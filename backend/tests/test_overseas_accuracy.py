import importlib.util
import datetime as dt
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def load(name):
    path = ROOT / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


accuracy = load("overseas_accuracy")
calibration = load("calibrate_overseas")
audit_module = load("audit_overseas_accuracy")


@pytest.fixture(autouse=True)
def configured_api_base(monkeypatch):
    monkeypatch.setattr(accuracy, "FUND_API_BASE", "https://api.test")


def registry_fixture():
    return {"models": {"012920": {"name": "测试基金", "active": {
        "version": "v1", "label": "测试模型", "min_weight": 50,
        "scale": 1, "bias": 0, "legs": [{"code": "usQQQ", "weight": 100}],
    }}}}


def test_add_predictions_is_daily_idempotent_and_precedes_settlement():
    ledger = {"records": []}
    registry = registry_fixture()
    details = {"012920": {
        "name": "测试基金", "latest_nav": 5, "latest_nav_date": "2026-07-08",
        "nav_history": [{"date": "2026-07-08", "nav": 5}],
    }}
    now = dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST)
    quotes = {"usQQQ": {
        "change": 2, "quote_date": "2026-07-09",
        "quote_time": "2026-07-09 16:00:00", "source": "tencent_quote",
    }}

    assert accuracy.add_predictions(ledger, registry, quotes, details, now) == 1
    assert accuracy.add_predictions(ledger, registry, quotes, details, now) == 0
    row = ledger["records"][0]
    assert row["status"] == "pending"
    assert row["prediction_date"] == "2026-07-10"
    assert row["target_nav_date"] == "2026-07-09"
    assert row["base_nav_date"] == "2026-07-08"
    assert row["predicted_change"] == 2
    assert row["quote_time"] == "2026-07-09 16:00:00"

    assert accuracy.settle_records(ledger, {"012920": {"nav_history": [
        {"date": "2026-07-08", "nav": 5},
        {"date": "2026-07-10", "nav": 5.2},
    ]}}) == 0
    assert accuracy.settle_records(ledger, {"012920": {"nav_history": [
        {"date": "2026-07-08", "nav": 5},
        {"date": "2026-07-09", "nav": 5.1},
    ]}}) == 1
    assert row["status"] == "settled"
    assert row["actual_change"] == 2


def test_add_predictions_skips_weekends():
    ledger = {"records": []}
    now = dt.datetime(2026, 7, 11, 14, 35, tzinfo=accuracy.CST)
    assert accuracy.add_predictions(
        ledger, registry_fixture(), {"usQQQ": 2},
        {"012920": {
            "latest_nav": 5, "latest_nav_date": "2026-07-10",
            "nav_history": [{"date": "2026-07-10", "nav": 5}],
        }}, now,
    ) == 0
    assert ledger["records"] == []


def test_empty_api_secret_has_no_legacy_fallback():
    assert accuracy.normalize_api_base("") == ""
    assert accuracy.normalize_api_base(None) == ""
    assert accuracy.normalize_api_base("https://example.test/") == "https://example.test"


def test_pipeline_requires_explicit_api_base_before_io(monkeypatch):
    monkeypatch.setattr(accuracy, "FUND_API_BASE", "")
    monkeypatch.setattr(accuracy, "REGISTRY", ROOT / "must-not-be-read.json")
    monkeypatch.setattr(accuracy, "request_bytes", lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("network must not be called before API configuration is validated")
    ))

    with pytest.raises(RuntimeError, match="FUND_API_BASE is required"):
        accuracy.run_pipeline()


def test_fetch_quotes_preserves_source_market_date(monkeypatch):
    us_fields = [""] * 33
    us_fields[30] = "2026-07-09 16:00:01"
    us_fields[32] = "2.5"
    cn_fields = [""] * 33
    cn_fields[30] = "20260710143501"
    cn_fields[32] = "-1.0"
    raw = (
        f'v_usQQQ="{"~".join(us_fields)}";'
        f'v_sh000300="{"~".join(cn_fields)}";'
    ).encode("gb18030")
    monkeypatch.setattr(accuracy, "request_bytes", lambda url: raw)
    assert accuracy.fetch_quotes({"usQQQ", "sh000300"}) == {"usQQQ": {
        "change": 2.5,
        "quote_date": "2026-07-09",
        "quote_time": "2026-07-09 16:00:01",
        "source": "tencent_quote",
    }, "sh000300": {
        "change": -1.0,
        "quote_date": "2026-07-10",
        "quote_time": "20260710143501",
        "source": "tencent_quote",
    }}


