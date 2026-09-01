"""Persistence and evaluation services for immutable v8 snapshots."""
from __future__ import annotations

import json
import math
import secrets
import statistics
from collections import Counter
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from database import db
from models.v8 import (
    DecisionDiff,
    DecisionSnapshot,
    EvidenceSnapshot,
    HoldingVersion,
    NotificationEvent,
    OutcomeEvaluation,
    PortfolioDecisionComponent,
    PortfolioDecisionSnapshot,
    PortfolioOutcomeComponent,
    PortfolioOutcomeEvaluation,
    PortfolioPolicy,
    canonical_json,
    payload_sha256,
    stable_id,
)
from strategy.decision_v2 import build_decision_diff, default_portfolio_policy


POSITIVE_ACTIONS = {"buy", "dca", "add"}
DEFENSIVE_ACTIONS = {"reduce", "sell"}
HORIZONS = (5, 20, 60)
IDEMPOTENCY_LEASE_SECONDS = 300
BEIJING = timezone(timedelta(hours=8))


_idempotency_owners: ContextVar[dict[tuple[str, str], str]] = ContextVar(
    "v8_idempotency_owners", default={},
)


class SnapshotConflictError(RuntimeError):
    """A deterministic identifier was reused for different immutable data."""


@dataclass(frozen=True)
class NotificationRecordResult:
    """Result of an append-only notification event write.

    ``claimed`` is true only for the worker that atomically inserted a new
    ``attempted`` event.  ``duplicate`` identifies an exact replay and lets the
    API suppress transport before it can send the same event twice.
    """

    event: NotificationEvent
    claimed: bool
    duplicate: bool


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _market_date(stamp: datetime | None = None) -> date:
    current = stamp or _now()
    if current.tzinfo is None:
        raise ValueError("market clock must include a timezone")
    return current.astimezone(BEIJING).date()


def _json(value: Any) -> str:
    return canonical_json(value)


def _model_payload(model: Any) -> dict:
    return model.model_dump(mode="python")


def _without(payload: dict, *keys: str) -> dict:
    return {key: value for key, value in payload.items() if key not in keys}


def _close(left: float, right: float, *, tolerance: float = 1e-9) -> bool:
    return abs(float(left) - float(right)) <= tolerance


def _evidence_identity(snapshot: EvidenceSnapshot) -> dict:
    return _without(_model_payload(snapshot), "evidence_id", "created_at")


def _holding_identity(version: HoldingVersion) -> dict:
    return _without(_model_payload(version), "holding_version", "created_at")


def _policy_identity(policy: PortfolioPolicy) -> dict:
    return _without(_model_payload(policy), "policy_version", "created_at")


def _decision_identity(snapshot: DecisionSnapshot) -> dict:
    return {
        "fund_code": snapshot.fund_code,
        "evidence_id": snapshot.evidence_id,
        "holding_version": snapshot.holding_version,
        "policy_version": snapshot.policy_version,
        "strategy_version": snapshot.strategy_version,
    }


def _portfolio_decision_identity(snapshot: PortfolioDecisionSnapshot) -> dict:
    return _without(
        _model_payload(snapshot),
        "portfolio_decision_id",
        "created_at",
    )


def _assert_id(actual: str, expected: str, kind: str) -> None:
    if actual != expected:
        raise SnapshotConflictError(f"{kind} deterministic id does not match payload")


def _existing_model(conn, table: str, id_column: str, identifier: str, model_type):
    row = conn.execute(
        f"SELECT payload_json FROM {table} WHERE {id_column}=?",
        (identifier,),
    ).fetchone()
    return model_type.model_validate_json(row["payload_json"]) if row else None


def save_evidence(snapshot: EvidenceSnapshot) -> EvidenceSnapshot:
    identity = _evidence_identity(snapshot)
    _assert_id(snapshot.evidence_id, stable_id("ev", identity), "evidence")
    payload = _model_payload(snapshot)
    semantic_sha = payload_sha256(identity)
    with db.transaction(immediate=True) as conn:
        existing = _existing_model(conn, "evidence_snapshots", "evidence_id", snapshot.evidence_id, EvidenceSnapshot)
        if existing is not None:
            if payload_sha256(_evidence_identity(existing)) != semantic_sha:
                raise SnapshotConflictError("stored evidence id has different content")
            return existing
        conn.execute(
            """INSERT INTO evidence_snapshots(
               evidence_id,fund_code,fund_name,fund_type,created_at,market_time,
               official_nav,official_nav_date,target_nav_date,benchmark_id,
               valuation_percentile,trend_state,momentum_state,drawdown,volatility,
               market_temperature,score,score_version,score_coverage,timing_signal,
               timing_coverage,estimate,estimate_status,estimate_coverage,
               estimate_model_version,estimate_error_p80,estimate_sample_count,
               estimate_mae,estimate_direction_accuracy,evidence_strength,
               source_states_json,evidence_nodes_json,missing_fields_json,
               stale_fields_json,risk_flags_json,payload_json,payload_sha256
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                snapshot.evidence_id, snapshot.fund_code, snapshot.fund_name, snapshot.fund_type,
                snapshot.created_at.isoformat(), snapshot.market_time.isoformat() if snapshot.market_time else None,
                snapshot.official_nav, snapshot.official_nav_date.isoformat() if snapshot.official_nav_date else None,
                snapshot.target_nav_date.isoformat() if snapshot.target_nav_date else None, snapshot.benchmark_id,
                snapshot.valuation_percentile, snapshot.trend_state, snapshot.momentum_state,
                snapshot.drawdown, snapshot.volatility, snapshot.market_temperature,
                snapshot.score, snapshot.score_version, snapshot.score_coverage,
                snapshot.timing_signal, snapshot.timing_coverage, snapshot.estimate,
                snapshot.estimate_status, snapshot.estimate_coverage, snapshot.estimate_model_version,
                snapshot.estimate_error_p80, snapshot.estimate_sample_count, snapshot.estimate_mae,
                snapshot.estimate_direction_accuracy, snapshot.evidence_strength,
                _json(snapshot.source_states), _json(snapshot.evidence_nodes),
                _json(snapshot.missing_fields), _json(snapshot.stale_fields), _json(snapshot.risk_flags),
                _json(payload), semantic_sha,
            ),
        )
        for state in snapshot.source_states:
            state_payload = state.model_dump(mode="python")
            event_identity = {
                "evidence_id": snapshot.evidence_id,
                "source_id": state.source_id,
                "state": state_payload,
            }
            conn.execute(
                """INSERT INTO source_health_events(
                   event_id,evidence_id,source_id,state,last_success,last_failure,
                   latency_ms,data_age_seconds,stale,error_class,observed_at,payload_json
                 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    stable_id("src", event_identity), snapshot.evidence_id, state.source_id, state.state,
                    state.last_success.isoformat() if state.last_success else None,
                    state.last_failure.isoformat() if state.last_failure else None,
                    state.latency_ms, state.data_age_seconds, int(state.stale), state.error_class,
                    snapshot.created_at.isoformat(), _json(state_payload),
                ),
            )
    return snapshot


def get_evidence(evidence_id: str) -> EvidenceSnapshot | None:
    conn = db.get_conn()
    try:
        return _existing_model(conn, "evidence_snapshots", "evidence_id", evidence_id, EvidenceSnapshot)
    finally:
        conn.close()


def latest_evidence(fund_code: str, *, at: datetime | None = None) -> EvidenceSnapshot | None:
    """Return the latest persisted evidence without fetching or writing data."""
    if at is not None and at.tzinfo is None:
        raise ValueError("evidence lookup time must include a timezone")
    conn = db.get_conn()
    try:
        if at is None:
            row = conn.execute(
                """SELECT payload_json FROM evidence_snapshots
                   WHERE fund_code=? ORDER BY created_at DESC,rowid DESC LIMIT 1""",
                (fund_code,),
            ).fetchone()
        else:
            row = conn.execute(
                """SELECT payload_json FROM evidence_snapshots
                   WHERE fund_code=? AND created_at<=?
                   ORDER BY created_at DESC,rowid DESC LIMIT 1""",
                (fund_code, at.isoformat()),
            ).fetchone()
        return EvidenceSnapshot.model_validate_json(row["payload_json"]) if row else None
    finally:
        conn.close()


def save_holding(version: HoldingVersion) -> HoldingVersion:
    identity = _holding_identity(version)
    _assert_id(version.holding_version, stable_id("hold", identity), "holding")
    semantic_sha = payload_sha256(identity)
    payload = _model_payload(version)
    with db.transaction(immediate=True) as conn:
        existing = _existing_model(conn, "holding_versions", "holding_version", version.holding_version, HoldingVersion)
        if existing is not None:
            if payload_sha256(_holding_identity(existing)) != semantic_sha:
                raise SnapshotConflictError("stored holding id has different content")
            return existing
        conn.execute(
            """INSERT INTO holding_versions(
               holding_version,fund_code,user_state,shares,cost,market_value,account,
               current_weight,target_weight,updated_at,source,created_at,payload_json,payload_sha256
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                version.holding_version, version.fund_code, version.user_state, version.shares,
                version.cost, version.market_value, version.account, version.current_weight,
                version.target_weight, version.updated_at.isoformat() if version.updated_at else None,
                version.source, version.created_at.isoformat(), _json(payload), semantic_sha,
            ),
        )
    return version


def get_holding(holding_version: str | None) -> HoldingVersion | None:
    if not holding_version:
        return None
    conn = db.get_conn()
    try:
        return _existing_model(conn, "holding_versions", "holding_version", holding_version, HoldingVersion)
    finally:
        conn.close()


def save_policy(policy: PortfolioPolicy) -> PortfolioPolicy:
    identity = _policy_identity(policy)
    _assert_id(policy.policy_version, stable_id("pol", identity), "policy")
    semantic_sha = payload_sha256(identity)
    payload = _model_payload(policy)
    with db.transaction(immediate=True) as conn:
        existing = _existing_model(conn, "portfolio_policy_versions", "policy_version", policy.policy_version, PortfolioPolicy)
        if existing is not None:
            if payload_sha256(_policy_identity(existing)) != semantic_sha:
                raise SnapshotConflictError("stored policy id has different content")
            return existing
        rows = conn.execute(
            """SELECT p.payload_json
               FROM portfolio_policy_versions p
               LEFT JOIN portfolio_policy_versions child
                 ON child.supersedes=p.policy_version
               WHERE child.policy_version IS NULL"""
        ).fetchall()
        if not rows:
            if policy.supersedes is not None:
                raise ValueError("the first policy cannot supersede another version")
        else:
            if len(rows) != 1:
                raise SnapshotConflictError("stored policy history contains multiple chain tips")
            tip = PortfolioPolicy.model_validate_json(rows[0]["payload_json"])
            if policy.supersedes != tip.policy_version:
                raise ValueError("new policy must supersede the current chain tip")
            if policy.effective_at <= tip.effective_at:
                raise ValueError("new policy effective_at must be after the superseded policy")
            if policy.created_at < tip.created_at:
                raise ValueError("new policy cannot be backfilled before its predecessor")
        conn.execute(
            """INSERT INTO portfolio_policy_versions(
               policy_version,name,target_allocations_json,target_ranges_json,
               max_single_fund_weight,max_theme_weight,rebalance_band,dca_rules_json,
               reduce_rules_json,sell_rules_json,effective_at,created_at,source,
               supersedes,payload_json,payload_sha256
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                policy.policy_version, policy.name, _json(policy.target_allocations), _json(policy.target_ranges),
                policy.max_single_fund_weight, policy.max_theme_weight, policy.rebalance_band,
                _json(policy.dca_rules), _json(policy.reduce_rules), _json(policy.sell_rules),
                policy.effective_at.isoformat(), policy.created_at.isoformat(), policy.source,
                policy.supersedes, _json(payload), semantic_sha,
            ),
        )
    return policy


