"""Existing Admin Policy lifecycle over real HTTP and explicit local SQLite.

Only the database path and UTC clock are controlled. No lifespan, cloud,
browser Admin credential, widened Owner scope or remote evidence is involved.
"""
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import json
import re
import sqlite3
import tempfile

import pytest
from fastapi.testclient import TestClient

import main
from database import db
from database.owner_analysis_schema import provision_owner_analysis_candidate
from database.owner_sync_schema import provision_owner_sync_candidate
from models.owner_analysis import parse_owner_analysis_request
from models.v8 import PortfolioPolicy, canonical_json, stable_id
from service import owner_analysis_repo as analysis
from service import owner_policy_state, owner_sessions as owners, security, v8_repo
from strategy import decision_v2


NOW = datetime(2026, 10, 26, 1, 0, tzinfo=timezone.utc)
PASSWORD = "synthetic admin lifecycle Owner password"
POLICY_PATH = "/api/v2/portfolio/policy"
STATE_PATH = "/api/v2/private/portfolio/policy-state"
ANALYSIS_PATH = "/api/v2/owner/analysis"
TOKENS = {name: "admin-lifecycle-fixture-" + name
          for name in ("ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN")}
FRONTEND = Path(__file__).resolve().parents[2] / "frontend/src/utils/owner-admin-policy-lifecycle.fixtures.ts"
V6_FRONTEND = Path(__file__).resolve().parents[2] / "frontend/src/utils/owner-analysis-v6-contract.fixtures.ts"


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@pytest.fixture(scope="module")
def password_hash():
    return owners.hash_owner_password(PASSWORD)


