from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import main
from models.api import (
    EstimateContext,
    V8DecisionBatchRequest,
    V8NotificationEventRequest,
    V8OutcomeSettleRequest,
    V8PolicyRequest,
)


@pytest.fixture(autouse=True)
def isolated_v8_api_db(tmp_path, monkeypatch):
    from database import db

    fixed_now = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "v8-api.db"))
    monkeypatch.setattr(
        main.v8_decisions,
        "_now",
        lambda: fixed_now,
    )
    db.init_db()
    main.v8_repo.ensure_default_policy(fixed_now)


def official_context():
    return {
        "status": "latest_official",
        "source": "official-test",
        "kind": "official_nav",
        "source_time": "2026-08-22",
        "source_time_precision": "date",
        "is_fallback": True,
        "fallback_reason": "intraday_unavailable",
        "estimate_change": None,
        "estimate_nav": None,
        "base_nav": None,
        "base_nav_date": None,
        "value_nav": 1.0,
        "nav_date": "2026-08-22",
        "diagnostics": {
            "primary_reason": "intraday_unavailable",
            "source_time_precision": "date",
        },
    }


def fake_detail(sample_detail, code="510300"):
    return {
        **sample_detail,
        "code": code,
        "name": f"测试{code}",
        "type": "指数型",
        "latest_nav": 1.0,
        "latest_nav_date": "2026-08-22",
        "source": "test",
        "updated_at": "2026-08-25T06:00:00+00:00",
    }


def test_openapi_exposes_additive_v2_contracts():
    paths = main.app.openapi()["paths"]
    assert {
        "/api/v2/fund/{code}/evidence",
        "/api/v2/fund/{code}/decision",
        "/api/v2/fund/{code}/decision/diff",
        "/api/v2/fund/{code}/outcomes",
        "/api/v2/watchlist/decisions",
        "/api/v2/portfolio/decisions",
        "/api/v2/portfolio/rebalance",
        "/api/v2/portfolio/outcomes",
        "/api/v2/portfolio/outcomes/settle",
        "/api/v2/portfolio/policy",
        "/api/v2/portfolio/policy/history",
        "/api/v2/strategy/registry",
        "/api/v2/strategy/{version}/performance",
        "/api/v2/strategy/candidates",
        "/api/v2/outcomes/settle",
    } <= set(paths)
    assert main.app.version == "8.0.0"


def test_v2_batch_does_not_convert_missing_target_weight_to_zero(sample_detail, monkeypatch):
    monkeypatch.setattr(main.repo, "get_detail", lambda code: fake_detail(sample_detail, code))
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    request = V8DecisionBatchRequest.model_validate({
        "items": [{
            "code": "510300",
            "holding": {"is_held": False, "source": "test"},
            "estimate_context": official_context(),
        }],
    })

    result = main.v8_portfolio_decisions(request, "worker")

    assert result["total"] == 1
    assert result["complete"] is False
    assert result["allocation"]["current_total"] is None
    assert result["allocation"]["target_total"] is None
    assert result["allocation"]["target_cash"] is None
    assert result["allocation"]["missing_target_weights"] == ["510300"]


def test_v2_portfolio_theme_overweight_is_explicit_and_not_normalized(sample_detail, monkeypatch):
    monkeypatch.setattr(main.repo, "get_detail", lambda code: fake_detail(sample_detail, code))
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    request = V8DecisionBatchRequest.model_validate({
        "items": [
            {
                "code": "510300",
                "theme": "科技",
                "holding": {"is_held": True, "current_weight": 35, "target_weight": 30, "source": "test"},
                "estimate_context": official_context(),
            },
            {
                "code": "159915",
                "theme": "科技",
                "holding": {"is_held": True, "current_weight": 30, "target_weight": 25, "source": "test"},
                "estimate_context": official_context(),
            },
        ],
    })

    result = main.v8_portfolio_decisions(request, "worker")

    assert result["allocation"]["complete"] is True
    assert result["allocation"]["current_total"] == 65
    assert result["allocation"]["theme_weights"] == {"科技": 65}
    assert result["allocation"]["theme_overweights"] == [
        {"theme": "科技", "current_weight": 65.0, "limit": 60.0},
    ]
    assert result["allocation"]["status"] == "needs_review"


