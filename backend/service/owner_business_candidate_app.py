"""Explicit full-business cloud candidate; never imported by the normal app.

This composition grants no migration, delivery or release qualification. All
storage capabilities are bound to the caller's explicit URL/token; constructing
or starting the app does not open storage, discover credentials or alter schema.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from service.owner_analysis import build_owner_analysis_repository_router
from service.owner_machine import build_owner_machine_repository_router
from service.owner_policy import build_owner_policy_repository_router
from service import owner_sessions
from service.owner_sync import build_owner_sync_repository_router
from service.turso_business_engine import TursoBusinessEngine


PRIVATE_HEADERS = {
    "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff",
}


def create_turso_owner_business_candidate_app(
    url: str, token: str, *, timeout_seconds: float = 8.0, operation_seconds: float = 30.0,
) -> FastAPI:
    """Bind the closed complete profile with explicit credentials, zero I/O.

    Fixed CORS matches the normal application, not a caller-defined origin or
    privilege grant. Browser sessions remain process-local: one API process is
    required. There is no lifespan migration, default connection or sender.
    """
    engine = TursoBusinessEngine(
        url, token, timeout_seconds=timeout_seconds, operation_seconds=operation_seconds,
    )
    app = FastAPI(title="司南基金 complete business cloud candidate", version="8.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173", "http://127.0.0.1:5173", "https://aureliuswu.github.io",
        ],
        allow_methods=["*"],
        allow_headers=[
            "Authorization", "Content-Type", "X-Owner-Sync-Consent", "X-Owner-Sync-Request-Hash",
            "X-Owner-Analysis-Consent", "X-Owner-Analysis-Request-Hash",
        ],
    )
    app.include_router(owner_sessions.router)
    app.include_router(build_owner_sync_repository_router(engine.sync))
    app.include_router(build_owner_analysis_repository_router(engine.analysis))
    app.include_router(build_owner_policy_repository_router(engine.policy))
    app.include_router(build_owner_machine_repository_router(engine.machine))

    @app.middleware("http")
    async def private_response_cache_policy(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(("/api/v2/private/", "/api/v2/owner/", "/api/v2/worker/portfolio/")):
            for name, value in PRIVATE_HEADERS.items():
                response.headers[name] = value
        return response

    return app
