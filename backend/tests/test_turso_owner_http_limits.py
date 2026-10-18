"""Opt-in driver contracts; no provider requests or credentials."""
import json
import sqlite3
import time

import pytest

from database import turso


class Response:
    def __init__(self, raw=b"", status=200, *, chunks=None):
        self.raw, self.status_code, self.chunks = raw, status, chunks
        self.closed = False
        self.json_reads = self.stream_reads = 0

    def json(self):
        self.json_reads += 1
        return json.loads(self.raw)

    def iter_content(self, chunk_size):
        self.stream_reads += 1
        assert chunk_size == 64 * 1024
        yield from self.chunks if self.chunks is not None else (self.raw,)

    def close(self):
        self.closed = True


class Session:
    def __init__(self, response):
        self.response, self.headers = response, {}
        self.trust_env = True
        self.calls = []
        self.closed = False

    def mount(self, *_args):
        pass

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response

    def close(self):
        self.closed = True


def payload():
    return {"baton": "synthetic-stream", "base_url": None,
            "results": [{"type": "ok", "response": {"type": "get_autocommit", "is_autocommit": True}}]}


def make_connection(monkeypatch, response, limits):
    session = Session(response)
    monkeypatch.setattr(turso.requests, "Session", lambda: session)
    connection = turso.Connection("https://candidate.example.invalid", "synthetic-token", http_limits=limits)
    return connection, session


def dispose(connection):
    # These response-only unit doubles have no real remote stream. End the
    # owned local Session without inventing a successful SQL close response.
    connection._broken = True
    connection.close()


def test_legacy_default_keeps_json_api_and_ambient_transport_behavior(monkeypatch):
    response = Response(json.dumps(payload()).encode())
    conn, session = make_connection(monkeypatch, response, None)
    try:
        conn._pipeline([{"type": "get_autocommit"}])
        assert response.json_reads == 1 and response.stream_reads == 0
        assert session.trust_env is True
        assert "json" in session.calls[0][1] and "data" not in session.calls[0][1]
        assert "stream" not in session.calls[0][1]
    finally:
        dispose(conn)


def test_explicit_limits_use_exact_bytes_streaming_no_environment_and_no_redirect(monkeypatch):
    response = Response(json.dumps(payload()).encode())
    conn, session = make_connection(monkeypatch, response, turso.HttpLimits(2, 4096))
    try:
        conn._pipeline([{"type": "get_autocommit"}])
        assert response.json_reads == 0 and response.stream_reads == 1 and response.closed
        assert session.trust_env is False
        assert session.headers["Accept-Encoding"] == "identity"
        options = session.calls[0][1]
        assert options["stream"] is True and options["allow_redirects"] is False
        assert 0 < options["timeout"] <= 2
        assert "json" not in options
        assert json.loads(options["data"]) == {"baton": None, "requests": [{"type": "get_autocommit"}]}
    finally:
        dispose(conn)


@pytest.mark.parametrize("raw", [
    b'{"baton":"one","baton":"two","results":[]}',
    b'{"baton":"one","results":[],"x":NaN}',
    b'{"baton":"one","results":[],"x":1e10000}',
    b'{"baton":"one","results":[],"x":"\\ud800"}',
    b'[' * 30 + b'0' + b']' * 30,
    b'\xff',
])
def test_invalid_or_unbounded_json_breaks_stream_without_private_error_or_retry(monkeypatch, raw):
    response = Response(raw)
    conn, session = make_connection(monkeypatch, response, turso.HttpLimits(2, 4096))
    try:
        with pytest.raises(sqlite3.OperationalError) as caught:
            conn._pipeline([{"type": "get_autocommit"}])
        assert "synthetic-token" not in str(caught.value)
        assert len(session.calls) == 1 and conn._broken and response.closed
        assert response.json_reads == 0
    finally:
        dispose(conn)


def test_body_byte_limit_is_enforced_during_streaming(monkeypatch):
    response = Response(chunks=[b"x" * 8, b"y" * 8])
    conn, session = make_connection(monkeypatch, response, turso.HttpLimits(2, 12))
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn._pipeline([{"type": "get_autocommit"}])
        assert conn._broken and response.closed and len(session.calls) == 1
    finally:
        dispose(conn)


