/** Independent managed-controller review reproductions; no real IO. */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOwnerWorkspaceSync } from './ownerWorkspaceSync'
import { OwnerWorkspaceError } from './owner-workspace'
import type { OwnerWorkspaceGuard, OwnerWorkspacePrepareCloudRequest, OwnerWorkspaceSyncState } from './owner-workspace-types'
import type { BuiltOwnerSyncRequest, OwnerSyncRecord } from '@/utils/ownerSyncContract'
import type { OwnerSyncCandidateTransport } from './ownerSyncCandidate'
import type { OwnerWorkspaceDeliveryRequest } from './owner-workspace-delivery'

const TARGET = 'a'.repeat(64), KEY = '000001::synthetic-account'
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function record(key = KEY, revision = 1): OwnerSyncRecord {
  return { key, kind: 'holding', deleted: false, record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: revision, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null } }
}
function linked(): OwnerWorkspaceSyncState {
  const base = { pulledRevision: 1, records: [record()] }, snapshot = { localVersion: 7, legacy: null,
    entries: [{ key: KEY, kind: 'holding', deleted: false,
      values: { ...record().values, cost: 8 }, local_pending: true }] }
  const sync = { schema: 'owner-workspace-sync-1', targetFingerprint: TARGET, epoch: 1, base, pending: null,
    recentReceipt: { id: 'synthetic-link-0001', hash: 'f'.repeat(64), operation: 'link', syncEpoch: 1,
      outboxVersion: 2, localVersion: 7 } }
  return { local: { snapshot, outbox: { version: 2, entry: null }, receiptCount: 3, sync,
    metadata: { schema: 'owner-workspace-local-1', adoption: { id: 'synthetic-adopt-0001', hash: 'b'.repeat(64),
      backupSha256: 'c'.repeat(64), sourceArchive: { sourceKey: null, v1Raw: null, v2Raw: null }, localVersion: 7 },
      displayTimes: [{ key: KEY, updated_at: null }], recentEdit: null, restoredArchives: [] } }, sync } as unknown as OwnerWorkspaceSyncState
}
// A complete D at a nonzero head must include its latest revision. Advancing
// the name stamp with the same value represents a real name ABA; merely
// changing upper while every record stays at revision1 is not a complete D.
function page(upper: number, records = [record(KEY, upper)]) {
  return { status: 200, rawBody: JSON.stringify({ upper_revision: upper, changes: records, next_cursor: null, complete: true }) }
}
function fixture() {
  let image = linked(), session = { authenticated: true, generation: 1 }
  const workspace = {
    targetFingerprint: TARGET,
    readSyncState: vi.fn(async () => structuredClone(image)),
    linkCloudBase: vi.fn(async () => { throw new OwnerWorkspaceError('workspace_invalid_input') }),
    prepareCloud: vi.fn(async (_request: OwnerWorkspacePrepareCloudRequest, _guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState> => {
      throw new OwnerWorkspaceError('workspace_invalid_input')
    }),
    cancelPreparedCloud: vi.fn(async () => { throw new OwnerWorkspaceError('workspace_invalid_input') }),
    transitionCloudDelivery: vi.fn(async (_request: OwnerWorkspaceDeliveryRequest, _guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState> => {
      throw new OwnerWorkspaceError('workspace_invalid_input')
    }),
    ackCloud: vi.fn(async () => { throw new OwnerWorkspaceError('workspace_invalid_input') }),
    syncReceipt: vi.fn(async () => ({ state: 'unknown' as const })),
  }
  const transport = { targetFingerprint: TARGET,
    write: vi.fn(async (_packet: BuiltOwnerSyncRequest, _signal: AbortSignal) => ({ status: 500, rawBody: '{}' })),
    receipt: vi.fn(async () => ({ status: 500, rawBody: '{}' })),
    changes: vi.fn(async (_parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0], _signal: AbortSignal) => page(1)),
  }
  const authority = new AbortController()
  const managed = createOwnerWorkspaceSync({ workspace, transport, session: () => session,
    guard: () => ({ signal: authority.signal, assertActive() { if (authority.signal.aborted) throw new Error('revoked') } }) })
  return { managed, workspace, transport, authority, image: () => structuredClone(image),
    setImage(value: OwnerWorkspaceSyncState) { image = value },
    setSession(value: typeof session) { session = value } }
}
function preparationImage(request: OwnerWorkspacePrepareCloudRequest): OwnerWorkspaceSyncState {
  const image = structuredClone(request.expected), version = image.local.outbox.version + 1,
    entry = { schema: 'owner-sync-outbox-1', state: 'prepared', rawBody: request.packet.rawBody, requestHash: request.packet.requestHash },
    adoption = image.local.metadata.adoption!
  Object.assign(image.local.outbox, { version, entry })
  Object.assign(image.sync, { epoch: image.sync.epoch + 1, pending: { requestId: request.id, requestHash: request.packet.requestHash,
    rawBody: request.packet.rawBody, preparationHash: request.hash, preimageHash: 'd'.repeat(64),
    adoptionId: adoption.id, adoptionHash: adoption.hash, localVersion: image.local.snapshot.localVersion,
    preparedOutboxVersion: version, baseRevision: image.sync.base!.pulledRevision } })
  return image
}
async function prepared() {
  const f = fixture(); f.managed.setCloudConsent(true)
  const request = await f.managed.previewPreparation('synthetic-prepare-0001')
  f.workspace.prepareCloud.mockImplementationOnce(async actual => {
    const image = preparationImage(actual); f.setImage(image); return image
  })
  await f.managed.commitPreparation(request, true)
  return { ...f, request }
}

describe('independent managed-controller review boundary', () => {
  it('rejects accessor preview envelopes before invoking getters or any local writer', async () => {
    const f = fixture(); f.managed.setCloudConsent(true)
    const request = await f.managed.previewPreparation('synthetic-prepare-0001'), getter = vi.fn(() => request.hash),
      supplied = structuredClone(request)
    Object.defineProperty(supplied, 'hash', { enumerable: true, get: getter })
    await expect(f.managed.commitPreparation(supplied, true)).rejects.toBeDefined()
    expect(getter).not.toHaveBeenCalled()
    expect(f.workspace.prepareCloud).not.toHaveBeenCalled()
    expect(f.managed.status().uncertainLocal).toBeNull()
  })

  it('retains a fully parsed completed D head even when exact local preimage checks fail after the GET', async () => {
    const f = fixture(); f.managed.setCloudConsent(true)
    const changed = f.image()
    f.transport.changes.mockImplementationOnce(async () => {
      // Another local receipt arrives while a complete current-session read is in flight.
      Object.assign(changed.local, { receiptCount: 4 })
      f.setImage(changed)
      return page(10)
    })
    await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_context_changed' })
    f.transport.changes.mockImplementationOnce(async () => page(9))
    await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_pull_required' })
    expect(f.managed.status().completeReady).toBe(false)
    expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('retains a strictly parsed partial pagination upper as a head floor without claiming a complete D', async () => {
    const f = fixture(); f.managed.setCloudConsent(true)
    const records = Array.from({ length: 200 }, (_, index) => record(String(index + 1).padStart(6, '0') + '::synthetic-account'))
    f.transport.changes.mockImplementationOnce(async () => ({ status: 200, rawBody: JSON.stringify({ upper_revision: 10,
      changes: records, next_cursor: [1, records[199].key], complete: false }) }))
      .mockImplementationOnce(async () => ({ status: 500, rawBody: '{}' }))
    await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect(f.transport.changes).toHaveBeenCalledTimes(2)
    expect(f.managed.status().completeReady).toBe(false)
    f.transport.changes.mockImplementationOnce(async () => page(9))
    await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_pull_required' })
    expect(f.transport.write).not.toHaveBeenCalled()
  })

  it('immediately aborts read-only HTTP when the captured authority signal is revoked', async () => {
    const f = fixture(); f.managed.setCloudConsent(true)
    let started!: () => void, observedSignal: AbortSignal | null = null
    const ready = new Promise<void>(resolve => { started = resolve })
    f.transport.changes.mockImplementationOnce(async (_parameters?: unknown, signal?: AbortSignal) => {
      observedSignal = signal!; started(); return new Promise<never>(() => {})
    })
    const work = f.managed.pullComplete(); await ready
    f.authority.abort()
    await expect(work).rejects.toMatchObject({ code: 'managed_context_changed' })
    expect(observedSignal!.aborted).toBe(true)
    expect(f.managed.status().completeReady).toBe(false)
    expect(f.transport.write).not.toHaveBeenCalled()
  })

  it.each(['write', 'receipt'] as const)('retains a semantic matched %s 200 head when persisting confirmed delivery loses a local CAS', async source => {
    const f = await prepared(), attemptedStates: string[] = []
    const result = { revision: 10,
      records: [{ ...record(), record_revision: 10, field_revisions: { ...record().field_revisions, cost: 10 },
        values: { ...record().values, cost: 8 } }] }
    if (source === 'write') f.transport.write.mockImplementationOnce(async () => ({ status: 200, rawBody: JSON.stringify(result) }))
    else {
      const image = f.image()
      Object.assign(image.local.outbox, { version: image.local.outbox.version + 1,
        entry: { ...image.local.outbox.entry, state: 'unknown' } })
      f.setImage(image)
      f.transport.receipt.mockImplementationOnce(async () => ({ status: 200,
        rawBody: JSON.stringify({ state: 'matched', status: 200, result }) }))
    }
    f.workspace.transitionCloudDelivery.mockImplementation(async request => {
      attemptedStates.push(request.nextState)
      if (request.nextState === 'confirmed') throw new OwnerWorkspaceError('workspace_conflict')
      const image = f.image()
      Object.assign(image.local.outbox, { version: image.local.outbox.version + 1,
        entry: { ...image.local.outbox.entry, state: request.nextState } })
      f.setImage(image); return image
    })
    const unknown = await (source === 'write' ? f.managed.sendOnce() : f.managed.reconcileReceipt())
    expect(unknown.local.outbox.entry!.state).toBe('unknown')
    expect(attemptedStates).toEqual(source === 'write' ? ['attempted', 'confirmed', 'unknown'] : ['confirmed'])
    expect(f.transport.write).toHaveBeenCalledTimes(source === 'write' ? 1 : 0)
    f.transport.changes.mockImplementationOnce(async () => page(9))
    // The candidate can now reject its remembered head first; otherwise the
    // managed floor rejects it. Both are failures, never accepted lower D.
    await expect(f.managed.pullComplete()).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:managed_pull_required|managed_unavailable)$/),
    })
    expect(f.managed.status().completeReady).toBe(false)
    expect(f.transport.write).toHaveBeenCalledTimes(source === 'write' ? 1 : 0)
  })

  it.each(['changed-value', 'wrong-key', 'wrong-deletion', 'missing-live-result'])('does not treat a structurally valid but semantically false POST as an observed head (%s)', async fault => {
    const f = await prepared(), result = { revision: 10,
      records: [{ ...record(), record_revision: 10, field_revisions: { ...record().field_revisions, cost: 10 },
        values: { ...record().values, cost: 8 } }] }
    if (fault === 'changed-value') result.records[0].values.cost = 999
    if (fault === 'wrong-key') result.records[0].key = '000002::synthetic-other'
    if (fault === 'wrong-deletion') result.records[0].deleted = true
    if (fault === 'missing-live-result') result.records = []
    f.transport.write.mockImplementationOnce(async () => ({ status: 200, rawBody: JSON.stringify(result) }))
    f.workspace.transitionCloudDelivery.mockImplementation(async request => {
      const image = f.image()
      Object.assign(image.local.outbox, { version: image.local.outbox.version + 1,
        entry: { ...image.local.outbox.entry, state: request.nextState } })
      f.setImage(image); return image
    })
    expect((await f.managed.sendOnce()).local.outbox.entry!.state).toBe('unknown')
    f.transport.changes.mockImplementationOnce(async () => page(9))
    expect((await f.managed.pullComplete()).pulledRevision).toBe(9)
    expect(f.transport.write).toHaveBeenCalledTimes(1)
  })

  it('retains the original local preparation envelope id/hash when its successful persistence is followed by failed hydration', async () => {
    const f = fixture(); f.managed.setCloudConsent(true)
    const request = await f.managed.previewPreparation('synthetic-prepare-0001')
    f.workspace.prepareCloud.mockImplementationOnce(async actual => {
      const image = preparationImage(actual); f.setImage(image)
      f.workspace.readSyncState.mockRejectedValueOnce(new Error('synthetic lost read after commit'))
      return image
    })
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: {
      operation: 'prepare', id: request.id, hash: request.hash } })
    await expect(f.managed.reconcileLocal(request.id, request.packet.requestHash)).rejects.toMatchObject({ code: 'managed_local_unknown' })
    expect(f.workspace.syncReceipt).not.toHaveBeenCalled()
    const original = await f.managed.exportPending()
    expect(original).toMatchObject({ requestId: request.id, requestHash: request.packet.requestHash,
      rawBody: request.packet.rawBody, preparationHash: request.hash, state: 'prepared' })
    expect(f.managed.status().uncertainLocal).toEqual({ operation: 'prepare', id: request.id, hash: request.hash })
    expect(f.transport.write).not.toHaveBeenCalled()
    expect(f.workspace.prepareCloud).toHaveBeenCalledTimes(1)
  })
})
