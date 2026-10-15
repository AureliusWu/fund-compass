import { readonly, shallowRef } from 'vue'
import { ApiError, assertOwnerApiTransport, ownerApiTarget, request, withRequestDeadline } from '@/api/request'
import type { BuiltOwnerSyncRequest, OwnerSyncCursor } from '@/utils/ownerSyncContract'

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

export interface OwnerSyncHttpResponse { readonly status: number; readonly rawBody: string }
export type OwnerSyncHttpOperation =
  | { readonly kind: 'write'; readonly packet: BuiltOwnerSyncRequest }
  | { readonly kind: 'receipt'; readonly requestId: string; readonly requestHash: string }
  | { readonly kind: 'changes'; readonly parameters: {
    readonly sinceRevision: number; readonly upperRevision?: number
    readonly cursor?: OwnerSyncCursor; readonly limit: number
  } }

interface SyncHttpRequest {
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly scope: 'read_private' | 'write_holdings'
  readonly headers: Readonly<Record<string, string>>
  readonly statuses: readonly number[]
  readonly body?: string
}

// Keep the dormant sync parser out of ordinary session/page chunks. The wire
// contract also caps responses at 2 MiB; this independent transport ceiling
// bounds bytes before any strict parser receives them.
const SYNC_RESPONSE_MAX_BYTES = 2 * 1024 * 1024
function syncHash(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value) }
function invalidSyncRequest(): never { throw new ApiError('同步请求契约无效', 'http', 400) }

function syncObject(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalidSyncRequest()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string')
    || Object.values(descriptors).some(value => !value.enumerable || !('value' in value))
    || Object.keys(descriptors).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))) return invalidSyncRequest()
  const values: Record<string, unknown> = Object.create(null)
  for (const [key, descriptor] of Object.entries(descriptors)) values[key] = descriptor.value
  return values
}

function syncRevision(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalidSyncRequest()
  return value
}

function syncChangesPath(input: unknown, normalizeKey: (kind: 'manual_asset' | 'watch', value: unknown) => string): string {
  const values = syncObject(input, ['sinceRevision', 'limit'], ['upperRevision', 'cursor'])
  const since = syncRevision(values.sinceRevision), limit = syncRevision(values.limit, 1)
  const upper = 'upperRevision' in values ? syncRevision(values.upperRevision) : undefined
  if (limit > 200 || (upper !== undefined && upper < since)) return invalidSyncRequest()
  const query = new URLSearchParams({ since_revision: String(since), limit: String(limit) })
  if (upper !== undefined) query.set('upper_revision', String(upper))
  if ('cursor' in values) {
    const cursor = values.cursor
    if (!Array.isArray(cursor) || cursor.length !== 2 || Reflect.ownKeys(cursor).length !== 3
      || Object.keys(cursor).length !== 2 || Object.keys(cursor).some((key, index) => key !== String(index))
      || Object.values(Object.getOwnPropertyDescriptors(cursor)).some(value => !('value' in value))) return invalidSyncRequest()
    const revision = syncRevision(cursor[0], 1), key: unknown = cursor[1]
    // Reuse the strict contract's canonical Unicode key rule, not locale or
    // URL-decoded path input. Cursor ordering remains the page parser's job.
    if (typeof key !== 'string' || key !== normalizeKey(key.startsWith('asset:') ? 'manual_asset' : 'watch', key)
      || upper === undefined || revision <= since || revision > upper) return invalidSyncRequest()
    query.set('cursor_revision', String(revision)); query.set('cursor_key', key)
  }
  return '/v2/owner/sync?' + query.toString()
}

