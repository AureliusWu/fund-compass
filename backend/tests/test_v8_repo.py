from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier, Event, Lock

import pytest

from models.v8 import EvidenceSnapshot
from service import v8_repo
from strategy.decision_v2 import (
    build_decision_snapshot,
    build_evidence_snapshot,
    build_holding_version,
    build_portfolio_policy,
)


T0 = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)
T1 = datetime(2026, 8, 25, 7, 30, tzinfo=timezone.utc)


@pytest.fixture
def v8_db(tmp_path, monkeypatch):
    from database import db

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "v8.db"))
    db.init_db()
    return db


def evidence(*, valuation=20, score=82, created_at=T0, target_nav_date=None):
    detail = {
        "code": "510300", "name": "测试基金", "type": "指数型",
        "latest_nav": 1.0, "latest_nav_date": "2026-08-22",
        "source": "test", "updated_at": "2026-08-25T06:00:00+00:00",
        "decision_context": {
            "status": "fresh", "source": "test_quote",
            "source_time": "2026-08-25T14:29:00+08:00", "source_time_precision": "datetime",
            "base_nav": 1.0, "base_nav_date": "2026-08-22",
            "estimate_change": 1.0, "target_nav_date": target_nav_date,
        },
    }
    return build_evidence_snapshot(
        detail,
        {
            "score": score, "score_version": "score-v1", "coverage": 1.0,
            "components": {"risk": {"detail": {"max_drawdown": -10, "volatility": 15}}},
        },
        {
            "signal": "买入" if valuation <= 35 else "持有",
            "signal_version": "signal-v1", "coverage": 1.0,
            "layers": {
                "valuation": {"label": "低估" if valuation <= 35 else "高估", "percentile": valuation, "source": "index_pe_pb"},
                "trend": {"label": "上升趋势"}, "sentiment": {"label": "中性"},
            },
        },
        {"available": True},
        created_at=created_at,
    )


def concurrent_saves(monkeypatch, *, table, save):
    """Widen the read-before-insert window without swallowing either result."""
    original_existing_model = v8_repo._existing_model
    start = Barrier(2)
    both_read_missing = Event()
    readers_lock = Lock()
    missing_readers = 0

    def delayed_existing_model(conn, candidate_table, id_column, identifier, model_type):
        nonlocal missing_readers
        result = original_existing_model(
            conn, candidate_table, id_column, identifier, model_type,
        )
        if candidate_table == table and result is None:
            with readers_lock:
                missing_readers += 1
                if missing_readers == 2:
                    both_read_missing.set()
            # With BEGIN IMMEDIATE the second writer waits before this read, so
            # only the first caller reaches this bounded wait. With deferred
            # BEGIN both callers read the gap and deterministically expose the
            # lock-upgrade race.
            both_read_missing.wait(timeout=2)
        return result

    monkeypatch.setattr(v8_repo, "_existing_model", delayed_existing_model)

    def worker():
        start.wait(timeout=5)
        return save()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(worker) for _ in range(2)]
        return [future.result(timeout=10) for future in futures]


def persist_decision(*, snapshot=None, held=False, current=None, target=None, created_at=T0):
    snapshot = v8_repo.save_evidence(snapshot or evidence(created_at=created_at))
    policy = v8_repo.ensure_default_policy(created_at)
    holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=held, current_weight=current, target_weight=target,
        source="test", created_at=created_at,
    ))
    decision = v8_repo.save_decision(build_decision_snapshot(
        snapshot, holding, policy, created_at=created_at,
    ))
    return snapshot, holding, policy, decision


def test_snapshot_save_is_idempotent_and_returns_first_created_time(v8_db):
    first = v8_repo.save_evidence(evidence(created_at=T0))
    second = v8_repo.save_evidence(evidence(created_at=T1))

    assert first.evidence_id == second.evidence_id
    assert second.created_at == T0
    conn = v8_db.get_conn()
    try:
        assert conn.execute("SELECT COUNT(*) FROM evidence_snapshots").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM source_health_events").fetchone()[0] == 2
    finally:
        conn.close()


def test_snapshot_id_payload_conflict_fails_closed(v8_db):
    original = evidence()
    v8_repo.save_evidence(original)
    forged = EvidenceSnapshot.model_validate({
        **original.model_dump(mode="python"),
        "score": 1.0,
    })

    with pytest.raises(v8_repo.SnapshotConflictError, match="deterministic id"):
        v8_repo.save_evidence(forged)


