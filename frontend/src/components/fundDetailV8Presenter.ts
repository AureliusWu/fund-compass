import type {
  V8Action,
  V8DecisionResult,
  V8EvidenceNode,
  V8EvidenceSnapshot,
  V8FundOutcomes,
} from '@/api/client'
import { inspectV8Decision, v8Date, type V8DecisionGateKind, type V8DecisionGateOptions } from '@/utils/v8DecisionGate'

export type V8NoticeTone = 'info' | 'warning' | 'danger'

export interface V8DataNotice {
  key: string
  tone: V8NoticeTone
  text: string
}

export interface V8OutcomeRow {
  key: string
  decisionId: string
  title: string
  axis: string
  returnText: string
  drawdownText: string
  peerExcessText: string | null
  predictionText: string | null
  predictionErrorText: string | null
  hitText: string
}

export interface V8OutcomePending {
  pendingHorizons: number[]
  unavailableHorizons: number[]
  qdiiTargetPending: boolean
}

export type V8DetailGateKind = V8DecisionGateKind

export interface V8DetailDecisionDisplay {
  gated: boolean
  gateKind: V8DetailGateKind
  displayActionLabel: string
  displayActionCode: string
  displayTone: 'positive' | 'neutral' | 'caution' | 'danger'
  displaySummary: string
  rawActionLabel: string
  rawActionCode: string
  rawSummary: string
  gateReason: string | null
  positionExecutionAllowed: boolean
}

type OutcomeItem = V8FundOutcomes['items'][number] & {
  unavailable_horizons?: number[]
}

const ACTION_TONES: Record<V8Action, 'positive' | 'neutral' | 'caution' | 'danger'> = {
  buy: 'positive',
  dca: 'positive',
  add: 'positive',
  watch: 'neutral',
  hold: 'neutral',
  reduce: 'caution',
  sell: 'danger',
}

const CATEGORY_LABELS: Record<V8EvidenceNode['category'], string> = {
  valuation: '估值',
  trend: '趋势',
  momentum: '动量',
  quality: '质量',
  risk: '风险',
  holding: '持仓',
  portfolio: '组合',
  data_quality: '数据质量',
  model_accuracy: '模型准确度',
  outcome: '历史结果',
}

const STATE_LABELS: Record<V8EvidenceNode['state'], string> = {
  support: '支持',
  constraint: '约束',
  neutral: '中性',
  missing: '缺失',
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
}