def test_settle_pairs_exact_nav_date_only():
    ledger = {"records": [{
        "prediction_date": "2026-07-03",
        "code": "012920", "target_nav_date": "2026-07-02", "base_nav": 5.0259,
        "base_nav_date": "2026-07-01",
        "predicted_change": -7.5, "status": "pending",
        "features": {"usQQQ": -7.5},
        "feature_evidence": {"usQQQ": {
            "change": -7.5, "quote_date": "2026-07-02",
            "quote_time": "2026-07-02 16:00:00", "source": "tencent_quote",
        }},
    }, {
        "prediction_date": "2026-07-02",
        "code": "018147", "target_nav_date": "2026-07-01", "base_nav": 2.803,
        "base_nav_date": "2026-06-30",
        "predicted_change": -8, "status": "pending",
        "features": {"usQQQ": -8},
        "feature_evidence": {"usQQQ": {
            "change": -8, "quote_date": "2026-07-01",
            "quote_time": "2026-07-01 16:00:00", "source": "tencent_quote",
        }},
    }]}
    details = {
        "012920": {"nav_history": [
            {"date": "2026-07-01", "nav": 5.0259},
            {"date": "2026-07-02", "nav": 4.6234},
        ]},
        "018147": {"nav_history": [
            {"date": "2026-06-30", "nav": 2.803},
            {"date": "2026-07-02", "nav": 2.464},
        ]},
    }

    assert accuracy.settle_records(ledger, details) == 1
    assert ledger["records"][0]["actual_change"] == -8.0085
    assert ledger["records"][0]["status"] == "settled"
    assert ledger["records"][1]["status"] == "pending"


def test_official_base_requires_top_level_and_history_to_align_strictly():
    valid = {
        "latest_nav": 5, "latest_nav_date": "2026-07-09",
        "nav_history": [{"date": "2026-07-09", "nav": 5}],
    }
    assert accuracy.official_base(valid, "2026-07-10") == ("2026-07-09", 5.0)
    assert accuracy.official_base({**valid, "latest_nav": 5.1}, "2026-07-10") is None
    assert accuracy.official_base(valid, "2026-07-09") is None
    assert accuracy.official_base(valid, "2026-07-20", max_age_days=7) is None


def test_official_base_requires_immediately_previous_trading_date():
    monday = {
        "latest_nav": 5, "latest_nav_date": "2026-07-10",
        "nav_history": [{"date": "2026-07-10", "nav": 5}],
    }
    assert accuracy.official_base(monday, "2026-07-13") == ("2026-07-10", 5.0)

    skipped_workday = {
        "latest_nav": 5, "latest_nav_date": "2026-07-08",
        "nav_history": [{"date": "2026-07-08", "nav": 5}],
    }
    assert accuracy.official_base(skipped_workday, "2026-07-10") is None

    holiday_boundary = {
        "latest_nav": 5, "latest_nav_date": "2026-09-29",
        "nav_history": [{"date": "2026-09-29", "nav": 5}],
    }
    assert accuracy.resolve_prediction_axis(holiday_boundary, "2026-10-08") == (
        "2026-09-30", "2026-09-29", 5.0,
    )
    assert accuracy.official_base(holiday_boundary, "2026-10-02") is None


