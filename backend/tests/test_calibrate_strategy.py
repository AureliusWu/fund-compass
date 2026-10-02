import importlib.util
import json
import socket
import urllib.error
import urllib.request
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


class FakeResponse:
    def __init__(self, payload=None, *, body=None, headers=None, on_read=None):
        self.body = (
            json.dumps(payload).encode("utf-8")
            if body is None else body
        )
        self.headers = headers or {}
        self.offset = 0
        self.on_read = on_read
        self.socket_timeouts = []
        socket_target = type("FakeSocket", (), {
            "settimeout": lambda inner_self, value: self.socket_timeouts.append(value),
        })()
        raw = type("FakeRaw", (), {"_sock": socket_target})()
        self.fp = type("FakeFP", (), {"raw": raw})()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read1(self, size=-1):
        if self.on_read:
            self.on_read()
        if self.offset >= len(self.body):
            return b""
        end = len(self.body) if size < 0 else min(len(self.body), self.offset + size)
        chunk = self.body[self.offset:end]
        self.offset = end
        return chunk


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
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")

    def private_response(request, timeout):
        assert timeout <= 45
        assert request.get_method() == "GET"
        assert request.full_url == "https://api.test/api/private/strategy/outcomes"
        assert request.get_header("Authorization") == "Bearer private-test-token"
        return FakeResponse({"total": 0, "summary": [], "items": []})

    monkeypatch.setattr(module.OUTCOME_OPENER, "open", private_response)
    assert module.fetch_outcomes() == {"total": 0, "summary": [], "items": []}

    monkeypatch.setattr(
        module.OUTCOME_OPENER,
        "open",
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


@pytest.mark.parametrize("base", [
    "http://api.test",
    "http://127.0.0.1:8000",
    "https://user:password@api.test",
    "https://api.test/base",
    "https://api.test?private=query",
    "https://api.test#private-fragment",
    "https://api.test\\@attacker.invalid",
    "https://api.test private",
])
def test_outcome_governance_rejects_unsafe_bearer_targets(monkeypatch, base):
    calls = []
    monkeypatch.setattr(module, "FUND_API_BASE", base)
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "ALLOW_INSECURE_LOOPBACK", False)
    monkeypatch.setattr(
        module.OUTCOME_OPENER,
        "open",
        lambda *_args, **_kwargs: calls.append(1),
    )

    with pytest.raises(RuntimeError, match="HTTPS origin") as caught:
        module.fetch_outcomes()
    assert calls == []
    assert "private" not in str(caught.value).lower()


def test_outcome_governance_allows_only_explicit_insecure_loopback(monkeypatch):
    requests = []
    monkeypatch.setattr(module, "FUND_API_BASE", "http://127.0.0.1:8765/")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "ALLOW_INSECURE_LOOPBACK", True)

    def response(request, timeout):
        requests.append((request.full_url, request.get_method(), timeout))
        return FakeResponse({"total": 0, "summary": [], "items": []})

    monkeypatch.setattr(module.OUTCOME_OPENER, "open", response)
    assert module.fetch_outcomes()["total"] == 0
    assert requests[0][0] == "http://127.0.0.1:8765/api/private/strategy/outcomes"
    assert requests[0][1] == "GET"


def test_outcome_governance_retries_transient_timeout_then_succeeds(monkeypatch):
    calls = []
    sleeps = []
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "OUTCOME_ATTEMPTS", 3)
    monkeypatch.setattr(module, "OUTCOME_BACKOFF_SECONDS", 5)
    monkeypatch.setattr(module, "OUTCOME_RETRY_AFTER_MAX_SECONDS", 15)
    monkeypatch.setattr(module.time, "sleep", sleeps.append)

    def response(request, timeout):
        calls.append((request.get_method(), timeout))
        if len(calls) == 1:
            raise socket.timeout("must-not-leak")
        return FakeResponse({"total": 0, "summary": [], "items": []})

    monkeypatch.setattr(module.OUTCOME_OPENER, "open", response)
    assert module.fetch_outcomes()["total"] == 0
    assert [method for method, _ in calls] == ["GET", "GET"]
    assert sleeps == [5]


