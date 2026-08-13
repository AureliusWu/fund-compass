#!/usr/bin/env python3
"""Publish public-seed holdings/industry enrichment for portfolio look-through.

This public repository intentionally never reads a private watchlist or Gist.
Only the explicitly reviewed codes in ``tools/enrich_funds.txt`` may become
public filenames or index entries.
"""
from __future__ import annotations

import calendar
import datetime
import json
import math
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from static_chunks import atomic_write_json

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "frontend" / "public" / "data" / "enrich"
FUNDS_FILE = Path(__file__).resolve().with_name("enrich_funds.txt")
SCHEMA_VERSION = 2
SOURCE = "akshare_eastmoney"
BEIJING = datetime.timezone(datetime.timedelta(hours=8), "Asia/Shanghai")
MIN_COVERAGE_RATIO = 0.90
MAX_HOLDINGS = 10
CONNECT_TIMEOUT = 8
READ_TIMEOUT = 60


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


def _safe_get(session: requests.Session, url: str, **kwargs):
    if not isinstance(url, str) or not url.lower().startswith("https://"):
        raise RuntimeError("enrichment source must use HTTPS")
    kwargs.setdefault("timeout", (CONNECT_TIMEOUT, READ_TIMEOUT))
    response = session.get(url, **kwargs)
    response.raise_for_status()
    if not str(response.url).lower().startswith("https://"):
        raise RuntimeError("enrichment response was not delivered over HTTPS")
    return response


def configure_akshare_http() -> None:
    """Give AKShare's two Eastmoney requests bounded HTTPS retry semantics."""
    session = _session()
    requests.get = lambda url, **kwargs: _safe_get(session, url, **kwargs)


def file_codes(path: Path = FUNDS_FILE) -> list[str]:
    if not path.exists():
        raise RuntimeError(f"public seed file is missing: {path.name}")
    codes: list[str] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            value = line.strip()
            if not value or value.startswith("#"):
                continue
            if not re.fullmatch(r"\d{6}", value):
                raise ValueError(f"invalid public seed on line {line_number}")
            codes.append(value)
    if not codes:
        raise RuntimeError("public seed list is empty")
    if len(codes) != len(set(codes)):
        raise ValueError("public seed list contains duplicates")
    return sorted(codes)


def _as_of(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value.date().isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    text = str(value).strip()
    if not text or text.lower() in {"nan", "nat", "none", "null"}:
        return None
    date_match = re.search(r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})", text)
    if date_match:
        try:
            return datetime.date(*(int(part) for part in date_match.groups())).isoformat()
        except ValueError:
            return None
    quarter_match = re.search(r"(20\d{2})(?:年)?\s*(?:第)?([1-4])(?:季|Q)", text, re.I)
    if not quarter_match:
        quarter_match = re.search(r"(20\d{2})\s*Q([1-4])", text, re.I)
    if quarter_match:
        year, quarter = (int(part) for part in quarter_match.groups())
        month = quarter * 3
        return datetime.date(year, month, calendar.monthrange(year, month)[1]).isoformat()
    return None


