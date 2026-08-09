from pathlib import Path

from database import db

import main


def test_persistence_status_never_assumes_default_storage_is_durable(monkeypatch):
    monkeypatch.delenv("FUND_DB_PERSISTENCE", raising=False)
    monkeypatch.delenv("FUND_DB", raising=False)
    monkeypatch.delenv("FUND_DB_MOUNT_PATH", raising=False)

    result = db.persistence_status()

    assert result["persistence"] == "unspecified"
    assert result["durable"] is False
    assert result["warning"]
    assert "path" not in result


def test_persistence_status_reports_ephemeral_without_storage_probe(monkeypatch):
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "ephemeral")
    monkeypatch.setattr(
        db.os.path,
        "ismount",
        lambda _path: (_ for _ in ()).throw(AssertionError("unexpected mount probe")),
    )

    result = db.persistence_status()

    assert result["persistence"] == "ephemeral"
    assert result["durable"] is False
    assert result["warning"]


def test_persistence_status_accepts_verified_writable_mount(tmp_path, monkeypatch):
    mount_path = tmp_path / "mounted-data"
    mount_path.mkdir()
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(mount_path / "fund_compass.db"))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))
    monkeypatch.setattr(db.os.path, "ismount", lambda path: Path(path) == mount_path.resolve())
    monkeypatch.setattr(db.os, "access", lambda path, mode: Path(path) == mount_path.resolve())

    result = db.persistence_status()

    assert result == {
        "engine": "sqlite",
        "persistence": "persistent_disk",
        "durable": True,
        "warning": None,
    }


def test_persistence_status_rejects_missing_explicit_database_path(tmp_path, monkeypatch):
    mount_path = tmp_path / "mounted-data"
    mount_path.mkdir()
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.delenv("FUND_DB", raising=False)
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path)


def test_persistence_status_rejects_missing_explicit_mount_path(tmp_path, monkeypatch):
    database_path = tmp_path / "sensitive-database-name.db"
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(database_path))
    monkeypatch.delenv("FUND_DB_MOUNT_PATH", raising=False)

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, database_path)


def test_persistence_status_rejects_relative_paths(monkeypatch):
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", "private/relative.db")
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", "private")

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, "private/relative.db", "private")


def test_persistence_status_rejects_filesystem_root_as_mount(tmp_path, monkeypatch):
    mount_path = Path(tmp_path.anchor)
    database_path = mount_path / "sensitive-database-name.db"
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(database_path))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))
    monkeypatch.setattr(db.os.path, "ismount", lambda _path: True)
    monkeypatch.setattr(db.os, "access", lambda _path, _mode: True)

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path, database_path)


def test_persistence_status_rejects_database_outside_mount(tmp_path, monkeypatch):
    mount_path = tmp_path / "mounted-data"
    mount_path.mkdir()
    database_path = tmp_path / "outside" / "sensitive-database-name.db"
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(database_path))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path, database_path)


def test_persistence_status_rejects_missing_mount(tmp_path, monkeypatch):
    mount_path = tmp_path / "missing-mounted-data"
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(mount_path / "fund_compass.db"))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path)


def test_persistence_status_rejects_mount_path_that_is_a_file(tmp_path, monkeypatch):
    mount_path = tmp_path / "not-a-directory"
    mount_path.write_text("not a mount", encoding="utf-8")
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(mount_path / "fund_compass.db"))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path)


def test_persistence_status_rejects_directory_that_is_not_a_mount(tmp_path, monkeypatch):
    mount_path = tmp_path / "ordinary-directory"
    mount_path.mkdir()
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(mount_path / "fund_compass.db"))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))
    monkeypatch.setattr(db.os.path, "ismount", lambda _path: False)

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path)


def test_persistence_status_rejects_unwritable_mount(tmp_path, monkeypatch):
    mount_path = tmp_path / "read-only-mounted-data"
    mount_path.mkdir()
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(mount_path / "fund_compass.db"))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))
    monkeypatch.setattr(db.os.path, "ismount", lambda _path: True)
    monkeypatch.setattr(db.os, "access", lambda _path, _mode: False)

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path)


def test_persistence_status_rejects_mount_probe_error(tmp_path, monkeypatch):
    mount_path = tmp_path / "unreadable-mounted-data"
    mount_path.mkdir()
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    monkeypatch.setenv("FUND_DB", str(mount_path / "fund_compass.db"))
    monkeypatch.setenv("FUND_DB_MOUNT_PATH", str(mount_path))
    monkeypatch.setattr(
        db.os.path,
        "ismount",
        lambda _path: (_ for _ in ()).throw(OSError("mount probe failed")),
    )

    result = db.persistence_status()

    _assert_misconfigured_without_path(result, mount_path)


def _assert_misconfigured_without_path(result, *sensitive_paths):
    assert result["persistence"] == "misconfigured"
    assert result["durable"] is False
    assert result["warning"]
    assert "path" not in result
    for sensitive_path in sensitive_paths:
        assert str(sensitive_path) not in result["warning"]


def test_health_exposes_index_freshness_and_database_mode(monkeypatch):
    index_status = {
        "loaded": True, "usable": False, "stale": True, "age_days": 8,
        "max_age_days": 7, "updated": "2026-07-31", "indices": 3, "source": "test",
    }
    database_status = {
        "engine": "sqlite", "persistence": "ephemeral", "durable": False, "warning": "test",
    }
    monkeypatch.setattr(main, "index_valuation_status", lambda: index_status)
    monkeypatch.setattr(main, "persistence_status", lambda: database_status)
    monkeypatch.setattr(main.repo, "universe_count", lambda: 10)
    monkeypatch.setattr(main.repo, "operations_status", lambda: {})
    monkeypatch.setattr(main.eastmoney, "source_health", lambda: {})
    monkeypatch.setattr(main, "registry_summary", lambda: {})

    result = main.health()

    assert result["index_valuation"] == index_status
    assert result["database"] == database_status
