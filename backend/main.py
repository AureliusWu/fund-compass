"""司南基金 后端入口（FastAPI）。

本地启动（建议 Python 3.12）：
    cd backend
    python -m venv .venv && .venv\\Scripts\\activate   # Windows
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

首次启动会自动抓取全量基金列表入库（约 2.7 万只，几秒）。
"""
import re
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from database.db import init_db
from service import repo
from strategy import analyze_fund, backtest, score_fund, timing_signal

NAV_TAIL = 800  # 返回给前端的净值条数（≈3年，供走势图 / 定投回放 / 指标计算）


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if repo.universe_count() == 0:
        try:
            repo.import_universe()
        except Exception:
            pass  # 离线/接口异常时不阻塞启动，可后续调用 /api/admin/refresh-universe
    yield


app = FastAPI(title="司南基金 API", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://aureliuswu.github.io",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


def fund_detail_dep(code: str) -> dict:
    """统一的详情取数依赖：命中缓存或抓取，失败转 404。

    四个基金端点此前各自重复一遍 try/except，收口到这里后端点只声明
    `detail: dict = Depends(fund_detail_dep)` 即可，详情逻辑只有一处。
    """
    try:
        return repo.get_detail(code)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


def _meta(d: dict) -> dict:
    return {"code": d["code"], "name": d.get("name"), "type": d.get("type")}


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "fund-compass",
        "version": app.version,
        "universe": repo.universe_count(),
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
    return {"code": detail["code"], "name": detail.get("name"), **backtest(detail)}


@app.get("/api/fund/{code}/analyze")
def fund_analyze(detail: dict = Depends(fund_detail_dep)) -> dict:
    """一次性聚合：详情 + 评分 + 信号 + 回测，单次往返取齐详情页所需全部数据。

    详情取一次、净值历史解析一次，三块算法共享同份数据；前端详情页由原先四次串行
    请求收敛为一次。各子对象保留 code/name/type，与独立端点的响应结构一致，便于复用类型。
    """
    meta = _meta(detail)
    nav = (detail.get("nav_history") or [])[-NAV_TAIL:]
    return {
        **meta,
        "detail": {**detail, "nav_history": nav},
        "score": {**meta, **score_fund(detail)},
        "signal": {**meta, **timing_signal(detail)},
        "backtest": {"code": meta["code"], "name": meta["name"], **backtest(detail)},
    }


@app.get("/api/watchlist")
def get_watchlist() -> dict:
    return {"items": repo.list_watchlist()}


@app.post("/api/watchlist")
def post_watchlist(payload: dict) -> dict:
    code = str(payload.get("code", "")).strip()
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(status_code=400, detail="需要 6 位基金代码")
    repo.add_watchlist(code)
    return {"ok": True, "code": code}


@app.delete("/api/watchlist/{code}")
def delete_watchlist(code: str) -> dict:
    repo.remove_watchlist(code)
    return {"ok": True, "code": code}


@app.post("/api/admin/refresh-universe")
def refresh_universe() -> dict:
    """手动刷新全量基金列表。"""
    try:
        n = repo.import_universe()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"imported": n}
