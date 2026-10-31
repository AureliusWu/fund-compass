"""Protected local machine candidate routes, with no browser Owner authority.

This router does not provision storage or send notifications. The sender must
retain its original task/attempt hashes; an unknown write is never replayed.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
import hmac
import json
import os
import re
from typing import Protocol

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from models.owner_machine import (
    MAX_BODY_BYTES, MAX_EVIDENCE_BODY_BYTES, MachineClaim, MachineEvidence, MachineFinish, MachineInput,
    MachinePrepare, parse_machine_input,
)
from service import owner_analysis_repo as analysis, owner_machine_repo as repo, security
from service import owner_machine_evidence as evidence_repo
from models.owner_machine_cache import MachineCachePrepare, parse_cache_prepare
from service import owner_machine_cache as cache_repo

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


async def _body(request, *, max_bytes=MAX_BODY_BYTES):
    if request.query_params:
        raise _error(422, "invalid_machine_query")
    types = request.headers.getlist("content-type")
    if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
        raise _error(415, "invalid_machine_content_type")
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or lengths and (not lengths[0].isascii() or not lengths[0].isdigit() or len(lengths[0]) > 10):
        raise _error(400, "invalid_machine_content_length")
    declared = int(lengths[0]) if lengths else None
    if declared is not None and declared > max_bytes:
        raise _error(413, "machine_body_too_large")
    data = bytearray()
    try:
        async with asyncio.timeout(5.0):
            async for chunk in request.stream():
                if len(data) + len(chunk) > max_bytes:
                    raise _error(413, "machine_body_too_large")
                data.extend(chunk)
    except TimeoutError:
        raise _error(408, "machine_body_timeout") from None
    except ClientDisconnect:
        raise _error(400, "machine_body_incomplete") from None
    if declared is not None and declared != len(data):
        raise _error(400, "invalid_machine_content_length")
    return bytes(data)


class OwnerMachineRepository(Protocol):
    """Fixed business capabilities, never an arbitrary operation/SQL surface."""

    def read_source(self, *, before_read: Callable) -> dict: ...
    def prepare_cache(self, request: MachineCachePrepare, *, before_commit: Callable) -> dict: ...
    def cache_receipt(self, day: str, request_id: str, request_hash: str, *, before_read: Callable) -> dict: ...
    def ingest_evidence(self, request: MachineEvidence, *, before_commit: Callable) -> dict: ...
    def evidence_receipt(self, day: str, request_id: str, request_hash: str, *, before_read: Callable) -> dict: ...
    def prepare_task(self, request: MachinePrepare, *, before_commit: Callable) -> dict: ...
    def claim_task(self, request: MachineClaim, *, before_commit: Callable) -> dict: ...
    def finish_task(self, request: MachineFinish, *, before_commit: Callable) -> dict: ...
    def read_status(self, day: str, *, before_read: Callable) -> dict: ...


class _LocalOperationFailure(Exception):
    def __init__(self, *, attempted: bool):
        self.attempted = attempted
        super().__init__("Machine local operation failed")


class LocalOwnerMachineRepository:
    """Retain native local guards, one connection and its close per operation."""

    def __init__(self, connection_factory: Callable):
        self._connection_factory = connection_factory

    def _perform(self, operation: Callable, check: Callable, *, writing=False):
        attempted = False
        try:
            check()
            with closing(self._connection_factory()) as conn:
                check()
                attempted = writing
                value = operation(conn, check)
            check()
            return value
        except (_AuthorizationFailure, analysis._GuardFailure, repo.MachineFault, analysis._Fault):
            raise
        except Exception:
            raise _LocalOperationFailure(attempted=attempted) from None

    def read_source(self, *, before_read: Callable) -> dict:
        return self._perform(lambda conn, _check: repo.read_source_local(conn), before_read)

    def prepare_cache(self, request: MachineCachePrepare, *, before_commit: Callable) -> dict:
        return self._perform(lambda conn, check: cache_repo.prepare_cache_local(
            conn, request, before_commit=check), before_commit, writing=True)

    def cache_receipt(self, day, request_id, request_hash, *, before_read: Callable) -> dict:
        return self._perform(lambda conn, check: cache_repo.read_cache_receipt_local(
            conn, day, request_id, request_hash, before_read=check), before_read)

    def ingest_evidence(self, request: MachineEvidence, *, before_commit: Callable) -> dict:
        return self._perform(lambda conn, check: evidence_repo.ingest_evidence_local(
            conn, request, before_commit=check), before_commit, writing=True)

    def evidence_receipt(self, day, request_id, request_hash, *, before_read: Callable) -> dict:
        return self._perform(lambda conn, check: evidence_repo.read_evidence_receipt_local(
            conn, day, request_id, request_hash, before_read=check), before_read)

    def prepare_task(self, request: MachinePrepare, *, before_commit: Callable) -> dict:
        return self._perform(lambda conn, check: repo.prepare_local(
            conn, request, before_commit=check), before_commit, writing=True)

    def claim_task(self, request: MachineClaim, *, before_commit: Callable) -> dict:
        return self._perform(lambda conn, check: repo.claim_local(
            conn, request, before_commit=check), before_commit, writing=True)

    def finish_task(self, request: MachineFinish, *, before_commit: Callable) -> dict:
        return self._perform(lambda conn, check: repo.finish_local(
            conn, request, before_commit=check), before_commit, writing=True)

    def read_status(self, day, *, before_read: Callable) -> dict:
        return self._perform(lambda conn, _check: repo.read_status_local(conn, day), before_read)


def build_owner_machine_router(connection_factory: Callable) -> APIRouter:
    """Keep main's existing local-only factory and zero-I/O construction."""
    return build_owner_machine_repository_router(LocalOwnerMachineRepository(connection_factory))


