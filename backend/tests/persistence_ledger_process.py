"""Writer/reader subprocess used by the V8 persistence recovery tests."""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone

from database import db
from service import v8_repo
from strategy.decision_v2 import (
    build_decision_snapshot,
    build_evidence_snapshot,
    build_holding_version,
    build_portfolio_policy,
)


CODE = "018147"
CREATED_AT = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)
SETTLED_AT = datetime(2026, 9, 1, 6, 30, tzinfo=timezone.utc)
READ_AT = datetime(2026, 9, 1, 7, 30, tzinfo=timezone.utc)
WINDOW = "2026-08-25T14:30+08:00"
REQUEST = {"scope": "v8-full-ledger-restart", "schema_version": 1}
REQUEST_ID = "v8-full-ledger-restart-proof"
ENDPOINT = "/persistence/full-ledger"


def _close(left: float, right: float, tolerance: float = 1e-8) -> bool:
    return abs(float(left) - float(right)) <= tolerance


def _evidence():
    detail = {
        "code": CODE,
        "name": "跨进程 QDII 测试基金",
        "type": "QDII",
        "latest_nav": 1.0,
        "latest_nav_date": "2026-08-22",
        "source": "persistence-restart-test",
        "updated_at": "2026-08-25T06:00:00+00:00",
        "decision_context": {
            "status": "modeled",
            "kind": "qdii_next_nav_estimate",
            "source": "qdii-restart-model",
            "source_time": "2026-08-25T14:29:00+08:00",
            "source_time_precision": "datetime",
            "base_nav": 1.0,
            "base_nav_date": "2026-08-22",
            "estimate_change": 1.25,
            "target_nav_date": "2026-08-25",
            "coverage": 87,
            "model_version": "qdii-restart-test",
            "sample_count": 30,
            "error_p80": 0.8,
            # Intentionally absent: MAE must remain null, never become zero.
            "direction_accuracy": 65,
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
        created_at=CREATED_AT,
    )


def _table_counts() -> dict[str, int]:
    tables = (
        "evidence_snapshots",
        "source_health_events",
        "holding_versions",
        "portfolio_policy_versions",
        "decision_snapshots",
        "outcome_evaluations",
        "portfolio_decision_snapshots",
        "portfolio_outcome_evaluations",
        "notification_events",
        "idempotency_responses",
    )
    with db.get_conn() as conn:
        return {
            table: int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in tables
        }


def write_ledger() -> None:
    db.init_db()
    evidence = v8_repo.save_evidence(_evidence())
    holding = v8_repo.save_holding(build_holding_version(
        CODE,
        is_held=True,
        shares=None,
        cost=None,
        market_value=None,
        account=None,
        current_weight=80,
        target_weight=80,
        source="persistence-restart-test",
        created_at=CREATED_AT,
    ))
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="跨进程恢复策略",
        target_allocations={CODE: 80},
        target_ranges={CODE: (70, 85)},
        max_single_fund_weight=90,
        max_theme_weight=None,
        rebalance_band=2,
        effective_at=CREATED_AT,
        source="persistence-restart-test",
        created_at=CREATED_AT,
    ))
    decision = v8_repo.save_decision(build_decision_snapshot(
        evidence,
        holding,
        policy,
        strategy_version="v8-ledger-restart-test",
        created_at=CREATED_AT,
    ))

    with db.transaction(immediate=True) as conn:
        conn.executemany(
            "INSERT INTO nav_history(code,date,nav,ac_return) VALUES(?,?,?,NULL)",
            [
                (CODE, "2026-08-22", 1.0),
                (CODE, "2026-08-25", 1.02),
                (CODE, "2026-08-26", 1.01),
                (CODE, "2026-08-27", 1.03),
                (CODE, "2026-08-28", 1.04),
                (CODE, "2026-08-29", 1.05),
                (CODE, "2026-08-30", 1.06),
            ],
        )

    v8_repo._now = lambda: SETTLED_AT
    outcomes = v8_repo.settle_outcomes(decision.decision_id, horizons=())
    assert len(outcomes) == 1 and outcomes[0].evaluation_kind == "qdii_target"

    request_items = [{"code": CODE, "theme": "海外"}]
    result = {
        "complete": True,
        "errors": [],
        "decisions": [{
            "code": CODE,
            "name": evidence.fund_name,
            "action": decision.action,
            "evidence": evidence.model_dump(mode="json"),
            "holding": holding.model_dump(mode="json"),
            "decision": decision.model_dump(mode="json"),
        }],
        "rebalance": [{
            "code": CODE,
            "name": evidence.fund_name,
            "action": decision.action,
            "theme": "海外",
            "current_weight": 80,
            "target_weight": 80,
        }],
        "policy_version": policy.policy_version,
        "strategy_version": decision.strategy_version,
    }
    portfolio_decision = v8_repo.save_portfolio_decision(
        v8_repo.build_portfolio_decision_snapshot(
            request_items,
            result,
            portfolio_value=None,
            source="persistence-restart-test",
        )
    )
    portfolio_outcomes = v8_repo.settle_portfolio_outcomes(
        portfolio_decision.portfolio_decision_id,
        horizons=(5,),
    )
    assert len(portfolio_outcomes) == 1

    for status, attempt_no, occurred_at in (
        ("scheduled", 0, CREATED_AT + timedelta(minutes=1)),
        ("attempted", 1, CREATED_AT + timedelta(minutes=2)),
        ("sent", 1, CREATED_AT + timedelta(minutes=3)),
    ):
        v8_repo.record_notification_event(
            decision_id=decision.decision_id,
            scheduled_window=WINDOW,
            status=status,
            attempt_no=attempt_no,
            natural_schedule=True,
            occurred_at=occurred_at,
        )

    manifest = {
        "evidence_id": evidence.evidence_id,
        "holding_version": holding.holding_version,
        "policy_version": policy.policy_version,
        "decision_id": decision.decision_id,
        "decision_action": decision.action,
        "outcome_id": outcomes[0].outcome_id,
        "portfolio_decision_id": portfolio_decision.portfolio_decision_id,
        "portfolio_outcome_id": portfolio_outcomes[0].outcome_id,
        "notification_event_id": v8_repo.notification_event_id(decision.decision_id, WINDOW),
    }
    claim = v8_repo.claim_idempotency(REQUEST_ID, ENDPOINT, REQUEST)
    assert claim["state"] == "claimed"
    v8_repo.complete_idempotency(
        REQUEST_ID,
        ENDPOINT,
        manifest,
        owner_token=claim["owner_token"],
    )
    assert _table_counts() == {
        "evidence_snapshots": 1,
        "source_health_events": len(evidence.source_states),
        "holding_versions": 1,
        "portfolio_policy_versions": 1,
        "decision_snapshots": 1,
        "outcome_evaluations": 1,
        "portfolio_decision_snapshots": 1,
        "portfolio_outcome_evaluations": 1,
        "notification_events": 3,
        "idempotency_responses": 1,
    }
    print("full-ledger-write-ok")


