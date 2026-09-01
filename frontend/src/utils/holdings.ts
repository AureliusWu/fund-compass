// 十大重仓股。浏览器只访问 Worker 的受限 JSON 端点；Worker 负责上游
// code 校验、响应大小和超时边界，页面不再执行第三方 JSONP。

import { fetchMarketQuotes, workerProxyEndpoint } from './marketQuotes'
import { recordSource } from './resilience'

export interface Holding {
  code: string
  name: string
  ratio: number
  change?: number
  reportDate?: string
}

interface CachedHoldings {
  items: Holding[]
  reportDate: string
  cachedAt: number
}

const mem = new Map<string, CachedHoldings>()
const LS = 'sinan_hold_v2_'
const TTL = 12 * 3600 * 1000 // 重仓股季度披露，缓存 12h；涨跌幅每次实时刷新
const MAX_REPORT_AGE_MS = 200 * 24 * 3600 * 1000
const TIMEOUT = 8000

function normalizeReportDate(value: unknown, now = Date.now()): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const parsed = Date.UTC(year, month - 1, day)
  const check = new Date(parsed)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  const current = new Date(now)
  const today = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate())
  const age = today - parsed
  return age >= 0 && age <= MAX_REPORT_AGE_MS ? value : null
}

function normalizeCached(value: unknown, now = Date.now()): CachedHoldings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const cachedAt = typeof raw.cachedAt === 'number' && Number.isFinite(raw.cachedAt) ? raw.cachedAt : null
  const reportDate = normalizeReportDate(raw.reportDate, now)
  if (cachedAt == null || now - cachedAt < 0 || now - cachedAt >= TTL || !reportDate || !Array.isArray(raw.items)) return null
  const items = raw.items.map((row: unknown): Holding | null => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null
    const item = row as Record<string, unknown>
    const normalized = normalizeHoldingRow(item.code, item.name, item.ratio)
    return normalized ? { ...normalized, reportDate } : null
  }).filter((row: Holding | null): row is Holding => row != null)
  return items.length ? { items, reportDate, cachedAt } : null
}

function loadMemory(code: string): CachedHoldings | null {
  const row = mem.get(code)
  const normalized = normalizeCached(row)
  if (!normalized) mem.delete(code)
  return normalized
}

function loadLS(code: string): CachedHoldings | null {
  try {
    return normalizeCached(JSON.parse(localStorage.getItem(LS + code) || 'null'))
  } catch { /* ignore */ }
  return null
}

function saveLS(code: string, value: CachedHoldings) {
  try { localStorage.setItem(LS + code, JSON.stringify(value)) } catch { /* 容量满忽略 */ }
}

export function normalizeHoldingRow(codeValue: unknown, nameValue: unknown, ratioValue: unknown): Holding | null {
  const code = String(codeValue ?? '').trim().toUpperCase()
  const name = String(nameValue ?? '').trim()
  const ratioText = String(ratioValue ?? '').trim().replace('%', '')
  const supportedCode = /^\d{5,6}$/.test(code) || /^[A-Z][A-Z0-9.-]{0,7}$/.test(code)
  if (!supportedCode || !name || !ratioText) return null
  const ratio = Number(ratioText)
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100) return null
  return { code, name, ratio }
}

async function fetchHoldings(code: string): Promise<CachedHoldings> {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const query = new URLSearchParams({ code })
    const response = await fetch(`${workerProxyEndpoint('holdings')}?${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`持仓代理 HTTP ${response.status}`)
    const payload = await response.json() as Record<string, unknown>
    if (String(payload.code || '') !== code || !Array.isArray(payload.items)) {
      throw new Error('持仓代理响应无效')
    }
    const reportDate = normalizeReportDate(payload.report_date)
    if (!reportDate) throw new Error('持仓披露日期缺失、超龄或无效')
    const items = payload.items.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      const row = raw as Record<string, unknown>
      const normalized = normalizeHoldingRow(row.code, row.name, row.ratio)
      return normalized ? [{ ...normalized, reportDate }] : []
    }).slice(0, 10)
    return { items, reportDate, cachedAt: Date.now() }
  } finally {
    globalThis.clearTimeout(timer)
  }
}

function quoteCodeForHolding(holding: Pick<Holding, 'code' | 'name'>): string | null {
  const code = holding.code.toUpperCase()
  if (/^\d{6}$/.test(code)) {
    if (/三星|SK海力士|海力士/i.test(holding.name)) return 'usEWY'
    return `${/^[69]/.test(code) ? 'sh' : 'sz'}${code}`
  }
  if (/^\d{5}$/.test(code)) return `hk${code}`
  if (/^[A-Z][A-Z0-9.-]{0,7}$/.test(code)) return `us${code.replace(/\./g, '-')}`
  return null
}

async function withCurrentChanges(stocks: Holding[]): Promise<Holding[]> {
  const codeByHolding = new Map(stocks.map((holding) => [holding, quoteCodeForHolding(holding)]))
  const quotes = await fetchMarketQuotes(
    [...codeByHolding.values()].filter((code): code is string => code != null),
  )
  return stocks.map((holding) => {
    const quoteCode = codeByHolding.get(holding)
    const change = quoteCode ? quotes.get(quoteCode)?.changePct : null
    return change != null && Number.isFinite(change) ? { ...holding, change } : { ...holding }
  })
}

// 取某基金十大重仓（名称/代码/占比缓存 12h；涨跌幅每次经 Worker 刷新）。
export async function getHoldings(code: string, force = false): Promise<Holding[]> {
  const normalizedCode = String(code || '').trim()
  if (!/^\d{6}$/.test(normalizedCode)) return []

  let cached = !force ? (loadMemory(normalizedCode) || loadLS(normalizedCode)) : null
  let holdingsOk = true
  if (!cached) {
    try {
      cached = await fetchHoldings(normalizedCode)
      holdingsOk = cached.items.length > 0
      if (cached.items.length) {
        mem.set(normalizedCode, cached)
        saveLS(normalizedCode, cached)
      }
    } catch {
      holdingsOk = false
      cached = loadLS(normalizedCode)
    }
  }

  recordSource('eastmoney', '东方财富持仓代理', holdingsOk)
  const list = cached?.items || []
  if (!list.length) return []
  try { return await withCurrentChanges(list) }
  catch { return list.map((holding) => ({ ...holding })) }
}
