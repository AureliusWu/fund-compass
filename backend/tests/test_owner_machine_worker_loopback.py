"""Actual bundled Worker -> real HTTP ASGI -> local SQLite -> single fake send.

Only public-provider responses and external delivery are synthetic. Backend
responses, request bodies, authorization, SQL, financial rules, hashes and
immutable receipts are real. TLS/cloud/actual delivery are NOT exercised.
"""
import json
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time

import pytest
import uvicorn

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
const first = await worker.runScheduled(env, new Date('2026-10-26T06:31:00Z'), '14:30');
const repeated = await worker.runScheduled(env, new Date('2026-10-26T06:31:00Z'), '14:30');
process.stdout.write(JSON.stringify({ first, repeated, sends, publicReads, apiCalls }));
"""


def test_real_bundled_worker_roundtrips_raw_backend_financial_contract_and_deduplicates(f):
    worker_path = Path(__file__).resolve().parents[2] / "worker"
    node = shutil.which("node")
    if node is None or not (worker_path / "node_modules" / "esbuild").is_dir():
        pytest.skip("cross-runtime loopback requires the separately installed Worker Node/esbuild toolchain")
    seed_details(f)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    origin = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = uvicorn.Server(uvicorn.Config(app_with(lambda: connect(f.path)), host="127.0.0.1",
        log_level="critical", access_log=False, lifespan="off", ws="none"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        result = subprocess.run([node, "--input-type=module", "-e", SCRIPT], cwd=worker_path,
            input=json.dumps({"origin": origin, "codes": f.source["codes"], "worker": WORKER, "admin": ADMIN}),
            text=True, capture_output=True, timeout=45, encoding="utf-8")
        assert result.returncode == 0, result.stderr[-2000:]
        output = json.loads(result.stdout)
        assert output["first"]["status"] == "sent", output
        assert output["repeated"]["status"] == "skipped", output
        assert output["sends"] == 1 and output["publicReads"] == 2
        assert output["first"]["original"]["attempt_hash"]
        assert output["first"]["original"]["evidence_request_hash"]
        assert counts(f)["owner_analysis_runs"] == 1
        with connect(f.path) as conn:
            assert dict(conn.execute("SELECT status,COUNT(*) FROM notification_events GROUP BY status")) == {
                "scheduled": 3, "attempted": 3, "sent": 3}
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        sock.close()
    assert not thread.is_alive()