def test_outcome_governance_caps_retry_after(monkeypatch):
    calls = []
    sleeps = []
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "OUTCOME_ATTEMPTS", 2)
    monkeypatch.setattr(module, "OUTCOME_RETRY_AFTER_MAX_SECONDS", 15)
    monkeypatch.setattr(module.time, "sleep", sleeps.append)

    def response(_request, timeout):
        assert timeout > 0
        calls.append(1)
        if len(calls) == 1:
            raise urllib.error.HTTPError(
                "https://private.invalid/must-not-leak", 503, "private", {"Retry-After": "999"}, None,
            )
        return FakeResponse({"total": 0, "summary": [], "items": []})

    monkeypatch.setattr(module.OUTCOME_OPENER, "open", response)
    assert module.fetch_outcomes()["summary"] == []
    assert len(calls) == 2
    assert sleeps == [15]


@pytest.mark.parametrize("status", [401, 403, 302, 400])
def test_outcome_governance_does_not_retry_auth_redirect_or_other_4xx(monkeypatch, status):
    calls = []
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")

    def response(_request, timeout):
        assert timeout > 0
        calls.append(1)
        raise urllib.error.HTTPError(
            "https://private.invalid/token=must-not-leak",
            status,
            "private-body-must-not-leak",
            {},
            None,
        )

    monkeypatch.setattr(module.OUTCOME_OPENER, "open", response)
    with pytest.raises(RuntimeError) as caught:
        module.fetch_outcomes()
    rendered = str(caught.value)
    assert len(calls) == 1
    assert "must-not-leak" not in rendered
    assert "private-body" not in rendered


def test_outcome_redirect_handler_never_builds_a_follow_up_request():
    handler = module._NoRedirectHandler()
    request = urllib.request.Request(
        "https://api.test/api/private/strategy/outcomes",
        headers={"Authorization": "Bearer private-test-token"},
    )
    assert handler.redirect_request(
        request,
        None,
        302,
        "redirect",
        {"Location": "https://attacker.invalid/collect"},
        "https://attacker.invalid/collect",
    ) is None


def test_outcome_governance_does_not_retry_invalid_json_or_oversized_body(monkeypatch):
    calls = []
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "OUTCOME_MAX_RESPONSE_BYTES", 16)

    def invalid_json(_request, timeout):
        assert timeout > 0
        calls.append(1)
        return FakeResponse(body=b"not-json")

    monkeypatch.setattr(module.OUTCOME_OPENER, "open", invalid_json)
    with pytest.raises(RuntimeError, match="invalid JSON"):
        module.fetch_outcomes()
    assert len(calls) == 1

    calls.clear()
    monkeypatch.setattr(
        module.OUTCOME_OPENER,
        "open",
        lambda *_args, **_kwargs: calls.append(1) or FakeResponse(body=b"x" * 17),
    )
    with pytest.raises(RuntimeError, match="byte limit"):
        module.fetch_outcomes()
    assert len(calls) == 1


def test_outcome_governance_rejects_unbounded_transport_without_retry(monkeypatch):
    calls = []
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")

    class ReadOnlyResponse:
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _size=-1):
            pytest.fail("generic read must never be used for private responses")

    monkeypatch.setattr(
        module.OUTCOME_OPENER,
        "open",
        lambda *_args, **_kwargs: calls.append(1) or ReadOnlyResponse(),
    )
    with pytest.raises(RuntimeError, match="does not support bounded reads"):
        module.fetch_outcomes()
    assert len(calls) == 1


