"""Strict, standard-library-only verification of formal storage attestations.

This module neither writes a database nor creates/signs evidence. Authentication
of a protected generator's payload is *not* proof that its claimed operations
actually happened, and the returned metadata never grants a release or changes
the application's storage contract. A separately reviewed protected executor and
the existing fail-closed release gate remain necessary.

Contract-v1 canonical JSON is UTF-8 JSON of the payload, sorted by key, without
whitespace, with ensure_ascii=False and allow_nan=False (Python json semantics).
The verifier key must come from an independent dedicated configuration, not an
Admin, Worker, Owner, database, or provider credential. Its independence cannot
be inferred from arbitrary bytes and must be enforced by the caller's workflow.
There is deliberately no signing function, environment fallback, or CLI here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import math
import re
from typing import Any


MAX_EVIDENCE_BYTES = 32 * 1024
MAX_JSON_DEPTH = 8
MIN_KEY_BYTES = 32
MAX_KEY_BYTES = 4096
MAX_EVIDENCE_LIFETIME = timedelta(days=7)
# No implicit future-clock grace: the attested issuance must already have occurred.
MAX_FUTURE_SKEW_SECONDS = 0
_MAX_INTEGER = 2**63 - 1
_DIGEST = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_SHA = re.compile(r"[0-9a-f]{40}\Z", re.ASCII)
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z", re.ASCII)
_UTC_TIMESTAMP = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)\Z",
    re.ASCII,
)
_PAIR_TO_RECOVERY_SCOPE = {
    ("sqlite", "persistent_disk"): "independent_persistent_disk_restore",
    ("libsql", "turso_cloud"): "independent_provider_restore",
}
_ENVELOPE_KEYS = frozenset({"payload", "attestation"})
_PAYLOAD_KEYS = frozenset({
    "contract_version", "scope", "target_sha", "write_source_sha256", "engine",
    "authority", "resource_fingerprint", "credential_configuration_revision",
    "database_schema_version", "application_record_id", "write_sha256",
    "read_sha256", "write_boot", "read_boot", "written_at", "read_at",
    "recovery", "ci_run_id", "issued_at", "expires_at",
})
_BOOT_KEYS = frozenset({"id", "started_at", "deployment_sha"})
_RECOVERY_KEYS = frozenset({
    "scope", "restored_resource_fingerprint", "application_read_sha256",
    "schema_verified", "constraints_verified", "completed_at", "rpo_seconds",
    "rto_seconds",
})
_ATTESTATION_KEYS = frozenset({"algorithm", "key_id", "signature"})


class EvidenceValidationError(ValueError):
    """A fixed, non-sensitive failure code; no input or credentials are echoed."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"Storage evidence rejected: {code}")


@dataclass(frozen=True, slots=True)
class EvidenceBoot:
    id: str
    started_at: str
    deployment_sha: str


@dataclass(frozen=True, slots=True)
class ExpectedStorageContext:
    """Trusted out-of-band context, never populated from the evidence itself.

    generator_ci_run_id identifies the protected *generator* run, not the later
    verifier's GITHUB_RUN_ID. current_read_boot must be independently observed on
    the current application instance. Timestamp strings bind byte-for-byte.
    """

    target_sha: str
    write_source_sha256: str
    engine: str
    authority: str
    resource_fingerprint: str
    credential_configuration_revision: str
    database_schema_version: int
    current_read_boot: EvidenceBoot
    generator_ci_run_id: int


@dataclass(frozen=True, slots=True)
class VerifiedStorageEvidence:
    """Authenticated, context-bound metadata only; not a release authorization."""

    contract_version: int
    scope: str
    target_sha: str
    resource_fingerprint: str
    application_record_id: str
    generator_ci_run_id: int
    write_boot_id: str
    read_boot_id: str
    restored_resource_fingerprint: str
    application_sha256: str
    canonical_payload_sha256: str
    issued_at: datetime
    expires_at: datetime