def build_owner_machine_repository_router(repository: OwnerMachineRepository) -> APIRouter:
    """Bind only the closed Worker/Admin business capabilities."""
    router = APIRouter(prefix="/api/v2/worker/portfolio", tags=["owner-machine-candidate"])

    async def execute(authority, operation, *, writing=False):
        _revalidate(authority)
        def call():
            try:
                _revalidate(authority)
                return operation(lambda: _revalidate(authority))
            except _AuthorizationFailure:
                raise
            except analysis._GuardFailure as error:
                if isinstance(error.original, _AuthorizationFailure):
                    raise error.original from None
                raise _error(503, "machine_result_unknown" if writing else "machine_storage_unavailable") from None
            except repo.MachineFault as error:
                raise _error(error.status, error.code) from None
            except analysis._Fault as error:
                raise _error(error.status, error.code) from None
            except _LocalOperationFailure as error:
                raise _error(503, "machine_result_unknown" if error.attempted else "machine_storage_unavailable") from None
            except Exception:
                raise _error(503, "machine_result_unknown" if writing else "machine_storage_unavailable") from None
        value = await run_in_threadpool(call)
        _revalidate(authority)
        return Response(analysis._json(value), media_type="application/json", headers=PRIVATE_HEADERS)

    @router.get("/source")
    async def source(request: Request, authority=Depends(_authorize)):
        if request.query_params:
            raise _error(422, "invalid_machine_query")
        return await execute(authority, lambda check: repository.read_source(before_read=check))

    def parsed(raw, model, *, max_bytes=MAX_BODY_BYTES):
        try:
            return parse_machine_input(raw, model, max_body_bytes=max_bytes)
        except Exception:
            raise _error(422, "invalid_machine_request") from None

    @router.post("/cache/prepare")
    async def prepare_cache(request: Request, authority=Depends(_authorize)):
        try:
            value = parse_cache_prepare(await _body(request))
        except (ValueError, UnicodeError, OverflowError, RecursionError):
            raise _error(422, "invalid_machine_cache_request") from None
        # Explicit operational preparation only: never startup, /source,
        # an automatic Worker fallback, or a network call inside a DB txn.
        return await execute(authority, lambda check: repository.prepare_cache(value, before_commit=check), writing=True)

    @router.get("/cache/requests/{request_id}")
    async def cache_receipt(request_id: str, request: Request, authority=Depends(_authorize)):
        values = request.query_params
        if (set(values) != {"occurrence_date", "request_hash"} or len(values.multi_items()) != 2
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}", request_id)
                or not re.fullmatch(r"[0-9a-f]{64}", values.get("request_hash", ""))):
            raise _error(422, "invalid_machine_query")
        try:
            day = MachineInput(occurrence_date=values["occurrence_date"]).occurrence_date
        except Exception:
            raise _error(422, "invalid_machine_occurrence") from None
        return await execute(authority, lambda check: repository.cache_receipt(
            day, request_id, values["request_hash"], before_read=check))

    @router.post("/evidence")
    async def evidence(request: Request, authority=Depends(_authorize)):
        value = parsed(await _body(request, max_bytes=MAX_EVIDENCE_BODY_BYTES), MachineEvidence,
                       max_bytes=MAX_EVIDENCE_BODY_BYTES)
        return await execute(authority, lambda check: repository.ingest_evidence(value, before_commit=check), writing=True)

    @router.get("/evidence/{request_id}")
    async def evidence_receipt(request_id: str, request: Request, authority=Depends(_authorize)):
        values = request.query_params
        if (set(values) != {"occurrence_date", "request_hash"} or len(values.multi_items()) != 2
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}", request_id)
                or not re.fullmatch(r"[0-9a-f]{64}", values.get("request_hash", ""))):
            raise _error(422, "invalid_machine_query")
        try:
            day = MachineInput(occurrence_date=values["occurrence_date"]).occurrence_date
        except Exception:
            raise _error(422, "invalid_machine_occurrence") from None
        return await execute(authority, lambda check: repository.evidence_receipt(
            day, request_id, values["request_hash"], before_read=check))

    @router.post("/tasks/prepare")
    async def prepare(request: Request, authority=Depends(_authorize)):
        value = parsed(await _body(request), MachinePrepare)
        return await execute(authority, lambda check: repository.prepare_task(value, before_commit=check), writing=True)

    @router.post("/tasks/claim")
    async def claim(request: Request, authority=Depends(_authorize)):
        value = parsed(await _body(request), MachineClaim)
        return await execute(authority, lambda check: repository.claim_task(value, before_commit=check), writing=True)

    @router.post("/tasks/finish")
    async def finish(request: Request, authority=Depends(_authorize)):
        value = parsed(await _body(request), MachineFinish)
        return await execute(authority, lambda check: repository.finish_task(value, before_commit=check), writing=True)

    @router.get("/tasks/{occurrence_date}")
    async def status(occurrence_date: str, request: Request, authority=Depends(_authorize)):
        if request.query_params:
            raise _error(422, "invalid_machine_query")
        try:
            MachineInput(occurrence_date=occurrence_date)
        except Exception:
            raise _error(422, "invalid_machine_occurrence") from None
        return await execute(authority, lambda check: repository.read_status(occurrence_date, before_read=check))

    return router
