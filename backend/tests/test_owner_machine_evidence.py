"""Real HTTP + one local database; no cloud requests or notification delivery."""
from contextlib import closing
from datetime import timedelta
import hashlib
import json
import sqlite3
import time

from fastapi.testclient import TestClient
import pytest

from models.owner_machine import MAX_BODY_BYTES, MAX_EVIDENCE_BODY_BYTES
from service import owner_machine_evidence as ingestion, repo, v8_decisions, v8_repo
from test_owner_machine_http import (ADMIN, BASE, WORKER, app_with, auth, claim_payload, client_for,
    finish_payload, isolated_auth, password_hash, post, private)
from test_owner_machine_repo import DAY, NOW, counts, f
from test_owner_analysis_repo import change_positions, connect
from test_owner_machine_capacity import _extend, _refresh


def raw_packet(f):
    context = {"status": "fresh", "source": "synthetic-market", "kind": "intraday_estimate",
        "source_time": (NOW - timedelta(minutes=1)).isoformat(), "source_time_precision": "datetime",
        "estimate_change": 0, "estimate_nav": 1.25, "base_nav": 1.25, "base_nav_date": "2026-10-23",
        "value_nav": 1.25, "value_date": DAY, "market_time": (NOW - timedelta(minutes=1)).isoformat(),
        "diagnostics": {"source_time_precision": "datetime"}}
    return {**{key: value for key, value in f.request.items() if key != "evidence"},
            "observations": [{"code": code, "estimate_context": dict(context)} for code in f.source["codes"]]}


def seed_details(f):
    with closing(connect(f.path)) as conn:
        for code in f.source["codes"]:
            repo._save_detail(conn, {"code": code, "name": "合成指数" + code, "type": "指数型-股票",
                "latest_nav": 1.25, "latest_nav_date": "2026-10-23", "source": "synthetic-public-cache",
                "nav_history": [{"date": "2026-10-23", "nav": 1.25, "ac_return": None}]})
            conn.execute("UPDATE fund_detail SET updated_at=? WHERE code=?", (NOW.isoformat(), code))
        conn.commit()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def evidence_post(client, raw, token=WORKER):
    result = client.post(BASE + "/evidence", content=raw,
        headers={**auth(token), "Content-Type": "application/json"})
    private(result)
    return result


def receipt(client, packet, raw, token=WORKER):
    result = client.get(BASE + "/evidence/" + packet["request_id"], params={
        "occurrence_date": packet["occurrence_date"], "request_hash": hashlib.sha256(raw).hexdigest()}, headers=auth(token))
    private(result)
    return result


def image(f):
    with closing(connect(f.path)) as conn:
        return tuple(conn.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] for table in
            ("evidence_snapshots", "source_health_events", "v8_record_scopes", "owner_machine_journal"))


def test_source_market_ingestion_real_prepare_claim_finish_readback_without_global_io(f, monkeypatch):
    seed_details(f)
    def forbidden(*args, **kwargs):
        pytest.fail("candidate ingestion opened global storage or fetched public data")
    for module, name in ((repo, "get_detail"), (repo, "fetch_detail"), (v8_decisions, "create_evidence"),
                         (v8_repo, "save_evidence"), (v8_repo, "historical_outcome_summary")):
        monkeypatch.setattr(module, name, forbidden)
    packet = raw_packet(f); raw = encoded(packet)
    with client_for(f) as client:
        result = evidence_post(client, raw)
        assert result.status_code == 200, result.text
        response = result.json()
        assert set(response) == {"schema", "revision", "source_hash", "policy_version", "evidence"}
        assert [row["code"] for row in response["evidence"]] == f.source["codes"]
        assert receipt(client, packet, raw).json() == response
        prepared = post(client, "prepare", {**f.request, "evidence": response["evidence"]})
        assert prepared.status_code == 200, prepared.text
        task = prepared.json()
        assert all(row["evidence"]["estimate"] == 0 for row in task["run"]["components"])
        assert task["run"]["components"][0]["holding"]["shares"] == 0
        claimed = post(client, "claim", claim_payload(task))
        assert claimed.status_code == 200 and claimed.json()["claimed"]
        assert claimed.json()["attempt"]["valid_count"] == 3
        assert post(client, "finish", finish_payload(claimed.json())).status_code == 200
        status = client.get(BASE + "/tasks/" + DAY, headers=auth())
        assert status.status_code == 200, status.text
        assert len(status.json()["observations"]) == 2  # ingestion is not a natural-run success
        before = image(f)
        assert evidence_post(client, raw).json() == response and image(f) == before
        # Exact raw bytes, not an equivalent re-serialization, identify a batch.
        conflict = evidence_post(client, raw + b" ")
        assert conflict.status_code == 409 and image(f) == before


