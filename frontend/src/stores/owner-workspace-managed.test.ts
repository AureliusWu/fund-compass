import { createHash } from 'node:crypto'
/** Synthetic injected IDB only: no browser, cloud, transport or release proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspacePrepareCloudRequest, buildOwnerWorkspaceCancelCloudRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceSyncState,
} from './owner-workspace'
import {
  openOwnerSyncOutbox, OWNER_SYNC_OUTBOX_DB_PREFIX, OWNER_SYNC_OUTBOX_SCHEMA,
  type OwnerSyncOutbox,
} from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, type OwnerWorkspaceSourceArchive } from '@/utils/owner-workspace-backup'
import { buildOwnerSyncRequest, restoreOwnerSyncRequest, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'
import type { OwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'

import { buildOwnerWorkspaceAckCloudRequest, type OwnerWorkspaceAckCloudInput } from './owner-workspace-delivery'
import type { OwnerSyncOutboxState } from './ownerSyncOutbox'

const TARGET = 'c'.repeat(64)
const KEY = '000001::账户一'
const handles: Array<OwnerWorkspace | OwnerSyncOutbox> = []
const forbidden = vi.fn(() => { throw new Error('synthetic ambient IO forbidden') })

beforeEach(() => {
  forbidden.mockClear()
  vi.stubGlobal('fetch', forbidden)
  vi.stubGlobal('indexedDB', { open: forbidden })
  vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden })
})
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
function context() {
  const controller = new AbortController(), state = { active: true }
  const guard: OwnerWorkspaceGuard = { signal: controller.signal,
    assertActive() { if (!state.active) throw new Error('synthetic context revoked') } }
  return { controller, state, guard }
}
function archive(extra = false): OwnerWorkspaceSourceArchive {
  const rows = [{ code: '000001', name: '合成基金', account: '账户一', position_kind: 'holding',
    shares: 0, cost: null, target_weight: null, updated_at: '2026-10-22T00:00:00Z' },
  ...(extra ? [{ code: '000002', name: '仅本机关注', account: '本机', position_kind: 'watch',
    shares: null, cost: null, target_weight: null, updated_at: '2026-10-21T00:00:00Z' }] : [])]
  return { sourceKey: 'sinan_watchlist_v2', v1Raw: 'unselected synthetic old archive', v2Raw: JSON.stringify(rows) }
}
function fund(key = KEY, shares = 0): OwnerSyncRecord {
  return { key, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: key === KEY ? '合成基金' : '仅云端持仓', shares, cost: null, target_weight: null } }
}
function baseline(): OwnerSyncBaseline {
  return { pulledRevision: 1, records: [fund(), fund('000003::云账户', 5), {
    key: 'asset:synthetic-cash', kind: 'manual_asset', deleted: false,
    record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: '合成现金', cls: '现金', value: 0, note: null },
  }] }
}
async function rawOpen(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function rawRead<T>(factory: IDBFactory, store: string): Promise<T> {
  const db = await rawOpen(factory)
  try { return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store), request = tx.objectStore(store).get('current')
    let value: T
    request.onsuccess = () => { value = request.result as T }
    tx.oncomplete = () => resolve(value); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function rawWrite(factory: IDBFactory, store: string, value: unknown, remove = false) {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    if (remove) tx.objectStore(store).delete('current'); else tx.objectStore(store).put(value, 'current')
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function rawImage(factory: IDBFactory) {
  const db = await rawOpen(factory)
  try {
    const names = [...db.objectStoreNames]
    return await new Promise<{ version: number; stores: Record<string, unknown[]> }>((resolve, reject) => {
      const tx = db.transaction(names), stores: Record<string, unknown[]> = {}
      for (const name of names) {
        const request = tx.objectStore(name).getAll()
        request.onsuccess = () => { stores[name] = request.result }
      }
      tx.oncomplete = () => resolve({ version: db.version, stores }); tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
async function adopted(extra = false, sourceArchive = archive(extra)) {
  const factory = new IDBFactory(), workspace = await openOwnerWorkspace(factory, TARGET), ctx = context()
  handles.push(workspace)
  const backup = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const request = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'sync-local-adopt-0001',
    expected: await workspace.readLocalState(ctx.guard), sourceArchive, backupSha256: backup.sha256 })
  const local = await workspace.adoptLocal(request, ctx.guard)
  return { factory, workspace, ctx, local }
}
async function upgraded(extra = false, sourceArchive?: OwnerWorkspaceSourceArchive) {
  const current = await adopted(extra, sourceArchive)
  const workspace = await upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.ctx.guard)
  handles.push(workspace)
  return { ...current, workspace }
}
async function linked(extra = false, base = baseline(), sourceArchive?: OwnerWorkspaceSourceArchive) {
  const current = await upgraded(extra, sourceArchive)
  const request = await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'sync-cloud-link-0001',
    expected: await current.workspace.readSyncState(current.ctx.guard), base })
  const linked = await current.workspace.linkCloudBase(request, current.ctx.guard)
  return { ...current, linked, linkRequest: request }
}
async function edit(workspace: OwnerWorkspace, guard: OwnerWorkspaceGuard, shares = 7, id = 'sync-local-edit-0001') {
  const expected = await workspace.readLocalState(guard)
  const previous = expected.snapshot.entries.find(row => row.key === KEY)!
  const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id, expected,
    command: { type: 'save', input: { code: '000001', name: previous.values.name, account: '账户一',
      position_kind: 'holding', shares, cost: previous.values.cost, target_weight: previous.values.target_weight },
    expectedEntry: previous, confirmed: true } })
  return workspace.editLocal(request, guard)
}
async function prepared() {
  const current = await linked()
  await edit(current.workspace, current.ctx.guard)
  const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-cloud-prepare-0001',
    expected: await current.workspace.readSyncState(current.ctx.guard) })
  const value = await current.workspace.prepareCloud(request, current.ctx.guard)
  return { ...current, request, value }
}
async function reopen(factory: IDBFactory) {
  const workspace = await openOwnerWorkspace(factory, TARGET, { existingOnly: true })
  handles.push(workspace); return workspace
}


type Prepared = Awaited<ReturnType<typeof prepared>>
async function move(current: Prepared, nextState: Exclude<OwnerSyncOutboxState, 'prepared'>,
  expected?: OwnerWorkspaceSyncState): Promise<OwnerWorkspaceSyncState> {
  const value = expected ?? await current.workspace.readSyncState(current.ctx.guard), pending = value.sync.pending!
  return current.workspace.transitionCloudDelivery({ expected: value, requestId: pending.requestId,
    requestHash: pending.requestHash, preparationHash: pending.preparationHash, nextState }, current.ctx.guard)
}
async function reach(current: Prepared, state: OwnerSyncOutboxState): Promise<OwnerWorkspaceSyncState> {
  let value = current.value
  if (state !== 'prepared') value = await move(current, 'attempted', value)
  if (state !== 'prepared' && state !== 'attempted') value = await move(current, state, value)
  return value
}
async function ackInput(current: Prepared, conflict = false): Promise<OwnerWorkspaceAckCloudInput> {
  const expected = await reach(current, conflict ? 'conflict' : 'confirmed'), original = fund()
  const post = { ...original, values: { ...original.values, shares: conflict ? 20 : 7 },
    record_revision: 2, field_revisions: { ...original.field_revisions, shares: 2 } }
  const remote = { ...fund('000004::新云账户', 9), record_revision: 2, lifecycle_revision: 2,
    field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }
  const result = conflict ? { error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
    conflicts: [{ key_digest: createHash('sha256').update(KEY).digest('hex').slice(0, 16), fields: ['shares'] }] }
    : { revision: 2, records: [post] }
  return { id: 'managed-ack-0001', expected,
    matchedResult: { source: 'write', requestId: current.request.id, requestHash: current.request.packet.requestHash,
      status: conflict ? 409 : 200, rawBody: JSON.stringify(result) },
    completeBaseline: { pulledRevision: 2, records: [...baseline().records.map(row => row.key === KEY ? post : row), remote] },
    minimumObservedRevision: 2, resolutions: [] }
}
describe('real private-host managed delivery and atomic complete-D acknowledgement (synthetic IDB only)', () => {
  const states: readonly OwnerSyncOutboxState[] = ['prepared', 'attempted', 'unknown', 'confirmed', 'conflict']
  it.each(states.flatMap(from => states.filter(to => to !== 'prepared').map(to => [from, to] as const)))(
    'allows only closed persisted transition %s -> %s without touching snapshot/metadata/sync/receipts', async (from, to) => {
      const current = await prepared(), value = await reach(current, from), before = await rawImage(current.factory)
      const allowed = ({ prepared: ['attempted'], attempted: ['unknown', 'confirmed', 'conflict'],
        unknown: ['confirmed', 'conflict'], confirmed: [], conflict: [] } as Record<string, string[]>)[from].includes(to)
      if (allowed) {
        const after = await move(current, to, value), raw = await rawImage(current.factory)
        expect(after.local.outbox).toEqual({ version: value.local.outbox.version + 1, entry: { ...value.local.outbox.entry!, state: to } })
        expect(after.sync).toEqual(value.sync)
        expect(after.local.snapshot).toEqual(value.local.snapshot); expect(after.local.metadata).toEqual(value.local.metadata)
        for (const store of Object.keys(before.stores).filter(name => name !== 'slot')) expect(raw.stores[store]).toEqual(before.stores[store])
        current.workspace.close()
        expect(await (await reopen(current.factory)).readSyncState(current.ctx.guard)).toEqual(after)
      } else {
        await expect(move(current, to, value)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
        expect(await rawImage(current.factory)).toEqual(before)
      }
      expect(forbidden).not.toHaveBeenCalled()
    })
  it.each(['requestId', 'requestHash', 'preparationHash'] as const)('rejects another original %s without mutation', async field => {
    const current = await prepared(), value = current.value, pending = value.sync.pending!, before = await rawImage(current.factory)
    const request = { expected: value, requestId: pending.requestId, requestHash: pending.requestHash,
      preparationHash: pending.preparationHash, nextState: 'attempted' as const,
      [field]: field === 'requestId' ? 'another-original-0001' : '0'.repeat(64) }
    await expect(current.workspace.transitionCloudDelivery(request, current.ctx.guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    expect(await rawImage(current.factory)).toEqual(before)
  })
  it('rejects a stale fullimage from a second actual tab, never retries unknown or increments epoch', async () => {
    const current = await prepared(), stale = current.value, other = await reopen(current.factory)
    const pending = stale.sync.pending!
    const attempted = await other.transitionCloudDelivery({ expected: stale, requestId: pending.requestId,
      requestHash: pending.requestHash, preparationHash: pending.preparationHash, nextState: 'attempted' }, current.ctx.guard)
    const before = await rawImage(current.factory)
    await expect(move(current, 'attempted', stale)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await rawImage(current.factory)).toEqual(before)
    const unknown = await move(current, 'unknown', attempted)
    await expect(move(current, 'attempted', unknown)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    expect(unknown.sync).toEqual(stale.sync)
  })
  it.each([false, true])('atomically acknowledges complete D and preserves source times, manual data, raw archives and pending (conflict=%s)', async conflict => {
    const current = await prepared(), original = await ackInput(current, conflict)
    const input = { ...original, resolutions: conflict ? [{ key: KEY, field: 'shares' as const, choice: 'local' as const }] : [] }
    const request = await buildOwnerWorkspaceAckCloudRequest(TARGET, input), before = input.expected
    const after = await current.workspace.ackCloud(request, current.ctx.guard)
    expect(after.sync.base).toEqual(input.completeBaseline); expect(after.sync.pending).toBeNull()
    expect(after.sync.epoch).toBe(before.sync.epoch + 1)
    expect(after.sync.recentReceipt).toEqual({ id: request.id, hash: request.hash, operation: 'ack',
      syncEpoch: after.sync.epoch, outboxVersion: before.local.outbox.version + 1, localVersion: before.local.snapshot.localVersion + 1 })
    expect(after.local.outbox).toEqual({ version: before.local.outbox.version + 1, entry: null })
    expect(after.local.snapshot.localVersion).toBe(before.local.snapshot.localVersion + 1)
    expect(after.local.snapshot.entries.every(row => row.local_pending)).toBe(true)
    expect(after.local.snapshot.entries.find(row => row.key === KEY)?.values).toEqual({ name: '合成基金', shares: 7, cost: null, target_weight: null })
    expect(after.local.metadata.adoption).toEqual(before.local.metadata.adoption)
    expect(after.local.metadata.restoredArchives).toEqual(before.local.metadata.restoredArchives)
    expect(after.local.metadata.displayTimes.find(row => row.key === KEY)?.updated_at)
      .toBe(before.local.metadata.displayTimes.find(row => row.key === KEY)?.updated_at)
    expect(after.local.metadata.displayTimes.find(row => row.key === '000004::新云账户')?.updated_at).toBeNull()
    expect(after.local.snapshot.entries.some(row => row.key.startsWith('asset:'))).toBe(false)
    expect(after.local.metadata.recentEdit).toMatchObject({ id: request.id, hash: request.hash })
    expect(await current.workspace.syncReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value: after })
    expect(await current.workspace.localReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value: after.local })
    current.workspace.close()
    expect(await (await reopen(current.factory)).readSyncState(current.ctx.guard)).toEqual(after)
    // A later pending image must still restore its original envelope from the ack receipt.
    if (conflict) {
      const workspace = await reopen(current.factory)
      const next = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'managed-next-0001', expected: after })
      const pending = await workspace.prepareCloud(next, current.ctx.guard)
      expect(pending.sync.recentReceipt?.operation).toBe('ack')
      expect(await workspace.readSyncState(current.ctx.guard)).toEqual(pending)
    }
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('refuses unresolved, mismatched or resealed ACKs and old prepared cancellation, preserving every store', async () => {
    const current = await prepared(), input = await ackInput(current, true), before = await rawImage(current.factory)
    await expect(buildOwnerWorkspaceAckCloudRequest(TARGET, input)).rejects.toMatchObject({ code: 'ack_unresolved' })
    const request = await buildOwnerWorkspaceAckCloudRequest(TARGET, { ...input, resolutions: [{ key: KEY, field: 'shares', choice: 'cloud' }] })
    await expect(current.workspace.ackCloud({ ...request, hash: '0'.repeat(64) }, current.ctx.guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    await expect(current.workspace.ackCloud({ ...request, matchedResult: { ...request.matchedResult, requestHash: '0'.repeat(64) } },
      current.ctx.guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    await expect(buildOwnerWorkspaceCancelCloudRequest(TARGET, { id: 'managed-cancel-0001', expected: input.expected,
      requestId: current.request.id, requestHash: current.request.packet.requestHash })).rejects.toMatchObject({ code: 'workspace_pending' })
    expect(await rawImage(current.factory)).toEqual(before)
  })
  it.each(['quota', 'abort', 'revoke'] as const)('rolls back all ACK stores on %s during the strict writer', async fault => {
    const current = await prepared(), input = await ackInput(current), request = await buildOwnerWorkspaceAckCloudRequest(TARGET, input)
    const before = await rawImage(current.factory), put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (fault === 'abort' && this.name === 'sync_metadata') {
        const result = put.call(this, value, key); this.transaction.abort(); return result
      }
      if (this.name === 'working_copy') {
        if (fault === 'quota') throw new DOMException('synthetic quota', 'QuotaExceededError')
        if (fault === 'revoke') current.ctx.controller.abort()
      }
      return put.call(this, value, key)
    })
    await expect(current.workspace.ackCloud(request, current.ctx.guard)).rejects.toMatchObject({
      code: fault === 'quota' ? 'workspace_quota' : fault === 'abort' ? 'workspace_aborted' : 'workspace_context_changed' })
    vi.restoreAllMocks()
    expect(await rawImage(current.factory)).toEqual(before)
  })
  it('rejects ignored strict durability before any delivery write', async () => {
    const current = await prepared(), before = await rawImage(current.factory), transaction = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function(this: IDBDatabase, ...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args)
      if (args[1] === 'readwrite') Object.defineProperty(tx, 'durability', { value: 'default' })
      return tx
    })
    await expect(move(current, 'attempted')).rejects.toMatchObject({ code: 'workspace_unavailable' })
    vi.restoreAllMocks()
    expect(await rawImage(current.factory)).toEqual(before)
  })
})
