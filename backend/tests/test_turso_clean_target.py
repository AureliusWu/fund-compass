"""Complete synthetic local migration plans; no sender/provider qualification."""
import base64
from contextlib import closing
from dataclasses import FrozenInstanceError, replace
import hashlib
import json
import sqlite3

import pytest

from database import turso_clean_target as compiler
from database import turso_scope_packet as kernel, turso_scope_upgrade as offline
from database import turso_machine_profile as profile
from test_turso_owner_upgrade_packet import captured, forbid_external_and_configured_access
import turso_scope_packet_fixtures as synthetic

TARGET = hashlib.sha256(b'https://new-clean-candidate.example.invalid').hexdigest()


def arguments(snapshot):
    archive = compiler.archive_clean_source(snapshot,
        expected_source_resource_sha256=snapshot.safe_metadata['resource_sha256'],
        expected_source_image_sha256=snapshot.safe_metadata['source_sha256'])
    return {'expected_source_resource_sha256': snapshot.safe_metadata['resource_sha256'],
        'expected_source_image_sha256': snapshot.safe_metadata['source_sha256'],
        'expected_source_archive_sha256': hashlib.sha256(archive.body).hexdigest(),
        'expected_target_resource_sha256': TARGET, 'created_at': synthetic.NOW}, archive


def packet(snapshot):
    args, archive = arguments(snapshot)
    plan = compiler.plan_clean_target(snapshot, **args)
    result = compiler.compile_clean_target(snapshot, **args, expected_repair_sha256=plan['repair_sha256'])
    return result, archive


def identities(compiled):
    meta = compiled.safe_metadata
    return {'expected_' + name: meta[name] for name in ('source_resource_sha256', 'source_image_sha256',
        'source_archive_sha256', 'target_resource_sha256', 'plan_sha256', 'packet_sha256')}


def empty():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


