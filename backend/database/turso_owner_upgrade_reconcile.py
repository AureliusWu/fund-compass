"""Fixed full-image readback for the separate repair/scope/Owner profile.

Supplied bytes only, no network or credential access. A matched image is not
authenticated cloud evidence. Missing means the complete original schema-8
image and an empty reserved slot, never proof of rollback or replay authority.
The original capture and external pre-send identities remain indispensable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from pathlib import Path

from database import owner_sync_schema as owner_schema, turso_owner_upgrade_packet as compiler
from database import turso_scope_packet as c, turso_scope_reconcile as engine
from database import turso_scope_response as parser, turso_scope_snapshot as capture
from database import turso_scope_upgrade as offline


PROFILE = 'turso-owner-upgrade-reconcile-read-v1'
EVIDENCE_SCOPE = 'local_supplied_owner_upgrade_read_contract'
MAX_SECONDS, MAX_BYTES = 30.0, 64 * 1024 * 1024
MAX_ROWS, MAX_SCHEMA_ROWS, MAX_STEPS = 100_000, 128, 16_384
_FLAGS, _PUBLIC_KEYS, _REASONS = engine._FLAGS, engine._PUBLIC_KEYS, engine._REASONS
_RECEIPT_COLUMNS = engine._RECEIPT_COLUMNS
_OWN_PATH = Path(__file__).resolve()


class ReconcileError(Exception):
    def __init__(self, reason):
        super().__init__(reason if type(reason) is str and reason in _REASONS else 'verification_failed')


def _fail(reason='response_protocol_invalid'):
    raise ReconcileError(reason)


def _own_digest():
    try:
        with _OWN_PATH.open('rb') as source:
            raw = source.read(1024 * 1024 + 1)
        if not 1 <= len(raw) <= 1024 * 1024:
            _fail('code_drift')
        raw.decode('utf-8', errors='strict')
        return hashlib.sha256(raw).hexdigest()
    except Exception:
        _fail('code_drift')


_LOADED_OWN_SHA = _own_digest()


def _current_code():
    try:
        if _own_digest() != _LOADED_OWN_SHA:
            _fail('code_drift')
        return (_LOADED_OWN_SHA, compiler._current_code(), engine._current_code())
    except Exception:
        _fail('code_drift')


@dataclass(frozen=True, slots=True, repr=False)
class SmallReadVerdict:
    """Closed syntactic result only; neither seal nor constructor authenticates it."""
    status: str
    reason: str
    permission_stop: bool
    remote_verified: bool = field(default=False, init=False)
    remote_applied: bool = field(default=False, init=False)
    remote_restore_verified: bool = field(default=False, init=False)
    formal_release_verified: bool = field(default=False, init=False)
    retry_allowed: bool = field(default=False, init=False)
    _seal: str = field(init=False, repr=False)

    def _values(self):
        if any(getattr(self, name) is not False for name in _FLAGS):
            _fail('result_integrity_invalid')
        try:
            # Reuse the closed native-type/state/permission contract, never the
            # old public read verifier or a substitute compiler/profile callback.
            result = engine.SmallReadVerdict(self.status, self.reason, self.permission_stop).safe_metadata
        except Exception:
            _fail('result_integrity_invalid')
        result.update(profile=PROFILE, evidence_scope=EVIDENCE_SCOPE)
        return result

    def __post_init__(self):
        try:
            budget = _dto_budget(self)
            values = self._values()
            _publish_sources(values, budget)
            object.__setattr__(self, '_seal', c._hash(c._json(values)))
            _publish_sources(values, budget)
        except Exception as error:
            raise ReconcileError(_error_reason(error)) from None

    @property
    def safe_metadata(self):
        try:
            budget = _dto_budget(self)
            result = self._values()
            _publish_sources(result, budget)
            if type(self._seal) is not str or self._seal != c._hash(c._json(result)):
                _fail('result_integrity_invalid')
            _publish_sources(result, budget)
            return result
        except Exception as error:
            raise ReconcileError(_error_reason(error)) from None


def _dto_budget(verdict):
    try:
        return engine._start()
    except Exception:
        # An unusable clock may report only an unqualified timeout/drift.
        # In particular it cannot retain an observed permission classification.
        values = verdict._values()
        if (values['status'] == 'unknown' and values['reason'] in ('time_limit', 'code_drift')
                and values['permission_stop'] is False):
            return None
        _fail('time_limit')


def _publish_sources(values, budget):
    try:
        _current_code()
    except Exception:
        # Only this explicit unqualified failure remains readable after source
        # drift. Unknown with a permission observation is still a bound claim.
        if not (values['status'] == 'unknown' and values['reason'] == 'code_drift'
                and values['permission_stop'] is False):
            _fail('code_drift')
    if budget is not None:
        budget.check()


def _error_reason(error):
    if type(error) is ReconcileError:
        return str(error)
    if type(error) is compiler.CompilerError:
        return {'compiler_code_drift': 'code_drift', 'compile_time_limit': 'time_limit',
                'packet_limit': 'response_limit', 'source_row_limit': 'response_limit'}.get(str(error), 'identity_invalid')
    return engine._error_reason(error)


def _prepare(snapshot, artifact, *, candidate_origin, expected_resource_sha256,
             expected_plan_sha256, expected_packet_sha256, read_schema, budget):
    budget.check()
    if type(read_schema) is not int or read_schema not in (8, 9):
        _fail('read_schema_invalid')
    identities = tuple(engine._sha(value) for value in
        (expected_resource_sha256, expected_plan_sha256, expected_packet_sha256))
    try:
        origin = capture._origin(candidate_origin)
    except capture.SnapshotError:
        _fail('origin_mismatch')
    if c._hash(origin.encode('ascii')) != identities[0]:
        _fail('origin_mismatch')
    packet = compiler.rehydrate_packet(snapshot, artifact,
        expected_resource_sha256=identities[0], expected_plan_sha256=identities[1],
        expected_packet_sha256=identities[2])
    budget.check()
    meta = packet.safe_metadata
    raw, source, _repaired, _deltas, _trigger, target_schema, target, facts, _code = compiler._prepare(
        snapshot, identities[0], compiler.REPAIR_PROFILE, budget)
    budget.check()
    if any(not c._same_native(meta.get(key), value) for key, value in facts.items()):
        _fail('identity_invalid')
    receipts = [spec[2] for spec in packet.statement_specs if spec[0] == 'receipt:insert']
    if (len(receipts) != 1 or len(receipts[0]) != 10
            or source['idempotency_responses'][0] != _RECEIPT_COLUMNS):
        _fail('identity_invalid')
    receipt = receipts[0]
    if (receipt[:5] != (meta['receipt_rowid'], meta['migration_id'], compiler.ENDPOINT, identities[1], 'complete')
            or receipt[6:8] != (None, None)):
        _fail('identity_invalid')
    expected_schema = raw.rows if read_schema == 8 else target_schema
    expected_rows = dict(source if read_schema == 8 else target)
    if read_schema == 9:
        expected_rows['idempotency_responses'] = (_RECEIPT_COLUMNS,
            sorted([*target['idempotency_responses'][1], receipt], key=lambda row: row[0]))
    if len(expected_schema) > MAX_SCHEMA_ROWS or sum(len(rows) for _, rows in expected_rows.values()) > MAX_ROWS:
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
        fixed.append(('table:' + table,
            f'SELECT rowid,* FROM main."{table}" ORDER BY rowid LIMIT 100001', (), MAX_ROWS))
    fixed.append(('receipt', 'SELECT rowid,* FROM main."idempotency_responses" '
        'WHERE (request_id=? AND endpoint=?) OR rowid=? ORDER BY rowid LIMIT 3',
        (meta['migration_id'], compiler.ENDPOINT, meta['receipt_rowid']), 3))
    # Discover result-column names using only an empty, trusted fixed schema.
    # SQLite may name rowid after an INTEGER PRIMARY KEY alias; never guess it
    # from untrusted responses or execute captured schema SQL for discovery.
    operational = frozenset(name for name in source if name in offline._OPERATIONAL_DEFINITIONS)
    reference = offline._source_reference('remote-schema-table', budget,
        operational_objects=operational, optimizer_statistics='sqlite_stat1' in source)
    try:
        for ddl in c._scope_ddl():
            budget.check()
            reference.execute(ddl)
        for ddl in owner_schema.OWNER_SYNC_DDL.values():
            reference.execute(ddl)
        reference.commit()
        specs = []
        for label, sql, args, row_limit in fixed:
            budget.check()
            columns = () if label == 'begin' else tuple(
                col[0] for col in (reference.execute(sql, args).description or ()))
            specs.append((label, sql, args, columns, row_limit))
    finally:
        reference.close()
    specs.extend((('commit', 'COMMIT', (), (), 0), ('rollback', 'ROLLBACK', (), (), 0)))
    if len(specs) > MAX_STEPS:
        _fail('response_limit')
    steps = []
    for label, sql, args, _, _ in specs[:-2]:
        step = {'stmt': engine._statement(sql, args)}
        if steps:
            step['condition'] = {'type': 'and', 'conds': [
                {'type': 'ok', 'step': len(steps) - 1}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}
        steps.append(step)
    commit = len(steps)
    steps.append({'stmt': engine._statement('COMMIT'), 'condition': {'type': 'and', 'conds': [
        {'type': 'ok', 'step': commit - 1}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    steps.append({'stmt': engine._statement('ROLLBACK'), 'condition': {'type': 'and', 'conds': [
        {'type': 'not', 'cond': {'type': 'ok', 'step': commit}},
        {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    body = c._json({'baton': None, 'requests': [
        {'type': 'batch', 'batch': {'steps': steps}}, {'type': 'get_autocommit'}, {'type': 'close'}]})
    if not 1 <= len(body) <= MAX_BYTES:
        _fail('response_limit')
    budget.check()
    return body, tuple(specs), (expected_schema, expected_rows, meta['source_user_version'], receipt, read_schema), origin


def build_owner_upgrade_reconcile_read(snapshot, artifact, *, candidate_origin,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256, read_schema):
    """One fixed read plan only, no sending, inferred schema fallback or retries."""
    try:
        budget, code = engine._start(), _current_code()
        body, _, _, _ = _prepare(snapshot, artifact, candidate_origin=candidate_origin,
            expected_resource_sha256=expected_resource_sha256, expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256, read_schema=read_schema, budget=budget)
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
        return body
    except Exception as error:
        raise ReconcileError(_error_reason(error)) from None


def verify_owner_upgrade_reconcile_read(snapshot, artifact, raw_response, *, candidate_origin,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256, read_schema):
    """Classify supplied bytes, retaining unknown/permission STOP and no retry."""
    status, reason = 'unknown', 'verification_failed'
    observation, budget, code, identity_bound = parser._Observation(), None, None, False
    try:
        budget, code = engine._start(), _current_code()
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
        engine._observe_permissions(payload, specs, origin, observation, budget)
        decoded = engine._read_fsm(payload, specs, origin, observation, budget)
        status, reason = engine._match_image(decoded, expected, budget)
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
    except Exception as error:
        status, reason = 'unknown', _error_reason(error)
    try:
        final_code = _current_code()
        if code is not None and final_code != code:
            _fail('code_drift')
    except Exception:
        status, reason, identity_bound = 'unknown', 'code_drift', False
    if not identity_bound or reason in ('identity_invalid', 'origin_mismatch', 'code_drift'):
        observation.permission = False
    if observation.permission:
        status, reason = 'unknown', 'permission_stop'
    try:
        verdict = SmallReadVerdict(status, reason, observation.permission)
        if _current_code() != code and code is not None:
            _fail('code_drift')
        if budget is not None:
            budget.check()
        return verdict
    except Exception as error:
        final_reason = _error_reason(error)
        permission = observation.permission and final_reason != 'code_drift'
        try:
            return SmallReadVerdict('unknown', 'permission_stop' if permission else final_reason, permission)
        except ReconcileError as construction_error:
            # A clock becoming unusable during a previously bound permission
            # result cannot escape into a second failing DTO construction.
            fallback = 'code_drift' if str(construction_error) == 'code_drift' else 'time_limit'
            return SmallReadVerdict('unknown', fallback, False)
