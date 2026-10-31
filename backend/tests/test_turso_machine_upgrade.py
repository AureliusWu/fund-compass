"""Owned-memory-only schema9 extension, not remote apply or restore proof."""
from contextlib import closing
from dataclasses import replace
import hashlib
import json
import math
import sqlite3

import pytest

from database import db, turso_schema, turso_machine_profile as profile
from database import turso_machine_upgrade as upgrade
from service import owner_sync_repo as sync
from test_owner_sync_repo import create_candidate

RESOURCE = "a" * 64
STAMP = "2026-10-30T00:00:00Z"


def source(*, header=8, optional=()):
    conn = create_candidate()
    conn.row_factory = sqlite3.Row
    conn.execute(turso_schema.VERSION_DDL)
    conn.execute("INSERT INTO _schema_version VALUES(1,9)")
    conn.execute("INSERT INTO v8_repository_scopes VALUES('production','production',NULL)")
    conn.execute("INSERT INTO funds(code,name,pinyin) VALUES('000001',?,?)", ("synthetic\x00tail", b"synthetic\x00blob"))
    conn.execute("INSERT INTO fund_detail(code,name,scale,latest_nav) VALUES('000001','synthetic',?,NULL)", (0.1,))
    conn.execute("INSERT INTO idempotency_responses VALUES('original-8-to-9','reserved:old','old','complete','{}',NULL,NULL,?,?)", (STAMP, STAMP))
    conn.commit()
    result = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-upgrade-source-0001", "expected_revision": 0,
        "operations": [{"key": "000001::zero", "kind": "holding", "deleted": False,
            "changes": {"name": "synthetic", "shares": 0, "cost": None, "target_weight": None}},
            {"key": "asset:cash", "kind": "manual_asset", "deleted": False,
             "changes": {"name": "synthetic cash", "cls": "现金", "value": 0, "note": None}}]}))
    assert result.status == 200
    for name in optional:
        conn.execute("ANALYZE" if name == "sqlite_stat1" else profile._OPERATIONAL[name])
    conn.commit()
    conn.execute(f"PRAGMA user_version={header}")
    conn.execute("PRAGMA query_only=ON")
    return conn


def compile(conn):
    return upgrade.compile_machine_upgrade(conn, expected_source_image_sha256=hashlib.sha256(conn.serialize()).hexdigest(),
        expected_resource_sha256=RESOURCE, created_at=STAMP)


def execute(conn, packet):
    for label, sql, args, rows, _ in packet.statement_specs:
        if label == "rollback":
            continue
        cursor = conn.execute(sql, args)
        if rows:
            assert [tuple(row) for row in cursor] == [(1,)]


@pytest.mark.parametrize("header", [0, 8, 9])
@pytest.mark.parametrize("optional", [(), ("sqlite_stat1", "universe_import_state"), ("turso_candidate_probe_v1",)])
def test_fixed_extension_preserves_every_old_typed_row_and_header_with_immutable_receipt(header, optional, monkeypatch):
    with closing(source(header=header, optional=optional)) as conn:
        original = conn.serialize()
        def forbidden(*args, **kwargs):
            pytest.fail("compiler used configured/global database or network")
        monkeypatch.setattr(db, "get_conn", forbidden)
        monkeypatch.setattr(db, "init_db", forbidden)
        packet = compile(conn)
        assert conn.serialize() == original
        safe = packet.safe_metadata
        assert safe["legacy_rows_unchanged"] and safe["source_user_version"] == header
        assert safe["object_count"] == profile.machine_profile_manifest(optional).object_count <= 128
        assert safe["target_row_count"] == safe["source_row_count"] + 3
        assert not any(safe[key] for key in upgrade._FLAGS)
        assert all(type(value) is not float for spec in packet.statement_specs for value in spec[2])
        assert upgrade.rehearse_machine_upgrade(packet)["rehearsed"]
        assert conn.serialize() == original
        target, *_ = upgrade._admit(packet._source_image, upgrade._budget())
        try:
            old_receipt = tuple(target.execute("SELECT * FROM idempotency_responses").fetchone())
            execute(target, packet)
            assert tuple(target.execute("SELECT * FROM idempotency_responses").fetchone()) == old_receipt
            assert target.execute("PRAGMA user_version").fetchone()[0] == header
            assert target.execute("SELECT shares FROM (SELECT json_extract(payload_json,'$.shares') AS shares FROM owner_sync_records WHERE kind='holding')").fetchone()[0] == 0
            assert target.execute("SELECT scale,latest_nav FROM fund_detail").fetchone()[0] == 0.1
            receipt = target.execute("SELECT payload_json FROM owner_machine_journal WHERE kind='observation'").fetchone()[0]
            assert json.loads(receipt)["schema"] == upgrade.RECEIPT_SCHEMA
            assert json.loads(receipt)["occurrence_id"] == upgrade.OCCURRENCE
            assert upgrade.reconcile_machine_upgrade_local(target, packet)["status"] == "matched"
            with pytest.raises(sqlite3.IntegrityError, match="immutable"):
                target.execute("DELETE FROM owner_machine_journal WHERE kind='observation'")
            target.rollback()
        finally:
            target.close()
        assert upgrade.reconcile_machine_upgrade_local(conn, packet) == {"status": "missing", **upgrade._FLAGS}


