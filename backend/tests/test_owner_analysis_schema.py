"""Exact local-only analysis inventory; every database here is synthetic."""
import json
import sqlite3

import pytest

from database.owner_analysis_schema import (
    MAX_ANALYSIS_DOCUMENT_BYTES, MAX_ANALYSIS_REQUEST_BYTES,
    OWNER_ANALYSIS_DDL, OWNER_ANALYSIS_SCHEMA_VERSION, OWNER_ANALYSIS_TRIGGERS,
    provision_owner_analysis_candidate, verify_owner_analysis_schema,
    verify_owner_workspace_schema,
)
from database.owner_sync_schema import (
    MAX_SAFE_INTEGER, OWNER_SYNC_DDL, _SQLITE_STAT1_DDL, _UNIVERSE_IMPORT_STATE_DDL,
    provision_owner_sync_candidate, verify_owner_sync_schema,
)
from database.turso_schema import VERSION_DDL, expected_objects


def owner_connection(*, factory=sqlite3.Connection, with_owner=True):
    conn = sqlite3.connect(":memory:", factory=factory)
    conn.execute("PRAGMA foreign_keys=ON")
    for ddl in expected_objects().values():
        conn.execute(ddl)
    conn.execute("PRAGMA user_version=9")
    conn.commit()
    if with_owner:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
    return conn


@pytest.fixture
def candidate():
    conn = owner_connection()
    provision_owner_analysis_candidate(conn, synthetic_candidate=True)
    try:
        yield conn
    finally:
        conn.close()


def objects(conn):
    return conn.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall()


def insert_policy(conn):
    conn.execute("""INSERT INTO portfolio_policy_versions(
        policy_version,name,target_allocations_json,target_ranges_json,
        dca_rules_json,reduce_rules_json,sell_rules_json,effective_at,
        created_at,source,payload_json,payload_sha256
    ) VALUES('pol-synthetic','synthetic','{}','{}','{}','{}','{}',
             '2026-10-23T00:00:00Z','2026-10-23T00:00:00Z','synthetic','{}',?)""", ("a" * 64,))


def run_values(**changes):
    values = {
        "request_id": "synthetic-request-1", "request_hash": "a" * 64,
        "request_json": "{}", "run_id": "synthetic-run-1", "source_revision": 0,
        "source_hash": "b" * 64, "source_json": "{}", "policy_version": "pol-synthetic",
        "strategy_version": "synthetic-strategy", "created_at": "2026-10-23T00:00:00Z",
        "response_json": "{}", "response_hash": "c" * 64,
    }
    values.update(changes)
    return values


def insert_run(conn, **changes):
    values = run_values(**changes)
    conn.execute("INSERT INTO owner_analysis_runs(" + ",".join(values) + ") VALUES(" +
                 ",".join("?" for _ in values) + ")", tuple(values.values()))


def test_explicit_existing_owner_profile_extension_is_atomic_and_idempotent():
    conn = owner_connection()
    try:
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_analysis_candidate(conn)
        assert objects(conn) == before
        result = provision_owner_analysis_candidate(conn, synthetic_candidate=True)
        assert result == {"schema_version": OWNER_ANALYSIS_SCHEMA_VERSION,
                          "core_schema_version": 9, "changed": True, "synthetic_only": True}
        after = objects(conn)
        verify_owner_analysis_schema(conn)
        verify_owner_workspace_schema(conn)
        assert conn.execute("PRAGMA user_version").fetchone() == (9,)
        assert conn.execute("SELECT * FROM owner_sync_state").fetchall() == [(1, 0)]
        assert conn.execute("SELECT * FROM owner_analysis_schema").fetchall() == [(1, OWNER_ANALYSIS_SCHEMA_VERSION)]
        assert not provision_owner_analysis_candidate(conn, synthetic_candidate=True)["changed"]
        assert objects(conn) == after
        # The original public/packet profile is deliberately NOT widened.
        with pytest.raises(sqlite3.DatabaseError):
            verify_owner_sync_schema(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
    finally:
        conn.close()


def test_workspace_union_accepts_owner_only_but_analysis_requires_extension():
    conn = owner_connection()
    try:
        before = objects(conn)
        verify_owner_workspace_schema(conn)
        verify_owner_sync_schema(conn)
        with pytest.raises(sqlite3.DatabaseError):
            verify_owner_analysis_schema(conn)
        assert objects(conn) == before
    finally:
        conn.close()


def test_real_application_init_then_explicit_owner_and_analysis_provision(tmp_path, monkeypatch):
    from database import db

    # Exercise the real initializer and its PRAGMA optimize on an exclusively
    # synthetic file; do not replace startup with assembled reference DDL.
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "ephemeral")
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "synthetic-real-init.db"))
    db.init_db()
    conn = db.get_conn()
    try:
        before = objects(conn)
        assert provision_owner_sync_candidate(conn, synthetic_candidate=True)["changed"]
        verify_owner_sync_schema(conn)
        assert provision_owner_analysis_candidate(conn, synthetic_candidate=True)["changed"]
        verify_owner_analysis_schema(conn)
        after = objects(conn)
        assert set(before).issubset(set(after))
        assert not provision_owner_analysis_candidate(conn, synthetic_candidate=True)["changed"]
        assert objects(conn) == after
    finally:
        conn.close()


