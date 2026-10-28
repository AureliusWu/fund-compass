"""Synthetic revalidation across body reads and session lifecycle changes."""
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from service import owner_sessions as owners

PASSWORD = "synthetic long-operation password"


@pytest.fixture(scope="module")
def password_hash():
    return owners.hash_owner_password(PASSWORD)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, password_hash):
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN"):
        monkeypatch.setenv(name, "synthetic-" + name)
    owners.reset_owner_sessions()
    yield
    owners.reset_owner_sessions()


def capture():
    response = owners._issue_session(owners.SecretStr(PASSWORD))
    token = response["access_token"]
    context = owners.authenticated_owner_authorization(token)
    assert context is not None
    return token, context


def assert_revoked(context):
    with pytest.raises(HTTPException) as error:
        owners.revalidate_owner_authorization(context, required_scope="write_holdings")
    assert error.value.status_code == 401


def test_handle_contains_digest_only_and_compatibility_metadata_remains():
    token, context = capture()
    assert owners.authenticated_owner_session(token) is context.session
    assert owners.revalidate_owner_authorization(context, required_scope="write_holdings") is context.session
    assert token not in repr(context)
    assert PASSWORD not in repr(context)
    assert not hasattr(context, "token")
    assert len(context.token_fingerprint) == 32


def test_logout_between_capture_and_write_rejects_old_handle_but_not_other_device():
    token, first = capture()
    _, second = capture()
    owners.logout_owner(HTTPAuthorizationCredentials(scheme="Bearer", credentials=token))
    assert_revoked(first)
    assert owners.revalidate_owner_authorization(second) is second.session


def test_absolute_expiry_between_body_and_write_rejects(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(owners, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    _, context = capture()
    clock[0] += owners.SESSION_TTL_SECONDS
    assert_revoked(context)


@pytest.mark.parametrize("configuration", [None, "invalid", "another-valid-salt"])
def test_configuration_rotation_or_removal_rejects_captured_handle(monkeypatch, password_hash, configuration):
    _, context = capture()
    if configuration is None:
        monkeypatch.delenv("OWNER_PASSWORD_HASH")
    elif configuration == "another-valid-salt":
        parts = password_hash.split("$")
        parts[2] = owners._base64url(b"different-salt-16")
        monkeypatch.setenv("OWNER_PASSWORD_HASH", "$".join(parts))
    else:
        monkeypatch.setenv("OWNER_PASSWORD_HASH", configuration)
    assert_revoked(context)


def test_restart_rejects_captured_handle():
    _, context = capture()
    owners.reset_owner_sessions()
    assert_revoked(context)


def test_replaced_session_object_cannot_keep_stale_scope_authorization():
    _, context = capture()
    owners._sessions[context.token_fingerprint] = replace(context.session, scopes=())
    assert_revoked(context)


def test_missing_scope_has_403_without_granting_other_roles():
    token, original = capture()
    owners._sessions[original.token_fingerprint] = replace(original.session, scopes=("read_private",))
    context = owners.authenticated_owner_authorization(token)
    assert context is not None
    assert owners.revalidate_owner_authorization(context, required_scope="read_private") is context.session
    with pytest.raises(HTTPException) as error:
        owners.revalidate_owner_authorization(context, required_scope="write_holdings")
    assert error.value.status_code == 403


@pytest.mark.parametrize("role", ["ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN"])
def test_machine_collision_after_body_read_fails_closed(monkeypatch, role):
    token, context = capture()
    monkeypatch.setenv(role, token)
    assert_revoked(context)


@pytest.mark.parametrize("context", [None, object(), SimpleNamespace(token_fingerprint=b"x" * 32)])
def test_untrusted_handle_type_fails_closed(context):
    assert_revoked(context)


def test_forged_digest_cannot_reuse_another_live_session():
    _, context = capture()
    assert_revoked(owners.OwnerAuthorization(session=context.session, token_fingerprint=b"x" * 32))
    assert_revoked(owners.OwnerAuthorization(session=replace(context.session), token_fingerprint=context.token_fingerprint))


def test_long_operation_dependency_accepts_owner_only():
    app = FastAPI()
    app.include_router(owners.router)

    @app.post("/synthetic-long-write")
    def write(context=Depends(owners.require_owner_authorization_scope("write_holdings"))):
        return {"owner_id": owners.revalidate_owner_authorization(context, required_scope="write_holdings").owner_id}

    token, _ = capture()
    with TestClient(app) as client:
        assert client.post("/synthetic-long-write", headers={"Authorization": "Bearer " + token}).json() == {"owner_id": "owner"}
        for credential in (None, "wrong", "synthetic-ADMIN_TOKEN", "synthetic-WORKER_TOKEN", "synthetic-PRIVATE_READ_TOKEN"):
            headers = {"Authorization": "Bearer " + credential} if credential else {}
            assert client.post("/synthetic-long-write", headers=headers).status_code == 401
    with pytest.raises(ValueError, match="Unknown Owner scope"):
        owners.require_owner_authorization_scope("admin")
    with pytest.raises(ValueError, match="Unknown Owner scope"):
        owners.revalidate_owner_authorization(None, required_scope="admin")
