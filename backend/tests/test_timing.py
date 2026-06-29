from strategy.timing import (
    _ma, _percentile, _rsi, sentiment_layer, timing_signal, trend_layer,
    valuation_layer,
)


def test_ma():
    assert _ma([1, 2, 3, 4], 2) == 3.5
    assert _ma([1, 2], 5) is None


def test_percentile():
    assert _percentile([1, 2, 3, 4], 4) == 100.0
    assert _percentile([1, 2, 3, 4], 1) == 25.0
    assert _percentile([], 1) is None


def test_rsi_monotonic_up_is_100():
    assert _rsi(list(range(1, 40))) == 100.0


def test_rsi_insufficient():
    assert _rsi([1, 2, 3]) is None


def test_trend_uptrend(uptrend):
    t = trend_layer(uptrend)
    assert t["label"] == "上升趋势"
    assert t["value"] == 1


def test_trend_downtrend(downtrend):
    t = trend_layer(downtrend)
    assert t["label"] == "下降趋势"
    assert t["value"] == -1


def test_sentiment_uptrend_overbought(uptrend):
    se = sentiment_layer(uptrend)
    assert se["label"] == "超买"
    assert se["value"] == -1


def test_valuation_insufficient(make_navs):
    v = valuation_layer(make_navs(n=50))
    assert v["label"] == "数据不足"
    assert v["percentile"] is None


def test_valuation_structure(uptrend):
    v = valuation_layer(uptrend)
    assert v["label"] in ("低估", "合理", "高估")
    assert 0 <= v["percentile"] <= 100


def test_valuation_undervalued_after_crash(make_navs):
    navs = make_navs(n=400, r=0.001)
    for h in navs[-30:]:                     # 末段砸盘 → 当前点远低于趋势线 → 低分位 → 低估
        h["nav"] = round(h["nav"] * 0.7, 6)
        h["ac_return"] = round((h["nav"] - 1) * 100, 4)
    v = valuation_layer(navs)
    assert v["label"] == "低估"
    assert v["value"] == 1


def test_timing_signal_full(uptrend):
    sig = timing_signal({"nav_history": uptrend})
    assert sig["signal"] in ("买入", "定投", "持有", "减仓")
    assert "disclaimer" in sig
    assert set(sig["layers"]) == {"valuation", "trend", "sentiment"}


def test_timing_signal_insufficient_degrades(make_navs):
    sig = timing_signal({"nav_history": make_navs(n=10)})
    assert sig["signal"] in ("买入", "定投", "持有", "减仓")   # 降级但仍给出信号
