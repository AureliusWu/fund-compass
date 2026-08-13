#!/usr/bin/env python3
"""司南基金 · 14:30 自选估值推送人工应急脚本（V3）。

读 Gist 自选 → 调用 Worker 估值代理（涨跌%）→ 仅当日有估值（=交易日，自动避开周末/节假日）
才推送微信。与 V2-6 的 notify.py 互不影响（独立脚本与工作流，复用同名 Secret）。

该脚本仅作为 GitHub Actions 人工应急入口；正式 14:30/14:40 调度由 Cloudflare Worker 承担。
脚本复用 Gist 状态文件 sinan-estimate-state.json，并只认 14:30 发送槽位，避免与 Worker 重复发送。

环境变量：GIST_ID、GIST_TOKEN、WECHAT_SENDKEY（兼容 SC_SENDKEY）、FUND_API_BASE、WORKER_TOKEN、
ESTIMATE_PROXY_URL、
SCHEDULE_CRON、PUSH_SLOT、FORCE。
纯 stdlib，无需 pip。
"""
import datetime
import json
import math
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

GIST_TOKEN = os.environ.get("GIST_TOKEN", "").strip()
GIST_ID = os.environ.get("GIST_ID", "").strip()
WECHAT_SENDKEY = (os.environ.get("WECHAT_SENDKEY") or os.environ.get("SC_SENDKEY") or "").strip()
PUSHPLUS_TOKEN = os.environ.get("PUSHPLUS_TOKEN", "").strip()
PUSHPLUS_TOPIC = os.environ.get("PUSHPLUS_TOPIC", "").strip()
PUSHPLUS_CHANNEL = os.environ.get("PUSHPLUS_CHANNEL", "wechat").strip()
NOTIFY_WEBHOOK_URL = os.environ.get("NOTIFY_WEBHOOK_URL", "").strip()
FORCE = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
PUSH_SLOT = os.environ.get("PUSH_SLOT", "").strip()
SCHEDULE_CRON = os.environ.get("SCHEDULE_CRON", "").strip()
FUND_API_BASE = os.environ.get("FUND_API_BASE", "").strip().rstrip("/")
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "").strip()
ESTIMATE_PROXY_URL = (
    os.environ.get("ESTIMATE_PROXY_URL")
    or os.environ.get("ESTIMATE_PROXY")
    or "https://sinan-estimate-push.ligugu69.workers.dev/estimates"
).strip().rstrip("/")
WATCH_FILE = "sinan-watchlist.json"
STATE_FILE = "sinan-estimate-state.json"
GH = "https://api.github.com"
CST = datetime.timezone(datetime.timedelta(hours=8))
VALID_SLOTS = ("14:30",)
MAX_SCHEDULE_DELAY_MINUTES = 25
REQUEST_TIMEOUT_SECONDS = 12
MAX_RESPONSE_BYTES = 2_000_000
MAX_WATCH_NAME_LENGTH = 120
MAX_WATCH_SHARES = 1_000_000_000_000
MAX_QUOTE_FUTURE_SKEW_SECONDS = 5 * 60
MAX_INTRADAY_AGE_SECONDS = 90 * 60
MAX_STATE_ATTEMPTS = 1000
MAX_STATE_TEXT = 240
VALID_CRON_RESULTS = {"sent", "sent_with_warning", "skipped", "failed"}
VALID_DECISION_STATUSES = {"ok", "disabled", "degraded"}


def _req(url, data=None, headers=None, method=None, timeout=REQUEST_TIMEOUT_SECONDS):
    h = {"User-Agent": "sinan-bot"}
    if headers:
        h.update(headers)
    request_method = (method or ("POST" if data is not None else "GET")).upper()
    attempts = 2 if request_method == "GET" and data is None else 1
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise ValueError("上游响应过大")
                return raw.decode("utf-8")
        except urllib.error.HTTPError as ex:
            retryable = ex.code == 429 or 500 <= ex.code < 600
            if attempt + 1 >= attempts or not retryable:
                raise
        except (urllib.error.URLError, TimeoutError, socket.timeout):
            if attempt + 1 >= attempts:
                raise
        time.sleep(0.2)
    raise RuntimeError("请求重试耗尽")


