import { describe, expect, it } from 'vitest'
import type { V8Action, V8DecisionResult, V8FundOutcomes } from '@/api/client'
import { homeActionBucket, homeDisplayAction, primaryDecisionReason, decisionChangeText } from '@/components/homeActionCenter'
import { buildV8DetailDecisionDisplay, collectV8OutcomeRows } from '@/components/fundDetailV8Presenter'
import { buildWatchDecisionRow } from '@/components/watchlist/decisionView'
import { inspectV8Decision, v8Timestamp } from './v8DecisionGate'

const NOW = Date.parse('2026-10-23T06:00:00Z')
const AT = '2026-10-23T06:00:00Z'
const options = { now: NOW }

function snapshot(action: V8Action = 'buy', confidence = 82): V8DecisionResult {
  const held = ['add', 'hold', 'reduce', 'sell'].includes(action)
  const evidence = {
    schema_version: 'v8-evidence-1' as const, evidence_id: `ev_${'a'.repeat(64)}`,
    fund_code: '000001', fund_name: '合成海外基金', fund_type: 'QDII', created_at: AT,
    market_time: AT, official_nav: 1, official_nav_date: '2026-10-22', target_nav_date: '2026-10-26',
    benchmark_id: null, valuation_percentile: 0, trend_state: '上升趋势', momentum_state: null,
    drawdown: 0, volatility: 0, market_temperature: 0, score: 82, score_version: 'score-v1',
    score_coverage: 0.8, timing_signal: '买入', timing_coverage: 0.8, estimate: 0,
    estimate_status: 'modeled', estimate_coverage: 80, estimate_model_version: 'fixture-v1',
    estimate_error_p80: 0, estimate_sample_count: 20, estimate_mae: 0, estimate_direction_accuracy: 0,
    source_states: [{ source_id: 'estimate:fixture', state: 'degraded' as const, last_success: AT,
      last_failure: null, latency_ms: 0, data_age_seconds: 0, stale: false, error_class: null }],
    evidence_nodes: [], evidence_strength: 80, missing_fields: [], stale_fields: [], risk_flags: [],
  }
  const holding = {
    schema_version: 'v8-holding-1' as const, holding_version: `hold_${'b'.repeat(64)}`,
    fund_code: '000001', user_state: held ? 'held' as const : 'unheld' as const,
    shares: held ? 1 : 0, cost: null, market_value: held ? 1 : 0, account: null,
    current_weight: held ? 10 : 0, target_weight: null, updated_at: null,
    source: 'fixture', created_at: AT,
  }
  const policy = {
    schema_version: 'v8-policy-1' as const, policy_version: `pol_${'c'.repeat(64)}`,
    name: '合成策略', target_allocations: {}, target_ranges: {}, max_single_fund_weight: 40,
    max_theme_weight: 60, rebalance_band: 2, dca_rules: { minimum_confidence: 55 },
    reduce_rules: {}, sell_rules: {}, effective_at: AT, created_at: AT, source: 'fixture', supersedes: null,
  }
  const decision = {
    schema_version: 'v8-decision-1' as const, decision_id: `dec_${'d'.repeat(64)}`,
    evidence_id: evidence.evidence_id, fund_code: '000001', holding_version: holding.holding_version,
    policy_version: policy.policy_version, strategy_version: 'decision-v2', user_state: holding.user_state,
    action, strength: 76, confidence, summary: '合成快照原摘要', reason_codes: [`ACTION_${action.toUpperCase()}`],
    reasons: ['合成原始理由'], risks: [], invalidation_codes: ['DATA_STALE'],
    invalidation_conditions: ['数据过期需重新评估'], position_guidance: null, evidence_nodes: [], created_at: AT,
  }
  return { code: '000001', name: '合成海外基金', type: 'QDII', action, action_label: '原快照动作',
    strength: 76, confidence, summary: decision.summary, evidence, holding, policy, decision, diff: null }
}

function row(result: V8DecisionResult, now = NOW) {
  return buildWatchDecisionRow({ code: '000001', name: '合成基金', type: 'QDII', result,
    diff: null, load: { kind: 'ready' }, diffLoad: { kind: 'error' },
    change: null, changeCaption: '下一净值估算' }, { now })
}

