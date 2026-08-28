#!/usr/bin/env python3
"""审计海外估值账本；结构错误失败，样本/时效问题仅告警。"""
import datetime as dt
import json
import math
import os
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "frontend" / "public" / "data" / "overseas-accuracy.json"
REGISTRY = ROOT / "frontend" / "src" / "data" / "overseas-models.json"
REPORT = ROOT / "frontend" / "public" / "data" / "overseas-audit.json"
CST = dt.timezone(dt.timedelta(hours=8))
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


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


MAX_EFFECTIVE_AGE_HOURS = max(1, env_int("OVERSEAS_EFFECTIVE_MAX_AGE_HOURS", 96))
ZERO_PREDICTION_LIMIT = max(1, env_int("OVERSEAS_ZERO_PREDICTION_LIMIT", 2))


def parse_timestamp(value: object) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=CST) if parsed.tzinfo is None else parsed.astimezone(CST)


def age_hours(value: object, now: dt.datetime) -> float | None:
    parsed = parse_timestamp(value)
    if parsed is None:
        return None
    return max(0.0, (now - parsed).total_seconds() / 3600)


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
    )


def previous_trading_date(value: dt.date) -> dt.date:
    candidate = value - dt.timedelta(days=1)
    while True:
        if candidate.year not in SUPPORTED_CALENDAR_YEARS:
            raise ValueError("unsupported calendar")
        if candidate.weekday() < 5 and candidate.isoformat() not in (BUILTIN_NON_TRADING_DATES | NON_TRADING_DATES):
            return candidate
        candidate -= dt.timedelta(days=1)


def valid_record_axis(row: dict) -> bool:
    try:
        observation = dt.date.fromisoformat(row["prediction_date"])
        target = dt.date.fromisoformat(row["target_nav_date"])
        base = dt.date.fromisoformat(row["base_nav_date"])
        return target == previous_trading_date(observation) and base == previous_trading_date(target)
    except (KeyError, TypeError, ValueError):
        return False


def valid_feature_evidence(row: dict) -> bool:
    features = row.get("features")
    evidence = row.get("feature_evidence")
    if not isinstance(features, dict) or not features or not isinstance(evidence, dict):
        return False
    if set(features) != set(evidence):
        return False
    for code, value in features.items():
        item = evidence.get(code)
        if not isinstance(item, dict):
            return False
        try:
            values_match = math.isclose(float(value), float(item.get("change")), rel_tol=1e-8, abs_tol=1e-8)
        except (TypeError, ValueError):
            return False
        if (
            not values_match
            or item.get("quote_date") != row.get("target_nav_date")
            or not isinstance(item.get("quote_time"), str)
            or not item["quote_time"].strip()
            or not isinstance(item.get("source"), str)
            or not item["source"].strip()
        ):
            return False
    return True


def effective_prediction_count(records: list[dict], registry: dict, observation_date: str | None) -> int:
    if not observation_date:
        return 0
    versions = {
        code: (entry.get("active") or {}).get("version")
        for code, entry in (registry.get("models") or {}).items()
    }
    return sum(
        row.get("prediction_date") == observation_date
        and row.get("model_version") == versions.get(row.get("code"))
        and row.get("status") in ("pending", "settled", "stale")
        and valid_record_axis(row)
        and valid_feature_evidence(row)
        and finite_number(row.get("predicted_change"))
        and finite_number(row.get("base_nav"))
        and row.get("base_nav", 0) > 0
        for row in records
    )


