"""Synthetic-only adapter regressions; no providers, Git or cloud commands."""
import datetime as dt
import hashlib
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
SPEC = importlib.util.spec_from_file_location("record_overseas_ops", ROOT / "tools" / "record_overseas_ops.py")
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)

START = dt.datetime(2026, 10, 13, 6, 35, tzinfo=dt.timezone.utc)
END = START + dt.timedelta(minutes=1)
IDENTITY = {"run_id": 38414079046, "attempt": 1, "source_sha": "a" * 40, "mode": "scheduled"}
PUBLISHED = {"commit_sha": "b" * 40, **{key: "c" * 64 for key in ops.FINANCIAL}}


def event(*, effective=1, audited=1, audit_errors=False, failed=None, published=PUBLISHED,
          mode="scheduled", start=START, producer_observed_failure=False):
    identity = {**IDENTITY, "mode": mode}
    context = ops.producer.build_run_context(start, run_mode=mode)
    stages = dict.fromkeys(ops.STAGES, "succeeded")
    if failed:
        stages[failed] = "failed"
    native = None if effective is None else {"effective_predictions_for_observation": effective,
                                           "predictions_written": effective, "settlements_written": 0}
    return ops._event(identity, context, start, start + dt.timedelta(minutes=1), native,
                      audited, audit_errors, stages, published,
                      producer_observed_failure=producer_observed_failure)


def admitted(value, binding):
    raw = ops.journal.encode(ops.journal.new_journal(), observed_at=value["finished_at"])
    return ops.journal.append(raw, value, binding=binding, observed_at=value["finished_at"])


@pytest.mark.parametrize("bad", [None, False, True, -1, 1001, 0.0, "0"])
def test_native_count_never_defaults_to_zero(bad):
    context = ops.producer.build_run_context(START, run_mode="scheduled")
    native = {"run": context, "predictions_written": 0, "settlements_written": 0,
              "effective_predictions_for_observation": bad}
    with pytest.raises(ops.OpsError, match="missing_receipt"):
        ops._native_receipt(native, context)


@pytest.mark.parametrize("report", [
    {"status": "failed", "errors": ["synthetic"], "stats": {}},
    {"status": "healthy", "errors": [], "stats": {}},
    {"status": "healthy", "errors": [], "stats": {"prediction_due": True,
     "prediction_expected": True, "effective_predictions_for_observation": False}},
])
def test_empty_audit_stats_are_not_zero(report):
    context = ops.producer.build_run_context(START, run_mode="scheduled")
    with pytest.raises(ops.OpsError, match="missing_receipt"):
        ops._audit_receipt(report, context)


@pytest.mark.parametrize("effective,audited", [(None, 0), (0, None), (0, 1), (1, 0)])
def test_missing_or_conflicting_counts_are_technical_failure(effective, audited):
    value, binding = event(effective=effective, audited=audited, published=None)
    assert (value["outcome"], value["reason"]) == ("failed", "missing_receipt")
    assert value["qualified_data"] is None
    admitted(value, binding)


def test_observed_producer_exception_is_known_failure_not_zero():
    value, binding = event(effective=None, audited=None, failed="producer", published=None,
                           producer_observed_failure=True)
    assert value["reason"] == "producer_failed"
    assert value["outcome"] == "failed"
    admitted(value, binding)


def test_audited_zero_preserves_failed_execution_axis():
    value, binding = event(effective=0, audited=0, audit_errors=True, failed="audit", published=None)
    assert (value["outcome"], value["workflow_status"], value["workflow_reason"]) == (
        "zero_effective", "failed", "audit_rejected")
    admitted(value, binding)


@pytest.mark.parametrize("failed", ["calibration", "audit", "evidence", "publication"])
def test_positive_count_does_not_qualify_failed_stages(failed):
    value, binding = event(failed=failed, audit_errors=failed == "audit", published=None)
    assert value["outcome"] == "failed"
    assert value["qualified_data"] is None
    admitted(value, binding)


