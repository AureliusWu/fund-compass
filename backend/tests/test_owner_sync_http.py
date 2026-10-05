"""Real Owner HTTP + explicit synthetic SQLite, without application mounting."""
import asyncio
from dataclasses import replace
import json
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from database import turso_schema
from database.owner_sync_schema import provision_owner_sync_candidate
from models.owner_sync import parse_sync_request
from service import owner_sessions as owners, owner_sync as http, owner_sync_repo as repo, security

PASSWORD = "synthetic owner-sync HTTP password"
PRIVATE_NAME = "synthetic private asset never in error"


@pytest.fixture(scope="module")
def password_hash():
    return owners.hash_owner_password(PASSWORD)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, password_hash):
    owners.reset_owner_sessions()
    security.reset_rate_limits()
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN"):
        monkeypatch.setenv(name, "synthetic-" + name)
    yield
    owners.reset_owner_sessions()
    security.reset_rate_limits()


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "synthetic-owner-http.db"
    with sqlite3.connect(path) as conn:
        for ddl in turso_schema.expected_objects().values():
            conn.execute(ddl)
        conn.execute("PRAGMA user_version=9")
        conn.commit()
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
    return path


@pytest.fixture
def client(database):
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(lambda: sqlite3.connect(database)))
    with TestClient(app) as active:
        yield active


def headers():
    token = owners._issue_session(owners.SecretStr(PASSWORD))["access_token"]
    return {"Authorization": "Bearer " + token, "X-Owner-Sync-Consent": "owner-sync-v1"}


def request(request_id="http-test-0001", expected=0, *, value=0):
    return {"request_id": request_id, "expected_revision": expected, "operations": [{
        "key": "asset:synthetic-http", "kind": "manual_asset", "deleted": False,
        "changes": {"name": PRIVATE_NAME, "cls": "现金", "value": value, "note": None},
    }]}


def receipt_headers(auth=None, payload=None):
    original = request() if payload is None else payload
    request_hash = parse_sync_request(json.dumps(original, ensure_ascii=False)).request_hash()
    return {**(headers() if auth is None else auth), "X-Owner-Sync-Request-Hash": request_hash}


def private(response):
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_success_replay_and_receipt_use_real_owner_sqlite_chain(client):
    auth = headers()
    first = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert first.status_code == 200
    assert first.json()["revision"] == 1
    assert first.json()["records"][0]["values"]["value"] == 0
    replay = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert (replay.status_code, replay.content) == (first.status_code, first.content)
    receipt = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers(auth))
    assert receipt.status_code == 200
    assert receipt.json() == {"state": "matched", "status": 200, "result": first.json()}
    page = client.get("/api/v2/owner/sync", headers=auth)
    assert page.status_code == 200
    assert page.json()["complete"] is True
    assert page.json()["upper_revision"] == 1
    for response in (first, replay, receipt, page):
        private(response)


@pytest.mark.parametrize("credential", [None, "wrong", "synthetic-ADMIN_TOKEN", "synthetic-WORKER_TOKEN", "synthetic-PRIVATE_READ_TOKEN"])
def test_auth_precedes_body_and_connection(client, monkeypatch, credential):
    async def forbidden_body(_):
        pytest.fail("untrusted credential reached body")
    monkeypatch.setattr(http, "_read_body", forbidden_body)
    auth = {"Authorization": "Bearer " + credential} if credential else {}
    auth["X-Owner-Sync-Request-Hash"] = "0" * 64
    for path, method in (("/api/v2/owner/sync", client.post), ("/api/v2/owner/sync", client.get),
                         ("/api/v2/owner/sync/requests/http-test-0001", client.get)):
        response = method(path, headers=auth)
        assert response.status_code == 401
        private(response)


def test_read_only_scope_does_not_grant_write(client):
    auth = headers()
    fingerprint = next(iter(owners._sessions))
    owners._sessions[fingerprint] = replace(owners._sessions[fingerprint], scopes=("read_private",))
    assert client.get("/api/v2/owner/sync", headers=auth).status_code == 200
    response = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert response.status_code == 403
    private(response)


