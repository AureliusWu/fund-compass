"""A rejected candidate completes evaluation without claiming publication."""
import copy
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    assert spec and spec.loader
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


calibration = load_tool("calibrate_strategy")
boundary = load_tool("calibration_publication_boundary")
ACTIVE = {"买入": 1.0, "定投": .75, "持有": .5, "减仓": .25}
WEIGHTS = [
    {"买入": .9, "定投": .7, "持有": .5, "减仓": .2},
    {"买入": 1., "定投": .8, "持有": .6, "减仓": .1},
    {"买入": 1., "定投": .85, "持有": .65, "减仓": .35},
    {"买入": .85, "定投": .7, "持有": .55, "减仓": .3},
]
TYPES = ("FOF", "QDII", "债券型", "指数型", "混合型", "股票型")


def real_rejection_rows():
    rows = []
    for index in range(30):
        if index >= 24:
            result = {"available": False, "accepted": False, "reason": "history insufficient"}
        else:
            result = {
                "available": True,
                "accepted": index < 5,
                "candidate_weights": copy.deepcopy(WEIGHTS[max(0, index - 1) % len(WEIGHTS)]),
                "validation": {
                    "baseline": {"outperform": 0., "max_drawdown": -10.},
                    "candidate": {"outperform": .65, "max_drawdown": -9.},
                },
            }
        rows.append({"code": f"{index:06d}", "type": TYPES[index % len(TYPES)], **result})
    return rows


@pytest.fixture
def run_context(tmp_path, monkeypatch):
    registry = tmp_path / "registry.json"
    report = tmp_path / "public-report.json"
    originals = {registry: b'{"existing_registry":"keep"}\n', report: b'{"existing_report":"keep"}\n'}
    for path, raw in originals.items():
        path.write_bytes(raw)
    current = {"active": {"version": "synthetic-active", "weights": ACTIVE}, "history": []}
    calls = []
    monkeypatch.setattr(calibration, "REGISTRY", registry)
    monkeypatch.setattr(calibration, "PUBLIC_REPORT", report)
    monkeypatch.setattr(calibration, "MIN_VALID", 12)
    monkeypatch.setattr(calibration, "load_registry", lambda: copy.deepcopy(current))

    def outcomes():
        calls.append("private_read")
        return {"total": 0, "summary": [], "items": []}

    monkeypatch.setattr(calibration, "fetch_outcomes", outcomes)
    rows = real_rejection_rows()

    def samples():
        assert calls == ["private_read"]
        return [(r["code"], r["type"]) for r in rows]

    monkeypatch.setattr(calibration, "sample_codes", samples)
    monkeypatch.setattr(calibration, "fetch_detail", lambda code: {"index": int(code)})
    monkeypatch.setattr(calibration, "calibrate", lambda detail: copy.deepcopy(rows[detail["index"]]))
    return {
        "rows": rows, "current": current, "originals": originals,
        "status": tmp_path / "status.json", "summary": tmp_path / "summary.md", "calls": calls,
    }


def assert_unchanged(context):
    for path, raw in context["originals"].items():
        assert path.read_bytes() == raw
        assert not path.with_suffix(path.suffix + ".tmp").exists()


def test_real_two_of_ten_vote_rejection_completes_without_publishing(run_context):
    context = run_context
    result = calibration.aggregate(context["rows"])
    assert (result["sampled"], result["valid"], result["accepted"]) == (30, 24, 5)
    assert (result["winner_votes"], result["required_votes"]) == (2, 10)
    assert result["median_validation_improvement"] == .65
    assert result["type_balance_ok"] is True
    assert result["passed"] is False

    status = calibration.main(evaluate_only=True, status_output=context["status"])
    assert context["calls"] == ["private_read"]
    assert status["candidate_status"] == "rejected"
    assert status["execution_status"] == "evaluation_completed"
    assert status["publication_accepted"] is status["publish"] is False
    assert boundary.check_run(context["status"], "success", context["summary"]) == 0
    summary = context["summary"].read_text(encoding="utf-8")
    for text in ("candidate: rejected", "publish: false", "publication_accepted: false",
                 "registry_unchanged: true", "public_report_unchanged: true"):
        assert text in summary
    assert set(json.loads(context["status"].read_text(encoding="utf-8"))) == boundary.STATUS_KEYS
    assert "weights" not in context["status"].read_text(encoding="utf-8")
    assert_unchanged(context)


