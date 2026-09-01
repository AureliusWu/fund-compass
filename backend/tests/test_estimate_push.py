"""估值推送、组合上下文与人工应急健壮性测试。"""
import datetime
import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "estimate_push.py"
WIRE_CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "estimate-wire-v8.json"
SPEC = importlib.util.spec_from_file_location("estimate_push", SCRIPT)
estimate_push = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(estimate_push)


def test_watchlist_boundary_isolates_malformed_rows_and_bounds_optional_fields():
    entries = estimate_push.normalize_watch_entries([
        None,
        "bad",
        [],
        {"code": "invalid"},
        {"code": " 000001 ", "name": " 一号 ", "shares": "100.5", "target_weight": "25", "deleted": False},
        {"code": "000002", "shares": -1, "target_weight": 101},
        {"code": "000003", "deleted": "false"},
        {"code": "000004", "deleted": True},
    ])

    assert entries == [
        {"code": "000001", "name": "一号", "shares": 100.5, "target_weight": 25.0},
        {"code": "000002"},
    ]
    assert estimate_push.normalize_watch_entries({"code": "000001"}) == []
    assert estimate_push.normalize_watch_entries("not-an-array") == []


def test_build_portfolio_payload_distributes_remaining_target():
    entries = [
        {"code": "000001", "shares": 100, "target_weight": 60},
        {"code": "000002", "shares": 100},
        {"code": "000003", "shares": 100},
    ]
    estimates = {
        "000001": {"est_nav": 2},
        "000002": {"est_nav": 1},
        "000003": {"est_nav": 1},
    }

    items, value, missing = estimate_push.build_portfolio_payload(entries, estimates)

    assert value == 400
    assert items[0]["current_weight"] == 50
    assert items[0]["target_weight"] == 60
    assert items[1]["target_weight"] == 20
    assert items[2]["target_weight"] == 20
    assert missing == []


def test_build_portfolio_payload_aggregates_accounts():
    entries = [
        {"code": "000001", "shares": 40, "account": "A"},
        {"code": "000001", "shares": 60, "account": "B"},
    ]
    items, value, missing = estimate_push.build_portfolio_payload(
        entries,
        {"000001": {"last_nav": 2}},
    )

    assert value == 200
    assert items == [{"code": "000001", "current_weight": 100.0, "target_weight": 100.0}]
    assert missing == []


def test_build_portfolio_payload_refuses_partial_weights_when_held_nav_is_missing():
    items, value, missing = estimate_push.build_portfolio_payload(
        [
            {"code": "000001", "shares": 100},
            {"code": "000002", "shares": 100},
        ],
        {"000001": {"est_nav": 2}, "000002": {"est_nav": None, "last_nav": None}},
    )

    assert value is None
    assert missing == ["000002"]
    assert items == [{"code": "000001"}, {"code": "000002"}]


def test_format_portfolio_summary_limits_actions():
    result = {
        "allocation": {"target_total": 90, "target_cash": 10, "warnings": []},
        "rebalance": [
            {"code": str(i), "name": f"基金{i}", "gap": i, "suggestion": "分批补仓", "amount": 1000}
            for i in range(1, 6)
        ],
    }

    text = estimate_push.format_portfolio_summary(result)

    assert "目标现金 10.0%" in text
    assert "基金3" in text
    assert "基金4" not in text


def test_fetch_estimates_uses_worker_proxy_and_preserves_status(monkeypatch):
    captured = {}

    def fake_req(url, data=None, headers=None, method=None, timeout=30):
        captured.update(url=url, headers=headers)
        return json.dumps({
            "status": "degraded",
            "items": [
                {
                    "code": "000001",
                    "name": "一号基金",
                    "last_nav": 1,
                    "est_nav": 1.02,
                    "est_change": 2,
                    "est_time": "2026-07-13",
                    "est_label": "盘中估值",
                    "est_kind": "estimate",
                    "status": "fresh",
                    "source": "eastmoney_estimate_table",
                },
                {
                    "code": "000002",
                    "name": "二号基金",
                    "last_nav": 0.98,
                    "est_nav": 1,
                    "est_change": 2.04,
                    "est_time": "2026-07-11",
                    "est_label": "最近净值",
                    "est_kind": "official_nav",
                    "status": "latest_official",
                    "source": "eastmoney_official_nav",
                },
            ],
        })

    monkeypatch.setattr(estimate_push, "ESTIMATE_PROXY_URL", "https://worker.test/estimates")
    monkeypatch.setattr(estimate_push, "_req", fake_req)

    result = estimate_push.fetch_estimates(["000001", "000002"])

    assert captured["url"] == "https://worker.test/estimates?codes=000001%2C000002"
    assert "fundgz" not in captured["url"]
    assert captured["headers"]["Accept"] == "application/json"
    assert result["000001"]["status"] == "fresh"
    assert result["000001"]["kind"] == "intraday_estimate"
    assert result["000002"]["status"] == "latest_official"
    assert result["000002"]["kind"] == "official_nav"
    assert result["000002"]["label"] == "最近净值"


