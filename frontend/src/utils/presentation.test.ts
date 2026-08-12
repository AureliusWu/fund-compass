import { describe, expect, it } from 'vitest'
import type { DecisionResp } from '@/api/client'
import type { Alert } from './alerts'
import { estimateDataFreshness, type Estimate } from './estimate'
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
  baseNav: 5, baseNavDate: '2026-07-09', valueNav: 5.1, valueDate: '2026-07-10',
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

  it('eventually expires legacy overseas estimates instead of keeping them stale forever', () => {
    expect(estimateFreshness({
      ...baseEstimate,
      kind: 'overseas',
      label: '海外估值',
      estTime: '2026-07-01T07:00:00Z',
    }, now)).toBe('expired')
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

  it('parses timezone-less quote times as Beijing time and rejects future drift', () => {
    const now = Date.parse('2026-08-12T10:00:00+08:00')
    expect(marketDataFreshness('2026-08-12 09:59:00', now)).toBe('fresh')
    expect(marketDataFreshness('2026-08-12 10:04:00', now)).toBe('fresh')
    expect(marketDataFreshness('2026-08-12 10:06:00', now)).toBe('expired')
  })

  it('evaluates date-only estimates by Beijing trading date without inventing a close time', () => {
    const morning = Date.parse('2026-08-12T09:00:00+08:00')
    expect(marketDataFreshness('2026-08-12', morning)).toBe('fresh')
    expect(marketDataFreshness('2026-08-11', morning)).toBe('stale')
    expect(marketDataFreshness('2026-08-10', morning)).toBe('stale')
    expect(marketDataFreshness('2026-08-07', morning)).toBe('expired')
    expect(marketDataFreshness('2026-08-14', morning)).toBe('expired')
    expect(marketDataFreshness('2026-02-31', morning)).toBe('expired')

    // Friday remains current over the weekend because no trading day elapsed.
    expect(marketDataFreshness('2026-08-07', Date.parse('2026-08-09T09:00:00+08:00'))).toBe('fresh')
  })

  it('keeps a same-Beijing-day holdings model current without calling it realtime', () => {
    const estimate: Estimate = {
      ...baseEstimate,
      code: '005844', name: '国内混合', kind: 'holdings_model', label: '重仓模型估算',
      isRealtime: false, modelReportDate: '2026-06-30', modelCoverage: 83.47,
      modelQuoteCount: 10, modelRejectedCount: 0,
      modelOldestQuoteTime: '2026-08-12 09:58:00', modelNewestQuoteTime: '2026-08-12 10:02:00',
    }
    const now = Date.parse('2026-08-12T10:03:00+08:00')
    expect(estimateFreshness(estimate, now)).toBe('fresh')
    expect(estimateChangeForDisplay(estimate, now)).toBe(2)
    expect(estimateTrustText(estimate)).toContain('重仓披露 2026-06-30')
    expect(estimateTrustText(estimate)).toContain('覆盖 83.5%')
    expect(estimateTrustText(estimate)).toContain('10 只行情')
    expect(estimateTrustText(estimate)).toContain('非官方模型估算')
  })

  it('expires a holdings model when any contributing quote window is old', () => {
    const estimate: Estimate = {
      ...baseEstimate,
      kind: 'holdings_model', label: '重仓模型估算', isRealtime: false,
      modelOldestQuoteTime: '2026-08-07 14:30:00',
      modelNewestQuoteTime: '2026-08-12 10:02:00',
    }
    expect(estimateFreshness(estimate, Date.parse('2026-08-12T10:03:00+08:00'))).toBe('expired')
    expect(estimateChangeForDisplay(estimate, Date.parse('2026-08-12T10:03:00+08:00'))).toBeNull()
  })

  it('uses minute age for holdings models across the lunch break', () => {
    const estimate: Estimate = {
      ...baseEstimate,
      kind: 'holdings_model', label: '重仓模型估算', isRealtime: false,
      estTime: '2026-08-12 11:30:00',
      modelOldestQuoteTime: '2026-08-12 11:30:00',
      modelNewestQuoteTime: '2026-08-12 11:30:00',
    }
    expect(estimateFreshness(estimate, Date.parse('2026-08-12T11:45:00+08:00'))).toBe('fresh')
    expect(estimateFreshness(estimate, Date.parse('2026-08-12T13:00:00+08:00'))).toBe('stale')
    expect(estimateFreshness(estimate, Date.parse('2026-08-12T13:01:00+08:00'))).toBe('expired')
    expect(estimateChangeForDisplay(estimate, Date.parse('2026-08-12T13:01:00+08:00'))).toBeNull()
    expect(estimateFreshness({
      ...estimate,
      estTime: '2026-08-12 13:06:00',
      modelOldestQuoteTime: '2026-08-12 13:06:00',
      modelNewestQuoteTime: '2026-08-12 13:06:00',
    }, Date.parse('2026-08-12T13:00:00+08:00'))).toBe('expired')
  })

  it('shares the same pure freshness result used by preferred daily moves', () => {
    const estimate: Estimate = {
      ...baseEstimate,
      kind: 'holdings_model', label: '重仓模型估算', isRealtime: false,
      estTime: '2026-08-12 12:59:00',
      modelOldestQuoteTime: '2026-08-12 12:59:00',
      modelNewestQuoteTime: '2026-08-12 12:59:00',
    }
    const now = Date.parse('2026-08-12T14:30:00+08:00')
    expect(estimateDataFreshness(estimate, now)).toBe('expired')
    expect(estimateFreshness(estimate, now)).toBe('expired')
    expect(estimateDataFreshness({ ...estimate,
      estTime: '2026-08-12 14:29:00',
      modelOldestQuoteTime: '2026-08-12 14:29:00',
      modelNewestQuoteTime: '2026-08-12 14:29:00',
    }, now)).toBe('fresh')
  })

  it('expires precise direct estimates after 90 minutes and hides their change', () => {
    const estimate: Estimate = {
      ...baseEstimate,
      code: '005844', name: '国内混合', kind: 'intraday', label: '盘中估值',
      isRealtime: true, status: 'fresh', estTime: '2026-08-12 09:30:00',
    }
    const afternoon = Date.parse('2026-08-12T14:30:00+08:00')
    expect(estimateFreshness(estimate, afternoon)).toBe('expired')
    expect(estimateChangeForDisplay(estimate, afternoon)).toBeNull()
    expect(estimateFreshness({ ...estimate, estTime: '2026-08-12 14:29:00' }, afternoon)).toBe('fresh')
    expect(estimateChangeForDisplay({ ...estimate, estTime: '2026-08-12 14:29:00' }, afternoon)).toBe(2)
    expect(estimateFreshness({ ...estimate, estTime: '2026-08-12 14:36:00' }, afternoon)).toBe('expired')
  })
})

describe('decision summary', () => {
  it('keeps the action compact while exposing confidence and one reason', () => {
    const decision: DecisionResp = {
      code: '012920', name: '全球成长', action: '分批定投', strength: 68, confidence: '中', data_status: '实时',
      data_time: '2026-07-10 14:30', position_level: '中位区域', trend_state: '中性', investment_method: '分批投入',
      change_conditions: ['趋势转弱时停止投入'], summary: '保持节奏', reasons: ['估值适中'], risks: [], position_rule: '', next_check: '',
    }
    expect(groupDecisions([{ code: '012920', name: '全球成长' }], { '012920': decision })).toEqual([{
      action: '分批定投', names: ['全球成长'], confidence: '中', reason: '估值适中',
    }])
  })
})