def read_ledger() -> None:
    db.init_db()
    replay = v8_repo.claim_idempotency(REQUEST_ID, ENDPOINT, REQUEST)
    assert replay["state"] == "complete"
    manifest = replay["response"]
    assert v8_repo.claim_idempotency(
        REQUEST_ID,
        ENDPOINT,
        {**REQUEST, "schema_version": 2},
    ) == {"state": "conflict"}

    evidence = v8_repo.get_evidence(manifest["evidence_id"])
    holding = v8_repo.get_holding(manifest["holding_version"])
    policy = v8_repo.read_policy(manifest["policy_version"], at=READ_AT)
    decision = v8_repo.get_decision(manifest["decision_id"])
    assert evidence is not None and holding is not None and decision is not None
    assert evidence.official_nav_date == date(2026, 8, 22)
    assert evidence.target_nav_date == date(2026, 8, 25)
    # Pydantic serializes the same instant as UTC; verify the instant rather
    # than requiring the original display offset to survive JSON round-trips.
    assert evidence.market_time == datetime(2026, 8, 25, 6, 29, tzinfo=timezone.utc)
    assert _close(evidence.estimate, 1.25)
    assert evidence.benchmark_id is None
    assert evidence.estimate_mae is None
    assert evidence.estimate_sample_count == 30
    expected_source_events = []
    for state in evidence.source_states:
        state_payload = state.model_dump(mode="python")
        expected_source_events.append({
            "event_id": v8_repo.stable_id("src", {
                "evidence_id": evidence.evidence_id,
                "source_id": state.source_id,
                "state": state_payload,
            }),
            "source_id": state.source_id,
            "payload": json.loads(v8_repo.canonical_json(state_payload)),
        })
    with db.get_conn() as conn:
        source_rows = conn.execute(
            """SELECT event_id,source_id,payload_json FROM source_health_events
               WHERE evidence_id=? ORDER BY source_id""",
            (evidence.evidence_id,),
        ).fetchall()
    actual_source_events = [{
        "event_id": row["event_id"],
        "source_id": row["source_id"],
        "payload": json.loads(row["payload_json"]),
    } for row in source_rows]
    assert actual_source_events == sorted(
        expected_source_events,
        key=lambda item: item["source_id"],
    )
    assert holding.holding_version == manifest["holding_version"]
    assert holding.current_weight == 80 and holding.target_weight == 80
    assert holding.shares is None and holding.cost is None
    assert holding.market_value is None and holding.account is None
    assert policy.target_allocations == {CODE: 80.0}
    assert policy.target_ranges == {CODE: (70.0, 85.0)}
    assert policy.max_theme_weight is None
    assert decision.evidence_id == evidence.evidence_id
    assert decision.holding_version == holding.holding_version
    assert decision.policy_version == policy.policy_version
    assert decision.strategy_version == "v8-ledger-restart-test"
    assert decision.action == manifest["decision_action"]
    assert decision.reason_codes and decision.invalidation_codes

    bundle = v8_repo.latest_decision_bundle(CODE)
    assert bundle is not None
    assert bundle["decision"] == decision
    assert bundle["evidence"] == evidence
    assert bundle["holding"] == holding
    assert bundle["policy"] == policy

    outcomes = v8_repo.outcome_rows(decision.decision_id)
    assert len(outcomes) == 1 and outcomes[0].outcome_id == manifest["outcome_id"]
    outcome = outcomes[0]
    assert outcome.evaluation_kind == "qdii_target" and outcome.horizon == 0
    assert outcome.base_nav_date == date(2026, 8, 22)
    assert outcome.evaluation_date == evidence.target_nav_date
    assert outcome.target_nav_date == evidence.target_nav_date
    assert _close(outcome.base_nav, 1.0)
    assert _close(outcome.evaluated_nav, 1.02)
    assert _close(outcome.absolute_return, 2.0)
    assert _close(outcome.predicted_change, 1.25)
    assert _close(outcome.prediction_error, -0.75)
    assert outcome.benchmark_return is None and outcome.peer_excess is None

    portfolio_decision = v8_repo.get_portfolio_decision(
        manifest["portfolio_decision_id"]
    )
    assert portfolio_decision is not None
    assert portfolio_decision.portfolio_value is None
    assert portfolio_decision.current_cash_weight == 20
    assert portfolio_decision.target_cash_weight == 20
    assert len(portfolio_decision.components) == 1
    assert portfolio_decision.components[0].current_weight == 80
    assert portfolio_decision.components[0].target_weight == 80
    portfolio_outcomes = v8_repo.portfolio_outcome_rows(
        portfolio_decision.portfolio_decision_id
    )
    assert len(portfolio_outcomes) == 1
    portfolio_outcome = portfolio_outcomes[0]
    assert portfolio_outcome.outcome_id == manifest["portfolio_outcome_id"]
    assert portfolio_outcome.method == "common_nav_dates_no_forward_fill"
    assert portfolio_outcome.current_cash_weight == 20
    assert len(portfolio_outcome.components) == 1

    events = v8_repo.notification_events(decision.decision_id)
    assert [event.status for event in events] == ["scheduled", "attempted", "sent"]
    assert all(event.notification_event_id == manifest["notification_event_id"] for event in events)
    assert v8_repo.notification_was_sent(decision.decision_id) is True
    duplicate = v8_repo.record_notification_events_batch(
        decision_ids=[decision.decision_id],
        scheduled_window=WINDOW,
        status="attempted",
        attempt_no=1,
        natural_schedule=True,
        occurred_at=READ_AT,
    )[0]
    assert duplicate.claimed is False and duplicate.duplicate is True

    before = _table_counts()
    assert v8_repo.save_evidence(evidence) == evidence
    assert v8_repo.save_holding(holding) == holding
    assert v8_repo.save_policy(policy) == policy
    assert v8_repo.save_decision(decision) == decision
    assert v8_repo.save_outcome(outcome) == outcome
    assert v8_repo.save_portfolio_decision(portfolio_decision) == portfolio_decision
    assert v8_repo.save_portfolio_outcome(portfolio_outcome) == portfolio_outcome
    assert _table_counts() == before

    with db.get_conn() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION
        assert conn.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA integrity_check(1)").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert db.persistence_status()["durable"] is False
    print("full-ledger-read-ok")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode == "write":
        write_ledger()
    elif mode == "read":
        read_ledger()
    else:
        raise SystemExit("usage: persistence_ledger_process.py {write|read}")
