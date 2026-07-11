import gzip
import hashlib
import json

from database import db
from service import repo


def _artifact(tmp_path, funds, valid=True):
    payload = json.dumps(funds, ensure_ascii=False).encode()
    artifact = tmp_path / "fund-universe.json.gz"
    meta = tmp_path / "fund-universe.meta.json"
    artifact.write_bytes(gzip.compress(payload))
    meta.write_text(json.dumps({
        "schema_version": 1, "generated_at": "2026-07-11T00:00:00Z", "source": "test",
        "fund_count": len(funds), "sha256": hashlib.sha256(payload).hexdigest() if valid else "bad",
    }), encoding="utf-8")
    return artifact, meta


def test_local_artifact_populates_empty_database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "universe.db"))
    monkeypatch.setattr(repo, "get_conn", db.get_conn)
    db.init_db()
    funds = [{"code": f"{index:06d}", "name": f"基金{index}", "type": "混合型", "pinyin": "JJ"} for index in range(1001)]
    artifact, meta = _artifact(tmp_path, funds)
    monkeypatch.setattr(repo, "UNIVERSE_ARTIFACT", artifact)
    monkeypatch.setattr(repo, "UNIVERSE_META", meta)
    result = repo.import_universe_artifact()
    assert result["loaded"] is True
    assert repo.universe_count() == 1001


def test_corrupt_artifact_does_not_block_startup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "corrupt.db"))
    monkeypatch.setattr(repo, "get_conn", db.get_conn)
    db.init_db()
    artifact, meta = _artifact(tmp_path, [], valid=False)
    monkeypatch.setattr(repo, "UNIVERSE_ARTIFACT", artifact)
    monkeypatch.setattr(repo, "UNIVERSE_META", meta)
    assert repo.import_universe_artifact()["loaded"] is False
    assert repo.query_funds()["seed"] is True