def test_fetch_estimates_reads_unavailable_rows_outside_legacy_items(monkeypatch):
    def fake_req(url, data=None, headers=None, method=None, timeout=30):
        return json.dumps({
            "status": "degraded",
            "items": [{
                "code": "000001", "kind": "estimate", "est_kind": "estimate",
                "last_nav": 1.0, "est_nav": 1.01, "est_change": 1.0,
                "status": "fresh", "source": "eastmoney_estimate_table",
            }],
            "unavailable_items": [{
                "code": "000002", "est_nav": None, "est_change": None,
                "kind": "unavailable", "est_kind": "estimate",
                "source": "unavailable", "source_time_precision": "date",
                "is_fallback": True, "fallback_reason": "official_unavailable",
                "diagnostics": {
                    "primary_reason": "official_unavailable", "source_time_precision": "date",
                },
                "status": "unavailable", "est_label": "数据不可用",
            }],
        })

    monkeypatch.setattr(estimate_push, "_req", fake_req)

    result = estimate_push.fetch_estimates(["000001", "000002"])

    assert result["000001"]["est_nav"] == 1.01
    assert result["000001"]["kind"] == "intraday_estimate"
    assert result["000002"]["status"] == "unavailable"
    assert result["000002"]["kind"] == "unavailable"
    assert result["000002"]["est_nav"] is None


def test_mixed_valid_and_unavailable_worker_rows_do_not_poison_decision_contract(monkeypatch):
    from models.api import PortfolioDecisionRequest

    monkeypatch.setattr(estimate_push, "_req", lambda *_args, **_kwargs: json.dumps({
        "items": [{
            "code": "000001", "kind": "estimate", "est_kind": "estimate",
            "status": "fresh", "source": "eastmoney_estimate_table",
            "base_nav": 1.0, "base_nav_date": "2026-08-11",
            "value_nav": 1.01, "value_date": "2026-08-12", "est_change": 1.0,
            "est_time": "2026-08-12 14:29:00", "source_time_precision": "datetime",
            "is_fallback": False,
            "diagnostics": {"source_time_precision": "datetime", "rejected": {}},
        }],
        "unavailable_items": [{
            "code": "000002", "kind": "unavailable", "est_kind": "estimate",
            "status": "unavailable", "source": "unavailable", "last_nav": 9,
            "est_nav": None, "est_change": None, "source_time_precision": "date",
            "is_fallback": True, "fallback_reason": "official_unavailable",
            "diagnostics": {
                "primary_reason": "official_unavailable", "source_time_precision": "date",
                "rejected": {},
            },
        }],
    }))

    estimates = estimate_push.fetch_estimates(["000001", "000002"])
    assert estimates["000002"]["kind"] == "unavailable"
    assert estimates["000002"]["last_nav"] is None
    items, value, missing = estimate_push.build_portfolio_payload(
        [{"code": "000001", "shares": 100}, {"code": "000002", "shares": 0}],
        estimates,
    )
    validated = PortfolioDecisionRequest(items=items, portfolio_value=value)
    assert missing == []
    assert validated.items[1].estimate_context.kind == "unavailable"
    assert validated.items[1].estimate_context.estimate_nav is None


def test_proxy_normalizer_keeps_blank_and_null_values_missing():
    for value in (None, "", "   ", "1.2oops", True, float("nan")):
        assert estimate_push._to_float(value) is None
    row = estimate_push._normalize_proxy_estimate({
        "status": "fresh", "est_kind": "estimate", "source": "test",
        "last_nav": None, "est_nav": "", "est_change": " ",
        "est_time": "2026-08-12T10:00:00+08:00",
    }, "000001")
    assert row["status"] == "unavailable"
    assert row["last_nav"] is None
    assert row["est_nav"] is None
    assert row["gszzl"] is None


