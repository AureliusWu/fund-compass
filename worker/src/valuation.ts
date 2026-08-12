import {
  createExternalRequestBudget,
  ExternalDataError,
  externalGet,
  readBoundedText,
  readJson,
  stableFailureReason,
  type ExternalRequestBudget,
} from './external'

export type ValuationKind = 'estimate' | 'holdings_model' | 'official_nav'
export type ValuationStatus = 'fresh' | 'delayed' | 'modeled' | 'latest_official'

export interface ValuationDiagnostics {
  primary_reason: string | null
  model_reason: string | null
  official_reason: string | null
  source_time_precision: 'date' | 'datetime'
  rejected: Record<string, number>
}

export interface Estimate {
  code: string
  name: string
  fundType: string
  // Legacy internal names retained for existing message/portfolio consumers.
  lastNav: number | null
  estNav: number | null
  change: number | null
  time: string
  navDate: string
  label: string
  kind: ValuationKind
  note: string
  // Strict v7 semantics.
  source: string
  status: ValuationStatus
  isFallback: boolean
  baseNav: number | null
  baseNavDate: string
  valueNav: number | null
  valueDate: string
  sourceTime: string
  coverage: number | null
  quoteCount: number | null
  reportDate: string
  oldestQuoteTime: string
  newestQuoteTime: string
  rejectedCount: number
  diagnostics: ValuationDiagnostics
}

export interface FundHolding {
  code: string
  name: string
  ratio: number
}

export interface FundHoldings {
  reportDate: string
  items: FundHolding[]
}

export interface HoldingQuote {
  code: string
  price: number
  change: number
  timestampMs: number
  sourceTime: string
}

export interface UnavailableValuation {
  code: string
  name: string
  baseNavDate: string
  valueDate: string
  sourceTime: string
  reason: string
  diagnostics: ValuationDiagnostics
}

export interface ValuationBatch {
  estimates: Map<string, Estimate>
  unavailable: Map<string, UnavailableValuation>
  primaryReason: string | null
}

const ESTIMATE_URL = 'https://api.fund.eastmoney.com/FundGuZhi/GetFundGZList'
const OFFICIAL_NAV_URL = 'https://api.fund.eastmoney.com/f10/lsjz'
const HOLDINGS_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx'
const PROFILE_URL = 'https://fund.eastmoney.com/pingzhongdata'
const QUOTES_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const MAX_NAV = 1_000_000
const MAX_ABS_CHANGE = 100
const MAX_PRICE = 10_000_000
const MAX_REPORT_AGE_MS = 185 * 24 * 60 * 60 * 1000
const MAX_OFFICIAL_BASE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const MAX_MODEL_QUOTE_AGE_MS = 90 * 60 * 1000
const CHANGE_ROUNDING_TOLERANCE = 0.05 + Number.EPSILON * 100
const MIN_HOLDINGS_QUOTES = 5
const MIN_HOLDINGS_COVERAGE = 50
const FALLBACK_CONCURRENCY = 5
// Public batches support the frontend's 25-code request without deliberately
// dropping official-NAV fallbacks. Only the first three candidates may spend
// the extra profile/holdings/quote budget; remaining candidates fetch official
// NAV only. Normal worst case: 1 + 25 + 3 * 3 = 35 GETs.
const MAX_FALLBACK_RESOLUTIONS = 25
const MAX_MODEL_ATTEMPTS = 3
const DEFAULT_REQUEST_BUDGET = 45

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function numberOrNull(value: unknown): number | null {
  if (value == null) return null
  const text = String(value).replace('%', '').replace(/,/g, '').trim()
  if (!text || text === '--' || text === '-') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveBounded(value: unknown, maximum = MAX_NAV): number | null {
  const parsed = numberOrNull(value)
  return parsed != null && parsed > 0 && parsed <= maximum ? parsed : null
}

function boundedChange(value: unknown): number | null {
  const parsed = numberOrNull(value)
  return parsed != null && Math.abs(parsed) <= MAX_ABS_CHANGE ? parsed : null
}

function cleanDate(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ''
  const timestamp = Date.parse(`${text}T00:00:00+08:00`)
  return Number.isFinite(timestamp) && beijingDate(new Date(timestamp)) === text ? text : ''
}

function dateFromSourceTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(value.trim())
  return match && cleanDate(match[1]) ? match[1] : ''
}

function sourceTimestampMs(value: string): number | null {
  const text = String(value || '').trim()
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  let parsed: number
  if (local) {
    if (!cleanDate(local[1])) return null
    const hour = Number(local[2])
    const minute = Number(local[3])
    const second = Number(local[4] || 0)
    if (hour > 23 || minute > 59 || second > 59) return null
    parsed = Date.parse(`${local[1]}T${local[2].padStart(2, '0')}:${local[3]}:${String(second).padStart(2, '0')}+08:00`)
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null
    parsed = Date.parse(text)
  }
  return Number.isFinite(parsed) ? parsed : null
}

