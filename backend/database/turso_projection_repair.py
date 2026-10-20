"""Explicit local-only repair rehearsal for two redundant Evidence REAL cells.

This is not a tolerant migration validator or an apply implementation. The
unchanged strict scope migration must accept the repaired private memory copy.
The original closed SQLite input, immutable payloads, IDs and payload digests
are never written. No configured database, credential, transport or input DDL
is executed. Returned metadata contains no row identifiers or business values.
"""
from __future__ import annotations

from datetime import datetime
import json
import math
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import sqlite3
import stat
import struct
import time

from database import turso_scope_upgrade as offline
from models.v8 import EvidenceSnapshot, canonical_json, payload_sha256, stable_id
from service import repository_scopes as scopes


PROFILE = "evidence-real-projection-repair-v1"
EVIDENCE_SCOPE = "local_evidence_projection_repair_rehearsal"
REPAIR_COLUMNS = ("estimate", "estimate_coverage")
TIME_BUDGET_SECONDS = 30.0
_WINDOWS_PATHS = os.name == "nt"
ERROR_CODES = offline.ERROR_CODES | frozenset({
    "source_binding_mismatch", "repair_binding_mismatch", "repair_not_needed",
    "repair_admission_failed", "repair_difference_invalid", "repair_image_mismatch",
    "repair_recovery_mismatch", "projection_repair_failed",
})


class ProjectionRepairError(Exception):
    """Closed, non-sensitive error code, never the underlying exception text."""

    def __init__(self, code):
        super().__init__(code if type(code) is str and code in ERROR_CODES else "projection_repair_failed")


def _fail(code):
    raise ProjectionRepairError(code)


def _code_digest():
    # The existing full strict-validator/producer binding plus this new module.
    project = Path(__file__).resolve().parents[2]
    return offline._digest(offline._json_bytes([
        ["strict_contract", offline._code_digest()],
        ["projection_repair", offline._digest(Path(__file__).read_bytes())],
        ["projection_repair_cli", offline._digest((project / "tools/turso_projection_repair.py").read_bytes())],
    ]))


