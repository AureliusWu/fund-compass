// 基金经理索引（V3）。懒加载 frontend/public/data/managers.json，客户端按姓名/公司搜索。
// 仅在进入「基金经理」模式时加载、SW 运行时缓存。
export interface Manager {
  id: string
  name: string
  company: string
  codes: string[]
  names: string[]
  days: string // 从业天数
  ret: string // 任职回报%
  scale: string // 在管规模
}

let cache: Manager[] | null = null

export async function loadManagers(): Promise<Manager[]> {
  if (cache) return cache
  const r = await fetch(`${import.meta.env.BASE_URL}data/managers.json`)
  if (!r.ok) throw new Error('暂无基金经理数据')
  const d = (await r.json()) as { managers: Manager[] }
  cache = d.managers || []
  return cache
}
