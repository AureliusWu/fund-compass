// 自选云同步（GitHub Gist）。参考蜉蝣基金做法：localStorage 为主，Gist 为云端备份/多设备同步。
const TOKEN_KEY = 'sinan_gist_token'
const ID_KEY = 'sinan_gist_id'
const SYNC_KEY = 'sinan_gist_sync_time'
const PULL_REQUIRED_KEY = 'sinan_gist_pull_required'
const FILENAME = 'sinan-watchlist.json'
const MANUAL_ASSETS_FILE = 'sinan-manual-assets.json'
const MANAGED_FILES = [FILENAME, MANUAL_ASSETS_FILE] as const
const API = 'https://api.github.com/gists'
const TIMEOUT = 15000

export interface WatchEntry {
  code: string
  name?: string
  shares?: number   // 持有份额（0/未设 = 仅关注）
  cost?: number     // 成本净值
  target_weight?: number // 目标仓位 %（V6-P2，可选）
  account?: string  // 所属账户（支付宝/天天基金/券商…，空=未分组）
  updated_at: string
  deleted?: boolean
  // V3-12 复合键：同一基金在不同账户可分别持有。id = code::account（account 为空时用 ''）。
  // 迁移旧数据时自动补全；新条目由 setHolding 生成。
  id?: string
}

function isWatchEntry(value: unknown): value is WatchEntry {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<WatchEntry>
  return typeof row.code === 'string'
    && /^\d{6}$/.test(row.code)
    && typeof row.updated_at === 'string'
    && (row.id == null || typeof row.id === 'string')
    && (row.shares == null || (typeof row.shares === 'number' && Number.isFinite(row.shares)))
    && (row.cost == null || (typeof row.cost === 'number' && Number.isFinite(row.cost)))
    && (row.target_weight == null || (typeof row.target_weight === 'number' && Number.isFinite(row.target_weight)))
    && (row.deleted == null || typeof row.deleted === 'boolean')
}

/** 生成/取得复合 ID */
export function entryId(code: string, account?: string): string {
  return `${code}::${(account || '').trim()}`
}

/** 迁移：为缺少 id 的旧条目补全 */
export function migrateEntries(entries: WatchEntry[]): WatchEntry[] {
  let changed = false
  for (const e of entries) {
    if (!e.id) { e.id = entryId(e.code, e.account); changed = true }
  }
  return changed ? [...entries] : entries
}

export const getToken = () => localStorage.getItem(TOKEN_KEY) || ''
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t)
export const getGistId = () => localStorage.getItem(ID_KEY) || ''
const setGistId = (id: string) => localStorage.setItem(ID_KEY, id)
const clearGistId = () => localStorage.removeItem(ID_KEY)
export const getSyncTime = () => localStorage.getItem(SYNC_KEY) || ''
const setSyncTime = (t: string) => localStorage.setItem(SYNC_KEY, t)
export const hasConfig = () => !!getToken()
export const clearConfig = () => [TOKEN_KEY, ID_KEY, SYNC_KEY, PULL_REQUIRED_KEY].forEach((k) => localStorage.removeItem(k))

function pullRequiredFiles(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(PULL_REQUIRED_KEY) || '[]')
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function setPullRequired(filename: string, required: boolean) {
  const files = pullRequiredFiles()
  if (required) files.add(filename)
  else files.delete(filename)
  if (files.size) localStorage.setItem(PULL_REQUIRED_KEY, JSON.stringify([...files]))
  else localStorage.removeItem(PULL_REQUIRED_KEY)
}

function requiresPull(filename: string): boolean {
  return pullRequiredFiles().has(filename)
}

function requireMigrationPulls() {
  for (const filename of MANAGED_FILES) setPullRequired(filename, true)
}

export function confirmPulledFile(filename: string) {
  if (MANAGED_FILES.includes(filename as typeof MANAGED_FILES[number])) setPullRequired(filename, false)
}

export function confirmEntriesApplied() {
  confirmPulledFile(FILENAME)
}

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

