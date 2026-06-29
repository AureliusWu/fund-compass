from strategy.scoring import (
    _scale, _star, _wavg, parse_tenure_years, risk_metrics, score_fund,
)


def test_scale_basic():
    assert _scale(0, 0, 100) == 0.0
    assert _scale(50, 0, 100) == 50.0
    assert _scale(100, 0, 100) == 100.0


def test_scale_clamps_out_of_range():
    assert _scale(-10, 0, 100) == 0.0
    assert _scale(200, 0, 100) == 100.0


def test_scale_inverted_lower_is_better():
    assert _scale(0, 1.5, 0) == 100.0
    assert _scale(1.5, 1.5, 0) == 0.0


def test_scale_none_and_degenerate():
    assert _scale(None, 0, 1) is None
    assert _scale(5, 3, 3) == 50.0


def test_wavg_skips_none_and_renormalises():
    assert _wavg([(100, 0.5), (None, 0.5)]) == 100.0
    assert _wavg([(None, 1)]) is None
    assert _wavg([]) is None


def test_parse_tenure_years():
    assert parse_tenure_years("14年又199天") == 14.5
    assert parse_tenure_years("3年") == 3.0
    assert parse_tenure_years("100天") == 0.3
    assert parse_tenure_years(None) is None
    assert parse_tenure_years("") is None
    assert parse_tenure_years("无") is None


def test_star_thresholds():
    assert _star(80) == 5
    assert _star(79.9) == 4
    assert _star(65) == 4
    assert _star(50) == 3
    assert _star(35) == 2
    assert _star(34.9) == 1
    assert _star(None) is None


def test_risk_metrics_uptrend(uptrend):
    rm = risk_metrics(uptrend)
    assert set(rm) == {"max_drawdown", "volatility", "sharpe"}
    assert rm["max_drawdown"] <= 0      # 单调上涨，回撤≈0
    assert rm["volatility"] >= 0


def test_risk_metrics_insufficient(make_navs):
    rm = risk_metrics(make_navs(n=10))
    assert rm == {"max_drawdown": None, "volatility": None, "sharpe": None}


def test_score_fund_structure(sample_detail):
    s = score_fund(sample_detail)
    assert 0 <= s["score"] <= 100
    assert s["star"] in (1, 2, 3, 4, 5)
    assert set(s["components"]) == {"return", "risk", "management", "cost"}
    assert s["components"]["return"]["weight"] == 0.4
    assert s["components"]["management"]["detail"]["tenure_years"] == 8.0
