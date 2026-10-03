"""Owner-only HTTP candidate, registered explicitly in isolated test apps.

No main.py registration, environment lookup, configured database access or
automatic schema provisioning. The connection factory must create an explicit
local SQLite connection in the calling thread. Turso integration is separate.
"""
from __future__ import annotations

import asyncio
from contextlib import closing
import json
import re
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from models.owner_sync import MAX_BODY_BYTES, MAX_SAFE_INTEGER, SyncValidationError, parse_sync_request
from service import owner_sessions as owners
from service import owner_sync_repo as repo
from service import security

BODY_DEADLINE_SECONDS = 5.0
SYNC_CONSENT = "owner-sync-v1"
PRIVATE_HEADERS = {
    "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff",
}
_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z", re.ASCII)
_REQUEST_HASH = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_INTEGER = re.compile(r"(?:0|[1-9][0-9]{0,15})\Z", re.ASCII)


def _error(status: int, code: str, headers: dict | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail=code, headers={**(headers or {}), **PRIVATE_HEADERS})


def _private_auth(scope: str):
    def authorize(credentials: HTTPAuthorizationCredentials | None = Security(owners._owner_bearer)):
        try:
            context = owners.require_owner_authorization(credentials)
            owners.revalidate_owner_authorization(context, required_scope=scope)
            security._rate_limit(
                f"owner_sync_{scope}:{context.token_fingerprint.hex()}",
                max_requests=security.MAX_REQUESTS if scope == "write_holdings" else security.PRIVATE_READ_MAX_REQUESTS,
                detail="Owner 同步请求过于频繁",
            )
            return context
        except HTTPException as error:
            raise _error(error.status_code, error.detail, error.headers) from None
    return authorize


def _revalidate(context, scope):
    try:
        return owners.revalidate_owner_authorization(context, required_scope=scope)
    except HTTPException as error:
        raise _error(error.status_code, error.detail, error.headers) from None


async def _read_body(request: Request) -> bytes:
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise _error(415, "invalid_sync_content_type")
    if request.headers.get("x-owner-sync-consent") != SYNC_CONSENT:
        raise _error(403, "sync_consent_required")
    declared = request.headers.get("content-length")
    if declared is not None:
        if not re.fullmatch(r"[0-9]{1,10}", declared, re.ASCII):
            raise _error(400, "invalid_sync_content_length")
        if int(declared) > MAX_BODY_BYTES:
            raise _error(413, "sync_body_too_large")
    body = bytearray()
    try:
        async with asyncio.timeout(BODY_DEADLINE_SECONDS):
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_BODY_BYTES:
                    raise _error(413, "sync_body_too_large")
                body.extend(chunk)
    except TimeoutError:
        raise _error(408, "sync_body_timeout") from None
    except ClientDisconnect:
        raise _error(400, "sync_body_incomplete") from None
    return bytes(body)


def _query(request: Request) -> dict:
    items = request.query_params.multi_items()
    allowed = {"since_revision", "upper_revision", "limit", "cursor_revision", "cursor_key"}
    if len(items) != len(dict(items)) or any(key not in allowed for key, _ in items):
        raise _error(422, "invalid_sync_query")
    values = dict(items)

    def integer(key: str, default=None):
        value = values.get(key)
        if value is None:
            return default
        if not _INTEGER.fullmatch(value) or int(value) > MAX_SAFE_INTEGER:
            raise _error(422, "invalid_sync_query")
        return int(value)

    since, upper, limit = integer("since_revision", 0), integer("upper_revision"), integer("limit", 100)
    cursor_revision, cursor_key = integer("cursor_revision"), values.get("cursor_key")
    if not 1 <= limit <= 200 or (upper is not None and upper < since):
        raise _error(422, "invalid_sync_query")
    if (cursor_revision is None) != (cursor_key is None):
        raise _error(422, "invalid_sync_query")
    cursor = None
    if cursor_key is not None:
        if (upper is None or not since < cursor_revision <= upper or not 1 <= len(cursor_key) <= 160
                or any(ord(char) < 32 or ord(char) == 127 for char in cursor_key)):
            raise _error(422, "invalid_sync_query")
        cursor = (cursor_revision, cursor_key)
    return {"since_revision": since, "upper_revision": upper, "limit": limit, "cursor": cursor}


