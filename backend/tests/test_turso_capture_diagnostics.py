"""Fake Session + owned memory only; diagnostics never discover credentials."""
import importlib.util
import json
import os
from pathlib import Path
import socket

import pytest
import requests

from database import turso_scope_snapshot as capture, turso_scope_transport as core
from database import turso_scope_upgrade as offline
import turso_scope_packet_fixtures as fixture
from test_turso_scope_transport import (
    FakeResponse, HTTPS, ORIGIN, TOKEN, execute_memory, network, raw_options,
)

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "turso_capture_diagnostics.py"
SPEC = importlib.util.spec_from_file_location("turso_capture_diagnostics", SCRIPT)
diagnostics = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(diagnostics)
SECRET = "never-print-private-token-url-body-request-response"


def transport():
    return diagnostics.DiagnosticSnapshotTransport(candidate_origin=ORIGIN, token=TOKEN)


def facts(value):
    result = value.safe_facts()
    encoded = json.dumps(result, allow_nan=False, sort_keys=True)
    assert SECRET not in encoded and TOKEN not in encoded and ORIGIN not in encoded and HTTPS not in encoded
    assert "traceback" not in encoded and "Bearer" not in encoded
    return result


def test_construction_and_offline_check_have_no_session_socket_or_environment(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("offline diagnostics attempted network or credential discovery")
    monkeypatch.setattr(core.requests, "Session", forbidden)
    for name in ("socket", "create_connection", "getaddrinfo"):
        monkeypatch.setattr(socket, name, forbidden)
    monkeypatch.setattr(os, "getenv", forbidden)
    observed = transport()
    assert repr(observed) == "<DiagnosticSnapshotTransport>"
    assert facts(observed)["phase"] == "constructed"
    result = diagnostics.offline_code_binding_check()
    assert result["code_binding_matches"] is True and result["network_attempted"] is False
    assert result["primary"] is None


def test_offline_code_drift_is_fixed_and_never_opens_session(monkeypatch):
    def drift():
        raise core.TransportError("code_drift")
    monkeypatch.setattr(core, "_current_code", drift)
    monkeypatch.setattr(core.requests, "Session", lambda: pytest.fail("drift opened Session"))
    result = diagnostics.offline_code_binding_check()
    assert result["code_binding_matches"] is False
    assert result["primary"] == {"reason": "code_drift", "http_status": None,
                                 "phase": "code_binding", "chain_truncated": False}


def test_forwarding_keeps_original_url_headers_timeout_limits_and_zero_retry(network):
    network.reply = FakeResponse(chunks=[b"abc", b"", b"defg"])
    observed = transport()
    response = observed.send(**raw_options())
    assert b"".join(response.iter_content(chunk_size=core.CHUNK_BYTES)) == b"abcdefg"
    observed.close()
    result = facts(observed)
    assert result["send_started"] and result["send_returned"]
    assert result["stream_started"] and result["stream_complete"] and result["received_bytes"] == 7
    assert result["primary"] is None and result["cleanup"] == {
        "attempted": True, "failed": False, "reason": None, "chain_truncated": False}
    url, options = network.calls[0]
    assert url == HTTPS + "/v3/pipeline"
    assert options["headers"] == {"Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json", "Accept-Encoding": "identity"}
    assert all(0 < seconds <= 5.0 for seconds in options["timeout"])
    assert options["verify"] is True and options["stream"] is True and options["allow_redirects"] is False
    assert network.sessions[0].mounts[0][1].max_retries.total == 0
    with pytest.raises(core.TransportError):
        observed.send(**raw_options())
    assert len(network.calls) == 1


@pytest.mark.parametrize("exception,reason", [
    (requests.exceptions.ConnectTimeout(SECRET), "requests_connect_timeout"),
    (requests.exceptions.ReadTimeout(SECRET), "requests_read_timeout"),
    (requests.exceptions.SSLError(SECRET), "requests_tls_error"),
    (requests.exceptions.ConnectionError(SECRET), "requests_connection_error"),
])
def test_send_exception_uses_exact_known_class_without_provider_text(network, exception, reason):
    network.post_error = exception
    observed = transport()
    with pytest.raises(core.TransportError):
        observed.send(**raw_options())
    result = facts(observed)
    assert result["primary"] == {"reason": reason, "http_status": None,
                                 "phase": "send", "chain_truncated": False}
    assert result["received_bytes"] == 0 and result["send_returned"] is False
    assert len(network.calls) == 1


def test_stream_timeout_keeps_received_bytes_and_primary_when_cleanup_also_fails(network):
    network.reply = FakeResponse(chunks=[b"abcde", requests.exceptions.ReadTimeout(SECRET)], fail_close=True)
    network.fail_close = True
    observed = transport()
    response = observed.send(**raw_options())
    with pytest.raises(core.TransportError):
        list(response.iter_content(chunk_size=core.CHUNK_BYTES))
    result = facts(observed)
    assert result["received_bytes"] == 5 and result["stream_complete"] is False
    assert result["primary"]["reason"] == "requests_read_timeout"
    assert result["primary"]["phase"] == "stream"
    assert result["cleanup"]["failed"] is True and result["cleanup"]["reason"] == "cleanup_failed"


@pytest.mark.parametrize("status,reason", [(401, "http_authentication_rejected"),
    (403, "http_access_denied"), (429, "http_rate_limited"), (503, "http_unexpected_status")])
def test_native_http_stop_and_cleanup_are_independent_facts(network, status, reason):
    network.reply = FakeResponse(status=status, fail_close=True)
    network.fail_close = True
    observed = transport()
    with pytest.raises(core.TransportError):
        observed.send(**raw_options())
    result = facts(observed)
    assert result["primary"]["reason"] == reason and result["primary"]["http_status"] == status
    assert result["cleanup"]["failed"] is True and len(network.calls) == 1


def test_cleanup_only_failure_never_replaces_or_fabricates_a_primary_error(network):
    observed = transport()
    response = observed.send(**raw_options())
    assert b"".join(response.iter_content()) == b"{}"
    network.fail_close = True
    with pytest.raises(core.TransportError):
        observed.close()
    result = facts(observed)
    assert result["primary"] is None and result["cleanup"]["failed"] is True


class HostileError(Exception):
    def __str__(self):
        raise AssertionError("stringified unknown secret exception")
    def __repr__(self):
        raise AssertionError("repr of unknown secret exception")
    def __getattribute__(self, name):
        if name in {"request", "response", "args", "__cause__", "__context__", "__traceback__"}:
            raise AssertionError("read unknown exception field")
        return super().__getattribute__(name)


def test_unknown_and_subclass_exceptions_never_use_text_or_arbitrary_fields(network, capsys):
    class UntrustedTimeout(requests.exceptions.ReadTimeout):
        def __str__(self):
            raise AssertionError("stringified untrusted timeout subclass")
    for error in (HostileError(SECRET), UntrustedTimeout(SECRET)):
        network.post_error = error
        observed = transport()
        with pytest.raises(core.TransportError):
            observed.send(**raw_options())
        result = facts(observed)
        assert result["primary"]["reason"] == "transport_failed"
    output = capsys.readouterr()
    assert output.out == output.err == ""


def test_only_exact_transport_type_fixed_reason_and_native_http_are_classified():
    class UntrustedTransportError(core.TransportError):
        def __str__(self):
            raise AssertionError("stringified untrusted transport subclass")
    untrusted = transport()
    untrusted._observe(UntrustedTransportError("code_drift", 401), "send")
    assert facts(untrusted)["primary"]["reason"] == "unclassified_error"
    assert facts(untrusted)["primary"]["http_status"] is None
    altered = core.TransportError("transport_failed")
    altered.args = (SECRET,)
    altered.http_status = True
    observed = transport()
    observed._observe(altered, "send")
    assert facts(observed)["primary"]["reason"] == "transport_failed"
    assert facts(observed)["primary"]["http_status"] is None


def test_exception_chain_has_eight_node_ceiling_and_handles_cycles():
    chain = [HostileError(SECRET) for _ in range(9)]
    chain.append(core.TransportError("code_drift"))
    for before, after in zip(chain, chain[1:]):
        before.__cause__ = after
    observed = transport()
    observed._observe(chain[0], "send")
    result = facts(observed)
    assert result["primary"]["reason"] == "unclassified_error"
    assert result["primary"]["chain_truncated"] is True
    chain[0].__cause__ = chain[0]
    cycle = transport()
    cycle._observe(chain[0], "send")
    assert facts(cycle)["primary"]["reason"] == "unclassified_error"


@pytest.mark.parametrize("mutation", ["url", "headers", "redirect", "attempts", "deadline", "size"])
def test_original_validation_limits_remain_closed_before_post(network, mutation):
    options = raw_options()
    if mutation == "url": options["url"] = "https://other.turso.io/v3/pipeline"
    if mutation == "headers": options["headers"] = {"Authorization": "Bearer " + SECRET}
    if mutation == "redirect": options["allow_redirects"] = True
    if mutation == "attempts": options["max_attempts"] = 2
    if mutation == "deadline": options["timeout_seconds"] = 31
    if mutation == "size": options["body"] = b"x" * (core.MAX_BYTES + 1)
    observed = transport()
    with pytest.raises(core.TransportError):
        observed.send(**options)
    assert network.calls == []
    assert facts(observed)["received_bytes"] == 0


def test_expired_send_budget_and_code_drift_are_fixed_pre_network_facts(network, monkeypatch):
    def expired(_self):
        raise core.TransportError("time_limit")
    monkeypatch.setattr(core._Deadline, "remaining", expired)
    observed = transport()
    with pytest.raises(core.TransportError):
        observed.send(**raw_options())
    assert facts(observed)["primary"]["reason"] == "time_limit" and network.calls == []


def test_send_code_drift_preserves_phase_and_zero_post(network, monkeypatch):
    def drift():
        raise core.TransportError("code_drift")
    monkeypatch.setattr(core, "_current_code", drift)
    observed = transport()
    with pytest.raises(core.TransportError):
        observed.send(**raw_options())
    result = facts(observed)
    assert result["primary"]["reason"] == "code_drift" and result["primary"]["phase"] == "send"
    assert result["received_bytes"] == 0 and network.calls == network.sessions == []


def test_single_operator_capture_keeps_private_success_and_same_fixed_plan(network):
    source = fixture.build_fixture()
    try:
        network.reply = lambda body: FakeResponse(execute_memory(source, body))
        result = diagnostics.capture_scope_snapshot_once(candidate_origin=ORIGIN, token=TOKEN,
            operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS), query_mode_profile="turso-fixed-read-v1")
        try:
            assert result.snapshot is not None
            assert result.snapshot.safe_metadata["remote_applied"] is False
            summary = facts(result)
            assert summary["capture_succeeded"] and summary["received_bytes"] > 0
            assert len(network.calls) == 1 and network.sessions[0].closed == 1
            assert repr(result) == "<CaptureDiagnosticResult>"
        finally:
            if result.snapshot is not None:
                result.snapshot.close()
    finally:
        source.close()


