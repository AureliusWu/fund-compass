"""Strict independent extension verification on synthetic SQLite only."""
import sqlite3

import pytest

from database.owner_sync_schema import (
    MAX_SAFE_INTEGER, MAX_SCHEMA_DDL_BYTES, MAX_SCHEMA_OBJECTS,
    OWNER_SYNC_DDL, OWNER_SYNC_SCHEMA_VERSION,
    provision_owner_sync_candidate, verify_owner_sync_schema,
)
from database.turso_schema import VERSION_DDL, expected_objects


def core_connection(*, factory=sqlite3.Connection, version=9):
    conn = sqlite3.connect(":memory:", factory=factory)
    conn.execute("PRAGMA foreign_keys=ON")
    for ddl in expected_objects().values():
        conn.execute(ddl)
    conn.execute(f"PRAGMA user_version={version}")
    conn.commit()
    return conn


@pytest.fixture
def candidate():
    conn = core_connection()
    provision_owner_sync_candidate(conn, synthetic_candidate=True)
    try:
        yield conn
    finally:
        conn.close()


def objects(conn):
    return conn.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall()


def test_explicit_candidate_has_independent_version_and_is_idempotent():
    conn = core_connection()
    try:
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn)
        assert objects(conn) == before
        first = provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert first == {"schema_version": OWNER_SYNC_SCHEMA_VERSION, "core_schema_version": 9,
                         "changed": True, "synthetic_only": True}
        assert conn.execute("PRAGMA user_version").fetchone() == (9,)
        assert conn.execute("SELECT * FROM owner_sync_state").fetchall() == [(1, 0)]
        assert conn.execute("SELECT * FROM owner_sync_schema").fetchall() == [(1, OWNER_SYNC_SCHEMA_VERSION)]
        after = objects(conn)
        second = provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert not second["changed"] and objects(conn) == after
    finally:
        conn.close()


def test_verify_is_read_only_even_with_query_only_and_sql_authorizer(candidate):
    before, changes = objects(candidate), candidate.total_changes
    statements = []
    candidate.set_trace_callback(statements.append)
    candidate.execute("PRAGMA query_only=ON")
    prohibited = {sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE,
                  sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_INDEX,
                  sqlite3.SQLITE_CREATE_TRIGGER, sqlite3.SQLITE_DROP_TABLE}
    candidate.set_authorizer(lambda code, *_args: sqlite3.SQLITE_DENY if code in prohibited else sqlite3.SQLITE_OK)
    verify_owner_sync_schema(candidate)
    assert candidate.total_changes == changes and objects(candidate) == before
    assert all(statement.lstrip().upper().startswith(("SELECT", "PRAGMA")) for statement in statements)
    candidate.set_authorizer(None)


@pytest.mark.parametrize("version", [0, 8, 10])
def test_core_version_is_not_extension_or_semver(version):
    conn = core_connection(version=version)
    try:
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert objects(conn) == before
    finally:
        conn.close()


def test_header_nine_on_empty_database_does_not_prove_core_schema():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA user_version=9")
    try:
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert objects(conn) == []
    finally:
        conn.close()


def test_missing_core_fixed_object_refuses_to_provision():
    conn = core_connection()
    key = next(key for key in expected_objects() if key[0] == "index")
    conn.execute('DROP INDEX "' + key[1] + '"')
    conn.commit()
    try:
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert objects(conn) == before
    finally:
        conn.close()


