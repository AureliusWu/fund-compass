"""Explicit local compiler for a repair + scope + Owner migration packet.

This is a separate profile, not a relaxation of the scope-v1 compiler and not
an apply tool. It requires a separately planned repair digest. Only fixed
repository DDL is executable; captured DDL is exact pre/postimage data. Packet
bytes/artifacts contain private data and must never enter logs or CI artifacts.
No connection, credential, pause, capacity, backup or release authority is
acquired here. Existing scope transport/verifiers do not accept this type.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
import time

from database import exact_real, owner_sync_schema as owner, turso_projection_repair as repair
from database import turso_scope_packet as c, turso_scope_snapshot as capture, turso_scope_upgrade as offline


PROFILE = 'turso-owner-upgrade-packet-v1'
ARTIFACT_PROFILE = 'turso-owner-upgrade-artifact-v1'
REPAIR_PROFILE = 'evidence-one-ulp-v1'
ENDPOINT = 'reserved:owner-upgrade:8-to-9:v1'
_TRIGGER = ('trigger', 'immutable_evidence_snapshots_update')
_FLAGS = c._PACKET_REMOTE_FLAGS
_DIGESTS = c._PACKET_DIGEST_KEYS | frozenset({
    'repair_sha256', 'repair_delta_sha256', 'repaired_rows_sha256',
    'target_raw_schema_sha256', 'target_rows_before_receipt_sha256',
})
_FACTS = {'legacy_rows_unchanged': False, 'immutable_payloads_ids_hashes_unchanged': True,
          'only_declared_projection_cells_changed': True}
_KEYS = _DIGESTS | _FLAGS | frozenset(_FACTS) | frozenset({
    'ok', 'profile', 'evidence_scope', 'repair_profile', 'guard_profile',
    'migration_id', 'from_schema', 'to_schema', 'receipt_rowid', 'packet_bytes',
    'batch_steps', 'source_row_count', 'max_statement_args', 'max_response_bytes',
    'repaired_cell_count', 'repaired_row_count', 'restored_trigger_raw_ddl_changed', 'source_user_version',
})
_RECIPE = ('created_at', 'guard_profile', 'repair_profile', 'resource_sha256', 'repair_sha256')
_REPAIR_FACT_KEYS = ('resource_sha256', 'source_image_sha256', 'source_rows_sha256',
    'raw_schema_sha256', 'source_contract_sha256', 'repair_delta_sha256', 'repaired_rows_sha256',
    'target_raw_schema_sha256', 'target_rows_before_receipt_sha256', 'compiler_sha256',
    'contract_code_sha256', 'repaired_cell_count', 'repaired_row_count', 'restored_trigger_raw_ddl_changed',
    'source_user_version')
_EXTRA_ERRORS = frozenset({'repair_binding_mismatch', 'repair_not_needed',
    'repair_admission_failed', 'repair_difference_invalid', 'repair_image_mismatch',
    'owner_target_invalid'})


class CompilerError(Exception):
    """Closed error enum only, never SQL, source values or exception messages."""
    def __init__(self, code):
        super().__init__(code if type(code) is str and code in c._ERRORS | _EXTRA_ERRORS
                         else 'packet_integrity_invalid')


def _fail(code):
    raise CompilerError(code)


def _own_code():
    rows = []
    for name, path in (('owner_compiler', Path(__file__).resolve()),
                       ('repair', Path(repair.__file__).resolve()),
                       ('owner_schema', Path(owner.__file__).resolve()),
                       ('exact_real', Path(exact_real.__file__).resolve())):
        with path.open('rb') as source:
            raw = source.read(1024 * 1024 + 1)
        if not 1 <= len(raw) <= 1024 * 1024:
            _fail('compiler_code_drift')
        raw.decode('utf-8', errors='strict')
        rows.append((name, c._hash(raw)))
    return tuple(rows)


_LOADED_OWN_CODE = _own_code()


def _current_code():
    try:
        current = _own_code()
        if current != _LOADED_OWN_CODE:
            _fail('compiler_code_drift')
        return (*c._current_code(), *current)
    except CompilerError:
        raise
    except Exception:
        _fail('compiler_code_drift')


def _identity(resource, repair_profile):
    c._sha(resource)
    if type(repair_profile) is not str or repair_profile != REPAIR_PROFILE:
        _fail('invalid_compile_arguments')


def _timestamp(value):
    if type(value) is not str or not c._UTC.fullmatch(value):
        _fail('invalid_compile_arguments')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo != timezone.utc or parsed.isoformat(timespec='seconds').replace('+00:00', 'Z') != value:
            _fail('invalid_compile_arguments')
    except (ValueError, OverflowError):
        _fail('invalid_compile_arguments')


def _prepare(snapshot, resource, repair_profile, budget):
    """Re-derive from the original capture, never trust a caller's repaired rows."""
    _identity(resource, repair_profile)
    code = _current_code()
    reference = target = None
    try:
        reference, raw, records, source_meta = c._admit(snapshot, resource, budget)
        canonical = c._schema_rows(reference)
        header = reference.execute('PRAGMA user_version').fetchone()[0]
        trigger = next(row for row in canonical if row[:2] == _TRIGGER)
        repaired, deltas = repair._derive(records, budget)
        operational = frozenset(row[1] for row in raw.rows if row[0] == 'table'
                                and row[1] in offline._OPERATIONAL_DEFINITIONS)
        options = dict(operational_objects=operational,
                       optimizer_statistics=any(row[:2] == ('table', 'sqlite_stat1') for row in raw.rows))
        # Fixed canonical DDL only, with the complete typed repaired rows.
        target = repair._new_repaired(repaired, offline._objects(reference), header,
                                      'remote-schema-table', options, budget)
        target_schema, scope_records = c._target(target, raw.rows, budget)
        # c._target deliberately retains source raw spelling. Here the one
        # dropped/recreated trigger MUST instead have repository-owned spelling.
        target.execute('BEGIN IMMEDIATE')
        for ddl in owner.OWNER_SYNC_DDL.values():
            budget.check()
            target.execute(ddl)
        target.execute('INSERT INTO owner_sync_schema(singleton,version) VALUES(1,?)',
                       (owner.OWNER_SYNC_SCHEMA_VERSION,))
        target.execute('INSERT INTO owner_sync_state(singleton,revision) VALUES(1,0)')
        target.commit()
        canonical_target = c._schema_rows(target)
        retained = {(row[0], row[1]): row for row in target_schema}
        retained[_TRIGGER] = trigger
        for row in canonical_target:
            retained.setdefault((row[0], row[1]), row)
        target_schema = tuple(retained[key] for key in sorted(retained))
        c._supported_schema(target_schema, canonical_target)
        # Remote version is _schema_version. Do not rewrite PRAGMA user_version
        # merely to satisfy the separate local-only Owner provisioning helper.
        c.db._verify_v8_schema_contract(target)
        offline._integrity(target)
        target_records = offline._snapshot_rows(target, offline._objects(target), budget)
        old_post = {name: target_records[name] for name in repaired}
        old_expected = {name: (columns, [(1, 1, 9)] if name == '_schema_version' else rows)
                        for name, (columns, rows) in repaired.items()}
        if offline._rows_digest(old_post) != offline._rows_digest(old_expected):
            _fail('repair_image_mismatch')
        expected_owner = {'owner_sync_schema': [(1, 1, owner.OWNER_SYNC_SCHEMA_VERSION)],
                          'owner_sync_state': [(1, 1, 0)], 'owner_sync_records': [],
                          'owner_sync_changes': [], 'owner_sync_receipts': []}
        if any(target_records[name][1] != rows for name, rows in expected_owner.items()):
            _fail('owner_target_invalid')
        facts = dict(resource_sha256=resource, source_image_sha256=source_meta['source_sha256'],
            source_rows_sha256=source_meta['source_rows_sha256'], raw_schema_sha256=raw.exact_sha256,
            source_contract_sha256=source_meta['source_contract_sha256'],
            repair_delta_sha256=c._hash(c._json(deltas)), repaired_rows_sha256=offline._rows_digest(repaired),
            target_raw_schema_sha256=capture._schema_inventory_digest(target_schema),
            target_rows_before_receipt_sha256=offline._rows_digest(target_records),
            compiler_sha256=dict(code)['owner_compiler'], contract_code_sha256=c._hash(c._json(code)),
            repaired_cell_count=len(deltas), repaired_row_count=len({row[0] for row in deltas}),
            source_user_version=header,
            restored_trigger_raw_ddl_changed=next(row for row in raw.rows if row[:2] == _TRIGGER) != trigger)
        binding = {'domain': 'fund-compass:owner-upgrade-repair-v1', 'repair_profile': repair_profile,
                   'facts': facts, 'code': code}
        facts['repair_sha256'] = c._hash(c._json(binding))
        budget.check()
        if _current_code() != code:
            _fail('compiler_code_drift')
        return raw, records, repaired, deltas, trigger, target_schema, target_records, facts, code
    finally:
        if reference is not None:
            reference.close()
        if target is not None:
            target.close()


