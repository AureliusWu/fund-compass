"""Owner Policy HTTP reads over actual, explicitly provisioned local SQLite.

No TestClient lifespan is entered, no default database is opened, and no cloud
or process/deployment evidence is claimed. Faults exercise response boundaries
around the real Policy reader rather than replacing its business result.
"""
from contextlib import closing
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import hashlib
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import main
from database import db
from database.owner_analysis_schema import provision_owner_analysis_candidate
from database.owner_sync_schema import provision_owner_sync_candidate
from service import owner_policy as http, owner_sessions as owners, security, v8_repo
from strategy.decision_v2 import build_portfolio_policy

PATH = "/api/v2/private/portfolio/policy-state"
PASSWORD = "policy router local fixture password"
SECRET = "private-driver-detail-must-not-leak"


@pytest.fixture(scope="module")
def password_hash():
    return owners.hash_owner_password(PASSWORD)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch, password_hash):
    owners.reset_owner_sessions()
    security.reset_rate_limits()
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "never-open-default.sqlite3"))
    for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN"):
        monkeypatch.setenv(name, "policy-fixture-" + name)
    yield
    owners.reset_owner_sessions()
    security.reset_rate_limits()


def connect(path, *, factory=sqlite3.Connection):
    conn = sqlite3.connect(path, factory=factory)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@pytest.fixture
def local_db(tmp_path, monkeypatch):
    path = tmp_path / "explicit-policy-state.sqlite3"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    # Real initialization, including sqlite_stat1 on the supported 3.12 runtime.
    db.init_db()
    with closing(connect(path)) as conn:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
    return path


@pytest.fixture
def policy_db(local_db):
    now = datetime.now(timezone.utc)
    created = now - timedelta(minutes=5)
    policies = []
    for index, effective in enumerate((now - timedelta(days=2), now - timedelta(days=1), now + timedelta(days=1))):
        policy = build_portfolio_policy(
            name=f"Private Policy timeline {index}", source="local-policy-http-fixture",
            target_allocations={"510300": 0 if index == 0 else 20},
            max_single_fund_weight=40, rebalance_band=0,
            effective_at=effective, created_at=created,
            supersedes=policies[-1].policy_version if policies else None,
        )
        policies.append(v8_repo.save_policy(policy))
    return local_db, policies


def private(response):
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"


def login(client):
    response = client.post("/api/v2/owner/session", json={"password": PASSWORD})
    assert response.status_code == 200, response.text
    private(response)
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def app_with(factory):
    app = FastAPI()
    app.middleware("http")(main.private_response_cache_policy)
    app.include_router(owners.router)
    app.include_router(http.build_owner_policy_router(factory))
    return app