function tradingDaysBetween(start: string, end: string): number {
  const cursor = new Date(`${start}T12:00:00Z`)
  const finish = new Date(`${end}T12:00:00Z`)
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(finish.getTime()) || cursor >= finish) return 0
  let tradingDays = 0
  while (cursor < finish && tradingDays <= 2) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) tradingDays++
  }
  return tradingDays
}

export function beijingDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function beijingTimestamp(timestampMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs))
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

function emptyDiagnostics(primaryReason: string | null = null): ValuationDiagnostics {
  return {
    primary_reason: primaryReason,
    model_reason: null,
    official_reason: null,
    source_time_precision: 'date',
    rejected: {},
  }
}

export function normalizeEstimate(raw: Record<string, unknown>, code: string): Estimate {
  const baseNav = positiveBounded(raw.dwjz ?? raw.last_nav)
  let valueNav = positiveBounded(raw.gsz ?? raw.est_nav)
  let change = boundedChange(raw.gszzl ?? raw.est_change)
  if (change == null && baseNav != null && valueNav != null) change = boundedChange((valueNav / baseNav - 1) * 100)
  if (valueNav == null && baseNav != null && change != null) valueNav = positiveBounded(baseNav * (1 + change / 100))
  const name = String(raw.name ?? raw.jjjc ?? code).trim() || code
  const fundType = String(raw.type ?? raw.FType ?? '').trim()
  const sourceTime = String(raw.gztime ?? raw.gxrq ?? raw.est_time ?? '').trim()
  const baseNavDate = cleanDate(raw.gzrq ?? raw.nav_date)
  const valueDate = dateFromSourceTime(sourceTime)
  const precision = /\d{1,2}:\d{2}/.test(sourceTime) ? 'datetime' : 'date'
  return {
    code,
    name,
    fundType,
    lastNav: baseNav,
    estNav: valueNav,
    change,
    time: sourceTime,
    navDate: baseNavDate,
    label: precision === 'datetime' ? '盘中估值' : '延迟估值',
    kind: 'estimate',
    note: precision === 'datetime'
      ? '东方财富盘中估算'
      : '东方财富盘中估算；上游未提供精确分钟',
    source: 'eastmoney_estimate_table',
    status: precision === 'datetime' ? 'fresh' : 'delayed',
    isFallback: false,
    baseNav,
    baseNavDate,
    valueNav,
    valueDate,
    sourceTime,
    coverage: null,
    quoteCount: null,
    reportDate: '',
    oldestQuoteTime: '',
    newestQuoteTime: '',
    rejectedCount: 0,
    diagnostics: {
      ...emptyDiagnostics(),
      source_time_precision: precision,
    },
  }
}

function valuationNumbersConsistent(baseNav: number | null, valueNav: number | null, change: number | null): boolean {
  if (baseNav == null || valueNav == null || change == null) return false
  const calculated = (valueNav / baseNav - 1) * 100
  return Number.isFinite(calculated) && Math.abs(calculated - change) <= CHANGE_ROUNDING_TOLERANCE
}

export function hasCompleteValues(estimate: Estimate): boolean {
  return estimate.baseNav != null
    && estimate.valueNav != null
    && estimate.change != null
    && positiveBounded(estimate.baseNav) != null
    && positiveBounded(estimate.valueNav) != null
    && boundedChange(estimate.change) != null
    && valuationNumbersConsistent(estimate.baseNav, estimate.valueNav, estimate.change)
    && cleanDate(estimate.baseNavDate) === estimate.baseNavDate
    && cleanDate(estimate.valueDate) === estimate.valueDate
}

function isCurrentPreciseEstimate(estimate: Estimate, now: Date): boolean {
  const nowMs = now.getTime()
  const sourceMs = sourceTimestampMs(estimate.sourceTime)
  return Number.isFinite(nowMs)
    && sourceMs != null
    && sourceMs <= nowMs + MAX_FUTURE_SKEW_MS
    && nowMs - sourceMs <= MAX_MODEL_QUOTE_AGE_MS
}

export function isFreshEstimate(estimate: Estimate, date: string, now?: Date): boolean {
  return estimate.kind === 'estimate'
    && estimate.status === 'fresh'
    && estimate.diagnostics.source_time_precision === 'datetime'
    && dateFromSourceTime(estimate.sourceTime) === date
    && hasCompleteValues(estimate)
    && (!now || isCurrentPreciseEstimate(estimate, now))
}

