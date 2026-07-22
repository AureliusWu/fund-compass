"""天天基金 pingzhongdata JS 文本的解析函数单测（用内联样本，绝不打网络）。"""
from service.eastmoney import _build_primary_nav_history, _json_var, _num, _str_var

JS = """
var fS_name = "测试基金A";
var fund_Rate="0.15";
var fund_sourceRate="1.50";
var Data_netWorthTrend = [{"x":1640966400000,"y":1.5,"equityReturn":0.5},{"x":1641052800000,"y":1.52,"equityReturn":1.8}];
var Data_currentFundManager =[{"name":"张三","workTime":"5年"}];
"""


def test_str_var():
    assert _str_var(JS, "fS_name") == "测试基金A"
    assert _str_var(JS, "fund_Rate") == "0.15"
    assert _str_var(JS, "not_exist") is None


def test_json_var_array():
    arr = _json_var(JS, "Data_netWorthTrend", [])
    assert isinstance(arr, list) and len(arr) == 2
    assert arr[0]["y"] == 1.5
    assert arr[1]["equityReturn"] == 1.8


def test_json_var_missing_returns_default():
    assert _json_var(JS, "missing", []) == []
    assert _json_var(JS, "missing", {}) == {}


def test_num():
    assert _num("1.5") == 1.5
    assert _num("0.15") == 0.15
    assert _num("abc") is None
    assert _num(None) is None
    assert _num("") is None


def test_live_estimate_keeps_upstream_quote_time(monkeypatch):
    from service import eastmoney as em
    class Response:
        def raise_for_status(self):
            return None
        def json(self):
            return {"ErrCode": 0, "TotalCount": 1, "Data": {"list": [{
                "bzdm": "000001", "jjjc": "测试基金", "dwjz": "1.0", "gsz": "1.01",
                "gszzl": "1.0%", "gzrq": "2026-07-21", "gxrq": "2026-07-22",
            }]}}
    monkeypatch.setattr(em.requests, "get", lambda *args, **kwargs: Response())
    result = em.fetch_estimate("000001")
    assert result["estimate_change"] == 1.0
    assert result["source_time"] == "2026-07-22"
    assert result["source_time_precision"] == "date"
    assert result["fetched_at"] != result["source_time"]


def test_primary_daily_returns_are_compounded_into_cumulative_return():
    points = _json_var(JS, "Data_netWorthTrend", [])
    history = _build_primary_nav_history(points)
    assert history[0]["ac_return"] == 0.5
    assert history[1]["ac_return"] == 2.309
    assert history[1]["ac_return"] != points[1]["equityReturn"]


def test_source_health_tracks_primary(monkeypatch):
    """主源成功/失败计数与最近错误记录（用基线增量，规避模块级计数器跨用例污染）。"""
    from service import eastmoney as em
    base = em.source_health()

    # 主源成功 → primary_ok +1
    monkeypatch.setattr(em, "_fetch_detail_pingzhong",
                        lambda code: {"code": code, "nav_history": [{"date": "2024-01-01", "nav": 1.0}]})
    em.fetch_detail("000001")
    assert em.source_health()["primary_ok"] == base["primary_ok"] + 1

    # 主源抛异常 → 降级备源；primary_fail +1 且记录 last_primary_error
    def _boom(code):
        raise RuntimeError("格式变了")
    monkeypatch.setattr(em, "_fetch_detail_pingzhong", _boom)
    monkeypatch.setattr(em, "_fetch_detail_fallback",
                        lambda code: {"code": code, "source": "fallback", "nav_history": []})
    em.fetch_detail("000002")
    h = em.source_health()
    assert h["primary_fail"] == base["primary_fail"] + 1
    assert h["fallback_used"] >= base["fallback_used"] + 1
    assert h["last_primary_error"]["code"] == "000002"
    assert 0 <= h["primary_fail_rate"] <= 100
