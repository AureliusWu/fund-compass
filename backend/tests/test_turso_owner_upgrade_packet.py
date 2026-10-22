"""Synthetic memory-only repair/scope/Owner packets, never cloud evidence."""
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, replace
from datetime import date, datetime
import hashlib
import json
import math
import os
import socket
import sqlite3

import pytest

from database import (db, owner_sync_schema as owner_schema,
                      turso_owner_upgrade_packet as compiler,
                      turso_scope_packet as strict, turso_scope_snapshot as capture,
                      turso_scope_upgrade as offline, v8_insert)
from models.v8 import canonical_json, payload_sha256, stable_id
from service import v8_repo
from test_acceptance_write_boundary import business_chain
import test_turso_scope_snapshot as capture_fixtures
import turso_scope_packet_fixtures as synthetic


@pytest.fixture(autouse=True)
def forbid_external_and_configured_access(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("synthetic packet must not use configured resources")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "socket", forbidden)
    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "init_db", forbidden)
    original_get = os._Environ.get

    def checked_get(env, key, default=None):
        if any(part in key.upper() for part in ("TOKEN", "TURSO", "PASSWORD", "CREDENTIAL")):
            forbidden()
        return original_get(env, key, default)

    monkeypatch.setattr(os._Environ, "get", checked_get)
    original_connect = sqlite3.connect

    def memory_only(database, *args, **kwargs):
        assert database == ":memory:", "test or compiler attempted non-memory SQLite"
        return original_connect(database, *args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", memory_only)


def _evidence(*, estimate=0.1, coverage=61.3):
    # Use the real production model/identity, not reserved acceptance provenance.
    model = business_chain()["evidence"].model_copy(update={
        "estimate": estimate, "estimate_coverage": coverage, "source_states": [],
    })
    return model.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(model))})


def _insert_evidence(conn, model):
    values = model.model_dump(mode="python")
    columns = v8_insert._COLUMNS["evidence_snapshots"]
    projected = []
    for column in columns:
        if column == "payload_json":
            value = canonical_json(values)
        elif column == "payload_sha256":
            value = payload_sha256(v8_repo._evidence_identity(model))
        elif column.endswith("_json"):
            value = canonical_json(values[column.removesuffix("_json")])
        else:
            value = values[column]
            if isinstance(value, (datetime, date)):
                value = value.isoformat()
        projected.append(value)
    statement = v8_insert.prepare_v8_insert(conn, "evidence_snapshots", tuple(projected))
    conn.execute(*statement)


@contextmanager
def captured(*, fields=("estimate", "estimate_coverage"), steps=1,
             direction=math.inf, estimate=0.1, coverage=61.3,
             raw_trigger=False, header=0, mutate=None):
    source = synthetic.build_fixture(root=False)
    try:
        model = _evidence(estimate=estimate, coverage=coverage)
        _insert_evidence(source, model)
        # Extra typed business data exercises full-image guards, independently
        # of the deliberately repaired Evidence cells.
        source.execute("UPDATE funds SET name=?,pinyin=? WHERE code='000001'",
                       ("synthetic\x00tail", b"synthetic\x00blob"))
        source.execute("UPDATE fund_detail SET scale=?,latest_nav=NULL WHERE code='000001'",
                       (math.nextafter(1.0, math.inf),))
        source.execute("UPDATE fund_detail SET scale=0 WHERE code='000002'")
        trigger = source.execute("SELECT sql FROM sqlite_master WHERE "
                                 "name='immutable_evidence_snapshots_update'").fetchone()[0]
        if fields:
            source.execute("DROP TRIGGER immutable_evidence_snapshots_update")
            for field in fields:
                value = getattr(model, field)
                for _ in range(steps):
                    value = math.nextafter(value, direction)
                source.execute("UPDATE evidence_snapshots SET " + field + "=?", (value,))
            source.execute(trigger)
        if raw_trigger:
            source.execute("PRAGMA writable_schema=ON")
            source.execute("UPDATE sqlite_master SET sql=replace(sql,'CREATE TRIGGER','CREATE  TRIGGER') "
                           "WHERE name='immutable_evidence_snapshots_update'")
            source.execute("PRAGMA writable_schema=OFF")
        if mutate:
            mutate(source)
        source.execute("PRAGMA user_version=" + str(header))
        source.commit()
        source.set_progress_handler(None, 0)
        with capture.capture_scope_snapshot(
            candidate_origin=capture_fixtures.ORIGIN, token=capture_fixtures.TOKEN,
            transport=capture_fixtures.SQLiteHrana(source),
            operational_tables=frozenset(offline._OPERATIONAL_DEFINITIONS),
            query_mode_profile="turso-fixed-read-v1",
        ) as snapshot:
            yield source, snapshot, model
    finally:
        source.close()


