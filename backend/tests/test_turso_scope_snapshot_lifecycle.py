"""Memory-only phase-budget lifetime regressions, never a cloud qualification.

The real monotonic clock and all existing 30-second limits remain unchanged.
Only an explicitly observed phase budget's deadline is expired as synthetic
fault injection. No handler is removed by a test from a captured reference.
"""
import hashlib
import sqlite3
import time

import pytest

from database import turso_scope_packet as compiler, turso_scope_snapshot as capture, turso_scope_upgrade as offline
import test_turso_scope_response as guarded
import turso_scope_packet_fixtures as s


REAL_MONOTONIC = time.monotonic
PROGRESS_READ = (
    'WITH RECURSIVE finite(n) AS '
    '(VALUES(1) UNION ALL SELECT n+1 FROM finite WHERE n<2000) '
    'SELECT SUM(n) FROM finite'
)
PROGRESS_SUM = 2_001_000
CAPTURE_FALSE = (
    'remote_verified', 'remote_applied', 'remote_restore_verified',
    'formal_release_verified', 'migration_rehearsed', 'apply_preimage_verified',
)
PACKET_FALSE = (
    'remote_verified', 'remote_applied', 'remote_restore_verified',
    'formal_release_verified', 'apply_preimage_verified', 'server_capabilities_verified',
)


@pytest.fixture(autouse=True)
def isolated_access(monkeypatch):
    # Reuse the existing complete socket/configured-DB/non-memory SQLite and
    # finite trusted-source file guard. Do not change its Path.resolve checks.
    guarded.isolated_access.__wrapped__(monkeypatch)


def observe_budgets(monkeypatch, module):
    original = module._Budget
    observed = []

    class ObservedBudget(original):
        def __init__(self, deadline):
            super().__init__(deadline)
            self.observed_calls = 0
            self.observed_aborts = 0
            observed.append(self)

        def progress(self):
            result = super().progress()
            self.observed_calls += 1
            self.observed_aborts += int(result == 1)
            return result

    monkeypatch.setattr(module, '_Budget', ObservedBudget)
    return observed


def expire_phase(budget):
    # This is a phase-specific deadline fault, never a fake clock or a change
    # to MAX_SECONDS. The original check/progress implementations still run.
    assert time.monotonic is REAL_MONOTONIC
    assert capture.MAX_SECONDS == compiler.MAX_SECONDS == 30.0
    budget.deadline = REAL_MONOTONIC() - 1.0


def assert_source_bindings(snapshot, expected_metadata, expected_inventory):
    metadata = snapshot.safe_metadata
    assert metadata == expected_metadata
    assert snapshot._schema_inventory is expected_inventory
    image = snapshot.connection.serialize()
    image_digest = hashlib.sha256(image).hexdigest()
    rows_digest = offline._rows_digest(s.records(snapshot.connection))
    contract_digest = offline._contract_digest(offline._objects(snapshot.connection))
    raw_digest = capture._schema_inventory_digest(expected_inventory.rows)
    assert image_digest == metadata['source_sha256']
    assert rows_digest == metadata['source_rows_sha256']
    assert contract_digest == metadata['source_contract_sha256']
    assert hashlib.sha256(b'https://synthetic-candidate.turso.io').hexdigest() == metadata['resource_sha256']
    assert raw_digest == expected_inventory.exact_sha256
    assert expected_inventory.resource_sha256 == metadata['resource_sha256']
    assert expected_inventory.source_image_sha256 == metadata['source_sha256']
    assert expected_inventory.source_rows_sha256 == metadata['source_rows_sha256']
    tables = sorted(
        row[1] for row in expected_inventory.rows
        if row[0] == 'table' and row[1] in offline._OPERATIONAL_DEFINITIONS
    )
    statistics = any(row[:2] == ('table', 'sqlite_stat1') for row in expected_inventory.rows)
    assert hashlib.sha256(offline._json_bytes({
        'profile': 'known-operational-v1', 'tables': tables,
        'optimizer_statistics': statistics,
    })).hexdigest() == metadata['inventory_sha256']
    assert all(metadata[key] is False for key in CAPTURE_FALSE)
    assert snapshot.connection.execute('PRAGMA query_only').fetchone()[0] == 1
    assert not snapshot.connection.in_transaction


def test_successful_handoff_expires_capture_budget_without_interrupting_owned_readonly_image(monkeypatch):
    budgets = observe_budgets(monkeypatch, capture)
    with s.captured() as (_, snapshot):
        assert len(budgets) == 1
        budget = budgets[0]
        assert budget.observed_aborts == 0
        metadata = dict(snapshot.safe_metadata)
        inventory = snapshot._schema_inventory
        before_calls = budget.observed_calls
        expire_phase(budget)
        # This bounded, fixed readonly query executes more than 1000 VM steps:
        # the old retained callback would deterministically abort it.
        assert snapshot.connection.execute(PROGRESS_READ).fetchone()[0] == PROGRESS_SUM
        assert budget.observed_calls == before_calls
        assert budget.observed_aborts == 0
        assert_source_bindings(snapshot, metadata, inventory)
        with pytest.raises(sqlite3.OperationalError):
            snapshot.connection.execute('INSERT INTO _schema_version VALUES(2,8)')
        # Python's legacy transaction mode begins before the rejected DML.
        # Clean up this test-owned attempt, not an unknown remote submission.
        snapshot.connection.rollback()
        assert_source_bindings(snapshot, metadata, inventory)
        assert budget.observed_calls == before_calls
        assert budget.observed_aborts == 0


