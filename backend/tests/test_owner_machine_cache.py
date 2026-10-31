"""Complete local cache transactions and fixed public-reader boundaries."""
from contextlib import closing
from datetime import timedelta
import hashlib
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sqlite3
import threading
import time
from types import SimpleNamespace

import pytest

from models.owner_machine_cache import MachineCachePrepare, parse_cache_prepare
from service import owner_analysis_repo as analysis, owner_machine_cache as cache, owner_machine_repo as machine
from service import v8_repo
from strategy.decision_v2 import build_portfolio_policy
from test_owner_analysis_repo import change_positions, connect
from test_owner_machine_evidence import seed_details
from test_owner_machine_capacity import _extend, _refresh
from test_owner_machine_repo import DAY, NOW, SHA, counts, f


def packet(f, **changes):
    return {"occurrence_date": DAY, "request_id": "machine-cache-original-0001", "worker_build_sha": SHA,
            "expected_revision": f.source["revision"], "source_hash": f.source["source_hash"],
            "policy_version": f.source["policy_version"], "request_budget": 100, **changes}


def request(f, **changes):
    return parse_cache_prepare(json.dumps(packet(f, **changes)))


def detail(code, at=NOW):
    value = {field: None for field in cache._DETAIL_COLUMNS}
    value.update(code=code, name="合成缓存指数" + code, type="指数型", latest_nav=1.25,
        latest_nav_date="2026-10-23", source="primary", updated_at=at.isoformat(), ret_1y=0, buy_rate=0,
        nav_history=[{"date": "2026-10-22", "nav": 1.2, "ac_return": None},
                     {"date": "2026-10-23", "nav": 1.25, "ac_return": None}])
    return value


def collector(codes, *, check, deadline):
    check()
    assert deadline > time.monotonic()
    return {code: detail(code) for code in codes}


def image(f):
    with closing(connect(f.path)) as conn:
        return tuple(tuple(tuple(row) for row in conn.execute("SELECT * FROM " + table + " ORDER BY rowid"))
                     for table in ("fund_detail", "nav_history", "owner_machine_journal"))


def call(f, value=None, *, get=collector, factory=sqlite3.Connection, before_commit=None):
    with closing(connect(f.path, factory=factory)) as conn:
        return cache.prepare_cache_local(conn, value or request(f), collector=get, before_commit=before_commit)


def test_complete_cold_cache_and_original_receipt_share_caller_transaction_without_business_writes(f):
    original = request(f); before = counts(f); calls = []
    with closing(connect(f.path)) as conn:
        def observed(codes, *, check, deadline):
            assert not conn.in_transaction
            calls.append(tuple(codes))
            return collector(codes, check=check, deadline=deadline)
        response = cache.prepare_cache_local(conn, original, collector=observed)
        assert response["fetched_count"] == response["requested_count"] == 3
        assert response["reused_count"] == 0 and calls == [tuple(f.source["codes"])]
        assert len(response["cache_digest"]) == 64 and response["prepared_at"] == NOW.isoformat()
        assert [row["code"] for row in response["details"]] == f.source["codes"]
        assert not conn.in_transaction
        unchanged = image(f)
        assert cache.prepare_cache_local(conn, original, collector=lambda *a, **k: pytest.fail("replayed original")) == response
        assert cache.read_cache_receipt_local(conn, DAY, original.request_id, original.request_hash()) == response
        assert image(f) == unchanged
        with pytest.raises(machine.MachineFault, match="machine_invocation_conflict"):
            cache.read_cache_receipt_local(conn, DAY, original.request_id, "0" * 64)
        with pytest.raises(machine.MachineFault, match="machine_cache_receipt_missing"):
            cache.read_cache_receipt_local(conn, DAY, "never-written-cache-0001", original.request_hash())
    assert counts(f) == before
    with closing(connect(f.path)) as conn:
        assert tuple(conn.execute("SELECT ret_1y,buy_rate,updated_at FROM fund_detail LIMIT 1").fetchone()) == (0, 0, NOW.isoformat())
        assert all(row[0] is None for row in conn.execute("SELECT ac_return FROM nav_history"))


def test_fresh_cache_reuse_does_not_fetch_or_renew_source_timestamp(f, monkeypatch):
    seed_details(f)
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW + timedelta(minutes=2))
    response = call(f, get=lambda *args, **kwargs: pytest.fail("fresh cache triggered source request"))
    assert response["fetched_count"] == 0 and response["reused_count"] == 3
    assert response["prepared_at"] == (NOW + timedelta(minutes=2)).isoformat()
    assert {row["updated_at"] for row in response["details"]} == {NOW.isoformat()}


