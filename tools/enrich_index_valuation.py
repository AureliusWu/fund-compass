#!/usr/bin/env python3
"""司南基金指数估值：有界匿名乐咕请求，同日加权 PE/PB 与历史分位。

单 Session/一次匿名 bootstrap、每 symbol/metric 一次请求；403/429 全源停止。
15秒间隔/240秒总预算仅约束负载，不证明免费源配额或恢复。
失败保留旧产物；六核心、源日期、7天与30样本门槛不降低。
"""
import datetime
import json
import math
import os
import re
import sys
from pathlib import Path

from index_valuation_source import LeguIndexSource, SourceMetricError, SourceStopped

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "index-valuation.json")
BEIJING = datetime.timezone(datetime.timedelta(hours=8), "Asia/Shanghai")
CORE_INDICES = {"沪深300", "上证50", "上证180", "中证100", "中证500", "中证1000"}
FETCH_ATTEMPTS = 3
MAX_CORE_AGE_DAYS = 7

# 乐咕乐股 symbol（中文全称，简称可能 KeyError）。key 是司南内部标准指数名，
# value 是按稳定性排序的候选 symbol；CI 逐个尝试，成功才写入。
LG_SYMBOLS = {
    "沪深300": ["沪深300"],
    "上证50": ["上证50"],
    "上证180": ["上证180"],
    "中证100": ["中证100"],
    "中证500": ["中证500"],
    "中证1000": ["中证1000"],
    "创业板指": ["创业板指", "创业板指数", "创业板综"],
    "科创50": ["科创50", "上证科创板50成份指数"],
    "中证红利": ["中证红利"],
    "中证主要消费": ["中证主要消费", "中证消费", "消费指数"],
    "中证白酒": ["中证白酒", "中证酒"],
    "中证医药": ["中证医药", "中证医药卫生", "全指医药"],
    "证券公司": ["证券公司", "中证全指证券公司", "证券指数"],
    "半导体": ["半导体", "中证全指半导体", "国证芯片"],
}

UNSUPPORTED_INDICES = [
    {"name": "恒生科技", "reason": "乐咕乐股 A 股指数 PE/PB 源不稳定覆盖港股指数，暂回退净值代理"},
    {"name": "纳斯达克100", "reason": "海外指数 PE/PB 免登录历史分位源未接入，暂回退净值代理"},
    {"name": "标普500", "reason": "海外指数 PE/PB 免登录历史分位源未接入，暂回退净值代理"},
]
UNSUPPORTED_INDICES += [
    {"name": name, "reason": "当前已核对的乐咕 symbol 映射不含该指数；未请求，不替代为其他指数，保持净值代理"}
    for name in sorted(set(LG_SYMBOLS) - LeguIndexSource.supported_symbols)
]


def _pct(series):
    """当前值（序列末位）在历史中的百分位（%）；样本不足返回 (None, None)。"""
    vals = []
    for v in series:
        try:
            f = float(v)
            if f == f:  # 排除 NaN
                vals.append(f)
        except (TypeError, ValueError):
            pass
    if len(vals) < 30:
        return None, None
    cur = vals[-1]
    below = sum(1 for v in vals if v <= cur)
    return round(cur, 2), round(below / len(vals) * 100, 1)


def _value_col(df, prefer):
    """仅认可乐咕已核对的市值加权滚动 PE/PB 列；未知或歧义列失败关闭。"""
    supported = {"滚动市盈率", "市净率"}
    requested = supported.intersection(prefer)
    if len(requested) != 1:
        return None
    column = next(iter(requested))
    # 重复同名列在真实 DataFrame 中会返回多列，不能静默选第一列。
    return column if list(df.columns).count(column) == 1 else None


def _series_from(ak, fn_name, sym, prefer, dump_cols):
    fn = getattr(ak, fn_name, None)
    if fn is None:
        print(f"[warn] akshare 无接口 {fn_name}")
        return None, None, None, None
    try:
        df = fn(symbol=sym)
    except SourceStopped:
        raise
    except Exception as e:
        # Public transport emits only fixed safe errors; never print raw URL/body.
        reason = str(e) if isinstance(e, SourceMetricError) else type(e).__name__
        print(f"[warn] {fn_name}('{sym}') 失败: {reason}")
        return None, None, None, None
    if df is None or not len(df):
        return None, None, None, None
    if dump_cols:
        print(f"[diag] {fn_name}('{sym}') columns: {list(df.columns)}")
    col = _value_col(df, prefer)
    if not col or list(df.columns).count("日期") != 1:
        return None, None, None, col
    # Keep date and value from the same row.  Upstream ordering is not a
    # contract, and a trailing NaN must not lend its date to an older value.
    dated_values: list[tuple[str, float]] = []
    for raw_date, raw_value in zip(df["日期"].tolist(), df[col].tolist()):
        source_date = _source_date(raw_date)
        if source_date is None or isinstance(raw_value, bool):
            continue
        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(value):
            dated_values.append((source_date, value))
    dated_values.sort(key=lambda item: item[0])
    cur, pct = _pct([value for _, value in dated_values])
    date = dated_values[-1][0] if cur is not None else None
    return cur, pct, date, col


