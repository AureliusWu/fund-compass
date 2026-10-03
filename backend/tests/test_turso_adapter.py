import sqlite3

import pytest
import requests

from database import turso


class Response:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload
        self.closed = False

    def json(self):
        return self.payload

    def close(self):
        self.closed = True


class Session:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.urls = []
        self.options = []
        self.headers = {}

    def post(self, url, **kwargs):
        self.urls.append(url)
        self.options.append(kwargs)
        return next(self.responses)

    def close(self):
        pass


def connection():
    return turso.Connection("libsql://candidate.example.invalid", "test-token")


def statement_result(*rows, names=("value",), affected=0, rowid=None):
    return {
        "cols": [{"name": name, "decltype": None} for name in names],
        "rows": [[turso._encode(value) for value in row] for row in rows],
        "affected_row_count": affected,
        "last_insert_rowid": rowid,
    }


@pytest.mark.parametrize("url", [
    "http://candidate.example.invalid",
    "https://user:secret@candidate.example.invalid",
    "https://candidate.example.invalid/path",
    "https://candidate.example.invalid/?token=secret",
    "https://candidate.example.invalid:8443",
])
def test_connection_rejects_unsafe_database_urls(url):
    with pytest.raises(ValueError):
        turso.Connection(url, "test-token")


def test_server_stream_base_is_used_only_on_same_tls_origin():
    conn = connection()
    first = Response({
        "baton": "b1",
        "base_url": "https://candidate.example.invalid/stream/abc",
        "results": [{"type": "ok", "response": {"type": "get_autocommit",
                                                     "is_autocommit": True}}],
    })
    second = Response({
        "baton": "b2", "base_url": None,
        "results": [{"type": "ok", "response": {"type": "get_autocommit",
                                                     "is_autocommit": True}}],
    })
    session = Session([first, second])
    conn._session = session
    operation = {"type": "get_autocommit"}
    conn._pipeline([operation])
    conn._pipeline([operation])
    assert session.urls == [
        "https://candidate.example.invalid/v3/pipeline",
        "https://candidate.example.invalid/stream/abc/v3/pipeline",
    ]
    assert first.closed and second.closed


def test_foreign_stream_origin_breaks_connection_without_leaking_values():
    conn = connection()
    response = Response({
        "baton": "private-baton",
        "base_url": "https://attacker.invalid/private-path",
        "results": [{"type": "ok", "response": {"type": "get_autocommit",
                                                     "is_autocommit": True}}],
    })
    conn._session = Session([response])
    with pytest.raises(sqlite3.OperationalError) as caught:
        conn._pipeline([{"type": "get_autocommit"}])
    assert "attacker" not in str(caught.value) and "private" not in str(caught.value)
    with pytest.raises(sqlite3.OperationalError, match="unusable"):
        conn.execute("SELECT 1")


def test_transport_failure_is_not_retried_and_poisons_stream():
    conn = connection()

    class FailedSession(Session):
        def post(self, url, **kwargs):
            self.urls.append(url)
            raise requests.ConnectionError("private provider response")

    session = FailedSession([])
    conn._session = session
    with pytest.raises(sqlite3.OperationalError, match="outcome unknown"):
        conn.execute("SELECT 1")
    with pytest.raises(sqlite3.OperationalError, match="unusable"):
        conn.execute("SELECT 1")
    assert len(session.urls) == 1


def test_execute_decodes_rows_and_tracks_server_transaction_state(monkeypatch):
    conn = connection()
    results = [
        {"type": "ok", "response": {"type": "execute", "result":
            statement_result((7, "alpha", b"x", None),
                             names=("Count", "text", "blob", "missing"))}},
        {"type": "ok", "response": {"type": "execute", "result":
            statement_result((3,))}},
        {"type": "ok", "response": {"type": "get_autocommit", "is_autocommit": False}},
    ]
    monkeypatch.setattr(conn, "_pipeline", lambda operations: results)
    row = conn.execute("SELECT 7").fetchone()
    assert tuple(row) == (7, "alpha", b"x", None)
    assert row["count"] == 7 and dict(zip(row.keys(), row))["text"] == "alpha"
    assert conn.total_changes == 3 and conn.in_transaction is True


def test_atomic_batch_builds_commit_and_conditional_rollback(monkeypatch):
    conn = connection()
    seen = []

    def run(operation):
        seen.append(operation)
        steps = operation["batch"]["steps"]
        return {
            "step_results": [
                statement_result(),
                statement_result(affected=1, rowid="1"),
                statement_result(affected=1, rowid="2"),
                statement_result(),
                None,
            ],
            "step_errors": [None] * len(steps),
        }

    monkeypatch.setattr(conn, "_run", run)
    cursors = conn.execute_batch([
        ("INSERT INTO sample(value) VALUES(?)", ("a",)),
        ("INSERT INTO sample(value) VALUES(?)", ("b",)),
    ])
    steps = seen[0]["batch"]["steps"]
    assert [step["stmt"]["sql"] for step in steps] == [
        "BEGIN IMMEDIATE",
        "INSERT INTO sample(value) VALUES(?)",
        "INSERT INTO sample(value) VALUES(?)",
        "COMMIT",
        "ROLLBACK",
    ]
    assert steps[-1]["condition"]["type"] == "and"
    assert [cursor.rowcount for cursor in cursors] == [1, 1]


def test_batch_surfaces_constraint_error_without_executing_a_retry(monkeypatch):
    conn = connection()
    calls = []

    def run(operation):
        calls.append(operation)
        count = len(operation["batch"]["steps"])
        return {
            "step_results": [statement_result(), None, None, None],
            "step_errors": [None, {"code": "SQLITE_CONSTRAINT_UNIQUE"}, None, None],
        }

    monkeypatch.setattr(conn, "_run", run)
    with pytest.raises(sqlite3.IntegrityError, match="SQLITE_CONSTRAINT_UNIQUE"):
        conn.execute_batch([("INSERT INTO sample VALUES(?)", (1,))])
    assert len(calls) == 1


