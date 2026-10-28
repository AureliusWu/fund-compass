"""Explicit local-only schema8 projection-repair plan and recovery rehearsal.

The source is a closed local SQLite snapshot, never a live database URL.
No credentials are read and no remote apply/repair command exists. Both modes
preserve the source and validate the repaired memory copy with the original
strict scope migration. Rehearse must be bound to a previously reviewed plan.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


EVIDENCE_SCOPE = "local_evidence_projection_repair_rehearsal"


class _ArgumentsError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default diagnostic can echo a private path or supplied
        # argument. Invalid requests use a fixed public error instead.
        raise _ArgumentsError()


def _parser():
    parser = _Parser(description=__doc__)
    parser.add_argument("command", choices=("plan", "rehearse"))
    parser.add_argument("--source", required=True)
    parser.add_argument("--source-kind", required=True,
                        choices=("remote-schema-table", "local-header"))
    parser.add_argument("--operational-profile", default="core-only",
                        choices=("core-only", "known-operational-v1"))
    parser.add_argument("--expected-source-sha256", required=True)
    parser.add_argument("--expected-repair-sha256")
    return parser


def _failure(error, stream):
    print(json.dumps({
        "ok": False, "error": error, "evidence_scope": EVIDENCE_SCOPE,
        "remote_verified": False, "remote_applied": False,
        "remote_restore_verified": False, "formal_release_verified": False,
        "local_original_recovery_verified": False,
    }, sort_keys=True), file=stream)


def main(argv=None, *, stdout=None, stderr=None):
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    try:
        args = _parser().parse_args(argv)
        if ((args.command == "rehearse" and args.expected_repair_sha256 is None)
                or (args.command == "plan" and args.expected_repair_sha256 is not None)):
            raise _ArgumentsError()
    except _ArgumentsError:
        _failure("invalid_arguments", stderr)
        return 2

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
    try:
        from database.turso_projection_repair import (
            ERROR_CODES, ProjectionRepairError,
            plan_projection_repair, rehearse_projection_repair,
        )
    except Exception:
        _failure("projection_repair_failed", stderr)
        return 1

    try:
        kwargs = {
            "source_kind": args.source_kind,
            "operational_profile": args.operational_profile,
            "expected_source_sha256": args.expected_source_sha256,
        }
        if args.command == "rehearse":
            result = rehearse_projection_repair(
                args.source, expected_repair_sha256=args.expected_repair_sha256, **kwargs,
            )
        else:
            result = plan_projection_repair(args.source, **kwargs)
        print(json.dumps(result, sort_keys=True), file=stdout)
        return 0
    except ProjectionRepairError as error:
        code = str(error)
        _failure(code if code in ERROR_CODES else "projection_repair_failed", stderr)
        return 1
    except Exception:
        _failure("projection_repair_failed", stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
