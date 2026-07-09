"""V6-P3 决策推送组合计算测试。"""
import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "estimate_push.py"
SPEC = importlib.util.spec_from_file_location("estimate_push", SCRIPT)
estimate_push = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(estimate_push)


def test_build_portfolio_payload_distributes_remaining_target():
    entries = [
        {"code": "000001", "shares": 100, "target_weight": 60},
        {"code": "000002", "shares": 100},
        {"code": "000003", "shares": 100},
    ]
    estimates = {
        "000001": {"est_nav": 2},
        "000002": {"est_nav": 1},
        "000003": {"est_nav": 1},
    }

    items, value = estimate_push.build_portfolio_payload(entries, estimates)

    assert value == 400
    assert items[0]["current_weight"] == 50
    assert items[0]["target_weight"] == 60
    assert items[1]["target_weight"] == 20
    assert items[2]["target_weight"] == 20


def test_build_portfolio_payload_aggregates_accounts():
    entries = [
        {"code": "000001", "shares": 40, "account": "A"},
        {"code": "000001", "shares": 60, "account": "B"},
    ]
    items, value = estimate_push.build_portfolio_payload(
        entries,
        {"000001": {"last_nav": 2}},
    )

    assert value == 200
    assert items == [{"code": "000001", "current_weight": 100.0, "target_weight": 100.0}]


def test_format_portfolio_summary_limits_actions():
    result = {
        "allocation": {"target_total": 90, "target_cash": 10, "warnings": []},
        "rebalance": [
            {"code": str(i), "name": f"基金{i}", "gap": i, "suggestion": "分批补仓", "amount": 1000}
            for i in range(1, 6)
        ],
    }

    text = estimate_push.format_portfolio_summary(result)

    assert "目标现金 10.0%" in text
    assert "基金3" in text
    assert "基金4" not in text
