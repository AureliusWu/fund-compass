"""Local candidate machine occurrence -> real Owner analysis -> existing claim.

No Gist, network, credential discovery, startup DDL or sender lives here. Each
write owns one BEGIN IMMEDIATE and an immutable journal receipt. Lost commits
are unknown: only read the original task/attempt, never infer safe replay.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import re
import sqlite3

from database.owner_machine_schema import OWNER_MACHINE_SCHEMA_VERSION, verify_owner_machine_schema
from models.owner_analysis import parse_owner_analysis_request
from models.owner_machine import MachineClaim, MachineFinish, MachinePrepare
from models.v8 import NotificationEvent, stable_id
from service import owner_analysis_repo as analysis, owner_policy_state as policies
from service import repository_scopes as scopes, v8_repo

BEIJING = timezone(timedelta(hours=8))
MAX_JOURNAL_ROWS = 100_000
MAX_JOURNAL_BYTES = 64 * 1024 * 1024
_KINDS = frozenset({"task", "attempt", "result", "observation"})
# Reviewed SSE 2026 annual closure notice. Unsupported years are unknown, not
# trading days. This is a domestic task calendar, not a QDII NAV-date oracle.
CALENDAR_SOURCE = "https://www.sse.com.cn/disclosure/dealinstruc/closed/"
HOLIDAYS_2026 = frozenset({
    "2026-01-01", "2026-01-02", "2026-02-16", "2026-02-17", "2026-02-18",
    "2026-02-19", "2026-02-20", "2026-02-23", "2026-04-06", "2026-05-01",
    "2026-05-04", "2026-05-05", "2026-06-19", "2026-09-25", "2026-10-01",
    "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
})


class MachineFault(RuntimeError):
    def __init__(self, code: str, status: int = 503):
        self.code, self.status = code, status
        super().__init__(code)


def _clock():
    return analysis._clock()


def _ready(conn):
    if not isinstance(conn, sqlite3.Connection) or conn.in_transaction:
        raise MachineFault("machine_storage_unavailable")
    if tuple(conn.execute("PRAGMA foreign_keys").fetchone()) != (1,):
        raise MachineFault("machine_storage_unavailable")
    verify_owner_machine_schema(conn)


def _load(conn, kind, identifier):
    if kind not in _KINDS:
        raise MachineFault("machine_integrity_unavailable")
    row = conn.execute(
        "SELECT CASE WHEN typeof(occurrence_id)='text' AND length(CAST(occurrence_id AS BLOB))<=128 "
        "THEN occurrence_id ELSE NULL END,"
        "CASE WHEN typeof(analysis_request_id)='text' AND length(CAST(analysis_request_id AS BLOB))<=128 "
        "THEN analysis_request_id ELSE NULL END,"
        "CASE WHEN typeof(created_at)='text' AND length(CAST(created_at AS BLOB))<=64 THEN created_at ELSE NULL END,"
        "CASE WHEN typeof(payload_json)='text' AND length(CAST(payload_json AS BLOB))<=? "
        "THEN payload_json ELSE NULL END,"
        "CASE WHEN typeof(payload_hash)='text' AND length(CAST(payload_hash AS BLOB))=64 THEN payload_hash ELSE NULL END,"
        "CASE WHEN schema_version='owner-machine-schema-1' THEN 1 ELSE 0 END "
        "FROM owner_machine_journal WHERE kind=? AND record_id=?",
        (analysis.MAX_JSON_BYTES, kind, identifier)).fetchone()
    if row is None:
        return None
    raw, digest = row[3], row[4]
    value = analysis._decode(raw)
    if (type(value) is not dict or row[5] != 1 or analysis._sha(raw) != digest
            or value.get("occurrence_id") != row[0] or value.get("created_at") != row[2]
            or value.get("analysis_request_id") != row[1]):
        raise MachineFault("machine_integrity_unavailable")
    return value, digest


def _append(conn, kind, identifier, value):
    if kind not in _KINDS:
        raise MachineFault("machine_integrity_unavailable")
    raw = analysis._bounded(analysis._json(value))
    count, size = conn.execute("SELECT COUNT(*),COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) "
                               "FROM owner_machine_journal").fetchone()
    if count >= MAX_JOURNAL_ROWS or size + len(raw.encode("utf-8")) > MAX_JOURNAL_BYTES:
        raise MachineFault("machine_capacity_exhausted")
    conn.execute("INSERT INTO owner_machine_journal(schema_version,kind,record_id,occurrence_id,analysis_request_id,created_at,payload_json,payload_hash) "
        "VALUES(?,?,?,?,?,?,?,?)", (OWNER_MACHINE_SCHEMA_VERSION, kind, identifier, value["occurrence_id"], value["analysis_request_id"],
                                  value["created_at"], raw, analysis._sha(raw)))
    return analysis._sha(raw)


def _policy(conn, stamp, check):
    chain = policies._read_chain(conn, stamp, scopes.PRODUCTION, check)
    current = next((row for row in chain if row.effective_at <= stamp), None)
    if current is None:
        raise MachineFault("machine_policy_unavailable", 409)
    return current


def _source(conn, check):
    source, raw, sha = analysis._source(conn, check)
    codes = sorted({row["key"][:6] for row in source["records"]
                    if not row["deleted"] and row["kind"] != "manual_asset"})
    if len(codes) > 100:
        raise MachineFault("machine_capacity_exhausted")
    return source, raw, sha, codes


def _window(request, stamp):
    planned = datetime.fromisoformat(f"{request.occurrence_date}T{request.slot}:00+08:00")
    actual = stamp.astimezone(BEIJING)
    if planned.year != 2026:
        raise MachineFault("machine_calendar_unsupported", 409)
    if planned.weekday() >= 5 or request.occurrence_date in HOLIDAYS_2026:
        raise MachineFault("machine_non_trading_day", 409)
    # No late replay of a 14:30 observation. Compensation may begin 14:40, but
    # all new deliveries stop strictly before 14:50 and remain marked actual.
    if actual.date() != planned.date() or actual < planned or actual >= planned.replace(hour=14, minute=50):
        raise MachineFault("machine_outside_delivery_window", 409)
    return planned.isoformat()


def _task(conn, occurrence, check):
    found = _load(conn, "task", occurrence)
    if found is None:
        return None
    task, task_hash = found
    required = {"schema", "occurrence_id", "analysis_request_id", "analysis_request_hash", "run_id",
                "run_response_hash", "source_revision", "source_hash", "policy_version", "strategy_version",
                "created_at", "worker_build_sha", "decision_ids"}
    if (set(task) != required or task["schema"] != "owner-machine-task-1" or task["occurrence_id"] != occurrence
            or type(task["worker_build_sha"]) is not str or not re.fullmatch(r"[0-9a-f]{40}", task["worker_build_sha"])):
        raise MachineFault("machine_integrity_unavailable")
    stored = analysis._stored(conn, task["analysis_request_id"], task["analysis_request_hash"], check)
    if stored is None or stored.status != 200:
        raise MachineFault("machine_integrity_unavailable")
    run = stored.body["run"]
    if (task["run_id"] != run["run_id"] or task["run_response_hash"] != analysis._sha(analysis._json(run))
            or task["source_revision"] != run["source"]["revision"] or task["source_hash"] != run["source"]["sha256"]
            or task["policy_version"] != run["policy"]["policy_version"]
            or task["strategy_version"] != run["strategy_version"] or task["created_at"] != run["created_at"]
            or task["decision_ids"] != [row["decision"]["decision_id"] for row in run["components"]]):
        raise MachineFault("machine_integrity_unavailable")
    return {"task": task, "task_hash": task_hash, "run": run, "source_current": stored.body["source_current"]}


def _transaction(conn, operation, *, immediate=False, before_commit=None, check=None):
    check = check if check is not None else analysis._guard(before_commit)
    active = False
    try:
        check(); _ready(conn); check()
        conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN"); active = True
        verify_owner_machine_schema(conn); check()
        value = operation(check)
        # Bound the entire returned image, not just each separately stored row.
        # In particular 200 observations cannot multiply the 2MiB document cap.
        analysis._bounded(analysis._json(value))
        check(); conn.commit(); active = False; check()
        return value
    except Exception:
        if active:
            analysis._rollback(conn)
        raise


def read_source_local(conn):
    def read(check):
        stamp = _clock()
        source, _raw, sha, codes = _source(conn, check)
        policy = _policy(conn, stamp, check)
        return {"schema": "owner-machine-source-1", "revision": source["revision"], "source_hash": sha,
                "record_count": len(source["records"]), "scope": "fund_only", "codes": codes,
                "policy_version": policy.policy_version}
    return _transaction(conn, read)


def _observe(conn, request, phase, started, finished, result=None, fault=None):
    """Append each real invocation separately; manual success cannot erase Cron."""
    if finished < started:
        raise MachineFault("machine_clock_regressed")
    identity = stable_id("machine_obs", {"occurrence": request.occurrence_date, "phase": phase,
                                         "request_id": request.request_id})
    input_hash = analysis._sha(analysis._json(request.model_dump(mode="json")))
    existing = _load(conn, "observation", identity)
    if existing:
        if existing[0].get("input_hash") != input_hash:
            raise MachineFault("machine_invocation_conflict", 409)
        return
    task = _load(conn, "task", request.occurrence_date)
    artifact, valid, expected, digest = "unavailable", None, None, None
    if result and "run" in result:
        valid = _fresh_count(result["run"], finished)
        expected = len(result["run"]["components"])
        artifact = "fresh" if result["run"]["pricing_complete"] and valid == expected else "partial"
        digest = analysis._sha(analysis._json(result["run"]))
    elif result and "attempt" in result:
        valid, expected = result["attempt"]["valid_count"], result["attempt"]["expected_count"]
        artifact = result["attempt"]["artifact_status"]
        digest = task[0]["run_response_hash"] if task else None
    duplicate = result is not None and result.get("duplicate") is True
    status = "blocked" if fault else "skipped" if duplicate else "succeeded"
    reason = fault.code if fault else "already_recorded" if duplicate else "prepared" if phase == "prepare" else "claim_acquired"
    observation = {"schema": "owner-machine-observation-1", "occurrence_id": request.occurrence_date,
        "analysis_request_id": task[0]["analysis_request_id"] if task else None,
        "created_at": finished.isoformat(), "input_hash": input_hash, "request_id": request.request_id,
        "phase": phase, "trigger": request.trigger, "slot": request.slot, "worker_build_sha": request.worker_build_sha,
        "scheduled_at": f"{request.occurrence_date}T{request.slot}:00+08:00",
        "started_at": started.isoformat(), "finished_at": finished.isoformat(),
        "execution_status": status, "artifact_status": artifact, "valid_count": valid,
        "expected_count": expected, "reason": reason, "artifact_digest": digest,
        "http_status": fault.status if fault else 200,
        "output_hash": None if fault else result.get("task_hash") or result.get("attempt_hash")}
    _append(conn, "observation", identity, observation)


def _operation(conn, request, phase, operation, before_commit):
    check = analysis._guard(before_commit)
    check()
    started = _clock()
    def write(check):
        # Invocation IDs identify immutable attempts, including rejections.
        # Checking this BEFORE business work prevents an old 14:29 blocked
        # packet from becoming a different successful invocation at 14:31.
        identity = stable_id("machine_obs", {"occurrence": request.occurrence_date, "phase": phase,
                                             "request_id": request.request_id})
        existing = _load(conn, "observation", identity)
        if existing is not None:
            observation = existing[0]
            if observation.get("input_hash") != analysis._sha(analysis._json(request.model_dump(mode="json"))):
                raise MachineFault("machine_invocation_conflict", 409)
            if observation.get("execution_status") == "blocked":
                code, status = observation.get("reason"), observation.get("http_status")
                if type(code) is not str or not re.fullmatch(r"[a-z][a-z0-9_]{1,79}", code) or type(status) is not int or status not in {409, 422, 503}:
                    raise MachineFault("machine_integrity_unavailable")
                raise MachineFault(code, status)
            if observation.get("execution_status") not in {"succeeded", "skipped"} or observation.get("http_status") != 200:
                raise MachineFault("machine_integrity_unavailable")
            task = _task(conn, request.occurrence_date, check)
            if task is None:
                raise MachineFault("machine_integrity_unavailable")
            if phase == "prepare":
                if observation.get("output_hash") != task["task_hash"]:
                    raise MachineFault("machine_integrity_unavailable")
                return {**task, "duplicate": True}
            for slot in ("14:30", "14:40"):
                attempt = _attempt(conn, request.occurrence_date, slot, task, check)
                if attempt is not None and attempt[1] == observation.get("output_hash"):
                    terminal = _terminal(conn, request.occurrence_date, slot, attempt, task, check)
                    return {"claimed": False, "duplicate": True, "attempt": attempt[0], "attempt_hash": attempt[1],
                            "result": terminal[0] if terminal else None}
            raise MachineFault("machine_integrity_unavailable")
        value = operation(check)
        _observe(conn, request, phase, started, _clock(), result=value)
        return value
    try:
        return _transaction(conn, write, immediate=True, check=check)
    except (MachineFault, analysis._Fault) as error:
        if error.code == "machine_invocation_conflict":
            raise
        # A known, rolled-back business rejection may still have a durable
        # execution observation. Unknown commit/close exceptions NEVER become
        # failed/retryable claims or a synthetic successful Cron observation.
        try:
            _transaction(conn, lambda _check: _observe(conn, request, phase, started, _clock(), fault=error),
                         immediate=True, check=check)
        except Exception:
            raise MachineFault("machine_observation_unknown") from None
        raise


def _notifications(conn, **parameters):
    try:
        return v8_repo._record_notification_events_in_transaction(conn, **parameters)
    except v8_repo.SnapshotConflictError:
        raise MachineFault("machine_notification_conflict", 409) from None


def prepare_local(conn, request: MachinePrepare, *, before_commit=None):
    def write(check):
        # Read an existing occurrence FIRST: changed market/source inputs must
        # never create a second run for the same natural/manual business day.
        existing = _task(conn, request.occurrence_date, check)
        if existing is not None:
            return {**existing, "duplicate": True}
        stamp = _clock(); _window(request, stamp)
        source, _raw, sha, codes = _source(conn, check)
        if source["revision"] != request.expected_revision or sha != request.source_hash or codes != [row.code for row in request.evidence]:
            raise MachineFault("machine_source_conflict", 409)
        policy = _policy(conn, stamp, check)
        if policy.policy_version != request.policy_version:
            raise MachineFault("machine_policy_changed", 409)
        analysis_request = parse_owner_analysis_request(analysis._json({
            "request_id": "machine-portfolio-" + request.occurrence_date,
            "expected_revision": request.expected_revision, "policy_version": request.policy_version,
            "evidence": [row.model_dump() for row in request.evidence]}))
        # Actual Holding/Decision/source/receipt and occurrence use ONE caller
        # transaction. The internal analysis core performs no nested commit.
        result = analysis._create_analysis_in_transaction(conn, analysis_request, check)
        run = result.body["run"]
        task = {"schema": "owner-machine-task-1", "occurrence_id": request.occurrence_date,
                "analysis_request_id": analysis_request.request_id, "analysis_request_hash": analysis_request.request_hash(),
                "run_id": run["run_id"], "run_response_hash": analysis._sha(analysis._json(run)),
                "source_revision": request.expected_revision, "source_hash": sha,
                "policy_version": request.policy_version, "strategy_version": run["strategy_version"],
                "created_at": run["created_at"], "worker_build_sha": request.worker_build_sha,
                "decision_ids": [row["decision"]["decision_id"] for row in run["components"]]}
        _append(conn, "task", request.occurrence_date, task)
        return {**_task(conn, request.occurrence_date, check), "duplicate": False}
    return _operation(conn, request, "prepare", write, before_commit)


def read_task_local(conn, occurrence):
    return _transaction(conn, lambda check: _task(conn, occurrence, check))


def _fresh_count(run, stamp):
    fresh = 0
    for component in run["components"]:
        proof = component["evidence"]
        market = datetime.fromisoformat(proof["market_time"]) if proof["market_time"] is not None else None
        created = datetime.fromisoformat(proof["created_at"])
        if (market is not None and market.astimezone(BEIJING).date() == stamp.astimezone(BEIJING).date()
                and timedelta(0) <= stamp - market <= timedelta(minutes=90)
                and proof["estimate_status"] == "fresh" and proof["estimate"] is not None
                and proof["target_nav_date"] is None
                and not {"estimate", "market_time"}.intersection(proof["stale_fields"])
                and timedelta(0) <= stamp - created <= timedelta(minutes=90)):
            fresh += 1
    return fresh


def _notification_phase(conn, attempt, status, stamp, error_class=None):
    """Bind a journal phase to the ACTUAL existing V8 claim, not just a hash."""
    detail = {"machine_task_hash": attempt["task_hash"], "occurrence_id": attempt["occurrence_id"]}
    for identifier in attempt["decision_ids"]:
        expected = v8_repo._notification_event(decision_id=identifier,
            scheduled_window=attempt["scheduled_window"], status=status,
            attempt_no=0 if status == "scheduled" else attempt["attempt_no"],
            natural_schedule=attempt["natural_schedule"], occurred_at=stamp,
            error_class=error_class, detail=detail)
        row = conn.execute("SELECT notification_event_id,decision_id,scheduled_window,status,attempt_no,"
            "natural_schedule,occurred_at,error_class,CASE WHEN length(CAST(detail_json AS BLOB))<=16384 "
            "THEN detail_json ELSE NULL END FROM production_notification_events WHERE event_log_id=?",
            (expected.event_log_id,)).fetchone()
        if row is None:
            raise MachineFault("machine_integrity_unavailable")
        model = NotificationEvent.model_validate_json(row[8])
        values = (expected.notification_event_id, identifier, expected.scheduled_window, status, expected.attempt_no,
                  int(expected.natural_schedule), stamp.isoformat(), error_class)
        if (tuple(row[:8]) != values or model.model_dump(mode="python") != expected.model_dump(mode="python")):
            raise MachineFault("machine_integrity_unavailable")


def _attempt(conn, occurrence, slot, task, check):
    found = _load(conn, "attempt", occurrence + ":" + slot)
    if found is None:
        return None
    attempt, digest = found
    fields = {"schema", "occurrence_id", "analysis_request_id", "task_hash", "slot", "attempt_no", "natural_schedule",
              "scheduled_window", "scheduled_at", "created_at", "request_id", "worker_build_sha", "trigger",
              "decision_ids", "execution_status", "artifact_status", "valid_count", "expected_count"}
    if (set(attempt) != fields or attempt["schema"] != "owner-machine-attempt-1" or attempt["slot"] != slot
            or task is None or attempt["task_hash"] != task["task_hash"]
            or attempt["analysis_request_id"] != task["task"]["analysis_request_id"]
            or attempt["decision_ids"] != task["task"]["decision_ids"]
            or attempt["scheduled_window"] != f"{occurrence}T{slot}+08:00"
            or attempt["scheduled_at"] != f"{occurrence}T{slot}:00+08:00"
            or type(attempt["attempt_no"]) is not int or attempt["attempt_no"] not in {1, 2}
            or type(attempt["natural_schedule"]) is not bool or attempt["trigger"] not in {"manual", "scheduled"}
            or attempt["natural_schedule"] != (attempt["trigger"] == "scheduled")
            or type(attempt["worker_build_sha"]) is not str or not re.fullmatch(r"[0-9a-f]{40}", attempt["worker_build_sha"])
            or type(attempt["request_id"]) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}", attempt["request_id"])):
        raise MachineFault("machine_integrity_unavailable")
    created = datetime.fromisoformat(attempt["created_at"])
    if created.tzinfo != timezone.utc or created.isoformat() != attempt["created_at"] or created > _clock():
        raise MachineFault("machine_integrity_unavailable")
    fresh = _fresh_count(task["run"], created)
    expected_artifact = "fresh" if task["run"]["pricing_complete"] and fresh == len(task["run"]["components"]) else "partial"
    if (attempt["execution_status"] != "running" or attempt["artifact_status"] != expected_artifact or fresh == 0
            or type(attempt["valid_count"]) is not int or attempt["valid_count"] != fresh
            or type(attempt["expected_count"]) is not int or attempt["expected_count"] != len(task["run"]["components"])):
        raise MachineFault("machine_integrity_unavailable")
    _window(MachineClaim(occurrence_date=occurrence, request_id=attempt["request_id"], trigger=attempt["trigger"],
        slot=slot, worker_build_sha=attempt["worker_build_sha"], task_hash=attempt["task_hash"]), created)
    if slot == "14:30" and attempt["attempt_no"] != 1:
        raise MachineFault("machine_integrity_unavailable")
    if slot == "14:40":
        primary = _attempt(conn, occurrence, "14:30", task, check)
        if primary is None:
            if attempt["attempt_no"] != 1:
                raise MachineFault("machine_integrity_unavailable")
        else:
            terminal = _terminal(conn, occurrence, "14:30", primary, task, check)
            if (attempt["attempt_no"] != 2 or terminal is None
                    or terminal[0]["outcome"] not in {"delivery_rejected", "pre_delivery_failed"}):
                raise MachineFault("machine_integrity_unavailable")
    check(); _notification_phase(conn, attempt, "scheduled", created)
    check(); _notification_phase(conn, attempt, "attempted", created)
    return attempt, digest


def _terminal(conn, occurrence, slot, attempt, task, check):
    found = _load(conn, "result", occurrence + ":" + slot)
    if found is None:
        return None
    result, digest = found
    fields = {"schema", "occurrence_id", "analysis_request_id", "created_at", "attempt_hash", "outcome",
              "execution_status", "artifact_status", "valid_count", "expected_count", "scheduled_at", "started_at",
              "finished_at", "trigger", "worker_build_sha", "artifact_digest"}
    previous, previous_hash = attempt
    if (set(result) != fields or result["schema"] != "owner-machine-result-1" or result["attempt_hash"] != previous_hash
            or result["analysis_request_id"] != previous["analysis_request_id"]
            or result["outcome"] not in {"sent", "delivery_rejected", "delivery_ambiguous", "pre_delivery_failed"}
            or result["execution_status"] != ("succeeded" if result["outcome"] == "sent" else "failed")
            or result["started_at"] != previous["created_at"] or result["finished_at"] != result["created_at"]
            or result["artifact_digest"] != task["task"]["run_response_hash"]):
        raise MachineFault("machine_integrity_unavailable")
    for field in ("artifact_status", "valid_count", "expected_count", "scheduled_at", "trigger", "worker_build_sha"):
        if type(result[field]) is not type(previous[field]) or result[field] != previous[field]:
            raise MachineFault("machine_integrity_unavailable")
    stamp = datetime.fromisoformat(result["created_at"])
    if (stamp.tzinfo != timezone.utc or stamp.isoformat() != result["created_at"]
            or stamp < datetime.fromisoformat(previous["created_at"]) or stamp > _clock()):
        raise MachineFault("machine_integrity_unavailable")
    check(); _notification_phase(conn, previous, "sent" if result["outcome"] == "sent" else "failed", stamp,
                                 None if result["outcome"] == "sent" else result["outcome"])
    return result, digest


def claim_local(conn, request: MachineClaim, *, before_commit=None):
    def write(check):
        task = _task(conn, request.occurrence_date, check)
        if task is None or task["task_hash"] != request.task_hash:
            raise MachineFault("machine_task_conflict", 409)
        # Both slots and manual/natural invocations share this immutable task.
        # The journal maps its original claim, NOT a new lease/sending lock.
        previous = []
        for slot in ("14:30", "14:40"):
            found = _attempt(conn, request.occurrence_date, slot, task, check)
            if found is None and _load(conn, "result", request.occurrence_date + ":" + slot) is not None:
                raise MachineFault("machine_integrity_unavailable")
            if found:
                prior, digest = found
                terminal = _terminal(conn, request.occurrence_date, slot, found, task, check)
                if slot == request.slot or terminal is None or terminal[0].get("outcome") not in {"delivery_rejected", "pre_delivery_failed"}:
                    return {"claimed": False, "duplicate": True, "attempt": prior, "attempt_hash": digest,
                            "result": terminal[0] if terminal else None}
                previous.append(prior)
        stamp = _clock(); planned = _window(request, stamp)
        if request.slot == "14:30" and previous:
            raise MachineFault("machine_slot_regressed", 409)
        if not task["source_current"]:
            raise MachineFault("machine_source_conflict", 409)
        if _policy(conn, stamp, check).policy_version != task["task"]["policy_version"]:
            raise MachineFault("machine_policy_changed", 409)
        if task["task"]["strategy_version"] != analysis.ANALYSIS_STRATEGY_VERSION:
            raise MachineFault("machine_strategy_changed", 409)
        run = task["run"]
        # A full digest may explain incomplete inputs, but cannot advertise a
        # fresh intraday push on yesterday's persisted Evidence alone.
        fresh = _fresh_count(run, stamp)
        if fresh == 0:
            raise MachineFault("machine_no_current_intraday", 409)
        natural = request.trigger == "scheduled"
        window = f"{request.occurrence_date}T{request.slot}+08:00"
        detail = {"machine_task_hash": request.task_hash, "occurrence_id": request.occurrence_date}
        attempt_no = len(previous) + 1
        _notifications(conn, decision_ids=task["task"]["decision_ids"],
            scheduled_window=window, status="scheduled", attempt_no=0, natural_schedule=natural,
            occurred_at=stamp, detail=detail, _machine_binding=(request.occurrence_date, request.task_hash))
        claims = _notifications(conn, decision_ids=task["task"]["decision_ids"],
            scheduled_window=window, status="attempted", attempt_no=attempt_no, natural_schedule=natural,
            occurred_at=stamp, detail=detail, _machine_binding=(request.occurrence_date, request.task_hash))
        if not claims or any(not row.claimed or row.duplicate for row in claims):
            # No transport permission can be reconstructed from a legacy claim
            # lacking this exact journal binding. Leave it for manual audit.
            raise MachineFault("machine_notification_already_claimed", 409)
        attempt = {"schema": "owner-machine-attempt-1", "occurrence_id": request.occurrence_date,
            "analysis_request_id": task["task"]["analysis_request_id"], "task_hash": request.task_hash,
            "slot": request.slot, "attempt_no": attempt_no, "natural_schedule": natural,
            "scheduled_window": window, "scheduled_at": planned, "created_at": stamp.isoformat(),
            "request_id": request.request_id, "worker_build_sha": request.worker_build_sha,
            "trigger": request.trigger, "decision_ids": task["task"]["decision_ids"],
            "execution_status": "running", "artifact_status": "fresh" if run["pricing_complete"] and fresh == len(run["components"]) else "partial",
            "valid_count": fresh, "expected_count": len(run["components"])}
        digest = _append(conn, "attempt", request.occurrence_date + ":" + request.slot, attempt)
        return {"claimed": True, "duplicate": False, "attempt": attempt, "attempt_hash": digest, "run": run}
    return _operation(conn, request, "claim", write, before_commit)


def finish_local(conn, request: MachineFinish, *, before_commit=None):
    def write(check):
        task = _task(conn, request.occurrence_date, check)
        found = _attempt(conn, request.occurrence_date, request.slot, task, check)
        if found is None or found[1] != request.attempt_hash:
            raise MachineFault("machine_attempt_conflict", 409)
        attempt, _digest = found
        existing = _terminal(conn, request.occurrence_date, request.slot, found, task, check)
        if existing:
            if existing[0].get("outcome") != request.outcome:
                raise MachineFault("machine_result_conflict", 409)
            return {"result": existing[0], "result_hash": existing[1], "duplicate": True}
        # Finishing an ORIGINAL send remains allowed after source/Policy changes.
        if task is None or task["task_hash"] != attempt["task_hash"] or task["task"]["decision_ids"] != attempt["decision_ids"]:
            raise MachineFault("machine_integrity_unavailable")
        stamp = _clock()
        if stamp < datetime.fromisoformat(attempt["created_at"]):
            raise MachineFault("machine_clock_regressed")
        status = "sent" if request.outcome == "sent" else "failed"
        detail = {"machine_task_hash": attempt["task_hash"], "occurrence_id": request.occurrence_date}
        _notifications(conn, decision_ids=attempt["decision_ids"],
            scheduled_window=attempt["scheduled_window"], status=status, attempt_no=attempt["attempt_no"],
            natural_schedule=attempt["natural_schedule"], occurred_at=stamp,
            error_class=None if status == "sent" else request.outcome, detail=detail,
            _machine_binding=(request.occurrence_date, attempt["task_hash"]))
        result = {"schema": "owner-machine-result-1", "occurrence_id": request.occurrence_date,
            "analysis_request_id": attempt["analysis_request_id"], "created_at": stamp.isoformat(),
            "attempt_hash": request.attempt_hash, "outcome": request.outcome,
            "execution_status": "succeeded" if status == "sent" else "failed",
            "artifact_status": attempt["artifact_status"], "valid_count": attempt["valid_count"],
            "expected_count": attempt["expected_count"], "scheduled_at": attempt["scheduled_at"],
            "started_at": attempt["created_at"], "finished_at": stamp.isoformat(),
            "trigger": attempt["trigger"], "worker_build_sha": attempt["worker_build_sha"],
            "artifact_digest": task["task"]["run_response_hash"]}
        digest = _append(conn, "result", request.occurrence_date + ":" + request.slot, result)
        return {"result": result, "result_hash": digest, "duplicate": False}
    return _transaction(conn, write, immediate=True, before_commit=before_commit)


def read_status_local(conn, occurrence):
    def read(check):
        task = _task(conn, occurrence, check)
        attempts = []
        for slot in ("14:30", "14:40"):
            found = _attempt(conn, occurrence, slot, task, check)
            if found is None and _load(conn, "result", occurrence + ":" + slot) is not None:
                raise MachineFault("machine_integrity_unavailable")
            if found:
                terminal = _terminal(conn, occurrence, slot, found, task, check)
                attempts.append({"attempt": found[0], "attempt_hash": found[1],
                                 "result": terminal[0] if terminal else None,
                                 "result_hash": terminal[1] if terminal else None})
        identifiers = conn.execute("SELECT CASE WHEN typeof(record_id)='text' AND length(CAST(record_id AS BLOB))<=128 "
            "THEN record_id ELSE NULL END FROM owner_machine_journal WHERE kind='observation' AND occurrence_id=? "
            "ORDER BY created_at,record_id LIMIT 201", (occurrence,)).fetchall()
        if len(identifiers) > 200:
            raise MachineFault("machine_capacity_exhausted")
        observations = []
        for row in identifiers:
            check()
            found = _load(conn, "observation", row[0])
            if found is None:
                raise MachineFault("machine_integrity_unavailable")
            value, digest = found
            if value.get("schema") == "owner-machine-evidence-receipt-1":
                # Market-ingestion receipts are not Cron execution success.
                # Verify their independent closed contract before excluding
                # them from prepare/claim observations and natural-run proof.
                from service.owner_machine_evidence import _checked_receipt
                _checked_receipt(conn, value, row[0], check)
                continue
            fields = {"schema", "occurrence_id", "analysis_request_id", "created_at", "input_hash", "request_id",
                "phase", "trigger", "slot", "worker_build_sha", "scheduled_at", "started_at", "finished_at",
                "execution_status", "artifact_status", "valid_count", "expected_count", "reason", "artifact_digest",
                "http_status", "output_hash"}
            if (set(value) != fields or value["schema"] != "owner-machine-observation-1"
                    or value["phase"] not in {"prepare", "claim"} or value["trigger"] not in {"manual", "scheduled"}
                    or value["slot"] not in {"14:30", "14:40"}
                    or value["execution_status"] not in {"blocked", "skipped", "succeeded"}
                    or value["artifact_status"] not in {"fresh", "partial", "unavailable"}
                    or type(value["worker_build_sha"]) is not str or not re.fullmatch(r"[0-9a-f]{40}", value["worker_build_sha"])
                    or type(value["input_hash"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", value["input_hash"])
                    or type(value["request_id"]) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}", value["request_id"])
                    or row[0] != stable_id("machine_obs", {"occurrence": occurrence, "phase": value["phase"], "request_id": value["request_id"]})
                    or value["scheduled_at"] != f"{occurrence}T{value['slot']}:00+08:00"
                    or value["finished_at"] != value["created_at"]):
                raise MachineFault("machine_integrity_unavailable")
            if type(value["reason"]) is not str or not re.fullmatch(r"[a-z][a-z0-9_]{1,79}", value["reason"]):
                raise MachineFault("machine_integrity_unavailable")
            if value["execution_status"] == "blocked":
                if value["output_hash"] is not None or type(value["http_status"]) is not int or value["http_status"] not in {409, 422, 503}:
                    raise MachineFault("machine_integrity_unavailable")
            elif (value["http_status"] != 200 or type(value["output_hash"]) is not str
                    or not re.fullmatch(r"[0-9a-f]{64}", value["output_hash"])):
                raise MachineFault("machine_integrity_unavailable")
            start, end = (datetime.fromisoformat(value[key]) for key in ("started_at", "finished_at"))
            if (start.tzinfo != timezone.utc or end.tzinfo != timezone.utc or end < start or end > _clock()
                    or start.isoformat() != value["started_at"] or end.isoformat() != value["finished_at"]):
                raise MachineFault("machine_integrity_unavailable")
            if value["artifact_status"] == "unavailable":
                if any(value[key] is not None for key in ("valid_count", "expected_count", "artifact_digest")):
                    raise MachineFault("machine_integrity_unavailable")
            elif (type(value["valid_count"]) is not int or type(value["expected_count"]) is not int
                    or not 0 <= value["valid_count"] <= value["expected_count"] <= 100
                    or type(value["artifact_digest"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", value["artifact_digest"])):
                raise MachineFault("machine_integrity_unavailable")
            observations.append({"observation": value, "observation_hash": digest})
        return {"schema": "owner-machine-status-1", "task": task, "attempts": attempts, "observations": observations}
    return _transaction(conn, read)