export function isPublishableIntraday(estimate: Estimate, date: string, now = new Date()): boolean {
  if (estimate.kind === 'estimate') {
    return isFreshEstimate(estimate, date, now)
  }
  if (estimate.kind !== 'holdings_model'
    || dateFromSourceTime(estimate.sourceTime) !== date
    || estimate.valueDate !== date
    || !hasCompleteValues(estimate)) return false
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) return false
  const times = [estimate.sourceTime, estimate.oldestQuoteTime, estimate.newestQuoteTime]
    .map(sourceTimestampMs)
  return times.every((timestamp) => timestamp != null
    && timestamp <= nowMs + MAX_FUTURE_SKEW_MS
    && nowMs - timestamp <= MAX_MODEL_QUOTE_AGE_MS)
}

export function parseEstimateTablePayload(payload: unknown, codes: string[]): Map<string, Estimate> {
  if (!isRecord(payload) || payload.ErrCode !== 0 || !isRecord(payload.Data) || !Array.isArray(payload.Data.list)) {
    throw new ExternalDataError('schema_invalid')
  }
  const wanted = new Set(codes)
  const estimates = new Map<string, Estimate>()
  for (const value of payload.Data.list) {
    if (!isRecord(value)) continue
    const code = String(value.bzdm ?? '').trim()
    if (!wanted.has(code)) continue
    const normalized = normalizeEstimate(value, code)
    const previous = estimates.get(code)
    if (!previous || normalized.sourceTime > previous.sourceTime) estimates.set(code, normalized)
  }
  return estimates
}

async function fetchEstimateTable(codes: string[], budget: ExternalRequestBudget): Promise<Map<string, Estimate>> {
  const query = new URLSearchParams({
    type: '0', sort: '1', orderType: 'asc', canbuy: '0', pageIndex: '1', pageSize: '30000',
  })
  const response = await externalGet(`${ESTIMATE_URL}?${query}`, {
    headers: { Referer: 'https://fund.eastmoney.com/fundguzhi.html' },
  }, { budget })
  return parseEstimateTablePayload(await readJson(response), codes)
}

interface OfficialNavRow {
  date: string
  nav: number
  change: number | null
}

export function parseOfficialNavPayload(payload: unknown, maximumDate = beijingDate()): OfficialNavRow[] {
  if (!isRecord(payload) || payload.ErrCode !== 0 || !isRecord(payload.Data) || !Array.isArray(payload.Data.LSJZList)) {
    throw new ExternalDataError('schema_invalid')
  }
  const byDate = new Map<string, OfficialNavRow>()
  for (const value of payload.Data.LSJZList) {
    if (!isRecord(value)) continue
    const date = cleanDate(value.FSRQ)
    const nav = positiveBounded(value.DWJZ)
    if (!date || date > maximumDate || nav == null) continue
    if (!byDate.has(date)) byDate.set(date, { date, nav, change: boundedChange(value.JZZZL) })
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date))
}

