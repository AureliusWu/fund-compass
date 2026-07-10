#!/usr/bin/env python3
"""用海外误差账本训练 Challenger；严格按时间切分，达标后才可晋级。"""
import datetime as dt
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "frontend" / "src" / "data" / "overseas-models.json"
LEDGER = ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json"
AUTO_PROMOTE = os.environ.get("AUTO_PROMOTE_OVERSEAS", "").lower() in ("1", "true", "yes")
MIN_SAMPLES = int(os.environ.get("OVERSEAS_MIN_SAMPLES", "20"))


def predict(row: dict, model: dict) -> float | None:
    features = row.get("features") or {}
    available = [(leg, features[leg["code"]]) for leg in model["legs"] if leg["code"] in features]
    weight = sum(float(leg["weight"]) for leg, _ in available)
    if not available or weight < float(model.get("min_weight") or 0):
        return None
    raw = sum(float(leg["weight"]) * float(value) for leg, value in available) / weight
    return raw * float(model.get("scale", 1)) + float(model.get("bias", 0))


def metrics(rows: list[dict], model: dict) -> dict:
    pairs = [(predict(row, model), float(row["actual_change"])) for row in rows]
    pairs = [(prediction, actual) for prediction, actual in pairs if prediction is not None]
    if not pairs:
        return {"samples": 0, "mae": None, "direction_accuracy": None, "extreme_mae": None}
    errors = [prediction - actual for prediction, actual in pairs]
    extreme = [abs(prediction - actual) for prediction, actual in pairs if abs(actual) >= 3]
    return {
        "samples": len(pairs),
        "mae": round(sum(abs(value) for value in errors) / len(errors), 4),
        "bias": round(sum(errors) / len(errors), 4),
        "direction_accuracy": round(sum((prediction >= 0) == (actual >= 0) for prediction, actual in pairs) / len(pairs) * 100, 1),
        "extreme_mae": round(sum(extreme) / len(extreme), 4) if extreme else None,
    }


def train_candidate(rows: list[dict], active: dict) -> dict:
    best = json.loads(json.dumps(active))
    best_score = metrics(rows, best)["mae"]
    # 单轮坐标搜索重仓/因子权重，限制在当前权重的 80%-120%。
    for index, leg in enumerate(best["legs"]):
        original = float(leg["weight"])
        choice = original
        for multiplier in (0.8, 1.0, 1.2):
            trial = json.loads(json.dumps(best))
            trial["legs"][index]["weight"] = round(original * multiplier, 4)
            score = metrics(rows, trial)["mae"]
            if score is not None and (best_score is None or score < best_score):
                best_score, choice = score, trial["legs"][index]["weight"]
        best["legs"][index]["weight"] = choice
    for scale in (0.8, 1.0, 1.2, 1.4, 1.6):
        for bias in (-0.4, -0.2, 0.0, 0.2, 0.4):
            trial = json.loads(json.dumps(best))
            trial["scale"], trial["bias"] = scale, bias
            score = metrics(rows, trial)["mae"]
            if score is not None and (best_score is None or score < best_score):
                best_score, best = score, trial
    return best


