// 自选云同步（GitHub Gist）。参考蜉蝣基金做法：localStorage 为主，Gist 为云端备份/多设备同步。
const TOKEN_KEY = 'sinan_gist_token'
const ID_KEY = 'sinan_gist_id'
const SYNC_KEY = 'sinan_gist_sync_time'
const FILENAME = 'sinan-watchlist.json'
const API = 'https://api.github.com/gists'
const TIMEOUT = 15000

export interface WatchEntry {
  code: string
  name?: string
  shares?: number   // 持有份额（0/未设 = 仅关注）
  cost?: number     // 成本净值
  account?: string  // 所属账户（支付宝/天天基金/券商…，空=未分组）
  updated_at: string
  deleted?: boolean
}

export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t)
export const getGistId = () => localStorage.getItem(ID_KEY) || ''
const setGistId = (id: string) => localStorage.setItem(ID_KEY, id)
export const getSyncTime = () => localStorage.getItem(SYNC_KEY) || ''
const setSyncTime = (t: string) => localStorage.setItem(SYNC_KEY, t)
export const hasConfig = () => !!getToken()
export const clearConfig = () => [TOKEN_KEY, ID_KEY, SYNC_KEY].forEach((k) => localStorage.removeItem(k))

async function ghFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { Authorization: 'token ' + getToken(), ...(init.headers || {}) },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function findExistingGist(): Promise<string | null> {
  for (let page = 1; page <= 5; page++) {
    const r = await ghFetch(`${API}?per_page=100&page=${page}`)
    if (!r.ok) return null
    const gists = await r.json()
    if (!gists.length) return null
    for (const g of gists) if (g.files && g.files[FILENAME]) return g.id
    if (gists.length < 100) return null
  }
  return null
}

export async function pullEntries(): Promise<WatchEntry[] | null> {
  if (!getToken()) return null
  let id = getGistId()
  if (!id) {
    const found = await findExistingGist()
    if (found) { setGistId(found); id = found } else return null
  }
  const r = await ghFetch(`${API}/${id}`)
  if (!r.ok) { if (r.status === 404) setGistId(''); return null }
  const data = await r.json()
  const file = data.files?.[FILENAME]
  if (!file?.content) return null
  try {
    const arr = JSON.parse(file.content)
    return Array.isArray(arr) ? (arr as WatchEntry[]) : null
  } catch {
    return null
  }
}

export async function pushEntries(entries: WatchEntry[]): Promise<boolean> {
  if (!getToken()) return false
  const content = JSON.stringify(entries, null, 2)
  let id = getGistId()
  if (!id) id = (await findExistingGist()) || ''
  const desc = '司南基金 自选 | ' + new Date().toISOString()
  let r: Response
  if (id) {
    r = await ghFetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc, files: { [FILENAME]: { content } } }),
    })
  } else {
    r = await ghFetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc, public: false, files: { [FILENAME]: { content } } }),
    })
  }
  if (!r.ok) { if (r.status === 404) setGistId(''); return false }
  const data = await r.json()
  if (data.id) setGistId(data.id)
  setSyncTime(new Date().toISOString())
  return true
}
