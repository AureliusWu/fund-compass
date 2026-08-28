import type { V8Action, V8DecisionDiff, V8DecisionResult } from '@/api/client'
import { V8_STRONG_ACTION_CONFIDENCE_GATE } from '@/utils/v8Decision'
import { isOverseasLike, type Estimate } from '@/utils/estimate'

export type WatchDecisionLoadKind = 'idle' | 'loading' | 'ready' | 'missing' | 'error'
export type WatchDecisionFilter = 'all' | 'action' | 'buy' | 'sell' | 'abnormal' | 'rise' | 'fall'
export type WatchDecisionSort = 'action' | 'confidence' | 'change'

export interface WatchDecisionLoadState {
  kind: WatchDecisionLoadKind
  message?: string
}

export interface WatchDecisionSource {
  code: string
  name: string
  type: string | null
  result: V8DecisionResult | null
  diff: V8DecisionDiff | null
  load: WatchDecisionLoadState
  diffLoad: WatchDecisionLoadState
  change: number | null
  changeCaption: '盘中估值' | '重仓估算' | '下一净值估算' | '正式净值' | '涨跌'
}

export function watchEstimateCaption(
  typeOrName: string | null | undefined,
  estimate: Estimate | null | undefined,
): WatchDecisionSource['changeCaption'] {
  if (!estimate) return '涨跌'
  if (estimate.kind === 'official_nav') return '正式净值'
  if (isOverseasLike(typeOrName, estimate)) return '下一净值估算'
  if (estimate.kind === 'holdings_model') return '重仓估算'
  return '盘中估值'
}

export function watchEstimateSemanticLabel(
  typeOrName: string | null | undefined,
  estimate: Estimate,
): string {
  const caption = watchEstimateCaption(typeOrName, estimate)
  if (caption === '正式净值') return '最近公布正式净值涨跌'
  if (caption === '下一净值估算') return caption
  return estimate.label
}

export interface WatchDecisionRow extends WatchDecisionSource {
  action: V8Action | null
  actionLabel: string
  snapshotActionLabel: string | null
  actionTone: 'buy' | 'sell' | 'hold' | 'warn'
  actionable: boolean
  gated: boolean
  strength: number | null
  confidence: number | null
  dataLabel: string
  dataDetail: string
  dataAbnormal: boolean
  mainReason: string
  changeLabel: string
  changeDetail: string | null
}

const V8_ACTIONS = new Set<V8Action>(['buy', 'dca', 'watch', 'add', 'hold', 'reduce', 'sell'])
const STRONG_ACTIONS = new Set<V8Action>(['buy', 'dca', 'add', 'reduce', 'sell'])

const ACTION_LABELS: Record<V8Action, string> = {
  buy: '买入',
  dca: '定投',
  watch: '观察',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  sell: '卖出',
}

const ACTION_PRIORITY: Record<V8Action, number> = {
  sell: 0,
  reduce: 1,
  buy: 2,
  add: 3,
  dca: 4,
  watch: 5,
  hold: 6,
}

function finitePercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function isAction(value: unknown): value is V8Action {
  return typeof value === 'string' && V8_ACTIONS.has(value as V8Action)
}

function firstText(values: unknown): string | null {
  if (!Array.isArray(values)) return null
  const item = values.find(value => typeof value === 'string' && value.trim())
  return typeof item === 'string' ? item.trim() : null
}

