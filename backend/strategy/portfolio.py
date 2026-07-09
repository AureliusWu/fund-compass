"""批量决策与组合校准（V6-P1/P2）。"""
from service import repo
from strategy.decision import decide_fund


def _allocation_summary(items: list[dict]) -> dict:
    current = round(sum(float(x.get("current_weight") or 0) for x in items), 2)
    target = round(sum(float(x.get("target_weight") or 0) for x in items), 2)
    warnings: list[str] = []
    if target > 100.01:
        warnings.append(f"目标仓位合计 {target}%，超过 100%")
    if current > 100.5:
        warnings.append(f"当前仓位合计 {current}%，请检查持仓市值口径")
    return {
        "current_total": current,
        "target_total": target,
        "target_cash": round(max(0, 100 - target), 2),
        "status": "需校准" if warnings else "正常",
        "warnings": warnings,
    }


def _rebalance_plan(items: list[dict], decisions: list[dict], portfolio_value: float | None) -> list[dict]:
    decision_by_code = {str(x.get("code")): x for x in decisions}
    rows: list[dict] = []
    for item in items:
        code = str(item.get("code", ""))
        if item.get("current_weight") is None or item.get("target_weight") is None:
            continue
        current = float(item["current_weight"])
        target = float(item["target_weight"])
        gap = round(target - current, 2)
        decision = decision_by_code.get(code, {})
        action = str(decision.get("action") or "观察")
        if abs(gap) < 0.5:
            suggestion = "维持"
        elif gap > 0 and action in ("分批买入", "继续定投"):
            suggestion = "分批补仓"
        elif gap > 0:
            suggestion = "暂缓补仓"
        elif action in ("停止加仓", "部分观察", "考虑替换"):
            suggestion = "逐步降仓"
        else:
            suggestion = "关注超配"
        amount = None if portfolio_value is None else round(abs(gap) * portfolio_value / 100, 2)
        rows.append({
            "code": code,
            "name": decision.get("name") or code,
            "current_weight": round(current, 2),
            "target_weight": round(target, 2),
            "gap": gap,
            "suggestion": suggestion,
            "amount": amount,
        })
    priority = {"逐步降仓": 0, "分批补仓": 1, "关注超配": 2, "暂缓补仓": 3, "维持": 4}
    return sorted(rows, key=lambda x: (priority[x["suggestion"]], -abs(x["gap"])))


def decide_portfolio(items: list[dict], portfolio_value: float | None = None) -> dict:
    """对多只基金批量决策。

    items 每项支持：
    - code: 6 位基金代码（必填）
    - current_weight: 当前仓位 %（可选）
    - target_weight: 目标仓位 %（可选）
    """
    decisions: list[dict] = []
    errors: list[dict] = []
    for raw in items:
        code = str(raw.get("code", "")).strip()
        if not code:
            continue
        holding = None
        cw = raw.get("current_weight")
        tw = raw.get("target_weight")
        if cw is not None and tw is not None:
            holding = {"current_weight": float(cw), "target_weight": float(tw)}
        try:
            detail = repo.get_detail(code)
            d = decide_fund(detail, holding)
            decisions.append({
                "code": detail.get("code"),
                "name": detail.get("name"),
                "type": detail.get("type"),
                **d,
            })
        except Exception as ex:
            errors.append({"code": code, "error": str(ex)})
    return {
        "decisions": decisions,
        "errors": errors,
        "total": len(decisions),
        "allocation": _allocation_summary(items),
        "rebalance": _rebalance_plan(items, decisions, portfolio_value),
    }
