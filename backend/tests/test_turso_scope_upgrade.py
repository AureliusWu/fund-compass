"""Offline-only schema8 snapshots and failure injection; no cloud evidence."""
import ast
import importlib.util
from io import StringIO
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys

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


OPERATIONAL_COMBINATIONS = (
    (), ("turso_candidate_probe_v1",), ("universe_import_state",),
    ("turso_candidate_probe_v1", "universe_import_state"),
)


def repository_operational_statement(name):
    # Read the trusted producer definitions as data, never import/run a producer
    # or execute a SQLite input's sqlite_master SQL. This catches copy drift in
    # the rehearsal's fixed DDL rather than using the same constant twice.
    source, _ = upgrade._OPERATIONAL_DEFINITIONS[name]
    project = Path(__file__).resolve().parents[2]
    parsed = ast.parse((project / source).read_text(encoding="utf-8"))
    producer = "write_probe" if name == "turso_candidate_probe_v1" else "import_universe_artifact"
    function = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == producer)
    matches = []
    for node in ast.walk(function):
        if not isinstance(node, ast.Call) or not node.args or not isinstance(node.func, ast.Attribute) or node.func.attr != "execute":
            continue
        literal = node.args[0]
        if isinstance(literal, ast.Constant) and isinstance(literal.value, str):
            sql = literal.value
        elif isinstance(literal, ast.JoinedStr):
            parts = []
            for part in literal.values:
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    parts.append(part.value)
                elif (isinstance(part, ast.FormattedValue) and isinstance(part.value, ast.Name)
                      and part.value.id == "PROBE_TABLE" and part.conversion == -1 and part.format_spec is None):
                    parts.append("turso_candidate_probe_v1")
                else:
                    parts = []
                    break
            sql = "".join(parts)
        else:
            continue
        if reformat_ddl(sql).startswith("CREATE TABLE IF NOT EXISTS " + name + " ("):
            matches.append(sql)
    assert len(matches) == 1
    return matches[0]


def reformat_ddl(sql):
    return turso_schema._normalize_ddl(sql)


def install_operational_tables(path, names):
    with sqlite3.connect(path) as conn:
        for name in names:
            conn.execute(repository_operational_statement(name))
        if "turso_candidate_probe_v1" in names:
            # TEXT affinity can legally retain BLOB values. Capture the actual
            # stored types instead of normalizing or judging receipt contents.
            conn.executemany(
                "INSERT INTO turso_candidate_probe_v1(rowid,nonce_sha256,marker_sha256,created_at) VALUES(?,?,?,?)",
                [(-5, "1" * 64, sqlite3.Binary(b"\x00\xffprivate-probe-marker"), ""),
                 (17, sqlite3.Binary(b"private-nonce-blob"), "0", sqlite3.Binary(b"\x01\x00")),
                 (91, "2" * 64, "private-operational-value", "2026-09-01T00:00:00+00:00")],
            )
        if "universe_import_state" in names:
            conn.execute("INSERT INTO universe_import_state VALUES(1,?,0,?)",
                         (sqlite3.Binary(b"private-universe-digest"), ""))


def operational_rows(conn, names):
    result = {name: [tuple(row) for row in conn.execute(f'SELECT rowid,* FROM "{name}" ORDER BY rowid')]
              for name in names}
    result["sqlite_sequence"] = [tuple(row) for row in conn.execute("SELECT rowid,name,seq FROM sqlite_sequence ORDER BY rowid")]
    return result


