import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from models.v8 import PortfolioDecisionSnapshot
from service import v8_decisions, v8_repo
from strategy.decision_v2 import (
    build_decision_snapshot,
    build_evidence_snapshot,
    build_holding_version,
    build_portfolio_policy,
)


T0 = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)
T1 = T0 + timedelta(hours=1)
SETTLED_AT = datetime(2027, 1, 15, 6, 30, tzinfo=timezone.utc)


@pytest.fixture
def portfolio_db(tmp_path, monkeypatch):
    from database import db

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "portfolio-outcomes-v8.db"))
    monkeypatch.setattr(v8_repo, "_now", lambda: SETTLED_AT)
    db.init_db()
    return db


def _evidence(code: str, *, created_at: datetime = T0):
    detail = {
        "code": code,
        "name": f"基金{code}",
        "type": "指数型",
        "latest_nav": 1.0,
        "latest_nav_date": "2026-08-22",
        "source": "test",
        "updated_at": "2026-08-25T06:00:00+00:00",
        "decision_context": {
            "status": "fresh",
            "kind": "estimate",
            "source": "test",
            "source_time": "2026-08-25T14:29:00+08:00",
            "source_time_precision": "datetime",
            "base_nav": 1.0,
            "base_nav_date": "2026-08-22",
            "estimate_change": 1.0,
        },
    }
    return build_evidence_snapshot(
        detail,
        {
            "score": 80,
            "score_version": "score-v1",
            "coverage": 1,
            "components": {
                "risk": {"detail": {"max_drawdown": -10, "volatility": 12}},
            },
        },
        {
            "signal": "买入",
            "signal_version": "signal-v1",
            "coverage": 1,
            "layers": {
                "valuation": {
                    "label": "低估",
                    "percentile": 20,
                    "source": "index_pe_pb",
                },
                "trend": {"label": "上升趋势"},
                "sentiment": {"label": "中性"},
            },
        },
        {"available": True},
        created_at=created_at,
    )


def _portfolio_snapshot():
    policy = v8_repo.ensure_default_policy(T0)
    specs = (
        ("510300", "宽基", 60.0, 50.0),
        ("159915", "成长", 30.0, 40.0),
    )
    request_items = []
    decision_rows = []
    rebalance = []
    decisions = []
    for code, theme, current, target in specs:
        evidence = v8_repo.save_evidence(_evidence(code))
        holding = v8_repo.save_holding(build_holding_version(
            code,
            is_held=True,
            current_weight=current,
            target_weight=target,
            source="test",
            created_at=T0,
        ))
        decision = v8_repo.save_decision(build_decision_snapshot(
            evidence,
            holding,
            policy,
            strategy_version="portfolio-v8-test",
            created_at=T0,
        ))
        decisions.append(decision)
        request_items.append({"code": code, "theme": theme})
        decision_rows.append({
            "code": code,
            "name": evidence.fund_name,
            "action": decision.action,
            "evidence": evidence.model_dump(mode="json"),
            "holding": holding.model_dump(mode="json"),
            "decision": decision.model_dump(mode="json"),
        })
        rebalance.append({
            "code": code,
            "name": evidence.fund_name,
            "action": decision.action,
            "theme": theme,
            "current_weight": current,
            "target_weight": target,
        })
    result = {
        "complete": True,
        "errors": [],
        "decisions": decision_rows,
        "rebalance": rebalance,
        "policy_version": policy.policy_version,
        "strategy_version": "portfolio-v8-test",
    }
    snapshot = v8_repo.build_portfolio_decision_snapshot(request_items, result)
    return v8_repo.save_portfolio_decision(snapshot), request_items, result, decisions


