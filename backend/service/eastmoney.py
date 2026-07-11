"""天天基金公开数据源（主源）。

- 基金列表：http://fund.eastmoney.com/js/fundcode_search.js
- 基金详情：http://fund.eastmoney.com/pingzhongdata/{code}.js（含费率/收益/经理/规模/净值走势）

AKShare 作为备源（M1 暂未接入，后续在此模块加 fallback）。
"""
import json
import logging
import re
from datetime import datetime, timedelta, timezone

import requests

log = logging.getLogger(__name__)

CST = timezone(timedelta(hours=8))
_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "http://fund.eastmoney.com/"}
_TIMEOUT = (4, 10)


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


def _build_primary_nav_history(points: list[dict]) -> list[dict]:
    """把主源每日涨跌连乘为累计总收益，统一 ac_return 的跨源语义。"""
    history = []
    total_return_index = 1.0
    for point in points:
        ts, nav = point.get("x"), _num(point.get("y"))
        if ts is None or nav is None or nav <= 0:
            continue
        daily_return = _num(point.get("equityReturn"))
        if daily_return is not None:
            total_return_index *= 1 + daily_return / 100
        date = datetime.fromtimestamp(ts / 1000, tz=CST).strftime("%Y-%m-%d")
        history.append({
            "date": date,
            "nav": nav,
            "ac_return": round((total_return_index - 1) * 100, 6),
        })
    return history


def _fetch_detail_pingzhong(code: str) -> dict:
    """主源：单只基金详情 + 净值历史（pingzhongdata，字段最全）。"""
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
    nav_history = _build_primary_nav_history(_json_var(txt, "Data_netWorthTrend", []) or [])
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
        "source": "primary",
    }


def _fallback_name(code: str) -> str | None:
    """备源辅助：从天天基金估值接口（另一主机）取基金名。"""
    try:
        txt = _get(f"https://fundgz.1234567.com.cn/js/{code}.js?rt={int(datetime.now().timestamp() * 1000)}")
        m = re.search(r"jsonpgz\((.*)\)", txt)
        return json.loads(m.group(1)).get("name") if m else None
    except Exception:
        log.debug("备源取名失败 code=%s", code, exc_info=True)
        return None


def _fetch_detail_fallback(code: str) -> dict:
    """备源：f10 历史净值（api.fund.eastmoney.com，与主源不同主机/接口）。

    主源 pingzhongdata 挂掉/被改时兜底。只保证核心：净值历史（单位净值 + 累计净值=天然复权）
    + 名称 + 最新净值，足够支撑评分/择时/回测；经理/规模/排名/费率等富字段降级为空。
    """
    r = requests.get(
        "https://api.fund.eastmoney.com/f10/lsjz",
        params={"fundCode": code, "pageIndex": 1, "pageSize": 1200,
                "_": int(datetime.now().timestamp() * 1000)},
        headers={"User-Agent": "Mozilla/5.0", "Referer": "http://fundf10.eastmoney.com/"},
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    lst = ((r.json() or {}).get("Data") or {}).get("LSJZList") or []
    nav_history = []
    for it in reversed(lst):  # 接口按日期倒序，反转为时间正序
        d = it.get("FSRQ")
        dwjz = _num(it.get("DWJZ"))
        ljjz = _num(it.get("LJJZ"))
        if not d or dwjz is None:
            continue
        # 累计净值起点≈1.0 → (LJJZ-1)*100 近似累计收益率，供 _series 复权用
        acr = (ljjz - 1) * 100 if ljjz is not None else None
        nav_history.append({"date": d, "nav": dwjz, "ac_return": acr})
    if not nav_history:
        raise ValueError(f"备源亦无净值数据：{code}")
    return {
        "code": code,
        "name": _fallback_name(code) or code,
        "buy_rate": None, "source_rate": None,
        "ret_1m": None, "ret_6m": None, "ret_1y": None, "ret_3y": None,
        "manager": None, "manager_worktime": None,
        "scale": None,
        "rank_in_type": None, "rank_total": None,
        "latest_nav": nav_history[-1]["nav"], "latest_nav_date": nav_history[-1]["date"],
        "nav_history": nav_history,
        "source": "fallback",
    }


# ── 主源健康统计（进程内、单实例视角；重启清零、多 worker 各自独立）──────────
# 主源 pingzhongdata 靠正则解析 JS 文本，天天基金改版会让解析失败而静默降级备源。
# 这里累计主源成功/失败，经 /api/health 暴露，让「主源悄悄失准」可被人工发现。
_stats = {"primary_ok": 0, "primary_fail": 0, "fallback_used": 0, "last_primary_error": None}


def _record_primary_ok() -> None:
    _stats["primary_ok"] += 1


def _record_primary_fail(code: str, reason: str) -> None:
    _stats["primary_fail"] += 1
    _stats["fallback_used"] += 1
    _stats["last_primary_error"] = {
        "code": code, "reason": reason,
        "at": datetime.now(CST).isoformat(timespec="seconds"),
    }


def source_health() -> dict:
    """主源健康快照：成功/失败计数、失败率、最近一次失败、是否疑似降级。"""
    total = _stats["primary_ok"] + _stats["primary_fail"]
    fail_rate = round(_stats["primary_fail"] / total * 100, 1) if total else 0.0
    return {
        "primary_ok": _stats["primary_ok"],
        "primary_fail": _stats["primary_fail"],
        "fallback_used": _stats["fallback_used"],
        "primary_fail_rate": fail_rate,
        "last_primary_error": _stats["last_primary_error"],
        # 有一定样本且失败率过半 → 主源可能挂了/改了格式，值得人工介入
        "degraded": total >= 5 and fail_rate >= 50,
    }


def fetch_detail(code: str) -> dict:
    """单只基金详情 + 净值历史。主源 pingzhongdata；失败或无净值时降级到备源 f10 lsjz。"""
    try:
        d = _fetch_detail_pingzhong(code)
        if d.get("nav_history"):
            _record_primary_ok()
            return d
        log.warning("主源 pingzhongdata 无净值，降级备源 f10 code=%s", code)
        _record_primary_fail(code, "主源无净值")
    except Exception as e:
        log.warning("主源 pingzhongdata 解析失败，降级备源 f10 code=%s", code, exc_info=True)
        _record_primary_fail(code, f"{type(e).__name__}: {e}")
    return _fetch_detail_fallback(code)
