"""Synthetic-only index producer contract boundaries; no real source or artifact."""
import datetime
import importlib.util
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
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
