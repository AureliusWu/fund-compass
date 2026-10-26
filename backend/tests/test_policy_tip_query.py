"""Semantic regression matrix for the fixed Policy-tip SQL on real schema 9.

Fault rows below use direct SQL only in a disposable local database. Query
equivalence does not make those rows valid application writes, repair hidden
chain corruption, grant acceptance writes or claim provider/cloud evidence.
No timing, query-plan or performance thresholds are asserted here.
"""
from collections import Counter
from contextlib import closing
from datetime import datetime, timedelta, timezone
import sqlite3

import pytest

from database import db
from models.v8 import canonical_json, payload_sha256
from service import owner_policy_state, repository_scopes as scopes, v8_repo
from strategy.decision_v2 import build_portfolio_policy


AT = datetime(2026, 10, 26, tzinfo=timezone.utc)
ACCEPTANCE = scopes.acceptance_scope("v9-acceptance-tip-query")
UNCHANGED = object()


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@pytest.fixture
def local_db(tmp_path, monkeypatch):
    path = tmp_path / "actual-schema9-policy-tip-query.sqlite3"
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with closing(connect(path)) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
        assert scopes.schema_errors(conn) == []
    return path


def legacy_policy_tips_query(scope):
    """Frozen prior correlated NOT EXISTS query, not the candidate helper."""
    scope = scopes.validate_scope(scope)
    table = scopes.production_table(scopes.ROOTS["policy"][0]) if scope == scopes.PRODUCTION else scopes.ROOTS["policy"][0]
    return (f"SELECT p.payload_json FROM {table} p JOIN {scopes.RECORD_TABLE} ps "
            "ON ps.record_kind='policy' AND ps.record_id=p.policy_version "
            "WHERE ps.scope_key=? AND NOT EXISTS (SELECT 1 FROM portfolio_policy_versions child "
            f"JOIN {scopes.RECORD_TABLE} cs ON cs.record_kind='policy' AND cs.record_id=child.policy_version "
            "WHERE child.supersedes=p.policy_version AND cs.scope_key=?)", (scope.key, scope.key))


def raw_insert(conn, model, scope, *, supersedes_column=UNCHANGED):
    """Test-only raw seeding deliberately bypasses repository write authority."""
    parent = model.supersedes if supersedes_column is UNCHANGED else supersedes_column
    conn.execute("INSERT INTO portfolio_policy_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        model.policy_version, model.name, canonical_json(model.target_allocations),
        canonical_json(model.target_ranges), model.max_single_fund_weight, model.max_theme_weight,
        model.rebalance_band, canonical_json(model.dca_rules), canonical_json(model.reduce_rules),
        canonical_json(model.sell_rules), model.effective_at.isoformat(), model.created_at.isoformat(),
        model.source, parent, canonical_json(model), payload_sha256(v8_repo._policy_identity(model)),
    ))
    if scope is not None:
        scopes.register_record(conn, "policy", model.policy_version, scope)


