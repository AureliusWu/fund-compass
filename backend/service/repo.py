"""数据仓储：universe 导入、列表查询、详情缓存（SQLite）。"""
import logging
from datetime import datetime, timedelta, timezone

from database.db import get_conn
from service.eastmoney import fetch_detail, fetch_universe

log = logging.getLogger(__name__)

CST = timezone(timedelta(hours=8))
DETAIL_TTL = timedelta(hours=12)
HIST_KEEP = 800   # 入库保留的净值条数（≈3年，供 MA120 / 估值分位）

# 冷启动兜底种子：只覆盖常用指数/ETF，避免空库时选基页完全空白。
# 完整 universe 不再启动时抓取；需要完整列表时手动 POST /api/admin/refresh-universe。
SEED_FUNDS = [
    {"code": "510300", "name": "华泰柏瑞沪深300ETF", "type": "指数型-股票", "pinyin": "HTBRHS300ETF"},
    {"code": "050002", "name": "博时沪深300指数A", "type": "指数型-股票", "pinyin": "BSHS300ZSA"},
    {"code": "510500", "name": "南方中证500ETF", "type": "指数型-股票", "pinyin": "NFZZ500ETF"},
    {"code": "510050", "name": "华夏上证50ETF", "type": "指数型-股票", "pinyin": "HXSZ50ETF"},
    {"code": "159915", "name": "易方达创业板ETF", "type": "指数型-股票", "pinyin": "YFDCYBETF"},
    {"code": "588000", "name": "华夏科创50ETF", "type": "指数型-股票", "pinyin": "HXKC50ETF"},
    {"code": "161725", "name": "招商中证白酒指数A", "type": "指数型-股票", "pinyin": "ZSZZBJZSA"},
    {"code": "513100", "name": "国泰纳斯达克100ETF", "type": "QDII-指数", "pinyin": "GTNSDK100ETF"},
    {"code": "161130", "name": "易方达纳斯达克100人民币A", "type": "QDII-指数", "pinyin": "YFDNSDK100RMB A"},
    {"code": "513500", "name": "博时标普500ETF", "type": "QDII-指数", "pinyin": "BSBP500ETF"},
]


def _now():
    return datetime.now(CST)


def universe_count() -> int:
    conn = get_conn()
    try:
        return conn.execute("SELECT COUNT(*) FROM funds").fetchone()[0]
    finally:
        conn.close()


def import_universe() -> int:
    """抓取全量基金并写入 funds 表，返回条数。只在手动刷新时调用，不进入启动路径。"""
    funds = fetch_universe()
    conn = get_conn()
    try:
        conn.executemany(
            "INSERT OR REPLACE INTO funds(code,name,type,pinyin) VALUES (?,?,?,?)",
            [(f["code"], f["name"], f["type"], f["pinyin"]) for f in funds],
        )
        conn.commit()
    finally:
        conn.close()
    return len(funds)


def _query_seed(q=None, type=None, page=1, page_size=20) -> dict:
    """空库冷启动时的极速兜底列表；纯内存过滤，不访问网络。"""
    items = SEED_FUNDS
    if type:
        items = [f for f in items if type in (f.get("type") or "")]
    if q:
        needle = q.strip().upper()
        items = [
            f for f in items
            if needle in f["code"]
            or needle in f["name"].upper()
            or needle in f["pinyin"].upper()
        ]
    total = len(items)
    start = (page - 1) * page_size
    page_items = items[start:start + page_size]
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [{"code": f["code"], "name": f["name"], "type": f["type"]} for f in page_items],
        "seed": True,
    }