def plan(snapshot, **overrides):
    options = dict(expected_resource_sha256=snapshot.safe_metadata["resource_sha256"],
                   repair_profile=compiler.REPAIR_PROFILE)
    options.update(overrides)
    return compiler.plan_captured_owner_repair(snapshot, **options)


def compile_packet(snapshot, **overrides):
    options = dict(expected_resource_sha256=snapshot.safe_metadata["resource_sha256"],
                   expected_repair_sha256=plan(snapshot)["repair_sha256"],
                   guard_profile=strict.GUARD_PROFILE, created_at=synthetic.NOW,
                   repair_profile=compiler.REPAIR_PROFILE)
    options.update(overrides)
    return compiler.compile_captured_owner_packet(snapshot, **options)


def identity(packet):
    metadata = packet.safe_metadata
    return {"expected_" + key: metadata[key]
            for key in ("resource_sha256", "plan_sha256", "packet_sha256")}


def receipt(conn, packet):
    rows = conn.execute("SELECT rowid,* FROM idempotency_responses WHERE request_id=? AND endpoint=?",
                        (packet.safe_metadata["migration_id"], compiler.ENDPOINT)).fetchall()
    inserts = [spec for spec in packet.statement_specs
               if spec[1].startswith('INSERT INTO "idempotency_responses"(')]
    assert len(inserts) == 1
    expected = inserts[0][2]
    assert len(expected) == 10
    assert len(rows) == 1 and strict._same_native(tuple(rows[0]), expected)


def _assert_original(conn, schema_before, rows_before):
    assert strict._schema_rows(conn) == schema_before
    assert offline._rows_digest(synthetic.records(conn)) == rows_before
    assert not conn.in_transaction


def test_explicit_repair_packet_executes_full_owner_target_without_mutating_capture():
    with captured() as (source, snapshot, model):
        source_image = source.serialize()
        snapshot_image = snapshot.connection.serialize()
        before = synthetic.records(source)
        with pytest.raises(strict.CompilerError):
            synthetic.compile_packet(snapshot)
        packet = compile_packet(snapshot)
        metadata = packet.safe_metadata
        assert type(packet) is compiler.CompiledOwnerPacket
        assert metadata["repaired_cell_count"] == 2 and metadata["repaired_row_count"] == 1
        assert metadata["legacy_rows_unchanged"] is False
        assert metadata["immutable_payloads_ids_hashes_unchanged"] is True
        assert metadata["only_declared_projection_cells_changed"] is True
        assert metadata["source_rows_sha256"] != metadata["repaired_rows_sha256"]
        assert metadata["packet_sha256"] == hashlib.sha256(packet.body).hexdigest()
        for key in strict._PACKET_REMOTE_FLAGS:
            assert metadata[key] is False
        assert compiler.ENDPOINT != strict.ENDPOINT
        wire = json.loads(packet.body)
        assert all(arg["type"] != "float"
                   for step in wire["requests"][0]["batch"]["steps"] for arg in step["stmt"]["args"])
        assert all(len(spec[2]) <= strict.MAX_ARGS for spec in packet.statement_specs)
        with pytest.raises(FrozenInstanceError):
            packet.body = b"changed"
        metadata["remote_applied"] = True
        assert packet.safe_metadata["remote_applied"] is False
        target = synthetic.clone(source)
        try:
            assert synthetic.execute_packet(target, packet)["committed"]
            after = synthetic.records(target)
            for table, record in before.items():
                if table == "_schema_version":
                    assert after[table][1] == [(1, 1, 9)]
                elif table == "idempotency_responses":
                    assert len(after[table][1]) == len(record[1]) + 1
                    assert strict._same_native(after[table][1][0], record[1][0])
                elif table == "evidence_snapshots":
                    columns, old_rows = record
                    expected = list(old_rows[0])
                    expected[columns.index("estimate") + 1] = model.estimate
                    expected[columns.index("estimate_coverage") + 1] = model.estimate_coverage
                    assert strict._same_native(after[table][1][0], tuple(expected))
                else:
                    assert offline._rows_digest({table: after[table]}) == offline._rows_digest({table: record})
            assert tuple(target.execute("SELECT singleton,revision FROM owner_sync_state").fetchone()) == (1, 0)
            assert tuple(target.execute("SELECT singleton,version FROM owner_sync_schema").fetchone()) == (1, owner_schema.OWNER_SYNC_SCHEMA_VERSION)
            for table in ("owner_sync_records", "owner_sync_changes", "owner_sync_receipts"):
                assert target.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] == 0
            assert target.execute("SELECT COUNT(*) FROM v8_record_scopes").fetchone()[0] == 1
            receipt(target, packet)
            with pytest.raises(sqlite3.IntegrityError, match="immutable"):
                target.execute("UPDATE evidence_snapshots SET estimate=9")
        finally:
            target.close()
        assert source.serialize() == source_image
        assert snapshot.connection.serialize() == snapshot_image


