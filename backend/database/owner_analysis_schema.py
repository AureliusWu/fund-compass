"""Closed local analysis profile, explicitly provisioned on synthetic Owner DBs.

No connection factory, configured path, remote adapter or startup migration is
used here. The original Owner-only verifier and remote packet keep their own
closed inventory; this profile is a separate opt-in for local analysis work.
"""
from __future__ import annotations

import sqlite3
from functools import lru_cache

from database.owner_sync_schema import (
    MAX_SAFE_INTEGER, OWNER_SYNC_DDL, _local_connection, _objects, _same_ddl,
    _verify_owner_sync_objects,
)
from database.turso_schema import expected_objects

OWNER_ANALYSIS_SCHEMA_VERSION = "owner-analysis-schema-1"
MAX_ANALYSIS_REQUEST_BYTES = 16 * 1024
MAX_ANALYSIS_DOCUMENT_BYTES = 2 * 1024 * 1024

OWNER_ANALYSIS_DDL = {
    "owner_analysis_schema": """CREATE TABLE owner_analysis_schema (
      singleton INTEGER PRIMARY KEY CHECK(typeof(singleton) = 'integer' AND singleton = 1),
      version TEXT NOT NULL CHECK(typeof(version) = 'text' AND version = 'owner-analysis-schema-1')
    )""",
    "owner_analysis_runs": f"""CREATE TABLE owner_analysis_runs (
      request_id TEXT PRIMARY KEY NOT NULL CHECK(typeof(request_id) = 'text'),
      request_hash TEXT NOT NULL CHECK(typeof(request_hash) = 'text' AND length(request_hash) = 64 AND length(CAST(request_hash AS BLOB)) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
      request_json TEXT NOT NULL CHECK(typeof(request_json) = 'text' AND length(CAST(request_json AS BLOB)) BETWEEN 1 AND {MAX_ANALYSIS_REQUEST_BYTES}),
      run_id TEXT UNIQUE NOT NULL CHECK(typeof(run_id) = 'text'),
      source_revision INTEGER NOT NULL CHECK(typeof(source_revision) = 'integer' AND source_revision BETWEEN 0 AND {MAX_SAFE_INTEGER}),
      source_hash TEXT NOT NULL CHECK(typeof(source_hash) = 'text' AND length(source_hash) = 64 AND length(CAST(source_hash AS BLOB)) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
      source_json TEXT NOT NULL CHECK(typeof(source_json) = 'text' AND length(CAST(source_json AS BLOB)) BETWEEN 1 AND {MAX_ANALYSIS_DOCUMENT_BYTES}),
      policy_version TEXT NOT NULL REFERENCES portfolio_policy_versions(policy_version) CHECK(typeof(policy_version) = 'text'),
      strategy_version TEXT NOT NULL CHECK(typeof(strategy_version) = 'text' AND instr(strategy_version,char(0)) = 0 AND length(strategy_version) BETWEEN 1 AND 120),
      created_at TEXT NOT NULL CHECK(typeof(created_at) = 'text'),
      response_json TEXT NOT NULL CHECK(typeof(response_json) = 'text' AND length(CAST(response_json AS BLOB)) BETWEEN 1 AND {MAX_ANALYSIS_DOCUMENT_BYTES}),
      response_hash TEXT NOT NULL CHECK(typeof(response_hash) = 'text' AND length(response_hash) = 64 AND length(CAST(response_hash AS BLOB)) = 64 AND response_hash NOT GLOB '*[^0-9a-f]*')
    )""",
    "owner_analysis_components": """CREATE TABLE owner_analysis_components (
      request_id TEXT NOT NULL REFERENCES owner_analysis_runs(request_id) CHECK(typeof(request_id) = 'text'),
      fund_code TEXT NOT NULL CHECK(typeof(fund_code) = 'text' AND length(fund_code) = 6 AND length(CAST(fund_code AS BLOB)) = 6 AND fund_code NOT GLOB '*[^0-9]*'),
      holding_version TEXT NOT NULL REFERENCES holding_versions(holding_version) CHECK(typeof(holding_version) = 'text'),
      evidence_id TEXT NOT NULL REFERENCES evidence_snapshots(evidence_id) CHECK(typeof(evidence_id) = 'text'),
      decision_id TEXT NOT NULL REFERENCES decision_snapshots(decision_id) CHECK(typeof(decision_id) = 'text'),
      PRIMARY KEY(request_id,fund_code)
    )""",
}

OWNER_ANALYSIS_TRIGGERS = {
    f"immutable_{table}_{operation.lower()}": (
        f"CREATE TRIGGER immutable_{table}_{operation.lower()} "
        f"BEFORE {operation} ON {table} "
        "BEGIN SELECT RAISE(ABORT, 'Owner analysis rows are immutable'); END"
    )
    for table in OWNER_ANALYSIS_DDL
    for operation in ("UPDATE", "DELETE")
}


