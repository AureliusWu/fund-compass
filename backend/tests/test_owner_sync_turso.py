"""Actual loopback HTTP + SQLite Hrana simulation, never a Turso service.

The driver sends real requests bytes to an owned localhost HTTP server. Only
the Session's URL is rewritten from the synthetic TLS origin to that server;
SQL, parameters, transactions, conditional batch steps, result encoding, and
commit/response-loss behavior execute against a fresh real SQLite file.
"""
from contextlib import closing, contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import sqlite3
import threading

import pytest
import requests

from database import db, owner_sync_schema, turso, turso_schema
from models.owner_sync import parse_sync_request
from service import owner_sync_repo as local
from service import owner_sync_turso as remote

ORIGIN = "https://owner-candidate.example.invalid"
TOKEN = "synthetic-owner-db-token"
_REAL_SESSION = requests.sessions.Session


def raw_request(identifier, operations, expected=0):
    return json.dumps({"request_id": identifier, "expected_revision": expected, "operations": operations},
                      ensure_ascii=False, separators=(",", ":")).encode()


def create_operation(key="000001::账户甲", *, shares=0, cost=None, target=25, name="合成基金"):
    return {"key": key, "kind": "holding", "deleted": False,
            "changes": {"name": name, "shares": shares, "cost": cost, "target_weight": target}, "base_values": {}}


def seed_owner_database(path, *, header=8):
    conn = sqlite3.connect(path)
    try:
        turso_schema.initialize_candidate(conn)
        conn.execute("PRAGMA user_version=9")
        owner_sync_schema.provision_owner_sync_candidate(conn, synthetic_candidate=True)
        conn.execute(f"PRAGMA user_version={header}")
        conn.commit()
    finally:
        conn.close()


def decode_value(value):
    if value["type"] == "null":
        return None
    if value["type"] == "integer":
        return int(value["value"])
    if value["type"] == "float":
        return float(value["value"])
    if value["type"] == "text":
        return value["value"]
    raise AssertionError("This synthetic test has no blob parameters")


def encode_value(value):
    if value is None:
        return {"type": "null"}
    if type(value) is int:
        return {"type": "integer", "value": str(value)}
    if type(value) is float:
        return {"type": "float", "value": value}
    if type(value) is str:
        return {"type": "text", "value": value}
    raise AssertionError("Unexpected synthetic SQLite response type")


