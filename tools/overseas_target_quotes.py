"""Exact, independently corroborated daily quotes for a delayed observation.

This is a read-only source adapter, not a ledger replay/backfill path. Tencent's
adjusted daily closes are usable only when BOTH dates exactly match Nasdaq's
unadjusted closes. An adjustment, missing session or conflicting live return
therefore remains missing instead of changing the model's return definition.
"""
import datetime as dt
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


MAX_BODY = 512 * 1024
MAX_SYMBOLS = 20
TOTAL_SECONDS = 30
REQUEST_SECONDS = 8
ETF_SYMBOLS = frozenset({"QQQ", "SOXX", "SMH", "EWY", "EEM"})
CST = dt.timezone(dt.timedelta(hours=8))


class QuoteEvidenceError(ValueError):
    pass


def _reject(reason):
    raise QuoteEvidenceError(reason)


def _date(value):
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        _reject("date_invalid")
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        _reject("date_invalid")


def _price(value):
    if type(value) not in (str, int, float) or isinstance(value, bool):
        _reject("price_invalid")
    text = str(value)
    if len(text) > 32 or not re.fullmatch(r"\$?\d+(?:,\d{3})*(?:\.\d+)?", text):
        _reject("price_invalid")
    try:
        number = Decimal(text.replace("$", "").replace(",", ""))
    except InvalidOperation:
        _reject("price_invalid")
    if not number.is_finite() or number <= 0:
        _reject("price_invalid")
    return number


def _symbol(code, live):
    if type(code) is not str or not re.fullmatch(r"us[A-Z][A-Z0-9]{0,11}", code):
        _reject("unsupported_symbol")
    symbol = live.get("source_symbol") if type(live) is dict else None
    if type(symbol) is not str or not re.fullmatch(
        re.escape(code[2:]) + r"\.(?:OQ|N|P|A)", symbol
    ):
        _reject("symbol_identity_invalid")
    return "us" + symbol


def _axis(target_date, base_date, observed_at):
    target, base = _date(target_date), _date(base_date)
    if not isinstance(observed_at, dt.datetime) or observed_at.tzinfo is None:
        _reject("observation_invalid")
    observation_date = observed_at.astimezone(CST).date()
    if not base < target < observation_date or (target - base).days > 7:
        _reject("axis_invalid")
    return target, base, observation_date


def verify_daily_evidence(code, live, target_date, base_date, observed_at, tencent, nasdaq):
    """Validate both sources without inventing an intraday timestamp."""
    symbol = _symbol(code, live)
    target, base, observation_date = _axis(target_date, base_date, observed_at)
    live_date = _date(live.get("quote_date"))
    if live_date < target or live_date > observation_date:
        _reject("live_date_invalid")
    if type(tencent) is not dict or type(tencent.get("code")) is not int or tencent["code"] != 0:
        _reject("history_shape_invalid")
    data = tencent.get("data")
    if type(data) is not dict or set(data) != {symbol} or type(data[symbol]) is not dict:
        _reject("symbol_identity_invalid")
    rows = data[symbol].get("qfqday")
    if type(rows) is not list or not 2 <= len(rows) <= 8:
        _reject("history_shape_invalid")
    daily = {}
    previous = None
    for row in rows:
        if type(row) is not list or len(row) != 6:
            _reject("history_shape_invalid")
        date = _date(row[0])
        if date > target or (target - date).days > 21 or (previous is not None and date <= previous):
            _reject("history_date_invalid")
        open_, close, high, low = map(_price, row[1:5])
        if not low <= min(open_, close) <= max(open_, close) <= high:
            _reject("price_invalid")
        daily[date] = close
        previous = date
    if base not in daily or target not in daily:
        _reject("history_date_missing")
    if [date for date in daily if date >= base] != [base, target]:
        _reject("base_not_previous_session")

    if type(nasdaq) is not dict or type(nasdaq.get("status")) is not dict:
        _reject("verification_shape_invalid")
    status = nasdaq["status"].get("rCode")
    if type(status) is not int or status != 200:
        _reject("verification_shape_invalid")
    official = nasdaq.get("data")
    if type(official) is not dict or official.get("symbol") != code[2:]:
        _reject("symbol_identity_invalid")
    if type(official.get("totalRecords")) is not int or official["totalRecords"] != 2:
        _reject("verification_date_missing")
    table = official.get("tradesTable")
    official_rows = table.get("rows") if type(table) is dict else None
    if type(official_rows) is not list or len(official_rows) != 2:
        _reject("verification_date_missing")
    prices = {}
    for row in official_rows:
        if type(row) is not dict or type(row.get("date")) is not str:
            _reject("verification_shape_invalid")
        try:
            date = dt.datetime.strptime(row["date"], "%m/%d/%Y").date()
        except ValueError:
            _reject("date_invalid")
        if date not in (base, target) or date in prices:
            _reject("verification_date_missing")
        prices[date] = _price(row.get("close"))
    if set(prices) != {base, target}:
        _reject("verification_date_missing")
    if any(daily[date] != prices[date] for date in (base, target)):
        _reject("price_basis_mismatch")
    try:
        change = float(((prices[target] / prices[base] - 1) * 100).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        ))
    except (InvalidOperation, OverflowError):
        _reject("price_invalid")
    if not math.isfinite(change):
        _reject("price_invalid")
    if live_date == target:
        value = live.get("change")
        if type(value) not in (int, float) or not math.isfinite(value) or not math.isclose(
            value, change, rel_tol=0, abs_tol=1e-8
        ):
            _reject("live_conflict")
        return dict(live)
    return {
        "change": change, "quote_date": target_date, "quote_time": target_date,
        "source": "tencent_daily_nasdaq_verified", "time_precision": "date",
        "source_symbol": live["source_symbol"], "previous_close_date": base_date,
        "previous_close": float(prices[base]), "close": float(prices[target]),
        "verification_source": "nasdaq_historical_close",
        "price_basis": "qfq_closes_equal_unadjusted_closes",
    }


