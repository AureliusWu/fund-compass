import { afterEach, describe, expect, it, vi } from 'vitest'

import { getHoldings, normalizeHoldingRow } from './holdings'

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

describe('normalizeHoldingRow', () => {
  it('keeps a valid disclosed ratio', () => {
    expect(normalizeHoldingRow('600000', '浦发银行', ' 3.25% ')).toEqual({
      code: '600000',
      name: '浦发银行',
      ratio: 3.25,
    })
  })

  it.each([undefined, null, '', '--', 'nan', 0, -1, 101])(
    'skips a holding when its ratio is missing or invalid: %s',
    (ratio) => {
      expect(normalizeHoldingRow('600000', '浦发银行', ratio)).toBeNull()
    },
  )

  it('loads holdings and current changes only through bounded Worker JSON endpoints', async () => {
    stubStorage()
    const createElement = vi.fn(() => { throw new Error('third-party script creation is forbidden') })
    vi.stubGlobal('document', { createElement })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/holdings?')) {
        return Response.json({ code: '654321', report_date: '2026-06-30', items: [
          { code: '600000', name: '浦发银行', ratio: 3.25 },
          { code: '000001', name: '平安银行', ratio: 2.5 },
        ] })
      }
      if (url.includes('/quotes?')) {
        return Response.json({ items: [
          { code: 'sh600000', price: 10, change_pct: 0, status: 'fresh', source_time: '2026-08-28T14:30:00+08:00' },
          { code: 'sz000001', price: 12, change_pct: 'unknown', status: 'stale', source_time: null },
        ] })
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await getHoldings('654321', true)

    expect(rows).toEqual([
      { code: '600000', name: '浦发银行', ratio: 3.25, change: 0, reportDate: '2026-06-30' },
      { code: '000001', name: '平安银行', ratio: 2.5, reportDate: '2026-06-30' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('sinan-estimate-push.ligugu69.workers.dev'))).toBe(true)
    expect(createElement).not.toHaveBeenCalled()
  })

  it('expires both memory and local holdings caches after 12 hours', async () => {
    stubStorage()
    vi.useFakeTimers()
    const startedAt = Date.UTC(2026, 8, 1, 6, 30)
    vi.setSystemTime(startedAt)
    let holdingsCalls = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/holdings?')) {
        holdingsCalls += 1
        return Response.json({
          code: '654322',
          report_date: '2026-06-30',
          items: [{ code: '600000', name: '浦发银行', ratio: 3.25 }],
        })
      }
      if (url.includes('/quotes?')) return Response.json({ items: [] })
      throw new Error(`unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(await getHoldings('654322', true)).toHaveLength(1)
    vi.setSystemTime(startedAt + 60_000)
    expect(await getHoldings('654322')).toHaveLength(1)
    expect(holdingsCalls).toBe(1)

    vi.setSystemTime(startedAt + 12 * 3600 * 1000 + 1)
    expect(await getHoldings('654322')).toHaveLength(1)
    expect(holdingsCalls).toBe(2)
  })

  it.each(['2027-01-01', '2025-01-01', null])(
    'fails closed when the holdings report date is future, too old, or missing: %s',
    async (reportDate) => {
      stubStorage()
      vi.useFakeTimers()
      vi.setSystemTime(Date.UTC(2026, 8, 1, 6, 30))
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        code: '654323',
        report_date: reportDate,
        items: [{ code: '600000', name: '浦发银行', ratio: 3.25 }],
      })))

      expect(await getHoldings('654323', true)).toEqual([])
    },
  )
})
