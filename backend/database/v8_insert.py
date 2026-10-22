"""Fixed V8 INSERT value slots with explicit exact REAL binding.

This is not an SQL rewriter or a driver default. The repository owns every
table, column, literal and REAL slot below. Only a native sqlite3.Connection
keeps native float parameters; protocol wrappers use exact SQLite expressions
without guessing their transport identity from environment or attributes.
"""
from __future__ import annotations

import sqlite3
from types import MappingProxyType

from database.exact_real import exact_real_binding


__all__ = ("prepare_v8_insert",)


# Column order is the existing repository projection order, not input schema.
_COLUMNS = MappingProxyType({
    "evidence_snapshots": (
        "evidence_id", "fund_code", "fund_name", "fund_type", "created_at", "market_time",
        "official_nav", "official_nav_date", "target_nav_date", "benchmark_id",
        "valuation_percentile", "trend_state", "momentum_state", "drawdown", "volatility",
        "market_temperature", "score", "score_version", "score_coverage", "timing_signal",
        "timing_coverage", "estimate", "estimate_status", "estimate_coverage",
        "estimate_model_version", "estimate_error_p80", "estimate_sample_count",
        "estimate_mae", "estimate_direction_accuracy", "evidence_strength",
        "source_states_json", "evidence_nodes_json", "missing_fields_json",
        "stale_fields_json", "risk_flags_json", "payload_json", "payload_sha256",
    ),
    "source_health_events": (
        "event_id", "evidence_id", "source_id", "state", "last_success", "last_failure",
        "latency_ms", "data_age_seconds", "stale", "error_class", "observed_at", "payload_json",
    ),
    "holding_versions": (
        "holding_version", "fund_code", "user_state", "shares", "cost", "market_value", "account",
        "current_weight", "target_weight", "updated_at", "source", "created_at", "payload_json", "payload_sha256",
    ),
    "portfolio_policy_versions": (
        "policy_version", "name", "target_allocations_json", "target_ranges_json",
        "max_single_fund_weight", "max_theme_weight", "rebalance_band", "dca_rules_json",
        "reduce_rules_json", "sell_rules_json", "effective_at", "created_at", "source",
        "supersedes", "payload_json", "payload_sha256",
    ),
    "decision_snapshots": (
        "decision_id", "evidence_id", "fund_code", "holding_version", "policy_version",
        "strategy_version", "user_state", "action", "strength", "confidence", "summary",
        "reason_codes_json", "reasons_json", "risks_json", "invalidation_codes_json",
        "invalidation_json", "position_guidance_json", "evidence_nodes_json", "created_at", "payload_json", "payload_sha256",
    ),
    "portfolio_decision_snapshots": (
        "portfolio_decision_id", "decision_date", "policy_version", "strategy_version",
        "component_count", "current_cash_weight", "target_cash_weight", "portfolio_value",
        "components_json", "source", "created_at", "payload_json", "payload_sha256",
    ),
    "outcome_evaluations": (
        "outcome_id", "decision_id", "evaluation_kind", "horizon", "base_nav_date",
        "evaluation_date", "target_nav_date", "base_nav", "evaluated_nav", "absolute_return",
        "benchmark_return", "peer_excess", "max_drawdown", "hit", "benchmark_samples",
        "predicted_change", "prediction_error", "created_at", "payload_json", "payload_sha256",
    ),
    "portfolio_outcome_evaluations": (
        "outcome_id", "portfolio_decision_id", "horizon", "base_nav_date", "evaluation_date",
        "absolute_return", "max_drawdown", "current_cash_weight", "cash_return", "cash_contribution",
        "components_json", "method", "created_at", "payload_json", "payload_sha256",
    ),
    "notification_events": (
        "event_log_id", "notification_event_id", "decision_id", "scheduled_window", "status",
        "attempt_no", "natural_schedule", "occurred_at", "error_class", "detail_json",
    ),
    "idempotency_responses": (
        "request_id", "endpoint", "request_sha256", "state", "response_json", "owner_token",
        "lease_expires_at", "created_at", "completed_at",
    ),
})
_REAL_COLUMNS = MappingProxyType({
    "evidence_snapshots": frozenset((
        "official_nav", "valuation_percentile", "drawdown", "volatility", "market_temperature",
        "score", "score_coverage", "timing_coverage", "estimate", "estimate_coverage",
        "estimate_error_p80", "estimate_mae", "estimate_direction_accuracy", "evidence_strength",
    )),
    "source_health_events": frozenset(("latency_ms", "data_age_seconds")),
    "holding_versions": frozenset(("shares", "cost", "market_value", "current_weight", "target_weight")),
    "portfolio_policy_versions": frozenset(("max_single_fund_weight", "max_theme_weight", "rebalance_band")),
    # Decision strength/confidence are INTEGER columns and remain ordinary args.
    "decision_snapshots": frozenset(),
    "portfolio_decision_snapshots": frozenset(("current_cash_weight", "target_cash_weight", "portfolio_value")),
    "outcome_evaluations": frozenset((
        "base_nav", "evaluated_nav", "absolute_return", "benchmark_return", "peer_excess",
        "max_drawdown", "predicted_change", "prediction_error",
    )),
    "portfolio_outcome_evaluations": frozenset((
        "absolute_return", "max_drawdown", "current_cash_weight", "cash_return", "cash_contribution",
    )),
    "notification_events": frozenset(),
    "idempotency_responses": frozenset(),
})
# Preserve the old claim INSERT's SQL literals and six-parameter contract.
_CLAIM_LITERALS = MappingProxyType({"state": "'in_progress'", "response_json": "NULL", "completed_at": "NULL"})
# These templates contain repository-owned names/literals only. Build once,
# never cache private parameters or rewrite a caller's SQL/placeholder text.
_NATIVE_INSERTS = MappingProxyType({
    table: "INSERT INTO " + table + "(" + ",".join(columns) + ") VALUES ("
    + ",".join(_CLAIM_LITERALS[column] if table == "idempotency_responses" and column in _CLAIM_LITERALS else "?"
               for column in columns) + ")"
    for table, columns in _COLUMNS.items()
})


