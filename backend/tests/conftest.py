"""共享测试夹具：合成净值序列与详情字典（不依赖任何网络数据源）。"""
from datetime import datetime, timedelta

import pytest


def _make_navs(n=500, r=0.0008, start="2022-01-03"):
    """生成 n 个连续日历日的净值点，按日收益 r 等比增长（r>0 上涨 / r<0 下跌）。

    ac_return 用 (nav-1)*100 填充，使「分红复权」序列与单位净值一致，
    便于 timing._series 走复权分支。
    """
    d0 = datetime.strptime(start, "%Y-%m-%d")
    out = []
    for i in range(n):
        nav = round((1 + r) ** i, 6)
        out.append({
            "date": (d0 + timedelta(days=i)).strftime("%Y-%m-%d"),
            "nav": nav,
            "ac_return": round((nav - 1) * 100, 4),
        })
    return out


@pytest.fixture
def make_navs():
    return _make_navs


@pytest.fixture
def uptrend(make_navs):
    return make_navs(n=500, r=0.0008)


@pytest.fixture
def downtrend(make_navs):
    return make_navs(n=500, r=-0.0008)


@pytest.fixture
def sample_detail(uptrend):
    return {
        "code": "000001", "name": "测试基金", "type": "混合型-偏股",
        "ret_1y": 12.0, "ret_3y": 40.0,
        "rank_in_type": 100, "rank_total": 1000,
        "manager": "张三", "manager_worktime": "8年又0天", "buy_rate": 0.15,
        "nav_history": uptrend,
    }