def _insert_navs(db, rows):
    conn = db.get_conn()
    try:
        conn.executemany(
            "INSERT OR REPLACE INTO nav_history(code,date,nav,ac_return) VALUES(?,?,?,NULL)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


def _nav_rows(*, start_offset: int, stop_offset: int):
    base = T0.astimezone(timezone(timedelta(hours=8))).date()
    rows = []
    for offset in range(start_offset, stop_offset + 1):
        point = (base + timedelta(days=offset)).isoformat()
        rows.append(("510300", point, 1 + offset * 0.001))
        if offset % 2 == 0:
            rows.append(("159915", point, 2 * (1 + offset * 0.0005)))
    return rows


def test_portfolio_snapshot_preserves_weights_and_rejects_incomplete_inputs(portfolio_db):
    snapshot, request_items, result, _ = _portfolio_snapshot()

    assert [(row.fund_code, row.current_weight, row.target_weight) for row in snapshot.components] == [
        ("159915", 30.0, 40.0),
        ("510300", 60.0, 50.0),
    ]
    assert snapshot.current_cash_weight == 10
    assert snapshot.target_cash_weight == 10

    reordered = {
        **result,
        "decisions": list(reversed(result["decisions"])),
        "rebalance": list(reversed(result["rebalance"])),
    }
    replay = v8_repo.build_portfolio_decision_snapshot(
        list(reversed(request_items)), reordered,
    )
    assert replay.portfolio_decision_id == snapshot.portfolio_decision_id
    assert v8_repo.save_portfolio_decision(replay) == snapshot

    with pytest.raises(ValueError, match="every requested component"):
        v8_repo.build_portfolio_decision_snapshot(
            request_items,
            {**result, "decisions": result["decisions"][:1]},
        )
    overweight = [dict(row) for row in result["rebalance"]]
    overweight[0]["current_weight"] = 80
    with pytest.raises(ValueError, match="not normalized"):
        v8_repo.build_portfolio_decision_snapshot(
            request_items,
            {**result, "rebalance": overweight},
        )

    earlier = PortfolioDecisionSnapshot.model_validate({
        **snapshot.model_dump(mode="python"),
        "created_at": snapshot.created_at - timedelta(seconds=1),
    })
    with pytest.raises(ValueError, match="cannot predate a component decision"):
        v8_repo.save_portfolio_decision(earlier)

    wrong_axis = snapshot.model_dump(mode="python", exclude={
        "portfolio_decision_id", "created_at",
    })
    wrong_axis["decision_date"] = snapshot.decision_date - timedelta(days=1)
    mismatched = PortfolioDecisionSnapshot(
        portfolio_decision_id=v8_repo.stable_id("pdec", wrong_axis),
        created_at=snapshot.created_at,
        **wrong_axis,
    )
    with pytest.raises(ValueError, match="latest component decision"):
        v8_repo.save_portfolio_decision(mismatched)


def test_portfolio_outcomes_use_only_common_dates_and_explicit_cash(portfolio_db):
    import main

    snapshot, _, _, _ = _portfolio_snapshot()
    base = snapshot.decision_date.isoformat()
    _insert_navs(portfolio_db, [
        ("510300", base, 1.0),
        ("159915", base, 2.0),
        *_nav_rows(start_offset=1, stop_offset=8),
    ])

    assert v8_repo.settle_portfolio_outcomes(
        snapshot.portfolio_decision_id, horizons=(5,),
    ) == []

    _insert_navs(portfolio_db, _nav_rows(start_offset=9, stop_offset=120))
    settled = main.v8_settle_portfolio_outcomes(
        snapshot.portfolio_decision_id, 100, "worker",
    )
    assert settled["settled"] == 3

    rows = v8_repo.portfolio_outcome_rows(snapshot.portfolio_decision_id)
    assert [row.horizon for row in rows] == [5, 20, 60]
    assert [row.evaluation_date for row in rows] == [
        snapshot.decision_date + timedelta(days=10),
        snapshot.decision_date + timedelta(days=40),
        snapshot.decision_date + timedelta(days=120),
    ]
    horizon_60 = rows[-1]
    assert horizon_60.method == "common_nav_dates_no_forward_fill"
    assert horizon_60.current_cash_weight == 10
    assert horizon_60.cash_return == 0
    assert horizon_60.cash_contribution == 0
    assert horizon_60.absolute_return == pytest.approx(9.0)
    assert {row.fund_code: row.contribution for row in horizon_60.components} == pytest.approx({
        "510300": 7.2,
        "159915": 1.8,
    })

    conn = portfolio_db.get_conn()
    before = conn.execute(
        "SELECT COUNT(*) FROM portfolio_outcome_evaluations"
    ).fetchone()[0]
    conn.close()
    response = main.v8_portfolio_outcomes(10)
    assert response["items"][0]["pending_horizons"] == []
    assert v8_repo.settle_all_portfolio_outcomes(1)["scanned"] == 0
    conn = portfolio_db.get_conn()
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM portfolio_outcome_evaluations"
        ).fetchone()[0] == before
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute(
                "UPDATE portfolio_decision_snapshots SET source='changed'"
            )
        conn.rollback()
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute("DELETE FROM portfolio_outcome_evaluations")
    finally:
        conn.close()


