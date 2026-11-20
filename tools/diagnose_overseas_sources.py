#!/usr/bin/env python3
"""Read-only source/date diagnosis, including offline Actions artifact triage."""
import argparse
import contextlib
import datetime as dt
import io
import json
import math
import os
import re
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

try:
    from tools import overseas_accuracy as producer
except ModuleNotFoundError:
    import overseas_accuracy as producer

MAX_BODY = 4 * 1024 * 1024
ARTIFACT_PROFILE = "overseas-run-artifact-diagnosis-1"
WINDOWS = {"open", "calendar_unsupported", "non_trading_day", "delayed_cross_day",
           "too_early", "delayed_same_day"}
AXIS_COUNTS = ("axis_base_ahead", "axis_base_stale", "axis_base_date_mismatch",
               "axis_target_nav_already_known", "target_quotes_missing", "coverage_insufficient")
RUN_API = "https://api.github.com/repos/AureliusWu/fund-compass/actions/runs/"
PIPELINE_STEP = "Run native pipeline and record public occurrence"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "sinan-overseas-diagnosis", "Referer": "https://fund.eastmoney.com/",
    })
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
        raw = response.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise ValueError("body_limit")
    return raw


def primary_date(raw):
    text = raw.decode("utf-8")
    match = re.search(r"\bvar\s+Data_netWorthTrend\s*=\s*(\[.*?\])\s*;", text, re.S)
    if match is None:
        raise ValueError("primary_shape")
    rows = json.loads(match[1])
    if type(rows) is not list or not rows:
        raise ValueError("primary_shape")
    dates = []
    for row in rows:
        if type(row) is not dict or type(row.get("x")) is not int or producer._float(row.get("y")) is None:
            raise ValueError("primary_shape")
        dates.append(dt.datetime.fromtimestamp(row["x"] / 1000, producer.CST).date().isoformat())
    return max(dates)


def snapshot(detail, observation):
    counts = {}
    producer.resolve_prediction_axis(detail, observation, reason_counts=counts)
    date = detail.get("latest_nav_date") if type(detail) is dict else None
    try:
        if type(date) is not str or dt.date.fromisoformat(date).isoformat() != date:
            date = None
    except ValueError:
        date = None
    return counts, date


def run(now=None):
    now = now or dt.datetime.now(producer.CST)
    observation = now.astimezone(producer.CST).date()
    while not producer.is_fund_trading_day(observation):
        observation -= dt.timedelta(days=1)
    registry = json.loads(producer.REGISTRY.read_text(encoding="utf-8"))
    codes = sorted(registry["models"])
    if not 1 <= len(codes) <= 20 or any(re.fullmatch(r"\d{6}", code) is None for code in codes):
        raise ValueError("registry_shape")
    base = producer.require_api_base()
    result = {"profile": "overseas-source-diagnosis-1", "read_only": True,
              "observed_at": now.isoformat(timespec="seconds"),
              "observation_date": observation.isoformat(),
              "target_date": producer.previous_trading_date(observation).isoformat(),
              "models": len(codes), "counts": {}, "api_latest_dates": {}, "primary_latest_dates": {}}

    def count(key, amount=1):
        result["counts"][key] = result["counts"].get(key, 0) + amount

    for code in codes:
        try:
            detail = json.loads(read(f"{base}/api/fund/{code}").decode("utf-8"))
            counts, api_date = snapshot(detail, observation.isoformat())
            for key, value in counts.items():
                count(key, value)
            if api_date:
                result["api_latest_dates"][api_date] = result["api_latest_dates"].get(api_date, 0) + 1
        except urllib.error.HTTPError as ex:
            count("api_http_" + str(ex.code))
            if ex.code in (401, 403, 429):
                count("source_access_stopped")
                break
            continue
        except Exception:
            count("api_unavailable")
            continue
        try:
            date = primary_date(read(f"https://fund.eastmoney.com/pingzhongdata/{code}.js"))
            result["primary_latest_dates"][date] = result["primary_latest_dates"].get(date, 0) + 1
            if api_date:
                count("api_behind_primary" if api_date < date else "api_ahead_primary" if api_date > date else "api_primary_aligned")
        except urllib.error.HTTPError as ex:
            count("primary_http_" + str(ex.code))
            if ex.code in (401, 403, 429):
                count("source_access_stopped")
                break
        except Exception:
            count("primary_unavailable")
    return result