async function syncHttpRequest(input: unknown, ensureActive: () => void): Promise<SyncHttpRequest> {
  try {
    const operation = syncObject(input, ['kind'], ['packet', 'requestId', 'requestHash', 'parameters'])
    if (!['write', 'receipt', 'changes'].includes(operation.kind as string)) return invalidSyncRequest()
    // The import, original-packet SHA restoration and canonical reconstruction
    // all run inside requestOwnerSync's existing single total deadline.
    const { buildOwnerSyncRequest, restoreOwnerSyncRequest, normalizeOwnerSyncKey } = await import('@/utils/ownerSyncContract')
    ensureActive()
    if (operation.kind === 'write') {
      syncObject(operation, ['kind', 'packet'])
      const packet = syncObject(operation.packet, ['request', 'rawBody', 'requestHash', 'byteLength'])
      if (typeof packet.rawBody !== 'string' || !syncHash(packet.requestHash)) return invalidSyncRequest()
      const original = await restoreOwnerSyncRequest(packet.rawBody, packet.requestHash)
      ensureActive()
      if (packet.byteLength !== original.byteLength) return invalidSyncRequest()
      // Canonical construction, not JSON.stringify object insertion order,
      // binds the public DTO to the restored original bytes as well.
      const supplied = await buildOwnerSyncRequest(packet.request)
      ensureActive()
      if (supplied.rawBody !== original.rawBody || supplied.requestHash !== original.requestHash) return invalidSyncRequest()
      return { path: '/v2/owner/sync', method: 'POST', scope: 'write_holdings',
        headers: { 'Content-Type': 'application/json', 'X-Owner-Sync-Consent': 'owner-sync-v1' },
        statuses: [200, 400, 403, 408, 409, 413, 415, 422, 429, 503], body: original.rawBody }
    }
    if (operation.kind === 'receipt') {
      syncObject(operation, ['kind', 'requestId', 'requestHash'])
      if (typeof operation.requestId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/.test(operation.requestId)
        || !syncHash(operation.requestHash)) return invalidSyncRequest()
      return { path: '/v2/owner/sync/requests/' + encodeURIComponent(operation.requestId),
        method: 'GET', scope: 'read_private', headers: { 'X-Owner-Sync-Request-Hash': operation.requestHash },
        statuses: [200, 404, 503] }
    }
    if (operation.kind === 'changes') {
      syncObject(operation, ['kind', 'parameters'])
      return { path: syncChangesPath(operation.parameters, normalizeOwnerSyncKey), method: 'GET', scope: 'read_private',
        headers: {}, statuses: [200] }
    }
    return invalidSyncRequest()
  } catch (error) {
    if (error instanceof ApiError) throw error
    return invalidSyncRequest()
  }
}

async function syncTargetDigest(target: string, ensureActive: () => void): Promise<string> {
  try {
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(target))
    ensureActive()
    const digest = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
    if (!syncHash(digest)) throw new Error('invalid_digest')
    return digest
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('同步目标校验不可用', 'http', 503)
  }
}

/** Endpoint identity only, not database identity, storage readiness or consent. */
export function getOwnerSyncTargetFingerprint(): Promise<string> {
  return withRequestDeadline(async (_signal, ensureActive) => {
    const target = ownerApiTarget()
    const digest = await syncTargetDigest(target, ensureActive)
    if (ownerApiTarget() !== target) return invalidSyncRequest()
    return digest
  })
}

async function readSyncBody(response: Response, signal: AbortSignal, ensureActive: () => void): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new ApiError('同步响应契约无效', 'http', 502)
  let completed = false, cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    try { void reader.cancel().catch(() => {}) } catch { /* Failure remains unavailable. */ }
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    ensureActive()
    const length = response.headers.get('content-length')
    if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length)
      || length.length > 10 || Number(length) > SYNC_RESPONSE_MAX_BYTES)) throw new Error('response_limit')
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      throw new Error('response_type')
    }
    // Preserve a BOM as data so the strict JSON grammar can reject it; never
    // silently replace malformed UTF-8 or reserialize numeric JSON tokens.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const parts: string[] = []
    let total = 0, chunks = 0
    for (;;) {
      ensureActive()
      const next = await reader.read()
      ensureActive()
      if (next.done) break
      if (!(next.value instanceof Uint8Array) || ++chunks > 32_768) throw new Error('response_type')
      total += next.value.byteLength
      if (total > SYNC_RESPONSE_MAX_BYTES) throw new Error('response_limit')
      parts.push(decoder.decode(next.value, { stream: true }))
    }
    parts.push(decoder.decode())
    ensureActive()
    const raw = parts.join('')
    ensureActive()
    completed = true
    return raw
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('同步响应契约无效', 'http', 502)
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!completed) cancel()
    try { reader.releaseLock() } catch {
      if (completed) throw new ApiError('同步响应契约无效', 'http', 502)
    }
  }
}