def ensure_default_policy(created_at: datetime | None = None) -> PortfolioPolicy:
    return save_policy(default_portfolio_policy(created_at))


def get_policy(policy_version: str | None = None, *, at: datetime | None = None) -> PortfolioPolicy:
    ensure_default_policy()
    return read_policy(policy_version, at=at)


def read_policy(policy_version: str | None = None, *, at: datetime | None = None) -> PortfolioPolicy:
    """Read an effective policy without creating the default policy row."""
    current = at or _now()
    if current.tzinfo is None:
        raise ValueError("policy lookup time must include a timezone")
    current = current.astimezone(timezone.utc)
    if policy_version:
        conn = db.get_conn()
        try:
            policy = _existing_model(
                conn, "portfolio_policy_versions", "policy_version", policy_version, PortfolioPolicy,
            )
        finally:
            conn.close()
        if policy is None:
            raise LookupError("policy version not found")
        if policy.effective_at.astimezone(timezone.utc) > current:
            raise LookupError("policy version is not effective at the requested time")
        return policy
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT payload_json FROM portfolio_policy_versions ORDER BY effective_at DESC, created_at DESC"
        ).fetchall()
    finally:
        conn.close()
    policies = [PortfolioPolicy.model_validate_json(row["payload_json"]) for row in rows]
    active = next((policy for policy in policies if policy.effective_at <= current), None)
    if active is None:
        raise LookupError("no effective policy version")
    return active


def policy_history() -> list[PortfolioPolicy]:
    ensure_default_policy()
    return read_policy_history()


def read_policy_history() -> list[PortfolioPolicy]:
    """Read policy history without performing startup-style initialization."""
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT payload_json FROM portfolio_policy_versions ORDER BY effective_at DESC, created_at DESC"
        ).fetchall()
        return [PortfolioPolicy.model_validate_json(row["payload_json"]) for row in rows]
    finally:
        conn.close()


def save_decision(snapshot: DecisionSnapshot) -> DecisionSnapshot:
    _assert_id(snapshot.decision_id, stable_id("dec", _decision_identity(snapshot)), "decision")
    payload = _model_payload(snapshot)
    semantic = _without(payload, "created_at")
    semantic_sha = payload_sha256(semantic)
    with db.transaction(immediate=True) as conn:
        evidence = _existing_model(
            conn, "evidence_snapshots", "evidence_id", snapshot.evidence_id, EvidenceSnapshot,
        )
        holding = _existing_model(
            conn, "holding_versions", "holding_version", snapshot.holding_version, HoldingVersion,
        )
        policy = _existing_model(
            conn, "portfolio_policy_versions", "policy_version", snapshot.policy_version, PortfolioPolicy,
        )
        if evidence is None:
            raise LookupError("decision evidence does not exist")
        if holding is None:
            raise LookupError("decision holding version does not exist")
        if policy is None:
            raise LookupError("decision policy version does not exist")
        if evidence.fund_code != snapshot.fund_code or holding.fund_code != snapshot.fund_code:
            raise ValueError("decision, evidence, and holding fund codes must match")
        if holding.user_state != snapshot.user_state:
            raise ValueError("decision user_state must match its holding version")
        if evidence.created_at > snapshot.created_at:
            raise ValueError("decision cannot reference future evidence")
        if evidence.market_time is not None and evidence.market_time > snapshot.created_at:
            raise ValueError("decision cannot reference a future market timestamp")
        if holding.created_at > snapshot.created_at or (
            holding.updated_at is not None and holding.updated_at > snapshot.created_at
        ):
            raise ValueError("decision cannot reference a future holding state")
        if policy.created_at > snapshot.created_at or policy.effective_at > snapshot.created_at:
            raise ValueError("decision cannot reference a future policy")
        existing = _existing_model(conn, "decision_snapshots", "decision_id", snapshot.decision_id, DecisionSnapshot)
        if existing is not None:
            if payload_sha256(_without(_model_payload(existing), "created_at")) != semantic_sha:
                raise SnapshotConflictError("stored decision id has different output")
            return existing
        conn.execute(
            """INSERT INTO decision_snapshots(
               decision_id,evidence_id,fund_code,holding_version,policy_version,
               strategy_version,user_state,action,strength,confidence,summary,
               reason_codes_json,reasons_json,risks_json,invalidation_codes_json,
               invalidation_json,position_guidance_json,evidence_nodes_json,
               created_at,payload_json,payload_sha256
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                snapshot.decision_id, snapshot.evidence_id, snapshot.fund_code,
                snapshot.holding_version, snapshot.policy_version, snapshot.strategy_version,
                snapshot.user_state, snapshot.action, snapshot.strength, snapshot.confidence,
                snapshot.summary, _json(snapshot.reason_codes), _json(snapshot.reasons),
                _json(snapshot.risks), _json(snapshot.invalidation_codes),
                _json(snapshot.invalidation_conditions),
                _json(snapshot.position_guidance) if snapshot.position_guidance else None,
                _json(snapshot.evidence_nodes), snapshot.created_at.isoformat(),
                _json(payload), semantic_sha,
            ),
        )
    return snapshot


def get_decision(decision_id: str) -> DecisionSnapshot | None:
    conn = db.get_conn()
    try:
        return _existing_model(conn, "decision_snapshots", "decision_id", decision_id, DecisionSnapshot)
    finally:
        conn.close()


def latest_decision(
    fund_code: str,
    *,
    exclude: str | None = None,
    at: datetime | None = None,
) -> DecisionSnapshot | None:
    """Return the latest persisted decision without generating a replacement."""
    if at is not None and at.tzinfo is None:
        raise ValueError("decision lookup time must include a timezone")
    conn = db.get_conn()
    try:
        clauses = ["fund_code=?"]
        params: list[Any] = [fund_code]
        if exclude:
            clauses.append("decision_id<>?")
            params.append(exclude)
        if at is not None:
            clauses.append("created_at<=?")
            params.append(at.isoformat())
        row = conn.execute(
            f"""SELECT payload_json FROM decision_snapshots
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at DESC,rowid DESC LIMIT 1""",
            params,
        ).fetchone()
        return DecisionSnapshot.model_validate_json(row["payload_json"]) if row else None
    finally:
        conn.close()


def decision_history(fund_code: str, limit: int = 50) -> list[DecisionSnapshot]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT payload_json FROM decision_snapshots WHERE fund_code=?
               ORDER BY created_at DESC, rowid DESC LIMIT ?""",
            (fund_code, max(1, min(200, int(limit)))),
        ).fetchall()
        return [DecisionSnapshot.model_validate_json(row["payload_json"]) for row in rows]
    finally:
        conn.close()


def diff_for_decision(decision: DecisionSnapshot) -> DecisionDiff:
    evidence = get_evidence(decision.evidence_id)
    if evidence is None:
        raise LookupError("decision evidence is missing")
    conn = db.get_conn()
    try:
        current = conn.execute(
            "SELECT rowid,created_at FROM decision_snapshots WHERE decision_id=?",
            (decision.decision_id,),
        ).fetchone()
        if current is None:
            raise LookupError("decision is not persisted")
        row = conn.execute(
            """SELECT payload_json FROM decision_snapshots
               WHERE fund_code=? AND decision_id<>?
                 AND (created_at<? OR (created_at=? AND rowid<?))
               ORDER BY created_at DESC,rowid DESC LIMIT 1""",
            (
                decision.fund_code,
                decision.decision_id,
                current["created_at"],
                current["created_at"],
                current["rowid"],
            ),
        ).fetchone()
        previous = DecisionSnapshot.model_validate_json(row["payload_json"]) if row else None
    finally:
        conn.close()
    previous_evidence = get_evidence(previous.evidence_id) if previous else None
    return build_decision_diff(
        decision,
        evidence,
        previous,
        previous_evidence,
        get_holding(decision.holding_version),
        get_holding(previous.holding_version) if previous else None,
    )


def latest_decision_diff(fund_code: str) -> DecisionDiff | None:
    """Return a diff for the latest stored decision; never creates snapshots."""
    decision = latest_decision(fund_code)
    return diff_for_decision(decision) if decision is not None else None


def latest_decision_bundle(fund_code: str) -> dict | None:
    """Assemble the latest immutable decision chain using reads only."""
    decision = latest_decision(fund_code)
    if decision is None:
        return None
    evidence = get_evidence(decision.evidence_id)
    holding = get_holding(decision.holding_version)
    try:
        policy = read_policy(decision.policy_version)
    except LookupError as error:
        raise SnapshotConflictError("decision policy is missing") from error
    if evidence is None or holding is None:
        raise SnapshotConflictError("decision evidence or holding is missing")
    return {
        "decision": decision,
        "evidence": evidence,
        "holding": holding,
        "policy": policy,
        "diff": diff_for_decision(decision),
    }


