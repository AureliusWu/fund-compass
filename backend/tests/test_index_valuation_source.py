"""Synthetic transport-only fixtures; never request the real public source."""
import datetime
import json
from pathlib import Path
import sys

import pytest
import requests

TOOLS = Path(__file__).resolve().parents[2] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import enrich_index_valuation as producer
import index_valuation_source as source_module
from index_valuation_source import (
    LeguIndexSource, MAX_RESPONSE_BYTES, MIN_INTERVAL_SECONDS, SourceMetricError,
    SourceStopped, TOTAL_BUDGET_SECONDS, retry_after_seconds, source_day,
)

CST = datetime.timezone(datetime.timedelta(hours=8))
TODAY = datetime.datetime.now(CST).date()
FIXED_UTC = datetime.datetime(2026, 10, 18, 5, 0, tzinfo=datetime.timezone.utc)
CSRF_FIXTURE = "synthetic-anonymous-csrf-not-for-logs"


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class Response:
    def __init__(self, body=b"", status=200, headers=None):
        self.body = body
        self.status_code = status
        self.headers = headers or {}
        self.closed = False
        self.reads = 0

    def iter_content(self, chunk_size):
        for offset in range(0, len(self.body), chunk_size):
            self.reads += 1
            yield self.body[offset:offset + chunk_size]

    def close(self):
        self.closed = True


class Session:
    def __init__(self, responses, clock):
        self.responses = list(responses)
        self.clock = clock
        self.calls = []
        self.headers = {"Authorization": "synthetic-preexisting-header"}
        self.cookies = {"synthetic-old-cookie": "must-be-cleared"}
        self.auth = ("synthetic-user", "synthetic-password")
        self.verify = False
        self.closed = 0

    def get(self, url, **kwargs):
        self.calls.append((self.clock(), url, kwargs))
        assert self.responses, "unexpected extra request"
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def close(self):
        self.closed += 1


def bootstrap(body=None):
    return Response(body if body is not None else f'<meta name="_csrf" content="{CSRF_FIXTURE}">'.encode())


def metric(kind, value=None, *, day=TODAY, field=None, date_value=None):
    weighted = field or ("addTtmPe" if kind == "pe" else "addPb")
    rows = [{"date": date_value if date_value is not None else (day - datetime.timedelta(days=29 - i)).isoformat(),
             weighted: (12.0 if kind == "pe" else 1.2) if value is None else value} for i in range(30)]
    return Response(json.dumps({"data": rows}, allow_nan=False).encode())


def source(responses):
    clock = Clock()
    session = Session(responses, clock)
    client = LeguIndexSource(session=session, clock=clock, sleeper=clock.sleep, utcnow=lambda: FIXED_UTC)
    return client, session, clock


def full_responses(*, day=TODAY):
    return [bootstrap()] + [metric(kind, day=day) for _ in producer.CORE_INDICES for kind in ("pe", "pb")]


def test_429_at_seventh_metric_stops_every_later_fetch_and_preserves_old_artifact(tmp_path, monkeypatch):
    limited = Response(b"never-log-or-read-this-body", 429, {"Retry-After": "120"})
    client, session, _ = source([bootstrap()] + [metric(kind) for _ in range(3) for kind in ("pe", "pb")] + [limited])
    target = tmp_path / "index-valuation.json"
    target.write_bytes(b"old-good-artifact")
    monkeypatch.setattr(producer, "OUT", str(target))
    assert producer.main(source=client) == 1
    assert target.read_bytes() == b"old-good-artifact"
    assert not target.with_suffix(".json.tmp").exists()
    assert len(session.calls) == 8  # One bootstrap + exactly seven metric GETs.
    assert limited.reads == 0 and limited.closed and session.closed >= 1
    assert client.public_events()[-1]["http_status"] == 429
    assert client.public_events()[-1]["retry_after_seconds"] == 120
    with pytest.raises(SourceStopped):
        client.stock_index_pb_lg("中证100")
    assert len(session.calls) == 8
    assert len(producer.CORE_INDICES) == 6