def test_preparation_does_not_obtain_or_request_a_notification_window(f, monkeypatch):
    monkeypatch.setattr(machine, "_window", lambda *args: pytest.fail("cache preparation requested notification eligibility"))
    result = call(f)
    assert result["fetched_count"] == 3 and counts(f)["notification_events"] == 0


@pytest.mark.parametrize("reason", ["missing_code", "extra_code", "nan", "zero_nav", "future_nav", "old_nav", "bad_date",
                                    "mismatch", "future_observation", "naive_observation", "boolean_number", "unknown_field"])
def test_bad_or_incomplete_final_source_preserves_entire_old_cache(f, reason):
    seed_details(f)
    with closing(connect(f.path)) as conn:
        conn.execute("UPDATE fund_detail SET updated_at=?", ((NOW - timedelta(days=1)).isoformat(),)); conn.commit()
    before = image(f)
    def broken(codes, **kwargs):
        result = collector(codes, **kwargs)
        last = result[codes[-1]]
        if reason == "missing_code": result.pop(codes[-1])
        elif reason == "extra_code": result["999999"] = detail("999999")
        elif reason == "nan": last["ret_1y"] = float("nan")
        elif reason == "zero_nav": last["latest_nav"] = 0
        elif reason == "future_nav": last["latest_nav_date"] = "2026-10-27"
        elif reason == "old_nav": last["latest_nav_date"] = "2026-10-18"
        elif reason == "bad_date": last["latest_nav_date"] = "bad"
        elif reason == "mismatch": last["nav_history"][-1]["nav"] = 8
        elif reason == "future_observation": last["updated_at"] = (NOW + timedelta(seconds=1)).isoformat()
        elif reason == "naive_observation": last["updated_at"] = NOW.replace(tzinfo=None).isoformat()
        elif reason == "boolean_number": last["buy_rate"] = False
        else: last["score"] = 90
        return result
    with pytest.raises(machine.MachineFault):
        call(f, get=broken)
    assert image(f) == before


@pytest.mark.parametrize("boundary", ["source", "cache", "day"])
def test_changes_during_network_reject_without_overwriting_newer_state(f, monkeypatch, boundary):
    def changed(codes, **kwargs):
        result = collector(codes, **kwargs)
        if boundary == "source":
            change_positions(f, {"asset:cash": {"value": 1001}})
        elif boundary == "cache":
            with closing(connect(f.path)) as conn:
                conn.execute("INSERT INTO fund_detail(code,name,updated_at) VALUES (?,?,?)", (codes[0], "newer cache", NOW.isoformat())); conn.commit()
        else:
            monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW + timedelta(days=1))
        return result
    with pytest.raises(machine.MachineFault, match={"source": "machine_source_conflict", "cache": "machine_cache_changed",
                                                   "day": "machine_cache_occurrence_mismatch"}[boundary]):
        call(f, get=changed)
    with closing(connect(f.path)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM owner_machine_journal WHERE kind='observation'").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM nav_history").fetchone()[0] == 0


def test_failed_last_append_rolls_back_all_cache_rows_and_never_becomes_a_receipt(f):
    class Lost(sqlite3.Connection):
        def execute(self, sql, args=()):
            if sql.startswith("INSERT INTO owner_machine_journal"):
                raise sqlite3.OperationalError("synthetic private insert error")
            return super().execute(sql, args)
    before = image(f)
    with pytest.raises(sqlite3.OperationalError):
        call(f, factory=Lost)
    assert image(f) == before


def test_actual_cache_commit_lost_ack_stays_readable_only_by_original_receipt(f):
    class Lost(sqlite3.Connection):
        wrote = False
        def execute(self, sql, args=()):
            result = super().execute(sql, args)
            self.wrote |= sql.startswith("INSERT INTO owner_machine_journal")
            return result
        def commit(self):
            super().commit()
            if self.wrote:
                raise sqlite3.OperationalError("synthetic cache commit response lost")
    original = request(f)
    with pytest.raises(sqlite3.OperationalError):
        call(f, original, factory=Lost)
    before = image(f)
    with closing(connect(f.path)) as conn:
        assert cache.read_cache_receipt_local(conn, DAY, original.request_id, original.request_hash())["fetched_count"] == 3
    assert image(f) == before


