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

describe('explicit v4 common-cloud-base and atomic local packet foundation', () => {
  it('keeps normal startup at v3 and upgrades only the explicit adopted original database', async () => {
    const current = await adopted(), before = await rawImage(current.factory)
    expect(before.version).toBe(3)
    expect(Object.keys(before.stores).sort()).toEqual(['import_receipts', 'local_metadata', 'slot', 'working_copy'])
    const workspace = await upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.ctx.guard)
    handles.push(workspace)
    const state = await workspace.readSyncState(current.ctx.guard), after = await rawImage(current.factory)
    expect(after.version).toBe(4)
    expect(Object.keys(after.stores).sort()).toEqual([...Object.keys(before.stores), 'sync_metadata'].sort())
    for (const name of Object.keys(before.stores)) expect(after.stores[name]).toEqual(before.stores[name])
    expect(state.local).toEqual({ ...current.local, sync: state.sync })
    expect(state.sync).toEqual({ schema: 'owner-workspace-sync-1', targetFingerprint: TARGET,
      epoch: 0, base: null, pending: null, recentReceipt: null })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('links a complete base without losing local-only records, manual data, raw archives, zero/null or actual times', async () => {
    const current = await linked(true), { local, sync } = current.linked
    expect(sync.base).toEqual(baseline())
    expect(sync.pending).toBeNull()
    expect(sync.epoch).toBe(1)
    expect(local.snapshot.localVersion).toBe(current.local.snapshot.localVersion + 1)
    expect(local.outbox.version).toBe(current.local.outbox.version + 1)
    expect(local.snapshot.entries.map(row => row.key)).toEqual([KEY, '000002::本机', '000003::云账户'])
    expect(local.snapshot.entries[0].values).toMatchObject({ shares: 0, cost: null, target_weight: null })
    expect(local.metadata.displayTimes.find(row => row.key === KEY)?.updated_at).toBe('2026-10-22T00:00:00Z')
    expect(local.metadata.displayTimes.find(row => row.key === '000003::云账户')?.updated_at).toBeNull()
    expect(local.metadata.adoption?.sourceArchive).toEqual(archive(true))
    expect(await current.workspace.syncReceipt(current.linkRequest.id, current.linkRequest.hash, current.ctx.guard))
      .toEqual({ state: 'matched', value: current.linked })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('derives only genuine B→L changed fields and atomically keeps original packet plus full prepare binding', async () => {
    const current = await linked(), before = current.linked
    await edit(current.workspace, current.ctx.guard, 7)
    const expected = await current.workspace.readSyncState(current.ctx.guard)
    expect(expected.sync.base).toEqual(before.sync.base)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-cloud-prepare-0001', expected })
    expect(request.packet.request.expected_revision).toBe(1)
    expect(request.packet.request.operations).toEqual([{ key: KEY, kind: 'holding', deleted: false,
      changes: { shares: 7 }, base_values: { kind: 'holding', deleted: false, shares: 0 } }])
    const value = await current.workspace.prepareCloud(request, current.ctx.guard)
    expect(value.local.snapshot).toEqual(expected.local.snapshot)
    expect(value.local.metadata).toEqual(expected.local.metadata)
    expect(value.sync.base).toEqual(expected.sync.base)
    expect(value.local.outbox.entry).toEqual({ schema: OWNER_SYNC_OUTBOX_SCHEMA, state: 'prepared',
      rawBody: request.packet.rawBody, requestHash: request.packet.requestHash })
    expect(value.sync.pending).toMatchObject({ requestId: request.id, requestHash: request.packet.requestHash,
      rawBody: request.packet.rawBody, preparationHash: request.hash,
      adoptionId: expected.local.metadata.adoption!.id, adoptionHash: expected.local.metadata.adoption!.hash,
      localVersion: expected.local.snapshot.localVersion, preparedOutboxVersion: value.local.outbox.version, baseRevision: 1 })
    expect(await restoreOwnerSyncRequest(value.sync.pending!.rawBody, value.sync.pending!.requestHash)).toEqual(request.packet)
    expect(await current.workspace.syncReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value })
    expect(await current.workspace.syncReceipt('sync-cloud-absent-0001', request.hash, current.ctx.guard)).toEqual({ state: 'unknown' })
  })

  it('cancels only the exact unsent packet atomically and retains common base plus latest local receipt', async () => {
    const current = await prepared()
    const request = await buildOwnerWorkspaceCancelCloudRequest(TARGET, { id: 'sync-cloud-cancel-0001',
      expected: current.value, requestId: current.request.id, requestHash: current.request.packet.requestHash })
    const value = await current.workspace.cancelPreparedCloud(request, current.ctx.guard)
    expect(value.local.outbox).toEqual({ version: current.value.local.outbox.version + 1, entry: null })
    expect(value.local.snapshot).toEqual(current.value.local.snapshot)
    expect(value.sync.base).toEqual(current.value.sync.base)
    expect(value.sync.pending).toBeNull()
    expect(value.sync.epoch).toBe(current.value.sync.epoch + 1)
    expect(await current.workspace.syncReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value })
    expect(await current.workspace.syncReceipt(current.request.id, current.request.hash, current.ctx.guard)).toEqual({ state: 'unknown' })
  })

  it('serializes two independent handles preparing one old complete image; exactly one original packet survives', async () => {
    const current = await linked()
    await edit(current.workspace, current.ctx.guard)
    const second = await reopen(current.factory), expected = await current.workspace.readSyncState(current.ctx.guard)
    const [one, two] = await Promise.all(['sync-race-prepare-0001', 'sync-race-prepare-0002']
      .map(id => buildOwnerWorkspacePrepareCloudRequest(TARGET, { id, expected })))
    const results = await Promise.allSettled([current.workspace.prepareCloud(one, current.ctx.guard), second.prepareCloud(two, current.ctx.guard)])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(1)
    const winner = results[0].status === 'fulfilled' ? one : two
    const value = await second.readSyncState(current.ctx.guard)
    expect(value.sync.pending?.requestId).toBe(winner.id)
    expect(value.local.outbox.entry?.rawBody).toBe(winner.packet.rawBody)
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('rejects a stale full prepare image after another tab edits and leaves the newer complete image intact', async () => {
    const current = await linked(), second = await reopen(current.factory)
    await edit(current.workspace, current.ctx.guard, 7)
    const expected = await current.workspace.readSyncState(current.ctx.guard)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-stale-prepare-0001', expected })
    await edit(second, current.ctx.guard, 8, 'sync-second-edit-0001')
    const before = await rawImage(current.factory)
    await expect(current.workspace.prepareCloud(request, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it('preserves common base exactly through ordinary v4 local edits and existingOnly/default reopen', async () => {
    const current = await linked(), base = structuredClone(current.linked.sync.base)
    await edit(current.workspace, current.ctx.guard, 7)
    expect((await current.workspace.readSyncState(current.ctx.guard)).sync.base).toEqual(base)
    current.workspace.close()
    const one = await reopen(current.factory), two = await openOwnerWorkspace(current.factory, TARGET)
    handles.push(two)
    expect((await one.readSyncState(current.ctx.guard)).sync.base).toEqual(base)
    expect((await two.readSyncState(current.ctx.guard)).sync.base).toEqual(base)
    expect((await rawImage(current.factory)).version).toBe(4)
  })

  it.each(['save', 'remove'] as const)('blocks the actual local %s primitive while a prepared packet exists', async type => {
    const current = await prepared(), expected = await current.workspace.readLocalState(current.ctx.guard)
    const previous = expected.snapshot.entries.find(row => row.key === KEY)!
    const command = type === 'remove' ? { type, keys: [KEY], expectedEntries: [previous], confirmed: true } as const
      : { type, input: { code: '000001', name: '合成基金', account: '账户一', position_kind: 'holding',
        shares: 9, cost: null, target_weight: null }, expectedEntry: previous, confirmed: true } as const
    const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'sync-pending-edit-0001', expected, command })
    const before = await rawImage(current.factory)
    await expect(current.workspace.editLocal(request, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it('retains a real v3 pre-existing packet and refuses explicit upgrade without rewriting it', async () => {
    const factory = new IDBFactory(), old = await openOwnerSyncOutbox(factory, TARGET)
    handles.push(old)
    const packet = await buildOwnerSyncRequest({ request_id: 'sync-legacy-pending-0001', expected_revision: 0,
      operations: [{ key: '000009::旧账户', kind: 'watch', deleted: false, changes: { name: '合成旧提交' }, base_values: {} }] })
    await old.compareAndSwap(0, { schema: OWNER_SYNC_OUTBOX_SCHEMA, state: 'prepared', rawBody: packet.rawBody, requestHash: packet.requestHash })
    const workspace = await openOwnerWorkspace(factory, TARGET), guard = context().guard
    handles.push(workspace)
    const before = await rawImage(factory), expected = await workspace.readLocalState(guard)
    await expect(upgradeOwnerWorkspaceSync(factory, TARGET, expected, guard)).rejects.toBeInstanceOf(Error)
    expect(await rawImage(factory)).toEqual(before)
    expect(before.version).toBe(3)
  })

  it.each(['relaxed', 'default', 'missing', 'throw'] as const)('refuses actual %s strict durability before an upgrade changes v3', async durability => {
    const current = await adopted(), before = await rawImage(current.factory), actual = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite') Object.defineProperty(tx, 'durability', { configurable: true,
        get() { if (durability === 'throw') throw new Error('synthetic durability unavailable'); return durability === 'missing' ? undefined : durability } })
      return tx
    })
    await expect(upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    vi.restoreAllMocks()
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it('does not reconstruct v4 metadata/current after loss through either open path', async () => {
    const current = await upgraded()
    current.workspace.close()
    await rawWrite(current.factory, 'sync_metadata', null, true)
    const before = await rawImage(current.factory)
    await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toBeInstanceOf(Error)
    await expect(openOwnerWorkspace(current.factory, TARGET)).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
    expect(before.stores.sync_metadata).toEqual([])
  })

  it.each(['clear', 'attempt', 'replace'] as const)('rejects the old outbox %s CAS bypass for managed v4 packets', async action => {
    const current = await prepared(), outbox = await openOwnerSyncOutbox(current.factory, TARGET)
    handles.push(outbox)
    const snapshot = await outbox.read(), original = snapshot.entry!
    const next = action === 'clear' ? null : action === 'attempt' ? { ...original, state: 'attempted' as const }
      : { ...original, rawBody: original.rawBody + ' ' }
    const before = await rawImage(current.factory)
    await expect(outbox.compareAndSwap(snapshot.version, next)).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it('never reopens legacy null→prepared CAS just because the physical version became v4', async () => {
    const current = await upgraded(), outbox = await openOwnerSyncOutbox(current.factory, TARGET)
    handles.push(outbox)
    const packet = await buildOwnerSyncRequest({ request_id: 'sync-legacy-bypass-0001', expected_revision: 0,
      operations: [{ key: '000009::旁路', kind: 'watch', deleted: false, changes: { name: '不得发送' }, base_values: {} }] })
    const snapshot = await outbox.read(), before = await rawImage(current.factory)
    await expect(outbox.compareAndSwap(snapshot.version, { schema: OWNER_SYNC_OUTBOX_SCHEMA,
      state: 'prepared', rawBody: packet.rawBody, requestHash: packet.requestHash })).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
    expect(forbidden).not.toHaveBeenCalled()
  })

  it.each(['binding-hash', 'binding-body', 'adoption', 'slot-hash', 'slot-body', 'base'] as const)
    ('refuses %s tampering on a newly reopened pending v4 workspace', async fault => {
      const current = await prepared()
      current.workspace.close()
      if (fault.startsWith('slot-')) {
        const row = await rawRead<{ version: number; resourceFingerprint: string; entry: NonNullable<OwnerWorkspaceSyncState['local']['outbox']['entry']> }>(current.factory, 'slot')
        await rawWrite(current.factory, 'slot', { ...row, entry: { ...row.entry,
          ...(fault === 'slot-hash' ? { requestHash: 'f'.repeat(64) } : { rawBody: row.entry.rawBody + ' ' }) } })
      } else {
        const row = await rawRead<OwnerWorkspaceSyncMetadata>(current.factory, 'sync_metadata')
        const changed = structuredClone(row)
        const value = fault === 'base' ? { ...changed, base: { ...changed.base!, records: changed.base!.records.map(record =>
          record.key === KEY ? { ...record, values: { ...record.values, shares: 99 } } : record) } }
          : { ...changed, pending: { ...changed.pending!, ...(fault === 'binding-hash' ? { preimageHash: 'f'.repeat(64) }
            : fault === 'binding-body' ? { rawBody: changed.pending!.rawBody + ' ' } : { adoptionHash: 'f'.repeat(64) }) } }
        await rawWrite(current.factory, 'sync_metadata', value)
      }
      const before = await rawImage(current.factory)
      await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toBeInstanceOf(Error)
      expect(await rawImage(current.factory)).toEqual(before)
    })

  it('rolls back both slot and sync binding when a successful metadata put is followed by abort', async () => {
    const current = await linked()
    await edit(current.workspace, current.ctx.guard)
    const expected = await current.workspace.readSyncState(current.ctx.guard)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-abort-prepare-0001', expected })
    const before = await rawImage(current.factory), actual = IDBObjectStore.prototype.put
    const reached = vi.fn()
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = actual.call(this, value, key)
      if (this.name === 'sync_metadata') result.addEventListener('success', () => { reached(); this.transaction.abort() })
      return result
    })
    await expect(current.workspace.prepareCloud(request, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    expect(reached).toHaveBeenCalledOnce()
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it('reopens a genuinely committed prepare after the local result is lost and only checks the exact original receipt', async () => {
    const current = await linked()
    await edit(current.workspace, current.ctx.guard)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-commit-lost-0001',
      expected: await current.workspace.readSyncState(current.ctx.guard) })
    const actual = IDBDatabase.prototype.transaction, committed = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite') tx.addEventListener('complete', () => { committed(); current.workspace.close() })
      return tx
    })
    await expect(current.workspace.prepareCloud(request, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    expect(committed).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
    const workspace = await reopen(current.factory), value = await workspace.readSyncState(current.ctx.guard)
    expect(value.sync.pending?.requestId).toBe(request.id)
    expect(await workspace.syncReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value })
    expect(await workspace.syncReceipt('sync-wrong-request-0001', request.hash, current.ctx.guard)).toEqual({ state: 'unknown' })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('rejects a revoked guard before any cloud-base or slot write', async () => {
    const current = await upgraded(), expected = await current.workspace.readSyncState(current.ctx.guard)
    const request = await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'sync-revoked-link-0001', expected, base: baseline() })
    const before = await rawImage(current.factory)
    current.ctx.controller.abort()
    await expect(current.workspace.linkCloudBase(request, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it.each(['initial-transaction', 'successful-add'] as const)
    ('leaves the explicit v4 gap fail-closed after %s abort without repairing old stores', async point => {
      const current = await adopted(), before = await rawImage(current.factory), reached = vi.fn()
      if (point === 'initial-transaction') {
        const actual = IDBDatabase.prototype.transaction
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
          const tx = actual.call(this, names, mode, options)
          if (mode === 'readwrite' && Array.isArray(names) && names.includes('sync_metadata')) {
            reached(); tx.abort()
          }
          return tx
        })
      } else {
        const actual = IDBObjectStore.prototype.add
        vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
          const result = actual.call(this, value, key)
          if (this.name === 'sync_metadata') result.addEventListener('success', () => { reached(); this.transaction.abort() })
          return result
        })
      }
      await expect(upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.ctx.guard)).rejects.toBeInstanceOf(Error)
      expect(reached).toHaveBeenCalledOnce()
      vi.restoreAllMocks()
      const after = await rawImage(current.factory)
      expect(after.version).toBe(4)
      expect(after.stores.sync_metadata).toEqual([])
      for (const name of Object.keys(before.stores)) expect(after.stores[name]).toEqual(before.stores[name])
      await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toBeInstanceOf(Error)
      await expect(openOwnerWorkspace(current.factory, TARGET)).rejects.toBeInstanceOf(Error)
      expect(await rawImage(current.factory)).toEqual(after)
    })

  it('rejects a v4 local edit captured before a same-epoch base difference even on a fresh handle', async () => {
    const current = await linked(), expected = await current.workspace.readLocalState(current.ctx.guard)
    const previous = expected.snapshot.entries.find(row => row.key === KEY)!
    const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'sync-stale-base-edit-0001', expected,
      command: { type: 'save', input: { code: '000001', name: '合成基金', account: '账户一', position_kind: 'holding',
        shares: 6, cost: null, target_weight: null }, expectedEntry: previous, confirmed: true } })
    current.workspace.close()
    const row = await rawRead<OwnerWorkspaceSyncMetadata>(current.factory, 'sync_metadata')
    await rawWrite(current.factory, 'sync_metadata', { ...row, base: { ...row.base!, records: row.base!.records.map(record =>
      record.key === KEY ? { ...record, values: { ...record.values, shares: 4 } } : record) } })
    const before = await rawImage(current.factory), fresh = await reopen(current.factory)
    await expect(fresh.editLocal(request, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it('keeps a committed cancellation receipt after local response loss and rejects a different hash for the same ID', async () => {
    const current = await prepared()
    const request = await buildOwnerWorkspaceCancelCloudRequest(TARGET, { id: 'sync-cancel-lost-0001', expected: current.value,
      requestId: current.request.id, requestHash: current.request.packet.requestHash })
    const actual = IDBDatabase.prototype.transaction, committed = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite') tx.addEventListener('complete', () => { committed(); current.workspace.close() })
      return tx
    })
    await expect(current.workspace.cancelPreparedCloud(request, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    expect(committed).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
    const workspace = await reopen(current.factory), value = await workspace.readSyncState(current.ctx.guard)
    expect(value.local.outbox.entry).toBeNull()
    expect(value.sync.pending).toBeNull()
    expect(value.sync.base).toEqual(current.value.sync.base)
    expect(await workspace.syncReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value })
    await expect(workspace.syncReceipt(request.id, 'f'.repeat(64), current.ctx.guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await workspace.syncReceipt(current.request.id, current.request.hash, current.ctx.guard)).toEqual({ state: 'unknown' })
  })

  it('rejects a different envelope hash or wrong original identity without clearing a prepared packet', async () => {
    const current = await prepared(), before = await rawImage(current.factory)
    await expect(current.workspace.syncReceipt(current.request.id, 'f'.repeat(64), current.ctx.guard))
      .rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    const cancel = await buildOwnerWorkspaceCancelCloudRequest(TARGET, { id: 'sync-cancel-hash-0001', expected: current.value,
      requestId: current.request.id, requestHash: current.request.packet.requestHash })
    await expect(current.workspace.cancelPreparedCloud({ ...cancel, hash: 'f'.repeat(64) }, current.ctx.guard)).rejects.toBeInstanceOf(Error)
    await expect(buildOwnerWorkspaceCancelCloudRequest(TARGET, { id: 'sync-cancel-wrong-0001', expected: current.value,
      requestId: 'sync-not-original-0001', requestHash: current.request.packet.requestHash })).rejects.toBeInstanceOf(Error)
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it.each(['revision', 'operation', 'byte-length', 'extra-key'] as const)
    ('rejects supplied packet %s drift while its original bytes/hash remain unchanged', async fault => {
      const current = await linked()
      await edit(current.workspace, current.ctx.guard)
      const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-packet-shape-0001',
        expected: await current.workspace.readSyncState(current.ctx.guard) })
      const packet = fault === 'revision' ? { ...request.packet, request: { ...request.packet.request, expected_revision: 99 } }
        : fault === 'operation' ? { ...request.packet, request: { ...request.packet.request,
          operations: [{ ...request.packet.request.operations[0], changes: { shares: 99 } }] } }
        : fault === 'byte-length' ? { ...request.packet, byteLength: request.packet.byteLength + 1 }
        : { ...request.packet, token: 'synthetic-never-real' }
      const before = await rawImage(current.factory)
      await expect(current.workspace.prepareCloud({ ...request, packet }, current.ctx.guard)).rejects.toBeInstanceOf(Error)
      expect(await rawImage(current.factory)).toEqual(before)
    })

  it('serializes two conflicting first-link attempts without applying the losing newer base', async () => {
    const current = await upgraded(), second = await reopen(current.factory)
    const expected = await current.workspace.readSyncState(current.ctx.guard)
    const newer: OwnerSyncBaseline = { pulledRevision: 2, records: [...baseline().records, {
      ...fund('000004::新云账户', 9), record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 },
    }] }
    const one = await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'sync-link-race-0001', expected, base: baseline() })
    const two = await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'sync-link-race-0002', expected, base: newer })
    const results = await Promise.allSettled([current.workspace.linkCloudBase(one, current.ctx.guard), second.linkCloudBase(two, current.ctx.guard)])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(1)
    const winner = results[0].status === 'fulfilled' ? one : two
    const value = await second.readSyncState(current.ctx.guard)
    expect(value.sync.base).toEqual(winner.base)
    expect(value.sync.recentReceipt?.id).toBe(winner.id)
    expect(value.local.snapshot.entries.filter(row => row.key === '000003::云账户')).toHaveLength(1)
  })

  it('does not let a new first-link request replace applied B or smuggle a newer observation into prepare', async () => {
    const current = await linked(), before = await rawImage(current.factory)
    const expected = await current.workspace.readSyncState(current.ctx.guard)
    await expect(buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'sync-rebase-forbidden-0001', expected,
      base: { pulledRevision: 2, records: baseline().records.map(record => ({ ...record, record_revision: 2 })) } }))
      .rejects.toBeInstanceOf(Error)
    await edit(current.workspace, current.ctx.guard)
    const edited = await current.workspace.readSyncState(current.ctx.guard)
    const withObservation = { id: 'sync-rebase-prepare-0001', expected: edited, base: { pulledRevision: 99, records: [] } }
    await expect(buildOwnerWorkspacePrepareCloudRequest(TARGET, withObservation)).rejects.toBeInstanceOf(Error)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-kept-base-0001', expected: edited })
    expect(request.packet.request.expected_revision).toBe(1)
    expect(request.packet.request.operations[0].base_values?.shares).toBe(0)
    expect((await rawImage(current.factory)).stores.sync_metadata).toEqual(before.stores.sync_metadata)
  })

  it('rejects a valid rehashed same-ID packet substituted into both slot and pending under the original preparation receipt', async () => {
    const current = await prepared()
    current.workspace.close()
    const slot = await rawRead<{ version: number; resourceFingerprint: string;
      entry: NonNullable<OwnerWorkspaceSyncState['local']['outbox']['entry']> }>(current.factory, 'slot')
    const sync = await rawRead<OwnerWorkspaceSyncMetadata>(current.factory, 'sync_metadata')
    const original = await restoreOwnerSyncRequest(slot.entry.rawBody, slot.entry.requestHash)
    const replacement = await buildOwnerSyncRequest({ ...original.request,
      operations: original.request.operations.map(operation => ({ ...operation, changes: { shares: 99 } })) })
    expect(replacement.request.request_id).toBe(original.request.request_id)
    expect(replacement.requestHash).not.toBe(original.requestHash)
    await rawWrite(current.factory, 'slot', { ...slot, entry: { ...slot.entry,
      rawBody: replacement.rawBody, requestHash: replacement.requestHash } })
    await rawWrite(current.factory, 'sync_metadata', { ...sync, pending: { ...sync.pending!,
      rawBody: replacement.rawBody, requestHash: replacement.requestHash } })
    const before = await rawImage(current.factory)
    await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(await rawImage(current.factory)).toEqual(before)
  })

  it('retains exact negative-zero B/L while a changed nullable field uses a wire-normalized packet that reopens', async () => {
    const sourceArchive = { ...archive(), v2Raw: archive().v2Raw!
      .replace('"shares":0', '"shares":-0').replace('"cost":null', '"cost":-0') }
    const base: OwnerSyncBaseline = { ...baseline(), records: baseline().records.map(record => record.key === KEY
      ? { ...record, values: { ...record.values, shares: -0, cost: -0 } } : record) }
    const current = await linked(false, base, sourceArchive)
    const expected = await current.workspace.readLocalState(current.ctx.guard), previous = expected.snapshot.entries.find(row => row.key === KEY)!
    expect(Object.is(previous.values.shares, -0)).toBe(true)
    expect(Object.is(previous.values.cost, -0)).toBe(true)
    const editRequest = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'sync-negative-base-edit-0001', expected,
      command: { type: 'save', input: { code: '000001', name: '合成基金', account: '账户一', position_kind: 'holding',
        shares: -0, cost: null, target_weight: null }, expectedEntry: previous, confirmed: true } })
    await current.workspace.editLocal(editRequest, current.ctx.guard)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-negative-base-prepare-0001',
      expected: await current.workspace.readSyncState(current.ctx.guard) })
    expect(request.packet.request.operations[0].changes).toEqual({ cost: null })
    expect(Object.is(request.packet.request.operations[0].base_values!.cost, 0)).toBe(true)
    await current.workspace.prepareCloud(request, current.ctx.guard)
    await current.workspace.readSyncState(current.ctx.guard)
    current.workspace.close()
    const workspace = await reopen(current.factory), value = await workspace.readSyncState(current.ctx.guard)
    const keptBase = value.sync.base!.records.find(record => record.key === KEY)!
    expect(Object.is(keptBase.values.shares, -0)).toBe(true)
    expect(Object.is(keptBase.values.cost, -0)).toBe(true)
    expect(Object.is(value.local.snapshot.entries.find(row => row.key === KEY)!.values.shares, -0)).toBe(true)
    expect(await workspace.syncReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value })
  })

  it('normalizes negative zero only in the new-record wire packet, preserving local values and the exact preparation receipt', async () => {
    const current = await linked(), expected = await current.workspace.readLocalState(current.ctx.guard)
    const editRequest = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'sync-negative-new-edit-0001', expected,
      command: { type: 'save', input: { code: '000009', name: '合成零持仓', account: '新账户', position_kind: 'holding',
        shares: -0, cost: -0, target_weight: null }, expectedEntry: null, confirmed: true } })
    await current.workspace.editLocal(editRequest, current.ctx.guard)
    const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'sync-negative-new-prepare-0001',
      expected: await current.workspace.readSyncState(current.ctx.guard) })
    const operation = request.packet.request.operations.find(row => row.key === '000009::新账户')!
    expect(Object.is(operation.changes!.shares, 0)).toBe(true)
    expect(Object.is(operation.changes!.cost, 0)).toBe(true)
    const value = await current.workspace.prepareCloud(request, current.ctx.guard)
    expect(Object.is(value.local.snapshot.entries.find(row => row.key === operation.key)!.values.cost, -0)).toBe(true)
    await current.workspace.readSyncState(current.ctx.guard)
    current.workspace.close()
    const workspace = await reopen(current.factory), checked = await workspace.readSyncState(current.ctx.guard)
    expect(await workspace.syncReceipt(request.id, request.hash, current.ctx.guard)).toEqual({ state: 'matched', value: checked })
    expect(Object.is(checked.local.snapshot.entries.find(row => row.key === operation.key)!.values.shares, -0)).toBe(true)
  })
})