@pytest.mark.parametrize("fault", ["core8", "owner_missing", "unknown_table", "partial_analysis", "bad_owner_head", "bad_scope", "bad_header"])
def test_incompatible_source_is_refused_not_initialized_or_repaired(fault):
    with closing(source()) as conn:
        conn.execute("PRAGMA query_only=OFF")
        sql = {"core8": "UPDATE _schema_version SET version=8", "owner_missing": "DROP TABLE owner_sync_receipts",
               "unknown_table": "CREATE TABLE unrelated(x)", "partial_analysis": "CREATE TABLE owner_analysis_schema(x)",
               "bad_owner_head": "UPDATE owner_sync_state SET revision=10", "bad_scope": "INSERT INTO v8_repository_scopes VALUES('acceptance:v9-acceptance-corrupt','acceptance','v9-acceptance-corrupt')",
               "bad_header": "PRAGMA user_version=10"}[fault]
        conn.execute(sql); conn.commit(); conn.execute("PRAGMA query_only=ON")
        original = conn.serialize()
        with pytest.raises(upgrade.MachineUpgradeError):
            compile(conn)
        assert conn.serialize() == original


@pytest.mark.parametrize("fault", ["writable", "transaction", "temp", "attached", "foreign_keys"])
def test_source_must_be_explicit_idle_read_only_native_connection(fault):
    with closing(source()) as conn:
        if fault == "writable": conn.execute("PRAGMA query_only=OFF")
        elif fault == "transaction": conn.execute("BEGIN")
        elif fault == "temp":
            conn.execute("PRAGMA query_only=OFF"); conn.execute("CREATE TEMP TABLE private_temp(x)"); conn.execute("PRAGMA query_only=ON")
        elif fault == "attached": conn.execute("ATTACH ':memory:' AS other")
        else: conn.execute("PRAGMA foreign_keys=OFF")
        with pytest.raises(upgrade.MachineUpgradeError, match="source_unavailable"):
            compile(conn)
        if fault == "transaction":
            assert conn.in_transaction  # The compiler cannot own this rollback.