def _positive_ratio(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        ratio = float(str(value).strip().replace("%", ""))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(ratio) or ratio <= 0 or ratio > 100:
        return None
    return round(ratio, 6)


def _stock_code(value) -> str | None:
    text = str(value or "").strip()
    if text.endswith(".0"):
        text = text[:-2]
    # Mainland codes are six digits; Eastmoney publishes Hong Kong codes with
    # five digits.  Preserve both exactly instead of inventing a leading zero.
    if not text.isdigit() or len(text) not in (5, 6):
        return None
    return text


def _clean_name(value) -> str | None:
    text = str(value or "").strip()
    return None if not text or text.lower() in {"nan", "none", "null"} else text


def _latest_records(frame, period_column: str | None) -> tuple[list[dict], str | None]:
    records = frame.to_dict("records")
    if not isinstance(records, list) or not records:
        return [], None
    if not period_column:
        return records, None
    dated = [(record, _as_of(record.get(period_column))) for record in records]
    valid_dates = [as_of for _, as_of in dated if as_of]
    if valid_dates:
        latest = max(valid_dates)
        return [record for record, as_of in dated if as_of == latest], latest
    first_period = records[0].get(period_column)
    return [record for record in records if record.get(period_column) == first_period], None


def enrich_one(ak, code: str, *, now: datetime.datetime | None = None) -> dict:
    """Fetch one public seed; source failures degrade fields, never their semantics."""
    current = (now or datetime.datetime.now(BEIJING)).astimezone(BEIJING)
    years = [str(current.year), str(current.year - 1)]
    holdings: list[dict] = []
    industries: list[dict] = []
    holdings_as_of: str | None = None
    industries_as_of: str | None = None

    for year in years:
        try:
            frame = ak.fund_portfolio_hold_em(symbol=code, date=year)
        except Exception as error:
            print(f"[warn] holdings source attempt failed: {type(error).__name__}")
            continue
        if frame is None or not len(frame):
            continue
        period_column = "季度" if "季度" in frame.columns else None
        records, observed = _latest_records(frame, period_column)
        for record in records:
            stock_code = _stock_code(record.get("股票代码"))
            name = _clean_name(record.get("股票名称"))
            ratio = _positive_ratio(record.get("占净值比例"))
            if stock_code and name and ratio is not None:
                holdings.append({"code": stock_code, "name": name, "ratio": ratio})
        if holdings:
            holdings_as_of = observed
            holdings = holdings[:MAX_HOLDINGS]
            break

    for year in years:
        try:
            frame = ak.fund_portfolio_industry_allocation_em(symbol=code, date=year)
        except Exception as error:
            print(f"[warn] industries source attempt failed: {type(error).__name__}")
            continue
        if frame is None or not len(frame):
            continue
        period_column = "截止时间" if "截止时间" in frame.columns else None
        records, observed = _latest_records(frame, period_column)
        name_column = next((name for name in ("行业类别", "行业名称", "行业") if name in frame.columns), None)
        if not name_column:
            continue
        for record in records:
            name = _clean_name(record.get(name_column))
            ratio = _positive_ratio(record.get("占净值比例"))
            if name and ratio is not None:
                industries.append({"name": name, "ratio": ratio})
        if industries:
            industries_as_of = observed
            break

    return {
        "schema_version": SCHEMA_VERSION,
        "code": code,
        "source": SOURCE,
        "fetched_at": current.isoformat(timespec="seconds"),
        "holdings_as_of": holdings_as_of,
        "industries_as_of": industries_as_of,
        "holdings": holdings,
        "industries": industries,
    }


def validate_result(data: dict, expected_code: str) -> None:
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
        raise RuntimeError("invalid enrichment schema")
    if data.get("code") != expected_code or data.get("source") != SOURCE:
        raise RuntimeError("enrichment identity mismatch")
    try:
        fetched_at = datetime.datetime.fromisoformat(data["fetched_at"])
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("invalid enrichment fetched_at") from error
    if fetched_at.tzinfo is None or fetched_at.utcoffset() != datetime.timedelta(hours=8):
        raise RuntimeError("enrichment fetched_at must use Beijing offset")
    holdings = data.get("holdings")
    industries = data.get("industries")
    if not isinstance(holdings, list) or not holdings or not isinstance(industries, list) or not industries:
        raise RuntimeError("enrichment holdings or industries are missing")
    if holdings and not data.get("holdings_as_of"):
        raise RuntimeError("non-empty enrichment holdings require holdings_as_of")
    if industries and not data.get("industries_as_of"):
        raise RuntimeError("non-empty enrichment industries require industries_as_of")
    holding_codes: set[str] = set()
    holding_ratio = 0.0
    for row in holdings:
        if (not isinstance(row, dict) or not isinstance(row.get("code"), str)
                or not re.fullmatch(r"\d{5,6}", row["code"])
                or not isinstance(row.get("name"), str) or not _clean_name(row.get("name"))
                or isinstance(row.get("ratio"), bool) or not isinstance(row.get("ratio"), (int, float))
                or _positive_ratio(row.get("ratio")) is None):
            raise RuntimeError("invalid enrichment holding")
        if row["code"] in holding_codes:
            raise RuntimeError("duplicate enrichment holding")
        holding_codes.add(row["code"])
        holding_ratio += float(row["ratio"])
    if holding_ratio > 100.001:
        raise RuntimeError("enrichment holding ratios exceed 100%")
    industry_names: set[str] = set()
    industry_ratio = 0.0
    for row in industries:
        if (not isinstance(row, dict) or not isinstance(row.get("name"), str) or not _clean_name(row.get("name"))
                or isinstance(row.get("ratio"), bool) or not isinstance(row.get("ratio"), (int, float))
                or _positive_ratio(row.get("ratio")) is None):
            raise RuntimeError("invalid enrichment industry")
        if row["name"] in industry_names:
            raise RuntimeError("duplicate enrichment industry")
        industry_names.add(row["name"])
        industry_ratio += float(row["ratio"])
    if industry_ratio > 100.001:
        raise RuntimeError("enrichment industry ratios exceed 100%")
    for field in ("holdings_as_of", "industries_as_of"):
        value = data.get(field)
        if value is not None and _as_of(value) != value:
            raise RuntimeError(f"invalid {field}")


def publish(results: dict[str, dict], expected_codes: list[str], out_dir: Path = OUT_DIR) -> dict:
    expected = set(expected_codes)
    if not expected or set(results) - expected:
        raise RuntimeError("enrichment output is outside the public seed allowlist")
    required = math.ceil(len(expected) * MIN_COVERAGE_RATIO)
    successful = {code: data for code, data in results.items() if data.get("holdings")}
    if len(successful) < required:
        raise RuntimeError(f"enrichment coverage regressed: {len(successful)}/{len(expected)}")
    if set(successful) != expected:
        raise RuntimeError("not every public seed has a valid enrichment result")
    for code, data in successful.items():
        validate_result(data, code)

    out_dir.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".enrich-stage-", dir=out_dir.parent))
    try:
        index_rows = []
        for code in sorted(successful):
            data = successful[code]
            atomic_write_json(stage / f"{code}.json", data)
            index_rows.append({
                "code": code,
                "holdings_as_of": data["holdings_as_of"],
                "industries_as_of": data["industries_as_of"],
                "n_holdings": len(data["holdings"]),
                "n_industries": len(data["industries"]),
            })
        fetched_at = next(iter(successful.values()))["fetched_at"]
        index = {
            "schema_version": SCHEMA_VERSION,
            "source": SOURCE,
            "fetched_at": fetched_at,
            "funds": index_rows,
        }
        atomic_write_json(stage / "index.json", index)

        out_dir.mkdir(parents=True, exist_ok=True)
        for code in sorted(successful):
            os.replace(stage / f"{code}.json", out_dir / f"{code}.json")
        os.replace(stage / "index.json", out_dir / "index.json")  # publish manifest last

        allowed_files = {f"{code}.json" for code in expected} | {"index.json"}
        for existing in out_dir.glob("*.json"):
            if existing.name not in allowed_files:
                existing.unlink()
        return index
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def main() -> int:
    import akshare as ak  # CI-only dependency

    configure_akshare_http()
    codes = file_codes()
    print(f"public seeds: {len(codes)}")
    results: dict[str, dict] = {}
    for index, code in enumerate(codes, 1):
        print(f"enrich progress: {index}/{len(codes)}")
        data = enrich_one(ak, code)
        if data["holdings"]:
            results[code] = data
        else:
            print("[warn] one public seed has no holdings")
    index = publish(results, codes)
    print(f"done: {len(index['funds'])} public funds enriched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
