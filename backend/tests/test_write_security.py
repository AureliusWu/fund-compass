import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

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
    calls = 0

    def decide(items, value):
        nonlocal calls
        calls += 1
        return {
            "decisions": [{"code": "510300", "action": "持有", "summary": f"首次结果-{calls}"}],
            "errors": [], "total": len(items), "allocation": {}, "rebalance": [],
        }

    monkeypatch.setattr(main, "decide_portfolio", decide)
    payload = {"request_id": "2026-07-11-14:30", "items": [{"code": "510300"}]}
    request = PortfolioDecisionRequest(**payload)
    first = main.portfolio_decisions(request, "worker")
    second = main.portfolio_decisions(request, "worker")
    assert first["duplicate"] is False
    assert second["duplicate"] is True
    assert second["decisions"] == first["decisions"]
    assert second["decisions"][0]["summary"] == "首次结果-1"
    assert second["total"] == 1
    assert calls == 1

    conflicting = PortfolioDecisionRequest(**{
        "request_id": payload["request_id"],
        "items": [{"code": "159915"}],
    })
    with pytest.raises(HTTPException) as error:
        main.portfolio_decisions(conflicting, "worker")
    assert error.value.status_code == 409


def test_portfolio_endpoint_preserves_validated_estimate_context(monkeypatch):
    captured = {}

    def decide(items, value):
        captured["items"] = items
        return {"decisions": [], "errors": [], "total": 0, "allocation": {}, "rebalance": []}

    monkeypatch.setattr(main, "decide_portfolio", decide)
    request = PortfolioDecisionRequest(**{
        "items": [{
            "code": "510300",
            "estimate_context": {
                "status": "modeled",
                "source": "eastmoney_holdings_model",
                "kind": "holdings_model",
                "source_time": "2026-08-12T10:00:37+08:00",
                "source_time_precision": "datetime",
                "estimate_change": 1.46,
                "estimate_nav": 3.501,
                "base_nav": 3.4509,
                "base_nav_date": "2026-08-11",
                "value_nav": 3.501,
                "value_date": "2026-08-12",
                "model_coverage": 83.47,
                "model_quote_count": 10,
                "model_report_date": "2026-06-30",
                "model_oldest_quote_time": "2026-08-12T09:59:50+08:00",
                "model_newest_quote_time": "2026-08-12T10:00:37+08:00",
                "model_rejected_count": 0,
                "is_fallback": True,
                "fallback_reason": "schema_invalid",
                "diagnostics": {
                    "primary_reason": "schema_invalid", "source_time_precision": "datetime",
                },
            },
        }],
    })

    main.portfolio_decisions(request, "worker")

    context = captured["items"][0]["estimate_context"]
    assert context["kind"] == "holdings_model"
    assert context["model_coverage"] == 83.47
    assert context["source_time_precision"] == "datetime"
    assert context["diagnostics"]["primary_reason"] == "schema_invalid"
    assert context["diagnostics"]["rejected"] == {}


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
        assert conn.execute("SELECT COUNT(*) FROM idempotency_responses").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM decision_history").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM portfolio_decision_history").fetchone()[0] == 0
    finally:
        conn.close()

    retried = main.portfolio_decisions(request, "worker")
    assert retried["duplicate"] is False
    assert attempts == 2
    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT state,response_json FROM idempotency_responses WHERE endpoint=?",
            ("legacy_portfolio_decisions",),
        ).fetchone()
        assert row["state"] == "complete"
        assert row["response_json"] is not None
        assert conn.execute("SELECT COUNT(*) FROM decision_history").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM portfolio_decision_history").fetchone()[0] == 1
    finally:
        conn.close()


def test_public_watchlist_compatibility_route_fails_closed(monkeypatch):
    monkeypatch.setattr(repo, "list_watchlist", lambda: ["510300"])
    with pytest.raises(HTTPException) as error:
        main.get_watchlist()
    assert error.value.status_code == 403


def test_anonymous_fund_force_query_cannot_bypass_repository_ttl(monkeypatch):
    force_values = []

    def detail(code, *, force=False):
        force_values.append(force)
        return {"code": code, "name": "测试基金", "type": "指数型", "nav_history": []}

    monkeypatch.setattr(repo, "get_detail", detail)
    response = TestClient(main.app).get("/api/fund/510300?force=true")

    assert response.status_code == 200
    assert response.json()["code"] == "510300"
    assert force_values == [False]


def test_public_fund_error_does_not_echo_upstream_detail(monkeypatch):
    secret_detail = "private-upstream-url?token=do-not-leak"
    monkeypatch.setattr(repo, "get_detail", lambda code, *, force=False: (_ for _ in ()).throw(RuntimeError(secret_detail)))

    response = TestClient(main.app).get("/api/fund/510300")

    assert response.status_code == 404
    assert response.json() == {"detail": "基金数据暂不可用"}
    assert secret_detail not in response.text


def test_rate_limit_is_bounded(monkeypatch):
    monkeypatch.setattr("service.security.MAX_REQUESTS", 2)
    require_admin("Bearer admin-test-token")
    require_admin("Bearer admin-test-token")
    with pytest.raises(HTTPException) as error:
        require_admin("Bearer admin-test-token")
    assert error.value.status_code == 429