@pytest.mark.parametrize("status", [401, 403, 429, 500, 302])
def test_bootstrap_failure_stops_without_any_metric_or_retry(status):
    rejected = Response(b"not-a-data-body", status)
    client, session, _ = source([rejected])
    with pytest.raises(SourceStopped):
        client.stock_index_pe_lg("沪深300")
    with pytest.raises(SourceStopped):
        client.stock_index_pe_lg("上证50")
    assert len(session.calls) == 1 and rejected.closed and session.closed >= 1


def test_bootstrap_missing_or_ambiguous_csrf_is_fixed_safe_error():
    for body in (b"<html>upstream refused</html>", b'<meta name="_csrf" content="a"><meta name="_csrf" content="b">'):
        client, session, _ = source([bootstrap(body)])
        with pytest.raises(SourceStopped, match="csrf_meta_missing_or_ambiguous"):
            client.stock_index_pe_lg("沪深300")
        assert len(session.calls) == 1 and session.closed >= 1


def test_bootstrap_response_close_failure_stops_without_a_second_bootstrap():
    response = bootstrap()
    client, session, _ = source([response])

    def failed_close():
        response.closed = True
        raise RuntimeError("synthetic-close-details-must-not-be-exposed")

    response.close = failed_close
    with pytest.raises(SourceStopped, match="bootstrap_response_close_error") as caught:
        client.stock_index_pe_lg("沪深300")
    with pytest.raises(SourceStopped):
        client.stock_index_pb_lg("沪深300")
    assert len(session.calls) == 1 and response.closed and session.closed >= 1
    assert caught.value.__suppress_context__ is True
    assert "synthetic-close-details" not in str(caught.value) + json.dumps(client.public_events())


def test_oversize_response_stops_all_source_without_reading_future_responses():
    big = Response(b"x" * (MAX_RESPONSE_BYTES + 1))
    client, session, _ = source([bootstrap(), big])
    with pytest.raises(SourceStopped, match="body_limit_exceeded"):
        client.stock_index_pe_lg("沪深300")
    with pytest.raises(SourceStopped):
        client.stock_index_pb_lg("沪深300")
    assert len(session.calls) == 2 and big.closed and session.closed >= 1


def test_full_core_keeps_requested14_and_exact_optional_missing_without_keyerror_retries(tmp_path, monkeypatch):
    client, session, _ = source(full_responses())
    target = tmp_path / "index-valuation.json"
    monkeypatch.setattr(producer, "OUT", str(target))
    assert producer.main(source=client) == 0
    payload = json.loads(target.read_text(encoding="utf-8"))
    optional = set(producer.LG_SYMBOLS) - producer.CORE_INDICES
    assert len(optional) == 8
    assert payload["coverage"]["requested"] == 14
    assert payload["coverage"]["core_requested"] == payload["coverage"]["core_returned"] == 6
    assert payload["coverage"]["returned"] == 6 and set(payload["coverage"]["missing"]) == optional
    assert optional <= {row["name"] for row in payload["unsupported"]}
    assert len(session.calls) == 13
    assert session.calls[0][2]["params"] is None  # The bootstrap has no API query.
    assert len({((call[2].get("params") or {}).get("indexCode"), call[1]) for call in session.calls}) == 13
    for earlier, later in zip(session.calls, session.calls[1:]):
        assert later[0] - earlier[0] >= MIN_INTERVAL_SECONDS
    for _, _, kwargs in session.calls:
        assert kwargs["timeout"] == (3, 8) and kwargs["allow_redirects"] is False and kwargs["stream"] is True
    assert session.headers == {} and session.cookies == {} and session.auth is None and session.verify is True


def test_duplicate_metric_never_performs_second_get():
    client, session, _ = source([bootstrap(), metric("pe")])
    client.stock_index_pe_lg("沪深300")
    with pytest.raises(SourceMetricError, match="duplicate_metric_not_retried"):
        client.stock_index_pe_lg("沪深300")
    assert len(session.calls) == 2


def test_expired_total_budget_prevents_request_and_closes_session():
    client, session, clock = source([])
    clock.value = TOTAL_BUDGET_SECONDS
    with pytest.raises(SourceStopped, match="total_budget_exhausted"):
        client.stock_index_pe_lg("沪深300")
    assert session.calls == [] and session.closed >= 1


