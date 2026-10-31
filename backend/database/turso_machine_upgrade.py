"""Independent schema9 Owner-only -> complete machine packet, entirely local.

Only an explicitly owned read-only SQLite snapshot and external SHA identities
are accepted. This is neither a sender nor a startup migration. The generated
conditional Hrana batch uses repository DDL; captured SQL is comparison data.
Packet bodies/artifacts contain private source rows: never log or upload them.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import sqlite3
import time

from database import owner_analysis_schema as analysis, owner_machine_schema as machine
from database import owner_sync_schema as owner, turso_machine_profile as profile
from database import turso_scope_packet as kernel, turso_scope_upgrade as offline
from service import owner_sync_repo as sync, repository_scopes as scopes

PROFILE = "turso-machine-extension-packet-1"
ARTIFACT_PROFILE = "turso-machine-extension-artifact-1"
RECEIPT_SCHEMA = "owner-machine-upgrade-receipt-1"
OCCURRENCE = "profile:owner-machine"
MAX_SECONDS = 30.0
_NEW_TABLES = frozenset((*analysis.OWNER_ANALYSIS_DDL, *machine.OWNER_MACHINE_DDL))
_FLAGS = {"remote_applied": False, "restore_verified": False, "retry_allowed": False,
          "formal_release_qualified": False, "server_capabilities_verified": False}
_ERRORS = frozenset({"invalid_arguments", "source_unavailable", "source_identity_mismatch",
    "source_profile_mismatch", "source_integrity_invalid", "capacity_exhausted", "code_drift",
    "packet_integrity_invalid", "operation_timeout", "rehearsal_failed"})
_CODE_FILES = (Path(__file__).resolve(), Path(profile.__file__).resolve(), Path(analysis.__file__).resolve(),
    Path(machine.__file__).resolve(), Path(owner.__file__).resolve(), Path(kernel.__file__).resolve(),
    Path(offline.__file__).resolve(), Path(sync.__file__).resolve(), Path(scopes.__file__).resolve())


class MachineUpgradeError(RuntimeError):
    def __init__(self, code="source_unavailable"):
        super().__init__(code if code in _ERRORS else "source_unavailable")


def _fail(code):
    raise MachineUpgradeError(code)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _code():
    result = []
    for path in _CODE_FILES:
        with path.open("rb") as source:
            raw = source.read(1024 * 1024 + 1)
        if not 1 <= len(raw) <= 1024 * 1024:
            _fail("code_drift")
        raw.decode("utf-8", errors="strict")
        result.append((path.name, _sha(raw)))
    return tuple(result)


_LOADED_CODE = (*kernel._current_code(), *_code())


def _current_code():
    if (*kernel._current_code(), *_code()) != _LOADED_CODE:
        _fail("code_drift")
    return _LOADED_CODE


def _budget():
    return kernel._Budget(time.monotonic() + MAX_SECONDS)


def _identity(value):
    if type(value) is not str or not kernel._SHA.fullmatch(value):
        _fail("invalid_arguments")
    return value


def _stamp(value):
    if type(value) is not str or not kernel._UTC.fullmatch(value):
        _fail("invalid_arguments")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo != timezone.utc or stamp.isoformat(timespec="seconds").replace("+00:00", "Z") != value:
            _fail("invalid_arguments")
    except (ValueError, OverflowError):
        _fail("invalid_arguments")


def _schema(conn):
    rows = tuple(tuple(row) for row in conn.execute(
        "SELECT type,CASE WHEN length(CAST(name AS BLOB))<=256 THEN name END,"
        "CASE WHEN length(CAST(tbl_name AS BLOB))<=256 THEN tbl_name END,"
        "CASE WHEN sql IS NULL OR length(CAST(sql AS BLOB))<=16384 THEN sql END,"
        "length(CAST(sql AS BLOB)) FROM main.sqlite_master ORDER BY type,name LIMIT 129"))
    if (not rows or len(rows) > 128 or any(type(row[0]) is not str or type(row[1]) is not str
            or type(row[2]) is not str or row[4] is not None and
            (type(row[3]) is not str or not 1 <= row[4] <= 16384) for row in rows)):
        _fail("source_profile_mismatch")
    return tuple(row[:4] for row in rows)


def _reference(objects):
    """All supplied objects originate in the fixed manifest, never source SQL."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    try:
        for kind in ("table", "index", "view", "trigger"):
            for row in objects:
                if row[0] != kind or row[3] is None or row[1] in {"sqlite_sequence", "sqlite_stat1"}:
                    continue
                conn.execute(row[3])
        if any(row[:2] == ("table", "sqlite_stat1") for row in objects):
            conn.execute("ANALYZE")
        conn.commit()
        return conn
    except Exception:
        conn.close()
        raise