async function fetchOfficialNav(
  code: string,
  name: string,
  primaryReason: string,
  maximumDate: string,
  budget: ExternalRequestBudget,
): Promise<Estimate | null> {
  const query = new URLSearchParams({ fundCode: code, pageIndex: '1', pageSize: '10' })
  const response = await externalGet(`${OFFICIAL_NAV_URL}?${query}`, {
    headers: { Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` },
  }, { budget })
  const rows = parseOfficialNavPayload(await readJson(response), maximumDate)
  if (rows.length < 2) return null
  const latest = rows[0]
  const previous = rows[1]
  const change = latest.change ?? boundedChange((latest.nav / previous.nav - 1) * 100)
  if (change == null) return null
  return {
    code,
    name: name || code,
    fundType: '',
    lastNav: previous.nav,
    estNav: latest.nav,
    change,
    time: latest.date,
    navDate: previous.date,
    label: '最近净值',
    kind: 'official_nav',
    note: '盘中估值不可用；展示最近两个已公布正式净值的涨跌',
    source: 'eastmoney_official_nav',
    status: 'latest_official',
    isFallback: true,
    baseNav: previous.nav,
    baseNavDate: previous.date,
    valueNav: latest.nav,
    valueDate: latest.date,
    sourceTime: latest.date,
    coverage: null,
    quoteCount: null,
    reportDate: '',
    oldestQuoteTime: '',
    newestQuoteTime: '',
    rejectedCount: 0,
    diagnostics: emptyDiagnostics(primaryReason),
  }
}

function htmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim()
}

export function parseFundHoldings(payload: string): FundHoldings {
  if (!payload || !/\bapidata\s*=/.test(payload)) throw new ExternalDataError('schema_invalid')
  const marker = /截止至：\s*<font[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/font>/gi
  const markers = [...payload.matchAll(marker)]
  const sections: Array<{ reportDate: string; table: string }> = []
  for (let index = 0; index < markers.length; index += 1) {
    const match = markers[index]
    const reportDate = cleanDate(match[1])
    if (!reportDate || match.index == null) continue
    const afterMarker = match.index + match[0].length
    const nextMarker = markers[index + 1]?.index ?? payload.length
    const tableStart = payload.indexOf('<table', afterMarker)
    if (tableStart < 0 || tableStart >= nextMarker) continue
    const tableEnd = payload.indexOf('</table>', tableStart)
    if (tableEnd < 0 || tableEnd >= nextMarker) continue
    sections.push({ reportDate, table: payload.slice(tableStart, tableEnd + '</table>'.length) })
  }
  if (!sections.length) throw new ExternalDataError('schema_invalid')
  sections.sort((a, b) => b.reportDate.localeCompare(a.reportDate))
  const reportDate = sections[0].reportDate
  const latest = sections.filter((section) => section.reportDate === reportDate)
  if (latest.length !== 1) throw new ExternalDataError('schema_invalid')
  const table = latest[0].table
  const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => htmlText(match[1]))
  const headerRatioIndex = headers.findIndex((header) => header.includes('占净值') && header.includes('比例'))
  const items: FundHolding[] = []
  const seen = new Set<string>()
  const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || []
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1])
    if (cells.length < 7) continue
    const ratioIndex = headerRatioIndex >= 0 && headerRatioIndex < cells.length ? headerRatioIndex : 6
    const code = htmlText(cells[1]).trim().toUpperCase()
    const name = htmlText(cells[2])
    const ratio = numberOrNull(htmlText(cells[ratioIndex]))
    if (!code || seen.has(code) || !name || ratio == null || ratio <= 0 || ratio > 100) continue
    seen.add(code)
    items.push({ code, name, ratio })
    if (items.length >= 10) break
  }
  return { reportDate, items }
}

export async function fetchFundHoldings(code: string, budget = createExternalRequestBudget(DEFAULT_REQUEST_BUDGET)): Promise<FundHoldings> {
  const query = new URLSearchParams({ type: 'jjcc', code, topline: '10' })
  const response = await externalGet(`${HOLDINGS_URL}?${query}`, {
    headers: {
      Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html`,
      'User-Agent': 'sinan-cloudflare-worker',
    },
  }, { budget })
  return parseFundHoldings(await readBoundedText(response))
}

export function parseFundProfile(payload: string): { name: string } | null {
  const encoded = /\bvar\s+fS_name\s*=\s*("(?:\\.|[^"\\])*")\s*;/.exec(payload)?.[1]
  if (!encoded) return null
  try {
    const name = JSON.parse(encoded) as unknown
    return typeof name === 'string' && name.trim() ? { name: name.trim() } : null
  } catch {
    return null
  }
}

async function fetchFundProfile(code: string, budget: ExternalRequestBudget): Promise<{ name: string } | null> {
  const response = await externalGet(`${PROFILE_URL}/${code}.js?v=${Date.now()}`, {
    headers: { Referer: `https://fund.eastmoney.com/${code}.html` },
  }, { budget })
  return parseFundProfile(await readBoundedText(response))
}

export function isOverseasLike(name: string, fundType = ''): boolean {
  return /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港|美国|原油|商品|欧洲|亚洲/i.test(`${name} ${fundType}`)
}

function secidForHolding(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null
  return `${/^[69]/.test(code) ? '1' : '0'}.${code}`
}

export function parseHoldingQuotePayload(payload: unknown): Map<string, HoldingQuote> {
  if (!isRecord(payload) || !isRecord(payload.data)) throw new ExternalDataError('schema_invalid')
  const raw = payload.data.diff
  const rows = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : null
  if (!rows) throw new ExternalDataError('schema_invalid')
  const quotes = new Map<string, HoldingQuote>()
  for (const value of rows) {
    if (!isRecord(value)) continue
    const code = String(value.f12 ?? '').trim()
    const price = positiveBounded(value.f2, MAX_PRICE)
    const change = boundedChange(value.f3)
    const seconds = numberOrNull(value.f124)
    const timestampMs = seconds == null ? NaN : seconds * 1000
    if (!/^\d{6}$/.test(code) || price == null || change == null || !Number.isFinite(timestampMs) || timestampMs <= 0) continue
    quotes.set(code, { code, price, change, timestampMs, sourceTime: beijingTimestamp(timestampMs) })
  }
  return quotes
}

async function fetchHoldingQuotes(holdings: FundHolding[], budget: ExternalRequestBudget): Promise<Map<string, HoldingQuote>> {
  const secids = holdings.map((item) => secidForHolding(item.code)).filter((value): value is string => Boolean(value))
  if (!secids.length) return new Map()
  const query = new URLSearchParams({
    fltt: '2', fields: 'f2,f12,f3,f124', secids: secids.join(','), _: String(Date.now()),
  })
  const response = await externalGet(`${QUOTES_URL}?${query}`, {
    headers: { Referer: 'https://quote.eastmoney.com/' },
  }, { budget })
  return parseHoldingQuotePayload(await readJson(response))
}

