"""Synthetic local machine HTTP and notification-wrapper performance evidence.

Five fresh database copies per size/side, actual SQLite/FastAPI/auth/domain
operations, no lifespan or external sender. A synthetic Worker reports `sent`
only to measure the existing terminal-journal API, never as delivery proof.
Prints JSON; callers save reviewed public measurements with normal file tools.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import logging
import os
from pathlib import Path
import platform
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
import types
import warnings


ROOT = Path(__file__).resolve().parents[1]
BASELINE = "eec63a15b98e6550759dcdd0ae6b47056da5b29a"
SIZES = (3, 100)
SAMPLES = 5
DAY = "2026-10-26"
NOW = datetime(2026, 10, 26, 6, 31, tzinfo=timezone.utc)
SOURCE_FILES = (
    "backend/database/owner_machine_schema.py", "backend/database/owner_analysis_schema.py",
    "backend/service/owner_machine_repo.py", "backend/service/owner_machine.py",
    "backend/models/owner_machine.py", "backend/service/owner_analysis_repo.py",
    "backend/service/owner_policy_state.py", "backend/service/owner_sync_repo.py",
    "backend/service/owner_sync.py", "backend/service/v8_repo.py",
    "backend/service/repository_scopes.py", "backend/database/v8_insert.py",
    "backend/database/db.py", "backend/database/owner_sync_schema.py",
    "backend/models/owner_analysis.py", "backend/models/owner_sync.py",
    "backend/strategy/decision_v2.py", "backend/models/v8.py",
    "backend/tests/test_owner_machine_repo.py", "backend/tests/test_owner_machine_capacity.py",
    "backend/tests/test_owner_analysis_repo.py", "tools/benchmark_owner_machine.py",
)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def source_hashes():
    return {name: sha((ROOT / name).read_bytes()) for name in SOURCE_FILES}


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True).stdout


def elapsed(call):
    start = time.perf_counter_ns()
    value = call()
    return (time.perf_counter_ns() - start) / 1_000_000, value


def measured(values):
    return {"samples_ms": [round(value, 6) for value in values],
            "median_ms": round(statistics.median(values), 6),
            "worst_ms": round(max(values), 6), "sample_count": len(values)}


def main():
    # Set the explicit owned DB before importing any application module. Existing
    # configured credentials or database locations are never read or copied.
    owned = Path(tempfile.mkdtemp(prefix="fc-owner-machine-bench-")).resolve()
    assert owned.parent == Path(tempfile.gettempdir()).resolve()
    os.environ["FUND_DB_BACKEND"] = "sqlite"
    os.environ["FUND_DB"] = str(owned / "never-configured.sqlite3")
    os.environ["ADMIN_TOKEN"] = "synthetic-machine-benchmark-admin"
    os.environ["WORKER_TOKEN"] = "synthetic-machine-benchmark-worker"
    os.environ["PRIVATE_READ_TOKEN"] = "synthetic-machine-benchmark-private"

    def forbidden(*_args, **_kwargs):
        raise RuntimeError("benchmark_forbids_network_sockets")
    socket.create_connection = forbidden
    sys.path.insert(0, str(ROOT / "backend"))
    sys.path.insert(0, str(ROOT / "backend" / "tests"))
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    logging.getLogger().setLevel(logging.ERROR)

    # Pin disk bytes BEFORE any project/test module is imported, so an edit
    # during import cannot be mislabeled as the loaded code's stable identity.
    current_before = source_hashes()

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from pytest import MonkeyPatch
    from database import db
    from service import owner_analysis_repo as analysis, owner_machine_repo as machine, security, v8_repo
    from service.owner_machine import build_owner_machine_router
    from service.owner_sync import configured_local_sync_connection
    from test_owner_machine_repo import f as fixture
    from test_owner_machine_capacity import _extend, _refresh

    after_import = source_hashes()
    baseline_raw = git("show", f"{BASELINE}:backend/service/v8_repo.py")
    old_repo = types.ModuleType("_owner_machine_benchmark_eec63_repo")
    sys.modules[old_repo.__name__] = old_repo
    exec(compile(baseline_raw, f"<{BASELINE}:v8_repo.py>", "exec"), old_repo.__dict__)
    samples, comparison = [], []
    semantic_digests = {size: [] for size in SIZES}

    def backup(source, target):
        assert source.resolve().parent == target.resolve().parent == owned
        assert not target.exists()
        with closing(sqlite3.connect(source)) as original, closing(sqlite3.connect(target)) as copied:
            original.backup(copied)

    def counts(path):
        with closing(sqlite3.connect(path)) as conn:
            tables = {name: conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
                      for name in ("owner_analysis_runs", "owner_analysis_components", "holding_versions",
                                   "decision_snapshots", "notification_events", "owner_machine_journal")}
            phases = dict(conn.execute("SELECT status,COUNT(*) FROM notification_events GROUP BY status"))
            journal = dict(conn.execute("SELECT kind,COUNT(*) FROM owner_machine_journal GROUP BY kind"))
            return {"tables": tables, "notification_phases": phases, "journal_kinds": journal}

    for size in SIZES:
        with MonkeyPatch.context() as patch:
            # Existing fixed fixture uses real writes for all references and
            # mixed accounts/zero holding/watch/manual source. Seed time is NOT
            # counted as request latency, nor called a migration proof.
            case = fixture.__wrapped__(owned, patch)
            if size != 3:
                _extend(case, size)
            _refresh(case)
            seed = owned / f"seed-{size}.sqlite3"
            backup(case.path, seed)
            # `fixture` fixes only business time. Monotonic/perf clocks are real.
            assert analysis._clock() == NOW
            app = FastAPI()
            app.include_router(build_owner_machine_router(configured_local_sync_connection))
            client = TestClient(app, raise_server_exceptions=False)
            headers = {"Authorization": "Bearer synthetic-machine-benchmark-worker"}
            # Exactly 25 real HTTP requests per independent size fixture, below
            # the unchanged 30/minute limiter. No mid-fixture reset/retry.
            security.reset_rate_limits()
            for index in range(SAMPLES):
                target = owned / f"http-{size}-{index}.sqlite3"
                backup(seed, target)
                db.DB_PATH = str(target)
                row = {"size": size, "sample": index + 1, "phases": {}}
                def request(phase, method, path, body=None):
                    duration, response = elapsed(lambda: client.request(method, "/api/v2/worker/portfolio" + path,
                        headers=headers, **({"json": body} if body is not None else {})))
                    assert response.status_code == 200, (phase, response.status_code, response.text[:200])
                    value = response.json()
                    row["phases"][phase] = {"elapsed_ms": round(duration, 6), "http_status": response.status_code,
                                             "response_bytes": len(response.content)}
                    return value
                source = request("source", "GET", "/source")
                assert len(source["codes"]) == size and source["revision"] == case.source["revision"]
                prepared = request("prepare", "POST", "/tasks/prepare", case.request)
                assert not prepared["duplicate"] and prepared["source_current"]
                assert len(prepared["run"]["components"]) == len(prepared["task"]["decision_ids"]) == size
                claim = request("claim", "POST", "/tasks/claim", {
                    "occurrence_date": DAY, "request_id": "benchmark-machine-claim-0001", "trigger": "scheduled",
                    "slot": "14:30", "worker_build_sha": "d" * 40, "task_hash": prepared["task_hash"]})
                assert claim["claimed"] and not claim["duplicate"]
                assert claim["attempt"]["valid_count"] == claim["attempt"]["expected_count"] == size
                terminal = request("finish", "POST", "/tasks/finish", {
                    "occurrence_date": DAY, "slot": "14:30", "attempt_hash": claim["attempt_hash"], "outcome": "sent"})
                assert not terminal["duplicate"] and terminal["result"]["execution_status"] == "succeeded"
                status = request("status", "GET", f"/tasks/{DAY}")
                assert len(status["attempts"]) == 1 and status["attempts"][0]["result"] == terminal["result"]
                assert len(status["observations"]) == 2
                row["counts"] = counts(target)
                assert row["counts"]["notification_phases"] == {"scheduled": size, "attempted": size, "sent": size}
                assert row["counts"]["tables"]["owner_analysis_runs"] == 1
                row["complete_components"] = size
                row["body_digest"] = sha(analysis._json({"prepared": prepared, "claim": claim, "terminal": terminal,
                                                         "status": status}).encode("utf-8"))
                semantic_digests[size].append(row["body_digest"])
                samples.append(row)
            client.close()

            # Compare the changed wrapper to its EXACT old implementation, using
            # actual Owner-analysis decisions without a machine task binding.
            # The new guarded machine protocol intentionally has no old API.
            legacy_seed = owned / f"legacy-seed-{size}.sqlite3"
            backup(seed, legacy_seed)
            db.DB_PATH = str(legacy_seed)
            with closing(sqlite3.connect(legacy_seed)) as conn:
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA foreign_keys=ON")
                request = {"request_id": "benchmark-legacy-notification-source", "expected_revision": case.source["revision"],
                           "policy_version": case.policy.policy_version, "evidence": case.request["evidence"]}
                result = analysis.create_analysis_local(conn, analysis._json(request))
                assert result.status == 200 and result.body["source_current"]
                ids = [row["decision"]["decision_id"] for row in result.body["run"]["components"]]
                assert len(ids) == size
            parameters = {"decision_ids": ids, "scheduled_window": DAY + "T14:30+08:00", "attempt_no": 1,
                          "natural_schedule": True, "occurred_at": NOW, "detail": {"benchmark": "local-claim-wrapper-1"}}
            scheduled = {**parameters, "status": "scheduled", "attempt_no": 0}
            assert all(not item.claimed and not item.duplicate for item in old_repo.record_notification_events_batch(**scheduled))
            event_digests = []
            for index in range(SAMPLES):
                sides = ("baseline", "current") if index % 2 == 0 else ("current", "baseline")
                for side in sides:
                    target = owned / f"claim-{size}-{index}-{side}.sqlite3"
                    backup(legacy_seed, target)
                    db.DB_PATH = str(target)
                    function = old_repo.record_notification_events_batch if side == "baseline" else v8_repo.record_notification_events_batch
                    duration, result = elapsed(lambda: function(**{**parameters, "status": "attempted"}))
                    assert len(result) == size and all(item.claimed and not item.duplicate for item in result)
                    digest = sha(analysis._json([item.event.model_dump(mode="json") for item in result]).encode("utf-8"))
                    event_digests.append(digest)
                    row = {"size": size, "sample": index + 1, "side": side, "elapsed_ms": round(duration, 6),
                           "claimed_count": size, "event_digest": digest, "counts": counts(target)}
                    assert row["counts"]["notification_phases"] == {"scheduled": size, "attempted": size}
                    assert row["counts"]["journal_kinds"] == {"schema": 1}
                    comparison.append(row)
            assert len(set(event_digests)) == 1, "baseline/current notification outputs differ"
            # fixture() reuses its literal filename on the next size, so do not
            # overwrite/remove it: choose another fresh fixture directory.
            if size != SIZES[-1]:
                owned = Path(tempfile.mkdtemp(prefix="fc-owner-machine-bench-")).resolve()
                assert owned.parent == Path(tempfile.gettempdir()).resolve()

    current_after = source_hashes()
    drift = [name for name in SOURCE_FILES
             if current_before[name] != after_import[name] or after_import[name] != current_after[name]]
    aggregates = []
    for size in SIZES:
        phases = {phase: measured([row["phases"][phase]["elapsed_ms"] for row in samples if row["size"] == size])
                  for phase in ("source", "prepare", "claim", "finish", "status")}
        phases["complete_flow"] = measured([sum(item["elapsed_ms"] for item in row["phases"].values())
                                           for row in samples if row["size"] == size])
        legacy = {side: measured([row["elapsed_ms"] for row in comparison if row["size"] == size and row["side"] == side])
                  for side in ("baseline", "current")}
        delta = (legacy["current"]["median_ms"] / legacy["baseline"]["median_ms"] - 1) * 100
        legacy["median_delta_percent"] = round(delta, 4)
        legacy["verdict"] = "FAIL" if delta > 20 else "WARN" if delta > 10 else "PASS"
        aggregates.append({"size": size, "machine_http": phases, "machine_baseline": "NOT_COMPARABLE_NEW_API",
                           "legacy_notification_claim_comparison": legacy,
                           "http_body_identical_across_samples": len(set(semantic_digests[size])) == 1})
    report = {"schema": "owner-machine-local-performance-1", "observed_at": datetime.now(timezone.utc).isoformat(),
        "baseline_commit": BASELINE, "baseline_v8_repo_sha256": sha(baseline_raw),
        "current_head": git("rev-parse", "HEAD").decode().strip(), "current_worktree_dirty": bool(git("status", "--porcelain")),
        "source_before": current_before, "source_after_import": after_import, "source_after": current_after, "source_drift": drift,
        "source_stable_during_measurement": not drift, "synthetic_business_clock": NOW.isoformat(),
        "python": platform.python_version(), "platform": platform.platform(), "sqlite": sqlite3.sqlite_version,
        "shared_dependencies": {name: version(name) for name in ("fastapi", "starlette", "pydantic", "httpx", "pytest")},
        "sample_count_per_size_and_side": SAMPLES, "aggregation": aggregates,
        "machine_http_samples": samples, "legacy_claim_samples": comparison,
        "qualification": {"local_synthetic_only": True, "no_lifespan": True, "in_process_asgi_not_tcp": True,
            "actual_sqlite_and_auth": True, "actual_external_delivery": False, "production_readiness": False,
            "remote_migration_or_durability": False, "formal_release": False, "full_head_qualification": False,
            "unchanged_production_rate_limits": True, "business_clock_not_performance_clock": True,
            "socket_create_connection_block_is_not_os_network_sandbox": True},
        "limits": ["Synthetic fixed fixtures, current shared dependencies; not a complete historical environment replay.",
            "Fresh SQLite files and new requests, but imported Python modules and OS page caches remain warm.",
            "Five samples give directional median/worst only, not statistically established p95 or production latency.",
            "Terminal sent is a synthetic authorized API report; no ServerChan or other notification transport was invoked.",
            "The complete machine API is new and cannot claim before/after improvement.",
            "Worktree source may be concurrently edited; any hash drift invalidates current qualification and requires a new run.",
            "No frontend artifacts or real browser interactions are measured by this backend benchmark."]}
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 2 if drift else 0


if __name__ == "__main__":
    raise SystemExit(main())
