r"""司南基金 后端入口（FastAPI）。

本地启动（建议 Python 3.12）：
    cd backend
    python -m venv .venv\Scripts\activate   # Windows
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

启动阶段只初始化本地 SQLite 表结构，不抓取第三方数据、不导入基金全集。
基金全集需要时通过 POST /api/admin/refresh-universe 手动刷新，避免冷启动被网络请求拖慢。
"""
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from database.db import init_db, persistence_status
from models.api import (
    HealthResponse, PortfolioDecisionRequest, PortfolioDecisionResponse,
    PortfolioLabRequest, V8DecisionBatchRequest,
    V8NotificationEventRequest, V8OutcomeSettleRequest, V8PolicyRequest, WatchlistRequest,
)
from service import eastmoney, repo, v8_decisions, v8_repo
from service.security import require_admin, require_worker_or_admin
from strategy import backtest, decide_fund, score_fund, timing_signal
from strategy.calibration import calibrate
from strategy.index_valuation import status as index_valuation_status
from strategy.portfolio import decide_portfolio
from strategy.portfolio_lab import analyze_portfolio
from strategy.decision_v2 import build_portfolio_policy
from strategy.registry import registry_summary

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
log = logging.getLogger(__name__)

NAV_TAIL = 800  # 返回给前端的净值条数（≈3年，供走势图 / 定投回放 / 指标计算）
STARTED_AT = datetime.now(timezone.utc).isoformat()


def _deployment_status() -> dict:
    """Expose only a validated source commit, never arbitrary environment text."""
    raw_commit = os.environ.get("RENDER_GIT_COMMIT", "").strip().lower()
    commit = raw_commit if re.fullmatch(r"[0-9a-f]{40}", raw_commit) else None
    return {
        "platform": "render" if os.environ.get("RENDER") == "true" else "local",
        "commit": commit,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 冷启动只做本地建表，绝不在启动路径里访问第三方数据源。
    init_db()
    # Persist the deterministic default policy during startup so every public
    # GET remains a genuine read and protected decision writes can reference a
    # real immutable policy row.
    v8_repo.ensure_default_policy()
    if repo.universe_count() == 0:
        repo.import_universe_artifact()
    yield


app = FastAPI(title="司南基金 API", version="7.0.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://aureliuswu.github.io",
    ],
    allow_methods=["*"],
    allow_headers=["*"]
)


def fund_detail_dep(code: str, force: bool = Query(False)) -> dict:
    """统一的详情取数依赖：命中缓存或抓取，失败转 404。

    四个基金端点此前各自重复一遍 try/except，收口到这里后端点只声明
    `detail: dict = Depends(fund_detail_dep)` 即可，详情逻辑只有一处。
    """
    try:
        return repo.get_detail(code, force=force)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


def _meta(d: dict) -> dict:
    return {
        "code": d["code"], "name": d.get("name"), "type": d.get("type"),
        "data_source": d.get("source"), "data_updated_at": d.get("updated_at"),
        "data_stale": bool(d.get("stale")), "data_age_hours": d.get("data_age_hours", 0),
        "as_of_date": d.get("latest_nav_date"),
    }


def _market_kind(detail: dict) -> str:
    text = f"{detail.get('type') or ''} {detail.get('name') or ''}".upper()
    if any(marker in text for marker in ("黄金", "白银", "贵金属")):
        return "gold"
    if any(marker in text for marker in ("港股", "恒生", "香港")):
        return "hk"
    if any(marker in text for marker in ("QDII", "全球", "海外", "纳斯达克", "标普", "美元", "国际")):
        return "overseas"
    return "cn"