def test_shared_v8_wire_contract_normalizes_to_strict_backend_context():
    from models.api import EstimateContext

    contract = json.loads(WIRE_CONTRACT.read_text(encoding="utf-8"))
    for case in contract["cases"]:
        wire = case["wire"]
        expected = case["expected"]
        row = estimate_push._normalize_proxy_estimate(wire, wire["code"])
        if not expected["accepted"]:
            assert row["kind"] == "unavailable", case["id"]
            assert row["fallback_reason"] == expected["reason"], case["id"]
            assert all(row[field] is None for field in (
                "last_nav", "est_nav", "gszzl", "base_nav", "value_nav",
                "value_change", "estimate_nav", "estimate_change",
            )), case["id"]
            continue

        context = estimate_push._decision_estimate_context(row)
        validated = EstimateContext(**context).model_dump()
        assert validated["kind"] == expected["kind"], case["id"]
        for field in (
            "nav_date", "value_nav", "value_change", "estimate_nav",
            "estimate_change", "target_nav_date", "estimate_model_version",
            "sample_count", "coverage", "error_p80",
        ):
            if field in expected:
                assert validated[field] == expected[field], (case["id"], field)


def test_new_worker_official_nav_with_null_legacy_aliases_needs_no_change_or_base():
    from models.api import EstimateContext

    row = estimate_push._normalize_proxy_estimate({
        "code": "000001", "kind": "official_nav", "est_kind": "official_nav",
        "status": "latest_official", "source": "eastmoney_official_nav",
        "source_time": "2026-08-28", "source_time_precision": "date",
        "nav_date": "2026-08-28", "value_nav": 1.02,
        "estimate_nav": None, "estimate_change": None, "estimate_time": None,
        "est_nav": None, "est_change": None, "est_time": "2026-08-28",
        "is_fallback": True, "fallback_reason": "intraday_unavailable",
        "diagnostics": {
            "primary_reason": "intraday_unavailable",
            "source_time_precision": "date", "rejected": {},
        },
    }, "000001")

    assert row["kind"] == "official_nav"
    assert row["est_nav"] == 1.02
    assert row["gszzl"] is None
    assert row["base_nav"] is None
    assert row["base_nav_date"] is None
    context = estimate_push._decision_estimate_context(row)
    validated = EstimateContext(**context)
    assert validated.value_nav == 1.02
    assert validated.value_change is None
    assert validated.estimate_nav is None
    assert validated.estimate_change is None


def test_official_same_day_base_pair_is_dropped_without_inventing_zero_change():
    from models.api import EstimateContext

    row = estimate_push._normalize_proxy_estimate({
        "kind": "official_nav", "status": "latest_official",
        "source": "eastmoney_official_nav", "source_time": "2026-08-28",
        "source_time_precision": "date", "nav_date": "2026-08-28",
        "value_nav": 1.02, "value_change": 0,
        "base_nav": 1.02, "base_nav_date": "2026-08-28",
        "is_fallback": True, "fallback_reason": "intraday_stale",
        "diagnostics": {
            "primary_reason": "intraday_stale", "source_time_precision": "date",
            "rejected": {},
        },
    }, "000001")

    assert row["base_nav"] is None
    assert row["base_nav_date"] is None
    assert row["value_change"] is None
    assert row["gszzl"] is None
    validated = EstimateContext(**estimate_push._decision_estimate_context(row))
    assert validated.base_nav is None
    assert validated.base_nav_date is None
    assert validated.value_change is None


def test_stale_legacy_estimate_falls_back_to_one_official_nav_without_zero_change():
    from models.api import EstimateContext

    stale = estimate_push._normalize_proxy_estimate({
        "kind": "estimate", "est_kind": "estimate", "status": "stale",
        "source": "eastmoney_estimate_table", "last_nav": 1,
        "nav_date": "2026-08-27", "value_nav": 1.01,
        "value_date": "2026-08-28", "est_nav": 1.01, "est_change": 1,
        "est_time": "2026-08-28T12:00:00+08:00",
        "source_time_precision": "datetime", "is_fallback": False,
        "diagnostics": {
            "primary_reason": "estimate_stale",
            "source_time_precision": "datetime", "rejected": {},
        },
    }, "000001")
    fallback = estimate_push._portfolio_evidence(
        stale,
        "2026-08-28",
        datetime.datetime(2026, 8, 28, 14, 30, tzinfo=estimate_push.CST),
    )

    assert fallback["kind"] == "official_nav"
    assert fallback["value_nav"] == 1
    assert fallback["nav_date"] == "2026-08-27"
    assert fallback["base_nav"] is None
    assert fallback["base_nav_date"] is None
    assert fallback["value_change"] is None
    assert fallback["gszzl"] is None
    validated = EstimateContext(**estimate_push._decision_estimate_context(fallback))
    assert validated.kind == "official_nav"
    assert validated.value_change is None


