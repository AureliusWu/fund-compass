"""FakeSession + synthetic memory only, not actual TLS/cloud/apply evidence."""
import builtins
from copy import deepcopy
import io
import os
from pathlib import Path
import socket
import sqlite3

import pytest

from database import db, exact_real, owner_sync_schema, turso_projection_repair
from database import turso_owner_upgrade_packet as compiler
from database import turso_owner_upgrade_response as parser
from database import turso_owner_upgrade_reconcile as reconcile
from database import turso_owner_upgrade_transport as v
from database import turso_scope_packet as strict, turso_scope_response as old_parser
from database import turso_scope_reconcile as old_reconcile, turso_scope_transport as http
from database import turso_scope_upgrade as offline
import test_turso_owner_upgrade_packet as owner_fixtures
import turso_scope_packet_fixtures as s
from test_turso_scope_transport import (FakeResponse, SessionFactory, execute_memory,
    assert_closed, assert_request, forbidden, ORIGIN, TOKEN, PRIVATE)


@pytest.fixture
def call(monkeypatch):
    """Only the finite repository source files and SQLite :memory: may be read."""
    allowed = frozenset([*(path for _, path in strict._CODE_FILES),
        *(Path(module.__file__).resolve() for module in
          (compiler, parser, reconcile, v, old_parser, old_reconcile, http,
           exact_real, owner_sync_schema, turso_projection_repair))])
    real_connect = sqlite3.connect
    real_path_open, real_open, real_io_open = Path.open, builtins.open, io.open

    def check(path, args, kwargs):
        if not isinstance(path, (str, Path)) or Path(path).resolve() not in allowed:
            forbidden()
        mode = args[0] if args else kwargs.get('mode', 'r')
        if type(mode) is not str or mode not in ('r', 'rb'):
            forbidden()

    def fixed_path_open(path, *args, **kwargs):
        check(path, args, kwargs)
        return real_path_open(path, *args, **kwargs)

    def fixed_open(path, *args, **kwargs):
        check(path, args, kwargs)
        return real_open(path, *args, **kwargs)

    def fixed_io_open(path, *args, **kwargs):
        check(path, args, kwargs)
        return real_io_open(path, *args, **kwargs)

    def memory_only(database, *args, **kwargs):
        if type(database) is not str or database != ':memory:':
            forbidden()
        return real_connect(database, *args, **kwargs)

    def invoke(function, *args, **kwargs):
        with monkeypatch.context() as scope:
            for name in ('socket', 'create_connection', 'getaddrinfo'):
                scope.setattr(socket, name, forbidden)
            for name in ('get_conn', 'init_db', '_turso_settings'):
                scope.setattr(db, name, forbidden)
            scope.setattr(offline, '_scope_upgrade', forbidden)
            scope.setattr(sqlite3, 'connect', memory_only)
            scope.setattr(Path, 'open', fixed_path_open)
            scope.setattr(builtins, 'open', fixed_open)
            scope.setattr(io, 'open', fixed_io_open)
            scope.setattr(os, 'getenv', forbidden)
            scope.setattr(os, 'environ', {})
            return function(*args, **kwargs)
    return invoke


@pytest.fixture
def case():
    with owner_fixtures.captured(raw_trigger=True) as (source, snapshot, _model):
        packet = owner_fixtures.compile_packet(snapshot)
        # Keep independent original identities before any supplied artifact is
        # changed. No test obtains them from a subsequently mutated artifact.
        yield source, snapshot, packet, dict(owner_fixtures.identity(packet))


@pytest.fixture
def network(monkeypatch):
    factory = SessionFactory()
    monkeypatch.setattr(http.requests, 'Session', factory)
    return factory


def options(case, **overrides):
    result = dict(candidate_origin=ORIGIN, token=TOKEN, **case[3])
    result.update(overrides)
    return result


def send(call, case, **overrides):
    return call(v.send_owner_upgrade_packet_once, case[1], case[2].artifact(), **options(case, **overrides))