def _same_schema(actual, expected):
    return len(actual) == len(expected) and all(a[:3] == e[:3] and owner._same_ddl(a[3], e[3])
                                               for a, e in zip(actual, expected))


def _records(conn, expected, budget):
    # Refuse an oversized cell before Python materialization, not after json.
    for kind, table in expected:
        if kind != "table":
            continue
        names = tuple(row[1] for row in conn.execute(f'PRAGMA table_info("{table}")'))
        condition = " OR ".join(f'length(CAST("{name}" AS BLOB))>{kernel.MAX_CELL_BYTES}' for name in names)
        if conn.execute(f'SELECT 1 FROM "{table}" WHERE {condition} LIMIT 1').fetchone() is not None:
            _fail("capacity_exhausted")
        budget.check()
    return offline._snapshot_rows(conn, expected, offline._Budget(budget.deadline))


@contextmanager
def _source_read_snapshot(conn, budget):
    """Own only a new read transaction; never roll back a caller transaction.

    The first schema read pins SQLite's read snapshot before page bounds and
    serialization. This is not proof that other processes are globally paused.
    A later real apply still needs the complete locked preimage guards.
    """
    if conn.in_transaction:
        _fail("source_unavailable")
    owned = False
    try:
        conn.execute("BEGIN")
        owned = True
        conn.execute("SELECT 1 FROM main.sqlite_master LIMIT 1").fetchone()
        pages = conn.execute("PRAGMA page_count").fetchone()[0]
        size = conn.execute("PRAGMA page_size").fetchone()[0]
        if (type(pages) is not int or type(size) is not int or pages <= 0 or size <= 0
                or pages * size > kernel.MAX_IMAGE_BYTES):
            _fail("capacity_exhausted")
        budget.check()
        if not conn.in_transaction:
            _fail("source_unavailable")
        yield
        if not conn.in_transaction:
            _fail("source_unavailable")
        budget.check()
    finally:
        if owned:
            try:
                conn.rollback()
            except Exception:
                _fail("source_unavailable")


