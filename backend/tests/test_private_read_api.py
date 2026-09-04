"""Real ASGI tests for the public/private financial-data boundary."""
from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient

import main
from models.v8 import (
    DecisionDiff,
    DecisionSnapshot,
    EvidenceSnapshot,
    HoldingVersion,
    OutcomeEvaluation,
    PortfolioDecisionComponent,
    PortfolioDecisionSnapshot,
    PortfolioOutcomeComponent,
    PortfolioOutcomeEvaluation,
    PortfolioPolicy,
    PositionGuidance,
)


NOW = datetime(2026, 8, 29, 6, 30, tzinfo=timezone.utc)
PRIVATE_TOKEN = "private-read-test-token"


def _id(prefix: str, value: str) -> str:
    return f"{prefix}_{value * 64}"


@pytest.fixture
def private_records(monkeypatch):
    evidence = EvidenceSnapshot(
        evidence_id=_id("ev", "a"),
        fund_code="510300",
        fund_name="测试沪深300",
        fund_type="指数型",
        created_at=NOW,
        official_nav=1.0,
        official_nav_date=date(2026, 8, 28),
        score=80,
        score_version="score-v1",
        score_coverage=1,
        timing_signal="持有",
        timing_coverage=1,
        estimate_status="latest_official",
        evidence_strength=80,
    )
    holding = HoldingVersion(
        holding_version=_id("hold", "b"),
        fund_code="510300",
        user_state="held",
        shares=12_345.67,
        cost=0.8765,
        market_value=98_765.43,
        account="不可公开账户",
        current_weight=37.25,
        target_weight=25.5,
        updated_at=NOW,
        source="private-test",
        created_at=NOW,
    )
    policy = PortfolioPolicy(
        policy_version=_id("pol", "c"),
        name="私人配置",
        target_allocations={"510300": 25.5},
        target_ranges={"510300": (20.0, 30.0)},
        max_single_fund_weight=35,
        effective_at=NOW,
        created_at=NOW,
        source="private-test",
    )
    decision = DecisionSnapshot(
        decision_id=_id("dec", "d"),
        evidence_id=evidence.evidence_id,
        fund_code=evidence.fund_code,
        holding_version=holding.holding_version,
        policy_version=policy.policy_version,
        strategy_version="v8-test",
        user_state="held",
        action="reduce",
        strength=70,
        confidence=80,
        summary="当前建议：减仓。",
        reason_codes=["ACTION_REDUCE", "POSITION_OVERWEIGHT", "SCORE_SUFFICIENT"],
        reasons=["当前仓位高于目标区间或单基金上限", "综合评分 80"],
        risks=["系统只提供数据辅助决策，不执行真实交易"],
        invalidation_codes=["VALUATION_NORMALIZES", "DATA_DEGRADES"],
        invalidation_conditions=["估值回落后复核", "数据质量下降时暂停动作"],
        position_guidance=PositionGuidance(
            current_weight=37.25,
            target_weight=25.5,
            target_range=(20.0, 30.0),
            suggested_change=-5.0,
            suggested_range=(30.0, 32.25),
            method="分批降低到目标区间",
            amount=13_257.1,
            precise=True,
        ),
        evidence_nodes=[
            {
                "node_id": "quality",
                "category": "quality",
                "state": "support",
                "label": "综合评分 80",
                "value": 80,
                "source_id": evidence.evidence_id,
            },
            {
                "node_id": "holding_position",
                "category": "holding",
                "state": "constraint",
                "label": "当前仓位 37.25%，目标区间 20.00%–30.00%",
                "value": 37.25,
                "source_id": holding.holding_version,
            },
        ],
        created_at=NOW,
    )
    diff = DecisionDiff(
        previous_decision_id=_id("dec", "e"),
        current_decision_id=decision.decision_id,
        previous_action="hold",
        current_action="reduce",
        changed=True,
        drivers=["动作从持有变为减仓", "当前仓位从 30.0% 变为 37.25%"],
        driver_codes=["ACTION_CHANGED", "CURRENT_WEIGHT_CHANGED"],
        unchanged=["综合评分基本不变", "目标仓位维持 25.5%"],
    )
    bundle = {
        "decision": decision,
        "evidence": evidence,
        "holding": holding,
        "policy": policy,
        "diff": diff,
    }
    fund_outcome = OutcomeEvaluation(
        outcome_id=_id("out", "f"),
        decision_id=decision.decision_id,
        evaluation_kind="horizon",
        horizon=5,
        base_nav_date=date(2026, 8, 25),
        evaluation_date=date(2026, 8, 28),
        base_nav=1.0,
        evaluated_nav=1.03,
        absolute_return=3.0,
        max_drawdown=-1.0,
        hit=True,
        created_at=NOW,
    )
    fund_outcomes = {
        "fund_code": "510300",
        "total": 1,
        "items": [{
            "decision": decision.model_dump(mode="json"),
            "outcomes": [fund_outcome.model_dump(mode="json")],
            "pending_horizons": [20, 60],
            "unavailable_horizons": [],
            "qdii_target_pending": False,
        }],
    }
    components = [
        PortfolioDecisionComponent(
            fund_code="510300",
            fund_name="测试沪深300",
            decision_id=decision.decision_id,
            evidence_id=evidence.evidence_id,
            holding_version=holding.holding_version,
            action="reduce",
            theme="宽基",
            current_weight=60,
            target_weight=50,
        ),
        PortfolioDecisionComponent(
            fund_code="159915",
            fund_name="测试创业板",
            decision_id=_id("dec", "1"),
            evidence_id=_id("ev", "2"),
            holding_version=_id("hold", "3"),
            action="hold",
            theme="成长",
            current_weight=30,
            target_weight=40,
        ),
    ]
    portfolio_decision = PortfolioDecisionSnapshot(
        portfolio_decision_id=_id("pdec", "4"),
        decision_date=date(2026, 8, 25),
        policy_version=policy.policy_version,
        strategy_version="v8-test",
        components=components,
        current_cash_weight=10,
        target_cash_weight=10,
        portfolio_value=456_789.12,
        source="private-test",
        created_at=NOW,
    )
    outcome_components = [
        PortfolioOutcomeComponent(
            fund_code="510300",
            current_weight=60,
            base_nav=1,
            evaluated_nav=1.1,
            absolute_return=10,
            contribution=6,
        ),
        PortfolioOutcomeComponent(
            fund_code="159915",
            current_weight=30,
            base_nav=1,
            evaluated_nav=0.9,
            absolute_return=-10,
            contribution=-3,
        ),
    ]
    portfolio_outcome = PortfolioOutcomeEvaluation(
        outcome_id=_id("pout", "5"),
        portfolio_decision_id=portfolio_decision.portfolio_decision_id,
        horizon=5,
        base_nav_date=date(2026, 8, 25),
        evaluation_date=date(2026, 8, 28),
        absolute_return=3,
        max_drawdown=-4,
        current_cash_weight=10,
        components=outcome_components,
        created_at=NOW,
    )
    portfolio_outcomes = {
        "total": 1,
        "mature": 1,
        "pending": 0,
        "unavailable": 0,
        "items": [{
            "portfolio_decision": portfolio_decision.model_dump(mode="json"),
            "outcomes": [portfolio_outcome.model_dump(mode="json")],
            "pending_horizons": [],
            "ready_horizons": [],
            "unavailable_horizons": [],
            "available_common_observations": 5,
        }],
    }
    legacy_outcomes = {
        "total": 1,
        "mature": 1,
        "pending": 0,
        "items": [{
            "id": 1,
            "snapshot_date": "2026-08-25",
            "strategy_version": "v7-test",
            "created_at": NOW.isoformat(),
            "items": [{
                "code": "510300",
                "name": "测试沪深300",
                "weight": 1.0,
                "base_nav": 1.0,
                "base_date": "2026-08-25",
                "action": "减仓",
            }],
            "returns": {"20": {"date": "2026-08-28", "return": 3, "components": 1}},
        }],
    }

    monkeypatch.setenv("PRIVATE_READ_TOKEN", PRIVATE_TOKEN)
    monkeypatch.setenv("ADMIN_TOKEN", "admin-test-token")
    monkeypatch.setenv("WORKER_TOKEN", "worker-test-token")
    monkeypatch.setattr(main.v8_repo, "latest_evidence", lambda code: evidence)
    monkeypatch.setattr(main.v8_repo, "latest_decision_bundle", lambda code: bundle)
    monkeypatch.setattr(main.v8_repo, "latest_decision_diff", lambda code: diff)
    monkeypatch.setattr(main.v8_repo, "outcomes_for_fund", lambda code: fund_outcomes)
    monkeypatch.setattr(main.v8_repo, "portfolio_outcomes", lambda limit: portfolio_outcomes)
    monkeypatch.setattr(main.v8_repo, "read_policy", lambda *args, **kwargs: policy)
    monkeypatch.setattr(main.v8_repo, "read_policy_history", lambda: [policy])
    watchlist = [{
        "code": "510300", "name": "测试沪深300", "type": "指数型",
        "added_at": "2026-08-25T00:00:00+00:00",
    }, {
        "code": "159915", "name": None, "type": None,
        "added_at": "2026-08-24T00:00:00+00:00",
    }]
    monkeypatch.setattr(main.repo, "list_watchlist", lambda: watchlist)
    monkeypatch.setattr(main.repo, "portfolio_decision_outcomes", lambda: legacy_outcomes)
    monkeypatch.setattr(main.repo, "decision_outcomes", lambda: {"total": 1, "items": [{"code": "510300"}]})
    monkeypatch.setattr(main.repo, "version_comparison", lambda: {"samples": 1, "private": True})
    monkeypatch.setattr(main.v8_repo, "strategy_performance", lambda version: {"strategy_version": version, "samples": 1})
    monkeypatch.setattr(main.repo, "public_operations_status", lambda: {
        "universe_artifact": None,
        "cache": {"requests": 0, "hits": 0, "hit_rate": None, "oldest_age_hours": None},
        "latest_decision_write": None,
        "latest_result_settlement": None,
        "redacted": True,
    })
    monkeypatch.setattr(main.repo, "operations_status", lambda: {
        "latest_decision_write": "2026-08-25T09:30:00+00:00",
        "latest_result_settlement": "2026-08-28",
        "owner_marker": "private-operations",
        "redacted": False,
    })
    monkeypatch.setattr(main, "registry_summary", lambda: {
        "active": {"version": "private-v1"},
        "candidate": {"owner_marker": "private-candidate"},
        "governance": {"outcome_evidence": {"samples": 1}},
    })
    return {
        "holding": holding,
        "policy": policy,
        "decision": decision,
        "portfolio": portfolio_decision,
    }


