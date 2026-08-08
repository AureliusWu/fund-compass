"""V6-P3 决策推送组合计算测试。"""
import datetime
import importlib.util
import json
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "estimate_push.py"
SPEC = importlib.util.spec_from_file_location("estimate_push", SCRIPT)
estimate_push = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(estimate_push)


def test_build_portfolio_payload_distributes_remaining_target():
    entries = [
        {"code": "000001", "shares": 100, "target_weight": 60},
        {"code": "000002", "shares": 100},
        {"code": "000003", "shares": 100},
    ]
    estimates = {
        "000001": {"est_nav": 2},
        "000002": {"est_nav": 1},
        "000003": {"est_nav": 1},
    }

    items, value, missing = estimate_push.build_portfolio_payload(entries, estimates)

    assert value == 400
    assert items[0]["current_weight"] == 50
    assert items[0]["target_weight"] == 60
    assert items[1]["target_weight"] == 20
    assert items[2]["target_weight"] == 20
    assert missing == []


def test_build_portfolio_payload_aggregates_accounts():
    entries = [
        {"code": "000001", "shares": 40, "account": "A"},
        {"code": "000001", "shares": 60, "account": "B"},
    ]
    items, value, missing = estimate_push.build_portfolio_payload(
        entries,
        {"000001": {"last_nav": 2}},
    )

    assert value == 200
    assert items == [{"code": "000001", "current_weight": 100.0, "target_weight": 100.0}]
    assert missing == []


def test_build_portfolio_payload_refuses_partial_weights_when_held_nav_is_missing():
    items, value, missing = estimate_push.build_portfolio_payload(
        [
            {"code": "000001", "shares": 100},
            {"code": "000002", "shares": 100},
        ],
        {"000001": {"est_nav": 2}, "000002": {"est_nav": None, "last_nav": None}},
    )

    assert value is None
    assert missing == ["000002"]
    assert items == [{"code": "000001"}, {"code": "000002"}]


def test_format_portfolio_summary_limits_actions():
    result = {
        "allocation": {"target_total": 90, "target_cash": 10, "warnings": []},
        "rebalance": [
            {"code": str(i), "name": f"基金{i}", "gap": i, "suggestion": "分批补仓", "amount": 1000}
            for i in range(1, 6)
        ],
    }

    text = estimate_push.format_portfolio_summary(result)

    assert "目标现金 10.0%" in text
    assert "基金3" in text
    assert "基金4" not in text


def test_fetch_estimates_uses_worker_proxy_and_preserves_status(monkeypatch):
    captured = {}

    def fake_req(url, data=None, headers=None, method=None, timeout=30):
        captured.update(url=url, headers=headers)
        return json.dumps({
            "status": "degraded",
            "items": [
                {
                    "code": "000001",
                    "name": "一号基金",
                    "last_nav": 1,
                    "est_nav": 1.02,
                    "est_change": 2,
                    "est_time": "2026-07-13",
                    "est_label": "盘中估值",
                    "est_kind": "estimate",
                    "status": "fresh",
                    "source": "eastmoney_estimate_table",
                },
                {
                    "code": "000002",
                    "name": "二号基金",
                    "last_nav": 0.98,
                    "est_nav": 1,
                    "est_change": 2.04,
                    "est_time": "2026-07-11",
                    "est_label": "最近净值",
                    "est_kind": "official_nav",
                    "status": "latest_official",
                    "source": "eastmoney_official_nav",
                },
            ],
        })

    monkeypatch.setattr(estimate_push, "ESTIMATE_PROXY_URL", "https://worker.test/estimates")
    monkeypatch.setattr(estimate_push, "_req", fake_req)

    result = estimate_push.fetch_estimates(["000001", "000002"])

    assert captured["url"] == "https://worker.test/estimates?codes=000001%2C000002"
    assert "fundgz" not in captured["url"]
    assert captured["headers"]["Accept"] == "application/json"
    assert result["000001"]["status"] == "fresh"
    assert result["000002"]["status"] == "latest_official"
    assert result["000002"]["label"] == "最近净值"


def test_fetch_estimates_reads_unavailable_rows_outside_legacy_items(monkeypatch):
    def fake_req(url, data=None, headers=None, method=None, timeout=30):
        return json.dumps({
            "status": "degraded",
            "items": [{"code": "000001", "est_nav": 1.01, "status": "fresh"}],
            "unavailable_items": [{
                "code": "000002", "est_nav": None, "est_change": None,
                "status": "unavailable", "est_label": "数据不可用",
            }],
        })

    monkeypatch.setattr(estimate_push, "_req", fake_req)

    result = estimate_push.fetch_estimates(["000001", "000002"])

    assert result["000001"]["est_nav"] == 1.01
    assert result["000002"]["status"] == "unavailable"
    assert result["000002"]["est_nav"] is None


