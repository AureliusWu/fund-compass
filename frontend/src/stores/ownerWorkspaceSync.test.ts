/** Synthetic coordinator integration with real injected fake-IDB workspace
 * primitives. Mock only HTTP/session/authority and explicitly labelled corrupt
 * competing-port observations. No ambient IO, real browser, cloud or UI proof.
 */
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, buildOwnerWorkspaceAdoptLocalRequest,
  buildOwnerWorkspaceEditLocalRequest, buildOwnerWorkspacePrepareCloudRequest,
  buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceCancelCloudRequest, type OwnerWorkspace, type OwnerWorkspaceGuard,
  type OwnerWorkspaceSyncState, OwnerWorkspaceError,
} from './owner-workspace'
import { createOwnerWorkspaceSync } from './ownerWorkspaceSync'
import type { OwnerWorkspaceDeliveryRequest, OwnerWorkspaceAckCloudRequest } from './owner-workspace-delivery'
import { canonicalOwnerLocal, buildOwnerLegacyWorkspaceBackup } from '@/utils/owner-workspace-backup'
import { buildOwnerSyncRequest, type OwnerSyncRecord, type BuiltOwnerSyncRequest } from '@/utils/ownerSyncContract'
import type { OwnerSyncCandidateTransport } from './ownerSyncCandidate'

