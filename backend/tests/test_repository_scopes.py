"""Local synthetic scope gates, never a production/remote durability claim."""
from datetime import date, timedelta
import json
import sqlite3

import pytest

from database import db, turso_schema
from models.v8 import canonical_json, payload_sha256, stable_id
from service import persistence_verification as verification, repository_scopes as scopes, v8_repo
from strategy.decision_v2 import build_decision_snapshot
from test_acceptance_write_boundary import (NS, KINDS, business_chain, configure, copied_fixture,
                                            provision, save_chain, wrapped_portfolio)
from test_v8_portfolio_outcomes import (_portfolio_snapshot, _insert_navs, _nav_rows, SETTLED_AT)


@pytest.fixture
def business_db(tmp_path, monkeypatch):
    path = tmp_path / "business.db"
    configure(path, monkeypatch)
    db.init_db()
    chain = business_chain()
    save_chain(chain)
    return path, chain


def mixed_scopes(tmp_path, monkeypatch):
    path, acceptance, production = copied_fixture(tmp_path, monkeypatch, business=True)
    # Seed a second scope through raw synthetic SQL only. Repository acceptance
    # writes to mixed/remote databases remain forbidden, including this one.
    with sqlite3.connect(path) as conn:
        for kind in KINDS:
            scopes.register_record(conn, kind, getattr(acceptance[kind], scopes.ROOTS[kind][1]), scopes.acceptance_scope(NS))
    return path, acceptance, production


def drop_scope_contract(conn):
    for table in scopes.VIEW_TABLES:
        conn.execute("DROP VIEW production_" + table)
    conn.execute("DROP TABLE " + scopes.RECORD_TABLE)
    conn.execute("DROP TABLE " + scopes.SCOPE_TABLE)
    # A real prior physical revision, not a same-version object repair.
    conn.execute("PRAGMA user_version=8")


def root_rows(conn):
    return {kind: [tuple(row) for row in conn.execute("SELECT * FROM " + table)]
            for kind, (table, _) in scopes.ROOTS.items()}


