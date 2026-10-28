"""Memory-only Owner upgrade response contracts; never remote evidence."""
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import FrozenInstanceError, replace
import builtins
import hashlib
import io
import json
from pathlib import Path
import socket
import sqlite3

import pytest

from database import (db, exact_real, owner_sync_schema, turso_owner_upgrade_packet as compiler,
                      turso_owner_upgrade_response as v, turso_projection_repair,
                      turso_scope_response as parser, turso_scope_snapshot as capture,
                      turso_scope_upgrade as offline)
import test_turso_owner_upgrade_packet as fixture
from test_turso_scope_response import (PRIVATE, ORIGIN, arrays, empty,
                                      execute_synthetic, guard, raw, success)


def forbidden(*_args, **_kwargs):
    raise AssertionError('external_or_configured_access_forbidden')


@pytest.fixture(autouse=True)
def isolated_access(monkeypatch):
    for name in ('socket', 'create_connection', 'getaddrinfo'):
        monkeypatch.setattr(socket, name, forbidden)
    for name in ('get_conn', 'init_db', '_turso_settings'):
        monkeypatch.setattr(db, name, forbidden)
    monkeypatch.setattr(offline, '_scope_upgrade', forbidden)
    actual_connect = sqlite3.connect

    def memory_only(database, *args, **kwargs):
        if type(database) is not str or database != ':memory:':
            forbidden()
        return actual_connect(database, *args, **kwargs)

    monkeypatch.setattr(sqlite3, 'connect', memory_only)
    allowed = frozenset([*(path for _, path in compiler.c._CODE_FILES),
        *(Path(module.__file__).resolve() for module in
          (compiler, turso_projection_repair, owner_sync_schema, exact_real)),
        v._VERIFIER_PATH, v._PARSER_PATH])
    actual_path_open, actual_open = Path.open, builtins.open

    def mode_allowed(args, kwargs):
        mode = args[0] if args else kwargs.get('mode', 'r')
        if type(mode) is not str or mode not in ('r', 'rb'):
            forbidden()

    def path_open(path, *args, **kwargs):
        if path.resolve() not in allowed:
            forbidden()
        mode_allowed(args, kwargs)
        return actual_path_open(path, *args, **kwargs)

    def fixed_open(path, *args, **kwargs):
        if type(path) is not str or Path(path).resolve() not in allowed:
            forbidden()
        mode_allowed(args, kwargs)
        return actual_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'open', path_open)
    monkeypatch.setattr(builtins, 'open', fixed_open)


@pytest.fixture
def case(monkeypatch):
    # Real capture and real compiler/pins: no compiler/parser fixture patch.
    with fixture.captured() as (source, snapshot, _model):
        packet = fixture.compile_packet(snapshot)
        expected = fixture.identity(packet)
        monkeypatch.setattr(capture, 'capture_scope_snapshot', forbidden)
        yield source, snapshot, packet, expected


def verify(case, data, **overrides):
    _, snapshot, packet, expected = case
    options = dict(candidate_origin=ORIGIN, **expected)
    options.update(overrides)
    return v.verify_owner_upgrade_response(snapshot, packet.artifact(), data, **options)


def safe(verdict):
    assert type(verdict) is v.ResponseVerdict
    result = verdict.safe_metadata
    assert set(result) == v._PUBLIC_KEYS
    assert result['profile'] == v.PROFILE != parser.PROFILE
    assert result['evidence_scope'] == v.EVIDENCE_SCOPE
    assert result['compiler_sha256'] == v._LOADED_COMPILER_SHA
    assert result['parser_sha256'] == v._LOADED_PARSER_SHA
    for key in v._FLAGS:
        assert result[key] is False and type(result[key]) is bool
    assert PRIVATE not in repr(verdict) and PRIVATE not in json.dumps(result)
    return result


def unknown(verdict, reason=None):
    result = safe(verdict)
    assert result['status'] == 'unknown_requires_reconcile'
    assert result['requires_reconciliation'] is True
    assert result['response_contract_verified'] is False
    assert result['commit_acknowledged'] is False
    if reason is not None:
        assert result['reason'] == reason
    return result