def test_positive_count_does_not_qualify_unconfirmed_publication():
    value, binding = event(published=None)
    assert value["reason"] == "publication_failed"
    admitted(value, binding)


def test_confirmed_financial_commit_survives_ci_dispatch_failure():
    value, binding = event(failed="ci_dispatch")
    assert value["outcome"] == "qualified"
    assert value["qualified_data"] == PUBLISHED
    assert value["workflow_status"] == "failed"
    assert value["workflow_reason"] == "ci_dispatch_failed"
    admitted(value, binding)


@pytest.mark.parametrize("mode,start,reason", [
    ("manual", START, "manual_observation_only"),
    ("scheduled", dt.datetime(2026, 10, 7, 6, 35, tzinfo=dt.timezone.utc), "non_trading_day"),
    ("scheduled", dt.datetime(2026, 10, 13, 0, 1, tzinfo=dt.timezone.utc), "scheduled_window_missed"),
])
def test_manual_holiday_cross_day_never_qualifies(mode, start, reason):
    value, binding = event(mode=mode, start=start)
    assert (value["outcome"], value["reason"]) == ("skipped", reason)
    assert value["qualified_data"] is None
    admitted(value, binding)


def test_unsupported_calendar_stays_blocked():
    value, binding = event(start=dt.datetime(2027, 10, 13, 6, 35, tzinfo=dt.timezone.utc))
    assert (value["outcome"], value["reason"]) == ("blocked", "calendar_unsupported")
    assert value["workflow_status"] == "failed"
    admitted(value, binding)


@pytest.mark.parametrize("start,status", [
    (dt.datetime(2026, 10, 13, 6, 30, tzinfo=dt.timezone.utc), "open"),
    (dt.datetime(2026, 10, 13, 7, 20, tzinfo=dt.timezone.utc), "open"),
    (dt.datetime(2026, 10, 13, 7, 20, 1, tzinfo=dt.timezone.utc), "delayed_same_day"),
])
def test_utc_window_boundaries_keep_actual_start_and_delay(start, status):
    value, binding = event(start=start)
    assert value["window_status"] == status
    assert value["started_at"] == ops._clock(start)
    admitted(value, binding)


def test_calendar_disagreement_fails_closed(monkeypatch):
    monkeypatch.setattr(ops.auditor, "NON_TRADING_DATES", {"2026-10-13"})
    with pytest.raises(ops.OpsError, match="calendar_unsupported"):
        ops._calendar()


def test_preexisting_financial_index_stops_financial_add(monkeypatch):
    calls = []
    def command(*args):
        calls.append(args)
        return (next(iter(ops.FINANCIAL.values())) + "\0").encode()
    monkeypatch.setattr(ops, "_command", command)
    with pytest.raises(ops.OpsError, match="publication_failed"):
        ops._stage_only(tuple(ops.FINANCIAL.values()))
    assert len(calls) == 1


def test_empty_index_is_a_valid_no_change_path(monkeypatch):
    monkeypatch.setattr(ops, "_command", lambda *args: b"")
    assert ops._stage_only(tuple(ops.FINANCIAL.values())) is False


def fresh_ops_raw():
    value, binding = event()
    return ops._append_ops(None, value, binding, END, ops._calendar())[0]


def checkpoint_mock(monkeypatch, *, remote=None, changed_after=False, error=False):
    calls = []
    context = object()
    tips = iter((IDENTITY["source_sha"], "f" * 40)) if changed_after else None
    monkeypatch.setattr(ops, "_head", lambda: IDENTITY["source_sha"])
    monkeypatch.setattr(ops, "_remote_head", lambda: next(tips) if tips else remote or IDENTITY["source_sha"])
    monkeypatch.setattr(ops, "_now", lambda: END)
    monkeypatch.setattr(ops, "_command", lambda *args, **kwargs: pytest.fail("journal must not mutate any Git object or ref"))
    def publish(actual, raw, **kwargs):
        assert actual is context
        calls.append((raw, kwargs))
        if error:
            raise ops.artifact_store.ArtifactError("output_failed")
        return {"checkpoint": kwargs["checkpoint"], "event_recorded": kwargs["checkpoint"] == "terminal"}
    monkeypatch.setattr(ops.artifact_store, "publish", publish)
    return calls, context


