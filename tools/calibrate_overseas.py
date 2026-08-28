#!/usr/bin/env python3
"""用海外误差账本训练 Challenger；只生成候选与审计建议。"""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "frontend" / "src" / "data" / "overseas-models.json"
LEDGER = ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json"
MIN_SAMPLES = int(os.environ.get("OVERSEAS_MIN_SAMPLES", "20"))
BUILTIN_NON_TRADING_DATES = {
    "2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31",
    "2025-02-03", "2025-02-04", "2025-04-04", "2025-05-01", "2025-05-02",
    "2025-05-05", "2025-06-02", "2025-10-01", "2025-10-02", "2025-10-03",
    "2025-10-06", "2025-10-07", "2025-10-08", "2026-01-01", "2026-01-02",
    "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20",
    "2026-02-23", "2026-04-06", "2026-05-01", "2026-05-04", "2026-05-05",
    "2026-06-19", "2026-09-25", "2026-10-01", "2026-10-02", "2026-10-05",
    "2026-10-06", "2026-10-07",
}
SUPPORTED_CALENDAR_YEARS = {2025, 2026}
NON_TRADING_DATES = {
    value.strip()
    for value in os.environ.get("OVERSEAS_NON_TRADING_DATES", "").split(",")
    if value.strip()
}


def previous_trading_date(value: dt.date) -> dt.date:
    candidate = value - dt.timedelta(days=1)
    while True:
        if candidate.year not in SUPPORTED_CALENDAR_YEARS:
            raise ValueError("unsupported calendar")
        if candidate.weekday() < 5 and candidate.isoformat() not in (BUILTIN_NON_TRADING_DATES | NON_TRADING_DATES):
            return candidate
        candidate -= dt.timedelta(days=1)


def valid_feature_evidence(row: dict) -> bool:
    features = row.get("features")
    evidence = row.get("feature_evidence")
    if not isinstance(features, dict) or not features or not isinstance(evidence, dict):
        return False
    if set(features) != set(evidence):
        return False
    for code, value in features.items():
        item = evidence.get(code)
        try:
            feature_value = float(value)
            evidence_value = float(item.get("change")) if isinstance(item, dict) else math.nan
        except (TypeError, ValueError):
            return False
        if (
            not isinstance(item, dict)
            or item.get("quote_date") != row.get("target_nav_date")
            or not math.isfinite(feature_value)
            or not math.isfinite(evidence_value)
            or not math.isclose(feature_value, evidence_value, rel_tol=1e-8, abs_tol=1e-8)
            or not isinstance(item.get("quote_time"), str)
            or not item["quote_time"].strip()
            or not isinstance(item.get("source"), str)
            or not item["source"].strip()
        ):
            return False
    return True


def eligible_settled_rows(rows: list[dict]) -> list[dict]:
    output = []
    for row in rows:
        if row.get("status") != "settled" or not isinstance(row.get("features"), dict) or not row.get("features"):
            continue
        try:
            observation = dt.date.fromisoformat(row["prediction_date"])
            target = dt.date.fromisoformat(row["target_nav_date"])
            base = dt.date.fromisoformat(row["base_nav_date"])
            expected_target = previous_trading_date(observation)
            expected_base = previous_trading_date(target)
            actual_change = float(row["actual_change"])
            feature_values = [float(value) for value in row["features"].values()]
        except (KeyError, TypeError, ValueError):
            continue
        if (
            target != expected_target
            or base != expected_base
            or not row.get("model_version")
            or not math.isfinite(actual_change)
            or not all(math.isfinite(value) for value in feature_values)
            or not valid_feature_evidence(row)
        ):
            continue
        output.append(row)
    return output


def data_fingerprint(rows: list[dict]) -> str:
    evidence = [{
        "target_nav_date": row.get("target_nav_date"),
        "prediction_date": row.get("prediction_date"),
        "base_nav_date": row.get("base_nav_date"),
        "model_version": row.get("model_version"),
        "actual_change": row.get("actual_change"),
        "features": row.get("features"),
        "feature_evidence": row.get("feature_evidence"),
    } for row in sorted(rows, key=lambda item: (item.get("target_nav_date") or "", item.get("model_version") or ""))]
    encoded = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def data_effective_at(rows: list[dict]) -> str | None:
    settled_times = [row.get("settled_at") for row in rows if row.get("settled_at")]
    if settled_times:
        return max(settled_times)
    target_dates = [row.get("target_nav_date") for row in rows if row.get("target_nav_date")]
    return max(target_dates) if target_dates else None


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


