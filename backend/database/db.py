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
from pathlib import Path
from typing import Iterator

log = logging.getLogger(__name__)

DB_PATH = os.environ.get(
    "FUND_DB",
    str(Path(__file__).resolve().parent.parent / "fund_compass.db"),
)

DEFAULT_TIMEOUT_SECONDS = 8.0
MAX_TIMEOUT_SECONDS = 60.0

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
def transaction() -> Iterator[sqlite3.Connection]:
    """Commit on success and always roll back an incomplete write on failure."""
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Lightweight additive migrations for databases created by old versions."""
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


def init_db() -> None:
    """Initialize schema and durable SQLite settings.

    WAL allows readers to continue while a writer commits. If the environment
    cannot enable WAL, initialization continues with SQLite's current journal
    mode and logs the degradation.
    """
    with transaction() as conn:
        try:
            journal_mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            if str(journal_mode).lower() != "wal":
                log.warning("SQLite WAL unavailable; journal_mode=%s", journal_mode)
        except sqlite3.DatabaseError as exc:
            log.warning("SQLite WAL setup failed; continuing with current mode: %s", exc)
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.executescript(SCHEMA)
        _migrate(conn)
        check = conn.execute("PRAGMA quick_check(1)").fetchone()[0]
        if check != "ok":
            raise sqlite3.DatabaseError(f"SQLite quick_check failed: {check}")
        conn.execute("PRAGMA optimize")
