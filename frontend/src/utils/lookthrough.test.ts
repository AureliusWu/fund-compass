import { afterEach, describe, expect, it, vi } from 'vitest'

const getHoldingsMock = vi.hoisted(() => vi.fn())

vi.mock('./holdings', () => ({
  getHoldings: getHoldingsMock,
}))

describe('computeLookthrough', () => {
  afterEach(() => {
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

  it('aggregates stock and industry exposure from enrich data', async () => {
    mockFetchByCode({
      F1: {
        code: 'F1',
        holdings: [
          { code: 'A', name: '股票A', ratio: 10 },
          { code: 'B', name: '股票B', ratio: 5 },
        ],
        industries: [{ name: '信息技术', ratio: 60 }],
      },
      F2: {
        code: 'F2',
        holdings: [
          { code: 'A', name: '股票A', ratio: 20 },
          { code: 'C', name: '股票C', ratio: 10 },
        ],
        industries: [{ name: '信息技术', ratio: 30 }],
      },
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
    expect(r.stocks[0]).toMatchObject({ code: 'A', value: 200, funds: 2 })
    expect(r.stocks[0].pct).toBeCloseTo(13.3333)
    expect(r.industries[0]).toMatchObject({ name: '信息技术', value: 750 })
    expect(r.industries[0].pct).toBeCloseTo(50)
    expect(getHoldingsMock).not.toHaveBeenCalled()
  })

  it('falls back to top10 holdings when enrich data is missing', async () => {
    mockFetchByCode({})
    getHoldingsMock.mockResolvedValue([
      { code: 'A', name: '股票A', ratio: 10 },
      { code: 'B', name: '股票B', ratio: 5 },
    ])
    const { computeLookthrough } = await import('./lookthrough')

    const r = await computeLookthrough([{ code: 'F1', name: '基金1', value: 1000 }])

    expect(r.source).toBe('top10')
    expect(r.coveredValue).toBe(1000)
    expect(r.industryCoveredValue).toBe(0)
    expect(r.stocks.map((s) => s.code)).toEqual(['A', 'B'])
    expect(r.stocks[0].value).toBeCloseTo(100)
    expect(r.stocks[0].pct).toBeCloseTo(10)
  })

  it('marks mixed source when enrich and top10 are both used', async () => {
    mockFetchByCode({
      F1: {
        code: 'F1',
        holdings: [{ code: 'A', name: '股票A', ratio: 10 }],
        industries: [],
      },
    })
    getHoldingsMock.mockResolvedValue([{ code: 'B', name: '股票B', ratio: 20 }])
    const { computeLookthrough } = await import('./lookthrough')

    const r = await computeLookthrough([
      { code: 'F1', name: '基金1', value: 1000 },
      { code: 'F2', name: '基金2', value: 500 },
    ])

    expect(r.source).toBe('mixed')
    expect(r.coveredValue).toBe(1500)
    expect(r.stocks.map((s) => s.code)).toEqual(['A', 'B'])
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
  })
})
