"""Actual bundled Worker -> real HTTP ASGI -> local SQLite -> single fake send.

Only public-provider responses and external delivery are synthetic. Backend
responses, request bodies, authorization, SQL, financial rules, hashes and
immutable receipts are real. TLS/cloud/actual delivery are NOT exercised.
"""
import json
from datetime import datetime, timezone
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time

import pytest
import uvicorn
from fastapi.responses import Response

from service import owner_machine_cache as cache
from test_owner_machine_evidence import seed_details
from test_owner_machine_http import ADMIN, WORKER, app_with, isolated_auth, password_hash
from test_owner_machine_repo import counts, f
from test_owner_analysis_repo import connect


SCRIPT = r"""
import { build } from 'esbuild';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input);
const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false,
  format: 'esm', platform: 'browser', logLevel: 'silent',
  define: { WORKER_BUILD_SHA: JSON.stringify('d'.repeat(40)) } });
const realFetch = globalThis.fetch;
let sends = 0, publicReads = 0, apiCalls = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin === 'https://machine-loopback.invalid') {
    apiCalls.push(url.pathname);
    return realFetch(fixture.origin + url.pathname + url.search, init);
  }
  if (url.origin === 'https://api.fund.eastmoney.com' && url.pathname === '/FundGuZhi/GetFundGZList') {
    publicReads++;
    return Response.json({ ErrCode: 0, Data: { list: fixture.codes.map(code => ({
      bzdm: code, jjjc: 'synthetic index', type: 'index', dwjz: '1.25', gsz: '1.25', gszzl: '0',
      gzrq: '2026-10-23', gxrq: '2026-10-26 14:30:00' })) } });
  }
  if (url.origin === 'https://sctapi.ftqq.com') {
    sends++;
    return Response.json({ code: 0 });
  }
  throw new Error('unexpected external surface');
};
const worker = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const env = { OWNER_MACHINE_MODE: 'candidate', FUND_API_BASE: 'https://machine-loopback.invalid',
  WORKER_TOKEN: fixture.worker, ADMIN_TOKEN: fixture.admin, WECHAT_SENDKEY: 'synthetic-delivery-only',
  GIST_ID: '', GIST_TOKEN: '' };
let cachePrepared = null;
if (fixture.prepare_cache) {
  const source = await (await fetch('https://machine-loopback.invalid/api/v2/worker/portfolio/source', {
    headers: { Authorization: 'Bearer ' + fixture.worker } })).json();
  const response = await fetch('https://machine-loopback.invalid/api/v2/worker/portfolio/cache/prepare', {
    method: 'POST', headers: { Authorization: 'Bearer ' + fixture.worker, 'Content-Type': 'application/json' },
    body: JSON.stringify({ occurrence_date: '2026-10-26', request_id: 'explicit-loopback-cache-0001',
      worker_build_sha: 'd'.repeat(40), expected_revision: source.revision, source_hash: source.source_hash,
      policy_version: source.policy_version, request_budget: 100 }) });
  cachePrepared = await response.json();
  if (!response.ok) throw new Error('explicit cache preparation did not succeed');
}
const first = await worker.runScheduled(env, new Date('2026-10-26T06:31:00Z'), '14:30');
const repeated = await worker.runScheduled(env, new Date('2026-10-26T06:31:00Z'), '14:30');
process.stdout.write(JSON.stringify({ first, repeated, sends, publicReads, apiCalls, cachePrepared }));
"""


@pytest.mark.parametrize("cache_preparation", [False, True], ids=["warm-cache", "cold-explicit-preparation"])
def test_real_bundled_worker_roundtrips_raw_backend_financial_contract_and_deduplicates(f, monkeypatch, cache_preparation):
    worker_path = Path(__file__).resolve().parents[2] / "worker"
    node = shutil.which("node")
    if node is None or not (worker_path / "node_modules" / "esbuild").is_dir():
        pytest.skip("cross-runtime loopback requires the separately installed Worker Node/esbuild toolchain")
    if not cache_preparation:
        seed_details(f)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    origin = "http://127.0.0.1:" + str(sock.getsockname()[1])
    app = app_with(lambda: connect(f.path))
    cache_reads = []
    if cache_preparation:
        @app.get("/synthetic-public/{code}.js")
        def public_detail(code: str):
            cache_reads.append(code)
            milliseconds = int(datetime(2026, 10, 23, tzinfo=timezone.utc).timestamp() * 1000)
            raw = f'var fS_code={json.dumps(code)};var fS_name="合成指数";var Data_netWorthTrend=' + json.dumps([
                {"x": milliseconds, "y": 1.25, "equityReturn": None}]) + ";"
            return Response(raw, media_type="application/javascript")

        real_session = cache.requests.Session
        class OwnedPublicSession(real_session):
            def get(self, url, **kwargs):
                assert url.startswith("https://fund.eastmoney.com/pingzhongdata/")
                code_file = url.rsplit("/", 1)[-1]
                response = super().get(origin + "/synthetic-public/" + code_file, **kwargs)
                # Owned transport mapping only; no TLS/provider claim is made.
                response.url = url
                return response
        monkeypatch.setattr(cache.requests, "Session", OwnedPublicSession)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1",
        log_level="critical", access_log=False, lifespan="off", ws="none"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        result = subprocess.run([node, "--input-type=module", "-e", SCRIPT], cwd=worker_path,
            input=json.dumps({"origin": origin, "codes": f.source["codes"], "worker": WORKER, "admin": ADMIN,
                              "prepare_cache": cache_preparation}),
            text=True, capture_output=True, timeout=45, encoding="utf-8")
        assert result.returncode == 0, result.stderr[-2000:]
        output = json.loads(result.stdout)
        assert output["first"]["status"] == "sent", output
        assert output["repeated"]["status"] == "skipped", output
        assert output["sends"] == 1 and output["publicReads"] == 2
        assert output["first"]["original"]["attempt_hash"]
        assert output["first"]["original"]["evidence_request_hash"]
        if cache_preparation:
            assert output["cachePrepared"]["fetched_count"] == 3
            assert sorted(cache_reads) == f.source["codes"]
        else:
            assert output["cachePrepared"] is None and cache_reads == []
        assert counts(f)["owner_analysis_runs"] == 1
        with connect(f.path) as conn:
            assert dict(conn.execute("SELECT status,COUNT(*) FROM notification_events GROUP BY status")) == {
                "scheduled": 3, "attempted": 3, "sent": 3}
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        sock.close()
    assert not thread.is_alive()
