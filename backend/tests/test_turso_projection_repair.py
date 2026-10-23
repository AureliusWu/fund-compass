"""New synthetic SQLite only; no cloud, credential or production evidence."""
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import sqlite3

import pytest

from database import db, turso_schema, turso_scope_upgrade as offline, turso_projection_repair as repair
from models.v8 import canonical_json, stable_id
from service import v8_repo
from strategy.decision_v2 import build_decision_snapshot
from test_acceptance_write_boundary import business_chain, configure, save_chain
from test_repository_scopes import drop_scope_contract
from test_turso_scope_upgrade import install_operational_tables, OPERATIONAL_COMBINATIONS


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mutate(path, table, statement, args=()):
    """Corrupt only this test's newly created synthetic source, keeping DDL."""
    with sqlite3.connect(path) as conn:
        conn.execute(f"DROP TRIGGER immutable_{table}_update")
        conn.execute(statement, args)
        conn.execute(f"CREATE TRIGGER immutable_{table}_update BEFORE UPDATE ON {table} "
                     f"BEGIN SELECT RAISE(ABORT, '{table} is immutable'); END")


@pytest.fixture
def source(tmp_path, monkeypatch, request):
    path = tmp_path / "private-synthetic-source.db"
    configure(path, monkeypatch)
    db.init_db()
    chain = business_chain()
    settings = {"estimate": 0.1, "estimate_coverage": 61.3, **getattr(request, "param", {})}
    evidence = chain["evidence"].model_copy(update=settings)
    evidence = evidence.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(evidence))})
    chain["evidence"] = evidence
    chain["decision"] = build_decision_snapshot(evidence, chain["holding"], chain["policy"],
                                                  strategy_version="business-v1", created_at=evidence.created_at)
    save_chain(chain)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO funds(code,name,type,pinyin) VALUES('000001','private-source-marker','mixed',NULL)")
        drop_scope_contract(conn)
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        assert conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete"
    return path, chain


def corrupt_floats(source, *, fields=repair.REPAIR_COLUMNS, steps=1, direction=math.inf):
    path, chain = source
    for field in fields:
        value = getattr(chain["evidence"], field)
        for _ in range(steps):
            value = math.nextafter(value, direction)
        mutate(path, "evidence_snapshots", f"UPDATE evidence_snapshots SET {field}=?", (value,))
    return path


def plan(path, **kwargs):
    return repair.plan_projection_repair(path, source_kind="local-header", expected_source_sha256=digest(path), **kwargs)


def test_strict_old_path_still_refuses_and_explicit_repair_recovery_preserves_original(source, monkeypatch, capsys):
    path = corrupt_floats(source)
    before = path.read_bytes()
    with pytest.raises(offline.UpgradeError, match="legacy_chain_validation_failed"):
        offline.rehearse_snapshot(path, source_kind="local-header", restore=False)
    calls, originals = [], []
    strict, restore = offline._scope_upgrade, offline._restore_image
    def observed(conn, kind, budget):
        calls.append(tuple(conn.execute("SELECT estimate,estimate_coverage FROM evidence_snapshots").fetchone()))
        strict(conn, kind, budget)
    def observed_restore(image, expected, budget):
        conn = restore(image, expected, budget)
        originals.append((conn.execute("PRAGMA user_version").fetchone()[0],
                          tuple(conn.execute("SELECT rowid,estimate,estimate_coverage FROM evidence_snapshots").fetchone())))
        return conn
    monkeypatch.setattr(offline, "_scope_upgrade", observed)
    monkeypatch.setattr(offline, "_restore_image", observed_restore)
    planned = plan(path)
    result = repair.rehearse_projection_repair(path, source_kind="local-header", expected_source_sha256=digest(path),
                                               expected_repair_sha256=planned["repair_sha256"])
    assert len(calls) == 3 and all(row == (0.1, 61.3) for row in calls)
    assert originals == [(8, (1, math.nextafter(0.1, math.inf), math.nextafter(61.3, math.inf)))]
    assert result["repair_sha256"] == planned["repair_sha256"]
    assert result["repair_delta_sha256"] == planned["repair_delta_sha256"]
    assert result["source_rows_sha256"] != result["repaired_rows_sha256"]
    assert result["repaired_cell_count"] == 2 and result["repaired_row_count"] == 1
    assert result["estimate_repaired_cell_count"] == result["estimate_coverage_repaired_cell_count"] == 1
    assert not planned["local_original_recovery_verified"] and result["local_original_recovery_verified"]
    assert result["source_file_unchanged"] and result["immutable_payloads_ids_hashes_unchanged"]
    assert result["only_declared_projection_cells_changed"] and not result["legacy_rows_unchanged"]
    assert result["repository_roots_readback_verified"]
    assert all(result[key] is False for key in ("remote_verified", "remote_applied", "remote_restore_verified",
                                                "formal_release_verified", "remote_write_attempted"))
    assert path.read_bytes() == before and capsys.readouterr() == ("", "")
    emitted = json.dumps(result)
    assert all(secret not in emitted for secret in (str(path), source[1]["evidence"].evidence_id,
                                                   source[1]["holding"].holding_version, "61.3", "0.100000"))
    with pytest.raises(offline.UpgradeError, match="legacy_chain_validation_failed"):
        offline.rehearse_snapshot(path, source_kind="local-header", restore=False)