def test_new_sync_requires_separate_consent_not_gist_or_authorization_only(client):
    auth = headers()
    for value in (None, "true", "legacy-gist", "owner-sync-v1,owner-sync-v1"):
        consent = {**auth}
        if value is None:
            consent.pop("X-Owner-Sync-Consent")
        else:
            consent["X-Owner-Sync-Consent"] = value
        response = client.post("/api/v2/owner/sync", headers=consent, json=request())
        assert response.status_code == 403
        private(response)
        assert PRIVATE_NAME not in response.text


@pytest.mark.parametrize("body", [
    '{"request_id":"http-test-0001","expected_revision":0,"operations":[],"private":"secret-input"}',
    '{"request_id":"secret-input","request_id":"http-test-0001"}',
    '{"expected_revision":NaN,"private":"secret-input"}',
    '{"secret-input":', '"secret-input"',
])
def test_validation_fixed_error_never_echoes_input(client, body):
    response = client.post("/api/v2/owner/sync", headers={**headers(), "Content-Type": "application/json"}, content=body)
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_sync_request"}
    assert "secret-input" not in response.text
    private(response)


def test_content_type_and_body_size_bounds(client):
    auth = headers()
    wrong = client.post("/api/v2/owner/sync", headers=auth, content=json.dumps(request()))
    assert wrong.status_code == 415
    oversized = client.post("/api/v2/owner/sync", headers={**auth, "Content-Type": "application/json"}, content=b"x" * (http.MAX_BODY_BYTES + 1))
    assert oversized.status_code == 413
    for response in (wrong, oversized):
        private(response)


def test_streamed_size_and_deadline_without_trusting_content_length(monkeypatch):
    class Streaming:
        headers = {"content-type": "application/json", "x-owner-sync-consent": "owner-sync-v1"}
        async def stream(self):
            yield b"x" * http.MAX_BODY_BYTES
            yield b"x"
    class Pending(Streaming):
        async def stream(self):
            await asyncio.sleep(10)
            yield b"{}"
    with pytest.raises(http.HTTPException) as size:
        asyncio.run(http._read_body(Streaming()))
    assert size.value.status_code == 413
    monkeypatch.setattr(http, "BODY_DEADLINE_SECONDS", 0.01)
    with pytest.raises(http.HTTPException) as deadline:
        asyncio.run(http._read_body(Pending()))
    assert deadline.value.status_code == 408
    assert deadline.value.headers["Cache-Control"] == "no-store"


def test_logout_during_body_prevents_database_write(client, database, monkeypatch):
    auth = headers()
    original = http._read_body
    async def logout_after_body(value):
        raw = await original(value)
        from fastapi.security import HTTPAuthorizationCredentials
        owners.logout_owner(HTTPAuthorizationCredentials(scheme="Bearer", credentials=auth["Authorization"][7:]))
        return raw
    monkeypatch.setattr(http, "_read_body", logout_after_body)
    response = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert response.status_code == 401
    private(response)
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT revision FROM owner_sync_state").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM owner_sync_receipts").fetchone()[0] == 0


def test_logout_after_commit_does_not_deliver_private_success_or_undo_commit(client, database, monkeypatch):
    auth = headers()
    apply = repo.apply_sync_local
    def apply_then_logout(*args, **kwargs):
        result = apply(*args, **kwargs)
        owners.reset_owner_sessions()
        return result
    monkeypatch.setattr(repo, "apply_sync_local", apply_then_logout)
    response = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert response.status_code == 401
    assert PRIVATE_NAME not in response.text
    private(response)
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT revision FROM owner_sync_state").fetchone()[0] == 1
    # A new owner session may reconcile the accepted write across logout.
    stored = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers())
    assert stored.status_code == 200
    assert stored.json()["state"] == "matched"


def test_logout_after_read_does_not_deliver_captured_private_records(client, monkeypatch):
    auth = headers()
    assert client.post("/api/v2/owner/sync", headers=auth, json=request()).status_code == 200
    read = repo.read_sync_changes
    def read_then_logout(*args, **kwargs):
        page = read(*args, **kwargs)
        owners.reset_owner_sessions()
        return page
    monkeypatch.setattr(repo, "read_sync_changes", read_then_logout)
    response = client.get("/api/v2/owner/sync", headers=auth)
    assert response.status_code == 401
    assert PRIVATE_NAME not in response.text
    private(response)


