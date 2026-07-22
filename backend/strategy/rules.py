"""决策规则：数据新鲜度 + 指标状态 + 风险/持仓修正 → 可执行动作。

规则与文案集中在此模块，API / 决策引擎只调用，不在端点里散落 if/else。
"""
from datetime import datetime, timezone

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


def map_action(quality: float | None, signal: str, layers: dict, holding: dict | None = None) -> str:
    """Return one of the explicit held/unheld action vocabularies."""
    val = layers.get("valuation") or {}
    trend = (layers.get("trend") or {}).get("label") or ""
    held = bool((holding or {}).get("is_held") or ((holding or {}).get("current_weight") or 0) > 0)
    if quality is None or signal == "观察" or val.get("label") == "数据不足":
        return "持有" if held else "观望"

    if held:
        if signal == "减仓" and quality <= 45 and _overextended(layers) and ("下降" in trend or "偏弱" in trend):
            return "卖出"
        if signal == "减仓":
            return "减仓"
        if signal == "买入" and quality >= 70:
            return "加仓"
        return "持有"

    if signal == "买入" and quality >= 80 and not _overextended(layers) and "下降" not in trend:
        return "买入"
    if signal in ("买入", "定投") and quality >= 60:
        return "分批定投"
    return "观望"


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
        return "未提供个人仓位，仅给方向建议，不计算金额。"

    target = holding.get("target_weight")
    current = holding.get("current_weight")
    held = bool(holding.get("is_held") or (current or 0) > 0)
    if target is None or current is None:
        if action in ("买入", "加仓"):
            return "先以小仓位试建，确认趋势与数据继续有效后再加仓。"
        if action == "分批定投":
            return "按周或按月分批投入，避免一次性重仓。"
        if action == "减仓":
            return "分批降低仓位，保留部分仓位观察后续变化。"
        if action == "卖出":
            return "风险条件同时触发，可分批退出；避免在单日波动中冲动交易。"
        return "维持当前仓位，不因单日波动追涨杀跌。" if held else "暂不建仓，等待条件改善。"

    gap = round(float(target) - float(current), 1)
    if action in ("买入", "分批定投", "加仓"):
        if gap <= 0:
            return f"当前仓位 {current}% 已达或超过目标 {target}%，暂不建议加仓。"
        return f"目标仓位 {target}%，当前 {current}%，可分批补 {gap}% 左右。"
    if action in ("减仓", "卖出"):
        if current <= 0:
            return "当前无持仓，无需减仓操作。"
        return f"当前仓位 {current}%，目标 {target}%；{action}，勿一次性清仓。"
    return f"目标仓位 {target}%，当前 {current}%，维持原计划。"


def build_summary(action: str, quality: float | None, signal: str, layers: dict) -> str:
    val = layers.get("valuation") or {}
    val_label = val.get("label") or "未知"
    q = f"{quality}" if quality is not None else "--"
    templates = {
        "买入": f"综合分 {q}，{val_label}且趋势未明显走弱，可小仓位买入。",
        "分批定投": f"综合分 {q}，{val_label}，方向可参与但不适合一次性重仓。",
        "观望": f"综合分 {q}，当前证据不足或风险收益比一般，暂不建仓。",
        "加仓": f"综合分 {q}，{val_label}且买入信号成立，可在目标仓位内加仓。",
        "持有": f"综合分 {q}，{val_label}，尚未触发明确调仓条件。",
        "减仓": f"综合分 {q}，估值、趋势或动量转弱，建议降低部分仓位。",
        "卖出": f"综合分 {q} 偏低且多项风险条件同时触发，建议退出风险敞口。",
    }
    return templates.get(action, templates["观望"])


def build_reasons(score: dict, signal: dict, bt: dict, bt_ok: bool) -> list[str]:
    reasons: list[str] = []
    q = score.get("score")
    if q is not None:
        reasons.append(f"综合评分 {q}（数据覆盖率 {score.get('coverage', 0) * 100:.0f}%）")
    sig = signal.get("signal")
    if sig:
        reasons.append(f"择时信号 {sig}（证据强度 {signal.get('evidence_strength', '低')}）")
    layers = signal.get("layers") or {}
    val = layers.get("valuation") or {}
    if val.get("label"):
        src = "真实 PE/PB" if val.get("source") == "index_pe_pb" else "净值代理"
        reasons.append(f"估值分位 {val['label']}（{src}）")
    tr = layers.get("trend") or {}
    if tr.get("label"):
        reasons.append(f"趋势状态 {tr['label']}")
    se = layers.get("sentiment") or {}
    if se.get("label"):
        rsi = se.get("rsi")
        reasons.append(f"动量状态 {se['label']}" + (f"（RSI14 {rsi}）" if rsi is not None else ""))
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
    if signal.get("coverage", 1) < 0.6:
        issues.append("择时证据覆盖不足")
    val = (signal.get("layers") or {}).get("valuation") or {}
    if val.get("label") == "数据不足":
        issues.append("估值层数据不足")
    if val.get("source") == "nav_detrended":
        issues.append("估值使用净值代理，非真实 PE/PB")
    if not bt.get("available"):
        issues.append("回测区间不足")
    if (detail or {}).get("stale"):
        issues.append("基金数据已过期")
    freshness = (detail or {}).get("decision_context") or {}
    if freshness.get("status") in ("stale", "unavailable"):
        issues.append("盘中数据已过期或不可用")
    elif freshness.get("status") in ("delayed", "degraded", "latest_official"):
        issues.append("盘中数据延迟或已降级")
    return issues


