import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V8Action, V8DecisionDiff, V8DecisionResult } from '@/api/client'
import {
  buildWatchDecisionRow,
  filterAndSortWatchDecisions,
  watchEstimateCaption,
  watchEstimateSemanticLabel,
  type WatchDecisionSource,
} from './decisionView'
import type { Estimate } from '@/utils/estimate'

function result(action: V8Action = 'buy', confidence: number | null = 82): V8DecisionResult {
  const strength = 76
  const held = ['add', 'hold', 'reduce', 'sell'].includes(action)
  return {
    code: '000001',
    name: '测试基金',
    type: 'QDII',
    action,
    action_label: '买入',
    strength,
    confidence,
    summary: '当前建议',
    decision: {
      schema_version: 'v8-decision-1', decision_id: `dec_${'d'.repeat(64)}`, evidence_id: `ev_${'a'.repeat(64)}`,
      fund_code: '000001', holding_version: `hold_${'b'.repeat(64)}`,
      policy_version: `pol_${'c'.repeat(64)}`, strategy_version: 'strategy_1', action, strength, confidence,
      user_state: held ? 'held' : 'unheld', summary: '当前建议', reason_codes: [`ACTION_${action.toUpperCase()}`],
      invalidation_codes: ['DATA_STALE'], invalidation_conditions: ['数据过期'], position_guidance: null,
      reasons: ['估值处于较低区间'], risks: [], evidence_nodes: [], created_at: '2026-08-28T06:00:00Z',
    },
    evidence: {
      schema_version: 'v8-evidence-1', evidence_id: `ev_${'a'.repeat(64)}`, fund_code: '000001',
      fund_name: '测试基金', fund_type: 'QDII', stale_fields: [], missing_fields: [], risk_flags: [],
      created_at: '2026-08-28T06:00:00Z', market_time: '2026-08-28T06:00:00Z',
      official_nav: 1, official_nav_date: '2026-08-27', target_nav_date: '2026-08-28',
      benchmark_id: null, valuation_percentile: 20, trend_state: '上升趋势', momentum_state: null,
      drawdown: null, volatility: null, market_temperature: null, score: 82, score_version: 'score-v1',
      score_coverage: 0.8, timing_coverage: 0.8, timing_signal: '买入', estimate: 0,
      estimate_coverage: 80, estimate_model_version: 'model-v1', estimate_error_p80: null,
      estimate_sample_count: 20, estimate_mae: null, estimate_direction_accuracy: null,
      evidence_nodes: [], evidence_strength: 80,
      estimate_status: 'modeled', source_states: [{ source_id: 'estimate:model', state: 'degraded', stale: false,
        last_success: '2026-08-28T06:00:00Z', last_failure: null, data_age_seconds: 0, latency_ms: 0, error_class: null }],
    },
    holding: { schema_version: 'v8-holding-1', holding_version: `hold_${'b'.repeat(64)}`, fund_code: '000001',
      user_state: held ? 'held' : 'unheld', shares: held ? 10 : 0, market_value: held ? 10 : 0,
      cost: null, current_weight: null, target_weight: null, account: null, updated_at: null,
      source: 'fixture', created_at: '2026-08-28T06:00:00Z' },
    policy: { schema_version: 'v8-policy-1', policy_version: `pol_${'c'.repeat(64)}`, dca_rules: {},
      name: '合成策略', source: 'fixture', supersedes: null, target_allocations: {}, target_ranges: {},
      max_single_fund_weight: 40, max_theme_weight: 60, rebalance_band: 2, reduce_rules: {}, sell_rules: {},
      created_at: '2026-08-28T06:00:00Z', effective_at: '2026-08-28T06:00:00Z' },
    diff: {},
  } as unknown as V8DecisionResult
}

function diff(overrides: Partial<V8DecisionDiff> = {}): V8DecisionDiff {
  return {
    previous_decision_id: `dec_${'e'.repeat(64)}`, current_decision_id: `dec_${'d'.repeat(64)}`, previous_action: 'watch',
    current_action: 'buy', changed: true, drivers: ['估值分位下移'], driver_codes: ['VALUATION'], unchanged: [],
    ...overrides,
  }
}

function source(overrides: Partial<WatchDecisionSource> = {}): WatchDecisionSource {
  return {
    code: '000001', name: '测试基金', type: 'QDII', result: result(), diff: diff(),
    load: { kind: 'ready' }, diffLoad: { kind: 'ready' }, change: 1.25, changeCaption: '下一净值估算',
    ...overrides,
  }
}

