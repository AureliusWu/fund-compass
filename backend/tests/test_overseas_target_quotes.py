"""Synthetic source-adapter cases; no providers, credentials or business writes."""
import copy
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import urllib.error

import pytest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "overseas_target_quote_tests", ROOT / "tools" / "overseas_target_quotes.py"
)
quotes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quotes)

BASE, TARGET = "2026-11-02", "2026-11-03"
NOW = dt.datetime(2026, 11, 4, 22, 50, tzinfo=quotes.CST)


def live():
    return {"source_symbol": "QQQ.OQ", "quote_date": "2026-11-04",
            "change": -3, "source": "synthetic-live", "quote_time": "2026-11-04 09:50:00"}


def history():
    return {"code": 0, "data": {"usQQQ.OQ": {"qfqday": [
        [BASE, "100", "100", "101", "99", "12"],
        [TARGET, "100", "102", "103", "99", "14"],
    ]}}}


def official():
    return {"status": {"rCode": 200}, "data": {"symbol": "QQQ", "totalRecords": 2, "tradesTable": {"rows": [
        {"date": "11/03/2026", "close": "$102.00"},
        {"date": "11/02/2026", "close": "$100.00"},
    ]}}}


def verify(l=None, h=None, o=None, **kwargs):
    return quotes.verify_daily_evidence(
        "usQQQ", live() if l is None else l,
        kwargs.get("target", TARGET), kwargs.get("base", BASE), kwargs.get("now", NOW),
        history() if h is None else h, official() if o is None else o,
    )


def test_delayed_quote_uses_exact_independently_equal_closes_without_invented_time():
    l, h, o = live(), history(), official()
    before = copy.deepcopy((l, h, o))
    result = verify(l, h, o)
    assert result["change"] == 2
    assert result["quote_date"] == TARGET
    assert result["quote_time"] == TARGET
    assert result["time_precision"] == "date"
    assert result["source"] == "tencent_daily_nasdaq_verified"
    assert (result["previous_close"], result["close"]) == (100, 102)
    assert (l, h, o) == before


@pytest.mark.parametrize("mutate,reason", [
    (lambda l, h, o: l.update(source_symbol="SPY.OQ"), "symbol_identity_invalid"),
    (lambda l, h, o: l.update(source_symbol="QQQ"), "symbol_identity_invalid"),
    (lambda l, h, o: h["data"].update({"usQQQ": h["data"].pop("usQQQ.OQ")}), "symbol_identity_invalid"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"][0].__setitem__(0, "2011-06-02"), "history_date_invalid"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"].pop(), "history_shape_invalid"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"][1].__setitem__(0, "2026-11-04"), "history_date_invalid"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"][1].__setitem__(0, BASE), "history_date_invalid"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"][0].__setitem__(0, "2026-10-30"), "history_date_missing"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"].extend([[BASE] * 6] * 7), "history_shape_invalid"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"][0].__setitem__(2, True), "price_invalid"),
    (lambda l, h, o: h["data"]["usQQQ.OQ"]["qfqday"][0].__setitem__(2, 0), "price_invalid"),
    (lambda l, h, o: o["data"]["tradesTable"]["rows"][0].update(close=None), "price_invalid"),
    (lambda l, h, o: o["data"]["tradesTable"]["rows"][0].update(close="NaN"), "price_invalid"),
    (lambda l, h, o: o["data"]["tradesTable"]["rows"][0].update(close="101.99"), "price_basis_mismatch"),
    (lambda l, h, o: o["data"].update(symbol="SPY"), "symbol_identity_invalid"),
    (lambda l, h, o: o["status"].update(rCode=True), "verification_shape_invalid"),
    (lambda l, h, o: o["data"]["tradesTable"]["rows"][0].update(date="11/04/2026"), "verification_date_missing"),
    (lambda l, h, o: l.update(quote_date="2026-11-05"), "live_date_invalid"),
    (lambda l, h, o: l.update(quote_date="2026-10-30"), "live_date_invalid"),
], ids=["wrong-symbol", "missing-suffix", "unqualified-response", "sparse-2011", "missing-target",
        "future-history", "duplicate-date", "missing-base", "too-many-rows", "bool-price", "zero-price", "null-price", "nan-price",
        "adjustment-mismatch", "wrong-official-symbol", "bool-status", "wrong-official-date",
        "future-live", "stale-live"])
def test_source_gaps_and_different_price_bases_remain_missing(mutate, reason):
    l, h, o = live(), history(), official()
    mutate(l, h, o)
    with pytest.raises(quotes.QuoteEvidenceError, match="^" + reason + "$"):
        verify(l, h, o)


