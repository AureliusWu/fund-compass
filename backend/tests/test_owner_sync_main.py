"""Real main.app routing + explicitly prepared synthetic SQLite only.

TestClient is deliberately not entered as a context manager: these request
integration tests do not invoke or replace the existing startup lifespan.
Startup migration and Turso schema-8 rejection remain separate unchanged gates.
"""
from contextlib import closing
import copy
import sqlite3

import pytest
from fastapi.testclient import TestClient

import main
from database import db, turso, turso_schema
from service import owner_sessions as owners, owner_sync as http, security
from test_owner_sync_http import (
    PASSWORD, PRIVATE_NAME, database, private, receipt_headers, request,
)


@pytest.fixture(scope="module")
def password_hash():
    return owners.hash_owner_password(PASSWORD)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch, password_hash):
    owners.reset_owner_sessions()
    security.reset_rate_limits()
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "ephemeral")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "not-created-default.db"))
    for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN"):
        monkeypatch.setenv(name, "synthetic-" + name)

    def forbidden(*_args, **_kwargs):
        pytest.fail("main sync request entered automatic connection/startup provisioning")

    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(main, "init_db", forbidden)
    yield
    owners.reset_owner_sessions()
    security.reset_rate_limits()


@pytest.fixture
def client():
    active = TestClient(main.app)
    yield active
    active.close()


@pytest.fixture
def configured_database(database, monkeypatch):
    # Reuse the existing test-only core + explicit synthetic extension fixture.
    monkeypatch.setattr(db, "DB_PATH", str(database))
    return database


def login(client):
    response = client.post("/api/v2/owner/session", json={"password": PASSWORD})
    assert response.status_code == 200
    private(response)
    value = response.json()
    assert value["owner_id"] == "owner" and value["token_type"] == "Bearer"
    assert set(value["scopes"]) == {"read_private", "write_holdings", "run_personal_analysis"}
    return {"Authorization": "Bearer " + value["access_token"], "X-Owner-Sync-Consent": "owner-sync-v1"}


def filesystem_snapshot(root):
    return {
        str(path.relative_to(root)): path.read_bytes() if path.is_file() else None
        for path in root.rglob("*")
    }


def track_configured_connections(monkeypatch, path):
    connect = sqlite3.connect
    connections, statements, arguments = [], [], []

    def traced(database, *args, **kwargs):
        conn = connect(database, *args, **kwargs)
        # verify_owner_sync_schema may build its trusted in-memory reference.
        # Only the actual configured file is the target of this no-DDL check.
        if database != ":memory:":
            assert database == path.as_uri() + "?mode=rw"
            assert kwargs["uri"] is True
            arguments.append(kwargs)
            connections.append(conn)
            conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(http.sqlite3, "connect", traced)
    return connections, statements, arguments


def test_main_uses_existing_file_with_connection_pragmas_and_select_only_verification(configured_database, monkeypatch):
    monkeypatch.setenv("FUND_DB_TIMEOUT_SECONDS", "1.25")
    before = configured_database.read_bytes()
    connections, statements, arguments = track_configured_connections(monkeypatch, configured_database)
    with closing(http.configured_local_sync_connection()) as conn:
        assert conn.row_factory is sqlite3.Row
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 1250
        assert conn.in_transaction is False
    assert len(connections) == 1 and arguments[0]["timeout"] == 1.25
    assert statements and all(sql.lstrip().upper().startswith(("SELECT", "PRAGMA")) for sql in statements)
    assert configured_database.read_bytes() == before
    with pytest.raises(sqlite3.ProgrammingError):
        connections[0].execute("SELECT 1")


