"""Explicit complete-source cache preparation; no transaction during fetching.

The default collector uses one bounded primary-only HTTPS GET per needed code.
It never calls the legacy fetcher's fallback/estimate/name chain. Cache rows
and their original-byte receipt commit on the caller's one local connection.
No startup, Cron, remote database, environment credential or sender is used.
"""
from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import re
import threading
import time

import requests

from models.owner_machine_cache import MachineCachePrepare
from models.v8 import stable_id
from service import eastmoney, owner_analysis_repo as analysis, owner_machine_evidence as evidence
from service import owner_machine_repo as machine, repo

MAX_REQUESTS = 100
MAX_CONCURRENCY = 4
MAX_PROVIDER_BYTES = 4 * 1024 * 1024
MAX_CACHE_IMAGE_BYTES = 8 * 1024 * 1024
MAX_POINTS = 20_000
REQUEST_SECONDS = 8.0
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z")
_DETAIL_COLUMNS = evidence._DETAIL_COLUMNS
_RECEIPT_FIELDS = {"schema", "occurrence_id", "analysis_request_id", "created_at", "request_id", "request_hash",
                   "worker_build_sha", "response"}
_RESPONSE_FIELDS = {"schema", "revision", "source_hash", "policy_version", "prepared_at", "requested_count",
                    "fetched_count", "reused_count", "details", "cache_digest"}


def _fault(code="machine_cache_source_unavailable", status=503):
    return machine.MachineFault(code, status)


def _number(value, *, minimum=None, integer=False):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("invalid native number")
    if minimum is not None and value < minimum or integer and (type(value) is not int):
        raise ValueError("invalid number range")
    return value


def _text(value, maximum, *, optional=False):
    if value is None and optional:
        return None
    if type(value) is not str or not value.strip() or len(value.encode("utf-8")) > maximum or "\x00" in value:
        raise ValueError("invalid bounded text")
    return value


def _optional_number(raw):
    if raw in (None, ""):
        return None
    if type(raw) is str:
        if not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", raw):
            raise ValueError("invalid source decimal")
        raw = float(raw)
    return _number(raw)


def _json(text):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate provider field")
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite provider number")))


def _var(text, name, *, required=False):
    if len(re.findall(r"var\s+" + re.escape(name) + r"\s*=", text)) > 1:
        raise ValueError("duplicate provider assignment")
    raw = eastmoney._raw_var(text, name)
    if raw is None:
        if required:
            raise ValueError("missing provider field")
        return None
    return _json(raw)


