from database import db
from service import repo


def test_operations_status_is_secret_free_and_tolerates_empty_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "operations.db"))
    monkeypatch.setattr(repo, "get_conn", db.get_conn)
    monkeypatch.setattr(repo, "UNIVERSE_META", tmp_path / "missing.json")
    db.init_db()
    status = repo.operations_status()
    assert status["cache"]["hit_rate"] is None
    assert status["latest_decision_write"] is None
    assert "token" not in str(status).lower()
