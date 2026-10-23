"""Pure synthetic tests. No files/config/credentials/network/remote evidence."""
from dataclasses import FrozenInstanceError, replace
import hashlib
import json
import math
import sqlite3
import socket
import time

import pytest

from database import db, turso_scope_packet as c, turso_scope_snapshot as capture, turso_scope_upgrade as offline
import turso_scope_packet_fixtures as s


@pytest.fixture(autouse=True)
def no_external_or_configured_access(monkeypatch):
    """Function-scoped guards; importing test helpers never patches globals."""
    def forbidden(*_args, **_kwargs):
        raise AssertionError('external/configured access forbidden in packet tests')
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(socket, 'socket', forbidden)
    monkeypatch.setattr(db, 'get_conn', forbidden)
    monkeypatch.setattr(db, 'init_db', forbidden)
    monkeypatch.setattr(offline, '_scope_upgrade', forbidden)


def fails(code):
    return pytest.raises(c.CompilerError, match='^' + code + '$')


def test_capture_compile_execute_full_typed_postimage_and_frozen_specs():
    with s.captured() as (source, snapshot):
        before = s.records(source)
        packet = s.compile_packet(snapshot)
        assert type(packet.body) is bytes
        assert packet.safe_metadata['source_row_count'] == 8
        assert packet.safe_metadata['guard_profile'] == c.GUARD_PROFILE
        assert packet.safe_metadata['receipt_rowid'] == 2
        assert packet.safe_metadata['packet_sha256'] == hashlib.sha256(packet.body).hexdigest()
        for key in ('remote_verified', 'remote_applied', 'remote_restore_verified', 'formal_release_verified',
                    'apply_preimage_verified', 'server_capabilities_verified'):
            assert packet.safe_metadata[key] is False
        assert all(len(spec[2]) <= 900 for spec in packet.statement_specs)
        assert not any(spec[1].startswith('PRAGMA') for spec in packet.statement_specs)
        assert packet.statement_specs[0][1] == 'BEGIN IMMEDIATE'
        assert packet.statement_specs[-2][1] == 'COMMIT'
        assert packet.statement_specs[-1][1] == 'ROLLBACK'
        for _, _, _, want_rows, expected in packet.statement_specs:
            assert want_rows is (expected[0] == 'guard')
            if want_rows:
                assert expected == ('guard', ('guard_passed',), (('integer', '1'),))
        with pytest.raises(FrozenInstanceError):
            packet.body = b'tamper'
        meta = packet.safe_metadata
        meta['remote_verified'] = True
        assert packet.safe_metadata['remote_verified'] is False
        assert 'synthetic-fund' not in repr(packet) and 'INSERT' not in repr(packet)
        target = s.clone(source)
        try:
            outcome = s.execute_packet(target, packet)
            assert outcome['committed'] is True and outcome['autocommit'] is True
            after = s.records(target)
            for table, record in before.items():
                if table == '_schema_version':
                    assert after[table][1] == [(1, 1, 9)]
                elif table == 'idempotency_responses':
                    assert len(after[table][1]) == len(record[1]) + 1
                    assert after[table][1][:len(record[1])] == record[1]
                else:
                    assert offline._rows_digest({table: after[table]}) == offline._rows_digest({table: record})
            assert len(after['v8_record_scopes'][1]) == 1
            assert s.receipt(target, packet) == 'exact-complete-synthetic'
            assert snapshot.connection.execute('SELECT version FROM _schema_version').fetchone()[0] == 8
        finally:
            target.close()


@pytest.mark.parametrize('profile', ['query-only-v1', 'turso-fixed-read-v1'])
def test_both_explicit_read_capture_profiles_accepted(profile):
    with s.captured(profile=profile) as (_, snapshot):
        packet = s.compile_packet(snapshot)
        assert packet.safe_metadata['source_row_count'] == snapshot.safe_metadata['row_count']


@pytest.mark.parametrize('value', ['', None, False, 'query-only-v1', 'sqlite-is-v1', c.GUARD_PROFILE + ' '])
def test_unknown_guard_profile_early_fail(value):
    with fails('invalid_compile_arguments'):
        c.compile_captured_packet(None, expected_resource_sha256='a'*64, guard_profile=value, created_at=s.NOW)


def test_guard_profile_omission_not_default():
    with pytest.raises(TypeError, match='guard_profile'):
        c.compile_captured_packet(None, expected_resource_sha256='a'*64, created_at=s.NOW)


@pytest.mark.parametrize('now', ['', None, '2026-10-03T00:00:00+00:00', '2026-10-03T00:00:00.1Z',
                                 '2026-02-30T00:00:00Z', '2026-10-03T24:00:00Z'])