def _parse_primary(code: str, text: str, observed_at: datetime) -> dict:
    """Parse fixed data assignments as JSON, never execute source JavaScript."""
    if _var(text, "fS_code", required=True) != code:
        raise ValueError("provider fund identity mismatch")
    name = _text(_var(text, "fS_name", required=True), 512)
    points = _var(text, "Data_netWorthTrend", required=True)
    if type(points) is not list or not 1 <= len(points) <= MAX_POINTS:
        raise ValueError("provider history unavailable")
    history, dates, accumulated = [], [], 1.0
    complete_returns = True
    for point in points:
        if type(point) is not dict:
            raise ValueError("invalid history point")
        milliseconds = _number(point.get("x"), minimum=0)
        nav = _number(point.get("y"), minimum=0)
        if nav <= 0:
            raise ValueError("nonpositive NAV")
        when = datetime.fromtimestamp(milliseconds / 1000, tz=machine.BEIJING).date().isoformat()
        if dates and when <= dates[-1]:
            raise ValueError("unordered or duplicate NAV dates")
        dates.append(when)
        daily = point.get("equityReturn")
        if daily is None:
            complete_returns = False
        else:
            daily = _number(daily, minimum=-100)
            if complete_returns:
                accumulated *= 1 + daily / 100
                if not math.isfinite(accumulated):
                    raise ValueError("nonfinite accumulated return")
        history.append({"date": when, "nav": nav,
                        "ac_return": round((accumulated - 1) * 100, 6) if complete_returns else None})
    managers = _var(text, "Data_currentFundManager")
    managers = [] if managers is None else managers
    if type(managers) is not list or len(managers) > 100 or any(type(item) is not dict for item in managers):
        raise ValueError("invalid manager data")
    manager = managers[0] if managers else {}
    manager_id = manager.get("id")
    if manager_id is not None:
        if type(manager_id) not in (str, int):
            raise ValueError("invalid manager identity")
        manager_id = _text(str(manager_id), 64)
    scales = _var(text, "Data_fluctuationScale")
    scales = {} if scales is None else scales
    if type(scales) is not dict:
        raise ValueError("invalid scale data")
    series = scales.get("series")
    series = [] if series is None else series
    if type(series) is not list or len(series) > MAX_POINTS or any(type(item) is not dict for item in series):
        raise ValueError("invalid scale series")
    ranks = _var(text, "Data_rateInSimilarType")
    ranks = [] if ranks is None else ranks
    if type(ranks) is not list or len(ranks) > MAX_POINTS or any(type(item) is not dict for item in ranks):
        raise ValueError("invalid ranking series")
    rank = ranks[-1] if ranks else {}
    values = {"code": code, "name": name, "type": repo._infer_fund_type(name),
        "buy_rate": _optional_number(_var(text, "fund_Rate")),
        "source_rate": _optional_number(_var(text, "fund_sourceRate")),
        "ret_1m": _optional_number(_var(text, "syl_1y")),
        "ret_6m": _optional_number(_var(text, "syl_6y")),
        "ret_1y": _optional_number(_var(text, "syl_1n")),
        "ret_3y": _optional_number(_var(text, "syl_3y")),
        "manager": _text(manager.get("name"), 512, optional=True), "manager_id": manager_id,
        "manager_worktime": _text(manager.get("workTime"), 128, optional=True),
        "scale": _optional_number(series[-1].get("y")) if series else None,
        "rank_in_type": _optional_number(rank.get("y")), "rank_total": _optional_number(rank.get("sc")),
        "latest_nav": history[-1]["nav"], "latest_nav_date": history[-1]["date"],
        "nav_history": history[-repo.HIST_KEEP:], "source": "primary",
        "updated_at": observed_at.isoformat()}
    return _validate_detail(code, values, observed_at)


def _validate_detail(code, detail, now):
    if type(detail) is not dict or detail.get("code") != code:
        raise ValueError("detail identity mismatch")
    permitted = {*_DETAIL_COLUMNS, "nav_history"}
    if set(detail) != permitted:
        raise ValueError("closed detail required")
    _text(detail["name"], 512)
    for field, size in (("type", 128), ("manager", 512), ("manager_id", 64), ("manager_worktime", 128)):
        _text(detail[field], size, optional=True)
    if detail["source"] != "primary":
        raise ValueError("only explicit primary observations admitted")
    observed = datetime.fromisoformat(detail["updated_at"])
    if observed.tzinfo is None or observed > now or now - observed > timedelta(seconds=analysis.TOTAL_SECONDS):
        raise ValueError("observation timestamp unavailable")
    latest = date.fromisoformat(detail["latest_nav_date"])
    today = now.astimezone(machine.BEIJING).date()
    if latest.isoformat() != detail["latest_nav_date"] or not 0 <= (today - latest).days <= 7:
        raise ValueError("latest NAV is not current")
    _number(detail["latest_nav"], minimum=0)
    if detail["latest_nav"] <= 0:
        raise ValueError("nonpositive latest NAV")
    for field in ("scale", "buy_rate", "source_rate", "ret_1m", "ret_6m", "ret_1y", "ret_3y",
                  "rank_in_type", "rank_total"):
        if detail[field] is not None:
            _number(detail[field])
    for field in ("rank_in_type", "rank_total"):
        if detail[field] is not None and (detail[field] < 0 or not float(detail[field]).is_integer()):
            raise ValueError("invalid ranking")
    history = detail["nav_history"]
    if type(history) is not list or not 1 <= len(history) <= repo.HIST_KEEP:
        raise ValueError("complete bounded history required")
    previous = None
    for item in history:
        if type(item) is not dict or set(item) != {"date", "nav", "ac_return"}:
            raise ValueError("closed NAV row required")
        when = date.fromisoformat(item["date"])
        if when.isoformat() != item["date"] or when > latest or previous and when <= previous:
            raise ValueError("history date invalid")
        previous = when
        _number(item["nav"], minimum=0)
        if item["nav"] <= 0:
            raise ValueError("nonpositive history NAV")
        if item["ac_return"] is not None:
            _number(item["ac_return"])
    if history[-1]["date"] != detail["latest_nav_date"] or history[-1]["nav"] != detail["latest_nav"]:
        raise ValueError("latest NAV and history disagree")
    if len(analysis._json({key: detail[key] for key in _DETAIL_COLUMNS}).encode("utf-8")) > 16 * 1024:
        raise ValueError("detail exceeds existing byte budget")
    return detail


