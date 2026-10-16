"""Immutable repository scope metadata; no credentials, connections or remote writes.

Scope is an explicit repository argument, never inferred from a fund code or
display text. The only acceptance writer currently authorized by the repository
remains the exact fixture in an exclusively owned local database.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
import json
import re
import sqlite3


ROOTS = {
    "evidence": ("evidence_snapshots", "evidence_id"),
    "holding": ("holding_versions", "holding_version"),
    "policy": ("portfolio_policy_versions", "policy_version"),
    "decision": ("decision_snapshots", "decision_id"),
}
SCOPE_TABLE = "v8_repository_scopes"
RECORD_TABLE = "v8_record_scopes"
SCOPE_TABLES = (SCOPE_TABLE, RECORD_TABLE)
NAMESPACE = re.compile(r"v9-acceptance-[a-z0-9-]{1,48}\Z", re.ASCII)


@dataclass(frozen=True)
class RepositoryScope:
    purpose: str
    namespace: str | None = None

    def __post_init__(self):
        if self.purpose == "production" and self.namespace is None:
            return
        if self.purpose == "acceptance" and isinstance(self.namespace, str) and NAMESPACE.fullmatch(self.namespace):
            return
        raise ValueError("invalid repository scope")

    @property
    def key(self) -> str:
        return "production" if self.purpose == "production" else "acceptance:" + self.namespace


PRODUCTION = RepositoryScope("production")


def acceptance_scope(namespace: str) -> RepositoryScope:
    return RepositoryScope("acceptance", namespace)


def validate_scope(scope: RepositoryScope) -> RepositoryScope:
    if type(scope) is not RepositoryScope:
        raise ValueError("invalid repository scope")
    # Revalidate rather than trusting construction or a modified frozen object.
    RepositoryScope(scope.purpose, scope.namespace)
    return scope


_SCOPE_DDL = """CREATE TABLE IF NOT EXISTS v8_repository_scopes (
  scope_key TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('production','acceptance')),
  namespace TEXT,
  CHECK((purpose='production' AND scope_key='production' AND namespace IS NULL)
    OR (purpose='acceptance' AND scope_key='acceptance:'||namespace
      AND namespace IS NOT NULL AND length(namespace) BETWEEN 15 AND 62
      AND substr(namespace,1,14)='v9-acceptance-'
      AND substr(namespace,15) NOT GLOB '*[^a-z0-9-]*'))
)"""
_RECORD_DDL = """CREATE TABLE IF NOT EXISTS v8_record_scopes (
  record_kind TEXT NOT NULL CHECK(record_kind IN ('evidence','holding','policy','decision')),
  record_id TEXT NOT NULL CHECK(length(record_id)>0),
  scope_key TEXT NOT NULL REFERENCES v8_repository_scopes(scope_key) ON DELETE RESTRICT,
  PRIMARY KEY(record_kind,record_id)
)"""


def _registered(kind: str, column: str) -> str:
    return ("EXISTS (SELECT 1 FROM v8_record_scopes scope_record "
            f"WHERE scope_record.record_kind='{kind}' AND scope_record.record_id={column} "
            "AND scope_record.scope_key='production')")


def schema_statements() -> tuple[str, ...]:
    statements = [_SCOPE_DDL, _RECORD_DDL,
                  "CREATE INDEX IF NOT EXISTS idx_v8_record_scope ON v8_record_scopes(scope_key,record_kind,record_id)"]
    existence = " OR ".join(
        f"(NEW.record_kind='{kind}' AND EXISTS (SELECT 1 FROM {table} WHERE {column}=NEW.record_id))"
        for kind, (table, column) in ROOTS.items()
    )
    statements.append("CREATE TRIGGER IF NOT EXISTS scoped_record_requires_root "
                      f"BEFORE INSERT ON {RECORD_TABLE} WHEN NOT ({existence}) "
                      "BEGIN SELECT RAISE(ABORT, 'scope root missing'); END")
    for kind, (table, column) in ROOTS.items():
        conditions = [_registered(kind, "r." + column)]
        if kind == "policy":
            statements.append("""CREATE VIEW IF NOT EXISTS production_portfolio_policy_versions AS
              WITH RECURSIVE production_chain(policy_version) AS (
                SELECT p.policy_version FROM portfolio_policy_versions p
                JOIN v8_record_scopes s ON s.record_kind='policy' AND s.record_id=p.policy_version
                WHERE p.supersedes IS NULL AND s.scope_key='production'
                UNION
                SELECT child.policy_version FROM portfolio_policy_versions child
                JOIN v8_record_scopes s ON s.record_kind='policy' AND s.record_id=child.policy_version
                JOIN production_chain parent ON parent.policy_version=child.supersedes
                WHERE s.scope_key='production'
              ) SELECT r.*,r.rowid AS rowid FROM portfolio_policy_versions r
                JOIN production_chain pc ON pc.policy_version=r.policy_version""")
            continue
        if kind == "decision":
            conditions.extend(_registered(parent, "r." + ROOTS[parent][1])
                              for parent in ("evidence", "holding", "policy"))
            conditions.append("EXISTS (SELECT 1 FROM production_portfolio_policy_versions p WHERE p.policy_version=r.policy_version)")
        statements.append(f"CREATE VIEW IF NOT EXISTS production_{table} AS SELECT r.*,r.rowid AS rowid FROM {table} r "
                          "WHERE " + " AND ".join(conditions))
    for table, parent_table, child_column, parent_column in (
        ("source_health_events", "evidence_snapshots", "evidence_id", "evidence_id"),
        ("outcome_evaluations", "decision_snapshots", "decision_id", "decision_id"),
        ("notification_events", "decision_snapshots", "decision_id", "decision_id"),
        ("portfolio_outcome_evaluations", "portfolio_decision_snapshots", "portfolio_decision_id", "portfolio_decision_id"),
    ):
        statements.append(f"CREATE VIEW IF NOT EXISTS production_{table} AS SELECT r.*,r.rowid AS rowid FROM {table} r "
                          f"JOIN production_{parent_table} parent ON parent.{parent_column}=r.{child_column}")
    statements.append("""CREATE VIEW IF NOT EXISTS production_portfolio_decision_snapshots AS
      SELECT r.*,r.rowid AS rowid FROM portfolio_decision_snapshots r
      JOIN production_portfolio_policy_versions p ON p.policy_version=r.policy_version
      WHERE json_valid(r.components_json)
        AND json_type(CASE WHEN json_valid(r.components_json) THEN r.components_json ELSE 'null' END)='array'
        AND json_array_length(CASE WHEN json_valid(r.components_json) THEN r.components_json ELSE '[]' END)=r.component_count
        AND NOT EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(r.components_json) THEN r.components_json ELSE '[]' END) component
          LEFT JOIN production_decision_snapshots d ON d.decision_id=json_extract(CASE WHEN component.type='object' THEN component.value ELSE '{}' END,'$.decision_id')
          WHERE component.type<>'object' OR d.decision_id IS NULL
            OR d.evidence_id IS NOT json_extract(CASE WHEN component.type='object' THEN component.value ELSE '{}' END,'$.evidence_id')
            OR d.holding_version IS NOT json_extract(CASE WHEN component.type='object' THEN component.value ELSE '{}' END,'$.holding_version')
            OR d.fund_code IS NOT json_extract(CASE WHEN component.type='object' THEN component.value ELSE '{}' END,'$.fund_code')
            OR d.policy_version<>r.policy_version OR d.strategy_version<>r.strategy_version
        )""")
    return tuple(statements)


VIEW_TABLES = frozenset((*[item[0] for item in ROOTS.values()], "source_health_events",
                        "outcome_evaluations", "notification_events", "portfolio_decision_snapshots",
                        "portfolio_outcome_evaluations"))


def production_table(table: str) -> str:
    return "production_" + table if table in VIEW_TABLES else table


def model_query(table: str, id_column: str, identifier: str, scope: RepositoryScope):
    scope = validate_scope(scope)
    if scope == PRODUCTION:
        return f"SELECT payload_json FROM {production_table(table)} WHERE {id_column}=?", (identifier,)
    kind = next((key for key, value in ROOTS.items() if value == (table, id_column)), None)
    if kind is None:
        raise ValueError("acceptance derived reads are forbidden")
    return (f"SELECT r.payload_json FROM {table} r JOIN {RECORD_TABLE} s ON s.record_kind=? "
            f"AND s.record_id=r.{id_column} WHERE r.{id_column}=? AND s.scope_key=?",
            (kind, identifier, scope.key))


def policy_tips_query(scope: RepositoryScope):
    scope = validate_scope(scope)
    table = production_table(ROOTS["policy"][0]) if scope == PRODUCTION else ROOTS["policy"][0]
    return (f"SELECT p.payload_json FROM {table} p JOIN {RECORD_TABLE} ps "
            "ON ps.record_kind='policy' AND ps.record_id=p.policy_version "
            "WHERE ps.scope_key=? AND NOT EXISTS (SELECT 1 FROM portfolio_policy_versions child "
            f"JOIN {RECORD_TABLE} cs ON cs.record_kind='policy' AND cs.record_id=child.policy_version "
            "WHERE child.supersedes=p.policy_version AND cs.scope_key=?)", (scope.key, scope.key))


def schema_errors(conn) -> list[str]:
    # Verify view predicates and scope triggers, not merely object names.
    reference = sqlite3.connect(":memory:")
    try:
        for statement in schema_statements():
            reference.execute(statement)
        for table in SCOPE_TABLES:
            for operation in ("update", "delete"):
                reference.execute(f"CREATE TRIGGER immutable_{table}_{operation} BEFORE {operation} ON {table} "
                                  f"BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END")
        expected = {(row[0], row[1]): row[2] for row in reference.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")}
    finally:
        reference.close()
    actual = {(row[0], row[1]): row[2] for row in conn.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")}
    def normalized(sql):
        parts = re.split(r"('(?:''|[^'])*'|\"(?:\"\"|[^\"])*\")", sql.strip().rstrip(";"))
        return "".join(re.sub(r"\s+", " ", re.sub(r"\bIF\s+NOT\s+EXISTS\b", "", part,
                       flags=re.IGNORECASE)).lower() if index % 2 == 0 else part
                       for index, part in enumerate(parts))
    return [f"{name} scope definition mismatch" for (kind, name), sql in expected.items()
            if (kind, name) not in actual or normalized(actual[kind, name]) != normalized(sql)]


def assert_record_scope(conn, kind: str, identifier: str, scope: RepositoryScope) -> None:
    scope = validate_scope(scope)
    table, column = ROOTS[kind]
    row = conn.execute(f"SELECT scope_key FROM {RECORD_TABLE} WHERE record_kind=? AND record_id=?",
                       (kind, identifier)).fetchone()
    if row is not None:
        if row[0] != scope.key:
            raise ValueError("repository cross-scope write forbidden")
    elif conn.execute(f"SELECT 1 FROM {table} WHERE {column}=?", (identifier,)).fetchone():
        raise ValueError("repository record scope missing")


def register_record(conn, kind: str, identifier: str, scope: RepositoryScope) -> None:
    scope = validate_scope(scope)
    if kind not in ROOTS:
        raise ValueError("invalid repository record kind")
    existing = conn.execute(f"SELECT scope_key FROM {RECORD_TABLE} WHERE record_kind=? AND record_id=?",
                            (kind, identifier)).fetchone()
    if existing is not None and existing[0] != scope.key:
        raise ValueError("repository cross-scope write forbidden")
    conn.execute(f"INSERT INTO {SCOPE_TABLE}(scope_key,purpose,namespace) VALUES(?,?,?) ON CONFLICT(scope_key) DO NOTHING",
                 (scope.key, scope.purpose, scope.namespace))
    conn.execute(f"INSERT INTO {RECORD_TABLE}(record_kind,record_id,scope_key) VALUES(?,?,?) ON CONFLICT(record_kind,record_id) DO NOTHING",
                 (kind, identifier, scope.key))


def _reserved(payload: dict) -> bool:
    def reserved(value):
        return isinstance(value, str) and value.startswith(("local-persistence:", "synthetic:",
                "fund_detail:local-persistence:", "estimate:local-persistence:"))
    if any(reserved(payload.get(field)) for field in ("source", "account")):
        return True
    if any(payload.get(field) == "local-acceptance-v1" for field in ("score_version", "strategy_version", "estimate_model_version")):
        return True
    return any(isinstance(item, dict) and reserved(item.get("source_id"))
               for field in ("source_states", "evidence_nodes") for item in payload.get(field, ()))


def _validate_legacy_lineages(conn) -> None:
    """Migration-only model/lineage checks before any new scope is committed."""
    from models.v8 import (EvidenceSnapshot, HoldingVersion, PortfolioPolicy, DecisionSnapshot,
                           PortfolioDecisionSnapshot, OutcomeEvaluation, PortfolioOutcomeEvaluation,
                           NotificationEvent, SourceState, canonical_json, payload_sha256, stable_id)
    root_models = dict(evidence=EvidenceSnapshot, holding=HoldingVersion, policy=PortfolioPolicy, decision=DecisionSnapshot)
    roots = {kind: {row[column]: root_models[kind].model_validate_json(row["payload_json"])
                    for row in conn.execute(f"SELECT {column},payload_json FROM {table}")}
             for kind, (table, column) in ROOTS.items()}
    policies = roots["policy"]
    if len([p for p in policies.values() if p.supersedes is None]) > 1:
        raise ValueError("multiple legacy policy roots")
    children = {}
    visited = set()
    for policy in policies.values():
        pending, current = set(), policy
        while current.policy_version not in visited:
            if current.policy_version in pending:
                raise ValueError("legacy policy cycle")
            pending.add(current.policy_version)
            if current.supersedes is None:
                break
            parent = policies.get(current.supersedes)
            if parent is None or parent.effective_at >= current.effective_at or parent.created_at > current.created_at:
                raise ValueError("legacy policy predecessor mismatch")
            current = parent
        visited.update(pending)
        if policy.supersedes:
            children[policy.supersedes] = children.get(policy.supersedes, 0) + 1
    if any(count > 1 for count in children.values()):
        raise ValueError("legacy policy fork")
    for decision in roots["decision"].values():
        evidence = roots["evidence"].get(decision.evidence_id)
        holding = roots["holding"].get(decision.holding_version)
        policy = policies.get(decision.policy_version)
        if (evidence is None or holding is None or policy is None
                or decision.fund_code != evidence.fund_code or decision.fund_code != holding.fund_code
                or decision.user_state != holding.user_state
                or evidence.created_at > decision.created_at
                or (evidence.market_time is not None and evidence.market_time > decision.created_at)
                or holding.created_at > decision.created_at
                or (holding.updated_at is not None and holding.updated_at > decision.created_at)
                or policy.created_at > decision.created_at or policy.effective_at > decision.created_at):
            raise ValueError("legacy decision lineage mismatch")
    derived_models = {
        "portfolio_decision_snapshots": PortfolioDecisionSnapshot, "outcome_evaluations": OutcomeEvaluation,
        "portfolio_outcome_evaluations": PortfolioOutcomeEvaluation, "notification_events": NotificationEvent,
        "source_health_events": SourceState,
    }
    portfolios = {}
    actual_source_events = set()
    for table, model_type in derived_models.items():
        for raw in conn.execute("SELECT * FROM " + table):
            row = dict(raw)
            payload_column = "detail_json" if table == "notification_events" else "payload_json"
            model = model_type.model_validate_json(row[payload_column])
            payload = model.model_dump(mode="python")
            if canonical_json(json.loads(row[payload_column])) != canonical_json(payload) or _reserved(payload):
                raise ValueError("legacy derived payload mismatch")
            for name, value in row.items():
                if name == payload_column:
                    continue
                model_name = name.removesuffix("_json") if name.endswith("_json") else name
                if model_name not in payload:
                    continue
                expected = payload[model_name]
                actual = json.loads(value) if name.endswith("_json") and value is not None else value
                if isinstance(expected, datetime) and isinstance(actual, str):
                    actual = datetime.fromisoformat(actual)
                if isinstance(expected, bool) and type(actual) is int and actual in (0, 1):
                    actual = bool(actual)
                if canonical_json(actual) != canonical_json(expected):
                    raise ValueError("legacy derived projection mismatch")
            if table == "portfolio_decision_snapshots":
                identity = {k: v for k, v in payload.items() if k not in {"portfolio_decision_id", "created_at"}}
                if row["portfolio_decision_id"] != stable_id("pdec", identity) or row["component_count"] != len(model.components):
                    raise ValueError("legacy portfolio identity mismatch")
                if model.policy_version not in policies:
                    raise ValueError("legacy portfolio policy missing")
                for component in model.components:
                    decision = roots["decision"].get(component.decision_id)
                    if (decision is None or decision.evidence_id != component.evidence_id
                            or decision.holding_version != component.holding_version or decision.fund_code != component.fund_code
                            or decision.policy_version != model.policy_version or decision.strategy_version != model.strategy_version
                            or decision.action != component.action or decision.created_at > model.created_at):
                        raise ValueError("legacy portfolio lineage mismatch")
                    holding = roots["holding"][decision.holding_version]
                    current = 0.0 if holding.user_state == "unheld" else holding.current_weight
                    guidance = decision.position_guidance
                    if (current is None or abs(component.current_weight - current) > 1e-9
                            or guidance is None or guidance.target_weight is None
                            or abs(component.target_weight - guidance.target_weight) > 1e-9):
                        raise ValueError("legacy portfolio weight lineage mismatch")
                latest_date = max(roots["decision"][component.decision_id].created_at.astimezone(
                    timezone(timedelta(hours=8))).date() for component in model.components)
                if model.decision_date != latest_date:
                    raise ValueError("legacy portfolio date lineage mismatch")
                portfolios[model.portfolio_decision_id] = model
            elif table == "outcome_evaluations":
                identity = {k: payload[k] for k in ("decision_id", "evaluation_kind", "horizon", "evaluation_date")}
                if model.decision_id not in roots["decision"] or model.outcome_id != stable_id("out", identity):
                    raise ValueError("legacy outcome lineage mismatch")
            elif table == "portfolio_outcome_evaluations":
                identity = {k: payload[k] for k in ("portfolio_decision_id", "horizon", "evaluation_date")}
                if model.portfolio_decision_id not in portfolios or model.outcome_id != stable_id("pout", identity):
                    raise ValueError("legacy portfolio outcome lineage mismatch")
            elif table == "notification_events":
                event_identity = {k: payload[k] for k in ("decision_id", "scheduled_window")}
                log_identity = {k: payload[k] for k in ("notification_event_id", "status", "attempt_no", "natural_schedule")}
                if (model.decision_id not in roots["decision"] or model.notification_event_id != stable_id("ntf", event_identity)
                        or model.event_log_id != stable_id("ntl", log_identity)):
                    raise ValueError("legacy notification lineage mismatch")
            else:
                evidence = roots["evidence"].get(row["evidence_id"])
                identity = dict(evidence_id=row["evidence_id"], source_id=model.source_id, state=payload)
                if (evidence is None or model not in evidence.source_states or row["event_id"] != stable_id("src", identity)
                        or datetime.fromisoformat(row["observed_at"]) != evidence.created_at):
                    raise ValueError("legacy source health lineage mismatch")
                actual_source_events.add((row["evidence_id"], model.source_id, row["event_id"]))
            if "payload_sha256" in row:
                semantic = identity if table == "portfolio_decision_snapshots" else {k: v for k, v in payload.items() if k != "created_at"}
                if row["payload_sha256"] != payload_sha256(semantic):
                    raise ValueError("legacy derived digest mismatch")
    expected_source_events = {
        (evidence.evidence_id, state.source_id, stable_id("src", dict(
            evidence_id=evidence.evidence_id, source_id=state.source_id, state=state.model_dump(mode="python"))))
        for evidence in roots["evidence"].values() for state in evidence.source_states
    }
    if actual_source_events != expected_source_events:
        raise ValueError("legacy source health population mismatch")


def backfill_legacy_production(conn, *, allow_legacy: bool) -> None:
    """Called inside the existing local migration transaction; never rewrites payloads.

    Marked fixtures are never reclassified or silently repaired. New fixtures
    are registered by their already guarded repository writes.
    """
    from models.v8 import (EvidenceSnapshot, HoldingVersion, PortfolioPolicy, DecisionSnapshot,
                           canonical_json, payload_sha256, stable_id)
    models = dict(evidence=EvidenceSnapshot, holding=HoldingVersion, policy=PortfolioPolicy, decision=DecisionSnapshot)
    prefixes = dict(evidence="ev", holding="hold", policy="pol", decision="dec")
    conn.execute(f"INSERT INTO {SCOPE_TABLE}(scope_key,purpose,namespace) VALUES('production','production',NULL) ON CONFLICT(scope_key) DO NOTHING")
    marked = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_persistence_acceptance_v1'").fetchone()
    migrated_records = False
    for kind, (table, column) in ROOTS.items():
        rows = conn.execute(f"SELECT r.* FROM {table} r LEFT JOIN {RECORD_TABLE} s "
                            f"ON s.record_kind=? AND s.record_id=r.{column} WHERE s.record_id IS NULL", (kind,)).fetchall()
        if rows and marked:
            raise sqlite3.DatabaseError("legacy acceptance scope migration requires a new isolated fixture")
        if rows and not allow_legacy:
            raise sqlite3.DatabaseError("repository root scope metadata missing; explicit repair required")
        for row in rows:
            try:
                row = dict(row)
                payload = json.loads(row["payload_json"])
                if type(payload) is not dict or payload.get(column) != row[column] or _reserved(payload):
                    raise ValueError()
                model = models[kind].model_validate(payload).model_dump(mode="python")
                if canonical_json(payload) != canonical_json(model):
                    raise ValueError()
                semantic = {key: value for key, value in model.items() if key != "created_at" and (kind == "decision" or key != column)}
                identity = {key: model[key] for key in ("fund_code", "evidence_id", "holding_version", "policy_version", "strategy_version")} if kind == "decision" else semantic
                if row[column] != stable_id(prefixes[kind], identity) or row["payload_sha256"] != payload_sha256(semantic):
                    raise ValueError()
                for name, value in row.items():
                    model_name = name.removesuffix("_json") if name.endswith("_json") else name
                    model_name = {"invalidation": "invalidation_conditions"}.get(model_name, model_name)
                    if model_name not in model:
                        continue
                    projected = json.loads(value) if name.endswith("_json") and value is not None else value
                    expected = model[model_name]
                    if isinstance(expected, datetime) and isinstance(projected, str):
                        projected = datetime.fromisoformat(projected)
                    if canonical_json(projected) != canonical_json(expected):
                        raise ValueError()
            except (ValueError, TypeError, OverflowError):
                raise sqlite3.DatabaseError("legacy root scope cannot be classified safely") from None
            register_record(conn, kind, row[column], PRODUCTION)
            migrated_records = True
    if migrated_records:
        try:
            _validate_legacy_lineages(conn)
        except (ValueError, TypeError, KeyError, OverflowError):
            raise sqlite3.DatabaseError("legacy scope lineage cannot be classified safely") from None


def verify_local_population(conn, namespace: str) -> None:
    expected = acceptance_scope(namespace)
    scopes = conn.execute(f"SELECT scope_key,purpose,namespace FROM {SCOPE_TABLE}").fetchall()
    expected_records = {(kind, row[0], expected.key)
                        for kind, (table, column) in ROOTS.items()
                        for row in conn.execute(f"SELECT {column} FROM {table}").fetchall()}
    actual = {tuple(row) for row in conn.execute(f"SELECT record_kind,record_id,scope_key FROM {RECORD_TABLE}")}
    if actual != expected_records:
        raise ValueError("acceptance record scope mismatch")
    expected_scopes = {(PRODUCTION.key, PRODUCTION.purpose, None)}
    if expected_records:
        expected_scopes.add((expected.key, expected.purpose, namespace))
    if {tuple(row) for row in scopes} != expected_scopes:
        raise ValueError("unexpected acceptance scope metadata")
