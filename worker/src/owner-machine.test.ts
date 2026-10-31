import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { machineEstimateContext, run, runScheduled, type Env } from './index'
import { parseMachineJson } from './owner-machine'
import * as valuation from './valuation'
import { estimateFixture } from './estimate-fixtures.test-support'

const DAY = '2026-10-26'
const NOW = new Date(DAY + 'T06:31:00Z')
const BUILD = 'd'.repeat(40)
const POLICY = 'pol_' + 'a'.repeat(64)
const SOURCE = 'b'.repeat(64)
const env: Env = { OWNER_MACHINE_MODE: 'candidate', FUND_API_BASE: 'https://api.test',
  WORKER_TOKEN: 'worker-private', ADMIN_TOKEN: 'admin-private', WECHAT_SENDKEY: 'send-private',
  GIST_ID: '', GIST_TOKEN: '' }
const hex = (index: number) => index.toString(16).padStart(64, '0')
type Row = Record<string, any>
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
  return JSON.stringify(value)
}
async function sha(raw: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
function json(value: unknown) { return new Response(canonical(value), { headers: { 'Content-Type': 'application/json' } }) }

function network(options: { codes?: string[]; unknown?: string; duplicate?: boolean; provider?: 'sent' | 'timeout' | 'http' | 'invalid' | 'rejected' | 'contradictory' | 'oversize'; pythonReal?: boolean; sourceChanged?: boolean; afterClaim?: () => void; attemptOverrides?: Row; rawClaim?: (raw: string) => string } = {}) {
  const codes = options.codes || ['000001', '000009']
  const calls: Array<{ path: string; method: string; body?: Row; raw?: string; init: RequestInit }> = []
  let sourceReads = 0
  let task: Row
  let taskHash = ''
  let image: Row
  let attempt: Row
  let attemptHash = ''
  const wire = (value: unknown) => options.pythonReal ? canonical(value).replaceAll('"estimate":0', '"estimate":0.0') : canonical(value)
  const output = (value: unknown) => new Response(wire(value), { headers: { 'Content-Type': 'application/json' } })
  const source = { schema: 'owner-machine-source-1', revision: 4, source_hash: SOURCE,
    record_count: codes.length + 2, scope: 'fund_only', codes, policy_version: POLICY }
  vi.spyOn(valuation, 'resolveValuations').mockImplementation(async (requested) => {
    expect(requested).toEqual(codes)
    return { estimates: new Map(), unavailable: new Map(), primaryReason: 'test_unavailable' }
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input)), path = url.pathname
    const raw = typeof init.body === 'string' ? init.body : undefined
    const body = raw ? JSON.parse(raw) as Row : undefined
    calls.push({ path, method: init.method || 'GET', body, raw, init })
    if (url.hostname === 'sctapi.ftqq.com') {
      if (options.provider === 'timeout') throw new DOMException('private provider secret', 'TimeoutError')
      if (options.provider === 'http') return new Response('private provider secret', { status: 429 })
      if (options.provider === 'invalid') return new Response('{"code":0,"code":401}')
      if (options.provider === 'contradictory') return json({ code: 0, errno: 401 })
      if (options.provider === 'oversize') return new Response('x'.repeat(16_385))
      return json({ code: options.provider === 'rejected' ? 401 : 0 })
    }
    expect(url.origin).toBe('https://api.test')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer worker-private' })
    expect(init.redirect).toBe('error')
    if (options.unknown && path.endsWith('/' + options.unknown)) throw new DOMException('private backend detail', 'TimeoutError')
    if (path.endsWith('/source')) return output({ ...source, revision: options.sourceChanged && ++sourceReads > 1 ? 5 : 4 })
    if (path.endsWith('/evidence')) {
      expect(body!.observations.map((item: Row) => item.code)).toEqual(codes)
      expect(body).not.toHaveProperty('holdings')
      expect(body!.observations.every((item: Row) => item.estimate_context.kind === 'unavailable')).toBe(true)
      expect(body!.observations.every((item: Row) => !('uncertainty' in item.estimate_context))).toBe(true)
      return output({ schema: 'owner-machine-evidence-1', revision: 4, source_hash: SOURCE, policy_version: POLICY,
        evidence: codes.map((code, i) => ({ code, evidence_id: 'ev_' + hex(i + 1) })) })
    }
    if (path.endsWith('/prepare')) {
      const components = codes.map((code, i) => ({ code, account_count: i === 0 ? 2 : 0,
        holding: { schema_version: 'v8-holding-1', holding_version: 'hold_' + hex(i + 1), fund_code: code, user_state: i === 0 ? 'held' : 'unheld', shares: i === 0 ? 0 : null },
        evidence: { schema_version: 'v8-evidence-1', evidence_id: 'ev_' + hex(i + 1), fund_code: code,
          estimate: i === 0 ? 0 : null, estimate_status: i === 0 ? 'fresh' : 'unavailable',
          created_at: DAY + 'T06:30:00+00:00', market_time: i === 0 ? DAY + 'T06:29:00+00:00' : null,
          target_nav_date: null, stale_fields: [] },
        decision: { schema_version: 'v8-decision-1', decision_id: 'dec_' + hex(i + 1), evidence_id: 'ev_' + hex(i + 1), fund_code: code,
          holding_version: 'hold_' + hex(i + 1), policy_version: POLICY, strategy_version: 'candidate-test', user_state: i === 0 ? 'held' : 'unheld', action: i === 0 ? 'hold' : 'watch', confidence: 20, strength: 20 },
      }))
      image = { schema: 'owner-analysis-run-1', request_id: 'machine-portfolio-' + DAY,
        request_hash: 'e'.repeat(64), run_id: 'owner_analysis_' + 'f'.repeat(64),
        source: { revision: 4, sha256: SOURCE, record_count: codes.length + 2, scope: 'fund_only' },
        policy: { schema_version: 'v8-policy-1', policy_version: POLICY, effective_at: DAY + 'T00:00:00+00:00' },
        strategy_version: 'candidate-test', created_at: DAY + 'T06:30:00+00:00', pricing_complete: false,
        unavailable_codes: codes.slice(1), components }
      task = { schema: 'owner-machine-task-1', occurrence_id: DAY, analysis_request_id: image.request_id,
        analysis_request_hash: image.request_hash, run_id: image.run_id, run_response_hash: await sha(wire(image)),
        source_revision: 4, source_hash: SOURCE, policy_version: POLICY, strategy_version: image.strategy_version,
        created_at: image.created_at, worker_build_sha: BUILD, decision_ids: components.map((item) => item.decision.decision_id) }
      taskHash = await sha(wire(task))
      return output({ task, task_hash: taskHash, run: image, source_current: true, duplicate: false })
    }
    if (path.endsWith('/claim')) {
      if (options.duplicate) return json({ claimed: false, duplicate: true, attempt: null, attempt_hash: 'c'.repeat(64), result: null })
      attempt = { schema: 'owner-machine-attempt-1', occurrence_id: DAY, analysis_request_id: task.analysis_request_id,
        task_hash: taskHash, slot: body!.slot, attempt_no: 1, natural_schedule: body!.trigger === 'scheduled',
        scheduled_window: `${DAY}T${body!.slot}+08:00`, scheduled_at: `${DAY}T${body!.slot}:00+08:00`,
        created_at: DAY + 'T06:31:00+00:00', request_id: body!.request_id, worker_build_sha: BUILD,
        trigger: body!.trigger, decision_ids: task.decision_ids, execution_status: 'running', artifact_status: 'partial',
        valid_count: 1, expected_count: codes.length, ...options.attemptOverrides }
      attemptHash = await sha(wire(attempt))
      const value = { claimed: true, duplicate: false, attempt, attempt_hash: attemptHash, run: image }
      options.afterClaim?.()
      return new Response(options.rawClaim?.(wire(value)) || wire(value), { headers: { 'Content-Type': 'application/json' } })
    }
    if (path.endsWith('/finish')) {
      expect(body!.attempt_hash).toBe(attemptHash)
      const result = { schema: 'owner-machine-result-1', occurrence_id: DAY, analysis_request_id: task.analysis_request_id,
        attempt_hash: attemptHash, outcome: body!.outcome, artifact_digest: task.run_response_hash }
      return output({ result, result_hash: await sha(wire(result)), duplicate: false })
    }
    if (path.endsWith('/tasks/' + DAY)) return json({ schema: 'owner-machine-status-1', task: null, attempts: [], observations: [] })
    throw new Error('unexpected private route ' + path)
  }))
  return { calls, providerCalls: () => calls.filter((call) => call.path.includes('.send')),
    posts: () => calls.filter((call) => call.method === 'POST') }
}