def test_scheduled_window_records_delay_without_backdating_late_runs():
    on_time = accuracy.build_run_context(
        dt.datetime(2026, 7, 10, 14, 40, tzinfo=accuracy.CST), run_mode="scheduled",
    )
    assert on_time["prediction_expected"] is True
    assert on_time["scheduled_for"] == "2026-07-10T14:35+08:00"
    assert on_time["delay_minutes"] == 5

    late = accuracy.build_run_context(
        dt.datetime(2026, 7, 10, 16, 0, tzinfo=accuracy.CST), run_mode="scheduled",
    )
    assert late["prediction_due"] is True
    assert late["prediction_allowed"] is True
    assert late["prediction_window_status"] == "delayed_same_day"
    assert late["observation_date"] == "2026-07-10"
    assert late["prediction_target_date"] == "2026-07-09"

    cross_day = accuracy.build_run_context(
        dt.datetime(2026, 7, 11, 1, 0, tzinfo=accuracy.CST), run_mode="scheduled",
    )
    assert cross_day["scheduled_for"] == "2026-07-10T14:35+08:00"
    assert cross_day["delay_minutes"] == 625
    assert cross_day["observation_date"] == "2026-07-11"
    assert cross_day["scheduled_observation_date"] == "2026-07-10"
    assert cross_day["prediction_due"] is True
    assert cross_day["prediction_expected"] is False
    assert cross_day["prediction_allowed"] is False
    assert cross_day["prediction_window_status"] == "delayed_cross_day"
    assert cross_day["prediction_target_date"] == "2026-07-09"

    manual_weekend = accuracy.build_run_context(
        dt.datetime(2026, 7, 11, 14, 35, tzinfo=accuracy.CST), run_mode="manual",
    )
    assert manual_weekend["prediction_due"] is False
    assert manual_weekend["prediction_expected"] is False

    manual_on_time = accuracy.build_run_context(
        dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST), run_mode="manual",
    )
    assert manual_on_time["prediction_window_status"] == "open"
    assert manual_on_time["prediction_allowed"] is False

    holiday = accuracy.build_run_context(
        dt.datetime(2026, 10, 1, 14, 35, tzinfo=accuracy.CST), run_mode="scheduled",
        non_trading_dates={"2026-10-01"},
    )
    assert holiday["prediction_window_status"] == "non_trading_day"
    assert holiday["prediction_due"] is False

    unsupported = accuracy.build_run_context(
        dt.datetime(2027, 1, 4, 14, 35, tzinfo=accuracy.CST), run_mode="scheduled",
    )
    assert unsupported["calendar_supported"] is False
    assert unsupported["prediction_allowed"] is False
    unsupported_audit = audit_module.audit({"records": [], "pipeline": unsupported}, registry_fixture())
    assert any("超出已审计" in error for error in unsupported_audit["errors"])


def test_model_uses_only_quote_legs_proven_for_target_date():
    model = {
        "label": "cross-market", "min_weight": 50, "scale": 1, "bias": 0,
        "legs": [
            {"code": "usQQQ", "weight": 60},
            {"code": "sh000300", "weight": 40},
        ],
    }
    result = accuracy.calculate_model(model, {
        "usQQQ": {
            "change": 2, "quote_date": "2026-07-09",
            "quote_time": "2026-07-09 16:00:00", "source": "tencent_quote",
        },
        "sh000300": {
            "change": -1, "quote_date": "2026-07-10",
            "quote_time": "2026-07-10 14:35:00", "source": "tencent_quote",
        },
    }, "2026-07-09")
    assert result is not None
    assert result["predicted_change"] == 2
    assert set(result["features"]) == {"usQQQ"}
    assert result["feature_evidence"]["usQQQ"]["quote_date"] == "2026-07-09"

    model["min_weight"] = 70
    assert accuracy.calculate_model(model, {
        "usQQQ": {
            "change": 2, "quote_date": "2026-07-09",
            "quote_time": "2026-07-09 16:00:00", "source": "tencent_quote",
        },
        "sh000300": {
            "change": -1, "quote_date": "2026-07-10",
            "quote_time": "2026-07-10 14:35:00", "source": "tencent_quote",
        },
    }, "2026-07-09") is None


