#!/usr/bin/env python3
"""记录海外基金当时估值，并在对应净值公布后结算误差。纯 stdlib。"""
import datetime as dt
import json
import os
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "frontend" / "src" / "data" / "overseas-models.json"
LEDGER = ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json"
FUND_API_BASE = os.environ.get("FUND_API_BASE", "https://fund-compass-api.onrender.com").rstrip("/")
CST = dt.timezone(dt.timedelta(hours=8))


def request_bytes(url: str, timeout=30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "sinan-overseas-audit"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def fetch_fundgz(code: str) -> dict | None:
    raw = request_bytes(f"https://fundgz.1234567.com.cn/js/{code}.js").decode("utf-8")
    match = re.search(r"jsonpgz\((.*)\)", raw)
    return json.loads(match.group(1)) if match else None


def fetch_quotes(codes: set[str]) -> dict[str, float]:
    if not codes:
        return {}
    raw = request_bytes(f"https://qt.gtimg.cn/q={','.join(sorted(codes))}").decode("gb18030", "replace")
    output = {}
    for code, body in re.findall(r'v_([\w]+)="([^"]*)"', raw):
        fields = body.split("~")
        if len(fields) > 32:
            try:
                output[code] = float(fields[32])
            except ValueError:
                pass
    return output


def calculate_model(model: dict, quotes: dict[str, float]) -> dict | None:
    def calculate(candidate: dict) -> dict | None:
        available = [(leg, quotes[leg["code"]]) for leg in candidate["legs"] if leg["code"] in quotes]
        coverage = sum(float(leg["weight"]) for leg, _ in available)
        if coverage < float(candidate.get("min_weight") or 0) or not available:
            return None
        raw_change = sum(change * float(leg["weight"]) for leg, change in available) / coverage
        scale = float(candidate.get("scale", 1))
        bias = float(candidate.get("bias", 0))
        return {
            "raw_change": round(raw_change, 6),
            "predicted_change": round(raw_change * scale + bias, 4),
            "coverage": round(coverage, 2),
            "features": {leg["code"]: change for leg, change in available},
            "model_label": candidate["label"],
            "fallback_used": candidate is not model,
        }

    return calculate(model) or (calculate(model["fallback"]) if model.get("fallback") else None)


def add_predictions(ledger: dict, registry: dict, quotes: dict[str, float], fund_data: dict[str, dict], now: dt.datetime) -> int:
    existing = {
        (row.get("code"), row.get("prediction_date"), row.get("model_version"))
        for row in ledger.get("records", [])
    }
    written = 0
    target_date = now.date().isoformat()
    for code, entry in registry["models"].items():
        data = fund_data.get(code) or {}
        active = entry["active"]
        key = (code, target_date, active["version"])
        base_nav = _float(data.get("dwjz"))
        if key in existing or not base_nav or not data.get("jzrq"):
            continue
        prediction = calculate_model(active, quotes)
        if not prediction:
            continue
        ledger.setdefault("records", []).append({
            "code": code,
            "name": data.get("name") or entry.get("name") or code,
            "prediction_date": target_date,
            "target_nav_date": target_date,
            "base_nav_date": data["jzrq"],
            "base_nav": base_nav,
            "predicted_nav": round(base_nav * (1 + prediction["predicted_change"] / 100), 4),
            "model_version": active["version"],
            "quote_time": now.isoformat(timespec="seconds"),
            "status": "pending",
            **prediction,
        })
        written += 1
    return written


def settle_records(ledger: dict, details: dict[str, dict]) -> int:
    settled = 0
    for row in ledger.get("records", []):
        if row.get("status") not in ("pending", "stale", "market_closed"):
            continue
        history = {
            point.get("date"): _float(point.get("nav"))
            for point in (details.get(row["code"], {}).get("nav_history") or [])
        }
        actual_nav = history.get(row["target_nav_date"])
        if not actual_nav:
            continue
        actual_change = (actual_nav / row["base_nav"] - 1) * 100
        error = row["predicted_change"] - actual_change
        row.update({
            "actual_nav": round(actual_nav, 4),
            "actual_change": round(actual_change, 4),
            "error": round(error, 4),
            "absolute_error": round(abs(error), 4),
            "direction_hit": (row["predicted_change"] >= 0) == (actual_change >= 0),
            "status": "settled",
            "settlement_note": "按预测目标日精确匹配已公布净值",
        })
        settled += 1
    return settled


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
        if target.weekday() >= 5:
            row["status"] = "market_closed"
            row["settlement_note"] = "目标日为周末，不参与训练并等待人工确认"
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
        rows = sorted(
            [row for row in ledger.get("records", []) if row.get("code") == code and row.get("status") == "settled"],
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
                row.get("code") == code and row.get("status") == "pending"
                for row in ledger.get("records", [])
            ),
            "stale": sum(
                row.get("code") == code and row.get("status") in ("stale", "market_closed")
                for row in ledger.get("records", [])
            ),
            "model_version": entry["active"]["version"],
        }
    return output


def fetch_details(codes: list[str]) -> dict[str, dict]:
    output = {}
    for code in codes:
        try:
            output[code] = json.loads(request_bytes(f"{FUND_API_BASE}/api/fund/{code}", timeout=90).decode("utf-8"))
        except Exception as ex:
            print(f"detail unavailable {code}: {ex}")
    return output


def write_json_atomic(path: Path, value: dict) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def _float(value):
    try:
        number = float(value)
        return number if number > 0 else None
    except (TypeError, ValueError):
        return None


def main() -> None:
    now = dt.datetime.now(CST)
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    codes = list(registry["models"])
    details = fetch_details(codes)
    settled = settle_records(ledger, details)
    quote_codes = {
        leg["code"]
        for entry in registry["models"].values()
        for model in [entry["active"], entry["active"].get("fallback")]
        if model for leg in model["legs"]
    }
    quotes = fetch_quotes(quote_codes)
    fund_data = {}
    for code in codes:
        try:
            fund_data[code] = fetch_fundgz(code) or {}
        except Exception as ex:
            print(f"fundgz unavailable {code}: {ex}")
    written = add_predictions(ledger, registry, quotes, fund_data, now)
    update_pending_states(ledger, now.date())
    ledger["updated_at"] = now.isoformat(timespec="seconds")
    ledger["summary"] = summarize(ledger, registry)
    ledger["records"] = ledger.get("records", [])[-1000:]
    write_json_atomic(LEDGER, ledger)
    print(f"overseas accuracy: predictions={written}, settled={settled}, quotes={len(quotes)}")


if __name__ == "__main__":
    main()