def test_complete_archive_repair_fixed_126_target_and_local_rehearsal_leave_source_unchanged():
    def operational(source):
        source.execute('INSERT INTO turso_candidate_probe_v1 VALUES(?,?,?)', ('a' * 64, 'b' * 64, synthetic.NOW))
        source.execute('INSERT INTO universe_import_state VALUES(1,?,?,?)', ('c' * 64, 29_000, synthetic.NOW))
    with captured(raw_trigger=True, mutate=operational) as (source, snapshot, model):
        before = source.serialize()
        captured_before = snapshot.connection.serialize()
        compiled, archive = packet(snapshot)
        meta = compiled.safe_metadata
        assert meta['object_count'] == 126 and meta['repaired_cell_count'] == 2
        assert meta['excluded_row_count'] == 2 and meta['owner_initial_revision'] == 0
        assert meta['browser_holdings_synced'] is False
        assert meta['source_resource_sha256'] != meta['target_resource_sha256']
        document = json.loads(archive.body)
        assert base64.b64decode(document['source_image_base64']) == captured_before
        assert document['raw_schema'] == [list(row) for row in snapshot._schema_inventory.rows]
        with closing(empty()) as target:
            outcome = synthetic.execute_packet(target, compiled)
            assert outcome['committed'] and outcome['autocommit']
            assert kernel._schema_rows(target) == profile.machine_profile_manifest().objects
            tables = {row[0] for row in target.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert not set(compiler.EXCLUDED_TABLES) & tables
            assert target.execute('SELECT revision FROM owner_sync_state').fetchone()[0] == 0
            assert target.execute('SELECT COUNT(*) FROM owner_sync_records').fetchone()[0] == 0
            journal = tuple(target.execute("SELECT kind,occurrence_id,payload_json FROM owner_machine_journal ORDER BY rowid"))
            assert len(journal) == 2
            receipt = json.loads(journal[1][2])
            assert receipt['schema'] == compiler.RECEIPT_SCHEMA and journal[1][1] == compiler.OCCURRENCE
            assert receipt['browser_holdings_synced'] is False and receipt['remote_applied'] is False
            assert 'owner-upgrade-8-to-9:' not in journal[1][2]
            assert 'machine-extension:' not in journal[1][2]
            assert target.execute('SELECT estimate,estimate_coverage FROM evidence_snapshots').fetchone()[:] == (model.estimate, model.estimate_coverage)
        report = compiler.rehearse_clean_target(snapshot, compiled)
        assert report['ok'] and report['source_unchanged']
        assert all(report[key] is False for key in compiler._FLAGS)
        assert source.serialize() == before and snapshot.connection.serialize() == captured_before


def test_no_repair_is_an_explicit_zero_delta_not_a_hidden_row_change():
    with captured(fields=()) as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        assert compiled.safe_metadata['repaired_cell_count'] == 0
        assert compiled.safe_metadata['repaired_row_count'] == 0
        assert compiler.rehearse_clean_target(snapshot, compiled)['ok']


@pytest.mark.parametrize('changed', ['expected_source_resource_sha256', 'expected_source_image_sha256',
    'expected_source_archive_sha256', 'expected_target_resource_sha256'])
def test_external_identities_cannot_be_rebound(changed):
    with captured() as (_, snapshot, _model):
        args, _archive = arguments(snapshot)
        if changed == 'expected_target_resource_sha256':
            args[changed] = args['expected_source_resource_sha256']
        else:
            args[changed] = '0' * 64
        with pytest.raises(compiler.CleanTargetError):
            compiler.plan_clean_target(snapshot, **args)


@pytest.mark.parametrize('existing', ['table', 'temp', 'header', 'attached'])
def test_target_must_be_genuinely_empty_with_zero_header_and_no_other_state(existing):
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        with closing(empty()) as target:
            if existing == 'table': target.execute('CREATE TABLE user_data(value TEXT)')
            elif existing == 'temp': target.execute('CREATE TEMP TABLE unrelated(value TEXT)')
            elif existing == 'header': target.execute('PRAGMA user_version=8')
            else: target.execute("ATTACH DATABASE ':memory:' AS extra")
            target.commit()
            before = target.serialize() if existing != 'temp' and existing != 'attached' else None
            outcome = synthetic.execute_packet(target, compiled)
            assert not outcome['committed'] and outcome['autocommit']
            assert target.execute("SELECT 1 FROM sqlite_master WHERE name='owner_machine_journal'").fetchone() is None
            if before is not None: assert target.serialize() == before


def test_every_migration_statement_failure_rolls_back_empty_schema_and_receipt():
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        assert len({spec[0] for spec in compiled.statement_specs}) == len(compiled.statement_specs)
        for label, *_rest in compiled.statement_specs[1:-2]:
            with closing(empty()) as target:
                outcome = synthetic.execute_packet(target, compiled, fail_label=label)
                assert not outcome['committed'] and outcome['autocommit'], label
                assert target.execute('SELECT COUNT(*) FROM sqlite_master').fetchone()[0] == 0, label


def test_original_archive_packet_and_plan_are_rederived_not_trusted_artifacts():
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        restored = compiler.rehydrate_clean_target(snapshot, compiled.artifact(), **identities(compiled))
        assert restored.body == compiled.body
        with pytest.raises(FrozenInstanceError): compiled.body = b'forged'
        for key in compiler._FLAGS:
            items = dict(compiled._safe_items); items[key] = True
            forged = replace(compiled, _safe_items=tuple(sorted(items.items())))
            with pytest.raises(compiler.CleanTargetError): _ = forged.safe_metadata
        artifact = compiled.artifact()
        metadata = dict(artifact['safe_metadata']); metadata['repaired_cell_count'] = 0
        artifact['safe_metadata'] = tuple(sorted(metadata.items()))
        with pytest.raises(compiler.CleanTargetError):
            compiler.rehydrate_clean_target(snapshot, artifact, **identities(compiled))


@pytest.mark.parametrize('steps', [2, 8])
def test_more_than_one_ulp_is_still_refused(steps):
    with captured(steps=steps) as (_, snapshot, _model):
        args, _archive = arguments(snapshot)
        with pytest.raises(compiler.CleanTargetError): compiler.plan_clean_target(snapshot, **args)


def test_packet_contains_only_fixed_target_ddl_and_integer_bound_exact_reals():
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        assert all(type(value) is not float for spec in compiled.statement_specs for value in spec[2])
        assert all('DROP ' not in spec[1].upper() for spec in compiled.statement_specs)
        ddl = [spec[1] for spec in compiled.statement_specs if spec[0].startswith('target:ddl:')]
        expected = [row[3] for kind in ('table', 'index', 'view', 'trigger') for row in profile.machine_profile_manifest().objects
                    if row[0] == kind and row[3] is not None and row[1] != 'sqlite_sequence']
        assert ddl == expected


@pytest.mark.parametrize('field,value', [('repaired_cell_count', 0), ('owner_initial_revision', False),
    ('source_archive_sha256', 'f' * 64), ('target_rows_sha256', 'e' * 64), ('unexpected', 'private-marker')])
def test_even_safe_summary_rederives_all_facts_and_native_types(field, value):
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        metadata = dict(compiled._safe_items); metadata[field] = value
        forged = replace(compiled, _safe_items=tuple(sorted(metadata.items())))
        with pytest.raises(compiler.CleanTargetError): _ = forged.safe_metadata


@pytest.mark.parametrize('field,value', [('source_row_count', True), ('source_image_sha256', 'f' * 64),
    ('source_archive_sha256', 'e' * 64), ('unexpected', 'private-marker')])
def test_source_archive_summary_is_not_an_editable_attestation(field, value):
    with captured() as (_, snapshot, _model):
        _args, archive = arguments(snapshot)
        metadata = dict(archive._safe_items); metadata[field] = value
        forged = replace(archive, _safe_items=tuple(sorted(metadata.items())))
        with pytest.raises(compiler.CleanTargetError): _ = forged.safe_metadata


def test_sequence_high_water_rowid_full_unrelated_public_and_private_json_are_preserved():
    def typed_data(source):
        source.executemany('INSERT INTO funds(rowid,code,name,type,pinyin) VALUES(?,?,?,?,?)',
            [(900 + index, f'{100000 + index:06d}', None if index == 0 else '', 'typed', b'\x00\xff') for index in range(100)])
        source.execute('INSERT INTO nav_history(rowid,code,date,nav,ac_return) VALUES(999,?,?,?,?)',
            ('100099', '2026-10-29', 13 / 482, None))
        source.execute('INSERT INTO decision_history(id,code,decision_date,base_nav,action,strategy_version,created_at) VALUES(?,?,?,?,?,?,?)',
            (777, '100099', '2026-10-29', 0.0, 'hold', 'private-sequence', synthetic.NOW))
        source.execute('DELETE FROM decision_history')
        source.execute("UPDATE sqlite_sequence SET rowid=991,seq=9000 WHERE name='decision_history'")
        source.execute('INSERT INTO idempotency_responses(rowid,request_id,endpoint,request_sha256,state,response_json,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?)',
            (993, 'private-json-zero', 'private-history', 'd' * 64, 'complete', '{"int":0,"real":0.0,"negative":-0.0,"null":null}', synthetic.NOW, synthetic.NOW))
    with captured(mutate=typed_data) as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        source_records = synthetic.records(snapshot.connection)
        with closing(empty()) as target:
            assert synthetic.execute_packet(target, compiled)['committed']
            target_records = synthetic.records(target)
            for table in ('funds', 'fund_detail', 'nav_history', 'sqlite_sequence', 'idempotency_responses'):
                assert kernel._same_native(tuple(tuple(row) for row in source_records[table][1]),
                                          tuple(tuple(row) for row in target_records[table][1]))
            assert target.execute("SELECT rowid,seq FROM sqlite_sequence WHERE name='decision_history'").fetchone()[:] == (991, 9000)


def test_complete_legacy_private_policy_holding_and_decision_chain_is_not_filtered():
    from datetime import date, datetime
    from database import v8_insert
    from models.v8 import canonical_json, payload_sha256, stable_id
    from service import v8_repo
    from test_acceptance_write_boundary import business_chain
    chain = business_chain()
    def roots(source):
        for kind, table in [('evidence', 'evidence_snapshots'), ('holding', 'holding_versions'),
                            ('policy', 'portfolio_policy_versions'), ('decision', 'decision_snapshots')]:
            model = chain[kind]
            values = model.model_dump(mode='python')
            identity = v8_repo._without(values, 'created_at') if kind == 'decision' else getattr(v8_repo, '_' + kind + '_identity')(model)
            parameters = []
            for column in v8_insert._COLUMNS[table]:
                field = column.removesuffix('_json') if column.endswith('_json') else column
                field = {'invalidation': 'invalidation_conditions'}.get(field, field)
                if column == 'payload_json': value = canonical_json(values)
                elif column == 'payload_sha256': value = payload_sha256(identity)
                elif column.endswith('_json'): value = canonical_json(values[field])
                else:
                    value = values[field]
                    if isinstance(value, (date, datetime)): value = value.isoformat()
                parameters.append(value)
            source.execute(*v8_insert.prepare_v8_insert(source, table, tuple(parameters)))
        evidence = chain['evidence']
        for state in evidence.source_states:
            payload = state.model_dump(mode='python')
            event_id = stable_id('src', {'evidence_id': evidence.evidence_id, 'source_id': state.source_id, 'state': payload})
            source.execute(*v8_insert.prepare_v8_insert(source, 'source_health_events', (
                event_id, evidence.evidence_id, state.source_id, state.state,
                state.last_success.isoformat() if state.last_success else None,
                state.last_failure.isoformat() if state.last_failure else None,
                state.latency_ms, state.data_age_seconds, int(state.stale), state.error_class,
                evidence.created_at.isoformat(), canonical_json(payload))))
    with captured(mutate=roots) as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        source_records = synthetic.records(snapshot.connection)
        with closing(empty()) as target:
            assert synthetic.execute_packet(target, compiled)['committed']
            target_records = synthetic.records(target)
            for table in ('holding_versions', 'portfolio_policy_versions', 'decision_snapshots', 'source_health_events', 'idempotency_responses'):
                assert kernel._same_native(tuple(tuple(row) for row in source_records[table][1]),
                                          tuple(tuple(row) for row in target_records[table][1]))
            scopes = dict(target.execute("SELECT record_kind,COUNT(*) FROM v8_record_scopes GROUP BY record_kind"))
            assert scopes['holding'] == scopes['policy'] == scopes['decision'] == 1
            assert scopes['evidence'] == 2


@pytest.mark.parametrize('operation', ['compile', 'summary', 'rehydrate'])
def test_clean_request_limit_applies_to_exact_complete_packet_not_just_source_image(monkeypatch, operation):
    with captured() as (_, snapshot, _model):
        args, _archive = arguments(snapshot)
        plan = compiler.plan_clean_target(snapshot, **args)
        compiled = compiler.compile_clean_target(snapshot, **args, expected_repair_sha256=plan['repair_sha256'])
        artifact = compiled.artifact()
        external = identities(compiled)
        monkeypatch.setattr(compiler, 'MAX_REQUEST_BYTES', len(compiled.body) - 1)
        with pytest.raises(compiler.CleanTargetError, match='^capacity_exhausted$'):
            if operation == 'compile': compiler.compile_clean_target(snapshot, **args, expected_repair_sha256=plan['repair_sha256'])
            elif operation == 'summary': _ = compiled.safe_metadata
            else: compiler.rehydrate_clean_target(snapshot, artifact, **external)


def test_rehearsal_rebuild_and_execution_share_one_total_deadline(monkeypatch):
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        original, defaults = compiler._Budget, []
        class TrackedBudget(original):
            def __init__(self, deadline=None):
                defaults.append(deadline)
                super().__init__(deadline)
        monkeypatch.setattr(compiler, '_Budget', TrackedBudget)
        assert compiler.rehearse_clean_target(snapshot, compiled)['ok']
        assert defaults.count(None) == 1


def test_financial_dependency_drift_cannot_publish_a_plan(monkeypatch):
    with captured() as (_, snapshot, _model):
        args, _archive = arguments(snapshot)
        original, calls = compiler._current_code, []
        def changed():
            code = original()
            calls.append(1)
            return code if len(calls) == 1 else (*code, ('synthetic-financial-module', 'changed'))
        monkeypatch.setattr(compiler, '_current_code', changed)
        with pytest.raises(compiler.CleanTargetError, match='^code_drift$'):
            compiler.plan_clean_target(snapshot, **args)


@pytest.mark.parametrize('moments', [(100.0, 99.0), (float('nan'),)])
def test_monotonic_nonfinite_or_backwards_clock_fails_closed(monkeypatch, moments):
    ticks = iter(moments)
    monkeypatch.setattr(compiler.time, 'monotonic', lambda: next(ticks))
    with pytest.raises(compiler.CleanTargetError, match='^operation_timeout$'):
        compiler._Budget().check()


@pytest.mark.parametrize('field', ['_safe_items', 'statement_specs', 'request_specs', '_private_archive'])
def test_rehearsal_proposal_cannot_silently_repair_forged_packet_members(field):
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        if field == '_safe_items':
            value = dict(compiled._safe_items); value['repaired_cell_count'] = 0
            value = tuple(sorted(value.items()))
        elif field == 'statement_specs':
            changed = list(compiled.statement_specs)
            changed[1] = (changed[1][0], 'DROP TABLE evidence_snapshots', (), False, ('empty', (), ()))
            value = tuple(changed)
        elif field == 'request_specs': value = compiled.request_specs[:-1]
        else: value = compiled._private_archive + b'forged-original-archive'
        with pytest.raises(compiler.CleanTargetError):
            compiler.rehearse_clean_target(snapshot, replace(compiled, **{field: value}))


def test_34928_source_rows_full_rehearsal_does_not_charge_redundant_third_source_image(record_property, monkeypatch):
    from datetime import date, timedelta
    def market_data(source):
        source.execute('DELETE FROM funds')
        source.executemany('INSERT INTO funds(code,name,type,pinyin) VALUES(?,?,?,?)',
            [(f'{index:06d}', '合成基金名称用于完整字节检查'[:15], '混合型', 'abcd') for index in range(1, 28170)])
        source.executemany('INSERT INTO nav_history(code,date,nav,ac_return) VALUES(?,?,?,?)',
            [('000001', (date(2000, 1, 1) + timedelta(days=index)).isoformat(), 1.0 + index / 10000, 2.0 + index / 10000)
             for index in range(6459)])
        # The fixture has _schema_version, two detail rows and one historical
        # idempotency receipt. Add only a fixed simple legacy watchlist tail to
        # reach the real source's exact 34,928-row scale, without private data.
        source.executemany('INSERT INTO watchlist(code,added_at) VALUES(?,?)',
            [(f'{index:06d}', synthetic.NOW) for index in range(1, 297)])
        source.commit()
    with synthetic.captured(funds=3, details=2, root=False, mutate=market_data) as (_, snapshot):
        assert snapshot.safe_metadata['row_count'] == 34928
        compiled, _archive = packet(snapshot)
        original_budget, outer = compiler._Budget, []
        class ObservedBudget(original_budget):
            def __init__(self, deadline=None):
                super().__init__(deadline)
                if deadline is None: outer.append(self)
        monkeypatch.setattr(compiler, '_Budget', ObservedBudget)
        try:
            report = compiler.rehearse_clean_target(snapshot, compiled)
        except compiler.CleanTargetError as error:
            budget = outer[-1]
            pytest.fail(f'fullscale reason={error}; rows={budget.rows}; bytes={budget.body_bytes}; sql_steps={budget.sql_steps}; context={type(error.__context__).__name__}')
        assert report['ok'] and report['source_unchanged']
        assert len(outer) == 1 and outer[0].rows == 34928
        assert outer[0].sql_steps <= 10_000_000
        record_property('full_source_row_count', snapshot.safe_metadata['row_count'])
        record_property('packet_bytes', len(compiled.body))
        record_property('local_transaction_seconds', report['local_transaction_seconds'])
        record_property('verification_rows_charged', report['verification_rows_charged'])
        record_property('operation_sql_progress_steps', report['operation_sql_progress_steps'])
        record_property('local_transaction_sql_progress_steps', report['local_transaction_sql_progress_steps'])


def test_rehearsal_does_not_reset_a_partly_spent_shared_row_budget(monkeypatch):
    with captured() as (_, snapshot, _model):
        compiled, _archive = packet(snapshot)
        original, outer = compiler._Budget, []
        class PartlySpentBudget(original):
            def __init__(self, deadline=None):
                super().__init__(deadline)
                if deadline is None:
                    outer.append(self)
                    if len(outer) == 1:
                        self.rows = kernel.MAX_ROWS - snapshot.safe_metadata['row_count'] + 1
        monkeypatch.setattr(compiler, '_Budget', PartlySpentBudget)
        with pytest.raises(compiler.CleanTargetError, match='^capacity_exhausted$'):
            compiler.rehearse_clean_target(snapshot, compiled)
        assert len(outer) == 1 and outer[0].rows == kernel.MAX_ROWS + 1


@pytest.mark.parametrize('fault', ['metadata_native_type', 'raw_schema', 'image', 'extra_key'])
def test_fresh_archive_serialization_is_verified_without_second_sql_source_scan(monkeypatch, fault):
    with captured() as (_, snapshot, _model):
        original = kernel._json
        def damaged(value):
            if type(value) is dict and value.get('profile') == compiler.ARCHIVE_PROFILE:
                changed = dict(value)
                if fault == 'metadata_native_type': changed['source_metadata'] = {**value['source_metadata'], 'from_schema': 8.0}
                elif fault == 'raw_schema':
                    rows = list(value['raw_schema'])
                    rows[0] = (*rows[0][:3], 'forged raw schema')
                    changed['raw_schema'] = rows
                elif fault == 'image': changed['source_image_base64'] = base64.b64encode(b'not-the-admitted-native-image').decode('ascii')
                else: changed['unexpected'] = 'synthetic-marker'
                value = changed
            return original(value)
        monkeypatch.setattr(kernel, '_json', damaged)
        with pytest.raises(compiler.CleanTargetError):
            compiler.archive_clean_source(snapshot,
                expected_source_resource_sha256=snapshot.safe_metadata['resource_sha256'],
                expected_source_image_sha256=snapshot.safe_metadata['source_sha256'])
