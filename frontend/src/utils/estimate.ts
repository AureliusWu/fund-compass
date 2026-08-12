// 天天基金当前估值表。旧 fundgz 单基金 JSONP 已下线；新表仅给更新日期，
// 不提供精确分钟，因此必须显示为延迟估值，不能伪装成实时行情。

import { recordSource } from './resilience'
import { getHoldings, type Holding } from './holdings'
import overseasRegistry from '@/data/overseas-models.json'
import { attachAccuracy } from './overseasAccuracy'

export interface Estimate {
  code: string
  name: string
  /** 估算的基准净值；lastNav 作为旧客户端兼容别名保留。 */
  baseNav: number | null
  baseNavDate: string
  /** 当前用于展示/市值计算的估算净值及归属日。 */
  valueNav: number | null
  valueDate: string
  lastNav: number | null
  estNav: number | null
  estChange: number | null // 估算涨跌% gszzl
  navDate: string
  estTime: string
  kind: 'intraday' | 'holdings_model' | 'overseas' | 'overseas_model' | 'official_nav'
  label: '盘中估值' | '延迟估值' | '重仓模型估算' | '海外估值' | '海外模型估算' | '最近净值' | '数据不可用'
  isRealtime: boolean
  sourceNote: string
  status?: string
  source?: string
  fallback?: string | null
  fallbackReason?: string | null
  fetchedAt?: string | null
  responseStatus?: string
  responseSource?: string
  responseFallback?: string | null
  responseFetchedAt?: string | null
  providerDiagnostics?: EstimateProviderDiagnostic[]
  modelWeight?: number
  modelCoverage?: number | null
  modelQuoteCount?: number | null
  modelReportDate?: string | null
  modelOldestQuoteTime?: string | null
  modelNewestQuoteTime?: string | null
  modelRejectedCount?: number | null
  modelCode?: string
  modelVersion?: string
  confidence?: string
  accuracySamples?: number
  errorBand?: number | null
  generatedAt?: string
  accuracyUpdatedAt?: string
  cached?: boolean
  cachedAt?: string
}

export interface EstimateProviderDiagnostic {
  provider: string
  status: string
  source?: string | null
  reason?: string | null
  fetchedAt?: string | null
}

export interface NavMove {
  date: string
  prevDate: string
  nav: number
  prevNav: number
  change: number
}

export interface DailyMove {
  change: number | null
  baseNav: number | null
  label: '估' | '净' | '重仓模型' | '延迟估值' | '海外非实时'
  sourceNote: string
  date?: string
}

export type EstimateDataFreshness = 'fresh' | 'stale' | 'expired'

const MAX_FUTURE_ESTIMATE_SKEW_MS = 5 * 60 * 1000
const PRECISE_ESTIMATE_FRESH_MS = 15 * 60 * 1000
const PRECISE_ESTIMATE_EXPIRE_MS = 90 * 60 * 1000

export interface Gz {
  fundcode?: string; name?: string
  dwjz?: unknown; gsz?: unknown; gszzl?: unknown; jzrq?: string; gztime?: string
  baseNav?: unknown; baseNavDate?: string; valueNav?: unknown; valueDate?: string
  sourcePrecision?: 'date' | 'datetime'
  estKind?: 'estimate' | 'holdings_model' | 'overseas_model' | 'official_nav'
  estLabel?: string
  estNote?: string
  estRealtime?: boolean
  status?: string
  source?: string
  fallback?: string | null
  fallbackReason?: string | null
  fetchedAt?: string | null
  responseStatus?: string
  responseSource?: string
  responseFallback?: string | null
  responseFetchedAt?: string | null
  providerDiagnostics?: EstimateProviderDiagnostic[]
  modelCoverage?: unknown
  modelQuoteCount?: unknown
  modelReportDate?: string | null
  modelOldestQuoteTime?: string | null
  modelNewestQuoteTime?: string | null
  modelRejectedCount?: unknown
}