def test_real_owner_packet_sql_acknowledges_full_target_but_not_remote(case):
    source, snapshot, packet, _expected = case
    source_image, capture_image = source.serialize(), snapshot.connection.serialize()
    payload, records = execute_synthetic(source, packet)
    assert records['_schema_version'][1] == [(1, 1, 9)]
    assert records['owner_sync_state'][1] == [(1, 1, 0)]
    assert records['owner_sync_schema'][1] == [(1, 1, owner_sync_schema.OWNER_SYNC_SCHEMA_VERSION)]
    result = safe(verify(case, raw(payload)))
    assert result['status'] == 'commit_acknowledged'
    assert result['identity_verified'] is True and result['session_closed_verified'] is True
    assert result['requires_reconciliation'] is False
    assert source.serialize() == source_image and snapshot.connection.serialize() == capture_image


def test_every_actual_executable_fault_prefix_has_exact_rollback(case):
    source, _snapshot, packet, _expected = case
    before = offline._rows_digest(fixture.synthetic.records(source))
    commit = packet.request_specs[0][2]
    for index in range(commit + 1):
        payload, records = execute_synthetic(source, packet, (index,))
        result = safe(verify(case, raw(payload)))
        assert result['status'] == ('not_started_acknowledged' if index == 0 else 'rollback_acknowledged'), (index, result['reason'])
        assert result['permission_stop'] is False
        assert offline._rows_digest(records) == before


@pytest.mark.parametrize('kind', ['both', 'skip', 'rollback_after_commit', 'commit_skip',
    'fault_no_rollback', 'two_faults', 'execute_after_fault', 'rollback_fault', 'all_skip'])
def test_contradictory_fsm_is_unknown_and_never_retry(case, kind):
    packet = case[2]
    payload = success(packet)
    values, errors = arrays(payload)
    commit, rollback = packet.request_specs[0][2:]
    if kind == 'both':
        errors[1] = {'message': PRIVATE, 'code': 'UNKNOWN'}
    elif kind == 'skip':
        values[1] = None
    elif kind == 'rollback_after_commit':
        values[rollback] = empty()
    elif kind == 'commit_skip':
        values[commit] = None
    elif kind == 'all_skip':
        values[:] = [None] * len(values)
    else:
        values[1:commit + 1] = [None] * commit
        errors[1] = {'message': PRIVATE, 'code': 'UNKNOWN'}
        if kind != 'fault_no_rollback':
            values[rollback] = empty()
        if kind == 'two_faults':
            errors[2] = {'message': PRIVATE, 'code': 'UNKNOWN'}
        elif kind == 'execute_after_fault':
            values[2] = guard() if packet.statement_specs[2][4][0] == 'guard' else empty()
        elif kind == 'rollback_fault':
            values[rollback] = None
            errors[rollback] = {'message': PRIVATE, 'code': 'UNKNOWN'}
    unknown(verify(case, raw(payload)))


@pytest.mark.parametrize('point', [0, 1, 2])
@pytest.mark.parametrize('code', sorted(parser._PERMISSION))
def test_literal_bound_permission_pipeline_errors_stop(case, point, code):
    payload = success(case[2])
    payload['results'][point] = {'type': 'error', 'error': {'message': PRIVATE, 'code': code}}
    assert unknown(verify(case, raw(payload)), 'permission_stop')['permission_stop'] is True


@pytest.mark.parametrize('kind', ['last_step', 'bad_message', 'large_message', 'earlier_bad_guard'])
def test_bound_literal_permission_survives_other_protocol_errors(case, kind):
    payload = success(case[2])
    values, errors = arrays(payload)
    errors[-1] = {'message': PRIVATE, 'code': 'SQLITE_READONLY'}
    values[1] = True
    if kind == 'bad_message':
        errors[-1]['message'] = False
    elif kind == 'large_message':
        errors[-1]['message'] = 'x' * (parser.MAX_ERROR_BYTES + 1)
    elif kind == 'earlier_bad_guard':
        values[1] = guard()
        values[1]['rows'][0][0]['value'] = '0'
    assert unknown(verify(case, raw(payload)), 'permission_stop')['permission_stop'] is True


