"""Only synthetic memory/protocol tests; never remote or durable evidence."""
import base64
import builtins
from copy import deepcopy
from dataclasses import FrozenInstanceError
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import time

import pytest

from database import db, turso_scope_packet as compiler, turso_scope_response as parser
from database import turso_scope_snapshot as capture, turso_scope_upgrade as offline
from database import turso_scope_reconcile as v
import turso_scope_packet_fixtures as s

ORIGIN = 'libsql://synthetic-candidate.turso.io'
PRIVATE = 'synthetic-private-marker-never-real'
PINS = {
    'turso_scope_packet.py': 'ee01ad893e1db5c8cac4fdc082f2f0c00e2df3568b4d80a6c557f6d6eb0263e0',
    'turso_scope_response.py': '313078fceff4c093cdc92181d5d888278d3c815bfeb818fe464ea56e533de7de',
    'turso_scope_snapshot.py': '78d0801fba7e78bd8b72a909c8bdb2acee5e8f4a7d63e038f543ed02df4faa0d',
    'turso_scope_upgrade.py': '08d7d530f188f7764f3cc6959d1d77ad054adaa57a6d317277f9d49e2cfd8a1c',
}


def forbidden(*args, **kwargs):
    raise AssertionError('external_or_configured_access_forbidden')


@pytest.fixture
def call(monkeypatch):
    """Guards exist only around candidate calls, not pytest's own reporting."""
    allowed = frozenset([*(path for _, path in compiler._CODE_FILES),
                         parser._VERIFIER_PATH, v._OWN_PATH])
    real_connect = sqlite3.connect
    real_path_open, real_open, real_io_open = Path.open, builtins.open, io.open

    def read_mode(args, kwargs):
        mode = args[0] if args else kwargs.get('mode', 'r')
        if type(mode) is not str or mode not in ('r', 'rb'):
            forbidden()

    def fixed_path_open(path, *args, **kwargs):
        if path.resolve() not in allowed:
            forbidden()
        read_mode(args, kwargs)
        return real_path_open(path, *args, **kwargs)

    def fixed_open(path, *args, **kwargs):
        if type(path) not in (str, Path) or Path(path).resolve() not in allowed:
            forbidden()
        read_mode(args, kwargs)
        return real_open(path, *args, **kwargs)

    def fixed_io_open(path, *args, **kwargs):
        if not isinstance(path, (str, Path)) or Path(path).resolve() not in allowed:
            forbidden()
        read_mode(args, kwargs)
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
            scope.setattr(capture, 'capture_scope_snapshot', forbidden)
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
    modules = (compiler, parser, capture, offline)
    for module in modules:
        path = Path(module.__file__).resolve()
        assert hashlib.sha256(path.read_bytes()).hexdigest() == PINS[path.name]
    with s.captured() as (source, snapshot):
        packet = s.compile_packet(snapshot)
        # Pin from the known synthetic creation BEFORE copies are tampered.
        # Production callers must independently retain these before sending.
        external = dict(s.identity(packet))
        yield source, snapshot, packet, external


def options(case, schema):
    return dict(candidate_origin=ORIGIN, read_schema=schema, **dict(case[3]))


def build(call, case, schema=9, **overrides):
    source, snapshot, packet, external = case
    kwargs = options(case, schema)
    kwargs.update(overrides)
    return call(v.build_scope_reconcile_read, snapshot, packet.artifact(), **kwargs)


def verify(call, case, response, schema=9, *, artifact=None, **overrides):
    _, snapshot, packet, _ = case
    kwargs = options(case, schema)
    kwargs.update(overrides)
    original = packet.artifact() if artifact is None else artifact
    return call(v.verify_scope_reconcile_read, snapshot, original, response, **kwargs)


