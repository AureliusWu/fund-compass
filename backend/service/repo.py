"""数据仓储：universe 导入、列表查询、详情缓存（SQLite）。"""
import logging
import json
import statistics
import gzip
import hashlib
from pathlib import Path
from datetime import datetime, timedelta, timezone

from database.db import get_conn
from service.eastmoney import fetch_detail, fetch_universe

log = logging.getLogger(__name__)

CST = timezone(timedelta(hours=8))
DETAIL_TTL = timedelta(hours=12)
STALE_MAX_AGE = timedelta(days=7)
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
UNIVERSE_ARTIFACT = Path(__file__).resolve().parent.parent / "data" / "fund-universe.json.gz"
UNIVERSE_META = Path(__file__).resolve().parent.parent / "data" / "fund-universe.meta.json"


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


def import_universe_artifact() -> dict:
    """Import a verified local artifact. This function never performs network I/O."""
    if not UNIVERSE_ARTIFACT.exists() or not UNIVERSE_META.exists():
        return {"loaded": False, "reason": "missing", "fund_count": 0}
    try:
        meta = json.loads(UNIVERSE_META.read_text(encoding="utf-8"))
        payload = gzip.decompress(UNIVERSE_ARTIFACT.read_bytes())
        digest = hashlib.sha256(payload).hexdigest()
        if meta.get("schema_version") != 1 or digest != meta.get("sha256"):
            raise ValueError("基金全集 artifact 校验失败")
        funds = json.loads(payload)
        if not isinstance(funds, list) or len(funds) != meta.get("fund_count"):
            raise ValueError("基金全集数量与元数据不一致")
        conn = get_conn()
        try:
            conn.executemany(
                "INSERT OR REPLACE INTO funds(code,name,type,pinyin) VALUES (?,?,?,?)",
                [(f["code"], f["name"], f.get("type"), f.get("pinyin", "")) for f in funds],
            )
            conn.commit()
        finally:
            conn.close()
        return {"loaded": True, **meta}
    except Exception as error:
        log.error("基金全集本地 artifact 加载失败: %s", error)
        return {"loaded": False, "reason": str(error), "fund_count": 0}


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


def _infer_fund_type(name: str | None) -> str | None:
    """Conservative fallback for detail sources that omit the fund category."""
    if not name:
        return None
    for marker, category in (
        ("QDII", "QDII"), ("FOF", "FOF"), ("货币", "货币型"),
        ("债券", "债券型"), ("混合", "混合型"), ("股票", "股票型"),
        ("指数", "指数型"), ("ETF", "指数型"),
    ):
        if marker.lower() in name.lower():
            return category
    return None


def _fill_detail_type(conn, detail: dict) -> None:
    if detail.get("type"):
        return
    row = conn.execute("SELECT type FROM funds WHERE code=?", (detail.get("code"),)).fetchone()
    detail["type"] = (row["type"] if row and row["type"] else None) or _infer_fund_type(detail.get("name"))