def test_business_migration_preserves_every_root_projection_payload_and_id(business_db):
    path, chain = business_db
    with sqlite3.connect(path) as conn:
        before = root_rows(conn)
        drop_scope_contract(conn)
    db.init_db()
    with sqlite3.connect(path) as conn:
        assert root_rows(conn) == before
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
        assert len(conn.execute("SELECT * FROM v8_record_scopes").fetchall()) == 4
    backups = list(path.parent.glob(path.name + ".pre-v8-*.bak"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
        assert root_rows(conn) == before
    assert v8_repo.get_decision(chain["decision"].decision_id) == chain["decision"]


@pytest.mark.parametrize("tamper", ["reserved", "projection", "digest", "identity", "payload"])
def test_unsafe_legacy_classification_rolls_back_without_rewriting_roots(business_db, tamper):
    path, _ = business_db
    with sqlite3.connect(path) as conn:
        drop_scope_contract(conn)
        conn.execute("DROP TRIGGER immutable_holding_versions_update")
        if tamper == "reserved":
            payload = json.loads(conn.execute("SELECT payload_json FROM holding_versions").fetchone()[0])
            payload["source"] = "synthetic:" + NS
            conn.execute("UPDATE holding_versions SET payload_json=?", (canonical_json(payload),))
        elif tamper == "projection":
            conn.execute("UPDATE holding_versions SET shares=12345")
        elif tamper == "digest":
            conn.execute("UPDATE holding_versions SET payload_sha256='untrusted-digest'")
        elif tamper == "identity":
            conn.execute("UPDATE holding_versions SET holding_version='untrusted-id'")
            conn.execute("DROP TRIGGER immutable_decision_snapshots_update")
            conn.execute("UPDATE decision_snapshots SET holding_version='untrusted-id'")
        else:
            conn.execute("UPDATE holding_versions SET payload_json='{}'")
        before = root_rows(conn)
    with pytest.raises(sqlite3.DatabaseError, match="cannot be classified safely"):
        db.init_db()
    with sqlite3.connect(path) as conn:
        assert root_rows(conn) == before
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone()


@pytest.mark.parametrize("table", scopes.SCOPE_TABLES)
@pytest.mark.parametrize("operation", ["UPDATE", "DELETE"])
def test_scope_metadata_is_immutable(business_db, table, operation):
    path, _ = business_db
    with sqlite3.connect(path) as conn:
        sql = f"UPDATE {table} SET scope_key='production'" if operation == "UPDATE" else f"DELETE FROM {table}"
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute(sql)


def test_orphan_scope_registration_cannot_create_metadata(business_db):
    path, _ = business_db
    with sqlite3.connect(path) as conn:
        with pytest.raises(sqlite3.IntegrityError, match="scope root missing"):
            scopes.register_record(conn, "decision", "missing-root", scopes.PRODUCTION)


def test_schema9_missing_scope_is_not_silently_reclassified_at_restart(business_db):
    path, chain = business_db
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_v8_record_scopes_delete")
        conn.execute("DELETE FROM v8_record_scopes WHERE record_kind='holding'")
        conn.execute("CREATE TRIGGER immutable_v8_record_scopes_delete BEFORE delete ON v8_record_scopes BEGIN SELECT RAISE(ABORT, 'v8_record_scopes is immutable'); END")
        before = root_rows(conn)
    assert v8_repo.get_holding(chain["holding"].holding_version) is None
    with pytest.raises(ValueError, match="record scope missing"):
        v8_repo.save_holding(chain["holding"])
    with pytest.raises(sqlite3.DatabaseError, match="scope metadata missing; explicit repair required"):
        db.init_db()
    with sqlite3.connect(path) as conn:
        assert root_rows(conn) == before
        assert conn.execute("SELECT COUNT(*) FROM v8_record_scopes WHERE record_kind='holding'").fetchone()[0] == 0
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9


def test_scope_registration_failure_rolls_back_root_and_source_events(tmp_path, monkeypatch):
    path = tmp_path / "atomic.db"
    configure(path, monkeypatch)
    db.init_db()
    monkeypatch.setattr(scopes, "register_record", lambda *args: (_ for _ in ()).throw(ValueError("scope failed")))
    with pytest.raises(ValueError, match="scope failed"):
        v8_repo.save_evidence(business_chain()["evidence"])
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM evidence_snapshots").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM source_health_events").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM v8_record_scopes").fetchone()[0] == 0


def test_scope_is_explicit_and_exclusive_fixture_is_not_a_business_database(tmp_path, monkeypatch):
    path = provision(tmp_path / "exclusive.db", monkeypatch)
    fixture = verification.fixture_chain(NS)
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_holding(fixture["holding"])
    verification.write_local_chain(path, NS)
    assert verification.read_local_chain(path, NS)["formal_release_verified"] is False
    assert v8_repo.get_holding(fixture["holding"].holding_version) is None
    assert v8_repo.get_holding(fixture["holding"].holding_version, scope=scopes.acceptance_scope(NS)) == fixture["holding"]
    assert v8_repo.latest_evidence("999999") is None
    assert v8_repo.latest_decision("999999") is None
    assert v8_repo.read_policy_history() == []
    assert v8_repo.outcome_settlement_status()["decisions"] == 0
    assert v8_repo.settle_all_outcomes()["scanned"] == 0


def test_default_reads_filter_scope_in_sql_before_order_and_limit(tmp_path, monkeypatch):
    path, acceptance, production = mixed_scopes(tmp_path, monkeypatch)
    assert v8_repo.get_decision(acceptance["decision"].decision_id) is None
    assert v8_repo.get_evidence(acceptance["evidence"].evidence_id) is None
    with pytest.raises(LookupError):
        v8_repo.read_policy(acceptance["policy"].policy_version)
    assert v8_repo.latest_evidence("999999") == production["evidence"]
    assert v8_repo.latest_decision("999999") == production["decision"]
    assert v8_repo.decision_history("999999", limit=1) == [production["decision"]]
    assert v8_repo.outcomes_for_fund("999999")["total"] == 1
    assert v8_repo.outcome_settlement_status(limit=1)["decisions"] == 1
    assert v8_repo.read_policy_history() == [production["policy"]]
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM source_health_events").fetchone()[0] > conn.execute("SELECT COUNT(*) FROM production_source_health_events").fetchone()[0]
    with pytest.raises(LookupError, match="decision not found"):
        v8_repo.settle_outcomes(acceptance["decision"].decision_id)


def next_policy(chain, *, supersedes=None):
    policy = chain["policy"].model_copy(update={
        "supersedes": supersedes or chain["policy"].policy_version,
        "effective_at": verification.FIXTURE_TIME + timedelta(days=1),
        "created_at": verification.FIXTURE_TIME + timedelta(days=1),
    })
    return policy.model_copy(update={"policy_version": stable_id("pol", v8_repo._policy_identity(policy))})


def test_policy_tips_are_scoped_and_acceptance_child_cannot_hide_production_tip(tmp_path, monkeypatch):
    _, acceptance, production = mixed_scopes(tmp_path, monkeypatch)
    policy = next_policy(production)
    assert v8_repo.save_policy(policy) == policy
    assert v8_repo.read_policy(at=policy.created_at) == policy
    assert v8_repo.read_policy_history() == [policy, production["policy"]]
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_policy(next_policy(production, supersedes=acceptance["policy"].policy_version))


@pytest.mark.parametrize("kind", KINDS)
def test_cross_scope_existing_root_replay_rejected_even_without_reserved_provenance(tmp_path, monkeypatch, kind):
    path = tmp_path / "ordinary.db"
    configure(path, monkeypatch)
    db.init_db()
    chain = business_chain()
    save_chain(chain)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_v8_record_scopes_update")
        conn.execute("INSERT INTO v8_repository_scopes VALUES(?,?,?)", (scopes.acceptance_scope(NS).key, "acceptance", NS))
        conn.execute("UPDATE v8_record_scopes SET scope_key=? WHERE record_kind=?", (scopes.acceptance_scope(NS).key, kind))
    with pytest.raises(ValueError, match="cross-scope write forbidden"):
        getattr(v8_repo, "save_" + kind)(chain[kind])


def test_normal_child_cannot_reuse_sanitized_acceptance_roots_or_send_notifications(business_db):
    path, chain = business_db
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_v8_record_scopes_update")
        conn.execute("INSERT INTO v8_repository_scopes VALUES(?,?,?)", (scopes.acceptance_scope(NS).key, "acceptance", NS))
        conn.execute("UPDATE v8_record_scopes SET scope_key=?", (scopes.acceptance_scope(NS).key,))
    child = build_decision_snapshot(chain["evidence"], chain["holding"], chain["policy"], strategy_version="another-business-v1", created_at=verification.FIXTURE_TIME)
    with pytest.raises(ValueError, match="cross-scope write forbidden"):
        v8_repo.save_decision(child)
    with pytest.raises(ValueError, match="cross-scope write forbidden"):
        v8_repo.record_notification_event(decision_id=chain["decision"].decision_id,
            scheduled_window="2026-09-01T14:30+08:00", status="scheduled", attempt_no=0,
            natural_schedule=True, occurred_at=verification.FIXTURE_TIME)


@pytest.mark.parametrize("kind", KINDS)
def test_explicit_remote_acceptance_scope_rejects_business_payload_before_connection(monkeypatch, kind):
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    monkeypatch.setattr(db, "get_conn", lambda: pytest.fail("No remote connection allowed"))
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        getattr(v8_repo, "save_" + kind)(business_chain()[kind], scope=scopes.acceptance_scope(NS))


@pytest.mark.parametrize("components", ['not-json', '["ordinary-string"]', '[42]', '[null]', '[true]', '[[]]', '[{}]', '"string"'])
def test_malformed_or_scalar_portfolio_components_are_hidden_without_poisoning_reads(business_db, components):
    path, chain = business_db
    portfolio = wrapped_portfolio(chain)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO portfolio_decision_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            portfolio.portfolio_decision_id, portfolio.decision_date.isoformat(), portfolio.policy_version,
            portfolio.strategy_version, 1, 80, 80, None, components, "business",
            portfolio.created_at.isoformat(), canonical_json(portfolio), payload_sha256(v8_repo._portfolio_decision_identity(portfolio)),
        ))
    assert v8_repo.portfolio_decision_snapshots(limit=1) == []
    assert v8_repo.get_portfolio_decision(portfolio.portfolio_decision_id) is None
    assert v8_repo.settle_all_portfolio_outcomes(limit=1)["scanned"] == 0