async function findExistingGist(filename: string, excludeId = ''): Promise<string | null> {
  let watchlistFallback = ''
  for (let page = 1; page <= 5; page++) {
    const r = await ghFetch(`${API}?per_page=100&page=${page}`)
    if (!r.ok) return null
    const gists = await r.json()
    if (!gists.length) return null
    for (const g of gists) {
      if (g.id === excludeId || !g.files) continue
      if (g.files[filename]) return g.id
      if (!watchlistFallback && g.files[FILENAME]) watchlistFallback = g.id
    }
    if (gists.length < 100) return watchlistFallback || null
  }
  return watchlistFallback || null
}

async function requestCachedGistWithRecovery(
  cachedId: string,
  filename: string,
  request: (id: string) => Promise<Response>,
): Promise<Response | null> {
  const initial = await request(cachedId)
  if (initial.status !== 404) return initial

  requireMigrationPulls()
  clearGistId()
  const replacement = await findExistingGist(filename, cachedId)
  if (!replacement) return null

  const retried = await request(replacement)
  if (retried.ok) setGistId(replacement)
  else if (retried.status === 404) clearGistId()
  return retried
}

async function fetchCurrentGist(filename: string): Promise<Response | null> {
  const cachedId = getGistId()
  let id = cachedId
  if (!id) {
    const found = await findExistingGist(filename)
    if (!found) return null
    setGistId(found)
    id = found
  }

  const request = (gistId: string) => ghFetch(`${API}/${gistId}`)
  const response = cachedId
    ? await requestCachedGistWithRecovery(cachedId, filename, request)
    : await request(id)
  if (!response?.ok) {
    if (response?.status === 404) clearGistId()
    return null
  }
  return response
}

export async function pullJsonFile<T>(filename: string): Promise<T | null> {
  if (!getToken()) return null
  const r = await fetchCurrentGist(filename)
  if (!r) return null
  const data = await r.json()
  const file = data.files?.[filename]
  if (!file?.content) {
    // A successful authenticated read proves there is no cloud value to overwrite.
    confirmPulledFile(filename)
    return null
  }
  try {
    return JSON.parse(file.content) as T
  } catch { return null }
}

export async function pushJsonFile(filename: string, value: unknown, desc = '司南基金 云同步'): Promise<boolean> {
  if (!getToken()) return false
  if (requiresPull(filename)) return false
  const content = JSON.stringify(value, null, 2)
  const cachedId = getGistId()
  let id = cachedId
  if (!id) id = (await findExistingGist(filename)) || ''
  const body = { description: desc + ' | ' + new Date().toISOString(), files: { [filename]: { content } } }
  const patch = (gistId: string) => ghFetch(`${API}/${gistId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let r: Response | null
  if (cachedId) {
    r = await patch(cachedId)
    if (r.status === 404) {
      requireMigrationPulls()
      clearGistId()
      const replacement = await findExistingGist(filename, cachedId)
      if (replacement) {
        const verified = await ghFetch(`${API}/${replacement}`)
        if (verified.ok) setGistId(replacement)
      }
      return false
    }
  } else {
    r = id
      ? await patch(id)
      : await ghFetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, public: false }),
      })
  }
  if (!r?.ok) { if (r?.status === 404) clearGistId(); return false }
  const data = await r.json()
  if (data.id) setGistId(data.id)
  setSyncTime(new Date().toISOString())
  return true
}

export async function pullEntries(): Promise<WatchEntry[] | null> {
  if (!getToken()) return null
  const r = await fetchCurrentGist(FILENAME)
  if (!r) return null
  const data = await r.json()
  const file = data.files?.[FILENAME]
  if (!file?.content) return null
  try {
    const arr = JSON.parse(file.content)
    if (!Array.isArray(arr) || !arr.every(isWatchEntry)) return null
    return arr as WatchEntry[]
  } catch {
    return null
  }
}

export async function pushEntries(entries: WatchEntry[]): Promise<boolean> {
  if (!getToken()) return false
  return pushJsonFile(FILENAME, entries, '司南基金 自选')
}
