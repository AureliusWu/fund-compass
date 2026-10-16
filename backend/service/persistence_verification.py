"""Local, isolated application-repository acceptance evidence.

Scope-aware production reads do not authorize remote acceptance writes. This
module still refuses remote connections and unmarked databases. Its fixture is
only written to a newly provisioned, tool-owned local database, never alongside
real holdings. Success is NOT an HTTP/Owner/Turso or formal durability proof.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import sqlite3

from database import db
from models.v8 import canonical_json, payload_sha256, stable_id
from service import v8_repo
from service import repository_scopes as scopes
from strategy.decision_v2 import (
    build_decision_snapshot, build_evidence_snapshot, build_holding_version,
    build_portfolio_policy,
)


MARKER_TABLE = "local_persistence_acceptance_v1"
NAMESPACE = re.compile(r"v9-acceptance-[a-z0-9-]{1,48}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
FIXTURE_TIME = datetime(2026, 9, 1, 6, 30, tzinfo=timezone.utc)
BOOT_ID = secrets.token_hex(16)
BOOT_STARTED_AT = datetime.now(timezone.utc).isoformat()
SOURCE_FILES = (
    "backend/database/db.py", "backend/models/v8.py",
    "backend/service/v8_repo.py", "backend/strategy/decision_v2.py",
    "backend/service/persistence_verification.py", "tools/persistence_candidate.py",
    "backend/service/repository_scopes.py",
)
CHAIN_TABLES = {
    "evidence": ("evidence_snapshots", "evidence_id"),
    "holding": ("holding_versions", "holding_version"),
    "policy": ("portfolio_policy_versions", "policy_version"),
    "decision": ("decision_snapshots", "decision_id"),
}
NOT_COVERED = [
    "production_http_owner_application_chain", "remote_turso_restart",
    "remote_pitr_or_provider_restore", "real_private_data_logical_export",
    "remote_uncertain_commit_and_reconciliation", "outcome_and_notification_delivery",
    "http_request_idempotency_and_conflict_contract",
]


class VerificationError(RuntimeError):
    """Allowlisted code; never include database values or provider errors."""


def _reserved_record(record) -> bool:
    """Recognize reserved provenance, not arbitrary names or financial values."""
    def reserved(value):
        return isinstance(value, str) and (
            value.startswith(("local-persistence:", "synthetic:"))
            or value.startswith(("fund_detail:local-persistence:", "estimate:local-persistence:"))
        )

    if record is None:
        return False
    if any(reserved(getattr(record, field, None)) for field in ("source", "account")):
        return True
    if any(getattr(record, field, None) == "local-acceptance-v1"
           for field in ("score_version", "strategy_version", "estimate_model_version")):
        return True
    return any(reserved(item.source_id) for field in ("source_states", "evidence_nodes")
               for item in getattr(record, field, ()))


def preflight_repository_write(candidate) -> None:
    # Direct reserved input must never open a provider connection. References
    # still require authoritative checks inside the repository transaction.
    if db.database_backend() != "sqlite" and _reserved_record(candidate):
        raise ValueError("local_acceptance_write_forbidden")


def guard_repository_write(conn, kind: str, candidate, *references, scope=scopes.PRODUCTION) -> None:
    """Same-transaction exclusive-fixture guard, not remote authorization.

    The sole exception is the existing exact four-record fixture in its marked
    exclusive local file. Ordinary remote writes add no marker-query requests.
    """
    scope = scopes.validate_scope(scope)
    reserved = any(_reserved_record(record) for record in (candidate, *references))
    if db.database_backend() != "sqlite":
        if reserved or scope != scopes.PRODUCTION:
            raise ValueError("local_acceptance_write_forbidden")
        return
    marked = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (MARKER_TABLE,),
    ).fetchone()
    if not marked:
        if reserved or scope != scopes.PRODUCTION:
            raise ValueError("local_acceptance_write_forbidden")
        return
    if kind not in CHAIN_TABLES:
        raise ValueError("local_acceptance_write_forbidden")
    try:
        path = _require_local(Path(db.DB_PATH))
        resources = conn.execute("PRAGMA database_list").fetchall()
        main = [row[2] for row in resources if row[1] == "main"]
        if len(main) != 1 or not main[0] or Path(main[0]).resolve(strict=True) != path:
            raise VerificationError("local_acceptance_resource_mismatch")
        rows = conn.execute(f"SELECT namespace FROM {MARKER_TABLE}").fetchall()
        if len(rows) != 1:
            raise VerificationError("isolated_database_namespace_mismatch")
        namespace = rows[0][0]
        if scope != scopes.acceptance_scope(namespace):
            raise VerificationError("local_acceptance_write_forbidden")
        _marker(conn, namespace)
        _check_population(conn, namespace)
        audit_schema(conn)
        _inspect_chain(conn, namespace, complete=False)
        if canonical_json(candidate) != canonical_json(fixture_chain(namespace)[kind]):
            raise VerificationError("local_acceptance_write_forbidden")
    except (VerificationError, sqlite3.Error, OSError, KeyError, TypeError, ValueError):
        # API writers already handle ValueError. Never expose resource paths,
        # marker contents, provider details, or schema text through that path.
        raise ValueError("local_acceptance_write_forbidden") from None


def _check_namespace(namespace: str) -> None:
    if not isinstance(namespace, str) or not NAMESPACE.fullmatch(namespace):
        raise VerificationError("invalid_acceptance_namespace")


def _require_local(path: Path) -> Path:
    if db.database_backend() != "sqlite" or str(db.DB_PATH).startswith("file:"):
        raise VerificationError("local_sqlite_only")
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved != Path(db.DB_PATH).resolve(strict=True):
        raise VerificationError("configured_resource_mismatch")
    return resolved


def source_fingerprint() -> str:
    root = Path(__file__).resolve().parents[2]
    return payload_sha256({
        name: hashlib.sha256((root / name).read_bytes()).hexdigest()
        for name in SOURCE_FILES
    })


def resource_fingerprint(path: Path, namespace: str) -> str:
    # The absolute path itself is never included in emitted evidence.
    return payload_sha256({"engine": "sqlite", "path": str(path.resolve()),
                           "namespace": namespace})


def _read_only(path: Path):
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA query_only=ON")
    return conn


def _normalized_sql(sql: str) -> str:
    return re.sub(r"\s+", " ", re.sub(
        r"\bIF\s+NOT\s+EXISTS\b", "", sql, flags=re.IGNORECASE,
    )).strip().rstrip(";").upper()


def audit_schema(conn) -> dict:
    """Read-only structural checks, not a restore or data-retention claim."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version != db.V8_SCHEMA_VERSION or db._v8_schema_contract_errors(conn):
        raise VerificationError("schema_contract_mismatch")
    for check in ("quick_check(1)", "integrity_check(1)"):
        if conn.execute("PRAGMA " + check).fetchone()[0] != "ok":
            raise VerificationError("database_integrity_failed")
    if conn.execute("PRAGMA foreign_key_check").fetchall():
        raise VerificationError("foreign_key_integrity_failed")
    triggers = {
        row["name"]: (row["tbl_name"], row["sql"])
        for row in conn.execute(
            "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'",
        )
    }
    for table in db.V8_IMMUTABLE_TABLES:
        for operation in ("update", "delete"):
            name = f"immutable_{table}_{operation}"
            expected = (
                f"CREATE TRIGGER {name} BEFORE {operation} ON {table} "
                f"BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END"
            )
            stored = triggers.get(name)
            if not stored or stored[0] != table or _normalized_sql(stored[1]) != _normalized_sql(expected):
                raise VerificationError("immutable_trigger_mismatch")
    objects = [dict(row) for row in conn.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )]
    return {"schema_version": version, "schema_sha256": payload_sha256(objects),
            "integrity_verified": True, "immutable_triggers_verified": True}


