"""Pure, bounded nonfinancial overseas run journal candidate (not cloud proof).

All input is supplied metadata. No files, environment, DB, socket or financial
rows are read. The external workflow must independently establish each binding
and financial qualification before calling this module. Never import this
module as an authorization or successful-publication decision.
"""
import datetime as dt
import json
import re

PROFILE = "overseas-public-ops-v1"
MAX_BYTES = 524288
MAX_EVENTS = 366
MAX_DURATION_SECONDS = 21600
CST = dt.timezone(dt.timedelta(hours=8))
UTC = dt.timezone.utc
_BINDING_KEYS = frozenset(("date", "run_id", "attempt", "source_sha", "mode", "expectation"))
_EVENT_KEYS = _BINDING_KEYS | frozenset((
    "expected_window", "window_status", "outcome", "reason", "started_at",
    "finished_at", "qualified_data", "workflow_status", "workflow_reason",
))
_DATA_KEYS = frozenset(("commit_sha", "ledger_sha256", "audit_sha256", "models_sha256", "evidence_sha256"))
_OUTCOMES = {
    "qualified": frozenset(("financial_qualified",)),
    "zero_effective": frozenset(("zero_effective_prediction",)),
    "failed": frozenset(("producer_failed", "audit_rejected", "calibration_failed", "evidence_failed", "publication_failed", "missing_receipt")),
    "skipped": frozenset(("non_trading_day", "manual_observation_only", "scheduled_window_missed")),
    "blocked": frozenset(("calendar_unsupported",)),
}
_ERRORS = frozenset(("schema_invalid", "identity_invalid", "clock_invalid", "window_invalid", "qualification_invalid", "bounds_exceeded", "duplicate_key", "conflicting_replay", "order_invalid"))
_WORKFLOW_FAILURES = frozenset(("producer_failed", "audit_rejected", "calibration_failed", "evidence_failed", "publication_failed", "missing_receipt", "ci_dispatch_failed", "calendar_unsupported"))


class JournalError(ValueError):
    def __init__(self, code):
        if type(code) is not str or code not in _ERRORS:
            code = "schema_invalid"
        self.code = code
        super().__init__(code)


def _reject(code="schema_invalid"):
    raise JournalError(code)


def _closed(value, keys):
    if type(value) is not dict or len(value) != len(keys) or any(type(key) is not str for key in value) or set(value) != keys:
        _reject()


def _literal(value, choices):
    if type(value) is not str or value not in choices:
        _reject()


def _integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        _reject()


def _sha(value, digits):
    if type(value) is not str or len(value) != digits or re.fullmatch(r"[0-9a-f]{" + str(digits) + "}", value) is None:
        _reject()


def _date(value):
    if type(value) is not str or len(value) != 10 or re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}", value) is None:
        _reject()
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError:
        _reject()
    if parsed.isoformat() != value:
        _reject()
    return parsed


def _clock(value):
    if type(value) is not str or len(value) != 20 or re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value) is None:
        _reject("clock_invalid")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        _reject("clock_invalid")
    return parsed


def _binding(value):
    _closed(value, _BINDING_KEYS)
    _date(value["date"])
    _integer(value["run_id"], 1, 2**53 - 1)
    _integer(value["attempt"], 1, 100)
    _sha(value["source_sha"], 40)
    _literal(value["mode"], ("scheduled", "manual"))
    _literal(value["expectation"], ("trading", "non_trading", "unsupported"))
    return value


def _order(event):
    return event["finished_at"], event["run_id"], event["attempt"]


