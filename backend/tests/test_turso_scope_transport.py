"""Synthetic fake requests + memory SQLite only; not live transport evidence.

The physical adapter is imported normally. No test may discover configured
credentials, private snapshots or backups.
"""
import builtins
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sqlite3

import pytest

from database import db, turso_scope_packet as compiler, turso_scope_response as parser
from database import turso_scope_reconcile as reconcile, turso_scope_snapshot as capture
from database import turso_scope_upgrade as offline
import turso_scope_packet_fixtures as s

from database import turso_scope_transport as v

ORIGIN = 'libsql://synthetic-candidate.turso.io'
HTTPS = 'https://synthetic-candidate.turso.io'
TOKEN = 'synthetic-token-physical-never-real'
PRIVATE = 'synthetic-private-marker-no-output'
PINS = {
    'turso_scope_packet.py': 'ee01ad893e1db5c8cac4fdc082f2f0c00e2df3568b4d80a6c557f6d6eb0263e0',
    'turso_scope_response.py': '313078fceff4c093cdc92181d5d888278d3c815bfeb818fe464ea56e533de7de',
    'turso_scope_snapshot.py': '78d0801fba7e78bd8b72a909c8bdb2acee5e8f4a7d63e038f543ed02df4faa0d',
    'turso_scope_upgrade.py': '08d7d530f188f7764f3cc6959d1d77ad054adaa57a6d317277f9d49e2cfd8a1c',
    'turso_scope_reconcile.py': '72535b43e7e1f11831343c2a021fe65f2aac89954a4381d6b213b1ef422e51bf',
}


def forbidden(*args, **kwargs):
    raise AssertionError('external_or_configured_access_forbidden')


@pytest.fixture
def call(monkeypatch):
    """Access guards cover candidate calls, not pytest's own reporting/files."""
    allowed = frozenset([*(path for _, path in compiler._CODE_FILES),
                         parser._VERIFIER_PATH, reconcile._OWN_PATH, v._OWN_PATH])
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
    for module in (compiler, parser, capture, offline, reconcile):
        path = Path(module.__file__)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == PINS[path.name]
    with s.captured() as (source, snapshot):
        packet = s.compile_packet(snapshot)
        original_sha = dict(s.identity(packet))  # Before altering any artifact.
        yield source, snapshot, packet, original_sha


class FakeResponse:
    def __init__(self, body=b'{}', *, status=200, chunks=None, fail_close=False, after_chunk=None):
        self.body, self.status_code = body, status
        self.chunks = chunks
        self.fail_close = fail_close
        self.after_chunk = after_chunk
        self.closed = self.iterated = 0

    def json(self):
        forbidden()

    @property
    def content(self):
        forbidden()

    @property
    def text(self):
        forbidden()

    def iter_content(self, chunk_size):
        assert chunk_size == 64 * 1024
        self.iterated += 1
        chunks = self.chunks if self.chunks is not None else [
            self.body[offset:offset + chunk_size] for offset in range(0, len(self.body), chunk_size)]
        for item in chunks:
            if isinstance(item, Exception):
                raise item
            yield item
            if self.after_chunk:
                self.after_chunk()

    def close(self):
        self.closed += 1
        if self.fail_close:
            raise RuntimeError(PRIVATE)


class FakeSession:
    def __init__(self, factory):
        self.factory = factory
        self.trust_env = True
        self.headers = {'synthetic-untrusted-default': PRIVATE}
        self.mounts = []
        self.closed = 0

    def mount(self, prefix, adapter):
        self.mounts.append((prefix, adapter))

    def post(self, url, **kwargs):
        assert self.trust_env is False and self.headers == {}
        self.factory.calls.append((url, kwargs))
        if self.factory.post_error:
            raise self.factory.post_error
        response = self.factory.reply(kwargs['data']) if callable(self.factory.reply) else self.factory.reply
        self.factory.responses.append(response)
        return response

    def close(self):
        self.closed += 1
        if self.factory.fail_close:
            raise RuntimeError(PRIVATE)


class SessionFactory:
    def __init__(self):
        self.calls, self.sessions, self.responses = [], [], []
        self.reply = FakeResponse()
        self.post_error = None
        self.fail_close = False

    def __call__(self):
        session = FakeSession(self)
        self.sessions.append(session)
        return session