@pytest.mark.parametrize("now,base,target", [
    (NOW.replace(tzinfo=None), BASE, TARGET),
    (NOW, BASE, "2026-11-04"),
    (NOW, TARGET, TARGET),
    (NOW, "2026-10-23", TARGET),
])
def test_observation_and_date_bounds_reject_future_or_unzoned_evidence(now, base, target):
    with pytest.raises(quotes.QuoteEvidenceError):
        verify(now=now, base=base, target=target)


def test_same_day_live_history_disagreement_is_an_explicit_conflict():
    l = {**live(), "quote_date": TARGET, "change": 3}
    with pytest.raises(quotes.QuoteEvidenceError, match="^live_conflict$"):
        verify(l=l)
    l["change"] = 2
    assert verify(l=l) == l


def test_zero_return_is_valid_and_never_replaced_by_missing():
    h, o = history(), official()
    h["data"]["usQQQ.OQ"]["qfqday"][1][2] = "100"
    o["data"]["tradesTable"]["rows"][0]["close"] = "100"
    assert verify(h=h, o=o)["change"] == 0


def test_no_intervening_market_session_can_be_skipped():
    h = history()
    h["data"]["usQQQ.OQ"]["qfqday"].insert(0, ["2026-10-30", "100", "100", "101", "99", "1"])
    with pytest.raises(quotes.QuoteEvidenceError, match="^base_not_previous_session$"):
        verify(h=h, base="2026-10-30")


def test_bounded_network_adapter_preserves_live_and_reports_rejected_history():
    calls, counts = [], {}
    h = history()
    h["data"]["usQQQ.OQ"]["qfqday"][1][2] = "101"

    def request(url, timeout):
        calls.append((url, timeout))
        return h if "gtimg.cn" in url else official()

    original = {"usQQQ": live()}
    result = quotes.supplement_target_quotes(original, {"usQQQ"}, TARGET, BASE, NOW,
                                             requester=request, diagnostics=counts)
    assert result == original
    assert counts == {"history_price_basis_mismatch": 1}
    assert "usQQQ.OQ,day,,2026-11-03,8,qfq" in calls[0][0]
    assert all(0 < timeout <= quotes.REQUEST_SECONDS for _, timeout in calls)


@pytest.mark.parametrize("status", [401, 403, 429])
def test_restricted_source_stops_without_retry_or_identity_fallback(status):
    calls, counts = [], {}

    def blocked(url, timeout):
        calls.append(url)
        raise urllib.error.HTTPError(url, status, "synthetic", {}, None)

    result = quotes.supplement_target_quotes(
        {"usQQQ": live(), "usSMH": {**live(), "source_symbol": "SMH.OQ"}},
        {"usQQQ", "usSMH"}, TARGET, BASE, NOW, requester=blocked, diagnostics=counts,
    )
    assert len(calls) == 1
    assert counts == {"history_http_" + str(status): 1}
    assert result["usQQQ"] == live()


def test_one_total_deadline_prevents_a_second_source_request():
    ticks = iter([0, 0, quotes.TOTAL_SECONDS + 1])
    calls, counts = [], {}

    def request(url, timeout):
        calls.append(url)
        return history()

    result = quotes.supplement_target_quotes(
        {"usQQQ": live()}, {"usQQQ"}, TARGET, BASE, NOW,
        requester=request, monotonic=lambda: next(ticks), diagnostics=counts,
    )
    assert calls and len(calls) == 1
    assert result["usQQQ"] == live()
    assert counts == {"history_budget_exceeded": 1}


def test_usable_live_quotes_and_unknown_source_identities_do_not_start_history_io():
    def forbidden(*args):
        raise AssertionError("unexpected network")

    current = {"usQQQ": {**live(), "quote_date": TARGET}, "usSMH": {"quote_date": "2026-11-04"}}
    counts = {}
    assert quotes.supplement_target_quotes(current, set(current), TARGET, BASE, NOW,
                                           requester=forbidden, diagnostics=counts) == current
    assert counts == {"history_symbol_identity_invalid": 1}


def test_http_body_limit_is_checked_before_decoding(monkeypatch):
    url = "https://api.nasdaq.com/api/quote/QQQ/historical"

    class Response(io.BytesIO):
        def geturl(self):
            return url

    monkeypatch.setattr(quotes.urllib.request, "urlopen",
                        lambda *args, **kwargs: Response(b"x" * (quotes.MAX_BODY + 1)))
    with pytest.raises(quotes.QuoteEvidenceError, match="^body_limit_exceeded$"):
        quotes.request_json(url, 1)


