"""Actual fresh local SQLite Policy reads; no remote or release proof."""
from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest

from database import db
from models.v8 import PortfolioPolicy, canonical_json, payload_sha256, stable_id
from service import owner_policy_state as state, repository_scopes as scopes, v8_repo
from strategy.decision_v2 import build_portfolio_policy

T0 = datetime(2026, 10, 23, 6, tzinfo=timezone.utc)


@pytest.fixture
def policy_db(tmp_path, monkeypatch):
    path = tmp_path / "owner-policy-state.sqlite3"
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    return path


def policy(name, effective=T0, *, created=T0, supersedes=None, offset=False):
    value = build_portfolio_policy(name=name, source="policy-state-fixture",
        effective_at=effective, created_at=created, supersedes=supersedes)
    if offset:
        zone = timezone(timedelta(hours=8))
        value = PortfolioPolicy.model_validate({**value.model_dump(mode="python"),
            "effective_at": effective.astimezone(zone), "created_at": created.astimezone(zone)})
    assert value.policy_version == stable_id("pol", v8_repo._policy_identity(value))
    return value


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def image(path):
    with connect(path) as conn:
        return [tuple(row) for row in conn.execute("SELECT * FROM portfolio_policy_versions ORDER BY rowid")]


@pytest.mark.parametrize("entry", ["current", "history"])
def test_legacy_reads_order_valid_direct_non_utc_models_by_actual_instant(policy_db, entry):
    first = v8_repo.save_policy(policy("offset-first", offset=True))
    second = v8_repo.save_policy(policy("utc-second", T0 + timedelta(hours=1), supersedes=first.policy_version))
    before = image(policy_db)
    if entry == "current":
        assert v8_repo.read_policy(at=T0 + timedelta(hours=2)).policy_version == second.policy_version
    else:
        assert [row.policy_version for row in v8_repo.read_policy_history()] == [second.policy_version, first.policy_version]
    assert image(policy_db) == before


@pytest.mark.parametrize("explicit", [False, True])
def test_historical_lookup_is_not_a_claim_of_historical_database_contents(policy_db, monkeypatch, explicit):
    first = v8_repo.save_policy(policy("first"))
    v8_repo.save_policy(policy("created-later", T0 + timedelta(hours=2),
        created=T0 + timedelta(hours=1), supersedes=first.policy_version))
    monkeypatch.setattr(v8_repo, "_now", lambda: T0 + timedelta(hours=3))
    actual = v8_repo.read_policy(first.policy_version if explicit else None, at=T0)
    assert actual == first


def read(path, at=T0, **kwargs):
    with connect(path) as conn:
        return state.read_owner_policy_state(conn, observed_at=at, **kwargs)


def raw_insert(conn, model, scope=scopes.PRODUCTION):
    """Disposable fault/capacity fixture only; not an application writer."""
    conn.execute("INSERT INTO portfolio_policy_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        model.policy_version, model.name, canonical_json(model.target_allocations),
        canonical_json(model.target_ranges), model.max_single_fund_weight,
        model.max_theme_weight, model.rebalance_band, canonical_json(model.dca_rules),
        canonical_json(model.reduce_rules), canonical_json(model.sell_rules),
        model.effective_at.isoformat(), model.created_at.isoformat(), model.source,
        model.supersedes, canonical_json(model), payload_sha256(v8_repo._policy_identity(model))))
    scopes.register_record(conn, "policy", model.policy_version, scope)


def fault_update(path, sql, params=(), *, table="portfolio_policy_versions", foreign_keys=True):
    """Corrupt a disposable test database, then restore the exact guard DDL."""
    with connect(path) as conn:
        if not foreign_keys:
            conn.execute("PRAGMA foreign_keys=OFF")
        name = f"immutable_{table}_update"
        trigger = conn.execute("SELECT sql FROM sqlite_master WHERE name=?", (name,)).fetchone()[0]
        conn.execute("DROP TRIGGER " + name)
        conn.execute(sql, params)
        conn.execute(trigger)


def assert_unavailable(path, *, code="policy_state_unavailable", **kwargs):
    before = image(path)
    with pytest.raises(state.OwnerPolicyReadError) as caught:
        read(path, **kwargs)
    assert caught.value.code == code
    assert caught.value.status == 503
    assert image(path) == before


