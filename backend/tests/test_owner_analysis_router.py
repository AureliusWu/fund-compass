"""Real Owner login and analysis routing over explicitly selected synthetic SQLite.

No default database, application startup, remote storage or market request is
used. Fault wrappers change transport/session boundaries, not the business
implementation used to save and reconcile the actual Holding/Decision chain.
"""
import asyncio
from contextlib import closing
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.datastructures import Headers
from starlette.requests import ClientDisconnect

from database import db
from database.owner_analysis_schema import provision_owner_analysis_candidate
from database.owner_sync_schema import provision_owner_sync_candidate
from models.owner_analysis import parse_owner_analysis_request
from service import owner_analysis as http, owner_analysis_repo as repo
from service import owner_sessions as owners, owner_sync_repo as sync_repo, security, v8_repo
from strategy.decision_v2 import build_evidence_snapshot, build_portfolio_policy

PASSWORD = "synthetic analysis HTTP owner password"
PRIVATE_NAME = "synthetic private analysis fund"
PATH = "/api/v2/owner/analysis"
REQUEST_ID = "analysis-http-0001"


@pytest.fixture(scope="module")
def password_hash():
    return owners.hash_owner_password(PASSWORD)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch, password_hash):
    owners.reset_owner_sessions()
    security.reset_rate_limits()
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "never-open-default.db"))
    for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN"):
        monkeypatch.setenv(name, "synthetic-" + name)
    yield
    owners.reset_owner_sessions()
    security.reset_rate_limits()


def connect(path, *, factory=sqlite3.Connection):
    conn = sqlite3.connect(path, factory=factory)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@pytest.fixture
def database(tmp_path, monkeypatch):
    path = tmp_path / "explicit-synthetic-analysis.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with closing(connect(path)) as conn:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
        provision_owner_analysis_candidate(conn, synthetic_candidate=True)
    at = datetime.now(timezone.utc) - timedelta(minutes=1)
    snapshot = build_evidence_snapshot(
        {"code": "510300", "name": PRIVATE_NAME, "type": "指数型",
         "latest_nav": 1.5, "latest_nav_date": at.date().isoformat(),
         "source": "analysis-http-fixture", "updated_at": at.isoformat(),
         "decision_context": {"status": "unavailable", "source": "analysis-http-fixture"}},
        {"score": 82, "score_version": "analysis-http-fixture", "coverage": 1.0},
        {"signal": "持有", "signal_version": "analysis-http-fixture", "coverage": 1.0,
         "layers": {"valuation": {"percentile": 20}, "trend": {"label": "上升趋势"}}},
        {"available": False}, created_at=at,
    )
    evidence = v8_repo.save_evidence(snapshot)
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="Synthetic analysis guardrails", target_allocations={"510300": 20},
        max_single_fund_weight=40, rebalance_band=2, effective_at=at,
        source="analysis-http-fixture", created_at=at,
    ))
    with closing(connect(path)) as conn:
        seeded = sync_repo.apply_sync_local(conn, json.dumps({
            "request_id": "analysis-seed-0001", "expected_revision": 0,
            "operations": [{"key": "510300::synthetic-account", "kind": "holding", "deleted": False,
                            "changes": {"name": PRIVATE_NAME, "shares": 10, "cost": 1,
                                        "target_weight": 20}}],
        }))
        assert seeded.status == 200 and seeded.body["revision"] == 1
    return path, {
        "request_id": REQUEST_ID, "expected_revision": 1,
        "policy_version": policy.policy_version,
        "evidence": [{"code": "510300", "evidence_id": evidence.evidence_id}],
    }


def app_with(factory):
    from main import private_response_cache_policy
    app = FastAPI()
    app.middleware("http")(private_response_cache_policy)
    app.include_router(owners.router)
    app.include_router(http.build_owner_analysis_router(factory))
    return app


@pytest.fixture
def client(database):
    with TestClient(app_with(lambda: connect(database[0]))) as active:
        yield active


def private(response):
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"


def login(client):
    result = client.post("/api/v2/owner/session", json={"password": PASSWORD})
    assert result.status_code == 200
    private(result)
    assert "run_personal_analysis" in result.json()["scopes"]
    return {"Authorization": "Bearer " + result.json()["access_token"],
            "X-Owner-Analysis-Consent": http.ANALYSIS_CONSENT}


def receipt_headers(auth, payload):
    return {**auth, "X-Owner-Analysis-Request-Hash": parse_owner_analysis_request(json.dumps(payload)).request_hash()}


