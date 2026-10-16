"""Reserved-fixture write protection; synthetic SQLite resources only."""
from datetime import date, timedelta
import sqlite3

import pytest

from database import db
from models.v8 import (OutcomeEvaluation, PortfolioDecisionComponent, PortfolioDecisionSnapshot,
                       PortfolioOutcomeComponent, PortfolioOutcomeEvaluation, canonical_json, payload_sha256, stable_id)
from service import persistence_verification as verification, v8_repo, repository_scopes as scopes
from strategy.decision_v2 import build_decision_snapshot


NS = "v9-acceptance-boundary"
KINDS = ("holding", "evidence", "policy", "decision")


def configure(path, monkeypatch):
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))


def provision(path, monkeypatch):
    configure(path, monkeypatch)
    with path.open("xb"):
        pass
    verification.provision_local_namespace(path, NS)
    return path


def save_chain(chain, *, scope=scopes.PRODUCTION):
    for kind in KINDS:
        getattr(v8_repo, "save_" + kind)(chain[kind], scope=scope)


def business_chain():
    chain = verification.fixture_chain(NS)
    e = chain["evidence"].model_copy(update={
        "score_version": "business-v1",
        "source_states": [item.model_copy(update={"source_id": "business:" + str(index)})
                          for index, item in enumerate(chain["evidence"].source_states)],
        "evidence_nodes": [item.model_copy(update={"source_id": "business"})
                           for item in chain["evidence"].evidence_nodes],
        "fund_name": "synthetic: is just a name, local-persistence: is just prose",
    })
    e = e.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(e))})
    h = chain["holding"].model_copy(update={"source": "business", "account": "normal"})
    h = h.model_copy(update={"holding_version": stable_id("hold", v8_repo._holding_identity(h))})
    p = chain["policy"].model_copy(update={"source": "business", "name": "synthetic: descriptive name"})
    p = p.model_copy(update={"policy_version": stable_id("pol", v8_repo._policy_identity(p))})
    d = build_decision_snapshot(e, h, p, strategy_version="business-v1", created_at=verification.FIXTURE_TIME)
    return {"evidence": e, "holding": h, "policy": p, "decision": d}


def copied_fixture(tmp_path, monkeypatch, *, business=False):
    source = provision(tmp_path / "exclusive.db", monkeypatch)
    verification.write_local_chain(source, NS)
    target = tmp_path / "ordinary.db"
    configure(target, monkeypatch)
    db.init_db()
    normal = business_chain()
    if business:
        save_chain(normal)
    # Simulate pre-guard persisted roots using raw synthetic data, not the API.
    with sqlite3.connect(source) as origin, sqlite3.connect(target) as dest:
        for table in ("holding_versions", "evidence_snapshots", "source_health_events",
                      "portfolio_policy_versions", "decision_snapshots"):
            for row in origin.execute("SELECT * FROM " + table):
                dest.execute("INSERT INTO " + table + " VALUES(" + ",".join("?" for _ in row) + ")", row)
    return target, verification.fixture_chain(NS), normal


def counts(path):
    with sqlite3.connect(path) as conn:
        return {table: conn.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
                for table in (*[value[0] for value in verification.CHAIN_TABLES.values()],
                              "source_health_events", "notification_events", "outcome_evaluations",
                              "portfolio_decision_snapshots", "portfolio_outcome_evaluations")}


@pytest.mark.parametrize("kind", KINDS)
def test_unmarked_replay_is_rejected_before_existing_return(tmp_path, monkeypatch, kind):
    path, chain, _ = copied_fixture(tmp_path, monkeypatch)
    before = counts(path)
    with pytest.raises(ValueError, match="^local_acceptance_write_forbidden$"):
        getattr(v8_repo, "save_" + kind)(chain[kind])
    assert counts(path) == before


@pytest.mark.parametrize("kind", KINDS)
def test_direct_reserved_remote_input_does_not_open_a_connection(monkeypatch, kind):
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    monkeypatch.setattr(db, "get_conn", lambda: pytest.fail("No provider connection may be opened"))
    with pytest.raises(ValueError, match="^local_acceptance_write_forbidden$"):
        getattr(v8_repo, "save_" + kind)(verification.fixture_chain(NS)[kind])