const TARGET = 'd'.repeat(64), KEY = '000001::synthetic-managed', PRIVATE = 'synthetic-private-no-echo'
const handles: OwnerWorkspace[] = []
const ambient = vi.fn(() => { throw new Error('ambient IO forbidden') })
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); ambient.mockClear()
  vi.stubGlobal('fetch', ambient); vi.stubGlobal('indexedDB', { open: ambient })
  vi.stubGlobal('localStorage', { getItem: ambient, setItem: ambient, removeItem: ambient })
})
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function record(shares = 0, revision = 1, patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: revision, cost: 1, target_weight: 1 },
    values: { name: PRIVATE, shares, cost: null, target_weight: null }, ...patch } as OwnerSyncRecord
}
function page(records: readonly OwnerSyncRecord[] = [], head = Math.max(0, ...records.map(row => row.record_revision)),
  cursor: readonly [number, string] | null = null) {
  return { status: 200, rawBody: JSON.stringify({ upper_revision: head, changes: records,
    next_cursor: cursor, complete: cursor === null }) }
}
function success(shares = 7, revision = 2) { return { status: 200, rawBody: JSON.stringify({ revision, records: [record(shares, revision)] }) } }
function conflict() { return { status: 409, rawBody: JSON.stringify({ error: {
  code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。',
}, conflicts: [{ key_digest: createHash('sha256').update(KEY).digest('hex').slice(0, 16), fields: ['shares'] }] }) } }
function receipt(response = success()) { return { status: 200,
  rawBody: JSON.stringify({ state: 'matched', status: response.status, result: JSON.parse(response.rawBody) }) } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function copy<T>(value: T): T { return structuredClone(value) }
function same(first: unknown, second: unknown) { return canonicalOwnerLocal(first) === canonicalOwnerLocal(second) }
function context() {
  const controller = new AbortController(), state = { active: true }
  const guard = { signal: controller.signal, assertActive() {
    if (controller.signal.aborted || !state.active) throw new Error('synthetic authority revoked')
  } }
  return { controller, state, guard }
}
function wsError(code: string) { return Object.assign(new Error('synthetic workspace unavailable'), { code }) }
type Port = Parameters<typeof createOwnerWorkspaceSync>[0]['workspace']

async function fixture(mode: 'linked' | 'unlinked' | 'prepared' = 'linked') {
  const factory = new IDBFactory(), authority = context(), legacy = await openOwnerWorkspace(factory, TARGET)
  handles.push(legacy)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: null, v2Raw: JSON.stringify([
    { code: '000001', name: PRIVATE, account: 'synthetic-managed', position_kind: 'holding',
      shares: 0, cost: null, target_weight: null, updated_at: '2026-10-22T00:00:00Z' },
  ]) }
  const backup = await buildOwnerLegacyWorkspaceBackup(sourceArchive), adopt = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, {
    id: 'managed-adopt-0001', expected: await legacy.readLocalState(authority.guard), sourceArchive, backupSha256: backup.sha256,
  }), adopted = await legacy.adoptLocal(adopt, authority.guard), workspace = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, authority.guard)
  handles.push(workspace)
  if (mode !== 'unlinked') {
    const link = await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'managed-link-0001',
      expected: await workspace.readSyncState(authority.guard), base: { pulledRevision: 1, records: [record()] } })
    await workspace.linkCloudBase(link, authority.guard)
    const expected = await workspace.readLocalState(authority.guard), before = expected.snapshot.entries[0]
    const edit = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'managed-edit-0001', expected,
      command: { type: 'save', input: { code: '000001', name: PRIVATE, account: 'synthetic-managed', position_kind: 'holding',
        shares: 7, cost: null, target_weight: null }, expectedEntry: before, confirmed: true } })
    await workspace.editLocal(edit, authority.guard)
  }
  if (mode === 'prepared') {
    const preparation = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'managed-prepare-0001', expected: await workspace.readSyncState(authority.guard) })
    await workspace.prepareCloud(preparation, authority.guard)
  }
  let image = await workspace.readSyncState(authority.guard), session = { authenticated: true, generation: 1 }
  let override = false
  const events: string[] = []
  function checked(guard: OwnerWorkspaceGuard, expected?: OwnerWorkspaceSyncState) {
    guard.assertActive(); if (guard.signal.aborted) throw wsError('workspace_context_changed')
    if (expected && !same(image, expected)) throw wsError('workspace_conflict')
  }
  const port = {
    targetFingerprint: TARGET,
    readSyncState: vi.fn(async (guard: OwnerWorkspaceGuard) => {
      checked(guard)
      if (!override) image = await workspace.readSyncState(guard)
      return image
    }),
    linkCloudBase: vi.fn(async (request: Parameters<OwnerWorkspace['linkCloudBase']>[0], guard: OwnerWorkspaceGuard) => {
      checked(guard, request.expected); image = await workspace.linkCloudBase(request, guard); return image
    }),
    prepareCloud: vi.fn(async (request: Parameters<OwnerWorkspace['prepareCloud']>[0], guard: OwnerWorkspaceGuard) => {
      checked(guard, request.expected); image = await workspace.prepareCloud(request, guard); events.push('prepared'); return image
    }),
    cancelPreparedCloud: vi.fn(async (request: Parameters<OwnerWorkspace['cancelPreparedCloud']>[0], guard: OwnerWorkspaceGuard) => {
      checked(guard, request.expected); image = await workspace.cancelPreparedCloud(request, guard); events.push('cancelled'); return image
    }),
    transitionCloudDelivery: vi.fn(async (request: OwnerWorkspaceDeliveryRequest, guard: OwnerWorkspaceGuard) => {
      checked(guard, request.expected)
      image = await workspace.transitionCloudDelivery(request, guard)
      events.push(request.nextState); return image
    }),
    ackCloud: vi.fn(async (request: OwnerWorkspaceAckCloudRequest, guard: OwnerWorkspaceGuard) => {
      checked(guard, request.expected)
      image = await workspace.ackCloud(request, guard)
      events.push('ack'); return image
    }),
    syncReceipt: vi.fn(async (id: string, hash: string, guard: OwnerWorkspaceGuard) => {
      checked(guard)
      return workspace.syncReceipt(id, hash, guard)
    }),
  } satisfies Port
  const transport = {
    targetFingerprint: TARGET,
    write: vi.fn(async (_packet: BuiltOwnerSyncRequest, _signal: AbortSignal): Promise<{ status: number; rawBody: string }> => {
      expect(image.local.outbox.entry!.state).toBe('attempted'); events.push('POST'); return success()
    }),
    receipt: vi.fn(async (_id: string, _hash: string, _signal: AbortSignal) => receipt()),
    changes: vi.fn(async (_parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0], _signal: AbortSignal) => page([record()])),
  }
  const guard = vi.fn((_signal: AbortSignal) => authority.guard), readSession = vi.fn(() => session)
  const create = () => createOwnerWorkspaceSync({ workspace: port, transport, session: readSession, guard })
  const managed = create()
  return { factory, workspace, port, transport, authority, events, guard, readSession, managed, create,
    image: () => image, replace: (next: OwnerWorkspaceSyncState) => { image = next; override = true }, setSession: (next: typeof session) => { session = next } }
}
async function prepared() {
  const f = await fixture()
  f.managed.setCloudConsent(true); await f.managed.hydrate()
  const request = await f.managed.previewPreparation('managed-prepare-0001')
  await f.managed.commitPreparation(request, true)
  return { ...f, request }
}
async function confirmed() {
  const f = await prepared(); await f.managed.sendOnce(); return f
}