def test_eligible_candidate_stays_blocked_without_private_sink(run_context):
    context = run_context
    for r in context["rows"][:24]:
        r["accepted"] = True
        r["candidate_weights"] = copy.deepcopy(WEIGHTS[0])
    status = calibration.main(evaluate_only=True, status_output=context["status"])
    assert status["candidate_passed"] is True
    assert status["candidate_status"] == "eligible"
    assert status["candidate_eligible_for_admin_review"] is True
    assert status["publication_status"] == "BLOCKED_PRIVATE_SINK_REQUIRED"
    assert status["publish"] is status["publication_accepted"] is False
    assert boundary.check_run(context["status"], "success", context["summary"]) == 1
    assert "BLOCKED_PRIVATE_SINK_REQUIRED" in context["summary"].read_text(encoding="utf-8")
    assert_unchanged(context)


def test_same_parameters_complete_without_publication():
    status = calibration.evaluation_status({"passed": True}, False, {
        "candidate_eligible_for_admin_review": False,
    })
    assert status["candidate_status"] == "no_change"
    assert boundary.verify_status(status) is True


@pytest.mark.parametrize("protected_name", ["registry.json", "public-report.json"])
@pytest.mark.parametrize("alias", ["direct", "normalized", "hardlink", "symlink", "temp_hardlink", "temp_symlink"])
def test_status_output_rejects_business_file_aliases_before_reads(run_context, monkeypatch, protected_name, alias):
    context = run_context
    protected = next(path for path in context["originals"] if path.name == protected_name)
    status = context["status"]
    if alias == "direct":
        status = protected
    elif alias == "normalized":
        folder = protected.parent / "nested"
        folder.mkdir()
        status = folder / ".." / protected.name
    else:
        link = status.with_suffix(status.suffix + ".tmp") if alias.startswith("temp_") else status
        if "symlink" in alias:
            try:
                link.symlink_to(protected)
            except OSError as exc:
                pytest.skip(f"symlink creation unavailable: {type(exc).__name__}")
        else:
            link.hardlink_to(protected)
    monkeypatch.setattr(calibration, "load_registry", lambda: pytest.fail("collision must stop before registry read"))
    monkeypatch.setattr(calibration, "fetch_outcomes", lambda: pytest.fail("collision must stop before network"))
    with pytest.raises(RuntimeError, match="overlaps a protected business file"):
        calibration.main(evaluate_only=True, status_output=status)
    assert context["calls"] == []
    for path, raw in context["originals"].items():
        assert path.read_bytes() == raw


