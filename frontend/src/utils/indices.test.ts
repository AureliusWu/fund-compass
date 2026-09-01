import { afterEach, describe, expect, it, vi } from 'vitest'

import { cachedIndices, getIndices, INDEX_CACHE_MAX_AGE_MS } from './indices'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubStorage() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  })
  return values
}

describe('index quote boundary', () => {
  it('uses the Worker JSON endpoint, preserves source time, and hides stale values', async () => {
    stubStorage()
    const createElement = vi.fn(() => { throw new Error('third-party script creation is forbidden') })
    vi.stubGlobal('document', { createElement })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      expect(url).toContain('sinan-estimate-push.ligugu69.workers.dev/quotes?')
      expect(new URL(url).searchParams.get('codes')?.split(',')).toEqual([
        'usIXIC', 'usINX', 'AU9999', 'sh000001', 'sh000300',
      ])
      return Response.json({ items: [
        { code: 'usIXIC', price: 21000, change_pct: 0.5, status: 'fresh', source_time: '2026-09-01T14:30:00+08:00' },
        { code: 'usINX', price: 6500, change_pct: 99, status: 'stale', source_time: '2026-08-29T04:00:00+08:00' },
        { code: 'AU9999', price: 800, change_pct: -0.2, status: 'fresh' },
        { code: 'sh000001', price: 3900, change_pct: 0, status: 'fresh' },
        { code: 'sh000300', price: 4600, change_pct: 0.1, status: 'fresh' },
      ] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await getIndices()

    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({
      name: '纳斯达克', price: 21000, changePct: 0.5, status: 'fresh',
      sourceTime: '2026-09-01T14:30:00+08:00',
    })
    expect(rows[1]).toMatchObject({
      name: '标普500', price: null, changePct: null, status: 'stale',
      sourceTime: '2026-08-29T04:00:00+08:00',
    })
    expect(rows[3].changePct).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(createElement).not.toHaveBeenCalled()
  })

  it('uses a short cache without extending its age and hides it after expiry', async () => {
    const values = stubStorage()
    vi.useFakeTimers()
    const startedAt = Date.UTC(2026, 8, 1, 6, 30)
    vi.setSystemTime(startedAt)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [
        { code: 'usIXIC', price: 21000, change_pct: 0.5, status: 'fresh', source_time: '2026-09-01T14:30:00+08:00' },
      ] }))
      .mockRejectedValue(new Error('proxy unavailable'))
    vi.stubGlobal('fetch', fetchMock)

    const fresh = await getIndices()
    expect(fresh[0]).toMatchObject({ price: 21000, status: 'fresh' })
    const firstCache = values.get('sinan_index_cache_v2')
    expect(firstCache).toBeTruthy()

    vi.setSystemTime(startedAt + INDEX_CACHE_MAX_AGE_MS - 1)
    const cached = await getIndices()
    expect(cached[0]).toMatchObject({ price: 21000, changePct: 0.5, status: 'cached' })
    expect(values.get('sinan_index_cache_v2')).toBe(firstCache)

    vi.setSystemTime(startedAt + INDEX_CACHE_MAX_AGE_MS + 1)
    const expired = await getIndices()
    expect(expired[0]).toMatchObject({ price: null, changePct: null, status: 'stale' })
    expect(cachedIndices()[0]).toMatchObject({ price: null, status: 'stale' })
    expect(values.get('sinan_index_cache_v2')).toBe(firstCache)
  })
})
