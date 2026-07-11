#!/usr/bin/env python3
"""司南基金 · 选基排行富集（V3-4）。

直连东方财富开放式基金排行接口（纯 requests，无需 akshare/pandas，本机与 CI 均可跑），
抓各类型基金的各期收益 + 手续费，输出 frontend/public/data/screener.json，
前端「排行筛选」客户端按 类型/收益/费率 筛选排序。

数据源：fund.eastmoney.com/data/rankhandler.aspx（与 akshare fund_open_fund_rank_em 同源）。
字段（逗号分隔，按位置）：0代码 1简称 ... 8近1月 9近3月 10近6月 11近1年 13近3年 14今年来 20手续费。
"""
import datetime
import json
import os
import re

import requests
from static_chunks import write_chunks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "screener.json")
HDR = {"User-Agent": "Mozilla/5.0", "Referer": "http://fund.eastmoney.com/data/fundranking.html"}
# 东财排行类型码 → 中文类型
TYPES = {"gp": "股票型", "hh": "混合型", "zq": "债券型", "zs": "指数型", "qdii": "QDII", "fof": "FOF"}


def num(s):
    if s is None:
        return None
    s = str(s).strip().replace("%", "").replace(",", "")
    if s in ("", "---", "--", "nan"):
        return None
    try:
        v = float(s)
        return round(v, 2) if v == v else None
    except ValueError:
        return None


def fetch(ft: str) -> list[str]:
    url = "http://fund.eastmoney.com/data/rankhandler.aspx"
    params = {"op": "ph", "dt": "kf", "ft": ft, "rs": "", "gs": 0,
              "sc": "1nzf", "st": "desc", "pi": 1, "pn": 20000, "dx": 1}
    r = requests.get(url, params=params, headers=HDR, timeout=60)
    r.encoding = "utf-8"
    m = re.search(r"datas:(\[.*?\]),allRecords", r.text, re.S)
    if not m:
        return []
    return json.loads(m.group(1))


def main():
    seen = set()
    rows = []
    for ft, tname in TYPES.items():
        try:
            arr = fetch(ft)
        except Exception as e:
            print("fail", ft, e)
            continue
        print(tname, len(arr))
        for line in arr:
            f = line.split(",")
            if len(f) < 21:
                continue
            code = f[0].strip()
            if not code or code in seen:
                continue
            seen.add(code)
            rows.append({
                "c": code, "n": f[1].strip(), "t": tname,
                "r1m": num(f[8]), "r3m": num(f[9]), "r6m": num(f[10]),
                "r1y": num(f[11]), "r3y": num(f[13]), "ytd": num(f[14]),
                "fee": num(f[20]),
            })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    updated = datetime.date.today().isoformat()
    with open(OUT, "w", encoding="utf-8") as fp:
        json.dump({"updated": updated, "funds": rows},
                  fp, ensure_ascii=False, separators=(",", ":"))
    write_chunks(OUT, "funds", rows, updated)
    print("screener total", len(rows))


if __name__ == "__main__":
    main()
