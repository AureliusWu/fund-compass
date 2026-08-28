"""Pydantic contracts for the stable public API boundary."""
import datetime as dt
import math
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    target_nav_date: str | None = Field(default=None, max_length=32)
    market_time: str | None = Field(default=None, max_length=64)
    model_version: str | None = Field(default=None, max_length=120)
    sample_count: int | None = Field(default=None, ge=0, le=1_000_000)
    mae: float | None = Field(default=None, ge=0, le=1000)
    error_p80: float | None = Field(default=None, ge=0, le=1000)
    direction_accuracy: float | None = Field(default=None, ge=0, le=100)
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
            return parsed.tzinfo is not None

        if self.source_time_precision == "date":
            if self.source_time is not None and not valid_date(self.source_time):
                raise ValueError("date 精度的 source_time 必须为有效 YYYY-MM-DD")
        elif self.source_time is not None and not valid_datetime(self.source_time):
            raise ValueError("datetime 精度的 source_time 必须包含有效日期和时间")
        for field in ("fetched_at", "calculated_at"):
            value = getattr(self, field)
            if value is not None and not valid_datetime(value):
                raise ValueError(f"{field} 必须为有效日期时间")
        if self.target_nav_date is not None and not valid_date(self.target_nav_date):
            raise ValueError("target_nav_date 必须为有效 YYYY-MM-DD")
        if self.target_nav_date is not None:
            if not valid_date(self.base_nav_date) or self.target_nav_date <= self.base_nav_date:
                raise ValueError("target_nav_date 必须晚于 base_nav_date")
        if self.market_time is not None and not valid_datetime(self.market_time):
            raise ValueError("market_time 必须为有效日期时间")
        if self.kind in {"official_nav", "unavailable"} and self.target_nav_date is not None:
            raise ValueError("正式净值或不可用证据不得声明下一目标净值日")

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
            required = ("source_time", "value_nav", "value_date")
            if any(missing(field) for field in required):
                raise ValueError("正式净值证据字段不完整")
            if self.estimate_change is not None or self.estimate_nav is not None:
                raise ValueError("正式净值不得伪装为盘中估值")
            if not valid_date(self.base_nav_date) or not valid_date(self.value_date):
                raise ValueError("正式净值日期字段格式无效")
            if (self.base_nav is None) != (self.base_nav_date is None):
                raise ValueError("正式净值的可选基准净值与日期必须成对出现")
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


class V8HoldingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_held: bool
    shares: float | None = Field(default=None, ge=0)
    cost: float | None = Field(default=None, ge=0)
    market_value: float | None = Field(default=None, ge=0)
    account: str | None = Field(default=None, max_length=120)
    current_weight: float | None = Field(default=None, ge=0, le=100)
    target_weight: float | None = Field(default=None, ge=0, le=100)
    updated_at: dt.datetime | None = None
    source: str = Field(default="api", min_length=1, max_length=120)

    @model_validator(mode="after")
    def validate_holding_state(self) -> "V8HoldingInput":
        positive = any(
            value is not None and value > 0
            for value in (self.shares, self.market_value, self.current_weight)
        )
        if not self.is_held and positive:
            raise ValueError("未持有状态不能携带正持仓")
        if self.updated_at is not None and self.updated_at.tzinfo is None:
            raise ValueError("updated_at 必须包含时区")
        return self


class V8DecisionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(pattern=r"^\d{6}$")
    theme: str | None = Field(default=None, min_length=1, max_length=120)
    holding: V8HoldingInput
    estimate_context: EstimateContext | None = None


class V8DecisionBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str | None = Field(default=None, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._:-]+$")
    items: list[V8DecisionItem] = Field(min_length=1, max_length=50)
    policy_version: str | None = Field(default=None, pattern=r"^pol_[0-9a-f]{64}$")
    portfolio_value: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def unique_fund_codes(self) -> "V8DecisionBatchRequest":
        codes = [item.code for item in self.items]
        if len(codes) != len(set(codes)):
            raise ValueError("items 不得包含重复基金代码")
        return self