@pytest.fixture
def client(private_records, tmp_path, monkeypatch):
    # Keep this ASGI suite independent from the developer's ignored local DB
    # and from whichever database another test used previously.  Entering the
    # client context runs the real application lifespan, including init_db().
    from database import db

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "private-read.db"))
    monkeypatch.setattr(
        main.repo,
        "import_universe_artifact",
        lambda: {"loaded": False, "reason": "isolated-test", "fund_count": 0},
    )
    # Requests travel through FastAPI routing, dependency injection, response
    # validation and JSON serialization; handlers are not called directly.
    with TestClient(main.app) as test_client:
        yield test_client


def _all_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _all_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from _all_keys(item)


def test_clean_client_initializes_health_database_before_first_request(client):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["universe"] == 0
    assert response.json()["universe_ready"] is False


PRIVATE_KEYS = {
    "shares",
    "cost",
    "market_value",
    "account",
    "portfolio_value",
    "current_weight",
    "target_weight",
    "current_cash_weight",
    "target_cash_weight",
    "target_allocations",
    "target_ranges",
    "amount",
    "contribution",
    "cash_contribution",
    "holding_version",
    "user_state",
}

PUBLIC_PORTFOLIO_KEYS = {
    "absolute_return",
    "max_drawdown",
    "snapshot_date",
    "decision_date",
    "base_nav_date",
    "evaluation_date",
    "strategy_version",
    "component_count",
    "available_common_observations",
    "portfolio_decision_id",
}


