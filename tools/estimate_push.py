#!/usr/bin/env python3
"""司南基金 · 交易日 14:30 / 14:40 / 14:50 自选估值推送（V3）。

读 Gist 自选 → 抓天天基金盘中估值（涨跌%）→ 仅当日有估值（=交易日，自动避开周末/节假日）
才推送微信。与 V2-6 的 notify.py 互不影响（独立脚本与工作流，复用同名 Secret）。

定时可靠性：GitHub 免费定时任务"尽力而为"，可能延迟/跳过。
工作流定义 14:30 / 14:40 / 14:50 三个 slot，脚本用 Gist 状态文件
sinan-estimate-state.json 记「当天每个 slot 已推」做去重，保证每个 slot 最多推一条。

环境变量：GIST_TOKEN、WECHAT_SENDKEY（兼容 SC_SENDKEY）、FUND_API_BASE、
SCHEDULE_CRON、PUSH_SLOT、FORCE。
纯 stdlib，无需 pip。
"""
import datetime
import json
import os
import re
import urllib.parse
import urllib.request

GIST_TOKEN = os.environ.get("GIST_TOKEN", "").strip()
WECHAT_SENDKEY = (os.environ.get("WECHAT_SENDKEY") or os.environ.get("SC_SENDKEY") or "").strip()
PUSHPLUS_TOKEN = os.environ.get("PUSHPLUS_TOKEN", "").strip()
PUSHPLUS_TOPIC = os.environ.get("PUSHPLUS_TOPIC", "").strip()
PUSHPLUS_CHANNEL = os.environ.get("PUSHPLUS_CHANNEL", "wechat").strip()
NOTIFY_WEBHOOK_URL = os.environ.get("NOTIFY_WEBHOOK_URL", "").strip()
FORCE = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
PUSH_SLOT = os.environ.get("PUSH_SLOT", "").strip()
SCHEDULE_CRON = os.environ.get("SCHEDULE_CRON", "").strip()
FUND_API_BASE = os.environ.get("FUND_API_BASE", "").strip().rstrip("/")
WATCH_FILE = "sinan-watchlist.json"
STATE_FILE = "sinan-estimate-state.json"
GH = "https://api.github.com"
CST = datetime.timezone(datetime.timedelta(hours=8))
VALID_SLOTS = ("14:30",)
MAX_SCHEDULE_DELAY_MINUTES = 25


