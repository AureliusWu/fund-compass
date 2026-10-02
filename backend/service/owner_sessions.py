"""Short-lived, single-owner browser sessions, independent of machine tokens.

Sessions and login limits are deliberately process-local. A restart signs every
device out; deployments must use one API process until a shared session store
and shared login limiter have been implemented. No raw session token is stored.

OWNER_PASSWORD_HASH format (not a plaintext password):
    pbkdf2_sha256$iterations$unpadded_base64url_salt$unpadded_base64url_digest
Use ``hash_owner_password`` to generate a hash offline, without logging input.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

MIN_HASH_ITERATIONS = 600_000
MAX_HASH_ITERATIONS = 2_000_000
SESSION_TTL_SECONDS = 30 * 60
MAX_SESSIONS = 8
LOGIN_WINDOW_SECONDS = 60
GLOBAL_LOGIN_LIMIT = 30
CLIENT_LOGIN_LIMIT = 5
MAX_LOGIN_CLIENTS = 1024
MIN_CONFIG_PASSWORD_CHARACTERS = 15
MAX_PASSWORD_BYTES = 512
MAX_LOGIN_BODY_BYTES = 4096
OWNER_SCOPES = ("read_private", "write_holdings", "run_personal_analysis")
_TOKEN_PATTERN = re.compile(r"own_[A-Za-z0-9_-]{43}\Z", re.ASCII)
_BASE64_PATTERN = re.compile(r"[A-Za-z0-9_-]+\Z", re.ASCII)
_state_lock = threading.Lock()
_verification_slots = threading.BoundedSemaphore(2)
_sessions: dict[bytes, "OwnerSession"] = {}
_global_logins: deque[float] = deque()
_client_logins: dict[bytes, deque[float]] = {}

router = APIRouter(prefix="/api/v2/owner", tags=["owner-session"])
_owner_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="OwnerSessionBearer",
    description="Short-lived owner session; machine credentials are never accepted.",
)


class OwnerLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: SecretStr = Field(min_length=1, max_length=MAX_PASSWORD_BYTES)

    @field_validator("password")
    @classmethod
    def validate_password_bytes(cls, value: SecretStr) -> SecretStr:
        try:
            length = len(value.get_secret_value().encode("utf-8"))
        except UnicodeError:
            raise ValueError("Owner password encoding is invalid") from None
        if length > MAX_PASSWORD_BYTES:
            raise ValueError("Owner password length is invalid")
        return value


class OwnerSessionMetadata(BaseModel):
    token_type: Literal["Bearer"] = "Bearer"
    expires_at: datetime
    owner_id: Literal["owner"] = "owner"
    scopes: list[Literal["read_private", "write_holdings", "run_personal_analysis"]]


class OwnerLoginResponse(OwnerSessionMetadata):
    access_token: str


@dataclass(frozen=True)
class _PasswordConfiguration:
    fingerprint: bytes
    iterations: int
    salt: bytes
    digest: bytes


@dataclass(frozen=True)
class OwnerSession:
    """Metadata only: never retains the browser bearer or the password."""

    owner_id: str
    scopes: tuple[str, ...]
    expires_at: datetime
    expires_monotonic: float
    configuration_fingerprint: bytes

    def metadata(self) -> dict:
        return {
            "token_type": "Bearer",
            "expires_at": self.expires_at,
            "owner_id": self.owner_id,
            "scopes": list(self.scopes),
        }


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_base64url(value: str, *, minimum: int, maximum: int) -> bytes | None:
    if not _BASE64_PATTERN.fullmatch(value) or not 1 <= len(value) <= 64:
        return None
    try:
        decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (ValueError, TypeError):
        return None
    if not minimum <= len(decoded) <= maximum or _base64url(decoded) != value:
        return None
    return decoded


def _configuration() -> _PasswordConfiguration | None:
    encoded = os.environ.get("OWNER_PASSWORD_HASH", "")
    if not 1 <= len(encoded) <= 200:
        return None
    fields = encoded.split("$")
    if len(fields) != 4 or fields[0] != "pbkdf2_sha256":
        return None
    number = fields[1]
    if not re.fullmatch(r"[1-9][0-9]{5,6}", number, re.ASCII):
        return None
    iterations = int(number)
    if not MIN_HASH_ITERATIONS <= iterations <= MAX_HASH_ITERATIONS:
        return None
    salt = _decode_base64url(fields[2], minimum=16, maximum=32)
    digest = _decode_base64url(fields[3], minimum=32, maximum=32)
    if salt is None or digest is None:
        return None
    return _PasswordConfiguration(
        fingerprint=hashlib.sha256(encoded.encode("utf-8")).digest(),
        iterations=iterations,
        salt=salt,
        digest=digest,
    )


def hash_owner_password(password: str, *, iterations: int = MIN_HASH_ITERATIONS) -> str:
    """Offline provisioning helper. The caller must handle its output securely.

    Returns a password hash only, with no logging, file writes, or environment
    mutation. Login separately refuses passwords equal to machine credentials.
    Provisioning requires at least 15 Unicode characters for this password-only
    entry point, without composition rules, trimming, or silent truncation.
    """
    if not isinstance(password, str) or not MIN_CONFIG_PASSWORD_CHARACTERS <= len(password) <= MAX_PASSWORD_BYTES:
        raise ValueError("Owner password length is invalid")
    try:
        encoded = password.encode("utf-8")
    except UnicodeError:
        raise ValueError("Owner password encoding is invalid") from None
    if len(encoded) > MAX_PASSWORD_BYTES:
        raise ValueError("Owner password length is invalid")
    if type(iterations) is not int or not MIN_HASH_ITERATIONS <= iterations <= MAX_HASH_ITERATIONS:
        raise ValueError("Owner password hash work factor is invalid")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", encoded, salt, iterations, dklen=32)
    return f"pbkdf2_sha256${iterations}${_base64url(salt)}${_base64url(digest)}"


def _machine_credential(value: str) -> bool:
    candidate = value.encode("utf-8")
    return any(
        configured and hmac.compare_digest(candidate, configured.encode("utf-8"))
        for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN")
        if (configured := os.environ.get(name, ""))
    )


def _purge_sessions(configuration: _PasswordConfiguration | None, now: float) -> None:
    for fingerprint, session in list(_sessions.items()):
        if (
            configuration is None
            or session.expires_monotonic <= now
            or not hmac.compare_digest(session.configuration_fingerprint, configuration.fingerprint)
        ):
            del _sessions[fingerprint]


def _retry_error(seconds: float, detail: str = "登录请求过于频繁，请稍后重试") -> HTTPException:
    return HTTPException(
        status_code=429,
        detail=detail,
        headers={"Retry-After": str(max(1, math.ceil(seconds)))},
    )


def _limit_login(client: str) -> None:
    """Bound all attempts before parsing/hash work; never trusts X-Forwarded-For."""
    now = time.monotonic()
    identity = hashlib.sha256(client[:128].encode("utf-8")).digest()
    with _state_lock:
        while _global_logins and now - _global_logins[0] >= LOGIN_WINDOW_SECONDS:
            _global_logins.popleft()
        for key, bucket in list(_client_logins.items()):
            while bucket and now - bucket[0] >= LOGIN_WINDOW_SECONDS:
                bucket.popleft()
            if not bucket:
                del _client_logins[key]
        if len(_global_logins) >= GLOBAL_LOGIN_LIMIT:
            raise _retry_error(LOGIN_WINDOW_SECONDS - (now - _global_logins[0]))
        bucket = _client_logins.get(identity)
        if bucket is None:
            if len(_client_logins) >= MAX_LOGIN_CLIENTS:
                raise _retry_error(LOGIN_WINDOW_SECONDS)
            bucket = _client_logins[identity] = deque()
        # Count client-rejected attempts globally too, so distributed traffic
        # cannot force unbounded parsing or password work.
        _global_logins.append(now)
        if len(bucket) >= CLIENT_LOGIN_LIMIT:
            raise _retry_error(LOGIN_WINDOW_SECONDS - (now - bucket[0]))
        bucket.append(now)


def authenticated_owner_session(token: str, *, required_scope: str | None = None) -> OwnerSession | None:
    """Return a live owner identity only for a server-issued opaque bearer."""
    with _state_lock:
        configuration = _configuration()
        _purge_sessions(configuration, time.monotonic())
        if not isinstance(token, str) or not _TOKEN_PATTERN.fullmatch(token) or _machine_credential(token):
            return None
        session = _sessions.get(hashlib.sha256(token.encode("ascii")).digest())
        if session is None or (required_scope is not None and required_scope not in session.scopes):
            return None
        return session


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="Owner 会话无效或已过期，请重新登录",
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_owner_session(
    credentials: HTTPAuthorizationCredentials | None = Security(_owner_bearer),
) -> OwnerSession:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized()
    session = authenticated_owner_session(credentials.credentials)
    if session is None:
        raise _unauthorized()
    return session


def require_owner_scope(scope: str):
    """Dependency factory for future owner-only writes/analysis, not Admin work."""
    if scope not in OWNER_SCOPES:
        raise ValueError("Unknown Owner scope")

    def scoped(session: OwnerSession = Depends(require_owner_session)) -> OwnerSession:
        if scope not in session.scopes:
            raise HTTPException(status_code=403, detail="Owner 会话无权执行此操作")
        return session

    return scoped


def _issue_session(password: SecretStr) -> dict:
    configuration = _configuration()
    if configuration is None:
        with _state_lock:
            _purge_sessions(None, time.monotonic())
        raise HTTPException(status_code=503, detail="Owner 登录服务未配置")
    candidate = password.get_secret_value()
    if len(candidate.encode("utf-8")) > MAX_PASSWORD_BYTES or _machine_credential(candidate):
        raise HTTPException(status_code=401, detail="登录凭据无效")
    if not _verification_slots.acquire(blocking=False):
        raise _retry_error(1)
    try:
        digest = hashlib.pbkdf2_hmac(
            "sha256", candidate.encode("utf-8"), configuration.salt, configuration.iterations, dklen=32,
        )
    finally:
        _verification_slots.release()
    if not hmac.compare_digest(digest, configuration.digest):
        raise HTTPException(status_code=401, detail="登录凭据无效")
    now = time.monotonic()
    with _state_lock:
        current = _configuration()
        _purge_sessions(current, now)
        # A password rotation concurrent with slow verification cannot revive
        # the old configuration or issue a session using the old password.
        if current is None or not hmac.compare_digest(configuration.fingerprint, current.fingerprint):
            raise HTTPException(status_code=503, detail="Owner 登录配置已更新，请重试")
        if len(_sessions) >= MAX_SESSIONS:
            raise _retry_error(SESSION_TTL_SECONDS, "Owner 会话数量已达上限，请先退出其他设备")
        for _ in range(3):
            token = "own_" + secrets.token_urlsafe(32)
            fingerprint = hashlib.sha256(token.encode("ascii")).digest()
            if fingerprint not in _sessions and not _machine_credential(token):
                break
        else:
            raise HTTPException(status_code=503, detail="Owner 会话暂不可用")
        session = OwnerSession(
            owner_id="owner",
            scopes=OWNER_SCOPES,
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL_SECONDS),
            expires_monotonic=now + SESSION_TTL_SECONDS,
            configuration_fingerprint=configuration.fingerprint,
        )
        _sessions[fingerprint] = session
    return {**session.metadata(), "access_token": token}


_LOGIN_SCHEMA = {
    "requestBody": {
        "required": True,
        "content": {"application/json": {"schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["password"],
            "properties": {"password": {
                "type": "string", "writeOnly": True, "minLength": 1, "maxLength": MAX_PASSWORD_BYTES,
                "description": "At most 512 UTF-8 bytes; never persisted or echoed in validation errors.",
            }},
        }}},
    },
}


def _json_object(pairs: list[tuple[str, object]]) -> dict:
    payload: dict = {}
    for key, value in pairs:
        if key in payload:
            raise ValueError("Duplicate login field")
        payload[key] = value
    return payload


@router.post("/session", response_model=OwnerLoginResponse, openapi_extra=_LOGIN_SCHEMA)
async def login_owner(request: Request) -> dict:
    _limit_login(request.client.host if request.client else "unknown")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(status_code=415, detail="登录请求格式无效")
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_LOGIN_BODY_BYTES:
            raise HTTPException(status_code=413, detail="登录请求过大")
        raw.extend(chunk)
    try:
        payload = OwnerLoginRequest.model_validate(json.loads(raw, object_pairs_hook=_json_object))
    except (ValueError, TypeError, ValidationError):
        # Do not serialize validation errors: FastAPI/Pydantic's normal error
        # body may include the submitted password as its `input` property.
        raise HTTPException(status_code=422, detail="登录请求无效") from None
    return await run_in_threadpool(_issue_session, payload.password)


@router.get("/session", response_model=OwnerSessionMetadata)
def get_owner_session(session: OwnerSession = Depends(require_owner_session)) -> dict:
    return session.metadata()


@router.delete("/session", status_code=204)
def logout_owner(
    credentials: HTTPAuthorizationCredentials | None = Security(_owner_bearer),
) -> Response:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized()
    if authenticated_owner_session(credentials.credentials) is None:
        raise _unauthorized()
    fingerprint = hashlib.sha256(credentials.credentials.encode("ascii")).digest()
    with _state_lock:
        _sessions.pop(fingerprint, None)
    return Response(status_code=204)


def reset_owner_sessions() -> None:
    """Test helper: clears process-local sessions and attempt counters only."""
    with _state_lock:
        _sessions.clear()
        _global_logins.clear()
        _client_logins.clear()
