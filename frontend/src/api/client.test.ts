import { afterEach, describe, expect, it, vi } from 'vitest'
import * as apiClient from './client'
import {
  getV8Decision,
  getV8DecisionDiff,
  getV8Evidence,
  getV8FundOutcomes,
  getV8PortfolioPolicy,
  getV8PortfolioPolicyHistory,
  getV8StrategyPerformance,
  getV8StrategyRegistry,
  request,
} from './client'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('API request resilience', () => {
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
  it('exposes snapshot reads without state-changing query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await getV8Evidence('510300')
    await getV8Decision('510300')
    await getV8DecisionDiff('510300')
    await getV8FundOutcomes('510300')
    await getV8PortfolioPolicy()
    await getV8PortfolioPolicyHistory()
    await getV8StrategyRegistry()
    await getV8StrategyPerformance('decision-v2:test')

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
})
