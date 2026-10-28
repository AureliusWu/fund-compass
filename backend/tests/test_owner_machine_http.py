"""Real protected HTTP over a fresh complete local machine profile.

No Gist credentials, external requests, real delivery or application lifespan
is used. Connection subclasses inject actual SQL/commit/close boundary faults;
the machine source, analysis, notification claim and journal stay unmocked.
"""
from contextlib import closing
import json
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from database import db
from models.owner_machine import MAX_BODY_BYTES
from service import owner_machine as http, owner_sessions as owners, security
from test_owner_machine_repo import DAY, SHA, counts, f
from test_owner_analysis_repo import connect


BASE = "/api/v2/worker/portfolio"
PASSWORD = "synthetic machine HTTP owner password"
WORKER = "synthetic-machine-http-worker"
ADMIN = "synthetic-machine-http-admin"
PRIVATE = "synthetic-machine-http-private"
FAULT_TEXT = "synthetic-private-storage-fault-must-not-escape"


@pytest.fixture(scope="module")
def password_hash():
    return owners.hash_owner_password(PASSWORD)


@pytest.fixture(autouse=True)
def isolated_auth(monkeypatch, password_hash):
    security.reset_rate_limits()
    owners.reset_owner_sessions()
    monkeypatch.setenv("WORKER_TOKEN", WORKER)
    monkeypatch.setenv("ADMIN_TOKEN", ADMIN)
    monkeypatch.setenv("PRIVATE_READ_TOKEN", PRIVATE)
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    for name in ("GIST_ID", "GIST_TOKEN", "GITHUB_TOKEN", "WECHAT_SENDKEY"):
        monkeypatch.delenv(name, raising=False)
    yield
    security.reset_rate_limits()
    owners.reset_owner_sessions()


def app_with(factory):
    app = FastAPI()
    app.include_router(owners.router)
    app.include_router(http.build_owner_machine_router(factory))
    return app


def client_for(fixture, *, factory=sqlite3.Connection):
    return TestClient(app_with(lambda: connect(fixture.path, factory=factory)))


def auth(token=WORKER):
    return {"Authorization": "Bearer " + token}


def private(response):
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"


def post(client, action, payload, *, token=WORKER):
    response = client.post(BASE + "/tasks/" + action, json=payload, headers=auth(token))
    private(response)
    return response


def claim_payload(task):
    return {"occurrence_date": DAY, "request_id": "machine-http-claim-0001", "trigger": "scheduled",
            "slot": "14:30", "worker_build_sha": SHA, "task_hash": task["task_hash"]}


def finish_payload(attempt, outcome="sent"):
    return {"occurrence_date": DAY, "slot": "14:30", "attempt_hash": attempt["attempt_hash"], "outcome": outcome}


def journal_counts(fixture):
    with closing(connect(fixture.path)) as conn:
        return dict(conn.execute("SELECT kind,COUNT(*) FROM owner_machine_journal GROUP BY kind"))


