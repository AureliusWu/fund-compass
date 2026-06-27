// 选基排行数据（V3-4）。懒加载 frontend/public/data/screener.json（东财开放基金排行，
// 各期收益+费率），客户端筛选/排序。文件较大，仅在进入「排行」模式时按需加载、SW 运行时缓存。
export interface ScreenFund {
  c: string // 代码
  n: string // 简称
  t: string // 类型
  r1m: number | null; r3m: number | null; r6m: number | null
  r1y: number | null; r3y: number | null; ytd: number | null
  fee: number | null // 手续费 %
}

let cache: { funds: ScreenFund[]; updated: string } | null = null

export async function loadScreener(): Promise<{ funds: ScreenFund[]; updated: string }> {
  if (cache) return cache
  const r = await fetch(`${import.meta.env.BASE_URL}data/screener.json`)
  if (!r.ok) throw new Error('暂无排行数据')
  const d = (await r.json()) as { updated: string; funds: ScreenFund[] }
  cache = { funds: d.funds || [], updated: d.updated || '' }
  return cache
}

// 详情页类型（可能较细，如「混合型-偏股」）归一到排行的大类
const CATS = ['指数型', '股票型', '混合型', '债券型', 'QDII', 'FOF']
export function catOf(t: string | null): string | null {
  if (!t) return null
  for (const c of CATS) if (t.includes(c)) return c
  return null
}

// 同类更优（V3-7）：同大类、近1年优于当前的基金，按近1年降序取前 n。
export async function findSimilar(type: string | null, selfCode: string, baseR1y: number | null, n = 6): Promise<ScreenFund[]> {
  const cat = catOf(type)
  if (!cat) return []
  const { funds } = await loadScreener()
  let arr = funds.filter((f) => f.t === cat && f.c !== selfCode && f.r1y != null)
  if (baseR1y != null) arr = arr.filter((f) => (f.r1y as number) > baseR1y)
  arr.sort((a, b) => (b.r1y as number) - (a.r1y as number))
  return arr.slice(0, n)
}