def test_weakened_view_is_not_silently_repaired(business_db):
    path, _ = business_db
    with sqlite3.connect(path) as conn:
        conn.execute("DROP VIEW production_evidence_snapshots")
        conn.execute("CREATE VIEW production_evidence_snapshots AS SELECT *,rowid FROM evidence_snapshots")
    with pytest.raises(sqlite3.DatabaseError, match="scope definition mismatch"):
        db.init_db()


@pytest.fixture
def legacy_derived_db(tmp_path, monkeypatch):
    path = tmp_path / "legacy-derived.db"
    configure(path, monkeypatch)
    monkeypatch.setattr(v8_repo, "_now", lambda: SETTLED_AT)
    db.init_db()
    portfolio, _, _, decisions = _portfolio_snapshot()
    _insert_navs(db, _nav_rows(start_offset=0, stop_offset=125))
    for decision in decisions:
        assert v8_repo.settle_outcomes(decision.decision_id)
        v8_repo.record_notification_event(decision_id=decision.decision_id,
            scheduled_window="2026-08-25T14:30+08:00", status="scheduled", attempt_no=0,
            natural_schedule=True, occurred_at=decision.created_at)
    assert v8_repo.settle_portfolio_outcomes(portfolio.portfolio_decision_id)
    with sqlite3.connect(path) as conn:
        drop_scope_contract(conn)
    return path, portfolio


