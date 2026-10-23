"""Actual synthetic SQLite source -> business rows, not cloud qualification."""
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from types import SimpleNamespace

import pytest

from database import db
from database.owner_analysis_schema import provision_owner_analysis_candidate
from database.owner_sync_schema import provision_owner_sync_candidate
from models.owner_analysis import parse_owner_analysis_request
from models.v8 import DecisionSnapshot, HoldingVersion, stable_id
from service import owner_analysis_repo as repo, owner_sync_repo as sync, v8_repo
from strategy.decision_v2 import build_evidence_snapshot, build_portfolio_policy


TABLES = ("holding_versions", "decision_snapshots", "v8_record_scopes", "v8_repository_scopes",
          "owner_analysis_runs", "owner_analysis_components", "owner_sync_records", "owner_sync_changes",
          "owner_sync_receipts", "evidence_snapshots", "portfolio_policy_versions")


def connect(path, *, factory=sqlite3.Connection):
    conn = sqlite3.connect(path, factory=factory)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def image(path):
    conn = connect(path)
    try:
        return {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                for table in TABLES}
    finally:
        conn.close()


def evidence(code, stamp, *, nav=1.5, status="live"):
    model = build_evidence_snapshot(
        {"code": code, "name": "合成基金" + code, "type": "指数型",
         "latest_nav": nav, "latest_nav_date": stamp.astimezone(timezone(timedelta(hours=8))).date().isoformat(),
         "source": "owner-analysis-repo-fixture", "updated_at": stamp.isoformat(),
         "decision_context": {"status": "unavailable", "source": "owner-analysis-repo-fixture"}},
        {"score": 82, "score_version": "owner-analysis-repo-fixture", "coverage": 1.0},
        {"signal": "买入", "signal_version": "owner-analysis-repo-fixture", "coverage": 1.0,
         "layers": {"valuation": {"percentile": 20}, "trend": {"label": "上升趋势"}}},
        {"available": False}, created_at=stamp,
    ).model_copy(update={"estimate_status": status})
    model = model.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(model))})
    return v8_repo.save_evidence(model)


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    path = tmp_path / "owner-analysis-repo.sqlite3"
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    with connect(path) as conn:
        provision_owner_sync_candidate(conn, synthetic_candidate=True)
        provision_owner_analysis_candidate(conn, synthetic_candidate=True)
    at = datetime.now(timezone.utc) - timedelta(hours=1)
    proofs = {code: evidence(code, at, nav=nav) for code, nav in
              (("510300", 1.5), ("000001", 2.0), ("000009", 1.0))}
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="合成基金组合策略", target_allocations={"510300": 60, "000001": 40},
        max_single_fund_weight=50, rebalance_band=2, effective_at=at,
        source="owner-analysis-repo-fixture", created_at=at,
    ))
    positions = [
        ("510300::A", "holding", {"name": "合成A", "shares": 10, "cost": 1, "target_weight": 20}),
        ("510300::B", "holding", {"name": "合成B", "shares": 20, "cost": 2, "target_weight": 40}),
        ("000001::C", "holding", {"name": "合成C", "shares": 15, "cost": None, "target_weight": 40}),
        ("000009::关注", "watch", {"name": "合成关注"}),
        ("asset:cash", "manual_asset", {"name": "合成现金", "cls": "现金", "value": 1000, "note": None}),
        ("000011::旧关注", "watch", {"name": "合成删除历史"}),
    ]
    with connect(path) as conn:
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "analysis-repo-seed-0001",
            "expected_revision": 0, "operations": [{"key": key, "kind": kind, "deleted": False, "changes": values}
                                                    for key, kind, values in positions]}, ensure_ascii=False))
        assert result.status == 200
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "analysis-repo-delete-0001",
            "expected_revision": 1, "operations": [{"key": "000011::旧关注", "kind": "watch", "deleted": True,
                "base_values": {"kind": "watch", "deleted": False, "name": "合成删除历史",
                                "shares": None, "cost": None, "target_weight": None}}]}, ensure_ascii=False))
        assert result.status == 200 and result.body["revision"] == 2
    request = {"request_id": "analysis-repo-run-0001", "expected_revision": 2,
               "policy_version": policy.policy_version,
               "evidence": [{"code": code, "evidence_id": value.evidence_id} for code, value in sorted(proofs.items())]}
    return SimpleNamespace(path=path, request=request, policy=policy, proofs=proofs, at=at)


