import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { formatMessage, normalizeEstimate, run, type Env, type Estimate } from './index'

const env: Env = {
  GIST_ID: 'gist', FUND_API_BASE: '', GIST_TOKEN: 'gist-token', WECHAT_SENDKEY: 'send-key',
  ADMIN_TOKEN: 'admin-token', WORKER_TOKEN: 'worker-token',
}
const monday1430 = new Date('2026-07-13T06:30:00Z')
const monday1440 = new Date('2026-07-13T06:40:00Z')

function fakeNetwork(sendStatuses = [200], options: { patchFails?: boolean; missingSecond?: boolean } = {}) {
  let state: Record<string, unknown> = {}
  let sends = 0
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/gists/gist') && (!init?.method || init.method === 'GET')) {
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
    if (url.includes('fundgz.1234567.com.cn')) {
      if (options.missingSecond && url.includes('000002')) return new Response('', { status: 404 })
      const code = url.includes('000002') ? '000002' : '000001'
      return new Response(`jsonpgz({"fundcode":"${code}","name":"基金${code}","dwjz":"1","gsz":"1.01","gszzl":"1","gztime":"2026-07-13 14:30"})`)
    }
    if (url.includes('sctapi.ftqq.com')) {
      const status = sendStatuses[Math.min(sends++, sendStatuses.length - 1)]
      return new Response(status === 200 ? '{"code":0}' : 'rate limited', {
        status, headers: status === 429 ? { 'Retry-After': '0' } : {},
      })
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
    const estimate: Estimate = { code: '000001', name: '测试基金', lastNav: 1, estNav: 1.02, change: 2, time: '2026-07-13 14:30', label: '盘中估值' }
    expect(formatMessage([{ code: '000001' }], new Map([['000001', estimate]]), null)).toContain('+2.00%')
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
    expect(body).not.toContain('gist-token')
    expect(body).not.toContain('send-key')
    expect(body).not.toContain('worker-token')
  })
})
