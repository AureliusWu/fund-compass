"""Actual local source/run/claim journal transactions, never real delivery."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from types import SimpleNamespace

import pytest

from database import db
from database.owner_analysis_schema import provision_owner_analysis_candidate
from database.owner_machine_schema import provision_owner_machine_candidate
from database.owner_sync_schema import provision_owner_sync_candidate
from models.owner_machine import MachineClaim, MachineFinish, MachinePrepare, parse_machine_input
from models.v8 import stable_id
from service import owner_analysis_repo as analysis, owner_machine_repo as machine, owner_sync_repo as sync, v8_repo
from strategy.decision_v2 import build_portfolio_policy
from test_owner_analysis_repo import connect, evidence

DAY = "2026-10-26"
NOW = datetime(2026, 10, 26, 6, 31, tzinfo=timezone.utc)
SHA = "d" * 40


@pytest.fixture
def f(tmp_path, monkeypatch):
    path = tmp_path / "machine.sqlite3"
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW)
    db.init_db()
    with connect(path) as conn:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
        provision_owner_analysis_candidate(conn, synthetic_candidate=True)
        provision_owner_machine_candidate(conn, synthetic_candidate=True)
    at = NOW - timedelta(minutes=1)
    policy = v8_repo.save_policy(build_portfolio_policy(name="合成机器策略", effective_at=at,
        source="machine-fixture", created_at=at))
    proofs = {}
    for code in ("000001", "000009", "510300"):
        proof = evidence(code, at).model_copy(update={"market_time": at, "estimate": 1.0,
            "estimate_status": "fresh", "missing_fields": [], "stale_fields": []})
        proof = proof.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(proof))})
        proofs[code] = v8_repo.save_evidence(proof)
    operations = [
        {"key": "510300::A", "kind": "holding", "deleted": False,
         "changes": {"name": "合成A", "shares": 10, "cost": 1.0, "target_weight": 20}},
        {"key": "510300::B", "kind": "holding", "deleted": False,
         "changes": {"name": "合成B", "shares": 20, "cost": None, "target_weight": 40}},
        {"key": "000001::零份", "kind": "holding", "deleted": False,
         "changes": {"name": "合成零份", "shares": 0, "cost": None, "target_weight": 40}},
        {"key": "000009::关注", "kind": "watch", "deleted": False, "changes": {"name": "合成关注"}},
        {"key": "asset:cash", "kind": "manual_asset", "deleted": False,
         "changes": {"name": "合成现金", "cls": "现金", "value": 1000, "note": None}},
    ]
    with connect(path) as conn:
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-seed-0001", "expected_revision": 0,
                                                        "operations": operations}, ensure_ascii=False))
        assert result.status == 200
        source = machine.read_source_local(conn)
    request = {"occurrence_date": DAY, "request_id": "machine-invocation-0001", "trigger": "scheduled",
        "slot": "14:30", "worker_build_sha": SHA, "expected_revision": source["revision"],
        "source_hash": source["source_hash"], "policy_version": policy.policy_version,
        "evidence": [{"code": code, "evidence_id": proof.evidence_id} for code, proof in sorted(proofs.items())]}
    return SimpleNamespace(path=path, request=request, source=source, proofs=proofs, policy=policy)


def call(f, function, request=None, *, factory=sqlite3.Connection):
    conn = connect(f.path, factory=factory)
    try:
        return function(conn, request) if request is not None else function(conn)
    finally:
        conn.close()


def prepare(f, **updates):
    return call(f, machine.prepare_local, parse_machine_input(json.dumps({**f.request, **updates}), MachinePrepare))


def claim_request(task, **updates):
    return MachineClaim(occurrence_date=DAY, request_id="machine-claim-0001", trigger="scheduled", slot="14:30",
                        worker_build_sha=SHA, task_hash=task["task_hash"], **updates)


def finish(f, attempt, outcome):
    return call(f, machine.finish_local, MachineFinish(occurrence_date=DAY, slot=attempt["attempt"]["slot"],
                                                     attempt_hash=attempt["attempt_hash"], outcome=outcome))


def counts(f):
    """Business/claim image; invocation observations are checked separately."""
    with connect(f.path) as conn:
        result = {table: conn.execute(f"SELECT COUNT(*) FROM {table}" +
                (" WHERE kind<>'observation'" if table == "owner_machine_journal" else "")).fetchone()[0] for table in
                ("owner_analysis_runs", "owner_analysis_components", "owner_machine_journal", "notification_events",
                 "holding_versions", "decision_snapshots")}
        return result


def test_complete_actual_source_to_run_claim_terminal_preserves_zero_and_accounts(f):
    assert f.source["codes"] == ["000001", "000009", "510300"] and f.source["record_count"] == 5
    task = prepare(f)
    assert task["duplicate"] is False and task["source_current"] is True
    by_code = {row["code"]: row for row in task["run"]["components"]}
    assert by_code["510300"]["holding"]["shares"] == 30
    assert by_code["510300"]["holding"]["target_weight"] == 60
    assert by_code["510300"]["holding"]["cost"] is None
    assert by_code["000001"]["holding"]["shares"] == 0 and by_code["000001"]["holding"]["user_state"] == "held"
    before = counts(f)
    assert prepare(f)["task"] == task["task"] and counts(f) == before
    attempt = call(f, machine.claim_local, claim_request(task))
    assert attempt["claimed"] and attempt["attempt"]["valid_count"] == 3
    assert not call(f, machine.claim_local, claim_request(task))["claimed"]
    result = finish(f, attempt, "sent")
    assert result["result"]["execution_status"] == "succeeded"
    assert finish(f, attempt, "sent")["duplicate"]
    with connect(f.path) as conn:
        rows = conn.execute("SELECT status,COUNT(*) FROM notification_events GROUP BY status").fetchall()
        assert dict(rows) == {"attempted": 3, "scheduled": 3, "sent": 3}
        assert conn.execute("SELECT COUNT(*) FROM owner_analysis_runs").fetchone()[0] == 1


def test_manual_and_natural_actual_concurrent_claims_use_one_original_run(f):
    task = prepare(f)
    def send_claim(trigger):
        req = claim_request(task).model_copy(update={"trigger": trigger, "request_id": "machine-claim-" + trigger})
        return call(f, machine.claim_local, req)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(send_claim, ("manual", "scheduled")))
    assert sorted(row["claimed"] for row in results) == [False, True]
    winner = next(row for row in results if row["claimed"])
    with connect(f.path) as conn:
        assert {row[0] for row in conn.execute("SELECT natural_schedule FROM notification_events")} == {
            int(winner["attempt"]["trigger"] == "scheduled")}
    assert len({row["attempt_hash"] for row in results}) == 1
    assert counts(f)["owner_analysis_runs"] == 1


@pytest.mark.parametrize("outcome", ["sent", "delivery_ambiguous"])
def test_terminal_or_ambiguous_never_compensates_even_with_other_trigger(f, monkeypatch, outcome):
    task = prepare(f)
    attempt = call(f, machine.claim_local, claim_request(task).model_copy(update={"trigger": "manual"}))
    finish(f, attempt, outcome)
    before = counts(f)
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW.replace(minute=41))
    duplicate = call(f, machine.claim_local, claim_request(task).model_copy(update={"slot": "14:40", "request_id": "machine-compensation-0001"}))
    assert not duplicate["claimed"] and duplicate["attempt_hash"] == attempt["attempt_hash"]
    assert counts(f) == before


@pytest.mark.parametrize("outcome", ["delivery_rejected", "pre_delivery_failed"])
def test_only_definite_safe_failure_allows_original_batch_at_compensation(f, monkeypatch, outcome):
    task = prepare(f)
    first = call(f, machine.claim_local, claim_request(task).model_copy(update={"trigger": "manual"}))
    finish(f, first, outcome)
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW.replace(minute=41))
    second = call(f, machine.claim_local, claim_request(task).model_copy(update={"slot": "14:40", "request_id": "machine-compensation-0001"}))
    assert second["claimed"] and second["attempt"]["attempt_no"] == 2
    assert second["attempt"]["decision_ids"] == first["attempt"]["decision_ids"]
    finish(f, second, "sent")
    assert counts(f)["owner_analysis_runs"] == 1


def test_source_changes_do_not_rebuild_same_occurrence_or_permit_claim(f):
    task = prepare(f)
    with connect(f.path) as conn:
        updated = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-source-change", "expected_revision": 1,
            "operations": [{"key": "510300::A", "kind": "holding", "deleted": False,
                            "changes": {"shares": 11}, "base_values": {"shares": 10}}]}))
        assert updated.status == 200
    before = counts(f)
    old = prepare(f, expected_revision=2, request_id="machine-new-invocation-0001")
    assert old["task"] == task["task"] and not old["source_current"] and counts(f) == before
    with pytest.raises(machine.MachineFault, match="machine_source_conflict"):
        call(f, machine.claim_local, claim_request(task))
    assert counts(f) == before


def test_policy_activation_blocks_original_task_without_replanning(f, monkeypatch):
    task = prepare(f)
    stamp = NOW + timedelta(seconds=30)
    v8_repo.save_policy(build_portfolio_policy(name="合成后继策略", effective_at=stamp, created_at=stamp,
        supersedes=f.policy.policy_version, source="machine-fixture"))
    monkeypatch.setattr(analysis, "_clock", lambda value=None: value or NOW + timedelta(minutes=1))
    before = counts(f)
    with pytest.raises(machine.MachineFault, match="machine_policy_changed"):
        call(f, machine.claim_local, claim_request(task))
    assert prepare(f)["task"] == task["task"] and counts(f) == before


def test_task_journal_fault_rolls_back_real_analysis_business_and_source_mapping(f):
    before = counts(f)
    class Fault(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            result = super().execute(sql, parameters)
            if sql.startswith("INSERT INTO owner_machine_journal"):
                raise sqlite3.OperationalError("fault after actual task INSERT")
            return result
    request = parse_machine_input(json.dumps(f.request), MachinePrepare)
    with pytest.raises(sqlite3.OperationalError, match="actual task"):
        call(f, machine.prepare_local, request, factory=Fault)
    assert counts(f) == before


def test_claim_commit_lost_response_is_read_only_unknown_and_cannot_send_twice(f):
    task = prepare(f)
    class Lost(sqlite3.Connection):
        def commit(self):
            super().commit()
            raise sqlite3.OperationalError("lost after actual COMMIT")
    with pytest.raises(sqlite3.OperationalError, match="actual COMMIT"):
        call(f, machine.claim_local, claim_request(task), factory=Lost)
    before = counts(f)
    duplicate = call(f, machine.claim_local, claim_request(task))
    assert not duplicate["claimed"] and duplicate["result"] is None
    status = call(f, lambda conn: machine.read_status_local(conn, DAY))
    assert len(status["attempts"]) == 1 and status["attempts"][0]["result"] is None
    assert counts(f) == before


@pytest.mark.parametrize("minute", [29, 50, 59])
def test_outside_window_cannot_be_relabelled_primary(f, monkeypatch, minute):
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: stamp or NOW.replace(minute=minute))
    with pytest.raises(machine.MachineFault, match="machine_outside_delivery_window"):
        prepare(f)
    assert counts(f)["owner_analysis_runs"] == 0


@pytest.mark.parametrize("changes", [{"estimate": None}, {"estimate_status": "bogus"},
                                     {"estimate_status": "latest_official"}, {"stale_fields": ["estimate"]}])
def test_null_unknown_official_or_stale_evidence_never_unlocks_fresh_send(f, changes):
    references = []
    for code, original in f.proofs.items():
        proof = original.model_copy(update=changes)
        proof = proof.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(proof))})
        proof = v8_repo.save_evidence(proof)
        references.append({"code": code, "evidence_id": proof.evidence_id})
    task = prepare(f, evidence=references)
    with pytest.raises(machine.MachineFault, match="machine_no_current_intraday"):
        call(f, machine.claim_local, claim_request(task))
    assert counts(f)["notification_events"] == 0


def test_natural_block_and_later_manual_read_are_separate_immutable_observations(f):
    task = prepare(f)
    with connect(f.path) as conn:
        sync.apply_sync_local(conn, json.dumps({"request_id": "machine-observation-update", "expected_revision": 1,
            "operations": [{"key": "510300::A", "kind": "holding", "deleted": False,
                            "changes": {"shares": 11}, "base_values": {"shares": 10}}]}))
    with pytest.raises(machine.MachineFault, match="machine_source_conflict"):
        call(f, machine.claim_local, claim_request(task))
    prepare(f, request_id="machine-manual-inspection", trigger="manual")
    status = call(f, lambda conn: machine.read_status_local(conn, DAY))
    observations = [row["observation"] for row in status["observations"]]
    assert len(observations) == 3
    blocked = next(row for row in observations if row["phase"] == "claim")
    assert blocked["trigger"] == "scheduled" and blocked["execution_status"] == "blocked"
    assert blocked["reason"] == "machine_source_conflict" and blocked["valid_count"] is None
    assert any(row["trigger"] == "manual" and row["execution_status"] == "skipped" for row in observations)
