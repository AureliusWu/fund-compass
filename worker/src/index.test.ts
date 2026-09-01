import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { estimateContext, formatMessage, normalizeBuildSha, normalizeEstimate, parseFundHoldings, parsePushState, parseWatchEntries, run, runScheduled, type Env, type Estimate } from './index'
import { estimateFixture } from './estimate-fixtures.test-support'
import { normalizeEstimateWire } from './valuation'

const env: Env = {
  GIST_ID: 'gist', FUND_API_BASE: '', GIST_TOKEN: 'gist-token', WECHAT_SENDKEY: 'send-key',
  ADMIN_TOKEN: 'admin-token', WORKER_TOKEN: 'worker-token',
}
const monday1430 = new Date('2026-07-13T06:30:00Z')
const monday1440 = new Date('2026-07-13T06:40:00Z')
const buildSha = '0123456789abcdef0123456789abcdef01234567'

function stubEdgeCache() {
  const entries = new Map<string, Response>()
  const pending: Promise<unknown>[] = []
  const match = vi.fn(async (input: Request | string) => {
    const key = input instanceof Request ? input.url : String(input)
    return entries.get(key)?.clone()
  })
  const put = vi.fn(async (input: Request | string, response: Response) => {
    const key = input instanceof Request ? input.url : String(input)
    entries.set(key, response.clone())
  })
  vi.stubGlobal('caches', { default: { match, put } })
  const ctx = {
    waitUntil(promise: Promise<unknown>) { pending.push(promise) },
    passThroughOnException() {},
  } as ExecutionContext
  return {
    entries,
    match,
    put,
    ctx,
    async drain() {
      await Promise.all(pending.splice(0))
    },
  }
}

describe('scheduled next-NAV estimate contract', () => {
  it.each(['qdii_next_nav_estimate_canonical', 'official_nav_change_unknown'])(
    'preserves canonical shared %s evidence for backend decisions', (id) => {
      const { wire, estimate } = estimateFixture(id)
      const context = estimateContext(estimate)
      for (const key of [
        'kind', 'source_time', 'value_nav', 'value_change', 'nav_date', 'base_nav', 'base_nav_date',
        'estimate_nav', 'estimate_change', 'estimate_time',
      ]) expect(context[key as keyof typeof context], key).toStrictEqual(wire[key])
      expect(normalizeEstimateWire(context)).toMatchObject({ kind: wire.kind, legacy_alias_used: false })
      if (id === 'qdii_next_nav_estimate_canonical') {
        expect(context).toMatchObject({
          market: 'overseas', target_nav_date: wire.target_nav_date,
          estimate_model_version: wire.estimate_model_version, sample_count: wire.sample_count,
          coverage: wire.coverage, uncertainty: wire.uncertainty,
        })
      }
    },
  )

  it('fails closed to unavailable when next-NAV model metadata is unknown', () => {
    const { estimate } = estimateFixture('qdii_next_nav_estimate_canonical')
    expect(estimateContext({ ...estimate, targetNavDate: null })).toMatchObject({
      kind: 'unavailable', estimate_nav: null, estimate_change: null, target_nav_date: null,
      estimate_model_version: null, sample_count: null, coverage: null, uncertainty: null,
    })
  })
})

function tencentQuoteRow(code: string, options: {
  price?: number; previousClose?: number; change?: number | null; timestamp?: string
} = {}): string {
  const fields = Array.from({ length: 33 }, () => '')
  fields[3] = String(options.price ?? 100)
  fields[4] = String(options.previousClose ?? 99)
  fields[30] = options.timestamp ?? '20260828153000'
  fields[32] = options.change === null ? '' : String(options.change ?? 1.01)
  return `v_${code.replace(/-/g, '_')}="${fields.join('~')}";`
}

function mockDecisionResponse(body: Record<string, unknown>) {
  const items = body.items as Array<{ code: string }>
  const decisions = items.map((item, index) => ({
    code: item.code,
    action: 'dca',
    action_label: '分批定投',
    summary: '维持计划',
    decision: {
      decision_id: `dec_${String(index + 1).padStart(64, 'a')}`,
      fund_code: item.code,
      action: 'dca',
    },
  }))
  return {
    request_id: body.request_id,
    duplicate: false,
    requested: items.length,
    total: decisions.length,
    complete: true,
    decisions,
    errors: [],
    policy_version: `pol_${'b'.repeat(64)}`,
    strategy_version: 'v8-decision-kernel-1',
    allocation: { complete: true, warnings: [] },
  }
}

function mockNotificationResponse(
  body: Record<string, unknown>,
  seen: Set<string>,
) {
  const ids = body.decision_ids as string[]
  const status = String(body.status)
  return {
    total: ids.length,
    events: ids.map((decisionId, index) => {
      const key = `${decisionId}:${body.scheduled_window}:${status}:${body.attempt_no}`
      const duplicate = seen.has(key)
      seen.add(key)
      return {
        claimed: status === 'attempted' && !duplicate,
        duplicate,
        event: {
          notification_event_id: `ntf_${String(index + 1).padStart(64, 'c')}`,
          event_log_id: `ntl_${String(index + 1).padStart(64, 'd')}`,
          decision_id: decisionId,
          scheduled_window: body.scheduled_window,
          status,
          attempt_no: body.attempt_no,
          natural_schedule: body.natural_schedule,
          occurred_at: body.occurred_at,
          error_class: body.error_class ?? null,
          detail: body.detail,
        },
      }
    }),
  }
}

