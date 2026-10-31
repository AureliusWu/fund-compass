"""Actual ASGI -> bounded driver -> owned HTTP/SQLite, never a cloud service.

Only public detail collection is synthetic. Every snapshot, business core,
guarded mutation, result receipt and close uses the real candidate code.
These tests do not prove provider support, durability, recovery or delivery.
"""
from contextlib import closing, contextmanager
from dataclasses import replace
import hashlib
import json
from types import SimpleNamespace

import pytest
import requests
from fastapi.testclient import TestClient

from database import db, turso, turso_schema
from models.owner_analysis import parse_owner_analysis_request
from models.owner_sync import parse_sync_request
from service import owner_machine_cache as cache, owner_sessions as owners
from service.owner_business_candidate_app import create_turso_owner_business_candidate_app
from test_owner_analysis_repo import connect
from test_owner_machine_cache_http import details, packet as cache_packet
from test_owner_machine_evidence import encoded, raw_packet
from test_owner_machine_http import (
    ADMIN, BASE, PASSWORD, WORKER, auth, claim_payload, finish_payload,
    isolated_auth, password_hash, private,
)
from test_owner_machine_repo import DAY, counts, f
from test_owner_sync_turso import ORIGIN, TOKEN, local_hrana

ANALYSIS = "/api/v2/owner/analysis"
POLICY = "/api/v2/private/portfolio/policy-state"
SYNC = "/api/v2/owner/sync"


def app(**options):
    return create_turso_owner_business_candidate_app(ORIGIN, TOKEN, **options)


def login(client):
    result = client.post("/api/v2/owner/session", json={"password": PASSWORD})
    assert result.status_code == 200, result.text
    private(result)
    return {"Authorization": "Bearer " + result.json()["access_token"]}


@contextmanager
def full_hrana(fixture, monkeypatch):
    with closing(connect(fixture.path)) as conn:
        conn.execute(turso_schema.VERSION_DDL)
        conn.execute("INSERT INTO _schema_version(singleton,version) VALUES(1,9)")
        conn.commit()
    with local_hrana(fixture.path, monkeypatch) as (server, _owner_only):
        base_session = turso.requests.Session
        observed = SimpleNamespace(write_posts=0, lose_next_write=False, after_write=None, server=server)

        class ObservedSession(base_session):
            def post(self, url, **kwargs):
                frame = json.loads(kwargs["data"])
                writing = any(
                    step["stmt"]["sql"] == "BEGIN IMMEDIATE"
                    for operation in frame["requests"] if operation["type"] == "batch"
                    for step in operation["batch"]["steps"]
                )
                observed.write_posts += int(writing)
                result = super().post(url, **kwargs)
                if writing and observed.after_write is not None:
                    callback, observed.after_write = observed.after_write, None
                    callback()
                if writing and observed.lose_next_write:
                    observed.lose_next_write = False
                    result.close()
                    raise requests.ConnectionError("synthetic accepted HTTP response lost")
                return result

        monkeypatch.setattr(turso.requests, "Session", ObservedSession)
        yield observed


def post_machine(client, suffix, value):
    result = client.post(BASE + suffix, content=encoded(value),
                         headers={**auth(), "Content-Type": "application/json"})
    private(result)
    return result


def analysis_packet(fixture, *, proofs=None):
    return {"request_id": "cloud-analysis-original-0001", "expected_revision": fixture.source["revision"],
            "policy_version": fixture.source["policy_version"],
            "evidence": proofs or fixture.request["evidence"]}