function snapshotIssues(source: WatchDecisionSource): { hard: string[]; soft: string[] } {
  const result = source.result
  const hard: string[] = []
  const soft: string[] = []
  if (source.load.kind !== 'ready' || !result) return { hard, soft }

  if (result.code !== source.code || result.decision?.fund_code !== source.code || result.evidence?.fund_code !== source.code) {
    hard.push('快照基金代码不一致')
  }
  if (!isAction(result.action) || result.decision?.action !== result.action) hard.push('动作字段不完整')
  if (!result.decision?.decision_id || !result.evidence?.evidence_id) hard.push('快照标识缺失')
  if (result.decision?.evidence_id !== result.evidence?.evidence_id) hard.push('决策与证据快照不一致')
  if (
    !result.holding?.holding_version
    || result.decision?.holding_version !== result.holding.holding_version
    || !result.policy?.policy_version
    || result.decision?.policy_version !== result.policy.policy_version
  ) hard.push('决策链不完整')
  const strength = finitePercent(result.strength)
  const confidence = finitePercent(result.confidence)
  if (strength == null || confidence == null) {
    hard.push('强度或置信度缺失')
  } else if (isAction(result.action) && STRONG_ACTIONS.has(result.action) && confidence < V8_STRONG_ACTION_CONFIDENCE_GATE) {
    hard.push(`置信度低于 ${V8_STRONG_ACTION_CONFIDENCE_GATE}，强动作暂停`)
  }
  if (result.decision?.strength !== result.strength || result.decision?.confidence !== result.confidence) {
    hard.push('决策指标与快照不一致')
  }

  if (
    !Array.isArray(result.evidence?.stale_fields)
    || !Array.isArray(result.evidence?.missing_fields)
    || !Array.isArray(result.evidence?.source_states)
  ) hard.push('数据状态字段不完整')

  const staleFields = Array.isArray(result.evidence?.stale_fields)
    ? result.evidence.stale_fields.filter(value => typeof value === 'string' && value.trim())
    : []
  const missingFields = Array.isArray(result.evidence?.missing_fields)
    ? result.evidence.missing_fields.filter(value => typeof value === 'string' && value.trim())
    : []
  if (staleFields.length) hard.push(`数据过期：${staleFields.slice(0, 2).join('、')}`)
  if (missingFields.length) hard.push(`数据缺失：${missingFields.slice(0, 2).join('、')}`)

  const estimateStatus = String(result.evidence?.estimate_status || '')
  if (estimateStatus === 'stale') hard.push('估值证据已过期')
  if (estimateStatus === 'unavailable') hard.push('估值证据不可用')
  if (estimateStatus === 'degraded') soft.push('估值证据已降级')

  const sourceStates = Array.isArray(result.evidence?.source_states) ? result.evidence.source_states : []
  for (const state of sourceStates) {
    if (!state || typeof state.source_id !== 'string') continue
    if (state.stale || state.state === 'stale') hard.push(`${state.source_id} 已过期`)
    else if (state.state === 'unavailable') hard.push(`${state.source_id} 不可用`)
    else if (state.state === 'degraded') soft.push(`${state.source_id} 已降级`)
    else if (state.state === 'unknown') soft.push(`${state.source_id} 状态待确认`)
  }

  return { hard: [...new Set(hard)], soft: [...new Set(soft)] }
}

function actionTone(action: V8Action | null, gated: boolean): WatchDecisionRow['actionTone'] {
  if (gated || !action) return 'warn'
  if (action === 'buy' || action === 'add' || action === 'dca') return 'buy'
  if (action === 'reduce' || action === 'sell') return 'sell'
  return 'hold'
}

function diffText(source: WatchDecisionSource): { label: string; detail: string | null } {
  if (source.diffLoad.kind === 'loading' || source.diffLoad.kind === 'idle') {
    return { label: '变化载入中', detail: null }
  }
  if (source.diffLoad.kind === 'missing') return { label: '首次记录', detail: null }
  if (source.diffLoad.kind === 'error' || !source.diff) {
    return { label: '变化不可用', detail: source.diffLoad.message || '无法核对历史快照' }
  }
  const decisionId = source.result?.decision?.decision_id
  if (!decisionId || source.diff.current_decision_id !== decisionId || source.diff.current_action !== source.result?.action) {
    return { label: '变化不可用', detail: '变化快照与当前决策不一致' }
  }
  if (!source.diff.previous_decision_id) {
    return { label: '首次记录', detail: firstText(source.diff.unchanged) }
  }
  if (!source.diff.changed) {
    return { label: '动作未变', detail: firstText(source.diff.unchanged) }
  }
  const previous = source.diff.previous_action && isAction(source.diff.previous_action)
    ? ACTION_LABELS[source.diff.previous_action]
    : '未知'
  const current = isAction(source.diff.current_action) ? ACTION_LABELS[source.diff.current_action] : '未知'
  return {
    label: `${previous} → ${current}`,
    detail: firstText(source.diff.drivers) || '已按结构化快照确认动作变化',
  }
}

