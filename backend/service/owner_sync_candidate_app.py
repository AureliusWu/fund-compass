"""Explicit Owner-only Turso candidate ASGI composition, never main startup.

This callable is not a migration, deployment switch or persistence proof. It
accepts its database URL/token directly, and creates no connection at import,
construction or ASGI startup. Only a complete schema-table9 + Owner-only profile
is admitted by the existing repository on each operation. Analysis and machine
profiles remain unsupported; no SQL/credential/environment fallback is added.
"""
from __future__ import annotations

from fastapi import FastAPI

from service import owner_sessions as owners
from service.owner_sync import PRIVATE_HEADERS, build_owner_sync_repository_router
from service.owner_sync_turso import MAX_SECONDS, TursoOwnerSyncRepository


def create_turso_owner_sync_candidate_app(
    url: str, token: str, *, timeout_seconds: float = 8.0,
    operation_seconds: float = MAX_SECONDS,
) -> FastAPI:
    """Return a callable candidate with real session/sync routes, and no I/O.

    The normal independent Owner password/session configuration still governs
    login; the database credential is never browser authorization. Sessions and
    limits remain process-local, so a separately authorized deployment must use
    one process. Cross-origin access is intentionally not enabled here.
    """
    repository = TursoOwnerSyncRepository(
        url, token, timeout_seconds=timeout_seconds, operation_seconds=operation_seconds,
    )
    app = FastAPI(title="司南基金 Owner-only 同步候选 API", version="8.0.0")
    app.include_router(owners.router)
    app.include_router(build_owner_sync_repository_router(repository))

    @app.middleware("http")
    async def private_response_cache_policy(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/v2/owner/"):
            for name, value in PRIVATE_HEADERS.items():
                response.headers[name] = value
        return response

    return app