@pytest.mark.parametrize("path", [
    "/api/v2/fund/510300/decision",
    "/api/v2/fund/510300/decision/diff",
    "/api/v2/fund/510300/outcomes",
    "/api/v2/portfolio/outcomes",
    "/api/v2/portfolio/policy",
    "/api/v2/portfolio/policy/history",
    "/api/strategy/portfolio-outcomes",
    "/api/watchlist",
])
def test_anonymous_public_reads_never_return_private_financial_fields(client, path):
    response = client.get(path)
    assert response.status_code == 403, response.text
    payload = response.json()
    assert payload == {"detail": "私人数据未公开"}
    assert PRIVATE_KEYS.isdisjoint(set(_all_keys(payload)))
    serialized = response.text
    assert "不可公开账户" not in serialized
    assert "当前仓位 37.25" not in serialized


def test_public_decision_fails_closed_for_cached_legacy_clients(client):
    response = client.get("/api/v2/fund/510300/decision")

    assert response.status_code == 403
    assert response.json() == {"detail": "私人数据未公开"}


def test_anonymous_owner_routes_never_query_private_repositories(client, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("anonymous route queried owner-scoped state")

    for name in (
        "latest_evidence", "latest_decision_bundle", "latest_decision_diff",
        "outcomes_for_fund", "portfolio_outcomes", "read_policy",
        "read_policy_history", "strategy_performance",
    ):
        monkeypatch.setattr(main.v8_repo, name, forbidden)
    for name in ("decision_outcomes", "portfolio_decision_outcomes", "version_comparison"):
        monkeypatch.setattr(main.repo, name, forbidden)
    monkeypatch.setattr(main.repo, "operations_status", forbidden)
    monkeypatch.setattr(main, "registry_summary", forbidden)

    paths = [
        "/api/v2/fund/510300/evidence",
        "/api/v2/fund/510300/decision",
        "/api/v2/fund/510300/decision/diff",
        "/api/v2/fund/510300/outcomes",
        "/api/v2/portfolio/policy",
        "/api/v2/portfolio/policy/history",
        "/api/v2/portfolio/outcomes",
        "/api/strategy/portfolio-outcomes",
        "/api/strategy/version-comparison",
        "/api/v2/strategy/decision-v2:test/performance",
        "/api/v2/strategy/registry",
        "/api/v2/strategy/candidates",
        "/api/strategy/registry",
        "/api/strategy/outcomes",
        "/api/watchlist",
    ]
    for path in paths:
        response = client.get(path)
        assert response.status_code == 403, (path, response.text)
        assert response.json() == {"detail": "私人数据未公开"}

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["strategy_registry"] == {"available": False, "redacted": True}
    assert health.json()["operations"]["latest_decision_write"] is None
    assert health.json()["operations"]["latest_result_settlement"] is None


@pytest.mark.parametrize("path", [
    "/api/v2/portfolio/outcomes",
    "/api/strategy/portfolio-outcomes",
])
def test_public_portfolio_outcomes_fail_closed_without_aggregate_side_channels(client, path):
    response = client.get(path)
    payload = response.json()

    assert response.status_code == 403
    assert payload == {"detail": "私人数据未公开"}
    assert PUBLIC_PORTFOLIO_KEYS.isdisjoint(set(_all_keys(payload)))


@pytest.mark.parametrize("path", [
    "/api/v2/private/fund/510300/evidence",
    "/api/v2/private/fund/510300/decision",
    "/api/v2/private/fund/510300/decision/diff",
    "/api/v2/private/fund/510300/outcomes",
    "/api/v2/private/portfolio/outcomes",
    "/api/v2/private/portfolio/policy",
    "/api/v2/private/portfolio/policy/history",
    "/api/private/strategy/portfolio-outcomes",
    "/api/private/strategy/outcomes",
    "/api/private/strategy/version-comparison",
    "/api/private/strategy/registry",
    "/api/private/operations",
    "/api/v2/private/strategy/registry",
    "/api/v2/private/strategy/private-v1/performance",
    "/api/private/watchlist",
])
def test_private_reads_require_the_dedicated_credential(client, path):
    missing = client.get(path)
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"

    assert client.get(path, headers={"Authorization": "Bearer wrong"}).status_code == 403
    assert client.get(path, headers={"Authorization": "Bearer admin-test-token"}).status_code == 403
    assert client.get(path, headers={"Authorization": "Bearer worker-test-token"}).status_code == 403


def test_authorized_private_reads_preserve_lossless_contract(client):
    headers = {"Authorization": f"Bearer {PRIVATE_TOKEN}"}
    evidence = client.get("/api/v2/private/fund/510300/evidence", headers=headers)
    decision = client.get("/api/v2/private/fund/510300/decision", headers=headers)
    diff = client.get("/api/v2/private/fund/510300/decision/diff", headers=headers)
    fund_outcomes = client.get("/api/v2/private/fund/510300/outcomes", headers=headers)
    portfolio = client.get("/api/v2/private/portfolio/outcomes", headers=headers)
    policy = client.get("/api/v2/private/portfolio/policy", headers=headers)
    watchlist = client.get("/api/private/watchlist", headers=headers)
    operations = client.get("/api/private/operations", headers=headers)
    registry = client.get("/api/private/strategy/registry", headers=headers)

    assert evidence.status_code == decision.status_code == diff.status_code == fund_outcomes.status_code == 200
    assert portfolio.status_code == policy.status_code == watchlist.status_code == 200
    assert operations.status_code == registry.status_code == 200
    assert evidence.json()["evidence_id"] == decision.json()["evidence"]["evidence_id"]
    assert diff.json()["current_decision_id"] == decision.json()["decision"]["decision_id"]
    assert fund_outcomes.json()["total"] == 1
    assert decision.json()["holding"]["shares"] == 12_345.67
    assert decision.json()["holding"]["account"] == "不可公开账户"
    assert decision.json()["decision"]["position_guidance"]["current_weight"] == 37.25
    assert portfolio.json()["items"][0]["portfolio_decision"]["portfolio_value"] == 456_789.12
    assert portfolio.json()["items"][0]["portfolio_decision"]["components"][0]["current_weight"] == 60
    assert policy.json()["target_allocations"] == {"510300": 25.5}
    assert [item["code"] for item in watchlist.json()["items"]] == ["510300", "159915"]
    assert watchlist.json()["items"][0]["name"] == "测试沪深300"
    assert operations.json()["operations"]["owner_marker"] == "private-operations"
    assert registry.json()["candidate"]["owner_marker"] == "private-candidate"


def test_private_read_rate_limit_is_separate_and_bounded(client, monkeypatch):
    from service import security

    monkeypatch.setattr(security, "PRIVATE_READ_MAX_REQUESTS", 2)
    security.reset_rate_limits()
    headers = {"Authorization": f"Bearer {PRIVATE_TOKEN}"}
    try:
        assert client.get("/api/private/watchlist", headers=headers).status_code == 200
        assert client.get("/api/private/watchlist", headers=headers).status_code == 200
        limited = client.get("/api/private/watchlist", headers=headers)
        assert limited.status_code == 429
        assert limited.json() == {"detail": "私人读取请求过于频繁"}
        assert int(limited.headers["retry-after"]) >= 1
        assert PRIVATE_TOKEN not in " ".join(security._requests)
    finally:
        security.reset_rate_limits()


@pytest.mark.parametrize("limit", [0, 501, 10_000])
def test_private_portfolio_outcome_limit_has_an_api_boundary(client, limit):
    response = client.get(
        f"/api/v2/private/portfolio/outcomes?limit={limit}",
        headers={"Authorization": f"Bearer {PRIVATE_TOKEN}"},
    )

    assert response.status_code == 422


def test_private_read_fails_closed_when_server_credential_is_unconfigured(client, monkeypatch):
    monkeypatch.delenv("PRIVATE_READ_TOKEN")
    response = client.get(
        "/api/private/watchlist",
        headers={"Authorization": f"Bearer {PRIVATE_TOKEN}"},
    )
    assert response.status_code == 503


def test_private_read_rejects_admin_or_worker_token_reuse(client, monkeypatch):
    monkeypatch.setenv("PRIVATE_READ_TOKEN", "admin-test-token")
    response = client.get(
        "/api/private/watchlist",
        headers={"Authorization": "Bearer admin-test-token"},
    )
    assert response.status_code == 503
    assert "必须彼此隔离" in response.json()["detail"]

    admin_write = client.post(
        "/api/watchlist",
        json={"code": "510300"},
        headers={"Authorization": "Bearer admin-test-token"},
    )
    assert admin_write.status_code == 503

    monkeypatch.setenv("PRIVATE_READ_TOKEN", "worker-test-token")
    worker_read = client.get(
        "/api/v2/notifications/dec_" + "a" * 64,
        headers={"Authorization": "Bearer worker-test-token"},
    )
    assert worker_read.status_code == 503


def test_private_read_token_never_authorizes_write_roles(client):
    headers = {"Authorization": f"Bearer {PRIVATE_TOKEN}"}
    assert client.post("/api/watchlist", json={"code": "510300"}, headers=headers).status_code == 401
    assert client.get("/api/v2/notifications/dec_" + "a" * 64, headers=headers).status_code == 401


def test_openapi_marks_private_contracts_and_fail_closed_public_status():
    schema = main.app.openapi()

    assert schema["components"]["securitySchemes"]["PrivateReadBearer"]["scheme"] == "bearer"
    private_operation = schema["paths"]["/api/v2/private/fund/{code}/decision"]["get"]
    assert private_operation["security"] == [{"PrivateReadBearer": []}]
    public_responses = schema["paths"]["/api/v2/fund/{code}/decision"]["get"]["responses"]
    assert "403" in public_responses
    assert "200" not in public_responses
    assert public_responses["403"]["description"].startswith("Anonymous owner-scoped read denied")
    denied_schema = public_responses["403"]["content"]["application/json"]["schema"]
    assert denied_schema["$ref"].endswith("PublicOwnerReadDenied")
    private_schema = private_operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert private_schema["$ref"].endswith("PrivateV8DecisionResponse")