def _marker(conn, namespace: str) -> dict:
    _check_namespace(namespace)
    if not conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (MARKER_TABLE,),
    ).fetchone():
        raise VerificationError("isolated_database_marker_required")
    rows = conn.execute(f"SELECT * FROM {MARKER_TABLE}").fetchall()
    if len(rows) != 1 or rows[0]["namespace"] != namespace:
        raise VerificationError("isolated_database_namespace_mismatch")
    row = dict(rows[0])
    if row["source_sha256"] != source_fingerprint():
        raise VerificationError("source_code_drift")
    return row


def _check_population(conn, namespace: str) -> None:
    allowed = {value[0] for value in CHAIN_TABLES.values()} | {"source_health_events", MARKER_TABLE, *scopes.SCOPE_TABLES}
    for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        table = row[0]
        if table.startswith("sqlite_"):
            continue
        quoted = '"' + table.replace('"', '""') + '"'
        count = conn.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
        if table not in allowed and count:
            raise VerificationError("non_acceptance_data_present")
        if table in {value[0] for value in CHAIN_TABLES.values()} and count > 1:
            raise VerificationError("non_acceptance_data_present")
    try:
        scopes.verify_local_population(conn, namespace)
    except ValueError:
        raise VerificationError("non_acceptance_data_present") from None


