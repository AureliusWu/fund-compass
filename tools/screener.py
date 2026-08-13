#!/usr/bin/env python3
"""Build the public fund screener snapshot from Eastmoney ranking data.

The publisher is deliberately fail-closed: every configured fund category must
pass response/schema validation and the result must stay close to the previous
successful snapshot before any public file is replaced.
"""
from __future__ import annotations

import datetime
import json
import math
import os
import re
from collections import Counter

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from static_chunks import atomic_write_json, write_chunks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "screener.json")
URL = "https://fund.eastmoney.com/data/rankhandler.aspx"
HDR = {"User-Agent": "sinan-fund-enrichment/2.0", "Referer": "https://fund.eastmoney.com/data/fundranking.html"}
TYPES = {"gp": "股票型", "hh": "混合型", "zq": "债券型", "zs": "指数型", "qdii": "QDII", "fof": "FOF"}
CONNECT_TIMEOUT = 8
READ_TIMEOUT = 60
MIN_TOTAL = 1_000
MIN_CATEGORY = 20
MIN_PREVIOUS_RATIO = 0.90
MIN_RETURN_COVERAGE = 0.95
BEIJING = datetime.timezone(datetime.timedelta(hours=8), "Asia/Shanghai")


def _session() -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    return session


def num(value):
    if value is None:
        return None
    text = str(value).strip().replace("%", "").replace(",", "")
    if text.lower() in ("", "---", "--", "nan", "null", "none"):
        return None
    try:
        parsed = float(text)
    except (TypeError, ValueError):
        raise ValueError(f"invalid numeric field: {text!r}")
    if not math.isfinite(parsed):
        raise ValueError(f"non-finite numeric field: {text!r}")
    return round(parsed, 2)


def fetch(ft: str, session: requests.Session | None = None) -> list[str]:
    if ft not in TYPES:
        raise ValueError(f"unknown fund category: {ft}")
    client = session or _session()
    response = client.get(
        URL,
        params={"op": "ph", "dt": "kf", "ft": ft, "rs": "", "gs": 0,
                "sc": "1nzf", "st": "desc", "pi": 1, "pn": 20000, "dx": 1},
        headers=HDR,
        timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
    )
    response.raise_for_status()
    if not str(response.url).lower().startswith("https://"):
        raise RuntimeError("ranking response was not delivered over HTTPS")
    response.encoding = "utf-8"
    text = response.text
    if text.lstrip().lower().startswith(("<!doctype html", "<html")):
        raise ValueError(f"ranking response is HTML for {ft}")
    match = re.search(r"datas\s*:\s*(\[.*?\])\s*,\s*allRecords\s*:\s*\"?(\d+)\"?", text, re.S)
    if not match:
        raise ValueError(f"ranking response schema changed for {ft}")
    rows = json.loads(match.group(1))
    if not isinstance(rows, list) or not rows or not all(isinstance(row, str) for row in rows):
        raise ValueError(f"ranking response is empty or invalid for {ft}")
    declared_total = int(match.group(2))
    if declared_total != len(rows):
        raise ValueError(f"ranking response is incomplete for {ft}: {len(rows)}/{declared_total}")
    return rows