def test_legacy_same_day_axis_is_retained_but_quarantined():
    row = {
        "code": "012920", "prediction_date": "2026-07-10",
        "target_nav_date": "2026-07-10", "base_nav_date": "2026-07-09",
        "model_version": "v1", "status": "settled", "error": 1,
        "direction_hit": True,
    }
    ledger = {"records": [row], "pipeline": {
        "last_prediction_at": "2026-07-10T14:35:00+08:00",
        "last_settlement_at": "2026-07-11T12:00:00+08:00",
    }}
    assert accuracy.migrate_legacy_misaligned_records(ledger) == 1
    assert row["status"] == "legacy_misaligned"
    assert row["legacy_status"] == "settled"
    assert row["excluded_from_metrics"] is True
    assert "last_effective_prediction_at" not in ledger["pipeline"]
    assert accuracy.migrate_legacy_misaligned_records(ledger) == 0

    registry = {"models": {"012920": {
        "active": {"version": "v1"}, "governance": {"status": "healthy"},
    }}}
    assert accuracy.summarize(ledger, registry)["012920"]["samples"] == 0
    assert calibration.eligible_settled_rows([row]) == []


def test_pending_state_never_rolls_forward_to_next_nav():
    import datetime as dt
    ledger = {"records": [
        {"code": "A", "target_nav_date": "2026-07-01", "status": "pending"},
        {"code": "B", "target_nav_date": "2026-07-05", "status": "pending"},
    ]}
    accuracy.update_pending_states(ledger, dt.date(2026, 7, 10))
    assert ledger["records"][0]["status"] == "stale"
    assert ledger["records"][0]["waiting_days"] == 9
    assert ledger["records"][1]["status"] == "market_closed"


def test_summary_has_rolling_windows_and_error_percentiles():
    rows = []
    observations = [
        dt.date(2026, 7, 2), dt.date(2026, 7, 3), dt.date(2026, 7, 6),
        dt.date(2026, 7, 7), dt.date(2026, 7, 8), dt.date(2026, 7, 9),
    ]
    for i, observation in enumerate(observations, 1):
        target = accuracy.previous_trading_date(observation)
        base = accuracy.previous_trading_date(target)
        rows.append({
            "code": "X", "prediction_date": observation.isoformat(),
            "target_nav_date": target.isoformat(), "base_nav_date": base.isoformat(),
            "model_version": "v1",
            "status": "settled",
            "error": float(i), "direction_hit": i % 2 == 0,
            "features": {"usQQQ": float(i)},
            "feature_evidence": {"usQQQ": {
                "change": float(i), "quote_date": target.isoformat(),
                "quote_time": f"{target.isoformat()} 16:00:00", "source": "tencent_quote",
            }},
        })
    registry = {"models": {"X": {"active": {"version": "v1"}, "governance": {"status": "healthy"}}}}
    summary = accuracy.summarize({"records": rows}, registry)["X"]
    assert summary["rolling_5"]["samples"] == 5
    assert summary["rolling_20"]["samples"] == 6
    assert summary["error_percentiles"]["p50"] == 3.5
    assert summary["error_percentiles"]["p95"] == 5.75


def test_calibration_keeps_time_holdout_and_rejects_small_sample():
    active = {
        "version": "v1", "label": "test", "min_weight": 100,
        "scale": 1.0, "bias": 0.0, "legs": [{"code": "usQQQ", "weight": 100}],
    }
    small = [{"target_nav_date": f"2026-01-{i:02d}", "features": {"usQQQ": 1}, "actual_change": 2} for i in range(1, 10)]
    assert calibration.calibrate(small, active, min_samples=20)["status"] == "collecting"

    rows = []
    for i in range(1, 31):
        rows.append({
            "target_nav_date": f"2026-{1 + (i - 1) // 28:02d}-{1 + (i - 1) % 28:02d}",
            "features": {"usQQQ": 1 if i % 2 else -1},
            "actual_change": 1.4 if i % 2 else -1.4,
        })
    result = calibration.calibrate(rows, active, min_samples=20)
    assert result["split_date"] == rows[21]["target_nav_date"]
    assert result["train_samples"] == 21
    assert result["validation_samples"] == 9
    assert result["status"] == "accepted"
    assert result["candidate"]["mae"] < result["baseline"]["mae"]


def test_drift_requires_sustained_recent_error_and_low_direction_hit():
    rows = []
    for i in range(20):
        error = 0.2 if i < 10 else 1.2
        rows.append({
            "target_nav_date": f"2026-01-{i + 1:02d}",
            "model_version": "v1", "status": "settled",
            "error": error, "direction_hit": i < 10,
        })
    degraded, evidence = calibration.active_is_degraded(rows, "v1")
    assert degraded is True
    assert evidence["recent_mae"] == 1.2
    assert evidence["recent_direction_accuracy"] == 0.0


