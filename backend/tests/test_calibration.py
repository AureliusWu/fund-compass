from strategy.calibration import WEIGHT, calibrate


def test_calibration_requires_enough_history(make_navs):
    result = calibrate({"nav_history": make_navs(n=300)})
    assert result["available"] is False
    assert result["accepted"] is False


def test_calibration_uses_holdout_period(make_navs, monkeypatch):
    history = make_navs(n=520)
    calls = []

    def fake_backtest(detail, weights=None):
        calls.append(len(detail["nav_history"]))
        selected = weights or WEIGHT
        improved = selected["持有"] >= 0.6
        return {
            "available": True,
            "outperform": 2.0 if improved else 1.0,
            "strategy": {"max_drawdown": -8.0 if improved else -9.0},
            "benchmark": {"max_drawdown": -12.0},
        }

    monkeypatch.setattr("strategy.calibration.backtest", fake_backtest)
    result = calibrate({"nav_history": history})

    assert result["available"] is True
    assert result["accepted"] is True
    assert result["train_points"] == 364
    assert result["validation_points"] == 156
    assert max(calls) == 364
    assert min(calls) == 276


def test_calibration_rejects_validation_regression(make_navs, monkeypatch):
    history = make_navs(n=520)

    def fake_backtest(detail, weights=None):
        is_validation = len(detail["nav_history"]) < 300
        selected = weights or WEIGHT
        improved = selected["持有"] >= 0.6
        outperform = (2.0 if improved else 1.0) if not is_validation else (-1.0 if improved else 0.5)
        return {
            "available": True,
            "outperform": outperform,
            "strategy": {"max_drawdown": -8.0},
            "benchmark": {"max_drawdown": -12.0},
        }

    monkeypatch.setattr("strategy.calibration.backtest", fake_backtest)
    result = calibrate({"nav_history": history})

    assert result["available"] is True
    assert result["accepted"] is False
    assert "验证段" in result["reason"]
