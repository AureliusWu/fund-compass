"""Synthetic Hrana transport over actual SQLite; no configured DB or cloud."""
import base64
from dataclasses import FrozenInstanceError, replace
import hashlib
import json
import socket
import sqlite3
import time

import pytest

from database import db, turso_scope_snapshot as capture, turso_scope_upgrade as offline


ORIGIN = "libsql://synthetic-candidate.turso.io"
TOKEN = "synthetic-never-a-real-token"
INVENTORIES = [frozenset(), frozenset({"turso_candidate_probe_v1"}),
               frozenset({"universe_import_state"}), frozenset(offline._OPERATIONAL_DEFINITIONS)]
QUERY_PROFILES = ["query-only-v1", "turso-fixed-read-v1"]


def encode(value):
    if value is None:
        return {"type": "null"}
    if type(value) is int:
        return {"type": "integer", "value": str(value)}
    if type(value) is float:
        return {"type": "float", "value": value}
    if type(value) is bytes:
        return {"type": "blob", "base64": base64.b64encode(value).decode("ascii")}
    return {"type": "text", "value": value}


class Response:
    status_code = 200

    def __init__(self, body, *, fail_close=False):
        self.body = body
        self.fail_close = fail_close
        self.closed = False
        self.iterated = False

    def iter_content(self, chunk_size):
        self.iterated = True
        for offset in range(0, len(self.body), chunk_size):
            yield self.body[offset:offset + chunk_size]

    def close(self):
        self.closed = True
        if self.fail_close:
            raise RuntimeError("private-cleanup-marker")


class SQLiteHrana:
    """Execute the received fixed batch on one real synthetic SQLite stream."""

    def __init__(self, conn, *, mutate=None, sql_error=None, response_error=None, close_error=False, before_step=None):
        self.conn = conn
        self.mutate = mutate
        self.sql_error = sql_error
        self.response_error = response_error
        self.close_error = close_error
        self.before_step = before_step
        self.calls = []
        self.executed = []
        self.closed = False
        self.response = None
        self.payload = None

    def condition(self, cond, results):
        kind = cond["type"]
        if kind == "ok":
            return results[cond["step"]] is not None
        if kind == "is_autocommit":
            return not self.conn.in_transaction
        if kind == "not":
            return not self.condition(cond["cond"], results)
        if kind == "and":
            return all(self.condition(child, results) for child in cond["conds"])
        raise AssertionError("unexpected condition")

    def send(self, **options):
        self.calls.append(options)
        assert options["max_attempts"] == 1 and options["allow_redirects"] is False
        assert options["stream"] is True and 0 < options["timeout_seconds"] <= capture.MAX_SECONDS
        assert options["url"] == "https://synthetic-candidate.turso.io/v3/pipeline"
        assert options["headers"]["Authorization"] == "Bearer " + TOKEN
        body = json.loads(options["body"])
        assert body["baton"] is None
        requests = body["requests"]
        assert [item["type"] for item in requests] == ["batch", "get_autocommit", "close"]
        results, errors = [], []
        for index, step in enumerate(requests[0]["batch"]["steps"]):
            if "condition" in step and not self.condition(step["condition"], results):
                results.append(None)
                errors.append(None)
                continue
            sql = step["stmt"]["sql"]
            assert step["stmt"] == {"sql": sql, "args": [], "named_args": [], "want_rows": True}
            # Never permit producer DDL/DML, ATTACH, source SQL, or migrations.
            assert sql.startswith(("PRAGMA ", "SELECT ")) or sql in ("BEGIN", "COMMIT", "ROLLBACK")
            assert sql != "BEGIN IMMEDIATE"
            self.executed.append((index, sql))
            if self.before_step:
                self.before_step(index, sql)
            if self.sql_error == index or self.sql_error == sql:
                results.append(None)
                errors.append({"message": "private-sql-body-marker", "code": "PRIVATE_ERROR"})
                continue
            try:
                cursor = self.conn.execute(sql)
            except sqlite3.Error:
                results.append(None)
                errors.append({"message": "private-sql-body-marker", "code": "PRIVATE_ERROR"})
                continue
            results.append({"cols": [{"name": col[0], "decltype": None} for col in (cursor.description or ())],
                            "rows": [[encode(value) for value in row] for row in cursor.fetchall()],
                            "affected_row_count": 0, "last_insert_rowid": None})
            errors.append(None)
        self.payload = {"baton": None, "base_url": None, "results": [
            {"type": "ok", "response": {"type": "batch", "result": {"step_results": results, "step_errors": errors}}},
            {"type": "ok", "response": {"type": "get_autocommit", "is_autocommit": not self.conn.in_transaction}},
            {"type": "ok", "response": {"type": "close"}},
        ]}
        if self.mutate:
            self.mutate(self.payload, body)
        raw = json.dumps(self.payload, separators=(",", ":"), ensure_ascii=True).encode()
        if self.response_error:
            raw = self.response_error(raw)
        self.response = Response(raw)
        return self.response

    def close(self):
        self.closed = True
        if self.conn.in_transaction:
            self.conn.rollback()
        if self.close_error:
            raise RuntimeError("private-transport-close-marker")


class RejectPragmaAssignments(SQLiteHrana):
    """Synthetic provider rejects a whole batch during SQL parsing, not auth."""

    def send(self, **options):
        body = json.loads(options["body"])
        if not any(step["stmt"]["sql"].startswith("PRAGMA ") and "=" in step["stmt"]["sql"]
                   for step in body["requests"][0]["batch"]["steps"]):
            return super().send(**options)
        self.calls.append(options)
        assert not self.conn.in_transaction
        self.payload = {"baton": None, "results": [
            {"type": "error", "error": {"code": "SQL_PARSE_ERROR",
                "message": "unsupported private-provider-marker:" + TOKEN}},
            {"type": "ok", "response": {"type": "get_autocommit", "is_autocommit": True}},
            {"type": "ok", "response": {"type": "close"}},
        ]}
        self.response = Response(json.dumps(self.payload, separators=(",", ":")).encode())
        return self.response


@pytest.fixture(autouse=True)
def no_external_access(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("external/configured access forbidden")
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "init_db", forbidden)
    monkeypatch.setattr(offline, "_scope_upgrade", forbidden)


