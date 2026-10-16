"""Synthetic, guarded tests: no configured DB, credentials, sockets or cloud."""
from contextlib import redirect_stdout, redirect_stderr
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
import hashlib
import builtins
import io
import json
import math
import os
from pathlib import Path
import socket
import sqlite3

import pytest

from database import db, turso_scope_packet as compiler, turso_scope_snapshot as capture, turso_scope_upgrade as offline
import turso_scope_packet_fixtures as s
from database import turso_scope_response as v

PRIVATE = 'synthetic-private-sql-token-url-marker-not-real'
ORIGIN = 'libsql://synthetic-candidate.turso.io'
REPO_PACKET_SHA = 'ee01ad893e1db5c8cac4fdc082f2f0c00e2df3568b4d80a6c557f6d6eb0263e0'


def forbidden(*_args, **_kwargs):
    raise AssertionError('external_or_configured_access_forbidden')


@pytest.fixture(autouse=True)
def isolated_access(monkeypatch):
    for name in ('socket', 'create_connection', 'getaddrinfo'):
        monkeypatch.setattr(socket, name, forbidden)
    for name in ('get_conn', 'init_db', '_turso_settings'):
        monkeypatch.setattr(db, name, forbidden)
    monkeypatch.setattr(offline, '_scope_upgrade', forbidden)
    real_connect = sqlite3.connect

    def memory_only(database, *args, **kwargs):
        if type(database) is not str or database != ':memory:':
            forbidden()
        return real_connect(database, *args, **kwargs)

    monkeypatch.setattr(sqlite3, 'connect', memory_only)
    allowed = frozenset([*(path for _, path in compiler._CODE_FILES), v._VERIFIER_PATH])
    real_path_open, real_open = Path.open, builtins.open

    def allowed_mode(args, kwargs):
        mode = args[0] if args else kwargs.get('mode', 'r')
        if type(mode) is not str or mode not in ('r', 'rb'):
            forbidden()

    def fixed_path_open(path, *args, **kwargs):
        if path.resolve() not in allowed:
            forbidden()
        allowed_mode(args, kwargs)
        return real_path_open(path, *args, **kwargs)

    def fixed_open(path, *args, **kwargs):
        if type(path) is not str or Path(path).resolve() not in allowed:
            forbidden()
        allowed_mode(args, kwargs)
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'open', fixed_path_open)
    monkeypatch.setattr(builtins, 'open', fixed_open)


@pytest.fixture
def case(monkeypatch):
    assert hashlib.sha256(compiler._CODE_FILES[0][1].read_bytes()).hexdigest() == REPO_PACKET_SHA
    with s.captured() as (source, snapshot):
        packet = s.compile_packet(snapshot)
        # Independently pinned at fixture creation, before tampering a copy.
        expected = dict(s.identity(packet))
        monkeypatch.setattr(capture, 'capture_scope_snapshot', forbidden)
        yield source, snapshot, packet, expected


def empty():
    return {'cols': [], 'rows': [], 'affected_row_count': 0, 'last_insert_rowid': None}


def guard():
    return {'cols': [{'name': 'guard_passed', 'decltype': None}],
            'rows': [[{'type': 'integer', 'value': '1'}]],
            'affected_row_count': 0, 'last_insert_rowid': None}


def envelope(values, errors):
    return {'baton': None, 'base_url': None, 'results': [
        {'type': 'ok', 'response': {'type': 'batch', 'result': {'step_results': values, 'step_errors': errors}}},
        {'type': 'ok', 'response': {'type': 'get_autocommit', 'is_autocommit': True}},
        {'type': 'ok', 'response': {'type': 'close'}}]}


def success(packet):
    values = [guard() if spec[4][0] == 'guard' else empty() for spec in packet.statement_specs]
    values[-1] = None
    return envelope(values, [None] * len(values))


def arrays(payload):
    result = payload['results'][0]['response']['result']
    return result['step_results'], result['step_errors']


