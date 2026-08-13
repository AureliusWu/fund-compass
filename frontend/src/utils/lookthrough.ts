// 持仓穿透（V3-3）。把组合里每只基金的成分股按权重穿透到底层个股 / 行业。
// 数据优先用 AKShare 富集 JSON（frontend/public/data/enrich/{code}.json，含完整持仓+行业），
// 缺失时回退到 V3-2 的 jjcc 前十大（utils/holdings）。后者只覆盖前十大，会标注为近似。
import { getHoldings } from './holdings'

export interface EnrichData {
  schema_version: 2
  code: string
  source: 'akshare_eastmoney'
  fetched_at: string
  holdings_as_of: string | null
  industries_as_of: string | null
  holdings: { code: string; name: string; ratio: number }[]
  industries: { name: string; ratio: number }[]
}

const enrichMem = new Map<string, EnrichData | null>()
const MAX_DISCLOSURE_AGE_DAYS = 550

function validDate(value: unknown, now = new Date()): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const exact = new Date(Date.UTC(year, month - 1, day))
  if (exact.getUTCFullYear() !== year || exact.getUTCMonth() !== month - 1 || exact.getUTCDate() !== day) return false
  const time = Date.parse(`${value}T00:00:00+08:00`)
  if (!Number.isFinite(time)) return false
  const age = (now.getTime() - time) / 86400000
  return age >= -1 && age <= MAX_DISCLOSURE_AGE_DAYS
}

function validRatios(rows: unknown): rows is { code: string; name: string; ratio: number }[] {
  if (!Array.isArray(rows)) return false
  const codes = new Set<string>()
  let total = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object') return false
    const item = row as Record<string, unknown>
    if (typeof item.code !== 'string' || !/^\d{5,6}$/.test(item.code) || codes.has(item.code)
      || typeof item.name !== 'string' || !item.name.trim()
      || typeof item.ratio !== 'number' || !Number.isFinite(item.ratio)
      || item.ratio <= 0 || item.ratio > 100) return false
    codes.add(item.code)
    total += item.ratio
  }
  return total <= 100.001
}

function validIndustries(rows: unknown): rows is { name: string; ratio: number }[] {
  if (!Array.isArray(rows)) return false
  const names = new Set<string>()
  let total = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object') return false
    const item = row as Record<string, unknown>
    if (typeof item.name !== 'string' || !item.name.trim() || names.has(item.name)
      || typeof item.ratio !== 'number' || !Number.isFinite(item.ratio)
      || item.ratio <= 0 || item.ratio > 100) return false
    names.add(item.name)
    total += item.ratio
  }
  return total <= 100.001
}

export function normalizeEnrich(code: string, raw: unknown, now = new Date()): EnrichData | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (row.schema_version !== 2 || row.code !== code || row.source !== 'akshare_eastmoney') return null
  if (typeof row.fetched_at !== 'string' || !/\+08:00$/.test(row.fetched_at)
    || !Number.isFinite(Date.parse(row.fetched_at))) return null
  if (row.holdings_as_of != null && !validDate(row.holdings_as_of, now)) return null
  if (row.industries_as_of != null && !validDate(row.industries_as_of, now)) return null
  if (!validRatios(row.holdings) || !validIndustries(row.industries)) return null
  if (row.holdings.length > 0 && !validDate(row.holdings_as_of, now)) return null
  if (row.industries.length > 0 && !validDate(row.industries_as_of, now)) return null
  return row as unknown as EnrichData
}

export async function loadEnrich(code: string): Promise<EnrichData | null> {
  if (enrichMem.has(code)) return enrichMem.get(code)!
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 6000)
    const r = await fetch(`${import.meta.env.BASE_URL}data/enrich/${code}.json`, {
      signal: ctrl.signal,
      cache: 'no-cache',
    })
    clearTimeout(t)
    if (!r.ok) return null
    const d = normalizeEnrich(code, await r.json())
    if (!d) return null
    enrichMem.set(code, d)
    return d
  } catch {
    return null
  }
}

export interface HeldFund { code: string; name: string; value: number }
export interface StockExposure { code: string; name: string; value: number; pct: number; funds: number }
export interface IndustryExposure { name: string; value: number; pct: number }
export interface Lookthrough {
  stocks: StockExposure[]
  industries: IndustryExposure[]
  coveredValue: number // 有持仓数据的基金市值合计
  totalValue: number
  industryCoveredValue: number
  source: 'enrich' | 'top10' | 'mixed' | 'none'
  stockDisclosureDates: string[]
  industryDisclosureDates: string[]
  hasUndatedStockFallback: boolean
}

// 穿透聚合：individualStock 在组合中的市值 = Σ 基金市值 × 个股占该基金净值比例。
export async function computeLookthrough(funds: HeldFund[]): Promise<Lookthrough> {
  const totalValue = funds.reduce((a, f) => a + f.value, 0)
  const stockMap = new Map<string, StockExposure>()
  const indMap = new Map<string, number>()
  let coveredValue = 0
  let industryCoveredValue = 0
  let usedEnrich = false
  let usedTop10 = false
  const stockDisclosureDates = new Set<string>()
  const industryDisclosureDates = new Set<string>()
  let hasUndatedStockFallback = false

  for (const f of funds) {
    const en = await loadEnrich(f.code)
    let holdings = en?.holdings
    if (holdings && holdings.length) usedEnrich = true
    else {
      const top10 = await getHoldings(f.code)
      holdings = top10
        .filter((h) => /^\d{5,6}$/.test(h.code) && h.name.trim()
          && Number.isFinite(h.ratio) && h.ratio > 0 && h.ratio <= 100)
        .map((h) => ({ code: h.code, name: h.name, ratio: h.ratio }))
      if (holdings.length) {
        usedTop10 = true
        hasUndatedStockFallback = true
      }
    }
    if (holdings && holdings.length) {
      if (en?.holdings_as_of) stockDisclosureDates.add(en.holdings_as_of)
      coveredValue += f.value
      for (const h of holdings) {
        const v = f.value * (h.ratio / 100)
        const cur = stockMap.get(h.code)
        if (cur) { cur.value += v; cur.funds += 1 }
        else stockMap.set(h.code, { code: h.code, name: h.name, value: v, pct: 0, funds: 1 })
      }
    }
    const inds = en?.industries
    if (inds && inds.length) {
      if (en?.industries_as_of) industryDisclosureDates.add(en.industries_as_of)
      industryCoveredValue += f.value
      for (const i of inds) indMap.set(i.name, (indMap.get(i.name) || 0) + f.value * (i.ratio / 100))
    }
  }

  const stocks = [...stockMap.values()].sort((a, b) => b.value - a.value)
  stocks.forEach((s) => { s.pct = totalValue > 0 ? (s.value / totalValue) * 100 : 0 })
  const industries = [...indMap.entries()]
    .map(([name, value]) => ({ name, value, pct: totalValue > 0 ? (value / totalValue) * 100 : 0 }))
    .sort((a, b) => b.value - a.value)

  const source: Lookthrough['source'] =
    usedEnrich && usedTop10 ? 'mixed' : usedEnrich ? 'enrich' : usedTop10 ? 'top10' : 'none'
  return {
    stocks,
    industries,
    coveredValue,
    totalValue,
    industryCoveredValue,
    source,
    stockDisclosureDates: [...stockDisclosureDates].sort(),
    industryDisclosureDates: [...industryDisclosureDates].sort(),
    hasUndatedStockFallback,
  }
}