def test_audit_blocks_duplicates_but_only_warns_on_stale():
    ledger = {"records": [{
        "code": "012920", "prediction_date": "2026-01-02", "target_nav_date": "2026-01-02",
        "base_nav_date": "2026-01-01", "model_version": "v1", "status": "stale",
    }, {
        "code": "012920", "prediction_date": "2026-01-02", "target_nav_date": "2026-01-02",
        "base_nav_date": "2026-01-01", "model_version": "v1", "status": "pending",
    }]}
    result = audit_module.audit(ledger, {"models": {}})
    assert result["status"] == "failed"
    assert any("重复预测" in error for error in result["errors"])
    assert any("超过 7 天" in warning for warning in result["warnings"])


def test_audit_accepts_observation_target_base_axis_and_quote_evidence():
    row = {
        "code": "012920", "prediction_date": "2026-07-13",
        "target_nav_date": "2026-07-10", "base_nav_date": "2026-07-09",
        "base_nav": 5, "predicted_change": 2, "model_version": "v1",
        "observed_at": "2026-07-13T16:00:00+08:00", "status": "pending",
        "features": {"usQQQ": 2},
        "feature_evidence": {"usQQQ": {
            "change": 2, "quote_date": "2026-07-10",
            "quote_time": "2026-07-10 16:00:00", "source": "tencent_quote",
        }},
    }
    result = audit_module.audit({"records": [row], "pipeline": {
        "run_mode": "scheduled", "prediction_due": True, "prediction_expected": True,
        "prediction_window_status": "delayed_same_day", "observation_date": "2026-07-13",
        "expected_models": 1, "effective_predictions_for_observation": 1,
        "last_effective_prediction_at": "2026-07-13T16:00:00+08:00",
    }}, registry_fixture(), now=dt.datetime(2026, 7, 13, 16, 1, tzinfo=accuracy.CST))
    assert result["status"] == "warning"
    assert result["errors"] == []
    assert result["stats"]["effective_predictions_for_observation"] == 1
    assert any("延迟至同日" in warning for warning in result["warnings"])


def test_audit_fails_closed_only_after_consecutive_expected_zero_runs():
    now = dt.datetime(2026, 7, 10, 14, 40, tzinfo=accuracy.CST)
    pipeline = {
        "heartbeat_at": now.isoformat(), "run_mode": "scheduled",
        "prediction_due": True, "prediction_expected": True,
        "prediction_window_status": "open", "observation_date": "2026-07-10",
        "prediction_target_date": "2026-07-09",
        "expected_models": 1, "effective_predictions_for_observation": 0,
        "consecutive_expected_zero_prediction_runs": 1,
    }
    first = audit_module.audit(
        {"records": [], "pipeline": pipeline}, registry_fixture(), now=now,
        zero_prediction_limit=2,
    )
    assert first["status"] == "warning"
    assert any("连续 1 次" in warning for warning in first["warnings"])

    second = audit_module.audit(
        {"records": [], "pipeline": {**pipeline, "consecutive_expected_zero_prediction_runs": 2}},
        registry_fixture(), now=now, zero_prediction_limit=2,
    )
    assert second["status"] == "failed"
    assert any("连续 2 次" in error for error in second["errors"])

    manual = audit_module.audit(
        {"records": [], "pipeline": {
            **pipeline, "run_mode": "manual", "prediction_due": False,
            "prediction_expected": False, "prediction_window_status": "delayed_same_day",
        }},
        registry_fixture(), now=now, zero_prediction_limit=2,
    )
    assert not any("有效预测为 0" in error for error in manual["errors"])

    missed = audit_module.audit(
        {"records": [], "pipeline": {
            **pipeline, "prediction_expected": False,
            "prediction_window_status": "too_early",
        }},
        registry_fixture(), now=now, zero_prediction_limit=2,
    )
    assert missed["status"] == "failed"
    assert any("无有效同日观察" in error for error in missed["errors"])