@pytest.mark.parametrize("checkpoint", ["restored", "terminal", "check_only"])
def test_ops_checkpoint_has_no_git_index_head_object_or_branch_write(monkeypatch, checkpoint):
    raw = fresh_ops_raw()
    calls, context = checkpoint_mock(monkeypatch)
    assert ops._publish_ops(IDENTITY["source_sha"], context, raw, checkpoint=checkpoint) == {
        "checkpoint": checkpoint, "event_recorded": checkpoint == "terminal"}
    assert calls == [(raw, {"checkpoint": checkpoint, "observed_at": ops._clock(END)})]


def test_unknown_financial_effect_has_no_safe_terminal_checkpoint_base(monkeypatch):
    raw = fresh_ops_raw()
    calls, context = checkpoint_mock(monkeypatch)
    monkeypatch.setattr(ops, "_head", lambda: "d" * 40)
    with pytest.raises(ops.OpsError, match="publication_failed"):
        ops._publish_ops(IDENTITY["source_sha"], context, raw)
    assert calls == []


def test_remote_main_change_stops_before_checkpoint_write(monkeypatch):
    raw = fresh_ops_raw()
    calls, context = checkpoint_mock(monkeypatch, remote="f" * 40)
    with pytest.raises(ops.OpsError, match="publication_failed"):
        ops._publish_ops(IDENTITY["source_sha"], context, raw)
    assert calls == []


def test_changed_main_after_local_checkpoint_reports_failure_without_retry(monkeypatch):
    raw = fresh_ops_raw()
    calls, context = checkpoint_mock(monkeypatch, changed_after=True)
    with pytest.raises(ops.OpsError, match="publication_failed"):
        ops._publish_ops(IDENTITY["source_sha"], context, raw)
    assert len(calls) == 1


def test_failed_checkpoint_write_is_never_retried(monkeypatch):
    raw = fresh_ops_raw()
    calls, context = checkpoint_mock(monkeypatch, error=True)
    with pytest.raises(ops.artifact_store.ArtifactError, match="output_failed"):
        ops._publish_ops(IDENTITY["source_sha"], context, raw)
    assert len(calls) == 1


def test_history_restore_uses_only_fixed_artifact_store_and_no_git_ref(monkeypatch):
    calls = []
    context, raw = object(), fresh_ops_raw()
    monkeypatch.setattr(ops, "_now", lambda: END)
    monkeypatch.setattr(ops, "_command", lambda *args, **kwargs: pytest.fail("no history Git command allowed"))
    def restore(root, identity, **kwargs):
        calls.append((root, identity, kwargs))
        return context, raw
    monkeypatch.setattr(ops.artifact_store, "restore", restore)
    assert ops._read_ops_history(IDENTITY) == (context, raw)
    assert calls == [(ops.ROOT, IDENTITY, {"observed_at": ops._clock(END)})]


def test_failed_history_query_is_not_treated_as_absent(monkeypatch):
    monkeypatch.setattr(ops, "_now", lambda: END)
    def restore(*args, **kwargs):
        raise ops.artifact_store.ArtifactError("history_missing")
    monkeypatch.setattr(ops.artifact_store, "restore", restore)
    with pytest.raises(ops.artifact_store.ArtifactError, match="history_missing"):
        ops._read_ops_history(IDENTITY)


def test_commit_tree_mismatch_is_not_qualification(monkeypatch, tmp_path):
    monkeypatch.setattr(ops, "ROOT", tmp_path)
    for path in ops.FINANCIAL.values():
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"synthetic\n")
    monkeypatch.setattr(ops, "_command", lambda *args: b"10\n" if args[1] == "cat-file" else b"different\n")
    with pytest.raises(ops.OpsError, match="publication_failed"):
        ops._digests_in_tree(PUBLISHED["commit_sha"])