@pytest.fixture
def source():
    opened = []
    def make(inventory=frozenset(), statistics=False):
        conn = offline._source_reference("remote-schema-table", offline._Budget(time.monotonic() + 30),
            optimizer_statistics=statistics, operational_objects=inventory)
        conn.execute("INSERT INTO _schema_version VALUES(1,8)")
        conn.execute("INSERT INTO funds VALUES('000001','private-fund-marker','mixed',NULL)")
        conn.execute("INSERT INTO funds VALUES('000002','',NULL,'')")
        conn.execute("INSERT INTO fund_detail(code,latest_nav,scale) VALUES('000001',0,NULL)")
        conn.execute("INSERT INTO nav_history VALUES('000001','2026-09-30',1.0,NULL)")
        conn.execute("INSERT INTO decision_history(code,decision_date,base_nav,action,strategy_version,created_at) "
                     "VALUES('000001','2026-09-30',1,'hold','fixture','2026-09-30T00:00:00+00:00')")
        conn.execute("DELETE FROM decision_history")
        if "turso_candidate_probe_v1" in inventory:
            conn.execute("INSERT INTO turso_candidate_probe_v1 VALUES(?,?,?)", ("a" * 64, "b" * 64, "2026-09-30T00:00:00Z"))
        if "universe_import_state" in inventory:
            conn.execute("INSERT INTO universe_import_state VALUES(1,?,2,'2026-09-30T00:00:00Z')", ("c" * 64,))
        conn.commit()
        opened.append(conn)
        return conn
    yield make
    for conn in opened:
        conn.close()


def run(transport, **kwargs):
    return capture.capture_scope_snapshot(candidate_origin=ORIGIN, token=TOKEN, transport=transport, **kwargs)


def step_index(body, fragment):
    if fragment == "PRAGMA query_only":
        return next(index for index, item in enumerate(body["requests"][0]["batch"]["steps"])
                    if item["stmt"]["sql"] == fragment)
    return next(index for index, item in enumerate(body["requests"][0]["batch"]["steps"])
                if fragment in item["stmt"]["sql"])


def row_result(payload, body, fragment):
    return payload["results"][0]["response"]["result"]["step_results"][step_index(body, fragment)]


@pytest.mark.parametrize("inventory", INVENTORIES)
@pytest.mark.parametrize("statistics", [False, True])
@pytest.mark.parametrize("profile", QUERY_PROFILES)
def test_complete_fixed_one_batch_snapshot_preserves_private_typed_data(source, inventory, statistics, profile):
    conn = source(inventory, statistics)
    before = offline._rows_digest(offline._snapshot_rows(conn, offline._objects(conn), offline._Budget(time.monotonic() + 30)))
    transport = SQLiteHrana(conn)
    with run(transport, operational_tables=inventory, optimizer_statistics=statistics,
             query_mode_profile=profile) as snapshot:
        result = snapshot.safe_metadata
        assert result["evidence_scope"] == "candidate_readonly_snapshot_capture"
        assert result["consistent_sql_snapshot"] is True
        assert result["query_mode_profile"] == profile
        assert result["query_only_observed"] == int(profile == "query-only-v1")
        assert type(result["query_only_observed"]) is int
        assert result["server_write_protection_verified"] is (profile == "query-only-v1")
        assert result["source_rows_sha256"] == before
        assert result["source_sha256"] == hashlib.sha256(snapshot.connection.serialize()).hexdigest()
        assert result["resource_sha256"] == hashlib.sha256(b"https://synthetic-candidate.turso.io").hexdigest()
        for name in ("remote_verified", "remote_applied", "remote_restore_verified", "formal_release_verified",
                     "migration_rehearsed", "apply_preimage_verified"):
            assert result[name] is False
        assert tuple(snapshot.connection.execute("SELECT latest_nav,scale FROM fund_detail").fetchone()) == (0.0, None)
        assert tuple(snapshot.connection.execute("SELECT rowid,name,seq FROM sqlite_sequence").fetchone()) == (1, "decision_history", 1)
        assert snapshot.connection.execute("SELECT version FROM _schema_version").fetchone()[0] == 8
        assert not snapshot.connection.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone()
        assert snapshot.connection.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError):
            snapshot.connection.execute("DELETE FROM funds")
        public = json.dumps(result) + repr(snapshot)
        assert all(marker not in public for marker in (ORIGIN, TOKEN, "private-fund-marker", "000001", "CREATE TABLE"))
    assert len(transport.calls) == 1 and transport.closed and transport.response.closed
    assert not conn.in_transaction


@pytest.mark.parametrize("index", range(9))
def test_sql_failure_stops_suffix_and_rejects_snapshot(source, index):
    transport = SQLiteHrana(source(), sql_error=index)
    with pytest.raises(capture.SnapshotError, match="^capture_sql_failed$"):
        run(transport)
    sqls = [sql for _, sql in transport.executed]
    assert "COMMIT" not in sqls
    assert all(position <= index or sql == "ROLLBACK" for position, sql in transport.executed)
    assert not transport.conn.in_transaction and transport.closed and transport.response.closed


def test_commit_failure_rollback_and_close_not_partial_success(source):
    transport = SQLiteHrana(source(), sql_error="COMMIT")
    with pytest.raises(capture.SnapshotError, match="^capture_sql_failed$"):
        run(transport)
    assert transport.executed[-1][1] == "ROLLBACK" and not transport.conn.in_transaction


def test_each_fixed_table_sql_error_stops_all_later_table_reads(source):
    reference = source()
    plan, _, _, _, _ = capture._plan(reference)
    queries = [step["stmt"]["sql"] for step in plan["requests"][0]["batch"]["steps"]
               if step["stmt"]["sql"].startswith("SELECT rowid,*")]
    assert len(queries) > 10 and any("sqlite_sequence" in sql for sql in queries)
    for query in queries:
        transport = SQLiteHrana(source(), sql_error=query)
        with pytest.raises(capture.SnapshotError, match="^capture_sql_failed$"):
            run(transport)
        sqls = [sql for _, sql in transport.executed]
        assert sqls[-1] == "ROLLBACK" and "COMMIT" not in sqls
        failure_index = sqls.index(query)
        assert sqls[failure_index + 1:] == ["ROLLBACK"]
        assert transport.closed and transport.response.closed and not transport.conn.in_transaction


def test_unexpected_autocommit_inside_batch_skips_suffix_and_cannot_form_snapshot(source):
    conn = source()
    def before(index, sql):
        if sql == "PRAGMA query_only":
            conn.rollback()
    transport = SQLiteHrana(conn, before_step=before)
    with pytest.raises(capture.SnapshotError, match="^capture_protocol_invalid$"):
        run(transport)
    sqls = [sql for _, sql in transport.executed]
    assert sqls == ["PRAGMA query_only=ON", "BEGIN", "PRAGMA query_only"]


