#!/usr/bin/env python3
"""Read-only source/date diagnosis. Never produces forecasts or writes a ledger."""
import contextlib
import datetime as dt
import io
import json
import os
import re
import urllib.error
import urllib.request

try:
    from tools import overseas_accuracy as producer
except ModuleNotFoundError:
    import overseas_accuracy as producer

MAX_BODY = 4 * 1024 * 1024


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


def main():
    try:
        # No imported helper's raw provider error may reach the public log.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = run()
    except Exception:
        result = {"profile": "overseas-source-diagnosis-1", "read_only": True, "status": "diagnosis_unavailable"}
    print(json.dumps(result, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