def _reject(code: str) -> None:
    # Suppress chained decoder exceptions, which may expose input fragments.
    raise EvidenceValidationError(code) from None


def _matches(value: object, pattern: re.Pattern[str]) -> bool:
    return type(value) is str and pattern.fullmatch(value) is not None


def _integer(value: object, *, minimum: int) -> bool:
    return type(value) is int and minimum <= value <= _MAX_INTEGER


def _duration_number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _exact_object(value: object, fields: frozenset[str]) -> dict[str, Any]:
    if type(value) is not dict or value.keys() != fields:
        _reject("invalid_shape")
    return value


def _timestamp(value: object, *, error_code: str = "invalid_timestamp") -> datetime:
    if not _matches(value, _UTC_TIMESTAMP):
        _reject(error_code)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        _reject(error_code)
    # A zero-offset aware timestamp is mandatory; no local-time interpretation.
    if parsed.utcoffset() != timedelta(0):
        _reject(error_code)
    return parsed.astimezone(timezone.utc)


def _check_configuration(
    key: object, expected_key_id: object, expected: object, now: object,
) -> None:
    if type(key) is not bytes or not MIN_KEY_BYTES <= len(key) <= MAX_KEY_BYTES:
        _reject("invalid_verifier_configuration")
    if not _matches(expected_key_id, _IDENTIFIER):
        _reject("invalid_verifier_configuration")
    if type(expected) is not ExpectedStorageContext:
        _reject("invalid_verifier_configuration")
    if (
        not _matches(expected.target_sha, _SHA)
        or not _matches(expected.write_source_sha256, _DIGEST)
        or type(expected.engine) is not str
        or type(expected.authority) is not str
        or (expected.engine, expected.authority) not in _PAIR_TO_RECOVERY_SCOPE
        or not _matches(expected.resource_fingerprint, _DIGEST)
        or not _matches(expected.credential_configuration_revision, _IDENTIFIER)
        or not _integer(expected.database_schema_version, minimum=8)
        or not _integer(expected.generator_ci_run_id, minimum=1)
        or type(expected.current_read_boot) is not EvidenceBoot
        or not _matches(expected.current_read_boot.id, _IDENTIFIER)
        or expected.current_read_boot.deployment_sha != expected.target_sha
    ):
        _reject("invalid_verifier_configuration")
    _timestamp(
        expected.current_read_boot.started_at,
        error_code="invalid_verifier_configuration",
    )
    if type(now) is not datetime or now.tzinfo is None:
        _reject("invalid_verifier_configuration")
    try:
        if now.utcoffset() != timedelta(0):
            _reject("invalid_verifier_configuration")
    except (TypeError, ValueError, OverflowError):
        _reject("invalid_verifier_configuration")


def _scan_depth(text: str) -> None:
    """Bound nesting before json.loads, accounting for quoted/escaped braces."""
    depth = 0
    quoted = False
    escaped = False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                _reject("json_depth_exceeded")
        elif char in "}]":
            depth -= 1
            if depth < 0:
                _reject("invalid_json")


def _reject_constant(_constant: str) -> None:
    _reject("invalid_json_number")


def _bounded_int(text: str) -> int:
    # Bounds avoid huge Python integer parsing as well as bool-as-int ambiguity.
    digits = text.removeprefix("-")
    if len(digits) > 19:
        _reject("invalid_json_number")
    value = int(text)
    if not -_MAX_INTEGER <= value <= _MAX_INTEGER:
        _reject("invalid_json_number")
    return value


def _finite_float(text: str) -> float:
    if len(text) > 128:
        _reject("invalid_json_number")
    value = float(text)
    if not math.isfinite(value):
        _reject("invalid_json_number")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for field, value in pairs:
        if field in result:
            _reject("duplicate_json_field")
        result[field] = value
    return result


