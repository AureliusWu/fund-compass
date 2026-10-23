"""Cross-account pricing and denominator checks on synthetic server records."""
from copy import deepcopy
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone

import pytest

from models.owner_sync import allowed_fields
from models.v8 import EvidenceSnapshot, SourceState
from service.owner_analysis_projection import OwnerProjectionError, project_fund_holdings


AT = datetime(2026, 10, 23, 6, 30, tzinfo=timezone.utc)


def record(code="510300", account="账户 A", kind="holding", deleted=False, **values):
    base = {"name": "合成基金", "shares": 10, "cost": 1, "target_weight": 10}
    if kind == "watch":
        base = {"name": "仅关注", "shares": None, "cost": None, "target_weight": None}
    if kind == "manual_asset":
        base = {"name": "手工现金", "cls": "现金", "value": 1e6, "note": None}
    return {
        "key": f"{code}::{account}" if kind != "manual_asset" else "asset:" + account,
        "kind": kind, "deleted": deleted, "record_revision": 3,
        "lifecycle_revision": 1,
        "field_revisions": {name: 3 for name in allowed_fields(kind)},
        "values": {**base, **values},
    }


def evidence(code="510300", nav=2, days=0, **patch):
    return EvidenceSnapshot(
        evidence_id="ev_" + "a" * 64, fund_code=code, fund_type="指数型",
        created_at=AT - timedelta(minutes=1), official_nav=nav,
        official_nav_date=(AT + timedelta(hours=8)).date() - timedelta(days=days) if nav is not None else None,
        score_coverage=0, timing_coverage=0, estimate_status="unavailable", evidence_strength=0,
        **patch,
    )


def rejects(records, prices=None, at=AT):
    with pytest.raises(OwnerProjectionError) as caught:
        project_fund_holdings(records, prices or {}, at)
    assert caught.value.code == "invalid_owner_projection"
    assert str(caught.value) == "Owner holding projection rejected"


def test_actual_multiple_accounts_have_one_fund_denominator_and_weighted_cost():
    source = [
        record(shares=10, cost=1, target_weight=10),
        record(account="账户 B", shares=30, cost=3, target_weight=20),
        record(code="000001", shares=60, cost=4, target_weight=70),
        record(kind="watch", account="关注账户", target_weight=100),
        record(kind="manual_asset"),
        record(code="999999", deleted=True, shares=1e300, target_weight=100),
    ]
    prices = {"510300": evidence(), "000001": evidence("000001", nav=2)}
    original, originals = deepcopy(source), {code: item.model_dump() for code, item in prices.items()}
    result = project_fund_holdings(source, prices, AT)
    rows = {row.code: row for row in result.holdings}
    assert result.scope == "fund_only" and result.pricing_complete
    assert result.unavailable_codes == ()
    assert tuple(rows) == ("000001", "510300")
    aggregate = rows["510300"]
    assert aggregate.is_held and aggregate.account_count == 2
    assert aggregate.shares == 40 and aggregate.cost == 2.5
    assert aggregate.target_weight == 30 and aggregate.market_value == 80
    assert aggregate.current_weight == 40
    assert rows["000001"].current_weight == 60
    assert source == original
    assert {code: item.model_dump() for code, item in prices.items()} == originals
    with pytest.raises(FrozenInstanceError):
        result.scope = "total_assets"
    with pytest.raises(FrozenInstanceError):
        aggregate.shares = 1


def test_watch_zero_and_unknown_share_holding_remain_three_distinct_states():
    source = [record(kind="watch"), record("000001", shares=0, cost=9), record("000002", shares=None)]
    result = project_fund_holdings(source, {"510300": evidence()}, AT)
    rows = {row.code: row for row in result.holdings}
    watch = rows["510300"]
    assert (watch.is_held, watch.shares, watch.cost, watch.target_weight, watch.account_count) == (False, None, None, None, 0)
    zero = rows["000001"]
    assert zero.is_held and zero.shares == 0 and zero.market_value == 0 and zero.cost is None
    unknown = rows["000002"]
    assert unknown.is_held and unknown.shares is None and unknown.market_value is None
    assert not result.pricing_complete and result.unavailable_codes == ("000002",)
    assert all(row.current_weight is None for row in result.holdings)


