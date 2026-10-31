#!/usr/bin/env python3
"""One controlled runner: native receipts, public journal, one financial Git ref.

This is not a generic receipt authorizer, cloud migration or release gate.
Only the four existing public overseas files may be staged on main. The one
nonfinancial journal is checkpointed for an immutable Actions artifact, never
checkout/index/HEAD or an operations branch. Unknown publication is not retried.
"""
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

try:
    from tools import overseas_accuracy as producer
    from tools import audit_overseas_accuracy as auditor
    from tools import calibrate_overseas as calibrator
    from tools import export_v8_overseas_evidence as exporter
    from tools import overseas_run_journal as journal
    from tools import overseas_journal_artifact as artifact_store
except ModuleNotFoundError:
    import overseas_accuracy as producer
    import audit_overseas_accuracy as auditor
    import calibrate_overseas as calibrator
    import export_v8_overseas_evidence as exporter
    import overseas_run_journal as journal
    import overseas_journal_artifact as artifact_store

ROOT = Path(__file__).resolve().parents[1]
FINANCIAL = {
    "ledger_sha256": "frontend/public/data/overseas-accuracy.json",
    "audit_sha256": "frontend/public/data/overseas-audit.json",
    "models_sha256": "frontend/src/data/overseas-models.json",
    "evidence_sha256": "backend/data/overseas-evidence.json",
}
OBSERVATION_START = dt.date(2026, 10, 8)
MAX_FILE_BYTES = 8 * 1024 * 1024
UTC = dt.timezone.utc
STAGES = ("producer", "calibration", "audit", "evidence", "publication", "ci_dispatch")
FAILURES = {
    "producer": "producer_failed", "calibration": "calibration_failed",
    "audit": "audit_rejected", "evidence": "evidence_failed",
    "publication": "publication_failed", "ci_dispatch": "ci_dispatch_failed",
}


class OpsError(ValueError):
    def __init__(self, reason="missing_receipt"):
        if reason not in {*FAILURES.values(), "missing_receipt", "calendar_unsupported"}:
            reason = "missing_receipt"
        self.reason = reason
        super().__init__(reason)


def _now():
    return dt.datetime.now(UTC).replace(microsecond=0)


def _clock(value):
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _count(value):
    if type(value) is not int or not 0 <= value <= 1000:
        raise OpsError()
    return value


def _command(*args, stdin=None, env=None):
    """Fixed caller commands only; capture but never print raw child errors."""
    try:
        result = subprocess.run(args, cwd=ROOT, input=stdin, check=False,
                                capture_output=True, timeout=45, env=env)
    except (OSError, subprocess.TimeoutExpired):
        raise OpsError("publication_failed") from None
    if result.returncode:
        raise OpsError("publication_failed")
    if len(result.stdout) > MAX_FILE_BYTES:
        raise OpsError("publication_failed")
    return result.stdout


def _sha40(raw):
    if type(raw) is not bytes or re.fullmatch(rb"[0-9a-f]{40}\n?", raw) is None:
        raise OpsError("publication_failed")
    return raw.decode("ascii").strip()


def _head():
    return _sha40(_command("git", "rev-parse", "HEAD"))


def _remote_head():
    raw = _command("git", "ls-remote", "--exit-code", "origin", "refs/heads/main")
    match = re.fullmatch(rb"([0-9a-f]{40})\trefs/heads/main\n", raw)
    if match is None:
        raise OpsError("publication_failed")
    return match[1].decode("ascii")


def _read_ops_history(identity):
    return artifact_store.restore(ROOT, identity, observed_at=_clock(_now()))


def _identity():
    source = os.environ.get("GITHUB_SHA", "")
    run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if (
        re.fullmatch(r"[0-9a-f]{40}", source) is None
        or re.fullmatch(r"[1-9][0-9]{0,15}", run_id) is None
        or re.fullmatch(r"[1-9][0-9]{0,2}", attempt) is None
        or not 1 <= int(run_id) <= 2**53 - 1 or not 1 <= int(attempt) <= 100
        or event not in ("schedule", "workflow_dispatch")
        or os.environ.get("GITHUB_REF") != "refs/heads/main"
        or os.environ.get("GITHUB_REPOSITORY") != "AureliusWu/fund-compass" or _head() != source
        or _command("git", "status", "--porcelain", "--untracked-files=all")
    ):
        raise OpsError()
    return {"source_sha": source, "run_id": int(run_id), "attempt": int(attempt),
            "mode": "scheduled" if event == "schedule" else "manual"}