def test_timestamp_closed_and_canonical(now):
    with fails('invalid_compile_arguments'):
        c.compile_captured_packet(None, expected_resource_sha256='a'*64, guard_profile=c.GUARD_PROFILE, created_at=now)


@pytest.mark.parametrize('identity', ['', 'A'*64, 'a'*63, None, b'a'*64, True])
def test_external_identity_sha_admission(identity):
    with fails('invalid_compile_arguments'):
        c.compile_captured_packet(None, expected_resource_sha256=identity, guard_profile=c.GUARD_PROFILE, created_at=s.NOW)


def test_wrong_expected_resource_rejects_before_source_decode():
    with s.captured() as (_, snapshot):
        with fails('source_identity_mismatch'):
            s.compile_packet(snapshot, expected_resource_sha256='a'*64)


@pytest.mark.parametrize('predicate', ['0', 'NULL', '(SELECT 1 WHERE 0)', '(SELECT NULL)',
                                      'EXISTS(SELECT 1 WHERE 0)'])
def test_scalar_assertion_false_null_and_no_row_fail(predicate):
    conn = sqlite3.connect(':memory:')
    try:
        statement = c._guard('test', predicate)
        with pytest.raises(sqlite3.OperationalError, match='integer overflow'):
            conn.execute(statement.sql).fetchall()
        good = conn.execute(c._guard('test', '1').sql)
        assert tuple(col[0] for col in good.description) == ('guard_passed',)
        row = good.fetchone()
        assert len(row) == 1 and type(row[0]) is int and row[0] == 1
    finally:
        conn.close()


@pytest.mark.parametrize('actual,expected,pass_guard', [
    (1, 1, True), (1, 1.0, False), (1.0, 1, False), (1.0, 1.0, True), (None, None, True),
    (None, 0, False), (0, None, False), ('a\x00b', 'a\x00b', True), ('a\x00b', 'a\x00c', False),
    (b'a\x00b', b'a\x00b', True), (b'a\x00b', b'a\x00c', False), ('1', 1, False),
    (0.0, -0.0, False), (-0.0, 0.0, False), (-0.0, -0.0, True), (0.0, 0.0, True),
    (1.0000000000000002, 1.0, False), (b'a', 'a', False)])
def test_type_byte_null_zero_match(actual, expected, pass_guard):
    conn = sqlite3.connect(':memory:')
    try:
        statement = c._guard('types', c._match('a', 'e'), (actual, expected),
                              'WITH test(a,e) AS (VALUES(?,?)) ')
        # Inner CTE columns referenced with a scalar subquery, no top-level FROM.
        statement = c._guard('types', '(SELECT ' + c._match('a', 'e') + ' FROM test)',
                             (actual, expected), 'WITH test(a,e) AS (VALUES(?,?)) ')
        if pass_guard:
            assert conn.execute(statement.sql, statement.args).fetchone()[0] == 1
        else:
            with pytest.raises(sqlite3.OperationalError, match='integer overflow'):
                conn.execute(statement.sql, statement.args).fetchall()
    finally:
        conn.close()


@pytest.mark.parametrize('fault', ['capability:atan2-zero', 'schema:exact-raw', 'count:funds', 'rows:funds:0',
    'receipt:absent', 'ddl:0', 'backfill:v8_record_scopes:0', 'version:cas', 'version:changes-one',
    'version:post', 'receipt:insert', 'receipt:changes-one', 'receipt:post-count', 'receipt:exact', 'commit'])
def test_fault_prefix_rolls_back_all_schema_data_receipt(fault):
    with s.captured() as (source, snapshot):
        packet = s.compile_packet(snapshot)
        target = s.clone(source)
        try:
            before_rows = offline._rows_digest(s.records(target))
            before_schema = c._schema_rows(target)
            outcome = s.execute_packet(target, packet, fail_label=fault)
            assert outcome['committed'] is False and outcome['autocommit'] is True
            assert 'rollback' in outcome['executed']
            assert c._schema_rows(target) == before_schema
            assert offline._rows_digest(s.records(target)) == before_rows
            assert s.receipt(target, packet) == 'unknown-absence'
            assert fault in outcome['executed']
        finally:
            target.close()