def read_artifact(path):
    with path.open("rb") as stream:
        raw = stream.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise ValueError("artifact_too_large")
    value = json.loads(raw)
    if type(value) is not dict:
        raise ValueError("artifact_shape")
    return value


def aware_time(value):
    parsed = dt.datetime.fromisoformat(value)
    if parsed.utcoffset() is None:
        raise ValueError("artifact_time")
    return parsed


def native_step(receipt):
    jobs = receipt["jobs"]
    if type(receipt["total_count"]) is not int or receipt["total_count"] != 1 or len(jobs) != 1:
        raise ValueError("jobs_shape")
    job = jobs[0]
    run_id = job["run_id"]
    if (type(run_id) is not int or run_id <= 0 or job["run_url"] != RUN_API + str(run_id)
            or type(job["run_attempt"]) is not int or job["run_attempt"] != 1
            or job["workflow_name"] != "overseas-accuracy" or job["name"] != "ledger"
            or job["status"] != "completed" or not re.fullmatch(r"[0-9a-f]{40}", job["head_sha"])):
        raise ValueError("jobs_identity")
    matches = [step for step in job["steps"] if step["name"] == PIPELINE_STEP]
    if (len(matches) != 1 or matches[0]["status"] != "completed"
            or matches[0]["conclusion"] not in {"success", "failure"}):
        raise ValueError("jobs_step")
    step = matches[0]
    start, end = aware_time(step["started_at"]), aware_time(step["completed_at"])
    if not aware_time(job["started_at"]) <= start <= end <= aware_time(job["completed_at"]):
        raise ValueError("jobs_time")
    return run_id, job["head_sha"], start, end


def compare_audit_records(ledger, audit, stats, start, audited_at):
    records = ledger["records"]
    if type(records) is not list or type(stats["records"]) is not int or stats["records"] != len(records):
        raise ValueError("artifact_records")
    counts = Counter(row.get("status") or "unknown" for row in records if type(row) is dict)
    reported = stats["statuses"]
    if (type(reported) is not dict or any(type(value) is not int for value in reported.values())
            or counts != reported or type(stats["legacy_misaligned"]) is not int
            or stats["legacy_misaligned"] != counts["legacy_misaligned"]):
        raise ValueError("artifact_records")
    errors, warnings = audit["errors"], audit["warnings"]
    if type(errors) is not list or type(warnings) is not list:
        raise ValueError("artifact_audit")
    if audit["status"] != ("failed" if errors else "warning" if warnings else "healthy"):
        raise ValueError("artifact_audit")

    age = stats["prediction_effective_age_hours"]
    last = ledger["pipeline"]["last_effective_prediction_at"]
    if last is None and age is None:
        return age
    if type(age) not in (int, float) or not math.isfinite(age) or age < 0:
        raise ValueError("artifact_age")
    last = aware_time(last)
    if last > audited_at:
        raise ValueError("artifact_age")
    # The independent audit reads its clock before stamping updated_at and rounds to one decimal.
    lower = round(max(0, (start - last).total_seconds() / 3600), 1)
    upper = round(max(0, (audited_at - last).total_seconds() / 3600), 1)
    if not lower <= age <= upper:
        raise ValueError("artifact_age")
    return age


