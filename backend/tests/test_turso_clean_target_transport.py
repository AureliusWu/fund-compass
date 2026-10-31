"""Real requests bytes over an owned HTTP/SQLite Hrana server, never Turso."""
from contextlib import closing, contextmanager
from dataclasses import replace
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import sqlite3
import threading
from types import SimpleNamespace

import pytest
import requests

from database import db, turso_clean_target as compiler
from database import turso_clean_target_transport as transport
from test_owner_sync_turso import HranaState, TOKEN, encode_value
from test_turso_owner_upgrade_packet import captured
from test_turso_clean_target import arguments
from turso_scope_packet_fixtures import decode

SOURCE = 'libsql://synthetic-candidate.turso.io'
ORIGIN = 'https://synthetic-clean-target.turso.io'
_REAL_SESSION = requests.sessions.Session


def prepared(snapshot):
    options, archive = arguments(snapshot)
    options['expected_target_resource_sha256'] = hashlib.sha256(ORIGIN.encode('ascii')).hexdigest()
    plan = compiler.plan_clean_target(snapshot, **options)
    packet = compiler.compile_clean_target(snapshot, **options, expected_repair_sha256=plan['repair_sha256'])
    metadata = packet.safe_metadata
    bindings = {'source_origin': SOURCE, 'target_origin': ORIGIN, 'token': TOKEN,
        **{'expected_' + key: metadata[key] for key in ('source_resource_sha256', 'source_image_sha256',
            'source_archive_sha256', 'target_resource_sha256', 'repair_sha256', 'plan_sha256', 'packet_sha256')}}
    return packet, bindings


@contextmanager
def owned_hrana(path, monkeypatch):
    state = HranaState(path)
    observed = SimpleNamespace(posts=[], write_posts=0, read_posts=0, status=200, foreign_keys=True,
        lose_write=False, corrupt=None, sql_permission=False, fail_cleanup=False, after_write=None)
    def execute(conn, statement):
        sql = statement['sql']
        if sql.startswith('BEGIN') and observed.foreign_keys:
            conn.execute('PRAGMA foreign_keys=ON')
        if observed.sql_permission and 'foreign_keys FROM pragma_foreign_keys' in sql:
            error = sqlite3.DatabaseError('synthetic permission stop')
            error.sqlite_errorname = 'SQLITE_AUTH'
            raise error
        assert not statement.get('named_args')
        previous_changes = conn.total_changes
        cursor = conn.execute(sql, tuple(decode(value) for value in statement.get('args', ())))
        names = [column[0] for column in cursor.description or ()]
        rows = cursor.fetchall() if cursor.description else []
        def encode(value):
            if type(value) is bytes:
                return {'type': 'blob', 'base64': base64.b64encode(value).decode('ascii')}
            return encode_value(value)
        return {'cols': [{'name': name, 'decltype': None} for name in names],
            'rows': [[encode(value) for value in row] for row in rows],
            'affected_row_count': max(0, cursor.rowcount, conn.total_changes - previous_changes),
            'last_insert_rowid': None if cursor.lastrowid is None else str(cursor.lastrowid)}
    state.execute = execute
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            assert self.path == '/v3/pipeline'
            assert self.headers.get('Authorization') == 'Bearer ' + TOKEN
            count = int(self.headers['Content-Length'])
            assert 0 < count <= 16 * 1024 * 1024
            frame = json.loads(self.rfile.read(count))
            observed.posts.append(frame)
            steps = frame['requests'][0]['batch']['steps']
            writing = steps[0]['stmt']['sql'] == 'BEGIN IMMEDIATE'
            observed.write_posts += int(writing)
            observed.read_posts += int(not writing)
            if observed.status != 200:
                self.send_response(observed.status); self.send_header('Content-Length', '2'); self.end_headers()
                self.wfile.write(b'{}')
                return
            response, unused = state.pipeline(frame)
            if writing and observed.after_write:
                callback, observed.after_write = observed.after_write, None
                callback()
            if writing and observed.lose_write:
                observed.lose_write = False
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); self.close_connection = True
                return
            if observed.corrupt:
                observed.corrupt(response, frame)
            raw = json.dumps(response, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            self.send_response(200); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    local = 'http://127.0.0.1:' + str(server.server_port)
    class Session(_REAL_SESSION):
        def post(self, url, **kwargs):
            assert url == ORIGIN + '/v3/pipeline'
            assert self.trust_env is False and kwargs['allow_redirects'] is False and kwargs['stream'] is True
            assert kwargs['verify'] is True and max(kwargs['timeout']) <= 5
            assert kwargs['headers']['Accept-Encoding'] == 'identity'
            return super().post(local + '/v3/pipeline', **kwargs)
        def close(self):
            super().close()
            if observed.fail_cleanup: raise RuntimeError('synthetic local cleanup failure')
    monkeypatch.setattr(transport.physical.requests, 'Session', Session)
    try:
        yield observed, state
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2); state.close()


