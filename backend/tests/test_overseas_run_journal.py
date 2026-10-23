"""Synthetic candidate tests only; no actual run or market data is fabricated."""
import builtins
import copy
import io
import json
import os
from pathlib import Path
import socket
import sqlite3

import pytest
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "overseas_run_journal_candidate", Path(__file__).resolve().parents[2] / "tools" / "overseas_run_journal.py",
)
assert _spec is not None and _spec.loader is not None
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)

NOW = "2026-10-11T12:00:00Z"
SOURCE = "a" * 40
CALENDAR = "c" * 64


@pytest.fixture
def call(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("external_access_forbidden")

    def invoke(function, *args, **kwargs):
        with monkeypatch.context() as scope:
            scope.setattr(builtins, "open", denied)
            scope.setattr(io, "open", denied)
            scope.setattr(Path, "open", denied)
            scope.setattr(Path, "read_text", denied)
            scope.setattr(Path, "read_bytes", denied)
            scope.setattr(Path, "write_text", denied)
            scope.setattr(Path, "write_bytes", denied)
            scope.setattr(socket, "socket", denied)
            scope.setattr(socket, "create_connection", denied)
            scope.setattr(socket, "getaddrinfo", denied)
            scope.setattr(sqlite3, "connect", denied)
            scope.setattr(os, "getenv", denied)
            scope.setattr(os, "environ", {})
            return function(*args, **kwargs)
    return invoke


def event(date="2026-10-08", run_id=10008, *, outcome="zero_effective", reason="zero_effective_prediction", mode="scheduled", expectation="trading", attempt=1, clock="06:40:00", end="06:41:00", window="open", workflow_status=None, workflow_reason=None):
    return {
        "date": date, "run_id": run_id, "attempt": attempt,
        "source_sha": SOURCE, "mode": mode, "expectation": expectation,
        "expected_window": date + "T06:35:00Z", "window_status": window,
        "outcome": outcome, "reason": reason,
        "workflow_status": workflow_status or ("failed" if outcome in ("zero_effective", "failed", "blocked") else "succeeded"),
        "workflow_reason": workflow_reason or (reason if outcome in ("failed", "blocked") else "audit_rejected" if outcome == "zero_effective" else "workflow_completed"),
        "started_at": date + "T" + clock + "Z", "finished_at": date + "T" + end + "Z",
        "qualified_data": {
            "commit_sha": "d" * 40, "ledger_sha256": "1" * 64,
            "audit_sha256": "2" * 64, "models_sha256": "3" * 64,
            "evidence_sha256": "4" * 64,
        } if outcome == "qualified" else None,
    }


def binding(value):
    return {key: value[key] for key in v._BINDING_KEYS}


def empty(call):
    return call(v.encode, v.new_journal(), observed_at=NOW)


def add(call, raw, value, external=None):
    return call(v.append, raw, value, binding=binding(value) if external is None else external, observed_at=NOW)


def summary(call, raw, dates):
    return call(v.summarize, raw, observed_at=NOW, expected_dates=tuple(dates), calendar_sha256=CALENDAR)


def test_cross_run_persistent_two_to_three_and_nonfinancial_history(call):
    raw = add(call, empty(call), event("2026-09-29", 10001, outcome="qualified", reason="financial_qualified"))
    raw = add(call, raw, event("2026-09-30", 10002))
    raw = add(call, raw, event("2026-10-07", 10003, outcome="skipped", reason="non_trading_day", expectation="non_trading", window="non_trading_day"))
    raw = add(call, raw, event())
    dates = ["2026-09-29", "2026-09-30", "2026-10-08"]
    assert summary(call, raw, dates)["zero_streak_exact"] == 2
    reloaded = call(v.encode, call(v.decode, raw, observed_at=NOW), observed_at=NOW)
    raw = add(call, reloaded, event("2026-10-09", 10009))
    result = summary(call, raw, dates + ["2026-10-09"])
    assert result["zero_streak_exact"] == 3
    assert result["last_qualified_financial_index"] == 0
    assert result["latest_scheduled_failure_index"] == 4
    assert result["alert_required"] is True
    assert result["remote_verified"] is result["formal_release"] is False
    assert b"nav" not in raw.lower()


def test_identical_canonical_replay_idempotent(call):
    value = event()
    raw = add(call, empty(call), value)
    assert add(call, raw, dict(reversed(list(value.items())))) == raw
    assert summary(call, raw, [value["date"]])["event_count"] == 1


@pytest.mark.parametrize("field, replacement", [
    ("source_sha", "b" * 40), ("finished_at", "2026-10-08T06:42:00Z"),
    ("outcome", "failed"), ("date", "2026-10-09"),
])
def test_identity_replay_never_overwrites_history(call, field, replacement):
    value = event()
    raw = add(call, empty(call), value)
    changed = dict(value, **{field: replacement})
    if field == "outcome":
        changed["reason"] = "audit_rejected"
    if field == "date":
        changed.update(expected_window="2026-10-09T06:35:00Z", started_at="2026-10-09T06:40:00Z", finished_at="2026-10-09T06:41:00Z")
    with pytest.raises(v.JournalError, match="conflicting_replay"):
        add(call, raw, changed)


def test_manual_holiday_preserve_failure_history_after_qualified_retry_recovery(call):
    raw = add(call, empty(call), event())
    recovered = event(run_id=10010, outcome="qualified", reason="financial_qualified", clock="07:00:00", end="07:01:00")
    raw = add(call, raw, recovered)
    manual = event(run_id=10011, outcome="skipped", reason="manual_observation_only", mode="manual", clock="07:10:00", end="07:11:00")
    raw = add(call, raw, manual)
    holiday = event("2026-10-10", 10012, outcome="skipped", reason="non_trading_day", expectation="non_trading", window="non_trading_day")
    raw = add(call, raw, holiday)
    result = summary(call, raw, ["2026-10-08"])
    assert result["zero_streak_lower_bound"] == 0
    assert result["zero_streak_exact"] == 0
    assert result["history_complete_for_streak"] is True
    assert result["alert_required"] is False
    assert result["last_qualified_financial_index"] == 1
    assert result["latest_scheduled_failure_index"] == 0
    assert result["latest_attempt_index"] == 3
    assert result["expected_observed_date_count"] == 1
    state = call(v.decode, raw, observed_at=NOW)
    assert state["events"][0]["outcome"] == "zero_effective"
    assert state["events"][0]["workflow_status"] == "failed"
    assert state["events"][1] == recovered
    assert result["remote_verified"] is result["formal_release"] is False


def test_success_then_same_date_failure_remains_failed_day(call):
    raw = add(call, empty(call), event(outcome="qualified", reason="financial_qualified"))
    raw = add(call, raw, event(run_id=10010, clock="07:00:00", end="07:01:00"))
    result = summary(call, raw, ["2026-10-08"])
    assert result["zero_streak_lower_bound"] == 1
    assert result["zero_streak_exact"] is None
    assert result["alert_required"] is True
    assert result["last_qualified_financial_index"] == 0
    assert result["latest_scheduled_failure_index"] == 1


def test_ci_failure_after_real_qualified_publication_keeps_two_states_separate(call):
    value = event(outcome="qualified", reason="financial_qualified", workflow_status="failed", workflow_reason="ci_dispatch_failed")
    raw = add(call, empty(call), value)
    result = summary(call, raw, ["2026-10-08"])
    assert result["latest_scheduled_failure_index"] == 0
    assert result["last_qualified_financial_index"] == 0
    assert result["zero_streak_exact"] == 0
    assert result["history_complete_for_streak"] is True
    assert result["alert_required"] is True


def test_prepublication_failure_cannot_claim_qualified_publication(call):
    for failure in sorted(v._WORKFLOW_FAILURES - {"ci_dispatch_failed"}):
        value = event(outcome="qualified", reason="financial_qualified", workflow_status="failed", workflow_reason=failure)
        with pytest.raises(v.JournalError, match="qualification_invalid"):
            add(call, empty(call), value)


def test_missing_expected_date_cannot_claim_consecutive_recovery_or_zero(call):
    raw = add(call, empty(call), event("2026-09-29", 10001, outcome="qualified", reason="financial_qualified"))
    raw = add(call, raw, event("2026-09-30", 10002))
    raw = add(call, raw, event("2026-10-09", 10009))
    result = summary(call, raw, ["2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09"])
    assert result["zero_streak_lower_bound"] == 1
    assert result["zero_streak_exact"] is None
    assert result["history_complete_for_streak"] is False
    missing_today = summary(call, raw, ["2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09", "2026-10-11"])
    assert missing_today["zero_streak_lower_bound"] == 0
    assert missing_today["alert_required"] is True


def test_empty_history_is_explicitly_unknown_not_recovered(call):
    result = summary(call, empty(call), ["2026-10-08"])
    assert result["zero_streak_exact"] is None
    assert result["last_qualified_financial_index"] is None
    assert result["alert_required"] is True


def test_unknown_failure_never_coerces_to_financial_zero(call):
    raw = add(call, empty(call), event(outcome="failed", reason="producer_failed"))
    result = summary(call, raw, ["2026-10-08"])
    assert result["zero_streak_exact"] is None
    assert result["zero_streak_lower_bound"] == 0
    assert result["alert_required"] is True


@pytest.mark.parametrize("mode, expectation, window", [
    ("manual", "trading", "open"), ("scheduled", "non_trading", "non_trading_day"),
    ("scheduled", "unsupported", "calendar_unsupported"),
])
def test_noneligible_context_cannot_claim_qualified_or_financial_zero(call, mode, expectation, window):
    for outcome, reason in (("qualified", "financial_qualified"), ("zero_effective", "zero_effective_prediction")):
        with pytest.raises(v.JournalError, match="qualification_invalid"):
            add(call, empty(call), event(mode=mode, expectation=expectation, window=window, outcome=outcome, reason=reason))


def test_cross_day_missed_window_is_not_backfilled_sample(call):
    value = event(outcome="skipped", reason="scheduled_window_missed", window="delayed_cross_day")
    value.update(started_at="2026-10-09T01:00:00Z", finished_at="2026-10-09T01:01:00Z")
    raw = add(call, empty(call), value)
    result = summary(call, raw, ["2026-10-08"])
    assert result["alert_required"] is True
    assert result["zero_streak_exact"] is None
    assert result["last_qualified_financial_index"] is None
    for outcome, reason in (("qualified", "financial_qualified"), ("zero_effective", "zero_effective_prediction")):
        changed = event(outcome=outcome, reason=reason, window="delayed_cross_day")
        changed.update(started_at=value["started_at"], finished_at=value["finished_at"])
        with pytest.raises(v.JournalError, match="qualification_invalid"):
            add(call, empty(call), changed)


def test_delayed_same_day_preserves_real_window_but_is_not_automatic_qualification(call):
    value = event(clock="13:00:00", end="13:01:00", window="delayed_same_day")
    raw = add(call, empty(call), value)
    assert summary(call, raw, ["2026-10-08"])["zero_streak_lower_bound"] == 1


def test_explicit_2027_unsupported_context_only_blocked_and_not_recovery(call):
    observed = "2027-01-04T12:00:00Z"
    value = event("2027-01-04", 20001, outcome="blocked", reason="calendar_unsupported", expectation="unsupported", window="calendar_unsupported")
    raw = call(v.encode, v.new_journal(), observed_at=observed)
    raw = call(v.append, raw, value, binding=binding(value), observed_at=observed)
    result = call(v.summarize, raw, observed_at=observed, expected_dates=(), calendar_sha256=CALENDAR)
    assert result["zero_streak_exact"] is None
    assert result["last_qualified_financial_index"] is None
    assert result["latest_scheduled_failure_index"] == 0


@pytest.mark.parametrize("field", sorted(v._BINDING_KEYS))
def test_external_binding_tamper_rejected(call, field):
    value = event()
    external = binding(value)
    external[field] = {"date": "2026-10-09", "run_id": 10010, "attempt": 2, "source_sha": "b" * 40, "mode": "manual", "expectation": "non_trading"}[field]
    with pytest.raises(v.JournalError, match="identity_invalid"):
        add(call, empty(call), value, external)


@pytest.mark.parametrize("field, value", [
    ("run_id", True), ("run_id", 0), ("run_id", "10008"), ("attempt", True),
    ("attempt", 101), ("source_sha", "https://secret.invalid"), ("source_sha", "a" * 64),
    ("source_sha", "A" * 40), ("date", "2026-2-03"), ("mode", "SCHEDULED"),
    ("expectation", "unknown"), ("outcome", "recovered"), ("reason", "token=hidden"),
    ("qualified_data", {"nav": 1.5}),
])
def test_closed_scalars_and_no_private_echo(call, field, value):
    changed = dict(event(), **{field: value})
    with pytest.raises(v.JournalError) as captured:
        add(call, empty(call), changed)
    assert str(captured.value) in v._ERRORS
    assert str(captured.value) == captured.value.code


@pytest.mark.parametrize("field", sorted(v._EVENT_KEYS))
def test_missing_event_field_rejected(call, field):
    changed = event()
    del changed[field]
    with pytest.raises(v.JournalError):
        call(v.append, empty(call), changed, binding=binding(event()), observed_at=NOW)


@pytest.mark.parametrize("extra", ["nav", "records", "Secret", "message", "error", "private_governance", "token", "url"])
def test_unknown_and_financial_field_rejected_at_all_scopes(call, extra):
    changed = dict(event(), **{extra: "not_exported"})
    with pytest.raises(v.JournalError):
        add(call, empty(call), changed)
    state = dict(v.new_journal(), **{extra: "not_exported"})
    with pytest.raises(v.JournalError):
        call(v.encode, state, observed_at=NOW)
    qualified = event(outcome="qualified", reason="financial_qualified")
    qualified["qualified_data"][extra] = "not_exported"
    with pytest.raises(v.JournalError):
        add(call, empty(call), qualified)


@pytest.mark.parametrize("field, value", [
    ("started_at", "2026-10-08T06:40:00+00:00"),
    ("started_at", "2026-10-08T06:40:00.1Z"),
    ("started_at", "2026-10-08T06:42:00Z"),
    ("finished_at", "2026-10-12T06:40:00Z"),
    ("finished_at", "2026-10-08T13:00:01Z"),
    ("expected_window", "2026-10-08T14:35:00Z"),
    ("window_status", "delayed_same_day"),
])
def test_clock_window_and_duration_contradictions_rejected(call, field, value):
    with pytest.raises(v.JournalError):
        add(call, empty(call), dict(event(), **{field: value}))


@pytest.mark.parametrize("raw, code", [
    (b'{"profile":"overseas-public-ops-v1","profile":"overseas-public-ops-v1","events":[]}', "duplicate_key"),
    (b'{"profile":"overseas-public-ops-v1","events":NaN}', "schema_invalid"),
    (b'{"profile":"overseas-public-ops-v1","events":Infinity}', "schema_invalid"),
    (b'[[[[[[[0]]]]]]]', "bounds_exceeded"),
    (b'"unterminated', "schema_invalid"),
    (b'\xff', "schema_invalid"),
    (b' ', "schema_invalid"),
    (b'', "bounds_exceeded"),
    (b' ' * (v.MAX_BYTES + 1), "bounds_exceeded"),
], ids=("duplicate", "nan", "infinity", "depth", "unterminated", "utf8", "space", "empty", "oversized"))
def test_json_duplicate_nan_depth_and_byte_limits(call, raw, code):
    with pytest.raises(v.JournalError, match=code):
        call(v.decode, raw, observed_at=NOW)


def test_duplicate_nested_native_key_rejected(call):
    raw = add(call, empty(call), event(outcome="qualified", reason="financial_qualified"))
    changed = raw.replace(b'"commit_sha":"', b'"commit_sha":"' + b'd' * 40 + b'","commit_sha":"')
    with pytest.raises(v.JournalError, match="duplicate_key"):
        call(v.decode, changed, observed_at=NOW)


def test_nonnative_input_types_rejected_before_json_normalization(call):
    class Text(str):
        pass
    class Integer(int):
        pass
    class Object(dict):
        pass
    for changed in (dict(event(), source_sha=Text(SOURCE)), dict(event(), run_id=Integer(10008)), Object(event())):
        with pytest.raises(v.JournalError):
            add(call, empty(call), changed)
    with pytest.raises(v.JournalError):
        call(v.encode, Object(v.new_journal()), observed_at=NOW)


def test_out_of_order_or_duplicate_persisted_identity_rejected(call):
    raw = add(call, empty(call), event("2026-10-09", 10009))
    with pytest.raises(v.JournalError, match="order_invalid"):
        add(call, raw, event())
    value = event()
    state = {"profile": v.PROFILE, "events": [value, copy.deepcopy(value)]}
    with pytest.raises(v.JournalError, match="conflicting_replay"):
        call(v.encode, state, observed_at=NOW)


def test_capacity_fail_closed_no_silent_retention_or_reset(call):
    entries = [event(run_id=20000 + i, attempt=1) for i in range(v.MAX_EVENTS)]
    raw = call(v.encode, {"profile": v.PROFILE, "events": entries}, observed_at=NOW)
    with pytest.raises(v.JournalError, match="bounds_exceeded"):
        add(call, raw, event(run_id=30000))
    assert add(call, raw, entries[-1]) == raw


def test_calendar_binding_contradiction_future_and_missing_invalid(call):
    raw = add(call, empty(call), event())
    for dates in ([], ["2026-10-09", "2026-10-08"], ["2026-10-08", "2026-10-08"], ["2026-10-12"]):
        with pytest.raises(v.JournalError):
            summary(call, raw, dates)
    with pytest.raises(v.JournalError):
        call(v.summarize, raw, observed_at=NOW, expected_dates=("2026-10-08",), calendar_sha256="unknown")


def test_error_constructor_never_exports_unknown_exception_text():
    assert str(v.JournalError("nav=123 token=secret")) == "schema_invalid"


def test_two_zero_dates_recover_same_day_then_next_zero_starts_new_streak(call):
    raw = add(call, empty(call), event("2026-09-29", 10001, outcome="qualified", reason="financial_qualified"))
    raw = add(call, raw, event("2026-09-30", 10002))
    raw = add(call, raw, event())
    dates = ["2026-09-29", "2026-09-30", "2026-10-08"]
    before = summary(call, raw, dates)
    assert before["zero_streak_exact"] == 2
    assert before["alert_required"] is True
    recovered = event(run_id=10010, outcome="qualified", reason="financial_qualified", clock="07:00:00", end="07:01:00")
    raw = add(call, raw, recovered)
    current = summary(call, raw, dates)
    assert current["zero_streak_exact"] == 0
    assert current["alert_required"] is False
    assert current["latest_scheduled_failure_index"] == 2
    assert current["last_qualified_financial_index"] == 3
    assert current["event_count"] == 4
    first_zero = event("2026-10-09", 10011, workflow_status="succeeded", workflow_reason="workflow_completed")
    raw = add(call, raw, first_zero)
    next_day = summary(call, raw, dates + ["2026-10-09"])
    assert next_day["zero_streak_lower_bound"] == next_day["zero_streak_exact"] == 1
    assert next_day["history_complete_for_streak"] is True
    assert next_day["alert_required"] is False
    assert next_day["last_qualified_financial_index"] == 3
    state = call(v.decode, raw, observed_at=NOW)
    assert state["events"][1]["outcome"] == state["events"][2]["outcome"] == "zero_effective"


def test_same_date_new_run_and_attempt_zero_are_one_daily_failure_not_recovery(call):
    raw = add(call, empty(call), event("2026-09-30", 10001, outcome="qualified", reason="financial_qualified"))
    first = event()
    raw = add(call, raw, first)
    assert add(call, raw, first) == raw
    raw = add(call, raw, event(attempt=2, clock="07:00:00", end="07:01:00"))
    raw = add(call, raw, event(run_id=10009, clock="07:10:00", end="07:11:00"))
    result = summary(call, raw, ["2026-09-30", "2026-10-08"])
    assert result["zero_streak_lower_bound"] == result["zero_streak_exact"] == 1
    assert result["event_count"] == 4
    assert result["expected_observed_date_count"] == 2
    assert result["alert_required"] is True
    assert result["last_qualified_financial_index"] == 0
    assert result["latest_scheduled_failure_index"] == 3


def test_failed_producer_then_qualified_retry_recovers_but_preserves_history(call):
    failed = event(outcome="failed", reason="producer_failed")
    raw = add(call, empty(call), failed)
    assert summary(call, raw, ["2026-10-08"])["alert_required"] is True
    recovered = event(run_id=10010, outcome="qualified", reason="financial_qualified", clock="07:00:00", end="07:01:00")
    raw = add(call, raw, recovered)
    result = summary(call, raw, ["2026-10-08"])
    assert result["zero_streak_exact"] == 0
    assert result["alert_required"] is False
    assert result["latest_scheduled_failure_index"] == 0
    assert result["last_qualified_financial_index"] == 1
    assert call(v.decode, raw, observed_at=NOW)["events"][0] == failed


def test_qualified_data_ci_failure_then_qualified_completed_retry_recovers_execution(call):
    failed_ci = event(outcome="qualified", reason="financial_qualified", workflow_status="failed", workflow_reason="ci_dispatch_failed")
    raw = add(call, empty(call), failed_ci)
    before = summary(call, raw, ["2026-10-08"])
    assert before["zero_streak_exact"] == 0
    assert before["alert_required"] is True
    recovered = event(run_id=10010, outcome="qualified", reason="financial_qualified", clock="07:00:00", end="07:01:00")
    raw = add(call, raw, recovered)
    result = summary(call, raw, ["2026-10-08"])
    assert result["zero_streak_exact"] == 0
    assert result["alert_required"] is False
    assert result["latest_scheduled_failure_index"] == 0
    assert result["last_qualified_financial_index"] == 1
    assert call(v.decode, raw, observed_at=NOW)["events"][0] == failed_ci


def test_manual_and_holiday_after_two_zero_dates_cannot_recover_current_failure(call):
    raw = add(call, empty(call), event("2026-09-29", 10001, outcome="qualified", reason="financial_qualified"))
    raw = add(call, raw, event("2026-09-30", 10002))
    raw = add(call, raw, event())
    manual = event(run_id=10011, outcome="skipped", reason="manual_observation_only", mode="manual", clock="07:10:00", end="07:11:00")
    raw = add(call, raw, manual)
    holiday = event("2026-10-10", 10012, outcome="skipped", reason="non_trading_day", expectation="non_trading", window="non_trading_day")
    raw = add(call, raw, holiday)
    result = summary(call, raw, ["2026-09-29", "2026-09-30", "2026-10-08"])
    assert result["zero_streak_exact"] == 2
    assert result["alert_required"] is True
    assert result["latest_scheduled_failure_index"] == 2
    assert result["last_qualified_financial_index"] == 0
    assert result["latest_attempt_index"] == 4


def test_maximum_javascript_safe_native_run_id_round_trips_without_conversion(call):
    value = event(run_id=2**53 - 1)
    raw = add(call, empty(call), value)
    assert b'"run_id":9007199254740991' in raw
    state = call(v.decode, raw, observed_at=NOW)
    assert type(state["events"][0]["run_id"]) is int
    assert state["events"][0]["run_id"] == 2**53 - 1
    assert add(call, raw, value) == raw


@pytest.mark.parametrize("run_id", [2**53, 2**53 + 1, 10**18 - 1, True, 10008.0, "10008"])
def test_unsafe_or_nonnative_run_id_rejected_without_truncation(call, run_id):
    with pytest.raises(v.JournalError, match="schema_invalid"):
        add(call, empty(call), event(run_id=run_id))
    external = dict(binding(event()), run_id=run_id)
    with pytest.raises(v.JournalError, match="schema_invalid"):
        call(v.append, empty(call), event(), binding=external, observed_at=NOW)


@pytest.mark.parametrize("external", [{}, None, [], False, 0, ""])
def test_empty_null_or_false_external_binding_rejected_directly(call, external):
    with pytest.raises(v.JournalError, match="schema_invalid"):
        call(v.append, empty(call), event(), binding=external, observed_at=NOW)


def test_helper_does_not_replace_explicit_empty_binding_with_event_identity(call):
    with pytest.raises(v.JournalError, match="schema_invalid"):
        add(call, empty(call), event(), external={})


@pytest.mark.parametrize("field", sorted(v._BINDING_KEYS))
def test_missing_external_binding_field_rejected_directly(call, field):
    external = binding(event())
    del external[field]
    with pytest.raises(v.JournalError, match="schema_invalid"):
        call(v.append, empty(call), event(), binding=external, observed_at=NOW)


def test_extra_external_binding_field_rejected_directly(call):
    external = dict(binding(event()), message="not_exported")
    with pytest.raises(v.JournalError, match="schema_invalid"):
        call(v.append, empty(call), event(), binding=external, observed_at=NOW)