def test_main_login_write_replay_conflict_receipts_fixed_upper_pagination_and_logout(client, configured_database, monkeypatch):
    auth = login(client)
    initial = request("main-sync-0001")
    second = copy.deepcopy(initial["operations"][0])
    second["key"] = "asset:synthetic-http-z"
    initial["operations"].append(second)
    first = client.post("/api/v2/owner/sync", headers=auth, json=initial)
    assert first.status_code == 200 and first.json()["revision"] == 1
    assert all(record["values"]["value"] == 0 for record in first.json()["records"])
    assert "holding_version" not in first.json()
    replay = client.post("/api/v2/owner/sync", headers=auth, json=initial)
    assert (replay.status_code, replay.content) == (first.status_code, first.content)
    receipt = client.get("/api/v2/owner/sync/requests/main-sync-0001",
                         headers=receipt_headers(auth, initial))
    assert receipt.status_code == 200
    assert receipt.json() == {"state": "matched", "status": 200, "result": first.json()}

    first_page = client.get("/api/v2/owner/sync", headers=auth, params={"limit": 1})
    page = first_page.json()
    assert first_page.status_code == 200 and page["upper_revision"] == 1 and page["complete"] is False
    later = request("main-later-0001", expected=1, value=3)
    later["operations"][0]["key"] = "asset:synthetic-http-new"
    newer_write = client.post("/api/v2/owner/sync", headers=auth, json=later)
    assert newer_write.status_code == 200 and newer_write.json()["revision"] == 2
    revision, key = page["next_cursor"]
    last_page = client.get("/api/v2/owner/sync", headers=auth, params={
        "limit": 1, "upper_revision": 1, "cursor_revision": revision, "cursor_key": key,
    })
    assert last_page.status_code == 200
    assert last_page.json()["upper_revision"] == 1 and last_page.json()["complete"] is True
    combined = page["changes"] + last_page.json()["changes"]
    assert len(combined) == 2 and all(row["record_revision"] == 1 for row in combined)
    increment = client.get("/api/v2/owner/sync", headers=auth, params={"since_revision": 1})
    assert increment.status_code == 200 and increment.json()["upper_revision"] == 2
    assert [row["key"] for row in increment.json()["changes"]] == ["asset:synthetic-http-new"]

    conflict_input = request("main-conflict-0001", value=1)
    conflict_input["operations"][0]["changes"] = {"value": 1}
    conflict_input["operations"][0]["base_values"] = {"value": 0}
    conflict = client.post("/api/v2/owner/sync", headers=auth, json=conflict_input)
    assert conflict.status_code == 409 and PRIVATE_NAME not in conflict.text
    assert conflict.json()["error"]["code"] == "sync_conflict"
    conflict_receipt = client.get("/api/v2/owner/sync/requests/main-conflict-0001",
                                  headers=receipt_headers(auth, conflict_input))
    assert conflict_receipt.status_code == 200
    assert conflict_receipt.json() == {"state": "matched", "status": 409, "result": conflict.json()}
    missing = request("main-missing-0001")
    absent = client.get("/api/v2/owner/sync/requests/main-missing-0001",
                        headers=receipt_headers(auth, missing))
    assert absent.status_code == 404
    assert absent.json() == {"state": "unknown", "error": "sync_result_unknown"}

    logout = client.delete("/api/v2/owner/session", headers=auth)
    assert logout.status_code == 204
    for response in (first, replay, receipt, first_page, newer_write, last_page,
                     increment, conflict, conflict_receipt, absent, logout):
        private(response)

    def forbidden(*_args, **_kwargs):
        pytest.fail("revoked main Owner reached the configured factory")
    monkeypatch.setattr(db, "database_backend", forbidden)
    for response in (
        client.get("/api/v2/owner/sync", headers=auth),
        client.post("/api/v2/owner/sync", headers=auth, json=request()),
        client.get("/api/v2/owner/sync/requests/main-sync-0001", headers=receipt_headers(auth, initial)),
    ):
        assert response.status_code == 401 and PRIVATE_NAME not in response.text
        private(response)


@pytest.mark.parametrize("fault", ["unextended", "unknown_table", "version8", "missing", "memory", "corrupt"])
def test_main_storage_rejection_is_fixed_closed_and_never_creates_or_repairs_schema(
        client, configured_database, tmp_path, monkeypatch, fault):
    path = configured_database
    if fault == "unextended":
        path = tmp_path / "unextended-core.db"
        with sqlite3.connect(path) as conn:
            for ddl in turso_schema.expected_objects().values():
                conn.execute(ddl)
            conn.execute("PRAGMA user_version=9")
    elif fault == "unknown_table":
        with sqlite3.connect(path) as conn:
            conn.execute("CREATE TABLE unexpected_private_schema(secret TEXT)")
    elif fault == "version8":
        with sqlite3.connect(path) as conn:
            conn.execute("PRAGMA user_version=8")
    elif fault == "missing":
        path = tmp_path / "never-created-parent" / "missing-private.db"
    elif fault == "corrupt":
        path = tmp_path / "corrupt-private.db"
        path.write_bytes(b"synthetic invalid SQLite only")
    monkeypatch.setattr(db, "DB_PATH", ":memory:" if fault == "memory" else str(path))
    auth = login(client)
    before = filesystem_snapshot(tmp_path)
    connections, statements, _arguments = track_configured_connections(monkeypatch, path)
    with pytest.raises(sqlite3.DatabaseError, match="^Owner sync local storage is unavailable$"):
        http.configured_local_sync_connection()
    for response, expected in (
        (client.get("/api/v2/owner/sync", headers=auth), {"detail": "sync_storage_unavailable"}),
        (client.post("/api/v2/owner/sync", headers=auth, json=request()), {"detail": "sync_storage_unavailable"}),
        (client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers(auth)),
         {"state": "unknown", "error": "sync_result_unknown"}),
    ):
        assert response.status_code == 503 and PRIVATE_NAME not in response.text and str(path) not in response.text
        private(response)
        assert response.json() == expected
    assert filesystem_snapshot(tmp_path) == before
    assert all(sql.lstrip().upper().startswith(("SELECT", "PRAGMA")) for sql in statements)
    for conn in connections:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")