@pytest.mark.parametrize("fields,estimate,coverage,direction", [
    (("estimate",), -0.1, None, -math.inf),
    (("estimate_coverage",), 0.0, 61.3, math.inf),
])
def test_one_projection_repair_preserves_other_null_or_zero(fields, estimate, coverage, direction):
    with captured(fields=fields, estimate=estimate, coverage=coverage, direction=direction) as (source, snapshot, model):
        packet = compile_packet(snapshot)
        assert packet.safe_metadata["repaired_cell_count"] == 1
        target = synthetic.clone(source)
        try:
            assert synthetic.execute_packet(target, packet)["committed"]
            actual = tuple(target.execute("SELECT estimate,estimate_coverage FROM evidence_snapshots").fetchone())
            assert strict._same_native(actual, (model.estimate, model.estimate_coverage))
        finally:
            target.close()


def test_every_actual_failure_prefix_rolls_back_original_rows_schema_trigger_and_receipt():
    with captured() as (source, snapshot, _model):
        packet = compile_packet(snapshot)
        labels = [spec[0] for spec in packet.statement_specs]
        assert labels[0] == "begin" and labels[-2:] == ["commit", "rollback"]
        # Duplicate pre/post guard labels must not accidentally exercise only
        # their first occurrence. Inject by actual statement index instead.
        assert sum(label == "schema:exact-raw" for label in labels) >= 2
        for fault_index, fault_label in enumerate(labels[:-1]):
            target = synthetic.clone(source)
            try:
                before_schema = strict._schema_rows(target)
                before_rows = offline._rows_digest(synthetic.records(target))
                reached = []

                def inject(_conn, label, index):
                    if index == fault_index:
                        reached.append((label, index))
                        raise sqlite3.OperationalError("synthetic failure")

                outcome = synthetic.execute_packet(target, packet, before=inject)
                assert reached == [(fault_label, fault_index)]
                assert outcome["committed"] is False and outcome["autocommit"] is True
                if fault_index:
                    assert "rollback" in outcome["executed"]
                _assert_original(target, before_schema, before_rows)
            finally:
                target.close()


def test_raw_trigger_repair_exception_is_explicit_and_all_other_raw_schema_preserved():
    with captured(raw_trigger=True) as (source, snapshot, _model):
        before_schema = strict._schema_rows(source)
        old_trigger = next(row for row in before_schema if row[1] == "immutable_evidence_snapshots_update")
        assert "CREATE  TRIGGER" in old_trigger[3]
        packet = compile_packet(snapshot)
        target = synthetic.clone(source)
        try:
            assert synthetic.execute_packet(target, packet)["committed"]
            after = {(row[0], row[1]): row for row in strict._schema_rows(target)}
            for row in before_schema:
                if row[1] == "immutable_evidence_snapshots_update":
                    assert after[row[:2]] != row
                    assert "CREATE  TRIGGER" not in after[row[:2]][3]
                else:
                    assert after[row[:2]] == row
            assert packet.safe_metadata["raw_schema_sha256"] != packet.safe_metadata["target_raw_schema_sha256"]
        finally:
            target.close()


