"""Explicit bounded Turso Owner repository; not enabled by main or a migrator.

Each read is one fixed BEGIN DEFERRED batch. A write computes the existing
business plan outside the remote transaction, then sends ONE atomic batch.
An internal stream-local TEMP row selects planned writes or a saved, canonical
409 for legitimate monotonic head changes. Existing request slots are replayed.
There is no automatic retry, alternate credential, initialization, input DDL,
or fallback to a local database. A separately controlled migration must first
install core schema-table 9 and the complete Owner extension.
"""
from __future__ import annotations

from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from functools import lru_cache
from itertools import islice
import math
import sqlite3
import time

from database import owner_sync_schema as schema, turso, turso_schema
from models.owner_sync import allowed_fields, parse_sync_request
from service import owner_sync_repo as local

MAX_SECONDS = 30.0
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_BATCH_STATEMENTS = 1024
MAX_STATEMENT_ARGS = 900
_RECORD_COLUMNS = ("sync_key", "kind", "deleted", "record_revision", "lifecycle_revision",
                   "field_revisions_json", "payload_json")
_LATEST_COLUMNS = ("sync_key", "revision", "snapshot_json")
_RECEIPT_COLUMNS = ("request_id", "request_hash", "status", "response_json")
# Repository-owned optional operational contracts, not captured/input DDL.
_OPERATIONAL = {
    "sqlite_stat1": schema._SQLITE_STAT1_DDL,
    "universe_import_state": schema._UNIVERSE_IMPORT_STATE_DDL,
    "turso_candidate_probe_v1": """CREATE TABLE turso_candidate_probe_v1 (
        nonce_sha256 TEXT PRIMARY KEY NOT NULL,
        marker_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
}
_CONTEXT = "temp.owner_sync_write_context"
_BUSINESS_GATE = (f"(SELECT new_receipt FROM {_CONTEXT} WHERE singleton=1)=1 AND EXISTS "
                  "(SELECT 1 FROM main.owner_sync_receipts WHERE request_id=? AND request_hash=? AND status=200)")
_CONTEXT_DDL = """CREATE TEMP TABLE owner_sync_write_context (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    new_receipt INTEGER NOT NULL CHECK(typeof(new_receipt)='integer' AND new_receipt IN (0,1)),
    branch INTEGER NOT NULL CHECK(typeof(branch)='integer' AND branch IN (0,1))
) WITHOUT ROWID"""
_UPSERT = ("INSERT INTO main.owner_sync_records(sync_key,kind,deleted,record_revision,lifecycle_revision,"
           "field_revisions_json,payload_json) SELECT ?,?,?,?,?,?,? WHERE " + _BUSINESS_GATE + " ON CONFLICT(sync_key) DO UPDATE SET "
           "kind=excluded.kind,deleted=excluded.deleted,record_revision=excluded.record_revision,"
           "lifecycle_revision=excluded.lifecycle_revision,field_revisions_json=excluded.field_revisions_json,"
           "payload_json=excluded.payload_json")


class _Deadline:
    def __init__(self, seconds):
        if (type(seconds) not in (int, float) or not math.isfinite(seconds)
                or not 0 < seconds <= MAX_SECONDS):
            raise ValueError("Invalid Owner operation budget")
        self.end = time.monotonic() + seconds

    def remaining(self):
        left = self.end - time.monotonic()
        if not math.isfinite(left) or left <= 0:
            raise local.SyncReadError("storage_unavailable")
        return left


@dataclass(frozen=True, repr=False)
class _Snapshot:
    objects: tuple
    head: int
    history: tuple
    extras: tuple


class _ReadRows:
    """Materialized, bounded rows which survive closing the HTTP connection."""
    __slots__ = ("_rows",)

    def __init__(self, rows):
        self._rows = iter(tuple(tuple(row) for row in rows))

    def fetchone(self):
        return next(self._rows, None)

    def fetchmany(self, size):
        return list(islice(self._rows, size))


def _bounded_text(column: str, maximum: int) -> str:
    # Column and maximum are closed source constants, never request strings.
    return f"CASE WHEN typeof({column})='text' AND length(CAST({column} AS BLOB))<={maximum} THEN {column} ELSE NULL END"


def _base_reads():
    safe = local.MAX_SAFE_REVISION
    return [
        ("SELECT substr(type,1,16)," + _bounded_text("name", schema.MAX_SCHEMA_NAME_BYTES) + ","
         + _bounded_text("tbl_name", schema.MAX_SCHEMA_NAME_BYTES) + ","
         + f"CASE WHEN sql IS NULL OR length(CAST(sql AS BLOB))<={schema.MAX_SCHEMA_DDL_BYTES} THEN sql ELSE NULL END,"
         + f"length(CAST(sql AS BLOB)) FROM main.sqlite_master ORDER BY type,name LIMIT {schema.MAX_SCHEMA_OBJECTS + 1}", ()),
        ("SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(version)='integer' AND version=9 THEN 1 ELSE 0 END FROM main._schema_version LIMIT 2", ()),
        ("SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 THEN 1 ELSE 0 END,"
         "CASE WHEN typeof(version)='text' AND version=? THEN 1 ELSE 0 END FROM main.owner_sync_schema LIMIT 2",
         (schema.OWNER_SYNC_SCHEMA_VERSION,)),
        ("SELECT CASE WHEN typeof(singleton)='integer' AND singleton=1 THEN 1 ELSE 0 END,"
         f"CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND {safe} THEN revision ELSE NULL END "
         "FROM main.owner_sync_state LIMIT 2", ()),
        ("SELECT MAX(revision),COUNT(DISTINCT revision),COALESCE(SUM(CASE WHEN typeof(revision)='integer' "
         f"AND revision BETWEEN 1 AND {safe} THEN 0 ELSE 1 END),0) FROM main.owner_sync_changes", ()),
        ("PRAGMA foreign_keys", ()),
        ("PRAGMA database_list", ()),
        ("SELECT 1 FROM sqlite_temp_master WHERE sql IS NOT NULL LIMIT 1", ()),
    ]


@lru_cache(maxsize=4)
def _canonical_objects(optional_names: tuple):
    reference = sqlite3.connect(":memory:")
    try:
        for ddl in turso_schema.expected_objects().values():
            reference.execute(ddl)
        reference.execute(turso_schema.VERSION_DDL)
        for ddl in schema.OWNER_SYNC_DDL.values():
            reference.execute(ddl)
        for name in optional_names:
            if name != "sqlite_stat1":
                reference.execute(_OPERATIONAL[name])
        rows = list(tuple(row) for row in reference.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"))
        if "sqlite_stat1" in optional_names:
            # Never CREATE an sqlite_* object or read optimizer data. Use the
            # exact independently reviewed, repository-owned metadata tuple.
            rows.append(("table", "sqlite_stat1", "sqlite_stat1", schema._SQLITE_STAT1_DDL))
        return tuple(sorted(rows, key=lambda row: (row[0], row[1])))
    finally:
        reference.close()


def _check_snapshot(cursors) -> _Snapshot:
    objects = tuple(tuple(row) for row in cursors[0].fetchmany(schema.MAX_SCHEMA_OBJECTS + 1))
    if not 1 <= len(objects) <= schema.MAX_SCHEMA_OBJECTS:
        raise local.SyncReadError("schema_unavailable")
    raw = []
    for row in objects:
        if (len(row) != 5 or type(row[0]) is not str or type(row[1]) is not str
                or type(row[2]) is not str or (row[3] is not None and type(row[3]) is not str)
                or (row[4] is not None and (type(row[4]) is not int or row[4] > schema.MAX_SCHEMA_DDL_BYTES))
                or (row[3] is None) != (row[4] is None)):
            raise local.SyncReadError("schema_unavailable")
        raw.append(row[:4])
    names = tuple(sorted(name for kind, name, _table, _sql in raw if kind == "table" and name in _OPERATIONAL))
    canonical = _canonical_objects(names)
    if len(raw) != len(canonical):
        raise local.SyncReadError("schema_unavailable")
    for actual, expected in zip(raw, canonical):
        if (actual[:3] != expected[:3] or (actual[3] is None) != (expected[3] is None)
                or actual[3] is not None and turso_schema._normalize_ddl(actual[3]) != turso_schema._normalize_ddl(expected[3])):
            raise local.SyncReadError("schema_unavailable")
    if (tuple(tuple(row) for row in cursors[1].fetchmany(2)) != ((1, 1),)
            or tuple(tuple(row) for row in cursors[2].fetchmany(2)) != ((1, 1),)):
        raise local.SyncReadError("schema_unavailable")
    states = tuple(tuple(row) for row in cursors[3].fetchmany(2))
    if len(states) != 1 or states[0][0] != 1:
        raise local.SyncReadError("integrity_unavailable")
    head = local._revision(states[0][1])
    histories = tuple(tuple(row) for row in cursors[4].fetchmany(2))
    if len(histories) != 1 or len(histories[0]) != 3 or histories[0][2] != 0:
        raise local.SyncReadError("integrity_unavailable")
    history = histories[0][:2]
    if ((history[0] is not None and local._revision(history[0], 1) != head)
            or local._revision(history[1]) != head):
        raise local.SyncReadError("integrity_unavailable")
    if tuple(tuple(row) for row in cursors[5].fetchmany(2)) != ((1,),):
        raise local.SyncReadError("storage_unavailable")
    databases = tuple(tuple(row) for row in cursors[6].fetchmany(3))
    if not databases or len(databases) > 2 or any(len(row) != 3 or row[1] not in {"main", "temp"} for row in databases):
        raise local.SyncReadError("schema_unavailable")
    if cursors[7].fetchone() is not None:
        raise local.SyncReadError("schema_unavailable")
    return _Snapshot(tuple(raw), head, history, tuple(_ReadRows(cursor.fetchall()) for cursor in cursors[8:]))


def _receipt_read(request_id):
    return ("SELECT request_id," + _bounded_text("request_hash", 64) + ",status,"
            + _bounded_text("response_json", local.MAX_JSON_BYTES)
            + " FROM main.owner_sync_receipts WHERE request_id=? LIMIT 2", (request_id,))


def _receipt(cursor, request_id, head):
    rows = tuple(tuple(row) for row in cursor.fetchmany(2))
    if not rows:
        return None
    if (len(rows) != 1 or rows[0][0] != request_id or type(rows[0][1]) is not str
            or not local._HASH.fullmatch(rows[0][1])):
        raise local._IntegrityError()
    row = rows[0]
    return local.StoredReceipt(row[0], row[1], local._validate_result(row[2], row[3], head))


def _record_reads(keys, request_id):
    marks = ",".join("?" for _ in keys)
    absent = " AND NOT EXISTS (SELECT 1 FROM main.owner_sync_receipts WHERE request_id=?)"
    current = ("SELECT sync_key,kind,deleted,record_revision,lifecycle_revision,"
               + _bounded_text("field_revisions_json", local.MAX_JSON_BYTES) + ","
               + _bounded_text("payload_json", local.MAX_JSON_BYTES)
               + f" FROM main.owner_sync_records WHERE sync_key IN ({marks})" + absent + " ORDER BY sync_key LIMIT 201")
    latest = ("WITH latest AS (SELECT sync_key,MAX(revision) AS revision FROM main.owner_sync_changes "
              + f"WHERE sync_key IN ({marks}) GROUP BY sync_key) SELECT c.sync_key,c.revision,"
              + _bounded_text("c.snapshot_json", local.MAX_JSON_BYTES)
              + " FROM latest h JOIN main.owner_sync_changes c ON c.sync_key=h.sync_key AND c.revision=h.revision "
              + "WHERE 1" + absent + " ORDER BY c.sync_key LIMIT 201")
    return [(current, (*keys, request_id)), (latest, (*keys, request_id))]


def _records(current_rows, latest_rows, head):
    latest = {}
    for key, revision, raw in latest_rows:
        if key in latest:
            raise local._IntegrityError()
        latest[key] = (revision, raw)
    result = {}
    for row in current_rows:
        key = row[0]
        if key in result or type(row[2]) is not int or row[2] not in (0, 1):
            raise local._IntegrityError()
        value = local._validate_record(local._envelope(key, row[1], bool(row[2]), row[3], row[4],
                                      local._decoded(row[5]), local._decoded(row[6])), upper=head)
        if key not in latest or latest[key][0] != value["record_revision"] or local._json(local._decoded(latest[key][1])) != local._json(value):
            raise local._IntegrityError()
        result[key] = value
    if set(result) != set(latest):
        raise local._IntegrityError()
    return result


def _guard(predicate, args=(), prefix=""):
    # A false/NULL predicate must raise, not merely return an ignored zero row.
    return (prefix + "SELECT CASE WHEN (" + predicate + ") THEN 1 ELSE "
            "abs(-9223372036854775808) END AS guard_passed", tuple(args))


def _same_sql(actual, expected):
    return (f"(typeof({actual})=typeof({expected}) AND CASE WHEN typeof({expected}) IN ('text','blob') "
            f"THEN CAST({actual} AS BLOB) IS CAST({expected} AS BLOB) ELSE {actual} IS {expected} END)")


def _raw_guard(table, columns, rows, *, count_predicate=None, count_args=(), planned_only=False):
    result = []
    def conditional(predicate):
        return f"(SELECT branch FROM {_CONTEXT} WHERE singleton=1)=0 OR ({predicate})" if planned_only else predicate
    if count_predicate is not None:
        result.append(_guard(conditional(count_predicate), count_args))
    if not rows:
        return result
    aliases = tuple(f"e{index}" for index in range(len(columns)))
    width = len(columns)
    for offset in range(0, len(rows), MAX_STATEMENT_ARGS // width):
        chunk = rows[offset:offset + MAX_STATEMENT_ARGS // width]
        slots = ",".join("(" + ",".join("?" for _ in columns) + ")" for _ in chunk)
        checks = " AND ".join(_same_sql('a."' + name + '"', "e." + alias) for name, alias in zip(columns, aliases))
        join = " AND ".join(_same_sql('a."' + name + '"', "e." + aliases[index]) for index, name in enumerate(columns[:2] if table == "main.sqlite_master" else columns[:1]))
        result.append(_guard(conditional(f'NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS (SELECT 1 FROM {table} a WHERE {join} AND {checks}))'),
                             tuple(value for row in chunk for value in row),
                             "WITH expected(" + ",".join(aliases) + ") AS (VALUES " + slots + ") "))
    return result


def _latest_guard(keys, rows):
    marks = ",".join("?" for _ in keys)
    prefix = ("WITH latest AS (SELECT sync_key,MAX(revision) AS revision FROM main.owner_sync_changes "
              f"WHERE sync_key IN ({marks}) GROUP BY sync_key)")
    predicate = "(SELECT COUNT(*) FROM latest)=?"
    args = (*keys,)
    if rows:
        slots = ",".join("(?,?,?)" for _ in rows)
        prefix += ",expected(e0,e1,e2) AS (VALUES " + slots + ")"
        checks = " AND ".join(_same_sql('a."' + name + '"', 'e.e' + str(index))
                              for index, name in enumerate(_LATEST_COLUMNS))
        predicate += (" AND NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS (SELECT 1 FROM latest h "
                      "JOIN main.owner_sync_changes a ON a.sync_key=h.sync_key AND a.revision=h.revision "
                      "WHERE " + checks + "))")
        args += tuple(value for row in rows for value in row)
    # The expected VALUES placeholders precede the predicate's count slot.
    args += (len(rows),)
    # Count PLUS MAX-membership is essential: old history rows may still exist
    # after a damaged latest-row replacement, and an absent key must stay absent.
    return _guard(f"(SELECT branch FROM {_CONTEXT} WHERE singleton=1)=0 OR ({predicate})", args, prefix + " ")


def _selected_integrity_guard(keys, head):
    """Check current/latest metadata even when a legitimate head race occurred.

    No business merge or float serialization is duplicated in SQL. The latest
    envelope must be the exact composition of current scalar metadata and its
    stored JSON fragments; fresh pulls still use the existing Python DTO rules.
    This is the selected read set, not a claim to detect arbitrary global SQL.
    """
    marks = ",".join("?" for _ in keys)
    prefix = ("WITH latest AS (SELECT sync_key,MAX(revision) AS revision FROM main.owner_sync_changes "
              f"WHERE sync_key IN ({marks}) GROUP BY sync_key) ")
    # Fixed key sets are checked without evaluating request-supplied JSON paths.
    allowed = "((r.kind='manual_asset' AND j.key IN ('cls','name','note','value')) OR (r.kind<>'manual_asset' AND j.key IN ('cost','name','shares','target_weight')))"
    fragments = []
    for column in ("field_revisions_json", "payload_json"):
        fragments.append(f"typeof(r.{column})='text' AND json_valid(r.{column}) AND json_type(r.{column})='object'")
        fragments.append(f"(SELECT COUNT(*) FROM json_each(r.{column}))=4 AND (SELECT COUNT(DISTINCT key) FROM json_each(r.{column}))=4")
        fragments.append(f"NOT EXISTS (SELECT 1 FROM json_each(r.{column}) j WHERE NOT {allowed})")
    fragments.append("NOT EXISTS (SELECT 1 FROM json_each(r.field_revisions_json) j WHERE j.type<>'integer' OR j.value<1 OR j.value>r.record_revision)")
    expected = ("'{\"deleted\":'||CASE r.deleted WHEN 0 THEN 'false' ELSE 'true' END"
                "||',\"field_revisions\":'||r.field_revisions_json||',\"key\":'||json_quote(r.sync_key)"
                "||',\"kind\":'||json_quote(r.kind)||',\"lifecycle_revision\":'||CAST(r.lifecycle_revision AS TEXT)"
                "||',\"record_revision\":'||CAST(r.record_revision AS TEXT)||',\"values\":'||r.payload_json||'}'")
    valid = ("h.revision IS NOT NULL AND typeof(r.kind)='text' AND r.kind IN ('watch','holding','manual_asset') AND "
             "typeof(r.deleted)='integer' AND r.deleted IN (0,1) AND typeof(r.record_revision)='integer' AND "
             f"r.record_revision BETWEEN 1 AND {head} AND r.record_revision=h.revision AND "
             "typeof(r.lifecycle_revision)='integer' AND r.lifecycle_revision BETWEEN 1 AND r.record_revision AND "
             + " AND ".join(fragments) + " AND typeof(c.snapshot_json)='text' AND CAST(c.snapshot_json AS BLOB) IS CAST((" + expected + ") AS BLOB)")
    predicate = ("NOT EXISTS (SELECT 1 FROM latest h LEFT JOIN main.owner_sync_records r ON r.sync_key=h.sync_key WHERE r.sync_key IS NULL) AND "
                 "NOT EXISTS (SELECT 1 FROM main.owner_sync_records r LEFT JOIN latest h ON h.sync_key=r.sync_key "
                 "LEFT JOIN main.owner_sync_changes c ON c.sync_key=h.sync_key AND c.revision=h.revision "
                 f"WHERE r.sync_key IN ({marks}) AND CASE WHEN {valid} THEN 1 ELSE 0 END=0)")
    return _guard(predicate, (*keys, *keys), prefix)


def _write_batch(snapshot, request, request_hash, keys, current_rows, latest_rows, counts, result, writes, deltas):
    statements, failures = [], {}
    def guards(items, code):
        for item in items:
            failures[len(statements)] = code
            statements.append(item)
    guards(_raw_guard("main.sqlite_master", ("type", "name", "tbl_name", "sql"), snapshot.objects,
                      count_predicate="(SELECT COUNT(*) FROM main.sqlite_master)=?", count_args=(len(snapshot.objects),)),
           "schema_unavailable")
    guards([_guard("(SELECT foreign_keys FROM pragma_foreign_keys)=1 AND "
                   "(SELECT COUNT(*) FROM pragma_database_list WHERE name NOT IN ('main','temp'))=0 AND "
                   "NOT EXISTS (SELECT 1 FROM sqlite_temp_master WHERE sql IS NOT NULL)"),
            _guard("(SELECT COUNT(*) FROM main._schema_version)=1 AND EXISTS (SELECT 1 FROM main._schema_version "
                   "WHERE typeof(singleton)='integer' AND singleton=1 AND typeof(version)='integer' AND version=9) AND "
                   "(SELECT COUNT(*) FROM main.owner_sync_schema)=1 AND EXISTS (SELECT 1 FROM main.owner_sync_schema "
                   "WHERE typeof(singleton)='integer' AND singleton=1 AND typeof(version)='text' AND version=?)",
                   (schema.OWNER_SYNC_SCHEMA_VERSION,))], "schema_unavailable")
    head = "(SELECT revision FROM main.owner_sync_state WHERE singleton=1)"
    guards([_guard("(SELECT COUNT(*) FROM main.owner_sync_state)=1 AND EXISTS (SELECT 1 FROM main.owner_sync_state "
                   "WHERE typeof(singleton)='integer' AND singleton=1 AND typeof(revision)='integer' "
                   f"AND revision BETWEEN 0 AND {local.MAX_SAFE_REVISION}) AND "
                   f"COALESCE((SELECT MAX(revision) FROM main.owner_sync_changes),0)={head} AND "
                   f"(SELECT COUNT(DISTINCT revision) FROM main.owner_sync_changes)={head} AND "
                   f"NOT EXISTS (SELECT 1 FROM main.owner_sync_changes WHERE typeof(revision)<>'integer' OR revision<1 OR revision>{head})"),
            _guard(f"{head}>=? AND (SELECT COUNT(*) FROM main.owner_sync_records)>=? AND "
                   f"(SELECT COUNT(*) FROM main.owner_sync_changes)>=?+({head}-?) AND "
                   "(SELECT COUNT(*) FROM main.owner_sync_receipts)>=? AND "
                   f"({head}>? OR ((SELECT COUNT(*) FROM main.owner_sync_records)=? AND "
                   "(SELECT COUNT(*) FROM main.owner_sync_changes)=?))",
                   (snapshot.head, counts[0], counts[1], snapshot.head, counts[2], snapshot.head, counts[0], counts[1]))],
           "integrity_unavailable")
    guards([_selected_integrity_guard(keys, head)], "integrity_unavailable")
    statements.extend([(_CONTEXT_DDL, ()),
                       (f"INSERT INTO {_CONTEXT}(singleton,new_receipt,branch) SELECT 1,0,CASE WHEN {head}=? THEN 1 ELSE 0 END",
                        (snapshot.head,))])
    marks = ",".join("?" for _ in keys)
    guards(_raw_guard("main.owner_sync_records", _RECORD_COLUMNS, current_rows,
                      count_predicate=f"(SELECT COUNT(*) FROM main.owner_sync_records WHERE sync_key IN ({marks}))=?",
                      count_args=(*keys, len(current_rows)), planned_only=True), "integrity_unavailable")
    guards([_latest_guard(keys, latest_rows)], "integrity_unavailable")
    slot = "EXISTS (SELECT 1 FROM main.owner_sync_receipts WHERE request_id=?)"
    guards([_guard(slot + f" OR (SELECT COUNT(*) FROM main.owner_sync_receipts)<{local.MAX_RECEIPTS}", (request.request_id,)),
            _guard(slot + f" OR (SELECT branch FROM {_CONTEXT} WHERE singleton=1)=0 OR ?<>200 OR "
                   f"((SELECT COUNT(*) FROM main.owner_sync_records)+?<={local.MAX_RECORDS} AND "
                   f"(SELECT COUNT(*) FROM main.owner_sync_changes)+?<={local.MAX_CHANGES} AND "
                   f"{head}+?<={local.MAX_SAFE_REVISION})",
                   (request.request_id, result.status, deltas[0], deltas[1], int(deltas[1] > 0)))], "capacity_exhausted")
    race = local.SyncResult(409, {**local._error("sync_conflict", 409).body,
                                 "conflicts": [local._conflict("", {"expected_revision"})]})
    statements.extend([
        ("INSERT INTO main.owner_sync_receipts(request_id,request_hash,status,response_json) "
         f"SELECT ?,?,CASE WHEN branch=1 THEN ? ELSE 409 END,CASE WHEN branch=1 THEN ? ELSE ? END FROM {_CONTEXT} "
         "WHERE singleton=1 AND NOT EXISTS (SELECT 1 FROM main.owner_sync_receipts WHERE request_id=?)",
         (request.request_id, request_hash, result.status, local._json(result.body), local._json(race.body), request.request_id)),
        # Capture changes() immediately ONCE. Every later DML uses this stable
        # boolean and the actual receipt status, never a later changes() value.
        (f"UPDATE {_CONTEXT} SET new_receipt=changes() WHERE singleton=1", ()),
    ])
    inserted_index, context_index = len(statements) - 2, len(statements) - 1
    write_start = len(statements)
    statements.extend(writes)
    if result.status == 200:
        post_rows = tuple((record["key"], record["kind"], int(record["deleted"]), record["record_revision"],
                           record["lifecycle_revision"], local._json(record["field_revisions"]), local._json(record["values"]))
                          for record in result.body["records"])
        # This subset is only checked for a newly accepted planned 200; a
        # replay or saved race-409 must not compare stale planned records.
        for sql, args in _raw_guard("main.owner_sync_records", _RECORD_COLUMNS, post_rows):
            sql = sql.replace("SELECT CASE WHEN (", f"SELECT CASE WHEN NOT ({_BUSINESS_GATE}) OR (", 1)
            # The CTE args precede the gate's request_id/hash placeholders.
            statements.append((sql, (*args, request.request_id, request_hash)))
    # Validate actual selected postimage/last-change linkage even after writes.
    # A successful receipt alone is not proof of the recorded business rows.
    statements.append(_selected_integrity_guard(keys, head))
    flags_index = len(statements)
    statements.extend([(f"SELECT new_receipt,branch FROM {_CONTEXT} WHERE singleton=1", ()),
                       (f"DROP TABLE {_CONTEXT}", ())])
    final_start = len(statements)
    statements.extend([*_base_reads(), _receipt_read(request.request_id)])
    return statements, failures, final_start, (inserted_index, context_index, write_start, len(writes), flags_index)


def _planned_result(request, head, existing, counts, request_hash):
    if counts[2] >= local.MAX_RECEIPTS:
        raise local._CapacityError()
    conflicts, planned = [], []
    if request.expected_revision > head:
        conflicts.append(local._conflict("", {"expected_revision"}))
    else:
        for operation in request.operations:
            current = existing.get(operation.key)
            try:
                record, fields = local._plan(operation, current, request.expected_revision)
            except Exception:
                record, fields = None, set(allowed_fields(operation.kind))
            if fields:
                conflicts.append(local._conflict(operation.key, fields))
            elif record is not None:
                planned.append((record, current))
    if conflicts:
        return local.SyncResult(409, {**local._error("sync_conflict", 409).body, "conflicts": conflicts}), (), head, (0, 0)
    changed = [(record, current) for record, current in planned
               if current is None or record["kind"] != current["kind"] or record["deleted"] != current["deleted"]
               or not local._same_values(record["values"], current["values"])]
    revision = head + bool(changed)
    if (revision > local.MAX_SAFE_REVISION or counts[0] + sum(current is None for _, current in changed) > local.MAX_RECORDS
            or counts[1] + len(changed) > local.MAX_CHANGES):
        raise local._CapacityError()
    changed_keys = {record["key"] for record, _ in changed}
    confirmed, writes = [], []
    for record, current in planned:
        if record["key"] in changed_keys:
            record = local._stamp(record, current, revision)
            local._validate_record(record, upper=revision)
            writes.append((_UPSERT, (record["key"], record["kind"], int(record["deleted"]), record["record_revision"],
                           record["lifecycle_revision"], local._json(record["field_revisions"]), local._json(record["values"]),
                           request.request_id, request_hash)))
            writes.append(("INSERT INTO main.owner_sync_changes(revision,sync_key,snapshot_json) SELECT ?,?,? WHERE " + _BUSINESS_GATE,
                           (revision, record["key"], local._json(record), request.request_id, request_hash)))
        else:
            record = current
        confirmed.append(record)
    if changed:
        writes.append(("UPDATE main.owner_sync_state SET revision=? WHERE singleton=1 AND " + _BUSINESS_GATE,
                       (revision, request.request_id, request_hash)))
    return (local.SyncResult(200, {"revision": revision, "records": confirmed}), tuple(writes), revision,
            (sum(current is None for _, current in changed), len(changed)))


class TursoOwnerSyncRepository:
    """Only explicit URL/token input. Constructing performs no HTTP or SQL.

    The caller owns Owner authentication, operation consent and response-time
    revalidation. main deliberately does NOT construct this repository yet.
    Tokens are never retained in results, errors, reprs, receipts or logs.
    """
    def __init__(self, url: str, token: str, *, timeout_seconds=8.0, operation_seconds=MAX_SECONDS):
        self._url = turso._base_url(url)
        if (type(token) is not str or not 1 <= len(token) <= 8192 or not token.isascii()
                or any(ord(char) < 33 or ord(char) > 126 for char in token)):
            raise ValueError("Explicit Owner database credential required")
        if (type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds)
                or not 0 < timeout_seconds <= 60):
            raise ValueError("Invalid Owner database timeout")
        _Deadline(operation_seconds)
        self._token, self._timeout, self._seconds = token, timeout_seconds, operation_seconds

    def _connection(self, deadline):
        conn = turso.connect(self._url, self._token, min(self._timeout, deadline.remaining()),
                             http_limits=turso.HttpLimits(deadline.remaining(), MAX_RESPONSE_BYTES))
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            return conn
        except Exception:
            conn.close()
            raise

    def _snapshot(self, deadline, extras):
        with closing(self._connection(deadline)) as conn:
            cursors = conn.execute_batch([*_base_reads(), *extras], atomic=True, begin_mode="deferred")
            snapshot = _check_snapshot(cursors)
        deadline.remaining()
        return snapshot

    def apply(self, raw_request: bytes | str, *, before_commit: Callable[[], None] | None = None):
        deadline = _Deadline(self._seconds)
        try:
            request = parse_sync_request(raw_request)
            request_hash = request.request_hash()
        except Exception:
            return local._error("invalid_request", 422)
        if before_commit:
            before_commit()
        keys = tuple(operation.key for operation in request.operations)
        count_reads = [(f"SELECT COUNT(*) FROM (SELECT 1 FROM main.{table} LIMIT {maximum + 1})", ())
                       for table, maximum in (("owner_sync_records", local.MAX_RECORDS),
                                               ("owner_sync_changes", local.MAX_CHANGES),
                                               ("owner_sync_receipts", local.MAX_RECEIPTS))]
        authorizing = False
        try:
            snapshot = self._snapshot(deadline, [_receipt_read(request.request_id), *count_reads,
                                                  *_record_reads(keys, request.request_id)])
            receipt = _receipt(snapshot.extras[0], request.request_id, snapshot.head)
            if receipt is not None:
                deadline.remaining()
                authorizing = True
                if before_commit:
                    before_commit()
                authorizing = False
                deadline.remaining()
                return receipt.result if receipt.request_hash == request_hash else local._error("idempotency_conflict", 409)
            counts = tuple(local._revision(cursor.fetchone()[0]) for cursor in snapshot.extras[1:4])
            if any(count > maximum for count, maximum in zip(counts, (local.MAX_RECORDS, local.MAX_CHANGES, local.MAX_RECEIPTS))):
                raise local._CapacityError()
            current_rows = tuple(tuple(row) for row in snapshot.extras[4].fetchmany(201))
            latest_rows = tuple(tuple(row) for row in snapshot.extras[5].fetchmany(201))
            if len(current_rows) > 200 or len(latest_rows) > 200:
                raise local._IntegrityError()
            existing = _records(current_rows, latest_rows, snapshot.head)
            result, writes, _revision, deltas = _planned_result(request, snapshot.head, existing, counts, request_hash)
            serialized = local._json(result.body)
            if len(serialized.encode("utf-8")) > local.MAX_JSON_BYTES:
                raise local._CapacityError()
            statements, failures, final_start, indexes = _write_batch(
                snapshot, request, request_hash, keys, current_rows, latest_rows, counts, result, writes, deltas)
            if len(statements) > MAX_BATCH_STATEMENTS or any(len(args) > MAX_STATEMENT_ARGS for _, args in statements):
                raise local._CapacityError()
            deadline.remaining()
        except local.SyncReadError as error:
            if authorizing:
                raise
            return local._error(error.code)
        except local._CapacityError:
            if authorizing:
                raise
            return local._error("capacity_exhausted")
        except local._IntegrityError:
            if authorizing:
                raise
            return local._error("integrity_unavailable")
        except Exception:
            if authorizing:
                raise
            return local._error("storage_unavailable")
        attempted = False
        authorizing = False
        try:
            with closing(self._connection(deadline)) as conn:
                authorizing = True
                if before_commit:
                    before_commit()
                authorizing = False
                deadline.remaining()
                attempted = True
                cursors = conn.execute_batch(statements, atomic=True, classify_errors=True)
                inserted_index, context_index, write_start, write_count, flags_index = indexes
                flags = tuple(tuple(row) for row in cursors[flags_index].fetchmany(2))
                if (len(flags) != 1 or len(flags[0]) != 2
                        or any(type(flag) is not int or flag not in (0, 1) for flag in flags[0])):
                    raise local._IntegrityError()
                new_receipt, branch = flags[0]
                actual = _check_snapshot(cursors[final_start:])
                receipt = _receipt(actual.extras[0], request.request_id, actual.head)
                if receipt is None:
                    raise local._IntegrityError()
                if new_receipt:
                    expected = result if branch else local.SyncResult(409, {**local._error("sync_conflict", 409).body,
                                                                          "conflicts": [local._conflict("", {"expected_revision"})]})
                    if receipt.request_hash != request_hash or receipt.result != expected:
                        raise local._IntegrityError()
                affected = int(new_receipt == 1 and branch == 1 and receipt.result.status == 200)
                if (cursors[inserted_index].rowcount != new_receipt or cursors[context_index].rowcount != 1
                        or any(cursor.rowcount != affected for cursor in cursors[write_start:write_start + write_count])):
                    raise local._IntegrityError()
                # Same ID/different hash never exposes the existing private body.
                result = receipt.result if receipt.request_hash == request_hash else local._error("idempotency_conflict", 409)
            deadline.remaining()
            return result
        except turso.TursoBatchError as error:
            if error.rollback_acknowledged and error.statement_index in failures:
                return local._error(failures[error.statement_index])
            return local._error("sync_result_unknown")
        except Exception:
            if authorizing:
                raise
            return local._error("sync_result_unknown" if attempted else "storage_unavailable")

    def reconcile(self, request_id: str, request_hash: str):
        if (type(request_id) is not str or not local._REQUEST_ID.fullmatch(request_id)
                or type(request_hash) is not str or not local._HASH.fullmatch(request_hash)):
            return local.SyncReconciliation("unavailable", request_id)
        try:
            deadline = _Deadline(self._seconds)
            snapshot = self._snapshot(deadline, [_receipt_read(request_id)])
            receipt = _receipt(snapshot.extras[0], request_id, snapshot.head)
            deadline.remaining()
            if receipt is None:
                return local.SyncReconciliation("absent", request_id)
            if receipt.request_hash != request_hash:
                return local.SyncReconciliation("unavailable", request_id)
            return local.SyncReconciliation("matched", request_id, receipt.result)
        except Exception:
            return local.SyncReconciliation("unavailable", request_id)

    def read_changes(self, *, since_revision=0, upper_revision=None, cursor=None, limit=100):
        try:
            local._revision(since_revision)
            if upper_revision is not None:
                local._revision(upper_revision)
            if type(limit) is not int or not 1 <= limit <= local.MAX_PAGE_SIZE:
                raise local._IntegrityError()
            if cursor is not None:
                if (type(cursor) is not tuple or len(cursor) != 2 or type(cursor[1]) is not str
                        or len(cursor[1]) > 160):
                    raise local._IntegrityError()
                local._revision(cursor[0])
                if cursor[0] == 0 and cursor[1] != "":
                    raise local._IntegrityError()
        except Exception:
            raise local.SyncReadError("invalid_request", 422) from None
        after_revision, after_key = cursor or (0, "")
        upper_sql = "COALESCE(?,(SELECT revision FROM main.owner_sync_state WHERE singleton=1))"
        rows_sql = ("SELECT revision,sync_key," + _bounded_text("snapshot_json", local.MAX_JSON_BYTES)
                    + " FROM main.owner_sync_changes WHERE revision>? AND revision<=" + upper_sql
                    + " AND (revision>? OR (revision=? AND sync_key>?)) ORDER BY revision,sync_key LIMIT ?")
        cursor_sql = "SELECT 1 FROM main.owner_sync_changes WHERE revision=? AND sync_key=? LIMIT 1"
        try:
            deadline = _Deadline(self._seconds)
            snapshot = self._snapshot(deadline, [
                (rows_sql, (since_revision, upper_revision, after_revision, after_revision, after_key, limit + 1)),
                (cursor_sql, (after_revision, after_key))])
            upper = snapshot.head if upper_revision is None else upper_revision
            if (upper > snapshot.head or since_revision > upper or after_revision > upper
                    or cursor is not None and after_revision < since_revision
                    or cursor is not None and after_revision > 0 and snapshot.extras[1].fetchone() is None):
                raise local.SyncReadError("invalid_request", 422)
            decoded = []
            for row in snapshot.extras[0].fetchmany(limit + 1):
                revision = local._revision(row[0], 1)
                record = local._validate_record(local._decoded(row[2]), upper=upper)
                if record["key"] != row[1] or record["record_revision"] != revision:
                    raise local._IntegrityError()
                decoded.append(record)
            more, records = len(decoded) > limit, decoded[:limit]
            next_cursor = (records[-1]["record_revision"], records[-1]["key"]) if more else None
            deadline.remaining()
            return {"upper_revision": upper, "changes": records, "next_cursor": next_cursor, "complete": not more}
        except local.SyncReadError:
            raise
        except local._IntegrityError:
            raise local.SyncReadError("integrity_unavailable") from None
        except Exception:
            raise local.SyncReadError("storage_unavailable") from None