def test_calibration_fingerprint_changes_only_with_effective_evidence():
    row = {
        "prediction_date": "2026-07-13", "target_nav_date": "2026-07-10", "base_nav_date": "2026-07-09",
        "model_version": "v1", "status": "settled", "actual_change": 2,
        "features": {"usQQQ": 1}, "settled_at": "2026-07-11T12:00:00+08:00",
        "feature_evidence": {"usQQQ": {
            "change": 1, "quote_date": "2026-07-10",
            "quote_time": "2026-07-10 16:00:00", "source": "tencent_quote",
        }},
    }
    eligible = calibration.eligible_settled_rows([row, {**row, "status": "pending"}])
    assert eligible == [row]
    assert calibration.data_fingerprint(eligible) == calibration.data_fingerprint([dict(row)])
    assert calibration.data_fingerprint(eligible) != calibration.data_fingerprint([{**row, "actual_change": 3}])
    assert calibration.data_effective_at(eligible) == "2026-07-11T12:00:00+08:00"


def test_audit_effective_age_does_not_use_fresh_heartbeat():
    now = dt.datetime(2026, 7, 10, 14, 40, tzinfo=accuracy.CST)
    result = audit_module.audit({
        "records": [],
        "updated_at": now.isoformat(),
        "pipeline": {
            "heartbeat_at": now.isoformat(), "run_mode": "manual",
            "prediction_due": False, "prediction_expected": False,
            "prediction_window_status": "open",
            "last_effective_prediction_at": "2026-07-01T14:35:00+08:00",
        },
    }, registry_fixture(), now=now, max_effective_age_hours=96)
    assert result["status"] == "warning"
    assert any("最后有效预测" in warning for warning in result["warnings"])
    assert result["stats"]["prediction_effective_age_hours"] > 96


def test_calibration_main_does_not_rewrite_unchanged_evidence(tmp_path, monkeypatch):
    row = {
        "code": "012920", "prediction_date": "2026-07-13",
        "target_nav_date": "2026-07-10", "base_nav_date": "2026-07-09",
        "model_version": "v1", "status": "settled", "actual_change": 2,
        "features": {"usQQQ": 1}, "settled_at": "2026-07-11T12:00:00+08:00",
        "feature_evidence": {"usQQQ": {
            "change": 1, "quote_date": "2026-07-10",
            "quote_time": "2026-07-10 16:00:00", "source": "tencent_quote",
        }},
    }
    registry = registry_fixture()
    registry["models"]["012920"]["candidate"] = {
        "status": "collecting", "data_fingerprint": calibration.data_fingerprint([row]),
        "eligible_for_admin_review": False,
        "admin_review_recommendation": "no_active_change",
    }
    registry["models"]["012920"]["governance"] = {
        "status": "collecting", "poor_cycles": 0,
        "active_change_policy": "explicit_admin_only",
        "rollback_recommended": False,
        "recommendation": "collect_more_evidence",
    }
    registry_path = tmp_path / "registry.json"
    ledger_path = tmp_path / "ledger.json"
    registry_path.write_text(json.dumps(registry), encoding="utf-8")
    ledger_path.write_text(json.dumps({"records": [row]}), encoding="utf-8")
    writes = []
    monkeypatch.setattr(calibration, "REGISTRY", registry_path)
    monkeypatch.setattr(calibration, "LEDGER", ledger_path)
    monkeypatch.setattr(calibration, "write_json_atomic", lambda path, value: writes.append((path, value)))

    calibration.main()

    assert writes == []