def test_actual_http_source_prepare_claim_finish_and_readback_have_one_original_chain(f):
    before = counts(f)
    with client_for(f) as client:
        source = client.get(BASE + "/source", headers=auth())
        private(source)
        assert source.status_code == 200 and source.json() == f.source
        assert source.json()["codes"] == ["000001", "000009", "510300"]
        prepared = post(client, "prepare", f.request)
        assert prepared.status_code == 200, prepared.text
        task = prepared.json()
        assert not task["duplicate"] and task["source_current"]
        assert task["task"]["source_revision"] == source.json()["revision"]
        assert task["task"]["source_hash"] == source.json()["source_hash"]
        components = {row["code"]: row for row in task["run"]["components"]}
        assert components["510300"]["holding"]["shares"] == 30
        assert components["510300"]["holding"]["target_weight"] == 60
        assert components["510300"]["holding"]["cost"] is None
        assert components["000001"]["holding"]["shares"] == 0
        assert components["000001"]["holding"]["user_state"] == "held"
        claimed = post(client, "claim", claim_payload(task))
        assert claimed.status_code == 200, claimed.text
        attempt = claimed.json()
        assert attempt["claimed"] and attempt["attempt"]["valid_count"] == 3
        assert attempt["attempt"]["expected_count"] == 3
        assert attempt["attempt"]["scheduled_at"] == "2026-10-26T14:30:00+08:00"
        assert attempt["attempt"]["created_at"] == "2026-10-26T06:31:00+00:00"
        unchanged = counts(f)
        duplicate = post(client, "claim", {**claim_payload(task), "trigger": "manual",
                                          "request_id": "machine-http-manual-0001"})
        assert duplicate.status_code == 200 and not duplicate.json()["claimed"]
        assert duplicate.json()["attempt_hash"] == attempt["attempt_hash"]
        # The separate manual invocation is durably visible as skipped, while
        # the original analysis and notification batch remain unchanged.
        assert counts(f) == unchanged  # The shared helper excludes invocation observations.
        assert journal_counts(f) == {"schema": 1, "task": 1, "attempt": 1, "observation": 3}
        finished = post(client, "finish", finish_payload(attempt))
        assert finished.status_code == 200, finished.text
        assert finished.json()["result"]["execution_status"] == "succeeded"
        assert finished.json()["result"]["artifact_status"] == "fresh"
        assert finished.json()["result"]["artifact_digest"] == task["task"]["run_response_hash"]
        final = counts(f)
        repeated = post(client, "finish", finish_payload(attempt))
        assert repeated.status_code == 200 and repeated.json()["duplicate"]
        status = client.get(BASE + "/tasks/" + DAY, headers=auth(ADMIN))
        private(status)
        assert status.status_code == 200 and status.json()["schema"] == "owner-machine-status-1"
        assert status.json()["task"]["task"] == task["task"]
        assert status.json()["attempts"][0]["result_hash"] == finished.json()["result_hash"]
        observations = [row["observation"] for row in status.json()["observations"]]
        assert sorted((row["phase"], row["trigger"], row["execution_status"]) for row in observations) == [
            ("claim", "manual", "skipped"), ("claim", "scheduled", "succeeded"), ("prepare", "scheduled", "succeeded")]
        assert all(row["artifact_status"] == "fresh" and row["valid_count"] == row["expected_count"] == 3
                   for row in observations)
        assert counts(f) == final
    assert final["owner_analysis_runs"] == before["owner_analysis_runs"] + 1
    assert final["notification_events"] == before["notification_events"] + 9
    with closing(connect(f.path)) as conn:
        assert dict(conn.execute("SELECT status,COUNT(*) FROM notification_events GROUP BY status")) == {
            "scheduled": 3, "attempted": 3, "sent": 3}


@pytest.mark.parametrize("route", ["source", "tasks/" + DAY, "tasks/prepare", "tasks/claim", "tasks/finish"])
@pytest.mark.parametrize("identity", ["anonymous", "private", "owner", "invalid"])
def test_non_machine_roles_are_rejected_before_factory(route, identity):
    calls = []

    def forbidden():
        calls.append(True)
        pytest.fail("denied identity opened machine storage")

    with TestClient(app_with(forbidden)) as client:
        headers = {}
        if identity == "private":
            headers = auth(PRIVATE)
        elif identity == "invalid":
            headers = auth("invalid-synthetic-machine-token")
        elif identity == "owner":
            login = client.post("/api/v2/owner/session", json={"password": PASSWORD})
            assert login.status_code == 200
            token = login.json()["access_token"]
            assert {"read_private", "write_holdings", "run_personal_analysis"} <= set(login.json()["scopes"])
            headers = auth(token)
        response = (client.post(BASE + "/" + route, json={}, headers=headers)
                    if route.rsplit("/", 1)[-1] in {"prepare", "claim", "finish"}
                    else client.get(BASE + "/" + route, headers=headers))
        assert response.status_code == 401
        private(response)
        assert calls == []