def test_logout_after_receipt_insert_before_commit_rolls_back(database):
    class RevokeBeforeCommit(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            result = super().execute(sql, parameters)
            if sql.startswith("INSERT INTO owner_sync_receipts"):
                owners.reset_owner_sessions()
            return result
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(lambda: sqlite3.connect(database, factory=RevokeBeforeCommit)))
    with TestClient(app) as client:
        response = client.post("/api/v2/owner/sync", headers=headers(), json=request())
    assert response.status_code == 401
    private(response)
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT revision FROM owner_sync_state").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM owner_sync_records").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM owner_sync_receipts").fetchone()[0] == 0


def test_close_failure_after_commit_returns_unknown_without_undoing(database):
    class FailClose(sqlite3.Connection):
        def close(self):
            super().close()
            raise RuntimeError("secret-input after accepted commit")
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(lambda: sqlite3.connect(database, factory=FailClose)))
    with TestClient(app) as client:
        response = client.post("/api/v2/owner/sync", headers=headers(), json=request())
    assert response.status_code == 503
    assert response.json() == {"detail": "sync_result_unknown"}
    private(response)
    with sqlite3.connect(database) as conn:
        receipt = repo.read_sync_receipt(conn, "http-test-0001")
        assert receipt is not None and receipt.status == 200
        assert conn.execute("SELECT revision FROM owner_sync_state").fetchone()[0] == 1


def test_conflict_and_changed_id_replay_never_echo_values(client):
    auth = headers()
    assert client.post("/api/v2/owner/sync", headers=auth, json=request()).status_code == 200
    changed_id = client.post("/api/v2/owner/sync", headers=auth, json=request(value=1))
    assert changed_id.status_code == 409
    assert PRIVATE_NAME not in changed_id.text
    conflict = request("http-conflict-001", value=1)
    conflict["operations"][0]["changes"] = {"value": 1}
    conflict["operations"][0]["base_values"] = {"value": 0}
    first = client.post("/api/v2/owner/sync", headers=auth, json=conflict)
    repeat = client.post("/api/v2/owner/sync", headers=auth, json=conflict)
    assert (first.status_code, first.content) == (repeat.status_code, repeat.content)
    assert first.status_code == 409
    assert PRIVATE_NAME not in first.text
    assert "value" in first.json()["conflicts"][0]["fields"]
    for response in (changed_id, first, repeat):
        private(response)


def test_pagination_keeps_fixed_upper_revision_during_new_writes(client):
    auth = headers()
    initial = request()
    second = json.loads(json.dumps(initial["operations"][0]))
    second["key"] = "asset:synthetic-http-z"
    initial["operations"].append(second)
    assert client.post("/api/v2/owner/sync", headers=auth, json=initial).status_code == 200
    first = client.get("/api/v2/owner/sync", headers=auth, params={"limit": 1}).json()
    assert first["upper_revision"] == 1 and first["complete"] is False
    later = request("http-later-0001", expected=1, value=3)
    later["operations"][0]["key"] = "asset:synthetic-http-new"
    assert client.post("/api/v2/owner/sync", headers=auth, json=later).json()["revision"] == 2
    revision, key = first["next_cursor"]
    last = client.get("/api/v2/owner/sync", headers=auth, params={
        "limit": 1, "upper_revision": 1, "cursor_revision": revision, "cursor_key": key,
    }).json()
    assert last["upper_revision"] == 1 and last["complete"] is True
    assert len(first["changes"] + last["changes"]) == 2
    assert all(row["record_revision"] == 1 for row in first["changes"] + last["changes"])
    newer = client.get("/api/v2/owner/sync", headers=auth, params={"since_revision": 1}).json()
    assert newer["upper_revision"] == 2
    assert [row["key"] for row in newer["changes"]] == ["asset:synthetic-http-new"]


@pytest.mark.parametrize("query", ["limit=0", "limit=201", "limit=1&limit=2", "since_revision=-1", "since_revision=true",
    "upper_revision=0&since_revision=1", "cursor_revision=1", "cursor_key=secret-input", "extra=secret-input", "since_revision=9007199254740992"])
def test_queries_reject_fixed_without_echoing_private_cursor(client, query):
    response = client.get("/api/v2/owner/sync?" + query, headers=headers())
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_sync_query"}
    assert "secret-input" not in response.text
    private(response)


