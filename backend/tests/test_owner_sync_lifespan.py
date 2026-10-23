"""Real main lifespan on a new synthetic local candidate, not process restart."""
from contextlib import closing
import gzip
import hashlib
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

import main
from database import db, turso_schema
from database.owner_sync_schema import provision_owner_sync_candidate, verify_owner_sync_schema
from models.owner_sync import parse_sync_request
from service import owner_sessions as owners, repo, security

PASSWORD = "synthetic owner startup password"


@pytest.fixture(scope="module")
def startup_password_hash():
    return owners.hash_owner_password(PASSWORD)


def private(response):
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_real_lifespan_import_then_owner_login_write_read_and_receipt(
        tmp_path, monkeypatch, startup_password_hash):
    path = tmp_path / "synthetic-owner-lifespan.db"
    assert not path.exists()
    with closing(sqlite3.connect(path)) as conn:
        for ddl in turso_schema.expected_objects().values():
            conn.execute(ddl)
        conn.execute("PRAGMA user_version=9")
        conn.commit()
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='universe_import_state'"
        ).fetchone() is None
        assert conn.execute("SELECT count(*) FROM funds").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM portfolio_policy_versions").fetchone()[0] == 0

    funds = [{"code": "000001", "name": "合成启动基金", "type": "混合型", "pinyin": "synthetic"}]
    payload = json.dumps(funds, ensure_ascii=False).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    artifact, meta = tmp_path / "synthetic-funds.json.gz", tmp_path / "synthetic-funds.meta.json"
    artifact.write_bytes(gzip.compress(payload))
    meta.write_text(json.dumps({
        "schema_version": 1, "generated_at": "2026-10-15T00:00:00Z",
        "source": "synthetic-owner-lifespan", "fund_count": 1, "sha256": digest,
    }), encoding="utf-8")
    monkeypatch.setenv("FUND_DB", str(path))
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "ephemeral")
    monkeypatch.setenv("OWNER_PASSWORD_HASH", startup_password_hash)
    for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN"):
        monkeypatch.setenv(name, "synthetic-startup-" + name)
    monkeypatch.setattr(db, "DB_PATH", str(path))
    monkeypatch.setattr(repo, "UNIVERSE_ARTIFACT", artifact)
    monkeypatch.setattr(repo, "UNIVERSE_META", meta)
    # No startup/get_conn function is mocked. In particular the original
    # init_db PRAGMA optimize and both normal startup producers remain active.
    assert main.init_db is db.init_db
    owners.reset_owner_sessions()
    security.reset_rate_limits()
    try:
        with TestClient(main.app) as client:
            # The context really enters lifespan, not just the router. Verify
            # the policy + import side effects before sending any Owner request.
            with closing(sqlite3.connect(path)) as conn:
                assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
                assert conn.execute("SELECT count(*) FROM portfolio_policy_versions").fetchone()[0] == 1
                assert conn.execute("SELECT code,name FROM funds").fetchall() == [("000001", "合成启动基金")]
                row = conn.execute(
                    "SELECT singleton_id,sha256,fund_count,imported_at FROM universe_import_state"
                ).fetchone()
                assert row[:3] == (1, digest, 1) and isinstance(row[3], str) and row[3]
                # Keep normal optimize's optional fixed sqlite_stat1 intact.
                verify_owner_sync_schema(conn)

            login = client.post("/api/v2/owner/session", json={"password": PASSWORD})
            assert login.status_code == 200
            private(login)
            session = login.json()
            assert session["owner_id"] == "owner" and session["token_type"] == "Bearer"
            assert set(session["scopes"]) == {"read_private", "write_holdings", "run_personal_analysis"}
            auth = {"Authorization": "Bearer " + session["access_token"],
                    "X-Owner-Sync-Consent": "owner-sync-v1"}
            baseline = client.get("/api/v2/owner/sync", headers=auth)
            assert baseline.status_code == 200
            assert baseline.json()["changes"] == [] and baseline.json()["upper_revision"] == 0

            original = {"request_id": "startup-sync-0001", "expected_revision": 0, "operations": [{
                "key": "asset:synthetic-startup", "kind": "manual_asset", "deleted": False,
                "changes": {"name": "合成启动资产", "cls": "现金", "value": 0, "note": None},
            }]}
            request_hash = parse_sync_request(json.dumps(original, ensure_ascii=False)).request_hash()
            written = client.post("/api/v2/owner/sync", headers=auth, json=original)
            assert written.status_code == 200 and written.json()["revision"] == 1
            assert written.json()["records"][0]["values"]["value"] == 0
            assert "holding_version" not in written.json()
            page = client.get("/api/v2/owner/sync", headers=auth)
            assert page.status_code == 200 and page.json()["complete"] is True
            assert page.json()["upper_revision"] == 1
            assert [record["key"] for record in page.json()["changes"]] == ["asset:synthetic-startup"]
            assert page.json()["changes"][0]["values"]["value"] == 0
            receipt = client.get("/api/v2/owner/sync/requests/startup-sync-0001",
                                 headers={**auth, "X-Owner-Sync-Request-Hash": request_hash})
            assert receipt.status_code == 200
            assert receipt.json() == {"state": "matched", "status": 200, "result": written.json()}
            for response in (baseline, written, page, receipt):
                private(response)
        # This confirms same-process file commits after lifespan exit only.
        # No second TestClient or physical-process restart is claimed.
        with closing(sqlite3.connect(path)) as conn:
            assert conn.execute("SELECT revision FROM owner_sync_state").fetchone() == (1,)
            assert conn.execute("SELECT request_id,request_hash,status FROM owner_sync_receipts").fetchall() == [
                ("startup-sync-0001", request_hash, 200),
            ]
    finally:
        owners.reset_owner_sessions()
        security.reset_rate_limits()
