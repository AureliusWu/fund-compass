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


def diagnose_artifact(directory):
    """Summarize the two public JSONs extracted from a single Actions artifact."""
    ledger_path = directory / "frontend/public/data/overseas-accuracy.json"
    if not ledger_path.is_file():
        ledger_path = directory / "overseas-accuracy.json"
    pipeline = read_artifact(ledger_path)["pipeline"]
    audit = read_artifact(ledger_path.with_name("overseas-audit.json"))
    stats = audit["stats"]
    window = pipeline["prediction_window_status"]
    audit_status = audit["status"]
    if window not in WINDOWS or audit_status not in {"healthy", "warning", "failed"}:
        raise ValueError("artifact_shape")

    start = dt.datetime.fromisoformat(pipeline["last_run_at"])
    audited_at = dt.datetime.fromisoformat(audit["updated_at"])
    scheduled_for = dt.datetime.fromisoformat(pipeline["scheduled_for"])
    target = pipeline["prediction_target_date"]
    target_date = None if target is None else dt.date.fromisoformat(target).isoformat()
    if any(value.utcoffset() is None for value in (start, audited_at, scheduled_for)):
        raise ValueError("artifact_time")
    if not dt.timedelta(0) <= audited_at - start <= dt.timedelta(minutes=12):
        raise ValueError("artifact_time")

    shared = {"prediction_due": bool, "prediction_expected": bool,
              "effective_predictions_for_observation": int}
    for key, kind in shared.items():
        if type(pipeline[key]) is not kind or type(stats[key]) is not kind or pipeline[key] != stats[key]:
            raise ValueError("artifact_mismatch")
    count = pipeline["effective_predictions_for_observation"]
    written = pipeline["predictions_written"]
    delay = pipeline["delay_minutes"]
    age = stats["prediction_effective_age_hours"]
    if count < 0 or type(written) is not int or written < 0 or written > count:
        raise ValueError("artifact_count")
    if type(delay) not in (int, float) or not math.isfinite(delay):
        raise ValueError("artifact_time")
    if age is not None and (type(age) not in (int, float) or not math.isfinite(age) or age < 0):
        raise ValueError("artifact_time")

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
    args = parser.parse_args(argv)
    if args.artifact_dir is not None:
        try:
            result = diagnose_artifact(args.artifact_dir)
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
