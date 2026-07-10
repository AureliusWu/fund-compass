import type { Estimate } from './estimate'

export interface AccuracySummary {
  samples: number
  status: 'collecting' | 'healthy' | 'degraded' | 'frozen'
  confidence: string
  mae: number | null
  bias: number | null
  direction_accuracy: number | null
  error_band: number | null
}
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
}
export interface AccuracyReport {
  updated_at: string
  summary: Record<string, AccuracySummary>
  records: AccuracyRecord[]
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
  const summary = (await loadOverseasAccuracy())?.summary?.[estimate.code]
  if (!summary) return estimate
  return {
    ...estimate,
    confidence: summary.confidence,
    accuracySamples: summary.samples,
    errorBand: summary.error_band,
    sourceNote: `${estimate.sourceNote} · ${summary.confidence}${summary.error_band != null ? ` · 历史约±${summary.error_band.toFixed(2)}%` : ''}`,
  }
}