def _req(url, data=None, headers=None, method=None, timeout=30):
    h = {"User-Agent": "sinan-bot"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def _gh(url, data=None, method=None):
    return _req(url, data=data, method=method, headers={
        "Authorization": f"token {GIST_TOKEN}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    })


def find_gist_id():
    """找到含自选文件的 Gist id。"""
    for page in range(1, 6):
        arr = json.loads(_gh(f"{GH}/gists?per_page=100&page={page}"))
        if not arr:
            return None
        for g in arr:
            if WATCH_FILE in (g.get("files") or {}):
                return g["id"]
        if len(arr) < 100:
            return None
    return None


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

def watch_entries(gid):
    """从 Gist 读取有效自选/持仓条目。"""
    raw = gist_file(gid, WATCH_FILE) or "[]"
    return [e for e in json.loads(raw)
            if isinstance(e, dict) and e.get("code") and not e.get("deleted")]


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_estimate(d, code):
    last_nav = _to_float(d.get("dwjz"))
    est_nav = _to_float(d.get("gsz"))
    est_change = _to_float(d.get("gszzl"))
    if est_change is None and last_nav and est_nav:
        est_change = (est_nav - last_nav) / last_nav * 100
    if est_nav is None and last_nav and est_change is not None:
        est_nav = last_nav * (1 + est_change / 100)

    name = d.get("name") or code
    gztime = d.get("gztime") or ""
    hour = None
    m = re.search(r"\s(\d{1,2}):\d{2}$", gztime)
    if m:
        hour = int(m.group(1))
    overseas = (
        re.search(r"QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港", name, re.I)
        and hour is not None
        and (hour < 9 or hour >= 15)
    )
    return {
        "name": name,
        "last_nav": last_nav,
        "est_nav": est_nav,
        "gszzl": est_change,
        "gztime": gztime,
        "label": "海外估值" if overseas else "盘中估值",
    }


def estimate(code):
    """天天基金估值：jsonpgz({...})。返回 name / gszzl(涨跌%) / gztime / label。"""
    rt = int(datetime.datetime.now().timestamp() * 1000)
    txt = _req(f"https://fundgz.1234567.com.cn/js/{code}.js?rt={rt}",
               headers={"Referer": "http://fund.eastmoney.com/"})
    m = re.search(r"jsonpgz\((.*)\)", txt)
    if not m:
        return None
    d = json.loads(m.group(1))
    return _normalize_estimate(d, code)


def build_portfolio_payload(entries, estimates):
    """聚合跨账户持仓，并按实时估值计算当前仓位。"""
    by_code = {}
    for entry in entries:
        code = str(entry.get("code", "")).strip()
        row = by_code.setdefault(code, {"code": code, "shares": 0.0, "target_weight": None})
        row["shares"] += _to_float(entry.get("shares")) or 0
        if entry.get("target_weight") is not None:
            row["target_weight"] = _to_float(entry.get("target_weight"))

    values = {}
    for code, row in by_code.items():
        est = estimates.get(code) or {}
        nav = est.get("est_nav") or est.get("last_nav")
        values[code] = row["shares"] * nav if nav and row["shares"] > 0 else 0
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
        if row["shares"] > 0 and portfolio_value > 0:
            item["current_weight"] = round(values[code] / portfolio_value * 100, 2)
            item["target_weight"] = round(
                row["target_weight"] if row["target_weight"] is not None else default_target,
                2,
            )
        items.append(item)
    return items, round(portfolio_value, 2)


def fetch_portfolio_decisions(items, portfolio_value):
    """一次请求获取全部决策与组合校准；失败时调用方降级为纯估值。"""
    if not FUND_API_BASE:
        return None
    try:
        body = json.dumps({
            "items": items,
            "portfolio_value": portfolio_value,
        }).encode("utf-8")
        raw = _req(
            f"{FUND_API_BASE}/api/portfolio/decisions",
            data=body,
            headers={"User-Agent": "sinan-bot", "Content-Type": "application/json"},
        )
        data = json.loads(raw)
        return data if isinstance(data, dict) and isinstance(data.get("decisions"), list) else None
    except Exception as ex:
        print("portfolio decision fail", ex)
        return None


def format_push_line(code, name, estimate_data, decision):
    """组合涨跌幅 + 决策动作为一行推送文案。"""
    nm = name or (estimate_data or {}).get("name") or code
    chg_txt = "—"
    if estimate_data and estimate_data.get("gszzl") is not None:
        try:
            chg = float(estimate_data["gszzl"])
            label = estimate_data.get("label") or "估值"
            chg_txt = f"{'+' if chg >= 0 else ''}{chg:.2f}%（{label}）"
        except (TypeError, ValueError):
            chg_txt = "—"
    if decision:
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


def send_notification(title, content):
    """Send through the first configured channel: PushPlus, ServerChan, or webhook."""
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
        out = _req(
            "https://www.pushplus.plus/send",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        print("pushplus:", out[:160])
        return True

    if WECHAT_SENDKEY:
        body = urllib.parse.urlencode({"title": title, "desp": content}).encode()
        out = _req(f"https://sctapi.ftqq.com/{WECHAT_SENDKEY}.send", data=body,
                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        print("serverchan:", out[:160])
        return True

    if NOTIFY_WEBHOOK_URL:
        payload = json.dumps({"title": title, "content": content}, ensure_ascii=False).encode("utf-8")
        out = _req(
            NOTIFY_WEBHOOK_URL,
            data=payload,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        print("webhook:", out[:160])
        return True

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
            return
        if delay < -5:
            print(
                f"planned slot {planned_slot} is {-delay} minutes early "
                f"(now={now.isoformat()}); skip unexpected early push"
            )
            return
    if now.weekday() >= 5 and not FORCE:
        print("周末，跳过"); return
    if not GIST_TOKEN:
        print("未配置 GIST_TOKEN，无法读自选"); return
    gid = find_gist_id()
    if not gid:
        print("未找到自选 Gist（请先在 App 配置云同步并上传自选）"); return

    # slot 去重：每天 14:30 / 14:40 / 14:50 各最多发一次（FORCE 测试除外）。
    state = {}
    try:
        sraw = gist_file(gid, STATE_FILE)
        state = json.loads(sraw) if sraw else {}
    except Exception as ex:
        print("读状态失败（按未推过处理）:", ex)
    if state.get("date") != today:
        state = {"date": today, "sent_slots": []}
    sent_slots = state.setdefault("sent_slots", [])
    if slot in sent_slots and not FORCE:
        print(f"今日（{today}）{slot} 已推过，跳过"); return

    entries = watch_entries(gid)
    if not entries:
        print("自选为空"); return

    unique = {}
    for entry in entries:
        code = str(entry["code"]).strip()
        unique.setdefault(code, entry.get("name"))

    estimates, fresh = {}, False
    for code in unique:
        try:
            e = estimate(code)
        except Exception as ex:
            print("est fail", code, ex); continue
        if not e:
            continue
        estimates[code] = e
        if e["gztime"].startswith(today):
            fresh = True

    if not estimates:
        print("无估值数据"); return
    if not fresh and not FORCE:
        print("今日无盘中估值（非交易日/休市），跳过"); return

    decision_result = None
    if FUND_API_BASE:
        items, portfolio_value = build_portfolio_payload(entries, estimates)
        decision_result = fetch_portfolio_decisions(items, portfolio_value)
    decisions = {
        str(row.get("code")): row
        for row in ((decision_result or {}).get("decisions") or [])
    }
    lines = [
        format_push_line(code, name, estimates.get(code), decisions.get(code))
        for code, name in unique.items()
        if code in estimates
    ]
    title = f"司南基金 · 自选决策摘要（{slot}）" if decision_result else f"司南基金 · 自选涨跌幅（{slot}）"
    content = "\n".join(f"- {ln}" for ln in lines) + "\n\n> 数据辅助分析，不构成投资建议。"
    portfolio_summary = format_portfolio_summary(decision_result)
    if portfolio_summary:
        content = "\n".join(f"- {ln}" for ln in lines) + "\n\n" + portfolio_summary + "\n\n> 数据辅助分析，不构成投资建议。"
    if send_notification(title, content):
        if FORCE:
            print("FORCE 测试推送，不写入 slot 去重状态")
        else:
            try:
                if slot not in sent_slots:
                    sent_slots.append(slot)
                state["sent_slots"] = sorted(sent_slots)
                state["last_slot"] = slot
                state["last_pushed_at"] = now.isoformat()
                write_state(gid, state)
            except Exception as ex:
                print("写状态失败（下次可能重推）:", ex)
    print(f"pushed {len(lines)} funds, fresh={fresh}, slot={slot}")


if __name__ == "__main__":
    main()