def fixture_chain(namespace: str) -> dict:
    _check_namespace(namespace)
    source = "local-persistence:" + namespace
    detail = {
        "code": "999999", "name": "本地隔离验收合成基金", "type": "指数型",
        "latest_nav": 1.0, "latest_nav_date": "2026-08-31", "source": source,
        "updated_at": FIXTURE_TIME.isoformat(),
        "decision_context": {
            "status": "fresh", "source": source, "source_time": FIXTURE_TIME.isoformat(),
            "source_time_precision": "datetime", "base_nav": 1.0,
            "base_nav_date": "2026-08-31", "estimate_change": 1.0,
        },
    }
    evidence = build_evidence_snapshot(
        detail,
        {"score": 80, "score_version": "local-acceptance-v1", "coverage": 1.0,
         "components": {"risk": {"detail": {"max_drawdown": -10, "volatility": 12}}}},
        {"signal": "持有", "signal_version": "local-acceptance-v1", "coverage": 1.0,
         "layers": {"valuation": {"label": "低估", "percentile": 20, "source": source},
                    "trend": {"label": "上升趋势"}, "sentiment": {"label": "中性"}}},
        {"available": True}, created_at=FIXTURE_TIME,
    )
    holding = build_holding_version(
        "999999", is_held=True, shares=100.0, cost=None, market_value=100.0,
        account="synthetic:" + namespace, current_weight=20, target_weight=20,
        source=source, created_at=FIXTURE_TIME,
    )
    policy = build_portfolio_policy(
        name="本地隔离验收策略", target_allocations={"999999": 20},
        target_ranges={"999999": (18, 22)}, max_single_fund_weight=40,
        source=source, effective_at=FIXTURE_TIME, created_at=FIXTURE_TIME,
    )
    decision = build_decision_snapshot(
        evidence, holding, policy, strategy_version="local-acceptance-v1",
        created_at=FIXTURE_TIME,
    )
    return {"evidence": evidence, "holding": holding, "policy": policy, "decision": decision}


def provision_local_namespace(path: Path, namespace: str) -> None:
    """Called only after CLI has exclusively created a brand-new empty file."""
    path = _require_local(path)
    _check_namespace(namespace)
    conn = _read_only(path)
    try:
        if conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]:
            raise VerificationError("new_empty_database_required")
    finally:
        conn.close()
    db.init_db()
    with db.transaction(immediate=True) as conn:
        conn.execute(f"CREATE TABLE {MARKER_TABLE} ("
                     "namespace TEXT PRIMARY KEY NOT NULL, source_sha256 TEXT NOT NULL, "
                     "created_at TEXT NOT NULL)")
        conn.execute(f"INSERT INTO {MARKER_TABLE} VALUES(?,?,?)", (
            namespace, source_fingerprint(), datetime.now(timezone.utc).isoformat(),
        ))