def send(snapshot, packet, bindings, **kwargs):
    return transport.send_clean_target_once(snapshot, packet.artifact(), **bindings, **kwargs)


def read(snapshot, packet, bindings, **kwargs):
    return transport.read_clean_target_once(snapshot, packet.artifact(), **bindings, **kwargs)


def test_real_http_import_then_independent_complete_readback_never_grants_retry(tmp_path, monkeypatch):
    with captured() as (source, snapshot, _model):
        before = source.serialize()
        packet, bindings = prepared(snapshot)
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch) as (observed, state):
            result = send(snapshot, packet, bindings).safe_metadata
            assert result['write_commit_acknowledged'] and result['session_closed_verified']
            assert not result['target_postimage_acknowledged'] and result['requires_reconciliation']
            assert observed.write_posts == 1 and observed.read_posts == 0
            final = read(snapshot, packet, bindings).safe_metadata
            assert final['status'] == 'target_image_acknowledged' and final['target_postimage_acknowledged']
            assert not final['write_commit_acknowledged'] and not final['requires_reconciliation']
            assert all(final[key] is False for key in transport._FLAGS)
            assert observed.write_posts == observed.read_posts == 1 and not state.streams
            read_frame = observed.posts[-1]
            assert all(step['stmt']['sql'].lstrip().split()[0] in {'BEGIN', 'WITH', 'SELECT', 'COMMIT', 'ROLLBACK'}
                       for step in read_frame['requests'][0]['batch']['steps'])
        assert source.serialize() == before


def test_lost_accepted_response_only_original_full_readback_no_automatic_write_replay(tmp_path, monkeypatch):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch) as (observed, _state):
            observed.lose_write = True
            with pytest.raises(transport.CleanTargetTransportError) as error:
                send(snapshot, packet, bindings)
            assert error.value.outcome == 'unknown' and observed.write_posts == 1
            final = read(snapshot, packet, bindings).safe_metadata
            assert final['target_postimage_acknowledged'] and final['retry_allowed'] is False
            assert observed.write_posts == observed.read_posts == 1


@pytest.mark.parametrize('status', [401, 403, 429])
def test_http_stop_never_retries_or_changes_identity(tmp_path, monkeypatch, status):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch) as (observed, _state):
            observed.status = status
            with pytest.raises(transport.CleanTargetTransportError) as error:
                send(snapshot, packet, bindings)
            assert error.value.http_status == status and error.value.outcome == 'unknown'
            assert len(observed.posts) == observed.write_posts == 1


def test_sql_permission_is_stop_even_with_observed_rollback(tmp_path, monkeypatch):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch) as (observed, _state):
            observed.sql_permission = True
            result = send(snapshot, packet, bindings).safe_metadata
            assert result['permission_stop'] and result['status'] == 'unknown_requires_reconcile'
            assert not result['write_commit_acknowledged'] and not result['retry_allowed']
            assert observed.write_posts == 1


@pytest.mark.parametrize('fault', ['nonempty', 'foreign_keys'])
def test_foreign_key_capability_and_empty_target_are_real_sql_guards(tmp_path, monkeypatch, fault):
    path = tmp_path / 'clean.sqlite3'
    if fault == 'nonempty':
        with closing(sqlite3.connect(path)) as conn:
            conn.execute('CREATE TABLE original_private(value TEXT)'); conn.commit()
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        with owned_hrana(path, monkeypatch) as (observed, _state):
            observed.foreign_keys = fault != 'foreign_keys'
            result = send(snapshot, packet, bindings).safe_metadata
            assert result['status'] == 'rollback_acknowledged' and not result['write_commit_acknowledged']
            assert observed.write_posts == 1
        with closing(sqlite3.connect(path)) as conn:
            assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='owner_machine_journal'").fetchone() is None


@pytest.mark.parametrize('fault', ['guard_zero', 'guard_empty', 'guard_extra', 'affected_zero', 'commit_skip', 'autocommit', 'sql_close', 'local_close'])
def test_bad_result_or_cleanup_is_unknown_despite_accepted_write(tmp_path, monkeypatch, fault):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch) as (observed, _state):
            if fault == 'local_close': observed.fail_cleanup = True
            def corrupt(payload, frame):
                if fault == 'guard_zero': payload['results'][0]['response']['result']['step_results'][1]['rows'][0][0]['value'] = '0'
                elif fault == 'guard_empty': payload['results'][0]['response']['result']['step_results'][1]['rows'] = []
                elif fault == 'guard_extra':
                    rows = payload['results'][0]['response']['result']['step_results'][1]['rows']
                    rows.append(rows[0])
                elif fault == 'affected_zero':
                    index = next(i for i, step in enumerate(frame['requests'][0]['batch']['steps'])
                                 if 'INSERT INTO' in step['stmt']['sql'] and step['stmt']['sql'].startswith('WITH '))
                    payload['results'][0]['response']['result']['step_results'][index]['affected_row_count'] = 0
                elif fault == 'commit_skip': payload['results'][0]['response']['result']['step_results'][-2] = None
                elif fault == 'autocommit': payload['results'][1]['response']['is_autocommit'] = False
                elif fault == 'sql_close': payload['results'][2] = {'type': 'error', 'error': {'code': 'SQLITE_ERROR', 'message': 'synthetic close error'}}
            observed.corrupt = corrupt
            with pytest.raises(transport.CleanTargetTransportError) as error:
                send(snapshot, packet, bindings)
            assert error.value.outcome == 'unknown' and observed.write_posts == 1
            observed.corrupt, observed.fail_cleanup = None, False
            assert read(snapshot, packet, bindings).safe_metadata['target_postimage_acknowledged']
            assert observed.write_posts == observed.read_posts == 1


