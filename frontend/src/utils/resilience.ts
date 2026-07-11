// 多源容灾（V3-9）。SWR 缓存 + 熔断 + 自动退避重试。
// 前端直连多个数据源（后端 API / 天天基金估值 / 腾讯行情 / 东方财富），
// 任一源不可用时自动降级，提升整体可用性。

export interface SourceStatus {
  id: string
  label: string
  ok: boolean
  lastCheck: number  // timestamp
  failures: number
  consecutive: number
}

export type SourceId = 'backend' | 'tiantian' | 'eastmoney' | 'tencent'

const STATUS_KEY = 'sinan_source_status'
const SWR_KEY_PREFIX = 'sinan_swr_v2_'

// ── 源状态追踪 ──
function loadStatuses(): Map<string, SourceStatus> {
  try {
    const raw = localStorage.getItem(STATUS_KEY)
    if (!raw) return new Map()
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Map()
    return new Map(arr.map((s: SourceStatus) => [s.id, s]))
  } catch { return new Map() }
}

function saveStatuses(m: Map<string, SourceStatus>): void {
  try { localStorage.setItem(STATUS_KEY, JSON.stringify([...m.values()])) } catch { /* ignore */ }
}

const statuses = loadStatuses()

export function sourceOk(id: SourceId): boolean {
  return statuses.get(id)?.ok !== false
}

export function recordSource(id: SourceId, label: string, ok: boolean): void {
  const s = statuses.get(id) || { id, label, ok: true, lastCheck: 0, failures: 0, consecutive: 0 }
  s.lastCheck = Date.now()
  if (ok) {
    s.ok = true
    s.consecutive = 0
  } else {
    s.failures++
    s.consecutive++
    // 连续失败 ≥ 3 次标记为不可用
    if (s.consecutive >= 3) s.ok = false
  }
  statuses.set(id, s)
  saveStatuses(statuses)
}

export function getSourceSummary(): SourceStatus[] {
  return [...statuses.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** 所有关键源是否都正常 */
export function allSourcesOk(): boolean {
  let allOk = true
  for (const s of statuses.values()) {
    if (!s.ok && s.consecutive >= 3) allOk = false
  }
  return allOk
}

// ── SWR（stale-while-revalidate）缓存 ──
interface CacheEntry<T> { data: T; ts: number }

export function swrGet<T>(key: string, maxAgeMs = Number.POSITIVE_INFINITY): T | null {
  try {
    const raw = localStorage.getItem(SWR_KEY_PREFIX + key)
    if (!raw) return null
    const entry: CacheEntry<T> = JSON.parse(raw)
    if (!Number.isFinite(entry.ts) || Date.now() - entry.ts > maxAgeMs) return null
    return entry.data
  } catch { return null }
}

export function swrSet<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, ts: Date.now() }
    localStorage.setItem(SWR_KEY_PREFIX + key, JSON.stringify(entry))
  } catch { /* quota exceeded */ }
}

/** SWR 包装器：优先返回缓存，同时异步刷新；兜底用缓存 */
export async function withSWR<T>(
  key: string,
  fetcher: () => Promise<T>,
  maxAgeMs = 300_000, // 默认 5 分钟
): Promise<T> {
  const cached = swrGet<T>(key, maxAgeMs)

  try {
    const fresh = await fetcher()
    swrSet(key, fresh)
    return fresh
  } catch (e) {
    if (cached) {
      console.warn(`[resilience] SWR fallback for ${key}`)
      return cached
    }
    throw e // 无缓存时原样抛出
  }
}

// ── 带退避的重试 ──
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelay?: number; onRetry?: (attempt: number, err: Error) => void } = {},
): Promise<T> {
  const { maxRetries = 2, baseDelay = 800, onRetry } = opts
  let lastErr: Error | undefined
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i) + Math.random() * 200
        onRetry?.(i + 1, lastErr)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastErr
}

// ── 初始化：启动时记录后端状态 ──
export async function checkBackend(): Promise<boolean> {
  try {
    const BASE = (import.meta.env.VITE_API_BASE as string) || '/api'
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(5000) })
    const ok = res.ok
    recordSource('backend', '后端 API', ok)
    return ok
  } catch {
    recordSource('backend', '后端 API', false)
    return false
  }
}
