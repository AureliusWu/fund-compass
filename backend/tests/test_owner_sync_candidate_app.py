"""Actual candidate ASGI -> HTTP -> owned loopback SQLite/Hrana, not Turso.

The transport is real HTTP only to the existing synthetic owned server. These
tests confer no provider, persistence, restoration or release qualification.
"""
from dataclasses import replace
import json
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from database import db, turso
from database.owner_analysis_schema import provision_owner_analysis_candidate
from database.owner_machine_schema import provision_owner_machine_candidate
from models.owner_sync import parse_sync_request
from service import owner_sessions as owners, owner_sync as http
from service import owner_sync_turso as remote
from service.owner_sync_candidate_app import create_turso_owner_sync_candidate_app
from test_owner_sync_http import PASSWORD, PRIVATE_NAME, isolated, password_hash, private, request
from test_owner_sync_turso import ORIGIN, TOKEN, database, local_hrana


def app(**options):
    return create_turso_owner_sync_candidate_app(ORIGIN, TOKEN, **options)


def login(client):
    response = client.post("/api/v2/owner/session", json={"password": PASSWORD})
    assert response.status_code == 200
    private(response)
    return {"Authorization": "Bearer " + response.json()["access_token"],
            "X-Owner-Sync-Consent": "owner-sync-v1"}


def receipt_auth(auth, payload):
    digest = parse_sync_request(json.dumps(payload, ensure_ascii=False)).request_hash()
    return {**auth, "X-Owner-Sync-Request-Hash": digest}


def test_construction_startup_and_contract_never_open_network_or_main_database(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("candidate construction/startup discovered storage or created HTTP")
    monkeypatch.setattr(turso.requests, "Session", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "init_db", forbidden)
    monkeypatch.setattr(db, "_turso_settings", forbidden)
    candidate = app()
    with TestClient(candidate) as client:
        paths = client.get("/openapi.json").json()["paths"]
        assert set(paths) == {
            "/api/v2/owner/session", "/api/v2/owner/sync",
            "/api/v2/owner/sync/requests/{request_id}",
        }
        assert client.get("/health").status_code == 404
        assert client.post("/api/v2/owner/analysis", json={}).status_code == 404
        assert client.post("/api/v2/worker/portfolio/prepare", json={}).status_code == 404
    assert TOKEN not in repr(candidate)


@pytest.mark.parametrize("options", [
    {"operation_seconds": 0}, {"operation_seconds": 31}, {"operation_seconds": float("nan")},
    {"timeout_seconds": 0}, {"timeout_seconds": 61}, {"timeout_seconds": float("inf")},
])
def test_candidate_budgets_are_validated_before_network(monkeypatch, options):
    monkeypatch.setattr(turso.requests, "Session", lambda: pytest.fail("invalid budget created HTTP"))
    with pytest.raises(ValueError):
        app(**options)


def test_auth_consent_and_validation_precede_candidate_network(monkeypatch):
    monkeypatch.setattr(turso.requests, "Session", lambda: pytest.fail("rejected request created HTTP"))
    with TestClient(app()) as client:
        for credentials in ({}, {"Authorization": "Bearer synthetic-ADMIN_TOKEN"},
                            {"Authorization": "Bearer synthetic-WORKER_TOKEN"}):
            denied = client.post("/api/v2/owner/sync", headers=credentials, json=request())
            assert denied.status_code == 401
            private(denied)
        auth = login(client)
        no_consent = client.post("/api/v2/owner/sync", headers={"Authorization": auth["Authorization"]}, json=request())
        assert no_consent.status_code == 403
        invalid = client.post("/api/v2/owner/sync", headers=auth, json={"private": PRIVATE_NAME})
        assert invalid.status_code == 422 and PRIVATE_NAME not in invalid.text
        bad_receipt = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=auth)
        assert bad_receipt.status_code == 422
        for response in (no_consent, invalid, bad_receipt):
            private(response)


