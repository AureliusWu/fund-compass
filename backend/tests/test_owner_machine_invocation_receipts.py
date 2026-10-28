"""A persisted invocation outcome is replayed, never executed a second time."""
from contextlib import closing
import json
import sqlite3

import pytest

from service import owner_analysis_repo as analysis, owner_machine_repo as machine
from test_owner_analysis_repo import connect
from test_owner_machine_repo import DAY, NOW, call, claim_request, counts, f, prepare


def observations(fixture):
    with closing(connect(fixture.path)) as conn:
        return [json.loads(row[0]) for row in conn.execute(
            "SELECT payload_json FROM owner_machine_journal WHERE kind='observation' ORDER BY record_id")]


def task_rows(fixture):
    with closing(connect(fixture.path)) as conn:
        return [tuple(row) for row in conn.execute(
            "SELECT * FROM owner_machine_journal WHERE kind IN ('task','attempt','result') ORDER BY kind,record_id")]


def mutate_journal(fixture, operation, *, trigger="delete"):
    """Raw corruption fixture restores the exact immutable trigger contract."""
    with closing(connect(fixture.path)) as conn:
        name = "immutable_owner_machine_journal_" + trigger
        assert trigger in {"delete", "update"}
        ddl = conn.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", (name,)).fetchone()[0]
        conn.execute("DROP TRIGGER " + name)
        operation(conn)
        conn.execute(ddl)
        conn.commit()


def test_previously_blocked_prepare_same_id_cannot_execute_when_window_later_opens(f, monkeypatch):
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW.replace(minute=29))
    with pytest.raises(machine.MachineFault, match="machine_outside_delivery_window"):
        prepare(f)
    before, original = counts(f), observations(f)
    assert len(original) == 1 and original[0]["execution_status"] == "blocked"
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW)
    with pytest.raises(machine.MachineFault, match="machine_outside_delivery_window"):
        prepare(f)
    assert counts(f) == before and observations(f) == original
    # A new actual invocation is separate evidence, not a rewritten old result.
    new = prepare(f, request_id="machine-later-prepare-0001")
    assert new["duplicate"] is False
    assert counts(f)["owner_analysis_runs"] == 1
    assert sorted(row["execution_status"] for row in observations(f)) == ["blocked", "succeeded"]


def test_previously_blocked_claim_same_id_stays_blocked_after_compensation_opens(f, monkeypatch):
    task = prepare(f)
    request = claim_request(task).model_copy(update={"slot": "14:40"})
    with pytest.raises(machine.MachineFault, match="machine_outside_delivery_window"):
        call(f, machine.claim_local, request)
    before, original = counts(f), observations(f)
    assert before["notification_events"] == 0
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW.replace(minute=41))
    with pytest.raises(machine.MachineFault, match="machine_outside_delivery_window"):
        call(f, machine.claim_local, request)
    assert counts(f) == before and observations(f) == original
    new = call(f, machine.claim_local, request.model_copy(update={"request_id": "machine-later-claim-0001"}))
    assert new["claimed"] is True and new["attempt"]["slot"] == "14:40"
    assert counts(f)["notification_events"] == 6


def test_positive_prepare_original_invocation_has_read_only_original_receipt(f):
    first = prepare(f)
    before, rows, original = counts(f), task_rows(f), observations(f)
    repeated = prepare(f)
    assert repeated["duplicate"] is True
    assert repeated["task"] == first["task"] and repeated["task_hash"] == first["task_hash"]
    assert counts(f) == before and task_rows(f) == rows and observations(f) == original


def test_positive_claim_replay_returns_no_transport_permission(f):
    task = prepare(f)
    request = claim_request(task)
    first = call(f, machine.claim_local, request)
    before, rows, original = counts(f), task_rows(f), observations(f)
    repeated = call(f, machine.claim_local, request)
    assert repeated["claimed"] is False and repeated["duplicate"] is True
    assert repeated["attempt"] == first["attempt"] and repeated["attempt_hash"] == first["attempt_hash"]
    assert counts(f) == before and task_rows(f) == rows and observations(f) == original


def test_positive_prepare_receipt_does_not_recreate_missing_original_task(f):
    prepare(f)
    mutate_journal(f, lambda conn: conn.execute("DELETE FROM owner_machine_journal WHERE kind='task'"))
    before, original = counts(f), observations(f)
    with pytest.raises(machine.MachineFault):
        prepare(f)
    assert counts(f) == before and observations(f) == original
    assert task_rows(f) == []


def test_positive_claim_receipt_does_not_recreate_missing_attempt_mapping(f, monkeypatch):
    task = prepare(f)
    request = claim_request(task)
    call(f, machine.claim_local, request)
    mutate_journal(f, lambda conn: conn.execute("DELETE FROM owner_machine_journal WHERE kind='attempt'"))
    before, original = counts(f), observations(f)
    def no_new_phase(*_args, **_kwargs):
        pytest.fail("A persisted invocation cannot reconstruct a missing original claim")
    monkeypatch.setattr(machine.v8_repo, "_record_notification_events_in_transaction", no_new_phase)
    with pytest.raises(machine.MachineFault):
        call(f, machine.claim_local, request)
    assert counts(f) == before and observations(f) == original


def test_positive_prepare_receipt_rejects_self_consistent_but_changed_task_output(f):
    prepare(f)
    def change(conn):
        row = conn.execute("SELECT payload_json FROM owner_machine_journal WHERE kind='task'").fetchone()
        task = json.loads(row[0])
        task["worker_build_sha"] = "e" * 40
        raw = analysis._json(task)
        conn.execute("UPDATE owner_machine_journal SET payload_json=?,payload_hash=? WHERE kind='task'",
                     (raw, analysis._sha(raw)))
    mutate_journal(f, change, trigger="update")
    before, rows, original = counts(f), task_rows(f), observations(f)
    with pytest.raises(machine.MachineFault):
        prepare(f)
    assert counts(f) == before and task_rows(f) == rows and observations(f) == original


@pytest.mark.parametrize("phase", ["prepare", "claim"])
def test_unknown_commit_keeps_original_invocation_and_never_grants_repeat_send(f, phase):
    task = prepare(f) if phase == "claim" else None
    class Lost(sqlite3.Connection):
        def commit(self):
            super().commit()
            raise sqlite3.OperationalError("synthetic original invocation response lost")
    if phase == "prepare":
        from models.owner_machine import MachinePrepare, parse_machine_input
        request = parse_machine_input(json.dumps(f.request), MachinePrepare)
        function = machine.prepare_local
    else:
        request, function = claim_request(task), machine.claim_local
    with pytest.raises(sqlite3.OperationalError, match="response lost"):
        call(f, function, request, factory=Lost)
    before, rows, original = counts(f), task_rows(f), observations(f)
    repeated = call(f, function, request)
    assert repeated["duplicate"] is True
    if phase == "claim":
        assert repeated["claimed"] is False
    assert counts(f) == before and task_rows(f) == rows and observations(f) == original
