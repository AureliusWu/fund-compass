"""Offline-only schema8 snapshots and failure injection; no cloud evidence."""
import importlib.util
from io import StringIO
import json
import os
from pathlib import Path
import socket
import sqlite3

import pytest

from database import db, turso_schema, turso_scope_upgrade as upgrade
from models.v8 import canonical_json
from test_acceptance_write_boundary import business_chain, configure, save_chain
from test_repository_scopes import drop_scope_contract, root_rows, legacy_derived_db


@pytest.fixture
def snapshot(tmp_path, monkeypatch):
    path = tmp_path / "private-path-snapshot.db"
    configure(path, monkeypatch)
    db.init_db()
    chain = business_chain()
    save_chain(chain)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO funds VALUES('000001','private-name-marker','mixed',NULL)")
        conn.execute("INSERT INTO funds VALUES('000002',NULL,'mixed','')")
        conn.execute("INSERT INTO fund_detail(code,latest_nav,scale) VALUES('000001',0,NULL)")
        conn.execute("INSERT INTO nav_history VALUES('000001','2026-08-31',1.0,NULL)")
        conn.execute("INSERT INTO decision_history(code,decision_date,base_nav,action,strategy_version,created_at) VALUES('000001','2026-08-31',1,'hold','test-v1','2026-08-31T00:00:00+00:00')")
        conn.execute("DELETE FROM decision_history")
        drop_scope_contract(conn)
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    assert conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete"
    conn.close()
    return path, chain


@pytest.fixture
def derived_snapshot(legacy_derived_db):
    path, portfolio = legacy_derived_db
    closed = path.with_name("closed-derived-snapshot.db")
    source = sqlite3.connect(path)
    destination = sqlite3.connect(closed)
    try:
        # The shared fixture may retain read handles. Create an actual coherent
        # local test snapshot rather than deleting/ignoring its live WAL.
        source.backup(destination)
        assert destination.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete"
    finally:
        destination.close()
        source.close()
    return closed, portfolio


def remote_snapshot(snapshot):
    path, chain = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute(turso_schema.VERSION_DDL)
        conn.execute("INSERT INTO _schema_version VALUES(1,8)")
        conn.execute("PRAGMA user_version=0")
    return path, chain


