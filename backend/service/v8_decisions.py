"""Application service that composes v8 I/O-free rules with persistence."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import math
from typing import Callable

from models.api import V8DecisionBatchRequest, V8DecisionItem
from models.v8 import HoldingVersion, PortfolioPolicy
from service import overseas_evidence, repo, v8_repo
from strategy.decision_v2 import (
    ACTION_ZH,
    HISTORICAL_OUTCOME_HORIZON,
    STRATEGY_VERSION,
    build_decision_snapshot,
    build_evidence_snapshot,
    build_holding_version,
)
from strategy.scoring import score_fund
from strategy.timing import timing_signal


class IdempotencyConflictError(RuntimeError):
    pass


class IdempotencyInProgressError(RuntimeError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


MAX_FUTURE_SKEW = timedelta(minutes=5)
MAX_LIVE_QUOTE_AGE = timedelta(minutes=90)
BEIJING = timezone(timedelta(hours=8))


def _parse_datetime(value) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else None


def _parse_date(value) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _unavailable_context(raw: dict, reason: str) -> dict:
    source = str(raw.get("source") or "estimate")[:60]
    return {
        "status": "unavailable",
        "source": f"rejected:{source}"[:80],
        "kind": "unavailable",
        "source_time": None,
        "source_time_precision": "date",
        "is_fallback": True,
        "fallback_reason": reason,
        "estimate_change": None,
        "estimate_nav": None,
        "base_nav": None,
        "base_nav_date": None,
        "value_nav": None,
        "value_date": None,
        "target_nav_date": None,
        "market_time": None,
        "diagnostics": {"primary_reason": reason, "source_time_precision": "date"},
    }


def _validated_estimate_context(detail: dict, context: dict | None, stamp: datetime) -> dict:
    """Revalidate trusted-Worker evidence against server time and official NAV.

    Request models reject malformed shapes.  This second boundary rejects
    internally valid but temporally impossible or cross-source-misaligned data.
    """
    raw = dict(context or {})
    kind = raw.get("kind")
    if kind == "unavailable" or raw.get("status") == "unavailable":
        return raw or _unavailable_context({}, "estimate_unavailable")

    if kind in {"estimate", "holdings_model", "official_nav"}:
        base_nav = raw.get("value_nav") if kind == "official_nav" else raw.get("base_nav")
        detail_nav = detail.get("latest_nav")
        base_date = _parse_date(raw.get("value_date") if kind == "official_nav" else raw.get("base_nav_date"))
        detail_date = _parse_date(detail.get("latest_nav_date"))
        try:
            nav_matches = (
                base_nav is not None and detail_nav is not None
                and math.isclose(float(base_nav), float(detail_nav), rel_tol=1e-8, abs_tol=1e-8)
            )
        except (TypeError, ValueError):
            nav_matches = False
        if not nav_matches or base_date is None or base_date != detail_date:
            return _unavailable_context(raw, "base_nav_mismatch")

    target = _parse_date(raw.get("target_nav_date")) if raw.get("target_nav_date") is not None else None
    base_date = _parse_date(raw.get("base_nav_date"))
    if target is not None and (
        base_date is None or target <= base_date or target > stamp.astimezone(BEIJING).date()
    ):
        return _unavailable_context(raw, "target_nav_date_invalid")

    precision = raw.get("source_time_precision")
    if precision == "datetime" and raw.get("source_time") is not None:
        source_time = _parse_datetime(raw.get("source_time"))
        if source_time is None or source_time > stamp + MAX_FUTURE_SKEW:
            return _unavailable_context(raw, "source_time_invalid")
        if kind in {"estimate", "holdings_model"} and stamp - source_time > MAX_LIVE_QUOTE_AGE:
            return _unavailable_context(raw, "source_time_stale")
    elif precision == "date" and raw.get("source_time") is not None:
        source_date = _parse_date(raw.get("source_time"))
        if source_date is None or source_date > stamp.astimezone(BEIJING).date():
            return _unavailable_context(raw, "source_date_invalid")

    for field in (
        "fetched_at", "calculated_at", "market_time",
        "model_oldest_quote_time", "model_newest_quote_time",
    ):
        if raw.get(field) is None:
            continue
        value = _parse_datetime(raw.get(field))
        if value is None or value > stamp + MAX_FUTURE_SKEW:
            return _unavailable_context(raw, f"{field}_invalid")
    return raw


def _holding_from_item(item: V8DecisionItem, created_at: datetime) -> HoldingVersion:
    value = item.holding
    return build_holding_version(
        item.code,
        is_held=value.is_held,
        shares=value.shares,
        cost=value.cost,
        market_value=value.market_value,
        account=value.account,
        current_weight=value.current_weight,
        target_weight=value.target_weight,
        updated_at=value.updated_at,
        source=value.source,
        created_at=created_at,
    )


def create_evidence(
    detail: dict,
    *,
    estimate_context: dict | None = None,
    created_at: datetime | None = None,
):
    stamp = (created_at or _now()).astimezone(timezone.utc)
    context = _validated_estimate_context(
        detail,
        estimate_context if estimate_context is not None else detail.get("decision_context"),
        stamp,
    )
    decision_detail = {**detail, "decision_context": context}
    fund_text = f"{detail.get('type') or ''} {detail.get('name') or ''}".upper()
    if any(marker in fund_text for marker in ("QDII", "海外", "全球", "纳斯达克", "标普")):
        model_evidence = overseas_evidence.resolve_for_detail(detail, stamp)
        if model_evidence is not None:
            decision_detail["overseas_evidence"] = model_evidence
    score = score_fund(decision_detail)
    signal = timing_signal(decision_detail)
    outcome_summary = v8_repo.historical_outcome_summary(
        str(detail.get("code") or ""),
        STRATEGY_VERSION,
        at=stamp,
        horizon=HISTORICAL_OUTCOME_HORIZON,
    )
    candidate = build_evidence_snapshot(
        decision_detail,
        score,
        signal,
        {},
        historical_outcome_summary=outcome_summary,
        created_at=stamp,
    )
    return v8_repo.save_evidence(candidate)


def create_decision(
    detail: dict,
    item: V8DecisionItem,
    *,
    policy: PortfolioPolicy,
    estimate_context: dict | None = None,
    created_at: datetime | None = None,
) -> dict:
    stamp = (created_at or _now()).astimezone(timezone.utc)
    evidence = create_evidence(detail, estimate_context=estimate_context, created_at=stamp)
    holding = v8_repo.save_holding(_holding_from_item(item, stamp))
    decision = build_decision_snapshot(
        evidence,
        holding,
        policy,
        strategy_version=STRATEGY_VERSION,
        created_at=stamp,
    )
    decision = v8_repo.save_decision(decision)
    diff = v8_repo.diff_for_decision(decision)
    return {
        "code": evidence.fund_code,
        "name": evidence.fund_name,
        "type": evidence.fund_type,
        "action": decision.action,
        "action_label": ACTION_ZH[decision.action],
        "strength": decision.strength,
        "confidence": decision.confidence,
        "summary": decision.summary,
        "decision": decision.model_dump(mode="json"),
        "evidence": evidence.model_dump(mode="json"),
        "holding": holding.model_dump(mode="json"),
        "policy": policy.model_dump(mode="json"),
        "diff": diff.model_dump(mode="json"),
    }


def _effective_target(item: V8DecisionItem, policy: PortfolioPolicy, fund_type: str) -> float | None:
    if item.holding.target_weight is not None:
        return item.holding.target_weight
    if item.code in policy.target_allocations:
        return policy.target_allocations[item.code]
    if fund_type in policy.target_allocations:
        return policy.target_allocations[fund_type]
    return None


def _portfolio_summary(
    request: V8DecisionBatchRequest,
    decisions: list[dict],
    policy: PortfolioPolicy,
    errors: list[dict],
) -> tuple[dict, list[dict]]:
    by_code = {row["code"]: row for row in decisions}
    current_values: list[float] = []
    target_values: list[float] = []
    missing_current: list[str] = []
    missing_target: list[str] = []
    theme_weights: dict[str, float] = {}
    theme_incomplete: list[str] = []
    rebalance = []
    for item in request.items:
        row = by_code.get(item.code)
        if row is None:
            continue
        holding = item.holding
        current = 0.0 if not holding.is_held else holding.current_weight
        target = _effective_target(item, policy, row["type"])
        if current is None:
            missing_current.append(item.code)
        else:
            current_values.append(current)
            if item.theme:
                theme_weights[item.theme] = theme_weights.get(item.theme, 0.0) + current
            elif policy.max_theme_weight is not None and current > 0:
                theme_incomplete.append(item.code)
        if target is None:
            missing_target.append(item.code)
        else:
            target_values.append(target)
        guidance = row["decision"].get("position_guidance") or {}
        change = guidance.get("suggested_change")
        amount = None
        if change is not None and request.portfolio_value is not None:
            amount = round(request.portfolio_value * abs(float(change)) / 100, 2)
        rebalance.append({
            "code": item.code,
            "name": row.get("name"),
            "action": row["action"],
            "theme": item.theme,
            "current_weight": current,
            "target_weight": target,
            "suggested_change": change,
            "suggested_range": guidance.get("suggested_range"),
            "amount": amount,
            "precise": bool(guidance.get("precise")),
        })
    warnings = []
    if errors:
        warnings.append("部分基金数据不可用，组合汇总已停止伪精确计算")
    if missing_current:
        warnings.append(f"持仓权重缺失：{','.join(missing_current)}")
    if missing_target:
        warnings.append(f"目标权重缺失：{','.join(missing_target)}")
    if theme_incomplete:
        warnings.append(f"主题分类缺失，无法完整执行主题上限：{','.join(theme_incomplete)}")
    theme_overweights = []
    if policy.max_theme_weight is not None:
        theme_overweights = [
            {"theme": theme, "current_weight": round(weight, 2), "limit": policy.max_theme_weight}
            for theme, weight in sorted(theme_weights.items())
            if weight > policy.max_theme_weight + 1e-9
        ]
        for item in theme_overweights:
            warnings.append(
                f"主题 {item['theme']} 当前权重 {item['current_weight']}% 超过政策上限 {item['limit']}%"
            )
    complete = not errors and not missing_current and not missing_target and len(decisions) == len(request.items)
    current_total = round(sum(current_values), 2) if complete else None
    target_total = round(sum(target_values), 2) if complete else None
    if complete and current_total is not None and current_total > 100 + 1e-9:
        warnings.append("当前权重合计超过 100%，请核对持仓")
    if complete and target_total is not None and target_total > 100 + 1e-9:
        warnings.append("目标权重合计超过 100%，系统不会自动归一")
    allocation = {
        "complete": complete,
        "current_total": current_total,
        "target_total": target_total,
        "target_cash": round(100 - target_total, 2) if complete and target_total is not None and target_total <= 100 else None,
        "status": "complete" if complete and not warnings else "needs_input" if not complete else "needs_review",
        "missing_current_weights": missing_current,
        "missing_target_weights": missing_target,
        "warnings": warnings,
        "theme_weights": {key: round(value, 2) for key, value in sorted(theme_weights.items())},
        "theme_overweights": theme_overweights,
        "theme_check_complete": not theme_incomplete,
    }
    return allocation, rebalance


def create_batch_decisions(
    request: V8DecisionBatchRequest,
    *,
    estimate_resolver: Callable[[dict], dict],
) -> dict:
    endpoint = "v2_portfolio_decisions"
    request_payload = request.model_dump(mode="json")
    if request.request_id:
        claim = v8_repo.claim_idempotency(request.request_id, endpoint, request_payload)
        if claim["state"] == "conflict":
            raise IdempotencyConflictError("request_id 已用于不同请求")
        if claim["state"] == "in_progress":
            raise IdempotencyInProgressError("相同 request_id 正在处理")
        if claim["state"] == "complete":
            return {**claim["response"], "duplicate": True}
    try:
        policy = v8_repo.get_policy(request.policy_version)
        stamp = _now()
        decisions = []
        errors = []
        for item in request.items:
            try:
                detail = repo.get_detail(item.code)
                context = (
                    item.estimate_context.model_dump(mode="python")
                    if item.estimate_context is not None
                    else estimate_resolver(detail)
                )
                decisions.append(create_decision(
                    detail,
                    item,
                    policy=policy,
                    estimate_context=context,
                    created_at=stamp,
                ))
            except Exception as error:
                errors.append({"code": item.code, "error": type(error).__name__})
        allocation, rebalance = _portfolio_summary(request, decisions, policy, errors)
        result = {
            "decisions": decisions,
            "errors": errors,
            "total": len(decisions),
            "requested": len(request.items),
            "complete": allocation["complete"],
            "allocation": allocation,
            "rebalance": rebalance,
            "policy_version": policy.policy_version,
            "strategy_version": STRATEGY_VERSION,
            "request_id": request.request_id,
            "duplicate": False,
        }
        if request.request_id:
            v8_repo.complete_idempotency(request.request_id, endpoint, result)
        return result
    except Exception:
        if request.request_id:
            v8_repo.release_idempotency(request.request_id, endpoint)
        raise
