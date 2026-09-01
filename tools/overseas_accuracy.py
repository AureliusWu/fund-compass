#!/usr/bin/env python3
"""记录海外基金当时估值，并在对应净值公布后结算误差。纯 stdlib。"""
import datetime as dt
import json
import math
import os
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "frontend" / "src" / "data" / "overseas-models.json"
LEDGER = ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json"


def normalize_api_base(value: str | None) -> str:
    return (value or "").strip().rstrip("/")


FUND_API_BASE = normalize_api_base(os.environ.get("FUND_API_BASE"))
CST = dt.timezone(dt.timedelta(hours=8))


def require_api_base() -> str:
    if not FUND_API_BASE:
        raise RuntimeError("FUND_API_BASE is required")
    return FUND_API_BASE


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


SCHEDULE_TIME = os.environ.get("OVERSEAS_SCHEDULE_TIME", "14:35")
PREDICTION_EARLY_MINUTES = max(0, env_int("OVERSEAS_PREDICTION_EARLY_MINUTES", 5))
PREDICTION_LATE_MINUTES = max(0, env_int("OVERSEAS_PREDICTION_LATE_MINUTES", 45))
MAX_BASE_AGE_DAYS = max(1, env_int("OVERSEAS_MAX_BASE_AGE_DAYS", 7))
RUN_MODE = os.environ.get(
    "OVERSEAS_RUN_MODE",
    "scheduled" if os.environ.get("GITHUB_EVENT_NAME") == "schedule" else "manual",
).strip().lower()
NON_TRADING_DATES = {
    value.strip()
    for value in os.environ.get("OVERSEAS_NON_TRADING_DATES", "").split(",")
    if value.strip()
}

# The fund NAV date follows the domestic fund calendar.  Keep the calendar
# bundled and reviewable: a missing CI secret must never turn a holiday into a
# trading day.  2025 is included only to make the 2026 New Year boundary exact.
# Source: Shanghai Stock Exchange annual closure notices.
CALENDAR_SOURCE = "https://www.sse.com.cn/disclosure/dealinstruc/closed/"
BUILTIN_NON_TRADING_DATES = {
    # 2025
    "2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
    "2025-02-03", "2025-02-04", "2025-04-04", "2025-05-01", "2025-05-02",
    "2025-05-05", "2025-06-02", "2025-10-01", "2025-10-02", "2025-10-03",
    "2025-10-06", "2025-10-07", "2025-10-08",
    # 2026
    "2026-01-01", "2026-01-02", "2026-02-16", "2026-02-17", "2026-02-18",
    "2026-02-19", "2026-02-20", "2026-02-23", "2026-04-06", "2026-05-01",
    "2026-05-04", "2026-05-05", "2026-06-19", "2026-09-25", "2026-10-01",
    "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
}
SUPPORTED_CALENDAR_YEARS = {2025, 2026}


