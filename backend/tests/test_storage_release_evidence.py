"""Synthetic signed fixtures only; never create release evidence or access a DB."""
from copy import deepcopy
from dataclasses import asdict, FrozenInstanceError, replace
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "storage_release_evidence_tool", ROOT / "tools" / "storage_release_evidence.py",
)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)

# This deliberately synthetic key is not configured on any service.
KEY = b"synthetic-attestation-test-key-only-32"
KEY_ID = "synthetic-generator-1"
NOW = datetime(2026, 9, 30, 1, 6, tzinfo=timezone.utc)
SHA = "a" * 40
SOURCE = "b" * 64
RESOURCE = "c" * 64
CHAIN = "d" * 64
RESTORE = "e" * 64


def fixture_payload(*, engine="libsql", authority="turso_cloud"):
    return {
        "contract_version": 1,
        "scope": "production_application_chain",
        "target_sha": SHA,
        "write_source_sha256": SOURCE,
        "engine": engine,
        "authority": authority,
        "resource_fingerprint": RESOURCE,
        "credential_configuration_revision": "synthetic-config-1",
        "database_schema_version": 8,
        "application_record_id": "synthetic-record-1",
        "write_sha256": CHAIN,
        "read_sha256": CHAIN,
        "write_boot": {
            "id": "synthetic-before-1", "started_at": "2026-09-30T01:00:00Z",
            "deployment_sha": SHA,
        },
        "read_boot": {
            "id": "synthetic-after-1", "started_at": "2026-09-30T01:02:00Z",
            "deployment_sha": SHA,
        },
        "written_at": "2026-09-30T01:01:00Z",
        "read_at": "2026-09-30T01:03:00Z",
        "recovery": {
            "scope": (
                "independent_provider_restore" if authority == "turso_cloud"
                else "independent_persistent_disk_restore"
            ),
            "restored_resource_fingerprint": RESTORE,
            "application_read_sha256": CHAIN,
            "schema_verified": True,
            "constraints_verified": True,
            "completed_at": "2026-09-30T01:04:00Z",
            "rpo_seconds": 0,
            "rto_seconds": 60.25,
        },
        "ci_run_id": 123456,
        "issued_at": "2026-09-30T01:05:00Z",
        "expires_at": "2026-10-01T01:01:00Z",
    }


def trusted_context(*, engine="libsql", authority="turso_cloud"):
    return module.ExpectedStorageContext(
        target_sha=SHA, write_source_sha256=SOURCE, engine=engine,
        authority=authority, resource_fingerprint=RESOURCE,
        credential_configuration_revision="synthetic-config-1",
        database_schema_version=8,
        current_read_boot=module.EvidenceBoot(
            id="synthetic-after-1", started_at="2026-09-30T01:02:00Z",
            deployment_sha=SHA,
        ),
        generator_ci_run_id=123456,
    )


def signed(payload=None, *, key=KEY, key_id=KEY_ID):
    """Test-local synthetic fixture signer, not production functionality."""
    payload = deepcopy(payload if payload is not None else fixture_payload())
    canonical = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return {
        "payload": payload,
        "attestation": {
            "algorithm": "HMAC-SHA256", "key_id": key_id,
            "signature": hmac.new(key, canonical, hashlib.sha256).hexdigest(),
        },
    }


def verify(document=None, **kwargs):
    document = signed() if document is None else document
    if type(document) is dict:
        document = json.dumps(document, allow_nan=False)
    return module.verify_storage_release_evidence(
        document, key=kwargs.pop("key", KEY),
        expected_key_id=kwargs.pop("expected_key_id", KEY_ID),
        expected=kwargs.pop("expected", trusted_context()),
        now=kwargs.pop("now", NOW), **kwargs,
    )


def put(obj, path, value):
    fields = path.split(".")
    for field in fields[:-1]:
        obj = obj[field]
    obj[fields[-1]] = value


def remove(obj, path):
    fields = path.split(".")
    for field in fields[:-1]:
        obj = obj[field]
    del obj[fields[-1]]