@pytest.mark.parametrize("ddl", [
    "CREATE TABLE unrelated(payload TEXT)",
    "CREATE TABLE sqliteXevil(payload TEXT)",
    "CREATE TABLE SqliteXevil(payload TEXT)",
    "CREATE INDEX sqliteXevil ON owner_sync_records(kind)",
    "CREATE VIEW sqliteXevil AS SELECT revision FROM owner_sync_state",
    "CREATE TRIGGER unknown_owner_sync AFTER INSERT ON owner_sync_records BEGIN SELECT 1; END",
])
def test_unknown_object_including_sqlite_like_names_is_not_exempt(candidate, ddl):
    candidate.execute(ddl)
    candidate.commit()
    before = objects(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_sync_candidate(candidate, synthetic_candidate=True)
    assert objects(candidate) == before


def test_unknown_object_also_refuses_initial_provision():
    conn = core_connection()
    conn.execute("CREATE TABLE sqliteXbefore(payload TEXT)")
    conn.commit()
    try:
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert objects(conn) == before
    finally:
        conn.close()


def test_unknown_sql_null_object_is_not_hidden_by_internal_index_exception(candidate):
    # Synthetic corruption fixture, not a production or input-DDL pathway.
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("INSERT INTO sqlite_master(type,name,tbl_name,rootpage,sql) VALUES('index','sqliteXnull','owner_sync_records',0,NULL)")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)


def test_missing_fixed_internal_index_is_rejected(candidate):
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("DELETE FROM sqlite_master WHERE name='sqlite_autoindex_owner_sync_records_1'")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)


@pytest.mark.parametrize("corruption", ["missing", "null", "altered"])
def test_fixed_autoincrement_sequence_must_exist_and_have_exact_ddl(candidate, corruption):
    candidate.execute("PRAGMA writable_schema=ON")
    if corruption == "missing":
        candidate.execute("DELETE FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
    else:
        ddl = None if corruption == "null" else "CREATE TABLE sqlite_sequence(name TEXT,seq INTEGER)"
        candidate.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='sqlite_sequence'", (ddl,))
    candidate.commit()
    before = objects(candidate)
    with pytest.raises(sqlite3.DatabaseError, match="internal schema contract"):
        verify_owner_sync_schema(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_sync_candidate(candidate, synthetic_candidate=True)
    assert objects(candidate) == before


def test_schema_object_count_is_bounded_before_full_read(candidate, monkeypatch):
    count = candidate.execute("SELECT count(*) FROM sqlite_master").fetchone()[0]
    assert count < MAX_SCHEMA_OBJECTS
    for index in range(MAX_SCHEMA_OBJECTS + 1 - count):
        candidate.execute(f"CREATE TABLE synthetic_extra_{index}(value TEXT)")
    candidate.commit()
    monkeypatch.setattr("database.owner_sync_schema._normalize_ddl",
                        lambda _ddl: pytest.fail("over-bound schema reached DDL normalization"))
    with pytest.raises(sqlite3.DatabaseError, match="verification bounds"):
        verify_owner_sync_schema(candidate)


def test_huge_unknown_ddl_is_bounded_before_python_normalization(candidate, monkeypatch):
    huge_ddl = "CREATE TABLE synthetic_huge(value TEXT /*" + "中" * MAX_SCHEMA_DDL_BYTES + "*/ )"
    candidate.execute(huge_ddl)
    candidate.commit()
    monkeypatch.setattr("database.owner_sync_schema._normalize_ddl",
                        lambda _ddl: pytest.fail("oversized DDL reached normalization"))
    with pytest.raises(sqlite3.DatabaseError, match="verification bounds"):
        verify_owner_sync_schema(candidate)


def test_partial_extension_is_not_repaired_or_adopted():
    conn = core_connection()
    conn.execute(OWNER_SYNC_DDL["owner_sync_schema"])
    conn.commit()
    try:
        before = objects(conn)
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert objects(conn) == before
    finally:
        conn.close()


def test_altered_fixed_extension_ddl_is_rejected(candidate):
    candidate.execute("DROP TABLE owner_sync_receipts")
    candidate.execute("CREATE TABLE owner_sync_receipts(request_id TEXT PRIMARY KEY, request_hash TEXT, status INTEGER, response_json TEXT)")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)


def test_missing_or_invalid_extension_metadata_refuses_without_repair(candidate):
    candidate.execute("DELETE FROM owner_sync_schema")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_sync_candidate(candidate, synthetic_candidate=True)
    assert candidate.execute("SELECT * FROM owner_sync_schema").fetchall() == []


def test_invalid_head_metadata_rejected_even_if_constraint_checks_disabled(candidate):
    candidate.execute("PRAGMA ignore_check_constraints=ON")
    candidate.execute("UPDATE owner_sync_state SET revision=-1")
    candidate.commit()
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)