def _decode(evidence: object) -> dict[str, Any]:
    if type(evidence) is bytes:
        if len(evidence) > MAX_EVIDENCE_BYTES:
            _reject("evidence_size_exceeded")
        try:
            text = evidence.decode("utf-8", errors="strict")
        except UnicodeError:
            _reject("invalid_json_encoding")
    elif type(evidence) is str:
        if len(evidence) > MAX_EVIDENCE_BYTES:
            _reject("evidence_size_exceeded")
        try:
            if len(evidence.encode("utf-8", errors="strict")) > MAX_EVIDENCE_BYTES:
                _reject("evidence_size_exceeded")
        except UnicodeError:
            _reject("invalid_json_encoding")
        text = evidence
    else:
        _reject("invalid_json_input")
    _scan_depth(text)
    try:
        value = json.loads(
            text, object_pairs_hook=_unique_object, parse_constant=_reject_constant,
            parse_int=_bounded_int, parse_float=_finite_float,
        )
    except (ValueError, TypeError, RecursionError, OverflowError) as exc:
        if isinstance(exc, EvidenceValidationError):
            raise
        _reject("invalid_json")
    return _exact_object(value, _ENVELOPE_KEYS)


def _validate_shape(envelope: dict[str, Any]) -> dict[str, Any]:
    payload = _exact_object(envelope["payload"], _PAYLOAD_KEYS)
    attestation = _exact_object(envelope["attestation"], _ATTESTATION_KEYS)
    write_boot = _exact_object(payload["write_boot"], _BOOT_KEYS)
    read_boot = _exact_object(payload["read_boot"], _BOOT_KEYS)
    recovery = _exact_object(payload["recovery"], _RECOVERY_KEYS)

    if type(payload["contract_version"]) is not int or payload["contract_version"] != 1:
        _reject("invalid_contract")
    if type(payload["scope"]) is not str or payload["scope"] != "production_application_chain":
        _reject("invalid_evidence_scope")
    if not _matches(payload["target_sha"], _SHA):
        _reject("invalid_field_type")
    for field in (
        "write_source_sha256", "resource_fingerprint", "write_sha256", "read_sha256",
    ):
        if not _matches(payload[field], _DIGEST):
            _reject("invalid_field_type")
    for field in ("credential_configuration_revision", "application_record_id"):
        if not _matches(payload[field], _IDENTIFIER):
            _reject("invalid_field_type")
    if (
        type(payload["engine"]) is not str
        or type(payload["authority"]) is not str
        or (payload["engine"], payload["authority"]) not in _PAIR_TO_RECOVERY_SCOPE
    ):
        _reject("invalid_storage_authority")
    if (
        not _integer(payload["database_schema_version"], minimum=8)
        or not _integer(payload["ci_run_id"], minimum=1)
    ):
        _reject("invalid_field_type")
    for boot in (write_boot, read_boot):
        if not _matches(boot["id"], _IDENTIFIER) or not _matches(boot["deployment_sha"], _SHA):
            _reject("invalid_field_type")
        _timestamp(boot["started_at"])
    for field in ("written_at", "read_at", "issued_at", "expires_at"):
        _timestamp(payload[field])
    if type(recovery["scope"]) is not str or recovery["scope"] not in _PAIR_TO_RECOVERY_SCOPE.values():
        _reject("invalid_recovery_scope")
    if (
        not _matches(recovery["restored_resource_fingerprint"], _DIGEST)
        or not _matches(recovery["application_read_sha256"], _DIGEST)
        or recovery["schema_verified"] is not True
        or recovery["constraints_verified"] is not True
        or not _duration_number(recovery["rpo_seconds"])
        or not _duration_number(recovery["rto_seconds"])
    ):
        _reject("invalid_recovery")
    _timestamp(recovery["completed_at"])
    if (
        type(attestation["algorithm"]) is not str
        or attestation["algorithm"] != "HMAC-SHA256"
        or not _matches(attestation["key_id"], _IDENTIFIER)
        or not _matches(attestation["signature"], _DIGEST)
    ):
        _reject("invalid_attestation")
    return payload