def build_portfolio_decision_snapshot(
    request_items: Iterable[dict[str, Any]],
    result: dict[str, Any],
    *,
    portfolio_value: float | None = None,
    source: str = "v2_portfolio_decisions",
) -> PortfolioDecisionSnapshot:
    """Build a complete portfolio snapshot without dropping or normalizing funds."""
    items = list(request_items)
    decisions = list(result.get("decisions") or [])
    rebalance = list(result.get("rebalance") or [])
    if (
        not result.get("complete")
        or result.get("errors")
        or not items
        or len(items) != len(decisions)
        or len(items) != len(rebalance)
    ):
        raise ValueError("portfolio snapshot requires every requested component")
    requested_codes = [str(item.get("code") or "") for item in items]
    if len(requested_codes) != len(set(requested_codes)):
        raise ValueError("portfolio snapshot fund codes must be unique")
    by_decision = {str(row.get("code") or ""): row for row in decisions}
    by_rebalance = {str(row.get("code") or ""): row for row in rebalance}
    if set(requested_codes) != set(by_decision) or set(requested_codes) != set(by_rebalance):
        raise ValueError("portfolio snapshot component sets do not match the request")

    components: list[PortfolioDecisionComponent] = []
    decision_times: list[datetime] = []
    for item in items:
        code = str(item["code"])
        row = by_decision[code]
        allocation = by_rebalance[code]
        decision_payload = row.get("decision") or {}
        evidence_payload = row.get("evidence") or {}
        holding_payload = row.get("holding") or {}
        current_weight = allocation.get("current_weight")
        target_weight = allocation.get("target_weight")
        if current_weight is None or target_weight is None:
            raise ValueError(f"portfolio component {code} has an unknown weight")
        if isinstance(current_weight, bool) or isinstance(target_weight, bool):
            raise ValueError(f"portfolio component {code} has an invalid weight")
        current = float(current_weight)
        target = float(target_weight)
        if not math.isfinite(current) or not math.isfinite(target):
            raise ValueError(f"portfolio component {code} has a non-finite weight")
        created_at = datetime.fromisoformat(str(decision_payload.get("created_at") or ""))
        if created_at.tzinfo is None:
            raise ValueError("portfolio component decision time must include a timezone")
        decision_times.append(created_at)
        theme = item.get("theme")
        if theme != allocation.get("theme"):
            raise ValueError(f"portfolio component {code} theme changed during evaluation")
        components.append(PortfolioDecisionComponent(
            fund_code=code,
            fund_name=row.get("name"),
            decision_id=str(decision_payload.get("decision_id") or ""),
            evidence_id=str(evidence_payload.get("evidence_id") or ""),
            holding_version=str(holding_payload.get("holding_version") or ""),
            action=str(row.get("action") or ""),
            theme=theme,
            current_weight=current,
            target_weight=target,
        ))

    current_total = sum(item.current_weight for item in components)
    target_total = sum(item.target_weight for item in components)
    if current_total > 100 + 1e-9 or target_total > 100 + 1e-9:
        raise ValueError("portfolio fund weights cannot exceed 100%; weights are not normalized")
    if portfolio_value is not None and (
        isinstance(portfolio_value, bool)
        or not math.isfinite(float(portfolio_value))
        or float(portfolio_value) < 0
    ):
        raise ValueError("portfolio value must be a finite non-negative number")
    created_at = max(decision_times)
    semantic = {
        "schema_version": "v8-portfolio-decision-1",
        "decision_date": max(_market_date(value) for value in decision_times),
        "policy_version": str(result.get("policy_version") or ""),
        "strategy_version": str(result.get("strategy_version") or ""),
        "components": sorted(components, key=lambda value: value.fund_code),
        "current_cash_weight": round(100 - current_total, 8),
        "target_cash_weight": round(100 - target_total, 8),
        "portfolio_value": float(portfolio_value) if portfolio_value is not None else None,
        "source": source,
    }
    return PortfolioDecisionSnapshot(
        portfolio_decision_id=stable_id("pdec", semantic),
        created_at=created_at,
        **semantic,
    )


def save_portfolio_decision(
    snapshot: PortfolioDecisionSnapshot,
) -> PortfolioDecisionSnapshot:
    identity = _portfolio_decision_identity(snapshot)
    _assert_id(
        snapshot.portfolio_decision_id,
        stable_id("pdec", identity),
        "portfolio decision",
    )
    payload = _model_payload(snapshot)
    semantic_sha = payload_sha256(identity)
    with db.transaction(immediate=True) as conn:
        policy = _existing_model(
            conn,
            "portfolio_policy_versions",
            "policy_version",
            snapshot.policy_version,
            PortfolioPolicy,
        )
        if policy is None:
            raise LookupError("portfolio decision policy does not exist")
        component_decision_dates: list[date] = []
        for component in snapshot.components:
            decision = _existing_model(
                conn,
                "decision_snapshots",
                "decision_id",
                component.decision_id,
                DecisionSnapshot,
            )
            if decision is None:
                raise LookupError(f"portfolio component decision does not exist: {component.fund_code}")
            if (
                decision.fund_code != component.fund_code
                or decision.evidence_id != component.evidence_id
                or decision.holding_version != component.holding_version
                or decision.policy_version != snapshot.policy_version
                or decision.strategy_version != snapshot.strategy_version
                or decision.action != component.action
            ):
                raise ValueError("portfolio component does not match its immutable decision")
            if decision.created_at > snapshot.created_at:
                raise ValueError("portfolio snapshot cannot predate a component decision")
            component_decision_dates.append(_market_date(decision.created_at))
            guidance = decision.position_guidance
            if (
                guidance is None
                or guidance.target_weight is None
                or not _close(component.target_weight, guidance.target_weight)
            ):
                raise ValueError("portfolio target weight does not match decision guidance")
            holding = _existing_model(
                conn,
                "holding_versions",
                "holding_version",
                component.holding_version,
                HoldingVersion,
            )
            if holding is None:
                raise LookupError("portfolio component holding version does not exist")
            expected_current = 0.0 if holding.user_state == "unheld" else holding.current_weight
            if expected_current is None or not _close(component.current_weight, expected_current):
                raise ValueError("portfolio current weight does not match its holding version")
        if snapshot.decision_date != max(component_decision_dates):
            raise ValueError("portfolio decision date must match its latest component decision")
        existing = _existing_model(
            conn,
            "portfolio_decision_snapshots",
            "portfolio_decision_id",
            snapshot.portfolio_decision_id,
            PortfolioDecisionSnapshot,
        )
        if existing is not None:
            if payload_sha256(_portfolio_decision_identity(existing)) != semantic_sha:
                raise SnapshotConflictError("stored portfolio decision id has different content")
            return existing
        conn.execute(
            """INSERT INTO portfolio_decision_snapshots(
               portfolio_decision_id,decision_date,policy_version,strategy_version,
               component_count,current_cash_weight,target_cash_weight,portfolio_value,
               components_json,source,created_at,payload_json,payload_sha256
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                snapshot.portfolio_decision_id,
                snapshot.decision_date.isoformat(),
                snapshot.policy_version,
                snapshot.strategy_version,
                len(snapshot.components),
                snapshot.current_cash_weight,
                snapshot.target_cash_weight,
                snapshot.portfolio_value,
                _json(snapshot.components),
                snapshot.source,
                snapshot.created_at.isoformat(),
                _json(payload),
                semantic_sha,
            ),
        )
    return snapshot


def get_portfolio_decision(
    portfolio_decision_id: str,
) -> PortfolioDecisionSnapshot | None:
    conn = db.get_conn()
    try:
        return _existing_model(
            conn,
            "portfolio_decision_snapshots",
            "portfolio_decision_id",
            portfolio_decision_id,
            PortfolioDecisionSnapshot,
        )
    finally:
        conn.close()


def portfolio_decision_snapshots(limit: int = 100) -> list[PortfolioDecisionSnapshot]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT payload_json FROM portfolio_decision_snapshots
               ORDER BY julianday(created_at) DESC,rowid DESC LIMIT ?""",
            (max(1, min(10_000, int(limit))),),
        ).fetchall()
        return [PortfolioDecisionSnapshot.model_validate_json(row["payload_json"]) for row in rows]
    finally:
        conn.close()


def _remember_idempotency_owner(request_id: str, endpoint: str, owner_token: str) -> None:
    owners = dict(_idempotency_owners.get())
    owners[(request_id, endpoint)] = owner_token
    _idempotency_owners.set(owners)


def _idempotency_owner(
    request_id: str,
    endpoint: str,
    owner_token: str | None,
) -> str | None:
    return owner_token or _idempotency_owners.get().get((request_id, endpoint))


def _forget_idempotency_owner(request_id: str, endpoint: str) -> None:
    owners = dict(_idempotency_owners.get())
    owners.pop((request_id, endpoint), None)
    _idempotency_owners.set(owners)


