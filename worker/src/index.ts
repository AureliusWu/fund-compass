import { ExternalDataError, externalGet, readBoundedText, readJson } from './external'
import {
  beijingDate,
  canonicalWireTime,
  fetchPublicQuotes,
  fetchFundHoldings,
  isSupportedPublicQuoteCode,
  isPublishableIntraday,
  normalizeEstimate,
  parseFundHoldings,
  publicUnavailableItem,
  publicValuationItem,
  resolveValuations,
  type Estimate,
  type FundHolding,
  type FundHoldings,
} from './valuation'

export { normalizeEstimate, parseFundHoldings }
export type { Estimate, FundHolding, FundHoldings }

declare const WORKER_BUILD_SHA: string | undefined

const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/

export function normalizeBuildSha(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return FULL_GIT_SHA_RE.test(normalized) ? normalized : null
}

function currentBuildSha(): string | null {
  return normalizeBuildSha(
    typeof WORKER_BUILD_SHA === 'string' ? WORKER_BUILD_SHA : undefined,
  )
}

export interface Env {
  GIST_ID: string
  FUND_API_BASE: string
  GIST_TOKEN: string
  WECHAT_SENDKEY: string
  ADMIN_TOKEN: string
  WORKER_TOKEN: string
}

interface WatchEntry {
  code: string
  name?: string
  shares?: number
  target_weight?: number
  deleted?: boolean
}

interface WorkerDecisionRequest {
  request_id: string
  items: Array<{
    code: string
    holding: {
      is_held: boolean
      shares?: number
      market_value?: number
      current_weight?: number
      target_weight?: number
      source: 'worker-gist'
    }
    estimate_context: DecisionEstimateContext
  }>
  portfolio_value: number
}

const MAX_WATCH_NAME_LENGTH = 120
const MAX_WATCH_SHARES = 1_000_000_000_000

function watchNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value == null || typeof value === 'boolean') return undefined
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : NaN
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined
}

export function parseWatchEntries(value: unknown): WatchEntry[] {
  if (!Array.isArray(value)) return []
  const entries: WatchEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const row = raw as Record<string, unknown>
    const code = typeof row.code === 'string' ? row.code.trim() : ''
    if (!/^\d{6}$/.test(code)) continue
    if (row.deleted != null && typeof row.deleted !== 'boolean') continue
    if (row.deleted === true) continue
    const entry: WatchEntry = { code }
    if (typeof row.name === 'string') {
      const name = row.name.trim()
      if (name) entry.name = name.slice(0, MAX_WATCH_NAME_LENGTH)
    }
    const shares = watchNumber(row.shares, 0, MAX_WATCH_SHARES)
    if (shares != null) entry.shares = shares
    const target = watchNumber(row.target_weight, 0, 100)
    if (target != null) entry.target_weight = target
    entries.push(entry)
  }
  return entries
}

interface DecisionEstimateContext {
  status: Estimate['status'] | 'unavailable'
  source: string
  source_time: string | null
  source_time_precision: 'date' | 'datetime'
  estimate_change: number | null
  estimate_nav: number | null
  estimate_time: string | null
  value_nav: number | null
  value_change: number | null
  nav_date: string | null
  target_nav_date: string | null
  kind: 'intraday_estimate' | 'qdii_next_nav_estimate' | 'holdings_model' | 'official_nav' | 'unavailable'
  market: 'overseas' | 'unknown'
  estimate_model_version: string | null
  sample_count: number | null
  coverage: number | null
  uncertainty: Estimate['uncertainty'] | null
  is_fallback: boolean
  fallback_reason: string | null
  base_nav: number | null
  base_nav_date: string | null
  value_date: string | null
  model_coverage: number | null
  model_quote_count: number | null
  model_report_date: string | null
  model_oldest_quote_time: string | null
  model_newest_quote_time: string | null
  model_rejected_count: number | null
  diagnostics: Record<string, unknown>
}

interface PushState {
  date: string
  sent_slots: string[]
  last_decision_ids?: string[]
  last_cron_at?: string
  last_cron_build_sha?: string
  scheduled_at?: string
  schedule_delay_seconds?: number
  last_cron_result?: 'sent' | 'sent_with_warning' | 'skipped' | 'failed'
  last_cron_reason?: string
  last_slot?: string
  last_attempt_at?: string
  last_pushed_at?: string
  last_success_at?: string
  attempt_count: number
  last_error?: string
  last_warning?: string
  decision_status?: 'ok' | 'disabled' | 'degraded'
  last_http_status?: number | null
}

interface DecisionOutcome {
  result: Record<string, unknown> | null
  status: 'ok' | 'disabled' | 'degraded'
  warning?: string
}

interface OutcomeSettlement {
  settled: number
  pending: number
  errors: unknown[]
}

type NotificationStatus = 'scheduled' | 'skipped' | 'attempted' | 'sent' | 'failed' | 'compensated'

interface NotificationAuditOutcome {
  claimed: boolean
  duplicate: boolean
}

class DecisionError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'DecisionError'
  }
}

const WATCH_FILE = 'sinan-watchlist.json'
const STATE_FILE = 'sinan-estimate-state.json'
type NaturalSlot = '14:30' | '14:40'
const PRIMARY_SLOT: NaturalSlot = '14:30'
const COMPENSATION_SLOT: NaturalSlot = '14:40'
const MAX_MESSAGE_LENGTH = 8000
const MAX_STATE_ATTEMPTS = 1000
const MAX_SCHEDULE_DELAY_SECONDS = 31 * 24 * 60 * 60
const VALID_STATE_SLOTS = new Set<NaturalSlot>([PRIMARY_SLOT, COMPENSATION_SLOT])
const VALID_CRON_RESULTS = new Set(['sent', 'sent_with_warning', 'skipped', 'failed'])
const VALID_DECISION_STATUSES = new Set(['ok', 'disabled', 'degraded'])
const VALID_ACTIONS = new Set(['buy', 'dca', 'watch', 'add', 'hold', 'reduce', 'sell'])
const DECISION_ID_RE = /^dec_[0-9a-f]{64}$/
const NOTIFICATION_ID_RE = /^ntf_[0-9a-f]{64}$/
const NOTIFICATION_LOG_ID_RE = /^ntl_[0-9a-f]{64}$/

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function strictStateDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : undefined
}

function stateTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
  return Number.isFinite(Date.parse(value)) ? value : undefined
}

function boundedStateText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length <= maximum ? value : undefined
}

/** Parse the untrusted shared Gist state without allowing malformed daily data
 * to crash scheduling or claim that today's slot was sent. */