@pytest.mark.parametrize("kind", ["local-header", "remote-schema-table"])
@pytest.mark.parametrize("names", OPERATIONAL_COMBINATIONS)
def test_profiles_rowids_operational_native_types_and_complete_preimage_retained(source, monkeypatch, kind, names):
    path = corrupt_floats(source, fields=("estimate",), direction=-math.inf)
    install_operational_tables(path, names)
    if kind == "remote-schema-table":
        with sqlite3.connect(path) as conn:
            conn.execute(turso_schema.VERSION_DDL)
            conn.execute("INSERT INTO _schema_version VALUES(1,8)")
            conn.execute("PRAGMA user_version=0")
    before = path.read_bytes()
    expected_rows = []
    original_snapshot = offline._snapshot_rows
    def observed(conn, objects, budget):
        records = original_snapshot(conn, objects, budget)
        expected_rows.append((conn.execute("PRAGMA user_version").fetchone()[0], records))
        return records
    monkeypatch.setattr(offline, "_snapshot_rows", observed)
    planned = repair.plan_projection_repair(path, source_kind=kind, expected_source_sha256=digest(path),
                                            operational_profile="known-operational-v1")
    result = repair.rehearse_projection_repair(path, source_kind=kind, expected_source_sha256=digest(path),
                                               expected_repair_sha256=planned["repair_sha256"],
                                               operational_profile="known-operational-v1")
    original_records = expected_rows[0][1]
    recovered_originals = [records for version, records in expected_rows[1:]
                          if version == expected_rows[0][0] and offline._rows_digest(records) == result["source_rows_sha256"]]
    assert recovered_originals and all(records == original_records for records in recovered_originals)
    assert result["local_original_recovery_verified"] and path.read_bytes() == before
    assert result["source_file_sha256"] == digest(path)


def test_zero_changes_are_not_a_repair(source):
    with pytest.raises(repair.ProjectionRepairError, match="repair_not_needed"):
        plan(source[0])


@pytest.mark.parametrize("source", [{"estimate": -0.1, "estimate_coverage": None}], indirect=True)
def test_negative_adjacent_ulp_repaired_and_other_null_preserved(source, monkeypatch):
    path = corrupt_floats(source, fields=("estimate",), direction=-math.inf)
    original = offline._scope_upgrade
    rows = []
    def observed(conn, kind, budget):
        rows.append(tuple(conn.execute("SELECT estimate,estimate_coverage FROM evidence_snapshots").fetchone()))
        original(conn, kind, budget)
    monkeypatch.setattr(offline, "_scope_upgrade", observed)
    planned = plan(path)
    assert planned["repaired_cell_count"] == 1 and rows == [(-0.1, None)]


@pytest.mark.parametrize("source", [{"estimate": 0.0}], indirect=True)
def test_payload_negative_zero_is_not_hidden_by_canonical_zero_normalization(source):
    path = corrupt_floats(source, fields=("estimate_coverage",))
    with sqlite3.connect(path) as conn:
        raw = conn.execute("SELECT payload_json FROM evidence_snapshots").fetchone()[0]
    assert '"estimate":0.0' in raw
    raw = raw.replace('"estimate":0.0', '"estimate":-0.0')
    mutate(path, "evidence_snapshots", "UPDATE evidence_snapshots SET payload_json=?", (raw,))
    with pytest.raises(repair.ProjectionRepairError, match="repair_difference_invalid"):
        plan(path)