def raw(f, **updates):
    return json.dumps({**f.request, **updates}, ensure_ascii=False)


def write(f, **updates):
    conn = connect(f.path)
    try:
        return repo.create_analysis_local(conn, raw(f, **updates))
    finally:
        conn.close()


def receipt(f, request=None):
    request = request or f.request
    conn = connect(f.path)
    try:
        parsed = parse_owner_analysis_request(json.dumps(request))
        return repo.reconcile_analysis_local(conn, parsed.request_id, parsed.request_hash())
    finally:
        conn.close()


def test_actual_complete_source_projects_accounts_and_links_real_models_atomically(fixture, monkeypatch):
    f = fixture
    before = image(f.path)
    # No global connection or transaction is permitted in this actual writer.
    monkeypatch.setattr(db, "get_conn", lambda: pytest.fail("analysis opened a global connection"))
    monkeypatch.setattr(db, "transaction", lambda **_kwargs: pytest.fail("analysis started a second transaction"))
    result = write(f)
    assert result.status == 200, result.body
    run = result.body["run"]
    assert result.body["source_current"] is True and run["source"]["revision"] == 2
    assert run["source"]["scope"] == "fund_only" and run["source"]["record_count"] == 6
    rows = {row["code"]: row for row in run["components"]}
    a, b, watch = (rows[code]["holding"] for code in ("510300", "000001", "000009"))
    assert a["shares"] == 30 and a["cost"] == pytest.approx(5 / 3)
    assert a["market_value"] == 45 and a["current_weight"] == 60 and a["target_weight"] == 60
    assert b["shares"] == 15 and b["cost"] is None and b["market_value"] == 30 and b["current_weight"] == 40
    assert rows["510300"]["account_count"] == 2
    assert watch["user_state"] == "unheld" and watch["shares"] is None
    assert all(row["holding"]["updated_at"] is None for row in rows.values())
    after = image(f.path)
    assert len(after["owner_analysis_runs"]) == 1 and len(after["owner_analysis_components"]) == 3
    for table in ("owner_sync_records", "owner_sync_changes", "owner_sync_receipts", "portfolio_policy_versions", "evidence_snapshots"):
        assert after[table] == before[table]
    with connect(f.path) as conn:
        saved_source = json.loads(conn.execute("SELECT source_json FROM owner_analysis_runs").fetchone()[0])
        assert any(row["kind"] == "manual_asset" and row["values"]["value"] == 1000 for row in saved_source["records"])
        assert any(row["key"] == "000011::旧关注" and row["deleted"] for row in saved_source["records"])
        for component in conn.execute("SELECT * FROM owner_analysis_components"):
            holding = HoldingVersion.model_validate_json(conn.execute("SELECT payload_json FROM holding_versions WHERE holding_version=?",
                (component["holding_version"],)).fetchone()[0])
            decision = DecisionSnapshot.model_validate_json(conn.execute("SELECT payload_json FROM decision_snapshots WHERE decision_id=?",
                (component["decision_id"],)).fetchone()[0])
            assert holding.source == run["run_id"]
            assert decision.holding_version == holding.holding_version and decision.evidence_id == component["evidence_id"]
            assert decision.policy_version == f.policy.policy_version and decision.strategy_version == repo.ANALYSIS_STRATEGY_VERSION
    assert write(f).body == result.body and image(f.path) == after
    assert receipt(f).result.body == result.body


@pytest.mark.parametrize("position", range(1, 17))
def test_every_actual_insert_fault_rolls_back_the_entire_chain(fixture, position):
    f = fixture
    before = image(f.path)
    class Fault(sqlite3.Connection):
        inserts = 0
        hit = False
        def execute(self, sql, parameters=()):
            result = super().execute(sql, parameters)
            if sql.startswith("INSERT INTO "):
                self.inserts += 1
                if self.inserts == position:
                    self.hit = True
                    raise sqlite3.OperationalError("synthetic fault after actual INSERT")
            return result
    conn = connect(f.path, factory=Fault)
    try:
        with pytest.raises(sqlite3.OperationalError, match="synthetic fault"):
            repo.create_analysis_local(conn, raw(f))
        assert conn.hit and not conn.in_transaction
    finally:
        conn.close()
    assert image(f.path) == before
    assert receipt(f).state == "absent"


