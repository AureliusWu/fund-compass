import { describe, expect, it } from 'vitest'

import { computeAttribution, computePeriodAttribution } from './attribution'

describe('computeAttribution', () => {
  it('returns empty summary when portfolio value is zero', () => {
    const r = computeAttribution([
      {
        code: '000001',
        name: 'A',
        account: '支付宝',
        type: '混合型',
        shares: 100,
        cost: 1,
        nav: null,
        value: 0,
        profit: 0,
        today: null,
      },
    ])

    expect(r.holdings).toEqual([])
    expect(r.bestDay).toBeNull()
    expect(r.concentration).toEqual({ top1: 0, top3: 0, top5: 0 })
  })

  it('computes weights, daily contribution, total return and concentration', () => {
    const r = computeAttribution([
      {
        code: 'A',
        name: '基金A',
        account: '支付宝',
        type: '混合型',
        shares: 100,
        cost: 1,
        nav: 2,
        value: 200,
        profit: 100,
        today: 4,
        todayPct: 2,
      },
      {
        code: 'B',
        name: '基金B',
        account: '券商',
        type: 'QDII',
        shares: 100,
        cost: 2,
        nav: 1,
        value: 100,
        profit: -100,
        today: -3,
        todayPct: -3,
      },
    ])

    expect(r.holdings).toHaveLength(2)
    expect(r.holdings[0].weight).toBeCloseTo(66.6667)
    expect(r.holdings[0].dayContrib).toBeCloseTo(1.3333)
    expect(r.holdings[0].totalReturn).toBeCloseTo(100)
    expect(r.holdings[0].totalContrib).toBeCloseTo(66.6667)
    expect(r.bestDay?.code).toBe('A')
    expect(r.worstDay?.code).toBe('B')
    expect(r.bestTotal?.code).toBe('A')
    expect(r.worstTotal?.code).toBe('B')
    expect(r.concentration.top1).toBeCloseTo(66.6667)
    expect(r.concentration.top3).toBeCloseTo(100)
    expect(r.concentration.top5).toBeCloseTo(100)
  })

  it('aggregates attribution by account and type sorted by weight', () => {
    const r = computeAttribution([
      {
        code: 'A',
        name: '基金A',
        account: '支付宝',
        type: '混合型',
        shares: 100,
        cost: 1,
        nav: 2,
        value: 200,
        profit: 100,
        today: 4,
        todayPct: 2,
      },
      {
        code: 'B',
        name: '基金B',
        account: '支付宝',
        type: '债券型',
        shares: 100,
        cost: 1,
        nav: 1,
        value: 100,
        profit: 0,
        today: null,
        todayPct: null,
      },
      {
        code: 'C',
        name: '基金C',
        account: '券商',
        type: '混合型',
        shares: 100,
        cost: 1,
        nav: 1,
        value: 100,
        profit: -20,
        today: -1,
        todayPct: -1,
      },
    ])

    expect(r.byAccount.map((g) => g.account)).toEqual(['支付宝', '券商'])
    expect(r.byAccount[0].weight).toBeCloseTo(75)
    expect(r.byAccount[0].dayContrib).toBeCloseTo(1)
    expect(r.byType.map((g) => g.type)).toEqual(['混合型', '债券型'])
    expect(r.byType[0].weight).toBeCloseTo(75)
    expect(r.byType[0].totalContrib).toBeCloseTo(45)
  })

  it('keeps day ranking null when no holding has daily return', () => {
    const r = computeAttribution([
      {
        code: 'A',
        name: '基金A',
        account: '支付宝',
        type: '混合型',
        shares: 100,
        cost: 1,
        nav: 1,
        value: 100,
        profit: 0,
        today: null,
        todayPct: null,
      },
    ])

    expect(r.bestDay).toBeNull()
    expect(r.worstDay).toBeNull()
    expect(r.bestTotal?.code).toBe('A')
  })
})

describe('computePeriodAttribution', () => {
  it('returns null when snapshots are insufficient or lack holding detail', () => {
    expect(computePeriodAttribution([])).toBeNull()
    expect(computePeriodAttribution([
      { date: '2026-07-03', value: 1000, cost: 900 },
      { date: '2026-07-04', value: 1100, cost: 900 },
    ])).toBeNull()
  })

  it('computes period contribution by holding, account and type', () => {
    const r = computePeriodAttribution([
      {
        date: '2026-07-01',
        value: 1000,
        cost: 900,
        holdings: [
          { id: '支付宝|A', code: 'A', name: '基金A', account: '支付宝', type: '混合型', value: 600, cost: 500 },
          { id: '券商|B', code: 'B', name: '基金B', account: '券商', type: '债券型', value: 400, cost: 400 },
        ],
      },
      {
        date: '2026-07-04',
        value: 1080,
        cost: 900,
        holdings: [
          { id: '支付宝|A', code: 'A', name: '基金A', account: '支付宝', type: '混合型', value: 660, cost: 500 },
          { id: '券商|B', code: 'B', name: '基金B', account: '券商', type: '债券型', value: 420, cost: 400 },
        ],
      },
    ])

    expect(r).not.toBeNull()
    expect(r!.delta).toBe(80)
    expect(r!.returnPct).toBeCloseTo(8)
    expect(r!.best?.key).toBe('支付宝|A')
    expect(r!.byAccount[0]).toMatchObject({ account: '支付宝', delta: 60 })
    expect(r!.byType[0]).toMatchObject({ type: '混合型', delta: 60 })
  })

  it('uses the first snapshot inside the requested window when available', () => {
    const r = computePeriodAttribution([
      { date: '2026-06-01', value: 800, cost: 700, holdings: [{ id: 'A', code: 'A', name: 'A', account: 'x', type: 't', value: 800, cost: 700 }] },
      { date: '2026-07-01', value: 1000, cost: 700, holdings: [{ id: 'A', code: 'A', name: 'A', account: 'x', type: 't', value: 1000, cost: 700 }] },
      { date: '2026-07-04', value: 1100, cost: 700, holdings: [{ id: 'A', code: 'A', name: 'A', account: 'x', type: 't', value: 1100, cost: 700 }] },
    ], 30)

    expect(r?.startDate).toBe('2026-07-01')
    expect(r?.delta).toBe(100)
  })
})
