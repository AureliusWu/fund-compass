"""Real SQLite cross-entry notification ownership, without any real sender."""
import json

import pytest

from service import owner_analysis_repo as analysis, owner_machine_repo as machine, v8_repo
from test_owner_analysis_repo import connect
from test_owner_machine_repo import DAY, NOW, call, claim_request, counts, f, prepare


WINDOW = DAY + "T14:30+08:00"


def _legacy(ids, status, *, natural=False, error=None, window=WINDOW, detail=None):
    return v8_repo.record_notification_events_batch(
        decision_ids=ids, scheduled_window=window, status=status,
        attempt_no=0 if status in {"scheduled", "skipped"} else 1,
        natural_schedule=natural, occurred_at=NOW,
        error_class=error, detail=detail,
    )


def _before_machine_task(f):
    request = {"request_id": "machine-portfolio-" + DAY,
        "expected_revision": f.request["expected_revision"], "policy_version": f.request["policy_version"],
        "evidence": f.request["evidence"]}
    with connect(f.path) as conn:
        result = analysis.create_analysis_local(conn, json.dumps(request))
        assert result.status == 200
        assert conn.execute("SELECT COUNT(*) FROM owner_machine_journal WHERE kind='task'").fetchone()[0] == 0
    return [row["decision"]["decision_id"] for row in result.body["run"]["components"]]


@pytest.mark.parametrize("finish", [None, "delivery_ambiguous", "delivery_rejected"])
@pytest.mark.parametrize("natural", [False, True])
def test_legacy_claim_before_task_binding_blocks_new_entry_on_either_axis(f, finish, natural):
    ids = _before_machine_task(f)
    _legacy(ids, "scheduled", natural=natural)
    assert all(row.claimed for row in _legacy(ids, "attempted", natural=natural))
    if finish is not None:
        _legacy(ids, "failed", natural=natural, error=finish)
    task = prepare(f)
    assert task["task"]["decision_ids"] == ids
    before = counts(f)
    # Even a definite legacy rejection has no common immutable occurrence
    # mapping, so the new entry cannot turn it into a safe machine replay.
    with pytest.raises(machine.MachineFault, match="machine_notification_conflict") as error:
        call(f, machine.claim_local, claim_request(task).model_copy(update={"trigger": "manual" if natural else "scheduled"}))
    assert error.value.status == 409
    assert counts(f) == before


def test_legacy_scheduled_then_attempted_sequence_cannot_acquire_second_send(f):
    task = prepare(f)
    first = call(f, machine.claim_local, claim_request(task).model_copy(update={"trigger": "manual"}))
    assert first["claimed"]
    before = counts(f)
    with pytest.raises(v8_repo.SnapshotConflictError, match="machine"):
        _legacy(task["task"]["decision_ids"], "scheduled", natural=True)
        _legacy(task["task"]["decision_ids"], "attempted", natural=True)
    assert counts(f) == before


@pytest.mark.parametrize("variant", ["partial", "reversed", "wrong_hash", "wrong_occurrence"])
def test_internal_binding_requires_complete_original_order_and_hash(f, variant):
    task = prepare(f)
    ids = task["task"]["decision_ids"]
    binding = (DAY, task["task_hash"])
    if variant == "partial":
        ids = ids[:-1]
    elif variant == "reversed":
        ids = ids[::-1]
    elif variant == "wrong_hash":
        binding = (DAY, "0" * 64)
    else:
        binding = ("2026-10-27", task["task_hash"])
    before = counts(f)
    with connect(f.path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        with pytest.raises(v8_repo.SnapshotConflictError, match="machine"):
            v8_repo._record_notification_events_in_transaction(conn,
                decision_ids=ids, scheduled_window=WINDOW, status="scheduled", attempt_no=0,
                natural_schedule=True, occurred_at=NOW, _machine_binding=binding)
        assert conn.in_transaction
        conn.rollback()
    assert counts(f) == before


def test_unbound_real_owner_analysis_remains_legacy_compatible_until_actual_task_membership(f):
    ids = _before_machine_task(f)
    scheduled = _legacy(ids, "scheduled", natural=False)
    attempted = _legacy(ids, "attempted", natural=False)
    assert all(not row.duplicate for row in scheduled)
    assert all(row.claimed for row in attempted)


@pytest.mark.parametrize("status", ["scheduled", "attempted", "sent", "failed", "compensated", "skipped"])
def test_legacy_entry_cannot_write_any_phase_for_actual_machine_task(f, status):
    task = prepare(f)
    attempt = call(f, machine.claim_local, claim_request(task).model_copy(update={"trigger": "manual"}))
    assert attempt["claimed"]
    before = counts(f)
    with pytest.raises(v8_repo.SnapshotConflictError, match="machine"):
        _legacy(task["task"]["decision_ids"], status, natural=True,
                error="delivery_ambiguous" if status == "failed" else None)
    assert counts(f) == before
