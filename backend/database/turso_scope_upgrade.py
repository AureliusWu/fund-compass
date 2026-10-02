"""Offline, bounded schema 8 -> 9 rehearsal over an explicit SQLite snapshot.

This module never opens a remote connection, reads credentials, initializes the
configured application database, or applies a migration to its input. Input DDL
is compared as data; only repository-owned statements run in private memory.
Logical backup/recovery below is not a Turso restore or a release certificate.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import stat
import time

from database import db, turso_schema
from service import repository_scopes as scopes


SOURCE_KINDS = frozenset({"remote-schema-table", "local-header"})
EVIDENCE_SCOPE = "local_turso_schema_migration_rehearsal"
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_CELL_BYTES = 256 * 1024
MAX_ROWS = 100_000
MAX_TABLE_ROWS = 100_000
MAX_BODY_BYTES = 64 * 1024 * 1024
MAX_SCHEMA_OBJECTS = 128
MAX_JSON_DEPTH = 24
MAX_JSON_NODES = 20_000
TIME_BUDGET_SECONDS = 30.0
_DIGEST = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
ERROR_CODES = frozenset({
    "invalid_arguments", "invalid_expected_digest", "unsupported_rehearsal_target",
    "rehearsal_time_limit", "snapshot_limit_exceeded", "schema_limit_exceeded",
    "source_schema_contract_mismatch", "source_not_sqlite", "source_file_limit_exceeded",
    "source_link_rejected", "source_unavailable", "source_not_regular_file",
    "source_live_sidecar_rejected", "snapshot_cell_limit_exceeded", "unsupported_snapshot_value",
    "snapshot_json_limit_exceeded", "snapshot_json_invalid", "snapshot_foreign_key_failure",
    "snapshot_integrity_failure", "source_version_invalid", "legacy_chain_validation_failed",
    "backup_limit_exceeded", "backup_digest_mismatch", "restored_scope_population_mismatch",
    "restored_repository_readback_failed", "source_drift_detected", "legacy_rows_changed",
    "plan_binding_mismatch", "restored_source_mismatch", "restored_target_mismatch",
    "source_or_code_drift_detected", "snapshot_database_error", "rehearsal_failed",
})


class UpgradeError(Exception):
    """Fixed local error code; never includes paths, SQL, values or exceptions."""

    def __init__(self, code):
        super().__init__(code if type(code) is str and code in ERROR_CODES else "rehearsal_failed")


@dataclass
class _Budget:
    deadline: float
    rows: int = 0
    body_bytes: int = 0
    sql_steps: int = 0

    def check(self):
        if time.monotonic() > self.deadline:
            raise UpgradeError("rehearsal_time_limit")

    def progress(self):
        self.sql_steps += 1000
        return int(self.sql_steps > 10_000_000 or time.monotonic() > self.deadline)

    def row(self, encoded: bytes):
        self.check()
        self.rows += 1
        self.body_bytes += len(encoded)
        if self.rows > MAX_ROWS or self.body_bytes > MAX_BODY_BYTES:
            raise UpgradeError("snapshot_limit_exceeded")


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json_bytes(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def _fixed_contract_statements() -> tuple[str, ...]:
    # Scope is the sole physical revision difference supported by this tool.
    # Deliberately reject unrecognized future changes, never infer a migration.
    if db.V8_SCHEMA_VERSION != 9:
        raise UpgradeError("unsupported_rehearsal_target")
    scope_statements = set(scopes.schema_statements())
    statements = [item for item in db.SCHEMA.split(";") if item.strip()]
    statements.extend(item for item in db.V8_SCHEMA_STATEMENTS if item not in scope_statements)
    for table in db.V8_IMMUTABLE_TABLES:
        if table in scopes.SCOPE_TABLES:
            continue
        for operation in ("update", "delete"):
            statements.append(f"CREATE TRIGGER immutable_{table}_{operation} BEFORE {operation.upper()} ON {table} "
                              f"BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END")
    return tuple(statements)


def _objects(conn) -> dict[tuple[str, str], str]:
    rows = conn.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchmany(MAX_SCHEMA_OBJECTS + 1)
    if len(rows) > MAX_SCHEMA_OBJECTS:
        raise UpgradeError("schema_limit_exceeded")
    return {(row[0], row[1]): row[2] for row in rows}


def _contract_digest(objects) -> str:
    return _digest(_json_bytes([[kind, name, turso_schema._normalize_ddl(sql)]
                               for (kind, name), sql in sorted(objects.items())]))


def _new_memory(budget: _Budget) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.set_progress_handler(budget.progress, 1000)
    return conn


def _source_reference(source_kind: str, budget: _Budget, *, optimizer_statistics: bool = False):
    conn = _new_memory(budget)
    try:
        for statement in _fixed_contract_statements():
            conn.execute(statement)
        if source_kind == "remote-schema-table":
            conn.execute(turso_schema.VERSION_DDL)
        # SQLite's own fixed internal statistics table is optional. Never run
        # input SQL to create it, and never treat arbitrary sqlite_* as allowed.
        if optimizer_statistics:
            conn.execute("ANALYZE")
        conn.commit()
        return conn
    except Exception:
        conn.close()
        raise


def _check_objects(conn, expected):
    actual = _objects(conn)
    if set(actual) != set(expected) or any(
            turso_schema._normalize_ddl(actual[key]) != turso_schema._normalize_ddl(sql)
            for key, sql in expected.items()):
        raise UpgradeError("source_schema_contract_mismatch")


def _file_digest(path: Path, budget: _Budget):
    total = 0
    result = hashlib.sha256()
    with path.open("rb") as source:
        if source.read(16) != b"SQLite format 3\x00":
            raise UpgradeError("source_not_sqlite")
        source.seek(0)
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            budget.check()
            total += len(chunk)
            if total > MAX_FILE_BYTES:
                raise UpgradeError("source_file_limit_exceeded")
            result.update(chunk)
    return result.hexdigest()


def _source_path(value, budget):
    try:
        selected = Path(value)
        if selected.is_symlink():
            raise UpgradeError("source_link_rejected")
        path = selected.resolve(strict=True)
        info = path.stat()
    except (OSError, TypeError, ValueError):
        raise UpgradeError("source_unavailable") from None
    if not stat.S_ISREG(info.st_mode):
        raise UpgradeError("source_not_regular_file")
    if info.st_size > MAX_FILE_BYTES:
        raise UpgradeError("source_file_limit_exceeded")
    # immutable=1 must never silently ignore a live WAL or rollback journal.
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise UpgradeError("source_live_sidecar_rejected")
    return path, _file_digest(path, budget)


def _typed(value):
    if value is None:
        return ["null"]
    if type(value) is int:
        return ["integer", str(value)]
    if type(value) is float and math.isfinite(value):
        return ["real", value.hex()]
    if type(value) is str:
        if len(value.encode("utf-8")) > MAX_CELL_BYTES:
            raise UpgradeError("snapshot_cell_limit_exceeded")
        return ["text", value]
    if type(value) is bytes:
        if len(value) > MAX_CELL_BYTES:
            raise UpgradeError("snapshot_cell_limit_exceeded")
        return ["blob", base64.b64encode(value).decode("ascii")]
    raise UpgradeError("unsupported_snapshot_value")


def _validate_json(value):
    def object_pairs(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError()
            result[key] = item
        return result
    try:
        decoded = json.loads(value, object_pairs_hook=object_pairs,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        pending, count = [(decoded, 0)], 0
        while pending:
            item, depth = pending.pop()
            count += 1
            if depth > MAX_JSON_DEPTH or count > MAX_JSON_NODES:
                raise UpgradeError("snapshot_json_limit_exceeded")
            if type(item) is float and not math.isfinite(item):
                raise UpgradeError("snapshot_json_invalid")
            if isinstance(item, dict):
                pending.extend((child, depth + 1) for child in item.values())
            elif isinstance(item, list):
                pending.extend((child, depth + 1) for child in item)
    except (ValueError, TypeError, RecursionError):
        raise UpgradeError("snapshot_json_invalid") from None


def _snapshot_rows(conn, expected, budget):
    records = {}
    for kind, table in sorted(expected):
        if kind != "table":
            continue
        columns = tuple(row[1] for row in conn.execute(f'PRAGMA table_info("{table}")'))
        rows = []
        for row in conn.execute(f'SELECT rowid,* FROM "{table}" ORDER BY rowid'):
            values = tuple(row)
            if len(rows) >= MAX_TABLE_ROWS:
                raise UpgradeError("snapshot_limit_exceeded")
            encoded = _json_bytes([_typed(value) for value in values])
            budget.row(encoded)
            for column, value in zip(columns, values[1:]):
                if value is not None and (column.endswith("_json") or column == "detail_json"):
                    _validate_json(value)
            rows.append(values)
        records[table] = (columns, rows)
    return records


def _rows_digest(records, *, exclude=()):
    result = hashlib.sha256()
    for table, (columns, rows) in sorted(records.items()):
        if table in exclude:
            continue
        result.update(_json_bytes([table, list(columns)]))
        for row in rows:
            result.update(b"\n" + _json_bytes([_typed(value) for value in row]))
    return result.hexdigest()


def _seed_memory(conn, records):
    # Only known table/column names obtained from the canonical reference reach SQL.
    # rowid is preserved: equal-time latest/history ordering must not change.
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("BEGIN IMMEDIATE")
    try:
        for table, (columns, rows) in sorted(records.items()):
            if table == "sqlite_sequence":
                conn.execute("DELETE FROM sqlite_sequence")
                conn.executemany("INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,?,?)", rows)
                continue
            names = ",".join('"' + name + '"' for name in ("rowid", *columns))
            conn.executemany(f'INSERT INTO "{table}"({names}) VALUES({",".join("?" for _ in range(len(columns) + 1))})', rows)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


def _integrity(conn):
    if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise UpgradeError("snapshot_foreign_key_failure")
    if conn.execute("PRAGMA quick_check(1)").fetchone()[0] != "ok":
        raise UpgradeError("snapshot_integrity_failure")


def _scope_upgrade(conn, source_kind, budget):
    conn.execute("BEGIN IMMEDIATE")
    try:
        for statement in scopes.schema_statements():
            conn.execute(statement)
        # This is the existing *complete* root identity/projection and derived
        # lineage validator, not a new weaker validator or initialize fallback.
        scopes.backfill_legacy_production(conn, allow_legacy=True)
        scopes._validate_legacy_lineages(conn)
        for table in scopes.SCOPE_TABLES:
            for operation in ("update", "delete"):
                conn.execute(f"CREATE TRIGGER immutable_{table}_{operation} BEFORE {operation} ON {table} "
                             f"BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END")
        db._verify_v8_schema_contract(conn)
        _integrity(conn)
        if source_kind == "remote-schema-table":
            conn.execute("UPDATE _schema_version SET version=9 WHERE singleton=1 AND version=8")
            if conn.execute("SELECT changes()").fetchone()[0] != 1:
                raise UpgradeError("source_version_invalid")
        conn.execute("PRAGMA user_version=9")
        budget.check()
        conn.commit()
    except UpgradeError:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        raise UpgradeError("legacy_chain_validation_failed") from None


def _serialize_backup(conn):
    image = conn.serialize()
    if len(image) > MAX_FILE_BYTES:
        raise UpgradeError("backup_limit_exceeded")
    return image


def _restore_image(image, expected_digest, budget):
    if not _DIGEST.fullmatch(expected_digest) or _digest(image) != expected_digest:
        raise UpgradeError("backup_digest_mismatch")
    conn = _new_memory(budget)
    try:
        conn.deserialize(image)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        _integrity(conn)
        return conn
    except Exception:
        conn.close()
        raise


def _repository_readback(conn, budget):
    from models.v8 import EvidenceSnapshot, HoldingVersion, PortfolioPolicy, DecisionSnapshot
    from service import v8_repo
    models = dict(evidence=EvidenceSnapshot, holding=HoldingVersion, policy=PortfolioPolicy, decision=DecisionSnapshot)
    for kind, (table, column) in scopes.ROOTS.items():
        total = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        visible = conn.execute(f"SELECT COUNT(*) FROM production_{table}").fetchone()[0]
        if total != visible:
            raise UpgradeError("restored_scope_population_mismatch")
        for row in conn.execute(f"SELECT {column},payload_json FROM {table}"):
            budget.check()
            result = v8_repo._existing_model(conn, table, column, row[0], models[kind])
            if result is None or result != models[kind].model_validate_json(row[1]):
                raise UpgradeError("restored_repository_readback_failed")
    records = conn.execute("SELECT COUNT(*) FROM v8_record_scopes").fetchone()[0]
    expected = sum(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table, _ in scopes.ROOTS.values())
    if records != expected or conn.execute("SELECT COUNT(*) FROM v8_repository_scopes WHERE scope_key<>'production'").fetchone()[0]:
        raise UpgradeError("restored_scope_population_mismatch")


def _code_digest():
    project = Path(__file__).resolve().parents[2]
    relative = ("backend/database/turso_scope_upgrade.py", "tools/turso_scope_upgrade.py",
                "backend/database/db.py", "backend/database/turso_schema.py",
                "backend/service/repository_scopes.py", "backend/service/v8_repo.py", "backend/models/v8.py")
    return _digest(_json_bytes([[name, _digest((project / name).read_bytes())] for name in relative]))


def rehearse_snapshot(source, *, source_kind: str, restore: bool = True,
                      expected_plan_sha256: str | None = None,
                      expected_backup_sha256: str | None = None) -> dict:
    """Read a closed local snapshot and optionally restore the private memory image.

    Returned output is safe metadata only. A saved plan digest can detect a
    changed source, code, contract or backup on a later invocation. No apply
    entry point exists; neither this function nor plan mode mutates its input.
    """
    if type(source_kind) is not str or source_kind not in SOURCE_KINDS or type(restore) is not bool:
        raise UpgradeError("invalid_arguments")
    for expected in (expected_plan_sha256, expected_backup_sha256):
        if expected is not None and (type(expected) is not str or not _DIGEST.fullmatch(expected)):
            raise UpgradeError("invalid_expected_digest")
    budget = _Budget(time.monotonic() + TIME_BUDGET_SECONDS)
    opened = []
    try:
        path, file_digest = _source_path(source, budget)
        code_digest = _code_digest()
        source_conn = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
        opened.append(source_conn)
        source_conn.row_factory = sqlite3.Row
        source_conn.execute("PRAGMA query_only=ON")
        source_conn.execute("PRAGMA trusted_schema=OFF")
        source_conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_CELL_BYTES)
        source_conn.set_progress_handler(budget.progress, 1000)
        reference = _source_reference(source_kind, budget,
                                      optimizer_statistics=("table", "sqlite_stat1") in _objects(source_conn))
        opened.append(reference)
        expected_objects = _objects(reference)
        header_version = source_conn.execute("PRAGMA user_version").fetchone()[0]
        if source_kind == "local-header" and header_version != 8:
            raise UpgradeError("source_version_invalid")
        if source_kind == "remote-schema-table" and header_version not in (0, 8):
            raise UpgradeError("source_version_invalid")
        _check_objects(source_conn, expected_objects)
        if source_kind == "remote-schema-table":
            versions = source_conn.execute("SELECT singleton,version FROM _schema_version").fetchall()
            if len(versions) != 1 or tuple(versions[0]) != (1, 8):
                raise UpgradeError("source_version_invalid")
        _integrity(source_conn)
        records = _snapshot_rows(source_conn, expected_objects, budget)
        if _source_path(path, budget)[1] != file_digest:
            raise UpgradeError("source_drift_detected")
        source_conn.close()
        opened.remove(source_conn)
        _seed_memory(reference, records)
        reference.execute(f"PRAGMA user_version={header_version}")
        _integrity(reference)
        source_rows_digest = _rows_digest(records)
        business_digest = _rows_digest(records, exclude=("_schema_version",))
        backup = _serialize_backup(reference)
        backup_digest = _digest(backup)
        if expected_backup_sha256 is not None and backup_digest != expected_backup_sha256:
            raise UpgradeError("backup_digest_mismatch")
        _scope_upgrade(reference, source_kind, budget)
        _repository_readback(reference, budget)
        target_records = _snapshot_rows(reference, _objects(reference), _Budget(budget.deadline))
        retained = {table: target_records[table] for table in records}
        if _rows_digest(retained, exclude=("_schema_version",)) != business_digest:
            raise UpgradeError("legacy_rows_changed")
        binding = {
            "source_kind": source_kind, "source_file_sha256": file_digest,
            "source_contract_sha256": _contract_digest(expected_objects),
            "source_rows_sha256": source_rows_digest, "logical_backup_sha256": backup_digest,
            "target_contract_sha256": _contract_digest(_objects(reference)),
            "target_rows_sha256": _rows_digest(target_records), "code_sha256": code_digest,
        }
        plan_digest = _digest(_json_bytes(binding))
        if expected_plan_sha256 is not None and plan_digest != expected_plan_sha256:
            raise UpgradeError("plan_binding_mismatch")
        if restore:
            # Independently reconstruct the original 8 backup, then repeat the
            # exact upgrade and verify both complete population and repo reads.
            restored = _restore_image(backup, backup_digest, budget)
            opened.append(restored)
            _check_objects(restored, expected_objects)
            restored_before = _snapshot_rows(restored, expected_objects, _Budget(budget.deadline))
            if _rows_digest(restored_before) != source_rows_digest:
                raise UpgradeError("restored_source_mismatch")
            _scope_upgrade(restored, source_kind, budget)
            _repository_readback(restored, budget)
            restored_after = _snapshot_rows(restored, _objects(restored), _Budget(budget.deadline))
            if _rows_digest(restored_after) != binding["target_rows_sha256"]:
                raise UpgradeError("restored_target_mismatch")
        if _source_path(path, budget)[1] != file_digest or _code_digest() != code_digest:
            raise UpgradeError("source_or_code_drift_detected")
        return {
            "ok": True, "command": "rehearse" if restore else "plan", "from_schema": 8, "to_schema": 9,
            "evidence_scope": EVIDENCE_SCOPE, "formal_release_verified": False,
            "remote_applied": False, "remote_restore_verified": False,
            "local_logical_restore_verified": restore, "legacy_rows_unchanged": True,
            "repository_roots_readback_verified": True, "source_file_unchanged": True,
            "plan_sha256": plan_digest, "table_count": len(records), "row_count": budget.rows,
            **binding,
        }
    except UpgradeError:
        raise
    except sqlite3.Error:
        raise UpgradeError("snapshot_database_error") from None
    except (OSError, ValueError, TypeError, OverflowError, KeyError):
        raise UpgradeError("rehearsal_failed") from None
    finally:
        for conn in reversed(opened):
            conn.close()
