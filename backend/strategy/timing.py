"""择时三层信号：估值 + 趋势 + 情绪 → 买入 / 定投 / 持有 / 减仓。

- 估值层：真正的 PE/PB 百分位需把基金映射到跟踪指数再取指数估值（免登录数据源暂缺）。
  当前用「去趋势净值分位」代理：把复权净值拟合指数趋势线，取当前点相对趋势的残差在历史
  残差中的分位 —— 贴着自身趋势涨为「合理」，显著偏离上/下方为「高估/低估」（均值回归语义，
  不再像绝对分位那样把长牛恒判高估）。真·PE/PB 留作后续增强。
- 趋势层：MA20 / MA60 / MA120 多头/空头排列。
- 情绪层：RSI(14)。
RSI/MA 用纯 Python 计算（单序列足够），pandas-ta 留待更复杂指标。
"""
import math


def _navs(nav_history, n=None):
    vs = [h["nav"] for h in (nav_history or []) if h.get("nav")]
    return vs[-n:] if n else vs


def _series(nav_history, n=None):
    """趋势/情绪指标用的价格序列：优先「分红复权」（累计收益重构），
    避免基金分红导致单位净值下跌而被误判为下跌/超卖；缺累计收益时退回单位净值。"""
    hs = [h for h in (nav_history or []) if h.get("nav")]
    if hs and all(h.get("ac_return") is not None for h in hs):
        vals = [1.0 + h["ac_return"] / 100.0 for h in hs]  # 累计收益率 → 复权净值（比例即可，指标对量纲不敏感）
    else:
        vals = [h["nav"] for h in hs]
    return vals[-n:] if n else vals


def _ma(vals, period):
    return sum(vals[-period:]) / period if len(vals) >= period else None


def _percentile(vals, current):
    if not vals:
        return None
    below = sum(1 for v in vals if v <= current)
    return round(below / len(vals) * 100, 1)


def _rsi(vals, period=14):
    if len(vals) < period + 1:
        return None
    deltas = [vals[i] - vals[i - 1] for i in range(1, len(vals))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(deltas)):  # Wilder 平滑
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0  # 无任何波动 → 中性，而非误判超买
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 1)


def valuation_layer(nav_history, window=504):
    """去趋势净值分位估值（对数线性回归残差）。

    旧法用「当前净值在历史中的绝对分位」，对长牛基金恒为高分位 → 永远误判高估。
    新法：把复权净值拟合到指数趋势线（对 log 做最小二乘），取当前点相对趋势线的「残差」
    在历史残差中的分位。稳步贴着趋势涨 → 残差≈0 → 合理；显著偏离趋势上方/下方 → 高估/低估。
    （真·指数 PE/PB 分位需付费/鉴权数据源，暂以此去趋势代理替代，语义更稳。）
    """
    vals = _series(nav_history, window)  # 分红复权，取近 window
    n = len(vals)
    if n < 120 or any(v <= 0 for v in vals):
        return {"label": "数据不足", "value": 0, "percentile": None, "note": "净值历史不足，无法估值"}
    ys = [math.log(v) for v in vals]
    xs = list(range(n))
    mx = (n - 1) / 2.0
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    b = sxy / sxx if sxx else 0.0
    a = my - b * mx
    resid = [ys[i] - (a + b * xs[i]) for i in range(n)]
    pct = _percentile(resid, resid[-1])
    if pct < 30:
        label, value = "低估", 1
    elif pct > 70:
        label, value = "高估", -1
    else:
        label, value = "合理", 0
    return {"label": label, "value": value, "percentile": pct,
            "note": f"去趋势分位 {pct}%（当前净值相对自身指数趋势的偏离，在历史中的位置；非真·PE/PB）"}


def trend_layer(nav_history):
    vals = _series(nav_history)  # 分红复权，避免分红假跌
    cur = vals[-1] if vals else None
    ma20, ma60, ma120 = _ma(vals, 20), _ma(vals, 60), _ma(vals, 120)
    if None in (cur, ma20, ma60, ma120):
        return {"label": "数据不足", "value": 0,
                "current": cur, "ma20": ma20, "ma60": ma60, "ma120": ma120}
    above = sum(1 for m in (ma20, ma60, ma120) if cur > m)
    if above == 3 and ma20 >= ma60 >= ma120:
        label, value = "上升趋势", 1
    elif above == 0 and ma20 <= ma60 <= ma120:
        label, value = "下降趋势", -1
    else:
        label, value = "横盘趋势", 0
    r = lambda x: round(x, 4)
    return {"label": label, "value": value,
            "current": r(cur), "ma20": r(ma20), "ma60": r(ma60), "ma120": r(ma120)}


def sentiment_layer(nav_history):
    rsi = _rsi(_series(nav_history, 250))  # 分红复权，避免分红假超卖
    if rsi is None:
        return {"label": "数据不足", "value": 0, "rsi": None}
    if rsi < 30:
        label, value = "超卖", 1
    elif rsi > 70:
        label, value = "超买", -1
    else:
        label, value = "中性", 0
    return {"label": label, "value": value, "rsi": rsi}


def timing_signal(detail):
    """合成三层为最终信号。权重 估值0.4 / 趋势0.35 / 情绪0.25。"""
    nh = detail.get("nav_history")
    val = valuation_layer(nh)
    tr = trend_layer(nh)
    se = sentiment_layer(nh)
    composite = round(0.4 * val["value"] + 0.35 * tr["value"] + 0.25 * se["value"], 3)
    if composite >= 0.5:
        signal, advice = "买入", "信号偏多，适合分批建仓"
    elif composite >= 0.15:
        signal, advice = "定投", "温和偏多，适合持续定投"
    elif composite > -0.15:
        signal, advice = "持有", "信号中性，继续观察"
    else:
        signal, advice = "减仓", "信号偏空，可逐步落袋"
    return {
        "signal": signal,
        "advice": advice,
        "composite": composite,
        "layers": {"valuation": val, "trend": tr, "sentiment": se},
    }