def test_receipt_absent_does_not_claim_definite_rollback(client):
    response = client.get("/api/v2/owner/sync/requests/http-missing-001", headers=receipt_headers(payload=request("http-missing-001")))
    assert response.status_code == 404
    assert response.json() == {"state": "unknown", "error": "sync_result_unknown"}
    private(response)


def test_receipt_same_id_different_original_body_is_unknown_not_false_match(client):
    auth = headers()
    first = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert first.status_code == 200
    changed = client.post("/api/v2/owner/sync", headers=auth, json=request(value=1))
    assert changed.status_code == 409
    changed_headers = receipt_headers(auth, request(value=1))
    unavailable = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=changed_headers)
    assert unavailable.status_code == 503
    assert unavailable.json() == {"state": "unknown", "error": "sync_result_unknown"}
    assert PRIVATE_NAME not in unavailable.text
    assert changed_headers["X-Owner-Sync-Request-Hash"] not in unavailable.text
    assert "http-test-0001" not in unavailable.text
    original = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers(auth))
    assert original.status_code == 200
    assert original.json() == {"state": "matched", "status": 200, "result": first.json()}
    assert set(original.json()) == {"state", "status", "result"}
    for response in (unavailable, original):
        private(response)


def test_receipt_preserves_original_conflict_result_only_for_exact_hash(client):
    auth = headers()
    assert client.post("/api/v2/owner/sync", headers=auth, json=request()).status_code == 200
    conflict = request("http-conflict-002", value=1)
    conflict["operations"][0]["changes"] = {"value": 1}
    conflict["operations"][0]["base_values"] = {"value": 0}
    first = client.post("/api/v2/owner/sync", headers=auth, json=conflict)
    assert first.status_code == 409
    matched = client.get("/api/v2/owner/sync/requests/http-conflict-002", headers=receipt_headers(auth, conflict))
    assert matched.status_code == 200
    assert matched.json() == {"state": "matched", "status": 409, "result": first.json()}
    assert PRIVATE_NAME not in matched.text
    private(matched)


@pytest.mark.parametrize("value", [None, "", "0" * 63, "0" * 65, "A" * 64, "g" * 64,
                                  " " + "0" * 64, "0" * 64 + " ", "0" * 64 + "," + "0" * 64])
def test_receipt_hash_header_is_required_strict_and_checked_before_factory(value):
    def forbidden_factory():
        pytest.fail("invalid receipt header opened a connection")
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(forbidden_factory))
    auth = headers()
    if value is not None:
        auth["X-Owner-Sync-Request-Hash"] = value
    with TestClient(app) as client:
        response = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=auth)
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_sync_request_hash"}
    private(response)


@pytest.mark.parametrize("second_name", ["X-Owner-Sync-Request-Hash", "x-owner-sync-request-hash"])
def test_receipt_rejects_duplicate_hash_header_even_when_values_identical(second_name):
    def forbidden_factory():
        pytest.fail("duplicate receipt hash opened a connection")
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(forbidden_factory))
    auth = list(headers().items()) + [("X-Owner-Sync-Request-Hash", "0" * 64), (second_name, "0" * 64)]
    with TestClient(app) as client:
        response = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=auth)
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_sync_request_hash"}
    private(response)


def test_receipt_rejects_query_without_echo_before_factory():
    def forbidden_factory():
        pytest.fail("receipt query opened a connection")
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(forbidden_factory))
    with TestClient(app) as client:
        response = client.get("/api/v2/owner/sync/requests/http-test-0001?hash=secret-input", headers=receipt_headers())
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_sync_request_id"}
    assert "secret-input" not in response.text
    private(response)


