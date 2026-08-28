"""SQLite connection management and schema initialization.

Connections are short-lived and configured consistently so concurrent FastAPI
worker threads fail predictably instead of immediately raising ``database is
locked``. Startup remains local-only and never performs network I/O.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

log = logging.getLogger(__name__)

DB_PATH = os.environ.get(
    "FUND_DB",
    str(Path(__file__).resolve().parent.parent / "fund_compass.db"),
)

DEFAULT_TIMEOUT_SECONDS = 8.0
MAX_TIMEOUT_SECONDS = 60.0
V8_SCHEMA_VERSION = 8

SCHEMA = """
CREATE TABLE IF NOT EXISTS funds (
  code   TEXT PRIMARY KEY,
  name   TEXT,
  type   TEXT,
  pinyin TEXT
);
CREATE INDEX IF NOT EXISTS idx_funds_type ON funds(type);

CREATE TABLE IF NOT EXISTS fund_detail (
  code             TEXT PRIMARY KEY,
  name             TEXT,
  type             TEXT,
  scale            REAL,
  buy_rate         REAL,
  source_rate      REAL,
  ret_1m           REAL,
  ret_6m           REAL,
  ret_1y           REAL,
  ret_3y           REAL,
  rank_in_type     INTEGER,
  rank_total       INTEGER,
  manager          TEXT,
  manager_id       TEXT,
  manager_worktime TEXT,
  latest_nav       REAL,
  latest_nav_date  TEXT,
  source           TEXT,
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS nav_history (
  code      TEXT,
  date      TEXT,
  nav       REAL,
  ac_return REAL,
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS watchlist (
  code     TEXT PRIMARY KEY,
  added_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,
  name             TEXT,
  type             TEXT,
  decision_date    TEXT NOT NULL,
  base_nav         REAL NOT NULL,
  action           TEXT NOT NULL,
  confidence       TEXT,
  strategy_version TEXT NOT NULL,
  score_version    TEXT,
  signal_version   TEXT,
  score_coverage   REAL,
  signal_coverage  REAL,
  evidence_strength TEXT,
  region           TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(code, decision_date, strategy_version)
);
CREATE INDEX IF NOT EXISTS idx_decision_history_date ON decision_history(decision_date);

CREATE TABLE IF NOT EXISTS portfolio_decision_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date    TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  items_json       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE(snapshot_date, strategy_version)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_decision_date ON portfolio_decision_history(snapshot_date);

CREATE TABLE IF NOT EXISTS idempotency_requests (
  request_id TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


V8_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS evidence_snapshots (
      evidence_id              TEXT PRIMARY KEY,
      fund_code                TEXT NOT NULL,
      fund_name                TEXT,
      fund_type                TEXT,
      created_at               TEXT NOT NULL,
      market_time              TEXT,
      official_nav             REAL,
      official_nav_date        TEXT,
      target_nav_date          TEXT,
      benchmark_id             TEXT,
      valuation_percentile     REAL,
      trend_state              TEXT,
      momentum_state           TEXT,
      drawdown                 REAL,
      volatility               REAL,
      market_temperature       REAL,
      score                    REAL,
      score_version            TEXT,
      score_coverage           REAL NOT NULL CHECK(score_coverage >= 0 AND score_coverage <= 1),
      timing_signal            TEXT,
      timing_coverage          REAL NOT NULL CHECK(timing_coverage >= 0 AND timing_coverage <= 1),
      estimate                 REAL,
      estimate_status          TEXT NOT NULL,
      estimate_coverage        REAL,
      estimate_model_version   TEXT,
      estimate_error_p80       REAL,
      estimate_sample_count    INTEGER,
      estimate_mae             REAL,
      estimate_direction_accuracy REAL,
      evidence_strength        REAL NOT NULL CHECK(evidence_strength >= 0 AND evidence_strength <= 100),
      source_states_json       TEXT NOT NULL,
      evidence_nodes_json      TEXT NOT NULL,
      missing_fields_json      TEXT NOT NULL,
      stale_fields_json        TEXT NOT NULL,
      risk_flags_json          TEXT NOT NULL,
      payload_json             TEXT NOT NULL,
      payload_sha256           TEXT NOT NULL UNIQUE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_evidence_fund_created ON evidence_snapshots(fund_code, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_evidence_target_nav_date ON evidence_snapshots(target_nav_date)",
    """
    CREATE TABLE IF NOT EXISTS source_health_events (
      event_id          TEXT PRIMARY KEY,
      evidence_id       TEXT NOT NULL REFERENCES evidence_snapshots(evidence_id) ON DELETE RESTRICT,
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
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_source_health_source_observed ON source_health_events(source_id, observed_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS holding_versions (
      holding_version  TEXT PRIMARY KEY,
      fund_code        TEXT NOT NULL,
      user_state       TEXT NOT NULL CHECK(user_state IN ('unheld', 'held')),
      shares           REAL,
      cost             REAL,
      market_value     REAL,
      account          TEXT,
      current_weight   REAL CHECK(current_weight IS NULL OR (current_weight >= 0 AND current_weight <= 100)),
      target_weight    REAL CHECK(target_weight IS NULL OR (target_weight >= 0 AND target_weight <= 100)),
      updated_at       TEXT,
      source           TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      payload_json     TEXT NOT NULL,
      payload_sha256   TEXT NOT NULL UNIQUE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_holding_fund_created ON holding_versions(fund_code, created_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS portfolio_policy_versions (
      policy_version          TEXT PRIMARY KEY,
      name                    TEXT NOT NULL,
      target_allocations_json TEXT NOT NULL,
      target_ranges_json      TEXT NOT NULL,
      max_single_fund_weight  REAL,
      max_theme_weight        REAL,
      rebalance_band          REAL,
      dca_rules_json          TEXT NOT NULL,
      reduce_rules_json       TEXT NOT NULL,
      sell_rules_json         TEXT NOT NULL,
      effective_at            TEXT NOT NULL,
      created_at              TEXT NOT NULL,
      source                  TEXT NOT NULL,
      supersedes              TEXT REFERENCES portfolio_policy_versions(policy_version) ON DELETE RESTRICT,
      payload_json            TEXT NOT NULL,
      payload_sha256          TEXT NOT NULL UNIQUE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_policy_effective ON portfolio_policy_versions(effective_at DESC, created_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS decision_snapshots (
      decision_id            TEXT PRIMARY KEY,
      evidence_id            TEXT NOT NULL REFERENCES evidence_snapshots(evidence_id) ON DELETE RESTRICT,
      fund_code              TEXT NOT NULL,
      holding_version        TEXT NOT NULL REFERENCES holding_versions(holding_version) ON DELETE RESTRICT,
      policy_version         TEXT NOT NULL REFERENCES portfolio_policy_versions(policy_version) ON DELETE RESTRICT,
      strategy_version       TEXT NOT NULL,
      user_state             TEXT NOT NULL CHECK(user_state IN ('unheld', 'held')),
      action                 TEXT NOT NULL CHECK(action IN ('buy','dca','watch','add','hold','reduce','sell')),
      strength               INTEGER NOT NULL CHECK(strength >= 0 AND strength <= 100),
      confidence             INTEGER NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
      summary                TEXT NOT NULL,
      reason_codes_json      TEXT NOT NULL,
      reasons_json           TEXT NOT NULL,
      risks_json             TEXT NOT NULL,
      invalidation_codes_json TEXT NOT NULL,
      invalidation_json      TEXT NOT NULL,
      position_guidance_json TEXT,
      evidence_nodes_json    TEXT NOT NULL,
      created_at             TEXT NOT NULL,
      payload_json           TEXT NOT NULL,
      payload_sha256         TEXT NOT NULL UNIQUE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_decision_fund_created ON decision_snapshots(fund_code, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_decision_versions ON decision_snapshots(strategy_version, policy_version, holding_version)",
    """
    CREATE TABLE IF NOT EXISTS outcome_evaluations (
      outcome_id             TEXT PRIMARY KEY,
      decision_id            TEXT NOT NULL REFERENCES decision_snapshots(decision_id) ON DELETE RESTRICT,
      evaluation_kind        TEXT NOT NULL CHECK(evaluation_kind IN ('horizon', 'qdii_target')),
      horizon                INTEGER NOT NULL CHECK(horizon IN (0, 5, 20, 60)),
      base_nav_date          TEXT NOT NULL,
      evaluation_date        TEXT NOT NULL,
      target_nav_date        TEXT,
      base_nav               REAL NOT NULL CHECK(base_nav > 0),
      evaluated_nav          REAL NOT NULL CHECK(evaluated_nav > 0),
      absolute_return        REAL NOT NULL,
      benchmark_return       REAL,
      peer_excess            REAL,
      max_drawdown           REAL NOT NULL,
      hit                    INTEGER NOT NULL CHECK(hit IN (0, 1)),
      benchmark_samples      INTEGER NOT NULL DEFAULT 0,
      predicted_change       REAL,
      prediction_error       REAL,
      created_at             TEXT NOT NULL,
      payload_json           TEXT NOT NULL,
      payload_sha256         TEXT NOT NULL UNIQUE,
      UNIQUE(decision_id, evaluation_kind, horizon)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_outcome_decision_horizon ON outcome_evaluations(decision_id, horizon)",
    "CREATE INDEX IF NOT EXISTS idx_outcome_evaluation_date ON outcome_evaluations(evaluation_date)",
    """
    CREATE TABLE IF NOT EXISTS portfolio_decision_snapshots (
      portfolio_decision_id TEXT PRIMARY KEY,
      decision_date         TEXT NOT NULL,
      policy_version        TEXT NOT NULL REFERENCES portfolio_policy_versions(policy_version) ON DELETE RESTRICT,
      strategy_version      TEXT NOT NULL,
      component_count       INTEGER NOT NULL CHECK(component_count > 0 AND component_count <= 50),
      current_cash_weight   REAL NOT NULL CHECK(current_cash_weight >= 0 AND current_cash_weight <= 100),
      target_cash_weight    REAL NOT NULL CHECK(target_cash_weight >= 0 AND target_cash_weight <= 100),
      portfolio_value       REAL CHECK(portfolio_value IS NULL OR portfolio_value >= 0),
      components_json       TEXT NOT NULL,
      source                TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      payload_json          TEXT NOT NULL,
      payload_sha256        TEXT NOT NULL UNIQUE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_portfolio_decision_snapshot_created ON portfolio_decision_snapshots(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_portfolio_decision_snapshot_versions ON portfolio_decision_snapshots(strategy_version, policy_version)",
    """
    CREATE TABLE IF NOT EXISTS portfolio_outcome_evaluations (
      outcome_id            TEXT PRIMARY KEY,
      portfolio_decision_id TEXT NOT NULL REFERENCES portfolio_decision_snapshots(portfolio_decision_id) ON DELETE RESTRICT,
      horizon               INTEGER NOT NULL CHECK(horizon IN (5, 20, 60)),
      base_nav_date         TEXT NOT NULL,
      evaluation_date       TEXT NOT NULL,
      absolute_return       REAL NOT NULL,
      max_drawdown          REAL NOT NULL CHECK(max_drawdown >= -100 AND max_drawdown <= 0),
      current_cash_weight   REAL NOT NULL CHECK(current_cash_weight >= 0 AND current_cash_weight <= 100),
      cash_return           REAL NOT NULL CHECK(cash_return = 0),
      cash_contribution     REAL NOT NULL CHECK(cash_contribution = 0),
      components_json       TEXT NOT NULL,
      method                TEXT NOT NULL CHECK(method = 'common_nav_dates_no_forward_fill'),
      created_at            TEXT NOT NULL,
      payload_json          TEXT NOT NULL,
      payload_sha256        TEXT NOT NULL UNIQUE,
      UNIQUE(portfolio_decision_id, horizon)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_portfolio_outcome_decision ON portfolio_outcome_evaluations(portfolio_decision_id, horizon)",
    "CREATE INDEX IF NOT EXISTS idx_portfolio_outcome_evaluation_date ON portfolio_outcome_evaluations(evaluation_date)",
    """
    CREATE TABLE IF NOT EXISTS notification_events (
      event_log_id          TEXT PRIMARY KEY,
      notification_event_id TEXT NOT NULL,
      decision_id           TEXT NOT NULL REFERENCES decision_snapshots(decision_id) ON DELETE RESTRICT,
      scheduled_window      TEXT NOT NULL,
      status                TEXT NOT NULL CHECK(status IN ('scheduled','skipped','attempted','sent','failed','compensated')),
      attempt_no            INTEGER NOT NULL CHECK(attempt_no >= 0),
      natural_schedule      INTEGER NOT NULL CHECK(natural_schedule IN (0, 1)),
      occurred_at           TEXT NOT NULL,
      error_class           TEXT,
      detail_json           TEXT NOT NULL,
      UNIQUE(notification_event_id, status, attempt_no, natural_schedule)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_notification_event ON notification_events(notification_event_id, occurred_at)",
    "CREATE INDEX IF NOT EXISTS idx_notification_decision ON notification_events(decision_id, occurred_at)",
    """
    CREATE TABLE IF NOT EXISTS idempotency_responses (
      request_id       TEXT NOT NULL,
      endpoint         TEXT NOT NULL,
      request_sha256   TEXT NOT NULL,
      state            TEXT NOT NULL CHECK(state IN ('in_progress', 'complete')),
      response_json    TEXT,
      owner_token      TEXT,
      lease_expires_at TEXT,
      created_at       TEXT NOT NULL,
      completed_at     TEXT,
      PRIMARY KEY(request_id, endpoint)
    )
    """,
)


V8_IMMUTABLE_TABLES = (
    "evidence_snapshots",
    "source_health_events",
    "holding_versions",
    "portfolio_policy_versions",
    "decision_snapshots",
    "outcome_evaluations",
    "portfolio_decision_snapshots",
    "portfolio_outcome_evaluations",
    "notification_events",
)


def _misconfigured_persistence(warning: str) -> dict:
    """Return a path-free persistent-disk configuration warning."""
    return {
        "engine": "sqlite",
        "persistence": "misconfigured",
        "durable": False,
        "warning": warning,
    }


def _persistent_disk_status() -> dict:
    """Verify that SQLite is configured on a real, writable mount point."""
    raw_db_path = os.environ.get("FUND_DB", "").strip()
    raw_mount_path = os.environ.get("FUND_DB_MOUNT_PATH", "").strip()
    if not raw_db_path:
        return _misconfigured_persistence(
            "持久盘模式缺少显式数据库文件配置，无法确认数据库可持久化",
        )
    if not raw_mount_path:
        return _misconfigured_persistence(
            "持久盘模式缺少显式挂载目录配置，无法确认数据库可持久化",
        )

    try:
        db_path = Path(raw_db_path).expanduser()
        mount_path = Path(raw_mount_path).expanduser()
        if not db_path.is_absolute() or not mount_path.is_absolute():
            return _misconfigured_persistence(
                "持久盘路径必须使用绝对路径，无法确认数据库可持久化",
            )
        db_path = db_path.resolve(strict=False)
        mount_path = mount_path.resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return _misconfigured_persistence(
            "持久盘路径配置无效，无法确认数据库可持久化",
        )

    if mount_path == Path(mount_path.anchor):
        return _misconfigured_persistence(
            "根文件系统不能作为持久盘挂载目录，无法确认数据库可持久化",
        )
    if db_path == mount_path or mount_path not in db_path.parents:
        return _misconfigured_persistence(
            "数据库文件未位于声明的持久盘内，无法确认数据库可持久化",
        )

    try:
        if not mount_path.exists() or not mount_path.is_dir():
            return _misconfigured_persistence(
                "声明的持久盘当前不可用，无法确认数据库可持久化",
            )
        if not os.path.ismount(mount_path):
            return _misconfigured_persistence(
                "声明的持久盘目录不是系统挂载点，无法确认数据库可持久化",
            )
        if not os.access(mount_path, os.W_OK | os.X_OK):
            return _misconfigured_persistence(
                "声明的持久盘不可写，无法确认数据库可持久化",
            )
    except OSError:
        return _misconfigured_persistence(
            "无法验证持久盘状态，无法确认数据库可持久化",
        )

    return {
        "engine": "sqlite",
        "persistence": "persistent_disk",
        "durable": True,
        "warning": None,
    }


def persistence_status() -> dict:
    """Return verified, non-sensitive SQLite durability metadata."""
    mode = os.environ.get("FUND_DB_PERSISTENCE", "").strip().lower()
    if mode == "persistent_disk":
        return _persistent_disk_status()
    if mode == "ephemeral":
        return {
            "engine": "sqlite",
            "persistence": "ephemeral",
            "durable": False,
            "warning": "数据库位于临时存储，实例重建后数据可能丢失",
        }
    return {
        "engine": "sqlite",
        "persistence": "unspecified",
        "durable": False,
        "warning": "未声明 FUND_DB_PERSISTENCE，不能确认数据库可持久",
    }


def _timeout_seconds() -> float:
    raw = os.environ.get("FUND_DB_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))
    try:
        value = float(raw)
    except (TypeError, ValueError):
        log.warning("invalid FUND_DB_TIMEOUT_SECONDS=%r; using %.1fs", raw, DEFAULT_TIMEOUT_SECONDS)
        return DEFAULT_TIMEOUT_SECONDS
    return min(MAX_TIMEOUT_SECONDS, max(0.1, value))


def _ensure_parent_directory(path: str) -> None:
    if path == ":memory:" or path.startswith("file:"):
        return
    Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)


def _database_file() -> Path | None:
    """Return a concrete SQLite file path when DB_PATH is file-backed."""
    if DB_PATH == ":memory:" or DB_PATH.startswith("file:"):
        return None
    try:
        return Path(DB_PATH).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _portfolio_outcome_schema_needs_repair(conn: sqlite3.Connection) -> bool:
    if not conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='portfolio_outcome_evaluations'"
    ).fetchone():
        return False
    columns = {row[1] for row in conn.execute("PRAGMA table_info(portfolio_outcome_evaluations)")}
    required_columns = {
        "outcome_id",
        "portfolio_decision_id",
        "horizon",
        "base_nav_date",
        "evaluation_date",
        "absolute_return",
        "max_drawdown",
        "current_cash_weight",
        "cash_return",
        "cash_contribution",
        "components_json",
        "method",
        "created_at",
        "payload_json",
        "payload_sha256",
    }
    if not required_columns <= columns:
        return True
    foreign_key_ok = any(
        row[2] == "portfolio_decision_snapshots" and row[3] == "portfolio_decision_id"
        for row in conn.execute("PRAGMA foreign_key_list(portfolio_outcome_evaluations)")
    )
    unique_ok = False
    for index in conn.execute("PRAGMA index_list(portfolio_outcome_evaluations)"):
        if not index[2]:
            continue
        index_columns = [
            row[2] for row in conn.execute(f"PRAGMA index_info('{index[1]}')")
        ]
        if index_columns == ["portfolio_decision_id", "horizon"]:
            unique_ok = True
            break
    return not foreign_key_ok or not unique_ok


def _backup_before_v8_migration() -> Path | None:
    """Create and verify a point-in-time backup before changing an old DB.

    A brand-new/empty database needs no backup.  The user version prevents a
    new backup from being created on every process restart.
    """
    source_path = _database_file()
    if source_path is None or not source_path.exists() or source_path.stat().st_size == 0:
        return None
    source = sqlite3.connect(str(source_path), timeout=_timeout_seconds())
    try:
        version = int(source.execute("PRAGMA user_version").fetchone()[0])
        table_count = int(source.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()[0])
        portfolio_snapshot_missing = not source.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='portfolio_decision_snapshots'"
        ).fetchone()
        schema_repair = (
            portfolio_snapshot_missing
            or _portfolio_outcome_schema_needs_repair(source)
        )
        if (version >= V8_SCHEMA_VERSION and not schema_repair) or table_count == 0:
            return None
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_path = source_path.with_name(f"{source_path.name}.pre-v8-{stamp}.bak")
        suffix = 1
        while backup_path.exists():
            backup_path = source_path.with_name(f"{source_path.name}.pre-v8-{stamp}-{suffix}.bak")
            suffix += 1
        backup = sqlite3.connect(str(backup_path))
        try:
            source.backup(backup)
            check = backup.execute("PRAGMA quick_check(1)").fetchone()[0]
            if check != "ok":
                raise sqlite3.DatabaseError(f"pre-v8 backup quick_check failed: {check}")
        except Exception:
            backup.close()
            try:
                backup_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        else:
            backup.close()
        log.info("created verified pre-v8 SQLite backup: %s", backup_path.name)
        return backup_path
    finally:
        source.close()


def get_conn() -> sqlite3.Connection:
    """Return a consistently configured SQLite connection.

    ``busy_timeout`` makes short write bursts wait instead of failing
    immediately. Foreign keys are enabled per connection because SQLite does
    not persist that setting in the database file.
    """
    _ensure_parent_directory(DB_PATH)
    timeout = _timeout_seconds()
    conn = sqlite3.connect(DB_PATH, timeout=timeout, uri=DB_PATH.startswith("file:"))
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {int(timeout * 1000)}")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def transaction(*, immediate: bool = False) -> Iterator[sqlite3.Connection]:
    """Commit on success and always roll back an incomplete write on failure.

    ``immediate`` acquires SQLite's reserved write lock before the first read.
    It is used for claim/check/insert sequences where two workers must never
    both observe an unclaimed row.
    """
    conn = get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotent additive migrations for databases created by old versions."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(fund_detail)")}
    if "source" not in cols:
        conn.execute("ALTER TABLE fund_detail ADD COLUMN source TEXT")
    if "manager_id" not in cols:
        conn.execute("ALTER TABLE fund_detail ADD COLUMN manager_id TEXT")
    decision_cols = {r["name"] for r in conn.execute("PRAGMA table_info(decision_history)")}
    for name, sql_type in (
        ("score_version", "TEXT"), ("signal_version", "TEXT"),
        ("score_coverage", "REAL"), ("signal_coverage", "REAL"),
        ("evidence_strength", "TEXT"), ("region", "TEXT"),
    ):
        if name not in decision_cols:
            conn.execute(f"ALTER TABLE decision_history ADD COLUMN {name} {sql_type}")

    version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    repaired_portfolio_outcome = False
    if _portfolio_outcome_schema_needs_repair(conn):
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='portfolio_outcome_evaluations_legacy_v8'"
        ).fetchone():
            raise sqlite3.DatabaseError("legacy portfolio outcome preservation table already exists")
        conn.execute("DROP TRIGGER IF EXISTS immutable_portfolio_outcome_evaluations_update")
        conn.execute("DROP TRIGGER IF EXISTS immutable_portfolio_outcome_evaluations_delete")
        # An explicit index follows a renamed table. Drop it before the rename
        # so CREATE INDEX below cannot be shadowed by a legacy-table index with
        # the same global SQLite name.
        conn.execute("DROP INDEX IF EXISTS idx_portfolio_outcome_decision")
        conn.execute("DROP INDEX IF EXISTS idx_portfolio_outcome_evaluation_date")
        conn.execute(
            "ALTER TABLE portfolio_outcome_evaluations RENAME TO portfolio_outcome_evaluations_legacy_v8"
        )
        repaired_portfolio_outcome = True
    for statement in V8_SCHEMA_STATEMENTS:
        conn.execute(statement)
    idempotency_cols = {
        row["name"] for row in conn.execute("PRAGMA table_info(idempotency_responses)")
    }
    for name in ("owner_token", "lease_expires_at"):
        if name not in idempotency_cols:
            conn.execute(f"ALTER TABLE idempotency_responses ADD COLUMN {name} TEXT")
    for table in V8_IMMUTABLE_TABLES:
        conn.execute(f"""
            CREATE TRIGGER IF NOT EXISTS immutable_{table}_update
            BEFORE UPDATE ON {table}
            BEGIN
              SELECT RAISE(ABORT, '{table} is immutable');
            END
        """)
        conn.execute(f"""
            CREATE TRIGGER IF NOT EXISTS immutable_{table}_delete
            BEFORE DELETE ON {table}
            BEGIN
              SELECT RAISE(ABORT, '{table} is immutable');
            END
        """)
    if repaired_portfolio_outcome:
        for operation in ("UPDATE", "DELETE"):
            conn.execute(f"""
                CREATE TRIGGER immutable_portfolio_outcome_legacy_{operation.lower()}
                BEFORE {operation} ON portfolio_outcome_evaluations_legacy_v8
                BEGIN
                  SELECT RAISE(ABORT, 'legacy portfolio outcomes are immutable');
                END
            """)
    if version < V8_SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {V8_SCHEMA_VERSION}")


def init_db() -> None:
    """Initialize schema and durable SQLite settings.

    WAL allows readers to continue while a writer commits. If the environment
    cannot enable WAL, initialization continues with SQLite's current journal
    mode and logs the degradation.
    """
    _backup_before_v8_migration()
    settings = get_conn()
    try:
        try:
            journal_mode = settings.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            if str(journal_mode).lower() != "wal":
                log.warning("SQLite WAL unavailable; journal_mode=%s", journal_mode)
        except sqlite3.DatabaseError as exc:
            log.warning("SQLite WAL setup failed; continuing with current mode: %s", exc)
        settings.execute("PRAGMA synchronous = NORMAL")
    finally:
        settings.close()
    with transaction(immediate=True) as conn:
        # sqlite3.executescript() commits an open transaction before running,
        # which would make a partially failed migration unrecoverable.  The
        # legacy schema contains only standalone CREATE statements, so execute
        # them one by one inside the same explicit migration transaction.
        for statement in SCHEMA.split(";"):
            if statement.strip():
                conn.execute(statement)
        _migrate(conn)
        foreign_key_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_key_errors:
            raise sqlite3.DatabaseError(f"SQLite foreign_key_check failed: {len(foreign_key_errors)} row(s)")
        check = conn.execute("PRAGMA quick_check(1)").fetchone()[0]
        if check != "ok":
            raise sqlite3.DatabaseError(f"SQLite quick_check failed: {check}")
        conn.execute("PRAGMA optimize")
