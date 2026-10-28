"""Explicit fixed local machine-task profile; never a startup migration.

The one append-only journal extends the complete Owner analysis profile.  Its
rows describe work and observations, not a second notification send lock.  The
existing V8 notification claim remains the sole transport ownership mechanism.
"""
from __future__ import annotations

import hashlib
import sqlite3
from functools import lru_cache

from database.owner_analysis_schema import (
    OWNER_ANALYSIS_DDL, OWNER_ANALYSIS_TRIGGERS, _analysis_implicit_indexes,
    _verify_analysis_objects,
)
from database.owner_sync_schema import (
    _local_connection, _objects, _same_ddl, _verify_owner_sync_objects,
)

OWNER_MACHINE_SCHEMA_VERSION = "owner-machine-schema-1"
MAX_MACHINE_DOCUMENT_BYTES = 2 * 1024 * 1024
MACHINE_SCHEMA_CREATED_AT = "1970-01-01T00:00:00+00:00"
MACHINE_SCHEMA_PAYLOAD_JSON = '{"schema":"owner-machine-schema-1"}'
MACHINE_SCHEMA_PAYLOAD_HASH = hashlib.sha256(MACHINE_SCHEMA_PAYLOAD_JSON.encode("utf-8")).hexdigest()

OWNER_MACHINE_DDL = {
    "owner_machine_journal": f"""CREATE TABLE owner_machine_journal (
      schema_version TEXT NOT NULL CHECK(typeof(schema_version) = 'text' AND schema_version = 'owner-machine-schema-1'),
      kind TEXT NOT NULL CHECK(typeof(kind) = 'text' AND kind IN ('schema','task','attempt','result','observation')),
      record_id TEXT NOT NULL CHECK(typeof(record_id) = 'text' AND length(CAST(record_id AS BLOB)) BETWEEN 1 AND 128 AND instr(record_id,char(0)) = 0),
      occurrence_id TEXT CHECK(occurrence_id IS NULL OR (typeof(occurrence_id) = 'text' AND length(CAST(occurrence_id AS BLOB)) BETWEEN 1 AND 128 AND instr(occurrence_id,char(0)) = 0)),
      analysis_request_id TEXT REFERENCES owner_analysis_runs(request_id) CHECK(analysis_request_id IS NULL OR (typeof(analysis_request_id) = 'text' AND length(CAST(analysis_request_id AS BLOB)) BETWEEN 1 AND 128 AND instr(analysis_request_id,char(0)) = 0)),
      created_at TEXT NOT NULL CHECK(typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) BETWEEN 1 AND 64 AND instr(created_at,char(0)) = 0),
      payload_json TEXT NOT NULL CHECK(typeof(payload_json) = 'text' AND length(CAST(payload_json AS BLOB)) BETWEEN 1 AND {MAX_MACHINE_DOCUMENT_BYTES}),
      payload_hash TEXT NOT NULL CHECK(typeof(payload_hash) = 'text' AND length(payload_hash) = 64 AND length(CAST(payload_hash AS BLOB)) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
      PRIMARY KEY(kind,record_id),
      CHECK((kind = 'schema' AND record_id = 'schema' AND occurrence_id IS NULL AND analysis_request_id IS NULL)
         OR (kind <> 'schema' AND occurrence_id IS NOT NULL))
    )""",
}
OWNER_MACHINE_TRIGGERS = {
    f"immutable_owner_machine_journal_{operation.lower()}": (
        f"CREATE TRIGGER immutable_owner_machine_journal_{operation.lower()} "
        f"BEFORE {operation} ON owner_machine_journal "
        "BEGIN SELECT RAISE(ABORT, 'Owner machine rows are immutable'); END"
    )
    for operation in ("UPDATE", "DELETE")
}


@lru_cache(maxsize=1)
def _machine_implicit_indexes() -> dict[tuple[str, str], None]:
    # Foreign-key target tables need not exist to compile this trusted table.
    # Derive only its actual fixed autoindex; no sqlite_ prefix exemption.
    reference = sqlite3.connect(":memory:")
    try:
        for ddl in OWNER_MACHINE_DDL.values():
            reference.execute(ddl)
        return {(row[0], row[1]): None for row in reference.execute(
            "SELECT type,name FROM sqlite_master WHERE sql IS NULL"
        )}
    finally:
        reference.close()


