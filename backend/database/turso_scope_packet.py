"""Pure, local evidence-only migration packet compiler. No transport or apply function.

Input is one already captured private memory object, not a file, URL, SQL,
configuration, or credential. Raw source DDL is data only. All executable DDL
is repository-owned. Trusted fixed source files are read only for code binding.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import time

from database import db, turso_schema, turso_scope_snapshot as capture, turso_scope_upgrade as offline
from models import v8 as v8_models
from service import repository_scopes as scopes

MAX_ARGS = 900
MAX_ROWS = 100_000
MAX_CELL_BYTES = 256 * 1024
MAX_IMAGE_BYTES = MAX_PACKET_BYTES = MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_STEPS = 16_384
MAX_SECONDS = 30.0
GUARD_PROFILE = "sqlite-atan2-zero-v1"
PACKET_PROFILE = "turso-scope-packet-v1"
ARTIFACT_PROFILE = "turso-scope-artifact-v1"
ENDPOINT = "reserved:scope-migration:8-to-9:v1"
_SHA = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z", re.ASCII)
_I64_MIN, _I64_MAX = -(2**63), 2**63 - 1
_ERRORS = frozenset({"invalid_compile_arguments", "compiler_code_drift", "compile_time_limit",
    "source_context_invalid", "source_metadata_invalid", "source_identity_mismatch",
    "source_memory_invalid", "source_image_invalid", "source_inventory_invalid", "source_schema_invalid",
    "source_version_invalid", "source_value_invalid", "source_row_limit", "source_lineage_invalid",
    "existing_receipt_requires_reconcile", "packet_limit", "artifact_invalid", "packet_integrity_invalid"})
_SAFE_KEYS = frozenset({"ok", "from_schema", "evidence_scope", "source_kind", "resource_sha256",
    "source_sha256", "source_rows_sha256", "source_contract_sha256", "operational_profile", "inventory_sha256",
    "query_mode_profile", "query_only_observed", "server_write_protection_verified", "table_count", "row_count",
    "consistent_sql_snapshot", "remote_verified", "remote_applied", "remote_restore_verified",
    "formal_release_verified", "migration_rehearsed", "apply_preimage_verified"})
_PACKET_DIGEST_KEYS = frozenset({'resource_sha256', 'source_image_sha256', 'source_rows_sha256',
    'raw_schema_sha256', 'source_contract_sha256', 'compiler_sha256', 'contract_code_sha256',
    'plan_sha256', 'packet_sha256'})
_PACKET_REMOTE_FLAGS = frozenset({'remote_verified', 'remote_applied', 'remote_restore_verified',
    'formal_release_verified', 'apply_preimage_verified', 'server_capabilities_verified'})
_PACKET_METADATA_KEYS = frozenset({'ok', 'profile', 'evidence_scope', 'from_schema', 'to_schema',
    'migration_id', 'receipt_rowid', 'guard_profile', 'packet_bytes', 'batch_steps', 'source_row_count',
    'max_statement_args', 'max_response_bytes'}) | _PACKET_DIGEST_KEYS | _PACKET_REMOTE_FLAGS
_CODE_FILES = (('compiler', Path(__file__).resolve()), ('capture', Path(capture.__file__).resolve()),
    ('offline', Path(offline.__file__).resolve()), ('schema', Path(turso_schema.__file__).resolve()),
    ('db', Path(db.__file__).resolve()), ('scopes', Path(scopes.__file__).resolve()),
    ('models', Path(v8_models.__file__).resolve()))


class CompilerError(Exception):
    def __init__(self, code):
        super().__init__(code if type(code) is str and code in _ERRORS else "packet_integrity_invalid")


def _fail(code):
    raise CompilerError(code)


def _sha(value):
    if type(value) is not str or not _SHA.fullmatch(value):
        _fail("invalid_compile_arguments")
    return value


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("ascii")


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _code_fingerprint():
    rows = []
    for name, path in _CODE_FILES:
        # Only the frozen finite trusted module paths, never caller-provided paths.
        with path.open('rb') as source:
            raw = source.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            _fail("compiler_code_drift")
        raw.decode('utf-8', errors='strict')
        rows.append((name, _hash(raw)))
    return tuple(rows)


_LOADED_CODE = _code_fingerprint()


def _current_code():
    try:
        result = _code_fingerprint()
    except CompilerError:
        raise
    except Exception:
        _fail("compiler_code_drift")
    if result != _LOADED_CODE:
        _fail("compiler_code_drift")
    return result


class _Budget(offline._Budget):
    def check(self):
        if time.monotonic() > self.deadline:
            _fail("compile_time_limit")


def _value(value):
    if value is None:
        return
    if type(value) is int and _I64_MIN <= value <= _I64_MAX:
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is str:
        try:
            if len(value.encode('utf-8', errors='strict')) <= MAX_CELL_BYTES:
                return
        except UnicodeError:
            pass
    if type(value) is bytes and len(value) <= MAX_CELL_BYTES:
        return
    _fail("source_value_invalid")


def _wire(value):
    _value(value)
    if value is None:
        return {"type": "null"}
    if type(value) is int:
        return {"type": "integer", "value": str(value)}
    if type(value) is float:
        return {"type": "float", "value": value}
    if type(value) is str:
        return {"type": "text", "value": value}
    return {"type": "blob", "base64": base64.b64encode(value).decode('ascii')}


def _native_frozen(value, *, depth=0, remaining=None):
    # Exact native types only. This rejects tuple/scalar subclasses and all
    # mutable descendants, not merely a frozen outer dataclass.
    if remaining is None:
        remaining = [4_000_000]
    remaining[0] -= 1
    if remaining[0] < 0 or depth > 24:
        _fail('packet_limit')
    if type(value) is tuple:
        for item in value:
            _native_frozen(item, depth=depth + 1, remaining=remaining)
    elif value is None or type(value) is bool:
        return
    elif type(value) in (str, bytes, int, float):
        _value(value)
    else:
        _fail('packet_integrity_invalid')


def _same_native(left, right):
    # Python equality alone treats True == 1 and +0.0 == -0.0. Neither is a
    # valid artifact equivalence. All leaves and containers are type-bound.
    if type(left) is not type(right):
        return False
    if type(left) is tuple:
        return len(left) == len(right) and all(_same_native(a, b) for a, b in zip(left, right))
    if type(left) is float:
        return left.hex() == right.hex()
    return left == right


@dataclass(frozen=True, slots=True, repr=False)
class Statement:
    label: str
    sql: str
    args: tuple = field(default=())
    want_rows: bool = field(default=False)
    result_spec: tuple = field(default=("empty", (), ()))

    def __post_init__(self):
        _native_frozen(self.result_spec)
        if (type(self.label) is not str or type(self.sql) is not str or type(self.args) is not tuple
                or len(self.args) > MAX_ARGS or type(self.want_rows) is not bool
                or not any(_same_native(self.result_spec, allowed) for allowed in
                       (("empty", (), ()), ("guard", ("guard_passed",), (("integer", "1"),))))):
            _fail("packet_integrity_invalid")
        if self.want_rows is not (self.result_spec[0] == 'guard'):
            _fail("packet_integrity_invalid")
        for value in self.args:
            _value(value)

    def _wire(self):
        return {"sql": self.sql, "args": [_wire(v) for v in self.args], "named_args": [],
                "want_rows": self.want_rows}


def _guard(label, predicate, args=(), prefix=''):
    return Statement(label, prefix + "SELECT CASE WHEN (" + predicate + ") THEN 1 ELSE "
                     "abs(-9223372036854775808) END AS guard_passed", tuple(args), True,
                     ("guard", ("guard_passed",), (("integer", "1"),)))


def _match(actual, expected):
    return (f"(typeof({actual})=typeof({expected}) AND (CASE WHEN typeof({expected}) IN ('text','blob') "
        f"THEN CAST({actual} AS BLOB) IS CAST({expected} AS BLOB) ELSE {actual} IS {expected} END) "
        f"AND (CASE WHEN typeof({expected})='real' THEN atan2({actual},-1.0) IS atan2({expected},-1.0) ELSE 1 END))")


def _schema_rows(conn):
    return tuple(tuple(row) for row in conn.execute(
        'SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name LIMIT 129'))


def _supported_schema(rows, expected):
    if type(rows) is not tuple or len(rows) != len(expected) or not 1 <= len(rows) <= 128:
        _fail("source_schema_invalid")
    for actual, canonical in zip(rows, expected):
        if (actual[:3] != canonical[:3] or (actual[3] is None) != (canonical[3] is None)
                or (actual[3] is not None and turso_schema._normalize_ddl(actual[3]) != turso_schema._normalize_ddl(canonical[3]))):
            _fail("source_schema_invalid")


def _schema_guards(rows):
    aliases = ('e0', 'e1', 'e2', 'e3')
    checks = ' AND '.join(_match('a.' + column, 'e.' + alias)
                         for column, alias in zip(('type', 'name', 'tbl_name', 'sql'), aliases))
    slots = ','.join('(?,?,?,?)' for _ in rows)
    predicate = (f'(SELECT COUNT(*) FROM main.sqlite_master)={len(rows)} AND NOT EXISTS '
        '(SELECT 1 FROM expected e LEFT JOIN main.sqlite_master a ON '
        'CAST(a.type AS BLOB)=CAST(e.e0 AS BLOB) AND CAST(a.name AS BLOB)=CAST(e.e1 AS BLOB) '
        f'WHERE a.name IS NULL OR NOT ({checks}))')
    yield _guard('schema:exact-raw', predicate, tuple(v for row in rows for v in row),
                 f'WITH expected({",".join(aliases)}) AS (VALUES {slots}) ')


def _row_guards(table, columns, rows, budget, *, include_count=True):
    width = len(columns) + 1
    chunk_size = MAX_ARGS // width
    if include_count:
        yield _guard('count:' + table, f'(SELECT COUNT(*) FROM main."{table}")=?', (len(rows),))
    names = ('rowid', *columns)
    aliases = tuple(f'e{i}' for i in range(width))
    checks = ' AND '.join(_match(f'a."{column}"', 'e.' + alias) for column, alias in zip(names, aliases))
    for offset in range(0, len(rows), chunk_size):
        budget.check()
        chunk = rows[offset:offset + chunk_size]
        slots = ','.join('(' + ','.join('?' for _ in aliases) + ')' for _ in chunk)
        predicate = (f'NOT EXISTS (SELECT 1 FROM expected e LEFT JOIN main."{table}" a ON a.rowid=e.e0 '
                     f'WHERE a.rowid IS NULL OR NOT ({checks}))')
        yield _guard(f'rows:{table}:{offset}', predicate, tuple(v for row in chunk for v in row),
                     f'WITH expected({",".join(aliases)}) AS (VALUES {slots}) ')


def _metadata(meta):
    if type(meta) is not dict or set(meta) != _SAFE_KEYS:
        _fail('source_metadata_invalid')
    if any(type(key) is not str for key in meta) or any(type(meta[k]) is not str
            for k in ('evidence_scope', 'source_kind', 'operational_profile')):
        _fail('source_metadata_invalid')
    if (meta['ok'] is not True or type(meta['from_schema']) is not int or meta['from_schema'] != 8
            or meta['evidence_scope'] != 'candidate_readonly_snapshot_capture'
            or meta['source_kind'] != 'remote-schema-table' or meta['operational_profile'] != 'known-operational-v1'
            or type(meta['query_mode_profile']) is not str or meta['query_mode_profile'] not in capture.QUERY_MODE_PROFILES
            or type(meta['query_only_observed']) is not int or meta['query_only_observed'] not in (0, 1)
            or meta['server_write_protection_verified'] is not (meta['query_mode_profile'] == 'query-only-v1')
            or (meta['query_mode_profile'] == 'query-only-v1' and meta['query_only_observed'] != 1)
            or meta['consistent_sql_snapshot'] is not True
            or any(meta[k] is not False for k in ('remote_verified', 'remote_applied', 'remote_restore_verified',
               'formal_release_verified', 'migration_rehearsed', 'apply_preimage_verified'))
            or any(type(meta[k]) is not int or not 0 <= meta[k] <= MAX_ROWS for k in ('table_count', 'row_count'))):
        _fail('source_metadata_invalid')
    for key in ('resource_sha256', 'source_sha256', 'source_rows_sha256', 'source_contract_sha256', 'inventory_sha256'):
        if type(meta[key]) is not str or not _SHA.fullmatch(meta[key]):
            _fail('source_metadata_invalid')
    return dict(meta)


def _read_authorizer(action, arg1, arg2, _database, _trigger):
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_PRAGMA and arg1 in ('table_info', 'user_version', 'database_list', 'query_only',
                                                  'foreign_key_check', 'quick_check'):
        if arg1 in ('user_version', 'query_only') and arg2 is not None:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def _admit(snapshot, expected_resource, budget):
    if type(snapshot) is not capture.CapturedSnapshot or type(snapshot.connection) is not sqlite3.Connection:
        _fail('source_context_invalid')
    meta = _metadata(snapshot.safe_metadata)
    if meta['resource_sha256'] != expected_resource:
        _fail('source_identity_mismatch')
    raw = snapshot._schema_inventory
    if (type(raw) is not capture._ValidatedSchemaInventory or type(raw.profile) is not str
            or raw.profile != 'captured-schema-inventory-v1'):
        _fail('source_inventory_invalid')
    try:
        validated = capture._ValidatedSchemaInventory(raw.rows, raw.exact_sha256, raw.resource_sha256,
                                                      raw.source_image_sha256, raw.source_rows_sha256)
    except Exception:
        _fail('source_inventory_invalid')
    raw = validated
    if (validated.resource_sha256 != expected_resource or validated.source_image_sha256 != meta['source_sha256']
            or validated.source_rows_sha256 != meta['source_rows_sha256']):
        _fail('source_inventory_invalid')
    operational = frozenset(row[1] for row in raw.rows if row[0] == 'table' and row[1] in offline._OPERATIONAL_DEFINITIONS)
    statistics = any(row[:2] == ('table', 'sqlite_stat1') for row in raw.rows)
    inventory = _hash(_json({'profile': 'known-operational-v1', 'tables': sorted(operational),
                             'optimizer_statistics': statistics}))
    if inventory != meta['inventory_sha256']:
        _fail('source_inventory_invalid')
    reference = offline._source_reference('remote-schema-table', budget,
                        optimizer_statistics=statistics, operational_objects=operational)
    decoder = None
    try:
        canonical = _schema_rows(reference)
        _supported_schema(raw.rows, canonical)
        if snapshot.connection.in_transaction:
            _fail('source_memory_invalid')
        databases = snapshot.connection.execute('PRAGMA database_list').fetchall()
        if (any(tuple(row) not in ((0, 'main', ''), (1, 'temp', '')) for row in databases)
                or not 1 <= len(databases) <= 2
                or snapshot.connection.execute('SELECT 1 FROM temp.sqlite_master LIMIT 1').fetchone() is not None
                or snapshot.connection.execute('PRAGMA query_only').fetchone()[0] != 1):
            _fail('source_memory_invalid')
        image = snapshot.connection.serialize()
        budget.check()
        if type(image) is not bytes or not 16 <= len(image) <= MAX_IMAGE_BYTES or not image.startswith(b'SQLite format 3\x00'):
            _fail('source_image_invalid')
        if _hash(image) != meta['source_sha256']:
            _fail('source_image_invalid')
        decoder = sqlite3.connect(':memory:')
        decoder.row_factory = sqlite3.Row
        decoder.enable_load_extension(False)
        decoder.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
        decoder.deserialize(image)
        decoder.set_progress_handler(budget.progress, 1000)
        decoder.set_authorizer(_read_authorizer)
        # Read metadata only before any table data. Never execute image/input DDL.
        if _schema_rows(decoder) != canonical:
            _fail('source_schema_invalid')
        header = decoder.execute('PRAGMA user_version').fetchone()[0]
        version = tuple(tuple(row) for row in decoder.execute('SELECT rowid,singleton,version FROM _schema_version'))
        if type(header) is not int or header not in (0, 8) or version != ((1, 1, 8),):
            _fail('source_version_invalid')
        records = offline._snapshot_rows(decoder, offline._objects(reference), budget)
        total = 0
        for table, (columns, rows) in records.items():
            previous = None
            total += len(rows)
            if total > MAX_ROWS:
                _fail('source_row_limit')
            for row in rows:
                budget.check()
                if type(row[0]) is not int or not _I64_MIN <= row[0] <= _I64_MAX or (previous is not None and row[0] <= previous):
                    _fail('source_value_invalid')
                previous = row[0]
                for value in row:
                    _value(value)
                if table == 'sqlite_sequence' and (type(row[1]) is not str or type(row[2]) is not int or row[2] < 0):
                    _fail('source_value_invalid')
        if (total != meta['row_count'] or len(records) != meta['table_count']
                or offline._rows_digest(records) != meta['source_rows_sha256']
                or offline._contract_digest(offline._objects(reference)) != meta['source_contract_sha256']):
            _fail('source_metadata_invalid')
        offline._seed_memory(reference, records)
        reference.execute(f'PRAGMA user_version={header}')
        offline._integrity(reference)
        roundtrip = offline._snapshot_rows(reference, offline._objects(reference), _Budget(budget.deadline))
        if offline._rows_digest(roundtrip) != meta['source_rows_sha256']:
            _fail('source_value_invalid')
        scopes._validate_legacy_lineages(reference)
        budget.check()
        return reference, raw, records, meta
    except Exception:
        reference.close()
        raise
    finally:
        if decoder is not None:
            decoder.close()


def _scope_ddl():
    result = list(scopes.schema_statements())
    for table in scopes.SCOPE_TABLES:
        for operation in ('update', 'delete'):
            result.append(f"CREATE TRIGGER immutable_{table}_{operation} BEFORE {operation} ON {table} "
                          f"BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END")
    return tuple(result)


def _target(reference, raw_rows, budget):
    reference.execute('BEGIN IMMEDIATE')
    for sql in _scope_ddl():
        budget.check()
        reference.execute(sql)
    scopes.backfill_legacy_production(reference, allow_legacy=True)
    scopes._validate_legacy_lineages(reference)
    budget.check()
    reference.execute('UPDATE _schema_version SET version=9 WHERE singleton=1 AND version=8')
    if reference.execute('SELECT changes()').fetchone()[0] != 1:
        _fail('source_version_invalid')
    reference.commit()
    db._verify_v8_schema_contract(reference)
    offline._integrity(reference)
    target = _schema_rows(reference)
    canonical_old = {(row[0], row[1]) for row in raw_rows}
    old = {(row[0], row[1]): row for row in raw_rows}
    for row in target:
        if (row[0], row[1]) not in canonical_old:
            old[(row[0], row[1])] = row
    if set(old) != {(row[0], row[1]) for row in target}:
        _fail('source_schema_invalid')
    target_raw = tuple(old[key] for key in sorted(old, key=lambda key: (key[0].encode(), key[1].encode())))
    _supported_schema(target_raw, target)
    records = offline._snapshot_rows(reference, offline._objects(reference), _Budget(budget.deadline))
    budget.check()
    return target_raw, {name: records[name] for name in scopes.SCOPE_TABLES}


def _pipeline(statements):
    controls = (Statement('begin', 'BEGIN IMMEDIATE'), Statement('commit', 'COMMIT'), Statement('rollback', 'ROLLBACK'))
    all_specs = (controls[0], *statements, controls[1], controls[2])
    steps = [{'stmt': controls[0]._wire()}]
    for statement in statements:
        steps.append({'stmt': statement._wire(), 'condition': {'type': 'and', 'conds': [
            {'type': 'ok', 'step': len(steps) - 1}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    commit = len(steps)
    steps.append({'stmt': controls[1]._wire(), 'condition': {'type': 'and', 'conds': [
        {'type': 'ok', 'step': commit - 1}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    steps.append({'stmt': controls[2]._wire(), 'condition': {'type': 'and', 'conds': [
        {'type': 'not', 'cond': {'type': 'ok', 'step': commit}}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    body = _json({'baton': None, 'requests': [{'type': 'batch', 'batch': {'steps': steps}},
                     {'type': 'get_autocommit'}, {'type': 'close'}]})
    if len(body) > MAX_PACKET_BYTES or len(steps) > MAX_STEPS:
        _fail('packet_limit')
    specs = tuple((s.label, s.sql, s.args, s.want_rows, s.result_spec) for s in all_specs)
    requests = (('batch', specs, commit, len(steps) - 1), ('get_autocommit', True), ('close',))
    return body, specs, requests


def _validate_packet_metadata(body, metadata, specs):
    # Public evidence must be closed before exposure, independently of the
    # stronger pre-send deterministic recompile. A frozen outer class alone
    # does not prevent dataclasses.replace or object.__setattr__ tampering.
    if (type(body) is not bytes or not 1 <= len(body) <= MAX_PACKET_BYTES
            or type(metadata) is not tuple or len(metadata) != len(_PACKET_METADATA_KEYS)
            or any(type(row) is not tuple or len(row) != 2 or type(row[0]) is not str for row in metadata)):
        _fail('packet_integrity_invalid')
    keys = tuple(row[0] for row in metadata)
    if keys != tuple(sorted(_PACKET_METADATA_KEYS)):
        _fail('packet_integrity_invalid')
    _native_frozen(metadata)
    meta = dict(metadata)
    if (meta['ok'] is not True or any(meta[key] is not False for key in _PACKET_REMOTE_FLAGS)
            or any(type(meta[key]) is not str or not _SHA.fullmatch(meta[key]) for key in _PACKET_DIGEST_KEYS)
            or any(type(meta[key]) is not str or meta[key] != value for key,value in
                   (('profile',PACKET_PROFILE),('evidence_scope','local_turso_scope_packet_compile'),
                    ('guard_profile',GUARD_PROFILE)))
            or type(meta['migration_id']) is not str
            or meta['migration_id'] != 'scope-migration-8-to-9:' + meta['resource_sha256']
            or any(type(meta[key]) is not int for key in ('from_schema','to_schema','receipt_rowid',
                   'packet_bytes','batch_steps','source_row_count','max_statement_args','max_response_bytes'))
            or meta['from_schema'] != 8 or meta['to_schema'] != 9
            or not 1 <= meta['source_row_count'] <= MAX_ROWS
            or not 1 <= meta['receipt_rowid'] <= min(_I64_MAX, meta['source_row_count'] + 1)
            or meta['packet_bytes'] != len(body) or meta['packet_sha256'] != _hash(body)
            or meta['max_response_bytes'] != MAX_RESPONSE_BYTES
            or type(specs) is not tuple or not 3 <= len(specs) <= MAX_STEPS
            or meta['batch_steps'] != len(specs)
            or any(type(spec) is not tuple or len(spec) != 5 or type(spec[2]) is not tuple
                   or len(spec[2]) > MAX_ARGS for spec in specs)
            or not 0 <= meta['max_statement_args'] <= MAX_ARGS
            or meta['max_statement_args'] != max(len(spec[2]) for spec in specs)):
        _fail('packet_integrity_invalid')
    code = _current_code()
    contract = tuple((name, sha) for name,sha in code if name != 'compiler')
    if (meta['compiler_sha256'] != dict(code)['compiler']
            or meta['contract_code_sha256'] != _hash(_json(contract))):
        _fail('packet_integrity_invalid')
    pre_counts = []
    for label,_sql,args,_want_rows,_result_spec in specs:
        if label == 'receipt:absent':
            break
        if type(label) is not str:
            _fail('packet_integrity_invalid')
        if label.startswith('count:'):
            if len(args) != 1 or type(args[0]) is not int or not 0 <= args[0] <= MAX_ROWS:
                _fail('packet_integrity_invalid')
            pre_counts.append(args[0])
    if not pre_counts or sum(pre_counts) != meta['source_row_count']:
        _fail('packet_integrity_invalid')
    return meta


@dataclass(frozen=True, slots=True, repr=False)
class CompiledPacket:
    body: bytes
    _metadata: tuple
    _recipe: tuple
    statement_specs: tuple
    request_specs: tuple
    _metadata_seal: str = field(init=False, repr=False)

    def __post_init__(self):
        if type(self.body) is not bytes or not 1 <= len(self.body) <= MAX_PACKET_BYTES:
            _fail('packet_integrity_invalid')
        for value in (self._metadata, self._recipe, self.statement_specs, self.request_specs):
            if type(value) is not tuple:
                _fail('packet_integrity_invalid')
            _native_frozen(value)
        if (not 3 <= len(self.statement_specs) <= MAX_STEPS
                or any(type(row) is not tuple or len(row) != 2 or type(row[0]) is not str
                       for row in self._metadata)
                or tuple(row[0] for row in self._metadata) != tuple(sorted(set(row[0] for row in self._metadata)))
                or len(self._recipe) != 3 or any(type(row) is not tuple or len(row) != 2
                   or any(type(value) is not str for value in row) for row in self._recipe)
                or tuple(row[0] for row in self._recipe) != ('created_at', 'guard_profile', 'resource_sha256')):
            _fail('packet_integrity_invalid')
        for spec in self.statement_specs:
            if type(spec) is not tuple or len(spec) != 5:
                _fail('packet_integrity_invalid')
            Statement(*spec)
        expected_requests = (('batch', self.statement_specs, len(self.statement_specs) - 2,
                              len(self.statement_specs) - 1), ('get_autocommit', True), ('close',))
        if not _same_native(self.request_specs, expected_requests):
            _fail('packet_integrity_invalid')
        _validate_packet_metadata(self.body, self._metadata, self.statement_specs)
        object.__setattr__(self, '_metadata_seal', _hash(_json(self._metadata)))

    @property
    def safe_metadata(self):
        # Fail closed on post-construction tampering; never filter/forward an
        # unknown field or claim a remote gate that this compiler cannot prove.
        result = _validate_packet_metadata(self.body, self._metadata, self.statement_specs)
        if type(self._metadata_seal) is not str or self._metadata_seal != _hash(_json(self._metadata)):
            _fail('packet_integrity_invalid')
        return result

    def artifact(self):
        # Private payload; do not log or put it in CI/GitHub artifacts.
        return {'profile': ARTIFACT_PROFILE, 'body': self.body, 'metadata': self._metadata,
                'recipe': self._recipe, 'statement_specs': self.statement_specs, 'request_specs': self.request_specs}


def compile_captured_packet(snapshot, *, expected_resource_sha256, guard_profile, created_at):
    expected_resource = _sha(expected_resource_sha256)
    if type(guard_profile) is not str or guard_profile != GUARD_PROFILE or type(created_at) is not str or not _UTC.fullmatch(created_at):
        _fail('invalid_compile_arguments')
    try:
        parsed = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
        if parsed.tzinfo != timezone.utc or parsed.isoformat(timespec='seconds').replace('+00:00', 'Z') != created_at:
            _fail('invalid_compile_arguments')
    except (ValueError, OverflowError):
        _fail('invalid_compile_arguments')
    code = _current_code()
    budget = _Budget(time.monotonic() + MAX_SECONDS)
    reference = None
    try:
        reference, raw, records, source_meta = _admit(snapshot, expected_resource, budget)
        migration_id = 'scope-migration-8-to-9:' + expected_resource
        receipt_rows = records['idempotency_responses'][1]
        id_col = records['idempotency_responses'][0].index('request_id') + 1
        endpoint_col = records['idempotency_responses'][0].index('endpoint') + 1
        if any(row[id_col] == migration_id and row[endpoint_col] == ENDPOINT for row in receipt_rows):
            _fail('existing_receipt_requires_reconcile')
        occupied = {row[0] for row in receipt_rows}
        receipt_rowid = next(number for number in range(1, len(occupied) + 2) if number not in occupied)
        target_schema, scope_records = _target(reference, raw.rows, budget)
        steps = [_guard('capability:atan2-zero', "typeof(atan2(0.0,-1.0))='real' AND atan2(0.0,-1.0)>0 "
            "AND atan2(-0.0,-1.0)<0 AND atan2(0.0,-1.0)=-atan2(-0.0,-1.0) AND "
            "typeof(?)='real' AND typeof(?)='real' AND atan2(?,-1.0)>0 AND atan2(?,-1.0)<0", (0.0, -0.0, 0.0, -0.0))]
        steps.extend(_schema_guards(raw.rows))
        for table, (columns, rows) in sorted(records.items()):
            steps.extend(_row_guards(table, columns, rows, budget))
        steps.append(_guard('receipt:absent', 'NOT EXISTS (SELECT 1 FROM idempotency_responses WHERE request_id=? AND endpoint=?)',
                            (migration_id, ENDPOINT)))
        steps.extend(Statement('ddl:' + str(index), sql) for index, sql in enumerate(_scope_ddl()))
        for table in scopes.SCOPE_TABLES:
            columns, rows = scope_records[table]
            names = ('rowid', *columns)
            size = MAX_ARGS // len(names)
            for offset in range(0, len(rows), size):
                budget.check()
                chunk = rows[offset:offset + size]
                slots = ','.join('(' + ','.join('?' for _ in names) + ')' for _ in chunk)
                sql = f'INSERT INTO "{table}"(' + ','.join('"' + name + '"' for name in names) + ') VALUES ' + slots
                steps.append(Statement('backfill:' + table + ':' + str(offset), sql, tuple(v for row in chunk for v in row)))
        steps.extend((Statement('version:cas', 'UPDATE _schema_version SET version=9 WHERE singleton=1 AND version=8'),
                      _guard('version:changes-one', 'changes()=1'),
                      _guard('version:post', '(SELECT COUNT(*) FROM _schema_version)=1 AND (SELECT '
                        "typeof(singleton)='integer' AND singleton=1 AND typeof(version)='integer' AND version=9 FROM _schema_version)")))
        steps.extend(_schema_guards(target_schema))
        for table, (columns, rows) in scope_records.items():
            steps.extend(_row_guards(table, columns, rows, budget))
        # Full old business postimage, not only new scopes. Version is the one
        # planned exception. Receipts are append-only with a separate count and
        # old-row guard after insertion; they are not claimed wholly unchanged.
        for table, (columns, rows) in sorted(records.items()):
            if table == 'idempotency_responses':
                continue
            post_rows = [(1, 1, 9)] if table == '_schema_version' else rows
            steps.extend(_row_guards(table, columns, post_rows, budget))
        receipt_post = [_guard('receipt:post-count', '(SELECT COUNT(*) FROM idempotency_responses)=?',
                               (len(receipt_rows) + 1,))]
        receipt_post.extend(_row_guards('idempotency_responses', records['idempotency_responses'][0],
                                        receipt_rows, budget, include_count=False))
        contract = tuple((name, sha) for name, sha in code if name != 'compiler')
        plan_frame = {'domain': 'fund-compass:turso-scope-plan-v1', 'profile': PACKET_PROFILE,
            'resource_sha256': expected_resource, 'migration_id': migration_id, 'endpoint': ENDPOINT,
            'from_schema': 8, 'to_schema': 9, 'source_image_sha256': source_meta['source_sha256'],
            'source_rows_sha256': source_meta['source_rows_sha256'], 'raw_schema_sha256': raw.exact_sha256,
            'source_contract_sha256': source_meta['source_contract_sha256'], 'guard_profile': guard_profile,
            'compiler_code': code, 'receipt_rowid': receipt_rowid, 'created_at': created_at,
            'prefix_statements': [statement._wire() for statement in steps],
            'receipt_post_statements': [statement._wire() for statement in receipt_post]}
        plan_sha = _hash(_json(plan_frame))
        response = _json({'profile': PACKET_PROFILE, 'migration_id': migration_id, 'plan_sha256': plan_sha,
                         'resource_sha256': expected_resource, 'from_schema': 8, 'to_schema': 9,
                         'source_rows_sha256': source_meta['source_rows_sha256'], 'raw_schema_sha256': raw.exact_sha256,
                         'guard_profile': guard_profile, 'receipt_rowid': receipt_rowid}).decode('ascii')
        receipt = (receipt_rowid, migration_id, ENDPOINT, plan_sha, 'complete', response, None, None, created_at, created_at)
        columns = ('rowid', *records['idempotency_responses'][0])
        steps.append(Statement('receipt:insert', 'INSERT INTO idempotency_responses(' + ','.join(columns)
                               + ') VALUES (' + ','.join('?' for _ in columns) + ')', receipt))
        steps.append(_guard('receipt:changes-one', 'changes()=1'))
        steps.extend(receipt_post)
        checks = ' AND '.join(_match('a."' + name + '"', 'e.e' + str(index)) for index, name in enumerate(columns))
        steps.append(_guard('receipt:exact', 'EXISTS (SELECT 1 FROM expected e JOIN idempotency_responses a '
            f'ON a.rowid=e.e0 WHERE {checks})', receipt,
            'WITH expected(' + ','.join('e' + str(i) for i in range(len(columns))) + ') AS (VALUES ('
            + ','.join('?' for _ in columns) + ')) '))
        body, specs, request_specs = _pipeline(tuple(steps))
        budget.check()
        if _current_code() != code:
            _fail('compiler_code_drift')
        metadata = {'ok': True, 'profile': PACKET_PROFILE, 'evidence_scope': 'local_turso_scope_packet_compile',
            'from_schema': 8, 'to_schema': 9, 'resource_sha256': expected_resource,
            'source_image_sha256': source_meta['source_sha256'], 'source_rows_sha256': source_meta['source_rows_sha256'],
            'raw_schema_sha256': raw.exact_sha256, 'source_contract_sha256': source_meta['source_contract_sha256'],
            'compiler_sha256': dict(code)['compiler'], 'contract_code_sha256': _hash(_json(contract)),
            'plan_sha256': plan_sha, 'packet_sha256': _hash(body), 'migration_id': migration_id,
            'receipt_rowid': receipt_rowid, 'guard_profile': guard_profile, 'packet_bytes': len(body),
            'batch_steps': len(specs), 'source_row_count': source_meta['row_count'],
            'max_statement_args': max(len(s.args) for s in steps), 'max_response_bytes': MAX_RESPONSE_BYTES,
            'remote_verified': False, 'remote_applied': False, 'remote_restore_verified': False,
            'formal_release_verified': False, 'apply_preimage_verified': False, 'server_capabilities_verified': False}
        packet = CompiledPacket(body, tuple(sorted(metadata.items())),
            (('created_at', created_at), ('guard_profile', guard_profile), ('resource_sha256', expected_resource)), specs, request_specs)
        budget.check()  # Include native deep freeze/validation in the compile budget.
        return packet
    except CompilerError:
        raise
    except offline.UpgradeError as error:
        if str(error) == 'rehearsal_time_limit':
            _fail('compile_time_limit')
        _fail('source_lineage_invalid')
    except Exception:
        _fail('source_context_invalid')
    finally:
        if reference is not None:
            reference.close()


def rehydrate_packet(snapshot, artifact, *, expected_resource_sha256, expected_plan_sha256, expected_packet_sha256):
    expected_resource = _sha(expected_resource_sha256)
    expected_plan = _sha(expected_plan_sha256)
    expected_packet = _sha(expected_packet_sha256)
    _current_code()
    keys = {'profile', 'body', 'metadata', 'recipe', 'statement_specs', 'request_specs'}
    if (type(artifact) is not dict or set(artifact) != keys or any(type(key) is not str for key in artifact)
            or type(artifact['profile']) is not str or artifact['profile'] != ARTIFACT_PROFILE
            or type(artifact['body']) is not bytes or not 1 <= len(artifact['body']) <= MAX_PACKET_BYTES
            or _hash(artifact['body']) != expected_packet
            or type(artifact['recipe']) is not tuple or len(artifact['recipe']) != 3
            or any(type(row) is not tuple or len(row) != 2 or any(type(value) is not str for value in row) for row in artifact['recipe'])
            or tuple(row[0] for row in artifact['recipe']) != ('created_at', 'guard_profile', 'resource_sha256')):
        _fail('artifact_invalid')
    for key in ('metadata', 'recipe', 'statement_specs', 'request_specs'):
        if type(artifact[key]) is not tuple:
            _fail('artifact_invalid')
        _native_frozen(artifact[key])
    recipe = dict(artifact['recipe'])
    if recipe['resource_sha256'] != expected_resource:
        _fail('artifact_invalid')
    expected = compile_captured_packet(snapshot, expected_resource_sha256=expected_resource,
                                      guard_profile=recipe['guard_profile'], created_at=recipe['created_at'])
    if expected.safe_metadata['plan_sha256'] != expected_plan or expected.safe_metadata['packet_sha256'] != expected_packet:
        _fail('packet_integrity_invalid')
    if any(not _same_native(artifact[key], expected.artifact()[key]) for key in keys):
        _fail('packet_integrity_invalid')
    return expected


def validate_packet_before_send(snapshot, packet, *, expected_resource_sha256, expected_plan_sha256, expected_packet_sha256):
    # This returns a recompiled packet only; it does not send or authorize a write.
    if type(packet) is not CompiledPacket:
        _fail('packet_integrity_invalid')
    return rehydrate_packet(snapshot, packet.artifact(), expected_resource_sha256=expected_resource_sha256,
                            expected_plan_sha256=expected_plan_sha256, expected_packet_sha256=expected_packet_sha256)
