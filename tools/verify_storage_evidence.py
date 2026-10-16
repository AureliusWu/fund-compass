"""Read-only signature/context preflight, NOT a formal release orchestrator.

The context must come from a protected executor's current deployment metadata,
not from the evidence being checked. This tool cannot prove that an executor
performed a production write/restart/restore, and cannot grant a release.
No key flag, signing command, network request, or database write is provided.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys

if __package__:
    from .storage_release_evidence import (
        EvidenceBoot, EvidenceValidationError, ExpectedStorageContext,
        MAX_EVIDENCE_BYTES, verify_storage_release_evidence,
    )
else:
    from storage_release_evidence import (
        EvidenceBoot, EvidenceValidationError, ExpectedStorageContext,
        MAX_EVIDENCE_BYTES, verify_storage_release_evidence,
    )

KEY_ENV = "FUND_STORAGE_EVIDENCE_KEY_B64"
KEY_ID_ENV = "FUND_STORAGE_EVIDENCE_KEY_ID"
MAX_CONTEXT_BYTES = 8192
# Reject known configured credentials; this does not prove key independence
# from every possible external credential. The protected caller must ensure it.
NON_ATTESTATION_CREDENTIALS = (
    "ADMIN_TOKEN", "WORKER_TOKEN", "PRIVATE_READ_TOKEN", "OWNER_PASSWORD_HASH",
    "TURSO_AUTH_TOKEN", "TURSO_API_TOKEN", "TURSO_API_KEY", "RENDER_API_KEY",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
)


class InputError(ValueError):
    """Fixed input error; never includes a filename, argument or secret."""


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise InputError("invalid_arguments")


def _read_regular_file(value: str, limit: int) -> bytes:
    try:
        path = Path(value)
        metadata = path.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or path.is_symlink()
                or getattr(metadata, "st_file_attributes", 0) & 0x400):
            raise InputError("invalid_input_file")
        with path.open("rb") as source:
            opened = os.fstat(source.fileno())
            if (not stat.S_ISREG(opened.st_mode)
                    or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino)):
                raise InputError("invalid_input_file")
            content = source.read(limit + 1)
        if not content or len(content) > limit:
            raise InputError("input_size_invalid")
        return content
    except (OSError, ValueError) as exc:
        if isinstance(exc, InputError):
            raise
        raise InputError("invalid_input_file") from None


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise InputError("invalid_context")
        result[key] = value
    return result


def _reject_constant(value):
    raise InputError("invalid_context")


def _context(content: bytes) -> ExpectedStorageContext:
    try:
        value = json.loads(content.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=_reject_constant)
        fields = {
            "context_version", "target_sha", "write_source_sha256", "engine",
            "authority", "resource_fingerprint", "credential_configuration_revision",
            "database_schema_version", "current_read_boot", "generator_ci_run_id",
        }
        if (type(value) is not dict or set(value) != fields
                or type(value["context_version"]) is not int or value["context_version"] != 1):
            raise InputError("invalid_context")
        boot = value["current_read_boot"]
        if type(boot) is not dict or set(boot) != {"id", "started_at", "deployment_sha"}:
            raise InputError("invalid_context")
        # The verifier validates all types and semantics of these exact fields.
        return ExpectedStorageContext(
            target_sha=value["target_sha"], write_source_sha256=value["write_source_sha256"],
            engine=value["engine"], authority=value["authority"],
            resource_fingerprint=value["resource_fingerprint"],
            credential_configuration_revision=value["credential_configuration_revision"],
            database_schema_version=value["database_schema_version"],
            current_read_boot=EvidenceBoot(**boot),
            generator_ci_run_id=value["generator_ci_run_id"],
        )
    except (ValueError, TypeError, RecursionError, KeyError):
        raise InputError("invalid_context") from None


def _verification_key(environ) -> tuple[bytes, str]:
    encoded = environ.get(KEY_ENV, "")
    key_id = environ.get(KEY_ID_ENV, "")
    if (not isinstance(encoded, str) or not 43 <= len(encoded) <= 5462
            or not re.fullmatch(r"[A-Za-z0-9_-]+", encoded)
            or not isinstance(key_id, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", key_id)):
        raise InputError("verification_key_not_configured")
    try:
        key = base64.b64decode(encoded + "=" * (-len(encoded) % 4),
                               altchars=b"-_", validate=True)
    except ValueError:
        raise InputError("verification_key_not_configured") from None
    if (not 32 <= len(key) <= 4096
            or base64.urlsafe_b64encode(key).decode("ascii").rstrip("=") != encoded):
        raise InputError("verification_key_not_configured")
    for name in NON_ATTESTATION_CREDENTIALS:
        configured = environ.get(name, "")
        if isinstance(configured, str) and configured:
            try:
                credential = configured.encode("utf-8")
            except UnicodeEncodeError:
                raise InputError("invalid_credential_configuration") from None
            if (hmac.compare_digest(key, credential)
                    or hmac.compare_digest(encoded.encode("ascii"), credential)):
                raise InputError("independent_verification_key_required")
    return key, key_id


def main(argv=None, *, stdout=None, stderr=None, environ=None, now=None) -> int:
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    environ = os.environ if environ is None else environ
    parser = _Parser(description=__doc__)
    parser.add_argument("--evidence", required=True, help="Explicit bounded signed JSON file")
    parser.add_argument("--context", required=True, help="Protected executor's current metadata JSON file")
    try:
        args = parser.parse_args(argv)
        key, key_id = _verification_key(environ)
        context = _context(_read_regular_file(args.context, MAX_CONTEXT_BYTES))
        evidence = _read_regular_file(args.evidence, MAX_EVIDENCE_BYTES)
        verify_storage_release_evidence(
            evidence, key=key, expected_key_id=key_id, expected=context,
            now=datetime.now(timezone.utc) if now is None else now,
        )
    except (InputError, EvidenceValidationError):
        print("storage evidence preflight failed: invalid or untrusted input", file=stderr)
        return 1
    # This preflight's success is never a formal_release_status or durable flag.
    print(json.dumps({
        "check": "signature_and_expected_context", "result": "passed",
        "formal_release_verified": False,
        "reason": "production_executor_and_release_integration_pending",
    }, sort_keys=True, separators=(",", ":")), file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