def test_real_owner_session_routes_reach_existing_turso_adapter_with_explicit_credentials(database, monkeypatch):
    monkeypatch.setenv("TURSO_DATABASE_URL", "https://unused-environment.example.invalid")
    monkeypatch.setenv("TURSO_AUTH_TOKEN", "unused-environment-token")
    with local_hrana(database, monkeypatch) as (state, _repository), TestClient(app()) as client:
        auth = login(client)
        payload = request()
        first = client.post("/api/v2/owner/sync", headers=auth, json=payload)
        assert first.status_code == 200 and first.json()["revision"] == 1
        assert first.json()["records"][0]["values"]["value"] == 0
        replay = client.post("/api/v2/owner/sync", headers=auth, json=payload)
        assert (replay.status_code, replay.content) == (200, first.content)
        stored = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_auth(auth, payload))
        assert stored.json() == {"state": "matched", "status": 200, "result": first.json()}
        changes = client.get("/api/v2/owner/sync", headers=auth)
        assert changes.status_code == 200 and changes.json()["upper_revision"] == 1
        assert changes.json()["changes"] == first.json()["records"]
        assert state.write_batches == 1
        for response in (first, replay, stored, changes):
            private(response)


def test_loss_of_real_http_write_response_retains_unknown_then_original_receipt(database, monkeypatch):
    with local_hrana(database, monkeypatch) as (state, _repository), TestClient(app()) as client:
        auth, payload = login(client), request()
        state.lose_write_response = True
        uncertain = client.post("/api/v2/owner/sync", headers=auth, json=payload)
        assert uncertain.status_code == 503
        assert uncertain.json()["error"]["code"] == "sync_result_unknown"
        assert state.write_batches == 1
        state.lose_write_response = False
        receipt = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_auth(auth, payload))
        assert receipt.status_code == 200 and receipt.json()["state"] == "matched"
        assert receipt.json()["result"]["revision"] == 1
        assert state.write_batches == 1  # No automatic resend during reconciliation.
        absent = request("candidate-missing-001")
        missing = client.get("/api/v2/owner/sync/requests/candidate-missing-001", headers=receipt_auth(auth, absent))
        assert missing.status_code == 404 and missing.json()["state"] == "unknown"
        for response in (uncertain, receipt, missing):
            private(response)


def test_logout_while_accepted_remote_batch_runs_hides_private_success(database, monkeypatch):
    with local_hrana(database, monkeypatch) as (state, _repository), TestClient(app()) as client:
        auth, payload = login(client), request()
        state.before_write = owners.reset_owner_sessions
        revoked = client.post("/api/v2/owner/sync", headers=auth, json=payload)
        assert revoked.status_code == 401 and PRIVATE_NAME not in revoked.text
        assert state.write_batches == 1
        restored = client.get("/api/v2/owner/sync/requests/http-test-0001",
                              headers=receipt_auth(login(client), payload))
        assert restored.status_code == 200 and restored.json()["state"] == "matched"
        private(revoked)
        private(restored)


def test_logout_after_remote_preflight_before_batch_prevents_write(database, monkeypatch):
    snapshot = remote.TursoOwnerSyncRepository._snapshot
    def revoke_after_snapshot(*args, **kwargs):
        value = snapshot(*args, **kwargs)
        owners.reset_owner_sessions()
        return value
    monkeypatch.setattr(remote.TursoOwnerSyncRepository, "_snapshot", revoke_after_snapshot)
    with local_hrana(database, monkeypatch) as (state, _repository), TestClient(app()) as client:
        revoked = client.post("/api/v2/owner/sync", headers=login(client), json=request())
        assert revoked.status_code == 401 and PRIVATE_NAME not in revoked.text
        assert state.write_batches == 0
        private(revoked)


def test_remote_close_failure_after_commit_is_unknown_until_original_receipt(database, monkeypatch):
    close = turso.Connection.close
    failed = False
    with local_hrana(database, monkeypatch) as (state, _repository), TestClient(app()) as client:
        def fail_one_write_close(connection):
            nonlocal failed
            close(connection)
            if state.write_batches and not failed:
                failed = True
                raise http.HTTPException(502, "secret-input driver close/private")
        monkeypatch.setattr(turso.Connection, "close", fail_one_write_close)
        auth, payload = login(client), request()
        uncertain = client.post("/api/v2/owner/sync", headers=auth, json=payload)
        assert uncertain.status_code == 503 and "secret-input" not in uncertain.text
        assert uncertain.json()["error"]["code"] == "sync_result_unknown"
        stored = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_auth(auth, payload))
        assert stored.status_code == 200 and stored.json()["state"] == "matched"
        assert state.write_batches == 1
        private(uncertain)
        private(stored)


