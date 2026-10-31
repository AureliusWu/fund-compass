"""Actual bounded Turso HTTP over an owned loopback SQLite/Hrana server.

These tests prove the explicit driver/profile boundary, not TLS, a real Turso
provider, business integrity, migration, durability or release qualification.
"""
from contextlib import closing
from dataclasses import FrozenInstanceError
import hashlib
import sqlite3

import pytest

from database import db, owner_analysis_schema as analysis, owner_machine_schema as machine
from database import owner_sync_schema as owner, turso, turso_schema
from database import turso_machine_profile as profile
from test_owner_sync_turso import ORIGIN, TOKEN, local_hrana, seed_owner_database


def seed(path, *, header=8, optional=()):
    seed_owner_database(path, header=9)
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        analysis.provision_owner_analysis_candidate(conn, synthetic_candidate=True)
        machine.provision_owner_machine_candidate(conn, synthetic_candidate=True)
        conn.execute("INSERT INTO v8_repository_scopes(scope_key,purpose,namespace) VALUES('production','production',NULL)")
        for name in optional:
            if name == "sqlite_stat1":
                conn.execute("ANALYZE")
            else:
                conn.execute(profile._OPERATIONAL[name])
        conn.execute(f"PRAGMA user_version={header}")
        conn.commit()


def connection(*, seconds=30, response=profile.MAX_RESPONSE_BYTES, bounded=True):
    limits = turso.HttpLimits(seconds, response) if bounded else None
    return turso.connect(ORIGIN, TOKEN, http_limits=limits)


def mutate(path, sql, parameters=()):
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("PRAGMA ignore_check_constraints=ON")
        conn.execute(sql, parameters)
        conn.commit()


def update_marker(path, table, values):
    name = "immutable_" + table + "_update"
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("PRAGMA ignore_check_constraints=ON")
        ddl = conn.execute("SELECT sql FROM sqlite_master WHERE name=?", (name,)).fetchone()[0]
        conn.execute("DROP TRIGGER " + name)
        conn.execute("UPDATE " + table + " SET " + values)
        conn.execute(ddl)
        conn.commit()


def test_manifest_is_fixed_immutable_complete_and_has_no_configured_io(monkeypatch):
    profile._manifest.cache_clear()
    def forbidden(*_args, **_kwargs):
        pytest.fail("manifest construction reached configured storage or HTTP")
    monkeypatch.setattr(db, "get_conn", forbidden)
    monkeypatch.setattr(db, "init_db", forbidden)
    monkeypatch.setattr(turso.requests, "Session", forbidden)
    manifest = profile.machine_profile_manifest()
    assert manifest.object_count == 126
    assert len(manifest.sha256) == 64
    assert {row[1] for row in manifest.objects if row[0] == "trigger"} >= {
        *analysis.OWNER_ANALYSIS_TRIGGERS, *machine.OWNER_MACHINE_TRIGGERS}
    assert ("table", "_schema_version") in {row[:2] for row in manifest.objects}
    assert profile.machine_profile_manifest(("sqlite_stat1", "universe_import_state")).object_count == 128
    assert profile.machine_profile_manifest(("turso_candidate_probe_v1",)).object_count == 128
    with pytest.raises(FrozenInstanceError):
        manifest.sha256 = "0" * 64


@pytest.mark.parametrize("names", [[], ("unknown",), ("sqlite_stat1", "sqlite_stat1"),
    ("sqlite_stat1", "universe_import_state", "turso_candidate_probe_v1"),
    ("turso_candidate_probe_v1", "universe_import_state")])
def test_optional_contract_never_expands_128_object_budget(names):
    with pytest.raises(profile.MachineProfileError):
        profile.machine_profile_manifest(names)


@pytest.mark.parametrize("header", [0, 8, 9])
@pytest.mark.parametrize("optional", [(), ("sqlite_stat1",), ("universe_import_state",),
    ("sqlite_stat1", "universe_import_state"), ("turso_candidate_probe_v1",)])
