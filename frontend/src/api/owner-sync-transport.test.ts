import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createOwnerSyncHttpTransport } from './owner-sync-transport'
import {
  clearOwnerSession, hasOwnerSession, loginOwnerSession, ownerSessionGeneration,
} from '@/stores/ownerSession'
import { createOwnerSyncCandidate, type OwnerSyncCandidateTransport } from '@/stores/ownerSyncCandidate'
import { openOwnerSyncOutbox, type OwnerSyncOutbox } from '@/stores/ownerSyncOutbox'
import {
  OWNER_SYNC_MAX_RESPONSE_BYTES, buildOwnerSyncRequest, parseSyncChangesPage,
  parseSyncReceiptResponse, parseSyncWriteResponse, type BuiltOwnerSyncRequest,
} from '@/utils/ownerSyncContract'

const API = 'https://synthetic-owner.example/api'
const TOKEN = 'own_' + 'a'.repeat(43)
const PRIVATE = 'synthetic private data must never be an error message'
const DRAFT = { key: 'asset:synthetic-http', kind: 'manual_asset' as const, deleted: false,
  changes: { name: '合成资产', cls: '现金', value: 0, note: null } }
const handles: OwnerSyncOutbox[] = []

function loginReply(token = TOKEN, expires = Date.now() + 30 * 60_000) {
  return { ok: true, status: 200, json: async () => ({ access_token: token, token_type: 'Bearer',
    owner_id: 'owner', expires_at: new Date(expires).toISOString(),
    scopes: ['read_private', 'write_holdings', 'run_personal_analysis'] }) }
}
function reply(raw: string | Uint8Array = '{}', status = 200, headers: Record<string, string> = {}) {
  return new Response(raw, { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
function changes(upper = 0) {
  return JSON.stringify({ upper_revision: upper, changes: [], next_cursor: null, complete: true })
}
function success() {
  return JSON.stringify({ revision: 1, records: [{ key: DRAFT.key, kind: DRAFT.kind, deleted: false,
    record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: DRAFT.changes }] })
}
async function packet() {
  return buildOwnerSyncRequest({ request_id: 'synthetic-http-0001', expected_revision: 0, operations: [DRAFT] })
}
async function connected() {
  const fetchMock = vi.fn().mockResolvedValueOnce(loginReply())
  vi.stubGlobal('fetch', fetchMock)
  await loginOwnerSession('synthetic-password')
  const transport = await createOwnerSyncHttpTransport()
  return { transport, fetchMock }
}
async function microtasks() { for (let index = 0; index < 80; index++) await Promise.resolve() }

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://synthetic-owner.example' })
  // Synchronous native SHA inside the WebCrypto-shaped boundary makes fake
  // timer races deterministic. No digest is fabricated or fixture-constant.
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (algorithm: string, input: ArrayBuffer) => {
    expect(algorithm).toBe('SHA-256')
    const bytes = createHash('sha256').update(new Uint8Array(input)).digest()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }) } })
})
afterEach(() => {
  clearOwnerSession()
  for (const handle of handles.splice(0)) handle.close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('explicit Owner HTTP sync transport', () => {
  it('constructs only a fixed endpoint fingerprint without fetch, browser storage or a session', async () => {
    const fetchMock = vi.fn(), storage = { getItem: vi.fn(), setItem: vi.fn() }
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage)
    const transport = await createOwnerSyncHttpTransport()
    expect(transport.targetFingerprint).toBe(createHash('sha256').update(API).digest('hex'))
    expect(Object.keys(transport).sort()).toEqual(['changes', 'receipt', 'targetFingerprint', 'write'])
    expect(Object.isFrozen(transport)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
    expect(hasOwnerSession()).toBe(false)
  })

  it('fails closed rather than inventing an origin or digest in headless/unsupported contexts', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('location', undefined)
    await expect(createOwnerSyncHttpTransport()).rejects.toMatchObject({ status: 400 })
    vi.stubGlobal('location', { origin: 'http://unsafe.synthetic.example' })
    await expect(createOwnerSyncHttpTransport()).rejects.toMatchObject({ status: 400 })
    vi.stubGlobal('location', { origin: 'https://synthetic-owner.example' })
    vi.stubGlobal('crypto', undefined)
    await expect(createOwnerSyncHttpTransport()).rejects.toMatchObject({ status: 503 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes the configured origin before computing the endpoint fingerprint', async () => {
    vi.stubGlobal('location', { origin: 'https://SYNTHETIC-OWNER.example:443' })
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    expect((await createOwnerSyncHttpTransport()).targetFingerprint)
      .toBe(createHash('sha256').update(API).digest('hex'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires an Owner session and never uses an Admin/Gist credential fallback', async () => {
    const transport = await createOwnerSyncHttpTransport(), fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(transport.changes({ sinceRevision: 0, limit: 200 }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'redacted', status: 401 })
    await expect(transport.write(await packet(), new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends restored POST bytes exactly once with separate consent and no cookie/cache/redirect path', async () => {
    const { transport, fetchMock } = await connected(), original = await packet(), raw = success()
    fetchMock.mockResolvedValueOnce(reply(raw))
    expect(await transport.write(original, new AbortController().signal)).toEqual({ status: 200, rawBody: raw })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(API + '/v2/owner/sync')
    expect(init).toMatchObject({ method: 'POST', body: original.rawBody, cache: 'no-store',
      credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + TOKEN)
    expect(new Headers(init.headers).get('X-Owner-Sync-Consent')).toBe('owner-sync-v1')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(parseSyncWriteResponse(200, raw).kind).toBe('success')
  })

  it.each(['hash', 'body', 'length', 'request', 'extra', 'getter'])(
    'rejects an untrusted typed packet (%s) before attaching credentials or fetching', async fault => {
      const { transport, fetchMock } = await connected(), original = await packet()
      const forged: Record<string, unknown> = { ...original }
      if (fault === 'hash') forged.requestHash = 'f'.repeat(64)
      if (fault === 'body') forged.rawBody = original.rawBody + ' '
      if (fault === 'length') forged.byteLength = original.byteLength + 1
      if (fault === 'request') forged.request = { ...original.request, expected_revision: 1 }
      if (fault === 'extra') forged.url = 'https://foreign.invalid/api'
      const getter = vi.fn(() => original.rawBody)
      if (fault === 'getter') Object.defineProperty(forged, 'rawBody', { enumerable: true, get: getter })
      await expect(transport.write(forged as unknown as BuiltOwnerSyncRequest, new AbortController().signal))
        .rejects.toMatchObject({ status: 400 })
      expect(getter).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('pins the configured target across construction and refuses a later different origin', async () => {
    const { transport, fetchMock } = await connected()
    vi.stubGlobal('location', { origin: 'https://different-owner.example' })
    await expect(transport.changes({ sinceRevision: 0, limit: 100 }, new AbortController().signal))
      .rejects.toMatchObject({ status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('encodes fixed-upper Unicode cursor queries without putting private keys or hashes in arbitrary paths', async () => {
    const { transport, fetchMock } = await connected(), key = 'asset:合成 / ? & 𐀀'
    fetchMock.mockResolvedValueOnce(reply(changes(9)))
    const parameters = { sinceRevision: 2, upperRevision: 9, cursor: [4, key] as const, limit: 200 }
    const result = await transport.changes(parameters, new AbortController().signal)
    const url = new URL(fetchMock.mock.calls[1][0])
    expect(url.origin + url.pathname).toBe(API + '/v2/owner/sync')
    expect([...url.searchParams]).toEqual([
      ['since_revision', '2'], ['limit', '200'], ['upper_revision', '9'], ['cursor_revision', '4'], ['cursor_key', key],
    ])
    expect(parseSyncChangesPage(result.rawBody, parameters).complete).toBe(true)
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined()
  })

  it.each([
    { sinceRevision: -1, limit: 100 }, { sinceRevision: 0.5, limit: 100 },
    { sinceRevision: Number.MAX_SAFE_INTEGER + 1, limit: 100 }, { sinceRevision: 0, limit: 201 },
    { sinceRevision: 0, limit: 0 }, { sinceRevision: 4, upperRevision: 3, limit: 100 },
    { sinceRevision: 0, cursor: [1, 'asset:ok'], limit: 100 },
    { sinceRevision: 1, upperRevision: 5, cursor: [1, 'asset:ok'], limit: 100 },
    { sinceRevision: 0, upperRevision: 5, cursor: [6, 'asset:ok'], limit: 100 },
    { sinceRevision: 0, upperRevision: 5, cursor: [1, '000001:: untrimmed '], limit: 100 },
    { sinceRevision: 0, upperRevision: 5, cursor: [1, 'asset:bad\nkey'], limit: 100 },
    { sinceRevision: 0, limit: 100, url: 'https://foreign.invalid' },
  ])('rejects malformed query context before any request: %j', async parameters => {
    const { transport, fetchMock } = await connected()
    await expect(transport.changes(parameters as Parameters<OwnerSyncCandidateTransport['changes']>[0], new AbortController().signal))
      .rejects.toMatchObject({ status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([404, 503])('keeps an unavailable receipt (%s) raw and unknown, without a POST retry', async status => {
    const { transport, fetchMock } = await connected(), original = await packet()
    const raw = '{"state":"unknown","error":"sync_result_unknown"}'
    fetchMock.mockResolvedValueOnce(reply(raw, status))
    const result = await transport.receipt(original.request.request_id, original.requestHash, new AbortController().signal)
    expect(result).toEqual({ status, rawBody: raw })
    expect(parseSyncReceiptResponse(result.status, result.rawBody).state).toBe('unknown')
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(API + '/v2/owner/sync/requests/synthetic-http-0001')
    expect(new Headers(init.headers).get('X-Owner-Sync-Request-Hash')).toBe(original.requestHash)
    expect(new URL(url).search).toBe('')
    expect(init.method).toBe('GET'); expect(init.body).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['../private', 'synthetic/id', 'short', 'synthetic-id\n'])(
    'rejects an invalid receipt id (%s) without URL/path escape', async requestId => {
      const { transport, fetchMock } = await connected()
      await expect(transport.receipt(requestId, 'a'.repeat(64), new AbortController().signal))
        .rejects.toMatchObject({ status: 400 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n'])(
    'rejects malformed original receipt hashes without placing them in a URL', async requestHash => {
      const { transport, fetchMock } = await connected()
      await expect(transport.receipt('synthetic-http-0001', requestHash, new AbortController().signal))
        .rejects.toMatchObject({ status: 400 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('returns 409 conflict text byte-for-byte instead of generic non-2xx rejection', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    const raw = '{ "error": {"code":"sync_conflict","message":"同步冲突，请保留本地草稿并重新核对。"},'
      + '"conflicts":[{"key_digest":"' + 'b'.repeat(16) + '","fields":["value"]}] }'
    fetchMock.mockResolvedValueOnce(reply(raw, 409))
    const result = await transport.write(original, new AbortController().signal)
    expect(result).toEqual({ status: 409, rawBody: raw })
    expect(parseSyncWriteResponse(result.status, result.rawBody).kind).toBe('conflict')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['{"revision":1.0,"records":[]}', '{"revision":0,"revision":1,"records":[]}', '\ufeff{"revision":0,"records":[]}'])(
    'preserves lexical numbers/duplicate keys for the existing strict parser: %s', async raw => {
      const { transport, fetchMock } = await connected()
      fetchMock.mockResolvedValueOnce(reply(raw))
      const result = await transport.write(await packet(), new AbortController().signal)
      expect(result.rawBody).toBe(raw)
      expect(() => parseSyncWriteResponse(result.status, result.rawBody)).toThrow()
    },
  )

  it('decodes UTF8 split across chunks without replacing bytes, and never calls response.json/text', async () => {
    const { transport, fetchMock } = await connected(), raw = success(), bytes = new TextEncoder().encode(raw)
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1))
      controller.close()
    } })
    const response = new Response(body, { headers: { 'Content-Type': 'application/json' } })
    const json = vi.spyOn(response, 'json'), text = vi.spyOn(response, 'text')
    fetchMock.mockResolvedValueOnce(response)
    expect((await transport.write(await packet(), new AbortController().signal)).rawBody).toBe(raw)
    expect(json).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled()
  })

  it.each(['utf8', 'mime', 'declared', 'stream'])(
    'bounds and rejects invalid responses (%s) without leaking private text', async fault => {
      const { transport, fetchMock } = await connected()
      let response = reply(PRIVATE)
      if (fault === 'utf8') response = reply(new Uint8Array([0xff]))
      if (fault === 'mime') response = reply(PRIVATE, 200, { 'Content-Type': 'text/html' })
      if (fault === 'declared') response = reply(PRIVATE, 200, { 'Content-Length': String(OWNER_SYNC_MAX_RESPONSE_BYTES + 1) })
      if (fault === 'stream') response = reply(new Uint8Array(OWNER_SYNC_MAX_RESPONSE_BYTES + 1), 200, { 'Content-Length': '0' })
      fetchMock.mockResolvedValueOnce(response)
      const result = transport.write(await packet(), new AbortController().signal)
      await expect(result).rejects.toMatchObject({ status: 502 })
      await expect(result).rejects.not.toThrow(PRIVATE)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it('does not follow redirects, retry server errors or turn them into an empty baseline', async () => {
    const { transport, fetchMock } = await connected()
    const cancellations = [vi.fn(() => new Promise<void>(() => {})), vi.fn(() => new Promise<void>(() => {}))]
    const responses = [307, 500].map((status, index) => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(PRIVATE)) }, cancel: cancellations[index],
    }), { status, headers: { 'Content-Type': 'application/json' } }))
    const readers = responses.map(response => vi.spyOn(response.body!, 'getReader'))
    fetchMock.mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1])
    await expect(transport.changes({ sinceRevision: 0, limit: 100 }, new AbortController().signal))
      .rejects.toMatchObject({ status: 307 })
    await expect(transport.changes({ sinceRevision: 0, limit: 100 }, new AbortController().signal))
      .rejects.toMatchObject({ status: 500 })
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledTimes(1)
    for (const read of readers) expect(read).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a 401 clears the session without reading its body or retrying', async () => {
    const { transport, fetchMock } = await connected(), cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(PRIVATE)) }, cancel,
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    const read = vi.spyOn(response.body!, 'getReader')
    fetchMock.mockResolvedValueOnce(response)
    const before = ownerSessionGeneration.value
    await expect(transport.changes({ sinceRevision: 0, limit: 100 }, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'redacted', status: 401 })
    expect(hasOwnerSession()).toBe(false)
    expect(ownerSessionGeneration.value).toBeGreaterThan(before)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('already-aborted callers do not reach hashing, packet restoration or fetch', async () => {
    const { transport, fetchMock } = await connected(), original = await packet(), controller = new AbortController()
    const digest = vi.mocked(crypto.subtle.digest), before = digest.mock.calls.length
    controller.abort()
    await expect(transport.write(original, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' })
    expect(digest).toHaveBeenCalledTimes(before); expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('forwards external cancellation and rejects a late fetch without clearing the active session', async () => {
    const { transport, fetchMock } = await connected(), controller = new AbortController()
    let finish!: (value: Response) => void, active: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_url, init) => { active = init.signal; return new Promise(resolve => { finish = resolve }) })
    const pending = transport.changes({ sinceRevision: 0, limit: 100 }, controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    await microtasks(); expect(fetchMock).toHaveBeenCalledTimes(2)
    controller.abort(); expect(active?.aborted).toBe(true)
    finish(reply(changes())); await assertion
    expect(hasOwnerSession()).toBe(true)
  })

  it('logout rejects a late body and cancels local reading without discarding the request outcome as rollback', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel })
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    const pending = transport.write(original, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'redacted', status: 401 })
    await microtasks(); expect(fetchMock).toHaveBeenCalledTimes(2)
    clearOwnerSession(); await assertion
    expect(cancel).toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an old 401 after new login cannot revoke the newer session', async () => {
    const { transport, fetchMock } = await connected()
    let finish!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(loginReply('own_' + 'b'.repeat(43)))
    const old = transport.changes({ sinceRevision: 0, limit: 100 }, new AbortController().signal)
    const assertion = expect(old).rejects.toMatchObject({ status: 401 })
    await microtasks(); await loginOwnerSession('synthetic-new-password')
    finish(reply(PRIVATE, 401)); await assertion
    expect(hasOwnerSession()).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('session expiry aborts a pending sync before a late result can become visible', async () => {
    vi.useFakeTimers()
    let finish!: (value: Response) => void
    const fetchMock = vi.fn().mockResolvedValueOnce(loginReply(TOKEN, Date.now() + 100))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    await loginOwnerSession('synthetic-password')
    const transport = await createOwnerSyncHttpTransport()
    const pending = transport.changes({ sinceRevision: 0, limit: 100 }, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'redacted', status: 401 })
    await microtasks(); expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100); await assertion
    finish(reply(changes())); await microtasks()
    expect(hasOwnerSession()).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('the one 12-second deadline includes packet hashing and prevents a late POST', async () => {
    vi.useFakeTimers()
    const { transport, fetchMock } = await connected(), original = await packet()
    const digest = vi.mocked(crypto.subtle.digest), actual = digest.getMockImplementation()!
    let finish!: (value: ArrayBuffer) => void
    digest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = transport.write(original, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await microtasks(); await vi.advanceTimersByTimeAsync(12_000); await assertion
    finish(await actual('SHA-256', new TextEncoder().encode(original.rawBody)))
    await microtasks(); expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the same deadline covers body reading even when stream cancellation never finishes', async () => {
    vi.useFakeTimers()
    const { transport, fetchMock } = await connected()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'Content-Type': 'application/json' },
    }))
    const pending = transport.changes({ sinceRevision: 0, limit: 100 }, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await microtasks(); expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(12_000); await assertion
    expect(cancel).toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('works with the existing disabled-by-default controller without making a confirmed holding version', async () => {
    const { transport, fetchMock } = await connected()
    const outbox = await openOwnerSyncOutbox(new IDBFactory(), transport.targetFingerprint); handles.push(outbox)
    const candidate = createOwnerSyncCandidate({ outbox, transport,
      session: () => ({ authenticated: hasOwnerSession(), generation: ownerSessionGeneration.value }) })
    expect(candidate.status().state).toBe('disabled')
    await expect(candidate.pullBaseline()).rejects.toMatchObject({ code: 'sync_disabled' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    candidate.setCloudConsent(true)
    fetchMock.mockResolvedValueOnce(reply(changes())).mockResolvedValueOnce(reply(success()))
    await candidate.pullBaseline(); await candidate.prepare('synthetic-http-0001', [DRAFT])
    expect((await candidate.sendPrepared()).state).toBe('confirmed')
    expect(candidate.status()).toMatchObject({ latestObservedHead: 1, lastCompletePulledRevision: 0, baselineReady: false })
    expect(candidate.getLastResult()).not.toHaveProperty('holding_version')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
