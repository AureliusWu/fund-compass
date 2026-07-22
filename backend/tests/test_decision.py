"""V6-P0 决策引擎测试。"""
from strategy.decision import decide_fund
from strategy.rules import build_decision, map_action, compute_confidence


def _pack(sample_detail, monkeypatch=None):
    if monkeypatch:
        monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    return decide_fund(sample_detail)


def test_decision_fields(sample_detail, monkeypatch):
    d = _pack(sample_detail, monkeypatch)
    for k in ("action", "strength", "data_status", "data_time", "position_level", "trend_state", "investment_method", "change_conditions", "confidence", "summary", "reasons", "risks", "position_rule", "next_check", "disclaimer", "methodology", "freshness", "raw"):
        assert k in d
    assert d["action"] in ("买入", "分批定投", "观望", "加仓", "持有", "减仓", "卖出")
    assert 0 <= d["strength"] <= 100
    assert d["confidence"] in ("高", "中", "低")
    assert d["methodology"]["score_version"] == "v3-risk-adjusted"
    assert d["methodology"]["signal_version"] == "v3-coverage-gated"


def test_decision_buy_action(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    monkeypatch.setattr("strategy.rules.map_action", lambda q, s, l, h=None: "买入")
    d = decide_fund(sample_detail)
    assert d["action"] == "买入"


def test_decision_dca_action(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_signal(detail):
        from strategy.timing import timing_signal
        sig = timing_signal(detail)
        sig["signal"] = "定投"
        return sig

    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail)
    assert d["action"] in ("分批定投", "观望")


def test_decision_hold_action(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_signal(detail):
        return {"signal": "持有", "layers": {"valuation": {"label": "合理", "source": "nav_detrended"},
                "trend": {"label": "横盘趋势"}, "sentiment": {"label": "中性"}}}

    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail, {"is_held": True})
    assert d["action"] == "持有"


def test_decision_reduce_low_score(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_score(detail):
        return {"score": 45.0, "star": 2}

    def fake_signal(detail):
        return {"signal": "减仓", "layers": {"valuation": {"label": "高估", "percentile": 85, "source": "nav_detrended"},
                "trend": {"label": "下降趋势"}, "sentiment": {"label": "超买", "rsi": 75}}}

    monkeypatch.setattr("strategy.decision.score_fund", fake_score)
    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail, {"is_held": True})
    assert d["action"] == "卖出"


def test_decision_partial_observe(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_score(detail):
        return {"score": 60.0, "star": 3}

    def fake_signal(detail):
        return {"signal": "减仓", "layers": {"valuation": {"label": "高估", "percentile": 85, "source": "nav_detrended"},
                "trend": {"label": "下降趋势"}, "sentiment": {"label": "超买", "rsi": 75}}}

    monkeypatch.setattr("strategy.decision.score_fund", fake_score)
    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail, {"is_held": True})
    assert d["action"] == "减仓"


def test_decision_insufficient_data(make_navs, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    detail = {"code": "000001", "name": "测试", "nav_history": make_navs(n=10)}
    d = decide_fund(detail)
    assert d["confidence"] == "低"
    assert d["action"] == "观望"


def test_decision_with_holding(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    holding = {"target_weight": 20.0, "current_weight": 5.0}
    d = decide_fund(sample_detail, holding)
    assert "目标仓位" in d["position_rule"] or "当前" in d["position_rule"]


def test_map_action_rules():
    layers = {"valuation": {"label": "合理"}, "sentiment": {"rsi": 50}}
    assert map_action(80, "买入", layers) == "买入"
    assert map_action(70, "定投", layers) == "分批定投"
    assert map_action(60, "持有", layers) == "观望"
    assert map_action(70, "买入", layers, {"is_held": True}) == "加仓"
    assert map_action(40, "减仓", layers, {"is_held": True}) == "减仓"


def test_confidence_high_with_pe_pb():
    layers = {"valuation": {"source": "index_pe_pb", "label": "合理"}}
    assert compute_confidence(75, layers, True, []) == "高"


def test_stale_detail_forces_observe_and_low_confidence(sample_detail):
    sample_detail["stale"] = True
    decision = build_decision(
        sample_detail,
        {"score": 80},
        {"signal": "买入", "layers": {"valuation": {"label": "低估", "source": "index_pe_pb"}}},
        {"available": True, "outperform": 2},
    )
    assert decision["action"] == "观望"
    assert decision["confidence"] == "低"
    assert "基金数据已过期" in decision["risks"]


def test_same_inputs_are_deterministic(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    holding = {"is_held": True, "target_weight": 20, "current_weight": 10}
    first = decide_fund(sample_detail, holding)
    second = decide_fund(sample_detail, holding)
    for key in ("action", "strength", "summary", "reasons", "change_conditions"):
        assert first[key] == second[key]


def test_unavailable_intraday_data_caps_strength_and_action(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    sample_detail["decision_context"] = {"status": "unavailable", "source_time": None, "source": "none", "is_fallback": True}
    decision = decide_fund(sample_detail, {"is_held": False})
    assert decision["action"] == "观望"
    assert decision["strength"] <= 25
    assert decision["data_status"] == "暂不可用"


def test_backtest_passes_code_to_timing(uptrend, monkeypatch):
    """回测切片应透传 fund code，使估值层可走 PE/PB。"""
    import importlib
    bt_mod = importlib.import_module("strategy.backtest")

    calls = []

    def spy_timing(detail):
        calls.append(detail.get("code"))
        return {"signal": "持有"}

    monkeypatch.setattr(bt_mod, "timing_signal", spy_timing)
    bt_mod.backtest({"code": "510300", "type": "指数型", "nav_history": uptrend})
    assert calls and all(c == "510300" for c in calls)