@pytest.mark.parametrize("kind", ("holding", "evidence", "policy"))
def test_marked_database_rejects_business_and_different_namespace(tmp_path, monkeypatch, kind):
    path = provision(tmp_path / "exclusive.db", monkeypatch)
    for chain in (business_chain(), verification.fixture_chain("v9-acceptance-other")):
        with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
            getattr(v8_repo, "save_" + kind)(chain[kind])
        assert not any(counts(path).values())


def test_exact_fixture_prefix_is_idempotent_but_changed_content_is_not_allowed(tmp_path, monkeypatch):
    path = provision(tmp_path / "exclusive.db", monkeypatch)
    chain = verification.fixture_chain(NS)
    h = chain["holding"].model_copy(update={"shares": 101.0})
    h = h.model_copy(update={"holding_version": stable_id("hold", v8_repo._holding_identity(h))})
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_holding(h)
    assert counts(path)["holding_versions"] == 0
    save_chain(chain, scope=scopes.acceptance_scope(NS))
    before = counts(path)
    save_chain(chain, scope=scopes.acceptance_scope(NS))
    assert counts(path) == before
    assert verification.read_local_chain(path, NS)["formal_release_verified"] is False


@pytest.mark.parametrize("tamper", [
    "DROP TABLE local_persistence_acceptance_v1",
    "UPDATE local_persistence_acceptance_v1 SET namespace='v9-acceptance-other'",
    "UPDATE local_persistence_acceptance_v1 SET source_sha256='private-marker'",
    "INSERT INTO watchlist VALUES('000001','2026-09-01')",
    "DROP TRIGGER immutable_holding_versions_update",
    "PRAGMA user_version=99",
])
def test_tampered_or_mixed_database_cannot_replay_fixture(tmp_path, monkeypatch, tamper):
    path = provision(tmp_path / "exclusive.db", monkeypatch)
    verification.write_local_chain(path, NS)
    with sqlite3.connect(path) as conn:
        conn.execute(tamper)
    before = counts(path)
    with pytest.raises(ValueError, match="^local_acceptance_write_forbidden$"):
        v8_repo.save_holding(verification.fixture_chain(NS)["holding"])
    assert counts(path) == before


def test_guard_checks_the_actual_transaction_resource(tmp_path, monkeypatch):
    path = provision(tmp_path / "exclusive.db", monkeypatch)
    other = tmp_path / "other.db"
    with sqlite3.connect(path) as source, sqlite3.connect(other) as dest:
        source.backup(dest)
    def wrong_connection():
        conn = sqlite3.connect(other)
        conn.row_factory = sqlite3.Row
        return conn
    monkeypatch.setattr(db, "get_conn", wrong_connection)
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_holding(verification.fixture_chain(NS)["holding"])
    assert not any(counts(path).values()) and not any(counts(other).values())


def test_guard_and_insert_share_immediate_write_lock(tmp_path, monkeypatch):
    path = provision(tmp_path / "exclusive.db", monkeypatch)
    original = verification._inspect_chain
    observed = []
    def inspect(conn, *args, **kwargs):
        assert conn.in_transaction
        with sqlite3.connect(path, timeout=0) as rival:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                rival.execute("INSERT INTO watchlist VALUES('000001','2026-09-01')")
        observed.append(True)
        return original(conn, *args, **kwargs)
    monkeypatch.setattr(verification, "_inspect_chain", inspect)
    v8_repo.save_holding(verification.fixture_chain(NS)["holding"], scope=scopes.acceptance_scope(NS))
    assert observed and counts(path)["holding_versions"] == 1
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM watchlist").fetchone()[0] == 0


def test_business_provenance_names_and_fund_code_are_not_mistaken_for_fixture(tmp_path, monkeypatch):
    path = tmp_path / "business.db"
    configure(path, monkeypatch)
    db.init_db()
    save_chain(business_chain())
    assert counts(path)["decision_snapshots"] == 1


