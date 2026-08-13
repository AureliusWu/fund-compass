import type { Estimate } from './estimate'

export interface AccuracySummary {
  samples: number
  status: 'collecting' | 'healthy' | 'degraded' | 'frozen'
  confidence: string
  mae: number | null
  bias: number | null
  direction_accuracy: number | null
  error_band: number | null
  error_percentiles?: { p50: number | null; p80: number | null; p95: number | null }
  rolling_5?: AccuracyWindow | null
  rolling_20?: AccuracyWindow | null
  pending?: number
  stale?: number
  legacy_misaligned?: number
}
export interface AccuracyWindow { samples: number; mae: number; bias: number; direction_accuracy: number }
export interface AccuracyRecord {
  code: string
  name: string
  display_date?: string
  prediction_date?: string
  target_nav_date: string
  base_nav_date: string
  predicted_change?: number | null
  actual_change?: number | null
  error?: number | null
  status: string
  model_version?: string
  note?: string
  waiting_days?: number
  settlement_note?: string
}
export interface AccuracyReport {
  updated_at: string
  pipeline?: {
    heartbeat_at?: string
    last_run_at?: string
    last_prediction_at?: string
    last_settlement_at?: string
    last_effective_prediction_at?: string
    last_effective_settlement_at?: string
    scheduled_for?: string
    delay_minutes?: number
    prediction_expected?: boolean
    alignment_version?: string
    legacy_misaligned_records?: number
  }
  summary: Record<string, AccuracySummary>
  records: AccuracyRecord[]
}

const EFFECTIVE_FRESH_MS = 96 * 60 * 60 * 1000

export function accuracyEffectiveAt(report: AccuracyReport, samples: number): string | undefined {
  const pipeline = report.pipeline
  if (!pipeline) return undefined
  return samples > 0
    ? pipeline.last_effective_settlement_at
    : pipeline.last_effective_prediction_at
}

let reportPromise: Promise<AccuracyReport | null> | null = null

export function loadOverseasAccuracy(force = false): Promise<AccuracyReport | null> {
  if (!reportPromise || force) {
    reportPromise = fetch(`${import.meta.env.BASE_URL}data/overseas-accuracy.json`, { cache: force ? 'reload' : 'default' })
      .then((response) => response.ok ? response.json() as Promise<AccuracyReport> : null)
      .catch(() => null)
  }
  return reportPromise
}

export async function attachAccuracy(estimate: Estimate): Promise<Estimate> {
  if (estimate.kind !== 'overseas_model') return estimate
  const report = await loadOverseasAccuracy()
  const summary = report?.summary?.[estimate.code]
  if (!summary) return estimate
  const effectiveAt = accuracyEffectiveAt(report, summary.samples)
  const parsedEffectiveAt = effectiveAt ? Date.parse(effectiveAt) : Number.NaN
  const effectiveAge = Number.isFinite(parsedEffectiveAt) && parsedEffectiveAt <= Date.now() + 5 * 60 * 1000
    ? Date.now() - parsedEffectiveAt
    : Infinity
  const confidence = summary.samples === 0
    ? '精度样本重新积累中'
    : effectiveAge > EFFECTIVE_FRESH_MS ? '精度数据过期' : summary.confidence
  return {
    ...estimate,
    confidence,
    accuracySamples: summary.samples,
    errorBand: summary.error_band,
    accuracyUpdatedAt: effectiveAt,
    sourceNote: `${estimate.sourceNote} · ${confidence}${summary.error_band != null ? ` · 历史约±${summary.error_band.toFixed(2)}%` : ''}`,
  }
}
