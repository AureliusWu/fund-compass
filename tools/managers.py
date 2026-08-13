#!/usr/bin/env python3
"""Build the public fund-manager index with fail-closed pagination."""
from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import re

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from static_chunks import atomic_write_json, write_chunks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "public", "data", "managers.json")
URL = "https://fund.eastmoney.com/Data/FundDataPortfolio_Interface.aspx"
HDR = {"User-Agent": "sinan-fund-enrichment/2.0", "Referer": "https://fund.eastmoney.com/manager/"}
PN = 50
CONNECT_TIMEOUT = 8
READ_TIMEOUT = 60
MIN_MANAGERS = 1_000
MIN_PREVIOUS_RATIO = 0.90
MAX_PAGES = 1_000
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
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def fetch_page(page: int, session: requests.Session | None = None) -> str:
    if page < 1:
        raise ValueError("page must be positive")
    client = session or _session()
    response = client.get(
        URL,
        params={"dt": 14, "mc": "returnjson", "ft": "all", "pn": PN, "pi": page,
                "sc": "abbname", "st": "asc"},
        headers=HDR,
        timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
    )
    response.raise_for_status()
    if not str(response.url).lower().startswith("https://"):
        raise RuntimeError("manager response was not delivered over HTTPS")
    response.encoding = "utf-8"
    text = response.text
    if text.lstrip().lower().startswith(("<!doctype html", "<html")):
        raise ValueError(f"manager response is HTML on page {page}")
    return text


def parse_rows(text: str) -> list:
    match = re.search(r"data\s*:\s*(\[.*\])\s*,\s*record", text, re.S)
    if not match:
        raise ValueError("manager response schema changed")
    rows = json.loads(match.group(1))
    if not isinstance(rows, list):
        raise ValueError("manager rows are invalid")
    return rows


def _page_count(text: str) -> int:
    match = re.search(r"pages\s*:\s*\"?(\d+)\"?", text)
    if not match:
        raise ValueError("manager page count is missing")
    pages = int(match.group(1))
    if not 1 <= pages <= MAX_PAGES:
        raise ValueError(f"manager page count is invalid: {pages}")
    return pages


def _record_count(text: str) -> int:
    match = re.search(r"record\s*:\s*\"?(\d+)\"?", text)
    if not match:
        raise ValueError("manager record count is missing")
    records = int(match.group(1))
    if records < 1 or records > MAX_PAGES * PN:
        raise ValueError(f"manager record count is invalid: {records}")
    return records


def _normalize_raw_row(raw, *, context: str = "source") -> dict:
    if not isinstance(raw, list) or len(raw) < 11:
        raise RuntimeError(f"invalid manager row in {context}")
    manager_id = str(raw[0] or "").strip()
    name = str(raw[1] or "").strip()
    company = str(raw[3] or "").strip()
    codes = [code.strip() for code in str(raw[4] or "").split(",") if code.strip()]
    names = [item.strip() for item in str(raw[5] or "").split(",") if item.strip()]
    if not manager_id or not name or not codes:
        raise RuntimeError(f"invalid manager identity in {context}")
    if len(codes) != len(names) or any(not re.fullmatch(r"\d{6}", code) for code in codes):
        raise RuntimeError(f"manager fund mapping is invalid for id={manager_id}")
    if any(not item for item in names):
        raise RuntimeError(f"manager fund names are invalid for id={manager_id}")
    return {
        "id": manager_id,
        "name": name,
        "company": company,
        "codes": codes,
        "names": names,
        "days": str(raw[6] or "").strip(),
        "ret": str(raw[7] or "").strip(),
        "scale": str(raw[10] or "").strip(),
    }