@pytest.mark.parametrize('mutation', ['missing', 'extra', 'value', 'null_zero', 'nul_tail', 'raw_schema', 'sequence'])
def test_changed_source_fails_same_lock_complete_preguard(mutation):
    def mutate_target(conn):
        if mutation == 'missing':
            conn.execute("DELETE FROM funds WHERE code='000003'")
        elif mutation == 'extra':
            conn.execute("INSERT INTO funds(code,name) VALUES('999999','extra')")
        elif mutation == 'value':
            conn.execute("UPDATE funds SET name='changed' WHERE code='000001'")
        elif mutation == 'null_zero':
            conn.execute("UPDATE fund_detail SET scale=0 WHERE code='000002'")
        elif mutation == 'nul_tail':
            conn.execute("UPDATE funds SET name=? WHERE code='000001'", ('a\x00c',))
        elif mutation == 'raw_schema':
            conn.execute('PRAGMA writable_schema=ON')
            conn.execute("UPDATE sqlite_master SET sql=replace(sql,'CREATE TABLE','CREATE  TABLE') WHERE name='funds'")
            conn.execute('PRAGMA writable_schema=OFF')
        else:
            conn.execute("INSERT INTO decision_history(code,decision_date,base_nav,action,strategy_version,created_at) "
                         "VALUES('000001','2026-09-30',1,'hold','fixture','2026-09-30T00:00:00+00:00')")
            conn.execute('DELETE FROM decision_history')
        conn.commit()
    def source_mutate(conn):
        conn.execute("UPDATE funds SET name=? WHERE code='000001'", ('a\x00b',))
        conn.execute("UPDATE fund_detail SET scale=NULL WHERE code='000002'")
        conn.commit()
    with s.captured(mutate=source_mutate) as (source, snapshot):
        packet = s.compile_packet(snapshot)
        target = s.clone(source)
        try:
            mutate_target(target)
            before_schema = c._schema_rows(target)
            before_rows = offline._rows_digest(s.records(target))
            outcome = s.execute_packet(target, packet)
            assert not outcome['committed'] and outcome['autocommit']
            assert c._schema_rows(target) == before_schema
            assert offline._rows_digest(s.records(target)) == before_rows
        finally:
            target.close()


@pytest.mark.parametrize('late', ['fund_name', 'receipt_old_json', 'extra_receipt', 'version', 'scope'])
def test_full_postimage_guards_reject_changes_after_preguard(late):
    with s.captured() as (source, snapshot):
        packet = s.compile_packet(snapshot)
        target = s.clone(source)
        injected = []
        def before(conn, label, index):
            if not injected and label == 'version:cas':
                injected.append(True)
                if late == 'fund_name':
                    conn.execute("UPDATE funds SET name='bad-postimage' WHERE code='000001'")
                elif late == 'receipt_old_json':
                    conn.execute("UPDATE idempotency_responses SET response_json='bad' WHERE endpoint='legacy_portfolio_decisions'")
                elif late == 'extra_receipt':
                    conn.execute("INSERT INTO idempotency_responses VALUES('extra','x','bad','complete','{}',NULL,NULL,'x','x')")
                elif late == 'version':
                    conn.execute('UPDATE _schema_version SET version=9 WHERE singleton=1')
                else:
                    conn.execute('DROP TRIGGER immutable_v8_record_scopes_delete')
        try:
            rows_before = offline._rows_digest(s.records(target))
            outcome = s.execute_packet(target, packet, before=before)
            assert injected and not outcome['committed'] and outcome['autocommit']
            assert offline._rows_digest(s.records(target)) == rows_before
            assert target.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone() is None
        finally:
            target.close()


def test_raw_source_spelling_preserved_target_not_canonicalized():
    def spelling(conn):
        conn.execute('PRAGMA writable_schema=ON')
        conn.execute("UPDATE sqlite_master SET sql=replace(sql,'CREATE TABLE','CREATE  TABLE') WHERE name='funds'")
        conn.execute('PRAGMA writable_schema=OFF')
        conn.commit()
    with s.captured(mutate=spelling) as (source, snapshot):
        raw = next(row[3] for row in snapshot._schema_inventory.rows if row[:2] == ('table','funds'))
        canonical = snapshot.connection.execute("SELECT sql FROM sqlite_master WHERE name='funds'").fetchone()[0]
        assert raw != canonical and 'CREATE  TABLE' in raw
        packet = s.compile_packet(snapshot)
        schema_specs = [spec for spec in packet.statement_specs if spec[0] == 'schema:exact-raw']
        assert len(schema_specs) == 2
        assert raw in schema_specs[0][2] and raw in schema_specs[1][2]
        target = s.clone(source)
        try:
            assert s.execute_packet(target, packet)['committed']
            assert target.execute("SELECT sql FROM sqlite_master WHERE name='funds'").fetchone()[0] == raw
        finally:
            target.close()


