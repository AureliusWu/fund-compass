"""Supplied-byte synthetic readback contracts, never real remote evidence."""
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

from database import (db, exact_real, owner_sync_schema, turso_projection_repair,
                      turso_owner_upgrade_packet as compiler,
                      turso_owner_upgrade_reconcile as v,
                      turso_scope_packet as strict, turso_scope_reconcile as legacy,
                      turso_scope_response as parser, turso_scope_snapshot as capture,
                      turso_scope_upgrade as offline)
import test_turso_owner_upgrade_packet as fixtures
from test_turso_scope_reconcile import arrays, execute_read, index, raw
import turso_scope_packet_fixtures as synthetic


ORIGIN = 'libsql://synthetic-candidate.turso.io'
PRIVATE = 'synthetic-private-marker-never-real'


def forbidden(*args, **kwargs):
    raise AssertionError('external_or_configured_access_forbidden')


@pytest.fixture
def call(monkeypatch):
    """Permit only the fixed source pins and explicit SQLite :memory: clones."""
    allowed = frozenset([*(path for _, path in strict._CODE_FILES),
        *(Path(module.__file__).resolve() for module in
          (compiler, v, legacy, parser, exact_real, owner_sync_schema, turso_projection_repair))])
    real_connect = sqlite3.connect
    real_path_open, real_open, real_io_open = Path.open, builtins.open, io.open

    def check_mode(args, kwargs):
        mode = args[0] if args else kwargs.get('mode', 'r')
        if type(mode) is not str or mode not in ('r', 'rb'):
            forbidden()

    def fixed_path_open(path, *args, **kwargs):
        if path.resolve() not in allowed:
            forbidden()
        check_mode(args, kwargs)
        return real_path_open(path, *args, **kwargs)

    def fixed_open(path, *args, **kwargs):
        if not isinstance(path, (str, Path)) or Path(path).resolve() not in allowed:
            forbidden()
        check_mode(args, kwargs)
        return real_open(path, *args, **kwargs)

    def fixed_io_open(path, *args, **kwargs):
        if not isinstance(path, (str, Path)) or Path(path).resolve() not in allowed:
            forbidden()
        check_mode(args, kwargs)
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
    with fixtures.captured() as (source, snapshot, model):
        packet = fixtures.compile_packet(snapshot)
        # Retain actual originals before any artifact or response tampering.
        yield source, snapshot, packet, dict(fixtures.identity(packet)), model


def options(case, schema):
    return dict(candidate_origin=ORIGIN, read_schema=schema, **dict(case[3]))


def build(call, case, schema=9, **overrides):
    kwargs = options(case, schema)
    kwargs.update(overrides)
    return call(v.build_owner_upgrade_reconcile_read, case[1], case[2].artifact(), **kwargs)


def verify(call, case, response, schema=9, *, artifact=None, **overrides):
    kwargs = options(case, schema)
    kwargs.update(overrides)
    original = case[2].artifact() if artifact is None else artifact
    return call(v.verify_owner_upgrade_reconcile_read, case[1], original, response, **kwargs)


def payload(call, case, schema=9):
    source, snapshot, packet, _, _ = case
    original_source, original_capture = source.serialize(), snapshot.connection.serialize()
    body = build(call, case, schema)
    target = synthetic.clone(source)
    try:
        if schema == 9:
            assert synthetic.execute_packet(target, packet)['committed'] is True
        before = (strict._schema_rows(target), offline._rows_digest(synthetic.records(target)))
        response = execute_read(target, body)
        assert (strict._schema_rows(target), offline._rows_digest(synthetic.records(target))) == before
        assert source.serialize() == original_source
        assert snapshot.connection.serialize() == original_capture
        return body, response
    finally:
        target.close()


def safe(call, verdict, status=None, reason=None):
    meta = call(lambda: verdict.safe_metadata)
    assert set(meta) == v._PUBLIC_KEYS == legacy._PUBLIC_KEYS
    assert meta['profile'] == v.PROFILE != legacy.PROFILE
    assert meta['evidence_scope'] == v.EVIDENCE_SCOPE != legacy.EVIDENCE_SCOPE
    assert all(meta[key] is False for key in v._FLAGS)
    assert PRIVATE not in repr(verdict) and PRIVATE not in json.dumps(meta)
    if status is not None:
        assert meta['status'] == status
    if reason is not None:
        assert meta['reason'] == reason
    return meta


