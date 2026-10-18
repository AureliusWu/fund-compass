"""Exact optional universe-import schema; synthetic SQLite only."""
import ast
from contextlib import closing
from pathlib import Path
import re
import sqlite3

import pytest

from database.owner_sync_schema import (
    _SQLITE_STAT1_DDL, _UNIVERSE_IMPORT_STATE_DDL, provision_owner_sync_candidate, verify_owner_sync_schema,
)
from database.turso_schema import _normalize_ddl
from test_owner_sync_schema import candidate, core_connection, objects


@pytest.mark.parametrize("source", ["service/repo.py", "database/turso_scope_upgrade.py"])
def test_optional_universe_ddl_matches_each_trusted_source_without_importing_upgrade(source):
    # Parse trusted source as data, never import the large migration module or
    # execute arbitrary input DDL. Only this one fixed source literal is used.
    tree = ast.parse((Path(__file__).resolve().parents[1] / source).read_text(encoding="utf-8"))
    definitions = [
        node.value for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        and re.match(r"^\s*CREATE TABLE IF NOT EXISTS universe_import_state\s*\(", node.value)
    ]
    assert len(definitions) == 1
    with closing(sqlite3.connect(":memory:")) as reference:
        reference.execute(definitions[0])
        stored = reference.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='universe_import_state'"
        ).fetchone()[0]
        # INTEGER PRIMARY KEY creates no optional NULL-SQL autoindex.
        assert reference.execute("SELECT type,name FROM sqlite_master").fetchall() == [
            ("table", "universe_import_state"),
        ]
    assert _normalize_ddl(stored) == _normalize_ddl(_UNIVERSE_IMPORT_STATE_DDL)


def test_absent_optional_table_is_never_created_by_verification(candidate):
    before, changes = objects(candidate), candidate.total_changes
    verify_owner_sync_schema(candidate)
    assert objects(candidate) == before and candidate.total_changes == changes
    assert not any(row[1] == "universe_import_state" for row in before)
    assert not any(row[1] == "sqlite_stat1" for row in before)


def test_optional_allowance_does_not_provision_an_unextended_core():
    with closing(core_connection()) as conn:
        conn.execute(_UNIVERSE_IMPORT_STATE_DDL)
        conn.commit()
        before, changes = objects(conn), conn.total_changes
        with pytest.raises(sqlite3.DatabaseError, match="contains unrecognized objects"):
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert objects(conn) == before and conn.total_changes == changes


@pytest.mark.parametrize("with_data", [False, True])
def test_fixed_optional_table_is_read_only_and_its_values_are_not_read(candidate, with_data):
    candidate.execute(_UNIVERSE_IMPORT_STATE_DDL)
    if with_data:
        # Types/content of this operational receipt are outside Owner sync's
        # contract: even huge BLOB cells must not enter Python during verification.
        candidate.execute(
            "INSERT INTO universe_import_state VALUES(1,zeroblob(1048576),0,zeroblob(1048576))"
        )
    candidate.commit()
    before, changes = objects(candidate), candidate.total_changes
    statements = []
    candidate.set_trace_callback(statements.append)
    candidate.execute("PRAGMA query_only=ON")

    def metadata_only(action, table, *_rest):
        if action == sqlite3.SQLITE_READ and table == "universe_import_state":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    candidate.set_authorizer(metadata_only)
    try:
        verify_owner_sync_schema(candidate)
        assert objects(candidate) == before and candidate.total_changes == changes
        assert all(sql.lstrip().upper().startswith(("SELECT", "PRAGMA")) for sql in statements)
    finally:
        candidate.set_authorizer(None)
        candidate.set_trace_callback(None)


