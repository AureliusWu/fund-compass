"""The dedicated dual-runtime check cannot silently qualify skipped tests."""
from pathlib import Path

import yaml


def test_worker_ci_requires_real_cross_runtime_checks_without_relaxing_deployment_hold():
    root = Path(__file__).resolve().parents[2]
    jobs = yaml.safe_load((root / ".github/workflows/ci.yml").read_text(encoding="utf-8"))["jobs"]
    worker = jobs["worker"]
    assert worker["permissions"] == {"contents": "read"}
    assert "if" not in worker and "continue-on-error" not in worker
    steps = worker["steps"]
    index = next(index for index, step in enumerate(steps)
                 if step.get("name") == "Verify real machine cross-runtime contract")
    gate = steps[index]
    install = steps[index - 1]
    setup = steps[index - 2]
    assert "actions/setup-python@v7" == setup["uses"] and setup["with"]["python-version"] == "3.12"
    for step in (setup, install, gate):
        assert "if" not in step and "continue-on-error" not in step
    assert gate["timeout-minutes"] == 2
    assert "python -m pip check" in install["run"]
    assert "await import('esbuild')" in gate["run"]
    assert "test_owner_machine_worker_contract.py" in gate["run"]
    assert "test_owner_machine_worker_loopback.py" in gate["run"]
    assert "assert not r.findall('.//skipped')" in gate["run"]
    assert "assert len(r.findall('.//testcase')) >= 5" in gate["run"]
    assert "vars.AUTO_DEPLOY_ENABLED == 'true'" in jobs["deploy"]["if"]
    assert "vars.AUTO_DEPLOY_ENABLED == 'true'" in jobs["candidate_smoke"]["if"]
    assert jobs["deploy"]["needs"] == ["resolve", "backend", "frontend", "worker"]