/** Fixed sync operations only. The caller must obtain explicit sync consent;
 * this function neither enables a candidate nor exposes the in-memory token. */
export async function requestOwnerSync(operation: OwnerSyncHttpOperation, signal: AbortSignal,
  expectedTargetFingerprint: string): Promise<OwnerSyncHttpResponse> {
  if (!(signal instanceof AbortSignal)) return invalidSyncRequest()
  assertOwnerApiTransport()
  if (!sessionIsActive()) throw new ApiError('请先登录私人会话', 'redacted', 401)
  const expected = generation.value
  const controller = new AbortController()
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  pending.add(controller)
  try {
    return await withRequestDeadline(async (active, ensureActive) => {
      const input = await syncHttpRequest(operation, ensureActive)
      ensureActive()
      const target = ownerApiTarget()
      if (!syncHash(expectedTargetFingerprint)
        || await syncTargetDigest(target, ensureActive) !== expectedTargetFingerprint) return invalidSyncRequest()
      ensureActive()
      assertGeneration(expected)
      if (!sessionIsActive()) throw new ApiError('私人会话已过期', 'redacted', 401)
      if (!metadata.value!.scopes.includes(input.scope)) throw new ApiError('私人会话无权同步', 'redacted', 403)
      if (ownerApiTarget() !== target) return invalidSyncRequest()
      // No arbitrary URL, method or headers cross this boundary. POST keeps
      // the exact restored body; there is no retry or automatic reconciliation.
      const response = await fetch(target + input.path, {
        method: input.method, headers: { ...input.headers, Authorization: `Bearer ${accessToken!}` },
        ...(input.body === undefined ? {} : { body: input.body }), signal: active,
        cache: 'no-store', credentials: 'omit', redirect: 'error',
      })
      try {
        ensureActive()
        assertGeneration(expected)
        if (!sessionIsActive()) throw new ApiError('私人会话已过期', 'redacted', 401)
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
          throw new ApiError('同步响应契约无效', 'http', 502)
        }
        if (response.status === 401) throw new ApiError('私人会话已失效，请重新登录', 'redacted', 401)
        if (!input.statuses.includes(response.status)) throw new ApiError(`HTTP ${response.status}`, 'http', response.status)
        const rawBody = await readSyncBody(response, active, ensureActive)
        ensureActive()
        assertGeneration(expected)
        if (!sessionIsActive()) throw new ApiError('私人会话已过期', 'redacted', 401)
        return Object.freeze({ status: response.status, rawBody })
      } catch (error) {
        // Includes rejected HTTP statuses and late fetch completions, before
        // a reader exists. Cancel local body delivery without reading private
        // error text, waiting on cleanup, changing the error or issuing HTTP.
        try { void response.body?.cancel().catch(() => {}) } catch { /* A locked/failed body stays unavailable. */ }
        throw error
      }
    }, controller.signal)
  } catch (error) {
    assertGeneration(expected)
    if (error instanceof ApiError && error.status === 401) {
      clearOwnerSession()
      throw new ApiError('私人会话已失效，请重新登录', 'redacted', 401)
    }
    throw error
  } finally {
    pending.delete(controller)
    signal.removeEventListener('abort', forward)
  }
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