beforeEach(() => { vi.stubGlobal('WORKER_BUILD_SHA', BUILD) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('strict candidate JSON', () => {
  it('rejects duplicate keys, nonfinite numbers, trailing data and excessive depth', () => {
    for (const raw of ['{"x":1,"x":2}', '{"x":1e999}', '{"x":1} true', '['.repeat(42) + '0' + ']'.repeat(42), '{"x":1,}']) {
      expect(() => parseMachineJson(raw)).toThrow('machine_response_invalid')
    }
  })
  it('retains raw Python REAL lexemes for receipt digest verification', () => {
    const document = parseMachineJson('{"run":{"zero":-0.0,"whole":1.0}}')
    expect(document.rawOf((document.value as Row).run)).toBe('{"zero":-0.0,"whole":1.0}')
  })
})

describe('canonical machine observation serializer', () => {
  it('omits legacy uncertainty and preserves missing fields as null', () => {
    const context = machineEstimateContext()
    expect(context).not.toHaveProperty('uncertainty')
    expect(context).toMatchObject({ kind: 'unavailable', estimate_change: null, mae: null, error_p80: null, direction_accuracy: null })
  })

  it('preserves real zero in intraday observations rather than making it missing', () => {
    const { estimate } = estimateFixture('intraday_estimate_canonical')
    const context = machineEstimateContext({ ...estimate, change: 0, valueNav: estimate.baseNav, estNav: estimate.baseNav })
    expect(context).toMatchObject({ kind: 'intraday_estimate', estimate_change: 0, estimate_nav: estimate.baseNav })
    expect(context).not.toHaveProperty('uncertainty')
  })

  it('expands exact QDII uncertainty zero values into canonical fields', () => {
    const { estimate } = estimateFixture('qdii_next_nav_estimate_canonical')
    const context = machineEstimateContext({ ...estimate, uncertainty: { mae: 0, error_p80: 0, direction_accuracy: 0 } })
    expect(context).toMatchObject({ kind: 'qdii_next_nav_estimate', market: 'overseas', mae: 0, error_p80: 0, direction_accuracy: 0,
      target_nav_date: estimate.targetNavDate, base_nav_date: estimate.baseNavDate, sample_count: estimate.sampleCount })
    expect(context).not.toHaveProperty('uncertainty')
  })

  it('keeps published NAV change separate from estimate fields', () => {
    const { estimate } = estimateFixture('official_nav_change_unknown')
    expect(machineEstimateContext(estimate)).toMatchObject({ kind: 'official_nav', estimate_change: null, estimate_nav: null,
      value_change: null, nav_date: estimate.valueDate })
  })
})

describe('actual candidate Worker entry', () => {
  it('runs source → complete observations → original task/claim → exactly one send → finish, without Gist', async () => {
    const net = network()
    const result = await runScheduled(env, NOW, '14:30')
    expect(result).toMatchObject({ status: 'sent', reason: 'sent', funds: 2 })
    expect(net.calls.map((call) => call.path)).toEqual([
      '/api/v2/worker/portfolio/source', '/api/v2/worker/portfolio/evidence',
      '/api/v2/worker/portfolio/tasks/prepare', '/api/v2/worker/portfolio/tasks/claim',
      '/api/v2/worker/portfolio/source', '/send-private.send', '/api/v2/worker/portfolio/tasks/finish',
    ])
    expect(net.providerCalls()).toHaveLength(1)
    const original = (result as Row).original
    expect(original.evidence_request_hash).toBe(await sha(net.calls[1].raw!))
    expect(original.prepare_request_hash).toBe(await sha(net.calls[2].raw!))
    expect(net.calls[1].body!.request_id).toBe(net.calls[3].body!.request_id)
    const content = new URLSearchParams(net.providerCalls()[0].init.body as URLSearchParams).get('desp')!
    expect(content).toContain('0.00%')
    expect(content).toContain('000009：估值未知')
    expect(content).toContain('组合定价不完整')
  })

  it('uses the real /test candidate consumer and original manual axis, not legacy force rules', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
    const net = network()
    const response = await worker.fetch(new Request('https://worker.test/test', { method: 'POST', headers: { Authorization: 'Bearer admin-private' } }), env)
    expect(await response.json()).toMatchObject({ status: 'sent' })
    expect(net.calls.find((call) => call.path.endsWith('/claim'))!.body!.trigger).toBe('manual')
    expect(net.providerCalls()).toHaveLength(1)
  })

  it('accepts an exact Python 0.0 subtree digest without normalizing it to JS integer zero', async () => {
    const net = network({ pythonReal: true })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'sent' })
    expect(net.providerCalls()).toHaveLength(1)
  })

  it('keeps all 100 funds in one source, Evidence, prepare and claim batch', async () => {
    const codes = Array.from({ length: 100 }, (_, i) => String(i + 1).padStart(6, '0'))
    const net = network({ codes })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'sent', funds: 100 })
    expect(net.calls[1].body!.observations).toHaveLength(100)
    expect(net.calls[2].body!.evidence).toHaveLength(100)
    expect(net.calls.filter((call) => call.path.endsWith('/claim'))).toHaveLength(1)
  })

  it.each(['evidence', 'prepare', 'claim', 'finish'])('does not retry or fall back after unknown %s', async (phase) => {
    const net = network({ unknown: phase })
    const result = await runScheduled(env, NOW)
    expect(result).toMatchObject({ status: 'failed', reason: 'machine_write_unknown', phase, original: { request_id: expect.stringMatching(/^machine-/) } })
    expect(net.calls.filter((call) => call.path.endsWith('/' + phase))).toHaveLength(1)
    expect(net.providerCalls()).toHaveLength(phase === 'finish' ? 1 : 0)
    if (phase === 'finish') expect((result as Row).original).toMatchObject({ attempt_hash: expect.any(String), task_hash: expect.any(String), outcome: 'sent' })
  })

  it('never treats claimed=false as send permission or automatically reads it back', async () => {
    const net = network({ duplicate: true })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'skipped', reason: 'machine_not_claimed' })
    expect(net.providerCalls()).toHaveLength(0)
    expect(net.calls.at(-1)!.path).toContain('/claim')
  })

  it.each(['timeout', 'http', 'invalid', 'contradictory', 'oversize'] as const)('records %s as ambiguous with one physical sender call', async (provider) => {
    const net = network({ provider })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'failed', reason: 'delivery_ambiguous' })
    expect(net.providerCalls()).toHaveLength(1)
    expect(net.calls.at(-1)!.body!.outcome).toBe('delivery_ambiguous')
  })

  it('allows only an explicit business rejection to become delivery_rejected', async () => {
    const net = network({ provider: 'rejected' })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'failed', reason: 'delivery_rejected' })
    expect(net.providerCalls()).toHaveLength(1)
  })

  it('rechecks source after claim and records a real pre-delivery failure', async () => {
    const net = network({ sourceChanged: true })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'failed', reason: 'pre_delivery_failed' })
    expect(net.providerCalls()).toHaveLength(0)
    expect(net.calls.at(-1)!.body!.outcome).toBe('pre_delivery_failed')
  })

  it('rechecks actual clock before sending rather than keeping the starting 14:31 window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
    const net = network({ afterClaim: () => vi.setSystemTime(new Date(DAY + 'T06:50:00Z')) })
    const result = await runScheduled(env, NOW)
    expect(result.status).toBe('failed')
    expect(net.providerCalls()).toHaveLength(0)
  })

  it('rejects duplicate response fields before send and does not retry claim', async () => {
    const net = network({ rawClaim: (raw) => raw.replace('"claimed":true', '"claimed":true,"claimed":true') })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'failed', reason: 'machine_write_unknown' })
    expect(net.providerCalls()).toHaveLength(0)
    expect(net.calls.filter((call) => call.path.endsWith('/claim'))).toHaveLength(1)
  })

  it('rejects a changed original run digest even when claimed=true', async () => {
    const net = network({ rawClaim: (raw) => raw.replace('"estimate":0', '"estimate":1') })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'failed', reason: 'machine_write_unknown', phase: 'claim' })
    expect(net.providerCalls()).toHaveLength(0)
  })

  it.each([{ valid_count: 2 }, { artifact_status: 'fresh' }])('rejects contradictory claim counters/artifact even with matching digest: %j', async (attemptOverrides) => {
    const net = network({ attemptOverrides })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'failed', reason: 'machine_write_unknown', phase: 'claim' })
    expect(net.providerCalls()).toHaveLength(0)
  })

  it('rejects more than 100 source codes without truncation, valuation or a POST', async () => {
    const net = network({ codes: Array.from({ length: 101 }, (_, i) => String(i + 1).padStart(6, '0')) })
    expect(await runScheduled(env, NOW)).toMatchObject({ status: 'failed' })
    expect(valuation.resolveValuations).not.toHaveBeenCalled()
    expect(net.posts()).toHaveLength(0)
  })

  it('refuses a candidate manual test outside the machine delivery window', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    expect(await run(env, true, new Date(DAY + 'T07:00:00Z'))).toMatchObject({ status: 'failed', reason: 'machine_outside_delivery_window' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not let candidate failure fall back to populated Gist credentials', async () => {
    const net = network({ unknown: 'source' })
    expect(await run({ ...env, GIST_ID: 'legacy', GIST_TOKEN: 'private' }, false, NOW)).toMatchObject({ status: 'failed' })
    expect(net.calls).toHaveLength(1)
  })

  it('uses one 15-second absolute API deadline across slow headers and body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    network()
    let cancelled = false
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 9000))
      let timer: ReturnType<typeof setTimeout>
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{}')); controller.close() }, 9000) },
        cancel() { cancelled = true; clearTimeout(timer) },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const operation = runScheduled(env, NOW)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await operation).toMatchObject({ status: 'failed', reason: 'machine_read_failed' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(valuation.resolveValuations).not.toHaveBeenCalled()
    expect(cancelled).toBe(true)
  })

  it('shares the single 10-second sender deadline with a slowly streaming reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const net = network()
    const ordinary = vi.mocked(fetch).getMockImplementation()!
    let cancelled = false
    let entered!: () => void
    const senderEntered = new Promise<void>((resolve) => { entered = resolve })
    const wrapped = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (new URL(String(input)).hostname !== 'sctapi.ftqq.com') return ordinary(input, init)
      entered()
      await new Promise((resolve) => setTimeout(resolve, 6000))
      let timer: ReturnType<typeof setTimeout>
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{"code":0}')); controller.close() }, 6000) },
        cancel() { cancelled = true; clearTimeout(timer) },
      }))
    })
    vi.stubGlobal('fetch', wrapped)
    const operation = runScheduled(env, NOW)
    await senderEntered
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await operation).toMatchObject({ status: 'failed', reason: 'delivery_ambiguous' })
    expect(wrapped.mock.calls.filter(([input]) => new URL(String(input)).hostname === 'sctapi.ftqq.com')).toHaveLength(1)
    expect(net.calls.at(-1)!.body!.outcome).toBe('delivery_ambiguous')
    expect(cancelled).toBe(true)
  })

  it('rejects unknown mode and missing build SHA before any network', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(run({ ...env, OWNER_MACHINE_MODE: 'yes' }, false, NOW)).rejects.toThrow('machine_mode_invalid')
    vi.stubGlobal('WORKER_BUILD_SHA', undefined)
    await expect(runScheduled(env, NOW)).rejects.toThrow('machine_configuration_incomplete')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps candidate health Gist-free and private task status protected/read-only', async () => {
    const net = network()
    const health = await worker.fetch(new Request('https://worker.test/health'), env)
    expect(await health.json()).toMatchObject({ runtime: { status: 'unknown', source: 'owner-machine-candidate' } })
    expect(net.calls).toHaveLength(0)
    expect((await worker.fetch(new Request(`https://worker.test/machine-status?date=${DAY}`), env)).status).toBe(401)
    expect(net.calls).toHaveLength(0)
    const response = await worker.fetch(new Request(`https://worker.test/machine-status?date=${DAY}`, { headers: { Authorization: 'Bearer admin-private' } }), env)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ schema: 'owner-machine-status-1', attempts: [] })
    expect(net.calls).toHaveLength(1)
    expect(net.calls[0].method).toBe('GET')
    const withoutSendKey = await worker.fetch(new Request(`https://worker.test/machine-status?date=${DAY}`, { headers: { Authorization: 'Bearer worker-private' } }), { ...env, WECHAT_SENDKEY: '' })
    expect(withoutSendKey.status).toBe(200)
  })
})
