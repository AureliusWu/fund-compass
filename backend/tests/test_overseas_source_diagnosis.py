import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("diagnosis", ROOT / "tools/diagnose_overseas_sources.py")
diagnosis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnosis)


@pytest.mark.parametrize("date,reason", [("2026-11-10", "axis_base_stale"),
                                         ("2026-11-12", "axis_base_ahead")])
def test_source_age_and_late_observation_remain_distinct(date, reason):
    detail = {"latest_nav_date": date, "latest_nav": 5, "nav_history": [{"date": date, "nav": 5}]}
    counts, selected = diagnosis.snapshot(detail, "2026-11-13")
    assert selected == date
    assert counts == {reason: 1, "axis_base_date_mismatch": 1}


def test_primary_parser_reads_data_without_executing_javascript():
    stamp = int(dt.datetime(2026, 11, 12, tzinfo=diagnosis.producer.CST).timestamp() * 1000)
    raw = ('throw new Error("not executed"); var Data_netWorthTrend = ' + json.dumps([{"x": stamp, "y": 5}]) + ';').encode()
    assert diagnosis.primary_date(raw) == "2026-11-12"


@pytest.mark.parametrize("raw", [b"HTML", b"var Data_netWorthTrend=[];",
                                b'var Data_netWorthTrend=[{"x":true,"y":5}];'])
def test_invalid_primary_is_unknown(raw):
    with pytest.raises(ValueError):
        diagnosis.primary_date(raw)


def test_read_only_run_stops_on_access_denial_and_never_uses_another_source(monkeypatch, tmp_path):
    registry = tmp_path / "models.json"
    registry.write_text(json.dumps({"models": {"539002": {}, "012920": {}}}))
    monkeypatch.setattr(diagnosis.producer, "REGISTRY", registry)
    monkeypatch.setattr(diagnosis.producer, "FUND_API_BASE", "https://api.test")
    requests = []
    def denied(url):
        requests.append(url)
        raise diagnosis.urllib.error.HTTPError(url, 403, "private response", {}, None)
    monkeypatch.setattr(diagnosis, "read", denied)
    result = diagnosis.run(dt.datetime(2026, 11, 14, 15, tzinfo=diagnosis.producer.CST))
    assert len(requests) == 1
    assert result["observation_date"] == "2026-11-13"
    assert result["counts"] == {"api_http_403": 1, "source_access_stopped": 1}
    assert "private response" not in json.dumps(result)