class HranaState:
    def __init__(self, path):
        self.path = path
        self.streams, self.frames = {}, []
        self.lock = threading.Lock()
        self.before_write = None
        self.lose_write_response = False
        self.fail_write_statement = None
        self.fail_write_index = None
        self.after_write_step = None
        self.zero_affected_result = False
        self.last_write_steps = ()
        self.after_write_temps = []
        self.write_batches = 0
        self.read_batches = 0

    @staticmethod
    def condition(condition, results, conn):
        kind = condition["type"]
        if kind == "ok":
            return results[condition["step"]] is not None
        if kind == "is_autocommit":
            return not conn.in_transaction
        if kind == "not":
            return not HranaState.condition(condition["cond"], results, conn)
        if kind == "and":
            return all(HranaState.condition(item, results, conn) for item in condition["conds"])
        raise AssertionError("Unexpected synthetic condition")

    @staticmethod
    def execute(conn, statement):
        assert not statement.get("named_args")
        args = tuple(decode_value(value) for value in statement.get("args", ()))
        cursor = conn.execute(statement["sql"], args)
        names = [description[0] for description in cursor.description or ()]
        rows = cursor.fetchall() if cursor.description else []
        return {"cols": [{"name": name, "decltype": None} for name in names],
                "rows": [[encode_value(value) for value in row] for row in rows],
                "affected_row_count": max(0, cursor.rowcount),
                "last_insert_rowid": None if cursor.lastrowid is None else str(cursor.lastrowid)}

    def pipeline(self, frame):
        with self.lock:
            self.frames.append(frame)
            baton = frame["baton"]
            if baton is None:
                baton = "synthetic-baton-" + str(len(self.frames))
                self.streams[baton] = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False)
            conn = self.streams[baton]
            responses, lost = [], False
            for operation in frame["requests"]:
                kind = operation["type"]
                try:
                    if kind == "execute":
                        result = self.execute(conn, operation["stmt"])
                    elif kind == "batch":
                        steps = operation["batch"]["steps"]
                        write = any(step["stmt"]["sql"].startswith("CREATE TEMP TABLE owner_sync_write_context") for step in steps)
                        self.write_batches += int(write)
                        self.read_batches += int(not write)
                        if write and self.before_write is not None:
                            callback, self.before_write = self.before_write, None
                            callback()
                        values, errors = [], []
                        injected = False
                        for index, step in enumerate(steps):
                            if "condition" in step and not self.condition(step["condition"], values, conn):
                                values.append(None)
                                errors.append(None)
                                continue
                            try:
                                if (write and not injected and (self.fail_write_index == index or
                                        self.fail_write_statement is not None and self.fail_write_statement in step["stmt"]["sql"])):
                                    injected = True
                                    raise sqlite3.OperationalError("synthetic fault")
                                value = self.execute(conn, step["stmt"])
                                if write and self.after_write_step is not None:
                                    self.after_write_step(conn, index, step["stmt"]["sql"])
                                if write and self.zero_affected_result and step["stmt"]["sql"].startswith("INSERT INTO main.owner_sync_records"):
                                    value["affected_row_count"] = 0
                                values.append(value)
                                errors.append(None)
                            except sqlite3.Error as error:
                                values.append(None)
                                errors.append({"code": getattr(error, "sqlite_errorname", "SQLITE_ERROR"),
                                               "message": "synthetic SQL error"})
                        result = {"step_results": values, "step_errors": errors}
                        if write:
                            self.last_write_steps = tuple(step["stmt"]["sql"] for step in steps)
                            self.after_write_temps.append(tuple(conn.execute("SELECT name FROM sqlite_temp_master WHERE sql IS NOT NULL")))
                        lost = lost or (write and self.lose_write_response)
                    elif kind == "get_autocommit":
                        responses.append({"type": "ok", "response": {"type": kind, "is_autocommit": not conn.in_transaction}})
                        continue
                    elif kind == "close":
                        conn.close()
                        del self.streams[baton]
                        baton = None
                        responses.append({"type": "ok", "response": {"type": "close"}})
                        continue
                    else:
                        raise AssertionError("Unexpected synthetic Hrana request")
                    responses.append({"type": "ok", "response": {"type": kind, "result": result}})
                except sqlite3.Error as error:
                    responses.append({"type": "error", "error": {"code": getattr(error, "sqlite_errorname", "SQLITE_ERROR"),
                                                                   "message": "synthetic SQL error"}})
            return {"baton": baton, "base_url": None, "results": responses}, lost

    def close(self):
        for conn in self.streams.values():
            conn.close()
        self.streams.clear()


@contextmanager
def local_hrana(path, monkeypatch):
    state = HranaState(path)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            assert self.path == "/v3/pipeline"
            assert self.headers.get("Authorization") == "Bearer " + TOKEN
            length = int(self.headers["Content-Length"])
            assert 0 < length <= 16 * 1024 * 1024
            frame = json.loads(self.rfile.read(length))
            response, lost = state.pipeline(frame)
            if lost:
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                self.close_connection = True
                return
            raw = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    local_url = "http://127.0.0.1:" + str(server.server_port)

    class LocalSession(_REAL_SESSION):
        def post(self, url, **kwargs):
            assert url == ORIGIN + "/v3/pipeline"
            assert kwargs.get("allow_redirects") is False
            assert self.trust_env is False
            return super().post(local_url + "/v3/pipeline", **kwargs)

    monkeypatch.setattr(turso.requests, "Session", LocalSession)
    try:
        yield state, remote.TursoOwnerSyncRepository(ORIGIN, TOKEN)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)
        state.close()
        assert not thread.is_alive()


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "synthetic-owner.db"
    seed_owner_database(path)
    return path


def owner_rows(path):
    with sqlite3.connect(path) as conn:
        return tuple((table, tuple(conn.execute(f"SELECT * FROM {table} ORDER BY 1,2")))
                     for table in ("owner_sync_schema", "owner_sync_state", "owner_sync_records", "owner_sync_changes", "owner_sync_receipts"))


def mutate(path, sql, args=()):
    with sqlite3.connect(path) as conn:
        conn.execute(sql, args)


