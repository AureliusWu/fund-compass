import pytest

from strategy.portfolio_lab import align_navs, analyze_portfolio, capped_weights, normalize_weights


def details(make_navs):
    return [
        {"code": "A", "name": "基金A", "nav_history": make_navs(n=180, r=0.001)},
        {"code": "B", "name": "基金B", "nav_history": make_navs(n=180, r=-0.0002)},
    ]


def test_portfolio_lab_returns_backtest_risk_and_bounded_rebalance(make_navs):
    result = analyze_portfolio(details(make_navs), [
        {"code": "A", "current_weight": 70, "target_weight": 30},
        {"code": "B", "current_weight": 30, "target_weight": 70},
    ], portfolio_value=100000)
    assert result["backtest"]["points"] == 180
    assert result["backtest"]["friction_cost"] >= 0
    assert sum(row["risk_contribution"] for row in result["risk"]["contributions"]) == pytest.approx(100, abs=0.1)
    assert all(0 <= row["suggested_weight"] <= 100 for row in result["rebalance"]["actions"])
    assert result["rebalance"]["estimated_cost"] >= 0
    assert "risk_change" in result["rebalance"]
    assert len(result["stress"]) == 3
    assert result["stress"][-1]["return"] < 0


def test_alignment_uses_only_common_observation_dates(make_navs):
    a = make_navs(n=80)
    b = [row for index, row in enumerate(make_navs(n=80, r=0.0003)) if index != 20]
    dates, series = align_navs([{"code": "A", "nav_history": a}, {"code": "B", "nav_history": b}])
    missing_date = a[20]["date"]
    assert missing_date not in dates
    assert len(dates) == 79
    assert all(len(values) == 79 for values in series)


def test_invalid_weights_and_short_history_are_rejected(make_navs):
    with pytest.raises(ValueError):
        normalize_weights([0, 0])
    with pytest.raises(ValueError, match="共同历史不足"):
        align_navs([
            {"code": "A", "nav_history": make_navs(n=30)},
            {"code": "B", "nav_history": make_navs(n=30)},
        ])


def test_weight_cap_is_preserved_after_normalization():
    weights, cap = capped_weights([100, 1, 1], 40)
    assert sum(weights) == pytest.approx(1)
    assert max(weights) <= cap + 1e-9
    assert cap == pytest.approx(0.4)