def test_outcome_governance_slow_drip_cannot_extend_read1_deadline(monkeypatch):
    clock = [0.0]
    response = FakeResponse(
        body=b'{"total":0}',
        on_read=lambda: clock.__setitem__(0, clock[0] + 16.0),
    )
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "OUTCOME_ATTEMPTS", 1)
    monkeypatch.setattr(module, "OUTCOME_TIMEOUT_SECONDS", 45)
    monkeypatch.setattr(module, "OUTCOME_TOTAL_BUDGET_SECONDS", 45)
    monkeypatch.setattr(module, "OUTCOME_READ_CHUNK_BYTES", 1)
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.OUTCOME_OPENER, "open", lambda *_args, **_kwargs: response)

    with pytest.raises(RuntimeError, match="deadline_exceeded"):
        module.fetch_outcomes()
    assert response.socket_timeouts == [45.0, 29.0, 13.0]


def test_outcome_governance_body_read_is_inside_attempt_budget(monkeypatch):
    clock = [0.0]
    sleeps = []
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "OUTCOME_ATTEMPTS", 1)
    monkeypatch.setattr(module, "OUTCOME_TIMEOUT_SECONDS", 45)
    monkeypatch.setattr(module, "OUTCOME_TOTAL_BUDGET_SECONDS", 45)
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.time, "sleep", sleeps.append)
    monkeypatch.setattr(
        module.OUTCOME_OPENER,
        "open",
        lambda *_args, **_kwargs: FakeResponse(
            {"total": 0, "summary": [], "items": []},
            on_read=lambda: clock.__setitem__(0, 46.0),
        ),
    )

    with pytest.raises(RuntimeError, match="deadline_exceeded"):
        module.fetch_outcomes()
    assert sleeps == []


def test_outcome_governance_json_parse_is_inside_attempt_budget(monkeypatch):
    clock = [0.0]
    response = FakeResponse({"total": 0, "summary": [], "items": []})
    real_loads = json.loads
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "OUTCOME_ATTEMPTS", 1)
    monkeypatch.setattr(module, "OUTCOME_TIMEOUT_SECONDS", 45)
    monkeypatch.setattr(module, "OUTCOME_TOTAL_BUDGET_SECONDS", 45)
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.OUTCOME_OPENER, "open", lambda *_args, **_kwargs: response)

    def delayed_loads(raw):
        result = real_loads(raw)
        clock[0] = 46.0
        return result

    monkeypatch.setattr(module.json, "loads", delayed_loads)
    with pytest.raises(RuntimeError, match="deadline_exceeded"):
        module.fetch_outcomes()


def test_outcome_governance_transient_exhaustion_is_bounded_and_redacted(monkeypatch):
    calls = []
    monkeypatch.setattr(module, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(module, "PRIVATE_READ_TOKEN", "private-test-token")
    monkeypatch.setattr(module, "OUTCOME_ATTEMPTS", 3)
    monkeypatch.setattr(module, "OUTCOME_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(module, "OUTCOME_RETRY_AFTER_MAX_SECONDS", 0)

    def unavailable(_request, timeout):
        assert timeout > 0
        calls.append(1)
        raise socket.timeout("private-url-and-token-must-not-leak")

    monkeypatch.setattr(module.OUTCOME_OPENER, "open", unavailable)
    with pytest.raises(RuntimeError) as caught:
        module.fetch_outcomes()
    rendered = str(caught.value)
    assert len(calls) == 3
    assert rendered == "outcome audit unavailable after 3 attempt(s): network"
    assert "private-url" not in rendered
    assert "token" not in rendered


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


def test_main_preserves_existing_outputs_when_private_read_is_unavailable(tmp_path, monkeypatch):
    registry_path = tmp_path / "strategy-params.json"
    report_path = tmp_path / "strategy-calibration.json"
    existing = {"audit_marker": "keep-existing-artifact"}
    for path in (registry_path, report_path):
        module.write_json_atomic(path, existing)
    monkeypatch.setattr(module, "REGISTRY", registry_path)
    monkeypatch.setattr(module, "PUBLIC_REPORT", report_path)
    monkeypatch.setattr(module, "load_registry", lambda: {
        "active": {"version": "test", "weights": {}}, "history": [],
    })
    monkeypatch.setattr(
        module,
        "fetch_outcomes",
        lambda: (_ for _ in ()).throw(RuntimeError("outcome audit unavailable")),
    )

    with pytest.raises(RuntimeError, match="outcome audit unavailable"):
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