@pytest.mark.parametrize('kind', ['foreign', 'arbitrary', 'beyond_pipeline', 'beyond_steps', 'extra_error_key', 'message_only'])
def test_unbound_permission_words_do_not_set_stop(case, kind):
    payload = success(case[2])
    values, errors = arrays(payload)
    if kind == 'arbitrary':
        payload['private'] = {'message': PRIVATE, 'code': 'AUTH'}
    elif kind == 'beyond_pipeline':
        payload['results'].append({'type': 'error', 'error': {'message': PRIVATE, 'code': 'AUTH'}})
    elif kind == 'beyond_steps':
        errors.append({'message': PRIVATE, 'code': 'AUTH'})
    elif kind == 'message_only':
        values[:] = [None] * len(values)
        errors[0] = {'message': 'AUTH ' + PRIVATE, 'code': 'SQLITE_BUSY'}
    else:
        errors[-1] = {'message': PRIVATE, 'code': 'AUTH'}
        if kind == 'extra_error_key':
            errors[-1]['private'] = PRIVATE
        else:
            payload['base_url'] = 'https://other.turso.io/v3/pipeline'
    result = safe(verify(case, raw(payload)))
    assert result['permission_stop'] is False


@pytest.mark.parametrize('data', [None, b'', b'{', b'\xff', b'null', b'[]',
    b'{"baton":null,"baton":null,"results":[]}', b'{"x":NaN}', b'{"x":1e9999}',
    b'{"x":"\\ud800"}', b'\xef\xbb\xbf{}', True, [], PRIVATE])
def test_missing_corrupt_partial_and_non_native_bytes_are_unknown(case, data):
    unknown(verify(case, data))


def test_native_bytes_subclass_rejected(case):
    class Bytes(bytes):
        pass
    unknown(verify(case, Bytes(raw(success(case[2])))), 'response_type_invalid')


@pytest.mark.parametrize('kind', ['autocommit_false', 'autocommit_int', 'baton', 'close_extra',
    'results_short', 'results_long', 'step_short', 'error_long', 'guard_zero', 'guard_float',
    'guard_bool', 'empty_rows', 'count_bool', 'replication_leading_zero', 'duration_over'])
def test_closed_envelope_exact_guard_and_native_metrics(case, kind):
    payload = success(case[2])
    values, errors = arrays(payload)
    if kind.startswith('autocommit_'):
        payload['results'][1]['response']['is_autocommit'] = False if kind.endswith('false') else 1
    elif kind == 'baton':
        payload['baton'] = PRIVATE
    elif kind == 'close_extra':
        payload['results'][2]['response']['private'] = PRIVATE
    elif kind == 'results_short':
        payload['results'].pop()
    elif kind == 'results_long':
        payload['results'].append({'type': 'ok', 'response': {'type': 'close'}})
    elif kind == 'step_short':
        values.pop()
    elif kind == 'error_long':
        errors.append(None)
    elif kind.startswith('guard_'):
        values[1]['rows'][0][0] = {'type': 'float', 'value': 1.0} if kind.endswith('float') else {
            'type': 'integer', 'value': True if kind.endswith('bool') else '0'}
    elif kind == 'empty_rows':
        values[0]['rows'] = [[]]
    elif kind == 'count_bool':
        values[1]['affected_row_count'] = True
    elif kind == 'replication_leading_zero':
        values[1]['replication_index'] = '01'
    else:
        values[1]['query_duration_ms'] = 30001
    unknown(verify(case, raw(payload)))


@pytest.mark.parametrize('name', ['expected_resource_sha256', 'expected_plan_sha256', 'expected_packet_sha256'])
@pytest.mark.parametrize('value', ['a' * 64, 'A' * 64, None, True])
def test_only_external_original_shas_can_admit_packet(case, name, value):
    result = unknown(verify(case, raw(success(case[2])), **{name: value}), 'identity_invalid')
    assert result['identity_verified'] is False


@pytest.mark.parametrize('origin', ['https://other.turso.io', 'https://user@synthetic-candidate.turso.io',
    'https://synthetic-candidate.turso.io/path', None, False, PRIVATE])
def test_origin_must_be_closed_and_match_resource(case, origin):
    result = unknown(verify(case, raw(success(case[2])), candidate_origin=origin), 'origin_mismatch')
    assert result['identity_verified'] is False and result['permission_stop'] is False


