import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
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
  return {
    code: options.code,
    name: `基金 ${options.code}`,
    type: '混合型',
    action: options.action,
    action_label: options.actionLabel ?? options.action,
    confidence: options.confidence ?? 80,
    strength: options.strength ?? 70,
    summary: '测试摘要',
    decision: {
      decision_id: `decision-${options.code}`,
      reasons: ['结构化原因'],
      invalidation_conditions: ['数据过期时重新评估'],
      created_at: '2026-08-28T06:30:00Z',
    },
    evidence: {
      evidence_strength: 75,
      stale_fields: options.stale ? ['official_nav'] : [],
      source_states: options.stale ? [{ stale: true, state: 'stale' }] : [],
      created_at: '2026-08-28T06:30:00Z',
      market_time: '2026-08-28T06:30:00Z',
      official_nav: null,
      official_nav_date: null,
      target_nav_date: null,
    },
    diff: {
      previous_decision_id: null,
      changed: false,
      drivers: [],
    },
  } as unknown as V8DecisionResult
}

describe('HomeActionCenter decision semantics', () => {
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
    expect(homeDisplayAction(decisions[3])).toBe('观察')
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

    expect(ordered.map((item) => item.code)).toEqual(['000001', '000002', '000004', '000003'])
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
