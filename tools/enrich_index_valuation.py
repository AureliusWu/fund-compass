#!/usr/bin/env python3
"""司南基金 · 指数估值富集（akshare，CI 跑）。V3-5「真实 PE/PB 估值」数据管线第一步。

取各主流宽基指数的历史 PE/PB，算「当前值在历史中的百分位」作为估值分位，
→ frontend/public/data/index-valuation.json，供步骤2接入 timing 估值层。

数据源（akshare 1.18.64 实测：funddb 系列已被移除）：
  stock_index_pe_lg / stock_index_pb_lg —— 乐咕乐股，按指数中文名取历史 PE/PB。
分位自算（当前值在历史序列中的百分位），不依赖接口的分位字段，最稳。

环境：仅 CI 安装 akshare（见 requirements-enrich.txt）。后端运行时不依赖本脚本与 akshare。
本机（py3.14）装不了 akshare，只能在 CI（3.12）验证；故带 [diag]/[warn] 诊断，据此校准 symbol/列名。
"""
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "index-valuation.json")

# 乐咕乐股宽基 symbol（中文名）。失败的自动跳过并打 [warn]，据日志下轮调整。
LG_SYMBOLS = ["上证", "深证", "沪深300", "上证50", "中证500", "中证1000", "创业板", "科创版"]


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


def _value_col(df, keywords):
    """按 keywords 优先级挑一列；都不中则取首个非「日期/指数」列兜底。"""
    for k in keywords:
        for c in df.columns:
            if k in str(c):
                return c
    for c in df.columns:
        if c not in ("日期", "指数"):
            return c
    return None


def _series_from(ak, fn_name, sym, keywords, diag):
    fn = getattr(ak, fn_name, None)
    if fn is None:
        print(f"[warn] akshare 无接口 {fn_name}")
        return None, None, None
    try:
        df = fn(symbol=sym)
    except Exception as e:
        print(f"[warn] {fn_name}('{sym}') 失败: {e}")
        return None, None, None
    if df is None or not len(df):
        return None, None, None
    if diag:
        print(f"[diag] {fn_name}('{sym}') columns:", list(df.columns))
        print(df.tail(2).to_string())
    col = _value_col(df, keywords)
    cur, pct = _pct(df[col].tolist()) if col else (None, None)
    date = str(df["日期"].iloc[-1]) if "日期" in df.columns else None
    return cur, pct, date


def fetch_index_valuation(ak) -> list[dict]:
    out = []
    first = True
    for sym in LG_SYMBOLS:
        pe, pe_pct, d1 = _series_from(ak, "stock_index_pe_lg", sym, ("滚动市盈率", "市盈率"), first)
        pb, pb_pct, d2 = _series_from(ak, "stock_index_pb_lg", sym, ("市净率",), False)
        first = False
        if pe is None and pb is None:
            continue
        out.append({"name": sym, "pe": pe, "pe_pct": pe_pct, "pb": pb, "pb_pct": pb_pct,
                    "date": d1 or d2 or datetime.date.today().isoformat()})
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
    payload = {"updated": datetime.date.today().isoformat(), "source": "legulegu", "indices": data}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"done: {len(data)} indices → {OUT}")
    print("[result]", json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