def _source_path(source, budget):
    # Lexical admission MUST precede absolute()/lstat()/SQLite. UNC metadata
    # lookup may itself negotiate SMB/system credentials, before any socket
    # guard in Python can observe it. Device/NT namespaces are not snapshots.
    try:
        name = os.fspath(source)
    except (TypeError, ValueError):
        _fail("source_unavailable")
    if type(name) is not str or not name or "\x00" in name:
        _fail("source_unavailable")
    slashes = name.replace("\\", "/")
    windows = PureWindowsPath(name)
    if (slashes.startswith("//") or name.startswith("\\")
            or slashes.lower().startswith(("/??/", "/device/", "/global??/", "/dosdevices/"))):
        _fail("source_link_rejected")
    if windows.drive:
        if (len(windows.drive) != 2 or not windows.drive[0].isascii()
                or not windows.drive[0].isalpha() or windows.drive[1] != ":"
                or not windows.is_absolute()):
            _fail("source_link_rejected")
        if any(PureWindowsPath(part).is_reserved() for part in windows.parts[1:]):
            _fail("source_link_rejected")
    elif _WINDOWS_PATHS or not PurePosixPath(name).is_absolute():
        _fail("source_link_rejected")
    # Also reject linked/reparse ancestors, not only the selected filename.
    try:
        selected = Path(name).absolute()
        for component in (selected, *selected.parents):
            info = component.lstat()
            if (stat.S_ISLNK(info.st_mode)
                    or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                _fail("source_link_rejected")
    except (OSError, ValueError, TypeError):
        _fail("source_unavailable")
    return offline._source_path(selected, budget)


def _same(left, right):
    return type(left) is type(right) and (left.hex() == right.hex() if type(left) is float else left == right)


def _real_bits(value):
    if (type(value) is not float or not math.isfinite(value)
            or (value == 0.0 and math.copysign(1.0, value) < 0)):
        _fail("repair_difference_invalid")
    bits = struct.unpack(">Q", struct.pack(">d", value))[0]
    return (~bits & ((1 << 64) - 1)) if bits >> 63 else bits | (1 << 63)


def _derive(records, budget):
    """Narrow admission only; the original backfill remains final authority.

    Decode exactly as backfill (Python JSON -> model_validate, not a different
    JSON-mode parser). Never synthesize/coerce payload fields or repair NULLs.
    All full roots/derived lineage validation still runs on the repaired image.
    """
    columns, rows = records["evidence_snapshots"]
    indexes = {name: index + 1 for index, name in enumerate(columns)}
    repaired_rows, deltas = [], []
    for row in rows:
        budget.check()
        values = dict(zip(columns, row[1:]))
        try:
            payload = json.loads(values["payload_json"])
            if (type(payload) is not dict or payload.get("evidence_id") != values["evidence_id"]
                    or scopes._reserved(payload)):
                _fail("repair_admission_failed")
            model = EvidenceSnapshot.model_validate(payload).model_dump(mode="python")
            if canonical_json(payload) != canonical_json(model):
                _fail("repair_admission_failed")
            semantic = {key: value for key, value in model.items() if key not in ("created_at", "evidence_id")}
            if (values["evidence_id"] != stable_id("ev", semantic)
                    or values["payload_sha256"] != payload_sha256(semantic)):
                _fail("repair_admission_failed")
            changed = list(row)
            for name, value in values.items():
                model_name = name.removesuffix("_json") if name.endswith("_json") else name
                model_name = {"invalidation": "invalidation_conditions"}.get(model_name, model_name)
                if model_name not in model:
                    continue
                projected = json.loads(value) if name.endswith("_json") and value is not None else value
                expected = model[model_name]
                if isinstance(expected, datetime) and isinstance(projected, str):
                    projected = datetime.fromisoformat(projected)
                if name in REPAIR_COLUMNS:
                    # Even equal cells must not hide a NULL/type/zero-sign
                    # distinction. NULL/NULL is preserved, never repaired.
                    if projected is None and expected is None:
                        continue
                    before, after = _real_bits(projected), _real_bits(expected)
                    if before == after:
                        continue
                    if abs(before - after) != 1:
                        _fail("repair_difference_invalid")
                    changed[indexes[name]] = expected
                    deltas.append((row[0], values["evidence_id"], values["payload_sha256"],
                                   name, projected.hex(), expected.hex()))
                elif canonical_json(projected) != canonical_json(expected):
                    _fail("repair_admission_failed")
            repaired_rows.append(tuple(changed))
        except ProjectionRepairError:
            raise
        except (ValueError, TypeError, KeyError, OverflowError):
            _fail("repair_admission_failed")
    if not deltas:
        _fail("repair_not_needed")
    # The original records and all tuples/cells are retained unchanged. Only
    # this independent table-list is replaced; no live SQLite row is updated.
    repaired = {table: (names, list(items)) for table, (names, items) in records.items()}
    repaired["evidence_snapshots"] = (columns, repaired_rows)
    _verify_difference(records, repaired, tuple(deltas), budget)
    return repaired, tuple(deltas)


def _verify_difference(before, after, deltas, budget):
    if before.keys() != after.keys():
        _fail("repair_image_mismatch")
    observed = []
    for table, (columns, rows) in sorted(before.items()):
        names, changed = after[table]
        if columns != names or len(rows) != len(changed):
            _fail("repair_image_mismatch")
        for original, repaired in zip(rows, changed):
            budget.check()
            if len(original) != len(repaired) or not _same(original[0], repaired[0]):
                _fail("repair_image_mismatch")
            for index, (left, right) in enumerate(zip(original[1:], repaired[1:]), 1):
                if _same(left, right):
                    continue
                name = columns[index - 1]
                if table != "evidence_snapshots" or name not in REPAIR_COLUMNS:
                    _fail("repair_image_mismatch")
                if abs(_real_bits(left) - _real_bits(right)) != 1:
                    _fail("repair_image_mismatch")
                observed.append((original[0], original[columns.index("evidence_id") + 1],
                                 original[columns.index("payload_sha256") + 1], name, left.hex(), right.hex()))
    if sorted(observed) != sorted(deltas) or len(observed) != len(deltas):
        _fail("repair_image_mismatch")


def _new_repaired(records, objects, header, source_kind, options, budget):
    conn = offline._source_reference(source_kind, budget, **options)
    try:
        offline._seed_memory(conn, records)
        conn.execute(f"PRAGMA user_version={header}")
        offline._integrity(conn)
        roundtrip = offline._snapshot_rows(conn, objects, offline._Budget(budget.deadline))
        if offline._rows_digest(roundtrip) != offline._rows_digest(records):
            _fail("repair_image_mismatch")
        return conn
    except Exception:
        conn.close()
        raise


def _upgrade(conn, source_kind, repaired, budget):
    # These are the existing complete strict root/projection/derived lineage
    # migration and repository readback. No monkeypatch, epsilon or fallback.
    offline._scope_upgrade(conn, source_kind, budget)
    offline._repository_readback(conn, budget)
    target = offline._snapshot_rows(conn, offline._objects(conn), offline._Budget(budget.deadline))
    retained = {table: target[table] for table in repaired}
    if (offline._rows_digest(retained, exclude=("_schema_version",))
            != offline._rows_digest(repaired, exclude=("_schema_version",))):
        _fail("legacy_rows_changed")
    return target


def _run(source, *, source_kind, expected_source_sha256, operational_profile, expected_repair_sha256, recover):
    if (type(source_kind) is not str or source_kind not in offline.SOURCE_KINDS
            or type(operational_profile) is not str or operational_profile not in offline.OPERATIONAL_PROFILES):
        _fail("invalid_arguments")
    for digest in (expected_source_sha256, expected_repair_sha256):
        if digest is not None and (type(digest) is not str or not offline._DIGEST.fullmatch(digest)):
            _fail("invalid_expected_digest")
    if expected_source_sha256 is None or (recover and expected_repair_sha256 is None):
        _fail("invalid_expected_digest")
    budget = offline._Budget(time.monotonic() + TIME_BUDGET_SECONDS)
    opened = []
    try:
        path, source_sha = _source_path(source, budget)
        if source_sha != expected_source_sha256:
            _fail("source_binding_mismatch")
        code_sha = _code_digest()
        definitions_sha = offline._operational_definitions_digest()
        source_conn = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
        opened.append(source_conn)
        source_conn.row_factory = sqlite3.Row
        source_conn.enable_load_extension(False)
        source_conn.execute("PRAGMA query_only=ON")
        source_conn.execute("PRAGMA trusted_schema=OFF")
        source_conn.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, offline.MAX_CELL_BYTES)
        source_conn.set_progress_handler(budget.progress, 1000)
        source_objects = offline._objects(source_conn)
        optional = frozenset(name for name in offline._OPERATIONAL_DEFINITIONS
                             if ("table", name) in source_objects) if operational_profile == "known-operational-v1" else frozenset()
        options = dict(optimizer_statistics=("table", "sqlite_stat1") in source_objects,
                       operational_objects=optional)
        reference = offline._source_reference(source_kind, budget, **options)
        opened.append(reference)
        objects = offline._objects(reference)
        offline._check_objects(source_conn, objects)
        header = source_conn.execute("PRAGMA user_version").fetchone()[0]
        if ((source_kind == "local-header" and header != 8)
                or (source_kind == "remote-schema-table" and header not in (0, 8))):
            _fail("source_version_invalid")
        if source_kind == "remote-schema-table":
            if tuple(tuple(row) for row in source_conn.execute("SELECT rowid,singleton,version FROM _schema_version")) != ((1, 1, 8),):
                _fail("source_version_invalid")
        offline._integrity(source_conn)
        records = offline._snapshot_rows(source_conn, objects, budget)
        original_image = offline._serialize_backup(source_conn)
        if _source_path(path, budget)[1] != source_sha:
            _fail("source_drift_detected")
        source_conn.close()
        opened.remove(source_conn)
        # Validate lineage in a canonical original memory copy before even
        # deriving a repair. This does not replace the later strict backfill.
        offline._seed_memory(reference, records)
        reference.execute(f"PRAGMA user_version={header}")
        offline._integrity(reference)
        scopes._validate_legacy_lineages(reference)
        source_rows_sha = offline._rows_digest(records)
        original_image_sha = offline._digest(original_image)
        repaired, deltas = _derive(records, budget)
        repaired_conn = _new_repaired(repaired, objects, header, source_kind, options, budget)
        opened.append(repaired_conn)
        repaired_image_sha = offline._digest(offline._serialize_backup(repaired_conn))
        repaired_rows_sha = offline._rows_digest(repaired)
        target = _upgrade(repaired_conn, source_kind, repaired, budget)
        binding = dict(profile=PROFILE, source_kind=source_kind, source_file_sha256=source_sha,
                       source_image_sha256=original_image_sha, source_rows_sha256=source_rows_sha,
                       source_contract_sha256=offline._contract_digest(objects),
                       operational_profile=operational_profile, operational_definitions_sha256=definitions_sha,
                       repair_delta_sha256=offline._digest(offline._json_bytes(deltas)),
                       repaired_image_sha256=repaired_image_sha, repaired_rows_sha256=repaired_rows_sha,
                       target_contract_sha256=offline._contract_digest(offline._objects(repaired_conn)),
                       target_rows_sha256=offline._rows_digest(target), code_sha256=code_sha)
        repair_sha = offline._digest(offline._json_bytes(binding))
        if expected_repair_sha256 is not None and repair_sha != expected_repair_sha256:
            _fail("repair_binding_mismatch")
        if recover:
            # Start from the ORIGINAL source serialize, never repaired8/target9.
            restored = offline._restore_image(original_image, original_image_sha, budget)
            opened.append(restored)
            offline._check_objects(restored, objects)
            if restored.execute("PRAGMA user_version").fetchone()[0] != header:
                _fail("restored_source_mismatch")
            restored_records = offline._snapshot_rows(restored, objects, offline._Budget(budget.deadline))
            if offline._rows_digest(restored_records) != source_rows_sha:
                _fail("restored_source_mismatch")
            scopes._validate_legacy_lineages(restored)
            rebuilt, rebuilt_deltas = _derive(restored_records, budget)
            if (rebuilt_deltas != deltas or offline._rows_digest(rebuilt) != repaired_rows_sha
                    or offline._digest(offline._json_bytes(rebuilt_deltas)) != binding["repair_delta_sha256"]):
                _fail("repair_recovery_mismatch")
            recovered = _new_repaired(rebuilt, objects, header, source_kind, options, budget)
            opened.append(recovered)
            if offline._digest(offline._serialize_backup(recovered)) != repaired_image_sha:
                _fail("repair_recovery_mismatch")
            recovered_target = _upgrade(recovered, source_kind, rebuilt, budget)
            if offline._rows_digest(recovered_target) != binding["target_rows_sha256"]:
                _fail("restored_target_mismatch")
        if (_source_path(path, budget)[1] != source_sha or _code_digest() != code_sha
                or offline._operational_definitions_digest() != definitions_sha):
            _fail("source_or_code_drift_detected")
        budget.check()
        return dict(ok=True, command="rehearse" if recover else "plan", evidence_scope=EVIDENCE_SCOPE,
                    from_schema=8, to_schema=9, repair_sha256=repair_sha,
                    repaired_cell_count=len(deltas), repaired_row_count=len({delta[0] for delta in deltas}),
                    estimate_repaired_cell_count=sum(delta[3] == "estimate" for delta in deltas),
                    estimate_coverage_repaired_cell_count=sum(delta[3] == "estimate_coverage" for delta in deltas),
                    source_row_count=sum(len(rows) for _, rows in records.values()), table_count=len(records),
                    source_file_unchanged=True, legacy_rows_unchanged=False,
                    immutable_payloads_ids_hashes_unchanged=True, only_declared_projection_cells_changed=True,
                    repository_roots_readback_verified=True, local_original_recovery_verified=recover,
                    remote_verified=False, remote_applied=False, remote_restore_verified=False,
                    formal_release_verified=False, remote_write_attempted=False, **binding)
    except ProjectionRepairError:
        raise
    except offline.UpgradeError as error:
        raise ProjectionRepairError(str(error)) from None
    except (sqlite3.Error, ValueError, TypeError, KeyError, OverflowError, OSError):
        raise ProjectionRepairError("projection_repair_failed") from None
    finally:
        close_failed = False
        for conn in reversed(opened):
            try:
                conn.close()
            except sqlite3.Error:
                close_failed = True
        if close_failed:
            raise ProjectionRepairError("projection_repair_failed") from None


def plan_projection_repair(source, *, source_kind, expected_source_sha256, operational_profile="core-only"):
    """Explicit plan: strict full migration in private memory, no recovery/apply."""
    return _run(source, source_kind=source_kind, expected_source_sha256=expected_source_sha256,
                operational_profile=operational_profile, expected_repair_sha256=None, recover=False)


def rehearse_projection_repair(source, *, source_kind, expected_source_sha256,
                              expected_repair_sha256, operational_profile="core-only"):
    """Re-derive the pinned plan, independently recover original8, then repeat."""
    return _run(source, source_kind=source_kind, expected_source_sha256=expected_source_sha256,
                operational_profile=operational_profile, expected_repair_sha256=expected_repair_sha256, recover=True)