def rejected(document, code=None, **kwargs):
    with pytest.raises(module.EvidenceValidationError) as exc:
        verify(document, **kwargs)
    if code is not None:
        assert exc.value.code == code
    assert str(exc.value) == f"Storage evidence rejected: {exc.value.code}"
    return exc.value


@pytest.mark.parametrize("engine,authority", [
    ("libsql", "turso_cloud"), ("sqlite", "persistent_disk"),
])
def test_authenticated_metadata_never_grants_release_or_durability(engine, authority):
    result = verify(
        signed(fixture_payload(engine=engine, authority=authority)),
        expected=trusted_context(engine=engine, authority=authority),
    )
    assert result.scope == "production_application_chain"
    assert result.target_sha == SHA and result.generator_ci_run_id == 123456
    assert result.application_sha256 == CHAIN
    assert result.restored_resource_fingerprint == RESTORE
    assert result.issued_at == datetime(2026, 9, 30, 1, 5, tzinfo=timezone.utc)
    assert "durable" not in asdict(result)
    assert "storage_verified" not in asdict(result)
    assert "formal_release_verified" not in asdict(result)
    with pytest.raises(FrozenInstanceError):
        result.scope = "unreviewed"


def test_canonical_signature_ignores_envelope_format_and_json_member_order():
    document = signed()
    one = verify(json.dumps(document, indent=4).encode("utf-8"))
    document["payload"] = dict(reversed(list(document["payload"].items())))
    two = verify(json.dumps(document, separators=(",", ":")))
    assert one == two
    assert len(one.canonical_payload_sha256) == 64


def test_repeat_of_identical_current_receipt_is_idempotent_not_single_use():
    document = signed()
    assert verify(document) == verify(document)


def test_signature_and_application_digest_comparisons_use_constant_time(monkeypatch):
    calls = []
    original = module.hmac.compare_digest
    monkeypatch.setattr(module.hmac, "compare_digest", lambda a, b: (calls.append((a, b)), original(a, b))[1])
    verify(signed())
    assert len(calls) == 3
    assert all(type(a) is str and len(a) == len(b) == 64 for a, b in calls)


@pytest.mark.parametrize("key", [None, "x" * 32, bytearray(b"x" * 32), b"", b"x" * 31, b"x" * 4097])
def test_key_is_bytes_independently_configured_and_bounded(key):
    rejected(signed(), "invalid_verifier_configuration", key=key)


@pytest.mark.parametrize("key_id", [None, True, "", " /secret.invalid", "x" * 129, "synthetic\nkey"])
def test_expected_key_id_is_fixed_valid_identifier(key_id):
    rejected(signed(), "invalid_verifier_configuration", expected_key_id=key_id)


def test_wrong_fixed_key_id_rejects_even_an_authentic_signature():
    rejected(signed(key_id="synthetic-other-key"), "wrong_attestation_key")


@pytest.mark.parametrize("change", ["key", "payload", "signature"])
def test_signature_tampering_is_rejected(change):
    document = signed(key=b"different-synthetic-key-with-32-bytes" if change == "key" else KEY)
    if change == "payload":
        document["payload"]["application_record_id"] = "synthetic-tampered"
    elif change == "signature":
        document["attestation"]["signature"] = "f" * 64
    rejected(document, "invalid_signature")


@pytest.mark.parametrize("path", [
    "extra", "payload.extra", "attestation.extra", "payload.write_boot.extra",
    "payload.read_boot.extra", "payload.recovery.extra",
])
def test_unknown_fields_rejected_at_all_levels(path):
    document = signed()
    put(document, path, "secret-marker-do-not-echo")
    error = rejected(document, "invalid_shape")
    assert "secret-marker" not in str(error)


