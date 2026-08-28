from datetime import datetime, timezone

import pytest

from strategy.decision_v2 import (
    build_decision_diff,
    build_decision_snapshot,
    build_evidence_snapshot,
    build_holding_version,
    build_portfolio_policy,
    default_portfolio_policy,
)


T0 = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)
T1 = datetime(2026, 8, 25, 6, 40, tzinfo=timezone.utc)


def make_evidence(
    *,
    score=82.0,
    score_coverage=1.0,
    valuation=20.0,
    trend="上升趋势",
    momentum="中性",
    signal="买入",
    timing_coverage=1.0,
    status="fresh",
    risk_flags=None,
    fund_type="指数型",
    p80=None,
    samples=None,
    target_nav_date=None,
    official_nav_available=True,
    historical_outcome=None,
    created_at=T0,
):
    detail = {
        "code": "510300",
        "name": "测试宽基",
        "type": fund_type,
        "latest_nav": 1.2 if official_nav_available else None,
        "latest_nav_date": "2026-08-22" if official_nav_available else None,
        "source": "fixture",
        "updated_at": "2026-08-25T06:29:00+00:00",
        "risk_flags": risk_flags or [],
        "decision_context": {
            "status": status,
            "kind": "estimate",
            "source": "fixture_quote",
            "source_time": "2026-08-25T14:29:00+08:00",
            "source_time_precision": "datetime",
            "market_time": "2026-08-25T14:29:00+08:00",
            "base_nav": 1.2 if official_nav_available else None,
            "base_nav_date": "2026-08-22" if official_nav_available else None,
            "estimate_change": 0.8,
            "target_nav_date": target_nav_date,
            "error_p80": p80,
            "sample_count": samples,
            "model_version": "test-model" if p80 is not None or samples is not None else None,
        },
    }
    score_result = {
        "score": score,
        "score_version": "score-test",
        "coverage": score_coverage,
        "components": {"risk": {"detail": {"max_drawdown": -12.0, "volatility": 18.0}}},
    }
    valuation_layer = {
        "label": "数据不足" if valuation is None else "低估" if valuation <= 35 else "高估" if valuation >= 70 else "中位",
        "percentile": valuation,
        "source": "index_pe_pb",
    }
    signal_result = {
        "signal": signal,
        "signal_version": "signal-test",
        "coverage": timing_coverage,
        "layers": {
            "valuation": valuation_layer,
            "trend": {"label": trend} if trend is not None else {"label": ""},
            "sentiment": {"label": momentum} if momentum is not None else {"label": ""},
        },
    }
    return build_evidence_snapshot(
        detail,
        score_result,
        signal_result,
        {"available": True},
        historical_outcome_summary=historical_outcome,
        created_at=created_at,
    )


def holding(*, held, current=None, target=None, created_at=T0):
    return build_holding_version(
        "510300",
        is_held=held,
        current_weight=current,
        target_weight=target,
        source="test",
        created_at=created_at,
    )


@pytest.mark.parametrize(
    ("evidence_kwargs", "holding_kwargs", "expected"),
    [
        ({}, {"held": False}, "buy"),
        ({}, {"held": True, "current": 20, "target": 10}, "reduce"),
        ({"valuation": 85, "signal": "持有"}, {"held": False}, "watch"),
        ({"valuation": 85, "signal": "减仓", "trend": "下降趋势"}, {"held": True, "current": 20, "target": 10}, "reduce"),
        ({"valuation": 85, "signal": "买入", "trend": "上升趋势"}, {"held": False}, "watch"),
        ({"valuation": 20, "signal": "买入", "trend": "下降趋势"}, {"held": False}, "dca"),
        ({"score_coverage": 0.5}, {"held": False}, "watch"),
        ({"status": "stale"}, {"held": False}, "watch"),
        ({"fund_type": "QDII", "p80": 3.2, "samples": 12, "target_nav_date": "2026-08-25"}, {"held": False}, "watch"),
        (
            {"score": 35, "valuation": 90, "trend": "下降趋势", "signal": "减仓", "risk_flags": ["manager_changed"]},
            {"held": True, "current": 20, "target": 10},
            "sell",
        ),
        ({}, {"held": True, "current": 45, "target": 45}, "reduce"),
        ({"official_nav_available": False}, {"held": False}, "watch"),
    ],
)
def test_v8_golden_actions(evidence_kwargs, holding_kwargs, expected):
    evidence = make_evidence(**evidence_kwargs)
    decision = build_decision_snapshot(evidence, holding(**holding_kwargs), default_portfolio_policy(T0))

    assert decision.action == expected
    assert decision.reason_codes[0] == f"ACTION_{expected.upper()}"
    assert decision.reasons
    assert decision.invalidation_codes
    assert decision.invalidation_conditions
    assert decision.strategy_version == "v8-kernel-1"
    assert decision.holding_version
    assert decision.policy_version