export function parsePushState(raw: string | null | undefined): Partial<PushState> {
  let value: unknown
  try { value = JSON.parse(raw || '{}') } catch { return {} }
  if (!plainRecord(value)) return {}
  const state: Partial<PushState> = {}
  const date = strictStateDate(value.date)
  if (date) {
    state.date = date
    if (Array.isArray(value.sent_slots)) {
      state.sent_slots = [...new Set(value.sent_slots.filter(
        (slot): slot is NaturalSlot => typeof slot === 'string' && VALID_STATE_SLOTS.has(slot as NaturalSlot),
      ))]
    }
    if (typeof value.attempt_count === 'number'
      && Number.isInteger(value.attempt_count)
      && value.attempt_count >= 0
      && value.attempt_count <= MAX_STATE_ATTEMPTS) state.attempt_count = value.attempt_count
    if (typeof value.last_slot === 'string' && VALID_STATE_SLOTS.has(value.last_slot as NaturalSlot)) state.last_slot = value.last_slot
    if (Array.isArray(value.last_decision_ids)) {
      const ids = value.last_decision_ids.filter(
        (item): item is string => typeof item === 'string' && DECISION_ID_RE.test(item),
      )
      if (ids.length <= 50) state.last_decision_ids = [...new Set(ids)]
    }
  }
  for (const field of ['last_cron_at', 'last_attempt_at', 'last_pushed_at', 'last_success_at'] as const) {
    const timestamp = stateTimestamp(value[field])
    if (timestamp) state[field] = timestamp
  }
  const lastCronBuildSha = normalizeBuildSha(value.last_cron_build_sha)
  if (lastCronBuildSha) state.last_cron_build_sha = lastCronBuildSha
  const scheduledAt = stateTimestamp(value.scheduled_at)
  if (scheduledAt) state.scheduled_at = scheduledAt
  if (typeof value.schedule_delay_seconds === 'number'
    && Number.isInteger(value.schedule_delay_seconds)
    && value.schedule_delay_seconds >= 0
    && value.schedule_delay_seconds <= MAX_SCHEDULE_DELAY_SECONDS) {
    state.schedule_delay_seconds = value.schedule_delay_seconds
  }
  if (typeof value.last_cron_result === 'string' && VALID_CRON_RESULTS.has(value.last_cron_result)) {
    state.last_cron_result = value.last_cron_result as PushState['last_cron_result']
  }
  const cronReason = boundedStateText(value.last_cron_reason, 80)
  if (cronReason != null) state.last_cron_reason = cronReason
  const lastError = boundedStateText(value.last_error, 240)
  if (lastError != null) state.last_error = lastError
  const lastWarning = boundedStateText(value.last_warning, 240)
  if (lastWarning != null) state.last_warning = lastWarning
  if (typeof value.decision_status === 'string' && VALID_DECISION_STATUSES.has(value.decision_status)) {
    state.decision_status = value.decision_status as PushState['decision_status']
  }
  if (value.last_http_status === null) state.last_http_status = null
  else if (typeof value.last_http_status === 'number'
    && Number.isInteger(value.last_http_status)
    && value.last_http_status >= 100
    && value.last_http_status <= 599) state.last_http_status = value.last_http_status
  return state
}

function incrementAttempts(value: number): number {
  return Math.min(MAX_STATE_ATTEMPTS, value + 1)
}

function numberOrNull(value: unknown): number | null {
  if (value == null || String(value).trim() === '' || String(value).trim() === '--') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function beijingNow(now = new Date()): { date: string; iso: string; weekday: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
  const date = `${part('year')}-${part('month')}-${part('day')}`
  return {
    date, weekday: part('weekday'), hour: part('hour'), minute: part('minute'),
    iso: `${date}T${part('hour')}:${part('minute')}:${part('second')}+08:00`,
  }
}

function naturalSlot(now: ReturnType<typeof beijingNow>, requested?: NaturalSlot): NaturalSlot {
  if (requested) return requested
  return `${now.hour}:${now.minute}` >= '14:35' ? COMPENSATION_SLOT : PRIMARY_SLOT
}

async function github(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const request = {
    ...init,
    headers: {
      'User-Agent': 'sinan-cloudflare-worker',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GIST_TOKEN}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  }
  if (!init.method || init.method === 'GET') return externalGet(`https://api.github.com${path}`, request)
  return fetch(`https://api.github.com${path}`, { ...request, signal: AbortSignal.timeout(10_000) })
}

async function readGist(env: Env): Promise<Record<string, { content?: string; raw_url?: string; truncated?: boolean }>> {
  const response = await github(env, `/gists/${env.GIST_ID}`)
  const payload = await readJson(response)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ExternalDataError('schema_invalid')
  const files = (payload as { files?: unknown }).files
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new ExternalDataError('schema_invalid')
  return files as Record<string, { content?: string; raw_url?: string; truncated?: boolean }>
}

async function fileContent(file?: { content?: string; raw_url?: string; truncated?: boolean }): Promise<string | null> {
  if (!file) return null
  if (file.truncated && file.raw_url) {
    const response = await externalGet(file.raw_url)
    return readBoundedText(response)
  }
  return file.content ?? null
}

const PUBLIC_ORIGINS = new Set([
  'https://aureliuswu.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

function publicCacheOrigin(request: Request): string {
  const origin = request.headers.get('Origin') || ''
  return PUBLIC_ORIGINS.has(origin) ? origin : 'anonymous'
}

function publicHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': PUBLIC_ORIGINS.has(origin) ? origin : 'https://aureliuswu.github.io',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'public, max-age=20',
    'Vary': 'Origin',
  }
}

async function publicEstimates(request: Request, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const codes = [...new Set((url.searchParams.get('codes') || '').split(',').map((v) => v.trim()).filter(Boolean))]
  if (!codes.length || codes.length > 50 || codes.some((code) => !/^\d{6}$/.test(code))) {
    return Response.json({ error: 'codes must contain 1-50 six-digit fund codes' }, {
      status: 400, headers: publicHeaders(request),
    })
  }
  const today = beijingNow().date
  const origin = publicCacheOrigin(request)
  const cacheKey = new Request(`https://estimate-cache.internal/v4?date=${today}&codes=${encodeURIComponent([...codes].sort().join(','))}&origin=${encodeURIComponent(origin)}`)
  const edgeCache = typeof caches === 'undefined' ? null : caches.default
  const cached = edgeCache ? await edgeCache.match(cacheKey) : null
  if (cached) return cached
  try {
    const batch = await resolveValuations(codes)
    const unavailable = codes.filter((code) => batch.unavailable.has(code))
    const unavailableItems = unavailable.map((code) => publicUnavailableItem(batch.unavailable.get(code)!))
    // Existing clients expect unavailable rows to stay out of `items` because
    // some legacy normalizers coerce null numeric values to zero.
    const items = codes.flatMap((code) => {
      const item = batch.estimates.get(code)
      return item ? [publicValuationItem(item)] : []
    })
    const kinds = new Set([...batch.estimates.values()].map((item) => item.kind))
    const source = kinds.size > 1
      ? 'eastmoney_mixed'
      : kinds.has('estimate')
        ? 'eastmoney_estimate_table'
        : kinds.has('holdings_model')
          ? 'eastmoney_holdings_model'
          : kinds.has('official_nav')
            ? 'eastmoney_official_nav'
            : 'unavailable'
    const hasFallback = [...batch.estimates.values()].some((item) => item.isFallback)
    const hasModel = kinds.has('holdings_model')
    const hasOfficial = kinds.has('official_nav')
    const accounting = {
      primary: [...batch.estimates.values()].filter((item) => item.kind === 'estimate').length,
      model: [...batch.estimates.values()].filter((item) => item.kind === 'holdings_model').length,
      official: [...batch.estimates.values()].filter((item) => item.kind === 'official_nav').length,
      unavailable: unavailable.length,
    }
    const response = Response.json({
      status: unavailable.length === codes.length ? 'unavailable' : (hasFallback || unavailable.length ? 'degraded' : 'ok'),
      source,
      fallback: hasModel && hasOfficial ? 'mixed' : hasModel ? 'holdings_model' : hasOfficial ? 'official_nav' : null,
      fallback_attempted: hasFallback || unavailable.length ? 'holdings_model_then_official_nav' : null,
      source_time_precision: 'date',
      fetched_at: new Date().toISOString(),
      requested: codes.length,
      returned: batch.estimates.size,
      unavailable: unavailable.length,
      unavailable_codes: unavailable,
      unavailable_items: unavailableItems,
      accounting,
      items,
    }, { headers: publicHeaders(request) })
    if (edgeCache && ctx) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()))
    return response
  } catch {
    return Response.json({ error: 'valuation_resolution_failed' }, {
      status: 502, headers: publicHeaders(request),
    })
  }
}

