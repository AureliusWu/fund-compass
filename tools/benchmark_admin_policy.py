"""Local synthetic Policy benchmark; never opens configured user databases.

Exact 9654 source is read from Git, not a remote checkout. The old repo and
endpoint are compiled in isolated module namespaces against the same installed
dependencies. Every HTTP append owns a fresh backup of one seeded local DB.
No lifespan, socket, platform credential, cloud API or deployment is used.
Prints JSON only; retained synthetic databases are under an owned Temp folder.
"""
from __future__ import annotations

import ast
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
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


ROOT = Path(__file__).resolve().parents[1]
BASELINE = "9654fb765dba9bafe9f764876257c7f280725b76"
SIZES = (0, 10, 100, 1000)
SAMPLES = 5
NOW = datetime(2026, 10, 26, 1, 0, tzinfo=timezone.utc)
START = datetime(2026, 8, 25, tzinfo=timezone.utc)
CURRENT_FILES = ("backend/main.py", "backend/service/v8_repo.py",
                 "backend/service/repository_scopes.py")


def git_source(path):
    return subprocess.run(["git", "show", f"{BASELINE}:{path}"], cwd=ROOT,
                          check=True, capture_output=True).stdout


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def function_from(raw, name, namespace):
    tree = ast.parse(raw.decode("utf-8"))
    node = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == name)
    node.decorator_list = []
    selected = ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[]))
    exec(compile(selected, f"<{BASELINE}:{name}>", "exec"), namespace)
    return namespace[name]


def summary(values):
    return {"samples": [round(value, 6) for value in values], "median": round(statistics.median(values), 6),
            "worst": round(max(values), 6), "unit": "milliseconds"}


def elapsed(call):
    started = time.perf_counter_ns()
    result = call()
    return (time.perf_counter_ns() - started) / 1_000_000, result