def claim_idempotency(
    request_id: str,
    endpoint: str,
    request_payload: Any,
    *,
    lease_seconds: int = IDEMPOTENCY_LEASE_SECONDS,
) -> dict:
    """Atomically claim a request, reclaiming abandoned work after its lease.

    The returned owner token can be passed explicitly to completion/release.
    Existing in-process callers remain safe because the token is also retained
    in the current execution context.
    """
    if isinstance(lease_seconds, bool) or not 1 <= int(lease_seconds) <= 3600:
        raise ValueError("idempotency lease_seconds must be in [1, 3600]")
    request_sha = payload_sha256(request_payload)
    now_at = _now()
    now = now_at.isoformat()
    lease_expires_at = (now_at + timedelta(seconds=int(lease_seconds))).isoformat()
    owner_token = secrets.token_urlsafe(24)
    reclaimed = False
    with db.transaction(immediate=True) as conn:
        row = conn.execute(
            "SELECT * FROM idempotency_responses WHERE request_id=? AND endpoint=?",
            (request_id, endpoint),
        ).fetchone()
        if row:
            if row["request_sha256"] != request_sha:
                return {"state": "conflict"}
            if row["state"] == "complete" and row["response_json"]:
                return {"state": "complete", "response": json.loads(row["response_json"])}
            raw_expiry = row["lease_expires_at"]
            try:
                expiry = datetime.fromisoformat(raw_expiry) if raw_expiry else None
            except ValueError:
                expiry = None
            if expiry is not None and expiry.tzinfo is not None and expiry > now_at:
                return {"state": "in_progress", "lease_expires_at": expiry.isoformat()}
            changed = conn.execute(
                """UPDATE idempotency_responses
                   SET owner_token=?,lease_expires_at=?,created_at=?
                   WHERE request_id=? AND endpoint=? AND state='in_progress'
                     AND request_sha256=?""",
                (
                    owner_token, lease_expires_at, now,
                    request_id, endpoint, request_sha,
                ),
            ).rowcount
            if changed != 1:
                return {"state": "in_progress"}
            reclaimed = True
        else:
            conn.execute(
                """INSERT INTO idempotency_responses(
                   request_id,endpoint,request_sha256,state,response_json,
                   owner_token,lease_expires_at,created_at,completed_at
                 ) VALUES (?,?,?,'in_progress',NULL,?,?,?,NULL)""",
                (request_id, endpoint, request_sha, owner_token, lease_expires_at, now),
            )
    _remember_idempotency_owner(request_id, endpoint, owner_token)
    return {
        "state": "claimed",
        "owner_token": owner_token,
        "lease_expires_at": lease_expires_at,
        "reclaimed": reclaimed,
    }


def complete_idempotency(
    request_id: str,
    endpoint: str,
    response: Any,
    *,
    owner_token: str | None = None,
) -> None:
    owner = _idempotency_owner(request_id, endpoint, owner_token)
    if not owner:
        raise RuntimeError("idempotency completion requires the current claim owner")
    with db.transaction(immediate=True) as conn:
        changed = conn.execute(
            """UPDATE idempotency_responses
               SET state='complete',response_json=?,completed_at=?,
                   owner_token=NULL,lease_expires_at=NULL
               WHERE request_id=? AND endpoint=? AND state='in_progress'
                 AND owner_token=?""",
            (_json(response), _now().isoformat(), request_id, endpoint, owner),
        ).rowcount
        if changed != 1:
            raise RuntimeError("idempotency claim is not in progress")
    _forget_idempotency_owner(request_id, endpoint)


def release_idempotency(
    request_id: str,
    endpoint: str,
    *,
    owner_token: str | None = None,
) -> None:
    owner = _idempotency_owner(request_id, endpoint, owner_token)
    if not owner:
        return
    with db.transaction(immediate=True) as conn:
        conn.execute(
            """DELETE FROM idempotency_responses
               WHERE request_id=? AND endpoint=? AND state='in_progress'
                 AND owner_token=?""",
            (request_id, endpoint, owner),
        )
    _forget_idempotency_owner(request_id, endpoint)


def _future_navs(
    conn,
    code: str,
    after: date,
    limit: int | None = None,
    *,
    as_of: date | None = None,
):
    cutoff = as_of or _market_date()
    sql = "SELECT date,nav FROM nav_history WHERE code=? AND date>? AND date<=? ORDER BY date"
    params: list[Any] = [code, after.isoformat(), cutoff.isoformat()]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return conn.execute(sql, params).fetchall()


def _peer_benchmark(
    conn,
    decision: DecisionSnapshot,
    evidence: EvidenceSnapshot,
    base_nav_date: date,
    evaluation_date: date,
) -> tuple[float | None, int]:
    rows = conn.execute(
        """SELECT d.payload_json AS decision_json,e.payload_json AS evidence_json
           FROM decision_snapshots d JOIN evidence_snapshots e ON e.evidence_id=d.evidence_id
           WHERE d.decision_id<>? AND d.fund_code<>? AND e.fund_type=?
             AND julianday(d.created_at)<=julianday(?)
             AND julianday(e.created_at)<=julianday(?)
           ORDER BY julianday(d.created_at) DESC,d.rowid DESC""",
        (
            decision.decision_id,
            decision.fund_code,
            evidence.fund_type,
            decision.created_at.isoformat(),
            decision.created_at.isoformat(),
        ),
    ).fetchall()
    peers = []
    seen_funds: set[str] = set()
    for row in rows:
        peer_decision = DecisionSnapshot.model_validate_json(row["decision_json"])
        peer_evidence = EvidenceSnapshot.model_validate_json(row["evidence_json"])
        if peer_decision.fund_code in seen_funds:
            continue
        if peer_evidence.market_time is not None and peer_evidence.market_time > decision.created_at:
            continue
        navs = conn.execute(
            """SELECT date,nav FROM nav_history
               WHERE code=? AND date IN (?,?)""",
            (
                peer_decision.fund_code,
                base_nav_date.isoformat(),
                evaluation_date.isoformat(),
            ),
        ).fetchall()
        by_date = {row["date"]: float(row["nav"]) for row in navs}
        base_nav = by_date.get(base_nav_date.isoformat())
        evaluated_nav = by_date.get(evaluation_date.isoformat())
        if base_nav is None or evaluated_nav is None or base_nav <= 0 or evaluated_nav <= 0:
            continue
        seen_funds.add(peer_decision.fund_code)
        peers.append((evaluated_nav / base_nav - 1) * 100)
    return (statistics.fmean(peers), len(peers)) if len(peers) >= 2 else (None, len(peers))


def _hit(action: str, value: float) -> bool:
    if action in POSITIVE_ACTIONS:
        return value > 0
    if action in DEFENSIVE_ACTIONS:
        return value <= 0
    return value >= 0


def _max_drawdown(base_nav: float, path: Iterable[float]) -> float:
    peak = float(base_nav)
    value = 0.0
    for raw in path:
        nav = float(raw)
        peak = max(peak, nav)
        value = min(value, (nav / peak - 1) * 100)
    return round(value, 4)


