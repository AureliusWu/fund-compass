"""Export a compact, backend-deployable QDII evidence snapshot.

The source ledger remains authoritative.  This exporter only copies rows that
already pass the exact target-date and feature-evidence checks; it never rolls a
missing target forward to the next NAV date.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from pathlib import Path

try:
    from tools.overseas_accuracy import valid_feature_evidence, valid_record_axis
except ModuleNotFoundError:  # direct ``python tools/export_...py`` execution
    from overseas_accuracy import valid_feature_evidence, valid_record_axis


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json"
DEFAULT_OUTPUT = ROOT / "backend" / "data" / "overseas-evidence.json"
ELIGIBLE_STATES = {"pending", "stale"}
BEIJING = dt.timezone(dt.timedelta(hours=8))


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _beijing_datetime(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BEIJING)
    return parsed.astimezone(BEIJING).isoformat(timespec="seconds")


def build_export(ledger: dict) -> dict:
    if ledger.get("schema") != 2 or not isinstance(ledger.get("records"), list):
        raise ValueError("overseas accuracy ledger schema is not v2")
    summary = ledger.get("summary") or {}
    latest: dict[str, dict] = {}
    for row in ledger["records"]:
        if not isinstance(row, dict) or row.get("status") not in ELIGIBLE_STATES:
            continue
        code = str(row.get("code") or "")
        if not (len(code) == 6 and code.isdigit()):
            continue
        if not valid_record_axis(row) or not valid_feature_evidence(row):
            raise ValueError(f"{code} contains invalid target-date evidence")
        current = latest.get(code)
        key = (str(row.get("observed_at") or ""), str(row.get("prediction_date") or ""))
        current_key = (
            str(current.get("observed_at") or ""), str(current.get("prediction_date") or ""),
        ) if current else ("", "")
        if key > current_key:
            latest[code] = row

    models = {}
    for code, row in sorted(latest.items()):
        metrics = summary.get(code) or {}
        if metrics.get("model_version") != row.get("model_version"):
            metrics = {}
        p80 = ((metrics.get("error_percentiles") or {}).get("p80"))
        required_numbers = {
            "base_nav": _number(row.get("base_nav")),
            "predicted_nav": _number(row.get("predicted_nav")),
            "predicted_change": _number(row.get("predicted_change")),
            "coverage": _number(row.get("coverage")),
        }
        if any(value is None for value in required_numbers.values()):
            raise ValueError(f"{code} contains non-finite model values")
        market_time = _beijing_datetime(row.get("quote_time"))
        observed_at = _beijing_datetime(row.get("observed_at"))
        if market_time is None or observed_at is None:
            raise ValueError(f"{code} contains invalid market/observation time")
        samples = _number(metrics.get("samples"))
        if samples is not None and (samples < 0 or not samples.is_integer()):
            raise ValueError(f"{code} contains invalid sample count")
        models[code] = {
            "code": code,
            "name": row.get("name") or code,
            "prediction_date": row["prediction_date"],
            "target_nav_date": row["target_nav_date"],
            "base_nav_date": row["base_nav_date"],
            **required_numbers,
            "model_version": row.get("model_version"),
            "observed_at": observed_at,
            "market_time": market_time,
            "status": row.get("status"),
            "alignment_version": row.get("alignment_version"),
            "sample_count": int(samples) if samples is not None else None,
            "mae": _number(metrics.get("mae")),
            "error_p80": _number(p80),
            "direction_accuracy": _number(metrics.get("direction_accuracy")),
            "accuracy_status": metrics.get("status"),
        }
    return {
        "schema": 1,
        "source_schema": ledger.get("schema"),
        "source_updated_at": ledger.get("updated_at"),
        "alignment_version": "observation-target-v2",
        "models": models,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    ledger = json.loads(args.input.read_text(encoding="utf-8"))
    payload = build_export(ledger)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"exported {len(payload['models'])} exact QDII evidence row(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