@pytest.mark.parametrize("path", [
    "payload", "attestation", "payload.contract_version", "payload.scope",
    "payload.target_sha", "payload.write_source_sha256", "payload.engine",
    "payload.authority", "payload.resource_fingerprint",
    "payload.credential_configuration_revision", "payload.database_schema_version",
    "payload.application_record_id", "payload.write_sha256", "payload.read_sha256",
    "payload.write_boot", "payload.read_boot", "payload.written_at",
    "payload.read_at", "payload.recovery", "payload.ci_run_id", "payload.issued_at",
    "payload.expires_at", "attestation.algorithm", "attestation.key_id",
    "attestation.signature", "payload.write_boot.id", "payload.write_boot.started_at",
    "payload.write_boot.deployment_sha", "payload.read_boot.id",
    "payload.read_boot.started_at", "payload.read_boot.deployment_sha",
    "payload.recovery.scope", "payload.recovery.restored_resource_fingerprint",
    "payload.recovery.application_read_sha256", "payload.recovery.schema_verified",
    "payload.recovery.constraints_verified", "payload.recovery.completed_at",
    "payload.recovery.rpo_seconds", "payload.recovery.rto_seconds",
])
def test_missing_fields_rejected_at_all_levels(path):
    document = signed()
    remove(document, path)
    rejected(document, "invalid_shape")


@pytest.mark.parametrize("path,value", [
    ("contract_version", True), ("contract_version", 1.0), ("contract_version", "1"),
    ("database_schema_version", True), ("database_schema_version", 8.0),
    ("database_schema_version", 7), ("ci_run_id", True), ("ci_run_id", 1.0),
    ("ci_run_id", 0), ("recovery.rpo_seconds", True),
    ("recovery.rto_seconds", False), ("recovery.rpo_seconds", -1),
    ("recovery.rto_seconds", "60"), ("recovery.schema_verified", 1),
    ("recovery.constraints_verified", "true"), ("recovery.constraints_verified", False),
    ("target_sha", "A" * 40), ("target_sha", SHA + "\n"),
    ("write_source_sha256", "g" * 64), ("read_sha256", "D" * 64),
    ("write_boot.id", ""), ("application_record_id", "x" * 129),
    ("application_record_id", "https://private.invalid"),
    ("scope", []), ("engine", []), ("authority", []), ("recovery.scope", []),
])
def test_strict_field_types_ranges_and_ascii_patterns(path, value):
    payload = fixture_payload()
    put(payload, path, value)
    rejected(signed(payload))


@pytest.mark.parametrize("path,value", [
    ("target_sha", "f" * 40), ("write_source_sha256", "f" * 64),
    ("resource_fingerprint", "f" * 64),
    ("credential_configuration_revision", "synthetic-config-2"),
    ("database_schema_version", 9),
])
def test_signed_receipt_bound_to_current_deployment_context(path, value):
    payload = fixture_payload()
    put(payload, path, value)
    rejected(signed(payload), "deployment_context_mismatch")


def test_signed_other_authority_does_not_match_current_turso_context():
    rejected(signed(fixture_payload(engine="sqlite", authority="persistent_disk")), "deployment_context_mismatch")


@pytest.mark.parametrize("engine,authority", [
    ("sqlite", "turso_cloud"), ("libsql", "persistent_disk"),
    ("postgresql", "persistent_disk"), ("sqlite", "ephemeral"),
])
def test_engine_authority_pair_must_be_meaningful(engine, authority):
    payload = fixture_payload(engine=engine, authority=authority)
    rejected(signed(payload), "invalid_storage_authority")


@pytest.mark.parametrize("scope", [
    "local_application_repository_chain", "sqlite_probe", "provider_probe",
    "production_health_contract", "production_application_chain ",
])
def test_authenticated_wrong_scope_or_local_receipt_cannot_be_promoted(scope):
    payload = fixture_payload()
    payload["scope"] = scope
    rejected(signed(payload), "invalid_evidence_scope")


def test_actual_local_unsigned_receipt_shape_cannot_be_promoted():
    rejected({
        "evidence_scope": "local_application_repository_chain",
        "formal_release_verified": False, "durable": False,
        "synthetic_only": True, "verified": True,
    }, "invalid_shape")


def test_unprotected_verified_flag_is_not_a_substitute_for_attestation():
    document = signed()
    document["attestation"] = {"verified": True}
    rejected(document, "invalid_shape")


