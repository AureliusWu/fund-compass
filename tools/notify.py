#!/usr/bin/env python3
"""司南基金 · 信号推送 + 保活（由 GitHub Actions 定时任务运行，纯 stdlib，无需 pip）。

流程：
  1. ping 后端 /health 预热（顺带免 Render 冷启动）；
  2. 从 Gist 文件 sinan-watchlist.json 读自选代码（与 App 云同步同源）；
  3. 逐只调后端 /fund/{code}/signal 取当前择时信号；
  4. 与上次结果（Gist 文件 sinan-signal-state.json）比对，信号变化才推 Server酱；
  5. 把最新信号写回 Gist 状态文件。
首次运行只播种状态、不推送（避免上来就刷屏）。手动 force 运行会发一条「推送测试」便于校验通道。

环境变量：
  API_BASE     后端 API 基址（默认线上 Render）
  GIST_TOKEN   GitHub PAT（gist 权限，与 App 云同步用的同一个）
  SC_SENDKEY   Server酱 SENDKEY
  FORCE        "1"/"true" 忽略交易时段强制运行 + 发推送测试
"""
import datetime
import json
import os
import urllib.parse
import urllib.request

API_BASE = os.environ.get("API_BASE", "https://fund-compass-api.onrender.com/api").rstrip("/")
GIST_TOKEN = os.environ.get("GIST_TOKEN", "").strip()
SC_SENDKEY = os.environ.get("SC_SENDKEY", "").strip()
FORCE = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")

WATCH_FILE = "sinan-watchlist.json"
STATE_FILE = "sinan-signal-state.json"
GH = "https://api.github.com"
CST = datetime.timezone(datetime.timedelta(hours=8))


def _req(url, data=None, headers=None, method=None, timeout=90):
    h = {"User-Agent": "sinan-bot"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def gh(url, data=None, method=None):
    return _req(url, data=data, method=method, headers={
        "Authorization": f"token {GIST_TOKEN}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    })


def trading_now() -> bool:
    """A 股交易时段：周一~周五 09:30–11:30、13:00–15:00（CST）。"""
    now = datetime.datetime.now(CST)
    if now.weekday() >= 5:
        return False
    m = now.hour * 60 + now.minute
    return (570 <= m <= 690) or (780 <= m <= 900)


def find_gist_id():
    for page in range(1, 6):
        arr = json.loads(gh(f"{GH}/gists?per_page=100&page={page}"))
        if not arr:
            return None
        for g in arr:
            if WATCH_FILE in (g.get("files") or {}):
                return g["id"]
        if len(arr) < 100:
            return None
    return None


def gist_file(gid, name):
    data = json.loads(gh(f"{GH}/gists/{gid}"))
    f = (data.get("files") or {}).get(name)
    if not f:
        return None
    if f.get("truncated") and f.get("raw_url"):  # 大文件 content 被截断时走 raw
        return _req(f["raw_url"], headers={"User-Agent": "sinan-bot"})
    return f.get("content")


def write_state(gid, state):
    body = json.dumps({"files": {STATE_FILE: {
        "content": json.dumps(state, ensure_ascii=False, indent=2)
    }}}).encode()
    gh(f"{GH}/gists/{gid}", data=body, method="PATCH")


def get_signal(code):
    d = json.loads(_req(f"{API_BASE}/fund/{code}/signal", timeout=90))
    return d.get("signal"), (d.get("name") or code)


def notify(title, desp):
    body = urllib.parse.urlencode({"title": title, "desp": desp}).encode()
    out = _req(f"https://sctapi.ftqq.com/{SC_SENDKEY}.send", data=body,
               headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    print("server酱:", out[:160])


def main():
    if not trading_now() and not FORCE:
        print("非交易时段，跳过"); return

    try:
        _req(f"{API_BASE}/health", timeout=120); print("health ok（已保活）")
    except Exception as e:
        print("health ping failed:", e)

    if not GIST_TOKEN:
        print("未配置 GIST_TOKEN，无法读取自选"); return
    gid = find_gist_id()
    if not gid:
        print("未找到自选 Gist（请先在 App 配置云同步并上传自选）"); return

    raw = gist_file(gid, WATCH_FILE)
    entries = json.loads(raw) if raw else []
    codes = [e["code"] for e in entries
             if isinstance(e, dict) and e.get("code") and not e.get("deleted")]
    if not codes:
        print("自选为空"); return

    sraw = gist_file(gid, STATE_FILE)
    state = json.loads(sraw) if sraw else {}
    seeding = not state

    new_state, names, changes = {}, {}, []
    for c in codes:
        try:
            sig, name = get_signal(c)
        except Exception as e:
            print("signal fail", c, e)
            if c in state:
                new_state[c] = state[c]
            continue
        names[c] = name
        if not sig:
            continue
        new_state[c] = sig
        prev = state.get(c)
        if prev and prev != sig:
            changes.append((c, name, prev, sig))

    if FORCE and SC_SENDKEY:  # 手动运行：发一条测试，校验通道
        rows = [f"- **{names.get(c, c)}**（{c}）：{new_state.get(c, '—')}" for c in codes]
        try:
            notify("司南基金 · 推送测试", "当前自选信号：\n" + "\n".join(rows) +
                   "\n\n> 这是手动测试推送，收到即说明通道已通。")
        except Exception as e:
            print("test notify failed:", e)
    elif changes and SC_SENDKEY:  # 定时运行：仅信号变化才推
        title = f"司南基金 · {len(changes)} 只信号变化"
        lines = [f"- **{n}**（{c}）：{p} → **{s}**" for c, n, p, s in changes]
        desp = "\n".join(lines) + "\n\n> 仅供个人参考，不构成投资建议。"
        try:
            notify(title, desp)
        except Exception as e:
            print("notify failed:", e)
    elif changes:
        print("有变化但未配置 SC_SENDKEY：", changes)

    write_state(gid, new_state)
    print(f"codes={len(codes)} changes={len(changes)} seeding={seeding}")


if __name__ == "__main__":
    main()
