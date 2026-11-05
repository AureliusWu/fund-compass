#!/usr/bin/env python3
"""Check the closed, nonfinancial receipt of a candidate-only calibration run.

A successful check means evaluation finished without changing or publishing a
strategy. It never authorizes publication or supplies private durable storage.
"""
import argparse
import json
import os
from pathlib import Path


STATUS_MAX_BYTES = 4096
STATUS_KEYS = frozenset((
    "schema", "execution_status", "candidate_status", "candidate_passed",
    "candidate_changed", "candidate_eligible_for_admin_review", "reason",
    "publication_status", "artifact_status", "publish", "publication_accepted",
    "private_output_published", "registry_unchanged", "public_report_unchanged",
))


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate status field")
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise ValueError("nonfinite status value")


def read_status(path: Path) -> dict:
    with path.open("rb") as stream:
        raw = stream.read(STATUS_MAX_BYTES + 1)
    if len(raw) > STATUS_MAX_BYTES:
        raise ValueError("status exceeds byte limit")
    value = json.loads(
        raw.decode("utf-8"), object_pairs_hook=_unique_object,
        parse_constant=_invalid_constant,
    )
    if type(value) is not dict or set(value) != STATUS_KEYS:
        raise ValueError("invalid status fields")
    return value


def verify_status(status: dict) -> bool:
    """Allow only an explicitly rejected/unchanged, unpublished evaluation."""
    if type(status) is not dict or set(status) != STATUS_KEYS:
        raise ValueError("invalid status fields")
    if type(status["schema"]) is not int or status["schema"] != 1:
        raise ValueError("invalid status schema")
    for key in ("candidate_passed", "candidate_changed", "candidate_eligible_for_admin_review"):
        if type(status[key]) is not bool:
            raise ValueError("invalid candidate decision")
    if (
        any(status[key] is not False for key in (
            "publish", "publication_accepted", "private_output_published",
        ))
        or status["registry_unchanged"] is not True
        or status["public_report_unchanged"] is not True
        or status["artifact_status"] != "not_created"
    ):
        raise ValueError("publication or mutation boundary violated")

    passed = status["candidate_passed"]
    changed = status["candidate_changed"]
    eligible = status["candidate_eligible_for_admin_review"]
    decision = (status["execution_status"], status["candidate_status"],
                status["reason"], status["publication_status"])
    if not passed and not eligible and decision == (
        "evaluation_completed", "rejected", "candidate_rejected", "not_requested",
    ):
        return True
    if passed and not changed and not eligible and decision == (
        "evaluation_completed", "no_change", "same_parameters", "not_requested",
    ):
        return True
    if passed and changed and eligible and decision == (
        "blocked", "eligible", "private_sink_required", "BLOCKED_PRIVATE_SINK_REQUIRED",
    ):
        return False
    raise ValueError("inconsistent calibration decision")


def check_run(status_path: Path, step_outcome: str, summary_path: Path | None = None) -> int:
    # Never read a leftover receipt after a failed/skipped/cancelled producer.
    status = None
    allowed = False
    if step_outcome == "success":
        try:
            status = read_status(status_path)
            allowed = verify_status(status)
        except (OSError, UnicodeError, ValueError, TypeError):
            status = None
    if status is None:
        lines = [
            "- execution_status: failed",
            "- reason: calibration_validation_failed_or_invalid_status",
            "- publication: not_accepted",
            "- publication_accepted: false",
            "- publish: false",
            "- private_output_published: false",
        ]
    else:
        lines = [
            f"- execution_status: {status['execution_status']}",
            f"- candidate: {status['candidate_status']}",
            f"- reason: {status['reason']}",
            f"- publication: {status['publication_status']}",
            "- artifact_status: not_created",
            "- registry_unchanged: true",
            "- public_report_unchanged: true",
            "- publication_accepted: false",
            "- publish: false",
            "- private_output_published: false",
        ]
    text = "### Strategy calibration evaluation\n\n" + "\n".join(lines) + "\n"
    if summary_path is not None:
        with summary_path.open("a", encoding="utf-8") as stream:
            stream.write(text)
    print(text, end="")
    return 0 if allowed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status-path", type=Path, required=True)
    parser.add_argument("--step-outcome", required=True)
    args = parser.parse_args()
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    return check_run(args.status_path, args.step_outcome, Path(summary) if summary else None)


if __name__ == "__main__":
    raise SystemExit(main())
