import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BacktestResp, FundDetail, ScoreResp, SignalResp } from '@/api/client'
import * as ai from './ai'
import { llmInterpret, templateInterpret } from './interpret'

function detail(overrides: Partial<FundDetail> = {}): FundDetail {
  return {
    code: '000001', name: '合成基金', type: '股票', scale: 2, buy_rate: null, source_rate: null,
    ret_1m: 0, ret_6m: null, ret_1y: 12, ret_3y: null, rank_in_type: null, rank_total: null,
    manager: null, manager_worktime: null, latest_nav: 1, latest_nav_date: '2026-09-30',
    nav_history: [], stale: false, ...overrides,
  }
}
function score(overrides: Partial<ScoreResp> = {}): ScoreResp {
  const component = { score: 80, weight: 0.25, effective_weight: 0.25, detail: {} }
  return {
    code: '000001', name: '合成基金', type: '股票', score: 82, star: 4,
    score_version: 'synthetic-score', eligible: true, coverage: 0.8, data_stale: false,
    rank_in_type: 2, rank_total: 100,
    components: { return: component, risk: component, management: component, cost: component },
    ...overrides,
  }
}
function signal(overrides: Partial<SignalResp> = {}): SignalResp {
  return {
    code: '000001', name: '合成基金', type: '股票', signal: '买入', advice: '合成信号操作倾向',
    composite: 80, coverage: 0.8, data_stale: false,
    layers: {
      valuation: { label: '中性', value: 0, source: 'index_pe_pb', index_name: '合成指数', pe: null, pe_pct: null },
      trend: { label: '上行', value: 1 }, sentiment: { label: '中性', value: 0, rsi: null },
    }, ...overrides,
  }
}
function backtest(overrides: Partial<BacktestResp> = {}): BacktestResp {
  return {
    code: '000001', name: '合成基金', available: true,
    strategy: { total_return: 12, max_drawdown: 8, curve: [] },
    benchmark: { total_return: 12, max_drawdown: 9, curve: [] },
    win_rate: null, ...overrides,
  }
}
function text(result: ReturnType<typeof templateInterpret>): string {
  return result.verdict + result.sections.map(section => section.t).join(' ')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('rule interpretation eligibility and freshness boundary', () => {
  it('keeps trusted 70% coverage eligible data usable and shows real zero returns', () => {
    const result = templateInterpret(detail(), score({ coverage: 0.7 }), signal(), null)
    expect(result.tone).toBe('good')
    expect(result.verdict).toContain('综合评分 82')
    expect(result.verdict).toContain('2/100')
    expect(text(result)).toContain('近1月 +0.00%')
    expect(text(result)).toContain('近6月 —')
    expect(text(result)).toContain('PE —，分位 —')
    expect(text(result)).not.toMatch(/null|undefined|NaN|Infinity/)
  })

  it.each([
    ['low coverage', { coverage: 0.69 }, {}, {}],
    ['ineligible score', { eligible: false }, {}, {}],
    ['stale score', { data_stale: true }, {}, {}],
    ['stale detail', {}, { stale: true }, {}],
    ['stale signal', {}, {}, { data_stale: true }],
    ['low signal coverage', {}, {}, { coverage: 0.69 }],
    ['zero signal coverage', {}, {}, { coverage: 0 }],
    ['missing signal coverage', {}, {}, { coverage: undefined }],
    ['null signal coverage', {}, {}, { coverage: null }],
    ['NaN signal coverage', {}, {}, { coverage: Number.NaN }],
    ['infinite signal coverage', {}, {}, { coverage: Number.POSITIVE_INFINITY }],
    ['negative infinite signal coverage', {}, {}, { coverage: Number.NEGATIVE_INFINITY }],
    ['negative signal coverage', {}, {}, { coverage: -0.1 }],
    ['signal coverage outside range', {}, {}, { coverage: 1.01 }],
    ['unknown eligibility', { eligible: undefined }, {}, {}],
    ['NaN coverage', { coverage: Number.NaN }, {}, {}],
    ['infinite coverage', { coverage: Number.POSITIVE_INFINITY }, {}, {}],
    ['invalid coverage range', { coverage: 1.01 }, {}, {}],
    ['unknown score', { score: null }, {}, {}],
    ['non-finite score', { score: Number.NaN }, {}, {}],
    ['invalid score range', { score: 101 }, {}, {}],
  ] as const)('uses a neutral interpretation for %s', (_name, scoreOverride, detailOverride, signalOverride) => {
    const result = templateInterpret(detail(detailOverride), score(scoreOverride as Partial<ScoreResp>), signal(signalOverride as Partial<SignalResp>), null)
    expect(result.tone).toBe('mid')
    expect(result.verdict).toContain('暂不作当前评分与操作倾向判断')
    expect(result.verdict).not.toContain('82')
    expect(result.verdict).not.toContain('同类排名')
    expect(result.sections.some(section => section.h === '评分拆解')).toBe(false)
    expect(text(result)).not.toContain('合成信号操作倾向')
    expect(text(result)).not.toContain('当前信号「买入」')
    expect(result.sections.find(section => section.h === '操作建议')?.t).toContain('暂不提供操作倾向')
  })

  it('keeps a genuine zero score distinct from missing score', () => {
    const result = templateInterpret(detail(), score({ score: 0 }), null, null)
    expect(result.tone).toBe('weak')
    expect(result.verdict).toContain('综合评分 0')
  })

  it.each([0.7, 1])('allows current rule interpretation when signal coverage is valid at boundary %s', coverage => {
    const result = templateInterpret(detail(), score(), signal({ coverage }), null)
    expect(result.tone).toBe('good')
    expect(result.verdict).toContain('综合评分 82')
    expect(text(result)).toContain('当前信号「买入」')
  })

  it('labels stale returns as a dated historical cache without current actions', () => {
    const result = templateInterpret(detail({ stale: true, updated_at: '2026-09-29' }), score(), signal(), null)
    expect(text(result)).toContain('历史缓存（2026-09-29），不代表当前数据')
    expect(text(result)).toContain('暂不提供操作倾向')
  })

  it('does not render non-finite components, returns, or scale as valid financial facts', () => {
    const sc = score()
    sc.components.return = { ...sc.components.return, score: Number.NaN }
    sc.components.risk = { ...sc.components.risk, score: Number.POSITIVE_INFINITY }
    const result = templateInterpret(detail({ ret_1y: Number.POSITIVE_INFINITY, scale: Number.NaN }), sc, signal(), null)
    expect(text(result)).not.toMatch(/NaN|Infinity/)
    expect(text(result)).toContain('近1年 —')
    expect(text(result)).not.toContain('规模约')
  })
})

describe('historical backtest comparison semantics', () => {
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])('does not turn missing/non-finite outperform %s into zero', outperform => {
    const result = templateInterpret(detail(), score(), null, backtest({ outperform }))
    expect(text(result)).toContain('超额收益数据不足，暂不比较策略优劣')
    expect(text(result)).not.toContain('收益相同')
    expect(text(result)).not.toContain('不如长期持有')
    expect(text(result)).not.toMatch(/胜率 null|NaN|Infinity/)
  })

  it('treats a true zero excess return as a tie', () => {
    const result = templateInterpret(detail(), score(), null, backtest({ outperform: 0, win_rate: 0 }))
    expect(text(result)).toContain('收益相同（+0.00%）')
    expect(text(result)).toContain('胜率 0%')
    expect(text(result)).not.toContain('未跑赢')
    expect(text(result)).not.toContain('不如长期持有')
  })

  it.each([[2, '策略超额 +2.00%'], [-2, '策略低于一直持有 -2.00%']] as const)(
    'limits an excess return of %s to the historical window', (outperform, expected) => {
      const result = templateInterpret(detail(), score(), null, backtest({ outperform }))
      expect(text(result)).toContain('本次历史回测区间' + expected)
      expect(text(result)).toContain('历史回测不代表未来表现')
      expect(text(result)).not.toContain('强趋势品种')
    },
  )
})

describe('free-text interpretation paused boundary', () => {
  it('rejects direct calls with the fixed notice without reading configuration or using network', async () => {
    const fetch = vi.fn()
    const getItem = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('localStorage', { getItem })
    const chat = vi.spyOn(ai, 'chat')
    await expect(llmInterpret(detail(), score(), signal(), backtest())).rejects.toThrow(ai.FREE_TEXT_AI_UNAVAILABLE)
    expect(chat).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
  })
})
