"""Explicit synthetic candidate extension, never a normal-startup migration."""
from __future__ import annotations

import sqlite3
from functools import lru_cache

from database.turso_schema import VERSION_DDL, _normalize_ddl, expected_objects

OWNER_SYNC_SCHEMA_VERSION = "owner-sync-schema-1"
MAX_SAFE_INTEGER = 2**53 - 1
MAX_SCHEMA_OBJECTS = 128
MAX_SCHEMA_DDL_BYTES = 16 * 1024
MAX_SCHEMA_NAME_BYTES = 256
_SEQUENCE_DDL = "CREATE TABLE sqlite_sequence(name,seq)"
OWNER_SYNC_DDL = {
    "owner_sync_schema": """CREATE TABLE owner_sync_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version TEXT NOT NULL CHECK(version = 'owner-sync-schema-1')
    )""",
    "owner_sync_state": f"""CREATE TABLE owner_sync_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 0 AND {MAX_SAFE_INTEGER})
    )""",
    "owner_sync_records": f"""CREATE TABLE owner_sync_records (
      sync_key TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('watch','holding','manual_asset')),
      deleted INTEGER NOT NULL CHECK(typeof(deleted) = 'integer' AND deleted IN (0,1)),
      record_revision INTEGER NOT NULL CHECK(typeof(record_revision) = 'integer' AND record_revision BETWEEN 1 AND {MAX_SAFE_INTEGER}),
      lifecycle_revision INTEGER NOT NULL CHECK(typeof(lifecycle_revision) = 'integer' AND lifecycle_revision BETWEEN 1 AND record_revision),
      field_revisions_json TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )""",
    "owner_sync_changes": f"""CREATE TABLE owner_sync_changes (
      revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND {MAX_SAFE_INTEGER}),
      sync_key TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY(revision,sync_key)
    )""",
    "owner_sync_receipts": """CREATE TABLE owner_sync_receipts (
      request_id TEXT PRIMARY KEY NOT NULL,
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
      status INTEGER NOT NULL CHECK(typeof(status) = 'integer' AND status IN (200,409)),
      response_json TEXT NOT NULL
    )""",
}


@lru_cache(maxsize=2)
def _implicit_indexes(include_owner: bool) -> dict[tuple[str, str], None]:
    # SQL-NULL autoindexes must also match the fixed trusted schema; never
    # exempt all NULL-SQL rows or an arbitrary sqlite_ name supplied by input.
    reference = sqlite3.connect(":memory:")
    try:
        for ddl in expected_objects().values():
            reference.execute(ddl)
        if include_owner:
            for ddl in OWNER_SYNC_DDL.values():
                reference.execute(ddl)
        return {(row[0], row[1]): None for row in reference.execute(
            "SELECT type,name FROM sqlite_master WHERE sql IS NULL"
        )}
    finally:
        reference.close()


def _same_ddl(actual: str | None, expected: str | None) -> bool:
    if actual is None or expected is None:
        return actual is expected
    return _normalize_ddl(actual) == _normalize_ddl(expected)


def _objects(conn: sqlite3.Connection) -> dict[tuple[str, str], str | None]:
    # Bound rows in SQL, and bound DDL/name bytes before transferring strings
    # to Python. A huge unknown object must not reach normalization or hashing.
    rows = conn.execute(
        "SELECT substr(type,1,16),"
        "CASE WHEN length(CAST(name AS BLOB)) <= ? THEN name ELSE NULL END,"
        "CASE WHEN length(CAST(sql AS BLOB)) <= ? THEN sql ELSE NULL END,"
        "length(CAST(sql AS BLOB)) FROM sqlite_master LIMIT ?",
        (MAX_SCHEMA_NAME_BYTES, MAX_SCHEMA_DDL_BYTES, MAX_SCHEMA_OBJECTS + 1),
    ).fetchmany(MAX_SCHEMA_OBJECTS + 1)
    if len(rows) > MAX_SCHEMA_OBJECTS or any(
        row[1] is None or (row[3] is not None and row[3] > MAX_SCHEMA_DDL_BYTES) for row in rows
    ):
        raise sqlite3.DatabaseError("Owner sync schema exceeds verification bounds")
    objects = {(row[0], row[1]): row[2] for row in rows}
    # AUTOINCREMENT creates this one fixed internal table. SQL LIKE's `_`
    # wildcard would hide user objects such as sqliteXevil; no prefix exemption.
    sequence_key = ("table", "sqlite_sequence")
    if sequence_key not in objects or not _same_ddl(objects[sequence_key], _SEQUENCE_DDL):
        raise sqlite3.DatabaseError("Owner sync internal schema contract mismatch")
    objects.pop(sequence_key)
    return objects