def _fetch_one(code, check, stop, deadline):
    check()
    if stop.is_set():
        raise _fault()
    left = min(REQUEST_SECONDS, deadline - time.monotonic())
    if left <= 0:
        raise _fault("machine_cache_timeout")
    request_deadline = time.monotonic() + left
    try:
        with requests.Session() as session:
            session.trust_env = False
            session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
            check()
            if stop.is_set():
                raise _fault()
            with session.get(f"https://fund.eastmoney.com/pingzhongdata/{code}.js",
                headers={"User-Agent": "fund-compass-cache-candidate", "Referer": "https://fund.eastmoney.com/",
                         "Accept-Encoding": "identity"}, stream=True, allow_redirects=False,
                timeout=(min(4.0, left), min(2.0, left))) as response:
                if response.status_code in {401, 403, 429}:
                    stop.set()
                    raise _fault("machine_cache_source_stopped")
                if response.status_code != 200 or response.url != f"https://fund.eastmoney.com/pingzhongdata/{code}.js":
                    raise _fault()
                if response.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
                    raise _fault()
                if response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() not in {
                        "application/javascript", "text/javascript", "application/x-javascript", "text/plain"}:
                    raise _fault()
                length = response.headers.get("Content-Length")
                if length is not None and (not re.fullmatch(r"[0-9]{1,10}", length) or int(length) > MAX_PROVIDER_BYTES):
                    raise _fault()
                data = bytearray()
                while True:
                    check()
                    if stop.is_set() or time.monotonic() >= request_deadline:
                        raise _fault("machine_cache_timeout")
                    chunk = response.raw.read1(16_384)
                    check()
                    if len(data) + len(chunk) > MAX_PROVIDER_BYTES:
                        raise _fault()
                    data.extend(chunk)
                    if not chunk:
                        break
                if length is not None and int(length) != len(data):
                    raise _fault()
                if time.monotonic() >= request_deadline:
                    raise _fault("machine_cache_timeout")
                detail = _parse_primary(code, data.decode("utf-8-sig", errors="strict"), machine._clock())
                check()
                if time.monotonic() >= request_deadline:
                    raise _fault("machine_cache_timeout")
                return detail
    except (machine.MachineFault, analysis._GuardFailure):
        raise
    except Exception:
        raise _fault() from None


def _collect_details(codes, *, check, deadline):
    if len(codes) > MAX_REQUESTS:
        raise _fault("machine_cache_request_budget_exhausted")
    stop = threading.Event()
    executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY, thread_name_prefix="fund-cache-candidate")
    pending, result, remaining = {}, {}, iter(codes)
    def launch():
        check()
        if stop.is_set():
            return
        code = next(remaining, None)
        if code is not None:
            pending[executor.submit(_fetch_one, code, check, stop, deadline)] = code
    try:
        for _ in range(MAX_CONCURRENCY):
            launch()
        while pending:
            check()
            left = deadline - time.monotonic()
            if left <= 0:
                raise _fault("machine_cache_timeout")
            completed, _ = wait(pending, timeout=min(left, 0.1), return_when=FIRST_COMPLETED)
            # Resolve all completed failures before scheduling ANY replacement.
            done = [(pending.pop(future), future.result()) for future in completed]
            for code, detail in done:
                result[code] = detail
            for _ in done:
                launch()
        check()
        return result
    except Exception:
        stop.set()
        for future in pending:
            future.cancel()
        raise
    finally:
        # In-flight public reads have their own short cooperative deadline and
        # no SQL capability. Their late result can never write or start a POST.
        executor.shutdown(wait=False, cancel_futures=True)


