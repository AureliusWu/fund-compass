// 基金经理索引（V3）。懒加载 frontend/public/data/managers.json，客户端按姓名/公司搜索。
// 仅在进入「基金经理」模式时加载、SW 运行时缓存。
import { ApiError, fetchWithDeadline, requestJson } from '@/api/request'
import { mapStaticCollection } from './static-collection'

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

export interface ManagerDataset {
  managers: Manager[]
  source: 'eastmoney_fund_managers'
  // The producer stamps collection time, not the financial metric's value date.
  collectedOn: string
  fetchedAt: string | null
  valueDate: null
  ageDays: number | null
  stale: boolean
}

export const MANAGER_SNAPSHOT_MAX_AGE_DAYS = 7
let cache: ManagerDataset | null = null

interface StaticManifest {
  schema_version: 2
  updated: string
  total: number
  collection: 'managers'
  sha256: string
  chunks: string[]
  chunk_sha256: Record<string, string>
}

const SHA256_RE = /^[a-f0-9]{64}$/
const CHUNK_RE = /^part-(\d{3})-([a-f0-9]{12})\.json$/

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

export function managerSnapshotFreshness(collectedOn: string | null, now = new Date()): { ageDays: number | null; stale: boolean } {
  if (!validIsoDate(collectedOn) || !Number.isFinite(now.getTime())) return { ageDays: null, stale: true }
  const shifted = new Date(now.getTime() + 8 * 3_600_000)
  if (!Number.isFinite(shifted.getTime())) return { ageDays: null, stale: true }
  const beijingDay = shifted.toISOString().slice(0, 10)
  const ageDays = (Date.parse(beijingDay) - Date.parse(collectedOn)) / 86_400_000
  if (ageDays < 0) return { ageDays: null, stale: true }
  return { ageDays, stale: ageDays > MANAGER_SNAPSHOT_MAX_AGE_DAYS }
}

function validManifest(raw: unknown): raw is StaticManifest {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Record<string, unknown>
  if (row.schema_version !== 2 || row.collection !== 'managers'
    || !Number.isInteger(row.total) || Number(row.total) <= 0
    || !validIsoDate(row.updated)
    || typeof row.sha256 !== 'string' || !SHA256_RE.test(row.sha256)
    || !Array.isArray(row.chunks) || row.chunks.length === 0
    || !row.chunk_sha256 || typeof row.chunk_sha256 !== 'object' || Array.isArray(row.chunk_sha256)) return false

  const chunks = row.chunks as unknown[]
  const hashes = row.chunk_sha256 as Record<string, unknown>
  if (new Set(chunks).size !== chunks.length || Object.keys(hashes).length !== chunks.length) return false
  return chunks.every((file, index) => {
    if (typeof file !== 'string') return false
    const match = CHUNK_RE.exec(file)
    const digest = hashes[file]
    if (!match || typeof digest !== 'string') return false
    return match[1] === String(index).padStart(3, '0')
      && SHA256_RE.test(digest) && digest.startsWith(match[2])
  })
}

function validManager(value: unknown): value is Manager {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && row.id.trim().length > 0
    && typeof row.name === 'string' && row.name.trim().length > 0
    && typeof row.company === 'string' && typeof row.days === 'string'
    && typeof row.ret === 'string' && typeof row.scale === 'string'
    && Array.isArray(row.codes) && Array.isArray(row.names) && row.codes.length === row.names.length
    && row.codes.length > 0 && row.codes.every((code) => typeof code === 'string' && /^\d{6}$/.test(code))
    && row.names.every((name) => typeof name === 'string' && name.trim().length > 0)
}

function validManagers(rows: unknown, expectedTotal?: number): rows is Manager[] {
  return Array.isArray(rows) && rows.length > 0 && (expectedTotal == null || rows.length === expectedTotal)
    && rows.every(validManager)
    && new Set(rows.map((row) => (row as Manager).id)).size === rows.length
}

function validLegacy(raw: unknown): raw is { managers: Manager[]; updated: string; fetched_at: string } {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Record<string, unknown>
  return row.schema_version === 2 && row.source === 'eastmoney_fund_managers'
    && validIsoDate(row.updated)
    && typeof row.fetched_at === 'string' && /\+08:00$/.test(row.fetched_at)
    && Number.isFinite(Date.parse(row.fetched_at)) && validManagers(row.managers)
}