@pytest.mark.parametrize("path,value", [
    ("read_boot.id", "synthetic-other-boot"),
    ("read_boot.started_at", "2026-09-30T01:02:00.000001Z"),
    ("read_boot.deployment_sha", "f" * 40),
    ("write_boot.deployment_sha", "f" * 40),
    ("write_boot.id", "synthetic-after-1"),
])
def test_boot_identity_is_exact_and_read_requires_a_distinct_restart(path, value):
    payload = fixture_payload()
    put(payload, path, value)
    rejected(signed(payload), "boot_context_mismatch")


def test_old_generator_run_replay_rejected_without_using_verifier_run_id():
    document = signed()
    rejected(document, "generator_run_mismatch", expected=replace(trusted_context(), generator_ci_run_id=123457))
    payload = fixture_payload()
    payload["ci_run_id"] = 123457
    rejected(signed(payload), "generator_run_mismatch")


def test_old_boot_replay_rejected_on_new_instance_same_code_and_database():
    expected = replace(trusted_context(), current_read_boot=module.EvidenceBoot(
        id="synthetic-after-2", started_at="2026-09-30T01:05:30Z", deployment_sha=SHA,
    ))
    rejected(signed(), "boot_context_mismatch", expected=expected)


def test_old_credential_revision_replay_rejected():
    rejected(signed(), "deployment_context_mismatch", expected=replace(
        trusted_context(), credential_configuration_revision="synthetic-config-2",
    ))


@pytest.mark.parametrize("field", ["read_sha256", "recovery.application_read_sha256"])
def test_all_application_read_digests_match_original_write(field):
    payload = fixture_payload()
    put(payload, field, "f" * 64)
    rejected(signed(payload), "application_digest_mismatch")


def test_restore_must_be_distinct_resource_not_original_database():
    payload = fixture_payload()
    payload["recovery"]["restored_resource_fingerprint"] = RESOURCE
    rejected(signed(payload), "restore_not_independent")


def test_restore_scope_must_match_storage_authority():
    payload = fixture_payload()
    payload["recovery"]["scope"] = "independent_persistent_disk_restore"
    rejected(signed(payload), "recovery_authority_mismatch")


@pytest.mark.parametrize("timestamp", [
    "2026-09-30 01:03:00Z", "2026-09-30T01:03:00", "2026-09-30T09:03:00+08:00",
    "2026-09-30T01:03:00z", "2026-09-30T01:03:00Z\n", "2026-09-30T01:03:60Z",
    "2026-02-30T01:03:00Z", "2026-09-30T01:03:00.1234567Z",
    "２０２６-09-30T01:03:00Z", 123, True, None,
])
def test_timestamps_are_bounded_utc_rfc3339_not_local_or_ambiguous(timestamp):
    payload = fixture_payload()
    payload["read_at"] = timestamp
    rejected(signed(payload), "invalid_timestamp")


def test_zero_offset_accepted_but_current_boot_timestamp_has_exact_binding():
    payload = fixture_payload()
    payload["read_boot"]["started_at"] = "2026-09-30T01:02:00+00:00"
    rejected(signed(payload), "boot_context_mismatch")
    expected = replace(trusted_context(), current_read_boot=module.EvidenceBoot(
        id="synthetic-after-1", started_at="2026-09-30T01:02:00+00:00", deployment_sha=SHA,
    ))
    assert verify(signed(payload), expected=expected).read_boot_id == "synthetic-after-1"


@pytest.mark.parametrize("path,value", [
    ("write_boot.started_at", "2026-09-30T01:01:01Z"),
    ("written_at", "2026-09-30T01:02:00Z"),
    ("written_at", "2026-09-30T01:02:01Z"),
    ("read_at", "2026-09-30T01:01:59Z"),
    ("recovery.completed_at", "2026-09-30T01:02:59Z"),
    ("issued_at", "2026-09-30T01:03:59Z"),
])
def test_operation_time_sequence_proves_write_then_restart_read_restore_issue(path, value):
    payload = fixture_payload()
    put(payload, path, value)
    rejected(signed(payload), "invalid_time_order")


