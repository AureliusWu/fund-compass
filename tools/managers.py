#!/usr/bin/env python3
"""司南基金 · 基金经理索引富集（V3）。

直连东方财富基金经理数据接口（纯 requests，本机+CI 均可跑），一次取全部基金经理及其
在管基金（代码+名称）+ 公司 / 任职回报 / 规模，输出 frontend/public/data/managers.json，
前端「基金经理」搜索客户端按姓名匹配，点基金进已有详情页。

数据源：fund.eastmoney.com/Data/FundDataPortfolio_Interface.aspx（dt=14 基金经理）。
行字段：[0]经理ID [1]姓名 [3]公司 [4]在管基金代码(逗号) [5]在管基金名称(逗号)
        [6]从业天数 [7]任职回报% [10]在管规模。
"""
import datetime
import json
import os
import re

import requests
from static_chunks import write_chunks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "managers.json")
HDR = {"User-Agent": "Mozilla/5.0", "Referer": "http://fund.eastmoney.com/manager/"}


PN = 50  # 接口每页上限约 50，需分页


def fetch_page(pi: int) -> str:
    r = requests.get(
        "http://fund.eastmoney.com/Data/FundDataPortfolio_Interface.aspx",
        params={"dt": 14, "mc": "returnjson", "ft": "all", "pn": PN, "pi": pi, "sc": "abbname", "st": "asc"},
        headers=HDR, timeout=60,
    )
    r.encoding = "utf-8"
    return r.text


def parse_rows(txt: str) -> list:
    m = re.search(r"data:(\[.*\]),record", txt, re.S)
    return json.loads(m.group(1)) if m else []


def main():
    txt = fetch_page(1)
    pm = re.search(r"pages:(\d+)", txt)
    pages = int(pm.group(1)) if pm else 1
    print(f"共 {pages} 页")
    arr = parse_rows(txt)
    for pi in range(2, pages + 1):
        try:
            arr += parse_rows(fetch_page(pi))
        except Exception as e:
            print("page", pi, "fail", e)
        if pi % 20 == 0:
            print(f"  ...{pi}/{pages}")
    out = []
    for x in arr:
        if len(x) < 8:
            continue
        codes = [c for c in str(x[4]).split(",") if c]
        names = [n for n in str(x[5]).split(",") if n]
        if not x[1] or not codes:
            continue
        out.append({
            "id": x[0], "name": x[1], "company": x[3],
            "codes": codes, "names": names,
            "days": x[6], "ret": x[7], "scale": x[10] if len(x) > 10 else "",
        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    updated = datetime.date.today().isoformat()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"updated": updated, "managers": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    write_chunks(OUT, "managers", out, updated, size=500)
    print("managers total", len(out))


if __name__ == "__main__":
    main()
