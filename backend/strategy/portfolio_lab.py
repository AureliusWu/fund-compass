"""组合级历史回测、风险贡献与受约束再平衡。纯 Python。"""
import math
import statistics

TRADING_DAYS = 252
DEFAULT_ASSUMPTIONS = {"rebalance_fee": 0.002, "annual_cash_yield": 0.012, "max_weight": 40.0, "min_trade": 2.0}
STRESS_SCENARIOS = [
    {"name": "温和回撤", "equity": -10, "bond": 0, "overseas": -5},
    {"name": "2018式熊市", "equity": -25, "bond": 8, "overseas": -10},
    {"name": "全球风险冲击", "equity": -35, "bond": 2, "overseas": -40},
]


def normalize_weights(values: list[float]) -> list[float]:
    total = sum(max(0.0, value) for value in values)
    if total <= 0:
        raise ValueError("组合权重合计必须大于 0")
    return [max(0.0, value) / total for value in values]


def capped_weights(values: list[float], max_weight: float) -> tuple[list[float], float]:
    weights = normalize_weights(values)
    cap = max(float(max_weight) / 100, 1 / len(weights))
    for _ in range(len(weights) + 2):
        above = [index for index, weight in enumerate(weights) if weight > cap + 1e-12]
        if not above:
            break
        excess = sum(weights[index] - cap for index in above)
        for index in above:
            weights[index] = cap
        below = [index for index, weight in enumerate(weights) if weight < cap - 1e-12]
        room = sum(weights[index] for index in below)
        if not below:
            break
        for index in below:
            weights[index] += excess * (weights[index] / room if room > 0 else 1 / len(below))
    return normalize_weights(weights), cap


def align_navs(details: list[dict]) -> tuple[list[str], list[list[float]]]:
    """仅在所有基金都有净值的共同交易日对齐，避免跨市场日期错位。"""
    histories = []
    for detail in details:
        points = {
            row["date"]: float(row["nav"])
            for row in detail.get("nav_history") or []
            if row.get("date") and row.get("nav") is not None and float(row["nav"]) > 0
        }
        if not points:
            raise ValueError(f"{detail.get('code') or '基金'} 缺少净值历史")
        histories.append(points)
    common_dates = sorted(set.intersection(*(set(history) for history in histories)))
    if len(common_dates) < 60:
        raise ValueError("共同历史不足 60 个观测点")
    aligned = [[history[day] for day in common_dates] for history in histories]
    return common_dates, aligned


def _returns(series: list[float]) -> list[float]:
    return [series[i] / series[i - 1] - 1 for i in range(1, len(series))]


def _metrics(curve: list[dict]) -> dict:
    values = [row["v"] for row in curve]
    returns = _returns(values)
    peak = values[0]
    drawdown = 0.0
    for value in values:
        peak = max(peak, value)
        drawdown = min(drawdown, value / peak - 1)
    years = max((len(values) - 1) / TRADING_DAYS, 1 / TRADING_DAYS)
    annual_return = (values[-1] / values[0]) ** (1 / years) - 1
    volatility = statistics.stdev(returns) * math.sqrt(TRADING_DAYS) if len(returns) >= 2 else 0.0
    return {
        "total_return": round((values[-1] / values[0] - 1) * 100, 2),
        "annual_return": round(annual_return * 100, 2),
        "annual_volatility": round(volatility * 100, 2),
        "max_drawdown": round(drawdown * 100, 2),
        "curve": curve,
    }


def covariance_matrix(series: list[list[float]]) -> list[list[float]]:
    returns = [_returns(values) for values in series]
    means = [statistics.fmean(values) for values in returns]
    count = min(len(values) for values in returns)
    matrix = []
    for i in range(len(returns)):
        row = []
        for j in range(len(returns)):
            cov = sum((returns[i][k] - means[i]) * (returns[j][k] - means[j]) for k in range(count)) / max(1, count - 1)
            row.append(cov * TRADING_DAYS)
        matrix.append(row)
    return matrix