@pytest.mark.parametrize("stage", ["stream_end", "close", "parse"])
def test_last_metric_deadline_includes_stream_end_cleanup_and_parse_and_preserves_artifact(stage, tmp_path, monkeypatch):
    responses = full_responses()
    client, session, clock = source(responses)
    last = responses[-1]
    original_iter, original_close = last.iter_content, last.close

    def late_iter(chunk_size):
        yield from original_iter(chunk_size)
        if stage == "stream_end":
            clock.value = TOTAL_BUDGET_SECONDS

    def late_close():
        original_close()
        if stage == "close":
            clock.value = TOTAL_BUDGET_SECONDS

    last.iter_content, last.close = late_iter, late_close
    if stage == "parse":
        original_frame = source_module._Frame

        def late_frame(rows, kind):
            result = original_frame(rows, kind)
            if len(session.calls) == 13:
                clock.value = TOTAL_BUDGET_SECONDS
            return result

        monkeypatch.setattr(source_module, "_Frame", late_frame)
    target = tmp_path / "index-valuation.json"
    target.write_bytes(b"old-good-artifact")
    monkeypatch.setattr(producer, "OUT", str(target))
    assert producer.main(source=client) == 1
    assert target.read_bytes() == b"old-good-artifact"
    assert not target.with_suffix(".json.tmp").exists()
    assert len(session.calls) == 13 and last.closed and session.closed >= 1
    with pytest.raises(SourceStopped):
        client.stock_index_pe_lg("沪深300")
    assert len(session.calls) == 13


def test_duplicate_valid_source_dates_cannot_count_as_thirty_samples_or_overwrite_artifact(tmp_path, monkeypatch):
    responses = full_responses()
    responses[1] = metric("pe", date_value=TODAY.isoformat())
    client, session, _ = source(responses)
    target = tmp_path / "index-valuation.json"
    target.write_bytes(b"old-good-artifact")
    monkeypatch.setattr(producer, "OUT", str(target))
    assert producer.main(source=client) == 1
    assert target.read_bytes() == b"old-good-artifact"
    assert not target.with_suffix(".json.tmp").exists()
    assert len(session.calls) == 13
    assert client.public_events()[1]["reason"] == "data_contract_error"


@pytest.mark.parametrize("body", [b'{"data": "\xff"}', b"[" * 2000 + b"]" * 2000])
def test_invalid_utf8_or_recursive_json_is_fixed_data_contract_error(body):
    client, session, _ = source([bootstrap(), Response(body)])
    with pytest.raises(SourceMetricError, match="data_contract_error"):
        client.stock_index_pe_lg("沪深300")
    assert len(session.calls) == 2


def test_cleanup_failure_does_not_replace_original_access_refusal():
    rejected = Response(b"not-read", 429)
    client, session, _ = source([rejected])

    def failed_close():
        raise RuntimeError("cleanup-must-not-replace-rate-limit")

    rejected.close = failed_close
    session.close = failed_close
    with pytest.raises(SourceStopped, match="rate_limited"):
        client.stock_index_pe_lg("沪深300")
    assert len(session.calls) == 1 and rejected.reads == 0


def test_standard_requests_proxy_resolution_retains_lowercase_and_no_proxy_without_netrc(monkeypatch):
    for name in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://upper-proxy.invalid:8080")
    monkeypatch.setenv("https_proxy", "http://lower-proxy.invalid:8081")
    client, session, _ = source([])
    assert session.proxies["https"] == "http://lower-proxy.invalid:8081"
    assert session.trust_env is False and session.auth is None and session.verify is True
    client.close()
    monkeypatch.setenv("NO_PROXY", "legulegu.com")
    client, session, _ = source([])
    assert session.proxies == {} and session.calls == []
    client.close()


def test_source_days_use_real_iso_or_explicit_integer_milliseconds_and_cst_rollover():
    instant = datetime.datetime(2026, 10, 17, 16, 0, tzinfo=datetime.timezone.utc)
    assert source_day(int(instant.timestamp() * 1000)) == "2026-10-18"
    assert source_day(int(instant.timestamp() * 1000) - 1) == "2026-10-17"
    assert source_day("2026-10-16") == "2026-10-16"
    assert source_day("2026-02-31") is None
    assert source_day(True) is None and source_day(None) is None
    assert source_day(1792252800000.0) is None
    assert source_day(10 ** 500) is None