def _local_connection(conn) -> None:
    if not isinstance(conn, sqlite3.Connection):
        raise sqlite3.DatabaseError("Owner sync requires an explicit local SQLite candidate")
    if any(row[1] not in ("main", "temp") for row in conn.execute("PRAGMA database_list")):
        raise sqlite3.DatabaseError("Owner sync rejects attached schemas")
    if conn.execute("SELECT 1 FROM sqlite_temp_master WHERE sql IS NOT NULL LIMIT 1").fetchone():
        raise sqlite3.DatabaseError("Owner sync rejects temporary schema objects")


def _verify_core(conn, actual: dict) -> dict:
    _local_connection(conn)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if type(version) is not int or version != 9:
        raise sqlite3.DatabaseError("Owner sync requires core schema 9")
    expected = dict(expected_objects())
    expected.update(_implicit_indexes(False))
    if ("table", "_schema_version") in actual:
        expected[("table", "_schema_version")] = VERSION_DDL
        rows = conn.execute("SELECT singleton,version FROM _schema_version").fetchall()
        if len(rows) != 1 or tuple(rows[0]) != (1, 9):
            raise sqlite3.DatabaseError("Owner sync core schema version mismatch")
    for key, ddl in expected.items():
        if key not in actual or not _same_ddl(actual[key], ddl):
            raise sqlite3.DatabaseError("Owner sync core schema contract mismatch")
    return expected


def verify_owner_sync_schema(conn) -> None:
    """SELECT/PRAGMA only. Unknown objects and incompatible versions fail closed."""
    _local_connection(conn)
    actual = _objects(conn)
    expected = _verify_core(conn, actual)
    expected.update({("table", name): ddl for name, ddl in OWNER_SYNC_DDL.items()})
    expected.update(_implicit_indexes(True))
    if set(actual) != set(expected):
        raise sqlite3.DatabaseError("Owner sync schema contains missing or unknown objects")
    for key, ddl in expected.items():
        if not _same_ddl(actual[key], ddl):
            raise sqlite3.DatabaseError("Owner sync schema contract mismatch")
    rows = conn.execute("SELECT singleton,version FROM owner_sync_schema").fetchall()
    if len(rows) != 1 or tuple(rows[0]) != (1, OWNER_SYNC_SCHEMA_VERSION):
        raise sqlite3.DatabaseError("Owner sync extension version mismatch")
    rows = conn.execute("SELECT singleton,revision FROM owner_sync_state").fetchall()
    if len(rows) != 1 or rows[0][0] != 1 or type(rows[0][1]) is not int or not 0 <= rows[0][1] <= MAX_SAFE_INTEGER:
        raise sqlite3.DatabaseError("Owner sync state metadata mismatch")


def provision_owner_sync_candidate(conn, *, synthetic_candidate: bool = False) -> dict:
    """Trusted caller explicitly selects an isolated synthetic candidate.

    This opt-in is not proof of production isolation, an Owner privilege, or a
    release receipt. No configured connection, network, or startup hook is used.
    """
    if synthetic_candidate is not True:
        raise sqlite3.DatabaseError("Owner sync synthetic provisioning requires explicit selection")
    _local_connection(conn)
    if conn.in_transaction:
        raise sqlite3.DatabaseError("Owner sync candidate has an active transaction")
    conn.execute("BEGIN IMMEDIATE")
    try:
        actual = _objects(conn)
        core = _verify_core(conn, actual)
        if any(name in OWNER_SYNC_DDL for _kind, name in actual):
            verify_owner_sync_schema(conn)
            changed = False
        else:
            if set(actual) != set(core):
                raise sqlite3.DatabaseError("Owner sync candidate contains unrecognized objects")
            for ddl in OWNER_SYNC_DDL.values():
                conn.execute(ddl)
            conn.execute("INSERT INTO owner_sync_schema(singleton,version) VALUES(1,?)", (OWNER_SYNC_SCHEMA_VERSION,))
            conn.execute("INSERT INTO owner_sync_state(singleton,revision) VALUES(1,0)")
            verify_owner_sync_schema(conn)
            changed = True
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"schema_version": OWNER_SYNC_SCHEMA_VERSION, "core_schema_version": 9, "changed": changed, "synthetic_only": True}