def test_v8_ids_and_actions_are_deterministic_for_identical_inputs():
    evidence_a = make_evidence(created_at=T0)
    evidence_b = make_evidence(created_at=T1)
    holding_a = holding(held=False, created_at=T0)
    holding_b = holding(held=False, created_at=T1)
    policy_a = default_portfolio_policy(T0)
    policy_b = default_portfolio_policy(T1)
    decision_a = build_decision_snapshot(evidence_a, holding_a, policy_a, created_at=T0)
    decision_b = build_decision_snapshot(evidence_b, holding_b, policy_b, created_at=T1)

    assert evidence_a.evidence_id == evidence_b.evidence_id
    assert holding_a.holding_version == holding_b.holding_version
    assert policy_a.policy_version == policy_b.policy_version
    assert decision_a.decision_id == decision_b.decision_id
    assert decision_a.action == decision_b.action
    assert decision_a.strength == decision_b.strength
    assert decision_a.confidence == decision_b.confidence
    assert decision_a.reason_codes == decision_b.reason_codes


def test_policy_effective_time_is_part_of_the_immutable_version():
    first = default_portfolio_policy(T0)
    changed = default_portfolio_policy(T1)

    # created_at alone is not identity, while the fixed effective_at and rules are.
    assert first.policy_version == changed.policy_version

    from strategy.decision_v2 import build_portfolio_policy

    later_effective = build_portfolio_policy(
        name=first.name,
        max_single_fund_weight=first.max_single_fund_weight,
        max_theme_weight=first.max_theme_weight,
        rebalance_band=first.rebalance_band,
        dca_rules=first.dca_rules,
        reduce_rules=first.reduce_rules,
        sell_rules=first.sell_rules,
        effective_at=T1,
        source=first.source,
    )
    assert later_effective.policy_version != first.policy_version


def test_latest_official_nav_is_not_stored_as_a_zero_intraday_estimate():
    detail = {
        "code": "510300",
        "name": "测试宽基",
        "type": "指数型",
        "latest_nav": 1.2,
        "latest_nav_date": "2026-08-22",
        "source": "fixture",
        "updated_at": "2026-08-25T06:29:00+00:00",
        "decision_context": {
            "status": "latest_official",
            "kind": "official_nav",
            "source": "official-test",
            "source_time": "2026-08-22",
            "source_time_precision": "date",
            "base_nav": 1.2,
            "base_nav_date": "2026-08-22",
            "estimate_change": 0.0,
        },
    }
    evidence = build_evidence_snapshot(
        detail,
        {"score": 80, "score_version": "test", "coverage": 1, "components": {}},
        {
            "signal": "买入", "signal_version": "test", "coverage": 1,
            "layers": {
                "valuation": {"label": "低估", "percentile": 20, "source": "index_pe_pb"},
                "trend": {"label": "上升趋势"}, "sentiment": {"label": "中性"},
            },
        },
        {"available": True},
        created_at=T0,
    )

    assert evidence.estimate is None
    assert evidence.estimate_status == "latest_official"


def test_higher_current_weight_cannot_create_a_stronger_add_action():
    evidence = make_evidence()
    policy = default_portfolio_policy(T0)
    low = build_decision_snapshot(evidence, holding(held=True, current=2, target=15), policy)
    reached = build_decision_snapshot(evidence, holding(held=True, current=15, target=15), policy)

    assert low.action == "add"
    assert reached.action == "hold"
    assert reached.strength <= low.strength


def test_decision_graph_contains_versioned_holding_and_portfolio_nodes():
    decision = build_decision_snapshot(
        make_evidence(),
        holding(held=True, current=45, target=45),
        default_portfolio_policy(T0),
    )
    by_id = {node.node_id: node for node in decision.evidence_nodes}

    assert by_id["holding_position"].category == "holding"
    assert by_id["holding_position"].state == "constraint"
    assert by_id["portfolio_single_fund_limit"].category == "portfolio"
    assert by_id["portfolio_single_fund_limit"].state == "constraint"
    assert by_id["holding_position"].source_id == decision.holding_version
    assert by_id["portfolio_single_fund_limit"].source_id == decision.policy_version