def _gh(url, data=None, method=None):
    return _req(url, data=data, method=method, headers={
        "Authorization": f"token {GIST_TOKEN}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    })


def find_gist_id():
    """Return the explicitly configured Gist; never guess during a migration."""
    return GIST_ID if re.fullmatch(r"[0-9a-fA-F]{20,64}", GIST_ID) else None


def gist_file(gid, name):
    """读 Gist 某文件内容（大文件被截断时走 raw_url）。"""
    data = json.loads(_gh(f"{GH}/gists/{gid}"))
    f = (data.get("files") or {}).get(name)
    if not f:
        return None
    if f.get("truncated") and f.get("raw_url"):
        return _req(f["raw_url"], headers={"User-Agent": "sinan-bot"})
    return f.get("content")


def write_state(gid, state):
    """把去重状态写回 Gist（PATCH 只更新该文件，不动自选）。"""
    body = json.dumps({"files": {STATE_FILE: {
        "content": json.dumps(state, ensure_ascii=False, indent=2)
    }}}).encode()
    _gh(f"{GH}/gists/{gid}", data=body, method="PATCH")


def _valid_state_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return value if datetime.date.fromisoformat(value).isoformat() == value else None
    except ValueError:
        return None


def _valid_state_timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})",
        value,
    ):
        return None
    try:
        datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
    except ValueError:
        return None


def _bounded_state_text(value, maximum=MAX_STATE_TEXT):
    return value if isinstance(value, str) and len(value) <= maximum else None


def sanitize_push_state(value):
    """Whitelist untrusted Gist state fields and fail closed for daily dedupe."""
    if not isinstance(value, dict):
        return {}
    state = {}
    date = _valid_state_date(value.get("date"))
    if date:
        state["date"] = date
        slots = value.get("sent_slots")
        if isinstance(slots, list):
            state["sent_slots"] = list(dict.fromkeys(
                slot for slot in slots if isinstance(slot, str) and slot in VALID_SLOTS
            ))
        attempts = value.get("attempt_count")
        if (isinstance(attempts, int) and not isinstance(attempts, bool)
                and 0 <= attempts <= MAX_STATE_ATTEMPTS):
            state["attempt_count"] = attempts
        if value.get("last_slot") in VALID_SLOTS:
            state["last_slot"] = value["last_slot"]
    for field in ("last_cron_at", "last_attempt_at", "last_pushed_at", "last_success_at"):
        timestamp = _valid_state_timestamp(value.get(field))
        if timestamp:
            state[field] = timestamp
    if value.get("last_cron_result") in VALID_CRON_RESULTS:
        state["last_cron_result"] = value["last_cron_result"]
    reason = _bounded_state_text(value.get("last_cron_reason"), 80)
    if reason is not None:
        state["last_cron_reason"] = reason
    for field in ("last_error", "last_warning"):
        text = _bounded_state_text(value.get(field))
        if text is not None:
            state[field] = text
    if value.get("decision_status") in VALID_DECISION_STATUSES:
        state["decision_status"] = value["decision_status"]
    http_status = value.get("last_http_status")
    if http_status is None and "last_http_status" in value:
        state["last_http_status"] = None
    elif (isinstance(http_status, int) and not isinstance(http_status, bool)
          and 100 <= http_status <= 599):
        state["last_http_status"] = http_status
    return state


def parse_push_state(raw, *, strict=False):
    if not raw:
        return {}
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError, json.JSONDecodeError):
        if strict:
            raise ValueError("push state is not valid JSON") from None
        return {}
    if strict:
        if not isinstance(value, dict):
            raise ValueError("push state must be an object")
        if "date" in value and _valid_state_date(value.get("date")) is None:
            raise ValueError("push state date is invalid")
        if "sent_slots" in value and (
            not isinstance(value.get("sent_slots"), list)
            or any(not isinstance(slot, str) or slot not in VALID_SLOTS for slot in value["sent_slots"])
        ):
            raise ValueError("push state sent_slots is invalid")
        attempts = value.get("attempt_count")
        if "attempt_count" in value and not (
            isinstance(attempts, int) and not isinstance(attempts, bool)
            and 0 <= attempts <= MAX_STATE_ATTEMPTS
        ):
            raise ValueError("push state attempt_count is invalid")
    return sanitize_push_state(value)


def rollover_daily_state(state, today):
    """Reset daily deduplication without erasing Worker-wide runtime history."""
    current = sanitize_push_state(state)
    if current.get("date") != today:
        current["date"] = today
        current["sent_slots"] = []
        current["attempt_count"] = 0
    else:
        current.setdefault("sent_slots", [])
        current.setdefault("attempt_count", 0)
    return current


def _increment_attempt_count(value):
    return min(MAX_STATE_ATTEMPTS, value + 1) if isinstance(value, int) else 1


def slot_from_schedule():
    m = re.match(r"^\s*30\s+6\s+", SCHEDULE_CRON)
    if m:
        return "14:30"
    return None


