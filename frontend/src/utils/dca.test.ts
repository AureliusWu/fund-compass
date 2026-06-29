import { describe, expect, it } from 'vitest'

import type { NavPoint } from '@/api/client'
import {
  simulateRegularDCA,
  simulateTakeProfit,
  simulateTargetDate,
  simulateValueDCA,
} from './dca'

// 每个净值生成一个月首净值点（月递增），便于 monthlyNavs 按月取点
function monthly(navs: number[], startYM = '2022-01'): NavPoint[] {
  const [y0, m0] = startYM.split('-').map(Number)
  return navs.map((nav, i) => {
    const idx = m0 - 1 + i
    const y = y0 + Math.floor(idx / 12)
    const m = String((idx % 12) + 1).padStart(2, '0')
    return { date: `${y}-${m}-01`, nav, ac_return: null }
  })
}

describe('simulateRegularDCA', () => {
  it('恒定净值 → 收益≈0', () => {
    const r = simulateRegularDCA(monthly(Array(12).fill(1)), 1000, 12, 1)!
    expect(r.periods).toBe(12)
    expect(r.invested).toBe(12000)
    expect(r.profit).toBeCloseTo(0)
    expect(r.rate).toBeCloseTo(0)
  })

  it('净值上涨 → 收益为正', () => {
    const navs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]
    const r = simulateRegularDCA(monthly(navs), 1000, 12, 2)!
    expect(r.profit).toBeGreaterThan(0)
    expect(r.rate).toBeGreaterThan(0)
  })

  it('不足 2 个月 → null', () => {
    expect(simulateRegularDCA(monthly([1]), 1000, 12, 1)).toBeNull()
  })
})

describe('simulateValueDCA', () => {
  it('恒定净值 → 平均倍数≈1', () => {
    const v = simulateValueDCA(monthly(Array(12).fill(1)), 1000, 12, 3, 1)!
    expect(v.detail.length).toBe(v.periods)
    expect(v.avgMultiplier).toBeCloseTo(1)
  })

  it('末月暴跌 → 该月触发 2 倍投', () => {
    const navs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.8]
    const v = simulateValueDCA(monthly(navs), 1000, 12, 6, 0.8)!
    expect(v.detail[v.detail.length - 1].multiplier).toBe(2.0)
  })

  it('历史不足 maPeriod+2 → null', () => {
    expect(simulateValueDCA(monthly([1, 1, 1]), 1000, 12, 5, 1)).toBeNull()
  })
})

describe('simulateTakeProfit', () => {
  it('持续上涨 + 低阈值 → 触发止盈周期', () => {
    const tp = simulateTakeProfit(monthly([1, 1.5, 2, 2.5, 3]), 1000, 12, 20, 3)!
    expect(tp.cycles.length).toBeGreaterThanOrEqual(1)
    expect(tp.withTP.invested).toBe(5000)
  })

  it('不足 3 个月 → null', () => {
    expect(simulateTakeProfit(monthly([1, 1]), 1000, 12, 20, 1)).toBeNull()
  })
})

describe('simulateTargetDate', () => {
  it('多起点情景：winRate 在 [0,100]，best≥worst', () => {
    const navs = Array.from({ length: 12 }, (_, i) => 1 + i * 0.1)
    const td = simulateTargetDate(monthly(navs), 1000, 6, 2.5)!
    expect(td.scenarios.length).toBeGreaterThan(0)
    expect(td.winRate).toBeGreaterThanOrEqual(0)
    expect(td.winRate).toBeLessThanOrEqual(100)
    expect(td.best.rate).toBeGreaterThanOrEqual(td.worst.rate)
  })

  it('历史不足 investMonths+3 → null', () => {
    expect(simulateTargetDate(monthly([1, 1, 1]), 1000, 6, 1)).toBeNull()
  })
})