@pytest.mark.parametrize("change", [
    lambda p, b: p.update(baton="private-baton"),
    lambda p, b: p.update(base_url="https://other.turso.io/stream/abc"),
    lambda p, b: p.update(base_url="https://synthetic-candidate.turso.io/%2e%2e/token"),
    lambda p, b: p["results"][1]["response"].update(is_autocommit=False),
    lambda p, b: p["results"][1]["response"].update(is_autocommit=1),
    lambda p, b: p["results"][2].update(type="error", error={"message": "private-close-body"}),
    lambda p, b: p["results"].pop(),
    lambda p, b: p["results"][0]["response"]["result"]["step_results"].pop(),
    lambda p, b: row_result(p, b, "query_only=ON").update(rows=[[]]),
    lambda p, b: row_result(p, b, "PRAGMA query_only")["rows"].__setitem__(0, [encode(0)]),
    lambda p, b: row_result(p, b, "PRAGMA query_only")["rows"].__setitem__(0, [encode(1.0)]),
    lambda p, b: row_result(p, b, "COMMIT").update(affected_row_count=True),
    lambda p, b: row_result(p, b, "COMMIT").update(last_insert_rowid=True),
    lambda p, b: row_result(p, b, "COMMIT").update(unreviewed=1),
])
def test_protocol_state_and_closure_must_all_be_exact(source, change):
    transport = SQLiteHrana(source(), mutate=change)
    with pytest.raises(capture.SnapshotError) as error:
        run(transport)
    assert TOKEN not in str(error.value) and "private" not in str(error.value)
    assert transport.closed and transport.response.closed and len(transport.calls) == 1


@pytest.mark.parametrize("raw", [
    {"type": "integer", "value": True}, {"type": "integer", "value": 1},
    {"type": "integer", "value": "01"}, {"type": "integer", "value": "-0"},
    {"type": "integer", "value": "9223372036854775808"},
    {"type": "float", "value": "1"}, {"type": "float", "value": True},
    {"type": "float", "value": float("inf")},
    {"type": "text", "value": "\ud800"},
    {"type": "blob", "base64": "YQ="}, {"type": "blob", "base64": "YR=="},
    {"type": "null", "value": None}, {"type": "new-type", "value": 1},
])
def test_typed_values_reject_coercion_nonfinite_surrogates_noncanonical_blob(source, raw):
    def corrupt(payload, body):
        row_result(payload, body, 'main."funds"')["rows"][0][1] = raw
    transport = SQLiteHrana(source(), mutate=corrupt)
    with pytest.raises(capture.SnapshotError):
        run(transport)


@pytest.mark.parametrize("raw", [
    b'{"baton":null,"baton":null,"results":[]}', b'\xff', b'{',
    b'{"baton":null,"results":[],"bad":NaN}',
    b'{"baton":null,"results":[],"bad":1e999}',
])
def test_raw_response_parser_rejects_duplicate_invalid_utf8_and_json(source, raw):
    transport = SQLiteHrana(source(), response_error=lambda _: raw)
    with pytest.raises(capture.SnapshotError):
        run(transport)
    assert transport.closed and transport.response.closed


@pytest.mark.parametrize("url", ["http://candidate.turso.io", "https://turso.io", "https://other.invalid",
    "https://user:secret@candidate.turso.io", "https://candidate.turso.io/?token=secret",
    "https://candidate.turso.io/stream", "https://candidate.turso.io:444", "https://candidate.turso.io#secret",
    "https://candidate.turso.io\\evil", "https://candidate.turso.io\n", "https://cändidate.turso.io"])
def test_origin_validation_before_send_never_leaks_input(source, url):
    transport = SQLiteHrana(source())
    with pytest.raises(capture.SnapshotError, match="^invalid_capture_arguments$"):
        capture.capture_scope_snapshot(candidate_origin=url, token=TOKEN, transport=transport)
    assert not transport.calls


@pytest.mark.parametrize("kwargs", [{"operational_tables": set()}, {"operational_tables": frozenset({"unknown"})},
    {"optimizer_statistics": 1}, {"timeout_seconds": True}, {"timeout_seconds": float("inf")},
    {"timeout_seconds": 0}, {"expected_resource_sha256": "bad"}, {"expected_resource_sha256": "0" * 64}])
def test_argument_and_resource_fingerprint_guards_have_zero_calls(source, kwargs):
    transport = SQLiteHrana(source())
    with pytest.raises(capture.SnapshotError):
        run(transport, **kwargs)
    assert not transport.calls


@pytest.mark.parametrize("mutation", ["extra", "schema_sql", "missing_sql", "attached", "version9", "header9", "missing_version", "missing_optional"])
def test_schema_closed_whitelist_and_schema8_only(source, mutation):
    conn = source()
    inventory = frozenset()
    if mutation == "extra":
        conn.execute("CREATE TABLE unknown_operational(x)")
    elif mutation == "attached":
        conn.execute("ATTACH ':memory:' AS private_attached")
    elif mutation == "version9":
        conn.execute("UPDATE _schema_version SET version=9")
    elif mutation == "header9":
        conn.execute("PRAGMA user_version=9")
    elif mutation == "missing_version":
        conn.execute("DELETE FROM _schema_version")
    elif mutation == "missing_optional":
        inventory = frozenset({"universe_import_state"})
    conn.commit()
    def change(payload, body):
        if mutation in {"schema_sql", "missing_sql"}:
            rows = row_result(payload, body, "main.sqlite_master")["rows"]
            entry = next(row for row in rows if row[1].get("value") == "funds")
            entry[3] = encode(None if mutation == "missing_sql" else "CREATE TABLE funds(private injected)")
    transport = SQLiteHrana(conn, mutate=change)
    with pytest.raises(capture.SnapshotError):
        run(transport, operational_tables=inventory)
    assert len(transport.calls) == 1