def save_outcome(outcome: OutcomeEvaluation) -> OutcomeEvaluation:
    identity = {
        "decision_id": outcome.decision_id,
        "evaluation_kind": outcome.evaluation_kind,
        "horizon": outcome.horizon,
        "evaluation_date": outcome.evaluation_date,
    }
    _assert_id(outcome.outcome_id, stable_id("out", identity), "outcome")
    payload = _model_payload(outcome)
    semantic = _without(payload, "created_at")
    semantic_sha = payload_sha256(semantic)
    with db.transaction(immediate=True) as conn:
        decision = _existing_model(
            conn, "decision_snapshots", "decision_id", outcome.decision_id, DecisionSnapshot,
        )
        if decision is None:
            raise LookupError("outcome decision does not exist")
        evidence = _existing_model(
            conn, "evidence_snapshots", "evidence_id", decision.evidence_id, EvidenceSnapshot,
        )
        if evidence is None or evidence.official_nav is None or evidence.official_nav_date is None:
            raise LookupError("outcome decision has no persisted official NAV evidence")
        if outcome.created_at < decision.created_at:
            raise ValueError("outcome cannot predate its decision")
        if outcome.evaluation_kind == "horizon":
            expected_base_date = _market_date(decision.created_at)
            base_row = conn.execute(
                "SELECT nav FROM nav_history WHERE code=? AND date=?",
                (decision.fund_code, expected_base_date.isoformat()),
            ).fetchone()
            if (
                outcome.base_nav_date != expected_base_date
                or base_row is None
                or not _close(outcome.base_nav, float(base_row["nav"]))
            ):
                raise ValueError("horizon outcome base NAV must be the exact decision-date NAV")
        elif outcome.base_nav_date != evidence.official_nav_date or not _close(
            outcome.base_nav, evidence.official_nav,
        ):
            raise ValueError("QDII outcome base NAV axis does not match decision evidence")
        if outcome.target_nav_date != evidence.target_nav_date:
            raise ValueError("outcome target NAV date does not match decision evidence")
        nav_row = conn.execute(
            "SELECT nav FROM nav_history WHERE code=? AND date=?",
            (decision.fund_code, outcome.evaluation_date.isoformat()),
        ).fetchone()
        if nav_row is None or not _close(outcome.evaluated_nav, float(nav_row["nav"])):
            raise ValueError("outcome evaluated NAV is not the exact persisted fund/date value")
        expected_return = (outcome.evaluated_nav / outcome.base_nav - 1) * 100
        if not _close(outcome.absolute_return, expected_return, tolerance=5e-4):
            raise ValueError("outcome return does not match its NAV values")
        if outcome.evaluation_kind == "horizon":
            future = _future_navs(
                conn,
                decision.fund_code,
                outcome.base_nav_date,
                outcome.horizon,
                as_of=_market_date(outcome.created_at),
            )
            if len(future) != outcome.horizon or future[-1]["date"] != outcome.evaluation_date.isoformat():
                raise ValueError("outcome horizon does not match the exact forward NAV axis")
            if outcome.predicted_change is not None or outcome.prediction_error is not None:
                raise ValueError("horizon outcome cannot contain QDII prediction fields")
            if outcome.hit != _hit(decision.action, expected_return):
                raise ValueError("outcome hit flag does not match the decision action")
            expected_drawdown = _max_drawdown(
                outcome.base_nav,
                [float(row["nav"]) for row in future],
            )
            if not _close(outcome.max_drawdown, expected_drawdown, tolerance=5e-4):
                raise ValueError("outcome drawdown does not match the persisted NAV path")
            peer_return, peer_count = _peer_benchmark(
                conn,
                decision,
                evidence,
                outcome.base_nav_date,
                outcome.evaluation_date,
            )
            if outcome.benchmark_samples != peer_count:
                raise ValueError("outcome peer sample count does not match persisted peers")
            expected_peer_excess = (
                expected_return - peer_return if peer_return is not None else None
            )
            if (
                (outcome.peer_excess is None) != (expected_peer_excess is None)
                or (
                    outcome.peer_excess is not None
                    and expected_peer_excess is not None
                    and not _close(outcome.peer_excess, expected_peer_excess, tolerance=5e-4)
                )
            ):
                raise ValueError("outcome peer excess does not match same-period peers")
        else:
            if outcome.peer_excess is not None or outcome.benchmark_samples:
                raise ValueError("QDII target outcome cannot contain peer benchmark fields")
            if evidence.target_nav_date != outcome.evaluation_date:
                raise ValueError("QDII outcome must use the evidence target NAV date")
            if outcome.predicted_change != evidence.estimate:
                raise ValueError("QDII outcome prediction does not match decision evidence")
            expected_error = (
                outcome.predicted_change - outcome.absolute_return
                if outcome.predicted_change is not None else None
            )
            if expected_error is None or outcome.prediction_error is None or not _close(
                outcome.prediction_error, expected_error, tolerance=5e-4,
            ):
                raise ValueError("QDII prediction error is inconsistent")
            if outcome.hit != ((outcome.predicted_change >= 0) == (expected_return >= 0)):
                raise ValueError("QDII hit flag does not match prediction direction")
            qdii_path = conn.execute(
                """SELECT nav FROM nav_history
                   WHERE code=? AND date>? AND date<=? ORDER BY date""",
                (
                    decision.fund_code,
                    outcome.base_nav_date.isoformat(),
                    outcome.evaluation_date.isoformat(),
                ),
            ).fetchall()
            expected_drawdown = _max_drawdown(
                outcome.base_nav,
                [float(row["nav"]) for row in qdii_path],
            )
            if not _close(outcome.max_drawdown, expected_drawdown, tolerance=5e-4):
                raise ValueError("QDII outcome drawdown does not match the persisted NAV path")
        existing = _existing_model(conn, "outcome_evaluations", "outcome_id", outcome.outcome_id, OutcomeEvaluation)
        if existing is not None:
            if payload_sha256(_without(_model_payload(existing), "created_at")) != semantic_sha:
                raise SnapshotConflictError("stored outcome id has different content")
            return existing
        collision = conn.execute(
            """SELECT payload_json FROM outcome_evaluations
               WHERE decision_id=? AND evaluation_kind=? AND horizon=?""",
            (outcome.decision_id, outcome.evaluation_kind, outcome.horizon),
        ).fetchone()
        if collision:
            existing = OutcomeEvaluation.model_validate_json(collision["payload_json"])
            if existing.outcome_id != outcome.outcome_id:
                raise SnapshotConflictError("decision horizon is already settled differently")
            return existing
        conn.execute(
            """INSERT INTO outcome_evaluations(
               outcome_id,decision_id,evaluation_kind,horizon,base_nav_date,
               evaluation_date,target_nav_date,base_nav,evaluated_nav,absolute_return,
               benchmark_return,peer_excess,max_drawdown,hit,benchmark_samples,
               predicted_change,prediction_error,created_at,payload_json,payload_sha256
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                outcome.outcome_id, outcome.decision_id, outcome.evaluation_kind, outcome.horizon,
                outcome.base_nav_date.isoformat(), outcome.evaluation_date.isoformat(),
                outcome.target_nav_date.isoformat() if outcome.target_nav_date else None,
                outcome.base_nav, outcome.evaluated_nav, outcome.absolute_return,
                outcome.benchmark_return, outcome.peer_excess, outcome.max_drawdown,
                int(outcome.hit), outcome.benchmark_samples, outcome.predicted_change,
                outcome.prediction_error, outcome.created_at.isoformat(), _json(payload), semantic_sha,
            ),
        )
    return outcome


def _make_outcome(
    decision: DecisionSnapshot,
    evidence: EvidenceSnapshot,
    *,
    kind: str,
    horizon: int,
    evaluation_date: date,
    evaluated_nav: float,
    path: list[float],
    base_nav_date: date,
    base_nav: float,
    peer_return: float | None = None,
    benchmark_samples: int = 0,
    predicted_change: float | None = None,
) -> OutcomeEvaluation:
    if base_nav <= 0:
        raise ValueError("outcome requires a positive exact base NAV")
    actual = (evaluated_nav / base_nav - 1) * 100
    max_drawdown = _max_drawdown(base_nav, path)
    identity = {
        "decision_id": decision.decision_id,
        "evaluation_kind": kind,
        "horizon": horizon,
        "evaluation_date": evaluation_date,
    }
    return OutcomeEvaluation(
        outcome_id=stable_id("out", identity),
        decision_id=decision.decision_id,
        evaluation_kind=kind,
        horizon=horizon,
        base_nav_date=base_nav_date,
        evaluation_date=evaluation_date,
        target_nav_date=evidence.target_nav_date,
        base_nav=base_nav,
        evaluated_nav=evaluated_nav,
        absolute_return=round(actual, 4),
        # No immutable market-benchmark series is bound to V8 evidence yet.
        # Keep it explicitly null instead of mislabelling a peer mean.
        benchmark_return=None,
        peer_excess=round(actual - peer_return, 4) if peer_return is not None else None,
        max_drawdown=max_drawdown,
        hit=_hit(decision.action, actual) if kind == "horizon" else (
            (predicted_change >= 0) == (actual >= 0) if predicted_change is not None else False
        ),
        benchmark_samples=benchmark_samples,
        predicted_change=predicted_change,
        prediction_error=round(predicted_change - actual, 4) if predicted_change is not None else None,
        created_at=_now(),
    )


def settle_outcomes(decision_id: str, horizons: Iterable[int] = HORIZONS) -> list[OutcomeEvaluation]:
    decision = get_decision(decision_id)
    if decision is None:
        raise LookupError("decision not found")
    evidence = get_evidence(decision.evidence_id)
    if evidence is None:
        raise LookupError("decision evidence is missing")
    cutoff = _market_date()
    decision_date = _market_date(decision.created_at)
    conn = db.get_conn()
    candidates: list[OutcomeEvaluation] = []
    try:
        base_row = conn.execute(
            "SELECT nav FROM nav_history WHERE code=? AND date=?",
            (decision.fund_code, decision_date.isoformat()),
        ).fetchone()
        for horizon in horizons:
            if horizon not in HORIZONS:
                raise ValueError("unsupported outcome horizon")
            existing = conn.execute(
                """SELECT 1 FROM outcome_evaluations
                   WHERE decision_id=? AND evaluation_kind='horizon' AND horizon=?""",
                (decision_id, horizon),
            ).fetchone()
            if existing:
                continue
            if base_row is None:
                continue
            future = _future_navs(
                conn,
                decision.fund_code,
                decision_date,
                horizon,
                as_of=cutoff,
            )
            if len(future) < horizon:
                continue
            point = future[horizon - 1]
            evaluation_date = date.fromisoformat(point["date"])
            peer_return, peer_count = _peer_benchmark(
                conn,
                decision,
                evidence,
                decision_date,
                evaluation_date,
            )
            candidates.append(_make_outcome(
                decision, evidence, kind="horizon", horizon=horizon,
                evaluation_date=evaluation_date,
                evaluated_nav=float(point["nav"]),
                path=[float(row["nav"]) for row in future],
                base_nav_date=decision_date,
                base_nav=float(base_row["nav"]),
                peer_return=peer_return,
                benchmark_samples=peer_count,
            ))
        if (
            evidence.official_nav is not None
            and evidence.official_nav_date is not None
            and evidence.target_nav_date is not None
            and evidence.target_nav_date <= cutoff
            and evidence.estimate is not None
        ):
            existing = conn.execute(
                """SELECT 1 FROM outcome_evaluations
                   WHERE decision_id=? AND evaluation_kind='qdii_target' AND horizon=0""",
                (decision_id,),
            ).fetchone()
            if not existing:
                # Exact date only.  Never use the next NAV when a QDII target is absent.
                target = conn.execute(
                    "SELECT date,nav FROM nav_history WHERE code=? AND date=?",
                    (decision.fund_code, evidence.target_nav_date.isoformat()),
                ).fetchone()
                if target:
                    path_rows = conn.execute(
                        """SELECT nav FROM nav_history WHERE code=? AND date>? AND date<=? ORDER BY date""",
                        (decision.fund_code, evidence.official_nav_date.isoformat(), evidence.target_nav_date.isoformat()),
                    ).fetchall()
                    candidates.append(_make_outcome(
                        decision, evidence, kind="qdii_target", horizon=0,
                        evaluation_date=evidence.target_nav_date,
                        evaluated_nav=float(target["nav"]),
                        path=[float(row["nav"]) for row in path_rows],
                        base_nav_date=evidence.official_nav_date,
                        base_nav=evidence.official_nav,
                        predicted_change=evidence.estimate,
                    ))
    finally:
        conn.close()
    for outcome in candidates:
        save_outcome(outcome)
    return outcome_rows(decision_id)


def outcome_rows(decision_id: str) -> list[OutcomeEvaluation]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT payload_json FROM outcome_evaluations WHERE decision_id=?
               ORDER BY evaluation_kind,horizon""",
            (decision_id,),
        ).fetchall()
        return [OutcomeEvaluation.model_validate_json(row["payload_json"]) for row in rows]
    finally:
        conn.close()


