"""Small synchronous libSQL-over-HTTP adapter for the repository's sqlite API.

This is a remote-only candidate, not an embedded replica. It implements the
official Hrana 3 JSON protocol (docs/HRANA_3_SPEC.md in tursodatabase/libsql).
The existing requests dependency avoids a native wheel requirement: libsql
0.1.11 has no Windows CPython 3.14 wheel. No request is retried or redirected.
Interactive cloud transactions still have the server's short time limit; use
execute_batch for non-interactive atomic work, and keep network I/O outside
interactive transactions.
"""
from __future__ import annotations

import base64
import math
import re
import sqlite3
import threading
from collections.abc import Iterable, Mapping
from itertools import islice
from urllib.parse import unquote, urlsplit, urlunsplit

import requests


_DML = {"INSERT", "UPDATE", "DELETE", "REPLACE"}
_CONTROL = {"BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"}
_LEADING = re.compile(r"\A(?:\s+|--[^\n]*(?:\n|$)|/\*.*?\*/)*", re.S)


def _keyword(sql: str) -> str:
    if not isinstance(sql, str) or not sql.strip():
        raise sqlite3.ProgrammingError("SQL must be a nonempty string")
    match = re.match(r"[A-Za-z]+", sql[_LEADING.match(sql).end():])
    return match.group().upper() if match else ""


def _base_url(url: str) -> str:
    """Accept only a clean TLS origin, never URL credentials or query tokens."""
    try:
        parsed = urlsplit(url)
        valid = (
            parsed.scheme in {"https", "libsql"} and parsed.hostname
            and parsed.username is None and parsed.password is None
            and not parsed.query and not parsed.fragment
            and parsed.path in {"", "/"} and parsed.port in {None, 443}
            and not any(character.isspace() for character in url)
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError("Turso requires a credential-free HTTPS/libSQL origin")
    return urlunsplit(("https", parsed.hostname.lower(), "", "", ""))


def _stream_base_url(url: str, origin: str) -> str:
    """Validate a server-selected Hrana base URL without leaking the token."""
    try:
        parsed = urlsplit(url)
        origin_parts = urlsplit(origin)
        decoded_path = unquote(parsed.path)
        valid = (
            parsed.scheme == "https" and parsed.hostname
            and parsed.hostname.lower() == origin_parts.hostname
            and parsed.port in {None, 443}
            and parsed.username is None and parsed.password is None
            and not parsed.query and not parsed.fragment
            and not any(character.isspace() for character in url)
            and "\\" not in decoded_path
            and all(segment not in {".", ".."} for segment in decoded_path.split("/"))
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ValueError("unsafe Hrana stream base URL")
    return urlunsplit(("https", parsed.hostname.lower(), parsed.path.rstrip("/"), "", ""))


def _encode(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, (bool, int)):
        if not -(2**63) <= value < 2**63:
            raise OverflowError("SQLite integer is outside signed 64-bit range")
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, float):
        if not math.isfinite(value):
            raise sqlite3.DataError("Non-finite database values are unsupported")
        return {"type": "float", "value": value}
    if isinstance(value, str):
        return {"type": "text", "value": value}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"type": "blob", "base64": base64.b64encode(value).decode("ascii")}
    raise sqlite3.ProgrammingError("Unsupported SQL parameter type")


def _decode(value):
    kind = value["type"]
    if kind == "null":
        return None
    if kind == "integer":
        return int(value["value"])
    if kind == "float":
        result = float(value["value"])
        if not math.isfinite(result):
            raise ValueError("non-finite response")
        return result
    if kind == "text" and isinstance(value["value"], str):
        return value["value"]
    if kind == "blob":
        return base64.b64decode(value["base64"], validate=True)
    raise ValueError("invalid database value")