def _old_withdrawn_history(f):
    seed_details(f)
    with closing(connect(f.path)) as conn:
        for code in f.source["codes"]:
            conn.executemany("INSERT INTO nav_history(code,date,nav,ac_return) VALUES (?,?,?,?)", [
                (code, "2026-10-21", 1.0, None), (code, "2026-10-22", 55.0, None)])
        conn.execute("INSERT INTO nav_history(code,date,nav,ac_return) VALUES ('999999','2026-10-23',9,NULL)")
        conn.execute("UPDATE fund_detail SET updated_at=?", ((NOW - timedelta(days=1)).isoformat(),))
        conn.commit()


def _complete_revised_source(codes, **kwargs):
    result = collector(codes, **kwargs)
    for value in result.values():
        value["nav_history"] = [{"date": "2026-10-21", "nav": 1.1, "ac_return": None},
                                {"date": "2026-10-23", "nav": 1.25, "ac_return": None}]
    return result


def test_fetched_complete_history_replaces_withdrawn_middle_date_without_union_or_business_change(f):
    _old_withdrawn_history(f)
    before = counts(f)
    result = call(f, get=_complete_revised_source)
    assert result["fetched_count"] == 3 and counts(f) == before
    with closing(connect(f.path)) as conn:
        for code in f.source["codes"]:
            assert [tuple(row) for row in conn.execute(
                "SELECT date,nav,ac_return FROM nav_history WHERE code=? ORDER BY date", (code,))] == [
                    ("2026-10-21", 1.1, None), ("2026-10-23", 1.25, None)]
        # An unrelated code is not part of this authorized complete source.
        assert [tuple(row) for row in conn.execute("SELECT date,nav,ac_return FROM nav_history WHERE code='999999'")] == [
            ("2026-10-23", 9, None)]


def test_fault_after_public_history_delete_restores_full_old_image_and_no_receipt(f):
    _old_withdrawn_history(f)
    before = image(f)
    class DeleteLost(sqlite3.Connection):
        def execute(self, sql, args=()):
            result = super().execute(sql, args)
            if sql == "DELETE FROM nav_history WHERE code=?":
                raise sqlite3.OperationalError("synthetic public-cache delete response failure")
            return result
    with pytest.raises(sqlite3.OperationalError):
        call(f, get=_complete_revised_source, factory=DeleteLost)
    assert image(f) == before


def test_permission_revocation_in_network_phase_propagates_original_guard_and_writes_nothing(f):
    allowed = [True]
    denial = PermissionError("synthetic authorization revoked")
    def check():
        if not allowed[0]: raise denial
    def revoke(codes, **kwargs):
        allowed[0] = False
        kwargs["check"]()
    before = image(f)
    with pytest.raises(analysis._GuardFailure) as found:
        call(f, get=revoke, before_commit=check)
    assert found.value.original is denial and image(f) == before


def test_policy_becoming_effective_during_collection_is_checked_in_final_transaction(f, monkeypatch):
    next_policy = v8_repo.save_policy(build_portfolio_policy(name="合成排期缓存策略", source="cache-fixture",
        effective_at=NOW + timedelta(seconds=1), created_at=NOW,
        supersedes=f.policy.policy_version))
    def advance(codes, **kwargs):
        values = collector(codes, **kwargs)
        monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW + timedelta(seconds=2))
        return values
    before = image(f)
    with pytest.raises(machine.MachineFault, match="machine_policy_changed"):
        call(f, get=advance)
    assert image(f) == before and next_policy.policy_version != f.policy.policy_version


@pytest.mark.parametrize("change", [{"request_budget": 100.0}, {"request_budget": True}, {"request_budget": 99},
                                    {"expected_revision": False}, {"codes": ["000001"]}, {"holdings": []}])
def test_request_rejects_implicit_budgets_and_client_source_fields(f, change):
    with pytest.raises(ValueError):
        request(f, **change)


def test_original_raw_bytes_and_existing_body_budget_are_not_reinterpreted(f):
    raw = json.dumps(packet(f)).encode("utf-8")
    value = parse_cache_prepare(raw)
    assert value.request_hash() == hashlib.sha256(raw).hexdigest()
    assert parse_cache_prepare(raw + b" ").request_hash() != value.request_hash()
    with pytest.raises(ValueError):
        parse_cache_prepare(b'{"request_budget":100,' + raw[1:])
    with pytest.raises(ValueError):
        parse_cache_prepare(raw + b" " * 16_384)