def test_new_sender_exact_original_body_and_closed_verdict_without_remote_promotion(call, case, network, capsys):
    target = s.clone(case[0])
    try:
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        metadata = send(call, case).safe_metadata
        assert metadata['commit_acknowledged'] is True
        assert metadata['session_closed_verified'] is True
        assert all(metadata[key] is False for key in parser._FLAGS)
        assert target.execute('SELECT version FROM _schema_version').fetchone()[0] == 9
        assert tuple(target.execute('SELECT singleton,revision FROM owner_sync_state').fetchone()) == (1, 0)
        owner_fixtures.receipt(target, case[2])
        assert_request(network, case[2].body)
        assert_closed(network)
        captured = capsys.readouterr()
        assert captured.out == captured.err == ''
    finally:
        target.close()


@pytest.mark.parametrize('schema,status', [(8, 'missing'), (9, 'matched')])
def test_explicit_new_reconcile_sends_only_closed_generated_read(call, case, network, schema, status):
    target = s.clone(case[0])
    try:
        if schema == 9:
            assert s.execute_packet(target, case[2])['committed'] is True
        expected = reconcile.build_owner_upgrade_reconcile_read(case[1], case[2].artifact(),
            candidate_origin=ORIGIN, read_schema=schema, **case[3])
        before = target.serialize()
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        metadata = call(v.read_owner_upgrade_reconcile_once, case[1], case[2].artifact(),
            read_schema=schema, **options(case)).safe_metadata
        assert metadata['status'] == status
        assert all(metadata[key] is False for key in reconcile._FLAGS)
        assert target.serialize() == before
        assert_request(network, expected)
        assert_closed(network)
    finally:
        target.close()


@pytest.mark.parametrize('key', ('expected_resource_sha256', 'expected_plan_sha256', 'expected_packet_sha256'))
@pytest.mark.parametrize('value', (None, False, 'f' * 64, 'A' * 64, b'a' * 64))
def test_bad_independent_original_sha_never_creates_session(call, case, network, key, value):
    with pytest.raises(v.TransportError, match='^identity_invalid$'):
        send(call, case, **{key: value})
    assert network.calls == network.sessions == []


def test_recompiles_entire_original_artifact_before_any_post(call, case, network):
    artifact = deepcopy(case[2].artifact())
    artifact['body'] += b' '
    with pytest.raises(v.TransportError, match='^identity_invalid$'):
        call(v.send_owner_upgrade_packet_once, case[1], artifact, **options(case))
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('operation', ('send', 'read'))
def test_old_scope_only_profile_never_reaches_new_http_path(call, network, operation):
    with s.captured() as (_source, snapshot):
        old_packet = s.compile_packet(snapshot)
        arguments = dict(candidate_origin=ORIGIN, token=TOKEN, **s.identity(old_packet))
        function = v.send_owner_upgrade_packet_once if operation == 'send' else v.read_owner_upgrade_reconcile_once
        if operation == 'read':
            arguments['read_schema'] = 8
        with pytest.raises(v.TransportError, match='^identity_invalid$'):
            call(function, snapshot, old_packet.artifact(), **arguments)
        assert network.calls == network.sessions == []


