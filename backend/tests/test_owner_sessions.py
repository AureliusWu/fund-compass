"""Synthetic-only Owner login, identity separation, and lifecycle contracts."""
import hashlib
import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

from service import owner_sessions, security

PASSWORD = "synthetic owner password only"
MACHINE_TOKENS = {
    "ADMIN_TOKEN": "synthetic-admin-only",
    "WORKER_TOKEN": "synthetic-worker-only",
    "PRIVATE_READ_TOKEN": "synthetic-private-reader-only",
}


@pytest.fixture(scope="module")
def password_hash():
    return owner_sessions.hash_owner_password(PASSWORD)


@pytest.fixture(autouse=True)
def isolated_sessions(monkeypatch, password_hash):
    for name, token in MACHINE_TOKENS.items():
        monkeypatch.setenv(name, token)
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    owner_sessions.reset_owner_sessions()
    security.reset_rate_limits()
    yield
    owner_sessions.reset_owner_sessions()
    security.reset_rate_limits()


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(owner_sessions, "time", SimpleNamespace(monotonic=lambda: now[0]))
    return now


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(owner_sessions.router)

    @app.get("/private")
    def private(identity: str = Depends(security.require_private_read)):
        return {"identity": identity, "private": "synthetic-only"}

    @app.post("/admin")
    def admin(identity: str = Depends(security.require_admin)):
        return {"identity": identity}

    @app.post("/worker")
    def worker(identity: str = Depends(security.require_worker_or_admin)):
        return {"identity": identity}

    @app.post("/holdings")
    def holdings(session=Depends(owner_sessions.require_owner_scope("write_holdings"))):
        return {"identity": session.owner_id}

    with TestClient(app) as active:
        yield active


def login(client, password=PASSWORD):
    return client.post("/api/v2/owner/session", json={"password": password})


def owner_headers(client):
    response = login(client)
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def test_login_contract_and_only_hashed_session_is_retained(client):
    start = datetime.now(timezone.utc)
    response = login(client)
    assert response.status_code == 200
    payload = response.json()
    token = payload.pop("access_token")
    assert owner_sessions._TOKEN_PATTERN.fullmatch(token)
    assert payload["owner_id"] == "owner"
    assert payload["token_type"] == "Bearer"
    assert payload["scopes"] == list(owner_sessions.OWNER_SCOPES)
    expires = datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
    assert expires.utcoffset() == timedelta(0)
    assert start + timedelta(minutes=30) <= expires <= datetime.now(timezone.utc) + timedelta(minutes=30)
    assert list(owner_sessions._sessions) == [hashlib.sha256(token.encode("ascii")).digest()]
    assert token not in repr(owner_sessions._sessions)
    assert PASSWORD not in repr(owner_sessions._sessions)
    metadata = client.get("/api/v2/owner/session", headers={"Authorization": "Bearer " + token})
    assert metadata.status_code == 200
    assert metadata.json() == payload
    assert token not in metadata.text
    assert PASSWORD not in response.text
    for machine in MACHINE_TOKENS.values():
        assert machine not in response.text


@pytest.mark.parametrize("authorization", [None, "Basic abc", "Bearer wrong", "Bearer"])
def test_session_metadata_and_logout_reject_anonymous_or_wrong_bearer(client, authorization):
    headers = {"Authorization": authorization} if authorization else {}
    for method in (client.get, client.delete):
        response = method("/api/v2/owner/session", headers=headers)
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"


def test_non_ascii_credential_is_rejected_without_comparison_error():
    from fastapi.security import HTTPAuthorizationCredentials

    credential = HTTPAuthorizationCredentials(scheme="Bearer", credentials="你好")
    with pytest.raises(HTTPException) as error:
        owner_sessions.require_owner_session(credential)
    assert error.value.status_code == 401
    with pytest.raises(HTTPException) as error:
        security.require_admin("Bearer 你好")
    assert error.value.status_code == 401
    with pytest.raises(HTTPException) as error:
        security.require_private_read(credential)
    assert error.value.status_code == 403


@pytest.mark.parametrize("machine", list(MACHINE_TOKENS.values()))
def test_machine_credentials_never_establish_owner_identity(client, machine):
    headers = {"Authorization": "Bearer " + machine}
    assert client.get("/api/v2/owner/session", headers=headers).status_code == 401
    assert client.delete("/api/v2/owner/session", headers=headers).status_code == 401
    assert client.post("/holdings", headers=headers).status_code == 401
    response = login(client, machine)
    assert response.status_code == 401
    assert machine not in response.text