@pytest.mark.parametrize('kind', ['profile', 'metadata', 'remote', 'body', 'resealed_body', 'recipe', 'specs', 'extra'])
def test_owner_artifact_tampering_never_enters_old_verifier(case, monkeypatch, kind):
    _source, snapshot, packet, expected = case
    artifact, identity = packet.artifact(), dict(expected)
    monkeypatch.setattr(parser, 'verify_scope_response', forbidden)
    monkeypatch.setattr(compiler.c, 'rehydrate_packet', forbidden)
    if kind == 'profile':
        artifact['profile'] = compiler.c.ARTIFACT_PROFILE
    elif kind == 'metadata':
        artifact['metadata'] = list(artifact['metadata'])
    elif kind == 'remote':
        artifact['metadata'] = tuple((name, True if name == 'remote_applied' else value)
                                     for name, value in artifact['metadata'])
    elif kind in {'body', 'resealed_body'}:
        artifact['body'] += b' '
        if kind == 'resealed_body':
            identity['expected_packet_sha256'] = hashlib.sha256(artifact['body']).hexdigest()
    elif kind == 'recipe':
        artifact['recipe'] = list(artifact['recipe'])
    elif kind == 'specs':
        artifact['statement_specs'] = list(artifact['statement_specs'])
    else:
        artifact['token'] = PRIVATE
    result = v.verify_owner_upgrade_response(snapshot, artifact, raw(success(packet)),
                                             candidate_origin=ORIGIN, **identity)
    unknown(result, 'identity_invalid')


def test_old_public_entry_and_old_admission_are_not_used_for_valid_owner_packet(case, monkeypatch):
    monkeypatch.setattr(parser, 'verify_scope_response', forbidden)
    monkeypatch.setattr(compiler.c, 'rehydrate_packet', forbidden)
    assert safe(verify(case, raw(success(case[2]))))['status'] == 'commit_acknowledged'


@pytest.mark.parametrize('state', ['commit_acknowledged', 'not_started_acknowledged', 'rollback_acknowledged'])
def test_dto_constructor_replace_mutation_and_reseal_close_every_proof(case, state):
    reasons = {'commit_acknowledged': 'commit_acknowledged',
               'not_started_acknowledged': 'begin_rejected', 'rollback_acknowledged': 'transaction_rolled_back'}
    _, _, packet, expected = case
    options = dict(status=state, reason=reasons[state],
        resource_sha256=expected['expected_resource_sha256'], plan_sha256=expected['expected_plan_sha256'],
        packet_sha256=expected['expected_packet_sha256'], response_sha256=hashlib.sha256(raw(success(packet))).hexdigest(),
        verifier_sha256=v._LOADED_VERIFIER_SHA, identity_verified=True, session_closed_verified=True, permission_stop=False)
    original = v.ResponseVerdict(**options)
    assert safe(original)['response_contract_verified'] is True
    class Text(str):
        pass
    alterations = [{'identity_verified': False}, {'identity_verified': 1}, {'permission_stop': True},
        {'session_closed_verified': False}, {'session_closed_verified': 1}, {'reason': 'permission_stop'},
        {'reason': 'verification_failed'}, {'status': 'unknown_requires_reconcile'}, {'verifier_sha256': 'a' * 64}]
    for key in ('resource_sha256', 'plan_sha256', 'packet_sha256', 'response_sha256', 'verifier_sha256'):
        alterations.extend({key: value} for value in (None, True, 'a' * 63, Text(options[key])))
    for altered in alterations:
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            v.ResponseVerdict(**(options | altered))
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            replace(original, **altered)
        forged = replace(original)
        for name, value in altered.items():
            object.__setattr__(forged, name, value)
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            _ = forged.safe_metadata
    for name in (*v._FLAGS, 'parser_sha256', 'compiler_sha256', 'contract_code_sha256'):
        forged = replace(original)
        object.__setattr__(forged, name, True if name in v._FLAGS else 'a' * 64)
        # A caller-controlled seal cannot grant remote authority or new pins.
        object.__setattr__(forged, '_seal', 'a' * 64)
        with pytest.raises(v.VerifierError, match='^result_integrity_invalid$'):
            _ = forged.safe_metadata
    with pytest.raises(FrozenInstanceError):
        original.retry_allowed = True
    metadata = original.safe_metadata
    metadata['remote_applied'] = True
    assert original.safe_metadata['remote_applied'] is False


