/** Real Pinia writers and authority locator with injected IDB; never browser/cloud evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory, type IDBDatabase } from 'fake-indexeddb'
import { useWatchlistStore } from './watchlist'
import { openOwnerAuthority } from './owner-authority'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, buildOwnerWorkspaceLinkCloudRequest,
  buildOwnerWorkspacePrepareCloudRequest, type OwnerWorkspace, type OwnerWorkspaceGuard,
} from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerWorkspaceBackup } from '@/utils/owner-workspace-backup'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'
import { setLegacySyncConsent } from '@/utils/cloud-consent'

const KEY = '510300::银行'
const LS = 'sinan_watchlist_v2'
let factory: IDBFactory
let data: Map<string, string>
const stores: Array<ReturnType<typeof useWatchlistStore>> = []
const handles: OwnerWorkspace[] = []
const network = vi.fn(() => { throw new Error('synthetic cloud IO forbidden') })
beforeEach(() => {
  factory = new IDBFactory()
  data = new Map([[LS, JSON.stringify([{ code: '510300', name: '合成零份', account: '银行',
    position_kind: 'holding', shares: 0, cost: 0, target_weight: null, updated_at: '2026-10-01T00:00:00Z' }])]])
  vi.stubGlobal('indexedDB', factory)
  vi.stubGlobal('location', { origin: 'https://fund.example' })
  vi.stubGlobal('BroadcastChannel', undefined) // Optional hint unavailable; actual persisted locator still governs every operation.
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  network.mockClear(); vi.stubGlobal('fetch', network)
  setLegacySyncConsent(false)
  setActivePinia(createPinia())
})
afterEach(() => {
  stores.splice(0).forEach(store => store.$dispose())
  handles.splice(0).forEach(handle => handle.close())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function createStore(allowBlocked = false) {
  setActivePinia(createPinia())
  const store = useWatchlistStore(); stores.push(store)
  if (allowBlocked) { try { await store.initialize() } catch { /* Keep the real blocked state observable. */ } }
  else await store.initialize()
  return store
}
function context(): OwnerWorkspaceGuard {
  const controller = new AbortController()
  return { signal: controller.signal, assertActive() { if (controller.signal.aborted) throw new Error('synthetic revoked') } }
}
const base = (): OwnerSyncBaseline => ({ pulledRevision: 1, records: [
  { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成零份', shares: 0, cost: 0, target_weight: null } },
  { key: '000003::云账户', kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成云持仓', shares: 5, cost: null, target_weight: 0 } },
  { key: 'asset:synthetic-manual', kind: 'manual_asset', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 }, values: { name: '合成现金', cls: '现金', value: 0, note: null } },
] })
async function rawOpen(target: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
}
async function image(target: string) {
  const db = await rawOpen(target)
  try { return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const names = [...db.objectStoreNames], tx = db.transaction(names), result: Record<string, unknown[]> = {}
    for (const name of names) { const request = tx.objectStore(name).getAll(); request.onsuccess = () => { result[name] = request.result } }
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function adoptedAndLinked() {
  const store = await createStore(), originalLS = data.get(LS)!
  expect(store.authorityState).toBe('legacy')
  const backup = await store.createLocalWorkspaceBackup()
  await store.activateLocalWorkspace(backup.raw, backup.sha256)
  expect(store.authorityState).toBe('idb')
  const locator = await openOwnerAuthority(factory, localStorage)
  const pointer = await locator.read(); locator.close()
  expect(pointer.phase).toBe('active')
  const target = pointer.targetFingerprint!, guard = context()
  const v3 = await openOwnerWorkspace(factory, target, { existingOnly: true }); handles.push(v3)
  const expected = await v3.readLocalState(guard)
  const raw = await rawOpen(target)
  expect(raw.version).toBe(3); raw.close()
  // Versionchange closes both real v3 handles. No application writer or
  // locator is replaced with a mock to manufacture the v4 initial state.
  const v4 = await upgradeOwnerWorkspaceSync(factory, target, expected, guard); handles.push(v4)
  const request = await buildOwnerWorkspaceLinkCloudRequest(target, { id: 'watch-v4-link-0001',
    expected: await v4.readSyncState(guard), base: base() })
  const linked = await v4.linkCloudBase(request, guard)
  store.$dispose()
  const reloaded = await createStore()
  await reloaded.load(true)
  expect(reloaded.authorityState).toBe('idb')
  expect(reloaded.recordsFor('000003')[0]).toMatchObject({ account: '云账户', shares: 5, cost: null, target_weight: 0, updated_at: null })
  expect(data.get(LS)).toBe(originalLS)
  return { store: reloaded, handle: v4, target, guard, linked, originalLS, pointer }
}

describe('real watchlist writers on the explicitly upgraded v4 authority', () => {
  it('reloads the original target, saves/removes/restores through real writers and preserves complete B/epoch/null-time semantics', async () => {
    const current = await adoptedAndLinked(), { store, handle, guard } = current
    const syncBefore = structuredClone((await handle.readSyncState(guard)).sync)
    const originalSnapshot = store.entrySnapshot(KEY)!
    await store.saveHolding({ code: '510300', name: '合成零份', account: '银行', position_kind: 'holding',
      shares: 7, cost: null, target_weight: 0 }, { id: KEY, snapshot: originalSnapshot }, { confirmed: true })
    expect(store.recordsFor('510300')[0]).toMatchObject({ shares: 7, cost: null, target_weight: 0, local_pending: true })
    expect((await handle.readSyncState(guard)).sync).toEqual(syncBefore)
    await store.remove('510300', '银行', { confirmed: true,
      expected: [{ id: KEY, snapshot: store.entrySnapshot(KEY)! }] })
    expect(store.recordsFor('510300')).toEqual([])
    expect(store.entries.find(row => row.id === KEY)?.deleted).toBe(true)
    const exported = await store.createLocalWorkspaceBackup()
    expect(exported.envelope.displayTimes.find(row => row.key === '000003::云账户')?.updated_at).toBeNull()
    expect(Object.keys(exported.envelope)).not.toContain('sync')
    expect(Object.keys(exported.envelope)).not.toContain('pending')
    const addition = { key: '000009::恢复', kind: 'watch' as const, deleted: false, local_pending: false,
      values: { name: '合成未知时间关注', shares: null, cost: null, target_weight: null } }
    const sourceArchive = { sourceKey: null, v1Raw: null, v2Raw: null } as const
    const external = await buildOwnerWorkspaceBackup({ snapshot: { localVersion: 1, entries: [addition], legacy: null },
      metadata: { schema: 'owner-workspace-local-1', adoption: { id: 'watch-v4-restored-source', hash: '1'.repeat(64),
        backupSha256: '2'.repeat(64), sourceArchive, localVersion: 1 }, recentEdit: null,
      displayTimes: [{ key: addition.key, updated_at: null }], restoredArchives: [] } })
    expect(await store.previewLocalWorkspaceRestore(external.raw, external.sha256)).toMatchObject({ added: 1, conflicts: 0 })
    await store.restoreLocalWorkspaceBackup(external.raw, external.sha256)
    expect(store.recordsFor('000009')[0]).toMatchObject({ shares: null, cost: null, updated_at: null, position_kind: 'watch' })
    const after = await handle.readSyncState(guard)
    expect(after.sync).toEqual(syncBefore)
    expect(after.local.sync).toEqual(syncBefore)
    expect(after.local.metadata.displayTimes.find(row => row.key === addition.key)?.updated_at).toBeNull()
    expect(after.sync.base?.records.find(row => row.kind === 'manual_asset')).toEqual(base().records[2])
    expect(store.hasLocalChanges()).toBe(true)
    expect(data.get(LS)).toBe(current.originalLS)
    const locator = await openOwnerAuthority(factory, localStorage)
    expect(await locator.read()).toEqual(current.pointer); locator.close()
    expect(network).not.toHaveBeenCalled()
  })

  it.each(['saveHolding', 'remove'] as const)('refuses real %s while retaining the exact prepared original without LS fallback', async operation => {
    const current = await adoptedAndLinked()
    await current.store.saveHolding({ code: '510300', name: '合成零份', account: '银行', position_kind: 'holding',
      shares: 7, cost: null, target_weight: null }, { id: KEY, snapshot: current.store.entrySnapshot(KEY)! }, { confirmed: true })
    const request = await buildOwnerWorkspacePrepareCloudRequest(current.target, { id: 'watch-v4-prepare-0001',
      expected: await current.handle.readSyncState(current.guard) })
    await current.handle.prepareCloud(request, current.guard)
    current.store.$dispose()
    const store = await createStore()
    await store.load(true)
    expect(store.authorityState).toBe('idb')
    const before = await image(current.target)
    if (operation === 'saveHolding') {
      await expect(store.saveHolding({ code: '510300', name: '合成零份', account: '银行', position_kind: 'holding',
        shares: 99, cost: null, target_weight: null }, { id: KEY, snapshot: store.entrySnapshot(KEY)! }, { confirmed: true }))
        .rejects.toBeInstanceOf(Error)
    } else {
      await expect(store.remove('510300', '银行', { confirmed: true,
        expected: [{ id: KEY, snapshot: store.entrySnapshot(KEY)! }] })).rejects.toBeInstanceOf(Error)
    }
    expect(store.authorityState).toBe('idb')
    expect(store.hasPendingLocalWorkspaceEdit).toBe(false)
    expect(await image(current.target)).toEqual(before)
    const kept = await current.handle.readSyncState(current.guard)
    expect(kept.local.outbox.entry?.rawBody).toBe(request.packet.rawBody)
    expect(kept.sync.pending?.preparationHash).toBe(request.hash)
    expect(kept.sync.base).toEqual(base())
    expect(data.get(LS)).toBe(current.originalLS)
    expect(network).not.toHaveBeenCalled()
  })

  it('blocks the actual reloaded store when v4 sync metadata is missing and never reads fallback LS business rows', async () => {
    const current = await adoptedAndLinked()
    current.store.$dispose(); current.handle.close()
    const db = await rawOpen(current.target)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sync_metadata', 'readwrite'); tx.objectStore('sync_metadata').delete('current')
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
    db.close()
    const oldLS = JSON.stringify([{ code: '999999', name: '不得复活的旧副本', updated_at: '2026-10-01T00:00:00Z' }])
    data.set(LS, oldLS)
    const reads = vi.spyOn(localStorage, 'getItem'), names = (await factory.databases()).map(row => row.name).sort()
    const store = await createStore(true)
    expect(store.authorityState).toBe('blocked')
    expect(store.entries).toEqual([])
    expect(reads.mock.calls.some(([key]) => key === LS || key === 'sinan_watchlist_v1')).toBe(false)
    await expect(store.saveHolding({ code: '510300', name: '不得写入', account: '银行', position_kind: 'holding',
      shares: 9, cost: null, target_weight: null })).rejects.toBeInstanceOf(Error)
    expect((await factory.databases()).map(row => row.name).sort()).toEqual(names)
    expect((await image(current.target)).sync_metadata).toEqual([])
    expect(data.get(LS)).toBe(oldLS)
    expect(network).not.toHaveBeenCalled()
  })
})