def query_funds(q=None, type=None, page=1, page_size=20) -> dict:
    page = max(1, page)
    page_size = max(1, min(page_size, 100))
    conn = get_conn()
    try:
        # 空库说明还没手动刷新完整 universe。此时绝不自动抓全量，直接走内存种子。
        base_total = conn.execute("SELECT COUNT(*) FROM funds").fetchone()[0]
        if base_total == 0:
            return _query_seed(q=q, type=type, page=page, page_size=page_size)

        where, args = [], []
        if type:
            where.append("type LIKE ?")
            args.append(f"%{type}%")
        if q:
            where.append("(code LIKE ? OR name LIKE ? OR pinyin LIKE ?)")
            args += [f"%{q}%", f"%{q}%", f"%{q.upper()}%"]
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = conn.execute("SELECT COUNT(*) FROM funds" + clause, args).fetchone()[0]
        rows = conn.execute(
            "SELECT code,name,type FROM funds" + clause + " ORDER BY code LIMIT ? OFFSET ?",
            args + [page_size, (page - 1) * page_size],
        ).fetchall()
    finally:
        conn.close()
    return {
        "total": total, "page": page, "page_size": page_size,
        "items": [dict(r) for r in rows],
        "seed": False,
    }


def _load_history(conn, code, limit=HIST_KEEP):
    rows = conn.execute(
        "SELECT date,nav,ac_return FROM nav_history WHERE code=? ORDER BY date DESC LIMIT ?",
        (code, limit),
    ).fetchall()
    return [dict(r) for r in reversed(rows)]


def _save_detail(conn, d):
    conn.execute(
        """INSERT OR REPLACE INTO fund_detail
        (code,name,type,scale,buy_rate,source_rate,ret_1m,ret_6m,ret_1y,ret_3y,
         rank_in_type,rank_total,manager,manager_worktime,latest_nav,latest_nav_date,source,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (d["code"], d["name"], d.get("type"), d.get("scale"), d.get("buy_rate"),
         d.get("source_rate"), d.get("ret_1m"), d.get("ret_6m"), d.get("ret_1y"),
         d.get("ret_3y"), d.get("rank_in_type"), d.get("rank_total"), d.get("manager"),
         d.get("manager_worktime"), d.get("latest_nav"), d.get("latest_nav_date"),
         d.get("source"), _now().isoformat(timespec="seconds")),
    )
    hist = (d.get("nav_history") or [])[-HIST_KEEP:]
    conn.executemany(
        "INSERT OR REPLACE INTO nav_history(code,date,nav,ac_return) VALUES (?,?,?,?)",
        [(d["code"], h["date"], h["nav"], h.get("ac_return")) for h in hist],
    )


def get_detail(code: str, force=False) -> dict:
    """详情：命中新鲜缓存直接返回，否则抓取并入库。"""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM fund_detail WHERE code=?", (code,)).fetchone()
        if row and not force:
            try:
                fresh = (_now() - datetime.fromisoformat(row["updated_at"])) < DETAIL_TTL
            except Exception:
                fresh = False
            if fresh:
                d = dict(row)
                d["nav_history"] = _load_history(conn, code)
                d["cached"] = True
                return d

        try:
            detail = fetch_detail(code)  # 内部已含主源→备源(f10 lsjz)降级
        except Exception:
            # 容灾末层：主源+备源都失败时，退回 DB 里上次成功缓存的陈旧数据，避免整页 404
            if row:
                log.warning("主源+备源均失败，退回陈旧缓存 code=%s", code, exc_info=True)
                d = dict(row)
                d["nav_history"] = _load_history(conn, code)
                d["cached"] = True
                d["stale"] = True
                return d
            log.error("主源+备源均失败且无缓存，详情不可用 code=%s", code, exc_info=True)
            raise
        ftype = conn.execute("SELECT type FROM funds WHERE code=?", (code,)).fetchone()
        detail["type"] = ftype["type"] if ftype else None
        _save_detail(conn, detail)
        conn.commit()
        detail["cached"] = False
        return detail
    finally:
        conn.close()


# ── 自选 ──────────────────────────────────────────────
def list_watchlist() -> list:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT w.code, f.name, f.type, w.added_at "
            "FROM watchlist w LEFT JOIN funds f ON f.code = w.code "
            "ORDER BY w.added_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def add_watchlist(code: str) -> None:
    conn = get_conn()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO watchlist(code, added_at) VALUES (?, ?)",
            (code, _now().isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()


def remove_watchlist(code: str) -> None:
    conn = get_conn()
    try:
        conn.execute("DELETE FROM watchlist WHERE code = ?", (code,))
        conn.commit()
    finally:
        conn.close()
