import pytest
from fastapi import HTTPException

from database import db
from service import security


def test_database_connection_uses_busy_timeout_wal_and_foreign_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "nested" / "sinan.db"))
    monkeypatch.setenv("FUND_DB_TIMEOUT_SECONDS", "0.25")
    db.init_db()

    conn = db.get_conn()
    try:
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 250
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert conn.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
    finally:
        conn.close()


def test_transaction_rolls_back_on_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "rollback.db"))
    db.init_db()

    with pytest.raises(RuntimeError):
        with db.transaction() as conn:
            conn.execute(
                "INSERT INTO watchlist(code, added_at) VALUES (?, ?)",
                ("510300", "now"),
            )
            raise RuntimeError("stop")

    conn = db.get_conn()
    try:
        assert conn.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0] == 0
    finally:
        conn.close()


def test_invalid_timeout_falls_back_to_default(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "fallback.db"))
    monkeypatch.setenv("FUND_DB_TIMEOUT_SECONDS", "not-a-number")
    conn = db.get_conn()
    try:
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == int(
            db.DEFAULT_TIMEOUT_SECONDS * 1000
        )
    finally:
        conn.close()


def test_bearer_is_case_insensitive_and_does_not_store_raw_token(monkeypatch):
    token = "admin-secret-value"
    monkeypatch.setenv("ADMIN_TOKEN", token)
    security.reset_rate_limits()

    assert security.require_admin(f"bearer {token}") == "admin"
    assert token not in " ".join(security._requests.keys())


def test_auth_and_rate_limit_return_protocol_headers(monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", "admin-token")
    monkeypatch.setattr(security, "MAX_REQUESTS", 1)
    security.reset_rate_limits()

    with pytest.raises(HTTPException) as unauthorized:
        security.require_admin(None)
    assert unauthorized.value.status_code == 401
    assert unauthorized.value.headers == {"WWW-Authenticate": "Bearer"}

    security.require_admin("Bearer admin-token")
    with pytest.raises(HTTPException) as limited:
        security.require_admin("Bearer admin-token")
    assert limited.value.status_code == 429
    assert int(limited.value.headers["Retry-After"]) >= 1