@pytest.fixture
def network(monkeypatch):
    factory = SessionFactory()
    monkeypatch.setattr(v.requests, 'Session', factory)
    return factory


def execute_memory(source, body):
    """Test-only original fixed SQL on synthetic memory; never real transport."""
    request = json.loads(body)
    assert request['baton'] is None
    assert [item['type'] for item in request['requests']] == ['batch', 'get_autocommit', 'close']
    values, errors, states = [], [], []
    for step in request['requests'][0]['batch']['steps']:
        if 'condition' in step and not s.condition(source, step['condition'], states):
            values.append(None)
            errors.append(None)
            states.append(None)
            continue
        stmt = step['stmt']
        assert stmt['named_args'] == []
        cursor = source.execute(stmt['sql'], tuple(s.decode(value) for value in stmt['args']))
        rows = cursor.fetchall()
        values.append({'cols': [{'name': col[0], 'decltype': None} for col in (cursor.description or ())],
            'rows': [[s.fixtures.encode(value) for value in row] for row in rows],
            'affected_row_count': 0, 'last_insert_rowid': None})
        errors.append(None)
        states.append(True)
    payload = {'baton': None, 'base_url': HTTPS + '/v3', 'results': [
        {'type': 'ok', 'response': {'type': 'batch', 'result': {'step_results': values, 'step_errors': errors}}},
        {'type': 'ok', 'response': {'type': 'get_autocommit', 'is_autocommit': not source.in_transaction}},
        {'type': 'ok', 'response': {'type': 'close'}}]}
    return json.dumps(payload, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def send_options(case, **overrides):
    result = dict(candidate_origin=ORIGIN, token=TOKEN, **case[3])
    result.update(overrides)
    return result


def send(call, case, **overrides):
    return call(v.send_packet_once, case[1], case[2].artifact(), **send_options(case, **overrides))


def raw_options(**overrides):
    result = dict(url=HTTPS + '/v3/pipeline',
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'},
        body=b'{"synthetic":"exact bytes"}', timeout_seconds=30.0,
        max_attempts=1, allow_redirects=False, stream=True)
    result.update(overrides)
    return result


def raw_roundtrip():
    transport = v.RequestsSnapshotTransport(candidate_origin=ORIGIN, token=TOKEN)
    try:
        response = transport.send(**raw_options())
        return b''.join(response.iter_content(chunk_size=v.CHUNK_BYTES))
    finally:
        transport.close()


def assert_closed(network):
    assert len(network.calls) == 1 and len(network.sessions) == 1
    assert network.sessions[0].closed == 1
    assert all(response.closed == 1 for response in network.responses)


def assert_request(network, expected):
    assert len(network.calls) == 1
    url, options = network.calls[0]
    assert url == HTTPS + '/v3/pipeline'
    assert set(options) == {'data', 'headers', 'timeout', 'allow_redirects', 'stream', 'verify'}
    assert type(options['data']) is bytes and options['data'] == expected
    assert options['headers'] == {'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json', 'Accept-Encoding': 'identity'}
    assert options['verify'] is True and options['allow_redirects'] is False and options['stream'] is True
    assert type(options['timeout']) is tuple and len(options['timeout']) == 2
    assert all(type(value) in (int, float) and 0 < value <= 5 for value in options['timeout'])
    mounts = network.sessions[0].mounts
    assert len(mounts) == 1 and mounts[0][0] == 'https://'
    assert mounts[0][1].max_retries.total == 0


def test_actual_sender_forwards_exact_packet_and_retains_false_remote_flags(call, case, network, capsys):
    target = s.clone(case[0])
    try:
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        result = send(call, case)
        meta = result.safe_metadata
        assert meta['commit_acknowledged'] is True
        assert meta['session_closed_verified'] is True
        assert all(meta[name] is False for name in parser._FLAGS)
        assert target.execute('SELECT version FROM _schema_version').fetchone()[0] == 9
        assert_request(network, case[2].body)
        assert_closed(network)
        output = capsys.readouterr()
        assert output.out == output.err == ''
    finally:
        target.close()


@pytest.mark.parametrize('schema,status', [(8, 'missing'), (9, 'matched')], ids=('before', 'after'))
def test_explicit_reconcile_uses_only_generated_read_plan(call, case, network, schema, status):
    target = s.clone(case[0])
    try:
        if schema == 9:
            assert s.execute_packet(target, case[2])['committed'] is True
        expected = reconcile.build_scope_reconcile_read(case[1], case[2].artifact(),
            candidate_origin=ORIGIN, read_schema=schema, **case[3])
        before = offline._rows_digest(s.records(target))
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        result = call(v.read_reconcile_once, case[1], case[2].artifact(),
            read_schema=schema, **send_options(case))
        assert result.safe_metadata['status'] == status
        assert all(result.safe_metadata[name] is False for name in reconcile._FLAGS)
        assert offline._rows_digest(s.records(target)) == before
        assert_request(network, expected)
        assert_closed(network)
    finally:
        target.close()


def test_concrete_adapter_is_compatible_with_normal_capture(call, case, network):
    target = s.clone(case[0])
    try:
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        transport = v.RequestsSnapshotTransport(candidate_origin=ORIGIN, token=TOKEN)
        result = call(capture.capture_scope_snapshot, candidate_origin=ORIGIN, token=TOKEN,
            transport=transport, operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS),
            query_mode_profile='turso-fixed-read-v1', expected_resource_sha256=case[3]['expected_resource_sha256'])
        try:
            assert result.safe_metadata['from_schema'] == 8
            assert result.safe_metadata['source_rows_sha256'] == case[1].safe_metadata['source_rows_sha256']
            assert result.safe_metadata['remote_applied'] is False
            assert_closed(network)
            assert network.calls[0][1]['data'].startswith(b'{')
        finally:
            result.close()
    finally:
        target.close()


