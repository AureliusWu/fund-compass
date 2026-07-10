#!/usr/bin/env python3
"""审计海外估值账本；结构错误失败，样本/时效问题仅告警。"""
import datetime as dt
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json"
REGISTRY = ROOT / "frontend" / "src" / "data" / "overseas-models.json"
REPORT = ROOT / "frontend" / "public" / "data" / "overseas-audit.json"


def audit(ledger: dict, registry: dict) -> dict:
    errors, warnings = [], []
    records = ledger.get("records")
    if not isinstance(records, list):
        return {"status": "failed", "errors": ["records 必须是数组"], "warnings": [], "stats": {}}
    keys = Counter()
    for index, row in enumerate(records):
        code = row.get("code") or f"row-{index}"
        prediction_date = row.get("prediction_date")
        version = row.get("model_version")
        if prediction_date and version:
            keys[(code, prediction_date, version)] += 1
        try:
            target = dt.date.fromisoformat(row["target_nav_date"])
            base = dt.date.fromisoformat(row["base_nav_date"])
            if base > target:
                errors.append(f"{code} {row['target_nav_date']}：基准日期晚于目标日期")
        except (KeyError, TypeError, ValueError):
            errors.append(f"{code}：日期字段无效")
        if row.get("status") == "settled":
            missing = [field for field in ("predicted_change", "actual_change", "error", "model_version") if row.get(field) is None]
            if missing:
                errors.append(f"{code} {row.get('target_nav_date')}：已结算记录缺少 {','.join(missing)}")
        if row.get("status") == "stale":
            warnings.append(f"{code} {row.get('target_nav_date')}：超过 7 天未取得精确归属日净值")
        coverage = row.get("coverage")
        if coverage is not None and float(coverage) < 30:
            warnings.append(f"{code} {row.get('target_nav_date')}：行情覆盖仅 {coverage}%")
    for key, count in keys.items():
        if count > 1:
            errors.append(f"{key[0]} {key[1]} {key[2]}：重复预测 {count} 条")
    for code, entry in (registry.get("models") or {}).items():
        governance = entry.get("governance") or {}
        if governance.get("status") in ("frozen", "rolled-back"):
            warnings.append(f"{code}：模型治理状态 {governance.get('status')}，请检查漂移证据")
    statuses = Counter(row.get("status") or "unknown" for row in records)
    return {
        "status": "failed" if errors else "warning" if warnings else "healthy",
        "errors": errors,
        "warnings": warnings,
        "stats": {"records": len(records), "statuses": dict(statuses)},
    }


def main() -> None:
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    report = audit(ledger, registry)
    report["updated_at"] = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