def local_apply(path, raw):
    with sqlite3.connect(path) as conn:
        # Only this explicit synthetic test connection uses the local header.
        header = conn.execute("PRAGMA user_version").fetchone()[0]
        conn.execute("PRAGMA user_version=9")
        result = local.apply_sync_local(conn, raw)
        conn.execute(f"PRAGMA user_version={header}")
        return result


def test_construct_and_invalid_request_have_zero_http_or_sql(monkeypatch):
    monkeypatch.setattr(turso.requests, "Session", lambda: pytest.fail("construction must not create a Session"))
    repository = remote.TursoOwnerSyncRepository(ORIGIN, TOKEN)
    assert repository.apply({}).status == 422
    assert repository.reconcile("bad", "bad").state == "unavailable"
    assert TOKEN not in repr(repository)


@pytest.mark.parametrize("header", [0, 8])
def test_actual_http_roundtrip_uses_schema_table_nine_not_header(database, monkeypatch, header):
    mutate(database, f"PRAGMA user_version={header}")
    raw = raw_request("http-create-0001", [create_operation()])
    with local_hrana(database, monkeypatch) as (state, repository):
        result = repository.apply(raw)
        assert result.status == 200 and result.body["revision"] == 1
        record = result.body["records"][0]
        assert record["values"]["shares"] == 0 and record["values"]["cost"] is None
        assert state.write_batches == state.read_batches == 1
        assert len(state.frames) == 6  # setup/read/close + setup/one write batch/close
        assert repository.apply(raw) == result
        assert state.write_batches == 1
        receipt = repository.reconcile("http-create-0001", parse_sync_request(raw).request_hash())
        assert receipt.state == "matched" and receipt.result == result
        assert repository.reconcile("http-create-0001", "0" * 64).state == "unavailable"
    with sqlite3.connect(database) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == header


def test_manual_asset_unicode_and_numeric_json_fragments_keep_exact_latest_envelope(database, monkeypatch):
    operation = {"key": "asset:合成🙂", "kind": "manual_asset", "deleted": False,
                 "changes": {"name": "人工资产\"🙂", "cls": "现金", "value": 1.0, "note": "备注\\🙂"}, "base_values": {}}
    with local_hrana(database, monkeypatch) as (state, repository):
        result = repository.apply(raw_request("manual-asset-001", [operation]))
        assert result.status == 200 and result.body["records"][0]["values"]["value"] == 1.0
        assert state.write_batches == 1 and not state.after_write_temps[-1]


