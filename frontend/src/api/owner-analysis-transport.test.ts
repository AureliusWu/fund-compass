import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRaw } from 'vue'
import { createOwnerAnalysisHttpTransport } from './owner-analysis-transport'
import { clearOwnerSession, hasOwnerSession, loginOwnerSession, ownerSession, ownerSessionGeneration,
  requestOwnerAnalysis, requestOwnerRead, requestOwnerSync, type OwnerAnalysisHttpOperation } from '@/stores/ownerSession'
import { buildOwnerAnalysisRequest, restoreOwnerAnalysisRequest, type BuiltOwnerAnalysisRequest } from '@/utils/ownerAnalysisContract'
import * as contract from '@/utils/ownerAnalysisContract'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'

const API = 'https://synthetic-owner.example/api'
const TOKEN = 'own_' + 'a'.repeat(43)
const PRIVATE = 'synthetic private error text must never escape'
const UNKNOWN = '{"state":"unknown","error":"analysis_result_unknown"}'
const FAILURE = '{"detail":"analysis_result_unknown"}'
const MAX_RESPONSE = 2 * 1024 * 1024 + 4096

function loginReply(token = TOKEN, expires = Date.now() + 30 * 60_000) {
  return { ok: true, status: 200, json: async () => ({ access_token: token, token_type: 'Bearer',
    owner_id: 'owner', expires_at: new Date(expires).toISOString(),
    scopes: ['read_private', 'write_holdings', 'run_personal_analysis'] }) }
}
function reply(raw: string | Uint8Array = FAILURE, status = 503, headers: Record<string, string> = {}) {
  return new Response(raw, { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
function packet() {
  return buildOwnerAnalysisRequest({ request_id: 'synthetic-analysis-0001', expected_revision: 1,
    policy_version: 'pol_' + 'a'.repeat(64), evidence: [{ code: '510300', evidence_id: 'ev_' + 'b'.repeat(64) }] })
}
async function connected() {
  const fetchMock = vi.fn().mockResolvedValueOnce(loginReply())
  vi.stubGlobal('fetch', fetchMock)
  await loginOwnerSession('synthetic-password')
  return { fetchMock, transport: await createOwnerAnalysisHttpTransport() }
}
async function microtasks() { for (let index = 0; index < 100; index++) await Promise.resolve() }

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://synthetic-owner.example' })
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (algorithm: string, input: ArrayBuffer) => {
    expect(algorithm).toBe('SHA-256')
    const bytes = createHash('sha256').update(new Uint8Array(input)).digest()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }) } })
})
afterEach(() => { clearOwnerSession(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('closed Owner analysis HTTP transport', () => {
  it('constructs only endpoint identity with no storage, session or network operation', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() }, fetchMock = vi.fn()
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage); vi.stubGlobal('fetch', fetchMock)
    const transport = await createOwnerAnalysisHttpTransport()
    expect(transport.targetFingerprint).toBe(createHash('sha256').update(API).digest('hex'))
    expect(Object.keys(transport).sort()).toEqual(['evidence', 'policy', 'receipt', 'targetFingerprint', 'write'])
    expect(Object.isFrozen(transport)).toBe(true)
    expect(hasOwnerSession()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled(); expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('requires a session and keeps old read/sync allowlists closed', async () => {
    const transport = await createOwnerAnalysisHttpTransport(), original = await packet()
    vi.stubGlobal('fetch', vi.fn())
    await expect(transport.write(original, new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    await expect(transport.policy(new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    await expect(requestOwnerRead('/v2/owner/analysis')).rejects.toMatchObject({ status: 400 })
    const { fetchMock } = await connected()
    await expect(requestOwnerSync({ kind: 'analysis', packet: original } as never,
      new AbortController().signal, transport.targetFingerprint)).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends exactly the restored bytes once with separate consent and returns a strictly checked fixed failure', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    fetchMock.mockResolvedValueOnce(reply())
    expect(await transport.write(original, new AbortController().signal)).toEqual({ status: 503, rawBody: FAILURE })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(API + '/v2/owner/analysis')
    expect(init).toMatchObject({ method: 'POST', body: original.rawBody, cache: 'no-store', credentials: 'omit',
      redirect: 'error', signal: expect.any(AbortSignal) })
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + TOKEN)
    expect(new Headers(init.headers).get('X-Owner-Analysis-Consent')).toBe('owner-analysis-v1')
    expect(new Headers(init.headers).get('X-Owner-Sync-Consent')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('accepts an actual backend run and matching original receipt, plus explicit read-only policy and evidence', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T06:00:00Z'))
    const { transport, fetchMock } = await connected(), fixture = ownerAnalysisBackendFixture()
    const original = await restoreOwnerAnalysisRequest(fixture.rawBody, fixture.requestHash)
    const receipt = JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(fixture.response) })
    fetchMock.mockResolvedValueOnce(reply(fixture.response, 200)).mockResolvedValueOnce(reply(receipt, 200))
      .mockResolvedValueOnce(reply(fixture.policy, 200)).mockResolvedValueOnce(reply(fixture.evidence, 200))
    expect(await transport.write(original, new AbortController().signal)).toEqual({ status: 200, rawBody: fixture.response })
    expect(await transport.receipt(original, new AbortController().signal)).toEqual({ status: 200, rawBody: receipt })
    expect(await transport.policy(new AbortController().signal)).toEqual({ status: 200, rawBody: fixture.policy })
    expect(await transport.evidence('510300', new AbortController().signal)).toEqual({ status: 200, rawBody: fixture.evidence })
    expect(fetchMock.mock.calls.slice(1).map(call => [call[0], call[1].method])).toEqual([
      [API + '/v2/owner/analysis', 'POST'], [API + '/v2/owner/analysis/requests/analysis-http-0001', 'GET'],
      [API + '/v2/private/portfolio/policy', 'GET'], [API + '/v2/private/fund/510300/evidence', 'GET'],
    ])
    expect(fetchMock.mock.calls[1][1].body).toBe(fixture.rawBody)
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('X-Owner-Analysis-Request-Hash')).toBe(fixture.requestHash)
    for (const [, init] of fetchMock.mock.calls.slice(3)) {
      expect(init.body).toBeUndefined()
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + TOKEN)
      expect(new Headers(init.headers).get('X-Owner-Analysis-Consent')).toBeNull()
    }
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it.each(['request-id', 'request-hash', 'source-revision', 'policy', 'evidence', 'holding'])(
    'rejects a success or receipt bound to different original context (%s)', async fault => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T06:00:00Z'))
      const { transport, fetchMock } = await connected(), fixture = ownerAnalysisBackendFixture()
      const original = await restoreOwnerAnalysisRequest(fixture.rawBody, fixture.requestHash)
      const result = JSON.parse(fixture.response)
      if (fault === 'request-id') result.run.request_id = 'different-analysis-0001'
      if (fault === 'request-hash') result.run.request_hash = 'a'.repeat(64)
      if (fault === 'source-revision') result.run.source.revision++
      if (fault === 'policy') result.run.policy.policy_version = 'pol_' + 'a'.repeat(64)
      if (fault === 'evidence') result.run.components[0].evidence.evidence_id = 'ev_' + 'a'.repeat(64)
      if (fault === 'holding') result.run.components[0].holding.holding_version = 'hold_' + 'a'.repeat(64)
      fetchMock.mockResolvedValueOnce(reply(JSON.stringify(result), 200))
        .mockResolvedValueOnce(reply(JSON.stringify({ state: 'matched', status: 200, result }), 200))
      await expect(transport.write(original, new AbortController().signal)).rejects.toMatchObject({ status: 502 })
      await expect(transport.receipt(original, new AbortController().signal)).rejects.toMatchObject({ status: 502 })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    },
  )

  it('preserves source_current false as historical evidence without pretending source confirmation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T06:00:00Z'))
    const { transport, fetchMock } = await connected(), fixture = ownerAnalysisBackendFixture()
    const original = await restoreOwnerAnalysisRequest(fixture.rawBody, fixture.requestHash)
    const result = JSON.parse(fixture.response)
    result.source_current = false
    const raw = JSON.stringify({ state: 'matched', status: 200, result })
    fetchMock.mockResolvedValueOnce(reply(raw, 200))
    expect((await transport.receipt(original, new AbortController().signal)).rawBody).toBe(raw)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('strictly validates quote keys and fund identity before delivering private input references', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T06:00:00Z'))
    const { transport, fetchMock } = await connected(), fixture = ownerAnalysisBackendFixture()
    const duplicate = fixture.policy.replace('{', '{"policy_version":"pol_' + 'a'.repeat(64) + '",')
    fetchMock.mockResolvedValueOnce(reply(duplicate, 200)).mockResolvedValueOnce(reply(fixture.evidence, 200))
    await expect(transport.policy(new AbortController().signal)).rejects.toMatchObject({ status: 502 })
    await expect(transport.evidence('000001', new AbortController().signal)).rejects.toMatchObject({ status: 502 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([404, 503])('uses the original packet for receipt (%s) without post retry, query or reconstructed identity', async status => {
    const { transport, fetchMock } = await connected(), original = await packet()
    fetchMock.mockResolvedValueOnce(reply(UNKNOWN, status))
    expect(await transport.receipt(original, new AbortController().signal)).toEqual({ status, rawBody: UNKNOWN })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(API + '/v2/owner/analysis/requests/synthetic-analysis-0001')
    expect(new URL(url).search).toBe('')
    expect(init.method).toBe('GET'); expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('X-Owner-Analysis-Request-Hash')).toBe(original.requestHash)
    expect(new Headers(init.headers).get('X-Owner-Analysis-Consent')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['hash', 'body', 'length', 'request', 'extra', 'getter'])(
    'rejects a forged original packet (%s) before credentials reach fetch', async fault => {
      const { transport, fetchMock } = await connected(), original = await packet()
      const changed: Record<string, unknown> = { ...original }, getter = vi.fn(() => original.rawBody)
      if (fault === 'hash') changed.requestHash = 'f'.repeat(64)
      if (fault === 'body') changed.rawBody = original.rawBody + ' '
      if (fault === 'length') changed.byteLength = original.byteLength + 1
      if (fault === 'request') changed.request = { ...original.request, expected_revision: 2 }
      if (fault === 'extra') changed.url = 'https://foreign.invalid'
      if (fault === 'getter') Object.defineProperty(changed, 'rawBody', { enumerable: true, get: getter })
      await expect(transport.write(changed as unknown as BuiltOwnerAnalysisRequest, new AbortController().signal))
        .rejects.toMatchObject({ status: 400 })
      await expect(transport.receipt(changed as unknown as BuiltOwnerAnalysisRequest, new AbortController().signal))
        .rejects.toMatchObject({ status: 400 })
      expect(getter).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { kind: 'policy', url: '/v2/portfolio/policy' }, { kind: 'policy', packet: {} },
    { kind: 'evidence', code: '../admin' }, { kind: 'evidence', code: '５１０３００' },
    { kind: 'evidence', code: '510300\n' }, { kind: 'evidence', code: '510300', method: 'POST' },
    { kind: 'write', requestId: 'synthetic-analysis-0001', requestHash: 'a'.repeat(64) },
    { kind: 'receipt', requestId: 'synthetic-analysis-0001', requestHash: 'a'.repeat(64) },
    { kind: 'changes', parameters: {} },
  ])('rejects unapproved operation/path input without a request: %j', async operation => {
    const { transport, fetchMock } = await connected()
    await expect(requestOwnerAnalysis(operation as OwnerAnalysisHttpOperation, new AbortController().signal,
      transport.targetFingerprint)).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps run scope separate from holdings writes, and requires read scope for quotes and receipt', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    const captured = toRaw(ownerSession.value) as unknown as { scopes: string[] }
    captured.scopes = ['read_private', 'write_holdings']
    await expect(transport.write(original, new AbortController().signal)).rejects.toMatchObject({ status: 403 })
    captured.scopes = ['run_personal_analysis', 'write_holdings']
    await expect(transport.receipt(original, new AbortController().signal)).rejects.toMatchObject({ status: 403 })
    await expect(transport.policy(new AbortController().signal)).rejects.toMatchObject({ status: 403 })
    await expect(transport.evidence('510300', new AbortController().signal)).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([404, 503, 307, 500])('quote status %s is fixed and its private body is never read or retried', async status => {
    const { transport, fetchMock } = await connected(), cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(PRIVATE)) }, cancel,
    }), { status, headers: { 'Content-Type': 'application/json' } })
    const read = vi.spyOn(response.body!, 'getReader')
    fetchMock.mockResolvedValueOnce(response)
    const pending = transport.policy(new AbortController().signal)
    await expect(pending).rejects.toMatchObject({ status })
    await expect(pending).rejects.not.toThrow(PRIVATE)
    expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(API + '/v2/private/portfolio/policy')
  })

  it('pins endpoint identity before sending and throughout late fetch delivery', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    vi.stubGlobal('location', { origin: 'https://other.example' })
    await expect(transport.write(original, new AbortController().signal)).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.stubGlobal('location', { origin: 'https://synthetic-owner.example' })
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = transport.write(original, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ status: 400 })
    await microtasks(); expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.stubGlobal('location', { origin: 'https://other.example' })
    const response = reply(), read = vi.spyOn(response.body!, 'getReader')
    finish(response); await assertion
    expect(read).not.toHaveBeenCalled(); expect(hasOwnerSession()).toBe(true)
  })

  it('rejects target drift during packet hashing before any POST', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    const digest = vi.mocked(crypto.subtle.digest), actual = digest.getMockImplementation()!
    let finish!: (digest: ArrayBuffer) => void
    digest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = transport.write(original, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ status: 400 })
    await microtasks(); vi.stubGlobal('location', { origin: 'https://other.example' })
    finish(await actual('SHA-256', new TextEncoder().encode(original.rawBody)))
    await assertion; expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('clears only the corresponding session on 401 without reading a private error', async () => {
    const { transport, fetchMock } = await connected(), original = await packet(), cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(PRIVATE)) }, cancel,
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    const read = vi.spyOn(response.body!, 'getReader'), before = ownerSessionGeneration.value
    fetchMock.mockResolvedValueOnce(response)
    await expect(transport.write(original, new AbortController().signal)).rejects.toMatchObject({ status: 401 })
    expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce()
    expect(hasOwnerSession()).toBe(false); expect(ownerSessionGeneration.value).toBeGreaterThan(before)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an old 401 cannot revoke a newer login or trigger an automatic receipt', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(loginReply('own_' + 'b'.repeat(43)))
    const pending = transport.write(original, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ status: 401 })
    await microtasks(); await loginOwnerSession('synthetic-new-password')
    finish(reply(PRIVATE, 401)); await assertion
    expect(hasOwnerSession()).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['utf8', 'mime', 'declared', 'stream', 'duplicate', 'BOM', 'unknown-detail'])(
    'bounds and strictly rejects a response (%s) without echoing it', async fault => {
      const { transport, fetchMock } = await connected(), original = await packet()
      let response = reply(PRIVATE)
      if (fault === 'utf8') response = reply(new Uint8Array([0xff]))
      if (fault === 'mime') response = reply(PRIVATE, 503, { 'Content-Type': 'text/html' })
      if (fault === 'declared') response = reply(PRIVATE, 503, { 'Content-Length': String(MAX_RESPONSE + 1) })
      if (fault === 'stream') response = reply(new Uint8Array(MAX_RESPONSE + 1), 503, { 'Content-Length': '0' })
      if (fault === 'duplicate') response = reply('{"detail":"analysis_result_unknown","detail":"analysis_result_unknown"}')
      if (fault === 'BOM') response = reply(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(FAILURE)]))
      if (fault === 'unknown-detail') response = reply('{"detail":"' + PRIVATE + '"}')
      fetchMock.mockResolvedValueOnce(response)
      const pending = transport.write(original, new AbortController().signal)
      await expect(pending).rejects.toMatchObject({ status: 502 })
      await expect(pending).rejects.not.toThrow(PRIVATE)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it('permits UTF8 split across chunks while never using response.json or text', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    const bytes = new TextEncoder().encode(FAILURE)
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    const json = vi.spyOn(response, 'json'), text = vi.spyOn(response, 'text')
    fetchMock.mockResolvedValueOnce(response)
    expect((await transport.write(original, new AbortController().signal)).rawBody).toBe(FAILURE)
    expect(json).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled()
  })

  it('keeps a single bounded 30-second POST budget rather than aborting at the old sync 12 seconds', async () => {
    vi.useFakeTimers()
    const { transport, fetchMock } = await connected(), original = await packet()
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    const pending = transport.write(original, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await microtasks(); await vi.advanceTimersByTimeAsync(29_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('includes packet hashing and body reading within the same total budget', async () => {
    vi.useFakeTimers()
    const { transport, fetchMock } = await connected(), original = await packet()
    const digest = vi.mocked(crypto.subtle.digest), actual = digest.getMockImplementation()!
    let finish!: (value: ArrayBuffer) => void
    digest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const hashing = transport.write(original, new AbortController().signal)
    const hashAssertion = expect(hashing).rejects.toMatchObject({ kind: 'timeout' })
    await microtasks(); await vi.advanceTimersByTimeAsync(30_000); await hashAssertion
    finish(await actual('SHA-256', new TextEncoder().encode(original.rawBody))); await microtasks()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    }))
    const reading = transport.write(original, new AbortController().signal)
    const readAssertion = expect(reading).rejects.toMatchObject({ kind: 'timeout' })
    await microtasks(); await vi.advanceTimersByTimeAsync(30_000); await readAssertion
    expect(cancel).toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not grant a fresh budget to strict response parsing', async () => {
    const { transport, fetchMock } = await connected(), original = await packet()
    let now = 0
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now)
    const actual = contract.parseOwnerAnalysisWriteResponse
    vi.spyOn(contract, 'parseOwnerAnalysisWriteResponse').mockImplementation((...args) => {
      const result = actual(...args)
      now = 30_001
      return result
    })
    fetchMock.mockResolvedValueOnce(reply())
    await expect(transport.write(original, new AbortController().signal)).rejects.toMatchObject({ kind: 'timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('cancels on logout and refuses already aborted work before hashing or POST', async () => {
    const { transport, fetchMock } = await connected(), original = await packet(), stopped = new AbortController()
    const digest = vi.mocked(crypto.subtle.digest), before = digest.mock.calls.length
    stopped.abort()
    await expect(transport.write(original, stopped.signal)).rejects.toMatchObject({ kind: 'cancelled' })
    expect(digest).toHaveBeenCalledTimes(before); expect(fetchMock).toHaveBeenCalledTimes(1)
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    }))
    const pending = transport.write(original, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ status: 401 })
    await microtasks(); clearOwnerSession(); await assertion
    expect(cancel).toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
