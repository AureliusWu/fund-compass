"""Explicit Owner analysis requests over an already provisioned local database.

Router construction performs no I/O. Analysis authorization is independent of
holding writes and machine roles; an uncertain accepted request is reconciled
only by its original request ID and hash, never automatically replayed.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import closing
import json
import re
from typing import Protocol

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from models.owner_analysis import MAX_BODY_BYTES, AnalysisValidationError, parse_owner_analysis_request
from service import owner_analysis_repo as repo
from service import owner_sessions as owners
from service import security

BODY_DEADLINE_SECONDS = 5.0
ANALYSIS_CONSENT = "owner-analysis-v1"
PRIVATE_HEADERS = {
    "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff",
}
_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z", re.ASCII)
_REQUEST_HASH = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_CONTENT_LENGTH = re.compile(r"[0-9]{1,10}\Z", re.ASCII)


class _AuthorizationFailure(HTTPException):
    """Only genuine revalidation failures may cross a driver boundary."""


def _error(status: int, code: str, headers: dict | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail=code, headers={**(headers or {}), **PRIVATE_HEADERS})


def _private_auth(scope: str):
    def authorize(credentials: HTTPAuthorizationCredentials | None = Security(owners._owner_bearer)):
        try:
            context = owners.require_owner_authorization(credentials)
            owners.revalidate_owner_authorization(context, required_scope=scope)
            security._rate_limit(
                f"owner_analysis_{scope}:{context.token_fingerprint.hex()}",
                max_requests=(security.MAX_REQUESTS if scope == "run_personal_analysis"
                              else security.PRIVATE_READ_MAX_REQUESTS),
                detail="Owner 分析请求过于频繁",
            )
            return context
        except HTTPException as error:
            raise _error(error.status_code, error.detail, error.headers) from None
    return authorize


def _revalidate(context: owners.OwnerAuthorization, scope: str):
    try:
        return owners.revalidate_owner_authorization(context, required_scope=scope)
    except HTTPException as error:
        raise _AuthorizationFailure(status_code=error.status_code, detail=error.detail,
                                    headers={**(error.headers or {}), **PRIVATE_HEADERS}) from None


async def _read_body(request: Request) -> bytes:
    content_types = request.headers.getlist("content-type")
    if (len(content_types) != 1
            or content_types[0].split(";", 1)[0].strip().lower() != "application/json"):
        raise _error(415, "invalid_analysis_content_type")
    if request.headers.getlist("x-owner-analysis-consent") != [ANALYSIS_CONSENT]:
        raise _error(403, "analysis_consent_required")
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or (lengths and not _CONTENT_LENGTH.fullmatch(lengths[0])):
        raise _error(400, "invalid_analysis_content_length")
    declared = int(lengths[0]) if lengths else None
    if declared is not None and declared > MAX_BODY_BYTES:
        raise _error(413, "analysis_body_too_large")
    body = bytearray()
    try:
        async with asyncio.timeout(BODY_DEADLINE_SECONDS):
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_BODY_BYTES:
                    raise _error(413, "analysis_body_too_large")
                body.extend(chunk)
    except TimeoutError:
        raise _error(408, "analysis_body_timeout") from None
    except ClientDisconnect:
        raise _error(400, "analysis_body_incomplete") from None
    except HTTPException:
        raise
    except Exception:
        raise _error(400, "analysis_body_incomplete") from None
    if declared is not None and declared != len(body):
        raise _error(400, "invalid_analysis_content_length")
    return bytes(body)


class OwnerAnalysisRepository(Protocol):
    """Two closed analysis operations; never an HTTP-facing SQL executor."""

    def create(self, raw_request: bytes, *, before_commit: Callable) -> repo.AnalysisResult: ...

    def reconcile(self, request_id: str, request_hash: str) -> repo.AnalysisReconciliation: ...


class _LocalWriteFailure(Exception):
    def __init__(self, *, attempted: bool):
        self.attempted = attempted
        super().__init__("Owner analysis local operation failed")


class LocalOwnerAnalysisRepository:
    """Own the existing local factory and its close/uncertain-write boundary."""

    def __init__(self, connection_factory: Callable):
        self._connection_factory = connection_factory

    def create(self, raw_request: bytes, *, before_commit: Callable) -> repo.AnalysisResult:
        attempted = False
        try:
            with closing(self._connection_factory()) as conn:
                attempted = True
                return repo.create_analysis_local(conn, raw_request, before_commit=before_commit)
        except _AuthorizationFailure:
            raise
        except Exception:
            raise _LocalWriteFailure(attempted=attempted) from None

    def reconcile(self, request_id: str, request_hash: str) -> repo.AnalysisReconciliation:
        with closing(self._connection_factory()) as conn:
            return repo.reconcile_analysis_local(conn, request_id, request_hash)


def build_owner_analysis_router(connection_factory: Callable) -> APIRouter:
    """Keep main's existing local-only factory and zero-I/O construction."""
    return build_owner_analysis_repository_router(LocalOwnerAnalysisRepository(connection_factory))