def test_overseas_calibration_never_promotes_or_rolls_back_active(tmp_path, monkeypatch):
    registry = registry_fixture()
    entry = registry["models"]["012920"]
    active = json.loads(json.dumps(entry["active"]))
    history = [{"version": "v0", "scale": 0.8, "bias": 0, "legs": active["legs"]}]
    entry["history"] = json.loads(json.dumps(history))
    entry["governance"] = {"status": "frozen", "poor_cycles": 1}
    registry_path = tmp_path / "registry.json"
    ledger_path = tmp_path / "ledger.json"
    registry_path.write_text(json.dumps(registry), encoding="utf-8")
    ledger_path.write_text(json.dumps({"records": [{"code": "012920"}]}), encoding="utf-8")
    monkeypatch.setattr(calibration, "REGISTRY", registry_path)
    monkeypatch.setattr(calibration, "LEDGER", ledger_path)
    monkeypatch.setattr(calibration, "eligible_settled_rows", lambda rows: rows)
    monkeypatch.setattr(calibration, "data_fingerprint", lambda rows: "new-evidence")
    monkeypatch.setattr(calibration, "data_effective_at", lambda rows: "2026-07-10T12:00:00+08:00")
    monkeypatch.setattr(calibration, "calibrate", lambda rows, model: {
        "status": "accepted",
        "samples": 20,
        "parameters": {"scale": 1.2, "bias": 0.1, "legs": model["legs"]},
    })
    monkeypatch.setattr(
        calibration,
        "active_is_degraded",
        lambda rows, version: (True, {"samples": 20, "recent_mae": 1.2}),
    )

    calibration.main()

    output = json.loads(registry_path.read_text(encoding="utf-8"))["models"]["012920"]
    assert output["active"] == active
    assert output["history"] == history
    assert output["candidate"]["status"] == "accepted"
    assert output["candidate"]["eligible_for_admin_review"] is False
    assert output["governance"]["poor_cycles"] == 2
    assert output["governance"]["rollback_recommended"] is True
    assert output["governance"]["recommendation"] == "review_rollback"
    assert output["governance"]["active_change_policy"] == "explicit_admin_only"


def test_cross_day_run_settles_real_rows_without_backfilled_prediction(tmp_path, monkeypatch):
    registry_path = tmp_path / "registry.json"
    ledger_path = tmp_path / "ledger.json"
    registry = registry_fixture()
    pending = {
        "code": "012920",
        "prediction_date": "2026-07-10",
        "target_nav_date": "2026-07-09",
        "base_nav_date": "2026-07-08",
        "base_nav": 5,
        "predicted_change": 2,
        "model_version": "v1",
        "observed_at": "2026-07-10T14:40:00+08:00",
        "status": "pending",
        "features": {"usQQQ": 2},
        "feature_evidence": {"usQQQ": {
            "change": 2,
            "quote_date": "2026-07-09",
            "quote_time": "2026-07-09 16:00:00",
            "source": "tencent_quote",
        }},
    }
    registry_path.write_text(json.dumps(registry), encoding="utf-8")
    ledger_path.write_text(json.dumps({"records": [pending]}), encoding="utf-8")
    monkeypatch.setattr(accuracy, "REGISTRY", registry_path)
    monkeypatch.setattr(accuracy, "LEDGER", ledger_path)
    monkeypatch.setattr(accuracy, "fetch_details", lambda codes: {"012920": {
        "nav_history": [
            {"date": "2026-07-08", "nav": 5},
            {"date": "2026-07-09", "nav": 5.1},
        ],
    }})
    monkeypatch.setattr(
        accuracy,
        "fetch_quotes",
        lambda codes: (_ for _ in ()).throw(AssertionError("cross-day run must not fetch prediction quotes")),
    )
    now = dt.datetime(2026, 7, 11, 1, 0, tzinfo=accuracy.CST)

    result = accuracy.run_pipeline(now, run_mode="scheduled")

    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    assert result["predictions_written"] == 0
    assert result["settlements_written"] == 1
    assert len(ledger["records"]) == 1
    assert ledger["records"][0]["status"] == "settled"
    assert ledger["pipeline"]["prediction_window_status"] == "delayed_cross_day"
    assert ledger["pipeline"]["prediction_expected"] is False
    assert ledger["pipeline"]["predictions_written"] == 0
    assert ledger["pipeline"]["settlements_written"] == 1
    report = audit_module.audit(ledger, registry, now=now)
    assert report["errors"] == []
    assert any("跨日" in warning for warning in report["warnings"])

    invalid = json.loads(json.dumps(ledger))
    invalid["pipeline"]["predictions_written"] = 1
    invalid_report = audit_module.audit(invalid, registry, now=now)
    assert any("不得回填伪预测" in error for error in invalid_report["errors"])