def _admit(image, budget):
    if type(image) is not bytes or not 16 <= len(image) <= kernel.MAX_IMAGE_BYTES or not image.startswith(b"SQLite format 3\x00"):
        _fail("source_unavailable")
    decoder = reference = None
    try:
        decoder = sqlite3.connect(":memory:")
        decoder.row_factory = sqlite3.Row
        decoder.enable_load_extension(False)
        decoder.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
        decoder.deserialize(image)
        decoder.set_progress_handler(budget.progress, 1000)
        raw = _schema(decoder)
        optional = tuple(sorted(row[1] for row in raw if row[0] == "table" and row[1] in profile._OPERATIONAL))
        manifest = profile.machine_profile_manifest(optional)
        source_objects = tuple(row for row in manifest.objects if row[2] not in _NEW_TABLES)
        if not _same_schema(raw, source_objects):
            _fail("source_profile_mismatch")
        if tuple(tuple(row) for row in decoder.execute("SELECT singleton,version FROM _schema_version LIMIT 2")) != ((1, 9),):
            _fail("source_profile_mismatch")
        header = decoder.execute("PRAGMA user_version").fetchone()[0]
        if type(header) is not int or header not in (0, 8, 9):
            _fail("source_profile_mismatch")
        if tuple(tuple(row) for row in decoder.execute("SELECT singleton,version FROM owner_sync_schema LIMIT 2")) != ((1, owner.OWNER_SYNC_SCHEMA_VERSION),):
            _fail("source_profile_mismatch")
        state = tuple(tuple(row) for row in decoder.execute("SELECT singleton,revision FROM owner_sync_state LIMIT 2"))
        history = decoder.execute("SELECT MAX(revision),COUNT(DISTINCT revision),COALESCE(SUM(CASE WHEN "
            f"typeof(revision)='integer' AND revision BETWEEN 1 AND {owner.MAX_SAFE_INTEGER} THEN 0 ELSE 1 END),0) "
            "FROM owner_sync_changes").fetchone()
        if (len(state) != 1 or type(state[0][0]) is not int or state[0][0] != 1
                or type(state[0][1]) is not int or not 0 <= state[0][1] <= owner.MAX_SAFE_INTEGER
                or type(history[1]) is not int or history[1] != state[0][1]
                or type(history[2]) is not int or history[2] != 0
                or (state[0][1] == 0 and history[0] is not None)
                or (state[0][1] > 0 and (type(history[0]) is not int or history[0] != state[0][1]))):
            _fail("source_integrity_invalid")
        decoder.execute("PRAGMA query_only=ON")
        records = _records(decoder, {(r[0], r[1]): r[3] for r in source_objects if r[3] is not None}, budget)
        reference = _reference(source_objects)
        reference.set_progress_handler(budget.progress, 1000)
        offline._seed_memory(reference, records)
        reference.execute(f"PRAGMA user_version={header}")
        offline._integrity(reference)
        roundtrip = _records(reference, offline._objects(reference), budget)
        if offline._rows_digest(roundtrip) != offline._rows_digest(records):
            _fail("source_integrity_invalid")
        if tuple(tuple(row) for row in reference.execute(
                "SELECT scope_key,purpose,namespace FROM v8_repository_scopes LIMIT 2")) != (("production", "production", None),):
            _fail("source_integrity_invalid")
        scopes._validate_legacy_lineages(reference)
        head = sync._head(reference)
        for row in reference.execute("SELECT sync_key FROM owner_sync_records ORDER BY sync_key"):
            budget.check()
            if sync._record(reference, row[0], head) is None:
                _fail("source_integrity_invalid")
        if reference.execute("SELECT 1 FROM owner_sync_changes c WHERE NOT EXISTS "
                "(SELECT 1 FROM owner_sync_records r WHERE r.sync_key=c.sync_key) LIMIT 1").fetchone() is not None:
            _fail("source_integrity_invalid")
        return reference, raw, records, manifest, header
    except Exception:
        if reference is not None:
            reference.close()
        raise
    finally:
        if decoder is not None:
            decoder.close()


