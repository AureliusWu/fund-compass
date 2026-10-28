"""Complete local machine batches and source/date boundaries, not delivery proof."""
from datetime import timedelta
import hashlib
import json
import math
import sqlite3

import pytest
from pydantic import ValidationError

from models.api import V8NotificationEventRequest
from models.owner_analysis import MAX_EVIDENCE
from models.owner_machine import MachinePrepare, parse_machine_input
from models.v8 import stable_id
from service import owner_analysis_repo as analysis, owner_machine_repo as machine, owner_sync_repo as sync, v8_repo
from strategy.decision_v2 import build_portfolio_policy
from test_owner_analysis_repo import change_positions, connect, evidence
from test_owner_machine_repo import DAY, NOW, call, claim_request, counts, f, finish, prepare


def _refresh(f):
    with connect(f.path) as conn:
        source = machine.read_source_local(conn)
    f.source = source
    f.request.update(expected_revision=source["revision"], source_hash=source["source_hash"],
                     evidence=[{"code": code, "evidence_id": proof.evidence_id}
                               for code, proof in sorted(f.proofs.items())])
    return source


def _assert_rejected_observation(f, before, reason):
    # A known business rejection leaves its invocation observation, not business
    # rows or a notification claim. Assert that new state instead of hiding it.
    assert counts(f) == before  # shared counts explicitly exclude observations
    with connect(f.path) as conn:
        raw = conn.execute("SELECT payload_json FROM owner_machine_journal WHERE kind='observation' "
                           "ORDER BY rowid DESC LIMIT 1").fetchone()[0]
    observation = json.loads(raw)
    assert observation["execution_status"] == "blocked"
    assert observation["reason"] == reason
    assert observation["trigger"] == "scheduled"


def _extend(f, count):
    """Add real distinct watch records and real persisted V8 Evidence."""
    additions = [f"{100000 + index:06d}" for index in range(count - len(f.proofs))]
    at = NOW - timedelta(minutes=1)
    for code in additions:
        proof = evidence(code, at).model_copy(update={"market_time": at, "estimate": 1.0,
            "estimate_status": "fresh", "missing_fields": [], "stale_fields": []})
        proof = proof.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(proof))})
        f.proofs[code] = v8_repo.save_evidence(proof)
    with connect(f.path) as conn:
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-capacity-additions",
            "expected_revision": sync._head(conn), "operations": [
                {"key": code + "::容量", "kind": "watch", "deleted": False,
                 "changes": {"name": "合成容量" + code}} for code in additions]}, ensure_ascii=False))
        assert result.status == 200
    return additions