interface ModelAttempt {
  estimate: Estimate | null
  reason: string
  rejected: Record<string, number>
}

function reject(rejected: Record<string, number>, reason: string): void {
  rejected[reason] = (rejected[reason] || 0) + 1
}

export function calculateHoldingsModel(
  official: Estimate,
  holdings: FundHoldings,
  quotes: Map<string, HoldingQuote>,
  now = new Date(),
  name = official.name,
  primaryReason = 'estimate_missing',
): ModelAttempt {
  const rejected: Record<string, number> = {}
  const nowMs = now.getTime()
  const today = beijingDate(now)
  const reportMs = holdings.reportDate ? Date.parse(`${holdings.reportDate}T23:59:59+08:00`) : NaN
  if (!Number.isFinite(reportMs) || holdings.reportDate > today || nowMs - reportMs > MAX_REPORT_AGE_MS) {
    return { estimate: null, reason: 'holdings_report_expired', rejected }
  }
  const officialBaseDate = cleanDate(official.valueDate)
  const todayMs = Date.parse(`${today}T00:00:00+08:00`)
  const officialBaseMs = officialBaseDate
    ? Date.parse(`${officialBaseDate}T00:00:00+08:00`)
    : NaN
  if (!Number.isFinite(officialBaseMs) || officialBaseDate > today || todayMs - officialBaseMs > MAX_OFFICIAL_BASE_AGE_MS) {
    return { estimate: null, reason: 'official_base_expired', rejected }
  }
  if (officialBaseDate === today) {
    return { estimate: null, reason: 'official_base_not_prior', rejected }
  }
  if (tradingDaysBetween(officialBaseDate, today) !== 1) {
    return { estimate: null, reason: 'official_base_not_previous_trading_day', rejected }
  }
  const usable: Array<{ ratio: number; change: number; quote: HoldingQuote }> = []
  const seenHoldingCodes = new Set<string>()
  for (const holding of holdings.items) {
    const holdingCode = String(holding.code || '').trim().toUpperCase()
    if (seenHoldingCodes.has(holdingCode)) { reject(rejected, 'duplicate_security'); continue }
    seenHoldingCodes.add(holdingCode)
    if (!secidForHolding(holdingCode)) { reject(rejected, 'unsupported_security'); continue }
    if (!Number.isFinite(holding.ratio) || holding.ratio <= 0 || holding.ratio > 100) {
      reject(rejected, 'holding_ratio_invalid')
      continue
    }
    const quote = quotes.get(holdingCode)
    if (!quote) { reject(rejected, 'quote_missing'); continue }
    if (quote.timestampMs > nowMs + MAX_FUTURE_SKEW_MS) { reject(rejected, 'quote_future'); continue }
    if (beijingDate(new Date(quote.timestampMs)) !== today) { reject(rejected, 'quote_stale'); continue }
    if (positiveBounded(quote.price, MAX_PRICE) == null || boundedChange(quote.change) == null) {
      reject(rejected, 'quote_out_of_range')
      continue
    }
    usable.push({ ratio: holding.ratio, change: quote.change, quote })
  }
  if (usable.some((item) => nowMs - item.quote.timestampMs > MAX_MODEL_QUOTE_AGE_MS)) {
    for (const item of usable) {
      if (nowMs - item.quote.timestampMs > MAX_MODEL_QUOTE_AGE_MS) reject(rejected, 'quote_stale')
    }
    return { estimate: null, reason: 'quote_window_stale', rejected }
  }
  const coverage = usable.reduce((sum, item) => sum + item.ratio, 0)
  if (usable.length < MIN_HOLDINGS_QUOTES) {
    return { estimate: null, reason: 'holdings_quote_count_low', rejected }
  }
  if (coverage < MIN_HOLDINGS_COVERAGE) {
    return { estimate: null, reason: 'holdings_coverage_low', rejected }
  }
  if (coverage > 100) {
    return { estimate: null, reason: 'holdings_coverage_invalid', rejected }
  }
  const baseNav = positiveBounded(official.valueNav)
  if (baseNav == null) return { estimate: null, reason: 'official_base_unavailable', rejected }
  const change = usable.reduce((sum, item) => sum + item.ratio * item.change / 100, 0)
  const valueNav = positiveBounded(baseNav * (1 + change / 100))
  if (boundedChange(change) == null || valueNav == null) {
    return { estimate: null, reason: 'model_value_out_of_range', rejected }
  }
  const sourceTimes = usable.map((item) => item.quote.sourceTime).sort()
  const oldestQuoteTime = sourceTimes[0]
  const newestQuoteTime = sourceTimes[sourceTimes.length - 1]
  const rejectedCount = Object.values(rejected).reduce((sum, value) => sum + value, 0)
  const diagnostics: ValuationDiagnostics = {
    primary_reason: primaryReason,
    model_reason: null,
    official_reason: null,
    source_time_precision: 'datetime',
    rejected,
  }
  return {
    reason: 'holdings_model_available',
    rejected,
    estimate: {
      code: official.code,
      name: name || official.name || official.code,
      fundType: official.fundType,
      lastNav: baseNav,
      estNav: valueNav,
      change,
      time: newestQuoteTime,
      navDate: officialBaseDate,
      label: '重仓估算',
      kind: 'holdings_model',
      note: `按已披露十大重仓（截至${holdings.reportDate}）的当日行情估算；覆盖净值${coverage.toFixed(1)}%，未披露部分按0贡献处理，不是基金公司官方估值`,
      source: 'eastmoney_holdings_model',
      status: 'modeled',
      isFallback: true,
      baseNav,
      baseNavDate: officialBaseDate,
      valueNav,
      valueDate: today,
      sourceTime: newestQuoteTime,
      coverage,
      quoteCount: usable.length,
      reportDate: holdings.reportDate,
      oldestQuoteTime,
      newestQuoteTime,
      rejectedCount,
      diagnostics,
    },
  }
}