def _event(value, observed_at):
    _closed(value, _EVENT_KEYS)
    _binding({key: value[key] for key in _BINDING_KEYS})
    date = _date(value["date"])
    start, end = _clock(value["started_at"]), _clock(value["finished_at"])
    if not start <= end <= observed_at or (end - start).total_seconds() > MAX_DURATION_SECONDS:
        _reject("clock_invalid")
    local_date = start.astimezone(CST).date()
    if local_date < date or (value["mode"] == "manual" and local_date != date):
        _reject("clock_invalid")
    expected = date.isoformat() + "T06:35:00Z"
    if type(value["expected_window"]) is not str or value["expected_window"] != expected:
        _reject("window_invalid")
    _literal(value["outcome"], _OUTCOMES)
    _literal(value["reason"], _OUTCOMES[value["outcome"]])
    _literal(value["workflow_status"], ("succeeded", "failed"))
    if value["workflow_status"] == "succeeded":
        _literal(value["workflow_reason"], ("workflow_completed",))
    else:
        _literal(value["workflow_reason"], _WORKFLOW_FAILURES)
    if value["outcome"] == "failed" and (
        value["workflow_status"] != "failed" or value["workflow_reason"] != value["reason"]
    ):
        _reject("qualification_invalid")
    if value["outcome"] == "qualified" and value["workflow_status"] == "failed" and value["workflow_reason"] != "ci_dispatch_failed":
        _reject("qualification_invalid")
    if value["expectation"] == "unsupported":
        window = "calendar_unsupported"
    elif value["expectation"] == "non_trading":
        window = "non_trading_day"
    elif local_date > date:
        window = "delayed_cross_day"
    elif start < _clock(expected) - dt.timedelta(minutes=5):
        window = "too_early"
    elif start > _clock(expected) + dt.timedelta(minutes=45):
        window = "delayed_same_day"
    else:
        window = "open"
    if type(value["window_status"]) is not str or value["window_status"] != window:
        _reject("window_invalid")
    if value["expectation"] == "unsupported":
        if value["outcome"] != "blocked" or value["reason"] != "calendar_unsupported":
            _reject("qualification_invalid")
    elif value["outcome"] == "blocked":
        _reject("qualification_invalid")
    if value["outcome"] in ("qualified", "zero_effective"):
        if value["mode"] != "scheduled" or value["expectation"] != "trading" or window not in ("open", "delayed_same_day"):
            _reject("qualification_invalid")
    if value["outcome"] == "skipped":
        expected_reason = (
            "manual_observation_only" if value["mode"] == "manual"
            else "non_trading_day" if value["expectation"] == "non_trading"
            else "scheduled_window_missed" if window in ("too_early", "delayed_cross_day")
            else None
        )
        if value["reason"] != expected_reason:
            _reject("qualification_invalid")
    data = value["qualified_data"]
    if value["outcome"] == "qualified":
        _closed(data, _DATA_KEYS)
        _sha(data["commit_sha"], 40)
        for key in _DATA_KEYS - {"commit_sha"}:
            _sha(data[key], 64)
    elif data is not None:
        _reject("qualification_invalid")
    return value


def _pairs(items):
    if len(items) > len(_EVENT_KEYS):
        _reject("bounds_exceeded")
    result = {}
    for key, value in items:
        if key in result:
            _reject("duplicate_key")
        result[key] = value
    return result


def _constant(value):
    _reject()


def _preflight(raw):
    if type(raw) is not bytes:
        _reject()
    if not raw or len(raw) > MAX_BYTES:
        _reject("bounds_exceeded")
    depth = nodes = 0
    quoted = escaped = False
    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
            continue
        if byte == 34:
            quoted = True
        elif byte in (123, 91):
            depth += 1
            nodes += 1
            if depth > 6 or nodes > 10000:
                _reject("bounds_exceeded")
        elif byte in (125, 93):
            depth -= 1
            if depth < 0:
                _reject()
    if quoted or depth:
        _reject()


def decode(raw, *, observed_at):
    """Validate closed metadata; syntactic acceptance never proves its authority."""
    observed = _clock(observed_at)
    _preflight(raw)
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_constant)
    except JournalError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise JournalError("schema_invalid") from None
    return _state(value, observed)


def _state(value, observed):
    _closed(value, frozenset(("profile", "events")))
    if type(value["profile"]) is not str or value["profile"] != PROFILE:
        _reject()
    events = value["events"]
    if type(events) is not list or len(events) > MAX_EVENTS:
        _reject("bounds_exceeded")
    identities = set()
    previous = None
    for event in events:
        _event(event, observed)
        identity = event["run_id"], event["attempt"]
        if identity in identities:
            _reject("conflicting_replay")
        identities.add(identity)
        order = _order(event)
        if previous is not None and order <= previous:
            _reject("order_invalid")
        previous = order
    return value