def test_receipt_explicit_free_i64_rowid_avoids_max_random():
    def max_rowid(conn):
        conn.execute('UPDATE idempotency_responses SET rowid=?', (2**63-1,))
        conn.commit()
    with s.captured(mutate=max_rowid) as (source, snapshot):
        packet = s.compile_packet(snapshot)
        assert packet.safe_metadata['receipt_rowid'] == 1
        insert = next(spec for spec in packet.statement_specs if spec[0] == 'receipt:insert')
        assert insert[2][0] == 1 and type(insert[2][0]) is int
        assert not any(word in insert[1].upper() for word in ('IGNORE','REPLACE','UPSERT'))
        target = s.clone(source)
        try:
            assert s.execute_packet(target, packet)['committed']
            assert target.execute('SELECT rowid FROM idempotency_responses ORDER BY rowid').fetchall()[1][0] == 2**63-1
            assert s.receipt(target, packet) == 'exact-complete-synthetic'
        finally:
            target.close()


def test_response_lost_receipt_same_id_no_reclaim_or_retry_and_unknown_absence():
    with s.captured() as (source, snapshot):
        packet = s.compile_packet(snapshot)
        target = s.clone(source)
        try:
            assert s.receipt(target, packet) == 'unknown-absence'
            with pytest.raises(s.ResponseLost):
                s.execute_packet(target, packet, lose_response=True)
            assert s.receipt(target, packet) == 'exact-complete-synthetic'
            old_sha = offline._rows_digest(s.records(target))
            replay = s.execute_packet(target, packet)
            assert replay['committed'] is False and replay['autocommit']
            assert offline._rows_digest(s.records(target)) == old_sha
        finally:
            target.close()


def test_guard_capability_missing_or_zero_coercing_fails_closed():
    with s.captured() as (source, snapshot):
        packet = s.compile_packet(snapshot)
        for impl in (None, lambda y,x: math.pi):
            target = s.clone(source)
            try:
                target.create_function('atan2', 2, impl)
                outcome = s.execute_packet(target, packet)
                assert not outcome['committed'] and outcome['autocommit']
                assert target.execute('SELECT version FROM _schema_version').fetchone()[0] == 8
            finally:
                target.close()


def test_rehydrate_and_presend_recompile_original_sha_immutable():
    with s.captured() as (_, snapshot):
        packet = s.compile_packet(snapshot)
        copy = c.rehydrate_packet(snapshot, packet.artifact(), **s.identity(packet))
        assert c._same_native(copy.statement_specs, packet.statement_specs) and copy.body == packet.body
        assert c.validate_packet_before_send(snapshot, packet, **s.identity(packet)).body == packet.body
        with fails('packet_integrity_invalid'):
            c.rehydrate_packet(snapshot, packet.artifact(), **(s.identity(packet) | {'expected_plan_sha256':'a'*64}))


@pytest.mark.parametrize('tamper', ['body', 'resigned_body', 'metadata_bool', 'metadata_list', 'recipe_list',
    'want_rows_int', 'args_bool', 'spec_list', 'result_list', 'request_list', 'extra', 'profile', 'zero_sign'])
def test_artifact_tamper_and_resigned_artifact_rejected(tamper):
    with s.captured() as (_, snapshot):
        packet = s.compile_packet(snapshot)
        artifact = packet.artifact()
        expected = s.identity(packet)
        if tamper in ('body', 'resigned_body'):
            artifact['body'] += b' '
            if tamper == 'resigned_body':
                expected['expected_packet_sha256'] = hashlib.sha256(artifact['body']).hexdigest()
        elif tamper == 'metadata_bool':
            artifact['metadata'] = tuple((k, True if k=='ok' else v) for k,v in artifact['metadata'])
            artifact['metadata'] = tuple((k, True if k=='receipt_rowid' else v) for k,v in artifact['metadata'])
        elif tamper == 'metadata_list':
            artifact['metadata'] = list(artifact['metadata'])
        elif tamper == 'recipe_list':
            artifact['recipe'] = list(artifact['recipe'])
        elif tamper == 'request_list':
            artifact['request_specs'] = list(artifact['request_specs'])
        elif tamper == 'extra':
            artifact['private'] = True
        elif tamper == 'profile':
            artifact['profile'] = c.ARTIFACT_PROFILE + '-unknown'
        else:
            specs = list(artifact['statement_specs'])
            index = next(i for i,spec in enumerate(specs) if spec[0]=='capability:atan2-zero')
            spec = list(specs[index])
            if tamper == 'want_rows_int':
                spec[3] = 1
            elif tamper == 'args_bool':
                spec[2] = (True, *spec[2][1:])
            elif tamper == 'zero_sign':
                spec[2] = (-0.0, *spec[2][1:])
            elif tamper == 'spec_list':
                specs[index] = spec
            else:
                spec[4] = ('guard', ['guard_passed'], (('integer','1'),))
            if tamper != 'spec_list':
                specs[index] = tuple(spec)
            artifact['statement_specs'] = tuple(specs)
        with pytest.raises(c.CompilerError, match='^(artifact_invalid|packet_integrity_invalid)$'):
            c.rehydrate_packet(snapshot, artifact, **expected)


