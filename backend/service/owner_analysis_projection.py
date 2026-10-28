"""Pure fund-only projection of the complete server-confirmed Owner source."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from models.owner_sync import MAX_SAFE_INTEGER, allowed_fields, normalize_key, normalize_record
from models.v8 import EvidenceSnapshot

_MARKET_TZ = timezone(timedelta(hours=8))
_RECORD_FIELDS = frozenset({
    "key", "kind", "deleted", "record_revision", "lifecycle_revision",
    "field_revisions", "values",
})


class OwnerProjectionError(ValueError):
    """A fixed error with no private source values or validation internals."""

    code = "invalid_owner_projection"

    def __init__(self):
        super().__init__("Owner holding projection rejected")


@dataclass(frozen=True)
class ProjectedFundHolding:
    code: str
    is_held: bool
    shares: float | None
    cost: float | None
    market_value: float | None
    current_weight: float | None
    target_weight: float | None
    account_count: int


@dataclass(frozen=True)
class OwnerFundProjection:
    holdings: tuple[ProjectedFundHolding, ...]
    pricing_complete: bool
    unavailable_codes: tuple[str, ...]
    scope: Literal["fund_only"] = "fund_only"


def _revision(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= MAX_SAFE_INTEGER:
        raise OwnerProjectionError()
    return value


def _record(value: Any) -> None:
    if type(value) is not dict or set(value) != _RECORD_FIELDS:
        raise OwnerProjectionError()
    kind = value["kind"]
    if type(kind) is not str or type(value["deleted"]) is not bool:
        raise OwnerProjectionError()
    if normalize_key(value["key"], kind) != value["key"]:
        raise OwnerProjectionError()
    revision = _revision(value["record_revision"])
    if _revision(value["lifecycle_revision"]) > revision:
        raise OwnerProjectionError()
    fields = value["field_revisions"]
    expected_fields = allowed_fields(kind)
    if type(fields) is not dict or set(fields) != expected_fields:
        raise OwnerProjectionError()
    if any(_revision(stamp) > revision for stamp in fields.values()):
        raise OwnerProjectionError()
    values = value["values"]
    if type(values) is not dict or set(values) != expected_fields:
        raise OwnerProjectionError()
    normalize_record(kind, values, require_complete=False)


def _sum(values) -> float:
    result = math.fsum(values)
    if not math.isfinite(result):
        raise OwnerProjectionError()
    return result


def _product(left: float, right: float) -> float:
    result = left * right
    if not math.isfinite(result):
        raise OwnerProjectionError()
    return result


def _evidence(code: str, value: Any, at: datetime) -> EvidenceSnapshot:
    if type(value) is not EvidenceSnapshot:
        raise OwnerProjectionError()
    # Frozen model_copy/model_construct can otherwise bypass V8 validation.
    checked = EvidenceSnapshot.model_validate(value.model_dump())
    if checked.fund_code != code or checked.created_at > at:
        raise OwnerProjectionError()
    if checked.market_time is not None and checked.market_time > at:
        raise OwnerProjectionError()
    for state in checked.source_states:
        for stamp in (state.last_success, state.last_failure):
            if stamp is not None and (stamp.tzinfo is None or stamp.utcoffset() is None or stamp > at):
                raise OwnerProjectionError()
    if checked.official_nav_date is not None and checked.official_nav_date > at.astimezone(_MARKET_TZ).date():
        raise OwnerProjectionError()
    if checked.official_nav is not None and not math.isfinite(checked.official_nav):
        raise OwnerProjectionError()
    return checked


def project_fund_holdings(
    records: list[dict], evidence_by_code: dict[str, EvidenceSnapshot], at: datetime,
) -> OwnerFundProjection:
    """Never normalize a partial pricing denominator into complete weights.

    Holding rows, including explicit zero and unknown shares, represent held
    status. Watch rows never contribute position finance. Manual assets and
    tombstones remain in the caller's complete source but not this fund scope.
    """
    try:
        if type(records) is not list or len(records) > 100_000 or type(evidence_by_code) is not dict:
            raise OwnerProjectionError()
        if type(at) is not datetime or at.tzinfo is None or at.utcoffset() is None:
            raise OwnerProjectionError()
        evidence = {}
        for code, item in evidence_by_code.items():
            if type(code) is not str or len(code) != 6 or not code.isascii() or not code.isdigit():
                raise OwnerProjectionError()
            evidence[code] = _evidence(code, item, at)
        grouped: dict[str, list[dict]] = {}
        seen = set()
        for record in records:
            _record(record)
            if record["key"] in seen:
                raise OwnerProjectionError()
            seen.add(record["key"])
            if not record["deleted"] and record["kind"] != "manual_asset":
                grouped.setdefault(record["key"][:6], []).append(record)

        projected = []
        unavailable = []
        known_targets = []
        today = at.astimezone(_MARKET_TZ).date()
        for code in sorted(grouped):
            positions = [row["values"] for row in grouped[code] if row["kind"] == "holding"]
            if not positions:
                projected.append(ProjectedFundHolding(code, False, None, None, None, None, None, 0))
                continue
            targets = [row["target_weight"] for row in positions]
            target_subtotal = _sum(value for value in targets if value is not None)
            if target_subtotal > 100:
                raise OwnerProjectionError()
            known_targets.append(target_subtotal)
            target = target_subtotal if all(value is not None for value in targets) else None
            shares = None if any(row["shares"] is None for row in positions) else _sum(row["shares"] for row in positions)
            cost = None
            if shares is not None and shares > 0 and all(row["cost"] is not None for row in positions):
                cost = _sum(_product(row["shares"], row["cost"]) for row in positions) / shares
                if not math.isfinite(cost):
                    raise OwnerProjectionError()
            nav = evidence.get(code)
            usable_nav = (
                nav is not None and nav.official_nav is not None and nav.official_nav_date is not None
                and (today - nav.official_nav_date).days <= 7
                and not {"official_nav", "official_nav_date"}.intersection(nav.stale_fields)
            )
            if shares == 0:
                market_value = 0.0
            elif shares is None or not usable_nav:
                market_value = None
                unavailable.append(code)
            else:
                market_value = _product(shares, nav.official_nav)
            projected.append(ProjectedFundHolding(
                code, True, shares, cost, market_value, None, target, len(positions),
            ))

        if _sum(known_targets) > 100:
            raise OwnerProjectionError()
        denominator = _sum(row.market_value for row in projected if row.is_held and row.market_value is not None)
        pricing_complete = not unavailable
        if pricing_complete:
            weighted = []
            for row in projected:
                weight = None
                if row.is_held:
                    # Divide before multiplying to avoid a needless 100x
                    # intermediate overflow for a valid finite market value.
                    weight = row.market_value / denominator * 100 if denominator > 0 else 0.0
                    if not math.isfinite(weight) or not 0 <= weight <= 100:
                        raise OwnerProjectionError()
                weighted.append(ProjectedFundHolding(
                    row.code, row.is_held, row.shares, row.cost, row.market_value,
                    weight, row.target_weight, row.account_count,
                ))
            projected = weighted
        return OwnerFundProjection(tuple(projected), pricing_complete, tuple(unavailable))
    except (TypeError, ValueError, UnicodeError, OverflowError, RecursionError):
        raise OwnerProjectionError() from None
