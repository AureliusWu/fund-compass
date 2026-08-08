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
    decisions = [{"code": "510300", "action": "持有", "summary": "维持计划"}]
    monkeypatch.setattr(main, "decide_portfolio", lambda items, value: {
        "decisions": decisions, "errors": [], "total": len(items), "allocation": {}, "rebalance": [],
    })
    payload = {"request_id": "2026-07-11-14:30", "items": [{"code": "510300"}]}
    request = PortfolioDecisionRequest(**payload)
    first = main.portfolio_decisions(request, "worker")
    second = main.portfolio_decisions(request, "worker")
    assert first["duplicate"] is False
    assert second["duplicate"] is True
    assert second["decisions"] == decisions
    assert second["total"] == 1


def test_failed_persistence_releases_claim_and_retry_completes_missing_write(monkeypatch):
    decision = {
        "code": "510300", "name": "测试基金", "type": "指数型",
        "as_of_date": "2026-08-08", "as_of_nav": 1.0,
        "action": "持有", "confidence": "中", "methodology": {},
    }
    monkeypatch.setattr(main, "decide_portfolio", lambda items, value: {
        "decisions": [decision], "errors": [], "total": 1,
        "allocation": {}, "rebalance": [],
    })
    monkeypatch.setattr(main, "registry_summary", lambda: {"active": {"version": "retry-v1"}})
    original_record_portfolio = repo.record_portfolio_decision
    attempts = 0

    def flaky_record_portfolio(items, decisions, version):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("组合快照写入失败")
        return original_record_portfolio(items, decisions, version)

    monkeypatch.setattr(repo, "record_portfolio_decision", flaky_record_portfolio)
    request = PortfolioDecisionRequest(**{
        "request_id": "2026-08-08-14:30",
        "items": [{"code": "510300", "current_weight": 10, "target_weight": 10}],
    })

    with pytest.raises(RuntimeError, match="组合快照写入失败"):
        main.portfolio_decisions(request, "worker")

    from database import db
    conn = db.get_conn()
    try:
        assert conn.execute("SELECT COUNT(*) FROM idempotency_requests").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM decision_history").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM portfolio_decision_history").fetchone()[0] == 0
    finally:
        conn.close()

    retried = main.portfolio_decisions(request, "worker")
    assert retried["duplicate"] is False
    assert attempts == 2
    conn = db.get_conn()
    try:
        assert conn.execute("SELECT COUNT(*) FROM idempotency_requests").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM decision_history").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM portfolio_decision_history").fetchone()[0] == 1
    finally:
        conn.close()


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