@pytest.mark.parametrize('bad', [True, [], float('nan'), float('inf'), -(2**63)-1, 2**63,
                                'x'*(c.MAX_CELL_BYTES+1), b'x'*(c.MAX_CELL_BYTES+1)],
                         ids=['bool','list','nan','inf','min-underflow','max-overflow','long-text','long-blob'])
def test_native_cell_limit_and_types(bad):
    with fails('source_value_invalid'):
        c._value(bad)


def test_tuple_and_scalar_subclass_rejected_in_statement_and_metadata():
    class Tuple(tuple): pass
    class String(str): pass
    for spec in (Tuple(('empty',(),())), ('guard',(String('guard_passed'),),(('integer','1'),)),
                 ('guard',['guard_passed'],(('integer','1'),))):
        with fails('packet_integrity_invalid'):
            c.Statement('x','SELECT 1',(),spec[0]=='guard',spec)
    with s.captured() as (_, snapshot):
        meta = dict(snapshot.safe_metadata)
        meta['source_kind'] = String(meta['source_kind'])
        with fails('source_metadata_invalid'):
            c._metadata(meta)


@pytest.mark.parametrize('key,value', [('row_count', True),('table_count',False),('from_schema',True),
    ('remote_verified',True),('apply_preimage_verified',True),('query_only_observed',True),
    ('query_only_observed',2),('server_write_protection_verified',True),('source_kind','wrong'),
    ('inventory_sha256','a'*64),('source_rows_sha256','a'*64),('source_contract_sha256','a'*64),
    ('source_sha256','a'*64)])
def test_mutated_source_metadata_rejected(key,value):
    with s.captured() as (_, snapshot):
        meta = dict(snapshot.safe_metadata)
        meta[key] = value
        bad = replace(snapshot, safe_metadata=meta)
        with pytest.raises(c.CompilerError):
            s.compile_packet(bad)


@pytest.mark.parametrize('mode', ['query_write', 'temp', 'attach', 'transaction', 'closed', 'image_mutated',
                                 'missing_inventory', 'inventory_mismatch'])
def test_source_context_memory_inventory_admission(mode):
    with s.captured() as (_, snapshot):
        bad = snapshot
        if mode == 'missing_inventory':
            bad = replace(snapshot,_schema_inventory=None)
        elif mode == 'inventory_mismatch':
            raw = snapshot._schema_inventory
            raw = replace(raw, resource_sha256='a'*64)
            bad = replace(snapshot,_schema_inventory=raw)
        elif mode == 'closed':
            snapshot.connection.close()
        else:
            snapshot.connection.execute('PRAGMA query_only=OFF')
            if mode == 'temp':
                snapshot.connection.execute('CREATE TEMP TABLE bad(x)')
            elif mode == 'attach':
                snapshot.connection.execute("ATTACH ':memory:' AS bad")
            elif mode == 'transaction':
                snapshot.connection.execute('BEGIN')
            elif mode == 'image_mutated':
                snapshot.connection.execute("UPDATE funds SET name='mutated' WHERE code='000001'")
                snapshot.connection.commit()
            if mode != 'query_write':
                snapshot.connection.execute('PRAGMA query_only=ON')
        with pytest.raises(c.CompilerError):
            s.compile_packet(bad)


@pytest.mark.parametrize('limit,value', [('MAX_ROWS',1),('MAX_CELL_BYTES',1),('MAX_IMAGE_BYTES',16),
                                       ('MAX_PACKET_BYTES',128),('MAX_STEPS',4),('MAX_SECONDS',-1.0)])
def test_compile_resource_limits_fail_closed(monkeypatch,limit,value):
    with s.captured() as (_, snapshot):
        monkeypatch.setattr(c, limit, value)
        with pytest.raises(c.CompilerError):
            s.compile_packet(snapshot)


def test_current_source_fingerprint_drift_fails_early(monkeypatch):
    monkeypatch.setattr(c,'_LOADED_CODE',(('compiler','a'*64),))
    with fails('compiler_code_drift'):
        c.compile_captured_packet(None,expected_resource_sha256='a'*64,guard_profile=c.GUARD_PROFILE,created_at=s.NOW)


