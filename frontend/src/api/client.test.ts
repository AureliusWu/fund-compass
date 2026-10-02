import { afterEach, describe, expect, it, vi } from 'vitest'
import * as apiClient from './client'
import { clearOwnerSession, loginOwnerSession } from '@/stores/ownerSession'
const SYNTHETIC_TOKEN = 'own_' + 'a'.repeat(43)
import {
  ApiError,
  getV8Decision,
  getV8DecisionDiff,
  getV8Evidence,
  getV8FundOutcomes,
  getV8PortfolioPolicy,
  getV8PortfolioPolicyHistory,
  getV8StrategyPerformance,
  getV8StrategyRegistry,
  getWatchlist,
  request,
} from './client'

afterEach(() => {
  clearOwnerSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('API request resilience', () => {
  it('accepts empty 204 responses without trying to parse JSON', async () => {
    const json = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, json }))
    await expect(request('/empty', { method: 'DELETE' })).resolves.toBeUndefined()
    expect(json).not.toHaveBeenCalled()
  })

  it('does not start a fetch when the caller signal was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(request('/cancelled', { signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not return a response body that completed after cancellation', async () => {
    let finishBody!: (value: unknown) => void
    const body = new Promise(resolve => { finishBody = resolve })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body }))
    const controller = new AbortController()
    const pending = request('/late-body', { signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    await Promise.resolve()
    controller.abort()
    finishBody({ private: 'synthetic' })
    await assertion
  })

  it('enforces its deadline while parsing a response body', async () => {
    vi.useFakeTimers()
    let finishBody!: (value: unknown) => void
    const body = new Promise(resolve => { finishBody = resolve })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body }))
    const pending = request('/late-json', undefined, 100)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(100)
    finishBody({ private: 'synthetic' })
    await assertion
  })

  it('ends promptly at the deadline even when a transport ignores abort', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})))
    const pending = request('/ignores-abort', undefined, 100)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('aborts a request after its deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))

    const pending = request('/slow', undefined, 100)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(100)

    await assertion
  })

  it('preserves HTTP status for failed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    await expect(request('/down')).rejects.toMatchObject({
      kind: 'http',
      status: 503,
    })
  })
})

describe('v8 API contracts', () => {
  it('maps authenticated reads to audited private URLs but keeps public calls anonymous', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: async () => url.endsWith('/owner/session') ? {
        access_token: SYNTHETIC_TOKEN, token_type: 'Bearer', owner_id: 'owner',
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        scopes: ['read_private', 'write_holdings', 'run_personal_analysis'],
      } : { code: '510300' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await loginOwnerSession('synthetic-password')
    await getV8Decision('510300')
    await getWatchlist()
    await apiClient.getStrategyOutcomes()
    await apiClient.getPortfolioOutcomes()
    await apiClient.getHealth()
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      '/api/v2/owner/session', '/api/v2/private/fund/510300/decision', '/api/private/watchlist',
      '/api/private/strategy/outcomes', '/api/private/strategy/portfolio-outcomes', '/api/health',
    ])
    for (const [, init] of fetchMock.mock.calls.slice(1, 5)) {
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${SYNTHETIC_TOKEN}`)
      expect(init.cache).toBe('no-store')
      expect(init.credentials).toBe('omit')
      expect(init.redirect).toBe('error')
    }
    expect(fetchMock.mock.calls[5]?.[1]?.headers).toBeUndefined()
  })

  it('exposes snapshot reads without state-changing query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ available: false, redacted: true }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const reads = await Promise.allSettled([
      getV8Evidence('510300'),
      getV8Decision('510300'),
      getV8DecisionDiff('510300'),
      getV8FundOutcomes('510300'),
      getV8PortfolioPolicy(),
      getV8PortfolioPolicyHistory(),
      getV8StrategyRegistry(),
      getV8StrategyPerformance('decision-v2:test'),
    ])
    expect(reads.every(result => result.status === 'rejected'
      && result.reason instanceof ApiError && result.reason.kind === 'redacted')).toBe(true)

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      '/api/v2/fund/510300/evidence',
      '/api/v2/fund/510300/decision',
      '/api/v2/fund/510300/decision/diff',
      '/api/v2/fund/510300/outcomes',
      '/api/v2/portfolio/policy',
      '/api/v2/portfolio/policy/history',
      '/api/v2/strategy/registry',
      '/api/v2/strategy/decision-v2%3Atest/performance',
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBeUndefined()
      expect(init?.headers).toBeUndefined()
      expect(init?.body).toBeUndefined()
    }
  })

  it('does not export Worker/Admin V8 write clients to browser code', () => {
    expect(apiClient).not.toHaveProperty('postV8WatchlistDecisions')
    expect(apiClient).not.toHaveProperty('postV8PortfolioDecisions')
    expect(apiClient).not.toHaveProperty('postV8PortfolioRebalance')
  })

  it('rejects a redacted owner response instead of treating hidden values as empty or zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: '510300',
        available: false,
        redacted: true,
      }),
    }))

    await expect(getV8Decision('510300')).rejects.toMatchObject({
      message: '私人数据未公开',
      kind: 'redacted',
    })
    await expect(getWatchlist()).rejects.toMatchObject({
      message: '私人数据未公开',
      kind: 'redacted',
    })
  })

  it('maps the fail-closed 403 compatibility boundary to a redacted state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }))

    await expect(getV8Decision('510300')).rejects.toMatchObject({
      message: '私人数据未公开',
      kind: 'redacted',
      status: 403,
    })
    await expect(getWatchlist()).rejects.toMatchObject({
      message: '私人数据未公开',
      kind: 'redacted',
      status: 403,
    })
  })

  it('fails closed when a mixed rollout returns the former full anonymous DTO', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: '510300',
        action: 'buy',
        holding: { shares: 123.45 },
      }),
    }))

    await expect(getV8Decision('510300')).rejects.toMatchObject({
      message: '匿名读取返回了不安全的旧契约',
      kind: 'http',
      status: 502,
    })
  })
})
