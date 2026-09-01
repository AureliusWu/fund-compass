import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from service.eastmoney import _parse_worker_estimate_row
from service.v8_decisions import _validated_estimate_context


FIXTURE_PATH = Path(__file__).resolve().parents[2] / "contracts" / "estimate-wire-v8.json"


def _fixture_cases() -> list[dict]:
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "estimate-wire-v8.0"
    return payload["cases"]


@pytest.mark.parametrize("case", _fixture_cases(), ids=lambda case: case["id"])
def test_worker_wire_fixture_normalizes_or_fails_closed(case: dict) -> None:
    wire = case["wire"]
    expected = case["expected"]
    if not expected["accepted"]:
        with pytest.raises(ValueError):
            _parse_worker_estimate_row(wire)
        return

    normalized = _parse_worker_estimate_row(wire)
    for field, expected_value in expected.items():
        if field in {"accepted", "legacy_alias_used", "freshness_at_2026_08_28"}:
            continue
        assert normalized[field] == expected_value

    # Canonical nulls are not backfilled with zero, including unavailable and
    # official NAV rows where estimate fields have a different meaning.
    for field in ("value_nav", "value_change", "estimate_nav", "estimate_change", "target_nav_date"):
        if expected.get(field, object()) is None:
            assert normalized[field] is None


def test_reported_stale_wire_is_not_usable_as_current_decision_evidence() -> None:
    stale = next(case for case in _fixture_cases() if case["id"] == "stale_intraday_estimate")
    context = _parse_worker_estimate_row(stale["wire"])
    detail = {
        "latest_nav": context["base_nav"],
        "latest_nav_date": context["base_nav_date"],
    }
    rejected = _validated_estimate_context(
        detail,
        context,
        datetime(2026, 8, 28, 8, 0, tzinfo=timezone.utc),
    )

    assert rejected["kind"] == "unavailable"
    assert rejected["status"] == "unavailable"
    assert rejected["estimate_nav"] is None
    assert rejected["estimate_change"] is None
    assert rejected["fallback_reason"] in {"source_time_stale", "source_reported_stale"}


def test_official_nav_is_accepted_at_seven_day_hard_limit() -> None:
    row = next(case for case in _fixture_cases() if case["id"] == "official_nav_canonical")
    context = _parse_worker_estimate_row(row["wire"])
    detail = {"latest_nav": context["value_nav"], "latest_nav_date": context["value_date"]}

    validated = _validated_estimate_context(
        detail,
        context,
        datetime(2026, 9, 4, 8, 0, tzinfo=timezone.utc),
    )

    assert validated["kind"] == "official_nav"
    assert validated["status"] == "latest_official"


def test_official_nav_older_than_seven_days_fails_closed() -> None:
    row = next(case for case in _fixture_cases() if case["id"] == "official_nav_canonical")
    context = _parse_worker_estimate_row(row["wire"])
    detail = {"latest_nav": context["value_nav"], "latest_nav_date": context["value_date"]}

    rejected = _validated_estimate_context(
        detail,
        context,
        datetime(2026, 9, 5, 8, 0, tzinfo=timezone.utc),
    )

    assert rejected["kind"] == "unavailable"
    assert rejected["status"] == "unavailable"
    assert rejected["value_nav"] is None
    assert rejected["estimate_nav"] is None
    assert rejected["fallback_reason"] == "official_nav_stale"


def test_official_nav_source_date_must_match_published_nav_date() -> None:
    row = next(case for case in _fixture_cases() if case["id"] == "official_nav_canonical")
    context = _parse_worker_estimate_row(row["wire"])
    context["source_time"] = "2026-08-27"
    detail = {"latest_nav": context["value_nav"], "latest_nav_date": context["value_date"]}

    rejected = _validated_estimate_context(
        detail,
        context,
        datetime(2026, 8, 28, 8, 0, tzinfo=timezone.utc),
    )

    assert rejected["kind"] == "unavailable"
    assert rejected["fallback_reason"] == "source_date_mismatch"


def test_deprecated_alias_only_input_is_normalized_without_leaking_aliases() -> None:
    normalized = _parse_worker_estimate_row({
        "code": "000006",
        "est_kind": "estimate",
        "status": "fresh",
        "source": "legacy_fixture",
        "is_fallback": False,
        "source_time_precision": "datetime",
        "last_nav": 1.0,
        "base_nav_date": "2026-08-27",
        "est_nav": 1.01,
        "est_change": 1.0,
        "value_date": "2026-08-28",
        "est_time": "2026-08-28T14:30:00+08:00",
        "diagnostics": {"source_time_precision": "datetime", "rejected": {}},
    })

    assert normalized["kind"] == "intraday_estimate"
    assert normalized["estimate_nav"] == 1.01
    assert normalized["estimate_change"] == 1.0
    assert all(not key.startswith("est_") for key in normalized)
