import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from service import overseas_evidence
from strategy.decision_v2 import build_evidence_snapshot
from tools.export_v8_overseas_evidence import build_export


NOW = datetime(2026, 8, 24, 6, 30, tzinfo=timezone.utc)


def _artifact(*, observed_at="2026-08-24T14:20:00+08:00"):
    return {
        "schema": 1,
        "source_schema": 2,
        "alignment_version": "observation-target-v2",
        "models": {
            "539002": {
                "code": "539002",
                "prediction_date": "2026-08-24",
                "target_nav_date": "2026-08-21",
                "base_nav_date": "2026-08-20",
                "base_nav": 2.384,
                "predicted_change": -0.1242,
                "predicted_nav": 2.381,
                "coverage": 64.33,
                "model_version": "v1-test",
                "observed_at": observed_at,
                "market_time": "2026-08-21T16:04:47+08:00",
                "status": "pending",
                "alignment_version": "observation-target-v2",
                "sample_count": 7,
                "mae": 1.0,
                "error_p80": 1.401,
                "direction_accuracy": 100.0,
            }
        },
    }


def _write_artifact(tmp_path, monkeypatch, payload):
    path = tmp_path / "overseas-evidence.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setenv("OVERSEAS_EVIDENCE_PATH", str(path))


def test_exporter_keeps_only_exact_audited_rows():
    ledger = json.loads(
        (ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json").read_text(encoding="utf-8")
    )

    exported = build_export(ledger)

    assert exported["schema"] == 1
    assert exported["alignment_version"] == "observation-target-v2"
    assert exported["models"]
    for row in exported["models"].values():
        assert row["base_nav_date"] < row["target_nav_date"] <= row["prediction_date"]
        assert row["alignment_version"] == "observation-target-v2"


def test_loader_fails_closed_when_detail_nav_does_not_match_model_base(tmp_path, monkeypatch):
    _write_artifact(tmp_path, monkeypatch, _artifact())

    rejected = overseas_evidence.resolve_for_detail(
        {"code": "539002", "latest_nav": 2.4, "latest_nav_date": "2026-08-21"}, NOW,
    )

    assert rejected == {
        "usable": False,
        "rejection_reason": "base_nav_mismatch",
        "code": "539002",
    }


def test_qdii_evidence_uses_exact_target_and_accuracy_gates(tmp_path, monkeypatch):
    _write_artifact(tmp_path, monkeypatch, _artifact())
    detail = {
        "code": "539002",
        "name": "测试海外基金",
        "type": "QDII",
        "latest_nav": 2.384,
        "latest_nav_date": "2026-08-20",
        "source": "test",
        "updated_at": "2026-08-25T06:00:00+00:00",
        "decision_context": {
            "status": "fresh",
            "kind": "estimate",
            "source": "worker-live",
            "source_time": "2026-08-24T14:29:00+08:00",
            "source_time_precision": "datetime",
            "market_time": "2026-08-24T14:29:00+08:00",
            "base_nav": 2.384,
            "base_nav_date": "2026-08-20",
            "estimate_change": -0.25,
            "target_nav_date": "2026-08-24",
            "model_version": "v1-test",
            "model_coverage": 82.0,
        },
    }
    model = overseas_evidence.resolve_for_detail(detail, NOW)
    detail["overseas_evidence"] = model
    evidence = build_evidence_snapshot(
        detail,
        {
            "score": 80,
            "score_version": "test",
            "coverage": 1,
            "components": {"risk": {"detail": {"max_drawdown": -10, "volatility": 18}}},
        },
        {
            "signal": "买入",
            "signal_version": "test",
            "coverage": 1,
            "layers": {
                "valuation": {"label": "低估", "percentile": 20, "source": "index_pe_pb"},
                "trend": {"label": "上升趋势"},
                "sentiment": {"label": "中性"},
            },
        },
        {"available": True},
        created_at=NOW,
    )

    assert model["usable"] is True
    assert evidence.target_nav_date.isoformat() == "2026-08-24"
    assert evidence.official_nav_date.isoformat() == "2026-08-20"
    assert evidence.estimate == -0.25
    assert evidence.estimate_sample_count == 7
    assert evidence.estimate_error_p80 == 1.401
    assert evidence.estimate_model_version == "v1-test"
    assert "qdii_low_sample" in evidence.risk_flags
    assert any(source.source_id == "estimate:overseas_accuracy_artifact" for source in evidence.source_states)


def test_old_qdii_artifact_is_stale_not_fresh(tmp_path, monkeypatch):
    _write_artifact(tmp_path, monkeypatch, _artifact())

    model = overseas_evidence.resolve_for_detail(
        {"code": "539002", "latest_nav": 2.384, "latest_nav_date": "2026-08-20"},
        NOW + timedelta(days=4),
    )

    assert model["usable"] is True
    assert model["status"] == "stale"
