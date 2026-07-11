"""SQLite 连接与建表。M1：基金universe、详情缓存、净值历史。"""
import os
import sqlite3
from pathlib import Path

DB_PATH = os.environ.get(
    "FUND_DB",
    str(Path(__file__).resolve().parent.parent / "fund_compass.db"),
)

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
  scale            REAL,   -- 最新规模（亿元）
  buy_rate         REAL,   -- 申购费率（%）
  source_rate      REAL,   -- 原费率（%）
  ret_1m           REAL,   -- 近1月收益（%）
  ret_6m           REAL,   -- 近6月收益（%）
  ret_1y           REAL,   -- 近1年收益（%）
  ret_3y           REAL,   -- 近3年收益（%）
  rank_in_type     INTEGER,-- 同类排名
  rank_total       INTEGER,-- 同类总数
  manager          TEXT,
  manager_id       TEXT,
  manager_worktime TEXT,   -- 任职时长文本，如「14年又199天」
  latest_nav       REAL,
  latest_nav_date  TEXT,
  source           TEXT,   -- 取数来源：primary（pingzhong）/ fallback（f10 lsjz）
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


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn) -> None:
    """轻量迁移：给已存在的旧库补齐后加的列（CREATE TABLE IF NOT EXISTS 不会改老表）。"""
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
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()