@pytest.mark.parametrize("boundary", ["commit", "close"])
def test_committed_batch_with_lost_response_is_unknown_then_original_receipt_read_only(f, boundary):
    seed_details(f); packet = raw_packet(f); raw = encoded(packet)
    class Lost(sqlite3.Connection):
        def commit(self):
            super().commit()
            if boundary == "commit":
                raise sqlite3.OperationalError("private synthetic provider failure")
        def close(self):
            super().close()
            if boundary == "close":
                raise sqlite3.OperationalError("private synthetic provider failure")
    with client_for(f, factory=Lost) as client:
        result = evidence_post(client, raw)
        assert result.status_code == 503 and result.json()["detail"] == "machine_result_unknown"
        assert "private synthetic" not in result.text
    before = image(f)
    with client_for(f) as client:
        assert receipt(client, packet, raw).status_code == 200
        assert image(f) == before
        absent = receipt(client, {**packet, "request_id": "never-written-original-0001"}, raw)
        assert absent.status_code == 404 and image(f) == before


@pytest.mark.parametrize("stage", ["append", "commit"])
def test_token_revocation_around_commit_preserves_unknown_semantics_and_admin_readback(f, monkeypatch, stage):
    seed_details(f); packet = raw_packet(f); raw = encoded(packet); before = image(f)
    class Rotate(sqlite3.Connection):
        def execute(self, sql, args=()):
            result = super().execute(sql, args)
            if stage == "append" and sql.startswith("INSERT INTO owner_machine_journal"):
                monkeypatch.setenv("WORKER_TOKEN", "rotated-machine-evidence-worker")
            return result
        def commit(self):
            super().commit()
            if stage == "commit":
                monkeypatch.setenv("WORKER_TOKEN", "rotated-machine-evidence-worker")
    with client_for(f, factory=Rotate) as client:
        result = evidence_post(client, raw)
        assert result.status_code == 401
    with client_for(f) as client:
        readback = receipt(client, packet, raw, ADMIN)
        assert readback.status_code == (404 if stage == "append" else 200)
        assert (image(f) == before) == (stage == "append")


@pytest.mark.parametrize("fault", ["missing", "old", "future", "naive", "bad_date", "future_date", "old_nav", "different_nav", "history_future"])
def test_invalid_final_detail_rejects_complete_batch_without_partial_evidence(f, fault):
    seed_details(f)
    with closing(connect(f.path)) as conn:
        code = f.source["codes"][-1]
        if fault == "missing":
            conn.execute("DELETE FROM fund_detail WHERE code=?", (code,))
        elif fault in {"old", "future", "naive"}:
            stamp = {"old": NOW - timedelta(days=7, seconds=1), "future": NOW + timedelta(seconds=1),
                     "naive": NOW.replace(tzinfo=None)}[fault]
            conn.execute("UPDATE fund_detail SET updated_at=? WHERE code=?", (stamp.isoformat(), code))
        elif fault in {"bad_date", "future_date", "old_nav"}:
            conn.execute("UPDATE fund_detail SET latest_nav_date=? WHERE code=?", (
                {"bad_date": "bad", "future_date": "2026-10-27", "old_nav": "2026-10-18"}[fault], code))
        elif fault == "different_nav":
            conn.execute("UPDATE nav_history SET nav=9 WHERE code=?", (code,))
        else:
            conn.execute("INSERT INTO nav_history(code,date,nav) VALUES (?,?,?)", (code, "2026-10-27", 1.25))
        conn.commit()
    before = image(f)
    with client_for(f) as client:
        result = evidence_post(client, encoded(raw_packet(f)))
        assert result.status_code == 503 and result.json()["detail"] == "machine_detail_unavailable"
        assert image(f) == before


