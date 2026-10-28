"""Fixed synthetic machine profile, actual SQLite and existing application readers."""
from contextlib import closing
import hashlib
import sqlite3

import pytest

from database.owner_analysis_schema import (
    provision_owner_analysis_candidate, verify_owner_analysis_schema,
    verify_owner_analysis_workspace_schema, verify_owner_workspace_schema,
)
from database.owner_machine_schema import (
    MACHINE_SCHEMA_CREATED_AT, MACHINE_SCHEMA_PAYLOAD_HASH, MACHINE_SCHEMA_PAYLOAD_JSON,
    MAX_MACHINE_DOCUMENT_BYTES, OWNER_MACHINE_DDL, OWNER_MACHINE_SCHEMA_VERSION,
    OWNER_MACHINE_TRIGGERS, provision_owner_machine_candidate, verify_owner_machine_schema,
)
from database.owner_sync_schema import (
    MAX_SCHEMA_OBJECTS, _UNIVERSE_IMPORT_STATE_DDL, provision_owner_sync_candidate,
    verify_owner_sync_schema,
)
from database.turso_schema import VERSION_DDL, expected_objects
from test_owner_analysis_repo import fixture, connect, raw  # actual synthetic business fixture


def analysis_connection(*, factory=sqlite3.Connection, analysis=True):
    conn = sqlite3.connect(":memory:", factory=factory)
    conn.execute("PRAGMA foreign_keys=ON")
    for ddl in expected_objects().values():
        conn.execute(ddl)
    conn.execute("PRAGMA user_version=9")
    conn.commit()
    provision_owner_sync_candidate(conn, synthetic_candidate=True)
    if analysis:
        provision_owner_analysis_candidate(conn, synthetic_candidate=True)
    return conn


def image(conn):
    return conn.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall()


def rows(conn):
    return conn.execute("SELECT * FROM owner_machine_journal ORDER BY kind,record_id").fetchall()


@pytest.fixture
def candidate():
    conn = analysis_connection()
    provision_owner_machine_candidate(conn, synthetic_candidate=True)
    try:
        yield conn
    finally:
        conn.close()


def insert_journal(conn, **updates):
    payload = '{"unknown":null,"value":-0.0,"zero":0}'
    value = {
        "schema_version": OWNER_MACHINE_SCHEMA_VERSION, "kind": "task", "record_id": "task-synthetic-1",
        "occurrence_id": "occurrence-synthetic-1", "analysis_request_id": None,
        "created_at": "2026-10-26T06:30:00+00:00", "payload_json": payload,
        "payload_hash": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
    }
    value.update(updates)
    conn.execute("INSERT INTO owner_machine_journal(" + ",".join(value) + ") VALUES(" +
                 ",".join("?" for _ in value) + ")", tuple(value.values()))