def test_canonical_legacy_value_conflict_fails_closed_without_zero_values():
    row = estimate_push._normalize_proxy_estimate({
        "kind": "intraday_estimate", "est_kind": "estimate",
        "status": "fresh", "source": "eastmoney_estimate_table",
        "source_time": "2026-08-28T14:30:00+08:00",
        "source_time_precision": "datetime", "base_nav": 1,
        "base_nav_date": "2026-08-27", "value_nav": 1.01,
        "value_date": "2026-08-28", "estimate_nav": 1.01,
        "estimate_change": 1, "estimate_time": "2026-08-28T14:30:00+08:00",
        "est_nav": 1.99, "est_change": 1,
    }, "000001")

    assert row["kind"] == "unavailable"
    assert row["fallback_reason"] == "canonical_legacy_conflict"
    assert all(row[field] is None for field in (
        "last_nav", "est_nav", "gszzl", "base_nav", "value_nav",
        "value_change", "estimate_nav", "estimate_change",
    ))


def test_legacy_overseas_model_normalizes_to_qdii_next_nav_estimate():
    from models.api import EstimateContext

    row = estimate_push._normalize_proxy_estimate({
        "kind": "overseas_model", "status": "modeled", "source": "legacy_qdii",
        "last_nav": 2.4, "base_nav_date": "2026-08-27",
        "value_nav": 2.424, "value_date": "2026-08-31",
        "est_nav": 2.424, "est_change": 1,
        "est_time": "2026-08-28T16:04:47+08:00",
        "source_time_precision": "datetime", "target_nav_date": "2026-08-31",
        "model_version": "legacy-q-v1", "sample_count": 12,
        "model_coverage": 75, "uncertainty": {"error_p80": 1.3},
        "diagnostics": {"source_time_precision": "datetime", "rejected": {}},
    }, "018147")

    assert row["kind"] == "qdii_next_nav_estimate"
    assert row["market"] == "overseas"
    context = estimate_push._decision_estimate_context(row)
    validated = EstimateContext(**context)
    assert validated.kind == "qdii_next_nav_estimate"
    assert validated.target_nav_date == "2026-08-31"
    assert validated.estimate_model_version == "legacy-q-v1"
    assert validated.sample_count == 12
    assert validated.coverage == 75
    assert validated.error_p80 == 1.3


def test_unknown_status_fails_closed_and_never_synthesizes_zero():
    row = estimate_push._normalize_proxy_estimate({
        "kind": "intraday_estimate", "status": "unknown", "source": "test",
        "base_nav": 1, "estimate_nav": 1.01, "estimate_change": 1,
    }, "000001")

    assert row["kind"] == "unavailable"
    assert row["fallback_reason"] == "status_invalid"
    assert all(row[field] is None for field in (
        "last_nav", "est_nav", "gszzl", "base_nav", "value_nav",
        "value_change", "estimate_nav", "estimate_change",
    ))


def test_safe_get_retries_once_and_caps_response_size(monkeypatch):
    calls = []

    class FakeResponse:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return self.body

    def transient_then_ok(_request, timeout):
        calls.append(timeout)
        if len(calls) == 1:
            raise estimate_push.urllib.error.URLError("temporary")
        return FakeResponse(b"{}")

    monkeypatch.setattr(estimate_push.urllib.request, "urlopen", transient_then_ok)
    monkeypatch.setattr(estimate_push.time, "sleep", lambda _seconds: None)
    assert estimate_push._req("https://example.test/data") == "{}"
    assert len(calls) == 2

    monkeypatch.setattr(
        estimate_push.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: FakeResponse(b"x" * (estimate_push.MAX_RESPONSE_BYTES + 1)),
    )
    try:
        estimate_push._req("https://example.test/large")
    except ValueError as ex:
        assert "响应过大" in str(ex)
    else:
        raise AssertionError("oversized responses must be rejected")


def test_serverchan_requires_business_success_and_hides_sendkey(monkeypatch, capsys):
    secret = "SCT-secret-must-not-leak"
    monkeypatch.setattr(estimate_push, "PUSHPLUS_TOKEN", "")
    monkeypatch.setattr(estimate_push, "WECHAT_SENDKEY", secret)
    monkeypatch.setattr(estimate_push, "NOTIFY_WEBHOOK_URL", "")
    monkeypatch.setattr(
        estimate_push,
        "_req",
        lambda *_args, **_kwargs: json.dumps({"code": 1, "message": f"rejected {secret}"}),
    )

    assert estimate_push.send_notification("title", "content") is False
    output = capsys.readouterr().out
    assert "serverchan_business_rejected" in output
    assert secret not in output

    monkeypatch.setattr(
        estimate_push,
        "_req",
        lambda *_args, **_kwargs: json.dumps({"code": 0, "message": "SUCCESS"}),
    )
    assert estimate_push.send_notification("title", "content") is True


