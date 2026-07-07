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


# ── V3-5 真实 PE/PB 估值测试 ──

MOCK_HS300 = {
    "index_name": "沪深300", "pe": 13.76, "pe_pct": 66.2,
    "pb": 1.44, "pb_pct": 31.2, "date": "2026-06-29",
    "source": "legulegu", "updated": "2026-06-29",
}

MOCK_ZZ500 = {
    "index_name": "中证500", "pe": 33.19, "pe_pct": 71.0,
    "pb": 2.73, "pb_pct": 64.7, "date": "2026-06-29",
    "source": "legulegu", "updated": "2026-06-29",
}


def test_valuation_index_pe_pb(make_navs, monkeypatch):
    """指数基金走真实 PE/PB 估值（PE分位66.2 → 合理）"""
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: MOCK_HS300)
    v = valuation_layer(make_navs(n=400), fund_code="510300")
    assert v["label"] == "合理"
    assert v["value"] == 0
    assert v["percentile"] == 66.2
    assert v["source"] == "index_pe_pb"
    assert v["index_name"] == "沪深300"
    assert v["pe"] == 13.76
    assert v["pe_pct"] == 66.2
    assert v["pb"] == 1.44
    assert v["pb_pct"] == 31.2


def test_valuation_index_pe_overvalued(make_navs, monkeypatch):
    """PE分位>70 → 高估"""
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: MOCK_ZZ500)
    v = valuation_layer(make_navs(n=400), fund_code="510500")
    assert v["label"] == "高估"
    assert v["value"] == -1
    assert v["source"] == "index_pe_pb"


def test_valuation_fallback_when_lookup_none(make_navs, monkeypatch):
    """非指数基金（lookup 返回 None）→ 回退到去趋势代理"""
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    v = valuation_layer(make_navs(n=400), fund_code="000001")
    assert v["label"] in ("低估", "合理", "高估")
    assert v["source"] == "nav_detrended"
    assert "note" in v


def test_valuation_fallback_explains_mapped_index_gap(make_navs, monkeypatch):
    """已映射但 PE/PB 未覆盖时，回退说明里点名原因"""
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    monkeypatch.setattr("strategy.timing._index_unavailable_reason", lambda code: "已映射至 纳斯达克100，海外指数 PE/PB 暂未覆盖")
    v = valuation_layer(make_navs(n=400), fund_code="513100")
    assert v["source"] == "nav_detrended"
    assert v["note"].startswith("已映射至 纳斯达克100")


def test_valuation_fallback_when_no_code(make_navs):
    """未传 fund_code → 直接走代理（不调 lookup）"""
    v = valuation_layer(make_navs(n=400))
    assert v["label"] in ("低估", "合理", "高估")
    assert v["source"] == "nav_detrended"


def test_timing_signal_passes_code_to_valuation(monkeypatch, make_navs):
    """timing_signal 将 detail["code"] 透传给 valuation_layer"""
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: MOCK_HS300)
    detail = {"code": "510300", "nav_history": make_navs(n=400)}
    sig = timing_signal(detail)
    val = sig["layers"]["valuation"]
    assert val["source"] == "index_pe_pb"
    assert val["index_name"] == "沪深300"
    assert val["pe_pct"] == 66.2


def test_timing_signal_non_index_still_works(sample_detail, monkeypatch):
    """非指数基金完整信号仍正常工作"""
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    sig = timing_signal(sample_detail)
    assert sig["signal"] in ("买入", "定投", "持有", "减仓")
    assert sig["layers"]["valuation"]["source"] == "nav_detrended"
