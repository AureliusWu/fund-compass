"""Candidate schema and routing tests; no external database or credentials."""
import sqlite3

import pytest

from database import db, turso_schema


@pytest.fixture
def local_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    yield conn
    conn.close()


def test_candidate_bootstrap_is_atomic_idempotent_and_preserves_constraints(local_conn):
    assert turso_schema.initialize_candidate(local_conn)["changed"] is True
    assert turso_schema.initialize_candidate(local_conn)["changed"] is False
    assert local_conn.execute("PRAGMA user_version").fetchone()[0] == 0
    assert local_conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 8
    assert local_conn.execute("PRAGMA foreign_key_check").fetchall() == []
    db._verify_v8_schema_contract(local_conn)
    triggers = local_conn.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]
    assert triggers == len(db.V8_IMMUTABLE_TABLES) * 2


def test_remote_startup_will_not_create_schema(local_conn):
    with pytest.raises(sqlite3.DatabaseError, match="initialized explicitly"):
        turso_schema.verify_schema(local_conn)
    assert local_conn.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] == 0


def test_candidate_refuses_incompatible_existing_database_without_writes(local_conn):
    local_conn.execute("CREATE TABLE owner_data(value TEXT)")
    local_conn.execute("INSERT INTO owner_data VALUES('preserve')")
    local_conn.commit()
    with pytest.raises(sqlite3.DatabaseError, match="differs"):
        turso_schema.initialize_candidate(local_conn)
    assert local_conn.execute("SELECT value FROM owner_data").fetchone()[0] == "preserve"
    assert local_conn.execute("SELECT name FROM sqlite_master WHERE name='_schema_version'").fetchone() is None


def test_candidate_rejects_future_version_and_trigger_drift(local_conn):
    turso_schema.initialize_candidate(local_conn)
    local_conn.execute("UPDATE _schema_version SET version=9")
    local_conn.commit()
    with pytest.raises(sqlite3.DatabaseError, match="Unsupported"):
        turso_schema.verify_schema(local_conn)
    local_conn.execute("UPDATE _schema_version SET version=8")
    local_conn.execute("DROP TRIGGER immutable_evidence_snapshots_update")
    local_conn.commit()
    with pytest.raises(sqlite3.DatabaseError, match="differs"):
        turso_schema.verify_schema(local_conn)


def test_candidate_initialization_rolls_back_on_failure(local_conn):
    class FailingConnection:
        def execute(self, sql, args=()):
            if "INSERT INTO _schema_version" in sql:
                raise sqlite3.OperationalError("injected")
            return local_conn.execute(sql, args)

        def commit(self):
            local_conn.commit()

        def rollback(self):
            local_conn.rollback()

    with pytest.raises(sqlite3.OperationalError, match="injected"):
        turso_schema.initialize_candidate(FailingConnection())
    assert local_conn.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] == 0


def test_turso_missing_credentials_never_creates_local_file(tmp_path, monkeypatch):
    path = tmp_path / "must-not-exist.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "turso_candidate")
    monkeypatch.delenv("TURSO_DATABASE_URL", raising=False)
    monkeypatch.delenv("TURSO_AUTH_TOKEN", raising=False)
    with pytest.raises(sqlite3.DatabaseError, match="credentials"):
        db.get_conn()
    assert not path.exists()
    assert db.persistence_status()["durable"] is False


def test_unknown_backend_is_not_silently_treated_as_sqlite(tmp_path, monkeypatch):
    path = tmp_path / "must-not-exist.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    monkeypatch.setenv("FUND_DB_BACKEND", "typo")
    with pytest.raises(sqlite3.DatabaseError, match="Unsupported"):
        db.init_db()
    assert not path.exists()


def test_turso_configuration_alone_cannot_grant_durability(monkeypatch):
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "turso_candidate")
    monkeypatch.setenv("TURSO_DATABASE_URL", "libsql://candidate.example.turso.io")
    monkeypatch.setenv("TURSO_AUTH_TOKEN", "test-only")
    assert db.persistence_status() == {
        "engine": "libsql", "persistence": "turso_candidate", "durable": False,
        "warning": "Turso 候选存储尚未通过生产跨重启读回验收",
    }


def test_remote_health_caches_aggregates_and_invalidates_on_database_change(monkeypatch):
    import main

    monkeypatch.setattr(main, "_health_summary_cache", None)
    monkeypatch.setattr(main, "database_backend", lambda: "turso")
    monkeypatch.setenv("TURSO_DATABASE_URL", "libsql://first.example.turso.io")
    calls = []
    monkeypatch.setattr(main.repo, "universe_count", lambda: calls.append(1) or 12)
    monkeypatch.setattr(main.repo, "public_operations_status", lambda: {"cache": {}})
    for _ in range(5):
        assert main._public_database_summary()[0] == 12
    assert len(calls) == 1
    monkeypatch.setenv("TURSO_DATABASE_URL", "libsql://second.example.turso.io")
    main._public_database_summary()
    assert len(calls) == 2


def test_remote_health_does_not_serve_expired_summary_on_failure(monkeypatch):
    import main

    monkeypatch.setattr(main, "_health_summary_cache", None)
    monkeypatch.setattr(main, "database_backend", lambda: "turso")
    clock = [0.0]
    monkeypatch.setattr(main.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(main.repo, "universe_count", lambda: 12)
    monkeypatch.setattr(main.repo, "public_operations_status", lambda: {})
    main._public_database_summary()
    clock[0] = main.HEALTH_SUMMARY_TTL_SECONDS + 1

    def unavailable():
        raise sqlite3.OperationalError("unavailable")

    monkeypatch.setattr(main.repo, "universe_count", unavailable)
    with pytest.raises(sqlite3.OperationalError):
        main._public_database_summary()
