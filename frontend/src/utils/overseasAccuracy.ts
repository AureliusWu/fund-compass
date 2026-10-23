import type { Estimate } from './estimate'
import { requestJson } from '@/api/request'

export interface AccuracySummary {
  samples: number
  model_version?: string
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
  alignment_version?: string
  observed_at?: string
  settled_at?: string
  excluded_from_metrics?: boolean
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
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

function evidenceTime(value: unknown): { milliseconds: number; nanoseconds: bigint } | undefined {
  if (typeof value !== 'string' || !validDate(value.slice(0, 10))) return undefined
  const parts = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59 || Number(parts[3]) > 59
    || (parts[5] !== undefined && (Number(parts[5]) > 23 || Number(parts[6]) > 59))) return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return undefined
  // Date.parse clips beyond milliseconds. Preserve the bounded fractional tail
  // for ordering and the future-skew guard, rather than accepting +5min+1ns.
  const fractionalTail = (parts[4] ?? '').padEnd(9, '0').slice(3)
  return { milliseconds: parsed, nanoseconds: BigInt(parsed) * 1_000_000n + BigInt(fractionalTail) }
}

function matchingModel(summary: AccuracySummary, modelVersion: unknown): modelVersion is string {
  return typeof modelVersion === 'string' && modelVersion.length > 0 && modelVersion.trim() === modelVersion
    && summary.model_version === modelVersion
}

/** A pipeline heartbeat or another fund/version cannot refresh this model's metrics.
 * Older/windowed reports without matching dated records deliberately yield unknown.
 * Registry candidate.data_effective_at is not an active-model freshness source.
 */
export function accuracyEffectiveAt(report: AccuracyReport, code: string, modelVersion: string | undefined, now = Date.now()): string | undefined {
  const summary = report.summary[code]
  if (!summary || !Number.isInteger(summary.samples) || summary.samples < 0 || !matchingModel(summary, modelVersion)
    || !Number.isSafeInteger(now)) return undefined
  const futureLimit = BigInt(now + MAX_FUTURE_SKEW_MS) * 1_000_000n
  let latest: { at: string; time: bigint } | undefined
  const identities = new Set<string>()
  for (const row of report.records) {
    if (row.code !== code || row.model_version !== modelVersion) continue
    if (summary.samples > 0 ? row.status !== 'settled' : !['pending', 'settled', 'stale'].includes(row.status)) continue
    if (row.excluded_from_metrics === true) continue
    if (row.alignment_version !== 'observation-target-v2'
      || !validDate(row.prediction_date) || !validDate(row.target_nav_date) || !validDate(row.base_nav_date)
      || !(row.base_nav_date < row.target_nav_date && row.target_nav_date < row.prediction_date)
      || typeof row.predicted_change !== 'number' || !Number.isFinite(row.predicted_change)) return undefined
    // Producer/auditor uniqueness is (code, prediction_date, model_version).
    const identity = row.prediction_date
    if (identities.has(identity)) return undefined
    identities.add(identity)
    const observed = evidenceTime(row.observed_at)
    if (observed === undefined || observed.nanoseconds > futureLimit
      || new Date(observed.milliseconds + BEIJING_OFFSET_MS).toISOString().slice(0, 10) !== row.prediction_date) return undefined
    const at = summary.samples > 0 ? row.settled_at : row.observed_at
    const time = evidenceTime(at)
    if (time === undefined || time.nanoseconds < observed.nanoseconds || time.nanoseconds > futureLimit) return undefined
    if (summary.samples > 0 && (typeof row.actual_change !== 'number' || !Number.isFinite(row.actual_change)
      || typeof row.error !== 'number' || !Number.isFinite(row.error))) return undefined
    if (!latest || time.nanoseconds > latest.time) latest = { at: at!, time: time.nanoseconds }
  }
  return latest?.at
}

export function accuracyFreshness(report: AccuracyReport, code: string, modelVersion: string | undefined, now = Date.now()) {
  const summary = report.summary[code]
  const modelMatches = !!summary && matchingModel(summary, modelVersion)
  const effectiveAt = accuracyEffectiveAt(report, code, modelVersion, now)
  const status: 'collecting' | 'unknown' | 'stale' | 'fresh' = modelMatches && summary.samples === 0
    ? 'collecting'
    : effectiveAt === undefined ? 'unknown'
    : now - Date.parse(effectiveAt) > EFFECTIVE_FRESH_MS ? 'stale' : 'fresh'
  const confidence = status === 'collecting' ? '精度样本重新积累中'
    : status === 'unknown' || status === 'stale' ? '精度数据过期' : summary!.confidence
  return { modelMatches, effectiveAt, status, confidence }
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
    && (row.model_version === undefined || (typeof row.model_version === 'string' && row.model_version.length > 0))
    && ['collecting', 'healthy', 'degraded', 'frozen'].includes(String(row.status))
    && typeof row.confidence === 'string'
    && ['mae', 'bias', 'direction_accuracy', 'error_band'].every(field => nullableNumber(row[field]))
    && validWindow(row.rolling_5) && validWindow(row.rolling_20)
    && (row.error_percentiles == null || (object(row.error_percentiles)
      && ['p50', 'p80', 'p95'].every(field => nullableNumber((row.error_percentiles as Record<string, unknown>)[field])))))) return false
  return value.records.every(row => object(row) && typeof row.code === 'string' && typeof row.status === 'string'
    && ['model_version', 'alignment_version', 'observed_at', 'settled_at'].every(field => row[field] === undefined || typeof row[field] === 'string')
    && (row.excluded_from_metrics === undefined || typeof row.excluded_from_metrics === 'boolean')
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
  const { modelMatches: matches, effectiveAt, confidence } = accuracyFreshness(report, estimate.code, estimate.modelVersion)
  return {
    ...estimate,
    confidence,
    accuracySamples: matches ? summary.samples : undefined,
    errorBand: matches ? summary.error_band : undefined,
    accuracyUpdatedAt: effectiveAt,
    sourceNote: `${estimate.sourceNote} · ${confidence}${matches && summary.error_band != null ? ` · 历史约±${summary.error_band.toFixed(2)}%` : ''}`,
  }
}
