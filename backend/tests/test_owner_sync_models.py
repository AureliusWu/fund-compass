"""Synthetic, offline inputs; no personal storage or cloud credentials."""
import json
import math

import pytest
from pydantic import ValidationError

from models.owner_sync import (
    MAX_BODY_BYTES, MAX_JSON_DEPTH, MAX_OPERATIONS, MAX_SAFE_INTEGER,
    OwnerSyncRequest, SyncValidationError, js_trim, normalize_key,
    normalize_record, normalize_sync_key, parse_sync_request, validate_values,
)


def operation(**patch):
    value = {"key": "000001::账户 A", "kind": "holding", "deleted": False,
             "changes": {"name": "合成基金", "shares": 0, "cost": None, "target_weight": 0},
             "base_values": {}}
    return {**value, **patch}


def body(**patch):
    return {"request_id": "synthetic-0001", "expected_revision": 0,
            "operations": [operation()], **patch}


def raw(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def rejects(value):
    with pytest.raises(SyncValidationError) as caught:
        parse_sync_request(value)
    assert caught.value.code == "invalid_sync_request"
    assert str(caught.value) == "Owner sync input rejected"
    assert "合成" not in str(caught.value)


def test_unknown_zero_and_original_numeric_types_are_preserved():
    request = parse_sync_request(raw(body()))
    values = request.operations[0].changes
    assert values["shares"] == 0 and type(values["shares"]) is int
    assert values["cost"] is None and values["target_weight"] == 0
    assert request.model_dump()["operations"][0]["changes"] == dict(values)
    assert len(request.request_hash()) == 64
    with pytest.raises(TypeError):
        values["cost"] = 3
    with pytest.raises(TypeError):
        values.update({"cost": 3})
    with pytest.raises(ValidationError):
        request.expected_revision = 1
    with pytest.raises(ValidationError):
        request.operations[0].deleted = True


def test_hash_only_ignores_object_key_order_and_json_whitespace():
    value = body()
    other = dict(reversed(list(value.items())))
    other["operations"] = [dict(reversed(list(value["operations"][0].items())))]
    first = parse_sync_request(raw(value))
    second = parse_sync_request(json.dumps(other, ensure_ascii=False, indent=4))
    assert first.request_hash() == second.request_hash()
    assert first.canonical_body() == second.canonical_body()


def test_hash_preserves_omission_null_raw_identity_and_number_tokens():
    baseline = raw(body(operations=[operation(changes={"shares": 1})]))
    variants = [baseline, baseline.replace('"shares":1', '"shares":1.0'),
                baseline.replace('"shares":1', '"shares":1e0'),
                raw(body(operations=[operation(changes={"shares": 1, "cost": None})])),
                raw(body(operations=[operation(key="000001:: 账户 A ", changes={"shares": 1})]))]
    parsed = [parse_sync_request(item) for item in variants]
    assert len({item.request_hash() for item in parsed}) == len(variants)
    assert len({item.operations[0].key for item in parsed}) == 1
    assert type(parsed[0].operations[0].changes["shares"]) is int
    assert type(parsed[1].operations[0].changes["shares"]) is float
    zeros = [parse_sync_request(baseline.replace('"shares":1', '"shares":' + token))
             for token in ("0", "-0", "0.0", "-0.0")]
    assert len({item.request_hash() for item in zeros}) == 4


def test_direct_model_validation_cannot_invent_raw_idempotency_provenance():
    request = OwnerSyncRequest.model_validate(body())
    with pytest.raises(SyncValidationError):
        request.request_hash()
    with pytest.raises(SyncValidationError):
        request.canonical_body()


@pytest.mark.parametrize("value", [None, {}, bytearray(b"{}"), b"\xff", "", "[]", "null", "1", "{} trailing"])
def test_parser_requires_bounded_valid_raw_utf8_object(value):
    rejects(value)


@pytest.mark.parametrize("value", [
    '{"request_id":"synthetic-0001","request_id":"synthetic-0002","expected_revision":0,"operations":[]}',
    '{"request_id":"synthetic-0001","request_\\u0069d":"synthetic-0002","expected_revision":0,"operations":[]}',
    raw(body()).replace('"shares":0', '"shares":0,"shares":1'),
    raw(body()).replace('"cost":null', '"cost":NaN'),
    raw(body()).replace('"cost":null', '"cost":Infinity'),
    raw(body()).replace('"cost":null', '"cost":-Infinity'),
    raw(body()).replace('"cost":null', '"cost":1e999'),
    raw(body()).replace('"cost":null', '"cost":' + str(MAX_SAFE_INTEGER + 1)),
    raw(body()).replace('"cost":null', '"cost":-' + str(MAX_SAFE_INTEGER + 1)),
    raw(body()).replace('合成基金', '\\ud800'),
    raw(body()).replace('合成基金', '\\udfff'),
])
def test_duplicate_keys_invalid_numbers_and_lone_surrogates_fail_closed(value):
    rejects(value)


def test_bytes_limit_is_utf8_bytes_and_bounded_whitespace_is_valid():
    encoded = raw(body()).encode("utf-8")
    exact = encoded + b" " * (MAX_BODY_BYTES - len(encoded))
    assert parse_sync_request(exact).request_id == "synthetic-0001"
    rejects(exact + b" ")
    rejects(raw(body(operations=[operation(changes={"name": "中" * MAX_BODY_BYTES})])))


def test_depth_limit_rejects_before_model_validation(monkeypatch):
    def unexpected(*_args, **_kwargs):
        pytest.fail("over-depth input reached model validation")
    monkeypatch.setattr(OwnerSyncRequest, "model_validate", unexpected)
    nested = 0
    for _ in range(MAX_JSON_DEPTH + 1):
        nested = [nested]
    rejects(raw({"synthetic": nested}))


def test_operation_limit_and_normalized_duplicate_identity():
    ops = [operation(key=f"{index:06d}::") for index in range(MAX_OPERATIONS)]
    assert len(parse_sync_request(raw(body(operations=ops))).operations) == MAX_OPERATIONS
    rejects(raw(body(operations=ops + [operation(key="999999::")])))
    rejects(raw(body(operations=[])))
    rejects(raw(body(operations=[operation(key="000001::\u00a0账户\ufeff"),
                                  operation(key="000001::账户", kind="watch", changes={"name": "关注"})])))


@pytest.mark.parametrize("patch", [{"extra": "private"}, {"expected_revision": True},
                                  {"expected_revision": 1.0}, {"expected_revision": -1},
                                  {"expected_revision": MAX_SAFE_INTEGER + 1},
                                  {"request_id": "short"}, {"request_id": "unsafe/private"},
                                  {"request_id": "x" * 129}, {"operations": {"x": operation()}}])
def test_request_closed_fields_and_safe_strict_revision(patch):
    rejects(raw(body(**patch)))


@pytest.mark.parametrize("patch", [{"kind": "cash"}, {"deleted": 0}, {"key": "000001"},
                                  {"key": "asset:fund"}, {"kind": "manual_asset"},
                                  {"code": "000001"}, {"changes": None}, {"base_values": []}])
def test_operation_closed_shape_identity_and_boolean(patch):
    rejects(raw(body(operations=[operation(**patch)])))


@pytest.mark.parametrize("field", ["code", "account", "id", "kind", "deleted", "revision", "holding_version", "policy"])
def test_changes_cannot_change_identity_lifecycle_or_add_arbitrary_fields(field):
    rejects(raw(body(operations=[operation(changes={field: None})])))
    if field not in {"kind", "deleted"}:
        rejects(raw(body(operations=[operation(base_values={field: None})])))


@pytest.mark.parametrize("field,value", [("shares", True), ("cost", False), ("target_weight", True),
                                        ("shares", -1), ("cost", -0.1), ("target_weight", 100.01),
                                        ("shares", "0"), ("name", None), ("name", "\u3000"),
                                        ("name", "private\x00input"), ("name", "😀" * 101)])
def test_finance_and_text_reject_coercion_invalid_ranges_and_controls(field, value):
    rejects(raw(body(operations=[operation(changes={field: value})])))


def test_js_trim_contract_utf16_accounts_and_internal_space_identity():
    whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    assert js_trim(whitespace + " A  B " + whitespace) == "A  B"
    assert normalize_key("000001::" + whitespace + "A  B" + whitespace, "holding") == "000001::A  B"
    assert normalize_sync_key("watch", "000001::") == "000001::"
    assert normalize_key("000001::" + "😀" * 32, "holding").endswith("😀" * 32)
    assert normalize_key("000001::\u180eA\u180e", "holding") == "000001::\u180eA\u180e"
    for account in ("😀" * 33, "a" * 65, "A\x00", "\u0085A", "A\tB"):
        rejects(raw(body(operations=[operation(key="000001::" + account)])))
    # Spaces inside an account remain identity, rather than being collapsed.
    parsed = parse_sync_request(raw(body(operations=[operation(key="000001::A B"), operation(key="000001::A  B")])))
    assert len(parsed.operations) == 2


def test_manual_namespace_is_disjoint_and_values_remain_separate():
    manual = operation(key="asset:synthetic-cash", kind="manual_asset",
                       changes={"name": "合成现金", "cls": "现金", "value": 0, "note": None})
    request = parse_sync_request(raw(body(operations=[manual, operation(key="000001::")])))
    assert request.operations[0].changes["value"] == 0
    for patch in ({"key": "000001::"}, {"key": "asset: cash "}, {"changes": {"value": None}},
                  {"changes": {"value": True}}, {"changes": {"cls": "债券"}},
                  {"changes": {"shares": 0}}, {"changes": {"note": "x" * 2001}}):
        rejects(raw(body(operations=[{**manual, **patch}])))


def test_base_values_missing_null_and_lifecycle_metadata_are_explicit():
    request = parse_sync_request(raw(body(operations=[operation(
        changes={"cost": None}, base_values={"kind": "watch", "deleted": False, "name": None, "shares": None})])))
    assert request.operations[0].base_values == {"kind": "watch", "deleted": False, "name": None, "shares": None}
    assert "target_weight" not in request.operations[0].changes
    for base in ({"kind": None}, {"kind": "unknown"}, {"deleted": 0}, {"deleted": None}, {"cost": True}):
        rejects(raw(body(operations=[operation(base_values=base)])))
    manual = operation(key="asset:synthetic", kind="manual_asset", changes={},
                       base_values={"name": None, "cls": None, "value": None})
    assert parse_sync_request(raw(body(operations=[manual]))).operations[0].base_values["value"] is None


def test_normalize_record_creation_revival_and_unknown_patch_contract():
    full = {"name": "合成", "shares": 0, "cost": None, "target_weight": None}
    assert normalize_record("holding", full) == full
    assert normalize_record("holding", {**full, "shares": None}, require_complete=False)["shares"] is None
    assert normalize_record("watch", {"name": "合成"}) == {**full, "shares": None}
    assert normalize_record("manual_asset", {"name": "合成现金", "cls": "现金", "value": 0})["note"] is None
    for kind, values, complete in (("holding", {"name": "合成", "shares": 1}, True),
                                   ("holding", {**full, "shares": None}, True),
                                   ("holding", {"shares": None}, False),
                                   ("watch", {"name": "合成", "shares": 1}, True),
                                   ("manual_asset", {"name": "合成现金"}, False)):
        with pytest.raises(SyncValidationError) as caught:
            normalize_record(kind, values, require_complete=complete)
        assert caught.value.code == "invalid_sync_record"
        assert str(caught.value) == "Owner sync input rejected"


def test_direct_validation_financial_extremes_are_finite_and_safe():
    assert validate_values("holding", {"shares": MAX_SAFE_INTEGER, "cost": 1e308, "target_weight": 100})["cost"] == 1e308
    for value in (math.nan, math.inf, -math.inf, True, MAX_SAFE_INTEGER + 1):
        with pytest.raises(ValueError):
            validate_values("holding", {"cost": value})
