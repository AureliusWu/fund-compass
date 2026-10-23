"""Caller-owned transactions on fresh synthetic SQLite only; no cloud evidence."""
from datetime import datetime, timedelta, timezone
import sqlite3

import pytest

from database import db
from models.api import V8DecisionItem
from models.v8 import DecisionSnapshot, HoldingVersion, canonical_json, payload_sha256, stable_id
from service import repository_scopes as scopes, v8_decisions, v8_repo
from strategy.decision_v2 import build_decision_snapshot, build_evidence_snapshot, build_holding_version, build_portfolio_policy


T0 = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)
T1 = T0 + timedelta(hours=1)
T2 = T1 + timedelta(hours=1)
TABLES = ("holding_versions", "decision_snapshots", "v8_repository_scopes", "v8_record_scopes")


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    return conn


def rows(path):
    conn = connect(path)
    try:
        return {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                for table in TABLES}
    finally:
        conn.close()


def holding(*, created_at=T1, updated_at=T0, source="atomic-pair-fixture"):
    return build_holding_version(
        "510300", is_held=True, shares=10, cost=1, market_value=15,
        account="fictional-account", current_weight=15, target_weight=20,
        updated_at=updated_at, source=source, created_at=created_at,
    )


def changed_decision(snapshot, **updates):
    candidate = snapshot.model_copy(update=updates)
    return candidate.model_copy(update={
        "decision_id": stable_id("dec", v8_repo._decision_identity(candidate)),
    })


@pytest.fixture
def atomic_db(tmp_path, monkeypatch):
    path = tmp_path / "atomic-pair.sqlite3"
    assert not path.exists()
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    evidence = build_evidence_snapshot(
        {"code": "510300", "name": "Fictional fund", "type": "指数型",
         "latest_nav": 1.5, "latest_nav_date": "2026-08-25", "source": "atomic-fixture",
         "updated_at": T0.isoformat(),
         "decision_context": {"status": "unavailable", "source": "atomic-fixture"}},
        {"score": 82, "score_version": "atomic-fixture", "coverage": 1.0},
        {"signal": "持有", "signal_version": "atomic-fixture", "coverage": 1.0,
         "layers": {"valuation": {"percentile": 20}, "trend": {"label": "上升趋势"}}},
        {"available": False}, created_at=T0,
    )
    policy = build_portfolio_policy(
        name="Atomic fixture guardrails", target_allocations={"510300": 20},
        max_single_fund_weight=40, rebalance_band=2, effective_at=T0,
        source="atomic-fixture", created_at=T0,
    )
    return path, v8_repo.save_evidence(evidence), v8_repo.save_policy(policy)


def test_pair_uses_one_caller_transaction_and_commits_for_independent_readback(atomic_db, monkeypatch):
    path, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    before = rows(path)

    def forbidden_connection(*_args, **_kwargs):
        pytest.fail("in-transaction kernels must not obtain a global connection")

    monkeypatch.setattr(db, "get_conn", forbidden_connection)
    monkeypatch.setattr(db, "transaction", forbidden_connection)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        assert v8_repo._save_holding_in_transaction(conn, candidate) == candidate
        assert v8_repo._save_decision_in_transaction(conn, decision) == decision
        assert conn.in_transaction is True
        assert rows(path) == before  # Neither kernel committed the caller's work.
        conn.commit()
    finally:
        conn.close()
    reader = connect(path)
    try:
        assert HoldingVersion.model_validate_json(reader.execute(
            "SELECT payload_json FROM holding_versions WHERE holding_version=?", (candidate.holding_version,),
        ).fetchone()[0]) == candidate
        assert DecisionSnapshot.model_validate_json(reader.execute(
            "SELECT payload_json FROM decision_snapshots WHERE decision_id=?", (decision.decision_id,),
        ).fetchone()[0]) == decision
        registered = {(row[0], row[1], row[2]) for row in reader.execute(
            "SELECT record_kind,record_id,scope_key FROM v8_record_scopes",
        )}
        assert ("holding", candidate.holding_version, "production") in registered
        assert ("decision", decision.decision_id, "production") in registered
    finally:
        reader.close()