def test_v2_portfolio_rejects_total_weight_above_100(sample_detail, monkeypatch):
    monkeypatch.setattr(main.repo, "get_detail", lambda code: fake_detail(sample_detail, code))
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    request = V8DecisionBatchRequest.model_validate({
        "items": [
            {
                "code": "510300",
                "holding": {
                    "is_held": True,
                    "current_weight": 60,
                    "target_weight": 30,
                    "source": "test",
                },
                "estimate_context": official_context(),
            },
            {
                "code": "159915",
                "holding": {
                    "is_held": True,
                    "current_weight": 50,
                    "target_weight": 30,
                    "source": "test",
                },
                "estimate_context": official_context(),
            },
        ],
    })

    with pytest.raises(HTTPException) as error:
        main.v8_portfolio_decisions(request, "worker")

    assert error.value.status_code == 422
    assert "cannot exceed 100%" in str(error.value.detail)
    assert main.v8_repo.portfolio_decision_snapshots() == []


def test_v2_request_id_replays_original_snapshot_response(sample_detail, monkeypatch):
    monkeypatch.setattr(main.repo, "get_detail", lambda code: fake_detail(sample_detail, code))
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    payload = {
        "request_id": "natural-2026-08-25-1430",
        "items": [{
            "code": "510300",
            "holding": {"is_held": False, "target_weight": 20, "source": "worker"},
            "estimate_context": official_context(),
        }],
    }
    request = V8DecisionBatchRequest.model_validate(payload)

    first = main.v8_portfolio_decisions(request, "worker")
    second = main.v8_portfolio_decisions(request, "worker")

    assert first["duplicate"] is False
    assert second["duplicate"] is True
    assert second["decisions"] == first["decisions"]
    assert second["decisions"][0]["decision"]["decision_id"] == first["decisions"][0]["decision"]["decision_id"]
    changed = V8DecisionBatchRequest.model_validate({
        **payload,
        "items": [{
            **payload["items"][0],
            "holding": {"is_held": False, "target_weight": 30, "source": "worker"},
        }],
    })
    with pytest.raises(HTTPException) as error:
        main.v8_portfolio_decisions(changed, "worker")
    assert error.value.status_code == 409


def test_policy_post_creates_new_version_and_preserves_default():
    default = main.v8_private_portfolio_policy("private_reader")
    request = V8PolicyRequest(
        name="长期配置",
        target_allocations={"510300": 20},
        target_ranges={"510300": (15, 25)},
        max_single_fund_weight=30,
        rebalance_band=3,
        effective_at=datetime(2026, 8, 25, 8, 0, tzinfo=timezone.utc),
    )

    custom = main.v8_post_portfolio_policy(request, "admin")
    history = main.v8_private_portfolio_policy_history("private_reader")

    assert custom["policy_version"] != default["policy_version"]
    assert custom["supersedes"] == default["policy_version"]
    assert history["total"] == 2


def test_qdii_context_requires_exact_valid_target_date():
    context = {
        "status": "modeled", "source": "qdii-test", "kind": "qdii_next_nav_estimate",
        "source_time": "2026-08-25T14:29:00+08:00", "source_time_precision": "datetime",
        "is_fallback": False, "estimate_change": 1.0, "estimate_nav": 1.01,
        "base_nav": 1.0, "base_nav_date": "2026-08-22", "value_nav": 1.01,
        "value_date": "2026-08-25", "target_nav_date": "2026-08-25",
        "market": "overseas", "market_time": "2026-08-25T14:29:00+08:00",
        "estimate_model_version": "US_TEST", "coverage": 85,
        "sample_count": 30, "mae": 0.4, "error_p80": 0.8, "direction_accuracy": 62,
        "diagnostics": {"source_time_precision": "datetime"},
    }
    assert EstimateContext.model_validate(context).target_nav_date == "2026-08-25"
    with pytest.raises(ValidationError, match="target_nav_date"):
        EstimateContext.model_validate({**context, "target_nav_date": "2026-02-30"})
    with pytest.raises(ValidationError, match="误差或不确定性"):
        EstimateContext.model_validate({
            **context,
            "sample_count": 0,
            "mae": None,
            "error_p80": None,
        })


