"""Run the real V8 repository chain in an exclusively owned LOCAL database.

No provider credentials are read, no network is used, and no production or
remote database is writable. These receipts are explicitly non-formal. A local
SQLite backup readback is not Turso PITR or production restart certification.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


class ArgumentError(Exception):
    pass


ARGUMENT_ERROR_CODES = frozenset({
    "invalid_arguments", "candidate_acknowledgement_required",
    "invalid_acceptance_namespace", "new_database_required",
    "explicit_local_path_required", "local_database_extension_required",
    "symlink_database_not_allowed", "local_database_file_required",
    "invalid_receipt_file", "invalid_receipt_object",
})
VERIFICATION_ERROR_CODES = frozenset({
    "invalid_acceptance_namespace", "local_sqlite_only",
    "configured_resource_mismatch", "schema_contract_mismatch",
    "database_integrity_failed", "foreign_key_integrity_failed",
    "immutable_trigger_mismatch", "isolated_database_marker_required",
    "isolated_database_namespace_mismatch", "source_code_drift",
    "non_acceptance_data_present", "new_empty_database_required",
    "application_chain_incomplete", "application_chain_mismatch",
    "stored_semantic_digest_mismatch", "stored_projection_mismatch",
    "source_health_chain_mismatch", "source_health_projection_mismatch",
    "repository_readback_mismatch", "receipt_identity_or_digest_mismatch",
    "invalid_receipt_resource", "receipt_resource_mismatch",
    "invalid_receipt_boot_identity", "invalid_receipt_timestamps",
    "restore_source_receipt_required", "local_acceptance_write_forbidden",
    "local_acceptance_resource_mismatch",
})
OPERATION_FAILED = "local_acceptance_operation_failed"


def _safe_error_code(exc, trusted_type, allowed_codes):
    """Allow only the exact already-imported type and one fixed native string.

    Classification never imports a provider module, reads configuration, or
    renders exception text. The native exception argument slot also avoids
    invoking any custom attribute or string-conversion implementation.
    """
    if trusted_type is None or type(exc) is not trusted_type:
        return OPERATION_FAILED
    args = BaseException.args.__get__(exc)
    if len(args) != 1 or type(args[0]) is not str or args[0] not in allowed_codes:
        return OPERATION_FAILED
    return args[0]


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ArgumentError("invalid_arguments")


def _parser():
    parser = _Parser(description=__doc__)
    parser.add_argument("--database", required=True, help="Explicit local SQLite file, never a URL")
    parser.add_argument("--namespace", required=True, help="v9-acceptance-<isolated name>")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("create", "write", "read", "verify-restored-local", "export-synthetic"):
        sub = commands.add_parser(command)
        if command in {"create", "write"}:
            sub.add_argument("--candidate", action="store_true")
        if command in {"read", "verify-restored-local", "export-synthetic"}:
            sub.add_argument("--receipt", required=True, help="JSON output from the original write")
    return parser


def _path(value: str, *, exists: bool) -> Path:
    # Do not interpret SQLite URI options or anything that resembles a URL.
    if not isinstance(value, str) or "\x00" in value or "://" in value or value.startswith("file:"):
        raise ArgumentError("explicit_local_path_required")
    path = Path(value)
    if path.suffix.lower() not in {".db", ".sqlite", ".sqlite3"}:
        raise ArgumentError("local_database_extension_required")
    if path.is_symlink():
        raise ArgumentError("symlink_database_not_allowed")
    path = path.resolve(strict=exists)
    if exists and not path.is_file():
        raise ArgumentError("local_database_file_required")
    return path


def _receipt(value: str) -> dict:
    path = Path(value)
    if not path.is_file() or path.stat().st_size > 65536:
        raise ArgumentError("invalid_receipt_file")
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(receipt, dict):
        raise ArgumentError("invalid_receipt_object")
    return receipt


def main(argv=None, *, stdout=None, stderr=None):
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    original_env = {name: os.environ.get(name) for name in (
        "FUND_DB", "FUND_DB_BACKEND", "FUND_DB_PERSISTENCE", "FUND_DB_MOUNT_PATH",
    )}
    previous_db_path = None
    database_module = None
    verification_error_type = None
    try:
        args = _parser().parse_args(argv)
        if args.command in {"create", "write"} and not args.candidate:
            raise ArgumentError("candidate_acknowledgement_required")
        # Validate the write target and namespace before creating/importing.
        import re
        if not re.fullmatch(r"v9-acceptance-[a-z0-9-]{1,48}", args.namespace):
            raise ArgumentError("invalid_acceptance_namespace")
        path = _path(args.database, exists=args.command != "create")
        if args.command == "create" and path.exists():
            raise ArgumentError("new_database_required")
        receipt = _receipt(args.receipt) if hasattr(args, "receipt") else None
        os.environ["FUND_DB"] = str(path)
        os.environ["FUND_DB_BACKEND"] = "sqlite"
        os.environ["FUND_DB_PERSISTENCE"] = "ephemeral"
        os.environ.pop("FUND_DB_MOUNT_PATH", None)
        backend_path = str(Path(__file__).resolve().parents[1] / "backend")
        if backend_path not in sys.path:
            sys.path.insert(0, backend_path)
        from database import db
        from service import persistence_verification as verification
        verification_error_type = verification.VerificationError
        database_module = db
        previous_db_path = db.DB_PATH
        db.DB_PATH = str(path)
        if args.command == "create":
            path.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive create is never an overwrite; a provisioning failure
            # leaves the selected candidate for operator inspection.
            with path.open("xb"):
                pass
            verification.provision_local_namespace(path, args.namespace)
            result = verification.write_local_chain(path, args.namespace)
        elif args.command == "write":
            result = verification.write_local_chain(path, args.namespace)
        elif args.command == "export-synthetic":
            result = verification.export_synthetic_chain(path, args.namespace, receipt=receipt)
        else:
            result = verification.read_local_chain(
                path, args.namespace, receipt=receipt,
                restored_local=args.command == "verify-restored-local",
            )
        print(json.dumps({"ok": True, "command": args.command, **result},
                         ensure_ascii=False, sort_keys=True), file=stdout)
        return 0
    except ArgumentError as exc:
        code = _safe_error_code(exc, ArgumentError, ARGUMENT_ERROR_CODES)
        print(json.dumps({"ok": False, "error": code}), file=stderr)
        return 2 if code != OPERATION_FAILED else 1
    except Exception as exc:
        code = _safe_error_code(exc, verification_error_type, VERIFICATION_ERROR_CODES)
        # Neither raw provider exceptions, arguments, SQL nor paths are logged.
        print(json.dumps({"ok": False, "error": code}), file=stderr)
        return 1
    finally:
        if database_module is not None and previous_db_path is not None:
            database_module.DB_PATH = previous_db_path
        for name, value in original_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


if __name__ == "__main__":
    raise SystemExit(main())