describe('shared V8 snapshot display gate', () => {
  it('accepts a complete modeled snapshot and keeps the next-NAV axis distinct from realized results', () => {
    const result = snapshot()
    const original = structuredClone(result)
    expect(inspectV8Decision(result, options)).toMatchObject({ valid: true, gated: false, strong: true,
      action: 'buy', minimumConfidence: 65 })
    expect(inspectV8Decision(result, options).soft).toContain('下一净值估算尚非已实现收益')
    expect(homeActionBucket(result, options)).toBe('action')
    expect(buildV8DetailDecisionDisplay(result, options).positionExecutionAllowed).toBe(true)
    expect(row(result).actionable).toBe(true)
    expect(result).toEqual(original)
    expect(decisionChangeText(result)).toBe('未提供可核对的历史比较')
  })

  it.each([
    ['fund', (r: V8DecisionResult) => { r.holding.fund_code = '000002' }],
    ['reference', (r: V8DecisionResult) => { r.decision.evidence_id = `ev_${'e'.repeat(64)}` }],
    ['identifier', (r: V8DecisionResult) => { r.policy.policy_version = 'policy_1' }],
    ['held action', (r: V8DecisionResult) => { r.holding.user_state = r.decision.user_state = 'held' }],
    ['unheld positive', (r: V8DecisionResult) => { r.holding.shares = 1 }],
    ['action mismatch', (r: V8DecisionResult) => { r.decision.action = 'watch' }],
    ['confidence mismatch', (r: V8DecisionResult) => { r.decision.confidence = 80 }],
    ['nonfinite', (r: V8DecisionResult) => { r.confidence = r.decision.confidence = NaN }],
    ['boolean', (r: V8DecisionResult) => { r.strength = true as unknown as number }],
    ['metric missing', (r: V8DecisionResult) => { r.confidence = null as unknown as number }],
    ['invalid score', (r: V8DecisionResult) => { r.evidence.score = Infinity }],
    ['invalid risk value', (r: V8DecisionResult) => { r.evidence.volatility = -1 }],
    ['stale', (r: V8DecisionResult) => { r.evidence.stale_fields = ['market_time'] }],
    ['missing', (r: V8DecisionResult) => { r.evidence.missing_fields = ['valuation'] }],
    ['shape', (r: V8DecisionResult) => { r.evidence.source_states = null as unknown as [] }],
    ['bad source', (r: V8DecisionResult) => { r.evidence.source_states[0]!.stale = 'false' as unknown as boolean }],
    ['coverage', (r: V8DecisionResult) => { r.evidence.score_coverage = 0.699999 }],
    ['modeled coverage', (r: V8DecisionResult) => { r.evidence.estimate_coverage = 69.99999 }],
    ['unknown status', (r: V8DecisionResult) => { r.evidence.estimate_status = 'unknown' }],
    ['invalid date', (r: V8DecisionResult) => { r.evidence.official_nav_date = '2026-02-30' }],
    ['unpaired NAV', (r: V8DecisionResult) => { r.evidence.official_nav = null }],
    ['NAV future', (r: V8DecisionResult) => { r.evidence.official_nav_date = '2026-10-24'; r.evidence.target_nav_date = '2026-10-26' }],
    ['bad target', (r: V8DecisionResult) => { r.evidence.target_nav_date = '2026-10-22' }],
    ['negative cost', (r: V8DecisionResult) => { r.holding.cost = -1 }],
    ['policy allocation', (r: V8DecisionResult) => { r.policy.target_allocations = { stock: 80, bond: 30 } }],
    ['type mismatch', (r: V8DecisionResult) => { r.evidence.fund_type = '指数型' }],
  ] as const)('pauses all three displays for %s without modifying historical evidence', (_name, mutate) => {
    const result = snapshot()
    mutate(result)
    const original = structuredClone(result)
    expect(inspectV8Decision(result, options).gated).toBe(true)
    expect(homeActionBucket(result, options)).toBe('watch')
    expect(homeDisplayAction(result, options)).toBe('暂停动作')
    expect(primaryDecisionReason(result, options)).toContain('暂停')
    expect(buildV8DetailDecisionDisplay(result, options)).toMatchObject({ gated: true,
      displayActionLabel: '暂停动作', positionExecutionAllowed: false, rawSummary: result.summary })
    expect(row(result)).toMatchObject({ actionable: false, gated: true, actionLabel: '暂停动作' })
    expect(result).toEqual(original)
  })

  it.each([
    ['buy', 65], ['add', 65], ['dca', 60], ['sell', 75], ['reduce', 55],
  ] as const)('retains the actual %s threshold of %s', (action, threshold) => {
    const at = snapshot(action, threshold)
    const below = snapshot(action, threshold - 1)
    expect(inspectV8Decision(at, options)).toMatchObject({ gated: false, minimumConfidence: threshold })
    expect(inspectV8Decision(below, options)).toMatchObject({ gated: true, kind: 'low_confidence' })
    expect(homeDisplayAction(below, options)).toBe('暂停动作')
  })

  it('retains a higher policy minimum for data-strong actions without raising reduction to a buy threshold', () => {
    for (const action of ['buy', 'add', 'dca', 'sell'] as const) {
      const result = snapshot(action, 89)
      result.policy.dca_rules.minimum_confidence = 90
      expect(inspectV8Decision(result, options)).toMatchObject({ gated: true, minimumConfidence: 90 })
    }
    const reduce = snapshot('reduce', 55)
    reduce.policy.dca_rules.minimum_confidence = 90
    expect(inspectV8Decision(reduce, options).gated).toBe(false)
  })

  it('keeps exact coverage boundaries, zero/null, held-zero and neutral low confidence distinct', () => {
    const result = snapshot('hold', 0)
    result.strength = result.decision.strength = 0
    result.holding.shares = result.holding.market_value = result.holding.current_weight = 0
    result.evidence.score = 0
    result.evidence.score_coverage = 0.7
    result.evidence.estimate_coverage = 70
    expect(inspectV8Decision(result, options).gated).toBe(false)
    expect(homeActionBucket(result, options)).toBe('hold')
    expect(row(result)).toMatchObject({ strength: 0, confidence: 0 })
    expect(result.holding.cost).toBeNull()
    expect(result.evidence.estimate).toBe(0)
  })

  it.each(['2026-10-23T06:00:00.001Z', '2026-10-23T06:00:00.000001Z',
    '2026-10-23T06:00:00', '2026-02-30T06:00:00Z', '2026-10-23T24:00:00Z'])('rejects future, unzoned or rolled timestamps %s', at => {
    const result = snapshot()
    result.decision.created_at = at
    expect(inspectV8Decision(result, options)).toMatchObject({ gated: true, valid: false })
  })

  it('checks every referenced time and does not let the page clock freeze recorded source age', () => {
    for (const location of ['evidence', 'holding', 'policy'] as const) {
      const result = snapshot()
      result[location].created_at = '2026-10-23T06:00:01Z'
      expect(inspectV8Decision(result, options).gated).toBe(true)
    }
    const result = snapshot()
    result.evidence.source_states[0]!.data_age_seconds = 7 * 86_400
    expect(inspectV8Decision(result, options).gated).toBe(false)
    const later = { now: NOW + 1 }
    expect(inspectV8Decision(result, later)).toMatchObject({ gated: true, kind: 'stale' })
    expect(homeDisplayAction(result, later)).toBe('暂停动作')
    expect(buildV8DetailDecisionDisplay(result, later).gated).toBe(true)
    expect(row(result, NOW + 1).gated).toBe(true)
  })

  it('uses the China date boundary for official NAV and permits an explicitly labelled future estimate target', () => {
    const result = snapshot()
    const boundary = Date.parse('2026-10-23T16:00:00Z')
    result.decision.created_at = result.evidence.created_at = result.evidence.market_time =
      result.holding.created_at = result.policy.created_at = result.policy.effective_at = '2026-10-23T16:00:00Z'
    result.evidence.official_nav_date = '2026-10-24'
    expect(inspectV8Decision(result, { now: boundary }).gated).toBe(false)
    result.evidence.official_nav_date = '2026-10-25'
    expect(inspectV8Decision(result, { now: boundary }).gated).toBe(true)
  })

  it.each([null, {}, { evidence: null }, { decision: [] }])('fails malformed snapshots closed without throwing', raw => {
    const result = raw as unknown as V8DecisionResult
    expect(inspectV8Decision(result, options)).toMatchObject({ valid: false, gated: true })
    expect(() => homeDisplayAction(result, options)).not.toThrow()
    expect(() => buildV8DetailDecisionDisplay(result, options)).not.toThrow()
  })

  it('rejects accessors before executing them', () => {
    const result = snapshot()
    Object.defineProperty(result, 'code', { enumerable: true, get: () => { throw new Error('getter must not run') } })
    expect(inspectV8Decision(result, options)).toMatchObject({ valid: false, gated: true })
  })

  it('requires context fund agreement and treats an absent comparison as unknown, never first-record proof', () => {
    expect(inspectV8Decision(snapshot(), { now: NOW, code: '000002' }).gated).toBe(true)
    expect(v8Timestamp('2026-10-23T14:00:00+08:00')).toBe(NOW)
    const result = snapshot()
    expect(decisionChangeText(result)).toBe('未提供可核对的历史比较')
    result.diff = { previous_decision_id: null, current_decision_id: result.decision.decision_id,
      previous_action: null, current_action: 'buy', changed: false, drivers: [], driver_codes: [], unchanged: [] }
    expect(decisionChangeText(result)).toContain('首次')
  })

  it('keeps future QDII targets as pending instead of realized return, error or direction hits', () => {
    const outcomes = { items: [{ decision: { decision_id: `dec_${'d'.repeat(64)}` }, outcomes: [{
      evaluation_kind: 'qdii_target', horizon: 0, base_nav_date: '2026-10-22',
      target_nav_date: '2026-10-26', evaluation_date: '2026-10-26', absolute_return: 12,
      max_drawdown: -2, peer_excess: 1, predicted_change: 1.5, prediction_error: 10.5, hit: true,
    }] }] } as unknown as V8FundOutcomes
    const original = structuredClone(outcomes)
    expect(collectV8OutcomeRows(outcomes, 8, options)[0]).toMatchObject({
      returnText: '待正式净值结算', drawdownText: '—', peerExcessText: null,
      predictionText: '1.50%', predictionErrorText: null, hitText: '待正式净值结算',
    })
    outcomes.items[0]!.outcomes[0]!.evaluation_date = '2026-10-23'
    expect(collectV8OutcomeRows(outcomes, 8, options)[0]?.returnText).toBe('结果日期未核对')
    outcomes.items[0]!.outcomes[0]!.evaluation_date = '2026-10-26'
    expect(collectV8OutcomeRows(outcomes, 8, { now: Date.parse('2026-10-26T16:00:00Z') })[0]).toMatchObject({
      returnText: '12.00%', predictionErrorText: '10.50%', hitText: '方向命中',
    })
    expect(outcomes).toEqual(original)
  })
})
