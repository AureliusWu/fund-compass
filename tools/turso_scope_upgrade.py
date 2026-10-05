"""Plan/rehearse an explicit local schema8 snapshot; no remote apply command.

The input must be a closed SQLite logical snapshot. A remote-schema-table
snapshot is still a local file; this tool does not access Turso or credentials.
Its local backup/recovery evidence cannot authorize a release or remote restore.
Known operational tables require the explicit known-operational-v1 profile;
the default core-only profile does not silently expand an existing plan.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


class _ArgumentsError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise _ArgumentsError()


def _parser():
    parser = _Parser(description=__doc__)
    parser.add_argument("command", choices=("plan", "rehearse"))
    parser.add_argument("--source", required=True)
    parser.add_argument("--source-kind", required=True, choices=("remote-schema-table", "local-header"))
    parser.add_argument("--operational-profile", default="core-only",
                        choices=("core-only", "known-operational-v1"))
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--expected-backup-sha256")
    return parser


def main(argv=None, *, stdout=None, stderr=None):
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    try:
        args = _parser().parse_args(argv)
    except _ArgumentsError:
        print(json.dumps({"ok": False, "error": "invalid_arguments",
                          "evidence_scope": "local_turso_schema_migration_rehearsal",
                          "formal_release_verified": False, "remote_applied": False,
                          "remote_restore_verified": False}), file=stderr)
        return 2
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    try:
        from database.turso_scope_upgrade import UpgradeError, rehearse_snapshot
    except Exception:
        print(json.dumps({"ok": False, "error": "rehearsal_failed",
                          "evidence_scope": "local_turso_schema_migration_rehearsal",
                          "formal_release_verified": False, "remote_applied": False,
                          "remote_restore_verified": False}, sort_keys=True), file=stderr)
        return 1
    try:
        result = rehearse_snapshot(args.source, source_kind=args.source_kind,
                                  restore=args.command == "rehearse",
                                  operational_profile=args.operational_profile,
                                  expected_plan_sha256=args.expected_plan_sha256,
                                  expected_backup_sha256=args.expected_backup_sha256)
        print(json.dumps(result, sort_keys=True), file=stdout)
        return 0
    except UpgradeError as error:
        print(json.dumps({"ok": False, "error": str(error),
                          "evidence_scope": "local_turso_schema_migration_rehearsal",
                          "formal_release_verified": False, "remote_applied": False,
                          "remote_restore_verified": False}, sort_keys=True), file=stderr)
        return 1
    except Exception:
        print(json.dumps({"ok": False, "error": "rehearsal_failed",
                          "evidence_scope": "local_turso_schema_migration_rehearsal",
                          "formal_release_verified": False, "remote_applied": False,
                          "remote_restore_verified": False}, sort_keys=True), file=stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