def _estimate_context(detail: dict, now_utc: datetime | None = None) -> dict:
    """Build traceable live-data context; never disguise request time as quote time."""
    current_utc = now_utc or datetime.now(timezone.utc)
    current_utc = (
        current_utc.replace(tzinfo=timezone.utc)
        if current_utc.tzinfo is None
        else current_utc.astimezone(timezone.utc)
    )
    fetched_at = current_utc.isoformat()
    try:
        estimate = eastmoney.fetch_resolved_estimate(detail["code"])
    except Exception as error:
        log.warning("盘中估值不可用 code=%s: %s", detail.get("code"), error)
        return {
            "source_time": detail.get("latest_nav_date"),
            "fetched_at": fetched_at,
            "calculated_at": None,
            "age_seconds": None,
            "status": "latest_official" if detail.get("latest_nav_date") else "unavailable",
            "source": detail.get("source") or "official_nav_cache",
            "is_fallback": True,
            "fallback_reason": str(error),
            "market": _market_kind(detail),
            "estimate_change": None,
            "estimate_nav": None,
        }

    source_time = estimate.get("source_time")
    age_seconds = None
    status = str(estimate.get("status") or "unavailable")
    def quote_age(value) -> float | None:
        if not value:
            return None
        text = str(value).strip().replace("Z", "+00:00")
        if "T" not in text and " " in text:
            text = text.replace(" ", "T", 1)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?", text):
            text += "+08:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return None
        return (current_utc - parsed.astimezone(timezone.utc)).total_seconds()

    precision = estimate.get("source_time_precision")
    hard_expired = False
    if precision == "datetime" and estimate.get("kind") in {"estimate", "holdings_model"}:
        times = [source_time]
        if estimate.get("kind") == "holdings_model":
            times.extend((
                estimate.get("model_oldest_quote_time"),
                estimate.get("model_newest_quote_time"),
            ))
        ages = [quote_age(value) for value in times]
        hard_expired = any(age is None or age < -5 * 60 or age > 90 * 60 for age in ages)
        if ages and ages[0] is not None:
            age_seconds = max(0, int(ages[0]))
    elif source_time:
        try:
            quote_date = datetime.strptime(str(source_time)[:10], "%Y-%m-%d").date()
            china_today = current_utc.astimezone(timezone(timedelta(hours=8))).date()
            if status == "fresh" and quote_date != china_today:
                status = "stale"
                hard_expired = True
        except ValueError:
            status = "stale"
            hard_expired = True
    if source_time is None:
        status = "stale"
        hard_expired = True
    elif hard_expired:
        status = "stale"
    elif status == "fresh" and age_seconds is not None and age_seconds > 10 * 60:
        status = "delayed"
    context = {
        **estimate,
        "calculated_at": estimate.get("calculated_at") or current_utc.isoformat(),
        "age_seconds": age_seconds,
        "status": status,
        "is_fallback": bool(estimate.get("is_fallback")),
        "market": _market_kind(detail),
    }
    if hard_expired:
        context.update({"estimate_change": None, "estimate_nav": None, "value_nav": None})
    return context


def _decision_detail(detail: dict) -> dict:
    return {**detail, "decision_context": _estimate_context(detail)}


@app.get("/api/health", response_model=HealthResponse)
def health() -> dict:
    universe = repo.universe_count()
    return {
        "status": "ok",
        "service": "fund-compass",
        "version": app.version,
        "deployment": _deployment_status(),
        "started_at": STARTED_AT,
        "universe": universe,
        "universe_ready": universe > 0,
        "universe_import": {"mode": "manual", "running": False},
        "source": eastmoney.source_health(),
        "index_valuation": index_valuation_status(),
        "database": persistence_status(),
        "strategy_registry": registry_summary(),
        "operations": repo.operations_status(),
    }


@app.get("/api/funds")
def list_funds(
    q: str | None = None,
    type: str | None = None,
    page: int = 1,
    page_size: int = Query(20, ge=1, le=100),
) -> dict:
    """基金列表：按类型 / 关键词（代码·名称·拼音）筛选，分页。"""
    return repo.query_funds(q=q, type=type, page=page, page_size=page_size)


@app.get("/api/fund/{code}")
def fund_detail(detail: dict = Depends(fund_detail_dep)) -> dict:
    """基金详情：费率 / 收益 / 经理 / 规模 / 同类排名 / 最新净值 + 近 800 日净值。"""
    detail["nav_history"] = (detail.get("nav_history") or [])[-NAV_TAIL:]
    return detail


