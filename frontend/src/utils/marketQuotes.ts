const DEFAULT_ESTIMATE_PROXY = 'https://sinan-estimate-push.ligugu69.workers.dev/estimates'
const DEFAULT_TIMEOUT_MS = 8000
const MAX_CODES = 50

export interface MarketQuote {
  code: string
  price: number
  changePct: number | null
  sourceTime: string | null
  source: string | null
  status: string | null
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

function strictNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Build sibling public Worker endpoints without accepting an upstream URL from
 * page data. Deployments with split proxies can override each endpoint via a
 * VITE_* variable at build time. */
export function workerProxyEndpoint(path: 'quotes' | 'holdings'): string {
  const configured = path === 'quotes'
    ? (import.meta.env.VITE_MARKET_QUOTE_PROXY as string | undefined)
    : (import.meta.env.VITE_HOLDINGS_PROXY as string | undefined)
  if (configured?.trim()) return configured.trim().replace(/\/+$/, '')

  const estimates = ((import.meta.env.VITE_ESTIMATE_PROXY as string | undefined) || DEFAULT_ESTIMATE_PROXY)
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
  return /\/estimates$/.test(estimates)
    ? estimates.replace(/\/estimates$/, `/${path}`)
    : `${estimates}/${path}`
}

export function normalizeMarketQuoteCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === 'AU9999') return text
  const match = /^(sh|sz)(\d{6})$/i.exec(text)
    || /^(hk)(\d{5})$/i.exec(text)
    || /^(us)([A-Z0-9][A-Z0-9-]{0,7})$/i.exec(text)
  if (!match) return null
  return `${match[1].toLowerCase()}${match[2].toUpperCase()}`
}

export async function fetchMarketQuotes(
  codes: Iterable<string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Map<string, MarketQuote>> {
  const requested = [...new Set([...codes].map(normalizeMarketQuoteCode).filter(
    (code): code is string => code != null,
  ))].slice(0, MAX_CODES)
  if (!requested.length) return new Map()

  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const query = new URLSearchParams({ codes: requested.join(',') })
    const response = await fetch(`${workerProxyEndpoint('quotes')}?${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`行情代理 HTTP ${response.status}`)
    const payload = await response.json() as Record<string, unknown>
    if (!Array.isArray(payload.items)) throw new Error('行情代理响应无效')

    const allowed = new Set(requested)
    const out = new Map<string, MarketQuote>()
    for (const raw of payload.items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      const code = normalizeMarketQuoteCode(row.code)
      const price = strictNumber(row.price)
      const status = cleanText(row.status)
      const changePct = status === 'stale' || row.change_pct == null
        ? null
        : strictNumber(row.change_pct)
      if (!code || !allowed.has(code) || price == null || price <= 0
        || (status !== 'fresh' && status !== 'stale')) continue
      // A malformed numeric change is missing, never zero. Legitimate 0 remains 0.
      out.set(code, {
        code,
        price,
        changePct,
        sourceTime: cleanText(row.source_time),
        source: cleanText(row.source),
        status,
      })
    }
    return out
  } finally {
    globalThis.clearTimeout(timer)
  }
}
