"""Bearer authentication and bounded in-process rate limiting for write endpoints."""
from __future__ import annotations

import hashlib
import hmac
import os
import threading
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException

WINDOW_SECONDS = 60
MAX_REQUESTS = 30
_lock = threading.Lock()
_requests: dict[str, deque[float]] = defaultdict(deque)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


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


def _identity(role: str, token: str) -> str:
    """Use a one-way token fingerprint so secrets never become dictionary keys."""
    fingerprint = hashlib.sha256(token.encode("utf-8")).hexdigest()[:20]
    return f"{role}:{fingerprint}"


def _rate_limit(identity: str) -> None:
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
        if len(bucket) >= MAX_REQUESTS:
            retry_after = max(1, int(WINDOW_SECONDS - (now - bucket[0])))
            raise HTTPException(
                status_code=429,
                detail="写接口请求过于频繁",
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)


def require_admin(authorization: str | None = Header(None)) -> str:
    token = _bearer(authorization)
    if not _matches(token, "ADMIN_TOKEN"):
        raise _unauthorized("管理员凭证无效")
    _rate_limit(_identity("admin", token))
    return "admin"


def require_worker_or_admin(authorization: str | None = Header(None)) -> str:
    token = _bearer(authorization)
    if _matches(token, "WORKER_TOKEN"):
        role = "worker"
    elif _matches(token, "ADMIN_TOKEN"):
        role = "admin"
    else:
        raise _unauthorized("Worker 或管理员凭证无效")
    _rate_limit(_identity(role, token))
    return role


def reset_rate_limits() -> None:
    """Test helper; never exposes token values."""
    with _lock:
        _requests.clear()