def test_unheld_contract_rejects_positive_weight():
    with pytest.raises(ValidationError, match="未持有"):
        V8DecisionBatchRequest.model_validate({
            "items": [{"code": "510300", "holding": {"is_held": False, "current_weight": 5}}],
        })


def test_v2_public_gets_only_read_existing_snapshots(sample_detail, monkeypatch):
    from database import db

    monkeypatch.setattr(main.repo, "get_detail", lambda code: fake_detail(sample_detail, code))
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    created = main.v8_portfolio_decisions(V8DecisionBatchRequest.model_validate({
        "items": [{
            "code": "510300",
            "holding": {"is_held": False, "target_weight": 20, "source": "worker"},
            "estimate_context": official_context(),
        }],
    }), "worker")
    conn = db.get_conn()
    try:
        before = {
            table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("evidence_snapshots", "holding_versions", "decision_snapshots", "outcome_evaluations")
        }
    finally:
        conn.close()

    evidence = main.v8_private_fund_evidence("510300", "private_reader")
    decision = main.v8_private_fund_decision("510300", "private_reader")
    diff = main.v8_private_fund_decision_diff("510300", "private_reader")
    outcomes = main.v8_private_fund_outcomes("510300", "private_reader")

    assert evidence["evidence_id"] == created["decisions"][0]["evidence"]["evidence_id"]
    assert decision["decision"]["decision_id"] == created["decisions"][0]["decision"]["decision_id"]
    assert diff["current_decision_id"] == decision["decision"]["decision_id"]
    assert outcomes["items"][0]["pending_horizons"] == []
    assert outcomes["items"][0]["unavailable_horizons"] == [5, 20, 60]
    assert main.v8_fund_evidence("510300") == {
        "fund_code": "510300", "available": False, "redacted": True,
    }
    assert main.v8_fund_decision("510300") == {
        "code": "510300", "available": False, "redacted": True,
    }
    conn = db.get_conn()
    try:
        after = {
            table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in before
        }
    finally:
        conn.close()
    assert after == before


def test_notification_attempt_is_an_atomic_transport_claim(sample_detail, monkeypatch):
    monkeypatch.setattr(main.repo, "get_detail", lambda code: fake_detail(sample_detail, code))
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    created = main.v8_portfolio_decisions(V8DecisionBatchRequest.model_validate({
        "items": [{
            "code": "510300",
            "holding": {"is_held": False, "target_weight": 20, "source": "worker"},
            "estimate_context": official_context(),
        }],
    }), "worker")
    decision_id = created["decisions"][0]["decision"]["decision_id"]
    common = {
        "decision_ids": [decision_id],
        "scheduled_window": "2026-08-25T14:30+08:00",
        "natural_schedule": True,
        "occurred_at": datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc),
    }
    main.v8_notification_events(V8NotificationEventRequest(
        **common, status="scheduled", attempt_no=0,
    ), "worker")
    first = main.v8_notification_events(V8NotificationEventRequest(
        **common, status="attempted", attempt_no=1,
    ), "worker")
    duplicate = main.v8_notification_events(V8NotificationEventRequest(
        **common, status="attempted", attempt_no=1,
    ), "worker")

    assert first["events"][0]["claimed"] is True
    assert first["events"][0]["duplicate"] is False
    assert duplicate["events"][0]["claimed"] is False
    assert duplicate["events"][0]["duplicate"] is True


def test_protected_outcome_settlement_has_bounded_response():
    result = main.v8_settle_outcomes(V8OutcomeSettleRequest(), "worker")
    assert result == {"settled": 0, "pending": 0, "errors": []}
