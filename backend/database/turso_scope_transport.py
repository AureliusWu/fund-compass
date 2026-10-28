"""Explicit, one-POST physical transport; never an apply authorization gate.

Unlike the pure contract modules, these functions can really send SQL. Only a
controlled operator may call send_packet_once after independently establishing
current write quiescence, provider capacity and a fresh protected backup. There
is no CLI, production route, credential discovery, retry or implicit follow-up.
Existing contract verdicts retain their false remote/durability/release flags.

Deadlines are cooperative, with bounded connect/read socket timeouts. requests
cannot preempt DNS or every native blocking operation; an external supervisor
is still required. Killing a sender does not establish the remote outcome.
"""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import threading
import time

import requests

from database import turso_scope_packet as compiler, turso_scope_response as parser
from database import turso_scope_reconcile as reconcile, turso_scope_snapshot as capture

MAX_SECONDS = 30.0
MAX_BYTES = 64 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
CONNECT_SECONDS = 5.0
READ_SECONDS = 5.0
_OWN_PATH = Path(__file__).resolve()
_REASONS = frozenset({'invalid_arguments', 'identity_invalid', 'code_drift',
    'time_limit', 'transport_used', 'transport_failed', 'http_authentication_rejected',
    'http_access_denied', 'http_rate_limited', 'http_unexpected_status',
    'response_limit', 'response_type_invalid', 'cleanup_failed', 'verification_failed'})


class TransportError(Exception):
    """Fixed diagnostic only. Every failure has unknown outcome and no retry."""
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
    try:
        if _own_digest() != _LOADED_OWN_SHA:
            _fail('code_drift')
        return (_LOADED_OWN_SHA, reconcile._current_code())
    except Exception:
        _fail('code_drift')


def _now():
    try:
        value = time.monotonic()
        if type(value) not in (int, float) or not math.isfinite(value):
            _fail('time_limit')
        return value
    except Exception:
        _fail('time_limit')


class _Deadline:
    def __init__(self, seconds):
        if (type(seconds) not in (int, float) or not math.isfinite(seconds)
                or not 0 < seconds <= MAX_SECONDS):
            _fail('invalid_arguments')
        self.last = _now()
        self.end = self.last + seconds

    def remaining(self):
        now = _now()
        if now < self.last or now >= self.end:
            _fail('time_limit')
        self.last = now
        return self.end - now


def _inputs(candidate_origin, token):
    try:
        origin = capture._origin(candidate_origin)
    except Exception:
        _fail('identity_invalid')
    if (type(token) is not str or not 1 <= len(token) <= 8192 or not token.isascii()
            or any(ord(char) < 33 or ord(char) > 126 for char in token)):
        _fail('invalid_arguments')
    return origin


def _bound(candidate_origin, token, resource, plan, packet):
    origin = _inputs(candidate_origin, token)
    if any(type(value) is not str or not compiler._SHA.fullmatch(value)
           for value in (resource, plan, packet)):
        _fail('identity_invalid')
    if hashlib.sha256(origin.encode('ascii')).hexdigest() != resource:
        _fail('identity_invalid')
    return origin


def _preflight_error(error):
    if type(error) is TransportError:
        return error
    if type(error) is compiler.CompilerError:
        reason = {'compiler_code_drift': 'code_drift', 'compile_time_limit': 'time_limit'}.get(str(error), 'identity_invalid')
    elif type(error) is reconcile.ReconcileError:
        reason = {'code_drift': 'code_drift', 'time_limit': 'time_limit'}.get(str(error), 'identity_invalid')
    else:
        reason = 'verification_failed'
    return TransportError(reason)


