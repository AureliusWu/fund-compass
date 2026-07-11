import pytest
from fastapi import HTTPException

import main
from models.api import PortfolioDecisionRequest
from service import repo
from service.security import require_admin, require_worker_or_admin, reset_rate_limits


@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    from database import db
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "security.db"))
    db.init_db()
    monkeypatch.setenv("ADMIN_TOKEN", "admin-test-token")
    monkeypatch.setenv("WORKER_TOKEN", "worker-test-token")
    reset_rate_limits()


def test_write_auth_rejects_missing_and_wrong_credentials():
    for credential in (None, "Bearer wrong"):
        with pytest.raises(HTTPException) as error:
            require_admin(credential)
        assert error.value.status_code == 401


def test_admin_and_worker_permissions():
    assert require_admin("Bearer admin-test-token") == "admin"
    assert require_worker_or_admin("Bearer admin-test-token") == "admin"
    assert require_worker_or_admin("Bearer worker-test-token") == "worker"
    with pytest.raises(HTTPException) as error:
        require_admin("Bearer worker-test-token")
    assert error.value.status_code == 401


def test_portfolio_request_id_is_idempotent(monkeypatch):
    monkeypatch.setattr(main, "decide_portfolio", lambda items, value: {
        "decisions": [], "errors": [], "total": len(items), "allocation": {}, "rebalance": [],
    })
    payload = {"request_id": "2026-07-11-14:30", "items": [{"code": "510300"}]}
    request = PortfolioDecisionRequest(**payload)
    first = main.portfolio_decisions(request, "worker")
    second = main.portfolio_decisions(request, "worker")
    assert first["duplicate"] is False
    assert second["duplicate"] is True


def test_public_read_function_stays_unprotected(monkeypatch):
    monkeypatch.setattr(repo, "list_watchlist", lambda: [])
    assert main.get_watchlist() == {"items": []}


def test_rate_limit_is_bounded(monkeypatch):
    monkeypatch.setattr("service.security.MAX_REQUESTS", 2)
    require_admin("Bearer admin-test-token")
    require_admin("Bearer admin-test-token")
    with pytest.raises(HTTPException) as error:
        require_admin("Bearer admin-test-token")
    assert error.value.status_code == 429