collect_public_details = _collect_details


def _cache_image(conn, codes, check):
    digest, size = hashlib.sha256(), 0
    def add(value):
        nonlocal size
        raw = analysis._json(value).encode("utf-8")
        size += len(raw)
        if size > MAX_CACHE_IMAGE_BYTES:
            raise _fault("machine_cache_capacity_exhausted")
        digest.update(str(len(raw)).encode("ascii") + b":" + raw)
    for code in codes:
        check()
        add(["code", code])
        bound = "+".join(f"COALESCE(length(CAST({field} AS BLOB)),0)" for field in _DETAIL_COLUMNS)
        row = conn.execute(f"SELECT {bound} FROM fund_detail WHERE code=?", (code,)).fetchone()
        if row is not None and (type(row[0]) is not int or row[0] > 16 * 1024):
            raise _fault("machine_cache_capacity_exhausted")
        row = conn.execute("SELECT " + ",".join(_DETAIL_COLUMNS) + " FROM fund_detail WHERE code=?", (code,)).fetchone()
        add(["detail", list(row) if row else None])
        count, history_bytes = conn.execute("SELECT COUNT(*),COALESCE(SUM(length(CAST(date AS BLOB))"
            "+COALESCE(length(CAST(nav AS BLOB)),0)+COALESCE(length(CAST(ac_return AS BLOB)),0)),0) "
            "FROM nav_history WHERE code=?", (code,)).fetchone()
        if count > repo.HIST_KEEP or history_bytes > repo.HIST_KEEP * 128:
            raise _fault("machine_cache_capacity_exhausted")
        for row in conn.execute("SELECT date,nav,ac_return FROM nav_history WHERE code=? ORDER BY date", (code,)):
            add(["nav", list(row)])
        row = conn.execute("SELECT CASE WHEN type IS NULL OR (typeof(type)='text' AND "
            "length(CAST(type AS BLOB))<=128) THEN 1 ELSE 0 END,"
            "CASE WHEN typeof(type)='text' AND length(CAST(type AS BLOB))<=128 THEN type ELSE NULL END "
            "FROM funds WHERE code=?", (code,)).fetchone()
        if row is not None and row[0] != 1:
            raise _fault("machine_cache_capacity_exhausted")
        add(["fund-type", [row[1]] if row else None])
    return digest.hexdigest()


def _receipt_id(occurrence, request_id):
    return stable_id("machine_cache", {"occurrence": occurrence, "request_id": request_id})