@lru_cache(maxsize=1)
def _analysis_implicit_indexes() -> dict[tuple[str, str], None]:
    reference = sqlite3.connect(":memory:")
    try:
        for ddl in expected_objects().values():
            reference.execute(ddl)
        for ddl in (*OWNER_SYNC_DDL.values(), *OWNER_ANALYSIS_DDL.values()):
            reference.execute(ddl)
        return {(row[0], row[1]): None for row in reference.execute(
            "SELECT type,name FROM sqlite_master WHERE sql IS NULL"
        )}
    finally:
        reference.close()


def _verify_analysis_objects(conn: sqlite3.Connection, actual: dict, owner: dict) -> None:
    expected = dict(owner)
    expected.update({("table", name): ddl for name, ddl in OWNER_ANALYSIS_DDL.items()})
    expected.update({("trigger", name): ddl for name, ddl in OWNER_ANALYSIS_TRIGGERS.items()})
    expected.update(_analysis_implicit_indexes())
    if set(actual) != set(expected):
        raise sqlite3.DatabaseError("Owner analysis schema contains missing or unknown objects")
    for key, ddl in expected.items():
        if not _same_ddl(actual[key], ddl):
            raise sqlite3.DatabaseError("Owner analysis schema contract mismatch")
    # Transfer only bounded booleans, even if CHECK constraints were disabled.
    rows = conn.execute(
        "SELECT CASE WHEN typeof(singleton) = 'integer' AND singleton = 1 THEN 1 ELSE 0 END,"
        "CASE WHEN typeof(version) = 'text' AND version = ? THEN 1 ELSE 0 END "
        "FROM owner_analysis_schema LIMIT 2", (OWNER_ANALYSIS_SCHEMA_VERSION,),
    ).fetchmany(2)
    if len(rows) != 1 or tuple(rows[0]) != (1, 1):
        raise sqlite3.DatabaseError("Owner analysis extension version mismatch")


def verify_owner_analysis_schema(conn) -> None:
    """Read-only verification of the complete fixed local analysis profile."""
    _local_connection(conn)
    actual = _objects(conn)
    owner = _verify_owner_sync_objects(conn, actual)
    _verify_analysis_objects(conn, actual, owner)


def verify_owner_workspace_schema(conn) -> None:
    """Read-only union of three independently fixed local workspace profiles."""
    _local_connection(conn)
    actual = _objects(conn)
    owner = _verify_owner_sync_objects(conn, actual)
    if set(actual) == set(owner):
        return
    if ("table", "owner_machine_journal") in actual:
        from database.owner_machine_schema import _verify_machine_objects
        _verify_machine_objects(conn, actual, owner)
        return
    _verify_analysis_objects(conn, actual, owner)


def verify_owner_analysis_workspace_schema(conn) -> None:
    """Analysis-compatible local profiles only; plain Owner sync is refused."""
    _local_connection(conn)
    actual = _objects(conn)
    owner = _verify_owner_sync_objects(conn, actual)
    if ("table", "owner_machine_journal") in actual:
        from database.owner_machine_schema import _verify_machine_objects
        _verify_machine_objects(conn, actual, owner)
        return
    _verify_analysis_objects(conn, actual, owner)


def provision_owner_analysis_candidate(conn, *, synthetic_candidate: bool = False) -> dict:
    """Atomically extend an explicitly selected existing local Owner candidate.

    Synthetic selection is a caller opt-in, not production-isolation evidence,
    Owner authorization, remote capability or a release qualification.
    """
    if synthetic_candidate is not True:
        raise sqlite3.DatabaseError("Owner analysis synthetic provisioning requires explicit selection")
    _local_connection(conn)
    if conn.in_transaction:
        raise sqlite3.DatabaseError("Owner analysis candidate has an active transaction")
    conn.execute("BEGIN IMMEDIATE")
    try:
        actual = _objects(conn)
        owner = _verify_owner_sync_objects(conn, actual)
        if set(actual) == set(owner):
            for ddl in (*OWNER_ANALYSIS_DDL.values(), *OWNER_ANALYSIS_TRIGGERS.values()):
                conn.execute(ddl)
            conn.execute("INSERT INTO owner_analysis_schema(singleton,version) VALUES(1,?)",
                         (OWNER_ANALYSIS_SCHEMA_VERSION,))
            verify_owner_analysis_schema(conn)
            changed = True
        else:
            _verify_analysis_objects(conn, actual, owner)
            changed = False
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"schema_version": OWNER_ANALYSIS_SCHEMA_VERSION, "core_schema_version": 9,
            "changed": changed, "synthetic_only": True}