@pytest.mark.parametrize(
    ("summary", "expected_state"),
    [
        (None, "missing"),
        ({"samples": 0, "hit_rate": None}, "missing"),
        ({"samples": 9, "hit_rate": 100}, "neutral"),
        ({"samples": 10, "hit_rate": 60}, "support"),
        ({"samples": 10, "hit_rate": 39.99}, "constraint"),
        ({"samples": 10, "hit_rate": 40}, "neutral"),
        ({"samples": 10, "hit_rate": 59.99}, "neutral"),
    ],
)
def test_historical_outcome_node_uses_mature_explicit_thresholds(summary, expected_state):
    normalized = {
        "fund_code": "510300",
        "strategy_version": "v8-kernel-1",
        "horizon": 20,
        "mean_return": 1.25,
        "peer_excess": 0.4,
        **(summary or {}),
    } if summary is not None else None

    evidence = make_evidence(historical_outcome=normalized)
    node = next(item for item in evidence.evidence_nodes if item.node_id == "historical_outcome")

    assert node.category == "outcome"
    assert node.state == expected_state
    if normalized and 0 < normalized["samples"] < 10:
        assert "仅观察" in node.label


def test_historical_outcome_node_source_is_stable_for_same_strategy_and_horizon():
    common = {
        "fund_code": "510300",
        "strategy_version": "v8-kernel-1",
        "horizon": 20,
        "samples": 10,
        "mean_return": 1.0,
        "peer_excess": 0.1,
    }
    support = make_evidence(historical_outcome={**common, "hit_rate": 60})
    constraint = make_evidence(historical_outcome={**common, "hit_rate": 30})
    support_node = next(item for item in support.evidence_nodes if item.node_id == "historical_outcome")
    constraint_node = next(item for item in constraint.evidence_nodes if item.node_id == "historical_outcome")

    assert support_node.source_id == constraint_node.source_id
    assert support_node.source_id.startswith("outcome_")


def test_data_quality_degradation_never_increases_confidence():
    policy = default_portfolio_policy(T0)
    position = holding(held=False)
    fresh = build_decision_snapshot(make_evidence(status="fresh"), position, policy)
    stale = build_decision_snapshot(make_evidence(status="stale"), position, policy)

    assert stale.confidence <= fresh.confidence
    assert stale.strength <= fresh.strength
    assert stale.action == "watch"


def test_higher_valuation_cannot_strengthen_buy():
    policy = default_portfolio_policy(T0)
    position = holding(held=False)
    low = build_decision_snapshot(make_evidence(valuation=20), position, policy)
    high = build_decision_snapshot(make_evidence(valuation=85), position, policy)

    assert low.action == "buy"
    assert high.action == "watch"
    assert high.strength <= low.strength


def test_sell_requires_structural_invalidation_not_single_market_move():
    evidence = make_evidence(score=35, valuation=90, trend="下降趋势", signal="减仓")
    decision = build_decision_snapshot(
        evidence,
        holding(held=True, current=20, target=10),
        default_portfolio_policy(T0),
    )

    assert decision.action == "reduce"
    assert decision.action != "sell"


def test_diff_marks_non_action_snapshot_changes():
    position = holding(held=True, current=10, target=10)
    policy = default_portfolio_policy(T0)
    previous_evidence = make_evidence(status="fresh", created_at=T0)
    current_evidence = make_evidence(status="modeled", created_at=T1)
    previous = build_decision_snapshot(previous_evidence, position, policy, created_at=T0)
    current = build_decision_snapshot(current_evidence, position, policy, created_at=T1)

    diff = build_decision_diff(
        current,
        current_evidence,
        previous,
        previous_evidence,
        position,
        position,
    )

    assert previous.action == current.action == "hold"
    assert diff.changed is True
    assert "DATA_STATUS_CHANGED" in diff.driver_codes


@pytest.mark.parametrize(
    "rules",
    [
        {"dca_rules": {"max_step_percent": 0}},
        {"dca_rules": {"minimum_confidence": 101}},
        {"reduce_rules": {"max_step_percent": True}},
        {"sell_rules": {"require_structural_invalidation": "yes"}},
    ],
)
def test_policy_rejects_invalid_consumed_rule_values(rules):
    with pytest.raises(ValueError):
        build_portfolio_policy(name="invalid", effective_at=T0, **rules)