def test_pushplus_requires_business_success(monkeypatch, capsys):
    monkeypatch.setattr(estimate_push, "PUSHPLUS_TOKEN", "pushplus-secret")
    monkeypatch.setattr(estimate_push, "WECHAT_SENDKEY", "")
    monkeypatch.setattr(estimate_push, "NOTIFY_WEBHOOK_URL", "")
    monkeypatch.setattr(
        estimate_push,
        "_req",
        lambda *_args, **_kwargs: json.dumps({"code": 500, "msg": "rejected"}),
    )

    assert estimate_push.send_notification("title", "content") is False
    assert "pushplus_business_rejected" in capsys.readouterr().out

    monkeypatch.setattr(
        estimate_push,
        "_req",
        lambda *_args, **_kwargs: json.dumps({"code": 200, "msg": "success"}),
    )
    assert estimate_push.send_notification("title", "content") is True


def test_notification_http_error_does_not_expose_credential_url(monkeypatch, capsys):
    secret = "SCT-http-error-secret"
    monkeypatch.setattr(estimate_push, "PUSHPLUS_TOKEN", "")
    monkeypatch.setattr(estimate_push, "WECHAT_SENDKEY", secret)
    monkeypatch.setattr(estimate_push, "NOTIFY_WEBHOOK_URL", "")

    def fail_with_url(url, **_kwargs):
        raise estimate_push.urllib.error.HTTPError(url, 503, "upstream failed", {}, None)

    monkeypatch.setattr(estimate_push, "_req", fail_with_url)

    assert estimate_push.send_notification("title", "content") is False
    output = capsys.readouterr().out
    assert "serverchan_http_503" in output
    assert secret not in output
    assert "sctapi.ftqq.com" not in output


def test_holdings_model_is_publishable_and_passes_typed_decision_evidence():
    row = estimate_push._normalize_proxy_estimate({
        "status": "modeled", "est_kind": "holdings_model",
        "source": "eastmoney_holdings_model", "base_nav": 3.4509,
        "base_nav_date": "2026-08-11", "value_nav": 3.5014,
        "value_date": "2026-08-12", "est_change": 1.46,
        "source_time_precision": "datetime", "is_fallback": True,
        "fallback_reason": "estimate_incomplete",
        "model_newest_quote_time": "2026-08-12T10:00:37+08:00",
        "model_oldest_quote_time": "2026-08-12T10:00:35+08:00",
        "model_report_date": "2026-06-30", "model_coverage": 83.47,
        "model_quote_count": 10, "model_rejected_count": 0,
        "diagnostics": {"primary_reason": "estimate_incomplete", "rejected": {}},
    }, "005844")

    assert estimate_push._is_publishable_intraday(
        row,
        "2026-08-12",
        datetime.datetime(2026, 8, 12, 10, 5, tzinfo=estimate_push.CST),
    ) is True
    items, value, missing = estimate_push.build_portfolio_payload(
        [{"code": "005844", "shares": 100}], {"005844": row},
    )
    assert value == 350.14
    assert missing == []
    context = items[0]["estimate_context"]
    assert context["status"] == "modeled"
    assert context["kind"] == "holdings_model"
    assert context["model_coverage"] == 83.47
    assert context["source_time"] == "2026-08-12T10:00:37+08:00"
    assert context["diagnostics"]["primary_reason"] == "estimate_incomplete"


def test_official_decision_context_drops_model_only_fields():
    row = estimate_push._normalize_proxy_estimate({
        "status": "latest_official", "est_kind": "official_nav",
        "source": "eastmoney_official_nav", "base_nav": 1.0,
        "base_nav_date": "2026-08-11", "value_nav": 1.01,
        "value_date": "2026-08-12", "est_change": 1.0,
        "source_time_precision": "date", "is_fallback": True,
        "fallback_reason": "estimate_missing", "model_quote_count": 9,
        "diagnostics": {"primary_reason": "estimate_missing", "rejected": {}},
    }, "005844")

    context = estimate_push._decision_estimate_context(row)
    assert context["kind"] == "official_nav"
    assert context["fallback_reason"] == "estimate_missing"
    assert "estimate_change" not in context
    assert "estimate_nav" not in context
    assert "model_quote_count" not in context
    assert context["diagnostics"]["source_time_precision"] == "date"


def test_official_nav_is_not_publishable_intraday_even_when_dated_today():
    assert estimate_push._is_publishable_intraday({
        "kind": "official_nav", "status": "latest_official",
        "last_nav": 1, "est_nav": 1.01, "gszzl": 1,
        "gztime": "2026-08-12",
    }, "2026-08-12") is False