async function publicQuotes(request: Request, url: URL): Promise<Response> {
  const rawCodes = (url.searchParams.get('codes') || '').split(',').map((value) => value.trim()).filter(Boolean)
  const codes = [...new Set(rawCodes)]
  if (!codes.length || codes.length > 50 || codes.length !== rawCodes.length
    || codes.some((code) => !isSupportedPublicQuoteCode(code))) {
    return Response.json({ error: 'codes must contain 1-50 unique supported market codes' }, {
      status: 400, headers: publicHeaders(request),
    })
  }
  try {
    const batch = await fetchPublicQuotes(codes)
    const items = codes.flatMap((code) => {
      const item = batch.items.get(code)
      return item ? [{
        code: item.code,
        price: item.price,
        change_pct: item.changePct,
        source_time: item.sourceTime,
        source: item.source,
        status: item.status,
      }] : []
    })
    const sources = new Set(items.map((item) => item.source))
    const degraded = batch.unavailableCodes.length > 0
      || items.some((item) => item.status === 'stale' || item.change_pct == null)
    return Response.json({
      status: items.length === 0 ? 'unavailable' : degraded ? 'degraded' : 'ok',
      source: sources.size > 1 ? 'mixed' : [...sources][0] || 'unavailable',
      fetched_at: new Date().toISOString(),
      requested: codes.length,
      returned: items.length,
      items,
      unavailable_codes: batch.unavailableCodes,
      errors: batch.failures.map((failure) => ({
        source: failure.source,
        reason: failure.reason,
        upstream_status: failure.upstreamStatus,
        codes: failure.codes,
      })),
    }, { headers: publicHeaders(request) })
  } catch {
    return Response.json({ error: 'quote_resolution_failed' }, {
      status: 502, headers: publicHeaders(request),
    })
  }
}

const HEALTH_CACHE_TTL_MS = 30_000
let healthCache: { gistId: string; expiresAt: number; runtime: Record<string, unknown> } | null = null

function healthHeaders(request: Request): HeadersInit {
  return {
    ...publicHeaders(request),
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'public, max-age=30',
  }
}

function healthFailureReason(error: unknown): string {
  if (error instanceof ExternalDataError) return error.reason
  return error instanceof SyntaxError ? 'state_json_invalid' : 'state_unavailable'
}

function healthRuntime(state: Partial<PushState>, today: string): Record<string, unknown> {
  return {
    state_available: true, last_cron_at: state.last_cron_at || null,
    last_cron_build_sha: state.last_cron_build_sha || null,
    scheduled_at: state.scheduled_at || null,
    schedule_delay_seconds: state.schedule_delay_seconds ?? null,
    last_cron_result: state.last_cron_result || null,
    last_cron_reason: state.last_cron_reason || null,
    last_attempt_at: state.last_attempt_at || null,
    last_result: state.last_cron_result === 'skipped'
      ? 'skipped'
      : state.last_error
        ? 'failed'
        : state.last_warning
          ? 'sent_with_warning'
          : state.last_pushed_at
            ? 'sent'
            : 'not_sent',
    last_error: state.last_error ? 'operation_failed' : null,
    last_success_at: state.last_success_at || state.last_pushed_at || null,
    last_warning: state.last_warning ? 'decision_degraded' : null,
    decision_status: state.decision_status || null,
    attempt_count: state.attempt_count || 0,
    sent_today: state.date === today && Boolean(state.sent_slots?.some((slot) => VALID_STATE_SLOTS.has(slot as NaturalSlot))),
    state_date: state.date || null,
  }
}

async function cachedHealthRuntime(env: Env, clock = new Date()): Promise<Record<string, unknown>> {
  const now = clock.getTime()
  if (healthCache?.gistId === env.GIST_ID && healthCache.expiresAt > now) return healthCache.runtime
  let runtime: Record<string, unknown>
  try {
    const files = await readGist(env)
    const raw = await fileContent(files[STATE_FILE])
    let parsed: unknown
    try { parsed = JSON.parse(raw || '{}') } catch { throw new ExternalDataError('json_invalid') }
    if (!plainRecord(parsed)) throw new ExternalDataError('schema_invalid')
    const state = parsePushState(raw)
    runtime = healthRuntime(state, beijingNow(clock).date)
  } catch (error) {
    runtime = { state_available: false, last_error: healthFailureReason(error) }
  }
  healthCache = { gistId: env.GIST_ID, expiresAt: now + HEALTH_CACHE_TTL_MS, runtime }
  return runtime
}

async function publicFundHoldings(request: Request, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const code = (url.searchParams.get('code') || '').trim()
  if (!/^\d{6}$/.test(code)) {
    return Response.json({ error: 'code must be a six-digit fund code' }, {
      status: 400, headers: publicHeaders(request),
    })
  }
  const origin = publicCacheOrigin(request)
  const cacheKey = new Request(`https://holdings-cache.internal/v1?code=${code}&origin=${encodeURIComponent(origin)}`)
  const edgeCache = typeof caches === 'undefined' ? null : caches.default
  const cached = edgeCache ? await edgeCache.match(cacheKey) : null
  if (cached) return cached
  try {
    const holdings = await fetchFundHoldings(code)
    const headers = new Headers(publicHeaders(request))
    headers.set('Cache-Control', 'public, max-age=1800')
    const response = Response.json({
      source: 'eastmoney_fund_archives',
      fetched_at: new Date().toISOString(),
      code,
      report_date: holdings.reportDate,
      status: holdings.items.length ? 'ok' : 'empty',
      returned: holdings.items.length,
      items: holdings.items,
    }, { headers })
    if (edgeCache && ctx) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()))
    return response
  } catch {
    return Response.json({ error: 'holdings_upstream_failed' }, {
      status: 502, headers: publicHeaders(request),
    })
  }
}