@pytest.mark.parametrize("operational", ["stat1", "universe", "both"])
def test_owner_preprovision_only_adds_the_fixed_engine_stat1_allowance(operational):
    conn = owner_connection(with_owner=False)
    try:
        if operational in ("universe", "both"):
            conn.execute(_UNIVERSE_IMPORT_STATE_DDL)
        if operational in ("stat1", "both"):
            conn.execute("ANALYZE")
        conn.commit()
        before = objects(conn)
        if operational in ("universe", "both"):
            # Do not widen the old application's unextended-core inventory.
            with pytest.raises(sqlite3.DatabaseError, match="contains unrecognized objects"):
                provision_owner_sync_candidate(conn, synthetic_candidate=True)
            assert objects(conn) == before
            return
        assert provision_owner_sync_candidate(conn, synthetic_candidate=True)["changed"]
        verify_owner_sync_schema(conn)
        assert provision_owner_analysis_candidate(conn, synthetic_candidate=True)["changed"]
        verify_owner_workspace_schema(conn)
        assert set(before).issubset(set(objects(conn)))
    finally:
        conn.close()


@pytest.mark.parametrize("bad", ["stat1-shape", "universe-shape", "universe-view", "sqlite-like"])
def test_owner_preprovision_rejects_bad_operational_shape_and_shadow_objects(bad):
    conn = owner_connection(with_owner=False)
    try:
        if bad == "stat1-shape":
            conn.execute("ANALYZE")
            conn.execute("PRAGMA writable_schema=ON")
            conn.execute("UPDATE sqlite_master SET sql='CREATE TABLE sqlite_stat1(tbl,idx,stat,extra)' "
                         "WHERE type='table' AND name='sqlite_stat1'")
        elif bad == "universe-shape":
            conn.execute("CREATE TABLE universe_import_state(payload TEXT)")
        elif bad == "universe-view":
            conn.execute("CREATE VIEW universe_import_state AS SELECT 1")
        else:
            conn.execute("CREATE TABLE sqliteXstat1(tbl,idx,stat)")
        conn.commit()
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert objects(conn) == before
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='owner_sync_schema'").fetchall() == []
    finally:
        conn.close()


@pytest.mark.parametrize("choice", [False, 1, "true", None])
def test_provision_opt_in_is_literal_true(candidate, choice):
    before = objects(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_analysis_candidate(candidate, synthetic_candidate=choice)
    assert objects(candidate) == before


def test_analysis_verifiers_are_read_only_under_sql_authorizer(candidate):
    before, changes = objects(candidate), candidate.total_changes
    statements = []
    candidate.set_trace_callback(statements.append)
    candidate.execute("PRAGMA query_only=ON")
    denied = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE,
              sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_INDEX,
              sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_DROP_TABLE}
    candidate.set_authorizer(lambda code, *_args: sqlite3.SQLITE_DENY if code in denied else sqlite3.SQLITE_OK)
    verify_owner_analysis_schema(candidate)
    verify_owner_workspace_schema(candidate)
    assert objects(candidate) == before and candidate.total_changes == changes
    assert all(sql.lstrip().upper().startswith(("SELECT", "PRAGMA")) for sql in statements)
    candidate.set_authorizer(None)


