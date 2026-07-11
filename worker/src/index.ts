export interface Env {
  GIST_ID: string
  FUND_API_BASE: string
  GIST_TOKEN: string
  WECHAT_SENDKEY: string
  ADMIN_TOKEN: string
}

interface WatchEntry {
  code: string
  name?: string
  shares?: number
  target_weight?: number
  deleted?: boolean
}

export interface Estimate {
  code: string
  name: string
  lastNav: number | null
  estNav: number | null
  change: number | null
  time: string
  label: string
}

interface PushState {
  date: string
  sent_slots: string[]
  last_slot?: string
  last_pushed_at?: string
}

const WATCH_FILE = 'sinan-watchlist.json'
const STATE_FILE = 'sinan-estimate-state.json'
const SLOT = '14:30'

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeEstimate(raw: Record<string, unknown>, code: string): Estimate {
  const lastNav = numberOrNull(raw.dwjz)
  let estNav = numberOrNull(raw.gsz)
  let change = numberOrNull(raw.gszzl)
  if (change == null && lastNav && estNav) change = (estNav / lastNav - 1) * 100
  if (estNav == null && lastNav && change != null) estNav = lastNav * (1 + change / 100)
  const name = String(raw.name || code)
  const time = String(raw.gztime || '')
  const hour = Number(/\s(\d{1,2}):\d{2}/.exec(time)?.[1])
  const overseas = /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i.test(name)
    && Number.isFinite(hour) && (hour < 9 || hour >= 15)
  return { code, name, lastNav, estNav, change, time, label: overseas ? '海外估值' : '盘中估值' }
}

function beijingNow(now = new Date()): { date: string; iso: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
  const date = `${part('year')}-${part('month')}-${part('day')}`
  return { date, weekday: part('weekday'), iso: `${date}T${part('hour')}:${part('minute')}:${part('second')}+08:00` }
}

async function github(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'User-Agent': 'sinan-cloudflare-worker',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GIST_TOKEN}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
}

async function readGist(env: Env): Promise<Record<string, { content?: string; raw_url?: string; truncated?: boolean }>> {
  const response = await github(env, `/gists/${env.GIST_ID}`)
  if (!response.ok) throw new Error(`Gist 读取失败: HTTP ${response.status}`)
  return ((await response.json()) as { files?: Record<string, { content?: string; raw_url?: string; truncated?: boolean }> }).files || {}
}

async function fileContent(file?: { content?: string; raw_url?: string; truncated?: boolean }): Promise<string | null> {
  if (!file) return null
  if (file.truncated && file.raw_url) {
    const response = await fetch(file.raw_url)
    if (!response.ok) throw new Error(`Gist raw 文件读取失败: HTTP ${response.status}`)
    return response.text()
  }
  return file.content ?? null
}

async function fetchEstimate(code: string): Promise<Estimate | null> {
  const response = await fetch(`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`, {
    headers: { Referer: 'http://fund.eastmoney.com/' },
  })
  if (!response.ok) return null
  const match = /jsonpgz\((.*)\)/.exec(await response.text())
  if (!match) return null
  return normalizeEstimate(JSON.parse(match[1]) as Record<string, unknown>, code)
}

function portfolioItems(entries: WatchEntry[], estimates: Map<string, Estimate>) {
  const grouped = new Map<string, { shares: number; target?: number }>()
  for (const entry of entries) {
    const current = grouped.get(entry.code) || { shares: 0 }
    current.shares += numberOrNull(entry.shares) || 0
    if (entry.target_weight != null) current.target = numberOrNull(entry.target_weight) ?? undefined
    grouped.set(entry.code, current)
  }
  const values = new Map<string, number>()
  for (const [code, row] of grouped) {
    const estimate = estimates.get(code)
    const nav = estimate?.estNav || estimate?.lastNav || 0
    values.set(code, row.shares * nav)
  }
  const portfolioValue = [...values.values()].reduce((sum, value) => sum + value, 0)
  const explicit = [...grouped.values()].reduce((sum, row) => sum + (row.shares > 0 ? row.target || 0 : 0), 0)
  const unset = [...grouped.values()].filter((row) => row.shares > 0 && row.target == null)
  const defaultTarget = unset.length ? Math.max(0, 100 - explicit) / unset.length : 0
  const items = [...grouped].map(([code, row]) => {
    if (row.shares <= 0 || portfolioValue <= 0) return { code }
    return {
      code,
      current_weight: Number(((values.get(code) || 0) / portfolioValue * 100).toFixed(2)),
      target_weight: Number((row.target ?? defaultTarget).toFixed(2)),
    }
  })
  return { items, portfolioValue: Number(portfolioValue.toFixed(2)) }
}