function primaryFallbackReason(
  estimate: Estimate | undefined,
  today: string,
  tableReason: string | null,
  now: Date,
): string {
  if (!estimate) return tableReason || 'estimate_missing'
  if (dateFromSourceTime(estimate.sourceTime) !== today) return 'estimate_stale'
  if (estimate.status === 'delayed') return 'estimate_delayed'
  if (estimate.diagnostics.source_time_precision === 'datetime' && !isCurrentPreciseEstimate(estimate, now)) {
    return 'estimate_stale'
  }
  return 'estimate_incomplete'
}

function delayedPrimaryFallback(
  primary: Estimate | undefined,
  today: string,
  diagnostics: ValuationDiagnostics,
  now: Date,
): Estimate | null {
  const datePrecisionDelayed = primary?.status === 'delayed'
    && primary.diagnostics.source_time_precision === 'date'
  const expiredPrecise = primary?.status === 'fresh'
    && primary.diagnostics.source_time_precision === 'datetime'
    && !isCurrentPreciseEstimate(primary, now)
  if (!primary
    || primary.kind !== 'estimate'
    || (!datePrecisionDelayed && !expiredPrecise)
    || dateFromSourceTime(primary.sourceTime) !== today
    || !hasCompleteValues(primary)) return null
  return {
    ...primary,
    status: 'delayed',
    label: '延迟估值',
    diagnostics: {
      ...diagnostics,
      source_time_precision: primary.diagnostics.source_time_precision,
    },
    note: `${primary.note}；数据已超出安全实时窗口；重仓模型未采用（${diagnostics.model_reason || 'model_unavailable'}）`,
  }
}

async function settledValue<T>(promise: Promise<T>): Promise<{ value: T | null; reason: string | null }> {
  try {
    return { value: await promise, reason: null }
  } catch (error) {
    return { value: null, reason: stableFailureReason(error) }
  }
}

