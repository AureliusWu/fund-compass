"""V6-P1 批量决策测试。"""
import pytest

from strategy.portfolio import _rebalance_plan, decide_portfolio


def test_portfolio_decisions_empty():
    r = decide_portfolio([])
    assert r["decisions"] == []
    assert r["total"] == 0
    assert r["allocation"]["target_cash"] == 100
    assert r["rebalance"] == []


def test_portfolio_decisions_batch(sample_detail, monkeypatch):
    monkeypatch.setattr("service.repo.get_detail", lambda code: {**sample_detail, "code": code})
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    r = decide_portfolio([{"code": "000001"}, {"code": "000002"}])
    assert r["total"] == 2
    assert len(r["decisions"]) == 2
    for d in r["decisions"]:
        assert "action" in d
        assert d["action"] in ("买入", "分批定投", "观望", "加仓", "持有", "减仓", "卖出")


def test_portfolio_decisions_with_holding(sample_detail, monkeypatch):
    monkeypatch.setattr("service.repo.get_detail", lambda code: sample_detail)
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    r = decide_portfolio([{"code": "000001", "current_weight": 5, "target_weight": 20}])
    assert r["total"] == 1
    assert "目标仓位" in r["decisions"][0]["position_rule"] or "当前" in r["decisions"][0]["position_rule"]
    assert r["allocation"]["target_total"] == 20
    assert r["allocation"]["target_cash"] == 80
    assert r["rebalance"][0]["gap"] == 15


def test_portfolio_rebalance_amount_and_overweight(sample_detail, monkeypatch):
    monkeypatch.setattr("service.repo.get_detail", lambda code: {**sample_detail, "code": code})
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    r = decide_portfolio(
        [
            {"code": "000001", "current_weight": 40, "target_weight": 30},
            {"code": "000002", "current_weight": 60, "target_weight": 80},
        ],
        portfolio_value=100_000,
    )

    assert r["allocation"]["status"] == "需校准"
    assert r["allocation"]["target_total"] == 110
    assert r["allocation"]["warnings"]
    assert {x["amount"] for x in r["rebalance"]} == {10_000, 20_000}


@pytest.mark.parametrize(
    ("action", "gap", "suggestion"),
    [
        ("买入", 10, "分批补仓"),
        ("分批定投", 10, "分批补仓"),
        ("加仓", 10, "分批补仓"),
        ("持有", 10, "暂缓补仓"),
        ("观望", 10, "暂缓补仓"),
        ("减仓", -10, "逐步降仓"),
        ("卖出", -10, "逐步降仓"),
        ("持有", -10, "关注超配"),
    ],
)
def test_rebalance_suggestion_uses_current_action_vocabulary(action, gap, suggestion):
    item = {"code": "000001", "current_weight": 20, "target_weight": 20 + gap}
    decision = {"code": "000001", "name": "测试基金", "action": action}

    assert _rebalance_plan([item], [decision], None)[0]["suggestion"] == suggestion


def test_portfolio_decisions_error(monkeypatch):
    def boom(code):
        raise RuntimeError("fetch fail")

    monkeypatch.setattr("service.repo.get_detail", boom)
    r = decide_portfolio([{"code": "000001"}])
    assert r["total"] == 0
    assert len(r["errors"]) == 1
