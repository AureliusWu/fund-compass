"""Bearer authentication and bounded in-process rate limiting.

Admin and Worker credentials authorize operational writes.  Private read
access deliberately uses a separate token so neither privileged credential
needs to be shipped to a browser or reused as an end-user identity.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import threading
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

WINDOW_SECONDS = 60
MAX_REQUESTS = 30
PRIVATE_READ_MAX_REQUESTS = 120
_lock = threading.Lock()
_requests: dict[str, deque[float]] = defaultdict(deque)
_private_read_bearer = HTTPBearer(
    auto_error=False,
    scheme_name="PrivateReadBearer",
    description=(
        "Single-owner private read credential. Configure PRIVATE_READ_TOKEN; "
        "ADMIN_TOKEN and WORKER_TOKEN are not accepted."
    ),
)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=403, detail=detail)


def _bearer(authorization: str | None) -> str:
    if not authorization:
        raise _unauthorized("需要 Bearer 凭证")
    scheme, separator, value = authorization.partition(" ")
    token = value.strip() if separator else ""
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized("需要 Bearer 凭证")
    return token


def _matches(value: str, env_name: str) -> bool:
    expected = os.environ.get(env_name, "")
    return bool(expected) and hmac.compare_digest(value, expected)


def _ensure_credential_separation() -> None:
    """Fail every privileged role closed when configured secrets collide."""
    configured = [
        (name, value)
        for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN")
        if (value := os.environ.get(name, ""))
    ]
    for index, (_, left) in enumerate(configured):
        if any(hmac.compare_digest(left, right) for _, right in configured[index + 1:]):
            raise HTTPException(status_code=503, detail="Admin、Worker 与私人读取凭证必须彼此隔离")


def _identity(role: str, token: str) -> str:
    """Use a one-way token fingerprint so secrets never become dictionary keys."""
    fingerprint = hashlib.sha256(token.encode("utf-8")).hexdigest()[:20]
    return f"{role}:{fingerprint}"


def _rate_limit(
    identity: str,
    *,
    max_requests: int | None = None,
    detail: str = "写接口请求过于频繁",
) -> None:
    limit = MAX_REQUESTS if max_requests is None else max_requests
    now = time.monotonic()
    with _lock:
        # Remove expired identities as well as timestamps, keeping memory bounded
        # after token rotation or test traffic using many identities.
        for key in list(_requests):
            bucket = _requests[key]
            while bucket and now - bucket[0] >= WINDOW_SECONDS:
                bucket.popleft()
            if not bucket:
                del _requests[key]

        bucket = _requests[identity]
        if len(bucket) >= limit:
            retry_after = max(1, int(WINDOW_SECONDS - (now - bucket[0])))
            raise HTTPException(
                status_code=429,
                detail=detail,
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)


def require_admin(authorization: str | None = Header(None)) -> str:
    token = _bearer(authorization)
    _ensure_credential_separation()
    if not _matches(token, "ADMIN_TOKEN"):
        raise _unauthorized("管理员凭证无效")
    _rate_limit(_identity("admin", token))
    return "admin"


def require_worker_or_admin(authorization: str | None = Header(None)) -> str:
    token = _bearer(authorization)
    _ensure_credential_separation()
    if _matches(token, "WORKER_TOKEN"):
        role = "worker"
    elif _matches(token, "ADMIN_TOKEN"):
        role = "admin"
    else:
        raise _unauthorized("Worker 或管理员凭证无效")
    _rate_limit(_identity(role, token))
    return role


def require_private_read(
    credentials: HTTPAuthorizationCredentials | None = Security(_private_read_bearer),
) -> str:
    """Authorize the deployment owner's lossless private read API.

    The current project is single-owner and has no user/account table.  This
    token therefore isolates private DTOs without pretending that Admin or
    Worker credentials are a user login.  A future multi-user service must
    replace it with row ownership, not broaden this credential.
    """
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise _unauthorized("需要私人读取 Bearer 凭证")
    token = credentials.credentials.strip()
    expected = os.environ.get("PRIVATE_READ_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="私人读取服务未配置")
    _ensure_credential_separation()
    if not hmac.compare_digest(token, expected):
        raise _forbidden("私人读取凭证无权访问")
    _rate_limit(
        _identity("private_reader", token),
        max_requests=PRIVATE_READ_MAX_REQUESTS,
        detail="私人读取请求过于频繁",
    )
    return "private_reader"


def reset_rate_limits() -> None:
    """Test helper; never exposes token values."""
    with _lock:
        _requests.clear()