def counts(path):
    with closing(connect(path)) as conn:
        return {name: conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
                for name in ("owner_analysis_runs", "owner_analysis_components", "holding_versions",
                             "decision_snapshots", "owner_sync_receipts")}


def test_router_construction_and_main_public_contract_open_no_database(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("router inspection opened storage")
    http.build_owner_analysis_router(forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "_database_file", forbidden)
    import main
    routes = main.app.openapi()["paths"]
    assert "post" in routes[PATH]
    assert "get" in routes[PATH + "/requests/{request_id}"]


def test_actual_analysis_replay_receipt_and_independent_sqlite_lineage(client, database):
    path, payload = database
    auth = login(client)
    first = client.post(PATH, headers=auth, json=payload)
    assert first.status_code == 200, first.text
    run = first.json()["run"]
    assert first.json()["source_current"] is True
    assert run["request_id"] == REQUEST_ID and run["source"]["revision"] == 1
    assert run["components"][0]["code"] == "510300"
    before = counts(path)
    assert before["owner_analysis_runs"] == before["owner_analysis_components"] == 1
    assert before["holding_versions"] == before["decision_snapshots"] == 1
    repeated = client.post(PATH, headers=auth, json=payload)
    assert (repeated.status_code, repeated.content) == (200, first.content)
    assert counts(path) == before
    receipt = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, payload))
    assert receipt.status_code == 200
    assert receipt.json() == {"state": "matched", "status": 200, "result": first.json()}
    with closing(connect(path)) as conn:
        component = conn.execute("SELECT holding_version,evidence_id,decision_id FROM owner_analysis_components").fetchone()
        decision = conn.execute("SELECT holding_version,evidence_id,policy_version FROM decision_snapshots WHERE decision_id=?",
                                (component["decision_id"],)).fetchone()
        assert decision["holding_version"] == component["holding_version"]
        assert decision["evidence_id"] == component["evidence_id"] == payload["evidence"][0]["evidence_id"]
        assert decision["policy_version"] == payload["policy_version"]
    for response in (first, repeated, receipt):
        private(response)


@pytest.mark.parametrize("credential", [None, "wrong", "synthetic-ADMIN_TOKEN", "synthetic-WORKER_TOKEN", "synthetic-PRIVATE_READ_TOKEN"])
def test_anonymous_and_machine_auth_are_rejected_before_body_or_storage(monkeypatch, credential):
    def forbidden(*_args, **_kwargs):
        pytest.fail("untrusted credential entered body or storage")
    monkeypatch.setattr(http, "_read_body", forbidden)
    auth = {"Authorization": "Bearer " + credential} if credential else {}
    auth["X-Owner-Analysis-Request-Hash"] = "0" * 64
    with TestClient(app_with(forbidden)) as client:
        for result in (client.post(PATH, headers=auth), client.get(PATH + "/requests/" + REQUEST_ID, headers=auth)):
            assert result.status_code == 401
            private(result)


@pytest.mark.parametrize("scopes", [("read_private",), ("write_holdings",), ("read_private", "write_holdings")])
def test_holding_write_or_read_scope_never_grants_analysis(client, database, scopes):
    auth = login(client)
    fingerprint = next(iter(owners._sessions))
    owners._sessions[fingerprint] = replace(owners._sessions[fingerprint], scopes=scopes)
    before = counts(database[0])
    response = client.post(PATH, headers=auth, json=database[1])
    assert response.status_code == 403 and counts(database[0]) == before
    private(response)


def test_analysis_scope_does_not_grant_private_receipt_read(client, database):
    auth = login(client)
    fingerprint = next(iter(owners._sessions))
    owners._sessions[fingerprint] = replace(owners._sessions[fingerprint], scopes=("run_personal_analysis",))
    assert client.post(PATH, headers=auth, json=database[1]).status_code == 200
    denied = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, database[1]))
    assert denied.status_code == 403
    private(denied)


@pytest.mark.parametrize("consent", [None, "true", "owner-sync-v1", "owner-analysis-v1,owner-analysis-v1"])
def test_separate_single_request_consent_precedes_storage(client, database, monkeypatch, consent):
    auth = login(client)
    if consent is None:
        del auth["X-Owner-Analysis-Consent"]
    else:
        auth["X-Owner-Analysis-Consent"] = consent
    def forbidden(*_args, **_kwargs):
        pytest.fail("missing analysis consent reached repo")
    monkeypatch.setattr(repo, "create_analysis_local", forbidden)
    result = client.post(PATH, headers=auth, json=database[1])
    assert result.status_code == 403 and result.json() == {"detail": "analysis_consent_required"}
    private(result)


