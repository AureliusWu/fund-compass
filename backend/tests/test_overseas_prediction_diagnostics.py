"""Synthetic public stage counts: no providers, secrets, or private ledger."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "prediction_diagnostics_accuracy", ROOT / "tools" / "overseas_accuracy.py"
)
accuracy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accuracy)


def detail():
    return {
        "latest_nav_date": "2026-07-08", "latest_nav": 5,
        "nav_history": [{"date": "2026-07-08", "nav": 5}],
    }


def model():
    return {
        "version": "synthetic-v1", "label": "synthetic", "min_weight": 70,
        "legs": [{"code": "usSYNTH", "weight": 100}], "scale": 1, "bias": 0,
    }


def quotes():
    return {"usSYNTH": {
        "change": 2, "quote_date": "2026-07-09",
        "quote_time": "2026-07-09 16:00:00", "source": "synthetic",
    }}


@pytest.mark.parametrize(("value", "reason"), [
    (None, "detail_missing"), ({}, "detail_missing"),
    ({"latest_nav_date": None}, "date_or_calendar_invalid"),
    ({**detail(), "latest_nav_date": "bad"}, "date_or_calendar_invalid"),
    ({**detail(), "latest_nav": None}, "latest_nav_missing"),
    ({**detail(), "latest_nav": True}, "latest_nav_missing"),
    ({**detail(), "nav_history": {}}, "history_nav_missing"),
    ({**detail(), "nav_history": [None, "bad"]}, "history_nav_missing"),
    ({**detail(), "latest_nav_date": "2026-07-07", "nav_history": [
        {"date": "2026-07-07", "nav": 5}
    ]}, "base_date_mismatch"),
    ({**detail(), "nav_history": [{"date": "2026-07-08", "nav": 6}]}, "nav_disagrees"),
], ids=["null", "empty", "missing-date", "bad-date", "null-nav", "bool-nav",
        "history-object", "malformed-history", "wrong-axis", "nav-conflict"])
def test_axis_rejection_is_closed_and_does_not_expose_inputs(value, reason):
    counts = {}
    original = copy.deepcopy(value)
    assert accuracy.resolve_prediction_axis(value, "2026-07-10", reason_counts=counts) is None
    assert counts == {"axis_" + reason: 1}
    assert value == original


def test_holiday_interval_still_rejects_eight_day_base():
    value = {"latest_nav_date": "2026-09-30", "latest_nav": 5,
             "nav_history": [{"date": "2026-09-30", "nav": 5}]}
    counts = {}
    assert accuracy.resolve_prediction_axis(value, "2026-10-09", reason_counts=counts) is None
    assert counts == {"axis_base_interval_too_long": 1}


def test_supported_axis_success_preserves_original_result():
    counts = {}
    value = detail()
    value["nav_history"].insert(0, None)
    assert accuracy.resolve_prediction_axis(value, "2026-07-10", reason_counts=counts) == (
        "2026-07-09", "2026-07-08", 5
    )
    assert counts == {"axis_accepted": 1}


def test_unknown_calendar_remains_rejected():
    counts = {}
    assert accuracy.resolve_prediction_axis(detail(), "2027-07-10", reason_counts=counts) is None
    assert counts == {"axis_date_or_calendar_invalid": 1}


@pytest.mark.parametrize(("candidate", "evidence", "reason"), [
    (None, quotes(), "invalid_shape"),
    ({**model(), "legs": {}}, quotes(), "invalid_shape"),
    (model(), None, "invalid_shape"),
    (model(), {}, "target_quotes_missing"),
    (model(), {"usSYNTH": {**quotes()["usSYNTH"], "quote_date": "2026-07-10"}}, "target_quotes_missing"),
    ({**model(), "legs": [None]}, quotes(), "target_quotes_missing"),
    ({**model(), "legs": [{"code": [], "weight": 100}]}, quotes(), "target_quotes_missing"),
    ({**model(), "legs": [{"code": "usSYNTH", "weight": 69}]}, quotes(), "coverage_insufficient"),
    ({**model(), "min_weight": None}, quotes(), "invalid_parameters"),
    ({**model(), "min_weight": -1}, quotes(), "invalid_parameters"),
    ({**model(), "scale": float("inf")}, quotes(), "invalid_parameters"),
    ({**model(), "bias": True}, quotes(), "invalid_parameters"),
    ({**model(), "scale": 1e308}, quotes(), "nonfinite_prediction"),
    (model(), {"usSYNTH": {**quotes()["usSYNTH"], "change": 10 ** 1000}}, "coverage_insufficient"),
], ids=["null-model", "bad-legs", "bad-quotes", "empty-quotes", "wrong-date",
        "null-leg", "bad-code", "under-coverage", "null-threshold", "negative-threshold",
        "infinite-scale", "bool-bias", "overflow-prediction", "huge-number"])
def test_model_rejection_is_closed(candidate, evidence, reason):
    counts = {}
    assert accuracy.calculate_model(candidate, evidence, "2026-07-09", reason_counts=counts) is None
    assert counts == {"model_primary_" + reason: 1}


def test_fallback_counts_both_stages_without_changing_financial_result():
    candidate = model()
    candidate["legs"] = [{"code": "missing", "weight": 100}]
    candidate["fallback"] = model()
    counts = {}
    result = accuracy.calculate_model(candidate, quotes(), "2026-07-09", reason_counts=counts)
    assert result["predicted_change"] == 2
    assert result["coverage"] == 100
    assert result["fallback_used"] is True
    assert counts == {"model_primary_target_quotes_missing": 1, "model_fallback_accepted": 1}


def test_primary_result_unchanged_when_diagnostics_are_omitted():
    assert accuracy.calculate_model(model(), quotes(), "2026-07-09") == {
        "raw_change": 2.0, "predicted_change": 2.0, "coverage": 100,
        "features": {"usSYNTH": 2.0},
        "feature_evidence": {"usSYNTH": {"change": 2.0, "quote_date": "2026-07-09",
            "quote_time": "2026-07-09 16:00:00", "source": "synthetic"}},
        "model_label": "synthetic", "fallback_used": False,
    }


@pytest.mark.parametrize(("base", "change"), [
    (1e308, 1e308), (5, -100), (5, -101), (1e-308, 0),
], ids=["derived-overflow", "zero-result", "negative-result", "rounded-zero"])
def test_invalid_derived_nav_never_enters_ledger_or_effective_count(base, change):
    registry = {"models": {"public-synthetic": {"active": model()}}}
    value = detail()
    value["latest_nav"] = base
    value["nav_history"][0]["nav"] = base
    evidence = quotes()
    evidence["usSYNTH"]["change"] = change
    # A unit weight avoids overflowing the model's weighted sum before NAV calculation.
    registry["models"]["public-synthetic"]["active"].update(
        {"min_weight": 0, "legs": [{"code": "usSYNTH", "weight": 1}]}
    )
    ledger, counts = {"records": []}, {}
    now = dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST)
    assert accuracy.add_predictions(
        ledger, registry, evidence, {"public-synthetic": value}, now, reason_counts=counts,
    ) == 0
    assert ledger["records"] == []
    assert counts["prediction_invalid_nav"] == 1
    assert accuracy.count_effective_predictions(ledger, registry, "2026-07-10") == 0
    legacy = {
        "code": "public-synthetic", "model_version": "synthetic-v1", "status": "pending",
        "prediction_date": "2026-07-10", "target_nav_date": "2026-07-09",
        "base_nav_date": "2026-07-08", "base_nav": base, "predicted_change": change,
        "features": {"usSYNTH": change}, "feature_evidence": {"usSYNTH": evidence["usSYNTH"]},
    }
    assert accuracy.valid_record_axis(legacy)
    assert accuracy.valid_feature_evidence(legacy)
    assert accuracy.count_effective_predictions({"records": [legacy]}, registry, "2026-07-10") == 0


def test_stored_nonfinite_prediction_is_not_effective_even_when_derivation_is_valid():
    registry = {"models": {"public-synthetic": {"active": model()}}}
    ledger = {"records": []}
    accuracy.add_predictions(ledger, registry, quotes(), {"public-synthetic": detail()},
                             dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST))
    assert accuracy.count_effective_predictions(ledger, registry, "2026-07-10") == 1
    ledger["records"][0]["predicted_nav"] = float("inf")
    assert accuracy.count_effective_predictions(ledger, registry, "2026-07-10") == 0


@pytest.mark.parametrize("points", [None, {}, [None, "bad", {"date": [], "nav": 5}]],
                         ids=["missing-history", "object-history", "malformed-points"])
def test_settlement_rejects_malformed_history_without_relabeling(points):
    registry = {"models": {"public-synthetic": {"active": model()}}}
    ledger = {"records": []}
    accuracy.add_predictions(ledger, registry, quotes(), {"public-synthetic": detail()},
                             dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST))
    before = copy.deepcopy(ledger)
    assert accuracy.settle_records(ledger, {"public-synthetic": {"nav_history": points}}) == 0
    assert ledger == before


def test_finite_navs_with_overflowing_actual_return_do_not_settle():
    registry = {"models": {"public-synthetic": {"active": model()}}}
    ledger = {"records": []}
    accuracy.add_predictions(ledger, registry, quotes(), {"public-synthetic": detail()},
                             dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST))
    ledger["records"][0]["base_nav"] = 1e-308
    before = copy.deepcopy(ledger)
    assert accuracy.settle_records(ledger, {"public-synthetic": {"nav_history": [
        {"date": "2026-07-08", "nav": 1e-308}, {"date": "2026-07-09", "nav": 1e308},
    ]}}) == 0
    assert ledger == before


def test_daily_retry_is_distinct_from_zero_and_does_not_duplicate_rows():
    registry = {"models": {"public-synthetic": {"active": model()}}}
    ledger = {"records": []}
    counts = {}
    now = dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST)
    for expected in (1, 0):
        assert accuracy.add_predictions(
            ledger, registry, quotes(), {"public-synthetic": detail()}, now,
            reason_counts=counts,
        ) == expected
    assert len(ledger["records"]) == 1
    assert counts == {"axis_accepted": 1, "model_primary_accepted": 1,
                      "prediction_written": 1, "prediction_already_recorded": 1}


def test_real_pipeline_output_contains_only_aggregate_diagnostic_fields(tmp_path, monkeypatch, capsys):
    registry_path = tmp_path / "models.json"
    ledger_path = tmp_path / "ledger.json"
    registry_path.write_text(json.dumps({"models": {"public-synthetic": {"active": model()}}}), encoding="utf-8")
    ledger_path.write_text('{"records":[]}', encoding="utf-8")
    monkeypatch.setattr(accuracy, "FUND_API_BASE", "https://synthetic.test")
    monkeypatch.setattr(accuracy, "REGISTRY", registry_path)
    monkeypatch.setattr(accuracy, "LEDGER", ledger_path)
    monkeypatch.setattr(accuracy, "fetch_details", lambda codes: {"public-synthetic": detail()})
    monkeypatch.setattr(accuracy, "fetch_quotes", lambda codes: {})
    monkeypatch.setattr(accuracy, "request_bytes", lambda *args, **kwargs: pytest.fail("no provider request"))
    result = accuracy.run_pipeline(dt.datetime(2026, 7, 10, 14, 35, tzinfo=accuracy.CST), run_mode="scheduled")
    assert result["effective_predictions_for_observation"] == 0
    counts = json.loads(ledger_path.read_text(encoding="utf-8"))["pipeline"]["prediction_diagnostics"]
    assert counts == {"axis_accepted": 1, "model_primary_target_quotes_missing": 1}
    output = capsys.readouterr().out
    assert "prediction diagnostics:" in output
    assert "public-synthetic" not in output
    assert "latest_nav" not in output