def main():
    owned = Path(tempfile.mkdtemp(prefix="fc-admin-policy-bench-")).resolve()
    assert owned.parent == Path(tempfile.gettempdir()).resolve()
    os.environ["FUND_DB_BACKEND"] = "sqlite"
    os.environ["FUND_DB"] = str(owned / "never-configured.sqlite3")
    os.environ["ADMIN_TOKEN"] = "synthetic-policy-performance-admin"
    os.environ["WORKER_TOKEN"] = "synthetic-policy-performance-worker"
    os.environ["PRIVATE_READ_TOKEN"] = "synthetic-policy-performance-private"

    def forbidden(*_args, **_kwargs):
        raise RuntimeError("benchmark_forbids_network_sockets")
    socket.create_connection = forbidden
    sys.path.insert(0, str(ROOT / "backend"))
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import main as application
    from database import db
    from database.v8_insert import prepare_v8_insert
    from models.v8 import canonical_json, payload_sha256
    from service import repository_scopes as scopes, security, v8_repo
    from strategy import decision_v2
    logging.getLogger().setLevel(logging.ERROR)
    current_before = {name: sha((ROOT / name).read_bytes()) for name in CURRENT_FILES}
    baseline_bytes = {name: git_source(name) for name in CURRENT_FILES}
    current_read_tip = getattr(v8_repo, "read_policy_tip", None)
    assert current_read_tip is not None, "This benchmark expects the profile-aware Policy fix"
    security.reset_rate_limits()
    decision_v2._now = lambda: NOW
    v8_repo._now = lambda: NOW

    old_repo = types.ModuleType("_policy_benchmark_old_repo")
    sys.modules[old_repo.__name__] = old_repo
    exec(compile(baseline_bytes["backend/service/v8_repo.py"], "<9654:v8_repo.py>", "exec"), old_repo.__dict__)
    old_scope_namespace = dict(vars(scopes))
    old_tips = function_from(baseline_bytes["backend/service/repository_scopes.py"],
                             "policy_tips_query", old_scope_namespace)

    class OldScopes:
        policy_tips_query = staticmethod(old_tips)
        def __getattr__(self, name):
            return getattr(scopes, name)
    old_repo.scopes = OldScopes()
    old_repo._now = lambda: NOW
    endpoint_namespace = dict(vars(application))
    endpoint_namespace["v8_repo"] = old_repo
    old_endpoint = function_from(baseline_bytes["backend/main.py"], "v8_post_portfolio_policy", endpoint_namespace)
    applications = {}
    for side, endpoint in (("baseline", old_endpoint), ("current", application.v8_post_portfolio_policy)):
        app = FastAPI()
        app.add_api_route("/policy", endpoint, methods=["POST"])
        applications[side] = TestClient(app, raise_server_exceptions=False)

    def candidate_tips(scope):
        scope = scopes.validate_scope(scope)
        table = scopes.production_table(scopes.ROOTS["policy"][0]) if scope == scopes.PRODUCTION else scopes.ROOTS["policy"][0]
        return (f"SELECT p.payload_json FROM {table} p JOIN {scopes.RECORD_TABLE} ps "
                "ON ps.record_kind='policy' AND ps.record_id=p.policy_version "
                "WHERE ps.scope_key=? AND p.policy_version NOT IN ("
                "SELECT child.supersedes FROM portfolio_policy_versions child "
                f"JOIN {scopes.RECORD_TABLE} cs ON cs.record_kind='policy' AND cs.record_id=child.policy_version "
                "WHERE cs.scope_key=? AND child.supersedes IS NOT NULL)", (scope.key, scope.key))

    def insert_fixture(conn, policy, scope=scopes.PRODUCTION):
        payload = policy.model_dump(mode="json")
        identity = v8_repo._policy_identity(policy)
        conn.execute(*prepare_v8_insert(conn, "portfolio_policy_versions", (
            policy.policy_version, policy.name, canonical_json(policy.target_allocations), canonical_json(policy.target_ranges),
            policy.max_single_fund_weight, policy.max_theme_weight, policy.rebalance_band,
            canonical_json(policy.dca_rules), canonical_json(policy.reduce_rules), canonical_json(policy.sell_rules),
            policy.effective_at.isoformat(), policy.created_at.isoformat(), policy.source,
            policy.supersedes, canonical_json(payload), payload_sha256(identity))))
        if scope is not None:
            scopes.register_record(conn, "policy", policy.policy_version, scope)

    def seed(path, count, *, scheduled=False):
        assert path.resolve().parent == owned
        db.DB_PATH = str(path)
        db.init_db()
        predecessor = None
        with db.transaction(immediate=True) as conn:
            for index in range(count):
                policy = (decision_v2.default_portfolio_policy(START) if index == 0 else
                          decision_v2.build_portfolio_policy(name=f"Policy performance seed {index}",
                              target_allocations={"510300": 20}, max_single_fund_weight=40,
                              rebalance_band=2, effective_at=(NOW + timedelta(minutes=index - count // 2)
                                  if scheduled else START + timedelta(minutes=index)),
                              source="admin", supersedes=predecessor, created_at=START + timedelta(minutes=index)))
                insert_fixture(conn, policy)
                predecessor = policy.policy_version

    def connect(path):
        assert path.resolve().parent == owned
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    sql_results = {}
    http_results = {}
    legacy_results = {}
    plans = {}
    for count in SIZES:
        # Independent history-size fixtures, not one accumulating 40-request
        # limiter experiment. Each group still performs ten requests through
        # the actual unchanged 30-request Admin limit and authentication.
        security.reset_rate_limits()
        path = owned / f"seed-{count}.sqlite3"
        seed(path, count)
        samples = {"correlated_not_exists": [], "uncorrelated_not_in": []}
        with closing(connect(path)) as conn:
            for label, query in (("correlated_not_exists", old_tips), ("uncorrelated_not_in", candidate_tips)):
                sql, params = query(scopes.PRODUCTION)
                rows = conn.execute(sql + " LIMIT 2", params).fetchall()
                if count == 0:
                    assert rows == []
                else:
                    assert len(rows) == 1
                # Warm this same DB/page cache once, then alternate the query
                # order in the timed pairs to avoid always advantaging one.
                conn.execute(sql + " LIMIT 2", params).fetchall()
                plans[f"{count}:{label}"] = [tuple(row) for row in conn.execute("EXPLAIN QUERY PLAN " + sql + " LIMIT 2", params)]
            for sample in range(SAMPLES):
                observed = []
                cases = (("correlated_not_exists", old_tips), ("uncorrelated_not_in", candidate_tips))
                for label, query in (cases if sample % 2 == 0 else cases[::-1]):
                    sql, params = query(scopes.PRODUCTION)
                    duration, rows = elapsed(lambda: conn.execute(sql + " LIMIT 2", params).fetchall())
                    samples[label].append(duration)
                    observed.append([tuple(row) for row in rows])
                assert observed[0] == observed[1], "Query candidates disagree"
        sql_results[str(count)] = {label: summary(values) for label, values in samples.items()}

        durations = {side: [] for side in applications}
        row_counts = {side: [] for side in applications}
        response_equality = []
        for sample in range(SAMPLES):
            responses = {}
            sides = ("baseline", "current") if sample % 2 == 0 else ("current", "baseline")
            for side in sides:
                target = owned / f"append-{count}-{sample}-{side}.sqlite3"
                with closing(connect(path)) as source, closing(connect(target)) as dest:
                    source.backup(dest)
                db.DB_PATH = str(target)
                duration, response = elapsed(lambda: applications[side].post("/policy", json={
                    "name": "Policy performance explicit append", "target_allocations": {"510300": 20},
                    "max_single_fund_weight": 40, "rebalance_band": 2,
                    "effective_at": (NOW + timedelta(minutes=1)).isoformat(),
                }, headers={"Authorization": "Bearer synthetic-policy-performance-admin"}))
                assert response.status_code == 200, (side, count, response.status_code, response.text)
                responses[side] = response.json()
                durations[side].append(duration)
                with closing(connect(target)) as conn:
                    total = conn.execute("SELECT count(*) FROM portfolio_policy_versions").fetchone()[0]
                    row_counts[side].append(total)
                    assert total == count + (2 if count == 0 and side == "baseline" else 1)
            if count:
                assert responses["baseline"] == responses["current"], "Successful append bodies differ"
                response_equality.append(True)
        http_results[str(count)] = {
            "baseline": summary(durations["baseline"]), "current": summary(durations["current"]),
            "policyCountsAfterAppend": row_counts,
            "comparableBusinessSemantics": count != 0,
            "equalResponseBodies": response_equality,
        }

        scheduled_path = owned / f"legacy-seed-{count}.sqlite3"
        seed(scheduled_path, count, scheduled=True)
        reads = {"baseline": [], "current": []}
        read_counts = {"baseline": [], "current": []}
        selected_equal = []
        for sample in range(SAMPLES):
            selected = {}
            sides = ("baseline", "current") if sample % 2 == 0 else ("current", "baseline")
            for side in sides:
                target = owned / f"legacy-{count}-{sample}-{side}.sqlite3"
                with closing(connect(scheduled_path)) as source, closing(connect(target)) as dest:
                    source.backup(dest)
                with closing(connect(target)) as conn:
                    before = [tuple(row) for row in conn.execute(
                        "SELECT policy_version,payload_json,payload_sha256 FROM portfolio_policy_versions ORDER BY policy_version")]
                db.DB_PATH = str(target)
                repository = old_repo if side == "baseline" else v8_repo
                duration, current = elapsed(lambda: repository.get_policy(at=NOW))
                reads[side].append(duration)
                selected[side] = canonical_json(current)
                with closing(connect(target)) as conn:
                    after = [tuple(row) for row in conn.execute(
                        "SELECT policy_version,payload_json,payload_sha256 FROM portfolio_policy_versions ORDER BY policy_version")]
                    if count:
                        assert before == after, "Legacy effective read changed Policy history"
                    else:
                        assert len(after) == 1
                    read_counts[side].append(len(after))
            assert selected["baseline"] == selected["current"], "Legacy selected effective versions differ"
            selected_equal.append(True)
        legacy_results[str(count)] = {
            "baseline": summary(reads["baseline"]), "current": summary(reads["current"]),
            "sameEffectivePolicy": selected_equal, "policyCountsAfterRead": read_counts,
            "nonemptyHistoryUnchanged": count != 0,
            "semantics": "legacy initialization creates one default" if count == 0 else "same default-root chain with later scheduled versions; select only the currently effective Policy",
        }

    semantic_path = owned / "query-semantics.sqlite3"
    seed(semantic_path, 0)
    semantic_checks = []
    acceptance = scopes.acceptance_scope("v9-acceptance-policy-perf")
    def policy(name, predecessor=None, source="admin"):
        return decision_v2.build_portfolio_policy(name=name, target_allocations={"510300": 20},
            effective_at=START, source=source, supersedes=predecessor, created_at=START)
    root = policy("SQL semantics production root")
    tip = policy("SQL semantics production child", root.policy_version)
    other = policy("SQL semantics acceptance root")
    def compare(label):
        with closing(connect(semantic_path)) as conn:
            for selected in (scopes.PRODUCTION, acceptance):
                outputs = []
                for query in (old_tips, candidate_tips):
                    sql, params = query(selected)
                    outputs.append(sorted(row[0] for row in conn.execute(sql, params)))
                assert outputs[0] == outputs[1], (label, selected.key)
                semantic_checks.append({"case": label, "scope": selected.key,
                                        "equal": True, "tipCount": len(outputs[0])})
    compare("empty")
    with db.transaction(immediate=True) as conn:
        insert_fixture(conn, root); insert_fixture(conn, tip); insert_fixture(conn, other, acceptance)
    compare("separate_scoped_null_roots")
    with db.transaction(immediate=True) as conn:
        # Deliberate raw fault fixtures, not accepted business writes: a
        # foreign-scope/unregistered child must not hide a production tip.
        insert_fixture(conn, policy("Foreign scope child", tip.policy_version), acceptance)
        insert_fixture(conn, policy("Unregistered child", tip.policy_version), None)
        insert_fixture(conn, policy("Reserved production root", source="synthetic:policy-benchmark"))
    compare("foreign_unregistered_child_and_reserved_root")
    with db.transaction(immediate=True) as conn:
        insert_fixture(conn, policy("Raw same-scope fork", root.policy_version))
    compare("same_scope_fork")
    for client in applications.values():
        client.close()
    current_after = {name: sha((ROOT / name).read_bytes()) for name in CURRENT_FILES}
    assert current_before == current_after, "Production source changed during measurement"
    result = {
        "schema": "admin-policy-local-performance-1", "captured_at_utc": datetime.now(timezone.utc).isoformat(),
        "baselineCommit": BASELINE, "baselineSourceSha256": {name: sha(raw) for name, raw in baseline_bytes.items()},
        "currentSourceSha256": current_before, "python": platform.python_version(), "sqlite": sqlite3.sqlite_version,
        "samplesPerSide": SAMPLES, "ownedSyntheticDirectory": str(owned), "sql": sql_results,
        "actualHttpAdminAppend": http_results, "legacyGetPolicy": legacy_results,
        "queryPlans": plans, "querySemanticChecks": semantic_checks,
        "method": "Same installed dependencies, exact baseline repo/endpoint function source compiled in isolated namespaces; shared current model/schema/guard dependencies. Old scope function uses current immutable scope types. Five alternating fresh DB-copy HTTP requests per side/size, real auth/Pydantic/SQLite write, no lifespan or sockets. Each independent size group resets only its local synthetic limiter fixture; ten requests remain under the unchanged actual 30-request limit. SQL timings warm cache and alternate order. Empty HTTP history baseline initializes an extra default row, so its business semantics differ and it is not a like-for-like latency comparison. The separately timed legacy get_policy path uses independent default-root histories with scheduled future versions, checks complete Policy rows unchanged on nonempty reads, and compares full selected effective Policy values; empty legacy calls intentionally bootstrap one default on both sides.",
        "excludedAttempt": "Initial unqualified attempt reused one accumulating synthetic Admin limiter bucket across all sizes, correctly received HTTP429 on reaching request31 at size1000, and stopped. No budgets or production auth changed; size fixtures are now isolated.",
        "limits": "Small synthetic local samples; not a network/cloud/real-device benchmark. Seed construction uses fixed real models/INSERT/scope records, not repeated Admin HTTP; it is performance setup, not lifecycle correctness evidence. Global dependency drift from baseline is not isolated. No resource or formal-release gate is closed.",
    }
    print(json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
