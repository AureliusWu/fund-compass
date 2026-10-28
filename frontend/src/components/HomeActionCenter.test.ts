import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V8Action, V8DecisionResult } from '@/api/client'
import {
  formatNullableNumber,
  homeDisplayAction,
  sortHomeActions,
  summarizeHomeActions,
  type HomeDecisionError,
} from './homeActionCenter'

function makeDecision(options: {
  code: string
  action: V8Action
  actionLabel?: string
  confidence?: number
  strength?: number
  stale?: boolean
}): V8DecisionResult {
  const held = ['add', 'hold', 'reduce', 'sell'].includes(options.action)
  const suffix = options.code.padStart(64, '0')
  const confidence = options.confidence ?? 80
  const strength = options.strength ?? 70
  const at = '2026-08-28T06:30:00Z'
  return {
    code: options.code,
    name: `基金 ${options.code}`,
    type: '混合型',
    action: options.action,
    action_label: options.actionLabel ?? options.action,
    confidence,
    strength,
    summary: '测试摘要',
    decision: {
      schema_version: 'v8-decision-1', decision_id: `dec_${suffix}`, evidence_id: `ev_${suffix}`,
      fund_code: options.code, holding_version: `hold_${suffix}`, policy_version: `pol_${suffix}`,
      strategy_version: 'decision-v2', user_state: held ? 'held' : 'unheld', action: options.action,
      strength, confidence, summary: '测试摘要', reason_codes: [`ACTION_${options.action.toUpperCase()}`],
      reasons: ['结构化原因'],
      risks: [], invalidation_codes: ['DATA_STALE'], position_guidance: null, evidence_nodes: [],
      invalidation_conditions: ['数据过期时重新评估'],
      created_at: '2026-08-28T06:30:00Z',
    },
    evidence: {
      schema_version: 'v8-evidence-1', evidence_id: `ev_${suffix}`, fund_code: options.code,
      fund_name: `基金 ${options.code}`, fund_type: '混合型', benchmark_id: null,
      valuation_percentile: 20, trend_state: '上升趋势', momentum_state: null,
      drawdown: null, volatility: null, market_temperature: null, score: 80, score_version: 'score-v1',
      score_coverage: 0.8, timing_coverage: 0.8, timing_signal: '买入', estimate: 0,
      estimate_status: 'fresh', estimate_coverage: null, estimate_model_version: null,
      estimate_error_p80: null, estimate_sample_count: null, estimate_mae: null, estimate_direction_accuracy: null,
      evidence_nodes: [], missing_fields: [], risk_flags: [],
      evidence_strength: 75,
      stale_fields: options.stale ? ['official_nav'] : [],
      source_states: [{ source_id: 'fixture', stale: !!options.stale, state: options.stale ? 'stale' : 'healthy',
        last_success: at, last_failure: null, latency_ms: 0, data_age_seconds: 0, error_class: null }],
      created_at: '2026-08-28T06:30:00Z',
      market_time: '2026-08-28T06:30:00Z',
      official_nav: 1,
      official_nav_date: '2026-08-27',
      target_nav_date: null,
    },
    holding: { schema_version: 'v8-holding-1', holding_version: `hold_${suffix}`, fund_code: options.code,
      user_state: held ? 'held' : 'unheld', shares: held ? 1 : 0, market_value: held ? 1 : 0,
      cost: null, current_weight: held ? 10 : 0, target_weight: null, account: null,
      source: 'fixture', updated_at: null, created_at: at },
    policy: { schema_version: 'v8-policy-1', policy_version: `pol_${suffix}`, name: '合成策略',
      target_allocations: {}, target_ranges: {}, max_single_fund_weight: 40, max_theme_weight: 60,
      rebalance_band: 2, dca_rules: {}, reduce_rules: {}, sell_rules: {}, source: 'fixture',
      effective_at: at, created_at: at, supersedes: null },
    diff: {
      previous_decision_id: null,
      current_decision_id: `dec_${suffix}`, current_action: options.action, previous_action: null,
      changed: false,
      drivers: [], driver_codes: [], unchanged: [],
    },
  } as unknown as V8DecisionResult
}

