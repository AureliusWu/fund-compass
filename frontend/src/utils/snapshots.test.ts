import { beforeEach, describe, expect, it } from 'vitest'

import { buildSnapChart, loadSnapshots, takeDailySnapshot, takeSnapshot } from './snapshots'

const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  },
  configurable: true,
})

describe('snapshots', () => {
  beforeEach(() => localStorage.clear())

  it('手动快照同一天覆盖', () => {
    takeSnapshot(1000, 900, new Date('2026-07-04T01:00:00Z'))
    const snaps = takeSnapshot(1200, 950, new Date('2026-07-04T12:00:00Z'))
    expect(snaps).toEqual([{ date: '2026-07-04', value: 1200, cost: 950 }])
  })

  it('保存可选持仓明细', () => {
    const snaps = takeSnapshot(1000, 900, new Date('2026-07-04T01:00:00Z'), [
      { id: '支付宝|A', code: 'A', name: '基金A', account: '支付宝', type: '混合型', value: 1000, cost: 900 },
    ])
    expect(snaps[0].holdings?.[0].id).toBe('支付宝|A')
  })

  it('每日自动快照不覆盖当天已有快照', () => {
    takeSnapshot(1000, 900, new Date('2026-07-04T01:00:00Z'))
    const snaps = takeDailySnapshot(1200, 950, new Date('2026-07-04T12:00:00Z'))
    expect(snaps).toEqual([{ date: '2026-07-04', value: 1000, cost: 900 }])
  })

  it('空资产不自动记录', () => {
    expect(takeDailySnapshot(0, 0, new Date('2026-07-04T01:00:00Z'))).toEqual([])
    expect(loadSnapshots()).toEqual([])
  })

  it('按日期排序并生成两点以上图表', () => {
    takeSnapshot(1100, 900, new Date('2026-07-05T01:00:00Z'))
    takeSnapshot(1000, 900, new Date('2026-07-04T01:00:00Z'))
    const snaps = loadSnapshots()
    expect(snaps.map((s) => s.date)).toEqual(['2026-07-04', '2026-07-05'])
    expect(buildSnapChart(snaps)).not.toBeNull()
    expect(buildSnapChart(snaps.slice(0, 1))).toBeNull()
  })
})