describe('watchlist V8 decision view', () => {
  beforeEach(() => { vi.useFakeTimers().setSystemTime('2026-08-28T06:00:00Z') })
  afterEach(() => { vi.useRealTimers() })
  it('labels a direct QDII estimate as a next-NAV estimate from fund semantics', () => {
    const estimate = {
      code: '018147',
      kind: 'intraday',
      label: '盘中估值',
      estChange: 0.83,
    } as Estimate

    expect(watchEstimateCaption('QDII-普通股票', estimate)).toBe('下一净值估算')
    expect(watchEstimateSemanticLabel('海外科技', estimate)).toBe('下一净值估算')
    expect(watchEstimateCaption('指数型', estimate)).toBe('盘中估值')
  })

  it('shows a complete V8 snapshot without treating an intentional modeled source as stale', () => {
    const row = buildWatchDecisionRow(source())

    expect(row).toMatchObject({
      actionLabel: '买入', actionable: true, gated: false, strength: 76, confidence: 82,
      dataLabel: '部分降级', dataAbnormal: false, changeCaption: '下一净值估算',
      changeLabel: '观察 → 买入',
    })
  })

  it('closes a strong action when V8 evidence is stale and keeps the raw action auditable', () => {
    const stale = result()
    stale.evidence.stale_fields = ['market_time']
    stale.evidence.source_states = [{
      source_id: 'estimate:model', state: 'stale', stale: true, last_success: null,
      last_failure: null, latency_ms: null, data_age_seconds: null, error_class: 'stale',
    }]
    const row = buildWatchDecisionRow(source({ result: stale }))

    expect(row.actionLabel).toBe('暂停动作')
    expect(row.snapshotActionLabel).toBe('买入')
    expect(row.actionable).toBe(false)
    expect(row.dataAbnormal).toBe(true)
    expect(row.mainReason).toContain('数据过期')
  })

  it('does not turn null confidence into zero', () => {
    const malformed = result('buy', null)
    const row = buildWatchDecisionRow(source({ result: malformed }))

    expect(row.confidence).toBeNull()
    expect(row.actionLabel).toBe('暂停动作')
    expect(row.dataDetail).toContain('强度或置信度缺失')
  })

  it('fails a low-confidence strong action closed while preserving the snapshot label', () => {
    const low = result('dca', 54)
    low.action_label = '分批定投'
    const row = buildWatchDecisionRow(source({ result: low, diff: diff({ current_action: 'dca' }) }))

    expect(row.actionLabel).toBe('暂停动作')
    expect(row.snapshotActionLabel).toBe('分批定投')
    expect(row.dataDetail).toContain('置信度低于 60')
    expect(row.actionable).toBe(false)
  })

  it('labels a 404 as no snapshot and never falls back to a legacy action', () => {
    const row = buildWatchDecisionRow(source({
      result: null,
      diff: null,
      load: { kind: 'missing', message: '尚未生成 V8 决策快照' },
      diffLoad: { kind: 'missing' },
    }))

    expect(row.action).toBeNull()
    expect(row.actionLabel).toBe('等待快照')
    expect(row.dataLabel).toBe('无快照')
    expect(row.mainReason).toBe('尚未生成 V8 决策快照')
  })

  it('keeps a valid current action but fails the change field closed on a partial diff error', () => {
    const row = buildWatchDecisionRow(source({
      diff: null,
      diffLoad: { kind: 'error', message: '历史变化请求失败' },
    }))

    expect(row.actionLabel).toBe('买入')
    expect(row.changeLabel).toBe('变化不可用')
    expect(row.changeDetail).toBe('历史变化请求失败')
    expect(row.dataAbnormal).toBe(true)
    expect(row.gated).toBe(false)
  })

  it('keeps private reads distinct from nonexistent snapshots and unavailable statistics', () => {
    const row = buildWatchDecisionRow(source({
      result: null, diff: null, load: { kind: 'redacted' }, diffLoad: { kind: 'redacted' },
    }))
    expect(row).toMatchObject({
      actionLabel: '未公开', dataLabel: '私人数据', changeLabel: '变化未公开',
      action: null, strength: null, confidence: null, actionable: false, gated: true,
    })
    expect(row.mainReason).toContain('不表示快照不存在')
  })

  it('filters action directions, abnormalities and non-null moves, then sorts nulls last', () => {
    const buy = source()
    const sellResult = result('sell', 90)
    sellResult.code = sellResult.decision.fund_code = sellResult.evidence.fund_code = sellResult.holding.fund_code = '000002'
    const sell = source({ code: '000002', name: '卖出基金', result: sellResult, change: -2, diff: diff({ current_action: 'sell' }) })
    const missing = source({
      code: '000003', name: '无快照基金', result: null, diff: null, change: null,
      load: { kind: 'missing' }, diffLoad: { kind: 'missing' }, changeCaption: '涨跌',
    })
    const sources = [missing, buy, sell]

    expect(filterAndSortWatchDecisions(sources, 'buy', 'action').map(row => row.code)).toEqual(['000001'])
    expect(filterAndSortWatchDecisions(sources, 'sell', 'action').map(row => row.code)).toEqual(['000002'])
    expect(filterAndSortWatchDecisions(sources, 'abnormal', 'action').map(row => row.code)).toEqual(['000003'])
    expect(filterAndSortWatchDecisions(sources, 'rise', 'change').map(row => row.code)).toEqual(['000001'])
    expect(filterAndSortWatchDecisions(sources, 'fall', 'change').map(row => row.code)).toEqual(['000002'])
    expect(filterAndSortWatchDecisions(sources, 'all', 'confidence').map(row => row.code)).toEqual(['000002', '000001', '000003'])
    expect(filterAndSortWatchDecisions(sources, 'all', 'change').map(row => row.code)).toEqual(['000001', '000002', '000003'])
  })
})