def _inspect_chain(conn, namespace: str, *, complete: bool) -> dict:
    expected = fixture_chain(namespace)
    payloads = {}
    database_rows = {}
    for kind, (table, identifier) in CHAIN_TABLES.items():
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        if not rows:
            if complete:
                raise VerificationError("application_chain_incomplete")
            continue
        payload = json.loads(rows[0]["payload_json"])
        if rows[0][identifier] != getattr(expected[kind], identifier) or canonical_json(payload) != canonical_json(expected[kind]):
            raise VerificationError("application_chain_mismatch")
        row = dict(rows[0])
        model = expected[kind].model_dump(mode="python")
        semantic = dict(model)
        semantic.pop("created_at")
        if kind != "decision":
            semantic.pop(identifier)
        if row["payload_sha256"] != payload_sha256(semantic):
            raise VerificationError("stored_semantic_digest_mismatch")
        for name, value in row.items():
            if name.endswith("_json"):
                if name == "payload_json":
                    continue
                model_name = name.removesuffix("_json")
                model_name = {"invalidation": "invalidation_conditions"}.get(model_name, model_name)
                if model_name in model:
                    if canonical_json(json.loads(value) if value is not None else None) != canonical_json(model[model_name]):
                        raise VerificationError("stored_projection_mismatch")
            else:
                model_name = "fund_code" if name == "fund_code" else name
                if model_name in model and canonical_json(value) != canonical_json(model[model_name]):
                    # SQL timestamps preserve +00:00 whereas model canonical
                    # timestamps use Z. Compare equivalent instants.
                    expected_value = model[model_name]
                    if not (isinstance(expected_value, datetime) and isinstance(value, str)
                            and datetime.fromisoformat(value) == expected_value):
                        raise VerificationError("stored_projection_mismatch")
        payloads[kind] = payload
        database_rows[kind] = row
    expected_sources = [{
        "event_id": stable_id("src", {"evidence_id": expected["evidence"].evidence_id,
                                     "source_id": state.source_id,
                                     "state": state.model_dump(mode="python")}),
        "evidence_id": expected["evidence"].evidence_id,
        "source_id": state.source_id,
        "payload_json": canonical_json(state),
    } for state in expected["evidence"].source_states]
    rows = [dict(row) for row in conn.execute("SELECT * FROM source_health_events ORDER BY source_id")]
    identities = [{key: row[key] for key in ("event_id", "evidence_id", "source_id", "payload_json")} for row in rows]
    if identities != (sorted(expected_sources, key=lambda row: row["source_id"]) if "evidence" in payloads else []):
        raise VerificationError("source_health_chain_mismatch")
    states = {state.source_id: state for state in expected["evidence"].source_states}
    for row in rows:
        state = states[row["source_id"]].model_dump(mode="python")
        for key, expected_value in state.items():
            actual_value = row[key]
            if key == "stale":
                actual_value = bool(actual_value)
            elif isinstance(expected_value, datetime) and isinstance(actual_value, str):
                actual_value = datetime.fromisoformat(actual_value)
            if canonical_json(actual_value) != canonical_json(expected_value):
                raise VerificationError("source_health_projection_mismatch")
        if datetime.fromisoformat(row["observed_at"]) != FIXTURE_TIME:
            raise VerificationError("source_health_projection_mismatch")
    return {"payloads": payloads, "source_health": rows,
            "chain_sha256": payload_sha256({"database_rows": database_rows, "source_health": rows})}


def _validated_snapshot(path: Path, namespace: str, *, complete: bool) -> dict:
    path = _require_local(path)
    conn = _read_only(path)
    try:
        marker = _marker(conn, namespace)
        _check_population(conn, namespace)
        schema = audit_schema(conn)
        chain = _inspect_chain(conn, namespace, complete=complete)
    finally:
        conn.close()
    return {"marker": marker, **schema, **chain}


def write_local_chain(path: Path, namespace: str) -> dict:
    _validated_snapshot(path, namespace, complete=False)
    chain = fixture_chain(namespace)
    # Each existing repository write owns its transaction. A later failure can
    # leave a valid prefix; a replay reconciles deterministic IDs, never deletes
    # the prefix and never labels the entire chain committed before readback.
    for kind in ("holding", "evidence", "policy", "decision"):
        getattr(v8_repo, "save_" + kind)(chain[kind], scope=scopes.acceptance_scope(namespace))
    return read_local_chain(path, namespace)


