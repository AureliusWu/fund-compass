"""Explicit Owner-only, read-only policy timeline over a provisioned local DB."""
from __future__ import annotations

from collections.abc import Callable
from contextlib import closing
import json
import math
import time
from typing import Protocol

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.security import HTTPAuthorizationCredentials
from starlette.concurrency import run_in_threadpool

from service import owner_sessions as owners, security
from service.owner_policy_state import read_owner_policy_state
from models.v8 import OwnerPolicyState

PRIVATE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff"}
READ_SECONDS = 30.0
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class _AuthorizationFailure(HTTPException):
    """Only an actual Owner revalidation may escape a storage boundary."""


def _error(status: int, detail: str, headers: dict | None = None):
    return HTTPException(status_code=status, detail=detail, headers={**(headers or {}), **PRIVATE_HEADERS})


def _budget(clock: list[float]):
    now = time.monotonic()
    if not math.isfinite(clock[0]) or not math.isfinite(now) or now < clock[1] or now - clock[0] >= READ_SECONDS:
        raise _error(503, "policy_state_unavailable")
    clock[1] = now


def _authorize(request: Request, credentials: HTTPAuthorizationCredentials | None = Security(owners._owner_bearer)):
    started = [time.monotonic()] * 2
    try:
        _budget(started)
        if len(request.headers.getlist("authorization")) != 1:
            raise _error(401, "Owner 会话无效或已过期，请重新登录")
        context = owners.require_owner_authorization(credentials)
        owners.revalidate_owner_authorization(context, required_scope="read_private")
        security._rate_limit(f"owner_policy_read:{context.token_fingerprint.hex()}",
                             max_requests=security.PRIVATE_READ_MAX_REQUESTS, detail="私人读取请求过于频繁")
        _budget(started)
        return context, started
    except HTTPException as error:
        raise _error(error.status_code, error.detail, error.headers) from None


class OwnerPolicyRepository(Protocol):
    """Only the fixed read-only Policy timeline is exposed to the router."""

    def read_state(self, *, before_return: Callable) -> OwnerPolicyState: ...


class LocalOwnerPolicyRepository:
    def __init__(self, connection_factory: Callable):
        self._connection_factory = connection_factory

    def read_state(self, *, before_return: Callable) -> OwnerPolicyState:
        before_return()
        with closing(self._connection_factory()) as conn:
            before_return()
            value = read_owner_policy_state(conn, before_return=before_return)
            before_return()
        before_return()
        return value


def build_owner_policy_router(connection_factory: Callable) -> APIRouter:
    """Keep main's existing closed local factory; construction is zero I/O."""
    return build_owner_policy_repository_router(LocalOwnerPolicyRepository(connection_factory))


def build_owner_policy_repository_router(repository: OwnerPolicyRepository) -> APIRouter:
    """Bind the read-only capability without changing auth or read budgets."""
    router = APIRouter(prefix="/api/v2/private/portfolio", tags=["owner-policy-state-candidate"])

    @router.get("/policy-state")
    async def state(request: Request, authorization=Depends(_authorize)):
        context, started = authorization
        if request.query_params:
            raise _error(422, "invalid_policy_state_query")
        def check():
            _budget(started)
            try:
                owners.revalidate_owner_authorization(context, required_scope="read_private")
            except HTTPException as error:
                raise _AuthorizationFailure(status_code=error.status_code, detail=error.detail,
                                            headers={**(error.headers or {}), **PRIVATE_HEADERS}) from None
            _budget(started)

        def read():
            check()
            try:
                value = repository.read_state(before_return=check)
                check()
                return value
            except _AuthorizationFailure:
                raise
            except Exception:
                raise _error(503, "policy_state_unavailable") from None

        check()
        value = await run_in_threadpool(read)
        check()
        try:
            body = json.dumps(value.model_dump(mode="json"), ensure_ascii=False, allow_nan=False,
                              separators=(",", ":"), sort_keys=True)
            if len(body.encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise ValueError("response limit")
        except Exception:
            raise _error(503, "policy_state_unavailable") from None
        check()
        return Response(body, media_type="application/json", headers=PRIVATE_HEADERS)

    return router
