"""Explicit, read-only complete machine profile for the bounded Turso driver.

This does not select credentials, provision tables, migrate an old database or
enable any main route. The existing core/Owner-only verifiers stay closed.
One fixed deferred batch reads bounded metadata; no application payload leaves
the database. A matching schema is not business integrity, durability, restore
or formal-release qualification.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
import hashlib
import json
import math
import sqlite3
import time

from database import owner_analysis_schema as analysis
from database import owner_machine_schema as machine
from database import owner_sync_schema as owner
from database import turso, turso_schema

PROFILE = "owner-machine-cloud-profile-1"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_OPERATION_SECONDS = 30.0
_OPERATIONAL = {
    "sqlite_stat1": owner._SQLITE_STAT1_DDL,
    "universe_import_state": owner._UNIVERSE_IMPORT_STATE_DDL,
    "turso_candidate_probe_v1": """CREATE TABLE turso_candidate_probe_v1 (
        nonce_sha256 TEXT PRIMARY KEY NOT NULL,
        marker_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
}


class MachineProfileError(sqlite3.DatabaseError):
    """One non-sensitive failure; never an authorization to retry or repair."""

    def __init__(self):
        super().__init__("Turso machine candidate profile is unavailable")


@dataclass(frozen=True)
class MachineProfileManifest:
    profile: str
    objects: tuple[tuple[str, str, str, str | None], ...]
    optional_tables: tuple[str, ...]
    sha256: str

    @property
    def object_count(self) -> int:
        return len(self.objects)


@dataclass(frozen=True)
class MachineProfileInspection:
    profile: str
    core_schema_version: int
    header_user_version: int
    owner_revision: int
    object_count: int
    schema_sha256: str
    optional_tables: tuple[str, ...]
    durability_verified: bool = field(default=False, init=False)
    restore_verified: bool = field(default=False, init=False)
    formal_release_qualified: bool = field(default=False, init=False)


def machine_profile_manifest(optional_tables: tuple[str, ...] = ()) -> MachineProfileManifest:
    """Return only repository-owned DDL; construction has zero external I/O.

    The required remote _schema_version consumes one of the local optional
    slots: the raw inventory is 126, not 125. At most two fixed operational
    tables fit the unchanged 128-object scan limit. Do not hide/drop objects.
    """
    if (type(optional_tables) is not tuple or any(type(name) is not str or name not in _OPERATIONAL for name in optional_tables)
            or len(set(optional_tables)) != len(optional_tables)):
        raise MachineProfileError()
    return _manifest(tuple(sorted(optional_tables)))


