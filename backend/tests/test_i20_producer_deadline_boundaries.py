"""Synthetic-only I20 producer and successful private-read deadline regressions.

No provider request or real artifact is used. Deadline phase tests retain the real
monotonic clock and use allowed one-second test configuration, not changed defaults.
"""
import datetime
import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TODAY = datetime.date(2026, 10, 11)
ORIGINAL = b"synthetic-last-qualified-artifact"


def _load_tool(name):
    spec = importlib.util.spec_from_file_location(
        f"i20_boundary_{name}", ROOT / "tools" / f"{name}.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


index = _load_tool("enrich_index_valuation")
calibration = _load_tool("calibrate_strategy")


class NativeDictSubclass(dict):
    def get(self, *_args, **_kwargs):
        pytest.fail("a non-native producer record must not be inspected")


class NativeStrSubclass(str):
    pass


class NativeIntSubclass(int):
    pass


def _core_row(name="沪深300", source_date=None):
    source_date = TODAY.isoformat() if source_date is None else source_date
    return {
        "name": name, "symbol": name, "date": source_date,
        "pe": 12.0, "pe_pct": 50.0, "pe_date": source_date,
        "pb": 1.2, "pb_pct": 40.0, "pb_date": source_date,
    }


def _six_core(source_date=None):
    return [_core_row(name, source_date) for name in sorted(index.CORE_INDICES)]


def _producer(monkeypatch, tmp_path, rows):
    output = tmp_path / "index-valuation.json"
    output.write_bytes(ORIGINAL)
    monkeypatch.setitem(sys.modules, "akshare", object())
    monkeypatch.setattr(index, "OUT", str(output))
    monkeypatch.setattr(index, "fetch_index_valuation", lambda _ak: rows)
    monkeypatch.setattr(index, "_beijing_today", lambda now=None: TODAY)
    return output


def _unchanged(output):
    assert output.read_bytes() == ORIGINAL
    assert not output.with_suffix(".json.tmp").exists()


@pytest.mark.parametrize("record", [None, [], "record", NativeDictSubclass(), {"name": []}])
def test_core_native_record_check_precedes_get_or_membership(record):
    assert index._valid_core_item(record) is False


@pytest.mark.parametrize("value", [
    None, "", "2026-02-31", "2026-10-1", "2026/10/11",
    "2026-10-11T00:00:00", datetime.date(2026, 10, 11),
    NativeStrSubclass("2026-10-11"), [], {},
])
def test_core_requires_native_canonical_nonmissing_dates(value):
    item = _core_row()
    item.update(date=value, pe_date=value, pb_date=value)
    assert index._valid_core_item(item) is False


@pytest.mark.parametrize("value", [True, NativeIntSubclass(12), 10 ** 1000, float("inf"), float("nan")])
def test_core_native_finite_metric_rejects_bool_subclass_overflow_or_nonfinite(value):
    item = _core_row()
    item["pe"] = value
    assert index._valid_core_item(item) is False


@pytest.mark.parametrize("records", [None, (), {}, [None], [NativeDictSubclass()], [{"name": []}]])
def test_producer_bad_native_record_contract_preserves_file(records, monkeypatch, tmp_path):
    output = _producer(monkeypatch, tmp_path, records)
    assert index.main() == 1
    _unchanged(output)


@pytest.mark.parametrize(("age_days", "exit_code"), [(0, 0), (7, 0), (8, 1), (-1, 1)])
def test_six_core_age_boundary_preserves_real_source_date(age_days, exit_code, monkeypatch, tmp_path):
    source_date = (TODAY - datetime.timedelta(days=age_days)).isoformat()
    output = _producer(monkeypatch, tmp_path, _six_core(source_date))
    assert len(index.CORE_INDICES) == 6
    assert index.MAX_CORE_AGE_DAYS == 7
    assert index.main() == exit_code
    if exit_code:
        _unchanged(output)
    else:
        payload = json.loads(output.read_text(encoding="utf-8"))
        assert payload["coverage"]["core_returned"] == payload["coverage"]["core_requested"] == 6
        assert payload["updated"] == source_date
        assert all(row["date"] == row["pe_date"] == row["pb_date"] == source_date for row in payload["indices"])


def test_noncore_future_day_rejects_without_overwriting(monkeypatch, tmp_path):
    rows = _six_core() + [_core_row("创业板指", (TODAY + datetime.timedelta(days=1)).isoformat())]
    output = _producer(monkeypatch, tmp_path, rows)
    assert index.main() == 1
    _unchanged(output)


def test_noncore_old_partial_keeps_dates_and_null_without_claiming_current(monkeypatch, tmp_path):
    old_date = (TODAY - datetime.timedelta(days=8)).isoformat()
    optional = _core_row("创业板指", old_date)
    optional.update(pb=None, pb_pct=None, pb_date=None)
    output = _producer(monkeypatch, tmp_path, _six_core() + [optional])
    assert index.main() == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["coverage"]["core_returned"] == 6
    assert payload["updated"] == old_date
    assert payload["indices"][-1] == optional
    assert payload["indices"][-1]["pb"] is None


@pytest.mark.parametrize("date_value", [None, "2026-02-31", [], NativeStrSubclass("2026-10-11")])
def test_noncore_invalid_native_date_preserves_file(date_value, monkeypatch, tmp_path):
    optional = _core_row("创业板指")
    optional["date"] = date_value
    output = _producer(monkeypatch, tmp_path, _six_core() + [optional])
    assert index.main() == 1
    _unchanged(output)


def test_producer_beijing_date_boundary_uses_utc_instant():
    before = datetime.datetime(2026, 10, 10, 15, 59, 59, tzinfo=datetime.timezone.utc)
    boundary = datetime.datetime(2026, 10, 10, 16, 0, tzinfo=datetime.timezone.utc)
    assert index._beijing_today(before) == datetime.date(2026, 10, 10)
    assert index._beijing_today(boundary) == TODAY


class BoundedResponse:
    def __init__(self, *, on_close=None):
        self.body = b'{"total":0,"summary":[],"items":[]}'
        self.offset = 0
        self.headers = {}
        self.on_close = on_close
        self.closed = False
        self.timeouts = []
        sock = type("SyntheticSocket", (), {
            "settimeout": lambda _self, value: self.timeouts.append(value),
        })()
        raw = type("SyntheticRaw", (), {"_sock": sock})()
        self.fp = type("SyntheticFP", (), {"raw": raw})()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        if self.on_close:
            self.on_close()
        self.closed = True
        return False

    def read1(self, size):
        end = min(len(self.body), self.offset + size)
        chunk = self.body[self.offset:end]
        self.offset = end
        return chunk


def _private_reader(monkeypatch, *, attempts=1, timeout=1, total=1):
    monkeypatch.setattr(calibration, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(calibration, "PRIVATE_READ_TOKEN", "synthetic-test-token")
    monkeypatch.setattr(calibration, "ALLOW_INSECURE_LOOPBACK", False)
    monkeypatch.setattr(calibration, "OUTCOME_ATTEMPTS", attempts)
    monkeypatch.setattr(calibration, "OUTCOME_TIMEOUT_SECONDS", timeout)
    monkeypatch.setattr(calibration, "OUTCOME_TOTAL_BUDGET_SECONDS", total)
    monkeypatch.setattr(calibration, "OUTCOME_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(calibration, "OUTCOME_RETRY_AFTER_MAX_SECONDS", 0)

    def forbidden_open(*_args, **_kwargs):
        pytest.fail("no real provider request is permitted in these tests")

    monkeypatch.setattr(calibration.OUTCOME_OPENER, "open", forbidden_open)


def _wait_past_real_budget(started, seconds):
    remaining = started + seconds + 0.05 - time.monotonic()
    if remaining > 0:
        time.sleep(remaining)


def test_private_cleanup_exhausts_total_budget_without_retry_or_public_write(monkeypatch, tmp_path):
    _private_reader(monkeypatch, attempts=3, timeout=2, total=1)
    opened_at = []
    response = BoundedResponse(on_close=lambda: _wait_past_real_budget(opened_at[0], 1))
    calls = []
    registry = tmp_path / "registry.json"
    report = tmp_path / "report.json"
    registry.write_bytes(ORIGINAL)
    report.write_bytes(ORIGINAL)
    monkeypatch.setattr(calibration, "REGISTRY", registry)
    monkeypatch.setattr(calibration, "PUBLIC_REPORT", report)
    monkeypatch.setattr(calibration, "load_registry", lambda: {"active": {"version": "synthetic"}, "history": []})
    monkeypatch.setattr(calibration, "sample_codes", lambda: pytest.fail("expired private read must stop before public sampling"))

    def open_response(request, timeout):
        calls.append(request.get_method())
        opened_at.append(time.monotonic())
        assert timeout > 0
        return response

    monkeypatch.setattr(calibration.OUTCOME_OPENER, "open", open_response)
    with pytest.raises(RuntimeError) as caught:
        calibration.main()
    assert str(caught.value) == "outcome audit unavailable after 1 attempt(s): deadline_exceeded"
    assert calls == ["GET"]
    assert response.closed and response.timeouts
    assert registry.read_bytes() == report.read_bytes() == ORIGINAL


def test_private_cleanup_attempt_timeout_can_retry_only_inside_total_budget(monkeypatch):
    _private_reader(monkeypatch, attempts=2, timeout=1, total=3)
    opened_at = []
    responses = [
        BoundedResponse(on_close=lambda: _wait_past_real_budget(opened_at[0], 1)),
        BoundedResponse(),
    ]
    calls = []

    def open_response(request, timeout):
        calls.append(request.get_method())
        assert timeout > 0
        opened_at.append(time.monotonic())
        return responses[len(calls) - 1]

    monkeypatch.setattr(calibration.OUTCOME_OPENER, "open", open_response)
    assert calibration.fetch_outcomes() == {"total": 0, "summary": [], "items": []}
    assert calls == ["GET", "GET"]
    assert all(response.closed for response in responses)


def test_private_structure_completion_is_inside_real_return_budget(monkeypatch):
    _private_reader(monkeypatch)
    opened_at = []
    real_loads = json.loads
    inspected = []
    response = BoundedResponse()
    calls = []

    class DelayedLegacyDict(dict):
        def get(self, key, default=None):
            value = super().get(key, default)
            if key == "summary":
                inspected.append(key)
                _wait_past_real_budget(opened_at[0], 1)
            return value

    monkeypatch.setattr(calibration.json, "loads", lambda raw: DelayedLegacyDict(real_loads(raw)))

    def open_response(request, timeout):
        calls.append(request.get_method())
        opened_at.append(time.monotonic())
        assert timeout > 0
        return response

    monkeypatch.setattr(calibration.OUTCOME_OPENER, "open", open_response)
    with pytest.raises(RuntimeError) as caught:
        calibration.fetch_outcomes()
    assert str(caught.value) == "outcome audit unavailable after 1 attempt(s): deadline_exceeded"
    assert inspected == ["summary"]
    assert response.closed
    assert calls == ["GET"]


def test_private_final_return_guard_uses_real_expired_deadline():
    expired = time.monotonic() - 0.001
    with pytest.raises(RuntimeError) as caught:
        calibration._require_outcome_return_budget(expired, 2)
    assert str(caught.value) == "outcome audit unavailable after 2 attempt(s): deadline_exceeded"


def test_private_fast_legacy_empty_contract_still_succeeds(monkeypatch):
    _private_reader(monkeypatch)
    response = BoundedResponse()
    calls = []

    def open_response(request, timeout):
        calls.append(request.get_method())
        assert timeout > 0
        return response

    monkeypatch.setattr(calibration.OUTCOME_OPENER, "open", open_response)
    assert calibration.fetch_outcomes() == {"total": 0, "summary": [], "items": []}
    assert response.closed
    assert calls == ["GET"]