def test_complete_profile_uses_one_actual_read_batch_with_original_header_unchanged(tmp_path, monkeypatch, header, optional):
    path = tmp_path / "machine.sqlite3"
    seed(path, header=header, optional=optional)
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    with local_hrana(path, monkeypatch) as (state, _unused):
        with closing(connection()) as conn:
            conn.execute("PRAGMA foreign_keys=ON")
            before = len(state.frames)
            value = profile.verify_turso_machine_profile(conn)
            assert len(state.frames) == before + 1
            assert state.read_batches == 1 and state.write_batches == 0
            assert conn.in_transaction is False and conn._closed is False and conn.total_changes == 0
            assert value.profile == profile.PROFILE and value.core_schema_version == 9
            assert value.header_user_version == header and value.owner_revision == 0
            assert value.optional_tables == tuple(sorted(optional))
            assert value.schema_sha256 == profile.machine_profile_manifest(optional).sha256
            assert not value.durability_verified and not value.restore_verified and not value.formal_release_qualified
            frame = state.frames[-1]
            steps = frame["requests"][0]["batch"]["steps"]
            assert steps[0]["stmt"]["sql"] == "BEGIN DEFERRED"
            assert all(step["stmt"]["sql"].split()[0] in {"BEGIN", "SELECT", "PRAGMA", "COMMIT", "ROLLBACK"} for step in steps)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original


@pytest.mark.parametrize("fault", ["core8", "core_missing", "owner_marker", "owner_head", "owner_history",
    "analysis_marker", "machine_marker", "machine_marker_missing", "production_missing", "acceptance_scope",
    "unknown_trigger", "unknown_index", "unknown_table", "bad_optional", "oversized_name", "oversized_ddl", "over_inventory", "header_new"])
def test_bad_complete_profile_is_refused_without_any_write_or_retry(tmp_path, monkeypatch, fault):
    path = tmp_path / "machine.sqlite3"
    seed(path)
    if fault == "core8": mutate(path, "UPDATE _schema_version SET version=8")
    elif fault == "core_missing": mutate(path, "DROP TABLE _schema_version")
    elif fault == "owner_marker": mutate(path, "UPDATE owner_sync_schema SET version='old'")
    elif fault == "owner_head": mutate(path, "UPDATE owner_sync_state SET revision=1")
    elif fault == "owner_history": mutate(path, "INSERT INTO owner_sync_changes VALUES(1,'000001::X','{}')")
    elif fault == "analysis_marker": update_marker(path, "owner_analysis_schema", "version='old'")
    elif fault == "machine_marker": update_marker(path, "owner_machine_journal", "payload_hash='" + "0" * 64 + "'")
    elif fault == "machine_marker_missing":
        mutate(path, "DROP TRIGGER immutable_owner_machine_journal_delete")
        mutate(path, "DELETE FROM owner_machine_journal WHERE kind='schema'")
        mutate(path, machine.OWNER_MACHINE_TRIGGERS["immutable_owner_machine_journal_delete"])
    elif fault == "production_missing":
        mutate(path, "DROP TRIGGER immutable_v8_repository_scopes_delete")
        mutate(path, "DELETE FROM v8_repository_scopes")
        mutate(path, "CREATE TRIGGER immutable_v8_repository_scopes_delete BEFORE DELETE ON v8_repository_scopes BEGIN SELECT RAISE(ABORT, 'v8_repository_scopes is immutable'); END")
    elif fault == "acceptance_scope": mutate(path, "INSERT INTO v8_repository_scopes VALUES('acceptance:v9-acceptance-test','acceptance','v9-acceptance-test')")
    elif fault == "unknown_trigger": mutate(path, "CREATE TRIGGER unknown_guard BEFORE INSERT ON fund_detail BEGIN SELECT 1; END")
    elif fault == "unknown_index": mutate(path, "CREATE INDEX unknown_index ON owner_sync_state(revision)")
    elif fault == "unknown_table": mutate(path, "CREATE TABLE sqliteXevil(value TEXT)")
    elif fault == "bad_optional": mutate(path, "CREATE TABLE universe_import_state(unknown TEXT)")
    elif fault == "oversized_name": mutate(path, 'CREATE TABLE "' + "x" * 257 + '"(v TEXT)')
    elif fault == "oversized_ddl": mutate(path, "CREATE VIEW oversized AS SELECT '" + "x" * 16384 + "'")
    elif fault == "over_inventory":
        for index in range(3): mutate(path, "CREATE TABLE synthetic_extra_" + str(index) + "(v TEXT)")
    else: mutate(path, "PRAGMA user_version=10")
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    with local_hrana(path, monkeypatch) as (state, _unused):
        with closing(connection()) as conn:
            conn.execute("PRAGMA foreign_keys=ON")
            before = len(state.frames)
            with pytest.raises(profile.MachineProfileError, match="^Turso machine candidate profile is unavailable$"):
                profile.verify_turso_machine_profile(conn)
            assert len(state.frames) == before + 1 and state.read_batches == 1 and state.write_batches == 0
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original