def _build(image, resource, created_at, *, budget=None):
    budget = budget if budget is not None else _budget()
    code = _current_code()
    _identity(resource); _stamp(created_at)
    reference, raw, records, manifest, header = _admit(image, budget)
    try:
        if sum(len(rows) for _, rows in records.values()) + 3 > kernel.MAX_ROWS:
            _fail("capacity_exhausted")
        for ddl in (*analysis.OWNER_ANALYSIS_DDL.values(), *analysis.OWNER_ANALYSIS_TRIGGERS.values(),
                    *machine.OWNER_MACHINE_DDL.values(), *machine.OWNER_MACHINE_TRIGGERS.values()):
            reference.execute(ddl)
        reference.execute("INSERT INTO owner_analysis_schema(singleton,version) VALUES(1,?)", (analysis.OWNER_ANALYSIS_SCHEMA_VERSION,))
        reference.execute("INSERT INTO owner_machine_journal(schema_version,kind,record_id,occurrence_id,analysis_request_id,created_at,payload_json,payload_hash) "
            "VALUES(?,'schema','schema',NULL,NULL,?,?,?)", (machine.OWNER_MACHINE_SCHEMA_VERSION,
                machine.MACHINE_SCHEMA_CREATED_AT, machine.MACHINE_SCHEMA_PAYLOAD_JSON, machine.MACHINE_SCHEMA_PAYLOAD_HASH))
        reference.commit()
        target_schema = tuple(sorted((*raw, *(row for row in manifest.objects if row[2] in _NEW_TABLES))))
        if not _same_schema(_schema(reference), target_schema):
            _fail("source_integrity_invalid")
        target = _records(reference, offline._objects(reference), budget)
        if offline._rows_digest({key: target[key] for key in records}) != offline._rows_digest(records):
            _fail("source_integrity_invalid")
        source_sha = _sha(image)
        migration_id = "machine-extension:" + resource
        record_id = "machine-upgrade:" + resource
        steps = [kernel._guard("capability:foreign-keys", "(SELECT foreign_keys=1 FROM pragma_foreign_keys)"),
            kernel._guard("capability:atan2-zero", "typeof(atan2(0.0,-1.0))='real' AND atan2(-0.0,-1.0)<0 AND atan2(0.0,-1.0)>0")]
        steps.extend(kernel._schema_guards(raw))
        steps.append(kernel._guard("header:source", "(SELECT typeof(user_version)='integer' AND user_version=? FROM pragma_user_version)", (header,)))
        for table, (columns, rows) in sorted(records.items()):
            steps.extend(kernel._row_guards(table, columns, rows, budget))
        for index, ddl in enumerate((*analysis.OWNER_ANALYSIS_DDL.values(), *analysis.OWNER_ANALYSIS_TRIGGERS.values(),
                *machine.OWNER_MACHINE_DDL.values(), *machine.OWNER_MACHINE_TRIGGERS.values())):
            steps.append(kernel.Statement("extension:ddl:" + str(index), ddl))
        for table in sorted(_NEW_TABLES):
            columns, rows = target[table]
            for row in rows:
                names = ("rowid", *columns)
                steps.append(kernel.Statement("extension:marker:" + table, f'INSERT INTO "{table}"('
                    + ",".join('"' + name + '"' for name in names) + ") VALUES (" + ",".join("?" for _ in row) + ")", tuple(row)))
        steps.extend(kernel._schema_guards(target_schema))
        steps.append(kernel._guard("header:post", "(SELECT user_version=? FROM pragma_user_version)", (header,)))
        for table, (columns, rows) in sorted(target.items()):
            steps.extend(kernel._row_guards(table, columns, rows, budget))
        journal_columns, marker_rows = target["owner_machine_journal"]
        steps.append(kernel._guard("receipt:absent", "NOT EXISTS (SELECT 1 FROM owner_machine_journal WHERE kind='observation' AND record_id=?)", (record_id,)))
        facts = {"profile": PROFILE, "resource_sha256": resource, "source_image_sha256": source_sha,
            "source_rows_sha256": offline._rows_digest(records), "source_schema_sha256": kernel.capture._schema_inventory_digest(raw),
            "target_schema_sha256": kernel.capture._schema_inventory_digest(target_schema),
            "target_rows_before_receipt_sha256": offline._rows_digest(target), "contract_code_sha256": _sha(kernel._json(code)),
            "migration_id": migration_id, "source_user_version": header, "created_at": created_at}
        plan_sha = _sha(kernel._json({"facts": facts, "steps": [row._wire() for row in steps]}))
        receipt = {"schema": RECEIPT_SCHEMA, "occurrence_id": OCCURRENCE, "analysis_request_id": None,
                   "created_at": created_at, "migration_id": migration_id, "plan_sha256": plan_sha, **facts}
        # facts.profile describes the compiler; receipt.schema is the independent
        # immutable journal document, never a natural execution observation.
        receipt_raw = kernel._json(receipt).decode("ascii")
        receipt_row = (2, machine.OWNER_MACHINE_SCHEMA_VERSION, "observation", record_id, OCCURRENCE, None,
                       created_at, receipt_raw, _sha(receipt_raw.encode("ascii")))
        names = ("rowid", *journal_columns)
        steps.append(kernel.Statement("receipt:insert", 'INSERT INTO owner_machine_journal('
            + ",".join('"' + name + '"' for name in names) + ") VALUES (" + ",".join("?" for _ in receipt_row) + ")", receipt_row))
        steps.append(kernel._guard("receipt:changes-one", "changes()=1"))
        target["owner_machine_journal"] = (journal_columns, [*marker_rows, receipt_row])
        steps.extend(kernel._row_guards("owner_machine_journal", journal_columns, target["owner_machine_journal"][1], budget))
        body, specs, requests = kernel._pipeline(tuple(steps))
        if any(type(value) is float for row in specs for value in row[2]):
            _fail("packet_integrity_invalid")
        meta = {**facts, "plan_sha256": plan_sha, "packet_sha256": _sha(body), "packet_bytes": len(body),
                "batch_steps": len(specs), "source_row_count": sum(len(rows) for _, rows in records.values()),
                "target_row_count": sum(len(rows) for _, rows in target.values()), "object_count": len(target_schema),
                "legacy_rows_unchanged": True, "physical_schema_version": 9, **_FLAGS}
        if _current_code() != code:
            _fail("code_drift")
        budget.check()
        return body, tuple(sorted(meta.items())), specs, requests, target_schema, target
    finally:
        reference.close()


