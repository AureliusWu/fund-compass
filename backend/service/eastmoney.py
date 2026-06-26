"""天天基金公开数据源（主源）。

- 基金列表：http://fund.eastmoney.com/js/fundcode_search.js
- 基金详情：http://fund.eastmoney.com/pingzhongdata/{code}.js（含费率/收益/经理/规模/净值走势）

AKShare 作为备源（M1 暂未接入，后续在此模块加 fallback）。
"""
import json
import re
from datetime import datetime, timedelta, timezone

import requests

CST = timezone(timedelta(hours=8))
_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "http://fund.eastmoney.com/"}
_TIMEOUT = 15


def _get(url: str) -> str:
    r = requests.get(url, headers=_HEADERS, timeout=_TIMEOUT)
    r.raise_for_status()
    r.encoding = "utf-8"
    return r.text


def fetch_universe() -> list[dict]:
    """全部基金 [{code,name,type,pinyin}]。"""
    txt = _get("http://fund.eastmoney.com/js/fundcode_search.js")
    arr = json.loads(txt[txt.index("["): txt.rindex("]") + 1])
    out = []
    for x in arr:
        if len(x) >= 4 and x[0]:
            out.append({"code": x[0], "name": x[2], "type": x[3], "pinyin": x[1]})
    return out


def _raw_var(text: str, name: str):
    m = re.search(r"var\s+" + name + r"\s*=\s*(.*?);", text, re.S)
    return m.group(1).strip() if m else None


def _str_var(text: str, name: str):
    raw = _raw_var(text, name)
    return raw.strip().strip('"') if raw is not None else None


def _json_var(text: str, name: str, default):
    raw = _raw_var(text, name)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def fetch_detail(code: str) -> dict:
    """单只基金详情 + 净值历史（来自 pingzhongdata）。"""
    txt = _get(f"http://fund.eastmoney.com/pingzhongdata/{code}.js")
    name = _str_var(txt, "fS_name")
    if not name:
        raise ValueError(f"无效基金或无数据：{code}")

    # 收益率：syl_1n=近1年, syl_3y=近3年, syl_6y=近6月, syl_1y=近1月
    ret_1y = _num(_str_var(txt, "syl_1n"))
    ret_3y = _num(_str_var(txt, "syl_3y"))
    ret_6m = _num(_str_var(txt, "syl_6y"))
    ret_1m = _num(_str_var(txt, "syl_1y"))

    # 经理（取在任第一位）
    mgrs = _json_var(txt, "Data_currentFundManager", []) or []
    manager = mgrs[0].get("name") if mgrs else None
    manager_worktime = mgrs[0].get("workTime") if mgrs else None

    # 规模（亿元，取最新一期）
    scale = None
    fs = _json_var(txt, "Data_fluctuationScale", {}) or {}
    series = fs.get("series") or []
    if series:
        scale = _num(series[-1].get("y"))

    # 同类排名
    rank_in_type = rank_total = None
    rt = _json_var(txt, "Data_rateInSimilarType", []) or []
    if rt:
        last = rt[-1]
        try:
            rank_in_type = int(last["y"]) if last.get("y") is not None else None
        except (TypeError, ValueError):
            rank_in_type = None
        try:
            rank_total = int(last.get("sc"))
        except (TypeError, ValueError):
            rank_total = None

    # 单位净值走势 → 历史 + 最新
    nav_history = []
    for p in _json_var(txt, "Data_netWorthTrend", []) or []:
        ts, y = p.get("x"), p.get("y")
        if ts is None or y is None:
            continue
        d = datetime.fromtimestamp(ts / 1000, tz=CST).strftime("%Y-%m-%d")
        nav_history.append({"date": d, "nav": y, "ac_return": p.get("equityReturn")})
    latest_nav = nav_history[-1]["nav"] if nav_history else None
    latest_nav_date = nav_history[-1]["date"] if nav_history else None

    return {
        "code": code,
        "name": name,
        "buy_rate": _num(_str_var(txt, "fund_Rate")),
        "source_rate": _num(_str_var(txt, "fund_sourceRate")),
        "ret_1m": ret_1m, "ret_6m": ret_6m, "ret_1y": ret_1y, "ret_3y": ret_3y,
        "manager": manager, "manager_worktime": manager_worktime,
        "scale": scale,
        "rank_in_type": rank_in_type, "rank_total": rank_total,
        "latest_nav": latest_nav, "latest_nav_date": latest_nav_date,
        "nav_history": nav_history,
    }