@pytest.mark.parametrize("fault", ["foreign_keys", "temp", "attached"])
def test_stream_state_is_read_not_repaired(tmp_path, monkeypatch, fault):
    path = tmp_path / "machine.sqlite3"
    seed(path)
    with local_hrana(path, monkeypatch) as (state, _unused):
        with closing(connection()) as conn:
            if fault != "foreign_keys": conn.execute("PRAGMA foreign_keys=ON")
            if fault == "temp": conn.execute("CREATE TEMP VIEW unrelated_temp AS SELECT 1")
            if fault == "attached": conn.execute("ATTACH DATABASE ':memory:' AS alien")
            before = len(state.frames)
            with pytest.raises(profile.MachineProfileError):
                profile.verify_turso_machine_profile(conn)
            assert len(state.frames) == before + 1
            # Verification never changes the caller's state to make it pass.
            if fault == "foreign_keys": assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 0
            if fault == "temp": assert conn.execute("SELECT name FROM sqlite_temp_master").fetchone()[0] == "unrelated_temp"
            if fault == "attached": assert "alien" in {row[1] for row in conn.execute("PRAGMA database_list")}


@pytest.mark.parametrize("fault", ["default_driver", "large_budget", "large_response", "active"])
def test_explicit_bounded_driver_and_free_transaction_are_required_before_request(tmp_path, monkeypatch, fault):
    path = tmp_path / "machine.sqlite3"
    seed(path)
    with local_hrana(path, monkeypatch) as (state, _unused):
        with closing(connection(bounded=fault != "default_driver", seconds=31 if fault == "large_budget" else 30,
                                response=profile.MAX_RESPONSE_BYTES + 1 if fault == "large_response" else profile.MAX_RESPONSE_BYTES)) as conn:
            if fault == "active": conn.execute("BEGIN")
            before = len(state.frames)
            with pytest.raises(profile.MachineProfileError): profile.verify_turso_machine_profile(conn)
            assert len(state.frames) == before


def test_sqlite_and_duck_connections_are_not_remote_authority():
    with closing(sqlite3.connect(":memory:")) as conn:
        with pytest.raises(profile.MachineProfileError): profile.verify_turso_machine_profile(conn)
    class Duck:
        def __getattr__(self, _name): pytest.fail("a duck connection was inspected")
    with pytest.raises(profile.MachineProfileError): profile.verify_turso_machine_profile(Duck())


def test_old_public_profiles_still_refuse_full_machine_schema(tmp_path, monkeypatch):
    path = tmp_path / "machine.sqlite3"
    seed(path)
    with local_hrana(path, monkeypatch):
        with closing(connection()) as conn:
            conn.execute("PRAGMA foreign_keys=ON")
            with pytest.raises(sqlite3.DatabaseError, match="unrecognized trigger"):
                turso_schema.verify_schema(conn)
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("PRAGMA user_version=9")
        with pytest.raises(sqlite3.DatabaseError): owner.verify_owner_sync_schema(conn)


def test_read_transport_error_is_sanitized_and_never_retried(tmp_path, monkeypatch):
    path = tmp_path / "machine.sqlite3"
    seed(path)
    with local_hrana(path, monkeypatch) as (state, _unused):
        with closing(connection()) as conn:
            conn.execute("PRAGMA foreign_keys=ON")
            original = state.pipeline
            calls = []
            def failing(frame):
                calls.append(True)
                return {"baton": None, "base_url": None, "results": [{"type": "error", "error": {
                    "code": "SQLITE_ERROR", "message": "synthetic-private-provider-and-token-never-escape"}}]}, False
            state.pipeline = failing
            try:
                with pytest.raises(profile.MachineProfileError) as error:
                    profile.verify_turso_machine_profile(conn)
                assert "private" not in str(error.value) and TOKEN not in str(error.value)
                assert calls == [True]
            finally:
                state.pipeline = original


@pytest.mark.parametrize("index", [1, 2, 5, 6, 7, 8])
@pytest.mark.parametrize("imposter", [True, 1.0], ids=["boolean", "float"])
def test_snapshot_parser_rejects_non_native_integer_marker_projections(tmp_path, index, imposter):
    path = tmp_path / "machine.sqlite3"
    seed(path)
    class Rows:
        def __init__(self, rows): self.values = iter(rows)
        def fetchmany(self, count):
            from itertools import islice
            return list(islice(self.values, count))
        def fetchone(self): return next(self.values, None)
    with closing(sqlite3.connect(path)) as conn:
        conn.execute("PRAGMA foreign_keys=ON")
        snapshot = [list(conn.execute(sql, parameters)) for sql, parameters in profile.machine_profile_reads()]
    snapshot[index] = [(imposter, *snapshot[index][0][1:])]
    with pytest.raises(profile.MachineProfileError):
        profile.inspect_machine_profile_snapshot([Rows(rows) for rows in snapshot])