@pytest.mark.parametrize("fault,expected", [("partial", 409), ("source", 409), ("revision", 409), ("policy", 409),
    ("duplicate", 422), ("unsorted", 422), ("holding", 422), ("score", 422), ("boolean", 422),
    ("kind_alias", 422), ("field_alias", 422), ("nav_alias", 422), ("diagnostic_boolean", 422), ("duplicate_key", 422)])
def test_closed_observation_contract_and_complete_source_never_partially_write(f, fault, expected):
    seed_details(f); packet = raw_packet(f)
    if fault == "partial": packet["observations"].pop()
    elif fault == "source": packet["source_hash"] = "0" * 64
    elif fault == "revision": packet["expected_revision"] += 1
    elif fault == "policy": packet["policy_version"] = "pol_" + "0" * 64
    elif fault == "duplicate": packet["observations"].append(packet["observations"][-1])
    elif fault == "unsorted": packet["observations"].reverse()
    elif fault == "holding": packet["holdings"] = []
    elif fault == "score": packet["observations"][0]["score"] = 99
    elif fault == "boolean": packet["observations"][0]["estimate_context"]["estimate_change"] = False
    elif fault == "kind_alias": packet["observations"][0]["estimate_context"]["kind"] = "estimate"
    elif fault == "field_alias": packet["observations"][0]["estimate_context"]["est_change"] = 0
    elif fault == "nav_alias": packet["observations"][0]["estimate_context"]["nav_date"] = DAY
    elif fault == "diagnostic_boolean":
        packet["observations"][0]["estimate_context"]["diagnostics"]["rejected"] = {"bad": True}
    raw = encoded(packet)
    if fault == "duplicate_key": raw = b'{"source_hash":"' + b"0" * 64 + b'",' + raw[1:]
    before = image(f)
    with client_for(f) as client:
        result = evidence_post(client, raw)
        assert result.status_code == expected, result.text
        assert image(f) == before


@pytest.mark.parametrize("quote", ["stale", "official", "unavailable", "future_value_date", "old_value_date"])
def test_non_intraday_context_never_becomes_fresh_market_evidence(f, quote):
    seed_details(f); packet = raw_packet(f)
    for row in packet["observations"]:
        if quote == "stale":
            row["estimate_context"]["source_time"] = (NOW - timedelta(days=1)).isoformat()
        elif quote in {"future_value_date", "old_value_date"}:
            row["estimate_context"]["value_date"] = "2026-10-27" if quote == "future_value_date" else "2026-10-23"
        elif quote == "official":
            row["estimate_context"] = {"kind": "official_nav", "status": "latest_official", "source": "synthetic-official",
                "source_time_precision": "date", "source_time": "2026-10-23", "value_nav": 1.25,
                "value_date": "2026-10-23", "is_fallback": True, "fallback_reason": "official_only",
                "diagnostics": {"source_time_precision": "date", "primary_reason": "official_only"}}
        else:
            row["estimate_context"] = {"kind": "unavailable", "status": "unavailable", "source": "synthetic-unavailable",
                "source_time_precision": "date", "is_fallback": True, "fallback_reason": "source_unavailable",
                "diagnostics": {"source_time_precision": "date", "primary_reason": "source_unavailable"}}
    with client_for(f) as client:
        result = evidence_post(client, encoded(packet))
        assert result.status_code == 200, result.text
        task = post(client, "prepare", {**f.request, "evidence": result.json()["evidence"]})
        assert task.status_code == 200, task.text
        response = post(client, "claim", claim_payload(task.json()))
        assert response.status_code == 409 and response.json()["detail"] == "machine_no_current_intraday"


