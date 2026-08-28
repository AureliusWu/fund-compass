import type { V8Action, V8DecisionResult } from '@/api/client'
import { V8_STRONG_ACTION_CONFIDENCE_GATE } from '@/utils/v8Decision'

export const HOME_ACTION_CONFIDENCE_GATE = V8_STRONG_ACTION_CONFIDENCE_GATE

export type HomeDecisionErrorKind = 'missing' | 'failed'

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

export function isV8DecisionStale(result: V8DecisionResult): boolean {
  return result.evidence.stale_fields.length > 0
    || ['stale', 'unavailable'].includes(result.evidence.estimate_status)
    || result.evidence.source_states.some((source) => (
      source.stale || source.state === 'stale' || source.state === 'unavailable'
    ))
}

export function isV8DecisionLowConfidence(result: V8DecisionResult): boolean {
  return result.confidence < HOME_ACTION_CONFIDENCE_GATE
}

/**
 * A stale or low-confidence strong action is grouped as observation on the home page.
 * The immutable snapshot action remains visible as metadata on the card.
 */
export function homeActionBucket(result: V8DecisionResult): 'action' | 'hold' | 'watch' {
  if (isV8DecisionStale(result)) return 'watch'
  if (result.action === 'hold') return 'hold'
  if (result.action === 'watch' || isV8DecisionLowConfidence(result)) return 'watch'
  return isActionableAction(result.action) ? 'action' : 'watch'
}

export function summarizeHomeActions(
  decisions: V8DecisionResult[],
  errors: HomeDecisionError[],
): HomeActionSummary {
  const summary: HomeActionSummary = {
    action: 0,
    hold: 0,
    watch: 0,
    dataIssues: errors.length,
    missing: 0,
    failed: 0,
  }
  for (const decision of decisions) {
    summary[homeActionBucket(decision)] += 1
    if (isV8DecisionStale(decision)) summary.dataIssues += 1
  }
  for (const error of errors) summary[error.kind] += 1
  return summary
}

export function sortHomeActions(decisions: V8DecisionResult[]): V8DecisionResult[] {
  return [...decisions].sort((left, right) => {
    const leftGated = homeActionBucket(left) === 'action' ? 0 : 1
    const rightGated = homeActionBucket(right) === 'action' ? 0 : 1
    if (leftGated !== rightGated) return leftGated - rightGated
    const actionOrder = PRIORITY[left.action] - PRIORITY[right.action]
    if (actionOrder !== 0) return actionOrder
    if (left.confidence !== right.confidence) return right.confidence - left.confidence
    if (left.strength !== right.strength) return right.strength - left.strength
    return left.code.localeCompare(right.code)
  })
}

export function homeDisplayAction(result: V8DecisionResult): string {
  if (isActionableAction(result.action) && isV8DecisionStale(result)) return '暂停动作'
  if (isActionableAction(result.action) && isV8DecisionLowConfidence(result)) return '观察'
  return result.action_label
}

export function homeActionTone(result: V8DecisionResult): string {
  if (isV8DecisionStale(result) || isV8DecisionLowConfidence(result)) return 'watch'
  if (result.action === 'buy' || result.action === 'add') return 'buy'
  if (result.action === 'dca' || result.action === 'watch') return 'watch'
  if (result.action === 'reduce' || result.action === 'sell') return 'reduce'
  return 'hold'
}

export function primaryDecisionReason(result: V8DecisionResult): string {
  if (isV8DecisionStale(result)) return '关键证据已过期，当前结论只作观察，等待新快照后再评估。'
  if (isV8DecisionLowConfidence(result) && isActionableAction(result.action)) {
    return '证据置信度未达强动作门槛，原快照动作仅作背景记录。'
  }
  return result.decision.reasons[0] || result.summary || '当前快照未提供原因说明。'
}

export function decisionChangeText(result: V8DecisionResult): string {
  if (!result.diff.previous_decision_id) return '首次建立 V8 决策快照'
  if (!result.diff.changed) return '行动未变化'
  if (result.diff.drivers.length) return result.diff.drivers.join('；')
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
