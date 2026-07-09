"""受约束的回测自校准：训练段选参数，留出验证段决定是否可采纳。"""
from strategy.backtest import backtest
from strategy.registry import DEFAULT_WEIGHTS, active_weights

WEIGHT = DEFAULT_WEIGHTS


CANDIDATES = [
    {"买入": 1.0, "定投": 0.75, "持有": 0.5, "减仓": 0.25},
    {"买入": 1.0, "定投": 0.85, "持有": 0.65, "减仓": 0.35},
    {"买入": 0.9, "定投": 0.7, "持有": 0.5, "减仓": 0.2},
    {"买入": 1.0, "定投": 0.8, "持有": 0.6, "减仓": 0.1},
    {"买入": 0.85, "定投": 0.7, "持有": 0.55, "减仓": 0.3},
]


def _objective(result: dict) -> float:
    if not result.get("available"):
        return float("-inf")
    excess = float(result.get("outperform") or 0)
    strategy_dd = float((result.get("strategy") or {}).get("max_drawdown") or 0)
    benchmark_dd = float((result.get("benchmark") or {}).get("max_drawdown") or 0)
    return round(excess + 0.3 * (strategy_dd - benchmark_dd), 4)


def calibrate(detail: dict, train_ratio: float = 0.7) -> dict:
    """训练集选择参数，最后 30% 历史只用于验证，避免未来数据泄漏。"""
    history = list(detail.get("nav_history") or [])
    if len(history) < 360:
        return {
            "available": False,
            "accepted": False,
            "reason": "至少需要 360 个净值点才能划分训练与验证区间",
        }

    split = max(240, min(len(history) - 150, int(len(history) * train_ratio)))
    train_detail = {**detail, "nav_history": history[:split]}
    validation_detail = {**detail, "nav_history": history[max(0, split - 120):]}

    train_rows = []
    for weights in CANDIDATES:
        result = backtest(train_detail, weights)
        train_rows.append({
            "weights": weights,
            "objective": _objective(result),
            "outperform": result.get("outperform"),
            "max_drawdown": (result.get("strategy") or {}).get("max_drawdown"),
        })
    best = max(train_rows, key=lambda row: row["objective"])
    current = active_weights()
    baseline = backtest(validation_detail, current)
    candidate = backtest(validation_detail, best["weights"])
    if not baseline.get("available") or not candidate.get("available"):
        return {
            "available": False,
            "accepted": False,
            "reason": "留出验证区间不足",
            "train": train_rows,
        }

    candidate_excess = float(candidate.get("outperform") or 0)
    baseline_excess = float(baseline.get("outperform") or 0)
    candidate_dd = float(candidate["strategy"]["max_drawdown"])
    baseline_dd = float(baseline["strategy"]["max_drawdown"])
    accepted = (
        best["weights"] != current
        and candidate_excess >= baseline_excess
        and candidate_excess >= 0
        and candidate_dd >= baseline_dd - 2
    )
    reasons = []
    if best["weights"] == current:
        reasons.append("训练段仍选择当前参数")
    if candidate_excess < baseline_excess:
        reasons.append("验证段未跑赢当前参数")
    if candidate_excess < 0:
        reasons.append("验证段未跑赢一直持有")
    if candidate_dd < baseline_dd - 2:
        reasons.append("验证段最大回撤恶化超过 2 个百分点")

    return {
        "available": True,
        "accepted": accepted,
        "current_weights": current,
        "candidate_weights": best["weights"],
        "split_date": history[split]["date"],
        "train_points": split,
        "validation_points": len(history) - split,
        "train": train_rows,
        "validation": {
            "baseline": {"outperform": baseline_excess, "max_drawdown": baseline_dd},
            "candidate": {"outperform": candidate_excess, "max_drawdown": candidate_dd},
        },
        "reason": "通过留出验证，可进入候选版本" if accepted else "；".join(reasons),
    }