def test_cell_response_row_depth_and_node_limits(source, monkeypatch):
    def large_cell(payload, body):
        row_result(payload, body, 'main."funds"')["rows"][0][2] = encode("x" * (capture.MAX_CELL_BYTES + 1))
    with pytest.raises(capture.SnapshotError, match="^capture_value_invalid$"):
        run(SQLiteHrana(source(), mutate=large_cell))
    monkeypatch.setattr(capture, "MAX_RESPONSE_BYTES", 16)
    with pytest.raises(capture.SnapshotError, match="^capture_response_limit$"):
        run(SQLiteHrana(source()))
    monkeypatch.setattr(capture, "MAX_RESPONSE_BYTES", 64 * 1024 * 1024)
    monkeypatch.setattr(capture, "MAX_PROTOCOL_DEPTH", 2)
    with pytest.raises(capture.SnapshotError, match="^capture_response_limit$"):
        run(SQLiteHrana(source()))
    monkeypatch.setattr(capture, "MAX_PROTOCOL_DEPTH", 24)
    monkeypatch.setattr(capture, "MAX_PROTOCOL_NODES", 2)
    with pytest.raises(capture.SnapshotError, match="^capture_response_limit$"):
        run(SQLiteHrana(source()))


@pytest.mark.parametrize("failure", ["http", "status_bool", "response_close", "transport_close", "timeout", "read"])
def test_transport_cleanup_http_and_deadline_fail_closed(source, failure, monkeypatch):
    transport = SQLiteHrana(source(), close_error=failure == "transport_close")
    original = transport.send
    def send(**options):
        response = original(**options)
        if failure == "http":
            response.status_code = 302
        elif failure == "status_bool":
            response.status_code = True
        elif failure == "response_close":
            response.fail_close = True
        elif failure in {"timeout", "read"}:
            def read(chunk_size):
                if failure == "timeout":
                    monkeypatch.setattr(capture.time, "monotonic", lambda: 10**20)
                    yield b"{}"
                else:
                    raise RuntimeError("private-network-detail")
                    yield b""
            response.iter_content = read
        return response
    transport.send = send
    with pytest.raises(capture.SnapshotError) as error:
        run(transport)
    assert "private" not in str(error.value) and TOKEN not in str(error.value)
    assert transport.closed and transport.response.closed
    if failure in {"http", "status_bool"}:
        assert not transport.response.iterated


def test_seed_affinity_cannot_silently_change_received_types(source):
    def change(payload, body):
        # SQLite TEXT affinity would change integer to a string on insertion.
        row_result(payload, body, 'main."funds"')["rows"][0][2] = encode(123)
    with pytest.raises(capture.SnapshotError, match="^capture_value_invalid$"):
        run(SQLiteHrana(source(), mutate=change))


def test_rowid_order_duplicate_and_aggregate_row_limits(source, monkeypatch):
    def duplicate(payload, body):
        rows = row_result(payload, body, 'main."funds"')["rows"]
        rows[1][0] = rows[0][0]
    with pytest.raises(capture.SnapshotError, match="^capture_value_invalid$"):
        run(SQLiteHrana(source(), mutate=duplicate))
    monkeypatch.setattr(capture, "MAX_ROWS", 2)
    with pytest.raises(capture.SnapshotError, match="^capture_row_limit$"):
        run(SQLiteHrana(source()))


def test_repeated_capture_is_same_typed_image_and_bound_inventory(source):
    first = run(SQLiteHrana(source()))
    second = run(SQLiteHrana(source()))
    try:
        assert first.safe_metadata == second.safe_metadata
    finally:
        first.close()
        second.close()


def test_current_hrana_metrics_and_undefined_non_dml_counts_are_typed_not_readonly_proof(source):
    def metric(payload, body):
        for result in payload["results"][0]["response"]["result"]["step_results"]:
            if result is not None:
                result.update(affected_row_count=4, last_insert_rowid="-9223372036854775808",
                              rows_read=100, rows_written=4, query_duration_ms=0.25)
    with run(SQLiteHrana(source(), mutate=metric)) as snapshot:
        assert snapshot.safe_metadata["consistent_sql_snapshot"]
        assert not snapshot.safe_metadata["remote_verified"]


@pytest.mark.parametrize("location", ["statement", "batch"])
@pytest.mark.parametrize("value", [None, "0", "18446744073709551615"])
def test_current_hrana_explicit_replication_index_accepts_null_and_canonical_u64(source, location, value):
    def change(payload, body):
        result = payload["results"][0]["response"]["result"]
        target = result if location == "batch" else row_result(payload, body, "COMMIT")
        target["replication_index"] = value
    with run(SQLiteHrana(source(), mutate=change)) as snapshot:
        assert snapshot.safe_metadata["consistent_sql_snapshot"]
        assert not snapshot.safe_metadata["apply_preimage_verified"]
        assert not snapshot.safe_metadata["remote_verified"]


@pytest.mark.parametrize("location", ["statement", "batch"])
@pytest.mark.parametrize("value", [
    0, 1, True, -1, 0.0, "", "00", "01", "+1", "-1", "1.0", "1e0", "1\n",
    "18446744073709551616", "999999999999999999999", "\u0661", [], {},
])
def test_replication_index_rejects_coercion_spelling_and_uint64_overflow(source, location, value):
    def change(payload, body):
        result = payload["results"][0]["response"]["result"]
        target = result if location == "batch" else row_result(payload, body, "COMMIT")
        target["replication_index"] = value
    transport = SQLiteHrana(source(), mutate=change)
    with pytest.raises(capture.SnapshotError, match="^capture_protocol_invalid$"):
        run(transport)
    assert transport.closed and transport.response.closed


@pytest.mark.parametrize("location", ["statement", "batch"])
def test_replication_index_extension_does_not_open_other_protocol_fields(source, location):
    def change(payload, body):
        result = payload["results"][0]["response"]["result"]
        target = result if location == "batch" else row_result(payload, body, "COMMIT")
        target.update(replication_index="0", unreviewed="private-unreviewed-marker")
    with pytest.raises(capture.SnapshotError, match="^capture_protocol_invalid$"):
        run(SQLiteHrana(source(), mutate=change))


@pytest.mark.parametrize("unpadded", [False, True])
@pytest.mark.parametrize("value", [b"", b"a", b"ab", b"abc", b"\x00\xff", b"abcd"])
def test_canonical_padded_and_official_no_pad_blob_roundtrip_exactly(source, unpadded, value):
    conn = source()
    conn.execute("UPDATE funds SET name=? WHERE code='000001'", (value,))
    conn.commit()
    def change(payload, body):
        rows = row_result(payload, body, 'main."funds"')["rows"]
        blob = rows[0][2]
        assert blob["type"] == "blob"
        if unpadded:
            blob["base64"] = blob["base64"].rstrip("=")
    with run(SQLiteHrana(conn, mutate=change)) as snapshot:
        assert snapshot.connection.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0] == value