class _BoundedResponse:
    """Streaming facade only, not a statement/commit/session certificate."""
    def __init__(self, owner, status):
        self._owner = owner
        self.status_code = status
        self._iterated = False

    def iter_content(self, chunk_size=CHUNK_BYTES):
        if (self._iterated or type(chunk_size) is not int or not 1 <= chunk_size <= CHUNK_BYTES
                or self._owner._closed or self._owner._response_closed):
            _fail('transport_used')
        self._iterated = True
        total = 0
        try:
            self._owner._budget.remaining()
            for chunk in self._owner._response.iter_content(chunk_size=CHUNK_BYTES):
                self._owner._budget.remaining()
                if type(chunk) is not bytes:
                    _fail('response_type_invalid')
                total += len(chunk)
                if total > MAX_BYTES:
                    _fail('response_limit')
                yield chunk
                self._owner._budget.remaining()
            self._owner._budget.remaining()
            if _current_code() != self._owner._code:
                _fail('code_drift')
            self._owner._budget.remaining()
        except Exception as error:
            failure = error if type(error) is TransportError else TransportError('transport_failed')
            try:
                self._owner.close()
            except TransportError:
                failure = TransportError('cleanup_failed')
            raise failure from None

    def close(self):
        self._owner._close_response()


class RequestsSnapshotTransport:
    """Concrete SnapshotTransport: one use, one POST, explicit origin/token.

    This raw adapter cannot authorize migration. A caller supplies the body;
    capture supplies its fixed read plan. Do not expose it as a production API.
    """
    def __init__(self, *, candidate_origin, token):
        self._origin = _inputs(candidate_origin, token)
        self._token = token
        self._lock = threading.Lock()
        self._used = self._closed = self._response_closed = self._session_closed = False
        self._cleanup_failed = False
        self._session = self._response = self._budget = self._code = None

    def send(self, *, url, headers, body, timeout_seconds,
             max_attempts, allow_redirects, stream):
        with self._lock:
            if self._used or self._closed:
                _fail('transport_used')
            self._used = True
        try:
            self._budget = _Deadline(timeout_seconds)
            if (type(url) is not str or url != self._origin + '/v3/pipeline'
                    or type(headers) is not dict
                    or any(type(key) is not str or type(value) is not str for key, value in headers.items())
                    or headers != {'Authorization': 'Bearer ' + self._token, 'Content-Type': 'application/json'}
                    or type(body) is not bytes or not 1 <= len(body) <= MAX_BYTES
                    or type(max_attempts) is not int or max_attempts != 1
                    or allow_redirects is not False or stream is not True):
                _fail('invalid_arguments')
            self._code = _current_code()
            self._budget.remaining()
            self._session = requests.Session()
            self._session.trust_env = False  # No ambient proxy, netrc or CA override.
            self._session.headers.clear()
            self._session.mount('https://', requests.adapters.HTTPAdapter(max_retries=0))
            if _current_code() != self._code:
                _fail('code_drift')
            remaining = self._budget.remaining()
            if self._closed:
                _fail('transport_used')
            self._response = self._session.post(self._origin + '/v3/pipeline',
                data=body, headers={**headers, 'Accept-Encoding': 'identity'},
                timeout=(min(CONNECT_SECONDS, remaining), min(READ_SECONDS, remaining)),
                allow_redirects=False, stream=True, verify=True)
            status = self._response.status_code
            if type(status) is not int or not 100 <= status <= 599:
                _fail('response_type_invalid')
            if status != 200:
                reason = {401: 'http_authentication_rejected', 403: 'http_access_denied',
                          429: 'http_rate_limited'}.get(status, 'http_unexpected_status')
                _fail(reason, status)
            self._budget.remaining()
            return _BoundedResponse(self, status)
        except Exception as error:
            failure = error if type(error) is TransportError else TransportError('transport_failed')
            try:
                self.close()
            except TransportError:
                # Keep an observed HTTP STOP; it remains unknown, never success.
                if failure.http_status is None:
                    failure = TransportError('cleanup_failed')
            raise failure from None

    def _close_response(self):
        if self._response is not None and not self._response_closed:
            self._response_closed = True
            try:
                self._response.close()
            except Exception:
                self._cleanup_failed = True
        if self._cleanup_failed:
            _fail('cleanup_failed')

    def close(self):
        self._closed = True
        try:
            self._close_response()
        except TransportError:
            pass
        if self._session is not None and not self._session_closed:
            self._session_closed = True
            try:
                self._session.close()  # Local sockets only; never an SQL close POST.
            except Exception:
                self._cleanup_failed = True
        self._token = ''
        if self._cleanup_failed:
            _fail('cleanup_failed')