def test_wrong_weighted_column_does_not_fall_back_to_equal_weight_or_new_name():
    client, session, _ = source([bootstrap(), metric("pe", field="ttmPe")])
    assert producer._series_from(client, "stock_index_pe_lg", "沪深300", ("滚动市盈率",), False) == (None, None, None, None)
    assert len(session.calls) == 2
    assert client.public_events()[-1]["reason"] == "data_contract_error"


def test_real_zero_and_null_remain_distinct_and_zero_does_not_pass_core_gate():
    zero = metric("pe", value=0)
    null_rows = [{"date": (TODAY - datetime.timedelta(days=29 - i)).isoformat(), "addTtmPe": None} for i in range(30)]
    client, _, _ = source([bootstrap(), zero, Response(json.dumps({"data": null_rows}).encode())])
    zero_result = producer._series_from(client, "stock_index_pe_lg", "沪深300", ("滚动市盈率",), False)
    null_result = producer._series_from(client, "stock_index_pe_lg", "上证50", ("滚动市盈率",), False)
    assert zero_result[0] == 0 and zero_result[0] is not None
    assert null_result[:3] == (None, None, None)
    assert producer._valid_core_item({"name": "沪深300", "date": TODAY.isoformat(), "pe_date": TODAY.isoformat(),
                                     "pb_date": TODAY.isoformat(), "pe": zero_result[0], "pe_pct": zero_result[1],
                                     "pb": 1.2, "pb_pct": 50}) is False


def test_mismatched_pe_pb_dates_fail_closed_without_extra_attempt():
    client, session, _ = source([bootstrap(), metric("pe"), metric("pb", day=TODAY - datetime.timedelta(days=1))])
    assert producer._fetch_one_index(client, "沪深300", ["沪深300"], False) is None
    assert len(session.calls) == 3


def test_future_source_dates_preserve_old_artifact(tmp_path, monkeypatch):
    client, _, _ = source(full_responses(day=TODAY + datetime.timedelta(days=1)))
    target = tmp_path / "index-valuation.json"
    target.write_bytes(b"old-good-artifact")
    monkeypatch.setattr(producer, "OUT", str(target))
    assert producer.main(source=client) == 1
    assert target.read_bytes() == b"old-good-artifact"


@pytest.mark.parametrize("raw,expected", [("0", 0), ("120", 120), ("86400", 86400), ("86401", None),
                                           ("-1", None), ("1\r\nInjected: value", None), ("x" * 129, None),
                                           (None, None), ("invalid-date", None)])
def test_retry_after_is_validated_and_zero_is_not_lost(raw, expected):
    assert retry_after_seconds(raw, FIXED_UTC) == expected


def test_retry_after_http_date_is_bounded_without_automatic_retry():
    assert retry_after_seconds("Sun, 18 Oct 2026 05:01:00 GMT", FIXED_UTC) == 60
    assert retry_after_seconds("Sun, 18 Oct 2026 04:59:59 GMT", FIXED_UTC) is None


def test_public_diagnostics_exclude_cookie_csrf_token_body_and_query_credentials():
    denied = Response(b"sensitive-looking-upstream-body", 403, {"Retry-After": "60"})
    client, _, _ = source([bootstrap(), denied])
    with pytest.raises(SourceStopped) as caught:
        client.stock_index_pe_lg("沪深300")
    text = json.dumps(client.public_events()) + str(caught.value)
    assert CSRF_FIXTURE not in text and "sensitive-looking-upstream-body" not in text
    assert "token=" not in text and "headers" not in text and "cookies" not in text
    assert denied.reads == 0


def test_transport_exception_is_safe_and_never_retried():
    client, session, _ = source([requests.ConnectionError("private-looking-url-or-token-must-not-be-logged")])
    with pytest.raises(SourceStopped) as caught:
        client.stock_index_pe_lg("沪深300")
    assert "private-looking" not in str(caught.value)
    assert len(session.calls) == 1 and session.closed >= 1