def test_time_equality_allowed_except_write_must_precede_read_boot():
    payload = fixture_payload()
    payload["write_boot"]["started_at"] = payload["written_at"]
    payload["read_at"] = payload["recovery"]["completed_at"] = payload["issued_at"] = payload["read_boot"]["started_at"]
    verify(signed(payload), now=datetime(2026, 9, 30, 1, 2, tzinfo=timezone.utc))


def test_future_issue_rejected_even_one_microsecond_and_grace_is_explicit_zero():
    assert module.MAX_FUTURE_SKEW_SECONDS == 0
    payload = fixture_payload()
    payload["issued_at"] = "2026-09-30T01:06:00.000001Z"
    rejected(signed(payload), "future_evidence")


@pytest.mark.parametrize("now", [
    datetime(2026, 10, 1, 1, 1, tzinfo=timezone.utc),
    datetime(2026, 10, 2, 1, 1, tzinfo=timezone.utc),
])
def test_expired_receipt_replay_rejected_at_exact_expiry_and_after(now):
    rejected(signed(), "expired_evidence", now=now)


def test_seven_day_lifetime_boundary_is_from_write_not_just_fresh_signature():
    payload = fixture_payload()
    payload["expires_at"] = "2026-10-07T01:01:00Z"
    verify(signed(payload))
    payload["expires_at"] = "2026-10-07T01:01:00.000001Z"
    rejected(signed(payload), "excessive_evidence_lifetime")


def test_issuer_cannot_renew_old_write_merely_by_issuing_new_signature():
    payload = fixture_payload()
    for path in ("write_boot.started_at", "read_boot.started_at", "written_at", "read_at", "recovery.completed_at"):
        fields = path.split(".")
        target = payload
        for field in fields[:-1]:
            target = target[field]
        target[fields[-1]] = target[fields[-1]].replace("2026-09-30", "2026-09-20")
    expected = replace(trusted_context(), current_read_boot=module.EvidenceBoot(
        id="synthetic-after-1", started_at="2026-09-20T01:02:00Z", deployment_sha=SHA,
    ))
    rejected(signed(payload), "excessive_evidence_lifetime", expected=expected)


@pytest.mark.parametrize("text", ["NaN", "Infinity", "-Infinity", "1e9999", "-1e9999", "9223372036854775808", "9" * 4301], ids=[
    "nan", "infinity", "negative-infinity", "overflow", "negative-overflow", "int64-overflow", "huge-integer",
])
def test_non_finite_and_unbounded_numeric_literals_rejected(text):
    document = json.dumps(signed()).replace('"rpo_seconds": 0', f'"rpo_seconds": {text}')
    rejected(document, "invalid_json_number")


@pytest.mark.parametrize("duplicate", [
    '"contract_version": 1, "contract_version": 1',
    '"schema_verified": true, "schema_verified": true',
    '"algorithm": "HMAC-SHA256", "algorithm": "HMAC-SHA256"',
    '"id": "synthetic-before-1", "id": "synthetic-before-1"',
])
def test_duplicate_json_keys_rejected_even_same_value_nested(duplicate):
    original = duplicate.split(", ", 1)[0]
    document = json.dumps(signed()).replace(original, duplicate)
    rejected(document, "duplicate_json_field")


def test_duplicate_root_envelope_field_rejected():
    document = json.dumps(signed())
    rejected(document[:-1] + ', "payload": {}}', "duplicate_json_field")


@pytest.mark.parametrize("document", [None, {}, [], 1, True, bytearray(b"{}"), memoryview(b"{}")])
def test_only_json_text_or_utf8_bytes_accepted(document):
    with pytest.raises(module.EvidenceValidationError) as exc:
        module.verify_storage_release_evidence(
            document, key=KEY, expected_key_id=KEY_ID, expected=trusted_context(), now=NOW,
        )
    assert exc.value.code == "invalid_json_input"


@pytest.mark.parametrize("document", [
    "", "null", "[]", "true", "{}", '{"payload": {}, "attestation": {}} trailing',
    '{"secret-marker-do-not-echo":', b"\xff", "\ud800", '\ufeff{}',
])
def test_malformed_non_object_or_encoding_errors_never_echo_input(document):
    error = rejected(document)
    assert "secret-marker" not in str(error)
    assert "payload" not in str(error)
    assert KEY.decode("ascii") not in str(error)


