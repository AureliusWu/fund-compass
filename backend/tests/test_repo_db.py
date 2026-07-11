"""数据库迁移与详情缓存：覆盖本次新增的 source 字段持久化（不打网络）。

隔离手法：monkeypatch `database.db.DB_PATH`（get_conn 运行时读该模块全局），
即可让每个用例用各自的临时 SQLite 文件，无需 reload 模块。
"""
import sqlite3

import pytest


def _cols(conn, table="fund_detail"):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    from database import db
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "test.db"))
    db.init_db()
    return db


def test_schema_has_source(temp_db):
    conn = temp_db.get_conn()
    try:
        assert "source" in _cols(conn)
    finally:
        conn.close()


def test_migrate_adds_source_to_legacy(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.db"
    conn = sqlite3.connect(legacy)
    conn.execute("CREATE TABLE fund_detail (code TEXT PRIMARY KEY, name TEXT)")  # 旧表无 source 列
    conn.commit()
    conn.close()

    from database import db
    monkeypatch.setattr(db, "DB_PATH", str(legacy))
    db.init_db()   # CREATE TABLE IF NOT EXISTS 跳过旧表 → _migrate 应补上 source 列

    conn = db.get_conn()
    try:
        assert "source" in _cols(conn)
    finally:
        conn.close()


def test_get_detail_persists_and_reads_source(temp_db, monkeypatch):
    from service import repo
    fake = {
        "code": "000001", "name": "测试基金", "buy_rate": 0.1, "source_rate": 1.0,
        "ret_1m": 1, "ret_6m": 2, "ret_1y": 3, "ret_3y": 4,
        "manager": "张三", "manager_worktime": "5年", "scale": 10.0,
        "rank_in_type": 1, "rank_total": 100,
        "latest_nav": 1.5, "latest_nav_date": "2024-01-01",
        "nav_history": [{"date": "2024-01-01", "nav": 1.5, "ac_return": 50.0}],
        "source": "primary",
    }
    monkeypatch.setattr(repo, "fetch_detail", lambda code: dict(fake, code=code))

    d1 = repo.get_detail("000001", force=True)    # 抓取并入库
    assert d1["source"] == "primary"
    assert d1["cached"] is False

    d2 = repo.get_detail("000001")                # 缓存命中，从 DB 读回（修复前这里会丢失 source）
    assert d2["source"] == "primary"
    assert d2["cached"] is True


def test_get_detail_falls_back_to_stale_cache_with_log(temp_db, monkeypatch, caplog):
    """主源+备源都失败时退回陈旧缓存，并记 warning 日志（可观测性）。"""
    import logging

    from service import repo
    good = {
        "code": "000002", "name": "缓存基金", "source": "primary",
        "latest_nav": 2.0, "latest_nav_date": "2024-01-01",
        "nav_history": [{"date": "2024-01-01", "nav": 2.0, "ac_return": 100.0}],
    }
    monkeypatch.setattr(repo, "fetch_detail", lambda code: dict(good, code=code))
    repo.get_detail("000002", force=True)          # 先成功入库一份

    def boom(code):
        raise RuntimeError("数据源全挂")
    monkeypatch.setattr(repo, "fetch_detail", boom)

    with caplog.at_level(logging.WARNING):
        d = repo.get_detail("000002", force=True)  # 抓取失败 → 退回陈旧缓存
    assert d["cached"] is True
    assert d["stale"] is True
    assert any("退回陈旧缓存" in r.getMessage() for r in caplog.records)


def test_get_detail_rejects_cache_older_than_seven_days(temp_db, monkeypatch):
    from service import repo
    monkeypatch.setattr(repo, "fetch_detail", lambda code: {
        "code": code, "name": "过期基金", "source": "primary", "latest_nav": 1,
        "latest_nav_date": "2024-01-01", "nav_history": [{"date": "2024-01-01", "nav": 1}],
    })
    repo.get_detail("000003", force=True)
    conn = temp_db.get_conn()
    conn.execute("UPDATE fund_detail SET updated_at='2000-01-01T00:00:00+08:00' WHERE code='000003'")
    conn.commit(); conn.close()
    monkeypatch.setattr(repo, "fetch_detail", lambda code: (_ for _ in ()).throw(RuntimeError("全挂")))
    with pytest.raises(RuntimeError, match="全挂"):
        repo.get_detail("000003", force=True)