def test_duplicate_consent_header_is_not_accepted(client, database):
    auth = list(login(client).items()) + [("x-owner-analysis-consent", http.ANALYSIS_CONSENT)]
    response = client.post(PATH, headers=auth, json=database[1])
    assert response.status_code == 403
    assert counts(database[0])["owner_analysis_runs"] == 0


@pytest.mark.parametrize("body", [
    '{"request_id":"secret-input","request_id":"analysis-http-0001"}',
    '{"expected_revision":NaN,"private":"secret-input"}',
    '{"secret-input":', '"secret-input"', '{"private":"secret-input"}',
])
def test_raw_validation_errors_are_fixed_and_do_not_echo(client, body):
    response = client.post(PATH, headers={**login(client), "Content-Type": "application/json"}, content=body)
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid_analysis_request"}
    assert "secret-input" not in response.text
    private(response)


@pytest.mark.parametrize("declared", ["-1", "1.5", "1,1", " ", "0" * 11])
def test_invalid_declared_body_length_rejected_before_stream(declared):
    class Streaming:
        headers = Headers({"content-type": "application/json", "x-owner-analysis-consent": http.ANALYSIS_CONSENT,
                           "content-length": declared})
        async def stream(self):
            pytest.fail("invalid length read stream")
            yield b"{}"
    with pytest.raises(HTTPException) as failure:
        asyncio.run(http._read_body(Streaming()))
    assert failure.value.status_code == 400


@pytest.mark.parametrize("declared", ["0", "1", "3"])
def test_declared_length_must_equal_actual_bytes(declared):
    class Streaming:
        headers = Headers({"content-type": "application/json", "x-owner-analysis-consent": http.ANALYSIS_CONSENT,
                           "content-length": declared})
        async def stream(self):
            yield b"{}"
    with pytest.raises(HTTPException) as failure:
        asyncio.run(http._read_body(Streaming()))
    assert failure.value.detail == "invalid_analysis_content_length"


def test_stream_size_disconnect_deadline_and_content_type_are_bounded(client, database, monkeypatch):
    auth = login(client)
    response = client.post(PATH, headers=auth, content=json.dumps(database[1]))
    assert response.status_code == 415
    too_large = client.post(PATH, headers={**auth, "Content-Type": "application/json"}, content=b"x" * (http.MAX_BODY_BYTES + 1))
    assert too_large.status_code == 413
    class Streaming:
        headers = Headers({"content-type": "application/json", "x-owner-analysis-consent": http.ANALYSIS_CONSENT})
        async def stream(self):
            yield b"x" * http.MAX_BODY_BYTES
            yield b"x"
    class Pending(Streaming):
        async def stream(self):
            await asyncio.sleep(10)
            yield b"{}"
    class Disconnected(Streaming):
        async def stream(self):
            raise ClientDisconnect()
            yield b"{}"
    monkeypatch.setattr(http, "BODY_DEADLINE_SECONDS", 0.01)
    for stream, status in ((Streaming(), 413), (Pending(), 408), (Disconnected(), 400)):
        with pytest.raises(HTTPException) as failure:
            asyncio.run(http._read_body(stream))
        assert failure.value.status_code == status
        assert failure.value.headers["Cache-Control"] == "no-store"
    assert counts(database[0])["owner_analysis_runs"] == 0


def test_logout_after_body_and_before_worker_never_writes(client, database, monkeypatch):
    auth = login(client)
    original = http._read_body
    async def revoke_after_body(request):
        raw = await original(request)
        owners.reset_owner_sessions()
        return raw
    monkeypatch.setattr(http, "_read_body", revoke_after_body)
    response = client.post(PATH, headers=auth, json=database[1])
    assert response.status_code == 401 and counts(database[0])["owner_analysis_runs"] == 0
    private(response)


@pytest.mark.parametrize("receipt", [False, True])
def test_logout_before_thread_entry_prevents_connection(monkeypatch, receipt):
    def forbidden():
        pytest.fail("revoked analysis owner opened connection")
    run = http.run_in_threadpool
    async def revoke_before_worker(function, *args, **kwargs):
        owners.reset_owner_sessions()
        return await run(function, *args, **kwargs)
    monkeypatch.setattr(http, "run_in_threadpool", revoke_before_worker)
    payload = {"request_id": REQUEST_ID, "expected_revision": 1, "policy_version": "pol_" + "0" * 64,
               "evidence": [{"code": "510300", "evidence_id": "ev_" + "0" * 64}]}
    with TestClient(app_with(forbidden)) as client:
        auth = login(client)
        response = (client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, payload)) if receipt
                    else client.post(PATH, headers=auth, json=payload))
    assert response.status_code == 401
    private(response)


