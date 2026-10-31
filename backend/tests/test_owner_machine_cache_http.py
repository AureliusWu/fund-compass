"""Protected cache preparation, actual SQL/HTTP; public collection is synthetic."""
from contextlib import closing
from datetime import timedelta
import hashlib
import json
import sqlite3
import time

from fastapi.testclient import TestClient
import pytest

from service import owner_machine_cache as cache, owner_machine_evidence as evidence
from test_owner_analysis_repo import change_positions, connect
from test_owner_machine_evidence import encoded, evidence_post, raw_packet, seed_details
from test_owner_machine_http import (ADMIN, BASE, PRIVATE, WORKER, app_with, auth, claim_payload, client_for,
    isolated_auth, password_hash, post, private)
from test_owner_machine_repo import DAY, NOW, SHA, counts, f
from test_owner_machine_capacity import _extend, _refresh


def packet(f):
    return {"occurrence_date": DAY, "request_id": "machine-cache-http-0001", "worker_build_sha": SHA,
        "expected_revision": f.source["revision"], "source_hash": f.source["source_hash"],
        "policy_version": f.source["policy_version"], "request_budget": 100}


def details(codes):
    result = {}
    for code in codes:
        row = dict.fromkeys(evidence._DETAIL_COLUMNS)
        row.update(code=code, name="合成指数" + code, type="指数型-股票", source="primary",
            latest_nav=1.25, latest_nav_date="2026-10-23", updated_at=NOW.isoformat(),
            nav_history=[{"date": "2026-10-23", "nav": 1.25, "ac_return": None}])
        result[code] = row
    return result


def cache_post(client, raw, *, token=WORKER):
    response = client.post(BASE + "/cache/prepare", content=raw,
                           headers={**auth(token), "Content-Type": "application/json"})
    private(response)
    return response


def read_receipt(client, request, raw, *, token=WORKER):
    response = client.get(BASE + "/cache/requests/" + request["request_id"], params={
        "occurrence_date": request["occurrence_date"], "request_hash": hashlib.sha256(raw).hexdigest()},
        headers=auth(token))
    private(response)
    return response


def cache_image(f):
    with closing(connect(f.path)) as conn:
        return tuple(tuple(tuple(row) for row in conn.execute(sql)) for sql in (
            "SELECT * FROM fund_detail ORDER BY code", "SELECT * FROM nav_history ORDER BY code,date",
            "SELECT * FROM owner_machine_journal WHERE kind='observation' ORDER BY record_id"))


def test_actual_main_cache_routes_are_zero_io_mounted():
    import main
    paths = main.app.openapi()["paths"]
    assert "post" in paths[BASE + "/cache/prepare"]
    assert "get" in paths[BASE + "/cache/requests/{request_id}"]


def test_cold_cache_prepare_to_evidence_and_original_task_without_business_mutation(f, monkeypatch):
    calls = []
    def collect(codes, *, check, deadline):
        check(); calls.append(tuple(codes))
        return details(codes)
    monkeypatch.setattr(cache, "collect_public_details", collect)
    request = packet(f); raw = encoded(request); before = counts(f)
    with client_for(f) as client:
        # A cold cache remains closed until the separate explicit preparation.
        blocked = evidence_post(client, encoded(raw_packet(f)))
        assert blocked.status_code == 503 and calls == []
        response = cache_post(client, raw)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["schema"] == "owner-machine-cache-1"
        assert calls == [tuple(f.source["codes"])]
        assert result["fetched_count"] == 3 and result["reused_count"] == 0
        assert counts(f) == before  # Cache preparation is NOT a business run.
        saved = cache_image(f)
        assert read_receipt(client, request, raw).json() == result
        assert cache_post(client, raw).json() == result and cache_image(f) == saved
        assert len(calls) == 1
        assert cache_post(client, raw + b" ").status_code == 409
        proof = evidence_post(client, encoded(raw_packet(f)))
        assert proof.status_code == 200, proof.text
        task = post(client, "prepare", {**f.request, "evidence": proof.json()["evidence"]})
        assert task.status_code == 200, task.text
        claim = post(client, "claim", claim_payload(task.json()))
        assert claim.status_code == 200 and claim.json()["claimed"]
        status = client.get(BASE + "/tasks/" + DAY, headers=auth())
        assert status.status_code == 200, status.text
        assert len(status.json()["observations"]) == 2  # no fake cache/Cron success


@pytest.mark.parametrize("token", ["", PRIVATE, "not-a-worker-token"])
def test_denied_cache_routes_never_open_storage_or_collect(token, monkeypatch):
    calls = []
    monkeypatch.setattr(cache, "collect_public_details", lambda *a, **kw: pytest.fail("denied request collected data"))
    with TestClient(app_with(lambda: calls.append(True))) as client:
        assert cache_post(client, b"{}", token=token).status_code == 401
        result = client.get(BASE + "/cache/requests/original-cache-001", params={
            "occurrence_date": DAY, "request_hash": "0" * 64}, headers=auth(token))
        assert result.status_code == 401 and calls == []