@pytest.mark.parametrize("unknown", ["shares", "cost", "target_weight"])
def test_one_missing_account_component_is_not_replaced_by_zero(unknown):
    partial = {"shares": 20, "cost": 4, "target_weight": 20, unknown: None}
    source = [record(shares=10, cost=2, target_weight=10), record(account="B", **partial)]
    result = project_fund_holdings(source, {"510300": evidence()}, AT)
    aggregate = result.holdings[0]
    assert getattr(aggregate, unknown) is None
    if unknown == "shares":
        assert aggregate.cost is None and aggregate.market_value is None and aggregate.current_weight is None
    else:
        assert aggregate.shares == 30 and aggregate.current_weight == 100


def test_missing_cost_on_even_a_zero_account_stays_unknown_and_target_zero_is_real():
    result = project_fund_holdings([
        record(shares=10, cost=2, target_weight=0),
        record(account="B", shares=0, cost=None, target_weight=0),
    ], {"510300": evidence()}, AT)
    assert result.holdings[0].cost is None
    assert result.holdings[0].target_weight == 0
    assert result.holdings[0].current_weight == 100


@pytest.mark.parametrize("pricing", ["absent", "unknown", "stale", "stale_field"])
def test_one_unpriced_positive_fund_invalidates_all_current_weights(pricing):
    prices = {"510300": evidence()}
    if pricing == "unknown":
        prices["000001"] = evidence("000001", nav=None)
    elif pricing == "stale":
        prices["000001"] = evidence("000001", days=8)
    elif pricing == "stale_field":
        prices["000001"] = evidence("000001", stale_fields=["official_nav"])
    result = project_fund_holdings([record(), record("000001"), record("000002", shares=0)], prices, AT)
    rows = {row.code: row for row in result.holdings}
    assert rows["510300"].market_value == 20
    assert rows["000001"].market_value is None
    assert rows["000002"].market_value == 0
    assert not result.pricing_complete and result.unavailable_codes == ("000001",)
    assert all(row.current_weight is None for row in result.holdings)


def test_actual_nav_day_not_fresh_capture_time_controls_seven_day_boundary():
    source = [record()]
    assert project_fund_holdings(source, {"510300": evidence(days=7)}, AT).pricing_complete
    fresh_capture_old_nav = evidence(days=8).model_copy(update={"created_at": AT})
    assert not project_fund_holdings(source, {"510300": fresh_capture_old_nav}, AT).pricing_complete
    # At UTC 17:00 it is already the following NAV calendar day in Shanghai.
    later = AT.replace(hour=17)
    assert not project_fund_holdings(source, {"510300": evidence(days=7)}, later).pricing_complete


def test_complete_zero_value_portfolio_gets_real_zero_weights_without_requiring_prices():
    result = project_fund_holdings([record(shares=0), record("000001", shares=0), record("000002", kind="watch")], {}, AT)
    assert result.pricing_complete and result.unavailable_codes == ()
    assert [(row.is_held, row.market_value, row.current_weight) for row in result.holdings] == [
        (True, 0, 0), (False, None, None), (True, 0, 0),
    ]


def test_empty_manual_only_deleted_only_inputs_have_no_fund_positions():
    for source in ([], [record(kind="manual_asset")], [record(deleted=True)]):
        result = project_fund_holdings(source, {}, AT)
        assert result.holdings == () and result.pricing_complete and result.scope == "fund_only"