def encode(value, *, observed_at):
    _state(value, _clock(observed_at))
    try:
        raw = json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n"
    except (ValueError, TypeError, RecursionError):
        raise JournalError("schema_invalid") from None
    decode(raw, observed_at=observed_at)
    return raw


def new_journal():
    """Explicit empty history, not a recovered zero counter or last-good data."""
    return {"profile": PROFILE, "events": []}


def append(raw, event, *, binding, observed_at):
    """Exact same identity/canonical content is idempotent; conflicts stop."""
    state = decode(raw, observed_at=observed_at)
    external = _binding(binding)
    admitted = _event(event, _clock(observed_at))
    if any(admitted[key] != external[key] for key in _BINDING_KEYS):
        _reject("identity_invalid")
    for existing in state["events"]:
        if (existing["run_id"], existing["attempt"]) == (admitted["run_id"], admitted["attempt"]):
            if existing != admitted:
                _reject("conflicting_replay")
            return encode(state, observed_at=observed_at)
    if len(state["events"]) == MAX_EVENTS:
        _reject("bounds_exceeded")
    if state["events"] and _order(admitted) <= _order(state["events"][-1]):
        _reject("order_invalid")
    state["events"].append(admitted)
    return encode(state, observed_at=observed_at)


def summarize(raw, *, observed_at, expected_dates, calendar_sha256):
    """Keep immutable failure history separate from the current daily state.

    The latest scheduled/trading terminal determines each expected date;
    a genuine qualified retry can recover it without deleting failed events.
    Manual/holiday attempts and missing history never manufacture recovery.
    """
    events = decode(raw, observed_at=observed_at)["events"]
    _sha(calendar_sha256, 64)
    if type(expected_dates) is not tuple or len(expected_dates) > MAX_EVENTS:
        _reject("bounds_exceeded")
    calendar_dates = []
    today = _clock(observed_at).astimezone(CST).date()
    for date in expected_dates:
        parsed = _date(date)
        if parsed > today or (calendar_dates and date <= calendar_dates[-1]):
            _reject("order_invalid")
        calendar_dates.append(date)
    calendar_set = set(calendar_dates)
    expected = {}
    latest_failure = last_qualified = None
    for index, event in enumerate(events):
        if event["mode"] == "scheduled" and (
            (event["expectation"] == "trading" and event["date"] not in calendar_set)
            or (event["expectation"] != "trading" and event["date"] in calendar_set)
        ):
            _reject("window_invalid")
        if event["mode"] == "scheduled" and (event["workflow_status"] == "failed" or event["outcome"] in ("zero_effective", "failed", "blocked")):
            latest_failure = index
        if event["outcome"] == "qualified":
            last_qualified = index
        if event["mode"] != "scheduled" or event["expectation"] != "trading":
            continue
        date = event["date"]
        expected[date] = index
    zero_streak = 0
    complete = False
    for date in reversed(calendar_dates):
        if date not in expected:
            break
        outcome = events[expected[date]]["outcome"]
        if outcome == "zero_effective":
            zero_streak += 1
        elif outcome == "qualified":
            complete = True
            break
        else:
            break
    return {
        "profile": PROFILE,
        "calendar_sha256": calendar_sha256,
        "event_count": len(events),
        "expected_observed_date_count": len(expected),
        "latest_attempt_index": len(events) - 1 if events else None,
        "latest_scheduled_failure_index": latest_failure,
        "last_qualified_financial_index": last_qualified,
        "zero_streak_lower_bound": zero_streak,
        "zero_streak_exact": zero_streak if complete else None,
        "history_complete_for_streak": complete,
        "alert_required": zero_streak >= 2 or (bool(calendar_dates) and (
            calendar_dates[-1] not in expected
            or events[expected[calendar_dates[-1]]]["outcome"] not in ("qualified", "zero_effective")
            or events[expected[calendar_dates[-1]]]["workflow_status"] == "failed"
        )),
        "remote_verified": False,
        "formal_release": False,
    }