@pytest.mark.parametrize('schema,status,reason', [(8, 'missing', 'missing_preimage'),
    (9, 'matched', 'matched_postimage')], ids=('original', 'upgraded'))
def test_full_original_and_repaired_owner_images_are_read_only_contracts(call, case, schema, status, reason):
    source_before, capture_before = case[0].serialize(), case[1].connection.serialize()
    body, value = payload(call, case, schema)
    safe(call, verify(call, case, raw(value), schema), status, reason)
    assert case[0].serialize() == source_before and case[1].connection.serialize() == capture_before
    wire = json.loads(body)
    assert [item['type'] for item in wire['requests']] == ['batch', 'get_autocommit', 'close']
    steps = wire['requests'][0]['batch']['steps']
    sqls = [step['stmt']['sql'] for step in steps]
    assert sqls[0] == 'BEGIN' and sqls[-2:] == ['COMMIT', 'ROLLBACK']
    assert not any(sql.startswith(('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER')) for sql in sqls)
    assert not any(sql.startswith('PRAGMA') and '=' in sql for sql in sqls)
    assert 'BEGIN IMMEDIATE' not in sqls
    assert wire['baton'] is None
    assert steps[-1]['condition']['conds'][0] == {'type': 'not', 'cond': {'type': 'ok', 'step': len(steps) - 2}}
    owner_reads = [sql for sql in sqls if sql.startswith('SELECT rowid,* FROM main."owner_sync_')]
    assert len(owner_reads) == (5 if schema == 9 else 0)