@pytest.mark.parametrize('key', ('expected_resource_sha256', 'expected_plan_sha256', 'expected_packet_sha256'),
    ids=('resource', 'plan', 'packet'))
@pytest.mark.parametrize('value', (None, False, 'f' * 64, 'A' * 64, b'a' * 64),
    ids=('missing', 'bool', 'wrong', 'upper', 'bytes'))
def test_bad_external_original_binding_has_zero_session_and_post(call, case, network, key, value):
    with pytest.raises(v.TransportError, match='^identity_invalid$'):
        send(call, case, **{key: value})
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('origin', ('https://other.turso.io', 'http://synthetic-candidate.turso.io',
    'https://user:secret@synthetic-candidate.turso.io', 'https://synthetic-candidate.turso.io/?token=secret'),
    ids=('other', 'tls', 'credentials', 'query'))
def test_origin_binding_precedes_rehydrate_and_network(call, case, network, monkeypatch, origin):
    monkeypatch.setattr(compiler, 'rehydrate_packet', forbidden)
    with pytest.raises(v.TransportError, match='^identity_invalid$'):
        send(call, case, candidate_origin=origin)
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('token', (None, '', False, 'a b', 'a\nb', '\u4e2d', 'a' * 8193),
    ids=('missing', 'empty', 'bool', 'space', 'newline', 'unicode', 'long'))
def test_no_credential_discovery_or_fallback(call, case, network, token):
    with pytest.raises(v.TransportError, match='^invalid_arguments$'):
        send(call, case, token=token)
    assert network.calls == network.sessions == []


def test_entire_artifact_is_rehydrated_before_network(call, case, network):
    artifact = deepcopy(case[2].artifact())
    artifact['body'] += b' '
    with pytest.raises(v.TransportError, match='^identity_invalid$'):
        call(v.send_packet_once, case[1], artifact, **send_options(case))
    assert network.calls == network.sessions == []


@pytest.mark.parametrize('fault', ('own_before', 'during_rehydrate', 'budget', 'compiler'),
    ids=('own', 'mid-source', 'time', 'compiler'))
def test_preflight_drift_or_expired_budget_never_creates_session(call, case, network, monkeypatch, fault):
    now = [0.0]
    monkeypatch.setattr(v, '_now', lambda: now[0])
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


@pytest.mark.parametrize('seconds', (False, None, 0, -1, 30.001, float('inf'), float('nan')),
    ids=('bool', 'missing', 'zero', 'negative', 'over', 'inf', 'nan'))
def test_native_total_timeout_bound_before_network(call, case, network, seconds):
    with pytest.raises(v.TransportError, match='^invalid_arguments$'):
        send(call, case, timeout_seconds=seconds)
    assert network.calls == network.sessions == []


