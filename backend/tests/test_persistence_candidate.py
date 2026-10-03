"""Synthetic-only local repository/recovery gates; no provider connections."""
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

from database import db
from service import persistence_verification as verification, v8_repo


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "persistence_candidate.py"
SPEC = importlib.util.spec_from_file_location("persistence_candidate_tool", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)
NAMESPACE = "v9-acceptance-test"


def invoke(path, command, *extra, namespace=NAMESPACE):
    out, err = io.StringIO(), io.StringIO()
    status = module.main([
        "--database", str(path), "--namespace", namespace, command, *extra,
    ], stdout=out, stderr=err)
    return status, json.loads(out.getvalue()) if out.getvalue() else None, err.getvalue()


def saved_receipt(tmp_path, receipt):
    path = tmp_path / "receipt.json"
    path.write_text(json.dumps(receipt), encoding="utf-8")
    return path


def provision(tmp_path, monkeypatch):
    path = tmp_path / "isolated.db"
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    with path.open("xb"):
        pass
    verification.provision_local_namespace(path, NAMESPACE)
    return path


def test_local_chain_idempotency_missing_values_and_export(tmp_path):
    path = tmp_path / "isolated.db"
    code, first, err = invoke(path, "create", "--candidate")
    assert code == 0 and not err
    assert first["evidence_scope"] == "local_application_repository_chain"
    assert first["formal_release_verified"] is False and first["durable"] is False
    assert first["synthetic_only"] is True
    assert "remote_turso_restart" in first["not_covered"]
    code, replay, err = invoke(path, "write", "--candidate")
    assert code == 0 and not err
    assert replay["chain_sha256"] == first["chain_sha256"]
    assert replay["chain_ids"] == first["chain_ids"]
    receipt = saved_receipt(tmp_path, first)
    code, exported, err = invoke(path, "export-synthetic", "--receipt", str(receipt))
    assert code == 0 and not err
    assert exported["private_data_export"] is False
    assert exported["payloads"]["holding"]["cost"] is None
    assert exported["payloads"]["evidence"]["estimate_mae"] is None
    assert exported["payloads"]["decision"]["holding_version"] == first["chain_ids"]["holding"]
    with sqlite3.connect(path) as conn:
        for table in ("evidence_snapshots", "holding_versions", "portfolio_policy_versions", "decision_snapshots"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 1
        for table in ("outcome_evaluations", "portfolio_outcome_evaluations", "notification_events"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


@pytest.mark.parametrize("command", ["create", "write"])
def test_write_requires_explicit_candidate_before_touching_file(tmp_path, command):
    path = tmp_path / "not-created.db"
    code, out, err = invoke(path, command)
    assert code == 2 and out is None
    assert "candidate_acknowledgement_required" in err
    assert not path.exists()


@pytest.mark.parametrize("path", ["libsql://private-url", "file:private.db?mode=rw", "https://secret.invalid/db"])
def test_cli_rejects_remote_or_uri_targets_without_disclosure(path):
    code, out, err = invoke(path, "create", "--candidate")
    assert code == 2 and out is None
    assert path not in err


def test_existing_database_is_never_overwritten_or_adopted(tmp_path):
    path = tmp_path / "private.db"
    path.write_bytes(b"private-marker")
    code, out, err = invoke(path, "create", "--candidate")
    assert code == 2 and out is None
    assert "new_database_required" in err and "private-marker" not in err
    assert path.read_bytes() == b"private-marker"


def test_unmarked_existing_schema_cannot_receive_fixture(tmp_path, monkeypatch):
    path = tmp_path / "other.db"
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    code, out, err = invoke(path, "write", "--candidate")
    assert code == 1 and out is None
    assert "isolated_database_marker_required" in err
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM holding_versions").fetchone()[0] == 0


def test_namespace_source_drift_and_other_data_fail_closed(tmp_path, monkeypatch):
    path = provision(tmp_path, monkeypatch)
    with pytest.raises(verification.VerificationError, match="namespace_mismatch"):
        verification.write_local_chain(path, "v9-acceptance-other")
    original = verification.source_fingerprint
    monkeypatch.setattr(verification, "source_fingerprint", lambda: "a" * 64)
    with pytest.raises(verification.VerificationError, match="source_code_drift"):
        verification.write_local_chain(path, NAMESPACE)
    monkeypatch.setattr(verification, "source_fingerprint", original)
    with db.transaction(immediate=True) as conn:
        conn.execute("INSERT INTO watchlist VALUES('000001','2026-09-01')")
    with pytest.raises(verification.VerificationError, match="non_acceptance_data"):
        verification.write_local_chain(path, NAMESPACE)


@pytest.mark.parametrize("tamper,error", [
    ("DROP TRIGGER immutable_holding_versions_update", "immutable_trigger_mismatch"),
    ("DROP INDEX idx_holding_fund_created", "schema_contract_mismatch"),
    ("PRAGMA user_version=99", "schema_contract_mismatch"),
])
def test_schema_and_immutable_contract_not_silently_repaired(tmp_path, monkeypatch, tamper, error):
    path = provision(tmp_path, monkeypatch)
    verification.write_local_chain(path, NAMESPACE)
    with sqlite3.connect(path) as conn:
        conn.execute(tamper)
    with pytest.raises(verification.VerificationError, match=error):
        verification.read_local_chain(path, NAMESPACE)
    with sqlite3.connect(path) as conn:
        # Reader never calls init_db() to conceal drift.
        if "TRIGGER" in tamper:
            assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='immutable_holding_versions_update'").fetchone() is None


def test_trigger_name_with_weakened_behavior_is_not_accepted(tmp_path, monkeypatch):
    path = provision(tmp_path, monkeypatch)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_holding_versions_update")
        conn.execute("CREATE TRIGGER immutable_holding_versions_update BEFORE UPDATE ON holding_versions BEGIN SELECT 1; END")
    with pytest.raises(verification.VerificationError, match="immutable_trigger_mismatch"):
        verification.write_local_chain(path, NAMESPACE)


def test_receipt_wrong_resource_digest_namespace_and_boot_rejected(tmp_path, monkeypatch):
    path = provision(tmp_path, monkeypatch)
    receipt = verification.write_local_chain(path, NAMESPACE)
    for key, value in (("resource_fingerprint", "b" * 64), ("chain_sha256", "b" * 64),
                       ("namespace", "v9-acceptance-other"), ("boot_id", None),
                       ("boot_started_at", "2026-09-01T00:00:00"), ("durable", True)):
        with pytest.raises(verification.VerificationError):
            verification.read_local_chain(path, NAMESPACE, receipt={**receipt, key: value})
    with pytest.raises(verification.VerificationError, match="receipt_resource_mismatch"):
        verification.read_local_chain(path, NAMESPACE, receipt=receipt, restored_local=True)


def test_column_projection_tampering_rejected_even_if_payload_unchanged(tmp_path, monkeypatch):
    path = provision(tmp_path, monkeypatch)
    verification.write_local_chain(path, NAMESPACE)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_holding_versions_update")
        conn.execute("UPDATE holding_versions SET shares=1")
        conn.execute("CREATE TRIGGER immutable_holding_versions_update BEFORE UPDATE ON holding_versions BEGIN SELECT RAISE(ABORT, 'holding_versions is immutable'); END")
    with pytest.raises(verification.VerificationError, match="stored_projection_mismatch"):
        verification.read_local_chain(path, NAMESPACE)


def test_source_health_projection_must_match_its_payload(tmp_path, monkeypatch):
    path = provision(tmp_path, monkeypatch)
    verification.write_local_chain(path, NAMESPACE)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_source_health_events_update")
        conn.execute("UPDATE source_health_events SET state='unavailable'")
        conn.execute("CREATE TRIGGER immutable_source_health_events_update BEFORE UPDATE ON source_health_events BEGIN SELECT RAISE(ABORT, 'source_health_events is immutable'); END")
    with pytest.raises(verification.VerificationError, match="source_health_projection_mismatch"):
        verification.read_local_chain(path, NAMESPACE)


def test_repository_readback_issues_no_mutating_statement(tmp_path, monkeypatch):
    path = provision(tmp_path, monkeypatch)
    receipt = verification.write_local_chain(path, NAMESPACE)
    original = db.get_conn
    queries = []
    def traced_connection():
        conn = original()
        conn.set_trace_callback(queries.append)
        return conn
    monkeypatch.setattr(db, "get_conn", traced_connection)
    verification.read_local_chain(path, NAMESPACE, receipt=receipt)
    assert queries
    assert all(query.lstrip().upper().startswith("SELECT") for query in queries)


def test_cli_restores_original_configuration_and_does_not_read_provider_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("FUND_DB_BACKEND", "turso")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "turso_candidate")
    monkeypatch.setenv("TURSO_AUTH_TOKEN", "synthetic-unused-sensitive-marker")
    monkeypatch.setenv("TURSO_DATABASE_URL", "libsql://synthetic-must-not-contact.invalid")
    previous_path = db.DB_PATH
    code, receipt, err = invoke(tmp_path / "local.db", "create", "--candidate")
    assert code == 0 and not err
    assert os.environ["FUND_DB_BACKEND"] == "turso"
    assert os.environ["FUND_DB_PERSISTENCE"] == "turso_candidate"
    assert db.DB_PATH == previous_path
    assert "sensitive-marker" not in json.dumps(receipt)
    assert "must-not-contact" not in json.dumps(receipt)


def test_partial_chain_failure_replays_deterministic_prefix(tmp_path, monkeypatch):
    path = provision(tmp_path, monkeypatch)
    original = v8_repo.save_evidence
    def failed(snapshot):
        raise RuntimeError("secret-marker-must-not-be-reported")
    monkeypatch.setattr(v8_repo, "save_evidence", failed)
    code, out, err = invoke(path, "write", "--candidate")
    assert code == 1 and out is None and "secret-marker" not in err
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM holding_versions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM evidence_snapshots").fetchone()[0] == 0
    monkeypatch.setattr(v8_repo, "save_evidence", original)
    verification.write_local_chain(path, NAMESPACE)
    assert verification.read_local_chain(path, NAMESPACE)["repository_readback_verified"] is True


@pytest.mark.parametrize("commit_then_fail", [False, True])
def test_local_commit_failure_rolls_back_or_reconciles_without_false_success(tmp_path, monkeypatch, commit_then_fail):
    path = provision(tmp_path, monkeypatch)
    original = db.get_conn
    class FailedCommit:
        def __init__(self, conn):
            self.conn = conn
        def __getattr__(self, name):
            return getattr(self.conn, name)
        def commit(self):
            if commit_then_fail:
                self.conn.commit()
            raise sqlite3.OperationalError("synthetic commit failure; not provider evidence")
    monkeypatch.setattr(db, "get_conn", lambda: FailedCommit(original()))
    with pytest.raises(sqlite3.OperationalError):
        verification.write_local_chain(path, NAMESPACE)
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM holding_versions").fetchone()[0] == int(commit_then_fail)
    monkeypatch.setattr(db, "get_conn", original)
    first = verification.write_local_chain(path, NAMESPACE)
    replay = verification.write_local_chain(path, NAMESPACE)
    assert first["chain_sha256"] == replay["chain_sha256"]


def run_process(path, command, *extra):
    env = os.environ.copy()
    # Host credentials must not be used even if a configured backend is Turso.
    env["FUND_DB_BACKEND"] = "turso"
    env["TURSO_DATABASE_URL"] = "libsql://must-not-contact.invalid"
    env["TURSO_AUTH_TOKEN"] = "synthetic-unused-not-a-real-secret"
    process = subprocess.run([
        sys.executable, str(SCRIPT), "--database", str(path), "--namespace", NAMESPACE,
        command, *extra,
    ], cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert process.returncode == 0, process.stderr
    assert "must-not-contact" not in process.stdout + process.stderr
    return json.loads(process.stdout)


def test_real_process_restart_and_local_backup_restore_are_honestly_scoped(tmp_path):
    original = tmp_path / "original.db"
    restored = tmp_path / "restored.db"
    written = run_process(original, "create", "--candidate")
    receipt = saved_receipt(tmp_path, written)
    restarted = run_process(original, "read", "--receipt", str(receipt))
    assert restarted["boot_id"] != written["boot_id"]
    assert restarted["restart_observed"] is True
    assert restarted["chain_sha256"] == written["chain_sha256"]
    source = sqlite3.connect(original)
    destination = sqlite3.connect(restored)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    restored_result = run_process(restored, "verify-restored-local", "--receipt", str(receipt))
    assert restored_result["evidence_scope"] == "local_restored_application_repository_chain"
    assert restored_result["provider"] == "local_sqlite"
    assert restored_result["durable"] is False
    assert restored_result["formal_release_verified"] is False
    assert restored_result["resource_fingerprint"] != written["resource_fingerprint"]
    assert restored_result["original_resource_fingerprint"] == written["resource_fingerprint"]
    assert restored_result["chain_sha256"] == written["chain_sha256"]
