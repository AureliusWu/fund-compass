"""Bounded, one-request Hrana capture into a private schema-8 SQLite image.

No network implementation, credential discovery, file output, input DDL, or
migration is provided here. The injected transport must enforce its one-attempt
and no-redirect contract. Protocol tests do not certify that transport or Turso.
A successful capture is a historical SQL snapshot, never an apply-time guard,
remote recovery, or formal release certificate.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
import hashlib
import json
import math
import re
import sqlite3
import time
from typing import Protocol
from urllib.parse import unquote, urlsplit

from database import turso_schema, turso_scope_upgrade as offline
from service import repository_scopes


MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_PROTOCOL_NODES = 2_000_000
MAX_PROTOCOL_DEPTH = 24
MAX_ROWS = 100_000
MAX_SCHEMA_ROWS = 128
MAX_CELL_BYTES = 256 * 1024
MAX_SECONDS = 30.0
QUERY_MODE_PROFILES = frozenset({"query-only-v1", "turso-fixed-read-v1"})
_I64_MIN, _I64_MAX = -(2**63), 2**63 - 1
_U64_MAX = 2**64 - 1
_SAFE_MAX = 2**53 - 1
_INTEGER = re.compile(r"(?:0|-[1-9][0-9]*|[1-9][0-9]*)\Z", re.ASCII)
_UNSIGNED_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z", re.ASCII)
_HOST = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+turso\.io\Z", re.ASCII)
_SHA = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
ERROR_CODES = frozenset({
    "invalid_capture_arguments", "capture_origin_mismatch", "capture_time_limit",
    "capture_response_limit", "capture_protocol_invalid", "capture_http_failed",
    "capture_transport_failed", "capture_cleanup_failed", "capture_sql_failed",
    "capture_schema_mismatch", "capture_version_invalid", "capture_row_limit",
    "capture_value_invalid", "capture_local_validation_failed",
})


class SnapshotError(Exception):
    """Fixed safe errors: no URL, token, SQL, response body, or source values."""

    def __init__(self, code: str):
        super().__init__(code if code in ERROR_CODES else "capture_protocol_invalid")


class _Budget(offline._Budget):
    def check(self):
        if time.monotonic() > self.deadline:
            _fail("capture_time_limit")


class SnapshotResponse(Protocol):
    status_code: int

    def iter_content(self, chunk_size: int): ...
    def close(self) -> None: ...


class SnapshotTransport(Protocol):
    def send(self, *, url: str, headers: dict, body: bytes, timeout_seconds: float,
             max_attempts: int, allow_redirects: bool, stream: bool) -> SnapshotResponse: ...
    def close(self) -> None: ...


_SCHEMA_INVENTORY_PROFILE = "captured-schema-inventory-v1"
_SCHEMA_INVENTORY_DOMAIN = "fund-compass:captured-schema-inventory-v1"


def _schema_inventory_digest(rows):
    # Exact typed framing, not SQL normalization or a server-side certificate.
    return hashlib.sha256(offline._json_bytes({
        "domain": _SCHEMA_INVENTORY_DOMAIN,
        "columns": ["type", "name", "tbl_name", "sql"],
        "rows": [[offline._typed(value) for value in row] for row in rows],
    })).hexdigest()


@dataclass(frozen=True, slots=True, repr=False)
class _ValidatedSchemaInventory:
    """Private historical raw schema, never a signature or apply-time guard.

    All source fields remain immutable native tuples/strings/null. A later
    compiler must revalidate this closed inventory, its digest and resource /
    image / row bindings against the selected source, then assert every object
    under the actual write lock. Do not serialize with asdict or log its rows.
    """
    rows: tuple[tuple[str, str, str, str | None], ...]
    exact_sha256: str
    resource_sha256: str
    source_image_sha256: str
    source_rows_sha256: str
    profile: str = field(default=_SCHEMA_INVENTORY_PROFILE, init=False)

    def __post_init__(self):
        if type(self.rows) is not tuple or not 1 <= len(self.rows) <= MAX_SCHEMA_ROWS:
            _fail("capture_schema_mismatch")
        previous = None
        for row in self.rows:
            if type(row) is not tuple or len(row) != 4:
                _fail("capture_schema_mismatch")
            kind, name, table, sql = row
            if type(kind) is not str or kind not in {"table", "index", "trigger", "view"}:
                _fail("capture_schema_mismatch")
            for value in (kind, name, table):
                if not _text(value) or "\x00" in value:
                    _fail("capture_schema_mismatch")
            if sql is not None:
                _text(sql)
            key = (kind.encode("utf-8"), name.encode("utf-8"))
            if previous is not None and key <= previous:
                _fail("capture_schema_mismatch")
            previous = key
        for digest in (self.exact_sha256, self.resource_sha256,
                       self.source_image_sha256, self.source_rows_sha256):
            if type(digest) is not str or not _SHA.fullmatch(digest):
                _fail("capture_value_invalid")
        if self.exact_sha256 != _schema_inventory_digest(self.rows):
            _fail("capture_schema_mismatch")


@dataclass
class CapturedSnapshot:
    # Private ownership is explicit. repr must never dump source records.
    connection: sqlite3.Connection = field(repr=False)
    safe_metadata: dict
    _schema_inventory: _ValidatedSchemaInventory | None = field(default=None, repr=False, kw_only=True)

    def close(self) -> None:
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _fail(code="capture_protocol_invalid"):
    raise SnapshotError(code)


def _text(value, *, maximum=MAX_CELL_BYTES):
    if type(value) is not str:
        _fail("capture_value_invalid")
    try:
        if len(value.encode("utf-8", errors="strict")) > maximum:
            _fail("capture_value_invalid")
    except UnicodeError:
        _fail("capture_value_invalid")
    return value


def _origin(value):
    if type(value) is not str or len(value) > 512 or not value.isascii():
        _fail("invalid_capture_arguments")
    try:
        parts = urlsplit(value)
        host = parts.hostname
        valid = (parts.scheme in {"https", "libsql"} and host and _HOST.fullmatch(host)
                 and parts.username is None and parts.password is None
                 and parts.port in (None, 443) and parts.path in ("", "/")
                 and not parts.query and not parts.fragment
                 and not any(c.isspace() for c in value) and "\\" not in value)
    except (ValueError, TypeError):
        valid = False
    if not valid:
        _fail("invalid_capture_arguments")
    return "https://" + host


def _same_stream_origin(value, origin):
    if value is None:
        return
    _text(value, maximum=2048)
    try:
        parts = urlsplit(value)
        path = unquote(parts.path)
        valid = (parts.scheme == "https" and parts.hostname == urlsplit(origin).hostname
                 and parts.username is None and parts.password is None
                 and parts.port in (None, 443) and not parts.query and not parts.fragment
                 and not any(c.isspace() for c in value) and "\\" not in path
                 and all(segment not in {".", ".."} for segment in path.split("/")))
    except (TypeError, ValueError):
        valid = False
    if not valid:
        _fail()


def _count(value, maximum=_SAFE_MAX):
    if type(value) is not int or not 0 <= value <= maximum:
        _fail()
    return value


def _replication_index(value):
    # libSQL's JSON serde uses Option<u64> encoded as null or a decimal
    # string for this explicit protocol extension. It is not a snapshot or
    # apply-time consistency certificate, and numeric JSON is not accepted.
    if value is None:
        return
    if (type(value) is not str or len(value) > 20
            or not _UNSIGNED_INTEGER.fullmatch(value) or int(value) > _U64_MAX):
        _fail()


def _value(value):
    if type(value) is not dict or type(value.get("type")) is not str:
        _fail("capture_value_invalid")
    kind = value["type"]
    if kind == "null" and set(value) == {"type"}:
        return None
    if kind == "integer" and set(value) == {"type", "value"}:
        raw = value["value"]
        if type(raw) is not str or len(raw) > 20 or not _INTEGER.fullmatch(raw):
            _fail("capture_value_invalid")
        number = int(raw)
        if not _I64_MIN <= number <= _I64_MAX:
            _fail("capture_value_invalid")
        return number
    if kind == "float" and set(value) == {"type", "value"}:
        number = value["value"]
        if type(number) not in (int, float) or not math.isfinite(number):
            _fail("capture_value_invalid")
        try:
            return float(number)
        except (OverflowError, ValueError):
            _fail("capture_value_invalid")
    if kind == "text" and set(value) == {"type", "value"}:
        return _text(value["value"])
    if kind == "blob" and set(value) == {"type", "base64"}:
        raw = _text(value["base64"], maximum=4 * ((MAX_CELL_BYTES + 2) // 3))
        try:
            # Current Hrana emits STANDARD_NO_PAD. Permit its canonical
            # spelling and the canonical padded spelling used by older
            # clients, but never nonzero tail bits or arbitrary padding.
            unpadded = raw.rstrip("=")
            decoded = base64.b64decode(unpadded + "=" * (-len(unpadded) % 4), validate=True)
        except (ValueError, UnicodeError):
            _fail("capture_value_invalid")
        canonical = base64.b64encode(decoded).decode("ascii")
        if len(decoded) > MAX_CELL_BYTES or raw not in (canonical, canonical.rstrip("=")):
            _fail("capture_value_invalid")
        return decoded
    _fail("capture_value_invalid")


def _parse_json(raw, budget):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                _fail()
            result[key] = value
        return result

    try:
        decoded = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                             parse_constant=lambda _: _fail())
        pending, nodes = [(decoded, 0)], 0
        while pending:
            budget.check()
            item, depth = pending.pop()
            nodes += 1
            if depth > MAX_PROTOCOL_DEPTH or nodes > MAX_PROTOCOL_NODES:
                _fail("capture_response_limit")
            if type(item) is float and not math.isfinite(item):
                _fail()
            if type(item) is dict:
                for key in item:
                    _text(key, maximum=128)
                pending.extend((value, depth + 1) for value in item.values())
            elif type(item) is list:
                pending.extend((value, depth + 1) for value in item)
            elif type(item) is str:
                _text(item, maximum=MAX_RESPONSE_BYTES)
        return decoded
    except SnapshotError:
        raise
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        _fail()


def _stmt(sql):
    return {"sql": sql, "args": [], "named_args": [], "want_rows": True}


def _plan(reference, query_mode_profile="query-only-v1"):
    # All identifiers and SQL come from a fixed repository reference, never the
    # remote schema response. Closed optional inventories avoid a metadata call.
    if type(query_mode_profile) is not str or query_mode_profile not in QUERY_MODE_PROFILES:
        _fail("invalid_capture_arguments")
    fixed = [
        ("begin", "BEGIN"),
        ("query_only", "PRAGMA query_only"),
        ("schema", "SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name LIMIT 129"),
        ("temp_schema", "SELECT type,name,tbl_name,sql FROM temp.sqlite_master ORDER BY type,name LIMIT 129"),
        ("databases", "PRAGMA database_list"),
        ("header", "PRAGMA main.user_version"),
        ("foreign_keys", "PRAGMA main.foreign_key_check"),
        ("integrity", "PRAGMA main.quick_check(1)"),
    ]
    if query_mode_profile == "query-only-v1":
        fixed.insert(0, ("query_only_on", "PRAGMA query_only=ON"))
    tables = {}
    for kind, table in sorted(offline._objects(reference)):
        if kind == "table":
            sql = f'SELECT rowid,* FROM main."{table}" ORDER BY rowid LIMIT {MAX_ROWS + 1}'
            columns = tuple(row[1] for row in reference.execute(f'PRAGMA table_info("{table}")'))
            tables[table] = columns
            fixed.append(("table:" + table, sql))
    steps, names, columns = [], [], []
    for name, sql in fixed:
        step = {"stmt": _stmt(sql)}
        if steps:
            step["condition"] = {"type": "and", "conds": [
                {"type": "ok", "step": len(steps) - 1},
                ({"type": "is_autocommit"} if name == "begin" else
                 {"type": "not", "cond": {"type": "is_autocommit"}}),
            ]}
        steps.append(step)
        names.append(name)
        # Only SELECT/readonly PRAGMA description discovery executes in memory.
        # BEGIN and query_only assignment must not change reference state.
        if name in {"query_only_on", "begin"}:
            columns.append(())
        else:
            cursor = reference.execute(sql)
            columns.append(tuple(column[0] for column in (cursor.description or ())))
    commit_index = len(steps)
    steps.append({"stmt": _stmt("COMMIT"), "condition": {"type": "and", "conds": [
        {"type": "ok", "step": commit_index - 1},
        {"type": "not", "cond": {"type": "is_autocommit"}},
    ]}})
    steps.append({"stmt": _stmt("ROLLBACK"), "condition": {"type": "and", "conds": [
        {"type": "not", "cond": {"type": "ok", "step": commit_index}},
        {"type": "not", "cond": {"type": "is_autocommit"}},
    ]}})
    body = {"baton": None, "requests": [
        {"type": "batch", "batch": {"steps": steps}},
        {"type": "get_autocommit"}, {"type": "close"},
    ]}
    return body, names, columns, tables, commit_index


def _statement_rows(result, expected_columns, budget):
    required = {"cols", "rows", "affected_row_count", "last_insert_rowid"}
    metrics = {"rows_read", "rows_written", "query_duration_ms", "replication_index"}
    if type(result) is not dict or not required <= set(result) <= required | metrics:
        _fail()
    # Hrana documents these two fields as undefined for non-DML statements.
    # Validate their types, but never mistake a zero for proof of read-only SQL.
    _count(result["affected_row_count"])
    if result["last_insert_rowid"] is not None:
        _value({"type": "integer", "value": result["last_insert_rowid"]})
    if "replication_index" in result:
        _replication_index(result["replication_index"])
    for metric in ("rows_read", "rows_written"):
        if metric in result:
            _count(result[metric])
    if "query_duration_ms" in result:
        duration = result["query_duration_ms"]
        if type(duration) not in (int, float) or not 0 <= duration <= MAX_SECONDS * 1000:
            _fail()
    cols, raw_rows = result["cols"], result["rows"]
    if type(cols) is not list or len(cols) != len(expected_columns) or type(raw_rows) is not list:
        _fail()
    if len(raw_rows) > MAX_ROWS + 1:
        _fail("capture_row_limit")
    for col, name in zip(cols, expected_columns):
        if (type(col) is not dict or not {"name"} <= set(col) <= {"name", "decltype"}
                or col["name"] != name):
            _fail()
        if col.get("decltype") is not None:
            _text(col["decltype"], maximum=128)
    rows = []
    for raw_row in raw_rows:
        budget.check()
        if type(raw_row) is not list or len(raw_row) != len(cols):
            _fail()
        rows.append(tuple(_value(value) for value in raw_row))
    return rows


def _decode_payload(payload, origin, names, columns, commit_index, budget):
    if (type(payload) is not dict or not {"baton", "results"} <= set(payload) <= {"baton", "results", "base_url"}
            or payload["baton"] is not None):
        _fail()
    _same_stream_origin(payload.get("base_url"), origin)
    results = payload["results"]
    if type(results) is not list or len(results) != 3:
        _fail()
    for item, expected in zip(results, ("batch", "get_autocommit", "close")):
        if (type(item) is not dict or set(item) != {"type", "response"} or item["type"] != "ok"
                or type(item["response"]) is not dict or item["response"].get("type") != expected):
            _fail("capture_sql_failed")
    state = results[1]["response"]
    if (set(state) != {"type", "is_autocommit"} or type(state["is_autocommit"]) is not bool
            or state["is_autocommit"] is not True):
        _fail()
    if results[2]["response"] != {"type": "close"}:
        _fail()
    response = results[0]["response"]
    if set(response) != {"type", "result"} or type(response["result"]) is not dict:
        _fail()
    result = response["result"]
    required = {"step_results", "step_errors"}
    if not required <= set(result) <= required | {"replication_index"}:
        _fail()
    if "replication_index" in result:
        _replication_index(result["replication_index"])
    values, errors = result["step_results"], result["step_errors"]
    if (type(values) is not list or type(errors) is not list
            or len(values) != commit_index + 2 or len(errors) != len(values)):
        _fail()
    if any(error is not None for error in errors):
        _fail("capture_sql_failed")
    if any(value is None for value in values[:commit_index + 1]) or values[-1] is not None:
        _fail()
    decoded = {name: _statement_rows(value, cols, budget)
               for name, cols, value in zip(names, columns, values)}
    if decoded["begin"] or ("query_only_on" in decoded and decoded["query_only_on"]):
        _fail()
    if _statement_rows(values[commit_index], (), budget):
        _fail()
    return decoded


def _assemble(reference, decoded, tables, budget, query_mode_profile="query-only-v1"):
    expected_schema = [tuple(row) for row in reference.execute(
        "SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name")]
    actual = decoded["schema"]
    if len(actual) > MAX_SCHEMA_ROWS or len(actual) != len(expected_schema):
        _fail("capture_schema_mismatch")
    for received, expected in zip(actual, expected_schema):
        if (received[:3] != expected[:3] or (received[3] is None) != (expected[3] is None)
                or (received[3] is not None and (type(received[3]) is not str
                    or turso_schema._normalize_ddl(received[3]) != turso_schema._normalize_ddl(expected[3])))):
            _fail("capture_schema_mismatch")
    databases = decoded["databases"]
    query_only = decoded["query_only"]
    if (len(query_only) != 1 or len(query_only[0]) != 1
            or type(query_only[0][0]) is not int or query_only[0][0] not in (0, 1)
            or (query_mode_profile == "query-only-v1" and query_only[0][0] != 1)
            or decoded["temp_schema"] or not 1 <= len(databases) <= 2
            or databases[0][:2] != (0, "main") or type(databases[0][0]) is not int
            or type(databases[0][2]) is not str
            or (len(databases) == 2 and (databases[1][:2] != (1, "temp")
                                        or type(databases[1][0]) is not int or databases[1][2] != ""))):
        _fail("capture_schema_mismatch")
    header = decoded["header"]
    if len(header) != 1 or len(header[0]) != 1 or type(header[0][0]) is not int or header[0][0] not in (0, 8):
        _fail("capture_version_invalid")
    if decoded["foreign_keys"] or decoded["integrity"] != [("ok",)]:
        _fail("capture_local_validation_failed")
    records, count = {}, 0
    for table, cols in tables.items():
        rows = decoded["table:" + table]
        count += len(rows)
        if len(rows) > MAX_ROWS or count > MAX_ROWS:
            _fail("capture_row_limit")
        previous = None
        for row in rows:
            if type(row[0]) is not int or (previous is not None and row[0] <= previous):
                _fail("capture_value_invalid")
            previous = row[0]
            if table == "sqlite_sequence" and (type(row[1]) is not str or type(row[2]) is not int or row[2] < 0):
                _fail("capture_value_invalid")
        records[table] = (cols, rows)
    version = records["_schema_version"][1]
    if (len(version) != 1 or version[0] != (1, 1, 8)
            or any(type(number) is not int for number in version[0])):
        _fail("capture_version_invalid")
    typed_digest = offline._rows_digest(records)
    offline._seed_memory(reference, records)
    reference.execute(f"PRAGMA user_version={header[0][0]}")
    offline._integrity(reference)
    roundtrip = offline._snapshot_rows(reference, offline._objects(reference), offline._Budget(budget.deadline))
    if offline._rows_digest(roundtrip) != typed_digest:
        _fail("capture_value_invalid")
    # This helper is read-only. Do NOT call backfill, migrate, initialize,
    # get_conn, or _scope_upgrade while capturing a historical schema-8 image.
    repository_scopes._validate_legacy_lineages(reference)
    budget.check()
    image = offline._serialize_backup(reference)
    reference.execute("PRAGMA query_only=ON")
    return typed_digest, hashlib.sha256(image).hexdigest(), count


def _captured_schema_inventory(decoded, *, resource_digest, image_digest, typed_digest, budget):
    # Called only after _assemble has checked the closed supported reference
    # inventory, typed data, lineage and roundtrip. Never derive raw SQL from
    # the reconstructed reference: formatting has already been canonicalized.
    rows = []
    for row in decoded["schema"]:
        budget.check()
        rows.append(tuple(row))
    rows = tuple(rows)
    result = _ValidatedSchemaInventory(
        rows=rows, exact_sha256=_schema_inventory_digest(rows),
        resource_sha256=resource_digest, source_image_sha256=image_digest,
        source_rows_sha256=typed_digest,
    )
    budget.check()
    return result


def capture_scope_snapshot(*, candidate_origin: str, token: str, transport: SnapshotTransport,
                           operational_tables: frozenset[str] = frozenset(),
                           optimizer_statistics: bool = False,
                           expected_resource_sha256: str | None = None,
                           query_mode_profile: str = "query-only-v1",
                           timeout_seconds: float = MAX_SECONDS) -> CapturedSnapshot:
    """Capture one explicit candidate, returning owned private memory only.

    The caller owns closing the injected transport even on invalid arguments.
    Once sending begins, this function always closes response and transport;
    cleanup failure rejects the capture. No automatic retry or follow-up call.
    The strict default sets and requires query_only=1. The explicitly selected
    Turso profile uses only fixed reads, observes query_only=0|1, and never
    claims server-enforced write protection or falls back after a failure.
    """
    origin = _origin(candidate_origin)
    if (type(token) is not str or not 1 <= len(token) <= 8192 or not token.isascii()
            or any(ord(char) < 33 or ord(char) > 126 for char in token)
            or type(operational_tables) is not frozenset
            or not operational_tables <= offline._OPERATIONAL_DEFINITIONS.keys()
            or type(optimizer_statistics) is not bool
            or type(query_mode_profile) is not str or query_mode_profile not in QUERY_MODE_PROFILES
            or type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= MAX_SECONDS):
        _fail("invalid_capture_arguments")
    resource_digest = hashlib.sha256(origin.encode("ascii")).hexdigest()
    if expected_resource_sha256 is not None:
        if type(expected_resource_sha256) is not str or not _SHA.fullmatch(expected_resource_sha256):
            _fail("invalid_capture_arguments")
        if expected_resource_sha256 != resource_digest:
            _fail("capture_origin_mismatch")
    budget = _Budget(time.monotonic() + timeout_seconds)
    reference, response, sending = None, None, False
    try:
        reference = offline._source_reference("remote-schema-table", budget,
            optimizer_statistics=optimizer_statistics, operational_objects=operational_tables)
        body, names, columns, tables, commit_index = _plan(reference, query_mode_profile)
        body = offline._json_bytes(body)
        budget.check()
        sending = True
        try:
            response = transport.send(url=origin + "/v3/pipeline",
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                body=body, timeout_seconds=max(0.001, budget.deadline - time.monotonic()),
                max_attempts=1, allow_redirects=False, stream=True)
            if type(response.status_code) is not int or response.status_code != 200:
                _fail("capture_http_failed")
            raw = bytearray()
            for chunk in response.iter_content(chunk_size=64 * 1024):
                budget.check()
                if type(chunk) is not bytes:
                    _fail()
                if len(raw) + len(chunk) > MAX_RESPONSE_BYTES:
                    _fail("capture_response_limit")
                raw.extend(chunk)
            budget.check()
            payload = _parse_json(raw, budget)
            decoded = _decode_payload(payload, origin, names, columns, commit_index, budget)
        except SnapshotError:
            raise
        except Exception:
            _fail("capture_transport_failed")
        finally:
            cleanup_failed = False
            if response is not None:
                try:
                    response.close()
                except Exception:
                    cleanup_failed = True
            try:
                transport.close()
            except Exception:
                cleanup_failed = True
            sending = False
            if cleanup_failed:
                _fail("capture_cleanup_failed")
        budget.check()
        typed_digest, image_digest, rows = _assemble(reference, decoded, tables, budget, query_mode_profile)
        schema_inventory = _captured_schema_inventory(decoded, resource_digest=resource_digest,
            image_digest=image_digest, typed_digest=typed_digest, budget=budget)
        inventory_digest = hashlib.sha256(offline._json_bytes({
            "profile": "known-operational-v1", "tables": sorted(operational_tables),
            "optimizer_statistics": optimizer_statistics,
        })).hexdigest()
        result = CapturedSnapshot(reference, {
            "ok": True, "from_schema": 8,
            "evidence_scope": "candidate_readonly_snapshot_capture",
            "source_kind": "remote-schema-table", "resource_sha256": resource_digest,
            "source_sha256": image_digest, "source_rows_sha256": typed_digest,
            "source_contract_sha256": offline._contract_digest(offline._objects(reference)),
            "operational_profile": "known-operational-v1", "inventory_sha256": inventory_digest,
            "query_mode_profile": query_mode_profile,
            "query_only_observed": decoded["query_only"][0][0],
            "server_write_protection_verified": query_mode_profile == "query-only-v1",
            "table_count": len(tables), "row_count": rows,
            "consistent_sql_snapshot": True, "remote_verified": False,
            "remote_applied": False, "remote_restore_verified": False,
            "formal_release_verified": False, "migration_rehearsed": False,
            "apply_preimage_verified": False,
        }, _schema_inventory=schema_inventory)
        budget.check()
        reference = None
        return result
    except SnapshotError:
        raise
    except offline.UpgradeError as error:
        if str(error) == "rehearsal_time_limit":
            _fail("capture_time_limit")
        _fail("capture_local_validation_failed")
    except Exception:
        _fail("capture_local_validation_failed")
    finally:
        if reference is not None:
            reference.close()
        if sending:
            try:
                transport.close()
            except Exception:
                pass