describe('HomeActionCenter decision semantics', () => {
  beforeEach(() => { vi.useFakeTimers().setSystemTime('2026-08-28T06:30:00Z') })
  afterEach(() => { vi.useRealTimers() })
  it('keeps stale and low-confidence strong snapshots out of the actionable count', () => {
    const decisions = [
      makeDecision({ code: '000001', action: 'buy' }),
      makeDecision({ code: '000002', action: 'hold' }),
      makeDecision({ code: '000003', action: 'watch' }),
      makeDecision({ code: '000004', action: 'add', confidence: 54 }),
      makeDecision({ code: '000005', action: 'sell', stale: true }),
    ]
    const errors: HomeDecisionError[] = [
      { code: '000006', name: null, kind: 'missing' },
      { code: '000007', name: null, kind: 'failed' },
    ]

    expect(summarizeHomeActions(decisions, errors)).toEqual({
      action: 1,
      hold: 1,
      watch: 3,
      dataIssues: 3,
      missing: 1,
      failed: 1,
      redacted: 0,
    })
    expect(homeDisplayAction(decisions[3])).toBe('暂停动作')
    expect(homeDisplayAction(decisions[4])).toBe('暂停动作')
    expect(summarizeHomeActions([
      makeDecision({ code: '000008', action: 'hold', confidence: 40 }),
    ], []).hold).toBe(1)

    const unavailableEstimate = makeDecision({ code: '000009', action: 'buy' })
    unavailableEstimate.evidence.estimate_status = 'unavailable'
    expect(homeDisplayAction(unavailableEstimate)).toBe('暂停动作')
  })

  it('sorts multiple decisions by safe actionability, then underlying urgency and confidence', () => {
    const ordered = sortHomeActions([
      makeDecision({ code: '000003', action: 'watch', confidence: 90 }),
      makeDecision({ code: '000002', action: 'buy', confidence: 70 }),
      makeDecision({ code: '000001', action: 'sell', confidence: 60 }),
      makeDecision({ code: '000004', action: 'reduce', confidence: 50 }),
    ])

    // A sell snapshot at 60 is below its actual 75 confidence gate.
    expect(ordered.map((item) => item.code)).toEqual(['000002', '000001', '000004', '000003'])
  })

  it('does not count redacted private snapshots as missing records or failed requests', () => {
    expect(summarizeHomeActions([], [{ code: '000001', name: null, kind: 'redacted' }])).toMatchObject({
      missing: 0, failed: 0, redacted: 1,
    })
  })

  it('renders missing values as an em dash while preserving a real zero', () => {
    expect(formatNullableNumber(null)).toBe('—')
    expect(formatNullableNumber(Number.NaN)).toBe('—')
    expect(formatNullableNumber(0)).toBe('0')
  })
})

describe('HomeActionCenter page contract', () => {
  it('uses V8 snapshots and names all guarded states without legacy-signal fallback', () => {
    const component = readFileSync(new URL('./HomeActionCenter.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const home = readFileSync(new URL('../pages/HomePage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

    expect(home).toContain('getV8Decision(item.code)')
    expect(home).toContain("error.status === 404\n        ? 'missing'")
    expect(home).toContain('<HomeActionCenter')
    expect(home).toContain('refreshHome(false)')
    expect(home).toContain('fetchTaskStatuses(force)')

    expect(component).toContain('尚无 V8 决策（404）')
    expect(component).toContain('部分结果不可读取')
    expect(component).toContain('私人数据未公开')
    expect(component).toContain('变化原因')
    expect(component).toContain('什么情况下会改变')
    expect(component).toContain('数据边界')
    expect(component).toContain('legacy signal')
    expect(component).not.toContain('SignalResp')
    expect(component).not.toContain('getSignal')
    expect(component).not.toMatch(/(?:\?\?|\|\|)\s*0/)
  })
})