def test_changed_decision_strategy_cannot_hide_reserved_references(tmp_path, monkeypatch):
    path, chain, _ = copied_fixture(tmp_path, monkeypatch)
    decision = build_decision_snapshot(chain["evidence"], chain["holding"], chain["policy"],
                                       strategy_version="business-v1", created_at=verification.FIXTURE_TIME)
    before = counts(path)
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_decision(decision)
    assert counts(path) == before


def test_business_policy_cannot_supersede_reserved_tip(tmp_path, monkeypatch):
    path, chain, _ = copied_fixture(tmp_path, monkeypatch)
    policy = chain["policy"].model_copy(update={"source": "business", "supersedes": chain["policy"].policy_version,
        "effective_at": verification.FIXTURE_TIME + timedelta(days=1),
        "created_at": verification.FIXTURE_TIME + timedelta(days=1)})
    policy = policy.model_copy(update={"policy_version": stable_id("pol", v8_repo._policy_identity(policy))})
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_policy(policy)
    assert counts(path)["portfolio_policy_versions"] == 1


@pytest.mark.parametrize("status", ["scheduled", "skipped", "attempted", "sent", "failed", "compensated"])
def test_mixed_notification_batch_is_rejected_atomically(tmp_path, monkeypatch, status):
    path, chain, normal = copied_fixture(tmp_path, monkeypatch, business=True)
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.record_notification_events_batch(
            decision_ids=[normal["decision"].decision_id, chain["decision"].decision_id],
            scheduled_window="2026-09-01T14:30+08:00", status=status,
            attempt_no=0 if status in {"scheduled", "skipped"} else 1,
            natural_schedule=True, occurred_at=verification.FIXTURE_TIME,
        )
    assert counts(path)["notification_events"] == 0


def test_outcome_rejects_reserved_roots_before_nav_lookup(tmp_path, monkeypatch):
    path, chain, _ = copied_fixture(tmp_path, monkeypatch)
    identity = {"decision_id": chain["decision"].decision_id, "evaluation_kind": "horizon", "horizon": 5,
                "evaluation_date": date(2026, 9, 6)}
    outcome = OutcomeEvaluation(outcome_id=stable_id("out", identity), **identity,
        base_nav_date=date(2026, 9, 1), base_nav=1.0, evaluated_nav=1.0, absolute_return=0.0,
        max_drawdown=0.0, hit=True, created_at=verification.FIXTURE_TIME + timedelta(days=5))
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_outcome(outcome)
    assert counts(path)["outcome_evaluations"] == 0


def wrapped_portfolio(chain):
    d = chain["decision"]
    component = PortfolioDecisionComponent(fund_code=d.fund_code, decision_id=d.decision_id,
        evidence_id=d.evidence_id, holding_version=d.holding_version, action=d.action,
        current_weight=20, target_weight=20)
    semantic = dict(decision_date=date(2026, 9, 1), policy_version=d.policy_version,
        strategy_version="business-v1", components=[component], current_cash_weight=80,
        target_cash_weight=80, portfolio_value=None, source="business")
    snapshot = PortfolioDecisionSnapshot(portfolio_decision_id=stable_id("pdec", semantic),
        created_at=verification.FIXTURE_TIME, **semantic)
    return snapshot.model_copy(update={"portfolio_decision_id": stable_id("pdec", v8_repo._portfolio_decision_identity(snapshot))})


def test_portfolio_cannot_wrap_reserved_components_in_a_business_source(tmp_path, monkeypatch):
    path, chain, _ = copied_fixture(tmp_path, monkeypatch)
    snapshot = wrapped_portfolio(chain)
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_portfolio_decision(snapshot)
    assert counts(path)["portfolio_decision_snapshots"] == 0