export async function loadManagers(options?: { signal?: AbortSignal }): Promise<Manager[]> {
  return (await loadManagerDataset(options)).managers
}

export async function loadManagerDataset(options?: { signal?: AbortSignal }): Promise<ManagerDataset> {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort(options?.signal?.reason)
  if (options?.signal?.aborted) cancel()
  else options?.signal?.addEventListener('abort', cancel, { once: true })
  const timer = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort('timeout')
  }, 12_000)
  let rejectOnAbort: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(new ApiError(timedOut ? '请求超时，请稍后重试' : '请求已取消', timedOut ? 'timeout' : 'cancelled'))
      if (controller.signal.aborted) rejectOnAbort()
      else controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
    })
    return await Promise.race([fetchManagerDataset(controller.signal), cancelled])
  } finally {
    globalThis.clearTimeout(timer)
    options?.signal?.removeEventListener('abort', cancel)
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
    controller.abort('finished')
  }
}

async function fetchManagerDataset(signal: AbortSignal): Promise<ManagerDataset> {
  const ensureActive = () => {
    if (signal?.aborted) throw new ApiError('请求已取消', 'cancelled')
  }
  ensureActive()
  if (cache) return { ...cache, ...managerSnapshotFreshness(cache.collectedOn) }
  const base = `${import.meta.env.BASE_URL}data/managers`
  let manifest: unknown
  let manifestMissing = false
  try {
    manifest = await requestJson<unknown>(`${base}/manifest.json`, { cache: 'no-cache', signal })
  } catch (error) {
    if (!(error instanceof ApiError && error.kind === 'http' && error.status === 404)) throw error
    manifestMissing = true
  }
  if (!manifestMissing) {
    if (!validManifest(manifest)) throw new Error('基金经理数据清单格式无效')
    const chunks = await mapStaticCollection(manifest.chunks, signal, async (file) => {
      try {
        return await fetchWithDeadline(`${base}/${file}`, { cache: 'force-cache', signal }, async (response) => {
          const text = await response.text()
          if (await sha256Text(text) !== manifest.chunk_sha256[file]) throw new ApiError('基金经理数据分片校验失败', 'network')
          const prefix = '{"managers":'
          if (!text.startsWith(prefix) || !text.endsWith('}')) throw new ApiError('基金经理数据分片格式无效', 'network')
          const arrayText = text.slice(prefix.length, -1)
          if (!arrayText.startsWith('[') || !arrayText.endsWith(']')) throw new ApiError('基金经理数据分片格式无效', 'network')
          let payload: unknown
          try { payload = JSON.parse(text) } catch { throw new ApiError('基金经理数据分片格式无效', 'network') }
          const rows = (payload as { managers?: unknown })?.managers
          if (!Array.isArray(rows) || !rows.every(validManager)) throw new ApiError('基金经理数据分片格式无效', 'network')
          return { rows, arrayText }
        })
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'http') throw new Error('基金经理数据分片加载失败')
        throw error
      }
    })
    const managers = chunks.flatMap((chunk) => chunk.rows)
    if (!validManagers(managers, manifest.total)) throw new Error('基金经理数据分片不完整')
    const datasetText = `[${chunks.map((chunk) => chunk.arrayText.slice(1, -1)).filter(Boolean).join(',')}]`
    if (await sha256Text(datasetText) !== manifest.sha256) {
      throw new Error('基金经理数据集合校验失败')
    }
    ensureActive()
    cache = {
      managers, source: 'eastmoney_fund_managers', collectedOn: manifest.updated,
      fetchedAt: null, valueDate: null, ...managerSnapshotFreshness(manifest.updated),
    }
    return cache
  }
  let d: unknown
  try {
    d = await requestJson<unknown>(`${import.meta.env.BASE_URL}data/managers.json`, { cache: 'no-cache', signal })
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'http' && error.status === 404) throw new Error('暂无基金经理数据')
    throw error
  }
  if (!validLegacy(d)) throw new Error('基金经理数据格式无效')
  ensureActive()
  cache = {
    managers: d.managers, source: 'eastmoney_fund_managers', collectedOn: d.updated,
    fetchedAt: d.fetched_at, valueDate: null, ...managerSnapshotFreshness(d.updated),
  }
  return cache
}
