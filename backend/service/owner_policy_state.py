"""Bounded single-connection local Policy observations, without initialization.

Policy payloads and identifiers are never rewritten. UTC ordering happens only
in the read projection, including legitimate non-UTC direct-model SQL columns.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import re
import sqlite3
import time
from typing import Callable

from database import db
from database.owner_sync_schema import _local_connection
from models.v8 import OwnerPolicyState, PortfolioPolicy, canonical_json, payload_sha256, stable_id
from service import repository_scopes as scopes

MAX_POLICY_VERSIONS = 1000
MAX_POLICY_BYTES = 2 * 1024 * 1024
TOTAL_SECONDS = 12.0
_COLUMNS = ("policy_version", "name", "target_allocations_json", "target_ranges_json",
            "max_single_fund_weight", "max_theme_weight", "rebalance_band", "dca_rules_json",
            "reduce_rules_json", "sell_rules_json", "effective_at", "created_at", "source",
            "supersedes", "payload_json", "payload_sha256")
_JSON_COLUMNS = frozenset({"target_allocations_json", "target_ranges_json", "dca_rules_json",
                           "reduce_rules_json", "sell_rules_json", "payload_json"})
_REAL_COLUMNS = frozenset({"max_single_fund_weight", "max_theme_weight", "rebalance_band"})
_MESSAGES = {
    "policy_state_unavailable": "策略版本状态无法安全核对。",
    "policy_state_capacity_exhausted": "策略版本历史超过本次读取容量，历史未被截断。",
    "policy_state_timeout": "策略版本核对未在本次预算内完成。",
}


class OwnerPolicyReadError(RuntimeError):
    def __init__(self, code: str = "policy_state_unavailable"):
        self.code = code if code in _MESSAGES else "policy_state_unavailable"
        self.status = 503
        super().__init__(_MESSAGES[self.code])


class _CallbackFailure(Exception):
    def __init__(self, original: Exception):
        self.original = original


def _ddl(value: str) -> str:
    parts = re.split(r"('(?:''|[^'])*'|\"(?:\"\"|[^\"])*\")", value.strip().rstrip(";"))
    return "".join(re.sub(r"\s+", " ", re.sub(r"\bIF\s+NOT\s+EXISTS\b", "", part,
        flags=re.IGNORECASE)).lower() if i % 2 == 0 else part for i, part in enumerate(parts))


def _schema(conn) -> None:
    _local_connection(conn)
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1 or conn.execute("PRAGMA user_version").fetchone()[0] != 9:
        raise OwnerPolicyReadError()
    required = {}
    selected = {"portfolio_policy_versions", scopes.SCOPE_TABLE, scopes.RECORD_TABLE,
                "idx_v8_record_scope", "scoped_record_requires_root", "production_portfolio_policy_versions"}
    for statement in db.V8_SCHEMA_STATEMENTS:
        match = re.match(r"\s*CREATE\s+(TABLE|VIEW|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)", statement, re.IGNORECASE)
        if match and match[2] in selected:
            required[(match[1].lower(), match[2])] = statement
    for table in ("portfolio_policy_versions", *scopes.SCOPE_TABLES):
        for operation in ("update", "delete"):
            required[("trigger", f"immutable_{table}_{operation}")] = (
                f"CREATE TRIGGER immutable_{table}_{operation} BEFORE {operation.upper()} ON {table} "
                f"BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END"
            )
    if len(required) != 12:
        raise OwnerPolicyReadError()
    for (kind, name), expected in required.items():
        row = conn.execute("SELECT CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=16384 "
                           "THEN sql ELSE NULL END FROM sqlite_master WHERE type=? AND name=?", (kind, name)).fetchone()
        if row is None or row[0] is None or _ddl(row[0]) != _ddl(expected):
            raise OwnerPolicyReadError()


def _decoded(raw: str):
    if type(raw) is not str or len(raw.encode("utf-8", errors="strict")) > MAX_POLICY_BYTES:
        raise OwnerPolicyReadError()
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise OwnerPolicyReadError()
            out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(OwnerPolicyReadError()))


def _instant(value) -> datetime:
    if type(value) is not str or len(value) > 128:
        raise OwnerPolicyReadError()
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise OwnerPolicyReadError()
    return parsed.astimezone(timezone.utc)


def _model(row, observed: datetime, scope) -> PortfolioPolicy:
    values = dict(zip(_COLUMNS, row[:-1]))
    if row[-1] != 1:
        raise OwnerPolicyReadError()
    model = PortfolioPolicy.model_validate(_decoded(values["payload_json"]))
    if canonical_json(model) != values["payload_json"]:
        raise OwnerPolicyReadError()
    identity = {key: value for key, value in model.model_dump(mode="python").items()
                if key not in {"policy_version", "created_at"}}
    if (model.policy_version != values["policy_version"] or model.policy_version != stable_id("pol", identity)
            or values["payload_sha256"] != payload_sha256(identity) or model.created_at > observed
            or scope == scopes.PRODUCTION and scopes._reserved(model.model_dump(mode="python"))):
        raise OwnerPolicyReadError()
    for column in _COLUMNS:
        if column in {"payload_json", "payload_sha256"}:
            continue
        field = column.removesuffix("_json")
        expected, actual = getattr(model, field), values[column]
        if column in _JSON_COLUMNS:
            if canonical_json(expected) != actual:
                raise OwnerPolicyReadError()
        elif column in _REAL_COLUMNS:
            if expected is None:
                if actual is not None:
                    raise OwnerPolicyReadError()
            elif type(actual) not in (int, float) or not math.isfinite(actual) or actual != expected:
                raise OwnerPolicyReadError()
        elif column in {"effective_at", "created_at"}:
            if _instant(actual) != expected:
                raise OwnerPolicyReadError()
        elif type(actual) is not type(expected) or actual != expected:
            raise OwnerPolicyReadError()
    return model


def _read_chain(conn, observed: datetime, scope, check) -> list[PortfolioPolicy]:
    _schema(conn); check()
    metadata = conn.execute("SELECT COUNT(*),COALESCE(MAX(CASE WHEN purpose=? AND namespace IS ? THEN 1 ELSE 0 END),0) "
        "FROM v8_repository_scopes WHERE scope_key=?", (scope.purpose, scope.namespace, scope.key)).fetchone()
    if tuple(metadata) != (1, 1):
        raise OwnerPolicyReadError()
    table = "production_portfolio_policy_versions" if scope == scopes.PRODUCTION else "portfolio_policy_versions"
    filtered = f"FROM {table} p JOIN v8_record_scopes s ON s.record_kind='policy' AND s.record_id=p.policy_version WHERE s.scope_key=?"
    text_columns = [column for column in _COLUMNS if column not in _REAL_COLUMNS]
    lengths = "+".join(f"COALESCE(length(CAST(p.{column} AS BLOB)),0)" for column in text_columns)
    counts = conn.execute(f"SELECT COUNT(*),COALESCE(SUM(length(CAST(p.payload_json AS BLOB))),0),COALESCE(SUM({lengths}),0) " + filtered,
        (scope.key,)).fetchone()
    if counts[0] > MAX_POLICY_VERSIONS or counts[1] > MAX_POLICY_BYTES or counts[2] > 2 * MAX_POLICY_BYTES:
        raise OwnerPolicyReadError("policy_state_capacity_exhausted")
    # A production view must not silently hide a same-scope orphan/cycle or a
    # missing root registration. Only bounded booleans/counts leave these checks.
    raw_count = conn.execute("SELECT COUNT(*) FROM portfolio_policy_versions p JOIN v8_record_scopes s "
        "ON s.record_kind='policy' AND s.record_id=p.policy_version WHERE s.scope_key=?", (scope.key,)).fetchone()[0]
    if counts[0] != raw_count or conn.execute("SELECT 1 FROM portfolio_policy_versions p WHERE NOT EXISTS "
        "(SELECT 1 FROM v8_record_scopes s WHERE s.record_kind='policy' AND s.record_id=p.policy_version) LIMIT 1").fetchone():
        raise OwnerPolicyReadError()
    if conn.execute("SELECT 1 FROM v8_record_scopes s WHERE s.record_kind='policy' AND s.scope_key=? AND NOT EXISTS "
        "(SELECT 1 FROM portfolio_policy_versions p WHERE p.policy_version=s.record_id) LIMIT 1", (scope.key,)).fetchone():
        raise OwnerPolicyReadError()
    selections = []
    for column in _COLUMNS:
        if column in _REAL_COLUMNS:
            selections.append(f"CASE WHEN typeof(p.{column}) IN ('real','integer','null') THEN p.{column} ELSE NULL END")
        else:
            limit = MAX_POLICY_BYTES if column in _JSON_COLUMNS else (128 if column in {"effective_at", "created_at"} else 480)
            selections.append(f"CASE WHEN typeof(p.{column})='text' AND length(CAST(p.{column} AS BLOB))<={limit} "
                f"THEN p.{column} ELSE NULL END")
    type_guards = [f"typeof(p.{column}) IN ('real','integer','null')" for column in _REAL_COLUMNS]
    type_guards.append("(typeof(p.supersedes)='null' OR (typeof(p.supersedes)='text' AND length(CAST(p.supersedes AS BLOB))<=68))")
    selections.append("CASE WHEN " + " AND ".join(type_guards) + " THEN 1 ELSE 0 END")
    rows = conn.execute("SELECT " + ",".join(selections) + " " + filtered + " LIMIT ?", (scope.key, MAX_POLICY_VERSIONS + 1)).fetchmany(MAX_POLICY_VERSIONS + 1)
    if len(rows) != counts[0]:
        raise OwnerPolicyReadError()
    models = []
    for row in rows:
        check(); models.append(_model(row, observed, scope))
    by_id = {model.policy_version: model for model in models}
    if len(by_id) != len(models):
        raise OwnerPolicyReadError()
    children = {}
    roots = []
    for model in models:
        check()
        if model.supersedes is None:
            roots.append(model.policy_version)
        else:
            parent = by_id.get(model.supersedes)
            if (parent is None or model.effective_at <= parent.effective_at or model.created_at < parent.created_at
                    or model.supersedes in children):
                raise OwnerPolicyReadError()
            children[model.supersedes] = model.policy_version
    if models and (len(roots) != 1 or len(models) - len(children) != 1):
        raise OwnerPolicyReadError()
    seen = set()
    next_id = roots[0] if roots else None
    while next_id is not None:
        check()
        if next_id in seen:
            raise OwnerPolicyReadError()
        seen.add(next_id); next_id = children.get(next_id)
    if len(seen) != len(models):
        raise OwnerPolicyReadError()
    return sorted(models, key=lambda model: (model.effective_at.astimezone(timezone.utc),
                  model.created_at.astimezone(timezone.utc), model.policy_version), reverse=True)


def read_owner_policy_state(conn: sqlite3.Connection, *, observed_at: datetime | None = None,
                            before_return: Callable[[], None] | None = None,
                            scope=scopes.PRODUCTION) -> OwnerPolicyState:
    """Read one closed snapshot; never create a connection, default or schema."""
    active = False
    try:
        if not isinstance(conn, sqlite3.Connection) or conn.in_transaction:
            raise OwnerPolicyReadError()
        scope = scopes.validate_scope(scope)
        observed = observed_at if observed_at is not None else datetime.now(timezone.utc)
        if not isinstance(observed, datetime) or observed.tzinfo is None or observed.utcoffset() is None:
            raise OwnerPolicyReadError()
        observed = observed.astimezone(timezone.utc)
        start = last = time.monotonic()
        if not math.isfinite(start):
            raise OwnerPolicyReadError("policy_state_timeout")
        def budget():
            nonlocal last
            now = time.monotonic()
            if not math.isfinite(now) or now < last or now - start >= TOTAL_SECONDS:
                raise OwnerPolicyReadError("policy_state_timeout")
            last = now
        def check():
            budget()
            if before_return is not None:
                try:
                    before_return()
                except Exception as error:
                    raise _CallbackFailure(error) from None
            budget()
        check(); conn.execute("BEGIN"); active = True
        history = _read_chain(conn, observed, scope, check)
        current = next((model for model in history if model.effective_at <= observed), None)
        future = [model.effective_at.astimezone(timezone.utc) for model in history if model.effective_at > observed]
        snapshot = OwnerPolicyState(observed_at=observed, current=current,
            next_effective_at=min(future) if future else None, history=tuple(history))
        if len(canonical_json(snapshot).encode("utf-8")) > MAX_POLICY_BYTES:
            raise OwnerPolicyReadError("policy_state_capacity_exhausted")
        check(); conn.commit(); active = False; check()
        return snapshot
    except _CallbackFailure as error:
        if active:
            try:
                conn.rollback()
            except Exception:
                pass
        raise error.original from None
    except Exception as error:
        if active:
            try:
                conn.rollback()
            except Exception:
                pass
        if isinstance(error, OwnerPolicyReadError):
            raise
        raise OwnerPolicyReadError() from None