def schedule_delay_minutes(now, slot):
    hour, minute = map(int, slot.split(":"))
    planned = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return int((now - planned).total_seconds() // 60)


def push_slot(now):
    """Resolve the push slot from manual input, GitHub schedule, or Beijing time."""
    if PUSH_SLOT in VALID_SLOTS:
        return PUSH_SLOT

    scheduled_slot = slot_from_schedule()
    if scheduled_slot:
        return scheduled_slot

    return "14:30"

def _bounded_optional_number(value, minimum, maximum):
    number = _to_float(value)
    return number if number is not None and minimum <= number <= maximum else None


def normalize_watch_entries(value):
    """Validate the untrusted Gist boundary and isolate malformed rows."""
    if not isinstance(value, list):
        return []
    entries = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        code = raw.get("code")
        code = code.strip() if isinstance(code, str) else ""
        if not re.fullmatch(r"\d{6}", code):
            continue
        deleted = raw.get("deleted")
        if deleted is not None and not isinstance(deleted, bool):
            continue
        if deleted is True:
            continue
        entry = {"code": code}
        name = raw.get("name")
        if isinstance(name, str) and name.strip():
            entry["name"] = name.strip()[:MAX_WATCH_NAME_LENGTH]
        shares = _bounded_optional_number(raw.get("shares"), 0, MAX_WATCH_SHARES)
        if shares is not None:
            entry["shares"] = shares
        target = _bounded_optional_number(raw.get("target_weight"), 0, 100)
        if target is not None:
            entry["target_weight"] = target
        entries.append(entry)
    return entries


def watch_entries(gid):
    """从 Gist 读取有效自选/持仓条目。"""
    raw = gist_file(gid, WATCH_FILE) or "[]"
    return normalize_watch_entries(json.loads(raw))


def _to_float(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    text = str(value).strip()
    if not text or not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", text):
        return None
    number = float(text)
    return number if math.isfinite(number) else None


def _to_int(value):
    number = _to_float(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _decision_estimate_context(estimate_data):
    """Return only the typed evidence accepted by the protected API."""
    if not isinstance(estimate_data, dict):
        return None
    kind = str(estimate_data.get("kind") or "")
    source = str(estimate_data.get("source") or "")
    status = str(estimate_data.get("status") or "")
    if kind not in ("estimate", "holdings_model", "official_nav", "unavailable") or not source or not status:
        return None
    precision = estimate_data.get("source_time_precision") or None
    raw_diagnostics = estimate_data.get("diagnostics")
    raw_diagnostics = raw_diagnostics if isinstance(raw_diagnostics, dict) else {}
    raw_rejected = raw_diagnostics.get("rejected")
    raw_rejected = raw_rejected if isinstance(raw_rejected, dict) else {}
    diagnostics = {
        "primary_reason": str(raw_diagnostics.get("primary_reason") or "")[:80] or None,
        "model_reason": str(raw_diagnostics.get("model_reason") or "")[:80] or None,
        "official_reason": str(raw_diagnostics.get("official_reason") or "")[:80] or None,
        "source_time_precision": precision,
        "rejected": {
            str(key)[:80]: parsed
            for key, value in list(raw_rejected.items())[:20]
            if (parsed := _to_int(value)) is not None and 0 <= parsed <= 100
        },
    }
    if kind == "unavailable":
        reason = (
            estimate_data.get("fallback_reason")
            or diagnostics["primary_reason"]
            or "valuation_unavailable"
        )
        diagnostics["primary_reason"] = str(reason)[:80]
        diagnostics["source_time_precision"] = precision or "date"
        context = {
            "status": "unavailable", "source": source[:80], "kind": "unavailable",
            "source_time_precision": diagnostics["source_time_precision"],
            "is_fallback": True, "fallback_reason": str(reason)[:240],
            "market": estimate_data.get("market") or "unknown",
            "diagnostics": diagnostics,
        }
        return {key: value for key, value in context.items() if value is not None}
    context = {
        "status": "modeled" if kind == "holdings_model" and status == "fresh" else status,
        "source": source[:80],
        "kind": kind,
        "source_time": estimate_data.get("gztime") or None,
        "fetched_at": estimate_data.get("fetched_at") or None,
        "calculated_at": estimate_data.get("calculated_at") or None,
        "source_time_precision": precision,
        "is_fallback": bool(estimate_data.get("is_fallback")),
        "fallback_reason": estimate_data.get("fallback_reason") or None,
        "market": estimate_data.get("market") or "unknown",
        "estimate_change": _to_float(estimate_data.get("gszzl")),
        "estimate_nav": _to_float(estimate_data.get("est_nav")),
        "base_nav": _to_float(estimate_data.get("base_nav")),
        "base_nav_date": estimate_data.get("base_nav_date") or None,
        "value_nav": _to_float(estimate_data.get("value_nav")),
        "value_date": estimate_data.get("value_date") or None,
        "note": (estimate_data.get("note") or "")[:500] or None,
        "diagnostics": diagnostics,
    }
    if kind == "holdings_model":
        context.update({
            "model_coverage": _to_float(estimate_data.get("model_coverage")),
            "model_quote_count": _to_int(estimate_data.get("model_quote_count")),
            "model_report_date": estimate_data.get("model_report_date") or None,
            "model_oldest_quote_time": estimate_data.get("model_oldest_quote_time") or None,
            "model_newest_quote_time": estimate_data.get("model_newest_quote_time") or None,
            "model_rejected_count": _to_int(estimate_data.get("model_rejected_count")),
        })
    return {key: value for key, value in context.items() if value is not None}


def _normalize_proxy_estimate(d, code):
    """Map the public Worker estimate contract to the legacy push shape."""
    status = str(d.get("status") or "unavailable")
    kind = str(d.get("kind") or d.get("est_kind") or "estimate")
    if kind not in ("estimate", "holdings_model", "official_nav", "unavailable"):
        kind = "unavailable"
        status = "unavailable"
    if kind == "unavailable":
        status = "unavailable"
    if status not in ("fresh", "modeled", "delayed", "degraded", "stale", "latest_official", "unavailable"):
        status = "unavailable"
    default_label = "最近净值" if kind == "official_nav" else (
        "重仓模型估算" if kind == "holdings_model" else
        "数据不可用" if status == "unavailable" else "盘中估值"
    )
    last_nav = _to_float(d.get("base_nav"))
    if last_nav is None:
        last_nav = _to_float(d.get("last_nav"))
    est_nav = _to_float(d.get("value_nav"))
    if est_nav is None:
        est_nav = _to_float(d.get("est_nav"))
    change = _to_float(d.get("est_change"))
    invalid_values = status in ("fresh", "modeled", "latest_official") and (
        last_nav is None or est_nav is None or change is None
    )
    if invalid_values:
        kind = "unavailable"
        status = "unavailable"
        default_label = "数据不可用"
    if kind == "unavailable":
        last_nav = est_nav = change = None
    return {
        "name": d.get("name") or code,
        "last_nav": last_nav,
        "est_nav": est_nav,
        "gszzl": change,
        "gztime": str(d.get("model_newest_quote_time") or d.get("est_time") or d.get("value_date") or ""),
        "label": default_label if invalid_values else str(d.get("est_label") or default_label),
        "kind": kind,
        "status": status,
        "source": str(d.get("source") or "unavailable"),
        "note": str(d.get("est_note") or ""),
        "base_nav": None if kind == "unavailable" else (
            _to_float(d.get("base_nav")) if d.get("base_nav") is not None else last_nav
        ),
        "base_nav_date": str(d.get("base_nav_date") or d.get("nav_date") or ""),
        "value_nav": None if kind == "unavailable" else (
            _to_float(d.get("value_nav")) if d.get("value_nav") is not None else est_nav
        ),
        "value_date": str(d.get("value_date") or ""),
        "fetched_at": str(d.get("fetched_at") or ""),
        "calculated_at": str(d.get("calculated_at") or ""),
        "source_time_precision": str(d.get("source_time_precision") or "") or None,
        "is_fallback": bool(d.get("is_fallback") or kind != "estimate"),
        "fallback_reason": str(
            d.get("fallback_reason") or d.get("unavailable_reason")
            or ("valuation_unavailable" if kind == "unavailable" else "")
        ) or None,
        "market": str(d.get("market") or "unknown") if d.get("market") in ("cn", "hk", "overseas", "gold") else "unknown",
        "model_coverage": _to_float(d.get("model_coverage")),
        "model_quote_count": _to_int(d.get("model_quote_count")),
        "model_report_date": str(d.get("model_report_date") or ""),
        "model_oldest_quote_time": str(d.get("model_oldest_quote_time") or ""),
        "model_newest_quote_time": str(d.get("model_newest_quote_time") or ""),
        "model_rejected_count": _to_int(d.get("model_rejected_count")),
        "diagnostics": d.get("diagnostics") if isinstance(d.get("diagnostics"), dict) else {},
    }


def fetch_estimates(codes):
    """Fetch up to 50 codes per request from the configured Worker proxy."""
    output = {}
    normalized_codes = list(dict.fromkeys(str(code).strip() for code in codes if str(code).strip()))
    for index in range(0, len(normalized_codes), 50):
        batch = normalized_codes[index:index + 50]
        query = urllib.parse.urlencode({"codes": ",".join(batch)})
        raw = _req(
            f"{ESTIMATE_PROXY_URL}?{query}",
            headers={"Accept": "application/json"},
        )
        payload = json.loads(raw)
        items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise ValueError("估值代理响应无效")
        unavailable_items = payload.get("unavailable_items") or []
        if not isinstance(unavailable_items, list):
            raise ValueError("估值代理不可用明细无效")
        if len(items) + len(unavailable_items) > len(batch) * 2:
            raise ValueError("估值代理返回条目过多")
        for item in items:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or "").strip()
            if re.fullmatch(r"\d{6}", code) and code in batch and code not in output:
                output[code] = _normalize_proxy_estimate(item, code)
        for item in unavailable_items:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or "").strip()
            if re.fullmatch(r"\d{6}", code) and code in batch and code not in output:
                output[code] = _normalize_proxy_estimate(item, code)
    return output


def estimate(code):
    """Compatibility wrapper for callers that request one fund."""
    return fetch_estimates([code]).get(code)


def _portfolio_evidence(estimate_data, today=None, now=None):
    """Use intraday evidence only inside its publish window; otherwise use formal base NAV."""
    if not isinstance(estimate_data, dict):
        return estimate_data
    kind = estimate_data.get("kind")
    if kind in ("estimate", "holdings_model"):
        publishable = (
            _is_publishable_intraday(estimate_data, today, now)
            if today and now else estimate_data.get("status") in ("fresh", "modeled")
        )
        if publishable:
            return estimate_data
        base_nav = _to_float(estimate_data.get("base_nav"))
        if base_nav is None:
            base_nav = _to_float(estimate_data.get("last_nav"))
        base_date = str(estimate_data.get("base_nav_date") or "").strip()
        reason = str(
            estimate_data.get("fallback_reason")
            or (estimate_data.get("diagnostics") or {}).get("primary_reason")
            or "intraday_evidence_expired"
        )[:80]
        if base_nav is not None and base_nav > 0 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", base_date):
            row = dict(estimate_data)
            row.update({
                "kind": "official_nav", "status": "latest_official",
                "source": "eastmoney_official_nav", "source_time_precision": "date",
                "gztime": base_date, "last_nav": base_nav, "est_nav": base_nav,
                "base_nav": base_nav, "base_nav_date": base_date,
                "value_nav": base_nav, "value_date": base_date, "gszzl": 0.0,
                "is_fallback": True, "fallback_reason": reason,
                "diagnostics": {
                    "primary_reason": reason, "model_reason": None,
                    "official_reason": None, "source_time_precision": "date", "rejected": {},
                },
            })
            return row
        return {
            "kind": "unavailable", "status": "unavailable", "source": "unavailable",
            "source_time_precision": "date", "is_fallback": True,
            "fallback_reason": reason, "last_nav": None, "est_nav": None,
            "base_nav": None, "value_nav": None, "gszzl": None,
            "diagnostics": {
                "primary_reason": reason, "source_time_precision": "date", "rejected": {},
            },
        }
    return estimate_data


def build_portfolio_payload(entries, estimates, today=None, now=None):
    """聚合跨账户持仓，并按实时估值计算当前仓位。"""
    by_code = {}
    for entry in entries:
        code = str(entry.get("code", "")).strip()
        row = by_code.setdefault(code, {"code": code, "shares": 0.0, "target_weight": None})
        row["shares"] += _to_float(entry.get("shares")) or 0
        if entry.get("target_weight") is not None:
            row["target_weight"] = _to_float(entry.get("target_weight"))

    values = {}
    missing_nav_codes = []
    for code, row in by_code.items():
        est = _portfolio_evidence(estimates.get(code), today, now) or {}
        nav = _to_float(est.get("est_nav"))
        if nav is None:
            nav = _to_float(est.get("last_nav"))
        if row["shares"] > 0 and (nav is None or nav <= 0):
            missing_nav_codes.append(code)
        values[code] = row["shares"] * nav if nav is not None and nav > 0 and row["shares"] > 0 else 0
    if missing_nav_codes:
        return [{"code": code} for code in by_code], None, missing_nav_codes
    portfolio_value = sum(values.values())

    explicit_total = sum(
        row["target_weight"] or 0 for row in by_code.values()
        if row["shares"] > 0 and row["target_weight"] is not None
    )
    unset = [
        row for row in by_code.values()
        if row["shares"] > 0 and row["target_weight"] is None
    ]
    default_target = max(0, 100 - explicit_total) / len(unset) if unset else 0

    items = []
    for code, row in by_code.items():
        item = {"code": code}
        context = _decision_estimate_context(_portfolio_evidence(estimates.get(code), today, now))
        if context:
            item["estimate_context"] = context
        if row["shares"] > 0 and portfolio_value > 0:
            item["current_weight"] = round(values[code] / portfolio_value * 100, 2)
            item["target_weight"] = round(
                row["target_weight"] if row["target_weight"] is not None else default_target,
                2,
            )
        items.append(item)
    return items, round(portfolio_value, 2), missing_nav_codes


def _parse_beijing_intraday(value):
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    elif re.fullmatch(r"\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?", text):
        text = text.replace(" ", "T") + "+08:00"
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(CST)


def _recent_intraday_time(value, today, now):
    parsed = _parse_beijing_intraday(value)
    if parsed is None or parsed.strftime("%Y-%m-%d") != today:
        return False
    age = (now - parsed).total_seconds()
    return -MAX_QUOTE_FUTURE_SKEW_SECONDS <= age <= MAX_INTRADAY_AGE_SECONDS


def _is_publishable_intraday(estimate_data, today, now=None):
    if not isinstance(estimate_data, dict):
        return False
    kind = estimate_data.get("kind")
    if kind not in ("estimate", "holdings_model"):
        return False
    if estimate_data.get("status") not in ("fresh", "modeled"):
        return False
    if not all(_to_float(estimate_data.get(key)) is not None for key in ("last_nav", "est_nav", "gszzl")):
        return False
    now = now or datetime.datetime.now(CST)
    if now.tzinfo is None:
        now = now.replace(tzinfo=CST)
    else:
        now = now.astimezone(CST)
    if kind == "holdings_model":
        oldest = estimate_data.get("model_oldest_quote_time") or estimate_data.get("gztime")
        newest = estimate_data.get("model_newest_quote_time") or estimate_data.get("gztime")
        return _recent_intraday_time(oldest, today, now) and _recent_intraday_time(newest, today, now)
    precision = estimate_data.get("source_time_precision")
    source_time = estimate_data.get("gztime")
    if precision == "datetime":
        return _recent_intraday_time(source_time, today, now)
    return False


class DecisionAuthError(RuntimeError):
    """Protected decision endpoint is configured but cannot be authenticated."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def fetch_portfolio_decisions(items, portfolio_value, request_id=None):
    """返回 (决策结果, 降级警告)；鉴权错误必须中止推送。"""
    if not FUND_API_BASE:
        return None, None
    if not WORKER_TOKEN:
        raise DecisionAuthError("组合决策未执行：WORKER_TOKEN 未配置")
    try:
        payload = {
            "items": items,
            "portfolio_value": portfolio_value,
        }
        if request_id:
            payload["request_id"] = request_id
        body = json.dumps(payload).encode("utf-8")
        raw = _req(
            f"{FUND_API_BASE}/api/portfolio/decisions",
            data=body,
            headers={
                "User-Agent": "sinan-bot",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {WORKER_TOKEN}",
            },
        )
        data = json.loads(raw)
        if isinstance(data, dict) and isinstance(data.get("decisions"), list):
            return data, None
        return None, "组合决策响应无效，已降级为纯估值"
    except urllib.error.HTTPError as ex:
        if ex.code in (401, 403):
            raise DecisionAuthError(f"组合决策鉴权失败: HTTP {ex.code}", ex.code) from ex
        warning = f"组合决策暂不可用: HTTP {ex.code}"
        print("portfolio decision fail", warning)
        return None, warning
    except Exception as ex:
        warning = f"组合决策暂不可用: {ex}"[:240]
        print("portfolio decision fail", warning)
        return None, warning


def format_push_line(code, name, estimate_data, decision, today=None, now=None):
    """组合涨跌幅 + 决策动作为一行推送文案。"""
    nm = name or (estimate_data or {}).get("name") or code
    if (estimate_data or {}).get("kind") in ("estimate", "holdings_model"):
        participates = (
            _is_publishable_intraday(estimate_data, today, now)
            if today and now else (estimate_data or {}).get("status") in ("fresh", "modeled")
        )
        if not participates:
            return f"**{nm}**  --（行情过期/延迟数据不参与）"
    chg_txt = "—（数据不可用）" if (estimate_data or {}).get("status") == "unavailable" else "—"
    if estimate_data and estimate_data.get("gszzl") is not None:
        try:
            chg = float(estimate_data["gszzl"])
            label = estimate_data.get("label") or "估值"
            chg_txt = f"{'+' if chg >= 0 else ''}{chg:.2f}%（{label}）"
        except (TypeError, ValueError):
            chg_txt = "—"
    if decision and (estimate_data or {}).get("kind") in ("estimate", "holdings_model"):
        action = decision.get("action") or "观察"
        summary = (decision.get("summary") or "").strip()
        tail = f"，{summary}" if summary else ""
        return f"**{nm}** {chg_txt} → **{action}**{tail}"
    return f"**{nm}**  {chg_txt}"


def format_portfolio_summary(result):
    """格式化组合校准摘要，限制长度避免通知过载。"""
    if not result:
        return ""
    allocation = result.get("allocation") or {}
    parts = [
        "### 组合校准",
        (
            f"目标仓位 {float(allocation.get('target_total') or 0):.1f}%"
            f" · 目标现金 {float(allocation.get('target_cash') or 0):.1f}%"
        ),
    ]
    for warning in allocation.get("warnings") or []:
        parts.append(f"- 注意：{warning}")
    actionable = [
        row for row in (result.get("rebalance") or [])
        if row.get("suggestion") != "维持"
    ][:3]
    for row in actionable:
        gap = float(row.get("gap") or 0)
        amount = row.get("amount")
        amount_text = f"，约 {float(amount):,.0f} 元" if amount is not None else ""
        parts.append(
            f"- {row.get('suggestion')}：{row.get('name') or row.get('code')}"
            f"（{gap:+.1f}%{amount_text}）"
        )
    return "\n".join(parts)


class NotificationError(RuntimeError):
    """Stable notification failure that never embeds a credential-bearing URL."""


def _notification_request(provider, url, *, data, headers):
    """Send one notification request and erase urllib's URL-bearing errors."""
    try:
        return _req(url, data=data, headers=headers)
    except urllib.error.HTTPError as ex:
        raise NotificationError(f"{provider}_http_{ex.code}") from None
    except (urllib.error.URLError, TimeoutError, socket.timeout):
        raise NotificationError(f"{provider}_network_error") from None
    except (UnicodeError, ValueError, json.JSONDecodeError):
        raise NotificationError(f"{provider}_response_invalid") from None
    except Exception:
        raise NotificationError(f"{provider}_request_failed") from None


def _notification_json(provider, raw):
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        raise NotificationError(f"{provider}_response_invalid") from None
    if not isinstance(payload, dict):
        raise NotificationError(f"{provider}_response_invalid")
    return payload


def send_notification(title, content):
    """Send once; only a verified provider acknowledgement counts as success."""
    try:
        if PUSHPLUS_TOKEN:
            payload = {
                "token": PUSHPLUS_TOKEN,
                "title": title,
                "content": content,
                "template": "markdown",
                "channel": PUSHPLUS_CHANNEL or "wechat",
            }
            if PUSHPLUS_TOPIC:
                payload["topic"] = PUSHPLUS_TOPIC
            out = _notification_request(
                "pushplus",
                "https://www.pushplus.plus/send",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            result = _notification_json("pushplus", out)
            if isinstance(result.get("code"), bool) or result.get("code") != 200:
                raise NotificationError("pushplus_business_rejected")
            print("pushplus: accepted")
            return True

        if WECHAT_SENDKEY:
            body = urllib.parse.urlencode({"title": title, "desp": content}).encode()
            out = _notification_request(
                "serverchan",
                f"https://sctapi.ftqq.com/{WECHAT_SENDKEY}.send",
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            result = _notification_json("serverchan", out)
            business_codes = [result[key] for key in ("code", "errno") if key in result]
            if (
                not business_codes
                or any(isinstance(code, bool) or code != 0 for code in business_codes)
            ):
                raise NotificationError("serverchan_business_rejected")
            print("serverchan: accepted")
            return True

        if NOTIFY_WEBHOOK_URL:
            payload = json.dumps({"title": title, "content": content}, ensure_ascii=False).encode("utf-8")
            _notification_request(
                "webhook",
                NOTIFY_WEBHOOK_URL,
                data=payload,
                headers={"Content-Type": "application/json; charset=utf-8"},
            )
            print("webhook: accepted")
            return True
    except NotificationError as ex:
        print(f"notification failed: {ex}")
        return False

    print("no notification channel configured; set PUSHPLUS_TOKEN, WECHAT_SENDKEY/SC_SENDKEY, or NOTIFY_WEBHOOK_URL")
    return False

def main():
    now = datetime.datetime.now(CST)
    today = now.strftime("%Y-%m-%d")
    slot = push_slot(now)
    planned_slot = slot_from_schedule() or (PUSH_SLOT if PUSH_SLOT in VALID_SLOTS else None)
    if planned_slot and not FORCE:
        delay = schedule_delay_minutes(now, planned_slot)
        if delay > MAX_SCHEDULE_DELAY_MINUTES:
            print(
                f"planned slot {planned_slot} is {delay} minutes late "
                f"(now={now.isoformat()}); skip stale push"
            )
            return 0
        if delay < -5:
            print(
                f"planned slot {planned_slot} is {-delay} minutes early "
                f"(now={now.isoformat()}); skip unexpected early push"
            )
            return 0
    if now.weekday() >= 5 and not FORCE:
        print("周末，跳过"); return 0
    if not GIST_TOKEN:
        raise SystemExit("未配置 GIST_TOKEN，人工应急任务拒绝空跑")
    gid = find_gist_id()
    if not gid:
        raise SystemExit("未配置有效 GIST_ID，人工应急任务拒绝枚举或猜测目标")

    # 与正式 Worker 共用 14:30 槽位；人工应急成功后也阻止同日重复发送。
    state = {}
    try:
        sraw = gist_file(gid, STATE_FILE)
        state = parse_push_state(sraw, strict=not FORCE)
    except Exception:
        if not FORCE:
            print("读取或校验推送状态失败；为避免重复发送，本次终止")
            return 1
        print("FORCE 已启用：忽略不可用的推送状态")
    state = rollover_daily_state(state, today)
    sent_slots = state.setdefault("sent_slots", [])
    if slot in sent_slots and not FORCE:
        print(f"今日（{today}）{slot} 已推过，跳过"); return 0

    entries = watch_entries(gid)
    if not entries:
        print("自选为空"); return 0

    unique = {}
    for entry in entries:
        code = str(entry["code"]).strip()
        unique.setdefault(code, entry.get("name"))

    try:
        estimates = fetch_estimates(unique.keys())
    except Exception as ex:
        print("estimate proxy fail; retired fundgz fallback is disabled:", ex)
        return 1
    fresh = any(_is_publishable_intraday(row, today) for row in estimates.values())

    if not estimates:
        print("无估值数据"); return 1
    if not fresh and not FORCE:
        print("今日无盘中估值（非交易日/休市），跳过"); return 0

    decision_result = None
    decision_warning = None
    decision_status = "disabled"
    if FUND_API_BASE:
        items, portfolio_value, missing_nav_codes = build_portfolio_payload(
            entries, estimates, today, now,
        )
        if missing_nav_codes:
            decision_warning = f"组合决策未执行：持仓缺少可用净值（{','.join(missing_nav_codes)}）"
            decision_status = "degraded"
            print(decision_warning)
        else:
            try:
                decision_result, decision_warning = fetch_portfolio_decisions(
                    items,
                    portfolio_value,
                    request_id=f"{today}-{slot}",
                )
                decision_status = "degraded" if decision_warning else "ok"
            except DecisionAuthError as ex:
                print(ex)
                if not FORCE:
                    state["last_slot"] = slot
                    state["last_attempt_at"] = now.isoformat()
                    state["attempt_count"] = _increment_attempt_count(state.get("attempt_count", 0))
                    state["last_error"] = str(ex)[:240]
                    state["last_warning"] = ""
                    state["decision_status"] = "degraded"
                    state["last_http_status"] = ex.status
                    try:
                        write_state(gid, state)
                    except Exception as write_ex:
                        print("写鉴权失败状态失败:", write_ex)
                return 1
    decisions = {
        str(row.get("code")): row
        for row in ((decision_result or {}).get("decisions") or [])
    }
    lines = [
        format_push_line(code, name, estimates.get(code), decisions.get(code), today, now)
        for code, name in unique.items()
        if code in estimates
    ]
    title = f"司南基金 · 自选决策摘要（{slot}）" if decision_result else f"司南基金 · 自选涨跌幅（{slot}）"
    content = "\n".join(f"- {ln}" for ln in lines) + "\n\n> 数据辅助分析，不构成投资建议。"
    portfolio_summary = format_portfolio_summary(decision_result)
    if portfolio_summary:
        content = "\n".join(f"- {ln}" for ln in lines) + "\n\n" + portfolio_summary + "\n\n> 数据辅助分析，不构成投资建议。"
    if not send_notification(title, content):
        print("notification not accepted; state unchanged")
        return 1
    if FORCE:
        print("FORCE 测试推送，不写入 slot 去重状态")
    else:
        try:
            if slot not in sent_slots:
                sent_slots.append(slot)
            state["sent_slots"] = sorted(sent_slots)
            state["last_slot"] = slot
            state["last_attempt_at"] = now.isoformat()
            state["last_pushed_at"] = now.isoformat()
            state["last_success_at"] = now.isoformat()
            state["attempt_count"] = _increment_attempt_count(state.get("attempt_count", 0))
            state["last_error"] = ""
            state["last_warning"] = decision_warning or ""
            state["decision_status"] = decision_status
            state["last_http_status"] = 200
            write_state(gid, state)
        except Exception:
            print("通知已发送但状态写入失败；任务标记失败以阻止假绿")
            return 1
    print(f"pushed {len(lines)} funds, fresh={fresh}, slot={slot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