@pytest.mark.parametrize("mutation", ["real", "null_zero", "blob", "nul_tail", "rowid", "schema"])
def test_changed_full_original_preimage_fails_without_partial_changes(mutation):
    with captured() as (source, snapshot, _model):
        packet = compile_packet(snapshot)
        target = synthetic.clone(source)
        try:
            if mutation == "real":
                target.execute("UPDATE fund_detail SET scale=? WHERE code='000001'", (1.0,))
            elif mutation == "null_zero":
                target.execute("UPDATE fund_detail SET latest_nav=0 WHERE code='000001'")
            elif mutation == "blob":
                target.execute("UPDATE funds SET pinyin=? WHERE code='000001'", ("synthetic\x00blob",))
            elif mutation == "nul_tail":
                target.execute("UPDATE funds SET name=? WHERE code='000001'", ("synthetic\x00other",))
            elif mutation == "rowid":
                target.execute("UPDATE funds SET rowid=99 WHERE code='000001'")
            else:
                target.execute("PRAGMA writable_schema=ON")
                target.execute("UPDATE sqlite_master SET sql=replace(sql,'CREATE TABLE','CREATE  TABLE') WHERE name='funds'")
                target.execute("PRAGMA writable_schema=OFF")
            target.commit()
            before_schema = strict._schema_rows(target)
            before_rows = offline._rows_digest(synthetic.records(target))
            assert not synthetic.execute_packet(target, packet)["committed"]
            _assert_original(target, before_schema, before_rows)
        finally:
            target.close()


@pytest.mark.parametrize("source_header,changed_header", [(0, 8), (0, 9), (8, 0), (8, 9)])
def test_changed_header_is_an_original_preimage_conflict(source_header, changed_header):
    with captured(header=source_header) as (source, snapshot, _model):
        packet = compile_packet(snapshot)
        assert packet.safe_metadata["source_user_version"] == source_header
        target = synthetic.clone(source)
        try:
            target.execute("PRAGMA user_version=" + str(changed_header))
            before_schema = strict._schema_rows(target)
            before_rows = offline._rows_digest(synthetic.records(target))
            assert not synthetic.execute_packet(target, packet)["committed"]
            _assert_original(target, before_schema, before_rows)
            assert target.execute("PRAGMA user_version").fetchone()[0] == changed_header
        finally:
            target.close()


@pytest.mark.parametrize("header", [0, 8])
def test_supported_header_preserved_without_executable_pragma_setters(header):
    with captured(header=header) as (source, snapshot, _model):
        packet = compile_packet(snapshot)
        assert not any(spec[1].startswith("PRAGMA") for spec in packet.statement_specs)
        target = synthetic.clone(source)
        try:
            assert synthetic.execute_packet(target, packet)["committed"]
            assert target.execute("PRAGMA user_version").fetchone()[0] == header
            assert target.execute("SELECT version FROM _schema_version").fetchone()[0] == 9
        finally:
            target.close()


@pytest.mark.parametrize("changed_header", [8, 9])
def test_changed_header_inside_migration_is_a_postimage_conflict(changed_header):
    with captured(header=0) as (source, snapshot, _model):
        packet = compile_packet(snapshot)
        target = synthetic.clone(source)
        injected = []

        def drift(conn, label, _index):
            if label == "version:cas" and not injected:
                injected.append(True)
                conn.execute("PRAGMA user_version=" + str(changed_header))

        try:
            before_schema = strict._schema_rows(target)
            before_rows = offline._rows_digest(synthetic.records(target))
            assert not synthetic.execute_packet(target, packet, before=drift)["committed"]
            assert injected == [True]
            _assert_original(target, before_schema, before_rows)
            assert target.execute("PRAGMA user_version").fetchone()[0] == 0
        finally:
            target.close()


