"""Pure local Hrana contract verification. No transport, retry or reconciliation.

Only a recompiled, externally identity-bound packet is admitted. Response
bytes are untrusted evidence, never proof that a remote migration occurred.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import re
import time

from database import turso_scope_packet as compiler, turso_scope_snapshot as capture

MAX_BYTES = 64 * 1024 * 1024
MAX_DEPTH = 24
MAX_NODES = 2_000_000
MAX_SECONDS = 30.0
MAX_ERROR_BYTES = 256 * 1024
MAX_CODE_BYTES = 128
MAX_KEY_BYTES = 128
MAX_COUNT = 2**53 - 1
PROFILE = 'turso-scope-response-v1'
EVIDENCE_SCOPE = 'local_scope_response_contract_verification'
_SHA = re.compile(r'[0-9a-f]{64}\Z', re.ASCII)
_INTEGER = re.compile(r'(?:0|-[1-9][0-9]*|[1-9][0-9]*)\Z', re.ASCII)
_UNSIGNED = re.compile(r'(?:0|[1-9][0-9]*)\Z', re.ASCII)
_PERMISSION = frozenset({'AUTH', 'PERM', 'READONLY', 'SQLITE_AUTH', 'SQLITE_PERM', 'SQLITE_READONLY'})
_STATES = frozenset({'commit_acknowledged', 'not_started_acknowledged',
                     'rollback_acknowledged', 'unknown_requires_reconcile'})
_REASONS = frozenset({'commit_acknowledged', 'begin_rejected', 'transaction_rolled_back',
    'response_missing', 'response_type_invalid', 'response_limit', 'response_protocol_invalid',
    'response_semantics_unknown', 'response_time_limit', 'pipeline_error', 'identity_invalid',
    'origin_mismatch', 'code_drift', 'permission_stop', 'verification_failed', 'result_integrity_invalid'})
_FLAGS = ('remote_verified', 'remote_applied', 'remote_restore_verified', 'formal_release_verified',
          'retry_allowed')
_PUBLIC_KEYS = frozenset({'profile', 'evidence_scope', 'status', 'reason', 'resource_sha256',
    'plan_sha256', 'packet_sha256', 'response_sha256', 'verifier_sha256', 'identity_verified', 'response_contract_verified',
    'commit_acknowledged', 'rollback_acknowledged', 'transaction_not_started_acknowledged',
    'session_closed_verified', 'permission_stop', 'requires_reconciliation', *_FLAGS})


class VerifierError(Exception):
    """Fixed enum only; no response, SQL, URL, message or values in exceptions."""
    def __init__(self, reason):
        super().__init__(reason if type(reason) is str and reason in _REASONS else 'verification_failed')


def _reject(reason='response_protocol_invalid'):
    raise VerifierError(reason)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                      allow_nan=False).encode('ascii')


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _safe_digest(value):
    return value if type(value) is str and _SHA.fullmatch(value) else None


_VERIFIER_PATH = Path(__file__).resolve()


def _verifier_code_digest():
    # One fixed own module path, never an input/configuration/credential path.
    try:
        with _VERIFIER_PATH.open('rb') as source:
            raw = source.read(1024 * 1024 + 1)
        if not 1 <= len(raw) <= 1024 * 1024:
            _reject('code_drift')
        raw.decode('utf-8', errors='strict')
        return _digest(raw)
    except VerifierError:
        raise
    except Exception:
        _reject('code_drift')


_LOADED_VERIFIER_SHA = _verifier_code_digest()


def _current_verifier_code():
    current = _verifier_code_digest()
    if current != _LOADED_VERIFIER_SHA:
        _reject('code_drift')
    return current


@dataclass(frozen=True, slots=True, repr=False)
class ResponseVerdict:
    status: str
    reason: str
    resource_sha256: str | None
    plan_sha256: str | None
    packet_sha256: str | None
    response_sha256: str | None
    verifier_sha256: str
    identity_verified: bool
    session_closed_verified: bool
    permission_stop: bool
    remote_verified: bool = field(default=False, init=False)
    remote_applied: bool = field(default=False, init=False)
    remote_restore_verified: bool = field(default=False, init=False)
    formal_release_verified: bool = field(default=False, init=False)
    retry_allowed: bool = field(default=False, init=False)
    _seal: str = field(init=False, repr=False)

    def __post_init__(self):
        values = self._values()
        object.__setattr__(self, '_seal', _digest(_canonical(values)))

    def _values(self):
        if (type(self.status) is not str or self.status not in _STATES
                or type(self.reason) is not str or self.reason not in _REASONS
                or any(getattr(self, name) is not False for name in _FLAGS)
                or any(type(getattr(self, name)) is not bool for name in
                       ('identity_verified', 'session_closed_verified', 'permission_stop'))
                or any(value is not None and _safe_digest(value) is None for value in
                       (self.resource_sha256, self.plan_sha256, self.packet_sha256, self.response_sha256))
                or _safe_digest(self.verifier_sha256) != _LOADED_VERIFIER_SHA):
            _reject('result_integrity_invalid')
        identities = (self.resource_sha256, self.plan_sha256, self.packet_sha256)
        if self.identity_verified and any(value is None for value in identities):
            _reject('result_integrity_invalid')
        if (not self.identity_verified and (self.session_closed_verified or self.permission_stop)
                or self.session_closed_verified and self.response_sha256 is None
                or self.permission_stop and (self.response_sha256 is None or self.reason != 'permission_stop')
                or self.reason == 'permission_stop' and not self.permission_stop):
            _reject('result_integrity_invalid')
        verified = self.status != 'unknown_requires_reconcile'
        if verified and (not self.identity_verified or not self.session_closed_verified
                         or self.response_sha256 is None or self.permission_stop):
            _reject('result_integrity_invalid')
        expected_reason = {'commit_acknowledged': 'commit_acknowledged',
                           'not_started_acknowledged': 'begin_rejected',
                           'rollback_acknowledged': 'transaction_rolled_back'}
        if verified and self.reason != expected_reason[self.status]:
            _reject('result_integrity_invalid')
        if not verified:
            if self.reason in expected_reason.values():
                _reject('result_integrity_invalid')
            if self.reason in {'identity_invalid', 'origin_mismatch', 'code_drift'} and self.identity_verified:
                _reject('result_integrity_invalid')
            if not self.identity_verified and self.reason not in {
                    'identity_invalid', 'origin_mismatch', 'code_drift', 'verification_failed', 'response_time_limit'}:
                _reject('result_integrity_invalid')
            if self.reason in {'response_missing', 'response_type_invalid'} and (
                    self.response_sha256 is not None or self.session_closed_verified or self.permission_stop):
                _reject('result_integrity_invalid')
            if self.reason in {'response_protocol_invalid', 'response_semantics_unknown', 'pipeline_error'} and self.response_sha256 is None:
                _reject('result_integrity_invalid')
        result = {'profile': PROFILE, 'evidence_scope': EVIDENCE_SCOPE,
            'status': self.status, 'reason': self.reason, 'resource_sha256': self.resource_sha256,
            'plan_sha256': self.plan_sha256, 'packet_sha256': self.packet_sha256,
            'response_sha256': self.response_sha256, 'verifier_sha256': self.verifier_sha256,
            'identity_verified': self.identity_verified,
            'response_contract_verified': verified,
            'commit_acknowledged': self.status == 'commit_acknowledged',
            'rollback_acknowledged': self.status == 'rollback_acknowledged',
            'transaction_not_started_acknowledged': self.status == 'not_started_acknowledged',
            'session_closed_verified': self.session_closed_verified, 'permission_stop': self.permission_stop,
            'requires_reconciliation': not verified,
            **{name: getattr(self, name) for name in _FLAGS}}
        if set(result) != _PUBLIC_KEYS:
            _reject('result_integrity_invalid')
        return result

    @property
    def safe_metadata(self):
        result = self._values()
        if type(self._seal) is not str or self._seal != _digest(_canonical(result)):
            _reject('result_integrity_invalid')
        return result


@dataclass(slots=True, repr=False)
class _Observation:
    permission: bool = False
    closed: bool = False


class _Budget:
    def __init__(self, deadline, start=None):
        if type(deadline) not in (int, float) or not math.isfinite(deadline):
            _reject('response_time_limit')
        self.deadline = deadline
        self.last = _now() if start is None else start
        if type(self.last) not in (int, float) or not math.isfinite(self.last) or self.last > deadline:
            _reject('response_time_limit')

    def check(self):
        current = _now()
        if current < self.last or current > self.deadline:
            _reject('response_time_limit')
        self.last = current


def _now():
    try:
        value = time.monotonic()
        if type(value) not in (int, float) or not math.isfinite(value):
            _reject('response_time_limit')
        return value
    except VerifierError:
        raise
    except Exception:
        _reject('response_time_limit')


def _text(value, maximum):
    if type(value) is not str:
        _reject()
    try:
        if len(value.encode('utf-8', errors='strict')) > maximum:
            _reject('response_limit')
    except UnicodeError:
        _reject()
    return value


def _preflight(text, budget):
    # Bound structure BEFORE json.loads allocates its object tree. This
    # intentionally counts keys too, making the node limit conservative.
    stack, nodes, in_string, escaped, scalar = [], 0, False, False, False
    for offset, char in enumerate(text):
        if not offset % 4096:
            budget.check()
        if in_string:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string, scalar = True, False
            nodes += 1
        elif char in '[{':
            stack.append(char)
            nodes += 1
            scalar = False
            if len(stack) > MAX_DEPTH:
                _reject('response_limit')
        elif char in ']}':
            if not stack or stack.pop() != ('[' if char == ']' else '{'):
                _reject()
            scalar = False
        elif char in ',:' or char.isspace():
            scalar = False
        elif not scalar:
            scalar = True
            nodes += 1
        if nodes > MAX_NODES:
            _reject('response_limit')
    if stack or in_string:
        _reject()
    budget.check()


def _parse(raw, budget):
    try:
        text = raw.decode('utf-8', errors='strict')
        _preflight(text, budget)

        def pairs(items):
            result = {}
            for key, value in items:
                budget.check()
                _text(key, MAX_KEY_BYTES)
                if key in result:
                    _reject()
                result[key] = value
            return result

        payload = json.loads(text, object_pairs_hook=pairs, parse_constant=lambda _: _reject())
        pending, nodes = [(payload, 0)], 0
        while pending:
            budget.check()
            value, depth = pending.pop()
            nodes += 1
            if depth > MAX_DEPTH or nodes > MAX_NODES:
                _reject('response_limit')
            if type(value) is float and not math.isfinite(value):
                _reject()
            if type(value) is dict:
                pending.extend((item, depth + 1) for item in value.values())
            elif type(value) is list:
                pending.extend((item, depth + 1) for item in value)
            elif type(value) is str:
                _text(value, MAX_BYTES)
        return payload
    except VerifierError:
        raise
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        _reject()


def _count(value):
    if type(value) is not int or not 0 <= value <= MAX_COUNT:
        _reject()


def _replication(value):
    if value is not None and (type(value) is not str or len(value) > 20
            or not _UNSIGNED.fullmatch(value) or int(value) > 2**64 - 1):
        _reject()


def _error(value, observation):
    if type(value) is not dict or not {'message'} <= set(value) <= {'message', 'code'}:
        _reject()
    _text(value['message'], MAX_ERROR_BYTES)
    if 'code' in value:
        code = _text(value['code'], MAX_CODE_BYTES)
        if code in _PERMISSION:
            observation.permission = True


def _observe_error_code(value, observation):
    # This records only the supplied literal code at a fixed protocol slot.
    # Message validity/semantics are still checked later and never authorize
    # a fallback. Extra keys or an unknown/native-subclass code are not observed.
    if (type(value) is dict and set(value) == {'message', 'code'}
            and type(value.get('code')) is str and value['code'] in _PERMISSION):
        observation.permission = True


def _observe_permissions(payload, packet, origin, observation, budget):
    # Do not recursively search arbitrary user data for words resembling AUTH.
    if type(payload) is not dict or type(payload.get('results')) is not list:
        return
    try:
        capture._same_stream_origin(payload.get('base_url'), origin)
    except capture.SnapshotError:
        return
    for item in payload['results'][:3]:
        budget.check()
        if type(item) is dict and set(item) == {'type', 'error'} and item.get('type') == 'error':
            _observe_error_code(item['error'], observation)
    items = payload['results']
    if not items or type(items[0]) is not dict:
        return
    first = items[0]
    response = first.get('response')
    if (first.get('type') != 'ok' or type(response) is not dict or response.get('type') != 'batch'
            or type(response.get('result')) is not dict):
        return
    errors = response['result'].get('step_errors')
    if type(errors) is list:
        for error in errors[:len(packet.statement_specs)]:
            budget.check()
            _observe_error_code(error, observation)


def _statement(value, spec, budget):
    required = {'cols', 'rows', 'affected_row_count', 'last_insert_rowid'}
    metrics = {'rows_read', 'rows_written', 'query_duration_ms', 'replication_index'}
    if type(value) is not dict or not required <= set(value) <= required | metrics:
        _reject()
    _count(value['affected_row_count'])
    rowid = value['last_insert_rowid']
    if rowid is not None and (type(rowid) is not str or len(rowid) > 20
            or not _INTEGER.fullmatch(rowid) or not -(2**63) <= int(rowid) <= 2**63 - 1):
        _reject()
    for name in ('rows_read', 'rows_written'):
        if name in value:
            _count(value[name])
    if 'replication_index' in value:
        _replication(value['replication_index'])
    if 'query_duration_ms' in value:
        duration = value['query_duration_ms']
        if type(duration) not in (int, float) or not math.isfinite(duration) or not 0 <= duration <= MAX_SECONDS * 1000:
            _reject()
    cols, rows = value['cols'], value['rows']
    if type(cols) is not list or type(rows) is not list:
        _reject()
    result_spec = spec[4]
    if result_spec[0] == 'empty':
        if cols or rows:
            _reject()
        return
    if len(cols) != 1 or len(rows) != 1 or type(cols[0]) is not dict:
        _reject()
    col = cols[0]
    if not {'name'} <= set(col) <= {'name', 'decltype'} or type(col['name']) is not str or col['name'] != 'guard_passed':
        _reject()
    if col.get('decltype') is not None:
        _text(col['decltype'], 128)
    if type(rows[0]) is not list or len(rows[0]) != 1 or type(rows[0][0]) is not dict:
        _reject()
    cell = rows[0][0]
    if (set(cell) != {'type', 'value'} or type(cell['type']) is not str or cell['type'] != 'integer'
            or type(cell['value']) is not str or cell['value'] != '1'):
        _reject()
    budget.check()


def _analyze(payload, packet, origin, observation, budget):
    if (type(payload) is not dict or not {'baton', 'results'} <= set(payload) <= {'baton', 'results', 'base_url'}
            or payload['baton'] is not None):
        _reject()
    try:
        capture._same_stream_origin(payload.get('base_url'), origin)
    except capture.SnapshotError:
        _reject()
    results = payload['results']
    if type(results) is not list or len(results) != 3:
        _reject()
    for item, expected in zip(results, ('batch', 'get_autocommit', 'close')):
        if type(item) is not dict or type(item.get('type')) is not str:
            _reject()
        if item['type'] == 'error':
            if set(item) != {'type', 'error'}:
                _reject()
            _error(item['error'], observation)
        elif (item['type'] != 'ok' or set(item) != {'type', 'response'}
                or type(item['response']) is not dict or type(item['response'].get('type')) is not str
                or item['response']['type'] != expected):
            _reject()
    if any(item['type'] != 'ok' for item in results):
        _reject('pipeline_error')
    state, closed = results[1]['response'], results[2]['response']
    if (set(state) != {'type', 'is_autocommit'} or state['is_autocommit'] is not True
            or closed != {'type': 'close'}):
        _reject('response_semantics_unknown')
    observation.closed = True
    batch = results[0]['response']
    if set(batch) != {'type', 'result'} or type(batch['result']) is not dict:
        _reject()
    result = batch['result']
    if not {'step_results', 'step_errors'} <= set(result) <= {'step_results', 'step_errors', 'replication_index'}:
        _reject()
    if 'replication_index' in result:
        _replication(result['replication_index'])
    values, errors = result['step_results'], result['step_errors']
    specs = packet.statement_specs
    commit, rollback = packet.request_specs[0][2:]
    if (type(values) is not list or type(errors) is not list or len(values) != len(specs) or len(errors) != len(specs)):
        _reject()
    states = []
    for value, error, spec in zip(values, errors, specs):
        budget.check()
        if error is not None:
            _error(error, observation)
            if value is not None:
                _reject()
            states.append('error')
        elif value is not None:
            _statement(value, spec, budget)
            states.append('ok')
        else:
            states.append('skip')
    if states == ['ok'] * (commit + 1) + ['skip']:
        return 'commit_acknowledged', 'commit_acknowledged'
    if states == ['error'] + ['skip'] * (len(specs) - 1):
        return 'not_started_acknowledged', 'begin_rejected'
    faults = [index for index, value in enumerate(states) if value == 'error']
    if len(faults) == 1:
        fault = faults[0]
        if (1 <= fault <= commit and states == ['ok'] * fault + ['error']
                + ['skip'] * (commit - fault) + ['ok'] and rollback == len(states) - 1):
            return 'rollback_acknowledged', 'transaction_rolled_back'
    _reject('response_semantics_unknown')


def verify_scope_response(snapshot, artifact, raw_response, *, candidate_origin,
                          expected_resource_sha256, expected_plan_sha256, expected_packet_sha256):
    """Verify local bytes; never send, authorize apply, reconcile or allow retry.

    Expected identities must be independently fixed by the caller, not read
    from an untrusted artifact. Any incomplete/invalid response is unknown.
    """
    identities = tuple(_safe_digest(value) for value in
                       (expected_resource_sha256, expected_plan_sha256, expected_packet_sha256))
    response_sha = None
    verified = False
    observation = _Observation()
    status, reason = 'unknown_requires_reconcile', 'verification_failed'
    budget = None
    try:
        started = _now()
        budget = _Budget(started + MAX_SECONDS, started)
        _current_verifier_code()
        budget.check()
        if any(value is None for value in identities):
            _reject('identity_invalid')
        origin = capture._origin(candidate_origin)
        packet = compiler.rehydrate_packet(snapshot, artifact,
            expected_resource_sha256=expected_resource_sha256, expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256)
        budget.check()
        if _digest(origin.encode('ascii')) != expected_resource_sha256:
            _reject('origin_mismatch')
        verified = True
        if raw_response is None:
            _reject('response_missing')
        if type(raw_response) is not bytes:
            _reject('response_type_invalid')
        if not 1 <= len(raw_response) <= min(MAX_BYTES, packet.safe_metadata['max_response_bytes']):
            _reject('response_limit')
        budget.check()
        response_sha = _digest(raw_response)
        budget.check()
        payload = _parse(raw_response, budget)
        _observe_permissions(payload, packet, origin, observation, budget)
        status, reason = _analyze(payload, packet, origin, observation, budget)
        budget.check()
    except compiler.CompilerError as error:
        reason = {'compiler_code_drift': 'code_drift', 'compile_time_limit': 'response_time_limit'}.get(
            str(error), 'identity_invalid')
    except capture.SnapshotError:
        reason = 'origin_mismatch'
    except VerifierError as error:
        reason = str(error)
    except Exception:
        reason = 'verification_failed'
    # A failure after parsing or a concurrent source change cannot preserve a
    # success classification. No exception text or private content is exposed.
    try:
        _current_verifier_code()
        compiler._current_code()
    except Exception:
        verified = False
        status, reason = 'unknown_requires_reconcile', 'code_drift'
    if not verified:
        observation.closed = observation.permission = False
    if observation.permission and reason not in {'identity_invalid', 'origin_mismatch', 'code_drift'}:
        status, reason = 'unknown_requires_reconcile', 'permission_stop'
    if reason not in {'commit_acknowledged', 'begin_rejected', 'transaction_rolled_back'}:
        status = 'unknown_requires_reconcile'
    verdict = ResponseVerdict(status, reason, *identities, response_sha,
                              _LOADED_VERIFIER_SHA, verified, observation.closed, observation.permission)
    # A cooperative total deadline includes full identity recompile, parsing,
    # interpretation, final source fingerprints and closed DTO construction.
    # It is not a process kill, Cloud timeout or cloud performance qualification.
    if budget is not None and reason != 'code_drift':
        try:
            budget.check()
        except VerifierError:
            if observation.permission:
                status, reason = 'unknown_requires_reconcile', 'permission_stop'
            else:
                status, reason = 'unknown_requires_reconcile', 'response_time_limit'
            verdict = ResponseVerdict(status, reason, *identities, response_sha,
                _LOADED_VERIFIER_SHA, verified, observation.closed, observation.permission)
    return verdict