@pytest.mark.parametrize("backend", ["turso", "unsupported"])
def test_main_non_sqlite_rejects_before_path_resolution_credentials_or_any_connect(client, monkeypatch, backend):
    auth = login(client)
    monkeypatch.setenv("FUND_DB_BACKEND", backend)
    calls = []
    def forbidden(*_args, **_kwargs):
        calls.append(True)
        pytest.fail("Turso sync touched a path, credential settings or connection")
    for name in ("get_conn", "_turso_settings", "_database_file"):
        monkeypatch.setattr(db, name, forbidden)
    monkeypatch.setattr(turso, "connect", forbidden)
    monkeypatch.setattr(http.sqlite3, "connect", forbidden)
    with pytest.raises(sqlite3.DatabaseError, match="^Owner sync local storage is unavailable$"):
        http.configured_local_sync_connection()
    for response, expected in (
        (client.get("/api/v2/owner/sync", headers=auth), {"detail": "sync_storage_unavailable"}),
        (client.post("/api/v2/owner/sync", headers=auth, json=request()), {"detail": "sync_storage_unavailable"}),
        (client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers(auth)),
         {"state": "unknown", "error": "sync_result_unknown"}),
    ):
        assert response.status_code == 503 and response.json() == expected
        private(response)
    assert calls == []


@pytest.mark.parametrize("credential", [None, "wrong", "synthetic-ADMIN_TOKEN", "synthetic-WORKER_TOKEN",
                                        "synthetic-PRIVATE_READ_TOKEN"])
def test_main_anonymous_and_machine_credentials_never_enter_factory(client, monkeypatch, credential):
    def forbidden(*_args, **_kwargs):
        pytest.fail("untrusted main request entered the configured factory")
    monkeypatch.setattr(db, "database_backend", forbidden)
    auth = {"Authorization": "Bearer " + credential} if credential else {}
    auth["X-Owner-Sync-Request-Hash"] = "0" * 64
    for response in (
        client.get("/api/v2/owner/sync", headers=auth),
        client.post("/api/v2/owner/sync", headers=auth, json=request()),
        client.get("/api/v2/owner/sync/requests/http-test-0001", headers=auth),
    ):
        assert response.status_code == 401 and PRIVATE_NAME not in response.text
        private(response)


@pytest.mark.parametrize("consent", [None, "legacy-gist"])
def test_main_owner_without_sync_consent_never_enters_factory(client, monkeypatch, consent):
    auth = login(client)
    if consent is None:
        auth.pop("X-Owner-Sync-Consent")
    else:
        auth["X-Owner-Sync-Consent"] = consent
    def forbidden(*_args, **_kwargs):
        pytest.fail("main sync without consent entered the configured factory")
    monkeypatch.setattr(db, "database_backend", forbidden)
    response = client.post("/api/v2/owner/sync", headers=auth, json=request())
    assert response.status_code == 403 and response.json() == {"detail": "sync_consent_required"}
    private(response)


@pytest.mark.parametrize("configured", [
    "file:synthetic-owner.db?mode=ro",
    "file:synthetic-owner.db?immutable=1",
    "file:synthetic-owner.db?mode=rw&cache=shared",
    "file:synthetic-owner.db",
    "FILE:synthetic-owner.db?mode=ro",
    ":memory:",
    "\\\\synthetic-host\\share\\private.db",
    "//synthetic-host/share/private.db",
    "",
    None,
])
def test_main_non_plain_file_configuration_is_rejected_before_resolution_settings_or_connect(
        client, monkeypatch, configured):
    auth = login(client)
    monkeypatch.setattr(db, "DB_PATH", configured)
    calls = []
    def forbidden(*_args, **_kwargs):
        calls.append(True)
        pytest.fail("non-plain local configuration reached path resolution, settings or connect")
    for name in ("_database_file", "_timeout_seconds", "_turso_settings", "get_conn"):
        monkeypatch.setattr(db, name, forbidden)
    monkeypatch.setattr(turso, "connect", forbidden)
    monkeypatch.setattr(http.sqlite3, "connect", forbidden)
    with pytest.raises(sqlite3.DatabaseError, match="^Owner sync local storage is unavailable$"):
        http.configured_local_sync_connection()
    for response, expected in (
        (client.get("/api/v2/owner/sync", headers=auth), {"detail": "sync_storage_unavailable"}),
        (client.post("/api/v2/owner/sync", headers=auth, json=request()), {"detail": "sync_storage_unavailable"}),
        (client.get("/api/v2/owner/sync/requests/http-test-0001", headers=receipt_headers(auth)),
         {"state": "unknown", "error": "sync_result_unknown"}),
    ):
        assert response.status_code == 503 and response.json() == expected
        private(response)
    assert calls == []
    assert db.DB_PATH is configured
