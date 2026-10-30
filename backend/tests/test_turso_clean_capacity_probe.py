"""Owned HTTP/SQLite carrier probe only, never real target/provider capacity."""
from dataclasses import replace
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import time

import pytest

from database import turso_scope_packet as kernel
from test_owner_sync_turso import TOKEN
from test_turso_clean_target_transport import ORIGIN, owned_hrana

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "turso_clean_capacity_probe.py"
SPEC = importlib.util.spec_from_file_location("turso_clean_capacity_probe", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
import sys
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


def options(**changes):
    values = dict(target_origin=ORIGIN, token=TOKEN,
        expected_target_resource_sha256=hashlib.sha256(ORIGIN.encode("ascii")).hexdigest(),
        request_bytes=128 * 1024, batch_steps=20)
    values.update(changes)
    return values


def probe(**changes):
    return module.probe_clean_capacity_once(**options(**changes))


def test_actual_owned_http_covers_bytes_steps_same_fixed_capability_and_utf8_but_no_writes(tmp_path, monkeypatch):
    path = tmp_path / "our-empty-capacity.sqlite3"
    with owned_hrana(path, monkeypatch) as (observed, state):
        result = probe()
        meta = result.safe_metadata
        assert meta["capacity_observed"] and meta["session_closed_verified"]
        assert meta["observed_request_bytes"] >= 128 * 1024
        assert meta["observed_request_bytes"] <= 128 * 1024 + 1024
        assert meta["observed_batch_steps_including_controls"] == 20
        assert len(observed.posts) == observed.read_posts == 1 and observed.write_posts == 0 and not state.streams
        frame = observed.posts[0]
        steps = frame["requests"][0]["batch"]["steps"]
        assert len(steps) == 20 and steps[0]["stmt"]["sql"] == "BEGIN DEFERRED"
        assert steps[-2]["stmt"]["sql"] == "COMMIT" and steps[-1]["stmt"]["sql"] == "ROLLBACK"
        fixed = module.clean.compiler.compact_capability_probe()
        assert steps[1]["stmt"] == fixed._wire()
        assert meta["plain_probe_sha256"] == hashlib.sha256(kernel._json(fixed._wire())).hexdigest()
        for step in steps[2:-2]:
            assert step["stmt"]["sql"].startswith("SELECT CASE WHEN")
            assert all(argument["type"] == "text" and set(argument["value"]) == {"0"}
                       and len(argument["value"].encode("utf8")) <= kernel.MAX_CELL_BYTES for argument in step["stmt"]["args"])
        assert all(meta[key] is False for key in module._FLAGS)
        assert repr(result).startswith("<")  # repr=False never contains raw request/response.
        with sqlite3.connect(path) as conn:
            assert conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone() == (0,)


def test_large_padding_never_exceeds_256k_per_text_and_16m_total():
    plan = module._plan(2 * 1024 * 1024, 6, module.clean._Budget(30))
    assert 2 * 1024 * 1024 <= len(plan.body) <= module.MAX_REQUEST_BYTES
    assert len(plan.statement_specs) == 6
    assert max(len(value.encode("utf8")) for spec in plan.statement_specs[2:-2] for value in spec[2]) <= kernel.MAX_CELL_BYTES
    assert any(len(spec[2]) > 1 for spec in plan.statement_specs[2:-2])
    tree = json.loads(plan.body)
    assert plan.body == json.dumps(tree, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf8")
    assert any(byte >= 128 for byte in plan.body)  # Genuine UTF-8 constant probe wire.


def test_offline_fourteen_mib_carrier_has_exact_full_step_count_without_network(monkeypatch):
    monkeypatch.setattr(module.physical.requests, "Session", lambda: pytest.fail("offline sizing opened network"))
    started = time.monotonic()
    plan = module._plan(14 * 1024 * 1024, 1000, module.clean._Budget(30))
    assert 14 * 1024 * 1024 <= len(plan.body) <= module.MAX_REQUEST_BYTES
    assert len(plan.statement_specs) == 1000 and time.monotonic() - started < 30
    assert all(len(spec[2]) <= kernel.MAX_ARGS for spec in plan.statement_specs)
    assert all(len(value.encode("utf8")) <= kernel.MAX_CELL_BYTES
               for spec in plan.statement_specs[2:-2] for value in spec[2])


def test_minimum_controls_plus_fixed_probe_has_no_padding_slot_and_fails_closed_if_too_small():
    original = module.clean._read_pipeline((module.clean.compiler.compact_capability_probe(),))
    minimum = len(json.dumps(json.loads(original.body), ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf8"))
    plan = module._plan(minimum, 4, module.clean._Budget(30))
    assert len(plan.statement_specs) == 4
    with pytest.raises(module.CapacityProbeError):
        module._plan(len(plan.body) + 1, 4, module.clean._Budget(30))
    with pytest.raises(module.CapacityProbeError):
        module._plan(minimum - 1025, 4, module.clean._Budget(30))


@pytest.mark.parametrize("changes", [
    {"request_bytes": 0}, {"request_bytes": True}, {"request_bytes": 16 * 1024 * 1024 + 1},
    {"request_bytes": "1024"}, {"batch_steps": 3}, {"batch_steps": False},
    {"batch_steps": kernel.MAX_STEPS + 1}, {"batch_steps": 20.0}, {"timeout_seconds": 31},
    {"timeout_seconds": float("nan")}, {"expected_target_resource_sha256": "f" * 64},
    {"expected_target_resource_sha256": None},
])
def test_invalid_dimensions_identity_or_budget_has_zero_session_or_request(monkeypatch, changes):
    monkeypatch.setattr(module.physical.requests, "Session", lambda: pytest.fail("invalid probe opened network"))
    with pytest.raises(module.CapacityProbeError): probe(**changes)


@pytest.mark.parametrize("status", [401, 403, 413, 429])
def test_http_stop_has_one_read_post_and_no_retry_or_identity_change(tmp_path, monkeypatch, status):
    with owned_hrana(tmp_path / "http-stop.sqlite3", monkeypatch) as (observed, _state):
        observed.status = status
        with pytest.raises(module.CapacityProbeError) as error: probe()
        assert error.value.http_status == status and error.value.outcome == "unknown"
        assert len(observed.posts) == observed.read_posts == 1 and observed.write_posts == 0


@pytest.mark.parametrize("kind", ["guard-zero", "affected-one", "affected-bool", "not-autocommit", "no-close", "foreign-url"])
def test_inconsistent_guard_control_envelope_cannot_be_capacity_pass(tmp_path, monkeypatch, kind):
    def corrupt(response, _frame):
        if kind == "guard-zero": response["results"][0]["response"]["result"]["step_results"][2]["rows"] = [[{"type": "integer", "value": "0"}]]
        elif kind == "affected-one": response["results"][0]["response"]["result"]["step_results"][2]["affected_row_count"] = 1
        elif kind == "affected-bool": response["results"][0]["response"]["result"]["step_results"][2]["affected_row_count"] = True
        elif kind == "not-autocommit": response["results"][1]["response"]["is_autocommit"] = False
        elif kind == "no-close": response["results"].pop()
        else: response["base_url"] = "https://not-the-same-target.turso.io/v3"
    with owned_hrana(tmp_path / (kind + ".sqlite3"), monkeypatch) as (observed, _state):
        observed.corrupt = corrupt
        with pytest.raises(module.CapacityProbeError): probe()
        assert observed.read_posts == len(observed.posts) == 1 and observed.write_posts == 0


def test_cleanup_failure_after_read_receipt_rejects_capacity_pass(tmp_path, monkeypatch):
    with owned_hrana(tmp_path / "cleanup.sqlite3", monkeypatch) as (observed, _state):
        observed.fail_cleanup = True
        with pytest.raises(module.CapacityProbeError): probe()
        assert len(observed.posts) == 1 and observed.write_posts == 0


def test_sealed_metadata_and_raw_response_cannot_be_replaced_to_grant_write_or_other_capacity(tmp_path, monkeypatch):
    with owned_hrana(tmp_path / "sealed.sqlite3", monkeypatch):
        result = probe()
        original = result.safe_metadata
        changed = {**original, "write_capacity_verified": True}
        for forged in (replace(result, _safe_items=tuple(sorted(changed.items()))),
                       replace(result, _dimensions=(original["observed_request_bytes"] + 1, 20)),
                       replace(result, _raw=b"{}"), replace(result, _seal=object())):
            with pytest.raises(module.CapacityProbeError): _ = forged.safe_metadata
        # Guard rows are all 1, so the same raw response must not be rebound to
        # a different reconstructed padded request even if facts are changed.
        dimensions = (original["observed_request_bytes"] + 100, 20)
        plan = module._plan(*dimensions, module.clean._Budget(30))
        rebound = module._interpret(result._raw, plan, ORIGIN, original["target_resource_sha256"],
                                    dimensions, module.clean._Budget(30))
        with pytest.raises(module.CapacityProbeError):
            _ = replace(result, _dimensions=dimensions, _safe_items=tuple(sorted(rebound.items()))).safe_metadata
        assert result.safe_metadata == original


def test_code_drift_and_expired_budget_are_rejected_before_session(monkeypatch):
    monkeypatch.setattr(module.physical.requests, "Session", lambda: pytest.fail("stopped probe opened network"))
    monkeypatch.setattr(module, "_code", lambda: ("changed",))
    with pytest.raises(module.CapacityProbeError) as error: probe()
    assert error.value.reason == "code_drift"


def test_shared_deadline_expiry_during_build_has_zero_network(monkeypatch):
    monkeypatch.setattr(module.physical.requests, "Session", lambda: pytest.fail("expired probe opened network"))
    original_check, calls = module.clean._Budget.check, []
    def expire(budget):
        calls.append(None)
        if len(calls) > 5:
            raise module.clean.compiler.CleanTargetError("operation_timeout")
        return original_check(budget)
    monkeypatch.setattr(module.clean._Budget, "check", expire)
    with pytest.raises(module.CapacityProbeError) as error: probe()
    assert error.value.reason == "operation_timeout"


def test_body_capture_permission_code_is_stop_even_with_200_envelope(tmp_path, monkeypatch):
    def permission(response, _frame):
        batch = response["results"][0]["response"]["result"]
        batch["step_errors"][1] = {"code": "SQLITE_AUTH", "message": "synthetic private permission body"}
    with owned_hrana(tmp_path / "permission.sqlite3", monkeypatch) as (observed, _state):
        observed.corrupt = permission
        with pytest.raises(module.CapacityProbeError) as error: probe()
        assert error.value.reason == "permission_stop"
        assert observed.read_posts == len(observed.posts) == 1 and observed.write_posts == 0


def test_unknown_secret_callback_exception_never_formats_or_leaks(monkeypatch, capsys):
    class Hostile(Exception):
        def __str__(self): raise AssertionError("unknown callback string accessed")
        def __repr__(self): raise AssertionError("unknown callback repr accessed")
    def changed(): raise Hostile("synthetic private callback token not output")
    monkeypatch.setattr(module.physical.requests, "Session", lambda: pytest.fail("revoked probe opened network"))
    with pytest.raises(module.CapacityProbeError) as error: probe(check=changed)
    assert error.value.args == ("transport_failed",)
    output = capsys.readouterr()
    assert output.out == output.err == ""
