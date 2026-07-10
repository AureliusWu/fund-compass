import type { DecisionResp } from '@/api/client'
import type { Alert } from './alerts'
import type { Estimate } from './estimate'
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

export type Freshness = 'fresh' | 'stale' | 'expired'

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
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
  if (!estimate) return 'expired'
  if (estimate.kind === 'overseas_model') return freshnessFromTime(estimate.generatedAt, now)
  if (estimate.kind === 'overseas') return 'stale'
  return freshnessFromTime(estimate.estTime, now)
}

export function estimateChangeForDisplay(estimate: Estimate | null | undefined, now = Date.now()): number | null {
  return estimateFreshness(estimate, now) === 'expired' ? null : estimate?.estChange ?? null
}

export function estimateTrustText(estimate: Estimate | null | undefined): string {
  if (!estimate) return '暂无可信度信息'
  const parts: string[] = []
  if (estimate.navDate) parts.push(`净值基准 ${estimate.navDate}`)
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
