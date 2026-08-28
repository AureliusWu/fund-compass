from datetime import datetime, timedelta, timezone

import pytest

from service import v8_repo
from strategy.decision_v2 import (
    build_decision_snapshot,
    build_evidence_snapshot,
    build_holding_version,
)


T0 = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)


@pytest.fixture
def outcome_db(tmp_path, monkeypatch):
    from database import db

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "outcomes-v8.db"))
    db.init_db()
    return db


def persist(target_nav_date=None):
    detail = {
        "code": "510300", "name": "结果测试", "type": "QDII" if target_nav_date else "指数型",
        "latest_nav": 1.0, "latest_nav_date": "2026-08-22",
        "source": "test", "updated_at": "2026-08-25T06:00:00+00:00",
        "decision_context": {
            "status": "fresh", "kind": "estimate", "source": "quote",
            "source_time": "2026-08-25T14:29:00+08:00", "source_time_precision": "datetime",
            "base_nav": 1.0, "base_nav_date": "2026-08-22",
            "estimate_change": 1.0, "target_nav_date": target_nav_date,
            "sample_count": 30 if target_nav_date else None,
            "error_p80": 0.8 if target_nav_date else None,
        },
    }
    evidence = build_evidence_snapshot(
        detail,
        {
            "score": 80, "score_version": "score-v1", "coverage": 1,
            "components": {"risk": {"detail": {"max_drawdown": -10, "volatility": 12}}},
        },
        {
            "signal": "买入", "signal_version": "signal-v1", "coverage": 1,
            "layers": {
                "valuation": {"label": "低估", "percentile": 20, "source": "index_pe_pb"},
                "trend": {"label": "上升趋势"}, "sentiment": {"label": "中性"},
            },
        },
        {"available": True},
        created_at=T0,
    )
    evidence = v8_repo.save_evidence(evidence)
    holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=False, source="test", created_at=T0,
    ))
    policy = v8_repo.ensure_default_policy(T0)
    decision = v8_repo.save_decision(build_decision_snapshot(
        evidence, holding, policy, created_at=T0,
    ))
    return evidence, decision


def insert_navs(db, rows):
    conn = db.get_conn()
    try:
        conn.executemany(
            "INSERT OR REPLACE INTO nav_history(code,date,nav,ac_return) VALUES('510300',?,?,NULL)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


def test_outcome_is_forward_only_immutable_and_one_per_horizon(outcome_db, monkeypatch):
    _, decision = persist()
    monkeypatch.setattr(
        v8_repo, "_now", lambda: datetime(2026, 9, 1, 6, 30, tzinfo=timezone.utc),
    )
    insert_navs(outcome_db, [("2026-08-23", 0.1), ("2026-08-24", 0.2), ("2026-08-25", 1.0)])
    start = datetime(2026, 8, 26)
    insert_navs(outcome_db, [
        ((start + timedelta(days=index)).date().isoformat(), 1 + (index + 1) / 100)
        for index in range(5)
    ])
    conn = outcome_db.get_conn()
    before = conn.execute(
        "SELECT payload_json FROM decision_snapshots WHERE decision_id=?", (decision.decision_id,),
    ).fetchone()[0]
    conn.close()

    first = v8_repo.settle_outcomes(decision.decision_id)
    second = v8_repo.settle_outcomes(decision.decision_id)

    horizon = next(row for row in first if row.evaluation_kind == "horizon")
    assert horizon.horizon == 5
    assert horizon.base_nav_date.isoformat() == "2026-08-25"
    assert horizon.evaluation_date.isoformat() == "2026-08-30"
    assert horizon.absolute_return == pytest.approx(5.0)
    assert horizon.max_drawdown == 0
    assert horizon.hit is True
    assert [row.outcome_id for row in second] == [row.outcome_id for row in first]
    conn = outcome_db.get_conn()
    try:
        assert conn.execute("SELECT COUNT(*) FROM outcome_evaluations").fetchone()[0] == 1
        after = conn.execute(
            "SELECT payload_json FROM decision_snapshots WHERE decision_id=?", (decision.decision_id,),
        ).fetchone()[0]
        assert after == before
    finally:
        conn.close()


def test_qdii_target_never_uses_the_next_available_nav(outcome_db):
    evidence, decision = persist(target_nav_date="2026-08-25")
    insert_navs(outcome_db, [("2026-08-26", 1.5)])

    pending = v8_repo.settle_outcomes(decision.decision_id)

    assert not any(row.evaluation_kind == "qdii_target" for row in pending)
    insert_navs(outcome_db, [("2026-08-25", 1.02)])
    settled = v8_repo.settle_outcomes(decision.decision_id)
    target = next(row for row in settled if row.evaluation_kind == "qdii_target")
    assert target.evaluation_date == evidence.target_nav_date
    assert target.evaluated_nav == pytest.approx(1.02)
    assert target.absolute_return == pytest.approx(2.0)
    assert target.prediction_error == pytest.approx(-1.0)


def test_outcomes_api_reports_mature_and_pending_horizons(outcome_db, monkeypatch):
    _, decision = persist()
    insert_navs(outcome_db, [("2026-08-25", 1.0)])
    insert_navs(outcome_db, [
        (f"2026-09-{day:02d}", 1 + day / 1000)
        for day in range(1, 6)
    ])

    before = len(v8_repo.outcome_rows(decision.decision_id))
    result = v8_repo.outcomes_for_fund("510300")

    assert result["total"] == 1
    assert result["items"][0]["decision"]["decision_id"] == decision.decision_id
    assert result["items"][0]["pending_horizons"] == [5, 20, 60]
    assert len(v8_repo.outcome_rows(decision.decision_id)) == before

    # Persisted future-dated rows cannot mature an outcome before market time.
    v8_repo.settle_outcomes(decision.decision_id)
    result = v8_repo.outcomes_for_fund("510300")
    assert result["items"][0]["pending_horizons"] == [5, 20, 60]

    monkeypatch.setattr(
        v8_repo, "_now", lambda: datetime(2026, 9, 6, 6, 30, tzinfo=timezone.utc),
    )
    v8_repo.settle_outcomes(decision.decision_id)
    result = v8_repo.outcomes_for_fund("510300")
    assert result["items"][0]["pending_horizons"] == [20, 60]