@app.get("/api/fund/{code}/score")
def fund_score(detail: dict = Depends(fund_detail_dep)) -> dict:
    """基金综合评分：0–100 + 五星 + 收益/风险/管理/成本 四维明细。"""
    return {**_meta(detail), **score_fund(detail)}


@app.get("/api/fund/{code}/signal")
def fund_signal(detail: dict = Depends(fund_detail_dep)) -> dict:
    """择时信号：估值 / 趋势 / 情绪 三层合成 买入·定投·持有·减仓，附每层依据。"""
    return {**_meta(detail), **timing_signal(detail)}


@app.get("/api/fund/{code}/backtest")
def fund_backtest(detail: dict = Depends(fund_detail_dep)) -> dict:
    """择时回测：按月用三层信号调仓 vs 一直持有，给收益/回撤/胜率/净值曲线。"""
    return {"code": detail["code"], "name": detail.get("name"), **backtest(detail, include_stress=True)}


@app.get("/api/fund/{code}/calibrate")
def fund_calibrate(detail: dict = Depends(fund_detail_dep)) -> dict:
    """训练/验证隔离的参数校准；只产出候选，不直接覆盖线上规则。"""
    return {"code": detail["code"], "name": detail.get("name"), **calibrate(detail)}


@app.get("/api/strategy/registry")
def strategy_registry() -> dict:
    """当前线上参数、候选版本及其跨基金验证依据。"""
    return registry_summary()


@app.get("/api/fund/{code}/decision")
def fund_decision(
    detail: dict = Depends(fund_detail_dep),
    held: bool = Query(False),
    target_weight: float | None = Query(None, ge=0, le=100),
    current_weight: float | None = Query(None, ge=0, le=100),
) -> dict:
    """决策卡片：综合评分 + 择时 + 回测 → 可执行动作（V6-P0）。"""
    holding = {"is_held": held, "target_weight": target_weight, "current_weight": current_weight}
    decision_detail = _decision_detail(detail)
    return {**_meta(detail), **decide_fund(decision_detail, holding)}


@app.get("/api/fund/{code}/analyze")
def fund_analyze(
    detail: dict = Depends(fund_detail_dep),
    held: bool = Query(False),
    target_weight: float | None = Query(None, ge=0, le=100),
    current_weight: float | None = Query(None, ge=0, le=100),
) -> dict:
    """一次性聚合：详情 + 评分 + 信号 + 回测 + 决策，单次往返取齐详情页所需全部数据。

    详情取一次、净值历史解析一次，各块算法共享同份数据；前端详情页由原先四次串行
    请求收敛为一次。各子对象保留 code/name/type，与独立端点的响应结构一致，便于复用类型。
    """
    meta = _meta(detail)
    nav = (detail.get("nav_history") or [])[-NAV_TAIL:]
    holding = {"is_held": held, "target_weight": target_weight, "current_weight": current_weight}
    score = score_fund(detail)
    signal = timing_signal(detail)
    bt = backtest(detail)
    decision = decide_fund(_decision_detail(detail), holding, score=score, signal=signal, backtest_result=bt)
    return {
        **meta,
        "detail": {**detail, "nav_history": nav},
        "score": {**meta, **score},
        "signal": {**meta, **signal},
        "backtest": {"code": meta["code"], "name": meta["name"], **bt},
        "decision": {**meta, **decision},
    }