def _closed(error):
    if isinstance(error, MachineUpgradeError):
        raise error
    if isinstance(error, (kernel.CompilerError, offline.UpgradeError)):
        text = str(error)
        _fail("operation_timeout" if "time_limit" in text else "capacity_exhausted" if "limit" in text else "source_integrity_invalid")
    _fail("source_unavailable")


@dataclass(frozen=True, slots=True, repr=False)
class CompiledMachineUpgrade:
    body: bytes
    metadata: tuple
    statement_specs: tuple
    request_specs: tuple
    _source_image: bytes = field(repr=False)
    _resource_sha256: str = field(repr=False)
    _created_at: str = field(repr=False)

    def __post_init__(self):
        # A caller-created/replaced dataclass is not a qualification. The safe
        # getters always rebuild; construction also rejects unbounded/non-native
        # fields before it can be mistaken for the bounded compiler output.
        if (type(self.body) is not bytes or not 1 <= len(self.body) <= kernel.MAX_PACKET_BYTES
                or type(self._source_image) is not bytes or len(self._source_image) > kernel.MAX_IMAGE_BYTES
                or any(type(value) is not tuple for value in (self.metadata, self.statement_specs, self.request_specs))):
            _fail("packet_integrity_invalid")
        kernel._native_frozen((self.metadata, self.statement_specs, self.request_specs))
        _identity(self._resource_sha256); _stamp(self._created_at)

    def _validated(self, *, budget=None):
        expected = _build(self._source_image, self._resource_sha256, self._created_at, budget=budget)
        if not all(kernel._same_native(a, b) for a, b in zip(
                (self.body, self.metadata, self.statement_specs, self.request_specs), expected[:4])):
            _fail("packet_integrity_invalid")
        return expected

    @property
    def safe_metadata(self):
        try:
            self._validated()
            return dict(self.metadata)
        except Exception as error:
            _closed(error)

    def artifact(self):
        try:
            self._validated()
            return {"profile": ARTIFACT_PROFILE, "body": self.body, "metadata": self.metadata,
                    "statement_specs": self.statement_specs, "request_specs": self.request_specs}
        except Exception as error:
            _closed(error)


