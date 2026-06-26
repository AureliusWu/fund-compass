"""择时回测：按月用 V1 三层信号决定目标仓位，对比「一直持有」基准。

简化模型（非精确模拟，仅供策略验证参考）：
- 每月第一个交易日按截至当时的净值算信号 → 目标股票仓位 w；其余视为现金（不计息）；
- 月间组合收益 = w × 基金涨跌；基准为始终满仓持有。
- 不计申赎费、不滑点。需要 ≥120 个净值点起步（MA120 等指标要历史）。
"""
from strategy.timing import timing_signal

WEIGHT = {"买入": 1.0, "定投": 0.75, "持有": 0.5, "减仓": 0.25}


def _max_drawdown(curve):
    peak = 1.0
    mdd = 0.0
    for p in curve:
        peak = max(peak, p["v"])
        mdd = min(mdd, p["v"] / peak - 1)
    return round(mdd * 100, 2)


def backtest(detail):
    navs = [(h["date"], h["nav"]) for h in (detail.get("nav_history") or []) if h.get("nav")]
    if len(navs) < 150:
        return {"available": False, "reason": "净值历史不足，无法回测"}

    # 月度调仓点（每月首个交易日），且需累计 ≥120 个点
    seen, month_idx = set(), []
    for i, (d, _) in enumerate(navs):
        ym = d[:7]
        if ym not in seen:
            seen.add(ym)
            month_idx.append(i)
    pts = [i for i in month_idx if i >= 120]
    if len(pts) < 6:
        return {"available": False, "reason": "可回测区间不足"}

    strat, bench = 1.0, 1.0
    strat_curve, bench_curve, actions = [], [], []
    for k in range(len(pts) - 1):
        i, j = pts[k], pts[k + 1]
        sig = timing_signal({"nav_history": [{"date": d, "nav": n} for d, n in navs[:i + 1]]})
        w = WEIGHT.get(sig["signal"], 0.5)
        ret = navs[j][1] / navs[i][1] - 1
        strat *= 1 + w * ret
        bench *= 1 + ret
        strat_curve.append({"date": navs[j][0], "v": round(strat, 4)})
        bench_curve.append({"date": navs[j][0], "v": round(bench, 4)})
        actions.append({"date": navs[i][0], "signal": sig["signal"], "weight": w})

    strat_ret = round((strat - 1) * 100, 2)
    bench_ret = round((bench - 1) * 100, 2)
    wins = sum(1 for a, b in zip(strat_curve, bench_curve) if a["v"] >= b["v"])
    return {
        "available": True,
        "start": navs[pts[0]][0], "end": navs[-1][0], "rebalances": len(pts) - 1,
        "strategy": {"total_return": strat_ret, "max_drawdown": _max_drawdown(strat_curve), "curve": strat_curve},
        "benchmark": {"total_return": bench_ret, "max_drawdown": _max_drawdown(bench_curve), "curve": bench_curve},
        "outperform": round(strat_ret - bench_ret, 2),
        "win_rate": round(wins / len(strat_curve) * 100, 1) if strat_curve else None,
        "actions": actions[-12:],
    }