def test_real_commit_with_lost_response_has_only_an_original_receipt_not_a_second_write(fixture):
    f = fixture
    class Lost(sqlite3.Connection):
        def commit(self):
            super().commit()
            raise sqlite3.OperationalError("synthetic response lost after actual COMMIT")
    conn = connect(f.path, factory=Lost)
    try:
        with pytest.raises(sqlite3.OperationalError, match="actual COMMIT"):
            repo.create_analysis_local(conn, raw(f))
    finally:
        conn.close()
    after = image(f.path)
    assert len(after["owner_analysis_runs"]) == 1
    found = receipt(f)
    assert found.state == "matched" and found.result.body["source_current"] is True
    assert image(f.path) == after


@pytest.mark.parametrize("stage", ["early", "after_run_insert"])
def test_authority_failure_propagates_and_rolls_back_even_inside_source_or_receipt_work(fixture, stage):
    f = fixture
    before = image(f.path)
    conn = connect(f.path)
    calls = 0
    class Revoked(Exception):
        pass
    def guard():
        nonlocal calls
        calls += 1
        if (stage == "early" and calls == 5 or stage == "after_run_insert"
                and conn.execute("SELECT COUNT(*) FROM owner_analysis_runs").fetchone()[0]):
            raise Revoked("synthetic authority revoked")
    try:
        with pytest.raises(Revoked):
            repo.create_analysis_local(conn, raw(f), before_commit=guard)
        assert not conn.in_transaction
    finally:
        conn.close()
    assert image(f.path) == before


def test_authorization_callback_cannot_push_the_final_commit_beyond_the_original_budget(fixture, monkeypatch):
    f = fixture
    before = image(f.path)
    elapsed = [0.0]
    monkeypatch.setattr(repo, "time", SimpleNamespace(monotonic=lambda: elapsed[0]))
    conn = connect(f.path)
    def slow_guard():
        if conn.execute("SELECT COUNT(*) FROM owner_analysis_runs").fetchone()[0]:
            elapsed[0] = 31.0
    try:
        result = repo.create_analysis_local(conn, raw(f), before_commit=slow_guard)
        assert result.status == 503 and result.body["error"]["code"] == "analysis_timeout"
        assert not conn.in_transaction
    finally:
        conn.close()
    assert image(f.path) == before


def test_unavailable_estimates_generate_valid_neutral_snapshots_and_matching_action_codes(fixture):
    f = fixture
    missing = evidence("510300", f.at, status="unavailable")
    request = {**f.request, "evidence": [{"code": item["code"], "evidence_id": missing.evidence_id}
        if item["code"] == "510300" else item for item in f.request["evidence"]]}
    conn = connect(f.path)
    try:
        result = repo.create_analysis_local(conn, json.dumps(request))
    finally:
        conn.close()
    assert result.status == 200, result.body
    row = next(row for row in result.body["run"]["components"] if row["code"] == "510300")
    assert row["decision"]["action"] == "hold"
    assert row["decision"]["reason_codes"][0] == "ACTION_HOLD"
    assert row["decision"]["position_guidance"] is None
    assert "OWNER_INPUTS_INCOMPLETE" in row["decision"]["reason_codes"]
    assert receipt(f, request).state == "matched"


def test_manual_change_invalidates_complete_source_without_overwriting_historical_models(fixture):
    f = fixture
    original = write(f)
    before = image(f.path)
    with connect(f.path) as conn:
        changed = sync.apply_sync_local(conn, json.dumps({"request_id": "analysis-repo-cash-change",
            "expected_revision": 2, "operations": [{"key": "asset:cash", "kind": "manual_asset", "deleted": False,
                "changes": {"value": 1200}, "base_values": {"kind": "manual_asset", "deleted": False, "value": 1000}}]}))
        assert changed.status == 200 and changed.body["revision"] == 3
    found = receipt(f)
    assert found.state == "matched" and found.result.body["source_current"] is False
    assert found.result.body["run"] == original.body["run"]
    repeated = write(f)
    assert repeated.status == 200 and repeated.body == found.result.body
    stale = write(f, request_id="analysis-repo-stale-new")
    assert stale.status == 409 and stale.body["error"]["code"] == "analysis_source_conflict"
    for table in ("holding_versions", "decision_snapshots", "owner_analysis_runs", "owner_analysis_components"):
        assert image(f.path)[table] == before[table]


