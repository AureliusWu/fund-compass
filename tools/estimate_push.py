#!/usr/bin/env python3
"""司南基金 · 交易日 14:30 / 14:40 / 14:50 自选估值推送（V3）。

读 Gist 自选 → 抓天天基金盘中估值（涨跌%）→ 仅当日有估值（=交易日，自动避开周末/节假日）
才推送微信。与 V2-6 的 notify.py 互不影响（独立脚本与工作流，复用同名 Secret）。

定时可靠性：GitHub 免费定时任务"尽力而为"，可能延迟/跳过。
工作流定义 14:30 / 14:40 / 14:50 三个 slot，脚本用 Gist 状态文件
sinan-estimate-state.json 记「当天每个 slot 已推」做去重，保证每个 slot 最多推一条。

环境变量：GIST_TOKEN、WECHAT_SENDKEY（兼容 SC_SENDKEY）、SCHEDULE_CRON、PUSH_SLOT、FORCE。
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

def watch_codes(gid):
    """从 Gist 自选读 [(code, name)]。"""
    raw = gist_file(gid, WATCH_FILE) or "[]"
    return [(e["code"], e.get("name")) for e in json.loads(raw)
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

    codes = watch_codes(gid)
    if not codes:
        print("自选为空"); return

    lines, fresh = [], False
    for code, name in codes:
        try:
            e = estimate(code)
        except Exception as ex:
            print("est fail", code, ex); continue
        if not e:
            continue
        nm = name or e["name"]
        if e["gztime"].startswith(today):
            fresh = True
        try:
            chg = float(e["gszzl"])
            label = e.get("label") or "估值"
            lines.append(f"**{nm}**  {'+' if chg >= 0 else ''}{chg:.2f}%（{label}）")
        except (TypeError, ValueError):
            lines.append(f"**{nm}**  —")

    if not lines:
        print("无估值数据"); return
    if not fresh and not FORCE:
        print("今日无盘中估值（非交易日/休市），跳过"); return

    title = f"司南基金 · 自选涨跌幅（{slot}）"
    content = "\n".join(f"- {ln}" for ln in lines) + "\n\n> 盘中/海外估值，仅供个人参考，不构成投资建议。"
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