@pytest.mark.parametrize("kind", ["local-header", "remote-schema-table"])
@pytest.mark.parametrize("names", OPERATIONAL_COMBINATIONS)
def test_explicit_operational_profile_preserves_all_rows_types_rowids_and_restore(snapshot, monkeypatch, kind, names):
    path, _ = remote_snapshot(snapshot) if kind == "remote-schema-table" else snapshot
    install_operational_tables(path, names)
    before = path.read_bytes()
    with sqlite3.connect(path) as conn:
        expected = operational_rows(conn, names)
        objects_before = upgrade._objects(conn)
    original = upgrade._scope_upgrade
    captured = []
    def observed(conn, source_kind, budget):
        captured.append(operational_rows(conn, names))
        original(conn, source_kind, budget)
        captured.append(operational_rows(conn, names))
    monkeypatch.setattr(upgrade, "_scope_upgrade", observed)
    plan = upgrade.rehearse_snapshot(path, source_kind=kind, restore=False,
                                    operational_profile="known-operational-v1")
    result = upgrade.rehearse_snapshot(path, source_kind=kind, operational_profile="known-operational-v1",
                                      expected_plan_sha256=plan["plan_sha256"],
                                      expected_backup_sha256=plan["logical_backup_sha256"])
    assert captured and all(rows == expected for rows in captured)
    assert result["operational_profile"] == "known-operational-v1"
    assert result["operational_definitions_sha256"] == upgrade._operational_definitions_digest()
    assert result["source_contract_sha256"] == upgrade._contract_digest(objects_before)
    assert result["source_rows_sha256"] == plan["source_rows_sha256"]
    assert result["target_rows_sha256"] == plan["target_rows_sha256"]
    assert result["table_count"] == sum(kind == "table" for kind, _ in objects_before)
    assert result["local_logical_restore_verified"] and result["legacy_rows_unchanged"]
    assert result["source_file_unchanged"] and not result["remote_applied"]
    assert not result["remote_restore_verified"] and not result["formal_release_verified"]
    assert path.read_bytes() == before
    emitted = json.dumps(result)
    assert all(value not in emitted for value in (str(path), "private-probe", "private-universe", "private-operational"))


@pytest.mark.parametrize("names", OPERATIONAL_COMBINATIONS[1:])
def test_default_core_profile_does_not_silently_allow_operational_tables(snapshot, names):
    path, _ = snapshot
    install_operational_tables(path, names)
    before = path.read_bytes()
    with pytest.raises(upgrade.UpgradeError, match="source_schema_contract_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header")
    assert path.read_bytes() == before


@pytest.mark.parametrize("name", sorted(upgrade._OPERATIONAL_DEFINITIONS))
def test_operational_contract_matches_its_current_repository_producer(name):
    actual = sqlite3.connect(":memory:")
    reference = sqlite3.connect(":memory:")
    try:
        actual.execute(repository_operational_statement(name))
        reference.execute(upgrade._OPERATIONAL_DEFINITIONS[name][1])
        assert upgrade._contract_digest(upgrade._objects(actual)) == upgrade._contract_digest(upgrade._objects(reference))
        assert list(actual.execute(f'PRAGMA table_info("{name}")')) == list(reference.execute(f'PRAGMA table_info("{name}")'))
    finally:
        actual.close()
        reference.close()


