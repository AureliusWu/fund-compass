"""决策规则：评分 + 择时 + 回测 → 可执行动作（V6-P0）。

规则与文案集中在此模块，API / 决策引擎只调用，不在端点里散落 if/else。
"""

DISCLAIMER = "数据辅助分析，不构成投资建议。"
NEXT_CHECK = "下次 14:30 查看盘中估值；每周复核一次。"


def _overextended(layers: dict) -> bool:
    val = layers.get("valuation") or {}
    sent = layers.get("sentiment") or {}
    pct = val.get("pe_pct")
    if pct is None:
        pct = val.get("percentile")
    rsi = sent.get("rsi")
    return (pct is not None and pct > 80) or (rsi is not None and rsi > 70)


def map_action(quality: float | None, signal: str, layers: dict) -> str:
    """择时信号 + 综合分 → 决策动作。"""
    val = layers.get("valuation") or {}
    if quality is None or val.get("label") == "数据不足":
        return "观察"

    if quality >= 75 and signal == "买入":
        return "分批买入"
    if quality >= 65 and signal == "定投":
        return "继续定投"
    if quality >= 65 and signal == "买入":
        return "继续定投"
    if signal == "持有":
        return "持有观望"
    if signal == "减仓" and quality < 50:
        return "考虑替换"
    if signal == "减仓" and _overextended(layers):
        return "部分观察"
    if signal == "减仓":
        return "停止加仓"
    return "观察"


def compute_confidence(
    quality: float | None,
    layers: dict,
    bt_ok: bool,
    issues: list[str],
) -> str:
    """高 / 中 / 低：综合数据质量、估值来源、回测可用性。"""
    if quality is None or any(
        "数据不足" in issue or "已过期" in issue for issue in issues
    ):
        return "低"

    val = layers.get("valuation") or {}
    score = 0
    if val.get("source") == "index_pe_pb":
        score += 2
    elif val.get("source") == "nav_detrended":
        score -= 1
    if bt_ok:
        score += 1
    if len(issues) >= 2:
        score -= 1
    if quality >= 70:
        score += 1

    if score >= 3:
        return "高"
    if score >= 1:
        return "中"
    return "低"


def build_position_rule(holding: dict | None, action: str) -> str:
    if not holding:
        return "缺少持仓数据，仅给方向建议，不算金额。"

    target = holding.get("target_weight")
    current = holding.get("current_weight")
    if target is None or current is None:
        return "缺少持仓数据，仅给方向建议，不算金额。"

    gap = round(float(target) - float(current), 1)
    if action in ("分批买入", "继续定投"):
        if gap <= 0:
            return f"当前仓位 {current}% 已达或超过目标 {target}%，暂不建议加仓。"
        return f"目标仓位 {target}%，当前 {current}%，可分批补 {gap}% 左右。"
    if action in ("停止加仓", "部分观察", "考虑替换"):
        if current <= 0:
            return "当前无持仓，无需减仓操作。"
        return f"当前仓位 {current}%，目标 {target}%；{action}，勿一次性清仓。"
    return f"目标仓位 {target}%，当前 {current}%，维持原计划。"


def build_summary(action: str, quality: float | None, signal: str, layers: dict) -> str:
    val = layers.get("valuation") or {}
    val_label = val.get("label") or "未知"
    q = f"{quality}" if quality is not None else "--"
    templates = {
        "分批买入": f"综合分 {q}，{val_label}，{signal} 信号，可分批建仓。",
        "继续定投": f"综合分 {q}，{val_label}，适合按原计划定投。",
        "持有观望": f"综合分 {q}，{val_label}，维持原计划即可。",
        "停止加仓": f"综合分 {q}，{val_label}，偏空信号，暂停追加。",
        "部分观察": f"综合分 {q}，估值或情绪偏高，可部分观察、控制仓位。",
        "考虑替换": f"综合分 {q} 偏低，{val_label}，可关注同类更优标的。",
        "观察": "数据或信号不足，暂维持观察。",
    }
    return templates.get(action, templates["观察"])


