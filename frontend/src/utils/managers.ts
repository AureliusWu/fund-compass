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
  const base = `${import.meta.env.BASE_URL}data/managers`
  const manifestResponse = await fetch(`${base}/manifest.json`)
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.json() as { chunks: string[] }
    if (Array.isArray(manifest.chunks)) {
      const chunks = await Promise.all(manifest.chunks.map(async (file) => {
        const response = await fetch(`${base}/${file}`)
        if (!response.ok) throw new Error('基金经理数据分片加载失败')
        return (await response.json() as { managers: Manager[] }).managers || []
      }))
      cache = chunks.flat()
      return cache
    }
  }
  const legacy = await fetch(`${import.meta.env.BASE_URL}data/managers.json`)
  if (!legacy.ok) throw new Error('暂无基金经理数据')
  const d = (await legacy.json()) as { managers: Manager[] }
  cache = d.managers || []
  return cache
}