const cache = new Map<string, { e: Estimate | null; t: number }>()
const TTL = 60_000
const TIMEOUT = 8000
const PERSISTENT_CACHE_KEY = 'sinan_estimates_v2'
const PERSISTENT_CACHE_MAX_AGE = 7 * 864e5
let tableCache: { rows: Map<string, Gz>; t: number } | null = null
const tableInflight = new Map<string, Promise<Map<string, Gz>>>()
const ESTIMATE_BATCH_SIZE = 25
const ESTIMATE_PROXY = (import.meta.env.VITE_ESTIMATE_PROXY as string)
  || 'https://sinan-estimate-push.ligugu69.workers.dev/estimates'

type EstimateCacheStorage = Pick<Storage, 'getItem' | 'setItem'>
interface PersistedEstimate { estimate: Estimate; cachedAt: number }

function browserStorage(): EstimateCacheStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage }
  catch { return null }
}

function readPersistentCache(storage: EstimateCacheStorage | null): Record<string, PersistedEstimate> {
  if (!storage) return {}
  try {
    const value = JSON.parse(storage.getItem(PERSISTENT_CACHE_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function loadCachedEstimates(
  codes: string[],
  storage: EstimateCacheStorage | null = browserStorage(),
): Map<string, Estimate> {
  const stored = readPersistentCache(storage)
  const now = Date.now()
  const out = new Map<string, Estimate>()
  for (const code of new Set(codes)) {
    const entry = stored[code]
    if (!entry || entry.estimate?.code !== code || !Number.isFinite(entry.cachedAt)) continue
    if (now - entry.cachedAt > PERSISTENT_CACHE_MAX_AGE) continue
    out.set(code, {
      ...entry.estimate,
      isRealtime: false,
      cached: true,
      cachedAt: new Date(entry.cachedAt).toISOString(),
      sourceNote: `${entry.estimate.sourceNote} · 本地缓存，正在后台更新`,
    })
  }
  return out
}

export function saveCachedEstimates(
  estimates: Iterable<Estimate | null>,
  storage: EstimateCacheStorage | null = browserStorage(),
) {
  if (!storage) return
  const now = Date.now()
  const stored = readPersistentCache(storage)
  for (const [code, entry] of Object.entries(stored)) {
    if (!entry || !Number.isFinite(entry.cachedAt) || now - entry.cachedAt > PERSISTENT_CACHE_MAX_AGE) delete stored[code]
  }
  for (const estimate of estimates) {
    if (!estimate?.code) continue
    const { cached: _cached, cachedAt: _cachedAt, ...fresh } = estimate
    stored[estimate.code] = { estimate: fresh as Estimate, cachedAt: now }
  }
  try { storage.setItem(PERSISTENT_CACHE_KEY, JSON.stringify(stored)) }
  catch { /* 缓存写入失败不影响实时刷新 */ }
}

interface ModelLeg { code: string; weight: number; note?: string }
interface ModelAdjustment { scale?: number; bias?: number }
export interface OverseasModel {
  label: string
  legs: ModelLeg[]
  minWeight?: number
  adjustment?: ModelAdjustment
  fallback?: OverseasModel
  version?: string
}

const HOLDINGS_MODEL_MIN_WEIGHT = 25

function registryModel(active: (typeof overseasRegistry.models)[keyof typeof overseasRegistry.models]['active']): OverseasModel {
  const convert = (model: typeof active | NonNullable<typeof active.fallback>): OverseasModel => ({
    label: model.label,
    minWeight: model.min_weight,
    adjustment: { scale: model.scale, bias: model.bias },
    legs: model.legs,
    ...('version' in model ? { version: model.version } : {}),
    ...('fallback' in model && model.fallback ? { fallback: convert(model.fallback) } : {}),
  })
  return convert(active)
}

const OVERSEAS_MODEL_BY_CODE: Record<string, OverseasModel> = Object.fromEntries(
  Object.entries(overseasRegistry.models).map(([code, entry]) => [code, registryModel(entry.active)]),
)

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nullableText(value: unknown): string | null {
  const text = cleanText(value)
  return text || null
}

function wholeNumberOrNull(value: unknown): number | null {
  const parsed = num(value)
  return parsed != null && parsed >= 0 && Number.isInteger(parsed) ? parsed : null
}

function normalizeProviderDiagnostics(value: unknown): EstimateProviderDiagnostic[] {
  const entries: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).map(([provider, item]) => (
          item && typeof item === 'object' ? { provider, ...(item as Record<string, unknown>) } : { provider, status: item }
        ))
      : []
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    const provider = cleanText(row.provider || row.name || row.id)
    const status = cleanText(row.status || row.result)
    if (!provider || !status) return []
    return [{
      provider,
      status,
      source: nullableText(row.source),
      reason: nullableText(row.reason || row.error || row.message),
      fetchedAt: nullableText(row.fetched_at || row.fetchedAt),
    }]
  })
}

function usableNav(n: number | null): n is number {
  return n != null && Number.isFinite(n) && n > 0
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2).replace(/\.?0+$/, '') : '--'
}