def test_holding_idempotent_save_serializes_concurrent_claims(v8_db, monkeypatch):
    holding = build_holding_version(
        "510300", is_held=True, current_weight=15, target_weight=20,
        source="concurrency-test", created_at=T0,
    )

    results = concurrent_saves(
        monkeypatch,
        table="holding_versions",
        save=lambda: v8_repo.save_holding(holding),
    )

    assert [result.holding_version for result in results] == [
        holding.holding_version,
        holding.holding_version,
    ]
    with v8_db.get_conn() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM holding_versions WHERE holding_version=?",
            (holding.holding_version,),
        ).fetchone()[0] == 1


def test_decision_idempotent_save_serializes_concurrent_claims(v8_db, monkeypatch):
    snapshot = v8_repo.save_evidence(evidence())
    policy = v8_repo.ensure_default_policy(T0)
    holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=False, current_weight=None, target_weight=None,
        source="concurrency-test", created_at=T0,
    ))
    decision = build_decision_snapshot(snapshot, holding, policy, created_at=T0)

    results = concurrent_saves(
        monkeypatch,
        table="decision_snapshots",
        save=lambda: v8_repo.save_decision(decision),
    )

    assert [result.decision_id for result in results] == [
        decision.decision_id,
        decision.decision_id,
    ]
    with v8_db.get_conn() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM decision_snapshots WHERE decision_id=?",
            (decision.decision_id,),
        ).fetchone()[0] == 1


def test_decision_diff_uses_persisted_structured_snapshots(v8_db):
    _, _, _, first = persist_decision(held=False, created_at=T0)
    second_evidence = evidence(valuation=60, score=70, created_at=T1)
    _, _, _, second = persist_decision(
        snapshot=second_evidence, held=True, current=15, target=15, created_at=T1,
    )

    diff = v8_repo.diff_for_decision(second)

    assert first.action == "buy"
    assert second.action == "hold"
    assert diff.previous_decision_id == first.decision_id
    assert diff.changed is True
    assert "ACTION_CHANGED" in diff.driver_codes
    assert "CURRENT_WEIGHT_CHANGED" in diff.driver_codes
    assert any("估值分位" in driver for driver in diff.drivers)


def test_policy_content_is_versioned_without_overwriting_history(v8_db):
    default = v8_repo.ensure_default_policy(T0)
    custom = build_portfolio_policy(
        name="我的目标",
        target_allocations={"510300": 20},
        target_ranges={"510300": (15, 25)},
        max_single_fund_weight=30,
        rebalance_band=3,
        effective_at=T1,
        source="test",
        supersedes=default.policy_version,
        created_at=T1,
    )
    saved = v8_repo.save_policy(custom)

    assert saved.policy_version != default.policy_version
    assert v8_repo.get_policy(saved.policy_version).target_allocations == {"510300": 20.0}
    assert [row.policy_version for row in v8_repo.policy_history()] == [saved.policy_version, default.policy_version]


def test_v2_idempotency_returns_original_response_and_rejects_key_reuse(v8_db):
    request = {"items": [{"code": "510300", "holding": {"is_held": False}}]}

    assert v8_repo.claim_idempotency("req-1", "v2", request)["state"] == "claimed"
    v8_repo.complete_idempotency("req-1", "v2", {"decision_id": "original"})
    replay = v8_repo.claim_idempotency("req-1", "v2", request)
    conflict = v8_repo.claim_idempotency("req-1", "v2", {"items": []})

    assert replay == {"state": "complete", "response": {"decision_id": "original"}}
    assert conflict == {"state": "conflict"}


