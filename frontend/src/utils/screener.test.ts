import { afterEach, describe, expect, it, vi } from 'vitest'

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

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

  function response(body: unknown, ok = true) {
    const text = JSON.stringify(body)
    return { ok, json: vi.fn().mockResolvedValue(body), text: vi.fn().mockResolvedValue(text) }
  }

  function mockLegacy(funds: unknown[], schemaVersion = 2) {
    const body = {
      schema_version: schemaVersion,
      updated: '2026-07-01',
      fetched_at: '2026-07-01T10:00:00+08:00',
      source: 'eastmoney_fund_ranking',
      funds,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({}, false))
      .mockResolvedValueOnce(response(body))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('loads screener data and caches it', async () => {
    const fetchMock = mockLegacy([
      { c: '000001', n: '基金A', t: '混合型', r1m: null, r3m: null, r6m: 5, r1y: 10, r3y: 20, ytd: null, fee: 0.1 },
    ])
    const { loadScreener } = await import('./screener')

    const first = await loadScreener()
    const second = await loadScreener()

    expect(first.updated).toBe('2026-07-01')
    expect(first.funds).toHaveLength(1)
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws readable error when screener source is unavailable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({}, false))
    vi.stubGlobal('fetch', fetchMock)
    const { loadScreener } = await import('./screener')

    await expect(loadScreener()).rejects.toThrow('暂无排行数据')
  })

  it('finds better same-category funds sorted by one-year return', async () => {
    mockLegacy([
      { c: '000001', n: '当前', t: '混合型', r1m: null, r3m: null, r6m: 1, r1y: 5, r3y: 4, ytd: null, fee: 0.2 },
      { c: '000002', n: '基金A', t: '混合型', r1m: null, r3m: null, r6m: 3, r1y: 12, r3y: 30, ytd: null, fee: 0.1 },
      { c: '000003', n: '基金B', t: '混合型', r1m: null, r3m: null, r6m: 2, r1y: 8, r3y: 20, ytd: null, fee: 0.1 },
      { c: '000004', n: '基金C', t: '混合型', r1m: null, r3m: null, r6m: 1, r1y: 4, r3y: 10, ytd: null, fee: 0.1 },
      { c: '000005', n: '基金D', t: '股票型', r1m: null, r3m: null, r6m: 5, r1y: 20, r3y: 40, ytd: null, fee: 0.1 },
      { c: '000006', n: '基金E', t: '混合型', r1m: null, r3m: null, r6m: 1, r1y: null, r3y: 5, ytd: null, fee: 0.1 },
    ])
    const { findSimilar } = await import('./screener')

    const r = await findSimilar('混合型-偏股', '000001', 5, 2)

    expect(r.map((f) => f.c)).toEqual(['000002', '000003'])
  })

  it('returns category top funds when base return is unavailable', async () => {
    mockLegacy([
      { c: '000001', n: '基金A', t: 'QDII', r1m: null, r3m: null, r6m: 1, r1y: -2, r3y: 1, ytd: null, fee: 0.1 },
      { c: '000002', n: '基金B', t: 'QDII', r1m: null, r3m: null, r6m: 2, r1y: 6, r3y: 3, ytd: null, fee: 0.1 },
    ])
    const { findSimilar } = await import('./screener')

    const r = await findSimilar('QDII-混合', 'SELF', null)

    expect(r.map((f) => f.c)).toEqual(['000002', '000001'])
  })

  it('returns empty when type cannot be normalized', async () => {
    const fetchMock = mockLegacy([])
    const { findSimilar } = await import('./screener')

    await expect(findSimilar('另类投资', 'SELF', 0)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a legacy monolith without schema v2', async () => {
    mockLegacy([
      { c: '000001', n: '基金A', t: '混合型', r1m: null, r3m: null, r6m: 1, r1y: 2, r3y: 3, ytd: null, fee: 0.1 },
    ], 1)
    const { loadScreener } = await import('./screener')

    await expect(loadScreener()).rejects.toThrow('排行数据格式无效')
  })
})

describe('screenQuality evidence gate', () => {
  it('does not publish a total score below 70% core-return coverage', async () => {
    const { screenQuality, screenQualityCoverage } = await import('./screener')
    const row = { c: 'A', n: '基金A', t: '混合型', r1m: 1, r3m: 3, r6m: 6, r1y: 10, r3y: null, ytd: 2, fee: 0.1 }

    expect(screenQualityCoverage(row)).toBeCloseTo(2 / 3)
    expect(screenQuality(row)).toBeNull()
    expect(screenQuality({ ...row, r3y: 30 })).not.toBeNull()
  })

  it('rejects an incomplete v2 chunk manifest instead of returning partial ranks', async () => {
    const file = `part-000-${'b'.repeat(12)}.json`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
        schema_version: 2, updated: '2026-08-12', total: 2, collection: 'funds',
        sha256: 'a'.repeat(64), chunks: [file],
        chunk_sha256: { [file]: 'b'.repeat(12) + 'c'.repeat(52) },
      }) })
      .mockResolvedValueOnce({ ok: false, text: vi.fn() })
    vi.stubGlobal('fetch', fetchMock)
    const { loadScreener } = await import('./screener')

    await expect(loadScreener()).rejects.toThrow('排行数据分片加载失败')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('verifies immutable chunk content against the manifest hash', async () => {
    vi.resetModules()
    const file = `part-000-${'b'.repeat(12)}.json`
    const body = JSON.stringify({
      funds: [{ c: '000001', n: '基金A', t: '混合型', r1m: 1, r3m: 2, r6m: 3, r1y: 4, r3y: 5, ytd: 6, fee: 0.1 }],
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
        schema_version: 2, updated: '2026-08-12', total: 1, collection: 'funds',
        sha256: 'a'.repeat(64), chunks: [file],
        chunk_sha256: { [file]: 'b'.repeat(12) + 'c'.repeat(52) },
      }) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(body) }))
    const { loadScreener } = await import('./screener')

    await expect(loadScreener()).rejects.toThrow('排行数据分片校验失败')
  })

  it('verifies and loads a complete v2 chunk generation without rewriting numeric JSON', async () => {
    vi.resetModules()
    const arrayText = '[{"c":"000001","n":"基金A","t":"混合型","r1m":1.0,"r3m":2.0,"r6m":3.0,"r1y":4.0,"r3y":5.0,"ytd":6.0,"fee":0.1}]'
    const body = `{"funds":${arrayText}}`
    const chunkHash = await digest(body)
    const file = `part-000-${chunkHash.slice(0, 12)}.json`
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
        schema_version: 2, updated: '2026-08-12', total: 1, collection: 'funds',
        sha256: await digest(arrayText), chunks: [file], chunk_sha256: { [file]: chunkHash },
      }) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(body) }))
    const { loadScreener } = await import('./screener')

    await expect(loadScreener()).resolves.toMatchObject({ updated: '2026-08-12', funds: [{ c: '000001' }] })
  })
})