@pytest.mark.parametrize("failure", ["resolve", "stat", "samefile"])
def test_status_path_identity_errors_fail_closed_before_network(run_context, monkeypatch, failure):
    context = run_context
    # Existing distinct files force the samefile branch as well as stat checks.
    context["status"].write_text("existing nonbusiness receipt", encoding="utf-8")
    original = getattr(Path, failure)

    def deny(path, *args, **kwargs):
        if path == context["status"]:
            raise PermissionError("synthetic private path must not be printed")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, failure, deny)
    monkeypatch.setattr(calibration, "fetch_outcomes", lambda: pytest.fail("unverified path must stop before network"))
    with pytest.raises(RuntimeError, match="identity could not be verified"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert context["calls"] == []
    assert_unchanged(context)


@pytest.mark.parametrize("alias", ["direct", "normalized", "hardlink", "symlink", "temp_hardlink", "temp_symlink"])
def test_status_output_protects_the_registry_modules_configured_read_path(run_context, monkeypatch, alias):
    context = run_context
    configured = context["status"].parent / "configured-read-registry.json"
    original = b'{"configured_registry":"must_remain"}\n'
    configured.write_bytes(original)
    # The loaded registry module is authoritative, including runtime overrides;
    # do not merely copy the tool's default or reread an unrelated env value.
    monkeypatch.setattr(calibration.strategy_registry, "REGISTRY_PATH", configured)
    monkeypatch.setenv("STRATEGY_REGISTRY_PATH", str(configured.parent / "different-env-path.json"))
    status = context["status"]
    if alias == "direct":
        status = configured
    elif alias == "normalized":
        nested = configured.parent / "nested"
        nested.mkdir()
        status = nested / ".." / configured.name
    else:
        link = status.with_suffix(status.suffix + ".tmp") if alias.startswith("temp_") else status
        if "symlink" in alias:
            try:
                link.symlink_to(configured)
            except OSError as exc:
                pytest.skip(f"symlink creation unavailable: {type(exc).__name__}")
        else:
            link.hardlink_to(configured)
    monkeypatch.setattr(calibration, "load_registry", lambda: pytest.fail("configured registry must not be read"))
    monkeypatch.setattr(calibration, "fetch_outcomes", lambda: pytest.fail("collision must stop before network"))
    with pytest.raises(RuntimeError, match="overlaps a protected business file"):
        calibration.main(evaluate_only=True, status_output=status)
    assert context["calls"] == []
    assert configured.read_bytes() == original
    assert_unchanged(context)


def test_current_registry_module_path_is_rechecked_before_receipt_write(run_context, monkeypatch):
    context = run_context
    original_calibrate = calibration.calibrate

    def update_configured_path(detail):
        if detail["index"] == 29:
            monkeypatch.setattr(calibration.strategy_registry, "REGISTRY_PATH", context["status"])
        return original_calibrate(detail)

    monkeypatch.setattr(calibration, "calibrate", update_configured_path)
    with pytest.raises(RuntimeError, match="overlaps a protected business file"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert context["calls"] == ["private_read"]
    assert not context["status"].exists()
    assert_unchanged(context)


def test_status_destination_is_rechecked_after_evaluation(run_context, monkeypatch):
    context = run_context
    protected = next(iter(context["originals"]))
    original_calibrate = calibration.calibrate

    def change_destination(detail):
        if detail["index"] == 29:
            context["status"].hardlink_to(protected)
        return original_calibrate(detail)

    monkeypatch.setattr(calibration, "calibrate", change_destination)
    with pytest.raises(RuntimeError, match="overlaps a protected business file"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert context["calls"] == ["private_read"]
    assert_unchanged(context)


@pytest.mark.parametrize("failure", ["private_read", "fetch_detail", "calibrate"])
def test_evaluation_errors_do_not_become_rejections(run_context, monkeypatch, capsys, failure):
    context = run_context

    def fail(*_args):
        raise RuntimeError("synthetic-secret-error-do-not-log")

    monkeypatch.setattr(calibration, "fetch_outcomes" if failure == "private_read" else failure, fail)
    with pytest.raises(RuntimeError):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert not context["status"].exists()
    assert boundary.check_run(context["status"], "failure", context["summary"]) == 1
    assert "synthetic-secret-error-do-not-log" not in capsys.readouterr().out
    assert_unchanged(context)


def test_insufficient_valid_samples_fail_instead_of_claiming_rejection(run_context):
    context = run_context
    for r in context["rows"][11:]:
        r["available"] = False
    with pytest.raises(RuntimeError, match="insufficient valid samples"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert not context["status"].exists()
    assert_unchanged(context)


@pytest.mark.parametrize("field,value", [
    ("outperform", math.nan), ("outperform", math.inf), ("max_drawdown", -math.inf),
    ("outperform", True), ("max_drawdown", None),
])
def test_nonfinite_or_incomplete_evidence_cannot_become_rejection(run_context, field, value):
    context = run_context
    # Even a fund that rejects its candidate must provide finite valid metrics.
    context["rows"][12]["validation"]["candidate"][field] = value
    with pytest.raises(RuntimeError, match="incomplete or nonfinite"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert not context["status"].exists()
    assert_unchanged(context)


def test_nonfinite_weights_and_overflow_improvement_fail(run_context):
    context = run_context
    context["rows"][12]["candidate_weights"]["买入"] = math.nan
    with pytest.raises(RuntimeError, match="incomplete or nonfinite"):
        calibration.main(evaluate_only=True)
    context["rows"][12]["candidate_weights"]["买入"] = 1.
    context["rows"][12]["validation"]["candidate"]["outperform"] = 1e308
    context["rows"][12]["validation"]["baseline"]["outperform"] = -1e308
    context["calls"].clear()
    with pytest.raises(RuntimeError, match="nonfinite improvement"):
        calibration.main(evaluate_only=True)
    assert_unchanged(context)


def test_nonfinite_training_metrics_are_not_hidden_by_a_valid_holdout(run_context):
    context = run_context
    context["rows"][12]["train"] = [{"objective": math.nan, "outperform": 1.}]
    with pytest.raises(RuntimeError, match="incomplete or nonfinite"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert not context["status"].exists()
    assert_unchanged(context)


@pytest.mark.parametrize("private", [
    {"total": 1, "summary": [], "items": []},
    {"total": 0, "summary": [{"samples": 12}], "items": []},
    {"total": 0, "summary": [], "items": [{"private": "canary"}]},
])
def test_evaluate_only_keeps_private_input_guard(run_context, monkeypatch, private):
    context = run_context
    monkeypatch.setattr(calibration, "fetch_outcomes", lambda: private)
    monkeypatch.setattr(calibration, "sample_codes", lambda: pytest.fail("private evidence must stop sampling"))
    with pytest.raises(RuntimeError, match="private governance storage"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert not context["status"].exists()
    assert_unchanged(context)


def test_evaluate_only_keeps_previous_private_governance_guard(run_context, monkeypatch):
    context = run_context
    context["current"]["governance"] = {"poor_cycles": 1}
    monkeypatch.setattr(calibration, "sample_codes", lambda: pytest.fail("private history must stop sampling"))
    with pytest.raises(RuntimeError, match="private governance storage"):
        calibration.main(evaluate_only=True, status_output=context["status"])
    assert not context["status"].exists()
    assert_unchanged(context)


def rejected_status():
    return calibration.evaluation_status({"passed": False}, True, {
        "candidate_eligible_for_admin_review": False,
    })


@pytest.mark.parametrize("key,value", [
    ("publish", True), ("publish", 0), ("publish", "false"),
    ("publication_accepted", True), ("private_output_published", True),
    ("registry_unchanged", False), ("public_report_unchanged", False),
    ("candidate_passed", True), ("candidate_passed", 0),
    ("candidate_eligible_for_admin_review", True), ("candidate_status", "unknown"),
    ("execution_status", "success"), ("publication_status", "published"),
    ("schema", True), ("artifact_status", "uploaded"),
])
def test_boundary_rejects_tampered_or_unknown_decisions(tmp_path, key, value):
    status = rejected_status()
    status[key] = value
    path = tmp_path / "status.json"
    path.write_text(json.dumps(status), encoding="utf-8")
    assert boundary.check_run(path, "success") == 1


@pytest.mark.parametrize("mode", ["missing", "duplicate", "extra", "oversize", "nonfinite", "invalid_json"])
def test_boundary_rejects_missing_or_unbounded_status_without_echoing_payload(tmp_path, capsys, mode):
    path = tmp_path / "status.json"
    if mode != "missing":
        raw = json.dumps(rejected_status())
        if mode == "duplicate":
            raw = raw[:-1] + ', "publish": true}'
        elif mode == "extra":
            raw = raw[:-1] + ', "owner_data": "private-canary"}'
        elif mode == "oversize":
            raw += " " * boundary.STATUS_MAX_BYTES
        elif mode == "nonfinite":
            raw = raw.replace('"schema": 1', '"schema": NaN')
        else:
            raw = "private-canary-invalid-json"
        path.write_text(raw, encoding="utf-8")
    assert boundary.check_run(path, "success") == 1
    assert "private-canary" not in capsys.readouterr().out


@pytest.mark.parametrize("step_outcome", ["failure", "cancelled", "skipped", "", "unknown"])
def test_failed_producer_cannot_reuse_a_valid_stale_receipt(tmp_path, monkeypatch, step_outcome):
    path = tmp_path / "status.json"
    path.write_text(json.dumps(rejected_status()), encoding="utf-8")
    monkeypatch.setattr(boundary, "read_status", lambda path: pytest.fail("failed producer must not read old status"))
    assert boundary.check_run(path, step_outcome) == 1


def test_boundary_cli_checks_receipt_and_writes_explicit_summary(tmp_path):
    status = tmp_path / "status.json"
    summary = tmp_path / "summary.md"
    status.write_text(json.dumps(rejected_status()), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "calibration_publication_boundary.py"),
         "--status-path", str(status), "--step-outcome", "success"],
        env={**os.environ, "GITHUB_STEP_SUMMARY": str(summary)},
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert "execution_status: evaluation_completed" in summary.read_text(encoding="utf-8")
    assert "publication_accepted: false" in summary.read_text(encoding="utf-8")
    assert "publish: false" in summary.read_text(encoding="utf-8")


def test_workflow_uses_evaluation_only_and_an_independent_boundary():
    source = (ROOT / ".github" / "workflows" / "calibrate-strategy.yml").read_text(encoding="utf-8")
    assert "--evaluate-only --status-output" in source
    assert "python tools/calibration_publication_boundary.py" in source
    assert "--step-outcome" in source
    assert "if: always()" in source
    assert "continue-on-error" not in source
    assert "actions/upload-artifact" not in source
    assert "contents: write" not in source