def _exchange(origin, token, body, budget):
    transport = RequestsSnapshotTransport(candidate_origin=origin, token=token)
    failure = None
    raw = bytearray()
    try:
        response = transport.send(url=origin + '/v3/pipeline',
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
            body=body, timeout_seconds=budget.remaining(),
            max_attempts=1, allow_redirects=False, stream=True)
        for chunk in response.iter_content(chunk_size=CHUNK_BYTES):
            budget.remaining()
            if len(raw) + len(chunk) > MAX_BYTES:
                _fail('response_limit')
            raw.extend(chunk)
        budget.remaining()
    except Exception as error:
        failure = error if type(error) is TransportError else TransportError('transport_failed')
    finally:
        try:
            transport.close()
        except TransportError:
            if failure is None or failure.http_status is None:
                failure = TransportError('cleanup_failed')
    if failure is not None:
        raise failure from None
    budget.remaining()
    return bytes(raw)


def send_packet_once(snapshot, artifact, *, candidate_origin, token,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256,
        timeout_seconds=MAX_SECONDS):
    """Really send one original-bound packet; NOT operational apply permission.

    The controlled caller must first establish live stop-write/capacity/new-backup
    gates. This function does not claim to know them, and is not a default route.
    Any exception after attempting transport means unknown; never retry it.
    """
    try:
        budget = _Deadline(timeout_seconds)
        origin = _bound(candidate_origin, token, expected_resource_sha256,
                        expected_plan_sha256, expected_packet_sha256)
        code = _current_code()
        budget.remaining()
        packet = compiler.rehydrate_packet(snapshot, artifact,
            expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256, expected_packet_sha256=expected_packet_sha256)
        budget.remaining()
        if _current_code() != code:
            _fail('code_drift')
        budget.remaining()
    except Exception as error:
        raise _preflight_error(error) from None
    raw = _exchange(origin, token, packet.body, budget)
    try:
        result = parser.verify_scope_response(snapshot, artifact, raw, candidate_origin=origin,
            expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256, expected_packet_sha256=expected_packet_sha256)
        budget.remaining()
        if _current_code() != code:
            _fail('code_drift')
        budget.remaining()
        return result
    except Exception as error:
        raise _preflight_error(error) from None


def read_reconcile_once(snapshot, artifact, *, candidate_origin, token,
        expected_resource_sha256, expected_plan_sha256, expected_packet_sha256,
        read_schema, timeout_seconds=MAX_SECONDS):
    """One explicit fixed read, never an automatic follow-up/replay of a write."""
    try:
        budget = _Deadline(timeout_seconds)
        origin = _bound(candidate_origin, token, expected_resource_sha256,
                        expected_plan_sha256, expected_packet_sha256)
        code = _current_code()
        budget.remaining()
        body = reconcile.build_scope_reconcile_read(snapshot, artifact, candidate_origin=origin,
            expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256, expected_packet_sha256=expected_packet_sha256,
            read_schema=read_schema)
        budget.remaining()
        if _current_code() != code:
            _fail('code_drift')
        budget.remaining()
    except Exception as error:
        raise _preflight_error(error) from None
    raw = _exchange(origin, token, body, budget)
    try:
        result = reconcile.verify_scope_reconcile_read(snapshot, artifact, raw, candidate_origin=origin,
            expected_resource_sha256=expected_resource_sha256,
            expected_plan_sha256=expected_plan_sha256, expected_packet_sha256=expected_packet_sha256,
            read_schema=read_schema)
        budget.remaining()
        if _current_code() != code:
            _fail('code_drift')
        budget.remaining()
        return result
    except Exception as error:
        raise _preflight_error(error) from None