def _statement(sql, parameters=()):
    _keyword(sql)
    statement = {"sql": sql, "want_rows": True}
    if isinstance(parameters, Mapping):
        if not all(isinstance(name, str) for name in parameters):
            raise sqlite3.ProgrammingError("Named SQL parameters require string keys")
        statement["named_args"] = [
            {"name": name, "value": _encode(value)} for name, value in parameters.items()
        ]
    else:
        if isinstance(parameters, (str, bytes, bytearray)):
            raise sqlite3.ProgrammingError("SQL parameters must be a sequence or mapping")
        statement["args"] = [_encode(value) for value in parameters]
    return statement


def _remote_error(error):
    # SQL error messages may embed bound values or URLs. Expose only known codes.
    code = error.get("code", "") if isinstance(error, dict) else ""
    known = isinstance(code, str) and re.fullmatch(r"SQLITE_[A-Z_]+", code)
    safe_code = code if known else "REMOTE_ERROR"
    if safe_code.startswith("SQLITE_CONSTRAINT"):
        cls = sqlite3.IntegrityError
    elif safe_code in {"SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_READONLY", "SQLITE_INTERRUPT"}:
        cls = sqlite3.OperationalError
    else:
        cls = sqlite3.DatabaseError
    result = cls(f"Turso statement failed ({safe_code})")
    if known:
        result.sqlite_errorname = code
    return result


class Row:
    """sqlite3.Row-like values, including dict(row) and positional iteration."""

    __slots__ = ("_names", "_values")

    def __init__(self, names, values):
        self._names = tuple(names)
        self._values = tuple(values)

    def keys(self):
        return list(self._names)

    def __getitem__(self, key):
        if isinstance(key, str):
            for index, name in enumerate(self._names):
                if name.lower() == key.lower():
                    return self._values[index]
            raise IndexError("No item with that key")
        return self._values[key]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.description = None
        self.rowcount = -1
        self.lastrowid = None
        self.arraysize = 1
        self._rows = iter(())
        self._closed = False

    def _load(self, sql, result):
        try:
            names = [column["name"] or "" for column in result["cols"]]
            values = [tuple(_decode(value) for value in row) for row in result["rows"]]
            if any(len(row) != len(names) for row in values):
                raise ValueError("column count mismatch")
            self.description = tuple((name, None, None, None, None, None, None) for name in names) or None
            self.rowcount = int(result["affected_row_count"]) if _keyword(sql) in _DML else -1
            if _keyword(sql) in {"INSERT", "REPLACE"}:
                rowid = result.get("last_insert_rowid")
                self.lastrowid = int(rowid) if rowid is not None else None
            factory = self.connection.row_factory
            if factory in {Row, sqlite3.Row}:
                values = [Row(names, row) for row in values]
            elif factory is not None:
                values = [factory(self, row) for row in values]
            self._rows = iter(values)
        except (KeyError, TypeError, ValueError, OverflowError):
            self.connection._invalidate("Turso returned an invalid statement result")
        return self

    def execute(self, sql, parameters=()):
        self._check()
        result = self.connection._execute(sql, parameters)
        return self._load(sql, result)

    def executemany(self, sql, parameters):
        self._check()
        if _keyword(sql) not in _DML:
            raise sqlite3.ProgrammingError("executemany requires a DML statement")
        self.rowcount = 0
        self.description = None
        self._rows = iter(())
        iterator = iter(parameters)
        while chunk := list(islice(iterator, 128)):
            # Validate parameters before acquiring the write transaction.
            statements = [(sql, args) for args in chunk]
            for statement, args in statements:
                _statement(statement, args)
            if not self.connection.in_transaction:
                self.connection.execute("BEGIN")
            cursors = self.connection.execute_batch(statements, atomic=False)
            self.rowcount += sum(cursor.rowcount for cursor in cursors)
        return self

    def _check(self):
        self.connection._check()
        if self._closed:
            raise sqlite3.ProgrammingError("Cannot operate on a closed cursor")

    def fetchone(self):
        self._check()
        return next(self._rows, None)

    def fetchall(self):
        self._check()
        return list(self._rows)

    def fetchmany(self, size=None):
        self._check()
        size = self.arraysize if size is None else size
        if size < 0:
            raise ValueError("fetch size must be nonnegative")
        return list(islice(self._rows, size))

    def close(self):
        self._closed = True
        self._rows = iter(())

    def __iter__(self):
        return self

    def __next__(self):
        self._check()
        return next(self._rows)