def verify_storage_release_evidence(
    evidence: bytes | str, *, key: bytes, expected_key_id: str,
    expected: ExpectedStorageContext, now: datetime,
) -> VerifiedStorageEvidence:
    """Authenticate and bind bounded evidence to independently trusted state.

    There is zero future-issuance grace and a maximum seven-day lifespan measured
    from both issuance and the actual application write. A new boot, resource,
    code/schema, credential revision, generator run, expiry, or signature mismatch
    rejects old receipts. Rechecking the same still-current receipt is idempotent;
    this read-only verifier does not maintain an external single-use replay store.

    The caller must pass a dedicated independently provisioned key and current
    metadata observed outside this receipt. Copying fields from the untrusted
    receipt into ``expected`` would defeat binding and is expressly unsupported.
    """
    _check_configuration(key, expected_key_id, expected, now)
    envelope = _decode(evidence)
    payload = _validate_shape(envelope)
    attestation = envelope["attestation"]
    if attestation["key_id"] != expected_key_id:
        _reject("wrong_attestation_key")
    canonical = json.dumps(
        payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    signature = hmac.new(key, canonical, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, attestation["signature"]):
        _reject("invalid_signature")

    for field in (
        "target_sha", "write_source_sha256", "engine", "authority",
        "resource_fingerprint", "credential_configuration_revision",
        "database_schema_version",
    ):
        if payload[field] != getattr(expected, field):
            _reject("deployment_context_mismatch")
    if payload["ci_run_id"] != expected.generator_ci_run_id:
        _reject("generator_run_mismatch")
    write_boot, read_boot = payload["write_boot"], payload["read_boot"]
    if (
        read_boot["id"] != expected.current_read_boot.id
        or read_boot["started_at"] != expected.current_read_boot.started_at
        or read_boot["deployment_sha"] != expected.current_read_boot.deployment_sha
        or write_boot["deployment_sha"] != expected.target_sha
        or write_boot["id"] == read_boot["id"]
    ):
        _reject("boot_context_mismatch")
    recovery = payload["recovery"]
    if recovery["scope"] != _PAIR_TO_RECOVERY_SCOPE[(payload["engine"], payload["authority"])]:
        _reject("recovery_authority_mismatch")
    if recovery["restored_resource_fingerprint"] == payload["resource_fingerprint"]:
        _reject("restore_not_independent")
    if (
        not hmac.compare_digest(payload["write_sha256"], payload["read_sha256"])
        or not hmac.compare_digest(payload["write_sha256"], recovery["application_read_sha256"])
    ):
        _reject("application_digest_mismatch")

    write_started = _timestamp(write_boot["started_at"])
    written = _timestamp(payload["written_at"])
    read_started = _timestamp(read_boot["started_at"])
    read = _timestamp(payload["read_at"])
    recovered = _timestamp(recovery["completed_at"])
    issued = _timestamp(payload["issued_at"])
    expires = _timestamp(payload["expires_at"])
    if issued > now:
        _reject("future_evidence")
    if now >= expires:
        _reject("expired_evidence")
    if not write_started <= written < read_started <= read <= recovered <= issued:
        _reject("invalid_time_order")
    if (
        not timedelta(0) < expires - issued <= MAX_EVIDENCE_LIFETIME
        or not timedelta(0) < expires - written <= MAX_EVIDENCE_LIFETIME
    ):
        _reject("excessive_evidence_lifetime")

    return VerifiedStorageEvidence(
        contract_version=1, scope=payload["scope"], target_sha=payload["target_sha"],
        resource_fingerprint=payload["resource_fingerprint"],
        application_record_id=payload["application_record_id"],
        generator_ci_run_id=payload["ci_run_id"], write_boot_id=write_boot["id"],
        read_boot_id=read_boot["id"],
        restored_resource_fingerprint=recovery["restored_resource_fingerprint"],
        application_sha256=payload["write_sha256"],
        canonical_payload_sha256=hashlib.sha256(canonical).hexdigest(),
        issued_at=issued, expires_at=expires,
    )