def _save_detail(conn, d):
    saved_at = _now().isoformat(timespec="seconds")
    conn.execute(
        """INSERT OR REPLACE INTO fund_detail
        (code,name,type,scale,buy_rate,source_rate,ret_1m,ret_6m,ret_1y,ret_3y,
         rank_in_type,rank_total,manager,manager_id,manager_worktime,latest_nav,latest_nav_date,source,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (d["code"], d["name"], d.get("type"), d.get("scale"), d.get("buy_rate"),
         d.get("source_rate"), d.get("ret_1m"), d.get("ret_6m"), d.get("ret_1y"),
         d.get("ret_3y"), d.get("rank_in_type"), d.get("rank_total"), d.get("manager"), d.get("manager_id"),
         d.get("manager_worktime"), d.get("latest_nav"), d.get("latest_nav_date"),
         d.get("source"), saved_at),
    )
    hist = (d.get("nav_history") or [])[-HIST_KEEP:]
    conn.executemany(
        "INSERT OR REPLACE INTO nav_history(code,date,nav,ac_return) VALUES (?,?,?,?)",
        [(d["code"], h["date"], h["nav"], h.get("ac_return")) for h in hist],
    )
    d["updated_at"] = saved_at


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
                _fill_detail_type(conn, d)
                d["nav_history"] = _load_history(conn, code)
                d["cached"] = True
                return d

        try:
            detail = fetch_detail(code)  # 内部已含主源→备源(f10 lsjz)降级
        except Exception:
            # 容灾末层：主源+备源都失败时，退回 DB 里上次成功缓存的陈旧数据，避免整页 404
            if row:
                try:
                    stale_age = _now() - datetime.fromisoformat(row["updated_at"])
                except Exception:
                    stale_age = STALE_MAX_AGE + timedelta(seconds=1)
                if stale_age > STALE_MAX_AGE:
                    log.error("缓存超过最大兜底期限 code=%s age=%s", code, stale_age, exc_info=True)
                    raise
                log.warning("主源+备源均失败，退回陈旧缓存 code=%s", code, exc_info=True)
                d = dict(row)
                _fill_detail_type(conn, d)
                d["nav_history"] = _load_history(conn, code)
                d["cached"] = True
                d["stale"] = True
                d["data_age_hours"] = round(stale_age.total_seconds() / 3600, 1)
                return d
            log.error("主源+备源均失败且无缓存，详情不可用 code=%s", code, exc_info=True)
            raise
        _fill_detail_type(conn, detail)
        _save_detail(conn, detail)
        conn.commit()
        detail["cached"] = False
        detail["stale"] = False
        detail["data_age_hours"] = 0.0
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


# ── 决策结果闭环 ──────────────────────────────────────
def record_decisions(decisions: list[dict], strategy_version: str) -> int:
    """保存当时决策快照；同基金/日期/参数版本只写一次，不事后覆盖。"""
    rows = []
    now = _now().isoformat(timespec="seconds")
    for decision in decisions:
        nav = decision.get("as_of_nav")
        date = decision.get("as_of_date")
        if not code_is_valid(decision.get("code")) or not date or not nav:
            continue
        methodology = decision.get("methodology") or {}
        fund_type = str(decision.get("type") or "")
        region = "overseas" if "QDII" in fund_type.upper() or "海外" in fund_type else "domestic"
        rows.append((
            decision["code"], decision.get("name"), decision.get("type"), date,
            float(nav), decision.get("action") or "观察", decision.get("confidence"),
            strategy_version, methodology.get("score_version"), methodology.get("signal_version"),
            methodology.get("score_coverage"), methodology.get("signal_coverage"),
            methodology.get("evidence_strength"), region, now,
        ))
    if not rows:
        return 0
    conn = get_conn()
    try:
        before = conn.total_changes
        conn.executemany(
            """INSERT OR IGNORE INTO decision_history
            (code,name,type,decision_date,base_nav,action,confidence,strategy_version,
             score_version,signal_version,score_coverage,signal_coverage,evidence_strength,region,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            rows,
        )
        conn.commit()
        return conn.total_changes - before
    finally:
        conn.close()


def code_is_valid(code) -> bool:
    return isinstance(code, str) and len(code) == 6 and code.isdigit()


def claim_request(request_id: str, endpoint: str) -> bool:
    """Atomically claim an idempotency key; an existing key is never overwritten."""
    conn = get_conn()
    try:
        before = conn.total_changes
        conn.execute(
            "INSERT OR IGNORE INTO idempotency_requests(request_id,endpoint,created_at) VALUES (?,?,?)",
            (request_id, endpoint, _now().isoformat(timespec="seconds")),
        )
        conn.commit()
        return conn.total_changes > before
    finally:
        conn.close()


def decision_outcomes(horizons=(5, 20, 60)) -> dict:
    """按决策时点后的第 N 个净值观测计算表现，绝不使用决策日前数据。"""
    conn = get_conn()
    try:
        decisions = [dict(row) for row in conn.execute(
            "SELECT * FROM decision_history ORDER BY decision_date DESC"
        ).fetchall()]
        results = []
        for decision in decisions:
            future = conn.execute(
                "SELECT date,nav FROM nav_history WHERE code=? AND date>? ORDER BY date",
                (decision["code"], decision["decision_date"]),
            ).fetchall()
            outcome = {**decision, "returns": {}}
            coverage = decision.get("signal_coverage")
            outcome["coverage_band"] = (
                "unknown" if coverage is None else "high" if coverage >= 0.9
                else "medium" if coverage >= 0.7 else "low"
            )
            for horizon in horizons:
                if len(future) >= horizon:
                    point = future[horizon - 1]
                    path = [float(row["nav"]) for row in future[:horizon]]
                    peak = float(decision["base_nav"])
                    max_drawdown = 0.0
                    for nav in path:
                        peak = max(peak, nav)
                        max_drawdown = min(max_drawdown, (nav / peak - 1) * 100)
                    outcome["returns"][str(horizon)] = {
                        "date": point["date"],
                        "return": round((point["nav"] / decision["base_nav"] - 1) * 100, 2),
                        "max_drawdown": round(max_drawdown, 2),
                    }
            results.append(outcome)
    finally:
        conn.close()

    # 同类型、相近决策日期、相同周期的 leave-one-out 横截面对照。
    for row in results:
        fund_type = row.get("type") or "未知"
        for horizon, outcome in row["returns"].items():
            decision_date = datetime.fromisoformat(row["decision_date"]).date()
            peers = []
            for peer in results:
                if peer["id"] == row["id"] or (peer.get("type") or "未知") != fund_type:
                    continue
                peer_outcome = peer["returns"].get(horizon)
                if not peer_outcome:
                    continue
                peer_date = datetime.fromisoformat(peer["decision_date"]).date()
                if abs((peer_date - decision_date).days) <= 7:
                    peers.append(peer_outcome["return"])
            if len(peers) >= 2:
                benchmark = statistics.fmean(peers)
                outcome["benchmark_return"] = round(benchmark, 2)
                outcome["excess_return"] = round(outcome["return"] - benchmark, 2)
                outcome["benchmark_samples"] = len(peers)
                outcome["benchmark_method"] = "same-type ±7d leave-one-out"

    groups: dict[tuple[str, str, str], list[float]] = {}
    positive_actions = {"分批买入", "继续定投"}
    defensive_actions = {"停止加仓", "部分观察", "考虑替换"}
    for row in results:
        for horizon, outcome in row["returns"].items():
            groups.setdefault((row["strategy_version"], row["action"], horizon), []).append(outcome["return"])
    summary = []
    for (version, action, horizon), returns in sorted(
        groups.items(), key=lambda item: (item[0][0], int(item[0][2]), item[0][1])
    ):
        if action in positive_actions:
            hits = sum(value > 0 for value in returns)
        elif action in defensive_actions:
            hits = sum(value <= 0 for value in returns)
        else:
            hits = sum(value >= 0 for value in returns)
        matching = [
            outcome
            for row in results
            if row["strategy_version"] == version and row["action"] == action
            for key, outcome in row["returns"].items() if key == horizon
        ]
        excess = [row["excess_return"] for row in matching if "excess_return" in row]
        drawdowns = [row["max_drawdown"] for row in matching]
        summary.append({
            "action": action,
            "strategy_version": version,
            "horizon": int(horizon),
            "samples": len(returns),
            "average_return": round(sum(returns) / len(returns), 2),
            "hit_rate": round(hits / len(returns) * 100, 1),
            "average_excess": round(statistics.fmean(excess), 2) if excess else None,
            "average_drawdown": round(statistics.fmean(drawdowns), 2),
            "worst_drawdown": round(min(drawdowns), 2),
        })

    def breakdown(field: str) -> list[dict]:
        buckets: dict[tuple[str, int], list[tuple[float, float, float | None, str]]] = {}
        for row in results:
            label = row.get(field) or "未知"
            for horizon, outcome in row["returns"].items():
                buckets.setdefault((label, int(horizon)), []).append((
                    outcome["return"], outcome["max_drawdown"],
                    outcome.get("excess_return"), row["action"],
                ))
        output = []
        for (label, horizon), values in sorted(buckets.items()):
            hits = sum(
                value > 0 if action in positive_actions
                else value <= 0 if action in defensive_actions
                else value >= 0
                for value, _, _, action in values
            )
            excess = [value[2] for value in values if value[2] is not None]
            output.append({
                field: label,
                "horizon": horizon,
                "samples": len(values),
                "average_return": round(statistics.fmean(value[0] for value in values), 2),
                "hit_rate": round(hits / len(values) * 100, 1),
                "average_excess": round(statistics.fmean(excess), 2) if excess else None,
                "average_drawdown": round(statistics.fmean(value[1] for value in values), 2),
            })
        return output

    mature = sum(1 for row in results if row["returns"])
    return {
        "total": len(results),
        "mature": mature,
        "pending": len(results) - mature,
        "items": results,
        "summary": summary,
        "breakdowns": {
            "strategy_version": breakdown("strategy_version"),
            "action": breakdown("action"),
            "confidence": breakdown("confidence"),
            "type": breakdown("type"),
            "score_version": breakdown("score_version"),
            "signal_version": breakdown("signal_version"),
            "evidence_strength": breakdown("evidence_strength"),
            "region": breakdown("region"),
            "coverage_band": breakdown("coverage_band"),
        },
    }


def version_comparison() -> dict:
    """Read-only, sample-gated comparison. It never changes registry or historical rows."""
    outcomes = decision_outcomes()
    positive_actions = {"分批买入", "继续定投"}
    defensive_actions = {"停止加仓", "部分观察", "考虑替换"}
    buckets: dict[tuple[str, int], list[tuple[dict, dict]]] = {}
    cutoff = None
    for row in outcomes["items"]:
        score_version = row.get("score_version") or "legacy"
        signal_version = row.get("signal_version") or "legacy"
        version = f"{score_version} / {signal_version}"
        for horizon, result in row["returns"].items():
            buckets.setdefault((version, int(horizon)), []).append((row, result))
            cutoff = max(cutoff or result["date"], result["date"])

    metrics = []
    for (version, horizon), values in sorted(buckets.items()):
        returns = [result["return"] for _, result in values]
        excess = [result["excess_return"] for _, result in values if result.get("excess_return") is not None]
        drawdowns = [result["max_drawdown"] for _, result in values]
        hits = 0
        for row, result in values:
            action, value = row["action"], result["return"]
            hits += value > 0 if action in positive_actions else value <= 0 if action in defensive_actions else value >= 0
        metrics.append({
            "version": version, "horizon": horizon, "samples": len(values),
            "average_return": round(statistics.fmean(returns), 2),
            "median_return": round(statistics.median(returns), 2),
            "average_excess": round(statistics.fmean(excess), 2) if excess else None,
            "average_drawdown": round(statistics.fmean(drawdowns), 2),
            "worst_drawdown": round(min(drawdowns), 2),
            "positive_rate": round(sum(value > 0 for value in returns) / len(values) * 100, 1),
            "direction_hit_rate": round(hits / len(values) * 100, 1),
            "observe_rate": round(sum(row["action"] in {"观察", "持有观望"} for row, _ in values) / len(values) * 100, 1),
        })

    new_name = "v3-risk-adjusted / v3-coverage-gated"
    new_rows = [row for row in metrics if row["version"] == new_name]
    total_new = sum(row["samples"] for row in new_rows)
    reasons = []
    if total_new < 100:
        reasons.append(f"新模型成熟样本 {total_new}/100，样本不足")
    type_breakdowns = outcomes["breakdowns"]["type"]
    if not any(row["samples"] >= 30 for row in type_breakdowns):
        reasons.append("主要基金类型成熟样本不足 30")
    if not any(row["horizon"] in (20, 60) for row in new_rows):
        reasons.append("20/60 日样本尚未成熟")
    return {
        "baseline_version": "legacy score/signal",
        "candidate_version": new_name,
        "frozen": True,
        "accepted": not reasons,
        "reasons": reasons,
        "data_cutoff": cutoff,
        "metrics": metrics,
        "breakdowns": outcomes["breakdowns"],
        "guardrails": {"minimum_total": 100, "minimum_primary_type": 30, "auto_tuning": False},
    }


def record_portfolio_decision(items: list[dict], decisions: list[dict], strategy_version: str) -> int:
    """保存组合建议时点的成分、权重和各自最新净值；同日同版本不可覆盖。"""
    decision_map = {row.get("code"): row for row in decisions}
    snapshot = []
    for item in items:
        decision = decision_map.get(item.get("code")) or {}
        weight = item.get("current_weight")
        if weight is None or float(weight) <= 0 or not decision.get("as_of_nav") or not decision.get("as_of_date"):
            continue
        snapshot.append({
            "code": item["code"], "name": decision.get("name"), "weight": float(weight),
            "base_nav": float(decision["as_of_nav"]), "base_date": decision["as_of_date"],
            "action": decision.get("action"),
        })
    total = sum(row["weight"] for row in snapshot)
    if not snapshot or total <= 0:
        return 0
    for row in snapshot:
        row["weight"] = row["weight"] / total
    now = _now()
    conn = get_conn()
    try:
        before = conn.total_changes
        conn.execute(
            """INSERT OR IGNORE INTO portfolio_decision_history
            (snapshot_date,strategy_version,items_json,created_at) VALUES (?,?,?,?)""",
            (now.date().isoformat(), strategy_version, json.dumps(snapshot, ensure_ascii=False), now.isoformat(timespec="seconds")),
        )
        conn.commit()
        return conn.total_changes - before
    finally:
        conn.close()


def portfolio_decision_outcomes(horizons=(20, 60)) -> dict:
    """按每个成分决策后第 N 个净值观测计算组合收益，不改写原始快照。"""
    conn = get_conn()
    try:
        snapshots = [dict(row) for row in conn.execute(
            "SELECT * FROM portfolio_decision_history ORDER BY snapshot_date DESC"
        ).fetchall()]
        results = []
        for snapshot in snapshots:
            items = json.loads(snapshot.pop("items_json"))
            returns = {}
            for horizon in horizons:
                parts, dates = [], []
                for item in items:
                    future = conn.execute(
                        "SELECT date,nav FROM nav_history WHERE code=? AND date>? ORDER BY date LIMIT ?",
                        (item["code"], item["base_date"], horizon),
                    ).fetchall()
                    if len(future) < horizon:
                        break
                    point = future[horizon - 1]
                    parts.append(item["weight"] * (point["nav"] / item["base_nav"] - 1))
                    dates.append(point["date"])
                if len(parts) == len(items):
                    returns[str(horizon)] = {
                        "date": max(dates), "return": round(sum(parts) * 100, 2),
                        "components": len(parts),
                    }
            results.append({**snapshot, "items": items, "returns": returns})
    finally:
        conn.close()
    return {
        "total": len(results),
        "mature": sum(bool(row["returns"]) for row in results),
        "pending": sum(not row["returns"] for row in results),
        "items": results,
    }
