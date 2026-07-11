"""Pydantic contracts for the stable public API boundary."""
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PortfolioItem(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    current_weight: float | None = Field(default=None, ge=0, le=100)
    target_weight: float | None = Field(default=None, ge=0, le=100)


class PortfolioDecisionRequest(BaseModel):
    request_id: str | None = Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")
    items: list[PortfolioItem] = Field(min_length=1, max_length=50)
    portfolio_value: float | None = Field(default=None, ge=0)


class PortfolioDecisionResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    decisions: list[dict[str, Any]]
    errors: list[dict[str, Any]]
    total: int
    duplicate: bool = False
    request_id: str | None = None


class PortfolioLabRequest(BaseModel):
    items: list[PortfolioItem] = Field(min_length=1, max_length=10)
    portfolio_value: float | None = Field(default=None, ge=0)
    assumptions: dict[str, float] = Field(default_factory=dict)


class WatchlistRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    status: str
    service: str
    version: str
    universe: int


WorkerDecisionRequest = PortfolioDecisionRequest