@pytest.mark.parametrize("size", [51, 100])
def test_complete_51_and_100_funds_use_one_real_run_and_unsplit_whole_claim(f, monkeypatch, size):
    _extend(f, size)
    source = _refresh(f)
    assert len(source["codes"]) == size and source["record_count"] == size + 2
    analysis_calls, notification_calls = [], []
    original_analysis = analysis._create_analysis_in_transaction
    original_notification = v8_repo._record_notification_events_in_transaction

    def tracked_analysis(conn, request, check):
        analysis_calls.append((conn, tuple(row.code for row in request.evidence)))
        assert conn.in_transaction
        return original_analysis(conn, request, check)

    def tracked_notification(conn, **kwargs):
        ids = tuple(kwargs["decision_ids"])
        notification_calls.append((conn, kwargs["status"], ids))
        assert conn.in_transaction and len(ids) == size
        return original_notification(conn, **kwargs)

    monkeypatch.setattr(analysis, "_create_analysis_in_transaction", tracked_analysis)
    monkeypatch.setattr(v8_repo, "_record_notification_events_in_transaction", tracked_notification)
    task = prepare(f)
    assert task["source_current"] and len(task["run"]["components"]) == size
    assert task["task"]["decision_ids"] == [row["decision"]["decision_id"] for row in task["run"]["components"]]
    assert len(analysis_calls) == 1 and analysis_calls[0][1] == tuple(source["codes"])
    assert counts(f)["owner_analysis_components"] == size
    attempt = call(f, machine.claim_local, claim_request(task))
    assert attempt["claimed"] and not attempt["duplicate"]
    assert attempt["attempt"]["decision_ids"] == task["task"]["decision_ids"]
    assert attempt["attempt"]["valid_count"] == attempt["attempt"]["expected_count"] == size
    assert [row[1] for row in notification_calls] == ["scheduled", "attempted"]
    assert notification_calls[0][0] is notification_calls[1][0]
    assert notification_calls[0][2] == notification_calls[1][2] == tuple(task["task"]["decision_ids"])
    assert finish(f, attempt, "sent")["result"]["expected_count"] == size
    assert [row[1] for row in notification_calls] == ["scheduled", "attempted", "sent"]
    with connect(f.path) as conn:
        assert dict(conn.execute("SELECT status,COUNT(*) FROM notification_events GROUP BY status")) == {
            "scheduled": size, "attempted": size, "sent": size}
        assert conn.execute("SELECT COUNT(*) FROM owner_analysis_runs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM owner_machine_journal WHERE kind='attempt'").fetchone()[0] == 1
    # This complete internal machine capability does not widen the old wire DTO.
    assert MAX_EVIDENCE == 100
    legacy = {"decision_ids": task["task"]["decision_ids"][:50], "scheduled_window": DAY + "T14:30+08:00",
              "status": "attempted", "attempt_no": 1}
    assert len(V8NotificationEventRequest.model_validate(legacy).decision_ids) == 50
    with pytest.raises(ValidationError):
        V8NotificationEventRequest.model_validate({**legacy, "decision_ids": task["task"]["decision_ids"][:51]})


def test_101_complete_funds_are_explicitly_blocked_not_truncated_to_100(f):
    _extend(f, 101)
    with connect(f.path) as conn:
        source, _raw, digest = analysis._source(conn, lambda: None)
        assert len({row["key"][:6] for row in source["records"]
                    if not row["deleted"] and row["kind"] != "manual_asset"}) == 101
    before = counts(f)
    with pytest.raises(machine.MachineFault, match="machine_capacity_exhausted"):
        call(f, machine.read_source_local)
    references = [{"code": code, "evidence_id": proof.evidence_id} for code, proof in sorted(f.proofs.items())]
    with pytest.raises(ValidationError):
        parse_machine_input(json.dumps({**f.request, "expected_revision": source["revision"],
                                       "source_hash": digest, "evidence": references}), MachinePrepare)
    # Even a caller truncating its request cannot make a complete source partial.
    with pytest.raises(machine.MachineFault, match="machine_capacity_exhausted"):
        prepare(f, expected_revision=source["revision"], source_hash=digest, evidence=references[:100])
    _assert_rejected_observation(f, before, "machine_capacity_exhausted")
    assert before["owner_analysis_runs"] == before["notification_events"] == 0