@pytest.mark.parametrize("value", ["YQ=", "YQ===", "YR", "YR==", "YWI==", "YWJj=", "Y-Q", "Y Q==", "YQ==\n"])
def test_blob_never_accepts_noncanonical_tail_bits_padding_or_alphabet(source, value):
    def change(payload, body):
        row_result(payload, body, 'main."funds"')["rows"][0][2] = {"type": "blob", "base64": value}
    with pytest.raises(capture.SnapshotError, match="^capture_value_invalid$"):
        run(SQLiteHrana(source(), mutate=change))


def test_actual_libsql_json_shape_replication_index_metrics_and_no_pad_blob(source):
    conn = source()
    conn.execute("UPDATE funds SET name=? WHERE code='000001'", (b"a",))
    conn.commit()
    def change(payload, body):
        result = payload["results"][0]["response"]["result"]
        result["replication_index"] = "18446744073709551615"
        for statement in result["step_results"]:
            if statement is None:
                continue
            statement.update(replication_index=None, rows_read=0, rows_written=0, query_duration_ms=0.25)
            for row in statement["rows"]:
                for value in row:
                    if value["type"] == "blob":
                        value["base64"] = value["base64"].rstrip("=")
    with run(SQLiteHrana(conn, mutate=change)) as snapshot:
        assert snapshot.connection.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0] == b"a"
        assert snapshot.safe_metadata["consistent_sql_snapshot"]
        assert not snapshot.safe_metadata["remote_verified"]
        assert not snapshot.safe_metadata["apply_preimage_verified"]


@pytest.mark.parametrize("field,value", [
    ("affected_row_count", 1.0), ("affected_row_count", -1), ("affected_row_count", "0"),
    ("rows_read", True), ("rows_read", 2**53), ("rows_written", -1),
    ("query_duration_ms", True), ("query_duration_ms", "1"), ("query_duration_ms", float("nan")),
    ("query_duration_ms", -1), ("last_insert_rowid", "9223372036854775808"),
])
def test_optional_metrics_counts_and_insert_rowid_do_not_accept_coercion(source, field, value):
    def change(payload, body):
        row_result(payload, body, "COMMIT")[field] = value
    with pytest.raises(capture.SnapshotError):
        run(SQLiteHrana(source(), mutate=change))


def test_all_schema_and_data_queries_share_real_sqlite_snapshot_despite_interleaved_writer(source, tmp_path):
    memory = source()
    path = tmp_path / "explicit-synthetic-remote-standin.db"
    first = sqlite3.connect(path)
    second = None
    try:
        memory.backup(first)
        assert first.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        second = sqlite3.connect(path)
        changed = []
        def before(index, sql):
            if sql == 'SELECT rowid,* FROM main."funds" ORDER BY rowid LIMIT 100001':
                assert first.in_transaction and first.execute("PRAGMA query_only").fetchone()[0] == 1
                second.execute("UPDATE funds SET name='new-private-writer-marker' WHERE code='000001'")
                second.commit()
                changed.append(True)
        transport = SQLiteHrana(first, before_step=before)
        with run(transport) as snapshot:
            assert changed == [True]
            assert snapshot.connection.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0] == "private-fund-marker"
            assert second.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0] == "new-private-writer-marker"
            assert not snapshot.safe_metadata["apply_preimage_verified"]
        assert len(transport.calls) == 1 and not first.in_transaction
    finally:
        if second is not None:
            second.close()
        first.close()


def test_valid_sqlite_int64_rowid_blob_and_empty_null_remain_exact(source):
    conn = source()
    conn.execute("DELETE FROM funds")
    conn.execute("DELETE FROM fund_detail")
    conn.execute("DELETE FROM nav_history")
    conn.execute("INSERT INTO funds(rowid,code,name,type,pinyin) VALUES(?,?,?,?,?)",
                 (-(2**63), "000001", b"\x00\xff", None, ""))
    conn.execute("INSERT INTO funds(rowid,code,name,type,pinyin) VALUES(?,?,?,?,?)",
                 (2**63 - 1, "000002", "", "mixed", None))
    conn.commit()
    with run(SQLiteHrana(conn)) as snapshot:
        rows = [tuple(row) for row in snapshot.connection.execute("SELECT rowid,* FROM funds ORDER BY rowid")]
        assert rows == [(-(2**63), "000001", b"\x00\xff", None, ""),
                        (2**63 - 1, "000002", "", "mixed", None)]


@pytest.mark.parametrize("table", ["holding_versions", "portfolio_policy_versions"])
def test_invalid_private_json_or_legacy_lineage_does_not_form_snapshot(source, table):
    conn = source()
    # Inspect fixed trusted columns to fill mandatory fields with synthetic
    # placeholders. The invalid JSON must fail before any model/lineage claim.
    info = list(conn.execute(f'PRAGMA table_info("{table}")'))
    columns = [row[1] for row in info]
    values = ["private-invalid" if row[2] == "TEXT" else 0 for row in info]
    if "user_state" in columns:
        values[columns.index("user_state")] = "unheld"
    if "supersedes" in columns:
        values[columns.index("supersedes")] = None
    for name in columns:
        if name.endswith("_json"):
            values[columns.index(name)] = "[]"
    if "payload_json" in columns:
        values[columns.index("payload_json")] = '{"duplicate":1,"duplicate":2}'
    conn.execute(f'INSERT INTO "{table}"({",".join(columns)}) VALUES({",".join("?" for _ in values)})', values)
    conn.commit()
    with pytest.raises(capture.SnapshotError, match="^capture_local_validation_failed$"):
        run(SQLiteHrana(conn))


def test_strict_success_close_and_stream_origin_optional_path(source):
    def change(payload, body):
        payload["base_url"] = "https://synthetic-candidate.turso.io/stream/opaque"
    with run(SQLiteHrana(source(), mutate=change)) as snapshot:
        assert snapshot.safe_metadata["consistent_sql_snapshot"]


def test_request_transport_exception_is_fixed_closed_once_and_not_retried(source):
    class Throw(SQLiteHrana):
        def send(self, **options):
            self.calls.append(options)
            raise RuntimeError("private-network-body-and-token:" + TOKEN)
    transport = Throw(source())
    with pytest.raises(capture.SnapshotError, match="^capture_transport_failed$"):
        run(transport)
    assert len(transport.calls) == 1 and transport.closed