@pytest.mark.parametrize("steps", [2, 4, 17, 1025])
def test_more_than_one_ulp_is_not_repairable(source, steps):
    path = corrupt_floats(source, steps=steps)
    before = path.read_bytes()
    with pytest.raises(repair.ProjectionRepairError, match="repair_difference_invalid"):
        plan(path)
    assert path.read_bytes() == before


@pytest.mark.parametrize("value", [None, "private-text", sqlite3.Binary(b"private-blob"), math.inf, -math.inf])
def test_null_type_nonfinite_projection_is_never_normalized(source, value):
    path = corrupt_floats(source, fields=("estimate_coverage",))
    mutate(path, "evidence_snapshots", "UPDATE evidence_snapshots SET estimate=?", (value,))
    before = path.read_bytes()
    with pytest.raises(repair.ProjectionRepairError):
        plan(path)
    assert path.read_bytes() == before


@pytest.mark.parametrize("before,after", [(1.0, 1), (True, 1.0), (None, 0.0), (0.0, None),
                                        (-0.0, 0.0), (0.0, -0.0), (math.inf, 1.0), (math.nan, 1.0)])
def test_exact_primitive_admission_no_bool_null_zero_sign_coercion(before, after):
    # SQLite REAL affinity itself coalesces some values; test the admission
    # primitive directly so its native-type/zero-sign promises are exercised.
    if type(before) is not float or not math.isfinite(before) or (before == 0 and math.copysign(1, before) < 0):
        with pytest.raises(repair.ProjectionRepairError):
            repair._real_bits(before)
    if type(after) is not float or not math.isfinite(after) or (after == 0 and math.copysign(1, after) < 0):
        with pytest.raises(repair.ProjectionRepairError):
            repair._real_bits(after)


@pytest.mark.parametrize("table,column,value", [("holding_versions", "shares", 999.0),
    ("portfolio_policy_versions", "max_single_fund_weight", 39.0),
    ("decision_snapshots", "confidence", 1), ("source_health_events", "observed_at", "2026-01-01T00:00:00+00:00")])
def test_other_root_or_derived_projection_corruption_still_refuses_whole_repair(source, table, column, value):
    path = corrupt_floats(source)
    mutate(path, table, f"UPDATE {table} SET {column}=?", (value,))
    before = path.read_bytes()
    with pytest.raises(repair.ProjectionRepairError):
        plan(path)
    assert path.read_bytes() == before


@pytest.mark.parametrize("tamper", ["unknown", "duplicate", "reserved", "identity", "hash", "other_projection", "json"])
def test_payload_identity_hash_and_other_evidence_projection_are_immutable_admission(source, tamper):
    path = corrupt_floats(source)
    with sqlite3.connect(path) as conn:
        raw = conn.execute("SELECT payload_json FROM evidence_snapshots").fetchone()[0]
    payload = json.loads(raw)
    if tamper == "hash":
        mutate(path, "evidence_snapshots", "UPDATE evidence_snapshots SET payload_sha256='private-invalid-hash'")
    elif tamper == "other_projection":
        mutate(path, "evidence_snapshots", "UPDATE evidence_snapshots SET score=1")
    else:
        if tamper == "unknown":
            payload["unknown_private_field"] = "private-value"
        elif tamper == "reserved":
            payload["score_version"] = "local-acceptance-v1"
        elif tamper == "identity":
            payload["evidence_id"] = "private-changed-id"
        raw = canonical_json(payload)
        if tamper == "duplicate":
            raw = '{"estimate":0.1,' + raw[1:]
        elif tamper == "json":
            raw = "private-not-json"
        mutate(path, "evidence_snapshots", "UPDATE evidence_snapshots SET payload_json=?", (raw,))
    before = path.read_bytes()
    with pytest.raises(repair.ProjectionRepairError) as caught:
        plan(path)
    assert str(caught.value) in repair.ERROR_CODES and "private" not in str(caught.value)
    assert path.read_bytes() == before


