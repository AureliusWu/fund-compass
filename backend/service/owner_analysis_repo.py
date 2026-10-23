"""Owner-confirmed source -> real immutable business snapshots, one transaction.

Only an explicit existing local analysis profile is supported. No connection,
schema, credential, market-data fetch, notification or retry is created here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import re
import sqlite3
import time
from typing import Callable

from database.owner_analysis_schema import verify_owner_analysis_schema
from models.owner_analysis import AnalysisValidationError, parse_owner_analysis_request
from models.v8 import (
    DecisionSnapshot, EvidenceSnapshot, HoldingVersion, PortfolioPolicy,
    canonical_json, payload_sha256, stable_id,
)
from service import owner_sync_repo as sync, repository_scopes as scopes, v8_repo
from service.owner_analysis_projection import OwnerProjectionError, project_fund_holdings
from strategy.decision_v2 import STRATEGY_VERSION, build_decision_snapshot, build_holding_version


ANALYSIS_STRATEGY_VERSION = STRATEGY_VERSION + "+owner-sync-1"
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_RUNS = 100_000
MAX_COMPONENTS = 100_000
TOTAL_SECONDS = 30.0
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z", re.ASCII)
_HASH = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_MESSAGES = {
    "invalid_analysis_request": "分析请求无效。",
    "analysis_source_conflict": "持仓同步版本已变化，请核对最新完整状态。",
    "analysis_source_empty": "当前没有可分析的基金记录。",
    "analysis_inputs_unavailable": "持仓或行情输入无法安全生成决策。",
    "analysis_evidence_unavailable": "所引用的基金证据不可用。",
    "analysis_policy_unavailable": "所引用的策略版本不可用。",
    "analysis_source_unavailable": "完整持仓来源无法核对。",
    "analysis_integrity_unavailable": "分析记录完整性无法核对。",
    "analysis_capacity_exhausted": "分析存储或输入容量已满，历史未被删除。",
    "analysis_storage_unavailable": "分析存储暂不可用。",
    "analysis_timeout": "分析未在本次预算内完成，请保留原请求标识。",
    "analysis_idempotency_conflict": "请求标识已用于另一份分析请求。",
}


@dataclass(frozen=True)
class AnalysisResult:
    status: int
    body: dict


@dataclass(frozen=True)
class AnalysisReconciliation:
    state: str
    request_id: str
    result: AnalysisResult | None = None


class _Fault(Exception):
    def __init__(self, code: str, status: int = 503):
        self.code, self.status = code, status
        super().__init__(code)


class _GuardFailure(Exception):
    def __init__(self, original: Exception):
        self.original = original
        super().__init__("Owner analysis authority changed")


def _json(value) -> str:
    # Preserve the complete sync source's native int/float/negative-zero image.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _business(model) -> dict:
    # The immutable V8 repositories have their own canonical numeric contract
    # (including signed-zero normalization). Do not apply it to raw Owner input.
    return json.loads(canonical_json(model))


def _bounded(raw: str) -> str:
    if type(raw) is not str or len(raw.encode("utf-8", errors="strict")) > MAX_JSON_BYTES:
        raise _Fault("analysis_capacity_exhausted")
    return raw


def _decode(raw):
    try:
        _bounded(raw)
        def pairs(items):
            out = {}
            for key, value in items:
                if key in out:
                    raise ValueError("duplicate key")
                out[key] = value
            return out
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")))
        if _json(value) != raw:
            raise ValueError("noncanonical record")
        return value
    except (TypeError, ValueError, UnicodeError, OverflowError, RecursionError):
        raise _Fault("analysis_integrity_unavailable") from None


def _clock(stamp: datetime | None = None) -> datetime:
    value = stamp or datetime.now(timezone.utc)
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise _Fault("analysis_integrity_unavailable")
    return value.astimezone(timezone.utc)


def _ready(conn):
    if not isinstance(conn, sqlite3.Connection) or conn.in_transaction:
        raise _Fault("analysis_storage_unavailable")
    try:
        if tuple(conn.execute("PRAGMA foreign_keys").fetchone()) != (1,):
            raise ValueError("foreign keys must already be enabled")
        verify_owner_analysis_schema(conn)
    except Exception:
        raise _Fault("analysis_storage_unavailable") from None


def _guard(before_commit: Callable | None):
    start = time.monotonic()
    if not math.isfinite(start):
        raise _Fault("analysis_timeout")
    def budget():
        now = time.monotonic()
        if not math.isfinite(now) or now < start or now - start > TOTAL_SECONDS:
            raise _Fault("analysis_timeout")
    def check():
        budget()
        if before_commit is not None:
            try:
                before_commit()
            except Exception as error:
                raise _GuardFailure(error) from None
        budget()
    return check


def _rollback(conn):
    try:
        conn.rollback()
    except Exception:
        pass  # A rollback/close exception cannot prove that a commit was absent.


def _source(conn, check) -> tuple[dict, str, str]:
    check()
    try:
        head = sync._head(conn)
        counts = conn.execute(
            "SELECT COUNT(*),COALESCE(SUM(length(CAST(sync_key AS BLOB))"
            "+length(CAST(payload_json AS BLOB))+length(CAST(field_revisions_json AS BLOB))),0) "
            "FROM owner_sync_records"
        ).fetchone()
        if type(counts[0]) is not int or counts[0] > sync.MAX_RECORDS or counts[1] > MAX_JSON_BYTES:
            raise _Fault("analysis_capacity_exhausted")
        if conn.execute(
            "SELECT 1 FROM owner_sync_changes c WHERE NOT EXISTS "
            "(SELECT 1 FROM owner_sync_records r WHERE r.sync_key=c.sync_key) LIMIT 1"
        ).fetchone() is not None:
            raise _Fault("analysis_source_unavailable")
        keys = conn.execute(
            "SELECT CASE WHEN typeof(sync_key)='text' AND length(CAST(sync_key AS BLOB))<=640 "
            "THEN sync_key ELSE NULL END FROM owner_sync_records ORDER BY sync_key LIMIT ?",
            (sync.MAX_RECORDS + 1,),
        ).fetchall()
        if len(keys) != counts[0] or any(type(row[0]) is not str for row in keys):
            raise _Fault("analysis_source_unavailable")
        records = []
        for row in keys:
            check()
            record = sync._record(conn, row[0], head)
            if record is None:
                raise _Fault("analysis_source_unavailable")
            records.append(record)
        source = {"schema": "owner-analysis-source-1", "revision": head, "records": records}
        raw = _bounded(_json(source))
        return source, raw, _sha(raw)
    except (_Fault, _GuardFailure):
        raise
    except Exception:
        raise _Fault("analysis_source_unavailable") from None


def _checked_source(raw: str, revision: int, sha: str) -> dict:
    source = _decode(raw)
    if (type(source) is not dict or set(source) != {"schema", "revision", "records"}
            or source["schema"] != "owner-analysis-source-1" or type(source["revision"]) is not int
            or not 0 <= source["revision"] <= sync.MAX_SAFE_REVISION or source["revision"] != revision
            or _sha(raw) != sha or type(source["records"]) is not list or len(source["records"]) > sync.MAX_RECORDS):
        raise _Fault("analysis_integrity_unavailable")
    keys = []
    try:
        for record in source["records"]:
            sync._validate_record(record, upper=revision)
            keys.append(record["key"])
    except Exception:
        raise _Fault("analysis_integrity_unavailable") from None
    if keys != sorted(set(keys)):
        raise _Fault("analysis_integrity_unavailable")
    return source


_REFERENCES = {
    "evidence": ("evidence_snapshots", "evidence_id", EvidenceSnapshot, v8_repo._evidence_identity, "ev"),
    "policy": ("portfolio_policy_versions", "policy_version", PortfolioPolicy, v8_repo._policy_identity, "pol"),
    "holding": ("holding_versions", "holding_version", HoldingVersion, v8_repo._holding_identity, "hold"),
    "decision": ("decision_snapshots", "decision_id", DecisionSnapshot, v8_repo._decision_identity, "dec"),
}


def _reference(conn, kind, identifier):
    table, column, model_type, identity, prefix = _REFERENCES[kind]
    try:
        row = conn.execute(
            f"SELECT CASE WHEN length(CAST(payload_json AS BLOB))<=? THEN payload_json ELSE NULL END,"
            f"CASE WHEN typeof(payload_sha256)='text' AND length(CAST(payload_sha256 AS BLOB))=64 "
            f"THEN payload_sha256 ELSE NULL END FROM {table} WHERE {column}=?", (MAX_JSON_BYTES, identifier),
        ).fetchone()
        if row is None:
            raise ValueError("reference unavailable")
        model = model_type.model_validate(_decode(row[0]))
        if _json(model.model_dump(mode="json")) != row[0] or getattr(model, column) != identifier:
            raise ValueError("reference representation mismatch")
        v8_repo._assert_id(identifier, stable_id(prefix, identity(model)), kind)
        semantic = (v8_repo._without(model.model_dump(mode="python"), "created_at")
                    if kind == "decision" else identity(model))
        if row[1] != payload_sha256(semantic):
            raise ValueError("reference hash mismatch")
        v8_repo._acceptance_preflight(model, scope=scopes.PRODUCTION)
        v8_repo._acceptance_guard(conn, kind, model, scope=scopes.PRODUCTION)
        return model
    except Exception:
        code = "analysis_policy_unavailable" if kind == "policy" else "analysis_evidence_unavailable"
        if kind not in {"evidence", "policy"}:
            code = "analysis_integrity_unavailable"
        raise _Fault(code, 409 if kind in {"evidence", "policy"} else 503) from None


def _neutral(decision: DecisionSnapshot, is_held: bool) -> DecisionSnapshot:
    action = "hold" if is_held else "watch"
    return DecisionSnapshot.model_validate({**decision.model_dump(mode="python"),
        "action": action, "confidence": min(decision.confidence, 30), "strength": min(decision.strength, 30),
        "summary": "持仓或行情数据尚不完整，暂不形成当前操作建议。",
        "reason_codes": ["ACTION_" + action.upper(),
                         *(code for code in decision.reason_codes if not code.startswith("ACTION_")),
                         "OWNER_INPUTS_INCOMPLETE"],
        "reasons": [*decision.reasons, "完整基金组合的持仓或定价依据不足。"],
        "risks": [*decision.risks, "不能将部分组合金额当作完整权重分母。"],
        "invalidation_codes": ["OWNER_INPUTS_CHANGED"],
        "invalidation_conditions": ["持仓同步版本、策略或行情证据变化后须重新生成。"],
        "position_guidance": None,
    })


def _run_id(request, source_hash: str, stamp: datetime, strategy_version: str) -> str:
    return stable_id("owner_analysis", {"request_id": request.request_id, "request_hash": request.request_hash(),
        "source_hash": source_hash, "created_at": stamp, "policy_version": request.policy_version,
        "strategy_version": strategy_version})


def _plan(conn, request, source: dict, source_hash: str, stamp: datetime, check):
    check()
    codes = sorted({row["key"][:6] for row in source["records"] if not row["deleted"] and row["kind"] != "manual_asset"})
    if not codes:
        raise _Fault("analysis_source_empty", 409)
    if codes != sorted(item.code for item in request.evidence):
        raise _Fault("analysis_source_conflict", 409)
    policy = _reference(conn, "policy", request.policy_version)
    if policy.created_at > stamp or policy.effective_at > stamp:
        raise _Fault("analysis_policy_unavailable", 409)
    evidence = {}
    for item in request.evidence:
        check()
        value = _reference(conn, "evidence", item.evidence_id)
        if value.fund_code != item.code or value.created_at > stamp or value.market_time and value.market_time > stamp:
            raise _Fault("analysis_evidence_unavailable", 409)
        evidence[item.code] = value
    try:
        projection = project_fund_holdings(source["records"], evidence, stamp)
    except OwnerProjectionError:
        raise _Fault("analysis_inputs_unavailable", 409) from None
    run_id = _run_id(request, source_hash, stamp, ANALYSIS_STRATEGY_VERSION)
    plans, components = [], []
    for row in projection.holdings:
        check()
        holding = build_holding_version(row.code, is_held=row.is_held, shares=row.shares, cost=row.cost,
            market_value=row.market_value, account=None, current_weight=row.current_weight,
            target_weight=row.target_weight, updated_at=None, source=run_id, created_at=stamp)
        proof = evidence[row.code]
        decision = build_decision_snapshot(proof, holding, policy,
            strategy_version=ANALYSIS_STRATEGY_VERSION, created_at=stamp)
        if (not projection.pricing_complete or stamp - proof.created_at > timedelta(days=7)
                or proof.estimate_status in {"stale", "unavailable"}):
            decision = _neutral(decision, row.is_held)
        plans.append((holding, decision))
        components.append({"code": row.code, "account_count": row.account_count,
            "holding": _business(holding), "evidence": _business(proof),
            "decision": _business(decision)})
    body = {"schema": "owner-analysis-run-1", "request_id": request.request_id,
        "request_hash": request.request_hash(), "run_id": run_id,
        "source": {"revision": source["revision"], "sha256": source_hash,
                   "record_count": len(source["records"]), "scope": projection.scope},
        "policy": _business(policy), "strategy_version": ANALYSIS_STRATEGY_VERSION,
        "created_at": stamp.isoformat(), "pricing_complete": projection.pricing_complete,
        "unavailable_codes": list(projection.unavailable_codes), "components": components}
    return body, _bounded(_json(body)), plans


_RUN_COLUMNS = ("request_id", "request_hash", "request_json", "run_id", "source_revision", "source_hash",
                "source_json", "policy_version", "strategy_version", "created_at", "response_json", "response_hash")


def _historical_body(conn, data, request, source, stamp, check):
    """Verify actual immutable outputs without rerunning today's strategy.

    The original source, reference models, semantic IDs and task mappings stay
    bound. A rules upgrade must not rewrite or make prior receipts unreadable.
    """
    body = _decode(data["response_json"])
    fields = {"schema", "request_id", "request_hash", "run_id", "source", "policy", "strategy_version",
              "created_at", "pricing_complete", "unavailable_codes", "components"}
    version = data["strategy_version"]
    if (type(body) is not dict or set(body) != fields or body["schema"] != "owner-analysis-run-1"
            or type(version) is not str or not 1 <= len(version) <= 120
            or body["strategy_version"] != version or body["request_id"] != request.request_id
            or body["request_hash"] != request.request_hash() or body["created_at"] != stamp.isoformat()
            or data["policy_version"] != request.policy_version
            or body["run_id"] != data["run_id"] or body["run_id"] != _run_id(request, data["source_hash"], stamp, version)
            or _sha(data["response_json"]) != data["response_hash"]
            or type(body["pricing_complete"]) is not bool):
        raise ValueError("historical run binding mismatch")
    if body["source"] != {"revision": source["revision"], "sha256": data["source_hash"],
                          "record_count": len(source["records"]), "scope": "fund_only"}:
        raise ValueError("historical source mismatch")
    policy = _reference(conn, "policy", request.policy_version)
    if (_json(body["policy"]) != _json(_business(policy))
            or policy.created_at > stamp or policy.effective_at > stamp):
        raise ValueError("historical policy mismatch")
    codes = sorted({row["key"][:6] for row in source["records"] if not row["deleted"] and row["kind"] != "manual_asset"})
    references = {item.code: item.evidence_id for item in request.evidence}
    components, unavailable = body["components"], body["unavailable_codes"]
    if (not codes or codes != sorted(references) or type(components) is not list or len(components) != len(codes)
            or type(unavailable) is not list or any(type(code) is not str or code not in codes for code in unavailable)
            or unavailable != sorted(set(unavailable)) or body["pricing_complete"] != (len(unavailable) == 0)):
        raise ValueError("historical coverage mismatch")
    expected = []
    for code, component in zip(codes, components):
        check()
        if (type(component) is not dict or set(component) != {"code", "account_count", "holding", "evidence", "decision"}
                or component["code"] != code or type(component["account_count"]) is not int):
            raise ValueError("historical component shape mismatch")
        holding = HoldingVersion.model_validate(component["holding"])
        decision = DecisionSnapshot.model_validate(component["decision"])
        proof = _reference(conn, "evidence", references[code])
        actual_holding = _reference(conn, "holding", holding.holding_version)
        actual_decision = _reference(conn, "decision", decision.decision_id)
        accounts = sum(row["kind"] == "holding" and not row["deleted"] and row["key"][:6] == code for row in source["records"])
        if (component["account_count"] != accounts or holding.user_state != ("held" if accounts else "unheld")
                or holding.fund_code != code or proof.fund_code != code or decision.fund_code != code
                or decision.holding_version != holding.holding_version or decision.evidence_id != proof.evidence_id
                or decision.policy_version != policy.policy_version or decision.strategy_version != version
                or holding.source != body["run_id"] or holding.created_at != stamp or decision.created_at != stamp
                or holding.updated_at is not None or holding.account is not None
                or proof.created_at > stamp or proof.market_time and proof.market_time > stamp
                or _json(component["holding"]) != _json(_business(actual_holding))
                or _json(component["decision"]) != _json(_business(actual_decision))
                or _json(component["evidence"]) != _json(_business(proof))):
            raise ValueError("historical business lineage mismatch")
        if not body["pricing_complete"] and (
                holding.current_weight is not None or decision.action != ("hold" if accounts else "watch")
                or decision.position_guidance is not None or "OWNER_INPUTS_INCOMPLETE" not in decision.reason_codes):
            raise ValueError("historical partial pricing mismatch")
        expected.append((request.request_id, code, holding.holding_version, proof.evidence_id, decision.decision_id))
    component_limits = {"request_id": 128, "fund_code": 6, "holding_version": 69,
                        "evidence_id": 67, "decision_id": 68}
    columns = ",".join(
        f"CASE WHEN typeof({name})='text' AND length(CAST({name} AS BLOB))<={limit} THEN {name} ELSE NULL END"
        for name, limit in component_limits.items())
    actual = [tuple(item) for item in conn.execute(
        f"SELECT {columns} FROM owner_analysis_components "
        "WHERE request_id=? ORDER BY fund_code LIMIT 101", (request.request_id,),
    ).fetchall()]
    if actual != expected:
        raise ValueError("historical component mapping mismatch")
    return body


def _stored(conn, identifier: str, request_hash: str, check) -> AnalysisResult | None:
    check()
    limits = {"request_json": 16 * 1024, "source_json": MAX_JSON_BYTES, "response_json": MAX_JSON_BYTES,
              "request_id": 128, "request_hash": 64, "run_id": 128, "source_hash": 64,
              "policy_version": 68, "strategy_version": 480, "created_at": 128, "response_hash": 64}
    columns = ",".join(name if name == "source_revision" else
        f"CASE WHEN typeof({name})='text' AND length(CAST({name} AS BLOB))<={limits[name]} THEN {name} ELSE NULL END"
        for name in _RUN_COLUMNS)
    row = conn.execute(f"SELECT {columns} FROM owner_analysis_runs WHERE request_id=?", (identifier,)).fetchone()
    if row is None:
        return None
    data = dict(zip(_RUN_COLUMNS, row))
    if data["request_hash"] != request_hash:
        raise _Fault("analysis_idempotency_conflict", 409)
    try:
        request = parse_owner_analysis_request(data["request_json"])
        if request.request_id != identifier or request.request_hash() != request_hash or request.canonical_body() != data["request_json"]:
            raise ValueError("request mismatch")
        source = _checked_source(data["source_json"], data["source_revision"], data["source_hash"])
        stamp = _clock(datetime.fromisoformat(data["created_at"]))
        if stamp.isoformat() != data["created_at"] or stamp > _clock():
            raise ValueError("invalid stored clock")
        body = _historical_body(conn, data, request, source, stamp, check)
        current, _raw, current_hash = _source(conn, check)
        if current["revision"] < source["revision"]:
            raise ValueError("source revision regressed")
        # Source equality at this read snapshot is not a current-action permit:
        # active policy/strategy, evidence freshness and UI gates are separate.
        return AnalysisResult(200, {"run": body,
            "source_current": current["revision"] == source["revision"] and current_hash == data["source_hash"]})
    except (_Fault, _GuardFailure):
        raise
    except Exception:
        raise _Fault("analysis_integrity_unavailable") from None


def create_analysis_local(conn, raw: bytes | str, *, before_commit: Callable | None = None) -> AnalysisResult:
    try:
        request = parse_owner_analysis_request(raw)
    except AnalysisValidationError:
        return AnalysisResult(422, {"error": {"code": "invalid_analysis_request", "message": _MESSAGES["invalid_analysis_request"]}})
    active = False
    try:
        check = _guard(before_commit)
        check(); _ready(conn); check()
        conn.execute("BEGIN IMMEDIATE"); active = True
        verify_owner_analysis_schema(conn); check()
        existing = _stored(conn, request.request_id, request.request_hash(), check)
        if existing is not None:
            check(); conn.commit(); active = False; check()
            return existing
        source, source_raw, source_hash = _source(conn, check)
        if source["revision"] != request.expected_revision:
            raise _Fault("analysis_source_conflict", 409)
        body, response_raw, plans = _plan(conn, request, source, source_hash, _clock(), check)
        counts = [conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("owner_analysis_runs", "owner_analysis_components")]
        if counts[0] >= MAX_RUNS or counts[1] + len(plans) > MAX_COMPONENTS:
            raise _Fault("analysis_capacity_exhausted")
        check()
        for holding, decision in plans:
            check()
            v8_repo._save_holding_in_transaction(conn, holding, scope=scopes.PRODUCTION)
            v8_repo._save_decision_in_transaction(conn, decision, scope=scopes.PRODUCTION)
        conn.execute("INSERT INTO owner_analysis_runs(" + ",".join(_RUN_COLUMNS) + ") VALUES(" + ",".join("?" for _ in _RUN_COLUMNS) + ")",
            (request.request_id, request.request_hash(), request.canonical_body(), body["run_id"], source["revision"],
             source_hash, source_raw, request.policy_version, ANALYSIS_STRATEGY_VERSION, body["created_at"], response_raw, _sha(response_raw)))
        for holding, decision in plans:
            check()
            conn.execute("INSERT INTO owner_analysis_components(request_id,fund_code,holding_version,evidence_id,decision_id) VALUES(?,?,?,?,?)",
                (request.request_id, holding.fund_code, holding.holding_version, decision.evidence_id, decision.decision_id))
        result = _stored(conn, request.request_id, request.request_hash(), check)
        if result is None or result.body != {"run": body, "source_current": True}:
            raise _Fault("analysis_integrity_unavailable")
        check(); conn.commit(); active = False; check()
        return result
    except _GuardFailure as error:
        if active:
            _rollback(conn)
        raise error.original from None
    except _Fault as error:
        if active:
            _rollback(conn)
        return AnalysisResult(error.status, {"error": {"code": error.code, "message": _MESSAGES[error.code]}})
    except Exception:
        if active:
            _rollback(conn)
        # In particular, a real authorization exception from the callback must
        # reach the router; only that layer can distinguish it from driver data.
        raise


def reconcile_analysis_local(conn, request_id: str, request_hash: str) -> AnalysisReconciliation:
    active = False
    try:
        if type(request_id) is not str or not _ID.fullmatch(request_id) or type(request_hash) is not str or not _HASH.fullmatch(request_hash):
            raise ValueError("invalid receipt identity")
        check = _guard(None)
        _ready(conn); conn.execute("BEGIN"); active = True
        verify_owner_analysis_schema(conn)
        result = _stored(conn, request_id, request_hash, check)
        check(); conn.commit(); active = False; check()
        return AnalysisReconciliation("matched" if result is not None else "absent", request_id, result)
    except Exception:
        if active:
            _rollback(conn)
        return AnalysisReconciliation("unavailable", request_id if type(request_id) is str and _ID.fullmatch(request_id) else "invalid")