def test_password_equal_to_machine_credential_fails_closed(client, monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", PASSWORD)
    response = login(client)
    assert response.status_code == 401
    assert PASSWORD not in response.text


def test_owner_can_read_without_machine_reader_configuration_but_cannot_operate(client, monkeypatch):
    monkeypatch.delenv("PRIVATE_READ_TOKEN")
    headers = owner_headers(client)
    response = client.get("/private", headers=headers)
    assert response.status_code == 200
    assert response.json()["identity"] == "owner"
    assert client.post("/holdings", headers=headers).status_code == 200
    assert client.post("/admin", headers=headers).status_code == 401
    assert client.post("/worker", headers=headers).status_code == 401


def test_server_side_private_reader_compatibility_is_not_an_owner(client):
    headers = {"Authorization": "Bearer " + MACHINE_TOKENS["PRIVATE_READ_TOKEN"]}
    response = client.get("/private", headers=headers)
    assert response.status_code == 200
    assert response.json()["identity"] == "private_reader"
    assert client.get("/api/v2/owner/session", headers=headers).status_code == 401


def test_owner_scope_failures_reject_private_reads_and_writes(client):
    headers = owner_headers(client)
    fingerprint = next(iter(owner_sessions._sessions))
    owner_sessions._sessions[fingerprint] = replace(owner_sessions._sessions[fingerprint], scopes=())
    assert client.get("/private", headers=headers).status_code == 403
    assert client.post("/holdings", headers=headers).status_code == 403
    assert owner_sessions.authenticated_owner_session(headers["Authorization"][7:], required_scope="read_private") is None
    with pytest.raises(ValueError, match="Unknown Owner scope"):
        owner_sessions.require_owner_scope("admin")


def test_expiry_is_absolute_not_extended_by_read_and_purges_digest(client, clock):
    headers = owner_headers(client)
    clock[0] += owner_sessions.SESSION_TTL_SECONDS - 1
    assert client.get("/api/v2/owner/session", headers=headers).status_code == 200
    clock[0] += 1
    assert client.get("/api/v2/owner/session", headers=headers).status_code == 401
    assert client.get("/private", headers=headers).status_code == 401
    assert owner_sessions._sessions == {}


def test_logout_revokes_only_that_device_and_restart_revokes_every_device(client):
    first = owner_headers(client)
    second = owner_headers(client)
    assert first != second
    response = client.delete("/api/v2/owner/session", headers=first)
    assert response.status_code == 204
    assert response.content == b""
    assert client.get("/api/v2/owner/session", headers=first).status_code == 401
    assert client.get("/private", headers=first).status_code == 401
    assert client.get("/api/v2/owner/session", headers=second).status_code == 200
    owner_sessions.reset_owner_sessions()
    assert client.get("/api/v2/owner/session", headers=second).status_code == 401


@pytest.mark.parametrize("new_configuration", [None, "not-a-password-hash", "valid-other-salt"])
def test_configuration_change_or_removal_immediately_revokes_existing_sessions(
    client, monkeypatch, password_hash, new_configuration,
):
    headers = owner_headers(client)
    if new_configuration is None:
        monkeypatch.delenv("OWNER_PASSWORD_HASH")
    elif new_configuration == "valid-other-salt":
        parts = password_hash.split("$")
        parts[2] = owner_sessions._base64url(b"different-salt-16")
        monkeypatch.setenv("OWNER_PASSWORD_HASH", "$".join(parts))
    else:
        monkeypatch.setenv("OWNER_PASSWORD_HASH", new_configuration)
    assert client.get("/api/v2/owner/session", headers=headers).status_code == 401
    assert client.get("/private", headers=headers).status_code == 401
    assert owner_sessions._sessions == {}


@pytest.mark.parametrize("field,replacement", [
    (0, "scrypt"), (1, "599999"), (1, "2000001"), (1, "0600000"),
    (1, "999999999999999999999"), (2, "abc"), (2, "AAAAAAAAAAAAAAAAAAAAAA="),
    (3, "abc"), (3, "!" * 43),
])
def test_hash_parser_strict_bounds_fail_closed(client, monkeypatch, password_hash, field, replacement):
    fields = password_hash.split("$")
    fields[field] = replacement
    configured = "$".join(fields)
    monkeypatch.setenv("OWNER_PASSWORD_HASH", configured)
    response = login(client)
    assert response.status_code == 503
    assert configured not in response.text
    assert PASSWORD not in response.text


def test_missing_owner_hash_never_enables_login(client, monkeypatch):
    monkeypatch.delenv("OWNER_PASSWORD_HASH")
    response = login(client)
    assert response.status_code == 503
    assert owner_sessions._sessions == {}


@pytest.mark.parametrize("payload", [
    {}, {"password": None}, {"password": 42}, {"password": []},
    {"password": {"nested": "private-input"}}, {"password": ""},
    {"password": "private-input" * 100}, {"password": "密" * 171},
    {"password": "\ud800private-input"}, {"password": "private-input", "token": "private-extra-input"},
    ["private-input"],
])
def test_login_validation_never_serializes_password_input(client, payload):
    # JSON raw bytes let us safely test an unpaired unicode escape too.
    response = client.post(
        "/api/v2/owner/session", content=json.dumps(payload), headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "登录请求无效"}
    assert "private-input" not in response.text
    assert "private-extra-input" not in response.text
    assert "input" not in response.text


@pytest.mark.parametrize("body", ['{"password":"private-input",', '{"password":"private-input","password":"other"}', 'NaN'])
def test_malformed_or_ambiguous_json_has_sanitized_error(client, body):
    response = client.post("/api/v2/owner/session", content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json() == {"detail": "登录请求无效"}


def test_large_body_is_rejected_before_hash_work(client, monkeypatch):
    monkeypatch.setattr(owner_sessions, "_issue_session", lambda _: pytest.fail("oversized body reached password work"))
    response = client.post(
        "/api/v2/owner/session", content=json.dumps({"password": "secret-body" * 1000}),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert "secret-body" not in response.text


def test_wrong_content_type_is_not_accepted_as_login(client):
    response = client.post("/api/v2/owner/session", content='{"password":"private-input"}')
    assert response.status_code == 415
    assert "private-input" not in response.text


def test_wrong_password_has_uniform_error_without_input(client):
    response = login(client, "synthetic wrong input")
    assert response.status_code == 401
    assert response.json() == {"detail": "登录凭据无效"}
    assert "synthetic wrong input" not in response.text
    assert owner_sessions._sessions == {}


def test_client_limit_precedes_hash_work_and_has_retry_after(client, monkeypatch, clock):
    monkeypatch.setattr(owner_sessions, "CLIENT_LOGIN_LIMIT", 1)
    assert login(client, "wrong").status_code == 401
    response = login(client)
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) == owner_sessions.LOGIN_WINDOW_SECONDS
    clock[0] += owner_sessions.LOGIN_WINDOW_SECONDS
    assert login(client).status_code == 200


def test_global_limit_bounds_distributed_clients_and_does_not_trust_forwarded_headers(client, monkeypatch):
    monkeypatch.setattr(owner_sessions, "GLOBAL_LOGIN_LIMIT", 2)
    owner_sessions._limit_login("synthetic-client-1")
    owner_sessions._limit_login("synthetic-client-2")
    response = client.post(
        "/api/v2/owner/session", json={"password": PASSWORD}, headers={"X-Forwarded-For": "new-client"},
    )
    assert response.status_code == 429
    assert len(owner_sessions._global_logins) == 2
    assert owner_sessions._sessions == {}


def test_forwarded_header_cannot_reset_client_attempt_budget(client, monkeypatch):
    monkeypatch.setattr(owner_sessions, "CLIENT_LOGIN_LIMIT", 1)
    first = client.post("/api/v2/owner/session", json={}, headers={"X-Forwarded-For": "first"})
    second = client.post("/api/v2/owner/session", json={}, headers={"X-Forwarded-For": "second"})
    assert first.status_code == 422
    assert second.status_code == 429
    assert len(owner_sessions._client_logins) == 1


def test_client_bucket_memory_is_bounded_and_expires(monkeypatch, clock):
    monkeypatch.setattr(owner_sessions, "MAX_LOGIN_CLIENTS", 2)
    owner_sessions._limit_login("client-1")
    owner_sessions._limit_login("client-2")
    with pytest.raises(HTTPException) as error:
        owner_sessions._limit_login("client-3")
    assert error.value.status_code == 429
    assert len(owner_sessions._client_logins) == 2
    clock[0] += owner_sessions.LOGIN_WINDOW_SECONDS
    owner_sessions._limit_login("client-3")
    assert len(owner_sessions._client_logins) == 1
    assert all(isinstance(identity, bytes) and len(identity) == 32 for identity in owner_sessions._client_logins)


def test_session_capacity_does_not_evict_an_existing_device(client, monkeypatch, clock):
    monkeypatch.setattr(owner_sessions, "MAX_SESSIONS", 2)
    first, second = owner_headers(client), owner_headers(client)
    assert login(client).status_code == 429
    assert len(owner_sessions._sessions) == 2
    assert client.get("/api/v2/owner/session", headers=first).status_code == 200
    assert client.get("/api/v2/owner/session", headers=second).status_code == 200
    clock[0] += owner_sessions.SESSION_TTL_SECONDS
    assert login(client).status_code == 200
    assert len(owner_sessions._sessions) == 1


def test_parallel_password_work_is_bounded(client):
    assert owner_sessions._verification_slots.acquire(blocking=False)
    assert owner_sessions._verification_slots.acquire(blocking=False)
    try:
        response = login(client)
        assert response.status_code == 429
        assert response.headers["retry-after"] == "1"
    finally:
        owner_sessions._verification_slots.release()
        owner_sessions._verification_slots.release()


def test_password_rotation_during_verification_cannot_issue_old_session(client, monkeypatch, password_hash):
    pbkdf2 = hashlib.pbkdf2_hmac

    def rotate_and_verify(*args, **kwargs):
        fields = password_hash.split("$")
        fields[2] = owner_sessions._base64url(b"different-salt-16")
        monkeypatch.setenv("OWNER_PASSWORD_HASH", "$".join(fields))
        return pbkdf2(*args, **kwargs)

    monkeypatch.setattr(owner_sessions, "hashlib", SimpleNamespace(sha256=hashlib.sha256, pbkdf2_hmac=rotate_and_verify))
    assert login(client).status_code == 503
    assert owner_sessions._sessions == {}


def test_owner_read_limit_remains_bounded_and_separate_from_machine_roles(client, monkeypatch):
    monkeypatch.setattr(security, "PRIVATE_READ_MAX_REQUESTS", 1)
    headers = owner_headers(client)
    assert client.get("/private", headers=headers).status_code == 200
    assert client.get("/private", headers=headers).status_code == 429
    assert client.post("/admin", headers={"Authorization": "Bearer " + MACHINE_TOKENS["ADMIN_TOKEN"]}).status_code == 200
    assert headers["Authorization"][7:] not in repr(security._requests)


def test_openapi_password_write_only_and_session_security(client):
    schema = client.app.openapi()
    login_schema = schema["paths"]["/api/v2/owner/session"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    assert login_schema["properties"]["password"]["writeOnly"] is True
    assert login_schema["properties"]["password"]["maxLength"] == 512
    assert login_schema["additionalProperties"] is False
    assert schema["paths"]["/api/v2/owner/session"]["get"]["security"] == [{"OwnerSessionBearer": []}]
    assert PASSWORD not in json.dumps(schema)


@pytest.mark.parametrize("password,iterations", [
    (None, 600000), ("", 600000), ("a", 600000), ("a" * 14, 600000), ("密" * 14, 600000),
    ("x" * 513, 600000), ("密" * 171, 600000), ("\ud800" * 15, 600000),
    (PASSWORD, 599999), (PASSWORD, 2000001), (PASSWORD, True),
])
def test_offline_hash_helper_bounds_and_never_includes_input_in_errors(password, iterations):
    with pytest.raises(ValueError) as error:
        owner_sessions.hash_owner_password(password, iterations=iterations)
    assert "valid" not in str(error.value).lower().replace("invalid", "")
    assert "密" not in str(error.value)


@pytest.mark.parametrize("password", ["a" * 15, "密" * 15, "🔥" * 15, "a" * 512])
def test_offline_hash_helper_character_minimum_has_no_composition_rule(password):
    encoded = owner_sessions.hash_owner_password(password)
    assert encoded.startswith("pbkdf2_sha256$600000$")
    fields = encoded.split("$")
    salt = owner_sessions._decode_base64url(fields[2], minimum=16, maximum=32)
    digest = owner_sessions._decode_base64url(fields[3], minimum=32, maximum=32)
    assert salt is not None
    assert hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 600000, dklen=32) == digest


def test_short_login_input_does_not_expose_provisioning_minimum(client):
    response = login(client, "short")
    assert response.status_code == 401
    assert response.json() == {"detail": "登录凭据无效"}
    assert "15" not in response.text