def test_read_only_owner_cannot_reach_candidate_write(database, monkeypatch):
    with local_hrana(database, monkeypatch) as (state, _repository), TestClient(app()) as client:
        auth = login(client)
        fingerprint = next(iter(owners._sessions))
        owners._sessions[fingerprint] = replace(owners._sessions[fingerprint], scopes=("read_private",))
        denied = client.post("/api/v2/owner/sync", headers=auth, json=request())
        assert denied.status_code == 403 and state.frames == []
        assert client.get("/api/v2/owner/sync", headers=auth).status_code == 200
        private(denied)


@pytest.mark.parametrize("profile", ["schema8", "analysis", "machine"])
def test_candidate_never_repairs_or_accepts_old_or_extended_cloud_profile(database, monkeypatch, profile):
    with sqlite3.connect(database) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        if profile == "schema8":
            conn.execute("UPDATE _schema_version SET version=8")
        else:
            conn.execute("PRAGMA user_version=9")
            provision_owner_analysis_candidate(conn, synthetic_candidate=True)
            if profile == "machine":
                provision_owner_machine_candidate(conn, synthetic_candidate=True)
            conn.execute("PRAGMA user_version=8")
        conn.commit()
    before = database.read_bytes()
    with local_hrana(database, monkeypatch) as (state, _repository), TestClient(app()) as client:
        response = client.post("/api/v2/owner/sync", headers=login(client), json=request())
        assert response.status_code == 503 and state.write_batches == 0
        private(response)
    assert database.read_bytes() == before


@pytest.mark.parametrize("kind", ["runtime", "http"])
def test_repository_seam_unclassified_exception_is_unknown_not_secret_detail(kind):
    class FailingRepository:
        def apply(self, *_args, **_kwargs):
            if kind == "http":
                raise http.HTTPException(502, "secret-input/private/path SELECT secret")
            raise RuntimeError("secret-input/private/path SELECT secret")
    candidate = FastAPI()
    candidate.include_router(http.build_owner_sync_repository_router(FailingRepository()))
    token = owners._issue_session(owners.SecretStr(PASSWORD))["access_token"]
    with TestClient(candidate) as client:
        response = client.post("/api/v2/owner/sync", json=request(), headers={
            "Authorization": "Bearer " + token, "X-Owner-Sync-Consent": "owner-sync-v1",
        })
    assert response.status_code == 503
    assert response.json() == {"detail": "sync_result_unknown"}
    private(response)


@pytest.mark.parametrize("operation", ["write", "changes", "receipt"])
def test_local_factory_http_exception_is_sanitized_before_acceptance(operation):
    def factory():
        raise http.HTTPException(502, "secret-input/private/db SELECT secret")
    candidate = FastAPI()
    candidate.include_router(http.build_owner_sync_router(factory))
    token = owners._issue_session(owners.SecretStr(PASSWORD))["access_token"]
    auth = {"Authorization": "Bearer " + token, "X-Owner-Sync-Consent": "owner-sync-v1"}
    with TestClient(candidate) as client:
        if operation == "write":
            response = client.post("/api/v2/owner/sync", headers=auth, json=request())
        elif operation == "changes":
            response = client.get("/api/v2/owner/sync", headers=auth)
        else:
            response = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_auth(auth, request()))
    assert response.status_code == 503 and "secret-input" not in response.text
    assert response.json() == ({"state": "unknown", "error": "sync_result_unknown"} if operation == "receipt"
                               else {"detail": "sync_storage_unavailable"})
    private(response)


def test_local_close_http_exception_remains_unknown_after_commit(database):
    class FailClose(sqlite3.Connection):
        def close(self):
            super().close()
            raise http.HTTPException(502, "secret-input/private after close")
    candidate = FastAPI()
    candidate.include_router(http.build_owner_sync_router(lambda: sqlite3.connect(database, factory=FailClose)))
    token = owners._issue_session(owners.SecretStr(PASSWORD))["access_token"]
    # This existing synthetic remote fixture has schema-table9/header8. Only
    # this explicit local test header is changed; the runtime never does so.
    with sqlite3.connect(database) as conn:
        conn.execute("PRAGMA user_version=9")
    with TestClient(candidate) as client:
        response = client.post("/api/v2/owner/sync", json=request(), headers={
            "Authorization": "Bearer " + token, "X-Owner-Sync-Consent": "owner-sync-v1",
        })
    assert response.status_code == 503 and response.json() == {"detail": "sync_result_unknown"}
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT revision FROM owner_sync_state").fetchone()[0] == 1
    private(response)
