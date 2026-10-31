"""Explicit single-request gzip capture of the original fixed read plan only.

This is not a generic SQL transport, migration sender or automatic fallback.
No CLI, environment credentials, retry, disk artifact or raised budget exists.
The original capture still validates typed/raw/image/lineage before returning
private RAM ownership. Safe stats are not backup or migration qualification.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
from pathlib import Path
import threading
import zlib

import requests

from database import turso_scope_snapshot as capture, turso_scope_transport as original
from database import turso_scope_upgrade as offline

MAX_BYTES = 64 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
MAX_SECONDS = 30.0
_PATH = Path(__file__).resolve()
_REASONS = frozenset({"invalid_arguments", "identity_invalid", "code_drift", "time_limit", "transport_used",
    "transport_failed", "http_authentication_rejected", "http_access_denied", "http_rate_limited",
    "http_unexpected_status", "response_type_invalid", "compressed_limit", "decoded_limit", "encoding_invalid",
    "gzip_invalid", "gzip_truncated", "gzip_trailing_data", "cleanup_failed", "capture_rejected"})
_REQUEST_ERRORS = {
    requests.exceptions.ConnectTimeout: "requests_connect_timeout",
    requests.exceptions.ReadTimeout: "requests_read_timeout",
    requests.exceptions.Timeout: "requests_timeout",
    requests.exceptions.SSLError: "requests_tls_error",
    requests.exceptions.ConnectionError: "requests_connection_error",
    requests.exceptions.ChunkedEncodingError: "requests_chunked_encoding_error",
    requests.exceptions.ContentDecodingError: "requests_content_decoding_error",
}


class CompressedCaptureError(Exception):
    def __init__(self, reason, http_status=None):
        self.reason = reason if type(reason) is str and reason in _REASONS else "transport_failed"
        self.http_status = http_status if type(http_status) is int and 100 <= http_status <= 599 else None
        super().__init__(self.reason)


def _fail(reason, http_status=None):
    raise CompressedCaptureError(reason, http_status)


def _digest():
    with _PATH.open("rb") as source:
        raw = source.read(1024 * 1024 + 1)
    if not 1 <= len(raw) <= 1024 * 1024:
        _fail("code_drift")
    return hashlib.sha256(raw).hexdigest()


_LOADED_SHA = _digest()


def _code():
    try:
        if _digest() != _LOADED_SHA:
            _fail("code_drift")
        return original._current_code(), _LOADED_SHA
    except Exception:
        _fail("code_drift")


def _inventory(operational_tables, optimizer_statistics):
    if (type(operational_tables) is not frozenset
            or any(type(name) is not str for name in operational_tables)
            or not operational_tables <= offline._OPERATIONAL_DEFINITIONS.keys()
            or type(optimizer_statistics) is not bool):
        _fail("invalid_arguments")


def _fixed_body(operational_tables, optimizer_statistics, deadline):
    """Only repository-owned native reference DDL and exact fixed read bytes."""
    reference = None
    try:
        budget = capture._Budget(deadline.end)
        deadline.remaining()
        reference = offline._source_reference("remote-schema-table", budget,
            operational_objects=operational_tables, optimizer_statistics=optimizer_statistics)
        body = offline._json_bytes(capture._plan(reference, "turso-fixed-read-v1")[0])
        deadline.remaining()
        return body
    finally:
        if reference is not None:
            reference.close()


def _safe_error(error):
    if type(error) is CompressedCaptureError:
        args = BaseException.args.__get__(error, BaseException)
        reason = (args[0] if type(args) is tuple and len(args) == 1 and type(args[0]) is str
                  and args[0] in _REASONS else "transport_failed")
        try:
            status = object.__getattribute__(error, "http_status")
        except AttributeError:
            status = None
        return reason, status if type(status) is int and 100 <= status <= 599 else None
    if type(error) is original.TransportError:
        args = BaseException.args.__get__(error, BaseException)
        reason = args[0] if type(args) is tuple and len(args) == 1 and type(args[0]) is str else None
        return (reason if reason in {"invalid_arguments", "identity_invalid", "code_drift", "time_limit", "transport_used"}
                else "transport_failed"), None
    return _REQUEST_ERRORS.get(type(error), "transport_failed"), None


class _Response:
    def __init__(self, owner):
        self._owner = owner
        self.status_code = 200
        self._used = False

    def iter_content(self, chunk_size=CHUNK_BYTES):
        owner = self._owner
        if self._used or owner._closed or type(chunk_size) is not int or not 1 <= chunk_size <= CHUNK_BYTES:
            _fail("transport_used")
        self._used = True
        owner._stats["phase"] = "stream"
        owner._stats["stream_started"] = True
        try:
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if owner._stats["encoding"] == "gzip" else None
            owner._budget.remaining()
            # requests.iter_content would auto-decompress. Explicit raw bytes
            # are mandatory so BOTH independent byte limits remain effective.
            owner._response.raw.decode_content = False
            for chunk in owner._response.raw.stream(CHUNK_BYTES, decode_content=False):
                owner._budget.remaining()
                if type(chunk) is not bytes or len(chunk) > CHUNK_BYTES:
                    _fail("response_type_invalid")
                if not chunk:
                    continue
                if len(chunk) > MAX_BYTES - owner._stats["compressed_bytes"]:
                    _fail("compressed_limit")
                owner._stats["compressed_bytes"] += len(chunk)
                if decoder is None:
                    if len(chunk) > MAX_BYTES - owner._stats["decoded_bytes"]:
                        _fail("decoded_limit")
                    owner._stats["decoded_bytes"] += len(chunk)
                    yield chunk
                    owner._budget.remaining()
                    continue
                if decoder.eof:
                    _fail("gzip_trailing_data")
                pending = chunk
                while True:
                    owner._budget.remaining()
                    remaining = MAX_BYTES - owner._stats["decoded_bytes"]
                    maximum = min(CHUNK_BYTES, remaining + 1)
                    before = pending
                    try:
                        decoded = decoder.decompress(pending, max_length=maximum)
                    except zlib.error:
                        _fail("gzip_invalid")
                    pending = decoder.unconsumed_tail
                    if decoder.unused_data:
                        _fail("gzip_trailing_data")
                    if len(decoded) > remaining:
                        _fail("decoded_limit")
                    if decoded:
                        owner._stats["decoded_bytes"] += len(decoded)
                        yield decoded
                        owner._budget.remaining()
                    if pending:
                        if pending == before and not decoded:
                            _fail("gzip_invalid")
                        continue
                    if not decoder.eof and len(decoded) == maximum:
                        # Drain only bounded buffered output, never flush().
                        pending = b""
                        continue
                    break
            owner._budget.remaining()
            if decoder is not None and not decoder.eof:
                _fail("gzip_truncated")
            if _code() != owner._bound_code:
                _fail("code_drift")
            owner._budget.remaining()
            owner._stats["stream_complete"] = True
        except Exception as error:
            reason, status = owner._record(error, "stream")
            try:
                owner.close()
            except CompressedCaptureError:
                pass
            raise CompressedCaptureError(reason, status) from None

    def close(self):
        self._owner._close_response()


class GzipFixedReadTransport:
    """Zero-I/O construction; one exact fixed-plan POST with explicit gzip."""
    def __init__(self, *, candidate_origin, token, operational_tables=frozenset(), optimizer_statistics=False):
        try:
            self._origin = original._inputs(candidate_origin, token)
        except Exception as error:
            reason, status = _safe_error(error)
            raise CompressedCaptureError(reason, status) from None
        _inventory(operational_tables, optimizer_statistics)
        self._token, self._operational, self._optimizer = token, operational_tables, optimizer_statistics
        self._lock = threading.Lock()
        self._used = self._closed = self._response_closed = self._session_closed = False
        self._session = self._response = self._budget = self._bound_code = None
        self._stats = {"schema": "turso-compressed-capture-1", "phase": "constructed", "encoding": None,
            "request_attempted": False, "stream_started": False, "stream_complete": False,
            "compressed_bytes": 0, "decoded_bytes": 0, "bytes_scope": "accepted_bounded_stream_prefix",
            "capture_succeeded": False, "primary": None,
            "cleanup": {"attempted": False, "failed": False, "reason": None}}

    def __repr__(self):
        return "<GzipFixedReadTransport>"

    def safe_stats(self):
        return deepcopy(self._stats)

    def _record(self, error, phase):
        reason, status = _safe_error(error)
        if self._stats["primary"] is None:
            self._stats["primary"] = {"phase": phase, "reason": reason, "http_status": status}
        return reason, status

    def send(self, *, url, headers, body, timeout_seconds, max_attempts, allow_redirects, stream):
        with self._lock:
            if self._used or self._closed:
                _fail("transport_used")
            self._used = True
        self._stats["phase"] = "send"
        try:
            self._budget = original._Deadline(timeout_seconds)
            if (type(url) is not str or url != self._origin + "/v3/pipeline"
                    or type(headers) is not dict or any(type(k) is not str or type(v) is not str for k, v in headers.items())
                    or headers != {"Authorization": "Bearer " + self._token, "Content-Type": "application/json"}
                    or type(body) is not bytes or not 1 <= len(body) <= MAX_BYTES
                    or type(max_attempts) is not int or max_attempts != 1 or allow_redirects is not False or stream is not True):
                _fail("invalid_arguments")
            self._bound_code = _code()
            if body != _fixed_body(self._operational, self._optimizer, self._budget):
                _fail("invalid_arguments")
            if _code() != self._bound_code:
                _fail("code_drift")
            self._budget.remaining()
            self._session = requests.Session()
            self._session.trust_env = False
            self._session.headers.clear()
            self._session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
            if _code() != self._bound_code:
                _fail("code_drift")
            remaining = self._budget.remaining()
            if self._closed:
                _fail("transport_used")
            self._stats["request_attempted"] = True
            self._response = self._session.post(self._origin + "/v3/pipeline", data=body,
                headers={**headers, "Accept-Encoding": "gzip"},
                timeout=(min(5.0, remaining), min(5.0, remaining)),
                allow_redirects=False, stream=True, verify=True)
            status = self._response.status_code
            if type(status) is not int or not 100 <= status <= 599:
                _fail("response_type_invalid")
            if status != 200:
                _fail({401: "http_authentication_rejected", 403: "http_access_denied",
                       429: "http_rate_limited"}.get(status, "http_unexpected_status"), status)
            encoding = self._response.headers.get("Content-Encoding")
            if encoding is None:
                encoding = "identity"
            elif type(encoding) is str:
                encoding = encoding.strip().lower()
            else:
                _fail("encoding_invalid")
            if encoding not in ("identity", "gzip"):
                _fail("encoding_invalid")
            self._stats["encoding"] = encoding
            self._budget.remaining()
            return _Response(self)
        except Exception as error:
            reason, status = self._record(error, "send")
            try:
                self.close()
            except CompressedCaptureError:
                pass
            raise CompressedCaptureError(reason, status) from None

    def _close_response(self):
        self._stats["cleanup"]["attempted"] = True
        if self._response is not None and not self._response_closed:
            self._response_closed = True
            try:
                self._response.close()
            except Exception:
                self._stats["cleanup"].update(failed=True, reason="cleanup_failed")
        if self._stats["cleanup"]["failed"]:
            _fail("cleanup_failed")

    def close(self):
        self._closed = True
        self._stats["phase"] = "close"
        try:
            self._close_response()
        except CompressedCaptureError:
            pass
        if self._session is not None and not self._session_closed:
            self._session_closed = True
            try:
                self._session.close()
            except Exception:
                self._stats["cleanup"].update(failed=True, reason="cleanup_failed")
        self._token = ""
        if self._stats["cleanup"]["failed"]:
            _fail("cleanup_failed")


class CompressedCaptureResult:
    def __init__(self, snapshot, stats):
        self.snapshot, self._stats = snapshot, stats

    def __repr__(self):
        return "<CompressedCaptureResult>"

    def safe_stats(self):
        return deepcopy(self._stats)


def capture_compressed_snapshot_once(*, candidate_origin, token, expected_resource_sha256,
        operational_tables=frozenset(), optimizer_statistics=False, timeout_seconds=MAX_SECONDS):
    """Operator-only, explicit resource-bound fixed-read-v1 RAM capture.

    Identity responses are accepted without a second request. A failed attempt
    never falls back, retries, writes a private file or supplies migration proof.
    """
    observed = GzipFixedReadTransport(candidate_origin=candidate_origin, token=token,
        operational_tables=operational_tables, optimizer_statistics=optimizer_statistics)
    snapshot = None
    try:
        if (type(expected_resource_sha256) is not str or not capture._SHA.fullmatch(expected_resource_sha256)
                or expected_resource_sha256 != hashlib.sha256(observed._origin.encode("ascii")).hexdigest()):
            _fail("identity_invalid")
        snapshot = capture.capture_scope_snapshot(candidate_origin=candidate_origin, token=token,
            transport=observed, expected_resource_sha256=expected_resource_sha256,
            operational_tables=operational_tables, optimizer_statistics=optimizer_statistics,
            query_mode_profile="turso-fixed-read-v1", timeout_seconds=timeout_seconds)
        observed._stats["capture_succeeded"] = True
    except Exception as error:
        if observed._stats["primary"] is None and not observed._stats["cleanup"]["failed"]:
            if type(error) in (CompressedCaptureError, original.TransportError):
                observed._record(error, "capture")
            else:
                observed._stats["primary"] = {"phase": "capture", "reason": "capture_rejected", "http_status": None}
    finally:
        try:
            observed.close()
        except Exception:
            try:
                if snapshot is not None:
                    try:
                        snapshot.close()
                    except Exception:
                        pass
            finally:
                snapshot = None
                observed._stats["capture_succeeded"] = False
                observed._stats["cleanup"].update(attempted=True, failed=True, reason="cleanup_failed")
    return CompressedCaptureResult(snapshot, observed.safe_stats())
