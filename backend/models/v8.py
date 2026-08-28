"""Versioned, immutable contracts for the v8 decision evidence chain."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Action = Literal["buy", "dca", "watch", "add", "hold", "reduce", "sell"]
UserState = Literal["unheld", "held"]
SourceHealthState = Literal["healthy", "degraded", "stale", "unavailable", "unknown"]


def _canonical_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _canonical_value(value.model_dump(mode="python"))
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("canonical datetime must include a timezone")
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise TypeError("canonical mapping keys must be strings")
        return {key: _canonical_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical_value(item) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical payload rejects NaN and Infinity")
        return 0.0 if value == 0 else value
    if value is None or isinstance(value, (str, int, bool)):
        return value
    raise TypeError(f"unsupported canonical value: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Serialize a bounded payload identically across runs."""
    return json.dumps(
        _canonical_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def payload_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def stable_id(prefix: str, value: Any) -> str:
    if not prefix or not prefix.replace("_", "").isalnum():
        raise ValueError("stable id prefix is invalid")
    return f"{prefix}_{payload_sha256({'kind': prefix, 'payload': value})}"


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SourceState(FrozenModel):
    source_id: str = Field(min_length=1, max_length=120)
    state: SourceHealthState
    last_success: datetime | None = None
    last_failure: datetime | None = None
    latency_ms: float | None = Field(default=None, ge=0)
    data_age_seconds: float | None = Field(default=None, ge=0)
    stale: bool
    error_class: str | None = Field(default=None, max_length=120)


class EvidenceNode(FrozenModel):
    node_id: str = Field(min_length=1, max_length=80)
    category: Literal[
        "valuation", "trend", "momentum", "quality", "risk", "holding",
        "portfolio", "data_quality", "model_accuracy", "outcome",
    ]
    state: Literal["support", "constraint", "neutral", "missing"]
    label: str = Field(min_length=1, max_length=240)
    value: float | str | bool | None = None
    source_id: str | None = Field(default=None, max_length=120)


class EvidenceSnapshot(FrozenModel):
    schema_version: Literal["v8-evidence-1"] = "v8-evidence-1"
    evidence_id: str = Field(pattern=r"^ev_[0-9a-f]{64}$")
    fund_code: str = Field(pattern=r"^\d{6}$")
    fund_name: str | None = Field(default=None, max_length=200)
    fund_type: str = Field(min_length=1, max_length=120)
    created_at: datetime
    market_time: datetime | None = None
    official_nav: float | None = Field(default=None, gt=0)
    official_nav_date: date | None = None
    target_nav_date: date | None = None
    benchmark_id: str | None = Field(default=None, max_length=120)
    valuation_percentile: float | None = Field(default=None, ge=0, le=100)
    trend_state: str | None = Field(default=None, max_length=120)
    momentum_state: str | None = Field(default=None, max_length=120)
    drawdown: float | None = None
    volatility: float | None = Field(default=None, ge=0)
    market_temperature: float | None = Field(default=None, ge=0, le=100)
    score: float | None = Field(default=None, ge=0, le=100)
    score_version: str | None = Field(default=None, max_length=120)
    score_coverage: float = Field(ge=0, le=1)
    timing_signal: str | None = Field(default=None, max_length=80)
    timing_coverage: float = Field(ge=0, le=1)
    estimate: float | None = Field(default=None, ge=-100, le=1000)
    estimate_status: str = Field(min_length=1, max_length=80)
    estimate_coverage: float | None = Field(default=None, ge=0, le=100)
    estimate_model_version: str | None = Field(default=None, max_length=120)
    estimate_error_p80: float | None = Field(default=None, ge=0)
    estimate_sample_count: int | None = Field(default=None, ge=0)
    estimate_mae: float | None = Field(default=None, ge=0)
    estimate_direction_accuracy: float | None = Field(default=None, ge=0, le=100)
    source_states: list[SourceState] = Field(default_factory=list, max_length=30)
    evidence_nodes: list[EvidenceNode] = Field(default_factory=list, max_length=40)
    evidence_strength: float = Field(ge=0, le=100)
    missing_fields: list[str] = Field(default_factory=list, max_length=50)
    stale_fields: list[str] = Field(default_factory=list, max_length=50)
    risk_flags: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("created_at", "market_time")
    @classmethod
    def timezone_required(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("snapshot datetime must include a timezone")
        return value

    @model_validator(mode="after")
    def date_axis_is_consistent(self) -> "EvidenceSnapshot":
        if (self.official_nav is None) != (self.official_nav_date is None):
            raise ValueError("official NAV and date must either both exist or both be absent")
        if self.target_nav_date is not None:
            if self.official_nav_date is None or self.target_nav_date <= self.official_nav_date:
                raise ValueError("target NAV date must be later than the official base NAV date")
            if self.estimate is None:
                raise ValueError("target NAV date requires a real estimate")
        if self.market_time is not None and self.market_time > self.created_at:
            raise ValueError("market time cannot be later than snapshot creation")
        return self


class HoldingVersion(FrozenModel):
    schema_version: Literal["v8-holding-1"] = "v8-holding-1"
    holding_version: str = Field(pattern=r"^hold_[0-9a-f]{64}$")
    fund_code: str = Field(pattern=r"^\d{6}$")
    user_state: UserState
    shares: float | None = Field(default=None, ge=0)
    cost: float | None = Field(default=None, ge=0)
    market_value: float | None = Field(default=None, ge=0)
    account: str | None = Field(default=None, max_length=120)
    current_weight: float | None = Field(default=None, ge=0, le=100)
    target_weight: float | None = Field(default=None, ge=0, le=100)
    updated_at: datetime | None = None
    source: str = Field(min_length=1, max_length=120)
    created_at: datetime

    @model_validator(mode="after")
    def state_matches_position(self) -> "HoldingVersion":
        positive = any(
            value is not None and value > 0
            for value in (self.shares, self.market_value, self.current_weight)
        )
        if self.user_state == "unheld" and positive:
            raise ValueError("unheld holding cannot contain a positive position")
        for value in (self.updated_at, self.created_at):
            if value is not None and value.tzinfo is None:
                raise ValueError("holding datetime must include a timezone")
        return self


class PortfolioPolicy(FrozenModel):
    schema_version: Literal["v8-policy-1"] = "v8-policy-1"
    policy_version: str = Field(pattern=r"^pol_[0-9a-f]{64}$")
    name: str = Field(min_length=1, max_length=120)
    target_allocations: dict[str, float] = Field(default_factory=dict, max_length=100)
    target_ranges: dict[str, tuple[float, float]] = Field(default_factory=dict, max_length=100)
    max_single_fund_weight: float | None = Field(default=None, gt=0, le=100)
    max_theme_weight: float | None = Field(default=None, gt=0, le=100)
    rebalance_band: float | None = Field(default=None, ge=0, le=50)
    dca_rules: dict[str, Any] = Field(default_factory=dict, max_length=30)
    reduce_rules: dict[str, Any] = Field(default_factory=dict, max_length=30)
    sell_rules: dict[str, Any] = Field(default_factory=dict, max_length=30)
    effective_at: datetime
    created_at: datetime
    source: str = Field(min_length=1, max_length=120)
    supersedes: str | None = Field(default=None, pattern=r"^pol_[0-9a-f]{64}$")

    @model_validator(mode="after")
    def policy_is_bounded(self) -> "PortfolioPolicy":
        if sum(self.target_allocations.values()) > 100 + 1e-9:
            raise ValueError("target allocations cannot exceed 100%")
        for key, value in self.target_allocations.items():
            if not key.strip() or not math.isfinite(value) or value < 0 or value > 100:
                raise ValueError("target allocation is invalid")
        for key, bounds in self.target_ranges.items():
            low, high = bounds
            if (
                not key.strip()
                or not math.isfinite(low) or not math.isfinite(high)
                or low < 0 or high > 100 or low > high
            ):
                raise ValueError("target range is invalid")
        if self.effective_at.tzinfo is None or self.created_at.tzinfo is None:
            raise ValueError("policy datetime must include a timezone")
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
                raise ValueError(f"{key} must be a finite percentage in (0, 100]")
        minimum_confidence = self.dca_rules.get("minimum_confidence")
        if minimum_confidence is not None and (
            isinstance(minimum_confidence, bool)
            or not isinstance(minimum_confidence, (int, float))
            or not math.isfinite(float(minimum_confidence))
            or not 0 <= float(minimum_confidence) <= 100
        ):
            raise ValueError("minimum_confidence must be a finite percentage in [0, 100]")
        require_structural = self.sell_rules.get("require_structural_invalidation")
        if require_structural is not None and not isinstance(require_structural, bool):
            raise ValueError("require_structural_invalidation must be boolean")
        return self


class PositionGuidance(FrozenModel):
    current_weight: float | None = Field(default=None, ge=0, le=100)
    target_weight: float | None = Field(default=None, ge=0, le=100)
    target_range: tuple[float, float] | None = None
    suggested_change: float | None = Field(default=None, ge=-100, le=100)
    suggested_range: tuple[float, float] | None = None
    method: str = Field(min_length=1, max_length=240)
    amount: float | None = Field(default=None, ge=0)
    precise: bool

    @model_validator(mode="after")
    def ranges_are_ordered(self) -> "PositionGuidance":
        for bounds in (self.target_range, self.suggested_range):
            if bounds is not None and (bounds[0] < 0 or bounds[1] > 100 or bounds[0] > bounds[1]):
                raise ValueError("position range is invalid")
        return self


class DecisionSnapshot(FrozenModel):
    schema_version: Literal["v8-decision-1"] = "v8-decision-1"
    decision_id: str = Field(pattern=r"^dec_[0-9a-f]{64}$")
    evidence_id: str = Field(pattern=r"^ev_[0-9a-f]{64}$")
    fund_code: str = Field(pattern=r"^\d{6}$")
    holding_version: str = Field(pattern=r"^hold_[0-9a-f]{64}$")
    policy_version: str = Field(pattern=r"^pol_[0-9a-f]{64}$")
    strategy_version: str = Field(min_length=1, max_length=120)
    user_state: UserState
    action: Action
    strength: int = Field(ge=0, le=100)
    confidence: int = Field(ge=0, le=100)
    summary: str = Field(min_length=1, max_length=600)
    reason_codes: list[str] = Field(min_length=1, max_length=30)
    reasons: list[str] = Field(min_length=1, max_length=30)
    risks: list[str] = Field(default_factory=list, max_length=30)
    invalidation_codes: list[str] = Field(min_length=1, max_length=30)
    invalidation_conditions: list[str] = Field(min_length=1, max_length=30)
    position_guidance: PositionGuidance | None = None
    evidence_nodes: list[EvidenceNode] = Field(default_factory=list, max_length=40)
    created_at: datetime

    @model_validator(mode="after")
    def decision_axis_is_consistent(self) -> "DecisionSnapshot":
        if self.created_at.tzinfo is None:
            raise ValueError("decision datetime must include a timezone")
        allowed = (
            {"buy", "dca", "watch"}
            if self.user_state == "unheld"
            else {"add", "hold", "reduce", "sell"}
        )
        if self.action not in allowed:
            raise ValueError("decision action is incompatible with user state")
        if self.reason_codes[0] != f"ACTION_{self.action.upper()}":
            raise ValueError("decision reason codes must identify the selected action")
        return self


class DecisionDiff(FrozenModel):
    previous_decision_id: str | None = None
    current_decision_id: str
    previous_action: Action | None = None
    current_action: Action
    changed: bool
    drivers: list[str] = Field(default_factory=list, max_length=30)
    driver_codes: list[str] = Field(default_factory=list, max_length=30)
    unchanged: list[str] = Field(default_factory=list, max_length=30)


class PortfolioDecisionComponent(FrozenModel):
    """One exact fund decision and its unmodified portfolio weights."""

    fund_code: str = Field(pattern=r"^\d{6}$")
    fund_name: str | None = Field(default=None, max_length=200)
    decision_id: str = Field(pattern=r"^dec_[0-9a-f]{64}$")
    evidence_id: str = Field(pattern=r"^ev_[0-9a-f]{64}$")
    holding_version: str = Field(pattern=r"^hold_[0-9a-f]{64}$")
    action: Action
    theme: str | None = Field(default=None, min_length=1, max_length=120)
    current_weight: float = Field(ge=0, le=100)
    target_weight: float = Field(ge=0, le=100)

    @model_validator(mode="after")
    def weights_are_finite(self) -> "PortfolioDecisionComponent":
        if not math.isfinite(self.current_weight) or not math.isfinite(self.target_weight):
            raise ValueError("portfolio component weights must be finite")
        return self


class PortfolioDecisionSnapshot(FrozenModel):
    """Immutable composition used as the sole base for V8 portfolio outcomes."""

    schema_version: Literal["v8-portfolio-decision-1"] = "v8-portfolio-decision-1"
    portfolio_decision_id: str = Field(pattern=r"^pdec_[0-9a-f]{64}$")
    decision_date: date
    policy_version: str = Field(pattern=r"^pol_[0-9a-f]{64}$")
    strategy_version: str = Field(min_length=1, max_length=120)
    components: list[PortfolioDecisionComponent] = Field(min_length=1, max_length=50)
    current_cash_weight: float = Field(ge=0, le=100)
    target_cash_weight: float = Field(ge=0, le=100)
    portfolio_value: float | None = Field(default=None, ge=0)
    source: str = Field(min_length=1, max_length=120)
    created_at: datetime

    @model_validator(mode="after")
    def composition_is_complete(self) -> "PortfolioDecisionSnapshot":
        if self.created_at.tzinfo is None:
            raise ValueError("portfolio decision datetime must include a timezone")
        if self.decision_date > self.created_at.astimezone(
            timezone(timedelta(hours=8))
        ).date():
            raise ValueError("portfolio decision date cannot be after its creation date")
        codes = [item.fund_code for item in self.components]
        decision_ids = [item.decision_id for item in self.components]
        if len(codes) != len(set(codes)) or len(decision_ids) != len(set(decision_ids)):
            raise ValueError("portfolio decision components must be unique")
        current_total = sum(item.current_weight for item in self.components)
        target_total = sum(item.target_weight for item in self.components)
        if not math.isclose(current_total + self.current_cash_weight, 100, abs_tol=1e-6):
            raise ValueError("current fund weights and cash must total 100%")
        if not math.isclose(target_total + self.target_cash_weight, 100, abs_tol=1e-6):
            raise ValueError("target fund weights and cash must total 100%")
        if self.portfolio_value is not None and not math.isfinite(self.portfolio_value):
            raise ValueError("portfolio value must be finite")
        return self


class PortfolioOutcomeComponent(FrozenModel):
    fund_code: str = Field(pattern=r"^\d{6}$")
    current_weight: float = Field(ge=0, le=100)
    base_nav: float = Field(gt=0)
    evaluated_nav: float = Field(gt=0)
    absolute_return: float
    contribution: float

    @model_validator(mode="after")
    def contribution_matches_navs(self) -> "PortfolioOutcomeComponent":
        values = (
            self.current_weight,
            self.base_nav,
            self.evaluated_nav,
            self.absolute_return,
            self.contribution,
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError("portfolio outcome component values must be finite")
        expected_return = (self.evaluated_nav / self.base_nav - 1) * 100
        if not math.isclose(self.absolute_return, expected_return, abs_tol=5e-4):
            raise ValueError("component return does not match its NAV values")
        expected_contribution = self.current_weight / 100 * expected_return
        if not math.isclose(self.contribution, expected_contribution, abs_tol=5e-4):
            raise ValueError("component contribution does not match its weight and return")
        return self


class PortfolioOutcomeEvaluation(FrozenModel):
    schema_version: Literal["v8-portfolio-outcome-1"] = "v8-portfolio-outcome-1"
    outcome_id: str = Field(pattern=r"^pout_[0-9a-f]{64}$")
    portfolio_decision_id: str = Field(pattern=r"^pdec_[0-9a-f]{64}$")
    horizon: Literal[5, 20, 60]
    base_nav_date: date
    evaluation_date: date
    absolute_return: float
    max_drawdown: float = Field(ge=-100, le=0)
    current_cash_weight: float = Field(ge=0, le=100)
    cash_return: Literal[0.0] = 0.0
    cash_contribution: Literal[0.0] = 0.0
    components: list[PortfolioOutcomeComponent] = Field(min_length=1, max_length=50)
    method: Literal["common_nav_dates_no_forward_fill"] = "common_nav_dates_no_forward_fill"
    created_at: datetime

    @model_validator(mode="after")
    def common_axis_is_consistent(self) -> "PortfolioOutcomeEvaluation":
        if self.created_at.tzinfo is None:
            raise ValueError("portfolio outcome datetime must include a timezone")
        market_date = self.created_at.astimezone(timezone(timedelta(hours=8))).date()
        if self.evaluation_date > market_date:
            raise ValueError("portfolio outcome evaluation date cannot be in the future")
        if self.evaluation_date <= self.base_nav_date:
            raise ValueError("portfolio outcome evaluation must be after its base date")
        codes = [item.fund_code for item in self.components]
        if len(codes) != len(set(codes)):
            raise ValueError("portfolio outcome components must be unique")
        if not math.isclose(
            sum(item.current_weight for item in self.components) + self.current_cash_weight,
            100,
            abs_tol=1e-6,
        ):
            raise ValueError("portfolio outcome fund weights and cash must total 100%")
        expected_return = sum(item.contribution for item in self.components)
        if not math.isclose(self.absolute_return, expected_return, abs_tol=5e-4):
            raise ValueError("portfolio return does not match component contributions")
        if not math.isfinite(self.absolute_return) or not math.isfinite(self.max_drawdown):
            raise ValueError("portfolio outcome values must be finite")
        return self


class OutcomeEvaluation(FrozenModel):
    schema_version: Literal["v8-outcome-1"] = "v8-outcome-1"
    outcome_id: str = Field(pattern=r"^out_[0-9a-f]{64}$")
    decision_id: str = Field(pattern=r"^dec_[0-9a-f]{64}$")
    evaluation_kind: Literal["horizon", "qdii_target"]
    horizon: Literal[0, 5, 20, 60]
    base_nav_date: date
    evaluation_date: date
    target_nav_date: date | None = None
    base_nav: float = Field(gt=0)
    evaluated_nav: float = Field(gt=0)
    absolute_return: float
    benchmark_return: float | None = None
    peer_excess: float | None = None
    max_drawdown: float = Field(ge=-100, le=0)
    hit: bool
    benchmark_samples: int = Field(default=0, ge=0)
    predicted_change: float | None = None
    prediction_error: float | None = None
    created_at: datetime

    @model_validator(mode="after")
    def evaluation_axis_is_consistent(self) -> "OutcomeEvaluation":
        if self.created_at.tzinfo is None:
            raise ValueError("outcome created_at must include a timezone")
        market_date = self.created_at.astimezone(timezone(timedelta(hours=8))).date()
        if self.evaluation_date > market_date:
            raise ValueError("outcome evaluation date cannot be in the future")
        if self.evaluation_date <= self.base_nav_date:
            raise ValueError("outcome evaluation must be after the base NAV date")
        if self.evaluation_kind == "horizon":
            if self.horizon not in {5, 20, 60}:
                raise ValueError("horizon outcome requires a 5/20/60 horizon")
        else:
            if self.horizon != 0 or self.target_nav_date is None:
                raise ValueError("QDII target outcome requires horizon 0 and a target date")
            if self.evaluation_date != self.target_nav_date:
                raise ValueError("QDII target outcome must use the exact target date")
        return self


class NotificationEvent(FrozenModel):
    notification_event_id: str = Field(pattern=r"^ntf_[0-9a-f]{64}$")
    event_log_id: str = Field(pattern=r"^ntl_[0-9a-f]{64}$")
    decision_id: str = Field(pattern=r"^dec_[0-9a-f]{64}$")
    scheduled_window: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$")
    status: Literal["scheduled", "skipped", "attempted", "sent", "failed", "compensated"]
    attempt_no: int = Field(ge=0, le=100)
    natural_schedule: bool
    occurred_at: datetime
    error_class: str | None = Field(default=None, max_length=120)
    detail: dict[str, Any] = Field(default_factory=dict, max_length=30)

    @model_validator(mode="after")
    def event_axis_is_consistent(self) -> "NotificationEvent":
        try:
            scheduled = datetime.fromisoformat(self.scheduled_window)
        except ValueError as error:
            raise ValueError("scheduled window must be a valid datetime") from error
        if scheduled.tzinfo is None or self.occurred_at.tzinfo is None:
            raise ValueError("notification datetimes must include a timezone")
        if self.status in {"scheduled", "skipped"} and self.attempt_no != 0:
            raise ValueError("scheduled/skipped events require attempt 0")
        if self.status in {"attempted", "sent", "failed", "compensated"} and self.attempt_no < 1:
            raise ValueError("send events require a positive attempt number")
        if self.status != "failed" and self.error_class is not None:
            raise ValueError("only failed events can include an error class")
        return self
