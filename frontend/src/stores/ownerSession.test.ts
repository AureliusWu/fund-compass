import { afterEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import {
  clearOwnerSession, getOwnerSessionMetadata, hasOwnerSession, loginOwnerSession,
  logoutOwnerSession, ownerSession, ownerSessionGeneration, requestOwnerRead,
} from './ownerSession'
const SYNTHETIC_TOKEN = 'own_' + 'a'.repeat(43)

function loginResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: SYNTHETIC_TOKEN, token_type: 'Bearer', owner_id: 'owner',
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    scopes: ['read_private', 'write_holdings', 'run_personal_analysis'], ...overrides,
  }
}
function response(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload }
}

afterEach(() => {
  clearOwnerSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('in-memory Owner session', () => {
  it('exposes only metadata and never persists credentials in browser stores', async () => {
    const write = vi.fn()
    vi.stubGlobal('localStorage', { setItem: write })
    vi.stubGlobal('sessionStorage', { setItem: write })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(loginResponse())))
    const metadata = await loginOwnerSession('synthetic-password')
    expect(metadata.owner_id).toBe('owner')
    expect(metadata).not.toHaveProperty('access_token')
    expect(ownerSession.value).not.toHaveProperty('access_token')
    metadata.scopes.length = 0
    metadata.expires_at = new Date(Date.now() - 1).toISOString()
    expect(ownerSession.value?.scopes).toHaveLength(3)
    expect(hasOwnerSession()).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('fails closed for invalid, expired or missing-scope login responses', async () => {
    for (const invalid of [
      { access_token: '' }, { token_type: 'Cookie' }, { owner_id: 'other' },
      { access_token: 'not-an-owner-token' }, { access_token: 'own_' + 'a'.repeat(257) },
      { expires_at: 'not-a-date' }, { expires_at: new Date(Date.now() - 1).toISOString() },
      { expires_at: new Date(Date.now() + 60 * 60_000).toISOString() },
      { scopes: ['read_private'] }, { scopes: ['read_private', 'read_private', 'write_holdings'] },
      { scopes: ['read_private', 'write_holdings', 'admin'] }, { extra_credential: 'synthetic' },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(loginResponse(invalid))))
      await expect(loginOwnerSession('synthetic-password')).rejects.toMatchObject({ status: 502 })
      expect(hasOwnerSession()).toBe(false)
    }
  })

  it('expires proactively and notifies rendered-payload consumers synchronously', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(loginResponse({ expires_at: new Date(Date.now() + 100).toISOString() }))))
    await loginOwnerSession('synthetic-password')
    let displayedPrivatePayload: unknown = { holding: 'synthetic' }
    const stop = watch(ownerSessionGeneration, () => { displayedPrivatePayload = null }, { flush: 'sync' })
    await vi.advanceTimersByTimeAsync(100)
    expect(ownerSession.value).toBeNull()
    expect(displayedPrivatePayload).toBeNull()
    stop()
  })

  it('rejects non-audited paths before sending any Owner token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(loginResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await loginOwnerSession('synthetic-password')
    for (const path of ['/health', '/v2/outcomes/settle', '/portfolio/lab', 'https://other.example/api/private/watchlist', '/v2/private/fund/510300/decision?force=true']) {
      await expect(requestOwnerRead(path)).rejects.toMatchObject({ status: 400 })
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects same-origin HTTP outside local development before submitting the password', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://fund.example' } })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(loginOwnerSession('synthetic-password')).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('allows HTTPS same-origin API transport', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://fund.example' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(loginResponse())))
    await expect(loginOwnerSession('synthetic-password')).resolves.toMatchObject({ owner_id: 'owner' })
    vi.unstubAllGlobals()
  })

  it('clears local private state before awaiting server logout and accepts 204', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(loginResponse()))
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    await loginOwnerSession('synthetic-password')
    const before = ownerSessionGeneration.value
    const pendingLogout = logoutOwnerSession()
    expect(ownerSession.value).toBeNull()
    expect(ownerSessionGeneration.value).toBeGreaterThan(before)
    await expect(pendingLogout).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE', cache: 'no-store' })
  })

  it('does not keep a session when server logout fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(loginResponse()))
      .mockRejectedValueOnce(new Error('offline')))
    await loginOwnerSession('synthetic-password')
    await expect(logoutOwnerSession()).rejects.toMatchObject({ kind: 'network' })
    expect(ownerSession.value).toBeNull()
  })

  it('clears revoked sessions on authenticated 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(loginResponse()))
      .mockResolvedValueOnce({ ok: false, status: 401 }))
    await loginOwnerSession('synthetic-password')
    await expect(requestOwnerRead('/private/watchlist')).rejects.toMatchObject({ kind: 'redacted', status: 401 })
    expect(ownerSession.value).toBeNull()
  })

  it('aborts private requests and rejects even a fetch that ignores the abort', async () => {
    let resolveRead!: (value: unknown) => void
    let readSignal: AbortSignal | undefined
    const fetchMock = vi.fn().mockResolvedValueOnce(response(loginResponse()))
      .mockImplementationOnce((_url, init) => {
        readSignal = init.signal
        return new Promise(resolve => { resolveRead = resolve })
      })
    vi.stubGlobal('fetch', fetchMock)
    await loginOwnerSession('synthetic-password')
    const pendingRead = requestOwnerRead('/private/watchlist')
    const assertion = expect(pendingRead).rejects.toMatchObject({ kind: 'redacted', status: 401 })
    clearOwnerSession()
    expect(readSignal?.aborted).toBe(true)
    resolveRead(response({ items: [{ shares: 12 }] }))
    await assertion
  })

  it('does not restore a late login response after the user cancelled the session', async () => {
    let finishLogin!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(resolve => { finishLogin = resolve })))
    const pendingLogin = loginOwnerSession('synthetic-password')
    const assertion = expect(pendingLogin).rejects.toMatchObject({ kind: 'cancelled' })
    clearOwnerSession()
    finishLogin(response(loginResponse()))
    await assertion
    expect(ownerSession.value).toBeNull()
  })

  it('does not let a late old-session failure clear a newly authenticated session', async () => {
    let finishOldRead!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(loginResponse()))
      .mockImplementationOnce(() => new Promise(resolve => { finishOldRead = resolve }))
      .mockResolvedValueOnce(response(loginResponse({ access_token: 'own_' + 'b'.repeat(43) }))))
    await loginOwnerSession('synthetic-password')
    const oldRead = requestOwnerRead('/private/watchlist')
    const assertion = expect(oldRead).rejects.toMatchObject({ kind: 'redacted' })
    await loginOwnerSession('synthetic-new-password')
    finishOldRead({ ok: false, status: 401 })
    await assertion
    expect(hasOwnerSession()).toBe(true)
  })

  it('gets session metadata only through the explicitly authenticated endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(loginResponse()))
      .mockResolvedValueOnce(response({
        token_type: 'Bearer', owner_id: 'owner', expires_at: loginResponse().expires_at,
        scopes: ['read_private', 'write_holdings', 'run_personal_analysis'],
      }))
    vi.stubGlobal('fetch', fetchMock)
    await loginOwnerSession('synthetic-password')
    expect(await getOwnerSessionMetadata()).not.toHaveProperty('access_token')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v2/owner/session')
  })

  it('rejects an inspect response that improperly includes a bearer credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(loginResponse()))
      .mockResolvedValueOnce(response(loginResponse())))
    await loginOwnerSession('synthetic-password')
    await expect(getOwnerSessionMetadata()).rejects.toMatchObject({ status: 502 })
    expect(hasOwnerSession()).toBe(false)
  })
})