function fakeNetwork(sendStatuses = [200], options: {
  patchFails?: boolean; patchFailures?: number; missingSecond?: boolean; gistReadFails?: boolean
    estimateFails?: boolean; officialFails?: boolean; holdingsFails?: boolean
  backend?: 'success' | 'timeout' | 'unauthorized'
  estimateDates?: Record<string, string>
  officialDates?: [string, string]
  missingNav?: string[]
  watchEntries?: unknown[]
  rawWatchlist?: unknown
  initialState?: Record<string, unknown>
} = {}) {
  let state: Record<string, unknown> = { ...(options.initialState || {}) }
  let sends = 0
  let patches = 0
  let outcomeSettlements = 0
  let decisionBody: Record<string, unknown> | null = null
  const decisionBodies: Record<string, unknown>[] = []
  const notificationEvents: Record<string, unknown>[] = []
  const seenNotificationEvents = new Set<string>()
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/gists/gist') && (!init?.method || init.method === 'GET')) {
      if (options.gistReadFails) return new Response('failed', { status: 502 })
      return Response.json({ files: {
        'sinan-watchlist.json': { content: JSON.stringify(options.rawWatchlist ?? options.watchEntries ?? [{ code: '000001', name: '一号' }, { code: '000002', name: '二号' }]) },
        'sinan-estimate-state.json': { content: JSON.stringify(state) },
      } })
    }
    if (url.includes('/gists/gist') && init?.method === 'PATCH') {
      patches += 1
      if (options.patchFails || patches <= (options.patchFailures ?? 0)) {
        return new Response('failed', { status: 500 })
      }
      const body = JSON.parse(String(init.body))
      state = JSON.parse(body.files['sinan-estimate-state.json'].content)
      return Response.json({ ok: true })
    }
    if (url.includes('/FundGuZhi/GetFundGZList')) {
      if (options.estimateFails) return new Response('upstream unavailable', { status: 503 })
      const list = ['000001', ...(options.missingSecond ? [] : ['000002'])].map((code) => ({
        bzdm: code, jjjc: `基金${code}`,
        dwjz: options.missingNav?.includes(code) ? '' : '1',
        gsz: options.missingNav?.includes(code) ? '' : '1.01',
        gszzl: options.missingNav?.includes(code) ? '' : '1%', gzrq: '2026-07-12',
        gxrq: options.estimateDates?.[code] || '2026-07-13 14:29',
      }))
      return Response.json({ ErrCode: 0, Data: { list } })
    }
    if (url.includes('/f10/lsjz')) {
      if (options.officialFails) return new Response('official unavailable', { status: 503 })
      const dates = options.officialDates || ['2026-07-12', '2026-07-11']
      return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: dates[0], DWJZ: '1.0200', JZZZL: '2.00' },
        { FSRQ: dates[1], DWJZ: '1.0000', JZZZL: '0.50' },
      ] } })
    }
    if (url.includes('/pingzhongdata/')) {
      const code = /\/pingzhongdata\/(\d{6})\.js/.exec(url)?.[1] || ''
      return new Response(`var fS_name = "基金${code}";`)
    }
    if (url.includes('/FundArchivesDatas.aspx')) {
      if (options.holdingsFails) return new Response('upstream unavailable', { status: 503 })
      const code = new URL(url).searchParams.get('code') || ''
      expect(new Headers(init?.headers).get('Referer')).toBe(`https://fundf10.eastmoney.com/ccmx_${code}.html`)
      if (code !== '005844') return new Response('var apidata={ content:"<table></table>" };')
      return new Response(`var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4>
        <table><tbody><tr><td>1</td><td><a>688361</a></td><td><a>中科飞测</a></td>
        <td></td><td></td><td></td><td>9.55%</td></tr></tbody></table>" };`)
    }
    if (url.includes('/api/qt/ulist.np/get')) {
      return Response.json({ data: { diff: [] } })
    }
    if (url.includes('sctapi.ftqq.com')) {
      const status = sendStatuses[Math.min(sends++, sendStatuses.length - 1)]
      return new Response(status === 200 ? '{"code":0}' : 'rate limited', {
        status, headers: status === 429 ? { 'Retry-After': '0' } : {},
      })
    }
    if (url.includes('/api/v2/outcomes/settle')) {
      outcomeSettlements += 1
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-token')
      return Response.json({ settled: 0, pending: 0, errors: [] })
    }
    if (url.includes('/api/v2/notifications/events')) {
      const body = JSON.parse(String(init?.body))
      notificationEvents.push(body)
      return Response.json(mockNotificationResponse(body, seenNotificationEvents))
    }
    if (url.includes('/api/v2/portfolio/decisions')) {
      if (options.backend === 'timeout') throw new DOMException('timeout', 'AbortError')
      if (options.backend === 'unauthorized') return new Response('unauthorized', { status: 401 })
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-token')
      const body = JSON.parse(String(init?.body))
      decisionBody = body
      decisionBodies.push(body)
      expect([
        'natural-2026-07-13-primary', 'manual-2026-07-13-143000',
      ]).toContain(body.request_id)
      return Response.json(mockDecisionResponse(body))
    }
    throw new Error(`unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    getState: () => state,
    getSends: () => sends,
    getOutcomeSettlements: () => outcomeSettlements,
    getDecisionBody: () => decisionBody,
    getDecisionBodies: () => decisionBodies,
    getNotificationEvents: () => notificationEvents,
    fetchMock,
  }
}

function fakeModelNetwork(options: { qdii?: boolean; freshPrimary?: boolean } = {}) {
  let state: Record<string, unknown> = {}
  let decisionBody: Record<string, unknown> | null = null
  const holdingCodes = ['688001', '688002', '688003', '688004', '688005', '688006']
  const name = options.qdii ? '嘉实美国成长股票(QDII)' : '国内科技混合'
  const seenNotificationEvents = new Set<string>()
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/gists/gist') && (!init?.method || init.method === 'GET')) {
      return Response.json({ files: {
        'sinan-watchlist.json': { content: JSON.stringify([{ code: '005844', name, shares: 100 }]) },
        'sinan-estimate-state.json': { content: JSON.stringify(state) },
      } })
    }
    if (url.includes('/gists/gist') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      state = JSON.parse(body.files['sinan-estimate-state.json'].content)
      return Response.json({ ok: true })
    }
    if (url.includes('/FundGuZhi/GetFundGZList')) {
      return Response.json({ ErrCode: 0, Data: { list: options.freshPrimary ? [{
        bzdm: '005844', jjjc: name, FType: options.qdii ? 'QDII' : '混合型',
        dwjz: '1', gsz: '1.01', gszzl: '1%', gzrq: '2026-07-12', gxrq: '2026-07-13 14:29',
      }] : [{
        bzdm: '005844', jjjc: name, FType: options.qdii ? 'QDII' : '混合型',
        dwjz: '1', gsz: '1.01', gszzl: '1%', gzrq: '2026-07-11', gxrq: '2026-07-12',
      }] } })
    }
    if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
      { FSRQ: '2026-07-12', DWJZ: '1.0200', JZZZL: '2.00' },
      { FSRQ: '2026-07-11', DWJZ: '1.0000', JZZZL: '0.50' },
    ] } })
    if (url.includes('/pingzhongdata/')) return new Response(`var fS_name = "${name}";`)
    if (url.includes('/FundArchivesDatas.aspx')) {
      const rows = holdingCodes.map((code, index) => `<tr><td>${index + 1}</td><td><a>${code}</a></td><td><a>持仓${index}</a></td><td></td><td></td><td></td><td>10%</td></tr>`).join('')
      return new Response(`var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4><table>${rows}</table>" };`)
    }
    if (url.includes('/api/qt/ulist.np/get')) return Response.json({ data: { diff: holdingCodes.map((code) => ({
      f12: code, f2: 100, f3: 2, f124: Date.parse('2026-07-13T06:29:00Z') / 1000,
    })) } })
    if (url.includes('/api/v2/outcomes/settle')) {
      return Response.json({ settled: 0, pending: 0, errors: [] })
    }
    if (url.includes('/api/v2/notifications/events')) {
      const body = JSON.parse(String(init?.body))
      return Response.json(mockNotificationResponse(body, seenNotificationEvents))
    }
    if (url.includes('/api/v2/portfolio/decisions')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      decisionBody = body
      return Response.json(mockDecisionResponse(body))
    }
    if (url.includes('sctapi.ftqq.com')) return new Response('{"code":0}')
    throw new Error(`unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, getState: () => state, getDecisionBody: () => decisionBody }
}

function fakeBudgetedModelNetwork() {
  let state: Record<string, unknown> = {}
  let decisionBody: Record<string, unknown> | null = null
  let notification = ''
  const fundCodes = Array.from({ length: 10 }, (_, index) => String(index + 1).padStart(6, '0'))
  const modelCodes = new Set(fundCodes.slice(0, 3))
  const holdingCodes = ['688001', '688002', '688003', '688004', '688005', '688006']
  const watchEntries = fundCodes.map((code) => ({ code, name: `基金${code}`, shares: 100 }))
  const seenNotificationEvents = new Set<string>()
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/gists/gist') && (!init?.method || init.method === 'GET')) {
      return Response.json({ files: {
        'sinan-watchlist.json': { content: JSON.stringify(watchEntries) },
        'sinan-estimate-state.json': { content: JSON.stringify(state) },
      } })
    }
    if (url.includes('/gists/gist') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      state = JSON.parse(body.files['sinan-estimate-state.json'].content)
      return Response.json({ ok: true })
    }
    if (url.includes('/FundGuZhi/GetFundGZList')) {
      return Response.json({ ErrCode: 0, Data: { list: fundCodes.map((code) => ({
        bzdm: code, jjjc: `基金${code}`, FType: '混合型', dwjz: '1', gsz: '1.01', gszzl: '1%',
        gzrq: '2026-07-11', gxrq: '2026-07-12',
      })) } })
    }
    if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
      { FSRQ: '2026-07-12', DWJZ: '1.0200', JZZZL: '2.00' },
      { FSRQ: '2026-07-11', DWJZ: '1.0000', JZZZL: '0.50' },
    ] } })
    if (url.includes('/FundArchivesDatas.aspx')) {
      const code = new URL(url).searchParams.get('code') || ''
      expect(modelCodes.has(code)).toBe(true)
      const rows = holdingCodes.map((holdingCode, index) => (
        `<tr><td>${index + 1}</td><td><a>${holdingCode}</a></td><td><a>持仓${index}</a></td>`
        + '<td></td><td></td><td></td><td>10%</td></tr>'
      )).join('')
      return new Response(`var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4><table>${rows}</table>" };`)
    }
    if (url.includes('/api/qt/ulist.np/get')) return Response.json({ data: { diff: holdingCodes.map((code) => ({
      f12: code, f2: 100, f3: 2, f124: Date.parse('2026-07-13T06:29:00Z') / 1000,
    })) } })
    if (url.includes('/api/v2/outcomes/settle')) {
      return Response.json({ settled: 0, pending: 0, errors: [] })
    }
    if (url.includes('/api/v2/notifications/events')) {
      const body = JSON.parse(String(init?.body))
      return Response.json(mockNotificationResponse(body, seenNotificationEvents))
    }
    if (url.includes('/api/v2/portfolio/decisions')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      decisionBody = body
      return Response.json(mockDecisionResponse(body))
    }
    if (url.includes('sctapi.ftqq.com')) {
      notification = String((init?.body as URLSearchParams).get('desp'))
      return new Response('{"code":0}')
    }
    throw new Error(`unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    getDecisionBody: () => decisionBody,
    getNotification: () => notification,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('watchlist boundary', () => {
  it('keeps valid entries while isolating malformed Gist rows and optional fields', () => {
    expect(parseWatchEntries([
      null,
      'bad',
      [],
      { code: 'bad' },
      { code: ' 000001 ', name: '  一号  ', shares: '100.5', target_weight: '25', deleted: false },
      { code: '000002', name: '二号', shares: -1, target_weight: 101 },
      { code: '000003', deleted: 'false' },
      { code: '000004', deleted: true },
    ])).toEqual([
      { code: '000001', name: '一号', shares: 100.5, target_weight: 25 },
      { code: '000002', name: '二号' },
    ])
  })

  it('treats a non-array Gist payload as an empty watchlist', () => {
    expect(parseWatchEntries({ code: '000001' })).toEqual([])
    expect(parseWatchEntries('not-json-array')).toEqual([])
  })
})

describe('Cloudflare push worker', () => {
  it('accepts only a complete Git commit identity', () => {
    expect(normalizeBuildSha(`  ${buildSha.toUpperCase()}  `)).toBe(buildSha)
    expect(normalizeBuildSha('0123456')).toBeNull()
    expect(normalizeBuildSha('g'.repeat(40))).toBeNull()
    expect(normalizeBuildSha(null)).toBeNull()
  })

  it('sanitizes untrusted Gist push state with bounded typed fields', () => {
    expect(parsePushState('[]')).toEqual({})
    expect(parsePushState('{bad json')).toEqual({})
    expect(parsePushState(JSON.stringify({
      date: '2026-07-13', sent_slots: ['14:30', '14:30', '14:40', 1], attempt_count: 2,
      last_slot: '14:30', last_cron_at: '2026-07-13T14:40:00+08:00',
      last_cron_build_sha: buildSha.toUpperCase(),
      scheduled_at: '2026-07-13T14:30:00+08:00', schedule_delay_seconds: 600,
      last_cron_result: 'skipped', last_cron_reason: 'no_publishable_intraday',
      last_success_at: '2026-07-11T14:30:00+08:00', last_error: '', last_warning: 'warning',
      decision_status: 'degraded', last_http_status: 429, extra: 'discard me',
    }))).toEqual({
      date: '2026-07-13', sent_slots: ['14:30', '14:40'], attempt_count: 2, last_slot: '14:30',
      last_cron_at: '2026-07-13T14:40:00+08:00', last_cron_result: 'skipped',
      last_cron_build_sha: buildSha,
      scheduled_at: '2026-07-13T14:30:00+08:00', schedule_delay_seconds: 600,
      last_cron_reason: 'no_publishable_intraday', last_success_at: '2026-07-11T14:30:00+08:00',
      last_error: '', last_warning: 'warning', decision_status: 'degraded', last_http_status: 429,
    })
  })

  it('drops malformed daily state while preserving only verifiable global history', () => {
    expect(parsePushState(JSON.stringify({
      date: '2026-02-30', sent_slots: '14:30', attempt_count: 1001, last_slot: 'bad',
      last_success_at: '2026-07-11T14:30:00+08:00', last_attempt_at: 'not-a-time',
      last_cron_result: 'unknown', last_cron_reason: 'x'.repeat(81), last_error: 'x'.repeat(241),
      last_cron_build_sha: 'not-a-full-sha',
      scheduled_at: 'not-a-time', schedule_delay_seconds: -1,
      decision_status: 'unknown', last_http_status: 99,
    }))).toEqual({ last_success_at: '2026-07-11T14:30:00+08:00' })
  })

  it.each(['14:30', { slot: '14:30' }])(
    'does not crash or falsely deduplicate a same-day malformed sent_slots=%j',
    async (sentSlots) => {
      const net = fakeNetwork([200], { initialState: {
        date: '2026-07-13', sent_slots: sentSlots, attempt_count: '2',
      } })
      await expect(run(env, false, monday1430)).resolves.toMatchObject({ status: 'sent' })
      expect(net.getSends()).toBe(1)
      expect(net.getState()).toMatchObject({ sent_slots: ['14:30'], attempt_count: 1 })
    },
  )

  it('normalizes and formats an estimate', () => {
    const result = normalizeEstimate({ name: '测试基金', dwjz: '1.0', gsz: '1.02', gztime: '2026-07-13 14:30' }, '000001')
    expect(result.change).toBeCloseTo(2)
    const estimate: Estimate = normalizeEstimate({
      name: '测试基金', dwjz: 1, gsz: 1.02, gszzl: 2,
      gztime: '2026-07-13 14:30', gzrq: '2026-07-12',
    }, '000001')
    expect(formatMessage([{ code: '000001' }], new Map([['000001', estimate]]), null)).toContain('+2.00%')
  })

  it('keeps null and blank upstream values missing instead of converting them to zero', () => {
    const result = normalizeEstimate({ name: '缺失值基金', dwjz: null, gsz: '', gszzl: '--' }, '000003')
    expect(result.lastNav).toBeNull()
    expect(result.estNav).toBeNull()
    expect(result.change).toBeNull()
  })

  it('skips malformed Gist rows and still processes the valid fund', async () => {
    const net = fakeNetwork([200], {
      rawWatchlist: [null, 'bad', { code: 'invalid' }, { code: ' 000001 ', name: '一号' }],
    })

    await expect(run(env, false, monday1430)).resolves.toMatchObject({ status: 'sent', funds: 1 })
    const estimateCall = net.fetchMock.mock.calls.find(([input]) => String(input).includes('/FundGuZhi/GetFundGZList'))
    expect(estimateCall).toBeDefined()
    expect(net.getSends()).toBe(1)
  })

  it('gracefully skips when the Gist watchlist has no valid entries', async () => {
    const net = fakeNetwork([200], { rawWatchlist: [null, 'bad', [], { code: 'invalid' }] })

    await expect(run(env, false, monday1430)).resolves.toEqual({ status: 'skipped', reason: 'empty_watchlist' })
    expect(net.getSends()).toBe(0)
    expect(net.fetchMock.mock.calls.some(([input]) => String(input).includes('/FundGuZhi/GetFundGZList'))).toBe(false)
  })

  it('settles outcomes before an empty-watchlist early exit', async () => {
    const net = fakeNetwork([200], { rawWatchlist: [], backend: 'success' })

    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .resolves.toMatchObject({
        status: 'skipped', reason: 'empty_watchlist',
        outcome_settlement: { settled: 0, pending: 0, errors: [] },
      })
    expect(net.getOutcomeSettlements()).toBe(1)
    expect(net.getDecisionBodies()).toHaveLength(0)
    expect(net.getSends()).toBe(0)
  })

  it('caps scheduled valuation subrequests while preserving an accounted skip', async () => {
    const watchEntries = Array.from({ length: 25 }, (_, index) => ({
      code: String(index + 1).padStart(6, '0'),
    }))
    const net = fakeNetwork([200], { watchEntries, estimateFails: true, officialFails: true })

    await expect(runScheduled(env, monday1430)).resolves.toMatchObject({
      status: 'skipped', reason: 'no_publishable_intraday',
    })
    const valuationCalls = net.fetchMock.mock.calls.filter(([input]) => {
      const url = String(input)
      return url.includes('eastmoney.com') || url.includes('eastmoney.com.cn')
    })
    expect(valuationCalls.length).toBeLessThanOrEqual(34)
    expect(net.getState()).toMatchObject({
      last_cron_result: 'skipped', last_cron_reason: 'no_publishable_intraday',
    })
  })

  it('parses the latest disclosed stock holdings and report date', () => {
    const result = parseFundHoldings(`var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4>
      <table><tbody><tr><td>1</td><td><a>688361</a></td><td><a>中科飞测</a></td>
      <td></td><td></td><td></td><td>9.55%</td></tr></tbody></table>" };`)
    expect(result.reportDate).toBe('2026-06-30')
    expect(result.items).toEqual([{ code: '688361', name: '中科飞测', ratio: 9.55 }])
  })

  it('sends at 14:30 and skips the 14:40 compensation after success', async () => {
    const net = fakeNetwork()
    expect((await run(env, false, monday1430)).status).toBe('sent')
    expect((await run(env, false, monday1440)).reason).toBe('already_sent')
    expect(net.getSends()).toBe(1)
  })

  it('uses the injected run clock for the intraday publish gate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T06:30:00Z'))
    const net = fakeNetwork()

    await expect(run(env, false, monday1430)).resolves.toMatchObject({ status: 'sent' })
    expect(net.getSends()).toBe(1)
  })

  it('keeps an expired sibling out of notification changes and decision evidence', async () => {
    const net = fakeNetwork([200], {
      backend: 'success',
      watchEntries: [
        { code: '000001', name: 'fresh', shares: 100 },
        { code: '000002', name: 'expired', shares: 100 },
      ],
      estimateDates: { '000002': '2026-07-13 12:59:00' },
    })

    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .resolves.toMatchObject({ status: 'sent', fresh: true, stale: 1 })
    const decision = net.getDecisionBody() as { items: Array<Record<string, unknown>>; portfolio_value: number }
    const fresh = decision.items.find((item) => item.code === '000001')!
    const expired = decision.items.find((item) => item.code === '000002')!
    expect(fresh.estimate_context).toMatchObject({
      kind: 'intraday_estimate', source_time: '2026-07-13T14:29:00+08:00',
      estimate_time: '2026-07-13T14:29:00+08:00', value_change: null, nav_date: null,
    })
    expect(expired.estimate_context).toMatchObject({
      kind: 'official_nav', status: 'latest_official', source_time_precision: 'date',
      base_nav: null, base_nav_date: null,
      estimate_nav: null, value_nav: 1, value_change: null, estimate_change: null,
      estimate_time: null,
    })
    expect((expired.holding as Record<string, unknown>).current_weight).toBe(49.75)
    expect(decision.portfolio_value).toBe(201)
    const sendCall = net.fetchMock.mock.calls.find(([input]) => String(input).includes('sctapi.ftqq.com'))
    const message = String((sendCall?.[1]?.body as URLSearchParams).get('desp'))
    expect(message).toContain('**expired** --（行情过期/延迟数据不参与）')
    expect(message).not.toContain('**expired** +')
  })

  it('records persistent 429 and succeeds on the 14:40 compensation', async () => {
    const net = fakeNetwork([429, 429, 200])
    await expect(run(env, false, monday1430)).rejects.toThrow('serverchan_http_error_http_429')
    expect(net.getState().last_http_status).toBe(429)
    expect((await run(env, false, monday1440)).status).toBe('sent')
    expect(net.getState().attempt_count).toBe(2)
    expect(net.getSends()).toBe(3)
  })

  it('keeps provider secrets and response bodies out of errors and persisted state', async () => {
    const secretBody = `rejected send-key private webhook body`
    const net = fakeNetwork([200])
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('sctapi.ftqq.com')) {
        return Response.json({ code: 401, message: secretBody })
      }
      return original(input, init)
    })

    await expect(run(env, false, monday1430)).rejects.toThrow('serverchan_business_rejected_http_200_code_401')
    const serialized = JSON.stringify(net.getState())
    expect(serialized).not.toContain('send-key')
    expect(serialized).not.toContain(secretBody)
    expect(net.getState().last_error).toBe('serverchan_business_rejected_http_200_code_401')
  })

  it('maps a ServerChan timeout to a stable persisted reason', async () => {
    const net = fakeNetwork([200])
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('sctapi.ftqq.com')) throw new DOMException('private timeout detail', 'TimeoutError')
      return original(input, init)
    })

    await expect(run(env, false, monday1430)).rejects.toThrow('serverchan_timeout')
    expect(net.getState().last_error).toBe('serverchan_timeout')
  })

  it.each([
    ['timeout', 'serverchan_timeout'],
    ['network', 'serverchan_network_error'],
    ['ambiguous response', 'serverchan_business_rejected_http_200'],
  ])('audits a %s delivery failure as delivery_ambiguous', async (mode, expectedError) => {
    const net = fakeNetwork([200], { backend: 'success' })
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => {
      if (!String(input).includes('sctapi.ftqq.com')) return original(input, init)
      if (mode === 'timeout') throw new DOMException('private timeout detail', 'TimeoutError')
      if (mode === 'network') throw new TypeError('private socket detail')
      return Response.json({ message: 'provider result omitted' })
    })

    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .rejects.toThrow(expectedError)
    const failed = [...net.getNotificationEvents()].reverse().find((event) => event.status === 'failed')
    expect(failed).toMatchObject({ status: 'failed', error_class: 'delivery_ambiguous' })
    expect(net.getState().sent_slots).toEqual([])
  })

  it.each([
    ['conflicting codes', { code: 0, errno: 1 }],
    ['missing code', { message: 'ambiguous success' }],
  ])('rejects ServerChan business responses with %s', async (_label, payload) => {
    const net = fakeNetwork([200])
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => (
      String(input).includes('sctapi.ftqq.com') ? Response.json(payload) : original(input, init)
    ))

    await expect(run(env, false, monday1430)).rejects.toThrow('serverchan_business_rejected')
    expect(net.getState().sent_slots).toEqual([])
  })

  it('fails clearly when Gist state cannot be written and does not send', async () => {
    const net = fakeNetwork([200], { patchFails: true })
    await expect(run(env, false, monday1430)).rejects.toThrow('Gist 状态写入失败')
    expect(net.getSends()).toBe(0)
  })

  it('closes a claimed pre-send Gist failure so 14:40 can compensate once', async () => {
    const net = fakeNetwork([200], { backend: 'success', patchFailures: 1 })
    const withBackend = { ...env, FUND_API_BASE: 'https://api.test' }

    await expect(run(withBackend, false, monday1430)).rejects.toThrow('Gist 状态写入失败')
    expect(net.getSends()).toBe(0)
    expect(net.getNotificationEvents().map((event) => event.status)).toEqual([
      'scheduled', 'attempted', 'failed',
    ])
    expect(net.getNotificationEvents()[2]).toMatchObject({
      scheduled_window: '2026-07-13T14:30+08:00',
      attempt_no: 1,
      error_class: 'pre_delivery_state_persistence_failed',
    })

    await expect(run(withBackend, false, monday1440)).resolves.toMatchObject({ status: 'sent' })
    expect(net.getSends()).toBe(1)
    expect(net.getNotificationEvents().map((event) => event.status)).toEqual([
      'scheduled', 'attempted', 'failed', 'scheduled', 'attempted', 'compensated',
    ])
  })

  it('keeps the official fallback visible when one primary estimate row is missing', async () => {
    const net = fakeNetwork([200], { missingSecond: true })
    const result = await run(env, false, monday1430)
    const sendCall = net.fetchMock.mock.calls.find(([input]) => String(input).includes('sctapi.ftqq.com'))
    const body = sendCall?.[1]?.body as URLSearchParams

    expect(result).toMatchObject({ funds: 2 })
    expect(body.get('desp')).toContain('**二号** +2.00%（最近净值）')
    expect(net.getSends()).toBe(1)
  })

  it('records a scheduled no-fresh skip without claiming a send attempt', async () => {
    const net = fakeNetwork([200], {
      estimateDates: { '000001': '2026-07-12', '000002': '2026-07-12' },
    })
    const result = await runScheduled(env, monday1430)

    expect(result).toMatchObject({ status: 'skipped', reason: 'official_nav_only' })
    expect(net.getState()).toMatchObject({
      last_cron_at: '2026-07-13T14:30:00+08:00',
      last_cron_result: 'skipped',
      last_cron_reason: 'official_nav_only',
    })
    expect(net.getState().last_attempt_at).toBeUndefined()
    expect(net.getSends()).toBe(0)
  })

  it('records an official-only skip when the primary estimate source fails', async () => {
    const net = fakeNetwork([200], {
      estimateFails: true,
      initialState: {
        date: '2026-07-12', sent_slots: ['14:30'], attempt_count: 2,
        last_success_at: '2026-07-11T14:30:00+08:00',
      },
    })

    await expect(runScheduled(env, monday1430)).resolves.toMatchObject({
      status: 'skipped', reason: 'official_nav_only',
    })
    expect(net.getState()).toMatchObject({
      date: '2026-07-13',
      sent_slots: [],
      attempt_count: 0,
      last_success_at: '2026-07-11T14:30:00+08:00',
      last_cron_at: '2026-07-13T14:30:00+08:00',
      last_cron_result: 'skipped',
      last_cron_reason: 'official_nav_only',
    })
    expect(net.getSends()).toBe(0)
  })

  it('does not let a settlement failure block an official-only early exit', async () => {
    const net = fakeNetwork([200], {
      backend: 'success',
      estimateDates: { '000001': '2026-07-12', '000002': '2026-07-12' },
    })
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => (
      String(input).includes('/api/v2/outcomes/settle')
        ? new Response('temporarily unavailable', { status: 503 })
        : original(input, init)
    ))

    await expect(runScheduled({ ...env, FUND_API_BASE: 'https://api.test' }, monday1430))
      .resolves.toMatchObject({
        status: 'skipped', reason: 'official_nav_only', outcome_settlement: null,
        warning: '决策结果结算暂不可用: HTTP 503',
      })
    expect(net.fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/v2/outcomes/settle')))
      .toHaveLength(1)
    expect(net.getState()).toMatchObject({
      last_cron_result: 'skipped', last_cron_reason: 'official_nav_only',
      last_warning: '决策结果结算暂不可用: HTTP 503',
    })
    expect(net.getDecisionBodies()).toHaveLength(0)
    expect(net.getSends()).toBe(0)
  })

  it('clears a previous-day failure and warning when today is skipped cleanly', async () => {
    const net = fakeNetwork([200], {
      estimateDates: { '000001': '2026-07-12', '000002': '2026-07-12' },
      initialState: {
        date: '2026-07-12', sent_slots: [], attempt_count: 1,
        last_error: 'serverchan_http_error_http_500', last_warning: 'old warning',
        last_cron_result: 'failed', last_cron_at: '2026-07-12T14:30:00+08:00',
      },
    })

    await expect(runScheduled(env, monday1430)).resolves.toMatchObject({
      status: 'skipped', reason: 'official_nav_only',
    })
    expect(net.getState()).toMatchObject({
      date: '2026-07-13', last_cron_result: 'skipped',
      last_error: '', last_warning: '',
    })
  })

  it('lets an official-only scheduled skip complete in the Cloudflare execution context', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    fakeNetwork([200], { estimateFails: true })
    const pending: Promise<unknown>[] = []
    const ctx = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise) },
    } as unknown as ExecutionContext

    await worker.scheduled({} as ScheduledController, env, ctx)

    expect(pending).toHaveLength(1)
    await expect(pending[0]).resolves.toBeUndefined()
  })

  it('uses the execution clock for freshness and records delayed planned Cron telemetry', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WORKER_BUILD_SHA', buildSha)
    const executedAt = new Date('2026-07-13T06:37:00Z')
    vi.setSystemTime(executedAt)
    const net = fakeNetwork([200], {
      backend: 'success',
      estimateDates: {
        '000001': '2026-07-13 14:36:00',
        '000002': '2026-07-13 14:36:00',
      },
    })
    const pending: Promise<unknown>[] = []
    const ctx = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise) },
    } as unknown as ExecutionContext

    await worker.scheduled({
      scheduledTime: monday1430.getTime(), cron: '30 6 * * MON-FRI',
    } as ScheduledController, { ...env, FUND_API_BASE: 'https://api.test' }, ctx)
    await expect(pending[0]).resolves.toBeUndefined()

    expect(net.getState()).toMatchObject({
      last_slot: '14:30',
      last_attempt_at: '2026-07-13T14:37:00+08:00',
      last_cron_at: '2026-07-13T14:37:00+08:00',
      last_cron_build_sha: buildSha,
      scheduled_at: '2026-07-13T14:30:00+08:00',
      schedule_delay_seconds: 420,
      last_cron_result: 'sent',
    })
    expect(net.getNotificationEvents().every((event) => (
      event.occurred_at === '2026-07-13T14:37:00+08:00'
      && event.scheduled_window === '2026-07-13T14:30+08:00'
    ))).toBe(true)
    expect(net.getSends()).toBe(1)
  })

  it('labels a stale primary row with its official fallback in a fresh push', async () => {
    const net = fakeNetwork([200], { estimateDates: { '000002': '2026-07-12' } })
    const result = await run(env, false, monday1430)
    const sendCall = net.fetchMock.mock.calls.find(([input]) => String(input).includes('sctapi.ftqq.com'))
    const body = sendCall?.[1]?.body as URLSearchParams

    expect(result).toMatchObject({ status: 'sent', fresh: true, stale: 1 })
    expect(body.get('desp')).not.toContain('**二号** +1.00%')
    expect(body.get('desp')).toContain('**二号** +2.00%（最近净值）')
  })

  it('keeps all ten funds in notification and decisions when only three receive the model budget', async () => {
    const net = fakeBudgetedModelNetwork()
    const result = await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)
    const decision = net.getDecisionBody() as { items: Array<Record<string, unknown>> }
    const contexts = decision.items.map((item) => item.estimate_context as Record<string, unknown>)

    expect(result).toMatchObject({
      status: 'sent', funds: 10, fresh: false, modeled: 3, stale: 7, decision_status: 'ok',
    })
    expect(decision.items).toHaveLength(10)
    expect(contexts.filter((context) => context.kind === 'holdings_model')).toHaveLength(3)
    expect(contexts.filter((context) => context.kind === 'official_nav')).toHaveLength(7)
    expect(contexts.some((context) => context.kind === 'unavailable')).toBe(false)
    expect(net.getNotification().match(/\*\*基金\d{6}\*\*/g)).toHaveLength(10)
    expect(net.getNotification().match(/（最近净值）/g)).toHaveLength(7)
  })

  it('runs the mocked Gist to estimate to backend to ServerChan to state chain', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    const result = await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)
    expect(result).toMatchObject({
      status: 'sent', outcome_settlement: { settled: 0, pending: 0, errors: [] },
    })
    expect(net.getState().sent_slots).toEqual(['14:30'])
  })

  it('uses the v2 holding contract and records the natural notification event sequence', async () => {
    const net = fakeNetwork([200], { backend: 'success' })

    await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)

    const decision = net.getDecisionBody() as { items: Array<Record<string, unknown>> }
    expect(decision.items[0]).not.toHaveProperty('current_weight')
    expect(decision.items[0]).not.toHaveProperty('target_weight')
    expect(decision.items[0].holding).toEqual({ is_held: false, source: 'worker-gist' })
    expect(net.getNotificationEvents().map((event) => ({
      status: event.status,
      attempt_no: event.attempt_no,
      scheduled_window: event.scheduled_window,
      natural_schedule: event.natural_schedule,
    }))).toEqual([
      { status: 'scheduled', attempt_no: 0, scheduled_window: '2026-07-13T14:30+08:00', natural_schedule: true },
      { status: 'attempted', attempt_no: 1, scheduled_window: '2026-07-13T14:30+08:00', natural_schedule: true },
      { status: 'sent', attempt_no: 1, scheduled_window: '2026-07-13T14:30+08:00', natural_schedule: true },
    ])
  })

  it('reuses the natural primary request id and records 14:40 after the primary send fails', async () => {
    const net = fakeNetwork([429, 429, 200], { backend: 'success' })
    const withBackend = { ...env, FUND_API_BASE: 'https://api.test' }

    await expect(run(withBackend, false, monday1430)).rejects.toThrow('serverchan_http_error_http_429')
    await expect(run(withBackend, false, monday1440)).resolves.toMatchObject({ status: 'sent' })

    expect(net.getState().sent_slots).toEqual(['14:40'])
    expect(net.getDecisionBodies().map((body) => body.request_id)).toEqual([
      'natural-2026-07-13-primary',
      'natural-2026-07-13-primary',
    ])
    const events = net.getNotificationEvents()
    expect(events.map((event) => event.status)).toEqual([
      'scheduled', 'attempted', 'failed', 'scheduled', 'attempted', 'compensated',
    ])
    expect(events.slice(0, 3).every((event) => event.scheduled_window === '2026-07-13T14:30+08:00')).toBe(true)
    expect(events.slice(3).every((event) => event.scheduled_window === '2026-07-13T14:40+08:00')).toBe(true)
    expect(net.getOutcomeSettlements()).toBe(1)
  })

  it('skips the compensation window after a successful primary send', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    const withBackend = { ...env, FUND_API_BASE: 'https://api.test' }
    await run(withBackend, false, monday1430)

    await expect(run(withBackend, false, monday1440)).resolves.toEqual({ status: 'skipped', reason: 'already_sent' })

    expect(net.getSends()).toBe(1)
    expect(net.getNotificationEvents().map((event) => event.status)).toEqual([
      'scheduled', 'attempted', 'sent', 'skipped',
    ])
    expect(net.getNotificationEvents()[3]).toMatchObject({
      scheduled_window: '2026-07-13T14:40+08:00', attempt_no: 0, natural_schedule: true,
    })
  })

  it('fails closed after backend timeout because no notification claim can be created', async () => {
    const net = fakeNetwork([200], { backend: 'timeout' })
    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .rejects.toThrow('无法建立通知幂等事件')
    expect(net.getState()).toMatchObject({
      decision_status: 'degraded', last_http_status: 503, last_error: 'decision_snapshot_unavailable',
    })
    expect(net.getSends()).toBe(0)
  })

  it('settles outcomes only at natural 14:30 and keeps notification alive on settlement failure', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => (
      String(input).includes('/api/v2/outcomes/settle')
        ? new Response('temporarily unavailable', { status: 503 })
        : original(input, init)
    ))

    const result = await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)

    expect(result).toMatchObject({ status: 'sent_with_warning', outcome_settlement: null })
    expect(result.warning).toContain('决策结果结算暂不可用: HTTP 503')
    expect(net.getSends()).toBe(1)
    expect(net.fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/v2/outcomes/settle')))
      .toHaveLength(1)
  })

  it('does not send or mark the slot sent when WORKER_TOKEN is missing', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    await expect(run({ ...env, FUND_API_BASE: 'https://api.test', WORKER_TOKEN: '' }, false, monday1430))
      .rejects.toThrow('WORKER_TOKEN 未配置')
    expect(net.getSends()).toBe(0)
    expect(net.getState()).toMatchObject({ decision_status: 'degraded', last_http_status: null })
    expect(net.getState().sent_slots).toEqual([])
  })

  it('does not send or mark the slot sent when backend authentication fails', async () => {
    const net = fakeNetwork([200], { backend: 'unauthorized' })
    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .rejects.toThrow('鉴权失败')
    expect(net.getSends()).toBe(0)
    expect(net.getState()).toMatchObject({ decision_status: 'degraded', last_http_status: 401 })
    expect(net.getState().sent_slots).toEqual([])
  })

  it('fails closed on a backend 425 without falling back to an estimate-only push', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => (
      String(input).includes('/api/v2/portfolio/decisions')
        ? new Response('still processing', { status: 425 })
        : original(input, init)
    ))

    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .rejects.toThrow('幂等冲突: HTTP 425')
    expect(net.getSends()).toBe(0)
    expect(net.getState()).toMatchObject({ sent_slots: [], last_http_status: 425 })
  })

  it('rejects a malformed successful decision response and does not send', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => (
      String(input).includes('/api/v2/portfolio/decisions')
        ? Response.json({ complete: true, decisions: [] })
        : original(input, init)
    ))

    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .rejects.toThrow('组合决策响应格式无效')
    expect(net.getSends()).toBe(0)
    expect(net.getState()).toMatchObject({ sent_slots: [], last_http_status: 502 })
  })

  it('requires an explicit successful attempted claim before sending', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    const original = net.fetchMock.getMockImplementation()!
    net.fetchMock.mockImplementation(async (input, init) => {
      const response = await original(input, init)
      if (!String(input).includes('/api/v2/notifications/events')) return response
      const request = JSON.parse(String(init?.body))
      if (request.status !== 'attempted') return response
      const payload = await response.json() as { events: Array<Record<string, unknown>> }
      return Response.json({
        ...payload,
        events: payload.events.map((row) => ({ ...row, claimed: false, duplicate: true })),
      })
    })

    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .resolves.toMatchObject({
        status: 'skipped', reason: 'notification_already_claimed',
        outcome_settlement: { settled: 0, pending: 0, errors: [] },
      })
    expect(net.getSends()).toBe(0)
    expect(net.getState().sent_slots).toEqual([])
  })

  it('separates deterministic natural request ids from manual test request ids', async () => {
    let net = fakeNetwork([200], { backend: 'success' })
    await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)
    expect(net.getDecisionBody()).toMatchObject({ request_id: 'natural-2026-07-13-primary' })

    vi.unstubAllGlobals()
    net = fakeNetwork([200], { backend: 'success' })
    await run({ ...env, FUND_API_BASE: 'https://api.test' }, true, monday1430)
    expect(net.getDecisionBody()).toMatchObject({ request_id: 'manual-2026-07-13-143000' })
    expect(net.getOutcomeSettlements()).toBe(0)
  })

  it('does not calculate partial portfolio weights when a held fund has no NAV', async () => {
    const net = fakeNetwork([200], {
      backend: 'success',
      missingNav: ['000002'],
      officialFails: true,
      watchEntries: [
        { code: '000001', name: '一号', shares: 100 },
        { code: '000002', name: '二号', shares: 100 },
      ],
    })
    await expect(run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430))
      .rejects.toThrow('无法建立通知幂等事件')
    expect(net.fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v2/portfolio/decisions'))).toBe(false)
    expect(net.getState()).toMatchObject({
      decision_status: 'degraded', last_error: 'decision_snapshot_unavailable',
    })
    expect(net.getSends()).toBe(0)
  })

  it('reports a Gist read failure without attempting a push', async () => {
    const net = fakeNetwork([200], { gistReadFails: true })
    await expect(run(env, false, monday1430)).rejects.toThrow('http_5xx')
    expect(net.getSends()).toBe(0)
  })

  it('skips weekends without network access', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await run(env, false, new Date('2026-07-11T06:30:00Z'))).reason).toBe('weekend')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('protects the force test endpoint with ADMIN_TOKEN', async () => {
    const response = await worker.fetch(new Request('https://worker.test/test', { method: 'POST' }), env)
    expect(response.status).toBe(401)
  })

  it('health exposes runtime state without secret values', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WORKER_BUILD_SHA', buildSha)
    vi.setSystemTime(monday1430)
    fakeNetwork()
    await runScheduled(env, monday1430)
    const response = await worker.fetch(new Request('https://worker.test/health'), env)
    const body = await response.json() as { runtime: Record<string, unknown>; version: string; build_sha: string }
    expect(response.status).toBe(200)
    expect(body.version).toBe('8.0.0')
    expect(body.build_sha).toBe(buildSha)
    expect(body.runtime).toMatchObject({
      state_available: true,
      last_cron_at: '2026-07-13T14:30:00+08:00',
      last_cron_build_sha: buildSha,
      last_cron_result: 'sent',
      last_cron_reason: null,
      last_attempt_at: '2026-07-13T14:30:00+08:00',
      sent_today: true,
    })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('gist-token')
    expect(serialized).not.toContain('send-key')
    expect(serialized).not.toContain('worker-token')

    const tuesday1430 = new Date('2026-07-14T06:30:00Z')
    vi.setSystemTime(tuesday1430)
    await expect(runScheduled(env, tuesday1430)).resolves.toMatchObject({
      status: 'skipped', reason: 'official_nav_only',
    })
    const nextDay = await (await worker.fetch(new Request('https://worker.test/health'), env)).json() as {
      runtime: Record<string, unknown>
    }
    expect(nextDay.runtime.sent_today).toBe(false)
    expect(nextDay.runtime.state_date).toBe('2026-07-14')
    expect(nextDay.runtime.attempt_count).toBe(0)
    expect(nextDay.runtime.last_success_at).toBe('2026-07-13T14:30:00+08:00')
    expect(nextDay.runtime.last_cron_at).toBe('2026-07-14T14:30:00+08:00')
    expect(nextDay.runtime.last_cron_result).toBe('skipped')
  })

  it('serves trusted-origin health through a short cache and restricts methods', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    const net = fakeNetwork()
    const healthEnv = { ...env, GIST_ID: 'gist-health-cache' }
    const request = () => new Request('https://worker.test/health', {
      headers: { Origin: 'https://aureliuswu.github.io' },
    })

    const first = await worker.fetch(request(), healthEnv)
    const second = await worker.fetch(request(), healthEnv)
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('https://aureliuswu.github.io')
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=30')
    expect(second.status).toBe(200)
    expect(net.fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes('/gists/gist-health-cache') && (!init?.method || init.method === 'GET')
    ))).toHaveLength(1)

    const head = await worker.fetch(new Request('https://worker.test/health', { method: 'HEAD' }), healthEnv)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const post = await worker.fetch(new Request('https://worker.test/health', { method: 'POST' }), healthEnv)
    expect(post.status).toBe(405)
    expect(post.headers.get('Allow')).toBe('GET, HEAD, OPTIONS')
  })

  it('returns only stable health error codes for malformed state and upstream failures', async () => {
    const secret = 'https://api.github.test/gists/private?token=secret'
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('gist-health-invalid')) {
        return Response.json({ files: { 'sinan-estimate-state.json': { content: `{${secret}` } } })
      }
      throw new Error(secret)
    })
    vi.stubGlobal('fetch', fetchMock)

    const invalid = await (await worker.fetch(
      new Request('https://worker.test/health'), { ...env, GIST_ID: 'gist-health-invalid' },
    )).json() as { runtime: Record<string, unknown> }
    const failed = await (await worker.fetch(
      new Request('https://worker.test/health'), { ...env, GIST_ID: 'gist-health-upstream' },
    )).json() as { runtime: Record<string, unknown> }

    expect(invalid.runtime).toEqual({ state_available: false, last_error: 'json_invalid' })
    expect(failed.runtime).toEqual({ state_available: false, last_error: 'network_error' })
    expect(JSON.stringify([invalid, failed])).not.toContain(secret)
  })

  it('serves a bounded CORS estimate batch without exposing secrets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    fakeNetwork()
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001,000002', {
      headers: { Origin: 'https://aureliuswu.github.io' },
    }), env)
    const body = await response.json() as {
      status: string; returned: number; items: Array<Record<string, unknown>>
      accounting: Record<string, number>
    }
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://aureliuswu.github.io')
    expect(body.status).toBe('ok')
    expect(body.returned).toBe(2)
    expect(body.accounting).toEqual({ primary: 2, model: 0, official: 0, unavailable: 0 })
    expect(Object.values(body.accounting).reduce((sum, value) => sum + value, 0)).toBe(2)
    expect(body.items[0]).toMatchObject({
      code: '000001', kind: 'intraday_estimate', value_change: null, nav_date: null, estimate_change: 1,
      estimate_time: '2026-07-13T14:29:00+08:00',
      est_change: 1, source_time_precision: 'datetime', status: 'fresh',
      source: 'eastmoney_estimate_table',
    })
  })

  it('coalesces untrusted estimate origins without regressing trusted CORS', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    fakeNetwork()
    const edge = stubEdgeCache()
    const endpoint = 'https://worker.test/estimates?codes=000001,000002'

    const first = await worker.fetch(new Request(endpoint, {
      headers: { Origin: 'https://random-one.invalid' },
    }), env, edge.ctx)
    await edge.drain()
    const second = await worker.fetch(new Request(endpoint, {
      headers: { Origin: 'https://random-two.invalid' },
    }), env, edge.ctx)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(edge.entries.size).toBe(1)
    expect([...edge.entries.keys()].map((key) => new URL(key).searchParams.get('origin')))
      .toEqual(['anonymous'])
    expect([...edge.entries.keys()].join('|')).not.toContain('random-')

    const trusted = await worker.fetch(new Request(endpoint, {
      headers: { Origin: 'https://aureliuswu.github.io' },
    }), env, edge.ctx)
    await edge.drain()
    expect(trusted.headers.get('Access-Control-Allow-Origin')).toBe('https://aureliuswu.github.io')
    expect(new Set([...edge.entries.keys()].map((key) => new URL(key).searchParams.get('origin'))))
      .toEqual(new Set(['anonymous', 'https://aureliuswu.github.io']))
  })

  it('keeps a fresh estimate-table row ahead of all fallback sources', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    const net = fakeModelNetwork({ freshPrimary: true })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=005844'), env)
    const body = await response.json() as { items: Array<Record<string, unknown>>; accounting: Record<string, number> }
    expect(body.items[0]).toMatchObject({ kind: 'intraday_estimate', status: 'fresh', source: 'eastmoney_estimate_table' })
    expect(net.fetchMock.mock.calls.some(([input]) => String(input).includes('/f10/lsjz'))).toBe(false)
    expect(net.fetchMock.mock.calls.some(([input]) => String(input).includes('/FundArchivesDatas.aspx'))).toBe(false)
  })

  it('uses one holdings-model contract for the public endpoint and scheduled decision context', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    let net = fakeModelNetwork()
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=005844'), env)
    const body = await response.json() as { items: Array<Record<string, unknown>>; accounting: Record<string, number> }
    expect(body.items[0]).toMatchObject({
      kind: 'holdings_model', status: 'modeled', source: 'eastmoney_holdings_model',
      base_nav: 1.02, base_nav_date: '2026-07-12', value_date: '2026-07-13',
      model_coverage: 60, model_quote_count: 6, model_report_date: '2026-06-30',
      source_time_precision: 'datetime',
    })
    expect(body.accounting).toEqual({ primary: 0, model: 1, official: 0, unavailable: 0 })

    vi.unstubAllGlobals()
    net = fakeModelNetwork()
    const result = await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)
    expect(result).toMatchObject({ status: 'sent', fresh: false, modeled: 1, funds: 1 })
    const decision = net.getDecisionBody() as { items: Array<Record<string, unknown>> }
    expect(decision.items[0].estimate_context).toMatchObject({
      status: 'modeled', kind: 'holdings_model', source: 'eastmoney_holdings_model',
      source_time: '2026-07-13T14:29:00+08:00', estimate_time: '2026-07-13T14:29:00+08:00',
      source_time_precision: 'datetime', value_change: null, nav_date: null,
      model_coverage: 60, model_quote_count: 6,
      model_oldest_quote_time: '2026-07-13T14:29:00+08:00',
      model_newest_quote_time: '2026-07-13T14:29:00+08:00',
    })
  })

  it('does not apply the generic holdings model to QDII and skips official-only scheduled data', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    const net = fakeModelNetwork({ qdii: true })
    await expect(runScheduled(env, monday1430)).resolves.toMatchObject({
      status: 'skipped', reason: 'official_nav_only',
    })
    expect(net.fetchMock.mock.calls.some(([input]) => String(input).includes('/FundArchivesDatas.aspx'))).toBe(false)
    expect(net.fetchMock.mock.calls.some(([input]) => String(input).includes('/api/qt/ulist.np/get'))).toBe(false)
    expect(net.getState()).toMatchObject({ last_cron_result: 'skipped', last_cron_reason: 'official_nav_only' })
  })

  it('falls back per fund when only one estimate row is stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    fakeNetwork([200], {
      estimateDates: { '000002': '2026-07-12' },
      officialDates: ['2026-07-11', '2026-07-10'],
    })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001,000002'), env)
    const body = await response.json() as {
      status: string
      source: string
      items: Array<Record<string, unknown>>
    }

    expect(response.status).toBe(200)
    expect(body.status).toBe('degraded')
    expect(body.source).toBe('eastmoney_mixed')
    expect(body.items[0]).toMatchObject({
      code: '000001', status: 'fresh', value_change: null, nav_date: null,
      estimate_change: 1, estimate_time: '2026-07-13T14:29:00+08:00', est_change: 1,
    })
    expect(body.items[1]).toMatchObject({
      code: '000002', status: 'latest_official', source: 'eastmoney_official_nav',
      fallback_reason: 'estimate_stale', value_change: 2, nav_date: '2026-07-11',
      estimate_change: null, est_time: '2026-07-11', est_change: null,
    })
  })

  it('falls back when an estimate is dated today but its numeric values are incomplete', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    fakeNetwork([200], { missingNav: ['000001'], missingSecond: true })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001'), env)
    const body = await response.json() as { items: Array<Record<string, unknown>> }

    expect(response.status).toBe(200)
    expect(body.items[0]).toMatchObject({
      code: '000001', status: 'latest_official', source: 'eastmoney_official_nav',
      fallback_reason: 'estimate_incomplete', last_nav: 1, value_nav: 1.02, value_change: 2,
      estimate_nav: null, estimate_change: null, est_nav: null, est_change: null,
    })
  })

  it('keeps a current but incomplete estimate out of legacy items if fallback also fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    fakeNetwork([200], { missingNav: ['000001'], missingSecond: true, officialFails: true })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001'), env)
    const body = await response.json() as {
      items: Array<Record<string, unknown>>
      unavailable_items: Array<Record<string, unknown>>
    }

    expect(response.status).toBe(200)
    expect(body.items).toEqual([])
    expect(body.unavailable_items[0]).toMatchObject({
      code: '000001', status: 'unavailable', fallback_reason: 'estimate_incomplete',
      last_nav: null, est_nav: null, est_change: null,
    })
  })

  it('does not present a weekend estimate table row as current data', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T06:30:00Z'))
    fakeNetwork([200], {
      estimateDates: { '000001': '2026-07-10' },
      officialDates: ['2026-07-10', '2026-07-09'],
    })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001'), env)
    const body = await response.json() as { items: Array<Record<string, unknown>> }

    expect(response.status).toBe(200)
    expect(body.items[0]).toMatchObject({
      status: 'latest_official', source: 'eastmoney_official_nav', est_time: '2026-07-10',
    })
  })

  it('reports unavailable funds separately without putting null numerics in legacy items', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(monday1430)
    fakeNetwork([200], {
      estimateDates: { '000001': '2026-07-12' },
      officialFails: true,
      missingSecond: true,
    })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001'), env)
    const body = await response.json() as {
      status: string
      returned: number
      unavailable: number
      items: Array<Record<string, unknown>>
      unavailable_codes: string[]
      unavailable_items: Array<Record<string, unknown>>
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'unavailable', returned: 0, unavailable: 1 })
    expect(body.items).toEqual([])
    expect(body.unavailable_codes).toEqual(['000001'])
    expect(body.unavailable_items[0]).toMatchObject({
      code: '000001', status: 'unavailable', source: 'unavailable',
      est_nav: null, est_change: null, fallback_reason: 'estimate_stale',
    })
  })

  it('rejects invalid or oversized public estimate batches', async () => {
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=bad'), env)
    expect(response.status).toBe(400)
  })

  it('returns unavailable diagnostics when all valuation upstreams are unavailable', async () => {
    fakeNetwork([200], { estimateFails: true, officialFails: true })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001'), env)
    expect(response.status).toBe(200)
    const body = await response.json() as { status: string; items: unknown[]; unavailable_items: Array<Record<string, unknown>> }
    expect(body.status).toBe('unavailable')
    expect(body.items).toEqual([])
    expect(body.unavailable_items[0]).toMatchObject({ status: 'unavailable', source: 'unavailable' })
  })

  it('falls back to the latest official NAV move when the estimate table closes', async () => {
    fakeNetwork([200], { estimateFails: true })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001'), env)
    const body = await response.json() as {
      fallback: string
      items: Array<Record<string, unknown>>
    }
    expect(response.status).toBe(200)
    expect(body.fallback).toBe('official_nav')
    expect(body.items[0]).toMatchObject({
      code: '000001',
      last_nav: 1,
      value_nav: 1.02,
      value_change: 2,
      estimate_nav: null,
      estimate_change: null,
      est_nav: null,
      est_change: null,
      nav_date: '2026-07-12',
      est_time: '2026-07-12',
      est_label: '最近净值',
      est_kind: 'official_nav',
      est_realtime: false,
      source: 'eastmoney_official_nav',
    })
  })

  it('serves fund holdings through the CORS proxy with disclosure metadata', async () => {
    fakeNetwork()
    const response = await worker.fetch(new Request('https://worker.test/holdings?code=005844', {
      headers: { Origin: 'https://aureliuswu.github.io' },
    }), env)
    const body = await response.json() as {
      status: string
      report_date: string
      items: Array<Record<string, unknown>>
    }
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://aureliuswu.github.io')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=1800')
    expect(body.status).toBe('ok')
    expect(body.report_date).toBe('2026-06-30')
    expect(body.items[0]).toEqual({ code: '688361', name: '中科飞测', ratio: 9.55 })
  })

  it('coalesces untrusted holdings origins without regressing trusted CORS', async () => {
    fakeNetwork()
    const edge = stubEdgeCache()
    const endpoint = 'https://worker.test/holdings?code=005844'

    await worker.fetch(new Request(endpoint, {
      headers: { Origin: 'https://random-one.invalid' },
    }), env, edge.ctx)
    await edge.drain()
    const second = await worker.fetch(new Request(endpoint, {
      headers: { Origin: 'https://random-two.invalid' },
    }), env, edge.ctx)

    expect(second.status).toBe(200)
    expect(edge.entries.size).toBe(1)
    expect([...edge.entries.keys()].map((key) => new URL(key).searchParams.get('origin')))
      .toEqual(['anonymous'])
    expect([...edge.entries.keys()].join('|')).not.toContain('random-')

    const trusted = await worker.fetch(new Request(endpoint, {
      headers: { Origin: 'http://localhost:5173' },
    }), env, edge.ctx)
    await edge.drain()
    expect(trusted.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(new Set([...edge.entries.keys()].map((key) => new URL(key).searchParams.get('origin'))))
      .toEqual(new Set(['anonymous', 'http://localhost:5173']))
  })

  it('rejects an invalid holdings fund code', async () => {
    const response = await worker.fetch(new Request('https://worker.test/holdings?code=bad'), env)
    expect(response.status).toBe(400)
  })

  it('reports an upstream holdings failure instead of returning an empty disclosure', async () => {
    fakeNetwork([200], { holdingsFails: true })
    const response = await worker.fetch(new Request('https://worker.test/holdings?code=005844'), env)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('holdings_upstream_failed')
  })

  it('serves normalized Tencent and Eastmoney quotes through fixed upstreams', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T07:31:00Z'))
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'qt.gtimg.cn') {
        expect(url.pathname).toBe('/')
        expect(url.searchParams.get('q')).toBe('usIXIC,sh000001')
        expect(new Headers(init?.headers).get('Referer')).toBe('https://gu.qq.com/')
        return new Response([
          tencentQuoteRow('usIXIC', {
            price: 21100, previousClose: 21000, change: 0.48, timestamp: '2026-08-28 15:30:00',
          }),
          tencentQuoteRow('sh000001', { price: 3800, previousClose: 3780, change: 0.53 }),
        ].join('\n'))
      }
      if (url.hostname === 'push2.eastmoney.com') {
        expect(url.pathname).toBe('/api/qt/ulist.np/get')
        expect(url.searchParams.get('secids')).toBe('118.AU9999,113.AU9999,114.AU9999')
        expect(new Headers(init?.headers).get('Referer')).toBe('https://quote.eastmoney.com/')
        return Response.json({ data: { diff: [{
          f12: 'AU9999', f2: 811.2, f3: -0.2, f124: Date.parse('2026-08-28T07:30:00Z') / 1000,
        }] } })
      }
      throw new Error(`unexpected fixed upstream ${url.hostname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await worker.fetch(new Request(
      'https://worker.test/quotes?codes=usIXIC,sh000001,AU9999',
      { headers: { Origin: 'https://aureliuswu.github.io' } },
    ), env)
    const body = await response.json() as {
      status: string; source: string; requested: number; returned: number
      unavailable_codes: string[]; errors: unknown[]; items: Array<Record<string, unknown>>
    }
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://aureliuswu.github.io')
    expect(body).toMatchObject({
      status: 'ok', source: 'mixed', requested: 3, returned: 3,
      unavailable_codes: [], errors: [],
    })
    expect(body.items).toEqual([
      expect.objectContaining({ code: 'usIXIC', price: 21100, change_pct: 0.48, source: 'tencent', status: 'fresh' }),
      expect.objectContaining({ code: 'sh000001', price: 3800, change_pct: 0.53, source: 'tencent', status: 'fresh' }),
      expect.objectContaining({ code: 'AU9999', price: 811.2, change_pct: -0.2, source: 'eastmoney', status: 'fresh' }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      label: 'malformed payload',
      reply: async () => new Response('not a Tencent assignment'),
      reason: 'schema_invalid', upstreamStatus: null, calls: 1,
    },
    {
      label: 'timeout',
      reply: async () => { throw new DOMException('private timeout detail', 'TimeoutError') },
      reason: 'network_timeout', upstreamStatus: null, calls: 2,
    },
    {
      label: '404',
      reply: async () => new Response('private not found body', { status: 404 }),
      reason: 'http_4xx', upstreamStatus: 404, calls: 1,
    },
    {
      label: '429',
      reply: async () => new Response('private rate limit body', { status: 429 }),
      reason: 'http_429', upstreamStatus: 429, calls: 2,
    },
    {
      label: '5xx',
      reply: async () => new Response('private server body', { status: 503 }),
      reason: 'http_5xx', upstreamStatus: 503, calls: 2,
    },
    {
      label: 'oversize',
      reply: async () => new Response('x', { headers: { 'Content-Length': '300000' } }),
      reason: 'response_too_large', upstreamStatus: null, calls: 1,
    },
  ])('normalizes $label quote failures without leaking upstream details', async ({
    reply, reason, upstreamStatus, calls,
  }) => {
    const fetchMock = vi.fn(reply)
    vi.stubGlobal('fetch', fetchMock)
    const response = await worker.fetch(new Request('https://worker.test/quotes?codes=usIXIC'), env)
    const body = await response.json() as {
      status: string; items: unknown[]; unavailable_codes: string[]
      errors: Array<Record<string, unknown>>
    }
    expect(response.status).toBe(200)
    expect(body.status).toBe('unavailable')
    expect(body.items).toEqual([])
    expect(body.unavailable_codes).toEqual(['usIXIC'])
    expect(body.errors).toEqual([{
      source: 'tencent', reason, upstream_status: upstreamStatus, codes: ['usIXIC'],
    }])
    expect(JSON.stringify(body)).not.toContain('private')
    expect(JSON.stringify(body)).not.toContain('qt.gtimg.cn')
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })

  it('marks severely stale quotes and removes their change percentage', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T07:31:00Z'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(tencentQuoteRow('usIXIC', {
      price: 20000, previousClose: 19000, change: 5.26, timestamp: '20260801093000',
    }))))
    const response = await worker.fetch(new Request('https://worker.test/quotes?codes=usIXIC'), env)
    const body = await response.json() as { status: string; items: Array<Record<string, unknown>> }
    expect(body.status).toBe('degraded')
    expect(body.items[0]).toMatchObject({
      code: 'usIXIC', price: 20000, change_pct: null,
      source_time: '2026-08-01 09:30:00', status: 'stale',
    })
  })

  it('reports a well-formed but unavailable quote without inventing zero values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('v_usIXIC="";')))
    const response = await worker.fetch(new Request('https://worker.test/quotes?codes=usIXIC'), env)
    const body = await response.json() as {
      status: string; items: unknown[]; unavailable_codes: string[]; errors: Array<Record<string, unknown>>
    }
    expect(body).toMatchObject({ status: 'unavailable', items: [], unavailable_codes: ['usIXIC'] })
    expect(body.errors).toEqual([{
      source: 'tencent', reason: 'upstream_empty', upstream_status: null, codes: ['usIXIC'],
    }])
    expect(JSON.stringify(body)).not.toMatch(/"(?:price|change_pct)":0/)
  })

  it('rejects illegal, duplicate or oversized quote code lists before any fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const requests = [
      'https://worker.test/quotes?codes=https%3A%2F%2Fevil.test',
      'https://worker.test/quotes?codes=usIXIC,usIXIC',
      `https://worker.test/quotes?codes=${Array.from({ length: 51 }, (_, index) => `usA${index}`).join(',')}`,
    ]
    for (const request of requests) {
      expect((await worker.fetch(new Request(request), env)).status).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
