"""天天基金 pingzhongdata JS 文本的解析函数单测（用内联样本，绝不打网络）。"""
from service.eastmoney import _json_var, _num, _str_var

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
