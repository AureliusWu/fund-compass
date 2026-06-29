#!/usr/bin/env python3
"""司南基金 · 指数估值富集（akshare，CI 跑）。V3-5「真实 PE/PB 估值」数据管线第一步。

取各主流指数的 PE/PB 当前值与历史分位 → frontend/public/data/index-valuation.json，
供后续把择时估值层从「净值分位代理」升级为真实指数 PE/PB 分位（步骤 2 接入 timing）。

akshare 接口随版本变动，且本机（py3.14）装不了 akshare、只能在 CI（3.12）验证，
故本脚本做防御性取值 + **诊断打印**：首次 CI 跑时据 [diag] 输出校准列名/接口。

环境：仅 CI 安装 akshare（见 requirements-enrich.txt）。后端运行时不依赖本脚本与 akshare。
"""
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "index-valuation.json")


def _num(x):
    """转 float；非数/NaN → None。"""
    try:
        v = float(x)
        return v if v == v else None  # NaN != NaN
    except (TypeError, ValueError):
        return None


def _pick(row: dict, *names):
    """按候选列名取第一个非空值（列名随 akshare 版本变动，多给几个别名兜底）。"""
    for n in names:
        if n in row and row[n] is not None and str(row[n]).strip() != "":
            return row[n]
    return None


def fetch_index_valuation(ak) -> list[dict]:
    """funddb 指数估值名录：一次返回各指数当前 PE/PB 及其历史分位。"""
    df = ak.index_value_name_funddb()
    # ── 诊断：首次 CI 跑据此校准下方列名映射 ──
    print("[diag] columns:", list(df.columns))
    print("[diag] sample:\n", df.head(3).to_string())

    out = []
    for r in df.to_dict("records"):
        name = _pick(r, "指数名称", "指数", "名称")
        if not name:
            continue
        out.append({
            "name": str(name).strip(),
            "pe": _num(_pick(r, "最新PE", "PE", "市盈率")),
            "pe_pct": _num(_pick(r, "PE分位", "PE百分位", "市盈率百分位", "PE历史百分位")),
            "pb": _num(_pick(r, "最新PB", "PB", "市净率")),
            "pb_pct": _num(_pick(r, "PB分位", "PB百分位", "市净率百分位", "PB历史百分位")),
            "date": str(_pick(r, "更新时间", "日期", "更新日期") or datetime.date.today().isoformat()),
        })
    return out


def main():
    import akshare as ak  # 仅 CI 有

    try:
        data = fetch_index_valuation(ak)
    except Exception as e:
        print("指数估值富集失败（接口可能改名，见上方 [diag]）:", e)
        return 1
    if not data:
        print("无指数估值数据（接口列名可能变化，见上方 [diag]）")
        return 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = {"updated": datetime.date.today().isoformat(), "indices": data}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    # 抽样回显，确认分位字段确实有值
    sample = [d for d in data if d["pe_pct"] is not None][:5]
    print(f"done: {len(data)} indices → {OUT}")
    print("[sample with pe_pct]", json.dumps(sample, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