def _closed_error(error):
    if isinstance(error, CompilerError):
        raise error
    if isinstance(error, (c.CompilerError, repair.ProjectionRepairError)):
        _fail(str(error))
    if isinstance(error, offline.UpgradeError):
        _fail('compile_time_limit' if str(error) == 'rehearsal_time_limit' else 'source_lineage_invalid')
    _fail('source_context_invalid')


def plan_captured_owner_repair(snapshot, *, expected_resource_sha256, repair_profile):
    """Safe local plan only. Its digest must be independently retained for compile."""
    try:
        budget = c._Budget(time.monotonic() + c.MAX_SECONDS)
        *_, facts, code = _prepare(snapshot, expected_resource_sha256, repair_profile, budget)
        result = {'ok': True, 'profile': REPAIR_PROFILE, 'evidence_scope': 'local_owner_upgrade_repair_plan',
                  **facts, **_FACTS, **{key: False for key in _FLAGS}}
        if _current_code() != code:
            _fail('compiler_code_drift')
        budget.check()
        return result
    except Exception as error:
        _closed_error(error)


def _insert_rows(table, columns, rows, budget):
    # Only names from the admitted fixed schema may reach this helper.
    names = ('rowid', *columns)
    size = c.MAX_ARGS // len(names)
    for offset in range(0, len(rows), size):
        budget.check()
        args, values = [], []
        for row in rows[offset:offset + size]:
            slots = []
            for value in row:
                if type(value) is float:
                    fragment, bound = exact_real.exact_real_binding(value)
                else:
                    fragment, bound = '?', (value,)
                slots.append(fragment)
                args.extend(bound)
            values.append('(' + ','.join(slots) + ')')
        yield c.Statement('backfill:' + table + ':' + str(offset),
            f'INSERT INTO "{table}"(' + ','.join('"' + name + '"' for name in names)
            + ') VALUES ' + ','.join(values), tuple(args))


