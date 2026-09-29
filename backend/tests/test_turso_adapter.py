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
        self.headers = {}

    def post(self, url, **kwargs):
        self.urls.append(url)
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
