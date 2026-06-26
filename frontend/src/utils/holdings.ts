// 十大重仓股（移植自蜉蝣基金 FundVal，纯前端、不依赖后端、不改 FundVal）。
// jjcc：fundf10 接口 <script> 注入，回写 window.apidata={content:HTML}，解析表格取前十大。
//   表格列：cells[1]=股票代码(a), cells[2]=名称(a), cells[6]=占净值比例(%)。jjcc 本身不含涨跌幅。
// 涨跌幅：另查东方财富 push2 ulist（f12=代码, f3=涨跌%），secid 沪市(6/9 开头)=1.code、深市=0.code。

export interface Holding { code: string; name: string; ratio: number; change?: number }

declare global { interface Window { apidata?: { content?: string } } }

const mem = new Map<string, Holding[]>()
const LS = 'sinan_hold_'
const TTL = 12 * 3600 * 1000 // 重仓股季度披露，缓存 12h；涨跌幅每次实时刷新
const TIMEOUT = 8000

let lock: Promise<unknown> = Promise.resolve() // 串行化 window.apidata 访问，避免并发冲突

function loadLS(code: string): Holding[] | null {
  try {
    const r = JSON.parse(localStorage.getItem(LS + code) || 'null')
    if (r && Array.isArray(r.v) && Date.now() - r.t < TTL) return r.v
  } catch { /* ignore */ }
  return null
}
function saveLS(code: string, v: Holding[]) {
  try { localStorage.setItem(LS + code, JSON.stringify({ t: Date.now(), v })) } catch { /* 容量满忽略 */ }
}

function parseHoldings(html: string): Holding[] {
  if (!html) return []
  const div = document.createElement('div')
  div.innerHTML = html
  const out: Holding[] = []
  div.querySelectorAll('table tbody tr').forEach((tr) => {
    if (out.length >= 10) return
    const cells = tr.children
    if (cells.length < 7) return
    const codeEl = cells[1].querySelector('a')
    const nameEl = cells[2].querySelector('a')
    const code = (codeEl?.textContent || cells[1].textContent || '').trim()
    const name = (nameEl?.textContent || cells[2].textContent || '').trim()
    const ratio = parseFloat((cells[6].textContent || '').trim()) || 0
    if (code && name) out.push({ code, name, ratio })
  })
  return out
}

function fetchJjcc(code: string): Promise<Holding[]> {
  return new Promise((resolve) => {
    const script = document.createElement('script')
    let done = false
    const finish = (list: Holding[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { delete window.apidata } catch { /* ignore */ }
      script.remove()
      resolve(list)
    }
    const timer = setTimeout(() => finish([]), TIMEOUT)
    script.onload = () => finish(parseHoldings(window.apidata?.content || ''))
    script.onerror = () => finish([])
    script.src = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&_=${Date.now()}`
    document.head.appendChild(script)
  })
}

const secidFor = (c: string) => (/^[69]/.test(c) ? '1.' : '0.') + c

// 给 A 股重仓填当日涨跌幅（原地写入 s.change），带超时避免卡住网络。
async function fetchQuotes(stocks: Holding[]): Promise<void> {
  const a = stocks.filter((s) => /^\d{6}$/.test(s.code))
  if (!a.length) return
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const secids = a.map((s) => secidFor(s.code)).join(',')
    const r = await fetch(
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f3&secids=${secids}&_=${Date.now()}`,
      { signal: ctrl.signal },
    )
    clearTimeout(t)
    if (!r.ok) return
    const j = await r.json()
    const diff = j?.data?.diff
    if (!diff) return
    const list: Array<{ f12?: string; f3?: number }> = Array.isArray(diff) ? diff : Object.values(diff)
    const map: Record<string, number> = {}
    list.forEach((it) => { if (it.f12 != null) map[String(it.f12)] = Number(it.f3) })
    stocks.forEach((s) => { if (Number.isFinite(map[s.code])) s.change = map[s.code] })
  } catch { clearTimeout(t) /* 静默：涨跌幅留空 */ }
}

// 取某基金十大重仓（名称/代码/占比 缓存 12h；涨跌幅每次实时刷新）。
export async function getHoldings(code: string, force = false): Promise<Holding[]> {
  let list = !force ? (mem.get(code) || loadLS(code)) : null
  if (!list) {
    const prev = lock
    let release!: () => void
    lock = new Promise<void>((r) => { release = r })
    try {
      await prev.catch(() => {})
      list = await fetchJjcc(code)
      if (list.length) { mem.set(code, list); saveLS(code, list) }
    } finally { release() }
  }
  list = list || []
  if (list.length) await fetchQuotes(list)
  return list.map((s) => ({ ...s }))
}
