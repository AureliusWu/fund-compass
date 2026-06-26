// 轻量本地缓存（localStorage + TTL）。M4 先用它给详情/评分/信号兜底，
// 离线时仍能看到上次数据；后续可换 IndexedDB 存更大的净值序列。
const PREFIX = 'fc_cache_'

export function cacheGet<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const { t, v } = JSON.parse(raw)
    if (Date.now() - t > maxAgeMs) return null
    return v as T
  } catch {
    return null
  }
}

export function cacheSet<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v: value }))
  } catch {
    // 容量满等情况忽略
  }
}