def _source_date(value) -> str | None:
    """Return a real source date; never substitute the job's run date."""
    if isinstance(value, datetime.datetime):
        return value.date().isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    text = str(value or "").strip()
    match = re.match(r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:$|[ T])", text)
    if not match:
        return None
    try:
        return datetime.date(*(int(part) for part in match.groups())).isoformat()
    except ValueError:
        return None


def _finite_number(value, *, positive: bool = False, percentile: bool = False) -> bool:
    if type(value) not in (int, float):
        return False
    try:
        finite = math.isfinite(value)
    except OverflowError:
        return False
    if not finite:
        return False
    if positive and value <= 0:
        return False
    if percentile and not 0 <= value <= 100:
        return False
    return True


def _canonical_source_date(value) -> str | None:
    """Published records contain native, canonical ISO dates, not date-like objects."""
    if type(value) is not str:
        return None
    parsed = _source_date(value)
    return parsed if parsed == value else None


def _beijing_today(now: datetime.datetime | None = None) -> datetime.date:
    instant = now if now is not None else datetime.datetime.now(datetime.timezone.utc)
    return instant.astimezone(BEIJING).date()


def _valid_core_item(item: dict) -> bool:
    if type(item) is not dict or type(item.get("name")) is not str:
        return False
    source_date = _canonical_source_date(item.get("date"))
    return (
        source_date is not None
        and item.get("name") in CORE_INDICES
        and _finite_number(item.get("pe"), positive=True)
        and _finite_number(item.get("pb"), positive=True)
        and _finite_number(item.get("pe_pct"), percentile=True)
        and _finite_number(item.get("pb_pct"), percentile=True)
        and type(item.get("pe_date")) is str
        and type(item.get("pb_date")) is str
        and item.get("pe_date") == source_date
        and item.get("pb_date") == source_date
    )


def _fetch_one_index(ak, name, candidates, dumped):
    attempts = getattr(ak, "fetch_attempts", FETCH_ATTEMPTS)
    if type(attempts) is not int or not 1 <= attempts <= FETCH_ATTEMPTS:
        raise ValueError("invalid_index_fetch_attempt_budget")
    # The real public transport is single-attempt. Legacy injectable frame
    # providers retain their existing bounded parser/retry contract.
    last_warn = None
    partial = None

    def item_for(sym, source_date, pe_data=None, pb_data=None):
        return {
            "name": name,
            "symbol": sym,
            "pe": pe_data[0] if pe_data is not None else None,
            "pe_pct": pe_data[1] if pe_data is not None else None,
            "pe_date": source_date if pe_data is not None else None,
            "pb": pb_data[0] if pb_data is not None else None,
            "pb_pct": pb_data[1] if pb_data is not None else None,
            "pb_date": source_date if pb_data is not None else None,
            "date": source_date,
        }

    for sym in candidates:
        # 仅在当前 symbol 的有界重试内保留成功观测；不读取旧产物，
        # 不跨候选 symbol 拼接，也不把不同源日期的 PE/PB 当成同日数据。
        pe_by_date = {}
        pb_by_date = {}
        for attempt in range(1, attempts + 1):
            pe, pe_pct, d1, pe_col = _series_from(
                ak,
                "stock_index_pe_lg",
                sym,
                ("滚动市盈率",),
                not dumped and attempt == 1,
            )
            pb, pb_pct, d2, pb_col = _series_from(
                ak, "stock_index_pb_lg", sym, ("市净率",), False,
            )
            if pe is not None and d1 is not None and _source_date(d1) == d1:
                pe_by_date[d1] = (pe, pe_pct, pe_col)
            if pb is not None and d2 is not None and _source_date(d2) == d2:
                pb_by_date[d2] = (pb, pb_pct, pb_col)
            common_dates = pe_by_date.keys() & pb_by_date.keys()
            if common_dates:
                source_date = max(common_dates)
                pe_data = pe_by_date[source_date]
                pb_data = pb_by_date[source_date]
                print(f"[col] {name}: symbol={sym} pe列={pe_data[2]} pb列={pb_data[2]} source_date={source_date}")
                return item_for(sym, source_date, pe_data, pb_data)
            if pe is None and pb is None:
                last_warn = sym
                if attempt < attempts:
                    print(f"[warn] {name}: symbol={sym} 空响应，重试 {attempt}/{attempts}")
                continue
            if pe_by_date and pb_by_date:
                print(
                    f"[warn] {name}: PE/PB 源日期不一致 symbol={sym} "
                    f"pe_date={max(pe_by_date)} pb_date={max(pb_by_date)} "
                    f"attempt={attempt}/{attempts}"
                )
                last_warn = sym
                continue
            if attempt < attempts:
                print(f"[warn] {name}: symbol={sym} PE/PB 不完整，重试 {attempt}/{attempts}")
        if pe_by_date and not pb_by_date:
            source_date = max(pe_by_date)
            partial = item_for(sym, source_date, pe_data=pe_by_date[source_date])
        elif pb_by_date and not pe_by_date:
            source_date = max(pb_by_date)
            partial = item_for(sym, source_date, pb_data=pb_by_date[source_date])
    if partial is not None:
        return partial
    print(f"[warn] {name} 候选 symbol 均失败: {candidates} last={last_warn}")
    return None


