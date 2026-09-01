import importlib.util
import json
from pathlib import Path

import pytest


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


def test_outcome_governance_uses_private_contract_and_rejects_redaction(monkeypatch):
    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(self.payload).encode("utf-8")

    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")

    def private_response(request, timeout):
        assert timeout == 30
        assert request.full_url == "https://api.test/api/private/strategy/outcomes"
        assert request.get_header("Authorization") == "Bearer private-test-token"
        return FakeResponse({"total": 0, "summary": [], "items": []})

    monkeypatch.setattr(module.urllib.request, "urlopen", private_response)
    assert module.fetch_outcomes() == {"total": 0, "summary": [], "items": []}

    monkeypatch.setattr(
        module.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: FakeResponse({
            "total": None, "summary": [], "available": False, "redacted": True,
        }),
    )
    with pytest.raises(RuntimeError, match="invalid or redacted"):
        module.fetch_outcomes()


def test_outcome_governance_requires_private_token(monkeypatch):
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "")

    with pytest.raises(RuntimeError, match="PRIVATE_READ_TOKEN"):
        module.fetch_outcomes()


def test_atomic_json_write(tmp_path):
    path = tmp_path / "report.json"
    module.write_json_atomic(path, {"ok": True})
    assert path.read_text(encoding="utf-8").strip() == '{\n  "ok": true\n}'
    assert not (tmp_path / "report.json.tmp").exists()


def test_review_policy_only_recommends_explicit_admin_changes():
    promotion = module.review_policy(
        candidate_passed=True,
        candidate_changed=True,
        degraded=False,
        frozen=False,
        poor_cycles=0,
        rollback_available=False,
    )
    assert promotion == {
        "active_change_policy": "explicit_admin_only",
        "candidate_eligible_for_admin_review": True,
        "rollback_recommended": False,
        "recommendation": "review_candidate",
    }

    rollback = module.review_policy(
        candidate_passed=True,
        candidate_changed=True,
        degraded=True,
        frozen=True,
        poor_cycles=2,
        rollback_available=True,
    )
    assert rollback["candidate_eligible_for_admin_review"] is False
    assert rollback["rollback_recommended"] is True
    assert rollback["recommendation"] == "review_rollback"


@pytest.mark.parametrize("outcomes", [
    {"total": 1, "summary": [], "items": []},
    {"total": 0, "summary": [{"samples": 12, "hit_rate": 25}], "items": []},
    {"total": 0, "summary": [], "items": [{"code": "000001"}]},
])
def test_main_refuses_to_publish_private_outcome_copies(tmp_path, monkeypatch, outcomes):
    registry_path = tmp_path / "strategy-params.json"
    report_path = tmp_path / "strategy-calibration.json"
    existing = {"audit_marker": "keep-existing-artifact"}
    for path in (registry_path, report_path):
        module.write_json_atomic(path, existing)
    monkeypatch.setattr(module, "REGISTRY", registry_path)
    monkeypatch.setattr(module, "PUBLIC_REPORT", report_path)
    monkeypatch.setattr(module, "sample_codes", lambda: [])
    monkeypatch.setattr(module, "load_registry", lambda: {
        "active": {"version": "test", "weights": {}}, "history": [],
    })
    monkeypatch.setattr(module, "fetch_outcomes", lambda: outcomes)

    with pytest.raises(RuntimeError, match="private governance storage"):
        module.main()

    for path in (registry_path, report_path):
        assert json.loads(path.read_text(encoding="utf-8")) == existing


@pytest.mark.parametrize("has_private_history", [False, True])
def test_main_never_promotes_or_rolls_back_active(tmp_path, monkeypatch, has_private_history):
    active = {
        "version": "auto-previous",
        "weights": {"买入": 1.0, "定投": 0.75, "持有": 0.5, "减仓": 0.25},
        "source": "cross-fund holdout validation",
    }
    history = [{"version": "v1-default", "weights": {"买入": 1.0}}]
    current = {
        "active": active,
        "history": history,
        "governance": {"poor_cycles": 1 if has_private_history else 0},
    }
    summary = {
        "sampled": 20,
        "valid": 20,
        "accepted": 20,
        "winner_votes": 20,
        "required_votes": 8,
        "median_validation_improvement": 1.0,
        "type_distribution": {"混合型": 5, "股票型": 5, "指数型": 5, "QDII": 5},
        "valid_type_distribution": {"混合型": 5, "股票型": 5, "指数型": 5, "QDII": 5},
        "max_type_share": 0.25,
        "type_balance_ok": True,
        "passed": True,
        "weights": {"买入": 1.0, "定投": 0.85, "持有": 0.6, "减仓": 0.2},
    }
    registry_path = tmp_path / "strategy-params.json"
    report_path = tmp_path / "strategy-calibration.json"
    monkeypatch.setattr(module, "REGISTRY", registry_path)
    monkeypatch.setattr(module, "PUBLIC_REPORT", report_path)
    monkeypatch.setattr(module, "sample_codes", lambda: [("000001", "混合型")])
    monkeypatch.setattr(module, "fetch_detail", lambda code: {})
    monkeypatch.setattr(module, "calibrate", lambda detail: {"available": True, "accepted": True})
    monkeypatch.setattr(module, "aggregate", lambda rows: summary)
    monkeypatch.setattr(module, "load_registry", lambda: json.loads(json.dumps(current)))
    monkeypatch.setattr(module, "fetch_outcomes", lambda: {"total": 0, "summary": [], "items": []})

    if has_private_history:
        with pytest.raises(RuntimeError, match="private governance storage"):
            module.main()
        assert not registry_path.exists()
        assert not report_path.exists()
        assert current["active"] == active
        assert current["governance"]["poor_cycles"] == 1
        return

    module.main()

    output = json.loads(registry_path.read_text(encoding="utf-8"))
    assert output["active"] == active
    assert output["history"] == history
    assert output["candidate"]["status"] == "passed"
    assert output["candidate"]["eligible_for_admin_review"] is True
    assert output["governance"]["poor_cycles"] == 0
    assert output["governance"]["rollback_recommended"] is False
    assert output["governance"]["recommendation"] == "review_candidate"
    assert output["governance"]["active_change_policy"] == "explicit_admin_only"