def test_last_insert_failure_rolls_back_the_entire_51_fund_claim(f):
    _extend(f, 51)
    _refresh(f)
    task = prepare(f)
    before = counts(f)

    class FailLast(sqlite3.Connection):
        inserts = 0

        def execute(self, sql, parameters=()):
            result = super().execute(sql, parameters)
            if sql.lstrip().startswith("INSERT INTO notification_events"):
                self.inserts += 1
                if self.inserts == 102:
                    raise sqlite3.OperationalError("fault after final complete-batch attempt INSERT")
            return result

    with pytest.raises(sqlite3.OperationalError, match="final complete-batch"):
        call(f, machine.claim_local, claim_request(task), factory=FailLast)
    assert counts(f) == before
    with connect(f.path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM owner_machine_journal WHERE kind='observation'").fetchone()[0] == 1
    # A separate invocation can obtain one whole claim after proven rollback;
    # this is a local fault test, not permission to retry an unknown HTTP send.
    attempt = call(f, machine.claim_local, claim_request(task))
    assert attempt["claimed"] and len(attempt["attempt"]["decision_ids"]) == 51


def test_complete_source_hash_preserves_manual_tombstone_int_zero_null_and_negative_zero(f):
    change_positions(f, {"510300::A": {"shares": 0}, "510300::B": {"shares": -0.0},
                         "asset:cash": {"value": -0.0}})
    with connect(f.path) as conn:
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-tombstone-seed", "expected_revision": 2,
            "operations": [{"key": "999999::历史", "kind": "watch", "deleted": False,
                            "changes": {"name": "合成删除历史"}}]}, ensure_ascii=False))
        assert result.status == 200
        prior = sync._record(conn, "999999::历史", 3)
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-tombstone-delete", "expected_revision": 3,
            "operations": [{"key": "999999::历史", "kind": "watch", "deleted": True,
                            "base_values": {"kind": "watch", "deleted": False, **prior["values"]}}]}, ensure_ascii=False))
        assert result.status == 200
    source = _refresh(f)
    assert source["record_count"] == 6 and source["codes"] == ["000001", "000009", "510300"]
    task = prepare(f)
    with connect(f.path) as conn:
        raw, digest = conn.execute("SELECT source_json,source_hash FROM owner_analysis_runs").fetchone()
        current, current_raw, current_hash = analysis._source(conn, lambda: None)
    assert raw == current_raw and digest == current_hash == hashlib.sha256(raw.encode("utf-8")).hexdigest()
    assert digest == source["source_hash"] == task["task"]["source_hash"] == task["run"]["source"]["sha256"]
    rows = {row["key"]: row for row in json.loads(raw)["records"]}
    assert type(rows["510300::A"]["values"]["shares"]) is int
    assert rows["510300::A"]["values"]["shares"] == 0
    assert type(rows["510300::B"]["values"]["shares"]) is float
    assert math.copysign(1, rows["510300::B"]["values"]["shares"]) == -1
    assert math.copysign(1, rows["asset:cash"]["values"]["value"]) == -1
    assert rows["510300::B"]["values"]["cost"] is None and rows["asset:cash"]["values"]["note"] is None
    assert rows["999999::历史"]["deleted"] is True and len(current["records"]) == 6
    assert all(row["code"] != "999999" for row in task["run"]["components"])
    assert call(f, machine.claim_local, claim_request(task))["claimed"]


@pytest.mark.parametrize("kind", ["manual_asset", "tombstone"])
def test_non_fund_or_tombstone_source_change_invalidates_original_task(f, kind):
    task = prepare(f)
    with connect(f.path) as conn:
        if kind == "manual_asset":
            operations = [{"key": "asset:cash", "kind": "manual_asset", "deleted": False,
                           "changes": {"note": "合成新备注"}, "base_values": {"note": None}}]
        else:
            prior = sync._record(conn, "000009::关注", 1)
            operations = [{"key": "000009::关注", "kind": "watch", "deleted": True,
                           "base_values": {"kind": "watch", "deleted": False, **prior["values"]}}]
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-non-finance-source-change",
            "expected_revision": 1, "operations": operations}, ensure_ascii=False))
        assert result.status == 200
    before = counts(f)
    original = prepare(f)
    assert original["task"] == task["task"] and original["source_current"] is False
    with pytest.raises(machine.MachineFault, match="machine_source_conflict"):
        call(f, machine.claim_local, claim_request(task))
    _assert_rejected_observation(f, before, "machine_source_conflict")


