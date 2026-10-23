import importlib.util
import io
import json
from pathlib import Path
import sqlite3

import pytest

from database.turso import TursoHTTPError


SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "turso_candidate.py"
SPEC = importlib.util.spec_from_file_location("turso_candidate", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)

ENV = {
    "FUND_DB_BACKEND": "turso",
    "FUND_DB_PERSISTENCE": "turso_candidate",
    "TURSO_DATABASE_URL": "libsql://candidate.example.invalid",
    "TURSO_AUTH_TOKEN": "test-only-token-not-a-real-secret",
}


def invoke(args, connector, env=None):
    out, err = io.StringIO(), io.StringIO()
    code = module.main(args, connector=connector, environ=ENV if env is None else env,
                       stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


def local_connector(path, queries=None):
    def connect(url, token, timeout):
        assert url == ENV["TURSO_DATABASE_URL"]
        assert token == ENV["TURSO_AUTH_TOKEN"]
        conn = sqlite3.connect(path, timeout=timeout)
        if queries is not None:
            conn.set_trace_callback(queries.append)
        return conn
    return connect


def test_inspect_is_read_only_and_never_discloses_private_rows(tmp_path):
    path = tmp_path / "candidate.db"
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE _schema_version (singleton INTEGER PRIMARY KEY, version INTEGER);
            INSERT INTO _schema_version VALUES (1, 8);
            CREATE TABLE funds (code TEXT PRIMARY KEY);
            INSERT INTO funds VALUES ('test-a'), ('test-b');
            CREATE TABLE private_ledger (private_value TEXT);
            INSERT INTO private_ledger VALUES ('private-runtime-marker');
        """)
    queries = []
    code, out, err = invoke(["inspect"], local_connector(path, queries))
    assert code == 0 and not err
    result = json.loads(out)
    assert result["schema_version"] == 8
    assert result["schema_version_source"] == "schema_table"
    assert result["table_count"] == 3 and result["fund_count"] == 2
    assert "private-runtime-marker" not in out and "private_ledger" not in out
    assert all(query.lstrip().upper().startswith(("SELECT", "PRAGMA")) for query in queries)
    assert not any("FROM private_ledger" in query for query in queries)
    assert result["formal_release_verified"] is False


def test_empty_candidate_inspect_does_not_create_schema_or_invent_funds(tmp_path):
    path = tmp_path / "empty.db"
    code, out, err = invoke(["inspect"], local_connector(path))
    assert code == 0 and not err
    result = json.loads(out)
    assert result["fund_count"] is None and result["table_count"] == 0
    assert result["schema_version"] == 0 and result["schema_version_source"] == "sqlite_header"
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0


@pytest.mark.parametrize("args,env", [
    (["write-probe"], ENV),
    (["initialize"], ENV),
    (["inspect"], {}),
    (["inspect"], {**ENV, "FUND_DB_BACKEND": "sqlite"}),
    (["inspect"], {**ENV, "FUND_DB_PERSISTENCE": "ephemeral"}),
    (["inspect"], {**ENV, "TURSO_AUTH_TOKEN": ""}),
    (["inspect"], {**ENV, "TURSO_DATABASE_URL": "http://insecure.invalid"}),
    (["inspect"], {**ENV, "TURSO_DATABASE_URL": "libsql://candidate.invalid?token=private-marker"}),
    (["--timeout", "nan", "inspect"], ENV),
    (["--timeout", "0", "inspect"], ENV),
    (["--timeout", "61", "inspect"], ENV),
    (["read-probe", "--nonce", "private-marker"], ENV),
    (["inspect", "--token", "private-marker"], ENV),
])
def test_invalid_intent_or_config_is_rejected_before_connect(args, env):
    calls = []
    code, out, err = invoke(args, lambda *a, **kw: calls.append((a, kw)), env)
    assert code == 2 and not out and not calls
    assert "private-marker" not in err
    assert ENV["TURSO_AUTH_TOKEN"] not in err
    assert ENV["TURSO_DATABASE_URL"] not in err


def test_marker_survives_connection_close_and_only_hashes_are_persisted(tmp_path):
    path = tmp_path / "candidate.db"
    connect = local_connector(path)
    code, out, err = invoke(["write-probe", "--candidate"], connect)
    assert code == 0 and not err
    written = json.loads(out)
    nonce = written["nonce"]
    assert len(nonce) == 64 and written["committed"] is True
    with sqlite3.connect(path) as conn:
        stored = conn.execute(f"SELECT * FROM {module.PROBE_TABLE}").fetchone()
        assert nonce not in stored
        assert written["nonce_sha256"] == stored[0]
    queries = []
    code, out, err = invoke(["read-probe", "--nonce", nonce], local_connector(path, queries))
    assert code == 0 and not err
    read = json.loads(out)
    assert read["matched"] is True
    assert read["nonce_sha256"] == written["nonce_sha256"]
    assert read["evidence_scope"] == "database_probe_only"
    assert read["formal_release_verified"] is False
    assert all(query.lstrip().upper().startswith("SELECT") for query in queries)


def test_missing_marker_read_does_not_create_table(tmp_path):
    path = tmp_path / "candidate.db"
    code, out, err = invoke(["read-probe", "--nonce", "a" * 64], local_connector(path))
    assert code == 2 and not out
    assert json.loads(err)["error"] == "probe_not_found"
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0


def test_initialize_is_explicit_idempotent_and_keeps_probe(tmp_path):
    path = tmp_path / "candidate.db"
    connect = local_connector(path)
    _, probe_out, _ = invoke(["write-probe", "--candidate"], connect)
    nonce = json.loads(probe_out)["nonce"]

    code, out, err = invoke(["initialize", "--candidate"], connect)
    assert code == 0 and not err
    assert json.loads(out)["changed"] is True
    code, out, err = invoke(["initialize", "--candidate"], connect)
    assert code == 0 and not err and json.loads(out)["changed"] is False
    code, out, err = invoke(["read-probe", "--nonce", nonce], connect)
    assert code == 0 and not err and json.loads(out)["matched"] is True

    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT version FROM _schema_version WHERE singleton=1",
        ).fetchone() == (9,)


def test_initialize_refuses_unknown_database_without_partial_schema(tmp_path):
    path = tmp_path / "candidate.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE unrelated_private_data(secret TEXT)")
    code, out, err = invoke(["initialize", "--candidate"], local_connector(path))
    assert code == 1 and not out
    assert json.loads(err)["error"] == "candidate_operation_failed"
    with sqlite3.connect(path) as conn:
        assert conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        ).fetchall() == [("unrelated_private_data",)]


def test_tampered_marker_is_rejected_without_printing_database_value(tmp_path):
    path = tmp_path / "candidate.db"
    connect = local_connector(path)
    _, out, _ = invoke(["write-probe", "--candidate"], connect)
    nonce = json.loads(out)["nonce"]
    with sqlite3.connect(path) as conn:
        conn.execute(f"UPDATE {module.PROBE_TABLE} SET marker_sha256='private-runtime-marker'")
    code, out, err = invoke(["read-probe", "--nonce", nonce], connect)
    assert code == 2 and not out
    assert json.loads(err)["error"] == "probe_mismatch"
    assert "private-runtime-marker" not in err


def test_failed_write_rolls_back_marker_table_atomically():
    conn = sqlite3.connect(":memory:")

    class FailInsert:
        def execute(self, sql, parameters=()):
            if sql.lstrip().startswith("INSERT"):
                raise RuntimeError("provider private error")
            return conn.execute(sql, parameters)

        def rollback(self):
            conn.rollback()

    with pytest.raises(RuntimeError):
        module.write_probe(FailInsert(), candidate=True)
    assert conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0
    conn.close()


@pytest.mark.parametrize("phase", ["connect", "execute", "commit", "close"])
def test_provider_failures_are_redacted(phase):
    secret_error = " ".join([ENV["TURSO_AUTH_TOKEN"], ENV["TURSO_DATABASE_URL"], "private-row"])
    local = sqlite3.connect(":memory:")

    class Connection:
        def execute(self, *args):
            if phase == "execute":
                raise RuntimeError(secret_error)
            return local.execute(*args)

        def commit(self):
            if phase == "commit":
                raise RuntimeError(secret_error)
            local.commit()

        def rollback(self):
            local.rollback()

        def close(self):
            if phase == "close":
                raise RuntimeError(secret_error)
            local.close()

    def connect(*args, **kwargs):
        if phase == "connect":
            raise RuntimeError(secret_error)
        return Connection()

    code, out, err = invoke(["write-probe", "--candidate"], connect)
    assert code == 1 and not out
    assert json.loads(err)["error"] == "candidate_operation_failed"
    for value in (ENV["TURSO_AUTH_TOKEN"], ENV["TURSO_DATABASE_URL"], "private-row"):
        assert value not in out + err
    local.close()


@pytest.mark.parametrize("status,error", [
    (401, "candidate_authentication_rejected"),
    (403, "candidate_access_denied"),
    (429, "candidate_rate_limited"),
    (500, "candidate_service_unavailable"),
    (503, "candidate_service_unavailable"),
    (599, "candidate_service_unavailable"),
    (301, "candidate_operation_failed"),
    (402, "candidate_operation_failed"),
    (409, "candidate_operation_failed"),
])
@pytest.mark.parametrize("phase", ["connect", "execute", "commit", "close"])
def test_typed_http_failures_have_fixed_codes_and_no_success_output(status, error, phase):
    local = sqlite3.connect(":memory:")
    calls = []

    def failure():
        exc = TursoHTTPError(status)
        # Even a changed message must never become a CLI output source.
        exc.args = (ENV["TURSO_AUTH_TOKEN"] + " private-row",)
        raise exc

    class Connection:
        def execute(self, *args):
            if phase == "execute":
                failure()
            return local.execute(*args)

        def commit(self):
            if phase == "commit":
                failure()
            local.commit()

        def rollback(self):
            local.rollback()

        def close(self):
            # A later cleanup error must not replace an earlier HTTP error.
            if phase == "close":
                failure()
            raise RuntimeError("private-finally-cleanup-marker")

    def connect(*args, **kwargs):
        calls.append(1)
        if phase == "connect":
            failure()
        return Connection()

    try:
        code, out, err = invoke(["write-probe", "--candidate"], connect)
        assert code == 1 and not out and len(calls) == 1
        assert json.loads(err) == {"ok": False, "error": error}
        for value in (ENV["TURSO_AUTH_TOKEN"], ENV["TURSO_DATABASE_URL"], "private-row", "committed"):
            assert value not in out + err
    finally:
        local.close()


class IntegerStatus(int):
    pass


class UnsafeStatus:
    def __eq__(self, other):
        pytest.fail("Malformed statuses must not be compared")

    def __str__(self):
        pytest.fail("Malformed statuses must not be stringified")


@pytest.mark.parametrize("status", [
    True, False, None, "401", 401.0, 99, 600,
    IntegerStatus(200), IntegerStatus(401), UnsafeStatus(),
])
def test_mutated_typed_status_cannot_create_an_authentication_claim(status):
    exc = TursoHTTPError(401)
    exc.status_code = status
    assert module._operation_error_code(exc) == "candidate_operation_failed"


def test_missing_typed_status_falls_back_without_handler_failure():
    exc = TursoHTTPError(401)
    del exc.status_code
    assert module._operation_error_code(exc) == "candidate_operation_failed"


@pytest.mark.parametrize("kind", [RuntimeError, sqlite3.OperationalError, type("DerivedHTTPError", (TursoHTTPError,), {})])
def test_provider_messages_and_lookalike_status_attributes_are_not_trusted(kind):
    exc = kind(401) if issubclass(kind, TursoHTTPError) else kind("HTTP 401 revoked invalid token")
    exc.status_code = 401
    assert module._operation_error_code(exc) == "candidate_operation_failed"