def test_expired_total_budget_during_body_never_reads_json_or_sends_followup(monkeypatch):
    clock = [10.0]
    monkeypatch.setattr(turso.time, "monotonic", lambda: clock[0])

    class SlowResponse(Response):
        def iter_content(self, chunk_size):
            clock[0] += 2
            yield self.raw

    response = SlowResponse(json.dumps(payload()).encode())
    conn, session = make_connection(monkeypatch, response, turso.HttpLimits(1, 4096))
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn._pipeline([{"type": "get_autocommit"}])
        assert response.json_reads == 0 and len(session.calls) == 1 and conn._broken
    finally:
        dispose(conn)


def test_real_close_delay_is_included_in_opted_in_total_budget(monkeypatch):
    class SlowClose(Response):
        def close(self):
            time.sleep(0.15)
            super().close()

    response = SlowClose(json.dumps(payload()).encode())
    conn, session = make_connection(monkeypatch, response, turso.HttpLimits(0.1, 4096))
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn._pipeline([{"type": "get_autocommit"}])
        assert response.closed and conn._broken and len(session.calls) == 1
    finally:
        dispose(conn)


def test_request_size_failure_happens_before_post(monkeypatch):
    response = Response()
    conn, session = make_connection(monkeypatch, response, turso.HttpLimits(2, 4096, max_request_bytes=1))
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn._pipeline([{"type": "get_autocommit"}])
        assert not session.calls and conn._broken
    finally:
        dispose(conn)


@pytest.mark.parametrize("status", [301, 401, 403, 429, 500])
def test_non_success_http_status_never_reads_provider_body(monkeypatch, status):
    response = Response(b"synthetic-private-response", status)
    conn, session = make_connection(monkeypatch, response, turso.HttpLimits(2, 4096))
    try:
        with pytest.raises(turso.TursoHTTPError) as caught:
            conn._pipeline([{"type": "get_autocommit"}])
        assert caught.value.status_code == status
        assert response.json_reads == response.stream_reads == 0
        assert conn._broken and response.closed and len(session.calls) == 1
    finally:
        dispose(conn)


def empty():
    return {"cols": [], "rows": [], "affected_row_count": 0, "last_insert_rowid": None}


def test_deferred_begin_is_explicit_and_default_remains_immediate(monkeypatch):
    conn, _ = make_connection(monkeypatch, Response(), turso.HttpLimits(2, 4096))
    seen = []

    def run(operation):
        seen.append(operation)
        return {"step_results": [empty(), empty(), empty(), None], "step_errors": [None] * 4}

    monkeypatch.setattr(conn, "_run", run)
    try:
        conn.execute_batch([("SELECT 1", ())], begin_mode="deferred")
        conn.execute_batch([("SELECT 1", ())])
        assert [operation["batch"]["steps"][0]["stmt"]["sql"] for operation in seen] == ["BEGIN DEFERRED", "BEGIN IMMEDIATE"]
    finally:
        dispose(conn)


@pytest.mark.parametrize("acknowledged", [False, True])
def test_batch_error_classification_requires_explicit_valid_rollback_ack(monkeypatch, acknowledged):
    conn, _ = make_connection(monkeypatch, Response(), turso.HttpLimits(2, 4096))
    result = {"step_results": [empty(), None, None, empty() if acknowledged else {}],
              "step_errors": [None, {"code": "SQLITE_ERROR"}, None, None]}
    monkeypatch.setattr(conn, "_run", lambda _operation: result)
    try:
        with pytest.raises(sqlite3.DatabaseError) as caught:
            conn.execute_batch([("SELECT 1", ())], classify_errors=True)
        assert isinstance(caught.value, turso.TursoBatchError) is acknowledged
        if acknowledged:
            assert caught.value.statement_index == 0 and caught.value.rollback_acknowledged is True
    finally:
        dispose(conn)