def prepare_v8_insert(conn, table: str, parameters: tuple) -> tuple[str, tuple]:
    """Compile one repository-owned INSERT without executing or owning a tx.

    SQLite keeps its original parameter objects and native binding behavior.
    Other callers use exact_real_binding only in the fixed REAL slots; this
    does not authenticate a protocol wrapper or confer cloud capability.
    Fixed protocol REAL projections follow V8 canonical_json's existing zero
    contract: either native float zero is represented as positive zero. The
    input model, payload and deterministic identities are not changed here;
    the generic exact_real_binding primitive still rejects negative zero.
    Other unsupported/nonfinite inputs fail before the INSERT. This neither
    preserves a binary zero sign nor remotely verifies provider storage.
    """
    if type(table) is not str or table not in _COLUMNS or type(parameters) is not tuple:
        raise ValueError("invalid fixed V8 INSERT contract")
    columns = _COLUMNS[table]
    literals = _CLAIM_LITERALS if table == "idempotency_responses" else {}
    if len(parameters) != len(columns) - len(literals):
        raise ValueError("invalid fixed V8 INSERT parameter count")
    if type(conn) is sqlite3.Connection:
        # The native fast path keeps the exact original parameter tuple and
        # native adapter behavior, including its physical zero semantics.
        return _NATIVE_INSERTS[table], parameters
    fragments = []
    bound = []
    index = 0
    for column in columns:
        if column in literals:
            fragments.append(literals[column])
            continue
        value = parameters[index]
        index += 1
        if column in _REAL_COLUMNS[table]:
            # _canonical_value already gives all V8 float zeros this numeric
            # representation. Apply it only to this trusted REAL projection,
            # not by mutating the model or rewriting payload/ID/hash bytes.
            projected = 0.0 if type(value) is float and value == 0 else value
            expression, args = exact_real_binding(projected)
            fragments.append(expression)
            bound.extend(args)
        else:
            if isinstance(value, float):
                raise TypeError("float outside fixed V8 REAL slots")
            fragments.append("?")
            bound.append(value)
    sql = "INSERT INTO " + table + "(" + ",".join(columns) + ") VALUES (" + ",".join(fragments) + ")"
    return sql, tuple(bound)
