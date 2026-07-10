"""择时回测：按月用 V1 三层信号决定目标仓位，对比「一直持有」基准。

简化模型（非精确模拟，仅供策略验证参考）：
- 每月第一个交易日按截至当时的净值算信号 → 目标股票仓位 w；其余视为计息现金；
- 月间组合收益 = w × 基金涨跌 + 现金收益 - 换仓摩擦；基准为始终满仓持有。
- 默认计申赎费、滑点、现金收益和最短持有期，并同时返回无摩擦结果。
"""
import datetime as dt

from strategy.registry import DEFAULT_WEIGHTS, active_weights
from strategy.timing import timing_signal

WEIGHT = DEFAULT_WEIGHTS
DEFAULT_ASSUMPTIONS = {
    "buy_fee": 0.0015,
    "sell_fee": 0.005,
    "slippage": 0.0002,
    "annual_cash_yield": 0.012,
    "min_hold_months": 1,
}


def _max_drawdown(curve):
    peak = 1.0
    mdd = 0.0
    for p in curve:
        peak = max(peak, p["v"])
        mdd = min(mdd, p["v"] / peak - 1)
    return round(mdd * 100, 2)


def backtest(detail, weights=None, assumptions=None, include_stress=False):
    weights = weights or active_weights()
    assumptions = {**DEFAULT_ASSUMPTIONS, **(assumptions or {})}
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

    strat, gross, bench = 1.0, 1.0, 1.0
    strat_curve, gross_curve, bench_curve, actions = [], [], [], []
    previous_weight = 0.0
    months_since_change = assumptions["min_hold_months"]
    for k in range(len(pts) - 1):
        i, j = pts[k], pts[k + 1]
        # 透传 code/type，使回测中的估值层能用真实 PE/PB 映射（V6-P0）
        sig = timing_signal({
            "code": detail.get("code"),
            "type": detail.get("type"),
            "name": detail.get("name"),
            "nav_history": [{"date": d, "nav": n} for d, n in navs[:i + 1]],
        })
        target_weight = weights.get(sig["signal"], 0.5)
        if target_weight < previous_weight and months_since_change < assumptions["min_hold_months"]:
            w = previous_weight
        else:
            w = target_weight
        ret = navs[j][1] / navs[i][1] - 1
        days = max(1, (dt.date.fromisoformat(navs[j][0][:10]) - dt.date.fromisoformat(navs[i][0][:10])).days)
        cash_ret = (1 + assumptions["annual_cash_yield"]) ** (days / 365) - 1
        buy_turnover = max(0.0, w - previous_weight)
        sell_turnover = max(0.0, previous_weight - w)
        friction = (
            buy_turnover * assumptions["buy_fee"]
            + sell_turnover * assumptions["sell_fee"]
            + abs(w - previous_weight) * assumptions["slippage"]
        )
        strat *= 1 + w * ret + (1 - w) * cash_ret - friction
        gross *= 1 + w * ret + (1 - w) * cash_ret
        bench *= 1 + ret
        strat_curve.append({"date": navs[j][0], "v": round(strat, 4)})
        gross_curve.append({"date": navs[j][0], "v": round(gross, 4)})
        bench_curve.append({"date": navs[j][0], "v": round(bench, 4)})
        actions.append({
            "date": navs[i][0],
            "signal": sig["signal"],
            "weight": w,
            "target_weight": target_weight,
            "turnover": round(abs(w - previous_weight), 3),
            "friction": round(friction * 100, 4),
        })
        if w != previous_weight:
            months_since_change = 0
        else:
            months_since_change += 1
        previous_weight = w

    strat_ret = round((strat - 1) * 100, 2)
    gross_ret = round((gross - 1) * 100, 2)
    bench_ret = round((bench - 1) * 100, 2)
    wins = sum(1 for a, b in zip(strat_curve, bench_curve) if a["v"] >= b["v"])
    result = {
        "available": True,
        "start": navs[pts[0]][0], "end": navs[-1][0], "rebalances": len(pts) - 1,
        "strategy": {"total_return": strat_ret, "max_drawdown": _max_drawdown(strat_curve), "curve": strat_curve},
        "strategy_gross": {
            "total_return": gross_ret,
            "max_drawdown": _max_drawdown(gross_curve),
            "curve": gross_curve,
        },
        "benchmark": {"total_return": bench_ret, "max_drawdown": _max_drawdown(bench_curve), "curve": bench_curve},
        "outperform": round(strat_ret - bench_ret, 2),
        "win_rate": round(wins / len(strat_curve) * 100, 1) if strat_curve else None,
        "actions": actions[-12:],
        "weights": weights,
        "assumptions": assumptions,
        "friction_cost": round(gross_ret - strat_ret, 2),
    }
    if include_stress:
        high_cost = {
            **assumptions,
            "buy_fee": assumptions["buy_fee"] * 2,
            "sell_fee": assumptions["sell_fee"] * 2,
            "slippage": max(assumptions["slippage"] * 2, 0.0005),
        }
        stressed = backtest(detail, weights, high_cost, include_stress=False)
        result["stress"] = {
            "high_cost_return": (stressed.get("strategy") or {}).get("total_return"),
            "high_cost_outperform": stressed.get("outperform"),
            "return_drop": round(
                strat_ret - float((stressed.get("strategy") or {}).get("total_return") or 0),
                2,
            ),
            "stable": (
                stressed.get("available")
                and float(stressed.get("outperform") or 0) >= -2
            ),
        }
    return result