def test_drift_during_session_setup_is_caught_before_first_post(call, case, network, monkeypatch):
    def changed_factory():
        result = network()
        monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
        return result
    monkeypatch.setattr(v.requests, 'Session', changed_factory)
    with pytest.raises(v.TransportError, match='^code_drift$'):
        send(call, case)
    assert network.calls == []
    assert len(network.sessions) == 1 and network.sessions[0].closed == 1


@pytest.mark.parametrize('status,reason', [(401, 'http_authentication_rejected'),
    (403, 'http_access_denied'), (429, 'http_rate_limited'), (301, 'http_unexpected_status'),
    (307, 'http_unexpected_status'), (500, 'http_unexpected_status')],
    ids=('auth', 'denied', 'rate', 'redirect', 'redirect-post', 'server'))
def test_observed_http_status_is_fixed_stop_no_body_or_retry(call, case, network, status, reason):
    network.reply = FakeResponse(PRIVATE.encode(), status=status)
    with pytest.raises(v.TransportError, match='^' + reason + '$') as caught:
        send(call, case)
    assert caught.value.http_status == status and caught.value.outcome == 'unknown'
    assert PRIVATE not in repr(caught.value) and TOKEN not in repr(caught.value)
    assert network.reply.iterated == 0
    assert_closed(network)


