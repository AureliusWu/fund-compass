from database import db
from service import repo


def test_operations_status_is_secret_free_and_tolerates_empty_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "operations.db"))
    monkeypatch.setattr(repo, "get_conn", db.get_conn)
    monkeypatch.setattr(repo, "UNIVERSE_META", tmp_path / "missing.json")
    db.init_db()
    public = repo.public_operations_status()
    private = repo.operations_status()
    assert public["cache"]["hit_rate"] is None
    assert public["latest_decision_write"] is None
    assert public["latest_result_settlement"] is None
    assert public["redacted"] is True
    assert private["latest_decision_write"] is None
    assert private["redacted"] is False
    assert "token" not in str(public).lower()