def test_fetch_portfolio_decisions_sends_worker_token_and_request_id(monkeypatch):
    captured = {}

    def fake_req(url, data=None, headers=None, method=None, timeout=30):
        captured.update(url=url, body=json.loads(data), headers=headers)
        return json.dumps({"decisions": []})

    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "worker-secret")
    monkeypatch.setattr(estimate_push, "_req", fake_req)

    result, warning = estimate_push.fetch_portfolio_decisions(
        [{"code": "000001"}],
        1000,
        request_id="2026-07-13-14:30",
    )

    assert result == {"decisions": []}
    assert warning is None
    assert captured["url"] == "https://api.test/api/portfolio/decisions"
    assert captured["headers"]["Authorization"] == "Bearer worker-secret"
    assert captured["body"]["request_id"] == "2026-07-13-14:30"


def test_fetch_portfolio_decisions_requires_worker_token(monkeypatch):
    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "")

    try:
        estimate_push.fetch_portfolio_decisions([], 0)
    except estimate_push.DecisionAuthError as ex:
        assert "WORKER_TOKEN" in str(ex)
    else:
        raise AssertionError("missing WORKER_TOKEN must stop the protected decision call")


def test_fetch_portfolio_decisions_returns_warning_on_timeout(monkeypatch):
    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "worker-secret")
    monkeypatch.setattr(
        estimate_push,
        "_req",
        lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError("timed out")),
    )

    result, warning = estimate_push.fetch_portfolio_decisions([], 0)

    assert result is None
    assert "timed out" in warning


def _install_main_probe(monkeypatch, decision_call):
    real_datetime = datetime.datetime

    class FixedDateTime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 7, 13, 14, 30, tzinfo=tz)

    written = []
    sends = []
    monkeypatch.setattr(estimate_push.datetime, "datetime", FixedDateTime)
    monkeypatch.setattr(estimate_push, "GIST_TOKEN", "gist-token")
    monkeypatch.setattr(estimate_push, "FUND_API_BASE", "https://api.test")
    monkeypatch.setattr(estimate_push, "WORKER_TOKEN", "worker-token")
    monkeypatch.setattr(estimate_push, "FORCE", False)
    monkeypatch.setattr(estimate_push, "PUSH_SLOT", "14:30")
    monkeypatch.setattr(estimate_push, "SCHEDULE_CRON", "")
    monkeypatch.setattr(estimate_push, "find_gist_id", lambda: "gist")
    monkeypatch.setattr(estimate_push, "gist_file", lambda *_args: "{}")
    monkeypatch.setattr(
        estimate_push,
        "watch_entries",
        lambda _gid: [{"code": "000001", "name": "测试基金", "shares": 100}],
    )
    monkeypatch.setattr(
        estimate_push,
        "fetch_estimates",
        lambda _codes: {"000001": {
            "name": "测试基金", "est_nav": 1.01, "last_nav": 1,
            "gszzl": 1, "gztime": "2026-07-13", "status": "fresh", "label": "盘中估值",
        }},
    )
    monkeypatch.setattr(estimate_push, "fetch_portfolio_decisions", decision_call)
    monkeypatch.setattr(
        estimate_push,
        "send_notification",
        lambda *_args: sends.append(True) or True,
    )
    monkeypatch.setattr(estimate_push, "write_state", lambda _gid, state: written.append(dict(state)))
    return written, sends


def test_main_records_decision_timeout_as_sent_with_warning(monkeypatch):
    written, sends = _install_main_probe(
        monkeypatch,
        lambda *_args, **_kwargs: (None, "组合决策暂不可用: timed out"),
    )

    estimate_push.main()

    assert sends == [True]
    assert written[-1]["sent_slots"] == ["14:30"]
    assert written[-1]["decision_status"] == "degraded"
    assert written[-1]["last_warning"] == "组合决策暂不可用: timed out"
    assert written[-1]["last_error"] == ""
    assert written[-1]["last_http_status"] == 200


def test_main_records_auth_failure_without_sending_or_marking_sent(monkeypatch):
    def auth_failure(*_args, **_kwargs):
        raise estimate_push.DecisionAuthError("组合决策鉴权失败: HTTP 401", 401)

    written, sends = _install_main_probe(monkeypatch, auth_failure)

    estimate_push.main()

    assert sends == []
    assert written[-1]["sent_slots"] == []
    assert written[-1]["decision_status"] == "degraded"
    assert written[-1]["last_error"] == "组合决策鉴权失败: HTTP 401"
    assert written[-1]["last_http_status"] == 401


def test_unavailable_proxy_item_is_explicit_in_push_line():
    line = estimate_push.format_push_line(
        "000001",
        "一号基金",
        {"status": "unavailable", "gszzl": None, "label": "数据不可用"},
        None,
    )

    assert "—（数据不可用）" in line