@app.post("/api/portfolio/decisions", response_model=PortfolioDecisionResponse)
def portfolio_decisions(request: PortfolioDecisionRequest, _role: str = Depends(require_worker_or_admin)) -> dict:
    """批量决策：自选列表一次返回各基金决策卡片（v7）。

    body: { "items": [{ "code": "510300", "current_weight": 5, "target_weight": 15 }] }
    current_weight / target_weight 可选；受信 Worker 还可携带经过
    Pydantic 边界校验的 estimate_context，确保估值与决策使用同一证据。
    """
    payload = request.model_dump()
    items = payload.get("items") or []
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items 需为数组")
    cleaned = []
    for it in items:
        if not isinstance(it, dict):
            continue
        code = str(it.get("code", "")).strip()
        if not re.fullmatch(r"\d{6}", code):
            raise HTTPException(status_code=400, detail=f"无效基金代码: {code or '(空)'}")
        row = {"code": code}
        for k in ("current_weight", "target_weight"):
            if it.get(k) is not None:
                try:
                    weight = float(it[k])
                except (TypeError, ValueError) as ex:
                    raise HTTPException(status_code=400, detail=f"{code} 的 {k} 需为数字") from ex
                if weight < 0 or weight > 100:
                    raise HTTPException(status_code=400, detail=f"{code} 的 {k} 需在 0-100 之间")
                row[k] = weight
        if isinstance(it.get("estimate_context"), dict):
            # Pydantic has already validated and bounded every field.  Preserve
            # the evidence so the portfolio engine does not refetch a different
            # estimate source while handling the same request.
            row["estimate_context"] = dict(it["estimate_context"])
        cleaned.append(row)
    if not cleaned:
        raise HTTPException(status_code=400, detail="items 不能为空")
    if len(cleaned) > 50:
        raise HTTPException(status_code=400, detail="单次最多 50 只基金")
    request_id = str(payload.get("request_id") or "").strip()
    if request_id and not re.fullmatch(r"[A-Za-z0-9._:-]{1,100}", request_id):
        raise HTTPException(status_code=400, detail="request_id 格式无效")
    portfolio_value = payload.get("portfolio_value")
    if portfolio_value is not None:
        try:
            portfolio_value = float(portfolio_value)
        except (TypeError, ValueError) as ex:
            raise HTTPException(status_code=400, detail="portfolio_value 需为数字") from ex
        if portfolio_value < 0:
            raise HTTPException(status_code=400, detail="portfolio_value 不能为负数")
    result = decide_portfolio(cleaned, portfolio_value)
    if request_id and not repo.claim_request(request_id, "portfolio_decisions"):
        return {**result, "duplicate": True, "request_id": request_id}
    try:
        version = (registry_summary().get("active") or {}).get("version") or "unknown"
        repo.record_decisions(result["decisions"], version)
        repo.record_portfolio_decision(cleaned, result["decisions"], version)
    except Exception:
        if request_id:
            try:
                repo.release_request(request_id, "portfolio_decisions")
            except Exception:
                log.exception("request_id 释放失败 request_id=%s", request_id)
        raise
    return {**result, "duplicate": False, "request_id": request_id or None}


@app.get("/api/strategy/outcomes")
def strategy_outcomes() -> dict:
    """历史决策在 5/20/60 个净值观测后的真实表现。"""
    return repo.decision_outcomes()


@app.get("/api/strategy/portfolio-outcomes")
def strategy_portfolio_outcomes() -> dict:
    """组合建议快照在 20/60 个净值观测后的真实表现。"""
    return repo.portfolio_decision_outcomes()


@app.get("/api/strategy/version-comparison")
def strategy_version_comparison() -> dict:
    """冻结模型的新旧实盘结果比较；只读且样本不足时拒绝下结论。"""
    return repo.version_comparison()


# ── v8 immutable decision chain (additive; legacy /api routes stay intact) ──

def _v8_valid_code(code: str) -> str:
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(status_code=422, detail="需要 6 位基金代码")
    return code


@app.get("/api/v2/fund/{code}/evidence")
def v8_fund_evidence(code: str) -> dict:
    """Return the latest persisted evidence without fetching or writing."""
    snapshot = v8_repo.latest_evidence(_v8_valid_code(code))
    if snapshot is None:
        raise HTTPException(status_code=404, detail="尚无已生成的 V8 Evidence 快照")
    return snapshot.model_dump(mode="json")


@app.get("/api/v2/fund/{code}/decision")
def v8_fund_decision(
    code: str,
) -> dict:
    bundle = v8_repo.latest_decision_bundle(_v8_valid_code(code))
    if bundle is None:
        raise HTTPException(status_code=404, detail="尚无已生成的 V8 Decision 快照")
    decision = bundle["decision"]
    evidence = bundle["evidence"]
    return {
        "code": evidence.fund_code,
        "name": evidence.fund_name,
        "type": evidence.fund_type,
        "action": decision.action,
        "action_label": v8_decisions.ACTION_ZH[decision.action],
        "strength": decision.strength,
        "confidence": decision.confidence,
        "summary": decision.summary,
        **{key: bundle[key].model_dump(mode="json") for key in (
            "decision", "evidence", "holding", "policy", "diff",
        )},
    }