@pytest.mark.parametrize("bad_type", ["坏" * 600, sqlite3.Binary(b"synthetic-invalid-type")])
def test_fund_type_preimage_rejects_oversized_or_nontext_before_materialization_or_fetch(f, bad_type):
    with closing(connect(f.path)) as conn:
        conn.execute("INSERT INTO funds(code,type) VALUES (?,?) ON CONFLICT(code) DO UPDATE SET type=excluded.type",
                     (f.source["codes"][0], bad_type)); conn.commit()
    before = image(f)
    with pytest.raises(machine.MachineFault, match="machine_cache_capacity_exhausted"):
        call(f, get=lambda *args, **kwargs: pytest.fail("bad preimage started public fetch"))
    assert image(f) == before


def provider_text(code="000001", *, points=None):
    values = {"fS_code": code, "fS_name": "合成指数", "fund_Rate": "0", "syl_1n": "0",
        "Data_netWorthTrend": points if points is not None else [
            {"x": 1792598400000, "y": 1.2, "equityReturn": None},
            {"x": 1792684800000, "y": 1.25, "equityReturn": 0}],
        "Data_currentFundManager": [{"name": "合成经理", "id": 0, "workTime": "0年"}]}
    # Fixed dates are 2026-10-22/23 in Beijing.
    return "\n".join("var " + key + " = " + json.dumps(value, ensure_ascii=False) + ";" for key, value in values.items())


def test_fixed_primary_parser_keeps_real_zero_unknown_returns_and_manager_identity():
    result = cache._parse_primary("000001", provider_text(), NOW)
    assert result["buy_rate"] == result["ret_1y"] == 0
    assert result["manager_id"] == "0"
    assert result["latest_nav_date"] == "2026-10-23"
    assert all(row["ac_return"] is None for row in result["nav_history"])


@pytest.mark.parametrize("fault", ["identity", "duplicate_assignment", "duplicate_date", "bad_number", "future", "false_metadata"])
def test_primary_parser_rejects_untrusted_source_shape(fault):
    text = provider_text()
    if fault == "identity": text = provider_text("000009")
    elif fault == "duplicate_assignment": text += '\nvar fS_code = "000001";'
    elif fault == "duplicate_date": text = provider_text(points=[{"x": 1792684800000, "y": 1, "equityReturn": 0}] * 2)
    elif fault == "bad_number": text = provider_text(points=[{"x": 1792684800000, "y": True, "equityReturn": 0}])
    elif fault == "future": text = provider_text(points=[{"x": 1793059200000, "y": 1, "equityReturn": 0}])
    else: text += '\nvar Data_fluctuationScale = false;'
    with pytest.raises(ValueError):
        cache._parse_primary("000001", text, NOW)


@pytest.mark.parametrize("status", [401, 403, 429])
def test_default_fixed_reader_stops_on_permission_or_quota_without_fallback(monkeypatch, status):
    calls, stopped = [], threading.Event()
    response = SimpleNamespace(status_code=status)
    class Enter:
        def __enter__(self): return response
        def __exit__(self, *args): pass
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def mount(self, *args): pass
        def get(self, url, **kwargs):
            calls.append((url, kwargs)); return Enter()
    monkeypatch.setattr(cache.requests, "Session", Session)
    with pytest.raises(machine.MachineFault, match="machine_cache_source_stopped"):
        cache._fetch_one("000001", lambda: None, stopped, time.monotonic() + 30)
    assert stopped.is_set() and len(calls) == 1
    assert calls[0][1]["allow_redirects"] is False and calls[0][1]["stream"] is True
    with pytest.raises(machine.MachineFault):
        cache._fetch_one("000009", lambda: None, stopped, time.monotonic() + 30)
    assert len(calls) == 1


def test_default_reader_enforces_body_cap_and_does_not_load_or_log_provider_data(monkeypatch):
    class Response:
        status_code = 200
        url = "https://fund.eastmoney.com/pingzhongdata/000001.js"
        headers = {"Content-Length": str(cache.MAX_PROVIDER_BYTES + 1), "Content-Type": "application/javascript"}
        @property
        def raw(self): pytest.fail("oversize body was read")
        def __enter__(self): return self
        def __exit__(self, *args): pass
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def mount(self, *args): pass
        def get(self, *args, **kwargs): return Response()
    monkeypatch.setattr(cache.requests, "Session", Session)
    with pytest.raises(machine.MachineFault):
        cache._fetch_one("000001", lambda: None, threading.Event(), time.monotonic() + 30)