function isOverseasEstimate(name: string, estTime: string): boolean {
  const overseasFund = /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i.test(name)
  const hour = Number((estTime.match(/\s(\d{1,2}):\d{2}$/) || [])[1])
  return overseasFund && Number.isFinite(hour) && (hour < 9 || hour >= 15)
}

export function latestNavMove(
  navHistory: Array<{ date: string; nav: number | null | undefined }> | null | undefined,
): NavMove | null {
  const points = (navHistory || [])
    .filter((p): p is { date: string; nav: number } => !!p.date && usableNav(p.nav ?? null))
  if (points.length < 2) return null
  const prev = points[points.length - 2]
  const cur = points[points.length - 1]
  return {
    date: cur.date,
    prevDate: prev.date,
    nav: cur.nav,
    prevNav: prev.nav,
    change: (cur.nav - prev.nav) / prev.nav * 100,
  }
}

export function isOverseasLike(typeOrName: string | null | undefined, estimate?: Estimate | null): boolean {
  if (estimate?.kind === 'overseas' || estimate?.kind === 'overseas_model') return true
  return /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i
    .test(typeOrName || estimate?.name || '')
}

function parseEstimateTime(value: string | null | undefined): number | null {
  const text = String(value || '').trim()
  if (!text) return null
  const datePart = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1]
  if (!datePart) return null
  const dateCheck = Date.parse(`${datePart}T00:00:00+08:00`)
  if (!Number.isFinite(dateCheck) || beijingEstimateDate(dateCheck) !== datePart) return null
  let normalized = text.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += 'T00:00:00+08:00'
  else if (/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) normalized += '+08:00'
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function beijingEstimateDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function tradingDaysBetweenEstimateDates(start: string, end: string): number {
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

function dateLevelEstimateFreshness(value: string | null | undefined, now: number): EstimateDataFreshness {
  if (!Number.isFinite(now)) return 'expired'
  const timestamp = parseEstimateTime(value)
  if (timestamp == null || timestamp > now + MAX_FUTURE_ESTIMATE_SKEW_MS) return 'expired'
  const tradingDays = tradingDaysBetweenEstimateDates(
    beijingEstimateDate(timestamp), beijingEstimateDate(now),
  )
  if (tradingDays === 0) return 'fresh'
  if (tradingDays <= 2) return 'stale'
  return 'expired'
}

function preciseEstimateFreshness(value: string | null | undefined, now: number): EstimateDataFreshness {
  if (!Number.isFinite(now)) return 'expired'
  const timestamp = parseEstimateTime(value)
  if (timestamp == null || timestamp > now + MAX_FUTURE_ESTIMATE_SKEW_MS) return 'expired'
  const age = Math.max(0, now - timestamp)
  if (age <= PRECISE_ESTIMATE_FRESH_MS) return 'fresh'
  if (age <= PRECISE_ESTIMATE_EXPIRE_MS) return 'stale'
  return 'expired'
}

function combineEstimateFreshness(a: EstimateDataFreshness, b: EstimateDataFreshness): EstimateDataFreshness {
  if (a === 'expired' || b === 'expired') return 'expired'
  return a === 'stale' || b === 'stale' ? 'stale' : 'fresh'
}

/** One pure freshness contract shared by presentation and every daily-move consumer. */
export function estimateDataFreshness(
  estimate: Estimate | null | undefined,
  now = Date.now(),
): EstimateDataFreshness {
  if (!estimate || estimate.status === 'unavailable') return 'expired'
  if (estimate.kind === 'holdings_model') {
    const newest = estimate.modelNewestQuoteTime || estimate.estTime || estimate.valueDate
    const oldest = estimate.modelOldestQuoteTime || newest
    return combineEstimateFreshness(
      preciseEstimateFreshness(oldest, now),
      preciseEstimateFreshness(newest, now),
    )
  }
  if (estimate.kind === 'official_nav') {
    return dateLevelEstimateFreshness(estimate.valueDate || estimate.estTime || estimate.navDate, now)
  }
  if (estimate.kind === 'overseas_model') {
    return dateLevelEstimateFreshness(estimate.generatedAt || estimate.estTime || estimate.valueDate, now)
  }
  if (estimate.kind === 'overseas') {
    const freshness = dateLevelEstimateFreshness(estimate.estTime || estimate.valueDate || estimate.navDate, now)
    return freshness === 'fresh' ? 'stale' : freshness
  }
  const sourceTime = estimate.estTime || estimate.valueDate || estimate.navDate
  return /[ T]\d{1,2}:\d{2}/.test(sourceTime || '')
    ? preciseEstimateFreshness(sourceTime, now)
    : dateLevelEstimateFreshness(sourceTime, now)
}

export function preferredDailyMove(
  estimate: Estimate | null | undefined,
  navMove: NavMove | null | undefined,
  typeOrName?: string | null,
  now = Date.now(),
): DailyMove | null {
  if (navMove
    && isOverseasLike(typeOrName, estimate)
    && dateLevelEstimateFreshness(navMove.date, now) !== 'expired') {
    return {
      change: navMove.change,
      baseNav: navMove.prevNav,
      label: '净',
      sourceNote: `最新公布净值涨跌：${navMove.prevDate} → ${navMove.date}`,
      date: navMove.date,
    }
  }
  if (estimate?.kind === 'official_nav'
    && estimate.estChange != null
    && estimateDataFreshness(estimate, now) !== 'expired') {
    return {
      change: estimate.estChange,
      baseNav: estimate.lastNav,
      label: '净',
      sourceNote: estimate.sourceNote,
      date: estimate.estTime || estimate.navDate,
    }
  }
  if (!estimate
    || estimate.estChange == null
    || estimate.lastNav == null
    || estimateDataFreshness(estimate, now) === 'expired') return null
  return {
    change: estimate.estChange,
    baseNav: estimate.lastNav,
    label: estimate.kind === 'holdings_model'
      ? '重仓模型'
      : estimate.isRealtime ? '估' : (estimate.kind === 'overseas' ? '海外非实时' : '延迟估值'),
    sourceNote: estimate.sourceNote,
    date: estimate.estTime || estimate.navDate,
  }
}

export function normalizeEstimate(d: Gz): Estimate {
  const hasOwn = (key: keyof Gz) => Object.prototype.hasOwnProperty.call(d, key)
  const valueNavProvided = hasOwn('valueNav') || hasOwn('gsz')
  const changeProvided = hasOwn('gszzl')
  const baseNav = num(hasOwn('baseNav') ? d.baseNav : d.dwjz)
  let valueNav = num(hasOwn('valueNav') ? d.valueNav : d.gsz)
  let estChange = num(d.gszzl)

  if (!changeProvided && estChange == null && usableNav(baseNav) && usableNav(valueNav)) {
    estChange = (valueNav - baseNav) / baseNav * 100
  }
  if (!valueNavProvided && !usableNav(valueNav) && usableNav(baseNav) && estChange != null) {
    valueNav = baseNav * (1 + estChange / 100)
  }

  const code = cleanText(d.fundcode)
  const name = cleanText(d.name) || code
  const baseNavDate = cleanText(d.baseNavDate) || cleanText(d.jzrq)
  const valueDate = cleanText(d.valueDate) || cleanText(d.gztime)
  const modelNewestQuoteTime = nullableText(d.modelNewestQuoteTime)
  const estTime = cleanText(d.gztime) || modelNewestQuoteTime || valueDate
  const overseas = isOverseasEstimate(name, estTime)
  const dateOnly = d.sourcePrecision === 'date'
  const official = d.estKind === 'official_nav'
  const holdingsModel = d.estKind === 'holdings_model'
  const upstreamOverseasModel = d.estKind === 'overseas_model'
  const unavailable = d.status === 'unavailable'
  const isRealtime = holdingsModel || official || unavailable
    ? false
    : d.estRealtime === true || (d.estRealtime !== false && !overseas && !dateOnly)
  const kind: Estimate['kind'] = official
    ? 'official_nav'
    : holdingsModel
      ? 'holdings_model'
      : upstreamOverseasModel
        ? 'overseas_model'
        : overseas ? 'overseas' : 'intraday'
  const label: Estimate['label'] = unavailable
    ? '数据不可用'
    : official
      ? '最近净值'
      : holdingsModel
        ? '重仓模型估算'
        : upstreamOverseasModel
          ? '海外模型估算'
          : overseas ? '海外估值' : (dateOnly ? '延迟估值' : '盘中估值')
  const modelCoverage = num(d.modelCoverage)
  const modelQuoteCount = wholeNumberOrNull(d.modelQuoteCount)
  const modelRejectedCount = wholeNumberOrNull(d.modelRejectedCount)
  return {
    code,
    name,
    baseNav,
    baseNavDate,
    valueNav,
    valueDate,
    lastNav: baseNav,
    estNav: valueNav,
    estChange,
    navDate: baseNavDate,
    estTime,
    kind,
    label,
    isRealtime,
    status: d.status,
    source: d.source,
    fallback: d.fallback ?? null,
    fallbackReason: d.fallbackReason ?? null,
    fetchedAt: d.fetchedAt ?? null,
    responseStatus: d.responseStatus,
    responseSource: d.responseSource,
    responseFallback: d.responseFallback ?? null,
    responseFetchedAt: d.responseFetchedAt ?? null,
    providerDiagnostics: d.providerDiagnostics || [],
    modelWeight: modelCoverage ?? undefined,
    modelCoverage,
    modelQuoteCount,
    modelReportDate: nullableText(d.modelReportDate),
    modelOldestQuoteTime: nullableText(d.modelOldestQuoteTime),
    modelNewestQuoteTime,
    modelRejectedCount,
    sourceNote: cleanText(d.estNote) || (unavailable
      ? '盘中估值与安全降级均不可用'
      : official
      ? '盘中估值不可用；展示最近两个已公布正式净值的涨跌'
      : holdingsModel
      ? '按已披露重仓的当日行情贡献估算；不是基金公司官方实时净值'
      : overseas
      ? '天天基金当前仅返回海外基金收盘后/延迟估值，未提供实时盘中估值'
      : dateOnly ? '天天基金估值表仅提供更新日期，未提供精确分钟' : '天天基金盘中估值'),
  }
}

function collectModelCodes(model: OverseasModel | null | undefined, out: Set<string>) {
  if (!model) return
  model.legs.forEach((leg) => out.add(leg.code))
  if (model.fallback) collectModelCodes(model.fallback, out)
}

function quoteCodeForHolding(h: Pick<Holding, 'code' | 'name'>): string | null {
  const raw = String(h.code || '').trim().toUpperCase()
  const name = String(h.name || '')
  if (/^\d{6}$/.test(raw)) {
    if (/三星|SK海力士|海力士/i.test(name)) return 'usEWY'
    return (/^[69]/.test(raw) ? 'sh' : 'sz') + raw
  }
  if (/^\d{5}$/.test(raw)) return 'hk' + raw
  if (/^[A-Z.]{1,8}$/.test(raw)) return 'us' + raw.replace(/\./g, '-')
  return null
}

export function holdingsToOverseasModel(
  holdings: Array<Pick<Holding, 'code' | 'name' | 'ratio'>>,
): OverseasModel | null {
  const legs: ModelLeg[] = []
  for (const h of holdings) {
    const weight = Number(h.ratio)
    if (!Number.isFinite(weight) || weight <= 0) continue
    const code = quoteCodeForHolding(h)
    if (!code) continue
    legs.push({ code, weight })
  }
  if (!legs.length) return null
  return { label: '十大重仓穿透模型', minWeight: HOLDINGS_MODEL_MIN_WEIGHT, legs }
}

function parseTencentQuote(raw: string | undefined): { price: number; changePct: number } | null {
  if (!raw) return null
  const fields = raw.split('~')
  if (fields.length < 4) return null
  const price = Number(fields[3])
  if (!Number.isFinite(price) || price <= 0) return null
  let changePct = Number(fields[32])
  if (!Number.isFinite(changePct)) {
    const prevClose = Number(fields[4])
    if (Number.isFinite(prevClose) && prevClose > 0) changePct = (price - prevClose) / prevClose * 100
  }
  return { price, changePct: Number.isFinite(changePct) ? changePct : NaN }
}

function fetchTencentQuotes(codes: string[]): Promise<Record<string, { price: number; changePct: number }>> {
  const uniq = Array.from(new Set(codes.filter(Boolean)))
  if (!uniq.length || typeof document === 'undefined') return Promise.resolve({})

  return new Promise((resolve) => {
    const script = document.createElement('script')
    let done = false
    const timer = window.setTimeout(finish, TIMEOUT)

    function finish() {
      if (done) return
      done = true
      clearTimeout(timer)
      script.remove()
      const out: Record<string, { price: number; changePct: number }> = {}
      uniq.forEach((code) => {
        try {
          const varName = 'v_' + code.replace(/\./g, '_')
          const parsed = parseTencentQuote((window as unknown as Record<string, string | undefined>)[varName])
          delete (window as unknown as Record<string, string | undefined>)[varName]
          if (parsed && Number.isFinite(parsed.changePct)) out[code] = parsed
        } catch { /* ignore bad quote */ }
      })
      recordSource('tencent', '腾讯行情', Object.keys(out).length > 0)
      resolve(out)
    }

    script.onload = finish
    script.onerror = finish
    script.src = `https://qt.gtimg.cn/q=${uniq.join(',')}&_t=${Date.now()}`
    document.head.appendChild(script)
  })
}

function calcModelChange(model: OverseasModel, quotes: Record<string, { changePct: number }>) {
  let sum = 0
  let weight = 0
  for (const leg of model.legs) {
    const quote = quotes[leg.code]
    if (!quote || !Number.isFinite(quote.changePct)) continue
    sum += quote.changePct * leg.weight
    weight += leg.weight
  }
  const minWeight = Number.isFinite(model.minWeight) ? model.minWeight! : 0
  if (weight <= 0 || weight < minWeight) return { changePct: NaN, weight }
  const rawChange = sum / weight
  const scale = Number.isFinite(model.adjustment?.scale) ? model.adjustment!.scale! : 1
  const bias = Number.isFinite(model.adjustment?.bias) ? model.adjustment!.bias! : 0
  return { changePct: rawChange * scale + bias, weight }
}

export function applyOverseasModelEstimate(
  estimate: Estimate,
  quotes: Record<string, { changePct: number }>,
  modelOverride?: OverseasModel | null,
): Estimate {
  if (!estimate || estimate.isRealtime || estimate.kind !== 'overseas') return estimate
  let model = modelOverride || OVERSEAS_MODEL_BY_CODE[estimate.code]
  if (!model) return estimate

  let result = calcModelChange(model, quotes)
  if (!Number.isFinite(result.changePct) && model.fallback) {
    result = calcModelChange(model.fallback, quotes)
    if (Number.isFinite(result.changePct)) model = model.fallback
  }
  if (!Number.isFinite(result.changePct)) return estimate

  const estNav = usableNav(estimate.lastNav)
    ? estimate.lastNav * (1 + result.changePct / 100)
    : estimate.estNav
  const generatedAt = new Date().toISOString()
  return {
    ...estimate,
    valueNav: estNav,
    valueDate: generatedAt,
    estNav,
    estChange: result.changePct,
    kind: 'overseas_model',
    label: '海外模型估算',
    isRealtime: true,
    modelWeight: result.weight,
    modelCoverage: result.weight,
    modelCode: model.legs.map((leg) => `${leg.code}:${leg.weight}`).join(','),
    modelVersion: model.version,
    generatedAt,
    sourceNote: `${model.label} · 可用权重${fmt(result.weight)}% · 基于实时市场行情自建估算，不是基金官方实时净值`,
  }
}

async function enhanceOverseasEstimate(e: Estimate): Promise<Estimate> {
  if (e.isRealtime || e.kind !== 'overseas') return e
  const configuredModel = OVERSEAS_MODEL_BY_CODE[e.code]
  let holdingsModel: OverseasModel | null = null
  if (!configuredModel) {
    try {
      holdingsModel = holdingsToOverseasModel(await getHoldings(e.code))
    } catch { /* holdings model is best-effort */ }
  }
  const model = configuredModel || holdingsModel
  if (!model) return e
  const codes = new Set<string>()
  collectModelCodes(configuredModel, codes)
  collectModelCodes(holdingsModel, codes)
  const quotes = await fetchTencentQuotes(Array.from(codes))
  const configured = configuredModel ? applyOverseasModelEstimate(e, quotes, configuredModel) : e
  if (configured !== e || !holdingsModel) return attachAccuracy(configured)
  return attachAccuracy(applyOverseasModelEstimate(e, quotes, holdingsModel))
}

interface EstimateEnvelope {
  status: string
  source: string
  fallback: string | null
  fetchedAt: string | null
}

function ownValue(row: Record<string, unknown>, primary: string, legacy: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, primary) ? row[primary] : row[legacy]
}

