import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openOwnerSyncOutbox, type OwnerSyncOutbox } from './ownerSyncOutbox'
import { createOwnerSyncCandidate, type OwnerSyncCandidateTransport } from './ownerSyncCandidate'
import { buildOwnerSyncRequest, type BuiltOwnerSyncRequest, type OwnerSyncRecord } from '@/utils/ownerSyncContract'

const TARGET = 'a'.repeat(64)
const DRAFT = { key: 'asset:synthetic-candidate', kind: 'manual_asset' as const, deleted: false,
  changes: { name: 'Synthetic candidate', cls: '现金', value: 0, note: null } }
const handles: OwnerSyncOutbox[] = []
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); vi.useRealTimers(); vi.unstubAllGlobals() })
function record(key = DRAFT.key, revision = 1): OwnerSyncRecord {
  return { key, kind: 'manual_asset', deleted: false, record_revision: revision,
    lifecycle_revision: 1, field_revisions: { name: 1, cls: 1, value: revision, note: 1 },
    values: { ...DRAFT.changes } }
}
function page(changes: OwnerSyncRecord[] = [], upper = 0, cursor: readonly [number, string] | null = null) {
  return { status: 200, rawBody: JSON.stringify({ upper_revision: upper, changes, next_cursor: cursor, complete: cursor === null }) }
}
function success(original: BuiltOwnerSyncRequest, head = 1) {
  return { status: 200, rawBody: JSON.stringify({ revision: head, records: original.request.operations
    .filter(operation => !operation.deleted).map(operation => ({ ...record(operation.key, head),
      values: { name: 'Synthetic candidate', cls: '现金', value: 0, note: null, ...operation.changes } })) }) }
}
function conflict() {
  return { status: 409, rawBody: JSON.stringify({ error: {
    code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。',
  }, conflicts: [{ key_digest: 'b'.repeat(16), fields: ['value'] }] }) }
}
async function fixture(factory = new IDBFactory()) {
  const outbox = await openOwnerSyncOutbox(factory, TARGET)
  handles.push(outbox)
  let session = { authenticated: true, generation: 1 }
  const transport = {
    targetFingerprint: TARGET,
    write: vi.fn(async (original: BuiltOwnerSyncRequest, _signal: AbortSignal) => success(original)),
    receipt: vi.fn(async (_id: string, _hash: string, _signal: AbortSignal): Promise<{ status: number; rawBody: string }> =>
      ({ status: 404, rawBody: JSON.stringify({ state: 'unknown', error: 'sync_result_unknown' }) })),
    changes: vi.fn(async (_parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0], _signal: AbortSignal) => page()),
  }
  const candidate = createOwnerSyncCandidate({ outbox, transport, session: () => session })
  return { outbox, transport, candidate, setSession: (next: typeof session) => { session = next } }
}
async function prepared() {
  const result = await fixture()
  result.candidate.setCloudConsent(true)
  await result.candidate.pullBaseline()
  await result.candidate.prepare('synthetic-request-0001', [DRAFT])
  return result
}