def test_notification_event_ids_are_window_scoped_and_append_only(v8_db):
    _, _, _, decision = persist_decision()
    v8_repo.record_notification_event(
        decision_id=decision.decision_id,
        scheduled_window="2026-08-25T14:30+08:00",
        status="scheduled",
        attempt_no=0,
        natural_schedule=True,
        occurred_at=T0,
    )
    primary = v8_repo.record_notification_event(
        decision_id=decision.decision_id,
        scheduled_window="2026-08-25T14:30+08:00",
        status="attempted",
        attempt_no=1,
        natural_schedule=True,
        occurred_at=T0,
    )
    duplicate = v8_repo.record_notification_event(
        decision_id=decision.decision_id,
        scheduled_window="2026-08-25T14:30+08:00",
        status="attempted",
        attempt_no=1,
        natural_schedule=True,
        occurred_at=T1,
    )
    sent = v8_repo.record_notification_event(
        decision_id=decision.decision_id,
        scheduled_window="2026-08-25T14:30+08:00",
        status="sent",
        attempt_no=1,
        natural_schedule=True,
        occurred_at=T1,
    )
    manual = v8_repo.record_notification_events_batch(
        decision_ids=[decision.decision_id],
        scheduled_window="2026-08-25T14:30+08:00",
        status="attempted", attempt_no=1, natural_schedule=False, occurred_at=T1,
    )[0]
    compensation_id = v8_repo.notification_event_id(
        decision.decision_id, "2026-08-25T14:40+08:00",
    )
    v8_repo.record_notification_event(
        decision_id=decision.decision_id,
        scheduled_window="2026-08-25T14:40+08:00",
        status="scheduled", attempt_no=0, natural_schedule=True, occurred_at=T1,
    )
    compensation_claim = v8_repo.record_notification_events_batch(
        decision_ids=[decision.decision_id],
        scheduled_window="2026-08-25T14:40+08:00",
        status="attempted", attempt_no=1, natural_schedule=True, occurred_at=T1,
    )[0]

    assert duplicate.occurred_at == T0
    assert manual.claimed is False
    assert manual.duplicate is True
    assert primary.notification_event_id == sent.notification_event_id
    assert primary.notification_event_id != compensation_id
    assert compensation_claim.claimed is False
    assert compensation_claim.duplicate is True
    assert v8_repo.notification_was_sent(decision.decision_id) is True
    rows = v8_repo.notification_events(decision.decision_id)
    assert sum(row.status == "attempted" for row in rows) == 1
    assert sum(row.status == "sent" for row in rows) == 1


def test_manual_notification_claim_cannot_block_the_natural_schedule(v8_db):
    _, _, _, decision = persist_decision()
    common = {
        "decision_id": decision.decision_id,
        "scheduled_window": "2026-08-25T14:30+08:00",
    }
    v8_repo.record_notification_event(
        **common, status="scheduled", attempt_no=0,
        natural_schedule=False, occurred_at=T0,
    )
    manual = v8_repo.record_notification_events_batch(
        decision_ids=[decision.decision_id],
        scheduled_window=common["scheduled_window"],
        status="attempted", attempt_no=1,
        natural_schedule=False, occurred_at=T0,
    )[0]
    v8_repo.record_notification_event(
        **common, status="scheduled", attempt_no=0,
        natural_schedule=True, occurred_at=T1,
    )
    natural = v8_repo.record_notification_events_batch(
        decision_ids=[decision.decision_id],
        scheduled_window=common["scheduled_window"],
        status="attempted", attempt_no=1,
        natural_schedule=True, occurred_at=T1,
    )[0]

    assert manual.claimed is True
    assert natural.claimed is True
    rows = v8_repo.notification_events(decision.decision_id)
    assert sum(row.status == "attempted" and not row.natural_schedule for row in rows) == 1
    assert sum(row.status == "attempted" and row.natural_schedule for row in rows) == 1


def test_ambiguous_primary_delivery_blocks_automatic_compensation(v8_db):
    _, _, _, decision = persist_decision()
    primary = "2026-08-25T14:30+08:00"
    compensation = "2026-08-25T14:40+08:00"
    for status, attempt_no, error_class in (
        ("scheduled", 0, None),
        ("attempted", 1, None),
        ("failed", 1, "delivery_ambiguous"),
    ):
        v8_repo.record_notification_event(
            decision_id=decision.decision_id,
            scheduled_window=primary,
            status=status,
            attempt_no=attempt_no,
            natural_schedule=True,
            occurred_at=T0,
            error_class=error_class,
        )
    v8_repo.record_notification_event(
        decision_id=decision.decision_id,
        scheduled_window=compensation,
        status="scheduled",
        attempt_no=0,
        natural_schedule=True,
        occurred_at=T1,
    )

    claim = v8_repo.record_notification_events_batch(
        decision_ids=[decision.decision_id],
        scheduled_window=compensation,
        status="attempted",
        attempt_no=1,
        natural_schedule=True,
        occurred_at=T1,
    )[0]

    assert claim.claimed is False
    assert claim.duplicate is True