def test_request_id_cannot_be_reused_for_another_revision_or_subset_of_the_source(fixture):
    f = fixture
    assert write(f).status == 200
    before = image(f.path)
    conflict = write(f, expected_revision=1)
    assert conflict.status == 409 and conflict.body["error"]["code"] == "analysis_idempotency_conflict"
    subset = write(f, request_id="analysis-repo-subset-new", evidence=f.request["evidence"][:-1])
    assert subset.status == 409 and subset.body["error"]["code"] == "analysis_source_conflict"
    assert image(f.path) == before


def test_a_missing_current_tombstone_is_not_an_empty_or_partial_source(fixture):
    f = fixture
    with connect(f.path) as conn:
        conn.execute("DELETE FROM owner_sync_records WHERE sync_key=?", ("000011::旧关注",))
    before = image(f.path)
    result = write(f)
    assert result.status == 503 and result.body["error"]["code"] == "analysis_source_unavailable"
    assert image(f.path) == before


def test_persisted_history_does_not_require_reexecuting_the_current_strategy(fixture, monkeypatch):
    f = fixture
    result = write(f)
    assert result.status == 200
    monkeypatch.setattr(repo, "ANALYSIS_STRATEGY_VERSION", "future-rules+owner-sync-1")
    monkeypatch.setattr(repo, "build_decision_snapshot", lambda *_args, **_kwargs: pytest.fail("reexecuted current strategy"))
    found = receipt(f)
    assert found.state == "matched"
    assert found.result.body["run"] == result.body["run"]


def test_invalid_raw_request_never_requires_a_connection():
    assert repo.create_analysis_local(None, '{"expected_revision":true}').status == 422


def change_positions(f, changes):
    with connect(f.path) as conn:
        head = sync._head(conn)
        operations = []
        for key, values in changes.items():
            prior = sync._record(conn, key, head)
            operations.append({"key": key, "kind": prior["kind"], "deleted": prior["deleted"],
                "changes": values, "base_values": {"kind": prior["kind"], "deleted": prior["deleted"],
                    **{name: prior["values"][name] for name in values}}})
        result = sync.apply_sync_local(conn, json.dumps({"request_id": "analysis-repo-fixture-change",
            "expected_revision": head, "operations": operations}))
        assert result.status == 200
        return result.body["revision"]


def test_actual_unknown_shares_invalidate_every_fund_weight_and_neutralize_actions(fixture):
    f = fixture
    revision = change_positions(f, {"000001::C": {"shares": None}})
    request = {**f.request, "expected_revision": revision}
    result = write(f, expected_revision=revision)
    assert result.status == 200, result.body
    run = result.body["run"]
    assert run["pricing_complete"] is False and run["unavailable_codes"] == ["000001"]
    components = {row["code"]: row for row in run["components"]}
    assert components["000001"]["holding"]["shares"] is None
    assert components["000001"]["holding"]["market_value"] is None
    assert components["510300"]["holding"]["market_value"] == 45
    for row in components.values():
        assert row["holding"]["current_weight"] is None
        assert row["decision"]["position_guidance"] is None
        assert row["decision"]["action"] == ("hold" if row["account_count"] else "watch")
        assert "OWNER_INPUTS_INCOMPLETE" in row["decision"]["reason_codes"]
    assert receipt(f, request).result.body == result.body