@app.get("/api/v2/fund/{code}/decision/diff")
def v8_fund_decision_diff(
    code: str,
) -> dict:
    diff = v8_repo.latest_decision_diff(_v8_valid_code(code))
    if diff is None:
        raise HTTPException(status_code=404, detail="尚无可比较的 V8 Decision 快照")
    return diff.model_dump(mode="json")


@app.get("/api/v2/fund/{code}/outcomes")
def v8_fund_outcomes(code: str) -> dict:
    return v8_repo.outcomes_for_fund(_v8_valid_code(code))


def _v8_batch(request: V8DecisionBatchRequest) -> dict:
    try:
        return v8_decisions.create_batch_decisions(request, estimate_resolver=_estimate_context)
    except v8_decisions.IdempotencyConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except v8_decisions.IdempotencyInProgressError as error:
        raise HTTPException(status_code=425, detail=str(error)) from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


def _v8_attach_portfolio_snapshot(
    request: V8DecisionBatchRequest,
    result: dict,
) -> dict:
    """Persist only a complete, exact portfolio; never drop or normalize items."""
    if not result.get("complete"):
        return {
            **result,
            "portfolio_decision": None,
            "portfolio_snapshot_status": "incomplete",
        }
    try:
        snapshot = v8_repo.build_portfolio_decision_snapshot(
            [item.model_dump(mode="python") for item in request.items],
            result,
            portfolio_value=request.portfolio_value,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail=f"组合快照无效: {error}",
        ) from error
    stored = v8_repo.save_portfolio_decision(snapshot)
    return {
        **result,
        "portfolio_decision": stored.model_dump(mode="json"),
        "portfolio_snapshot_status": "persisted",
    }


@app.post("/api/v2/watchlist/decisions")
def v8_watchlist_decisions(
    request: V8DecisionBatchRequest,
    _role: str = Depends(require_worker_or_admin),
) -> dict:
    return _v8_batch(request)


@app.post("/api/v2/portfolio/decisions")
def v8_portfolio_decisions(
    request: V8DecisionBatchRequest,
    _role: str = Depends(require_worker_or_admin),
) -> dict:
    return _v8_attach_portfolio_snapshot(request, _v8_batch(request))


@app.post("/api/v2/portfolio/rebalance")
def v8_portfolio_rebalance(
    request: V8DecisionBatchRequest,
    _role: str = Depends(require_worker_or_admin),
) -> dict:
    result = _v8_attach_portfolio_snapshot(request, _v8_batch(request))
    return {
        "request_id": result.get("request_id"),
        "duplicate": result.get("duplicate", False),
        "complete": result["complete"],
        "allocation": result["allocation"],
        "rebalance": result["rebalance"],
        "policy_version": result["policy_version"],
        "strategy_version": result["strategy_version"],
        "portfolio_decision": result.get("portfolio_decision"),
        "portfolio_snapshot_status": result.get("portfolio_snapshot_status"),
        **(
            {"portfolio_snapshot_error": result["portfolio_snapshot_error"]}
            if result.get("portfolio_snapshot_error") else {}
        ),
    }


@app.get("/api/v2/portfolio/outcomes")
def v8_portfolio_outcomes(limit: int = 100) -> dict:
    return v8_repo.portfolio_outcomes(limit)


