"""Bounded optional core metadata checks; synthetic in-memory SQLite only."""
from contextlib import closing
import sqlite3

import pytest

from database.owner_sync_schema import provision_owner_sync_candidate, verify_owner_sync_schema
from database.turso_schema import VERSION_DDL, expected_objects
from test_owner_sync_schema import core_connection, objects


class ProjectionConnection(sqlite3.Connection):
    """Observe real SQLite output, never fabricate a verification result."""
    forbid_metadata_read = False

    def execute(self, sql, parameters=()):
        normalized = " ".join(sql.upper().split())
        metadata_read = normalized.startswith("SELECT ") and "FROM _SCHEMA_VERSION" in normalized
        if metadata_read:
            if self.forbid_metadata_read:
                pytest.fail("malformed metadata DDL reached a data SELECT")
            assert normalized.endswith("FROM _SCHEMA_VERSION LIMIT 2")
            assert "TYPEOF(SINGLETON)" in normalized and "TYPEOF(VERSION)" in normalized
        cursor = super().execute(sql, parameters)
        return ProjectionCursor(cursor, self) if metadata_read else cursor


class ProjectionCursor:
    def __init__(self, cursor, connection):
        self.cursor, self.connection = cursor, connection

    def fetchall(self):
        pytest.fail("metadata query used unbounded fetchall")

    def fetchmany(self, size):
        assert size == 2
        rows = self.cursor.fetchmany(size)
        assert len(rows) <= 2
        assert all(len(row) == 2 and all(type(value) is int and value in (0, 1) for value in row)
                   for row in rows)
        self.connection.metadata_rows.append(rows)
        return rows


def prepared_candidate():
    conn = core_connection(factory=ProjectionConnection)
    provision_owner_sync_candidate(conn, synthetic_candidate=True)
    conn.metadata_rows = []
    return conn


@pytest.mark.parametrize("ddl", [
    "CREATE TABLE _schema_version(singleton INTEGER,version INTEGER)",
    "CREATE TABLE _schema_version(singleton INTEGER PRIMARY KEY CHECK(singleton=1),other INTEGER NOT NULL)",
])
def test_malformed_version_ddl_is_rejected_before_any_metadata_select(ddl):
    with closing(prepared_candidate()) as conn:
        conn.execute(ddl)
        if "version INTEGER" in ddl:
            conn.executemany("INSERT INTO _schema_version VALUES(?,?)", ((value, 9) for value in range(1024)))
        conn.commit()
        before, changes = objects(conn), conn.total_changes
        conn.forbid_metadata_read = True
        with pytest.raises(sqlite3.DatabaseError, match="core schema contract mismatch"):
            verify_owner_sync_schema(conn)
        assert conn.metadata_rows == []
        assert objects(conn) == before and conn.total_changes == changes


@pytest.mark.parametrize("kind", ["valid", "wrong", "real", "text", "huge_text", "huge_blob"])
def test_version_payload_is_checked_in_sql_without_transferring_raw_values(kind):
    value = {
        "valid": 9, "wrong": 8, "real": 9.5, "text": "synthetic invalid version",
        "huge_text": "中" * (128 * 1024), "huge_blob": b"\xff" * (128 * 1024),
    }[kind]
    with closing(prepared_candidate()) as conn:
        conn.execute(VERSION_DDL)
        conn.execute("INSERT INTO _schema_version VALUES(1,?)", (value,))
        conn.commit()
        before, changes = objects(conn), conn.total_changes
        conn.execute("PRAGMA query_only=ON")
        if kind == "valid":
            verify_owner_sync_schema(conn)
            assert conn.metadata_rows == [[(1, 1)]]
        else:
            with pytest.raises(sqlite3.DatabaseError, match="core schema version mismatch"):
                verify_owner_sync_schema(conn)
            assert conn.metadata_rows == [[(1, 0)]]
        assert objects(conn) == before and conn.total_changes == changes


def test_many_metadata_rows_are_bounded_even_when_check_constraints_were_bypassed():
    with closing(prepared_candidate()) as conn:
        conn.execute(VERSION_DDL)
        conn.execute("PRAGMA ignore_check_constraints=ON")
        conn.executemany("INSERT INTO _schema_version VALUES(?,9)", ((value,) for value in range(1, 1025)))
        conn.commit()
        before, changes = objects(conn), conn.total_changes
        conn.execute("PRAGMA query_only=ON")
        with pytest.raises(sqlite3.DatabaseError, match="core schema version mismatch"):
            verify_owner_sync_schema(conn)
        rows = conn.metadata_rows
        assert len(rows) == 1 and len(rows[0]) == 2
        assert objects(conn) == before and conn.total_changes == changes


@pytest.mark.parametrize("singleton", [None, 2])
def test_missing_or_wrong_singleton_is_not_accepted_as_exact_metadata(singleton):
    with closing(prepared_candidate()) as conn:
        conn.execute(VERSION_DDL)
        if singleton is not None:
            conn.execute("PRAGMA ignore_check_constraints=ON")
            conn.execute("INSERT INTO _schema_version VALUES(?,9)", (singleton,))
        conn.commit()
        with pytest.raises(sqlite3.DatabaseError, match="core schema version mismatch"):
            verify_owner_sync_schema(conn)
        assert conn.metadata_rows == ([[]] if singleton is None else [[(0, 1)]])


@pytest.mark.parametrize("fault", ["core", "extension"])
def test_valid_core_metadata_never_substitutes_for_exact_remaining_schema(fault):
    with closing(prepared_candidate()) as conn:
        conn.execute(VERSION_DDL)
        conn.execute("INSERT INTO _schema_version VALUES(1,9)")
        if fault == "core":
            index_name = next(name for object_type, name in expected_objects() if object_type == "index")
            conn.execute('DROP INDEX "' + index_name + '"')
        else:
            conn.execute("DROP TABLE owner_sync_receipts")
        conn.commit()
        before, changes = objects(conn), conn.total_changes
        with pytest.raises(sqlite3.DatabaseError):
            verify_owner_sync_schema(conn)
        assert conn.metadata_rows == [[(1, 1)]]
        assert objects(conn) == before and conn.total_changes == changes
