import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "calibrate_strategy.py"
SPEC = importlib.util.spec_from_file_location("calibrate_strategy", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


def row(weights, baseline, candidate, accepted=True, fund_type="混合型"):
    return {
        "available": True,
        "accepted": accepted,
        "type": fund_type,
        "candidate_weights": weights,
        "validation": {
            "baseline": {"outperform": baseline},
            "candidate": {"outperform": candidate},
        },
    }


def test_aggregate_promotes_only_with_broad_support(monkeypatch):
    monkeypatch.setattr(module, "MIN_VALID", 10)
    weights = {"买入": 1, "定投": .8, "持有": .6, "减仓": .1}
    types = ["混合型", "股票型", "指数型", "债券型", "QDII"]
    rows = [row(weights, 0, 1, fund_type=types[i % len(types)]) for i in range(8)]
    rows += [row(weights, 0, -1, accepted=False, fund_type=types[i]) for i in range(2)]
    result = module.aggregate(rows)
    assert result["passed"] is True
    assert result["winner_votes"] == 8
    assert result["type_balance_ok"] is True


def test_aggregate_rejects_small_sample(monkeypatch):
    monkeypatch.setattr(module, "MIN_VALID", 12)
    weights = {"买入": 1, "定投": .8, "持有": .6, "减仓": .1}
    result = module.aggregate([row(weights, 0, 2) for _ in range(5)])
    assert result["passed"] is False


def test_aggregate_rejects_single_type_dominance(monkeypatch):
    monkeypatch.setattr(module, "MIN_VALID", 10)
    weights = {"买入": 1, "定投": .8, "持有": .6, "减仓": .1}
    result = module.aggregate([row(weights, 0, 2) for _ in range(12)])
    assert result["type_balance_ok"] is False
    assert result["passed"] is False


def test_active_degradation_requires_two_mature_poor_groups():
    outcomes = {"summary": [
        {"strategy_version": "v2", "horizon": 20, "samples": 12, "hit_rate": 35},
        {"strategy_version": "v2", "horizon": 60, "samples": 10, "hit_rate": 30},
        {"strategy_version": "v1", "horizon": 20, "samples": 20, "hit_rate": 10},
    ]}
    degraded, evidence = module.active_is_degraded(outcomes, "v2")
    assert degraded is True
    assert evidence["poor_groups"] == 2


def test_active_degradation_ignores_immature_samples():
    outcomes = {"summary": [
        {"strategy_version": "v2", "horizon": 20, "samples": 9, "hit_rate": 0},
        {"strategy_version": "v2", "horizon": 60, "samples": 8, "hit_rate": 0},
    ]}
    degraded, _ = module.active_is_degraded(outcomes, "v2")
    assert degraded is False


def test_atomic_json_write(tmp_path):
    path = tmp_path / "report.json"
    module.write_json_atomic(path, {"ok": True})
    assert path.read_text(encoding="utf-8").strip() == '{\n  "ok": true\n}'
    assert not (tmp_path / "report.json.tmp").exists()