def test_pipeline_counts_zero_output_once_per_expected_trading_date(tmp_path, monkeypatch):
    registry_path = tmp_path / "registry.json"
    ledger_path = tmp_path / "ledger.json"
    registry_path.write_text(json.dumps(registry_fixture()), encoding="utf-8")
    ledger_path.write_text(json.dumps({"records": []}), encoding="utf-8")
    detail = {
        "name": "测试基金", "latest_nav": 5, "latest_nav_date": "2026-07-08",
        "nav_history": [{"date": "2026-07-08", "nav": 5}],
    }
    monkeypatch.setattr(accuracy, "REGISTRY", registry_path)
    monkeypatch.setattr(accuracy, "LEDGER", ledger_path)
    monkeypatch.setattr(accuracy, "fetch_details", lambda codes: {"012920": detail})
    monkeypatch.setattr(accuracy, "fetch_quotes", lambda codes: {})

    friday = dt.datetime(2026, 7, 10, 14, 40, tzinfo=accuracy.CST)
    accuracy.run_pipeline(friday, run_mode="scheduled")
    first = json.loads(ledger_path.read_text(encoding="utf-8"))["pipeline"]
    assert first["consecutive_expected_zero_prediction_runs"] == 1
    assert first["last_expected_zero_prediction_observation_date"] == "2026-07-10"

    accuracy.run_pipeline(friday, run_mode="scheduled")
    retry = json.loads(ledger_path.read_text(encoding="utf-8"))["pipeline"]
    assert retry["consecutive_expected_zero_prediction_runs"] == 1

    monday = dt.datetime(2026, 7, 13, 14, 40, tzinfo=accuracy.CST)
    detail.update({
        "latest_nav": 5.1,
        "latest_nav_date": "2026-07-09",
        "nav_history": [{"date": "2026-07-09", "nav": 5.1}],
    })
    accuracy.run_pipeline(monday, run_mode="scheduled")
    second_date = json.loads(ledger_path.read_text(encoding="utf-8"))["pipeline"]
    assert second_date["consecutive_expected_zero_prediction_runs"] == 2

    monkeypatch.setattr(accuracy, "fetch_quotes", lambda codes: {"usQQQ": {
        "change": 2, "quote_date": "2026-07-10",
        "quote_time": "2026-07-10 16:00:00", "source": "tencent_quote",
    }})
    accuracy.run_pipeline(monday, run_mode="scheduled")
    recovered = json.loads(ledger_path.read_text(encoding="utf-8"))["pipeline"]
    assert recovered["effective_predictions_for_observation"] == 1
    assert recovered["consecutive_expected_zero_prediction_runs"] == 0
    assert recovered["last_effective_prediction_at"] == monday.isoformat(timespec="seconds")


def test_manual_pipeline_never_creates_or_backfills_prediction(tmp_path, monkeypatch):
    registry_path = tmp_path / "registry.json"
    ledger_path = tmp_path / "ledger.json"
    registry_path.write_text(json.dumps(registry_fixture()), encoding="utf-8")
    ledger_path.write_text(json.dumps({"records": []}), encoding="utf-8")
    monkeypatch.setattr(accuracy, "REGISTRY", registry_path)
    monkeypatch.setattr(accuracy, "LEDGER", ledger_path)
    monkeypatch.setattr(accuracy, "fetch_details", lambda codes: {"012920": {
        "latest_nav": 5, "latest_nav_date": "2026-07-08",
        "nav_history": [{"date": "2026-07-08", "nav": 5}],
    }})
    monkeypatch.setattr(
        accuracy, "fetch_quotes",
        lambda codes: (_ for _ in ()).throw(AssertionError("manual run must not fetch prediction quotes")),
    )
    result = accuracy.run_pipeline(
        dt.datetime(2026, 7, 10, 16, 0, tzinfo=accuracy.CST), run_mode="manual",
    )
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    assert result["predictions_written"] == 0
    assert ledger["records"] == []
    assert ledger["pipeline"]["prediction_expected"] is False
    assert ledger["pipeline"]["prediction_window_status"] == "delayed_same_day"