def _checked_receipt(conn, value, record_id, check):
    try:
        if (type(value) is not dict or set(value) != _RECEIPT_FIELDS
                or value["schema"] != "owner-machine-cache-receipt-1" or value["analysis_request_id"] is not None
                or type(value["request_id"]) is not str or not _ID.fullmatch(value["request_id"])
                or type(value["request_hash"]) is not str or not _HEX.fullmatch(value["request_hash"])
                or type(value["worker_build_sha"]) is not str or not re.fullmatch(r"[0-9a-f]{40}", value["worker_build_sha"])
                or _receipt_id(value["occurrence_id"], value["request_id"]) != record_id):
            raise ValueError("receipt identity")
        occurrence = date.fromisoformat(value["occurrence_id"])
        stamp = datetime.fromisoformat(value["created_at"])
        if (stamp.tzinfo != timezone.utc or stamp.isoformat() != value["created_at"] or stamp > machine._clock()
                or stamp.astimezone(machine.BEIJING).date() != occurrence):
            raise ValueError("receipt time")
        response = value["response"]
        if (type(response) is not dict or set(response) != _RESPONSE_FIELDS
                or response["schema"] != "owner-machine-cache-1" or response["prepared_at"] != value["created_at"]
                or type(response["revision"]) is not int or not 0 <= response["revision"] <= analysis.sync.MAX_SAFE_REVISION
                or not _HEX.fullmatch(response["source_hash"]) or not _HEX.fullmatch(response["cache_digest"])
                or not re.fullmatch(r"pol_[0-9a-f]{64}", response["policy_version"])
                or type(response["details"]) is not list or not 1 <= len(response["details"]) <= MAX_REQUESTS):
            raise ValueError("receipt result")
        for field in ("requested_count", "fetched_count", "reused_count"):
            _number(response[field], minimum=0, integer=True)
        if (response["requested_count"] != len(response["details"])
                or response["fetched_count"] + response["reused_count"] != response["requested_count"]):
            raise ValueError("receipt counts")
        check()
        policy = analysis._reference(conn, "policy", response["policy_version"])
        if policy.created_at > stamp or policy.effective_at > stamp:
            raise ValueError("receipt Policy chronology")
        codes = []
        for item in response["details"]:
            check()
            if type(item) is not dict or set(item) != {"code", "source", "updated_at", "latest_nav_date"}:
                raise ValueError("receipt detail")
            code = _text(item["code"], 6)
            if not re.fullmatch(r"[0-9]{6}", code):
                raise ValueError("receipt fund")
            _text(item["source"], 80)
            observed = datetime.fromisoformat(item["updated_at"])
            latest = date.fromisoformat(item["latest_nav_date"])
            if (observed.tzinfo is None or observed > stamp or stamp - observed >= repo.DETAIL_TTL
                    or latest.isoformat() != item["latest_nav_date"] or not 0 <= (occurrence - latest).days <= 7):
                raise ValueError("receipt detail time")
            codes.append(code)
        if codes != sorted(set(codes)):
            raise ValueError("receipt complete source")
        # Cache is mutable: historical receipt validation deliberately does not
        # compare today's cache/source/Policy or renew its original eligibility.
        return response
    except (machine.MachineFault, analysis._GuardFailure):
        raise
    except Exception:
        raise _fault("machine_integrity_unavailable") from None


def _find_receipt(conn, occurrence, request_id, request_hash, check):
    identifier = _receipt_id(occurrence, request_id)
    found = machine._load(conn, "observation", identifier)
    if found is None:
        return None
    result = _checked_receipt(conn, found[0], identifier, check)
    if found[0]["request_hash"] != request_hash:
        raise _fault("machine_invocation_conflict", 409)
    return result


def read_cache_receipt_local(conn, occurrence, request_id, request_hash, *, before_read=None):
    def read(check):
        result = _find_receipt(conn, occurrence, request_id, request_hash, check)
        if result is None:
            raise _fault("machine_cache_receipt_missing", 404)
        return result
    return machine._transaction(conn, read, before_commit=before_read)


def _write_detail(conn, detail):
    # Do not call repo._save_detail: its current clock would retimestamp every
    # fetch at commit, losing the actual completed source observation instant.
    conn.execute("INSERT OR REPLACE INTO fund_detail (" + ",".join(_DETAIL_COLUMNS) + ") VALUES ("
                 + ",".join("?" for _ in _DETAIL_COLUMNS) + ")", tuple(detail[field] for field in _DETAIL_COLUMNS))
    # This explicit operation owns a complete validated, bounded source image.
    # Union/upsert would retain a withdrawn intermediate date from an older
    # provider image and relabel it under the new detail observation timestamp.
    # Replace only this public-cache code, in the same rollbackable transaction;
    # immutable business snapshots and all unrelated codes remain untouched.
    conn.execute("DELETE FROM nav_history WHERE code=?", (detail["code"],))
    conn.executemany("INSERT INTO nav_history(code,date,nav,ac_return) VALUES (?,?,?,?)",
        [(detail["code"], item["date"], item["nav"], item["ac_return"]) for item in detail["nav_history"]])