def test_router_and_main_public_contract_do_not_open_storage(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("router inspection opened storage")
    http.build_owner_machine_router(forbidden)
    monkeypatch.setattr(http.repo, "read_source_local", forbidden)
    monkeypatch.setattr(http.repo, "prepare_local", forbidden)
    monkeypatch.setattr(http.repo, "claim_local", forbidden)
    monkeypatch.setattr(http.repo, "finish_local", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    import main
    paths = main.app.openapi()["paths"]
    assert "get" in paths[BASE + "/source"]
    assert "get" in paths[BASE + "/tasks/{occurrence_date}"]
    for action in ("prepare", "claim", "finish"):
        assert "post" in paths[BASE + "/tasks/" + action]


def test_actual_main_mounted_router_uses_existing_local_factory_without_lifespan(f):
    import main
    # Deliberately no TestClient context/lifespan: this verifies mounted HTTP
    # and the configured local factory, not application startup or deployment.
    client = TestClient(main.app)
    try:
        response = client.get(BASE + "/source", headers=auth())
        private(response)
        assert response.status_code == 200 and response.json() == f.source
    finally:
        client.close()


@pytest.mark.parametrize("variant,expected", [
    ("duplicate_key", 422), ("boolean_revision", 422), ("unknown_field", 422),
    ("bad_request_id", 422), ("bad_hash", 422), ("bad_sha", 422),
    ("invalid_json", 422), ("invalid_utf8", 422), ("declared_large", 413),
    ("stream_large", 413), ("wrong_type", 415), ("duplicate_type", 415),
    ("duplicate_length", 400), ("wrong_length", 400), ("invalid_length", 400),
])
def test_invalid_raw_prepare_never_opens_storage(f, variant, expected):
    calls = []
    body = json.dumps(f.request, ensure_ascii=False).encode()
    headers = [("Authorization", "Bearer " + WORKER), ("Content-Type", "application/json")]
    if variant == "duplicate_key":
        body = b'{"occurrence_date":"' + DAY.encode() + b'",' + body[1:]
    elif variant in {"boolean_revision", "unknown_field", "bad_request_id", "bad_hash", "bad_sha"}:
        changes = {"boolean_revision": {"expected_revision": True}, "unknown_field": {"holdings": []},
                   "bad_request_id": {"request_id": "bad"}, "bad_hash": {"source_hash": "x" * 64},
                   "bad_sha": {"worker_build_sha": "not-a-source-sha"}}[variant]
        body = json.dumps({**f.request, **changes}).encode()
    elif variant == "invalid_json":
        body = b'{"unfinished":'
    elif variant == "invalid_utf8":
        body = b"\xff"
    elif variant == "declared_large":
        headers.append(("Content-Length", str(MAX_BODY_BYTES + 1)))
    elif variant == "stream_large":
        body = iter((b" " * 10_000, b" " * 7_000))
    elif variant == "wrong_type":
        headers[1] = ("Content-Type", "text/plain")
    elif variant == "duplicate_type":
        headers.append(("Content-Type", "application/json"))
    elif variant == "duplicate_length":
        headers.extend([("Content-Length", str(len(body))), ("Content-Length", str(len(body)))])
    elif variant == "wrong_length":
        headers.append(("Content-Length", "1"))
    elif variant == "invalid_length":
        headers.append(("Content-Length", "+1"))

    def forbidden():
        calls.append(True)
        pytest.fail("invalid raw input opened storage")

    with TestClient(app_with(forbidden)) as client:
        response = client.post(BASE + "/tasks/prepare", content=body, headers=headers)
        assert response.status_code == expected, response.text
        private(response)
        assert calls == []


def test_exact_raw_body_budget_remains_supported(f):
    raw = json.dumps(f.request).encode()
    body = raw + b" " * (MAX_BODY_BYTES - len(raw))
    assert len(body) == MAX_BODY_BYTES
    with client_for(f) as client:
        response = client.post(BASE + "/tasks/prepare", content=body,
                               headers={**auth(), "Content-Type": "application/json"})
        private(response)
        assert response.status_code == 200 and not response.json()["duplicate"]


def test_actual_source_conflict_is_a_known_blocked_observation_not_a_partial_run(f):
    before = counts(f)
    with client_for(f) as client:
        response = post(client, "prepare", {**f.request, "source_hash": "0" * 64})
        assert response.status_code == 409 and response.json()["detail"] == "machine_source_conflict"
        assert counts(f) == before and journal_counts(f) == {"schema": 1, "observation": 1}
        status = client.get(BASE + "/tasks/" + DAY, headers=auth())
        private(status)
        assert status.status_code == 200 and status.json()["task"] is None
        assert status.json()["attempts"] == []
        observations = status.json()["observations"]
        assert len(observations) == 1
        observation = observations[0]["observation"]
        assert observation["execution_status"] == "blocked"
        assert observation["artifact_status"] == "unavailable"
        assert observation["valid_count"] is None and observation["expected_count"] is None
        assert observation["reason"] == "machine_source_conflict"


@pytest.mark.parametrize("method,path", [("get", "/source?x=1"), ("get", "/tasks/" + DAY + "?x=1"),
                                         ("post", "/tasks/prepare?x=1"), ("post", "/tasks/claim?x=1"),
                                         ("post", "/tasks/finish?x=1")])
def test_unknown_queries_rejected_before_factory(method, path):
    calls = []
    with TestClient(app_with(lambda: calls.append(True))) as client:
        response = (client.get(BASE + path, headers=auth()) if method == "get"
                    else client.post(BASE + path, json={}, headers=auth()))
        assert response.status_code == 422 and response.json()["detail"] == "invalid_machine_query"
        private(response)
        assert calls == []


@pytest.mark.parametrize("day", ["bad", "2026-02-30", "2026-1-1", "20261026", "2026-10-26T00:00:00"])
def test_invalid_status_occurrence_rejected_before_factory(day):
    calls = []
    with TestClient(app_with(lambda: calls.append(True))) as client:
        response = client.get(BASE + "/tasks/" + day, headers=auth())
        assert response.status_code == 422 and response.json()["detail"] == "invalid_machine_occurrence"
        private(response)
        assert calls == []


@pytest.mark.parametrize("role,token", [("WORKER_TOKEN", WORKER), ("ADMIN_TOKEN", ADMIN)])
def test_real_credential_rotation_after_actual_task_insert_rolls_back_full_chain(f, monkeypatch, role, token):
    before = counts(f)
    rotated = []

    class Rotate(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            result = super().execute(sql, parameters)
            if sql.startswith("INSERT INTO owner_machine_journal") and parameters[1] == "task":
                monkeypatch.setenv(role, "rotated-synthetic-machine-http-credential")
                rotated.append(True)
            return result

    with client_for(f, factory=Rotate) as client:
        response = post(client, "prepare", f.request, token=token)
        assert response.status_code == 401 and response.json()["detail"] == "machine_authorization_changed"
        assert rotated == [True] and counts(f) == before
        assert token not in response.text and FAULT_TEXT not in response.text


@pytest.mark.parametrize("writing", [False, True])
def test_factory_failure_is_sanitized_and_never_claims_unknown_commit(f, writing):
    before = counts(f)

    def unavailable():
        raise sqlite3.OperationalError(FAULT_TEXT)

    with TestClient(app_with(unavailable)) as client:
        response = (post(client, "prepare", f.request) if writing
                    else client.get(BASE + "/source", headers=auth()))
        private(response)
        assert response.status_code == 503 and response.json()["detail"] == "machine_storage_unavailable"
        assert FAULT_TEXT not in response.text and counts(f) == before


@pytest.mark.parametrize("boundary", ["commit", "close"])
def test_real_commit_or_close_response_loss_is_unknown_with_original_task_readback(f, boundary):
    class Lost(sqlite3.Connection):
        def commit(self):
            super().commit()
            if boundary == "commit":
                raise sqlite3.OperationalError(FAULT_TEXT)

        def close(self):
            super().close()
            if boundary == "close":
                raise sqlite3.OperationalError(FAULT_TEXT)

    with client_for(f, factory=Lost) as client:
        response = post(client, "prepare", f.request)
        assert response.status_code == 503 and response.json()["detail"] == "machine_result_unknown"
        assert FAULT_TEXT not in response.text and WORKER not in response.text
    saved = counts(f)
    assert saved["owner_analysis_runs"] == 1 and saved["owner_machine_journal"] == 2
    assert journal_counts(f) == {"schema": 1, "task": 1, "observation": 1}
    with client_for(f) as client:
        status = client.get(BASE + "/tasks/" + DAY, headers=auth())
        private(status)
        assert status.status_code == 200
        assert status.json()["task"]["task"]["source_hash"] == f.source["source_hash"]
        assert status.json()["task"]["task"]["analysis_request_id"] == "machine-portfolio-" + DAY
        assert status.json()["attempts"] == [] and counts(f) == saved


def test_actual_claim_commit_loss_can_only_be_read_as_original_ambiguous_attempt(f):
    with client_for(f) as client:
        task_response = post(client, "prepare", f.request)
        assert task_response.status_code == 200
        task = task_response.json()

    class Lost(sqlite3.Connection):
        def commit(self):
            super().commit()
            raise sqlite3.OperationalError(FAULT_TEXT)

    with client_for(f, factory=Lost) as client:
        response = post(client, "claim", claim_payload(task))
        assert response.status_code == 503 and response.json()["detail"] == "machine_result_unknown"
        assert FAULT_TEXT not in response.text
    saved = counts(f)
    assert saved["notification_events"] == 6
    with client_for(f) as client:
        status = client.get(BASE + "/tasks/" + DAY, headers=auth())
        private(status)
        assert status.status_code == 200
        attempts = status.json()["attempts"]
        assert len(attempts) == 1 and attempts[0]["result"] is None
        assert attempts[0]["attempt"]["task_hash"] == task["task_hash"]
        assert counts(f) == saved


def test_existing_machine_rate_limit_is_not_expanded(f):
    calls = []

    def factory():
        calls.append(True)
        return connect(f.path)

    with TestClient(app_with(factory)) as client:
        for _ in range(30):
            response = client.get(BASE + "/source", headers=auth())
            private(response)
            assert response.status_code == 200
        response = client.get(BASE + "/source", headers=auth())
        private(response)
        assert response.status_code == 429 and int(response.headers["retry-after"]) >= 1
        assert len(calls) == 30 and security.MAX_REQUESTS == 30