def test_independent_original_sha_and_packet_sha_are_required_for_rehydration():
    with closing(source()) as conn:
        before = hashlib.sha256(conn.serialize()).hexdigest()
        with pytest.raises(upgrade.MachineUpgradeError, match="source_identity_mismatch"):
            upgrade.compile_machine_upgrade(conn, expected_source_image_sha256="0" * 64,
                expected_resource_sha256=RESOURCE, created_at=STAMP)
        packet = compile(conn); safe = packet.safe_metadata
        arguments = dict(expected_source_image_sha256=before, expected_resource_sha256=RESOURCE,
            expected_plan_sha256=safe["plan_sha256"], expected_packet_sha256=safe["packet_sha256"])
        rebuilt = upgrade.rehydrate_machine_upgrade(conn, packet.artifact(), **arguments)
        assert rebuilt.body == packet.body
        with pytest.raises(upgrade.MachineUpgradeError):
            upgrade.rehydrate_machine_upgrade(conn, packet.artifact(), **{**arguments, "expected_packet_sha256": "0" * 64})
        with pytest.raises(upgrade.MachineUpgradeError, match="packet_integrity_invalid"):
            replace(packet, body=packet.body + b" ").safe_metadata
        forged = dict(packet.artifact()); forged["metadata"] = tuple(sorted({**dict(packet.metadata), "legacy_rows_unchanged": False}.items()))
        with pytest.raises(upgrade.MachineUpgradeError):
            upgrade.rehydrate_machine_upgrade(conn, forged, **arguments)


@pytest.mark.parametrize("mutation", ["old_row", "owner_manual", "header", "new_object", "old_receipt"])
def test_locked_before_image_change_rolls_back_all_extension_objects(mutation):
    with closing(source()) as conn:
        packet = compile(conn)
        target, *_ = upgrade._admit(packet._source_image, upgrade._budget())
        try:
            sql = {"old_row": "UPDATE fund_detail SET scale=0.2", "owner_manual": "UPDATE owner_sync_state SET revision=2",
                "header": "PRAGMA user_version=9", "new_object": "CREATE TABLE intervening(x)",
                "old_receipt": "DELETE FROM idempotency_responses"}[mutation]
            target.execute(sql); target.commit()
            with pytest.raises(sqlite3.DatabaseError):
                execute(target, packet)
            target.rollback()
            assert target.execute("SELECT 1 FROM sqlite_master WHERE name='owner_machine_journal'").fetchone() is None
        finally:
            target.close()


def test_one_ulp_cache_real_change_is_not_erased_by_json_float_binding():
    with closing(source()) as conn:
        packet = compile(conn)
        target, *_ = upgrade._admit(packet._source_image, upgrade._budget())
        try:
            target.execute("UPDATE fund_detail SET scale=?", (math.nextafter(0.1, math.inf),)); target.commit()
            with pytest.raises(sqlite3.DatabaseError):
                execute(target, packet)
            target.rollback()
        finally:
            target.close()


def test_image_budget_is_checked_before_materializing_serialize(monkeypatch):
    with closing(source()) as conn:
        original = hashlib.sha256(conn.serialize()).hexdigest()
        monkeypatch.setattr(upgrade.kernel, "MAX_IMAGE_BYTES", 4096)
        with pytest.raises(upgrade.MachineUpgradeError, match="capacity_exhausted"):
            upgrade.compile_machine_upgrade(conn, expected_source_image_sha256=original,
                expected_resource_sha256=RESOURCE, created_at=STAMP)


def test_readback_plan_is_fixed_read_only_bounded_and_contains_no_credential_discovery():
    with closing(source()) as conn:
        packet = compile(conn)
        plan = upgrade.machine_upgrade_readback_plan(packet)
        assert all(sql.split()[0] in {"SELECT", "PRAGMA"} and not args for sql, args in plan)
        assert any("owner_machine_journal" in sql for sql, _ in plan)
        assert all("LIMIT 100001" in sql for sql, _ in plan if sql.startswith("SELECT rowid"))


def test_valid_noncanonical_raw_ddl_is_preserved_not_executed_as_input():
    with closing(source()) as conn:
        conn.execute("PRAGMA query_only=OFF")
        original = conn.execute("SELECT sql FROM sqlite_master WHERE name='idx_v8_record_scope'").fetchone()[0]
        conn.execute("DROP INDEX idx_v8_record_scope")
        conn.execute(original.replace(" ON ", "\n  ON  "))
        assert conn.execute("SELECT sql FROM sqlite_master WHERE name='idx_v8_record_scope'").fetchone()[0] != original
        conn.commit(); conn.execute("PRAGMA query_only=ON")
        packet = compile(conn)
        assert upgrade.rehearse_machine_upgrade(packet)["rehearsed"]


