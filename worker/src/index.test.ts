import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { formatMessage, normalizeEstimate, parseFundHoldings, run, type Env, type Estimate } from './index'

const env: Env = {
  GIST_ID: 'gist', FUND_API_BASE: '', GIST_TOKEN: 'gist-token', WECHAT_SENDKEY: 'send-key',
  ADMIN_TOKEN: 'admin-token', WORKER_TOKEN: 'worker-token',
}
const monday1430 = new Date('2026-07-13T06:30:00Z')
const monday1440 = new Date('2026-07-13T06:40:00Z')

function fakeNetwork(sendStatuses = [200], options: {
  patchFails?: boolean; missingSecond?: boolean; gistReadFails?: boolean
    estimateFails?: boolean; officialFails?: boolean; holdingsFails?: boolean
  backend?: 'success' | 'timeout'
} = {}) {
  let state: Record<string, unknown> = {}
  let sends = 0
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/gists/gist') && (!init?.method || init.method === 'GET')) {
      if (options.gistReadFails) return new Response('failed', { status: 502 })
      return Response.json({ files: {
        'sinan-watchlist.json': { content: JSON.stringify([{ code: '000001', name: '一号' }, { code: '000002', name: '二号' }]) },
        'sinan-estimate-state.json': { content: JSON.stringify(state) },
      } })
    }
    if (url.includes('/gists/gist') && init?.method === 'PATCH') {
      if (options.patchFails) return new Response('failed', { status: 500 })
      const body = JSON.parse(String(init.body))
      state = JSON.parse(body.files['sinan-estimate-state.json'].content)
      return Response.json({ ok: true })
    }
    if (url.includes('/FundGuZhi/GetFundGZList')) {
      if (options.estimateFails) return new Response('upstream unavailable', { status: 503 })
      const list = ['000001', ...(options.missingSecond ? [] : ['000002'])].map((code) => ({
        bzdm: code, jjjc: `基金${code}`, dwjz: '1', gsz: '1.01', gszzl: '1%', gxrq: '2026-07-13',
      }))
      return Response.json({ ErrCode: 0, Data: { list } })
    }
    if (url.includes('/f10/lsjz')) {
      if (options.officialFails) return new Response('official unavailable', { status: 503 })
      return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: '2026-07-24', DWJZ: '1.0200', JZZZL: '2.00' },
        { FSRQ: '2026-07-23', DWJZ: '1.0000', JZZZL: '0.50' },
      ] } })
    }
    if (url.includes('/FundArchivesDatas.aspx')) {
      if (options.holdingsFails) return new Response('upstream unavailable', { status: 503 })
      expect(new Headers(init?.headers).get('Referer')).toBe('https://fundf10.eastmoney.com/ccmx_005844.html')
      return new Response(`var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4>
        <table><tbody><tr><td>1</td><td><a>688361</a></td><td><a>中科飞测</a></td>
        <td></td><td></td><td></td><td>9.55%</td></tr></tbody></table>" };`)
    }
    if (url.includes('sctapi.ftqq.com')) {
      const status = sendStatuses[Math.min(sends++, sendStatuses.length - 1)]
      return new Response(status === 200 ? '{"code":0}' : 'rate limited', {
        status, headers: status === 429 ? { 'Retry-After': '0' } : {},
      })
    }
    if (url.includes('/api/portfolio/decisions')) {
      if (options.backend === 'timeout') throw new DOMException('timeout', 'AbortError')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer worker-token')
      const body = JSON.parse(String(init?.body))
      expect(body.request_id).toBe('2026-07-13-14:30')
      return Response.json({ decisions: [{ code: '000001', action: '继续定投', summary: '维持计划' }] })
    }
    throw new Error(`unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { getState: () => state, getSends: () => sends, fetchMock }
}

afterEach(() => vi.unstubAllGlobals())

describe('Cloudflare push worker', () => {
  it('normalizes and formats an estimate', () => {
    const result = normalizeEstimate({ name: '测试基金', dwjz: '1.0', gsz: '1.02', gztime: '2026-07-13 14:30' }, '000001')
    expect(result.change).toBeCloseTo(2)
    const estimate: Estimate = { code: '000001', name: '测试基金', lastNav: 1, estNav: 1.02, change: 2, time: '2026-07-13 14:30', navDate: '2026-07-12', label: '盘中估值' }
    expect(formatMessage([{ code: '000001' }], new Map([['000001', estimate]]), null)).toContain('+2.00%')
  })

  it('keeps null and blank upstream values missing instead of converting them to zero', () => {
    const result = normalizeEstimate({ name: '缺失值基金', dwjz: null, gsz: '', gszzl: '--' }, '000003')
    expect(result.lastNav).toBeNull()
    expect(result.estNav).toBeNull()
    expect(result.change).toBeNull()
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

  it('records persistent 429 and succeeds on the 14:40 compensation', async () => {
    const net = fakeNetwork([429, 429, 200])
    await expect(run(env, false, monday1430)).rejects.toThrow('HTTP 429')
    expect(net.getState().last_http_status).toBe(429)
    expect((await run(env, false, monday1440)).status).toBe('sent')
    expect(net.getState().attempt_count).toBe(2)
    expect(net.getSends()).toBe(3)
  })

  it('fails clearly when Gist state cannot be written and does not send', async () => {
    const net = fakeNetwork([200], { patchFails: true })
    await expect(run(env, false, monday1430)).rejects.toThrow('Gist 状态写入失败')
    expect(net.getSends()).toBe(0)
  })

  it('pushes remaining funds when one estimate is missing', async () => {
    const net = fakeNetwork([200], { missingSecond: true })
    const result = await run(env, false, monday1430)
    expect(result.funds).toBe(1)
    expect(net.getSends()).toBe(1)
  })

  it('runs the mocked Gist to estimate to backend to ServerChan to state chain', async () => {
    const net = fakeNetwork([200], { backend: 'success' })
    const result = await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)
    expect(result.status).toBe('sent')
    expect(net.getState().sent_slots).toEqual(['14:30'])
  })

  it('degrades to estimate-only push when the backend times out', async () => {
    const net = fakeNetwork([200], { backend: 'timeout' })
    expect((await run({ ...env, FUND_API_BASE: 'https://api.test' }, false, monday1430)).status).toBe('sent')
    expect(net.getSends()).toBe(1)
  })

  it('reports a Gist read failure without attempting a push', async () => {
    const net = fakeNetwork([200], { gistReadFails: true })
    await expect(run(env, false, monday1430)).rejects.toThrow('Gist 读取失败')
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
    fakeNetwork()
    const response = await worker.fetch(new Request('https://worker.test/health'), env)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('state_available')
    expect(body).toContain('6.0.3')
    expect(body).not.toContain('gist-token')
    expect(body).not.toContain('send-key')
    expect(body).not.toContain('worker-token')
  })

  it('serves a bounded CORS estimate batch without exposing secrets', async () => {
    fakeNetwork()
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001,000002', {
      headers: { Origin: 'https://aureliuswu.github.io' },
    }), env)
    const body = await response.json() as { returned: number; items: Array<Record<string, unknown>> }
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://aureliuswu.github.io')
    expect(body.returned).toBe(2)
    expect(body.items[0]).toMatchObject({ code: '000001', est_change: 1, source_time_precision: 'date' })
  })

  it('rejects invalid or oversized public estimate batches', async () => {
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=bad'), env)
    expect(response.status).toBe(400)
  })

  it('returns an explicit gateway failure when the estimate upstream is unavailable', async () => {
    fakeNetwork([200], { estimateFails: true, officialFails: true })
    const response = await worker.fetch(new Request('https://worker.test/estimates?codes=000001'), env)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('HTTP 503')
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
      est_nav: 1.02,
      est_change: 2,
      nav_date: '2026-07-23',
      est_time: '2026-07-24',
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

  it('rejects an invalid holdings fund code', async () => {
    const response = await worker.fetch(new Request('https://worker.test/holdings?code=bad'), env)
    expect(response.status).toBe(400)
  })

  it('reports an upstream holdings failure instead of returning an empty disclosure', async () => {
    fakeNetwork([200], { holdingsFails: true })
    const response = await worker.fetch(new Request('https://worker.test/holdings?code=005844'), env)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('HTTP 503')
  })
})