def test_settle_all_skips_fully_settled_old_snapshots(portfolio_db):
    old_snapshot, request_items, result, _ = _portfolio_snapshot()
    _insert_navs(portfolio_db, [
        ("510300", old_snapshot.decision_date.isoformat(), 1.0),
        ("159915", old_snapshot.decision_date.isoformat(), 2.0),
        *_nav_rows(start_offset=1, stop_offset=120),
    ])
    assert len(v8_repo.settle_portfolio_outcomes(
        old_snapshot.portfolio_decision_id,
    )) == 3

    new_snapshot = v8_repo.save_portfolio_decision(
        v8_repo.build_portfolio_decision_snapshot(
            request_items,
            result,
            source="starvation-regression",
        )
    )
    assert v8_repo.portfolio_outcome_rows(new_snapshot.portfolio_decision_id) == []

    settled = v8_repo.settle_all_portfolio_outcomes(limit=1)

    assert settled == {"settled": 3, "scanned": 1, "errors": []}
    assert [row.horizon for row in v8_repo.portfolio_outcome_rows(
        new_snapshot.portfolio_decision_id,
    )] == [5, 20, 60]


def test_decisions_reject_future_inputs(portfolio_db):
    policy = v8_repo.ensure_default_policy(T0)

    future_evidence = v8_repo.save_evidence(_evidence("510300", created_at=T1))
    current_holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=True, current_weight=10, target_weight=10,
        source="test", created_at=T0,
    ))
    with pytest.raises(ValueError, match="future evidence"):
        v8_repo.save_decision(build_decision_snapshot(
            future_evidence, current_holding, policy, created_at=T0,
        ))

    current_evidence = v8_repo.save_evidence(_evidence("159915", created_at=T0))
    future_holding = v8_repo.save_holding(build_holding_version(
        "159915", is_held=True, current_weight=10, target_weight=10,
        source="test", created_at=T1,
    ))
    with pytest.raises(ValueError, match="future holding"):
        v8_repo.save_decision(build_decision_snapshot(
            current_evidence, future_holding, policy, created_at=T0,
        ))

    future_policy = v8_repo.save_policy(build_portfolio_policy(
        name="future-policy",
        max_single_fund_weight=50,
        effective_at=T1,
        source="test",
        supersedes=policy.policy_version,
        created_at=T1,
    ))
    third_evidence = v8_repo.save_evidence(_evidence("161725", created_at=T0))
    third_holding = v8_repo.save_holding(build_holding_version(
        "161725", is_held=True, current_weight=10, target_weight=10,
        source="test", created_at=T0,
    ))
    with pytest.raises(ValueError, match="future policy"):
        v8_repo.save_decision(build_decision_snapshot(
            third_evidence, third_holding, future_policy, created_at=T0,
        ))


