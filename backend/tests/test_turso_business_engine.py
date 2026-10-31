"""Owned loopback HTTP/Hrana evidence, never real-cloud qualification."""
from contextlib import closing
import json
import sqlite3

import pytest

from database import db, turso
from service.turso_business_engine import TursoBusinessEngine, TursoBusinessError
from service import owner_sync_repo as local_sync
from test_owner_sync_turso import ORIGIN, TOKEN, local_hrana, raw_request, create_operation
from test_turso_machine_profile import seed


def engine():
    return TursoBusinessEngine(ORIGIN, TOKEN)


def test_constructor_has_zero_io_and_never_reads_configuration(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('constructor reached network or configured database')
    monkeypatch.setattr(turso.requests, 'Session', forbidden)
    monkeypatch.setattr(db, 'get_conn', forbidden)
    instance = engine()
    assert instance.sync and instance.analysis and instance.policy and instance.machine
    assert TOKEN not in repr(instance)


def test_real_driver_sync_full_profile_read_receipt_and_original_header(tmp_path, monkeypatch):
    path = tmp_path / 'business.sqlite3'
    seed(path, header=8, optional=('turso_candidate_probe_v1',))
    request = raw_request('business-sync-001', [create_operation()])
    with local_hrana(path, monkeypatch) as (state, unused):
        instance = engine()
        result = instance.sync.apply(request)
        assert result.status == 200 and result.body['revision'] == 1
        duplicate = instance.sync.apply(request)
        assert duplicate == result
        change = instance.sync.read_changes(since_revision=0)
        assert change['upper_revision'] == 1
        from models.owner_sync import parse_sync_request
        parsed = parse_sync_request(request)
        assert instance.sync.reconcile(parsed.request_id, parsed.request_hash()).state == 'matched'
        assert len(state.frames) > 1
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 8
        assert conn.execute('SELECT COUNT(*) FROM owner_sync_receipts').fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM turso_candidate_probe_v1').fetchone()[0] == 0


def test_unrelated_public_universe_is_not_cloned_or_count_guarded(tmp_path, monkeypatch):
    path = tmp_path / 'business.sqlite3'
    seed(path)
    with closing(sqlite3.connect(path)) as conn:
        conn.executemany('INSERT INTO funds(code,name,type) VALUES(?,?,?)',
                         [(str(100000 + index), 'public', '股票型') for index in range(29_000)])
        conn.commit()
    with local_hrana(path, monkeypatch):
        result = engine().sync.apply(raw_request('business-universe-001', [create_operation()]))
        assert result.status == 200
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute('SELECT COUNT(*) FROM funds').fetchone()[0] == 29_000


def test_bad_complete_profile_never_initializes_schema(tmp_path, monkeypatch):
    path = tmp_path / 'business.sqlite3'
    seed(path)
    with closing(sqlite3.connect(path)) as conn:
        conn.execute('UPDATE _schema_version SET version=8')
        conn.commit()
    with local_hrana(path, monkeypatch) as (state, unused):
        with pytest.raises(TursoBusinessError):
            engine().sync.apply(raw_request('business-bad-001', [create_operation()]))
        assert all('BEGIN IMMEDIATE' not in json.dumps(frame) for frame in state.frames)


def test_callback_sentinel_is_preserved_before_network(tmp_path, monkeypatch):
    path = tmp_path / 'business.sqlite3'
    seed(path)
    sentinel = RuntimeError('authorization expired synthetic')
    def revoke(): raise sentinel
    with local_hrana(path, monkeypatch) as (state, unused):
        with pytest.raises(RuntimeError) as error:
            engine().sync.apply(raw_request('business-auth-001', [create_operation()]), before_commit=revoke)
        assert error.value is sentinel and not state.frames


def test_complete_100_owner_codes_800_nav_and_29k_universe_fit_existing_snapshot_budget(tmp_path, monkeypatch):
    from datetime import date, timedelta
    path = tmp_path / 'business-large.sqlite3'
    seed(path, header=9)
    codes = [f'{index:06d}' for index in range(1, 101)]
    with closing(sqlite3.connect(path)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        result = local_sync.apply_sync_local(conn, raw_request('business-large-seed', [create_operation(key=code + '::A') for code in codes]))
        assert result.status == 200
        conn.executemany('INSERT INTO funds(code,name,type) VALUES(?,?,?)',
            [(str(100000 + index), 'unrelated public', '股票型') for index in range(29_000)] +
            [(code, 'owner public', '股票型') for code in codes])
        dates = [(date(2024, 1, 1) + timedelta(days=index)).isoformat() for index in range(800)]
        conn.executemany('INSERT INTO nav_history(code,date,nav,ac_return) VALUES(?,?,?,?)',
            ((code, day, 1.25, None) for code in codes for day in dates))
        conn.commit()
    with local_hrana(path, monkeypatch):
        result = engine().sync.read_changes(since_revision=0)
        assert len(result['changes']) == 100 and result['upper_revision'] == 1
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute('SELECT COUNT(*) FROM nav_history').fetchone()[0] == 80_000


def test_public_composite_null_key_is_rejected_before_send(tmp_path, monkeypatch):
    path = tmp_path / 'business-null.sqlite3'
    seed(path, header=9)
    with closing(sqlite3.connect(path)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        assert local_sync.apply_sync_local(conn, raw_request('null-key-seed', [create_operation()])).status == 200
        conn.executemany('INSERT INTO nav_history(code,date,nav) VALUES(?,?,?)', [('000001', None, 1.0), ('000001', None, 1.0)])
        conn.commit()
    with local_hrana(path, monkeypatch) as (state, unused):
        with pytest.raises(TursoBusinessError):
            engine().sync.apply(raw_request('null-key-operation', [create_operation(key='000002::A')], expected=1))
        assert all('BEGIN IMMEDIATE' not in json.dumps(frame) for frame in state.frames)


def test_preimage_conflict_rolls_back_once_without_replay(tmp_path, monkeypatch):
    from service.turso_business_engine import TursoBusinessConflict
    path = tmp_path / 'business-race.sqlite3'
    seed(path)
    with local_hrana(path, monkeypatch) as (state, unused):
        instance = engine()
        assert instance.sync.apply(raw_request('race-seed', [create_operation()])).status == 200
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("INSERT INTO funds(code,name,type) VALUES('000001','selected','股票型')")
            conn.commit()
        original = state.pipeline
        writes = []
        def race(frame):
            steps = frame['requests'][0].get('batch', {}).get('steps', [])
            if steps and steps[0]['stmt']['sql'] == 'BEGIN IMMEDIATE':
                writes.append(frame)
                with closing(sqlite3.connect(path)) as conn:
                    conn.execute("UPDATE funds SET type='changed concurrently' WHERE code='000001'")
                    conn.commit()
            return original(frame)
        state.pipeline = race
        with pytest.raises(TursoBusinessConflict):
            instance.sync.apply(raw_request('race-new', [create_operation(key='000002::A')], expected=1))
        assert len(writes) == 1
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute('SELECT revision FROM owner_sync_state').fetchone()[0] == 1
        assert conn.execute('SELECT COUNT(*) FROM owner_sync_receipts').fetchone()[0] == 1


def test_monotonic_rollback_is_fail_closed(monkeypatch):
    import service.turso_business_engine as module
    moments = iter([100.0, 100.0, 99.0])
    monkeypatch.setattr(module.time, 'monotonic', lambda: next(moments))
    budget = module._Budget(30, None)
    with pytest.raises(TursoBusinessError):
        budget.check()


@pytest.mark.parametrize('fault', ['guard_zero', 'guard_empty', 'guard_multiple', 'affected_zero'])
def test_malformed_committed_result_is_unknown_and_original_receipt_does_not_resend(tmp_path, monkeypatch, fault):
    from models.owner_sync import parse_sync_request
    path = tmp_path / 'business-result.sqlite3'
    seed(path)
    request = raw_request('business-result-001', [create_operation()])
    with local_hrana(path, monkeypatch) as (state, unused):
        original, writes = state.pipeline, []
        def corrupt(frame):
            response, lost = original(frame)
            steps = frame['requests'][0].get('batch', {}).get('steps', [])
            if steps and steps[0]['stmt']['sql'] == 'BEGIN IMMEDIATE':
                writes.append(frame)
                results = response['results'][0]['response']['result']['step_results']
                if fault == 'affected_zero':
                    index = next(index for index, step in enumerate(steps) if step['stmt']['sql'].startswith('INSERT INTO main.'))
                    results[index]['affected_row_count'] = 0
                else:
                    row = [{'type': 'integer', 'value': '0' if fault == 'guard_zero' else '1'}]
                    results[1]['rows'] = [] if fault == 'guard_empty' else [row, row] if fault == 'guard_multiple' else [row]
            return response, lost
        state.pipeline = corrupt
        instance = engine()
        with pytest.raises(TursoBusinessError):
            instance.sync.apply(request)
        parsed = parse_sync_request(request)
        assert instance.sync.reconcile(parsed.request_id, parsed.request_hash()).state == 'matched'
        assert len(writes) == 1


def test_exact_real_one_ulp_public_preimage_change_is_not_normalized(tmp_path, monkeypatch):
    import math
    from service.turso_business_engine import TursoBusinessConflict
    path = tmp_path / 'business-real.sqlite3'
    seed(path)
    value = 13 / 482
    with local_hrana(path, monkeypatch) as (state, unused):
        instance = engine()
        assert instance.sync.apply(raw_request('real-seed', [create_operation()])).status == 200
        with closing(sqlite3.connect(path)) as conn:
            conn.execute("INSERT INTO nav_history(code,date,nav,ac_return) VALUES('000001','2026-10-29',?,NULL)", (value,))
            conn.commit()
        # A no-race write must pass the exact REAL guard, rather than fail
        # merely because a decimal/JSON binding rounded the captured value.
        assert instance.sync.apply(raw_request('real-normal', [create_operation(key='000002::A')], expected=1)).status == 200
        original = state.pipeline
        def race(frame):
            steps = frame['requests'][0].get('batch', {}).get('steps', [])
            if steps and steps[0]['stmt']['sql'] == 'BEGIN IMMEDIATE':
                with closing(sqlite3.connect(path)) as conn:
                    conn.execute("UPDATE nav_history SET nav=? WHERE code='000001'", (math.nextafter(value, math.inf),))
                    conn.commit()
            return original(frame)
        state.pipeline = race
        with pytest.raises(TursoBusinessConflict):
            instance.sync.apply(raw_request('real-raced', [create_operation(key='000003::A')], expected=2))
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute('SELECT revision FROM owner_sync_state').fetchone()[0] == 2


@pytest.mark.parametrize('change_at,expected_receipts', [(2, 0), (3, 1)])
def test_business_dependency_drift_before_send_or_after_commit_never_returns_success(tmp_path, monkeypatch, change_at, expected_receipts):
    import service.turso_business_engine as module
    from models.owner_sync import parse_sync_request
    path = tmp_path / 'business-drift.sqlite3'
    seed(path)
    request = raw_request('business-drift-001', [create_operation()])
    original, calls = module._fingerprints, []
    def fingerprint():
        calls.append(1)
        return original() if len(calls) < change_at else (*module._LOADED, ('synthetic-financial-dependency', 'changed'))
    with local_hrana(path, monkeypatch) as (state, unused):
        monkeypatch.setattr(module, '_fingerprints', fingerprint)
        instance = engine()
        with pytest.raises(TursoBusinessError):
            instance.sync.apply(request)
        writes = sum('BEGIN IMMEDIATE' in json.dumps(frame) for frame in state.frames)
        assert writes == expected_receipts
        monkeypatch.setattr(module, '_fingerprints', original)
        parsed = parse_sync_request(request)
        receipt = instance.sync.reconcile(parsed.request_id, parsed.request_hash())
        assert receipt.state == ('matched' if expected_receipts else 'absent')
        assert sum('BEGIN IMMEDIATE' in json.dumps(frame) for frame in state.frames) == writes


@pytest.mark.parametrize('across_tables', [False, True])
def test_paged_snapshot_charges_shared_image_budget_before_retaining_next_page(tmp_path, monkeypatch, across_tables):
    import service.turso_business_engine as module
    path = tmp_path / 'business-page-cap.sqlite3'
    seed(path)
    with closing(sqlite3.connect(path)) as conn:
        count = 4 if across_tables else 10
        conn.executemany('INSERT INTO decision_history(code,name,decision_date,base_nav,action,strategy_version,created_at) VALUES(?,?,?,?,?,?,?)',
            [(f'{index:06d}', 'x' * 24_000, '2026-10-29', 1.0, 'hold', 'synthetic', '2026-10-29T00:00:00Z') for index in range(count)])
        if across_tables:
            conn.executemany('INSERT INTO watchlist(code,added_at) VALUES(?,?)',
                [(f'{index:06d}', 'x' * 24_000) for index in range(10)])
        conn.commit()
    # Modest synthetic data and deliberately SMALLER limits prove aggregate
    # enforcement without allocating a huge image or changing production caps.
    monkeypatch.setattr(module, 'MAX_PAGE_ROWS', 2)
    monkeypatch.setattr(module, 'MAX_BYTES', 128_000)
    with local_hrana(path, monkeypatch) as (state, unused):
        with pytest.raises(TursoBusinessError):
            engine().sync.read_changes(since_revision=0)
        page_reads = [step['stmt']['sql'] for frame in state.frames
            for operation in frame['requests'] if operation['type'] == 'batch'
            for step in operation['batch']['steps']
            if step['stmt']['sql'].startswith('SELECT rowid,')]
        history = [sql for sql in page_reads if 'FROM main."decision_history"' in sql]
        watches = [sql for sql in page_reads if 'FROM main."watchlist"' in sql]
        assert len(history) == (2 if across_tables else 3)
        assert len(watches) == (1 if across_tables else 0)
        assert all('BEGIN IMMEDIATE' not in json.dumps(frame) for frame in state.frames)
        assert not state.streams
        assert any(operation.get('stmt', {}).get('sql') == 'ROLLBACK'
                   for frame in state.frames for operation in frame['requests'])
