"""Opt-in safe diagnostics around the unchanged snapshot capture transport.

No CLI sender, credentials discovery, retry, altered timeout or provider error
text lives here. Only an explicit operator call can perform the original fixed
read capture. Diagnostics are observations, not migration/restore permission.
"""
from __future__ import annotations

from copy import deepcopy

import requests

from database import turso_scope_snapshot as capture
from database import turso_scope_transport as transport


SCHEMA = "turso-capture-diagnostics-1"
MAX_ERROR_NODES = 8
_REASONS = frozenset({
    "invalid_arguments", "identity_invalid", "code_drift", "time_limit", "transport_used",
    "transport_failed", "http_authentication_rejected", "http_access_denied", "http_rate_limited",
    "http_unexpected_status", "response_limit", "response_type_invalid", "cleanup_failed", "verification_failed",
})
_REQUEST_ERRORS = {
    requests.exceptions.ConnectTimeout: "requests_connect_timeout",
    requests.exceptions.ReadTimeout: "requests_read_timeout",
    requests.exceptions.Timeout: "requests_timeout",
    requests.exceptions.SSLError: "requests_tls_error",
    requests.exceptions.ProxyError: "requests_proxy_error",
    requests.exceptions.ConnectionError: "requests_connection_error",
    requests.exceptions.ChunkedEncodingError: "requests_chunked_encoding_error",
    requests.exceptions.ContentDecodingError: "requests_content_decoding_error",
    requests.exceptions.StreamConsumedError: "requests_stream_consumed",
    requests.exceptions.InvalidHeader: "requests_invalid_header",
    requests.exceptions.InvalidURL: "requests_invalid_url",
    requests.exceptions.InvalidSchema: "requests_invalid_schema",
    requests.exceptions.MissingSchema: "requests_missing_schema",
    requests.exceptions.TooManyRedirects: "requests_redirect_error",
    requests.exceptions.HTTPError: "requests_http_error",
    requests.exceptions.RequestException: "requests_error",
}


def _next_error(error):
    # Use native BaseException descriptors, not unknown subclass properties.
    cause = BaseException.__cause__.__get__(error, BaseException)
    return cause if cause is not None else BaseException.__context__.__get__(error, BaseException)


def _error_facts(error):
    """Inspect <=8 exception objects; never stringify or inspect request/body."""
    classified, unknown, cleanup, seen = [], False, False, set()
    current = error
    for _ in range(MAX_ERROR_NODES):
        if not isinstance(current, BaseException) or id(current) in seen:
            current = None
            break
        seen.add(id(current))
        if type(current) is transport.TransportError:
            arguments = BaseException.args.__get__(current, BaseException)
            reason = (arguments[0] if type(arguments) is tuple and len(arguments) == 1
                      and type(arguments[0]) is str and arguments[0] in _REASONS else "transport_failed")
            try:
                status = object.__getattribute__(current, "http_status")
            except AttributeError:
                status = None
            status = status if type(status) is int and 100 <= status <= 599 else None
            if reason == "cleanup_failed":
                cleanup = True
            else:
                classified.append({"reason": reason, "http_status": status})
        elif type(current) in _REQUEST_ERRORS:
            classified.append({"reason": _REQUEST_ERRORS[type(current)], "http_status": None})
        else:
            unknown = True
        current = _next_error(current)
        if current is None:
            break
    truncated = current is not None
    # A generic wrapper must not hide a known timeout/HTTP STOP in its chain.
    primary = next((item for item in classified if item["reason"] != "transport_failed"), None)
    if primary is None and classified:
        primary = classified[0]
    if primary is None and unknown:
        primary = {"reason": "unclassified_error", "http_status": None}
    return primary, cleanup, truncated


def offline_code_binding_check() -> dict:
    """Only check existing source bindings; never construct a Session/transport."""
    facts = {"schema": SCHEMA, "operation": "offline_code_binding_check", "network_attempted": False,
             "code_binding_matches": False, "primary": None}
    try:
        transport._current_code()
        facts["code_binding_matches"] = True
    except Exception as error:
        primary, _cleanup, truncated = _error_facts(error)
        facts["primary"] = {**(primary or {"reason": "unclassified_error", "http_status": None}),
                            "phase": "code_binding", "chain_truncated": truncated}
    return facts


class _DiagnosticResponse:
    def __init__(self, owner, response):
        self._owner, self._response = owner, response
        self.status_code = response.status_code

    def iter_content(self, chunk_size=transport.CHUNK_BYTES):
        owner = self._owner
        owner._facts["phase"] = "stream"
        owner._facts["stream_started"] = True
        try:
            for chunk in self._response.iter_content(chunk_size=chunk_size):
                # The underlying facade validates type, 64MiB and deadlines.
                if type(chunk) is bytes:
                    owner._facts["received_bytes"] += len(chunk)
                yield chunk
            owner._facts["stream_complete"] = True
        except Exception as error:
            owner._observe(error, "stream")
            raise

    def close(self):
        self._owner._facts["phase"] = "response_close"
        self._owner._facts["cleanup"]["attempted"] = True
        try:
            self._response.close()
        except Exception as error:
            self._owner._observe(error, "response_close", closing=True)
            raise