def test_historical_outcome_summary_is_same_strategy_and_past_only(portfolio_db):
    snapshot, _, _, decisions = _portfolio_snapshot()
    _insert_navs(portfolio_db, [
        ("510300", snapshot.decision_date.isoformat(), 1.0),
        ("159915", snapshot.decision_date.isoformat(), 2.0),
        *_nav_rows(start_offset=1, stop_offset=120),
    ])
    v8_repo.settle_outcomes(decisions[0].decision_id)

    before_backfill = v8_repo.historical_outcome_summary(
        "510300",
        "portfolio-v8-test",
        at=SETTLED_AT - timedelta(days=1),
        horizon=20,
    )
    visible = v8_repo.historical_outcome_summary(
        "510300",
        "portfolio-v8-test",
        at=SETTLED_AT + timedelta(days=1),
        horizon=20,
    )
    wrong_strategy = v8_repo.historical_outcome_summary(
        "510300",
        "other-strategy",
        at=SETTLED_AT + timedelta(days=1),
        horizon=20,
    )

    assert before_backfill["samples"] == 0
    assert before_backfill["mean_return"] is None
    assert visible["samples"] == 1
    # The first component is over the default single-fund limit, so its
    # defensive decision is not a hit when the subsequent return is positive.
    assert visible["hit_rate"] == 0
    assert visible["mean_return"] == pytest.approx(2.0)
    assert wrong_strategy["samples"] == 0


def test_create_evidence_never_reads_an_outcome_backfilled_after_its_snapshot_time(
    portfolio_db,
    monkeypatch,
):
    snapshot, _, _, decisions = _portfolio_snapshot()
    _insert_navs(portfolio_db, [
        ("510300", snapshot.decision_date.isoformat(), 1.0),
        ("159915", snapshot.decision_date.isoformat(), 2.0),
        *_nav_rows(start_offset=1, stop_offset=120),
    ])
    v8_repo.settle_outcomes(decisions[0].decision_id)
    monkeypatch.setattr(v8_decisions, "STRATEGY_VERSION", "portfolio-v8-test")
    monkeypatch.setattr(v8_decisions, "score_fund", lambda detail: {
        "score": 80,
        "score_version": "score-v1",
        "coverage": 1,
        "components": {"risk": {"detail": {"max_drawdown": -10, "volatility": 12}}},
    })
    monkeypatch.setattr(v8_decisions, "timing_signal", lambda detail: {
        "signal": "买入",
        "signal_version": "signal-v1",
        "coverage": 1,
        "layers": {
            "valuation": {"label": "低估", "percentile": 20, "source": "index_pe_pb"},
            "trend": {"label": "上升趋势"},
            "sentiment": {"label": "中性"},
        },
    })
    detail = {
        "code": "510300",
        "name": "历史结果测试",
        "type": "指数型",
        "latest_nav": 1.0,
        "latest_nav_date": snapshot.decision_date.isoformat(),
        "source": "test",
        "updated_at": T0.isoformat(),
    }
    official = {
        "status": "latest_official",
        "kind": "official_nav",
        "source": "test_official",
        "source_time": snapshot.decision_date.isoformat(),
        "source_time_precision": "date",
        "is_fallback": True,
        "fallback_reason": "intraday_unavailable",
        "estimate_change": None,
        "estimate_nav": None,
        "base_nav": 1.0,
        "base_nav_date": snapshot.decision_date.isoformat(),
        "value_nav": 1.0,
        "value_date": snapshot.decision_date.isoformat(),
    }

    before = v8_decisions.create_evidence(
        detail,
        estimate_context=official,
        created_at=SETTLED_AT - timedelta(days=1),
    )
    after = v8_decisions.create_evidence(
        detail,
        estimate_context=official,
        created_at=SETTLED_AT + timedelta(days=1),
    )
    before_node = next(node for node in before.evidence_nodes if node.node_id == "historical_outcome")
    after_node = next(node for node in after.evidence_nodes if node.node_id == "historical_outcome")

    assert before_node.state == "missing"
    assert after_node.state == "neutral"
    assert "1/10" in after_node.label
    assert before.evidence_id != after.evidence_id