@pytest.mark.parametrize("mutation", ["business_real", "old_receipt", "owner_revision", "scope_schema", "evidence"])
def test_complete_target_postimage_rejects_drift_after_original_preimage_check(mutation):
    with captured() as (source, snapshot, model):
        packet = compile_packet(snapshot)
        target = synthetic.clone(source)
        injected = []

        def drift(conn, label, _index):
            if label != "version:cas" or injected:
                return
            injected.append(True)
            if mutation == "business_real":
                conn.execute("UPDATE fund_detail SET scale=1 WHERE code='000001'")
            elif mutation == "old_receipt":
                conn.execute("UPDATE idempotency_responses SET response_json='changed-synthetic' "
                             "WHERE endpoint='legacy_portfolio_decisions'")
            elif mutation == "owner_revision":
                conn.execute("UPDATE owner_sync_state SET revision=1")
            elif mutation == "scope_schema":
                conn.execute("DROP TRIGGER immutable_v8_record_scopes_delete")
            else:
                trigger = conn.execute("SELECT sql FROM sqlite_master WHERE "
                                       "name='immutable_evidence_snapshots_update'").fetchone()[0]
                conn.execute("DROP TRIGGER immutable_evidence_snapshots_update")
                conn.execute("UPDATE evidence_snapshots SET estimate=?", (math.nextafter(model.estimate, -math.inf),))
                conn.execute(trigger)

        try:
            before_schema = strict._schema_rows(target)
            before_rows = offline._rows_digest(synthetic.records(target))
            assert synthetic.execute_packet(target, packet, before=drift)["committed"] is False
            assert injected == [True]
            _assert_original(target, before_schema, before_rows)
        finally:
            target.close()


def test_response_loss_replay_never_reclaims_or_changes_committed_packet():
    with captured() as (source, snapshot, _model):
        packet = compile_packet(snapshot)
        target = synthetic.clone(source)
        try:
            with pytest.raises(synthetic.ResponseLost):
                synthetic.execute_packet(target, packet, lose_response=True)
            receipt(target, packet)
            before_schema = strict._schema_rows(target)
            before_rows = offline._rows_digest(synthetic.records(target))
            assert not synthetic.execute_packet(target, packet)["committed"]
            _assert_original(target, before_schema, before_rows)
            receipt(target, packet)
        finally:
            target.close()


def test_original_identity_rehydrate_and_presend_recompile():
    with captured() as (_source, snapshot, _model):
        packet = compile_packet(snapshot)
        expected = identity(packet)
        restored = compiler.rehydrate_packet(snapshot, packet.artifact(), **expected)
        assert restored.body == packet.body
        assert strict._same_native(restored.statement_specs, packet.statement_specs)
        assert compiler.validate_packet_before_send(snapshot, packet, **expected).body == packet.body
        for key in expected:
            with pytest.raises(compiler.CompilerError):
                compiler.rehydrate_packet(snapshot, packet.artifact(), **(expected | {key: "a" * 64}))


@pytest.mark.parametrize("tamper", ["body", "resigned_body", "metadata", "metadata_bool", "recipe", "spec", "extra", "profile"])
def test_artifact_and_resealed_artifact_tampering_rejected(tamper):
    with captured() as (_source, snapshot, _model):
        packet = compile_packet(snapshot)
        artifact, expected = packet.artifact(), identity(packet)
        if tamper in ("body", "resigned_body"):
            artifact["body"] += b" "
            if tamper == "resigned_body":
                expected["expected_packet_sha256"] = hashlib.sha256(artifact["body"]).hexdigest()
        elif tamper == "metadata":
            artifact["metadata"] = list(artifact["metadata"])
        elif tamper == "metadata_bool":
            artifact["metadata"] = tuple((key, True if key == "repaired_cell_count" else value)
                                         for key, value in artifact["metadata"])
        elif tamper == "recipe":
            artifact["recipe"] = list(artifact["recipe"])
        elif tamper == "spec":
            artifact["statement_specs"] = list(artifact["statement_specs"])
        elif tamper == "extra":
            artifact["token"] = "synthetic-never-real"
        else:
            artifact["profile"] += "-unknown"
        with pytest.raises(compiler.CompilerError):
            compiler.rehydrate_packet(snapshot, artifact, **expected)