@pytest.mark.parametrize("mode", ["factory", "factory_http_exception", "storage", "missing_matched_result"])
def test_receipt_unavailable_failures_do_not_leak_driver_or_unverified_body(database, monkeypatch, mode):
    def connection():
        if mode == "factory":
            raise RuntimeError("secret-input/driver/path SELECT private")
        if mode == "factory_http_exception":
            raise http.HTTPException(502, "secret-input/private/hash")
        return sqlite3.connect(database)
    if mode == "storage":
        with sqlite3.connect(database) as conn:
            conn.execute("DROP TABLE owner_sync_receipts")
    elif mode == "missing_matched_result":
        monkeypatch.setattr(repo, "reconcile_sync_local", lambda *_args: repo.SyncReconciliation("matched", "http-test-0001"))
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(connection))
    with TestClient(app) as client:
        response = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers())
    assert response.status_code == 503
    assert response.json() == {"state": "unknown", "error": "sync_result_unknown"}
    assert "secret-input" not in response.text and PRIVATE_NAME not in response.text
    private(response)


def test_receipt_close_failure_hides_matched_result_and_closes_connection(database):
    with sqlite3.connect(database) as conn:
        accepted = repo.apply_sync_local(conn, json.dumps(request()))
        assert accepted.status == 200
    closed = []
    class FailClose(sqlite3.Connection):
        def close(self):
            super().close()
            closed.append(True)
            raise RuntimeError("secret-input matched private body/hash")
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(lambda: sqlite3.connect(database, factory=FailClose)))
    with TestClient(app) as client:
        response = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers())
    assert closed == [True]
    assert response.status_code == 503
    assert response.json() == {"state": "unknown", "error": "sync_result_unknown"}
    assert "secret-input" not in response.text and PRIVATE_NAME not in response.text
    private(response)


def test_receipt_logout_after_reconciliation_does_not_deliver_private_result(client, monkeypatch):
    auth = headers()
    assert client.post("/api/v2/owner/sync", headers=auth, json=request()).status_code == 200
    reconcile = repo.reconcile_sync_local
    def read_then_logout(*args, **kwargs):
        result = reconcile(*args, **kwargs)
        assert result.state == "matched"
        owners.reset_owner_sessions()
        return result
    monkeypatch.setattr(repo, "reconcile_sync_local", read_then_logout)
    response = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers(auth))
    assert response.status_code == 401
    assert PRIVATE_NAME not in response.text and "result" not in response.json()
    private(response)


def test_receipt_logout_before_worker_read_never_opens_connection(monkeypatch):
    def forbidden_factory():
        pytest.fail("revoked captured Owner opened receipt connection")
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(forbidden_factory))
    run = http.run_in_threadpool
    async def revoke_before_worker(function, *args, **kwargs):
        owners.reset_owner_sessions()
        return await run(function, *args, **kwargs)
    monkeypatch.setattr(http, "run_in_threadpool", revoke_before_worker)
    with TestClient(app) as client:
        response = client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers())
    assert response.status_code == 401
    assert PRIVATE_NAME not in response.text
    private(response)


def test_receipt_read_rate_limit_is_bounded_before_connection(database, monkeypatch):
    monkeypatch.setattr(security, "PRIVATE_READ_MAX_REQUESTS", 1)
    calls = []
    def connection():
        calls.append(True)
        return sqlite3.connect(database)
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(connection))
    auth = receipt_headers()
    with TestClient(app) as client:
        first = client.get("/api/v2/owner/sync/requests/http-missing-001", headers=auth)
        limited = client.get("/api/v2/owner/sync/requests/http-missing-001", headers=auth)
    assert first.status_code == 404 and calls == [True]
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) >= 1
    for response in (first, limited):
        private(response)


def test_storage_failure_does_not_expose_driver_path_or_sql(monkeypatch):
    def failing():
        raise RuntimeError("secret-input/driver/private/db.sqlite SELECT private")
    app = FastAPI()
    app.include_router(http.build_owner_sync_router(failing))
    with TestClient(app) as client:
        response = client.post("/api/v2/owner/sync", headers=headers(), json=request())
    assert response.status_code == 503
    assert response.json() == {"detail": "sync_storage_unavailable"}
    assert "secret-input" not in response.text
    private(response)


def test_write_rate_limit_is_bounded_before_body(client, monkeypatch):
    monkeypatch.setattr(security, "MAX_REQUESTS", 1)
    auth = headers()
    assert client.post("/api/v2/owner/sync", headers=auth, json=request()).status_code == 200
    response = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) >= 1
    private(response)


def test_candidate_router_not_mounted_in_main():
    import main
    assert not any(getattr(route, "path", "").startswith("/api/v2/owner/sync") for route in main.app.routes)
