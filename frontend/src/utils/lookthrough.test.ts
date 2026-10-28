import { afterEach, describe, expect, it, vi } from 'vitest'

const getHoldingsMock = vi.hoisted(() => vi.fn())

vi.mock('./holdings', () => ({
  getHoldings: getHoldingsMock,
}))

describe('computeLookthrough', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
    getHoldingsMock.mockReset()
  })

  function mockFetchByCode(data: Record<string, unknown | null>) {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const code = (url.match(/enrich\/([^/.]+)\.json/) || [])[1]
      const body = data[code]
      if (!body) return Promise.resolve({ ok: false, json: vi.fn() })
      return Promise.resolve({ ok: true, json: vi.fn().mockResolvedValue(body) })
    }))
  }

  function enrich(code: string, data: Record<string, unknown>) {
    return {
      schema_version: 2,
      code,
      source: 'akshare_eastmoney',
      fetched_at: '2026-08-12T10:00:00+08:00',
      holdings_as_of: '2026-06-30',
      industries_as_of: '2026-06-30',
      ...data,
    }
  }

  it('aggregates stock and industry exposure from enrich data', async () => {
    mockFetchByCode({
      F1: enrich('F1', {
        holdings: [
          { code: '600001', name: '股票A', ratio: 10 },
          { code: '600002', name: '股票B', ratio: 5 },
        ],
        industries: [{ name: '信息技术', ratio: 60 }],
      }),
      F2: enrich('F2', {
        holdings: [
          { code: '600001', name: '股票A', ratio: 20 },
          { code: '600003', name: '股票C', ratio: 10 },
        ],
        industries: [{ name: '信息技术', ratio: 30 }],
      }),
    })
    const { computeLookthrough } = await import('./lookthrough')

    const r = await computeLookthrough([
      { code: 'F1', name: '基金1', value: 1000 },
      { code: 'F2', name: '基金2', value: 500 },
    ])

    expect(r.source).toBe('enrich')
    expect(r.totalValue).toBe(1500)
    expect(r.coveredValue).toBe(1500)
    expect(r.industryCoveredValue).toBe(1500)
    expect(r.stocks[0]).toMatchObject({ code: '600001', value: 200, funds: 2 })
    expect(r.stocks[0].pct).toBeCloseTo(13.3333)
    expect(r.industries[0]).toMatchObject({ name: '信息技术', value: 750 })
    expect(r.industries[0].pct).toBeCloseTo(50)
    expect(getHoldingsMock).not.toHaveBeenCalled()
    expect(r.stockDisclosureDates).toEqual(['2026-06-30'])
    expect(r.industryDisclosureDates).toEqual(['2026-06-30'])
    expect(r.hasUndatedStockFallback).toBe(false)
  })

  it('falls back to top10 holdings when enrich data is missing', async () => {
    mockFetchByCode({})
    getHoldingsMock.mockResolvedValue([
      { code: '600001', name: '股票A', ratio: 10 },
      { code: '600002', name: '股票B', ratio: 5 },
    ])
    const { computeLookthrough } = await import('./lookthrough')

    const r = await computeLookthrough([{ code: 'F1', name: '基金1', value: 1000 }])

    expect(r.source).toBe('top10')
    expect(r.coveredValue).toBe(1000)
    expect(r.industryCoveredValue).toBe(0)
    expect(r.stocks.map((s) => s.code)).toEqual(['600001', '600002'])
    expect(r.stocks[0].value).toBeCloseTo(100)
    expect(r.stocks[0].pct).toBeCloseTo(10)
    expect(r.stockDisclosureDates).toEqual([])
    expect(r.hasUndatedStockFallback).toBe(true)
  })

  it('marks mixed source when enrich and top10 are both used', async () => {
    mockFetchByCode({
      F1: enrich('F1', {
        holdings: [{ code: '600001', name: '股票A', ratio: 10 }],
        industries: [],
      }),
    })
    getHoldingsMock.mockResolvedValue([{ code: '600002', name: '股票B', ratio: 20 }])
    const { computeLookthrough } = await import('./lookthrough')

    const r = await computeLookthrough([
      { code: 'F1', name: '基金1', value: 1000 },
      { code: 'F2', name: '基金2', value: 500 },
    ])

    expect(r.source).toBe('mixed')
    expect(r.coveredValue).toBe(1500)
    expect(r.stocks.map((s) => s.code)).toEqual(['600001', '600002'])
    expect(r.stockDisclosureDates).toEqual(['2026-06-30'])
    expect(r.hasUndatedStockFallback).toBe(true)
  })

  it('returns none source when no fund has holdings data', async () => {
    mockFetchByCode({})
    getHoldingsMock.mockResolvedValue([])
    const { computeLookthrough } = await import('./lookthrough')

    const r = await computeLookthrough([{ code: 'F1', name: '基金1', value: 1000 }])

    expect(r.source).toBe('none')
    expect(r.coveredValue).toBe(0)
    expect(r.stocks).toEqual([])
    expect(r.industries).toEqual([])
  })

  it('handles empty portfolio without division by zero', async () => {
    mockFetchByCode({})
    const { computeLookthrough } = await import('./lookthrough')

    const r = await computeLookthrough([])

    expect(r.totalValue).toBe(0)
    expect(r.coveredValue).toBe(0)
    expect(r.source).toBe('none')
    expect(r.stocks).toEqual([])
    expect(r.stockDisclosureDates).toEqual([])
    expect(r.industryDisclosureDates).toEqual([])
    expect(r.hasUndatedStockFallback).toBe(false)
  })

  it('rejects wrong code, stale disclosure and missing schema, then falls back', async () => {
    mockFetchByCode({
      F1: enrich('OTHER', { holdings: [{ code: '600001', name: '股票A', ratio: 10 }], industries: [] }),
      F2: enrich('F2', { holdings_as_of: '2020-01-01', holdings: [{ code: '600002', name: '股票B', ratio: 10 }], industries: [] }),
      F3: { code: 'F3', holdings: [{ code: '600003', name: '股票C', ratio: 10 }], industries: [] },
    })
    getHoldingsMock.mockResolvedValue([{ code: '600009', name: '正式前十大', ratio: 5 }])
    const { computeLookthrough } = await import('./lookthrough')

    const result = await computeLookthrough([
      { code: 'F1', name: '基金1', value: 100 },
      { code: 'F2', name: '基金2', value: 100 },
      { code: 'F3', name: '基金3', value: 100 },
    ])

    expect(result.source).toBe('top10')
    expect(result.stocks.map((row) => row.code)).toEqual(['600009'])
    expect(getHoldingsMock).toHaveBeenCalledTimes(3)
  })

  it('does not permanently cache a transient enrich failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: vi.fn() })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(enrich('F1', {
        holdings: [{ code: '600001', name: '股票A', ratio: 10 }], industries: [],
      })) })
    vi.stubGlobal('fetch', fetchMock)
    getHoldingsMock.mockResolvedValue([])
    const { computeLookthrough } = await import('./lookthrough')

    expect((await computeLookthrough([{ code: 'F1', name: '基金1', value: 100 }])).source).toBe('none')
    expect((await computeLookthrough([{ code: 'F1', name: '基金1', value: 100 }])).source).toBe('enrich')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects non-empty enrichment without its matching disclosure period', async () => {
    mockFetchByCode({
      F1: enrich('F1', {
        holdings_as_of: null,
        holdings: [{ code: '600001', name: '股票A', ratio: 10 }],
        industries: [],
      }),
    })
    getHoldingsMock.mockResolvedValue([{ code: '600009', name: '前十大回退', ratio: 5 }])
    const { computeLookthrough } = await import('./lookthrough')

    const result = await computeLookthrough([{ code: 'F1', name: '基金1', value: 100 }])

    expect(result.source).toBe('top10')
    expect(result.stockDisclosureDates).toEqual([])
    expect(result.hasUndatedStockFallback).toBe(true)
  })

  it('bounds enrichment body parsing and leaves a timeout retryable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-02T04:00:00Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(() => {}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(enrich('F1', {
        holdings: [{ code: '600001', name: '股票A', ratio: 10 }], industries: [],
      })) })
    vi.stubGlobal('fetch', fetchMock)
    const { loadEnrich } = await import('./lookthrough')
    const pending = loadEnrich('F1')
    await vi.advanceTimersByTimeAsync(6001)
    expect(await pending).toBeNull()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(await loadEnrich('F1')).toMatchObject({ code: 'F1', holdings_as_of: '2026-06-30' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a cancelled enrich response that completes late', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-02T04:00:00Z'))
    let resolveBody!: (value: unknown) => void
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200, json: () => new Promise(resolve => { resolveBody = resolve }),
    }).mockResolvedValueOnce({ ok: false, status: 404 })
    vi.stubGlobal('fetch', fetchMock)
    const { loadEnrich } = await import('./lookthrough')
    const controller = new AbortController()
    const pending = loadEnrich('F1', controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toBeNull()
    resolveBody(enrich('F1', { holdings: [{ code: '600001', name: '股票A', ratio: 10 }], industries: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(await loadEnrich('F1')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('revalidates cached disclosure age instead of keeping an expired success', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-02T04:00:00Z'))
    mockFetchByCode({ F1: enrich('F1', {
      holdings: [{ code: '600001', name: '股票A', ratio: 10 }], industries: [],
    }) })
    const { loadEnrich } = await import('./lookthrough')
    expect(await loadEnrich('F1')).toBeTruthy()
    vi.setSystemTime(new Date('2028-01-03T04:00:00Z'))
    expect(await loadEnrich('F1')).toBeNull()
  })
})
