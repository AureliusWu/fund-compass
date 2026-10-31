"""Complete-source market ingestion on the explicit local machine profile.

No fetching, credential discovery or second database connection. Public detail
must already be cached in this database; external Worker quotes do NOT warm
that cache. Evidence and the original-byte receipt commit together.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
import math
import re

from models.owner_machine import MachineEvidence
from models.v8 import stable_id
from service import owner_analysis_repo as analysis, owner_machine_repo as machine
from service import repo, v8_decisions, v8_repo
from service import overseas_evidence
from strategy.decision_v2 import HISTORICAL_OUTCOME_HORIZON, STRATEGY_VERSION

_DETAIL_COLUMNS = (
    "code", "name", "type", "scale", "buy_rate", "source_rate", "ret_1m", "ret_6m", "ret_1y", "ret_3y",
    "rank_in_type", "rank_total", "manager", "manager_id", "manager_worktime", "latest_nav", "latest_nav_date",
    "source", "updated_at",
)
_RECEIPT_FIELDS = {"schema", "occurrence_id", "analysis_request_id", "created_at", "request_id", "request_hash",
                   "trigger", "slot", "worker_build_sha", "response"}
_RESPONSE_FIELDS = {"schema", "revision", "source_hash", "policy_version", "evidence"}
MAX_HISTORY_ROWS = 10_000
MAX_HISTORY_BYTES = 8 * 1024 * 1024


def _cached_detail(conn, code, stamp):
    # Guard bytes before materialization, including malformed non-TEXT values.
    size_sql = "+".join(f"COALESCE(length(CAST({column} AS BLOB)),0)" for column in _DETAIL_COLUMNS)
    size = conn.execute(f"SELECT {size_sql} FROM fund_detail WHERE code=?", (code,)).fetchone()
    if size is None or type(size[0]) is not int or not 1 <= size[0] <= 16 * 1024:
        raise machine.MachineFault("machine_detail_unavailable")
    row = conn.execute("SELECT " + ",".join(_DETAIL_COLUMNS) + " FROM fund_detail WHERE code=?", (code,)).fetchone()
    detail = dict(row)
    try:
        updated = datetime.fromisoformat(detail["updated_at"])
        if updated.tzinfo is None or updated > stamp or stamp - updated > repo.STALE_MAX_AGE:
            raise ValueError("cache time unavailable")
        latest_date = date.fromisoformat(detail["latest_nav_date"])
        today = stamp.astimezone(machine.BEIJING).date()
        if (latest_date.isoformat() != detail["latest_nav_date"] or latest_date > today
                or (today - latest_date).days > 7):
            raise ValueError("NAV date unavailable")
        for column in ("scale", "buy_rate", "source_rate", "ret_1m", "ret_6m", "ret_1y", "ret_3y",
                       "rank_in_type", "rank_total", "latest_nav"):
            value = detail[column]
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
                raise ValueError("cache number unavailable")
        if detail["latest_nav"] is None or detail["latest_nav"] <= 0:
            raise ValueError("NAV unavailable")
        if type(detail["name"]) is not str or not detail["name"]:
            raise ValueError("fund identity unavailable")
        history = conn.execute(
            "SELECT CASE WHEN length(CAST(date AS BLOB))<=32 THEN date ELSE NULL END AS date,"
            "CASE WHEN typeof(nav) IN ('integer','real') THEN nav ELSE NULL END AS nav,"
            "CASE WHEN typeof(ac_return) IN ('integer','real') THEN ac_return ELSE NULL END AS ac_return "
            "FROM nav_history WHERE code=? ORDER BY date DESC LIMIT ?", (code, repo.HIST_KEEP)).fetchall()
        detail["nav_history"] = []
        for item in reversed(history):
            value = dict(item)
            when = date.fromisoformat(value["date"])
            if when.isoformat() != value["date"] or when > latest_date:
                raise ValueError("history date unavailable")
            if value["nav"] is None or value["nav"] <= 0 or not math.isfinite(value["nav"]):
                raise ValueError("history NAV unavailable")
            if value["ac_return"] is not None and not math.isfinite(value["ac_return"]):
                raise ValueError("history return unavailable")
            detail["nav_history"].append(value)
        latest_rows = [item for item in detail["nav_history"] if item["date"] == detail["latest_nav_date"]]
        if latest_rows and not math.isclose(latest_rows[0]["nav"], detail["latest_nav"], rel_tol=1e-8, abs_tol=1e-8):
            raise ValueError("cache NAV projections disagree")
        repo._fill_detail_type(conn, detail)
        age = stamp - updated.astimezone(timezone.utc)
        detail.update(cached=True, stale=age >= repo.DETAIL_TTL, data_age_hours=round(age.total_seconds() / 3600, 1))
        return detail
    except (TypeError, ValueError, OverflowError):
        raise machine.MachineFault("machine_detail_unavailable") from None


def _receipt_id(occurrence, request_id):
    return stable_id("machine_ev", {"occurrence": occurrence, "request_id": request_id})


def _history_budget(conn, codes, stamp):
    # The same predicates as the shared summary. Reject the complete batch on
    # exhaustion; never truncate outcomes into a misleading sample statistic.
    row = conn.execute(
        "SELECT COUNT(*),COALESCE(SUM(CASE WHEN typeof(o.payload_json)='text' THEN "
        "length(CAST(o.payload_json AS BLOB)) ELSE ? END),0) FROM production_outcome_evaluations o "
        "JOIN production_decision_snapshots d ON d.decision_id=o.decision_id "
        f"WHERE d.fund_code IN ({','.join('?' for _ in codes)}) AND d.strategy_version=? "
        "AND o.evaluation_kind='horizon' AND o.horizon=? AND o.evaluation_date<? "
        "AND julianday(o.created_at)<julianday(?) AND julianday(d.created_at)<julianday(?)",
        (MAX_HISTORY_BYTES + 1, *codes, STRATEGY_VERSION, HISTORICAL_OUTCOME_HORIZON,
         stamp.astimezone(machine.BEIJING).date().isoformat(), stamp.isoformat(), stamp.isoformat())).fetchone()
    if (type(row[0]) is not int or type(row[1]) is not int
            or row[0] > MAX_HISTORY_ROWS or row[1] > MAX_HISTORY_BYTES):
        raise machine.MachineFault("machine_evidence_capacity_exhausted")


def _checked_receipt(conn, value, record_id, check):
    try:
        if (type(value) is not dict or set(value) != _RECEIPT_FIELDS
                or value["schema"] != "owner-machine-evidence-receipt-1" or value["analysis_request_id"] is not None
                or type(value["request_id"]) is not str
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}", value["request_id"])
                or _receipt_id(value["occurrence_id"], value["request_id"]) != record_id
                or type(value["request_hash"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", value["request_hash"])
                or type(value["worker_build_sha"]) is not str or not re.fullmatch(r"[0-9a-f]{40}", value["worker_build_sha"])
                or value["trigger"] not in {"scheduled", "manual"} or value["slot"] not in {"14:30", "14:40"}):
            raise ValueError("receipt identity")
        from models.owner_machine import MachineInvocation
        invocation = MachineInvocation(**{key: value[key] for key in
            ("occurrence_id", "request_id", "trigger", "slot", "worker_build_sha") if key != "occurrence_id"},
            occurrence_date=value["occurrence_id"])
        stamp = datetime.fromisoformat(value["created_at"])
        if stamp.tzinfo != timezone.utc or stamp.isoformat() != value["created_at"] or stamp > machine._clock():
            raise ValueError("receipt time")
        machine._window(invocation, stamp)
        response = value["response"]
        if (type(response) is not dict or set(response) != _RESPONSE_FIELDS or response["schema"] != "owner-machine-evidence-1"
                or type(response["revision"]) is not int or not 0 <= response["revision"] <= analysis.sync.MAX_SAFE_REVISION
                or type(response["source_hash"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", response["source_hash"])
                or type(response["policy_version"]) is not str or not re.fullmatch(r"pol_[0-9a-f]{64}", response["policy_version"])
                or type(response["evidence"]) is not list or not 1 <= len(response["evidence"]) <= 100):
            raise ValueError("receipt response")
        policy = analysis._reference(conn, "policy", response["policy_version"])
        if policy.created_at > stamp or policy.effective_at > stamp:
            raise ValueError("receipt policy")
        codes = []
        for item in response["evidence"]:
            check()
            if type(item) is not dict or set(item) != {"code", "evidence_id"}:
                raise ValueError("receipt evidence")
            if type(item["code"]) is not str or not re.fullmatch(r"[0-9]{6}", item["code"]):
                raise ValueError("receipt fund")
            if type(item["evidence_id"]) is not str or not re.fullmatch(r"ev_[0-9a-f]{64}", item["evidence_id"]):
                raise ValueError("receipt reference")
            proof = analysis._reference(conn, "evidence", item["evidence_id"])
            if proof.fund_code != item["code"] or proof.created_at > stamp:
                raise ValueError("receipt evidence identity")
            codes.append(item["code"])
        if codes != sorted(set(codes)):
            raise ValueError("receipt complete set")
        return response
    except (machine.MachineFault, analysis._GuardFailure):
        raise
    except Exception:
        raise machine.MachineFault("machine_integrity_unavailable") from None


def _find_receipt(conn, occurrence, request_id, request_hash, check):
    identifier = _receipt_id(occurrence, request_id)
    found = machine._load(conn, "observation", identifier)
    if found is None:
        return None
    response = _checked_receipt(conn, found[0], identifier, check)
    if found[0]["request_hash"] != request_hash:
        raise machine.MachineFault("machine_invocation_conflict", 409)
    return response


def read_evidence_receipt_local(conn, occurrence, request_id, request_hash, *, before_read=None):
    def read(check):
        result = _find_receipt(conn, occurrence, request_id, request_hash, check)
        if result is None:
            # Missing is only a read observation, never a replay permit.
            raise machine.MachineFault("machine_evidence_receipt_missing", 404)
        return result
    return machine._transaction(conn, read, before_commit=before_read)


def ingest_evidence_local(conn, request: MachineEvidence, *, before_commit=None):
    request_hash = request.request_hash()
    def write(check):
        existing = _find_receipt(conn, request.occurrence_date, request.request_id, request_hash, check)
        if existing is not None:
            return existing
        stamp = machine._clock()
        machine._window(request, stamp)
        source, _raw, digest, codes = machine._source(conn, check)
        if (source["revision"] != request.expected_revision or digest != request.source_hash
                or codes != [item.code for item in request.observations]):
            raise machine.MachineFault("machine_source_conflict", 409)
        if machine._policy(conn, stamp, check).policy_version != request.policy_version:
            raise machine.MachineFault("machine_policy_changed", 409)
        _history_budget(conn, codes, stamp)
        check()
        # One bounded artifact per whole request, never one file read per fund.
        # It may enrich same-model accuracy, never supply today's prediction.
        artifact = overseas_evidence.load_artifact() if any(
            item.estimate_context.kind == "qdii_next_nav_estimate" for item in request.observations) else {}
        def overseas_resolver(detail, at):
            return overseas_evidence._resolve_for_detail(detail, at, artifact)
        plans = []
        # Complete validation/planning precedes the first Evidence append.
        for item in request.observations:
            check()
            detail = _cached_detail(conn, item.code, stamp)
            history = v8_repo._historical_outcome_summary(conn, item.code, STRATEGY_VERSION,
                at=stamp, horizon=HISTORICAL_OUTCOME_HORIZON)
            context = item.estimate_context.model_dump(mode="python")
            # The business Evidence does not retain intraday value_date. Check
            # that axis before projection so a current quote timestamp cannot
            # turn a future/old valuation date into today's fresh observation.
            if context["kind"] == "intraday_estimate" and context.get("value_date") != stamp.astimezone(machine.BEIJING).date().isoformat():
                context = v8_decisions._unavailable_context(context, "value_date_mismatch")
            plans.append(v8_decisions._build_evidence(detail,
                estimate_context=context, created_at=stamp,
                historical_outcome_summary=history, overseas_resolver=overseas_resolver))
        references = []
        for candidate in plans:
            check()
            proof = v8_repo._save_evidence_in_transaction(conn, candidate)
            references.append({"code": proof.fund_code, "evidence_id": proof.evidence_id})
        response = {"schema": "owner-machine-evidence-1", "revision": request.expected_revision,
                    "source_hash": request.source_hash, "policy_version": request.policy_version, "evidence": references}
        receipt = {"schema": "owner-machine-evidence-receipt-1", "occurrence_id": request.occurrence_date,
            "analysis_request_id": None, "created_at": stamp.isoformat(), "request_id": request.request_id,
            "request_hash": request_hash, "trigger": request.trigger, "slot": request.slot,
            "worker_build_sha": request.worker_build_sha, "response": response}
        machine._append(conn, "observation", _receipt_id(request.occurrence_date, request.request_id), receipt)
        return response
    return machine._transaction(conn, write, immediate=True, before_commit=before_commit)