def compile_machine_upgrade(source, *, expected_source_image_sha256, expected_resource_sha256, created_at):
    """Compile from a caller-owned query_only snapshot, never open a file/URL."""
    try:
        budget = _budget()
        _identity(expected_source_image_sha256); _identity(expected_resource_sha256); _stamp(created_at)
        if (type(source) is not sqlite3.Connection or source.in_transaction
                or tuple(source.execute("PRAGMA query_only").fetchone()) != (1,)
                or tuple(source.execute("PRAGMA foreign_keys").fetchone()) != (1,)
                or any(row[1] not in {"main", "temp"} for row in source.execute("PRAGMA database_list"))
                or source.execute("SELECT 1 FROM sqlite_temp_master LIMIT 1").fetchone() is not None):
            _fail("source_unavailable")
        with _source_read_snapshot(source, budget):
            image = source.serialize()
            if _sha(image) != expected_source_image_sha256:
                _fail("source_identity_mismatch")
            result = _build(image, expected_resource_sha256, created_at, budget=budget)
            # Still the same bounded SQLite read snapshot, not a new allocation
            # against possibly grown pages outside the original observation.
            if not source.in_transaction:
                _fail("source_unavailable")
            if _sha(source.serialize()) != expected_source_image_sha256:
                _fail("source_identity_mismatch")
        budget.check()
        return CompiledMachineUpgrade(*result[:4], image, expected_resource_sha256, created_at)
    except Exception as error:
        _closed(error)


def rehydrate_machine_upgrade(source, artifact, *, expected_source_image_sha256, expected_resource_sha256,
                               expected_plan_sha256, expected_packet_sha256):
    """Recompile against independent original SHA values; no send/replay power."""
    try:
        budget = _budget()
        _identity(expected_plan_sha256); _identity(expected_packet_sha256)
        if type(artifact) is not dict or set(artifact) != {"profile", "body", "metadata", "statement_specs", "request_specs"} or artifact["profile"] != ARTIFACT_PROFILE:
            _fail("packet_integrity_invalid")
        values = dict(artifact["metadata"])
        if values.get("plan_sha256") != expected_plan_sha256 or values.get("packet_sha256") != expected_packet_sha256:
            _fail("packet_integrity_invalid")
        packet = compile_machine_upgrade(source, expected_source_image_sha256=expected_source_image_sha256,
            expected_resource_sha256=expected_resource_sha256, created_at=values.get("created_at"))
        budget.check()
        packet._validated(budget=budget)
        expected_artifact = {"profile": ARTIFACT_PROFILE, "body": packet.body, "metadata": packet.metadata,
                             "statement_specs": packet.statement_specs, "request_specs": packet.request_specs}
        if not kernel._same_native(artifact, expected_artifact):
            _fail("packet_integrity_invalid")
        budget.check()
        return packet
    except Exception as error:
        _closed(error)


def rehearse_machine_upgrade(packet):
    """Execute the exact compiled statements only in a fresh owned memory DB."""
    conn = None
    try:
        budget = _budget()
        if type(packet) is not CompiledMachineUpgrade:
            _fail("packet_integrity_invalid")
        expected = packet._validated(budget=budget)
        # The validated image retains the original raw SQL spelling; executing
        # captured DDL to reproduce it would violate the admission boundary.
        # Deserialize only AFTER full fixed-schema/value validation above.
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.enable_load_extension(False)
        conn.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
        conn.deserialize(packet._source_image)
        conn.set_progress_handler(budget.progress, 1000)
        conn.execute("PRAGMA foreign_keys=ON")
        for label, sql, args, want_rows, _result in packet.statement_specs:
            if label == "rollback":
                continue
            cursor = conn.execute(sql, args)
            if want_rows and tuple(tuple(row) for row in cursor) != ((1,),):
                _fail("rehearsal_failed")
            budget.check()
        profile.inspect_machine_profile_snapshot([conn.execute(sql, args) for sql, args in profile.machine_profile_reads()])
        if _schema(conn) != expected[4] or offline._rows_digest(_records(conn, offline._objects(conn), budget)) != offline._rows_digest(expected[5]):
            _fail("rehearsal_failed")
        metadata = dict(packet.metadata)
        result = {"profile": PROFILE, "rehearsed": True, "source_image_sha256": metadata["source_image_sha256"],
                  "packet_sha256": metadata["packet_sha256"], "legacy_rows_unchanged": True, **_FLAGS}
        budget.check(); _current_code(); budget.check()
        return result
    except Exception as error:
        _closed(error)
    finally:
        if conn is not None:
            conn.close()


