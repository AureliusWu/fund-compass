"""Deterministic v8 evidence normalization and decision kernel.

The module never performs I/O.  A caller supplies already-fetched data, then
persists the returned immutable models through ``service.v8_repo``.
"""
from __future__ import annotations

import math
import re
from datetime import date, datetime, time, timezone
from typing import Any, Iterable

from models.v8 import (
    DecisionDiff,
    DecisionSnapshot,
    EvidenceNode,
    EvidenceSnapshot,
    HoldingVersion,
    PortfolioPolicy,
    PositionGuidance,
    SourceState,
    stable_id,
)


STRATEGY_VERSION = "v8-kernel-1"
HISTORICAL_OUTCOME_HORIZON = 20
HISTORICAL_OUTCOME_MIN_SAMPLES = 10
HISTORICAL_OUTCOME_SUPPORT_HIT_RATE = 60.0
HISTORICAL_OUTCOME_CONSTRAINT_HIT_RATE = 40.0
ACTION_ZH = {
    "buy": "开始建仓",
    "dca": "分批定投",
    "watch": "继续观察",
    "add": "目标内加仓",
    "hold": "继续持有",
    "reduce": "分批减仓",
    "sell": "分批退出",
}
STATE_FACTOR = {
    "healthy": 1.0,
    "degraded": 0.72,
    "stale": 0.35,
    "unavailable": 0.12,
    "unknown": 0.6,
}
ESTIMATE_FACTOR = {
    "fresh": 1.0,
    "modeled": 0.78,
    "delayed": 0.65,
    "degraded": 0.55,
    "latest_official": 0.68,
    "stale": 0.3,
    "unavailable": 0.15,
}
STRUCTURAL_RISKS = {
    "product_invalid",
    "strategy_invalid",
    "quality_breakdown",
    "policy_disallowed",
    "manager_changed",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _bounded(value: Any, low: float, high: float) -> float | None:
    number = _number(value)
    return number if number is not None and low <= number <= high else None


def _first_present(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _parse_date(value: Any) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip().replace("Z", "+00:00")
        if not text or re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return None
        if "T" not in text and " " in text:
            text = text.replace(" ", "T", 1)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?", text):
            text += "+08:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _source_datetime(value: Any) -> datetime | None:
    # A date-only NAV does not carry an event time; keep it unknown instead of
    # inventing 15:00 or request time as a source-success timestamp.
    return _parse_datetime(value)


def _snapshot_time(value: datetime | None) -> datetime:
    current = value or _now()
    if current.tzinfo is None:
        raise ValueError("snapshot time must include a timezone")
    return current.astimezone(timezone.utc)


def _error_class(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    mapping = (
        (("timeout", "timed out", "超时"), "timeout"),
        (("401", "403", "auth", "token", "鉴权"), "auth"),
        (("429", "rate", "限流"), "rate_limit"),
        (("schema", "json", "字段", "parse"), "schema"),
        (("stale", "expired", "过期"), "stale"),
        (("missing", "unavailable", "不可用", "缺失"), "unavailable"),
        (("network", "connect", "dns", "网络"), "network"),
    )
    return next((label for markers, label in mapping if any(marker in text for marker in markers)), "provider_error")


def _health_state(status: str) -> str:
    if status == "fresh":
        return "healthy"
    if status in {"modeled", "delayed", "degraded", "latest_official"}:
        return "degraded"
    if status == "stale":
        return "stale"
    if status == "unavailable":
        return "unavailable"
    return "unknown"


def _source_states(
    detail: dict,
    context: dict,
    supplied: Iterable[SourceState | dict] | None,
) -> list[SourceState]:
    states: dict[str, SourceState] = {}
    detail_source = str(detail.get("source") or "fund_detail_unknown")[:100]
    detail_age = _number(detail.get("data_age_hours"))
    detail_stale = bool(detail.get("stale"))
    updated_at = _parse_datetime(detail.get("updated_at"))
    states[f"fund_detail:{detail_source}"] = SourceState(
        source_id=f"fund_detail:{detail_source}",
        state="stale" if detail_stale else "healthy" if updated_at else "unknown",
        last_success=updated_at,
        data_age_seconds=detail_age * 3600 if detail_age is not None and detail_age >= 0 else None,
        stale=detail_stale,
        error_class="stale" if detail_stale else None,
    )

    estimate_status = str(context.get("status") or "unavailable")
    estimate_source = str(context.get("source") or "estimate_unknown")[:100]
    estimate_state = _health_state(estimate_status)
    estimate_age = _number(context.get("age_seconds"))
    states[f"estimate:{estimate_source}"] = SourceState(
        source_id=f"estimate:{estimate_source}",
        state=estimate_state,
        last_success=_source_datetime(context.get("source_time")),
        data_age_seconds=max(0.0, estimate_age) if estimate_age is not None else None,
        stale=estimate_state in {"stale", "unavailable"},
        error_class=_error_class(context.get("fallback_reason")),
    )

    for raw in supplied or ():
        state = raw if isinstance(raw, SourceState) else SourceState.model_validate(raw)
        states[state.source_id] = state
    return [states[key] for key in sorted(states)]


def _geometric_score(factors: list[float]) -> float:
    safe = [min(1.0, max(0.01, factor)) for factor in factors]
    return 100 * math.prod(safe) ** (1 / len(safe))


def _evidence_strength(
    score: float | None,
    score_coverage: float,
    timing_coverage: float,
    estimate_status: str,
    source_states: list[SourceState],
) -> float:
    score_factor = score_coverage if score is not None else min(score_coverage, 0.35)
    source_factor = min((STATE_FACTOR[state.state] for state in source_states), default=0.6)
    freshness_factor = ESTIMATE_FACTOR.get(estimate_status, 0.5)
    value = _geometric_score([score_factor, timing_coverage, source_factor, freshness_factor])
    if score_coverage < 0.7:
        value = min(value, 55)
    if estimate_status in {"stale", "unavailable"}:
        value = min(value, 30)
    # Keep the pre-validation identity payload type-identical to the persisted
    # EvidenceSnapshot.  A cap such as ``min(value, 30)`` can otherwise leave
    # an ``int`` here while Pydantic normalizes the field to ``float``, causing
    # the deterministic evidence ID to reject its own immutable payload.
    return float(round(value, 2))


def _evidence_nodes(
    *,
    valuation: float | None,
    valuation_label: str | None,
    trend: str | None,
    momentum: str | None,
    score: float | None,
    score_coverage: float,
    drawdown: float | None,
    estimate_status: str,
    estimate_error_p80: float | None,
    estimate_samples: int | None,
) -> list[EvidenceNode]:
    nodes: list[EvidenceNode] = []
    if valuation is None:
        nodes.append(EvidenceNode(node_id="valuation", category="valuation", state="missing", label="估值证据不足"))
    else:
        state = "support" if valuation <= 35 else "constraint" if valuation >= 70 else "neutral"
        nodes.append(EvidenceNode(
            node_id="valuation", category="valuation", state=state,
            label=f"估值约 {round(valuation)}% 分位", value=round(valuation, 2),
        ))
    if trend:
        weak = any(word in trend for word in ("下降", "偏弱", "空头"))
        strong = any(word in trend for word in ("上升", "偏强", "多头"))
        nodes.append(EvidenceNode(
            node_id="trend", category="trend",
            state="constraint" if weak else "support" if strong else "neutral",
            label=f"趋势：{trend}", value=trend,
        ))
    else:
        nodes.append(EvidenceNode(node_id="trend", category="trend", state="missing", label="趋势证据不足"))
    if momentum:
        hot = any(word in momentum for word in ("超买", "过热", "偏强"))
        weak = any(word in momentum for word in ("超卖", "偏弱"))
        nodes.append(EvidenceNode(
            node_id="momentum", category="momentum",
            state="constraint" if hot else "support" if weak else "neutral",
            label=f"动量：{momentum}", value=momentum,
        ))
    else:
        nodes.append(EvidenceNode(node_id="momentum", category="momentum", state="missing", label="动量证据不足"))
    if score is None:
        nodes.append(EvidenceNode(node_id="quality", category="quality", state="missing", label="综合评分不可用"))
    else:
        nodes.append(EvidenceNode(
            node_id="quality", category="quality",
            state="support" if score >= 70 else "constraint" if score < 50 else "neutral",
            label=f"综合评分 {score:.1f}，覆盖 {score_coverage * 100:.0f}%", value=score,
        ))
    if drawdown is not None:
        nodes.append(EvidenceNode(
            node_id="drawdown", category="risk",
            state="constraint" if drawdown <= -30 else "neutral",
            label=f"历史最大回撤 {drawdown:.2f}%", value=drawdown,
        ))
    nodes.append(EvidenceNode(
        node_id="data_quality", category="data_quality",
        state="support" if estimate_status == "fresh" else "constraint" if estimate_status in {"stale", "unavailable"} else "neutral",
        label=f"估值数据状态：{estimate_status}", value=estimate_status,
    ))
    if estimate_error_p80 is not None or estimate_samples is not None:
        constrained = (estimate_samples is not None and estimate_samples < 20) or (
            estimate_error_p80 is not None and estimate_error_p80 > 2.5
        )
        parts = []
        if estimate_samples is not None:
            parts.append(f"样本 {estimate_samples}")
        if estimate_error_p80 is not None:
            parts.append(f"P80 误差 ±{estimate_error_p80:.2f}%")
        nodes.append(EvidenceNode(
            node_id="model_accuracy", category="model_accuracy",
            state="constraint" if constrained else "support",
            label="，".join(parts), value=estimate_error_p80,
        ))
    return nodes


def _historical_outcome_node(summary: dict | None) -> EvidenceNode:
    """Build a stable, directionless-until-mature real-outcome evidence node."""
    raw = summary if isinstance(summary, dict) else {}
    fund_code = str(raw.get("fund_code") or "")
    strategy_version = str(raw.get("strategy_version") or STRATEGY_VERSION)
    horizon_number = _number(raw.get("horizon"))
    horizon = (
        int(horizon_number)
        if horizon_number is not None and horizon_number in {5, 20, 60}
        else HISTORICAL_OUTCOME_HORIZON
    )
    sample_number = _number(raw.get("samples"))
    samples = (
        int(sample_number)
        if sample_number is not None and sample_number >= 0 and sample_number.is_integer()
        else 0
    )
    hit_rate = _bounded(raw.get("hit_rate"), 0, 100)
    mean_return = _number(raw.get("mean_return"))
    peer_excess = _number(raw.get("peer_excess"))
    source_id = stable_id("outcome", {
        "fund_code": fund_code,
        "strategy_version": strategy_version,
        "horizon": horizon,
    })
    if samples == 0:
        return EvidenceNode(
            node_id="historical_outcome",
            category="outcome",
            state="missing",
            label=f"同策略历史实盘：暂无已结算 {horizon} 日样本",
            source_id=source_id,
        )
    if samples < HISTORICAL_OUTCOME_MIN_SAMPLES:
        return EvidenceNode(
            node_id="historical_outcome",
            category="outcome",
            state="neutral",
            label=(
                f"同策略历史实盘：{horizon} 日样本 "
                f"{samples}/{HISTORICAL_OUTCOME_MIN_SAMPLES}，仅观察"
            ),
            value=round(hit_rate, 2) if hit_rate is not None else None,
            source_id=source_id,
        )
    state = (
        "support"
        if hit_rate is not None and hit_rate >= HISTORICAL_OUTCOME_SUPPORT_HIT_RATE
        else "constraint"
        if hit_rate is not None and hit_rate < HISTORICAL_OUTCOME_CONSTRAINT_HIT_RATE
        else "neutral"
    )
    metrics = [
        f"同策略历史实盘：{horizon} 日样本 {samples}",
        f"命中率 {hit_rate:.1f}%" if hit_rate is not None else "命中率缺失",
    ]
    if mean_return is not None:
        metrics.append(f"平均收益 {mean_return:+.2f}%")
    if peer_excess is not None:
        metrics.append(f"同类超额 {peer_excess:+.2f}%")
    return EvidenceNode(
        node_id="historical_outcome",
        category="outcome",
        state=state,
        label="，".join(metrics),
        value=round(hit_rate, 2) if hit_rate is not None else None,
        source_id=source_id,
    )


def build_evidence_snapshot(
    detail: dict,
    score_result: dict,
    signal_result: dict,
    backtest_result: dict,
    *,
    historical_outcome_summary: dict | None = None,
    source_states: Iterable[SourceState | dict] | None = None,
    created_at: datetime | None = None,
) -> EvidenceSnapshot:
    """Normalize scattered current objects into one immutable evidence input."""
    code = str(detail.get("code") or "").strip()
    if not re.fullmatch(r"\d{6}", code):
        raise ValueError("evidence requires a six-digit fund code")
    context = detail.get("decision_context") or {}
    layers = signal_result.get("layers") or {}
    valuation_layer = layers.get("valuation") or {}
    trend_layer = layers.get("trend") or {}
    momentum_layer = layers.get("sentiment") or {}
    valuation = _bounded(valuation_layer.get("pe_pct"), 0, 100)
    if valuation is None:
        valuation = _bounded(valuation_layer.get("percentile"), 0, 100)
    score = _bounded(score_result.get("score"), 0, 100)
    score_coverage = _bounded(score_result.get("coverage"), 0, 1)
    timing_coverage = _bounded(signal_result.get("coverage"), 0, 1)
    score_coverage = 0.0 if score_coverage is None else score_coverage
    timing_coverage = 0.0 if timing_coverage is None else timing_coverage
    risk_detail = ((score_result.get("components") or {}).get("risk") or {}).get("detail") or {}
    drawdown = _number(risk_detail.get("max_drawdown"))
    volatility = _number(risk_detail.get("volatility"))
    model_evidence = detail.get("overseas_evidence") or {}
    model_usable = isinstance(model_evidence, dict) and model_evidence.get("usable") is True
    # This bundled artifact is a delayed audit ledger. It may enrich a live
    # Worker observation with metrics for the exact same model version, but it
    # must never become the current prediction itself.
    model_accuracy_matches = (
        model_usable
        and bool(context.get("model_version"))
        and context.get("model_version") == model_evidence.get("model_version")
    )
    estimate_status = str(context.get("status") or ("stale" if detail.get("stale") else "latest_official"))
    supplied_sources = list(source_states or ())
    if model_usable:
        model_state = "stale" if model_evidence.get("status") == "stale" else "degraded"
        supplied_sources.append(SourceState(
            source_id="estimate:overseas_accuracy_artifact",
            state=model_state,
            last_success=_parse_datetime(model_evidence.get("observed_at")),
            data_age_seconds=_number(model_evidence.get("data_age_seconds")),
            stale=model_state == "stale",
            error_class="stale" if model_state == "stale" else None,
        ))
    normalized_sources = _source_states(detail, context, supplied_sources)

    accuracy = model_evidence if model_accuracy_matches else context.get("accuracy") or {}
    estimate_coverage = _bounded(
        _first_present(
            context.get("coverage"), context.get("model_coverage"), context.get("estimate_coverage"),
        ), 0, 100,
    )
    estimate_model_version = context.get("model_version") or context.get("estimate_model_version")
    if model_accuracy_matches:
        estimate_error_p80 = _number(model_evidence.get("error_p80"))
        estimate_samples_raw = model_evidence.get("sample_count")
        estimate_mae = _number(model_evidence.get("mae"))
        estimate_direction = _bounded(model_evidence.get("direction_accuracy"), 0, 100)
    else:
        estimate_error_p80 = _number(_first_present(
            context.get("error_p80"), context.get("estimate_error_p80"), accuracy.get("p80_error"),
        ))
        estimate_samples_raw = context.get("sample_count")
        if estimate_samples_raw is None:
            estimate_samples_raw = context.get("accuracy_samples", accuracy.get("samples"))
        estimate_mae = _number(_first_present(context.get("mae"), accuracy.get("mae")))
        estimate_direction = _bounded(_first_present(
            context.get("direction_accuracy"), accuracy.get("direction_accuracy"),
        ), 0, 100)
    estimate_samples = int(estimate_samples_raw) if _number(estimate_samples_raw) is not None and int(estimate_samples_raw) >= 0 else None

    official_nav = _number(
        context.get("value_nav") if context.get("kind") == "official_nav" else context.get("base_nav")
    )
    if official_nav is None or official_nav <= 0:
        official_nav = _number(detail.get("latest_nav"))
    if official_nav is not None and official_nav <= 0:
        official_nav = None
    official_nav_date = _parse_date(
        context.get("value_date") if context.get("kind") == "official_nav" else context.get("base_nav_date")
    ) or _parse_date(detail.get("latest_nav_date"))
    target_nav_date = _parse_date(context.get("target_nav_date"))
    market_time = _parse_datetime(context.get("market_time"))
    if market_time is None and context.get("source_time_precision") == "datetime":
        market_time = _parse_datetime(context.get("source_time"))

    missing = []
    for field, value in (
        ("official_nav", official_nav),
        ("official_nav_date", official_nav_date),
        ("score", score),
        ("valuation_percentile", valuation),
        ("trend_state", trend_layer.get("label")),
        ("momentum_state", momentum_layer.get("label")),
    ):
        if value is None or value == "":
            missing.append(field)
    stale = []
    if detail.get("stale"):
        stale.append("fund_detail")
    if estimate_status in {"stale", "unavailable"}:
        stale.append("estimate")

    risks = [str(flag) for flag in (detail.get("risk_flags") or []) if str(flag).strip()]
    if isinstance(model_evidence, dict) and model_evidence and not model_usable:
        risks.append(f"qdii_evidence_rejected:{model_evidence.get('rejection_reason') or 'unknown'}")
    if official_nav is None or official_nav_date is None:
        risks.append("official_nav_missing")
    if score_coverage < 0.7:
        risks.append("score_coverage_low")
    if timing_coverage < 0.6:
        risks.append("timing_coverage_low")
    if valuation_layer.get("source") == "nav_detrended":
        risks.append("valuation_proxy")
    if estimate_status in {"stale", "unavailable"}:
        risks.append("source_stale" if estimate_status == "stale" else "estimate_unavailable")
    fund_text = f"{detail.get('type') or ''} {detail.get('name') or ''}".upper()
    overseas = any(marker in fund_text for marker in ("QDII", "海外", "全球", "纳斯达克", "标普"))
    if estimate_status == "modeled" and (estimate_coverage is None or estimate_coverage < 70):
        risks.append("model_coverage_low")
    if overseas and any(value is None for value in (
        estimate_coverage, estimate_model_version, estimate_samples, estimate_mae,
        estimate_error_p80, estimate_direction, target_nav_date, market_time,
    )):
        risks.append("qdii_accuracy_missing")
    if overseas and estimate_samples is not None and estimate_samples < 20:
        risks.append("qdii_low_sample")
    if overseas and estimate_error_p80 is not None and estimate_error_p80 > 2.5:
        risks.append("qdii_high_error")
    risks = sorted(set(risks))

    strength = _evidence_strength(score, score_coverage, timing_coverage, estimate_status, normalized_sources)
    nodes = _evidence_nodes(
        valuation=valuation,
        valuation_label=valuation_layer.get("label"),
        trend=trend_layer.get("label"),
        momentum=momentum_layer.get("label"),
        score=score,
        score_coverage=score_coverage,
        drawdown=drawdown,
        estimate_status=estimate_status,
        estimate_error_p80=estimate_error_p80,
        estimate_samples=estimate_samples,
    )
    nodes.append(_historical_outcome_node(historical_outcome_summary))
    id_payload = {
        "schema_version": "v8-evidence-1",
        "fund_code": code,
        "fund_name": detail.get("name"),
        "fund_type": str(detail.get("type") or "未知"),
        "market_time": market_time,
        "official_nav": official_nav,
        "official_nav_date": official_nav_date,
        "target_nav_date": target_nav_date,
        "benchmark_id": detail.get("benchmark_id"),
        "valuation_percentile": valuation,
        "trend_state": trend_layer.get("label"),
        "momentum_state": momentum_layer.get("label"),
        "drawdown": drawdown,
        "volatility": volatility,
        "market_temperature": _bounded(detail.get("market_temperature"), 0, 100),
        "score": score,
        "score_version": score_result.get("score_version"),
        "score_coverage": score_coverage,
        "timing_signal": signal_result.get("signal"),
        "timing_coverage": timing_coverage,
        "estimate": _number(
            context.get("estimate_change")
            if context.get("kind") in {
                "intraday_estimate", "qdii_next_nav_estimate", "holdings_model",
            }
            else None,
        ),
        "estimate_status": estimate_status,
        "estimate_coverage": estimate_coverage,
        "estimate_model_version": estimate_model_version,
        "estimate_error_p80": estimate_error_p80,
        "estimate_sample_count": estimate_samples,
        "estimate_mae": estimate_mae,
        "estimate_direction_accuracy": estimate_direction,
        "source_states": normalized_sources,
        "evidence_nodes": nodes,
        "evidence_strength": strength,
        "missing_fields": sorted(set(missing)),
        "stale_fields": sorted(set(stale)),
        "risk_flags": risks,
    }
    return EvidenceSnapshot(
        evidence_id=stable_id("ev", id_payload),
        created_at=_snapshot_time(created_at),
        **id_payload,
    )


def build_holding_version(
    fund_code: str,
    *,
    is_held: bool,
    shares: float | None = None,
    cost: float | None = None,
    market_value: float | None = None,
    account: str | None = None,
    current_weight: float | None = None,
    target_weight: float | None = None,
    updated_at: datetime | None = None,
    source: str = "api",
    created_at: datetime | None = None,
) -> HoldingVersion:
    numeric = {
        "shares": _number(shares),
        "cost": _number(cost),
        "market_value": _number(market_value),
        "current_weight": _number(current_weight),
        "target_weight": _number(target_weight),
    }
    semantic = {
        "schema_version": "v8-holding-1",
        "fund_code": fund_code,
        "user_state": "held" if is_held else "unheld",
        "shares": numeric["shares"],
        "cost": numeric["cost"],
        "market_value": numeric["market_value"],
        "account": account,
        "current_weight": numeric["current_weight"],
        "target_weight": numeric["target_weight"],
        "updated_at": updated_at,
        "source": source,
    }
    return HoldingVersion(
        holding_version=stable_id("hold", semantic),
        created_at=_snapshot_time(created_at),
        **semantic,
    )


def build_portfolio_policy(
    *,
    name: str,
    target_allocations: dict[str, float] | None = None,
    target_ranges: dict[str, tuple[float, float]] | None = None,
    max_single_fund_weight: float | None = None,
    max_theme_weight: float | None = None,
    rebalance_band: float | None = None,
    dca_rules: dict[str, Any] | None = None,
    reduce_rules: dict[str, Any] | None = None,
    sell_rules: dict[str, Any] | None = None,
    effective_at: datetime | None = None,
    source: str = "user",
    supersedes: str | None = None,
    created_at: datetime | None = None,
) -> PortfolioPolicy:
    for value in (target_allocations or {}).values():
        if isinstance(value, bool):
            raise ValueError("target allocations cannot contain booleans")
    for bounds in (target_ranges or {}).values():
        if any(isinstance(value, bool) for value in bounds):
            raise ValueError("target ranges cannot contain booleans")
    allocations = {str(key): float(value) for key, value in (target_allocations or {}).items()}
    ranges = {
        str(key): (float(value[0]), float(value[1]))
        for key, value in (target_ranges or {}).items()
    }
    effective = _snapshot_time(effective_at)
    semantic = {
        "schema_version": "v8-policy-1",
        "name": name,
        "target_allocations": allocations,
        "target_ranges": ranges,
        "max_single_fund_weight": _number(max_single_fund_weight),
        "max_theme_weight": _number(max_theme_weight),
        "rebalance_band": _number(rebalance_band),
        "dca_rules": dca_rules or {},
        "reduce_rules": reduce_rules or {},
        "sell_rules": sell_rules or {},
        "effective_at": effective,
        "source": source,
        "supersedes": supersedes,
    }
    return PortfolioPolicy(
        policy_version=stable_id("pol", semantic),
        created_at=_snapshot_time(created_at),
        **semantic,
    )


def default_portfolio_policy(created_at: datetime | None = None) -> PortfolioPolicy:
    current = _snapshot_time(created_at)
    return build_portfolio_policy(
        name="系统默认护栏",
        max_single_fund_weight=40,
        max_theme_weight=60,
        rebalance_band=2,
        dca_rules={"max_step_percent": 5, "minimum_confidence": 55},
        reduce_rules={"max_step_percent": 5},
        sell_rules={"require_structural_invalidation": True},
        effective_at=datetime.combine(date(2026, 8, 25), time.min, tzinfo=timezone.utc),
        source="system-default",
        created_at=current,
    )


def _weak_trend(value: str | None) -> bool:
    return bool(value and any(word in value for word in ("下降", "偏弱", "空头")))


def _strong_trend(value: str | None) -> bool:
    return bool(value and any(word in value for word in ("上升", "偏强", "多头")))


def _policy_value(mapping: dict[str, Any], evidence: EvidenceSnapshot) -> Any:
    if evidence.fund_code in mapping:
        return mapping[evidence.fund_code]
    if evidence.fund_type in mapping:
        return mapping[evidence.fund_type]
    return None


def _position_state(
    evidence: EvidenceSnapshot,
    holding: HoldingVersion,
    policy: PortfolioPolicy,
) -> tuple[str, float | None, tuple[float, float] | None, float | None]:
    target = holding.target_weight
    if target is None:
        target = _number(_policy_value(policy.target_allocations, evidence))
    bounds = _policy_value(policy.target_ranges, evidence)
    if bounds is not None:
        target_range = (float(bounds[0]), float(bounds[1]))
    elif target is not None:
        band = policy.rebalance_band if policy.rebalance_band is not None else 0.0
        target_range = (max(0.0, target - band), min(100.0, target + band))
    else:
        target_range = None
    current = 0.0 if holding.user_state == "unheld" else holding.current_weight
    if current is None:
        return "unknown", target, target_range, None
    if policy.max_single_fund_weight is not None and current > policy.max_single_fund_weight:
        return "overweight", target, target_range, current
    if target_range is None:
        return "unknown", target, None, current
    if current < target_range[0] - 1e-9:
        return "underweight", target, target_range, current
    if current > target_range[1] + 1e-9:
        return "overweight", target, target_range, current
    return "in_range", target, target_range, current


def _position_evidence_nodes(
    holding: HoldingVersion,
    policy: PortfolioPolicy,
    *,
    position_state: str,
    current: float | None,
    target_range: tuple[float, float] | None,
) -> list[EvidenceNode]:
    """Describe position and portfolio guardrails as structured evidence.

    These nodes belong to the decision snapshot rather than the market
    evidence snapshot: holdings and policy are independently versioned inputs
    and must not change the evidence identity.
    """
    if current is None:
        holding_node = EvidenceNode(
            node_id="holding_position",
            category="holding",
            state="missing",
            label="持仓权重缺失，仓位建议不做精确计算",
            source_id=holding.holding_version,
        )
    elif holding.user_state == "unheld":
        holding_node = EvidenceNode(
            node_id="holding_position",
            category="holding",
            state="neutral",
            label="当前空仓",
            value=0.0,
            source_id=holding.holding_version,
        )
    else:
        state = "constraint" if position_state == "overweight" else "support" if position_state == "underweight" else "neutral"
        range_text = (
            f"，目标区间 {target_range[0]:.2f}%–{target_range[1]:.2f}%"
            if target_range is not None
            else "，目标区间缺失"
        )
        holding_node = EvidenceNode(
            node_id="holding_position",
            category="holding",
            state=state,
            label=f"当前仓位 {current:.2f}%{range_text}",
            value=round(current, 2),
            source_id=holding.holding_version,
        )

    limit = policy.max_single_fund_weight
    if limit is None:
        portfolio_node = EvidenceNode(
            node_id="portfolio_single_fund_limit",
            category="portfolio",
            state="missing",
            label="组合政策未设置单基金上限",
            source_id=policy.policy_version,
        )
    else:
        breached = current is not None and current > limit + 1e-9
        portfolio_node = EvidenceNode(
            node_id="portfolio_single_fund_limit",
            category="portfolio",
            state="constraint" if breached else "neutral",
            label=(
                f"当前仓位 {current:.2f}% 超过单基金上限 {limit:.2f}%"
                if breached
                else f"单基金政策上限 {limit:.2f}%"
            ),
            value=round(limit, 2),
            source_id=policy.policy_version,
        )
    return [holding_node, portfolio_node]


def _model_factor(evidence: EvidenceSnapshot) -> float:
    factor = 1.0
    if "qdii_accuracy_missing" in evidence.risk_flags:
        factor = min(factor, 0.35)
    if evidence.estimate_status == "modeled":
        if evidence.estimate_coverage is None:
            factor = min(factor, 0.35)
        else:
            factor = min(factor, max(0.2, evidence.estimate_coverage / 100))
    if evidence.estimate_sample_count is not None and evidence.estimate_sample_count < 20:
        factor = min(factor, 0.6)
    p80 = evidence.estimate_error_p80
    if p80 is not None:
        factor = min(factor, 1.0 if p80 <= 0.75 else 0.82 if p80 <= 1.5 else 0.58 if p80 <= 2.5 else 0.35)
    return factor


def _confidence(evidence: EvidenceSnapshot) -> int:
    supporting = sum(node.state == "support" for node in evidence.evidence_nodes)
    constraining = sum(node.state == "constraint" for node in evidence.evidence_nodes)
    consistency = 0.78 if supporting and constraining else 0.94
    model = _model_factor(evidence)
    value = _geometric_score([
        max(0.01, evidence.evidence_strength / 100),
        model,
        consistency,
    ])
    if evidence.score_coverage < 0.7:
        value = min(value, 55)
    if evidence.estimate_status in {"stale", "unavailable"}:
        value = min(value, 30)
    if "qdii_low_sample" in evidence.risk_flags:
        value = min(value, 55)
    if "qdii_high_error" in evidence.risk_flags:
        value = min(value, 45)
    if "qdii_accuracy_missing" in evidence.risk_flags:
        value = min(value, 40)
    if "model_coverage_low" in evidence.risk_flags:
        value = min(value, 50)
    if "official_nav_missing" in evidence.risk_flags:
        value = min(value, 25)
    return max(0, min(100, round(value)))


def _reason_codes(
    evidence: EvidenceSnapshot,
    action: str,
    position_state: str,
) -> list[str]:
    codes = [f"ACTION_{action.upper()}"]
    codes.append("SCORE_SUFFICIENT" if evidence.score is not None and evidence.score_coverage >= 0.7 else "SCORE_INSUFFICIENT")
    if evidence.valuation_percentile is None:
        codes.append("VALUATION_MISSING")
    elif evidence.valuation_percentile <= 35:
        codes.append("VALUATION_LOW")
    elif evidence.valuation_percentile >= 70:
        codes.append("VALUATION_HIGH")
    else:
        codes.append("VALUATION_MID")
    codes.append(
        "TREND_WEAK" if _weak_trend(evidence.trend_state)
        else "TREND_STRONG" if _strong_trend(evidence.trend_state)
        else "TREND_NEUTRAL" if evidence.trend_state else "TREND_MISSING"
    )
    signal = str(evidence.timing_signal or "").upper()
    signal_code = {
        "买入": "SIGNAL_BUY", "定投": "SIGNAL_DCA", "持有": "SIGNAL_HOLD",
        "减仓": "SIGNAL_REDUCE", "观察": "SIGNAL_WATCH",
    }.get(signal, "SIGNAL_UNKNOWN")
    codes.append(signal_code)
    codes.append(f"POSITION_{position_state.upper()}")
    codes.append(f"DATA_{evidence.estimate_status.upper()}")
    if "qdii_low_sample" in evidence.risk_flags:
        codes.append("QDII_MODEL_AUXILIARY")
    if "qdii_accuracy_missing" in evidence.risk_flags:
        codes.append("QDII_ACCURACY_MISSING")
    elif evidence.target_nav_date is not None:
        codes.append("QDII_TARGET_DATE_BOUND")
    if "qdii_high_error" in evidence.risk_flags:
        codes.append("QDII_MODEL_HIGH_ERROR")
    if set(evidence.risk_flags) & STRUCTURAL_RISKS:
        codes.append("STRUCTURAL_RISK")
    return list(dict.fromkeys(codes))


def _reason_text(code: str, evidence: EvidenceSnapshot) -> str:
    mapping = {
        "SCORE_INSUFFICIENT": f"综合评分覆盖仅 {evidence.score_coverage * 100:.0f}%，不支持强动作",
        "VALUATION_MISSING": "估值证据不足",
        "VALUATION_LOW": f"估值处于相对低位（约 {evidence.valuation_percentile:.0f}% 分位）",
        "VALUATION_HIGH": f"估值处于相对高位（约 {evidence.valuation_percentile:.0f}% 分位）",
        "VALUATION_MID": f"估值处于中位区域（约 {evidence.valuation_percentile:.0f}% 分位）",
        "TREND_WEAK": f"趋势偏弱（{evidence.trend_state}）",
        "TREND_STRONG": f"趋势偏强（{evidence.trend_state}）",
        "TREND_NEUTRAL": f"趋势中性（{evidence.trend_state}）",
        "TREND_MISSING": "趋势证据不足",
        "SIGNAL_BUY": "择时证据偏多",
        "SIGNAL_DCA": "择时证据支持按计划分批投入",
        "SIGNAL_HOLD": "择时证据偏中性",
        "SIGNAL_REDUCE": "择时证据提示短期风险",
        "SIGNAL_WATCH": "择时证据覆盖不足",
        "SIGNAL_UNKNOWN": "择时状态未知",
        "POSITION_UNDERWEIGHT": "当前仓位低于目标区间",
        "POSITION_IN_RANGE": "当前仓位位于目标区间",
        "POSITION_OVERWEIGHT": "当前仓位高于目标区间或单基金上限",
        "POSITION_UNKNOWN": "缺少完整仓位或目标信息，不做伪精确仓位计算",
        "DATA_FRESH": "盘中证据新鲜",
        "DATA_MODELED": "盘中证据来自持仓/海外模型，仅作辅助",
        "DATA_DELAYED": "盘中证据延迟，已降低结论强度",
        "DATA_DEGRADED": "数据源已降级，已降低结论强度",
        "DATA_LATEST_OFFICIAL": "仅使用最新正式净值，不伪装盘中实时值",
        "DATA_STALE": "关键数据已过期，强动作已关闭",
        "DATA_UNAVAILABLE": "关键数据不可用，强动作已关闭",
        "QDII_MODEL_AUXILIARY": "海外模型成熟样本不足，仅作辅助证据",
        "QDII_TARGET_DATE_BOUND": f"海外估值绑定目标净值日 {evidence.target_nav_date}",
        "QDII_MODEL_HIGH_ERROR": "海外模型历史 P80 误差偏高，已降低模型权重",
        "QDII_ACCURACY_MISSING": "海外模型缺少完整准确率与目标日证据，已关闭强动作",
        "STRUCTURAL_RISK": "存在结构性失效风险，需要严格复核",
    }
    if code == "SCORE_SUFFICIENT":
        return f"综合评分 {evidence.score:.1f}，覆盖 {evidence.score_coverage * 100:.0f}%"
    return mapping.get(code, code)


def _risks(evidence: EvidenceSnapshot, position_state: str) -> list[str]:
    mapping = {
        "official_nav_missing": "正式净值或归属日缺失，无法进行可靠结果结算",
        "score_coverage_low": "评分数据覆盖不足",
        "timing_coverage_low": "择时证据覆盖不足",
        "valuation_proxy": "估值使用净值代理，不等同真实 PE/PB",
        "source_stale": "数据源已过期",
        "estimate_unavailable": "盘中估值不可用",
        "qdii_low_sample": "QDII/海外模型样本不足 20 条",
        "qdii_high_error": "QDII/海外模型历史误差偏高",
        "qdii_accuracy_missing": "QDII/海外模型准确率或目标日证据不完整",
        "model_coverage_low": "模型对当前基金的有效覆盖不足 70%",
        "product_invalid": "基金产品本身可能失效",
        "strategy_invalid": "当前策略适用性可能失效",
        "quality_breakdown": "长期质量证据显著恶化",
        "policy_disallowed": "当前资产配置政策不允许继续持有",
        "manager_changed": "基金经理发生变化，需要重新积累证据",
    }
    values = [mapping.get(flag, f"风险标记：{flag}") for flag in evidence.risk_flags]
    if position_state == "unknown":
        values.append("仓位或目标信息不完整，仓位建议不做精确计算")
    values.append("系统只提供数据辅助决策，不执行真实交易")
    return list(dict.fromkeys(values))


def _invalidation(action: str) -> tuple[list[str], list[str]]:
    if action in {"buy", "dca", "add"}:
        return (
            ["VALUATION_RISES", "QUALITY_FALLS", "TARGET_REACHED", "DATA_DEGRADES"],
            [
                "估值进入高位时停止新增并复核",
                "综合质量跌破门槛时停止投入",
                "仓位达到目标区间时转为持有",
                "关键数据过期或不可用时关闭强动作",
            ],
        )
    if action in {"reduce", "sell"}:
        return (
            ["VALUATION_NORMALIZES", "TREND_STABILIZES", "RISK_CLEARS", "DATA_DEGRADES"],
            [
                "估值回落到合理区间时重新评估",
                "趋势企稳且质量未恶化时降低防御动作",
                "结构性风险解除后重新评估持仓",
                "当前证据失效时暂停进一步操作并等待确认",
            ],
        )
    return (
        ["VALUATION_BECOMES_LOW", "TREND_BREAKS", "POSITION_LEAVES_RANGE", "DATA_DEGRADES"],
        [
            "估值进入低位且趋势企稳时考虑新增",
            "趋势与长期质量同时恶化时转为防御",
            "仓位离开目标区间时重新评估",
            "数据质量下降时继续保持低强度结论",
        ],
    )


def _guidance(
    action: str,
    holding: HoldingVersion,
    policy: PortfolioPolicy,
    target: float | None,
    target_range: tuple[float, float] | None,
    current: float | None,
) -> PositionGuidance:
    precise = current is not None and target_range is not None
    change = None
    suggested = None
    amount = None
    if action in {"buy", "dca", "add"}:
        max_step = _number(policy.dca_rules.get("max_step_percent"))
        max_step = 5.0 if max_step is None else max_step
        if precise:
            gap = max(0.0, target_range[0] - current)
            change = round(min(gap, max_step), 2)
            suggested = (round(current, 2), round(min(target_range[1], current + change), 2))
        method = "在目标仓位内分批投入，不一次性满仓"
    elif action == "reduce":
        max_step = _number(policy.reduce_rules.get("max_step_percent"))
        max_step = 5.0 if max_step is None else max_step
        if precise:
            excess = max(0.0, current - target_range[1])
            change = -round(min(excess, max_step), 2)
            after = max(target_range[1], current + change)
            suggested = (round(target_range[1], 2), round(after, 2))
        method = "分批降低到目标区间；减仓不等于清仓"
    elif action == "sell":
        if current is not None:
            change = -round(current, 2)
            suggested = (0.0, 0.0)
        method = "结构性失效条件同时满足时分批退出，并复核赎回成本"
    else:
        if current is not None:
            change = 0.0
            suggested = (round(current, 2), round(current, 2))
        method = "维持计划并按失效条件复核，不因单日波动追涨杀跌"
    if change is not None and holding.market_value is not None and current and current > 0:
        amount = round(holding.market_value * abs(change) / current, 2)
    return PositionGuidance(
        current_weight=current,
        target_weight=target,
        target_range=target_range,
        suggested_change=change,
        suggested_range=suggested,
        method=method,
        amount=amount,
        precise=precise,
    )


def build_decision_snapshot(
    evidence: EvidenceSnapshot,
    holding: HoldingVersion,
    policy: PortfolioPolicy,
    *,
    strategy_version: str = STRATEGY_VERSION,
    created_at: datetime | None = None,
) -> DecisionSnapshot:
    """Apply the deterministic action state machine to immutable inputs."""
    confidence = _confidence(evidence)
    position_state, target, target_range, current = _position_state(evidence, holding, policy)
    score = evidence.score
    valuation = evidence.valuation_percentile
    trend_weak = _weak_trend(evidence.trend_state)
    trend_strong = _strong_trend(evidence.trend_state)
    signal = evidence.timing_signal
    structural = bool(set(evidence.risk_flags) & STRUCTURAL_RISKS)
    minimum_confidence = _number(policy.dca_rules.get("minimum_confidence"))
    minimum_confidence = 60.0 if minimum_confidence is None else max(60.0, minimum_confidence)
    data_strong = (
        confidence >= minimum_confidence
        and score is not None
        and evidence.score_coverage >= 0.7
        and evidence.estimate_status not in {"stale", "unavailable"}
    )
    positive = 0
    negative = 0
    if score is not None:
        positive += 2 if score >= 75 else 1 if score >= 60 else 0
        negative += 2 if score < 45 else 1 if score < 60 else 0
    if valuation is not None:
        positive += 2 if valuation <= 35 else 1 if valuation <= 50 else 0
        negative += 2 if valuation >= 80 else 1 if valuation >= 70 else 0
    positive += 1 if trend_strong else 0
    negative += 1 if trend_weak else 0
    positive += 2 if signal == "买入" else 1 if signal == "定投" else 0
    negative += 2 if signal == "减仓" else 0

    if holding.user_state == "unheld":
        if not data_strong:
            action = "watch"
        elif score is not None and score >= 75 and valuation is not None and valuation <= 40 and not trend_weak and signal == "买入":
            action = "buy"
        elif (
            score is not None and score >= 60
            and valuation is not None and valuation <= 60
            and positive >= 3 and negative < 3
        ):
            action = "dca"
        else:
            action = "watch"
    else:
        require_structural = policy.sell_rules.get("require_structural_invalidation", True) is not False
        sell_allowed = (
            (structural if require_structural else structural or negative >= 5)
            and data_strong
            and confidence >= 75
            and score is not None and score <= 40
            and trend_weak
        )
        if sell_allowed:
            action = "sell"
        elif position_state == "overweight" or (negative >= 4 and confidence >= 45):
            action = "reduce"
        elif position_state == "underweight" and data_strong and positive >= 3:
            action = "add"
        else:
            action = "hold"

    # Hard gates are applied after the state machine so no future wording or UI
    # layer can re-enable a strong action from weak data.
    if action in {"buy", "add"} and confidence < 65:
        action = "watch" if holding.user_state == "unheld" else "hold"
    if action == "sell" and confidence < 75:
        action = "reduce" if position_state == "overweight" else "hold"

    base_strength = 40 + positive * 7 + negative * (5 if action in {"reduce", "sell"} else -3)
    if action in {"watch", "hold"}:
        base_strength = min(55, max(25, confidence))
    if action == "add" and current is not None and target_range is not None:
        gap = max(0.0, target_range[0] - current)
        base_strength = min(base_strength, 45 + min(30, gap * 2))
    if action == "reduce" and current is not None and target_range is not None:
        excess = max(0.0, current - target_range[1])
        base_strength = max(base_strength, 45 + min(30, excess * 2))
    strength = max(0, min(100, round(base_strength), confidence + 10))
    if evidence.estimate_status in {"modeled", "delayed", "latest_official"}:
        strength = min(strength, 65)
    elif evidence.estimate_status == "degraded":
        strength = min(strength, 55)
    elif evidence.estimate_status in {"stale", "unavailable"}:
        strength = min(strength, 30)

    codes = _reason_codes(evidence, action, position_state)
    visible_codes = [code for code in codes if not code.startswith("ACTION_")]
    reasons = [_reason_text(code, evidence) for code in visible_codes]
    reasons = list(dict.fromkeys(reasons))
    invalidation_codes, invalidation = _invalidation(action)
    guidance = _guidance(action, holding, policy, target, target_range, current)
    summary = f"当前建议：{ACTION_ZH[action]}。置信度 {confidence}/100，动作强度 {strength}/100。"
    id_input = {
        "fund_code": evidence.fund_code,
        "evidence_id": evidence.evidence_id,
        "holding_version": holding.holding_version,
        "policy_version": policy.policy_version,
        "strategy_version": strategy_version,
    }
    decision_nodes = [
        *evidence.evidence_nodes,
        *_position_evidence_nodes(
            holding,
            policy,
            position_state=position_state,
            current=current,
            target_range=target_range,
        ),
    ]
    return DecisionSnapshot(
        decision_id=stable_id("dec", id_input),
        evidence_id=evidence.evidence_id,
        fund_code=evidence.fund_code,
        holding_version=holding.holding_version,
        policy_version=policy.policy_version,
        strategy_version=strategy_version,
        user_state=holding.user_state,
        action=action,
        strength=strength,
        confidence=confidence,
        summary=summary,
        reason_codes=codes,
        reasons=reasons,
        risks=_risks(evidence, position_state),
        invalidation_codes=invalidation_codes,
        invalidation_conditions=invalidation,
        position_guidance=guidance,
        evidence_nodes=decision_nodes,
        created_at=_snapshot_time(created_at or evidence.created_at),
    )


def build_decision_diff(
    current: DecisionSnapshot,
    current_evidence: EvidenceSnapshot,
    previous: DecisionSnapshot | None,
    previous_evidence: EvidenceSnapshot | None,
    current_holding: HoldingVersion | None = None,
    previous_holding: HoldingVersion | None = None,
) -> DecisionDiff:
    """Compare only structured fields; no generative text is involved."""
    if previous is None or previous_evidence is None:
        return DecisionDiff(
            previous_decision_id=None,
            current_decision_id=current.decision_id,
            previous_action=None,
            current_action=current.action,
            changed=False,
            drivers=["这是该基金首条 v8 决策快照"],
            driver_codes=["FIRST_V8_DECISION"],
            unchanged=[],
        )
    drivers: list[str] = []
    codes: list[str] = []
    unchanged: list[str] = []
    if previous.action != current.action:
        drivers.append(f"动作从 {ACTION_ZH[previous.action]} 变为 {ACTION_ZH[current.action]}")
        codes.append("ACTION_CHANGED")
    else:
        unchanged.append(f"动作维持 {ACTION_ZH[current.action]}")

    for key, label, before, after in (
        ("CONFIDENCE", "置信度", previous.confidence, current.confidence),
        ("STRENGTH", "动作强度", previous.strength, current.strength),
    ):
        if before != after:
            drivers.append(f"{label}从 {before} 变为 {after}")
            codes.append(f"{key}_CHANGED")
        else:
            unchanged.append(f"{label}维持 {after}")
    for key, label, before, after in (
        ("POLICY_VERSION", "策略政策版本", previous.policy_version, current.policy_version),
        ("HOLDING_VERSION", "持仓版本", previous.holding_version, current.holding_version),
        ("STRATEGY_VERSION", "决策内核版本", previous.strategy_version, current.strategy_version),
    ):
        if before != after:
            drivers.append(f"{label}发生变化")
            codes.append(f"{key}_CHANGED")

    comparisons = (
        ("score", "综合评分", previous_evidence.score, current_evidence.score, 0.1),
        ("valuation", "估值分位", previous_evidence.valuation_percentile, current_evidence.valuation_percentile, 0.1),
        ("evidence_strength", "证据强度", previous_evidence.evidence_strength, current_evidence.evidence_strength, 0.1),
    )
    for key, label, before, after, tolerance in comparisons:
        if before is None and after is None:
            unchanged.append(f"{label}仍不可用")
        elif before is None or after is None or abs(after - before) >= tolerance:
            drivers.append(f"{label}从 {before if before is not None else '缺失'} 变为 {after if after is not None else '缺失'}")
            codes.append(f"{key.upper()}_CHANGED")
        else:
            unchanged.append(f"{label}基本不变")
    if previous_evidence.trend_state != current_evidence.trend_state:
        drivers.append(f"趋势从 {previous_evidence.trend_state or '缺失'} 变为 {current_evidence.trend_state or '缺失'}")
        codes.append("TREND_CHANGED")
    else:
        unchanged.append(f"趋势维持 {current_evidence.trend_state or '缺失'}")
    if previous_evidence.estimate_status != current_evidence.estimate_status:
        drivers.append(f"数据状态从 {previous_evidence.estimate_status} 变为 {current_evidence.estimate_status}")
        codes.append("DATA_STATUS_CHANGED")
    else:
        unchanged.append(f"数据状态维持 {current_evidence.estimate_status}")
    if set(previous_evidence.risk_flags) != set(current_evidence.risk_flags):
        drivers.append("结构化风险标记发生变化")
        codes.append("RISK_FLAGS_CHANGED")
    before_weight = previous_holding.current_weight if previous_holding else None
    after_weight = current_holding.current_weight if current_holding else None
    if before_weight != after_weight:
        drivers.append(f"当前仓位从 {before_weight if before_weight is not None else '未知'}% 变为 {after_weight if after_weight is not None else '未知'}%")
        codes.append("CURRENT_WEIGHT_CHANGED")
    before_target = previous.position_guidance.target_range if previous.position_guidance else None
    after_target = current.position_guidance.target_range if current.position_guidance else None
    if before_target != after_target:
        drivers.append(f"目标仓位区间从 {before_target or '未知'} 变为 {after_target or '未知'}")
        codes.append("TARGET_RANGE_CHANGED")
    return DecisionDiff(
        previous_decision_id=previous.decision_id,
        current_decision_id=current.decision_id,
        previous_action=previous.action,
        current_action=current.action,
        changed=bool(codes),
        drivers=drivers or ["结构化证据未出现可解释变化"],
        driver_codes=codes or ["NO_MATERIAL_CHANGE"],
        unchanged=list(dict.fromkeys(unchanged)),
    )
