"""Test-only synthetic capture/execution. Never a production transport."""
import base64
from contextlib import contextmanager
import json
import sqlite3
import time

import test_turso_scope_snapshot as fixtures
from database import turso_scope_packet as compiler, turso_scope_snapshot as capture, turso_scope_upgrade as offline
from datetime import datetime
from models.v8 import HoldingVersion, canonical_json, payload_sha256, stable_id

NOW = '2026-10-03T00:00:00Z'

FIXTURE_CREATED_AT = '2026-10-03T00:00:00+00:00'


def build_fixture(*, funds=3, details=2, root=True, old_receipt=True):
    """Explicit fixed-schema private memory data; no configured DB or globals."""
    conn = offline._source_reference('remote-schema-table', offline._Budget(time.monotonic() + 30),
                                    operational_objects=frozenset(offline._OPERATIONAL_DEFINITIONS))
    try:
        conn.execute('INSERT INTO _schema_version VALUES(1,8)')
        conn.executemany('INSERT INTO funds(code,name,type,pinyin) VALUES(?,?,?,?)',
            [(f'{i:06d}', f'synthetic-fund-{i}', 'mixed', None) for i in range(1, funds + 1)])
        conn.executemany('INSERT INTO fund_detail(code,scale,latest_nav) VALUES(?,?,?)',
            [(f'{i:06d}', 1.25, 0.0 if i == 1 else 1.01) for i in range(1, details + 1)])
        if root:
            identity = dict(schema_version='v8-holding-1', fund_code='000001', user_state='unheld',
                shares=None, cost=None, market_value=None, account=None, current_weight=None,
                target_weight=None, updated_at=None, source='scope-packet-fixture')
            identifier = stable_id('hold', identity)
            model = HoldingVersion(**identity, holding_version=identifier,
                                   created_at=datetime.fromisoformat(FIXTURE_CREATED_AT))
            values = (identifier, '000001', 'unheld', None, None, None, None, None, None, None,
                      'scope-packet-fixture', FIXTURE_CREATED_AT, canonical_json(model.model_dump(mode='python')),
                      payload_sha256(identity))
            conn.execute('INSERT INTO holding_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', values)
        if old_receipt:
            conn.execute("INSERT INTO idempotency_responses VALUES(?,?,?,'complete',?,NULL,NULL,?,?)",
                ('synthetic-old-operation', 'legacy_portfolio_decisions', 'b' * 64,
                 '{"fixture":true}', FIXTURE_CREATED_AT, FIXTURE_CREATED_AT))
        conn.commit()
        return conn
    except Exception:
        conn.close()
        raise


@contextmanager
def captured(*, funds=3, details=2, root=True, old_receipt=True, mutate=None,
             profile='turso-fixed-read-v1'):
    source = build_fixture(funds=funds, details=details, root=root, old_receipt=old_receipt)
    try:
        if mutate:
            mutate(source)
        source.set_progress_handler(None, 0)
        with capture.capture_scope_snapshot(candidate_origin=fixtures.ORIGIN, token=fixtures.TOKEN,
                transport=fixtures.SQLiteHrana(source), operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS),
                query_mode_profile=profile) as snapshot:
            yield source, snapshot
    finally:
        source.close()


def compile_packet(snapshot, **overrides):
    options = dict(expected_resource_sha256=snapshot.safe_metadata['resource_sha256'],
                   guard_profile=compiler.GUARD_PROFILE, created_at=NOW)
    options.update(overrides)
    return compiler.compile_captured_packet(snapshot, **options)


def identity(packet):
    meta = packet.safe_metadata
    return dict(expected_resource_sha256=meta['resource_sha256'], expected_plan_sha256=meta['plan_sha256'],
                expected_packet_sha256=meta['packet_sha256'])


def clone(source):
    target = sqlite3.connect(':memory:')
    target.row_factory = sqlite3.Row
    target.deserialize(source.serialize())
    return target


def decode(value):
    tag = value['type']
    if tag == 'null':
        return None
    if tag == 'integer':
        return int(value['value'])
    if tag == 'float':
        return value['value']
    if tag == 'text':
        return value['value']
    if tag == 'blob':
        return base64.b64decode(value['base64'], validate=True)
    raise AssertionError('bad synthetic wire tag')


def condition(conn, cond, results):
    kind = cond['type']
    if kind == 'ok':
        return results[cond['step']] is True
    if kind == 'is_autocommit':
        return not conn.in_transaction
    if kind == 'not':
        return not condition(conn, cond['cond'], results)
    if kind == 'and':
        return all(condition(conn, child, results) for child in cond['conds'])
    raise AssertionError('bad synthetic condition')


def execute_packet(conn, packet, *, fail_label=None, before=None, lose_response=False):
    body = json.loads(packet.body)
    assert body['baton'] is None
    assert [request['type'] for request in body['requests']] == ['batch', 'get_autocommit', 'close']
    steps = body['requests'][0]['batch']['steps']
    results, errors, executed = [], [], []
    for index, (step, spec) in enumerate(zip(steps, packet.statement_specs)):
        label, sql, args, want_rows, result_spec = spec
        if 'condition' in step and not condition(conn, step['condition'], results):
            results.append(None)
            errors.append(None)
            continue
        executed.append(label)
        assert step['stmt']['sql'] == sql
        assert step['stmt']['named_args'] == []
        assert step['stmt']['want_rows'] is want_rows
        bound = tuple(decode(value) for value in step['stmt']['args'])
        assert compiler._same_native(bound, args)
        try:
            if before:
                before(conn, label, index)
            if label == fail_label:
                raise sqlite3.OperationalError('synthetic fault')
            cursor = conn.execute(sql, bound)
            rows = cursor.fetchall()
            if result_spec[0] == 'guard':
                assert tuple(col[0] for col in cursor.description) == ('guard_passed',)
                assert len(rows) == 1 and len(rows[0]) == 1
                assert type(rows[0][0]) is int and rows[0][0] == 1
            else:
                assert not want_rows and rows == [] and cursor.description is None
            results.append(True)
            errors.append(None)
        except sqlite3.Error as error:
            results.append(False)
            errors.append(type(error).__name__)
    commit = packet.request_specs[0][2]
    outcome = {'committed': results[commit] is True, 'autocommit': not conn.in_transaction,
               'executed': tuple(executed), 'errors': tuple(errors), 'results': tuple(results)}
    if lose_response:
        raise ResponseLost(outcome)
    return outcome


class ResponseLost(Exception):
    pass


def records(conn):
    return offline._snapshot_rows(conn, offline._objects(conn), offline._Budget(time.monotonic() + 30))


def receipt(conn, packet):
    meta = packet.safe_metadata
    row = conn.execute('SELECT rowid,request_sha256,state,response_json,owner_token,lease_expires_at '
                       'FROM idempotency_responses WHERE request_id=? AND endpoint=?',
                       (meta['migration_id'], compiler.ENDPOINT)).fetchone()
    if row is None:
        return 'unknown-absence'
    if (type(row[0]) is not int or row[0] != meta['receipt_rowid'] or row[1] != meta['plan_sha256']
            or row[2] != 'complete' or row[4] is not None or row[5] is not None):
        return 'unknown-conflict'
    try:
        parsed = json.loads(row[3])
    except Exception:
        return 'unknown-conflict'
    if parsed['plan_sha256'] != meta['plan_sha256'] or parsed['migration_id'] != meta['migration_id']:
        return 'unknown-conflict'
    return 'exact-complete-synthetic'