class V8PolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    target_allocations: dict[str, float] = Field(default_factory=dict, max_length=100)
    target_ranges: dict[str, tuple[float, float]] = Field(default_factory=dict, max_length=100)
    max_single_fund_weight: float | None = Field(default=None, gt=0, le=100)
    max_theme_weight: float | None = Field(default=None, gt=0, le=100)
    rebalance_band: float | None = Field(default=None, ge=0, le=50)
    dca_rules: dict[str, Any] = Field(default_factory=dict, max_length=30)
    reduce_rules: dict[str, Any] = Field(default_factory=dict, max_length=30)
    sell_rules: dict[str, Any] = Field(default_factory=dict, max_length=30)
    effective_at: dt.datetime | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_boolean_policy_numbers(cls, raw: Any) -> Any:
        if not isinstance(raw, dict):
            return raw
        for value in (raw.get("target_allocations") or {}).values():
            if isinstance(value, bool):
                raise ValueError("target_allocations 不接受布尔值")
        for bounds in (raw.get("target_ranges") or {}).values():
            if isinstance(bounds, (list, tuple)) and any(isinstance(value, bool) for value in bounds):
                raise ValueError("target_ranges 不接受布尔值")
        return raw

    @model_validator(mode="after")
    def validate_policy(self) -> "V8PolicyRequest":
        if sum(self.target_allocations.values()) > 100 + 1e-9:
            raise ValueError("target_allocations 合计不得超过 100%")
        for key, value in self.target_allocations.items():
            if not key.strip() or not math.isfinite(value) or value < 0 or value > 100:
                raise ValueError("target_allocations 含无效条目")
        for key, bounds in self.target_ranges.items():
            low, high = bounds
            if (
                not key.strip()
                or not math.isfinite(low) or not math.isfinite(high)
                or low < 0 or high > 100 or low > high
            ):
                raise ValueError("target_ranges 含无效区间")
        if self.effective_at is not None and self.effective_at.tzinfo is None:
            raise ValueError("effective_at 必须包含时区")
        for rules, key in (
            (self.dca_rules, "max_step_percent"),
            (self.reduce_rules, "max_step_percent"),
        ):
            value = rules.get(key)
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or not 0 < float(value) <= 100
            ):
                raise ValueError(f"{key} 必须是 (0, 100] 内的有限数值")
        minimum_confidence = self.dca_rules.get("minimum_confidence")
        if minimum_confidence is not None and (
            isinstance(minimum_confidence, bool)
            or not isinstance(minimum_confidence, (int, float))
            or not math.isfinite(float(minimum_confidence))
            or not 0 <= float(minimum_confidence) <= 100
        ):
            raise ValueError("minimum_confidence 必须是 [0, 100] 内的有限数值")
        require_structural = self.sell_rules.get("require_structural_invalidation")
        if require_structural is not None and not isinstance(require_structural, bool):
            raise ValueError("require_structural_invalidation 必须是布尔值")
        return self


class V8OutcomeSettleRequest(BaseModel):
    """Bounded Worker/Admin request for the periodic immutable outcome job."""

    model_config = ConfigDict(extra="forbid")
    decision_ids: list[str] = Field(default_factory=list, max_length=200)
    limit: int = Field(default=1000, ge=1, le=10_000)

    @field_validator("decision_ids")
    @classmethod
    def validate_outcome_decision_ids(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)) or any(
            not re.fullmatch(r"dec_[0-9a-f]{64}", value) for value in values
        ):
            raise ValueError("decision_ids 格式无效或重复")
        return values


class V8NotificationEventRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision_ids: list[str] = Field(min_length=1, max_length=50)
    scheduled_window: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$")
    status: Literal["scheduled", "skipped", "attempted", "sent", "failed", "compensated"]
    attempt_no: int = Field(ge=0, le=100)
    natural_schedule: bool = True
    occurred_at: dt.datetime | None = None
    error_class: str | None = Field(default=None, max_length=120)
    detail: dict[str, Any] = Field(default_factory=dict, max_length=30)

    @field_validator("decision_ids")
    @classmethod
    def validate_decision_ids(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)) or any(not re.fullmatch(r"dec_[0-9a-f]{64}", value) for value in values):
            raise ValueError("decision_ids 格式无效或重复")
        return values

    @model_validator(mode="after")
    def validate_event_time(self) -> "V8NotificationEventRequest":
        if self.occurred_at is not None and self.occurred_at.tzinfo is None:
            raise ValueError("occurred_at 必须包含时区")
        if self.status in {"attempted", "sent", "failed", "compensated"} and self.attempt_no < 1:
            raise ValueError("发送尝试事件的 attempt_no 必须至少为 1")
        if self.status in {"scheduled", "skipped"} and self.attempt_no != 0:
            raise ValueError("scheduled/skipped 的 attempt_no 必须为 0")
        if self.status != "failed" and self.error_class is not None:
            raise ValueError("仅 failed 事件可携带 error_class")
        return self


class WatchlistRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    status: str
    service: str
    version: str
    universe: int


WorkerDecisionRequest = PortfolioDecisionRequest
