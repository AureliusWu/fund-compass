import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMarketTemp } from './market-temp'

const storage = new Map<string, string>()

afterEach(() => {
  storage.clear()
  vi.unstubAllGlobals()
})

describe('market temperature failure semantics', () => {
  it('returns unavailable without caching a fabricated neutral observation', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

    const result = await fetchMarketTemp()

    expect(result.status).toBe('unavailable')
    expect(storage.size).toBe(0)
  })

  it('labels an expired observation as stale when refresh fails', async () => {
    storage.set('sinan_market_temp_v1', JSON.stringify({
      score: 67,
      label: '偏热',
      color: '#C8963E',
      sources: [],
      updated: '2026-07-10T01:00:00.000Z',
      _ts: Date.now() - 5 * 3600 * 1000,
    }))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

    const result = await fetchMarketTemp()

    expect(result.status).toBe('stale')
    expect(result.score).toBe(67)
    expect(result.updated).toBe('2026-07-10T01:00:00.000Z')
  })
})