def _previous_counts(path: str = OUT) -> Counter:
    try:
        with open(path, encoding="utf-8") as stream:
            payload = json.load(stream)
        rows = payload.get("funds") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return Counter()
        return Counter(row.get("t") for row in rows if isinstance(row, dict) and row.get("t"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return Counter()


def validate_rows(rows: list[dict], previous: Counter | None = None) -> None:
    if not isinstance(rows, list) or len(rows) < MIN_TOTAL:
        raise RuntimeError(f"screener row count is too small: {len(rows) if isinstance(rows, list) else 0}")
    codes: set[str] = set()
    counts: Counter = Counter()
    with_return = 0
    numeric_fields = ("r1m", "r3m", "r6m", "r1y", "r3y", "ytd", "fee")
    required_fields = {"c", "n", "t", *numeric_fields}
    for row in rows:
        code = row.get("c") if isinstance(row, dict) else None
        name = row.get("n") if isinstance(row, dict) else None
        category = row.get("t") if isinstance(row, dict) else None
        if not isinstance(row, dict) or not required_fields.issubset(row):
            raise RuntimeError("screener record is missing required fields")
        if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code) or code in codes:
            raise RuntimeError(f"invalid or duplicate screener code: {code!r}")
        if not isinstance(name, str) or not name.strip() or category not in TYPES.values():
            raise RuntimeError(f"invalid screener identity for {code}")
        for field in numeric_fields:
            value = row.get(field)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                raise RuntimeError(f"invalid {field} for {code}")
        if row.get("fee") is not None and not 0 <= row["fee"] <= 100:
            raise RuntimeError(f"invalid fee for {code}")
        if any(row.get(field) is not None for field in ("r1m", "r3m", "r6m", "r1y", "r3y", "ytd")):
            with_return += 1
        codes.add(code)
        counts[category] += 1

    missing = set(TYPES.values()) - set(counts)
    if missing or any(counts[name] < MIN_CATEGORY for name in TYPES.values()):
        raise RuntimeError(f"screener category coverage is incomplete: {sorted(missing)}")
    if with_return / len(rows) < MIN_RETURN_COVERAGE:
        raise RuntimeError(f"screener return coverage regressed: {with_return}/{len(rows)}")

    baseline = previous or Counter()
    old_total = sum(baseline.values())
    if old_total and len(rows) < math.floor(old_total * MIN_PREVIOUS_RATIO):
        raise RuntimeError(f"screener total regressed: {len(rows)}/{old_total}")
    for category, old_count in baseline.items():
        if old_count >= MIN_CATEGORY and counts[category] < math.floor(old_count * MIN_PREVIOUS_RATIO):
            raise RuntimeError(f"screener category regressed: {category} {counts[category]}/{old_count}")


def build_rows(session: requests.Session | None = None) -> list[dict]:
    client = session or _session()
    seen: set[str] = set()
    rows: list[dict] = []
    for fund_type, type_name in TYPES.items():
        source_rows = fetch(fund_type, client)
        accepted = 0
        for source_index, line in enumerate(source_rows, 1):
            fields = line.split(",")
            if len(fields) < 21:
                raise RuntimeError(f"malformed screener row for {fund_type} at {source_index}")
            code = fields[0].strip()
            name = fields[1].strip()
            if not re.fullmatch(r"\d{6}", code) or not name:
                raise RuntimeError(f"invalid screener identity for {fund_type} at {source_index}")
            if code in seen:
                raise RuntimeError(f"duplicate screener code across categories: {code}")
            seen.add(code)
            rows.append({
                "c": code, "n": name, "t": type_name,
                "r1m": num(fields[8]), "r3m": num(fields[9]), "r6m": num(fields[10]),
                "r1y": num(fields[11]), "r3y": num(fields[13]), "ytd": num(fields[14]),
                "fee": num(fields[20]),
            })
            accepted += 1
        if accepted < MIN_CATEGORY:
            raise RuntimeError(f"too few valid rows for {fund_type}: {accepted}")
        print(f"{type_name}: {accepted}")
    return rows


def publish(rows: list[dict], out: str = OUT) -> dict:
    validate_rows(rows, _previous_counts(out))
    now = datetime.datetime.now(BEIJING)
    payload = {
        "schema_version": 2,
        "updated": now.date().isoformat(),
        "fetched_at": now.isoformat(timespec="seconds"),
        "source": "eastmoney_fund_ranking",
        "funds": rows,
    }
    atomic_write_json(out, payload)
    write_chunks(out, "funds", rows, payload["updated"])
    return payload


def main() -> None:
    rows = build_rows()
    payload = publish(rows)
    print(f"screener total {len(payload['funds'])}")


if __name__ == "__main__":
    main()