def _verify_machine_objects(conn: sqlite3.Connection, actual: dict, owner: dict) -> None:
    expected = dict(owner)
    expected.update({("table", name): ddl for name, ddl in OWNER_ANALYSIS_DDL.items()})
    expected.update({("trigger", name): ddl for name, ddl in OWNER_ANALYSIS_TRIGGERS.items()})
    expected.update(_analysis_implicit_indexes())
    expected.update({("table", name): ddl for name, ddl in OWNER_MACHINE_DDL.items()})
    expected.update({("trigger", name): ddl for name, ddl in OWNER_MACHINE_TRIGGERS.items()})
    expected.update(_machine_implicit_indexes())
    if set(actual) != set(expected):
        raise sqlite3.DatabaseError("Owner machine schema contains missing or unknown objects")
    for key, ddl in expected.items():
        if not _same_ddl(actual[key], ddl):
            raise sqlite3.DatabaseError("Owner machine schema contract mismatch")
    # Check the analysis marker against its original contract, without passing
    # the machine objects to the original exact public analysis verifier.
    machine_keys = {("table", "owner_machine_journal"),
                    *[("trigger", name) for name in OWNER_MACHINE_TRIGGERS],
                    *_machine_implicit_indexes()}
    analysis_actual = {key: ddl for key, ddl in actual.items() if key not in machine_keys}
    _verify_analysis_objects(conn, analysis_actual, owner)
    # Transfer bounded booleans only, even with disabled CHECK constraints.
    rows = conn.execute(
        "SELECT CASE WHEN typeof(schema_version)='text' AND schema_version=? THEN 1 ELSE 0 END,"
        "CASE WHEN typeof(record_id)='text' AND record_id='schema' THEN 1 ELSE 0 END,"
        "CASE WHEN occurrence_id IS NULL AND analysis_request_id IS NULL THEN 1 ELSE 0 END,"
        "CASE WHEN typeof(created_at)='text' AND created_at=? THEN 1 ELSE 0 END,"
        "CASE WHEN typeof(payload_json)='text' AND payload_json=? THEN 1 ELSE 0 END,"
        "CASE WHEN typeof(payload_hash)='text' AND payload_hash=? THEN 1 ELSE 0 END "
        "FROM owner_machine_journal WHERE kind='schema' LIMIT 2",
        (OWNER_MACHINE_SCHEMA_VERSION, MACHINE_SCHEMA_CREATED_AT,
         MACHINE_SCHEMA_PAYLOAD_JSON, MACHINE_SCHEMA_PAYLOAD_HASH),
    ).fetchmany(2)
    if len(rows) != 1 or tuple(rows[0]) != (1, 1, 1, 1, 1, 1):
        raise sqlite3.DatabaseError("Owner machine extension version mismatch")


def verify_owner_machine_schema(conn) -> None:
    """Read-only verification of the complete, fixed local machine profile."""
    _local_connection(conn)
    actual = _objects(conn)
    owner = _verify_owner_sync_objects(conn, actual)
    _verify_machine_objects(conn, actual, owner)


def provision_owner_machine_candidate(conn, *, synthetic_candidate: bool = False) -> dict:
    """Explicitly extend an already complete local analysis candidate once.

    The selection does not authenticate production isolation, authorize remote
    migration or grant persistence/release qualification. A partial profile is
    refused, not completed or repaired; commit errors propagate without retry.
    """
    if synthetic_candidate is not True:
        raise sqlite3.DatabaseError("Owner machine synthetic provisioning requires explicit selection")
    _local_connection(conn)
    if conn.in_transaction:
        raise sqlite3.DatabaseError("Owner machine candidate has an active transaction")
    if tuple(conn.execute("PRAGMA foreign_keys").fetchone()) != (1,):
        raise sqlite3.DatabaseError("Owner machine candidate requires foreign keys")
    conn.execute("BEGIN IMMEDIATE")
    try:
        actual = _objects(conn)
        owner = _verify_owner_sync_objects(conn, actual)
        if ("table", "owner_machine_journal") in actual:
            _verify_machine_objects(conn, actual, owner)
            changed = False
        else:
            _verify_analysis_objects(conn, actual, owner)
            for ddl in (*OWNER_MACHINE_DDL.values(), *OWNER_MACHINE_TRIGGERS.values()):
                conn.execute(ddl)
            conn.execute(
                "INSERT INTO owner_machine_journal(schema_version,kind,record_id,occurrence_id,"
                "analysis_request_id,created_at,payload_json,payload_hash) VALUES(?,'schema','schema',NULL,NULL,?,?,?)",
                (OWNER_MACHINE_SCHEMA_VERSION, MACHINE_SCHEMA_CREATED_AT,
                 MACHINE_SCHEMA_PAYLOAD_JSON, MACHINE_SCHEMA_PAYLOAD_HASH),
            )
            verify_owner_machine_schema(conn)
            changed = True
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"schema_version": OWNER_MACHINE_SCHEMA_VERSION, "core_schema_version": 9,
            "changed": changed, "synthetic_only": True}