@pytest.mark.parametrize("failure", ["missing_evidence", "fund_mismatch", "future_holding", "future_evidence", "future_policy"])
def test_decision_validation_failure_leaves_rollback_to_caller_and_restores_all_rows(atomic_db, failure):
    path, evidence, policy = atomic_db
    candidate = holding(updated_at=T2 if failure == "future_holding" else T0)
    if failure == "future_evidence":
        evidence = evidence.model_copy(update={"created_at": T2, "fund_name": "Future fictional evidence"})
        evidence = evidence.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(evidence))})
        v8_repo.save_evidence(evidence)
    if failure == "future_policy":
        policy = v8_repo.save_policy(build_portfolio_policy(
            name="Future fictional policy", effective_at=T2, created_at=T0,
            source="atomic-fixture", supersedes=policy.policy_version,
        ))
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    if failure == "missing_evidence":
        decision = changed_decision(decision, evidence_id="ev_" + "f" * 64)
    if failure == "fund_mismatch":
        decision = changed_decision(decision, fund_code="510500")
    before = rows(path)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        v8_repo._save_holding_in_transaction(conn, candidate)
        with pytest.raises((LookupError, ValueError)):
            v8_repo._save_decision_in_transaction(conn, decision)
        assert conn.in_transaction is True
        assert conn.execute("SELECT COUNT(*) FROM holding_versions WHERE holding_version=?",
                            (candidate.holding_version,)).fetchone()[0] == 1
        conn.rollback()
    finally:
        conn.close()
    assert rows(path) == before


def test_failure_after_decision_and_scope_insert_rolls_back_the_complete_pair(atomic_db, monkeypatch):
    path, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    before = rows(path)
    register = scopes.register_record

    def fail_after_registration(conn, kind, identifier, scope):
        register(conn, kind, identifier, scope)
        if kind == "decision":
            raise RuntimeError("synthetic-post-registration-fault")

    monkeypatch.setattr(scopes, "register_record", fail_after_registration)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        v8_repo._save_holding_in_transaction(conn, candidate)
        with pytest.raises(RuntimeError, match="synthetic-post-registration-fault"):
            v8_repo._save_decision_in_transaction(conn, decision)
        assert conn.in_transaction is True
        assert conn.execute("SELECT COUNT(*) FROM decision_snapshots").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM v8_record_scopes WHERE record_kind IN ('holding','decision')").fetchone()[0] == 2
        conn.rollback()
    finally:
        conn.close()
    assert rows(path) == before


def test_idempotent_pair_keeps_first_created_at_and_payload(atomic_db):
    path, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        v8_repo._save_holding_in_transaction(conn, candidate)
        v8_repo._save_decision_in_transaction(conn, decision)
        conn.commit()
        before = rows(path)
        conn.execute("BEGIN IMMEDIATE")
        assert v8_repo._save_holding_in_transaction(conn, candidate.model_copy(update={"created_at": T2})) == candidate
        assert v8_repo._save_decision_in_transaction(conn, decision.model_copy(update={"created_at": T2})) == decision
        assert conn.in_transaction is True
        conn.commit()
        assert rows(path) == before
    finally:
        conn.close()


def test_existing_decision_output_conflict_rolls_back_other_staged_holding(atomic_db):
    path, evidence, policy = atomic_db
    original = v8_repo.save_holding(holding())
    decision = v8_repo.save_decision(build_decision_snapshot(evidence, original, policy, created_at=T1))
    before = rows(path)
    staged = holding(source="separate-atomic-fixture")
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        v8_repo._save_holding_in_transaction(conn, staged)
        with pytest.raises(v8_repo.SnapshotConflictError, match="different output"):
            v8_repo._save_decision_in_transaction(conn, decision.model_copy(update={"summary": "Different fictional output"}))
        assert conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()
    assert rows(path) == before


def test_different_requested_scope_is_rejected_without_partial_pair(atomic_db):
    path, _, _ = atomic_db
    before = rows(path)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
            v8_repo._save_holding_in_transaction(conn, holding(), scope=scopes.acceptance_scope("v9-acceptance-atomic-pair"))
        assert conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()
    assert rows(path) == before