def fetch_index_valuation(ak) -> list[dict]:
    out = []
    dumped = False
    for name, candidates in LG_SYMBOLS.items():
        supported = getattr(ak, "supported_symbols", None)
        if supported is not None:
            candidates = [symbol for symbol in candidates if symbol in supported]
            if not candidates:
                print(f"[unsupported] {name}: no matching supported source symbol")
                continue
        item = _fetch_one_index(ak, name, candidates, dumped)
        if item:
            dumped = True
            out.append(item)
    return out


def main(source=None):
    owns_source = source is None
    ak = LeguIndexSource() if owns_source else source
    print("[diag] index valuation source: bounded anonymous legulegu")
    try:
        data = fetch_index_valuation(ak)
    except Exception as e:
        reason = str(e) if isinstance(e, SourceMetricError) else type(e).__name__
        print("指数估值富集失败:", reason)
        return 1
    finally:
        if isinstance(ak, LeguIndexSource):
            for event in ak.public_events():
                print("[source] " + json.dumps(event, ensure_ascii=False, allow_nan=False))
            ak.close()
    if type(data) is not list or any(
        type(item) is not dict
        or type(item.get("name")) is not str
        or not item["name"]
        for item in data
    ):
        print("指数估值返回非原生记录合同")
        return 1
    valid_core = {item["name"] for item in data if _valid_core_item(item)}
    missing_core = sorted(CORE_INDICES - valid_core)
    if missing_core:
        print(f"核心指数估值不完整或字段无效：{len(valid_core)}/{len(CORE_INDICES)}")
        return 1

    returned = {item["name"] for item in data}

    source_dates = [_canonical_source_date(item.get("date")) for item in data]
    if not source_dates or any(date is None for date in source_dates):
        print("指数估值含缺失或无效源日期")
        return 1
    now = datetime.datetime.now(BEIJING)
    today = _beijing_today(now)
    for item, source_date in zip(data, source_dates):
        age_days = (today - datetime.date.fromisoformat(source_date)).days
        if age_days < 0:
            print("指数估值源日期晚于当前北京时间日期")
            return 1
        if item["name"] in CORE_INDICES and age_days > MAX_CORE_AGE_DAYS:
            print("核心指数估值源日期已过期")
            return 1
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    missing = sorted(set(LG_SYMBOLS) - returned)
    payload = {
        "schema_version": 2,
        # updated 是最保守的源数据日期，不再用任务运行日期冒充行情日期。
        "updated": min(date for date in source_dates if date is not None),
        "fetched_at": now.isoformat(timespec="seconds"),
        "source": "legulegu",
        "indices": data,
        "coverage": {
            "core_requested": len(CORE_INDICES),
            "core_returned": len(valid_core),
            "requested": len(LG_SYMBOLS),
            "returned": len(data),
            "missing": missing,
        },
        "unsupported": UNSUPPORTED_INDICES,
    }
    target = Path(OUT)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(target)
    print(f"done: {len(data)} indices → {OUT}")
    print(f"[coverage] core={len(CORE_INDICES)}/{len(CORE_INDICES)} total={len(data)}/{len(LG_SYMBOLS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