def risk_analysis(codes: list[str], names: list[str], series: list[list[float]], weights: list[float]) -> dict:
    matrix = covariance_matrix(series)
    marginal = [sum(matrix[i][j] * weights[j] for j in range(len(weights))) for i in range(len(weights))]
    variance = sum(weights[i] * marginal[i] for i in range(len(weights)))
    volatility = math.sqrt(max(0.0, variance))
    contributions = []
    for i, code in enumerate(codes):
        contribution = weights[i] * marginal[i] / variance * 100 if variance > 1e-15 else 0.0
        contributions.append({
            "code": code, "name": names[i], "weight": round(weights[i] * 100, 2),
            "risk_contribution": round(contribution, 2),
            "annual_volatility": round(math.sqrt(max(0.0, matrix[i][i])) * 100, 2),
        })
    effective = 1 / sum(weight * weight for weight in weights)
    weighted_corr = []
    for i in range(len(weights)):
        for j in range(i + 1, len(weights)):
            denom = math.sqrt(max(0.0, matrix[i][i] * matrix[j][j]))
            if denom > 0:
                weighted_corr.append((abs(matrix[i][j] / denom), weights[i] * weights[j]))
    corr_weight = sum(weight for _, weight in weighted_corr)
    concentration = sum(value * weight for value, weight in weighted_corr) / corr_weight if corr_weight else 0.0
    return {
        "annual_volatility": round(volatility * 100, 2),
        "effective_holdings": round(effective, 2),
        "correlation_concentration": round(concentration * 100, 1),
        "contributions": sorted(contributions, key=lambda row: row["risk_contribution"], reverse=True),
        "covariance": matrix,
    }


def portfolio_backtest(details: list[dict], target_weights: list[float], assumptions=None) -> dict:
    assumptions = {**DEFAULT_ASSUMPTIONS, **(assumptions or {})}
    dates, series = align_navs(details)
    weights = normalize_weights(target_weights)
    asset_returns = [_returns(values) for values in series]
    strategy_value = benchmark_value = cash_value = 1.0
    current = weights[:]
    benchmark_weights = weights[:]
    strategy_curve = [{"date": dates[0], "v": 1.0}]
    benchmark_curve = [{"date": dates[0], "v": 1.0}]
    cash_curve = [{"date": dates[0], "v": 1.0}]
    total_cost = turnover = 0.0
    last_month = dates[0][:7]
    daily_cash = (1 + assumptions["annual_cash_yield"]) ** (1 / TRADING_DAYS) - 1
    for point in range(1, len(dates)):
        daily = [asset_returns[index][point - 1] for index in range(len(series))]
        growth = sum(current[index] * (1 + daily[index]) for index in range(len(current)))
        strategy_value *= growth
        current = [current[index] * (1 + daily[index]) / growth for index in range(len(current))]
        benchmark_growth = sum(benchmark_weights[index] * (1 + daily[index]) for index in range(len(weights)))
        benchmark_value *= benchmark_growth
        benchmark_weights = [benchmark_weights[index] * (1 + daily[index]) / benchmark_growth for index in range(len(weights))]
        month = dates[point][:7]
        if month != last_month:
            traded = sum(abs(current[index] - weights[index]) for index in range(len(weights))) / 2
            cost = strategy_value * traded * assumptions["rebalance_fee"]
            strategy_value -= cost
            total_cost += cost
            turnover += traded
            current = weights[:]
            last_month = month
        cash_value *= 1 + daily_cash
        strategy_curve.append({"date": dates[point], "v": round(strategy_value, 6)})
        benchmark_curve.append({"date": dates[point], "v": round(benchmark_value, 6)})
        cash_curve.append({"date": dates[point], "v": round(cash_value, 6)})
    return {
        "available": True,
        "start": dates[0], "end": dates[-1], "points": len(dates),
        "strategy": _metrics(strategy_curve),
        "benchmark": _metrics(benchmark_curve),
        "cash": _metrics(cash_curve),
        "turnover": round(turnover * 100, 2),
        "friction_cost": round(total_cost * 100, 3),
        "assumptions": assumptions,
        "aligned": {"dates": dates, "series": series},
    }