describe('explicit owner sync candidate', () => {
  it('imports/constructs disabled without requesting, reading legacy storage or persisting consent', async () => {
    const { candidate, transport, outbox } = await fixture()
    expect(candidate.status().state).toBe('disabled')
    for (const operation of [() => candidate.hydratePending(), () => candidate.pullBaseline(), () => candidate.sendPrepared()]) {
      await expect(operation()).rejects.toMatchObject({ code: 'sync_disabled' })
    }
    expect(transport.write).not.toHaveBeenCalled()
    expect(transport.changes).not.toHaveBeenCalled()
    expect(transport.receipt).not.toHaveBeenCalled()
    expect(await outbox.read()).toEqual({ version: 0, entry: null })
  })

  it('rejects a mismatched transport resource before any request', async () => {
    const f = await fixture()
    expect(() => createOwnerSyncCandidate({ outbox: f.outbox,
      transport: { ...f.transport, targetFingerprint: 'c'.repeat(64) }, session: () => ({ authenticated: true, generation: 1 }) }))
      .toThrowError('Owner sync candidate operation unavailable')
    expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('requires a complete cloud baseline, persists before POST and does not promote POST head to pull checkpoint', async () => {
    const f = await fixture()
    f.candidate.setCloudConsent(true)
    await expect(f.candidate.prepare('synthetic-request-0001', [DRAFT])).rejects.toMatchObject({ code: 'sync_pull_required' })
    expect((await f.candidate.pullBaseline()).busy).toBe(false)
    expect((await f.candidate.prepare('synthetic-request-0001', [DRAFT])).state).toBe('prepared')
    f.transport.write.mockImplementation(async original => {
      const persisted = await f.outbox.read()
      expect(persisted.entry?.state).toBe('attempted')
      expect(persisted.entry?.rawBody).toBe(original.rawBody)
      expect(persisted.entry?.requestHash).toBe(original.requestHash)
      return success(original, 4)
    })
    expect((await f.candidate.sendPrepared()).state).toBe('confirmed')
    expect(f.candidate.status()).toMatchObject({ lastCompletePulledRevision: 0, latestObservedHead: 4, baselineReady: false })
    expect(f.candidate.getLastResult()?.kind).toBe('success')
    await f.candidate.clearResolvedOrUnsent()
    await expect(f.candidate.prepare('synthetic-request-0002', [DRAFT])).rejects.toMatchObject({ code: 'sync_pull_required' })
  })

  it('keeps original bytes/id when network outcome is unknown and never automatically re-POSTs', async () => {
    const f = await prepared()
    const before = (await f.outbox.read()).entry!
    f.transport.write.mockRejectedValue(new Error('synthetic private provider failure'))
    expect((await f.candidate.sendPrepared()).state).toBe('unknown')
    expect(f.transport.write).toHaveBeenCalledTimes(1)
    expect(await f.outbox.read()).toMatchObject({ entry: { ...before, state: 'unknown' } })
    await f.candidate.hydratePending()
    await f.candidate.reconcilePending()
    await f.candidate.reconcilePending()
    expect(f.transport.receipt).toHaveBeenCalledTimes(2)
    expect(f.transport.write).toHaveBeenCalledTimes(1)
    await expect(f.candidate.sendPrepared()).rejects.toMatchObject({ code: 'sync_invalid_transition' })
    await expect(f.candidate.clearResolvedOrUnsent()).rejects.toMatchObject({ code: 'sync_invalid_transition' })
    await expect(f.candidate.prepare('synthetic-replacement-0002', [DRAFT])).rejects.toMatchObject({ code: 'sync_pending' })
  })

  it('reopens an attempted packet as unknown; fresh controller stays disabled', async () => {
    const f = await prepared()
    const stored = await f.outbox.read()
    await f.outbox.compareAndSwap(stored.version, { ...stored.entry!, state: 'attempted' })
    const reopened = createOwnerSyncCandidate({ outbox: f.outbox, transport: f.transport,
      session: () => ({ authenticated: true, generation: 2 }) })
    expect(reopened.status().state).toBe('disabled')
    reopened.setCloudConsent(true)
    expect((await reopened.hydratePending()).state).toBe('unknown')
    expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('only confirms exact hash receipt, without a POST retry or a full-pull revision shortcut', async () => {
    const f = await prepared()
    f.transport.write.mockRejectedValue(new Error('synthetic lost response'))
    await f.candidate.sendPrepared()
    const stored = (await f.outbox.read()).entry!
    f.transport.receipt.mockImplementation(async (id, hash) => {
      expect(id).toBe('synthetic-request-0001')
      expect(hash).toBe(stored.requestHash)
      const original = await buildOwnerSyncRequest(JSON.parse(stored.rawBody))
      return { status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(success(original, 4).rawBody) }) }
    })
    expect((await f.candidate.reconcilePending()).state).toBe('confirmed')
    expect(f.transport.write).toHaveBeenCalledTimes(1)
    expect(f.candidate.status()).toMatchObject({ lastCompletePulledRevision: 0, latestObservedHead: 4, baselineReady: false })
  })

  it('keeps closed unavailable receipt and malformed matched envelope unknown', async () => {
    const f = await prepared()
    f.transport.write.mockRejectedValue(new Error('synthetic lost response'))
    await f.candidate.sendPrepared()
    for (const response of [
      { status: 503, rawBody: '{"state":"unknown","error":"sync_result_unknown"}' },
      { status: 200, rawBody: '{"state":"matched","status":200,"result":{"revision":0,"records":[]},"secret":"private"}' },
    ]) {
      f.transport.receipt.mockResolvedValue(response)
      expect((await f.candidate.reconcilePending()).state).toBe('unknown')
      expect((await f.outbox.read()).entry?.state).toBe('unknown')
    }
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('requires explicit unknown replay acknowledgement and reuses byte-exact original packet', async () => {
    const f = await prepared()
    f.transport.write.mockRejectedValueOnce(new Error('synthetic disconnect'))
    await f.candidate.sendPrepared()
    const original = (await f.outbox.read()).entry!
    await expect(f.candidate.resendUnknown(false as true)).rejects.toMatchObject({ code: 'sync_unknown_resend_requires_confirmation' })
    expect(f.transport.write).toHaveBeenCalledTimes(1)
    expect((await f.candidate.resendUnknown(true)).state).toBe('confirmed')
    const posted = f.transport.write.mock.calls.map(call => call[0])
    expect(posted.map(packet => packet.rawBody)).toEqual([original.rawBody, original.rawBody])
    expect(posted.map(packet => packet.requestHash)).toEqual([original.requestHash, original.requestHash])
  })

  it('retains deterministic field conflict; clears only explicit resolved/unsent slots', async () => {
    const f = await prepared()
    f.transport.write.mockResolvedValue(conflict())
    expect((await f.candidate.sendPrepared()).state).toBe('conflict')
    expect(f.candidate.getLastResult()?.kind).toBe('conflict')
    await f.candidate.clearResolvedOrUnsent()
    expect((await f.outbox.read()).entry).toBeNull()
    await f.candidate.prepare('synthetic-request-0002', [DRAFT])
    await f.candidate.clearResolvedOrUnsent()
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('does not expose late success after logout; persistent request is not discarded', async () => {
    const f = await prepared()
    f.transport.write.mockImplementation(async original => {
      f.setSession({ authenticated: false, generation: 2 })
      f.candidate.notifySessionChanged()
      return success(original)
    })
    expect((await f.candidate.sendPrepared()).state).toBe('signed_out')
    expect(f.candidate.getLastResult()).toBeNull()
    expect(f.candidate.status()).toMatchObject({ lastCompletePulledRevision: null, latestObservedHead: null, baselineReady: false })
    expect((await f.outbox.read()).entry?.state).toBe('unknown')
  })

  it('revocation during a transport that ignores cancellation rejects late result without retry', async () => {
    const f = await prepared()
    let finish!: (value: { status: number; rawBody: string }) => void
    f.transport.write.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const sending = f.candidate.sendPrepared()
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledTimes(1))
    f.candidate.setCloudConsent(false)
    expect((await sending).state).toBe('disabled')
    const original = f.transport.write.mock.calls[0]![0]
    finish(success(original))
    await Promise.resolve()
    expect(f.candidate.getLastResult()).toBeNull()
    expect((await f.outbox.read()).entry?.state).toBe('unknown')
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent local sends before any double POST', async () => {
    const f = await prepared()
    let finish!: (value: { status: number; rawBody: string }) => void
    f.transport.write.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const sending = f.candidate.sendPrepared()
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledTimes(1))
    await expect(f.candidate.sendPrepared()).rejects.toMatchObject({ code: 'sync_busy' })
    finish(success(f.transport.write.mock.calls[0]![0]))
    await sending
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('blocks cross-tab send losers before POST using the actual IDB CAS', async () => {
    const factory = new IDBFactory()
    const first = await fixture(factory)
    const second = await fixture(factory)
    first.candidate.setCloudConsent(true)
    second.candidate.setCloudConsent(true)
    await first.candidate.pullBaseline()
    await first.candidate.prepare('synthetic-request-0001', [DRAFT])
    const outcomes = await Promise.allSettled([first.candidate.sendPrepared(), second.candidate.sendPrepared()])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(first.transport.write.mock.calls.length + second.transport.write.mock.calls.length).toBe(1)
  })

  it('only publishes complete fixed-upper pagination and preserves the draft observed baseline for ABA', async () => {
    const f = await fixture()
    f.candidate.setCloudConsent(true)
    const chunk = Array.from({ length: 200 }, (_, index) => record('asset:synthetic-' + String(index).padStart(3, '0'), 1))
    const first = chunk[0]!, tail = chunk.at(-1)!, second = record('asset:synthetic-z', 1)
    f.transport.changes.mockResolvedValueOnce(page(chunk, 1, [1, tail.key]))
      .mockImplementationOnce(async parameters => {
        expect(f.candidate.status().lastCompletePulledRevision).toBeNull()
        expect(parameters).toMatchObject({ sinceRevision: 0, upperRevision: 1, cursor: [1, tail.key] })
        return page([second], 1)
      })
    expect((await f.candidate.pullBaseline()).lastCompletePulledRevision).toBe(1)
    await f.candidate.prepare('synthetic-old-base-0001', [{ ...DRAFT, key: first.key, changes: { value: 2 } }])
    const before = (await f.outbox.read()).entry!
    f.transport.changes.mockResolvedValue(page([record(first.key, 3)], 3))
    await f.candidate.pullBaseline()
    const after = (await f.outbox.read()).entry!
    expect(after.rawBody).toBe(before.rawBody)
    expect(JSON.parse(after.rawBody).expected_revision).toBe(1)
    expect(JSON.parse(after.rawBody).operations[0].base_values.value).toBe(0)
  })

  it('does not commit a partial page or silently accept upper drift', async () => {
    const f = await fixture()
    f.candidate.setCloudConsent(true)
    const chunk = Array.from({ length: 200 }, (_, index) => record('asset:synthetic-' + String(index).padStart(3, '0'), 1))
    const tail = chunk.at(-1)!
    f.transport.changes.mockResolvedValueOnce(page(chunk, 1, [1, tail.key]))
      .mockResolvedValueOnce(page([record('asset:synthetic-z', 2)], 2))
    await expect(f.candidate.pullBaseline()).rejects.toMatchObject({ code: 'sync_unavailable' })
    expect(f.candidate.status()).toMatchObject({ lastCompletePulledRevision: null, baselineReady: false, state: 'blocked' })
    await expect(f.candidate.prepare('synthetic-request-0001', [DRAFT])).rejects.toMatchObject({ code: 'sync_pull_required' })
  })

  it('refuses head regression after seeing a newer accepted POST', async () => {
    const f = await prepared()
    f.transport.write.mockImplementation(async original => success(original, 4))
    await f.candidate.sendPrepared()
    f.transport.changes.mockResolvedValue(page([record()], 1))
    await expect(f.candidate.pullBaseline()).rejects.toMatchObject({ code: 'sync_unavailable' })
    expect(f.candidate.status().lastCompletePulledRevision).toBe(0)
    expect(f.candidate.status().baselineReady).toBe(false)
  })

  it('rejects unrelated or missing success records rather than confirming arbitrary data', async () => {
    for (const records of [[], [record('asset:synthetic-other')]]) {
      const f = await prepared()
      f.transport.write.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ revision: 1, records }) })
      expect((await f.candidate.sendPrepared()).state).toBe('unknown')
      expect(f.candidate.getLastResult()).toBeNull()
    }
  })

  it.each(['write', 'receipt', 'resend'] as const)('does not invoke %s after consent revocation in the scheduled transport microtask', async method => {
    const f = await prepared()
    if (method !== 'write') {
      f.transport.write.mockRejectedValueOnce(new Error('synthetic lost response'))
      await f.candidate.sendPrepared()
    }
    f.transport.write.mockClear()
    const NativeAbortController = globalThis.AbortController
    vi.stubGlobal('AbortController', class extends NativeAbortController {
      constructor() { super(); queueMicrotask(() => f.candidate.setCloudConsent(false)) }
    })
    const outcome = method === 'write' ? await f.candidate.sendPrepared()
      : method === 'receipt' ? await f.candidate.reconcilePending() : await f.candidate.resendUnknown(true)
    expect(outcome.state).toBe('disabled')
    expect(f.transport.write).not.toHaveBeenCalled()
    expect(f.transport.receipt).not.toHaveBeenCalled()
    expect((await f.outbox.read()).entry?.state).toBe('unknown')
  })

  it.each([
    [{ value: 17 }, { value: 0 }],
    [{ note: null }, { note: '' }],
    [{ name: 'Synthetic requested' }, { name: 'Synthetic other' }],
    [{ cls: '权益' }, { cls: '现金' }],
  ])('does not confirm a same-key success with different requested scalar values (%j)', async (changes, returned) => {
    const f = await fixture()
    f.candidate.setCloudConsent(true)
    await f.candidate.pullBaseline()
    await f.candidate.prepare('synthetic-wrong-values-0001', [{ ...DRAFT, changes: { ...DRAFT.changes, ...changes } }])
    const original = (await f.outbox.read()).entry!
    f.transport.write.mockImplementation(async packet => {
      const response = JSON.parse(success(packet).rawBody)
      response.records[0].values = { ...response.records[0].values, ...returned }
      return { status: 200, rawBody: JSON.stringify(response) }
    })
    expect((await f.candidate.sendPrepared()).state).toBe('unknown')
    expect(f.candidate.getLastResult()).toBeNull()
    expect((await f.outbox.read()).entry).toEqual({ ...original, state: 'unknown' })
    await expect(f.candidate.clearResolvedOrUnsent()).rejects.toMatchObject({ code: 'sync_invalid_transition' })
  })

  it('also rejects a matched receipt whose requested change differs', async () => {
    const f = await prepared()
    f.transport.write.mockRejectedValueOnce(new Error('synthetic lost response'))
    await f.candidate.sendPrepared()
    f.transport.receipt.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200,
      result: { revision: 1, records: [{ ...record(), values: { ...DRAFT.changes, value: 17 } }] } }) })
    expect((await f.candidate.reconcilePending()).state).toBe('unknown')
    expect(f.candidate.getLastResult()).toBeNull()
    expect((await f.outbox.read()).entry?.state).toBe('unknown')
  })

  it('accepts equivalent finite numbers without collapsing null to zero', async () => {
    const f = await fixture()
    f.candidate.setCloudConsent(true)
    await f.candidate.pullBaseline()
    await f.candidate.prepare('synthetic-numeric-0001', [{ ...DRAFT, changes: { ...DRAFT.changes, value: 1 } }])
    f.transport.write.mockImplementation(async packet => {
      const response = success(packet)
      return { ...response, rawBody: response.rawBody.replace('"value":1,"note":null', '"value":1.0,"note":null') }
    })
    expect((await f.candidate.sendPrepared()).state).toBe('confirmed')
  })

  it('a post-commit 401/idempotency error does not prove rollback', async () => {
    for (const response of [
      { status: 401, rawBody: '{"detail":"Owner 会话无效或已过期，请重新登录"}' },
      { status: 409, rawBody: JSON.stringify({ error: { code: 'idempotency_conflict', message: '请求标识已用于不同的同步请求。' } }) },
    ]) {
      const f = await prepared()
      f.transport.write.mockResolvedValue(response)
      expect((await f.candidate.sendPrepared()).state).toBe('unknown')
      expect((await f.outbox.read()).entry?.state).toBe('unknown')
    }
  })

  it('total pagination timeout stops local waiting and late transport cannot issue more pages', async () => {
    const f = await fixture()
    f.candidate.setCloudConsent(true)
    let finish!: (value: { status: number; rawBody: string }) => void
    f.transport.changes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    vi.useFakeTimers()
    const pull = f.candidate.pullBaseline()
    const rejected = expect(pull).rejects.toMatchObject({ code: 'sync_unavailable' })
    await vi.advanceTimersByTimeAsync(12_001)
    await rejected
    const first = record('asset:synthetic-a', 1)
    finish(page([first], 1, [1, first.key]))
    await vi.advanceTimersByTimeAsync(1)
    expect(f.transport.changes).toHaveBeenCalledTimes(1)
    expect(f.candidate.status()).toMatchObject({ baselineReady: false, lastCompletePulledRevision: null })
  })
})
