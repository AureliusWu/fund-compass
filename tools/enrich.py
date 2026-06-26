#!/usr/bin/env python3
"""司南基金 · AKShare 离线富集任务（GitHub Actions 跑，不进实时请求路径）。

为「待富集」的基金抓取完整持仓 + 行业配置，输出静态 JSON 到 frontend/public/data/enrich/，
随 GitHub Pages 部署，前端做持仓穿透（V3-3）时消费；缺数据时前端回退到 jjcc 前十大。

待富集基金来源（并集）：
  1. Gist 自选（sinan-watchlist.json，需 GIST_TOKEN，与 V2-6 同源）——覆盖用户实际持有；
  2. tools/enrich_funds.txt（每行一个 6 位代码，# 注释）——种子/兜底，离线也有数据。

环境变量：GIST_TOKEN（可选）。依赖：akshare（见 requirements-enrich.txt）。
本机 python 3.14 装不了 akshare，本脚本主要在 CI（3.12）运行。
"""
import datetime
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "frontend", "public", "data", "enrich")
FUNDS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "enrich_funds.txt")
GIST_TOKEN = os.environ.get("GIST_TOKEN", "").strip()
WATCH_FILE = "sinan-watchlist.json"
GH = "https://api.github.com"


def gist_codes() -> list[str]:
    if not GIST_TOKEN:
        return []
    try:
        hdr = {"Authorization": f"token {GIST_TOKEN}", "Accept": "application/vnd.github+json",
               "User-Agent": "sinan-enrich"}
        for page in range(1, 6):
            req = urllib.request.Request(f"{GH}/gists?per_page=100&page={page}", headers=hdr)
            arr = json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
            if not arr:
                return []
            for g in arr:
                if WATCH_FILE in (g.get("files") or {}):
                    gid = g["id"]
                    req2 = urllib.request.Request(f"{GH}/gists/{gid}", headers=hdr)
                    data = json.loads(urllib.request.urlopen(req2, timeout=30).read().decode("utf-8"))
                    raw = (data.get("files") or {}).get(WATCH_FILE, {}).get("content") or "[]"
                    return [e["code"] for e in json.loads(raw)
                            if isinstance(e, dict) and e.get("code") and not e.get("deleted")]
            if len(arr) < 100:
                return []
    except Exception as e:
        print("gist read failed:", e)
    return []


def file_codes() -> list[str]:
    if not os.path.exists(FUNDS_FILE):
        return []
    with open(FUNDS_FILE, encoding="utf-8") as f:
        return [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]


def enrich_one(ak, code: str) -> dict:
    """抓单只基金最新一期持仓 + 行业配置。akshare 接口随版本变动，做防御性处理。"""
    out = {"code": code, "updated": datetime.date.today().isoformat(), "holdings": [], "industries": []}
    years = [str(datetime.date.today().year), str(datetime.date.today().year - 1)]

    for y in years:
        try:
            df = ak.fund_portfolio_hold_em(symbol=code, date=y)
        except Exception:
            df = None
        if df is not None and len(df):
            # 取最新季度
            if "季度" in df.columns:
                df = df[df["季度"] == df["季度"].iloc[0]]
            recs = df.to_dict("records")
            for r in recs[:10]:
                c = str(r.get("股票代码", "")).strip()
                n = str(r.get("股票名称", "")).strip()
                try:
                    ratio = float(r.get("占净值比例"))
                except (TypeError, ValueError):
                    ratio = 0.0
                if c and n:
                    out["holdings"].append({"code": c, "name": n, "ratio": ratio})
            if out["holdings"]:
                break

    for y in years:
        try:
            di = ak.fund_portfolio_industry_allocation_em(symbol=code, date=y)
        except Exception:
            di = None
        if di is not None and len(di):
            if "截止时间" in di.columns:
                di = di[di["截止时间"] == di["截止时间"].iloc[0]]
            col = "行业类别" if "行业类别" in di.columns else di.columns[1]
            for r in di.to_dict("records"):
                name = str(r.get(col, "")).strip()
                try:
                    ratio = float(r.get("占净值比例"))
                except (TypeError, ValueError):
                    ratio = 0.0
                if name and ratio:
                    out["industries"].append({"name": name, "ratio": ratio})
            if out["industries"]:
                break

    return out


def main():
    import akshare as ak  # 仅 CI 有

    codes = sorted(set(gist_codes()) | set(file_codes()))
    if not codes:
        print("无待富集基金"); return
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"待富集 {len(codes)} 只：{codes}")
    index = []
    for i, code in enumerate(codes, 1):
        print(f"[{i}/{len(codes)}] 抓取 {code} …")
        try:
            data = enrich_one(ak, code)
        except Exception as e:
            print("enrich fail", code, e); continue
        if not data["holdings"]:
            print("skip(no holdings)", code); continue
        with open(os.path.join(OUT_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        index.append({"code": code, "updated": data["updated"],
                      "n_holdings": len(data["holdings"]), "n_industries": len(data["industries"])})
        print("ok", code, len(data["holdings"]), "holdings")
    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"updated": datetime.date.today().isoformat(), "funds": index}, f, ensure_ascii=False)
    print(f"done: {len(index)} funds enriched")


if __name__ == "__main__":
    sys.exit(main())