def historical_outcome_summary(
    fund_code: str,
    strategy_version: str,
    *,
    at: datetime,
    horizon: int = 20,
) -> dict[str, Any]:
    """Summarize only same-strategy outcomes knowable before ``at``.

    The strict prior-market-date boundary prevents an intraday decision from
    learning the same day's closing NAV.  The persistence-time boundary also
    prevents a later backfill from leaking into an older decision replay.
    This is deliberately read-only and never attempts outcome settlement.
    """
    if at.tzinfo is None:
        raise ValueError("outcome summary time must include a timezone")
    if horizon not in HORIZONS:
        raise ValueError("unsupported outcome summary horizon")
    cutoff_date = _market_date(at)
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT o.payload_json
               FROM outcome_evaluations o
               JOIN decision_snapshots d ON d.decision_id=o.decision_id
               WHERE d.fund_code=? AND d.strategy_version=?
                 AND o.evaluation_kind='horizon' AND o.horizon=?
                 AND o.evaluation_date<?
                 AND julianday(o.created_at)<julianday(?)
                 AND julianday(d.created_at)<julianday(?)
               ORDER BY o.evaluation_date,o.rowid""",
            (
                fund_code,
                strategy_version,
                horizon,
                cutoff_date.isoformat(),
                at.isoformat(),
                at.isoformat(),
            ),
        ).fetchall()
    finally:
        conn.close()
    outcomes = [
        OutcomeEvaluation.model_validate_json(row["payload_json"])
        for row in rows
    ]
    peer_values = [
        value.peer_excess for value in outcomes if value.peer_excess is not None
    ]
    return {
        "fund_code": fund_code,
        "strategy_version": strategy_version,
        "as_of": at.isoformat(),
        "horizon": horizon,
        "samples": len(outcomes),
        "hit_rate": (
            round(sum(value.hit for value in outcomes) / len(outcomes) * 100, 2)
            if outcomes else None
        ),
        "mean_return": (
            round(statistics.fmean(value.absolute_return for value in outcomes), 4)
            if outcomes else None
        ),
        "peer_excess": (
            round(statistics.fmean(peer_values), 4) if peer_values else None
        ),
    }


def _portfolio_common_navs(
    conn,
    snapshot: PortfolioDecisionSnapshot,
    *,
    as_of: date,
) -> tuple[list[date], dict[str, dict[date, float]]]:
    codes = [item.fund_code for item in snapshot.components]
    placeholders = ",".join("?" for _ in codes)
    rows = conn.execute(
        f"""SELECT code,date,nav FROM nav_history
            WHERE code IN ({placeholders}) AND date>=? AND date<=?
            ORDER BY date,code""",
        (*codes, snapshot.decision_date.isoformat(), as_of.isoformat()),
    ).fetchall()
    by_code: dict[str, dict[date, float]] = {code: {} for code in codes}
    for row in rows:
        nav = float(row["nav"])
        if math.isfinite(nav) and nav > 0:
            by_code[row["code"]][date.fromisoformat(row["date"])] = nav
    common = sorted(set.intersection(*(set(by_code[code]) for code in codes)))
    return common, by_code


def _calculate_portfolio_outcome(
    conn,
    snapshot: PortfolioDecisionSnapshot,
    horizon: int,
    *,
    created_at: datetime | None = None,
) -> PortfolioOutcomeEvaluation | None:
    if horizon not in HORIZONS:
        raise ValueError("unsupported portfolio outcome horizon")
    stamp = created_at or _now()
    cutoff = _market_date(stamp)
    common_dates, navs = _portfolio_common_navs(conn, snapshot, as_of=cutoff)
    if not common_dates or common_dates[0] != snapshot.decision_date:
        return None
    future_dates = [value for value in common_dates if value > snapshot.decision_date]
    if len(future_dates) < horizon:
        return None
    evaluation_date = future_dates[horizon - 1]
    components: list[PortfolioOutcomeComponent] = []
    for component in snapshot.components:
        base_nav = navs[component.fund_code][snapshot.decision_date]
        evaluated_nav = navs[component.fund_code][evaluation_date]
        absolute_return = (evaluated_nav / base_nav - 1) * 100
        components.append(PortfolioOutcomeComponent(
            fund_code=component.fund_code,
            current_weight=component.current_weight,
            base_nav=base_nav,
            evaluated_nav=evaluated_nav,
            absolute_return=round(absolute_return, 6),
            contribution=round(component.current_weight / 100 * absolute_return, 6),
        ))
    portfolio_path = []
    for point_date in future_dates[:horizon]:
        value = snapshot.current_cash_weight / 100
        for component in snapshot.components:
            value += (
                component.current_weight
                / 100
                * navs[component.fund_code][point_date]
                / navs[component.fund_code][snapshot.decision_date]
            )
        portfolio_path.append(value)
    identity = {
        "portfolio_decision_id": snapshot.portfolio_decision_id,
        "horizon": horizon,
        "evaluation_date": evaluation_date,
    }
    return PortfolioOutcomeEvaluation(
        outcome_id=stable_id("pout", identity),
        portfolio_decision_id=snapshot.portfolio_decision_id,
        horizon=horizon,
        base_nav_date=snapshot.decision_date,
        evaluation_date=evaluation_date,
        absolute_return=round(sum(item.contribution for item in components), 4),
        max_drawdown=_max_drawdown(1.0, portfolio_path),
        current_cash_weight=snapshot.current_cash_weight,
        components=components,
        created_at=stamp,
    )


def save_portfolio_outcome(
    outcome: PortfolioOutcomeEvaluation,
) -> PortfolioOutcomeEvaluation:
    identity = {
        "portfolio_decision_id": outcome.portfolio_decision_id,
        "horizon": outcome.horizon,
        "evaluation_date": outcome.evaluation_date,
    }
    _assert_id(outcome.outcome_id, stable_id("pout", identity), "portfolio outcome")
    payload = _model_payload(outcome)
    semantic = _without(payload, "created_at")
    semantic_sha = payload_sha256(semantic)
    with db.transaction(immediate=True) as conn:
        snapshot = _existing_model(
            conn,
            "portfolio_decision_snapshots",
            "portfolio_decision_id",
            outcome.portfolio_decision_id,
            PortfolioDecisionSnapshot,
        )
        if snapshot is None:
            raise LookupError("portfolio outcome decision does not exist")
        if outcome.created_at < snapshot.created_at:
            raise ValueError("portfolio outcome cannot predate its decision")
        expected = _calculate_portfolio_outcome(
            conn,
            snapshot,
            outcome.horizon,
            created_at=outcome.created_at,
        )
        if expected is None:
            raise ValueError("portfolio outcome does not have a complete common NAV axis")
        if payload_sha256(_without(_model_payload(expected), "created_at")) != semantic_sha:
            raise ValueError("portfolio outcome does not match persisted common-date NAV data")
        existing = _existing_model(
            conn,
            "portfolio_outcome_evaluations",
            "outcome_id",
            outcome.outcome_id,
            PortfolioOutcomeEvaluation,
        )
        if existing is not None:
            if payload_sha256(_without(_model_payload(existing), "created_at")) != semantic_sha:
                raise SnapshotConflictError("stored portfolio outcome id has different content")
            return existing
        collision = conn.execute(
            """SELECT payload_json FROM portfolio_outcome_evaluations
               WHERE portfolio_decision_id=? AND horizon=?""",
            (outcome.portfolio_decision_id, outcome.horizon),
        ).fetchone()
        if collision:
            stored = PortfolioOutcomeEvaluation.model_validate_json(collision["payload_json"])
            if stored.outcome_id != outcome.outcome_id:
                raise SnapshotConflictError("portfolio horizon is already settled differently")
            return stored
        conn.execute(
            """INSERT INTO portfolio_outcome_evaluations(
               outcome_id,portfolio_decision_id,horizon,base_nav_date,evaluation_date,
               absolute_return,max_drawdown,current_cash_weight,cash_return,
               cash_contribution,components_json,method,created_at,payload_json,payload_sha256
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                outcome.outcome_id,
                outcome.portfolio_decision_id,
                outcome.horizon,
                outcome.base_nav_date.isoformat(),
                outcome.evaluation_date.isoformat(),
                outcome.absolute_return,
                outcome.max_drawdown,
                outcome.current_cash_weight,
                outcome.cash_return,
                outcome.cash_contribution,
                _json(outcome.components),
                outcome.method,
                outcome.created_at.isoformat(),
                _json(payload),
                semantic_sha,
            ),
        )
    return outcome


def portfolio_outcome_rows(
    portfolio_decision_id: str,
) -> list[PortfolioOutcomeEvaluation]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT payload_json FROM portfolio_outcome_evaluations
               WHERE portfolio_decision_id=? ORDER BY horizon""",
            (portfolio_decision_id,),
        ).fetchall()
        return [PortfolioOutcomeEvaluation.model_validate_json(row["payload_json"]) for row in rows]
    finally:
        conn.close()


def settle_portfolio_outcomes(
    portfolio_decision_id: str,
    horizons: Iterable[int] = HORIZONS,
) -> list[PortfolioOutcomeEvaluation]:
    snapshot = get_portfolio_decision(portfolio_decision_id)
    if snapshot is None:
        raise LookupError("portfolio decision not found")
    requested = list(dict.fromkeys(int(value) for value in horizons))
    if any(value not in HORIZONS for value in requested):
        raise ValueError("unsupported portfolio outcome horizon")
    conn = db.get_conn()
    candidates: list[PortfolioOutcomeEvaluation] = []
    try:
        existing = {
            int(row["horizon"])
            for row in conn.execute(
                """SELECT horizon FROM portfolio_outcome_evaluations
                   WHERE portfolio_decision_id=?""",
                (portfolio_decision_id,),
            ).fetchall()
        }
        for horizon in requested:
            if horizon in existing:
                continue
            candidate = _calculate_portfolio_outcome(conn, snapshot, horizon)
            if candidate is not None:
                candidates.append(candidate)
    finally:
        conn.close()
    for candidate in candidates:
        save_portfolio_outcome(candidate)
    return portfolio_outcome_rows(portfolio_decision_id)


def portfolio_outcomes(limit: int = 100) -> dict:
    """Read immutable portfolio snapshots and outcomes without settling them."""
    snapshots = portfolio_decision_snapshots(limit)
    cutoff = _market_date()
    items = []
    for snapshot in snapshots:
        rows = portfolio_outcome_rows(snapshot.portfolio_decision_id)
        settled = {row.horizon for row in rows}
        conn = db.get_conn()
        try:
            common_dates, _ = _portfolio_common_navs(conn, snapshot, as_of=cutoff)
        finally:
            conn.close()
        base_available = bool(common_dates and common_dates[0] == snapshot.decision_date)
        available = (
            len([value for value in common_dates if value > snapshot.decision_date])
            if base_available else 0
        )
        missing = [horizon for horizon in HORIZONS if horizon not in settled]
        items.append({
            "portfolio_decision": snapshot.model_dump(mode="json"),
            "outcomes": [row.model_dump(mode="json") for row in rows],
            "pending_horizons": missing if base_available else [],
            "ready_horizons": [value for value in missing if available >= value],
            "unavailable_horizons": missing if not base_available else [],
            "available_common_observations": available,
        })
    return {
        "total": len(items),
        "mature": sum(bool(item["outcomes"]) for item in items),
        "pending": sum(bool(item["pending_horizons"]) for item in items),
        "unavailable": sum(bool(item["unavailable_horizons"]) for item in items),
        "items": items,
    }


def settle_all_portfolio_outcomes(limit: int = 100) -> dict:
    bounded_limit = max(1, min(10_000, int(limit)))
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT p.portfolio_decision_id
               FROM portfolio_decision_snapshots p
               WHERE (
                 SELECT COUNT(*) FROM portfolio_outcome_evaluations o
                 WHERE o.portfolio_decision_id=p.portfolio_decision_id
                   AND o.horizon IN (5,20,60)
               ) < 3
               ORDER BY julianday(p.created_at),p.rowid LIMIT ?""",
            (bounded_limit,),
        ).fetchall()
    finally:
        conn.close()
    settled = 0
    errors: list[dict[str, str]] = []
    for row in rows:
        identifier = row["portfolio_decision_id"]
        try:
            before = len(portfolio_outcome_rows(identifier))
            after = len(settle_portfolio_outcomes(identifier))
        except Exception as error:
            errors.append({
                "portfolio_decision_id": identifier,
                "error": type(error).__name__,
            })
        else:
            if after > before:
                settled += after - before
    return {"settled": settled, "scanned": len(rows), "errors": errors}