def request_json(url, timeout):
    request = urllib.request.Request(url, headers={
        "User-Agent": "sinan-overseas-audit", "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.geturl() != url:
            _reject("source_redirected")
        raw = response.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        _reject("body_limit_exceeded")

    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                _reject("json_invalid")
            result[key] = value
        return result

    def constant(_):
        _reject("json_invalid")

    def finite_float(text):
        value = float(text)
        if not math.isfinite(value):
            _reject("json_invalid")
        return value

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=object_pairs,
                          parse_constant=constant, parse_float=finite_float)
    except (UnicodeError, ValueError, RecursionError):
        _reject("json_invalid")


def supplement_target_quotes(live_quotes, codes, target_date, base_date, observed_at,
                             *, diagnostics=None, requester=None, monotonic=time.monotonic):
    """Fill only absent target-day US evidence, under one bounded read budget.

    The caller first establishes a still-legal prediction axis from current NAV
    details. A failed/empty live feed is not rescued by inventing symbol identity.
    """
    output = dict(live_quotes)
    diagnostics = diagnostics if diagnostics is not None else {}
    requester = requester or request_json
    started = monotonic()

    def count(reason):
        key = "history_" + reason
        diagnostics[key] = diagnostics.get(key, 0) + 1

    try:
        _axis(target_date, base_date, observed_at)
    except QuoteEvidenceError as error:
        count(str(error))
        return output
    if type(started) not in (int, float) or not math.isfinite(started):
        count("clock_invalid")
        return output
    deadline, previous_clock = started + TOTAL_SECONDS, started

    def remaining_budget():
        nonlocal previous_clock
        value = monotonic()
        if (type(value) not in (int, float) or not math.isfinite(value)
                or value < previous_clock):
            _reject("clock_invalid")
        previous_clock = value
        return deadline - value

    requested = 0
    for code in sorted(codes):
        live = live_quotes.get(code)
        if not isinstance(live, dict) or live.get("quote_date") == target_date:
            continue
        try:
            symbol = _symbol(code, live)
            target, _, observation_date = _axis(target_date, base_date, observed_at)
            live_date = _date(live.get("quote_date"))
            if live_date < target or live_date > observation_date:
                _reject("live_date_invalid")
            if requested >= MAX_SYMBOLS:
                count("symbol_limit_exceeded")
                break
            requested += 1
            remaining = remaining_budget()
            if remaining <= 0:
                count("budget_exceeded")
                break
            encoded = urllib.parse.quote(f"{symbol},day,,{target_date},8,qfq", safe=",.")
            tencent = requester(
                "https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=" + encoded,
                min(REQUEST_SECONDS, remaining),
            )
            remaining = remaining_budget()
            if remaining <= 0:
                count("budget_exceeded")
                break
            asset = "etf" if code[2:] in ETF_SYMBOLS else "stocks"
            query = urllib.parse.urlencode({
                "assetclass": asset, "fromdate": base_date, "todate": target_date, "limit": 8,
            })
            nasdaq = requester(f"https://api.nasdaq.com/api/quote/{code[2:]}/historical?{query}",
                               min(REQUEST_SECONDS, remaining))
            if remaining_budget() <= 0:
                count("budget_exceeded")
                break
            verified = verify_daily_evidence(
                code, live, target_date, base_date, observed_at, tencent, nasdaq,
            )
            if remaining_budget() <= 0:
                count("budget_exceeded")
                break
            output[code] = verified
            count("target_quote_accepted")
        except QuoteEvidenceError as error:
            count(str(error))
            if str(error) == "clock_invalid":
                break
        except urllib.error.HTTPError as error:
            count("http_" + str(error.code))
            if error.code in (401, 403, 429):
                break
        except (OSError, ValueError, TypeError, OverflowError):
            count("source_unavailable")
    return output
