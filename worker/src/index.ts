import { ExternalDataError, externalGet, readBoundedText, readJson } from './external'
import {
  beijingDate,
  fetchFundHoldings,
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
    current_weight?: number
    target_weight?: number
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
  status: 'fresh' | 'modeled' | 'delayed' | 'latest_official' | 'unavailable'
  source: string
  source_time: string | null
  source_time_precision: 'date' | 'datetime'
  estimate_change: number | null
  estimate_nav: number | null
  value_nav: number | null
  kind: 'estimate' | 'holdings_model' | 'official_nav' | 'unavailable'
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
  last_cron_at?: string
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

class DecisionError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'DecisionError'
  }
}

const WATCH_FILE = 'sinan-watchlist.json'
const STATE_FILE = 'sinan-estimate-state.json'
const SLOT = '14:30'
const MAX_MESSAGE_LENGTH = 8000
const MAX_STATE_ATTEMPTS = 1000
const VALID_STATE_SLOTS = new Set([SLOT])
const VALID_CRON_RESULTS = new Set(['sent', 'sent_with_warning', 'skipped', 'failed'])
const VALID_DECISION_STATUSES = new Set(['ok', 'disabled', 'degraded'])

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
        (slot): slot is string => typeof slot === 'string' && VALID_STATE_SLOTS.has(slot),
      ))]
    }
    if (typeof value.attempt_count === 'number'
      && Number.isInteger(value.attempt_count)
      && value.attempt_count >= 0
      && value.attempt_count <= MAX_STATE_ATTEMPTS) state.attempt_count = value.attempt_count
    if (typeof value.last_slot === 'string' && VALID_STATE_SLOTS.has(value.last_slot)) state.last_slot = value.last_slot
  }
  for (const field of ['last_cron_at', 'last_attempt_at', 'last_pushed_at', 'last_success_at'] as const) {
    const timestamp = stateTimestamp(value[field])
    if (timestamp) state[field] = timestamp
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

function beijingNow(now = new Date()): { date: string; iso: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
  const date = `${part('year')}-${part('month')}-${part('day')}`
  return { date, weekday: part('weekday'), iso: `${date}T${part('hour')}:${part('minute')}:${part('second')}+08:00` }
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
  const origin = request.headers.get('Origin') || 'none'
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
    last_cron_result: state.last_cron_result || null,
    last_cron_reason: state.last_cron_reason || null,
    last_attempt_at: state.last_attempt_at || null,
    last_result: state.last_error ? 'failed' : state.last_warning ? 'sent_with_warning' : state.last_pushed_at ? 'sent' : 'not_sent',
    last_error: state.last_error ? 'operation_failed' : null,
    last_success_at: state.last_success_at || state.last_pushed_at || null,
    last_warning: state.last_warning ? 'decision_degraded' : null,
    decision_status: state.decision_status || null,
    attempt_count: state.attempt_count || 0,
    sent_today: state.date === today && Boolean(state.sent_slots?.includes(SLOT)),
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
  const origin = request.headers.get('Origin') || 'none'
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

function estimateContext(estimate?: Estimate): DecisionEstimateContext {
  if (!estimate) {
    return {
      status: 'unavailable', source: 'unavailable', source_time: null, source_time_precision: 'date',
      estimate_change: null, estimate_nav: null, value_nav: null, kind: 'unavailable', is_fallback: true,
      fallback_reason: 'estimate_missing_for_decision',
      base_nav: null, base_nav_date: null, value_date: null,
      model_coverage: null, model_quote_count: null, model_report_date: null,
      model_oldest_quote_time: null, model_newest_quote_time: null, model_rejected_count: null,
      diagnostics: {
        primary_reason: 'estimate_missing_for_decision', source_time_precision: 'date',
      },
    }
  }
  return {
    status: estimate.status,
    source: estimate.source,
    source_time: estimate.sourceTime || null,
    source_time_precision: estimate.diagnostics.source_time_precision,
    estimate_change: estimate.change,
    estimate_nav: estimate.valueNav,
    value_nav: estimate.valueNav,
    kind: estimate.kind,
    is_fallback: estimate.isFallback,
    fallback_reason: estimate.isFallback ? estimate.diagnostics.primary_reason : null,
    base_nav: estimate.baseNav,
    base_nav_date: estimate.baseNavDate || null,
    value_date: estimate.valueDate || null,
    model_coverage: estimate.kind === 'holdings_model' ? estimate.coverage : null,
    model_quote_count: estimate.kind === 'holdings_model' ? estimate.quoteCount : null,
    model_report_date: estimate.kind === 'holdings_model' ? (estimate.reportDate || null) : null,
    model_oldest_quote_time: estimate.kind === 'holdings_model' ? (estimate.oldestQuoteTime || null) : null,
    model_newest_quote_time: estimate.kind === 'holdings_model' ? (estimate.newestQuoteTime || null) : null,
    model_rejected_count: estimate.kind === 'holdings_model' ? estimate.rejectedCount : null,
    diagnostics: { ...estimate.diagnostics },
  }
}

function safeDecisionEstimate(estimate: Estimate | undefined): Estimate | undefined {
  if (!estimate || estimate.kind !== 'estimate' || estimate.status !== 'delayed') return estimate
  if (estimate.baseNav == null || !estimate.baseNavDate) return undefined
  const reason = estimate.diagnostics.primary_reason || 'estimate_delayed'
  return {
    ...estimate,
    lastNav: estimate.baseNav,
    estNav: estimate.baseNav,
    change: 0,
    time: estimate.baseNavDate,
    navDate: estimate.baseNavDate,
    label: '最近正式净值',
    kind: 'official_nav',
    source: 'eastmoney_official_nav',
    status: 'latest_official',
    isFallback: true,
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
  const grouped = new Map<string, { shares: number; target?: number }>()
  for (const entry of entries) {
    const current = grouped.get(entry.code) || { shares: 0 }
    current.shares += numberOrNull(entry.shares) || 0
    if (entry.target_weight != null) current.target = numberOrNull(entry.target_weight) ?? undefined
    grouped.set(entry.code, current)
  }
  const values = new Map<string, number>()
  const missing: string[] = []
  for (const [code, row] of grouped) {
    const estimate = safeDecisionEstimate(estimates.get(code))
    const nav = numberOrNull(estimate?.estNav ?? estimate?.lastNav)
    if (row.shares > 0 && (nav == null || nav <= 0)) missing.push(code)
    values.set(code, row.shares > 0 && nav != null && nav > 0 ? row.shares * nav : 0)
  }
  if (missing.length) {
    return {
      items: [...grouped.keys()].map((code) => ({
        code, estimate_context: estimateContext(safeDecisionEstimate(estimates.get(code))),
      })),
      portfolioValue: 0,
      complete: false,
      missing,
    }
  }
  const portfolioValue = [...values.values()].reduce((sum, value) => sum + value, 0)
  const explicit = [...grouped.values()].reduce((sum, row) => sum + (row.shares > 0 ? row.target || 0 : 0), 0)
  const unset = [...grouped.values()].filter((row) => row.shares > 0 && row.target == null)
  const defaultTarget = unset.length ? Math.max(0, 100 - explicit) / unset.length : 0
  const items = [...grouped].map(([code, row]) => {
    const estimate_context = estimateContext(safeDecisionEstimate(estimates.get(code)))
    if (row.shares <= 0 || portfolioValue <= 0) return { code, estimate_context }
    return {
      code,
      current_weight: Number(((values.get(code) || 0) / portfolioValue * 100).toFixed(2)),
      target_weight: Number((row.target ?? defaultTarget).toFixed(2)),
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
    const response = await fetch(`${env.FUND_API_BASE.replace(/\/$/, '')}/api/portfolio/decisions`, {
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
    if (!response.ok) {
      return { result: null, status: 'degraded', warning: `组合决策暂不可用: HTTP ${response.status}` }
    }
    return { result: await response.json() as Record<string, unknown>, status: 'ok' }
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
    const action = decision ? ` → **${String(decision.action || '观察')}**` : ''
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
  reason?: string,
  error?: unknown,
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
    last_cron_result: result,
    last_cron_reason: result === 'skipped' ? reason : undefined,
  }
  if (result === 'failed') {
    current.last_error = persistedFailureReason(error)
    current.last_warning = ''
  } else {
    current.last_error = ''
    if (result !== 'sent_with_warning') current.last_warning = ''
  }
  await writeState(env, current)
}

export async function run(
  env: Env,
  force: boolean,
  clock = new Date(),
  valuationOptions: { requestBudget?: number } = {},
) {
  if (!env.GIST_ID || !env.GIST_TOKEN || !env.WECHAT_SENDKEY) throw new Error('Worker 密钥配置不完整')
  const now = beijingNow(clock)
  if (!force && (now.weekday === 'Sat' || now.weekday === 'Sun')) return { status: 'skipped', reason: 'weekend' }
  const files = await readGist(env)
  const entries = parseWatchEntries(JSON.parse(await fileContent(files[WATCH_FILE]) || '[]') as unknown)
  if (!entries.length) return { status: 'skipped', reason: 'empty_watchlist' }
  const state = parsePushState(await fileContent(files[STATE_FILE]))
  const current: PushState = state.date === now.date
    ? {
        date: now.date, sent_slots: state.sent_slots || [], last_slot: state.last_slot,
        last_attempt_at: state.last_attempt_at, last_pushed_at: state.last_pushed_at,
        last_success_at: state.last_success_at || state.last_pushed_at,
        attempt_count: state.attempt_count || 0, last_error: state.last_error,
        last_warning: state.last_warning, decision_status: state.decision_status,
        last_http_status: state.last_http_status ?? null,
      }
    : {
        date: now.date, sent_slots: [], attempt_count: 0, last_http_status: null,
        last_success_at: state.last_success_at || state.last_pushed_at,
      }
  if (!force && current.sent_slots.includes(SLOT)) return { status: 'skipped', reason: 'already_sent' }

  const unique = new Map<string, WatchEntry>()
  for (const entry of entries) if (!unique.has(entry.code)) unique.set(entry.code, entry)
  const valuation = await resolveValuations([...unique.keys()], clock, valuationOptions)
  const publishable = new Map([...valuation.estimates].filter(([, estimate]) => isPublishableIntraday(estimate, now.date, clock)))
  const realEstimateCount = [...publishable.values()].filter((estimate) => estimate.kind === 'estimate').length
  const modeledCount = [...publishable.values()].filter((estimate) => estimate.kind === 'holdings_model').length
  if (!force && !publishable.size) {
    const officialOnly = valuation.estimates.size > 0
      && [...valuation.estimates.values()].every((estimate) => estimate.kind === 'official_nav')
    return { status: 'skipped', reason: officialOnly ? 'official_nav_only' : 'no_publishable_intraday' }
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
  current.last_slot = SLOT
  current.last_attempt_at = now.iso
  current.attempt_count = incrementAttempts(current.attempt_count)
  current.last_error = ''
  current.last_warning = ''
  current.last_http_status = null
  let decision: DecisionOutcome
  try {
    // Portfolio decisions must fail closed when a held fund has no usable NAV;
    // do not silently compute weights from only the publishable subset.
    decision = await decisions(env, [...unique.values()], estimates, `${now.date}-${SLOT}`)
  } catch (error) {
    current.last_error = persistedFailureReason(error)
    current.last_http_status = error instanceof DecisionError ? error.status : null
    current.decision_status = 'degraded'
    if (!force) await writeState(env, current)
    throw error
  }
  const result = decision.result
  const title = result ? `司南基金 · 自选决策摘要（${SLOT}）` : `司南基金 · 自选涨跌幅（${SLOT}）`
  current.decision_status = decision.status
  current.last_warning = decision.warning || ''
  if (!force) await writeState(env, current)
  try {
    await sendWithOneRetry(env, title, formatMessage(activeEntries, estimates, result))
  } catch (error) {
    current.last_error = persistedFailureReason(error)
    current.last_http_status = error instanceof PushError ? error.status : null
    if (!force) await writeState(env, current)
    throw error
  }
  if (!force) {
    current.sent_slots = [...new Set([...current.sent_slots, SLOT])].sort()
    current.last_slot = SLOT
    current.last_pushed_at = now.iso
    current.last_success_at = now.iso
    current.last_error = ''
    current.last_warning = decision.warning || ''
    current.last_http_status = 200
    await writeState(env, current)
  }
  return {
    status: decision.warning ? 'sent_with_warning' : 'sent',
    funds: activeEntries.length,
    fresh: realEstimateCount > 0,
    modeled: modeledCount,
    stale: unique.size - publishable.size,
    decision_status: decision.status,
    warning: decision.warning || null,
    force,
  }
}

export async function runScheduled(env: Env, clock = new Date()) {
  const now = beijingNow(clock)
  try {
    const result = await run(env, false, clock, { requestBudget: 34 })
    const reason = 'reason' in result ? String(result.reason) : undefined
    await recordCronObservation(
      env,
      now,
      result.status as NonNullable<PushState['last_cron_result']>,
      reason,
    )
    return result
  } catch (error) {
    try {
      await recordCronObservation(env, now, 'failed', undefined, error)
    } catch (stateError) {
      console.error('failed to persist cron observation', stateError)
    }
    throw error
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env).then(console.log))
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS' && (url.pathname === '/estimates' || url.pathname === '/holdings' || url.pathname === '/health')) {
      return new Response(null, {
        status: 204,
        headers: url.pathname === '/health' ? healthHeaders(request) : publicHeaders(request),
      })
    }
    if (request.method === 'GET' && url.pathname === '/estimates') {
      return publicEstimates(request, url, ctx)
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
      const payload = { status: 'ok', service: 'sinan-estimate-push', version: '7.0.0', runtime, configured: {
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
