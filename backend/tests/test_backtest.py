from strategy.backtest import _max_drawdown, backtest


def test_backtest_insufficient(make_navs):
    r = backtest({"nav_history": make_navs(n=100)})
    assert r["available"] is False
    assert "reason" in r


def test_backtest_runs(uptrend):
    r = backtest({"nav_history": uptrend})
    assert r["available"] is True
    for k in ("strategy", "benchmark", "outperform", "win_rate", "rebalances", "actions"):
        assert k in r
    assert r["strategy"]["total_return"] is not None
    assert len(r["actions"]) <= 12


def test_max_drawdown_monotonic_up_is_zero():
    assert _max_drawdown([{"v": 1.0}, {"v": 1.1}, {"v": 1.2}]) == 0.0


def test_max_drawdown_detects_dip():
    # 1.0 → 1.2 → 0.9：从峰值 1.2 回撤到 0.9 = -25%
    assert _max_drawdown([{"v": 1.0}, {"v": 1.2}, {"v": 0.9}]) == -25.0
