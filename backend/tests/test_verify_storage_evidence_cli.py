"""Synthetic preflight CLI tests; no cloud, real credentials or release writes."""
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location("verify_storage_evidence_cli", TOOLS / "verify_storage_evidence.py")
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)
KEY = bytes(range(32))  # Public synthetic fixture; not a production key.
NOW = datetime(2026, 9, 30, 8, 0, tzinfo=timezone.utc)


def fixture_data():
    boot = {"id": "read-boot", "started_at": "2026-09-30T07:02:00Z", "deployment_sha": "a" * 40}
    context = {
        "context_version": 1, "target_sha": "a" * 40,
        "write_source_sha256": "b" * 64, "engine": "libsql", "authority": "turso_cloud",
        "resource_fingerprint": "c" * 64, "credential_configuration_revision": "revision-2",
        "database_schema_version": 8, "current_read_boot": boot, "generator_ci_run_id": 123,
    }
    payload = {
        "contract_version": 1, "scope": "production_application_chain", "target_sha": "a" * 40,
        "write_source_sha256": "b" * 64, "engine": "libsql", "authority": "turso_cloud",
        "resource_fingerprint": "c" * 64, "credential_configuration_revision": "revision-2",
        "database_schema_version": 8, "application_record_id": "synthetic-test-record",
        "write_sha256": "d" * 64, "read_sha256": "d" * 64,
        "write_boot": {"id": "write-boot", "started_at": "2026-09-30T07:00:00Z", "deployment_sha": "a" * 40},
        "read_boot": boot, "written_at": "2026-09-30T07:01:00Z", "read_at": "2026-09-30T07:03:00Z",
        "recovery": {
            "scope": "independent_provider_restore", "restored_resource_fingerprint": "e" * 64,
            "application_read_sha256": "d" * 64, "schema_verified": True, "constraints_verified": True,
            "completed_at": "2026-09-30T07:04:00Z", "rpo_seconds": 0, "rto_seconds": 60,
        },
        "ci_run_id": 123, "issued_at": "2026-09-30T07:05:00Z", "expires_at": "2026-10-01T07:05:00Z",
    }
    signature = hmac.new(KEY, json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                        ensure_ascii=False, allow_nan=False).encode(), hashlib.sha256).hexdigest()
    evidence = {"payload": payload, "attestation": {"algorithm": "HMAC-SHA256", "key_id": "test-key", "signature": signature}}
    return context, evidence


def files(tmp_path, context=None, evidence=None):
    default_context, default_evidence = fixture_data()
    context_path = tmp_path / "context.json"
    evidence_path = tmp_path / "evidence.json"
    context_path.write_text(json.dumps(default_context if context is None else context), encoding="utf-8")
    evidence_path.write_text(json.dumps(default_evidence if evidence is None else evidence), encoding="utf-8")
    return context_path, evidence_path


def env():
    return {cli.KEY_ENV: base64.urlsafe_b64encode(KEY).decode().rstrip("="), cli.KEY_ID_ENV: "test-key"}


def invoke(context_path, evidence_path, *, environment=None, extra=()):
    out, err = io.StringIO(), io.StringIO()
    result = cli.main(["--context", str(context_path), "--evidence", str(evidence_path), *extra],
                      stdout=out, stderr=err, environ=env() if environment is None else environment, now=NOW)
    return result, out.getvalue(), err.getvalue()


def assert_redacted_failure(result):
    code, out, err = result
    assert code == 1 and not out
    assert err == "storage evidence preflight failed: invalid or untrusted input\n"


def test_cli_only_confirms_signature_and_context_not_formal_release(tmp_path):
    result, out, err = invoke(*files(tmp_path))
    assert result == 0 and not err
    assert json.loads(out) == {
        "check": "signature_and_expected_context", "result": "passed", "formal_release_verified": False,
        "reason": "production_executor_and_release_integration_pending",
    }
    assert "durable" not in out and "storage_verified" not in out and "synthetic-test-record" not in out


