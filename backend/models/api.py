"""Pydantic contracts for the stable public API boundary."""
import datetime as dt
import math
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class EstimateDiagnostics(BaseModel):
    model_config = ConfigDict(extra="forbid")
    primary_reason: str | None = Field(default=None, max_length=80)
    model_reason: str | None = Field(default=None, max_length=80)
    official_reason: str | None = Field(default=None, max_length=80)
    source_time_precision: Literal["date", "datetime"] | None = None
    rejected: dict[str, int] = Field(default_factory=dict, max_length=20)


class EstimateContext(BaseModel):
    """Bounded live-data evidence supplied by the trusted Worker.

    The decision service never treats request time as quote time.  Keeping this
    contract typed also prevents malformed provider data from silently changing
    a decision.
    """

    model_config = ConfigDict(extra="forbid")
    status: Literal[
        "fresh", "modeled", "delayed", "degraded", "stale",
        "latest_official", "unavailable",
    ]
    source: str = Field(min_length=1, max_length=80)
    kind: Literal["estimate", "holdings_model", "official_nav", "unavailable"]
    source_time: str | None = Field(default=None, max_length=64)
    fetched_at: str | None = Field(default=None, max_length=64)
    calculated_at: str | None = Field(default=None, max_length=64)
    source_time_precision: Literal["date", "datetime"] | None = None
    is_fallback: bool = False
    fallback_reason: str | None = Field(default=None, max_length=240)
    market: Literal["cn", "hk", "overseas", "gold", "unknown"] = "unknown"
    estimate_change: float | None = Field(default=None, ge=-100, le=1000)
    estimate_nav: float | None = Field(default=None, gt=0)
    base_nav: float | None = Field(default=None, gt=0)
    base_nav_date: str | None = Field(default=None, max_length=32)
    value_nav: float | None = Field(default=None, gt=0)
    value_date: str | None = Field(default=None, max_length=32)
    model_coverage: float | None = Field(default=None, ge=0, le=100)
    model_quote_count: int | None = Field(default=None, ge=0, le=100)
    model_report_date: str | None = Field(default=None, max_length=32)
    model_oldest_quote_time: str | None = Field(default=None, max_length=64)
    model_newest_quote_time: str | None = Field(default=None, max_length=64)
    model_rejected_count: int | None = Field(default=None, ge=0, le=100)
    note: str | None = Field(default=None, max_length=500)
    diagnostics: EstimateDiagnostics = Field(default_factory=EstimateDiagnostics)

    @model_validator(mode="after")
    def validate_kind_contract(self) -> "EstimateContext":
        """Reject internally contradictory valuation evidence at the API edge."""
        if self.diagnostics.source_time_precision != self.source_time_precision:
            raise ValueError("diagnostics 时间精度与估值上下文不一致")

        def valid_date(value: str | None) -> bool:
            if value is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                return False
            try:
                dt.date.fromisoformat(value)
            except ValueError:
                return False
            return True

        def valid_datetime(value: str | None) -> bool:
            if value is None or re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                return False
            text = value.strip().replace("Z", "+00:00")
            try:
                parsed = dt.datetime.fromisoformat(text)
            except ValueError:
                return False
            return parsed.hour >= 0

        if self.source_time_precision == "date":
            if self.source_time is not None and not valid_date(self.source_time):
                raise ValueError("date 精度的 source_time 必须为有效 YYYY-MM-DD")
        elif self.source_time is not None and not valid_datetime(self.source_time):
            raise ValueError("datetime 精度的 source_time 必须包含有效日期和时间")
        for field in ("fetched_at", "calculated_at"):
            value = getattr(self, field)
            if value is not None and not valid_datetime(value):
                raise ValueError(f"{field} 必须为有效日期时间")

        model_fields = (
            "model_coverage", "model_quote_count", "model_report_date",
            "model_oldest_quote_time", "model_newest_quote_time",
            "model_rejected_count",
        )
        valuation_fields = ("estimate_change", "estimate_nav", "base_nav", "value_nav")

        def missing(field: str) -> bool:
            value = getattr(self, field)
            return value is None or (isinstance(value, str) and not value.strip())

        def valuation_numbers_consistent() -> bool:
            if any(getattr(self, field) is None for field in valuation_fields):
                return False
            if not math.isclose(self.estimate_nav, self.value_nav, rel_tol=1e-9, abs_tol=1e-9):
                return False
            calculated = (self.value_nav / self.base_nav - 1) * 100
            return abs(calculated - self.estimate_change) <= 0.05 + 1e-9

        if self.kind == "holdings_model":
            if self.status != "modeled" or self.source_time_precision != "datetime" or not self.is_fallback:
                raise ValueError("持仓模型必须为 modeled/datetime/fallback")
            required = (
                "source_time", "estimate_change", "estimate_nav", "base_nav", "base_nav_date",
                "value_nav", "value_date", "model_coverage", "model_quote_count",
                "model_report_date", "model_oldest_quote_time", "model_newest_quote_time",
                "model_rejected_count",
            )
            if any(missing(field) for field in required):
                raise ValueError("持仓模型证据字段不完整")
            if not valuation_numbers_consistent():
                raise ValueError("持仓模型估值数值不一致")
            if self.model_coverage is None or self.model_coverage < 50:
                raise ValueError("持仓模型覆盖率必须在 50-100 之间")
            if self.model_quote_count is None or self.model_quote_count < 5:
                raise ValueError("持仓模型至少需要 5 个有效报价")
            if not all(valid_date(getattr(self, field)) for field in ("base_nav_date", "value_date", "model_report_date")):
                raise ValueError("持仓模型日期字段格式无效")
            if not all(valid_datetime(getattr(self, field)) for field in ("model_oldest_quote_time", "model_newest_quote_time")):
                raise ValueError("持仓模型行情时间格式无效")
            if not self.fallback_reason or self.diagnostics.primary_reason != self.fallback_reason:
                raise ValueError("持仓模型必须携带一致的降级原因")
            return self

        if self.kind == "estimate":
            valid_estimate_time = (
                self.status == "fresh" and self.source_time_precision == "datetime"
            ) or (
                self.status == "delayed" and self.source_time_precision in {"date", "datetime"}
            )
            if not valid_estimate_time or self.is_fallback:
                raise ValueError("主估值状态、时间精度或 fallback 标记不一致")
            required = ("source_time", *valuation_fields, "base_nav_date", "value_date")
            if any(missing(field) for field in required):
                raise ValueError("主估值证据字段不完整")
            if not valuation_numbers_consistent():
                raise ValueError("主估值数值不一致")
            if not valid_date(self.base_nav_date) or not valid_date(self.value_date):
                raise ValueError("主估值日期字段格式无效")
            if self.fallback_reason is not None:
                raise ValueError("主估值不得携带降级原因")
            if any(getattr(self, field) is not None for field in model_fields):
                raise ValueError("主估值不得携带持仓模型字段")
            return self

        if self.kind == "official_nav":
            if self.status != "latest_official" or self.source_time_precision != "date" or not self.is_fallback:
                raise ValueError("正式净值必须为 latest_official/date/fallback")
            required = ("source_time", *valuation_fields, "base_nav_date", "value_date")
            if any(missing(field) for field in required):
                raise ValueError("正式净值证据字段不完整")
            if not valuation_numbers_consistent():
                raise ValueError("正式净值数值不一致")
            if not valid_date(self.base_nav_date) or not valid_date(self.value_date):
                raise ValueError("正式净值日期字段格式无效")
            if not self.fallback_reason or self.diagnostics.primary_reason != self.fallback_reason:
                raise ValueError("正式净值必须携带一致的降级原因")
            if any(getattr(self, field) is not None for field in model_fields):
                raise ValueError("正式净值不得携带持仓模型字段")
            return self

        if self.status != "unavailable" or not self.is_fallback:
            raise ValueError("不可用估值必须为 unavailable/fallback")
        numeric_fields = (*valuation_fields, "model_coverage", "model_quote_count", "model_rejected_count")
        if any(getattr(self, field) is not None for field in numeric_fields):
            raise ValueError("不可用估值的数值字段必须为空")
        if not self.fallback_reason or self.diagnostics.primary_reason != self.fallback_reason:
            raise ValueError("不可用估值必须携带一致的不可用原因")
        return self


class PortfolioItem(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    current_weight: float | None = Field(default=None, ge=0, le=100)
    target_weight: float | None = Field(default=None, ge=0, le=100)
    estimate_context: EstimateContext | None = None


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
