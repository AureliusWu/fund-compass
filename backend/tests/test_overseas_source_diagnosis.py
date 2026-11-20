import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("diagnosis", ROOT / "tools/diagnose_overseas_sources.py")
diagnosis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnosis)


@pytest.mark.parametrize("date,reason", [("2026-11-10", "axis_base_stale"),
                                         ("2026-11-12", "axis_base_ahead")])
def test_source_age_and_late_observation_remain_distinct(date, reason):
    detail = {"latest_nav_date": date, "latest_nav": 5, "nav_history": [{"date": date, "nav": 5}]}
    counts, selected = diagnosis.snapshot(detail, "2026-11-13")
    assert selected == date
    assert counts == {reason: 1, "axis_base_date_mismatch": 1}


def test_primary_parser_reads_data_without_executing_javascript():
    stamp = int(dt.datetime(2026, 11, 12, tzinfo=diagnosis.producer.CST).timestamp() * 1000)
    raw = ('throw new Error("not executed"); var Data_netWorthTrend = ' + json.dumps([{"x": stamp, "y": 5}]) + ';').encode()
    assert diagnosis.primary_date(raw) == "2026-11-12"


@pytest.mark.parametrize("raw", [b"HTML", b"var Data_netWorthTrend=[];",
                                b'var Data_netWorthTrend=[{"x":true,"y":5}];'])
def test_invalid_primary_is_unknown(raw):
    with pytest.raises(ValueError):
        diagnosis.primary_date(raw)


def test_read_only_run_stops_on_access_denial_and_never_uses_another_source(monkeypatch, tmp_path):
    registry = tmp_path / "models.json"
    registry.write_text(json.dumps({"models": {"539002": {}, "012920": {}}}))
    monkeypatch.setattr(diagnosis.producer, "REGISTRY", registry)
    monkeypatch.setattr(diagnosis.producer, "FUND_API_BASE", "https://api.test")
    requests = []
    def denied(url):
        requests.append(url)
        raise diagnosis.urllib.error.HTTPError(url, 403, "private response", {}, None)
    monkeypatch.setattr(diagnosis, "read", denied)
    result = diagnosis.run(dt.datetime(2026, 11, 14, 15, tzinfo=diagnosis.producer.CST))
    assert len(requests) == 1
    assert result["observation_date"] == "2026-11-13"
    assert result["counts"] == {"api_http_403": 1, "source_access_stopped": 1}
    assert "private response" not in json.dumps(result)


def write_public_artifact(directory, *, window, expected, audit_status, audit_override=None):
    directory.mkdir(parents=True, exist_ok=True)
    shared = {"prediction_due": True, "prediction_expected": expected,
              "effective_predictions_for_observation": 0}
    pipeline = {
        **shared, "prediction_window_status": window,
        "scheduled_for": "2026-11-18T14:35+08:00", "last_run_at": "2026-11-18T23:56:06+08:00",
        "prediction_target_date": "2026-11-17", "delay_minutes": 561.1,
        "predictions_written": 0, "prediction_diagnostics": {
            "axis_base_ahead": 3, "axis_base_date_mismatch": 3, "private detail": "do not print",
        } if expected else {},
    }
    (directory / "overseas-accuracy.json").write_text(json.dumps({"pipeline": pipeline}), encoding="utf-8")
    audit = {"status": audit_status, "updated_at": "2026-11-18T23:57:21+08:00",
             "stats": {**shared, "prediction_effective_age_hours": 289.4}, **(audit_override or {})}
    (directory / "overseas-audit.json").write_text(json.dumps(audit), encoding="utf-8")


@pytest.mark.parametrize("window,expected,audit_status,result_status", [
    ("delayed_same_day", True, "failed", "zero_effective_prediction"),
    ("delayed_cross_day", False, "warning", "scheduled_window_missed"),
])
def test_artifact_diagnosis_separates_zero_forecasts_and_missed_schedule(
        tmp_path, capsys, monkeypatch, window, expected, audit_status, result_status):
    data = tmp_path / "frontend/public/data" if expected else tmp_path
    write_public_artifact(data, window=window, expected=expected, audit_status=audit_status)

    def deny_network(*args):
        pytest.fail("offline artifact diagnosis must not call a provider")

    monkeypatch.setattr(diagnosis, "run", deny_network)
    monkeypatch.setattr(diagnosis, "read", deny_network)
    assert diagnosis.main(["--artifact-dir", str(tmp_path)]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == result_status
    assert output["audit_status"] == audit_status
    assert output["effective_predictions"] == 0
    assert output["prediction_diagnostics"] == ({"axis_base_ahead": 3, "axis_base_date_mismatch": 3} if expected else {})


def test_artifact_diagnosis_rejects_audit_from_different_run(tmp_path, capsys):
    write_public_artifact(tmp_path, window="delayed_same_day", expected=True, audit_status="failed",
                          audit_override={"updated_at": "2026-11-19T23:57:21+08:00"})
    assert diagnosis.main(["--artifact-dir", str(tmp_path)]) == 1
    assert json.loads(capsys.readouterr().out) == {
        "profile": diagnosis.ARTIFACT_PROFILE, "status": "artifact_unavailable",
    }
