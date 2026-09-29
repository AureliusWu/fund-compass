"""Quota-sensitive writes retain revision, NULL and transactional semantics."""
import gzip
import hashlib
import json
import sqlite3

import pytest

from database import db
from service import repo


class _ObservedConnection(sqlite3.Connection):
    def close(self):
        # Repository calls still exercise their normal lifecycle; retaining the
        # test connection lets total_changes observe actual SQLite row writes.
        pass


@pytest.fixture
def conn(tmp_path, monkeypatch):
    connection = sqlite3.connect(tmp_path / "writes.db", factory=_ObservedConnection)
    connection.row_factory = sqlite3.Row
    connection.executescript(db.SCHEMA)
    monkeypatch.setattr(repo, "get_conn", lambda: connection)
    yield connection
    sqlite3.Connection.close(connection)


def _artifact(tmp_path, monkeypatch, funds):
    payload = json.dumps(funds, ensure_ascii=False).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    artifact = tmp_path / "universe.json.gz"
    meta = tmp_path / "universe.meta.json"
    artifact.write_bytes(gzip.compress(payload))
    meta.write_text(json.dumps({
        "schema_version": 1, "fund_count": len(funds), "sha256": digest,
        "generated_at": "2026-09-28T00:00:00Z", "source": "fixture",
    }), encoding="utf-8")
    monkeypatch.setattr(repo, "UNIVERSE_ARTIFACT", artifact)
    monkeypatch.setattr(repo, "UNIVERSE_META", meta)
    return digest


def _fund(code="000001", **changes):
    return {"code": code, "name": "测试基金", "type": None, "pinyin": "CSJJ", **changes}


def _detail(history):
    return {"code": "000001", "name": "测试基金", "nav_history": history}


def test_repeated_detail_refresh_does_not_rewrite_800_historical_rows(conn, make_navs):
    history = make_navs(n=repo.HIST_KEEP)
    history[0]["ac_return"] = None
    detail = _detail(history)
    repo._save_detail(conn, detail)
    conn.commit()
    before = conn.total_changes

    repo._save_detail(conn, detail)
    conn.commit()

    # Only the detail's refreshed-at receipt is written, not the 800 NAV rows.
    assert conn.total_changes - before == 1
    assert conn.execute("SELECT COUNT(*) FROM nav_history").fetchone()[0] == 800


@pytest.mark.parametrize("old,new", [
    ((1.0, None), (1.1, None)),
    ((1.0, None), (1.0, 0.0)),
    ((1.0, 0.0), (1.0, None)),
    ((None, None), (1.0, None)),
    ((1.0, None), (None, None)),
])
def test_historical_revisions_are_updated_in_place_including_nulls(conn, old, new):
    def history(values):
        return [{"date": "2026-09-01", "nav": values[0], "ac_return": values[1]}]

    repo._save_detail(conn, _detail(history(old)))
    conn.commit()
    initial_rowid = conn.execute("SELECT rowid FROM nav_history").fetchone()[0]
    before = conn.total_changes

    repo._save_detail(conn, _detail(history(new)))
    conn.commit()

    row = conn.execute("SELECT rowid,nav,ac_return FROM nav_history").fetchone()
    assert conn.total_changes - before == 2  # Detail receipt plus one revision.
    assert tuple(row) == (initial_rowid, *new)


def test_refresh_retains_only_latest_window_without_rewriting_overlap(conn, monkeypatch):
    monkeypatch.setattr(repo, "HIST_KEEP", 2)
    first = [{"date": f"2026-09-{day:02d}", "nav": day / 100 + 1} for day in (1, 2)]
    second = [{"date": f"2026-09-{day:02d}", "nav": day / 100 + 1} for day in (2, 3)]
    repo._save_detail(conn, _detail(first))
    conn.commit()
    before = conn.total_changes

    repo._save_detail(conn, _detail(second))
    conn.commit()

    assert conn.total_changes - before == 3  # Detail, one insert and one eviction.
    assert [row[0] for row in conn.execute("SELECT date FROM nav_history ORDER BY date")] == [
        "2026-09-02", "2026-09-03",
    ]


def test_manual_fund_refresh_skips_identical_rows_and_keeps_null_revisions(conn, monkeypatch):
    funds = [_fund(), _fund("000002", type="指数型")]
    monkeypatch.setattr(repo, "fetch_universe", lambda: funds)
    assert repo.import_universe() == 2
    rowid = conn.execute("SELECT rowid FROM funds WHERE code='000001'").fetchone()[0]
    before = conn.total_changes
    assert repo.import_universe() == 2
    assert conn.total_changes == before

    funds[0]["type"] = ""
    assert repo.import_universe() == 2
    assert conn.total_changes - before == 1
    assert tuple(conn.execute("SELECT rowid,type FROM funds WHERE code='000001'").fetchone()) == (rowid, "")


