"""Fail-closed SQLite persistence contract used by post-deploy smoke tests.

This checks the reported storage contract only. It does not replace a real
write/read and restart verification on the deployment's persistent mount.
"""
from __future__ import annotations

import argparse
import json
import re
import sys


def persistence_is_acceptable(health: object, expected_version: str) -> bool:
    """Require verified persistent storage for V8+, retaining V7 free hosting."""
    if not isinstance(expected_version, str):
        return False
    major = expected_version.split(".", 1)[0]
    if not re.fullmatch(r"[0-9]+", major):
        return False
    try:
        expected_major = int(major)
    except ValueError:
        return False
    if not isinstance(health, dict):
        return False
    database = health.get("database")
    if not isinstance(database, dict) or database.get("engine") != "sqlite":
        return False

    mode = database.get("persistence")
    durable = database.get("durable")
    if mode == "persistent_disk" and durable is True:
        return True
    return expected_major < 8 and mode == "ephemeral" and durable is False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()
    try:
        health = json.load(sys.stdin)
    except (ValueError, OSError):
        print("SQLite persistence gate failed: invalid health JSON", file=sys.stderr)
        return 1
    if not persistence_is_acceptable(health, args.expected_version):
        # Do not echo the health payload, paths, or any runtime activity.
        print("SQLite persistence gate failed: unverified storage contract", file=sys.stderr)
        return 1
    print("SQLite persistence gate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