class NoBodyResponse(Response):
    def __init__(self, status, *, fail_close=False):
        super().__init__(None)
        self.status_code = status
        self.fail_close = fail_close

    def json(self):
        pytest.fail("Rejected HTTP responses must not read provider bodies")

    @property
    def text(self):
        pytest.fail("Rejected HTTP responses must not read provider text")

    @property
    def content(self):
        pytest.fail("Rejected HTTP responses must not read provider content")

    def close(self):
        self.closed = True
        if self.fail_close:
            raise RuntimeError("private-cleanup-marker")


class IntegerStatus(int):
    pass


class UnsafeStatus:
    def __eq__(self, other):
        pytest.fail("Malformed statuses must not be compared")

    def __str__(self):
        pytest.fail("Malformed statuses must not be stringified")


@pytest.mark.parametrize("status", [204, 301, 400, 401, 402, 403, 429, 500, 503, 599])
@pytest.mark.parametrize("fail_close", [False, True])
def test_http_failure_is_typed_redacted_and_never_retried(status, fail_close):
    conn = connection()
    response = NoBodyResponse(status, fail_close=fail_close)
    session = Session([response])
    conn._session = session
    with pytest.raises(turso.TursoHTTPError) as caught:
        conn.execute("SELECT 1")
    assert isinstance(caught.value, sqlite3.OperationalError)
    assert caught.value.status_code == status
    assert str(caught.value) == "Turso HTTP request failed; no automatic retry"
    assert response.closed and conn._broken
    assert session.options[0]["allow_redirects"] is False
    assert session.options[0]["timeout"] == 8.0
    with pytest.raises(sqlite3.OperationalError, match="unusable"):
        conn.execute("SELECT 1")
    conn.rollback()
    conn.close()
    assert len(session.urls) == 1


@pytest.mark.parametrize("status", [
    True, False, None, "200", "401", 200.0, 401.0, 99, 600,
    IntegerStatus(200), IntegerStatus(401), UnsafeStatus(),
])
def test_malformed_http_status_is_generic_and_poisons_stream(status):
    conn = connection()
    response = NoBodyResponse(status)
    session = Session([response])
    conn._session = session
    with pytest.raises(sqlite3.OperationalError, match="unsafe protocol") as caught:
        conn.execute("SELECT 1")
    assert type(caught.value) is sqlite3.OperationalError
    assert response.closed and conn._broken and len(session.urls) == 1
    with pytest.raises(ValueError, match="Invalid Turso HTTP status"):
        turso.TursoHTTPError(status)


@pytest.mark.parametrize("operation", ["commit", "batch", "close"])
def test_mutating_or_close_http_failure_never_claims_success_or_replays(operation):
    conn = connection()
    conn._baton = "synthetic-baton"
    conn.in_transaction = operation == "commit"
    response = NoBodyResponse(503)
    session = Session([response])
    conn._session = session
    with pytest.raises(turso.TursoHTTPError):
        if operation == "commit":
            conn.commit()
        elif operation == "batch":
            conn.execute_batch([("INSERT INTO sample VALUES(?)", ("synthetic",))])
        else:
            conn.close()
    assert response.closed and conn._broken and len(session.urls) == 1
    conn.rollback()
    conn.close()
    assert len(session.urls) == 1


@pytest.mark.parametrize("payload,expected", [
    ({"baton": "b1", "results": []}, "unsafe protocol"),
    ({"baton": "b1", "results": [{"type": "ok"}]}, "response cleanup failed"),
])
@pytest.mark.parametrize("inside_except", [False, True])
def test_response_cleanup_preserves_primary_error_and_sanitizes_lone_failure(payload, expected, inside_except):
    conn = connection()

    class BadCleanup(Response):
        def close(self):
            self.closed = True
            raise RuntimeError("private-cleanup-marker")

    response = BadCleanup(payload)
    session = Session([response])
    conn._session = session

    def invoke():
        with pytest.raises(sqlite3.OperationalError, match=expected) as caught:
            conn._pipeline([{"type": "get_autocommit"}])
        assert "private" not in str(caught.value)

    if inside_except:
        try:
            raise RuntimeError("unrelated enclosing exception")
        except RuntimeError:
            invoke()
    else:
        invoke()
    assert response.closed and conn._broken and len(session.urls) == 1


@pytest.mark.parametrize("http_failure", [False, True])
def test_connection_cleanup_preserves_http_failure_and_always_clears_state(http_failure):
    conn = connection()
    conn._baton = "synthetic-baton"
    conn.in_transaction = True
    response = (NoBodyResponse(401) if http_failure else Response({
        "baton": None, "results": [{"type": "ok", "response": {"type": "close"}}],
    }))

    class BadSession(Session):
        def close(self):
            raise RuntimeError("private-session-cleanup-marker")

    session = BadSession([response])
    session.headers["Authorization"] = "Bearer synthetic-token"
    conn._session = session
    with pytest.raises(sqlite3.OperationalError) as caught:
        conn.close()
    if http_failure:
        assert type(caught.value) is turso.TursoHTTPError
        assert caught.value.status_code == 401
    else:
        assert str(caught.value) == "Turso connection cleanup failed; no automatic retry"
    assert "private" not in str(caught.value)
    assert conn._closed and conn._broken
    assert conn._baton is None and not conn.in_transaction
    assert "Authorization" not in session.headers
    conn.close()
    assert len(session.urls) == 1
