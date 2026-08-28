import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  V8DecisionResult,
  V8EvidenceSnapshot,
  V8FundOutcomes,
} from '@/api/client'
import {
  buildV8DetailDecisionDisplay,
  buildV8DataNotices,
  collectV8OutcomeRows,
  formatV8Number,
  formatV8Percent,
  immutableDecisionFields,
  pendingForDecision,
  v8EstimateAxisLabel,
} from './fundDetailV8Presenter'
import { V8_STRONG_ACTION_CONFIDENCE_GATE } from '@/utils/v8Decision'

function evidence(overrides: Partial<V8EvidenceSnapshot> = {}): V8EvidenceSnapshot {
  return {
    schema_version: 'v8-evidence-1',
    evidence_id: `ev_${'1'.repeat(64)}`,
    fund_code: '018147',
    fund_name: '海外科技 QDII',
    fund_type: 'QDII-普通股票',
    created_at: '2026-08-28T14:30:00+08:00',
    market_time: '2026-08-28T14:29:00+08:00',
    official_nav: 1.2345,
    official_nav_date: '2026-08-27',
    target_nav_date: '2026-08-28',
    benchmark_id: null,
    valuation_percentile: null,
    trend_state: 'up',
    momentum_state: 'neutral',
    drawdown: null,
    volatility: null,
    market_temperature: null,
    score: 82,
    score_version: 'score-v1',
    score_coverage: 0.8,
    timing_signal: 'watch',
    timing_coverage: 0.9,
    estimate: 1.2,
    estimate_status: 'fresh',
    estimate_coverage: 76,
    estimate_model_version: 'qdii-v1',
    estimate_error_p80: null,
    estimate_sample_count: 8,
    estimate_mae: null,
    estimate_direction_accuracy: null,
    source_states: [],
    evidence_nodes: [],
    evidence_strength: 78,
    missing_fields: [],
    stale_fields: [],
    risk_flags: [],
    ...overrides,
  }
}

function decisionResult(overrides: Record<string, unknown> = {}): V8DecisionResult {
  return {
    code: '018147',
    name: '海外科技 QDII',
    type: 'QDII-普通股票',
    action: 'reduce',
    action_label: '减仓',
    strength: 78,
    confidence: 82,
    summary: '当前仓位超出政策目标',
    evidence: evidence(),
    holding: {
      user_state: 'held', current_weight: 28, target_weight: 12,
    },
    decision: {
      action: 'reduce', strength: 78, confidence: 82,
      position_guidance: {
        current_weight: 28, target_weight: 12, target_range: [10, 14],
        suggested_change: -16, suggested_range: [14, 18], amount: 16000,
        method: '超配回归目标区间', precise: true,
      },
    },
    ...overrides,
  } as unknown as V8DecisionResult
}

