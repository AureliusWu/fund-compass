"""Explicit-connection SQLite owner sync candidate; not a configured/cloud repo.

No initialization, credentials, HTTP, market data, V8 snapshots or remote adapter
is used here. The caller provisions a verified synthetic schema separately.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable

from database.owner_sync_schema import verify_owner_sync_schema
from models.owner_sync import allowed_fields, normalize_key, normalize_record, parse_sync_request

MAX_SAFE_REVISION = 2**53 - 1
MAX_RECORDS = 100_000
MAX_CHANGES = 100_000
MAX_RECEIPTS = 100_000
MAX_PAGE_SIZE = 200
MAX_JSON_BYTES = 1_500_000
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_CONFLICT_FIELDS = frozenset({"name", "shares", "cost", "target_weight", "cls", "value", "note", "kind", "deleted", "record_revision", "expected_revision"})
_MESSAGES = {
    "invalid_request": "同步请求无效。",
    "sync_conflict": "同步冲突，请保留本地草稿并重新核对。",
    "idempotency_conflict": "请求标识已用于不同的同步请求。",
    "schema_unavailable": "同步存储结构不可用。",
    "integrity_unavailable": "同步存储完整性验证失败。",
    "storage_unavailable": "同步存储暂不可用。",
    "capacity_exhausted": "同步存储容量已满，历史未被删除。",
    "sync_result_unknown": "同步提交结果未知，请保留原请求标识并核对回执。",
}


@dataclass(frozen=True)
class SyncResult:
    status: int
    body: dict[str, Any]


@dataclass(frozen=True)
class StoredReceipt:
    request_id: str
    request_hash: str
    result: SyncResult


@dataclass(frozen=True)
class SyncReconciliation:
    state: str  # matched / absent / unavailable; absent is NOT proof of rollback.
    request_id: str
    result: SyncResult | None = None


class SyncReadError(RuntimeError):
    def __init__(self, code: str, status: int = 503):
        self.code, self.status = code, status
        super().__init__(_MESSAGES[code])


class _IntegrityError(Exception):
    pass


class _CapacityError(Exception):
    pass


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _same_value(left: Any, right: Any) -> bool:
    # Original request tokens remain exact in request_hash. Business numbers
    # must survive the browser JSON round trip (1.0 becomes 1), without making
    # null/zero or booleans equivalent. Validators still reject invalid numbers.
    if type(left) in (int, float) and type(right) in (int, float):
        return math.isfinite(left) and math.isfinite(right) and left == right
    return type(left) is type(right) and left == right


def _same_values(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return set(left) == set(right) and all(_same_value(value, right[field]) for field, value in left.items())


def _decoded(raw: Any) -> Any:
    if not isinstance(raw, str):
        raise _IntegrityError()
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise _IntegrityError()
            result[key] = value
        return result
    try:
        if len(raw.encode("utf-8")) > MAX_JSON_BYTES:
            raise _IntegrityError()
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(_IntegrityError()))
        if _json(value) != raw:
            raise _IntegrityError()
        return value
    except (ValueError, TypeError, UnicodeError) as exc:
        raise _IntegrityError() from exc


def _revision(value: Any, minimum: int = 0) -> int:
    if type(value) is not int or not minimum <= value <= MAX_SAFE_REVISION:
        raise _IntegrityError()
    return value


def _ready(conn: sqlite3.Connection) -> None:
    if not isinstance(conn, sqlite3.Connection):
        raise SyncReadError("storage_unavailable")
    try:
        if conn.in_transaction:
            raise SyncReadError("storage_unavailable")
    except SyncReadError:
        raise
    except Exception as exc:
        raise SyncReadError("storage_unavailable") from exc
    _verify_locked(conn)


def _verify_locked(conn: sqlite3.Connection) -> None:
    try:
        verify_owner_sync_schema(conn)
    except Exception as exc:
        raise SyncReadError("schema_unavailable") from exc


def _head(conn: sqlite3.Connection) -> int:
    rows = conn.execute("SELECT singleton, revision FROM owner_sync_state").fetchall()
    if len(rows) != 1 or type(rows[0][0]) is not int or rows[0][0] != 1:
        raise _IntegrityError()
    head = _revision(rows[0][1])
    history = conn.execute("SELECT MAX(revision),COUNT(DISTINCT revision) FROM owner_sync_changes").fetchone()
    if (history[0] is not None and _revision(history[0], 1) != head) or _revision(history[1]) != head:
        raise _IntegrityError()
    return head


def _envelope(key: str, kind: str, deleted: bool, record_revision: int,
              lifecycle_revision: int, field_revisions: dict[str, int], values: dict[str, Any]) -> dict[str, Any]:
    return {"key": key, "kind": kind, "deleted": deleted, "record_revision": record_revision,
            "lifecycle_revision": lifecycle_revision, "field_revisions": field_revisions, "values": values}


def _validate_record(value: Any, *, upper: int) -> dict[str, Any]:
    try:
        if not isinstance(value, dict) or set(value) != {"key", "kind", "deleted", "record_revision", "lifecycle_revision", "field_revisions", "values"}:
            raise _IntegrityError()
        if type(value["deleted"]) is not bool or value["kind"] not in {"watch", "holding", "manual_asset"}:
            raise _IntegrityError()
        if normalize_key(value["key"], value["kind"]) != value["key"]:
            raise _IntegrityError()
        record = _revision(value["record_revision"], 1)
        lifecycle = _revision(value["lifecycle_revision"], 1)
        if not lifecycle <= record <= upper:
            raise _IntegrityError()
        fields = value["field_revisions"]
        if not isinstance(fields, dict) or set(fields) != set(allowed_fields(value["kind"])):
            raise _IntegrityError()
        for stamp in fields.values():
            if _revision(stamp, 1) > record:
                raise _IntegrityError()
        payload = value["values"]
        normalized = normalize_record(value["kind"], payload, require_complete=False)
        if set(payload) != set(allowed_fields(value["kind"])) or _json(normalized) != _json(payload):
            raise _IntegrityError()
        return value
    except Exception as exc:
        if isinstance(exc, _IntegrityError):
            raise
        raise _IntegrityError() from exc


def _record(conn: sqlite3.Connection, key: str, head: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT sync_key, kind, deleted, record_revision, lifecycle_revision, field_revisions_json, payload_json FROM owner_sync_records WHERE sync_key=?", (key,)).fetchone()
    if row is None:
        if conn.execute("SELECT 1 FROM owner_sync_changes WHERE sync_key=? LIMIT 1", (key,)).fetchone() is not None:
            raise _IntegrityError()  # Missing current/tombstone row is not a new identity.
        return None
    if type(row[2]) is not int or row[2] not in (0, 1):
        raise _IntegrityError()
    record = _validate_record(_envelope(row[0], row[1], bool(row[2]), row[3], row[4], _decoded(row[5]), _decoded(row[6])), upper=head)
    latest = conn.execute("SELECT revision,snapshot_json FROM owner_sync_changes WHERE sync_key=? ORDER BY revision DESC LIMIT 1", (key,)).fetchone()
    if latest is None or latest[0] != record["record_revision"] or _json(_decoded(latest[1])) != _json(record):
        raise _IntegrityError()
    return record


def _error(code: str, status: int = 503) -> SyncResult:
    return SyncResult(status, {"error": {"code": code, "message": _MESSAGES[code]}})


def _conflict(key: str, fields: set[str]) -> dict[str, Any]:
    return {"key_digest": hashlib.sha256(key.encode("utf-8")).hexdigest()[:16], "fields": sorted(fields)}


def _validate_result(status: Any, raw: Any, head: int) -> SyncResult:
    if type(status) is not int or status not in (200, 409):
        raise _IntegrityError()
    body = _decoded(raw)
    if not isinstance(body, dict):
        raise _IntegrityError()
    if status == 200:
        if set(body) != {"revision", "records"} or _revision(body["revision"]) > head or not isinstance(body["records"], list) or len(body["records"]) > 200:
            raise _IntegrityError()
        keys = set()
        for record in body["records"]:
            _validate_record(record, upper=body["revision"])
            if record["key"] in keys:
                raise _IntegrityError()
            keys.add(record["key"])
    else:
        expected_error = _error("sync_conflict", 409).body["error"]
        if set(body) != {"error", "conflicts"} or body["error"] != expected_error or not isinstance(body["conflicts"], list) or not 1 <= len(body["conflicts"]) <= 200:
            raise _IntegrityError()
        for conflict in body["conflicts"]:
            if not isinstance(conflict, dict) or set(conflict) != {"key_digest", "fields"} or not isinstance(conflict["key_digest"], str) or not re.fullmatch(r"[0-9a-f]{16}", conflict["key_digest"]):
                raise _IntegrityError()
            fields = conflict["fields"]
            if not isinstance(fields, list) or not fields or any(field not in _CONFLICT_FIELDS for field in fields) or fields != sorted(set(fields)):
                raise _IntegrityError()
    return SyncResult(status, body)


def _receipt(conn: sqlite3.Connection, request_id: str, head: int) -> StoredReceipt | None:
    row = conn.execute("SELECT request_id, request_hash, status, response_json FROM owner_sync_receipts WHERE request_id=?", (request_id,)).fetchone()
    if row is None:
        return None
    if row[0] != request_id or not isinstance(row[1], str) or not _HASH.fullmatch(row[1]):
        raise _IntegrityError()
    return StoredReceipt(row[0], row[1], _validate_result(row[2], row[3], head))


def _count(conn: sqlite3.Connection, table: str) -> int:
    # Table is only a closed internal constant, never request data.
    row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    return _revision(row[0])


def _rollback(conn: sqlite3.Connection) -> None:
    try:
        if conn.in_transaction:
            conn.rollback()
    except Exception:
        pass


def _plan(operation: Any, current: dict[str, Any] | None, expected: int) -> tuple[dict[str, Any] | None, set[str]]:
    changes, base = operation.changes, operation.base_values
    fields: set[str] = set()
    if current is None:
        if operation.deleted:
            return None, {"deleted"}
        for field, value in base.items():
            if value is not None:
                fields.add(field)
        if fields:
            return None, fields
        values = normalize_record(operation.kind, changes, require_complete=True)
        return _envelope(operation.key, operation.kind, False, 0, 0, {}, values), set()
    if operation.deleted:
        if current["record_revision"] > expected:
            fields.add("record_revision")
        if "deleted" in base and base["deleted"] != current["deleted"]:
            fields.add("deleted")
        if "kind" in base and base["kind"] != current["kind"]:
            fields.add("kind")
        if operation.kind != current["kind"]:
            fields.add("kind")
        for field in set(base) - {"kind", "deleted"}:
            if field not in current["values"] or not _same_value(base[field], current["values"][field]):
                fields.add(field)
        if changes:
            fields.update(changes)
        if fields:
            return None, fields
        if current["deleted"]:
            return current, set()
        return {**current, "deleted": True}, set()
    if current["deleted"]:
        if base.get("deleted") is not True or expected < current["lifecycle_revision"]:
            return None, {"deleted"}
        if "kind" in base and base["kind"] != current["kind"]:
            return None, {"kind"}
        if operation.kind != current["kind"] and base.get("kind") != current["kind"]:
            return None, {"kind"}
        for field in set(base) - {"kind", "deleted"}:
            if field not in current["values"] or not _same_value(base[field], current["values"][field]):
                fields.add(field)
        if fields:
            return None, fields
        # Explicit revive is a fresh full input, not a merge with old finance.
        values = normalize_record(operation.kind, changes, require_complete=True)
        return _envelope(operation.key, operation.kind, False, current["record_revision"], current["lifecycle_revision"], current["field_revisions"], values), set()
    if "deleted" in base and base["deleted"] is not False:
        fields.add("deleted")
    if operation.kind != current["kind"]:
        if base.get("kind") != current["kind"] or expected < current["record_revision"]:
            fields.add("kind")
        for field in set(base) - {"kind", "deleted"}:
            if field not in current["values"] or not _same_value(base[field], current["values"][field]):
                fields.add(field)
        if fields:
            return None, fields
        values = normalize_record(operation.kind, changes, require_complete=True)
        return {**current, "kind": operation.kind, "values": values}, set()
    if "kind" in base and base["kind"] != current["kind"]:
        fields.add("kind")
    if expected < current["lifecycle_revision"]:
        fields.add("deleted")
    for field in changes:
        if field not in base or not _same_value(base[field], current["values"][field]) or current["field_revisions"][field] > expected:
            fields.add(field)
    for field in set(base) - set(changes) - {"kind", "deleted"}:
        if not _same_value(base[field], current["values"][field]):
            fields.add(field)
    if fields:
        return None, fields
    values = normalize_record(operation.kind, {**current["values"], **changes}, require_complete=False)
    return {**current, "values": values}, set()


def _stamp(planned: dict[str, Any], current: dict[str, Any] | None, revision: int) -> dict[str, Any]:
    lifecycle_change = current is None or current["kind"] != planned["kind"] or current["deleted"] != planned["deleted"]
    revived = current is not None and current["deleted"] and not planned["deleted"]
    stamps = {field: revision if current is None or revived or field not in current["field_revisions"]
              or not _same_value(planned["values"][field], current["values"][field]) else current["field_revisions"][field]
              for field in allowed_fields(planned["kind"])}
    return {**planned, "record_revision": revision, "lifecycle_revision": revision if lifecycle_change else current["lifecycle_revision"], "field_revisions": stamps}


def apply_sync_local(conn: sqlite3.Connection, raw_request: bytes | str, *, before_commit: Callable[[], None] | None = None) -> SyncResult:
    """Apply a validated batch and receipt in one BEGIN IMMEDIATE transaction.

    Callback is trusted internal authorization and is propagated after rollback.
    Commit errors remain unknown, even if a subsequent read finds no receipt.
    """
    try:
        request = parse_sync_request(raw_request)
        request_hash = request.request_hash()
    except Exception:
        return _error("invalid_request", 422)
    try:
        _ready(conn)
    except SyncReadError as exc:
        return _error(exc.code)
    committing = False
    authorizing = False
    try:
        conn.execute("BEGIN IMMEDIATE")
        # Verify under the same lock as the business write, not only preflight.
        _verify_locked(conn)
        head = _head(conn)
        receipt = _receipt(conn, request.request_id, head)
        if receipt:
            result = receipt.result if receipt.request_hash == request_hash else _error("idempotency_conflict", 409)
        else:
            if _count(conn, "owner_sync_receipts") >= MAX_RECEIPTS:
                raise _CapacityError()
            conflicts = []
            planned: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
            if request.expected_revision > head:
                conflicts.append(_conflict("", {"expected_revision"}))
            else:
                for operation in request.operations:
                    current = _record(conn, operation.key, head)
                    try:
                        record, fields = _plan(operation, current, request.expected_revision)
                    except Exception:
                        # Structurally valid but semantically incomplete merged
                        # input is a deterministic conflict, not a partial write.
                        record, fields = None, set(allowed_fields(operation.kind))
                    if fields:
                        conflicts.append(_conflict(operation.key, fields))
                    elif record is not None:
                        planned.append((record, current))
            if conflicts:
                result = SyncResult(409, {**_error("sync_conflict", 409).body, "conflicts": conflicts})
            else:
                changed = [(record, current) for record, current in planned
                           if current is None or record["kind"] != current["kind"] or record["deleted"] != current["deleted"] or not _same_values(record["values"], current["values"])]
                revision = head + bool(changed)
                if revision > MAX_SAFE_REVISION or _count(conn, "owner_sync_records") + sum(current is None for _, current in changed) > MAX_RECORDS or _count(conn, "owner_sync_changes") + len(changed) > MAX_CHANGES:
                    raise _CapacityError()
                confirmed = []
                changed_keys = {record["key"] for record, _ in changed}
                for record, current in planned:
                    if record["key"] in changed_keys:
                        record = _stamp(record, current, revision)
                        _validate_record(record, upper=revision)
                        conn.execute("INSERT INTO owner_sync_records(sync_key,kind,deleted,record_revision,lifecycle_revision,field_revisions_json,payload_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(sync_key) DO UPDATE SET kind=excluded.kind,deleted=excluded.deleted,record_revision=excluded.record_revision,lifecycle_revision=excluded.lifecycle_revision,field_revisions_json=excluded.field_revisions_json,payload_json=excluded.payload_json",
                                     (record["key"], record["kind"], int(record["deleted"]), record["record_revision"], record["lifecycle_revision"], _json(record["field_revisions"]), _json(record["values"])))
                        conn.execute("INSERT INTO owner_sync_changes(revision,sync_key,snapshot_json) VALUES(?,?,?)", (revision, record["key"], _json(record)))
                    else:
                        record = current  # Confirm the actual stored representation on no-op.
                    confirmed.append(record)
                if changed:
                    conn.execute("UPDATE owner_sync_state SET revision=? WHERE singleton=1", (revision,))
                result = SyncResult(200, {"revision": revision, "records": confirmed})
            serialized = _json(result.body)
            if len(serialized.encode("utf-8")) > MAX_JSON_BYTES:
                raise _CapacityError()
            conn.execute("INSERT INTO owner_sync_receipts(request_id,request_hash,status,response_json) VALUES(?,?,?,?)", (request.request_id, request_hash, result.status, serialized))
        if before_commit:
            authorizing = True
            before_commit()
            authorizing = False
        committing = True
        conn.commit()
        return result
    except Exception as exc:
        _rollback(conn)
        if authorizing:
            raise
        if committing:
            return _error("sync_result_unknown")
        if isinstance(exc, _CapacityError):
            return _error("capacity_exhausted")
        if isinstance(exc, _IntegrityError):
            return _error("integrity_unavailable")
        if isinstance(exc, SyncReadError):
            return _error(exc.code)
        return _error("storage_unavailable")


def read_sync_receipt(conn: sqlite3.Connection, request_id: str) -> SyncResult | None:
    receipt = _read_receipt_transaction(conn, request_id)
    return receipt.result if receipt else None


def _read_receipt_transaction(conn: sqlite3.Connection, request_id: str) -> StoredReceipt | None:
    if not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id):
        raise SyncReadError("invalid_request", 422)
    _ready(conn)
    try:
        conn.execute("BEGIN")
        _verify_locked(conn)
        receipt = _receipt(conn, request_id, _head(conn))
        conn.commit()
        return receipt
    except _IntegrityError as exc:
        _rollback(conn)
        raise SyncReadError("integrity_unavailable") from exc
    except SyncReadError:
        _rollback(conn)
        raise
    except Exception as exc:
        _rollback(conn)
        raise SyncReadError("storage_unavailable") from exc


def reconcile_sync_local(conn: sqlite3.Connection, request_id: str, request_hash: str) -> SyncReconciliation:
    if not isinstance(request_hash, str) or not _HASH.fullmatch(request_hash):
        return SyncReconciliation("unavailable", request_id)
    try:
        if not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id):
            return SyncReconciliation("unavailable", request_id)
        receipt = _read_receipt_transaction(conn, request_id)
        if receipt is None:
            return SyncReconciliation("absent", request_id)
        if receipt.request_hash != request_hash:
            return SyncReconciliation("unavailable", request_id)
        return SyncReconciliation("matched", request_id, receipt.result)
    except Exception:
        return SyncReconciliation("unavailable", request_id)


reconcile = reconcile_sync_local


def read_sync_changes(conn: sqlite3.Connection, *, since_revision: int = 0, upper_revision: int | None = None,
                      cursor: tuple[int, str] | None = None, limit: int = 100) -> dict[str, Any]:
    if type(limit) is not int or not 1 <= limit <= MAX_PAGE_SIZE:
        raise SyncReadError("invalid_request", 422)
    try:
        _revision(since_revision)
        if upper_revision is not None:
            _revision(upper_revision)
        if cursor is not None:
            if not isinstance(cursor, tuple) or len(cursor) != 2 or not isinstance(cursor[1], str) or len(cursor[1]) > 160:
                raise _IntegrityError()
            _revision(cursor[0])
            if cursor[0] == 0 and cursor[1] != "":
                raise _IntegrityError()
    except _IntegrityError as exc:
        raise SyncReadError("invalid_request", 422) from exc
    _ready(conn)
    try:
        conn.execute("BEGIN")
        _verify_locked(conn)
        head = _head(conn)
        upper = head if upper_revision is None else upper_revision
        after_revision, after_key = cursor or (0, "")
        if upper > head or since_revision > upper or after_revision > upper or cursor is not None and after_revision < since_revision:
            raise SyncReadError("invalid_request", 422)
        if cursor is not None and after_revision > 0 and conn.execute("SELECT 1 FROM owner_sync_changes WHERE revision=? AND sync_key=?", cursor).fetchone() is None:
            raise SyncReadError("invalid_request", 422)
        rows = conn.execute("SELECT revision,sync_key,snapshot_json FROM owner_sync_changes WHERE revision>? AND revision<=? AND (revision>? OR (revision=? AND sync_key>?)) ORDER BY revision,sync_key LIMIT ?", (since_revision, upper, after_revision, after_revision, after_key, limit + 1)).fetchall()
        decoded = []
        for row in rows:
            revision = _revision(row[0], 1)
            record = _validate_record(_decoded(row[2]), upper=upper)
            if record["key"] != row[1] or record["record_revision"] != revision:
                raise _IntegrityError()
            decoded.append(record)
        more = len(decoded) > limit
        records = decoded[:limit]
        next_cursor = (records[-1]["record_revision"], records[-1]["key"]) if more else None
        conn.commit()
        return {"upper_revision": upper, "changes": records, "next_cursor": next_cursor, "complete": not more}
    except Exception as exc:
        _rollback(conn)
        if isinstance(exc, SyncReadError):
            raise
        raise SyncReadError("integrity_unavailable" if isinstance(exc, _IntegrityError) else "storage_unavailable") from exc
