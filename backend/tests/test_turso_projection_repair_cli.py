"""Local CLI routing/privacy checks; no private snapshots or network access."""
import importlib.util
from io import StringIO
import json
from pathlib import Path
import sys
from types import ModuleType

import pytest


@pytest.fixture
def cli():
    path = Path(__file__).resolve().parents[2] / "tools/turso_projection_repair.py"
    spec = importlib.util.spec_from_file_location("local_projection_repair_cli", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def engine(monkeypatch):
    module = ModuleType("database.turso_projection_repair")

    class Error(Exception):
        pass

    module.ProjectionRepairError = Error
    module.ERROR_CODES = frozenset({"source_drift_detected"})
    calls = []

    def plan(source, **kwargs):
        calls.append(("plan", source, kwargs))
        return {"ok": True, "command": "plan", "remote_applied": False}

    def rehearse(source, **kwargs):
        calls.append(("rehearse", source, kwargs))
        return {"ok": True, "command": "rehearse", "remote_applied": False}

    module.plan_projection_repair = plan
    module.rehearse_projection_repair = rehearse
    monkeypatch.setitem(sys.modules, "database.turso_projection_repair", module)
    return module, calls


def arguments(command="plan"):
    result = [command, "--source", "private-source-marker.db",
              "--source-kind", "remote-schema-table",
              "--expected-source-sha256", "a" * 64]
    if command == "rehearse":
        result += ["--expected-repair-sha256", "b" * 64]
    return result


@pytest.mark.parametrize("command", ["plan", "rehearse"])
def test_routes_only_explicit_local_arguments(cli, engine, command):
    module, calls = engine
    out, err = StringIO(), StringIO()
    assert cli.main(arguments(command), stdout=out, stderr=err) == 0
    expected = {"source_kind": "remote-schema-table", "operational_profile": "core-only",
                "expected_source_sha256": "a" * 64}
    if command == "rehearse":
        expected["expected_repair_sha256"] = "b" * 64
    assert calls == [(command, "private-source-marker.db", expected)]
    assert not err.getvalue()
    assert json.loads(out.getvalue()) == {"ok": True, "command": command, "remote_applied": False}
    assert "private-source" not in out.getvalue()


@pytest.mark.parametrize("invalid", [
    [], ["apply"], ["repair"], ["remote-apply"],
    ["plan", "--url", "private-url-marker"],
    arguments("rehearse")[:-2],
    arguments() + ["--expected-repair-sha256", "private-extra-marker"],
    arguments() + ["--token", "private-token-marker"],
])
def test_invalid_arguments_never_echo_input_or_call_engine(cli, engine, invalid):
    _, calls = engine
    out, err = StringIO(), StringIO()
    assert cli.main(invalid, stdout=out, stderr=err) == 2
    assert not calls and not out.getvalue()
    result = json.loads(err.getvalue())
    assert result["error"] == "invalid_arguments"
    assert result["evidence_scope"] == cli.EVIDENCE_SCOPE
    assert all(value is False for key, value in result.items()
               if key.endswith("verified") or key == "remote_applied")
    assert "private-" not in err.getvalue()


@pytest.mark.parametrize("failure", ["known", "unknown_code", "unexpected"])
def test_exception_text_is_sanitized_and_never_claims_remote_evidence(cli, engine, failure):
    module, calls = engine

    def fail(*args, **kwargs):
        if failure == "known":
            raise module.ProjectionRepairError("source_drift_detected")
        if failure == "unknown_code":
            raise module.ProjectionRepairError("private-row-marker")
        raise RuntimeError("private-path-marker")

    module.plan_projection_repair = fail
    out, err = StringIO(), StringIO()
    assert cli.main(arguments(), stdout=out, stderr=err) == 1
    assert not out.getvalue()
    result = json.loads(err.getvalue())
    assert result["error"] == ("source_drift_detected" if failure == "known"
                                else "projection_repair_failed")
    assert not result["remote_applied"] and not result["remote_verified"]
    assert not result["remote_restore_verified"] and not result["formal_release_verified"]
    assert not result["local_original_recovery_verified"]
    assert "private-" not in err.getvalue()
