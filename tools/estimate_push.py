#!/usr/bin/env python3
"""司南基金 · 交易日 14:20 自选估值推送（V3）。

读 Gist 自选 → 抓天天基金盘中估值（涨跌%）→ 仅当日有估值（=交易日，自动避开周末/节假日）
才推送 Server酱。与 V2-6 的 notify.py 互不影响（独立脚本与工作流，复用同名 Secret）。

环境变量：GIST_TOKEN、SC_SENDKEY（与 V2-6 同源）、FORCE（忽略交易日判断强制发，用于测试）。
纯 stdlib，无需 pip。
"""
import datetime
import json
import os
import re
import urllib.parse
import urllib.request

GIST_TOKEN = os.environ.get("GIST_TOKEN", "").strip()
SC_SENDKEY = os.environ.get("SC_SENDKEY", "").strip()
FORCE = os.environ.get("FORCE", "").lower() in ("1", "true", "yes")
WATCH_FILE = "sinan-watchlist.json"
GH = "https://api.github.com"
CST = datetime.timezone(datetime.timedelta(hours=8))


def _req(url, data=None, headers=None, method=None, timeout=30):
    h = {"User-Agent": "sinan-bot"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def _gh(url):
    return _req(url, headers={"Authorization": f"token {GIST_TOKEN}", "Accept": "application/vnd.github+json"})


def gist_codes():
    """从 Gist 自选读 [(code, name)]。"""
    if not GIST_TOKEN:
        return []
    for page in range(1, 6):
        arr = json.loads(_gh(f"{GH}/gists?per_page=100&page={page}"))
        if not arr:
            return []
        for g in arr:
            if WATCH_FILE in (g.get("files") or {}):
                data = json.loads(_gh(f'{GH}/gists/{g["id"]}'))
                raw = (data.get("files") or {}).get(WATCH_FILE, {}).get("content") or "[]"
                return [(e["code"], e.get("name")) for e in json.loads(raw)
                        if isinstance(e, dict) and e.get("code") and not e.get("deleted")]
        if len(arr) < 100:
            return []
    return []


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
    """推送通道（当前 Server酱）。后续扩展企业微信/Telegram/PushPlus 时在此按 env 增加分支即可。"""
    sent = False
    if SC_SENDKEY:
        body = urllib.parse.urlencode({"title": title, "desp": content}).encode()
        out = _req(f"https://sctapi.ftqq.com/{SC_SENDKEY}.send", data=body,
                   headers={"Content-Type": "application/x-www-form-urlencoded"})
        print("server酱:", out[:120])
        sent = True
    if not sent:
        print("未配置任何推送通道（SC_SENDKEY），跳过发送")


def main():
    now = datetime.datetime.now(CST)
    if now.weekday() >= 5 and not FORCE:
        print("周末，跳过"); return
    if not GIST_TOKEN:
        print("未配置 GIST_TOKEN，无法读自选"); return
    codes = gist_codes()
    if not codes:
        print("自选为空"); return

    today = now.strftime("%Y-%m-%d")
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

    title = f'司南基金 · 今日估值（{now.strftime("%H:%M")}）'
    content = "\n".join(f"- {ln}" for ln in lines) + "\n\n> 盘中估值，仅供个人参考，不构成投资建议。"
    send_notification(title, content)
    print(f"pushed {len(lines)} funds, fresh={fresh}")


if __name__ == "__main__":
    main()
