"""V6-P0 决策引擎测试。"""
from strategy.decision import decide_fund
from strategy.rules import build_decision, map_action, compute_confidence


def _pack(sample_detail, monkeypatch=None):
    if monkeypatch:
        monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    return decide_fund(sample_detail)


def test_decision_fields(sample_detail, monkeypatch):
    d = _pack(sample_detail, monkeypatch)
    for k in ("action", "confidence", "summary", "reasons", "risks", "position_rule", "next_check", "disclaimer", "raw"):
        assert k in d
    assert d["action"] in ("分批买入", "继续定投", "持有观望", "停止加仓", "部分观察", "考虑替换", "观察")
    assert d["confidence"] in ("高", "中", "低")


def test_decision_buy_action(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    monkeypatch.setattr("strategy.rules.map_action", lambda q, s, l: "分批买入")
    d = decide_fund(sample_detail)
    assert d["action"] == "分批买入"


def test_decision_dca_action(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_signal(detail):
        from strategy.timing import timing_signal
        sig = timing_signal(detail)
        sig["signal"] = "定投"
        return sig

    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail)
    assert d["action"] in ("继续定投", "观察")


def test_decision_hold_action(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_signal(detail):
        return {"signal": "持有", "layers": {"valuation": {"label": "合理", "source": "nav_detrended"},
                "trend": {"label": "横盘趋势"}, "sentiment": {"label": "中性"}}}

    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail)
    assert d["action"] == "持有观望"


def test_decision_reduce_low_score(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_score(detail):
        return {"score": 45.0, "star": 2}

    def fake_signal(detail):
        return {"signal": "减仓", "layers": {"valuation": {"label": "高估", "percentile": 85, "source": "nav_detrended"},
                "trend": {"label": "下降趋势"}, "sentiment": {"label": "超买", "rsi": 75}}}

    monkeypatch.setattr("strategy.decision.score_fund", fake_score)
    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail)
    assert d["action"] == "考虑替换"


def test_decision_partial_observe(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)

    def fake_score(detail):
        return {"score": 60.0, "star": 3}

    def fake_signal(detail):
        return {"signal": "减仓", "layers": {"valuation": {"label": "高估", "percentile": 85, "source": "nav_detrended"},
                "trend": {"label": "下降趋势"}, "sentiment": {"label": "超买", "rsi": 75}}}

    monkeypatch.setattr("strategy.decision.score_fund", fake_score)
    monkeypatch.setattr("strategy.decision.timing_signal", fake_signal)
    d = decide_fund(sample_detail)
    assert d["action"] == "部分观察"


def test_decision_insufficient_data(make_navs, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    detail = {"code": "000001", "name": "测试", "nav_history": make_navs(n=10)}
    d = decide_fund(detail)
    assert d["confidence"] == "低"
    assert "缺少持仓" in d["position_rule"] or "缺少" in d["position_rule"]


def test_decision_with_holding(sample_detail, monkeypatch):
    monkeypatch.setattr("strategy.timing._index_lookup", lambda code: None)
    holding = {"target_weight": 20.0, "current_weight": 5.0}
    d = decide_fund(sample_detail, holding)
    assert "目标仓位" in d["position_rule"] or "当前" in d["position_rule"]


def test_map_action_rules():
    layers = {"valuation": {"label": "合理"}, "sentiment": {"rsi": 50}}
    assert map_action(80, "买入", layers) == "分批买入"
    assert map_action(70, "定投", layers) == "继续定投"
    assert map_action(60, "持有", layers) == "持有观望"
    assert map_action(40, "减仓", layers) == "考虑替换"


def test_confidence_high_with_pe_pb():
    layers = {"valuation": {"source": "index_pe_pb", "label": "合理"}}
    assert compute_confidence(75, layers, True, []) == "高"


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
