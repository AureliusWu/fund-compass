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
