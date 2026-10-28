"""Explicit one-POST repair/scope/Owner transport, not apply authorization.

This module really can send the separately compiled Owner upgrade packet.
The controlled operator must first independently establish actual writer pause
and drain, provider/transaction capacity, and a fresh protected backup. There
is no startup route, CLI, credential discovery, retry or automatic follow-up.
Local parsing and Session.close do not establish remote commit or durability.

The shared physical adapter enforces TLS, exact bytes, no ambient credentials,
no redirects/retries, bounded streaming and cleanup. The total deadline here
also covers recompilation and verdict checks. It is cooperative, not a hard
process deadline; an external supervisor is still necessary.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from database import turso_owner_upgrade_packet as compiler
from database import turso_owner_upgrade_response as parser
from database import turso_owner_upgrade_reconcile as reconcile
from database import turso_scope_transport as http

MAX_SECONDS = http.MAX_SECONDS
_OWN_PATH = Path(__file__).resolve()
_REASONS = frozenset({'invalid_arguments', 'identity_invalid', 'code_drift',
    'time_limit', 'transport_used', 'transport_failed', 'http_authentication_rejected',
    'http_access_denied', 'http_rate_limited', 'http_unexpected_status',
    'response_limit', 'response_type_invalid', 'cleanup_failed', 'verification_failed'})


class TransportError(Exception):
    """Closed diagnostics only; every failure is unknown and never retryable."""
    def __init__(self, reason, http_status=None):
        reason = reason if type(reason) is str and reason in _REASONS else 'transport_failed'
        self.http_status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
        self.outcome = 'unknown'
        super().__init__(reason)


def _fail(reason, http_status=None):
    raise TransportError(reason, http_status)


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
    """Pin the new profile and the unchanged shared HTTP/pure-engine chain."""
    try:
        if _own_digest() != _LOADED_OWN_SHA:
            _fail('code_drift')
        return (_LOADED_OWN_SHA, compiler._current_code(),
                parser._current_verifier_code(), reconcile._current_code(),
                http._current_code())
    except Exception:
        _fail('code_drift')


def _closed_error(error):
    if type(error) is TransportError:
        return error
    if type(error) is http.TransportError:
        return TransportError(str(error), error.http_status)
    if type(error) is compiler.CompilerError:
        reason = {'compiler_code_drift': 'code_drift',
                  'compile_time_limit': 'time_limit'}.get(str(error), 'identity_invalid')
    elif type(error) is reconcile.ReconcileError:
        reason = {'code_drift': 'code_drift', 'time_limit': 'time_limit'}.get(str(error), 'identity_invalid')
    elif type(error) is parser.VerifierError:
        reason = {'code_drift': 'code_drift', 'response_time_limit': 'time_limit',
                  'time_limit': 'time_limit'}.get(str(error), 'verification_failed')
    else:
        reason = 'verification_failed'
    return TransportError(reason)


def _check_final(budget, code):
    budget.remaining()
    if _current_code() != code:
        _fail('code_drift')
    budget.remaining()


def send_owner_upgrade_packet_once(snapshot, artifact, *, candidate_origin, token,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256,
        timeout_seconds=MAX_SECONDS):
    """Send exactly one externally bound Owner packet, never authorize apply.

    Actual stop-write, capacity and protected-backup gates belong to the
    controlled caller. A failure after POST is unknown, never replay authority.
    The old scope-only sender and response profile are not reused or widened.
    """
    try:
        budget = http._Deadline(timeout_seconds)
        origin = http._bound(candidate_origin, token, expected_resource_sha256,
                             expected_plan_sha256, expected_packet_sha256)
        code = _current_code()
        budget.remaining()
        packet = compiler.rehydrate_packet(snapshot, artifact,
            expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256)
        _check_final(budget, code)
        raw = http._exchange(origin, token, packet.body, budget)
        # A changed new-profile source during physical streaming must not be
        # presented to a verifier as a stable successful contract.
        _check_final(budget, code)
        result = parser.verify_owner_upgrade_response(snapshot, artifact, raw,
            candidate_origin=origin, expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256)
        _check_final(budget, code)
        return result
    except Exception as error:
        raise _closed_error(error) from None


def read_owner_upgrade_reconcile_once(snapshot, artifact, *, candidate_origin, token,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256,
        read_schema, timeout_seconds=MAX_SECONDS):
    """Send one explicit fixed read; never follow a write or resend on its own."""
    try:
        budget = http._Deadline(timeout_seconds)
        origin = http._bound(candidate_origin, token, expected_resource_sha256,
                             expected_plan_sha256, expected_packet_sha256)
        code = _current_code()
        budget.remaining()
        body = reconcile.build_owner_upgrade_reconcile_read(snapshot, artifact,
            candidate_origin=origin, expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256, read_schema=read_schema)
        _check_final(budget, code)
        raw = http._exchange(origin, token, body, budget)
        _check_final(budget, code)
        result = reconcile.verify_owner_upgrade_reconcile_read(snapshot, artifact, raw,
            candidate_origin=origin, expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256,
            expected_packet_sha256=expected_packet_sha256, read_schema=read_schema)
        _check_final(budget, code)
        return result
    except Exception as error:
        raise _closed_error(error) from None
