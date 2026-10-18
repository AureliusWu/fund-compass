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
from dataclasses import dataclass
import json
import math
import re
import sqlite3
import threading
import time
from collections.abc import Iterable, Mapping
from itertools import islice
from urllib.parse import unquote, urlsplit, urlunsplit

import requests


_DML = {"INSERT", "UPDATE", "DELETE", "REPLACE"}
_CONTROL = {"BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"}
_LEADING = re.compile(r"\A(?:\s+|--[^\n]*(?:\n|$)|/\*.*?\*/)*", re.S)


class TursoHTTPError(sqlite3.OperationalError):
    """A sanitized HTTP observation, not proof of token revocation or commit."""

    def __init__(self, status_code: int):
        if type(status_code) is not int or not 100 <= status_code <= 599:
            raise ValueError("Invalid Turso HTTP status")
        self.status_code = status_code
        super().__init__("Turso HTTP request failed; no automatic retry")


@dataclass(frozen=True)
class HttpLimits:
    """Explicit opt-in only; legacy connections retain their existing behavior.

    This is a cooperative total connection budget, not native DNS preemption.
    A caller with multiple connections must pass its remaining operation budget.
    """
    seconds: float
    max_response_bytes: int
    max_request_bytes: int = 16 * 1024 * 1024

    def __post_init__(self):
        if (type(self.seconds) not in (int, float) or not math.isfinite(self.seconds)
                or not 0 < self.seconds <= 60 or type(self.max_response_bytes) is not int
                or not 1 <= self.max_response_bytes <= 64 * 1024 * 1024
                or type(self.max_request_bytes) is not int
                or not 1 <= self.max_request_bytes <= 64 * 1024 * 1024):
            raise ValueError("Invalid explicit Turso HTTP limits")


class TursoBatchError(sqlite3.DatabaseError):
    """Opt-in classified SQL failure with an observed, explicit ROLLBACK ACK.

    This says nothing about another connection or a later retry. No raw SQL,
    parameters, provider message, or response body is retained in this error.
    """
    def __init__(self, statement_index: int):
        self.statement_index = statement_index
        self.rollback_acknowledged = True
        super().__init__("Turso atomic batch rejected and rollback acknowledged")


def _empty_control_result(value):
    return (type(value) is dict and value.get("cols") == [] and value.get("rows") == []
            and type(value.get("affected_row_count")) is int and value["affected_row_count"] == 0
            and "last_insert_rowid" in value)


def _classified_batch_shape(values, errors, commit_index):
    """Reject contradictory conditional-batch observations before classification."""
    for value, error in zip(values, errors):
        if (value is not None and error is not None
                or value is not None and type(value) is not dict
                or error is not None and type(error) is not dict):
            raise ValueError("contradictory batch result/error")
    if values[0] is None and errors[0] is None:
        raise ValueError("missing BEGIN observation")
    # Each non-rollback step has exactly the preceding step's `ok` condition.
    # A failed/skipped step cannot have any later body/COMMIT result or error.
    for index in range(1, commit_index + 1):
        skipped = values[index] is None and errors[index] is None
        if skipped != (values[index - 1] is None):
            raise ValueError("inconsistent conditional batch suffix")
    if values[commit_index] is not None:
        if values[-1] is not None or errors[-1] is not None:
            raise ValueError("ROLLBACK after successful COMMIT")
    elif values[-1] is not None and not _empty_control_result(values[-1]):
        raise ValueError("invalid ROLLBACK acknowledgement")


def _strict_pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _bounded_json_tree(value, *, depth=0, remaining=None):
    remaining = [400_000] if remaining is None else remaining
    remaining[0] -= 1
    if remaining[0] < 0 or depth > 24:
        raise ValueError("JSON structure limit")
    if type(value) is dict:
        for key, item in value.items():
            key.encode("utf-8", errors="strict")
            _bounded_json_tree(item, depth=depth + 1, remaining=remaining)
    elif type(value) is list:
        for item in value:
            _bounded_json_tree(item, depth=depth + 1, remaining=remaining)
    elif type(value) is str:
        value.encode("utf-8", errors="strict")
    elif type(value) is float and not math.isfinite(value):
        raise ValueError("non-finite JSON number")


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