class Connection:
    """One serialized remote stream; transport ambiguity makes it unusable."""

    def __init__(self, url: str, token: str, timeout: float = 8.0):
        self._origin = _base_url(url)
        self._stream_base = self._origin
        if not isinstance(token, str) or not token or any(c.isspace() for c in token):
            raise ValueError("Turso requires a nonempty authentication token")
        if isinstance(timeout, bool) or not math.isfinite(timeout) or not 0 < timeout <= 60:
            raise ValueError("Turso timeout must be positive and at most 60 seconds")
        self._timeout = float(timeout)
        self._session = requests.Session()
        # requests' default adapter does not retry. Explicitly keep that contract.
        self._session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
        self._session.headers.update({"Authorization": f"Bearer {token}"})
        self._baton = None
        self._closed = False
        self._broken = False
        self._owner = threading.get_ident()
        self.row_factory = Row
        self.in_transaction = False
        self.total_changes = 0

    def _check(self):
        if self._closed:
            raise sqlite3.ProgrammingError("Cannot operate on a closed database")
        if threading.get_ident() != self._owner:
            raise sqlite3.ProgrammingError("Turso connection belongs to another thread")
        if self._broken:
            raise sqlite3.OperationalError("Turso connection is unusable; reconcile before retrying")

    def _invalidate(self, message):
        self._broken = True
        raise sqlite3.OperationalError(message) from None

    def _pipeline(self, operations):
        self._check()
        try:
            response = self._session.post(
                self._stream_base + "/v3/pipeline",
                json={"baton": self._baton, "requests": operations},
                timeout=self._timeout,
                allow_redirects=False,
            )
        except requests.RequestException:
            self._invalidate("Turso request failed; outcome unknown, no automatic retry")
        try:
            if response.status_code != 200:
                self._invalidate("Turso HTTP request failed; no automatic retry")
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("response is not an object")
            base_url = payload.get("base_url")
            if base_url is not None:
                self._stream_base = _stream_base_url(base_url, self._origin)
            baton = payload["baton"]
            results = payload["results"]
            if not isinstance(results, list) or len(results) != len(operations):
                raise ValueError("result count mismatch")
            closing = operations[-1]["type"] == "close"
            if not closing and (not isinstance(baton, str) or not baton):
                raise ValueError("database stream unexpectedly closed")
            self._baton = baton
            return results
        except (KeyError, TypeError, ValueError):
            self._invalidate("Turso returned an invalid or unsafe protocol response")
        finally:
            response.close()

    def _run(self, operation):
        # Server state, not guessed SQL text, decides whether a transaction is
        # active (including ROLLBACK conflict resolution and deferred FK errors).
        results = self._pipeline([
            operation,
            {"type": "execute", "stmt": _statement("SELECT total_changes()")},
            {"type": "get_autocommit"},
        ])
        try:
            state = results[2]["response"]
            count = results[1]["response"]
            if state["type"] != "get_autocommit" or not isinstance(state["is_autocommit"], bool):
                raise ValueError("missing transaction state")
            if count["type"] != "execute":
                raise ValueError("missing change count")
            self.in_transaction = not state["is_autocommit"]
            self.total_changes = int(_decode(count["result"]["rows"][0][0]))
            first = results[0]
            if first["type"] == "error":
                raise _remote_error(first["error"])
            result = first["response"]
            if first["type"] != "ok" or result["type"] != operation["type"]:
                raise ValueError("unexpected operation result")
            return result["result"]
        except (KeyError, IndexError, TypeError, ValueError):
            self._invalidate("Turso returned an incomplete operation result")

    def _execute(self, sql, parameters):
        statement = _statement(sql, parameters)
        # Match sqlite3 legacy transaction control: ordinary DML starts a
        # transaction; SELECT and DDL do not. Explicit BEGIN remains independent.
        if _keyword(sql) in _DML and not self.in_transaction:
            self._run({"type": "execute", "stmt": _statement("BEGIN")})
        return self._run({"type": "execute", "stmt": statement})

    def cursor(self):
        self._check()
        return Cursor(self)

    def execute(self, sql, parameters=()):
        return self.cursor().execute(sql, parameters)

    def executemany(self, sql, parameters):
        return self.cursor().executemany(sql, parameters)

    def execute_batch(self, statements: Iterable[tuple], *, atomic: bool = True):
        """Run a conditional batch in one HTTP call.

        atomic=True owns BEGIN IMMEDIATE/COMMIT and rolls back on any error.
        atomic=False requires an existing transaction and leaves its commit or
        rollback to the caller. Neither mode executes a suffix after an error.
        """
        self._check()
        statements = list(statements)
        if not statements:
            return []
        if atomic == self.in_transaction:
            raise sqlite3.ProgrammingError("Batch transaction ownership mismatch")
        prepared = []
        for sql, parameters in statements:
            if _keyword(sql) in _CONTROL:
                raise sqlite3.ProgrammingError("Transaction control is not allowed inside a batch")
            prepared.append(_statement(sql, parameters))
        steps = [{"stmt": _statement("BEGIN IMMEDIATE")}] if atomic else []
        offset = len(steps)
        for statement in prepared:
            step = {"stmt": statement}
            if steps:
                step["condition"] = {"type": "ok", "step": len(steps) - 1}
            steps.append(step)
        if atomic:
            commit_index = len(steps)
            steps.append({
                "stmt": _statement("COMMIT"),
                "condition": {"type": "ok", "step": commit_index - 1},
            })
            steps.append({
                "stmt": _statement("ROLLBACK"),
                "condition": {"type": "and", "conds": [
                    {"type": "not", "cond": {"type": "ok", "step": commit_index}},
                    {"type": "not", "cond": {"type": "is_autocommit"}},
                ]},
            })
        result = self._run({"type": "batch", "batch": {"steps": steps}})
        try:
            values, errors = result["step_results"], result["step_errors"]
            if len(values) != len(steps) or len(errors) != len(steps):
                raise ValueError("batch result count mismatch")
            if atomic and self.in_transaction:
                self._invalidate("Turso batch did not finish its transaction")
            for error in errors:
                if error is not None:
                    raise _remote_error(error)
            if atomic and values[commit_index] is None:
                raise ValueError("batch did not commit")
            return [
                Cursor(self)._load(sql, values[offset + index])
                for index, (sql, _args) in enumerate(statements)
            ]
        except (KeyError, IndexError, TypeError, ValueError):
            self._invalidate("Turso returned an incomplete batch result")

    def commit(self):
        self._check()
        if self.in_transaction:
            self.execute("COMMIT")

    def rollback(self):
        # A lost baton cannot safely be replayed. The abandoned server stream
        # expires and rolls back; never mask the original ambiguous-outcome error.
        if self._broken:
            return
        self._check()
        if self.in_transaction:
            self.execute("ROLLBACK")

    def close(self):
        if self._closed:
            return
        try:
            if self._baton is not None and not self._broken:
                result = self._pipeline([{"type": "close"}])[0]
                if result.get("type") != "ok":
                    raise _remote_error(result.get("error"))
        finally:
            self._session.headers.pop("Authorization", None)
            self._session.close()
            self._closed = True
            self._baton = None
            self.in_transaction = False

    def __enter__(self):
        self._check()
        return self

    def __exit__(self, kind, value, traceback):
        if kind is not None:
            self.rollback()
        else:
            try:
                self.commit()
            except sqlite3.Error:
                self.rollback()
                raise


def connect(url: str, token: str, timeout: float = 8.0) -> Connection:
    return Connection(url, token, timeout)