@pytest.mark.parametrize("ddl", [
    "CREATE TABLE owner_analysis_extra(payload TEXT)",
    "CREATE TABLE sqliteXanalysis(payload TEXT)",
    "CREATE INDEX idx_owner_analysis_extra ON owner_analysis_runs(source_revision)",
    "CREATE VIEW owner_analysis_view AS SELECT * FROM owner_analysis_runs",
    "CREATE TRIGGER extra_analysis AFTER INSERT ON owner_analysis_runs BEGIN SELECT 1; END",
])
def test_unknown_objects_have_no_prefix_or_type_exemption(candidate, ddl):
    candidate.execute(ddl)
    candidate.commit()
    before = objects(candidate)
    for verify in (verify_owner_analysis_schema, verify_owner_workspace_schema):
        with pytest.raises(sqlite3.DatabaseError):
            verify(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_analysis_candidate(candidate, synthetic_candidate=True)
    assert objects(candidate) == before


@pytest.mark.parametrize("name", tuple(OWNER_ANALYSIS_DDL))
def test_partial_analysis_profile_is_never_filled_in(name):
    conn = owner_connection()
    try:
        conn.execute(OWNER_ANALYSIS_DDL[name])
        conn.commit()
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_analysis_candidate(conn, synthetic_candidate=True)
        with pytest.raises(sqlite3.DatabaseError):
            verify_owner_workspace_schema(conn)
        assert objects(conn) == before
    finally:
        conn.close()


def test_empty_or_core_without_owner_is_not_automatically_provisioned():
    for complete_core in (False, True):
        conn = sqlite3.connect(":memory:")
        try:
            if complete_core:
                for ddl in expected_objects().values():
                    conn.execute(ddl)
            conn.execute("PRAGMA user_version=9")
            conn.commit()
            before = objects(conn)
            with pytest.raises(sqlite3.DatabaseError):
                provision_owner_analysis_candidate(conn, synthetic_candidate=True)
            assert objects(conn) == before
        finally:
            conn.close()


def test_all_fixed_triggers_and_implicit_indexes_are_required(candidate):
    candidate.execute("DROP TRIGGER immutable_owner_analysis_components_delete")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_workspace_schema(candidate)
    candidate.execute(OWNER_ANALYSIS_TRIGGERS["immutable_owner_analysis_components_delete"])
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("DELETE FROM sqlite_master WHERE name='sqlite_autoindex_owner_analysis_runs_2'")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_analysis_schema(candidate)


def test_unknown_sql_null_index_is_not_hidden(candidate):
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("INSERT INTO sqlite_master(type,name,tbl_name,rootpage,sql) "
                      "VALUES('index','sqliteXanalysis','owner_analysis_runs',0,NULL)")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_workspace_schema(candidate)


def test_altered_fixed_ddl_is_rejected(candidate):
    candidate.execute("DROP TRIGGER immutable_owner_analysis_runs_delete")
    candidate.execute("CREATE TRIGGER immutable_owner_analysis_runs_delete "
                      "BEFORE DELETE ON owner_analysis_runs BEGIN SELECT 1; END")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_analysis_schema(candidate)


@pytest.mark.parametrize("table,old,new", [
    ("owner_analysis_runs", "UNIQUE NOT NULL", "NOT NULL"),
    ("owner_analysis_runs", "REFERENCES portfolio_policy_versions(policy_version)", ""),
    ("owner_analysis_components", "PRIMARY KEY(request_id,fund_code)", "PRIMARY KEY(fund_code)"),
    ("owner_analysis_components", "REFERENCES evidence_snapshots(evidence_id)", ""),
])
def test_changed_unique_primary_and_foreign_keys_are_not_accepted(candidate, table, old, new):
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name=?",
                      (OWNER_ANALYSIS_DDL[table].replace(old, new), table))
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_workspace_schema(candidate)