describe('FundDetail V8 presenter', () => {
  it('keeps null distinct from a real zero', () => {
    expect(formatV8Percent(null)).toBe('—')
    expect(formatV8Percent(0)).toBe('0.00%')
    expect(formatV8Number(undefined)).toBe('—')
    expect(formatV8Number(0)).toBe('0.00')
  })

  it('explains exact QDII target date without mixing the official NAV date', () => {
    const notices = buildV8DataNotices(evidence())
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toContain('2026-08-28')
    expect(notices[0].text).toContain('正式净值基准日 2026-08-27')
    expect(notices[0].text).toContain('两个日期不混用')
    expect(v8EstimateAxisLabel(evidence())).toBe('下一净值估算涨跌')
    expect(v8EstimateAxisLabel(evidence({ target_nav_date: null }))).toBe('下一净值估算涨跌')
    expect(v8EstimateAxisLabel(evidence({ fund_type: '指数型', fund_name: '宽基指数', target_nav_date: null }))).toBe('盘中估值涨跌')
  })

  it('makes stale and missing evidence explicit and never substitutes zero', () => {
    const notices = buildV8DataNotices(evidence({
      target_nav_date: null,
      official_nav: null,
      official_nav_date: null,
      missing_fields: ['official_nav', 'market_temperature'],
      stale_fields: ['score'],
      source_states: [{
        source_id: 'score-source', state: 'unavailable', last_success: null, last_failure: null,
        latency_ms: null, data_age_seconds: 90000, stale: false, error_class: null,
      }, {
        source_id: 'estimate-source', state: 'degraded', last_success: null, last_failure: null,
        latency_ms: null, data_age_seconds: null, stale: false, error_class: null,
      }],
    }))
    expect(notices.map((notice) => notice.key)).toEqual([
      'qdii-target-missing', 'stale', 'degraded', 'missing', 'official-nav-missing',
    ])
    expect(notices.find((notice) => notice.key === 'missing')?.text).toContain('未替换成 0')
    expect(notices.find((notice) => notice.key === 'stale')?.tone).toBe('danger')
  })

  it('shows mature zero-return outcomes as zero and pending axes as pending', () => {
    const decisionId = `dec_${'2'.repeat(64)}`
    const data = {
      fund_code: '018147',
      total: 1,
      items: [{
        decision: { decision_id: decisionId },
        outcomes: [{
          outcome_id: `out_${'3'.repeat(64)}`,
          evaluation_kind: 'qdii_target',
          horizon: 0,
          base_nav_date: '2026-08-27',
          evaluation_date: '2026-08-28',
          target_nav_date: '2026-08-28',
          absolute_return: 0,
          max_drawdown: 0,
          peer_excess: 0,
          predicted_change: 0,
          prediction_error: 0,
          hit: true,
        }],
        pending_horizons: [5, 20],
        unavailable_horizons: [60],
        qdii_target_pending: true,
      }],
    } as unknown as V8FundOutcomes

    const rows = collectV8OutcomeRows(data)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      returnText: '0.00%',
      drawdownText: '0.00%',
      peerExcessText: '0.00%',
      predictionText: '0.00%',
      predictionErrorText: '0.00%',
    })
    expect(pendingForDecision(data, decisionId)).toEqual({
      pendingHorizons: [5, 20],
      unavailableHorizons: [60],
      qdiiTargetPending: true,
    })
  })

  it('passes action and numeric decision fields through without AI rewriting', () => {
    const raw = {
      action: 'reduce',
      action_label: '减仓',
      strength: 63,
      confidence: 71,
      summary: '仓位超出策略上限',
    } as V8DecisionResult
    expect(immutableDecisionFields(raw)).toEqual({
      action: 'reduce',
      actionLabel: '减仓',
      strength: 63,
      confidence: 71,
      summary: '仓位超出策略上限',
    })
  })

  it('fails a stale held overweight strong action closed and preserves raw audit values', () => {
    const raw = decisionResult({
      evidence: evidence({
        stale_fields: ['market_time'],
        source_states: [{
          source_id: 'estimate:model', state: 'unavailable', stale: false,
          last_success: null, last_failure: null, latency_ms: null,
          data_age_seconds: null, error_class: 'source_timeout',
        }],
      }),
    })
    const before = JSON.stringify(raw)
    const display = buildV8DetailDecisionDisplay(raw)

    expect(display).toMatchObject({
      gated: true,
      gateKind: 'stale',
      displayActionLabel: '暂停动作',
      displayActionCode: 'paused',
      rawActionLabel: '减仓',
      rawActionCode: 'reduce',
      positionExecutionAllowed: false,
    })
    expect(display.gateReason).toContain('过期字段：market_time')
    expect(display.gateReason).toContain('estimate:model 不可用')
    expect(raw.holding.user_state).toBe('held')
    expect(raw.decision.position_guidance?.current_weight).toBe(28)
    expect(raw.decision.position_guidance?.target_weight).toBe(12)
    expect(raw.decision.position_guidance?.suggested_change).toBe(-16)
    expect(JSON.stringify(raw)).toBe(before)
  })

  it('turns a low-confidence strong action into observation at the shared 55 gate', () => {
    const low = decisionResult({
      action: 'buy', action_label: '买入', confidence: V8_STRONG_ACTION_CONFIDENCE_GATE - 1,
      decision: { action: 'buy', confidence: V8_STRONG_ACTION_CONFIDENCE_GATE - 1 },
      evidence: evidence({ target_nav_date: null, fund_type: '指数型', fund_name: '宽基指数' }),
    })
    expect(buildV8DetailDecisionDisplay(low)).toMatchObject({
      gated: true,
      gateKind: 'low_confidence',
      displayActionLabel: '观察',
      displayActionCode: 'watch',
      rawActionLabel: '买入',
      rawActionCode: 'buy',
      positionExecutionAllowed: false,
    })

    const atGate = decisionResult({
      confidence: V8_STRONG_ACTION_CONFIDENCE_GATE,
      evidence: evidence({ target_nav_date: null, fund_type: '指数型', fund_name: '宽基指数' }),
    })
    expect(buildV8DetailDecisionDisplay(atGate).gated).toBe(false)
  })
})

describe('FundDetail V8 information hierarchy', () => {
  it('places all six read-only layers before legacy metrics', () => {
    const page = readFileSync(new URL('../pages/FundDetailPage.vue', import.meta.url), 'utf8')
    const panel = readFileSync(new URL('./FundDetailV8Panel.vue', import.meta.url), 'utf8')
    expect(page.indexOf('<FundDetailV8Panel')).toBeGreaterThan(-1)
    expect(page.indexOf('<FundDetailV8Panel')).toBeLessThan(page.indexOf('class="legacy-divider"'))
    expect(page.indexOf('class="legacy-divider"')).toBeLessThan(page.indexOf('class="est card"'))

    const layers = [
      'decision-card',
      'decision-diff',
      'position-guidance',
      'evidence-graph',
      'risk-invalidation',
      'historical-outcome',
    ]
    let previous = -1
    for (const layer of layers) {
      const next = panel.indexOf(`data-layer="${layer}"`)
      expect(next).toBeGreaterThan(previous)
      previous = next
    }
  })

  it('contains explicit missing, pending, stale and 404 explanations', () => {
    const panel = readFileSync(new URL('./FundDetailV8Panel.vue', import.meta.url), 'utf8')
    expect(panel).toContain("error.status === 404")
    expect(panel).toContain('404 表示“还没有生成记录”')
    expect(panel).toContain('尚无已成熟的 Outcome')
    expect(panel).toContain('缺失时不顺延配对')
    expect(panel).toContain('— 表示未计算，不是 0')
    expect(panel).toContain('AI 不能改写')
    expect(panel).toContain('原快照动作（审计保留）')
    expect(panel).toContain('仓位动作已暂停')
  })
})