@pytest.mark.parametrize("explicit_default", [False, True])
def test_provider_rejects_query_only_assignment_and_default_never_falls_back(source, explicit_default):
    transport = RejectPragmaAssignments(source())
    options = {"query_mode_profile": "query-only-v1"} if explicit_default else {}
    with pytest.raises(capture.SnapshotError, match="^capture_sql_failed$") as error:
        run(transport, **options)
    assert len(transport.calls) == 1 and transport.executed == []
    assert transport.closed and transport.response.closed
    assert not transport.conn.in_transaction
    assert TOKEN not in str(error.value) and "private" not in str(error.value)
    steps = json.loads(transport.calls[0]["body"])["requests"][0]["batch"]["steps"]
    assert steps[0]["stmt"]["sql"] == "PRAGMA query_only=ON"


@pytest.mark.parametrize("observed", [0, 1])
def test_explicit_fixed_read_profile_omits_setter_and_never_claims_server_protection(source, observed):
    conn = source()
    conn.execute(f"PRAGMA query_only={observed}")
    transport = RejectPragmaAssignments(conn)
    with run(transport, query_mode_profile="turso-fixed-read-v1") as snapshot:
        assert snapshot.safe_metadata["query_mode_profile"] == "turso-fixed-read-v1"
        assert snapshot.safe_metadata["query_only_observed"] == observed
        assert type(snapshot.safe_metadata["query_only_observed"]) is int
        assert snapshot.safe_metadata["server_write_protection_verified"] is False
        assert all(snapshot.safe_metadata[name] is False for name in (
            "remote_verified", "remote_applied", "remote_restore_verified", "formal_release_verified",
            "migration_rehearsed", "apply_preimage_verified"))
        # Local reconstructed image protection is not the remote observation.
        assert snapshot.connection.execute("PRAGMA query_only").fetchone()[0] == 1
    sqls = [sql for _, sql in transport.executed]
    assert sqls[0] == "BEGIN" and "PRAGMA query_only=ON" not in sqls
    assert not any(sql.startswith("PRAGMA ") and "=" in sql for sql in sqls)
    assert len(transport.calls) == 1 and transport.closed and transport.response.closed
    assert conn.execute("PRAGMA query_only").fetchone()[0] == observed


@pytest.mark.parametrize("profile", [None, True, 0, [], {}, "", "QUERY-ONLY-V1",
                                      "turso-fixed-read-v2", "turso-fixed-read-v1\n"])
def test_unknown_query_profiles_fail_before_any_transport_call(source, profile):
    transport = RejectPragmaAssignments(source())
    with pytest.raises(capture.SnapshotError, match="^invalid_capture_arguments$"):
        run(transport, query_mode_profile=profile)
    assert not transport.calls and transport.response is None


@pytest.mark.parametrize("raw", [
    encode(-1), encode(2), encode(0.0), encode(1.0), encode("0"), encode("1"), encode(None),
    {"type": "integer", "value": True}, {"type": "float", "value": True},
])
def test_fixed_read_getter_rejects_unknown_float_boolean_and_coercion(source, raw):
    def change(payload, body):
        row_result(payload, body, "PRAGMA query_only")["rows"] = [[raw]]
    transport = RejectPragmaAssignments(source(), mutate=change)
    with pytest.raises(capture.SnapshotError):
        run(transport, query_mode_profile="turso-fixed-read-v1")
    assert len(transport.calls) == 1 and transport.closed and transport.response.closed


@pytest.mark.parametrize("rows", [[], [[], []], [[encode(0)], [encode(1)]], [[encode(0), encode(1)]]])
def test_fixed_read_getter_requires_exact_single_cell(source, rows):
    def change(payload, body):
        row_result(payload, body, "PRAGMA query_only")["rows"] = rows
    with pytest.raises(capture.SnapshotError):
        run(RejectPragmaAssignments(source(), mutate=change), query_mode_profile="turso-fixed-read-v1")


@pytest.mark.parametrize("profile", QUERY_PROFILES)
def test_query_profiles_keep_closed_fixed_sql_and_transaction_condition_chain(source, profile):
    plan, names, _, _, commit_index = capture._plan(source(), profile)
    steps = plan["requests"][0]["batch"]["steps"]
    assert plan["baton"] is None
    assert [request["type"] for request in plan["requests"]] == ["batch", "get_autocommit", "close"]
    assert names[0] == ("query_only_on" if profile == "query-only-v1" else "begin")
    assert "condition" not in steps[0]
    for index, name in enumerate(names[1:], 1):
        assert steps[index]["condition"] == {"type": "and", "conds": [
            {"type": "ok", "step": index - 1},
            ({"type": "is_autocommit"} if name == "begin" else
             {"type": "not", "cond": {"type": "is_autocommit"}}),
        ]}
    assert steps[commit_index]["condition"] == {"type": "and", "conds": [
        {"type": "ok", "step": commit_index - 1},
        {"type": "not", "cond": {"type": "is_autocommit"}},
    ]}
    assert steps[commit_index + 1]["condition"] == {"type": "and", "conds": [
        {"type": "not", "cond": {"type": "ok", "step": commit_index}},
        {"type": "not", "cond": {"type": "is_autocommit"}},
    ]}
    for step in steps:
        sql = step["stmt"]["sql"]
        assert step["stmt"] == {"sql": sql, "args": [], "named_args": [], "want_rows": True}
        assert sql in ("BEGIN", "COMMIT", "ROLLBACK", "PRAGMA query_only=ON") or sql.startswith(("SELECT ", "PRAGMA "))
        if profile == "turso-fixed-read-v1":
            assert sql != "PRAGMA query_only=ON"
    assert capture._plan(source())[0] == capture._plan(source(), "query-only-v1")[0]


@pytest.mark.parametrize("failure", ["BEGIN", "PRAGMA query_only", "COMMIT", 'main."funds"', "autocommit"])
def test_fixed_read_sql_and_autocommit_failures_still_close_without_success_or_retry(source, failure):
    conn = source()
    def before(index, sql):
        if failure == "autocommit" and sql == "PRAGMA query_only":
            conn.rollback()
    failing_sql = ('SELECT rowid,* FROM main."funds" ORDER BY rowid LIMIT 100001'
                   if failure == 'main."funds"' else failure)
    transport = RejectPragmaAssignments(conn, sql_error=None if failure == "autocommit" else failing_sql,
                                        before_step=before)
    with pytest.raises(capture.SnapshotError):
        run(transport, query_mode_profile="turso-fixed-read-v1")
    assert len(transport.calls) == 1 and transport.closed and transport.response.closed
    assert not conn.in_transaction
    sqls = [sql for _, sql in transport.executed]
    if failure == "autocommit":
        assert sqls == ["BEGIN", "PRAGMA query_only"]
    elif failure == "BEGIN":
        assert sqls == ["BEGIN"]
    elif failure == "COMMIT":
        assert sqls[-2:] == ["COMMIT", "ROLLBACK"]
    else:
        assert sqls[-1] == "ROLLBACK" and "COMMIT" not in sqls