def raw(payload):
    return json.dumps(payload, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def verify(case, value, **overrides):
    _, snapshot, packet, expected = case
    options = dict(candidate_origin=ORIGIN, **expected)
    options.update(overrides)
    return v.verify_scope_response(snapshot, packet.artifact(), value, **options)


def safe(verdict):
    meta = verdict.safe_metadata
    assert set(meta) == v._PUBLIC_KEYS
    for name in v._FLAGS:
        assert meta[name] is False and type(meta[name]) is bool
    assert PRIVATE not in repr(verdict)
    assert PRIVATE not in json.dumps(meta)
    return meta


def unknown(verdict, reason=None):
    meta = safe(verdict)
    assert meta['status'] == 'unknown_requires_reconcile'
    assert meta['requires_reconciliation'] is True
    assert meta['response_contract_verified'] is False
    assert meta['commit_acknowledged'] is False
    if reason is not None:
        assert meta['reason'] == reason
    return meta


def execute_synthetic(source, packet, fail_indices=()):
    """Test-only repository-owned SQL over a fresh synthetic in-memory clone."""
    target = s.clone(source)
    try:
        body = json.loads(packet.body)
        values, errors, condition_results = [], [], []
        for index, (step, spec) in enumerate(zip(body['requests'][0]['batch']['steps'], packet.statement_specs)):
            if 'condition' in step and not s.condition(target, step['condition'], condition_results):
                values.append(None)
                errors.append(None)
                condition_results.append(None)
                continue
            try:
                if index in fail_indices:
                    raise sqlite3.OperationalError('synthetic fault')
                cursor = target.execute(spec[1], spec[2])
                rows = cursor.fetchall()
                values.append({'cols': [{'name': col[0], 'decltype': None} for col in (cursor.description or ())],
                    'rows': [[s.fixtures.encode(value) for value in row] for row in rows],
                    'affected_row_count': 0, 'last_insert_rowid': None})
                errors.append(None)
                condition_results.append(True)
            except sqlite3.Error:
                values.append(None)
                errors.append({'message': PRIVATE, 'code': 'SYNTHETIC_FAULT'})
                condition_results.append(False)
        payload = envelope(values, errors)
        payload['results'][1]['response']['is_autocommit'] = not target.in_transaction
        return payload, s.records(target)
    finally:
        target.close()


def test_success_real_synthetic_sql_and_no_remote_claim(case):
    source, _, packet, _ = case
    payload, records = execute_synthetic(source, packet)
    assert records['_schema_version'][1] == [(1, 1, 9)]
    meta = safe(verify(case, raw(payload)))
    assert meta['status'] == 'commit_acknowledged'
    assert meta['response_contract_verified'] is True
    assert meta['session_closed_verified'] is True
    assert meta['identity_verified'] is True
    assert meta['requires_reconciliation'] is False


def test_every_executable_step_fault_has_exact_prefix_rollback(case):
    source, _, packet, _ = case
    before = offline._rows_digest(s.records(source))
    commit = packet.request_specs[0][2]
    for index in range(commit + 1):
        payload, records = execute_synthetic(source, packet, (index,))
        meta = safe(verify(case, raw(payload)))
        assert meta['status'] == ('not_started_acknowledged' if index == 0 else 'rollback_acknowledged'), (index, meta['reason'])
        assert offline._rows_digest(records) == before
        assert meta['permission_stop'] is False
    print('synthetic_executable_fault_positions=' + str(commit + 1))


def test_rollback_failure_never_becomes_retry(case):
    source, _, packet, _ = case
    payload, _ = execute_synthetic(source, packet, (1, len(packet.statement_specs) - 1))
    unknown(verify(case, raw(payload)))


@pytest.mark.parametrize('code', sorted(v._PERMISSION))
def test_literal_permission_codes_observed_only(case, code):
    packet = case[2]
    payload = success(packet)
    values, errors = arrays(payload)
    values[:] = [None] * len(values)
    errors[0] = {'message': PRIVATE, 'code': code}
    meta = unknown(verify(case, raw(payload)), 'permission_stop')
    assert meta['permission_stop'] is True


@pytest.mark.parametrize('code', ['UNKNOWN', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'auth', 'AUTH_MORE', 'SQLITE_READONLY_EXTRA', ''])
def test_unknown_busy_and_message_do_not_authorize_fallback(case, code):
    payload = success(case[2])
    values, errors = arrays(payload)
    values[:] = [None] * len(values)
    errors[0] = {'message': 'AUTH PERM READONLY ' + PRIVATE, 'code': code}
    meta = safe(verify(case, raw(payload)))
    assert meta['status'] == 'not_started_acknowledged'
    assert meta['permission_stop'] is False


@pytest.mark.parametrize('index', [0, 1, 2])
def test_pipeline_error_is_unknown_even_with_permission(case, index):
    payload = success(case[2])
    payload['results'][index] = {'type': 'error', 'error': {'message': PRIVATE, 'code': 'AUTH'}}
    meta = unknown(verify(case, raw(payload)), 'permission_stop')
    assert meta['permission_stop'] is True


@pytest.mark.parametrize('kind', ['both', 'middle_skip', 'rollback_after_commit', 'commit_skip',
    'fault_without_rollback', 'two_faults', 'executed_after_fault', 'failed_rollback', 'begin_then_everything_skip'])
def test_contradictory_step_control_fails_closed(case, kind):
    packet = case[2]
    payload = success(packet)
    values, errors = arrays(payload)
    commit, rollback = packet.request_specs[0][2:]
    if kind == 'both':
        errors[1] = {'message': PRIVATE, 'code': 'UNKNOWN'}
    elif kind == 'middle_skip':
        values[1] = None
    elif kind == 'rollback_after_commit':
        values[rollback] = empty()
    elif kind == 'commit_skip':
        values[commit] = None
    elif kind == 'begin_then_everything_skip':
        values[1:] = [None] * (len(values) - 1)
    else:
        values[1:commit + 1] = [None] * commit
        errors[1] = {'message': PRIVATE, 'code': 'UNKNOWN'}
        if kind != 'fault_without_rollback':
            values[rollback] = empty()
        if kind == 'two_faults':
            errors[2] = {'message': PRIVATE, 'code': 'UNKNOWN'}
        elif kind == 'executed_after_fault':
            values[2] = guard() if packet.statement_specs[2][4][0] == 'guard' else empty()
        elif kind == 'failed_rollback':
            values[rollback] = None
            errors[rollback] = {'message': PRIVATE, 'code': 'UNKNOWN'}
    unknown(verify(case, raw(payload)))


@pytest.mark.parametrize('kind', ['autocommit_false', 'autocommit_int', 'baton', 'close_extra',
    'unknown_top_key', 'upper_key', 'results_short', 'results_long', 'batch_extra', 'step_short',
    'errors_long', 'step_wrong_type', 'error_wrong_type', 'stream_other', 'stream_user', 'stream_encoded_parent'])
def test_closed_envelope_and_lengths(case, kind):
    payload = success(case[2])
    values, errors = arrays(payload)
    if kind.startswith('autocommit'):
        payload['results'][1]['response']['is_autocommit'] = False if kind.endswith('false') else 1
    elif kind == 'baton':
        payload['baton'] = PRIVATE
    elif kind == 'close_extra':
        payload['results'][2]['response']['private'] = PRIVATE
    elif kind == 'unknown_top_key':
        payload['private'] = PRIVATE
    elif kind == 'upper_key':
        payload['Baton'] = None
    elif kind == 'results_short':
        payload['results'].pop()
    elif kind == 'results_long':
        payload['results'].append({'type': 'ok', 'response': {'type': 'close'}})
    elif kind == 'batch_extra':
        payload['results'][0]['response']['private'] = PRIVATE
    elif kind == 'step_short':
        values.pop()
    elif kind == 'errors_long':
        errors.append(None)
    elif kind == 'step_wrong_type':
        values[0] = True
    elif kind == 'error_wrong_type':
        values[0] = None
        errors[0] = PRIVATE
    elif kind == 'stream_other':
        payload['base_url'] = 'https://other.turso.io/v3/pipeline'
    elif kind == 'stream_user':
        payload['base_url'] = 'https://user@synthetic-candidate.turso.io/v3/pipeline'
    else:
        payload['base_url'] = 'https://synthetic-candidate.turso.io/%2e%2e/pipeline'
    unknown(verify(case, raw(payload)))


@pytest.mark.parametrize('cell', [{'type': 'float', 'value': 1.0}, {'type': 'integer', 'value': 1},
    {'type': 'integer', 'value': True}, {'type': 'integer', 'value': '01'},
    {'type': 'integer', 'value': '0'}, {'type': 'integer', 'value': '1', 'private': PRIVATE},
    {'type': 'text', 'value': '1'}, {'type': 'null'}, True])
def test_guard_native_wire_exact_one(case, cell):
    payload = success(case[2])
    arrays(payload)[0][1]['rows'] = [[cell]]
    unknown(verify(case, raw(payload)))


@pytest.mark.parametrize('kind', ['guard_col', 'guard_extra_row', 'guard_extra_cell', 'guard_decltype',
    'empty_cols', 'empty_rows', 'metric_bool', 'metric_negative', 'metric_over', 'rowid_int',
    'rowid_leading_zero', 'rowid_over', 'replication_int', 'replication_leading_zero',
    'replication_over', 'duration_bool', 'duration_negative', 'duration_over', 'metadata_extra'])
def test_statement_shapes_and_metadata(case, kind):
    payload = success(case[2])
    values, _ = arrays(payload)
    value = values[1]
    if kind == 'guard_col':
        value['cols'][0]['name'] = 'wrong'
    elif kind == 'guard_extra_row':
        value['rows'].append(value['rows'][0])
    elif kind == 'guard_extra_cell':
        value['rows'][0].append({'type': 'integer', 'value': '1'})
    elif kind == 'guard_decltype':
        value['cols'][0]['decltype'] = 1
    elif kind == 'empty_cols':
        values[0]['cols'] = [{'name': 'private'}]
    elif kind == 'empty_rows':
        values[0]['rows'] = [[]]
    elif kind.startswith('metric_'):
        value['affected_row_count'] = {'metric_bool': True, 'metric_negative': -1, 'metric_over': 2**53}[kind]
    elif kind.startswith('rowid_'):
        value['last_insert_rowid'] = {'rowid_int': 1, 'rowid_leading_zero': '01', 'rowid_over': str(2**63)}[kind]
    elif kind.startswith('replication_'):
        value['replication_index'] = {'replication_int': 1, 'replication_leading_zero': '01', 'replication_over': str(2**64)}[kind]
    elif kind.startswith('duration_'):
        value['query_duration_ms'] = {'duration_bool': True, 'duration_negative': -1, 'duration_over': 30001}[kind]
    else:
        value['private'] = PRIVATE
    unknown(verify(case, raw(payload)))


def test_valid_finite_optional_metrics_and_same_origin(case):
    payload = success(case[2])
    payload['base_url'] = 'https://synthetic-candidate.turso.io/v3/pipeline'
    values, _ = arrays(payload)
    for value in values[:-1]:
        value.update(affected_row_count=2**53 - 1, last_insert_rowid=str(-(2**63)),
                     rows_read=0, rows_written=0, query_duration_ms=30000, replication_index=str(2**64 - 1))
    payload['results'][0]['response']['result']['replication_index'] = None
    assert safe(verify(case, raw(payload)))['status'] == 'commit_acknowledged'


@pytest.mark.parametrize('value', [None, b'', b'{', b'\xff', b'{"baton":null,"baton":null,"results":[]}',
    b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e9999}', b'\xef\xbb\xbf{}', b'[]', b'null', True, [], 'private'])
def test_missing_malformed_and_nonbytes(case, value):
    unknown(verify(case, value))


def test_duplicate_key_nested_and_inverse_case_unknown(case):
    payload = success(case[2])
    data = raw(payload)
    needle = b'"affected_row_count":0'
    duplicated = data.replace(needle, needle + b',"affected_row_count":0', 1)
    unknown(verify(case, duplicated), 'response_protocol_invalid')
    for extra in (b'"Affected_Row_Count":0,' + needle, needle + b',"Affected_Row_Count":0'):
        unknown(verify(case, data.replace(needle, extra, 1)))


def test_preflight_depth_node_bytes_at_boundary_and_plus_one(case, monkeypatch):
    data = raw(success(case[2]))
    monkeypatch.setattr(v, 'MAX_BYTES', len(data))
    assert safe(verify(case, data))['status'] == 'commit_acknowledged'
    unknown(verify(case, data + b' '), 'response_limit')
    monkeypatch.setattr(v, 'MAX_BYTES', 64 * 1024 * 1024)
    depth_limit = b'[' * v.MAX_DEPTH + b'0' + b']' * v.MAX_DEPTH
    assert type(v._parse(depth_limit, v._Budget(v._now() + 30))) is list
    with pytest.raises(v.VerifierError, match='^response_limit$'):
        v._parse(b'[' + depth_limit + b']', v._Budget(v._now() + 30))
    monkeypatch.setattr(v, 'MAX_NODES', 3)
    assert v._parse(b'[0,1]', v._Budget(v._now() + 30)) == [0, 1]
    with pytest.raises(v.VerifierError, match='^response_limit$'):
        v._parse(b'[0,1,2]', v._Budget(v._now() + 30))


@pytest.mark.parametrize('field,limit', [('message', v.MAX_ERROR_BYTES), ('code', v.MAX_CODE_BYTES)])
def test_error_native_bounds(case, field, limit):
    payload = success(case[2])
    values, errors = arrays(payload)
    values[:] = [None] * len(values)
    errors[0] = {'message': PRIVATE, 'code': 'UNKNOWN'}
    errors[0][field] = 'x' * limit
    assert safe(verify(case, raw(payload)))['status'] == 'not_started_acknowledged'
    errors[0][field] += 'x'
    unknown(verify(case, raw(payload)), 'response_limit')


@pytest.mark.parametrize('error', [{}, {'message': PRIVATE, 'private': PRIVATE}, {'message': True},
    {'message': PRIVATE, 'code': None}, {'message': PRIVATE, 'code': True}])
def test_error_closed_native_shape(case, error):
    payload = success(case[2])
    values, errors = arrays(payload)
    values[:] = [None] * len(values)
    errors[0] = error
    unknown(verify(case, raw(payload)))


@pytest.mark.parametrize('field', ['expected_resource_sha256', 'expected_plan_sha256', 'expected_packet_sha256'])
def test_external_identity_mismatch(case, field):
    unknown(verify(case, raw(success(case[2])), **{field: 'a' * 64}), 'identity_invalid')


@pytest.mark.parametrize('origin', ['https://other.turso.io', 'https://user@synthetic-candidate.turso.io', None, True, PRIVATE])
def test_origin_must_normalize_and_match_external_resource(case, origin):
    unknown(verify(case, raw(success(case[2])), candidate_origin=origin), 'origin_mismatch')


@pytest.mark.parametrize('kind', ['metadata_remote', 'metadata_bool', 'metadata_extra', 'spec', 'body', 'resigned_body', 'recipe'])
def test_artifact_metadata_and_packet_tampering(case, kind):
    _, snapshot, packet, expected = case
    artifact = packet.artifact()
    identities = dict(expected)
    if kind.startswith('metadata'):
        pairs = list(artifact['metadata'])
        if kind == 'metadata_extra':
            pairs.append(('private', PRIVATE))
        else:
            key = 'remote_applied' if kind == 'metadata_remote' else 'receipt_rowid'
            pairs = [(name, True if name == key else value) for name, value in pairs]
        artifact['metadata'] = tuple(pairs)
    elif kind == 'spec':
        artifact['statement_specs'] = list(artifact['statement_specs'])
    elif kind in ('body', 'resigned_body'):
        artifact['body'] += b' '
        if kind == 'resigned_body':
            identities['expected_packet_sha256'] = hashlib.sha256(artifact['body']).hexdigest()
    else:
        artifact['recipe'] = (('created_at', '2026-10-04T00:00:00Z'), *artifact['recipe'][1:])
    result = v.verify_scope_response(snapshot, artifact, raw(success(packet)), candidate_origin=ORIGIN, **identities)
    unknown(result, 'identity_invalid')


def test_code_drift_before_and_after_interpretation(case, monkeypatch):
    original = compiler._current_code
    count = [0]

    def drift_after_response():
        count[0] += 1
        # A hook only on the local response analyzer simulates concurrent
        # source drift without editing any frozen repository file.
        if count[0] > 0:
            raise compiler.CompilerError('compiler_code_drift')
        return original()

    monkeypatch.setattr(compiler, '_current_code', drift_after_response)
    unknown(verify(case, raw(success(case[2]))), 'code_drift')


def test_code_drift_during_analyze_discards_prior_success(case, monkeypatch):
    original = v._analyze

    def changed(*args):
        result = original(*args)
        monkeypatch.setattr(compiler, '_current_code', lambda: (_ for _ in ()).throw(compiler.CompilerError('compiler_code_drift')))
        return result

    monkeypatch.setattr(v, '_analyze', changed)
    unknown(verify(case, raw(success(case[2]))), 'code_drift')


def test_budget_timeout_and_internal_failure_are_safe_unknown(case, monkeypatch):
    original_check = v._Budget.check
    monkeypatch.setattr(v._Budget, 'check', lambda self: v._reject('response_time_limit'))
    unknown(verify(case, raw(success(case[2]))), 'response_time_limit')
    monkeypatch.setattr(v._Budget, 'check', original_check)
    monkeypatch.setattr(v, '_parse', lambda *_args: (_ for _ in ()).throw(RuntimeError(PRIVATE)))
    unknown(verify(case, raw(success(case[2]))), 'verification_failed')


@pytest.mark.parametrize('clock', [float('nan'), float('inf'), float('-inf'), True])
def test_nonfinite_clock_is_fixed_unknown(case, monkeypatch, clock):
    monkeypatch.setattr(v.time, 'monotonic', lambda: clock)
    unknown(verify(case, raw(success(case[2]))), 'response_time_limit')


@pytest.mark.parametrize('data', [b'{"x":"\\ud800"}', b'{"\\ud800":0}', b'{"x":"\\udfff"}'])
def test_unpaired_unicode_surrogate_never_passes(case, data):
    unknown(verify(case, data), 'response_protocol_invalid')


def test_output_is_closed_immutable_false_and_private_markers_never_echo(case, capsys):
    payload = success(case[2])
    values, errors = arrays(payload)
    values[:] = [None] * len(values)
    errors[0] = {'message': PRIVATE, 'code': 'AUTH'}
    output, stderr = io.StringIO(), io.StringIO()
    with redirect_stdout(output), redirect_stderr(stderr):
        verdict = verify(case, raw(payload))
        meta = safe(verdict)
    assert output.getvalue() == '' and stderr.getvalue() == ''
    assert meta['permission_stop'] is True
    with pytest.raises(FrozenInstanceError):
        verdict.retry_allowed = True
    with pytest.raises(TypeError):
        replace(verdict, private=PRIVATE)
    meta['remote_applied'] = True
    assert verdict.safe_metadata['remote_applied'] is False
    for name in v._FLAGS:
        changed = replace(verdict)
        object.__setattr__(changed, name, True)
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            _ = changed.safe_metadata
    changed = replace(verdict)
    object.__setattr__(changed, 'permission_stop', False)
    with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
        _ = changed.safe_metadata
    assert PRIVATE not in capsys.readouterr().out


def test_guards_reject_network_files_config_and_real_credentials(case):
    assert not any(name in os.environ for name in ('TURSO_AUTH_TOKEN', 'TURSO_DATABASE_URL', 'RENDER_API_KEY', 'GITHUB_TOKEN'))
    for operation in (lambda: socket.socket(), lambda: socket.getaddrinfo('invalid', 443),
            lambda: db.get_conn(), lambda: db._turso_settings(), lambda: sqlite3.connect('not-a-memory-database')):
        with pytest.raises(AssertionError, match='^external_or_configured_access_forbidden$'):
            operation()
    assert safe(verify(case, raw(success(case[2]))))['retry_allowed'] is False


def test_file_guards_allow_only_fixed_trusted_source_reads(case):
    for operation in (lambda: Path('synthetic-never-read.env').open('rb'),
            lambda: builtins.open('synthetic-never-read.env'),
            lambda: v._VERIFIER_PATH.open('wb')):
        with pytest.raises(AssertionError, match='^external_or_configured_access_forbidden$'):
            operation()
    assert hashlib.sha256(v._VERIFIER_PATH.read_bytes()).hexdigest() == v._LOADED_VERIFIER_SHA


@pytest.mark.parametrize('state', ['commit_acknowledged', 'not_started_acknowledged', 'rollback_acknowledged'])
def test_confirmed_dto_constructor_and_replace_close_relations(case, state):
    reasons = {'commit_acknowledged': 'commit_acknowledged', 'not_started_acknowledged': 'begin_rejected',
               'rollback_acknowledged': 'transaction_rolled_back'}
    _, _, packet, expected = case
    options = dict(status=state, reason=reasons[state],
        resource_sha256=expected['expected_resource_sha256'], plan_sha256=expected['expected_plan_sha256'],
        packet_sha256=expected['expected_packet_sha256'], response_sha256=hashlib.sha256(raw(success(packet))).hexdigest(),
        verifier_sha256=v._LOADED_VERIFIER_SHA, identity_verified=True, session_closed_verified=True, permission_stop=False)
    original = v.ResponseVerdict(**options)
    assert safe(original)['response_contract_verified'] is True
    class Text(str):
        pass
    alterations = []
    for field in ('resource_sha256', 'plan_sha256', 'packet_sha256', 'response_sha256', 'verifier_sha256'):
        for value in (None, 'a' * 63, True, Text(options[field])):
            alterations.append({field: value})
    alterations.extend([{'permission_stop': True}, {'reason': 'permission_stop'}, {'reason': 'verification_failed'},
        {'identity_verified': False}, {'identity_verified': 1}, {'session_closed_verified': False},
        {'session_closed_verified': 1}, {'status': 'unknown_requires_reconcile'}, {'verifier_sha256': 'a' * 64}])
    for altered in alterations:
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            v.ResponseVerdict(**(options | altered))
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            replace(original, **altered)
        changed = replace(original)
        for field, value in altered.items():
            object.__setattr__(changed, field, value)
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            _ = changed.safe_metadata


def test_unknown_dto_cannot_claim_inconsistent_proofs(case):
    verdict = verify(case, None)
    unknown(verdict, 'response_missing')
    for altered in ({'identity_verified': False}, {'session_closed_verified': True}, {'permission_stop': True},
            {'reason': 'commit_acknowledged'}, {'reason': 'code_drift'}, {'response_sha256': 'a' * 64},
            {'resource_sha256': None}, {'reason': 'permission_stop'}):
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            replace(verdict, **altered)


@pytest.mark.parametrize('location', ['pipeline_last', 'step_last', 'bad_message', 'bad_message_large', 'guard_before_auth'])
def test_known_literal_permission_observed_before_other_protocol_failure(case, location):
    packet = case[2]
    payload = success(packet)
    values, errors = arrays(payload)
    if location == 'pipeline_last':
        payload['results'][0] = {'type': 'malformed'}
        payload['results'][2] = {'type': 'error', 'error': {'message': PRIVATE, 'code': 'AUTH'}}
    else:
        values[1] = True
        errors[-1] = {'message': PRIVATE, 'code': 'SQLITE_READONLY'}
        if location == 'bad_message':
            errors[-1]['message'] = True
        elif location == 'bad_message_large':
            errors[-1]['message'] = 'x' * (v.MAX_ERROR_BYTES + 1)
        elif location == 'guard_before_auth':
            values[1] = guard()
            values[1]['rows'][0][0]['value'] = '0'
    meta = unknown(verify(case, raw(payload)), 'permission_stop')
    assert meta['permission_stop'] is True


@pytest.mark.parametrize('location', ['arbitrary_nested', 'beyond_pipeline', 'beyond_steps', 'extra_error_key', 'foreign_origin'])
def test_arbitrary_auth_words_and_unbound_slots_never_set_permission(case, location):
    payload = success(case[2])
    if location == 'arbitrary_nested':
        payload['private'] = {'message': PRIVATE, 'code': 'AUTH'}
    elif location == 'beyond_pipeline':
        payload['results'].append({'type': 'error', 'error': {'message': PRIVATE, 'code': 'AUTH'}})
    else:
        _, errors = arrays(payload)
        if location == 'beyond_steps':
            errors.append({'message': PRIVATE, 'code': 'AUTH'})
        else:
            errors[-1] = {'message': PRIVATE, 'code': 'AUTH'}
            if location == 'extra_error_key':
                errors[-1]['private'] = PRIVATE
            else:
                payload['base_url'] = 'https://other.turso.io/v3/pipeline'
    assert unknown(verify(case, raw(payload)))['permission_stop'] is False


def test_permission_is_cleared_after_identity_or_code_qualification_is_lost(case, monkeypatch):
    payload = success(case[2])
    values, errors = arrays(payload)
    values[1] = None
    errors[1] = {'message': PRIVATE, 'code': 'AUTH'}
    original = v._analyze
    def drift(*args):
        try:
            return original(*args)
        finally:
            monkeypatch.setattr(v, '_current_verifier_code', lambda: v._reject('code_drift'))
    monkeypatch.setattr(v, '_analyze', drift)
    meta = unknown(verify(case, raw(payload)), 'code_drift')
    assert meta['identity_verified'] is False and meta['permission_stop'] is False
    assert meta['session_closed_verified'] is False


def test_own_source_digest_before_and_after_is_required(case, monkeypatch):
    original = v._current_verifier_code
    calls = [0]
    def drift_after():
        calls[0] += 1
        if calls[0] >= 2:
            v._reject('code_drift')
        return original()
    monkeypatch.setattr(v, '_current_verifier_code', drift_after)
    meta = unknown(verify(case, raw(success(case[2]))), 'code_drift')
    assert meta['identity_verified'] is False and meta['session_closed_verified'] is False


@pytest.mark.parametrize('point', ['rehydrate', 'analyze', 'final_sources', 'dto'])
def test_total_30_second_deadline_includes_all_stages(case, monkeypatch, point):
    clock = [100.0]
    monkeypatch.setattr(v, '_now', lambda: clock[0])
    if point == 'rehydrate':
        original = compiler.rehydrate_packet
        def slow(*args, **kwargs):
            result = original(*args, **kwargs)
            clock[0] += 30.001
            return result
        monkeypatch.setattr(compiler, 'rehydrate_packet', slow)
    elif point == 'analyze':
        original = v._analyze
        def slow(*args):
            result = original(*args)
            clock[0] += 30.001
            return result
        monkeypatch.setattr(v, '_analyze', slow)
    elif point == 'final_sources':
        original = v._current_verifier_code
        calls = [0]
        def slow():
            calls[0] += 1
            result = original()
            if calls[0] == 2:
                clock[0] += 30.001
            return result
        monkeypatch.setattr(v, '_current_verifier_code', slow)
    else:
        original = v.ResponseVerdict.__post_init__
        def slow(self):
            original(self)
            clock[0] += 30.001
        monkeypatch.setattr(v.ResponseVerdict, '__post_init__', slow)
    unknown(verify(case, raw(success(case[2]))), 'response_time_limit')


def test_budget_backward_clock_is_unknown(case, monkeypatch):
    readings = iter((100.0, 99.9))
    monkeypatch.setattr(v, '_now', lambda: next(readings, 99.9))
    unknown(verify(case, raw(success(case[2]))), 'response_time_limit')


def test_response_native_subclass_is_rejected(case):
    class Bytes(bytes):
        pass
    unknown(verify(case, Bytes(raw(success(case[2])))), 'response_type_invalid')


def test_preflight_escaped_brackets_quotes_and_duplicate_escaped_key(case):
    budget = v._Budget(v._now() + 30)
    assert v._parse(b'{"literal":"[\\\"{\\\\]"}', budget) == {'literal': '["{\\]'}
    data = raw(success(case[2]))
    unknown(verify(case, data.replace(b'"baton":null', b'"baton":null,"\\u0062aton":null', 1)), 'response_protocol_invalid')


@pytest.mark.parametrize('point', ['commit_without_rollback', 'begin_skip', 'close_error', 'autocommit_error'])
def test_control_failures_do_not_infer_automatic_rollback_or_completion(case, point):
    payload = success(case[2])
    values, errors = arrays(payload)
    commit, rollback = case[2].request_specs[0][2:]
    if point == 'commit_without_rollback':
        values[commit] = None
        errors[commit] = {'message': PRIVATE, 'code': 'SQLITE_IOERR'}
        values[rollback] = None
    elif point == 'begin_skip':
        values[:] = [None] * len(values)
    else:
        index = 2 if point == 'close_error' else 1
        payload['results'][index] = {'type': 'error', 'error': {'message': PRIVATE, 'code': 'UNKNOWN'}}
    unknown(verify(case, raw(payload)))


def test_compiler_time_limit_maps_unknown_not_identity_proof(case, monkeypatch):
    def timed_out(*_args, **_kwargs):
        raise compiler.CompilerError('compile_time_limit')
    monkeypatch.setattr(compiler, 'rehydrate_packet', timed_out)
    result = unknown(verify(case, raw(success(case[2]))), 'response_time_limit')
    assert result['identity_verified'] is False and result['session_closed_verified'] is False
