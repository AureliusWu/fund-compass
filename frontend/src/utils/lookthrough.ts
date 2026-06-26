// 持仓穿透（V3-3）。把组合里每只基金的成分股按权重穿透到底层个股 / 行业。
// 数据优先用 AKShare 富集 JSON（frontend/public/data/enrich/{code}.json，含完整持仓+行业），
// 缺失时回退到 V3-2 的 jjcc 前十大（utils/holdings）。后者只覆盖前十大，会标注为近似。
import { getHoldings } from './holdings'

export interface EnrichData {
  code: string
  holdings: { code: string; name: string; ratio: number }[]
  industries: { name: string; ratio: number }[]
}

const enrichMem = new Map<string, EnrichData | null>()

export async function loadEnrich(code: string): Promise<EnrichData | null> {
  if (enrichMem.has(code)) return enrichMem.get(code)!
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 6000)
    const r = await fetch(`${import.meta.env.BASE_URL}data/enrich/${code}.json`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) { enrichMem.set(code, null); return null }
    const d = (await r.json()) as EnrichData
    enrichMem.set(code, d)
    return d
  } catch {
    enrichMem.set(code, null)
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

  for (const f of funds) {
    const en = await loadEnrich(f.code)
    let holdings = en?.holdings
    if (holdings && holdings.length) usedEnrich = true
    else {
      const top10 = await getHoldings(f.code)
      holdings = top10.map((h) => ({ code: h.code, name: h.name, ratio: h.ratio }))
      if (holdings.length) usedTop10 = true
    }
    if (holdings && holdings.length) {
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
  return { stocks, industries, coveredValue, totalValue, industryCoveredValue, source }
}