def test_wrong_source_and_wrong_plan_pin_fail_closed(source):
    path = corrupt_floats(source)
    with pytest.raises(repair.ProjectionRepairError, match="source_binding_mismatch"):
        repair.plan_projection_repair(path, source_kind="local-header", expected_source_sha256="0" * 64)
    with pytest.raises(repair.ProjectionRepairError, match="repair_binding_mismatch"):
        repair.rehearse_projection_repair(path, source_kind="local-header", expected_source_sha256=digest(path),
                                          expected_repair_sha256="0" * 64)


@pytest.mark.parametrize("tamper", ["rowid", "value", "header"])
def test_independent_original_restore_must_match_complete_preimage(source, monkeypatch, tamper):
    path = corrupt_floats(source)
    planned = plan(path)
    original = offline._restore_image
    def damaged(image, expected, budget):
        conn = original(image, expected, budget)
        if tamper == "header":
            conn.execute("PRAGMA user_version=7")
        else:
            conn.execute("UPDATE funds SET name='private-corruption'") if tamper == "value" else conn.execute("INSERT INTO funds(rowid,code) VALUES(987,'private-extra')")
            conn.commit()
        return conn
    monkeypatch.setattr(offline, "_restore_image", damaged)
    with pytest.raises(repair.ProjectionRepairError, match="restored_source_mismatch"):
        repair.rehearse_projection_repair(path, source_kind="local-header", expected_source_sha256=digest(path),
                                          expected_repair_sha256=planned["repair_sha256"])


def test_restored_strict_target_cannot_drift(source, monkeypatch):
    path = corrupt_floats(source)
    planned = plan(path)
    original = offline._scope_upgrade
    calls = 0
    def drift(conn, kind, budget):
        nonlocal calls
        calls += 1
        original(conn, kind, budget)
        if calls == 2:
            conn.execute("INSERT INTO funds(code) VALUES('private-extra')")
            conn.commit()
    monkeypatch.setattr(offline, "_scope_upgrade", drift)
    with pytest.raises(repair.ProjectionRepairError, match="legacy_rows_changed|restored_target_mismatch"):
        repair.rehearse_projection_repair(path, source_kind="local-header", expected_source_sha256=digest(path),
                                          expected_repair_sha256=planned["repair_sha256"])


def test_no_network_credentials_runtime_initialization_or_source_write(source, monkeypatch):
    path = corrupt_floats(source)
    before = path.read_bytes()
    def forbidden(*args, **kwargs):
        pytest.fail("local repair must not use configured DB or network")
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "init_db", forbidden)
    original_get, original_connect = os._Environ.get, sqlite3.connect
    def checked_get(env, key, default=None):
        if any(word in key.upper() for word in ("TOKEN", "TURSO", "PASSWORD", "CREDENTIAL")):
            pytest.fail("credential environment read forbidden")
        return original_get(env, key, default)
    def checked_connect(database, *args, **kwargs):
        assert database == ":memory:" or (str(database).startswith(path.as_uri())
                                           and str(database).endswith("?mode=ro&immutable=1") and kwargs.get("uri") is True)
        return original_connect(database, *args, **kwargs)
    monkeypatch.setattr(os._Environ, "get", checked_get)
    monkeypatch.setattr(sqlite3, "connect", checked_connect)
    planned = plan(path)
    result = repair.rehearse_projection_repair(path, source_kind="local-header", expected_source_sha256=digest(path),
                                               expected_repair_sha256=planned["repair_sha256"])
    assert result["local_original_recovery_verified"] and path.read_bytes() == before


@pytest.mark.parametrize("argument,value", [("source_kind", "private-unknown"), ("source_kind", True),
    ("operational_profile", "private-unknown"), ("expected_source_sha256", None),
    ("expected_source_sha256", True), ("expected_source_sha256", "private-secret")])
def test_closed_argument_errors(source, argument, value):
    kwargs = dict(source_kind="local-header", expected_source_sha256=digest(source[0]))
    kwargs[argument] = value
    with pytest.raises(repair.ProjectionRepairError) as caught:
        repair.plan_projection_repair(source[0], **kwargs)
    assert str(caught.value) in {"invalid_arguments", "invalid_expected_digest"}