@pytest.mark.parametrize("bad", ["missing", "version", "singleton"])
def test_version_metadata_is_checked_in_addition_to_inventory(candidate, bad):
    for operation in ("update", "delete"):
        candidate.execute("DROP TRIGGER immutable_owner_analysis_schema_" + operation)
    candidate.execute("PRAGMA ignore_check_constraints=ON")
    if bad == "missing":
        candidate.execute("DELETE FROM owner_analysis_schema")
    elif bad == "version":
        candidate.execute("UPDATE owner_analysis_schema SET version=?", (b"owner-analysis-schema-1",))
    else:
        candidate.execute("UPDATE owner_analysis_schema SET singleton=2")
    for operation in ("update", "delete"):
        candidate.execute(OWNER_ANALYSIS_TRIGGERS["immutable_owner_analysis_schema_" + operation])
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError, match="extension version"):
        verify_owner_analysis_schema(candidate)


def test_fixed_optional_operational_and_version_tables_are_supported_without_data_reads(candidate):
    candidate.execute(_UNIVERSE_IMPORT_STATE_DDL)
    candidate.execute(VERSION_DDL)
    candidate.execute("INSERT INTO _schema_version VALUES(1,9)")
    candidate.execute("ANALYZE")
    candidate.commit()
    statements = []
    candidate.set_trace_callback(statements.append)
    verify_owner_analysis_schema(candidate)
    assert not any("FROM universe_import_state" in sql or "FROM sqlite_stat1" in sql for sql in statements)
    assert candidate.execute("SELECT sql FROM sqlite_master WHERE name='sqlite_stat1'").fetchone()[0] == _SQLITE_STAT1_DDL


def test_attached_temp_and_remote_connections_are_rejected(candidate):
    candidate.execute("ATTACH DATABASE ':memory:' AS synthetic_other")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_workspace_schema(candidate)
    candidate.execute("DETACH DATABASE synthetic_other")
    candidate.execute("CREATE TEMP VIEW synthetic_view AS SELECT 1")
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_analysis_candidate(candidate, synthetic_candidate=True)
    class Remote:
        def execute(self, *_args):
            pytest.fail("remote connection was used")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_analysis_schema(Remote())


def test_existing_transaction_is_not_committed_or_rolled_back(candidate):
    candidate.execute("BEGIN IMMEDIATE")
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_analysis_candidate(candidate, synthetic_candidate=True)
    assert candidate.in_transaction
    candidate.rollback()


@pytest.mark.parametrize("failure", ["create", "commit"])
def test_provision_fault_rolls_back_only_analysis_extension(failure):
    class FaultConnection(sqlite3.Connection):
        fail = False
        def execute(self, sql, *args, **kwargs):
            if self.fail and failure == "create" and sql.startswith("CREATE TABLE owner_analysis_components"):
                raise sqlite3.OperationalError("synthetic create fault")
            return super().execute(sql, *args, **kwargs)
        def commit(self):
            if self.fail and failure == "commit":
                raise sqlite3.OperationalError("synthetic commit fault")
            return super().commit()
    conn = owner_connection(factory=FaultConnection)
    try:
        before = objects(conn)
        conn.fail = True
        with pytest.raises(sqlite3.OperationalError):
            provision_owner_analysis_candidate(conn, synthetic_candidate=True)
        assert not conn.in_transaction and objects(conn) == before
        verify_owner_sync_schema(conn)
    finally:
        conn.close()


