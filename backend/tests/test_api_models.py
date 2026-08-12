import pytest
from pydantic import ValidationError

import main
from models.api import EstimateContext, PortfolioDecisionRequest, PortfolioLabRequest, WatchlistRequest


def test_contracts_reject_invalid_codes_and_ranges():
    with pytest.raises(ValidationError):
        PortfolioDecisionRequest(items=[{"code": "123", "current_weight": 2}])
    with pytest.raises(ValidationError):
        PortfolioDecisionRequest(items=[{"code": "510300", "target_weight": 101}])
    with pytest.raises(ValidationError):
        WatchlistRequest(code="abcdef")
    with pytest.raises(ValidationError):
        PortfolioDecisionRequest(items=[{
            "code": "510300",
            "estimate_context": {
                "status": "modeled", "source": "holdings_model",
                "kind": "holdings_model", "estimate_nav": 0,
            },
        }])


def test_portfolio_contract_accepts_bounded_model_evidence():
    request = PortfolioDecisionRequest(items=[{
        "code": "510300",
        "estimate_context": {
            "status": "modeled",
            "source": "eastmoney_holdings_model",
            "kind": "holdings_model",
            "source_time": "2026-08-12T10:00:35+08:00",
            "source_time_precision": "datetime",
            "estimate_change": 1.46,
            "estimate_nav": 3.501,
            "base_nav": 3.4509,
            "base_nav_date": "2026-08-11",
            "value_nav": 3.501,
            "value_date": "2026-08-12",
            "model_coverage": 83.47,
            "model_quote_count": 10,
            "model_report_date": "2026-06-30",
            "model_oldest_quote_time": "2026-08-12T09:59:50+08:00",
            "model_newest_quote_time": "2026-08-12T10:00:35+08:00",
            "model_rejected_count": 1,
            "is_fallback": True,
            "fallback_reason": "schema_invalid",
            "diagnostics": {
                "primary_reason": "schema_invalid",
                "model_reason": None,
                "official_reason": None,
                "source_time_precision": "datetime",
                "rejected": {"quote_stale": 1},
            },
        },
    }])
    assert request.items[0].estimate_context is not None
    assert request.items[0].estimate_context.kind == "holdings_model"
    assert request.items[0].estimate_context.diagnostics.rejected == {"quote_stale": 1}


def _estimate_context(**updates):
    context = {
        "status": "fresh", "source": "eastmoney_estimate_table", "kind": "estimate",
        "source_time": "2026-08-12 14:29:00", "source_time_precision": "datetime",
        "is_fallback": False, "estimate_change": 1.0, "estimate_nav": 1.01,
        "base_nav": 1.0, "base_nav_date": "2026-08-11", "value_nav": 1.01,
        "value_date": "2026-08-12",
        "diagnostics": {"source_time_precision": "datetime"},
    }
    context.update(updates)
    return context


@pytest.mark.parametrize("context", [
    _estimate_context(),
    _estimate_context(
        status="delayed", source_time="2026-08-12", source_time_precision="date",
        diagnostics={"source_time_precision": "date"},
    ),
    _estimate_context(status="delayed"),
    _estimate_context(
        status="latest_official", kind="official_nav", source="eastmoney_official_nav",
        source_time="2026-08-11", source_time_precision="date", is_fallback=True,
        base_nav_date="2026-08-08", value_date="2026-08-11",
        fallback_reason="estimate_missing",
        diagnostics={"primary_reason": "estimate_missing", "source_time_precision": "date"},
    ),
    {
        "status": "unavailable", "source": "unavailable", "kind": "unavailable",
        "source_time_precision": "date", "is_fallback": True,
        "fallback_reason": "official_unavailable",
        "diagnostics": {
            "primary_reason": "official_unavailable", "source_time_precision": "date",
        },
    },
])
def test_estimate_context_accepts_each_coherent_kind(context):
    assert EstimateContext.model_validate(context).kind == context["kind"]


@pytest.mark.parametrize("context", [
    _estimate_context(source_time_precision="date"),
    _estimate_context(source_time="2026-08-12"),
    _estimate_context(value_date="2026-02-30"),
    _estimate_context(value_nav=2.0, estimate_nav=2.0, estimate_change=1.0),
    _estimate_context(value_nav=1.01, estimate_nav=1.02),
    _estimate_context(status="fresh", source_time="2026-08-12", source_time_precision="date",
                      diagnostics={"source_time_precision": "date"}),
    _estimate_context(is_fallback=True),
    {
        **_estimate_context(
            status="modeled", kind="holdings_model", source="eastmoney_holdings_model",
            is_fallback=True, model_coverage=49.9, model_quote_count=5,
            model_report_date="2026-06-30", model_oldest_quote_time="2026-08-12 14:28:00",
            model_newest_quote_time="2026-08-12 14:29:00", model_rejected_count=0,
            fallback_reason="model_attempted",
            diagnostics={"primary_reason": "model_attempted", "source_time_precision": "datetime"},
        ),
    },
    {
        **_estimate_context(
            status="modeled", kind="holdings_model", source="eastmoney_holdings_model",
            is_fallback=True, model_coverage=80, model_quote_count=6,
            model_report_date="2026-06-30", model_oldest_quote_time="2026-08-12 14:28:00",
            model_newest_quote_time="2026-08-12 14:29:00",
            fallback_reason="model_attempted",
            diagnostics={"primary_reason": "model_attempted", "source_time_precision": "datetime"},
        ),
    },
    {
        **_estimate_context(
            status="latest_official", kind="official_nav", source="eastmoney_official_nav",
            source_time="2026-08-11", source_time_precision="date", is_fallback=True,
            value_date="2026-08-11", base_nav_date="2026-08-08", model_quote_count=5,
            fallback_reason="estimate_missing",
            diagnostics={"primary_reason": "estimate_missing", "source_time_precision": "date"},
        ),
    },
    {
        "status": "unavailable", "source": "unavailable", "kind": "unavailable",
        "source_time_precision": "date", "is_fallback": True, "estimate_nav": 1.0,
        "fallback_reason": "official_unavailable",
        "diagnostics": {"primary_reason": "official_unavailable", "source_time_precision": "date"},
    },
])
def test_estimate_context_rejects_cross_field_contradictions(context):
    with pytest.raises(ValidationError):
        PortfolioDecisionRequest(items=[{"code": "510300", "estimate_context": context}])


def test_estimate_context_accepts_normal_nav_and_change_rounding():
    context = _estimate_context(
        base_nav=1.0000, value_nav=1.0104, estimate_nav=1.0104, estimate_change=1.04,
    )
    assert EstimateContext.model_validate(context).estimate_change == 1.04


def test_portfolio_lab_contract_has_stable_defaults():
    request = PortfolioLabRequest(items=[{"code": "510300"}])
    assert request.assumptions == {}
    assert request.portfolio_value is None


def test_openapi_exposes_typed_critical_requests():
    schema = main.app.openapi()
    decision = schema["paths"]["/api/portfolio/decisions"]["post"]
    watchlist = schema["paths"]["/api/watchlist"]["post"]
    assert "requestBody" in decision
    assert "PortfolioDecisionRequest" in str(decision["requestBody"])
    assert "WatchlistRequest" in str(watchlist["requestBody"])
