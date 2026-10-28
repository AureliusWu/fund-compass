"""Protected local machine candidate routes, with no browser Owner authority.

This router does not provision storage or send notifications. The sender must
retain its original task/attempt hashes; an unknown write is never replayed.
"""
from __future__ import annotations

import asyncio
from contextlib import closing
from dataclasses import dataclass
import hmac
import json
import os

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from models.owner_machine import (
    MAX_BODY_BYTES, MachineClaim, MachineFinish, MachineInput, MachinePrepare, parse_machine_input,
)
from service import owner_analysis_repo as analysis, owner_machine_repo as repo, security

PRIVATE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff"}


def _error(status, code, headers=None):
    return HTTPException(status_code=status, detail=code, headers={**(headers or {}), **PRIVATE_HEADERS})


class _AuthorizationFailure(HTTPException):
    pass


@dataclass(frozen=True, repr=False)
class _Authority:
    role: str
    token: str


def _authorize(authorization: str | None = Header(None)):
    try:
        role = security.require_worker_or_admin(authorization)
        return _Authority(role, security._bearer(authorization))
    except HTTPException as error:
        raise _error(error.status_code, error.detail, error.headers) from None


def _revalidate(authority):
    try:
        security._ensure_credential_separation()
        configured = os.environ.get("WORKER_TOKEN" if authority.role == "worker" else "ADMIN_TOKEN", "")
        if not configured or not hmac.compare_digest(configured.encode("utf-8"), authority.token.encode("utf-8")):
            raise _error(401, "machine_authorization_changed")
    except HTTPException as error:
        raise _AuthorizationFailure(status_code=error.status_code, detail=error.detail,
                                    headers={**(error.headers or {}), **PRIVATE_HEADERS}) from None


async def _body(request):
    if request.query_params:
        raise _error(422, "invalid_machine_query")
    types = request.headers.getlist("content-type")
    if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
        raise _error(415, "invalid_machine_content_type")
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or lengths and (not lengths[0].isascii() or not lengths[0].isdigit() or len(lengths[0]) > 10):
        raise _error(400, "invalid_machine_content_length")
    declared = int(lengths[0]) if lengths else None
    if declared is not None and declared > MAX_BODY_BYTES:
        raise _error(413, "machine_body_too_large")
    data = bytearray()
    try:
        async with asyncio.timeout(5.0):
            async for chunk in request.stream():
                if len(data) + len(chunk) > MAX_BODY_BYTES:
                    raise _error(413, "machine_body_too_large")
                data.extend(chunk)
    except TimeoutError:
        raise _error(408, "machine_body_timeout") from None
    except ClientDisconnect:
        raise _error(400, "machine_body_incomplete") from None
    if declared is not None and declared != len(data):
        raise _error(400, "invalid_machine_content_length")
    return bytes(data)


def build_owner_machine_router(connection_factory):
    """Construction has zero I/O; only an existing complete local profile opens."""
    router = APIRouter(prefix="/api/v2/worker/portfolio", tags=["owner-machine-candidate"])

    async def execute(authority, operation, *, writing=False):
        _revalidate(authority)
        def call():
            attempted = False
            try:
                _revalidate(authority)
                with closing(connection_factory()) as conn:
                    _revalidate(authority)
                    attempted = writing
                    return operation(conn, lambda: _revalidate(authority))
            except _AuthorizationFailure:
                raise
            except analysis._GuardFailure as error:
                if isinstance(error.original, _AuthorizationFailure):
                    raise error.original from None
                raise _error(503, "machine_result_unknown" if attempted else "machine_storage_unavailable") from None
            except repo.MachineFault as error:
                raise _error(error.status, error.code) from None
            except analysis._Fault as error:
                raise _error(error.status, error.code) from None
            except Exception:
                raise _error(503, "machine_result_unknown" if attempted else "machine_storage_unavailable") from None
        value = await run_in_threadpool(call)
        _revalidate(authority)
        return Response(analysis._json(value), media_type="application/json", headers=PRIVATE_HEADERS)

    @router.get("/source")
    async def source(request: Request, authority=Depends(_authorize)):
        if request.query_params:
            raise _error(422, "invalid_machine_query")
        return await execute(authority, lambda conn, _check: repo.read_source_local(conn))

    def parsed(raw, model):
        try:
            return parse_machine_input(raw, model)
        except Exception:
            raise _error(422, "invalid_machine_request") from None

    @router.post("/tasks/prepare")
    async def prepare(request: Request, authority=Depends(_authorize)):
        value = parsed(await _body(request), MachinePrepare)
        return await execute(authority, lambda conn, check: repo.prepare_local(conn, value, before_commit=check), writing=True)

    @router.post("/tasks/claim")
    async def claim(request: Request, authority=Depends(_authorize)):
        value = parsed(await _body(request), MachineClaim)
        return await execute(authority, lambda conn, check: repo.claim_local(conn, value, before_commit=check), writing=True)

    @router.post("/tasks/finish")
    async def finish(request: Request, authority=Depends(_authorize)):
        value = parsed(await _body(request), MachineFinish)
        return await execute(authority, lambda conn, check: repo.finish_local(conn, value, before_commit=check), writing=True)

    @router.get("/tasks/{occurrence_date}")
    async def status(occurrence_date: str, request: Request, authority=Depends(_authorize)):
        if request.query_params:
            raise _error(422, "invalid_machine_query")
        try:
            MachineInput(occurrence_date=occurrence_date)
        except Exception:
            raise _error(422, "invalid_machine_occurrence") from None
        return await execute(authority, lambda conn, _check: repo.read_status_local(conn, occurrence_date))

    return router