class DiagnosticSnapshotTransport:
    """Single-use original transport with non-sensitive, independent facts.

    Construction delegates only original input validation: no network or DB.
    Direct injection into capture preserves its original exception contract.
    Calling safe_facts() never accesses the retained transport or its secrets.
    """
    def __init__(self, *, candidate_origin, token):
        self._inner = transport.RequestsSnapshotTransport(candidate_origin=candidate_origin, token=token)
        self._facts = {
            "schema": SCHEMA, "phase": "constructed", "send_started": False, "send_returned": False,
            "stream_started": False, "stream_complete": False, "received_bytes": 0,
            "received_bytes_scope": "yielded_by_original_bounded_transport",
            "capture_succeeded": False, "primary": None,
            "cleanup": {"attempted": False, "failed": False, "reason": None, "chain_truncated": False},
        }

    def __repr__(self):
        return "<DiagnosticSnapshotTransport>"

    def safe_facts(self) -> dict:
        return deepcopy(self._facts)

    def _observe(self, error, phase, *, closing=False):
        primary, cleanup, truncated = _error_facts(error)
        # Original HTTP STOP handling deliberately keeps its primary status
        # when local close also fails. Read only the trusted adapter's native
        # boolean, never a response/request/provider field, to retain both.
        if (type(self._inner) is transport.RequestsSnapshotTransport
                and object.__getattribute__(self._inner, "_cleanup_failed") is True):
            cleanup = True
        if closing or cleanup:
            self._facts["cleanup"].update(attempted=True, failed=True,
                reason="cleanup_failed", chain_truncated=truncated)
        if not closing and primary is not None and self._facts["primary"] is None:
            self._facts["primary"] = {**primary, "phase": phase, "chain_truncated": truncated}

    def send(self, **parameters):
        self._facts["phase"] = "send"
        self._facts["send_started"] = True
        try:
            response = self._inner.send(**parameters)
            self._facts["send_returned"] = True
            return _DiagnosticResponse(self, response)
        except Exception as error:
            self._observe(error, "send")
            raise

    def close(self):
        self._facts["phase"] = "transport_close"
        self._facts["cleanup"]["attempted"] = True
        try:
            self._inner.close()
        except Exception as error:
            self._observe(error, "transport_close", closing=True)
            raise


class CaptureDiagnosticResult:
    """Private snapshot ownership plus detached safe facts; no raw exception."""
    def __init__(self, snapshot, facts):
        self.snapshot = snapshot
        self._facts = facts

    def __repr__(self):
        return "<CaptureDiagnosticResult>"

    def safe_facts(self) -> dict:
        return deepcopy(self._facts)


def capture_scope_snapshot_once(*, candidate_origin, token,
        operational_tables=frozenset(), optimizer_statistics=False,
        expected_resource_sha256=None, query_mode_profile="query-only-v1",
        timeout_seconds=capture.MAX_SECONDS) -> CaptureDiagnosticResult:
    """Explicit operator-only, one original fixed read capture, never a sender.

    A failed capture returns snapshot=None and closed safe diagnostics. It never
    retries, reads environment credentials or upgrades migration qualification.
    Successful private snapshot ownership transfers to the caller as before.
    """
    observed = DiagnosticSnapshotTransport(candidate_origin=candidate_origin, token=token)
    snapshot = None
    try:
        snapshot = capture.capture_scope_snapshot(candidate_origin=candidate_origin, token=token,
            transport=observed, operational_tables=operational_tables,
            optimizer_statistics=optimizer_statistics, expected_resource_sha256=expected_resource_sha256,
            query_mode_profile=query_mode_profile, timeout_seconds=timeout_seconds)
        observed._facts["capture_succeeded"] = True
    except Exception as error:
        if observed._facts["primary"] is None and not observed._facts["cleanup"]["failed"]:
            observed._observe(error, "capture")
    finally:
        try:
            observed.close()
        except Exception:
            try:
                if snapshot is not None:
                    try:
                        snapshot.close()
                    except Exception:
                        # Neither local cleanup exception is safe diagnostic
                        # text. Discard this rejected snapshot even if its
                        # own close failed; never return it as qualified.
                        pass
            finally:
                snapshot = None
                observed._facts["capture_succeeded"] = False
                observed._facts["cleanup"].update(attempted=True, failed=True, reason="cleanup_failed")
    return CaptureDiagnosticResult(snapshot, observed.safe_facts())