def _data_status(context: dict, detail: dict) -> str:
    status = context.get("status")
    labels = {
        "fresh": "实时",
        "delayed": "延迟",
        "stale": "旧数据",
        "degraded": "降级",
        "latest_official": "最新正式净值",
        "unavailable": "暂不可用",
    }
    if detail.get("stale"):
        return "旧数据"
    return labels.get(status, "最新正式净值")


def _strength(quality: float | None, score: dict, signal: dict, confidence: str, data_status: str) -> int:
    if quality is None:
        value = 25
    else:
        coverage = min(float(score.get("coverage", 0) or 0), float(signal.get("coverage", 0) or 0))
        value = round(45 + abs(float(quality) - 50) * 0.7 + coverage * 20)
    if confidence == "低":
        value = min(value, 45)
    caps = {"实时": 100, "延迟": 65, "降级": 55, "最新正式净值": 55, "旧数据": 35, "暂不可用": 25}
    return max(0, min(100, value, caps.get(data_status, 45)))


def _position_level(layers: dict) -> str:
    valuation = layers.get("valuation") or {}
    percentile = valuation.get("pe_pct")
    if percentile is None:
        percentile = valuation.get("percentile")
    if percentile is not None:
        if percentile <= 35:
            return f"相对低位（约 {round(percentile)}% 分位）"
        if percentile >= 70:
            return f"相对高位（约 {round(percentile)}% 分位）"
        return f"中位区域（约 {round(percentile)}% 分位）"
    return valuation.get("label") or "位置数据不足"


def _trend_state(layers: dict) -> str:
    label = str((layers.get("trend") or {}).get("label") or "")
    if any(word in label for word in ("上升", "偏强", "多头")):
        return "偏强"
    if any(word in label for word in ("下降", "偏弱", "空头")):
        return "偏弱"
    return "中性" if label else "趋势数据不足"


def _investment_method(action: str) -> str:
    return {
        "买入": "先以小仓位买入，不一次性满仓。",
        "分批定投": "未来数周或数月分批投入，暂不一次性重仓。",
        "观望": "保持现金，等待估值、趋势或数据质量改善。",
        "加仓": "仅在目标仓位内分批加仓。",
        "持有": "维持仓位并按计划复核，不追涨杀跌。",
        "减仓": "分批降低仓位，保留部分仓位验证后续走势。",
        "卖出": "分批退出风险敞口，并复核交易成本与赎回规则。",
    }[action]


def _change_conditions(action: str) -> list[str]:
    if action in ("买入", "分批定投", "加仓"):
        return [
            "若估值进入高位且动量过热，转为持有或减仓。",
            "若趋势与综合质量同时恶化，停止投入并重新评估。",
            "若数据变为延迟、旧数据或降级，降低强度并等待新数据。",
        ]
    if action in ("减仓", "卖出"):
        return [
            "若估值回落到合理或低位且趋势企稳，转为持有或分批投入。",
            "若风险信号继续恶化并跌破关键趋势，维持或提高减仓力度。",
            "若当前数据失效，暂停进一步操作并等待确认。",
        ]
    return [
        "若估值进入低位且趋势企稳，转为买入、定投或加仓。",
        "若估值过热且趋势转弱，转为减仓；多项风险同时触发时考虑卖出。",
        "若数据质量下降，继续保持低强度结论。",
    ]


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

    action = map_action(quality, sig, layers, holding)
    context = detail.get("decision_context") or {}
    data_status = _data_status(context, detail)
    held = bool((holding or {}).get("is_held") or ((holding or {}).get("current_weight") or 0) > 0)
    if data_status in ("旧数据", "暂不可用"):
        action = "持有" if held else "观望"
    confidence = compute_confidence(quality, layers, bt_ok, issues)
    strength = _strength(quality, score, signal, confidence, data_status)
    source_time = context.get("source_time") or detail.get("latest_nav_date")

    reasons = build_reasons(score, signal, bt, bt_ok)
    estimate_change = context.get("estimate_change")
    if estimate_change is not None:
        reasons.append(f"盘中估值涨跌 {float(estimate_change):+.2f}%（行情时间 {source_time or '未知'}）")

    return {
        "code": detail.get("code"),
        "name": detail.get("name"),
        "action": action,
        "strength": strength,
        "confidence": confidence,
        "data_status": data_status,
        "data_time": source_time,
        "calculated_at": datetime.now(timezone.utc).isoformat(),
        "position_level": _position_level(layers),
        "trend_state": _trend_state(layers),
        "investment_method": _investment_method(action),
        "change_conditions": _change_conditions(action),
        "summary": build_summary(action, quality, sig, layers),
        "reasons": reasons,
        "risks": build_risks(signal, bt, detail, holding, issues),
        "position_rule": build_position_rule(holding, action),
        "next_check": NEXT_CHECK,
        "disclaimer": DISCLAIMER,
        "methodology": {
            "score_version": score.get("score_version") or "unknown",
            "signal_version": signal.get("signal_version") or "unknown",
            "score_coverage": score.get("coverage"),
            "signal_coverage": signal.get("coverage"),
            "evidence_strength": signal.get("evidence_strength") or confidence,
        },
        "freshness": {
            "sourceTime": source_time,
            "fetchedAt": context.get("fetched_at") or detail.get("updated_at"),
            "calculatedAt": context.get("calculated_at"),
            "ageSeconds": context.get("age_seconds"),
            "status": context.get("status") or ("stale" if detail.get("stale") else "latest_official"),
            "source": context.get("source") or detail.get("source") or "unknown",
            "isFallback": bool(context.get("is_fallback") or detail.get("stale")),
            "fallbackReason": context.get("fallback_reason"),
        },
        "raw": {"score": score, "signal": signal, "backtest": bt},
    }