@pytest.mark.parametrize("field,value", [
    ("request_id", None), ("request_id", b"synthetic"),
    ("request_hash", "a" * 63), ("request_hash", "G" * 64),
    ("request_hash", "a" * 63 + "\0"), ("source_hash", b"a" * 64),
    ("response_hash", "a" * 63 + "\0"),
    ("request_json", ""), ("request_json", b"{}"),
    ("request_json", "中" * (MAX_ANALYSIS_REQUEST_BYTES // 3 + 1)),
    ("source_json", "中" * (MAX_ANALYSIS_DOCUMENT_BYTES // 3 + 1)),
    ("response_json", "x" * (MAX_ANALYSIS_DOCUMENT_BYTES + 1)),
    ("run_id", None), ("source_revision", -1),
    ("source_revision", MAX_SAFE_INTEGER + 1), ("source_revision", 0.5),
    ("policy_version", b"pol-synthetic"), ("strategy_version", ""),
    ("strategy_version", "x" * 121), ("created_at", b"now"),
    ("strategy_version", "valid\0" + "x" * 121),
], ids=[f"constraint-{index}" for index in range(21)])
def test_native_types_hash_and_utf8_capacity_checks(candidate, field, value):
    insert_policy(candidate)
    with pytest.raises(sqlite3.IntegrityError):
        insert_run(candidate, **{field: value})
    candidate.rollback()


def test_safe_revision_and_exact_utf8_boundaries_and_unique_run(candidate):
    insert_policy(candidate)
    insert_run(candidate, source_revision=MAX_SAFE_INTEGER,
               request_json="x" * MAX_ANALYSIS_REQUEST_BYTES,
               source_json="x" * MAX_ANALYSIS_DOCUMENT_BYTES,
               response_json="x" * MAX_ANALYSIS_DOCUMENT_BYTES,
               strategy_version="中" * 120)
    with pytest.raises(sqlite3.IntegrityError):
        insert_run(candidate, request_id="synthetic-request-2")
    candidate.rollback()


def test_immediate_foreign_keys_are_fixed_and_enforced(candidate):
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        insert_run(candidate)
    candidate.rollback()
    insert_policy(candidate)
    insert_run(candidate)
    with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"):
        candidate.execute("INSERT INTO owner_analysis_components VALUES(?,?,?,?,?)",
                          ("synthetic-request-1", "000001", "missing-holding", "missing-evidence", "missing-decision"))
    candidate.rollback()
    references = candidate.execute("PRAGMA foreign_key_list(owner_analysis_components)").fetchall()
    assert {(row[2], row[3], row[4]) for row in references} == {
        ("owner_analysis_runs", "request_id", "request_id"),
        ("holding_versions", "holding_version", "holding_version"),
        ("evidence_snapshots", "evidence_id", "evidence_id"),
        ("decision_snapshots", "decision_id", "decision_id"),
    }


@pytest.mark.parametrize("fund", ["00001", "0000001", "０００００１", "00000\0", b"000001", "00000a"])
def test_component_fund_code_is_exact_six_ascii_digits(candidate, fund):
    candidate.execute("PRAGMA foreign_keys=OFF")
    with pytest.raises(sqlite3.IntegrityError):
        candidate.execute("INSERT INTO owner_analysis_components VALUES(?,?,?,?,?)",
                          ("synthetic-request-1", fund, "holding", "evidence", "decision"))
    candidate.rollback()


@pytest.mark.parametrize("table", tuple(OWNER_ANALYSIS_DDL))
@pytest.mark.parametrize("operation", ["UPDATE", "DELETE"])
def test_each_analysis_table_rejects_update_and_delete(candidate, table, operation):
    candidate.execute("PRAGMA foreign_keys=OFF")
    insert_run(candidate)
    candidate.execute("INSERT INTO owner_analysis_components VALUES(?,?,?,?,?)",
                      ("synthetic-request-1", "000001", "holding", "evidence", "decision"))
    candidate.commit()
    sql = f"DELETE FROM {table}" if operation == "DELETE" else f"UPDATE {table} SET " + {
        "owner_analysis_schema": "version=version", "owner_analysis_runs": "run_id=run_id",
        "owner_analysis_components": "fund_code=fund_code",
    }[table]
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        candidate.execute(sql)
    candidate.rollback()


def test_complete_analysis_profile_keeps_real_sync_write_receipt_and_read_working(candidate):
    from service import owner_sync_repo as repo

    raw = json.dumps({
        "request_id": "synthetic-sync-1", "expected_revision": 0,
        "operations": [{"key": "000001::", "kind": "holding", "deleted": False,
                        "changes": {"name": "合成基金", "shares": 0, "cost": None,
                                    "target_weight": None}}],
    }, ensure_ascii=False).encode()
    result = repo.apply_sync_local(candidate, raw)
    assert result.status == 200 and result.body["revision"] == 1
    assert result.body["records"][0]["values"] == {
        "name": "合成基金", "shares": 0.0, "cost": None, "target_weight": None,
    }
    assert repo.read_sync_receipt(candidate, "synthetic-sync-1") == result
    assert repo.apply_sync_local(candidate, raw) == result
    assert repo.read_sync_changes(candidate) == {
        "upper_revision": 1, "changes": result.body["records"],
        "next_cursor": None, "complete": True,
    }
    verify_owner_analysis_schema(candidate)
    assert candidate.execute("SELECT count(*) FROM owner_analysis_runs").fetchone() == (0,)