def test_cross_scope_evidence_reference_rejects_and_rolls_back_staged_holding(atomic_db):
    path, evidence, policy = atomic_db
    other = evidence.model_copy(update={"fund_name": "Other synthetic scope", "source_states": [], "evidence_nodes": []})
    other = other.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(other))})
    conn = connect(path)
    try:
        # Raw seeding is confined to this fresh fixture; production writers
        # remain forbidden from inventing or adopting acceptance provenance.
        stored = dict(conn.execute("SELECT * FROM evidence_snapshots WHERE evidence_id=?", (evidence.evidence_id,)).fetchone())
        stored.update(evidence_id=other.evidence_id, fund_name=other.fund_name, source_states_json="[]",
                      evidence_nodes_json="[]", payload_json=canonical_json(other),
                      payload_sha256=payload_sha256(v8_repo._evidence_identity(other)))
        columns = list(stored)
        conn.execute("INSERT INTO evidence_snapshots(" + ",".join(columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")",
                     tuple(stored[column] for column in columns))
        scopes.register_record(conn, "evidence", other.evidence_id, scopes.acceptance_scope("v9-acceptance-atomic-pair"))
        conn.commit()
        before = rows(path)
        candidate = holding()
        decision = build_decision_snapshot(other, candidate, policy, created_at=T1)
        conn.execute("BEGIN IMMEDIATE")
        v8_repo._save_holding_in_transaction(conn, candidate)
        with pytest.raises(ValueError, match="cross-scope"):
            v8_repo._save_decision_in_transaction(conn, decision)
        assert conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()
    assert rows(path) == before


@pytest.mark.parametrize("kernel", ["holding", "decision"])
def test_kernel_requires_existing_transaction_before_any_sql_or_write(atomic_db, kernel):
    path, evidence, policy = atomic_db
    candidate = holding()
    value = candidate if kernel == "holding" else build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    save = v8_repo._save_holding_in_transaction if kernel == "holding" else v8_repo._save_decision_in_transaction
    before = rows(path)
    conn = connect(path)
    executed = []
    conn.set_trace_callback(executed.append)
    try:
        assert conn.in_transaction is False
        with pytest.raises(ValueError, match="active_transaction_required"):
            save(conn, value)
        assert executed == [] and conn.in_transaction is False
    finally:
        conn.close()
    assert rows(path) == before


def test_kernels_accept_connection_protocol_without_owning_its_lifecycle(atomic_db):
    path, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    conn = connect(path)

    class TransactionView:
        @property
        def in_transaction(self):
            return conn.in_transaction

        def execute(self, *args):
            return conn.execute(*args)

        def commit(self):
            pytest.fail("kernel cannot commit")

        def rollback(self):
            pytest.fail("kernel cannot roll back")

        def close(self):
            pytest.fail("kernel cannot close")

    try:
        conn.execute("BEGIN IMMEDIATE")
        view = TransactionView()
        assert v8_repo._save_holding_in_transaction(view, candidate) == candidate
        assert v8_repo._save_decision_in_transaction(view, decision) == decision
        assert conn.in_transaction is True
        conn.rollback()
    finally:
        conn.close()


def test_public_wrappers_still_commit_and_replay_original_models(atomic_db):
    path, evidence, policy = atomic_db
    candidate = v8_repo.save_holding(holding())
    decision = v8_repo.save_decision(build_decision_snapshot(evidence, candidate, policy, created_at=T1))
    before = rows(path)
    assert v8_repo.save_holding(candidate.model_copy(update={"created_at": T2})) == candidate
    assert v8_repo.save_decision(decision.model_copy(update={"created_at": T2})) == decision
    assert v8_repo.get_holding(candidate.holding_version) == candidate
    assert v8_repo.get_decision(decision.decision_id) == decision
    assert rows(path) == before


def test_public_pair_commits_and_returns_first_stored_models(atomic_db):
    path, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    assert v8_repo.save_holding_and_decision(candidate, decision) == (candidate, decision)
    before = rows(path)
    assert v8_repo.save_holding_and_decision(
        candidate.model_copy(update={"created_at": T2}), decision.model_copy(update={"created_at": T2}),
    ) == (candidate, decision)
    assert rows(path) == before


def test_public_pair_rolls_back_both_roots_and_scopes_on_decision_failure(atomic_db, monkeypatch):
    path, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    before = rows(path)
    register = scopes.register_record

    def fail_after_decision_scope(conn, kind, identifier, scope):
        register(conn, kind, identifier, scope)
        if kind == "decision":
            raise RuntimeError("synthetic-pair-write-fault")

    monkeypatch.setattr(scopes, "register_record", fail_after_decision_scope)
    with pytest.raises(RuntimeError, match="synthetic-pair-write-fault"):
        v8_repo.save_holding_and_decision(candidate, decision)
    assert rows(path) == before


@pytest.mark.parametrize("mismatch", ["holding_id", "fund_code"])
def test_public_pair_rejects_pair_mismatch_before_opening_connection(atomic_db, monkeypatch, mismatch):
    _, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)
    decision = changed_decision(decision, **(
        {"holding_version": "hold_" + "f" * 64} if mismatch == "holding_id" else {"fund_code": "510500"}
    ))

    def forbidden_connection(*_args, **_kwargs):
        pytest.fail("mismatched pair must fail before opening a connection")

    monkeypatch.setattr(db, "transaction", forbidden_connection)
    monkeypatch.setattr(db, "get_conn", forbidden_connection)
    with pytest.raises(ValueError, match="pair references must match"):
        v8_repo.save_holding_and_decision(candidate, decision)