def _plan_frame(facts, choices, migration_id, receipt_rowid, prefix, receipt_post):
    return dict(domain='fund-compass:owner-upgrade-plan-v1', profile=PROFILE, facts=facts,
        migration_id=migration_id, endpoint=ENDPOINT, guard_profile=choices['guard_profile'],
        repair_profile=choices['repair_profile'], created_at=choices['created_at'], receipt_rowid=receipt_rowid,
        prefix_statements=[s._wire() for s in prefix], receipt_post_statements=[s._wire() for s in receipt_post])


def _receipt_response(facts, migration_id, plan_sha, receipt_rowid):
    return c._json(dict(profile=PROFILE, migration_id=migration_id, plan_sha256=plan_sha,
        resource_sha256=facts['resource_sha256'], repair_sha256=facts['repair_sha256'], from_schema=8, to_schema=9,
        target_raw_schema_sha256=facts['target_raw_schema_sha256'],
        target_rows_before_receipt_sha256=facts['target_rows_before_receipt_sha256'],
        receipt_rowid=receipt_rowid)).decode('ascii')


def _validate(body, metadata, recipe, specs, requests):
    """Closed public facts and immutable private packet, without trusting a seal."""
    for value in (metadata, recipe, specs, requests):
        if type(value) is not tuple:
            _fail('packet_integrity_invalid')
        c._native_frozen(value)
    if (any(type(row) is not tuple or len(row) != 2 or type(row[0]) is not str for row in metadata)
            or tuple(row[0] for row in metadata) != tuple(sorted(_KEYS))
            or any(type(row) is not tuple or len(row) != 2 or any(type(v) is not str for v in row) for row in recipe)
            or tuple(row[0] for row in recipe) != _RECIPE):
        _fail('packet_integrity_invalid')
    meta, choices = dict(metadata), dict(recipe)
    code = _current_code()
    _timestamp(choices['created_at'])
    if (meta['ok'] is not True or meta['profile'] != PROFILE
            or meta['evidence_scope'] != 'local_owner_upgrade_packet_compile'
            or meta['guard_profile'] != c.GUARD_PROFILE or meta['repair_profile'] != REPAIR_PROFILE
            or choices['guard_profile'] != c.GUARD_PROFILE or choices['repair_profile'] != REPAIR_PROFILE
            or choices['resource_sha256'] != meta['resource_sha256']
            or choices['repair_sha256'] != meta['repair_sha256']
            or any(meta[key] is not False for key in _FLAGS)
            or any(meta[key] is not value for key, value in _FACTS.items())
            or type(meta['restored_trigger_raw_ddl_changed']) is not bool
            or any(type(meta[key]) is not str or not c._SHA.fullmatch(meta[key]) for key in _DIGESTS)
            or meta['compiler_sha256'] != dict(code)['owner_compiler']
            or meta['contract_code_sha256'] != c._hash(c._json(code))
            or meta['migration_id'] != 'owner-upgrade-8-to-9:' + meta['resource_sha256']
            or any(type(meta[key]) is not int for key in ('from_schema', 'to_schema', 'receipt_rowid',
                'packet_bytes', 'batch_steps', 'source_row_count', 'max_statement_args',
                'max_response_bytes', 'repaired_cell_count', 'repaired_row_count', 'source_user_version'))
            or meta['from_schema'] != 8 or meta['to_schema'] != 9
            or meta['source_user_version'] not in (0, 8)
            or not 1 <= meta['source_row_count'] <= c.MAX_ROWS
            or not 1 <= meta['repaired_row_count'] <= meta['repaired_cell_count'] <= 2 * meta['source_row_count']
            or not 1 <= meta['receipt_rowid'] <= min(c._I64_MAX, meta['source_row_count'] + 1)
            or not 3 <= len(specs) <= c.MAX_STEPS):
        _fail('packet_integrity_invalid')
    for spec in specs:
        if (type(spec) is not tuple or len(spec) != 5 or type(spec[2]) is not tuple
                or any(type(v) is float for v in spec[2])):
            _fail('packet_integrity_invalid')
        c.Statement(*spec)
    expected_body, expected_specs, expected_requests = c._pipeline(tuple(c.Statement(*row) for row in specs[1:-2]))
    if (type(body) is not bytes or body != expected_body or not c._same_native(specs, expected_specs)
            or not c._same_native(requests, expected_requests) or meta['packet_bytes'] != len(body)
            or meta['packet_sha256'] != c._hash(body) or meta['batch_steps'] != len(specs)
            or meta['max_statement_args'] != max(len(row[2]) for row in specs)
            or meta['max_response_bytes'] != c.MAX_RESPONSE_BYTES):
        _fail('packet_integrity_invalid')
    # Cross-bind public facts to the actual immutable packet, not just a
    # constructor-created seal. A dataclasses.replace with plausible new
    # counts, digests or DDL-change claims must not publish those as evidence.
    labels = [row[0] for row in specs]
    if labels.count('receipt:insert') != 1 or labels.count('receipt:absent') != 1:
        _fail('packet_integrity_invalid')
    insert_at, absent_at = labels.index('receipt:insert'), labels.index('receipt:absent')
    if not absent_at < insert_at < len(specs) - 4 or labels[insert_at + 1] != 'receipt:changes-one':
        _fail('packet_integrity_invalid')
    counts = [row[2] for row in specs[1:absent_at] if row[0].startswith('count:')]
    if (not counts or any(len(args) != 1 or type(args[0]) is not int or not 0 <= args[0] <= c.MAX_ROWS for args in counts)
            or sum(args[0] for args in counts) != meta['source_row_count']):
        _fail('packet_integrity_invalid')
    headers = [row for row in specs if row[0] in ('header:source', 'header:post')]
    if (tuple(row[0] for row in headers) != ('header:source', 'header:post')
            or any(not c._same_native(row[2], (meta['source_user_version'],)) for row in headers)):
        _fail('packet_integrity_invalid')
    cells = [row for row in specs[absent_at + 1:insert_at] if row[0].startswith('repair:cell:')]
    if (len(cells) != meta['repaired_cell_count'] or any(len(row[2]) != 5 or type(row[2][1]) is not int for row in cells)
            or len({row[2][1] for row in cells}) != meta['repaired_row_count']):
        _fail('packet_integrity_invalid')
    schemas = [row[2] for row in specs if row[0] == 'schema:exact-raw']
    if len(schemas) != 2 or any(len(args) % 4 for args in schemas):
        _fail('packet_integrity_invalid')
    before_schema, after_schema = [tuple(tuple(args[i:i + 4]) for i in range(0, len(args), 4)) for args in schemas]
    before_trigger = [row for row in before_schema if row[:2] == _TRIGGER]
    after_trigger = [row for row in after_schema if row[:2] == _TRIGGER]
    if (len(before_trigger) != 1 or len(after_trigger) != 1
            or capture._schema_inventory_digest(before_schema) != meta['raw_schema_sha256']
            or capture._schema_inventory_digest(after_schema) != meta['target_raw_schema_sha256']
            or (before_trigger != after_trigger) is not meta['restored_trigger_raw_ddl_changed']):
        _fail('packet_integrity_invalid')
    facts = {key: meta[key] for key in _REPAIR_FACT_KEYS}
    expected_repair = c._hash(c._json({'domain': 'fund-compass:owner-upgrade-repair-v1',
        'repair_profile': REPAIR_PROFILE, 'facts': facts, 'code': code}))
    if expected_repair != meta['repair_sha256']:
        _fail('packet_integrity_invalid')
    facts['repair_sha256'] = expected_repair
    frame = _plan_frame(facts, choices, meta['migration_id'], meta['receipt_rowid'],
        tuple(c.Statement(*row) for row in specs[1:insert_at]),
        tuple(c.Statement(*row) for row in specs[insert_at + 2:-3]))
    if c._hash(c._json(frame)) != meta['plan_sha256']:
        _fail('packet_integrity_invalid')
    expected_receipt = (meta['receipt_rowid'], meta['migration_id'], ENDPOINT, meta['plan_sha256'], 'complete',
        _receipt_response(facts, meta['migration_id'], meta['plan_sha256'], meta['receipt_rowid']),
        None, None, choices['created_at'], choices['created_at'])
    if not c._same_native(specs[insert_at][2], expected_receipt):
        _fail('packet_integrity_invalid')
    return meta