describe('explicit disabled managed controller and authority lifetime', () => {
  it('constructs default-off with no workspace/session/guard/transport/ambient IO', async () => {
    const f = await fixture()
    expect(f.port.readSyncState).not.toHaveBeenCalled(); expect(f.guard).not.toHaveBeenCalled(); expect(f.readSession).not.toHaveBeenCalled()
    for (const method of Object.values(f.transport)) if (typeof method === 'function') expect(method).not.toHaveBeenCalled()
    expect(ambient).not.toHaveBeenCalled()
    await expect(f.managed.hydrate()).rejects.toMatchObject({ code: 'managed_disabled' })
    expect(f.port.readSyncState).not.toHaveBeenCalled()
  })

  it('rejects target mismatch before any method and requires authenticated exact generation', async () => {
    const f = await fixture()
    expect(() => createOwnerWorkspaceSync({ workspace: f.port, transport: { ...f.transport, targetFingerprint: 'e'.repeat(64) },
      session: f.readSession, guard: f.guard })).toThrowError(expect.objectContaining({ code: 'managed_invalid_options' }))
    f.managed.setCloudConsent(true); f.setSession({ authenticated: false, generation: 1 })
    await expect(f.managed.hydrate()).rejects.toMatchObject({ code: 'managed_signed_out' })
    f.setSession({ authenticated: true, generation: 2 }); await f.managed.hydrate()
    expect(f.managed.status().state).toBe('idle')
    f.managed.close(); await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_closed' })
  })

  it('hydrates/reloads original prepared and attempted slots without POST or legacy CAS/clear/resend surface', async () => {
    const f = await fixture('prepared'), original = copy(f.image())
    f.managed.setCloudConsent(true); await f.managed.hydrate()
    expect(f.managed.status().state).toBe('prepared')
    expect(f.transport.write).not.toHaveBeenCalled(); expect(f.port.transitionCloudDelivery).not.toHaveBeenCalled()
    expect(f.managed).not.toHaveProperty('prepare'); expect(f.managed).not.toHaveProperty('clearResolvedOrUnsent'); expect(f.managed).not.toHaveProperty('resendUnknown')
    f.replace({ ...original, local: { ...original.local, outbox: { version: original.local.outbox.version + 1,
      entry: { ...original.local.outbox.entry!, state: 'attempted' } } } })
    const reloaded = f.create(); reloaded.setCloudConsent(true); await reloaded.hydrate()
    expect(reloaded.status().state).toBe('unknown')
    await expect(reloaded.sendOnce()).rejects.toMatchObject({ code: 'managed_pending' })
    expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('requires exact current preview and explicit confirmation before any local prepare', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('managed-preview-0001')
    await expect(f.managed.commitPreparation(request, false as true)).rejects.toMatchObject({ code: 'managed_confirmation_required' })
    expect(f.port.prepareCloud).not.toHaveBeenCalled()
    await f.managed.hydrate()
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.prepareCloud).not.toHaveBeenCalled()
  })

  it('rejects revoked authority and does not let a late response affect a newer login or consent context', async () => {
    const f = await prepared(), waiting = deferred<ReturnType<typeof success>>()
    f.transport.write.mockImplementationOnce(() => waiting.promise)
    const pending = f.managed.sendOnce()
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledTimes(1))
    f.setSession({ authenticated: true, generation: 2 }); f.managed.notifySessionChanged()
    await expect(pending).rejects.toMatchObject({ code: 'managed_context_changed' })
    waiting.resolve(success()); await Promise.resolve(); await Promise.resolve()
    expect(f.image().local.outbox.entry!.state).toBe('attempted')
    expect(f.managed.status().resultReady).toBe(false)
    await f.managed.hydrate(); expect(f.managed.status().state).toBe('unknown')
    expect(f.port.ackCloud).not.toHaveBeenCalled()
  })

  it('external authority signal abort stops an uncooperative transport immediately, not after its 12s', async () => {
    const f = await prepared(), waiting = deferred<ReturnType<typeof success>>()
    f.transport.write.mockImplementationOnce(() => waiting.promise)
    const pending = f.managed.sendOnce()
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledTimes(1))
    f.authority.controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'managed_context_changed' })
    waiting.resolve(success()); await Promise.resolve()
    expect(f.image().local.outbox.entry!.state).toBe('attempted')
    expect(f.managed.status().resultReady).toBe(false)
  })
})