def test_logout_after_actual_insert_before_commit_rolls_back_full_chain(database):
    class RevokeBeforeCommit(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            result = super().execute(sql, parameters)
            if sql.startswith("INSERT INTO owner_analysis_runs"):
                owners.reset_owner_sessions()
            return result
    before = counts(database[0])
    with TestClient(app_with(lambda: connect(database[0], factory=RevokeBeforeCommit))) as client:
        response = client.post(PATH, headers=login(client), json=database[1])
    assert response.status_code == 401, response.text
    assert counts(database[0]) == before
    private(response)


def test_logout_after_commit_hides_private_result_and_new_session_can_reconcile(client, database, monkeypatch):
    auth = login(client)
    original = repo.create_analysis_local
    def accepted_then_logout(*args, **kwargs):
        result = original(*args, **kwargs)
        assert result.status == 200
        owners.reset_owner_sessions()
        return result
    monkeypatch.setattr(repo, "create_analysis_local", accepted_then_logout)
    response = client.post(PATH, headers=auth, json=database[1])
    assert response.status_code == 401 and PRIVATE_NAME not in response.text
    assert counts(database[0])["owner_analysis_runs"] == 1
    matched = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(login(client), database[1]))
    assert matched.status_code == 200 and matched.json()["state"] == "matched"
    private(response)
    private(matched)


def test_close_failure_after_acceptance_is_unknown_and_never_replays(database):
    class FailClose(sqlite3.Connection):
        def close(self):
            super().close()
            raise RuntimeError("secret-input driver path SELECT private")
    with TestClient(app_with(lambda: connect(database[0], factory=FailClose))) as client:
        auth = login(client)
        response = client.post(PATH, headers=auth, json=database[1])
        assert response.status_code == 503 and response.json() == {"detail": "analysis_result_unknown"}
        receipt = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, database[1]))
    assert counts(database[0])["owner_analysis_runs"] == 1
    assert receipt.status_code == 503 and receipt.json() == {"state": "unknown", "error": "analysis_result_unknown"}
    for result in (response, receipt):
        assert "secret-input" not in result.text and PRIVATE_NAME not in result.text
        private(result)


@pytest.mark.parametrize("driver_http", [False, True])
def test_factory_errors_including_http_exceptions_never_leak(driver_http):
    def failing():
        if driver_http:
            raise HTTPException(502, "secret-input private database path", headers={"X-Private": "secret-input"})
        raise RuntimeError("secret-input private database path SELECT private")
    payload = {"request_id": REQUEST_ID, "expected_revision": 1, "policy_version": "pol_" + "0" * 64,
               "evidence": [{"code": "510300", "evidence_id": "ev_" + "0" * 64}]}
    with TestClient(app_with(failing)) as client:
        auth = login(client)
        response = client.post(PATH, headers=auth, json=payload)
        receipt = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, payload))
    assert response.status_code == 503 and response.json() == {"detail": "analysis_storage_unavailable"}
    assert receipt.status_code == 503 and receipt.json() == {"state": "unknown", "error": "analysis_result_unknown"}
    for result in (response, receipt):
        assert "secret-input" not in result.text and "x-private" not in result.headers
        private(result)


def test_missing_receipt_and_wrong_original_hash_stay_unknown(client, database):
    auth = login(client)
    missing = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, database[1]))
    assert missing.status_code == 404 and missing.json() == {"state": "unknown", "error": "analysis_result_unknown"}
    assert client.post(PATH, headers=auth, json=database[1]).status_code == 200
    wrong = client.get(PATH + "/requests/" + REQUEST_ID,
                       headers={**auth, "X-Owner-Analysis-Request-Hash": "0" * 64})
    assert wrong.status_code == 503 and wrong.json() == missing.json()
    assert PRIVATE_NAME not in wrong.text and REQUEST_ID not in wrong.text
    private(missing)
    private(wrong)


@pytest.mark.parametrize("value", [None, "", "0" * 63, "0" * 65, "A" * 64, "g" * 64,
                                  " " + "0" * 64, "0" * 64 + " ", "0" * 64 + "," + "0" * 64])
def test_receipt_hash_is_single_strict_and_validated_before_storage(value):
    def forbidden():
        pytest.fail("invalid receipt hash opened storage")
    with TestClient(app_with(forbidden)) as client:
        auth = login(client)
        if value is not None:
            auth["X-Owner-Analysis-Request-Hash"] = value
        response = client.get(PATH + "/requests/" + REQUEST_ID, headers=auth)
    assert response.status_code == 422 and response.json() == {"detail": "invalid_analysis_request_hash"}
    private(response)