@pytest.mark.parametrize('point', ['own', 'parser', 'compiler', 'analyze', 'constructor', 'getter'])
def test_all_source_pins_before_after_and_inside_dto_discard_success(case, monkeypatch, point):
    if point in {'own', 'parser', 'compiler'}:
        if point == 'own':
            monkeypatch.setattr(v, '_verifier_code_digest', lambda: 'a' * 64)
        elif point == 'parser':
            monkeypatch.setattr(parser, '_current_verifier_code', lambda: parser._reject('code_drift'))
        else:
            monkeypatch.setattr(compiler, '_current_code', lambda: compiler._fail('compiler_code_drift'))
    elif point == 'analyze':
        original = parser._analyze
        def changed(*args):
            result = original(*args)
            monkeypatch.setattr(v, '_verifier_code_digest', lambda: 'a' * 64)
            return result
        monkeypatch.setattr(parser, '_analyze', changed)
    elif point == 'constructor':
        original = v.ResponseVerdict._values
        def changed(self):
            result = original(self)
            monkeypatch.setattr(v, '_verifier_code_digest', lambda: 'a' * 64)
            return result
        monkeypatch.setattr(v.ResponseVerdict, '_values', changed)
    else:
        original = v.ResponseVerdict.safe_metadata.fget
        def changed(self):
            result = original(self)
            monkeypatch.setattr(v, '_verifier_code_digest', lambda: 'a' * 64)
            return result
        monkeypatch.setattr(v.ResponseVerdict, 'safe_metadata', property(changed))
    result = unknown(verify(case, raw(success(case[2]))), 'code_drift')
    assert result['identity_verified'] is False and result['session_closed_verified'] is False
    assert result['permission_stop'] is False


def test_success_dto_constructor_and_getter_fail_after_source_drift(case, monkeypatch):
    verdict = verify(case, raw(success(case[2])))
    monkeypatch.setattr(v, '_verifier_code_digest', lambda: 'a' * 64)
    with pytest.raises(v.VerifierError, match='^code_drift$'):
        replace(verdict)
    with pytest.raises(v.VerifierError, match='^code_drift$'):
        _ = verdict.safe_metadata


@pytest.mark.parametrize('code,reason', [('compiler_code_drift', 'code_drift'),
                                      ('source_identity_mismatch', 'identity_invalid')])
def test_transient_post_admission_metadata_error_never_recovers_identity(case, monkeypatch, code, reason):
    original_rehydrate = compiler.rehydrate_packet
    original_metadata = compiler.CompiledOwnerPacket.safe_metadata.fget
    admitted, failed = [], []

    def rehydrate(*args, **kwargs):
        result = original_rehydrate(*args, **kwargs)
        admitted.append(True)
        return result

    def once_after_real_validation(self):
        result = original_metadata(self)
        if admitted and not failed:
            failed.append(True)
            raise compiler.CompilerError(code)
        return result

    monkeypatch.setattr(compiler, 'rehydrate_packet', rehydrate)
    monkeypatch.setattr(compiler.CompiledOwnerPacket, 'safe_metadata', property(once_after_real_validation))
    result = unknown(verify(case, raw(success(case[2]))), reason)
    assert admitted == [True] and failed == [True]
    assert result['identity_verified'] is False and result['session_closed_verified'] is False
    assert result['permission_stop'] is False


@pytest.mark.parametrize('point', ['rehydrate', 'parse', 'analyze', 'final_sources', 'constructor', 'getter'])
def test_original_total_deadline_includes_every_stage(case, monkeypatch, point):
    clock = [100.0]
    monkeypatch.setattr(v, '_now', lambda: clock[0])
    if point == 'rehydrate':
        module, name = compiler, 'rehydrate_packet'
    elif point in {'parse', 'analyze'}:
        module, name = parser, '_' + point
    elif point == 'final_sources':
        original = v._current_verifier_code
        calls = []
        def slow():
            result = original()
            calls.append(True)
            if len(calls) == 2:
                clock[0] += 30.001
            return result
        monkeypatch.setattr(v, '_current_verifier_code', slow)
        module = None
    elif point == 'constructor':
        module, name = v.ResponseVerdict, '__post_init__'
    else:
        original = v.ResponseVerdict.safe_metadata.fget
        def slow(self):
            result = original(self)
            clock[0] += 30.001
            return result
        monkeypatch.setattr(v.ResponseVerdict, 'safe_metadata', property(slow))
        module = None
    if module is not None:
        original = getattr(module, name)
        def slow(*args, **kwargs):
            result = original(*args, **kwargs)
            clock[0] += 30.001
            return result
        monkeypatch.setattr(module, name, slow)
    unknown(verify(case, raw(success(case[2]))), 'response_time_limit')