@pytest.mark.parametrize('header', (0, 8), ids=('zero', 'eight'))
@pytest.mark.parametrize('raw_trigger', (False, True), ids=('fixed-ddl', 'old-spelling'))
def test_source_header_and_one_declared_trigger_spelling_are_bound(call, header, raw_trigger):
    with fixtures.captured(header=header, raw_trigger=raw_trigger) as (source, snapshot, model):
        packet = fixtures.compile_packet(snapshot)
        original = source, snapshot, packet, dict(fixtures.identity(packet)), model
        for schema, status in ((8, 'missing'), (9, 'matched')):
            body, value = payload(call, original, schema)
            safe(call, verify(call, original, raw(value), schema), status)
            arrays(value)[0][index(body, 'header')]['rows'][0][0] = {
                'type': 'integer', 'value': str(8 if header == 0 else 0)}
            safe(call, verify(call, original, raw(value), schema), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('table', ('owner_sync_schema', 'owner_sync_state', 'owner_sync_records',
    'owner_sync_changes', 'owner_sync_receipts'), ids=('schema', 'revision', 'records', 'changes', 'receipts'))
def test_every_owner_table_seed_or_empty_image_is_checked(call, case, table):
    body, value = payload(call, case)
    result = arrays(value)[0][index(body, 'table:' + table)]
    if result['rows']:
        result['rows'][0][-1] = {'type': 'integer', 'value': '1' if table == 'owner_sync_state' else '99'}
    else:
        result['rows'] = [[{'type': 'null'} for _ in result['cols']]]
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('table', ('funds', 'fund_detail', 'evidence_snapshots', 'v8_record_scopes',
                                  'idempotency_responses', '_schema_version'))
@pytest.mark.parametrize('mutation', ('cell', 'missing', 'extra'), ids=('same-count', 'less', 'more'))
def test_all_business_scope_evidence_and_receipt_rows_are_exact(call, case, table, mutation):
    body, value = payload(call, case)
    rows = arrays(value)[0][index(body, 'table:' + table)]['rows']
    assert rows
    if mutation == 'cell':
        rows[0][-1] = {'type': 'text', 'value': 'changed-synthetic'}
    elif mutation == 'missing':
        rows.pop()
    else:
        rows.append(deepcopy(rows[-1]))
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('column', ('estimate', 'estimate_coverage', 'payload_json', 'payload_sha256', 'evidence_id'))
def test_repaired_evidence_values_and_immutable_identity_cannot_drift(call, case, column):
    body, value = payload(call, case)
    result = arrays(value)[0][index(body, 'table:evidence_snapshots')]
    position = next(offset for offset, item in enumerate(result['cols']) if item['name'] == column)
    result['rows'][0][position] = {'type': 'text', 'value': 'changed-synthetic'}
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('kind', ('real', 'null-zero', 'blob-text', 'nul-tail', 'rowid', 'signed-zero'))
def test_native_real_null_blob_and_text_bytes_not_normalized(call, case, kind):
    body, value = payload(call, case)
    values, _ = arrays(value)
    details = values[index(body, 'table:fund_detail')]
    funds = values[index(body, 'table:funds')]
    if kind == 'real':
        column = next(i for i, item in enumerate(details['cols']) if item['name'] == 'scale')
        details['rows'][0][column] = {'type': 'float', 'value': 1.0}
    elif kind == 'null-zero':
        column = next(i for i, item in enumerate(details['cols']) if item['name'] == 'latest_nav')
        details['rows'][0][column] = {'type': 'integer', 'value': '0'}
    elif kind == 'blob-text':
        assert funds['rows'][0][-1]['type'] == 'blob'
        funds['rows'][0][-1] = {'type': 'text', 'value': 'synthetic\x00blob'}
    elif kind == 'nul-tail':
        column = next(i for i, item in enumerate(funds['cols']) if item['name'] == 'name')
        funds['rows'][0][column] = {'type': 'text', 'value': 'synthetic\x00other'}
    elif kind == 'rowid':
        funds['rows'][0][0] = {'type': 'integer', 'value': '99'}
    else:
        column = next(i for i, item in enumerate(details['cols']) if item['name'] == 'scale')
        assert details['rows'][1][column] == {'type': 'float', 'value': 0.0}
        details['rows'][1][column] = {'type': 'float', 'value': -0.0}
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('column', range(10), ids=tuple('c' + str(i) for i in range(10)))
def test_unique_ten_column_upgrade_receipt_bound_in_full(call, case, column):
    body, value = payload(call, case)
    rows = arrays(value)[0][index(body, 'receipt')]['rows']
    assert len(rows) == 1 and len(rows[0]) == 10
    rows[0][column] = {'type': 'integer', 'value': '999'} if column == 0 else {'type': 'text', 'value': 'changed'}
    safe(call, verify(call, case, raw(value)), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('fault', ('absent', 'absent-all', 'duplicate', 'table-drift', 'rowid-collision', 'endpoint-collision'))
def test_receipt_absence_on_schema_nine_and_collision_on_eight_are_unknown(call, case, fault):
    schema = 8 if fault.endswith('collision') else 9
    body, value = payload(call, case, schema)
    values, _ = arrays(value)
    selected = values[index(body, 'receipt')]['rows']
    if fault in ('absent', 'absent-all'):
        if fault == 'absent-all':
            complete = values[index(body, 'table:idempotency_responses')]['rows']
            assert len(complete) == 2 and complete[-1] == selected[0]
            complete.pop()
        selected.clear()
    elif fault == 'duplicate':
        selected.append(deepcopy(selected[0]))
    elif fault == 'table-drift':
        values[index(body, 'table:idempotency_responses')]['rows'][-1][5] = {'type': 'text', 'value': '{}'}
    else:
        after_body, after = payload(call, case, 9)
        row = deepcopy(arrays(after)[0][index(after_body, 'receipt')]['rows'][0])
        row[1 if fault == 'rowid-collision' else 0] = {'type': 'text', 'value': 'unrelated'} if fault == 'rowid-collision' else {'type': 'integer', 'value': '99'}
        values[index(body, 'table:idempotency_responses')]['rows'].append(deepcopy(row))
        selected.append(row)
    safe(call, verify(call, case, raw(value), schema), 'unknown', 'image_mismatch')


@pytest.mark.parametrize('schema', (None, False, True, 0, 7, 10, '9', 9.0))
def test_read_schema_requires_explicit_native_8_or_9(call, case, schema):
    safe(call, verify(call, case, b'{}', schema), 'unknown', 'read_schema_invalid')
    with pytest.raises(v.ReconcileError, match='^read_schema_invalid$'):
        build(call, case, schema)


@pytest.mark.parametrize('key', ('expected_resource_sha256', 'expected_plan_sha256', 'expected_packet_sha256'))
@pytest.mark.parametrize('invalid', (None, False, b'a' * 64, 'A' * 64, 'a' * 63, 'f' * 64))
def test_external_original_bindings_never_filled_from_artifact(call, case, key, invalid):
    safe(call, verify(call, case, b'{}', **{key: invalid}), 'unknown')
    with pytest.raises(v.ReconcileError):
        build(call, case, **{key: invalid})


def test_origin_rejected_before_original_rehydration(call, case, monkeypatch):
    monkeypatch.setattr(compiler, 'rehydrate_packet', forbidden)
    safe(call, verify(call, case, b'{}', candidate_origin='libsql://other-candidate.turso.io'),
         'unknown', 'origin_mismatch')


@pytest.mark.parametrize('mutation', ('body', 'metadata', 'recipe', 'statements', 'requests', 'extra', 'old-profile', 'resealed-body'))
def test_entire_private_artifact_recompiled_not_only_metadata(call, case, mutation):
    artifact = deepcopy(case[2].artifact())
    overrides = {}
    if mutation in ('body', 'resealed-body'):
        artifact['body'] += b' '
        if mutation == 'resealed-body':
            overrides['expected_packet_sha256'] = hashlib.sha256(artifact['body']).hexdigest()
    elif mutation == 'metadata':
        artifact['metadata'] += (('token', PRIVATE),)
    elif mutation == 'recipe':
        artifact['recipe'] = tuple((key, '2026-10-04T00:00:00Z' if key == 'created_at' else item)
                                   for key, item in artifact['recipe'])
    elif mutation == 'statements':
        first = artifact['statement_specs'][0]
        artifact['statement_specs'] = ((first[0], 'DROP TABLE funds', *first[2:]), *artifact['statement_specs'][1:])
    elif mutation == 'requests':
        artifact['request_specs'] = (('close',),)
    elif mutation == 'old-profile':
        artifact['profile'] = strict.ARTIFACT_PROFILE
    else:
        artifact['secret'] = PRIVATE
    safe(call, verify(call, case, b'{}', artifact=artifact, **overrides), 'unknown', 'identity_invalid')


@pytest.mark.parametrize('artifact', (None, {}, [], False))
def test_original_artifact_required_without_helper_fallback(call, case, artifact):
    verdict = call(v.verify_owner_upgrade_reconcile_read, case[1], artifact, b'{}', **options(case, 9))
    safe(call, verdict, 'unknown', 'identity_invalid')


@pytest.mark.parametrize('fault', ('error', 'skip', 'contradiction'))
def test_every_fixed_read_or_commit_slot_fails_closed(call, case, fault):
    _, clean = payload(call, case)
    count = len(arrays(clean)[0])
    for slot in range(count):
        if slot == count - 1 and fault == 'skip':
            continue  # The successful plan requires its rollback to be skipped.
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


@pytest.mark.parametrize('slot', (0, 1, 2), ids=('batch', 'autocommit', 'close'))
def test_pipeline_errors_do_not_certify_rollback_or_success(call, case, slot):
    _, value = payload(call, case)
    value['results'][slot] = {'type': 'error', 'error': {'message': PRIVATE, 'code': 'SYNTHETIC_FAULT'}}
    safe(call, verify(call, case, raw(value)), 'unknown', 'read_failed')


@pytest.mark.parametrize('code', tuple(sorted(parser._PERMISSION)))
def test_bound_known_permission_in_last_slot_survives_malformed_first(call, case, code):
    _, value = payload(call, case)
    values, errors = arrays(value)
    values[0] = {'malformed': PRIVATE}
    errors[-1] = {'message': PRIVATE, 'code': code}
    assert safe(call, verify(call, case, raw(value)), 'unknown', 'permission_stop')['permission_stop'] is True


@pytest.mark.parametrize('fault', ('foreign-origin', 'invalid-identity', 'message-only', 'unknown-code', 'extra-field', 'extra-slot'))
def test_unbound_or_unrecognized_auth_text_does_not_grant_permission_status(call, case, fault):
    _, value = payload(call, case)
    values, errors = arrays(value)
    overrides = {}
    errors[-1] = {'message': PRIVATE, 'code': 'AUTH'}
    if fault == 'foreign-origin':
        value['base_url'] = 'https://other-candidate.turso.io/v3'
    elif fault == 'invalid-identity':
        overrides['expected_plan_sha256'] = 'f' * 64
    elif fault == 'message-only':
        errors[-1] = {'message': 'AUTH PERM READONLY ' + PRIVATE}
    elif fault == 'unknown-code':
        errors[-1]['code'] = 'SQLITE_BUSY'
    elif fault == 'extra-field':
        errors[-1]['token'] = PRIVATE
    else:
        errors[-1] = None
        values.append(None)
        errors.append({'message': PRIVATE, 'code': 'AUTH'})
    assert safe(call, verify(call, case, raw(value), **overrides), 'unknown')['permission_stop'] is False


@pytest.mark.parametrize('mutation', ('autocommit', 'baton', 'close-extra', 'step-count', 'column', 'result-extra', 'schema', 'temp'))
def test_each_protocol_layer_and_schema_inventory_is_closed(call, case, mutation):
    body, value = payload(call, case)
    if mutation == 'autocommit':
        value['results'][1]['response']['is_autocommit'] = 1
    elif mutation == 'baton':
        value['baton'] = PRIVATE
    elif mutation == 'close-extra':
        value['results'][2]['response']['message'] = PRIVATE
    elif mutation == 'step-count':
        arrays(value)[0].pop()
    elif mutation == 'column':
        arrays(value)[0][index(body, 'receipt')]['cols'][0]['name'] = 'wrong'
    elif mutation == 'result-extra':
        value['results'][0]['response']['result']['authorization'] = True
    elif mutation == 'schema':
        arrays(value)[0][index(body, 'schema')]['rows'][0][-1] = {'type': 'text', 'value': 'changed-ddl'}
    else:
        result = arrays(value)[0][3]
        assert json.loads(body)['requests'][0]['batch']['steps'][3]['stmt']['sql'].startswith('SELECT type,name,tbl_name,sql FROM temp.')
        result['rows'] = [[{'type': 'text', 'value': 'unexpected'}] * 4]
    safe(call, verify(call, case, raw(value)), 'unknown')


@pytest.mark.parametrize('kind', ('duplicate', 'nan', 'depth', 'nodes', 'bytes', 'utf8', 'empty', 'cell', 'rows', 'blob'))
def test_json_and_typed_value_limits_keep_private_material_out_of_result(call, case, kind):
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
        result = arrays(value)[0][index(body, 'table:funds')]
        if kind == 'cell':
            result['rows'][0][2] = {'type': 'text', 'value': 'x' * (strict.MAX_CELL_BYTES + 1)}
        elif kind == 'blob':
            result['rows'][0][-1] = {'type': 'blob', 'base64': base64.b64encode(b'x' * (strict.MAX_CELL_BYTES + 1)).decode('ascii')}
        else:
            result['rows'] = [result['rows'][0]] * (v.MAX_ROWS + 1)
        data = raw(value)
    safe(call, verify(call, case, data), 'unknown')


@pytest.mark.parametrize('response,reason', [(None, 'response_missing'), ('{}', 'response_type_invalid'),
    (bytearray(b'{}'), 'response_type_invalid')], ids=('none', 'string', 'mutable'))
def test_raw_response_must_be_native_immutable_bytes(call, case, response, reason):
    safe(call, verify(call, case, response), 'unknown', reason)


def test_global_read_bound_includes_repair_scope_owner_seeds_and_receipt(call, case, monkeypatch):
    monkeypatch.setattr(v, 'MAX_ROWS', case[1].safe_metadata['row_count'])
    assert type(build(call, case, 8)) is bytes
    with pytest.raises(v.ReconcileError, match='^response_limit$'):
        build(call, case, 9)


@pytest.mark.parametrize('limit', ('schema', 'steps'))
def test_generation_schema_or_step_bound_does_not_expand(call, case, monkeypatch, limit):
    monkeypatch.setattr(v, 'MAX_SCHEMA_ROWS' if limit == 'schema' else 'MAX_STEPS',
                        len(case[1]._schema_inventory.rows) if limit == 'schema' else 2)
    with pytest.raises(v.ReconcileError, match='^response_limit$'):
        build(call, case)


@pytest.mark.parametrize('pin', ('own', 'parser', 'compiler', 'legacy'))
def test_final_source_pins_invalidate_already_matching_image(call, case, monkeypatch, pin):
    _, value = payload(call, case)
    real_match = legacy._match_image
    observed = []

    def match_then_drift(*args):
        result = real_match(*args)
        observed.append(result)
        if pin == 'own':
            monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
        elif pin == 'parser':
            monkeypatch.setattr(parser, '_current_verifier_code', lambda: 'f' * 64)
        elif pin == 'compiler':
            monkeypatch.setattr(compiler, '_current_code', lambda: (('owner_compiler', 'f' * 64),))
        else:
            monkeypatch.setattr(legacy, '_current_code', lambda: ('f' * 64,))
        return result

    monkeypatch.setattr(legacy, '_match_image', match_then_drift)
    safe(call, verify(call, case, raw(value)), 'unknown', 'code_drift')
    assert observed == [('matched', 'matched_postimage')]


@pytest.mark.parametrize('phase', ('final-pin', 'verdict'))
def test_total_budget_includes_final_pins_and_result_construction(call, case, monkeypatch, phase):
    _, value = payload(call, case)
    real_match, real_code, real_verdict = legacy._match_image, v._current_code, v.SmallReadVerdict
    clock = [1000.0]
    matched, delayed = [], []
    monkeypatch.setattr(time, 'monotonic', lambda: clock[0])

    def match(*args):
        result = real_match(*args)
        matched.append(result)
        return result

    def code():
        result = real_code()
        if matched and not delayed and phase == 'final-pin':
            delayed.append(True)
            clock[0] += v.MAX_SECONDS + 1.0
        return result

    def verdict(*args, **kwargs):
        result = real_verdict(*args, **kwargs)
        if matched and not delayed and phase == 'verdict':
            assert result.status == 'matched'
            delayed.append(True)
            clock[0] += v.MAX_SECONDS + 1.0
        return result

    monkeypatch.setattr(legacy, '_match_image', match)
    monkeypatch.setattr(v, '_current_code', code)
    monkeypatch.setattr(v, 'SmallReadVerdict', verdict)
    safe(call, verify(call, case, raw(value)), 'unknown', 'time_limit')
    assert matched == [('matched', 'matched_postimage')] and delayed == [True]


def test_code_drift_inside_result_constructor_cannot_preserve_match(call, case, monkeypatch):
    _, value = payload(call, case)
    real_verdict = v.SmallReadVerdict
    observed = []

    def changed(*args, **kwargs):
        result = real_verdict(*args, **kwargs)
        if not observed:
            observed.append(result.status)
            monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
        return result

    monkeypatch.setattr(v, 'SmallReadVerdict', changed)
    safe(call, verify(call, case, raw(value)), 'unknown', 'code_drift')
    assert observed == ['matched']


@pytest.mark.parametrize('status,reason,permission', [('matched', 'missing_preimage', False),
    ('missing', 'matched_postimage', False), ('unknown', 'matched_postimage', False),
    ('unknown', 'permission_stop', False), ('matched', 'matched_postimage', True),
    ('unknown', 'verification_failed', True), ('UNKNOWN', 'verification_failed', False),
    ('unknown', PRIVATE, False), ('unknown', 'verification_failed', 0),
    (True, 'verification_failed', False)])
def test_closed_dto_rejects_inconsistent_states_and_non_native_bools(call, status, reason, permission):
    with pytest.raises(v.ReconcileError, match='^result_integrity_invalid$'):
        call(v.SmallReadVerdict, status, reason, permission)


@pytest.mark.parametrize('flag', legacy._FLAGS)
@pytest.mark.parametrize('value', (True, 0, None), ids=('true', 'zero', 'none'))
def test_sealed_dto_cannot_add_remote_or_retry_authority(call, flag, value):
    with pytest.raises(TypeError):
        call(v.SmallReadVerdict, 'missing', 'missing_preimage', False, **{flag: value})
    result = call(v.SmallReadVerdict, 'missing', 'missing_preimage', False)
    object.__setattr__(result, flag, value)
    # Even an attacker-recomputed content seal cannot legalize invalid facts.
    meta = dict(profile=v.PROFILE, evidence_scope=v.EVIDENCE_SCOPE, status='missing',
                reason='missing_preimage', permission_stop=False, **dict.fromkeys(v._FLAGS, False))
    meta[flag] = value
    object.__setattr__(result, '_seal', hashlib.sha256(strict._json(meta)).hexdigest())
    with pytest.raises(v.ReconcileError, match='^result_integrity_invalid$'):
        call(lambda: result.safe_metadata)


def test_closed_slots_fixed_errors_immutable_metadata_and_native_text(call):
    result = call(v.SmallReadVerdict, 'missing', 'missing_preimage', False)
    with pytest.raises(FrozenInstanceError):
        result.status = 'matched'
    with pytest.raises((AttributeError, TypeError)):
        object.__setattr__(result, 'token', PRIVATE)
    changed = safe(call, result)
    changed['token'], changed['retry_allowed'] = PRIVATE, True
    assert 'token' not in safe(call, result) and safe(call, result)['retry_allowed'] is False
    object.__setattr__(result, 'reason', 'verification_failed')
    with pytest.raises(v.ReconcileError, match='^result_integrity_invalid$'):
        call(lambda: result.safe_metadata)

    class Text(str):
        pass

    with pytest.raises(v.ReconcileError, match='^result_integrity_invalid$'):
        call(v.SmallReadVerdict, Text('unknown'), 'verification_failed', False)
    assert str(v.ReconcileError(PRIVATE)) == 'verification_failed'
    assert str(v.ReconcileError({'token': PRIVATE})) == 'verification_failed'


@pytest.mark.parametrize('status,reason', [('matched', 'matched_postimage'), ('missing', 'missing_preimage')])
def test_success_constructor_and_preexisting_getter_recheck_source_pins(call, monkeypatch, status, reason):
    result = call(v.SmallReadVerdict, status, reason, False)
    safe(call, result, status, reason)
    monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
    with pytest.raises(v.ReconcileError, match='^code_drift$'):
        call(lambda: result.safe_metadata)
    with pytest.raises(v.ReconcileError, match='^code_drift$'):
        call(v.SmallReadVerdict, status, reason, False)
    # Closed failure diagnostics remain readable after a pin failure; they do
    # not acquire success/remote authority merely by being constructible.
    safe(call, call(v.SmallReadVerdict, 'unknown', 'code_drift', False), 'unknown', 'code_drift')


def test_second_full_derivation_remains_bound_to_original_capture(call, case, monkeypatch):
    _, value = payload(call, case)
    real_prepare = compiler._prepare
    observed = []

    def different_second(*args, **kwargs):
        result = real_prepare(*args, **kwargs)
        observed.append(True)
        if len(observed) == 2:
            parts = list(result)
            parts[-2] = dict(parts[-2], source_image_sha256='f' * 64)
            return tuple(parts)
        return result

    monkeypatch.setattr(compiler, '_prepare', different_second)
    safe(call, verify(call, case, raw(value)), 'unknown', 'identity_invalid')
    assert observed == [True, True]


@pytest.mark.parametrize('schema', (8, 9), ids=('original', 'upgraded'))
def test_original_closed_capture_cannot_be_relabelled_schema_nine(call, case, schema):
    _, value = payload(call, case, schema)
    original = dict(case[1].safe_metadata)
    try:
        case[1].safe_metadata['from_schema'] = 9
        safe(call, verify(call, case, raw(value), schema), 'unknown', 'identity_invalid')
    finally:
        case[1].safe_metadata.clear()
        case[1].safe_metadata.update(original)


def test_global_caps_are_not_expanded_for_repair_and_owner_tables():
    assert v.MAX_SECONDS == legacy.MAX_SECONDS == 30.0
    assert v.MAX_BYTES == legacy.MAX_BYTES == 64 * 1024 * 1024
    assert v.MAX_ROWS == legacy.MAX_ROWS == 100_000
    assert v.MAX_SCHEMA_ROWS == legacy.MAX_SCHEMA_ROWS == 128
    assert v.MAX_STEPS == legacy.MAX_STEPS == 16_384


@pytest.mark.parametrize('operation', ('constructor', 'getter'))
@pytest.mark.parametrize('status,reason,permission', [
    ('matched', 'matched_postimage', False), ('missing', 'missing_preimage', False),
    ('unknown', 'verification_failed', False), ('unknown', 'permission_stop', True),
    ('unknown', 'code_drift', False),
], ids=('matched', 'missing', 'unknown', 'permission', 'drift-diagnostic'))
def test_dto_total_budget_starts_before_actual_value_validation(call, monkeypatch, operation, status, reason, permission):
    result = call(v.SmallReadVerdict, status, reason, permission) if operation == 'getter' else None
    original_values = v.SmallReadVerdict._values
    elapsed, completed = [1000.0], []
    monkeypatch.setattr(time, 'monotonic', lambda: elapsed[0])

    def actual_validation_then_delay(self):
        values = original_values(self)
        if not completed:
            completed.append(values['status'])
            # The original validator genuinely completed. Charge its elapsed
            # work once, without skipping code pins or sleeping in the suite.
            elapsed[0] += 31.0
        return values

    monkeypatch.setattr(v.SmallReadVerdict, '_values', actual_validation_then_delay)
    with pytest.raises(v.ReconcileError, match='^time_limit$'):
        if operation == 'constructor':
            call(v.SmallReadVerdict, status, reason, permission)
        else:
            call(lambda: result.safe_metadata)
    assert completed == [status]


@pytest.mark.parametrize('operation', ('constructor', 'getter'))
@pytest.mark.parametrize('reason', tuple(sorted(v._REASONS - frozenset(legacy._SUCCESS.values()) - {'code_drift'})))
def test_unknown_dto_cannot_keep_permission_or_other_claims_after_source_drift(call, monkeypatch, operation, reason):
    permission = reason == 'permission_stop'
    result = call(v.SmallReadVerdict, 'unknown', reason, permission) if operation == 'getter' else None
    monkeypatch.setattr(v, '_own_digest', lambda: 'f' * 64)
    with pytest.raises(v.ReconcileError, match='^code_drift$'):
        if operation == 'constructor':
            call(v.SmallReadVerdict, 'unknown', reason, permission)
        else:
            call(lambda: result.safe_metadata)
    safe(call, call(v.SmallReadVerdict, 'unknown', 'code_drift', False), 'unknown', 'code_drift')


@pytest.mark.parametrize('clock_failure', ('expired', 'nan'))
def test_late_bound_auth_with_clock_failure_never_leaks_constructor_error_or_retry(call, case, monkeypatch, clock_failure):
    _, value = payload(call, case)
    arrays(value)[1][-1] = {'message': PRIVATE, 'code': 'AUTH'}
    actual_observe, actual_verdict = legacy._observe_permissions, v.SmallReadVerdict
    clock, observed, attempts = [1000.0], [], []
    monkeypatch.setattr(time, 'monotonic', lambda: clock[0])

    def observe_then_lose_clock(*args):
        actual_observe(*args)
        assert args[3].permission is True
        observed.append(True)
        clock[0] = float('nan') if clock_failure == 'nan' else clock[0] + 31.0

    def record_constructor(*args, **kwargs):
        attempts.append(args[:3])
        return actual_verdict(*args, **kwargs)

    monkeypatch.setattr(legacy, '_observe_permissions', observe_then_lose_clock)
    monkeypatch.setattr(v, 'SmallReadVerdict', record_constructor)
    verdict = verify(call, case, raw(value))
    expected_reason = 'time_limit' if clock_failure == 'nan' else 'permission_stop'
    meta = safe(call, verdict, 'unknown', expected_reason)
    assert meta['permission_stop'] is (clock_failure == 'expired')
    assert observed == [True]
    if clock_failure == 'nan':
        # Exercise the once-failing fallback constructor, not merely an early
        # timeout before permission observation. It must close to unqualified
        # unknown rather than escape an exception or retain an unusable claim.
        assert attempts.count(('unknown', 'permission_stop', True)) >= 2
        assert attempts[-1] == ('unknown', 'time_limit', False)