def test_default_reader_includes_parse_time_in_original_request_deadline(monkeypatch):
    raw = provider_text().encode("utf-8")
    clock = [0.0]
    class Response:
        status_code = 200
        url = "https://fund.eastmoney.com/pingzhongdata/000001.js"
        headers = {"Content-Length": str(len(raw)), "Content-Type": "application/javascript"}
        def __enter__(self):
            self.raw = io.BytesIO(raw)
            return self
        def __exit__(self, *args): pass
    class Session:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def mount(self, *args): pass
        def get(self, *args, **kwargs): return Response()
    original_parse = cache._parse_primary
    def parse_after_deadline(*args):
        result = original_parse(*args)
        clock[0] = 9.0  # original 8-second deadline cannot renew after parsing
        return result
    monkeypatch.setattr(cache.requests, "Session", Session)
    monkeypatch.setattr(cache.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(cache.machine, "_clock", lambda: NOW)
    monkeypatch.setattr(cache, "_parse_primary", parse_after_deadline)
    with pytest.raises(machine.MachineFault, match="machine_cache_timeout"):
        cache._fetch_one("000001", lambda: None, threading.Event(), 30.0)


def test_collector_bounds_concurrency_and_never_schedules_after_authoritative_stop(monkeypatch):
    calls, active, peak, lock = [], 0, 0, threading.Lock()
    def fetch(code, check, stop, deadline):
        nonlocal active, peak
        with lock:
            active += 1; peak = max(peak, active); calls.append(code)
        try:
            if code == "000001":
                stop.set()
                raise machine.MachineFault("machine_cache_source_stopped")
            time.sleep(0.02)
            return detail(code)
        finally:
            with lock: active -= 1
    monkeypatch.setattr(cache, "_fetch_one", fetch)
    with pytest.raises(machine.MachineFault, match="machine_cache_source_stopped"):
        cache.collect_public_details(tuple(f"{index:06d}" for index in range(1, 101)), check=lambda: None,
                                     deadline=time.monotonic() + 30)
    assert len(calls) <= 4 and peak <= 4


def test_actual_default_collector_owned_http_100_cold_codes_commit_complete_cache_once(f, monkeypatch):
    """Only TLS origin is bridged to our loopback; reader/parser/SQL are real."""
    _extend(f, 100); _refresh(f)
    calls, active, peak, lock = [], 0, 0, threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal active, peak
            code = self.path.rsplit("/", 1)[-1].removesuffix(".js")
            with lock:
                calls.append(code); active += 1; peak = max(peak, active)
            try:
                raw = provider_text(code).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers(); self.wfile.write(raw)
            finally:
                with lock: active -= 1
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    real_session = cache.requests.Session
    class Bridge:
        def __init__(self):
            self.session = real_session(); self.session.trust_env = False
        def __enter__(self): return self
        def __exit__(self, *args): self.session.close()
        def mount(self, *args): self.session.mount(*args)
        def get(self, url, **kwargs):
            assert url.startswith("https://fund.eastmoney.com/pingzhongdata/")
            response = self.session.get("http://127.0.0.1:" + str(server.server_port) + "/" + url.rsplit("/", 1)[-1], **kwargs)
            response.url = url  # Controlled transport identity, NOT real TLS proof.
            return response
    monkeypatch.setattr(cache.requests, "Session", Bridge)
    try:
        with closing(connect(f.path)) as conn:
            result = cache.prepare_cache_local(conn, request(f))
            assert result["fetched_count"] == result["requested_count"] == 100
            assert result["reused_count"] == 0
            assert sorted(calls) == f.source["codes"] and len(calls) == 100 and peak <= 4
            original = request(f)
            assert cache.read_cache_receipt_local(conn, DAY, original.request_id, original.request_hash()) == result
            assert conn.execute("SELECT COUNT(*) FROM fund_detail").fetchone()[0] == 100
            assert conn.execute("SELECT COUNT(*) FROM nav_history").fetchone()[0] == 200
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=5)
    assert not thread.is_alive()