export function formatV8Percent(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function formatV8Number(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

export function formatV8Timestamp(value: string | null | undefined): string {
  if (!value) return '时间未记录'
  const stamp = new Date(value)
  if (Number.isNaN(stamp.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(stamp)
}

export function v8ActionTone(action: V8Action): 'positive' | 'neutral' | 'caution' | 'danger' {
  return ACTION_TONES[action]
}

/**
 * Fail strong actions closed for display while retaining the immutable snapshot
 * action and numbers as explicitly-labelled audit evidence.
 */
export function buildV8DetailDecisionDisplay(result: V8DecisionResult, options?: V8DecisionGateOptions): V8DetailDecisionDisplay {
  const gate = inspectV8Decision(result, options)
  const rawActionLabel = typeof result?.action_label === 'string' ? result.action_label : '动作未记录'
  const rawActionCode = typeof result?.action === 'string' ? result.action : '未记录'
  const rawSummary = typeof result?.summary === 'string' ? result.summary : '摘要未记录'
  return {
    gated: gate.gated,
    gateKind: gate.kind,
    displayActionLabel: gate.gated ? '暂停动作' : rawActionLabel,
    displayActionCode: gate.gated ? 'paused' : rawActionCode,
    displayTone: gate.gated || !gate.action ? 'neutral' : v8ActionTone(gate.action),
    displaySummary: gate.gated ? '证据或决策链未通过当前核对，原快照只作历史记录，当前动作暂停。' : rawSummary,
    rawActionLabel,
    rawActionCode,
    rawSummary,
    gateReason: gate.gated ? gate.hard.join('；') : null,
    positionExecutionAllowed: !gate.gated,
  }
}

export function evidenceCategoryLabel(category: V8EvidenceNode['category']): string {
  return CATEGORY_LABELS[category]
}

export function evidenceStateLabel(state: V8EvidenceNode['state']): string {
  return STATE_LABELS[state]
}

export function formatEvidenceValue(value: V8EvidenceNode['value']): string | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  return value
}

function qdiiLike(evidence: V8EvidenceSnapshot): boolean {
  return /QDII|海外/i.test(`${evidence.fund_type} ${evidence.fund_name ?? ''}`)
}

export function v8EstimateAxisLabel(evidence: V8EvidenceSnapshot): string {
  return qdiiLike(evidence) ? '下一净值估算涨跌' : '盘中估值涨跌'
}

/**
 * Build only explanatory labels. The action, confidence and all numeric values
 * remain the immutable values returned by the V8 snapshot API.
 */
export function buildV8DataNotices(evidence: V8EvidenceSnapshot): V8DataNotice[] {
  const notices: V8DataNotice[] = []
  if (!evidence || !Array.isArray(evidence.source_states) || !Array.isArray(evidence.stale_fields)
    || !Array.isArray(evidence.missing_fields)) return [{ key: 'invalid', tone: 'danger', text: '数据状态不完整，当前动作暂停。' }]
  const sources = evidence.source_states.filter(source => source && typeof source.source_id === 'string')
  const staleSources = sources.filter((source) => (
    source.stale || source.state === 'stale' || source.state === 'unavailable'
  ))
  const degradedSources = sources.filter((source) => source.state === 'degraded')

  if (evidence.target_nav_date) {
    notices.push({
      key: 'qdii-target',
      tone: 'info',
      text: `QDII 下一净值估算目标日 ${evidence.target_nav_date}；正式净值基准日 ${evidence.official_nav_date ?? '缺失'}，两个日期不混用。`,
    })
  } else if (qdiiLike(evidence)) {
    notices.push({
      key: 'qdii-target-missing',
      tone: 'warning',
      text: 'QDII 下一净值估算目标日未生成；本快照不展示或推算该数值。',
    })
  }

  if (evidence.stale_fields.length || staleSources.length) {
    const fields = evidence.stale_fields.length ? evidence.stale_fields.join('、') : '数据源'
    notices.push({
      key: 'stale',
      tone: 'danger',
      text: `快照含过期证据（${fields}）；动作已按降级规则生成，请勿将过期数值当作实时数据。`,
    })
  }

  if (degradedSources.length) {
    notices.push({
      key: 'degraded',
      tone: 'warning',
      text: `部分数据源已降级（${degradedSources.map((source) => source.source_id).join('、')}）；请结合证据强度与误差边界判断。`,
    })
  }

  if (evidence.missing_fields.length) {
    notices.push({
      key: 'missing',
      tone: 'warning',
      text: `未取得：${evidence.missing_fields.join('、')}。缺失值保持为空，未替换成 0。`,
    })
  }

  if (evidence.official_nav == null || evidence.official_nav_date == null) {
    notices.push({
      key: 'official-nav-missing',
      tone: 'warning',
      text: '正式净值或净值日期缺失；不展示虚构的净值基准。',
    })
  }

  return notices
}

export function pendingForDecision(
  outcomes: V8FundOutcomes | null,
  decisionId: string,
): V8OutcomePending {
  const item = outcomes?.items.find((candidate) => candidate.decision.decision_id === decisionId) as OutcomeItem | undefined
  return {
    pendingHorizons: numberArray(item?.pending_horizons),
    unavailableHorizons: numberArray(item?.unavailable_horizons),
    qdiiTargetPending: item?.qdii_target_pending === true,
  }
}

function outcomeRow(record: Record<string, unknown>, decisionId: string, index: number, now: number): V8OutcomeRow | null {
  const kind = record.evaluation_kind
  if (kind !== 'horizon' && kind !== 'qdii_target') return null
  const horizon = finiteNumber(record.horizon)
  const baseDate = stringValue(record.base_nav_date) ?? '基准日未记录'
  const evaluationDate = stringValue(record.evaluation_date) ?? '结算日未记录'
  const targetDate = stringValue(record.target_nav_date)
  const base = v8Date(record.base_nav_date)
  const evaluated = v8Date(record.evaluation_date)
  const target = v8Date(record.target_nav_date)
  const today = Math.floor((now + 8 * 3_600_000) / 86_400_000) * 86_400_000
  const validAxis = Number.isFinite(now) && base != null && evaluated != null && base < evaluated
    && (kind !== 'qdii_target' || (target != null && target === evaluated))
  const settled = validAxis && evaluated! <= today
  const pendingText = validAxis ? '待正式净值结算' : '结果日期未核对'
  const absoluteReturn = finiteNumber(record.absolute_return)
  const drawdown = finiteNumber(record.max_drawdown)
  const peerExcess = finiteNumber(record.peer_excess)
  const predictedChange = finiteNumber(record.predicted_change)
  const predictionError = finiteNumber(record.prediction_error)
  const hit = typeof record.hit === 'boolean' ? record.hit : null
  const title = kind === 'qdii_target'
    ? `QDII 目标日 ${targetDate ?? evaluationDate}`
    : `${horizon == null ? '未知' : horizon} 个净值观测日`

  return {
    key: stringValue(record.outcome_id) ?? `${decisionId}-${kind}-${horizon ?? index}`,
    decisionId,
    title,
    axis: `${baseDate} → ${evaluationDate}`,
    returnText: settled ? formatV8Percent(absoluteReturn) : pendingText,
    drawdownText: settled ? formatV8Percent(drawdown) : '—',
    peerExcessText: !settled || peerExcess == null ? null : formatV8Percent(peerExcess),
    predictionText: predictedChange == null ? null : formatV8Percent(predictedChange),
    predictionErrorText: !settled || predictionError == null ? null : formatV8Percent(predictionError),
    hitText: !settled ? pendingText : hit == null ? '命中状态未记录' : (hit ? '方向命中' : '方向未命中'),
  }
}

export function collectV8OutcomeRows(outcomes: V8FundOutcomes | null, limit = 8, options?: V8DecisionGateOptions): V8OutcomeRow[] {
  if (!outcomes || !Array.isArray(outcomes.items)) return []
  const now = options?.now instanceof Date ? options.now.getTime() : options?.now ?? Date.now()
  const rows: V8OutcomeRow[] = []
  for (const item of outcomes.items) {
    if (!item || !Array.isArray(item.outcomes) || typeof item.decision?.decision_id !== 'string') continue
    item.outcomes.forEach((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return
      const row = outcomeRow(record, item.decision.decision_id, index, now)
      if (row) rows.push(row)
    })
  }
  return rows.slice(0, Math.max(0, limit))
}

export function immutableDecisionFields(result: V8DecisionResult) {
  return {
    action: result.action,
    actionLabel: result.action_label,
    strength: result.strength,
    confidence: result.confidence,
    summary: result.summary,
  }
}