@pytest.mark.parametrize("key", [
    "source_image_sha256", "source_rows_sha256", "raw_schema_sha256", "source_contract_sha256",
    "repair_delta_sha256", "repaired_rows_sha256", "target_raw_schema_sha256",
    "target_rows_before_receipt_sha256", "repaired_cell_count", "repaired_row_count", "source_user_version",
    "plan_sha256", "restored_trigger_raw_ddl_changed",
])
def test_metadata_facts_cannot_be_forged_by_reconstruction_or_resealing(key):
    with captured() as (_source, snapshot, _model):
        packet = compile_packet(snapshot)
        original = dict(packet._metadata)
        changed = dict(original)
        changed[key] = ("a" * 64 if key.endswith("_sha256") else 8 if key == "source_user_version"
                        else not original[key] if key == "restored_trigger_raw_ddl_changed"
                        else original[key] + 1)
        metadata = tuple(sorted(changed.items()))
        with pytest.raises(compiler.CompilerError):
            replace(packet, _metadata=metadata)
        object.__setattr__(packet, "_metadata", metadata)
        # A local hash is not authentication: replacing it must not let public
        # facts disagree with the plan that is actually inside the packet.
        object.__setattr__(packet, "_seal", strict._hash(strict._json(metadata)))
        with pytest.raises(compiler.CompilerError):
            _ = packet.safe_metadata


def test_six_remote_flags_remain_literal_false_in_constructed_packet():
    with captured() as (_source, snapshot, _model):
        packet = compile_packet(snapshot)
        for key in strict._PACKET_REMOTE_FLAGS:
            for value in (True, 0, None):
                metadata = tuple((name, value if name == key else item) for name, item in packet._metadata)
                with pytest.raises(compiler.CompilerError):
                    replace(packet, _metadata=metadata)


@pytest.mark.parametrize("value", [None, False, "", "evidence-one-ulp-v1 ", strict.PACKET_PROFILE])
def test_repair_profile_requires_explicit_exact_literal(value):
    with pytest.raises(compiler.CompilerError, match="^invalid_compile_arguments$"):
        compiler.plan_captured_owner_repair(None, expected_resource_sha256="a" * 64,
                                            repair_profile=value)


def test_no_repair_not_a_hidden_owner_schema_migration_and_repair_pin_required():
    with captured(fields=()) as (_source, snapshot, _model):
        with pytest.raises(compiler.CompilerError, match="^repair_not_needed$"):
            plan(snapshot)
    with captured() as (_source, snapshot, _model):
        with pytest.raises(compiler.CompilerError, match="^repair_binding_mismatch$"):
            compile_packet(snapshot, expected_repair_sha256="a" * 64)
        with pytest.raises(compiler.CompilerError, match="^source_identity_mismatch$"):
            plan(snapshot, expected_resource_sha256="a" * 64)


def test_repair_pin_independent_of_receipt_timestamp_but_plan_not_interchangeable():
    with captured() as (_source, snapshot, _model):
        first = compile_packet(snapshot)
        second = compile_packet(snapshot, created_at="2026-10-03T00:00:01Z")
        one, two = first.safe_metadata, second.safe_metadata
        assert one["repair_sha256"] == two["repair_sha256"] == plan(snapshot)["repair_sha256"]
        assert one["migration_id"] == two["migration_id"]
        assert one["receipt_rowid"] == two["receipt_rowid"]
        assert one["plan_sha256"] != two["plan_sha256"]
        assert one["packet_sha256"] != two["packet_sha256"]
        with pytest.raises(compiler.CompilerError):
            compiler.rehydrate_packet(snapshot, second.artifact(), **identity(first))


def test_required_repair_pin_and_profile_have_no_default():
    with pytest.raises(TypeError, match="expected_repair_sha256"):
        compiler.compile_captured_owner_packet(None, expected_resource_sha256="a" * 64,
            guard_profile=strict.GUARD_PROFILE, created_at=synthetic.NOW,
            repair_profile=compiler.REPAIR_PROFILE)
    with pytest.raises(TypeError, match="repair_profile"):
        compiler.plan_captured_owner_repair(None, expected_resource_sha256="a" * 64)


@pytest.mark.parametrize("steps", [2, 17])
def test_more_than_one_ulp_still_refused(steps):
    with captured(steps=steps) as (source, snapshot, _model):
        image = source.serialize()
        with pytest.raises(compiler.CompilerError, match="^repair_difference_invalid$"):
            plan(snapshot)
        assert source.serialize() == image


def test_old_profile_does_not_accept_new_private_artifact():
    with captured() as (_source, snapshot, _model):
        packet = compile_packet(snapshot)
        with pytest.raises(strict.CompilerError):
            strict.rehydrate_packet(snapshot, packet.artifact(), **identity(packet))