def service_input():
    detail = {
        "code": "510300", "name": "Atomic service fixture", "type": "指数型",
        "latest_nav": 1.5, "latest_nav_date": "2026-08-25", "source": "atomic-service-fixture",
        "updated_at": T0.isoformat(), "nav_history": [],
    }
    item = V8DecisionItem.model_validate({
        "code": "510300", "holding": {"is_held": True, "shares": 10, "cost": 1,
        "market_value": 15, "account": "fictional-account", "current_weight": 15,
        "target_weight": 20, "updated_at": T0, "source": "atomic-pair-fixture"},
    })
    return detail, item


def test_real_create_decision_uses_pair_and_returns_actual_first_holding(atomic_db):
    _, _, policy = atomic_db
    first = v8_repo.save_holding(holding())
    detail, item = service_input()
    result = v8_decisions.create_decision(detail, item, policy=policy, created_at=T2)
    assert result["holding"] == first.model_dump(mode="json")
    assert result["decision"]["holding_version"] == first.holding_version
    assert v8_repo.get_decision(result["decision"]["decision_id"]).model_dump(mode="json") == result["decision"]


def test_real_create_decision_sql_failure_keeps_old_chain_without_new_holding_decision_scopes(atomic_db, monkeypatch):
    path, evidence, policy = atomic_db
    first = holding()
    original = build_decision_snapshot(evidence, first, policy, created_at=T1)
    v8_repo.save_holding_and_decision(first, original)
    before = rows(path)
    detail, item = service_input()
    # A different valid holding would be left behind by the old two-write flow.
    item = item.model_copy(update={"holding": item.holding.model_copy(update={"shares": 12})})
    get_conn = db.get_conn

    def deny_decision_insert():
        conn = get_conn()

        def authorize(action, table, _column, _database, _trigger):
            return sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_INSERT and table == "decision_snapshots" else sqlite3.SQLITE_OK

        conn.set_authorizer(authorize)
        return conn

    monkeypatch.setattr(db, "get_conn", deny_decision_insert)
    with pytest.raises(sqlite3.DatabaseError):
        v8_decisions.create_decision(detail, item, policy=policy, created_at=T2)
    after = rows(path)
    assert after["holding_versions"] == before["holding_versions"]
    assert after["decision_snapshots"] == before["decision_snapshots"]
    root_scopes = lambda values: [row for row in values if row[0] in ("holding", "decision")]
    assert root_scopes(after["v8_record_scopes"]) == root_scopes(before["v8_record_scopes"])
    assert after["v8_repository_scopes"] == before["v8_repository_scopes"]
    assert v8_repo.get_holding(first.holding_version) == first
    assert v8_repo.get_decision(original.decision_id) == original
    # Evidence is intentionally saved first and is outside the pair's boundary.
    conn = connect(path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM evidence_snapshots").fetchone()[0] >= 2
    finally:
        conn.close()


@pytest.mark.parametrize("invalid", ["holding_id", "decision_id", "decision_output"])
def test_public_prevalidation_still_rejects_before_opening_connection(atomic_db, monkeypatch, invalid):
    _, evidence, policy = atomic_db
    candidate = holding()
    decision = build_decision_snapshot(evidence, candidate, policy, created_at=T1)

    def forbidden_connection(*_args, **_kwargs):
        pytest.fail("invalid public input must fail before opening a connection")

    monkeypatch.setattr(db, "transaction", forbidden_connection)
    monkeypatch.setattr(db, "get_conn", forbidden_connection)
    with pytest.raises((ValueError, v8_repo.SnapshotConflictError)):
        if invalid == "holding_id":
            v8_repo.save_holding(candidate.model_copy(update={"holding_version": "hold_" + "f" * 64}))
        elif invalid == "decision_id":
            v8_repo.save_decision(decision.model_copy(update={"decision_id": "dec_" + "f" * 64}))
        else:
            v8_repo.save_decision(decision.model_copy(update={"confidence": float("inf")}))