export function buildWatchDecisionRow(source: WatchDecisionSource): WatchDecisionRow {
  const result = source.result
  const { hard, soft } = snapshotIssues(source)
  const action = result && isAction(result.action) ? result.action : null
  const resultActionLabel = typeof result?.action_label === 'string' ? result.action_label.trim() : ''
  const snapshotActionLabel = action ? (resultActionLabel || ACTION_LABELS[action]) : null
  const unavailable = source.load.kind !== 'ready' || !result
  const gated = !unavailable && hard.length > 0
  const diff = diffText(source)
  const diffUnavailable = diff.label === '变化不可用'
  const loadMessage = source.load.message || (
    source.load.kind === 'missing' ? '尚未生成 V8 快照' :
      source.load.kind === 'error' ? 'V8 快照不可用' :
        source.load.kind === 'loading' || source.load.kind === 'idle' ? '正在载入 V8 快照' : ''
  )
  const mainReason = unavailable
    ? loadMessage
    : gated
      ? hard[0]
      : firstText(result.decision?.reasons) || String(result.summary || '').trim() || '快照未提供主要理由'

  return {
    ...source,
    action,
    actionLabel: unavailable ? '等待快照' : gated ? '暂停动作' : snapshotActionLabel || '等待数据',
    snapshotActionLabel,
    actionTone: actionTone(action, unavailable || gated),
    actionable: !unavailable && !gated && action != null && !['watch', 'hold'].includes(action),
    gated: unavailable || gated,
    strength: result ? finitePercent(result.strength) : null,
    confidence: result ? finitePercent(result.confidence) : null,
    dataLabel: unavailable
      ? source.load.kind === 'missing' ? '无快照' : source.load.kind === 'error' ? '请求失败' : '载入中'
      : hard.length ? '数据异常' : diffUnavailable ? '变化异常' : soft.length ? '部分降级' : '数据正常',
    dataDetail: unavailable
      ? loadMessage
      : [...hard, ...(diffUnavailable && diff.detail ? [`变化：${diff.detail}`] : []), ...soft].join('；')
        || '快照数据通过完整性检查',
    dataAbnormal: unavailable || hard.length > 0 || diffUnavailable,
    mainReason,
    changeLabel: diff.label,
    changeDetail: diff.detail,
  }
}

function matchesFilter(row: WatchDecisionRow, filter: WatchDecisionFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'action') return row.actionable
  if (filter === 'buy') return !row.gated && row.action != null && ['buy', 'add', 'dca'].includes(row.action)
  if (filter === 'sell') return !row.gated && row.action != null && ['reduce', 'sell'].includes(row.action)
  if (filter === 'abnormal') return row.dataAbnormal
  if (filter === 'rise') return row.change != null && row.change > 0
  return row.change != null && row.change < 0
}

function nullableDescending(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return right - left
}

export function filterAndSortWatchDecisions(
  sources: WatchDecisionSource[],
  filter: WatchDecisionFilter,
  sort: WatchDecisionSort,
): WatchDecisionRow[] {
  const rows = sources.map(buildWatchDecisionRow).filter(row => matchesFilter(row, filter))
  return rows.sort((left, right) => {
    let order = 0
    if (sort === 'confidence') order = nullableDescending(left.confidence, right.confidence)
    else if (sort === 'change') order = nullableDescending(left.change, right.change)
    else {
      const leftPriority = left.gated || !left.action ? 99 : ACTION_PRIORITY[left.action]
      const rightPriority = right.gated || !right.action ? 99 : ACTION_PRIORITY[right.action]
      order = leftPriority - rightPriority
      if (!order) order = nullableDescending(left.strength, right.strength)
    }
    return order || left.code.localeCompare(right.code)
  })
}