def test_negative_old_revision_cannot_fill_a_gap_despite_matching_max_and_distinct_head():
    with closing(source(header=9)) as conn:
        conn.execute("PRAGMA query_only=OFF")
        changed = sync.apply_sync_local(conn, json.dumps({"request_id": "machine-upgrade-next-source-0001", "expected_revision": 1,
            "operations": [{"key": "000001::zero", "kind": "holding", "deleted": False,
                "changes": {"name": "next"}, "base_values": {"kind": "holding", "deleted": False, "name": "synthetic"}}]}))
        assert changed.status == 200
        conn.execute("PRAGMA ignore_check_constraints=ON")
        conn.execute("DELETE FROM owner_sync_records WHERE sync_key='asset:cash'")
        conn.execute("DELETE FROM owner_sync_changes WHERE sync_key='asset:cash'")
        conn.execute("UPDATE owner_sync_changes SET revision=-1 WHERE revision=1")
        conn.commit()
        assert sync._head(conn) == 2  # MAX/distinct alone is insufficient.
        conn.execute("PRAGMA query_only=ON")
        original = conn.serialize()
        with pytest.raises(upgrade.MachineUpgradeError, match="source_integrity_invalid"):
            compile(conn)
        assert conn.serialize() == original


@pytest.mark.parametrize("fault", ["bad_image", "bad_source_schema", "code_drift"])
def test_artifact_errors_are_closed_and_do_not_echo_private_source_or_raw_sql(fault, monkeypatch):
    with closing(source()) as conn:
        packet = compile(conn)
        if fault == "bad_image":
            packet = replace(packet, _source_image=b"private source secret must not escape")
        elif fault == "bad_source_schema":
            conn.execute("PRAGMA query_only=OFF")
            conn.execute("CREATE TABLE private_source_schema_secret(x)")
            conn.commit(); conn.execute("PRAGMA query_only=ON")
            packet = replace(packet, _source_image=conn.serialize())
        else:
            monkeypatch.setattr(upgrade, "_code", lambda: ())
        with pytest.raises(upgrade.MachineUpgradeError) as error:
            packet.artifact()
        assert str(error.value) in upgrade._ERRORS
        assert "private" not in str(error.value) and "SELECT" not in str(error.value)


@pytest.mark.parametrize("bad_sha", [False, True])
def test_compiler_read_snapshot_is_owned_and_original_connection_state_is_restored(bad_sha):
    with closing(source()) as conn:
        original = conn.serialize(); trace = []
        conn.set_trace_callback(trace.append)
        if bad_sha:
            with pytest.raises(upgrade.MachineUpgradeError, match="source_identity_mismatch"):
                upgrade.compile_machine_upgrade(conn, expected_source_image_sha256="0" * 64,
                    expected_resource_sha256=RESOURCE, created_at=STAMP)
        else:
            compile(conn)
        assert "BEGIN" in trace and "ROLLBACK" in trace
        assert not conn.in_transaction and conn.serialize() == original
        assert tuple(conn.execute("PRAGMA query_only").fetchone()) == (1,)
        assert tuple(conn.execute("PRAGMA foreign_keys").fetchone()) == (1,)


def test_source_page_bound_fault_rolls_back_only_the_owned_read_transaction():
    with closing(source()) as conn:
        original = conn.serialize(); trace = []
        conn.set_trace_callback(trace.append)
        def authorize(action, arg1, arg2, _database, _trigger):
            return sqlite3.SQLITE_DENY if (action == sqlite3.SQLITE_PRAGMA and arg1 == "page_count" and conn.in_transaction) else sqlite3.SQLITE_OK
        conn.set_authorizer(authorize)
        with pytest.raises(upgrade.MachineUpgradeError, match="source_unavailable"):
            compile(conn)
        conn.set_authorizer(None)
        assert "BEGIN" in trace and "ROLLBACK" in trace
        assert not conn.in_transaction and conn.serialize() == original