def build_reasons(score: dict, signal: dict, bt: dict, bt_ok: bool) -> list[str]:
    reasons: list[str] = []
    q = score.get("score")
    if q is not None:
        reasons.append(f"综合评分 {q}")
    sig = signal.get("signal")
    if sig:
        reasons.append(f"择时信号 {sig}")
    layers = signal.get("layers") or {}
    val = layers.get("valuation") or {}
    if val.get("label"):
        src = "真实 PE/PB" if val.get("source") == "index_pe_pb" else "净值代理"
        reasons.append(f"估值 {val['label']}（{src}）")
    tr = layers.get("trend") or {}
    if tr.get("label"):
        reasons.append(f"趋势 {tr['label']}")
    se = layers.get("sentiment") or {}
    if se.get("label"):
        rsi = se.get("rsi")
        reasons.append(f"情绪 {se['label']}" + (f" RSI {rsi}" if rsi is not None else ""))
    if bt_ok and bt.get("outperform") is not None:
        op = bt["outperform"]
        tag = "跑赢" if op >= 0 else "跑输"
        reasons.append(f"回测择时{tag}持有 {abs(op)}%")
    elif not bt.get("available"):
        reasons.append("回测数据不足")
    return reasons


def build_risks(
    signal: dict,
    bt: dict,
    detail: dict,
    holding: dict | None,
    issues: list[str],
) -> list[str]:
    risks: list[str] = []
    risks.extend(issues)
    layers = signal.get("layers") or {}
    val = layers.get("valuation") or {}
    if val.get("source") == "nav_detrended":
        risks.append("估值层使用净值代理，强趋势长牛可能被误判高估")
    fund_type = (detail.get("type") or "") + (detail.get("name") or "")
    if "QDII" in fund_type.upper() or "海外" in fund_type:
        risks.append("QDII/海外基金净值公布滞后，盘中估值仅供参考")
    if not holding:
        risks.append("缺少个人仓位，无法给出金额建议")
    if bt.get("available") and bt.get("outperform") is not None and bt["outperform"] < 0:
        risks.append("历史回测显示择时策略跑输一直持有")
    risks.append("择时信号仅为时机参考，非买卖指令")
    # 去重保序
    seen: set[str] = set()
    out: list[str] = []
    for r in risks:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def collect_issues(score: dict, signal: dict, bt: dict, detail: dict | None = None) -> list[str]:
    issues: list[str] = []
    if score.get("score") is None:
        issues.append("综合评分数据不足")
    val = (signal.get("layers") or {}).get("valuation") or {}
    if val.get("label") == "数据不足":
        issues.append("估值层数据不足")
    if val.get("source") == "nav_detrended":
        issues.append("估值使用净值代理，非真实 PE/PB")
    if not bt.get("available"):
        issues.append("回测区间不足")
    if (detail or {}).get("stale"):
        issues.append("基金数据已过期")
    return issues


def build_decision(
    detail: dict,
    score: dict,
    signal: dict,
    bt: dict,
    holding: dict | None = None,
) -> dict:
    """合成完整决策卡片字段。"""
    layers = signal.get("layers") or {}
    quality = score.get("score")
    sig = signal.get("signal") or "持有"
    issues = collect_issues(score, signal, bt, detail)
    bt_ok = bool(bt.get("available") and bt.get("outperform") is not None)

    action = map_action(quality, sig, layers)
    if detail.get("stale"):
        action = "观察"
    confidence = compute_confidence(quality, layers, bt_ok, issues)

    return {
        "code": detail.get("code"),
        "name": detail.get("name"),
        "action": action,
        "confidence": confidence,
        "summary": build_summary(action, quality, sig, layers),
        "reasons": build_reasons(score, signal, bt, bt_ok),
        "risks": build_risks(signal, bt, detail, holding, issues),
        "position_rule": build_position_rule(holding, action),
        "next_check": NEXT_CHECK,
        "disclaimer": DISCLAIMER,
        "raw": {"score": score, "signal": signal, "backtest": bt},
    }
