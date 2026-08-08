from database.db import persistence_status

import main


def test_persistence_status_never_assumes_default_storage_is_durable(monkeypatch):
    monkeypatch.delenv("FUND_DB_PERSISTENCE", raising=False)

    result = persistence_status()

    assert result["persistence"] == "unspecified"
    assert result["durable"] is False
    assert result["warning"]
    assert "path" not in result


def test_persistence_status_distinguishes_ephemeral_and_disk(monkeypatch):
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "ephemeral")
    ephemeral = persistence_status()
    monkeypatch.setenv("FUND_DB_PERSISTENCE", "persistent_disk")
    persistent = persistence_status()

    assert ephemeral["durable"] is False
    assert ephemeral["warning"]
    assert persistent == {
        "engine": "sqlite",
        "persistence": "persistent_disk",
        "durable": True,
        "warning": None,
    }


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
