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


def write_public_artifact(directory, *, late=False):
    directory.mkdir(parents=True, exist_ok=True)
    start = "2026-11-20T00:00:02+08:00" if late else "2026-11-18T23:56:06+08:00"
    audited_at = "2026-11-20T00:00:57+08:00" if late else "2026-11-18T23:57:21+08:00"
    end = "2026-11-20T00:01:08+08:00" if late else "2026-11-18T23:57:26+08:00"
    shared = {"prediction_due": True, "prediction_expected": not late,
              "effective_predictions_for_observation": 0}
    pipeline = {
        **shared, "prediction_window_status": "delayed_cross_day" if late else "delayed_same_day",
        "scheduled_for": "2026-11-19T14:35+08:00" if late else "2026-11-18T14:35+08:00",
        "last_run_at": start, "heartbeat_at": start, "observation_date": start[:10],
        "scheduled_observation_date": "2026-11-19" if late else "2026-11-18",
        "prediction_target_date": "2026-11-18" if late else "2026-11-17",
        "delay_minutes": 565.03 if late else 561.1,
        "last_effective_prediction_at": "2026-11-06T22:33:06+08:00",
        "predictions_written": 0, "prediction_diagnostics": {
            "axis_base_ahead": 3, "axis_base_date_mismatch": 3, "private detail": "do not print",
        } if not late else {},
    }
    ledger = {"schema": 2, "updated_at": start, "pipeline": pipeline, "records": [{"status": "settled"}]}
    audit = {
        "status": "warning" if late else "failed", "updated_at": audited_at,
        "errors": [] if late else ["stale latest prediction"], "warnings": ["late run"],
        "stats": {**shared, "records": 1, "statuses": {"settled": 1}, "legacy_misaligned": 0,
                  "prediction_effective_age_hours": 313.5 if late else 289.4},
    }
    receipt = {"total_count": 1, "jobs": [{
        "run_id": 100, "run_attempt": 1, "run_url": diagnosis.RUN_API + "100", "workflow_name": "overseas-accuracy",
        "name": "ledger", "status": "completed", "head_sha": "a" * 40, "started_at": start,
        "completed_at": end, "steps": [{"name": diagnosis.PIPELINE_STEP, "status": "completed",
                                       "started_at": start, "completed_at": end,
                                       "conclusion": "success" if late else "failure"}],
    }]}
    for name, value in (("overseas-accuracy.json", ledger), ("overseas-audit.json", audit), ("jobs.json", receipt)):
        (directory / name).write_text(json.dumps(value), encoding="utf-8")
    return directory / "jobs.json"


@pytest.mark.parametrize("late,audit_status,result_status", [
    (False, "failed", "zero_effective_prediction"),
    (True, "warning", "scheduled_window_missed"),
])
def test_artifact_diagnosis_separates_zero_forecasts_and_missed_schedule(
        tmp_path, capsys, monkeypatch, late, audit_status, result_status):
    data = tmp_path if late else tmp_path / "frontend/public/data"
    jobs = write_public_artifact(data, late=late)

    def deny_network(*args):
        pytest.fail("offline artifact diagnosis must not call a provider")

    monkeypatch.setattr(diagnosis, "run", deny_network)
    monkeypatch.setattr(diagnosis, "read", deny_network)
    assert diagnosis.main(["--artifact-dir", str(tmp_path), "--run-jobs", str(jobs)]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["run_id"] == 100
    assert output["source_sha"] == "a" * 40
    assert output["status"] == result_status
    assert output["audit_status"] == audit_status
    assert output["effective_predictions"] == 0
    assert output["prediction_diagnostics"] == ({} if late else {"axis_base_ahead": 3, "axis_base_date_mismatch": 3})


def test_artifact_diagnosis_rejects_audit_from_different_run(tmp_path, capsys):
    jobs = write_public_artifact(tmp_path)
    audit_path = tmp_path / "overseas-audit.json"
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["updated_at"] = "2026-11-19T23:57:21+08:00"
    audit_path.write_text(json.dumps(audit), encoding="utf-8")
    assert diagnosis.main(["--artifact-dir", str(tmp_path), "--run-jobs", str(jobs)]) == 1
    assert json.loads(capsys.readouterr().out) == {
        "profile": diagnosis.ARTIFACT_PROFILE, "status": "artifact_unavailable",
    }


def test_artifact_rejects_fresh_upload_of_previous_run_pair(tmp_path):
    previous = tmp_path / "previous"
    write_public_artifact(previous)
    current_jobs = write_public_artifact(tmp_path / "current", late=True)
    with pytest.raises(ValueError, match="artifact_time"):
        diagnosis.diagnose_artifact(previous, current_jobs)


@pytest.mark.parametrize("field,value,error", [
    ("records", 2, "artifact_records"),
    ("statuses", {"legacy_misaligned": 1}, "artifact_records"),
    ("prediction_effective_age_hours", 0, "artifact_age"),
])
def test_artifact_rejects_conflicting_audit_contents_in_matching_time(tmp_path, field, value, error):
    jobs = write_public_artifact(tmp_path)
    audit_path = tmp_path / "overseas-audit.json"
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    audit["stats"][field] = value
    audit_path.write_text(json.dumps(audit), encoding="utf-8")
    with pytest.raises(ValueError, match=error):
        diagnosis.diagnose_artifact(tmp_path, jobs)
