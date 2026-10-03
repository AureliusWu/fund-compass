// All API calls share one deadline, including response-body parsing.
const BASE = (import.meta.env.VITE_API_BASE as string) || '/api'
const REQUEST_TIMEOUT_MS = 12_000

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network' | 'http' | 'redacted' | 'cancelled',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function assertOwnerApiTransport(): void {
  // Node unit tests run in Vite's development environment with synthetic data.
  // Real browser sessions must use HTTPS, except local development loopback.
  if (typeof window === 'undefined' && import.meta.env.DEV && BASE === '/api') return
  try {
    const url = typeof window !== 'undefined' ? new URL(BASE, window.location.origin) : new URL(BASE)
    const localDevelopment = import.meta.env.DEV && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !localDevelopment) || url.username || url.password
      || url.search || url.hash || !url.pathname.endsWith('/api')) throw new Error('unsafe')
  } catch {
    throw new ApiError('私人会话需要安全的 API 地址', 'http', 400)
  }
}

export async function fetchWithDeadline<T>(
  url: string,
  init?: RequestInit,
  decode: (response: Response, signal: AbortSignal) => Promise<T> = response => response.json() as Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort(init?.signal?.reason)
  if (init?.signal?.aborted) forwardAbort()
  else init?.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort('timeout')
  }, timeoutMs)
  const ensureActive = () => {
    if (controller.signal.aborted) {
      throw new ApiError(timedOut ? '请求超时，请稍后重试' : '请求已取消', timedOut ? 'timeout' : 'cancelled')
    }
  }
  let rejectOnAbort: (() => void) | undefined

  try {
    ensureActive()
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(new ApiError(timedOut ? '请求超时，请稍后重试' : '请求已取消', timedOut ? 'timeout' : 'cancelled'))
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
    })
    const res = await Promise.race([
      fetch(url, { ...init, signal: controller.signal }), cancelled,
    ])
    ensureActive()
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, 'http', res.status)
    const payload: T = await Promise.race([decode(res, controller.signal), cancelled])
    ensureActive()
    return payload
  } catch (error) {
    if (error instanceof ApiError) throw error
    ensureActive()
    throw new ApiError('网络连接失败，请稍后重试', 'network')
  } finally {
    globalThis.clearTimeout(timer)
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
    init?.signal?.removeEventListener('abort', forwardAbort)
  }
}

export function requestJson<T>(url: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return fetchWithDeadline<T>(url, init, async response => {
    if (response.status === 204 || response.status === 205) return undefined as T
    return response.json() as Promise<T>
  }, timeoutMs)
}

export function request<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return requestJson<T>(BASE + path, { ...init, cache: 'no-store' }, timeoutMs)
}
