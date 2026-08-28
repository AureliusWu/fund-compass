"""Load the compact, audited QDII evidence artifact shipped with the API."""
from __future__ import annotations

import json
import logging
import math
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


log = logging.getLogger(__name__)
DEFAULT_PATH = Path(__file__).resolve().parents[1] / "data" / "overseas-evidence.json"
MAX_BYTES = 1_000_000
MAX_AGE_SECONDS = 72 * 60 * 60
MAX_FUTURE_SKEW_SECONDS = 5 * 60
BEIJING = timezone(timedelta(hours=8))


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _date(value) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _datetime(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else None


def _path() -> Path:
    return Path(os.environ.get("OVERSEAS_EVIDENCE_PATH", DEFAULT_PATH)).expanduser()


def load_artifact() -> dict:
    path = _path()
    try:
        if path.stat().st_size > MAX_BYTES:
            raise ValueError("artifact exceeds size limit")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if (
            payload.get("schema") != 1
            or payload.get("source_schema") != 2
            or payload.get("alignment_version") != "observation-target-v2"
            or not isinstance(payload.get("models"), dict)
        ):
            raise ValueError("artifact schema is invalid")
        return payload
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        log.warning("QDII v8 evidence artifact unavailable: %s", type(error).__name__)
        return {"schema": 1, "models": {}, "unavailable": True}


def resolve_for_detail(detail: dict, now: datetime | None = None) -> dict | None:
    code = str(detail.get("code") or "")
    if not re.fullmatch(r"\d{6}", code):
        return None
    row = (load_artifact().get("models") or {}).get(code)
    if not isinstance(row, dict):
        return None
    required_dates = {
        key: _date(row.get(key))
        for key in ("prediction_date", "target_nav_date", "base_nav_date")
    }
    base_nav = _number(row.get("base_nav"))
    predicted_change = _number(row.get("predicted_change"))
    predicted_nav = _number(row.get("predicted_nav"))
    coverage = _number(row.get("coverage"))
    if (
        row.get("code") != code
        or any(value is None for value in required_dates.values())
        or base_nav is None or base_nav <= 0
        or predicted_nav is None or predicted_nav <= 0
        or predicted_change is None
        or coverage is None or coverage < 0 or coverage > 100
        or row.get("alignment_version") != "observation-target-v2"
        or row.get("status") not in {"pending", "stale"}
    ):
        return {"usable": False, "rejection_reason": "artifact_row_invalid", "code": code}
    if not (
        required_dates["base_nav_date"] < required_dates["target_nav_date"] <= required_dates["prediction_date"]
    ):
        return {"usable": False, "rejection_reason": "date_axis_invalid", "code": code}
    detail_nav = _number(detail.get("latest_nav"))
    detail_date = _date(detail.get("latest_nav_date"))
    if detail_nav is None or detail_date != required_dates["base_nav_date"] or not math.isclose(
        detail_nav, base_nav, rel_tol=1e-8, abs_tol=1e-8,
    ):
        return {"usable": False, "rejection_reason": "base_nav_mismatch", "code": code}
    observed_at = _datetime(row.get("observed_at"))
    market_time = _datetime(row.get("market_time"))
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("QDII evidence comparison time must include a timezone")
    current = current.astimezone(timezone.utc)
    if (
        observed_at is None or market_time is None
        or observed_at > current + timedelta(seconds=MAX_FUTURE_SKEW_SECONDS)
        or market_time > observed_at
        or market_time > current + timedelta(seconds=MAX_FUTURE_SKEW_SECONDS)
        or market_time.astimezone(BEIJING).date() != required_dates["target_nav_date"]
        or not math.isclose(
            predicted_nav,
            base_nav * (1 + predicted_change / 100),
            rel_tol=1e-4,
            abs_tol=max(1e-6, base_nav * 1e-4),
        )
    ):
        return {"usable": False, "rejection_reason": "artifact_time_or_formula_invalid", "code": code}
    age_seconds = max(0.0, (current - market_time).total_seconds())
    status = "modeled" if row.get("status") == "pending" and age_seconds is not None and age_seconds <= MAX_AGE_SECONDS else "stale"
    sample_number = _number(row.get("sample_count"))
    sample_count = (
        int(sample_number)
        if sample_number is not None and sample_number >= 0 and sample_number.is_integer()
        else None
    )
    mae = _number(row.get("mae"))
    error_p80 = _number(row.get("error_p80"))
    direction_accuracy = _number(row.get("direction_accuracy"))
    if mae is not None and mae < 0 or error_p80 is not None and error_p80 < 0 or (
        direction_accuracy is not None and not 0 <= direction_accuracy <= 100
    ):
        return {"usable": False, "rejection_reason": "accuracy_metrics_invalid", "code": code}
    return {
        "usable": True,
        "code": code,
        "status": status,
        "source": "overseas_accuracy_artifact",
        "prediction_date": required_dates["prediction_date"].isoformat(),
        "target_nav_date": required_dates["target_nav_date"].isoformat(),
        "base_nav_date": required_dates["base_nav_date"].isoformat(),
        "base_nav": base_nav,
        "predicted_change": predicted_change,
        "predicted_nav": predicted_nav,
        "coverage": coverage,
        "model_version": row.get("model_version"),
        "observed_at": row.get("observed_at"),
        "market_time": market_time.astimezone(BEIJING).isoformat(timespec="seconds"),
        "sample_count": sample_count,
        "mae": mae,
        "error_p80": error_p80,
        "direction_accuracy": direction_accuracy,
        "data_age_seconds": age_seconds,
        "observed_age_seconds": max(0.0, (current - observed_at).total_seconds()),
        "alignment_version": row.get("alignment_version"),
    }
