import sqlite3
from pathlib import Path

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


def test_pre_v8_backup_restores_side_by_side_and_migrates(tmp_path, monkeypatch):
    from database import db

    source_path = tmp_path / "source-legacy.db"
    source = sqlite3.connect(source_path)
    source.execute("CREATE TABLE fund_detail(code TEXT PRIMARY KEY, name TEXT)")
    source.executemany(
        "INSERT INTO fund_detail(code,name) VALUES(?,?)",
        [("000001", "恢复样本一"), ("000002", "恢复样本二")],
    )
    source.commit()
    source.close()
    monkeypatch.setattr(db, "DB_PATH", str(source_path))

    db.init_db()
    backups = list(tmp_path.glob("source-legacy.db.pre-v8-*.bak"))
    assert len(backups) == 1

    restored_path = tmp_path / "side-by-side" / "restored.db"
    restored_path.parent.mkdir()
    backup = sqlite3.connect(backups[0])
    restored = sqlite3.connect(restored_path)
    try:
        assert backup.execute("PRAGMA user_version").fetchone()[0] == 0
        assert backup.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
        assert backup.execute("PRAGMA integrity_check(1)").fetchone()[0] == "ok"
        assert backup.execute("PRAGMA foreign_key_check").fetchall() == []
        backup.backup(restored)
    finally:
        restored.close()
        backup.close()

    monkeypatch.setattr(db, "DB_PATH", str(restored_path))
    db.init_db()
    with db.get_conn() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION
        assert [
            tuple(row)
            for row in conn.execute("SELECT code,name FROM fund_detail ORDER BY code")
        ] == [("000001", "恢复样本一"), ("000002", "恢复样本二")]
        assert conn.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA integrity_check(1)").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert len(list(restored_path.parent.glob("restored.db.pre-v8-*.bak"))) == 1

    original = sqlite3.connect(source_path)
    try:
        assert original.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION
        assert original.execute("SELECT COUNT(*) FROM fund_detail").fetchone()[0] == 2
    finally:
        original.close()


def test_existing_legacy_migration_failure_preserves_source_and_backup(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "legacy-failure.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE fund_detail(code TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO fund_detail(code,name) VALUES('000001','不能丢失')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", str(path))
    original_migrate = db._migrate

    def fail_after_real_migration(connection):
        original_migrate(connection)
        raise sqlite3.DatabaseError("synthetic post-migration verification failure")

    monkeypatch.setattr(db, "_migrate", fail_after_real_migration)
    with pytest.raises(sqlite3.DatabaseError, match="synthetic post-migration"):
        db.init_db()

    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert [row[1] for row in conn.execute("PRAGMA table_info(fund_detail)")] == [
            "code", "name",
        ]
        assert conn.execute(
            "SELECT name FROM fund_detail WHERE code='000001'"
        ).fetchone()[0] == "不能丢失"
        assert _table_names(conn) == {"fund_detail"}
    finally:
        conn.close()
    backups = list(tmp_path.glob("legacy-failure.db.pre-v8-*.bak"))
    assert len(backups) == 1
    backup = sqlite3.connect(backups[0])
    try:
        assert backup.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
        assert backup.execute("SELECT COUNT(*) FROM fund_detail").fetchone()[0] == 1
    finally:
        backup.close()


