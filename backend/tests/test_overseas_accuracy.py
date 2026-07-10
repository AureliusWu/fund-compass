import importlib.util
import datetime as dt
from pathlib import Path


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


def registry_fixture():
    return {"models": {"012920": {"name": "测试基金", "active": {
        "version": "v1", "label": "测试模型", "min_weight": 50,
        "scale": 1, "bias": 0, "legs": [{"code": "usQQQ", "weight": 100}],
    }}}}


def test_add_predictions_is_daily_idempotent_and_precedes_settlement():
    ledger = {"records": []}
    registry = registry_fixture()
    fund_data = {"012920": {"name": "测试基金", "dwjz": "5", "jzrq": "2026-07-09"}}
    now = dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST)

    assert accuracy.add_predictions(ledger, registry, {"usQQQ": 2}, fund_data, now) == 1
    assert accuracy.add_predictions(ledger, registry, {"usQQQ": 3}, fund_data, now) == 0
    row = ledger["records"][0]
    assert row["status"] == "pending"
    assert row["prediction_date"] == "2026-07-10"
    assert row["target_nav_date"] == "2026-07-10"
    assert row["predicted_change"] == 2

    assert accuracy.settle_records(ledger, {"012920": {"nav_history": [
        {"date": "2026-07-11", "nav": 5.2},
    ]}}) == 0
    assert accuracy.settle_records(ledger, {"012920": {"nav_history": [
        {"date": "2026-07-10", "nav": 5.1},
    ]}}) == 1
    assert row["status"] == "settled"
    assert row["actual_change"] == 2


def test_add_predictions_skips_weekends():
    ledger = {"records": []}
    now = dt.datetime(2026, 7, 11, 14, 35, tzinfo=accuracy.CST)
    assert accuracy.add_predictions(
        ledger, registry_fixture(), {"usQQQ": 2},
        {"012920": {"dwjz": "5", "jzrq": "2026-07-10"}}, now,
    ) == 0
    assert ledger["records"] == []


def test_settle_pairs_exact_nav_date_only():
    ledger = {"records": [{
        "code": "012920", "target_nav_date": "2026-07-02", "base_nav": 5.0259,
        "predicted_change": -7.5, "status": "pending",
    }, {
        "code": "018147", "target_nav_date": "2026-07-01", "base_nav": 2.803,
        "predicted_change": -8, "status": "pending",
    }]}
    details = {
        "012920": {"nav_history": [{"date": "2026-07-02", "nav": 4.6234}]},
        "018147": {"nav_history": [{"date": "2026-07-02", "nav": 2.464}]},
    }

    assert accuracy.settle_records(ledger, details) == 1
    assert ledger["records"][0]["actual_change"] == -8.0085
    assert ledger["records"][0]["status"] == "settled"
    assert ledger["records"][1]["status"] == "pending"


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
    for i in range(1, 7):
        rows.append({
            "code": "X", "target_nav_date": f"2026-01-{i:02d}", "status": "settled",
            "error": float(i), "direction_hit": i % 2 == 0,
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
