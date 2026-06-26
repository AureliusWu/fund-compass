// 盘中估值（天天基金 JSONP）。移植自蜉蝣基金（FundVal）的实现思路，
// 司南前端用同一全局回调 window.jsonpgz —— 纯前端、不依赖后端，盘中实时。
// 接口：https://fundgz.1234567.com.cn/js/{code}.js → jsonpgz({...})
// 字段：dwjz=昨日单位净值, gsz=盘中估算净值, gszzl=估算涨跌%, jzrq=净值日期, gztime=估值时间。
// 注意：gszzl 是百分比可为负/为 0，统一用 Number.isFinite 判断；QDII 常无 gsz（盘中估值缺失）。

export interface Estimate {
  code: string
  name: string
  lastNav: number | null // 昨日单位净值 dwjz
  estNav: number | null // 盘中估算净值 gsz
  estChange: number | null // 估算涨跌% gszzl
  navDate: string // 上一净值日期 jzrq
  estTime: string // 估值时间 gztime
}

interface Gz {
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

function num(s: unknown): number | null {
  const n = typeof s === 'number' ? s : parseFloat(String(s))
  return Number.isFinite(n) ? n : null
}

// 全局 JSONP 回调（接口里写死的函数名，按 fundcode 调度到对应 Promise）。
window.jsonpgz = (d: Gz) => {
  if (!d || !d.fundcode) return
  const code = d.fundcode
  const p = pending.get(code)
  if (!p) return
  pending.delete(code)
  clearTimeout(p.timer)
  const e: Estimate = {
    code,
    name: d.name || code,
    lastNav: num(d.dwjz),
    estNav: num(d.gsz),
    estChange: num(d.gszzl),
    navDate: d.jzrq || '',
    estTime: d.gztime || '',
  }
  cache.set(code, { e, t: Date.now() })
  p.resolve(e)
}

// 抓单只盘中估值；失败/超时返回 null。force 跳过缓存。
export function fetchEstimate(code: string, force = false): Promise<Estimate | null> {
  const c = cache.get(code)
  if (!force && c && Date.now() - c.t < TTL) return Promise.resolve(c.e)
  return new Promise((resolve) => {
    codeGen[code] = (codeGen[code] || 0) + 1
    const gen = codeGen[code]
    const script = document.createElement('script')
    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`
    const timer = window.setTimeout(() => {
      const p = pending.get(code)
      if (p && p.gen === gen) {
        pending.delete(code)
        script.remove()
        cache.set(code, { e: null, t: Date.now() })
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