def _calendar():
    """Check all three duplicated calendars; exporter imports producer's one."""
    values = []
    for module in (producer, auditor, calibrator):
        if type(module.BUILTIN_NON_TRADING_DATES) is not set or type(module.NON_TRADING_DATES) is not set:
            raise OpsError("calendar_unsupported")
        dates = module.BUILTIN_NON_TRADING_DATES | module.NON_TRADING_DATES
        if len(dates) > journal.MAX_EVENTS or module.SUPPORTED_CALENDAR_YEARS != {2025, 2026}:
            raise OpsError("calendar_unsupported")
        for value in dates:
            if type(value) is not str:
                raise OpsError("calendar_unsupported")
            try:
                parsed = dt.date.fromisoformat(value)
            except ValueError:
                raise OpsError("calendar_unsupported") from None
            if parsed.isoformat() != value or parsed.year not in module.SUPPORTED_CALENDAR_YEARS:
                raise OpsError("calendar_unsupported")
        values.append(dates)
    if not values[0] == values[1] == values[2]:
        raise OpsError("calendar_unsupported")
    raw = json.dumps({"years": [2025, 2026], "closed": sorted(values[0]),
                      "schedule": "06:35Z", "early_minutes": 5, "late_minutes": 45},
                     sort_keys=True, separators=(",", ":")).encode("ascii")
    return hashlib.sha256(raw).hexdigest()


def _native_receipt(result, expected):
    if type(result) is not dict or type(result.get("run")) is not dict or result["run"] != expected:
        raise OpsError()
    return {key: _count(result.get(key)) for key in (
        "predictions_written", "settlements_written", "effective_predictions_for_observation")}


def _audit_receipt(report, expected):
    if (
        type(report) is not dict or type(report.get("errors")) is not list
        or type(report.get("stats")) is not dict
        or report.get("status") not in ("healthy", "warning", "failed")
        or (report["status"] == "failed") != bool(report["errors"])
    ):
        raise OpsError()
    stats = report["stats"]
    for key in ("prediction_due", "prediction_expected"):
        if type(stats.get(key)) is not bool or stats[key] is not expected[key]:
            raise OpsError()
    return _count(stats.get("effective_predictions_for_observation")), bool(report["errors"])


def _file_bytes(path):
    target = ROOT / path
    if not target.is_file() or target.is_symlink() or target.stat().st_size > MAX_FILE_BYTES:
        raise OpsError("publication_failed")
    raw = target.read_bytes()
    if not raw or len(raw) > MAX_FILE_BYTES:
        raise OpsError("publication_failed")
    return raw


def _digests_in_tree(commit):
    output = {}
    for key, path in FINANCIAL.items():
        local = _file_bytes(path)
        size = _command("git", "cat-file", "-s", f"{commit}:{path}")
        if re.fullmatch(rb"[0-9]+\n", size) is None or int(size) != len(local):
            raise OpsError("publication_failed")
        tree = _command("git", "show", f"{commit}:{path}")
        if tree != local:
            raise OpsError("publication_failed")
        output[key] = hashlib.sha256(local).hexdigest()
    return output


def _stage_only(paths):
    if _command("git", "diff", "--cached", "--name-only", "-z"):
        raise OpsError("publication_failed")
    _command("git", "add", "--", *paths)
    cached = _command("git", "diff", "--cached", "--name-only", "-z")
    if cached and set(cached.rstrip(b"\0").split(b"\0")) - {path.encode("ascii") for path in paths}:
        raise OpsError("publication_failed")
    return bool(cached)


def _push_once(ref, expected_old, commit):
    """Normal push, guarded against the server's actual advertised old OID.

    A preflight ls-remote is not CAS: deletion/rollback before push would still
    permit a normal push. Our fixed pre-push hook rejects that advertisement;
    receive-pack then checks the advertised old OID during the update. This is
    only a single-ref guard, not an artifact publication or cross-system ACK.
    """
    if ref != "refs/heads/main" or (
        expected_old is not None and (
            type(expected_old) is not str or re.fullmatch(r"[0-9a-f]{40}", expected_old) is None
        )
    ) or type(commit) is not str or re.fullmatch(r"[0-9a-f]{40}", commit) is None or commit == "0" * 40:
        raise OpsError("publication_failed")
    if ref == "refs/heads/main" and expected_old is None:
        raise OpsError("publication_failed")
    env = os.environ.copy()
    env.update({"OVERSEAS_PUSH_REF": ref, "OVERSEAS_PUSH_OLD": expected_old or "0" * 40,
                "OVERSEAS_PUSH_NEW": commit})
    _command("git", "-c", "core.hooksPath=" + str(ROOT / "tools" / "overseas-hooks"),
             "push", "origin", f"{commit}:{ref}", env=env)