def test_pre_v8_backup_rejects_foreign_key_damage_without_mutating_source(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "orphaned-legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        PRAGMA foreign_keys=OFF;
        CREATE TABLE parent(id TEXT PRIMARY KEY);
        CREATE TABLE child(
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id)
        );
        INSERT INTO child(id,parent_id) VALUES('child-1','missing-parent');
    """)
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", str(path))

    with pytest.raises(
        sqlite3.DatabaseError,
        match=r"pre-v8 backup foreign_key_check failed: 1 row\(s\)",
    ):
        db.init_db()

    assert list(tmp_path.glob("orphaned-legacy.db.pre-v8-*.bak")) == []
    assert list(tmp_path.glob("*.partial")) == []
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert conn.execute("SELECT parent_id FROM child").fetchone()[0] == "missing-parent"
        assert _table_names(conn) == {"parent", "child"}
    finally:
        conn.close()


def test_v8_startup_rejects_existing_foreign_key_damage(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "orphaned-v8.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute(
        """INSERT INTO source_health_events(
             event_id,evidence_id,source_id,state,last_success,last_failure,
             latency_ms,data_age_seconds,stale,error_class,observed_at,payload_json
           ) VALUES(?,?,?,?,NULL,NULL,NULL,NULL,1,NULL,?,?)""",
        (
            "orphan-event",
            "ev_missing",
            "orphan-source",
            "unavailable",
            "2026-08-25T00:00:00+00:00",
            "{}",
        ),
    )
    conn.commit()
    conn.close()

    with pytest.raises(
        sqlite3.DatabaseError,
        match=r"SQLite foreign_key_check failed: 1 row\(s\)",
    ):
        db.init_db()

    assert list(tmp_path.glob("orphaned-v8.db.pre-v8-*.bak")) == []
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION
        assert conn.execute(
            "SELECT evidence_id FROM source_health_events WHERE event_id='orphan-event'"
        ).fetchone()[0] == "ev_missing"
    finally:
        conn.close()


def test_v8_column_repair_is_backed_up_before_alter(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "v8-column-repair.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    conn = sqlite3.connect(path)
    conn.execute("ALTER TABLE idempotency_responses DROP COLUMN owner_token")
    conn.execute("ALTER TABLE idempotency_responses DROP COLUMN lease_expires_at")
    conn.commit()
    conn.close()

    db.init_db()

    backups = list(tmp_path.glob("v8-column-repair.db.pre-v8-*.bak"))
    assert len(backups) == 1
    backup = sqlite3.connect(backups[0])
    try:
        assert {
            row[1] for row in backup.execute("PRAGMA table_info(idempotency_responses)")
        }.isdisjoint({"owner_token", "lease_expires_at"})
    finally:
        backup.close()
    conn = db.get_conn()
    try:
        assert {"owner_token", "lease_expires_at"} <= {
            row["name"] for row in conn.execute("PRAGMA table_info(idempotency_responses)")
        }
    finally:
        conn.close()


def test_v8_missing_required_column_fails_closed_after_verified_backup(
    tmp_path,
    monkeypatch,
):
    from database import db

    path = tmp_path / "v8-missing-summary.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE decision_snapshots DROP COLUMN summary")
        schema_before = conn.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
        ).fetchall()

    with pytest.raises(
        sqlite3.DatabaseError,
        match=r"decision_snapshots missing columns: summary",
    ):
        db.init_db()

    backups = list(tmp_path.glob("v8-missing-summary.db.pre-v8-*.bak"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
        assert "summary" not in {
            row[1] for row in backup.execute("PRAGMA table_info(decision_snapshots)")
        }

    with sqlite3.connect(path) as source:
        assert source.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
        ).fetchall() == schema_before
        assert source.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION
    assert list(tmp_path.glob("*.partial")) == []


def test_v8_wrong_named_index_definition_fails_closed(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "v8-wrong-index.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with sqlite3.connect(path) as conn:
        conn.execute("DROP INDEX idx_decision_versions")
        conn.execute(
            "CREATE INDEX idx_decision_versions ON decision_snapshots(fund_code)"
        )

    with pytest.raises(
        sqlite3.DatabaseError,
        match=r"idx_decision_versions index definition mismatch",
    ):
        db.init_db()

    assert len(list(tmp_path.glob("v8-wrong-index.db.pre-v8-*.bak"))) == 1
    with sqlite3.connect(path) as source:
        assert [
            row[2] for row in source.execute("PRAGMA index_info(idx_decision_versions)")
        ] == ["fund_code"]


def test_v8_missing_foreign_key_contract_fails_closed(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "v8-missing-foreign-key.db"
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            PRAGMA foreign_keys=OFF;
            DROP TRIGGER immutable_source_health_events_update;
            DROP TRIGGER immutable_source_health_events_delete;
            DROP INDEX idx_source_health_source_observed;
            DROP TABLE source_health_events;
            CREATE TABLE source_health_events (
              event_id          TEXT PRIMARY KEY,
              evidence_id       TEXT NOT NULL,
              source_id         TEXT NOT NULL,
              state             TEXT NOT NULL,
              last_success      TEXT,
              last_failure      TEXT,
              latency_ms        REAL,
              data_age_seconds  REAL,
              stale             INTEGER NOT NULL CHECK(stale IN (0, 1)),
              error_class       TEXT,
              observed_at       TEXT NOT NULL,
              payload_json      TEXT NOT NULL,
              UNIQUE(evidence_id, source_id)
            );
            CREATE INDEX idx_source_health_source_observed
              ON source_health_events(source_id, observed_at DESC);
            CREATE TRIGGER immutable_source_health_events_update
              BEFORE UPDATE ON source_health_events
              BEGIN
                SELECT RAISE(ABORT, 'source_health_events is immutable');
              END;
            CREATE TRIGGER immutable_source_health_events_delete
              BEFORE DELETE ON source_health_events
              BEGIN
                SELECT RAISE(ABORT, 'source_health_events is immutable');
              END;
        """)

    with pytest.raises(
        sqlite3.DatabaseError,
        match=r"source_health_events missing foreign keys: evidence_id->evidence_snapshots.evidence_id",
    ):
        db.init_db()

    assert len(list(tmp_path.glob("v8-missing-foreign-key.db.pre-v8-*.bak"))) == 1
    with sqlite3.connect(path) as source:
        assert source.execute(
            "PRAGMA foreign_key_list(source_health_events)"
        ).fetchall() == []
        assert source.execute(
            "SELECT 1 FROM sqlite_master WHERE type='trigger' "
            "AND name='immutable_source_health_events_update'"
        ).fetchone() is not None


