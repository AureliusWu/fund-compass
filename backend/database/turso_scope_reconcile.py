"""Pure supplied-byte read contract, not transport or remote reconciliation.

The caller must independently retain the original schema-8 capture, immutable
artifact and three pre-send SHA values. Neither a matching receipt nor this
module authenticates their origin. Missing is historical absence, never retry
permission. Only finite source pins and private in-memory references are read.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from pathlib import Path

from database import turso_scope_packet as compiler, turso_scope_response as parser
from database import turso_scope_snapshot as capture, turso_scope_upgrade as offline

MAX_SECONDS = 30.0
MAX_BYTES = 64 * 1024 * 1024
MAX_ROWS = 100_000
MAX_SCHEMA_ROWS = 128
MAX_STEPS = 16_384
PROFILE = 'turso-scope-reconcile-read-v1'
EVIDENCE_SCOPE = 'local_supplied_scope_read_contract'
_FLAGS = ('remote_verified', 'remote_applied', 'remote_restore_verified',
          'formal_release_verified', 'retry_allowed')
_STATES = frozenset({'matched', 'missing', 'unknown'})
_SUCCESS = {'matched': 'matched_postimage', 'missing': 'missing_preimage'}
_REASONS = frozenset({'matched_postimage', 'missing_preimage', 'identity_invalid',
    'origin_mismatch', 'code_drift', 'read_schema_invalid', 'response_missing',
    'response_type_invalid', 'response_limit', 'response_protocol_invalid',
    'read_failed', 'image_mismatch', 'time_limit', 'permission_stop',
    'verification_failed', 'result_integrity_invalid'})
_PUBLIC_KEYS = frozenset({'profile', 'evidence_scope', 'status', 'reason',
                          'permission_stop', *_FLAGS})
_RECEIPT_COLUMNS = ('request_id', 'endpoint', 'request_sha256', 'state',
    'response_json', 'owner_token', 'lease_expires_at', 'created_at', 'completed_at')
_OWN_PATH = Path(__file__).resolve()


class ReconcileError(Exception):
    """Fixed reasons only: never expose rows, SQL, response messages or origins."""
    def __init__(self, reason):
        super().__init__(reason if type(reason) is str and reason in _REASONS
                         else 'verification_failed')


def _fail(reason='response_protocol_invalid'):
    raise ReconcileError(reason)


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _own_digest():
    try:
        with _OWN_PATH.open('rb') as source:
            raw = source.read(1024 * 1024 + 1)
        if not 1 <= len(raw) <= 1024 * 1024:
            _fail('code_drift')
        raw.decode('utf-8', errors='strict')
        return _digest(raw)
    except ReconcileError:
        raise
    except Exception:
        _fail('code_drift')


_LOADED_OWN_SHA = _own_digest()


def _current_code():
    if _own_digest() != _LOADED_OWN_SHA:
        _fail('code_drift')
    try:
        return (_LOADED_OWN_SHA, parser._current_verifier_code(), compiler._current_code())
    except Exception:
        _fail('code_drift')


@dataclass(frozen=True, slots=True, repr=False)
class SmallReadVerdict:
    """Syntactic result only. Constructing one never grants source authority."""
    status: str
    reason: str
    permission_stop: bool
    remote_verified: bool = field(default=False, init=False)
    remote_applied: bool = field(default=False, init=False)
    remote_restore_verified: bool = field(default=False, init=False)
    formal_release_verified: bool = field(default=False, init=False)
    retry_allowed: bool = field(default=False, init=False)
    _seal: str = field(init=False, repr=False)

    def __post_init__(self):
        object.__setattr__(self, '_seal', _digest(compiler._json(self._values())))

    def _values(self):
        if (type(self.status) is not str or self.status not in _STATES
                or type(self.reason) is not str or self.reason not in _REASONS
                or type(self.permission_stop) is not bool
                or any(getattr(self, name) is not False for name in _FLAGS)):
            _fail('result_integrity_invalid')
        if self.status in _SUCCESS:
            if self.reason != _SUCCESS[self.status] or self.permission_stop:
                _fail('result_integrity_invalid')
        elif self.reason in _SUCCESS.values():
            _fail('result_integrity_invalid')
        if self.permission_stop is not (self.reason == 'permission_stop'):
            _fail('result_integrity_invalid')
        result = {'profile': PROFILE, 'evidence_scope': EVIDENCE_SCOPE,
            'status': self.status, 'reason': self.reason, 'permission_stop': self.permission_stop,
            **{name: getattr(self, name) for name in _FLAGS}}
        if set(result) != _PUBLIC_KEYS:
            _fail('result_integrity_invalid')
        return result

    @property
    def safe_metadata(self):
        result = self._values()
        if type(self._seal) is not str or self._seal != _digest(compiler._json(result)):
            _fail('result_integrity_invalid')
        return result


class _Budget(offline._Budget):
    def __init__(self, deadline, start):
        super().__init__(deadline)
        self.last = start

    def check(self):
        try:
            now = parser._now()
        except Exception:
            _fail('time_limit')
        if now < self.last or now > self.deadline:
            _fail('time_limit')
        self.last = now

    def progress(self):
        self.sql_steps += 1000
        try:
            self.check()
            return int(self.sql_steps > 10_000_000)
        except ReconcileError:
            return 1


def _start():
    try:
        now = parser._now()
        return _Budget(now + MAX_SECONDS, now)
    except Exception:
        _fail('time_limit')


def _sha(value):
    if type(value) is not str or not compiler._SHA.fullmatch(value):
        _fail('identity_invalid')
    return value


def _statement(sql, args=()):
    return {'sql': sql, 'args': [compiler._wire(value) for value in args],
            'named_args': [], 'want_rows': True}


def _prepare(snapshot, artifact, *, candidate_origin, expected_resource_sha256,
             expected_plan_sha256, expected_packet_sha256, read_schema, budget):
    budget.check()
    if type(read_schema) is not int or read_schema not in (8, 9):
        _fail('read_schema_invalid')
    identities = tuple(_sha(value) for value in
        (expected_resource_sha256, expected_plan_sha256, expected_packet_sha256))
    try:
        origin = capture._origin(candidate_origin)
    except capture.SnapshotError:
        _fail('origin_mismatch')
    if _digest(origin.encode('ascii')) != identities[0]:
        _fail('origin_mismatch')
    # Complete external-SHA recompile, not artifact metadata or receipt-derived identity.
    packet = compiler.rehydrate_packet(snapshot, artifact,
        expected_resource_sha256=identities[0], expected_plan_sha256=identities[1],
        expected_packet_sha256=identities[2])
    budget.check()
    reference = None
    try:
        reference, raw, source, source_meta = compiler._admit(snapshot, identities[0], budget)
        meta = packet.safe_metadata
        if (source_meta['source_sha256'] != meta['source_image_sha256']
                or source_meta['source_rows_sha256'] != meta['source_rows_sha256']
                or source_meta['source_contract_sha256'] != meta['source_contract_sha256']
                or raw.exact_sha256 != meta['raw_schema_sha256']):
            _fail('identity_invalid')
        header = reference.execute('PRAGMA user_version').fetchone()[0]
        receipts = [spec[2] for spec in packet.statement_specs if spec[0] == 'receipt:insert']
        if (len(receipts) != 1 or type(receipts[0]) is not tuple or len(receipts[0]) != 10
                or source['idempotency_responses'][0] != _RECEIPT_COLUMNS):
            _fail('identity_invalid')
        receipt = receipts[0]
        if (receipt[:5] != (meta['receipt_rowid'], meta['migration_id'], compiler.ENDPOINT,
                           identities[1], 'complete') or receipt[6:8] != (None, None)):
            _fail('identity_invalid')
        expected_schema = raw.rows
        expected_rows = dict(source)
        if read_schema == 9:
            expected_schema, scope_rows = compiler._target(reference, raw.rows, budget)
            expected_rows.update(scope_rows)
            expected_rows['_schema_version'] = (source['_schema_version'][0], [(1, 1, 9)])
            expected_rows['idempotency_responses'] = (_RECEIPT_COLUMNS,
                sorted([*source['idempotency_responses'][1], receipt], key=lambda row: row[0]))
        if (len(expected_schema) > MAX_SCHEMA_ROWS
                or sum(len(rows) for _, rows in expected_rows.values()) > MAX_ROWS):
            _fail('response_limit')
        fixed = [
            ('begin', 'BEGIN', (), 0),
            ('query_only', 'PRAGMA query_only', (), 1),
            ('schema', 'SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name LIMIT 129', (), MAX_SCHEMA_ROWS),
            ('temp_schema', 'SELECT type,name,tbl_name,sql FROM temp.sqlite_master ORDER BY type,name LIMIT 129', (), MAX_SCHEMA_ROWS),
            ('databases', 'PRAGMA database_list', (), 2),
            ('header', 'PRAGMA main.user_version', (), 1),
            ('foreign_keys', 'PRAGMA main.foreign_key_check', (), 1),
            ('integrity', 'PRAGMA main.quick_check(1)', (), 1),
        ]
        for table in sorted(expected_rows):
            # Names only from the admitted fixed contract, never remote SQL/identifiers.
            fixed.append(('table:' + table,
                f'SELECT rowid,* FROM main."{table}" ORDER BY rowid LIMIT 100001', (), MAX_ROWS))
        receipt_args = (meta['migration_id'], compiler.ENDPOINT, meta['receipt_rowid'])
        fixed.append(('receipt', 'SELECT rowid,* FROM main."idempotency_responses" '
            'WHERE (request_id=? AND endpoint=?) OR rowid=? ORDER BY rowid LIMIT 3', receipt_args, 3))
        specs = []
        for label, sql, args, row_limit in fixed:
            budget.check()
            columns = () if label == 'begin' else tuple(
                col[0] for col in (reference.execute(sql, args).description or ()))
            specs.append((label, sql, args, columns, row_limit))
        specs.extend((('commit', 'COMMIT', (), (), 0), ('rollback', 'ROLLBACK', (), (), 0)))
        if len(specs) > MAX_STEPS:
            _fail('response_limit')
        steps = []
        for label, sql, args, _, _ in specs[:-2]:
            step = {'stmt': _statement(sql, args)}
            if steps:
                step['condition'] = {'type': 'and', 'conds': [
                    {'type': 'ok', 'step': len(steps) - 1},
                    {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}
            steps.append(step)
        commit = len(steps)
        steps.append({'stmt': _statement('COMMIT'), 'condition': {'type': 'and', 'conds': [
            {'type': 'ok', 'step': commit - 1}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
        steps.append({'stmt': _statement('ROLLBACK'), 'condition': {'type': 'and', 'conds': [
            {'type': 'not', 'cond': {'type': 'ok', 'step': commit}},
            {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
        body = compiler._json({'baton': None, 'requests': [
            {'type': 'batch', 'batch': {'steps': steps}}, {'type': 'get_autocommit'}, {'type': 'close'}]})
        if not 1 <= len(body) <= MAX_BYTES:
            _fail('response_limit')
        expected = (expected_schema, expected_rows, header, receipt, read_schema)
        budget.check()
        return body, tuple(specs), expected, origin
    finally:
        if reference is not None:
            reference.close()


def _error_reason(error):
    if type(error) is ReconcileError:
        return str(error)
    if type(error) is compiler.CompilerError:
        return {'compiler_code_drift': 'code_drift', 'compile_time_limit': 'time_limit',
                'packet_limit': 'response_limit', 'source_row_limit': 'response_limit'}.get(str(error), 'identity_invalid')
    if type(error) is parser.VerifierError:
        return {'code_drift': 'code_drift', 'response_time_limit': 'time_limit',
                'response_limit': 'response_limit'}.get(str(error), 'response_protocol_invalid')
    if type(error) is capture.SnapshotError:
        return {'capture_row_limit': 'response_limit', 'capture_value_invalid': 'image_mismatch'}.get(
            str(error), 'response_protocol_invalid')
    if type(error) is offline.UpgradeError:
        return {'rehearsal_time_limit': 'time_limit', 'snapshot_limit_exceeded': 'response_limit'}.get(
            str(error), 'verification_failed')
    return 'verification_failed'


def build_scope_reconcile_read(snapshot, artifact, *, candidate_origin,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256, read_schema):
    """Build one fixed read plan. No sending, fallback, credentials or retries."""
    try:
        budget = _start()
        code = _current_code()
        budget.check()
        body, _, _, _ = _prepare(snapshot, artifact, candidate_origin=candidate_origin,
            expected_resource_sha256=expected_resource_sha256, expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256, read_schema=read_schema, budget=budget)
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
        return body
    except Exception as error:
        raise ReconcileError(_error_reason(error)) from None


def _observe_permissions(payload, specs, origin, observation, budget):
    if type(payload) is not dict or type(payload.get('results')) is not list:
        return
    try:
        capture._same_stream_origin(payload.get('base_url'), origin)
    except capture.SnapshotError:
        return
    items = payload['results']
    for item in items[:3]:
        budget.check()
        if type(item) is dict and set(item) == {'type', 'error'} and item.get('type') == 'error':
            parser._observe_error_code(item['error'], observation)
    if not items or type(items[0]) is not dict:
        return
    first = items[0]
    result = first.get('response')
    if (first.get('type') != 'ok' or type(result) is not dict or result.get('type') != 'batch'
            or type(result.get('result')) is not dict):
        return
    errors = result['result'].get('step_errors')
    if type(errors) is list:
        for error in errors[:len(specs)]:
            budget.check()
            parser._observe_error_code(error, observation)


def _read_fsm(payload, specs, origin, observation, budget):
    if (type(payload) is not dict or not {'baton', 'results'} <= set(payload) <= {'baton', 'results', 'base_url'}
            or payload['baton'] is not None):
        _fail()
    capture._same_stream_origin(payload.get('base_url'), origin)
    results = payload['results']
    if type(results) is not list or len(results) != 3:
        _fail()
    for item, operation in zip(results, ('batch', 'get_autocommit', 'close')):
        budget.check()
        if type(item) is not dict or type(item.get('type')) is not str:
            _fail()
        if item['type'] == 'error':
            if set(item) != {'type', 'error'}:
                _fail()
            parser._error(item['error'], observation)
            _fail('read_failed')
        if (set(item) != {'type', 'response'} or item['type'] != 'ok'
                or type(item['response']) is not dict or item['response'].get('type') != operation):
            _fail()
    if (results[1]['response'] != {'type': 'get_autocommit', 'is_autocommit': True}
            or results[1]['response'].get('is_autocommit') is not True
            or results[2]['response'] != {'type': 'close'}):
        _fail('read_failed')
    batch = results[0]['response']
    if set(batch) != {'type', 'result'} or type(batch['result']) is not dict:
        _fail()
    result = batch['result']
    if not {'step_results', 'step_errors'} <= set(result) <= {'step_results', 'step_errors', 'replication_index'}:
        _fail()
    if 'replication_index' in result:
        parser._replication(result['replication_index'])
    values, errors = result['step_results'], result['step_errors']
    if type(values) is not list or type(errors) is not list or len(values) != len(specs) or len(errors) != len(specs):
        _fail()
    decoded = {}
    for index, (value, error, spec) in enumerate(zip(values, errors, specs)):
        budget.check()
        label, _, _, columns, row_limit = spec
        if error is not None:
            parser._error(error, observation)
            if value is not None:
                _fail()
            _fail('read_failed')
        if label == 'rollback':
            if value is not None:
                _fail('read_failed')
            continue
        if value is None:
            _fail('read_failed')
        if type(value) is dict and type(value.get('rows')) is list and len(value['rows']) > row_limit:
            _fail('response_limit')
        decoded[label] = capture._statement_rows(value, columns, budget)
    return decoded


def _match_image(decoded, expected, budget):
    schema, tables, header, receipt, read_schema = expected
    if (not compiler._same_native(tuple(decoded['schema']), schema)
            or decoded['temp_schema'] or decoded['begin'] or decoded['commit']
            or not compiler._same_native(tuple(decoded['header']), ((header,),))
            or decoded['foreign_keys']
            or not compiler._same_native(tuple(decoded['integrity']), (('ok',),))
            or len(decoded['query_only']) != 1 or len(decoded['query_only'][0]) != 1
            or type(decoded['query_only'][0][0]) is not int or decoded['query_only'][0][0] not in (0, 1)):
        _fail('image_mismatch')
    databases = decoded['databases']
    if (not 1 <= len(databases) <= 2 or len(databases[0]) != 3
            or type(databases[0][0]) is not int or databases[0][:2] != (0, 'main')
            or type(databases[0][2]) is not str
            or (len(databases) == 2 and not compiler._same_native(databases[1], (1, 'temp', '')))):
        _fail('image_mismatch')
    total = 0
    for table, (_, expected_rows) in tables.items():
        budget.check()
        actual = tuple(decoded['table:' + table])
        total += len(actual)
        if total > MAX_ROWS:
            _fail('response_limit')
        if not compiler._same_native(actual, tuple(expected_rows)):
            _fail('image_mismatch')
    all_receipts = decoded['table:idempotency_responses']
    selected = tuple(row for row in all_receipts
        if (row[1], row[2]) == (receipt[1], receipt[2]) or row[0] == receipt[0])
    expected_receipt = (receipt,) if read_schema == 9 else ()
    if (not compiler._same_native(tuple(decoded['receipt']), selected)
            or not compiler._same_native(selected, expected_receipt)):
        _fail('image_mismatch')
    return ('matched', 'matched_postimage') if read_schema == 9 else ('missing', 'missing_preimage')


def verify_scope_reconcile_read(snapshot, artifact, raw_response, *, candidate_origin,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256, read_schema):
    """Classify provided bytes only; matched/missing/unknown never permit retry."""
    status, reason = 'unknown', 'verification_failed'
    observation = parser._Observation()
    budget = None
    code = None
    identity_bound = False
    try:
        budget = _start()
        code = _current_code()
        budget.check()
        _, specs, expected, origin = _prepare(snapshot, artifact, candidate_origin=candidate_origin,
            expected_resource_sha256=expected_resource_sha256, expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256, read_schema=read_schema, budget=budget)
        identity_bound = True
        budget.check()
        if raw_response is None:
            _fail('response_missing')
        if type(raw_response) is not bytes:
            _fail('response_type_invalid')
        if not 1 <= len(raw_response) <= MAX_BYTES:
            _fail('response_limit')
        payload = parser._parse(raw_response, budget)
        _observe_permissions(payload, specs, origin, observation, budget)
        decoded = _read_fsm(payload, specs, origin, observation, budget)
        status, reason = _match_image(decoded, expected, budget)
        budget.check()
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
    except Exception as error:
        status, reason = 'unknown', _error_reason(error)
    # Close-out source checks and construction are within the same cooperative
    # 30-second budget; it is not a process kill or remote lifetime guarantee.
    try:
        _current_code()
    except Exception:
        status, reason = 'unknown', 'code_drift'
        identity_bound = False
    if not identity_bound or reason in ('identity_invalid', 'origin_mismatch', 'code_drift'):
        observation.permission = False
    if observation.permission:
        status, reason = 'unknown', 'permission_stop'
    verdict = SmallReadVerdict(status, reason, observation.permission)
    try:
        final_code = _current_code()
        if code is not None and final_code != code:
            _fail('code_drift')
        if budget is not None and reason != 'code_drift':
            budget.check()
    except Exception as error:
        final_reason = _error_reason(error)
        if final_reason == 'code_drift':
            observation.permission = False
        elif observation.permission:
            final_reason = 'permission_stop'
        verdict = SmallReadVerdict('unknown', final_reason, observation.permission)
    return verdict