def outcomes_for_fund(fund_code: str) -> dict:
    """Read already-settled outcomes and pending axes without writing rows."""
    decisions = decision_history(fund_code, 200)
    items = []
    for decision in decisions:
        rows = outcome_rows(decision.decision_id)
        mature = {(row.evaluation_kind, row.horizon): row for row in rows}
        evidence = get_evidence(decision.evidence_id)
        conn = db.get_conn()
        try:
            decision_date = _market_date(decision.created_at)
            horizon_base_available = bool(conn.execute(
                "SELECT 1 FROM nav_history WHERE code=? AND date=?",
                (decision.fund_code, decision_date.isoformat()),
            ).fetchone())
        finally:
            conn.close()
        items.append({
            "decision": decision.model_dump(mode="json"),
            "outcomes": [row.model_dump(mode="json") for row in rows],
            "pending_horizons": [
                h for h in HORIZONS
                if horizon_base_available and ("horizon", h) not in mature
            ],
            "unavailable_horizons": [
                h for h in HORIZONS
                if not horizon_base_available and ("horizon", h) not in mature
            ],
            "qdii_target_pending": bool(
                evidence
                and evidence.official_nav is not None
                and evidence.official_nav_date is not None
                and evidence.target_nav_date
                and evidence.estimate is not None
                and ("qdii_target", 0) not in mature
            ),
        })
    return {"fund_code": fund_code, "total": len(items), "items": items}


def outcome_settlement_status(
    decision_ids: Iterable[str] | None = None,
    *,
    limit: int = 1000,
) -> dict:
    """Return a read-only count of missing immutable outcome rows."""
    bounded_limit = max(1, min(10_000, int(limit)))
    requested = list(dict.fromkeys(decision_ids or []))
    conn = db.get_conn()
    try:
        if requested:
            placeholders = ",".join("?" for _ in requested)
            rows = conn.execute(
                f"""SELECT decision_id,payload_json FROM decision_snapshots
                    WHERE decision_id IN ({placeholders})""",
                requested,
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT decision_id,payload_json FROM decision_snapshots
                   ORDER BY julianday(created_at) DESC,rowid DESC LIMIT ?""",
                (bounded_limit,),
            ).fetchall()
        by_id = {row["decision_id"]: row for row in rows}
        errors = [
            {"decision_id": identifier, "error": "decision not found"}
            for identifier in requested if identifier not in by_id
        ]
        missing: list[dict[str, Any]] = []
        unavailable: list[dict[str, Any]] = []
        for row in rows:
            decision = DecisionSnapshot.model_validate_json(row["payload_json"])
            evidence = _existing_model(
                conn, "evidence_snapshots", "evidence_id", decision.evidence_id, EvidenceSnapshot,
            )
            if evidence is None:
                errors.append({
                    "decision_id": decision.decision_id,
                    "error": "decision evidence not found",
                })
                continue
            existing = {
                (item["evaluation_kind"], int(item["horizon"]))
                for item in conn.execute(
                    """SELECT evaluation_kind,horizon FROM outcome_evaluations
                       WHERE decision_id=?""",
                    (decision.decision_id,),
                ).fetchall()
            }
            decision_date = _market_date(decision.created_at)
            horizon_base_available = bool(conn.execute(
                "SELECT 1 FROM nav_history WHERE code=? AND date=?",
                (decision.fund_code, decision_date.isoformat()),
            ).fetchone())
            for horizon in HORIZONS:
                if ("horizon", horizon) not in existing:
                    target = missing if horizon_base_available else unavailable
                    target.append({
                        "decision_id": decision.decision_id,
                        "evaluation_kind": "horizon",
                        "horizon": horizon,
                        **({} if horizon_base_available else {"reason": "decision_date_nav_unavailable"}),
                    })
            if (
                evidence.official_nav is not None
                and evidence.official_nav_date is not None
                and evidence.target_nav_date is not None
                and evidence.estimate is not None
                and ("qdii_target", 0) not in existing
            ):
                missing.append({
                    "decision_id": decision.decision_id,
                    "evaluation_kind": "qdii_target",
                    "horizon": 0,
                    "target_nav_date": evidence.target_nav_date.isoformat(),
                })
    finally:
        conn.close()
    return {
        "decisions": len(rows),
        "pending": len(missing),
        "missing": missing,
        "unavailable": len(unavailable),
        "unavailable_items": unavailable,
        "errors": errors,
    }


def settle_all_outcomes(limit: int = 1000) -> dict:
    cutoff = _market_date()
    bounded_limit = max(1, min(10_000, limit))
    conn = db.get_conn()
    try:
        ids = [row[0] for row in conn.execute(
            """SELECT d.decision_id
               FROM decision_snapshots d
               JOIN evidence_snapshots e ON e.evidence_id=d.evidence_id
               WHERE (
                 (
                   EXISTS (
                     SELECT 1 FROM nav_history base
                     WHERE base.code=d.fund_code
                       AND base.date=date(d.created_at,'+8 hours')
                   )
                   AND (
                     (NOT EXISTS (
                        SELECT 1 FROM outcome_evaluations o
                        WHERE o.decision_id=d.decision_id
                          AND o.evaluation_kind='horizon' AND o.horizon=5
                      ) AND 5 <= (
                        SELECT COUNT(*) FROM nav_history n
                        WHERE n.code=d.fund_code
                          AND n.date>date(d.created_at,'+8 hours') AND n.date<=?
                      ))
                     OR
                     (NOT EXISTS (
                        SELECT 1 FROM outcome_evaluations o
                        WHERE o.decision_id=d.decision_id
                          AND o.evaluation_kind='horizon' AND o.horizon=20
                      ) AND 20 <= (
                        SELECT COUNT(*) FROM nav_history n
                        WHERE n.code=d.fund_code
                          AND n.date>date(d.created_at,'+8 hours') AND n.date<=?
                      ))
                     OR
                     (NOT EXISTS (
                        SELECT 1 FROM outcome_evaluations o
                        WHERE o.decision_id=d.decision_id
                          AND o.evaluation_kind='horizon' AND o.horizon=60
                      ) AND 60 <= (
                        SELECT COUNT(*) FROM nav_history n
                        WHERE n.code=d.fund_code
                          AND n.date>date(d.created_at,'+8 hours') AND n.date<=?
                      ))
                   )
                 )
                 OR (
                   e.target_nav_date IS NOT NULL AND e.estimate IS NOT NULL
                   AND e.target_nav_date<=?
                   AND EXISTS (
                     SELECT 1 FROM nav_history target
                     WHERE target.code=d.fund_code AND target.date=e.target_nav_date
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM outcome_evaluations o
                     WHERE o.decision_id=d.decision_id
                       AND o.evaluation_kind='qdii_target' AND o.horizon=0
                   )
                 )
               )
               ORDER BY julianday(d.created_at),d.rowid
               LIMIT ?""",
            (
                cutoff.isoformat(),
                cutoff.isoformat(),
                cutoff.isoformat(),
                cutoff.isoformat(),
                bounded_limit,
            ),
        ).fetchall()]
    finally:
        conn.close()
    settled = 0
    errors: list[dict[str, str]] = []
    for decision_id in ids:
        try:
            before = len(outcome_rows(decision_id))
            after = settle_outcomes(decision_id)
            settled += max(0, len(after) - before)
        except Exception as error:
            errors.append({
                "decision_id": decision_id,
                "error": f"{type(error).__name__}: {str(error)[:180]}",
            })
    return {"settled": settled, "scanned": len(ids), "errors": errors}


def strategy_performance(strategy_version: str) -> dict:
    """Aggregate persisted outcomes only; never settles or rewrites history."""
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT o.payload_json,d.decision_id,e.fund_type
               FROM outcome_evaluations o JOIN decision_snapshots d ON d.decision_id=o.decision_id
               JOIN evidence_snapshots e ON e.evidence_id=d.evidence_id
               WHERE d.strategy_version=? AND o.evaluation_kind='horizon'
               ORDER BY o.horizon,o.evaluation_date""",
            (strategy_version,),
        ).fetchall()
    finally:
        conn.close()
    buckets: dict[int, list[OutcomeEvaluation]] = {}
    decision_horizons: dict[str, set[int]] = {}
    decision_types: dict[str, str] = {}
    for row in rows:
        outcome = OutcomeEvaluation.model_validate_json(row["payload_json"])
        buckets.setdefault(outcome.horizon, []).append(outcome)
        decision_horizons.setdefault(row["decision_id"], set()).add(outcome.horizon)
        decision_types[row["decision_id"]] = row["fund_type"] or "unknown"
    metrics = []
    for horizon, values in sorted(buckets.items()):
        excess = [row.peer_excess for row in values if row.peer_excess is not None]
        metrics.append({
            "horizon": horizon,
            "samples": len(values),
            "hit_rate": round(sum(row.hit for row in values) / len(values) * 100, 2),
            "average_return": round(statistics.fmean(row.absolute_return for row in values), 4),
            "average_peer_excess": round(statistics.fmean(excess), 4) if excess else None,
            "average_drawdown": round(statistics.fmean(row.max_drawdown for row in values), 4),
            "worst_drawdown": round(min(row.max_drawdown for row in values), 4),
        })
    sample_ids = set(decision_horizons)
    fully_matured_ids = {
        identifier for identifier, horizons in decision_horizons.items()
        if {20, 60}.issubset(horizons)
    }
    type_counts = Counter(decision_types[identifier] for identifier in fully_matured_ids)
    primary_type, primary_type_samples = (
        type_counts.most_common(1)[0] if type_counts else (None, 0)
    )
    minimum_total = 100
    minimum_primary_type = 30
    eligible = (
        len(fully_matured_ids) >= minimum_total
        and primary_type_samples >= minimum_primary_type
    )
    return {
        "strategy_version": strategy_version,
        "samples": len(sample_ids),
        "metrics": metrics,
        "auto_promotion": False,
        "sample_gate": {
            "minimum_total": minimum_total,
            "actual_total": len(sample_ids),
            "minimum_primary_type": minimum_primary_type,
            "primary_type": primary_type,
            "primary_type_samples": primary_type_samples,
            "required_mature_horizons": [20, 60],
            "fully_matured_samples": len(fully_matured_ids),
        },
        "eligible_for_review": eligible,
    }