def test_empty_observation_is_null_without_default_schema_or_extra_connection(policy_db, monkeypatch):
    with connect(policy_db) as conn:
        statements = []
        conn.set_trace_callback(statements.append)
        before = conn.total_changes
        def forbidden(*args, **kwargs):
            raise AssertionError("read attempted to create a connection or default")
        monkeypatch.setattr(db, "get_conn", forbidden)
        monkeypatch.setattr(sqlite3, "connect", forbidden)
        monkeypatch.setattr(v8_repo, "ensure_default_policy", forbidden)
        snapshot = state.read_owner_policy_state(conn, observed_at=T0.astimezone(timezone(timedelta(hours=8))))
        assert snapshot.model_dump(mode="json") == {"schema_version": "owner-policy-state-1",
            "observed_at": "2026-10-23T06:00:00Z", "current": None,
            "next_effective_at": None, "history": []}
        assert conn.total_changes == before
        assert not conn.in_transaction
        assert sum(sql == "BEGIN" for sql in statements) == 1
        assert sum(sql == "COMMIT" for sql in statements) == 1
        assert not any(sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER")) for sql in statements)


def test_current_and_next_are_selected_at_exact_microseconds(policy_db):
    created = T0 - timedelta(days=1)
    first = v8_repo.save_policy(policy("first", created=created, offset=True))
    second = v8_repo.save_policy(policy("second", T0 + timedelta(microseconds=1), created=created,
        supersedes=first.policy_version))
    third = v8_repo.save_policy(policy("third", T0 + timedelta(microseconds=2), created=created,
        supersedes=second.policy_version))
    before = image(policy_db)
    early = read(policy_db, T0 - timedelta(microseconds=1))
    assert early.current is None and early.next_effective_at == T0
    exact = read(policy_db, T0 + timedelta(microseconds=1))
    assert exact.current == second
    assert exact.next_effective_at == third.effective_at
    assert exact.history == (third, second, first)
    final = read(policy_db, third.effective_at)
    assert final.current == third and final.next_effective_at is None
    assert image(policy_db) == before


def test_typed_null_zero_and_rule_values_survive_snapshot(policy_db):
    model = build_portfolio_policy(name="typed-values", source="policy-state-fixture",
        target_allocations={"000001": 0.0}, target_ranges={"000001": (0.0, 0.0)},
        max_single_fund_weight=None, max_theme_weight=None, rebalance_band=0.0,
        dca_rules={"minimum_confidence": 0, "optional": None},
        sell_rules={"require_structural_invalidation": False}, effective_at=T0, created_at=T0)
    v8_repo.save_policy(model)
    actual = read(policy_db).current
    assert actual == model
    assert actual.max_single_fund_weight is None and actual.max_theme_weight is None
    assert actual.rebalance_band == 0.0
    assert actual.target_allocations == {"000001": 0.0}
    assert actual.target_ranges == {"000001": (0.0, 0.0)}
    assert actual.dca_rules == {"minimum_confidence": 0, "optional": None}
    assert actual.sell_rules["require_structural_invalidation"] is False


@pytest.mark.parametrize("fault", ["sha", "id", "extra", "duplicate", "name", "range", "numeric-null", "numeric-blob", "supersedes-blob", "time", "unaware-time"])
def test_immutable_id_digest_payload_and_every_projection_are_cross_checked(policy_db, fault):
    model = v8_repo.save_policy(policy("valid"))
    if fault == "sha":
        sql, params = "UPDATE portfolio_policy_versions SET payload_sha256=?", ("0" * 64,)
    elif fault == "id":
        changed = model.model_copy(update={"name": "different-content"})
        sql, params = "UPDATE portfolio_policy_versions SET name=?,payload_json=?,payload_sha256=?", (
            changed.name, canonical_json(changed), payload_sha256(v8_repo._policy_identity(changed)))
    elif fault == "extra":
        sql, params = "UPDATE portfolio_policy_versions SET payload_json=?", (canonical_json({**model.model_dump(mode="python"), "extra": 1}),)
    elif fault == "duplicate":
        sql, params = "UPDATE portfolio_policy_versions SET payload_json=?", (canonical_json(model)[:-1] + ',"name":"valid"}',)
    elif fault == "name":
        sql, params = "UPDATE portfolio_policy_versions SET name='wrong'", ()
    elif fault == "range":
        sql, params = "UPDATE portfolio_policy_versions SET target_ranges_json='{\"x\":[0,1]}'", ()
    elif fault == "numeric-null":
        sql, params = "UPDATE portfolio_policy_versions SET rebalance_band=0", ()
    elif fault == "numeric-blob":
        sql, params = "UPDATE portfolio_policy_versions SET max_theme_weight=x'01'", ()
    elif fault == "supersedes-blob":
        sql, params = "UPDATE portfolio_policy_versions SET supersedes=x'01'", ()
    elif fault == "time":
        sql, params = "UPDATE portfolio_policy_versions SET effective_at=?", ((T0 + timedelta(microseconds=1)).isoformat(),)
    else:
        sql, params = "UPDATE portfolio_policy_versions SET created_at='2026-10-23T06:00:00'", ()
    fault_update(policy_db, sql, params, foreign_keys=fault != "supersedes-blob")
    assert_unavailable(policy_db)


@pytest.mark.parametrize("fault", ["second-root", "fork", "missing-parent", "equal-effective", "earlier-effective", "earlier-created", "cross-scope-parent"])
def test_complete_same_scope_chain_is_required_even_when_production_view_hides_faults(policy_db, fault):
    first = v8_repo.save_policy(policy("first"))
    if fault == "second-root":
        child = policy("other-root", T0 + timedelta(hours=1))
    elif fault == "missing-parent":
        child = policy("orphan", T0 + timedelta(hours=1), supersedes="pol_" + "0" * 64)
    elif fault == "equal-effective":
        child = policy("equal", T0, supersedes=first.policy_version)
    elif fault == "earlier-effective":
        child = policy("earlier", T0 - timedelta(microseconds=1), supersedes=first.policy_version)
    elif fault == "earlier-created":
        child = policy("old-created", T0 + timedelta(hours=1), created=T0 - timedelta(microseconds=1), supersedes=first.policy_version)
    elif fault == "cross-scope-parent":
        acceptance = scopes.acceptance_scope("v9-acceptance-policy-test")
        with connect(policy_db) as conn:
            parent = policy("acceptance-root")
            raw_insert(conn, parent, acceptance)
        child = policy("bad-ancestor", T0 + timedelta(hours=1), supersedes=parent.policy_version)
    else:
        sibling = v8_repo.save_policy(policy("successor", T0 + timedelta(hours=1), supersedes=first.policy_version))
        child = policy("fork", T0 + timedelta(hours=2), supersedes=first.policy_version)
        assert sibling.supersedes == first.policy_version
    with connect(policy_db) as conn:
        if fault == "missing-parent":
            conn.execute("PRAGMA foreign_keys=OFF")
        raw_insert(conn, child)
    assert_unavailable(policy_db, at=T0 + timedelta(hours=3))


def test_production_scope_is_filtered_before_payload_limits_and_selected_scope_is_explicit(policy_db, monkeypatch):
    first = v8_repo.save_policy(policy("business"))
    scope = scopes.acceptance_scope("v9-acceptance-policy-test")
    with connect(policy_db) as conn:
        acceptance = policy("isolated")
        raw_insert(conn, acceptance, scope)
    monkeypatch.setattr(state, "MAX_POLICY_VERSIONS", 1)
    assert read(policy_db).history == (first,)
    assert read(policy_db, scope=scope).history == (acceptance,)
    fault_update(policy_db, "UPDATE portfolio_policy_versions SET payload_json=? WHERE policy_version=?",
        ("x" * (state.MAX_POLICY_BYTES + 1), acceptance.policy_version))
    assert read(policy_db).current == first
    assert_unavailable(policy_db, scope=scope, code="policy_state_capacity_exhausted")


@pytest.mark.parametrize("fault", ["missing-registration", "missing-metadata", "reserved-provenance"])
def test_scope_ownership_is_never_inferred_or_backfilled(policy_db, fault):
    model = v8_repo.save_policy(policy("business"))
    if fault == "missing-registration":
        with connect(policy_db) as conn:
            trigger = conn.execute("SELECT sql FROM sqlite_master WHERE name='immutable_v8_record_scopes_delete'").fetchone()[0]
            conn.execute("DROP TRIGGER immutable_v8_record_scopes_delete")
            conn.execute("DELETE FROM v8_record_scopes WHERE record_kind='policy'")
            conn.execute(trigger)
    elif fault == "missing-metadata":
        # An absent selected scope is not an empty, trustworthy timeline.
        assert_unavailable(policy_db, scope=scopes.acceptance_scope("v9-acceptance-absent"))
        return
    else:
        reserved = build_portfolio_policy(name="reserved", source="synthetic:v9-acceptance-reserved",
            effective_at=T0 + timedelta(hours=1), created_at=T0, supersedes=model.policy_version)
        with connect(policy_db) as conn:
            raw_insert(conn, reserved)
    assert_unavailable(policy_db, at=T0 + timedelta(hours=2))


def test_all_1000_versions_are_returned_and_1001_is_rejected_not_truncated(policy_db):
    previous = None
    with connect(policy_db) as conn:
        for index in range(1001):
            model = policy(f"version-{index}", T0 + timedelta(microseconds=index), supersedes=previous)
            if index == 1000:
                overflow = model
                break
            raw_insert(conn, model)
            previous = model.policy_version
    snapshot = read(policy_db, T0 + timedelta(seconds=1))
    assert len(snapshot.history) == 1000
    assert snapshot.history[0].name == "version-999" and snapshot.history[-1].name == "version-0"
    with connect(policy_db) as conn:
        raw_insert(conn, overflow)
    assert_unavailable(policy_db, code="policy_state_capacity_exhausted", at=T0 + timedelta(seconds=1))


def test_payload_and_final_wire_have_real_two_mib_limit(policy_db):
    large = build_portfolio_policy(name="large", source="policy-state-fixture",
        dca_rules={"body": "x" * (state.MAX_POLICY_BYTES // 2)}, effective_at=T0, created_at=T0)
    v8_repo.save_policy(large)
    # One valid model is below 2MiB, but current+history cannot exceed wire cap.
    assert len(canonical_json(large).encode()) < state.MAX_POLICY_BYTES
    assert_unavailable(policy_db, code="policy_state_capacity_exhausted")


@pytest.mark.parametrize("fault", ["old-version", "foreign-keys", "missing-trigger", "altered-view", "active-transaction", "temp", "attached"])
def test_existing_local_connection_contract_is_not_initialized_or_repaired(policy_db, fault):
    with connect(policy_db) as conn:
        if fault == "old-version":
            conn.execute("PRAGMA user_version=8")
        elif fault == "foreign-keys":
            conn.execute("PRAGMA foreign_keys=OFF")
        elif fault == "missing-trigger":
            conn.execute("DROP TRIGGER immutable_portfolio_policy_versions_update")
        elif fault == "altered-view":
            conn.execute("DROP VIEW production_portfolio_policy_versions")
            conn.execute("CREATE VIEW production_portfolio_policy_versions AS SELECT * FROM portfolio_policy_versions")
        elif fault == "active-transaction":
            conn.execute("BEGIN")
        elif fault == "temp":
            conn.execute("CREATE TEMP TABLE shadow_policy(value)")
        else:
            conn.execute("ATTACH DATABASE ':memory:' AS other")
        before = conn.total_changes
        with pytest.raises(state.OwnerPolicyReadError, match="策略版本状态"):
            state.read_owner_policy_state(conn, observed_at=T0)
        assert conn.total_changes == before
        assert conn.in_transaction is (fault == "active-transaction")


@pytest.mark.parametrize("bad", [datetime(2026, 10, 23), "2026-10-23T06:00:00Z", 0])
def test_unaware_or_non_datetime_observation_is_rejected(policy_db, bad):
    assert_unavailable(policy_db, at=bad)


def test_new_state_rejects_real_future_created_policy(policy_db):
    v8_repo.save_policy(policy("future-created", created=T0 + timedelta(microseconds=1)))
    assert_unavailable(policy_db)


def test_one_read_transaction_keeps_snapshot_when_another_connection_appends(policy_db):
    first = v8_repo.save_policy(policy("before"))
    second = policy("after", T0 + timedelta(hours=1), supersedes=first.policy_version)
    with connect(policy_db) as conn:
        inserted = False
        def guard():
            nonlocal inserted
            if conn.in_transaction and not inserted:
                v8_repo.save_policy(second)
                inserted = True
        snapshot = state.read_owner_policy_state(conn, observed_at=T0 + timedelta(hours=2), before_return=guard)
        assert inserted and snapshot.history == (first,)
    assert read(policy_db, T0 + timedelta(hours=2)).history == (second, first)


def test_callback_failure_keeps_original_authority_error_and_rolls_back(policy_db):
    with connect(policy_db) as conn:
        calls = 0
        denial = PermissionError("session revoked")
        def guard():
            nonlocal calls
            calls += 1
            if conn.in_transaction:
                raise denial
        with pytest.raises(PermissionError) as caught:
            state.read_owner_policy_state(conn, observed_at=T0, before_return=guard)
        assert caught.value is denial and calls >= 2 and not conn.in_transaction


@pytest.mark.parametrize("fault", ["callback-budget", "clock-backwards", "non-finite", "post-commit"])
def test_budget_includes_authorization_callback_and_post_commit(policy_db, monkeypatch, fault):
    clock = [10.0]
    monkeypatch.setattr(state.time, "monotonic", lambda: clock[0])
    with connect(policy_db) as conn:
        def guard():
            if fault == "callback-budget":
                clock[0] = 22.0
            elif fault == "clock-backwards":
                clock[0] = 9.0
            elif fault == "non-finite":
                clock[0] = float("nan")
        if fault == "post-commit":
            conn.set_trace_callback(lambda sql: clock.__setitem__(0, 22.0) if sql == "COMMIT" else None)
        with pytest.raises(state.OwnerPolicyReadError) as caught:
            state.read_owner_policy_state(conn, observed_at=T0, before_return=guard)
        assert caught.value.code == "policy_state_timeout"
        assert not conn.in_transaction
