import { afterEach, describe, expect, it, vi } from 'vitest'

describe('catOf', () => {
  it('normalizes detailed fund type to screener category', async () => {
    const { catOf } = await import('./screener')

    expect(catOf('混合型-偏股')).toBe('混合型')
    expect(catOf('QDII-股票')).toBe('QDII')
    expect(catOf('指数型-股票')).toBe('指数型')
    expect(catOf(null)).toBeNull()
    expect(catOf('另类投资')).toBeNull()
  })
})

describe('loadScreener and findSimilar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function mockFetch(body: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      json: vi.fn().mockResolvedValue(body),
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('loads screener data and caches it', async () => {
    const fetchMock = mockFetch({
      updated: '2026-07-01',
      funds: [{ c: 'A', n: '基金A', t: '混合型', r1m: null, r3m: null, r6m: null, r1y: 10, r3y: null, ytd: null, fee: 0.1 }],
    })
    const { loadScreener } = await import('./screener')

    const first = await loadScreener()
    const second = await loadScreener()

    expect(first.updated).toBe('2026-07-01')
    expect(first.funds).toHaveLength(1)
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws readable error when screener source is unavailable', async () => {
    mockFetch({}, false)
    const { loadScreener } = await import('./screener')

    await expect(loadScreener()).rejects.toThrow('暂无排行数据')
  })

  it('finds better same-category funds sorted by one-year return', async () => {
    mockFetch({
      updated: '2026-07-01',
      funds: [
        { c: 'SELF', n: '当前', t: '混合型', r1m: null, r3m: null, r6m: null, r1y: 5, r3y: null, ytd: null, fee: 0.2 },
        { c: 'A', n: '基金A', t: '混合型', r1m: null, r3m: null, r6m: null, r1y: 12, r3y: null, ytd: null, fee: 0.1 },
        { c: 'B', n: '基金B', t: '混合型', r1m: null, r3m: null, r6m: null, r1y: 8, r3y: null, ytd: null, fee: 0.1 },
        { c: 'C', n: '基金C', t: '混合型', r1m: null, r3m: null, r6m: null, r1y: 4, r3y: null, ytd: null, fee: 0.1 },
        { c: 'D', n: '基金D', t: '股票型', r1m: null, r3m: null, r6m: null, r1y: 20, r3y: null, ytd: null, fee: 0.1 },
        { c: 'E', n: '基金E', t: '混合型', r1m: null, r3m: null, r6m: null, r1y: null, r3y: null, ytd: null, fee: 0.1 },
      ],
    })
    const { findSimilar } = await import('./screener')

    const r = await findSimilar('混合型-偏股', 'SELF', 5, 2)

    expect(r.map((f) => f.c)).toEqual(['A', 'B'])
  })

  it('returns category top funds when base return is unavailable', async () => {
    mockFetch({
      updated: '2026-07-01',
      funds: [
        { c: 'A', n: '基金A', t: 'QDII', r1m: null, r3m: null, r6m: null, r1y: -2, r3y: null, ytd: null, fee: 0.1 },
        { c: 'B', n: '基金B', t: 'QDII', r1m: null, r3m: null, r6m: null, r1y: 6, r3y: null, ytd: null, fee: 0.1 },
      ],
    })
    const { findSimilar } = await import('./screener')

    const r = await findSimilar('QDII-混合', 'SELF', null)

    expect(r.map((f) => f.c)).toEqual(['B', 'A'])
  })

  it('returns empty when type cannot be normalized', async () => {
    const fetchMock = mockFetch({ updated: '', funds: [] })
    const { findSimilar } = await import('./screener')

    await expect(findSimilar('另类投资', 'SELF', 0)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