def cli_module():
    path = Path(__file__).resolve().parents[2] / "tools/turso_scope_upgrade.py"
    spec = importlib.util.spec_from_file_location("offline_turso_scope_upgrade_cli", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("kind", ["local-header", "remote-schema-table"])
def test_plan_rehearsal_preserves_closed_input_and_all_bindings(snapshot, kind):
    path, chain = remote_snapshot(snapshot) if kind == "remote-schema-table" else snapshot
    before = path.read_bytes()
    with sqlite3.connect(path) as conn:
        roots_before = root_rows(conn)
    plan = upgrade.rehearse_snapshot(path, source_kind=kind, restore=False)
    result = upgrade.rehearse_snapshot(path, source_kind=kind, expected_plan_sha256=plan["plan_sha256"],
                                      expected_backup_sha256=plan["logical_backup_sha256"])
    assert result["ok"] and result["from_schema"] == 8 and result["to_schema"] == 9
    assert result["evidence_scope"] == "local_turso_schema_migration_rehearsal"
    assert result["source_file_unchanged"] and result["legacy_rows_unchanged"]
    assert result["repository_roots_readback_verified"] and result["local_logical_restore_verified"]
    assert not result["remote_applied"] and not result["remote_restore_verified"] and not result["formal_release_verified"]
    assert plan["local_logical_restore_verified"] is False
    assert plan["target_rows_sha256"] == result["target_rows_sha256"]
    assert path.read_bytes() == before
    with sqlite3.connect(path) as conn:
        assert root_rows(conn) == roots_before
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='v8_record_scopes'").fetchone()
    emitted = json.dumps(result)
    assert str(path) not in emitted and "private-name-marker" not in emitted
    assert chain["decision"].decision_id not in emitted
    assert "TURSO_AUTH_TOKEN" not in emitted


def test_valid_full_derived_chain_restores_readably(derived_snapshot):
    path, _ = derived_snapshot
    before = path.read_bytes()
    result = upgrade.rehearse_snapshot(path, source_kind="local-header")
    assert result["local_logical_restore_verified"] and result["legacy_rows_unchanged"]
    assert path.read_bytes() == before


@pytest.mark.parametrize("table,payload", [
    ("source_health_events", "payload_json"), ("outcome_evaluations", "payload_json"),
    ("portfolio_decision_snapshots", "payload_json"), ("portfolio_outcome_evaluations", "payload_json"),
    ("notification_events", "detail_json"),
])
def test_derived_invalid_json_is_rejected(derived_snapshot, table, payload):
    path, _ = derived_snapshot
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_" + table + "_update")
        conn.execute(f"UPDATE {table} SET {payload}='not-json'")
        conn.execute(f"CREATE TRIGGER immutable_{table}_update BEFORE UPDATE ON {table} BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END")
    before = path.read_bytes()
    with pytest.raises(upgrade.UpgradeError, match="snapshot_json_invalid"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")
    assert path.read_bytes() == before


@pytest.mark.parametrize("table,column,assignment", [
    ("source_health_events", "observed_at", "'2026-08-24T06:30:00+00:00'"),
    ("outcome_evaluations", "absolute_return", "99"),
    ("portfolio_decision_snapshots", "component_count", "1"),
    ("portfolio_outcome_evaluations", "absolute_return", "99"),
    ("notification_events", "natural_schedule", "0"),
])
def test_derived_projection_drift_is_rejected(derived_snapshot, table, column, assignment):
    path, _ = derived_snapshot
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_" + table + "_update")
        conn.execute(f"UPDATE {table} SET {column}={assignment}")
        conn.execute(f"CREATE TRIGGER immutable_{table}_update BEFORE UPDATE ON {table} BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END")
    with pytest.raises(upgrade.UpgradeError, match="legacy_chain_validation_failed"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


@pytest.mark.parametrize("version", [0, 7, 9, 10, 100])
def test_local_header_rejects_not_exactly8(snapshot, version):
    path, _ = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute(f"PRAGMA user_version={version}")
    before = path.read_bytes()
    with pytest.raises(upgrade.UpgradeError, match="source_version_invalid"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")
    assert path.read_bytes() == before


@pytest.mark.parametrize("version", [7, 9, 10])
def test_remote_schema_table_rejects_not_exactly8(snapshot, version):
    path, _ = remote_snapshot(snapshot)
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE _schema_version SET version=?", (version,))
    with pytest.raises(upgrade.UpgradeError, match="source_version_invalid"):
        upgrade.rehearse_snapshot(path, source_kind="remote-schema-table")


@pytest.mark.parametrize("sql", [
    "CREATE TABLE private_extra_table(secret TEXT)",
    "CREATE TABLE local_persistence_acceptance_v1(namespace TEXT)",
    "CREATE VIEW private_view AS SELECT * FROM holding_versions",
    "DROP TRIGGER immutable_holding_versions_delete",
    "CREATE TRIGGER private_trigger AFTER INSERT ON funds BEGIN SELECT 1; END",
    "DROP INDEX idx_holding_fund_created",
    "ALTER TABLE holding_versions ADD COLUMN private_extra TEXT",
])
def test_unrecognized_or_weakened_schema_is_rejected_without_input_writes(snapshot, sql):
    path, _ = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute(sql)
    before = path.read_bytes()
    with pytest.raises(upgrade.UpgradeError, match="source_schema_contract_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")
    assert path.read_bytes() == before


@pytest.mark.parametrize("tamper", ["json", "identity", "digest", "projection", "reserved", "duplicate_json", "nonfinite_json"])
def test_root_invalidity_is_rejected(snapshot, tamper):
    path, chain = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_holding_versions_update")
        raw = json.loads(conn.execute("SELECT payload_json FROM holding_versions").fetchone()[0])
        if tamper == "json":
            conn.execute("UPDATE holding_versions SET payload_json='not-json'")
        elif tamper == "duplicate_json":
            conn.execute("UPDATE holding_versions SET payload_json=?", ('{"source":"a","source":"b"}',))
        elif tamper == "nonfinite_json":
            conn.execute("UPDATE holding_versions SET payload_json=?", ('{"shares":NaN}',))
        elif tamper == "identity":
            raw["holding_version"] = "private-invalid-id"
            conn.execute("UPDATE holding_versions SET payload_json=?", (canonical_json(raw),))
        elif tamper == "digest":
            conn.execute("UPDATE holding_versions SET payload_sha256='invalid-private-digest'")
        elif tamper == "projection":
            conn.execute("UPDATE holding_versions SET shares=999")
        else:
            raw["source"] = "synthetic:private-marker"
            conn.execute("UPDATE holding_versions SET payload_json=?", (canonical_json(raw),))
        conn.execute("CREATE TRIGGER immutable_holding_versions_update BEFORE UPDATE ON holding_versions BEGIN SELECT RAISE(ABORT, 'holding_versions is immutable'); END")
    before = path.read_bytes()
    with pytest.raises(upgrade.UpgradeError) as caught:
        upgrade.rehearse_snapshot(path, source_kind="local-header")
    assert str(caught.value) in {"snapshot_json_invalid", "legacy_chain_validation_failed"}
    assert path.read_bytes() == before


def test_orphan_reference_and_cycle_refuse_rehearsal(snapshot):
    path, chain = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_portfolio_policy_versions_update")
        conn.execute("UPDATE portfolio_policy_versions SET supersedes=policy_version")
        conn.execute("CREATE TRIGGER immutable_portfolio_policy_versions_update BEFORE UPDATE ON portfolio_policy_versions BEGIN SELECT RAISE(ABORT, 'portfolio_policy_versions is immutable'); END")
    with pytest.raises(upgrade.UpgradeError, match="legacy_chain_validation_failed"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_orphan_foreign_key_is_rejected(snapshot):
    path, _ = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_decision_snapshots_update")
        conn.execute("UPDATE decision_snapshots SET holding_version='missing-private-root'")
        conn.execute("CREATE TRIGGER immutable_decision_snapshots_update BEFORE UPDATE ON decision_snapshots BEGIN SELECT RAISE(ABORT, 'decision_snapshots is immutable'); END")
    with pytest.raises(upgrade.UpgradeError, match="snapshot_foreign_key_failure"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_missing_source_does_not_create_a_database(tmp_path):
    missing = tmp_path / "missing-private-path.db"
    with pytest.raises(upgrade.UpgradeError, match="source_unavailable"):
        upgrade.rehearse_snapshot(missing, source_kind="local-header")
    assert not missing.exists()


def test_non_sqlite_and_directory_inputs_fail_closed(tmp_path):
    plain = tmp_path / "private-text.txt"
    plain.write_bytes(b"not a SQLite database")
    for source, error in ((plain, "source_not_sqlite"), (tmp_path, "source_not_regular_file")):
        with pytest.raises(upgrade.UpgradeError, match=error):
            upgrade.rehearse_snapshot(source, source_kind="local-header")


def test_source_kind_cannot_guess_or_fallback(snapshot):
    path, _ = snapshot
    with pytest.raises(upgrade.UpgradeError, match="source_schema_contract_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="remote-schema-table")
    remote_snapshot(snapshot)
    with pytest.raises(upgrade.UpgradeError, match="source_version_invalid"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


@pytest.mark.parametrize("limit,value", [("MAX_FILE_BYTES", 1), ("MAX_ROWS", 1), ("MAX_TABLE_ROWS", 0),
                                         ("MAX_BODY_BYTES", 1), ("MAX_SCHEMA_OBJECTS", 1), ("MAX_CELL_BYTES", 8)])
def test_limits_reject_not_truncate(snapshot, monkeypatch, limit, value):
    path, _ = snapshot
    monkeypatch.setattr(upgrade, limit, value)
    with pytest.raises(upgrade.UpgradeError):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_expired_budget_rejects(snapshot, monkeypatch):
    path, _ = snapshot
    monkeypatch.setattr(upgrade, "TIME_BUDGET_SECONDS", -1)
    with pytest.raises(upgrade.UpgradeError, match="rehearsal_time_limit"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


@pytest.mark.parametrize("binding", ["expected_plan_sha256", "expected_backup_sha256"])
def test_changed_binding_rejects(snapshot, binding):
    path, _ = snapshot
    with pytest.raises(upgrade.UpgradeError, match="plan_binding_mismatch|backup_digest_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", **{binding: "0" * 64})


def test_source_drift_between_plan_and_rehearsal_is_rejected(snapshot):
    path, _ = snapshot
    plan = upgrade.rehearse_snapshot(path, source_kind="local-header", restore=False)
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE funds SET name='changed-private-name'")
    with pytest.raises(upgrade.UpgradeError, match="plan_binding_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", expected_plan_sha256=plan["plan_sha256"])


def test_source_drift_during_snapshot_is_rejected(snapshot, monkeypatch):
    path, _ = snapshot
    original = upgrade._snapshot_rows
    def drifting(conn, expected, budget):
        result = original(conn, expected, budget)
        with sqlite3.connect(path) as writer:
            writer.execute("UPDATE funds SET name='concurrent-private-name'")
        return result
    monkeypatch.setattr(upgrade, "_snapshot_rows", drifting)
    with pytest.raises(upgrade.UpgradeError, match="source_drift_detected"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_corrupted_logical_backup_never_claims_restore(snapshot, monkeypatch):
    path, _ = snapshot
    original = upgrade._restore_image
    def corrupt(image, expected, budget):
        corrupted = image[:-1] + bytes([image[-1] ^ 1])
        return original(corrupted, expected, budget)
    monkeypatch.setattr(upgrade, "_restore_image", corrupt)
    with pytest.raises(upgrade.UpgradeError, match="backup_digest_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_in_memory_migration_failure_never_mutates_source(snapshot, monkeypatch):
    path, _ = snapshot
    before = path.read_bytes()
    original = upgrade.scopes.backfill_legacy_production
    def failed(conn, **kwargs):
        original(conn, **kwargs)
        raise sqlite3.DatabaseError("private-injected-error")
    monkeypatch.setattr(upgrade.scopes, "backfill_legacy_production", failed)
    with pytest.raises(upgrade.UpgradeError, match="legacy_chain_validation_failed"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")
    assert path.read_bytes() == before


def test_code_drift_never_certifies_a_stale_plan(snapshot, monkeypatch):
    path, _ = snapshot
    digests = iter(["1" * 64, "2" * 64])
    monkeypatch.setattr(upgrade, "_code_digest", lambda: next(digests))
    with pytest.raises(upgrade.UpgradeError, match="source_or_code_drift_detected"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


@pytest.mark.parametrize("limit,value", [("MAX_JSON_DEPTH", 1), ("MAX_JSON_NODES", 1)])
def test_json_resource_limits_fail_closed(snapshot, monkeypatch, limit, value):
    path, _ = snapshot
    monkeypatch.setattr(upgrade, limit, value)
    with pytest.raises(upgrade.UpgradeError, match="snapshot_json_limit_exceeded"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_nonfinite_sqlite_value_is_not_rounded_or_replaced(snapshot):
    path, _ = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE nav_history SET nav=1e999")
    with pytest.raises(upgrade.UpgradeError, match="unsupported_snapshot_value"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_overflowing_json_number_is_rejected_before_model_coercion(snapshot):
    path, _ = snapshot
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_holding_versions_update")
        conn.execute("UPDATE holding_versions SET payload_json=?", ('{"shares":1e999}',))
        conn.execute("CREATE TRIGGER immutable_holding_versions_update BEFORE UPDATE ON holding_versions BEGIN SELECT RAISE(ABORT, 'holding_versions is immutable'); END")
    with pytest.raises(upgrade.UpgradeError, match="snapshot_json_invalid"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_live_wal_sidecar_is_rejected(snapshot):
    path, _ = snapshot
    Path(str(path) + "-wal").touch()
    with pytest.raises(upgrade.UpgradeError, match="source_live_sidecar_rejected"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")


def test_offline_cli_never_opens_network_or_reads_credential_environment(snapshot, monkeypatch):
    path, _ = snapshot
    def network_forbidden(*args, **kwargs):
        pytest.fail("offline rehearsal must not use network")
    monkeypatch.setattr(socket, "create_connection", network_forbidden)
    monkeypatch.setattr(socket.socket, "connect", network_forbidden)
    monkeypatch.setattr(db, "get_conn", network_forbidden)
    monkeypatch.setattr(db, "init_db", network_forbidden)
    original_get = os._Environ.get
    def safe_get(environ, key, default=None):
        if any(word in key.upper() for word in ("TOKEN", "PASSWORD", "TURSO", "CREDENTIAL")):
            pytest.fail("offline rehearsal must not inspect credentials")
        return original_get(environ, key, default)
    monkeypatch.setattr(os._Environ, "get", safe_get)
    stdout, stderr = StringIO(), StringIO()
    assert cli_module().main(["rehearse", "--source", str(path), "--source-kind", "local-header"],
                             stdout=stdout, stderr=stderr) == 0
    result = json.loads(stdout.getvalue())
    assert result["local_logical_restore_verified"] is True and stderr.getvalue() == ""


@pytest.mark.parametrize("argv", [["apply", "--source", "private-path"], ["plan"],
                                  ["plan", "--source", "private-path", "--source-kind", "private-secret-kind"]])
def test_cli_has_no_apply_and_argument_errors_are_redacted(argv):
    stdout, stderr = StringIO(), StringIO()
    assert cli_module().main(argv, stdout=stdout, stderr=stderr) == 2
    result = json.loads(stderr.getvalue())
    assert result["ok"] is False and result["error"] == "invalid_arguments"
    assert result["evidence_scope"] == "local_turso_schema_migration_rehearsal"
    assert result["formal_release_verified"] is False and result["remote_applied"] is False
    assert stdout.getvalue() == "" and "private" not in stderr.getvalue()


def test_cli_operation_error_is_fixed_and_not_path_or_private_data(tmp_path):
    stdout, stderr = StringIO(), StringIO()
    assert cli_module().main(["rehearse", "--source", str(tmp_path / "private-missing.db"),
                             "--source-kind", "local-header"], stdout=stdout, stderr=stderr) == 1
    result = json.loads(stderr.getvalue())
    assert result["error"] == "source_unavailable" and result["formal_release_verified"] is False
    assert "private" not in stderr.getvalue() and stdout.getvalue() == ""


def test_unknown_upgrade_error_code_is_never_printed_as_private_text():
    assert str(upgrade.UpgradeError("private-secret-marker")) == "rehearsal_failed"