def test_duplicate_hash_or_query_is_rejected_before_storage():
    def forbidden():
        pytest.fail("ambiguous receipt opened storage")
    with TestClient(app_with(forbidden)) as client:
        auth = login(client)
        headers = [*auth.items(), ("X-Owner-Analysis-Request-Hash", "0" * 64),
                   ("x-owner-analysis-request-hash", "0" * 64)]
        duplicate = client.get(PATH + "/requests/" + REQUEST_ID, headers=headers)
        query = client.get(PATH + "/requests/" + REQUEST_ID + "?secret=secret-input",
                           headers={**auth, "X-Owner-Analysis-Request-Hash": "0" * 64})
        post_query = client.post(PATH + "?secret=secret-input", headers=auth, json={})
    assert duplicate.json() == {"detail": "invalid_analysis_request_hash"}
    assert query.json() == {"detail": "invalid_analysis_request_id"}
    assert post_query.json() == {"detail": "invalid_analysis_query"}
    for response in (duplicate, query, post_query):
        assert response.status_code == 422 and "secret-input" not in response.text
        private(response)


def test_logout_after_receipt_read_hides_private_result(client, database, monkeypatch):
    auth = login(client)
    assert client.post(PATH, headers=auth, json=database[1]).status_code == 200
    original = repo.reconcile_analysis_local
    def read_then_logout(*args, **kwargs):
        result = original(*args, **kwargs)
        assert result.state == "matched"
        owners.reset_owner_sessions()
        return result
    monkeypatch.setattr(repo, "reconcile_analysis_local", read_then_logout)
    response = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, database[1]))
    assert response.status_code == 401 and PRIVATE_NAME not in response.text
    private(response)


def test_analysis_and_receipt_rate_limits_precede_business_io(client, database, monkeypatch):
    auth = login(client)
    monkeypatch.setattr(security, "MAX_REQUESTS", 1)
    monkeypatch.setattr(security, "PRIVATE_READ_MAX_REQUESTS", 1)
    assert client.post(PATH, headers=auth, json=database[1]).status_code == 200
    limited = client.post(PATH, headers=auth, json=database[1])
    assert limited.status_code == 429 and int(limited.headers["retry-after"]) >= 1
    headers = receipt_headers(auth, database[1])
    assert client.get(PATH + "/requests/" + REQUEST_ID, headers=headers).status_code == 200
    limited_read = client.get(PATH + "/requests/" + REQUEST_ID, headers=headers)
    assert limited_read.status_code == 429 and int(limited_read.headers["retry-after"]) >= 1
    assert counts(database[0])["owner_analysis_runs"] == 1
    private(limited)
    private(limited_read)


def test_main_actual_analysis_profile_and_exact_cors_headers(database, monkeypatch):
    import main
    def forbidden(*_args, **_kwargs):
        pytest.fail("analysis main route entered startup/default connection")
    monkeypatch.setattr(main, "init_db", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    client = TestClient(main.app)  # No lifespan startup or automatic provisioning.
    try:
        auth = login(client)
        response = client.post(PATH, headers=auth, json=database[1])
        assert response.status_code == 200, response.text
        allowed = client.options(PATH, headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,x-owner-analysis-consent,x-owner-analysis-request-hash",
        })
        denied = client.options(PATH, headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-owner-analysis-arbitrary",
        })
        assert allowed.status_code == 200 and denied.status_code == 400
        private(response)
    finally:
        client.close()


def test_main_unprovisioned_analysis_returns_503_without_ddl(tmp_path, monkeypatch):
    import main
    path = tmp_path / "explicit-owner-without-analysis.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with closing(connect(path)) as conn:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
    before = path.read_bytes()
    statements = []
    original = sqlite3.connect
    def traced(*args, **kwargs):
        conn = original(*args, **kwargs)
        if args[0] != ":memory:":
            conn.set_trace_callback(statements.append)
        return conn
    monkeypatch.setattr(sqlite3, "connect", traced)
    payload = {"request_id": REQUEST_ID, "expected_revision": 1, "policy_version": "pol_" + "0" * 64,
               "evidence": [{"code": "510300", "evidence_id": "ev_" + "0" * 64}]}
    client = TestClient(main.app)
    try:
        response = client.post(PATH, headers=login(client), json=payload)
        assert response.status_code == 503
        assert str(path) not in response.text
        private(response)
    finally:
        client.close()
    assert path.read_bytes() == before
    assert not any(statement.lstrip().upper().startswith(("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE"))
                   for statement in statements)