def test_all_four_exact_commit_bytes_are_hashed(monkeypatch, tmp_path):
    monkeypatch.setattr(ops, "ROOT", tmp_path)
    raw = b"synthetic\n"
    for path in ops.FINANCIAL.values():
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    monkeypatch.setattr(ops, "_command", lambda *args: b"10\n" if args[1] == "cat-file" else raw)
    assert ops._digests_in_tree(PUBLISHED["commit_sha"]) == {
        key: hashlib.sha256(raw).hexdigest() for key in ops.FINANCIAL}


def test_unchanged_financial_files_still_require_confirmed_commit_digests(monkeypatch):
    calls = []
    monkeypatch.setattr(ops, "_head", lambda: IDENTITY["source_sha"])
    monkeypatch.setattr(ops, "_remote_head", lambda: IDENTITY["source_sha"])
    monkeypatch.setattr(ops, "_file_bytes", lambda path: b"synthetic\n")
    monkeypatch.setattr(ops, "_stage_only", lambda paths: False)
    def digests(commit):
        calls.append(commit)
        return {key: "c" * 64 for key in ops.FINANCIAL}
    monkeypatch.setattr(ops, "_digests_in_tree", digests)
    monkeypatch.setattr(ops, "_command", lambda *args: pytest.fail("unchanged path must not commit or push"))
    result = ops._publish_financial(IDENTITY["source_sha"])
    assert result == {**PUBLISHED, "commit_sha": IDENTITY["source_sha"]}
    assert calls == [IDENTITY["source_sha"]]


def test_unknown_financial_push_is_a_single_attempt(monkeypatch):
    calls = []
    heads = iter((IDENTITY["source_sha"], PUBLISHED["commit_sha"]))
    monkeypatch.setattr(ops, "_head", lambda: next(heads))
    monkeypatch.setattr(ops, "_remote_head", lambda: IDENTITY["source_sha"])
    monkeypatch.setattr(ops, "_file_bytes", lambda path: b"synthetic\n")
    monkeypatch.setattr(ops, "_stage_only", lambda paths: True)
    monkeypatch.setattr(ops, "_digests_in_tree", lambda commit: {key: "c" * 64 for key in ops.FINANCIAL})
    def command(*args, env=None):
        calls.append(args)
        if "push" in args:
            assert env["OVERSEAS_PUSH_OLD"] == IDENTITY["source_sha"]
            assert env["OVERSEAS_PUSH_NEW"] == PUBLISHED["commit_sha"]
            assert env["OVERSEAS_PUSH_REF"] == "refs/heads/main"
            raise ops.OpsError("publication_failed")
        return b""
    monkeypatch.setattr(ops, "_command", command)
    with pytest.raises(ops.OpsError, match="publication_failed"):
        ops._publish_financial(IDENTITY["source_sha"])
    assert ["push" if "push" in args else args[1] for args in calls] == ["commit", "push"]


@pytest.mark.parametrize("ref,old", [("refs/heads/main", "a" * 40), ("refs/heads/main", "e" * 40)])
def test_single_push_uses_fixed_hook_and_overrides_ambient_expectations(monkeypatch, ref, old):
    calls = []
    monkeypatch.setenv("OVERSEAS_PUSH_REF", "refs/heads/foreign")
    monkeypatch.setenv("OVERSEAS_PUSH_OLD", "f" * 40)
    monkeypatch.setattr(ops, "_command", lambda *args, **kwargs: calls.append((args, kwargs)))
    ops._push_once(ref, old, "d" * 40)
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args == ("git", "-c", "core.hooksPath=" + str(ops.ROOT / "tools" / "overseas-hooks"),
                    "push", "origin", "d" * 40 + ":" + ref)
    assert {key: kwargs["env"][key] for key in (
        "OVERSEAS_PUSH_REF", "OVERSEAS_PUSH_OLD", "OVERSEAS_PUSH_NEW")} == {
        "OVERSEAS_PUSH_REF": ref, "OVERSEAS_PUSH_OLD": old or "0" * 40,
        "OVERSEAS_PUSH_NEW": "d" * 40}
    assert not any("force" in arg or arg.startswith("+") or arg == "--no-verify" for arg in args)