def test_exact_extension_is_explicit_atomic_idempotent_and_preserves_old_profiles():
    conn = analysis_connection()
    try:
        before = image(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_machine_candidate(conn)
        assert image(conn) == before
        result = provision_owner_machine_candidate(conn, synthetic_candidate=True)
        assert result == {"schema_version": OWNER_MACHINE_SCHEMA_VERSION,
                          "core_schema_version": 9, "changed": True, "synthetic_only": True}
        after = image(conn)
        assert set(before).issubset(after)
        assert len(after) - len(before) == 4
        assert rows(conn) == [(OWNER_MACHINE_SCHEMA_VERSION, "schema", "schema", None, None,
                              MACHINE_SCHEMA_CREATED_AT, MACHINE_SCHEMA_PAYLOAD_JSON, MACHINE_SCHEMA_PAYLOAD_HASH)]
        for verify in (verify_owner_machine_schema, verify_owner_workspace_schema,
                       verify_owner_analysis_workspace_schema):
            verify(conn)
        for verify in (verify_owner_sync_schema, verify_owner_analysis_schema):
            with pytest.raises(sqlite3.DatabaseError):
                verify(conn)
        assert not provision_owner_machine_candidate(conn, synthetic_candidate=True)["changed"]
        assert image(conn) == after
        assert conn.execute("PRAGMA user_version").fetchone() == (9,)
        assert conn.execute("SELECT * FROM owner_sync_state").fetchall() == [(1, 0)]
    finally:
        conn.close()


def test_all_old_profile_compatibility_contracts_remain_distinct():
    conn = analysis_connection(analysis=False)
    try:
        verify_owner_sync_schema(conn)
        verify_owner_workspace_schema(conn)
        for verify in (verify_owner_machine_schema, verify_owner_analysis_workspace_schema):
            with pytest.raises(sqlite3.DatabaseError):
                verify(conn)
        before = image(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_machine_candidate(conn, synthetic_candidate=True)
        assert image(conn) == before
        provision_owner_analysis_candidate(conn, synthetic_candidate=True)
        verify_owner_analysis_schema(conn)
        verify_owner_analysis_workspace_schema(conn)
        verify_owner_workspace_schema(conn)
        with pytest.raises(sqlite3.DatabaseError):
            verify_owner_machine_schema(conn)
    finally:
        conn.close()


@pytest.mark.parametrize("choice", [False, 1, "true", None])
def test_only_literal_true_selects_provision(choice):
    conn = analysis_connection()
    try:
        before = image(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_machine_candidate(conn, synthetic_candidate=choice)
        assert image(conn) == before
    finally:
        conn.close()


def test_complete_optional_inventory_fits_original_object_bound_without_operational_reads(candidate):
    candidate.execute(VERSION_DDL)
    candidate.execute("INSERT INTO _schema_version VALUES(1,9)")
    candidate.execute(_UNIVERSE_IMPORT_STATE_DDL)
    candidate.execute("ANALYZE")
    candidate.commit()
    assert candidate.execute("SELECT COUNT(*) FROM sqlite_master").fetchone() == (MAX_SCHEMA_OBJECTS,)
    assert MAX_SCHEMA_OBJECTS == 128
    statements = []
    candidate.set_trace_callback(statements.append)
    verify_owner_machine_schema(candidate)
    verify_owner_workspace_schema(candidate)
    verify_owner_analysis_workspace_schema(candidate)
    assert not any("FROM universe_import_state" in sql or "FROM sqlite_stat1" in sql for sql in statements)
    candidate.execute("CREATE TABLE unrelated_extra(payload TEXT)")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError, match="verification bounds"):
        verify_owner_machine_schema(candidate)


def test_machine_verification_is_select_pragma_only(candidate):
    before, changes = image(candidate), candidate.total_changes
    statements = []
    candidate.set_trace_callback(statements.append)
    candidate.execute("PRAGMA query_only=ON")
    denied = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE,
              sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_INDEX,
              sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_DROP_TABLE}
    candidate.set_authorizer(lambda code, *_args: sqlite3.SQLITE_DENY if code in denied else sqlite3.SQLITE_OK)
    for verify in (verify_owner_machine_schema, verify_owner_workspace_schema,
                   verify_owner_analysis_workspace_schema):
        verify(candidate)
    assert image(candidate) == before and candidate.total_changes == changes
    assert statements and all(sql.lstrip().upper().startswith(("SELECT", "PRAGMA")) for sql in statements)
    candidate.set_authorizer(None)


@pytest.mark.parametrize("ddl", [
    "CREATE TABLE owner_machine_extra(payload TEXT)",
    "CREATE TABLE sqliteXmachine(payload TEXT)",
    "CREATE INDEX idx_machine_extra ON owner_machine_journal(occurrence_id)",
    "CREATE VIEW owner_machine_view AS SELECT * FROM owner_machine_journal",
    "CREATE TRIGGER extra_machine AFTER INSERT ON owner_machine_journal BEGIN SELECT 1; END",
])
def test_unknown_objects_are_not_hidden_by_name_or_type(candidate, ddl):
    candidate.execute(ddl)
    candidate.commit()
    before = image(candidate)
    for verify in (verify_owner_machine_schema, verify_owner_workspace_schema,
                   verify_owner_analysis_workspace_schema):
        with pytest.raises(sqlite3.DatabaseError):
            verify(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_machine_candidate(candidate, synthetic_candidate=True)
    assert image(candidate) == before


@pytest.mark.parametrize("missing", ["table", "update", "delete", "marker", "autoindex"])
def test_partial_machine_profile_is_rejected_not_repaired(candidate, missing):
    if missing == "table":
        candidate.execute("DROP TABLE owner_machine_journal")
        # A fixed-name orphan object must not be mistaken for pure analysis.
        candidate.execute("CREATE VIEW owner_machine_journal AS SELECT 1")
    elif missing in {"update", "delete"}:
        candidate.execute("DROP TRIGGER immutable_owner_machine_journal_" + missing)
    elif missing == "marker":
        candidate.execute("DROP TRIGGER immutable_owner_machine_journal_delete")
        candidate.execute("DELETE FROM owner_machine_journal WHERE kind='schema'")
        candidate.execute(OWNER_MACHINE_TRIGGERS["immutable_owner_machine_journal_delete"])
    else:
        candidate.execute("PRAGMA writable_schema=ON")
        candidate.execute("DELETE FROM sqlite_master WHERE name='sqlite_autoindex_owner_machine_journal_1'")
    candidate.commit()
    before = image(candidate)
    for verify in (verify_owner_machine_schema, verify_owner_workspace_schema,
                   verify_owner_analysis_workspace_schema):
        with pytest.raises(sqlite3.DatabaseError):
            verify(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_machine_candidate(candidate, synthetic_candidate=True)
    assert image(candidate) == before


@pytest.mark.parametrize("field,value", [
    ("schema_version", "owner-machine-schema-2"), ("record_id", "wrong"),
    ("kind", "task"),
    ("occurrence_id", "not-null"), ("analysis_request_id", "not-null"),
    ("created_at", "1970-01-01T00:00:00Z"), ("payload_json", '{"schema":"wrong"}'),
    ("payload_hash", "0" * 64), ("payload_json", b'{"schema":"owner-machine-schema-1"}'),
])
def test_marker_all_columns_are_checked_even_when_checks_disabled(candidate, field, value):
    candidate.execute("DROP TRIGGER immutable_owner_machine_journal_update")
    candidate.execute("PRAGMA ignore_check_constraints=ON")
    candidate.execute("PRAGMA foreign_keys=OFF")
    candidate.execute(f"UPDATE owner_machine_journal SET {field}=? WHERE kind='schema'", (value,))
    candidate.execute(OWNER_MACHINE_TRIGGERS["immutable_owner_machine_journal_update"])
    candidate.commit()
    for verify in (verify_owner_machine_schema, verify_owner_workspace_schema,
                   verify_owner_analysis_workspace_schema):
        with pytest.raises(sqlite3.DatabaseError, match="extension version"):
            verify(candidate)


@pytest.mark.parametrize("old,new", [
    ("PRIMARY KEY(kind,record_id)", "PRIMARY KEY(record_id)"),
    ("REFERENCES owner_analysis_runs(request_id)", ""),
    ("BETWEEN 1 AND 2097152", "BETWEEN 1 AND 9999999"),
    ("'schema','task','attempt','result','observation'", "'schema','task','anything'"),
])
def test_altered_fixed_ddl_is_not_accepted(candidate, old, new):
    assert old in OWNER_MACHINE_DDL["owner_machine_journal"]
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("UPDATE sqlite_master SET sql=? WHERE name='owner_machine_journal' AND type='table'",
                      (OWNER_MACHINE_DDL["owner_machine_journal"].replace(old, new),))
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError, match="contract mismatch"):
        verify_owner_machine_schema(candidate)


@pytest.mark.parametrize("field,value", [
    ("schema_version", None), ("schema_version", "other"), ("kind", "send_lock"),
    ("kind", "schema"), ("kind", b"task"), ("record_id", None), ("record_id", ""),
    ("record_id", "中" * 43), ("record_id", "x\0y"), ("occurrence_id", None),
    ("occurrence_id", b"x"), ("analysis_request_id", "missing-analysis-id"),
    ("created_at", None), ("created_at", "x" * 65),
    ("payload_json", ""), ("payload_json", b"{}"),
    pytest.param("payload_json", "中" * (MAX_MACHINE_DOCUMENT_BYTES // 3 + 1), id="payload-utf8-overflow"),
    ("payload_hash", "G" * 64), ("payload_hash", "a" * 63 + "\0"),
    ("payload_hash", b"a" * 64),
])
def test_journal_constraints_reject_bad_native_types_bytes_and_foreign_keys(candidate, field, value):
    before = rows(candidate)
    with pytest.raises(sqlite3.IntegrityError):
        insert_journal(candidate, **{field: value})
    candidate.rollback()
    assert rows(candidate) == before


@pytest.mark.parametrize("kind", ["task", "attempt", "result", "observation"])
def test_journal_rows_preserve_raw_values_and_are_immutable(candidate, kind):
    insert_journal(candidate, kind=kind)
    candidate.commit()
    before = rows(candidate)
    assert any(
        row[6] == '{"unknown":null,"value":-0.0,"zero":0}' for row in before)
    for sql in ("UPDATE owner_machine_journal SET payload_json='{}' WHERE kind=?",
                "DELETE FROM owner_machine_journal WHERE kind=?"):
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            candidate.execute(sql, (kind,))
        candidate.rollback()
    with pytest.raises(sqlite3.IntegrityError):
        insert_journal(candidate, kind=kind)
    candidate.rollback()
    assert rows(candidate) == before


@pytest.mark.parametrize("position", range(1, 5))
def test_each_extension_write_fault_rolls_back_to_exact_analysis(position):
    class FaultConnection(sqlite3.Connection):
        enabled = False
        writes = 0
        def execute(self, sql, *args, **kwargs):
            if self.enabled and sql.startswith(("CREATE TABLE owner_machine_journal",
                                                "CREATE TRIGGER immutable_owner_machine_journal_",
                                                "INSERT INTO owner_machine_journal")):
                self.writes += 1
                if self.writes == position:
                    raise sqlite3.OperationalError("synthetic machine write fault")
            return super().execute(sql, *args, **kwargs)
    conn = analysis_connection(factory=FaultConnection)
    try:
        before = image(conn)
        conn.enabled = True
        with pytest.raises(sqlite3.OperationalError, match="synthetic machine write fault"):
            provision_owner_machine_candidate(conn, synthetic_candidate=True)
        assert conn.writes == position and not conn.in_transaction
        assert image(conn) == before
        verify_owner_analysis_schema(conn)
    finally:
        conn.close()


@pytest.mark.parametrize("committed", [False, True])
def test_commit_fault_is_not_a_success_or_automatic_retry(committed):
    class FaultConnection(sqlite3.Connection):
        enabled = False
        commits = 0
        def commit(self):
            if self.enabled:
                self.commits += 1
                if committed:
                    super().commit()
                raise sqlite3.OperationalError("synthetic unknown machine commit")
            return super().commit()
    conn = analysis_connection(factory=FaultConnection)
    try:
        before = image(conn)
        conn.enabled = True
        with pytest.raises(sqlite3.OperationalError, match="unknown machine commit"):
            provision_owner_machine_candidate(conn, synthetic_candidate=True)
        assert conn.commits == 1 and not conn.in_transaction
        if committed:
            verify_owner_machine_schema(conn)
            conn.enabled = False
            statements = []
            conn.set_trace_callback(statements.append)
            assert not provision_owner_machine_candidate(conn, synthetic_candidate=True)["changed"]
            assert not any(sql.startswith(("CREATE", "INSERT")) for sql in statements)
        else:
            assert image(conn) == before
            verify_owner_analysis_schema(conn)
    finally:
        conn.close()


def test_post_write_verification_failure_rolls_back_every_extension_object(monkeypatch):
    from database import owner_machine_schema as schema

    conn = analysis_connection()
    try:
        before = image(conn)
        def fault(_conn):
            raise sqlite3.DatabaseError("synthetic post-write verification fault")
        monkeypatch.setattr(schema, "verify_owner_machine_schema", fault)
        with pytest.raises(sqlite3.DatabaseError, match="post-write verification fault"):
            provision_owner_machine_candidate(conn, synthetic_candidate=True)
        assert not conn.in_transaction and image(conn) == before
        verify_owner_analysis_schema(conn)
    finally:
        conn.close()


def test_sql_null_unknown_index_and_duplicate_marker_are_not_hidden(candidate):
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("INSERT INTO sqlite_master(type,name,tbl_name,rootpage,sql) "
                      "VALUES('index','sqliteXmachine','owner_machine_journal',0,NULL)")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_machine_schema(candidate)
    candidate.execute("DELETE FROM sqlite_master WHERE name='sqliteXmachine'")
    candidate.execute("PRAGMA ignore_check_constraints=ON")
    candidate.execute("INSERT INTO owner_machine_journal "
                      "SELECT schema_version,kind,'other-schema',occurrence_id,analysis_request_id,"
                      "created_at,payload_json,payload_hash FROM owner_machine_journal WHERE kind='schema'")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError, match="extension version"):
        verify_owner_machine_schema(candidate)


def test_invalid_connections_and_active_transactions_are_not_repurposed(candidate):
    candidate.execute("BEGIN IMMEDIATE")
    with pytest.raises(sqlite3.DatabaseError, match="active transaction"):
        provision_owner_machine_candidate(candidate, synthetic_candidate=True)
    assert candidate.in_transaction
    candidate.rollback()
    candidate.execute("ATTACH DATABASE ':memory:' AS synthetic_attached")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_machine_schema(candidate)
    candidate.execute("DETACH DATABASE synthetic_attached")
    candidate.execute("CREATE TEMP VIEW synthetic_temp AS SELECT 1")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_workspace_schema(candidate)
    class Remote:
        def execute(self, *_args):
            pytest.fail("remote connection was used")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_machine_schema(Remote())


def test_provision_refuses_disabled_foreign_keys_without_writing():
    conn = analysis_connection()
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        before = image(conn)
        with pytest.raises(sqlite3.DatabaseError, match="foreign keys"):
            provision_owner_machine_candidate(conn, synthetic_candidate=True)
        assert image(conn) == before and not conn.in_transaction
    finally:
        conn.close()


def test_actual_configured_factory_sync_reader_and_analysis_work_on_machine_profile(fixture, monkeypatch):
    from database import db
    from models.owner_analysis import parse_owner_analysis_request
    from service import owner_analysis_repo as analysis, owner_sync as http, owner_sync_repo as sync

    f = fixture
    with closing(connect(f.path)) as conn:
        before = [tuple(row) for row in conn.execute("SELECT * FROM owner_sync_records ORDER BY sync_key")]
        provision_owner_machine_candidate(conn, synthetic_candidate=True)
    monkeypatch.setattr(db, "DB_PATH", str(f.path))
    with closing(http.configured_local_sync_connection()) as conn:
        page = sync.read_sync_changes(conn)
        assert page["upper_revision"] == 2
        result = analysis.create_analysis_local(conn, raw(f))
        assert result.status == 200 and result.body["source_current"] is True
        assert len(result.body["run"]["components"]) == 3
        parsed = parse_owner_analysis_request(raw(f))
        receipt = analysis.reconcile_analysis_local(conn, parsed.request_id, parsed.request_hash())
        assert receipt.state == "matched" and receipt.result.body == result.body
        assert [tuple(row) for row in conn.execute("SELECT * FROM owner_sync_records ORDER BY sync_key")] == before
        assert conn.execute("SELECT count(*) FROM owner_machine_journal").fetchone()[0] == 1
        insert_journal(conn, analysis_request_id=parsed.request_id)
        conn.commit()
        assert conn.execute("SELECT analysis_request_id FROM owner_machine_journal WHERE kind='task'").fetchone()[0] == parsed.request_id
        verify_owner_machine_schema(conn)