def test_publish_gate_rejects_old_model_quotes_and_accepts_recent_quotes():
    row = {
        "kind": "holdings_model", "status": "modeled",
        "last_nav": 1, "est_nav": 1.01, "gszzl": 1,
        "gztime": "2026-08-12 09:30:00",
        "model_oldest_quote_time": "2026-08-12 09:29:00",
        "model_newest_quote_time": "2026-08-12 09:30:00",
    }
    at_close = datetime.datetime(2026, 8, 12, 14, 30, tzinfo=estimate_push.CST)
    assert estimate_push._is_publishable_intraday(row, "2026-08-12", at_close) is False

    row.update({
        "gztime": "2026-08-12 14:29:00",
        "model_oldest_quote_time": "2026-08-12 14:28:00",
        "model_newest_quote_time": "2026-08-12 14:29:00",
    })
    assert estimate_push._is_publishable_intraday(row, "2026-08-12", at_close) is True


def test_publish_gate_rejects_date_precision_and_stale_datetime_estimates():
    row = {
        "kind": "estimate", "status": "fresh",
        "last_nav": 1, "est_nav": 1.01, "gszzl": 1,
        "gztime": "2026-08-12", "source_time_precision": "date",
    }
    now = datetime.datetime(2026, 8, 12, 14, 30, tzinfo=estimate_push.CST)
    assert estimate_push._is_publishable_intraday(row, "2026-08-12", now) is False

    row.update({"gztime": "2026-08-12 09:30:00", "source_time_precision": "datetime"})
    assert estimate_push._is_publishable_intraday(row, "2026-08-12", now) is False

    row["gztime"] = "2026-08-12 14:29:00"
    assert estimate_push._is_publishable_intraday(row, "2026-08-12", now) is True


def test_mixed_fresh_and_expired_estimates_use_only_formal_nav_for_expired_fund():
    from models.api import PortfolioDecisionRequest

    now = datetime.datetime(2026, 8, 12, 14, 30, tzinfo=estimate_push.CST)
    estimates = {
        "000001": {
            "kind": "estimate", "status": "fresh", "source": "eastmoney_estimate_table",
            "last_nav": 1.0, "est_nav": 1.01, "gszzl": 1.0,
            "base_nav": 1.0, "base_nav_date": "2026-08-11",
            "value_nav": 1.01, "value_date": "2026-08-12",
            "gztime": "2026-08-12 14:29:00", "source_time_precision": "datetime",
            "is_fallback": False,
            "diagnostics": {"source_time_precision": "datetime", "rejected": {}},
        },
        "000002": {
            "kind": "estimate", "status": "delayed", "source": "eastmoney_estimate_table",
            "last_nav": 1.0, "est_nav": 1.02, "gszzl": 2.0,
            "base_nav": 1.0, "base_nav_date": "2026-08-11",
            "value_nav": 1.02, "value_date": "2026-08-12",
            "gztime": "2026-08-12 12:59:00", "source_time_precision": "datetime",
            "is_fallback": False, "fallback_reason": "estimate_stale",
            "diagnostics": {
                "primary_reason": "estimate_stale", "source_time_precision": "datetime",
                "rejected": {},
            },
        },
    }
    items, value, missing = estimate_push.build_portfolio_payload(
        [{"code": "000001", "shares": 100}, {"code": "000002", "shares": 100}],
        estimates, "2026-08-12", now,
    )
    validated = PortfolioDecisionRequest(items=items, portfolio_value=value)
    expired = validated.items[1]
    assert missing == []
    assert value == 201.0
    assert expired.current_weight == 49.75
    assert expired.estimate_context.kind == "official_nav"
    assert expired.estimate_context.estimate_nav is None
    assert expired.estimate_context.estimate_change is None
    assert expired.estimate_context.base_nav is None
    assert expired.estimate_context.base_nav_date is None
    assert expired.estimate_context.value_change is None
    line = estimate_push.format_push_line(
        "000002", "expired", estimates["000002"],
        {"action": "加仓", "summary": "should not appear"}, "2026-08-12", now,
    )
    assert "行情过期/延迟数据不参与" in line
    assert "加仓" not in line


def test_fetch_portfolio_decisions_sends_worker_token_and_request_id(monkeypatch):
    captured = {}

    def fake_req(url, data=None, headers=None, method=None, timeout=30):
        captured.update(url=url, body=json.loads(data), headers=headers)
        return json.dumps({"decisions": []})

    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "worker-secret")
    monkeypatch.setattr(estimate_push, "_req", fake_req)

    result, warning = estimate_push.fetch_portfolio_decisions(
        [{"code": "000001"}],
        1000,
        request_id="2026-07-13-14:30",
    )

    assert result == {"decisions": []}
    assert warning is None
    assert captured["url"] == "https://api.test/api/portfolio/decisions"
    assert captured["headers"]["Authorization"] == "Bearer worker-secret"
    assert captured["body"]["request_id"] == "2026-07-13-14:30"