@pytest.mark.parametrize("document", [
    b" " * (module.MAX_EVIDENCE_BYTES + 1),
    " " * (module.MAX_EVIDENCE_BYTES + 1),
    "汉" * (module.MAX_EVIDENCE_BYTES // 2),
], ids=["oversized-bytes", "oversized-string", "oversized-utf8"])
def test_json_byte_size_bounded_including_multibyte_input(document):
    rejected(document, "evidence_size_exceeded")


def test_exact_byte_size_limit_is_allowed_not_one_byte_more():
    text = json.dumps(signed())
    padded = text + " " * (module.MAX_EVIDENCE_BYTES - len(text))
    verify(padded.encode("utf-8"))
    rejected(padded + " ", "evidence_size_exceeded")


def test_depth_prechecked_before_parser_recursion_and_quoted_braces_not_counted():
    rejected("[" * (module.MAX_JSON_DEPTH + 1) + "0" + "]" * (module.MAX_JSON_DEPTH + 1), "json_depth_exceeded")
    rejected("[" * 1200 + "0" + "]" * 1200, "json_depth_exceeded")
    error = rejected(json.dumps({"payload": '[' * 100 + '\\"' + ']' * 100, "attestation": {}}))
    assert error.code == "invalid_shape"


@pytest.mark.parametrize("now", [
    None, "2026-09-30T01:06:00Z", datetime(2026, 9, 30, 1, 6),
    datetime(2026, 9, 30, 9, 6, tzinfo=timezone(timedelta(hours=8))),
])
def test_now_is_explicit_trusted_aware_utc(now):
    rejected(signed(), "invalid_verifier_configuration", now=now)


@pytest.mark.parametrize("field,value", [
    ("target_sha", "A" * 40), ("write_source_sha256", None), ("engine", []),
    ("authority", "ephemeral"), ("resource_fingerprint", "f" * 63),
    ("credential_configuration_revision", "bad/identifier"),
    ("database_schema_version", True), ("database_schema_version", 7),
    ("generator_ci_run_id", True), ("generator_ci_run_id", 0),
    ("current_read_boot", {}),
])
def test_trusted_context_is_strict_not_bool_coercing_or_unknown_engine(field, value):
    rejected(signed(), "invalid_verifier_configuration", expected=replace(trusted_context(), **{field: value}))


@pytest.mark.parametrize("boot", [
    module.EvidenceBoot(id="", started_at="2026-09-30T01:02:00Z", deployment_sha=SHA),
    module.EvidenceBoot(id="synthetic-after-1", started_at="2026-09-30T01:02:00", deployment_sha=SHA),
    module.EvidenceBoot(id="synthetic-after-1", started_at="2026-09-30T01:02:00Z", deployment_sha="f" * 40),
])
def test_trusted_current_boot_must_be_full_current_target_identity(boot):
    rejected(signed(), "invalid_verifier_configuration", expected=replace(trusted_context(), current_read_boot=boot))


def test_untrusted_dict_is_not_accepted_as_context():
    rejected(signed(), "invalid_verifier_configuration", expected=asdict(trusted_context()))


def test_verifier_required_shapes_remain_aligned_with_frozen_contract():
    contract = json.loads((ROOT / "contracts" / "storage-release-evidence-v1.json").read_text(encoding="utf-8"))
    payload = contract["properties"]["payload"]
    assert module._ENVELOPE_KEYS == set(contract["required"])
    assert module._PAYLOAD_KEYS == set(payload["required"])
    assert module._BOOT_KEYS == set(contract["$defs"]["boot"]["required"])
    assert module._RECOVERY_KEYS == set(payload["properties"]["recovery"]["required"])
    assert module._ATTESTATION_KEYS == set(contract["properties"]["attestation"]["required"])
    assert contract["additionalProperties"] is False
    assert payload["additionalProperties"] is False