def _publish_financial(source):
    if _head() != source or _remote_head() != source:
        raise OpsError("publication_failed")
    for path in FINANCIAL.values():
        _file_bytes(path)
    if _stage_only(tuple(FINANCIAL.values())):
        _command("git", "commit", "-m", "chore: 更新海外估值精度账本")
        commit = _head()
        digests = _digests_in_tree(commit)
        # One attempt only: errors/timeouts may have had a remote effect.
        _push_once("refs/heads/main", source, commit)
    else:
        commit, digests = source, _digests_in_tree(source)
    if _remote_head() != commit:
        raise OpsError("publication_failed")
    return {"commit_sha": commit, **digests}


def _dispatch(commit):
    try:
        _command("gh", "workflow", "run", "ci.yml", "--ref", "main", "-f", f"target_sha={commit}")
    except OpsError:
        raise OpsError("ci_dispatch_failed") from None


def _event(identity, context, start, end, native, audited, audit_errors, stages, published,
           *, producer_observed_failure=False):
    binding = {**identity, "date": context["scheduled_observation_date"],
               "expectation": "unsupported" if not context["calendar_supported"] else
               "trading" if context["trading_day"] else "non_trading"}
    failed = next((FAILURES[key] for key in STAGES if stages[key] == "failed"), None)
    outcome, reason, data = "failed", failed or "missing_receipt", None
    if binding["expectation"] == "unsupported":
        outcome, reason = "blocked", "calendar_unsupported"
        failed = failed or reason
    elif identity["mode"] == "manual":
        outcome, reason = "skipped", "manual_observation_only"
    elif binding["expectation"] == "non_trading":
        outcome, reason = "skipped", "non_trading_day"
    elif context["prediction_window_status"] in ("too_early", "delayed_cross_day"):
        outcome, reason = "skipped", "scheduled_window_missed"
    elif producer_observed_failure:
        outcome, reason, failed = "failed", "producer_failed", "producer_failed"
    elif native is None or audited is None or native["effective_predictions_for_observation"] != audited:
        outcome, reason, failed = "failed", "missing_receipt", "missing_receipt"
    elif audited == 0:
        outcome, reason = "zero_effective", "zero_effective_prediction"
    elif failed in (None, "ci_dispatch_failed") and published is not None and audit_errors is False:
        outcome, reason, data = "qualified", "financial_qualified", published
    else:
        outcome, reason = "failed", failed or "publication_failed"
        failed = reason
    return {
        **binding, "expected_window": binding["date"] + "T06:35:00Z",
        "window_status": context["prediction_window_status"], "started_at": _clock(start),
        "finished_at": _clock(end), "outcome": outcome, "reason": reason,
        "qualified_data": data, "workflow_status": "failed" if failed else "succeeded",
        "workflow_reason": failed or "workflow_completed",
    }, binding


def _append_ops(raw, event, binding, now, calendar_sha):
    if raw is None:
        raw = journal.encode(journal.new_journal(), observed_at=_clock(now))
    raw = journal.append(raw, event, binding=binding, observed_at=_clock(now))
    today = now.astimezone(producer.CST).date()
    if today < OBSERVATION_START or (today - OBSERVATION_START).days >= journal.MAX_EVENTS:
        raise OpsError("calendar_unsupported")
    dates = []
    for offset in range((today - OBSERVATION_START).days + 1):
        date = OBSERVATION_START + dt.timedelta(days=offset)
        earliest = dt.datetime.combine(date, dt.time(6, 35, tzinfo=UTC)) - dt.timedelta(minutes=5)
        if now >= earliest and date.year in producer.SUPPORTED_CALENDAR_YEARS and producer.is_fund_trading_day(date):
            dates.append(date.isoformat())
    summary = journal.summarize(raw, observed_at=_clock(now), expected_dates=tuple(dates), calendar_sha256=calendar_sha)
    return raw, summary


def _publish_ops(base, context, raw, *, checkpoint="terminal"):
    if re.fullmatch(r"[0-9a-f]{40}", base) is None or type(raw) is not bytes or not 0 < len(raw) <= journal.MAX_BYTES:
        raise OpsError("publication_failed")
    if _head() != base or _remote_head() != base:
        raise OpsError("publication_failed")
    result = artifact_store.publish(context, raw, checkpoint=checkpoint, observed_at=_clock(_now()))
    if _head() != base or _remote_head() != base:
        raise OpsError("publication_failed")
    return result