def test_observed_auth_stop_is_not_lost_when_post_returns_after_budget(call, case, network, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(v, '_now', lambda: now[0])
    def late_auth(body):
        now[0] = 31.0
        return FakeResponse(PRIVATE.encode(), status=401)
    network.reply = late_auth
    with pytest.raises(v.TransportError, match='^http_authentication_rejected$') as caught:
        send(call, case)
    assert caught.value.http_status == 401 and caught.value.outcome == 'unknown'
    assert_closed(network)


@pytest.mark.parametrize('stage', ('post', 'read'), ids=('post', 'stream'))
def test_ambiguous_request_failures_do_not_rollback_replay_or_http_close(call, case, network, stage):
    if stage == 'post':
        network.post_error = v.requests.Timeout(PRIVATE)
    else:
        network.reply = FakeResponse(chunks=[b'prefix', v.requests.ConnectionError(PRIVATE)])
    with pytest.raises(v.TransportError, match='^transport_failed$') as caught:
        send(call, case)
    assert caught.value.outcome == 'unknown'
    assert_closed(network)


@pytest.mark.parametrize('where', ('response', 'session'), ids=('response', 'session'))
def test_local_cleanup_failure_cannot_return_acknowledged_success(call, case, network, where):
    target = s.clone(case[0])
    try:
        def reply(body):
            return FakeResponse(execute_memory(target, body), fail_close=where == 'response')
        network.reply = reply
        network.fail_close = where == 'session'
        with pytest.raises(v.TransportError, match='^cleanup_failed$') as caught:
            send(call, case)
        assert caught.value.outcome == 'unknown'
        assert target.execute('SELECT version FROM _schema_version').fetchone()[0] == 9
        assert_closed(network)  # Only local cleanup; no second HTTP close/rollback.
    finally:
        target.close()


def test_http_permission_stop_survives_cleanup_failure_without_claiming_success(call, case, network):
    network.reply = FakeResponse(PRIVATE.encode(), status=403, fail_close=True)
    network.fail_close = True
    with pytest.raises(v.TransportError, match='^http_access_denied$') as caught:
        send(call, case)
    assert caught.value.http_status == 403 and caught.value.outcome == 'unknown'
    assert_closed(network)


@pytest.mark.parametrize('data', (b'\xff', b'{"baton":null,"baton":null,"results":[]}', b''),
    ids=('utf8', 'duplicate', 'empty'))
def test_200_bytes_are_passed_to_strict_existing_parser_not_response_json(call, case, network, data):
    network.reply = FakeResponse(data)
    meta = send(call, case).safe_metadata
    assert meta['status'] == 'unknown_requires_reconcile'
    assert all(meta[name] is False for name in parser._FLAGS)
    assert_closed(network)


def test_local_session_close_is_not_sql_close_acknowledgement(call, case, network):
    target = s.clone(case[0])
    try:
        def reply(body):
            value = json.loads(execute_memory(target, body))
            value['results'][2] = {'type': 'error', 'error': {'message': PRIVATE, 'code': 'SYNTHETIC'}}
            return FakeResponse(json.dumps(value).encode())
        network.reply = reply
        meta = send(call, case).safe_metadata
        assert meta['status'] == 'unknown_requires_reconcile'
        assert meta['session_closed_verified'] is False
        assert target.execute('SELECT version FROM _schema_version').fetchone()[0] == 9
        assert_closed(network)
    finally:
        target.close()


@pytest.mark.parametrize('fault', ('bytes', 'type', 'time', 'backward'), ids=('bytes', 'type', 'time', 'backward'))
def test_stream_is_bounded_in_bytes_types_and_monotonic_time(call, network, monkeypatch, fault):
    now = [10.0]
    monkeypatch.setattr(v, '_now', lambda: now[0])
    if fault == 'bytes':
        monkeypatch.setattr(v, 'MAX_BYTES', len(raw_options()['body']))
        network.reply = FakeResponse(chunks=[b'x' * len(raw_options()['body']), b'x'])
        expected = 'response_limit'
    elif fault == 'type':
        network.reply = FakeResponse(chunks=[bytearray(b'x')])
        expected = 'response_type_invalid'
    else:
        network.reply = FakeResponse(chunks=[b'x', b'y'],
            after_chunk=lambda: now.__setitem__(0, 41.0 if fault == 'time' else 9.0))
        expected = 'time_limit'
    with pytest.raises(v.TransportError, match='^' + expected + '$'):
        call(raw_roundtrip)
    assert_closed(network)


@pytest.mark.parametrize('option,value', [('max_attempts', 2), ('max_attempts', True),
    ('allow_redirects', True), ('stream', False), ('url', HTTPS + '/other'),
    ('body', bytearray(b'{}'))], ids=('attempts', 'bool', 'redirect', 'stream', 'path', 'body'))
def test_adapter_rejects_contract_weakening_before_session(call, network, option, value):
    def run():
        transport = v.RequestsSnapshotTransport(candidate_origin=ORIGIN, token=TOKEN)
        try:
            transport.send(**raw_options(**{option: value}))
        finally:
            transport.close()
    with pytest.raises(v.TransportError, match='^invalid_arguments$'):
        call(run)
    assert network.calls == network.sessions == []


def test_adapter_instance_never_sends_twice_even_after_local_close(call, network):
    def run():
        transport = v.RequestsSnapshotTransport(candidate_origin=ORIGIN, token=TOKEN)
        response = transport.send(**raw_options())
        assert b''.join(response.iter_content()) == b'{}'
        response.close()
        transport.close()
        transport.close()
        with pytest.raises(v.TransportError, match='^transport_used$'):
            transport.send(**raw_options())
    call(run)
    assert_closed(network)
    assert_request(network, raw_options()['body'])


@pytest.mark.parametrize('phase', ('stream', 'verdict'), ids=('stream', 'final-result'))
def test_source_drift_after_send_is_unknown_without_second_post(call, case, network, monkeypatch, phase):
    target = s.clone(case[0])
    try:
        network.reply = lambda body: FakeResponse(execute_memory(target, body),
            after_chunk=(lambda: monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)) if phase == 'stream' else None)
        if phase == 'verdict':
            real = parser.verify_scope_response
            def changed(*args, **kwargs):
                result = real(*args, **kwargs)
                monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
                return result
            monkeypatch.setattr(parser, 'verify_scope_response', changed)
        with pytest.raises(v.TransportError, match='^code_drift$'):
            send(call, case)
        assert_closed(network)
    finally:
        target.close()


def test_total_budget_includes_existing_parser_and_final_verdict(call, case, network, monkeypatch):
    target = s.clone(case[0])
    try:
        now = [0.0]
        monkeypatch.setattr(v, '_now', lambda: now[0])
        network.reply = lambda body: FakeResponse(execute_memory(target, body))
        real = parser.verify_scope_response
        def delayed(*args, **kwargs):
            result = real(*args, **kwargs)
            assert result.safe_metadata['commit_acknowledged'] is True
            now[0] = 31.0
            return result
        monkeypatch.setattr(parser, 'verify_scope_response', delayed)
        with pytest.raises(v.TransportError, match='^time_limit$'):
            send(call, case)
        assert_closed(network)
    finally:
        target.close()


def test_fixed_error_repr_never_interpolates_unknown_private_reason():
    error = v.TransportError(PRIVATE, TOKEN)
    assert str(error) == 'transport_failed' and error.http_status is None
    assert PRIVATE not in repr(error) and TOKEN not in repr(error)
    assert error.outcome == 'unknown'