@pytest.mark.parametrize("raw", [
    b'{"code":0,"code":1}', b'{"data":{"close":1,"close":2}}',
    b'{"change":NaN}', b'{"change":Infinity}', b'{"change":-Infinity}',
    b'{"close":1e309}', b'{"close":-1e309}', b'{"price":}', b'\xff',
], ids=["duplicate-root", "duplicate-nested", "nan", "infinity", "negative-infinity",
        "float-overflow", "negative-float-overflow", "invalid-json", "invalid-utf8"])
def test_real_http_json_reader_rejects_ambiguous_or_nonfinite_input(monkeypatch, raw):
    url = "https://api.nasdaq.com/api/quote/QQQ/historical"

    class Response(io.BytesIO):
        def geturl(self):
            return url

    monkeypatch.setattr(quotes.urllib.request, "urlopen", lambda *args, **kwargs: Response(raw))
    with pytest.raises(quotes.QuoteEvidenceError, match="^json_invalid$"):
        quotes.request_json(url, 1)


@pytest.mark.parametrize("ticks", [[0, 0, 1, 30], [0, 0, 1, 2, 30]])
def test_second_source_parse_and_validation_must_finish_inside_total_budget(ticks):
    clock, counts, calls = iter(ticks), {}, []

    def request(url, timeout):
        calls.append(url)
        return history() if "gtimg.cn" in url else official()

    result = quotes.supplement_target_quotes(
        {"usQQQ": live()}, {"usQQQ"}, TARGET, BASE, NOW,
        requester=request, monotonic=lambda: next(clock), diagnostics=counts,
    )
    assert len(calls) == 2
    assert result["usQQQ"] == live()
    assert counts == {"history_budget_exceeded": 1}


@pytest.mark.parametrize("now", [NOW.replace(tzinfo=None), NOW - dt.timedelta(days=1)])
def test_invalid_observation_is_rejected_before_any_provider_io(now):
    def forbidden(*args):
        raise AssertionError("invalid dates must not start a request")

    counts = {}
    result = quotes.supplement_target_quotes({"usQQQ": live()}, {"usQQQ"}, TARGET, BASE,
                                             now, requester=forbidden, diagnostics=counts)
    assert result["usQQQ"] == live()
    assert sum(counts.values()) == 1


@pytest.mark.parametrize("ticks", [[float("nan")], [10, 9]])
def test_invalid_or_backward_budget_clock_cannot_start_provider_io(ticks):
    clock = iter(ticks)
    counts = {}

    def forbidden(*args):
        raise AssertionError("invalid clock must not start a request")

    result = quotes.supplement_target_quotes(
        {"usQQQ": live()}, {"usQQQ"}, TARGET, BASE, NOW,
        requester=forbidden, diagnostics=counts, monotonic=lambda: next(clock),
    )
    assert result["usQQQ"] == live()
    assert counts == {"history_clock_invalid": 1}


def load_accuracy():
    spec = importlib.util.spec_from_file_location("delayed_pipeline_accuracy", ROOT / "tools" / "overseas_accuracy.py")
    accuracy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(accuracy)
    return accuracy


def pipeline_fixture(tmp_path, monkeypatch, *, known_target=False):
    accuracy = load_accuracy()
    registry = {"models": {"synthetic-fund": {"active": {
        "version": "synthetic-v1", "label": "synthetic", "min_weight": 100,
        "legs": [{"code": "usQQQ", "weight": 100}], "scale": 1, "bias": 0,
    }}}}
    # Preserve a prior public observation exactly; no historical repair is allowed.
    original = {"code": "synthetic-fund", "status": "observed_only", "note": "original history"}
    ledger_path, registry_path = tmp_path / "ledger.json", tmp_path / "registry.json"
    ledger_path.write_text(json.dumps({"records": [original]}), encoding="utf-8")
    registry_path.write_text(json.dumps(registry), encoding="utf-8")
    detail = {"latest_nav_date": TARGET if known_target else BASE,
              "latest_nav": 5, "nav_history": [{"date": BASE, "nav": 5}]}
    if known_target:
        detail["nav_history"].append({"date": TARGET, "nav": 5})
    monkeypatch.setattr(accuracy, "FUND_API_BASE", "https://synthetic.test")
    monkeypatch.setattr(accuracy, "REGISTRY", registry_path)
    monkeypatch.setattr(accuracy, "LEDGER", ledger_path)
    monkeypatch.setattr(accuracy, "fetch_details", lambda codes: {"synthetic-fund": detail})
    monkeypatch.setattr(accuracy, "fetch_quotes", lambda codes: {"usQQQ": live()})
    return accuracy, ledger_path, original


