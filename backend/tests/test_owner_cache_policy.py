"""Cache/CORS regressions for the single-owner browser boundary."""
from fastapi.testclient import TestClient
import pytest

import main


@pytest.fixture(autouse=True)
def isolated_application_database(tmp_path, monkeypatch):
    from database import db
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "owner-cache.db"))
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "ephemeral")
    monkeypatch.setattr(main.repo, "ensure_universe_artifact", lambda: None)


def test_private_auth_errors_are_never_cacheable(monkeypatch):
    monkeypatch.delenv("PRIVATE_READ_TOKEN", raising=False)
    monkeypatch.delenv("OWNER_PASSWORD_HASH", raising=False)
    with TestClient(main.app, raise_server_exceptions=False) as client:
        for path in (
            "/api/v2/private/fund/510300/decision",
            "/api/private/watchlist",
            "/api/v2/owner/session",
        ):
            response = client.get(path)
            assert response.status_code in (401, 503)
            assert response.headers["cache-control"] == "no-store"
            assert response.headers["pragma"] == "no-cache"
            assert response.headers["x-content-type-options"] == "nosniff"


def test_owner_login_errors_do_not_bypass_cache_policy():
    with TestClient(main.app, raise_server_exceptions=False) as client:
        response = client.post("/api/v2/owner/session", content=b"not-json", headers={
            "Content-Type": "application/json",
        })
        assert response.status_code in (422, 503)
        assert response.headers["cache-control"] == "no-store"
        assert "not-json" not in response.text


def test_cors_allows_explicit_pages_origin_not_arbitrary_origin():
    with TestClient(main.app, raise_server_exceptions=False) as client:
        for origin, allowed in (
            ("https://aureliuswu.github.io", True),
            ("https://untrusted.invalid", False),
        ):
            response = client.options("/api/v2/owner/session", headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            })
            assert (response.headers.get("access-control-allow-origin") == origin) is allowed


@pytest.mark.parametrize("origin", [
    "https://aureliuswu.github.io", "http://localhost:5173", "http://127.0.0.1:5173",
])
@pytest.mark.parametrize("method,headers", [
    ("POST", "authorization,content-type,x-owner-sync-consent"),
    ("GET", "authorization,x-owner-sync-request-hash"),
])
def test_owner_sync_preflight_allows_only_the_closed_browser_headers(monkeypatch, origin, method, headers):
    from database import db
    def forbidden(*_args, **_kwargs):
        pytest.fail("CORS preflight opened configured storage")
    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "_database_file", forbidden)
    client = TestClient(main.app)
    try:
        response = client.options("/api/v2/owner/sync", headers={
            "Origin": origin, "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
        })
    finally:
        client.close()
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-headers"].lower().split(", ") == [
        "accept", "accept-language", "authorization", "content-language", "content-type",
        "x-owner-sync-consent", "x-owner-sync-request-hash",
    ]
    assert "access-control-allow-credentials" not in response.headers
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("origin,headers", [
    ("https://untrusted.invalid", "authorization,x-owner-sync-request-hash"),
    ("https://aureliuswu.github.io", "authorization,x-arbitrary-private-header"),
    ("https://aureliuswu.github.io", "x-forwarded-for"),
])
def test_owner_sync_preflight_rejects_unknown_origins_or_headers(origin, headers):
    # Request routing is exercised without running startup provisioning.
    client = TestClient(main.app)
    try:
        response = client.options("/api/v2/owner/sync", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": headers,
        })
    finally:
        client.close()
    assert response.status_code == 400
    assert "*" not in response.headers["access-control-allow-headers"]
    if origin == "https://untrusted.invalid":
        assert "access-control-allow-origin" not in response.headers
    assert response.headers["cache-control"] == "no-store"