export function estimateContext(estimate?: Estimate): DecisionEstimateContext {
  if (!estimate) {
    return {
      status: 'unavailable', source: 'unavailable', source_time: null, source_time_precision: 'date',
      estimate_change: null, estimate_nav: null, estimate_time: null,
      value_nav: null, value_change: null, nav_date: null, target_nav_date: null,
      kind: 'unavailable', is_fallback: true,
      market: 'unknown', estimate_model_version: null, sample_count: null, coverage: null, uncertainty: null,
      fallback_reason: 'estimate_missing_for_decision',
      base_nav: null, base_nav_date: null, value_date: null,
      model_coverage: null, model_quote_count: null, model_report_date: null,
      model_oldest_quote_time: null, model_newest_quote_time: null, model_rejected_count: null,
      diagnostics: {
        primary_reason: 'estimate_missing_for_decision', source_time_precision: 'date',
      },
    }
  }
  const isOfficial = estimate.kind === 'official_nav'
  const isQdii = estimate.kind === 'qdii_next_nav_estimate'
  const sourceTime = canonicalWireTime(estimate.sourceTime, estimate.diagnostics.source_time_precision)
  if (!sourceTime) return estimateContext()
  // Scheduled evidence uses the same strict serializer as the public wire.
  // This is contract support, not permission to use an uncalibrated QDII model.
  try { publicValuationItem(estimate) }
  catch (error) {
    if (error instanceof ExternalDataError) return estimateContext()
    throw error
  }
  return {
    status: estimate.status,
    source: estimate.source,
    source_time: sourceTime,
    source_time_precision: estimate.diagnostics.source_time_precision,
    // A published NAV is an observed value, never an intraday estimate.  Keep
    // the estimate fields null so downstream code cannot relabel an official
    // value/change as a live prediction.
    estimate_change: isOfficial ? null : estimate.change,
    estimate_nav: isOfficial ? null : estimate.valueNav,
    estimate_time: isOfficial ? null : sourceTime,
    value_nav: estimate.valueNav,
    value_change: isOfficial ? estimate.change : null,
    nav_date: isOfficial ? (estimate.valueDate || null) : null,
    target_nav_date: isQdii ? (estimate.targetNavDate ?? null) : null,
    kind: estimate.kind === 'estimate' ? 'intraday_estimate' : estimate.kind,
    market: isQdii ? 'overseas' : 'unknown',
    estimate_model_version: isQdii ? (estimate.estimateModelVersion ?? null) : null,
    sample_count: isQdii ? (estimate.sampleCount ?? null) : null,
    coverage: isQdii ? estimate.coverage : null,
    uncertainty: isQdii ? (estimate.uncertainty ?? null) : null,
    is_fallback: estimate.isFallback,
    fallback_reason: estimate.isFallback ? estimate.diagnostics.primary_reason : null,
    base_nav: estimate.baseNav,
    base_nav_date: estimate.baseNavDate || null,
    value_date: estimate.valueDate || null,
    model_coverage: estimate.kind === 'holdings_model' || isQdii ? estimate.coverage : null,
    model_quote_count: estimate.kind === 'holdings_model' ? estimate.quoteCount : null,
    model_report_date: estimate.kind === 'holdings_model' ? (estimate.reportDate || null) : null,
    model_oldest_quote_time: estimate.kind === 'holdings_model'
      ? canonicalWireTime(estimate.oldestQuoteTime, 'datetime')
      : null,
    model_newest_quote_time: estimate.kind === 'holdings_model'
      ? canonicalWireTime(estimate.newestQuoteTime, 'datetime')
      : null,
    model_rejected_count: estimate.kind === 'holdings_model' ? estimate.rejectedCount : null,
    diagnostics: { ...estimate.diagnostics },
  }
}

function safeDecisionEstimate(estimate: Estimate | undefined): Estimate | undefined {
  if (estimate?.kind === 'qdii_next_nav_estimate') {
    try { publicValuationItem(estimate) }
    catch (error) {
      if (error instanceof ExternalDataError) return undefined
      throw error
    }
  }
  if (!estimate || estimate.kind !== 'estimate' || estimate.status !== 'delayed') return estimate
  if (estimate.baseNav == null || !estimate.baseNavDate) return undefined
  const reason = estimate.diagnostics.primary_reason || 'estimate_delayed'
  return {
    ...estimate,
    lastNav: null,
    estNav: estimate.baseNav,
    // The delayed row only proves one official NAV value. Without a preceding
    // official NAV pair, its move is unknown and must not be fabricated as 0.
    change: null,
    time: estimate.baseNavDate,
    navDate: estimate.baseNavDate,
    label: '最近正式净值',
    kind: 'official_nav',
    source: 'eastmoney_official_nav',
    status: 'latest_official',
    isFallback: true,
    baseNav: null,
    baseNavDate: '',
    valueNav: estimate.baseNav,
    valueDate: estimate.baseNavDate,
    sourceTime: estimate.baseNavDate,
    coverage: null,
    quoteCount: null,
    reportDate: '',
    oldestQuoteTime: '',
    newestQuoteTime: '',
    rejectedCount: 0,
    diagnostics: {
      ...estimate.diagnostics,
      primary_reason: reason,
      source_time_precision: 'date',
    },
  }
}

function portfolioItems(entries: WatchEntry[], estimates: Map<string, Estimate>) {
  const grouped = new Map<string, { shares: number; hasPositionInput: boolean; target?: number }>()
  for (const entry of entries) {
    const current = grouped.get(entry.code) || { shares: 0, hasPositionInput: false }
    const shares = numberOrNull(entry.shares)
    if (shares != null) {
      current.shares += shares
      current.hasPositionInput = true
    }
    if (entry.target_weight != null) current.target = numberOrNull(entry.target_weight) ?? undefined
    grouped.set(entry.code, current)
  }
  const values = new Map<string, number>()
  const missing: string[] = []
  for (const [code, row] of grouped) {
    const estimate = safeDecisionEstimate(estimates.get(code))
    const nav = numberOrNull(estimate?.estNav ?? estimate?.lastNav)
    if (row.hasPositionInput && row.shares > 0 && (nav == null || nav <= 0)) missing.push(code)
    if (row.hasPositionInput && row.shares > 0 && nav != null && nav > 0) {
      values.set(code, row.shares * nav)
    }
  }
  if (missing.length) {
    return {
      items: [...grouped].map(([code, row]) => ({
        code,
        holding: {
          is_held: row.hasPositionInput && row.shares > 0,
          ...(row.hasPositionInput ? { shares: row.shares } : {}),
          ...(row.target != null ? { target_weight: row.target } : {}),
          source: 'worker-gist' as const,
        },
        estimate_context: estimateContext(safeDecisionEstimate(estimates.get(code))),
      })),
      portfolioValue: 0,
      complete: false,
      missing,
    }
  }
  const portfolioValue = [...values.values()].reduce((sum, value) => sum + value, 0)
  const items = [...grouped].map(([code, row]) => {
    const estimate_context = estimateContext(safeDecisionEstimate(estimates.get(code)))
    const held = row.hasPositionInput && row.shares > 0
    if (!held || portfolioValue <= 0) return {
      code,
      holding: {
        is_held: false,
        ...(row.hasPositionInput ? { shares: row.shares } : {}),
        ...(row.target != null ? { target_weight: row.target } : {}),
        source: 'worker-gist' as const,
      },
      estimate_context,
    }
    const marketValue = values.get(code)
    if (marketValue == null) throw new Error('portfolio_value_incomplete')
    return {
      code,
      holding: {
        is_held: true,
        shares: row.shares,
        market_value: Number(marketValue.toFixed(2)),
        current_weight: Number((marketValue / portfolioValue * 100).toFixed(2)),
        ...(row.target != null ? { target_weight: Number(row.target.toFixed(2)) } : {}),
        source: 'worker-gist' as const,
      },
      estimate_context,
    }
  })
  return {
    items,
    portfolioValue: Number(portfolioValue.toFixed(2)),
    complete: missing.length === 0,
    missing,
  }
}

function invalidDecisionResponse(reason: string): never {
  throw new DecisionError(`组合决策响应格式无效: ${reason}`, 502)
}