def test_all_market_quotes_fresh_but_unknown_shares_remain_partial_and_neutral(f):
    change_positions(f, {"510300::A": {"shares": None}})
    _refresh(f)
    task = prepare(f)
    assert task["run"]["pricing_complete"] is False
    assert task["run"]["unavailable_codes"] == ["510300"]
    assert all(row["decision"]["action"] in {"hold", "watch"} for row in task["run"]["components"])
    assert all(row["holding"]["current_weight"] is None for row in task["run"]["components"])
    attempt = call(f, machine.claim_local, claim_request(task))
    assert attempt["claimed"] and attempt["attempt"]["valid_count"] == attempt["attempt"]["expected_count"] == 3
    assert attempt["attempt"]["artifact_status"] == "partial"
    assert finish(f, attempt, "sent")["result"]["artifact_status"] == "partial"


def test_future_policy_is_not_current_and_does_not_block_original_before_activation(f):
    future = v8_repo.save_policy(build_portfolio_policy(name="合成待生效策略", effective_at=NOW + timedelta(minutes=1),
        created_at=NOW, supersedes=f.policy.policy_version, source="machine-capacity-fixture"))
    assert call(f, machine.read_source_local)["policy_version"] == f.policy.policy_version
    before = counts(f)
    with pytest.raises(machine.MachineFault, match="machine_policy_changed"):
        prepare(f, policy_version=future.policy_version, request_id="machine-future-policy-invocation")
    _assert_rejected_observation(f, before, "machine_policy_changed")
    task = prepare(f)
    assert task["task"]["policy_version"] == f.policy.policy_version
    assert call(f, machine.claim_local, claim_request(task))["claimed"]


def _replace_evidence(f, created, market=None):
    references = []
    for code in sorted(f.proofs):
        proof = evidence(code, created).model_copy(update={"market_time": market or created, "estimate": 1.0,
            "estimate_status": "fresh", "missing_fields": [], "stale_fields": []})
        proof = proof.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(proof))})
        proof = v8_repo.save_evidence(proof)
        references.append({"code": code, "evidence_id": proof.evidence_id})
    return references


@pytest.mark.parametrize("age, allowed", [(timedelta(minutes=90), True),
                                           (timedelta(minutes=90, microseconds=1), False),
                                           (timedelta(days=1), False)])
def test_original_evidence_age_and_day_are_rechecked_without_regenerating_run(f, age, allowed):
    refs = _replace_evidence(f, NOW - age)
    task = prepare(f, evidence=refs)
    before = counts(f)
    if allowed:
        assert call(f, machine.claim_local, claim_request(task))["claimed"]
    else:
        with pytest.raises(machine.MachineFault, match="machine_no_current_intraday"):
            call(f, machine.claim_local, claim_request(task))
        _assert_rejected_observation(f, before, "machine_no_current_intraday")
        assert before["notification_events"] == 0
    assert prepare(f, evidence=refs)["task"] == task["task"] and counts(f)["owner_analysis_runs"] == 1


def test_future_evidence_cannot_create_a_machine_run(f):
    refs = _replace_evidence(f, NOW + timedelta(minutes=1))
    before = counts(f)
    with pytest.raises(analysis._Fault, match="analysis_evidence_unavailable"):
        prepare(f, evidence=refs)
    _assert_rejected_observation(f, before, "analysis_evidence_unavailable")


@pytest.mark.parametrize("day, code", [("2026-10-25", "machine_non_trading_day"),
                                      ("2026-10-01", "machine_non_trading_day"),
                                      ("2027-01-04", "machine_calendar_unsupported"),
                                      ("2026-10-27", "machine_outside_delivery_window")])
def test_non_trading_unsupported_or_wrong_actual_day_never_creates_business_rows(f, day, code):
    before = counts(f)
    with pytest.raises(machine.MachineFault, match=code):
        prepare(f, occurrence_date=day)
    _assert_rejected_observation(f, before, code)
    assert before["owner_analysis_runs"] == 0


def test_compensation_cannot_start_before_its_real_window(f):
    task = prepare(f)
    before = counts(f)
    with pytest.raises(machine.MachineFault, match="machine_outside_delivery_window"):
        call(f, machine.claim_local, claim_request(task).model_copy(update={"slot": "14:40"}))
    _assert_rejected_observation(f, before, "machine_outside_delivery_window")