def constrained_rebalance(items: list[dict], risk: dict, portfolio_value=None, assumptions=None) -> dict:
    assumptions = {**DEFAULT_ASSUMPTIONS, **(assumptions or {})}
    current = normalize_weights([float(item.get("current_weight") or 0) for item in items])
    desired, effective_cap = capped_weights(
        [float(item.get("target_weight") or 0) for item in items], assumptions["max_weight"],
    )
    risk_by_code = {row["code"]: row["risk_contribution"] for row in risk["contributions"]}
    # 单一基金贡献超过 40% 时，不允许建议继续加仓；其余权重按比例承接。
    capped = desired[:]
    freed = 0.0
    for index, item in enumerate(items):
        if risk_by_code.get(item["code"], 0) > 40 and capped[index] > current[index]:
            freed += capped[index] - current[index]
            capped[index] = current[index]
    receivers = [index for index in range(len(items)) if risk_by_code.get(items[index]["code"], 0) <= 40]
    receiver_total = sum(capped[index] for index in receivers)
    if freed > 0 and receiver_total > 0:
        for index in receivers:
            capped[index] += freed * capped[index] / receiver_total
    actions, turnover = [], 0.0
    for index, item in enumerate(items):
        delta = (capped[index] - current[index]) * 100
        trade = 0.0 if abs(delta) < assumptions["min_trade"] else delta
        turnover += abs(trade) / 100 / 2
        actions.append({
            "code": item["code"], "name": item.get("name") or item["code"],
            "current_weight": round(current[index] * 100, 2),
            "suggested_weight": round((current[index] * 100) if trade == 0 else capped[index] * 100, 2),
            "delta": round(trade, 2),
            "action": "维持" if trade == 0 else "增加" if trade > 0 else "减少",
            "amount": round(portfolio_value * trade / 100, 2) if portfolio_value is not None else None,
            "reason": "偏差低于调仓阈值，不产生交易" if trade == 0 else "风险贡献超过40%，限制继续加仓" if risk_by_code.get(item["code"], 0) > 40 and delta > 0 else "目标仓位偏差达到调仓阈值",
        })
    suggested = normalize_weights([row["suggested_weight"] for row in actions])
    matrix = risk["covariance"]
    suggested_variance = sum(
        suggested[i] * matrix[i][j] * suggested[j]
        for i in range(len(suggested)) for j in range(len(suggested))
    )
    suggested_volatility = math.sqrt(max(0.0, suggested_variance)) * 100
    return {
        "actions": actions,
        "turnover": round(turnover * 100, 2),
        "estimated_cost": round((portfolio_value or 0) * turnover * assumptions["rebalance_fee"], 2) if portfolio_value is not None else None,
        "risk_change": {
            "current_volatility": risk["annual_volatility"],
            "suggested_volatility": round(suggested_volatility, 2),
            "delta": round(suggested_volatility - risk["annual_volatility"], 2),
        },
        "constraints": {
            "max_weight": assumptions["max_weight"],
            "effective_max_weight": round(effective_cap * 100, 2),
            "min_trade": assumptions["min_trade"],
        },
    }


def stress_scenarios(details: list[dict], weights: list[float], portfolio_value=None) -> list[dict]:
    output = []
    for scenario in STRESS_SCENARIOS:
        total_return = 0.0
        for detail, weight in zip(details, weights):
            fund_type = (detail.get("type") or detail.get("name") or "").upper()
            asset = "overseas" if "QDII" in fund_type or "海外" in fund_type else "bond" if "债" in fund_type else "equity"
            total_return += weight * scenario[asset]
        output.append({
            "name": scenario["name"],
            "return": round(total_return, 2),
            "pnl": round((portfolio_value or 0) * total_return / 100, 2) if portfolio_value is not None else None,
        })
    return output


def analyze_portfolio(details: list[dict], items: list[dict], portfolio_value=None, assumptions=None) -> dict:
    targets = [float(item.get("target_weight") or item.get("current_weight") or 0) for item in items]
    backtest = portfolio_backtest(details, targets, assumptions)
    weights = normalize_weights([float(item.get("current_weight") or 0) for item in items])
    codes = [detail["code"] for detail in details]
    names = [detail.get("name") or detail["code"] for detail in details]
    risk = risk_analysis(codes, names, backtest["aligned"]["series"], weights)
    public_backtest = {key: value for key, value in backtest.items() if key != "aligned"}
    enriched_items = [{**item, "name": names[index]} for index, item in enumerate(items)]
    return {
        "backtest": public_backtest,
        "risk": {key: value for key, value in risk.items() if key != "covariance"},
        "rebalance": constrained_rebalance(enriched_items, risk, portfolio_value, assumptions),
        "stress": stress_scenarios(details, weights, portfolio_value),
    }