async function decisions(env: Env, entries: WatchEntry[], estimates: Map<string, Estimate>) {
  if (!env.FUND_API_BASE) return null
  const payload = portfolioItems(entries, estimates)
  try {
    const response = await fetch(`${env.FUND_API_BASE.replace(/\/$/, '')}/api/portfolio/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: payload.items, portfolio_value: payload.portfolioValue }),
      signal: AbortSignal.timeout(25_000),
    })
    if (!response.ok) return null
    return await response.json() as Record<string, unknown>
  } catch { return null }
}

export function formatMessage(entries: WatchEntry[], estimates: Map<string, Estimate>, result: Record<string, unknown> | null) {
  const decisionRows = Array.isArray(result?.decisions) ? result.decisions as Record<string, unknown>[] : []
  const byCode = new Map(decisionRows.map((row) => [String(row.code), row]))
  const lines = entries.map((entry) => {
    const estimate = estimates.get(entry.code)
    if (!estimate) return null
    const change = estimate.change == null ? '--' : `${estimate.change >= 0 ? '+' : ''}${estimate.change.toFixed(2)}%（${estimate.label}）`
    const decision = byCode.get(entry.code)
    const action = decision ? ` → **${String(decision.action || '观察')}**` : ''
    const summary = decision?.summary ? `，${String(decision.summary)}` : ''
    return `- **${entry.name || estimate.name || entry.code}** ${change}${action}${summary}`
  }).filter(Boolean)
  return `${lines.join('\n')}\n\n> 数据辅助分析，不构成投资建议。`
}

async function serverChan(env: Env, title: string, content: string): Promise<void> {
  const body = new URLSearchParams({ title, desp: content })
  const response = await fetch(`https://sctapi.ftqq.com/${env.WECHAT_SENDKEY}.send`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  const result = await response.text()
  if (!response.ok) throw new Error(`Server酱发送失败: HTTP ${response.status}`)
  let parsed: { code?: number; errno?: number; message?: string } = {}
  try { parsed = JSON.parse(result) } catch { /* non-JSON response */ }
  if ((parsed.code != null && parsed.code !== 0) || (parsed.errno != null && parsed.errno !== 0)) {
    throw new Error(`Server酱发送失败: ${parsed.message || result.slice(0, 160)}`)
  }
}

async function writeState(env: Env, state: PushState): Promise<void> {
  const response = await github(env, `/gists/${env.GIST_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [STATE_FILE]: { content: JSON.stringify(state, null, 2) } } }),
  })
  if (!response.ok) throw new Error(`Gist 状态写入失败: HTTP ${response.status}`)
}

async function run(env: Env, force: boolean) {
  if (!env.GIST_ID || !env.GIST_TOKEN || !env.WECHAT_SENDKEY) throw new Error('Worker 密钥配置不完整')
  const now = beijingNow()
  if (!force && (now.weekday === 'Sat' || now.weekday === 'Sun')) return { status: 'skipped', reason: 'weekend' }
  const files = await readGist(env)
  const entries = (JSON.parse(await fileContent(files[WATCH_FILE]) || '[]') as WatchEntry[])
    .filter((entry) => entry?.code && !entry.deleted)
  if (!entries.length) return { status: 'skipped', reason: 'empty_watchlist' }
  const state = JSON.parse(await fileContent(files[STATE_FILE]) || '{}') as Partial<PushState>
  const current: PushState = state.date === now.date
    ? { date: now.date, sent_slots: state.sent_slots || [], last_slot: state.last_slot, last_pushed_at: state.last_pushed_at }
    : { date: now.date, sent_slots: [] }
  if (!force && current.sent_slots.includes(SLOT)) return { status: 'skipped', reason: 'already_sent' }

  const unique = new Map<string, WatchEntry>()
  for (const entry of entries) if (!unique.has(entry.code)) unique.set(entry.code, entry)
  const estimatePairs = await Promise.all([...unique].map(async ([code]) => [code, await fetchEstimate(code)] as const))
  const estimates = new Map(estimatePairs.filter((pair): pair is [string, Estimate] => pair[1] != null))
  if (!estimates.size) throw new Error('未取得任何估值数据')
  const fresh = [...estimates.values()].some((estimate) => estimate.time.startsWith(now.date))
  if (!force && !fresh) return { status: 'skipped', reason: 'no_fresh_estimate' }

  const activeEntries = [...unique.values()].filter((entry) => estimates.has(entry.code))
  const result = await decisions(env, activeEntries, estimates)
  const title = result ? `司南基金 · 自选决策摘要（${SLOT}）` : `司南基金 · 自选涨跌幅（${SLOT}）`
  await serverChan(env, title, formatMessage(activeEntries, estimates, result))
  if (!force) {
    current.sent_slots = [...new Set([...current.sent_slots, SLOT])].sort()
    current.last_slot = SLOT
    current.last_pushed_at = now.iso
    await writeState(env, current)
  }
  return { status: 'sent', funds: activeEntries.length, fresh, force }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env, false).then(console.log).catch((error) => console.error(error)))
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'sinan-estimate-push', configured: {
        gist_id: Boolean(env.GIST_ID), fund_api: Boolean(env.FUND_API_BASE),
        gist_token: Boolean(env.GIST_TOKEN), serverchan: Boolean(env.WECHAT_SENDKEY), admin: Boolean(env.ADMIN_TOKEN),
      } })
    }
    if (url.pathname === '/test' && request.method === 'POST') {
      if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }
      try { return Response.json(await run(env, true)) }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }) }
    }
    return new Response('Not Found', { status: 404 })
  },
}