function wireKind(value: unknown): Gz['estKind'] {
  return value === 'official_nav' || value === 'holdings_model' || value === 'overseas_model'
    ? value
    : 'estimate'
}

function wireRow(row: Record<string, unknown>, envelope: EstimateEnvelope): Gz | null {
  const code = cleanText(row.code || row.bzdm)
  if (!/^\d{6}$/.test(code)) return null
  const diagnostics = normalizeProviderDiagnostics(
    row.provider_diagnostics ?? row.providers ?? row.provider_diagnostic ?? row.diagnostics,
  )
  const precision = row.source_time_precision === 'datetime' ? 'datetime' : 'date'
  const estKind = wireKind(row.est_kind)
  const valueDate = cleanText(ownValue(row, 'value_date', 'est_time'))
  const newestQuote = nullableText(row.model_newest_quote_time ?? row.newest_quote_time)
  return {
    fundcode: code,
    name: cleanText(row.name) || code,
    baseNav: ownValue(row, 'base_nav', 'last_nav'),
    baseNavDate: cleanText(ownValue(row, 'base_nav_date', 'nav_date')),
    valueNav: ownValue(row, 'value_nav', 'est_nav'),
    valueDate,
    dwjz: row.last_nav,
    gsz: row.est_nav,
    gszzl: ownValue(row, 'value_change', 'est_change'),
    jzrq: cleanText(row.nav_date),
    gztime: cleanText(row.est_time) || newestQuote || valueDate,
    sourcePrecision: precision,
    estKind,
    estLabel: cleanText(row.est_label),
    estNote: cleanText(row.est_note),
    estRealtime: row.est_realtime === true,
    status: cleanText(row.status) || (estKind === 'holdings_model' ? 'modeled' : ''),
    source: cleanText(row.source) || envelope.source,
    fallback: nullableText(row.fallback) ?? envelope.fallback,
    fallbackReason: nullableText(row.fallback_reason),
    fetchedAt: nullableText(row.fetched_at) ?? envelope.fetchedAt,
    responseStatus: envelope.status,
    responseSource: envelope.source,
    responseFallback: envelope.fallback,
    responseFetchedAt: envelope.fetchedAt,
    providerDiagnostics: diagnostics,
    modelCoverage: row.model_coverage ?? row.model_weight ?? row.coverage,
    modelQuoteCount: row.model_quote_count ?? row.quote_count,
    modelReportDate: nullableText(row.model_report_date ?? row.report_date),
    modelOldestQuoteTime: nullableText(row.model_oldest_quote_time ?? row.oldest_quote_time),
    modelNewestQuoteTime: newestQuote,
    modelRejectedCount: row.model_rejected_count ?? row.rejected_count,
  }
}