async function resolveFallback(
  code: string,
  primary: Estimate | undefined,
  tableReason: string | null,
  now: Date,
  allowModel: boolean,
  budget: ExternalRequestBudget,
): Promise<{ estimate: Estimate | null; unavailable: UnavailableValuation | null }> {
  const today = beijingDate(now)
  const primaryReason = primaryFallbackReason(primary, today, tableReason, now)
  const knownName = primary?.name && primary.name !== code ? primary.name : ''
  if (!allowModel) {
    const officialResult = await settledValue(fetchOfficialNav(code, knownName || code, primaryReason, today, budget))
    const diagnostics = emptyDiagnostics(primaryReason)
    diagnostics.model_reason = 'model_budget_exhausted'
    diagnostics.official_reason = officialResult.value ? null : (officialResult.reason || 'official_unavailable')
    const delayed = delayedPrimaryFallback(primary, today, diagnostics, now)
    if (delayed) return { estimate: delayed, unavailable: null }
    if (officialResult.value) {
      officialResult.value.diagnostics = diagnostics
      officialResult.value.note = `${officialResult.value.note}；重仓模型未尝试（model_budget_exhausted）`
      return { estimate: officialResult.value, unavailable: null }
    }
    return {
      estimate: null,
      unavailable: {
        code,
        name: knownName || code,
        baseNavDate: primary?.baseNavDate || '',
        valueDate: primary?.valueDate || '',
        sourceTime: primary?.sourceTime || '',
        reason: diagnostics.official_reason || 'official_unavailable',
        diagnostics,
      },
    }
  }
  if (knownName && isOverseasLike(knownName, primary?.fundType)) {
    const officialResult = await settledValue(fetchOfficialNav(code, knownName, primaryReason, today, budget))
    const diagnostics = emptyDiagnostics(primaryReason)
    diagnostics.model_reason = 'overseas_model_forbidden'
    diagnostics.official_reason = officialResult.value ? null : (officialResult.reason || 'official_unavailable')
    const delayed = delayedPrimaryFallback(primary, today, diagnostics, now)
    if (delayed) return { estimate: delayed, unavailable: null }
    if (officialResult.value) {
      officialResult.value.diagnostics = diagnostics
      officialResult.value.note = `${officialResult.value.note}；海外/QDII不套用通用重仓模型`
      return { estimate: officialResult.value, unavailable: null }
    }
    return {
      estimate: null,
      unavailable: {
        code, name: knownName, baseNavDate: primary?.baseNavDate || '', valueDate: primary?.valueDate || '',
        sourceTime: primary?.sourceTime || '', reason: diagnostics.official_reason || 'official_unavailable', diagnostics,
      },
    }
  }
  const [profileResult, officialResult] = await Promise.all([
    knownName ? Promise.resolve({ value: { name: knownName }, reason: null }) : settledValue(fetchFundProfile(code, budget)),
    settledValue(fetchOfficialNav(code, knownName || code, primaryReason, today, budget)),
  ])
  const profile = profileResult.value
  const name = knownName || profile?.name || code
  const official = officialResult.value
  if (official) official.name = name
  const diagnostics = emptyDiagnostics(primaryReason)
  diagnostics.official_reason = official ? null : (officialResult.reason || 'official_unavailable')

  let modelReason = 'model_not_attempted'
  let rejected: Record<string, number> = {}
  const classificationKnown = Boolean(knownName || profile?.name)
  if (!official) modelReason = 'official_base_unavailable'
  else if (!classificationKnown) modelReason = profileResult.reason || 'fund_classification_unknown'
  else if (isOverseasLike(name, primary?.fundType)) modelReason = 'overseas_model_forbidden'
  else {
    const holdingsResult = await settledValue(fetchFundHoldings(code, budget))
    const holdings = holdingsResult.value
    const containsUnsupportedSecurity = Boolean(holdings?.items.some((item) => !secidForHolding(item.code)))
    if (!holdings) modelReason = holdingsResult.reason || 'holdings_unavailable'
    else if (containsUnsupportedSecurity) modelReason = 'non_mainland_holdings_forbidden'
    else {
      const quoteResult = await settledValue(fetchHoldingQuotes(holdings.items, budget))
      if (!quoteResult.value) modelReason = quoteResult.reason || 'quotes_unavailable'
      else {
        const attempt = calculateHoldingsModel(official, holdings, quoteResult.value, now, name, primaryReason)
        modelReason = attempt.reason
        rejected = attempt.rejected
        if (attempt.estimate) return { estimate: attempt.estimate, unavailable: null }
      }
    }
  }

  diagnostics.model_reason = modelReason
  diagnostics.rejected = rejected
  const delayed = delayedPrimaryFallback(primary, today, diagnostics, now)
  if (delayed) return { estimate: delayed, unavailable: null }
  if (official) {
    official.diagnostics = diagnostics
    official.note = `${official.note}；重仓模型未采用（${modelReason}）`
    return { estimate: official, unavailable: null }
  }
  return {
    estimate: null,
    unavailable: {
      code,
      name,
      baseNavDate: primary?.baseNavDate || '',
      valueDate: primary?.valueDate || '',
      sourceTime: primary?.sourceTime || '',
      reason: diagnostics.official_reason || modelReason || primaryReason,
      diagnostics,
    },
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = []
  for (let index = 0; index < items.length; index += limit) {
    output.push(...await Promise.all(items.slice(index, index + limit).map(mapper)))
  }
  return output
}

export async function resolveValuations(
  codes: string[],
  now = new Date(),
  options: { requestBudget?: number } = {},
): Promise<ValuationBatch> {
  const uniqueCodes = [...new Set(codes.filter((code) => /^\d{6}$/.test(code)))]
  const budget = createExternalRequestBudget(options.requestBudget ?? DEFAULT_REQUEST_BUDGET)
  const today = beijingDate(now)
  let primary = new Map<string, Estimate>()
  let tableReason: string | null = null
  try {
    primary = await fetchEstimateTable(uniqueCodes, budget)
  } catch (error) {
    tableReason = stableFailureReason(error)
  }
  const estimates = new Map<string, Estimate>()
  const unavailable = new Map<string, UnavailableValuation>()
  const fallbackCodes: string[] = []
  for (const code of uniqueCodes) {
    const estimate = primary.get(code)
    if (estimate && isFreshEstimate(estimate, today, now)) estimates.set(code, estimate)
    else fallbackCodes.push(code)
  }
  const budgetedFallbackCodes = fallbackCodes.slice(0, MAX_FALLBACK_RESOLUTIONS)
  const modelCodes = new Set(budgetedFallbackCodes.slice(0, MAX_MODEL_ATTEMPTS))
  const fallback = await mapWithConcurrency(budgetedFallbackCodes, FALLBACK_CONCURRENCY, async (code) => ({
    code,
    result: await resolveFallback(code, primary.get(code), tableReason, now, modelCodes.has(code), budget),
  }))
  for (const { code, result } of fallback) {
    if (result.estimate) estimates.set(code, result.estimate)
    else if (result.unavailable) unavailable.set(code, result.unavailable)
  }
  for (const code of fallbackCodes.slice(MAX_FALLBACK_RESOLUTIONS)) {
    const item = primary.get(code)
    const diagnostics = emptyDiagnostics(primaryFallbackReason(item, today, tableReason, now))
    diagnostics.model_reason = 'fallback_budget_exhausted'
    diagnostics.official_reason = 'fallback_budget_exhausted'
    unavailable.set(code, {
      code,
      name: item?.name || code,
      baseNavDate: item?.baseNavDate || '',
      valueDate: item?.valueDate || '',
      sourceTime: item?.sourceTime || '',
      reason: 'fallback_budget_exhausted',
      diagnostics,
    })
  }
  return { estimates, unavailable, primaryReason: tableReason }
}

export function publicValuationItem(item: Estimate): Record<string, unknown> {
  if (!hasCompleteValues(item)) throw new ExternalDataError('schema_invalid')
  return {
    code: item.code,
    name: item.name,
    kind: item.kind,
    source: item.source,
    status: item.status,
    is_fallback: item.isFallback,
    base_nav: item.baseNav,
    base_nav_date: item.baseNavDate,
    value_nav: item.valueNav,
    value_date: item.valueDate,
    source_time: item.sourceTime,
    estimate_change: item.change,
    coverage: item.coverage,
    quote_count: item.quoteCount,
    report_date: item.reportDate || null,
    oldest_quote_time: item.oldestQuoteTime || null,
    newest_quote_time: item.newestQuoteTime || null,
    rejected_count: item.rejectedCount,
    model_coverage: item.coverage,
    model_quote_count: item.quoteCount,
    model_report_date: item.reportDate || null,
    model_oldest_quote_time: item.oldestQuoteTime || null,
    model_newest_quote_time: item.newestQuoteTime || null,
    model_rejected_count: item.rejectedCount,
    note: item.note,
    diagnostics: item.diagnostics,
    // FundVal and other v6 consumers.
    last_nav: item.lastNav,
    est_nav: item.estNav,
    est_change: item.change,
    nav_date: item.navDate,
    // FundVal v13 treats every unknown non-official kind as a direct estimate
    // and derives its badge from this legacy field.  Keep the canonical
    // source_time/model_* timestamps precise, but make the v6 alias date-only
    // for holdings models so old clients cannot relabel a non-official model
    // as realtime.
    est_time: item.kind === 'holdings_model' ? item.valueDate : item.time,
    source_time_precision: item.diagnostics.source_time_precision,
    est_label: item.label,
    est_kind: item.kind,
    est_realtime: item.kind === 'estimate'
      && item.status === 'fresh'
      && item.diagnostics.source_time_precision === 'datetime',
    est_note: item.note,
    fallback_reason: item.isFallback ? item.diagnostics.primary_reason : null,
  }
}

export function publicUnavailableItem(item: UnavailableValuation): Record<string, unknown> {
  return {
    code: item.code,
    name: item.name,
    kind: 'unavailable',
    source: 'unavailable',
    status: 'unavailable',
    is_fallback: true,
    base_nav: null,
    base_nav_date: item.baseNavDate,
    value_nav: null,
    value_date: item.valueDate,
    source_time: item.sourceTime,
    estimate_change: null,
    coverage: null,
    quote_count: null,
    report_date: null,
    oldest_quote_time: null,
    newest_quote_time: null,
    rejected_count: 0,
    model_coverage: null,
    model_quote_count: null,
    model_report_date: null,
    model_oldest_quote_time: null,
    model_newest_quote_time: null,
    model_rejected_count: 0,
    note: '盘中估值、重仓模型和最近正式净值均不可用',
    diagnostics: item.diagnostics,
    last_nav: null,
    est_nav: null,
    est_change: null,
    nav_date: item.baseNavDate,
    est_time: item.sourceTime,
    source_time_precision: item.diagnostics.source_time_precision,
    est_label: '数据不可用',
    est_kind: 'estimate',
    est_realtime: false,
    est_note: '盘中估值、重仓模型和最近正式净值均不可用',
    fallback_reason: item.diagnostics.primary_reason,
    unavailable_reason: item.reason,
  }
}