@pytest.mark.parametrize("ref,old,new", [("refs/heads/foreign", "a" * 40, "d" * 40),
    ("refs/heads/main", None, "d" * 40), ("refs/heads/main", False, "d" * 40),
    ("refs/heads/main", "short", "d" * 40), ("refs/heads/main", None, "0" * 40),
    ("refs/heads/ops/overseas-run-journal", "a" * 40, "d" * 40)])
def test_invalid_push_binding_has_zero_git_calls(monkeypatch, ref, old, new):
    monkeypatch.setattr(ops, "_command", lambda *args, **kwargs: pytest.fail("no Git command allowed"))
    with pytest.raises(ops.OpsError, match="publication_failed"):
        ops._push_once(ref, old, new)


@pytest.mark.parametrize("old", ["a" * 40, "e" * 40])
def test_fixed_hook_accepts_only_exact_single_ref_advertisement(old):
    loader = SourceFileLoader("overseas_push_hook", str(ROOT / "tools" / "overseas-hooks" / "pre-push"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    hook = importlib.util.module_from_spec(spec)
    loader.exec_module(hook)
    ref, new = "refs/heads/main", "d" * 40
    env = {"OVERSEAS_PUSH_REF": ref, "OVERSEAS_PUSH_OLD": old, "OVERSEAS_PUSH_NEW": new}
    raw = f"{new} {new} {ref} {old}\n".encode()
    assert hook.accepts(["origin", "synthetic-file-origin"], env, raw) is True
    for bad in (b"", raw + raw, raw + b"\n", raw.replace(old.encode(), b"f" * 40),
                raw.replace(ref.encode(), b"refs/heads/ops/overseas-run-journal"), raw.replace(new.encode(), b"c" * 40),
                raw.replace((new + " ").encode(), b"HEAD ", 1), b"x" * 4097):
        assert hook.accepts(["origin", "synthetic-file-origin"], env, bad) is False
    assert hook.accepts(["other", "synthetic-file-origin"], env, raw) is False
    assert hook.accepts(["origin"], env, raw) is False


def test_three_zero_runs_and_recovery_preserve_old_pointer():
    calendar_sha = ops._calendar()
    first, binding = event(start=dt.datetime(2026, 10, 8, 6, 35, tzinfo=dt.timezone.utc))
    raw, _ = ops._append_ops(None, first, binding, dt.datetime(2026, 10, 8, 6, 36, tzinfo=dt.timezone.utc), calendar_sha)
    for i, day in enumerate((9, 12, 13), 1):
        value, binding = event(effective=0, audited=0, published=None,
                               start=dt.datetime(2026, 10, day, 6, 35, tzinfo=dt.timezone.utc))
        value["run_id"] += i
        binding["run_id"] += i
        raw, result = ops._append_ops(raw, value, binding, dt.datetime(2026, 10, day, 6, 36, tzinfo=dt.timezone.utc), calendar_sha)
        assert result["zero_streak_exact"] == i
        assert result["last_qualified_financial_index"] == 0
    value, binding = event()
    value["run_id"] += 4
    binding["run_id"] += 4
    value["started_at"], value["finished_at"] = "2026-10-13T06:37:00Z", "2026-10-13T06:38:00Z"
    raw, result = ops._append_ops(raw, value, binding, dt.datetime(2026, 10, 13, 6, 38, tzinfo=dt.timezone.utc), calendar_sha)
    assert result["zero_streak_exact"] == 0
    assert result["last_qualified_financial_index"] == 4
    assert result["latest_scheduled_failure_index"] == 3
    assert result["event_count"] == 5
    value, binding = event(effective=0, audited=0, published=None)
    value["run_id"] += 5
    binding["run_id"] += 5
    value["started_at"], value["finished_at"] = "2026-10-13T06:39:00Z", "2026-10-13T06:40:00Z"
    _, result = ops._append_ops(raw, value, binding, dt.datetime(2026, 10, 13, 6, 40, tzinfo=dt.timezone.utc), calendar_sha)
    assert result["zero_streak_exact"] == 3
    assert result["last_qualified_financial_index"] == 4
    assert result["latest_scheduled_failure_index"] == 5
    assert result["alert_required"] is True


def test_append_identical_occurrence_is_idempotent_and_changed_replay_stops():
    value, binding = event()
    calendar_sha = ops._calendar()
    raw, summary = ops._append_ops(None, value, binding, END, calendar_sha)
    same, same_summary = ops._append_ops(raw, value, binding, END, calendar_sha)
    assert same == raw and same_summary == summary and summary["event_count"] == 1
    value["qualified_data"] = {**PUBLISHED, "commit_sha": "f" * 40}
    with pytest.raises(ops.journal.JournalError, match="conflicting_replay"):
        ops._append_ops(raw, value, binding, END, calendar_sha)


def test_midnight_does_not_mark_the_not_yet_due_new_trading_day_missing(monkeypatch):
    expected = []
    summarize = ops.journal.summarize
    def capture(raw, **kwargs):
        expected.append(kwargs["expected_dates"])
        return summarize(raw, **kwargs)
    monkeypatch.setattr(ops.journal, "summarize", capture)
    value, binding = event(start=dt.datetime(2026, 10, 13, 16, 1, tzinfo=dt.timezone.utc))
    assert value["date"] == "2026-10-13" and value["window_status"] == "delayed_cross_day"
    ops._append_ops(None, value, binding, dt.datetime(2026, 10, 13, 16, 2, tzinfo=dt.timezone.utc), ops._calendar())
    assert expected == [("2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13")]


def test_journal_check_only_has_zero_producer_financial_calendar_or_event_calls(monkeypatch, capsys):
    identity = {**IDENTITY, "mode": "manual"}
    raw = ops.journal.encode(ops.journal.new_journal(), observed_at=ops._clock(END))
    context, calls = object(), []
    monkeypatch.setattr(ops, "_identity", lambda: identity.copy())
    monkeypatch.setenv("OVERSEAS_JOURNAL_CHECK_ONLY", "true")
    monkeypatch.setattr(ops, "_read_ops_history", lambda actual: (context, raw))
    for name in ("_calendar", "_publish_financial", "_dispatch", "_event", "_append_ops"):
        monkeypatch.setattr(ops, name, lambda *args, **kwargs: pytest.fail("check-only cannot run business/calendar/event code"))
    monkeypatch.setattr(ops.producer, "run_pipeline", lambda **kwargs: pytest.fail("no provider"))
    def checkpoint(base, actual, current, *, checkpoint):
        assert base == identity["source_sha"] and actual is context and current is raw
        calls.append(checkpoint)
        return {"checkpoint": checkpoint, "event_recorded": False,
                "journal_sha256": hashlib.sha256(raw).hexdigest(), "journal_bytes": len(raw), "event_count": 0}
    monkeypatch.setattr(ops, "_publish_ops", checkpoint)
    assert ops.run() == 0 and calls == ["restored", "check_only"]
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == "journal_check_only" and output["event_recorded"] is False
    assert output["journal_sha256"] == hashlib.sha256(raw).hexdigest()
    assert "events" not in output and "qualified_data" not in output


def test_scheduled_run_cannot_enable_manual_check_only(monkeypatch):
    monkeypatch.setattr(ops, "_identity", lambda: IDENTITY.copy())
    monkeypatch.setenv("OVERSEAS_JOURNAL_CHECK_ONLY", "true")
    monkeypatch.setattr(ops, "_read_ops_history", lambda *args: pytest.fail("must reject before storage IO"))
    with pytest.raises(ops.OpsError):
        ops.run()


def test_failure_after_restore_keeps_state_but_never_fabricates_terminal_event(monkeypatch):
    calls = []
    monkeypatch.setattr(ops, "_identity", lambda: IDENTITY.copy())
    monkeypatch.setenv("OVERSEAS_JOURNAL_CHECK_ONLY", "false")
    monkeypatch.setattr(ops, "_read_ops_history", lambda identity: (object(), b"synthetic-state"))
    monkeypatch.setattr(ops, "_publish_ops", lambda *args, checkpoint: calls.append(checkpoint))
    def calendar():
        raise ops.OpsError("calendar_unsupported")
    monkeypatch.setattr(ops, "_calendar", calendar)
    assert ops.main() == 1 and calls == ["restored"]


def runner_mock(monkeypatch, tmp_path, *, fail=None, effective=1, audited=1, audit_errors=False):
    calls, persisted = [], []
    context = ops.producer.build_run_context(START, run_mode="scheduled", schedule_time="14:35",
                                            early_minutes=5, late_minutes=45)
    ledger, registry = tmp_path / "ledger.json", tmp_path / "registry.json"
    monkeypatch.setattr(ops.producer, "LEDGER", ledger)
    monkeypatch.setattr(ops.producer, "REGISTRY", registry)
    monkeypatch.setattr(ops.auditor, "REPORT", tmp_path / "audit.json")
    monkeypatch.setattr(ops.exporter, "DEFAULT_OUTPUT", tmp_path / "evidence.json")
    monkeypatch.setattr(ops, "_identity", lambda: IDENTITY.copy())
    monkeypatch.setattr(ops, "_read_ops_history", lambda identity: (None, None))
    monkeypatch.setenv("OVERSEAS_JOURNAL_CHECK_ONLY", "false")
    monkeypatch.setenv("FUND_API_BASE", "https://synthetic.invalid")
    # Deterministic real-occurrence-shaped fixture, not a live natural window.
    clocks = iter((START, END, END, END))
    monkeypatch.setattr(ops, "_now", lambda: next(clocks))
    monkeypatch.setattr(ops, "_command", lambda *args, **kwargs: pytest.fail("Git must be mocked"))
    def stage(name):
        calls.append(name)
        if fail == name:
            raise ValueError("synthetic secret/provider text must not be printed")
    def pipeline(*, now, run_mode):
        stage("producer")
        assert now == START and run_mode == "scheduled"
        ledger.write_text(json.dumps({"pipeline": {key: value for key, value in context.items()
                                                  if key != "prediction_allowed"}}), encoding="utf-8")
        registry.write_text("{}", encoding="utf-8")
        return {"run": context, "predictions_written": effective, "settlements_written": 0,
                "effective_predictions_for_observation": effective}
    def audit(value, model, *, now):
        stage("audit")
        assert now == END and value["pipeline"]["observation_date"] == context["observation_date"]
        return {"status": "failed" if audit_errors else "healthy", "errors": ["synthetic"] if audit_errors else [],
                "stats": {"prediction_due": context["prediction_due"],
                          "prediction_expected": context["prediction_expected"],
                          "effective_predictions_for_observation": audited}}
    def build_export(value):
        stage("evidence")
        return {"synthetic_public_scalar": 1}
    def write_json(path, value):
        path.write_text(json.dumps(value), encoding="utf-8")
    def publish_financial(source):
        stage("publication")
        assert source == IDENTITY["source_sha"]
        return PUBLISHED.copy()
    def dispatch(commit):
        stage("ci_dispatch")
        assert commit == PUBLISHED["commit_sha"]
    def publish_ops(base, prior, raw, *, checkpoint="terminal"):
        if checkpoint == "restored":
            return {"checkpoint": checkpoint, "event_recorded": False}
        calls.append("ops")
        assert prior is None
        persisted.append((base, ops.journal.decode(raw, observed_at=ops._clock(END))))
        return "d" * 40
    monkeypatch.setattr(ops.producer, "run_pipeline", pipeline)
    monkeypatch.setattr(ops.producer, "write_json_atomic", write_json)
    monkeypatch.setattr(ops.calibrator, "main", lambda: stage("calibration"))
    monkeypatch.setattr(ops.auditor, "audit", audit)
    monkeypatch.setattr(ops.exporter, "build_export", build_export)
    monkeypatch.setattr(ops, "_publish_financial", publish_financial)
    monkeypatch.setattr(ops, "_dispatch", dispatch)
    monkeypatch.setattr(ops, "_publish_ops", publish_ops)
    return calls, persisted


@pytest.mark.parametrize("fail,reason", [
    ("producer", "producer_failed"), ("calibration", "calibration_failed"),
    ("audit", "missing_receipt"), ("evidence", "evidence_failed"),
    ("publication", "publication_failed"), ("ci_dispatch", "ci_dispatch_failed"),
])
def test_whole_runner_stage_failure_uses_known_fixed_receipt_and_separate_ops(monkeypatch, tmp_path, capsys, fail, reason):
    calls, persisted = runner_mock(monkeypatch, tmp_path, fail=fail)
    assert ops.run() == 1
    assert len(persisted) == 1
    base, state = persisted[0]
    value = state["events"][0]
    assert value["workflow_status"] == "failed" and value["workflow_reason"] == reason
    if fail == "ci_dispatch":
        assert value["reason"] == "financial_qualified"
        assert value["outcome"] == "qualified" and value["qualified_data"] == PUBLISHED
        assert base == PUBLISHED["commit_sha"]
    else:
        assert value["reason"] == reason
        assert value["outcome"] == "failed" and value["qualified_data"] is None
        assert base == IDENTITY["source_sha"]
    if fail == "calibration":
        assert "audit" in calls and "publication" not in calls
    output = capsys.readouterr()
    assert "secret/provider" not in output.out + output.err


@pytest.mark.parametrize("effective,audited,errors,outcome,status", [
    (1, 1, False, "qualified", 0), (0, 0, True, "zero_effective", 1),
    (None, None, False, "failed", 1), (1, 0, False, "failed", 1),
])
def test_whole_runner_native_and_audit_counts_are_independent(monkeypatch, tmp_path, effective, audited, errors, outcome, status):
    calls, persisted = runner_mock(monkeypatch, tmp_path, effective=effective, audited=audited, audit_errors=errors)
    assert ops.run() == status
    value = persisted[0][1]["events"][0]
    assert value["outcome"] == outcome
    assert value["started_at"] == "2026-10-13T06:35:00Z"
    assert value["finished_at"] == "2026-10-13T06:36:00Z"
    if effective is None or effective != audited:
        assert value["reason"] == "missing_receipt"
        assert "evidence" not in calls and "publication" not in calls and "ci_dispatch" not in calls
    if outcome != "qualified":
        assert value["qualified_data"] is None


def test_missing_configured_api_is_recorded_without_provider_or_financial_write(monkeypatch, tmp_path):
    calls, persisted = runner_mock(monkeypatch, tmp_path)
    monkeypatch.delenv("FUND_API_BASE", raising=False)
    assert ops.run() == 1
    assert calls == ["ops"]
    assert persisted[0][0] == IDENTITY["source_sha"]
    assert persisted[0][1]["events"][0]["reason"] == "producer_failed"


@pytest.mark.parametrize("field,bad", [
    ("GITHUB_SHA", "short"), ("GITHUB_RUN_ID", "0"), ("GITHUB_RUN_ATTEMPT", "101"),
    ("GITHUB_EVENT_NAME", "push"), ("GITHUB_REF", "refs/heads/ops/overseas-run-journal"),
    ("GITHUB_REPOSITORY", "other/repo"),
])
def test_identity_rejects_wrong_source_event_ref_or_repository_before_any_git_write(monkeypatch, field, bad):
    values = {"GITHUB_SHA": IDENTITY["source_sha"], "GITHUB_RUN_ID": str(IDENTITY["run_id"]),
              "GITHUB_RUN_ATTEMPT": "1", "GITHUB_EVENT_NAME": "schedule",
              "GITHUB_REF": "refs/heads/main", "GITHUB_REPOSITORY": "AureliusWu/fund-compass"}
    values[field] = bad
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(ops, "_head", lambda: IDENTITY["source_sha"])
    monkeypatch.setattr(ops, "_command", lambda *args: pytest.fail("invalid identity must short-circuit"))
    with pytest.raises(ops.OpsError, match="missing_receipt"):
        ops._identity()