@dataclass(frozen=True, slots=True, repr=False)
class CompiledOwnerPacket:
    body: bytes
    _metadata: tuple
    _recipe: tuple
    statement_specs: tuple
    request_specs: tuple
    _seal: str = field(init=False, repr=False)

    def __post_init__(self):
        try:
            budget = c._Budget(time.monotonic() + c.MAX_SECONDS)
            _validate(self.body, self._metadata, self._recipe, self.statement_specs, self.request_specs)
            object.__setattr__(self, '_seal', c._hash(c._json(self._metadata)))
            _current_code()
            budget.check()
        except Exception as error:
            _closed_error(error)

    @property
    def safe_metadata(self):
        try:
            budget = c._Budget(time.monotonic() + c.MAX_SECONDS)
            result = _validate(self.body, self._metadata, self._recipe, self.statement_specs, self.request_specs)
            if self._seal != c._hash(c._json(self._metadata)):
                _fail('packet_integrity_invalid')
            _current_code()
            budget.check()
            return result
        except Exception as error:
            _closed_error(error)

    def artifact(self):
        return {'profile': ARTIFACT_PROFILE, 'body': self.body, 'metadata': self._metadata,
                'recipe': self._recipe, 'statement_specs': self.statement_specs, 'request_specs': self.request_specs}