describe('original atomic preparation and single durable attempted POST', () => {
  it('links only a previewed complete baseline through the actual explicit v4 IDB method', async () => {
    const f = await fixture('unlinked'), original = copy(f.image())
    f.managed.setCloudConsent(true); await f.managed.hydrate()
    await expect(f.managed.previewLink('managed-link-next-0001')).rejects.toMatchObject({ code: 'managed_pull_required' })
    await f.managed.hydrate(); await f.managed.pullComplete()
    const preview = await f.managed.previewLink('managed-link-next-0001')
    expect(preview.preview.issues).toEqual([])
    const after = await f.managed.commitLink(preview.request, true)
    expect(after.sync.base).toEqual({ pulledRevision: 1, records: [record()] })
    expect(after.local.snapshot.localVersion).toBe(original.local.snapshot.localVersion + 1)
    expect(after.local.metadata.displayTimes).toEqual(original.local.metadata.displayTimes)
    expect(f.port.linkCloudBase).toHaveBeenCalledTimes(1); expect(f.transport.write).not.toHaveBeenCalled()
    expect(await f.workspace.readSyncState(f.authority.guard)).toEqual(after)
  })

  it('prepares from applied B rather than newly pulled D and persists attempted before exactly one original-body POST', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    f.transport.changes.mockResolvedValueOnce(page([record(99, 3)])); await f.managed.pullComplete()
    const request = await f.managed.previewPreparation('managed-prepare-0001')
    expect(request.packet.request.expected_revision).toBe(1)
    expect(request.packet.request.operations).toEqual([{ key: KEY, kind: 'holding', deleted: false,
      changes: { shares: 7 }, base_values: { kind: 'holding', deleted: false, shares: 0 } }])
    await f.managed.commitPreparation(request, true); const before = copy(f.image())
    await f.managed.sendOnce()
    expect(f.events).toEqual(['prepared', 'attempted', 'POST', 'confirmed'])
    expect(f.transport.write).toHaveBeenCalledTimes(1)
    expect(f.transport.write.mock.calls[0][0]).toEqual(request.packet)
    expect(f.image().sync.pending!.rawBody).toBe(before.sync.pending!.rawBody)
    expect(f.image().sync.pending!.preparationHash).toBe(before.sync.pending!.preparationHash)
    await expect(f.managed.sendOnce()).rejects.toMatchObject({ code: 'managed_pending' })
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('requires unsent cancellation confirmation and never changes B/L or posts during cancellation', async () => {
    const f = await prepared(); let before = copy(f.image())
    await expect(f.managed.cancelPrepared('managed-cancel-0001', false as true)).rejects.toMatchObject({ code: 'managed_confirmation_required' })
    await f.managed.hydrate(); const after = await f.managed.cancelPrepared('managed-cancel-0001', true)
    expect(after.local.outbox.entry).toBeNull(); expect(after.sync.pending).toBeNull()
    expect(after.sync.base).toEqual(before.sync.base); expect(after.local.snapshot).toEqual(before.local.snapshot)
    expect(f.port.cancelPreparedCloud).toHaveBeenCalledTimes(1); expect(f.transport.write).not.toHaveBeenCalled()
  })

  it.each(['network', 'partial', 'malformed', 'permission'] as const)('keeps exact original after %s and requires manual receipt, never resend', async fault => {
    const f = await prepared(), before = copy(f.image())
    if (fault === 'network') f.transport.write.mockRejectedValueOnce(new Error(PRIVATE))
    if (fault === 'partial') f.transport.write.mockResolvedValueOnce({ status: 200, rawBody: '{"revision":2,"records":[]}' })
    if (fault === 'malformed') f.transport.write.mockResolvedValueOnce({ status: 200, rawBody: '{"revision":2,"revision":2,"records":[]}' })
    if (fault === 'permission') f.transport.write.mockResolvedValueOnce({ status: 403, rawBody: '{"detail":"sync_consent_required"}' })
    const after = await f.managed.sendOnce()
    expect(after.local.outbox.entry!.state).toBe('unknown')
    expect(after.sync.pending).toEqual(before.sync.pending)
    expect(f.managed.status().resultReady).toBe(false)
    await expect(f.managed.sendOnce()).rejects.toMatchObject({ code: 'managed_pending' })
    await f.managed.hydrate(); await f.managed.reconcileReceipt()
    expect(f.transport.receipt).toHaveBeenCalledWith(before.sync.pending!.requestId, before.sync.pending!.requestHash, expect.any(AbortSignal))
    expect(f.image().local.outbox.entry!.state).toBe('confirmed')
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('unknown receipt preserves original packet and never treats missing as rollback/resend permission', async () => {
    const f = await prepared(); f.transport.write.mockRejectedValueOnce(new Error('synthetic lost write'))
    await f.managed.sendOnce(); const before = copy(f.image())
    f.transport.receipt.mockResolvedValueOnce({ status: 404, rawBody: '{"state":"unknown","error":"sync_result_unknown"}' })
    await f.managed.reconcileReceipt()
    expect(f.image()).toEqual(before); expect(f.managed.status().resultReady).toBe(false)
    expect(f.transport.write).toHaveBeenCalledTimes(1); expect(f.port.ackCloud).not.toHaveBeenCalled()
  })

  it.each(['packet', 'preparation', 'adoption'] as const)('rejects another-tab %s binding before any POST or cancellation', async field => {
    const f = await prepared(); let before = copy(f.image())
    const pending = { ...before.sync.pending! }
    if (field === 'packet') {
      const packet = await buildOwnerSyncRequest({ ...f.request.packet.request, request_id: 'managed-other-tab-0001' })
      pending.requestId = packet.request.request_id; pending.requestHash = packet.requestHash; pending.rawBody = packet.rawBody
      before = { ...before, local: { ...before.local, outbox: { ...before.local.outbox,
        entry: { ...before.local.outbox.entry!, rawBody: packet.rawBody, requestHash: packet.requestHash } } } }
    }
    if (field === 'preparation') pending.preparationHash = 'e'.repeat(64)
    if (field === 'adoption') {
      pending.adoptionId = 'managed-other-adopt-0001'
      before = { ...before, local: { ...before.local, metadata: { ...before.local.metadata,
        adoption: { ...before.local.metadata.adoption!, id: pending.adoptionId } } } }
    }
    const sync = { ...before.sync, pending }; f.replace({ ...before, sync, local: { ...before.local, sync } })
    await expect(f.managed.sendOnce()).rejects.toMatchObject({ code: 'managed_hydrate_required' })
    expect(f.transport.write).not.toHaveBeenCalled(); expect(f.port.transitionCloudDelivery).not.toHaveBeenCalled()
  })

  it('checks the complete preview preimage rather than only unchanged packet identity', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const preview = await f.managed.previewPreparation('managed-prepare-0001'), changed = copy(f.image())
    const metadata = { ...changed.local.metadata, displayTimes: changed.local.metadata.displayTimes.map(row => ({ ...row, updated_at: null })) }
    f.replace({ ...changed, local: { ...changed.local, metadata } })
    await expect(f.managed.commitPreparation(preview, true)).rejects.toMatchObject({ code: 'managed_context_changed' })
    expect(f.port.prepareCloud).not.toHaveBeenCalled(); expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('actual second-handle cancel/reprepare replaces the packet without letting the stale controller send or clear it', async () => {
    const f = await prepared(), other = await openOwnerWorkspace(f.factory, TARGET, { existingOnly: true })
    handles.push(other)
    const expected = await other.readSyncState(f.authority.guard), pending = expected.sync.pending!
    const cancel = await buildOwnerWorkspaceCancelCloudRequest(TARGET, { id: 'managed-other-cancel-0001', expected,
      requestId: pending.requestId, requestHash: pending.requestHash })
    await other.cancelPreparedCloud(cancel, f.authority.guard)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'managed-other-prepare-0001',
      expected: await other.readSyncState(f.authority.guard) })
    const replaced = await other.prepareCloud(request, f.authority.guard)
    await expect(f.managed.sendOnce()).rejects.toMatchObject({ code: 'managed_hydrate_required' })
    expect(f.transport.write).not.toHaveBeenCalled(); expect(f.port.transitionCloudDelivery).not.toHaveBeenCalled()
    expect(await other.readSyncState(f.authority.guard)).toEqual(replaced)
  })

  it('a same-packet competing delivery version cannot be overwritten by a late response from the old attempt', async () => {
    const f = await prepared(), waiting = deferred<ReturnType<typeof success>>()
    f.transport.write.mockImplementationOnce(() => waiting.promise)
    const pending = f.managed.sendOnce()
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledTimes(1))
    const other = await openOwnerWorkspace(f.factory, TARGET, { existingOnly: true }); handles.push(other)
    const expected = await other.readSyncState(f.authority.guard), original = expected.sync.pending!
    const competing = await other.transitionCloudDelivery({ expected, requestId: original.requestId,
      requestHash: original.requestHash, preparationHash: original.preparationHash, nextState: 'unknown' }, f.authority.guard)
    waiting.resolve(success()); await pending
    expect(await other.readSyncState(f.authority.guard)).toEqual(competing)
    expect(f.managed.status().resultReady).toBe(false); expect(f.port.ackCloud).not.toHaveBeenCalled()
    expect(f.transport.write).toHaveBeenCalledTimes(1)
    await f.managed.reconcileReceipt()
    expect((await other.readSyncState(f.authority.guard)).local.outbox.entry!.state).toBe('confirmed')
  })
})

describe('matched response, complete fixed-upper D, explicit preview and strict ACK', () => {
  it('never ACKs POST partial data, requires complete pull and preview, then resets memory without another transition/CAS/POST', async () => {
    const f = await confirmed()
    expect(f.image().sync.base!.pulledRevision).toBe(1)
    await expect(f.managed.previewAcknowledgement('managed-ack-0001')).rejects.toMatchObject({ code: 'managed_pull_required' })
    await f.managed.hydrate(); await f.managed.reconcileReceipt()
    f.transport.changes.mockResolvedValueOnce(page([record(7, 2)])); await f.managed.pullComplete()
    const preview = await f.managed.previewAcknowledgement('managed-ack-0001')
    expect(preview.request).not.toBeNull(); expect(preview.preview.baseD!.pulledRevision).toBe(2)
    const transitions = f.port.transitionCloudDelivery.mock.calls.length, before = copy(f.image())
    const after = await f.managed.commitAcknowledgement(preview.request!, true)
    expect(f.port.ackCloud).toHaveBeenCalledTimes(1); expect(f.port.transitionCloudDelivery).toHaveBeenCalledTimes(transitions)
    expect(after.local.outbox.entry).toBeNull(); expect(after.sync.pending).toBeNull()
    expect(after.sync.base).toEqual(preview.preview.baseD)
    expect(after.local.snapshot.localVersion).toBe(before.local.snapshot.localVersion + 1)
    expect(after.local.snapshot.entries.every(entry => entry.local_pending)).toBe(true)
    expect(f.managed.status()).toMatchObject({ state: 'idle', completeReady: false, resultReady: false, uncertainLocal: null })
    expect(f.transport.write).toHaveBeenCalledTimes(1)
    await expect(f.managed.commitAcknowledgement(preview.request!, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.ackCloud).toHaveBeenCalledTimes(1)
  })

  it('409 requires an explicit actual three-way choice before generating/applying an ACK', async () => {
    const f = await prepared(); f.transport.write.mockResolvedValueOnce(conflict()); await f.managed.sendOnce()
    f.transport.changes.mockResolvedValueOnce(page([record(12, 2)])); await f.managed.pullComplete()
    const unresolved = await f.managed.previewAcknowledgement('managed-ack-0001')
    expect(unresolved.request).toBeNull(); expect(unresolved.preview.nextSnapshot).toBeNull()
    expect(unresolved.preview.conflicts).toMatchObject([{ key: KEY, field: 'shares', choice: null }])
    const chosen = await f.managed.previewAcknowledgement('managed-ack-0001', [{ key: KEY, field: 'shares', choice: 'local' }])
    expect(chosen.preview.nextSnapshot!.entries[0].values.shares).toBe(7)
    const after = await f.managed.commitAcknowledgement(chosen.request!, true)
    expect(after.sync.base!.records[0].values.shares).toBe(12)
    expect(after.local.snapshot.entries[0].values.shares).toBe(7)
    expect(after.local.snapshot.entries[0].local_pending).toBe(true)
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('after reload a persisted confirmed slot needs this-session matching receipt before ACK', async () => {
    const f = await confirmed(), reloaded = f.create(); reloaded.setCloudConsent(true); await reloaded.hydrate()
    f.transport.changes.mockResolvedValueOnce(page([record(7, 2)])); await reloaded.pullComplete()
    await expect(reloaded.previewAcknowledgement('managed-ack-0001')).rejects.toMatchObject({ code: 'managed_result_required' })
    expect(f.port.ackCloud).not.toHaveBeenCalled()
    await reloaded.hydrate(); await reloaded.reconcileReceipt()
    f.transport.changes.mockResolvedValueOnce(page([record(7, 2)])); await reloaded.pullComplete()
    expect((await reloaded.previewAcknowledgement('managed-ack-0001')).request).not.toBeNull()
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('another handle finishing the exact ACK invalidates the old preview without invoking ACK again', async () => {
    const f = await confirmed(); f.transport.changes.mockResolvedValueOnce(page([record(7, 2)])); await f.managed.pullComplete()
    const { request } = await f.managed.previewAcknowledgement('managed-ack-0001')
    const other = await openOwnerWorkspace(f.factory, TARGET, { existingOnly: true }); handles.push(other)
    const committed = await other.ackCloud(request!, f.authority.guard)
    await expect(f.managed.commitAcknowledgement(request!, true)).rejects.toMatchObject({ code: 'managed_hydrate_required' })
    expect(f.port.ackCloud).not.toHaveBeenCalled(); expect(await other.readSyncState(f.authority.guard)).toEqual(committed)
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('retains observed head across failed stale-D pulls within the same generation (regression)', async () => {
    const f = await confirmed(); f.transport.changes.mockResolvedValueOnce(page([record(7, 5)])); await f.managed.pullComplete()
    f.transport.changes.mockResolvedValueOnce(page([record(7, 3)]))
    await expect(f.managed.pullComplete()).rejects.toBeDefined()
    await f.managed.hydrate(); await f.managed.reconcileReceipt()
    f.transport.changes.mockResolvedValueOnce(page([record(7, 3)]))
    await expect(f.managed.pullComplete()).rejects.toBeDefined()
    expect(f.managed.status().completeReady).toBe(false); expect(f.port.ackCloud).not.toHaveBeenCalled()
  })

  it('a validated fixed-upper partial page still raises the head floor when a later page fails', async () => {
    const f = await confirmed(), first = Array.from({ length: 200 }, (_, index) => record(7, 2,
      { key: String(index + 1).padStart(6, '0') + '::synthetic-page' })), cursor = [2, first.at(-1)!.key] as const
    f.transport.changes.mockResolvedValueOnce(page(first, 5, cursor)).mockResolvedValueOnce({ status: 503, rawBody: '{}' })
    await expect(f.managed.pullComplete()).rejects.toBeDefined()
    await f.managed.hydrate(); await f.managed.reconcileReceipt()
    f.transport.changes.mockResolvedValueOnce(page([record(7, 3)]))
    await expect(f.managed.pullComplete()).rejects.toBeDefined()
    expect(f.managed.status().completeReady).toBe(false); expect(f.port.ackCloud).not.toHaveBeenCalled()
  })

  it('fixed-upper 200-row partial pages do not create a complete-D ACK until the final page is validated', async () => {
    const f = await confirmed(), waiting = deferred<ReturnType<typeof page>>()
    const first = Array.from({ length: 200 }, (_, index) => record(7, 2, { key: String(index + 1).padStart(6, '0') + '::synthetic-page' })),
      cursor = [2, first.at(-1)!.key] as const
    f.transport.changes.mockResolvedValueOnce(page(first, 3, cursor)).mockImplementationOnce(() => waiting.promise)
    const pending = f.managed.pullComplete()
    await vi.waitFor(() => expect(f.transport.changes).toHaveBeenCalledTimes(2))
    expect(f.managed.status().completeReady).toBe(false); expect(f.port.ackCloud).not.toHaveBeenCalled()
    expect(f.transport.changes.mock.calls.map(call => call[0])).toEqual([
      { sinceRevision: 0, limit: 200 }, { sinceRevision: 0, upperRevision: 3, cursor, limit: 200 },
    ])
    waiting.resolve(page([record(7, 3)], 3)); await pending
    expect(f.managed.status().completeReady).toBe(true)
  })
})

describe('whole-operation deadline and local uncertainty without replay', () => {
  it('12s budget covers the entire operation, ignores uncooperative late completion and blocks parallel operations', async () => {
    const f = await prepared(), waiting = deferred<ReturnType<typeof success>>()
    vi.useFakeTimers(); f.transport.write.mockImplementationOnce(() => waiting.promise)
    const pending = f.managed.sendOnce(), rejected = expect(pending).rejects.toMatchObject({ code: 'managed_timeout' })
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledTimes(1))
    await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_busy' })
    await vi.advanceTimersByTimeAsync(12_000); await rejected
    waiting.resolve(success()); await Promise.resolve(); await Promise.resolve()
    expect(f.image().local.outbox.entry!.state).toBe('attempted'); expect(f.managed.status().resultReady).toBe(false)
    expect(f.transport.write).toHaveBeenCalledTimes(1); expect(f.port.ackCloud).not.toHaveBeenCalled()
  })

  it('lost local preparation response retains exact id/hash and requires manual local receipt, not prepare replay', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('managed-prepare-0001'), original = f.port.prepareCloud.getMockImplementation()!
    f.port.prepareCloud.mockImplementationOnce(async (...parameters) => { await original(...parameters); throw wsError('workspace_unavailable') })
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: { operation: 'prepare', id: request.id, hash: request.hash } })
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_local_unknown' })
    const actual = await f.managed.reconcileLocal(request.id, request.hash)
    expect(actual.state).toBe('matched'); expect(f.managed.status()).toMatchObject({ state: 'prepared', uncertainLocal: null })
    expect(f.port.prepareCloud).toHaveBeenCalledTimes(1); expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('the same 12s budget includes preflight storage time, rather than restarting at POST', async () => {
    const f = await prepared(), waiting = deferred<ReturnType<typeof success>>(), read = f.port.readSyncState.getMockImplementation()!
    vi.useFakeTimers(); const started = Date.now()
    f.port.readSyncState.mockImplementationOnce(async guard => {
      await new Promise(resolve => setTimeout(resolve, 8_000)); return read(guard)
    })
    f.transport.write.mockImplementationOnce(() => waiting.promise)
    const pending = f.managed.sendOnce(), rejected = expect(pending).rejects.toMatchObject({ code: 'managed_timeout' })
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(Math.max(0, started + 11_999 - Date.now()))
    expect(f.managed.status().busy).toBe(true)
    await vi.advanceTimersByTimeAsync(1); await rejected
    waiting.resolve(success()); await Promise.resolve()
    expect(f.image().local.outbox.entry!.state).toBe('attempted')
    expect(f.port.ackCloud).not.toHaveBeenCalled()
  })

  it('a successful local prepare followed by failed hydrate retains the same receipt until the whole operation succeeds', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('managed-prepare-0001'), prepare = f.port.prepareCloud.getMockImplementation()!
    f.port.prepareCloud.mockImplementationOnce(async (...args) => {
      const value = await prepare(...args); f.port.readSyncState.mockRejectedValueOnce(new Error('synthetic hydrate failed')); return value
    })
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: { id: request.id, hash: request.hash } })
    f.port.readSyncState.mockRejectedValueOnce(new Error('synthetic receipt hydrate failed'))
    await expect(f.managed.reconcileLocal(request.id, request.hash)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect(f.managed.status().uncertainLocal).toMatchObject({ id: request.id, hash: request.hash })
    expect((await f.managed.reconcileLocal(request.id, request.hash)).state).toBe('matched')
    expect(f.managed.status()).toMatchObject({ state: 'prepared', uncertainLocal: null })
    expect(f.port.prepareCloud).toHaveBeenCalledTimes(1); expect(f.transport.write).not.toHaveBeenCalled()
  })

  it.each(['lost-ack-response', 'lost-reset-read'] as const)('actual ACK commit followed by %s is local-unknown and only a matching local receipt closes it', async fault => {
    const f = await confirmed(); f.transport.changes.mockResolvedValueOnce(page([record(7, 2)])); await f.managed.pullComplete()
    const { request } = await f.managed.previewAcknowledgement('managed-ack-0001'), ack = f.port.ackCloud.getMockImplementation()!
    f.port.ackCloud.mockImplementationOnce(async (...args) => {
      const value = await ack(...args)
      if (fault === 'lost-ack-response') throw wsError('workspace_unavailable')
      f.port.readSyncState.mockRejectedValueOnce(new Error('synthetic reset read failed')); return value
    })
    await expect(f.managed.commitAcknowledgement(request!, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect((await f.workspace.readSyncState(f.authority.guard)).local.outbox.entry).toBeNull()
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: { id: request!.id, hash: request!.hash } })
    await expect(f.managed.commitAcknowledgement(request!, true)).rejects.toMatchObject({ code: 'managed_local_unknown' })
    expect((await f.managed.reconcileLocal(request!.id, request!.hash)).state).toBe('matched')
    expect(f.managed.status()).toMatchObject({ state: 'idle', uncertainLocal: null, resultReady: false, completeReady: false })
    expect(f.port.ackCloud).toHaveBeenCalledTimes(1); expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('missing local receipt stays unknown; export returns original bytes without triggering cloud or clearing state', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('managed-prepare-0001')
    f.port.prepareCloud.mockRejectedValueOnce(wsError('workspace_unavailable'))
    await expect(f.managed.commitPreparation(request, true)).rejects.toBeDefined()
    f.port.syncReceipt.mockResolvedValueOnce({ state: 'unknown' })
    expect(await f.managed.reconcileLocal(request.id, request.hash)).toEqual({ state: 'unknown' })
    expect(f.managed.status().state).toBe('local_unknown')
    expect(await f.managed.exportPending()).toBeNull()
    expect(f.port.prepareCloud).toHaveBeenCalledTimes(1); expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('definitive pre-write conflict is not treated as local unknown and cannot trigger replay', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('managed-prepare-0001')
    f.port.prepareCloud.mockRejectedValueOnce(new OwnerWorkspaceError('workspace_conflict'))
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect(f.managed.status().uncertainLocal).toBeNull(); expect(f.port.prepareCloud).toHaveBeenCalledTimes(1)
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.prepareCloud).toHaveBeenCalledTimes(1)
  })
})