@pytest.mark.parametrize("contradiction", ["paired-error-result", "suffix-result", "suffix-error", "commit-result"])
def test_contradictory_batch_acknowledgements_are_unknown_and_break_connection(monkeypatch, contradiction):
    conn, session = make_connection(monkeypatch, Response(), turso.HttpLimits(2, 4096))
    # BEGIN + guard failure + skipped statement + skipped COMMIT + ROLLBACK.
    values = [empty(), None, None, None, empty()]
    errors = [None, {"code": "SQLITE_ERROR"}, None, None, None]
    if contradiction == "paired-error-result":
        values[1] = empty()
    elif contradiction == "suffix-result":
        values[2] = empty()
    elif contradiction == "suffix-error":
        errors[2] = {"code": "SQLITE_ERROR"}
    else:
        values[3] = empty()
    monkeypatch.setattr(conn, "_run", lambda _operation: {"step_results": values, "step_errors": errors})
    try:
        with pytest.raises(sqlite3.OperationalError) as caught:
            conn.execute_batch([("SELECT 1", ()), ("SELECT 2", ())], classify_errors=True)
        assert not isinstance(caught.value, turso.TursoBatchError)
        assert conn._broken and not session.calls
    finally:
        dispose(conn)


def test_classification_cannot_be_accidentally_enabled_on_legacy_connection(monkeypatch):
    conn, session = make_connection(monkeypatch, Response(), None)
    try:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute_batch([("SELECT 1", ())], classify_errors=True)
        assert not session.calls
    finally:
        dispose(conn)


def test_opted_in_affected_row_count_must_not_coerce_boolean_to_integer(monkeypatch):
    conn, session = make_connection(monkeypatch, Response(), turso.HttpLimits(2, 4096))
    malformed = {**empty(), "affected_row_count": True}
    monkeypatch.setattr(conn, "_run", lambda _operation: {
        "step_results": [empty(), malformed, empty(), None], "step_errors": [None] * 4})
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute_batch([("SELECT 1", ())])
        assert conn._broken and not session.calls
    finally:
        dispose(conn)


@pytest.mark.parametrize("wire", [
    {"type": "integer", "value": True}, {"type": "integer", "value": 1.5},
    {"type": "integer", "value": "1.5"}, {"type": "integer", "value": 1},
    {"type": "integer", "value": "9223372036854775808"},
    {"type": "float", "value": True}, {"type": "null", "value": None},
    {"type": "text", "value": 1},
])
def test_opted_in_wire_values_are_not_coerced(monkeypatch, wire):
    conn, session = make_connection(monkeypatch, Response(), turso.HttpLimits(2, 4096))
    statement = {**empty(), "cols": [{"name": "value"}], "rows": [[wire]]}
    monkeypatch.setattr(conn, "_run", lambda _operation: statement)
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("SELECT 1")
        assert conn._broken and not session.calls
    finally:
        dispose(conn)


def test_default_legacy_decode_coercion_is_not_changed_by_opt_in_policy(monkeypatch):
    conn, session = make_connection(monkeypatch, Response(), None)
    statement = {**empty(), "cols": [{"name": "value"}], "rows": [[{"type": "integer", "value": True}]]}
    monkeypatch.setattr(conn, "_run", lambda _operation: statement)
    try:
        assert conn.execute("SELECT 1").fetchone()[0] == 1
        assert not conn._broken and not session.calls
    finally:
        dispose(conn)


@pytest.mark.parametrize("wire", [{"type": "integer", "value": True}, {"type": "integer", "value": 1.5},
                                  {"type": "integer", "value": "1.5"}, {"type": "float", "value": 1.0}])
def test_opted_in_total_changes_must_be_a_typed_native_integer(monkeypatch, wire):
    conn, session = make_connection(monkeypatch, Response(), turso.HttpLimits(2, 4096))
    monkeypatch.setattr(conn, "_pipeline", lambda _operations: [
        {"type": "ok", "response": {"type": "execute", "result": empty()}},
        {"type": "ok", "response": {"type": "execute", "result": {"rows": [[wire]]}}},
        {"type": "ok", "response": {"type": "get_autocommit", "is_autocommit": True}},
    ])
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("SELECT 1")
        assert conn._broken and not session.calls
    finally:
        dispose(conn)