@lru_cache(maxsize=8)
def _manifest(optional_tables: tuple[str, ...]) -> MachineProfileManifest:
    reference = sqlite3.connect(":memory:")
    try:
        for ddl in (*turso_schema.expected_objects().values(), turso_schema.VERSION_DDL,
                    *owner.OWNER_SYNC_DDL.values(), *analysis.OWNER_ANALYSIS_DDL.values(),
                    *analysis.OWNER_ANALYSIS_TRIGGERS.values(), *machine.OWNER_MACHINE_DDL.values(),
                    *machine.OWNER_MACHINE_TRIGGERS.values()):
            reference.execute(ddl)
        for name in optional_tables:
            if name != "sqlite_stat1":
                reference.execute(_OPERATIONAL[name])
        objects = [tuple(row) for row in reference.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")]
        if "sqlite_stat1" in optional_tables:
            # SQLite owns this internal name. Review its exact metadata rather
            # than enabling writable_schema or copying any planner contents.
            objects.append(("table", "sqlite_stat1", "sqlite_stat1", owner._SQLITE_STAT1_DDL))
        objects = tuple(sorted(objects, key=lambda row: (row[0], row[1])))
        if len(objects) > owner.MAX_SCHEMA_OBJECTS:
            raise MachineProfileError()
        raw = json.dumps({"profile": PROFILE, "objects": objects}, ensure_ascii=False,
                         sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        return MachineProfileManifest(PROFILE, objects, optional_tables, hashlib.sha256(raw).hexdigest())
    finally:
        reference.close()


def machine_profile_reads() -> tuple[tuple[str, tuple], ...]:
    """Fixed bounded SELECT/PRAGMA metadata; never accept caller SQL or DDL."""
    safe = owner.MAX_SAFE_INTEGER
    return (
        ("SELECT substr(type,1,16),"
         f"CASE WHEN typeof(name)='text' AND length(CAST(name AS BLOB))<={owner.MAX_SCHEMA_NAME_BYTES} THEN name ELSE NULL END,"
         f"CASE WHEN typeof(tbl_name)='text' AND length(CAST(tbl_name AS BLOB))<={owner.MAX_SCHEMA_NAME_BYTES} THEN tbl_name ELSE NULL END,"
         f"CASE WHEN sql IS NULL OR (typeof(sql)='text' AND length(CAST(sql AS BLOB))<={owner.MAX_SCHEMA_DDL_BYTES}) THEN sql ELSE NULL END,"
         f"length(CAST(sql AS BLOB)) FROM main.sqlite_master ORDER BY type,name LIMIT {owner.MAX_SCHEMA_OBJECTS + 1}", ()),
        ("SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(version)='integer' AND version=9 THEN 1 ELSE 0 END FROM main._schema_version LIMIT 2", ()),
        ("SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(version)='text' AND version=? THEN 1 ELSE 0 END FROM main.owner_sync_schema LIMIT 2",
         (owner.OWNER_SYNC_SCHEMA_VERSION,)),
        ("SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 THEN 1 ELSE 0 END,"
         f"CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND {safe} THEN revision ELSE NULL END "
         "FROM main.owner_sync_state LIMIT 2", ()),
        ("SELECT MAX(revision),COUNT(DISTINCT revision),COALESCE(SUM(CASE WHEN typeof(revision)='integer' "
         f"AND revision BETWEEN 1 AND {safe} THEN 0 ELSE 1 END),0) FROM main.owner_sync_changes", ()),
        ("SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(version)='text' AND version=? THEN 1 ELSE 0 END FROM main.owner_analysis_schema LIMIT 2",
         (analysis.OWNER_ANALYSIS_SCHEMA_VERSION,)),
        ("SELECT CASE WHEN typeof(schema_version)='text' AND schema_version=? THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(record_id)='text' AND record_id='schema' THEN 1 ELSE 0 END,"
         "CASE WHEN occurrence_id IS NULL AND analysis_request_id IS NULL THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(created_at)='text' AND created_at=? THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(payload_json)='text' AND payload_json=? THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(payload_hash)='text' AND payload_hash=? THEN 1 ELSE 0 END "
         "FROM main.owner_machine_journal WHERE kind='schema' LIMIT 2",
         (machine.OWNER_MACHINE_SCHEMA_VERSION, machine.MACHINE_SCHEMA_CREATED_AT,
          machine.MACHINE_SCHEMA_PAYLOAD_JSON, machine.MACHINE_SCHEMA_PAYLOAD_HASH)),
        ("SELECT CASE WHEN typeof(scope_key)='text' AND scope_key='production' THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(purpose)='text' AND purpose='production' THEN 1 ELSE 0 END,"
         "CASE WHEN namespace IS NULL THEN 1 ELSE 0 END FROM main.v8_repository_scopes LIMIT 2", ()),
        ("PRAGMA foreign_keys", ()),
        ("PRAGMA database_list", ()),
        ("SELECT 1 FROM sqlite_temp_master LIMIT 1", ()),
        ("PRAGMA user_version", ()),
    )


def _rows(cursor, limit):
    return tuple(tuple(row) for row in cursor.fetchmany(limit))


def _exact_integer_row(cursor, expected):
    rows = _rows(cursor, 2)
    return (len(rows) == 1 and len(rows[0]) == len(expected)
            and all(type(value) is int for value in rows[0]) and rows[0] == expected)


def _checked(cursors) -> MachineProfileInspection:
    if type(cursors) is not list or len(cursors) != len(machine_profile_reads()):
        raise MachineProfileError()
    rows = _rows(cursors[0], owner.MAX_SCHEMA_OBJECTS + 1)
    if not rows or len(rows) > owner.MAX_SCHEMA_OBJECTS:
        raise MachineProfileError()
    raw = []
    for row in rows:
        if (len(row) != 5 or any(type(item) is not str for item in row[:3])
                or (row[3] is not None and type(row[3]) is not str)
                or (row[4] is not None and (type(row[4]) is not int or not 1 <= row[4] <= owner.MAX_SCHEMA_DDL_BYTES))
                or (row[3] is None) != (row[4] is None)):
            raise MachineProfileError()
        raw.append(row[:4])
    names = tuple(sorted(name for kind, name, _table, _ddl in raw if kind == "table" and name in _OPERATIONAL))
    manifest = machine_profile_manifest(names)
    if len(raw) != manifest.object_count:
        raise MachineProfileError()
    for actual, expected in zip(raw, manifest.objects):
        if actual[:3] != expected[:3] or not owner._same_ddl(actual[3], expected[3]):
            raise MachineProfileError()
    for index in (1, 2, 5):
        if not _exact_integer_row(cursors[index], (1, 1)):
            raise MachineProfileError()
    state = _rows(cursors[3], 2)
    if (len(state) != 1 or len(state[0]) != 2 or type(state[0][0]) is not int or state[0][0] != 1
            or type(state[0][1]) is not int or not 0 <= state[0][1] <= owner.MAX_SAFE_INTEGER):
        raise MachineProfileError()
    head = state[0][1]
    history = _rows(cursors[4], 2)
    if (len(history) != 1 or len(history[0]) != 3 or type(history[0][1]) is not int or history[0][1] != head
            or type(history[0][2]) is not int or history[0][2] != 0
            or (head == 0 and history[0][0] is not None)
            or (head > 0 and (type(history[0][0]) is not int or history[0][0] != head))):
        raise MachineProfileError()
    if (not _exact_integer_row(cursors[6], (1, 1, 1, 1, 1, 1))
            or not _exact_integer_row(cursors[7], (1, 1, 1)) or not _exact_integer_row(cursors[8], (1,))):
        raise MachineProfileError()
    databases = _rows(cursors[9], 3)
    if (not databases or len(databases) > 2 or any(len(row) != 3 or row[1] not in {"main", "temp"} for row in databases)
            or [row[1] for row in databases].count("main") != 1
            or len({row[1] for row in databases}) != len(databases)):
        raise MachineProfileError()
    if cursors[10].fetchone() is not None:
        raise MachineProfileError()
    header = _rows(cursors[11], 2)
    if len(header) != 1 or len(header[0]) != 1 or type(header[0][0]) is not int or header[0][0] not in {0, 8, 9}:
        raise MachineProfileError()
    return MachineProfileInspection(PROFILE, 9, header[0][0], head, manifest.object_count,
                                    manifest.sha256, manifest.optional_tables)


def verify_turso_machine_profile(conn: turso.Connection) -> MachineProfileInspection:
    """Read one bounded metadata snapshot using the actual remote driver only.

    Caller owns its explicit URL/token, connection and close. An active stream
    transaction or an unbounded/default driver is refused before any request.
    Errors are sanitized; no automatic retry, migration or fallback is present.
    """
    if not isinstance(conn, turso.Connection):
        raise MachineProfileError()
    limits = conn._http_limits
    if (conn.in_transaction is not False
            or type(limits) is not turso.HttpLimits or limits.seconds > MAX_OPERATION_SECONDS
            or limits.max_response_bytes > MAX_RESPONSE_BYTES):
        raise MachineProfileError()
    try:
        started = time.monotonic()
        if type(started) not in (int, float) or not math.isfinite(started):
            raise MachineProfileError()
        conn._check()
        conn._remaining()
        cursors = conn.execute_batch(machine_profile_reads(), atomic=True, begin_mode="deferred")
        value = inspect_machine_profile_snapshot(cursors)
        conn._remaining()
        finished = time.monotonic()
        if (type(finished) not in (int, float) or not math.isfinite(finished)
                or finished < started or finished - started > limits.seconds):
            raise MachineProfileError()
        return value
    except MachineProfileError:
        raise
    except Exception:
        raise MachineProfileError() from None


def inspect_machine_profile_snapshot(cursors: list) -> MachineProfileInspection:
    """Parse the fixed read results, without certifying transport provenance.

    A controlled compiler/rehearsal can consume the exact same read contract on
    its own trusted reference. This pure parser is not cloud or send authority.
    """
    try:
        return _checked(cursors)
    except MachineProfileError:
        raise
    except Exception:
        raise MachineProfileError() from None
