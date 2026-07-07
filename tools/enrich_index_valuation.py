#!/usr/bin/env python3
"""司南基金 · 指数估值富集（akshare，CI 跑）。V3-5「真实 PE/PB 估值」数据管线第一步。

取各主流宽基指数的历史 PE/PB，算「当前值在历史中的百分位」作为估值分位，
→ frontend/public/data/index-valuation.json，供步骤2接入 timing 估值层。

数据源（akshare 1.18.64 实测：funddb 系列已被移除）：
  stock_index_pe_lg / stock_index_pb_lg —— 乐咕乐股，按指数中文**全称**取历史 PE/PB。
分位自算（当前值在历史序列中的百分位），不依赖接口的分位字段，最稳。
指数整体口径用「市值加权」列（避开等权/中位数，等权会被小盘高 PE 拉高）。

环境：仅 CI 安装 akshare（见 requirements-enrich.txt）。后端运行时不依赖本脚本与 akshare。
本机（py3.14）装不了 akshare，只能在 CI（3.12）验证；故带 [diag]/[warn]/[col] 诊断，据此校准。
"""
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "index-valuation.json")

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


def _value_col(df, prefer, avoid=("等权", "中位数")):
    """按 prefer 优先级挑列，优先排除 avoid（等权/中位数）；再退而求其次；最后兜底首个数值列。"""
    cols = [c for c in df.columns if c not in ("日期", "指数")]
    for k in prefer:                                  # 含 prefer 且不含 avoid（市值加权口径）
        for c in cols:
            if k in str(c) and not any(a in str(c) for a in avoid):
                return c
    for k in prefer:                                  # 退一步：含 prefer（可能等权）
        for c in cols:
            if k in str(c):
                return c
    return cols[0] if cols else None


def _series_from(ak, fn_name, sym, prefer, dump_cols):
    fn = getattr(ak, fn_name, None)
    if fn is None:
        print(f"[warn] akshare 无接口 {fn_name}")
        return None, None, None, None
    try:
        df = fn(symbol=sym)
    except Exception as e:
        print(f"[warn] {fn_name}('{sym}') 失败: {e}")
        return None, None, None, None
    if df is None or not len(df):
        return None, None, None, None
    if dump_cols:
        print(f"[diag] {fn_name}('{sym}') columns: {list(df.columns)}")
    col = _value_col(df, prefer)
    cur, pct = _pct(df[col].tolist()) if col else (None, None)
    date = str(df["日期"].iloc[-1]) if "日期" in df.columns else None
    return cur, pct, date, col


def _fetch_one_index(ak, name, candidates, dumped):
    last_warn = None
    for sym in candidates:
        pe, pe_pct, d1, pe_col = _series_from(ak, "stock_index_pe_lg", sym, ("滚动市盈率", "市盈率"), not dumped)
        pb, pb_pct, d2, pb_col = _series_from(ak, "stock_index_pb_lg", sym, ("市净率",), False)
        if pe is None and pb is None:
            last_warn = sym
            continue
        print(f"[col] {name}: symbol={sym} pe列={pe_col} pb列={pb_col}")
        return {
            "name": name,
            "symbol": sym,
            "pe": pe,
            "pe_pct": pe_pct,
            "pb": pb,
            "pb_pct": pb_pct,
            "date": d1 or d2 or datetime.date.today().isoformat(),
        }
    print(f"[warn] {name} 候选 symbol 均失败: {candidates} last={last_warn}")
    return None


def fetch_index_valuation(ak) -> list[dict]:
    out = []
    dumped = False
    for name, candidates in LG_SYMBOLS.items():
        item = _fetch_one_index(ak, name, candidates, dumped)
        if item:
            dumped = True
            out.append(item)
    return out


def main():
    import akshare as ak  # 仅 CI 有
    print("[diag] akshare version:", getattr(ak, "__version__", "?"))
    try:
        data = fetch_index_valuation(ak)
    except Exception as e:
        print("指数估值富集失败:", e)
        return 1
    if not data:
        print("无指数估值数据（symbol/列名需据 [diag]/[warn] 调整）")
        return 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = {
        "updated": datetime.date.today().isoformat(),
        "source": "legulegu",
        "indices": data,
        "unsupported": UNSUPPORTED_INDICES,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"done: {len(data)} indices → {OUT}")
    print("[result]", json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
