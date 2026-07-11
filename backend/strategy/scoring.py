"""基金综合评分（0–100）。

参考晨星思想，四个维度加权：收益 40% / 风险 30% / 管理 20% / 成本 10%。
输入为 M1 的详情字典（含 nav_history），输出可解释的分项明细。
风险指标用纯 Python 计算（最大回撤 / 年化波动率 / 夏普），不依赖 pandas/numpy；
M3 的技术指标再引入 pandas-ta。
"""
import math
import re

_TRADING_DAYS = 252
_RISK_FREE = 0.02
SCORE_VERSION = "v3-risk-adjusted"
MIN_SCORE_COVERAGE = 0.7


def _scale(x, lo, hi):
    """把 x 从 [lo, hi] 线性映射到 0–100（越界裁剪）。lo>hi 表示越小越好。"""
    if x is None:
        return None
    if lo == hi:
        return 50.0
    t = (x - lo) / (hi - lo)
    return max(0.0, min(100.0, t * 100.0))


def _wavg(pairs):
    """对 (分值, 权重) 列表求加权平均，自动跳过 None 并按剩余权重归一。"""
    items = [(s, w) for s, w in pairs if s is not None]
    if not items:
        return None
    total_w = sum(w for _, w in items)
    return sum(s * w for s, w in items) / total_w if total_w else None


def parse_tenure_years(worktime):
    """「14年又199天」→ 14.5（年）。"""
    if not worktime:
        return None
    y = re.search(r"(\d+)年", worktime)
    d = re.search(r"(\d+)天", worktime)
    if not (y or d):
        return None
    years = (int(y.group(1)) if y else 0) + (int(d.group(1)) / 365 if d else 0)
    return round(years, 1)


def risk_metrics(nav_history, window=_TRADING_DAYS):
    """从单位净值序列算最大回撤(%)、年化波动率(%)、夏普。取最近 window 个点。"""
    navs = [h["nav"] for h in (nav_history or []) if h.get("nav")]
    navs = navs[-window:]
    if len(navs) < 20:
        return {
            "max_drawdown": None,
            "volatility": None,
            "sharpe": None,
            "annualized_return": None,
            "calmar": None,
        }

    rets = [navs[i] / navs[i - 1] - 1 for i in range(1, len(navs)) if navs[i - 1]]
    n = len(rets)
    mean = sum(rets) / n
    var = sum((r - mean) ** 2 for r in rets) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    vol_annual = sd * math.sqrt(_TRADING_DAYS)
    total_return = navs[-1] / navs[0] - 1
    ann_return = (1 + total_return) ** (_TRADING_DAYS / max(1, len(navs) - 1)) - 1
    sharpe = (ann_return - _RISK_FREE) / vol_annual if vol_annual > 0 else None

    peak = navs[0]
    mdd = 0.0
    for v in navs:
        if v > peak:
            peak = v
        dd = v / peak - 1
        if dd < mdd:
            mdd = dd

    return {
        "max_drawdown": round(mdd * 100, 2),       # 负值，越接近 0 越好
        "volatility": round(vol_annual * 100, 2),  # 年化波动率 %
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "annualized_return": round(ann_return * 100, 2),
        "calmar": round(ann_return / abs(mdd), 2) if mdd < 0 else None,
    }


def _star(score):
    if score is None:
        return None
    for threshold, star in ((80, 5), (65, 4), (50, 3), (35, 2)):
        if score >= threshold:
            return star
    return 1


def score_fund(detail):
    """对单只基金详情打分，返回综合分 + 五星 + 四维分项明细。"""
    d = detail

    # 收益：同类排名百分位为主，绝对收益为辅
    rank_pct = None
    if d.get("rank_in_type") and d.get("rank_total"):
        rank_pct = round((1 - d["rank_in_type"] / d["rank_total"]) * 100, 1)
    r1 = _scale(d.get("ret_1y"), -20, 60)
    r3 = _scale(d.get("ret_3y"), -30, 120)
    if rank_pct is not None:
        return_score = _wavg([(rank_pct, 0.5), (r1, 0.3), (r3, 0.2)])
    else:
        return_score = _wavg([(r1, 0.6), (r3, 0.4)])

    # 风险：最大回撤为主，波动率为辅
    rm = risk_metrics(d.get("nav_history"))
    dd_score = _scale(rm["max_drawdown"], -50, 0)
    vol_score = _scale(rm["volatility"], 40, 5)
    sharpe_score = _scale(rm["sharpe"], -0.5, 2.0)
    risk_score = _wavg([(dd_score, 0.5), (vol_score, 0.3), (sharpe_score, 0.2)])

    # 管理：经理任期（8 年以上满分）
    tenure = parse_tenure_years(d.get("manager_worktime"))
    mgmt_score = _scale(tenure, 0, 8)

    # 成本：申购费率（越低越好）
    cost_score = _scale(d.get("buy_rate"), 1.5, 0)

    dimensions = {
        "return": (return_score, 0.4),
        "risk": (risk_score, 0.3),
        "management": (mgmt_score, 0.2),
        "cost": (cost_score, 0.1),
    }
    coverage = round(sum(weight for value, weight in dimensions.values() if value is not None), 2)
    eligible = return_score is not None and risk_score is not None and coverage >= MIN_SCORE_COVERAGE
    composite = _wavg(list(dimensions.values())) if eligible else None
    score = round(composite, 1) if composite is not None else None

    def effective_weight(name):
        value, weight = dimensions[name]
        return round(weight / coverage, 4) if value is not None and coverage > 0 else 0.0

    def r(s):
        return round(s, 1) if s is not None else None

    return {
        "score": score,
        "star": _star(score),
        "score_version": SCORE_VERSION,
        "coverage": coverage,
        "eligible": eligible,
        "rank_in_type": d.get("rank_in_type"),
        "rank_total": d.get("rank_total"),
        "components": {
            "return": {"weight": 0.4, "effective_weight": effective_weight("return"), "score": r(return_score),
                       "detail": {"rank_pct": rank_pct, "ret_1y": d.get("ret_1y"), "ret_3y": d.get("ret_3y")}},
            "risk": {"weight": 0.3, "effective_weight": effective_weight("risk"), "score": r(risk_score), "detail": rm},
            "management": {"weight": 0.2, "effective_weight": effective_weight("management"), "score": r(mgmt_score),
                           "detail": {"manager": d.get("manager"), "tenure_years": tenure}},
            "cost": {"weight": 0.1, "effective_weight": effective_weight("cost"), "score": r(cost_score),
                     "detail": {"buy_rate": d.get("buy_rate")}},
        },
    }