def test_same_reserved_slot_identity_stable_despite_plan_timestamp_change():
    with s.captured() as (_, snapshot):
        first = s.compile_packet(snapshot)
        second = s.compile_packet(snapshot,created_at='2026-10-03T00:00:01Z')
        assert first.safe_metadata['migration_id'] == second.safe_metadata['migration_id']
        assert first.safe_metadata['plan_sha256'] != second.safe_metadata['plan_sha256']
        assert first.safe_metadata['receipt_rowid'] == second.safe_metadata['receipt_rowid']


def test_no_root_complete_empty_scope_backfill_supported():
    with s.captured(root=False,old_receipt=False) as (source,snapshot):
        packet = s.compile_packet(snapshot)
        target = s.clone(source)
        try:
            assert s.execute_packet(target,packet)['committed']
            assert target.execute('SELECT COUNT(*) FROM v8_record_scopes').fetchone()[0] == 0
            assert s.receipt(target,packet) == 'exact-complete-synthetic'
        finally:
            target.close()


def forged_memory(snapshot, mutation, *, rebind_rows=True):
    # Tests deliberately rebind every public/private digest, so rejection must
    # be structural/semantic rather than just an old checksum mismatch.
    conn = s.clone(snapshot.connection)
    conn.set_progress_handler(None, 0)
    mutation(conn)
    conn.commit()
    meta = dict(snapshot.safe_metadata)
    if rebind_rows:
        records = s.records(conn)
        meta['source_rows_sha256'] = offline._rows_digest(records)
        meta['row_count'] = sum(len(record[1]) for record in records.values())
        meta['table_count'] = len(records)
    conn.execute('PRAGMA query_only=ON')
    meta['source_sha256'] = hashlib.sha256(conn.serialize()).hexdigest()
    inventory = replace(snapshot._schema_inventory, source_image_sha256=meta['source_sha256'],
                        source_rows_sha256=meta['source_rows_sha256'])
    return conn, replace(snapshot, connection=conn, safe_metadata=meta, _schema_inventory=inventory)


@pytest.mark.parametrize('header', [0,8])
def test_supported_source_header_preserved_no_remote_setter(header):
    def mutate(conn):
        conn.execute(f'PRAGMA user_version={header}')
        conn.commit()
    with s.captured(mutate=mutate) as (source,snapshot):
        packet = s.compile_packet(snapshot)
        target = s.clone(source)
        try:
            assert s.execute_packet(target,packet)['committed']
            assert target.execute('PRAGMA user_version').fetchone()[0] == header
            assert target.execute('SELECT version FROM _schema_version').fetchone()[0] == 9
        finally:
            target.close()


@pytest.mark.parametrize('mode', ['header9','version7','version9','versionMissing','extraTable','changedSchema','malformedSchema',
                                 'sqliteSequenceNegative','sqliteSequenceReal','invalidHoldingPayload'])
def test_forged_all_bound_image_still_closed_schema_version_lineage(mode):
    def mutation(conn):
        if mode=='header9':
            conn.execute('PRAGMA user_version=9')
        elif mode in ('version7','version9'):
            conn.execute('UPDATE _schema_version SET version=?', (int(mode[-1]),))
        elif mode=='versionMissing':
            conn.execute('DELETE FROM _schema_version')
        elif mode=='extraTable':
            conn.execute('CREATE TABLE arbitrary_extra(x)')
        elif mode in ('changedSchema','malformedSchema'):
            conn.execute('PRAGMA writable_schema=ON')
            conn.execute("UPDATE sqlite_master SET sql=replace(sql,'CHECK',?) WHERE type='table' AND name='holding_versions'",
                         ('CHECK ' if mode=='changedSchema' else 'UNSUPPORTED_CHECK',))
            conn.execute('PRAGMA writable_schema=OFF')
        elif mode.startswith('sqliteSequence'):
            conn.execute('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)',
                         ('decision_history',-1 if mode=='sqliteSequenceNegative' else 1.5))
        else:
            # Only trusted synthetic DDL, not user SQL or a real image.
            trigger = conn.execute("SELECT sql FROM sqlite_master WHERE name='immutable_holding_versions_update'").fetchone()[0]
            conn.execute('DROP TRIGGER immutable_holding_versions_update')
            conn.execute("UPDATE holding_versions SET payload_json='{}'")
            conn.execute(trigger)
    with s.captured() as (_,snapshot):
        conn,bad = forged_memory(snapshot,mutation,rebind_rows=(mode not in ('changedSchema','malformedSchema')))
        try:
            expected = ('source_version_invalid' if mode.startswith(('header','version'))
                        else 'source_schema_invalid' if mode in ('extraTable','changedSchema')
                        else 'source_value_invalid' if mode.startswith('sqliteSequence')
                        else 'source_context_invalid')
            with fails(expected):
                s.compile_packet(bad)
        finally:
            conn.close()