def main_client(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Policy HTTP entered lifespan or a default database factory")

    monkeypatch.setattr(main, "init_db", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    # closing only calls close; unlike `with TestClient`, it never runs startup.
    return closing(TestClient(main.app))


def image(path):
    with closing(connect(path)) as conn:
        schema = tuple(tuple(row) for row in conn.execute(
            "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"))
        rows = tuple(tuple(row) for row in conn.execute(
            "SELECT * FROM portfolio_policy_versions ORDER BY policy_version"))
        scopes = tuple(tuple(row) for row in conn.execute(
            "SELECT * FROM v8_record_scopes ORDER BY record_kind,record_id"))
        return schema, rows, scopes


def unavailable(response):
    assert response.status_code == 503, response.text
    assert response.json() == {"detail": "policy_state_unavailable"}
    assert SECRET not in response.text and SECRET not in str(response.headers)
    private(response)


def fingerprint(auth):
    token = auth["Authorization"].removeprefix("Bearer ")
    return hashlib.sha256(token.encode("ascii")).digest()


def test_construction_and_real_main_openapi_are_zero_io(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Policy router/OpenAPI construction opened storage")

    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "_database_file", forbidden)
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    http.build_owner_policy_router(forbidden)
    monkeypatch.setattr(main.app, "openapi_schema", None)
    operation = main.app.openapi()["paths"][PATH]["get"]
    assert operation["security"] == [{"OwnerSessionBearer": []}]
    assert "parameters" not in operation


@pytest.mark.parametrize("profile", ["owner-only", "analysis"])
def test_real_main_reads_existing_production_policy_chain_read_only(policy_db, monkeypatch, profile):
    path, policies = policy_db
    if profile == "analysis":
        with closing(connect(path)) as conn:
            provision_owner_analysis_candidate(conn, synthetic_candidate=True)
    before = image(path)
    original_connect = sqlite3.connect
    opened, statements = [], []

    def traced(database, *args, **kwargs):
        conn = original_connect(database, *args, **kwargs)
        if database != ":memory:":
            assert database == path.as_uri() + "?mode=rw"
            assert kwargs["uri"] is True
            conn.set_trace_callback(statements.append)
            opened.append(conn)
        return conn

    monkeypatch.setattr(sqlite3, "connect", traced)
    with main_client(monkeypatch) as client:
        response = client.get(PATH, headers=login(client))
        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body) == {"schema_version", "observed_at", "current", "next_effective_at", "history"}
        assert body["schema_version"] == "owner-policy-state-1"
        assert body["current"] == policies[1].model_dump(mode="json")
        assert body["history"] == [policy.model_dump(mode="json") for policy in reversed(policies)]
        assert datetime.fromisoformat(body["next_effective_at"].replace("Z", "+00:00")) == policies[2].effective_at
        assert body["history"][-1]["target_allocations"]["510300"] == 0
        assert body["current"]["rebalance_band"] == 0
        private(response)
    assert len(opened) == 1
    for conn in opened:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")
    assert statements
    assert not any(sql.lstrip().upper().startswith(("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "REPLACE"))
                   for sql in statements)
    monkeypatch.setattr(sqlite3, "connect", original_connect)
    assert image(path) == before


def test_real_main_empty_policy_state_does_not_create_default_policy(local_db, monkeypatch):
    before = image(local_db)
    with main_client(monkeypatch) as client:
        response = client.get(PATH, headers=login(client))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["current"] is None and body["next_effective_at"] is None and body["history"] == []
        private(response)
    # Restore only the deliberately disabled legacy factory before direct SQL.
    assert image(local_db) == before


@pytest.mark.parametrize("token", [None, "wrong", "policy-fixture-ADMIN_TOKEN", "policy-fixture-WORKER_TOKEN",
                                  "policy-fixture-PRIVATE_READ_TOKEN"])
def test_real_main_anonymous_and_machine_tokens_never_reach_storage(monkeypatch, token):
    def forbidden(*_args, **_kwargs):
        pytest.fail("non-Owner Policy request reached configured local storage")

    monkeypatch.setattr(db, "database_backend", forbidden)
    with main_client(monkeypatch) as client:
        response = client.get(PATH, headers={"Authorization": "Bearer " + token} if token else {})
        assert response.status_code == 401, response.text
        private(response)


@pytest.mark.parametrize("scopes,expected", [(("write_holdings",), 403), (("run_personal_analysis",), 403),
                                            (("read_private",), 200)])
def test_real_owner_requires_only_read_private_scope(policy_db, monkeypatch, scopes, expected):
    with main_client(monkeypatch) as client:
        auth = login(client)
        key = fingerprint(auth)
        owners._sessions[key] = replace(owners._sessions[key], scopes=scopes)
        if expected != 200:
            monkeypatch.setattr(db, "database_backend", lambda: pytest.fail("missing read scope reached database"))
        response = client.get(PATH, headers=auth)
        assert response.status_code == expected, response.text
        private(response)


@pytest.mark.parametrize("query", ["?unknown=1", "?at=2026-10-23", "?x=1&x=2", "?limit=1&limit=2", "?x="])
def test_any_query_including_duplicate_query_is_rejected_before_storage(monkeypatch, query):
    def forbidden(*_args, **_kwargs):
        pytest.fail("Policy query reached storage")

    with closing(TestClient(app_with(forbidden))) as client:
        response = client.get(PATH + query, headers=login(client))
        assert response.status_code == 422 and response.json() == {"detail": "invalid_policy_state_query"}
        private(response)


def test_duplicate_authorization_is_rejected_before_storage(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("duplicate Authorization reached storage")

    with closing(TestClient(app_with(forbidden))) as client:
        auth = login(client)["Authorization"]
        response = client.get(PATH, headers=[("Authorization", auth), ("Authorization", auth)])
        assert response.status_code == 401, response.text
        private(response)


@pytest.mark.parametrize("stage", ["factory", "read", "close", "serialization"])
@pytest.mark.parametrize("status", [401, 403, 422, 503])
def test_driver_and_serialization_http_exceptions_are_storage_503_not_authority(policy_db, monkeypatch, stage, status):
    path, _policies = policy_db
    closed = []
    original_read = http.read_owner_policy_state

    def fault():
        raise HTTPException(status_code=status, detail=SECRET, headers={"WWW-Authenticate": SECRET})

    class Connection(sqlite3.Connection):
        def close(self):
            super().close()
            closed.append(True)
            if stage == "close":
                fault()

    def factory():
        if stage == "factory":
            fault()
        return connect(path, factory=Connection)

    def read(*args, **kwargs):
        value = original_read(*args, **kwargs)
        if stage == "read":
            fault()
        return value

    monkeypatch.setattr(http, "read_owner_policy_state", read)
    with closing(TestClient(app_with(factory))) as client:
        auth = login(client)
        if stage == "serialization":
            monkeypatch.setattr(http, "json", SimpleNamespace(dumps=lambda *_a, **_kw: fault()))
        unavailable(client.get(PATH, headers=auth))
    assert bool(closed) is (stage != "factory")


def invalidate(auth, kind, monkeypatch):
    key = fingerprint(auth)
    if kind == "revoke":
        owners.reset_owner_sessions()
    elif kind == "expiry":
        # Keep the exact captured session object: its real expiry comparison,
        # not identity replacement, must reject the equality boundary.
        expires = owners._sessions[key].expires_monotonic
        monkeypatch.setattr(owners, "time", SimpleNamespace(monotonic=lambda: expires))
    elif kind == "configuration":
        monkeypatch.setenv("OWNER_PASSWORD_HASH", "changed-configuration-invalidates-original-session")
    elif kind == "machine-collision":
        monkeypatch.setenv("WORKER_TOKEN", auth["Authorization"].removeprefix("Bearer "))
    else:
        owners._sessions[key] = replace(owners._sessions[key], scopes=("write_holdings",))


@pytest.mark.parametrize("kind", ["revoke", "expiry", "configuration", "machine-collision", "scope-replaced"])
@pytest.mark.parametrize("stage", ["read", "close", "serialization"])
def test_late_authority_change_never_delivers_private_policy(policy_db, monkeypatch, kind, stage):
    path, _policies = policy_db
    original_read, original_dumps = http.read_owner_policy_state, http.json.dumps
    auth = None
    closed = []

    def change():
        invalidate(auth, kind, monkeypatch)

    class Connection(sqlite3.Connection):
        def close(self):
            super().close()
            closed.append(True)
            if stage == "close":
                change()

    def read(*args, **kwargs):
        result = original_read(*args, **kwargs)
        if stage == "read":
            change()
        return result

    def dumps(*args, **kwargs):
        result = original_dumps(*args, **kwargs)
        change()
        return result

    monkeypatch.setattr(http, "read_owner_policy_state", read)
    with closing(TestClient(app_with(lambda: connect(path, factory=Connection)))) as client:
        auth = login(client)
        if stage == "serialization":
            monkeypatch.setattr(http, "json", SimpleNamespace(dumps=dumps))
        response = client.get(PATH, headers=auth)
        assert response.status_code == 401, response.text
        assert "Private Policy timeline" not in response.text
        private(response)
    assert closed == [True]


@pytest.mark.parametrize("stage", ["authorization", "factory", "read", "close", "serialization"])
@pytest.mark.parametrize("elapsed,expected", [(29.999, 200), (30.0, 503)])
def test_total_read_budget_includes_authorization_factory_close_and_serialization(policy_db, monkeypatch, stage, elapsed, expected):
    path, _policies = policy_db
    clock = [100.0]
    original_read, original_dumps = http.read_owner_policy_state, http.json.dumps
    original_require = owners.require_owner_authorization

    def advance():
        clock[0] = 100.0 + elapsed

    class Connection(sqlite3.Connection):
        def close(self):
            super().close()
            if stage == "close":
                advance()

    def factory():
        if stage == "factory":
            advance()
        return connect(path, factory=Connection)

    def read(*args, **kwargs):
        result = original_read(*args, **kwargs)
        if stage == "read":
            advance()
        return result

    def require(*args, **kwargs):
        result = original_require(*args, **kwargs)
        if stage == "authorization":
            advance()
        return result

    def dumps(*args, **kwargs):
        result = original_dumps(*args, **kwargs)
        advance()
        return result

    # Only the router's clock changes; AnyIO/session/reader clocks stay real.
    monkeypatch.setattr(http, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(http, "read_owner_policy_state", read)
    monkeypatch.setattr(owners, "require_owner_authorization", require)
    with closing(TestClient(app_with(factory))) as client:
        auth = login(client)
        if stage == "serialization":
            monkeypatch.setattr(http, "json", SimpleNamespace(dumps=dumps))
        response = client.get(PATH, headers=auth)
        assert response.status_code == expected, response.text
        private(response)
        if expected == 503:
            unavailable(response)


@pytest.mark.parametrize("clock", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_router_clock_fails_closed_before_storage(monkeypatch, clock):
    def forbidden(*_args, **_kwargs):
        pytest.fail("invalid Policy clock reached storage")

    with closing(TestClient(app_with(forbidden))) as client:
        auth = login(client)
        monkeypatch.setattr(http, "time", SimpleNamespace(monotonic=lambda: clock))
        unavailable(client.get(PATH, headers=auth))


def test_router_clock_regression_between_in_budget_checks_fails_closed(policy_db, monkeypatch):
    clock = [100.0]
    original_read = http.read_owner_policy_state

    class Connection(sqlite3.Connection):
        def close(self):
            super().close()
            clock[0] = 109.0

    def read(*args, **kwargs):
        result = original_read(*args, **kwargs)
        clock[0] = 110.0
        return result

    monkeypatch.setattr(http, "read_owner_policy_state", read)
    monkeypatch.setattr(http, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    with closing(TestClient(app_with(lambda: connect(policy_db[0], factory=Connection)))) as client:
        unavailable(client.get(PATH, headers=login(client)))


def test_response_utf8_capacity_failure_is_private_fixed_503(policy_db, monkeypatch):
    with closing(TestClient(app_with(lambda: connect(policy_db[0])))) as client:
        auth = login(client)
        monkeypatch.setattr(http, "json", SimpleNamespace(dumps=lambda *_a, **_kw: "中" * (http.MAX_RESPONSE_BYTES // 3 + 1)))
        unavailable(client.get(PATH, headers=auth))


@pytest.mark.parametrize("fault", ["core-only", "schema8", "unknown-table", "missing-policy-trigger",
                                  "bad-policy-view", "partial-analysis", "empty-file", "missing-path"])
def test_real_main_incompatible_storage_is_never_created_or_repaired(policy_db, tmp_path, monkeypatch, fault):
    path, _policies = policy_db
    if fault == "core-only":
        path = tmp_path / "explicit-core-only.sqlite3"
        monkeypatch.setattr(db, "DB_PATH", str(path))
        db.init_db()
    elif fault == "empty-file":
        path = tmp_path / "explicit-empty.sqlite3"
        path.touch()
    elif fault == "missing-path":
        path = tmp_path / "must-not-create-parent" / "missing.sqlite3"
    else:
        with closing(connect(path)) as conn:
            if fault == "schema8":
                conn.execute("PRAGMA user_version=8")
            elif fault == "unknown-table":
                conn.execute("CREATE TABLE unexpected_policy_extra(private TEXT)")
            elif fault == "missing-policy-trigger":
                conn.execute("DROP TRIGGER immutable_portfolio_policy_versions_update")
            elif fault == "bad-policy-view":
                conn.execute("DROP VIEW production_portfolio_policy_versions")
                conn.execute("CREATE VIEW production_portfolio_policy_versions AS SELECT * FROM portfolio_policy_versions")
            else:
                provision_owner_analysis_candidate(conn, synthetic_candidate=True)
                conn.execute("DROP TABLE owner_analysis_components")
            conn.commit()
    monkeypatch.setattr(db, "DB_PATH", str(path))
    original = path.read_bytes() if path.exists() else None
    with main_client(monkeypatch) as client:
        unavailable(client.get(PATH, headers=login(client)))
    assert path.exists() is (original is not None)
    if original is not None:
        assert path.read_bytes() == original
    else:
        assert not path.parent.exists()


@pytest.mark.parametrize("configured", [":memory:", "file:unselected.sqlite3?mode=memory", "//unselected-host/db.sqlite3"])
def test_real_main_closed_factory_does_not_accept_memory_uri_or_network_paths(monkeypatch, configured):
    monkeypatch.setattr(db, "DB_PATH", configured)
    monkeypatch.setattr(sqlite3, "connect", lambda *_a, **_kw: pytest.fail("forbidden configured path reached SQLite"))
    with main_client(monkeypatch) as client:
        unavailable(client.get(PATH, headers=login(client)))


def test_real_main_remote_configuration_never_enters_local_sqlite_or_cloud(monkeypatch):
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    monkeypatch.setattr(sqlite3, "connect", lambda *_a, **_kw: pytest.fail("remote Policy route opened SQLite"))
    monkeypatch.setattr(db, "_turso_connection", lambda *_a, **_kw: pytest.fail("Policy route opened cloud"), raising=False)
    with main_client(monkeypatch) as client:
        unavailable(client.get(PATH, headers=login(client)))
