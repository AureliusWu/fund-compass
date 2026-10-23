"""Offline raw request contract; contains only synthetic opaque references."""
import hashlib
import json

import pytest
from pydantic import ValidationError

from models.owner_analysis import (
    MAX_BODY_BYTES, MAX_EVIDENCE, AnalysisValidationError, OwnerAnalysisRequest,
    parse_owner_analysis_request,
)


def body(**patch):
    return {
        "request_id": "analysis-synthetic-001", "expected_revision": 1,
        "policy_version": "pol_" + "a" * 64,
        "evidence": [{"code": "510300", "evidence_id": "ev_" + "b" * 64}],
        **patch,
    }


def raw(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def rejects(value):
    with pytest.raises(AnalysisValidationError) as caught:
        parse_owner_analysis_request(value)
    assert caught.value.code == "invalid_analysis_request"
    assert str(caught.value) == "Owner analysis input rejected"


def test_closed_frozen_request_has_original_canonical_hash():
    request = parse_owner_analysis_request(raw(body()).encode())
    assert request.request_id == "analysis-synthetic-001"
    assert request.expected_revision == 1
    assert request.evidence[0].code == "510300"
    assert request.evidence[0].evidence_id == "ev_" + "b" * 64
    assert type(request.evidence) is tuple
    canonical = request.canonical_body()
    assert json.loads(canonical) == body()
    assert request.request_hash() == hashlib.sha256(canonical.encode()).hexdigest()
    with pytest.raises(ValidationError):
        request.expected_revision = 2
    with pytest.raises(ValidationError):
        request.evidence[0].code = "000001"


def test_key_order_whitespace_do_not_change_hash_but_array_order_does():
    source = body(evidence=[
        {"code": "510300", "evidence_id": "ev_" + "b" * 64},
        {"code": "000001", "evidence_id": "ev_" + "c" * 64},
    ])
    reordered = dict(reversed(list(source.items())))
    reordered["evidence"] = [dict(reversed(list(item.items()))) for item in source["evidence"]]
    original = parse_owner_analysis_request(raw(source))
    assert original.request_hash() == parse_owner_analysis_request(json.dumps(reordered, indent=2)).request_hash()
    reordered["evidence"].reverse()
    assert original.request_hash() != parse_owner_analysis_request(raw(reordered)).request_hash()


def test_original_revision_number_token_is_retained_and_direct_model_cannot_mint_provenance():
    positive_zero = parse_owner_analysis_request(raw(body(expected_revision=0)))
    negative_zero = parse_owner_analysis_request(raw(body(expected_revision=0)).replace('"expected_revision":0', '"expected_revision":-0'))
    assert positive_zero.expected_revision == negative_zero.expected_revision == 0
    assert positive_zero.request_hash() != negative_zero.request_hash()
    direct = OwnerAnalysisRequest.model_validate(body())
    with pytest.raises(AnalysisValidationError):
        direct.canonical_body()
    with pytest.raises(AnalysisValidationError):
        direct.request_hash()


@pytest.mark.parametrize("value", [None, {}, bytearray(b"{}"), b"\xff", "", "[]", "null", "1", "{} trailing"])
def test_raw_utf8_object_required(value):
    rejects(value)


@pytest.mark.parametrize("value", [
    raw(body()) + "\ufeff", "\ufeff" + raw(body()),
    b"\xef\xbb\xbf" + raw(body()).encode(),
    raw(body()).replace('"expected_revision":1', '"expected_revision":1,"expected_revision":2'),
    raw(body()).replace('"expected_revision":1', '"expected_revision":1,"expected_revisi\\u006fn":2'),
    raw(body()).replace('"code":"510300"', '"code":"510300","code":"000001"'),
    raw(body()).replace('"expected_revision":1', '"expected_revision":NaN'),
    raw(body()).replace('"expected_revision":1', '"expected_revision":Infinity'),
    raw(body()).replace('"expected_revision":1', '"expected_revision":1e400'),
    raw(body()).replace('"code":"510300"', '"code":"\\ud800"'),
])
def test_bom_duplicates_unsafe_json_and_surrogates_are_rejected(value):
    rejects(value)


@pytest.mark.parametrize("revision", [-1, 2**53, True, False, 1.0, "1", None])
def test_revision_is_a_safe_native_integer(revision):
    rejects(raw(body(expected_revision=revision)))


@pytest.mark.parametrize("change", [
    {"request_id": "short"}, {"request_id": "private account name"},
    {"policy_version": "pol_" + "A" * 64}, {"policy_version": "a" * 64},
    {"policy_version": "pol_" + "a" * 65},
    {"policy_version": "pol_" + "a" * 64 + "\n"},
    {"holdings": []}, {"prices": {"510300": 1}}, {"target_weight": 50},
    {"evidence": []}, {"evidence": None}, {"evidence": {}},
    {"evidence": [{"code": "５１０３００", "evidence_id": "ev_" + "b" * 64}]},
    {"evidence": [{"code": "510300", "evidence_id": "ev_" + "B" * 64}]},
    {"evidence": [{"code": "510300\n", "evidence_id": "ev_" + "b" * 64}]},
    {"evidence": [{"code": "510300", "evidence_id": "ev_" + "b" * 64 + "\n"}]},
    {"evidence": [{"code": "510300", "evidence_id": "ev_" + "b" * 64, "price": 1}]},
    {"evidence": [{"code": "510300", "evidence_id": "ev_" + "b" * 64}] * 2},
])
def test_closed_request_rejects_untrusted_inputs_and_duplicate_funds(change):
    rejects(raw(body(**change)))


def test_exact_body_and_evidence_bounds_are_enforced():
    source = raw(body(expected_revision=2**53 - 1))
    padded = source + " " * (MAX_BODY_BYTES - len(source.encode()))
    assert parse_owner_analysis_request(padded).expected_revision == 2**53 - 1
    rejects(padded + " ")
    items = [{"code": f"{code:06}", "evidence_id": "ev_" + "b" * 64} for code in range(MAX_EVIDENCE)]
    assert len(parse_owner_analysis_request(raw(body(evidence=items))).evidence) == 100
    rejects(raw(body(evidence=items + [{"code": "999999", "evidence_id": "ev_" + "c" * 64}])))


def test_missing_fields_and_nested_depth_cannot_hide_in_unknown_fields():
    for field in body():
        incomplete = body()
        del incomplete[field]
        rejects(raw(incomplete))
    rejects(raw(body(extra=[[[[[[[[[None]]]]]]]]])))
