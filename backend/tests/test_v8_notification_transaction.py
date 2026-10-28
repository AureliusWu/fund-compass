"""The existing notification claim can share a real caller-owned transaction.

Only fresh synthetic local SQLite is used; no HTTP transport or cloud evidence.
"""
from datetime import timedelta

import pytest

from database import db
from service import v8_repo
from strategy.decision_v2 import build_decision_snapshot
from test_v8_atomic_holding_decision import T1, atomic_db, connect, holding


WINDOW = "2026-08-25T14:30+08:00"


@pytest.fixture
def notification_db(atomic_db):
    path, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    v8_repo.save_holding_and_decision(candidate, decision)
    # A caller-owned table represents the future occurrence/source binding,
    # not a replacement lock or a production schema extension.
    conn = connect(path)
    try:
        conn.execute("CREATE TABLE caller_binding (identity TEXT PRIMARY KEY)")
        conn.commit()
    finally:
        conn.close()
    return path, decision


def phases(path):
    conn = connect(path)
    try:
        return {
            "caller": [tuple(row) for row in conn.execute("SELECT * FROM caller_binding")],
            "events": [tuple(row) for row in conn.execute(
                "SELECT * FROM notification_events ORDER BY event_log_id")],
        }
    finally:
        conn.close()


def record(conn, decision, status, *, window=WINDOW, error=None, detail=None):
    return v8_repo._record_notification_events_in_transaction(
        conn, decision_ids=[decision.decision_id], scheduled_window=window,
        status=status, attempt_no=0 if status == "scheduled" else 1,
        natural_schedule=True, occurred_at=T1, error_class=error, detail=detail,
    )[0]


@pytest.mark.parametrize("finish", ["commit", "rollback"])
def test_same_transaction_binds_caller_data_scheduled_and_attempted(notification_db, monkeypatch, finish):
    path, decision = notification_db
    before = phases(path)

    def forbidden(*_args, **_kwargs):
        pytest.fail("notification kernel cannot open a global connection or transaction")

    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "transaction", forbidden)
    conn = connect(path)
    sql = []
    conn.set_trace_callback(sql.append)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO caller_binding VALUES(?)", ("same-transaction",))
        scheduled = record(conn, decision, "scheduled")
        attempted = record(conn, decision, "attempted")
        assert scheduled.claimed is False and scheduled.duplicate is False
        assert attempted.claimed is True and attempted.duplicate is False
        assert conn.in_transaction is True
        assert phases(path) == before  # No implicit commit or secondary writer.
        assert sum(statement == "BEGIN IMMEDIATE" for statement in sql) == 1
        assert not any(statement in {"COMMIT", "ROLLBACK"} for statement in sql)
        getattr(conn, finish)()
    finally:
        conn.close()
    after = phases(path)
    if finish == "rollback":
        assert after == before
    else:
        assert after["caller"] == [("same-transaction",)]
        assert len(after["events"]) == 2


def test_missing_schedule_does_not_rollback_caller_work(notification_db):
    path, decision = notification_db
    before = phases(path)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("INSERT INTO caller_binding VALUES(?)", ("caller-still-owns",))
        with pytest.raises(v8_repo.SnapshotConflictError, match="no scheduled event"):
            record(conn, decision, "attempted")
        assert conn.in_transaction is True
        assert conn.execute("SELECT identity FROM caller_binding").fetchone()[0] == "caller-still-owns"
        assert phases(path) == before
        conn.rollback()
    finally:
        conn.close()
    assert phases(path) == before


def test_inactive_connection_rejected_before_any_sql(notification_db):
    path, decision = notification_db
    conn = connect(path)
    sql = []
    conn.set_trace_callback(sql.append)
    try:
        assert conn.in_transaction is False
        with pytest.raises(ValueError, match="active_transaction_required"):
            record(conn, decision, "scheduled")
        assert sql == [] and conn.in_transaction is False
    finally:
        conn.close()


def test_connection_protocol_cannot_commit_rollback_close_or_begin(notification_db):
    path, decision = notification_db
    conn = connect(path)

    class TransactionView:
        @property
        def in_transaction(self):
            return conn.in_transaction

        def execute(self, statement, *args):
            assert not statement.strip().upper().startswith(("BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"))
            return conn.execute(statement, *args)

        def commit(self):
            pytest.fail("kernel cannot commit")

        def rollback(self):
            pytest.fail("kernel cannot roll back")

        def close(self):
            pytest.fail("kernel cannot close")

    try:
        conn.execute("BEGIN IMMEDIATE")
        view = TransactionView()
        record(view, decision, "scheduled")
        assert record(view, decision, "attempted").claimed is True
        assert conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()


def test_exact_attempt_replay_keeps_original_event_and_changed_detail_conflicts(notification_db):
    path, decision = notification_db
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        record(conn, decision, "scheduled")
        first = record(conn, decision, "attempted", detail={"occurrence": "fixed"})
        conn.commit()
        before = phases(path)
        conn.execute("BEGIN IMMEDIATE")
        replay = v8_repo._record_notification_events_in_transaction(
            conn, decision_ids=[decision.decision_id], scheduled_window=WINDOW,
            status="attempted", attempt_no=1, natural_schedule=True,
            occurred_at=T1 + timedelta(minutes=5), detail={"occurrence": "fixed"},
        )[0]
        assert replay.claimed is False and replay.duplicate is True
        assert replay.event == first.event
        with pytest.raises(v8_repo.SnapshotConflictError, match="changed immutable content"):
            record(conn, decision, "attempted", detail={"occurrence": "different"})
        assert conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()
    assert phases(path) == before


def test_ambiguous_primary_still_blocks_compensation_in_caller_transaction(notification_db):
    path, decision = notification_db
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        record(conn, decision, "scheduled")
        assert record(conn, decision, "attempted").claimed is True
        record(conn, decision, "failed", error="delivery_ambiguous")
        compensation = "2026-08-25T14:40+08:00"
        record(conn, decision, "scheduled", window=compensation)
        result = record(conn, decision, "attempted", window=compensation)
        assert result.claimed is False and result.duplicate is True
        assert conn.execute("SELECT COUNT(*) FROM notification_events WHERE status='attempted'").fetchone()[0] == 1
        conn.rollback()
    finally:
        conn.close()


@pytest.mark.parametrize("invalid", ["empty", "duplicate", "event_model"])
def test_public_invalid_input_still_fails_before_connection(notification_db, monkeypatch, invalid):
    _, decision = notification_db

    def forbidden(*_args, **_kwargs):
        pytest.fail("invalid public notification input must not open storage")

    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "transaction", forbidden)
    with pytest.raises(ValueError):
        v8_repo.record_notification_events_batch(
            decision_ids=[] if invalid == "empty" else [decision.decision_id] * (2 if invalid == "duplicate" else 1),
            scheduled_window=WINDOW, status="scheduled", attempt_no=1 if invalid == "event_model" else 0,
            natural_schedule=True, occurred_at=T1,
        )