def calibrate(rows: list[dict], active: dict, min_samples=MIN_SAMPLES) -> dict:
    ordered = sorted(rows, key=lambda row: row["target_nav_date"])
    if len(ordered) < min_samples:
        return {"status": "collecting", "samples": len(ordered), "required": min_samples}
    split = max(1, int(len(ordered) * 0.7))
    train, validation = ordered[:split], ordered[split:]
    if len(validation) < 5:
        return {"status": "collecting", "samples": len(ordered), "required_validation": 5}
    candidate = train_candidate(train, active)
    baseline_metrics = metrics(validation, active)
    candidate_metrics = metrics(validation, candidate)
    extreme_ok = (
        baseline_metrics["extreme_mae"] is None
        or candidate_metrics["extreme_mae"] is None
        or candidate_metrics["extreme_mae"] <= baseline_metrics["extreme_mae"]
    )
    accepted = (
        candidate_metrics["mae"] is not None
        and baseline_metrics["mae"] is not None
        and candidate_metrics["mae"] <= baseline_metrics["mae"] - 0.15
        and candidate_metrics["direction_accuracy"] >= baseline_metrics["direction_accuracy"]
        and extreme_ok
    )
    return {
        "status": "accepted" if accepted else "rejected",
        "samples": len(ordered),
        "split_date": validation[0]["target_nav_date"],
        "train_samples": len(train),
        "validation_samples": len(validation),
        "baseline": baseline_metrics,
        "candidate": candidate_metrics,
        "parameters": {key: candidate[key] for key in ("scale", "bias", "legs")},
    }


def active_is_degraded(rows: list[dict], version: str) -> tuple[bool, dict]:
    """同一 active 至少 20 个结算样本，最近 10 个明显劣于此前 10 个才记退化。"""
    mature = sorted(
        [row for row in rows if row.get("model_version") == version and row.get("status") == "settled"],
        key=lambda row: row["target_nav_date"],
    )
    if len(mature) < 20:
        return False, {"samples": len(mature), "reason": "insufficient"}
    previous, recent = mature[-20:-10], mature[-10:]
    previous_mae = sum(abs(float(row["error"])) for row in previous) / 10
    recent_mae = sum(abs(float(row["error"])) for row in recent) / 10
    recent_direction = sum(bool(row.get("direction_hit")) for row in recent) / 10 * 100
    degraded = recent_mae > max(previous_mae * 1.35, previous_mae + 0.3) and recent_direction < 40
    return degraded, {
        "samples": len(mature),
        "previous_mae": round(previous_mae, 3),
        "recent_mae": round(recent_mae, 3),
        "recent_direction_accuracy": round(recent_direction, 1),
    }


def write_json_atomic(path: Path, value: dict) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> None:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")
    for code, entry in registry["models"].items():
        rows = [row for row in ledger.get("records", []) if row.get("code") == code and row.get("status") == "settled" and row.get("features")]
        result = calibrate(rows, entry["active"])
        degraded, drift = active_is_degraded(rows, entry["active"]["version"])
        previous_cycles = int((entry.get("governance") or {}).get("poor_cycles") or 0)
        poor_cycles = previous_cycles + 1 if degraded else 0
        candidate = {
            "version": "candidate-" + now[:10].replace("-", ""),
            "created_at": now,
            **result,
        }
        entry["candidate"] = candidate
        entry["governance"] = {
            "status": "frozen" if degraded else "healthy" if result["status"] in ("accepted", "rejected") else "collecting",
            "min_samples": MIN_SAMPLES,
            "poor_cycles": poor_cycles,
            "drift_evidence": drift,
        }
        if result["status"] == "accepted" and AUTO_PROMOTE and not degraded:
            previous = entry["active"]
            promoted = json.loads(json.dumps(previous))
            promoted.update(result["parameters"])
            promoted["version"] = "auto-" + now[:10].replace("-", "")
            promoted["promoted_at"] = now
            promoted["evidence"] = {key: value for key, value in result.items() if key != "parameters"}
            entry["history"] = ([previous] + entry.get("history", []))[:10]
            entry["active"] = promoted
            entry["candidate"]["status"] = "promoted"
        if poor_cycles >= 2 and entry.get("history"):
            failed = entry["active"]
            entry["active"] = entry["history"].pop(0)
            entry["history"] = ([failed] + entry["history"])[:10]
            entry["governance"].update({
                "status": "rolled-back", "poor_cycles": 0,
                "rolled_back_from": failed["version"],
            })
    registry["updated_at"] = now
    write_json_atomic(REGISTRY, registry)
    print(json.dumps({code: entry["candidate"]["status"] for code, entry in registry["models"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()
