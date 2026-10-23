import type { V8Action } from '@/api/client'
import { V8_STRONG_ACTION_CONFIDENCE_GATE } from './v8Decision'

export interface V8DecisionGateOptions { code?: string; now?: number | Date }
export type V8DecisionGateKind = 'invalid' | 'stale' | 'missing' | 'coverage' | 'low_confidence' | null
export interface V8DecisionGate {
  valid: boolean
  gated: boolean
  action: V8Action | null
  strong: boolean
  kind: V8DecisionGateKind
  hard: string[]
  soft: string[]
  minimumConfidence: number
}

const ACTIONS = new Set(['buy', 'dca', 'watch', 'add', 'hold', 'reduce', 'sell'])
const STRONG = new Set(['buy', 'dca', 'add', 'reduce', 'sell'])
const STATES = new Set(['healthy', 'degraded', 'stale', 'unavailable', 'unknown'])
const ESTIMATES = new Set(['fresh', 'modeled', 'delayed', 'degraded', 'latest_official', 'stale', 'unavailable'])
const DAY = 86_400_000
const MAX_AGE = 7 * DAY
type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('shape')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
    || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value') || !descriptors[key].enumerable)) throw new Error('shape')
  return value as RecordValue
}
function text(value: unknown, limit = 600): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}
function bounded(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
}
function nullable(value: unknown, low = -Infinity, high = Infinity): boolean {
  return value === null || bounded(value, low, high)
}
function list(value: unknown, limit: number, minimum = 0): value is string[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= limit && value.every(item => text(item))
}
function id(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9a-f]{64}$`).test(value)
}

/** Strict zoned timestamps; JS's rollover/date-only/local-time coercions are not evidence. */
export function v8Timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!parts) return null
  const [, year, month, day, hour, minute, second, fraction, zone, , offsetHour, offsetMinute] = parts
  if (+year! < 1 || +hour! > 23 || +minute! > 59 || +second! > 59
      || (zone !== 'Z' && (+offsetHour! > 23 || +offsetMinute! > 59))) return null
  if (v8Date(`${year}-${month}-${day}`) == null) return null
  const submillisecond = fraction ? Number(`0.${fraction}`) * 1000 % 1 : 0
  const stamp = Date.parse(value) + submillisecond
  return Number.isFinite(stamp) ? stamp : null
}

export function v8Date(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && +value.slice(0, 4) > 0
    ? date.getTime() : null
}

function nodes(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 40 && value.every(raw => {
    const node = record(raw)
    return text(node.node_id, 80) && text(node.label, 240)
      && ['valuation', 'trend', 'momentum', 'quality', 'risk', 'holding', 'portfolio', 'data_quality', 'model_accuracy', 'outcome'].includes(String(node.category))
      && ['support', 'constraint', 'neutral', 'missing'].includes(String(node.state))
      && (node.value === null || typeof node.value === 'boolean' || typeof node.value === 'string' || bounded(node.value, -Infinity, Infinity))
      && (node.source_id === null || typeof node.source_id === 'string')
  })
}

function range(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 2
    && bounded(value[0], 0, 100) && bounded(value[1], 0, 100) && value[0] <= value[1])
}

/** Pure snapshot checks, not Owner authority, authentication, or permission to trade. */
export function inspectV8Decision(value: unknown, options: V8DecisionGateOptions = {}): V8DecisionGate {
  const hard: string[] = []
  const soft: string[] = []
  let action: V8Action | null = null
  let minimumConfidence = V8_STRONG_ACTION_CONFIDENCE_GATE
  let kind: V8DecisionGateKind = null
  let valid = true
  const issue = (category: Exclude<V8DecisionGateKind, null>, message: string) => {
    hard.push(message)
    if (category === 'invalid') { valid = false; kind = 'invalid' }
    else if (kind !== 'invalid' && (kind == null || kind === 'low_confidence')) kind = category
  }
  try {
    const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now()
    if (!Number.isFinite(now)) throw new Error('clock')
    const result = record(value)
    const decision = record(result.decision)
    const evidence = record(result.evidence)
    const holding = record(result.holding)
    const policy = record(result.policy)
    if (typeof result.action === 'string' && ACTIONS.has(result.action)) action = result.action as V8Action
    if (typeof result.code !== 'string' || !/^[0-9]{6}$/.test(result.code)
      || (options.code !== undefined && result.code !== options.code)
      || [decision.fund_code, evidence.fund_code, holding.fund_code].some(code => code !== result.code)) issue('invalid', '快照基金代码不一致')
    if (!text(result.type, 120) || result.type !== evidence.fund_type) issue('invalid', '基金类型与证据不一致')
    if (decision.schema_version !== 'v8-decision-1' || evidence.schema_version !== 'v8-evidence-1'
      || holding.schema_version !== 'v8-holding-1' || policy.schema_version !== 'v8-policy-1'
      || !id(decision.decision_id, 'dec') || !id(evidence.evidence_id, 'ev')
      || !id(holding.holding_version, 'hold') || !id(policy.policy_version, 'pol')) issue('invalid', '快照结构或标识不完整')
    if (decision.evidence_id !== evidence.evidence_id || decision.holding_version !== holding.holding_version
      || decision.policy_version !== policy.policy_version) issue('invalid', '决策链不完整或引用不一致')
    if (!action || decision.action !== action || !text(result.action_label) || !text(result.summary)
      || decision.summary !== result.summary || !text(decision.strategy_version, 120)) issue('invalid', '动作字段不完整或与快照不一致')
    const held = holding.user_state === 'held'
    if (!['held', 'unheld'].includes(String(holding.user_state)) || decision.user_state !== holding.user_state
      || (action != null && !(held ? ['add', 'hold', 'reduce', 'sell'] : ['buy', 'dca', 'watch']).includes(action))) issue('invalid', '动作与持仓状态不一致')
    for (const field of ['shares', 'cost', 'market_value', 'current_weight', 'target_weight']) {
      if (!nullable(holding[field], 0, field.includes('weight') ? 100 : Infinity)) issue('invalid', '持仓数值无效，未知值不得替换为零')
    }
    if (!held && ['shares', 'market_value', 'current_weight'].some(field => typeof holding[field] === 'number' && holding[field] > 0)) issue('invalid', '空仓快照包含正持仓')
    if (!Number.isInteger(result.strength) || !bounded(result.strength, 0, 100)
      || !Number.isInteger(result.confidence) || !bounded(result.confidence, 0, 100)) issue('invalid', '强度或置信度缺失或无效')
    if (decision.strength !== result.strength || decision.confidence !== result.confidence) issue('invalid', '决策指标与快照不一致')
    if (decision.position_guidance !== null) {
      const position = record(decision.position_guidance)
      if (!nullable(position.current_weight, 0, 100) || !nullable(position.target_weight, 0, 100)
        || !nullable(position.suggested_change, -100, 100) || !nullable(position.amount, 0)
        || !range(position.target_range) || !range(position.suggested_range)
        || typeof position.precise !== 'boolean' || !text(position.method, 240)) issue('invalid', '仓位建议数值或范围无效')
    }
    if (!list(decision.reason_codes, 30, 1) || decision.reason_codes[0] !== `ACTION_${action?.toUpperCase()}`
      || !list(decision.reasons, 30, 1) || !list(decision.risks, 30)
      || !list(decision.invalidation_codes, 30, 1) || !list(decision.invalidation_conditions, 30, 1)
      || !nodes(decision.evidence_nodes) || !nodes(evidence.evidence_nodes)) issue('invalid', '决策原因或证据字段不完整')

    const stamp = (raw: unknown, label: string): number | null => {
      const parsed = v8Timestamp(raw)
      if (parsed == null || parsed > now) issue('invalid', `${label}时间无效或晚于当前时间`)
      return parsed
    }
    const decisionAt = stamp(decision.created_at, '决策')
    const evidenceAt = stamp(evidence.created_at, '证据')
    const holdingAt = stamp(holding.created_at, '持仓')
    const policyAt = stamp(policy.created_at, '策略')
    const effectiveAt = stamp(policy.effective_at, '策略生效')
    if (decisionAt != null && [evidenceAt, holdingAt, policyAt, effectiveAt].some(at => at != null && at > decisionAt)) issue('invalid', '决策引用了晚于自身的快照')
    if (holding.updated_at !== null) {
      const updated = stamp(holding.updated_at, '持仓更新')
      if (updated != null && holdingAt != null && updated > holdingAt) issue('invalid', '持仓更新时间晚于快照')
    }
    if ((decisionAt != null && now - decisionAt > MAX_AGE) || (evidenceAt != null && now - evidenceAt > MAX_AGE)) issue('stale', '快照已超过七天，只作历史记录')
    if (evidence.market_time !== null) {
      const marketAt = stamp(evidence.market_time, '行情')
      if (marketAt != null && evidenceAt != null && marketAt > evidenceAt) issue('invalid', '行情时间晚于证据快照')
      if (marketAt != null && now - marketAt > MAX_AGE) issue('stale', '行情证据已过期')
    }
    const officialDate = v8Date(evidence.official_nav_date)
    const today = Math.floor((now + 8 * 3_600_000) / DAY) * DAY
    if ((evidence.official_nav === null) !== (evidence.official_nav_date === null)
      || !nullable(evidence.official_nav, Number.MIN_VALUE)
      || (evidence.official_nav_date !== null && (officialDate == null || officialDate > today))) issue('invalid', '正式净值与日期无效或不一致')
    if (officialDate != null && evidenceAt != null && officialDate > Math.floor((evidenceAt + 8 * 3_600_000) / DAY) * DAY) issue('invalid', '正式净值日期晚于证据快照')
    if (evidence.official_nav === null) issue('missing', '正式净值或日期缺失')
    if (officialDate != null && today - officialDate > MAX_AGE) issue('stale', '正式净值基准已超过七天')
    if (!nullable(evidence.estimate, -100, 1000)) issue('invalid', '估值数值无效')
    for (const field of ['valuation_percentile', 'market_temperature', 'estimate_direction_accuracy']) {
      if (!nullable(evidence[field], 0, 100)) issue('invalid', '证据数值无效')
    }
    for (const field of ['volatility', 'estimate_error_p80', 'estimate_mae']) {
      if (!nullable(evidence[field], 0)) issue('invalid', '证据数值无效')
    }
    if (!nullable(evidence.drawdown) || (evidence.estimate_sample_count !== null
      && (!Number.isSafeInteger(evidence.estimate_sample_count) || !bounded(evidence.estimate_sample_count, 0, Infinity)))) issue('invalid', '证据数值无效')
    if (evidence.target_nav_date !== null) {
      const target = v8Date(evidence.target_nav_date)
      if (target == null || officialDate == null || target <= officialDate || evidence.estimate === null) issue('invalid', '下一净值估算目标日与正式基准不一致')
      else soft.push('下一净值估算尚非已实现收益')
    }
    if (!bounded(evidence.score_coverage, 0, 1) || !bounded(evidence.timing_coverage, 0, 1)
      || !bounded(evidence.evidence_strength, 0, 100) || !nullable(evidence.score, 0, 100)
      || !nullable(evidence.estimate_coverage, 0, 100)) issue('invalid', '评分覆盖率或证据强度无效')
    if (bounded(evidence.score_coverage, 0, 1) && evidence.score_coverage < 0.7) issue('coverage', '评分覆盖率低于 70%，强动作暂停')
    if (evidence.score === null) issue('missing', '评分证据缺失')
    if (!list(evidence.stale_fields, 50) || !list(evidence.missing_fields, 50) || !list(evidence.risk_flags, 50)) issue('invalid', '数据状态字段不完整')
    else {
      if (evidence.stale_fields.length) issue('stale', `数据过期：${evidence.stale_fields.slice(0, 2).join('、')}`)
      if (evidence.missing_fields.length) issue('missing', `数据缺失：${evidence.missing_fields.slice(0, 2).join('、')}`)
    }
    if (typeof evidence.estimate_status !== 'string' || !ESTIMATES.has(evidence.estimate_status)) issue('invalid', '估值状态未知')
    else if (['stale', 'unavailable'].includes(evidence.estimate_status)) issue('stale', evidence.estimate_status === 'stale' ? '估值证据已过期' : '估值证据不可用')
    else if (['degraded', 'modeled', 'delayed'].includes(evidence.estimate_status)) soft.push('估值证据已降级')
    if (evidence.estimate_status === 'modeled' && (!bounded(evidence.estimate_coverage, 0, 100) || evidence.estimate_coverage < 70)) issue('coverage', '模型覆盖率不足 70%，强动作暂停')
    if (!Array.isArray(evidence.source_states) || evidence.source_states.length > 30) issue('invalid', '数据源状态字段不完整')
    else for (const raw of evidence.source_states) {
      const source = record(raw)
      if (!text(source.source_id, 120) || !STATES.has(String(source.state)) || typeof source.stale !== 'boolean'
        || !nullable(source.latency_ms, 0) || !nullable(source.data_age_seconds, 0)) { issue('invalid', '数据源状态无效'); continue }
      for (const field of ['last_success', 'last_failure']) {
        if (source[field] !== null) {
          const at = stamp(source[field], `${source.source_id} ${field === 'last_success' ? '成功' : '失败'}`)
          if (at != null && evidenceAt != null && at > evidenceAt) issue('invalid', `${source.source_id} 来源时间晚于证据快照`)
        }
      }
      if (source.stale || ['stale', 'unavailable'].includes(String(source.state))) issue('stale', `${source.source_id} 已过期或不可用`)
      if (source.state === 'degraded' || source.state === 'unknown') soft.push(`${source.source_id} ${source.state === 'unknown' ? '状态待确认' : '已降级'}`)
      const lastSuccess = v8Timestamp(source.last_success)
      // Recorded age is measured at evidence creation, so elapsed page time
      // must be added; an old snapshot's age cannot remain frozen forever.
      const age = typeof source.data_age_seconds === 'number' && evidenceAt != null
        ? source.data_age_seconds * 1000 + Math.max(0, now - evidenceAt) : null
      if ((lastSuccess != null && now - lastSuccess > MAX_AGE) || (age != null && age > MAX_AGE)) issue('stale', `${source.source_id} 来源已超过七天`)
    }
    const rules = record(policy.dca_rules)
    const reduceRules = record(policy.reduce_rules)
    const sellRules = record(policy.sell_rules)
    const allocations = record(policy.target_allocations)
    const ranges = record(policy.target_ranges)
    if (!text(policy.name, 120) || !text(policy.source, 120)
      || !nullable(policy.max_single_fund_weight, Number.MIN_VALUE, 100)
      || !nullable(policy.max_theme_weight, Number.MIN_VALUE, 100) || !nullable(policy.rebalance_band, 0, 50)
      || (policy.supersedes !== null && !id(policy.supersedes, 'pol'))
      || Object.keys(allocations).length > 100 || Object.keys(ranges).length > 100
      || Object.values(allocations).some(weight => !bounded(weight, 0, 100))
      || Object.values(allocations).reduce<number>((sum, weight) => sum + (typeof weight === 'number' ? weight : 0), 0) > 100 + 1e-9
      || Object.values(ranges).some(bounds => bounds === null || !range(bounds))) issue('invalid', '策略仓位范围或数值无效')
    if ([rules, reduceRules].some(rule => rule.max_step_percent !== undefined && !bounded(rule.max_step_percent, Number.MIN_VALUE, 100))
      || (sellRules.require_structural_invalidation !== undefined && typeof sellRules.require_structural_invalidation !== 'boolean')) issue('invalid', '策略动作护栏无效')
    const policyMin = rules.minimum_confidence
    if (policyMin !== undefined && !bounded(policyMin, 0, 100)) issue('invalid', '策略置信度门槛无效')
    if (action && ['buy', 'dca', 'add', 'sell'].includes(action)) minimumConfidence = Math.max(60,
      action === 'sell' ? 75 : action === 'buy' || action === 'add' ? 65 : 60,
      typeof policyMin === 'number' && Number.isFinite(policyMin) ? policyMin : 0)
    if (action && STRONG.has(action) && bounded(result.confidence, 0, 100) && result.confidence < minimumConfidence) issue('low_confidence', `置信度低于 ${minimumConfidence}，强动作暂停`)
  } catch {
    issue('invalid', '快照结构不完整，当前动作暂停')
  }
  return { valid, gated: hard.length > 0, action, strong: action != null && STRONG.has(action), kind,
    hard: [...new Set(hard)], soft: [...new Set(soft)], minimumConfidence }
}