def request_bytes(url: str, timeout=30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "sinan-overseas-audit"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def parse_market_time(value: str) -> dt.datetime | None:
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y%m%d%H%M%S"):
        try:
            return dt.datetime.strptime(value, pattern)
        except (TypeError, ValueError):
            continue
    return None


def fetch_quotes(codes: set[str]) -> dict[str, dict]:
    if not codes:
        return {}
    raw = request_bytes(f"https://qt.gtimg.cn/q={','.join(sorted(codes))}").decode("gb18030", "replace")
    output = {}
    for code, body in re.findall(r'v_([\w]+)="([^"]*)"', raw):
        fields = body.split("~")
        if len(fields) > 32:
            try:
                value = float(fields[32])
                market_time = fields[30].strip()
                quote_stamp = parse_market_time(market_time)
                if math.isfinite(value) and quote_stamp is not None:
                    output[code] = {
                        "change": value,
                        "quote_date": quote_stamp.date().isoformat(),
                        # Tencent does not declare a timezone for this exchange
                        # timestamp, so retain the source value without inventing one.
                        "quote_time": market_time,
                        "source": "tencent_quote",
                    }
            except ValueError:
                pass
    return output


def build_run_context(
    now: dt.datetime,
    *,
    run_mode: str = RUN_MODE,
    schedule_time: str = SCHEDULE_TIME,
    early_minutes: int = PREDICTION_EARLY_MINUTES,
    late_minutes: int = PREDICTION_LATE_MINUTES,
    non_trading_dates: set[str] | None = None,
) -> dict:
    """Describe whether this invocation may and must produce a prediction."""
    local_now = now.astimezone(CST) if now.tzinfo else now.replace(tzinfo=CST)
    normalized_mode = run_mode.strip().lower() if isinstance(run_mode, str) else "manual"
    try:
        hour_text, minute_text = schedule_time.split(":", 1)
        scheduled_time = dt.time(int(hour_text), int(minute_text), tzinfo=CST)
    except (AttributeError, TypeError, ValueError):
        scheduled_time = dt.time(14, 35, tzinfo=CST)
    scheduled_for = dt.datetime.combine(local_now.date(), scheduled_time)
    if normalized_mode == "scheduled" and (
        scheduled_for.weekday() >= 5
        or local_now < scheduled_for - dt.timedelta(minutes=max(0, early_minutes))
    ):
        # A schedule event cannot legitimately run before its own window.  If a
        # weekday cron appears before today's window (or on a weekend), bind it
        # to the latest weekday occurrence so a queue delay crossing midnight
        # is explicit instead of looking like an early same-day observation.
        scheduled_date = local_now.date() - dt.timedelta(days=1)
        while scheduled_date.weekday() >= 5:
            scheduled_date -= dt.timedelta(days=1)
        scheduled_for = dt.datetime.combine(scheduled_date, scheduled_time)
    delay_minutes = round((local_now - scheduled_for).total_seconds() / 60, 2)
    cross_day = normalized_mode == "scheduled" and scheduled_for.date() != local_now.date()
    excluded = non_trading_dates if non_trading_dates is not None else NON_TRADING_DATES
    calendar_date = scheduled_for.date() if normalized_mode == "scheduled" else local_now.date()
    try:
        trading_day = is_fund_trading_day(calendar_date, excluded)
        target_date = previous_trading_date(calendar_date, excluded)
        calendar_supported = True
    except ValueError:
        trading_day = False
        target_date = None
        calendar_supported = False
    prediction_due = normalized_mode == "scheduled" and trading_day
    prediction_allowed = prediction_due and not cross_day and delay_minutes >= -max(0, early_minutes)
    if not calendar_supported:
        window_status = "calendar_unsupported"
    elif not trading_day:
        window_status = "non_trading_day"
    elif cross_day:
        window_status = "delayed_cross_day"
    elif delay_minutes < -max(0, early_minutes):
        window_status = "too_early"
    elif delay_minutes > max(0, late_minutes):
        # GitHub scheduled jobs can start hours late.  A same-calendar-day run
        # is still usable if every source quote proves the intended target date.
        window_status = "delayed_same_day"
    else:
        window_status = "open"
    return {
        "run_mode": normalized_mode,
        "scheduled_for": scheduled_for.isoformat(timespec="minutes"),
        "delay_minutes": delay_minutes,
        "observation_date": local_now.date().isoformat(),
        "scheduled_observation_date": scheduled_for.date().isoformat(),
        "calendar_supported": calendar_supported,
        "trading_day": trading_day,
        "prediction_due": prediction_due,
        "prediction_expected": prediction_allowed,
        "prediction_allowed": prediction_allowed,
        "prediction_window_status": window_status,
        "prediction_target_date": target_date.isoformat() if target_date else None,
    }


def calculate_model(model: dict, quotes: dict[str, dict], target_date: str) -> dict | None:
    def calculate(candidate: dict) -> dict | None:
        available = []
        for leg in candidate.get("legs") or []:
            code = leg.get("code")
            evidence = quotes.get(code)
            if not isinstance(evidence, dict) or evidence.get("quote_date") != target_date:
                continue
            change = _number(evidence.get("change"))
            weight = _number(leg.get("weight"))
            if code and change is not None and weight is not None and weight > 0:
                available.append((leg, change, weight, evidence))
        coverage = sum(weight for _, _, weight, _ in available)
        min_weight = _number(candidate.get("min_weight")) or 0
        if coverage < min_weight or not available:
            return None
        raw_change = sum(change * weight for _, change, weight, _ in available) / coverage
        scale = _number(candidate.get("scale", 1))
        bias = _number(candidate.get("bias", 0))
        if scale is None or bias is None:
            return None
        predicted_change = raw_change * scale + bias
        if not math.isfinite(predicted_change):
            return None
        return {
            "raw_change": round(raw_change, 6),
            "predicted_change": round(predicted_change, 4),
            "coverage": round(coverage, 2),
            "features": {leg["code"]: change for leg, change, _, _ in available},
            "feature_evidence": {
                leg["code"]: {
                    "change": change,
                    "quote_date": evidence["quote_date"],
                    "quote_time": evidence.get("quote_time"),
                    "source": evidence.get("source"),
                }
                for leg, change, _, evidence in available
            },
            "model_label": candidate.get("label") or "海外模型",
            "fallback_used": candidate is not model,
        }

    return calculate(model) or (calculate(model["fallback"]) if isinstance(model.get("fallback"), dict) else None)


def _history_nav(detail: dict, value_date: str) -> float | None:
    matches = [
        _float(point.get("nav"))
        for point in (detail.get("nav_history") or [])
        if point.get("date") == value_date
    ]
    return matches[-1] if matches else None


def _calendar_exclusions(non_trading_dates: set[str] | None = None) -> set[str]:
    return BUILTIN_NON_TRADING_DATES | (
        non_trading_dates if non_trading_dates is not None else NON_TRADING_DATES
    )


def is_fund_trading_day(value: dt.date, non_trading_dates: set[str] | None = None) -> bool:
    if value.year not in SUPPORTED_CALENDAR_YEARS:
        raise ValueError(f"unsupported fund calendar year: {value.year}")
    return value.weekday() < 5 and value.isoformat() not in _calendar_exclusions(non_trading_dates)


def previous_trading_date(target: dt.date, non_trading_dates: set[str] | None = None) -> dt.date:
    """Return the immediately preceding audited domestic fund trading date."""
    candidate = target - dt.timedelta(days=1)
    while not is_fund_trading_day(candidate, non_trading_dates):
        candidate -= dt.timedelta(days=1)
    return candidate


def resolve_prediction_axis(
    detail: dict,
    observation_date: str,
    max_age_days: int = MAX_BASE_AGE_DAYS,
    non_trading_dates: set[str] | None = None,
) -> tuple[str, str, float] | None:
    """Resolve observation T -> target T-1 -> official base T-2.

    Calendar dates establish the expected axis; NAV history and the top-level
    latest NAV independently corroborate the base.  Any gap fails closed.
    """
    latest_date = detail.get("latest_nav_date")
    latest_nav = _float(detail.get("latest_nav"))
    try:
        observation = dt.date.fromisoformat(observation_date)
        target = previous_trading_date(observation, non_trading_dates)
        expected_base = previous_trading_date(target, non_trading_dates)
        base = dt.date.fromisoformat(latest_date)
    except (TypeError, ValueError):
        return None
    history_nav = _history_nav(detail, latest_date)
    if (
        latest_nav is None
        or history_nav is None
        or base != expected_base
        or (target - base).days > max_age_days
        or not math.isclose(latest_nav, history_nav, rel_tol=1e-8, abs_tol=1e-8)
    ):
        return None
    return target.isoformat(), latest_date, latest_nav


def official_base(
    detail: dict,
    target_date: str,
    max_age_days: int = MAX_BASE_AGE_DAYS,
    non_trading_dates: set[str] | None = None,
) -> tuple[str, float] | None:
    """Compatibility helper for callers that already resolved the target."""
    latest_date = detail.get("latest_nav_date")
    latest_nav = _float(detail.get("latest_nav"))
    try:
        target = dt.date.fromisoformat(target_date)
        base = dt.date.fromisoformat(latest_date)
        if not is_fund_trading_day(target, non_trading_dates):
            return None
        expected_base = previous_trading_date(target, non_trading_dates)
    except (TypeError, ValueError):
        return None
    history_nav = _history_nav(detail, latest_date)
    if (
        latest_nav is None
        or history_nav is None
        or base != expected_base
        or (target - base).days > max_age_days
        or not math.isclose(latest_nav, history_nav, rel_tol=1e-8, abs_tol=1e-8)
    ):
        return None
    return latest_date, latest_nav


def valid_record_axis(row: dict, non_trading_dates: set[str] | None = None) -> bool:
    try:
        observation = dt.date.fromisoformat(row["prediction_date"])
        target = dt.date.fromisoformat(row["target_nav_date"])
        base = dt.date.fromisoformat(row["base_nav_date"])
        return (
            target == previous_trading_date(observation, non_trading_dates)
            and base == previous_trading_date(target, non_trading_dates)
        )
    except (KeyError, TypeError, ValueError):
        return False


def valid_feature_evidence(row: dict) -> bool:
    features = row.get("features")
    evidence = row.get("feature_evidence")
    target_date = row.get("target_nav_date")
    if not isinstance(features, dict) or not features or not isinstance(evidence, dict):
        return False
    if set(features) != set(evidence):
        return False
    for code, feature_value in features.items():
        item = evidence.get(code)
        if not isinstance(item, dict) or item.get("quote_date") != target_date:
            return False
        feature_number = _number(feature_value)
        evidence_number = _number(item.get("change"))
        if (
            feature_number is None
            or evidence_number is None
            or not math.isclose(feature_number, evidence_number, rel_tol=1e-8, abs_tol=1e-8)
            or not isinstance(item.get("quote_time"), str)
            or not item["quote_time"].strip()
            or not isinstance(item.get("source"), str)
            or not item["source"].strip()
        ):
            return False
    return True


def add_predictions(
    ledger: dict,
    registry: dict,
    quotes: dict[str, dict],
    details: dict[str, dict],
    now: dt.datetime,
    *,
    scheduled_for: str | None = None,
    delay_minutes: float | None = None,
    max_base_age_days: int = MAX_BASE_AGE_DAYS,
    non_trading_dates: set[str] | None = None,
) -> int:
    existing = {
        (row.get("code"), row.get("prediction_date"), row.get("model_version"))
        for row in ledger.get("records", [])
    }
    written = 0
    local_now = now.astimezone(CST) if now.tzinfo else now.replace(tzinfo=CST)
    observation_date = local_now.date().isoformat()
    try:
        if not is_fund_trading_day(local_now.date(), non_trading_dates):
            return 0
    except ValueError:
        return 0
    for code, entry in registry["models"].items():
        detail = details.get(code) or {}
        active = entry["active"]
        key = (code, observation_date, active["version"])
        axis = resolve_prediction_axis(detail, observation_date, max_base_age_days, non_trading_dates)
        if key in existing or axis is None:
            continue
        target_date, base_nav_date, base_nav = axis
        prediction = calculate_model(active, quotes, target_date)
        if not prediction:
            continue
        quote_times = [
            evidence.get("quote_time")
            for evidence in prediction.get("feature_evidence", {}).values()
            if evidence.get("quote_time")
        ]
        ledger.setdefault("records", []).append({
            "code": code,
            "name": detail.get("name") or entry.get("name") or code,
            "prediction_date": observation_date,
            "target_nav_date": target_date,
            "base_nav_date": base_nav_date,
            "base_nav": base_nav,
            "predicted_nav": round(base_nav * (1 + prediction["predicted_change"] / 100), 4),
            "model_version": active["version"],
            "observed_at": local_now.isoformat(timespec="seconds"),
            "quote_time": max(quote_times) if quote_times else None,
            "scheduled_for": scheduled_for,
            "delay_minutes": delay_minutes,
            "calendar_source": CALENDAR_SOURCE,
            "alignment_version": "observation-target-v2",
            "status": "pending",
            **prediction,
        })
        written += 1
    return written


def settle_records(ledger: dict, details: dict[str, dict], now: dt.datetime | None = None) -> int:
    settled_at = (now or dt.datetime.now(CST)).isoformat(timespec="seconds")
    settled = 0
    for row in ledger.get("records", []):
        if row.get("status") not in ("pending", "stale", "market_closed"):
            continue
        detail = details.get(row.get("code"), {})
        history = {point.get("date"): _float(point.get("nav")) for point in (detail.get("nav_history") or [])}
        actual_nav = history.get(row.get("target_nav_date"))
        base_history_nav = history.get(row.get("base_nav_date"))
        base_nav = _float(row.get("base_nav"))
        try:
            target_date = dt.date.fromisoformat(row["target_nav_date"])
            base_date = dt.date.fromisoformat(row["base_nav_date"])
        except (KeyError, TypeError, ValueError):
            continue
        if (
            actual_nav is None
            or base_nav is None
            or base_history_nav is None
            or not valid_record_axis(row)
            or not valid_feature_evidence(row)
            or not math.isclose(base_nav, base_history_nav, rel_tol=1e-8, abs_tol=1e-8)
        ):
            continue
        predicted_change = _number(row.get("predicted_change"))
        if predicted_change is None:
            continue
        actual_change = (actual_nav / base_nav - 1) * 100
        error = predicted_change - actual_change
        row.update({
            "actual_nav": round(actual_nav, 4),
            "actual_change": round(actual_change, 4),
            "error": round(error, 4),
            "absolute_error": round(abs(error), 4),
            "direction_hit": (predicted_change >= 0) == (actual_change >= 0),
            "status": "settled",
            "settled_at": settled_at,
            "settlement_note": "按目标净值日精确匹配官方净值",
        })
        settled += 1
    return settled


def migrate_legacy_misaligned_records(ledger: dict) -> int:
    """Retain old rows but quarantine the former T == target date axis."""
    changed = 0
    for row in ledger.get("records", []):
        if not isinstance(row, dict) or row.get("status") in ("observed_only", "legacy_misaligned"):
            continue
        prediction_date = row.get("prediction_date")
        if prediction_date and prediction_date == row.get("target_nav_date"):
            row["legacy_status"] = row.get("status")
            row["status"] = "legacy_misaligned"
            row["excluded_from_metrics"] = True
            row["legacy_misalignment_reason"] = (
                "旧口径将观察日同时当作目标净值日，无法证明行情与净值归属日对齐"
            )
            changed += 1
    if changed:
        ledger["schema"] = 2
        ledger.pop("schema_version", None)
        ledger["evidence_migration"] = {
            "id": "observation-target-v2",
            "applied_at": dt.datetime.now(CST).isoformat(timespec="seconds"),
            "legacy_records_retained": sum(
                isinstance(row, dict) and row.get("status") == "legacy_misaligned"
                for row in ledger.get("records", [])
            ),
        }
        pipeline = ledger.setdefault("pipeline", {})
        pipeline["alignment_version"] = "observation-target-v2"
        pipeline["legacy_misaligned_records"] = sum(
            isinstance(row, dict) and row.get("status") == "legacy_misaligned"
            for row in ledger.get("records", [])
        )
        for current_key, legacy_key in (
            ("last_prediction_at", "legacy_last_prediction_at"),
            ("last_settlement_at", "legacy_last_settlement_at"),
        ):
            if pipeline.get(current_key) and not pipeline.get(legacy_key):
                pipeline[legacy_key] = pipeline[current_key]
            pipeline.pop(current_key, None)
        valid_rows = [row for row in ledger.get("records", []) if valid_record_axis(row)]
        valid_predictions = [row.get("observed_at") for row in valid_rows if row.get("observed_at")]
        valid_settlements = [
            row.get("settled_at") for row in valid_rows
            if row.get("status") == "settled" and row.get("settled_at")
        ]
        if valid_predictions:
            pipeline["last_effective_prediction_at"] = max(valid_predictions)
        else:
            pipeline.pop("last_effective_prediction_at", None)
        if valid_settlements:
            pipeline["last_effective_settlement_at"] = max(valid_settlements)
        else:
            pipeline.pop("last_effective_settlement_at", None)
        pipeline.pop("effective_predictions_for_target", None)
        pipeline.pop("last_expected_zero_prediction_target_date", None)
    return changed


def update_pending_states(ledger: dict, today: dt.date) -> None:
    for row in ledger.get("records", []):
        if row.get("status") not in ("pending", "stale", "market_closed"):
            continue
        try:
            target = dt.date.fromisoformat(row["target_nav_date"])
        except (KeyError, TypeError, ValueError):
            row["status"] = "stale"
            row["settlement_note"] = "目标净值日期无效，等待人工审计"
            continue
        waiting = max(0, (today - target).days)
        row["waiting_days"] = waiting
        try:
            target_is_trading_day = is_fund_trading_day(target)
        except ValueError:
            target_is_trading_day = False
        if not target_is_trading_day:
            row["status"] = "market_closed"
            row["settlement_note"] = "目标日非已审计交易日，不参与训练并等待人工确认"
        elif waiting > 7:
            row["status"] = "stale"
            row["settlement_note"] = "超过 7 天仍无对应净值，不自动顺延配对"
        else:
            row["status"] = "pending"
            row["settlement_note"] = "等待同一归属日净值公布"


def percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * ratio
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def window_metrics(rows: list[dict], size: int) -> dict | None:
    selected = rows[-size:]
    if not selected:
        return None
    errors = [float(row["error"]) for row in selected]
    return {
        "samples": len(selected),
        "mae": round(sum(abs(value) for value in errors) / len(errors), 3),
        "bias": round(sum(errors) / len(errors), 3),
        "direction_accuracy": round(sum(bool(row["direction_hit"]) for row in selected) / len(selected) * 100, 1),
    }


def summarize(ledger: dict, registry: dict) -> dict:
    output = {}
    for code, entry in registry["models"].items():
        active_version = (entry.get("active") or {}).get("version")
        rows = sorted(
            [
                row for row in ledger.get("records", [])
                if row.get("code") == code
                and row.get("model_version") == active_version
                and row.get("status") == "settled"
                and valid_record_axis(row)
                and valid_feature_evidence(row)
            ],
            key=lambda row: row["target_nav_date"],
        )
        errors = [float(row["error"]) for row in rows]
        samples = len(rows)
        mae = sum(abs(value) for value in errors) / samples if samples else None
        sorted_abs = sorted(abs(value) for value in errors)
        p80 = sorted_abs[min(len(sorted_abs) - 1, int(len(sorted_abs) * 0.8))] if sorted_abs else None
        status = (entry.get("governance") or {}).get("status") or "collecting"
        confidence = "样本积累中" if samples < 20 else "较高" if mae is not None and mae <= 1 else "中等" if mae is not None and mae <= 2 else "偏低"
        output[code] = {
            "samples": samples,
            "status": status,
            "confidence": confidence,
            "mae": round(mae, 3) if mae is not None else None,
            "bias": round(sum(errors) / samples, 3) if samples else None,
            "direction_accuracy": round(sum(bool(row["direction_hit"]) for row in rows) / samples * 100, 1) if samples else None,
            "error_band": round(p80, 3) if p80 is not None else None,
            "error_percentiles": {
                "p50": round(percentile(sorted_abs, 0.5), 3) if sorted_abs else None,
                "p80": round(percentile(sorted_abs, 0.8), 3) if sorted_abs else None,
                "p95": round(percentile(sorted_abs, 0.95), 3) if sorted_abs else None,
            },
            "rolling_5": window_metrics(rows, 5),
            "rolling_20": window_metrics(rows, 20),
            "pending": sum(
                row.get("code") == code and row.get("model_version") == active_version
                and row.get("status") == "pending"
                for row in ledger.get("records", [])
            ),
            "stale": sum(
                row.get("code") == code and row.get("model_version") == active_version
                and row.get("status") in ("stale", "market_closed")
                for row in ledger.get("records", [])
            ),
            "legacy_misaligned": sum(
                row.get("code") == code and row.get("status") == "legacy_misaligned"
                for row in ledger.get("records", [])
            ),
            "model_version": active_version,
        }
    return output


def fetch_details(codes: list[str]) -> dict[str, dict]:
    api_base = require_api_base()
    output = {}
    for code in codes:
        try:
            output[code] = json.loads(request_bytes(f"{api_base}/api/fund/{code}", timeout=90).decode("utf-8"))
        except Exception as ex:
            print(f"detail unavailable {code}: {ex}")
    return output


def count_effective_predictions(ledger: dict, registry: dict, observation_date: str) -> int:
    versions = {
        code: (entry.get("active") or {}).get("version")
        for code, entry in (registry.get("models") or {}).items()
    }
    return sum(
        row.get("prediction_date") == observation_date
        and versions.get(row.get("code")) == row.get("model_version")
        and row.get("status") in ("pending", "settled", "stale")
        and valid_record_axis(row)
        and valid_feature_evidence(row)
        and _float(row.get("base_nav")) is not None
        and _number(row.get("predicted_change")) is not None
        for row in ledger.get("records", [])
    )


def write_json_atomic(path: Path, value: dict) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def _float(value):
    number = _number(value)
    return number if number is not None and number > 0 else None


def _number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def run_pipeline(now: dt.datetime | None = None, *, run_mode: str | None = None) -> dict:
    require_api_base()
    now = now or dt.datetime.now(CST)
    now = now.astimezone(CST) if now.tzinfo else now.replace(tzinfo=CST)
    run = build_run_context(now, run_mode=run_mode or RUN_MODE)
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    ledger["schema"] = 2
    ledger.pop("schema_version", None)
    migrated = migrate_legacy_misaligned_records(ledger)
    codes = list(registry["models"])
    details = fetch_details(codes)
    settled = settle_records(ledger, details, now)
    quote_codes = {
        leg["code"]
        for entry in registry["models"].values()
        for model in [entry["active"], entry["active"].get("fallback")]
        if model for leg in model["legs"]
    }
    quotes = {}
    quote_error = None
    if run["prediction_allowed"]:
        try:
            quotes = fetch_quotes(quote_codes)
        except Exception as ex:
            quote_error = type(ex).__name__
            print(f"quote feed unavailable: {quote_error}")
    written = 0
    if run["prediction_allowed"]:
        written = add_predictions(
            ledger,
            registry,
            quotes,
            details,
            now,
            scheduled_for=run["scheduled_for"],
            delay_minutes=run["delay_minutes"],
        )
    update_pending_states(ledger, now.date())
    ledger["updated_at"] = now.isoformat(timespec="seconds")
    pipeline = ledger.setdefault("pipeline", {})
    effective_for_observation = count_effective_predictions(ledger, registry, run["observation_date"])
    try:
        previous_zero_runs = max(0, int(pipeline.get("consecutive_expected_zero_prediction_runs") or 0))
    except (TypeError, ValueError):
        previous_zero_runs = 0
    if run["prediction_expected"]:
        if effective_for_observation == 0:
            already_counted = pipeline.get("last_expected_zero_prediction_observation_date") == run["observation_date"]
            zero_runs = previous_zero_runs if already_counted else previous_zero_runs + 1
            zero_observation_date = run["observation_date"]
        else:
            zero_runs = 0
            zero_observation_date = None
    else:
        zero_runs = previous_zero_runs
        zero_observation_date = pipeline.get("last_expected_zero_prediction_observation_date")
    pipeline.update({
        "last_run_at": now.isoformat(timespec="seconds"),
        "heartbeat_at": now.isoformat(timespec="seconds"),
        "run_mode": run["run_mode"],
        "scheduled_for": run["scheduled_for"],
        "delay_minutes": run["delay_minutes"],
        "observation_date": run["observation_date"],
        "scheduled_observation_date": run["scheduled_observation_date"],
        "calendar_supported": run["calendar_supported"],
        "calendar_source": CALENDAR_SOURCE,
        "alignment_version": "observation-target-v2",
        "trading_day": run["trading_day"],
        "prediction_due": run["prediction_due"],
        "prediction_expected": run["prediction_expected"],
        "prediction_window_status": run["prediction_window_status"],
        "prediction_target_date": run["prediction_target_date"],
        "expected_models": len(registry.get("models") or {}),
        "effective_predictions_for_observation": effective_for_observation,
        "consecutive_expected_zero_prediction_runs": zero_runs,
        "last_expected_zero_prediction_observation_date": zero_observation_date,
        "predictions_written": written,
        "settlements_written": settled,
        "legacy_records_migrated": migrated,
        "quotes_count": len(quotes),
        "details_count": len(details),
        "quote_error": quote_error,
    })
    if written:
        pipeline["last_prediction_at"] = now.isoformat(timespec="seconds")
        pipeline["last_effective_prediction_at"] = now.isoformat(timespec="seconds")
    if settled:
        pipeline["last_settlement_at"] = now.isoformat(timespec="seconds")
        pipeline["last_effective_settlement_at"] = now.isoformat(timespec="seconds")
    ledger["summary"] = summarize(ledger, registry)
    ledger["records"] = ledger.get("records", [])[-1000:]
    write_json_atomic(LEDGER, ledger)
    print(
        "overseas accuracy: "
        f"mode={run['run_mode']}, window={run['prediction_window_status']}, "
        f"predictions={written}, effective={effective_for_observation}, "
        f"settled={settled}, quotes={len(quotes)}"
    )
    return {
        "predictions_written": written,
        "settlements_written": settled,
        "effective_predictions_for_observation": effective_for_observation,
        "run": run,
    }


def main() -> None:
    run_pipeline()


if __name__ == "__main__":
    main()