def test_fetch_portfolio_decisions_requires_worker_token(monkeypatch):
    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "")

    try:
        estimate_push.fetch_portfolio_decisions([], 0)
    except estimate_push.DecisionAuthError as ex:
        assert "WORKER_TOKEN" in str(ex)
    else:
        raise AssertionError("missing WORKER_TOKEN must stop the protected decision call")


def test_fetch_portfolio_decisions_returns_warning_on_timeout(monkeypatch):
    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "worker-secret")
    monkeypatch.setattr(
        estimate_push,
        "_req",
        lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("timed out")),
    )

    result, warning = estimate_push.fetch_portfolio_decisions([], 0)

    assert result is None
    assert "timed out" in warning


def test_rollover_daily_state_preserves_global_runtime_history():
    state = estimate_push.rollover_daily_state(
        {
            "date": "2026-07-12",
            "sent_slots": ["14:30"],
            "attempt_count": 2,
            "last_cron_at": "2026-07-12T14:40:00+08:00",
            "last_cron_result": "skipped",
            "last_cron_reason": "no_fresh_estimate",
            "last_attempt_at": "2026-07-11T14:30:00+08:00",
            "last_success_at": "2026-07-11T14:30:00+08:00",
            "last_error": "",
        },
        "2026-07-13",
    )

    assert state["date"] == "2026-07-13"
    assert state["sent_slots"] == []
    assert state["attempt_count"] == 0
    assert state["last_cron_at"] == "2026-07-12T14:40:00+08:00"
    assert state["last_cron_result"] == "skipped"
    assert state["last_cron_reason"] == "no_fresh_estimate"
    assert state["last_attempt_at"] == "2026-07-11T14:30:00+08:00"
    assert state["last_success_at"] == "2026-07-11T14:30:00+08:00"


def test_push_state_parser_whitelists_types_bounds_and_deduplicates_slots():
    state = estimate_push.parse_push_state(json.dumps({
        "date": "2026-07-13",
        "sent_slots": ["14:30", "14:30", "14:40", 1],
        "attempt_count": 2,
        "last_slot": "14:30",
        "last_success_at": "2026-07-11T14:30:00+08:00",
        "last_cron_result": "skipped",
        "last_cron_reason": "no_publishable_intraday",
        "last_error": "",
        "last_warning": "warning",
        "decision_status": "degraded",
        "last_http_status": 429,
        "extra": "discard",
    }))

    assert state == {
        "date": "2026-07-13",
        "sent_slots": ["14:30"],
        "attempt_count": 2,
        "last_slot": "14:30",
        "last_success_at": "2026-07-11T14:30:00+08:00",
        "last_cron_result": "skipped",
        "last_cron_reason": "no_publishable_intraday",
        "last_error": "",
        "last_warning": "warning",
        "decision_status": "degraded",
        "last_http_status": 429,
    }


def test_push_state_parser_rebuilds_malformed_daily_fields_and_keeps_safe_history():
    assert estimate_push.parse_push_state("[]") == {}
    assert estimate_push.parse_push_state("{bad json") == {}
    state = estimate_push.rollover_daily_state({
        "date": "2026-02-30",
        "sent_slots": "14:30",
        "attempt_count": float("inf"),
        "last_slot": "bad",
        "last_success_at": "2026-07-11T14:30:00+08:00",
        "last_attempt_at": "not-a-time",
        "last_cron_result": "unknown",
        "last_cron_reason": "x" * 81,
        "last_error": "x" * 241,
        "decision_status": "unknown",
        "last_http_status": 99,
    }, "2026-07-13")
    assert state == {
        "date": "2026-07-13",
        "sent_slots": [],
        "attempt_count": 0,
        "last_success_at": "2026-07-11T14:30:00+08:00",
    }


def test_same_day_malformed_sent_slots_never_claims_the_slot_was_sent():
    for malformed in ("14:30", {"slot": "14:30"}, None):
        state = estimate_push.rollover_daily_state({
            "date": "2026-07-13", "sent_slots": malformed, "attempt_count": "2",
        }, "2026-07-13")
        assert state["sent_slots"] == []
        assert state["attempt_count"] == 0
        assert "14:30" not in state["sent_slots"]