def _limited_decode(value):
    """Native Hrana value types for opt-in callers; legacy _decode is unchanged."""
    if type(value) is not dict:
        raise ValueError("invalid typed database value")
    kind = value.get("type")
    if kind == "null" and set(value) == {"type"}:
        return None
    if kind == "blob" and set(value) == {"type", "base64"} and type(value["base64"]) is str:
        return base64.b64decode(value["base64"], validate=True)
    if set(value) != {"type", "value"}:
        raise ValueError("invalid typed database value")
    raw = value["value"]
    if kind == "integer":
        if (type(raw) is not str or len(raw) > 20
                or re.fullmatch(r"(?:0|-?[1-9][0-9]{0,18})", raw, re.ASCII) is None):
            raise ValueError("invalid signed database integer")
        result = int(raw)
        if -(2**63) <= result < 2**63:
            return result
    elif kind == "float" and type(raw) in (int, float):
        try:
            result = float(raw)
        except OverflowError:
            raise ValueError("invalid finite database float") from None
        if math.isfinite(result):
            return result
    elif kind == "text" and type(raw) is str:
        raw.encode("utf-8", errors="strict")
        return raw
    raise ValueError("invalid typed database value")


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
            if getattr(self.connection, "_http_limits", None) is not None and (
                    type(result) is not dict or type(result.get("affected_row_count")) is not int or result["affected_row_count"] < 0):
                raise ValueError("invalid opted-in affected row count")
            names = [column["name"] or "" for column in result["cols"]]
            decode = _decode if getattr(self.connection, "_http_limits", None) is None else _limited_decode
            values = [tuple(decode(value) for value in row) for row in result["rows"]]
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

    def __init__(self, url: str, token: str, timeout: float = 8.0, *,
                 http_limits: HttpLimits | None = None):
        self._origin = _base_url(url)
        self._stream_base = self._origin
        if not isinstance(token, str) or not token or any(c.isspace() for c in token):
            raise ValueError("Turso requires a nonempty authentication token")
        if isinstance(timeout, bool) or not math.isfinite(timeout) or not 0 < timeout <= 60:
            raise ValueError("Turso timeout must be positive and at most 60 seconds")
        self._timeout = float(timeout)
        if http_limits is not None and type(http_limits) is not HttpLimits:
            raise ValueError("Explicit Turso limits must use HttpLimits")
        self._http_limits = http_limits
        self._deadline = None if http_limits is None else time.monotonic() + http_limits.seconds
        self._session = requests.Session()
        if http_limits is not None:
            # Opt-in requests use only the explicit task credential, not netrc,
            # environment proxies, or environment CA overrides.
            self._session.trust_env = False
            self._session.headers["Accept-Encoding"] = "identity"
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

    def _remaining(self):
        if self._deadline is None:
            return self._timeout
        remaining = self._deadline - time.monotonic()
        if not math.isfinite(remaining) or remaining <= 0:
            self._invalidate("Turso operation budget exhausted; outcome unknown")
        return min(self._timeout, remaining)

    def _limited_payload(self, response):
        raw = bytearray()
        for chunk in response.iter_content(chunk_size=64 * 1024):
            self._remaining()
            if type(chunk) is not bytes:
                raise ValueError("invalid response chunk")
            if len(raw) + len(chunk) > self._http_limits.max_response_bytes:
                raise ValueError("response byte limit")
            raw.extend(chunk)
        self._remaining()
        payload = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_strict_pairs,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")))
        _bounded_json_tree(payload)
        self._remaining()
        return payload

    def _pipeline(self, operations):
        self._check()
        try:
            frame = {"baton": self._baton, "requests": operations}
            if self._http_limits is None:
                options = {"json": frame}
            else:
                body = json.dumps(frame, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
                if len(body) > self._http_limits.max_request_bytes:
                    self._invalidate("Turso request exceeds explicit byte limit")
                options = {"data": body, "headers": {"Content-Type": "application/json"}, "stream": True}
            response = self._session.post(
                self._stream_base + "/v3/pipeline",
                timeout=self._remaining(),
                allow_redirects=False,
                **options,
            )
        except requests.RequestException:
            self._invalidate("Turso request failed; outcome unknown, no automatic retry")
        except (TypeError, ValueError, UnicodeError, OverflowError):
            if self._http_limits is not None:
                self._invalidate("Turso explicit request encoding rejected; no automatic retry")
            raise
        completed = False
        try:
            status = response.status_code
            if type(status) is not int or not 100 <= status <= 599:
                raise ValueError("invalid HTTP status")
            if status != 200:
                self._broken = True
                raise TursoHTTPError(status) from None
            payload = response.json() if self._http_limits is None else self._limited_payload(response)
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
            completed = True
            return results
        except (KeyError, TypeError, ValueError, OverflowError, RecursionError,
                UnicodeError, requests.RequestException):
            self._invalidate("Turso returned an invalid or unsafe protocol response")
        finally:
            # Cleanup must not erase an earlier HTTP/protocol failure. A lone
            # cleanup failure still invalidates the stream, with no raw detail.
            try:
                response.close()
            except Exception:
                if completed:
                    self._invalidate("Turso response cleanup failed; no automatic retry")
            if completed and self._http_limits is not None:
                # A successful payload does not excuse cleanup exceeding the
                # opted-in total budget. Do not replace an earlier HTTP/parse
                # failure, or change the default legacy connection behavior.
                self._remaining()

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
            wire_count = count["result"]["rows"][0][0]
            changes = _decode(wire_count) if self._http_limits is None else _limited_decode(wire_count)
            if self._http_limits is not None and (type(changes) is not int or changes < 0):
                raise ValueError("invalid typed change count")
            self.total_changes = int(changes)
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

    def execute_batch(self, statements: Iterable[tuple], *, atomic: bool = True,
                      begin_mode: str = "immediate", classify_errors: bool = False):
        """Run a conditional batch in one HTTP call.

        atomic=True owns BEGIN IMMEDIATE/COMMIT and rolls back on any error.
        atomic=False requires an existing transaction and leaves its commit or
        rollback to the caller. Neither mode executes a suffix after an error.
        begin_mode='deferred' explicitly requests BEGIN DEFERRED; it is not a
        generic read-only SQL validator. classify_errors is opt-in and exposes
        an index only when this response includes a successful ROLLBACK and no
        COMMIT result; all ambiguous observations retain their old exceptions.
        """
        self._check()
        if (type(begin_mode) is not str or begin_mode not in {"immediate", "deferred"}
                or (not atomic and begin_mode != "immediate") or type(classify_errors) is not bool
                or (classify_errors and (not atomic or self._http_limits is None))):
            raise sqlite3.ProgrammingError("Invalid explicit batch options")
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
        steps = [{"stmt": _statement("BEGIN IMMEDIATE" if begin_mode == "immediate" else "BEGIN DEFERRED")}] if atomic else []
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
            if classify_errors:
                _classified_batch_shape(values, errors, commit_index)
            if atomic and self.in_transaction:
                self._invalidate("Turso batch did not finish its transaction")
            for index, error in enumerate(errors):
                if error is not None:
                    if (classify_errors and values[commit_index] is None
                            and _empty_control_result(values[-1]) and errors[-1] is None
                            and 0 < index < commit_index and not self.in_transaction):
                        raise TursoBatchError(index - offset)
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
        completed = False
        try:
            if self._baton is not None and not self._broken:
                result = self._pipeline([{"type": "close"}])[0]
                if result.get("type") != "ok":
                    raise _remote_error(result.get("error"))
            completed = True
        finally:
            try:
                self._session.headers.pop("Authorization", None)
                self._session.close()
            except Exception:
                if completed:
                    self._invalidate("Turso connection cleanup failed; no automatic retry")
            finally:
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


def connect(url: str, token: str, timeout: float = 8.0, *,
            http_limits: HttpLimits | None = None) -> Connection:
    return Connection(url, token, timeout, http_limits=http_limits)
