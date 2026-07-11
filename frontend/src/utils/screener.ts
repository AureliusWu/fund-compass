// 选基排行数据（V3-4 + V6-P4 决策质量筛选）。懒加载 frontend/public/data/screener.json
export interface ScreenFund {
  c: string // 代码
  n: string // 简称
  t: string // 类型
  r1m: number | null; r3m: number | null; r6m: number | null
  r1y: number | null; r3y: number | null; ytd: number | null
  fee: number | null // 手续费 %
}

export type ScreenPresetId = '' | 'broad' | 'sector' | 'qdii' | 'bond'
export type RankSortKey = 'quality' | 'r1y' | 'r3y' | 'r6m' | 'r3m' | 'ytd' | 'fee' | 'stable'

export interface RankFilter {
  type?: string
  keyword?: string
  preset?: ScreenPresetId
  minR1y?: number
  minR3y?: number
  maxFee?: number
  minQuality?: number
  sortKey: RankSortKey
}

const BROAD_RE = /沪深300|中证500|上证50|上证180|中证1000|创业板|科创50|红利|中证100|深100|300ETF|500ETF|50ETF|1000ETF|A500/i

let cache: { funds: ScreenFund[]; updated: string } | null = null

export async function loadScreener(): Promise<{ funds: ScreenFund[]; updated: string }> {
  if (cache) return cache
  const base = `${import.meta.env.BASE_URL}data/screener`
  const manifestResponse = await fetch(`${base}/manifest.json`)
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.json() as { updated: string; chunks: string[] }
    if (Array.isArray(manifest.chunks)) {
      const chunks = await Promise.all(manifest.chunks.map(async (file) => {
        const response = await fetch(`${base}/${file}`)
        if (!response.ok) throw new Error('排行数据分片加载失败')
        return (await response.json() as { funds: ScreenFund[] }).funds || []
      }))
      cache = { funds: chunks.flat(), updated: manifest.updated || '' }
      return cache
    }
  }
  const legacy = await fetch(`${import.meta.env.BASE_URL}data/screener.json`)
  if (!legacy.ok) throw new Error('暂无排行数据')
  const d = (await legacy.json()) as { updated: string; funds: ScreenFund[] }
  cache = { funds: d.funds || [], updated: d.updated || '' }
  return cache
}

const CATS = ['指数型', '股票型', '混合型', '债券型', 'QDII', 'FOF']
export function catOf(t: string | null): string | null {
  if (!t) return null
  for (const c of CATS) if (t.includes(c)) return c
  return null
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n))
}

function scale(x: number | null, lo: number, hi: number): number | null {
  if (x == null || Number.isNaN(x)) return null
  if (lo === hi) return 50
  return clamp(((x - lo) / (hi - lo)) * 100)
}

/** V6-P4：用现有排行字段估算「决策质量分」0–100（非后端四维评分，供选基排序/筛选）。 */
export function screenQuality(f: ScreenFund): number | null {
  const r1 = scale(f.r1y, -20, 60)
  const r3 = scale(f.r3y, -30, 120)
  const r6 = scale(f.r6m, -15, 80)
  const parts: { s: number; w: number }[] = []
  if (r1 != null) parts.push({ s: r1, w: 0.35 })
  if (r3 != null) parts.push({ s: r3, w: 0.35 })
  if (r6 != null) parts.push({ s: r6, w: 0.15 })
  if (!parts.length) return null
  const tw = parts.reduce((a, p) => a + p.w, 0)
  let ret = parts.reduce((a, p) => a + p.s * p.w, 0) / tw

  const feeScore = f.fee != null ? scale(1.5 - f.fee, 0, 1.5) ?? 50 : 50
  let stab = 75
  if (f.r1m != null && f.r1y != null && f.r1y > 5 && f.r1m > f.r1y * 0.45) stab = 35
  if (f.r3m != null && f.r1y != null && f.r3m > f.r1y * 1.2) stab = Math.min(stab, 45)

  return Math.round(ret * 0.55 + (feeScore ?? 50) * 0.25 + stab * 0.2)
}

/** 波动/回撤代理：近端收益离散越大，分越低（无真实 MDD 数据时的保守替代）。 */
export function screenStability(f: ScreenFund): number | null {
  if (f.r1m == null || f.r3m == null) return null
  const spread = Math.abs(f.r1m - f.r3m / 4)
  return Math.round(clamp(100 - spread * 1.2))
}

export function matchPreset(f: ScreenFund, preset: ScreenPresetId): boolean {
  if (!preset) return true
  if (preset === 'qdii') return f.t === 'QDII'
  if (preset === 'bond') return f.t === '债券型'
  if (preset === 'broad') return f.t === '指数型' && BROAD_RE.test(f.n)
  if (preset === 'sector') {
    return (f.t === '指数型' || f.t === '股票型') && !(f.t === '指数型' && BROAD_RE.test(f.n))
  }
  return true
}

export function filterAndSortRank(all: ScreenFund[], filter: RankFilter): ScreenFund[] {
  const kw = filter.keyword?.trim().toLowerCase()
  const arr = all.filter((f) => {
    if (filter.type && f.t !== filter.type) return false
    if (filter.preset && !matchPreset(f, filter.preset)) return false
    if (filter.minR1y != null && !(f.r1y != null && f.r1y >= filter.minR1y)) return false
    if (filter.minR3y != null && !(f.r3y != null && f.r3y >= filter.minR3y)) return false
    if (filter.maxFee != null && !(f.fee != null && f.fee <= filter.maxFee)) return false
    if (filter.minQuality != null) {
      const q = screenQuality(f)
      if (q == null || q < filter.minQuality) return false
    }
    if (kw && !(f.c.includes(kw) || f.n.toLowerCase().includes(kw))) return false
    return true
  })

  const k = filter.sortKey
  const asc = k === 'fee'
  arr.sort((a, b) => {
    if (k === 'quality') {
      const av = screenQuality(a); const bv = screenQuality(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return bv - av
    }
    if (k === 'stable') {
      const av = screenStability(a); const bv = screenStability(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return bv - av
    }
    const av = a[k as keyof ScreenFund] as number | null
    const bv = b[k as keyof ScreenFund] as number | null
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return asc ? av - bv : bv - av
  })
  return arr
}

/** 同类更优（V3-7 + V6-P4）：同大类、质量/收益/费率综合更优。 */
export async function findSimilar(type: string | null, selfCode: string, baseR1y: number | null, n = 6): Promise<ScreenFund[]> {
  const cat = catOf(type)
  if (!cat) return []
  const { funds } = await loadScreener()
  let arr = funds.filter((f) => f.t === cat && f.c !== selfCode)
  if (baseR1y != null) arr = arr.filter((f) => f.r1y != null && f.r1y > baseR1y)
  arr.sort((a, b) => {
    const qa = screenQuality(a) ?? -1
    const qb = screenQuality(b) ?? -1
    if (qb !== qa) return qb - qa
    const fa = a.fee ?? 99
    const fb = b.fee ?? 99
    if (fa !== fb) return fa - fb
    return (b.r1y ?? -999) - (a.r1y ?? -999)
  })
  return arr.slice(0, n)
}

export function rankMetric(f: ScreenFund, sortKey: RankSortKey): number | null {
  if (sortKey === 'quality') return screenQuality(f)
  if (sortKey === 'stable') return screenStability(f)
  return f[sortKey as keyof ScreenFund] as number | null
}