function parseDecisionResponse(
  value: unknown,
  requestId: string,
  requestedCodes: string[],
): Record<string, unknown> {
  if (!plainRecord(value)) invalidDecisionResponse('payload_not_object')
  if (typeof value.complete !== 'boolean') invalidDecisionResponse('complete_missing')
  if (typeof value.duplicate !== 'boolean') invalidDecisionResponse('duplicate_missing')
  if (value.request_id !== requestId) invalidDecisionResponse('request_id_mismatch')
  if (!Number.isInteger(value.requested) || value.requested !== requestedCodes.length) {
    invalidDecisionResponse('requested_mismatch')
  }
  if (!Array.isArray(value.decisions) || !Array.isArray(value.errors)) {
    invalidDecisionResponse('result_arrays_missing')
  }
  if (!Number.isInteger(value.total) || value.total !== value.decisions.length) {
    invalidDecisionResponse('total_mismatch')
  }
  if (typeof value.policy_version !== 'string' || !/^pol_[0-9a-f]{64}$/.test(value.policy_version)) {
    invalidDecisionResponse('policy_version_invalid')
  }
  if (typeof value.strategy_version !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(value.strategy_version)) {
    invalidDecisionResponse('strategy_version_invalid')
  }
  if (!plainRecord(value.allocation) || typeof value.allocation.complete !== 'boolean'
    || value.allocation.complete !== value.complete || !Array.isArray(value.allocation.warnings)
    || value.allocation.warnings.some((item) => typeof item !== 'string')) {
    invalidDecisionResponse('allocation_invalid')
  }

  const requested = new Set(requestedCodes)
  const accounted = new Set<string>()
  for (const raw of value.decisions) {
    if (!plainRecord(raw)) invalidDecisionResponse('decision_not_object')
    const code = raw.code
    const action = raw.action
    if (typeof code !== 'string' || !requested.has(code) || accounted.has(code)) {
      invalidDecisionResponse('decision_code_invalid')
    }
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
      invalidDecisionResponse('decision_action_invalid')
    }
    if (typeof raw.action_label !== 'string' || !raw.action_label.trim()
      || typeof raw.summary !== 'string' || !raw.summary.trim()) {
      invalidDecisionResponse('decision_text_invalid')
    }
    if (!plainRecord(raw.decision) || typeof raw.decision.decision_id !== 'string'
      || !DECISION_ID_RE.test(raw.decision.decision_id)
      || raw.decision.action !== action || raw.decision.fund_code !== code) {
      invalidDecisionResponse('decision_snapshot_invalid')
    }
    accounted.add(code)
  }
  for (const raw of value.errors) {
    if (!plainRecord(raw) || typeof raw.code !== 'string' || !requested.has(raw.code)
      || accounted.has(raw.code) || typeof raw.error !== 'string' || !raw.error.trim()) {
      invalidDecisionResponse('error_row_invalid')
    }
    accounted.add(raw.code)
  }
  if (accounted.size !== requested.size || [...requested].some((code) => !accounted.has(code))) {
    invalidDecisionResponse('fund_coverage_incomplete')
  }
  if (value.complete && (value.errors.length > 0 || value.decisions.length !== requested.size)) {
    invalidDecisionResponse('complete_result_inconsistent')
  }
  return value
}

async function decisions(
  env: Env,
  entries: WatchEntry[],
  estimates: Map<string, Estimate>,
  requestId: string,
): Promise<DecisionOutcome> {
  if (!env.FUND_API_BASE) return { result: null, status: 'disabled' }
  if (!env.WORKER_TOKEN) throw new DecisionError('组合决策未执行：WORKER_TOKEN 未配置')
  const payload = portfolioItems(entries, estimates)
  if (!payload.complete) {
    return {
      result: null,
      status: 'degraded',
      warning: `组合决策未执行：持仓缺少可用净值（${payload.missing.join(',')}）`,
    }
  }
  const request: WorkerDecisionRequest = {
    request_id: requestId, items: payload.items, portfolio_value: payload.portfolioValue,
  }
  try {
    const response = await fetch(`${env.FUND_API_BASE.replace(/\/$/, '')}/api/v2/portfolio/decisions`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        ...(env.WORKER_TOKEN ? { Authorization: `Bearer ${env.WORKER_TOKEN}` } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(25_000),
    })
    if (response.status === 401 || response.status === 403) {
      throw new DecisionError(`组合决策鉴权失败: HTTP ${response.status}`, response.status)
    }
    if (response.status === 409 || response.status === 425) {
      throw new DecisionError(`组合决策幂等冲突: HTTP ${response.status}`, response.status)
    }
    if (!response.ok) {
      return { result: null, status: 'degraded', warning: `组合决策暂不可用: HTTP ${response.status}` }
    }
    let raw: unknown
    try { raw = await response.json() }
    catch { invalidDecisionResponse('json_invalid') }
    const result = parseDecisionResponse(raw, requestId, payload.items.map((item) => item.code))
    if (result.complete === false) {
      const warnings = plainRecord(result.allocation) && Array.isArray(result.allocation.warnings)
        ? result.allocation.warnings.filter((value): value is string => typeof value === 'string')
        : []
      return {
        result,
        status: 'degraded',
        warning: warnings[0] || '组合决策数据不完整，已停止伪精确组合计算',
      }
    }
    return { result, status: 'ok' }
  } catch (error) {
    if (error instanceof DecisionError) throw error
    const name = error instanceof Error ? error.name : ''
    const reason = name === 'AbortError' || name === 'TimeoutError' ? 'network_timeout' : 'network_error'
    return {
      result: null,
      status: 'degraded',
      warning: `组合决策暂不可用: ${reason}`,
    }
  }
}

async function settleOutcomes(env: Env): Promise<{ result: OutcomeSettlement | null; warning?: string }> {
  const prefix = '决策结果结算暂不可用'
  try {
    const response = await fetch(`${env.FUND_API_BASE.replace(/\/$/, '')}/api/v2/outcomes/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.WORKER_TOKEN}`,
      },
      body: '{}',
      signal: AbortSignal.timeout(25_000),
    })
    if (!response.ok) {
      const warning = `${prefix}: HTTP ${response.status}`
      console.warn(warning)
      return { result: null, warning }
    }
    let raw: unknown
    try { raw = await response.json() }
    catch {
      const warning = `${prefix}: json_invalid`
      console.warn(warning)
      return { result: null, warning }
    }
    if (!plainRecord(raw)
      || !Number.isInteger(raw.settled) || Number(raw.settled) < 0
      || !Number.isInteger(raw.pending) || Number(raw.pending) < 0
      || !Array.isArray(raw.errors) || raw.errors.length > 1000) {
      const warning = `${prefix}: schema_invalid`
      console.warn(warning)
      return { result: null, warning }
    }
    const result: OutcomeSettlement = {
      settled: Number(raw.settled), pending: Number(raw.pending), errors: raw.errors,
    }
    if (result.errors.length) {
      const warning = `决策结果结算存在 ${result.errors.length} 个显式错误`
      console.warn(warning)
      return { result, warning }
    }
    return { result }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const reason = name === 'AbortError' || name === 'TimeoutError' ? 'network_timeout' : 'network_error'
    const warning = `${prefix}: ${reason}`
    console.warn(warning)
    return { result: null, warning }
  }
}

function warnings(...values: Array<string | undefined>): string {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].join('；')
}

function decisionIds(result: Record<string, unknown> | null): string[] {
  if (!result || !Array.isArray(result.decisions)) return []
  const ids = result.decisions.flatMap((row) => {
    if (!plainRecord(row) || !plainRecord(row.decision)) return []
    const value = row.decision.decision_id
    return typeof value === 'string' && DECISION_ID_RE.test(value) ? [value] : []
  })
  return [...new Set(ids)]
}