def _raw_schema_rows(conn):
    return tuple(tuple(row) for row in conn.execute(
        "SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name"))


def _format_only_source_ddl(conn, table="funds"):
    original = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
    changed = original.replace("CREATE TABLE", "CREATE \n  TABLE", 1)
    assert changed != original
    assert offline.turso_schema._normalize_ddl(changed) == offline.turso_schema._normalize_ddl(original)
    conn.execute("PRAGMA writable_schema=ON")
    try:
        conn.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name=?", (changed, table))
        conn.commit()
    finally:
        conn.execute("PRAGMA writable_schema=OFF")
    return original, changed


@pytest.mark.parametrize("profile", QUERY_PROFILES)
def test_private_inventory_retains_real_sqlite_raw_format_and_all_null_objects(source, profile):
    conn = source()
    original, changed = _format_only_source_ddl(conn)
    expected = _raw_schema_rows(conn)
    null_rows = tuple(row for row in expected if row[3] is None)
    assert null_rows and any(row[1].startswith("sqlite_autoindex_") for row in null_rows)
    with run(SQLiteHrana(conn), query_mode_profile=profile) as snapshot:
        inventory = snapshot._schema_inventory
        assert type(inventory) is capture._ValidatedSchemaInventory
        assert inventory.profile == "captured-schema-inventory-v1"
        assert inventory.rows == expected
        assert type(inventory.rows) is tuple
        assert all(type(row) is tuple and len(row) == 4
                   and all(type(value) is str for value in row[:3])
                   and (row[3] is None or type(row[3]) is str) for row in inventory.rows)
        assert tuple(row for row in inventory.rows if row[3] is None) == null_rows
        raw_sql = next(row[3] for row in inventory.rows if row[:2] == ("table", "funds"))
        assert raw_sql == changed
        assert snapshot.connection.execute("SELECT sql FROM sqlite_master WHERE name='funds'").fetchone()[0] == original
        assert inventory.exact_sha256 == capture._schema_inventory_digest(expected)
        assert inventory.resource_sha256 == snapshot.safe_metadata["resource_sha256"]
        assert inventory.source_image_sha256 == snapshot.safe_metadata["source_sha256"]
        assert inventory.source_rows_sha256 == snapshot.safe_metadata["source_rows_sha256"]
        assert hashlib.sha256(snapshot.connection.serialize()).hexdigest() == inventory.source_image_sha256


def test_raw_inventory_digest_distinguishes_format_even_when_safe_metadata_and_logical_image_are_same(source):
    first_conn, second_conn = source(), source()
    _format_only_source_ddl(second_conn)
    with run(SQLiteHrana(first_conn)) as first, run(SQLiteHrana(second_conn)) as second:
        assert first.safe_metadata == second.safe_metadata
        assert first.connection.serialize() == second.connection.serialize()
        assert first._schema_inventory.rows != second._schema_inventory.rows
        assert first._schema_inventory.exact_sha256 != second._schema_inventory.exact_sha256


def test_raw_inventory_digest_uses_exact_typed_domain_separated_framing():
    rows = (("table", "synthetic", "synthetic", "CREATE TABLE synthetic(v TEXT DEFAULT 'a  b')"),
            ("trigger", "synthetic_guard", "synthetic", "CREATE TRIGGER synthetic_guard AFTER INSERT ON synthetic BEGIN SELECT 'x'; END"))
    expected_frame = {
        "domain": "fund-compass:captured-schema-inventory-v1",
        "columns": ["type", "name", "tbl_name", "sql"],
        "rows": [[["text", value] for value in row] for row in rows],
    }
    expected = hashlib.sha256(offline._json_bytes(expected_frame)).hexdigest()
    assert capture._schema_inventory_digest(rows) == expected
    literal_changed = (rows[0][:-1] + (rows[0][3].replace("'a  b'", "'a b'"),), rows[1])
    assert capture._schema_inventory_digest(literal_changed) != expected
    assert offline.turso_schema._normalize_ddl(rows[0][3]) != offline.turso_schema._normalize_ddl(literal_changed[0][3])
    null_sql = (("index", "sqlite_autoindex_synthetic_1", "synthetic", None),)
    empty_sql = (("index", "sqlite_autoindex_synthetic_1", "synthetic", ""),)
    assert capture._schema_inventory_digest(null_sql) != capture._schema_inventory_digest(empty_sql)
    undomain_frame = {key: value for key, value in expected_frame.items() if key != "domain"}
    assert expected != hashlib.sha256(offline._json_bytes(undomain_frame)).hexdigest()


def test_private_inventory_is_immutable_and_never_added_to_public_metadata_or_repr(source):
    with run(SQLiteHrana(source())) as snapshot:
        inventory = snapshot._schema_inventory
        with pytest.raises(FrozenInstanceError):
            inventory.rows = ()
        with pytest.raises(FrozenInstanceError):
            inventory.exact_sha256 = "0" * 64
        with pytest.raises(TypeError):
            inventory.rows[0] = inventory.rows[0]
        with pytest.raises(TypeError):
            inventory.rows[0][3] = "private-replacement-marker"
        assert not hasattr(inventory, "__dict__")
        assert set(snapshot.safe_metadata) == {
            "ok", "from_schema", "evidence_scope", "source_kind", "resource_sha256",
            "source_sha256", "source_rows_sha256", "source_contract_sha256",
            "operational_profile", "inventory_sha256", "query_mode_profile", "query_only_observed",
            "server_write_protection_verified", "table_count", "row_count", "consistent_sql_snapshot",
            "remote_verified", "remote_applied", "remote_restore_verified", "formal_release_verified",
            "migration_rehearsed", "apply_preimage_verified",
        }
        public = repr(snapshot) + repr(inventory) + json.dumps(snapshot.safe_metadata)
        assert all(marker not in public for marker in ("CREATE TABLE", "CREATE TRIGGER", ORIGIN, TOKEN, "private-fund-marker"))
        # Old explicit two-positional construction remains supported, but is
        # intentionally missing the private historical preimage capability.
        legacy = capture.CapturedSnapshot(snapshot.connection, snapshot.safe_metadata)
        assert legacy._schema_inventory is None
        with pytest.raises(TypeError):
            capture.CapturedSnapshot(snapshot.connection, snapshot.safe_metadata, inventory)


