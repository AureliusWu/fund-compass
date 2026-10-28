import type { V8Action, V8DecisionResult } from '@/api/client'
import { V8_STRONG_ACTION_CONFIDENCE_GATE } from '@/utils/v8Decision'
import { inspectV8Decision, type V8DecisionGateOptions } from '@/utils/v8DecisionGate'

export const HOME_ACTION_CONFIDENCE_GATE = V8_STRONG_ACTION_CONFIDENCE_GATE

export type HomeDecisionErrorKind = 'missing' | 'failed' | 'redacted'

export interface HomeDecisionError {
  code: string
  name: string | null
  kind: HomeDecisionErrorKind
}

export interface HomeActionSummary {
  action: number
  hold: number
  watch: number
  dataIssues: number
  missing: number
  failed: number
  redacted: number
}

const ACTIONABLE = new Set<V8Action>(['buy', 'dca', 'add', 'reduce', 'sell'])
const PRIORITY: Record<V8Action, number> = {
  sell: 0,
  reduce: 1,
  buy: 2,
  add: 3,
  dca: 4,
  watch: 5,
  hold: 6,
}

export function isActionableAction(action: V8Action): boolean {
  return ACTIONABLE.has(action)
}

export function isV8DecisionStale(result: V8DecisionResult, options?: V8DecisionGateOptions | number): boolean {
  // Array.filter supplies its index as the second argument; it is not a clock.
  const gate = inspectV8Decision(result, typeof options === 'number' ? undefined : options)
  return gate.gated && gate.kind !== 'low_confidence'
}

export function isV8DecisionLowConfidence(result: V8DecisionResult, options?: V8DecisionGateOptions | number): boolean {
  return inspectV8Decision(result, typeof options === 'number' ? undefined : options).kind === 'low_confidence'
}

/**
 * A stale or low-confidence strong action is grouped as observation on the home page.
 * The immutable snapshot action remains visible as metadata on the card.
 */
export function homeActionBucket(result: V8DecisionResult, options?: V8DecisionGateOptions): 'action' | 'hold' | 'watch' {
  const gate = inspectV8Decision(result, options)
  if (gate.gated) return 'watch'
  if (gate.action === 'hold') return 'hold'
  return gate.strong ? 'action' : 'watch'
}

export function summarizeHomeActions(
  decisions: V8DecisionResult[],
  errors: HomeDecisionError[],
  options?: V8DecisionGateOptions,
): HomeActionSummary {
  const summary: HomeActionSummary = {
    action: 0,
    hold: 0,
    watch: 0,
    dataIssues: errors.length,
    missing: 0,
    failed: 0,
    redacted: 0,
  }
  for (const decision of decisions) {
    summary[homeActionBucket(decision, options)] += 1
    if (isV8DecisionStale(decision, options)) summary.dataIssues += 1
  }
  for (const error of errors) summary[error.kind] += 1
  return summary
}

export function sortHomeActions(decisions: V8DecisionResult[], options?: V8DecisionGateOptions): V8DecisionResult[] {
  return [...decisions].sort((left, right) => {
    const leftGated = homeActionBucket(left, options) === 'action' ? 0 : 1
    const rightGated = homeActionBucket(right, options) === 'action' ? 0 : 1
    if (leftGated !== rightGated) return leftGated - rightGated
    const actionOrder = (PRIORITY[left?.action] ?? 99) - (PRIORITY[right?.action] ?? 99)
    if (actionOrder !== 0) return actionOrder
    for (const field of ['confidence', 'strength'] as const) {
      const a = typeof left?.[field] === 'number' && Number.isFinite(left[field]) ? left[field] : -1
      const b = typeof right?.[field] === 'number' && Number.isFinite(right[field]) ? right[field] : -1
      if (a !== b) return b - a
    }
    return String(left?.code ?? '').localeCompare(String(right?.code ?? ''))
  })
}

export function homeDisplayAction(result: V8DecisionResult, options?: V8DecisionGateOptions): string {
  if (inspectV8Decision(result, options).gated) return '暂停动作'
  return result.action_label
}

export function homeActionTone(result: V8DecisionResult, options?: V8DecisionGateOptions): string {
  if (inspectV8Decision(result, options).gated) return 'watch'
  if (result.action === 'buy' || result.action === 'add') return 'buy'
  if (result.action === 'dca' || result.action === 'watch') return 'watch'
  if (result.action === 'reduce' || result.action === 'sell') return 'reduce'
  return 'hold'
}

export function primaryDecisionReason(result: V8DecisionResult, options?: V8DecisionGateOptions): string {
  const gate = inspectV8Decision(result, options)
  if (gate.gated) return `${gate.hard.join('；')}。原快照只作历史记录，当前动作暂停。`
  return result.decision.reasons[0] || result.summary || '当前快照未提供原因说明。'
}

export function decisionChangeText(result: V8DecisionResult): string {
  const diff = result?.diff
  if (!diff || !Array.isArray(diff.drivers) || typeof diff.changed !== 'boolean'
    || diff.drivers.some(value => typeof value !== 'string')
    || (diff.previous_decision_id !== null && !/^dec_[0-9a-f]{64}$/.test(diff.previous_decision_id))
    || diff.current_decision_id !== result.decision?.decision_id || diff.current_action !== result.action) return '未提供可核对的历史比较'
  if (diff.previous_decision_id === null && diff.previous_action === null) return '首次建立 V8 决策快照'
  if (!diff.changed) return '行动未变化'
  if (diff.drivers.length) return diff.drivers.filter(value => typeof value === 'string').join('；')
  return '快照已变化，但未提供可展示的驱动因素。'
}

export function formatNullableNumber(value: number | null, digits = 4): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

export function formatCstTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}