@pytest.mark.parametrize("sql,args", [
    ("UPDATE _schema_version SET version=8", ()),
    ("DROP TABLE owner_sync_receipts", ()),
    ("CREATE TABLE owner_sync_extra(value TEXT)", ()),
    ("CREATE TRIGGER owner_extra AFTER INSERT ON owner_sync_records BEGIN SELECT 1; END", ()),
])
def test_incompatible_remote_schema_is_rejected_without_provisioning(database, monkeypatch, sql, args):
    mutate(database, sql, args)
    with sqlite3.connect(database) as conn:
        before = tuple(conn.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name"))
    with local_hrana(database, monkeypatch) as (state, repository):
        result = repository.apply(raw_request("schema-reject-01", [create_operation()]))
        assert result.status == 503 and state.write_batches == 0
    with sqlite3.connect(database) as conn:
        assert tuple(conn.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")) == before


@pytest.mark.parametrize("name", ["universe_import_state", "turso_candidate_probe_v1", "sqlite_stat1"])
def test_only_fixed_known_operational_table_contracts_are_accepted(database, monkeypatch, name):
    mutate(database, "ANALYZE" if name == "sqlite_stat1" else remote._OPERATIONAL[name])
    with local_hrana(database, monkeypatch) as (_state, repository):
        assert repository.apply(raw_request("known-table-001", [create_operation()])).status == 200


def test_success_noop_saved_conflict_and_changed_original_body_are_exact(database, monkeypatch):
    create = raw_request("first-create-001", [create_operation()])
    with local_hrana(database, monkeypatch) as (state, repository):
        first = repository.apply(create)
        noop = raw_request("noop-request-001", [{"key": "000001::账户甲", "kind": "holding", "deleted": False,
                           "changes": {"shares": 0.0}, "base_values": {"shares": 0}}], expected=1)
        no_change = repository.apply(noop)
        assert no_change.status == 200 and no_change.body["revision"] == 1
        conflict = raw_request("future-request-1", [create_operation("000002::账户乙")], expected=99)
        rejected = repository.apply(conflict)
        assert rejected.status == 409 and rejected.body["error"]["code"] == "sync_conflict"
        assert repository.apply(conflict) == rejected
        assert repository.reconcile("future-request-1", parse_sync_request(conflict).request_hash()).result == rejected
        altered = create.replace('合成基金'.encode(), '修改名称'.encode())
        wrong = repository.apply(altered)
        assert wrong.status == 409 and wrong.body["error"]["code"] == "idempotency_conflict"
        assert state.write_batches == 3
        assert first.body["revision"] == no_change.body["revision"]


def test_existing_merge_rules_disjoint_fields_aba_and_tombstone_survive_remote_path(database, monkeypatch):
    with local_hrana(database, monkeypatch) as (_state, repository):
        assert repository.apply(raw_request("merge-create-001", [create_operation()])).status == 200
        def patch(identifier, changes, base, expected=1):
            return repository.apply(raw_request(identifier, [{"key": "000001::账户甲", "kind": "holding",
                                    "deleted": False, "changes": changes, "base_values": base}], expected))
        assert patch("merge-cost-00001", {"cost": 2}, {"cost": None}).status == 200
        assert patch("merge-name-00001", {"name": "另一名称"}, {"name": "合成基金"}).status == 200
        assert patch("merge-cost-00002", {"cost": None}, {"cost": 2}, expected=3).status == 200
        aba = patch("merge-aba-000001", {"cost": 3}, {"cost": None}, expected=1)
        assert aba.status == 409
        deleted = repository.apply(raw_request("delete-record-01", [{"key": "000001::账户甲", "kind": "holding",
                                  "deleted": True, "changes": {}, "base_values": {}}], expected=4))
        assert deleted.status == 200 and deleted.body["records"][0]["deleted"] is True
        stale = patch("stale-revive-001", {"name": "旧设备"}, {"name": "另一名称"}, expected=4)
        assert stale.status == 409


def test_atomic_rename_and_fixed_upper_pages_exclude_later_write(database, monkeypatch):
    with local_hrana(database, monkeypatch) as (_state, repository):
        assert repository.apply(raw_request("rename-create-01", [create_operation()])).status == 200
        rename = raw_request("rename-batch-001", [
            {"key": "000001::账户甲", "kind": "holding", "deleted": True, "changes": {}, "base_values": {}},
            create_operation("000001::账户乙"), create_operation("000002::账户乙")], expected=1)
        moved = repository.apply(rename)
        assert moved.status == 200 and moved.body["revision"] == 2
        first = repository.read_changes(limit=1)
        assert first["upper_revision"] == 2 and first["complete"] is False
        assert repository.apply(raw_request("later-create-001", [create_operation("000003::账户丙")], expected=2)).status == 200
        records, cursor = first["changes"], first["next_cursor"]
        while cursor is not None:
            page = repository.read_changes(upper_revision=2, cursor=cursor, limit=1)
            records += page["changes"]
            cursor = page["next_cursor"]
        assert len(records) == 4 and max(record["record_revision"] for record in records) == 2
        assert all(record["key"] != "000003::账户丙" for record in records)


@pytest.mark.parametrize("race", ["new-head", "same-request", "different-hash", "schema"])
def test_atomic_race_saves_conflict_or_replays_actual_receipt_without_second_write(database, monkeypatch, race):
    original = raw_request("racing-request-1", [create_operation()])
    with local_hrana(database, monkeypatch) as (state, repository):
        def race_write():
            if race == "schema":
                mutate(database, "CREATE TABLE race_extra(value TEXT)")
            elif race == "same-request":
                assert local_apply(database, original).status == 200
            elif race == "different-hash":
                other = raw_request("racing-request-1", [create_operation("000002::账户乙", name="另一请求私人正文")])
                assert local_apply(database, other).status == 200
            else:
                assert local_apply(database, raw_request("competing-write1", [create_operation("000002::账户乙")])).status == 200
        state.before_write = race_write
        result = repository.apply(original)
        assert state.write_batches == state.read_batches == 1  # no automatic follow-up
        if race == "new-head":
            assert result == local.SyncResult(409, {**local._error("sync_conflict", 409).body,
                                                   "conflicts": [local._conflict("", {"expected_revision"})]})
            assert repository.reconcile("racing-request-1", parse_sync_request(original).request_hash()).result == result
        elif race == "same-request":
            assert result.status == 200 and result.body["revision"] == 1
            assert repository.reconcile("racing-request-1", parse_sync_request(original).request_hash()).result == result
        elif race == "different-hash":
            assert result == local._error("idempotency_conflict", 409)
            assert "另一请求私人正文" not in json.dumps(result.body, ensure_ascii=False)
            assert repository.reconcile("racing-request-1", parse_sync_request(original).request_hash()).state == "unavailable"
        else:
            assert result.status == 503 and result.body["error"]["code"] == "schema_unavailable"
        assert state.write_batches == 1
        with sqlite3.connect(database) as conn:
            count = conn.execute("SELECT COUNT(*) FROM owner_sync_receipts WHERE request_id='racing-request-1'").fetchone()[0]
            assert count == int(race != "schema")
            assert not conn.in_transaction
        assert all(not objects for objects in state.after_write_temps)


def test_unrelated_noop_receipt_with_unchanged_head_does_not_block_new_request(database, monkeypatch):
    initial = raw_request("noop-race-create", [create_operation()])
    assert local_apply(database, initial).status == 200
    original = raw_request("noop-race-target", [{"key": "000001::账户甲", "kind": "holding", "deleted": False,
                           "changes": {"shares": 0}, "base_values": {"shares": 0}}], expected=1)
    competitor = original.replace(b"noop-race-target", b"noop-race-other1")
    with local_hrana(database, monkeypatch) as (state, repository):
        state.before_write = lambda: local_apply(database, competitor)
        result = repository.apply(original)
        assert result.status == 200 and result.body["revision"] == 1
        assert repository.reconcile("noop-race-target", parse_sync_request(original).request_hash()).result == result
        assert state.write_batches == 1
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT revision FROM owner_sync_state").fetchone()[0] == 1


def test_actual_commit_then_lost_http_response_is_unknown_and_only_explicit_read_reconciles(database, monkeypatch):
    raw = raw_request("lost-response-01", [create_operation()])
    with local_hrana(database, monkeypatch) as (state, repository):
        state.lose_write_response = True
        unknown = repository.apply(raw)
        assert unknown.status == 503 and unknown.body["error"]["code"] == "sync_result_unknown"
        assert state.write_batches == state.read_batches == 1
        receipt = repository.reconcile("lost-response-01", parse_sync_request(raw).request_hash())
        assert receipt.state == "matched" and receipt.result.status == 200
        assert state.write_batches == 1
        absent = repository.reconcile("not-sent-request", hashlib.sha256(b"synthetic").hexdigest())
        assert absent.state == "absent"  # Caller must NOT infer permission to resend.


@pytest.mark.parametrize("fault", ["INSERT INTO main.owner_sync_records", "INSERT INTO main.owner_sync_changes", "INSERT INTO main.owner_sync_receipts"])
def test_dml_fault_keeps_previous_private_database_and_never_retries(database, monkeypatch, fault):
    before = owner_rows(database)
    with local_hrana(database, monkeypatch) as (state, repository):
        state.fail_write_statement = fault
        result = repository.apply(raw_request("fault-request-01", [create_operation()]))
        assert result.status == 503 and result.body["error"]["code"] == "sync_result_unknown"
        assert state.write_batches == 1
    assert owner_rows(database) == before


def test_authorization_rechecked_before_first_read_write_and_receipt_replay(database, monkeypatch):
    raw = raw_request("authorization-01", [create_operation()])
    with local_hrana(database, monkeypatch) as (state, repository):
        calls = []
        def revoked():
            calls.append(1)
            if len(calls) == 2:
                raise RuntimeError("synthetic-revoked")
        with pytest.raises(RuntimeError, match="synthetic-revoked"):
            repository.apply(raw, before_commit=revoked)
        assert state.write_batches == 0
        assert repository.apply(raw).status == 200
        calls.clear()
        with pytest.raises(RuntimeError, match="synthetic-revoked"):
            repository.apply(raw, before_commit=revoked)
        assert state.write_batches == 1


def test_two_hundred_operations_keep_one_write_batch_and_bounded_statement_arguments(database, monkeypatch):
    operations = [create_operation(f"{index:06d}::合成账户") for index in range(200)]
    raw = raw_request("maximum-batch-01", operations)
    with local_hrana(database, monkeypatch) as (state, repository):
        result = repository.apply(raw)
        assert result.status == 200 and len(result.body["records"]) == 200
        assert state.write_batches == state.read_batches == 1 and len(state.frames) == 6
        for frame in state.frames:
            for operation in frame["requests"]:
                if operation["type"] == "batch":
                    assert len(operation["batch"]["steps"]) <= remote.MAX_BATCH_STATEMENTS + 3
                    assert max(len(step["stmt"].get("args", [])) for step in operation["batch"]["steps"]) <= remote.MAX_STATEMENT_ARGS


@pytest.mark.parametrize("include_absent", [False, True])
def test_latest_guard_binds_expected_cte_before_the_count_predicate(database, include_absent):
    assert local_apply(database, raw_request("guard-binding-01", [create_operation()])).status == 200
    keys = ("000001::账户甲", "000003::不存在") if include_absent else ("000001::账户甲",)
    with closing(sqlite3.connect(database)) as conn:
        latest = tuple(conn.execute("SELECT sync_key,revision,snapshot_json FROM owner_sync_changes"))
        conn.execute(remote._CONTEXT_DDL)
        conn.execute("INSERT INTO temp.owner_sync_write_context VALUES(1,0,1)")
        sql, args = remote._latest_guard(keys, latest)
        assert conn.execute(sql, args).fetchone() == (1,)
        conn.execute("UPDATE owner_sync_changes SET snapshot_json='damaged'")
        with pytest.raises(sqlite3.Error):
            conn.execute(sql, args).fetchone()


@pytest.mark.parametrize("missing", [False, True])
def test_same_head_latest_replacement_or_new_history_cannot_bypass_complete_read_set(database, monkeypatch, missing):
    assert local_apply(database, raw_request("readset-first-01", [create_operation()])).status == 200
    assert local_apply(database, raw_request("readset-second01", [create_operation("000002::账户乙")], expected=1)).status == 200
    selected = "000003::账户丙" if missing else "000001::账户甲"
    operation = create_operation(selected) if missing else {"key": selected, "kind": "holding", "deleted": False,
                                                          "changes": {"shares": 1}, "base_values": {"shares": 0}}
    with local_hrana(database, monkeypatch) as (state, repository):
        state.before_write = lambda: mutate(database, "UPDATE owner_sync_changes SET sync_key=? WHERE revision=2 AND sync_key='000002::账户乙'", (selected,))
        result = repository.apply(raw_request("readset-target01", [operation], expected=2))
        assert result.status == 503 and result.body["error"]["code"] == "integrity_unavailable"
        assert state.write_batches == 1 and not state.after_write_temps[-1]
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM owner_sync_receipts WHERE request_id='readset-target01'").fetchone()[0] == 0


def test_head_advance_does_not_disguise_selected_current_latest_corruption_as_conflict(database, monkeypatch):
    assert local_apply(database, raw_request("corrupt-first-01", [create_operation()])).status == 200
    original = raw_request("corrupt-target01", [{"key": "000001::账户甲", "kind": "holding", "deleted": False,
                          "changes": {"shares": 1}, "base_values": {"shares": 0}}], expected=1)
    with local_hrana(database, monkeypatch) as (state, repository):
        def advance_and_corrupt():
            assert local_apply(database, raw_request("corrupt-other-01", [create_operation("000002::账户乙")], expected=1)).status == 200
            mutate(database, "UPDATE owner_sync_records SET payload_json=? WHERE sync_key='000001::账户甲'",
                   (local._json({"name": "损坏正文", "shares": 0, "cost": None, "target_weight": 25}),))
        state.before_write = advance_and_corrupt
        result = repository.apply(original)
        assert result.status == 503 and result.body["error"]["code"] == "integrity_unavailable"
        assert state.write_batches == 1
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM owner_sync_receipts WHERE request_id='corrupt-target01'").fetchone()[0] == 0


@pytest.mark.parametrize("constant", ["MAX_RECORDS", "MAX_CHANGES", "MAX_RECEIPTS", "MAX_SAFE_REVISION"])
def test_capacity_and_revision_boundaries_preserve_history_without_write(database, monkeypatch, constant):
    if constant == "MAX_SAFE_REVISION":
        assert local_apply(database, raw_request("capacity-create1", [create_operation()])).status == 200
        raw = raw_request("capacity-target1", [{"key": "000001::账户甲", "kind": "holding", "deleted": False,
                          "changes": {"shares": 1}, "base_values": {"shares": 0}}], expected=1)
        monkeypatch.setattr(local, constant, 1)
    else:
        raw = raw_request("capacity-target1", [create_operation()])
        monkeypatch.setattr(local, constant, 0)
    before = owner_rows(database)
    with local_hrana(database, monkeypatch) as (state, repository):
        result = repository.apply(raw)
        assert result.status == 503 and result.body["error"]["code"] == "capacity_exhausted"
        assert state.write_batches == 0
    assert owner_rows(database) == before


def test_locked_receipt_capacity_is_rechecked_but_existing_receipt_replay_is_not_blocked(database, monkeypatch):
    first = raw_request("receipt-full-001", [create_operation()])
    assert local_apply(database, first).status == 200
    monkeypatch.setattr(local, "MAX_RECEIPTS", 2)
    with local_hrana(database, monkeypatch) as (state, repository):
        noop = raw_request("receipt-noop-001", [{"key": "000001::账户甲", "kind": "holding", "deleted": False,
                           "changes": {"shares": 0}, "base_values": {"shares": 0}}], expected=1)
        state.before_write = lambda: local_apply(database, noop)
        result = repository.apply(raw_request("receipt-target01", [create_operation("000002::账户乙")], expected=1))
        assert result.status == 503 and result.body["error"]["code"] == "capacity_exhausted"
        assert state.write_batches == 1 and not state.after_write_temps[-1]
        monkeypatch.setattr(local, "MAX_RECEIPTS", 0)
        replay = repository.apply(first)
        assert replay.status == 200 and replay.body["revision"] == 1 and state.write_batches == 1


def test_every_actual_batch_step_fault_rolls_back_and_cleans_temp(database, tmp_path, monkeypatch):
    raw = raw_request("every-step-fault", [create_operation()])
    with local_hrana(database, monkeypatch) as (state, repository):
        assert repository.apply(raw).status == 200
        steps = state.last_write_steps
        assert steps[-2:] == ("COMMIT", "ROLLBACK")
        for index in range(len(steps) - 1):  # every executed step, including COMMIT, never the recovery ROLLBACK
            state.close()
            state.path = tmp_path / f"step-{index}.db"
            seed_owner_database(state.path)
            before = owner_rows(state.path)
            state.fail_write_index = index
            result = repository.apply(raw)
            assert result.status == 503, index
            assert owner_rows(state.path) == before, index
            assert not state.after_write_temps[-1], index


def test_postimage_corruption_rolls_back_but_wrong_affected_observation_stays_unknown(database, monkeypatch):
    before = owner_rows(database)
    raw = raw_request("postimage-check1", [create_operation()])
    with local_hrana(database, monkeypatch) as (state, repository):
        def corrupt_postimage(conn, _index, sql):
            if sql.startswith("UPDATE main.owner_sync_state"):
                conn.execute("UPDATE main.owner_sync_records SET payload_json=?",
                             (local._json({"name": "错误后像", "shares": 0, "cost": None, "target_weight": 25}),))
        state.after_write_step = corrupt_postimage
        rejected = repository.apply(raw)
        assert rejected.status == 503 and owner_rows(database) == before
        assert not state.after_write_temps[-1]
        state.after_write_step = None
        state.zero_affected_result = True
        unknown = repository.apply(raw)
        assert unknown.status == 503 and unknown.body["error"]["code"] == "sync_result_unknown"
        assert state.write_batches == 2
        receipt = repository.reconcile("postimage-check1", parse_sync_request(raw).request_hash())
        assert receipt.state == "matched" and receipt.result.status == 200


@pytest.mark.parametrize("kwargs", [{"limit": True}, {"limit": 0}, {"since_revision": -1}, {"upper_revision": True},
                                    {"cursor": (True, "")}, {"cursor": (1,) }])
def test_invalid_page_parameters_do_not_open_transport(monkeypatch, kwargs):
    monkeypatch.setattr(turso.requests, "Session", lambda: pytest.fail("invalid page must not create a Session"))
    repository = remote.TursoOwnerSyncRepository(ORIGIN, TOKEN)
    with pytest.raises(local.SyncReadError) as caught:
        repository.read_changes(**kwargs)
    assert caught.value.status == 422