@pytest.mark.parametrize('schema', (None, False, 7, 10, '8'))
def test_read_schema_closed_before_http(call, case, network, schema):
    with pytest.raises(v.TransportError, match='^identity_invalid$'):
        call(v.read_owner_upgrade_reconcile_once, case[1], case[2].artifact(),
            read_schema=schema, **options(case))
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('token', (None, '', False, 'a b', 'a\nb', '\u4e2d', 'a' * 8193))
def test_only_explicit_bounded_token_no_environment_discovery(call, case, network, token):
    with pytest.raises(v.TransportError, match='^invalid_arguments$'):
        send(call, case, token=token)
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('seconds', (False, None, 0, -1, 30.001, float('inf'), float('nan')))
def test_total_timeout_native_and_bounded_before_network(call, case, network, seconds):
    with pytest.raises(v.TransportError, match='^invalid_arguments$'):
        send(call, case, timeout_seconds=seconds)
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('fault', ('own_before', 'during_rehydrate', 'budget', 'compiler'))
def test_new_profile_preflight_source_and_time_failure_precede_session(call, case, network, monkeypatch, fault):
    now = [0.0]
    monkeypatch.setattr(http, '_now', lambda: now[0])
    real = compiler.rehydrate_packet
    if fault == 'own_before':
        monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
    else:
        def changed(*args, **kwargs):
            result = real(*args, **kwargs)
            if fault == 'budget':
                now[0] = 31.0
            elif fault == 'compiler':
                raise compiler.CompilerError('compiler_code_drift')
            else:
                monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
            return result
        monkeypatch.setattr(compiler, 'rehydrate_packet', changed)
    with pytest.raises(v.TransportError, match='^(code_drift|time_limit)$'):
        send(call, case)
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('status,reason', [(401, 'http_authentication_rejected'),
    (403, 'http_access_denied'), (429, 'http_rate_limited'),
    (301, 'http_unexpected_status'), (307, 'http_unexpected_status'), (500, 'http_unexpected_status')])
def test_http_stops_no_body_followup_retry_or_private_error(call, case, network, status, reason):
    network.reply = FakeResponse(PRIVATE.encode(), status=status)
    with pytest.raises(v.TransportError, match='^' + reason + '$') as caught:
        send(call, case)
    assert caught.value.outcome == 'unknown' and caught.value.http_status == status
    assert PRIVATE not in repr(caught.value) and TOKEN not in repr(caught.value)
    assert network.reply.iterated == 0
    assert_closed(network)


def test_observed_permission_stop_survives_late_response_and_cleanup_failure(call, case, network, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(http, '_now', lambda: now[0])
    def late_response(_body):
        now[0] = 31.0
        return FakeResponse(PRIVATE.encode(), status=403, fail_close=True)
    network.reply = late_response
    network.fail_close = True
    with pytest.raises(v.TransportError, match='^http_access_denied$') as caught:
        send(call, case)
    assert caught.value.http_status == 403 and caught.value.outcome == 'unknown'
    assert_closed(network)


@pytest.mark.parametrize('stage', ('post', 'stream'))
def test_ambiguous_exchange_has_no_second_post_rollback_or_sql_close(call, case, network, stage):
    if stage == 'post':
        network.post_error = http.requests.Timeout(PRIVATE)
    else:
        network.reply = FakeResponse(chunks=[b'prefix', http.requests.ConnectionError(PRIVATE)])
    with pytest.raises(v.TransportError, match='^transport_failed$') as caught:
        send(call, case)
    assert caught.value.outcome == 'unknown'
    assert_closed(network)


@pytest.mark.parametrize('where', ('response', 'session'))
def test_local_cleanup_failure_cannot_return_success_even_if_memory_committed(call, case, network, where):
    target = s.clone(case[0])
    try:
        network.reply = lambda body: FakeResponse(execute_memory(target, body), fail_close=where == 'response')
        network.fail_close = where == 'session'
        with pytest.raises(v.TransportError, match='^cleanup_failed$'):
            send(call, case)
        assert target.execute('SELECT version FROM _schema_version').fetchone()[0] == 9
        assert_closed(network)
    finally:
        target.close()


@pytest.mark.parametrize('body', (b'\xff', b'{"baton":null,"baton":null,"results":[]}', b''))
def test_supplied_bad_200_bytes_remain_unknown_without_second_request(call, case, network, body):
    network.reply = FakeResponse(body)
    metadata = send(call, case).safe_metadata
    assert metadata['status'] == 'unknown_requires_reconcile'
    assert all(metadata[key] is False for key in parser._FLAGS)
    assert_closed(network)


@pytest.mark.parametrize('phase', ('stream', 'verdict'))
def test_new_profile_drift_after_send_is_unknown_without_second_post(call, case, network, monkeypatch, phase):
    target = s.clone(case[0])
    try:
        network.reply = lambda body: FakeResponse(execute_memory(target, body),
            after_chunk=(lambda: monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)) if phase == 'stream' else None)
        if phase == 'verdict':
            real = parser.verify_owner_upgrade_response
            def changed(*args, **kwargs):
                result = real(*args, **kwargs)
                monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
                return result
            monkeypatch.setattr(parser, 'verify_owner_upgrade_response', changed)
        with pytest.raises(v.TransportError, match='^code_drift$'):
            send(call, case)
        assert_closed(network)
    finally:
        target.close()


