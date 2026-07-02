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
FORCE = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
PUSH_SLOT = os.environ.get("PUSH_SLOT", "").strip()
SCHEDULE_CRON = os.environ.get("SCHEDULE_CRON", "").strip()
WATCH_FILE = "sinan-watchlist.json"
STATE_FILE = "sinan-estimate-state.json"
GH = "https://api.github.com"
CST = datetime.timezone(datetime.timedelta(hours=8))
VALID_SLOTS = ("14:30", "14:40", "14:50")


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


def push_slot(now):
    """确定本次推送 slot：优先 workflow 显式输入，其次 GitHub schedule，最后当前北京时间。"""
    if PUSH_SLOT in VALID_SLOTS:
        return PUSH_SLOT

    # github.event.schedule 形如 "30 6 * * 1-5"，UTC 06:mm 对应北京时间 14:mm。
    m = re.match(r"^\s*(30|40|50)\s+6\s+", SCHEDULE_CRON)
    if m:
        return f"14:{m.group(1)}"

    if now.hour == 14 and now.minute in (30, 40, 50):
        return f"14:{now.minute:02d}"

    # 手动测试或 GitHub 严重延迟时，用最近一个未明确识别的收盘前 slot 标记。
    if now.hour < 14 or (now.hour == 14 and now.minute < 40):
        return "14:30"
    if now.hour == 14 and now.minute < 50:
        return "14:40"
    return "14:50"


def watch_codes(gid):
    """从 Gist 自选读 [(code, name)]。"""
    raw = gist_file(gid, WATCH_FILE) or "[]"
    return [(e["code"], e.get("name")) for e in json.loads(raw)
            if isinstance(e, dict) and e.get("code") and not e.get("deleted")]


def estimate(code):
    """天天基金盘中估值：jsonpgz({...})。返回 name / gszzl(涨跌%) / gztime。"""
    rt = int(datetime.datetime.now().timestamp() * 1000)
    txt = _req(f"https://fundgz.1234567.com.cn/js/{code}.js?rt={rt}",
               headers={"Referer": "http://fund.eastmoney.com/"})
    m = re.search(r"jsonpgz\((.*)\)", txt)
    if not m:
        return None
    d = json.loads(m.group(1))
    return {"name": d.get("name") or code, "gszzl": d.get("gszzl"), "gztime": d.get("gztime") or ""}


def send_notification(title, content):
    """微信推送通道（Server酱 SendKey，兼容旧 SC_SENDKEY Secret）。"""
    sent = False
    if WECHAT_SENDKEY:
        body = urllib.parse.urlencode({"title": title, "desp": content}).encode()
        out = _req(f"https://sctapi.ftqq.com/{WECHAT_SENDKEY}.send", data=body,
                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        print("微信推送:", out[:120])
        sent = True
    if not sent:
        print("未配置微信推送通道（WECHAT_SENDKEY 或 SC_SENDKEY），跳过发送")
    return sent


def main():
    now = datetime.datetime.now(CST)
    today = now.strftime("%Y-%m-%d")
    slot = push_slot(now)
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
            lines.append(f"**{nm}**  {'+' if chg >= 0 else ''}{chg:.2f}%")
        except (TypeError, ValueError):
            lines.append(f"**{nm}**  —")

    if not lines:
        print("无估值数据"); return
    if not fresh and not FORCE:
        print("今日无盘中估值（非交易日/休市），跳过"); return

    title = f"司南基金 · 自选涨跌幅（{slot}）"
    content = "\n".join(f"- {ln}" for ln in lines) + "\n\n> 盘中估值，仅供个人参考，不构成投资建议。"
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
