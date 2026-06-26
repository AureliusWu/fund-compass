// 指数行情条（移植自蜉蝣基金 FundVal，纯前端、不依赖后端）。
// 指数：腾讯 qt.gtimg.cn JSONP（<script> 注入，window.v_*），"~" 分割，field[3]=现价/[32]=涨跌%/[4]=昨收。
// 黄金：东方财富 push2 fetch（CORS 友好），secid=118/113/114.AU9999，f43/f57/f60=价、f170=涨跌%。
// A 股休市时接口自带返回上一交易日收盘价；30s 刷新；离线回退本地缓存。

export interface IndexQuote { name: string; price: number; changePct: number }

interface Cfg { code: string; name: string; gold?: boolean }
const CONFIG: Cfg[] = [
  { code: 'usIXIC', name: '纳斯达克' },
  { code: 'usINX', name: '标普500' },
  { code: 'AU9999', name: '黄金9999', gold: true },
  { code: 'sh000001', name: '上证指数' },
  { code: 'sh000300', name: '沪深300' },
]

const LS = 'sinan_index_cache_v1'
const TIMEOUT = 8000
const num = (s: unknown): number => parseFloat(String(s))

function loadCache(): IndexQuote[] {
  try { const a = JSON.parse(localStorage.getItem(LS) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}
function saveCache(q: IndexQuote[]) { try { localStorage.setItem(LS, JSON.stringify(q)) } catch { /* 容量满忽略 */ } }

function parseGtimg(raw: string | undefined): { price: number; changePct: number } | null {
  if (!raw || typeof raw !== 'string') return null
  const f = raw.split('~')
  if (f.length < 4) return null
  const price = parseFloat(f[3])
  if (!Number.isFinite(price) || price <= 0) return null
  let chg = parseFloat(f[32])
  if (!Number.isFinite(chg)) {
    const pc = parseFloat(f[4])
    if (Number.isFinite(pc) && pc > 0) chg = ((price - pc) / pc) * 100
  }
  return { price, changePct: Number.isFinite(chg) ? chg : NaN }
}

// 一次 JSONP 请求拉多只指数，返回 code → {price,changePct}|null
function fetchIndices(codes: string[]): Promise<Record<string, { price: number; changePct: number } | null>> {
  return new Promise((resolve) => {
    const w = window as unknown as Record<string, string | undefined>
    const script = document.createElement('script')
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      script.remove()
      const out: Record<string, { price: number; changePct: number } | null> = {}
      for (const c of codes) {
        out[c] = ok ? parseGtimg(w['v_' + c]) : null
        try { delete w['v_' + c] } catch { /* ignore */ }
      }
      resolve(out)
    }
    const timer = setTimeout(() => finish(false), TIMEOUT)
    script.onload = () => finish(true)
    script.onerror = () => finish(false)
    script.src = 'https://qt.gtimg.cn/q=' + codes.join(',') + '&_t=' + Date.now()
    document.head.appendChild(script)
  })
}

// 黄金 AU9999（东方财富 push2，多 secid 兜底）
async function fetchGold(): Promise<{ price: number; changePct: number } | null> {
  for (const secid of ['118.AU9999', '113.AU9999', '114.AU9999']) {
    try {
      const r = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f60,f170&fltt=2&_=${Date.now()}`)
      if (!r.ok) continue
      const j = await r.json()
      const d = j?.data
      if (!d) continue
      let price = num(d.f43)
      if (!(price > 0)) price = num(d.f57)
      if (!(price > 0)) price = num(d.f60)
      if (!(price > 0)) continue
      let chg = num(d.f170)
      if (!Number.isFinite(chg)) { const pc = num(d.f60); chg = pc > 0 ? ((price - pc) / pc) * 100 : NaN }
      return { price, changePct: Number.isFinite(chg) ? chg : NaN }
    } catch { /* 下一个 secid */ }
  }
  return null
}

// 拉全部行情（指数 + 黄金并行），失败的项回退缓存；有任一成功就刷新缓存。
export async function getIndices(): Promise<IndexQuote[]> {
  const cache = loadCache()
  const gtimgCodes = CONFIG.filter((c) => !c.gold).map((c) => c.code)
  const [idx, gold] = await Promise.all([fetchIndices(gtimgCodes), fetchGold()])
  const out: IndexQuote[] = CONFIG.map((c, i) => {
    const got = c.gold ? gold : idx[c.code]
    if (got && Number.isFinite(got.price)) return { name: c.name, price: got.price, changePct: got.changePct }
    return cache[i] && cache[i].name === c.name ? cache[i] : { name: c.name, price: NaN, changePct: NaN }
  })
  if (out.some((o) => Number.isFinite(o.price))) saveCache(out)
  return out
}

// 初次渲染用的占位（缓存或空骨架）
export function cachedIndices(): IndexQuote[] {
  const c = loadCache()
  return c.length === CONFIG.length ? c : CONFIG.map((x) => ({ name: x.name, price: NaN, changePct: NaN }))
}