def image(path):
    with closing(connect(path)) as conn:
        return (tuple(tuple(row) for row in conn.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")),
                *(tuple(tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid"))
                  for table in ("portfolio_policy_versions", scopes.SCOPE_TABLE, scopes.RECORD_TABLE)))


def layout(conn, case, selected):
    other = ACCEPTANCE if selected == scopes.PRODUCTION else scopes.PRODUCTION
    made = []

    def model(label, *, parent=None, source="policy-tip-query-fixture"):
        result = build_portfolio_policy(
            name=case + ":" + label, source=source,
            effective_at=AT + timedelta(minutes=len(made)), created_at=AT,
            supersedes=parent.policy_version if parent else None,
        )
        made.append(result)
        return result

    def add(label, *, parent=None, owner=UNCHANGED, source="policy-tip-query-fixture"):
        result = model(label, parent=parent, source=source)
        raw_insert(conn, result, selected if owner is UNCHANGED else owner)
        return result

    if case == "empty":
        return []
    if case == "only-unregistered-null-root":
        add("unregistered", owner=None)
        return []
    if case == "orphan-column":
        # Existing raw corruption: the production recursive view hides the
        # orphan, while the explicitly selected acceptance table does not.
        conn.execute("PRAGMA foreign_keys=OFF")
        orphan = model("orphan")
        raw_insert(conn, orphan, selected, supersedes_column="pol_" + "a" * 64)
        return [] if selected == scopes.PRODUCTION else [orphan]
    if case == "cycle-column-corruption":
        conn.execute("PRAGMA foreign_keys=OFF")
        first = model("cycle-a")
        second = model("cycle-b", parent=first)
        raw_insert(conn, first, selected, supersedes_column=second.policy_version)
        raw_insert(conn, second, selected)
        return []

    root = add("root", source="synthetic:v9-acceptance-raw-pollution" if case == "reserved-root" else "policy-tip-query-fixture")
    if case in ("null-root", "reserved-root"):
        return [root]
    if case == "two-null-roots":
        return [root, add("second-null-root")]
    if case == "foreign-null-root":
        add("other-scope-root", owner=other)
        return [root]
    if case == "unregistered-child":
        add("unregistered-child", parent=root, owner=None)
        return [root]
    if case == "foreign-child":
        add("other-scope-child", parent=root, owner=other)
        return [root]
    if case == "cross-scope-parent":
        foreign = add("other-scope-parent", owner=other)
        child = add("selected-child", parent=foreign)
        return [root] if selected == scopes.PRODUCTION else [root, child]
    child = add("child", parent=root,
                source="synthetic:v9-acceptance-raw-pollution" if case == "reserved-child" else "policy-tip-query-fixture")
    if case in ("chain", "reserved-child"):
        return [child]
    if case == "fork":
        return [child, add("fork-sibling", parent=root)]
    if case == "longer-chain-with-null-roots-in-subquery":
        add("unrelated-other-scope-null-root", owner=other)
        return [add("grandchild", parent=child)]
    raise AssertionError("Unknown exact SQL matrix case")


CASES = ("empty", "null-root", "two-null-roots", "chain", "foreign-null-root",
         "unregistered-child", "foreign-child", "cross-scope-parent", "only-unregistered-null-root",
         "fork", "longer-chain-with-null-roots-in-subquery", "reserved-root", "reserved-child",
         "orphan-column", "cycle-column-corruption")


@pytest.mark.parametrize("selected", [scopes.PRODUCTION, ACCEPTANCE], ids=["production", "acceptance"])
@pytest.mark.parametrize("case", CASES)
def test_fixed_null_filtered_query_preserves_the_prior_exact_scoped_payload_multiset(local_db, case, selected):
    with closing(connect(local_db)) as conn:
        expected = layout(conn, case, selected)
        conn.commit()
    before = image(local_db)
    old_sql, old_params = legacy_policy_tips_query(selected)
    new_sql, new_params = scopes.policy_tips_query(selected)
    assert new_params == old_params
    with closing(connect(local_db)) as conn:
        old = Counter(row[0] for row in conn.execute(old_sql, old_params))
        new = Counter(row[0] for row in conn.execute(new_sql, new_params))
        assert new == old == Counter(canonical_json(model) for model in expected)
        # Both callers still need only two rows to distinguish a unique tip
        # from ambiguity; the query does not promise a stable result order.
        assert len(conn.execute(new_sql + " LIMIT 2", new_params).fetchall()) == min(2, sum(old.values()))
    assert image(local_db) == before


@pytest.mark.parametrize("selected", [scopes.PRODUCTION, ACCEPTANCE], ids=["production", "acceptance"])
@pytest.mark.parametrize("case", ["two-null-roots", "fork"])
def test_real_tip_reader_still_rejects_multiple_scoped_tips_without_writing(local_db, case, selected):
    with closing(connect(local_db)) as conn:
        layout(conn, case, selected)
        conn.commit()
    before = image(local_db)
    with pytest.raises(v8_repo.SnapshotConflictError, match="multiple chain tips"):
        v8_repo.read_policy_tip(scope=selected)
    assert image(local_db) == before


@pytest.mark.parametrize("case", ["two-null-roots", "fork"])
def test_real_policy_writer_still_rejects_ambiguous_production_tips_in_its_transaction(local_db, case):
    with closing(connect(local_db)) as conn:
        tips = layout(conn, case, scopes.PRODUCTION)
        conn.commit()
    before = image(local_db)
    candidate = build_portfolio_policy(name="Must not append to ambiguous chain", source="admin",
                                       effective_at=AT + timedelta(days=1), created_at=AT,
                                       supersedes=tips[0].policy_version)
    with pytest.raises(v8_repo.SnapshotConflictError, match="multiple chain tips"):
        v8_repo.save_policy(candidate)
    assert image(local_db) == before


@pytest.mark.parametrize("case", ["reserved-root", "reserved-child"])
def test_raw_reserved_tip_visibility_is_not_misrepresented_as_write_or_owner_read_permission(local_db, case):
    with closing(connect(local_db)) as conn:
        tips = layout(conn, case, scopes.PRODUCTION)
        conn.commit()
    before = image(local_db)
    # This selected-tip reader, like the old SQL, is not a full provenance
    # audit. The real writer and strict Owner state reader remain independent.
    assert v8_repo.read_policy_tip() == tips[0]
    candidate = build_portfolio_policy(name="Normal candidate cannot reuse reserved root", source="admin",
                                       effective_at=AT + timedelta(days=1), created_at=AT,
                                       supersedes=tips[0].policy_version)
    with pytest.raises(ValueError, match="local_acceptance_write_forbidden"):
        v8_repo.save_policy(candidate)
    with closing(connect(local_db)) as conn:
        with pytest.raises(owner_policy_state.OwnerPolicyReadError):
            owner_policy_state.read_owner_policy_state(conn, observed_at=AT + timedelta(days=1))
    assert image(local_db) == before