@pytest.mark.parametrize('clock', [float('nan'), float('inf'), float('-inf'), True])
def test_unusable_clock_can_only_publish_unqualified_timeout(case, monkeypatch, clock):
    monkeypatch.setattr(v.time, 'monotonic', lambda: clock)
    result = unknown(verify(case, raw(success(case[2]))), 'response_time_limit')
    assert result['identity_verified'] is False and result['session_closed_verified'] is False


def test_backward_clock_is_unknown(case, monkeypatch):
    readings = iter((100.0, 99.9))
    monkeypatch.setattr(v, '_now', lambda: next(readings, 99.9))
    unknown(verify(case, raw(success(case[2]))), 'response_time_limit')


@pytest.mark.parametrize('point', ['constructor', 'getter'])
def test_direct_dto_budget_starts_before_native_value_validation(case, monkeypatch, point):
    verdict = verify(case, raw(success(case[2])))
    clock = [100.0]
    monkeypatch.setattr(v, '_now', lambda: clock[0])
    original = v.ResponseVerdict._values

    def slow(self):
        result = original(self)
        clock[0] += 30.001
        return result

    monkeypatch.setattr(v.ResponseVerdict, '_values', slow)
    with pytest.raises(v.VerifierError, match='^response_time_limit$'):
        if point == 'constructor':
            replace(verdict)
        else:
            _ = verdict.safe_metadata


@pytest.mark.parametrize('clock', [float('nan'), float('inf'), True])
def test_bound_auth_then_unusable_clock_returns_unqualified_unknown_not_exception(case, monkeypatch, clock):
    payload = success(case[2])
    values, errors = arrays(payload)
    values[:] = [None] * len(values)
    errors[0] = {'message': PRIVATE, 'code': 'AUTH'}
    original = parser._analyze

    def became_unmeasurable(*args):
        result = original(*args)
        monkeypatch.setattr(v.time, 'monotonic', lambda: clock)
        return result

    monkeypatch.setattr(parser, '_analyze', became_unmeasurable)
    result = unknown(verify(case, raw(payload)), 'response_time_limit')
    assert result['identity_verified'] is False and result['permission_stop'] is False
    assert result['session_closed_verified'] is False and result['retry_allowed'] is False


def test_bound_auth_and_finite_outer_timeout_remains_stop_no_retry(case, monkeypatch):
    payload = success(case[2])
    values, errors = arrays(payload)
    values[:] = [None] * len(values)
    errors[0] = {'message': PRIVATE, 'code': 'AUTH'}
    clock = [100.0]
    monkeypatch.setattr(v, '_now', lambda: clock[0])
    original = parser._analyze

    def slow(*args):
        result = original(*args)
        clock[0] += 30.001
        return result

    monkeypatch.setattr(parser, '_analyze', slow)
    result = unknown(verify(case, raw(payload)), 'permission_stop')
    assert result['identity_verified'] is True and result['permission_stop'] is True
    assert result['retry_allowed'] is False


def test_failed_budget_checker_still_returns_closed_unqualified_timeout(case, monkeypatch):
    monkeypatch.setattr(v._Budget, 'check', lambda _: v._reject('response_time_limit'))
    result = unknown(verify(case, raw(success(case[2]))), 'response_time_limit')
    assert result['identity_verified'] is False


def test_size_bound_and_parser_exception_are_safe_unknown(case, monkeypatch):
    data = raw(success(case[2]))
    monkeypatch.setattr(v, 'MAX_BYTES', len(data))
    assert safe(verify(case, data))['status'] == 'commit_acknowledged'
    unknown(verify(case, data + b' '), 'response_limit')
    monkeypatch.setattr(parser, '_parse', lambda *_: (_ for _ in ()).throw(RuntimeError(PRIVATE)))
    unknown(verify(case, data), 'verification_failed')


def test_empty_output_and_fixed_file_network_guards(case):
    output, errors = io.StringIO(), io.StringIO()
    with redirect_stdout(output), redirect_stderr(errors):
        safe(verify(case, raw(success(case[2]))))
    assert output.getvalue() == '' and errors.getvalue() == ''
    for action in (lambda: socket.socket(), lambda: db.get_conn(),
                   lambda: sqlite3.connect('not-memory'), lambda: Path('never-read.env').open('rb'),
                   lambda: v._VERIFIER_PATH.open('wb')):
        with pytest.raises(AssertionError, match='^external_or_configured_access_forbidden$'):
            action()