@pytest.mark.parametrize("filename", ["uri legacy.db", "literal%20.db"])
def test_file_uri_legacy_database_gets_verified_backup(tmp_path, monkeypatch, filename):
    from database import db

    path = tmp_path / filename
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE fund_detail(code TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO fund_detail(code,name) VALUES('000001','URI 旧数据')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", f"{path.resolve().as_uri()}?mode=rwc")

    db.init_db()

    backups = list(tmp_path.glob(f"{filename}.pre-v8-*.bak"))
    assert len(backups) == 1
    backup = sqlite3.connect(backups[0])
    try:
        assert backup.execute(
            "SELECT name FROM fund_detail WHERE code='000001'"
        ).fetchone()[0] == "URI 旧数据"
    finally:
        backup.close()
    with db.get_conn() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION


def test_future_schema_fails_before_backup_or_journal_mutation(tmp_path, monkeypatch):
    from database import db

    path = tmp_path / "future.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE future_only(value TEXT)")
    conn.execute("INSERT INTO future_only(value) VALUES('preserve-me')")
    conn.execute(f"PRAGMA user_version={db.V8_SCHEMA_VERSION + 1}")
    before_journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", str(path))

    with pytest.raises(sqlite3.DatabaseError, match="newer than supported"):
        db.init_db()

    assert list(tmp_path.glob("future.db.pre-v8-*.bak")) == []
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.V8_SCHEMA_VERSION + 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == before_journal
        assert conn.execute("SELECT value FROM future_only").fetchone()[0] == "preserve-me"
        assert _table_names(conn) == {"future_only"}
    finally:
        conn.close()


def test_verified_backup_rename_failure_removes_partial(tmp_path, monkeypatch):
    from database import db

    source_path = tmp_path / "rename-source.db"
    target_path = tmp_path / "rename-target.bak"
    source = sqlite3.connect(source_path)
    source.execute("CREATE TABLE sentinel(value TEXT)")
    source.execute("INSERT INTO sentinel(value) VALUES('safe')")
    source.commit()

    def fail_replace(self, target):
        raise PermissionError("synthetic Windows sharing violation")

    monkeypatch.setattr(Path, "replace", fail_replace)
    try:
        with pytest.raises(PermissionError, match="sharing violation"):
            db._publish_verified_backup(
                source,
                target_path,
                context="rename failure test",
            )
    finally:
        source.close()

    assert target_path.exists() is False
    assert target_path.with_name(f"{target_path.name}.partial").exists() is False
    conn = sqlite3.connect(source_path)
    try:
        assert conn.execute("SELECT value FROM sentinel").fetchone()[0] == "safe"
    finally:
        conn.close()


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