def notification_event_id(decision_id: str, scheduled_window: str) -> str:
    return stable_id("ntf", {"decision_id": decision_id, "scheduled_window": scheduled_window})


def _notification_event(
    *,
    decision_id: str,
    scheduled_window: str,
    status: str,
    attempt_no: int,
    natural_schedule: bool,
    occurred_at: datetime,
    error_class: str | None,
    detail: dict[str, Any],
) -> NotificationEvent:
    event_id = notification_event_id(decision_id, scheduled_window)
    log_identity = {
        "notification_event_id": event_id,
        "status": status,
        "attempt_no": attempt_no,
        "natural_schedule": natural_schedule,
    }
    return NotificationEvent(
        notification_event_id=event_id,
        event_log_id=stable_id("ntl", log_identity),
        decision_id=decision_id,
        scheduled_window=scheduled_window,
        status=status,
        attempt_no=attempt_no,
        natural_schedule=natural_schedule,
        occurred_at=occurred_at,
        error_class=error_class,
        detail=detail,
    )


def _notification_semantics(event: NotificationEvent) -> dict:
    """Fields that must match on an idempotent event replay."""
    return _without(event.model_dump(mode="python"), "occurred_at")


def record_notification_events_batch(
    *,
    decision_ids: Iterable[str],
    scheduled_window: str,
    status: str,
    attempt_no: int,
    natural_schedule: bool,
    occurred_at: datetime | None = None,
    error_class: str | None = None,
    detail: dict[str, Any] | None = None,
) -> list[NotificationRecordResult]:
    """Append a notification phase, atomically claiming an entire send batch.

    ``attempted`` is the transport claim.  If any decision/window in the batch
    was claimed previously, no new attempted rows are inserted and the whole
    batch is returned as a duplicate so parallel Cron invocations cannot split
    ownership and both send.
    """
    identifiers = list(decision_ids)
    if not identifiers or len(identifiers) != len(set(identifiers)):
        raise ValueError("notification decision_ids must be non-empty and unique")
    stamp = occurred_at or _now()
    event_detail = detail or {}
    events = [
        _notification_event(
            decision_id=identifier,
            scheduled_window=scheduled_window,
            status=status,
            attempt_no=attempt_no,
            natural_schedule=natural_schedule,
            occurred_at=stamp,
            error_class=error_class,
            detail=event_detail,
        )
        for identifier in identifiers
    ]
    with db.transaction(immediate=True) as conn:
        placeholders = ",".join("?" for _ in identifiers)
        found = {
            row["decision_id"]
            for row in conn.execute(
                f"SELECT decision_id FROM decision_snapshots WHERE decision_id IN ({placeholders})",
                identifiers,
            ).fetchall()
        }
        missing = [identifier for identifier in identifiers if identifier not in found]
        if missing:
            raise LookupError(f"notification decision not found: {','.join(missing)}")

        if status == "attempted":
            event_ids = [event.notification_event_id for event in events]
            event_placeholders = ",".join("?" for _ in event_ids)
            claimed_rows = conn.execute(
                f"""SELECT event_log_id,detail_json FROM notification_events
                    WHERE notification_event_id IN ({event_placeholders})
                      AND status='attempted' AND natural_schedule=?""",
                [*event_ids, int(natural_schedule)],
            ).fetchall()
            if claimed_rows:
                exact = {
                    row["event_log_id"]: NotificationEvent.model_validate_json(row["detail_json"])
                    for row in claimed_rows
                }
                results = []
                for event in events:
                    existing = exact.get(event.event_log_id)
                    if existing is not None and _notification_semantics(existing) != _notification_semantics(event):
                        raise SnapshotConflictError("notification claim replay changed immutable content")
                    results.append(NotificationRecordResult(
                        event=existing or event,
                        claimed=False,
                        duplicate=True,
                    ))
                return results
            if not natural_schedule:
                natural_terminal = conn.execute(
                    f"""SELECT 1 FROM notification_events
                        WHERE decision_id IN ({placeholders})
                          AND natural_schedule=1
                          AND substr(scheduled_window,1,10)=?
                          AND status IN ('sent','compensated') LIMIT 1""",
                    [*identifiers, scheduled_window[:10]],
                ).fetchone()
                if natural_terminal:
                    return [
                        NotificationRecordResult(event=event, claimed=False, duplicate=True)
                        for event in events
                    ]
            if natural_schedule:
                prior_rows = conn.execute(
                    f"""SELECT decision_id,notification_event_id,status,attempt_no,error_class
                        FROM notification_events
                        WHERE decision_id IN ({placeholders})
                          AND natural_schedule=1
                          AND substr(scheduled_window,1,10)=?
                          AND notification_event_id NOT IN ({event_placeholders})""",
                    [*identifiers, scheduled_window[:10], *event_ids],
                ).fetchall()
                phases: dict[tuple[str, str, int], dict[str, set[str]]] = {}
                for row in prior_rows:
                    phase = phases.setdefault(
                        (row["decision_id"], row["notification_event_id"], int(row["attempt_no"])),
                        {"states": set(), "errors": set()},
                    )
                    phase["states"].add(row["status"])
                    if row["error_class"]:
                        phase["errors"].add(row["error_class"])
                prior_claim_is_terminal_or_ambiguous = any(
                    "sent" in phase["states"]
                    or "compensated" in phase["states"]
                    or "delivery_ambiguous" in phase["errors"]
                    or ("attempted" in phase["states"] and "failed" not in phase["states"])
                    for phase in phases.values()
                )
                if prior_claim_is_terminal_or_ambiguous:
                    return [
                        NotificationRecordResult(event=event, claimed=False, duplicate=True)
                        for event in events
                    ]
            for event in events:
                scheduled = conn.execute(
                    """SELECT 1 FROM notification_events
                       WHERE notification_event_id=? AND status='scheduled'
                         AND attempt_no=0 AND natural_schedule=? LIMIT 1""",
                    (event.notification_event_id, int(natural_schedule)),
                ).fetchone()
                if not scheduled:
                    raise SnapshotConflictError("notification attempt has no scheduled event")

        results: list[NotificationRecordResult] = []
        for event in events:
            existing_row = conn.execute(
                "SELECT detail_json FROM notification_events WHERE event_log_id=?",
                (event.event_log_id,),
            ).fetchone()
            if existing_row:
                existing = NotificationEvent.model_validate_json(existing_row["detail_json"])
                if _notification_semantics(existing) != _notification_semantics(event):
                    raise SnapshotConflictError("notification event replay changed immutable content")
                results.append(NotificationRecordResult(
                    event=existing,
                    claimed=False,
                    duplicate=True,
                ))
                continue

            if status in {"sent", "failed", "compensated"}:
                attempted = conn.execute(
                    """SELECT 1 FROM notification_events
                       WHERE notification_event_id=? AND status='attempted'
                         AND attempt_no=? AND natural_schedule=? LIMIT 1""",
                    (event.notification_event_id, attempt_no, int(natural_schedule)),
                ).fetchone()
                if not attempted:
                    raise SnapshotConflictError("notification completion has no matching attempted claim")

            payload = event.model_dump(mode="python")
            conn.execute(
                """INSERT INTO notification_events(
                   event_log_id,notification_event_id,decision_id,scheduled_window,status,
                   attempt_no,natural_schedule,occurred_at,error_class,detail_json
                 ) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    event.event_log_id, event.notification_event_id, event.decision_id,
                    event.scheduled_window, event.status, event.attempt_no,
                    int(event.natural_schedule), event.occurred_at.isoformat(), event.error_class,
                    _json(payload),
                ),
            )
            results.append(NotificationRecordResult(
                event=event,
                claimed=status == "attempted",
                duplicate=False,
            ))
        return results


def record_notification_event(
    *,
    decision_id: str,
    scheduled_window: str,
    status: str,
    attempt_no: int,
    natural_schedule: bool,
    occurred_at: datetime | None = None,
    error_class: str | None = None,
    detail: dict[str, Any] | None = None,
) -> NotificationEvent:
    return record_notification_events_batch(
        decision_ids=[decision_id],
        scheduled_window=scheduled_window,
        status=status,
        attempt_no=attempt_no,
        natural_schedule=natural_schedule,
        occurred_at=occurred_at,
        error_class=error_class,
        detail=detail,
    )[0].event


def notification_events(decision_id: str) -> list[NotificationEvent]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """SELECT detail_json FROM notification_events WHERE decision_id=?
               ORDER BY occurred_at,event_log_id""",
            (decision_id,),
        ).fetchall()
        return [NotificationEvent.model_validate_json(row["detail_json"]) for row in rows]
    finally:
        conn.close()


def notification_was_sent(decision_id: str) -> bool:
    conn = db.get_conn()
    try:
        return bool(conn.execute(
            """SELECT 1 FROM notification_events
               WHERE decision_id=? AND status IN ('sent','compensated') LIMIT 1""",
            (decision_id,),
        ).fetchone())
    finally:
        conn.close()
