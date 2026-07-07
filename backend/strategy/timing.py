"""择时三层信号：估值 + 趋势 + 情绪 → 买入 / 定投 / 持有 / 减仓。

- 估值层：优先用真实指数 PE/PB 分位（V3-5 步骤2，需 fund_index_map.json 有映射 +
  index-valuation.json 有估值数据），无数据时回退到「去趋势净值分位」代理：
  把复权净值拟合指数趋势线，取当前点相对趋势的残差在历史残差中的分位。
- 趋势层：MA20 / MA60 / MA120 多头/空头排列。
- 情绪层：RSI(14)。
RSI/MA 用纯 Python 计算（单序列足够），pandas-ta 留待更复杂指标。
"""
import math

from strategy.index_valuation import lookup as _index_lookup
from strategy.index_valuation import unavailable_reason as _index_unavailable_reason


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


def valuation_layer(nav_history, window=504, fund_code=None):
    """估值层：优先用真实指数 PE/PB 分位，无数据时回退到去趋势净值分位。

    若 fund_code 能在 fund_index_map.json 中找到对应指数且该指数有 PE 分位数据，
    则用 PE 分位做主信号（<30 低估 / 30-70 合理 / >70 高估），同时附 PB 分位供参考。
    否则回退到「对数线性回归去趋势分位」的代理方法。
    """
    # ── 真实 PE/PB 分位（优先） ──
    if fund_code:
        idx = _index_lookup(fund_code)
        if idx:
            pct = idx["pe_pct"]
            if pct < 30:
                label, value = "低估", 1
            elif pct > 70:
                label, value = "高估", -1
            else:
                label, value = "合理", 0
            return {
                "label": label,
                "value": value,
                "percentile": pct,
                "source": "index_pe_pb",
                "index_name": idx["index_name"],
                "pe": idx["pe"],
                "pe_pct": idx["pe_pct"],
                "pb": idx["pb"],
                "pb_pct": idx["pb_pct"],
                "valuation_date": idx["date"],
                "note": f"基于 {idx['index_name']} PE={idx['pe']} 历史分位 {pct}%（数据: {idx['source']} {idx['date']}）",
            }

    # ── 回退：去趋势净值分位（现有逻辑，不变） ──
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
    reason = _index_unavailable_reason(fund_code) if fund_code else None
    note = f"去趋势分位 {pct}%（当前净值相对自身指数趋势的偏离，在历史中的位置；非真·PE/PB）"
    if reason:
        note = f"{reason}；{note}"
    return {"label": label, "value": value, "percentile": pct,
            "source": "nav_detrended",
            "note": note}


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
    val = valuation_layer(nh, fund_code=detail.get("code"))
    tr = trend_layer(nh)
    se = sentiment_layer(nh)
    composite = round(0.4 * val["value"] + 0.35 * tr["value"] + 0.25 * se["value"], 3)
    # 措辞如实化：择时是「风险/时机参考」，不是买卖指令。回测显示对多数基金长期持有/定投
    # 优于择时（见详情页「策略回测」），故避免「卖出/落袋」这类指令式表述。
    if composite >= 0.5:
        signal, advice = "买入", "偏多 · 可作分批建仓 / 定投的时机参考"
    elif composite >= 0.15:
        signal, advice = "定投", "温和偏多 · 适合持续定投"
    elif composite > -0.15:
        signal, advice = "持有", "中性 · 维持原计划，优质基金长期持有通常更优"
    else:
        signal, advice = "减仓", "偏空 · 注意短期回撤风险；但择时常跑输持有，优质基金不建议轻易卖出"
    return {
        "signal": signal,
        "advice": advice,
        "composite": composite,
        "disclaimer": "择时信号仅为风险 / 时机参考，非买卖指令。回测显示对多数基金，长期持有 / 定投优于择时。",
        "layers": {"valuation": val, "trend": tr, "sentiment": se},
    }