function fetchEstimateBatch(codes: string[], force = false): Promise<Map<string, Gz>> {
  const ordered = [...codes].sort()
  if (!force && tableCache && Date.now() - tableCache.t < TTL && ordered.every((code) => tableCache?.rows.has(code))) {
    return Promise.resolve(new Map(ordered.map((code) => [code, tableCache!.rows.get(code)!])))
  }
  const inflightKey = `${force ? 'force' : 'normal'}:${ordered.join(',')}`
  const active = tableInflight.get(inflightKey)
  if (active) return active
  const request = (async () => {
    const controller = new AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), TIMEOUT)
    try {
      const query = new URLSearchParams({ codes: ordered.join(',') })
      if (force) query.set('_', String(Date.now()))
      const response = await fetch(`${ESTIMATE_PROXY}?${query}`, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(`估值代理 HTTP ${response.status}`)
      const payload = await response.json() as Record<string, unknown>
      if (!Array.isArray(payload.items)) throw new Error('估值代理响应无效')
      const envelope: EstimateEnvelope = {
        status: cleanText(payload.status),
        source: cleanText(payload.source),
        fallback: nullableText(payload.fallback),
        fetchedAt: nullableText(payload.fetched_at),
      }
      const rows = new Map<string, Gz>()
      const unavailable = Array.isArray(payload.unavailable_items) ? payload.unavailable_items : []
      for (const raw of [...payload.items, ...unavailable]) {
        if (!raw || typeof raw !== 'object') continue
        const normalized = wireRow(raw as Record<string, unknown>, envelope)
        if (normalized && ordered.includes(normalized.fundcode || '')) rows.set(normalized.fundcode!, normalized)
      }
      const merged = new Map(tableCache?.rows || [])
      rows.forEach((row, code) => merged.set(code, row))
      tableCache = { rows: merged, t: Date.now() }
      return rows
    } finally { globalThis.clearTimeout(timer) }
  })()
  tableInflight.set(inflightKey, request)
  void request.finally(() => tableInflight.delete(inflightKey)).catch(() => undefined)
  return request
}