@pytest.mark.parametrize("marker", ["account", "source", "wrapped_source", "malformed_source", "node_source"])
def test_single_reserved_provenance_field_is_sufficient(tmp_path, monkeypatch, marker):
    path = tmp_path / "ordinary.db"
    configure(path, monkeypatch)
    db.init_db()
    chain = business_chain()
    if marker in {"account", "source"}:
        update = {marker: "synthetic:" + NS if marker == "account" else "local-persistence:" + NS}
        model = chain["holding"].model_copy(update=update)
        model = model.model_copy(update={"holding_version": stable_id("hold", v8_repo._holding_identity(model))})
        kind = "holding"
    else:
        key = "evidence_nodes" if marker == "node_source" else "source_states"
        items = list(getattr(chain["evidence"], key))
        source = "local-persistence:" if marker == "malformed_source" else "estimate:local-persistence:" + NS
        items[0] = items[0].model_copy(update={"source_id": source})
        model = chain["evidence"].model_copy(update={key: items})
        model = model.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(model))})
        kind = "evidence"
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        getattr(v8_repo, "save_" + kind)(model)
    assert not any(counts(path).values())


def test_portfolio_outcome_rejects_hidden_acceptance_before_nav_calculation(tmp_path, monkeypatch):
    path, chain, _ = copied_fixture(tmp_path, monkeypatch)
    snapshot = wrapped_portfolio(chain)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO portfolio_decision_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            snapshot.portfolio_decision_id, snapshot.decision_date.isoformat(), snapshot.policy_version,
            snapshot.strategy_version, 1, 80, 80, None, canonical_json(snapshot.components), "business",
            snapshot.created_at.isoformat(), canonical_json(snapshot), payload_sha256(v8_repo._portfolio_decision_identity(snapshot)),
        ))
    identity = dict(portfolio_decision_id=snapshot.portfolio_decision_id, horizon=5, evaluation_date=date(2026, 9, 6))
    component = PortfolioOutcomeComponent(fund_code="999999", current_weight=20, base_nav=1.0,
        evaluated_nav=1.0, absolute_return=0.0, contribution=0.0)
    outcome = PortfolioOutcomeEvaluation(outcome_id=stable_id("pout", identity), **identity,
        base_nav_date=date(2026, 9, 1), absolute_return=0.0, max_drawdown=0.0, current_cash_weight=80,
        components=[component], created_at=verification.FIXTURE_TIME + timedelta(days=5))
    monkeypatch.setattr(v8_repo, "_calculate_portfolio_outcome", lambda *a, **k: pytest.fail("Do not calculate acceptance NAV"))
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_portfolio_outcome(outcome)
    assert counts(path)["portfolio_outcome_evaluations"] == 0


def test_notification_guard_precedes_exact_replay_return(tmp_path, monkeypatch):
    path, chain, _ = copied_fixture(tmp_path, monkeypatch)
    params = dict(decision_id=chain["decision"].decision_id, scheduled_window="2026-09-01T14:30+08:00",
        status="scheduled", attempt_no=0, natural_schedule=True, occurred_at=verification.FIXTURE_TIME)
    event = v8_repo._notification_event(**params, error_class=None, detail={})
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO notification_events VALUES(?,?,?,?,?,?,?,?,?,?)", (
            event.event_log_id, event.notification_event_id, event.decision_id, event.scheduled_window,
            event.status, 0, 1, event.occurred_at.isoformat(), None, canonical_json(event),
        ))
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.record_notification_event(**params)
    assert counts(path)["notification_events"] == 1


def test_remote_business_guard_adds_no_provider_query(monkeypatch):
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    class NoRequests:
        def execute(self, *args):
            pytest.fail("Normal remote guard must not add a query")
    for kind, model in business_chain().items():
        verification.preflight_repository_write(model)
        verification.guard_repository_write(NoRequests(), kind, model)


def test_projected_reference_drift_cannot_select_a_different_lineage(tmp_path, monkeypatch):
    path, chain, normal = copied_fixture(tmp_path, monkeypatch, business=True)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_decision_snapshots_update")
        conn.execute("UPDATE decision_snapshots SET holding_version=? WHERE decision_id=?",
                     (normal["holding"].holding_version, chain["decision"].decision_id))
    with pytest.raises(v8_repo.SnapshotConflictError, match="references disagree"):
        v8_repo.record_notification_event(decision_id=chain["decision"].decision_id,
            scheduled_window="2026-09-01T14:30+08:00", status="scheduled", attempt_no=0,
            natural_schedule=True, occurred_at=verification.FIXTURE_TIME)
    assert counts(path)["notification_events"] == 0