def test_construction_startup_and_openapi_are_zero_io_and_closed(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("candidate startup opened storage, discovered credentials or sent HTTP")
    for module, name in ((turso.requests, "Session"), (db, "get_conn"), (db, "init_db"), (db, "_turso_settings")):
        monkeypatch.setattr(module, name, forbidden)
    with TestClient(app()) as client:
        paths = client.get("/openapi.json").json()["paths"]
        assert set(paths) == {
            "/api/v2/owner/session", SYNC, SYNC + "/requests/{request_id}",
            ANALYSIS, ANALYSIS + "/requests/{request_id}", POLICY,
            BASE + "/source", BASE + "/cache/prepare", BASE + "/cache/requests/{request_id}",
            BASE + "/evidence", BASE + "/evidence/{request_id}", BASE + "/tasks/prepare",
            BASE + "/tasks/claim", BASE + "/tasks/finish", BASE + "/tasks/{occurrence_date}",
        }
        for path in ("/health", "/sql", "/api/v2/worker/portfolio/execute"):
            assert client.get(path).status_code == 404
    assert TOKEN not in repr(app())


@pytest.mark.parametrize("options", [
    {"timeout_seconds": 0}, {"operation_seconds": 0}, {"timeout_seconds": float("nan")},
    {"operation_seconds": 31},
])
def test_invalid_budgets_are_rejected_without_io(monkeypatch, options):
    monkeypatch.setattr(turso.requests, "Session", lambda: pytest.fail("invalid budget opened network"))
    with pytest.raises(ValueError):
        app(**options)


def test_auth_scope_consent_and_fixed_cors_precede_all_storage(monkeypatch):
    monkeypatch.setattr(turso.requests, "Session", lambda: pytest.fail("denied request opened network"))
    with TestClient(app()) as client:
        owner = login(client)
        for path in (BASE + "/source", BASE + "/tasks/" + DAY):
            denied = client.get(path, headers=owner)
            assert denied.status_code in (401, 403)
            private(denied)
        assert client.get(POLICY, headers=auth(ADMIN)).status_code == 401
        assert client.post(ANALYSIS, headers=owner, json={}).status_code == 403
        assert client.post(SYNC, headers=owner, json={}).status_code == 403
        fingerprint = next(iter(owners._sessions))
        owners._sessions[fingerprint] = replace(owners._sessions[fingerprint], scopes=("read_private",))
        assert client.post(ANALYSIS, headers={**owner, "X-Owner-Analysis-Consent": "owner-analysis-v1"}, json={}).status_code == 403
        allowed = client.options(ANALYSIS, headers={"Origin": "https://aureliuswu.github.io",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization,X-Owner-Analysis-Consent"})
        assert allowed.status_code == 200
        assert allowed.headers["access-control-allow-origin"] == "https://aureliuswu.github.io"
        assert "access-control-allow-credentials" not in allowed.headers
        for origin, header in (("https://untrusted.example.invalid", "Authorization"),
                               ("https://aureliuswu.github.io", "X-Arbitrary-SQL")):
            denied = client.options(ANALYSIS, headers={"Origin": origin,
                "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": header})
            assert denied.status_code == 400


def test_real_driver_policy_source_and_all_three_sync_routes(f, monkeypatch):
    monkeypatch.setenv("TURSO_DATABASE_URL", "https://ignored.example.invalid")
    monkeypatch.setenv("TURSO_AUTH_TOKEN", "ignored-environment-token")
    with full_hrana(f, monkeypatch) as observed, TestClient(app()) as client:
        owner = login(client)
        policy = client.get(POLICY, headers=owner)
        assert policy.status_code == 200, policy.text
        assert policy.json()["schema_version"] == "owner-policy-state-1"
        assert policy.json()["current"]["policy_version"] == f.source["policy_version"]
        source = client.get(BASE + "/source", headers=auth())
        assert source.status_code == 200 and source.json() == f.source
        payload = {"request_id": "cloud-sync-original-0001", "expected_revision": f.source["revision"],
                   "operations": [{"key": "000010::云端关注", "kind": "watch", "deleted": False,
                                   "changes": {"name": "合成云候选关注"}}]}
        posted = client.post(SYNC, content=encoded(payload), headers={**owner,
            "Content-Type": "application/json", "X-Owner-Sync-Consent": "owner-sync-v1"})
        assert posted.status_code == 200, posted.text
        digest = parse_sync_request(encoded(payload)).request_hash()
        receipt = client.get(SYNC + "/requests/" + payload["request_id"],
                             headers={**owner, "X-Owner-Sync-Request-Hash": digest})
        assert receipt.status_code == 200 and receipt.json()["result"] == posted.json()
        changes = client.get(SYNC, headers=owner)
        assert changes.status_code == 200 and changes.json()["upper_revision"] == f.source["revision"] + 1
        assert observed.write_posts == 1
        for result in (policy, source, posted, receipt, changes):
            private(result)


def test_cold_cache_through_real_analysis_task_once_claim_and_unknown_finish(f, monkeypatch):
    collected = []
    def collect(codes, *, check, deadline):
        check(); collected.append(tuple(codes))
        return details(codes)
    monkeypatch.setattr(cache, "collect_public_details", collect)
    with full_hrana(f, monkeypatch) as observed, TestClient(app()) as client:
        before = counts(f)
        cold = post_machine(client, "/evidence", raw_packet(f))
        assert cold.status_code == 503 and collected == []
        cache_request = cache_packet(f); cache_raw = encoded(cache_request)
        prepared_cache = post_machine(client, "/cache/prepare", cache_request)
        assert prepared_cache.status_code == 200, prepared_cache.text
        assert prepared_cache.json()["fetched_count"] == 3 and counts(f) == before
        assert collected == [tuple(f.source["codes"])]
        cache_receipt = client.get(BASE + "/cache/requests/" + cache_request["request_id"], params={
            "occurrence_date": DAY, "request_hash": hashlib.sha256(cache_raw).hexdigest()}, headers=auth(ADMIN))
        assert cache_receipt.status_code == 200 and cache_receipt.json() == prepared_cache.json()
        proof_packet = raw_packet(f); proof_raw = encoded(proof_packet)
        proof = post_machine(client, "/evidence", proof_packet)
        assert proof.status_code == 200, proof.text
        evidence_receipt = client.get(BASE + "/evidence/" + proof_packet["request_id"], params={
            "occurrence_date": DAY, "request_hash": hashlib.sha256(proof_raw).hexdigest()}, headers=auth())
        assert evidence_receipt.status_code == 200 and evidence_receipt.json() == proof.json()
        owner = login(client); request = analysis_packet(f, proofs=proof.json()["evidence"])
        result = client.post(ANALYSIS, content=encoded(request), headers={**owner,
            "Content-Type": "application/json", "X-Owner-Analysis-Consent": "owner-analysis-v1"})
        assert result.status_code == 200, result.text
        original = client.get(ANALYSIS + "/requests/" + request["request_id"], headers={**owner,
            "X-Owner-Analysis-Request-Hash": parse_owner_analysis_request(encoded(request)).request_hash()})
        assert original.status_code == 200 and original.json()["result"] == result.json()
        task = post_machine(client, "/tasks/prepare", {**f.request, "evidence": proof.json()["evidence"]})
        assert task.status_code == 200, task.text
        claimed = post_machine(client, "/tasks/claim", claim_payload(task.json()))
        assert claimed.status_code == 200 and claimed.json()["claimed"], claimed.text
        duplicate = post_machine(client, "/tasks/claim", {**claim_payload(task.json()),
            "trigger": "manual", "request_id": "cloud-manual-claim-0001"})
        assert duplicate.status_code == 200 and duplicate.json()["claimed"] is False
        observed.lose_next_write = True
        unknown = post_machine(client, "/tasks/finish", finish_payload(claimed.json()))
        assert unknown.status_code == 503 and unknown.json()["detail"] == "machine_result_unknown"
        writes = observed.write_posts
        status = client.get(BASE + "/tasks/" + DAY, headers=auth())
        assert status.status_code == 200, status.text
        assert status.json()["attempts"][0]["result"]["execution_status"] == "succeeded"
        assert observed.write_posts == writes  # A readback does not replay finish or grant send permission.
        for response in (cache_receipt, evidence_receipt, result, original, unknown, status):
            private(response)
        with closing(connect(f.path)) as conn:
            assert dict(conn.execute("SELECT status,COUNT(*) FROM notification_events GROUP BY status")) == {
                "scheduled": 3, "attempted": 3, "sent": 3}


def test_revocation_during_public_collection_prevents_remote_write_and_no_replay(f, monkeypatch):
    def collect(codes, *, check, deadline):
        monkeypatch.setenv("WORKER_TOKEN", "rotated-cloud-worker-token")
        check()
        return details(codes)
    monkeypatch.setattr(cache, "collect_public_details", collect)
    with full_hrana(f, monkeypatch) as observed, TestClient(app()) as client:
        before = counts(f)
        result = post_machine(client, "/cache/prepare", cache_packet(f))
        assert result.status_code == 401 and observed.write_posts == 0
        assert counts(f) == before
        denied = client.get(BASE + "/source", headers=auth())
        assert denied.status_code in (401, 403) and observed.write_posts == 0


def test_logout_after_actual_commit_hides_success_original_receipt_never_resends(f, monkeypatch):
    with full_hrana(f, monkeypatch) as observed, TestClient(app()) as client:
        owner = login(client); request = analysis_packet(f)
        observed.after_write = owners.reset_owner_sessions
        revoked = client.post(ANALYSIS, content=encoded(request), headers={**owner,
            "Content-Type": "application/json", "X-Owner-Analysis-Consent": "owner-analysis-v1"})
        assert revoked.status_code == 401 and observed.write_posts == 1
        result = client.get(ANALYSIS + "/requests/" + request["request_id"], headers={**login(client),
            "X-Owner-Analysis-Request-Hash": parse_owner_analysis_request(encoded(request)).request_hash()})
        assert result.status_code == 200 and result.json()["state"] == "matched"
        assert observed.write_posts == 1
        private(revoked); private(result)


def test_actual_remote_close_failure_hides_committed_analysis_until_original_receipt(f, monkeypatch):
    close = turso.Connection.close
    failed = False
    with full_hrana(f, monkeypatch) as observed, TestClient(app()) as client:
        def fail_one_write_close(connection):
            nonlocal failed
            close(connection)
            if observed.write_posts and not failed:
                failed = True
                raise RuntimeError("private candidate driver close details")
        monkeypatch.setattr(turso.Connection, "close", fail_one_write_close)
        owner = login(client); request = analysis_packet(f)
        unknown = client.post(ANALYSIS, content=encoded(request), headers={**owner,
            "Content-Type": "application/json", "X-Owner-Analysis-Consent": "owner-analysis-v1"})
        assert unknown.status_code == 503 and unknown.json()["detail"] == "analysis_result_unknown"
        assert "private candidate" not in unknown.text
        result = client.get(ANALYSIS + "/requests/" + request["request_id"], headers={**owner,
            "X-Owner-Analysis-Request-Hash": parse_owner_analysis_request(encoded(request)).request_hash()})
        assert result.status_code == 200 and result.json()["state"] == "matched"
        assert observed.write_posts == 1
        private(unknown); private(result)


def test_lost_actual_claim_response_and_readback_never_grant_another_claim(f, monkeypatch):
    with full_hrana(f, monkeypatch) as observed, TestClient(app()) as client:
        task = post_machine(client, "/tasks/prepare", f.request)
        assert task.status_code == 200, task.text
        observed.lose_next_write = True
        unknown = post_machine(client, "/tasks/claim", claim_payload(task.json()))
        assert unknown.status_code == 503 and unknown.json()["detail"] == "machine_result_unknown"
        writes = observed.write_posts
        status = client.get(BASE + "/tasks/" + DAY, headers=auth())
        assert status.status_code == 200 and len(status.json()["attempts"]) == 1, status.text
        assert status.json()["attempts"][0]["result"] is None
        assert observed.write_posts == writes
        duplicate = post_machine(client, "/tasks/claim", {**claim_payload(task.json()),
            "request_id": "cloud-new-manual-claim-0002", "trigger": "manual"})
        assert duplicate.status_code == 200 and duplicate.json()["claimed"] is False
        assert duplicate.json()["attempt_hash"] == status.json()["attempts"][0]["attempt_hash"]
        private(unknown); private(status); private(duplicate)
