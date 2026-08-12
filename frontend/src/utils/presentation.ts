import type { DecisionResp } from '@/api/client'
import type { Alert } from './alerts'
import { estimateDataFreshness, type Estimate, type EstimateDataFreshness } from './estimate'
import type { SourceStatus } from './resilience'

export const MAIN_NAV_ITEMS = [
  { to: '/', label: '首页', icon: 'home' },
  { to: '/screen', label: '选基', icon: 'mirror' },
  { to: '/watch', label: '自选', icon: 'scroll' },
] as const

export const WATCH_SECTIONS = ['今日决策摘要', '盘中估值'] as const

export function combineTemperature(market: number | null | undefined, watch: number | null | undefined): number | null {
  if (market == null) return watch ?? null
  if (watch == null) return market
  return Math.round(market * 0.6 + watch * 0.4)
}

export function visibleUnreadAlerts(alerts: Alert[]): Alert[] {
  return alerts
    .filter((alert) => !alert.dismissed && !alert.read)
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, 8)
}

export type Freshness = EstimateDataFreshness
const MAX_FUTURE_SOURCE_SKEW_MS = 5 * 60 * 1000

function parseTime(value: string | null | undefined): number | null {
  const text = String(value || '').trim()
  if (!text) return null
  let normalized = text.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T15:00:00+08:00'
  else if (/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) normalized += '+08:00'
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function beijingDateKey(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function tradingDaysBetween(start: string, end: string): number {
  const cursor = new Date(`${start}T12:00:00Z`)
  const finish = new Date(`${end}T12:00:00Z`)
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(finish.getTime())) return 4
  let tradingDays = 0
  while (cursor < finish && tradingDays <= 3) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) tradingDays++
  }
  return tradingDays
}

export function freshnessFromTime(
  value: string | null | undefined,
  now = Date.now(),
  staleAfterMs = 90 * 60 * 1000,
  expireAfterMs = 24 * 60 * 60 * 1000,
): Freshness {
  const timestamp = parseTime(value)
  if (timestamp == null) return 'expired'
  const age = Math.max(0, now - timestamp)
  if (age > expireAfterMs) return 'expired'
  if (age > staleAfterMs) return 'stale'
  return 'fresh'
}

export function estimateFreshness(estimate: Estimate | null | undefined, now = Date.now()): Freshness {
  return estimateDataFreshness(estimate, now)
}

export function marketDataFreshness(value: string | null | undefined, now = Date.now()): Freshness {
  const text = String(value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const sourceTimestamp = Date.parse(`${text}T00:00:00+08:00`)
    if (!Number.isFinite(sourceTimestamp) || beijingDateKey(sourceTimestamp) !== text) return 'expired'
    const today = beijingDateKey(now)
    if (text > today) return 'expired'
    const tradingDays = tradingDaysBetween(text, today)
    if (tradingDays === 0) return 'fresh'
    if (tradingDays <= 2) return 'stale'
    return 'expired'
  }
  const timestamp = parseTime(value)
  if (timestamp == null) return 'expired'
  if (timestamp > now + MAX_FUTURE_SOURCE_SKEW_MS) return 'expired'
  const tradingDays = tradingDaysBetween(beijingDateKey(timestamp), beijingDateKey(now))
  if (tradingDays === 0) return 'fresh'
  if (tradingDays <= 2) return 'stale'
  return 'expired'
}

export function estimateChangeForDisplay(estimate: Estimate | null | undefined, now = Date.now()): number | null {
  return estimateFreshness(estimate, now) === 'expired' ? null : estimate?.estChange ?? null
}

export function estimateTrustText(estimate: Estimate | null | undefined): string {
  if (!estimate) return '暂无可信度信息'
  const parts: string[] = []
  if (estimate.baseNavDate || estimate.navDate) parts.push(`净值基准 ${estimate.baseNavDate || estimate.navDate}`)
  if (estimate.kind === 'holdings_model') {
    if (estimate.modelReportDate) parts.push(`重仓披露 ${estimate.modelReportDate}`)
    const coverage = estimate.modelCoverage ?? estimate.modelWeight
    if (coverage != null) parts.push(`覆盖 ${coverage.toFixed(1)}%`)
    if (estimate.modelQuoteCount != null) parts.push(`${estimate.modelQuoteCount} 只行情`)
    const oldest = estimate.modelOldestQuoteTime
    const newest = estimate.modelNewestQuoteTime
    if (oldest || newest) parts.push(`行情 ${oldest || '未知'} → ${newest || '未知'}`)
    if (estimate.modelRejectedCount) parts.push(`剔除 ${estimate.modelRejectedCount} 只`)
    parts.push('非官方模型估算')
  }
  if (estimate.kind === 'overseas_model') {
    if (estimate.modelWeight != null) parts.push(`覆盖 ${estimate.modelWeight.toFixed(0)}%`)
    parts.push(estimate.confidence || '样本积累中')
    if (estimate.accuracySamples != null) parts.push(`${estimate.accuracySamples} 样本`)
    if (estimate.errorBand != null) parts.push(`P80 ±${estimate.errorBand.toFixed(2)}%`)
  }
  return parts.join(' · ') || estimate.sourceNote
}

export function sourceFreshness(source: SourceStatus, now = Date.now()): Freshness {
  if (!source.ok) return 'expired'
  return freshnessFromTime(
    source.lastCheck ? new Date(source.lastCheck).toISOString() : null,
    now,
    15 * 60 * 1000,
    24 * 60 * 60 * 1000,
  )
}

export interface DecisionGroup {
  action: string
  names: string[]
  confidence: DecisionResp['confidence']
  reason: string
}

export function groupDecisions(
  items: Array<{ code: string; name: string }>,
  decisions: Record<string, DecisionResp>,
): DecisionGroup[] {
  const groups = new Map<string, DecisionGroup>()
  for (const item of items) {
    const decision = decisions[item.code]
    if (!decision) continue
    const existing = groups.get(decision.action)
    if (existing) {
      existing.names.push(item.name)
      continue
    }
    groups.set(decision.action, {
      action: decision.action,
      names: [item.name],
      confidence: decision.confidence,
      reason: decision.reasons[0] || decision.summary || '等待更多数据',
    })
  }
  return [...groups.values()]
}
