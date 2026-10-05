"""Initialize, inspect, or probe an explicitly selected Turso candidate database.

Credentials are read only from the environment. Destructive migration, data
deletion, and production/release certification are deliberately unsupported.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
from urllib.parse import urlsplit


PROBE_TABLE = "turso_candidate_probe_v1"
NONCE_PATTERN = re.compile(r"[0-9a-f]{64}\Z")


class CandidateError(Exception):
    """An allowlisted error code, never a provider error or database value."""


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally repeats invalid argument values, possibly secrets.
        raise CandidateError("invalid_arguments")


def _parser():
    parser = _Parser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=15.0)
    commands = parser.add_subparsers(dest="command", required=True)
    initialize = commands.add_parser(
        "initialize", help="Provision or adopt the supported V8 candidate schema",
    )
    initialize.add_argument("--candidate", action="store_true",
                            help="Attest that the configured database is a candidate")
    commands.add_parser("inspect", help="Read connection/schema/public counts only")
    write = commands.add_parser("write-probe", help="Commit one synthetic marker")
    write.add_argument("--candidate", action="store_true",
                       help="Attest that the configured database is a candidate")
    read = commands.add_parser("read-probe", help="Read a previously written marker")
    read.add_argument("--nonce", required=True)
    return parser


def _configuration(environ, timeout):
    if not math.isfinite(timeout) or not 0 < timeout <= 60:
        raise CandidateError("invalid_timeout")
    if environ.get("FUND_DB_BACKEND", "").strip().lower() != "turso":
        raise CandidateError("turso_backend_required")
    if environ.get("FUND_DB_PERSISTENCE", "").strip().lower() != "turso_candidate":
        raise CandidateError("turso_candidate_persistence_required")
    url = environ.get("TURSO_DATABASE_URL", "").strip()
    token = environ.get("TURSO_AUTH_TOKEN", "").strip()
    if not url or not token:
        raise CandidateError("missing_credentials")
    try:
        parsed = urlsplit(url)
        valid = (
            parsed.scheme in {"libsql", "https"} and parsed.hostname
            and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment
            and parsed.path in {"", "/"}
        )
    except ValueError:
        valid = False
    if not valid:
        raise CandidateError("invalid_database_url")
    return url, token


def _connect(url, token, timeout):
    # Do not import database.db or main: they may initialize application state.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    from database.turso import connect
    return connect(url, token, timeout=timeout)


def _initialize_candidate(conn):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    from database.turso_schema import initialize_candidate
    return initialize_candidate(conn)


def _table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,),
    ).fetchone() is not None


def _nonnegative_integer(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CandidateError("invalid_database_summary")
    return value


def inspect_database(conn):
    """Read public aggregate metadata; never enumerate private ledger records."""
    if conn.execute("SELECT 1").fetchone()[0] != 1:
        raise CandidateError("connectivity_check_failed")
    if _table_exists(conn, "_schema_version"):
        row = conn.execute(
            "SELECT version FROM _schema_version WHERE singleton=1",
        ).fetchone()
        if row is None:
            raise CandidateError("missing_schema_version")
        schema_version = _nonnegative_integer(row[0])
        version_source = "schema_table"
    else:
        schema_version = _nonnegative_integer(
            conn.execute("PRAGMA user_version").fetchone()[0],
        )
        version_source = "sqlite_header"
    table_count = _nonnegative_integer(conn.execute(
        "SELECT COUNT(*) FROM sqlite_master "
        "WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).fetchone()[0])
    fund_count = None
    if _table_exists(conn, "funds"):
        fund_count = _nonnegative_integer(
            conn.execute("SELECT COUNT(*) FROM funds").fetchone()[0],
        )
    return {
        "connectivity": True,
        "schema_version": schema_version,
        "schema_version_source": version_source,
        "table_count": table_count,
        "fund_count": fund_count,
    }


def _hashes(nonce):
    if not isinstance(nonce, str) or not NONCE_PATTERN.fullmatch(nonce):
        raise CandidateError("invalid_nonce")
    digest = hashlib.sha256(nonce.encode("ascii")).hexdigest()
    marker = hashlib.sha256(
        ("fund-compass:turso-candidate:v1:" + nonce).encode("ascii"),
    ).hexdigest()
    return digest, marker


def write_probe(conn, *, candidate=False):
    if not candidate:
        raise CandidateError("candidate_acknowledgement_required")
    nonce = secrets.token_hex(32)
    digest, marker = _hashes(nonce)
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS {PROBE_TABLE} (
                nonce_sha256 TEXT PRIMARY KEY NOT NULL,
                marker_sha256 TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute(
            f"INSERT INTO {PROBE_TABLE} "
            "(nonce_sha256, marker_sha256, created_at) VALUES (?, ?, ?)",
            (digest, marker, created_at),
        )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    return {
        "nonce": nonce, "nonce_sha256": digest,
        "created_at": created_at, "committed": True,
    }


def read_probe(conn, nonce):
    digest, marker = _hashes(nonce)
    if not _table_exists(conn, PROBE_TABLE):
        raise CandidateError("probe_not_found")
    row = conn.execute(
        f"SELECT marker_sha256 FROM {PROBE_TABLE} WHERE nonce_sha256=?",
        (digest,),
    ).fetchone()
    if row is None:
        raise CandidateError("probe_not_found")
    if not isinstance(row[0], str) or not secrets.compare_digest(row[0], marker):
        raise CandidateError("probe_mismatch")
    return {"nonce_sha256": digest, "matched": True}


def _operation_error_code(exc):
    """Classify only adapter HTTP status, never provider text or attributes."""
    fallback = "candidate_operation_failed"
    if not isinstance(exc, sqlite3.OperationalError):
        return fallback
    # Keep driver imports outside argument/config validation and success paths
    # with injected SQLite connections. This module never imports database.db.
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
        from database.turso import TursoHTTPError
    except ImportError:
        return fallback
    if type(exc) is not TursoHTTPError:
        return fallback
    status = getattr(exc, "status_code", None)
    if type(status) is not int or not 100 <= status <= 599:
        return fallback
    if status == 401:
        return "candidate_authentication_rejected"
    if status == 403:
        return "candidate_access_denied"
    if status == 429:
        return "candidate_rate_limited"
    if 500 <= status <= 599:
        return "candidate_service_unavailable"
    return fallback


def main(argv=None, *, connector=None, environ=None, stdout=None, stderr=None):
    """Run the CLI with injectable connections for isolated boundary tests."""
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    environ = os.environ if environ is None else environ
    conn = None
    try:
        args = _parser().parse_args(argv)
        # Check write/read intent before importing a driver or opening a socket.
        if args.command in {"initialize", "write-probe"} and not args.candidate:
            raise CandidateError("candidate_acknowledgement_required")
        if args.command == "read-probe":
            _hashes(args.nonce)
        url, token = _configuration(environ, args.timeout)
        conn = (connector or _connect)(url, token, timeout=args.timeout)
        if args.command == "initialize":
            result = _initialize_candidate(conn)
        elif args.command == "inspect":
            result = inspect_database(conn)
        elif args.command == "write-probe":
            result = write_probe(conn, candidate=args.candidate)
        else:
            result = read_probe(conn, args.nonce)
        # A failed close must not produce both a success and an error response.
        conn.close()
        conn = None
        print(json.dumps({
            "ok": True,
            "command": args.command,
            "evidence_scope": "database_probe_only",
            "formal_release_verified": False,
            **result,
        }, sort_keys=True), file=stdout)
        return 0
    except CandidateError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=stderr)
        return 2
    except Exception as exc:
        # Never emit exception text, URLs, SQL parameters, response bodies or
        # tracebacks: provider errors can contain tokens and private data.
        print(json.dumps({"ok": False, "error": _operation_error_code(exc)}), file=stderr)
        return 1
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