def test_unchanged_artifact_skips_all_data_and_receipt_writes(conn, tmp_path, monkeypatch):
    digest = _artifact(tmp_path, monkeypatch, [_fund(), _fund("000002")])
    first = repo.ensure_universe_artifact()
    before = conn.total_changes

    second = repo.ensure_universe_artifact()

    assert first["loaded"] is True and first["changed"] is True
    assert second["loaded"] is True and second["changed"] is False
    assert second["reason"] == "unchanged"
    assert second["sha256"] == digest
    assert second["imported_at"] == first["imported_at"]
    assert conn.total_changes == before
    assert repo.universe_import_status() == {
        "sha256": digest, "fund_count": 2, "imported_at": first["imported_at"],
    }


def test_matching_receipt_reconciles_a_stray_directory_row(conn, tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch, [_fund(), _fund("000002")])
    assert repo.ensure_universe_artifact()["changed"] is True
    conn.execute("INSERT INTO funds(code,name) VALUES('999999','stale')")
    conn.commit()

    result = repo.ensure_universe_artifact()

    assert result["changed"] is True
    assert repo.universe_count() == 2
    assert conn.execute("SELECT 1 FROM funds WHERE code='999999'").fetchone() is None


def test_changed_artifact_updates_existing_database_and_only_changed_rows(conn, tmp_path, monkeypatch):
    funds = [_fund(), _fund("000002")]
    old_digest = _artifact(tmp_path, monkeypatch, funds)
    assert repo.ensure_universe_artifact()["loaded"] is True
    before = conn.total_changes
    funds[0]["name"] = "修订名称"
    funds.pop()
    funds.append(_fund("000003"))
    new_digest = _artifact(tmp_path, monkeypatch, funds)

    updated = repo.ensure_universe_artifact()

    assert old_digest != new_digest
    assert updated["loaded"] is True and updated["changed"] is True
    assert conn.total_changes - before == 4  # Revision, insert, removal and receipt.
    assert repo.universe_count() == 2
    assert conn.execute("SELECT 1 FROM funds WHERE code='000002'").fetchone() is None
    assert conn.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0] == "修订名称"
    assert repo.universe_import_status()["sha256"] == new_digest


@pytest.mark.parametrize("failure", ["funds", "receipt"])
def test_failed_artifact_import_rolls_back_funds_and_keeps_previous_receipt(
    conn, tmp_path, monkeypatch, failure,
):
    _artifact(tmp_path, monkeypatch, [_fund()])
    assert repo.ensure_universe_artifact()["loaded"] is True
    old_receipt = repo.universe_import_status()
    if failure == "funds":
        conn.execute("""CREATE TRIGGER reject_fund BEFORE INSERT ON funds
            WHEN NEW.code='000002' BEGIN SELECT RAISE(ABORT, 'injected fund failure'); END""")
    else:
        conn.execute("""CREATE TRIGGER reject_receipt BEFORE UPDATE ON universe_import_state
            BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END""")
    conn.commit()
    _artifact(tmp_path, monkeypatch, [_fund(name="未提交修订"), _fund("000002")])

    result = repo.ensure_universe_artifact()

    assert result["loaded"] is False
    assert "injected" in result["reason"]
    assert not conn.in_transaction
    assert repo.universe_import_status() == old_receipt
    assert [tuple(row) for row in conn.execute("SELECT code,name FROM funds")] == [
        ("000001", "测试基金"),
    ]


def test_invalid_artifact_never_replaces_committed_receipt(conn, tmp_path, monkeypatch):
    _artifact(tmp_path, monkeypatch, [_fund()])
    assert repo.ensure_universe_artifact()["loaded"] is True
    previous = repo.universe_import_status()
    _artifact(tmp_path, monkeypatch, [_fund(), _fund()])
    before = conn.total_changes

    result = repo.ensure_universe_artifact()

    assert result["loaded"] is False
    assert conn.total_changes == before
    assert repo.universe_import_status() == previous


def test_unimported_database_has_no_claimed_artifact(conn):
    assert repo.universe_import_status() is None
    assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='universe_import_state'").fetchone() is None


def test_large_universe_import_uses_bounded_statements_and_one_remote_batch(conn, tmp_path, monkeypatch):
    class BatchConnection:
        def __init__(self):
            self.batches = []

        def __getattr__(self, name):
            return getattr(conn, name)

        def execute_batch(self, statements, *, atomic):
            assert atomic is False and conn.in_transaction
            self.batches.append(statements)
            for sql, args in statements:
                conn.execute(sql, args)

    remote = BatchConnection()
    monkeypatch.setattr(repo, "get_conn", lambda: remote)
    funds = [_fund(f"{index:06d}") for index in range(1001)]
    _artifact(tmp_path, monkeypatch, funds)

    result = repo.ensure_universe_artifact()

    assert result["loaded"] is True
    assert repo.universe_count() == 1001
    assert len(remote.batches) == 1
    statements = remote.batches[0]
    assert len(statements) == 7  # Six bounded writes and the import receipt.
    assert all(len(args) <= 800 for _, args in statements)