def test_schema8_to9_preserves_valid_derived_chains_and_defaults_remain_readable(legacy_derived_db):
    path, portfolio = legacy_derived_db
    tables = (*[table for table, _ in scopes.ROOTS.values()], "source_health_events", "outcome_evaluations",
              "portfolio_decision_snapshots", "portfolio_outcome_evaluations", "notification_events")
    with sqlite3.connect(path) as conn:
        before = {table: conn.execute("SELECT * FROM " + table).fetchall() for table in tables}
    db.init_db()
    with sqlite3.connect(path) as conn:
        assert {table: conn.execute("SELECT * FROM " + table).fetchall() for table in tables} == before
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
    assert v8_repo.get_portfolio_decision(portfolio.portfolio_decision_id) == portfolio
    assert len(v8_repo.portfolio_outcome_rows(portfolio.portfolio_decision_id)) == 3
    assert v8_repo.notification_events(portfolio.components[0].decision_id)


@pytest.mark.parametrize("table,payload_column", [
    ("source_health_events", "payload_json"), ("outcome_evaluations", "payload_json"),
    ("portfolio_decision_snapshots", "payload_json"), ("portfolio_outcome_evaluations", "payload_json"),
    ("notification_events", "detail_json"),
])
def test_schema8_malformed_derived_payload_refuses_whole_scope_migration(legacy_derived_db, table, payload_column):
    path, _ = legacy_derived_db
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_" + table + "_update")
        conn.execute(f"UPDATE {table} SET {payload_column}='not-json'")
        before = root_rows(conn)
    with pytest.raises(sqlite3.DatabaseError, match="scope lineage cannot be classified safely"):
        db.init_db()
    with sqlite3.connect(path) as conn:
        assert root_rows(conn) == before
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone()


@pytest.mark.parametrize("table,column,assignment", [
    ("source_health_events", "observed_at", "'2026-08-24T06:30:00+00:00'"),
    ("outcome_evaluations", "absolute_return", "99"),
    ("portfolio_decision_snapshots", "component_count", "1"),
    ("portfolio_outcome_evaluations", "absolute_return", "99"),
    ("notification_events", "natural_schedule", "0"),
])
def test_schema8_derived_projection_drift_refuses_scope_migration(legacy_derived_db, table, column, assignment):
    path, _ = legacy_derived_db
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_" + table + "_update")
        conn.execute(f"UPDATE {table} SET {column}={assignment}")
    with pytest.raises(sqlite3.DatabaseError, match="scope lineage cannot be classified safely"):
        db.init_db()
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone()


def test_cyclic_policy_and_descendants_are_hidden_then_migration_refuses_reclassification(business_db):
    path, chain = business_db
    policy = v8_repo.save_policy(next_policy(chain))
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_portfolio_policy_versions_update")
        conn.execute("UPDATE portfolio_policy_versions SET supersedes=? WHERE policy_version=?",
                     (policy.policy_version, chain["policy"].policy_version))
    assert v8_repo.read_policy_history() == []
    assert v8_repo.get_decision(chain["decision"].decision_id) is None
    with sqlite3.connect(path) as conn:
        drop_scope_contract(conn)
    with pytest.raises(sqlite3.DatabaseError, match="cannot be classified safely"):
        db.init_db()


def test_legacy_source_health_missing_event_refuses_incomplete_population(legacy_derived_db):
    path, _ = legacy_derived_db
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_source_health_events_delete")
        conn.execute("DELETE FROM source_health_events WHERE rowid=(SELECT MIN(rowid) FROM source_health_events)")
    with pytest.raises(sqlite3.DatabaseError, match="scope lineage cannot be classified safely"):
        db.init_db()
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone()


def test_existing_remote_schema_without_scope_requires_migration_and_remains_untouched(business_db, monkeypatch):
    path, _ = business_db
    with sqlite3.connect(path) as conn:
        drop_scope_contract(conn)
        conn.execute(turso_schema.VERSION_DDL)
        conn.execute("INSERT INTO _schema_version VALUES(1,8)")
        before = root_rows(conn)
    queries = []
    def connect():
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.set_trace_callback(queries.append)
        return conn
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    monkeypatch.setattr(db, "get_conn", connect)
    with pytest.raises(sqlite3.DatabaseError, match="Unsupported Turso schema version; migration required"):
        db.init_db()
    with connect() as conn:
        with pytest.raises(sqlite3.DatabaseError, match="Unsupported Turso schema version; migration required"):
            turso_schema.initialize_candidate(conn)
        assert root_rows(conn) == before
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone()
    assert all(query.lstrip().upper().startswith(("SELECT", "PRAGMA")) for query in queries)
