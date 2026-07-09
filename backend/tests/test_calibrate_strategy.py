import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "calibrate_strategy.py"
SPEC = importlib.util.spec_from_file_location("calibrate_strategy", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


def row(weights, baseline, candidate, accepted=True):
    return {
        "available": True,
        "accepted": accepted,
        "candidate_weights": weights,
        "validation": {
            "baseline": {"outperform": baseline},
            "candidate": {"outperform": candidate},
        },
    }


def test_aggregate_promotes_only_with_broad_support(monkeypatch):
    monkeypatch.setattr(module, "MIN_VALID", 10)
    weights = {"买入": 1, "定投": .8, "持有": .6, "减仓": .1}
    rows = [row(weights, 0, 1) for _ in range(8)]
    rows += [row(weights, 0, -1, accepted=False) for _ in range(2)]
    result = module.aggregate(rows)
    assert result["passed"] is True
    assert result["winner_votes"] == 8


def test_aggregate_rejects_small_sample(monkeypatch):
    monkeypatch.setattr(module, "MIN_VALID", 12)
    weights = {"买入": 1, "定投": .8, "持有": .6, "减仓": .1}
    result = module.aggregate([row(weights, 0, 2) for _ in range(5)])
    assert result["passed"] is False
