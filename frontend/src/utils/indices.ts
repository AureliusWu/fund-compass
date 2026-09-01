// 指数行情条。浏览器只访问受限 Worker JSON 代理，第三方响应不会
// 再作为脚本在本应用 origin 执行。30s 刷新；失败时仅回退短时新鲜缓存。

import { recordSource } from './resilience'
import { fetchMarketQuotes, type MarketQuote } from './marketQuotes'

export type IndexQuoteStatus = 'fresh' | 'cached' | 'stale' | 'unavailable'

export interface IndexQuote {
  name: string
  price: number | null
  changePct: number | null
  status: IndexQuoteStatus
  sourceTime: string | null
}

interface CachedQuote {
  name: string
  price: number
  changePct: number | null
  sourceTime: string | null
  cachedAt: number
}

interface Cfg { code: string; name: string; gold?: boolean }
const CONFIG: Cfg[] = [
  { code: 'usIXIC', name: '纳斯达克' },
  { code: 'usINX', name: '标普500' },
  { code: 'AU9999', name: '黄金9999', gold: true },
  { code: 'sh000001', name: '上证指数' },
  { code: 'sh000300', name: '沪深300' },
]

const LS = 'sinan_index_cache_v2'
export const INDEX_CACHE_MAX_AGE_MS = 5 * 60 * 1000

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function loadCache(): Map<string, CachedQuote> {
  const out = new Map<string, CachedQuote>()
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || '[]')
    if (!Array.isArray(raw)) return out
    for (const value of raw) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const row = value as Record<string, unknown>
      const name = typeof row.name === 'string' ? row.name : ''
      const price = nullableNumber(row.price)
      const cachedAt = nullableNumber(row.cachedAt)
      if (!CONFIG.some((item) => item.name === name) || price == null || price <= 0
        || cachedAt == null || cachedAt <= 0) continue
      out.set(name, {
        name,
        price,
        changePct: nullableNumber(row.changePct),
        sourceTime: typeof row.sourceTime === 'string' && row.sourceTime.trim()
          ? row.sourceTime.trim()
          : null,
        cachedAt,
      })
    }
  } catch { /* 损坏缓存按空处理 */ }
  return out
}

function saveCache(cache: Map<string, CachedQuote>) {
  try { localStorage.setItem(LS, JSON.stringify([...cache.values()])) } catch { /* 容量满忽略 */ }
}

function cacheState(row: CachedQuote | undefined, now: number): IndexQuoteStatus {
  if (!row) return 'unavailable'
  return now - row.cachedAt <= INDEX_CACHE_MAX_AGE_MS ? 'cached' : 'stale'
}

function fromCache(name: string, row: CachedQuote | undefined, now: number): IndexQuote {
  const status = cacheState(row, now)
  if (row && status === 'cached') {
    return {
      name,
      price: row.price,
      changePct: row.changePct,
      status,
      sourceTime: row.sourceTime,
    }
  }
  return {
    name,
    price: null,
    changePct: null,
    status,
    sourceTime: row?.sourceTime ?? null,
  }
}

type FreshMarketQuote = MarketQuote & { status: 'fresh' }

function isFresh(quote: MarketQuote | undefined): quote is FreshMarketQuote {
  return quote?.status === 'fresh' && Number.isFinite(quote.price) && quote.price > 0
}

// 拉全部行情（指数 + 黄金并行）。上游明确 stale 时隐藏数值；网络失败时
// 只允许使用 5 分钟内的本地缓存，且不会刷新原缓存时间。
export async function getIndices(): Promise<IndexQuote[]> {
  const now = Date.now()
  const cache = loadCache()
  let quotes = new Map<string, MarketQuote>()
  try { quotes = await fetchMarketQuotes(CONFIG.map((item) => item.code)) }
  catch { /* 代理失败时逐项按时间边界回退缓存 */ }

  const tencentOk = CONFIG.some((item) => !item.gold && isFresh(quotes.get(item.code)))
  recordSource('tencent', '腾讯行情', tencentOk)
  recordSource('eastmoney', '东方财富', isFresh(quotes.get('AU9999')))

  let receivedFresh = false
  const out = CONFIG.map((cfg): IndexQuote => {
    const got = quotes.get(cfg.code)
    if (isFresh(got)) {
      receivedFresh = true
      const row: CachedQuote = {
        name: cfg.name,
        price: got.price,
        changePct: got.changePct,
        sourceTime: got.sourceTime,
        cachedAt: now,
      }
      cache.set(cfg.name, row)
      return { ...row, status: 'fresh' }
    }
    if (got?.status === 'stale') {
      return {
        name: cfg.name,
        price: null,
        changePct: null,
        status: 'stale',
        sourceTime: got.sourceTime,
      }
    }
    return fromCache(cfg.name, cache.get(cfg.name), now)
  })

  if (receivedFresh) saveCache(cache)
  return out
}

// 初次渲染仅展示 5 分钟内的缓存；过期缓存保留时间标签但不展示价格。
export function cachedIndices(): IndexQuote[] {
  const now = Date.now()
  const cache = loadCache()
  return CONFIG.map((cfg) => fromCache(cfg.name, cache.get(cfg.name), now))
}
