import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest
import requests


ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def load_tool(name: str):
    spec = importlib.util.spec_from_file_location(f"test_{name}", TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


enrich = load_tool("enrich")
screener = load_tool("screener")
managers = load_tool("managers")
static_chunks = load_tool("static_chunks")
index_valuation = load_tool("enrich_index_valuation")


class Response:
    def __init__(self, text, *, status=200, url="https://fund.eastmoney.com/source"):
        self.text = text
        self.status_code = status
        self.url = url
        self.encoding = None

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


class Session:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


class FakeSeries:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return list(self.values)


class FakeFrame:
    def __init__(self, **columns):
        self.data = columns
        self.columns = list(columns)

    def __len__(self):
        return len(next(iter(self.data.values()))) if self.data else 0

    def __getitem__(self, key):
        return FakeSeries(self.data[key])


class FakeAkshare:
    def __init__(self, frame):
        self.frame = frame

    def stock_index_pe_lg(self, symbol):
        return self.frame


def screener_row(code="000001"):
    fields = [""] * 21
    fields[0] = code
    fields[1] = "示例基金"
    for index, value in zip((8, 9, 10, 11, 13, 14, 20), ("1", "2", "3", "4", "5", "6", "0.1")):
        fields[index] = value
    return ",".join(fields)


def manager_row(manager_id="1"):
    return [manager_id, "经理", "", "公司", "000001", "示例基金", "100", "10", "", "", "1亿"]


def test_public_seed_parser_rejects_private_or_invalid_codes(tmp_path):
    seed = tmp_path / "funds.txt"
    seed.write_text("# public only\n000001\n005827\n", encoding="utf-8")
    assert enrich.file_codes(seed) == ["000001", "005827"]

    seed.write_text("000001\nprivate-code\n", encoding="utf-8")
    with pytest.raises(ValueError):
        enrich.file_codes(seed)


def test_public_artifacts_are_exactly_the_reviewed_seed_allowlist():
    seeds = set(enrich.file_codes())
    published = {
        path.stem for path in enrich.OUT_DIR.glob("*.json") if path.name != "index.json"
    }
    assert published == seeds
    index = json.loads((enrich.OUT_DIR / "index.json").read_text(encoding="utf-8"))
    assert index["schema_version"] == 2
    assert index["source"] == "akshare_eastmoney"
    assert {row["code"] for row in index["funds"]} == seeds
    for code in seeds:
        payload = json.loads((enrich.OUT_DIR / f"{code}.json").read_text(encoding="utf-8"))
        enrich.validate_result(payload, code)


def test_enrichment_source_has_no_private_gist_reader():
    source = (TOOLS / "enrich.py").read_text(encoding="utf-8")
    assert "GIST_TOKEN" not in source
    assert "api.github.com" not in source
    assert not hasattr(enrich, "gist_codes")


def test_enrichment_publish_is_allowlist_only_and_fail_closed(tmp_path):
    output = tmp_path / "enrich"
    output.mkdir()
    sentinel = output / "000001.json"
    sentinel.write_bytes(b"old")
    with pytest.raises(RuntimeError):
        enrich.publish({}, ["000001"], output)
    assert sentinel.read_bytes() == b"old"

    payload = {
        "schema_version": 2,
        "code": "000001",
        "source": "akshare_eastmoney",
        "fetched_at": "2026-08-12T12:00:00+08:00",
        "holdings_as_of": "2026-06-30",
        "industries_as_of": None,
        "holdings": [{"code": "600000", "name": "示例股票", "ratio": 10.0}],
        "industries": [],
    }
    with pytest.raises(RuntimeError):
        enrich.publish({"000001": payload, "005827": {**payload, "code": "005827"}}, ["000001"], output)
    assert sentinel.read_bytes() == b"old"


def test_missing_ratio_is_not_coerced_to_zero():
    assert enrich._positive_ratio(None) is None
    assert enrich._positive_ratio("") is None
    assert enrich._positive_ratio("nan") is None
    assert enrich._positive_ratio(0) is None
    assert enrich._positive_ratio("1.25%") == 1.25


@pytest.mark.parametrize("missing_field", ["holdings_as_of", "industries_as_of"])
def test_nonempty_enrichment_requires_matching_disclosure_date(missing_field):
    payload = {
        "schema_version": 2,
        "code": "000001",
        "source": "akshare_eastmoney",
        "fetched_at": "2026-08-12T12:00:00+08:00",
        "holdings_as_of": "2026-06-30",
        "industries_as_of": "2026-06-30",
        "holdings": [{"code": "600000", "name": "示例股票", "ratio": 10.0}],
        "industries": [{"name": "银行", "ratio": 10.0}],
    }
    payload[missing_field] = None

    with pytest.raises(RuntimeError, match="require"):
        enrich.validate_result(payload, "000001")


def test_enrichment_rejects_duplicate_or_overallocated_rows():
    payload = {
        "schema_version": 2,
        "code": "000001",
        "source": "akshare_eastmoney",
        "fetched_at": "2026-08-12T12:00:00+08:00",
        "holdings_as_of": "2026-06-30",
        "industries_as_of": "2026-06-30",
        "holdings": [
            {"code": "600000", "name": "示例股票", "ratio": 60.0},
            {"code": "600000", "name": "重复股票", "ratio": 40.0},
        ],
        "industries": [{"name": "银行", "ratio": 10.0}],
    }
    with pytest.raises(RuntimeError, match="duplicate"):
        enrich.validate_result(payload, "000001")

    payload["holdings"][1]["code"] = "600001"
    payload["holdings"][1]["ratio"] = 41.0
    with pytest.raises(RuntimeError, match="exceed"):
        enrich.validate_result(payload, "000001")


def test_enrichment_http_requires_https_status_and_timeout():
    session = Session(Response("ok"))
    assert enrich._safe_get(session, "https://fund.example/source").text == "ok"
    _, kwargs = session.calls[0]
    assert kwargs["timeout"] == (enrich.CONNECT_TIMEOUT, enrich.READ_TIMEOUT)

    with pytest.raises(RuntimeError):
        enrich._safe_get(session, "http://fund.example/source")
    with pytest.raises(requests.HTTPError):
        enrich._safe_get(Session(Response("rate limited", status=429)), "https://fund.example/source")


@pytest.mark.parametrize("status", [429, 500])
def test_screener_rejects_http_failures(status):
    with pytest.raises(requests.HTTPError):
        screener.fetch("gp", Session(Response("failure", status=status)))


@pytest.mark.parametrize("body", ["<html>blocked</html>", "var rankData={datas:[],allRecords:0}", "unexpected"])
def test_screener_rejects_html_empty_and_schema_drift(body):
    with pytest.raises(ValueError):
        screener.fetch("gp", Session(Response(body)))


def test_screener_uses_https_and_bounded_timeout():
    session = Session(Response(f"var rankData={{datas:{json.dumps([screener_row()])},allRecords:1}}"))
    assert screener.fetch("gp", session) == [screener_row()]
    url, kwargs = session.calls[0]
    assert url.startswith("https://")
    assert kwargs["timeout"] == (screener.CONNECT_TIMEOUT, screener.READ_TIMEOUT)


def test_screener_rejects_all_records_mismatch():
    body = f"var rankData={{datas:{json.dumps([screener_row()])},allRecords:2}}"
    with pytest.raises(ValueError, match="incomplete"):
        screener.fetch("gp", Session(Response(body)))


def test_screener_rejects_malformed_source_row(monkeypatch):
    monkeypatch.setattr(screener, "fetch", lambda kind, session=None: ["too,few,fields"])
    with pytest.raises(RuntimeError, match="malformed"):
        screener.build_rows()


def test_screener_rejects_illegal_numeric_source_field(monkeypatch):
    row = screener_row()
    fields = row.split(",")
    fields[8] = "not-a-number"
    monkeypatch.setattr(screener, "fetch", lambda kind, session=None: [",".join(fields)])
    with pytest.raises(ValueError, match="invalid numeric"):
        screener.build_rows()


def test_screener_partial_failure_never_publishes(monkeypatch, tmp_path):
    output = tmp_path / "screener.json"
    output.write_bytes(b"old")
    monkeypatch.setattr(screener, "OUT", str(output))
    monkeypatch.setattr(screener, "fetch", lambda kind, session=None: (_ for _ in ()).throw(RuntimeError("source down")))
    with pytest.raises(RuntimeError):
        screener.build_rows()
    assert output.read_bytes() == b"old"


def test_manager_fetch_requires_every_page(monkeypatch):
    first = f"returnjson={{data:{json.dumps([manager_row()])},record:51,pages:2}}"
    monkeypatch.setattr(managers, "fetch_page", lambda page, session=None: first if page == 1 else "<html>blocked</html>")
    with pytest.raises(ValueError):
        managers.fetch_all(Session(Response(first)))


def test_manager_fetch_checks_declared_record_count(monkeypatch):
    first = f"returnjson={{data:{json.dumps([manager_row()])},record:2,pages:1}}"
    monkeypatch.setattr(managers, "fetch_page", lambda page, session=None: first)
    with pytest.raises(RuntimeError, match="incomplete"):
        managers.fetch_all(Session(Response(first)))


def test_manager_fetch_rejects_duplicate_pages(monkeypatch):
    page_rows = [manager_row(str(index)) for index in range(managers.PN)]
    body = f"returnjson={{data:{json.dumps(page_rows)},record:100,pages:2}}"
    monkeypatch.setattr(managers, "fetch_page", lambda page, session=None: body)
    with pytest.raises(RuntimeError, match="duplicates an earlier page"):
        managers.fetch_all(Session(Response(body)))


def test_manager_normalization_fails_closed_on_illegal_row():
    with pytest.raises(RuntimeError, match="invalid manager row"):
        managers.normalize_rows([["too", "short"]])


def test_manager_duplicate_id_is_deduplicated_or_rejected():
    one = manager_row("1")
    assert len(managers.normalize_rows([one, one])) == 1
    conflict = manager_row("1")
    conflict[1] = "另一位经理"
    with pytest.raises(RuntimeError):
        managers.normalize_rows([one, conflict])


def test_manager_publish_regression_does_not_touch_previous_file(tmp_path, monkeypatch):
    output = tmp_path / "managers.json"
    previous = {"managers": [{"id": str(index)} for index in range(100)]}
    output.write_text(json.dumps(previous), encoding="utf-8")
    monkeypatch.setattr(managers, "MIN_MANAGERS", 1)
    valid = [{
        "id": str(index), "name": "经理", "company": "公司",
        "codes": ["000001"], "names": ["基金"], "days": "1", "ret": "1", "scale": "1",
    } for index in range(80)]
    before = output.read_bytes()
    with pytest.raises(RuntimeError):
        managers.publish(valid, str(output))
    assert output.read_bytes() == before


def test_chunk_manifest_is_last_and_has_integrity(tmp_path, monkeypatch):
    out = tmp_path / "dataset.json"
    writes = []
    original = static_chunks.atomic_write_json

    def record(path, payload):
        writes.append(Path(path).name)
        original(path, payload)

    monkeypatch.setattr(static_chunks, "atomic_write_json", record)
    rows = [{"id": index} for index in range(5)]
    static_chunks.write_chunks(str(out), "items", rows, "2026-08-12", size=2)

    assert writes[-1] == "manifest.json"
    manifest = json.loads((tmp_path / "dataset" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 2
    assert manifest["total"] == len(rows)
    assert manifest["sha256"] == hashlib.sha256(
        json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    for filename, digest in manifest["chunk_sha256"].items():
        assert hashlib.sha256((tmp_path / "dataset" / filename).read_bytes()).hexdigest() == digest


def test_index_valuation_missing_core_fails_without_overwriting(tmp_path, monkeypatch):
    output = tmp_path / "index-valuation.json"
    output.write_bytes(b"old")
    fake_akshare = object()
    monkeypatch.setitem(sys.modules, "akshare", fake_akshare)
    monkeypatch.setattr(index_valuation, "OUT", str(output))
    monkeypatch.setattr(index_valuation, "fetch_index_valuation", lambda ak: [{
        "name": "沪深300", "date": "2026-08-12", "pe": 12, "pe_pct": 50,
        "pb": 1.2, "pb_pct": 40,
    }])

    assert index_valuation.main() == 1
    assert output.read_bytes() == b"old"


def test_index_valuation_uses_source_date_and_reports_optional_gaps(tmp_path, monkeypatch):
    output = tmp_path / "index-valuation.json"
    fake_akshare = object()
    monkeypatch.setitem(sys.modules, "akshare", fake_akshare)
    monkeypatch.setattr(index_valuation, "OUT", str(output))
    rows = [{
        "name": name,
        "date": "2026-08-11" if name == "沪深300" else "2026-08-12",
        "pe": 12,
        "pe_pct": 50,
        "pe_date": "2026-08-11" if name == "沪深300" else "2026-08-12",
        "pb": 1.2,
        "pb_pct": 40,
        "pb_date": "2026-08-11" if name == "沪深300" else "2026-08-12",
    } for name in sorted(index_valuation.CORE_INDICES)]
    monkeypatch.setattr(index_valuation, "fetch_index_valuation", lambda ak: rows)

    assert index_valuation.main() == 0
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 2
    assert payload["updated"] == "2026-08-11"
    assert payload["fetched_at"].endswith("+08:00")
    assert payload["coverage"]["core_returned"] == len(index_valuation.CORE_INDICES)
    assert payload["coverage"]["returned"] == len(rows)
    assert set(payload["coverage"]["missing"]) == set(index_valuation.LG_SYMBOLS) - index_valuation.CORE_INDICES


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("pe", None), ("pe", 0), ("pb", None), ("pb", 0),
        ("pe_pct", None), ("pe_pct", 101), ("pb_pct", None), ("pb_pct", 101),
        ("date", None), ("date", "2026-02-31"),
    ],
)
def test_index_valuation_rejects_invalid_core_evidence(field, value, tmp_path, monkeypatch):
    output = tmp_path / "index-valuation.json"
    output.write_bytes(b"old")
    fake_akshare = object()
    monkeypatch.setitem(sys.modules, "akshare", fake_akshare)
    monkeypatch.setattr(index_valuation, "OUT", str(output))
    rows = [{
        "name": name, "date": "2026-08-12", "pe": 12, "pe_pct": 50,
        "pe_date": "2026-08-12", "pb": 1.2, "pb_pct": 40, "pb_date": "2026-08-12",
    } for name in sorted(index_valuation.CORE_INDICES)]
    rows[0][field] = value
    monkeypatch.setattr(index_valuation, "fetch_index_valuation", lambda ak: rows)

    assert index_valuation.main() == 1
    assert output.read_bytes() == b"old"


def test_index_valuation_rejects_core_pe_pb_date_mismatch(tmp_path, monkeypatch):
    output = tmp_path / "index-valuation.json"
    output.write_bytes(b"old")
    fake_akshare = object()
    monkeypatch.setitem(sys.modules, "akshare", fake_akshare)
    monkeypatch.setattr(index_valuation, "OUT", str(output))
    rows = [{
        "name": name, "date": "2026-08-12", "pe": 12, "pe_pct": 50,
        "pe_date": "2026-08-12", "pb": 1.2, "pb_pct": 40, "pb_date": "2026-08-12",
    } for name in sorted(index_valuation.CORE_INDICES)]
    rows[0]["pb_date"] = "2026-08-11"
    monkeypatch.setattr(index_valuation, "fetch_index_valuation", lambda ak: rows)

    assert index_valuation.main() == 1
    assert output.read_bytes() == b"old"


def test_index_fetch_rejects_pe_pb_source_date_mismatch(monkeypatch):
    def fake_series(ak, fn_name, sym, prefer, dump_cols):
        if fn_name == "stock_index_pe_lg":
            return 12.0, 50.0, "2026-08-12", "滚动市盈率"
        return 1.2, 40.0, "2026-08-11", "市净率"

    monkeypatch.setattr(index_valuation, "_series_from", fake_series)

    assert index_valuation._fetch_one_index(object(), "沪深300", ["沪深300"], False) is None


def test_index_series_sorts_parseable_dates_before_selecting_current_value():
    dates = [f"2026-07-{day:02d}" for day in range(1, 31)] + ["2026-08-01"]
    values = list(range(1, 31)) + [777]
    order = [30, *range(29, -1, -1)]
    frame = FakeFrame(
        日期=[dates[index] for index in order],
        滚动市盈率=[values[index] for index in order],
    )

    current, percentile, source_date, column = index_valuation._series_from(
        FakeAkshare(frame), "stock_index_pe_lg", "沪深300", ("滚动市盈率",), False,
    )

    assert current == 777
    assert percentile == 100
    assert source_date == "2026-08-01"
    assert column == "滚动市盈率"


def test_index_series_uses_date_from_last_valid_value_row_not_trailing_nan():
    frame = FakeFrame(
        日期=[f"2026-07-{day:02d}" for day in range(1, 31)] + ["2026-07-31"],
        滚动市盈率=list(range(1, 31)) + [float("nan")],
    )

    current, percentile, source_date, _ = index_valuation._series_from(
        FakeAkshare(frame), "stock_index_pe_lg", "沪深300", ("滚动市盈率",), False,
    )

    assert current == 30
    assert percentile == 100
    assert source_date == "2026-07-30"
