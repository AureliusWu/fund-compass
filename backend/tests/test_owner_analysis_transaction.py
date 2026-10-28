"""Original analysis and caller journal share one real synthetic transaction."""
import hashlib
import json

import pytest

from database import db
from database.owner_machine_schema import provision_owner_machine_candidate, verify_owner_machine_schema
from models.owner_analysis import parse_owner_analysis_request
from service import owner_analysis_repo as repo, v8_repo
from test_owner_analysis_repo import connect, fixture, image, raw


@pytest.fixture
def machine_fixture(fixture):
    with connect(fixture.path) as conn:
        provision_owner_machine_candidate(conn, synthetic_candidate=True)
        verify_owner_machine_schema(conn)
    return fixture


def snapshot(path):
    result = image(path)
    with connect(path) as conn:
        result["owner_machine_journal"] = [tuple(row) for row in conn.execute(
            "SELECT * FROM owner_machine_journal ORDER BY kind,record_id")]
    return result


def journal(conn, request, *, analysis=None):
    payload = json.dumps({"test": "caller-owned-analysis-binding", "request_hash": request.request_hash()},
                         sort_keys=True, separators=(",", ":"))
    conn.execute("INSERT INTO owner_machine_journal VALUES(?,?,?,?,?,?,?,?)", (
        "owner-machine-schema-1", "task", "transaction-test-task", "transaction-test-occurrence",
        analysis, "2026-08-25T06:30:00+00:00", payload, hashlib.sha256(payload.encode()).hexdigest(),
    ))


@pytest.mark.parametrize("finish", ["commit", "rollback"])
def test_analysis_and_caller_journal_are_one_actual_transaction(machine_fixture, monkeypatch, finish):
    f = machine_fixture
    before = snapshot(f.path)
    request = parse_owner_analysis_request(raw(f))
    original_ready = repo._ready

    def forbidden(*_args, **_kwargs):
        pytest.fail("in-transaction analysis cannot acquire storage or own its readiness/lifecycle")

    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "transaction", forbidden)
    monkeypatch.setattr(repo, "_ready", forbidden)
    conn = connect(f.path)
    sql = []
    conn.set_trace_callback(sql.append)
    try:
        conn.execute("BEGIN IMMEDIATE")
        verify_owner_machine_schema(conn)  # The caller verifies its complete profile.
        result = repo._create_analysis_in_transaction(conn, request, repo._guard(None))
        assert result.status == 200 and result.body["source_current"] is True
        assert result.body["run"]["source"]["revision"] == f.request["expected_revision"]
        journal(conn, request, analysis=request.request_id)
        assert conn.in_transaction is True
        assert snapshot(f.path) == before  # Independent connection cannot see it yet.
        assert sum(statement == "BEGIN IMMEDIATE" for statement in sql) == 1
        assert not any(statement in {"COMMIT", "ROLLBACK"} for statement in sql)
        getattr(conn, finish)()
    finally:
        conn.close()
    after = snapshot(f.path)
    if finish == "rollback":
        assert after == before
    else:
        assert len(after["owner_analysis_runs"]) == 1
        assert len(after["owner_analysis_components"]) == 3
        assert len(after["holding_versions"]) == 3 and len(after["decision_snapshots"]) == 3
        assert len(after["owner_machine_journal"]) == 2
        # Public reconciliation owns its separate read transaction and must run
        # the real readiness verifier; only the internal write kernel omits it.
        monkeypatch.setattr(repo, "_ready", original_ready)
        with connect(f.path) as reader:
            found = reader.execute("SELECT analysis_request_id FROM owner_machine_journal WHERE kind='task'").fetchone()
            assert found[0] == request.request_id
            receipt = repo.reconcile_analysis_local(reader, request.request_id, request.request_hash())
            assert receipt.state == "matched" and receipt.result.body == result.body


