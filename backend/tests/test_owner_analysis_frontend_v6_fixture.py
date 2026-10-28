"""Rebuild the independent v6 frontend fixture through real local repositories.

Only the UTC clock and explicitly selected temporary SQLite path are fixed.
Sync parsing/stamping/history, source capture/SHA, actual Holding/Decision
creation and original receipt reconciliation are the production implementations.
No network, credential, cloud migration or remote durability claim is made.
"""
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import tempfile

import pytest

from database import db
from database.owner_analysis_schema import provision_owner_analysis_candidate
from database.owner_sync_schema import provision_owner_sync_candidate
from models.owner_analysis import parse_owner_analysis_request
from models.v8 import canonical_json
from service import owner_analysis_repo as analysis, owner_sync_repo as sync, v8_repo
from strategy.decision_v2 import build_evidence_snapshot, build_portfolio_policy


AT = datetime(2026, 10, 26, 0, 0, tzinfo=timezone.utc)
NOW = datetime(2026, 10, 26, 0, 1, tzinfo=timezone.utc)
KEY = "510300::synthetic-account"
CASH = "asset:synthetic-v6-cash"
DELETED = "asset:synthetic-v6-deleted"
REQUEST_ID = "analysis-v6-http-0001"
FRONTEND = Path(__file__).resolve().parents[2] / "frontend/src/utils/owner-analysis-v6-contract.fixtures.ts"


def _json(value):
    # The sync source preserves native numeric spellings, including -0.0.
    # Do not apply the distinct V8 business canonical-zero contract here.
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def _connect(path):
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _fold(page):
    assert page["complete"] is True and page["next_cursor"] is None
    rows = {}
    for row in page["changes"]:
        rows[row["key"]] = row
    return sorted(rows.values(), key=lambda row: row["key"])


def capture_v6_fixture(path):
    """Purely local reproducible capture; each call owns a fresh real database."""
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
        monkeypatch.setattr(db, "DB_PATH", str(path))
        actual_clock = analysis._clock
        monkeypatch.setattr(analysis, "_clock", lambda stamp=None: actual_clock(stamp or NOW))
        db.init_db()
        with closing(_connect(path)) as connection:
            provision_owner_sync_candidate(connection, synthetic_candidate=True)
            provision_owner_analysis_candidate(connection, synthetic_candidate=True)

        detail = {
            "code": "510300", "name": "synthetic private analysis fund", "type": "指数型",
            "latest_nav": 1.5, "latest_nav_date": AT.date().isoformat(),
            "source": "analysis-v6-http-fixture", "updated_at": AT.isoformat(),
            "decision_context": {"status": "unavailable", "source": "analysis-v6-http-fixture"},
        }
        evidence = v8_repo.save_evidence(build_evidence_snapshot(
            detail, {"score": 82, "score_version": "analysis-v6-http-fixture", "coverage": 1.0},
            {"signal": "持有", "signal_version": "analysis-v6-http-fixture", "coverage": 1.0,
             "layers": {"valuation": {"percentile": 20}, "trend": {"label": "上升趋势"}}},
            {"available": False}, created_at=AT,
        ))
        policy = v8_repo.save_policy(build_portfolio_policy(
            name="Synthetic v6 analysis guardrails", target_allocations={"510300": 20},
            max_single_fund_weight=40, rebalance_band=2, effective_at=AT,
            source="analysis-v6-http-fixture", created_at=AT,
        ))

        batches = [
            {"request_id": "analysis-v6-seed-0001", "expected_revision": 0, "operations": [
                {"key": KEY, "kind": "holding", "deleted": False,
                 "changes": {"name": "synthetic private analysis fund", "shares": 10,
                             "cost": 1, "target_weight": 20}},
                {"key": DELETED, "kind": "manual_asset", "deleted": False,
                 "changes": {"name": "retired synthetic cash", "cls": "现金", "value": 0, "note": None}},
            ]},
            {"request_id": "analysis-v6-manual-0002", "expected_revision": 1, "operations": [
                {"key": CASH, "kind": "manual_asset", "deleted": False,
                 "changes": {"name": "synthetic v6 cash", "cls": "现金", "value": -0.0, "note": None}},
                {"key": DELETED, "kind": "manual_asset", "deleted": True,
                 "base_values": {"kind": "manual_asset", "deleted": False,
                                 "name": "retired synthetic cash", "cls": "现金", "value": 0, "note": None}},
            ]},
            {"request_id": "analysis-v6-refresh-0003", "expected_revision": 2, "operations": [
                {"key": CASH, "kind": "manual_asset", "deleted": False,
                 "changes": {"note": "refreshed note"},
                 "base_values": {"kind": "manual_asset", "deleted": False, "note": None}},
            ]},
        ]
        with closing(_connect(path)) as connection:
            for revision, batch in enumerate(batches, 1):
                applied = sync.apply_sync_local(connection, _json(batch))
                assert applied.status == 200, applied.body
                assert applied.body["revision"] == revision
            initial = sync.read_sync_changes(connection, since_revision=0, upper_revision=2, limit=200)
            current = sync.read_sync_changes(connection, since_revision=0, upper_revision=3, limit=200)

        request = {"request_id": REQUEST_ID, "expected_revision": 3,
                   "policy_version": policy.policy_version,
                   "evidence": [{"code": "510300", "evidence_id": evidence.evidence_id}]}
        parsed = parse_owner_analysis_request(_json(request))
        with closing(_connect(path)) as connection:
            created = analysis.create_analysis_local(connection, parsed.canonical_body())
            assert created.status == 200, created.body
            original = connection.execute(
                "SELECT source_json,source_hash,response_json FROM owner_analysis_runs WHERE request_id=?",
                (REQUEST_ID,),
            ).fetchone()
            assert original is not None
            # Verify against the actual stored original source, never a frontend
            # reconstruction of JSON numbers or a replacement source digest.
            source = json.loads(original["source_json"])
            assert source["schema"] == "owner-analysis-source-1"
            assert source["revision"] == 3 and source["records"] == _fold(current)
            assert hashlib.sha256(original["source_json"].encode("utf-8")).hexdigest() == original["source_hash"]
            assert created.body["run"]["source"]["sha256"] == original["source_hash"]
            assert json.loads(original["response_json"]) == created.body["run"]
            receipt = analysis.reconcile_analysis_local(connection, REQUEST_ID, parsed.request_hash())
            assert receipt.state == "matched" and receipt.result == created

        return {
            "at": AT.isoformat().replace("+00:00", "Z"),
            "now": NOW.isoformat().replace("+00:00", "Z"),
            "request": request, "rawBody": parsed.canonical_body(), "requestHash": parsed.request_hash(),
            "response": _json(created.body), "policy": canonical_json(policy), "evidence": canonical_json(evidence),
            "initialRecords": _fold(initial), "currentRecords": _fold(current),
            "changesHistory": current["changes"],
            "initialChangesRaw": _json(initial), "currentChangesRaw": _json(current),
        }