def machine_upgrade_readback_plan(packet):
    """Fixed reads for one explicit consistent read batch, no transport.

    A future caller must bound the whole response and execute these reads in
    one deferred transaction. This tuple is not a verified Hrana response.
    """
    try:
        if type(packet) is not CompiledMachineUpgrade:
            _fail("packet_integrity_invalid")
        expected = packet._validated()
        tables = sorted(expected[5])
        return (("SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name LIMIT 129", ()),
            ("PRAGMA user_version", ()), ("PRAGMA foreign_keys", ()), ("PRAGMA database_list", ()),
            ("SELECT 1 FROM sqlite_temp_master LIMIT 1", ()), ("PRAGMA foreign_key_check", ()), ("PRAGMA quick_check(1)", ()),
            *((f'SELECT rowid,* FROM main."{table}" ORDER BY rowid LIMIT 100001', ()) for table in tables))
    except Exception as error:
        _closed(error)


def reconcile_machine_upgrade_local(conn, packet):
    """Classify an explicit local read only; missing is NEVER replay authority."""
    decoder = None
    try:
        budget = _budget()
        if (type(conn) is not sqlite3.Connection or type(packet) is not CompiledMachineUpgrade
                or conn.in_transaction or tuple(conn.execute("PRAGMA foreign_keys").fetchone()) != (1,)
                or any(row[1] not in {"main", "temp"} for row in conn.execute("PRAGMA database_list"))
                or conn.execute("SELECT 1 FROM sqlite_temp_master LIMIT 1").fetchone() is not None):
            _fail("source_unavailable")
        expected = packet._validated(budget=budget)
        with _source_read_snapshot(conn, budget):
            image = conn.serialize()
        if len(image) > kernel.MAX_IMAGE_BYTES:
            _fail("capacity_exhausted")
        decoder = sqlite3.connect(":memory:")
        decoder.row_factory = sqlite3.Row
        decoder.enable_load_extension(False)
        decoder.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
        decoder.deserialize(image)
        decoder.execute("PRAGMA query_only=ON")
        decoder.set_progress_handler(budget.progress, 1000)
        raw = _schema(decoder)
        header = decoder.execute("PRAGMA user_version").fetchone()[0]
        if type(header) is not int or header != dict(packet.metadata)["source_user_version"]:
            _fail("source_integrity_invalid")
        if raw == expected[4]:
            rows = _records(decoder, offline._objects(decoder), budget)
            matched = offline._rows_digest(rows) == offline._rows_digest(expected[5])
            result = {"status": "matched" if matched else "unknown", **_FLAGS}
            budget.check(); _current_code(); budget.check()
            return result
        source, before, records, _manifest, _header = _admit(packet._source_image, budget)
        source.close()
        missing = raw == before and offline._rows_digest(_records(decoder, offline._objects(decoder), budget)) == offline._rows_digest(records)
        result = {"status": "missing" if missing else "unknown", **_FLAGS}
        budget.check(); _current_code(); budget.check()
        return result
    except Exception:
        return {"status": "unknown", **_FLAGS}
    finally:
        if decoder is not None:
            decoder.close()
