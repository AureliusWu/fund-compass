"""Real main.app analysis integration on explicitly prepared synthetic files.

TestClient is never entered as a context manager, so application lifespan is
not run. These are local ASGI/SQLite tests, not process or cloud evidence.
"""
from contextlib import closing
import copy
import hashlib
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

import main
from database import db
from database.owner_sync_schema import provision_owner_sync_candidate
from service import owner_sessions as owners
from test_owner_analysis_router import (
    PATH, PRIVATE_NAME, REQUEST_ID, connect, counts, database, isolated, login,
    password_hash, private, receipt_headers,
)

SYNC_PATH = "/api/v2/owner/sync"


def main_client(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("main analysis entered automatic startup/default connection")

    monkeypatch.setattr(main, "init_db", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    # closing() invokes only close(), never TestClient.__enter__/lifespan.
    return closing(TestClient(main.app))


def schema_image(path):
    with closing(connect(path)) as conn:
        return [tuple(row) for row in conn.execute(
            "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
        )]


def trace_configured_connections(monkeypatch, path):
    original = sqlite3.connect
    connections, statements = [], []

    def traced(database, *args, **kwargs):
        conn = original(database, *args, **kwargs)
        if database != ":memory:":
            assert database == path.as_uri() + "?mode=rw"
            assert kwargs["uri"] is True
            connections.append(conn)
            conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(sqlite3, "connect", traced)
    return connections, statements, original


def assert_no_ddl(statements):
    assert statements
    assert not any(sql.lstrip().upper().startswith(("CREATE", "ALTER", "DROP"))
                   for sql in statements)


def test_main_full_owner_source_creates_actual_immutable_chain_and_original_receipt(database, monkeypatch):
    path, payload = database
    before_schema = schema_image(path)
    connections, statements, original_connect = trace_configured_connections(monkeypatch, path)
    with main_client(monkeypatch) as client:
        auth = login(client)
        full = client.get(SYNC_PATH, headers=auth, params={"since_revision": 0})
        assert full.status_code == 200, full.text
        private(full)
        source = full.json()
        assert source["complete"] is True and source["next_cursor"] is None
        assert source["upper_revision"] == payload["expected_revision"] == 1
        assert len(source["changes"]) == 1
        assert source["changes"][0]["values"]["name"] == PRIVATE_NAME
        canonical_source = json.dumps({
            "schema": "owner-analysis-source-1", "revision": source["upper_revision"],
            "records": source["changes"],
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        expected_source_hash = hashlib.sha256(canonical_source.encode("utf-8")).hexdigest()

        first = client.post(PATH, headers=auth, json=payload)
        assert first.status_code == 200, first.text
        result = first.json()
        run = result["run"]
        assert result["source_current"] is True
        assert run["request_id"] == REQUEST_ID
        assert run["source"] == {"revision": 1, "sha256": expected_source_hash,
                                 "record_count": 1, "scope": "fund_only"}
        assert run["policy"]["policy_version"] == payload["policy_version"]
        assert run["components"][0]["evidence"]["evidence_id"] == payload["evidence"][0]["evidence_id"]
        repeated = client.post(PATH, headers=auth, json=payload)
        assert repeated.status_code == 200 and repeated.content == first.content
        receipt = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, payload))
        assert receipt.status_code == 200
        assert receipt.json() == {"state": "matched", "status": 200, "result": result}
        for response in (first, repeated, receipt):
            private(response)
    assert_no_ddl(statements)
    assert len(connections) == 4
    for conn in connections:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")
    # Stop tracing before independent direct SQL inspection of the actual file.
    monkeypatch.setattr(sqlite3, "connect", original_connect)
    assert schema_image(path) == before_schema
    assert counts(path) == {"owner_analysis_runs": 1, "owner_analysis_components": 1,
                            "holding_versions": 1, "decision_snapshots": 1,
                            "owner_sync_receipts": 1}
    with closing(connect(path)) as conn:
        stored = conn.execute("SELECT source_revision,source_hash,source_json,policy_version "
                              "FROM owner_analysis_runs WHERE request_id=?", (REQUEST_ID,)).fetchone()
        assert tuple(stored) == (1, expected_source_hash, canonical_source, payload["policy_version"])
        component = conn.execute("SELECT holding_version,evidence_id,decision_id "
                                 "FROM owner_analysis_components WHERE request_id=?", (REQUEST_ID,)).fetchone()
        decision = conn.execute("SELECT holding_version,evidence_id,policy_version "
                                "FROM decision_snapshots WHERE decision_id=?", (component["decision_id"],)).fetchone()
        assert tuple(decision) == (component["holding_version"], component["evidence_id"], payload["policy_version"])
        assert component["holding_version"] == run["components"][0]["holding"]["holding_version"]
        assert component["decision_id"] == run["components"][0]["decision"]["decision_id"]
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_main_sync_edit_marks_original_analysis_historical_without_new_chain(database, monkeypatch):
    path, payload = database
    with main_client(monkeypatch) as client:
        auth = login(client)
        first = client.post(PATH, headers=auth, json=payload)
        assert first.status_code == 200, first.text
        original_run = first.json()["run"]
        change = client.post(SYNC_PATH, headers={**auth, "X-Owner-Sync-Consent": "owner-sync-v1"}, json={
            "request_id": "analysis-main-edit-0001", "expected_revision": 1,
            "operations": [{"key": "510300::synthetic-account", "kind": "holding", "deleted": False,
                            "changes": {"shares": 20}, "base_values": {"shares": 10}}],
        })
        assert change.status_code == 200 and change.json()["revision"] == 2
        full = client.get(SYNC_PATH, headers=auth, params={"since_revision": 0})
        assert full.status_code == 200 and full.json()["complete"] is True
        assert full.json()["upper_revision"] == 2
        assert full.json()["changes"][-1]["values"]["shares"] == 20
        repeated = client.post(PATH, headers=auth, json=payload)
        assert repeated.status_code == 200
        assert repeated.json() == {"run": original_run, "source_current": False}
        receipt = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, payload))
        assert receipt.status_code == 200
        assert receipt.json() == {"state": "matched", "status": 200, "result": repeated.json()}
        for response in (first, change, full, repeated, receipt):
            private(response)
    assert counts(path) == {"owner_analysis_runs": 1, "owner_analysis_components": 1,
                            "holding_versions": 1, "decision_snapshots": 1,
                            "owner_sync_receipts": 2}


