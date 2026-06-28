#!/usr/bin/env python3
"""司南基金 · 择时信号有效性批量验证（P2 背书）。

从 screener 各类型抽样基金，抓真实净值，用 strategy.backtest 跑「择时策略 vs 一直持有」，
统计：跑赢比例、平均超额、平均胜率，按类型分组。回答「这套择时信号到底值不值得日常依赖」。
纯 Python + requests，本机可跑（无 pandas/fastapi 依赖）。

用法（在 backend 目录下）：PYTHONUTF8=1 python ../tools/validate_signal.py [每类抽样数]
"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from service.eastmoney import fetch_detail  # noqa: E402
from strategy import backtest  # noqa: E402

SCREENER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "frontend", "public", "data", "screener.json")


def sample(n_per_type: int):
    funds = json.load(open(SCREENER, encoding="utf-8"))["funds"]
    by: dict[str, list[str]] = {}
    for f in funds:
        by.setdefault(f["t"], []).append(f["c"])
    random.seed(42)
    out = []
    for t, codes in by.items():
        random.shuffle(codes)
        out += [(c, t) for c in codes[:n_per_type]]
    return out


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    funds = sample(n)
    print(f"抽样 {len(funds)} 只，逐只回测中…\n")
    rows = []
    for i, (code, t) in enumerate(funds, 1):
        try:
            d = fetch_detail(code)
            bt = backtest(d)
        except Exception as e:
            print(f"  [{i}/{len(funds)}] {code} 失败 {e}")
            continue
        if not bt.get("available") or not bt.get("strategy"):
            continue
        s = bt["strategy"]["total_return"]
        b = bt["benchmark"]["total_return"]
        rows.append({"code": code, "type": t, "strat": s, "bench": b,
                     "out": bt.get("outperform", s - b), "win": bt.get("win_rate")})
        print(f"  [{i}/{len(funds)}] {code} {t[:4]:<4} 策略 {s:+.1f}% vs 持有 {b:+.1f}% 超额 {(s-b):+.1f}% 胜率 {bt.get('win_rate')}%")

    if not rows:
        print("无有效回测"); return
    won = [r for r in rows if r["out"] > 0]
    avg_out = sum(r["out"] for r in rows) / len(rows)
    avg_win = sum(r["win"] for r in rows if r["win"] is not None) / max(1, sum(1 for r in rows if r["win"] is not None))
    print("\n===== 汇总 =====")
    print(f"有效样本 {len(rows)} 只")
    print(f"择时跑赢「一直持有」: {len(won)}/{len(rows)} = {len(won)/len(rows)*100:.0f}%")
    print(f"平均超额收益: {avg_out:+.1f}%")
    print(f"平均胜率(调仓方向): {avg_win:.0f}%")
    print("\n按类型:")
    for t in sorted(set(r["type"] for r in rows)):
        g = [r for r in rows if r["type"] == t]
        gw = sum(1 for r in g if r["out"] > 0)
        print(f"  {t:<6} 样本{len(g):>2}  跑赢{gw}/{len(g)}  平均超额{sum(r['out'] for r in g)/len(g):+.1f}%")


if __name__ == "__main__":
    main()