function staleCachedEstimate(code: string, reason: string): Estimate | null {
  const previous = cache.get(code)?.e
  return previous
    ? { ...previous, isRealtime: false, cached: true, sourceNote: `${previous.sourceNote} · ${reason}` }
    : null
}

async function fetchEstimateSet(codes: string[], force = false): Promise<Map<string, Estimate | null>> {
  const unique = [...new Set(codes.map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code)))]
  const out = new Map<string, Estimate | null>(unique.map((code) => [code, null]))
  const chunks: string[][] = []
  for (let index = 0; index < unique.length; index += ESTIMATE_BATCH_SIZE) {
    chunks.push(unique.slice(index, index + ESTIMATE_BATCH_SIZE))
  }
  const settled = await Promise.allSettled(chunks.map((chunk) => fetchEstimateBatch(chunk, force)))
  let proxySucceeded = false
  await Promise.all(settled.map(async (result, index) => {
    const chunk = chunks[index]
    if (result.status === 'rejected') {
      chunk.forEach((code) => out.set(code, staleCachedEstimate(code, '代理请求失败，保留上次数据')))
      return
    }
    proxySucceeded = true
    await Promise.all(chunk.map(async (code) => {
      const raw = result.value.get(code)
      if (!raw) {
        out.set(code, staleCachedEstimate(code, '代理未返回该基金，保留上次数据'))
        return
      }
      const estimate = await enhanceOverseasEstimate(normalizeEstimate(raw))
      cache.set(code, { e: estimate, t: Date.now() })
      out.set(code, estimate)
    }))
  }))
  saveCachedEstimates([...out.values()].filter((estimate) => estimate?.status !== 'unavailable'))
  recordSource('tiantian', '司南估值代理', proxySucceeded && [...out.values()].some(Boolean))
  return out
}

// 抓单只估值；失败/超时返回 null。force 跳过缓存。
export async function fetchEstimate(code: string, force = false): Promise<Estimate | null> {
  const c = cache.get(code)
  if (!force && c && Date.now() - c.t < TTL) return Promise.resolve(c.e)
  if (!/^\d{6}$/.test(code)) return null
  return (await fetchEstimateSet([code], force)).get(code) ?? null
}

// 批量并发抓取，返回 code → Estimate|null 映射。
export async function fetchEstimates(codes: string[]): Promise<Map<string, Estimate | null>> {
  return fetchEstimateSet(codes)
}