def compile_captured_owner_packet(snapshot, *, expected_resource_sha256, expected_repair_sha256,
                                  guard_profile, created_at, repair_profile):
    try:
        resource, expected_repair = c._sha(expected_resource_sha256), c._sha(expected_repair_sha256)
        if type(guard_profile) is not str or guard_profile != c.GUARD_PROFILE:
            _fail('invalid_compile_arguments')
        _timestamp(created_at)
        budget = c._Budget(time.monotonic() + c.MAX_SECONDS)
        raw, records, repaired, deltas, trigger, target_schema, target_records, facts, code = _prepare(
            snapshot, resource, repair_profile, budget)
        if facts['repair_sha256'] != expected_repair:
            _fail('repair_binding_mismatch')
        migration_id = 'owner-upgrade-8-to-9:' + resource
        receipt_columns, receipt_rows = records['idempotency_responses']
        if any(row[receipt_columns.index('request_id') + 1] == migration_id
               and row[receipt_columns.index('endpoint') + 1] == ENDPOINT for row in receipt_rows):
            _fail('existing_receipt_requires_reconcile')
        occupied = {row[0] for row in receipt_rows}
        receipt_rowid = next(n for n in range(1, len(occupied) + 2) if n not in occupied)
        steps = [c._guard('capability:atan2-zero', "typeof(atan2(0.0,-1.0))='real' AND "
            'atan2(0.0,-1.0)>0 AND atan2(-0.0,-1.0)<0 AND atan2(0.0,-1.0)=-atan2(-0.0,-1.0)')]
        steps.extend(c._schema_guards(raw.rows))
        # Fixed read-only table-valued PRAGMA, never a header setter. A provider
        # without this capability fails inside the transaction before repair.
        # Actual provider support/capacity must still be verified before apply.
        header_predicate = "(SELECT typeof(user_version)='integer' AND user_version=? FROM pragma_user_version)"
        steps.append(c._guard('header:source', header_predicate, (facts['source_user_version'],)))
        for table, (columns, rows) in sorted(records.items()):
            steps.extend(c._row_guards(table, columns, rows, budget))
        steps.append(c._guard('receipt:absent',
            'NOT EXISTS (SELECT 1 FROM idempotency_responses WHERE request_id=? AND endpoint=?)',
            (migration_id, ENDPOINT)))
        # No input DDL. Only this exact validated trigger may be removed, and
        # every failure before COMMIT rolls back its removal and all repairs.
        steps.append(c.Statement('repair:drop-update-trigger', 'DROP TRIGGER immutable_evidence_snapshots_update'))
        for index, (rowid, identifier, payload_hash, column, before, after) in enumerate(deltas):
            budget.check()
            if column not in repair.REPAIR_COLUMNS:
                _fail('repair_difference_invalid')
            before_sql, before_args = exact_real.exact_real_binding(float.fromhex(before))
            after_sql, after_args = exact_real.exact_real_binding(float.fromhex(after))
            steps.append(c.Statement('repair:cell:' + str(index),
                f'UPDATE evidence_snapshots SET "{column}"={after_sql} WHERE rowid=? '
                'AND CAST(evidence_id AS BLOB) IS CAST(? AS BLOB) '
                'AND CAST(payload_sha256 AS BLOB) IS CAST(? AS BLOB) '
                f'AND typeof("{column}")=\'real\' AND "{column}" IS {before_sql}',
                (*after_args, rowid, identifier, payload_hash, *before_args)))
            steps.append(c._guard('repair:changes-one:' + str(index), 'changes()=1'))
        steps.append(c.Statement('repair:restore-update-trigger', trigger[3]))
        steps.extend(c._row_guards('evidence_snapshots', *repaired['evidence_snapshots'], budget))
        steps.extend(c.Statement('scope:ddl:' + str(i), sql) for i, sql in enumerate(c._scope_ddl()))
        for table in c.scopes.SCOPE_TABLES:
            steps.extend(_insert_rows(table, *target_records[table], budget))
        for table, ddl in owner.OWNER_SYNC_DDL.items():
            steps.append(c.Statement('owner:ddl:' + table, ddl))
        for table in owner.OWNER_SYNC_DDL:
            steps.extend(_insert_rows(table, *target_records[table], budget))
        steps.extend((c.Statement('version:cas', 'UPDATE _schema_version SET version=9 WHERE singleton=1 AND version=8'),
            c._guard('version:changes-one', 'changes()=1')))
        steps.extend(c._schema_guards(target_schema))
        steps.append(c._guard('header:post', header_predicate, (facts['source_user_version'],)))
        for table, (columns, rows) in sorted(target_records.items()):
            if table != 'idempotency_responses':
                steps.extend(c._row_guards(table, columns, rows, budget))
        receipt_post = [c._guard('receipt:post-count', '(SELECT COUNT(*) FROM idempotency_responses)=?',
                                (len(receipt_rows) + 1,))]
        receipt_post.extend(c._row_guards('idempotency_responses', receipt_columns, receipt_rows, budget,
                                          include_count=False))
        choices = dict(created_at=created_at, guard_profile=guard_profile, repair_profile=repair_profile)
        frame = _plan_frame(facts, choices, migration_id, receipt_rowid, steps, receipt_post)
        plan_sha = c._hash(c._json(frame))
        response = _receipt_response(facts, migration_id, plan_sha, receipt_rowid)
        receipt = (receipt_rowid, migration_id, ENDPOINT, plan_sha, 'complete', response,
                   None, None, created_at, created_at)
        receipt_insert = next(_insert_rows('idempotency_responses', receipt_columns, [receipt], budget))
        steps.append(c.Statement('receipt:insert', receipt_insert.sql, receipt_insert.args))
        steps.append(c._guard('receipt:changes-one', 'changes()=1'))
        steps.extend(receipt_post)
        steps.extend(c._row_guards('idempotency_responses', receipt_columns, [receipt], budget, include_count=False))
        body, specs, requests = c._pipeline(tuple(steps))
        if _current_code() != code:
            _fail('compiler_code_drift')
        meta = dict(ok=True, profile=PROFILE, evidence_scope='local_owner_upgrade_packet_compile',
            **facts, **_FACTS, **{key: False for key in _FLAGS}, from_schema=8, to_schema=9,
            migration_id=migration_id, receipt_rowid=receipt_rowid, repair_profile=repair_profile,
            guard_profile=guard_profile, packet_bytes=len(body), batch_steps=len(specs),
            packet_sha256=c._hash(body), plan_sha256=plan_sha,
            source_row_count=sum(len(rows) for _columns, rows in records.values()),
            max_statement_args=max(len(s.args) for s in steps), max_response_bytes=c.MAX_RESPONSE_BYTES)
        packet = CompiledOwnerPacket(body, tuple(sorted(meta.items())),
            tuple(zip(_RECIPE, (created_at, guard_profile, repair_profile, resource, expected_repair))), specs, requests)
        if _current_code() != code:
            _fail('compiler_code_drift')
        budget.check()
        return packet
    except Exception as error:
        _closed_error(error)