@pytest.mark.parametrize("mutation", [
    lambda rows: list(rows),
    lambda rows: (list(rows[0]), *rows[1:]),
    lambda rows: (),
    lambda rows: (rows[0][:-1], *rows[1:]),
    lambda rows: (("unreviewed", *rows[0][1:]), *rows[1:]),
    lambda rows: ((rows[0][0], 1, *rows[0][2:]), *rows[1:]),
    lambda rows: ((rows[0][0], rows[0][1], True, rows[0][3]), *rows[1:]),
    lambda rows: ((*rows[0][:3], b"private-sql-bytes"), *rows[1:]),
    lambda rows: ((*rows[0][:3], False), *rows[1:]),
    lambda rows: ((rows[0][0], rows[0][1] + "\x00", *rows[0][2:]), *rows[1:]),
    lambda rows: ((rows[0][0], rows[0][1], "\ud800", rows[0][3]), *rows[1:]),
    lambda rows: (rows[0], *rows),
    lambda rows: tuple(reversed(rows)),
    lambda rows: (rows[0],) * 129,
])
def test_private_inventory_rejects_mutable_non_native_malformed_duplicate_unsorted_and_unbounded_rows(source, mutation):
    with run(SQLiteHrana(source())) as snapshot:
        inventory = snapshot._schema_inventory
        with pytest.raises(capture.SnapshotError) as error:
            replace(inventory, rows=mutation(inventory.rows))
        assert TOKEN not in str(error.value) and "private" not in str(error.value)


@pytest.mark.parametrize("field", ["exact_sha256", "resource_sha256", "source_image_sha256", "source_rows_sha256"])
@pytest.mark.parametrize("value", [None, True, "", "A" * 64, "a" * 64 + "\n"])
def test_private_inventory_digest_fields_are_exact_closed_lowercase_sha256(source, field, value):
    with run(SQLiteHrana(source())) as snapshot:
        with pytest.raises(capture.SnapshotError, match="^capture_value_invalid$"):
            replace(snapshot._schema_inventory, **{field: value})


def test_private_inventory_rejects_a_well_spelled_but_wrong_raw_digest(source):
    with run(SQLiteHrana(source())) as snapshot:
        with pytest.raises(capture.SnapshotError, match="^capture_schema_mismatch$"):
            replace(snapshot._schema_inventory, exact_sha256="0" * 64)


def test_private_inventory_is_built_only_after_cleanup_and_complete_assembly(source, monkeypatch):
    transport = SQLiteHrana(source())
    events = []
    assemble, inventory = capture._assemble, capture._captured_schema_inventory
    def assembling(*args, **kwargs):
        assert transport.closed and transport.response.closed
        result = assemble(*args, **kwargs)
        events.append("assembled")
        return result
    def building(*args, **kwargs):
        assert events == ["assembled"] and transport.closed and transport.response.closed
        result = inventory(*args, **kwargs)
        events.append("private_inventory")
        return result
    monkeypatch.setattr(capture, "_assemble", assembling)
    monkeypatch.setattr(capture, "_captured_schema_inventory", building)
    with run(transport) as snapshot:
        assert snapshot._schema_inventory is not None
        assert events == ["assembled", "private_inventory"]


@pytest.mark.parametrize("failure", ["sql", "schema", "literal", "null_sql", "cleanup"])
def test_failed_capture_never_constructs_or_returns_private_schema_inventory(source, monkeypatch, failure):
    builds = []
    def forbidden(*args, **kwargs):
        builds.append(True)
        raise AssertionError("private inventory must not be built after failure")
    monkeypatch.setattr(capture, "_captured_schema_inventory", forbidden)
    conn = source()
    def mutate(payload, body):
        if failure in {"sql", "cleanup"}:
            return
        schema = row_result(payload, body, "main.sqlite_master")["rows"]
        if failure == "schema":
            schema[0][2] = encode("private-unreviewed-table")
        elif failure == "literal":
            row = next(row for row in schema if row[0]["value"] == "trigger" and " is immutable'" in row[3]["value"])
            row[3] = encode(row[3]["value"].replace(" is immutable'", " is  immutable'"))
        elif failure == "null_sql":
            row = next(row for row in schema if row[3]["type"] == "null")
            row[3] = encode("")
    transport = SQLiteHrana(conn, mutate=mutate, sql_error=0 if failure == "sql" else None,
                            close_error=failure == "cleanup")
    expected_code = {"sql": "capture_sql_failed", "cleanup": "capture_cleanup_failed"}.get(
        failure, "capture_schema_mismatch")
    with pytest.raises(capture.SnapshotError, match=f"^{expected_code}$"):
        run(transport)
    assert builds == []
    assert transport.closed and transport.response.closed and len(transport.calls) == 1


def test_private_raw_inventory_and_data_keep_same_historical_snapshot_with_concurrent_format_writer(source, tmp_path):
    memory = source()
    path = tmp_path / "synthetic-private-inventory-writer.db"
    first = sqlite3.connect(path)
    second = None
    try:
        memory.backup(first)
        assert first.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        second = sqlite3.connect(path)
        before_schema = _raw_schema_rows(first)
        original = next(row[3] for row in before_schema if row[:2] == ("table", "funds"))
        formatted = original.replace("CREATE TABLE", "CREATE \n  TABLE", 1)
        changed = []
        def before(index, sql):
            if sql == 'SELECT rowid,* FROM main."funds" ORDER BY rowid LIMIT 100001':
                assert first.in_transaction
                second.execute("PRAGMA writable_schema=ON")
                try:
                    second.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='funds'", (formatted,))
                    second.execute("UPDATE funds SET name='private-concurrent-writer' WHERE code='000001'")
                    second.commit()
                finally:
                    second.execute("PRAGMA writable_schema=OFF")
                changed.append(True)
        transport = SQLiteHrana(first, before_step=before)
        with run(transport) as snapshot:
            assert changed == [True]
            assert snapshot._schema_inventory.rows == before_schema
            assert snapshot._schema_inventory.exact_sha256 == capture._schema_inventory_digest(before_schema)
            assert _raw_schema_rows(second) != before_schema
            assert snapshot.connection.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0] == "private-fund-marker"
            assert second.execute("SELECT name FROM funds WHERE code='000001'").fetchone()[0] == "private-concurrent-writer"
            assert snapshot.safe_metadata["apply_preimage_verified"] is False
        assert len(transport.calls) == 1 and not first.in_transaction
    finally:
        if second is not None:
            second.close()
        first.close()