@contextmanager
def local_database(path, monkeypatch, password_hash):
    clock = SimpleNamespace(now=NOW)
    owners.reset_owner_sessions()
    security.reset_rate_limits()
    monkeypatch.setenv("OWNER_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    for name, token in TOKENS.items():
        monkeypatch.setenv(name, token)
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with closing(connect(path)) as conn:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
        provision_owner_analysis_candidate(conn, synthetic_candidate=True)

    class ClockDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(clock.now.timestamp(), tz or timezone.utc)

    monkeypatch.setattr(main, "datetime", ClockDatetime)
    monkeypatch.setattr(owner_policy_state, "datetime", ClockDatetime)
    monkeypatch.setattr(v8_repo, "_now", lambda: clock.now)
    monkeypatch.setattr(decision_v2, "_now", lambda: clock.now)
    actual_clock = analysis._clock
    monkeypatch.setattr(analysis, "_clock", lambda stamp=None: actual_clock(stamp or clock.now))

    def forbidden(*_args, **_kwargs):
        pytest.fail("Admin lifecycle unexpectedly entered application lifespan")

    monkeypatch.setattr(main, "init_db", forbidden)
    # closing, rather than TestClient's context manager, does not run lifespan.
    with closing(TestClient(main.app, raise_server_exceptions=False)) as client:
        yield SimpleNamespace(path=path, client=client, clock=clock)
    owners.reset_owner_sessions()
    security.reset_rate_limits()


@pytest.fixture
def local(tmp_path, monkeypatch, password_hash):
    with local_database(tmp_path / "explicit-admin-policy-lifecycle.sqlite3", monkeypatch, password_hash) as active:
        yield active


def admin_headers():
    return {"Authorization": "Bearer " + TOKENS["ADMIN_TOKEN"]}


def payload(name, effective):
    return {"name": name, "target_allocations": {"510300": 20},
            "max_single_fund_weight": 40, "rebalance_band": 2,
            "effective_at": effective.isoformat()}


def policy_rows(path):
    with closing(connect(path)) as conn:
        return [dict(row) for row in conn.execute(
            "SELECT * FROM portfolio_policy_versions ORDER BY effective_at,policy_version")]


def database_image(path):
    tables = ("portfolio_policy_versions", "v8_record_scopes", "holding_versions",
              "decision_snapshots", "owner_analysis_runs", "owner_analysis_components",
              "owner_sync_state", "owner_sync_records", "owner_sync_changes", "owner_sync_receipts")
    with closing(connect(path)) as conn:
        return {table: tuple(tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid"))
                for table in tables}


def private(response):
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"


def owner_headers(local):
    response = local.client.post("/api/v2/owner/session", json={"password": PASSWORD})
    assert response.status_code == 200, response.text
    assert set(response.json()["scopes"]) == {"read_private", "write_holdings", "run_personal_analysis"}
    assert owners.OWNER_SCOPES == ("read_private", "write_holdings", "run_personal_analysis")
    private(response)
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def publish(local, name, effective, **overrides):
    body = {**payload(name, effective), **overrides}
    response = local.client.post(POLICY_PATH, headers=admin_headers(), json=body)
    assert response.status_code == 200, (name, response.status_code, response.text)
    model = PortfolioPolicy.model_validate(response.json())
    assert model.policy_version == stable_id("pol", v8_repo._policy_identity(model))
    assert model.source == "admin"
    return response.json()


def read_state(local, auth):
    before = database_image(local.path)
    response = local.client.get(STATE_PATH, headers=auth)
    assert response.status_code == 200, response.text
    private(response)
    assert database_image(local.path) == before
    return response.json()


def test_admin_http_appends_current_and_two_future_policies_to_the_actual_chain_tip(local):
    versions = []
    for name, effective in (("Explicit A current", NOW - timedelta(hours=1)),
                            ("Explicit B next", NOW + timedelta(hours=1)),
                            ("Explicit C later", NOW + timedelta(hours=2))):
        response = local.client.post(POLICY_PATH, headers=admin_headers(), json=payload(name, effective))
        assert response.status_code == 200, (name, response.status_code, response.text)
        versions.append(response.json())

    first, second, third = versions
    assert [row["supersedes"] for row in versions] == [None, first["policy_version"], second["policy_version"]]
    assert all(row["source"] == "admin" for row in versions)
    stored = policy_rows(local.path)
    assert [row["policy_version"] for row in stored] == [row["policy_version"] for row in versions]
    assert len(stored) == 3
    assert v8_repo.read_policy(at=NOW).policy_version == first["policy_version"]
    assert v8_repo.read_policy(at=NOW + timedelta(hours=1)).policy_version == second["policy_version"]
    assert v8_repo.read_policy(at=NOW + timedelta(hours=2)).policy_version == third["policy_version"]


def test_admin_http_empty_policy_database_creates_only_the_explicit_admin_policy(local):
    assert policy_rows(local.path) == []
    response = local.client.post(POLICY_PATH, headers=admin_headers(),
                                 json=payload("Explicit first Policy", NOW - timedelta(hours=1)))
    assert response.status_code == 200, response.text
    rows = policy_rows(local.path)
    assert len(rows) == 1, [(row["name"], row["source"]) for row in rows]
    assert rows[0]["policy_version"] == response.json()["policy_version"]
    assert rows[0]["source"] == "admin" and rows[0]["supersedes"] is None


@pytest.mark.parametrize("identity", ["anonymous", "wrong", "worker", "private-read", "owner"])
def test_existing_admin_policy_write_never_accepts_other_identities_or_enters_storage(local, monkeypatch, identity):
    auth = {
        "anonymous": {}, "wrong": {"Authorization": "Bearer invalid-admin-lifecycle-token"},
        "worker": {"Authorization": "Bearer " + TOKENS["WORKER_TOKEN"]},
        "private-read": {"Authorization": "Bearer " + TOKENS["PRIVATE_READ_TOKEN"]},
        "owner": owner_headers(local),
    }[identity]
    before = database_image(local.path)

    def forbidden(*_args, **_kwargs):
        pytest.fail("Non-Admin Policy request reached a database factory")

    with monkeypatch.context() as guard:
        guard.setattr(db, "get_conn", forbidden)
        response = local.client.post(POLICY_PATH, headers=auth,
                                     json=payload("Forbidden Policy write", NOW))
    assert response.status_code == 401, response.text
    assert database_image(local.path) == before


def test_owner_reads_empty_policy_state_without_default_or_write_permission(local):
    auth = owner_headers(local)
    before = database_image(local.path)
    state = read_state(local, auth)
    assert state["history"] == [] and state["current"] is None and state["next_effective_at"] is None
    denied = local.client.post(POLICY_PATH, headers=auth, json=payload("Owner cannot publish", NOW))
    assert denied.status_code == 401, denied.text
    assert database_image(local.path) == before


def test_owner_reads_complete_actual_admin_timeline_at_exact_future_boundaries(local):
    auth = owner_headers(local)
    a = publish(local, "A current", NOW - timedelta(hours=1), rebalance_band=0)
    original_a = policy_rows(local.path)
    b = publish(local, "B next", NOW + timedelta(hours=1), max_single_fund_weight=30)
    c = publish(local, "C later", NOW + timedelta(hours=2), max_single_fund_weight=None)
    assert policy_rows(local.path)[:1] == original_a
    assert a["supersedes"] is None and b["supersedes"] == a["policy_version"]
    assert c["supersedes"] == b["policy_version"]
    for instant, current, upcoming in ((NOW, a, b),
                                       (NOW + timedelta(hours=1) - timedelta(microseconds=1), a, b),
                                       (NOW + timedelta(hours=1), b, c),
                                       (NOW + timedelta(hours=2) - timedelta(microseconds=1), b, c),
                                       (NOW + timedelta(hours=2), c, None)):
        local.clock.now = instant
        state = read_state(local, auth)
        assert datetime.fromisoformat(state["observed_at"].replace("Z", "+00:00")) == instant
        assert state["current"] == current
        assert state["history"] == [c, b, a]
        assert state["next_effective_at"] == (upcoming["effective_at"] if upcoming else None)
    assert a["rebalance_band"] == 0 and c["max_single_fund_weight"] is None


def test_future_only_explicit_admin_root_has_no_current_policy_and_bootstrap_does_not_add_default(local):
    auth = owner_headers(local)
    future = publish(local, "Explicit future-only Admin root", NOW + timedelta(hours=1))
    assert future["supersedes"] is None
    before = database_image(local.path)
    assert v8_repo.ensure_default_policy().policy_version == future["policy_version"]
    assert [row.policy_version for row in v8_repo.policy_history()] == [future["policy_version"]]
    with pytest.raises(LookupError, match="no effective policy version"):
        v8_repo.get_policy()
    state = read_state(local, auth)
    assert state["current"] is None and state["next_effective_at"] == future["effective_at"]
    assert state["history"] == [future]
    assert database_image(local.path) == before
    assert [row["source"] for row in policy_rows(local.path)] == ["admin"]


@pytest.mark.parametrize("effective", [NOW - timedelta(days=1), NOW - timedelta(hours=1),
                                        NOW, NOW + timedelta(hours=1)])
def test_admin_cannot_append_equal_or_earlier_than_existing_future_tip(local, effective):
    publish(local, "A current", NOW - timedelta(hours=1))
    publish(local, "B actual future tip", NOW + timedelta(hours=1))
    before = database_image(local.path)
    response = local.client.post(POLICY_PATH, headers=admin_headers(),
                                 json=payload("Must not replace existing tip", effective))
    assert response.status_code == 409, response.text
    assert database_image(local.path) == before


@pytest.mark.parametrize("invalid", [
    {"unexpected": "not a Policy field"}, {"effective_at": "2026-10-26T02:00:00"},
    {"target_allocations": {"510300": True}}, {"target_allocations": {"510300": 101}},
    {"target_ranges": {"510300": [30, 20]}},
])
def test_invalid_admin_model_never_initializes_or_appends_any_policy(local, invalid):
    before = database_image(local.path)
    response = local.client.post(POLICY_PATH, headers=admin_headers(),
                                 json={**payload("Invalid Admin Policy", NOW), **invalid})
    assert response.status_code == 422, response.text
    assert database_image(local.path) == before


def seed_complete_owner_source(local, auth):
    detail = {"code": "510300", "name": "synthetic private lifecycle fund", "type": "指数型",
              "latest_nav": 1.5, "latest_nav_date": NOW.date().isoformat(),
              "source": "admin-policy-lifecycle-fixture", "updated_at": NOW.isoformat(),
              "decision_context": {"status": "unavailable", "source": "admin-policy-lifecycle-fixture"}}
    evidence = v8_repo.save_evidence(decision_v2.build_evidence_snapshot(
        detail, {"score": 82, "score_version": "admin-policy-lifecycle-fixture", "coverage": 1.0},
        {"signal": "持有", "signal_version": "admin-policy-lifecycle-fixture", "coverage": 1.0,
         "layers": {"valuation": {"percentile": 20}, "trend": {"label": "上升趋势"}}},
        {"available": False}, created_at=NOW,
    ))
    batches = [
        {"request_id": "policy-lifecycle-sync-0001", "expected_revision": 0, "operations": [
            {"key": "510300::synthetic-a", "kind": "holding", "deleted": False,
             "changes": {"name": detail["name"], "shares": 10, "cost": 1, "target_weight": 10}},
            {"key": "510300::synthetic-b", "kind": "holding", "deleted": False,
             "changes": {"name": detail["name"], "shares": 0, "cost": None, "target_weight": 10}},
            {"key": "asset:synthetic-policy-cash", "kind": "manual_asset", "deleted": False,
             "changes": {"name": "synthetic cash", "cls": "现金", "value": -0.0, "note": None}},
            {"key": "asset:synthetic-policy-retired", "kind": "manual_asset", "deleted": False,
             "changes": {"name": "synthetic retired", "cls": "现金", "value": 0, "note": None}},
        ]},
        {"request_id": "policy-lifecycle-sync-0002", "expected_revision": 1, "operations": [
            {"key": "asset:synthetic-policy-retired", "kind": "manual_asset", "deleted": True,
             "base_values": {"kind": "manual_asset", "deleted": False, "name": "synthetic retired",
                             "cls": "现金", "value": 0, "note": None}},
        ]},
    ]
    for revision, batch in enumerate(batches, 1):
        response = local.client.post("/api/v2/owner/sync", json=batch,
                                     headers={**auth, "X-Owner-Sync-Consent": "owner-sync-v1"})
        assert response.status_code == 200, response.text
        assert response.json()["revision"] == revision
        private(response)
    return evidence


def create_analysis(local, auth, request_id, policy, evidence):
    request = {"request_id": request_id, "expected_revision": 2,
               "policy_version": policy["policy_version"],
               "evidence": [{"code": "510300", "evidence_id": evidence.evidence_id}]}
    parsed = parse_owner_analysis_request(json.dumps(request))
    response = local.client.post(ANALYSIS_PATH, json=request,
                                 headers={**auth, "X-Owner-Analysis-Consent": "owner-analysis-v1"})
    assert response.status_code == 200, response.text
    private(response)
    result = response.json()
    assert result["source_current"] is True and result["run"]["policy"] == policy
    assert result["run"]["source"]["revision"] == 2 and result["run"]["source"]["record_count"] == 4
    assert result["run"]["components"][0]["account_count"] == 2
    assert result["run"]["components"][0]["decision"]["policy_version"] == policy["policy_version"]
    return parsed, result


def test_real_owner_analysis_new_policies_require_new_explicit_runs_and_preserve_original_receipts(local):
    auth = owner_headers(local)
    a = publish(local, "A analysis guardrails", NOW - timedelta(hours=1))
    b = publish(local, "B analysis guardrails", NOW + timedelta(hours=1), rebalance_band=0)
    c = publish(local, "C analysis guardrails", NOW + timedelta(hours=2), max_single_fund_weight=30)
    evidence = seed_complete_owner_source(local, auth)
    old_request, old_result = create_analysis(local, auth, "policy-analysis-a-0001", a, evidence)
    original = database_image(local.path)
    assert len(original["holding_versions"]) == len(original["decision_snapshots"]) == 1
    assert read_state(local, auth)["current"] == old_result["run"]["policy"]

    for offset, policy, request_id in ((1, b, "policy-analysis-b-0002"), (2, c, "policy-analysis-c-0003")):
        local.clock.now = NOW + timedelta(hours=offset)
        before_read = database_image(local.path)
        current = read_state(local, auth)
        assert current["current"] == policy
        receipt = local.client.get(ANALYSIS_PATH + "/requests/" + old_request.request_id,
                                   headers={**auth, "X-Owner-Analysis-Request-Hash": old_request.request_hash()})
        assert receipt.status_code == 200, receipt.text
        private(receipt)
        assert receipt.json() == {"state": "matched", "status": 200, "result": old_result}
        # source_current is not an assertion that this historical Policy is
        # still active. Frontend qualification separately compares current ID.
        assert receipt.json()["result"]["source_current"] is True
        assert current["current"]["policy_version"] != receipt.json()["result"]["run"]["policy"]["policy_version"]
        assert database_image(local.path) == before_read

        _, new_result = create_analysis(local, auth, request_id, policy, evidence)
        assert new_result["run"]["run_id"] != old_result["run"]["run_id"]
        assert new_result["run"]["source"] == old_result["run"]["source"]
        after = database_image(local.path)
        for table in ("holding_versions", "decision_snapshots", "owner_analysis_runs", "owner_analysis_components"):
            assert after[table][:len(original[table])] == original[table]
            assert len(after[table]) == offset + 1
        assert after["portfolio_policy_versions"] == original["portfolio_policy_versions"]
        for table in ("owner_sync_state", "owner_sync_records", "owner_sync_changes", "owner_sync_receipts"):
            assert after[table] == original[table]


def test_legacy_get_policy_keeps_its_separate_default_initialization_contract(local):
    assert policy_rows(local.path) == []
    policy = v8_repo.get_policy()
    rows = policy_rows(local.path)
    assert len(rows) == 1 and rows[0]["policy_version"] == policy.policy_version
    assert rows[0]["source"] == "system-default"


@pytest.mark.parametrize("entry", ["get_policy", "policy_history", "ensure_default_policy"])
def test_explicit_admin_root_is_compatible_with_legacy_reads_and_bootstrap_without_default_writes(local, entry):
    a = publish(local, "Explicit Admin root", NOW - timedelta(hours=1))
    b = publish(local, "Explicit Admin next", NOW + timedelta(hours=1))
    before = database_image(local.path)
    result = getattr(v8_repo, entry)()
    if entry == "get_policy":
        assert result.policy_version == a["policy_version"]
    elif entry == "policy_history":
        assert [row.policy_version for row in result] == [b["policy_version"], a["policy_version"]]
    # This is the same bootstrap helper main.lifespan invokes, not a complete
    # startup/restart/deployment test. Calling it again must be a pure no-op.
    v8_repo.ensure_default_policy()
    assert database_image(local.path) == before
    assert all(row["source"] == "admin" for row in policy_rows(local.path))


def test_existing_legacy_default_root_survives_admin_append_and_repeated_bootstrap(local):
    default = v8_repo.ensure_default_policy()
    before = policy_rows(local.path)
    appended = publish(local, "Admin follows existing legacy root", NOW)
    assert appended["supersedes"] == default.policy_version
    assert policy_rows(local.path)[:1] == before
    image = database_image(local.path)
    v8_repo.ensure_default_policy()
    v8_repo.ensure_default_policy()
    assert v8_repo.get_policy().policy_version == appended["policy_version"]
    assert [row.policy_version for row in v8_repo.policy_history()] == [appended["policy_version"], default.policy_version]
    assert database_image(local.path) == image


def test_admin_stale_tip_after_actual_competing_commit_returns_409_without_rebase_or_second_write(local, monkeypatch):
    a = publish(local, "A before concurrent Admin", NOW - timedelta(hours=1))
    b = publish(local, "B future before concurrent Admin", NOW + timedelta(hours=1))
    before = policy_rows(local.path)
    actual_build = main.build_portfolio_policy
    committed = {}

    def competing_commit(**values):
        candidate = actual_build(**values)
        assert candidate.supersedes == b["policy_version"]
        competing = decision_v2.build_portfolio_policy(
            name="Actual separately committed competing tip", source="admin",
            effective_at=NOW + timedelta(minutes=90), created_at=NOW,
            max_single_fund_weight=35, supersedes=b["policy_version"],
        )
        # save_policy opens and commits its own real BEGIN IMMEDIATE before
        # the original Admin request reaches its own real save transaction.
        v8_repo.save_policy(competing)
        committed["id"], committed["image"] = competing.policy_version, database_image(local.path)
        return candidate

    monkeypatch.setattr(main, "build_portfolio_policy", competing_commit)
    response = local.client.post(POLICY_PATH, headers=admin_headers(),
                                 json=payload("Original request cannot auto-rebase", NOW + timedelta(hours=2)))
    assert response.status_code == 409, response.text
    assert database_image(local.path) == committed["image"]
    assert policy_rows(local.path)[:2] == before
    assert [row["policy_version"] for row in policy_rows(local.path)] == [a["policy_version"], b["policy_version"], committed["id"]]


def test_bootstrap_unknown_after_real_commit_propagates_without_automatic_rewrite(local, monkeypatch):
    actual_save = v8_repo.save_policy
    calls = []
    committed = {}

    def commit_then_lose_response(policy, **kwargs):
        calls.append(policy.policy_version)
        actual_save(policy, **kwargs)
        committed["image"] = database_image(local.path)
        raise sqlite3.OperationalError("synthetic response loss after actual Policy commit")

    monkeypatch.setattr(v8_repo, "save_policy", commit_then_lose_response)
    with pytest.raises(sqlite3.OperationalError, match="after actual Policy commit"):
        v8_repo.ensure_default_policy()
    assert len(calls) == 1
    assert database_image(local.path) == committed["image"]
    assert len(policy_rows(local.path)) == 1
    # A later independent bootstrap reads the committed tip. It does not turn
    # the original unknown return into success or invoke the save again.
    assert v8_repo.ensure_default_policy().policy_version == calls[0]
    assert len(calls) == 1 and database_image(local.path) == committed["image"]


def test_empty_bootstrap_losing_to_real_admin_root_only_reads_the_known_competing_tip(local, monkeypatch):
    actual_save = v8_repo.save_policy
    calls = []
    competitor = decision_v2.build_portfolio_policy(
        name="Actual Admin root wins empty bootstrap race", source="admin",
        effective_at=NOW - timedelta(hours=1), created_at=NOW,
        max_single_fund_weight=30,
    )
    committed = {}

    def competing_root_before_default_insert(policy, **kwargs):
        calls.append(policy.policy_version)
        actual_save(competitor)
        committed["image"] = database_image(local.path)
        # The default insert is rejected by the real in-transaction chain
        # check, not by an injected exception or fabricated successful result.
        return actual_save(policy, **kwargs)

    monkeypatch.setattr(v8_repo, "save_policy", competing_root_before_default_insert)
    assert v8_repo.ensure_default_policy().policy_version == competitor.policy_version
    assert len(calls) == 1
    assert database_image(local.path) == committed["image"]
    assert [row["source"] for row in policy_rows(local.path)] == ["admin"]


def json_bytes(value):
    # Raw Owner source uses native number spellings, not V8's canonical-zero
    # model identity contract. Preserve int/float/-0.0 in the sealed envelope.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sealed_fixture(path):
    match = re.search(r'^const raw = ("(?:[^"\\]|\\.)*")\r?$', path.read_text(encoding="utf-8"), re.MULTILINE)
    assert match is not None, "Fixture must retain its original JSON string envelope"
    return json.loads(json.loads(match.group(1)))


def capture_admin_policy_fixture(path):
    """Rebuild A/B/C wire through actual main HTTP and an independent database."""
    at = datetime(2026, 10, 26, 0, 0, tzinfo=timezone.utc)
    start = at + timedelta(minutes=1)
    with pytest.MonkeyPatch.context() as monkeypatch:
        with local_database(path, monkeypatch, owners.hash_owner_password(PASSWORD)) as active:
            active.clock.now = start
            auth = owner_headers(active)
            policies = {
                "a": publish(active, "Synthetic Admin lifecycle A", at),
                "b": publish(active, "Synthetic Admin lifecycle B", start + timedelta(seconds=20), rebalance_band=0),
                "c": publish(active, "Synthetic Admin lifecycle C", start + timedelta(seconds=40), max_single_fund_weight=30),
            }
            detail = {
                "code": "510300", "name": "synthetic private analysis fund", "type": "指数型",
                "latest_nav": 1.5, "latest_nav_date": at.date().isoformat(),
                "source": "analysis-v6-http-fixture", "updated_at": at.isoformat(),
                "decision_context": {"status": "unavailable", "source": "analysis-v6-http-fixture"},
            }
            evidence = v8_repo.save_evidence(decision_v2.build_evidence_snapshot(
                detail, {"score": 82, "score_version": "analysis-v6-http-fixture", "coverage": 1.0},
                {"signal": "持有", "signal_version": "analysis-v6-http-fixture", "coverage": 1.0,
                 "layers": {"valuation": {"percentile": 20}, "trend": {"label": "上升趋势"}}},
                {"available": False}, created_at=at,
            ))
            key, cash, deleted = "510300::synthetic-account", "asset:synthetic-v6-cash", "asset:synthetic-v6-deleted"
            batches = [
                {"request_id": "analysis-v6-seed-0001", "expected_revision": 0, "operations": [
                    {"key": key, "kind": "holding", "deleted": False,
                     "changes": {"name": "synthetic private analysis fund", "shares": 10, "cost": 1, "target_weight": 20}},
                    {"key": deleted, "kind": "manual_asset", "deleted": False,
                     "changes": {"name": "retired synthetic cash", "cls": "现金", "value": 0, "note": None}},
                ]},
                {"request_id": "analysis-v6-manual-0002", "expected_revision": 1, "operations": [
                    {"key": cash, "kind": "manual_asset", "deleted": False,
                     "changes": {"name": "synthetic v6 cash", "cls": "现金", "value": -0.0, "note": None}},
                    {"key": deleted, "kind": "manual_asset", "deleted": True,
                     "base_values": {"kind": "manual_asset", "deleted": False, "name": "retired synthetic cash",
                                     "cls": "现金", "value": 0, "note": None}},
                ]},
                {"request_id": "analysis-v6-refresh-0003", "expected_revision": 2, "operations": [
                    {"key": cash, "kind": "manual_asset", "deleted": False,
                     "changes": {"note": "refreshed note"},
                     "base_values": {"kind": "manual_asset", "deleted": False, "note": None}},
                ]},
            ]
            for revision, batch in enumerate(batches, 1):
                response = active.client.post("/api/v2/owner/sync", json=batch,
                                              headers={**auth, "X-Owner-Sync-Consent": "owner-sync-v1"})
                assert response.status_code == 200, response.text
                assert response.json()["revision"] == revision
            pages = []
            for upper in (2, 3):
                response = active.client.get("/api/v2/owner/sync", headers=auth,
                                             params={"since_revision": 0, "upper_revision": upper, "limit": 200})
                assert response.status_code == 200, response.text
                page = response.json()
                assert page["complete"] is True and page["next_cursor"] is None
                assert page["upper_revision"] == upper
                pages.append((response.text, page))

            def fold(page):
                records = {row["key"]: row for row in page["changes"]}
                return sorted(records.values(), key=lambda row: row["key"])

            stages = []
            for index, label in enumerate(("a", "b", "c")):
                active.clock.now = start + timedelta(seconds=index * 20)
                state = active.client.get(STATE_PATH, headers=auth)
                assert state.status_code == 200, state.text
                assert state.json()["current"] == policies[label]
                prior = {}
                for previous in stages:
                    receipt = active.client.get(ANALYSIS_PATH + "/requests/" + previous["request"]["request_id"],
                                                headers={**auth, "X-Owner-Analysis-Request-Hash": previous["requestHash"]})
                    assert receipt.status_code == 200, receipt.text
                    assert receipt.json()["result"] == json.loads(previous["responseRaw"])
                    assert receipt.json()["result"]["run"]["policy"]["policy_version"] != policies[label]["policy_version"]
                    prior[previous["key"]] = receipt.text
                request = {"request_id": f"admin-policy-analysis-{label}-000{index + 1}", "expected_revision": 3,
                           "policy_version": policies[label]["policy_version"],
                           "evidence": [{"code": "510300", "evidence_id": evidence.evidence_id}]}
                parsed = parse_owner_analysis_request(json_bytes(request))
                created = active.client.post(ANALYSIS_PATH, content=parsed.canonical_body(),
                                              headers={**auth, "Content-Type": "application/json",
                                                       "X-Owner-Analysis-Consent": "owner-analysis-v1"})
                assert created.status_code == 200, created.text
                assert created.json()["source_current"] is True
                assert created.json()["run"]["policy"] == policies[label]
                receipt = active.client.get(ANALYSIS_PATH + "/requests/" + request["request_id"],
                                            headers={**auth, "X-Owner-Analysis-Request-Hash": parsed.request_hash()})
                assert receipt.status_code == 200 and receipt.json()["result"] == created.json()
                stages.append({"key": label, "now": active.clock.now.isoformat().replace("+00:00", "Z"),
                               "policyStateRaw": state.text, "request": request,
                               "rawBody": parsed.canonical_body(), "requestHash": parsed.request_hash(),
                               "responseRaw": created.text, "receiptRaw": receipt.text, "priorReceipts": prior})

            return {"at": at.isoformat().replace("+00:00", "Z"),
                    "now": start.isoformat().replace("+00:00", "Z"),
                    "policies": policies, "evidence": canonical_json(evidence),
                    "initialRecords": fold(pages[0][1]), "currentRecords": fold(pages[1][1]),
                    "changesHistory": pages[1][1]["changes"],
                    "initialChangesRaw": pages[0][0], "currentChangesRaw": pages[1][0], "stages": stages}


def test_admin_policy_frontend_fixture_is_rebuilt_from_independent_actual_http_and_sqlite(tmp_path):
    captured = capture_admin_policy_fixture(tmp_path / "admin-policy-capture.sqlite3")
    assert json_bytes(captured) == json_bytes(sealed_fixture(FRONTEND))
    assert json_bytes(capture_admin_policy_fixture(tmp_path / "admin-policy-independent.sqlite3")) == json_bytes(captured)


def test_admin_policy_fixture_reuses_the_exact_complete_v6_source_and_original_service_hash():
    captured, original = sealed_fixture(FRONTEND), sealed_fixture(V6_FRONTEND)
    for field in ("initialRecords", "currentRecords", "changesHistory", "evidence"):
        assert json_bytes(captured[field]) == json_bytes(original[field])
    for field in ("initialChangesRaw", "currentChangesRaw"):
        assert json_bytes(json.loads(captured[field])) == json_bytes(json.loads(original[field]))
    source = json.loads(original["response"])["run"]["source"]
    assert len(captured["currentRecords"]) == 3 and len(captured["changesHistory"]) == 5
    for index, stage in enumerate(captured["stages"]):
        assert stage["key"] == "abc"[index]
        assert json.loads(stage["responseRaw"])["run"]["source"] == source
        state = json.loads(stage["policyStateRaw"])
        assert state["current"] == captured["policies"][stage["key"]]
        assert state["history"] == [captured["policies"][key] for key in ("c", "b", "a")]
        assert set(stage["priorReceipts"]) == set("abc"[:index])


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="fc-admin-policy-lifecycle-") as directory:
        result = capture_admin_policy_fixture(Path(directory) / "explicit.sqlite3")
        print("FC_ADMIN_POLICY_FIXTURE_BEGIN")
        # ASCII transport avoids Windows stdout encoding loss; decoded strings
        # retain all original HTTP bytes and original service-generated hashes.
        print(json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False))
        print("FC_ADMIN_POLICY_FIXTURE_END")
