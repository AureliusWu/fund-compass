import importlib.util
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
