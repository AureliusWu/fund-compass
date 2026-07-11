"""Minimal bearer authentication and in-process rate limiting for write endpoints."""
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


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="需要 Bearer 凭证")
    return authorization[7:].strip()


def _matches(value: str, env_name: str) -> bool:
    expected = os.environ.get(env_name, "")
    return bool(expected) and hmac.compare_digest(value, expected)


def _rate_limit(identity: str) -> None:
    now = time.monotonic()
    with _lock:
        bucket = _requests[identity]
        while bucket and now - bucket[0] >= WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= MAX_REQUESTS:
            raise HTTPException(status_code=429, detail="写接口请求过于频繁")
        bucket.append(now)


def require_admin(authorization: str | None = Header(None)) -> str:
    token = _bearer(authorization)
    if not _matches(token, "ADMIN_TOKEN"):
        raise HTTPException(status_code=401, detail="管理员凭证无效")
    _rate_limit("admin:" + token)
    return "admin"


def require_worker_or_admin(authorization: str | None = Header(None)) -> str:
    token = _bearer(authorization)
    if _matches(token, "WORKER_TOKEN"):
        role = "worker"
    elif _matches(token, "ADMIN_TOKEN"):
        role = "admin"
    else:
        raise HTTPException(status_code=401, detail="Worker 或管理员凭证无效")
    _rate_limit(role + ":" + token)
    return role


def reset_rate_limits() -> None:
    """Test helper; never exposes token values."""
    with _lock:
        _requests.clear()