def _install_main_probe(monkeypatch, decision_call):
    real_datetime = datetime.datetime

    class FixedDateTime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 7, 13, 14, 30, tzinfo=tz)

    written = []
    sends = []
    monkeypatch.setattr(estimate_push.datetime, "datetime", FixedDateTime)
    monkeypatch.setattr(estimate_push, "GIST_TOKEN", "gist-token")
    monkeypatch.setattr(estimate_push, "GIST_ID", "a" * 32)
    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "worker-token")
    monkeypatch.setattr(estimate_push, "FORCE", False)
    monkeypatch.setattr(estimate_push, "PUSH_SLOT", "14:30")
    monkeypatch.setattr(estimate_push, "SCHEDULE_CRON", "")
    monkeypatch.setattr(estimate_push, "find_gist_id", lambda: "gist")
    monkeypatch.setattr(estimate_push, "gist_file", lambda *_args: "{}")
    monkeypatch.setattr(
        estimate_push,
        "watch_entries",
        lambda _gid: [{"code": "000001", "name": "测试基金", "shares": 100}],
    )
    monkeypatch.setattr(
        estimate_push,
        "fetch_estimates",
        lambda _codes: {"000001": {
            "name": "测试基金", "est_nav": 1.01, "last_nav": 1,
            "gszzl": 1, "gztime": "2026-07-13 14:29:00", "source_time_precision": "datetime",
            "status": "fresh", "label": "盘中估值",
            "kind": "estimate", "source": "eastmoney_estimate_table",
        }},
    )
    monkeypatch.setattr(estimate_push, "fetch_portfolio_decisions", decision_call)
    monkeypatch.setattr(
        estimate_push,
        "send_notification",
        lambda *_args: sends.append(True) or True,
    )
    monkeypatch.setattr(estimate_push, "write_state", lambda _gid, state: written.append(dict(state)))
    return written, sends


def test_gist_target_must_be_explicit_and_is_never_enumerated(monkeypatch):
    monkeypatch.setattr(estimate_push, "GIST_ID", "")
    monkeypatch.setattr(
        estimate_push,
        "_gh",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not enumerate Gists")),
    )

    assert estimate_push.find_gist_id() is None


def test_main_fails_closed_when_gist_configuration_is_missing(monkeypatch):
    monkeypatch.setattr(estimate_push, "FORCE", True)
    monkeypatch.setattr(estimate_push, "GIST_TOKEN", "")
    monkeypatch.setattr(estimate_push, "GIST_ID", "")

    with pytest.raises(SystemExit, match="GIST_TOKEN"):
        estimate_push.main()


def test_main_records_decision_timeout_as_sent_with_warning(monkeypatch):
    written, sends = _install_main_probe(
        monkeypatch,
        lambda *_args, **_kwargs: (None, "组合决策暂不可用: timed out"),
    )

    assert estimate_push.main() == 0

    assert sends == [True]
    assert written[-1]["sent_slots"] == ["14:30"]
    assert written[-1]["decision_status"] == "degraded"
    assert written[-1]["last_warning"] == "组合决策暂不可用: timed out"
    assert written[-1]["last_error"] == ""
    assert written[-1]["last_http_status"] == 200
    assert written[-1]["last_success_at"] == "2026-07-13T14:30:00+08:00"


def test_main_records_auth_failure_without_sending_or_marking_sent(monkeypatch):
    def auth_failure(*_args, **_kwargs):
        raise estimate_push.DecisionAuthError("组合决策鉴权失败: HTTP 401", 401)

    written, sends = _install_main_probe(monkeypatch, auth_failure)

    assert estimate_push.main() == 1

    assert sends == []
    assert written[-1]["sent_slots"] == []
    assert written[-1]["decision_status"] == "degraded"
    assert written[-1]["last_error"] == "组合决策鉴权失败: HTTP 401"
    assert written[-1]["last_http_status"] == 401


def test_main_does_not_mark_sent_when_provider_does_not_acknowledge(monkeypatch):
    written, sends = _install_main_probe(
        monkeypatch,
        lambda *_args, **_kwargs: (None, None),
    )
    monkeypatch.setattr(
        estimate_push,
        "send_notification",
        lambda *_args: sends.append(True) or False,
    )

    assert estimate_push.main() == 1

    assert sends == [True]
    assert written == []


def test_main_fails_closed_when_state_read_fails(monkeypatch):
    written, sends = _install_main_probe(monkeypatch, lambda *_args, **_kwargs: (None, None))
    monkeypatch.setattr(
        estimate_push,
        "gist_file",
        lambda *_args: (_ for _ in ()).throw(OSError("temporary failure")),
    )

    assert estimate_push.main() == 1
    assert sends == []
    assert written == []


def test_main_fails_closed_when_state_is_malformed(monkeypatch):
    written, sends = _install_main_probe(monkeypatch, lambda *_args, **_kwargs: (None, None))
    monkeypatch.setattr(estimate_push, "gist_file", lambda *_args: '{"date":"bad"}')

    assert estimate_push.main() == 1
    assert sends == []
    assert written == []


def test_unavailable_proxy_item_is_explicit_in_push_line():
    line = estimate_push.format_push_line(
        "000001",
        "一号基金",
        {"status": "unavailable", "gszzl": None, "label": "数据不可用"},
        None,
    )

    assert "—（数据不可用）" in line
