"""Explicit one-POST clean-target operator helpers; never an apply gate.

These functions do not establish stop-write, backup, free quota, provider
capability, restore or production permission. No configured credentials,
environment discovery, startup route, retry or automatic follow-up exists.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import math
from pathlib import Path

from database import turso_clean_target as compiler
from database import turso_scope_packet as kernel, turso_scope_response as parser
from database import turso_scope_transport as physical

PROFILE = 'turso-clean-target-transport-1'
MAX_SECONDS = 30.0
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
_FLAGS = {**compiler._FLAGS, 'delivery_authorized': False}
_REASONS = frozenset({'invalid_arguments', 'identity_invalid', 'code_drift', 'operation_timeout',
    'capacity_exhausted', 'transport_failed', 'cleanup_failed', 'http_authentication_rejected',
    'http_access_denied', 'http_rate_limited', 'http_unexpected_status', 'verification_failed',
    'response_limit', 'response_type_invalid', 'transport_used', 'response_contract_invalid'})


class CleanTargetTransportError(RuntimeError):
    """Closed diagnostics only. Every failure remains unknown, never retryable."""
    def __init__(self, reason='transport_failed', http_status=None):
        self.reason = reason if type(reason) is str and reason in _REASONS else 'transport_failed'
        self.http_status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
        self.outcome = 'unknown'
        super().__init__(self.reason)


def _fail(reason, status=None):
    raise CleanTargetTransportError(reason, status) from None


def _code():
    path = Path(__file__).resolve()
    with path.open('rb') as source:
        raw = source.read(1024 * 1024 + 1)
    if not 1 <= len(raw) <= 1024 * 1024:
        _fail('code_drift')
    raw.decode('utf-8', errors='strict')
    return (hashlib.sha256(raw).hexdigest(), compiler._current_code(),
            parser._current_verifier_code(), physical._current_code())


_LOADED = _code()


def _current_code():
    try:
        value = _code()
        if value != _LOADED:
            _fail('code_drift')
        return value
    except Exception:
        _fail('code_drift')


class _Budget(compiler._Budget):
    def __init__(self, seconds, check=None):
        if (type(seconds) not in (int, float) or not math.isfinite(seconds)
                or not 0 < seconds <= MAX_SECONDS or check is not None and not callable(check)):
            _fail('invalid_arguments')
        self.callback, self.original = check, None
        super().__init__()
        self.deadline = self.last + seconds

    def check(self):
        super().check()
        if self.callback is not None:
            try:
                self.callback()
            except Exception as error:
                self.original = error
                raise
        super().check()

    def remaining(self):
        self.check()
        return self.deadline - self.last

    def progress(self):
        self.sql_steps += 1000
        try:
            self.check()
            return int(self.sql_steps > 10_000_000)
        except Exception:
            # SQLite must interrupt quietly; the outer boundary rethrows the
            # original callback sentinel rather than an unraisable callback log.
            return 1


def _closed(error, budget=None):
    if budget is not None and budget.original is not None:
        raise budget.original from None
    if type(error) is CleanTargetTransportError:
        raise error from None
    if type(error) is physical.TransportError:
        reason = {'time_limit': 'operation_timeout'}.get(str(error), str(error))
        _fail(reason, error.http_status)
    if type(error) is compiler.CleanTargetError:
        reason = str(error) if str(error) in {'operation_timeout', 'code_drift', 'capacity_exhausted'} else 'identity_invalid'
        _fail(reason)
    if type(error) is parser.VerifierError:
        reason = {'response_time_limit': 'operation_timeout', 'code_drift': 'code_drift',
                  'response_limit': 'response_limit'}.get(str(error), 'response_contract_invalid')
        _fail(reason)
    _fail('verification_failed')


def _origins(source_origin, target_origin, token, identities):
    try:
        source = kernel.capture._origin(source_origin)
        target = physical._inputs(target_origin, token)
        for value in identities.values():
            compiler._identity(value)
        if (source == target or hashlib.sha256(source.encode('ascii')).hexdigest() != identities['expected_source_resource_sha256']
                or hashlib.sha256(target.encode('ascii')).hexdigest() != identities['expected_target_resource_sha256']):
            _fail('identity_invalid')
        return source, target
    except Exception:
        _fail('identity_invalid')


def _admit(snapshot, artifact, identities, budget):
    expected_repair = identities['expected_repair_sha256']
    packet = compiler._rehydrate(snapshot, artifact, budget=budget,
        **{name: value for name, value in identities.items() if name != 'expected_repair_sha256'})
    # _rehydrate just rederived and fully validated this immutable packet under
    # the SAME budget. Do not reset the deadline or repeat that full build.
    metadata = dict(packet._safe_items)
    if metadata['repair_sha256'] != expected_repair:
        _fail('identity_invalid')
    if not 1 <= len(packet.body) <= min(MAX_REQUEST_BYTES, compiler.MAX_REQUEST_BYTES):
        _fail('capacity_exhausted')
    budget.check()
    return packet, metadata


@dataclass(frozen=True, slots=True, repr=False)
class _ReadPlan:
    body: bytes
    statement_specs: tuple
    request_specs: tuple


def _read_pipeline(statements):
    controls = (kernel.Statement('read:begin', 'BEGIN DEFERRED'),
                kernel.Statement('read:commit', 'COMMIT'), kernel.Statement('read:rollback', 'ROLLBACK'))
    specs = (controls[0], *statements, controls[1], controls[2])
    steps = [{'stmt': controls[0]._wire()}]
    for statement in statements:
        steps.append({'stmt': statement._wire(), 'condition': {'type': 'and', 'conds': [
            {'type': 'ok', 'step': len(steps) - 1}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    commit = len(steps)
    steps.append({'stmt': controls[1]._wire(), 'condition': {'type': 'and', 'conds': [
        {'type': 'ok', 'step': commit - 1}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    steps.append({'stmt': controls[2]._wire(), 'condition': {'type': 'and', 'conds': [
        {'type': 'not', 'cond': {'type': 'ok', 'step': commit}}, {'type': 'not', 'cond': {'type': 'is_autocommit'}}]}})
    body = kernel._json({'baton': None, 'requests': [{'type': 'batch', 'batch': {'steps': steps}},
        {'type': 'get_autocommit'}, {'type': 'close'}]})
    if len(body) > MAX_REQUEST_BYTES or len(steps) > kernel.MAX_STEPS:
        _fail('capacity_exhausted')
    frozen = tuple((step.label, step.sql, step.args, step.want_rows, step.result_spec) for step in specs)
    return _ReadPlan(body, frozen, (('batch', frozen, commit, len(steps) - 1), ('get_autocommit', True), ('close',)))


def _read_plan(packet, budget):
    # Full target, not merely its markers. The write prefix's journal count=1
    # predates the clean receipt: omit it and use final receipt:post guards (=2).
    selected = [kernel._guard('read:connection',
        "(SELECT foreign_keys FROM pragma_foreign_keys)=1 AND "
        "(SELECT COUNT(*) FROM pragma_database_list WHERE name NOT IN ('main','temp'))=0 AND "
        'NOT EXISTS (SELECT 1 FROM sqlite_temp_master)')]
    for spec in packet.statement_specs:
        label, sql, args, want_rows, result_spec = spec
        if (label in {'schema:exact-raw', 'target:header-post', 'target:fk-post'}
                or label.startswith(('count:', 'rows:')) and 'owner_machine_journal' not in label
                or label.startswith('receipt:post:')):
            if not want_rows or sql.lstrip().split(None, 1)[0] not in {'SELECT', 'WITH'}:
                _fail('identity_invalid')
            selected.append(kernel.Statement('read:' + label, sql, args, want_rows, result_spec))
    if (not any(step.label == 'read:schema:exact-raw' for step in selected)
            or not any(step.label == 'read:receipt:post:count:owner_machine_journal' for step in selected)):
        _fail('identity_invalid')
    budget.check()
    return _read_pipeline(tuple(selected))


def _affected(payload, plan, budget):
    values = payload['results'][0]['response']['result']['step_results']
    for index, (value, spec) in enumerate(zip(values, plan.statement_specs)):
        budget.check()
        if value is None:
            continue
        sql = spec[1].lstrip()
        keyword = sql.split(None, 1)[0].upper()
        if keyword in {'INSERT', 'UPDATE', 'DELETE'} or spec[0].startswith('backfill:') or spec[0] == 'receipt:insert':
            following = plan.statement_specs[index + 1]
            if 'changes()=' not in following[1]:
                _fail('response_contract_invalid')
            expected = following[2][0] if following[2] else 1
            if type(value['affected_row_count']) is not int or value['affected_row_count'] != expected:
                _fail('response_contract_invalid')
        elif type(value['affected_row_count']) is not int or value['affected_row_count'] != 0:
            _fail('response_contract_invalid')


def _interpret(raw, plan, target, packet_metadata, operation, budget):
    if type(raw) is not bytes or not 1 <= len(raw) <= MAX_RESPONSE_BYTES:
        _fail('response_limit')
    payload = parser._parse(raw, budget)
    observation = parser._Observation()
    parser._observe_permissions(payload, plan, target, observation, budget)
    try:
        state, reason = parser._analyze(payload, plan, target, observation, budget)
        _affected(payload, plan, budget)
    except (parser.VerifierError, CleanTargetTransportError):
        # Exact permission codes remain STOP even in an inconsistent envelope.
        if not observation.permission:
            raise
        state, reason = 'unknown_requires_reconcile', 'permission_stop'
    if observation.permission:
        state, reason = 'unknown_requires_reconcile', 'permission_stop'
    acknowledged = state == 'commit_acknowledged'
    status = 'target_image_acknowledged' if acknowledged and operation == 'readback' else state
    keys = ('source_resource_sha256', 'target_resource_sha256', 'source_image_sha256',
        'source_archive_sha256', 'repair_sha256', 'plan_sha256', 'packet_sha256')
    return {'profile': PROFILE, 'operation': operation, 'status': status, 'reason': reason,
        **{key: packet_metadata[key] for key in keys},
        'response_sha256': hashlib.sha256(raw).hexdigest(),
        'read_plan_sha256': hashlib.sha256(plan.body).hexdigest() if operation == 'readback' else None,
        'identity_verified': True, 'response_contract_verified': state != 'unknown_requires_reconcile',
        'write_commit_acknowledged': acknowledged and operation == 'write',
        'target_postimage_acknowledged': acknowledged and operation == 'readback',
        'rollback_acknowledged': state == 'rollback_acknowledged',
        'transaction_not_started_acknowledged': state == 'not_started_acknowledged',
        'session_closed_verified': observation.closed, 'permission_stop': observation.permission,
        'requires_reconciliation': operation == 'write' or not acknowledged,
        **_FLAGS}


@dataclass(frozen=True, slots=True, repr=False)
class CleanTargetObservation:
    _safe_items: tuple
    _raw: bytes = field(repr=False)
    _packet: compiler.CompiledCleanTarget = field(repr=False)
    _target: str = field(repr=False)
    _operation: str = field(repr=False)

    def _validate(self, budget):
        code = _current_code()
        if (type(self._packet) is not compiler.CompiledCleanTarget or type(self._operation) is not str
                or self._operation not in {'write', 'readback'} or type(self._target) is not str
                or type(self._safe_items) is not tuple):
            _fail('identity_invalid')
        kernel._native_frozen(self._safe_items)
        meta = self._packet._validate(budget)
        target = kernel.capture._origin(self._target)
        if hashlib.sha256(target.encode('ascii')).hexdigest() != meta['target_resource_sha256']:
            _fail('identity_invalid')
        plan = self._packet if self._operation == 'write' else _read_plan(self._packet, budget)
        expected = _interpret(self._raw, plan, target, meta, self._operation, budget)
        if not kernel._same_native(tuple(sorted(expected.items())), self._safe_items):
            _fail('response_contract_invalid')
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
        return expected

    @property
    def safe_metadata(self):
        budget = None
        try:
            budget = _Budget(MAX_SECONDS)
            return self._validate(budget)
        except Exception as error:
            _closed(error, budget)


def _identities(source_resource, source_image, archive, target_resource, repair, plan, packet):
    return dict(expected_source_resource_sha256=source_resource, expected_source_image_sha256=source_image,
        expected_source_archive_sha256=archive, expected_target_resource_sha256=target_resource,
        expected_repair_sha256=repair, expected_plan_sha256=plan, expected_packet_sha256=packet)


def _operate(snapshot, artifact, *, source_origin, target_origin, token, identities,
             operation, timeout_seconds, check):
    budget = None
    try:
        budget = _Budget(timeout_seconds, check)
        _source, target = _origins(source_origin, target_origin, token, identities)
        code = _current_code(); budget.check()
        packet, metadata = _admit(snapshot, artifact, identities, budget)
        plan = packet if operation == 'write' else _read_plan(packet, budget)
        if len(plan.body) > MAX_REQUEST_BYTES:
            _fail('capacity_exhausted')
        budget.check()
        if _current_code() != code:
            _fail('code_drift')
        # The shared raw physical helper provides explicit task credential,
        # trust_env=False, TLS verification, no redirects, one POST, no retry,
        # bounded streaming, 5-second connect/read and local cleanup. It does
        # NOT inspect or pretend this is the old scope/Owner public profile.
        raw = physical._exchange(target, token, plan.body, budget)
        budget.check()
        if _current_code() != code:
            _fail('code_drift')
        facts = _interpret(raw, plan, target, metadata, operation, budget)
        result = CleanTargetObservation(tuple(sorted(facts.items())), raw, packet, target, operation)
        if _current_code() != code:
            _fail('code_drift')
        budget.check()
        return result
    except Exception as error:
        _closed(error, budget)


def send_clean_target_once(snapshot, artifact, *, source_origin, target_origin, token,
        expected_source_resource_sha256, expected_source_image_sha256, expected_source_archive_sha256,
        expected_target_resource_sha256, expected_repair_sha256, expected_plan_sha256,
        expected_packet_sha256, timeout_seconds=MAX_SECONDS, check=None):
    """One explicit write POST. Operator gates are external, never inferred."""
    return _operate(snapshot, artifact, source_origin=source_origin, target_origin=target_origin,
        token=token, identities=_identities(expected_source_resource_sha256, expected_source_image_sha256,
            expected_source_archive_sha256, expected_target_resource_sha256, expected_repair_sha256,
            expected_plan_sha256, expected_packet_sha256), operation='write', timeout_seconds=timeout_seconds, check=check)


def read_clean_target_once(snapshot, artifact, *, source_origin, target_origin, token,
        expected_source_resource_sha256, expected_source_image_sha256, expected_source_archive_sha256,
        expected_target_resource_sha256, expected_repair_sha256, expected_plan_sha256,
        expected_packet_sha256, timeout_seconds=MAX_SECONDS, check=None):
    """One independently requested fixed full read. Receipt grants NO replay."""
    return _operate(snapshot, artifact, source_origin=source_origin, target_origin=target_origin,
        token=token, identities=_identities(expected_source_resource_sha256, expected_source_image_sha256,
            expected_source_archive_sha256, expected_target_resource_sha256, expected_repair_sha256,
            expected_plan_sha256, expected_packet_sha256), operation='readback', timeout_seconds=timeout_seconds, check=check)
