import sqlite3

import pytest


def _table_names(conn):
    return {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }


def test_v8_migration_backs_up_legacy_database_and_is_idempotent(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE fund_detail(code TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO fund_detail(code,name) VALUES('000001','旧数据')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", str(path))

    db.init_db()

    backups = list(tmp_path.glob("legacy.db.pre-v8-*.bak"))
    assert len(backups) == 1
    backup = sqlite3.connect(backups[0])
    try:
        assert backup.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
        assert backup.execute("SELECT name FROM fund_detail WHERE code='000001'").fetchone()[0] == "旧数据"
    finally:
        backup.close()

    conn = db.get_conn()
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION
        assert {
            "evidence_snapshots", "source_health_events", "holding_versions",
            "portfolio_policy_versions", "decision_snapshots", "outcome_evaluations",
            "portfolio_decision_snapshots", "portfolio_outcome_evaluations",
            "notification_events", "idempotency_responses",
        } <= _table_names(conn)
        assert conn.execute("SELECT name FROM fund_detail WHERE code='000001'").fetchone()[0] == "旧数据"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()

    db.init_db()
    assert len(list(tmp_path.glob("legacy.db.pre-v8-*.bak"))) == 1


def test_v8_snapshot_tables_reject_update_and_delete(tmp_path, monkeypatch):
    from database import db
    from service import v8_repo

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "immutable.db"))
    db.init_db()
    policy = v8_repo.ensure_default_policy()
    conn = db.get_conn()
    try:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute(
                "UPDATE portfolio_policy_versions SET name='覆盖历史' WHERE policy_version=?",
                (policy.policy_version,),
            )
        conn.rollback()
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute(
                "DELETE FROM portfolio_policy_versions WHERE policy_version=?",
                (policy.policy_version,),
            )
    finally:
        conn.close()


def test_migration_preserves_and_replaces_malformed_portfolio_outcome_table(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "malformed-v8.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE portfolio_outcome_evaluations (
          outcome_id TEXT PRIMARY KEY,
          portfolio_key TEXT NOT NULL,
          horizon INTEGER NOT NULL,
          evaluation_date TEXT NOT NULL,
          absolute_return REAL NOT NULL,
          max_drawdown REAL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_sha256 TEXT NOT NULL UNIQUE,
          UNIQUE(portfolio_key, horizon)
        );
        CREATE INDEX idx_portfolio_outcome_decision
          ON portfolio_outcome_evaluations(portfolio_key, horizon);
        CREATE INDEX idx_portfolio_outcome_evaluation_date
          ON portfolio_outcome_evaluations(evaluation_date);
        INSERT INTO portfolio_outcome_evaluations VALUES (
          'old-outcome','legacy-key',20,'2026-08-25',1.0,-2.0,
          '2026-08-25T00:00:00+00:00','{}','legacy-sha'
        );
        PRAGMA user_version=8;
    """)
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", str(path))

    db.init_db()

    conn = db.get_conn()
    try:
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(portfolio_outcome_evaluations)")
        }
        assert "portfolio_decision_id" in columns
        assert "portfolio_key" not in columns
        assert conn.execute(
            "SELECT portfolio_key FROM portfolio_outcome_evaluations_legacy_v8"
        ).fetchone()[0] == "legacy-key"
        assert any(
            row["table"] == "portfolio_decision_snapshots" and row["from"] == "portfolio_decision_id"
            for row in conn.execute("PRAGMA foreign_key_list(portfolio_outcome_evaluations)")
        )
        assert conn.execute(
            "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_portfolio_outcome_decision'"
        ).fetchone()[0] == "portfolio_outcome_evaluations"
        assert conn.execute(
            "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name='idx_portfolio_outcome_evaluation_date'"
        ).fetchone()[0] == "portfolio_outcome_evaluations"
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            conn.execute("DELETE FROM portfolio_outcome_evaluations_legacy_v8")
    finally:
        conn.close()
    assert len(list(tmp_path.glob("malformed-v8.db.pre-v8-*.bak"))) == 1


def test_v8_migration_failure_rolls_back_all_schema_changes(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "failed.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))

    def fail_mid_migration(conn):
        conn.execute("CREATE TABLE should_rollback(value TEXT)")
        raise sqlite3.DatabaseError("synthetic migration failure")

    monkeypatch.setattr(db, "_migrate", fail_mid_migration)
    with pytest.raises(sqlite3.DatabaseError, match="synthetic"):
        db.init_db()

    conn = sqlite3.connect(path)
    try:
        assert _table_names(conn) == set()
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    finally:
        conn.close()
