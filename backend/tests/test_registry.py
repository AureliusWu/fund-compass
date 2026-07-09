import json

from strategy import registry


def test_registry_falls_back_when_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(registry, "REGISTRY_PATH", tmp_path / "missing.json")
    assert registry.active_weights() == registry.DEFAULT_WEIGHTS


def test_registry_loads_active_weights(monkeypatch, tmp_path):
    path = tmp_path / "params.json"
    weights = {"买入": 0.9, "定投": 0.8, "持有": 0.6, "减仓": 0.2}
    path.write_text(json.dumps({"active": {"version": "v2", "weights": weights}}), encoding="utf-8")
    monkeypatch.setattr(registry, "REGISTRY_PATH", path)
    assert registry.active_weights() == weights
