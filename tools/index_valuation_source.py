"""Bounded anonymous Legu index source. No login, retry, or anti-block fallback."""
from __future__ import annotations

import datetime
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import hashlib
import json
import math
import time

import requests

ORIGIN = "https://legulegu.com"
BOOTSTRAP = ORIGIN + "/stockdata/sz50-ttm-lyr"
MIN_INTERVAL_SECONDS = 15
TOTAL_BUDGET_SECONDS = 240
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ROWS = 10000
MAX_RETRY_AFTER_SECONDS = 86400
SYMBOL_CODES = {
    "上证50": "000016.SH", "沪深300": "000300.SH", "上证380": "000009.SH",
    "创业板50": "399673.SZ", "中证500": "000905.SH", "上证180": "000010.SH",
    "深证红利": "399324.SZ", "深证100": "399330.SZ", "中证1000": "000852.SH",
    "上证红利": "000015.SH", "中证100": "000903.SH", "中证800": "000906.SH",
}
CST = datetime.timezone(datetime.timedelta(hours=8))


def source_day(raw):
    """Keep native ISO days or convert integer epoch milliseconds UTC -> CST.

    No seconds/ms guessing and no replacement with the collection/run date.
    """
    if type(raw) is str:
        try:
            date = datetime.date.fromisoformat(raw)
            return raw if date.isoformat() == raw else None
        except ValueError:
            return None
    if type(raw) is int:
        try:
            seconds, milliseconds = divmod(raw, 1000)
            instant = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
            return (instant + datetime.timedelta(milliseconds=milliseconds)).astimezone(CST).date().isoformat()
        except (ValueError, OverflowError, OSError):
            return None
    return None