def read_local_chain(path: Path, namespace: str, *, receipt: dict | None = None,
                     restored_local: bool = False) -> dict:
    snapshot = _validated_snapshot(path, namespace, complete=True)
    fixture = fixture_chain(namespace)
    scope = scopes.acceptance_scope(namespace)
    actual = {
        "evidence": v8_repo.get_evidence(fixture["evidence"].evidence_id, scope=scope),
        "holding": v8_repo.get_holding(fixture["holding"].holding_version, scope=scope),
        "policy": v8_repo.read_policy(fixture["policy"].policy_version, at=FIXTURE_TIME, scope=scope),
        "decision": v8_repo.get_decision(fixture["decision"].decision_id, scope=scope),
    }
    if canonical_json(actual) != canonical_json(snapshot["payloads"]):
        raise VerificationError("repository_readback_mismatch")
    result = {
        "contract_version": "local-repository-acceptance-1",
        "evidence_scope": "local_application_repository_chain",
        "provider": "local_sqlite", "synthetic_only": True,
        "formal_release_verified": False, "durable": False,
        "namespace": namespace, "resource_fingerprint": resource_fingerprint(path, namespace),
        "source_sha256": snapshot["marker"]["source_sha256"],
        "schema_version": snapshot["schema_version"], "schema_sha256": snapshot["schema_sha256"],
        "chain_sha256": snapshot["chain_sha256"],
        "chain_ids": {kind: getattr(value, CHAIN_TABLES[kind][1]) for kind, value in fixture.items()},
        "boot_id": BOOT_ID, "boot_started_at": BOOT_STARTED_AT,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "integrity_verified": True, "immutable_triggers_verified": True,
        "repository_readback_verified": True, "restored_local": restored_local,
        "not_covered": NOT_COVERED,
    }
    if receipt is not None:
        # Only compare evidence produced by this contract, never arbitrary
        # supplied SHA strings or a provider URL masquerading as an identity.
        for key in ("contract_version", "evidence_scope", "provider", "synthetic_only",
                    "formal_release_verified", "durable", "namespace", "source_sha256",
                    "schema_version", "schema_sha256", "chain_sha256", "chain_ids"):
            if type(receipt.get(key)) is not type(result[key]) or receipt[key] != result[key]:
                raise VerificationError("receipt_identity_or_digest_mismatch")
        fingerprint = receipt.get("resource_fingerprint")
        if not isinstance(fingerprint, str) or not SHA256.fullmatch(fingerprint):
            raise VerificationError("invalid_receipt_resource")
        if (fingerprint == result["resource_fingerprint"]) == restored_local:
            raise VerificationError("receipt_resource_mismatch")
        if not isinstance(receipt.get("boot_id"), str) or not re.fullmatch(r"[0-9a-f]{32}", receipt["boot_id"]):
            raise VerificationError("invalid_receipt_boot_identity")
        try:
            boot = datetime.fromisoformat(receipt["boot_started_at"])
            observed = datetime.fromisoformat(receipt["observed_at"])
            if boot.tzinfo is None or observed.tzinfo is None or not boot <= observed <= datetime.now(timezone.utc):
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise VerificationError("invalid_receipt_timestamps") from None
        result["receipt_matched"] = True
        result["restart_observed"] = receipt.get("boot_id") != BOOT_ID
        if restored_local:
            result["original_resource_fingerprint"] = fingerprint
            result["evidence_scope"] = "local_restored_application_repository_chain"
    elif restored_local:
        raise VerificationError("restore_source_receipt_required")
    return result


def export_synthetic_chain(path: Path, namespace: str, *, receipt: dict) -> dict:
    evidence = read_local_chain(path, namespace, receipt=receipt)
    snapshot = _validated_snapshot(path, namespace, complete=True)
    return {
        "export_contract": "synthetic-chain-export-1", "private_data_export": False,
        "formal_release_verified": False, "durable": False,
        "evidence": evidence, "payloads": snapshot["payloads"],
        "source_health": snapshot["source_health"],
        "export_sha256": payload_sha256({"payloads": snapshot["payloads"],
                                         "source_health": snapshot["source_health"]}),
    }