def test_main_stale_expected_revision_refuses_without_saving_holding_or_decision(database, monkeypatch):
    path, payload = database
    before = counts(path)
    with main_client(monkeypatch) as client:
        stale = copy.deepcopy(payload)
        stale["expected_revision"] = 0
        response = client.post(PATH, headers=login(client), json=stale)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "analysis_source_conflict"
        private(response)
    assert counts(path) == before


@pytest.mark.parametrize("credential", [None, "wrong", "synthetic-ADMIN_TOKEN",
                                       "synthetic-WORKER_TOKEN", "synthetic-PRIVATE_READ_TOKEN"])
def test_main_anonymous_or_machine_credentials_never_open_analysis_storage(database, monkeypatch, credential):
    def forbidden(*_args, **_kwargs):
        pytest.fail("untrusted main analysis credential entered configured storage")

    monkeypatch.setattr(db, "database_backend", forbidden)
    auth = {"Authorization": "Bearer " + credential} if credential else {}
    auth.update({"X-Owner-Analysis-Consent": "owner-analysis-v1",
                 "X-Owner-Analysis-Request-Hash": "0" * 64})
    with main_client(monkeypatch) as client:
        for response in (client.post(PATH, headers=auth, json=database[1]),
                         client.get(PATH + "/requests/" + REQUEST_ID, headers=auth)):
            assert response.status_code == 401 and PRIVATE_NAME not in response.text
            private(response)


def test_main_logout_prevents_later_post_and_receipt_reads_before_storage(database, monkeypatch):
    with main_client(monkeypatch) as client:
        auth = login(client)
        assert client.post(PATH, headers=auth, json=database[1]).status_code == 200
        logout = client.delete("/api/v2/owner/session", headers=auth)
        assert logout.status_code == 204
        def forbidden(*_args, **_kwargs):
            pytest.fail("revoked main Owner reached analysis storage")
        monkeypatch.setattr(db, "database_backend", forbidden)
        for response in (client.post(PATH, headers=auth, json=database[1]),
                         client.get(PATH + "/requests/" + REQUEST_ID,
                                    headers=receipt_headers(auth, database[1]))):
            assert response.status_code == 401 and PRIVATE_NAME not in response.text
            private(response)
    assert owners._sessions == {}


@pytest.mark.parametrize("fault", ["owner-only", "core8", "partial-analysis", "unknown-object", "missing"])
def test_main_incompatible_storage_never_creates_or_repairs_analysis_schema(database, tmp_path, monkeypatch, fault):
    path, payload = database
    if fault == "owner-only":
        path = tmp_path / "explicit-owner-only.db"
        monkeypatch.setattr(db, "DB_PATH", str(path))
        db.init_db()
        with closing(connect(path)) as conn:
            provision_owner_sync_candidate(conn, synthetic_candidate=True)
    elif fault == "missing":
        path = tmp_path / "absent-parent" / "absent.db"
    else:
        with closing(connect(path)) as conn:
            if fault == "core8":
                conn.execute("PRAGMA user_version=8")
            elif fault == "partial-analysis":
                conn.execute("DROP TABLE owner_analysis_components")
            else:
                conn.execute("CREATE TABLE owner_analysis_extra(private TEXT)")
            conn.commit()
    monkeypatch.setattr(db, "DB_PATH", str(path))
    before = path.read_bytes() if path.exists() else None
    connections, statements, _original_connect = trace_configured_connections(monkeypatch, path)
    with main_client(monkeypatch) as client:
        auth = login(client)
        write = client.post(PATH, headers=auth, json=payload)
        receipt = client.get(PATH + "/requests/" + REQUEST_ID, headers=receipt_headers(auth, payload))
        assert write.status_code == receipt.status_code == 503
        assert receipt.json() == {"state": "unknown", "error": "analysis_result_unknown"}
        for response in (write, receipt):
            assert str(path) not in response.text and PRIVATE_NAME not in response.text
            private(response)
    if statements:
        assert all(sql.lstrip().upper().startswith(("SELECT", "PRAGMA")) for sql in statements)
    assert (path.read_bytes() if path.exists() else None) == before
    if fault == "missing":
        assert connections == [] and not path.parent.exists()
    for conn in connections:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")