@pytest.mark.parametrize('mode',['source-image','typed-rows','raw-sha','resource','profile'])
def test_private_inventory_internal_bindings_revalidated(mode):
    with s.captured() as (_,snapshot):
        inventory = snapshot._schema_inventory
        changes = {'source-image':dict(source_image_sha256='a'*64), 'typed-rows':dict(source_rows_sha256='a'*64),
                   'resource':dict(resource_sha256='a'*64)}
        if mode in changes:
            bad_inventory = replace(inventory,**changes[mode])
        else:
            bad_inventory = replace(inventory)
            object.__setattr__(bad_inventory,'exact_sha256' if mode=='raw-sha' else 'profile',
                               'a'*64 if mode=='raw-sha' else 'unknown')
        with fails('source_inventory_invalid'):
            s.compile_packet(replace(snapshot,_schema_inventory=bad_inventory))


def test_existing_reserved_slot_refuses_in_progress_or_complete_without_reclaim():
    resource = hashlib.sha256(b'https://synthetic-candidate.turso.io').hexdigest()
    def slot(conn):
        conn.execute("INSERT INTO idempotency_responses VALUES(?,?,?,'in_progress',NULL,'owner','lease','time',NULL)",
                     ('scope-migration-8-to-9:'+resource,c.ENDPOINT,'b'*64))
        conn.commit()
    with s.captured(mutate=slot) as (source,snapshot):
        before = offline._rows_digest(s.records(source))
        with fails('existing_receipt_requires_reconcile'):
            s.compile_packet(snapshot)
        assert offline._rows_digest(s.records(source)) == before


def test_raw_null_schema_guard_and_sql_literal_bytes_are_distinct():
    conn = sqlite3.connect(':memory:')
    try:
        conn.execute("CREATE TABLE t(x TEXT DEFAULT 'a  b', y TEXT UNIQUE)")
        rows = c._schema_rows(conn)
        assert any(row[3] is None for row in rows)
        assert conn.execute(next(c._schema_guards(rows)).sql,next(c._schema_guards(rows)).args).fetchone()[0] == 1
        for change in ('null-empty','literal-space'):
            mutated = tuple((kind,name,table, '' if sql is None else sql) for kind,name,table,sql in rows) if change=='null-empty' else tuple(
                (kind,name,table,sql.replace("'a  b'","'a b'") if sql else sql) for kind,name,table,sql in rows)
            statement = next(c._schema_guards(mutated))
            with pytest.raises(sqlite3.OperationalError,match='integer overflow'):
                conn.execute(statement.sql,statement.args).fetchall()
        canonical = tuple((kind,name,table,sql.replace("'a  b'","'a b'") if sql else sql) for kind,name,table,sql in rows)
        with fails('source_schema_invalid'):
            c._supported_schema(rows,canonical)
    finally:
        conn.close()


def test_bool_native_equal_int_and_zero_sign_tamper_not_equivalent():
    assert c._same_native((1,), (True,)) is False
    assert c._same_native((0.0,),(-0.0,)) is False
    class Tuple(tuple): pass
    assert c._same_native((),Tuple()) is False
    with s.captured(root=False,old_receipt=False) as (_,snapshot):
        packet = s.compile_packet(snapshot)
        assert packet.safe_metadata['receipt_rowid'] == 1
        artifact = packet.artifact()
        artifact['metadata'] = tuple((key, True if key=='receipt_rowid' else value) for key,value in artifact['metadata'])
        with fails('packet_integrity_invalid'):
            c.rehydrate_packet(snapshot,artifact,**s.identity(packet))


@pytest.mark.parametrize('name', ['a\x00b',b'a\x00b'])
def test_capture_to_packet_nul_text_blob_and_stored_real_zero_roundtrip(name):
    def mutation(conn):
        conn.execute("UPDATE funds SET name=? WHERE code='000001'",(name,))
        conn.execute("UPDATE fund_detail SET latest_nav=? WHERE code='000001'",(-0.0,))
        conn.commit()
    with s.captured(mutate=mutation) as (source,snapshot):
        value = snapshot.connection.execute("SELECT latest_nav FROM fund_detail WHERE code='000001'").fetchone()[0]
        assert type(value) is float and value.hex() == '0x0.0p+0'  # REAL affinity canonicalizes stored zero.
        packet = s.compile_packet(snapshot)
        target = s.clone(source)
        try:
            assert s.execute_packet(target,packet)['committed']
            actual = target.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0]
            assert type(actual) is type(name) and actual == name
            assert target.execute("SELECT latest_nav FROM fund_detail WHERE code='000001'").fetchone()[0].hex() == value.hex()
        finally:
            target.close()