function parseNotificationAuditResponse(
  value: unknown,
  ids: string[],
  scheduledWindow: string,
  status: NotificationStatus,
  attemptNo: number,
  naturalSchedule: boolean,
): NotificationAuditOutcome {
  if (!plainRecord(value) || !Array.isArray(value.events)
    || !Number.isInteger(value.total) || value.total !== ids.length
    || value.events.length !== ids.length) {
    throw new DecisionError('通知审计响应格式无效: envelope_invalid', 502)
  }
  const expected = new Set(ids)
  const returned = new Set<string>()
  const claims: boolean[] = []
  const duplicates: boolean[] = []
  for (const raw of value.events) {
    if (!plainRecord(raw)) throw new DecisionError('通知审计响应格式无效: event_invalid', 502)
    if (!plainRecord(raw.event) || typeof raw.claimed !== 'boolean' || typeof raw.duplicate !== 'boolean') {
      throw new DecisionError('通知审计响应格式无效: claim_flags_missing', 502)
    }
    const nested = raw.event
    claims.push(raw.claimed)
    duplicates.push(raw.duplicate)
    const id = nested.decision_id
    if (typeof id !== 'string' || !expected.has(id) || returned.has(id)
      || typeof nested.notification_event_id !== 'string' || !NOTIFICATION_ID_RE.test(nested.notification_event_id)
      || typeof nested.event_log_id !== 'string' || !NOTIFICATION_LOG_ID_RE.test(nested.event_log_id)
      || nested.scheduled_window !== scheduledWindow || nested.status !== status
      || nested.attempt_no !== attemptNo || nested.natural_schedule !== naturalSchedule
      || typeof nested.occurred_at !== 'string' || !Number.isFinite(Date.parse(nested.occurred_at))) {
      throw new DecisionError('通知审计响应格式无效: event_mismatch', 502)
    }
    returned.add(id)
  }
  if (returned.size !== expected.size) {
    throw new DecisionError('通知审计响应格式无效: coverage_incomplete', 502)
  }
  if (claims.some((signal) => signal !== claims[0])
    || duplicates.some((signal) => signal !== duplicates[0])) {
    throw new DecisionError('通知审计响应格式无效: claim_inconsistent', 502)
  }
  const claimed = claims[0]
  const duplicate = duplicates[0]
  if (status === 'attempted') {
    if (claimed === duplicate) {
      throw new DecisionError('通知审计响应格式无效: attempted_claim_invalid', 502)
    }
  } else if (claimed) {
    throw new DecisionError('通知审计响应格式无效: non_attempt_claimed', 502)
  }
  return { claimed, duplicate }
}

async function recordNotificationEvent(
  env: Env,
  ids: string[],
  now: ReturnType<typeof beijingNow>,
  slot: string,
  status: NotificationStatus,
  attemptNo: number,
  naturalSchedule: boolean,
  errorClass?: string,
): Promise<NotificationAuditOutcome> {
  if (!ids.length || !env.FUND_API_BASE) {
    throw new DecisionError('通知审计未执行：决策标识或后端地址缺失')
  }
  const scheduledWindow = `${now.date}T${slot}+08:00`
  const response = await fetch(`${env.FUND_API_BASE.replace(/\/$/, '')}/api/v2/notifications/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.WORKER_TOKEN ? { Authorization: `Bearer ${env.WORKER_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      decision_ids: ids,
      scheduled_window: scheduledWindow,
      status,
      attempt_no: attemptNo,
      natural_schedule: naturalSchedule,
      occurred_at: now.iso,
      ...(status === 'failed' && errorClass ? { error_class: errorClass } : {}),
      detail: { runtime: 'cloudflare-worker', window: slot },
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 401 || response.status === 403) {
    throw new DecisionError(`通知审计鉴权失败: HTTP ${response.status}`, response.status)
  }
  if (!response.ok) throw new DecisionError(`通知审计写入失败: HTTP ${response.status}`, response.status)
  let payload: unknown
  try { payload = await response.json() }
  catch { throw new DecisionError('通知审计响应格式无效: json_invalid', 502) }
  return parseNotificationAuditResponse(
    payload, ids, scheduledWindow, status, attemptNo, naturalSchedule,
  )
}

export function formatMessage(entries: WatchEntry[], estimates: Map<string, Estimate>, result: Record<string, unknown> | null) {
  const decisionRows = Array.isArray(result?.decisions) ? result.decisions as Record<string, unknown>[] : []
  const byCode = new Map(decisionRows.map((row) => [String(row.code), row]))
  const lines = entries.map((entry) => {
    const estimate = estimates.get(entry.code)
    // `run` only passes entries that received an explicit valuation outcome.
    // An absent estimate therefore means the resolver marked this fund
    // unavailable; keep it visible without inventing a numeric value.
    if (!estimate) return `- **${entry.name || entry.code}** --（数据暂不可用）`
    if (estimate.kind === 'estimate' && estimate.status === 'delayed') {
      return `- **${entry.name || estimate.name || entry.code}** --（行情过期/延迟数据不参与）`
    }
    const change = estimate.change == null ? `--（${estimate.label}）` : `${estimate.change >= 0 ? '+' : ''}${estimate.change.toFixed(2)}%（${estimate.label}）`
    const decision = estimate.kind === 'official_nav' ? undefined : byCode.get(entry.code)
    const actionLabels: Record<string, string> = {
      buy: '开始建仓', dca: '分批定投', watch: '继续观察', add: '目标内加仓',
      hold: '继续持有', reduce: '分批减仓', sell: '分批退出',
    }
    const rawAction = decision ? String(decision.action_label || decision.action || '观察') : ''
    const action = decision ? ` → **${actionLabels[rawAction] || rawAction}**` : ''
    const summary = decision?.summary ? `，${String(decision.summary)}` : ''
    return `- **${entry.name || estimate.name || entry.code}** ${change}${action}${summary}`
  }).filter(Boolean)
  const message = `${lines.join('\n')}\n\n> 数据辅助分析，不构成投资建议。`
  return message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 20)}\n\n> 内容已安全截断`
}

class PushError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number | null = null,
    readonly retryAfter = 0,
    readonly businessCode: number | null = null,
  ) {
    super(`serverchan_${reason}${status != null ? `_http_${status}` : ''}${businessCode != null ? `_code_${businessCode}` : ''}`)
    this.name = 'PushError'
  }
}

function persistedFailureReason(error: unknown): string {
  if (error instanceof PushError) return error.message
  if (error instanceof DecisionError) return error.status == null ? 'decision_configuration_error' : `decision_http_${error.status}`
  if (error instanceof ExternalDataError) return error.reason
  const name = error instanceof Error ? error.name : ''
  return name === 'AbortError' || name === 'TimeoutError' ? 'network_timeout' : 'operation_failed'
}

function notificationFailureClass(error: unknown): string {
  if (error instanceof PushError && [
    'timeout', 'network_error', 'response_invalid', 'response_too_large',
  ].includes(error.reason)) return 'delivery_ambiguous'
  // A syntactically readable response without any provider result code cannot
  // prove rejection: the provider may have accepted the notification before
  // returning a partial/changed response. Keep compensation fail-closed.
  if (error instanceof PushError
    && error.reason === 'business_rejected'
    && error.businessCode == null) return 'delivery_ambiguous'
  return persistedFailureReason(error)
}

async function serverChan(env: Env, title: string, content: string): Promise<void> {
  const body = new URLSearchParams({ title, desp: content })
  let response: Response
  try {
    response = await fetch(`https://sctapi.ftqq.com/${env.WECHAT_SENDKEY}.send`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    throw new PushError(name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network_error')
  }
  let result: string
  try { result = await readBoundedText(response, 16_384) }
  catch (error) {
    await response.body?.cancel().catch(() => undefined)
    throw new PushError(error instanceof ExternalDataError ? error.reason : 'response_invalid', response.status)
  }
  if (!response.ok) throw new PushError(
    'http_error', response.status, Number(response.headers.get('Retry-After') || 0),
  )
  let parsed: { code?: number; errno?: number; message?: string } = {}
  try { parsed = JSON.parse(result) } catch { /* non-JSON response */ }
  const businessCodes = [parsed.code, parsed.errno].filter((code): code is number => typeof code === 'number')
  const rejectedCode = businessCodes.find((code) => code !== 0)
  if (!businessCodes.length || rejectedCode != null) {
    throw new PushError('business_rejected', response.status, 0, rejectedCode ?? null)
  }
}

