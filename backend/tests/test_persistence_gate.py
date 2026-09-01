import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "persistence_gate.py"
SPEC = importlib.util.spec_from_file_location("persistence_gate", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)


def health(mode="persistent_disk", durable=True):
    return {"database": {"engine": "sqlite", "persistence": mode, "durable": durable}}


@pytest.mark.parametrize("version", ["8.0.0", "9.0.0", "10.2.0-rc.1"])
@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"database": None},
        {"database": {}},
        {"database": {"engine": "sqlite", "durable": True}},
        {"database": {"engine": "sqlite", "persistence": "persistent_disk"}},
        {"database": {"engine": "unknown", "persistence": "persistent_disk", "durable": True}},
        health(None),
        health("unspecified"),
        health("unknown"),
        health("ephemeral"),
        health("ephemeral", False),
        health("misconfigured"),
        health(durable=None),
        health(durable=False),
        health(durable="true"),
        health(durable=1),
    ],
)
def test_v8_rejects_missing_unknown_and_non_boolean_storage_contract(version, payload):
    assert module.persistence_is_acceptable(payload, version) is False


@pytest.mark.parametrize("version", ["7.0.1", "8.0.0", "9.0.0"])
def test_all_versions_accept_explicit_persistent_disk_with_true_boolean(version):
    assert module.persistence_is_acceptable(health(), version) is True


def test_v7_keeps_explicit_ephemeral_false_without_requiring_paid_storage():
    assert module.persistence_is_acceptable(health("ephemeral", False), "7.0.1") is True


@pytest.mark.parametrize(
    "payload",
    [health("unspecified"), health("unknown"), health("misconfigured"),
     health("ephemeral"), health("ephemeral", "false"), health("ephemeral", 0),
     health(durable=False), health(durable="true")],
)
def test_v7_does_not_relax_its_explicit_storage_contract(payload):
    assert module.persistence_is_acceptable(payload, "7.0.1") is False


@pytest.mark.parametrize("version", [None, 8, "", "v8.0.0", "unknown", "８.0.0", "-1.0.0"])
def test_invalid_expected_major_fails_closed(version):
    assert module.persistence_is_acceptable(health(), version) is False


@pytest.mark.parametrize(
    "version,payload,expected_exit",
    [
        ("8.0.0", health(), 0),
        ("8.0.0", health("unspecified"), 1),
        ("8.0.0", health("ephemeral", False), 1),
        ("8.0.0", health(durable="true"), 1),
        ("7.0.1", health("ephemeral", False), 0),
    ],
)
def test_workflow_cli_uses_the_behavioral_gate(version, payload, expected_exit):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--expected-version", version],
        input=json.dumps(payload), capture_output=True, text=True, cwd=ROOT, timeout=10,
    )
    assert result.returncode == expected_exit


def test_workflow_cli_rejects_invalid_json_without_echoing_runtime_details():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--expected-version", "8.0.0"],
        input="private-runtime-marker", capture_output=True, text=True, cwd=ROOT, timeout=10,
    )
    assert result.returncode == 1
    assert "private-runtime-marker" not in result.stdout + result.stderr
