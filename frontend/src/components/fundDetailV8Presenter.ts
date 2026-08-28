import type {
  V8Action,
  V8DecisionResult,
  V8EvidenceNode,
  V8EvidenceSnapshot,
  V8FundOutcomes,
} from '@/api/client'
import { V8_STRONG_ACTION_CONFIDENCE_GATE } from '@/utils/v8Decision'

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

export type V8DetailGateKind = 'stale' | 'low_confidence' | null

export interface V8DetailDecisionDisplay {
  gated: boolean
  gateKind: V8DetailGateKind
  displayActionLabel: string
  displayActionCode: string
  displayTone: 'positive' | 'neutral' | 'caution' | 'danger'
  displaySummary: string
  rawActionLabel: string
  rawActionCode: V8Action
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

const STRONG_ACTIONS = new Set<V8Action>(['buy', 'dca', 'add', 'reduce', 'sell'])

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

function hardDataIssues(result: V8DecisionResult): string[] {
  const issues: string[] = []
  if (result.evidence.stale_fields.length) {
    issues.push(`过期字段：${result.evidence.stale_fields.join('、')}`)
  }
  if (['stale', 'unavailable'].includes(result.evidence.estimate_status)) {
    issues.push(result.evidence.estimate_status === 'stale' ? '估值证据已过期' : '估值证据不可用')
  }
  for (const source of result.evidence.source_states) {
    if (source.stale || source.state === 'stale') issues.push(`${source.source_id} 已过期`)
    else if (source.state === 'unavailable') issues.push(`${source.source_id} 不可用`)
  }
  return [...new Set(issues)]
}

/**
 * Fail strong actions closed for display while retaining the immutable snapshot
 * action and numbers as explicitly-labelled audit evidence.
 */
export function buildV8DetailDecisionDisplay(result: V8DecisionResult): V8DetailDecisionDisplay {
  const strong = STRONG_ACTIONS.has(result.action)
  const issues = hardDataIssues(result)
  const confidence = typeof result.confidence === 'number' && Number.isFinite(result.confidence)
    ? result.confidence
    : null

  if (strong && issues.length) {
    return {
      gated: true,
      gateKind: 'stale',
      displayActionLabel: '暂停动作',
      displayActionCode: 'paused',
      displayTone: 'neutral',
      displaySummary: '关键证据已过期或不可用，等待新快照后再评估；当前不执行原强动作。',
      rawActionLabel: result.action_label,
      rawActionCode: result.action,
      rawSummary: result.summary,
      gateReason: issues.join('；'),
      positionExecutionAllowed: false,
    }
  }

  if (strong && (confidence == null || confidence < V8_STRONG_ACTION_CONFIDENCE_GATE)) {
    const confidenceText = confidence == null ? '未记录' : String(confidence)
    return {
      gated: true,
      gateKind: 'low_confidence',
      displayActionLabel: '观察',
      displayActionCode: 'watch',
      displayTone: 'neutral',
      displaySummary: `置信度 ${confidenceText} 未达到强动作门槛 ${V8_STRONG_ACTION_CONFIDENCE_GATE}，原动作仅作审计记录。`,
      rawActionLabel: result.action_label,
      rawActionCode: result.action,
      rawSummary: result.summary,
      gateReason: `置信度门槛 ${V8_STRONG_ACTION_CONFIDENCE_GATE}`,
      positionExecutionAllowed: false,
    }
  }

  return {
    gated: false,
    gateKind: null,
    displayActionLabel: result.action_label,
    displayActionCode: result.action,
    displayTone: v8ActionTone(result.action),
    displaySummary: result.summary,
    rawActionLabel: result.action_label,
    rawActionCode: result.action,
    rawSummary: result.summary,
    gateReason: null,
    positionExecutionAllowed: true,
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
  const staleSources = evidence.source_states.filter((source) => (
    source.stale || source.state === 'stale' || source.state === 'unavailable'
  ))
  const degradedSources = evidence.source_states.filter((source) => source.state === 'degraded')

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

function outcomeRow(record: Record<string, unknown>, decisionId: string, index: number): V8OutcomeRow | null {
  const kind = record.evaluation_kind
  if (kind !== 'horizon' && kind !== 'qdii_target') return null
  const horizon = finiteNumber(record.horizon)
  const baseDate = stringValue(record.base_nav_date) ?? '基准日未记录'
  const evaluationDate = stringValue(record.evaluation_date) ?? '结算日未记录'
  const targetDate = stringValue(record.target_nav_date)
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
    returnText: formatV8Percent(absoluteReturn),
    drawdownText: formatV8Percent(drawdown),
    peerExcessText: peerExcess == null ? null : formatV8Percent(peerExcess),
    predictionText: predictedChange == null ? null : formatV8Percent(predictedChange),
    predictionErrorText: predictionError == null ? null : formatV8Percent(predictionError),
    hitText: hit == null ? '命中状态未记录' : (hit ? '方向命中' : '方向未命中'),
  }
}

export function collectV8OutcomeRows(outcomes: V8FundOutcomes | null, limit = 8): V8OutcomeRow[] {
  if (!outcomes) return []
  const rows: V8OutcomeRow[] = []
  for (const item of outcomes.items) {
    item.outcomes.forEach((record, index) => {
      const row = outcomeRow(record, item.decision.decision_id, index)
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