def test_expired_capture_phase_still_permits_fresh_compile_and_external_sha_rehydration(monkeypatch):
    budgets = observe_budgets(monkeypatch, capture)
    with s.captured() as (_, snapshot):
        initial = s.compile_packet(snapshot)
        artifact = initial.artifact()
        identities = dict(s.identity(initial))
        metadata = dict(snapshot.safe_metadata)
        inventory = snapshot._schema_inventory
        assert len(budgets) == 1
        before_calls = budgets[0].observed_calls
        expire_phase(budgets[0])
        compile_calls = []
        original_compile = compiler.compile_captured_packet

        def recompiling(*args, **kwargs):
            compile_calls.append(True)
            return original_compile(*args, **kwargs)

        monkeypatch.setattr(compiler, 'compile_captured_packet', recompiling)
        compiled = s.compile_packet(snapshot)
        rebuilt = compiler.rehydrate_packet(snapshot, artifact, **identities)
        assert compile_calls == [True, True]
        assert initial is not compiled and initial is not rebuilt
        for expected in (compiled, rebuilt):
            other = expected.artifact()
            assert set(other) == set(artifact)
            assert all(compiler._same_native(artifact[key], other[key]) for key in artifact)
            assert all(expected.safe_metadata[key] is False for key in PACKET_FALSE)
        assert budgets[0].observed_calls == before_calls
        assert_source_bindings(snapshot, metadata, inventory)


def test_capture_stage_sql_progress_still_aborts_and_closes_before_any_handoff(monkeypatch):
    budgets = observe_budgets(monkeypatch, capture)
    references = []
    observations = []
    original_assemble = capture._assemble

    def expire_while_capturing(reference, decoded, tables, budget, query_mode_profile):
        references.append(reference)
        assert budgets == [budget]
        assert transport.closed and transport.response.closed
        before_calls = budget.observed_calls
        expire_phase(budget)
        try:
            reference.execute(PROGRESS_READ).fetchone()
        finally:
            # The real SQLite callback must have run and returned its original
            # abort value, not a wrapper exception or fake-clock answer.
            observations.append((budget.observed_calls - before_calls, budget.observed_aborts))
        return original_assemble(reference, decoded, tables, budget, query_mode_profile)

    monkeypatch.setattr(capture, '_assemble', expire_while_capturing)
    source = s.build_fixture()
    try:
        # Exactly the existing synthetic-source fixture setup; this is not the
        # captured reference's handler and is not the capture-stage budget.
        source.set_progress_handler(None, 0)
        transport = s.fixtures.SQLiteHrana(source)
        with pytest.raises(capture.SnapshotError, match='^capture_local_validation_failed$'):
            capture.capture_scope_snapshot(
                candidate_origin=s.fixtures.ORIGIN, token=s.fixtures.TOKEN,
                transport=transport,
                operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS),
                query_mode_profile='turso-fixed-read-v1',
            )
        assert len(transport.calls) == 1
        assert transport.closed and transport.response.closed
        assert len(references) == 1
        # Keep these assertions OUTSIDE capture's catch-all: an AssertionError
        # inside _assemble is itself mapped to capture_local_validation_failed.
        assert len(observations) == 1
        assert observations[0][0] > 0 and observations[0][1] > 0
        assert len(budgets) == 1 and budgets[0].deadline < REAL_MONOTONIC()
        with pytest.raises(sqlite3.ProgrammingError):
            references[0].execute('SELECT 1')
    finally:
        source.close()


def test_new_compiler_phase_retains_real_sql_progress_and_deadline_rejection(monkeypatch):
    capture_budgets = observe_budgets(monkeypatch, capture)
    with s.captured() as (_, snapshot):
        metadata = dict(snapshot.safe_metadata)
        inventory = snapshot._schema_inventory
        expire_phase(capture_budgets[0])
        compile_budgets = observe_budgets(monkeypatch, compiler)
        references = []
        original_target = compiler._target

        def expire_new_compiler_phase(reference, raw_rows, budget):
            references.append(reference)
            assert budget is compile_budgets[0]
            assert budget is not capture_budgets[0]
            assert budget.deadline > REAL_MONOTONIC()
            before_calls = budget.observed_calls
            expire_phase(budget)
            with pytest.raises(sqlite3.OperationalError):
                reference.execute(PROGRESS_READ).fetchone()
            assert budget.observed_calls > before_calls
            assert budget.observed_aborts > 0
            # Original compiler check raises its fixed compile_time_limit;
            # the orchestrator must reject and close its private reference.
            budget.check()
            return original_target(reference, raw_rows, budget)

        monkeypatch.setattr(compiler, '_target', expire_new_compiler_phase)
        with pytest.raises(compiler.CompilerError, match='^compile_time_limit$'):
            s.compile_packet(snapshot)
        assert len(references) == 1
        with pytest.raises(sqlite3.ProgrammingError):
            references[0].execute('SELECT 1')
        assert_source_bindings(snapshot, metadata, inventory)