def test_analysis_kernel_rejects_inactive_connection_before_any_sql(machine_fixture):
    f = machine_fixture
    before = snapshot(f.path)
    request = parse_owner_analysis_request(raw(f))
    conn = connect(f.path)
    sql = []
    conn.set_trace_callback(sql.append)
    try:
        assert conn.in_transaction is False
        with pytest.raises(ValueError, match="active_transaction_required"):
            repo._create_analysis_in_transaction(conn, request, repo._guard(None))
        assert sql == [] and conn.in_transaction is False
    finally:
        conn.close()
    assert snapshot(f.path) == before


def test_kernel_preserves_original_receipt_without_rerunning_new_strategy(machine_fixture, monkeypatch):
    f = machine_fixture
    request = parse_owner_analysis_request(raw(f))
    conn = connect(f.path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        first = repo._create_analysis_in_transaction(conn, request, repo._guard(None))
        conn.commit()
        before = snapshot(f.path)
        monkeypatch.setattr(repo, "_plan", lambda *_args: pytest.fail("a stored request must not rerun current strategy"))
        monkeypatch.setattr(repo, "ANALYSIS_STRATEGY_VERSION", "different-current-test-version")
        conn.execute("BEGIN IMMEDIATE")
        replay = repo._create_analysis_in_transaction(conn, request, repo._guard(None))
        assert replay == first and conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()
    assert snapshot(f.path) == before


def test_mid_write_failure_leaves_journal_and_analysis_rollback_to_caller(machine_fixture, monkeypatch):
    f = machine_fixture
    before = snapshot(f.path)
    request = parse_owner_analysis_request(raw(f))
    original = v8_repo._save_decision_in_transaction

    def fail_after_actual_decision(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("synthetic-after-real-analysis-write")

    monkeypatch.setattr(v8_repo, "_save_decision_in_transaction", fail_after_actual_decision)
    conn = connect(f.path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        journal(conn, request)
        with pytest.raises(RuntimeError, match="after-real-analysis-write"):
            repo._create_analysis_in_transaction(conn, request, repo._guard(None))
        assert conn.in_transaction is True
        assert conn.execute("SELECT COUNT(*) FROM holding_versions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM decision_snapshots").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM owner_machine_journal WHERE kind='task'").fetchone()[0] == 1
        assert snapshot(f.path) == before
        conn.rollback()
    finally:
        conn.close()
    assert snapshot(f.path) == before


def test_kernel_requires_exact_source_revision_without_rolling_back_caller(machine_fixture):
    f = machine_fixture
    before = snapshot(f.path)
    request = parse_owner_analysis_request(raw(f, expected_revision=1))
    conn = connect(f.path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        journal(conn, request)
        with pytest.raises(repo._Fault) as error:
            repo._create_analysis_in_transaction(conn, request, repo._guard(None))
        assert error.value.code == "analysis_source_conflict" and error.value.status == 409
        assert conn.in_transaction is True
        assert conn.execute("SELECT COUNT(*) FROM owner_machine_journal WHERE kind='task'").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM owner_analysis_runs").fetchone()[0] == 0
        conn.rollback()
    finally:
        conn.close()
    assert snapshot(f.path) == before


def test_analysis_protocol_cannot_begin_commit_rollback_or_close(machine_fixture):
    f = machine_fixture
    before = snapshot(f.path)
    request = parse_owner_analysis_request(raw(f))
    conn = connect(f.path)

    class TransactionView:
        @property
        def in_transaction(self):
            return conn.in_transaction

        def execute(self, statement, *args):
            assert not statement.strip().upper().startswith(("BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"))
            return conn.execute(statement, *args)

        def commit(self):
            pytest.fail("analysis kernel cannot commit")

        def rollback(self):
            pytest.fail("analysis kernel cannot roll back")

        def close(self):
            pytest.fail("analysis kernel cannot close")

    try:
        conn.execute("BEGIN IMMEDIATE")
        result = repo._create_analysis_in_transaction(TransactionView(), request, repo._guard(None))
        assert result.status == 200 and conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()
    assert snapshot(f.path) == before