def run():
    identity = _identity()
    check_only = os.environ.get("OVERSEAS_JOURNAL_CHECK_ONLY", "false")
    if check_only not in ("true", "false") or (check_only == "true" and identity["mode"] != "manual"):
        raise OpsError()
    context_store, history = _read_ops_history(identity)
    # Preserve only the available original state before any producer/provider
    # work. This checkpoint does not claim a terminal event for this run.
    restored = _publish_ops(identity["source_sha"], context_store, history, checkpoint="restored")
    if check_only == "true":
        result = _publish_ops(identity["source_sha"], context_store, history, checkpoint="check_only")
        print(json.dumps({"status": "journal_check_only", **result}, sort_keys=True, allow_nan=False))
        return 0
    calendar_sha = _calendar()
    start = _now()
    context = producer.build_run_context(start, run_mode=identity["mode"], schedule_time="14:35",
                                         early_minutes=5, late_minutes=45)
    stages = dict.fromkeys(STAGES, "skipped")
    native, audited, audit_errors, published = None, None, None, None

    def stage(name, action):
        try:
            # Existing helpers may print model rows or raw exception text. The
            # controlled wrapper exposes only fixed stage names and native counts.
            with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                value = action()
            stages[name] = "succeeded"
            return value
        except Exception:
            stages[name] = "failed"
            return None

    def produce():
        # Keep the existing workflow's configured API requirement, but capture
        # its known failure as a receipt instead of exiting before finalization.
        if not os.environ.get("FUND_API_BASE", "").strip():
            raise OpsError("producer_failed")
        return producer.run_pipeline(now=start, run_mode=identity["mode"])

    result = stage("producer", produce)
    producer_observed_failure = stages["producer"] == "failed"
    if not producer_observed_failure:
        try:
            native = _native_receipt(result, context)
        except OpsError:
            stages["producer"] = "failed"
    if native is not None:
        stage("calibration", calibrator.main)

        def independent_audit():
            ledger = json.loads(producer.LEDGER.read_text(encoding="utf-8"))
            registry = json.loads(producer.REGISTRY.read_text(encoding="utf-8"))
            pipeline = ledger.get("pipeline")
            if type(pipeline) is not dict or any(
                type(pipeline.get(key)) is not type(value) or pipeline[key] != value
                for key, value in context.items() if key != "prediction_allowed"
            ):
                raise OpsError()
            report = auditor.audit(ledger, registry, now=_now())
            report["updated_at"] = _now().astimezone(producer.CST).isoformat(timespec="seconds")
            producer.write_json_atomic(auditor.REPORT, report)
            return _audit_receipt(report, context)

        audit_result = stage("audit", independent_audit)
        if audit_result is not None:
            audited, audit_errors = audit_result
            if audit_errors or audited != native["effective_predictions_for_observation"]:
                stages["audit"] = "failed"
        if stages["calibration"] == stages["audit"] == "succeeded":
            def export():
                ledger = json.loads(producer.LEDGER.read_text(encoding="utf-8"))
                payload = exporter.build_export(ledger)
                producer.write_json_atomic(exporter.DEFAULT_OUTPUT, payload)
            stage("evidence", export)
        if all(stages[key] == "succeeded" for key in STAGES[:4]):
            published = stage("publication", lambda: _publish_financial(identity["source_sha"]))
        if published is not None:
            stage("ci_dispatch", lambda: _dispatch(published["commit_sha"]))
    end = _now()
    event, binding = _event(identity, context, start, end, native, audited, audit_errors, stages, published,
                           producer_observed_failure=producer_observed_failure)
    raw, summary = _append_ops(history, event, binding, end, calendar_sha)
    # Unconfirmed financial publication cannot use a possibly changed local
    # commit as a safe remote base. No force/rebase/reset/retry is performed.
    base = published["commit_sha"] if published else identity["source_sha"]
    print(json.dumps({"run_id": identity["run_id"], "attempt": identity["attempt"],
                      "source_sha": identity["source_sha"], "date": event["date"],
                      "started_at": event["started_at"], "finished_at": event["finished_at"],
                      "window_status": event["window_status"],
                      "stages": stages, "producer_effective_count":
                      native["effective_predictions_for_observation"] if native else None,
                      "audit_effective_count": audited, "outcome": event["outcome"],
                      "reason": event["reason"], "summary": summary}, sort_keys=True, allow_nan=False))
    _publish_ops(base, context_store, raw)
    return 1 if event["workflow_status"] == "failed" else 0


def main():
    try:
        return run()
    except OpsError as error:
        print(json.dumps({"status": "failed", "reason": error.reason}), flush=True)
        return 1
    except journal.JournalError:
        print(json.dumps({"status": "failed", "reason": "missing_receipt"}), flush=True)
        return 1
    except artifact_store.ArtifactError as error:
        print(json.dumps({"status": "failed", "reason": error.reason}), flush=True)
        return 1
    except Exception:
        print(json.dumps({"status": "failed", "reason": "missing_receipt"}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