def _sealed_frontend_fixture():
    match = re.search(r'^const raw = ("(?:[^"\\]|\\.)*")\r?$', FRONTEND.read_text(encoding="utf-8"), re.MULTILINE)
    assert match is not None, "Frontend fixture must retain its original JSON string envelope"
    return json.loads(json.loads(match.group(1)))


def test_actual_sqlite_v6_analysis_rebuilds_the_exact_sealed_frontend_bytes(tmp_path):
    captured = capture_v6_fixture(tmp_path / "v6-original.sqlite3")
    sealed = _sealed_frontend_fixture()
    assert _json(captured) == _json(sealed)
    assert capture_v6_fixture(tmp_path / "v6-independent-rebuild.sqlite3") == captured


def test_sealed_fixture_keeps_real_history_tombstone_zero_and_original_source_count(tmp_path):
    captured = capture_v6_fixture(tmp_path / "v6-source.sqlite3")
    initial = captured["initialRecords"]
    current = captured["currentRecords"]
    assert len(initial) == len(current) == 3
    assert [row["record_revision"] for row in captured["changesHistory"]] == [1, 1, 2, 2, 3]
    assert sum(row["deleted"] for row in current) == 1
    before = next(row for row in initial if row["key"] == CASH)
    after = next(row for row in current if row["key"] == CASH)
    assert before["values"]["note"] is None and after["values"]["note"] == "refreshed note"
    assert after["field_revisions"] == {"name": 2, "cls": 2, "value": 2, "note": 3}
    assert type(after["values"]["value"]) is float and math.copysign(1, after["values"]["value"]) == -1
    body = json.loads(captured["response"])
    assert body["source_current"] is True
    assert body["run"]["source"]["revision"] == 3
    assert body["run"]["source"]["record_count"] == len(current)
    assert body["run"]["source"]["scope"] == "fund_only"
    assert [item["code"] for item in body["run"]["components"]] == ["510300"]
    assert body["run"]["components"][0]["account_count"] == 1


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="fc-v6-analysis-fixture-") as directory:
        value = capture_v6_fixture(Path(directory) / "explicit.sqlite3")
        print("FC_V6_FIXTURE_BEGIN")
        # stdout may use a legacy Windows codepage. ASCII JSON escapes retain
        # the original Unicode bytes after decoding without changing source
        # numeric spellings, response contents or service-generated digests.
        print(json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False))
        print("FC_V6_FIXTURE_END")