def diagnose_artifact(directory, jobs_path):
    """Summarize the extracted public JSONs against the selected native job step."""
    ledger_path = directory / "frontend/public/data/overseas-accuracy.json"
    if not ledger_path.is_file():
        ledger_path = directory / "overseas-accuracy.json"
    ledger = read_artifact(ledger_path)
    pipeline = ledger["pipeline"]
    audit = read_artifact(ledger_path.with_name("overseas-audit.json"))
    stats = audit["stats"]
    window = pipeline["prediction_window_status"]
    audit_status = audit["status"]
    if type(ledger["schema"]) is not int or ledger["schema"] != 2 or window not in WINDOWS:
        raise ValueError("artifact_shape")

    run_id, source_sha, step_start, step_end = native_step(read_artifact(jobs_path))
    start = aware_time(pipeline["last_run_at"])
    audited_at = aware_time(audit["updated_at"])
    scheduled_for = aware_time(pipeline["scheduled_for"])
    target = pipeline["prediction_target_date"]
    target_date = None if target is None else dt.date.fromisoformat(target).isoformat()
    if (not step_start <= start <= audited_at <= step_end
            or not dt.timedelta(0) <= audited_at - start <= dt.timedelta(minutes=12)
            or aware_time(ledger["updated_at"]) != start or aware_time(pipeline["heartbeat_at"]) != start):
        raise ValueError("artifact_time")
    observation_day = start.astimezone(producer.CST).date()
    scheduled_day = scheduled_for.astimezone(producer.CST).date()
    if (pipeline["observation_date"] != observation_day.isoformat()
            or pipeline["scheduled_observation_date"] != scheduled_day.isoformat()
            or (target_date is not None and target_date >= scheduled_day.isoformat())):
        raise ValueError("artifact_dates")

    shared = {"prediction_due": bool, "prediction_expected": bool,
              "effective_predictions_for_observation": int}
    for key, kind in shared.items():
        if type(pipeline[key]) is not kind or type(stats[key]) is not kind or pipeline[key] != stats[key]:
            raise ValueError("artifact_mismatch")
    count = pipeline["effective_predictions_for_observation"]
    written = pipeline["predictions_written"]
    delay = pipeline["delay_minutes"]
    if count < 0 or type(written) is not int or written < 0 or written > count:
        raise ValueError("artifact_count")
    if (type(delay) not in (int, float) or not math.isfinite(delay)
            or delay != round((start - scheduled_for).total_seconds() / 60, 2)):
        raise ValueError("artifact_time")
    if ((window == "delayed_cross_day" and (scheduled_day >= observation_day
            or pipeline["prediction_expected"] or written))
            or (pipeline["prediction_expected"] and (not pipeline["prediction_due"]
                or scheduled_day != observation_day or target_date is None
                or window not in {"open", "delayed_same_day"}))):
        raise ValueError("artifact_window")
    age = compare_audit_records(ledger, audit, stats, start, audited_at)

    source_counts = pipeline["prediction_diagnostics"]
    if type(source_counts) is not dict:
        raise ValueError("artifact_shape")
    counts = {key: source_counts[key] for key in AXIS_COUNTS if key in source_counts}
    if any(type(value) is not int or value < 0 for value in counts.values()):
        raise ValueError("artifact_count")

    if pipeline["prediction_expected"]:
        status = "effective_predictions_present" if count else "zero_effective_prediction"
    elif pipeline["prediction_due"] and window == "delayed_cross_day":
        status = "scheduled_window_missed"
    else:
        status = "prediction_not_expected"
    return {
        "profile": ARTIFACT_PROFILE,
        "run_id": run_id,
        "source_sha": source_sha,
        "status": status,
        "audit_status": audit_status,
        "window_status": window,
        "scheduled_for": scheduled_for.isoformat(timespec="minutes"),
        "observation_started_at": start.isoformat(timespec="seconds"),
        "prediction_target_date": target_date,
        "delay_minutes": delay,
        "effective_predictions": count,
        "predictions_written": written,
        "last_effective_prediction_age_hours": age,
        "prediction_diagnostics": counts,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-dir", type=Path, help="diagnose two extracted public JSON files without network")
    parser.add_argument("--run-jobs", type=Path, help="Jobs API response for the same workflow run's first attempt")
    args = parser.parse_args(argv)
    if (args.artifact_dir is None) != (args.run_jobs is None):
        parser.error("--artifact-dir and --run-jobs must be provided together")
    if args.artifact_dir is not None:
        try:
            result = diagnose_artifact(args.artifact_dir, args.run_jobs)
        except (OSError, KeyError, TypeError, ValueError, OverflowError):
            print(json.dumps({"profile": ARTIFACT_PROFILE, "status": "artifact_unavailable"}))
            return 1
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0
    try:
        # No imported helper's raw provider error may reach the public log.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = run()
    except Exception:
        result = {"profile": "overseas-source-diagnosis-1", "read_only": True, "status": "diagnosis_unavailable"}
    print(json.dumps(result, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    raise SystemExit(main())