def test_total_budget_includes_successful_new_verdict_and_final_checks(call, case, network, monkeypatch):
    target = s.clone(case[0])
    try:
        now = [0.0]
        monkeypatch.setattr(http, '_now', lambda: now[0])
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        real = parser.verify_owner_upgrade_response
        def delayed(*args, **kwargs):
            result = real(*args, **kwargs)
            assert result.safe_metadata['commit_acknowledged'] is True
            now[0] = 31.0
            return result
        monkeypatch.setattr(parser, 'verify_owner_upgrade_response', delayed)
        with pytest.raises(v.TransportError, match='^time_limit$'):
            send(call, case)
        assert_closed(network)
    finally:
        target.close()


@pytest.mark.parametrize('stage', ('plan', 'verdict'))
def test_read_total_budget_covers_real_plan_and_verdict(call, case, network, monkeypatch, stage):
    target = s.clone(case[0])
    try:
        now = [0.0]
        monkeypatch.setattr(http, '_now', lambda: now[0])
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        name = 'build_owner_upgrade_reconcile_read' if stage == 'plan' else 'verify_owner_upgrade_reconcile_read'
        real = getattr(reconcile, name)
        reached = []
        def delayed(*args, **kwargs):
            result = real(*args, **kwargs)
            if stage == 'verdict':
                assert result.safe_metadata['status'] == 'missing'
            else:
                assert type(result) is bytes
            reached.append(True)
            now[0] = 31.0
            return result
        monkeypatch.setattr(reconcile, name, delayed)
        with pytest.raises(v.TransportError, match='^time_limit$'):
            call(v.read_owner_upgrade_reconcile_once, case[1], case[2].artifact(),
                read_schema=8, **options(case))
        assert reached == [True]
        if stage == 'plan':
            assert network.calls == network.sessions == []
        else:
            assert_closed(network)
    finally:
        target.close()


@pytest.mark.parametrize('fault', ('bytes', 'type', 'time', 'backward'))
def test_new_sender_preserves_shared_stream_limits_and_closes(call, case, network, monkeypatch, fault):
    now = [10.0]
    monkeypatch.setattr(http, '_now', lambda: now[0])
    if fault == 'bytes':
        monkeypatch.setattr(http, 'MAX_BYTES', len(case[2].body))
        network.reply = FakeResponse(chunks=[b'x' * len(case[2].body), b'x'])
        reason = 'response_limit'
    elif fault == 'type':
        network.reply = FakeResponse(chunks=[bytearray(b'x')])
        reason = 'response_type_invalid'
    else:
        network.reply = FakeResponse(chunks=[b'x', b'y'],
            after_chunk=lambda: now.__setitem__(0, 41.0 if fault == 'time' else 9.0))
        reason = 'time_limit'
    with pytest.raises(v.TransportError, match='^' + reason + '$'):
        send(call, case)
    assert_closed(network)


def test_fixed_error_never_interpolates_arbitrary_private_reason():
    error = v.TransportError(PRIVATE, TOKEN)
    assert str(error) == 'transport_failed' and error.http_status is None
    assert error.outcome == 'unknown' and PRIVATE not in repr(error) and TOKEN not in repr(error)
