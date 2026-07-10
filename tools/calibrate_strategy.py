#!/usr/bin/env python3
"""跨基金策略校准：生成候选注册表，严格门槛通过时自动晋级 active。"""
import datetime as dt
import json
import math
import os
import random
import statistics
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from service.eastmoney import fetch_detail  # noqa: E402
from strategy.calibration import calibrate  # noqa: E402
from strategy.registry import load_registry  # noqa: E402

SCREENER = ROOT / "frontend" / "public" / "data" / "screener.json"
REGISTRY = ROOT / "backend" / "data" / "strategy-params.json"
PUBLIC_REPORT = ROOT / "frontend" / "public" / "data" / "strategy-calibration.json"
MIN_VALID = int(os.environ.get("CALIBRATION_MIN_VALID", "12"))
MAX_FUNDS = int(os.environ.get("CALIBRATION_MAX_FUNDS", "30"))
AUTO_PROMOTE = os.environ.get("AUTO_PROMOTE_STRATEGY", "").lower() in ("1", "true", "yes")
FUND_API_BASE = os.environ.get("FUND_API_BASE", "").rstrip("/")


def sample_codes() -> list[tuple[str, str]]:
    funds = json.loads(SCREENER.read_text(encoding="utf-8")).get("funds") or []
    by_type: dict[str, list[str]] = {}
    for fund in funds:
        if fund.get("c") and fund.get("t"):
            by_type.setdefault(fund["t"], []).append(fund["c"])
    random.seed(20260709)
    selected: list[tuple[str, str]] = []
    while len(selected) < MAX_FUNDS:
        added = False
        for fund_type in sorted(by_type):
            codes = by_type[fund_type]
            if codes:
                selected.append((codes.pop(random.randrange(len(codes))), fund_type))
                added = True
                if len(selected) >= MAX_FUNDS:
                    break
        if not added:
            break
    return selected


def weight_key(weights: dict) -> str:
    return json.dumps(weights, ensure_ascii=False, sort_keys=True)


def write_json_atomic(path: Path, value: dict) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def aggregate(rows: list[dict]) -> dict:
    valid = [row for row in rows if row.get("available")]
    accepted = [row for row in valid if row.get("accepted")]
    votes = Counter(weight_key(row["candidate_weights"]) for row in accepted)
    winner_key, winner_votes = votes.most_common(1)[0] if votes else (None, 0)
    winner_rows = [row for row in accepted if weight_key(row["candidate_weights"]) == winner_key]
    deltas = [
        row["validation"]["candidate"]["outperform"] - row["validation"]["baseline"]["outperform"]
        for row in winner_rows
    ]
    required_votes = max(5, math.ceil(len(valid) * 0.4))
    median_delta = round(statistics.median(deltas), 2) if deltas else None
    type_distribution = Counter(row.get("type") or "未知" for row in rows)
    valid_type_distribution = Counter(row.get("type") or "未知" for row in valid)
    max_type_share = (
        max(valid_type_distribution.values()) / len(valid)
        if valid_type_distribution and valid else 1
    )
    type_balance_ok = len(valid_type_distribution) >= 4 and max_type_share <= 0.4
    passed = (
        len(valid) >= MIN_VALID
        and winner_votes >= required_votes
        and median_delta is not None
        and median_delta >= 0.5
        and type_balance_ok
    )
    return {
        "sampled": len(rows),
        "valid": len(valid),
        "accepted": len(accepted),
        "winner_votes": winner_votes,
        "required_votes": required_votes,
        "median_validation_improvement": median_delta,
        "type_distribution": dict(type_distribution),
        "valid_type_distribution": dict(valid_type_distribution),
        "max_type_share": round(max_type_share, 3),
        "type_balance_ok": type_balance_ok,
        "passed": passed,
        "weights": json.loads(winner_key) if winner_key else None,
    }


