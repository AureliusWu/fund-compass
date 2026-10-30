"""Pure local schema8 capture -> independently empty full-profile candidate.

Not a sender, provider capability test, startup hook or release gate. Original
source rows/raw schema are retained in a private source archive. Only the two
fixed operational tables are omitted from the *new* target. No caller DDL,
configured storage, credentials or network access is used.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time

from database import owner_sync_schema as owner, owner_analysis_schema as analysis
from database import owner_machine_schema as machine, turso_machine_profile as profile
from database import turso_scope_packet as kernel, turso_scope_upgrade as offline
from database import turso_projection_repair as repair, turso_owner_upgrade_packet as owner_packet
from database import turso_machine_upgrade as machine_upgrade

PROFILE = 'turso-clean-target-packet-2'
ARCHIVE_PROFILE = 'turso-clean-source-archive-1'
ARTIFACT_PROFILE = 'turso-clean-target-artifact-2'
REPAIR_PROFILE = 'clean-target-exact-ulp-derived-projection-1'
RECEIPT_SCHEMA = 'owner-clean-target-migration-receipt-1'
OCCURRENCE = 'profile:clean-target'
EXCLUDED_TABLES = ('turso_candidate_probe_v1', 'universe_import_state')
MAX_SECONDS = 30.0
MAX_REQUEST_BYTES = 16 * 1024 * 1024
_FLAGS = {'remote_applied': False, 'server_capabilities_verified': False,
    'restore_verified': False, 'durability_verified': False, 'retry_allowed': False,
    'formal_release_qualified': False, 'natural_schedule_verified': False,
    'sender_request_budget_verified': False}
_ERRORS = frozenset({'invalid_arguments', 'source_unavailable', 'source_identity_mismatch',
    'source_archive_mismatch', 'source_profile_unsupported', 'source_integrity_invalid',
    'repair_binding_mismatch', 'packet_identity_mismatch', 'packet_integrity_invalid',
    'capacity_exhausted', 'code_drift', 'operation_timeout', 'rehearsal_failed'})


class CleanTargetError(RuntimeError):
    def __init__(self, code='source_unavailable'):
        super().__init__(code if code in _ERRORS else 'source_unavailable')


def _fail(code):
    raise CleanTargetError(code) from None


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _code():
    root = Path(__file__).resolve().parents[1]
    paths = sorted({path for folder in ('database', 'models', 'service', 'strategy')
                    for path in (root / folder).glob('*.py')})
    result = []
    for path in paths:
        if not path.resolve().is_relative_to(root):
            _fail('code_drift')
        with path.open('rb') as source:
            raw = source.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            _fail('code_drift')
        raw.decode('utf-8', errors='strict')
        result.append((str(path.relative_to(root)), _sha(raw)))
    return tuple(result)


_LOADED = _code()


def _current_code():
    try:
        code = _code()
        if code != _LOADED:
            _fail('code_drift')
        # Original modules continue enforcing their OWN unchanged pins too.
        kernel._current_code()
        owner_packet._current_code()
        machine_upgrade._current_code()
        return code
    except CleanTargetError:
        raise
    except Exception:
        _fail('code_drift')


class _Budget(kernel._Budget):
    def __init__(self, deadline=None):
        import math
        self.last = time.monotonic()
        if not math.isfinite(self.last):
            _fail('operation_timeout')
        super().__init__(self.last + MAX_SECONDS if deadline is None else deadline)
        if not math.isfinite(self.deadline) or self.deadline <= self.last or self.deadline > self.last + MAX_SECONDS:
            _fail('operation_timeout')

    def check(self):
        import math
        now = time.monotonic()
        if not math.isfinite(now) or now < self.last or now >= self.deadline:
            _fail('operation_timeout')
        self.last = now

    def progress(self):
        self.sql_steps += 1000
        try:
            self.check()
            return int(self.sql_steps > 10_000_000)
        except CleanTargetError:
            return 1


def _identity(value):
    if type(value) is not str or not kernel._SHA.fullmatch(value):
        _fail('invalid_arguments')
    return value


def _stamp(value):
    if type(value) is not str or not kernel._UTC.fullmatch(value):
        _fail('invalid_arguments')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo != timezone.utc or parsed.isoformat(timespec='seconds').replace('+00:00', 'Z') != value:
            _fail('invalid_arguments')
    except (ValueError, OverflowError):
        _fail('invalid_arguments')
    return value


def _closed(error):
    if type(error) is CleanTargetError:
        raise error from None
    if isinstance(error, offline.UpgradeError) and str(error) in {'snapshot_limit_exceeded', 'snapshot_cell_limit_exceeded'}:
        _fail('capacity_exhausted')
    if isinstance(error, kernel.CompilerError) and str(error) in {'packet_limit', 'source_row_limit'}:
        _fail('capacity_exhausted')
    _fail('source_integrity_invalid')


def _archive(snapshot, source_resource, source_image, budget):
    _identity(source_resource); _identity(source_image)
    reference, raw, records, metadata = kernel._admit(snapshot, source_resource, budget)
    try:
        if metadata['source_sha256'] != source_image:
            _fail('source_identity_mismatch')
        # The immutable image contains ALL original rows, including operational
        # tables. The independent inventory preserves original raw DDL spelling.
        image = snapshot.connection.serialize()
        if _sha(image) != source_image:
            _fail('source_identity_mismatch')
        body = kernel._json({'profile': ARCHIVE_PROFILE, 'source_metadata': metadata,
            'raw_schema': raw.rows, 'source_image_base64': base64.b64encode(image).decode('ascii')})
        if len(body) > kernel.MAX_IMAGE_BYTES:
            _fail('capacity_exhausted')
        _archive_roundtrip(body, metadata, raw.rows, image, budget)
        safe = {'profile': ARCHIVE_PROFILE, 'source_resource_sha256': source_resource,
            'source_image_sha256': source_image, 'source_archive_sha256': _sha(body),
            'source_rows_sha256': metadata['source_rows_sha256'], 'raw_schema_sha256': raw.exact_sha256,
            'source_row_count': sum(len(rows) for _columns, rows in records.values()),
            'source_table_count': len(records), 'archive_bytes': len(body), **_FLAGS}
        budget.check()
        return body, safe, raw, records, metadata
    finally:
        reference.close()


def _archive_roundtrip(body, metadata, raw_rows, image, budget):
    """Cheap independent serialization boundary, no second SQLite/source scan."""
    budget.check()
    text = body.decode('utf-8', errors='strict')
    offline._validate_json(text)  # strict duplicate/finite/depth/node checks
    document = json.loads(text)
    if (type(document) is not dict or set(document) != {'profile', 'source_metadata', 'raw_schema', 'source_image_base64'}
            or document['profile'] != ARCHIVE_PROFILE or type(document['source_metadata']) is not dict
            or type(document['raw_schema']) is not list or len(document['raw_schema']) > 128
            or any(type(row) is not list for row in document['raw_schema'])
            or type(document['source_image_base64']) is not str):
        _fail('source_archive_mismatch')
    decoded = base64.b64decode(document['source_image_base64'], validate=True)
    if (not kernel._same_native(tuple(sorted(document['source_metadata'].items())), tuple(sorted(metadata.items())))
            or not kernel._same_native(tuple(tuple(row) for row in document['raw_schema']), raw_rows)
            or not kernel._same_native(decoded, image) or _sha(decoded) != metadata['source_sha256']
            or base64.b64encode(decoded).decode('ascii') != document['source_image_base64']):
        _fail('source_archive_mismatch')
    budget.check()


@contextmanager
def _archive_snapshot(body, budget):
    """Decode private native bytes, then let unchanged strict admission verify.

    No image/input DDL is executed to create a workspace. deserialize only
    installs the bounded image; the old compiler's read authorizer, inventory,
    exact typed rows and fixed-schema checks remain the final admission gate.
    """
    conn = None
    try:
        if type(body) is not bytes or not 1 <= len(body) <= kernel.MAX_IMAGE_BYTES:
            _fail('source_archive_mismatch')
        text = body.decode('utf-8', errors='strict')
        offline._validate_json(text)
        document = json.loads(text)
        if (type(document) is not dict or set(document) != {'profile', 'source_metadata', 'raw_schema', 'source_image_base64'}
                or document['profile'] != ARCHIVE_PROFILE or type(document['raw_schema']) is not list
                or type(document['source_image_base64']) is not str):
            _fail('source_archive_mismatch')
        metadata = kernel._metadata(document['source_metadata'])
        raw_rows = tuple(tuple(row) for row in document['raw_schema'])
        inventory = kernel.capture._ValidatedSchemaInventory(raw_rows,
            kernel.capture._schema_inventory_digest(raw_rows), metadata['resource_sha256'],
            metadata['source_sha256'], metadata['source_rows_sha256'])
        image = base64.b64decode(document['source_image_base64'], validate=True)
        if (not 16 <= len(image) <= kernel.MAX_IMAGE_BYTES or _sha(image) != metadata['source_sha256']
                or not image.startswith(b'SQLite format 3\x00')):
            _fail('source_archive_mismatch')
        budget.check()
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        conn.enable_load_extension(False)
        conn.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
        conn.deserialize(image)
        conn.execute('PRAGMA query_only=ON')
        conn.set_progress_handler(budget.progress, 1000)
        yield kernel.capture.CapturedSnapshot(conn, metadata, _schema_inventory=inventory)
        budget.check()
    finally:
        if conn is not None:
            try:
                conn.close()
            finally:
                budget.check()


@dataclass(frozen=True, slots=True)
class SourceArchive:
    body: bytes = field(repr=False)
    _safe_items: tuple = field(repr=False)

    @property
    def safe_metadata(self):
        try:
            budget = _Budget(); code = _current_code()
            with _archive_snapshot(self.body, budget) as snapshot:
                rebuilt, facts, *_ = _archive(snapshot, snapshot.safe_metadata['resource_sha256'],
                    snapshot.safe_metadata['source_sha256'], budget)
                if (not kernel._same_native(rebuilt, self.body)
                        or not kernel._same_native(tuple(sorted(facts.items())), self._safe_items)):
                    _fail('source_archive_mismatch')
            if _current_code() != code:
                _fail('code_drift')
            budget.check()
            return facts
        except Exception as error:
            _closed(error)


def archive_clean_source(snapshot, *, expected_source_resource_sha256, expected_source_image_sha256):
    """Return a PRIVATE complete archive; persist/hash it independently first."""
    try:
        budget = _Budget(); code = _current_code()
        body, safe, *_ = _archive(snapshot, expected_source_resource_sha256, expected_source_image_sha256, budget)
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
        return SourceArchive(body, tuple(sorted(safe.items())))
    except Exception as error:
        _closed(error)


def _records(conn, budget):
    return offline._snapshot_rows(conn, offline._objects(conn), _Budget(budget.deadline))


def _plain_pack(rows):
    """Only native int/text(no NUL)/NULL, with the OLD one-cell byte limit.

    Keep the old logical row chunk size. Stop streaming JSON encoding at the
    first oversized part, without assembling an arbitrarily large new cell.
    Any other native type or oversized pack takes the original exact path.
    """
    for row in rows:
        for value in row:
            if value is not None and type(value) not in (int, str):
                return None
            kernel._value(value)
            if type(value) is str and '\x00' in value:
                return None
    parts, size = [], 0
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    for part in encoder.iterencode(rows):
        size += len(part.encode('utf-8', errors='strict'))
        if size > kernel.MAX_CELL_BYTES:
            return None
        parts.append(part)
    return ''.join(parts)


def _plain_prefix(width):
    # Materialization is statement-local CTE evaluation, NOT a named TEMP
    # table/schema object. Decode once, rather than repeatedly per match leaf.
    aliases = ','.join('e' + str(index) for index in range(width))
    columns = []
    for index in range(width):
        path = f"'$[{index}]'"
        value = f'json_extract(p,{path})'
        columns.append(f"CASE json_type(p,{path}) WHEN 'integer' THEN "
            f"CASE WHEN typeof({value})='integer' THEN {value} ELSE abs(-9223372036854775808) END "
            f"WHEN 'text' THEN {value} WHEN 'null' THEN NULL ELSE abs(-9223372036854775808) END")
    return ("WITH packed AS MATERIALIZED (SELECT key AS ordinal,CASE WHEN type='array' AND "
        f"typeof(key)='integer' AND json_array_length(value)={width} THEN value ELSE abs(-9223372036854775808) END AS p "
        "FROM json_each(?)),expected(" + aliases + ") AS MATERIALIZED (SELECT " + ','.join(columns)
        + ' FROM packed ORDER BY ordinal) ')


def compact_capability_probe():
    """Fixed public-data readonly JSON1/MATERIALIZED/I64/UTF8 probe; zero I/O."""
    values = ((-9223372036854775808, 9223372036854775807, 9007199254740993, 0,
               '', '汉字Ω😀e\u0301é', 'a"b\\c\n\t\r\x01', None),)
    packed = _plain_pack(values)
    if packed is None:
        _fail('source_integrity_invalid')
    checks, parameters = [], [packed]
    for index, value in enumerate(values[0]):
        actual = f'e.e{index}'
        if type(value) is int:
            checks.append(f"typeof({actual})='integer' AND {actual} IS ?")
            parameters.append(value)
        elif type(value) is str:
            checks.append(f"typeof({actual})='text' AND CAST({actual} AS BLOB) IS X'{value.encode('utf-8').hex()}'")
        else:
            checks.append(f"typeof({actual})='null' AND {actual} IS NULL")
    predicate = '(SELECT COUNT(*) FROM expected)=1 AND EXISTS (SELECT 1 FROM expected e WHERE ' + ' AND '.join(checks) + ')'
    return kernel._guard('target:json1-plain-capability', predicate, tuple(parameters), _plain_prefix(8))


def _row_guards(table, columns, rows, budget, *, include_count=True):
    width = len(columns) + 1
    size = kernel.MAX_ARGS // width
    if include_count:
        yield kernel._guard('count:' + table, f'(SELECT COUNT(*) FROM main."{table}")=?', (len(rows),))
    names = ('rowid', *columns)
    # This matcher is used ONLY after _plain_pack admitted int/text/NULL and
    # the JSON1 decoder refused every other kind. Same-type I64 -> canonical
    # decimal bytes is injective, TEXT -> complete original bytes is exact and
    # NULL IS NULL. No REAL exists here, so generic CASE/atan2 is unnecessary.
    # The nonplain fallback still uses the original kernel matcher unchanged.
    matching = ' AND '.join(f'(typeof(a."{name}")=typeof(e.e{index}) AND '
        f'CAST(a."{name}" AS BLOB) IS CAST(e.e{index} AS BLOB))' for index, name in enumerate(names))
    for offset in range(0, len(rows), size):
        budget.check()
        chunk = rows[offset:offset + size]
        packed = _plain_pack(chunk)
        if packed is None:
            for statement in kernel._row_guards(table, columns, chunk, budget, include_count=False):
                yield kernel.Statement(f'rows:{table}:{offset}', statement.sql, statement.args,
                                       statement.want_rows, statement.result_spec)
            continue
        predicate = (f'(SELECT COUNT(*) FROM expected)={len(chunk)} AND '
            f'(SELECT COUNT(DISTINCT e0) FROM expected)={len(chunk)} AND NOT EXISTS '
            f'(SELECT 1 FROM expected e LEFT JOIN main."{table}" a ON a.rowid=e.e0 '
            f'WHERE a.rowid IS NULL OR NOT ({matching}))')
        yield kernel._guard(f'rows:{table}:{offset}', predicate, (packed,), _plain_prefix(width))


def _pipeline(statements):
    # Reuse the unchanged conditional FSM/spec builder; only this NEW profile
    # serializes the exact same JSON value tree as standard UTF-8 wire bytes.
    body, specs, requests = kernel._pipeline(statements)
    body = json.dumps(json.loads(body), ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8', errors='strict')
    if len(body) > MAX_REQUEST_BYTES:
        _fail('capacity_exhausted')
    return body, specs, requests


def _fixed_target(records, repaired, budget):
    # Fail closed rather than silently discarding a third source table to fit
    # 126 objects. sqlite_stat1 is not in this migration's exclusion contract.
    if 'sqlite_stat1' in records:
        _fail('source_profile_unsupported')
    retained = {name: value for name, value in repaired.items() if name not in EXCLUDED_TABLES}
    target = offline._source_reference('remote-schema-table', _Budget(budget.deadline))
    try:
        expected_tables = {name for kind, name in offline._objects(target) if kind == 'table'}
        if set(retained) != expected_tables:
            _fail('source_profile_unsupported')
        offline._seed_memory(target, retained)
        offline._integrity(target)
        if offline._rows_digest(_records(target, budget)) != offline._rows_digest(retained):
            _fail('source_integrity_invalid')
        # Complete original root/projection/derived validation remains final
        # authority. No reduced scope, unknown tables, epsilon or repair fallback.
        offline._scope_upgrade(target, 'remote-schema-table', budget)
        offline._repository_readback(target, budget)
        # The old offline scope rehearsal spells its newly created trigger
        # keywords differently from the ordinary native Owner verifier. Do not
        # weaken that verifier or execute captured DDL: rehouse the already
        # validated complete rows in the FIXED canonical core9 manifest instead.
        scope_rows = _records(target, budget)
        new_tables = set(owner.OWNER_SYNC_DDL) | set(analysis.OWNER_ANALYSIS_DDL) | set(machine.OWNER_MACHINE_DDL)
        manifest = profile.machine_profile_manifest()
        canonical = machine_upgrade._reference(tuple(row for row in manifest.objects if row[2] not in new_tables))
        try:
            if set(scope_rows) != {name for kind, name in offline._objects(canonical) if kind == 'table'}:
                _fail('source_integrity_invalid')
            offline._seed_memory(canonical, scope_rows)
            canonical.execute('PRAGMA user_version=9')
            if offline._rows_digest(_records(canonical, budget)) != offline._rows_digest(scope_rows):
                _fail('source_integrity_invalid')
        except Exception:
            canonical.close()
            raise
        target.close()
        target = canonical
        owner.provision_owner_sync_candidate(target, synthetic_candidate=True)
        analysis.provision_owner_analysis_candidate(target, synthetic_candidate=True)
        machine.provision_owner_machine_candidate(target, synthetic_candidate=True)
        if manifest.object_count != 126 or not machine_upgrade._same_schema(kernel._schema_rows(target), manifest.objects):
            _fail('source_integrity_invalid')
        result = _records(target, budget)
        expected = {name: (columns, [(1, 1, 9)] if name == '_schema_version' else rows)
                    for name, (columns, rows) in retained.items()}
        if offline._rows_digest({name: result[name] for name in retained}) != offline._rows_digest(expected):
            _fail('source_integrity_invalid')
        if (result['owner_sync_state'][1] != [(1, 1, 0)] or result['owner_sync_records'][1]
                or result['owner_sync_changes'][1] or result['owner_sync_receipts'][1]
                or result['owner_analysis_runs'][1] or result['owner_analysis_components'][1]
                or len(result['owner_machine_journal'][1]) != 1):
            _fail('source_integrity_invalid')
        budget.check()
        return target, manifest, result
    except Exception:
        target.close()
        raise


def _insert(table, columns, rows, budget):
    names = ('rowid', *columns)
    width = len(names)
    size = kernel.MAX_ARGS // width
    for offset in range(0, len(rows), size):
        budget.check()
        chunk = rows[offset:offset + size]
        packed = _plain_pack(chunk)
        label = f'backfill:{table}:{offset}'
        if packed is None:
            original = next(owner_packet._insert_rows(table, columns, chunk, budget))
            yield kernel.Statement(label, original.sql, original.args)
        else:
            sql = (_plain_prefix(width) + f'INSERT INTO "{table}"('
                + ','.join('"' + name + '"' for name in names) + ') SELECT '
                + ','.join('e' + str(index) for index in range(width)) + ' FROM expected')
            yield kernel.Statement(label, sql, (packed,))
        yield kernel._guard('affected:' + label, 'changes()=?', (len(chunk),))


def _build(snapshot, *, source_resource, source_image, source_archive, target_resource, created_at, budget):
    source_resource, source_image = _identity(source_resource), _identity(source_image)
    source_archive, target_resource = _identity(source_archive), _identity(target_resource)
    _stamp(created_at)
    if source_resource == target_resource:
        _fail('invalid_arguments')
    code = _current_code()
    archive, archive_meta, raw, records, source_meta = _archive(snapshot, source_resource, source_image, budget)
    if archive_meta['source_archive_sha256'] != source_archive:
        _fail('source_archive_mismatch')
    try:
        repaired, deltas = repair._derive(records, budget)
    except repair.ProjectionRepairError as error:
        if str(error) != 'repair_not_needed':
            raise
        repaired, deltas = records, ()
    repair_facts = {'profile': REPAIR_PROFILE, 'source_resource_sha256': source_resource,
        'source_image_sha256': source_image, 'source_archive_sha256': source_archive,
        'source_rows_sha256': source_meta['source_rows_sha256'], 'raw_schema_sha256': raw.exact_sha256,
        'repair_delta_sha256': _sha(kernel._json(deltas)),
        'repaired_rows_sha256': offline._rows_digest(repaired),
        'repaired_cell_count': len(deltas), 'repaired_row_count': len({delta[0] for delta in deltas}),
        'contract_code_sha256': _sha(kernel._json(code))}
    repair_sha = _sha(kernel._json(repair_facts))
    target = None
    try:
        target, manifest, target_rows = _fixed_target(records, repaired, budget)
        if sum(len(rows) for _columns, rows in target_rows.values()) + 1 > kernel.MAX_ROWS:
            _fail('capacity_exhausted')
        exclusion_rows = {name: records[name] for name in EXCLUDED_TABLES if name in records}
        facts = {**repair_facts, 'profile': PROFILE, 'repair_profile': REPAIR_PROFILE,
            'repair_sha256': repair_sha, 'target_resource_sha256': target_resource,
            'source_user_version': snapshot.connection.execute('PRAGMA user_version').fetchone()[0],
            'target_user_version': 0, 'target_schema_sha256': manifest.sha256,
            'target_raw_schema_sha256': kernel.capture._schema_inventory_digest(manifest.objects),
            'target_rows_before_receipt_sha256': offline._rows_digest(target_rows),
            'excluded_tables': EXCLUDED_TABLES, 'excluded_row_count': sum(len(rows) for _cols, rows in exclusion_rows.values()),
            'excluded_rows_sha256': offline._rows_digest(exclusion_rows), 'object_count': 126,
            'owner_initial_revision': 0, 'owner_initial_record_count': 0,
            'browser_holdings_synced': False, 'wire_encoding': 'utf8-json',
            'plain_pack_profile': 'native-int-text-no-nul-null-json1-1',
            'plain_probe_sha256': _sha(kernel._json(compact_capability_probe()._wire())),
            'source_row_count': sum(len(rows) for _cols, rows in records.values()),
            'source_table_count': len(records), 'created_at': created_at}
        steps = [kernel._guard('target:connection',
            "(SELECT foreign_keys FROM pragma_foreign_keys)=1 AND "
            "(SELECT COUNT(*) FROM pragma_database_list WHERE name NOT IN ('main','temp'))=0 AND "
            'NOT EXISTS (SELECT 1 FROM sqlite_temp_master)'),
            kernel._guard('target:empty', '(SELECT COUNT(*) FROM main.sqlite_master)=0'),
            kernel._guard('target:header-zero', '(SELECT typeof(user_version)=\'integer\' AND user_version=0 FROM pragma_user_version)'),
            kernel._guard('target:math', "typeof(atan2(0.0,-1.0))='real' AND atan2(0.0,-1.0)>0 AND atan2(-0.0,-1.0)<0")]
        steps.append(compact_capability_probe())
        for kind in ('table', 'index', 'view', 'trigger'):
            for row in manifest.objects:
                if row[0] == kind and row[3] is not None and row[1] != 'sqlite_sequence':
                    steps.append(kernel.Statement('target:ddl:' + row[1], row[3]))
        steps.append(kernel.Statement('target:defer-fk', 'PRAGMA defer_foreign_keys=ON'))
        for table, (columns, rows) in sorted(target_rows.items()):
            if table != 'sqlite_sequence':
                steps.extend(_insert(table, columns, rows, budget))
        # AUTOINCREMENT seed inserts can create sequence rows. Remove ONLY
        # these generated rows, then restore the complete original sequence,
        # including rowid and high-water values greater than MAX(id).
        auto = {row[1] for row in manifest.objects if row[0] == 'table' and row[3] and 'AUTOINCREMENT' in row[3].upper()}
        generated = sum(bool(target_rows[name][1]) for name in auto)
        steps += [kernel.Statement('sequence:clear-generated', 'DELETE FROM sqlite_sequence'),
                  kernel._guard('sequence:clear-count', 'changes()=?', (generated,))]
        steps.extend(_insert('sqlite_sequence', *target_rows['sqlite_sequence'], budget))
        steps.extend(kernel._schema_guards(manifest.objects))
        steps.append(kernel._guard('target:header-post', '(SELECT user_version=0 FROM pragma_user_version)'))
        for table, (columns, rows) in sorted(target_rows.items()):
            steps.extend(_row_guards(table, columns, rows, budget))
        steps.append(kernel._guard('target:fk-post', 'NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)'))
        plan_sha = _sha(kernel._json({'facts': facts, 'steps': [step._wire() for step in steps]}))
        migration_id = 'clean-target:' + target_resource
        receipt_id = 'clean-target:' + _sha(kernel._json((source_archive, target_resource, plan_sha)))
        receipt = {'schema': RECEIPT_SCHEMA, 'occurrence_id': OCCURRENCE, 'analysis_request_id': None,
            'created_at': created_at, 'migration_id': migration_id, 'plan_sha256': plan_sha, **facts, **_FLAGS}
        receipt_raw = kernel._json(receipt).decode('ascii')
        columns, journal = target_rows['owner_machine_journal']
        rowid = max((row[0] for row in journal), default=0) + 1
        receipt_row = (rowid, machine.OWNER_MACHINE_SCHEMA_VERSION, 'observation', receipt_id,
            OCCURRENCE, None, created_at, receipt_raw, _sha(receipt_raw.encode('ascii')))
        receipt_insert = next(owner_packet._insert_rows('owner_machine_journal', columns, [receipt_row], budget))
        steps += [kernel.Statement('receipt:insert', receipt_insert.sql, receipt_insert.args),
                  kernel._guard('receipt:changes-one', 'changes()=1')]
        target_rows['owner_machine_journal'] = (columns, [*journal, receipt_row])
        for statement in _row_guards('owner_machine_journal', columns, target_rows['owner_machine_journal'][1], budget):
            steps.append(kernel.Statement('receipt:post:' + statement.label, statement.sql,
                statement.args, statement.want_rows, statement.result_spec))
        body, specs, requests = _pipeline(tuple(steps))
        if len(body) > MAX_REQUEST_BYTES:
            _fail('capacity_exhausted')
        if (any(type(value) is float for spec in specs for value in spec[2])
                or len({spec[0] for spec in specs}) != len(specs)):
            _fail('packet_integrity_invalid')
        metadata = {**facts, **_FLAGS, 'plan_sha256': plan_sha, 'packet_sha256': _sha(body),
            'packet_bytes': len(body), 'batch_steps': len(specs), 'migration_id': migration_id,
            'receipt_id': receipt_id, 'receipt_rowid': rowid,
            'target_rows_sha256': offline._rows_digest(target_rows),
            'target_row_count': sum(len(rows) for _cols, rows in target_rows.values()),
            'max_statement_args': max(len(spec[2]) for spec in specs),
            'max_packet_bytes': MAX_REQUEST_BYTES, 'max_request_bytes': MAX_REQUEST_BYTES,
            'source_archive_limit_bytes': kernel.MAX_IMAGE_BYTES,
            'max_response_bytes': kernel.MAX_RESPONSE_BYTES}
        recipe = tuple(sorted({'created_at': created_at, 'source_resource_sha256': source_resource,
            'source_image_sha256': source_image, 'source_archive_sha256': source_archive,
            'target_resource_sha256': target_resource, 'repair_sha256': repair_sha}.items()))
        budget.check()
        if _current_code() != code:
            _fail('code_drift')
        return body, tuple(sorted(metadata.items())), recipe, specs, requests, archive
    finally:
        if target is not None:
            try:
                target.close()
            finally:
                budget.check()


@dataclass(frozen=True, slots=True, repr=False)
class CompiledCleanTarget:
    body: bytes
    _safe_items: tuple
    recipe: tuple
    statement_specs: tuple
    request_specs: tuple
    _private_archive: bytes = field(repr=False)

    def _validate_structure(self, budget):
        """No source authority: only an internally source-rebuilt fresh packet.

        External packets must still use _validate or original-source _rehydrate.
        This checks the complete native frame/controls/body/spec/recipe contract
        without doing the same source build a second time after _build.
        """
        budget.check()
        if type(self.body) is bytes and len(self.body) > MAX_REQUEST_BYTES:
            _fail('capacity_exhausted')
        meta = dict(self._safe_items)
        if (type(self.body) is not bytes or not 1 <= len(self.body) <= MAX_REQUEST_BYTES
                or meta.get('profile') != PROFILE or meta.get('packet_sha256') != _sha(self.body)
                or meta.get('packet_bytes') != len(self.body) or meta.get('object_count') != 126
                or meta.get('owner_initial_revision') != 0 or meta.get('owner_initial_record_count') != 0
                or meta.get('browser_holdings_synced') is not False
                or meta.get('source_resource_sha256') == meta.get('target_resource_sha256')
                or any(meta.get(key) is not False for key in _FLAGS)):
            _fail('packet_integrity_invalid')
        kernel._native_frozen(self._safe_items); kernel._native_frozen(self.recipe)
        kernel._native_frozen(self.statement_specs); kernel._native_frozen(self.request_specs)
        controls = (self.statement_specs[0][1], self.statement_specs[-2][1], self.statement_specs[-1][1])
        if controls != ('BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'):
            _fail('packet_integrity_invalid')
        rebuilt = _pipeline(tuple(kernel.Statement(*spec) for spec in self.statement_specs[1:-2]))
        if not kernel._same_native(rebuilt, (self.body, self.statement_specs, self.request_specs)):
            _fail('packet_integrity_invalid')
        recipe = dict(self.recipe)
        if (set(recipe) != {'source_resource_sha256', 'source_image_sha256', 'source_archive_sha256',
                'target_resource_sha256', 'repair_sha256', 'created_at'} or len(recipe) != len(self.recipe)):
            _fail('packet_integrity_invalid')
        budget.check()
        return meta

    def _validate(self, budget=None):
        budget = _Budget() if budget is None else budget
        meta = self._validate_structure(budget)
        # A body digest is NOT a seal for public facts. Public getters still
        # rebuild every fact from the original private archive, unchanged.
        recipe = dict(self.recipe)
        with _archive_snapshot(self._private_archive, budget) as snapshot:
            expected = _build(snapshot, **_arguments(recipe['source_resource_sha256'], recipe['source_image_sha256'],
                recipe['source_archive_sha256'], recipe['target_resource_sha256'], recipe['created_at']), budget=budget)
        observed = (self.body, self._safe_items, self.recipe, self.statement_specs, self.request_specs, self._private_archive)
        if not kernel._same_native(expected, observed):
            _fail('packet_integrity_invalid')
        budget.check()
        return meta

    @property
    def safe_metadata(self):
        try:
            return self._validate()
        except Exception as error:
            _closed(error)

    def artifact(self):
        try:
            self._validate()
        except Exception as error:
            _closed(error)
        return {'profile': ARTIFACT_PROFILE, 'body': self.body,
            'safe_metadata': self._safe_items, 'recipe': self.recipe}


def _arguments(expected_source_resource_sha256, expected_source_image_sha256,
        expected_source_archive_sha256, expected_target_resource_sha256, created_at):
    return dict(source_resource=expected_source_resource_sha256, source_image=expected_source_image_sha256,
        source_archive=expected_source_archive_sha256, target_resource=expected_target_resource_sha256,
        created_at=created_at)


def plan_clean_target(snapshot, *, expected_source_resource_sha256, expected_source_image_sha256,
        expected_source_archive_sha256, expected_target_resource_sha256, created_at):
    """Pure complete plan; independently retain its exact repair/plan hashes."""
    try:
        budget = _Budget()
        result = _build(snapshot, **_arguments(expected_source_resource_sha256,
            expected_source_image_sha256, expected_source_archive_sha256,
            expected_target_resource_sha256, created_at), budget=budget)
        return CompiledCleanTarget(*result)._validate(budget)
    except Exception as error:
        _closed(error)


def compile_clean_target(snapshot, *, expected_source_resource_sha256, expected_source_image_sha256,
        expected_source_archive_sha256, expected_target_resource_sha256, expected_repair_sha256, created_at):
    try:
        budget = _Budget()
        expected_repair = _identity(expected_repair_sha256)
        result = _build(snapshot, **_arguments(expected_source_resource_sha256,
            expected_source_image_sha256, expected_source_archive_sha256,
            expected_target_resource_sha256, created_at), budget=budget)
        packet = CompiledCleanTarget(*result)
        if packet._validate(budget)['repair_sha256'] != expected_repair:
            _fail('repair_binding_mismatch')
        return packet
    except Exception as error:
        _closed(error)


def rehydrate_clean_target(snapshot, artifact, *, expected_source_resource_sha256,
        expected_source_image_sha256, expected_source_archive_sha256, expected_target_resource_sha256,
        expected_plan_sha256, expected_packet_sha256):
    """Recompile independently; neither edited metadata nor resealing grants trust."""
    try:
        return _rehydrate(snapshot, artifact, expected_source_resource_sha256=expected_source_resource_sha256,
            expected_source_image_sha256=expected_source_image_sha256,
            expected_source_archive_sha256=expected_source_archive_sha256,
            expected_target_resource_sha256=expected_target_resource_sha256,
            expected_plan_sha256=expected_plan_sha256, expected_packet_sha256=expected_packet_sha256,
            budget=_Budget())
    except Exception as error:
        _closed(error)


def _rehydrate(snapshot, artifact, *, expected_source_resource_sha256, expected_source_image_sha256,
        expected_source_archive_sha256, expected_target_resource_sha256,
        expected_plan_sha256, expected_packet_sha256, budget):
    try:
        code = _current_code()
        if type(artifact) is dict and type(artifact.get('body')) is bytes and len(artifact['body']) > MAX_REQUEST_BYTES:
            _fail('capacity_exhausted')
        if (type(artifact) is not dict or set(artifact) != {'profile', 'body', 'safe_metadata', 'recipe'}
                or artifact['profile'] != ARTIFACT_PROFILE or type(artifact['recipe']) is not tuple
                or type(artifact['safe_metadata']) is not tuple or type(artifact['body']) is not bytes):
            _fail('packet_integrity_invalid')
        _identity(expected_plan_sha256); _identity(expected_packet_sha256)
        recipe = dict(artifact['recipe'])
        if set(recipe) != {'source_resource_sha256', 'source_image_sha256', 'source_archive_sha256',
                'target_resource_sha256', 'repair_sha256', 'created_at'} or len(recipe) != len(artifact['recipe']):
            _fail('packet_integrity_invalid')
        packet = CompiledCleanTarget(*_build(snapshot, **_arguments(expected_source_resource_sha256,
            expected_source_image_sha256, expected_source_archive_sha256,
            expected_target_resource_sha256, recipe['created_at']), budget=budget))
        # Freshly built above from the actual original snapshot and all external
        # identities. Do NOT scan that same immutable source again merely to
        # validate our own generated output; compare its entire frozen frame.
        metadata = packet._validate_structure(budget)
        if (metadata['plan_sha256'] != expected_plan_sha256 or metadata['packet_sha256'] != expected_packet_sha256
                or not kernel._same_native(packet.body, artifact['body'])
                or not kernel._same_native(packet._safe_items, artifact['safe_metadata'])
                or not kernel._same_native(packet.recipe, artifact['recipe'])):
            _fail('packet_identity_mismatch')
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
        return packet
    except Exception as error:
        _closed(error)


def rehearse_clean_target(snapshot, packet):
    """Execute on a NEW empty native memory DB; source never receives writes."""
    conn = None
    try:
        if type(packet) is not CompiledCleanTarget:
            _fail('invalid_arguments')
        budget = _Budget(); code = _current_code()
        # These frozen/native members are only a PROPOSAL, not authentication.
        # The full source-bound rehydration below independently derives the
        # canonical frame under this same budget. Do not rescan the same source
        # only to authenticate our own generated output again.
        if (type(packet.body) is not bytes or type(packet._private_archive) is not bytes
                or type(packet._safe_items) is not tuple or type(packet.recipe) is not tuple
                or type(packet.statement_specs) is not tuple or type(packet.request_specs) is not tuple):
            _fail('packet_integrity_invalid')
        for value in (packet._safe_items, packet.recipe, packet.statement_specs, packet.request_specs):
            kernel._native_frozen(value)
        if any(type(item) is not tuple or len(item) != 2 or type(item[0]) is not str for item in packet._safe_items):
            _fail('packet_integrity_invalid')
        meta = dict(packet._safe_items)
        if len(meta) != len(packet._safe_items):
            _fail('packet_integrity_invalid')
        original_members = (packet.body, packet._safe_items, packet.recipe,
                            packet.statement_specs, packet.request_specs, packet._private_archive)
        original_artifact = {'profile': ARTIFACT_PROFILE, 'body': packet.body,
            'safe_metadata': packet._safe_items, 'recipe': packet.recipe}
        packet = _rehydrate(snapshot, original_artifact, budget=budget, **{
            'expected_' + key: meta[key] for key in ('source_resource_sha256', 'source_image_sha256',
                'source_archive_sha256', 'target_resource_sha256', 'plan_sha256', 'packet_sha256')})
        canonical_members = (packet.body, packet._safe_items, packet.recipe,
                             packet.statement_specs, packet.request_specs, packet._private_archive)
        if not kernel._same_native(original_members, canonical_members):
            _fail('packet_integrity_invalid')
        meta = dict(packet._safe_items)
        budget.check()
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        conn.set_progress_handler(budget.progress, 1000)
        budget.check()
        transaction_started = budget.last
        transaction_sql_started = budget.sql_steps
        conn.execute('BEGIN IMMEDIATE')
        try:
            for _label, sql, args, want_rows, spec in packet.statement_specs[1:-2]:
                budget.check()
                cursor = conn.execute(sql, args)
                rows = tuple(tuple(row) for row in cursor.fetchall())
                if want_rows and (rows != ((1,),) or type(rows[0][0]) is not int):
                    _fail('rehearsal_failed')
                if not want_rows and rows:
                    _fail('rehearsal_failed')
            conn.commit()
            budget.check()
            transaction_finished = budget.last
            transaction_sql_finished = budget.sql_steps
        except Exception:
            conn.rollback()
            raise
        rows = _records(conn, budget)
        if (kernel._schema_rows(conn) != profile.machine_profile_manifest().objects
                or offline._rows_digest(rows) != meta['target_rows_sha256']
                or conn.execute('PRAGMA user_version').fetchone()[0] != 0
                or conn.execute('PRAGMA foreign_key_check').fetchone() is not None):
            _fail('rehearsal_failed')
        if (_sha(snapshot.connection.serialize()) != meta['source_image_sha256']
                or _current_code() != code):
            _fail('code_drift')
        budget.check()
        return {'ok': True, 'profile': PROFILE, 'evidence_scope': 'local_clean_target_rehearsal',
            'source_archive_sha256': meta['source_archive_sha256'], 'plan_sha256': meta['plan_sha256'],
            'packet_sha256': meta['packet_sha256'], 'object_count': 126,
            'local_transaction_seconds': transaction_finished - transaction_started,
            'verification_rows_charged': budget.rows,
            'operation_sql_progress_steps': budget.sql_steps,
            'local_transaction_sql_progress_steps': transaction_sql_finished - transaction_sql_started,
            'source_unchanged': True, 'owner_initial_revision': 0,
            'browser_holdings_synced': False, **_FLAGS}
    except Exception as error:
        _closed(error)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                _fail('rehearsal_failed')
            finally:
                budget.check()
