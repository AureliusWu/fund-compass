"""Explicit capacity-only fixed SELECT probe; never a migration/write test.

One DEFERRED pipeline, one POST, own ASCII-zero padding only. No supplied SQL,
private payload, environment credentials, retries or automatic follow-up exist.
An observation only covers these actual bytes/steps, not write capability,
900-parameter dimensions, SQL complexity, transaction duration or release.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path

from database import turso_clean_target_transport as clean
from database import turso_scope_packet as kernel, turso_scope_response as parser
from database import turso_scope_transport as physical

PROFILE = "turso-clean-readonly-capacity-probe-1"
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_SECONDS = 30.0
MAX_EXTRA_BYTES = 1024
_FLAGS = {
    "write_capacity_verified": False, "parameter_dimensions_verified": False,
    "sql_complexity_verified": False, "transaction_duration_verified": False,
    "target_postimage_verified": False, "remote_applied": False, "restore_verified": False,
    "formal_release_verified": False, "migration_authorized": False, "retry_allowed": False,
}
_REASONS = frozenset({"invalid_arguments", "identity_invalid", "code_drift", "operation_timeout",
    "capacity_exhausted", "transport_failed", "cleanup_failed", "http_authentication_rejected",
    "http_access_denied", "http_rate_limited", "http_unexpected_status", "response_limit",
    "response_type_invalid", "transport_used", "response_contract_invalid", "permission_stop"})
_SEAL = object()


class CapacityProbeError(RuntimeError):
    def __init__(self, reason="transport_failed", http_status=None):
        self.reason = reason if type(reason) is str and reason in _REASONS else "transport_failed"
        self.http_status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
        self.outcome = "unknown"
        super().__init__(self.reason)


def _fail(reason, status=None):
    raise CapacityProbeError(reason, status) from None


class _IssuedSeal:
    """Per-observation immutable issuance binding, not a public certificate."""
    __slots__ = ("_issuer", "_items")

    def __init__(self, issuer, items):
        if issuer is not _SEAL:
            _fail("identity_invalid")
        object.__setattr__(self, "_issuer", issuer)
        object.__setattr__(self, "_items", items)

    def __setattr__(self, _name, _value):
        _fail("identity_invalid")

    def __repr__(self):
        return "<_IssuedCapacitySeal>"


def _code():
    with Path(__file__).resolve().open("rb") as source:
        raw = source.read(1024 * 1024 + 1)
    if not 1 <= len(raw) <= 1024 * 1024:
        _fail("code_drift")
    raw.decode("utf8", errors="strict")
    return hashlib.sha256(raw).hexdigest(), clean._current_code(), physical._current_code()


_LOADED = _code()


def _current_code():
    try:
        result = _code()
        if result != _LOADED:
            _fail("code_drift")
        return result
    except Exception:
        _fail("code_drift")


def _closed(error):
    if type(error) is CapacityProbeError:
        raise error from None
    if type(error) in (physical.TransportError, clean.CleanTargetTransportError, parser.VerifierError,
                       clean.compiler.CleanTargetError):
        args = BaseException.args.__get__(error, BaseException)
        reason = args[0] if type(args) is tuple and len(args) == 1 and type(args[0]) is str else None
        reason = {"time_limit": "operation_timeout", "response_time_limit": "operation_timeout"}.get(reason, reason)
        if reason not in _REASONS:
            reason = "response_contract_invalid"
        status = object.__getattribute__(error, "http_status") if type(error) in (physical.TransportError, clean.CleanTargetTransportError) else None
        _fail(reason, status)
    _fail("transport_failed")


def _dimensions(request_bytes, batch_steps):
    if (type(request_bytes) is not int or not 1 <= request_bytes <= MAX_REQUEST_BYTES
            or type(batch_steps) is not int or not 4 <= batch_steps <= kernel.MAX_STEPS):
        _fail("invalid_arguments")


def _statements(guard_count, cell_counts, extra, budget):
    """Only generated ASCII zeros and fixed SELECT syntax; no input values."""
    statements = []
    for index, count in enumerate(cell_counts):
        budget.check()
        padding, checks = [], []
        for cell in range(count):
            length = 1 + min(extra, kernel.MAX_CELL_BYTES - 1)
            extra -= length - 1
            padding.append("0" * length)
            parameter = "?" + str(cell + 1)
            checks.append(f"typeof({parameter})='text' AND length({parameter})={length} "
                          f"AND {parameter} NOT GLOB '*[^0]*'")
        statements.append(kernel._guard("capacity:select:" + str(index), " AND ".join(checks), tuple(padding)))
    if extra or len(statements) != guard_count:
        _fail("capacity_exhausted")
    return tuple(statements)


def _plan(request_bytes, batch_steps, budget):
    _dimensions(request_bytes, batch_steps)
    # The immutable first public constant guard is exactly the final packet's
    # JSON1/MATERIALIZED/I64/Unicode probe; it never accepts caller SQL/data.
    fixed = clean.compiler.compact_capability_probe()
    guards = batch_steps - 4  # Fixed probe + BEGIN/COMMIT/ROLLBACK.
    cells = max(guards, (request_bytes + kernel.MAX_CELL_BYTES - 1) // kernel.MAX_CELL_BYTES) if guards else 0
    base, remainder = divmod(cells, guards) if guards else (0, 0)
    cell_counts = tuple(base + int(index < remainder) for index in range(guards))
    if cell_counts and max(cell_counts) > kernel.MAX_ARGS:
        _fail("capacity_exhausted")

    def compile_size(extra):
        budget.check()
        try:
            original = clean._read_pipeline((fixed, *_statements(guards, cell_counts, extra, budget)))
            body = json.dumps(json.loads(original.body), ensure_ascii=False, sort_keys=True,
                              separators=(",", ":"), allow_nan=False).encode("utf8", errors="strict")
            if len(body) > MAX_REQUEST_BYTES:
                _fail("capacity_exhausted")
            result = clean._ReadPlan(body, original.statement_specs, original.request_specs)
        except clean.CleanTargetTransportError as error:
            if error.reason == "capacity_exhausted":
                return None
            raise
        budget.check()
        return result

    empty = compile_size(0)
    if empty is None:
        _fail("capacity_exhausted")
    if len(empty.body) >= request_bytes:
        if len(empty.body) > min(MAX_REQUEST_BYTES, request_bytes + MAX_EXTRA_BYTES):
            _fail("capacity_exhausted")
        return empty
    if not guards:
        _fail("capacity_exhausted")
    lo, hi = 0, min(request_bytes, cells * (kernel.MAX_CELL_BYTES - 1))
    # Monotone offline sizing only. Never dispatch an exploratory network call.
    while lo < hi:
        budget.check()
        mid = (lo + hi) // 2
        candidate = compile_size(mid)
        if candidate is None or len(candidate.body) >= request_bytes:
            hi = mid
        else:
            lo = mid + 1
    result = compile_size(lo)
    if (result is None or not request_bytes <= len(result.body) <= min(MAX_REQUEST_BYTES, request_bytes + MAX_EXTRA_BYTES)
            or len(result.statement_specs) != batch_steps):
        _fail("capacity_exhausted")
    return result


def _interpret(raw, plan, target, resource, dimensions, budget):
    if type(raw) is not bytes or not 1 <= len(raw) <= clean.MAX_RESPONSE_BYTES:
        _fail("response_limit")
    payload = parser._parse(raw, budget)
    observation = parser._Observation()
    parser._observe_permissions(payload, plan, target, observation, budget)
    if observation.permission:
        _fail("permission_stop")
    state, _reason = parser._analyze(payload, plan, target, observation, budget)
    clean._affected(payload, plan, budget)
    if state != "commit_acknowledged" or not observation.closed:
        _fail("response_contract_invalid")
    budget.check()
    return {"profile": PROFILE, "capacity_observed": True, "target_resource_sha256": resource,
        "required_request_bytes": dimensions[0], "observed_request_bytes": len(plan.body),
        "observed_batch_steps_including_controls": len(plan.statement_specs),
        "plain_probe_sha256": hashlib.sha256(kernel._json(clean.compiler.compact_capability_probe()._wire())).hexdigest(),
        "request_sha256": hashlib.sha256(plan.body).hexdigest(),
        "response_sha256": hashlib.sha256(raw).hexdigest(), "session_closed_verified": True, **_FLAGS}


@dataclass(frozen=True, slots=True, repr=False)
class CapacityObservation:
    _safe_items: tuple
    _raw: bytes = field(repr=False)
    _target: str = field(repr=False)
    _dimensions: tuple = field(repr=False)
    _seal: object = field(repr=False)

    def _validate(self, budget):
        code = _current_code()
        if (type(self._seal) is not _IssuedSeal or self._seal._issuer is not _SEAL
                or self._seal._items is not self._safe_items
                or type(self._dimensions) is not tuple or len(self._dimensions) != 2):
            _fail("identity_invalid")
        kernel._native_frozen(self._safe_items)
        target = kernel.capture._origin(self._target)
        plan = _plan(*self._dimensions, budget)
        resource = hashlib.sha256(target.encode("ascii")).hexdigest()
        result = _interpret(self._raw, plan, target, resource, self._dimensions, budget)
        if not kernel._same_native(tuple(sorted(result.items())), self._safe_items):
            _fail("response_contract_invalid")
        if _current_code() != code:
            _fail("code_drift")
        budget.check()
        return result

    @property
    def safe_metadata(self):
        try:
            return self._validate(clean._Budget(MAX_SECONDS))
        except Exception as error:
            _closed(error)


def probe_clean_capacity_once(*, target_origin, token, expected_target_resource_sha256,
                              request_bytes, batch_steps, timeout_seconds=MAX_SECONDS, check=None):
    """One explicitly targeted SELECT-only carrier probe, never auto retry.

    The dimensional integers must come from the operator's frozen packet safe
    metadata. This helper does not accept or inspect that private packet.
    """
    try:
        budget = clean._Budget(timeout_seconds, check)
        budget.check()
        code = _current_code()
        target = physical._inputs(target_origin, token)
        if (type(expected_target_resource_sha256) is not str
                or not kernel._SHA.fullmatch(expected_target_resource_sha256)
                or hashlib.sha256(target.encode("ascii")).hexdigest() != expected_target_resource_sha256):
            _fail("identity_invalid")
        plan = _plan(request_bytes, batch_steps, budget)
        if _current_code() != code:
            _fail("code_drift")
        budget.check()
        raw = physical._exchange(target, token, plan.body, budget)
        budget.check()
        meta = _interpret(raw, plan, target, expected_target_resource_sha256, (request_bytes, batch_steps), budget)
        if _current_code() != code:
            _fail("code_drift")
        budget.check()
        items = tuple(sorted(meta.items()))
        result = CapacityObservation(items, raw, target, (request_bytes, batch_steps), _IssuedSeal(_SEAL, items))
        # Revalidate under this operation's ORIGINAL total deadline, not a new
        # network window. The public metadata getter remains pure local checks.
        result._validate(budget)
        budget.check()
        return result
    except Exception as error:
        _closed(error)