@pytest.mark.parametrize("ddl", [
    _UNIVERSE_IMPORT_STATE_DDL.replace("CHECK(singleton_id = 1)", "CHECK(singleton_id > 0)"),
    _UNIVERSE_IMPORT_STATE_DDL.replace("sha256 TEXT NOT NULL", "sha256 TEXT"),
    _UNIVERSE_IMPORT_STATE_DDL.replace("fund_count INTEGER", "fund_count TEXT"),
    _UNIVERSE_IMPORT_STATE_DDL.replace("imported_at TEXT NOT NULL", "imported_at TEXT NOT NULL, extra TEXT"),
])
def test_optional_table_wrong_ddl_is_rejected_without_repair(candidate, ddl):
    candidate.execute(ddl)
    candidate.commit()
    before, changes = objects(candidate), candidate.total_changes
    with pytest.raises(sqlite3.DatabaseError, match="schema contract mismatch"):
        verify_owner_sync_schema(candidate)
    assert objects(candidate) == before and candidate.total_changes == changes


@pytest.mark.parametrize("ddl", [
    _UNIVERSE_IMPORT_STATE_DDL.replace("universe_import_state", "universe_import_state_extra", 1),
    "CREATE TABLE turso_candidate_probe_v1(nonce_sha256 TEXT PRIMARY KEY NOT NULL,marker_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)",
    "CREATE INDEX universe_import_state_extra ON universe_import_state(sha256)",
    "CREATE VIEW universe_import_state_view AS SELECT sha256 FROM universe_import_state",
    "CREATE TRIGGER universe_import_state_trigger AFTER INSERT ON universe_import_state BEGIN SELECT 1; END",
])
def test_optional_allowance_never_exempts_prefix_probe_index_view_or_trigger(candidate, ddl):
    candidate.execute(_UNIVERSE_IMPORT_STATE_DDL)
    candidate.execute(ddl)
    candidate.commit()
    before, changes = objects(candidate), candidate.total_changes
    with pytest.raises(sqlite3.DatabaseError, match="missing or unknown objects"):
        verify_owner_sync_schema(candidate)
    assert objects(candidate) == before and candidate.total_changes == changes


def test_analyze_generated_stat1_is_verified_read_only_without_reading_its_values(candidate):
    # Normal startup optimization must remain active. Only its exact fixed
    # schema is optional; this does not exempt other SQLite-prefixed objects.
    candidate.execute(_UNIVERSE_IMPORT_STATE_DDL)
    candidate.execute("ANALYZE")
    candidate.commit()
    row = candidate.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'"
    ).fetchone()
    assert row is not None
    assert _normalize_ddl(row[0]) == _normalize_ddl(_SQLITE_STAT1_DDL)
    before, changes = objects(candidate), candidate.total_changes
    candidate.execute("PRAGMA query_only=ON")

    def metadata_only(action, table, *_rest):
        if action == sqlite3.SQLITE_READ and table == "sqlite_stat1":
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    candidate.set_authorizer(metadata_only)
    try:
        verify_owner_sync_schema(candidate)
        assert objects(candidate) == before and candidate.total_changes == changes
    finally:
        candidate.set_authorizer(None)


@pytest.mark.parametrize("ddl", [
    "CREATE TABLE sqlite_stat1(tbl TEXT,idx,stat)",
    "CREATE TABLE sqlite_stat1(tbl,idx,stat,extra)",
    None,
])
def test_stat1_wrong_schema_is_rejected_without_repair(candidate, ddl):
    candidate.execute("ANALYZE")
    # Test-only corruption of this synthetic in-memory fixture's catalog.
    # No input DDL is executed; never perform this on a configured database.
    candidate.execute("PRAGMA writable_schema=ON")
    candidate.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='sqlite_stat1'", (ddl,))
    candidate.execute("PRAGMA writable_schema=OFF")
    candidate.commit()
    before, changes = objects(candidate), candidate.total_changes
    with pytest.raises(sqlite3.DatabaseError, match="schema contract mismatch"):
        verify_owner_sync_schema(candidate)
    assert objects(candidate) == before and candidate.total_changes == changes


def test_stat1_allowance_never_exempts_similarly_named_statistics(candidate):
    candidate.execute("ANALYZE")
    candidate.execute("CREATE TABLE sqliteXstat1(tbl,idx,stat)")
    candidate.commit()
    before, changes = objects(candidate), candidate.total_changes
    with pytest.raises(sqlite3.DatabaseError, match="missing or unknown objects"):
        verify_owner_sync_schema(candidate)
    assert objects(candidate) == before and candidate.total_changes == changes