def rehydrate_packet(snapshot, artifact, *, expected_resource_sha256, expected_plan_sha256, expected_packet_sha256):
    try:
        budget = c._Budget(time.monotonic() + c.MAX_SECONDS)
        code = _current_code()
        resource, plan_sha, packet_sha = (c._sha(v) for v in
            (expected_resource_sha256, expected_plan_sha256, expected_packet_sha256))
        keys = {'profile', 'body', 'metadata', 'recipe', 'statement_specs', 'request_specs'}
        if (type(artifact) is not dict or set(artifact) != keys or artifact['profile'] != ARTIFACT_PROFILE
                or type(artifact['body']) is not bytes or not 1 <= len(artifact['body']) <= c.MAX_PACKET_BYTES
                or c._hash(artifact['body']) != packet_sha):
            _fail('artifact_invalid')
        meta = _validate(artifact['body'], artifact['metadata'], artifact['recipe'],
                         artifact['statement_specs'], artifact['request_specs'])
        budget.check()
        choices = dict(artifact['recipe'])
        if meta['resource_sha256'] != resource:
            _fail('artifact_invalid')
        expected = compile_captured_owner_packet(snapshot, expected_resource_sha256=resource,
            expected_repair_sha256=choices['repair_sha256'], guard_profile=choices['guard_profile'],
            repair_profile=choices['repair_profile'], created_at=choices['created_at'])
        budget.check()
        safe = expected.safe_metadata
        if safe['plan_sha256'] != plan_sha or safe['packet_sha256'] != packet_sha:
            _fail('packet_integrity_invalid')
        if any(not c._same_native(artifact[key], expected.artifact()[key]) for key in keys):
            _fail('packet_integrity_invalid')
        if _current_code() != code:
            _fail('compiler_code_drift')
        budget.check()
        return expected
    except Exception as error:
        _closed_error(error)


def validate_packet_before_send(snapshot, packet, **identities):
    """Recompile only; this API neither sends a request nor authorizes a write."""
    if type(packet) is not CompiledOwnerPacket:
        _fail('packet_integrity_invalid')
    return rehydrate_packet(snapshot, packet.artifact(), **identities)