@pytest.mark.parametrize("source", [
    [record(target_weight=60), record(account="B", target_weight=41)],
    [record(target_weight=60), record("000001", target_weight=41)],
    [record(target_weight=60), record("000001", target_weight=41), record("000002", target_weight=None)],
    [record(target_weight=100.00000000000001)],
    [record(shares=1e308), record(account="B", shares=1e308)],
    [record(shares=1e308, cost=1e308)],
    [record(shares=1e308, cost=0)],
])
def test_target_overallocation_and_numeric_overflow_are_refused(source):
    rejects(source, {"510300": evidence(nav=10), "000001": evidence("000001")})


def test_portfolio_total_value_overflow_is_refused_even_when_each_fund_value_is_finite():
    rejects([record(shares=1e308, cost=0), record("000001", shares=1e308, cost=0)], {
        "510300": evidence(nav=1), "000001": evidence("000001", nav=1),
    })


def test_missing_third_fund_does_not_hide_overflow_in_the_known_partial_values():
    rejects([record(shares=1e308, cost=0), record("000001", shares=1e308, cost=0), record("000002")], {
        "510300": evidence(nav=1), "000001": evidence("000001", nav=1),
    })


@pytest.mark.parametrize("patch", [
    {"created_at": AT + timedelta(microseconds=1)},
    {"market_time": AT + timedelta(seconds=1), "created_at": AT + timedelta(seconds=1)},
    {"official_nav_date": AT.date() + timedelta(days=1)},
    {"official_nav": float("inf")}, {"official_nav": float("nan")},
    {"official_nav": -1}, {"fund_code": "000001"},
    {"created_at": AT.replace(tzinfo=None)},
    {"official_nav_date": None},
])
def test_future_and_invalid_evidence_is_refused_without_changing_inputs(patch):
    price = evidence().model_copy(update=patch)
    rejects([record()], {"510300": price})


def test_predictive_target_day_is_not_used_as_the_official_price_day():
    price = evidence(estimate=1, target_nav_date=AT.date() + timedelta(days=2))
    result = project_fund_holdings([record()], {"510300": price}, AT)
    assert result.holdings[0].market_value == 20 and result.pricing_complete


@pytest.mark.parametrize("field", ["last_success", "last_failure"])
@pytest.mark.parametrize("stamp", [AT + timedelta(microseconds=1), AT.replace(tzinfo=None)])
def test_health_timestamps_cannot_represent_unknown_timezone_or_future_observations(field, stamp):
    state = SourceState(source_id="synthetic-nav", state="healthy", stale=False, **{field: stamp})
    rejects([record()], {"510300": evidence(source_states=[state])})


@pytest.mark.parametrize("change", [
    {"shares": True}, {"shares": -1}, {"shares": float("nan")}, {"shares": 2**53},
    {"cost": float("inf")}, {"target_weight": -1}, {"target_weight": "10"},
])
def test_invalid_financial_values_are_refused(change):
    rejects([record(**change)])


def test_source_requires_complete_envelopes_and_unique_normalized_server_keys():
    good = record()
    variants = []
    for field in good:
        incomplete = deepcopy(good)
        del incomplete[field]
        variants.append(incomplete)
    variants += [
        {**good, "extra": 1}, {**good, "key": "510300:: 账户 A "},
        {**good, "deleted": 0}, {**good, "record_revision": True},
        {**good, "lifecycle_revision": 4},
        {**good, "field_revisions": {**good["field_revisions"], "cost": 4}},
        {**good, "values": {"name": "incomplete"}},
    ]
    for invalid in variants:
        rejects([invalid])
    rejects([good, deepcopy(good)])
    rejects([record(kind="manual_asset", value=float("inf"))])
    rejects([record(deleted=True, shares=-1)])


def test_aware_clock_native_collections_and_evidence_map_identity_are_required():
    rejects([record()], at=AT.replace(tzinfo=None))
    rejects(tuple([record()]))
    rejects([record()], {"000001": evidence()})
    rejects([record()], {"510300": evidence().model_dump()})