def test_failed_capture_does_not_mask_send_primary_with_capture_or_cleanup(network):
    network.post_error = requests.exceptions.ReadTimeout(SECRET)
    network.fail_close = True
    result = diagnostics.capture_scope_snapshot_once(candidate_origin=ORIGIN, token=TOKEN)
    summary = facts(result)
    assert result.snapshot is None and summary["capture_succeeded"] is False
    assert summary["primary"]["reason"] == "requests_read_timeout"
    assert summary["cleanup"]["failed"] is True and len(network.calls) == 1
    summary["primary"]["reason"] = SECRET
    assert facts(result)["primary"]["reason"] == "requests_read_timeout"  # detached copy


def test_invalid_capture_budget_closes_without_network_or_retry(network):
    result = diagnostics.capture_scope_snapshot_once(candidate_origin=ORIGIN, token=TOKEN, timeout_seconds=31)
    summary = facts(result)
    assert result.snapshot is None and summary["primary"]["phase"] == "capture"
    assert summary["cleanup"]["attempted"] is True and network.calls == []


def test_operator_double_close_failure_clears_snapshot_and_qualification_without_secret_error(network, monkeypatch, capsys):
    source = fixture.build_fixture()
    original_transport_close = diagnostics.DiagnosticSnapshotTransport.close
    original_snapshot_close = capture.CapturedSnapshot.close
    close_calls, rejected = [], []

    def fail_final_transport_close(observed):
        close_calls.append(observed)
        if len(close_calls) == 2:
            raise HostileError(SECRET)
        return original_transport_close(observed)

    def fail_snapshot_close(snapshot):
        rejected.append(snapshot)
        raise HostileError(SECRET)

    monkeypatch.setattr(diagnostics.DiagnosticSnapshotTransport, "close", fail_final_transport_close)
    monkeypatch.setattr(capture.CapturedSnapshot, "close", fail_snapshot_close)
    try:
        network.reply = lambda body: FakeResponse(execute_memory(source, body))
        result = diagnostics.capture_scope_snapshot_once(candidate_origin=ORIGIN, token=TOKEN,
            operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS), query_mode_profile="turso-fixed-read-v1")
        summary = facts(result)
        assert len(close_calls) == 2 and len(rejected) == 1
        assert result.snapshot is None and summary["capture_succeeded"] is False
        assert summary["primary"] is None
        assert summary["cleanup"]["attempted"] is True and summary["cleanup"]["failed"] is True
        assert summary["cleanup"]["reason"] == "cleanup_failed"
        output = capsys.readouterr()
        assert output.out == output.err == ""
        assert len(network.calls) == 1
    finally:
        for snapshot in rejected:
            original_snapshot_close(snapshot)
        source.close()