def build_owner_sync_router(connection_factory: Callable) -> APIRouter:
    """Build a test/candidate router; calling this does not open a database."""
    router = APIRouter(prefix="/api/v2/owner/sync", tags=["owner-sync-candidate"])

    @router.post("")
    async def synchronize(request: Request, context=Depends(_private_auth("write_holdings"))):
        raw = await _read_body(request)
        _revalidate(context, "write_holdings")
        try:
            parse_sync_request(raw)
        except SyncValidationError:
            raise _error(422, "invalid_sync_request") from None

        def write():
            _revalidate(context, "write_holdings")
            attempted = False
            try:
                with closing(connection_factory()) as conn:
                    attempted = True
                    return repo.apply_sync_local(conn, raw, before_commit=lambda: _revalidate(context, "write_holdings"))
            except HTTPException:
                raise
            except Exception:
                # Never expose a factory/driver error, path, SQL or input.
                # A factory failure occurs before any write. Once accepted,
                # even a close/driver failure cannot prove a rollback.
                raise _error(503, "sync_result_unknown" if attempted else "sync_storage_unavailable") from None

        result = await run_in_threadpool(write)
        # Logout cannot cancel an accepted commit, but must prevent a private
        # success body from being delivered using revoked captured metadata.
        _revalidate(context, "write_holdings")
        # Canonical response bytes stay identical across the initial write and
        # JSON receipt reload; dictionary insertion order is not stable there.
        return Response(json.dumps(result.body, sort_keys=True, separators=(",", ":"),
                                   ensure_ascii=False, allow_nan=False),
                        status_code=result.status, media_type="application/json", headers=PRIVATE_HEADERS)

    @router.get("")
    async def changes(request: Request, context=Depends(_private_auth("read_private"))):
        parameters = _query(request)

        def read():
            _revalidate(context, "read_private")
            try:
                with closing(connection_factory()) as conn:
                    return repo.read_sync_changes(conn, **parameters)
            except HTTPException:
                raise
            except repo.SyncReadError as error:
                raise _error(422 if error.status == 422 else 503,
                             "invalid_sync_query" if error.status == 422 else "sync_storage_unavailable") from None
            except Exception:
                raise _error(503, "sync_storage_unavailable") from None

        page = await run_in_threadpool(read)
        _revalidate(context, "read_private")
        return JSONResponse(page, headers=PRIVATE_HEADERS)

    @router.get("/requests/{request_id}")
    async def receipt(request_id: str, request: Request, context=Depends(_private_auth("read_private"))):
        if not _REQUEST_ID.fullmatch(request_id) or request.query_params:
            raise _error(422, "invalid_sync_request_id")
        hashes = request.headers.getlist("x-owner-sync-request-hash")
        if len(hashes) != 1 or not _REQUEST_HASH.fullmatch(hashes[0]):
            raise _error(422, "invalid_sync_request_hash")
        request_hash = hashes[0]

        def read():
            _revalidate(context, "read_private")
            try:
                with closing(connection_factory()) as conn:
                    return repo.reconcile_sync_local(conn, request_id, request_hash)
            except Exception:
                # A driver/factory/close failure cannot establish whether an
                # accepted write committed. Never echo the supplied hash or
                # an unverified receipt, even if read succeeded before close.
                return None

        reconciliation = await run_in_threadpool(read)
        _revalidate(context, "read_private")
        unknown = {"state": "unknown", "error": "sync_result_unknown"}
        if reconciliation is not None and reconciliation.state == "absent":
            # Missing receipt is not proof that an unknown write rolled back.
            return JSONResponse(unknown, status_code=404, headers=PRIVATE_HEADERS)
        if (reconciliation is None or reconciliation.state != "matched" or reconciliation.result is None
                or reconciliation.result.status not in (200, 409)):
            return JSONResponse(unknown, status_code=503, headers=PRIVATE_HEADERS)
        stored = reconciliation.result
        return JSONResponse({"state": "matched", "status": stored.status, "result": stored.body}, headers=PRIVATE_HEADERS)

    return router