@pytest.mark.parametrize("name,old,new", [
    ("turso_candidate_probe_v1", "PRIMARY KEY NOT NULL", "PRIMARY KEY"),
    ("turso_candidate_probe_v1", "marker_sha256 TEXT NOT NULL", "marker_sha256 BLOB NOT NULL"),
    ("turso_candidate_probe_v1", "created_at TEXT NOT NULL", "created_at TEXT"),
    ("universe_import_state", "CHECK(singleton_id = 1)", "CHECK(singleton_id = 2)"),
    ("universe_import_state", "CHECK(fund_count >= 0)", "CHECK(fund_count >= -1)"),
    ("universe_import_state", "sha256 TEXT NOT NULL", "sha256 TEXT"),
])
def test_known_operational_name_does_not_allow_changed_ddl(snapshot, name, old, new):
    path, _ = snapshot
    sql = repository_operational_statement(name)
    assert old in sql
    with sqlite3.connect(path) as conn:
        conn.execute(sql.replace(old, new))
    before = path.read_bytes()
    with pytest.raises(upgrade.UpgradeError, match="source_schema_contract_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile="known-operational-v1")
    assert path.read_bytes() == before


@pytest.mark.parametrize("sql", [
    "CREATE TABLE turso_candidate_probe_v2(secret TEXT)",
    "CREATE TABLE turso_candidate_probe_v1_backup(secret TEXT)",
    "CREATE TABLE universe_import_state_backup(secret TEXT)",
    "CREATE TABLE private_operational_extra(secret TEXT)",
    "CREATE INDEX private_extra_probe_index ON turso_candidate_probe_v1(marker_sha256)",
    "CREATE TRIGGER private_probe_trigger AFTER INSERT ON turso_candidate_probe_v1 BEGIN SELECT 1; END",
    "CREATE VIEW private_operational_view AS SELECT * FROM universe_import_state",
    "ALTER TABLE universe_import_state ADD COLUMN private_extra TEXT",
])
def test_operational_profile_still_rejects_every_other_object(snapshot, sql):
    path, _ = snapshot
    install_operational_tables(path, OPERATIONAL_COMBINATIONS[-1])
    with sqlite3.connect(path) as conn:
        conn.execute(sql)
    before = path.read_bytes()
    with pytest.raises(upgrade.UpgradeError, match="source_schema_contract_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile="known-operational-v1")
    assert path.read_bytes() == before


def test_operational_profile_retains_optimizer_statistics(snapshot):
    path, _ = snapshot
    install_operational_tables(path, OPERATIONAL_COMBINATIONS[-1])
    with sqlite3.connect(path) as conn:
        conn.execute("ANALYZE")
    before = path.read_bytes()
    result = upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile="known-operational-v1")
    assert result["local_logical_restore_verified"] and result["legacy_rows_unchanged"]
    assert path.read_bytes() == before


def test_profile_is_bound_even_when_no_operational_tables_are_present(snapshot):
    path, _ = snapshot
    core = upgrade.rehearse_snapshot(path, source_kind="local-header", restore=False)
    operational = upgrade.rehearse_snapshot(path, source_kind="local-header", restore=False,
                                           operational_profile="known-operational-v1")
    assert core["operational_profile"] == "core-only"
    assert core["source_contract_sha256"] == operational["source_contract_sha256"]
    assert core["plan_sha256"] != operational["plan_sha256"]
    with pytest.raises(upgrade.UpgradeError, match="plan_binding_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile="known-operational-v1",
                                 expected_plan_sha256=core["plan_sha256"])


def test_old_plan_without_profile_and_definition_binding_is_rejected(snapshot):
    path, _ = snapshot
    plan = upgrade.rehearse_snapshot(path, source_kind="local-header", restore=False)
    old_keys = ("source_kind", "source_file_sha256", "source_contract_sha256", "source_rows_sha256",
                "logical_backup_sha256", "target_contract_sha256", "target_rows_sha256", "code_sha256")
    old_digest = upgrade._digest(upgrade._json_bytes({key: plan[key] for key in old_keys}))
    with pytest.raises(upgrade.UpgradeError, match="plan_binding_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", expected_plan_sha256=old_digest)


@pytest.mark.parametrize("source", ["backend/service/repo.py", "tools/turso_candidate.py"])
def test_producer_code_is_bound_without_importing_or_modifying_it(snapshot, monkeypatch, source):
    path, _ = snapshot
    plan = upgrade.rehearse_snapshot(path, source_kind="local-header", restore=False)
    project = Path(__file__).resolve().parents[2]
    selected = project / source
    original = Path.read_bytes
    reads = []
    def altered_bytes(value):
        reads.append(value)
        data = original(value)
        return data + b"\n# synthetic source drift\n" if value == selected else data
    monkeypatch.setattr(Path, "read_bytes", altered_bytes)
    assert upgrade._code_digest() != plan["code_sha256"]
    assert upgrade._operational_definitions_digest() != plan["operational_definitions_sha256"]
    with pytest.raises(upgrade.UpgradeError, match="plan_binding_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", expected_plan_sha256=plan["plan_sha256"])
    assert selected in reads


def test_operational_data_drift_invalidates_plan(snapshot):
    path, _ = snapshot
    install_operational_tables(path, OPERATIONAL_COMBINATIONS[-1])
    plan = upgrade.rehearse_snapshot(path, source_kind="local-header", restore=False,
                                    operational_profile="known-operational-v1")
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE universe_import_state SET sha256=?", ("changed-private-universe",))
    with pytest.raises(upgrade.UpgradeError, match="plan_binding_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile="known-operational-v1",
                                 expected_plan_sha256=plan["plan_sha256"])


@pytest.mark.parametrize("tamper", ["rowid", "type", "payload"])
def test_operational_backup_restore_drift_never_certifies(snapshot, monkeypatch, tamper):
    path, _ = snapshot
    install_operational_tables(path, OPERATIONAL_COMBINATIONS[-1])
    before = path.read_bytes()
    original = upgrade._restore_image
    def corrupt(image, expected, budget):
        conn = original(image, expected, budget)
        if tamper == "rowid":
            conn.execute("UPDATE turso_candidate_probe_v1 SET rowid=999 WHERE rowid=91")
        elif tamper == "type":
            conn.execute("UPDATE turso_candidate_probe_v1 SET marker_sha256=? WHERE rowid=17", (sqlite3.Binary(b"0"),))
        else:
            conn.execute("UPDATE universe_import_state SET sha256='changed-private-payload'")
        conn.commit()
        return conn
    monkeypatch.setattr(upgrade, "_restore_image", corrupt)
    with pytest.raises(upgrade.UpgradeError, match="restored_source_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile="known-operational-v1")
    assert path.read_bytes() == before


def test_operational_restore_target_drift_never_certifies(snapshot, monkeypatch):
    path, _ = snapshot
    install_operational_tables(path, OPERATIONAL_COMBINATIONS[-1])
    before = path.read_bytes()
    original = upgrade._scope_upgrade
    calls = 0
    def drift(conn, source_kind, budget):
        nonlocal calls
        calls += 1
        original(conn, source_kind, budget)
        if calls == 2:
            conn.execute("UPDATE turso_candidate_probe_v1 SET rowid=123 WHERE rowid=91")
            conn.commit()
    monkeypatch.setattr(upgrade, "_scope_upgrade", drift)
    with pytest.raises(upgrade.UpgradeError, match="restored_target_mismatch"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile="known-operational-v1")
    assert path.read_bytes() == before


@pytest.mark.parametrize("value", [None, True, "known-operational-v2", "turso_candidate_probe"])
def test_invalid_operational_profile_fails_closed(snapshot, value):
    path, _ = snapshot
    with pytest.raises(upgrade.UpgradeError, match="invalid_arguments"):
        upgrade.rehearse_snapshot(path, source_kind="local-header", operational_profile=value)


def test_real_cli_operational_plan_and_rehearsal_bind_without_credentials(snapshot, tmp_path):
    path, _ = remote_snapshot(snapshot)
    install_operational_tables(path, OPERATIONAL_COMBINATIONS[-1])
    before = path.read_bytes()
    script = Path(__file__).resolve().parents[2] / "tools/turso_scope_upgrade.py"
    env = {"PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1", "FUND_DB_BACKEND": "sqlite",
           "FUND_DB": str(tmp_path / "unused-configured.db"), "FUND_DB_PERSISTENCE": "ephemeral"}
    if sys.platform == "win32":
        env["SystemRoot"] = os.environ.get("SystemRoot", "C:\\Windows")
    def run(command, *extra):
        return subprocess.run([sys.executable, str(script), command, "--source", str(path),
                               "--source-kind", "remote-schema-table", *extra], env=env,
                              capture_output=True, text=True, encoding="utf-8", timeout=30)
    refused = run("plan")
    assert refused.returncode == 1 and json.loads(refused.stderr)["error"] == "source_schema_contract_mismatch"
    planned = run("plan", "--operational-profile", "known-operational-v1")
    assert planned.returncode == 0 and not planned.stderr
    plan = json.loads(planned.stdout)
    restored = run("rehearse", "--operational-profile", "known-operational-v1",
                   "--expected-plan-sha256", plan["plan_sha256"],
                   "--expected-backup-sha256", plan["logical_backup_sha256"])
    assert restored.returncode == 0 and not restored.stderr
    result = json.loads(restored.stdout)
    assert result["plan_sha256"] == plan["plan_sha256"] and result["operational_profile"] == "known-operational-v1"
    assert result["local_logical_restore_verified"] and not result["remote_applied"]
    assert not result["formal_release_verified"] and not result["remote_restore_verified"]
    assert path.read_bytes() == before and not (tmp_path / "unused-configured.db").exists()
    assert all(value not in planned.stdout + restored.stdout + refused.stderr for value in
               (str(path), "private-probe", "private-universe", "private-operational", "TURSO_AUTH_TOKEN"))


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


@pytest.mark.parametrize("operational", [False, True])
def test_offline_cli_never_opens_network_or_reads_credential_environment(snapshot, monkeypatch, operational):
    path, _ = snapshot
    if operational:
        install_operational_tables(path, OPERATIONAL_COMBINATIONS[-1])
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
    argv = ["rehearse", "--source", str(path), "--source-kind", "local-header"]
    if operational:
        argv.extend(["--operational-profile", "known-operational-v1"])
    assert cli_module().main(argv,
                             stdout=stdout, stderr=stderr) == 0
    result = json.loads(stdout.getvalue())
    assert result["local_logical_restore_verified"] is True and stderr.getvalue() == ""


@pytest.mark.parametrize("argv", [["apply", "--source", "private-path"], ["plan"],
                                  ["plan", "--source", "private-path", "--source-kind", "private-secret-kind"],
                                  ["plan", "--source", "private-path", "--source-kind", "local-header",
                                   "--operational-profile", "private-secret-profile"]])
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