@pytest.mark.parametrize("token", ["", "invalid-worker-token"])
def test_denied_ingestion_and_receipt_never_open_storage(token):
    calls = []
    with TestClient(app_with(lambda: calls.append(True))) as client:
        assert evidence_post(client, b"{}", token).status_code == 401
        result = client.get(BASE + "/evidence/original-request-1", params={"occurrence_date": DAY, "request_hash": "0" * 64},
                            headers=auth(token))
        assert result.status_code == 401 and calls == []


def test_original_market_receipt_survives_manual_source_change_without_granting_prepare(f):
    seed_details(f); packet = raw_packet(f); raw = encoded(packet)
    with client_for(f) as client:
        result = evidence_post(client, raw)
        assert result.status_code == 200
        original = result.json()
        change_positions(f, {"asset:cash": {"value": 1001}})
        before = image(f)
        assert receipt(client, packet, raw).json() == original
        assert evidence_post(client, raw).json() == original and image(f) == before
        changed = post(client, "prepare", {**f.request, "evidence": original["evidence"]})
        assert changed.status_code == 409 and changed.json()["detail"] == "machine_source_conflict"
        assert counts(f)["owner_analysis_runs"] == 0


def test_qdii_next_nav_keeps_target_and_zero_uncertainty_but_cannot_claim_intraday(f, monkeypatch):
    seed_details(f); packet = raw_packet(f); reads = []
    monkeypatch.setattr(ingestion.overseas_evidence, "load_artifact", lambda: reads.append(True) or {})
    for row in packet["observations"]:
        row["estimate_context"].update(kind="qdii_next_nav_estimate", status="modeled", market="overseas",
            target_nav_date=DAY, estimate_model_version="synthetic-qdii-1", sample_count=0,
            coverage=0, mae=0, error_p80=0, direction_accuracy=0)
    with client_for(f) as client:
        result = evidence_post(client, encoded(packet))
        assert result.status_code == 200, result.text
        assert reads == [True]  # one bounded attachment for the complete batch
        task = post(client, "prepare", {**f.request, "evidence": result.json()["evidence"]})
        assert task.status_code == 200, task.text
        for item in task.json()["run"]["components"]:
            proof = item["evidence"]
            assert proof["target_nav_date"] == DAY and proof["estimate_status"] == "modeled"
            assert proof["estimate_mae"] == proof["estimate_error_p80"] == proof["estimate_direction_accuracy"] == 0
        claimed = post(client, "claim", claim_payload(task.json()))
        assert claimed.status_code == 409 and claimed.json()["detail"] == "machine_no_current_intraday"


def test_full_100_observations_fit_separate_budget_and_three_samples_stay_in_total_guard(f):
    _extend(f, 100); _refresh(f); seed_details(f)
    packet = raw_packet(f); raw = encoded(packet)
    assert MAX_BODY_BYTES < len(raw) < MAX_EVIDENCE_BODY_BYTES
    samples = []
    with client_for(f) as client:
        for index in range(3):
            packet["request_id"] = "machine-full-100-evidence-" + str(index)
            start = time.perf_counter()
            result = evidence_post(client, encoded(packet))
            samples.append(time.perf_counter() - start)
            assert result.status_code == 200 and len(result.json()["evidence"]) == 100, result.text
        over = evidence_post(client, b" " * (MAX_EVIDENCE_BODY_BYTES + 1))
        assert over.status_code == 413
    assert max(samples) < 30.0
    print("MACHINE_EVIDENCE_100_LOCAL_SECONDS=" + json.dumps(samples))