def review_policy(
    *,
    candidate_status: str,
    degraded: bool,
    poor_cycles: int,
    rollback_available: bool,
) -> dict:
    """将 Challenger 和漂移证据转为人工审核建议，不改写 active/history。"""
    eligible = candidate_status == "accepted" and not degraded
    rollback_recommended = poor_cycles >= 2 and rollback_available
    if rollback_recommended:
        recommendation = "review_rollback"
    elif poor_cycles >= 2:
        recommendation = "investigate_active_degradation"
    elif degraded:
        recommendation = "monitor_active_degradation"
    elif eligible:
        recommendation = "review_candidate"
    elif candidate_status == "collecting":
        recommendation = "collect_more_evidence"
    else:
        recommendation = "keep_active_rejected_candidate"
    return {
        "active_change_policy": "explicit_admin_only",
        "candidate_eligible_for_admin_review": eligible,
        "rollback_recommended": rollback_recommended,
        "recommendation": recommendation,
    }


def write_json_atomic(path: Path, value: dict) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main() -> None:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")
    changed = 0
    statuses = {}
    for code, entry in registry["models"].items():
        rows = eligible_settled_rows([row for row in ledger.get("records", []) if row.get("code") == code])
        fingerprint = data_fingerprint(rows)
        previous_candidate = entry.get("candidate") or {}
        if previous_candidate.get("data_fingerprint") == fingerprint:
            governance = entry.get("governance") or {}
            policy = review_policy(
                candidate_status=previous_candidate.get("status") or "collecting",
                degraded=governance.get("status") == "frozen",
                poor_cycles=int(governance.get("poor_cycles") or 0),
                rollback_available=bool(entry.get("history")),
            )
            candidate_updates = {
                "eligible_for_admin_review": policy["candidate_eligible_for_admin_review"],
                "admin_review_recommendation": (
                    "consider_promotion" if policy["candidate_eligible_for_admin_review"] else "no_active_change"
                ),
            }
            governance_updates = {
                key: policy[key]
                for key in ("active_change_policy", "rollback_recommended", "recommendation")
            }
            if any(previous_candidate.get(key) != value for key, value in candidate_updates.items()) or any(
                governance.get(key) != value for key, value in governance_updates.items()
            ):
                entry["candidate"] = {**previous_candidate, **candidate_updates}
                entry["governance"] = {**governance, **governance_updates}
                changed += 1
            statuses[code] = previous_candidate.get("status") or "unchanged"
            continue
        result = calibrate(rows, entry["active"])
        degraded, drift = active_is_degraded(rows, entry["active"]["version"])
        previous_cycles = int((entry.get("governance") or {}).get("poor_cycles") or 0)
        poor_cycles = previous_cycles + 1 if degraded else 0
        policy = review_policy(
            candidate_status=result["status"],
            degraded=degraded,
            poor_cycles=poor_cycles,
            rollback_available=bool(entry.get("history")),
        )
        candidate = {
            "version": "candidate-" + now[:10].replace("-", ""),
            "created_at": now,
            "data_fingerprint": fingerprint,
            "data_effective_at": data_effective_at(rows),
            **result,
            "eligible_for_admin_review": policy["candidate_eligible_for_admin_review"],
            "admin_review_recommendation": (
                "consider_promotion" if policy["candidate_eligible_for_admin_review"] else "no_active_change"
            ),
        }
        entry["candidate"] = candidate
        entry["governance"] = {
            "status": "frozen" if degraded else "healthy" if result["status"] in ("accepted", "rejected") else "collecting",
            "min_samples": MIN_SAMPLES,
            "poor_cycles": poor_cycles,
            "drift_evidence": drift,
            **policy,
        }
        statuses[code] = entry["candidate"]["status"]
        changed += 1
    if changed:
        registry["updated_at"] = now
        write_json_atomic(REGISTRY, registry)
    print(json.dumps({"changed": changed, "statuses": statuses}, ensure_ascii=False))


if __name__ == "__main__":
    main()