def test_actual_zero_shares_are_held_and_raw_source_keeps_native_negative_zero(fixture):
    f = fixture
    revision = change_positions(f, {"510300::A": {"shares": 0}, "510300::B": {"shares": -0.0},
                                    "000001::C": {"shares": 0}})
    result = write(f, expected_revision=revision)
    assert result.status == 200, result.body
    assert result.body["run"]["pricing_complete"] is True
    for row in result.body["run"]["components"]:
        holding = row["holding"]
        if row["account_count"]:
            assert holding["user_state"] == "held"
            assert holding["shares"] == 0 and holding["cost"] is None
            assert holding["market_value"] == 0 and holding["current_weight"] == 0
        else:
            assert holding["user_state"] == "unheld" and holding["shares"] is None
    with connect(f.path) as conn:
        source = conn.execute("SELECT source_json FROM owner_analysis_runs").fetchone()[0]
        assert '"shares":-0.0' in source and '"shares":0' in source


@pytest.mark.parametrize("stage", ["new", "replay", "receipt"])
def test_commit_finishing_after_budget_is_unknown_but_original_receipt_survives(fixture, monkeypatch, stage):
    f = fixture
    if stage != "new":
        assert write(f).status == 200
    elapsed = [0.0]
    monkeypatch.setattr(repo, "time", SimpleNamespace(monotonic=lambda: elapsed[0]))
    class SlowCommit(sqlite3.Connection):
        def commit(self):
            super().commit()
            elapsed[0] = 31.0
    conn = connect(f.path, factory=SlowCommit)
    try:
        if stage == "receipt":
            parsed = parse_owner_analysis_request(raw(f))
            result = repo.reconcile_analysis_local(conn, parsed.request_id, parsed.request_hash())
            assert result.state == "unavailable"
        else:
            result = repo.create_analysis_local(conn, raw(f))
            assert result.status == 503 and result.body["error"]["code"] == "analysis_timeout"
        assert not conn.in_transaction
    finally:
        conn.close()
    elapsed[0] = 0.0
    found = receipt(f)
    assert found.state == "matched" and found.result.body["run"]["request_id"] == f.request["request_id"]
    assert len(image(f.path)["owner_analysis_runs"]) == 1


def test_connection_with_foreign_keys_disabled_is_rejected_without_repair(fixture):
    f = fixture
    before = image(f.path)
    conn = connect(f.path)
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        result = repo.create_analysis_local(conn, raw(f))
        assert result.status == 503 and result.body["error"]["code"] == "analysis_storage_unavailable"
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 0
    finally:
        conn.close()
    assert image(f.path) == before


@pytest.mark.parametrize("kind", ["policy", "evidence"])
def test_missing_actual_reference_does_not_write_any_partial_business_chain(fixture, kind):
    f = fixture
    before = image(f.path)
    updates = {"policy_version": "pol_" + "f" * 64} if kind == "policy" else {
        "evidence": [{**item, "evidence_id": "ev_" + "f" * 64} if item["code"] == "510300" else item
                     for item in f.request["evidence"]]}
    result = write(f, **updates)
    assert result.status == 409 and result.body["error"]["code"] == "analysis_" + kind + "_unavailable"
    assert image(f.path) == before and receipt(f).state == "absent"


@pytest.mark.parametrize("limit", ["MAX_RUNS", "MAX_COMPONENTS", "MAX_JSON_BYTES"])
def test_actual_capacity_exhaustion_never_purges_or_partially_inserts(fixture, monkeypatch, limit):
    f = fixture
    before = image(f.path)
    monkeypatch.setattr(repo, limit, 0)
    result = write(f)
    assert result.status == 503 and result.body["error"]["code"] == "analysis_capacity_exhausted"
    assert image(f.path) == before


def test_receipt_reads_never_insert_or_provision_and_match_the_original_hash(fixture):
    f = fixture
    result = write(f)
    before = image(f.path)
    statements = []
    conn = connect(f.path)
    conn.set_trace_callback(statements.append)
    parsed = parse_owner_analysis_request(raw(f))
    try:
        assert repo.reconcile_analysis_local(conn, parsed.request_id, parsed.request_hash()).result.body == result.body
        assert repo.reconcile_analysis_local(conn, parsed.request_id, "f" * 64).state == "unavailable"
    finally:
        conn.close()
    assert statements and all(sql.lstrip().upper().startswith(("SELECT", "PRAGMA", "BEGIN", "COMMIT", "ROLLBACK"))
                              for sql in statements)
    assert image(f.path) == before
