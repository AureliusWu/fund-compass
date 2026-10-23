/** Real adopted IDB primitives with synthetic records; not a browser/cloud recovery qualification. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, reconcileOwnerWorkspaceSyncUpgrade,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspacePrepareCloudRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceLocalState,
} from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { buildOwnerWorkspaceRecoveryBackup, restoreOwnerWorkspaceRecoveryBackup, validateOwnerWorkspaceRecoveryBackup } from '@/utils/owner-workspace-recovery'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'

const TARGET = '8'.repeat(64), KEY = '510300::合成账户'
const handles: OwnerWorkspace[] = []
afterEach(() => { handles.splice(0).forEach(h => h.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function context() {
  const controller = new AbortController()
  return { controller, guard: { signal: controller.signal, assertActive() { if (controller.signal.aborted) throw new Error('revoked') } } satisfies OwnerWorkspaceGuard }
}
async function adopted() {
  const factory = new IDBFactory(), handle = await openOwnerWorkspace(factory, TARGET), { guard, controller } = context()
  handles.push(handle)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'opaque original archive',
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '零份合成', account: '合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-22T00:00:00Z' }]) }
  const backup = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const request = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'recovery-adopt-0001',
    expected: await handle.readLocalState(guard), sourceArchive, backupSha256: backup.sha256 })
  const local = await handle.adoptLocal(request, guard)
  return { factory, handle, local, guard, controller }
}
async function rawOpen(factory: IDBFactory, version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET, version)
    request.onupgradeneeded = () => request.result.createObjectStore('sync_metadata')
    request.onsuccess = () => resolve(request.result as unknown as IDBDatabase)
    request.onerror = () => reject(request.error)
  })
}
async function gap(factory: IDBFactory) { const db = await rawOpen(factory, 4); db.close() }
async function mutate(factory: IDBFactory, store: string, value: unknown, key = 'current') {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function image(factory: IDBFactory) {
  const db = await rawOpen(factory)
  try { return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const result: Record<string, unknown[]> = {}, names = [...db.objectStoreNames], tx = db.transaction(names)
    for (const name of names) { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { result[name] = request.result } }
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')
function base(): OwnerSyncBaseline { return { pulledRevision: 1, records: [
  { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 }, values: { name: '零份合成', shares: -0, cost: null, target_weight: 0 } },
  { key: 'asset:synthetic-manual', kind: 'manual_asset', deleted: true, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 }, values: { name: '删除现金', cls: '现金', value: 0, note: null } },
] } }
async function pending() {
  const current = await adopted(), v4 = await upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.guard)
  handles.push(v4)
  const linked = await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, {
    id: 'recovery-link-0001', expected: await v4.readSyncState(current.guard), base: base(),
  }), current.guard)
  const local = await v4.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'recovery-edit-0001', expected: linked.local,
    command: { type: 'save', input: { code: '510300', name: '零份合成', account: '合成账户', position_kind: 'holding', shares: 8,
      cost: null, target_weight: 0 }, expectedEntry: linked.local.snapshot.entries[0], confirmed: true } }), current.guard)
  const request = await buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'recovery-prepare-0001', expected: { local, sync: local.sync! } })
  const prepared = await v4.prepareCloud(request, current.guard)
  return { ...current, v4, prepared, request }
}

describe('full adopted-workspace recovery file', () => {
  it('roundtrips complete v3 state and actual -0/null/source bytes without ambient IO', async () => {
    const { local } = await adopted(), forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    const backup = await buildOwnerWorkspaceRecoveryBackup(TARGET, local)
    expect(backup.sha256).toBe(hash(backup.raw))
    expect(backup.byteLength).toBe(Buffer.byteLength(backup.raw))
    const recovered = await restoreOwnerWorkspaceRecoveryBackup(backup.raw, backup.sha256)
    expect(recovered).toMatchObject({ physicalVersion: 3, targetFingerprint: TARGET, local })
    expect(Object.is(recovered.local.snapshot.entries[0].values.shares, -0)).toBe(true)
    expect(recovered.local.snapshot.entries[0].values.cost).toBeNull()
    expect(Object.isFrozen(recovered.local.snapshot.entries[0])).toBe(true)
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('retains complete v4 B/manual tombstones, original packet bytes and preparation hashes', async () => {
    const current = await pending(), backup = await buildOwnerWorkspaceRecoveryBackup(TARGET, current.prepared.local)
    const recovered = await restoreOwnerWorkspaceRecoveryBackup(backup.raw, backup.sha256)
    expect(recovered.local).toEqual(current.prepared.local)
    expect(recovered.local.sync?.base).toEqual(base())
    expect(recovered.local.sync?.pending?.rawBody).toBe(current.request.packet.rawBody)
    expect(recovered.local.sync?.pending?.preparationHash).toBe(current.request.hash)
    expect(recovered.local.outbox.entry?.state).toBe('prepared') // decoding never enables resend or writes storage
  })
  it.each(['preparationHash', 'preimageHash', 'requestHash'] as const)('rejects resealed file with corrupt actual pending %s', async field => {
    const current = await pending(), backup = await buildOwnerWorkspaceRecoveryBackup(TARGET, current.prepared.local)
    const copy = JSON.parse(backup.raw); copy.local.sync.pending[field] = '1'.repeat(64)
    const raw = canonicalOwnerLocal(copy)
    await expect(restoreOwnerWorkspaceRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
  })
  it.each(['wrong-version', 'receipt-count', 'missing-sync', 'wrong-adoption-hash', 'extra-field'] as const)('rejects incomplete or unsupported image: %s', async fault => {
    const current = await pending(), backup = await buildOwnerWorkspaceRecoveryBackup(TARGET, current.prepared.local), copy = JSON.parse(backup.raw)
    if (fault === 'wrong-version') copy.physicalVersion = 3
    if (fault === 'receipt-count') copy.local.receiptCount = 1
    if (fault === 'missing-sync') delete copy.local.sync
    if (fault === 'wrong-adoption-hash') copy.local.metadata.adoption.backupSha256 = '1'.repeat(64)
    if (fault === 'extra-field') copy.token = 'not-a-real-token'
    const raw = canonicalOwnerLocal(copy)
    await expect(restoreOwnerWorkspaceRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
  })
  it('rejects getter payload without invoking it and wrong bytes/duplicate keys/BOM even when resealed', async () => {
    const { local } = await adopted(), backup = await buildOwnerWorkspaceRecoveryBackup(TARGET, local), getter = vi.fn()
    await expect(validateOwnerWorkspaceRecoveryBackup(Object.defineProperty({ ...backup.envelope }, 'local', { enumerable: true, get: getter }))).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled()
    await expect(restoreOwnerWorkspaceRecoveryBackup(backup.raw + ' ', backup.sha256)).rejects.toMatchObject({ code: 'hash_mismatch' })
    for (const raw of ['\ufeff' + backup.raw, backup.raw + ' ', backup.raw.replace('{', '{"physicalVersion":3,')]) {
      await expect(restoreOwnerWorkspaceRecoveryBackup(raw, hash(raw))).rejects.toBeInstanceOf(Error)
    }
  })
})

describe('manual completion of an interrupted v3-to-v4 upgrade', () => {
  it('initializes only an empty existing sync store after exact full original-image verification', async () => {
    const current = await adopted(), backup = await buildOwnerWorkspaceRecoveryBackup(TARGET, current.local)
    await gap(current.factory)
    await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toBeInstanceOf(Error)
    const before = await image(current.factory), copy = await restoreOwnerWorkspaceRecoveryBackup(backup.raw, backup.sha256)
    const handle = await reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, copy.local, current.guard); handles.push(handle)
    const actual = await handle.readLocalState(current.guard)
    expect({ ...actual, sync: undefined }).toEqual({ ...current.local, sync: undefined })
    expect(actual.sync).toMatchObject({ epoch: 0, base: null, pending: null, recentReceipt: null })
    expect(await image(current.factory)).toEqual({ ...before, sync_metadata: [actual.sync] })
    handle.close()
    const repeat = await reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, current.local, current.guard); handles.push(repeat)
    expect(await repeat.readLocalState(current.guard)).toEqual(actual)
  })
  it('can reconcile an already completed exact upgrade, but never rolls back later local or linked state', async () => {
    const current = await adopted(), v4 = await upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.guard); handles.push(v4)
    const same = await reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, current.local, current.guard); handles.push(same)
    await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'recovery-already-linked',
      expected: await v4.readSyncState(current.guard), base: base() }), current.guard)
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, current.local, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it('does not create a missing database or upgrade a v3 database', async () => {
    const current = await adopted(), missing = new IDBFactory()
    await expect(reconcileOwnerWorkspaceSyncUpgrade(missing, TARGET, current.local, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await missing.databases()).toEqual([])
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, current.local, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['snapshot', 'metadata', 'slot', 'receipt', 'shadow-sync'] as const)('rejects a changed or incomplete original image: %s', async fault => {
    const current = await adopted(); await gap(current.factory)
    if (fault === 'snapshot') await mutate(current.factory, 'working_copy', { schema: 'owner-workspace-1', targetFingerprint: TARGET,
      snapshot: { ...current.local.snapshot, entries: [] } })
    if (fault === 'metadata') await mutate(current.factory, 'local_metadata', { ...current.local.metadata, displayTimes: [] })
    if (fault === 'slot') await mutate(current.factory, 'slot', { ...current.local.outbox, version: current.local.outbox.version + 1, resourceFingerprint: TARGET })
    if (fault === 'receipt') await mutate(current.factory, 'import_receipts', {}, 'unexpected')
    if (fault === 'shadow-sync') await mutate(current.factory, 'sync_metadata', {}, 'unexpected')
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, current.local, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it('aborts the strict initialization when authority revokes after add, preserving the gap for manual verification', async () => {
    const current = await adopted(); await gap(current.factory)
    const before = await image(current.factory), add = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      const result = add.apply(this, args)
      if (this.name === 'sync_metadata') current.controller.abort()
      return result
    })
    await expect(reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, current.local, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
    vi.restoreAllMocks()
    const handle = await reconcileOwnerWorkspaceSyncUpgrade(current.factory, TARGET, current.local, context().guard); handles.push(handle)
    expect((await handle.readSyncState(context().guard)).sync.epoch).toBe(0)
  })
})
