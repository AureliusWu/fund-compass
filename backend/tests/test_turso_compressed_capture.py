"""Explicit gzip fixed-read tests: fake Session and owned memory, no network."""
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket

import pytest
import requests

from database import turso_scope_transport as original, turso_scope_upgrade as offline
from database import turso_scope_snapshot as capture
import turso_scope_packet_fixtures as fixture
from test_turso_scope_transport import FakeResponse, HTTPS, ORIGIN, TOKEN, execute_memory, network
from test_turso_capture_diagnostics import HostileError, SECRET

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "turso_compressed_capture.py"
SPEC = importlib.util.spec_from_file_location("turso_compressed_capture", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)
RESOURCE = hashlib.sha256(HTTPS.encode("ascii")).hexdigest()


class Raw:
    def __init__(self, chunks):
        self.chunks, self.calls, self.decode_content = chunks, [], True
    def stream(self, amount, *, decode_content):
        self.calls.append((amount, decode_content))
        assert amount == 64 * 1024 and decode_content is False and self.decode_content is False
        for chunk in self.chunks:
            if isinstance(chunk, Exception):
                raise chunk
            yield chunk


class Reply(FakeResponse):
    def __init__(self, body=b"{}", *, encoding=None, chunks=None, status=200, fail_close=False):
        super().__init__(body, status=status, fail_close=fail_close)
        self.headers = {} if encoding is None else {"Content-Encoding": encoding}
        self.raw = Raw(chunks if chunks is not None else [body[i:i + 65536] for i in range(0, len(body), 65536)])
    def iter_content(self, *_args, **_kwargs):
        pytest.fail("requests automatic decompression was used")


def transport(**options):
    return module.GzipFixedReadTransport(candidate_origin=ORIGIN, token=TOKEN, **options)


def options(**changes):
    result = dict(url=HTTPS + "/v3/pipeline", headers={"Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json"}, body=module._fixed_body(frozenset(), False, original._Deadline(30)),
        timeout_seconds=30.0, max_attempts=1, allow_redirects=False, stream=True)
    result.update(changes)
    return result


def stats(observed):
    result = observed.safe_stats()
    encoded = json.dumps(result, sort_keys=True, allow_nan=False)
    for secret in (SECRET, ORIGIN, HTTPS, TOKEN, "Bearer", "traceback"):
        assert secret not in encoded
    return result