def test_pipeline_delayed_same_day_prediction_retains_real_observation_axis_and_history(tmp_path, monkeypatch):
    accuracy, path, original = pipeline_fixture(tmp_path, monkeypatch)
    requests = []

    def request(url, timeout):
        requests.append(url)
        return history() if "gtimg.cn" in url else official()

    monkeypatch.setattr(accuracy.overseas_target_quotes, "request_json", request)
    result = accuracy.run_pipeline(NOW, run_mode="scheduled")
    ledger = json.loads(path.read_text(encoding="utf-8"))
    assert result["predictions_written"] == 1
    assert ledger["records"][0] == original
    row = ledger["records"][1]
    assert (row["prediction_date"], row["target_nav_date"], row["base_nav_date"]) == (
        "2026-11-04", TARGET, BASE,
    )
    assert row["observed_at"] == NOW.isoformat(timespec="seconds")
    assert row["status"] == "pending"
    assert row["feature_evidence"]["usQQQ"]["verification_source"] == "nasdaq_historical_close"
    assert ledger["pipeline"]["prediction_diagnostics"]["history_target_quote_accepted"] == 1
    assert len(requests) == 2


def test_known_target_nav_does_not_authorize_retrospective_forecast_or_history_fetch(tmp_path, monkeypatch):
    accuracy, path, original = pipeline_fixture(tmp_path, monkeypatch, known_target=True)

    def forbidden(*args):
        raise AssertionError("known target NAV must not authorize history fetch")

    monkeypatch.setattr(accuracy.overseas_target_quotes, "request_json", forbidden)
    result = accuracy.run_pipeline(NOW, run_mode="scheduled")
    ledger = json.loads(path.read_text(encoding="utf-8"))
    assert result["predictions_written"] == 0
    assert ledger["records"] == [original]
    assert ledger["pipeline"]["prediction_diagnostics"] == {
        "axis_base_date_mismatch": 1, "axis_base_ahead": 1,
    }


@pytest.mark.parametrize("mode,now", [("manual", NOW), ("scheduled", NOW.replace(day=5, hour=1))])
def test_manual_and_cross_day_invocations_never_backfill_history_forecasts(tmp_path, monkeypatch, mode, now):
    accuracy, path, original = pipeline_fixture(tmp_path, monkeypatch)

    def forbidden(*args):
        raise AssertionError("manual/cross-day must not request forecast sources")

    monkeypatch.setattr(accuracy, "fetch_quotes", forbidden)
    monkeypatch.setattr(accuracy.overseas_target_quotes, "request_json", forbidden)
    result = accuracy.run_pipeline(now, run_mode=mode)
    assert result["predictions_written"] == 0
    assert json.loads(path.read_text(encoding="utf-8"))["records"] == [original]


def test_already_recorded_daily_prediction_is_not_replaced_or_refetched(tmp_path, monkeypatch):
    accuracy, path, original = pipeline_fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(accuracy.overseas_target_quotes, "request_json",
                        lambda url, timeout: history() if "gtimg.cn" in url else official())
    accuracy.run_pipeline(NOW, run_mode="scheduled")
    before = json.loads(path.read_text(encoding="utf-8"))["records"]

    def forbidden(*args):
        raise AssertionError("recorded prediction must not be sourced again")

    monkeypatch.setattr(accuracy.overseas_target_quotes, "request_json", forbidden)
    result = accuracy.run_pipeline(NOW, run_mode="scheduled")
    assert result["predictions_written"] == 0
    assert json.loads(path.read_text(encoding="utf-8"))["records"] == before


def test_live_parser_retains_only_the_provider_matching_exchange_symbol(monkeypatch):
    accuracy = load_accuracy()
    fields = [""] * 33
    fields[2], fields[30], fields[32] = "QQQ.OQ", "2026-11-04 16:00:01", "0.97"
    raw = f'v_usQQQ="{"~".join(fields)}";'.encode("gb18030")
    monkeypatch.setattr(accuracy, "request_bytes", lambda url: raw)
    assert accuracy.fetch_quotes({"usQQQ"})["usQQQ"]["source_symbol"] == "QQQ.OQ"
    fields[2] = "SPY.OQ"
    raw = f'v_usQQQ="{"~".join(fields)}";'.encode("gb18030")
    assert "source_symbol" not in accuracy.fetch_quotes({"usQQQ"})["usQQQ"]