@pytest.mark.parametrize("operation", ["constructor", "metadata", "compile", "rehydrate", "presend"])
def test_source_drift_after_real_validation_cannot_publish_success(monkeypatch, operation):
    with captured() as (_source, snapshot, _model):
        packet = compile_packet(snapshot)
        expected = identity(packet)
        artifact = packet.artifact()
        repair_sha = packet.safe_metadata["repair_sha256"]
        original_validate, original_own = compiler._validate, compiler._own_code
        validated = []

        def observed_own_code():
            # Preserve the real finite source-file reads. Only after the real
            # validator succeeded do we simulate its next read observing drift.
            rows = original_own()
            return tuple((name, "0" * 64 if name == "owner_compiler" else sha)
                         for name, sha in rows) if validated else rows

        def validated_then_drift(*args, **kwargs):
            result = original_validate(*args, **kwargs)
            validated.append(True)
            return result

        monkeypatch.setattr(compiler, "_own_code", observed_own_code)
        monkeypatch.setattr(compiler, "_validate", validated_then_drift)
        with pytest.raises(compiler.CompilerError, match="^compiler_code_drift$"):
            if operation == "constructor":
                replace(packet)
            elif operation == "metadata":
                _ = packet.safe_metadata
            elif operation == "compile":
                compiler.compile_captured_owner_packet(snapshot,
                    expected_resource_sha256=expected["expected_resource_sha256"],
                    expected_repair_sha256=repair_sha, guard_profile=strict.GUARD_PROFILE,
                    created_at=synthetic.NOW, repair_profile=compiler.REPAIR_PROFILE)
            elif operation == "rehydrate":
                compiler.rehydrate_packet(snapshot, artifact, **expected)
            else:
                compiler.validate_packet_before_send(snapshot, packet, **expected)
        assert validated, "test must reach and complete the unchanged real validator"


def test_repair_planner_source_drift_after_complete_prepare_rejected(monkeypatch):
    with captured() as (_source, snapshot, _model):
        original_prepare, original_own = compiler._prepare, compiler._own_code
        prepared = []

        def observed_own_code():
            rows = original_own()
            return tuple((name, "0" * 64 if name == "owner_compiler" else sha)
                         for name, sha in rows) if prepared else rows

        def prepared_then_drift(*args, **kwargs):
            result = original_prepare(*args, **kwargs)
            prepared.append(True)
            return result

        monkeypatch.setattr(compiler, "_own_code", observed_own_code)
        monkeypatch.setattr(compiler, "_prepare", prepared_then_drift)
        with pytest.raises(compiler.CompilerError, match="^compiler_code_drift$"):
            plan(snapshot)
        assert prepared == [True]


def test_rehydrate_budget_is_total_not_reset_by_successful_recompile(monkeypatch):
    with captured() as (_source, snapshot, _model):
        packet = compile_packet(snapshot)
        expected, artifact = identity(packet), packet.artifact()
        original_validate = compiler._validate
        original_compile = compiler.compile_captured_owner_packet
        elapsed = [1000.0]
        validations, compiles = [], []

        def observed_validate(*args, **kwargs):
            result = original_validate(*args, **kwargs)
            if not validations:
                # No sleep and no validator bypass: charge 20 seconds only
                # after the original artifact validation has really succeeded.
                elapsed[0] += 20.0
            validations.append(True)
            return result

        def observed_compile(*args, **kwargs):
            result = original_compile(*args, **kwargs)
            compiles.append(True)
            # The separate compile succeeds within its own 30 second window,
            # but rehydrate's original window has now consumed 35 seconds.
            elapsed[0] += 15.0
            return result

        monkeypatch.setattr(compiler.time, "monotonic", lambda: elapsed[0])
        monkeypatch.setattr(compiler, "_validate", observed_validate)
        monkeypatch.setattr(compiler, "compile_captured_owner_packet", observed_compile)
        with pytest.raises(compiler.CompilerError, match="^compile_time_limit$"):
            compiler.rehydrate_packet(snapshot, artifact, **expected)
        assert validations and compiles == [True]


def test_closed_error_never_exposes_supplied_private_text():
    assert "synthetic-private-marker" not in str(compiler.CompilerError("synthetic-private-marker"))