def raw(payload):
    return json.dumps(payload, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def arrays(payload):
    result = payload['results'][0]['response']['result']
    return result['step_results'], result['step_errors']


def index(body, label):
    steps = json.loads(body)['requests'][0]['batch']['steps']
    for offset, step in enumerate(steps):
        sql = step['stmt']['sql']
        if label == 'receipt' and sql.startswith('SELECT rowid,* FROM main."idempotency_responses" WHERE'):
            return offset
        if label.startswith('table:') and sql == 'SELECT rowid,* FROM main."' + label[6:] + '" ORDER BY rowid LIMIT 100001':
            return offset
        if label == 'schema' and sql.startswith('SELECT type,name,tbl_name,sql FROM main.sqlite_master'):
            return offset
        if label in ('begin', 'commit', 'rollback') and sql == label.upper():
            return offset
        if label == 'header' and sql == 'PRAGMA main.user_version':
            return offset
    raise AssertionError('synthetic_label_missing')


def execute_read(source, body):
    """Only generated fixed-read SQL over a supplied synthetic memory DB."""
    request = json.loads(body)
    values, errors, states = [], [], []
    for step in request['requests'][0]['batch']['steps']:
        if 'condition' in step and not s.condition(source, step['condition'], states):
            values.append(None)
            errors.append(None)
            states.append(None)
            continue
        stmt = step['stmt']
        assert stmt['named_args'] == []
        assert stmt['want_rows'] is True
        cursor = source.execute(stmt['sql'], tuple(s.decode(value) for value in stmt['args']))
        values.append({'cols': [{'name': col[0], 'decltype': None} for col in (cursor.description or ())],
            'rows': [[s.fixtures.encode(value) for value in row] for row in cursor.fetchall()],
            'affected_row_count': 0, 'last_insert_rowid': None})
        errors.append(None)
        states.append(True)
    return {'baton': None, 'base_url': 'https://synthetic-candidate.turso.io/v3', 'results': [
        {'type': 'ok', 'response': {'type': 'batch', 'result': {'step_results': values, 'step_errors': errors}}},
        {'type': 'ok', 'response': {'type': 'get_autocommit', 'is_autocommit': not source.in_transaction}},
        {'type': 'ok', 'response': {'type': 'close'}}]}


def payload(call, case, schema=9):
    source, _, packet, _ = case
    body = build(call, case, schema)
    target = s.clone(source)
    try:
        if schema == 9:
            assert s.execute_packet(target, packet)['committed'] is True
        before = (compiler._schema_rows(target), offline._rows_digest(s.records(target)))
        result = execute_read(target, body)
        assert (compiler._schema_rows(target), offline._rows_digest(s.records(target))) == before
        return body, result
    finally:
        target.close()


def safe(call, verdict, status=None, reason=None):
    meta = call(lambda: verdict.safe_metadata)
    assert set(meta) == v._PUBLIC_KEYS
    assert meta['profile'] == v.PROFILE
    assert meta['evidence_scope'] == v.EVIDENCE_SCOPE
    assert all(meta[key] is False for key in v._FLAGS)
    assert PRIVATE not in repr(verdict) and PRIVATE not in json.dumps(meta)
    if status is not None:
        assert meta['status'] == status
    if reason is not None:
        assert meta['reason'] == reason
    return meta


@pytest.mark.parametrize('schema,status,reason', [(8, 'missing', 'missing_preimage'),
    (9, 'matched', 'matched_postimage')], ids=('before', 'after'))
def test_exact_full_synthetic_images_never_authorize_retry(call, case, schema, status, reason):
    body, value = payload(call, case, schema)
    safe(call, verify(call, case, raw(value), schema), status, reason)
    steps = json.loads(body)['requests'][0]['batch']['steps']
    sqls = [step['stmt']['sql'] for step in steps]
    assert sqls[0] == 'BEGIN' and sqls[-2:] == ['COMMIT', 'ROLLBACK']
    assert not any(sql.startswith(('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER')) for sql in sqls)
    assert not any(sql.startswith('PRAGMA') and '=' in sql for sql in sqls)
    assert 'BEGIN IMMEDIATE' not in sqls
    assert json.loads(body)['requests'][0]['batch']['steps'][-1]['condition']['conds'][0] == {
        'type': 'not', 'cond': {'type': 'ok', 'step': len(steps) - 2}}


@pytest.mark.parametrize('mutation', ('same_count', 'missing', 'extra', 'receipt_only', 'count_only'), ids=('swap', 'less', 'more', 'receipt', 'counts'))
def test_full_rows_not_receipt_or_count_only(call, case, mutation):
    body, value = payload(call, case)
    values, _ = arrays(value)
    slot = index(body, 'table:funds')
    if mutation == 'same_count':
        values[slot]['rows'][0][2] = {'type': 'text', 'value': 'different-same-count'}
    elif mutation == 'missing':
        values[slot]['rows'].pop()
    elif mutation == 'extra':
        values[slot]['rows'].append(deepcopy(values[slot]['rows'][-1]))
    elif mutation == 'receipt_only':
        for offset, step in enumerate(json.loads(body)['requests'][0]['batch']['steps']):
            if step['stmt']['sql'].startswith('SELECT rowid,*') and offset != index(body, 'receipt'):
                values[offset]['rows'] = []
    else:
        values[slot]['rows'] = [[{'type': 'integer', 'value': '3'}]]
        values[slot]['cols'] = [{'name': 'COUNT(*)'}]
    safe(call, verify(call, case, raw(value)), 'unknown')


@pytest.mark.parametrize('kind,replacement', [('integer', {'type': 'text', 'value': '1'}),
    ('null', {'type': 'integer', 'value': '0'}), ('float', {'type': 'float', 'value': -0.0}),
    ('text', {'type': 'blob', 'base64': 'eA=='}), ('text', {'type': 'text', 'value': 'synthetic\u0000changed'})],
    ids=('int-text', 'null-zero', 'sign-zero', 'text-blob', 'nul-tail'))
def test_native_types_null_blob_and_signed_zero_are_exact(call, case, kind, replacement):
    body, value = payload(call, case)
    values, _ = arrays(value)
    selected = None
    for result in values:
        if result is None:
            continue
        for row in result['rows']:
            for position, cell in enumerate(row):
                if cell['type'] == kind and (kind != 'float' or cell.get('value') == 0.0):
                    selected = row, position
                    break
            if selected:
                break
        if selected:
            break
    assert selected is not None
    selected[0][selected[1]] = replacement
    safe(call, verify(call, case, raw(value)), 'unknown')


def test_blob_bytes_supported_without_text_normalization(call):
    def seed(source):
        source.execute('UPDATE funds SET pinyin=? WHERE code=?', (b'\x00\xffbinary', '000001'))
        source.commit()
    with s.captured(mutate=seed) as (source, snapshot):
        packet = s.compile_packet(snapshot)
        original = source, snapshot, packet, dict(s.identity(packet))
        body, value = payload(call, original)
        safe(call, verify(call, original, raw(value)), 'matched')
        values, _ = arrays(value)
        row = values[index(body, 'table:funds')]['rows'][0]
        assert row[-1]['type'] == 'blob'
        row[-1]['base64'] = base64.b64encode(b'\x00\xfebinary').decode('ascii')
        safe(call, verify(call, original, raw(value)), 'unknown')


@pytest.mark.parametrize('mutation', ('whitespace', 'literal', 'null'), ids=('space', 'literal', 'null'))
def test_raw_schema_sql_never_normalized(call, case, mutation):
    body, value = payload(call, case)
    rows = arrays(value)[0][index(body, 'schema')]['rows']
    row = next(row for row in rows if row[3]['type'] == 'text'
               and (mutation != 'literal' or "'" in row[3]['value']))
    if mutation == 'null':
        row[3] = {'type': 'null'}
    else:
        if mutation == 'whitespace':
            row[3]['value'] += ' '
        else:
            row[3]['value'] = row[3]['value'].replace("'", "'changed", 1)
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('column', tuple(range(10)), ids=tuple('c' + str(i) for i in range(10)))
def test_each_of_ten_receipt_cells_and_full_table_must_match(call, case, column):
    body, value = payload(call, case)
    rows = arrays(value)[0][index(body, 'receipt')]['rows']
    assert len(rows) == 1 and len(rows[0]) == 10
    rows[0][column] = {'type': 'integer', 'value': '999'} if column == 0 else {'type': 'text', 'value': 'changed'}
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('mutation', ('wrong_slot', 'duplicate', 'no_receipt', 'table_drift', 'preimage_receipt'),
    ids=('slot', 'duplicate', 'absent', 'table', 'before-receipt'))
def test_receipt_identity_slot_and_duplicate_read_consistency(call, case, mutation):
    schema = 8 if mutation == 'preimage_receipt' else 9
    body, value = payload(call, case, schema)
    values, _ = arrays(value)
    slot = index(body, 'receipt')
    if mutation == 'wrong_slot':
        values[slot]['rows'][0][0] = {'type': 'integer', 'value': '99'}
    elif mutation == 'duplicate':
        values[slot]['rows'].append(deepcopy(values[slot]['rows'][0]))
    elif mutation == 'no_receipt':
        values[slot]['rows'] = []
    elif mutation == 'table_drift':
        values[index(body, 'table:idempotency_responses')]['rows'][-1][5] = {'type': 'text', 'value': '{}'}
    else:
        after_body, after = payload(call, case)
        values[slot]['rows'] = deepcopy(arrays(after)[0][index(after_body, 'receipt')]['rows'])
    safe(call, verify(call, case, raw(value), schema), 'unknown')


@pytest.mark.parametrize('slot', ('header', 'table:_schema_version'), ids=('header', 'version'))
def test_version_header_is_not_offline_rehearsal_or_wrong_branch(call, case, slot):
    body, value = payload(call, case)
    row = arrays(value)[0][index(body, slot)]['rows'][0]
    row[-1] = {'type': 'integer', 'value': '9' if slot == 'header' else '8'}
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('schema', (None, False, True, 0, 7, 10, '9', 9.0), ids=('none', 'false', 'true', 'zero', 'old', 'next', 'text', 'float'))
def test_read_branch_is_explicit_native_8_or_9(call, case, schema):
    safe(call, verify(call, case, b'{}', schema), 'unknown', 'read_schema_invalid')
    with pytest.raises(v.ReconcileError, match='^read_schema_invalid$'):
        build(call, case, schema)


@pytest.mark.parametrize('key', ('expected_resource_sha256', 'expected_plan_sha256', 'expected_packet_sha256'),
    ids=('resource', 'plan', 'packet'))
def test_external_original_sha_tamper_rejected(call, case, key):
    _, value = payload(call, case)
    safe(call, verify(call, case, raw(value), **{key: 'f' * 64}), 'unknown')
    with pytest.raises(v.ReconcileError):
        build(call, case, **{key: 'f' * 64})


def test_wrong_origin_stops_before_rehydrate(call, case, monkeypatch):
    monkeypatch.setattr(compiler, 'rehydrate_packet', forbidden)
    safe(call, verify(call, case, b'{}', candidate_origin='libsql://other-candidate.turso.io'),
         'unknown', 'origin_mismatch')


@pytest.mark.parametrize('mutation', ('body', 'metadata', 'recipe', 'statements', 'requests', 'extra'),
    ids=('body', 'meta', 'recipe', 'stmt', 'request', 'extra'))
def test_entire_original_artifact_not_only_public_digests(call, case, mutation):
    _, value = payload(call, case)
    artifact = deepcopy(case[2].artifact())
    if mutation == 'body':
        artifact['body'] += b' '
    elif mutation == 'metadata':
        artifact['metadata'] += (('token', PRIVATE),)
    elif mutation == 'recipe':
        artifact['recipe'] = tuple((key, '2026-10-04T00:00:00Z' if key == 'created_at' else item)
                                   for key, item in artifact['recipe'])
    elif mutation == 'statements':
        artifact['statement_specs'] = artifact['statement_specs'][:-1]
    elif mutation == 'requests':
        artifact['request_specs'] = (('close',),)
    else:
        artifact['secret'] = PRIVATE
    safe(call, verify(call, case, raw(value), artifact=artifact), 'unknown', 'identity_invalid')


@pytest.mark.parametrize('fault', ('error', 'skip', 'contradiction'), ids=('error', 'skip', 'both'))
def test_every_read_begin_commit_and_rollback_slot_fail_closed(call, case, fault):
    body, clean = payload(call, case)
    count = len(arrays(clean)[0])
    for slot in range(count):
        # ROLLBACK must skip on success; its injected success/error is a fault.
        if slot == count - 1 and fault == 'skip':
            continue
        value = deepcopy(clean)
        values, errors = arrays(value)
        if fault == 'error':
            values[slot] = None
            errors[slot] = {'message': PRIVATE, 'code': 'SYNTHETIC_FAULT'}
        elif fault == 'skip':
            values[slot] = None
        else:
            values[slot] = {'cols': [], 'rows': [], 'affected_row_count': 0, 'last_insert_rowid': None}
            errors[slot] = {'message': PRIVATE, 'code': 'SYNTHETIC_FAULT'}
        safe(call, verify(call, case, raw(value)), 'unknown')
    value = deepcopy(clean)
    arrays(value)[0][-1] = {'cols': [], 'rows': [], 'affected_row_count': 0, 'last_insert_rowid': None}
    safe(call, verify(call, case, raw(value)), 'unknown', 'read_failed')


@pytest.mark.parametrize('slot', (0, 1, 2), ids=('batch', 'autocommit', 'close'))
def test_pipeline_error_slots_never_form_a_success_or_rollback_certificate(call, case, slot):
    _, value = payload(call, case)
    value['results'][slot] = {'type': 'error', 'error': {'message': PRIVATE, 'code': 'SYNTHETIC_FAULT'}}
    safe(call, verify(call, case, raw(value)), 'unknown', 'read_failed')


@pytest.mark.parametrize('code', tuple(sorted(parser._PERMISSION)), ids=tuple('p' + str(i) for i in range(len(parser._PERMISSION))))
def test_known_permission_in_last_fixed_slot_survives_malformed_earlier_slot(call, case, code):
    _, value = payload(call, case)
    values, errors = arrays(value)
    values[0] = {'malformed': PRIVATE}
    errors[-1] = {'message': PRIVATE, 'code': code}
    meta = safe(call, verify(call, case, raw(value)), 'unknown', 'permission_stop')
    assert meta['permission_stop'] is True


@pytest.mark.parametrize('fault', ('foreign_stream', 'invalid_identity'), ids=('foreign', 'identity'))
def test_unbound_authorization_response_cannot_claim_permission_stop(call, case, fault):
    _, value = payload(call, case)
    arrays(value)[1][-1] = {'message': PRIVATE, 'code': 'AUTH'}
    overrides = {}
    if fault == 'foreign_stream':
        value['base_url'] = 'https://other-candidate.turso.io/v3'
    else:
        overrides['expected_plan_sha256'] = 'f' * 64
    meta = safe(call, verify(call, case, raw(value), **overrides), 'unknown')
    assert meta['permission_stop'] is False


@pytest.mark.parametrize('kind', ('message', 'unknown_code', 'extra_field', 'extra_slot'), ids=('text', 'code', 'extra', 'outside'))
def test_permission_never_guessed_from_text_unknown_keys_or_outside_plan(call, case, kind):
    _, value = payload(call, case)
    values, errors = arrays(value)
    if kind == 'extra_slot':
        values.append(None)
        errors.append({'message': PRIVATE, 'code': 'AUTH'})
    else:
        errors[-1] = {'message': 'AUTH PERM READONLY ' + PRIVATE}
        if kind == 'unknown_code':
            errors[-1]['code'] = 'SQLITE_BUSY'
        if kind == 'extra_field':
            errors[-1].update(code='AUTH', token=PRIVATE)
    meta = safe(call, verify(call, case, raw(value)), 'unknown')
    assert meta['permission_stop'] is False


@pytest.mark.parametrize('mutation', ('autocommit', 'baton', 'close_extra', 'step_count', 'column', 'result_extra'),
    ids=('auto', 'baton', 'close', 'count', 'col', 'extra'))
def test_protocol_shape_closed_at_each_layer(call, case, mutation):
    body, value = payload(call, case)
    if mutation == 'autocommit':
        value['results'][1]['response']['is_autocommit'] = 1
    elif mutation == 'baton':
        value['baton'] = PRIVATE
    elif mutation == 'close_extra':
        value['results'][2]['response']['message'] = PRIVATE
    elif mutation == 'step_count':
        arrays(value)[0].pop()
    elif mutation == 'column':
        arrays(value)[0][index(body, 'receipt')]['cols'][0]['name'] = 'wrong'
    else:
        value['results'][0]['response']['result']['authorization'] = True
    safe(call, verify(call, case, raw(value)), 'unknown')


@pytest.mark.parametrize('kind', ('duplicate', 'nan', 'depth', 'nodes', 'bytes', 'utf8', 'empty', 'cell', 'rows'),
    ids=('dup', 'nan', 'depth', 'nodes', 'bytes', 'utf8', 'empty', 'cell', 'rows'))
def test_bounded_json_cells_and_rows_never_expose_private_material(call, case, kind):
    body, value = payload(call, case)
    if kind == 'duplicate':
        data = b'{"baton":null,"baton":null,"results":[]}'
    elif kind == 'nan':
        data = b'{"baton":null,"results":NaN}'
    elif kind == 'depth':
        data = b'[' * (parser.MAX_DEPTH + 1) + b'0' + b']' * (parser.MAX_DEPTH + 1)
    elif kind == 'nodes':
        data = b'[' + b'0,' * parser.MAX_NODES + b'0]'
    elif kind == 'bytes':
        data = b' ' * (v.MAX_BYTES + 1)
    elif kind == 'utf8':
        data = b'\xff'
    elif kind == 'empty':
        data = b''
    else:
        row_result = arrays(value)[0][index(body, 'table:funds')]
        if kind == 'cell':
            row_result['rows'][0][2] = {'type': 'text', 'value': 'x' * (compiler.MAX_CELL_BYTES + 1)}
        else:
            row_result['rows'] = [row_result['rows'][0]] * (v.MAX_ROWS + 1)
        data = raw(value)
    safe(call, verify(call, case, data), 'unknown')


@pytest.mark.parametrize('value,reason', [(None, 'response_missing'), ('{}', 'response_type_invalid'),
    (bytearray(b'{}'), 'response_type_invalid')], ids=('none', 'str', 'mutable'))
def test_native_response_bytes_required(call, case, value, reason):
    safe(call, verify(call, case, value), 'unknown', reason)


def test_generation_counts_new_scope_and_receipt_rows_against_same_global_bound(call, case, monkeypatch):
    monkeypatch.setattr(v, 'MAX_ROWS', case[1].safe_metadata['row_count'])
    assert type(build(call, case, 8)) is bytes
    with pytest.raises(v.ReconcileError, match='^response_limit$'):
        build(call, case, 9)


@pytest.mark.parametrize('limit', ('schema', 'steps'), ids=('schema', 'steps'))
def test_generation_schema_and_step_caps(call, case, monkeypatch, limit):
    if limit == 'schema':
        monkeypatch.setattr(v, 'MAX_SCHEMA_ROWS', len(case[1]._schema_inventory.rows))
    else:
        monkeypatch.setattr(v, 'MAX_STEPS', 2)
    with pytest.raises(v.ReconcileError, match='^response_limit$'):
        build(call, case)


@pytest.mark.parametrize('pin', ('own', 'parser', 'compiler'), ids=('own', 'parser', 'compiler'))
def test_final_code_pin_invalidates_previously_matching_image(call, case, monkeypatch, pin):
    _, value = payload(call, case)
    real_match = v._match_image
    observed = []
    def matching_then_drift(*args):
        result = real_match(*args)
        observed.append(result)
        if pin == 'own':
            monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
        elif pin == 'parser':
            monkeypatch.setattr(parser, '_current_verifier_code', lambda: 'f' * 64)
        else:
            monkeypatch.setattr(compiler, '_current_code', lambda: (('compiler', 'f' * 64),))
        return result
    monkeypatch.setattr(v, '_match_image', matching_then_drift)
    safe(call, verify(call, case, raw(value)), 'unknown', 'code_drift')
    assert observed == [('matched', 'matched_postimage')]


@pytest.mark.parametrize('phase', ('pin', 'verdict'), ids=('pin', 'construct'))
def test_real_monotonic_deadline_includes_final_pin_and_result_construction(call, case, monkeypatch, phase):
    _, value = payload(call, case)
    monkeypatch.setattr(v, 'MAX_SECONDS', 2.0)
    before = []
    delayed = []
    real_match, real_code, real_verdict = v._match_image, v._current_code, v.SmallReadVerdict
    def matched(*args):
        result = real_match(*args)
        before.append(result)
        return result
    def code():
        result = real_code()
        if before and not delayed and phase == 'pin':
            delayed.append(True)
            time.sleep(2.02)
        return result
    def verdict(*args, **kwargs):
        result = real_verdict(*args, **kwargs)
        if before and not delayed and phase == 'verdict':
            assert result.status == 'matched'
            delayed.append(True)
            time.sleep(2.02)
        return result
    monkeypatch.setattr(v, '_match_image', matched)
    monkeypatch.setattr(v, '_current_code', code)
    monkeypatch.setattr(v, 'SmallReadVerdict', verdict)
    started = time.monotonic()
    safe(call, verify(call, case, raw(value)), 'unknown', 'time_limit')
    assert time.monotonic() - started >= 2.0
    assert before == [('matched', 'matched_postimage')] and delayed == [True]


@pytest.mark.parametrize('status,reason,permission', [('matched', 'missing_preimage', False),
    ('missing', 'matched_postimage', False), ('unknown', 'matched_postimage', False),
    ('unknown', 'permission_stop', False), ('matched', 'matched_postimage', True),
    ('unknown', 'verification_failed', True), ('UNKNOWN', 'verification_failed', False),
    ('unknown', PRIVATE, False), ('unknown', 'verification_failed', 0)],
    ids=('matched-reason', 'missing-reason', 'unknown-reason', 'missing-stop', 'success-stop', 'wrong-stop', 'state', 'reason', 'bool'))
def test_constructor_closed_native_status_relationships(call, status, reason, permission):
    with pytest.raises(v.ReconcileError, match='^result_integrity_invalid$'):
        call(v.SmallReadVerdict, status, reason, permission)


@pytest.mark.parametrize('field', v._FLAGS, ids=('verified', 'applied', 'restore', 'formal', 'retry'))
def test_constructor_and_getter_cannot_add_remote_or_retry_permission(call, field):
    with pytest.raises(TypeError):
        call(v.SmallReadVerdict, 'missing', 'missing_preimage', False, **{field: True})
    result = call(v.SmallReadVerdict, 'missing', 'missing_preimage', False)
    object.__setattr__(result, field, True)
    with pytest.raises(v.ReconcileError, match='^result_integrity_invalid$'):
        call(lambda: result.safe_metadata)


def test_closed_slots_getter_seal_and_fresh_copy(call):
    result = call(v.SmallReadVerdict, 'missing', 'missing_preimage', False)
    with pytest.raises(FrozenInstanceError):
        result.status = 'matched'
    with pytest.raises((AttributeError, TypeError)):
        object.__setattr__(result, 'token', PRIVATE)
    changed = safe(call, result)
    changed['token'] = PRIVATE
    changed['retry_allowed'] = True
    assert 'token' not in safe(call, result)
    assert safe(call, result)['retry_allowed'] is False
    object.__setattr__(result, 'reason', 'verification_failed')
    with pytest.raises(v.ReconcileError, match='^result_integrity_invalid$'):
        call(lambda: result.safe_metadata)


def test_non_native_constructor_values_and_fixed_error_text(call):
    class Text(str):
        pass
    with pytest.raises(v.ReconcileError):
        call(v.SmallReadVerdict, Text('unknown'), 'verification_failed', False)
    assert str(v.ReconcileError(PRIVATE)) == 'verification_failed'
    assert str(v.ReconcileError({'token': PRIVATE})) == 'verification_failed'


@pytest.mark.parametrize('schema', (8, 9), ids=('before', 'after'))
def test_original_capture_cannot_be_relabelled_schema_nine(call, case, schema):
    _, value = payload(call, case, schema)
    case[1].safe_metadata['from_schema'] = 9
    safe(call, verify(call, case, raw(value), schema), 'unknown', 'identity_invalid')


def test_reserved_slot_occupied_by_unrelated_row_is_not_missing(call, case):
    body, value = payload(call, case, 8)
    after_body, after = payload(call, case, 9)
    values, _ = arrays(value)
    row = deepcopy(arrays(after)[0][index(after_body, 'receipt')]['rows'][0])
    row[1] = {'type': 'text', 'value': 'unrelated-slot-occupant'}
    row[2] = {'type': 'text', 'value': 'unrelated-endpoint'}
    values[index(body, 'table:idempotency_responses')]['rows'].append(deepcopy(row))
    values[index(body, 'receipt')]['rows'] = [row]
    safe(call, verify(call, case, raw(value), 8), 'unknown', 'image_mismatch')


def test_supplied_ddl_is_rejected_as_data_never_executed(call, case):
    _, value = payload(call, case)
    artifact = deepcopy(case[2].artifact())
    first = artifact['statement_specs'][0]
    artifact['statement_specs'] = ((first[0], 'DROP TABLE funds', *first[2:]),
                                 *artifact['statement_specs'][1:])
    safe(call, verify(call, case, raw(value), artifact=artifact), 'unknown', 'identity_invalid')


def test_second_admission_is_still_bound_to_original_recompiled_source(call, case, monkeypatch):
    _, value = payload(call, case)
    real_admit = compiler._admit
    seen = []
    def different_second(*args, **kwargs):
        result = real_admit(*args, **kwargs)
        seen.append(True)
        if len(seen) == 2:
            reference, inventory, records, meta = result
            meta = dict(meta, source_sha256='f' * 64)
            return reference, inventory, records, meta
        return result
    monkeypatch.setattr(compiler, '_admit', different_second)
    safe(call, verify(call, case, raw(value)), 'unknown', 'identity_invalid')
    assert seen == [True, True]


def test_code_drift_inside_final_result_construction_cannot_preserve_match(call, case, monkeypatch):
    _, value = payload(call, case)
    real_verdict = v.SmallReadVerdict
    observed = []
    def construct_then_drift(*args, **kwargs):
        result = real_verdict(*args, **kwargs)
        if not observed:
            observed.append(result.status)
            monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
        return result
    monkeypatch.setattr(v, 'SmallReadVerdict', construct_then_drift)
    safe(call, verify(call, case, raw(value)), 'unknown', 'code_drift')
    assert observed == ['matched']


@pytest.mark.parametrize('key', ('expected_resource_sha256', 'expected_plan_sha256', 'expected_packet_sha256'),
    ids=('resource', 'plan', 'packet'))
@pytest.mark.parametrize('invalid', (None, False, b'a' * 64, 'A' * 64, 'a' * 63),
    ids=('none', 'false', 'bytes', 'upper', 'short'))
def test_invalid_external_binding_is_never_filled_from_artifact(call, case, key, invalid):
    safe(call, verify(call, case, b'{}', **{key: invalid}), 'unknown', 'identity_invalid')


@pytest.mark.parametrize('invalid', (None, {}, [], False), ids=('none', 'empty', 'list', 'false'))
def test_missing_native_original_artifact_rejected_without_test_helper_fallback(call, case, invalid):
    _, snapshot, _, _ = case
    result = call(v.verify_scope_reconcile_read, snapshot, invalid, b'{}', **options(case, 9))
    safe(call, result, 'unknown', 'identity_invalid')