def test_constructor_does_not_create_session_resolve_dns_compile_reference_or_read_environment(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("constructor performed I/O")
    for target, name in ((module.requests, "Session"), (offline, "_source_reference"), (os, "getenv"),
                         (socket, "socket"), (socket, "getaddrinfo"), (socket, "create_connection")):
        monkeypatch.setattr(target, name, forbidden)
    observed = transport()
    assert repr(observed) == "<GzipFixedReadTransport>" and stats(observed)["phase"] == "constructed"


@pytest.mark.parametrize("encoding", [None, "identity", "gzip", "GZip"])
def test_explicit_one_gzip_request_accepts_identity_without_any_fallback(network, encoding):
    plain = b"sample data" * 10000
    wire = gzip.compress(plain) if encoding and encoding.lower() == "gzip" else plain
    network.reply = Reply(wire, encoding=encoding)
    observed = transport()
    response = observed.send(**options())
    assert b"".join(response.iter_content()) == plain
    observed.close()
    result = stats(observed)
    assert result["compressed_bytes"] == len(wire) and result["decoded_bytes"] == len(plain)
    assert result["stream_complete"] and not result["cleanup"]["failed"]
    assert len(network.calls) == 1 and network.sessions[0].trust_env is False and network.sessions[0].headers == {}
    url, request = network.calls[0]
    assert url == HTTPS + "/v3/pipeline" and request["headers"] == {
        "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "Accept-Encoding": "gzip"}
    assert request["verify"] is True and request["allow_redirects"] is False and request["stream"] is True
    assert all(0 < seconds <= 5 for seconds in request["timeout"])
    assert network.sessions[0].mounts[0][1].max_retries.total == 0
    with pytest.raises(module.CompressedCaptureError):
        observed.send(**options())
    assert len(network.calls) == 1


def test_gzip_header_body_and_crc_split_at_every_byte_decode_incrementally(network):
    plain = bytes(range(256)) * 1000
    wire = gzip.compress(plain)
    network.reply = Reply(encoding="gzip", chunks=[wire[i:i + 1] for i in range(len(wire))])
    observed = transport()
    assert b"".join(observed.send(**options()).iter_content()) == plain
    observed.close()
    assert stats(observed)["decoded_bytes"] == len(plain)


@pytest.mark.parametrize("encoding", ["br", "deflate", "gzip, gzip", "gzip; x=1", "", False])
def test_only_identity_or_single_gzip_encoding_is_accepted_without_retry(network, encoding):
    network.reply = Reply(gzip.compress(b"{}"), encoding=encoding)
    observed = transport()
    with pytest.raises(module.CompressedCaptureError):
        observed.send(**options())
    assert stats(observed)["primary"]["reason"] == "encoding_invalid" and len(network.calls) == 1


@pytest.mark.parametrize("bad,reason", [
    (b"not gzip", "gzip_invalid"), (gzip.compress(b"data")[:-1], "gzip_truncated"),
    (gzip.compress(b"data") + b"x", "gzip_trailing_data"),
    (gzip.compress(b"data") + gzip.compress(b"more"), "gzip_trailing_data"),
])
def test_invalid_truncated_trailing_or_concatenated_gzip_rejects_whole_stream(network, bad, reason):
    network.reply = Reply(bad, encoding="gzip")
    observed = transport()
    with pytest.raises(module.CompressedCaptureError):
        b"".join(observed.send(**options()).iter_content())
    assert stats(observed)["primary"]["reason"] == reason and not stats(observed)["stream_complete"]
    assert len(network.calls) == 1 and network.sessions[0].closed == 1


def test_crc_failure_and_trailing_next_chunk_are_rejected(network):
    wire = bytearray(gzip.compress(b"data"))
    wire[-8] ^= 1
    for chunks, reason in (([bytes(wire)], "gzip_invalid"),
                           ([gzip.compress(b"data"), b"extra"], "gzip_trailing_data")):
        network.reply = Reply(encoding="gzip", chunks=chunks)
        observed = transport()
        with pytest.raises(module.CompressedCaptureError):
            b"".join(observed.send(**options()).iter_content())
        assert stats(observed)["primary"]["reason"] == reason


def test_bomb_uses_explicit_bounded_max_length_before_allocating_large_output(network, monkeypatch):
    network.reply = Reply(gzip.compress(b"x" * (64 * 1024)), encoding="gzip")
    observed = transport()
    response = observed.send(**options())
    original_factory = module.zlib.decompressobj
    maxima = []
    class Decoder:
        def __init__(self, *args): self.inner = original_factory(*args)
        def __getattr__(self, name): return getattr(self.inner, name)
        def decompress(self, data, *, max_length):
            maxima.append(max_length)
            return self.inner.decompress(data, max_length=max_length)
    monkeypatch.setattr(module, "MAX_BYTES", 1024)
    monkeypatch.setattr(module.zlib, "decompressobj", Decoder)
    with pytest.raises(module.CompressedCaptureError):
        list(response.iter_content())
    result = stats(observed)
    assert result["primary"]["reason"] == "decoded_limit"
    assert maxima and max(maxima) <= 1025 and result["decoded_bytes"] <= 1024


def test_compressed_and_identity_byte_limits_fail_before_accepting_oversize_prefix(network, monkeypatch):
    network.reply = Reply(chunks=[b"x" * 1024, b"y"])
    observed = transport()
    response = observed.send(**options())
    monkeypatch.setattr(module, "MAX_BYTES", 1024)
    with pytest.raises(module.CompressedCaptureError):
        list(response.iter_content())
    result = stats(observed)
    assert result["primary"]["reason"] == "compressed_limit"
    assert result["compressed_bytes"] == result["decoded_bytes"] == 1024


def test_exact_decoded_limit_allows_crc_footer_but_not_an_additional_output_byte(network, monkeypatch):
    network.reply = Reply(gzip.compress(b"x" * 4096), encoding="gzip")
    observed = transport()
    response = observed.send(**options())
    monkeypatch.setattr(module, "MAX_BYTES", 4096)
    assert b"".join(response.iter_content()) == b"x" * 4096
    assert stats(observed)["decoded_bytes"] == 4096 and stats(observed)["stream_complete"]
    observed.close()


@pytest.mark.parametrize("bad", [b"x" * (65536 + 1), bytearray(b"abc"), "secret body"],
                         ids=["oversize-chunk", "bytearray", "text"])
def test_raw_stream_type_and_chunk_size_are_bounded_before_accepting_bytes(network, bad):
    network.reply = Reply(chunks=[bad])
    observed = transport()
    with pytest.raises(module.CompressedCaptureError):
        list(observed.send(**options()).iter_content())
    result = stats(observed)
    assert result["primary"]["reason"] == "response_type_invalid"
    assert result["compressed_bytes"] == result["decoded_bytes"] == 0


@pytest.mark.parametrize("change", ["sql", "space", "query_only", "headers", "url", "redirect", "retry", "budget"])
def test_exact_repository_fixed_read_body_and_original_request_guards_precede_session(network, change):
    request = options()
    if change == "sql": request["body"] = b'{"sql":"DELETE FROM funds"}'
    if change == "space": request["body"] += b" "
    if change == "query_only":
        reference = offline._source_reference("remote-schema-table", offline._Budget(original._now() + 30))
        try: request["body"] = offline._json_bytes(capture._plan(reference, "query-only-v1")[0])
        finally: reference.close()
    if change == "headers": request["headers"]["Accept-Encoding"] = "gzip"
    if change == "url": request["url"] = "https://other.turso.io/v3/pipeline"
    if change == "redirect": request["allow_redirects"] = True
    if change == "retry": request["max_attempts"] = 2
    if change == "budget": request["timeout_seconds"] = 31
    observed = transport()
    with pytest.raises(module.CompressedCaptureError): observed.send(**request)
    assert network.calls == network.sessions == []


@pytest.mark.parametrize("status", [401, 403, 429, 503])
def test_http_stop_retains_native_status_when_both_cleanup_operations_fail(network, status):
    network.reply = Reply(status=status, fail_close=True)
    network.fail_close = True
    observed = transport()
    with pytest.raises(module.CompressedCaptureError): observed.send(**options())
    result = stats(observed)
    assert result["primary"]["http_status"] == status and result["cleanup"]["failed"]
    assert result["compressed_bytes"] == result["decoded_bytes"] == 0 and len(network.calls) == 1


def test_timeout_and_unknown_secret_exception_do_not_leak_or_retry(network):
    for error, reason in ((requests.exceptions.ReadTimeout(SECRET), "requests_read_timeout"),
                          (HostileError(SECRET), "transport_failed")):
        network.post_error = error
        observed = transport()
        with pytest.raises(module.CompressedCaptureError): observed.send(**options())
        assert stats(observed)["primary"]["reason"] == reason


def test_original_deadline_expiry_during_stream_keeps_primary_and_bounded_prefix(network, monkeypatch):
    network.reply = Reply(chunks=[b"abc", b"def"])
    observed = transport()
    response = observed.send(**options())
    iterator = response.iter_content()
    assert next(iterator) == b"abc"
    def expired(_self): raise original.TransportError("time_limit")
    monkeypatch.setattr(original._Deadline, "remaining", expired)
    with pytest.raises(module.CompressedCaptureError): next(iterator)
    assert stats(observed)["primary"]["reason"] == "time_limit" and stats(observed)["decoded_bytes"] == 3


def test_code_drift_during_session_configuration_prevents_post_and_closes_session(network, monkeypatch):
    codes = iter([("original",), ("original",), ("changed",)])
    monkeypatch.setattr(module, "_code", lambda: next(codes))
    observed = transport()
    with pytest.raises(module.CompressedCaptureError): observed.send(**options())
    assert stats(observed)["primary"]["reason"] == "code_drift"
    assert network.calls == [] and len(network.sessions) == 1 and network.sessions[0].closed == 1


def test_close_during_session_configuration_prevents_post(network, monkeypatch):
    observed = transport()
    def session_factory():
        session = network()
        original_mount = session.mount
        def mount(prefix, adapter):
            original_mount(prefix, adapter)
            observed.close()
        session.mount = mount
        return session
    monkeypatch.setattr(module.requests, "Session", session_factory)
    with pytest.raises(module.CompressedCaptureError): observed.send(**options())
    assert stats(observed)["primary"]["reason"] == "transport_used"
    assert network.calls == [] and len(network.sessions) == 1 and network.sessions[0].closed == 1


def test_unknown_stream_failure_keeps_safe_primary_and_independent_cleanup(network):
    network.reply = Reply(chunks=[b"abc", HostileError(SECRET)], fail_close=True)
    network.fail_close = True
    observed = transport()
    with pytest.raises(module.CompressedCaptureError): list(observed.send(**options()).iter_content())
    result = stats(observed)
    assert result["decoded_bytes"] == 3 and result["primary"]["reason"] == "transport_failed"
    assert result["primary"]["phase"] == "stream" and result["cleanup"]["failed"]


@pytest.mark.parametrize("compressed", [True, False])
def test_helper_uses_original_typed_image_lineage_capture_and_explicit_resource_binding(network, compressed):
    source = fixture.build_fixture()
    try:
        def reply(body):
            payload = execute_memory(source, body)
            return Reply(gzip.compress(payload) if compressed else payload, encoding="gzip" if compressed else None)
        network.reply = reply
        result = module.capture_compressed_snapshot_once(candidate_origin=ORIGIN, token=TOKEN,
            expected_resource_sha256=RESOURCE, operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS))
        try:
            assert result.snapshot is not None and stats(result)["capture_succeeded"]
            assert result.snapshot.safe_metadata["query_mode_profile"] == "turso-fixed-read-v1"
            assert result.snapshot.safe_metadata["remote_applied"] is False
            assert result.snapshot.safe_metadata["resource_sha256"] == RESOURCE
            assert len(network.calls) == 1 and network.sessions[0].closed == 1
            assert repr(result) == "<CompressedCaptureResult>"
        finally:
            if result.snapshot is not None: result.snapshot.close()
    finally: source.close()


def test_helper_rejects_wrong_sourcehash_and_unknown_optional_before_request(network):
    result = module.capture_compressed_snapshot_once(candidate_origin=ORIGIN, token=TOKEN, expected_resource_sha256="f" * 64)
    assert result.snapshot is None and stats(result)["primary"]["reason"] == "identity_invalid"
    assert network.calls == []
    with pytest.raises(module.CompressedCaptureError): transport(operational_tables=frozenset({SECRET}))
    assert network.calls == []


def test_failed_typed_validation_cannot_return_a_gzip_success_as_snapshot(network):
    network.reply = Reply(gzip.compress(b"{}"), encoding="gzip")
    result = module.capture_compressed_snapshot_once(candidate_origin=ORIGIN, token=TOKEN, expected_resource_sha256=RESOURCE)
    assert result.snapshot is None and stats(result)["capture_succeeded"] is False
    assert stats(result)["stream_complete"] and stats(result)["primary"]["reason"] == "capture_rejected"
    assert len(network.calls) == 1


def test_helper_double_close_failure_discards_private_snapshot_and_never_leaks_secret(network, monkeypatch, capsys):
    source = fixture.build_fixture()
    transport_close = module.GzipFixedReadTransport.close
    snapshot_close = capture.CapturedSnapshot.close
    calls, rejected = [], []
    def final_close(observed):
        calls.append(observed)
        if len(calls) == 2: raise HostileError(SECRET)
        return transport_close(observed)
    def failed_snapshot_close(snapshot):
        rejected.append(snapshot)
        raise HostileError(SECRET)
    monkeypatch.setattr(module.GzipFixedReadTransport, "close", final_close)
    monkeypatch.setattr(capture.CapturedSnapshot, "close", failed_snapshot_close)
    try:
        network.reply = lambda body: Reply(gzip.compress(execute_memory(source, body)), encoding="gzip")
        result = module.capture_compressed_snapshot_once(candidate_origin=ORIGIN, token=TOKEN,
            expected_resource_sha256=RESOURCE, operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS))
        summary = stats(result)
        assert result.snapshot is None and summary["capture_succeeded"] is False
        assert summary["cleanup"]["failed"] and summary["cleanup"]["reason"] == "cleanup_failed"
        assert len(calls) == 2 and len(rejected) == 1 and len(network.calls) == 1
        output = capsys.readouterr()
        assert output.out == output.err == ""
    finally:
        for snapshot in rejected: snapshot_close(snapshot)
        source.close()