def fetch_all(session: requests.Session | None = None) -> list:
    client = session or _session()
    first = fetch_page(1, client)
    pages = _page_count(first)
    declared_records = _record_count(first)
    expected_pages = math.ceil(declared_records / PN)
    if pages != expected_pages:
        raise RuntimeError(f"manager pagination is inconsistent: pages={pages} record={declared_records}")
    print(f"共 {pages} 页")
    rows = parse_rows(first)
    if not rows:
        raise RuntimeError("manager first page is empty")
    for row_number, row in enumerate(rows, 1):
        _normalize_raw_row(row, context=f"page 1 row {row_number}")
    page_signatures = {
        hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    }
    for page in range(2, pages + 1):
        page_rows = parse_rows(fetch_page(page, client))
        if not page_rows:
            raise RuntimeError(f"manager page {page}/{pages} is empty")
        signature = hashlib.sha256(
            json.dumps(page_rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if signature in page_signatures:
            raise RuntimeError(f"manager page {page}/{pages} duplicates an earlier page")
        page_signatures.add(signature)
        for row_number, row in enumerate(page_rows, 1):
            _normalize_raw_row(row, context=f"page {page} row {row_number}")
        rows.extend(page_rows)
        if page % 20 == 0:
            print(f"  ...{page}/{pages}")
    if len(rows) != declared_records:
        raise RuntimeError(f"manager response is incomplete: {len(rows)}/{declared_records}")
    return rows


def normalize_rows(raw_rows: list) -> list[dict]:
    unique: dict[str, dict] = {}
    for index, raw in enumerate(raw_rows, 1):
        item = _normalize_raw_row(raw, context=f"row {index}")
        manager_id = item["id"]
        previous = unique.get(manager_id)
        if previous is not None and previous != item:
            raise RuntimeError(f"conflicting duplicate manager id={manager_id}")
        unique[manager_id] = item
    return list(unique.values())


def _previous_count(path: str = OUT) -> int:
    try:
        with open(path, encoding="utf-8") as stream:
            payload = json.load(stream)
        rows = payload.get("managers") if isinstance(payload, dict) else None
        return len({str(row.get("id")) for row in rows if isinstance(row, dict) and row.get("id")}) if isinstance(rows, list) else 0
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return 0


def validate_rows(rows: list[dict], previous_count: int = 0) -> None:
    if not isinstance(rows, list) or len(rows) < MIN_MANAGERS:
        raise RuntimeError(f"manager row count is too small: {len(rows) if isinstance(rows, list) else 0}")
    ids: set[str] = set()
    for row in rows:
        manager_id = row.get("id") if isinstance(row, dict) else None
        if not isinstance(manager_id, str) or not manager_id or manager_id in ids:
            raise RuntimeError(f"invalid or duplicate manager id: {manager_id!r}")
        codes = row.get("codes")
        names = row.get("names")
        if not row.get("name") or not isinstance(codes, list) or not isinstance(names, list) or len(codes) != len(names):
            raise RuntimeError(f"invalid manager record: {manager_id}")
        if not codes or any(not isinstance(code, str) or not re.fullmatch(r"\d{6}", code) for code in codes):
            raise RuntimeError(f"invalid manager fund codes: {manager_id}")
        if any(not isinstance(name, str) or not name.strip() for name in names):
            raise RuntimeError(f"invalid manager fund names: {manager_id}")
        if any(not isinstance(row.get(field), str) for field in ("company", "days", "ret", "scale")):
            raise RuntimeError(f"invalid manager metadata: {manager_id}")
        ids.add(manager_id)
    if previous_count and len(rows) < math.floor(previous_count * MIN_PREVIOUS_RATIO):
        raise RuntimeError(f"manager total regressed: {len(rows)}/{previous_count}")


def publish(rows: list[dict], out: str = OUT) -> dict:
    validate_rows(rows, _previous_count(out))
    now = datetime.datetime.now(BEIJING)
    payload = {
        "schema_version": 2,
        "updated": now.date().isoformat(),
        "fetched_at": now.isoformat(timespec="seconds"),
        "source": "eastmoney_fund_managers",
        "managers": rows,
    }
    atomic_write_json(out, payload)
    write_chunks(out, "managers", rows, payload["updated"], size=500)
    return payload


def main() -> None:
    rows = normalize_rows(fetch_all())
    payload = publish(rows)
    print(f"managers total {len(payload['managers'])}")


if __name__ == "__main__":
    main()
