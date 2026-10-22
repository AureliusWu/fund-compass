"""Local response contract for the separate repair + scope + Owner packet.

Only the Owner compiler's original-capture rehydration admits an artifact.
The fixed Hrana parser/FSM is shared, not the scope-v1 public entry point or
packet type. Supplied bytes are not authenticated remote evidence. This
module never sends, retries, reconciles or authorizes a migration.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import time

from database import turso_owner_upgrade_packet as compiler
from database import turso_scope_response as parser, turso_scope_snapshot as capture


PROFILE = 'turso-owner-upgrade-response-v1'
EVIDENCE_SCOPE = 'local_owner_upgrade_response_contract_verification'
MAX_BYTES = 64 * 1024 * 1024
MAX_SECONDS = 30.0
_FLAGS = ('remote_verified', 'remote_applied', 'remote_restore_verified',
          'formal_release_verified', 'retry_allowed')
_STATES = parser._STATES
_REASONS = parser._REASONS
_PUBLIC_KEYS = parser._PUBLIC_KEYS | frozenset({
    'parser_sha256', 'compiler_sha256', 'contract_code_sha256',
})
_VERIFIER_PATH = Path(__file__).resolve()
_PARSER_PATH = Path(parser.__file__).resolve()


class VerifierError(Exception):
    """Closed enum only; never propagate private response or packet content."""
    def __init__(self, reason):
        super().__init__(reason if type(reason) is str and reason in _REASONS
                         else 'verification_failed')


def _reject(reason='response_protocol_invalid'):
    raise VerifierError(reason)


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                      allow_nan=False).encode('ascii')


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _safe_digest(value):
    return value if type(value) is str and parser._SHA.fullmatch(value) else None


def _verifier_code_digest():
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
_LOADED_PARSER_SHA = parser._current_verifier_code()
_LOADED_COMPILER_CODE = compiler._current_code()
_LOADED_COMPILER_SHA = dict(_LOADED_COMPILER_CODE)['owner_compiler']
_LOADED_SOURCE_CODE = (*_LOADED_COMPILER_CODE,
                       ('scope_response', _LOADED_PARSER_SHA),
                       ('owner_response', _LOADED_VERIFIER_SHA))
_LOADED_CONTRACT_SHA = _digest(_canonical(_LOADED_SOURCE_CODE))


def _current_verifier_code():
    """Fixed source graph only; fail closed on drift in any shared dependency."""
    try:
        current = (*compiler._current_code(),
                   ('scope_response', parser._current_verifier_code()),
                   ('owner_response', _verifier_code_digest()))
        if current != _LOADED_SOURCE_CODE:
            _reject('code_drift')
        return _LOADED_VERIFIER_SHA
    except VerifierError:
        raise
    except Exception:
        _reject('code_drift')


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


def _budget():
    started = _now()
    return _Budget(started + MAX_SECONDS, started)


def _unqualified_failure(values):
    return (values['status'] == 'unknown_requires_reconcile'
            and values['reason'] in {'response_time_limit', 'code_drift'}
            and values['identity_verified'] is False and values['session_closed_verified'] is False
            and values['permission_stop'] is False)


def _publish_sources(values, budget):
    # A source mismatch may publish only the explicit unqualified drift result,
    # never a previously observed success, closed session or permission claim.
    try:
        _current_verifier_code()
    except VerifierError:
        if not (values['status'] == 'unknown_requires_reconcile'
                and values['reason'] == 'code_drift' and values['identity_verified'] is False
                and values['session_closed_verified'] is False and values['permission_stop'] is False):
            _reject('code_drift')
    if budget is not None:
        try:
            budget.check()
        except VerifierError:
            if not _unqualified_failure(values):
                raise


def _start_dto_budget():
    try:
        return _budget()
    except VerifierError:
        return None


def _require_dto_budget(values, budget):
    # If a clock itself is unusable, only a fully unqualified explicit
    # timeout/drift DTO can still report that failure. Never retain an
    # identity, session or permission proof without a measurable budget.
    if budget is None and not _unqualified_failure(values):
        _reject('response_time_limit')


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
    parser_sha256: str = field(default=_LOADED_PARSER_SHA, init=False)
    compiler_sha256: str = field(default=_LOADED_COMPILER_SHA, init=False)
    contract_code_sha256: str = field(default=_LOADED_CONTRACT_SHA, init=False)
    remote_verified: bool = field(default=False, init=False)
    remote_applied: bool = field(default=False, init=False)
    remote_restore_verified: bool = field(default=False, init=False)
    formal_release_verified: bool = field(default=False, init=False)
    retry_allowed: bool = field(default=False, init=False)
    _seal: str = field(init=False, repr=False)

    def __post_init__(self):
        budget = _start_dto_budget()
        values = self._values()
        _require_dto_budget(values, budget)
        _publish_sources(values, budget)
        object.__setattr__(self, '_seal', _digest(_canonical(values)))
        _publish_sources(values, budget)

    def _values(self):
        if (type(self.status) is not str or self.status not in _STATES
                or type(self.reason) is not str or self.reason not in _REASONS
                or any(getattr(self, name) is not False for name in _FLAGS)
                or any(type(getattr(self, name)) is not bool for name in
                       ('identity_verified', 'session_closed_verified', 'permission_stop'))
                or any(value is not None and _safe_digest(value) is None for value in
                       (self.resource_sha256, self.plan_sha256, self.packet_sha256, self.response_sha256))
                or any(type(value) is not str or value != expected for value, expected in (
                    (self.verifier_sha256, _LOADED_VERIFIER_SHA),
                    (self.parser_sha256, _LOADED_PARSER_SHA),
                    (self.compiler_sha256, _LOADED_COMPILER_SHA),
                    (self.contract_code_sha256, _LOADED_CONTRACT_SHA)))):
            _reject('result_integrity_invalid')
        if self.identity_verified and any(value is None for value in (
                self.resource_sha256, self.plan_sha256, self.packet_sha256)):
            _reject('result_integrity_invalid')
        if (not self.identity_verified and (self.session_closed_verified or self.permission_stop)
                or self.session_closed_verified and self.response_sha256 is None
                or self.permission_stop and (self.response_sha256 is None or self.reason != 'permission_stop')
                or self.reason == 'permission_stop' and not self.permission_stop):
            _reject('result_integrity_invalid')
        verified = self.status != 'unknown_requires_reconcile'
        expected_reasons = {'commit_acknowledged': 'commit_acknowledged',
                            'not_started_acknowledged': 'begin_rejected',
                            'rollback_acknowledged': 'transaction_rolled_back'}
        if verified and (not self.identity_verified or not self.session_closed_verified
                or self.response_sha256 is None or self.permission_stop
                or self.reason != expected_reasons[self.status]):
            _reject('result_integrity_invalid')
        if not verified:
            if self.reason in expected_reasons.values():
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
        result = dict(profile=PROFILE, evidence_scope=EVIDENCE_SCOPE,
            status=self.status, reason=self.reason, resource_sha256=self.resource_sha256,
            plan_sha256=self.plan_sha256, packet_sha256=self.packet_sha256,
            response_sha256=self.response_sha256, verifier_sha256=self.verifier_sha256,
            parser_sha256=self.parser_sha256, compiler_sha256=self.compiler_sha256,
            contract_code_sha256=self.contract_code_sha256, identity_verified=self.identity_verified,
            response_contract_verified=verified,
            commit_acknowledged=self.status == 'commit_acknowledged',
            rollback_acknowledged=self.status == 'rollback_acknowledged',
            transaction_not_started_acknowledged=self.status == 'not_started_acknowledged',
            session_closed_verified=self.session_closed_verified, permission_stop=self.permission_stop,
            requires_reconciliation=not verified, **{name: getattr(self, name) for name in _FLAGS})
        if set(result) != _PUBLIC_KEYS:
            _reject('result_integrity_invalid')
        return result

    @property
    def safe_metadata(self):
        budget = _start_dto_budget()
        result = self._values()
        _require_dto_budget(result, budget)
        _publish_sources(result, budget)
        if type(self._seal) is not str or self._seal != _digest(_canonical(result)):
            _reject('result_integrity_invalid')
        _publish_sources(result, budget)
        return result


def verify_owner_upgrade_response(snapshot, artifact, raw_response, *, candidate_origin,
                                  expected_resource_sha256, expected_plan_sha256, expected_packet_sha256):
    """Interpret supplied bytes only after recompile against independent SHAs.

    The outer cooperative deadline includes admission, parsing, all final pin
    reads and construction/getter validation. It is not a hard process timeout
    and does not prove actual SQL close/commit, transport or remote durability.
    """
    identities = tuple(_safe_digest(value) for value in
                       (expected_resource_sha256, expected_plan_sha256, expected_packet_sha256))
    response_sha, verified, budget = None, False, None
    observation = parser._Observation()
    status, reason = 'unknown_requires_reconcile', 'verification_failed'
    try:
        budget = _budget()
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
        payload = parser._parse(raw_response, budget)
        parser._observe_permissions(payload, packet, origin, observation, budget)
        status, reason = parser._analyze(payload, packet, origin, observation, budget)
        budget.check()
    except compiler.CompilerError as error:
        reason = {'compiler_code_drift': 'code_drift', 'compile_time_limit': 'response_time_limit'}.get(
            str(error), 'identity_invalid')
    except capture.SnapshotError:
        reason = 'origin_mismatch'
    except (VerifierError, parser.VerifierError) as error:
        reason = str(error) if str(error) in _REASONS else 'verification_failed'
    except Exception:
        reason = 'verification_failed'

    def closed_result():
        nonlocal status, reason, verified
        try:
            _current_verifier_code()
        except Exception:
            verified = False
            status, reason = 'unknown_requires_reconcile', 'code_drift'
        if reason in {'identity_invalid', 'origin_mismatch', 'code_drift'}:
            # A later healthy source read cannot restore qualification already
            # lost at an earlier stage of this verification attempt.
            verified = False
        if not verified:
            observation.closed = observation.permission = False
        if observation.permission and reason not in {'identity_invalid', 'origin_mismatch', 'code_drift'}:
            status, reason = 'unknown_requires_reconcile', 'permission_stop'
        if reason not in {'commit_acknowledged', 'begin_rejected', 'transaction_rolled_back'}:
            status = 'unknown_requires_reconcile'
        return ResponseVerdict(status, reason, *identities, response_sha, _LOADED_VERIFIER_SHA,
                               verified, observation.closed, observation.permission)

    try:
        verdict = closed_result()
        # Deliberately include the public getter, not merely a constructor seal.
        _ = verdict.safe_metadata
        _current_verifier_code()
        if budget is not None:
            budget.check()
        return verdict
    except VerifierError as error:
        if str(error) == 'code_drift':
            verified = False
            observation.closed = observation.permission = False
            reason = 'code_drift'
        elif observation.permission and verified:
            reason = 'permission_stop'
        else:
            reason = 'response_time_limit' if str(error) == 'response_time_limit' else 'verification_failed'
            # A DTO clock failure may make its own deadline unmeasurable.
            # Returning only an unqualified timeout remains safe in that case.
            if reason == 'response_time_limit':
                verified = False
                observation.closed = observation.permission = False
        status = 'unknown_requires_reconcile'
        try:
            return closed_result()
        except VerifierError as fallback_error:
            # A bound AUTH observation is a stop, not permission to retry, but
            # a subsequently unusable DTO clock cannot retain qualified proofs.
            # Report a closed unqualified failure instead of throwing again.
            verified = False
            observation.closed = observation.permission = False
            reason = 'code_drift' if str(fallback_error) == 'code_drift' else 'response_time_limit'
            return closed_result()