def build_owner_analysis_repository_router(repository: OwnerAnalysisRepository) -> APIRouter:
    """Bind only analysis and original-receipt reconciliation capabilities."""
    router = APIRouter(prefix="/api/v2/owner/analysis", tags=["owner-analysis-candidate"])

    @router.post("")
    async def analyze(request: Request, context=Depends(_private_auth("run_personal_analysis"))):
        if request.query_params:
            raise _error(422, "invalid_analysis_query")
        raw = await _read_body(request)
        _revalidate(context, "run_personal_analysis")
        try:
            parse_owner_analysis_request(raw)
        except AnalysisValidationError:
            raise _error(422, "invalid_analysis_request") from None
        _revalidate(context, "run_personal_analysis")

        def write():
            _revalidate(context, "run_personal_analysis")
            try:
                return repository.create(
                    raw, before_commit=lambda: _revalidate(context, "run_personal_analysis"),
                )
            except _AuthorizationFailure:
                raise
            except _LocalWriteFailure as error:
                raise _error(503, "analysis_result_unknown" if error.attempted else "analysis_storage_unavailable") from None
            except Exception:
                # A remote call or a local close failure is not rollback proof.
                raise _error(503, "analysis_result_unknown") from None

        result = await run_in_threadpool(write)
        _revalidate(context, "run_personal_analysis")
        try:
            body = json.dumps(result.body, sort_keys=True, separators=(",", ":"),
                              ensure_ascii=False, allow_nan=False)
        except Exception:
            raise _error(503, "analysis_result_unknown") from None
        _revalidate(context, "run_personal_analysis")
        return Response(body, status_code=result.status, media_type="application/json", headers=PRIVATE_HEADERS)

    @router.get("/requests/{request_id}")
    async def receipt(request_id: str, request: Request, context=Depends(_private_auth("read_private"))):
        if not _REQUEST_ID.fullmatch(request_id) or request.query_params:
            raise _error(422, "invalid_analysis_request_id")
        hashes = request.headers.getlist("x-owner-analysis-request-hash")
        if len(hashes) != 1 or not _REQUEST_HASH.fullmatch(hashes[0]):
            raise _error(422, "invalid_analysis_request_hash")
        request_hash = hashes[0]
        _revalidate(context, "read_private")

        def read():
            _revalidate(context, "read_private")
            try:
                return repository.reconcile(request_id, request_hash)
            except _AuthorizationFailure:
                raise
            except Exception:
                return None

        reconciliation = await run_in_threadpool(read)
        _revalidate(context, "read_private")
        unknown = {"state": "unknown", "error": "analysis_result_unknown"}
        if (reconciliation is not None and reconciliation.request_id == request_id
                and reconciliation.state == "absent"):
            return JSONResponse(unknown, status_code=404, headers=PRIVATE_HEADERS)
        if (reconciliation is None or reconciliation.request_id != request_id
                or reconciliation.state != "matched" or reconciliation.result is None
                or reconciliation.result.status not in (200, 409)):
            return JSONResponse(unknown, status_code=503, headers=PRIVATE_HEADERS)
        stored = reconciliation.result
        response = JSONResponse({"state": "matched", "status": stored.status, "result": stored.body}, headers=PRIVATE_HEADERS)
        _revalidate(context, "read_private")
        return response

    return router