def test_optional_core_metadata_requires_exact_ddl_and_exact_version():
    conn = core_connection()
    conn.execute(VERSION_DDL)
    conn.execute("INSERT INTO _schema_version VALUES(1,9)")
    conn.commit()
    try:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
        verify_owner_sync_schema(conn)
        conn.execute("UPDATE _schema_version SET version=8")
        conn.commit()
        with pytest.raises(sqlite3.DatabaseError):
            verify_owner_sync_schema(conn)
    finally:
        conn.close()


def test_optional_core_metadata_wrong_ddl_is_rejected():
    conn = core_connection()
    conn.execute("CREATE TABLE _schema_version(singleton INTEGER PRIMARY KEY,version INTEGER NOT NULL)")
    conn.execute("INSERT INTO _schema_version VALUES(1,9)")
    conn.commit()
    try:
        with pytest.raises(sqlite3.DatabaseError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
    finally:
        conn.close()


def test_attached_and_temporary_schemas_are_rejected(candidate):
    candidate.execute("ATTACH DATABASE ':memory:' AS synthetic_other")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)
    candidate.execute("DETACH DATABASE synthetic_other")
    candidate.execute("CREATE TEMP TABLE synthetic_temporary(value TEXT)")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(candidate)


def test_remote_duck_type_is_not_an_explicit_local_connection():
    class Duck:
        def execute(self, *_args):
            pytest.fail("remote/fake connection queried")
    with pytest.raises(sqlite3.DatabaseError):
        verify_owner_sync_schema(Duck())


def test_sqlite_subclass_supports_internal_fault_injection():
    class TrustedConnection(sqlite3.Connection):
        pass
    conn = core_connection(factory=TrustedConnection)
    try:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
        verify_owner_sync_schema(conn)
    finally:
        conn.close()


def test_provision_failure_rolls_back_only_new_extension():
    class BeforeCommitFailure(sqlite3.Connection):
        fail_commit = False
        def commit(self):
            if self.fail_commit:
                raise sqlite3.OperationalError("synthetic commit failure")
            return super().commit()
    conn = core_connection(factory=BeforeCommitFailure)
    before = objects(conn)
    conn.fail_commit = True
    try:
        with pytest.raises(sqlite3.OperationalError):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert not conn.in_transaction and objects(conn) == before
    finally:
        conn.close()


def test_provision_refuses_existing_transaction(candidate):
    candidate.execute("BEGIN IMMEDIATE")
    with pytest.raises(sqlite3.DatabaseError):
        provision_owner_sync_candidate(candidate, synthetic_candidate=True)
    assert candidate.in_transaction
    candidate.rollback()


@pytest.mark.parametrize("statement,args", [
    ("UPDATE owner_sync_state SET revision=?", (-1,)),
    ("UPDATE owner_sync_state SET revision=?", (MAX_SAFE_INTEGER + 1,)),
    ("UPDATE owner_sync_schema SET version=?", ("owner-sync-schema-2",)),
    ("INSERT INTO owner_sync_receipts VALUES(?,?,?,?)", ("synthetic", "f" * 64, 503, "{}")),
    ("INSERT INTO owner_sync_receipts VALUES(?,?,?,?)", ("synthetic", "G" * 64, 200, "{}")),
    ("INSERT INTO owner_sync_records VALUES(?,?,?,?,?,?,?)", ("000001::", "holding", 2, 1, 1, "{}", "{}")),
    ("INSERT INTO owner_sync_records VALUES(?,?,?,?,?,?,?)", ("000001::", "holding", 0, 1, 2, "{}", "{}")),
])
def test_fixed_physical_checks_reject_invalid_metadata_and_receipts(candidate, statement, args):
    with pytest.raises(sqlite3.IntegrityError):
        candidate.execute(statement, args)
    candidate.rollback()
