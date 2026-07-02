// 盘中估值（天天基金 JSONP）。移植自蜉蝣基金（FundVal）的实现思路，
// 司南前端用同一全局回调 window.jsonpgz —— 纯前端、不依赖后端，盘中实时。
// 接口：https://fundgz.1234567.com.cn/js/{code}.js → jsonpgz({...})
// 字段：dwjz=昨日单位净值, gsz=盘中估算净值, gszzl=估算涨跌%, jzrq=净值日期, gztime=估值时间。
// 注意：gszzl 是百分比可为负/为 0，统一用 Number.isFinite 判断；QDII/全球基金常返回海外收盘后的估值时间。

import { recordSource } from './resilience'

export interface Estimate {
  code: string
  name: string
  lastNav: number | null // 昨日单位净值 dwjz
  estNav: number | null // 盘中估算净值 gsz
  estChange: number | null // 估算涨跌% gszzl
  navDate: string // 上一净值日期 jzrq
  estTime: string // 估值时间 gztime
  kind: 'intraday' | 'overseas'
  label: '盘中估值' | '海外估值'
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

function num(s: unknown): number | null {
  const n = typeof s === 'number' ? s : parseFloat(String(s))
  return Number.isFinite(n) ? n : null
}

function usableNav(n: number | null): n is number {
  return n != null && Number.isFinite(n) && n > 0
}

function isOverseasEstimate(name: string, estTime: string): boolean {
  const overseasFund = /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i.test(name)
  const hour = Number((estTime.match(/\s(\d{1,2}):\d{2}$/) || [])[1])
  return overseasFund && Number.isFinite(hour) && (hour < 9 || hour >= 15)
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
  }
}

// 全局 JSONP 回调（接口里写死的函数名，按 fundcode 调度到对应 Promise）。
function handleJsonpgz(d: Gz) {
  if (!d || !d.fundcode) return
  const code = d.fundcode
  const p = pending.get(code)
  if (!p) return
  pending.delete(code)
  clearTimeout(p.timer)
  const e = normalizeEstimate(d)
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