def test_readback_checks_unrelated_rows_not_only_receipt(tmp_path, monkeypatch):
    path = tmp_path / 'clean.sqlite3'
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        with owned_hrana(path, monkeypatch) as (observed, _state):
            assert send(snapshot, packet, bindings).safe_metadata['write_commit_acknowledged']
            with closing(sqlite3.connect(path)) as conn:
                conn.execute("UPDATE funds SET name='changed after receipt' WHERE code='000001'"); conn.commit()
            result = read(snapshot, packet, bindings).safe_metadata
            assert not result['target_postimage_acknowledged'] and not result['retry_allowed']
            assert observed.write_posts == observed.read_posts == 1


def test_same_origin_or_wrong_external_identity_stops_before_session_creation(monkeypatch):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        def forbidden(*args, **kwargs): pytest.fail('invalid binding reached HTTP')
        monkeypatch.setattr(transport.physical.requests, 'Session', forbidden)
        bad = {**bindings, 'target_origin': SOURCE}
        with pytest.raises(transport.CleanTargetTransportError): send(snapshot, packet, bad)
        arbitrary = {key: value for key, value in bindings.items() if key.startswith('expected_')}
        arbitrary['expected_target_resource_sha256'] = hashlib.sha256(b'https://example.com').hexdigest()
        with pytest.raises(transport.CleanTargetTransportError):
            transport._origins(SOURCE, 'https://example.com', TOKEN, arbitrary)
        for key in [key for key in bindings if key.startswith('expected_')]:
            bad = {**bindings, key: '0' * 64}
            with pytest.raises(transport.CleanTargetTransportError): send(snapshot, packet, bad)


def test_callback_revocation_after_commit_is_not_returned_as_success(tmp_path, monkeypatch):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        sentinel = RuntimeError('synthetic operator authorization revoked')
        allowed = [True]
        def check():
            if not allowed[0]: raise sentinel
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch) as (observed, _state):
            observed.after_write = lambda: allowed.__setitem__(0, False)
            with pytest.raises(RuntimeError) as error: send(snapshot, packet, bindings, check=check)
            assert error.value is sentinel and observed.write_posts == 1
            assert read(snapshot, packet, bindings).safe_metadata['target_postimage_acknowledged']


def test_result_safe_summary_cannot_be_resealed_or_coerced(tmp_path, monkeypatch):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch):
            result = send(snapshot, packet, bindings)
            for key, value in [('retry_allowed', True), ('unknown', 'private'), ('target_postimage_acknowledged', True)]:
                facts = dict(result._safe_items); facts[key] = value
                forged = replace(result, _safe_items=tuple(sorted(facts.items())))
                with pytest.raises(transport.CleanTargetTransportError): _ = forged.safe_metadata


def test_explicit_token_never_reads_ambient_credential_or_proxy_configuration(tmp_path, monkeypatch):
    import os
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        def forbidden(*args, **kwargs): pytest.fail('operator helper reached configured storage')
        monkeypatch.setattr(db, 'get_conn', forbidden)
        monkeypatch.setattr(db, 'init_db', forbidden)
        original = os._Environ.get
        def credential_guard(env, key, default=None):
            if any(word in key.upper() for word in ('TURSO', 'TOKEN', 'PASSWORD', 'CREDENTIAL', 'PROXY', 'NETRC')):
                pytest.fail('operator helper inspected ambient credentials')
            return original(env, key, default)
        with owned_hrana(tmp_path / 'clean.sqlite3', monkeypatch) as (_observed, _state):
            monkeypatch.setattr(os._Environ, 'get', credential_guard)
            assert send(snapshot, packet, bindings).safe_metadata['write_commit_acknowledged']


def test_cancelled_preflight_never_opens_http_and_preserves_original_error(monkeypatch):
    with captured() as (_, snapshot, _model):
        packet, bindings = prepared(snapshot)
        sentinel = RuntimeError('synthetic cancellation before HTTP')
        def stop(): raise sentinel
        def forbidden(*args, **kwargs): pytest.fail('cancelled helper opened HTTP')
        monkeypatch.setattr(transport.physical.requests, 'Session', forbidden)
        with pytest.raises(RuntimeError) as error: send(snapshot, packet, bindings, check=stop)
        assert error.value is sentinel