@pytest.mark.parametrize("variant", ["extra", "budget", "boolean_budget", "boolean_revision", "duplicate", "large"])
def test_invalid_cache_raw_never_opens_or_fetches(f, variant):
    value = packet(f)
    if variant == "extra": value["codes"] = f.source["codes"]
    if variant == "budget": value["request_budget"] = 99
    if variant == "boolean_budget": value["request_budget"] = True
    if variant == "boolean_revision": value["expected_revision"] = True
    raw = encoded(value)
    if variant == "duplicate": raw = b'{"request_budget":100,' + raw[1:]
    if variant == "large": raw = b" " * (16 * 1024 + 1)
    with TestClient(app_with(lambda: pytest.fail("invalid request opened storage"))) as client:
        assert cache_post(client, raw).status_code == (413 if variant == "large" else 422)


@pytest.mark.parametrize("boundary", ["commit", "close"])
def test_cache_lost_commit_or_close_retains_original_read_only_receipt(f, monkeypatch, boundary):
    monkeypatch.setattr(cache, "collect_public_details", lambda codes, **kw: details(codes))
    request = packet(f); raw = encoded(request)
    class Lost(sqlite3.Connection):
        writes = False
        def execute(self, sql, args=()):
            result = super().execute(sql, args)
            if sql.startswith("INSERT INTO owner_machine_journal"):
                self.writes = True
            return result
        def commit(self):
            super().commit()
            if boundary == "commit" and self.writes:
                raise sqlite3.OperationalError("private cache commit response lost")
        def close(self):
            super().close()
            if boundary == "close":
                raise sqlite3.OperationalError("private cache close response lost")
    with client_for(f, factory=Lost) as client:
        result = cache_post(client, raw)
        assert result.status_code == 503 and result.json()["detail"] == "machine_result_unknown", result.text
        assert "private cache" not in result.text
    saved = cache_image(f)
    with client_for(f) as client:
        assert read_receipt(client, request, raw, token=ADMIN).status_code == 200
        assert cache_image(f) == saved


def test_manual_source_change_during_collection_rejects_all_cache_writes(f, monkeypatch):
    def changed(codes, *, check, deadline):
        change_positions(f, {"asset:cash": {"value": 1001}})
        check()
        return details(codes)
    monkeypatch.setattr(cache, "collect_public_details", changed)
    before = cache_image(f)
    with client_for(f) as client:
        result = cache_post(client, encoded(packet(f)))
        assert result.status_code == 409, result.text
        assert cache_image(f) == before


def test_real_authority_revocation_during_collection_blocks_cache_commit(f, monkeypatch):
    def revoked(codes, *, check, deadline):
        monkeypatch.setenv("WORKER_TOKEN", "rotated-original-cache-token")
        check()
        return details(codes)
    monkeypatch.setattr(cache, "collect_public_details", revoked)
    before = cache_image(f)
    with client_for(f) as client:
        result = cache_post(client, encoded(packet(f)))
        assert result.status_code == 401 and cache_image(f) == before


def test_existing_fresh_cache_is_reused_without_network_or_timestamp_refresh(f, monkeypatch):
    seed_details(f)
    before = cache_image(f)
    def no_fetch(codes, **kwargs):
        assert tuple(codes) == ()
        return {}
    monkeypatch.setattr(cache, "collect_public_details", no_fetch)
    with client_for(f) as client:
        result = cache_post(client, encoded(packet(f)))
        assert result.status_code == 200, result.text
        assert result.json()["fetched_count"] == 0 and result.json()["reused_count"] == 3
        after = cache_image(f)
        assert after[:2] == before[:2]


def test_three_complete_100_fund_preparations_remain_bounded(f, monkeypatch):
    _extend(f, 100); _refresh(f)
    monkeypatch.setattr(cache, "collect_public_details", lambda codes, **kw: details(codes))
    samples = {"cold": [], "reused": []}
    with client_for(f) as client:
        for mode in samples:
            for index in range(3):
                if mode == "cold":
                    # Only this owned synthetic fixture's public caches are
                    # reset; source/business rows and immutable receipts stay.
                    with connect(f.path) as conn:
                        conn.execute("DELETE FROM fund_detail")
                        conn.execute("DELETE FROM nav_history")
                value = {**packet(f), "request_id": f"cache-complete-100-{mode}-{index}"}
                start = time.perf_counter()
                result = cache_post(client, encoded(value))
                samples[mode].append(time.perf_counter() - start)
                assert result.status_code == 200 and len(result.json()["details"]) == 100, result.text
                assert result.json()["fetched_count"] == (100 if mode == "cold" else 0)
                assert result.json()["reused_count"] == (0 if mode == "cold" else 100)
    assert max(value for series in samples.values() for value in series) < 30
    print("CACHE_100_LOCAL_SECONDS=" + json.dumps(samples))
