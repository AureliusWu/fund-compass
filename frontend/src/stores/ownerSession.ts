import { readonly, shallowRef } from 'vue'
import { ApiError, assertOwnerApiTransport, request } from '@/api/request'

export interface OwnerSessionMetadata {
  token_type: 'Bearer'
  expires_at: string
  owner_id: 'owner'
  scopes: string[]
}

interface OwnerLoginResponse extends OwnerSessionMetadata {
  access_token: string
  token_type: 'Bearer'
}

// The credential is deliberately not reactive or serializable store state.
// No persistence, service-worker message, URL parameter or browser cookie.
let accessToken: string | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
const metadata = shallowRef<OwnerSessionMetadata | null>(null)
const generation = shallowRef(0)
const pending = new Set<AbortController>()
const OWNER_SCOPES = ['read_private', 'write_holdings', 'run_personal_analysis']
const MAX_SESSION_TTL_MS = 1_800_000
const CLOCK_TOLERANCE_MS = 30_000
export const ownerSession = readonly(metadata)
export const ownerSessionGeneration = readonly(generation)

export function clearOwnerSession(): void {
  accessToken = null
  metadata.value = null
  if (expiryTimer != null) globalThis.clearTimeout(expiryTimer)
  expiryTimer = null
  for (const controller of pending) controller.abort('owner-session-changed')
  pending.clear()
  // Synchronous watchers clear rendered private payloads before any new request.
  generation.value++
}

function sessionIsActive(): boolean {
  if (accessToken && metadata.value && Date.parse(metadata.value.expires_at) > Date.now()) return true
  if (accessToken || metadata.value) clearOwnerSession()
  return false
}

function scheduleExpiry(): void {
  if (!metadata.value) return
  const remaining = Date.parse(metadata.value.expires_at) - Date.now()
  if (remaining <= 0) { clearOwnerSession(); return }
  expiryTimer = globalThis.setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647))
}

function assertGeneration(expected: number): void {
  if (generation.value !== expected) throw new ApiError('私人会话已变更，请重新登录', 'redacted', 401)
}

function validateMetadata(value: unknown): OwnerSessionMetadata {
  const result = value as OwnerSessionMetadata | null
  if (!result || result.token_type !== 'Bearer' || result.owner_id !== 'owner'
    || typeof result.expires_at !== 'string' || !/(?:Z|\+00:00)$/.test(result.expires_at)
    || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()
    || Date.parse(result.expires_at) > Date.now() + MAX_SESSION_TTL_MS + CLOCK_TOLERANCE_MS
    || !Array.isArray(result.scopes)
    || result.scopes.length !== OWNER_SCOPES.length || new Set(result.scopes).size !== OWNER_SCOPES.length
    || !OWNER_SCOPES.every(scope => result.scopes.includes(scope))) {
    throw new ApiError('私人会话响应契约无效', 'http', 502)
  }
  return { token_type: 'Bearer', expires_at: result.expires_at, owner_id: 'owner', scopes: [...result.scopes] }
}

export async function loginOwnerSession(password: string): Promise<OwnerSessionMetadata> {
  assertOwnerApiTransport()
  clearOwnerSession()
  const expected = generation.value
  const controller = new AbortController()
  pending.add(controller)
  try {
    const result = await request<OwnerLoginResponse>('/v2/owner/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      body: JSON.stringify({ password }),
      signal: controller.signal,
    })
    assertGeneration(expected)
    const sessionMetadata = validateMetadata(result)
    if (!result || result.token_type !== 'Bearer' || typeof result.access_token !== 'string'
      || !/^own_[A-Za-z0-9_-]{43}$/.test(result.access_token) || result.owner_id !== 'owner'
      || Object.keys(result).length !== 5
      || Object.keys(result).some(key => !['access_token', 'token_type', 'expires_at', 'owner_id', 'scopes'].includes(key))) {
      throw new ApiError('私人会话响应契约无效', 'http', 502)
    }
    accessToken = result.access_token
    metadata.value = sessionMetadata
    scheduleExpiry()
    generation.value++
    return { ...sessionMetadata, scopes: [...sessionMetadata.scopes] }
  } finally { pending.delete(controller) }
}

// Explicitly audited read-only routes. Never attach an Owner token to arbitrary
// public routes, an Admin/Worker write endpoint, or a caller-provided external URL.
const OWNER_READ_PATHS = [
  /^\/private\/watchlist$/,
  /^\/private\/operations$/,
  /^\/private\/strategy\/(?:outcomes|portfolio-outcomes|registry|version-comparison)$/,
  /^\/v2\/private\/fund\/\d{6}\/(?:evidence|decision|decision\/diff|outcomes)$/,
  /^\/v2\/private\/portfolio\/policy(?:\/history)?$/,
  /^\/v2\/private\/strategy\/registry$/,
  /^\/v2\/private\/strategy\/[A-Za-z0-9._~%:-]+\/performance$/,
]

async function authenticatedRequest<T>(path: string, init?: RequestInit): Promise<T> {
  assertOwnerApiTransport()
  if (!sessionIsActive()) throw new ApiError('请先登录私人会话', 'redacted', 401)
  const expected = generation.value
  const token = accessToken!
  const controller = new AbortController()
  pending.add(controller)
  try {
    const value = await request<T>(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    assertGeneration(expected)
    if (!sessionIsActive()) throw new ApiError('私人会话已过期', 'redacted', 401)
    return value
  } catch (error) {
    assertGeneration(expected)
    if (error instanceof ApiError && error.status === 401) {
      clearOwnerSession()
      throw new ApiError('私人会话已失效，请重新登录', 'redacted', 401)
    }
    throw error
  } finally { pending.delete(controller) }
}

export function hasOwnerSession(): boolean { return sessionIsActive() }

// Background tabs may throttle timers. Recheck expiry before resumed use.
if (typeof window !== 'undefined') window.addEventListener('focus', () => { sessionIsActive() })
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sessionIsActive()
})

export function requestOwnerRead<T>(path: string): Promise<T> {
  if (!OWNER_READ_PATHS.some(pattern => pattern.test(path))) {
    return Promise.reject(new ApiError('未审计的私人读取路径', 'http', 400))
  }
  return authenticatedRequest<T>(path)
}

export async function getOwnerSessionMetadata(): Promise<OwnerSessionMetadata> {
  const value = await authenticatedRequest<OwnerSessionMetadata>('/v2/owner/session')
  try {
    if (Object.keys(value).length !== 4
      || Object.keys(value).some(key => !['token_type', 'expires_at', 'owner_id', 'scopes'].includes(key))) {
      throw new ApiError('私人会话元数据契约无效', 'http', 502)
    }
    return validateMetadata(value)
  } catch (error) {
    clearOwnerSession()
    if (error instanceof ApiError) throw error
    throw new ApiError('私人会话元数据契约无效', 'http', 502)
  }
}

export async function logoutOwnerSession(): Promise<void> {
  const token = accessToken
  clearOwnerSession() // Local privacy must not depend on a reachable server.
  if (!token) return
  assertOwnerApiTransport()
  try {
    await request<void>('/v2/owner/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
      redirect: 'error',
    })
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error
  }
}
