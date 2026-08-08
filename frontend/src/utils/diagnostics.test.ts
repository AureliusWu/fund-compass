import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NavPoint } from '@/api/client'
import { alignNavHistories, computeCorrelation, correlationFromNavHistories } from './diagnostics'

const getFundDetail = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ getFundDetail }))

afterEach(() => getFundDetail.mockReset())

function point(date: string, nav: number): NavPoint {
  return { date, nav, ac_return: null }
}

describe('NAV date alignment', () => {
  it('keeps only common dates in chronological order without forward filling', () => {
    const aligned = alignNavHistories([
      { code: 'a', points: [point('2026-01-01', 1), point('2026-01-02', 2), point('2026-01-03', 3)] },
      { code: 'b', points: [point('2026-01-04', 40), point('2026-01-03', 30), point('2026-01-01', 10)] },
    ])

    expect(aligned.dates).toEqual(['2026-01-01', '2026-01-03'])
    expect(aligned.values.a).toEqual([1, 3])
    expect(aligned.values.b).toEqual([10, 30])
  })

  it('correlates values paired by date even when source arrays have different ordering', () => {
    const dates = Array.from({ length: 12 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`)
    const a = dates.map((date, index) => point(date, index + 1))
    const b = dates.map((date, index) => point(date, (index + 1) * 2)).reverse()
    const result = correlationFromNavHistories(
      [{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }],
      new Map([['a', a], ['b', b]]),
    )

    expect(result?.pairs[0]).toMatchObject({ corr: 1, samples: 11 })
    expect(result?.matrix[0][1]).toBeCloseTo(1)
  })

  it('preserves an unknown correlation as null when common samples are insufficient', () => {
    const points = Array.from({ length: 9 }, (_, index) => point(`2026-01-${String(index + 1).padStart(2, '0')}`, index + 1))
    const result = correlationFromNavHistories(
      [{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }],
      new Map([['a', points], ['b', points]]),
    )

    expect(result?.pairs[0]).toMatchObject({ corr: null, samples: 8 })
    expect(result?.matrix[0][1]).toBeNull()
  })

  it('uses one global common-date window for every pair in a 3-fund matrix', () => {
    const dates = Array.from({ length: 15 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`)
    const a = dates.map((date, index) => point(date, 100 + index + (index % 2)))
    const b = dates.map((date, index) => point(date, 80 + index * 1.5 + (index % 3)))
    const c = dates.slice(4).map((date, index) => point(date, 60 + index + (index % 2) * 0.5))
    const result = correlationFromNavHistories(
      [{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }, { code: 'c', name: 'C' }],
      new Map([['a', a], ['b', b], ['c', c]]),
    )

    expect(result?.pairs.map((pair) => pair.samples)).toEqual([10, 10, 10])
  })

  it('correlates daily returns rather than trending NAV levels', () => {
    const returnsA = [0.02, -0.01, 0.03, -0.02, 0.01, -0.03, 0.025, -0.015, 0.018, -0.012, 0.022, -0.008]
    const returnsB = returnsA.map((value) => -value)
    const build = (returns: number[]) => {
      let nav = 100
      return [point('2026-01-01', nav), ...returns.map((value, index) => {
        nav *= 1 + value
        return point(`2026-01-${String(index + 2).padStart(2, '0')}`, nav)
      })]
    }
    const result = correlationFromNavHistories(
      [{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }],
      new Map([['a', build(returnsA)], ['b', build(returnsB)]]),
    )

    expect(result?.pairs[0].corr).toBeCloseTo(-1, 10)
    expect(result?.pairs[0].samples).toBe(12)
  })

  it('loads each fund code once even when the same holding appears in multiple accounts', async () => {
    const points = Array.from({ length: 12 }, (_, index) => point(`2026-01-${String(index + 1).padStart(2, '0')}`, 100 + index + (index % 2)))
    getFundDetail.mockImplementation(async (code: string) => ({ code, nav_history: points }))

    await computeCorrelation([
      { code: 'a', name: 'A 账户 1' },
      { code: 'a', name: 'A 账户 2' },
      { code: 'b', name: 'B' },
    ])

    expect(getFundDetail).toHaveBeenCalledTimes(2)
    expect(getFundDetail.mock.calls.map(([code]) => code).sort()).toEqual(['a', 'b'])
  })

  it('reuses provided NAV histories without another API request', async () => {
    const points = Array.from({ length: 12 }, (_, index) => point(
      `2026-01-${String(index + 1).padStart(2, '0')}`,
      100 + index + (index % 2),
    ))

    const result = await computeCorrelation(
      [{ code: 'a', name: 'A' }, { code: 'b', name: 'B' }],
      new Map([['a', points], ['b', points.map((item) => ({ ...item, nav: item.nav * 2 }))]]),
    )

    expect(result?.pairs[0].samples).toBe(11)
    expect(getFundDetail).not.toHaveBeenCalled()
  })
})
