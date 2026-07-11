import pytest
from pydantic import ValidationError

import main
from models.api import PortfolioDecisionRequest, PortfolioLabRequest, WatchlistRequest


def test_contracts_reject_invalid_codes_and_ranges():
    with pytest.raises(ValidationError):
        PortfolioDecisionRequest(items=[{"code": "123", "current_weight": 2}])
    with pytest.raises(ValidationError):
        PortfolioDecisionRequest(items=[{"code": "510300", "target_weight": 101}])
    with pytest.raises(ValidationError):
        WatchlistRequest(code="abcdef")


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