@app.post("/api/v2/portfolio/outcomes/settle")
def v8_settle_portfolio_outcomes(
    portfolio_decision_id: str | None = None,
    limit: int = 100,
    _role: str = Depends(require_worker_or_admin),
) -> dict:
    bounded_limit = max(1, min(10_000, int(limit)))
    if portfolio_decision_id is not None:
        if not re.fullmatch(r"pdec_[0-9a-f]{64}", portfolio_decision_id):
            raise HTTPException(status_code=422, detail="portfolio_decision_id 格式无效")
        try:
            before = len(v8_repo.portfolio_outcome_rows(portfolio_decision_id))
            rows = v8_repo.settle_portfolio_outcomes(portfolio_decision_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        return {
            "settled": max(0, len(rows) - before),
            "errors": [],
            "portfolio_decision_id": portfolio_decision_id,
        }
    return v8_repo.settle_all_portfolio_outcomes(bounded_limit)


@app.get("/api/v2/portfolio/policy")
def v8_portfolio_policy() -> dict:
    try:
        return v8_repo.read_policy().model_dump(mode="json")
    except LookupError as error:
        raise HTTPException(status_code=503, detail="V8 默认 Policy 尚未初始化") from error


@app.post("/api/v2/portfolio/policy")
def v8_post_portfolio_policy(
    request: V8PolicyRequest,
    _role: str = Depends(require_admin),
) -> dict:
    current = v8_repo.get_policy()
    payload = request.model_dump(mode="python")
    effective_at = payload.pop("effective_at") or datetime.now(timezone.utc)
    policy = build_portfolio_policy(
        **payload,
        effective_at=effective_at,
        source="admin",
        supersedes=current.policy_version,
    )
    return v8_repo.save_policy(policy).model_dump(mode="json")


@app.get("/api/v2/portfolio/policy/history")
def v8_portfolio_policy_history() -> dict:
    rows = v8_repo.read_policy_history()
    return {"total": len(rows), "items": [row.model_dump(mode="json") for row in rows]}


@app.get("/api/v2/strategy/registry")
def v8_strategy_registry() -> dict:
    registry = registry_summary()
    active = (registry.get("active") or {}).get("version")
    return {
        **registry,
        "v8_kernel": v8_decisions.STRATEGY_VERSION,
        "v8_performance": v8_repo.strategy_performance(v8_decisions.STRATEGY_VERSION),
        "legacy_active_performance": v8_repo.strategy_performance(active) if active else None,
        "auto_promotion": False,
    }


@app.get("/api/v2/strategy/{version}/performance")
def v8_strategy_performance(version: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,120}", version):
        raise HTTPException(status_code=422, detail="策略版本格式无效")
    return v8_repo.strategy_performance(version)


@app.get("/api/v2/strategy/candidates")
def v8_strategy_candidates() -> dict:
    registry = registry_summary()
    return {
        "candidate": registry.get("candidate"),
        "history": registry.get("history") or [],
        "governance": registry.get("governance"),
        "auto_promotion": False,
    }


@app.post("/api/v2/outcomes/settle")
def v8_settle_outcomes(
    request: V8OutcomeSettleRequest,
    _role: str = Depends(require_worker_or_admin),
) -> dict:
    settled = 0
    errors: list[dict] = []
    if request.decision_ids:
        for decision_id in request.decision_ids:
            try:
                before = len(v8_repo.outcome_rows(decision_id))
                v8_repo.settle_outcomes(decision_id)
                settled += max(0, len(v8_repo.outcome_rows(decision_id)) - before)
            except LookupError:
                errors.append({"decision_id": decision_id, "error": "decision not found"})
    else:
        batch = v8_repo.settle_all_outcomes(request.limit)
        settled = batch["settled"]
        errors.extend(batch["errors"])
    status = v8_repo.outcome_settlement_status(
        request.decision_ids or None,
        limit=request.limit,
    )
    known_errors = {
        (row.get("decision_id"), row.get("error")) for row in errors
    }
    errors.extend(
        row for row in status["errors"]
        if (row.get("decision_id"), row.get("error")) not in known_errors
    )
    return {"settled": settled, "pending": status["pending"], "errors": errors}


@app.post("/api/v2/notifications/events")
def v8_notification_events(
    request: V8NotificationEventRequest,
    _role: str = Depends(require_worker_or_admin),
) -> dict:
    payload = request.model_dump(mode="python")
    decision_ids = payload.pop("decision_ids")
    try:
        results = v8_repo.record_notification_events_batch(
            decision_ids=decision_ids,
            **payload,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except v8_repo.SnapshotConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    events = [
        {
            "event": result.event.model_dump(mode="json"),
            "claimed": result.claimed,
            "duplicate": result.duplicate,
        }
        for result in results
    ]
    return {"total": len(events), "events": events}


@app.get("/api/v2/notifications/{decision_id}")
def v8_get_notification_events(
    decision_id: str,
    _role: str = Depends(require_worker_or_admin),
) -> dict:
    if not re.fullmatch(r"dec_[0-9a-f]{64}", decision_id):
        raise HTTPException(status_code=422, detail="decision_id 格式无效")
    rows = v8_repo.notification_events(decision_id)
    return {"decision_id": decision_id, "total": len(rows), "events": [row.model_dump(mode="json") for row in rows]}


@app.post("/api/portfolio/lab")
def portfolio_lab(request: PortfolioLabRequest, _role: str = Depends(require_admin)) -> dict:
    """组合历史回测、风险贡献与受约束再平衡建议。"""
    payload = request.model_dump()
    items = payload.get("items") or []
    if not isinstance(items, list) or not 1 <= len(items) <= 10:
        raise HTTPException(status_code=400, detail="组合需包含 1-10 只基金")
    cleaned, details = [], []
    for item in items:
        code = str((item or {}).get("code") or "").strip()
        if not re.fullmatch(r"\d{6}", code):
            raise HTTPException(status_code=400, detail=f"无效基金代码: {code or '(空)'}")
        row = {"code": code}
        for field in ("current_weight", "target_weight"):
            if item.get(field) is None:
                raise HTTPException(status_code=422, detail=f"{code} 缺少 {field}，组合实验室不会按 0 处理")
            try:
                value = float(item[field])
            except (TypeError, ValueError) as ex:
                raise HTTPException(status_code=400, detail=f"{code} 的 {field} 需为数字") from ex
            if value < 0 or value > 100:
                raise HTTPException(status_code=400, detail=f"{code} 的 {field} 需在 0-100 之间")
            row[field] = value
        cleaned.append(row)
        try:
            details.append(repo.get_detail(code))
        except Exception as ex:
            raise HTTPException(status_code=422, detail=f"{code} 数据不可用: {ex}") from ex
    portfolio_value = payload.get("portfolio_value")
    if portfolio_value is not None:
        try:
            portfolio_value = max(0.0, float(portfolio_value))
        except (TypeError, ValueError) as ex:
            raise HTTPException(status_code=400, detail="portfolio_value 需为数字") from ex
    raw_assumptions = payload.get("assumptions") or {}
    if not isinstance(raw_assumptions, dict):
        raise HTTPException(status_code=400, detail="assumptions 需为对象")
    assumption_ranges = {
        "rebalance_fee": (0, 0.05), "annual_cash_yield": (0, 0.2),
        "max_weight": (1, 100), "min_trade": (0, 20),
    }
    assumptions = {}
    for key, value in raw_assumptions.items():
        if key not in assumption_ranges:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError) as ex:
            raise HTTPException(status_code=400, detail=f"{key} 需为数字") from ex
        low, high = assumption_ranges[key]
        if number < low or number > high:
            raise HTTPException(status_code=400, detail=f"{key} 需在 {low}-{high} 之间")
        assumptions[key] = number
    try:
        return analyze_portfolio(details, cleaned, portfolio_value, assumptions)
    except ValueError as ex:
        raise HTTPException(status_code=422, detail=str(ex)) from ex


@app.get("/api/watchlist")
def get_watchlist() -> dict:
    return {"items": repo.list_watchlist()}


@app.post("/api/watchlist")
def post_watchlist(request: WatchlistRequest, _role: str = Depends(require_admin)) -> dict:
    code = request.code
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(status_code=400, detail="需要 6 位基金代码")
    repo.add_watchlist(code)
    return {"ok": True, "code": code}


@app.delete("/api/watchlist/{code}")
def delete_watchlist(code: str, _role: str = Depends(require_admin)) -> dict:
    repo.remove_watchlist(code)
    return {"ok": True, "code": code}


@app.post("/api/admin/refresh-universe")
def refresh_universe(_role: str = Depends(require_admin)) -> dict:
    """手动刷新全量基金列表。"""
    try:
        n = repo.import_universe()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"imported": n}