def prepare_cache_local(conn, request: MachineCachePrepare, *, before_commit=None, collector=None):
    request_hash = request.request_hash()
    start = time.monotonic()
    check = analysis._guard(before_commit)
    check()
    deadline = start + analysis.TOTAL_SECONDS
    def read(check):
        existing = _find_receipt(conn, request.occurrence_date, request.request_id, request_hash, check)
        if existing is not None:
            return {"existing": existing}
        stamp = machine._clock()
        if stamp.astimezone(machine.BEIJING).date().isoformat() != request.occurrence_date:
            raise _fault("machine_cache_occurrence_mismatch", 409)
        source, _raw, sha, codes = machine._source(conn, check)
        if not codes:
            raise _fault("machine_source_empty", 409)
        if source["revision"] != request.expected_revision or sha != request.source_hash:
            raise _fault("machine_source_conflict", 409)
        if machine._policy(conn, stamp, check).policy_version != request.policy_version:
            raise _fault("machine_policy_changed", 409)
        image = _cache_image(conn, codes, check)
        reused, needed = {}, []
        for code in codes:
            check()
            try:
                detail = evidence._cached_detail(conn, code, stamp)
                if (detail["stale"] or not detail["nav_history"]
                        or detail["nav_history"][-1]["date"] != detail["latest_nav_date"]):
                    raise ValueError("cache requires preparation")
                _text(detail["source"], 80)
                reused[code] = detail
            except (machine.MachineFault, ValueError):
                needed.append(code)
        return {"codes": codes, "cache_image": image, "reused": reused, "needed": needed}
    plan = machine._transaction(conn, read, check=check)
    if "existing" in plan:
        return plan["existing"]
    check()
    if conn.in_transaction:
        raise _fault("machine_cache_active_transaction")
    fetched = (collector or collect_public_details)(tuple(plan["needed"]), check=check, deadline=deadline) if plan["needed"] else {}
    check()
    if type(fetched) is not dict or sorted(fetched) != plan["needed"]:
        raise _fault("machine_cache_incomplete_source")
    stamp = machine._clock()
    if stamp.astimezone(machine.BEIJING).date().isoformat() != request.occurrence_date:
        raise _fault("machine_cache_occurrence_mismatch", 409)
    for code, detail in fetched.items():
        try:
            _validate_detail(code, detail, stamp)
        except Exception:
            raise _fault("machine_cache_source_invalid") from None
        check()
    def write(check):
        existing = _find_receipt(conn, request.occurrence_date, request.request_id, request_hash, check)
        if existing is not None:
            return existing
        now = machine._clock()
        if now.astimezone(machine.BEIJING).date().isoformat() != request.occurrence_date:
            raise _fault("machine_cache_occurrence_mismatch", 409)
        source, _raw, sha, codes = machine._source(conn, check)
        if source["revision"] != request.expected_revision or sha != request.source_hash or codes != plan["codes"]:
            raise _fault("machine_source_conflict", 409)
        if machine._policy(conn, now, check).policy_version != request.policy_version:
            raise _fault("machine_policy_changed", 409)
        if _cache_image(conn, codes, check) != plan["cache_image"]:
            raise _fault("machine_cache_changed", 409)
        for code, detail in fetched.items():
            check(); _validate_detail(code, detail, now)
            repo._fill_detail_type(conn, detail)
            _write_detail(conn, detail)
        details = []
        for code in codes:
            check()
            detail = evidence._cached_detail(conn, code, now)
            if detail["stale"]:
                raise _fault("machine_cache_expired_during_prepare", 409)
            details.append({field: detail[field] for field in ("code", "source", "updated_at", "latest_nav_date")})
        response = {"schema": "owner-machine-cache-1", "revision": request.expected_revision,
            "source_hash": request.source_hash, "policy_version": request.policy_version,
            "prepared_at": now.isoformat(), "requested_count": len(codes), "fetched_count": len(fetched),
            "reused_count": len(plan["reused"]), "details": details, "cache_digest": _cache_image(conn, codes, check)}
        receipt = {"schema": "owner-machine-cache-receipt-1", "occurrence_id": request.occurrence_date,
            "analysis_request_id": None, "created_at": now.isoformat(), "request_id": request.request_id,
            "request_hash": request_hash, "worker_build_sha": request.worker_build_sha, "response": response}
        machine._append(conn, "observation", _receipt_id(request.occurrence_date, request.request_id), receipt)
        return response
    return machine._transaction(conn, write, immediate=True, check=check)