async function sendWithOneRetry(env: Env, title: string, content: string): Promise<void> {
  try { await serverChan(env, title, content) }
  catch (error) {
    if (!(error instanceof PushError) || error.status !== 429) throw error
    // Server酱通常使用秒；仅接受短等待，避免 Worker 长时间占用。
    const retryAfter = Math.min(5, Math.max(0, error.retryAfter))
    if (retryAfter) await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
    await serverChan(env, title, content)
  }
}

async function writeState(env: Env, state: PushState): Promise<void> {
  const response = await github(env, `/gists/${env.GIST_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [STATE_FILE]: { content: JSON.stringify(state, null, 2) } } }),
  })
  if (!response.ok) throw new Error(`Gist 状态写入失败: HTTP ${response.status}`)
}

async function recordCronObservation(
  env: Env,
  now: ReturnType<typeof beijingNow>,
  result: NonNullable<PushState['last_cron_result']>,
  options: {
    reason?: string
    error?: unknown
    warning?: string
    scheduledAt?: string
    delaySeconds?: number
  } = {},
): Promise<void> {
  const files = await readGist(env)
  const state = parsePushState(await fileContent(files[STATE_FILE]))
  const sameDay = state.date === now.date
  const current: PushState = {
    ...state,
    date: now.date,
    sent_slots: sameDay ? (state.sent_slots || []) : [],
    attempt_count: sameDay ? (state.attempt_count || 0) : 0,
    last_cron_at: now.iso,
    last_cron_build_sha: currentBuildSha() || undefined,
    scheduled_at: options.scheduledAt,
    schedule_delay_seconds: options.delaySeconds,
    last_cron_result: result,
    last_cron_reason: result === 'skipped' ? options.reason : undefined,
  }
  if (result === 'failed') {
    current.last_error = persistedFailureReason(options.error)
    current.last_warning = ''
  } else {
    current.last_error = ''
    current.last_warning = options.warning || ''
  }
  await writeState(env, current)
}

export async function run(
  env: Env,
  force: boolean,
  clock = new Date(),
  valuationOptions: { requestBudget?: number } = {},
  requestedSlot?: NaturalSlot,
) {
  if (!env.GIST_ID || !env.GIST_TOKEN || !env.WECHAT_SENDKEY) throw new Error('Worker 密钥配置不完整')
  const now = beijingNow(clock)
  const slot = force ? `${now.hour}:${now.minute}` : naturalSlot(now, requestedSlot)
  if (!force && (now.weekday === 'Sat' || now.weekday === 'Sun')) return { status: 'skipped', reason: 'weekend' }
  // Outcome closing is a daily maintenance responsibility, independent from
  // whether today's watchlist or intraday valuation can produce a push.
  const shouldSettle = !force && slot === PRIMARY_SLOT && Boolean(env.FUND_API_BASE && env.WORKER_TOKEN)
  const settlement = shouldSettle
    ? await settleOutcomes(env)
    : { result: null as OutcomeSettlement | null }
  const skipped = (reason: string) => shouldSettle
    ? {
        status: 'skipped' as const,
        reason,
        outcome_settlement: settlement.result,
        warning: settlement.warning || null,
      }
    : { status: 'skipped' as const, reason }
  const files = await readGist(env)
  const entries = parseWatchEntries(JSON.parse(await fileContent(files[WATCH_FILE]) || '[]') as unknown)
  if (!entries.length) return skipped('empty_watchlist')
  const state = parsePushState(await fileContent(files[STATE_FILE]))
  const current: PushState = state.date === now.date
    ? {
        date: now.date, sent_slots: state.sent_slots || [], last_slot: state.last_slot,
        last_attempt_at: state.last_attempt_at, last_pushed_at: state.last_pushed_at,
        last_success_at: state.last_success_at || state.last_pushed_at,
        attempt_count: state.attempt_count || 0, last_error: state.last_error,
        last_warning: state.last_warning, decision_status: state.decision_status,
        last_http_status: state.last_http_status ?? null,
        last_decision_ids: state.last_decision_ids || [],
      }
    : {
        date: now.date, sent_slots: [], attempt_count: 0, last_http_status: null,
        last_success_at: state.last_success_at || state.last_pushed_at,
      }
  if (!force && current.sent_slots.some((value) => VALID_STATE_SLOTS.has(value as NaturalSlot))) {
    if (slot === COMPENSATION_SLOT && current.last_decision_ids?.length) {
      await recordNotificationEvent(
        env, current.last_decision_ids, now, slot, 'skipped', 0, true,
      )
    }
    return skipped('already_sent')
  }

  const unique = new Map<string, WatchEntry>()
  for (const entry of entries) if (!unique.has(entry.code)) unique.set(entry.code, entry)
  const valuation = await resolveValuations([...unique.keys()], clock, valuationOptions)
  const publishable = new Map([...valuation.estimates].filter(([, estimate]) => isPublishableIntraday(estimate, now.date, clock)))
  const realEstimateCount = [...publishable.values()].filter((estimate) => estimate.kind === 'estimate').length
  const modeledCount = [...publishable.values()].filter((estimate) => estimate.kind === 'holdings_model').length
  if (!force && !publishable.size) {
    const officialOnly = valuation.estimates.size > 0
      && [...valuation.estimates.values()].every((estimate) => estimate.kind === 'official_nav')
    return skipped(officialOnly ? 'official_nav_only' : 'no_publishable_intraday')
  }
  if (force && !valuation.estimates.size) throw new Error('valuation_unavailable')
  // `publishable` is only the send gate. Once at least one intraday valuation
  // exists, retain every resolver outcome for display and portfolio decisions:
  // modeled/official rows carry their real NAV, while unavailable rows remain
  // absent from this numeric map and are represented explicitly downstream.
  const estimates = valuation.estimates
  const activeEntries = [...unique.values()].filter((entry) => (
    estimates.has(entry.code) || valuation.unavailable.has(entry.code)
  ))
  current.last_slot = slot
  current.last_attempt_at = now.iso
  current.attempt_count = incrementAttempts(current.attempt_count)
  current.last_error = ''
  current.last_warning = ''
  current.last_http_status = null
  let decision: DecisionOutcome
  try {
    // Portfolio decisions must fail closed when a held fund has no usable NAV;
    // do not silently compute weights from only the publishable subset.
    const requestId = force
      ? `manual-${now.date}-${slot.replace(':', '')}${now.iso.slice(17, 19)}`
      // Primary and compensation must replay the same immutable batch. If the
      // primary transport succeeded but its Gist marker failed, a new 14:40
      // decision id would defeat backend cross-window dedupe.
      : `natural-${now.date}-primary`
    decision = await decisions(env, [...unique.values()], estimates, requestId)
  } catch (error) {
    current.last_error = persistedFailureReason(error)
    current.last_http_status = error instanceof DecisionError ? error.status : null
    current.decision_status = 'degraded'
    if (!force) await writeState(env, current)
    throw error
  }
  const result = decision.result
  if (env.FUND_API_BASE && !result) {
    current.last_error = 'decision_snapshot_unavailable'
    current.last_http_status = 503
    current.decision_status = 'degraded'
    if (!force) await writeState(env, current)
    throw new DecisionError('组合决策不可用，无法建立通知幂等事件', 503)
  }
  const title = result ? `司南基金 · 自选决策摘要（${slot}）` : `司南基金 · 自选涨跌幅（${slot}）`
  current.decision_status = decision.status
  current.last_warning = warnings(decision.warning, settlement.warning)
  const ids = decisionIds(result)
  if (result) {
    try {
      if (!ids.length) throw new DecisionError('组合决策响应未包含可审计决策', 502)
      current.last_decision_ids = ids
      await recordNotificationEvent(env, ids, now, slot, 'scheduled', 0, !force)
      const claim = await recordNotificationEvent(
        env, ids, now, slot, 'attempted', current.attempt_count, !force,
      )
      if (!claim.claimed || claim.duplicate) {
        if (!force) await writeState(env, current)
        return skipped('notification_already_claimed')
      }
    } catch (error) {
      current.last_error = persistedFailureReason(error)
      current.last_http_status = error instanceof DecisionError ? error.status : null
      current.decision_status = 'degraded'
      if (!force) await writeState(env, current)
      throw error
    }
  }
  if (!force) {
    try {
      // The backend claim already exists, but transport has not started. If
      // the Gist checkpoint fails, close that claim explicitly as a safe
      // pre-delivery failure so the 14:40 window may compensate exactly once.
      await writeState(env, current)
    } catch (error) {
      current.last_error = persistedFailureReason(error)
      current.decision_status = 'degraded'
      if (result) {
        try {
          await recordNotificationEvent(
            env,
            ids,
            now,
            slot,
            'failed',
            current.attempt_count,
            true,
            'pre_delivery_state_persistence_failed',
          )
        } catch (auditError) {
          console.error('failed to close pre-delivery notification claim', auditError)
        }
      }
      throw error
    }
  }
  try {
    await sendWithOneRetry(env, title, formatMessage(activeEntries, estimates, result))
  } catch (error) {
    current.last_error = persistedFailureReason(error)
    current.last_http_status = error instanceof PushError ? error.status : null
    if (result) {
      try {
        await recordNotificationEvent(
          env, ids, now, slot, 'failed', current.attempt_count, !force, notificationFailureClass(error),
        )
      } catch (auditError) {
        console.error('failed to persist notification failure event', auditError)
      }
    }
    if (!force) await writeState(env, current)
    throw error
  }
  let auditWarning = ''
  if (result) {
    try {
      await recordNotificationEvent(
        env,
        ids,
        now,
        slot,
        !force && slot === COMPENSATION_SLOT ? 'compensated' : 'sent',
        current.attempt_count,
        !force,
      )
    } catch (error) {
      auditWarning = '通知已发送，但审计事件写入失败'
    }
  }
  // Persist the backend terminal event before the Gist success marker.  If the
  // Gist write fails after transport, the compensation run can still observe
  // the immutable sent/compensated audit and must not send a duplicate.
  if (!force) {
    current.sent_slots = [...new Set([...current.sent_slots, slot as NaturalSlot])].sort()
    current.last_slot = slot
    current.last_pushed_at = now.iso
    current.last_success_at = now.iso
    current.last_error = ''
    current.last_warning = warnings(decision.warning, settlement.warning, auditWarning)
    current.last_http_status = 200
    await writeState(env, current)
  }
  const warning = warnings(decision.warning, settlement.warning, auditWarning) || null
  return {
    status: warning ? 'sent_with_warning' : 'sent',
    funds: activeEntries.length,
    fresh: realEstimateCount > 0,
    modeled: modeledCount,
    stale: unique.size - publishable.size,
    decision_status: decision.status,
    warning,
    outcome_settlement: settlement.result,
    force,
  }
}

export async function runScheduled(
  env: Env,
  clock = new Date(),
  requestedSlot?: NaturalSlot,
  scheduledClock?: Date,
) {
  const now = beijingNow(clock)
  const scheduledAt = scheduledClock && Number.isFinite(scheduledClock.getTime())
    ? beijingNow(scheduledClock).iso
    : undefined
  const delaySeconds = scheduledAt
    ? Math.min(
        MAX_SCHEDULE_DELAY_SECONDS,
        Math.max(0, Math.floor((clock.getTime() - scheduledClock!.getTime()) / 1000)),
      )
    : undefined
  try {
    const result = await run(env, false, clock, { requestBudget: 34 }, requestedSlot)
    const reason = 'reason' in result ? String(result.reason) : undefined
    const warning = 'warning' in result && typeof result.warning === 'string'
      ? result.warning
      : undefined
    await recordCronObservation(
      env,
      now,
      result.status as NonNullable<PushState['last_cron_result']>,
      { reason, warning, scheduledAt, delaySeconds },
    )
    return result
  } catch (error) {
    try {
      await recordCronObservation(env, now, 'failed', {
        error, scheduledAt, delaySeconds,
      })
    } catch (stateError) {
      console.error('failed to persist cron observation', stateError)
    }
    throw error
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Cloudflare's scheduledTime is the nominal trigger instant, not the time
    // this isolate actually started. It is telemetry only: freshness, audit
    // occurred_at and last_cron_at must all use the real execution clock.
    const clock = new Date()
    const scheduledClock = Number.isFinite(controller.scheduledTime)
      ? new Date(controller.scheduledTime)
      : undefined
    const slot = controller.cron
      ? (controller.cron.startsWith('40 6 ') ? COMPENSATION_SLOT : PRIMARY_SLOT)
      : undefined
    ctx.waitUntil(runScheduled(env, clock, slot, scheduledClock).then(console.log))
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS' && (url.pathname === '/estimates' || url.pathname === '/quotes' || url.pathname === '/holdings' || url.pathname === '/health')) {
      return new Response(null, {
        status: 204,
        headers: url.pathname === '/health' ? healthHeaders(request) : publicHeaders(request),
      })
    }
    if (request.method === 'GET' && url.pathname === '/estimates') {
      return publicEstimates(request, url, ctx)
    }
    if (request.method === 'GET' && url.pathname === '/quotes') {
      return publicQuotes(request, url)
    }
    if (request.method === 'GET' && url.pathname === '/holdings') {
      return publicFundHoldings(request, url, ctx)
    }
    if (url.pathname === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Response.json({ error: 'method_not_allowed' }, {
          status: 405, headers: { ...healthHeaders(request), Allow: 'GET, HEAD, OPTIONS' },
        })
      }
      const runtime = await cachedHealthRuntime(env)
      const payload = {
        status: 'ok', service: 'sinan-estimate-push', version: '8.0.0', build_sha: currentBuildSha(), runtime, configured: {
        gist_id: Boolean(env.GIST_ID), fund_api: Boolean(env.FUND_API_BASE),
        gist_token: Boolean(env.GIST_TOKEN), serverchan: Boolean(env.WECHAT_SENDKEY), admin: Boolean(env.ADMIN_TOKEN),
        worker: Boolean(env.WORKER_TOKEN),
      } }
      if (request.method === 'HEAD') return new Response(null, { headers: healthHeaders(request) })
      return Response.json(payload, { headers: healthHeaders(request) })
    }
    if (url.pathname === '/test' && request.method === 'POST') {
      if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }
      try { return Response.json(await run(env, true)) }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }) }
    }
    return new Response('Not Found', { status: 404 })
  },
}
