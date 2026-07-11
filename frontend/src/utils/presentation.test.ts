import { describe, expect, it } from 'vitest'
import type { DecisionResp } from '@/api/client'
import type { Alert } from './alerts'
import type { Estimate } from './estimate'
import {
  MAIN_NAV_ITEMS,
  WATCH_SECTIONS,
  combineTemperature,
  estimateChangeForDisplay,
  estimateFreshness,
  estimateTrustText,
  freshnessFromTime,
  marketDataFreshness,
  groupDecisions,
  sourceFreshness,
  visibleUnreadAlerts,
} from './presentation'

const baseEstimate: Estimate = {
  code: '012920', name: '全球成长', lastNav: 5, estNav: 5.1, estChange: 2,
  navDate: '2026-07-09', estTime: '2026-07-10 14:30', kind: 'overseas_model',
  label: '海外模型估算', isRealtime: true, sourceNote: '模型估算',
}

describe('page presentation contracts', () => {
  it('keeps only the three primary navigation entries and two watch sections', () => {
    expect(MAIN_NAV_ITEMS.map((item) => item.label)).toEqual(['首页', '选基', '自选'])
    expect(MAIN_NAV_ITEMS.map((item) => item.to)).toEqual(['/', '/screen', '/watch'])
    expect(WATCH_SECTIONS).toEqual(['今日决策摘要', '盘中估值'])
  })

  it('combines market and watch temperatures only once with the agreed weights', () => {
    expect(combineTemperature(60, 58)).toBe(59)
    expect(combineTemperature(60, null)).toBe(60)
    expect(combineTemperature(null, 58)).toBe(58)
  })

  it('removes read and dismissed alerts from the visible reminder area', () => {
    const alerts: Alert[] = [
      { id: '1', kind: 'rebalance', title: 'a', body: 'a', level: 'info', time: '2026-07-10T02:00:00Z', read: false, dismissed: false },
      { id: '2', kind: 'rebalance', title: 'b', body: 'b', level: 'info', time: '2026-07-10T03:00:00Z', read: true, dismissed: false },
    ]
    expect(visibleUnreadAlerts(alerts).map((item) => item.id)).toEqual(['1'])
    alerts[0].read = true
    expect(visibleUnreadAlerts(alerts)).toEqual([])
  })
})

describe('freshness and QDII evidence', () => {
  const now = Date.parse('2026-07-10T07:00:00Z')

  it('hides an expired precise estimate but keeps a fresh model estimate', () => {
    const fresh = { ...baseEstimate, generatedAt: '2026-07-10T06:30:00Z' }
    const expired = { ...baseEstimate, generatedAt: '2026-07-06T06:30:00Z' }
    expect(estimateFreshness(fresh, now)).toBe('fresh')
    expect(estimateChangeForDisplay(fresh, now)).toBe(2)
    expect(estimateFreshness(expired, now)).toBe('expired')
    expect(estimateChangeForDisplay(expired, now)).toBeNull()
  })

  it('renders compact model coverage, sample confidence and P80 band', () => {
    const text = estimateTrustText({
      ...baseEstimate, modelWeight: 72, confidence: '中等', accuracySamples: 24, errorBand: 1.86,
    })
    expect(text).toContain('净值基准 2026-07-09')
    expect(text).toContain('覆盖 72%')
    expect(text).toContain('24 样本')
    expect(text).toContain('P80 ±1.86%')
  })

  it('marks stale source checks yellow before they become expired', () => {
    expect(freshnessFromTime('2026-07-10T06:30:00Z', now)).toBe('fresh')
    expect(sourceFreshness({ id: 'x', label: 'x', ok: true, lastCheck: now - 20 * 60 * 1000, failures: 0, consecutive: 0 }, now)).toBe('stale')
    expect(sourceFreshness({ id: 'x', label: 'x', ok: false, lastCheck: now, failures: 3, consecutive: 3 }, now)).toBe('expired')
  })

  it('does not expire Friday market data over the weekend', () => {
    expect(marketDataFreshness('2026-07-10 15:00', Date.parse('2026-07-12T08:00:00+08:00'))).toBe('fresh')
    expect(marketDataFreshness('2026-07-10 15:00', Date.parse('2026-07-13T16:00:00+08:00'))).toBe('stale')
    expect(marketDataFreshness('2026-07-10 15:00', Date.parse('2026-07-16T16:00:00+08:00'))).toBe('expired')
  })
})

describe('decision summary', () => {
  it('keeps the action compact while exposing confidence and one reason', () => {
    const decision: DecisionResp = {
      code: '012920', name: '全球成长', action: '继续定投', confidence: '中', summary: '保持节奏',
      reasons: ['估值适中'], risks: [], position_rule: '', next_check: '',
    }
    expect(groupDecisions([{ code: '012920', name: '全球成长' }], { '012920': decision })).toEqual([{
      action: '继续定投', names: ['全球成长'], confidence: '中', reason: '估值适中',
    }])
  })
})