def fetch_outcomes() -> dict | None:
    if not FUND_API_BASE:
        return None
    try:
        req = urllib.request.Request(
            f"{FUND_API_BASE}/api/strategy/outcomes",
            headers={"User-Agent": "sinan-calibration"},
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as ex:
        print(f"outcome audit unavailable: {ex}")
        return None


def active_is_degraded(outcomes: dict | None, version: str) -> tuple[bool, dict]:
    """成熟的 20/60 日结果至少两个分组低命中，才算一个退化周期。"""
    rows = [
        row for row in ((outcomes or {}).get("summary") or [])
        if row.get("strategy_version") == version
        and row.get("horizon") in (20, 60)
        and row.get("samples", 0) >= 10
    ]
    poor = [row for row in rows if row.get("hit_rate", 100) < 40]
    return len(poor) >= 2, {
        "mature_groups": len(rows),
        "poor_groups": len(poor),
        "samples": sum(row.get("samples", 0) for row in rows),
    }


def main() -> None:
    rows = []
    for index, (code, fund_type) in enumerate(sample_codes(), 1):
        try:
            result = calibrate(fetch_detail(code))
            rows.append({"code": code, "type": fund_type, **result})
            print(f"[{index}] {code} {fund_type} accepted={result.get('accepted')}")
        except Exception as ex:
            rows.append({"code": code, "type": fund_type, "available": False, "error": str(ex)})
            print(f"[{index}] {code} failed: {ex}")

    summary = aggregate(rows)
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")
    current = load_registry()
    outcomes = fetch_outcomes()
    active_version = current["active"].get("version") or "unknown"
    degraded, outcome_evidence = active_is_degraded(outcomes, active_version)
    previous_cycles = int((current.get("governance") or {}).get("poor_cycles") or 0)
    poor_cycles = previous_cycles + 1 if degraded else 0
    frozen = not summary["type_balance_ok"] or summary["valid"] < MIN_VALID
    candidate = {
        "version": "candidate-" + now[:10].replace("-", ""),
        "created_at": now,
        "weights": summary["weights"],
        "status": "passed" if summary["passed"] else "rejected",
        "evidence": {key: value for key, value in summary.items() if key != "weights"},
    }
    output = {
        "schema": 1,
        "updated_at": now,
        "active": current["active"],
        "history": current.get("history") or [],
        "candidate": candidate,
        "governance": {
            "status": "frozen" if frozen else "healthy",
            "poor_cycles": poor_cycles,
            "outcome_evidence": outcome_evidence,
        },
    }
    changed = candidate["weights"] != current["active"].get("weights")
    if summary["passed"] and AUTO_PROMOTE and changed and not frozen:
        output["history"] = ([current["active"]] + output["history"])[:10]
        output["active"] = {
            "version": candidate["version"].replace("candidate", "auto"),
            "weights": candidate["weights"],
            "source": "cross-fund holdout validation",
            "promoted_at": now,
            "evidence": candidate["evidence"],
            "previous_version": current["active"].get("version"),
        }
        candidate["status"] = "promoted"
    elif summary["passed"] and not changed:
        candidate["status"] = "same-as-active"
    if (
        poor_cycles >= 2
        and output["active"].get("source") == "cross-fund holdout validation"
        and output["history"]
    ):
        failed = output["active"]
        output["active"] = output["history"].pop(0)
        output["history"] = ([failed] + output["history"])[:10]
        output["governance"]["status"] = "rolled-back"
        output["governance"]["poor_cycles"] = 0
        output["governance"]["rolled_back_from"] = failed.get("version")

    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(REGISTRY, output)
    report = {
        "updated_at": now,
        "active": output["active"],
        "candidate": candidate,
        "summary": summary,
        "funds": [
            {
                "code": row["code"],
                "type": row["type"],
                "available": row.get("available", False),
                "accepted": row.get("accepted", False),
                "reason": row.get("reason") or row.get("error"),
            }
            for row in rows
        ],
    }
    write_json_atomic(PUBLIC_REPORT, report)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
