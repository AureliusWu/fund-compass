import type { Estimate } from './estimate'
import { requestJson } from '@/api/request'

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
let reportCache: AccuracyReport | null = null
let generation = 0

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function validWindow(value: unknown): boolean {
  return value == null || (object(value) && Number.isInteger(value.samples) && Number(value.samples) >= 0
    && ['mae', 'bias', 'direction_accuracy'].every(field => typeof value[field] === 'number' && Number.isFinite(value[field])))
}

function validReport(value: unknown): value is AccuracyReport {
  if (!object(value) || typeof value.updated_at !== 'string' || !object(value.summary) || !Array.isArray(value.records)) return false
  if (value.pipeline != null && !object(value.pipeline)) return false
  if (!Object.values(value.summary).every(row => object(row) && Number.isInteger(row.samples) && Number(row.samples) >= 0
    && ['collecting', 'healthy', 'degraded', 'frozen'].includes(String(row.status))
    && typeof row.confidence === 'string'
    && ['mae', 'bias', 'direction_accuracy', 'error_band'].every(field => nullableNumber(row[field]))
    && validWindow(row.rolling_5) && validWindow(row.rolling_20)
    && (row.error_percentiles == null || (object(row.error_percentiles)
      && ['p50', 'p80', 'p95'].every(field => nullableNumber((row.error_percentiles as Record<string, unknown>)[field])))))) return false
  return value.records.every(row => object(row) && typeof row.code === 'string' && typeof row.status === 'string'
    && ['predicted_change', 'actual_change', 'error'].every(field => row[field] === undefined || nullableNumber(row[field])))
}

export function loadOverseasAccuracy(force = false, options?: { signal?: AbortSignal }): Promise<AccuracyReport | null> {
  const signal = options?.signal
  if (signal?.aborted) return Promise.resolve(null)
  if (force) {
    generation += 1
    reportCache = null
    reportPromise = null
  }
  if (reportCache) return Promise.resolve(reportCache)
  // Only un-cancellable callers share an in-flight promise. A caller's signal
  // cannot terminate another component's request for the same public report.
  if (!signal && reportPromise) return reportPromise
  const currentGeneration = generation
  const pending = requestJson<unknown>(`${import.meta.env.BASE_URL}data/overseas-accuracy.json`, {
    cache: force ? 'reload' : 'default', signal,
  }).then(value => {
    if (!validReport(value) || signal?.aborted) return null
    if (currentGeneration === generation) reportCache = value
    return value
  }).catch(() => null).finally(() => {
    // Failed/null promises must not prevent a later request from recovering.
    if (reportPromise === pending) reportPromise = null
  })
  if (!signal) reportPromise = pending
  return pending
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