@pytest.mark.parametrize("environment", [
    {}, {cli.KEY_ENV: "sensitive-marker", cli.KEY_ID_ENV: "test-key"},
    {cli.KEY_ENV: base64.urlsafe_b64encode(b"short").decode().rstrip("="), cli.KEY_ID_ENV: "test-key"},
    {cli.KEY_ENV: env()[cli.KEY_ENV] + "=", cli.KEY_ID_ENV: "test-key"},
    {cli.KEY_ENV: env()[cli.KEY_ENV], cli.KEY_ID_ENV: "key-with\nnew-line"},
])
def test_missing_or_bad_key_never_falls_back_or_echoes(tmp_path, environment):
    assert_redacted_failure(invoke(*files(tmp_path), environment=environment))


@pytest.mark.parametrize("name", cli.NON_ATTESTATION_CREDENTIALS)
def test_encoded_auth_credential_cannot_be_reused_as_evidence_key(tmp_path, name):
    environment = {**env(), name: env()[cli.KEY_ENV]}
    assert_redacted_failure(invoke(*files(tmp_path), environment=environment))


def test_decoded_auth_credential_cannot_be_reused(tmp_path):
    key = b"synthetic-auth-credential-not-production-32"
    environment = {cli.KEY_ENV: base64.urlsafe_b64encode(key).decode().rstrip("="), cli.KEY_ID_ENV: "test-key", "ADMIN_TOKEN": key.decode()}
    assert_redacted_failure(invoke(*files(tmp_path), environment=environment))


@pytest.mark.parametrize("name", cli.NON_ATTESTATION_CREDENTIALS)
def test_bad_credential_environment_does_not_raise_or_echo(tmp_path, name):
    assert_redacted_failure(invoke(*files(tmp_path), environment={**env(), name: "\ud800synthetic-only"}))


@pytest.mark.parametrize("mutation", ["extra", "wrong-version", "bool-version", "wrong-boot", "wrong-run", "bad-schema"])
def test_context_is_exact_bounded_and_independent(tmp_path, mutation):
    context, evidence = fixture_data()
    if mutation == "extra":
        context["sensitive-marker"] = "never-echo"
    elif mutation == "wrong-version":
        context["context_version"] = 2
    elif mutation == "bool-version":
        context["context_version"] = True
    elif mutation == "wrong-boot":
        context["current_read_boot"]["id"] = "new-boot"
    elif mutation == "wrong-run":
        context["generator_ci_run_id"] = 124
    else:
        context["database_schema_version"] = True
    assert_redacted_failure(invoke(*files(tmp_path, context, evidence)))


@pytest.mark.parametrize("content", [
    '{"context_version":1,"context_version":1}', '{"context_version":NaN}',
    '{"context_version":Infinity}', '{"context_version":1e9999}',
    '[' * 1000 + '0' + ']' * 1000,
])
def test_bad_context_json_fails_without_traceback(tmp_path, content):
    context, evidence = files(tmp_path)
    context.write_text(content, encoding="utf-8")
    assert_redacted_failure(invoke(context, evidence))


@pytest.mark.parametrize("which", ["evidence", "context"])
def test_file_size_limits_and_unexpected_paths_fail_closed(tmp_path, which):
    context, evidence = files(tmp_path)
    selected = evidence if which == "evidence" else context
    limit = cli.MAX_EVIDENCE_BYTES if which == "evidence" else cli.MAX_CONTEXT_BYTES
    selected.write_bytes(b"s" * (limit + 1))
    assert_redacted_failure(invoke(context, evidence))
    assert_redacted_failure(invoke(tmp_path if which == "context" else context,
                                  tmp_path if which == "evidence" else evidence))


def test_no_secret_command_line_flags_or_arbitrary_signing(tmp_path):
    assert_redacted_failure(invoke(*files(tmp_path), extra=("--key", "sensitive-marker")))
    assert_redacted_failure(invoke(*files(tmp_path), extra=("--sign",)))


def test_local_unsigned_receipt_rejected(tmp_path):
    context, evidence = files(tmp_path, evidence={"scope": "local_application_repository_chain", "durable": False})
    assert_redacted_failure(invoke(context, evidence))


def test_direct_script_runs_and_does_not_leak_paths_when_unconfigured(tmp_path):
    context, evidence = files(tmp_path)
    result = subprocess.run([sys.executable, str(TOOLS / "verify_storage_evidence.py"),
                             "--context", str(context), "--evidence", str(evidence)],
                            env={}, capture_output=True, encoding="utf-8", timeout=10)
    assert_redacted_failure((result.returncode, result.stdout, result.stderr))