def test_expired_budget_refuses(source, monkeypatch):
    path = corrupt_floats(source)
    monkeypatch.setattr(repair, "TIME_BUDGET_SECONDS", -1)
    with pytest.raises(repair.ProjectionRepairError, match="rehearsal_time_limit"):
        plan(path)


def test_source_drift_during_read_is_not_certified(source, monkeypatch):
    path = corrupt_floats(source)
    original = offline._snapshot_rows
    changed = False
    def drift(conn, objects, budget):
        nonlocal changed
        records = original(conn, objects, budget)
        if not changed:
            changed = True
            with sqlite3.connect(path) as writer:
                writer.execute("UPDATE funds SET name='private-concurrent-change'")
        return records
    monkeypatch.setattr(offline, "_snapshot_rows", drift)
    with pytest.raises(repair.ProjectionRepairError, match="source_drift_detected"):
        plan(path)


def test_loaded_contract_binding_drift_is_not_certified(source, monkeypatch):
    path = corrupt_floats(source)
    values = iter(("1" * 64, "2" * 64))
    monkeypatch.setattr(repair, "_code_digest", lambda: next(values))
    with pytest.raises(repair.ProjectionRepairError, match="source_or_code_drift_detected"):
        plan(path)


def test_live_sidecar_rejects_before_immutable_open(source):
    path = corrupt_floats(source)
    Path(str(path) + "-wal").touch()
    with pytest.raises(repair.ProjectionRepairError, match="source_live_sidecar_rejected"):
        plan(path)


def test_fixed_schema_no_unknown_or_weakened_trigger_admission(source):
    path = corrupt_floats(source)
    with sqlite3.connect(path) as conn:
        conn.execute("DROP TRIGGER immutable_evidence_snapshots_update")
    before = path.read_bytes()
    with pytest.raises(repair.ProjectionRepairError, match="source_schema_contract_mismatch"):
        plan(path)
    assert path.read_bytes() == before


@pytest.mark.parametrize("source", [
    r"\\server\share\snapshot.db", "//server/share/snapshot.db",
    r"\\?\UNC\server\share\snapshot.db", "//?/UNC/server/share/snapshot.db",
    r"\\.\C:\snapshot.db", "//./C:/snapshot.db", r"\\?\C:\snapshot.db",
    r"\??\C:\snapshot.db", r"\Device\HarddiskVolume1\snapshot.db",
    r"\GLOBAL??\C:\snapshot.db", r"\DosDevices\C:\snapshot.db",
    "/??/UNC/server/share/snapshot.db", "/Device/HarddiskVolume1/snapshot.db",
    "C:snapshot.db", "C:", "C:../snapshot.db", r"\rooted-without-drive.db",
    "snapshot.db", r"C:\NUL", r"D:\dir\CON.db", b"C:/snapshot.db", None, True,
])
def test_nonlocal_or_device_names_rejected_before_any_filesystem_or_sqlite(source, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("nonlocal lexical rejection must precede filesystem/SQLite access")
    monkeypatch.setattr(Path, "absolute", forbidden)
    monkeypatch.setattr(Path, "lstat", forbidden)
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    with pytest.raises(repair.ProjectionRepairError) as caught:
        repair.plan_projection_repair(source, source_kind="local-header", expected_source_sha256="0" * 64)
    assert str(caught.value) in {"source_link_rejected", "source_unavailable"}


@pytest.mark.parametrize("source", ["/NUL", "/dir/CON.db", "/snapshot.db"])
def test_windows_current_drive_rooted_path_is_not_a_local_absolute_snapshot(source, monkeypatch):
    monkeypatch.setattr(repair, "_WINDOWS_PATHS", True)
    def forbidden(*args, **kwargs):
        pytest.fail("Windows rooted/device rejection must precede filesystem/SQLite")
    monkeypatch.setattr(Path, "absolute", forbidden)
    monkeypatch.setattr(Path, "lstat", forbidden)
    monkeypatch.setattr(sqlite3, "connect", forbidden)
    with pytest.raises(repair.ProjectionRepairError, match="source_link_rejected"):
        repair.plan_projection_repair(source, source_kind="local-header", expected_source_sha256="0" * 64)


def test_error_never_accepts_unlisted_private_text():
    assert str(repair.ProjectionRepairError("private-secret")) == "projection_repair_failed"
