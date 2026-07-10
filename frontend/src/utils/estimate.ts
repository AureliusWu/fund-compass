// 盘中估值（天天基金 JSONP）。移植自蜉蝣基金（FundVal）的实现思路，
// 司南前端用同一全局回调 window.jsonpgz —— 纯前端、不依赖后端，盘中实时。
// 接口：https://fundgz.1234567.com.cn/js/{code}.js → jsonpgz({...})
// 字段：dwjz=昨日单位净值, gsz=盘中估算净值, gszzl=估算涨跌%, jzrq=净值日期, gztime=估值时间。
// 注意：gszzl 是百分比可为负/为 0，统一用 Number.isFinite 判断；QDII/全球基金常返回海外收盘后的估值时间。

import { recordSource } from './resilience'
import { getHoldings, type Holding } from './holdings'
import overseasRegistry from '@/data/overseas-models.json'
import { attachAccuracy } from './overseasAccuracy'

export interface Estimate {
  code: string
  name: string
  lastNav: number | null // 昨日单位净值 dwjz
  estNav: number | null // 盘中估算净值 gsz
  estChange: number | null // 估算涨跌% gszzl
  navDate: string // 上一净值日期 jzrq
  estTime: string // 估值时间 gztime
  kind: 'intraday' | 'overseas' | 'overseas_model'
  label: '盘中估值' | '海外估值' | '海外模型估算'
  isRealtime: boolean
  sourceNote: string
  modelWeight?: number
  modelCode?: string
  modelVersion?: string
  confidence?: string
  accuracySamples?: number
  errorBand?: number | null
  generatedAt?: string
  accuracyUpdatedAt?: string
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
  label: '估' | '净' | '海外非实时'
  sourceNote: string
  date?: string
}

export interface Gz {
  fundcode?: string; name?: string
  dwjz?: string; gsz?: string; gszzl?: string; jzrq?: string; gztime?: string
}

interface Pending { resolve: (e: Estimate | null) => void; timer: number; gen: number }

declare global {
  interface Window { jsonpgz?: (d: Gz) => void }
}

const pending = new Map<string, Pending>()
const codeGen: Record<string, number> = {}
const cache = new Map<string, { e: Estimate | null; t: number }>()
const TTL = 60_000 // 盘中估值 1 分钟内复用，避免频繁注入
const TIMEOUT = 8000

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

function num(s: unknown): number | null {
  const n = typeof s === 'number' ? s : parseFloat(String(s))
  return Number.isFinite(n) ? n : null
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

export function preferredDailyMove(
  estimate: Estimate | null | undefined,
  navMove: NavMove | null | undefined,
  typeOrName?: string | null,
): DailyMove | null {
  if (navMove && isOverseasLike(typeOrName, estimate)) {
    return {
      change: navMove.change,
      baseNav: navMove.prevNav,
      label: '净',
      sourceNote: `最新公布净值涨跌：${navMove.prevDate} → ${navMove.date}`,
      date: navMove.date,
    }
  }
  if (!estimate || estimate.estChange == null || estimate.lastNav == null) return null
  return {
    change: estimate.estChange,
    baseNav: estimate.lastNav,
    label: estimate.isRealtime ? '估' : '海外非实时',
    sourceNote: estimate.sourceNote,
    date: estimate.estTime || estimate.navDate,
  }
}

export function normalizeEstimate(d: Gz): Estimate {
  const lastNav = num(d.dwjz)
  let estNav = num(d.gsz)
  let estChange = num(d.gszzl)

  if (estChange == null && usableNav(lastNav) && usableNav(estNav)) {
    estChange = (estNav - lastNav) / lastNav * 100
  }
  if (!usableNav(estNav) && usableNav(lastNav) && estChange != null) {
    estNav = lastNav * (1 + estChange / 100)
  }

  const name = d.name || d.fundcode || ''
  const estTime = d.gztime || ''
  const overseas = isOverseasEstimate(name, estTime)
  const isRealtime = !overseas
  return {
    code: d.fundcode || '',
    name,
    lastNav,
    estNav,
    estChange,
    navDate: d.jzrq || '',
    estTime,
    kind: overseas ? 'overseas' : 'intraday',
    label: overseas ? '海外估值' : '盘中估值',
    isRealtime,
    sourceNote: overseas
      ? '天天基金当前仅返回海外基金收盘后/延迟估值，未提供实时盘中估值'
      : '天天基金盘中估值',
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
  return {
    ...estimate,
    estNav,
    estChange: result.changePct,
    kind: 'overseas_model',
    label: '海外模型估算',
    isRealtime: true,
    modelWeight: result.weight,
    modelCode: model.legs.map((leg) => `${leg.code}:${leg.weight}`).join(','),
    modelVersion: model.version,
    generatedAt: new Date().toISOString(),
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

// 全局 JSONP 回调（接口里写死的函数名，按 fundcode 调度到对应 Promise）。
async function handleJsonpgz(d: Gz) {
  if (!d || !d.fundcode) return
  const code = d.fundcode
  const p = pending.get(code)
  if (!p) return
  pending.delete(code)
  clearTimeout(p.timer)
  const e = await enhanceOverseasEstimate(normalizeEstimate(d))
  cache.set(code, { e, t: Date.now() })
  recordSource('tiantian', '天天基金', true)
  p.resolve(e)
}

if (typeof window !== 'undefined') {
  window.jsonpgz = handleJsonpgz
}

// 抓单只盘中估值；失败/超时返回 null。force 跳过缓存。
// V3-9：记录天天基金源状态。
export function fetchEstimate(code: string, force = false): Promise<Estimate | null> {
  const c = cache.get(code)
  if (!force && c && Date.now() - c.t < TTL) return Promise.resolve(c.e)
  return new Promise((resolve) => {
    codeGen[code] = (codeGen[code] || 0) + 1
    const gen = codeGen[code]
    let recorded = false
    const fail = () => { if (!recorded) { recorded = true; recordSource('tiantian', '天天基金', false) } }
    const script = document.createElement('script')
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`
    const timer = window.setTimeout(() => {
      const p = pending.get(code)
      if (p && p.gen === gen) {
        pending.delete(code)
        script.remove()
        cache.set(code, { e: null, t: Date.now() })
        fail()
        resolve(null)
      }
    }, TIMEOUT)
    pending.set(code, { resolve, timer, gen })
    script.onerror = () => {
      const p = pending.get(code)
      if (p && p.gen === gen) {
        clearTimeout(p.timer)
        pending.delete(code)
        script.remove()
        fail()
        resolve(null)
      }
    }
    script.onload = () => script.remove()
    document.head.appendChild(script)
  })
}

// 批量并发抓取，返回 code → Estimate|null 映射。
export async function fetchEstimates(codes: string[]): Promise<Map<string, Estimate | null>> {
  const out = new Map<string, Estimate | null>()
  await Promise.all(codes.map(async (c) => { out.set(c, await fetchEstimate(c)) }))
  return out
}