def retry_after_seconds(raw, now):
    """Return only a validated public delay; never log arbitrary header text."""
    if not isinstance(raw, str) or not raw or len(raw) > 128 or "\r" in raw or "\n" in raw:
        return None
    text = raw.strip()
    if text.isascii() and text.isdecimal():
        value = int(text)
    else:
        try:
            date = parsedate_to_datetime(text)
            if date.tzinfo is None or now.tzinfo is None:
                return None
            value = math.ceil((date - now).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None
    return value if 0 <= value <= MAX_RETRY_AFTER_SECONDS else None


class SourceMetricError(RuntimeError):
    """Fixed safe reason, never a raw exception/body/request URL."""


class SourceStopped(SourceMetricError):
    """Whole-source stop; no subsequent request or same-run retry is allowed."""


class _Csrf(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta" and values.get("name") == "_csrf":
            value = values.get("content")
            if isinstance(value, str) and 0 < len(value) <= 256 and "\r" not in value and "\n" not in value:
                self.values.append(value)


class _Series:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return list(self.values)


class _Frame:
    """Project actual public fields to the existing reviewed weighted-metric parser."""
    def __init__(self, rows, metric):
        field, column = ("addTtmPe", "滚动市盈率") if metric == "pe" else ("addPb", "市净率")
        if any(type(row) is not dict or "date" not in row or field not in row for row in rows):
            raise SourceMetricError("legulegu column_contract_mismatch")
        days = [source_day(row["date"]) for row in rows]
        valid_days = [day for day in days if day is not None]
        if len(valid_days) != len(set(valid_days)):
            raise SourceMetricError("legulegu duplicate_source_date")
        self.columns = ["日期", column]
        self.data = {"日期": days, column: [row[field] for row in rows]}
        self.size = len(rows)

    def __len__(self):
        return self.size

    def __getitem__(self, name):
        return _Series(self.data[name])


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


class LeguIndexSource:
    """One bootstrap and one GET per supported symbol/metric per instance.

    Conservative pacing is a client load budget, not proof of an upstream
    quota or permission. A rejection is terminal for this instance, including
    when a caller catches SourceStopped and asks for another metric.
    """
    fetch_attempts = 1
    supported_symbols = frozenset(SYMBOL_CODES)

    def __init__(self, *, session=None, clock=None, sleeper=None, utcnow=None):
        self._session = session if session is not None else requests.Session()
        self._session.headers.clear()
        self._session.cookies.clear()
        self._session.auth = None
        self._session.verify = True
        self._session.trust_env = False  # No .netrc/account credentials.
        # Standard Requests proxy/NO_PROXY/lowercase semantics, without netrc.
        # All requests use this fixed origin; do not reinterpret proxy variables.
        self._session.proxies = requests.utils.get_environ_proxies(ORIGIN)
        self._clock = clock if clock is not None else time.monotonic
        self._sleep = sleeper if sleeper is not None else time.sleep
        self._now = utcnow if utcnow is not None else lambda: datetime.datetime.now(datetime.timezone.utc)
        self._deadline = self._clock() + TOTAL_BUDGET_SECONDS
        self._last_started = None
        self._csrf = None
        self._seen = set()
        self._stopped = False
        self._events = []

    def close(self):
        self._stopped = True
        self._csrf = None
        try:
            self._session.close()
        except Exception:
            pass  # Cleanup must not replace the original refusal/failure.

    def public_events(self):
        return [dict(event) for event in self._events]

    def _stop(self, reason):
        self.close()
        raise SourceStopped("legulegu " + reason) from None

    def _remaining(self):
        remaining = self._deadline - self._clock()
        if self._stopped:
            raise SourceStopped("legulegu source_stopped")
        if remaining <= 0:
            self._stop("total_budget_exhausted")
        return remaining

    def _request(self, path, *, symbol=None, metric=None, params=None):
        remaining = self._remaining()
        wait = max(0, MIN_INTERVAL_SECONDS - (self._clock() - self._last_started)) if self._last_started is not None else 0
        if wait >= remaining:
            self._stop("total_budget_exhausted")
        if wait:
            self._sleep(wait)
        remaining = self._remaining()
        headers = {"User-Agent": "fund-compass-public-index-source/1.0", "Accept": "application/json" if metric else "text/html"}
        if self._csrf is not None:
            headers["X-CSRF-Token"] = self._csrf
        self._last_started = self._clock()
        event = {"stage": "metric" if metric else "bootstrap", "index": symbol, "metric": metric,
                 "fetched_at": self._now().isoformat(), "http_status": None, "retry_after_seconds": None}
        self._events.append(event)
        try:
            response = self._session.get(ORIGIN + path, params=params, headers=headers,
                                         timeout=(min(3, remaining), min(8, remaining)),
                                         allow_redirects=False, stream=True)
        except requests.RequestException:
            event["reason"] = "transport_error"
            if metric is None:
                self._stop("bootstrap_transport_error")
            raise SourceMetricError("legulegu transport_error") from None
        try:
            event["http_status"] = response.status_code
            event["retry_after_seconds"] = retry_after_seconds(response.headers.get("Retry-After"), self._now())
            if response.status_code in (401, 403, 429):
                event["reason"] = "access_rejected" if response.status_code != 429 else "rate_limited"
                self._stop(event["reason"])
            if response.status_code != 200:
                event["reason"] = "http_error"
                if metric is None:
                    self._stop("bootstrap_http_error")
                raise SourceMetricError("legulegu http_error")
            body = bytearray()
            try:
                for chunk in response.iter_content(chunk_size=65536):
                    self._remaining()
                    if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                        event["reason"] = "body_limit_exceeded"
                        self._stop("body_limit_exceeded")
                    body.extend(chunk)
            except requests.RequestException:
                event["reason"] = "stream_transport_error"
                if metric is None:
                    self._stop("bootstrap_stream_transport_error")
                raise SourceMetricError("legulegu stream_transport_error") from None
            self._remaining()  # Includes iterator exhaustion after the last chunk.
            event["bytes"] = len(body)
            result = bytes(body)
        except BaseException:
            try:
                response.close()
            except Exception:
                pass  # Preserve the actual refusal/parse/transport failure.
            event["elapsed_seconds"] = round(self._clock() - self._last_started, 3)
            raise
        try:
            response.close()
        except Exception:
            event["reason"] = "response_close_error"
            if metric is None:
                self._stop("bootstrap_response_close_error")
            raise SourceMetricError("legulegu response_close_error") from None
        self._remaining()  # Successful cleanup is part of the total budget.
        event["elapsed_seconds"] = round(self._clock() - self._last_started, 3)
        return result

    def _bootstrap(self):
        if self._csrf is not None:
            return
        raw = self._request("/stockdata/sz50-ttm-lyr")
        parser = _Csrf()
        parser.feed(raw.decode("utf-8", errors="replace"))
        if len(parser.values) != 1:
            self._events[-1]["reason"] = "csrf_meta_missing_or_ambiguous"
            self._stop("csrf_meta_missing_or_ambiguous")
        self._remaining()
        self._csrf = parser.values[0]

    def _metric(self, symbol, metric):
        self._remaining()
        if symbol not in self.supported_symbols:
            raise SourceMetricError("legulegu unsupported_symbol")
        if (symbol, metric) in self._seen:
            raise SourceMetricError("legulegu duplicate_metric_not_retried")
        self._seen.add((symbol, metric))
        self._bootstrap()
        day = self._now().astimezone(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()
        # Standard anonymous public protocol, not an account/API credential.
        raw = self._request("/api/stockdata/index-basic-" + metric, symbol=symbol, metric=metric,
                            params={"indexCode": SYMBOL_CODES[symbol], "token": hashlib.md5(day.encode()).hexdigest()})
        try:
            payload = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique_object,
                                 parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("nonfinite_json")))
            rows = payload.get("data") if type(payload) is dict else None
            if type(rows) is not list or not rows or len(rows) > MAX_ROWS:
                raise ValueError("empty_or_invalid_rows")
            result = _Frame(rows, metric)
        except (ValueError, TypeError, RecursionError, SourceMetricError):
            self._events[-1]["reason"] = "data_contract_error"
            raise SourceMetricError("legulegu data_contract_error") from None
        self._remaining()  # Includes JSON decoding and frame/date projection.
        self._events[-1]["rows"] = len(rows)
        return result

    def stock_index_pe_lg(self, symbol):
        return self._metric(symbol, "pe")

    def stock_index_pb_lg(self, symbol):
        return self._metric(symbol, "pb")
