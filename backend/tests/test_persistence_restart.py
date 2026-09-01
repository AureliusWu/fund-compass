import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
LEDGER_PROCESS = Path(__file__).with_name("persistence_ledger_process.py")


def _run_backend_command(
    command: list[str],
    database_path: Path,
    *,
    expect_success: bool = True,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["FUND_DB"] = str(database_path)
    existing_pythonpath = env.get("PYTHONPATH")
    env["PYTHONPATH"] = str(BACKEND) + (
        os.pathsep + existing_pythonpath if existing_pythonpath else ""
    )
    # A local file demonstrates restart survival, not a verified production
    # mount. Keep health in the honest, non-durable state for this test.
    env.pop("FUND_DB_PERSISTENCE", None)
    env.pop("FUND_DB_MOUNT_PATH", None)
    result = subprocess.run(
        command,
        cwd=BACKEND,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if expect_success:
        assert result.returncode == 0, (
            f"subprocess failed with exit {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def _run_backend_process(script: str, database_path: Path) -> subprocess.CompletedProcess[str]:
    return _run_backend_command([sys.executable, "-c", script], database_path)


def _run_ledger_process(
    mode: str,
    database_path: Path,
    *,
    expect_success: bool = True,
) -> subprocess.CompletedProcess[str]:
    return _run_backend_command(
        [sys.executable, str(LEDGER_PROCESS), mode],
        database_path,
        expect_success=expect_success,
    )


def _verified_sqlite_backup(source_path: Path, restored_path: Path) -> None:
    from database import db

    source = sqlite3.connect(source_path)
    try:
        assert db._publish_verified_backup(
            source,
            restored_path,
            context="V8 recovery backup",
        ) == restored_path.resolve()
    finally:
        source.close()
    restored = sqlite3.connect(restored_path)
    try:
        assert restored.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"
        assert restored.execute("PRAGMA integrity_check(1)").fetchone()[0] == "ok"
        assert restored.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        restored.close()


def test_sqlite_record_survives_real_process_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "persistent" / "fund_compass.db"
    writer = """
from database import db
db.init_db()
with db.transaction(immediate=True) as conn:
    conn.execute(
        '''INSERT INTO idempotency_responses(
               request_id, endpoint, request_sha256, state, response_json,
               owner_token, lease_expires_at, created_at, completed_at
           ) VALUES (?, ?, ?, 'complete', ?, NULL, NULL, ?, ?)''',
        ('restart-proof', '/persistence-gate', 'a' * 64, '{"survived":true}',
         '2026-08-29T00:00:00+00:00', '2026-08-29T00:00:00+00:00'),
    )
"""
    reader = """
from database import db
db.init_db()
with db.get_conn() as conn:
    row = conn.execute(
        'SELECT response_json FROM idempotency_responses WHERE request_id=? AND endpoint=?',
        ('restart-proof', '/persistence-gate'),
    ).fetchone()
    assert row is not None and row['response_json'] == '{"survived":true}'
    assert conn.execute('PRAGMA user_version').fetchone()[0] == db.V8_SCHEMA_VERSION
    assert conn.execute('PRAGMA quick_check(1)').fetchone()[0] == 'ok'
    assert conn.execute('PRAGMA integrity_check(1)').fetchone()[0] == 'ok'
    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
assert db.persistence_status()['durable'] is False
"""

    _run_backend_process(writer, database_path)
    _run_backend_process(reader, database_path)


def test_v8_full_ledger_survives_process_restart_and_backup_restore(tmp_path: Path) -> None:
    database_path = tmp_path / "live" / "fund_compass.db"
    restored_path = tmp_path / "recovery" / "fund_compass-restored.db"

    writer = _run_ledger_process("write", database_path)
    assert "full-ledger-write-ok" in writer.stdout

    restarted = _run_ledger_process("read", database_path)
    assert "full-ledger-read-ok" in restarted.stdout

    _verified_sqlite_backup(database_path, restored_path)
    restored = _run_ledger_process("read", restored_path)
    assert "full-ledger-read-ok" in restored.stdout
    assert list(tmp_path.rglob("*.partial")) == []


def test_v8_full_ledger_reader_rejects_missing_source_health_audit(tmp_path: Path) -> None:
    database_path = tmp_path / "tampered" / "fund_compass.db"
    _run_ledger_process("write", database_path)
    conn = sqlite3.connect(database_path)
    try:
        conn.execute("DROP TRIGGER immutable_source_health_events_delete")
        conn.execute("DELETE FROM source_health_events")
        conn.commit()
    finally:
        conn.close()

    rejected = _run_ledger_process(
        "read",
        database_path,
        expect_success=False,
    )
    assert rejected.returncode != 0
    assert "AssertionError" in rejected.stderr


def test_render_blueprint_stays_free_and_paid_blueprint_is_absent() -> None:
    active = yaml.safe_load((ROOT / "render.yaml").read_text(encoding="utf-8"))
    active_service = active["services"][0]

    assert active_service["plan"] == "free"
    assert "disk" not in active_service
    assert {item["key"]: item.get("value") for item in active_service["envVars"]}[
        "FUND_DB_PERSISTENCE"
    ] == "ephemeral"
    assert not (ROOT / "render-persistent.yaml").exists()
