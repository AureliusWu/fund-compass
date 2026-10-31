"""Real Worker serializer -> strict Python machine packet, with no network.

esbuild bundles index.ts and its existing Estimate fixtures in memory only.
Backend-only CI may omit Node/worker dependencies and then explicitly skips;
an installed but broken bundler or incompatible real serializer must fail.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from models.owner_machine import MAX_EVIDENCE_BODY_BYTES, MachineEvidence, parse_machine_input


_WORKER = Path(__file__).resolve().parents[2] / "worker"
_SCENARIOS = ("unavailable", "official_unknown", "fresh_zero", "qdii_zero")
_NODE_PROGRAM = r"""
import { build } from 'esbuild';
globalThis.fetch = () => { throw new Error('cross-language contract must stay offline'); };
const source = `
import { machineEstimateContext } from './src/index.ts';
import { estimateFixture } from './src/estimate-fixtures.test-support.ts';
import type { Estimate } from './src/valuation.ts';
const intraday = estimateFixture('intraday_estimate_canonical').estimate;
if (intraday.baseNav == null) throw new Error('real intraday fixture needs a base NAV');
const freshZero: Estimate = {
  ...intraday, change: 0, valueNav: intraday.baseNav, estNav: intraday.baseNav,
};
const qdii: Estimate = {
  ...estimateFixture('qdii_next_nav_estimate_canonical').estimate,
  uncertainty: { mae: 0, error_p80: 0, direction_accuracy: 0 },
};
const scenarios: [string, Estimate | undefined][] = [
  ['unavailable', undefined],
  ['official_unknown', estimateFixture('official_nav_change_unknown').estimate],
  ['fresh_zero', freshZero],
  ['qdii_zero', qdii],
];
export const packets = scenarios.map(([scenario, estimate], index) => ({
  scenario,
  raw: JSON.stringify({
    occurrence_date: '2026-10-26', request_id: 'worker-context-contract-000' + index,
    trigger: 'manual', slot: '14:30', worker_build_sha: '0123456789abcdef0123456789abcdef01234567',
    expected_revision: 0, source_hash: '0'.repeat(64), policy_version: 'pol_' + '1'.repeat(64),
    observations: [{ code: '000001', estimate_context: machineEstimateContext(estimate) }],
  }),
}));
`;
const result = await build({
  stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'owner-machine-worker-contract.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
});
if (result.outputFiles.length !== 1) throw new Error('expected one in-memory Worker bundle');
const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
process.stdout.write(JSON.stringify(module.packets));
"""


@pytest.fixture(scope="module")
def worker_packets():
    node = shutil.which("node")
    if node is None:
        pytest.skip("real Worker contract needs an installed Node runtime; no serializer substitute used")
    if not (_WORKER / "node_modules" / "esbuild" / "lib" / "main.js").is_file():
        pytest.skip("real Worker contract needs existing worker/node_modules/esbuild; no dependencies installed")
    result = subprocess.run(
        [node, "--input-type=module", "--eval", _NODE_PROGRAM], cwd=_WORKER,
        capture_output=True, text=True, encoding="utf-8", timeout=30, check=False,
    )
    assert result.returncode == 0, "real Worker serializer failed: " + result.stderr[-4000:]
    assert len(result.stdout.encode("utf-8")) <= 64 * 1024
    packets = json.loads(result.stdout)
    assert len(packets) == len(_SCENARIOS)
    assert {row["scenario"] for row in packets} == set(_SCENARIOS)
    return {row["scenario"]: row["raw"].encode("utf-8") for row in packets}


@pytest.mark.parametrize("scenario", _SCENARIOS)
def test_actual_worker_context_is_accepted_by_strict_python_machine_packet(worker_packets, scenario):
    raw = worker_packets[scenario]
    parsed = parse_machine_input(raw, MachineEvidence, max_body_bytes=MAX_EVIDENCE_BODY_BYTES)
    assert parsed.request_hash() == hashlib.sha256(raw).hexdigest()
    assert len(parsed.observations) == 1 and parsed.observations[0].code == "000001"
    context = parsed.observations[0].estimate_context
    wire = json.loads(raw)["observations"][0]["estimate_context"]
    assert "uncertainty" not in wire  # Real machine serializer flattens this legacy field.
    if scenario == "unavailable":
        assert context.kind == "unavailable" and context.status == "unavailable"
        assert context.estimate_change is None and context.estimate_nav is None and context.value_nav is None
    elif scenario == "official_unknown":
        assert context.kind == "official_nav" and context.status == "latest_official"
        assert context.estimate_change is None and context.estimate_nav is None and context.value_change is None
        assert context.value_nav is not None and context.value_nav > 0
    elif scenario == "fresh_zero":
        assert context.kind == "intraday_estimate" and context.status == "fresh"
        assert context.estimate_change == 0 and context.estimate_change is not None
        assert context.estimate_nav == context.value_nav == context.base_nav
        assert context.target_nav_date is None
    else:
        assert context.kind == "qdii_next_nav_estimate" and context.status in {"modeled", "degraded", "stale"}
        assert context.target_nav_date is not None and context.estimate_model_version is not None
        assert context.mae == context.error_p80 == context.direction_accuracy == 0
        assert all(wire[key] == 0 for key in ("mae", "error_p80", "direction_accuracy"))