def audit(
    ledger: dict,
    registry: dict,
    *,
    now: dt.datetime | None = None,
    max_effective_age_hours: int = MAX_EFFECTIVE_AGE_HOURS,
    zero_prediction_limit: int = ZERO_PREDICTION_LIMIT,
) -> dict:
    current = now or dt.datetime.now(CST)
    current = current.astimezone(CST) if current.tzinfo else current.replace(tzinfo=CST)
    errors, warnings = [], []
    raw_records = ledger.get("records")
    if not isinstance(raw_records, list):
        return {"status": "failed", "errors": ["records 必须是数组"], "warnings": [], "stats": {}}
    records = []
    for index, row in enumerate(raw_records):
        if not isinstance(row, dict):
            errors.append(f"row-{index}：记录必须是对象")
            continue
        records.append(row)
    keys = Counter()
    legacy_misaligned = 0
    for index, row in enumerate(records):
        code = row.get("code") or f"row-{index}"
        prediction_date = row.get("prediction_date")
        version = row.get("model_version")
        if prediction_date and version:
            keys[(code, prediction_date, version)] += 1
        status = row.get("status")
        if status == "legacy_misaligned":
            legacy_misaligned += 1
            if row.get("excluded_from_metrics") is not True:
                errors.append(f"{code} {row.get('target_nav_date')}：历史错位样本未显式排除")
        elif status != "observed_only":
            if not valid_record_axis(row):
                errors.append(
                    f"{code} {row.get('prediction_date')}：必须满足观察日T、目标净值日T-1、基准日T-2"
                )
        if row.get("status") == "settled":
            missing = [
                field for field in (
                    "predicted_change", "actual_change", "error", "model_version",
                    "observed_at", "feature_evidence",
                )
                if row.get(field) is None
            ]
            if missing:
                errors.append(f"{code} {row.get('target_nav_date')}：已结算记录缺少 {','.join(missing)}")
            if not isinstance(row.get("feature_evidence"), dict) or not row.get("feature_evidence"):
                errors.append(f"{code} {row.get('target_nav_date')}：已结算记录缺少行情日期证据")
        if status in ("pending", "settled", "stale") and not valid_feature_evidence(row):
            errors.append(f"{code} {row.get('prediction_date')}：行情日期或特征证据与目标净值日不一致")
        if row.get("status") == "stale":
            warnings.append(f"{code} {row.get('target_nav_date')}：超过 7 天未取得精确归属日净值")
        coverage = row.get("coverage")
        try:
            if coverage is not None and float(coverage) < 30:
                warnings.append(f"{code} {row.get('target_nav_date')}：行情覆盖仅 {coverage}%")
        except (TypeError, ValueError):
            errors.append(f"{code} {row.get('target_nav_date')}：行情覆盖字段无效")
    for key, count in keys.items():
        if count > 1:
            errors.append(f"{key[0]} {key[1]} {key[2]}：重复预测 {count} 条")
    if legacy_misaligned:
        warnings.append(f"已保留并排除 {legacy_misaligned} 条历史日期轴错位样本")
    for code, entry in (registry.get("models") or {}).items():
        governance = entry.get("governance") or {}
        if governance.get("status") in ("frozen", "rolled-back"):
            warnings.append(f"{code}：模型治理状态 {governance.get('status')}，请检查漂移证据")

    pipeline = ledger.get("pipeline") if isinstance(ledger.get("pipeline"), dict) else {}
    heartbeat = pipeline.get("heartbeat_at") or pipeline.get("last_run_at")
    if heartbeat and parse_timestamp(heartbeat) is None:
        errors.append("pipeline heartbeat_at 时间无效")
    run_mode = pipeline.get("run_mode")
    prediction_due = pipeline.get("prediction_due") is True
    prediction_expected = pipeline.get("prediction_expected") is True
    window_status = pipeline.get("prediction_window_status")
    observation_date = pipeline.get("observation_date")
    expected_models = max(0, safe_int(pipeline.get("expected_models"), len(registry.get("models") or {})))
    effective_count = effective_prediction_count(records, registry, observation_date)
    reported_effective = pipeline.get("effective_predictions_for_observation")
    if reported_effective is not None and safe_int(reported_effective, -1) != effective_count:
        errors.append("pipeline 当日有效预测计数与账本不一致")
    if pipeline.get("calendar_supported") is False or window_status == "calendar_unsupported":
        errors.append("当前日期超出已审计基金交易日历覆盖范围")
    elif run_mode == "scheduled" and prediction_due and window_status == "delayed_same_day":
        warnings.append("计划任务延迟至同日窗口，预测仅使用已证明归属目标日的行情")
    elif run_mode == "scheduled" and prediction_due and window_status == "delayed_cross_day":
        try:
            scheduled_date = dt.date.fromisoformat(pipeline["scheduled_observation_date"])
            observation = dt.date.fromisoformat(observation_date)
            valid_cross_day = scheduled_date < observation
        except (KeyError, TypeError, ValueError):
            valid_cross_day = False
        if not valid_cross_day:
            errors.append("跨日延迟任务的计划日与真实运行日不一致")
        elif prediction_expected or safe_int(pipeline.get("predictions_written")) > 0:
            errors.append("跨日延迟任务不得回填伪预测")
        else:
            warnings.append("计划任务延迟至跨日；已跳过预测，仅持久化真实结算与审计证据")
    elif run_mode == "scheduled" and prediction_due and window_status not in ("open", "delayed_same_day"):
        errors.append(f"计划预测任务无有效同日观察：{window_status or 'unknown'}")
    if prediction_expected:
        if effective_count == 0:
            zero_runs = max(0, safe_int(pipeline.get("consecutive_expected_zero_prediction_runs")))
            message = f"应产出预测但当日有效预测为 0（连续 {zero_runs} 次）"
            if zero_runs >= max(1, zero_prediction_limit):
                errors.append(message)
            else:
                warnings.append(message)
        elif expected_models and effective_count < expected_models:
            warnings.append(f"当日仅产出 {effective_count}/{expected_models} 个有效模型预测")

    prediction_effective_at = pipeline.get("last_effective_prediction_at")
    settlement_effective_at = pipeline.get("last_effective_settlement_at")
    prediction_age = age_hours(prediction_effective_at, current)
    settlement_age = age_hours(settlement_effective_at, current)
    if prediction_effective_at and prediction_age is None:
        errors.append("pipeline 最后有效预测时间无效")
    elif prediction_age is not None and prediction_age > max_effective_age_hours:
        message = f"最后有效预测已过去 {prediction_age:.1f} 小时"
        if prediction_expected:
            errors.append(message)
        else:
            warnings.append(message)
    elif prediction_expected and effective_count == 0 and prediction_effective_at is None:
        warnings.append("尚无任何有效预测时间证据")
    if settlement_effective_at and settlement_age is None:
        errors.append("pipeline 最后有效结算时间无效")
    elif settlement_age is not None and settlement_age > max_effective_age_hours:
        warnings.append(f"最后有效结算已过去 {settlement_age:.1f} 小时")

    statuses = Counter(row.get("status") or "unknown" for row in records)
    return {
        "status": "failed" if errors else "warning" if warnings else "healthy",
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "records": len(raw_records),
            "statuses": dict(statuses),
            "prediction_due": prediction_due,
            "prediction_expected": prediction_expected,
            "effective_predictions_for_observation": effective_count,
            "legacy_misaligned": legacy_misaligned,
            "prediction_effective_age_hours": round(prediction_age, 1) if prediction_age is not None else None,
            "settlement_effective_age_hours": round(settlement_age, 1) if settlement_age is not None else None,
        },
    }


def main() -> None:
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    report = audit(ledger, registry)
    report["updated_at"] = dt.datetime.now(CST).isoformat(timespec="seconds")
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