def test_read_snapshot_prevents_other_writer_commit_between_page_bound_and_second_serialize(tmp_path, monkeypatch):
    path = tmp_path / "closed-synthetic-source.sqlite3"
    with closing(source()) as original, closing(sqlite3.connect(path)) as saved:
        original.backup(saved)
    with closing(sqlite3.connect(path)) as reader, closing(sqlite3.connect(path, timeout=0.01)) as writer:
        reader.execute("PRAGMA foreign_keys=ON"); reader.execute("PRAGMA query_only=ON")
        original_build = upgrade._build
        attempts = []
        def build_under_external_writer(*args, **kwargs):
            assert reader.in_transaction
            writer.execute("INSERT INTO funds(code,name,pinyin) VALUES('999999','synthetic growth',?)", (b"x" * 50000,))
            try:
                with pytest.raises(sqlite3.OperationalError, match="locked"):
                    writer.commit()
                attempts.append(True)
            finally:
                writer.rollback()
            return original_build(*args, **kwargs)
        monkeypatch.setattr(upgrade, "_build", build_under_external_writer)
        packet = compile(reader)
        assert packet.body and attempts == [True]
        assert not reader.in_transaction
        # This is a SQLite read lock, not a promise of global stop-write.
        writer.execute("INSERT INTO funds(code,name) VALUES('999999','synthetic after read')"); writer.commit()


def _poison_after_final_full_digests(monkeypatch, poison):
    original_digest = upgrade.offline._rows_digest
    counts = []
    def digest(records, **kwargs):
        result = original_digest(records, **kwargs)
        if "owner_machine_journal" in records and len(records["owner_machine_journal"][1]) == 2:
            counts.append(True)
            if len(counts) == 2:
                poison()
        return result
    monkeypatch.setattr(upgrade.offline, "_rows_digest", digest)
    return counts


def test_rehearsal_tail_code_drift_cannot_publish_rehearsed(monkeypatch):
    with closing(source()) as conn:
        packet = compile(conn)
        calls = _poison_after_final_full_digests(monkeypatch, lambda: monkeypatch.setattr(upgrade, "_code", lambda: ()))
        with pytest.raises(upgrade.MachineUpgradeError, match="code_drift"):
            upgrade.rehearse_machine_upgrade(packet)
        assert len(calls) == 2 and not conn.in_transaction


def test_rehearsal_tail_timeout_cannot_publish_rehearsed(monkeypatch):
    with closing(source()) as conn:
        packet = compile(conn); budget = upgrade._budget(); expired = []
        original_check = budget.check
        def check():
            if expired:
                raise upgrade.MachineUpgradeError("operation_timeout")
            original_check()
        budget.check = check
        monkeypatch.setattr(upgrade, "_budget", lambda: budget)
        calls = _poison_after_final_full_digests(monkeypatch, lambda: expired.append(True))
        with pytest.raises(upgrade.MachineUpgradeError, match="operation_timeout"):
            upgrade.rehearse_machine_upgrade(packet)
        assert len(calls) == 2 and not conn.in_transaction


@pytest.mark.parametrize("fault", ["code", "time"])
def test_readback_tail_drift_or_timeout_stays_unknown_and_restores_connection(fault, monkeypatch):
    with closing(source()) as conn:
        packet = compile(conn)
        target, *_ = upgrade._admit(packet._source_image, upgrade._budget())
        try:
            execute(target, packet)
            expired = []
            if fault == "time":
                budget = upgrade._budget(); original_check = budget.check
                def check():
                    if expired:
                        raise upgrade.MachineUpgradeError("operation_timeout")
                    original_check()
                budget.check = check
                monkeypatch.setattr(upgrade, "_budget", lambda: budget)
            def poison():
                if fault == "code": monkeypatch.setattr(upgrade, "_code", lambda: ())
                else: expired.append(True)
            calls = _poison_after_final_full_digests(monkeypatch, poison)
            assert upgrade.reconcile_machine_upgrade_local(target, packet) == {"status": "unknown", **upgrade._FLAGS}
            assert len(calls) == 2 and not target.in_transaction
        finally:
            target.close()
