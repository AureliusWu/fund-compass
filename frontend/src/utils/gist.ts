// 自选云同步（GitHub Gist）。参考蜉蝣基金做法：localStorage 为主，Gist 为云端备份/多设备同步。
import { ApiError, fetchWithDeadline } from '@/api/request'
import { getLegacySyncConsent, getLegacySyncGeneration, setLegacySyncConsent, subscribeLegacySyncConsent } from './cloud-consent'
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
  shares?: number | null   // 持有份额；缺失不等于 0，意图由 position_kind 表达
  position_kind?: 'holding' | 'watch' // Explicit input intent; zero shares need not mean "watch".
  cost?: number | null     // 成本净值，缺失为 null/未设
  target_weight?: number | null // 目标仓位 %（V6-P2，可选）
  account?: string  // 所属账户（支付宝/天天基金/券商…，空=未分组）
  updated_at: string
  deleted?: boolean
  // V3-12 复合键：同一基金在不同账户可分别持有。id = code::account（account 为空时用 ''）。
  // 迁移旧数据时自动补全；新条目由 setHolding 生成。
  id?: string
}

function isWatchEntry(value: unknown): value is WatchEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Partial<WatchEntry>
  const fields = new Set(['code', 'name', 'shares', 'cost', 'target_weight', 'position_kind', 'account', 'updated_at', 'deleted', 'id'])
  const date = typeof row.updated_at === 'string' ? row.updated_at.slice(0, 10) : ''
  const timestamp = typeof row.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(row.updated_at)
    && Number.isFinite(Date.parse(row.updated_at)) && new Date(row.updated_at).toISOString().slice(0, 10) === date
  return typeof row.code === 'string'
    && /^\d{6}$/.test(row.code)
    && Object.keys(value).every(key => fields.has(key))
    && timestamp
    && (row.name == null || typeof row.name === 'string')
    && (row.account == null || typeof row.account === 'string' && row.account.length <= 200 && !/[\u0000-\u001f\u007f]/.test(row.account))
    && (row.id == null || typeof row.id === 'string' && row.id === entryId(row.code, row.account))
    && (row.position_kind == null || row.position_kind === 'holding' || row.position_kind === 'watch')
    && (row.shares == null || (typeof row.shares === 'number' && Number.isFinite(row.shares) && row.shares >= 0))
    && (row.position_kind !== 'watch' || row.shares == null || row.shares === 0)
    && (row.cost == null || (typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0))
    && (row.target_weight == null || (typeof row.target_weight === 'number' && Number.isFinite(row.target_weight) && row.target_weight >= 0 && row.target_weight <= 100))
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

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' } }
export const setToken = (t: string) => { setLegacySyncConsent(false); localStorage.setItem(TOKEN_KEY, t) }
export const getGistId = () => {
  try { const value = localStorage.getItem(ID_KEY) || ''; return /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : '' } catch { return '' }
}
const setGistId = (id: string) => localStorage.setItem(ID_KEY, id)
const clearGistId = () => localStorage.removeItem(ID_KEY)
export const getSyncTime = () => { try { return localStorage.getItem(SYNC_KEY) || '' } catch { return '' } }
const setSyncTime = (t: string) => localStorage.setItem(SYNC_KEY, t)
export const hasConfig = () => !!getToken()
export const clearConfig = () => {
  setLegacySyncConsent(false)
  ;[TOKEN_KEY, ID_KEY, SYNC_KEY, PULL_REQUIRED_KEY].forEach((k) => localStorage.removeItem(k))
}

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
  if (getLegacySyncConsent() && MANAGED_FILES.includes(filename as typeof MANAGED_FILES[number])) setPullRequired(filename, false)
}

export function confirmEntriesApplied() {
  confirmPulledFile(FILENAME)
}

interface CloudOperation { generation: number; token: string; controller: AbortController; filename: string }
interface GistResponse { ok: boolean; status: number; data: unknown }
const object = (value: unknown): Record<string, unknown> | null => value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
function gistFile(data: unknown, filename: string): Record<string, unknown> | null {
  return object(object(object(data)?.files)?.[filename])
}
const operations = new Map<string, CloudOperation>()
function assertActive(operation: CloudOperation) {
  if (operation.controller.signal.aborted || !getLegacySyncConsent()
    || operation.generation !== getLegacySyncGeneration() || operation.token !== getToken()
    || operations.get(operation.filename) !== operation) {
    throw new ApiError('云同步已取消，本地数据保留', 'cancelled')
  }
}
async function withCloud<T>(filename: string, denied: T, run: (operation: CloudOperation) => Promise<T>): Promise<T> {
  if (!getLegacySyncConsent() || !getToken()) return denied
  operations.get(filename)?.controller.abort('superseded')
  const operation = { generation: getLegacySyncGeneration(), token: getToken(), controller: new AbortController(), filename }
  operations.set(filename, operation)
  const unsubscribe = subscribeLegacySyncConsent((_consent, generation) => {
    if (generation !== operation.generation) operation.controller.abort('consent-changed')
  })
  try {
    assertActive(operation)
    const value = await run(operation)
    assertActive(operation)
    return value
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'cancelled') return denied
    throw error
  } finally {
    unsubscribe()
    if (operations.get(filename) === operation) operations.delete(filename)
  }
}
async function ghFetch(operation: CloudOperation, url: string, init: RequestInit = {}): Promise<GistResponse> {
  assertActive(operation)
  try {
    const response = await fetchWithDeadline<GistResponse>(url, {
      ...init, signal: operation.controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { ...(init.headers || {}), Authorization: 'token ' + operation.token },
    }, async response => ({ ok: response.ok, status: response.status, data: await response.json() }), TIMEOUT)
    assertActive(operation)
    return response
  } catch (error) {
    assertActive(operation)
    if (error instanceof ApiError && error.kind === 'http') return { ok: false, status: error.status || 502, data: null }
    throw error
  }
}