def altered_packet_metadata(packet,key,value):
    values = dict(packet._metadata)
    values[key] = value
    return tuple(sorted(values.items()))


@pytest.mark.parametrize('key', sorted(c._PACKET_REMOTE_FLAGS))
def test_constructor_and_accessor_six_remote_flags_literal_false(key):
    with s.captured() as (_,snapshot):
        packet = s.compile_packet(snapshot)
        for value in (True,0,1,None):
            metadata = altered_packet_metadata(packet,key,value)
            with fails('packet_integrity_invalid'):
                replace(packet,_metadata=metadata)
            object.__setattr__(packet,'_metadata',metadata)
            with fails('packet_integrity_invalid'):
                _ = packet.safe_metadata
            object.__setattr__(packet,'_metadata',altered_packet_metadata(packet,key,False))
            assert packet.safe_metadata[key] is False


@pytest.mark.parametrize('key',['private_sql','unknown','token','__proto__'])
def test_constructor_and_accessor_unknown_private_keys_not_exposed(key):
    with s.captured() as (_,snapshot):
        packet = s.compile_packet(snapshot)
        metadata = altered_packet_metadata(packet,key,'synthetic-private-marker')
        with fails('packet_integrity_invalid'):
            replace(packet,_metadata=metadata)
        object.__setattr__(packet,'_metadata',metadata)
        with fails('packet_integrity_invalid'):
            _ = packet.safe_metadata


@pytest.mark.parametrize('key,value', [
    ('ok',1),('ok',False),('profile','unknown'),('evidence_scope','unknown'),('guard_profile','unknown'),
    ('migration_id','scope-migration-8-to-9:'+'a'*64),('receipt_rowid',True),('receipt_rowid',0),
    ('receipt_rowid',2**63-1),('packet_bytes',True),('packet_bytes',1),('batch_steps',True),('batch_steps',3),
    ('source_row_count',True),('source_row_count',0),('source_row_count',100001),('source_row_count',9),
    ('max_statement_args',True),('max_statement_args',901),('max_statement_args',0),
    ('max_response_bytes',True),('max_response_bytes',1),('from_schema',True),('from_schema',7),
    ('to_schema',True),('to_schema',8),('resource_sha256','A'*64),('source_rows_sha256','nothex'),
    ('source_image_sha256',('a'*64,)),('raw_schema_sha256',b'a'*64),('plan_sha256',False),
    ('packet_sha256','a'*64),('compiler_sha256','a'*64),('contract_code_sha256','a'*64)])
def test_packet_metadata_native_closed_values_and_payload_binding(key,value):
    with s.captured() as (_,snapshot):
        packet = s.compile_packet(snapshot)
        metadata = altered_packet_metadata(packet,key,value)
        with fails('packet_integrity_invalid'):
            replace(packet,_metadata=metadata)
        object.__setattr__(packet,'_metadata',metadata)
        with fails('packet_integrity_invalid'):
            _ = packet.safe_metadata


def test_public_accessor_rejects_otherwise_well_shaped_metadata_replacement():
    with s.captured() as (_,snapshot):
        packet = s.compile_packet(snapshot)
        original = packet._metadata
        # This is a valid native 64hex shape, but not the constructed evidence.
        object.__setattr__(packet,'_metadata',altered_packet_metadata(packet,'source_rows_sha256','a'*64))
        with fails('packet_integrity_invalid'):
            _ = packet.safe_metadata
        object.__setattr__(packet,'_metadata',original)
        assert packet.safe_metadata['source_rows_sha256'] == snapshot.safe_metadata['source_rows_sha256']
        object.__setattr__(packet,'body',packet.body+b' ')
        with fails('packet_integrity_invalid'):
            _ = packet.safe_metadata


def test_packet_metadata_native_keys_duplicate_order_missing_and_subclasses():
    class String(str): pass
    class Tuple(tuple): pass
    with s.captured() as (_,snapshot):
        packet = s.compile_packet(snapshot)
        invalid = [Tuple(packet._metadata),list(packet._metadata),packet._metadata[::-1],packet._metadata[1:],
                   (*packet._metadata,packet._metadata[0]),
                   tuple((String(key),value) for key,value in packet._metadata),
                   altered_packet_metadata(packet,'profile',String(c.PACKET_PROFILE))]
        for metadata in invalid:
            with fails('packet_integrity_invalid'):
                replace(packet,_metadata=metadata)
            object.__setattr__(packet,'_metadata',metadata)
            with fails('packet_integrity_invalid'):
                _ = packet.safe_metadata
        # No broad error catch: exact native-key rules are exercised directly.