async function findExistingGist(operation: CloudOperation, filename: string, excludeId = ''): Promise<string | null> {
  let watchlistFallback = ''
  for (let page = 1; page <= 5; page++) {
    const r = await ghFetch(operation, `${API}?per_page=100&page=${page}`)
    if (!r.ok) return null
    const gists = r.data
    if (!Array.isArray(gists)) return null
    if (!gists.length) return null
    for (const value of gists) {
      const g = object(value)
      const files = object(g?.files)
      if (!g || typeof g.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(g.id) || g.id === excludeId || !files) continue
      if (files[filename]) return g.id
      if (!watchlistFallback && files[FILENAME]) watchlistFallback = g.id
    }
    if (gists.length < 100) return watchlistFallback || null
  }
  return watchlistFallback || null
}

async function requestCachedGistWithRecovery(
  operation: CloudOperation,
  cachedId: string,
  filename: string,
  request: (id: string) => Promise<GistResponse>,
): Promise<GistResponse | null> {
  const initial = await request(cachedId)
  assertActive(operation)
  if (initial.status !== 404) return initial

  requireMigrationPulls()
  clearGistId()
  const replacement = await findExistingGist(operation, filename, cachedId)
  assertActive(operation)
  if (!replacement) return null

  const retried = await request(replacement)
  assertActive(operation)
  if (retried.ok) setGistId(replacement)
  else if (retried.status === 404) clearGistId()
  return retried
}

async function fetchCurrentGist(operation: CloudOperation, filename: string): Promise<GistResponse | null> {
  const cachedId = getGistId()
  let id = cachedId
  if (!id) {
    const found = await findExistingGist(operation, filename)
    assertActive(operation)
    if (!found) return null
    setGistId(found)
    id = found
  }

  const request = (gistId: string) => ghFetch(operation, `${API}/${gistId}`)
  const response = cachedId
    ? await requestCachedGistWithRecovery(operation, cachedId, filename, request)
    : await request(id)
  assertActive(operation)
  if (!response?.ok) {
    if (response?.status === 404) clearGistId()
    return null
  }
  return response
}

export async function pullJsonFile<T>(filename: string): Promise<T | null> {
  return withCloud<T | null>(filename, null, async operation => {
    const r = await fetchCurrentGist(operation, filename)
    assertActive(operation)
    if (!r) return null
    const files = object(object(r.data)?.files)
    if (!files) return null
    const file = object(files[filename])
    if (!(filename in files)) {
      // Only a valid authenticated file map proves that no value exists.
      confirmPulledFile(filename)
      return null
    }
    if (typeof file?.content !== 'string' || file.truncated === true) return null
    try { return JSON.parse(file.content) as T } catch { return null }
  })
}

export async function pushJsonFile(filename: string, value: unknown, desc = '司南基金 云同步'): Promise<boolean> {
  return withCloud(filename, false, async operation => {
    if (requiresPull(filename)) return false
    let content: string | undefined
    try {
      content = JSON.stringify(value, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('invalid-number')
        return item
      }, 2)
    } catch { return false }
    if (typeof content !== 'string') return false
    const cachedId = getGistId()
    let id = cachedId
    if (!id) id = (await findExistingGist(operation, filename)) || ''
    assertActive(operation)
    const body = { description: desc + ' | ' + new Date().toISOString(), files: { [filename]: { content } } }
    const patch = (gistId: string) => ghFetch(operation, `${API}/${gistId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    let r: GistResponse | null
    if (cachedId) {
      r = await patch(cachedId)
      assertActive(operation)
      if (r.status === 404) {
        requireMigrationPulls()
        clearGistId()
        const replacement = await findExistingGist(operation, filename, cachedId)
        assertActive(operation)
        if (replacement) {
          const verified = await ghFetch(operation, `${API}/${replacement}`)
          assertActive(operation)
          if (verified.ok) setGistId(replacement)
        }
        return false
      }
    } else {
      r = id ? await patch(id) : await ghFetch(operation, API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, public: false }),
      })
    }
    assertActive(operation)
    if (!r?.ok) { if (r?.status === 404) clearGistId(); return false }
    const data = object(r.data)
    if (typeof data?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.id)) return false
    setGistId(data.id)
    setSyncTime(new Date().toISOString())
    return true
  })
}

export async function pullEntries(): Promise<WatchEntry[] | null> {
  return withCloud<WatchEntry[] | null>(FILENAME, null, async operation => {
    const r = await fetchCurrentGist(operation, FILENAME)
    assertActive(operation)
    if (!r) return null
    const file = gistFile(r.data, FILENAME)
    if (typeof file?.content !== 'string' || file.truncated === true) return null
    try {
      const arr = JSON.parse(file.content)
      if (!Array.isArray(arr) || !arr.every(isWatchEntry)) return null
      if (new Set(arr.map(row => row.id || entryId(row.code, row.account))).size !== arr.length) return null
      return arr as WatchEntry[]
    } catch { return null }
  })
}

export async function pushEntries(entries: WatchEntry[]): Promise<boolean> {
  if (!Array.isArray(entries) || !entries.every(isWatchEntry)
    || new Set(entries.map(row => row.id || entryId(row.code, row.account))).size !== entries.length) return false
  if (!getToken()) return false
  return pushJsonFile(FILENAME, entries, '司南基金 自选')
}
