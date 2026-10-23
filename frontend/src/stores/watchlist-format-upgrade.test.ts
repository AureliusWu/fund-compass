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
import { restoreOwnerWorkspaceRecoveryBackup } from '@/utils/owner-workspace-recovery'
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

async function adopted() {
  const store = await createStore(), rowBackup = await store.createLocalWorkspaceBackup()
  await store.activateLocalWorkspace(rowBackup.raw, rowBackup.sha256)
  const locator = await openOwnerAuthority(factory, localStorage), pointer = await locator.read(); locator.close()
  return { store, target: pointer.targetFingerprint!, pointer }
}
async function rawWrite(target: string, store: string, value?: unknown) {
  const db = await rawOpen(target)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    if (value === undefined) tx.objectStore(store).delete('current')
    else tx.objectStore(store).put(value, 'current')
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
describe('real store explicit complete-image format upgrade and narrow recovery only', () => {
  it.each(['hash', 'archive'] as const)('does not bless observed adoption %s drift through load or either backup exporter', async field => {
    const current = await adopted(), file = await current.store.createSyncRecoveryBackup()
    await current.store.upgradeLocalSyncFormat(file.raw, file.sha256, true)
    const before = current.store.entries.map(row => ({ ...row })), stored = await image(current.target)
    const metadata = structuredClone(stored.local_metadata[0]) as any
    if (field === 'hash') metadata.adoption.hash = '9'.repeat(64)
    else metadata.adoption.sourceArchive.v1Raw = 'synthetic observed identity drift'
    await rawWrite(current.target, 'local_metadata', metadata)
    await expect(current.store.createLocalWorkspaceBackup()).rejects.toThrow()
    await expect(current.store.createSyncRecoveryBackup()).rejects.toThrow()
    expect(current.store.entries).toEqual(before)
    await expect(current.store.load(true)).rejects.toThrow()
    expect(current.store.authorityState).toBe('blocked')
    expect(current.store.entries).toEqual(before)
    await expect(current.store.enableWorkspaceSync(true)).rejects.toThrow()
    expect(network).not.toHaveBeenCalled()
  })

  it('requires a fresh exact full backup and upgrades only the existing adopted target without session/network', async () => {
    const current = await adopted(), before = await image(current.target)
    expect(current.store.localSyncFormat).toBe('v3')
    const file = await current.store.createSyncRecoveryBackup()
    const decoded = await restoreOwnerWorkspaceRecoveryBackup(file.raw, file.sha256)
    expect(decoded).toEqual(file.envelope)
    expect(decoded.physicalVersion).toBe(3)
    expect(decoded.targetFingerprint).toBe(current.target)
    expect(decoded.local.snapshot.entries[0].values).toMatchObject({ shares: 0, cost: 0, target_weight: null })
    expect(decoded.local.metadata.adoption?.sourceArchive.v2Raw).toBe(data.get(LS))
    await expect(current.store.upgradeLocalSyncFormat(file.raw, file.sha256, false as true)).rejects.toMatchObject({ code: 'requires-confirmation' })
    await current.store.upgradeLocalSyncFormat(file.raw, file.sha256, true)
    expect(current.store.localSyncFormat).toBe('v4')
    const after = await image(current.target)
    for (const name of Object.keys(before)) expect(after[name]).toEqual(before[name])
    expect(after.sync_metadata).toEqual([{ schema: 'owner-workspace-sync-1', targetFingerprint: current.target,
      epoch: 0, base: null, pending: null, recentReceipt: null }])
    current.store.$dispose()
    const reloaded = await createStore()
    expect(reloaded.localSyncFormat).toBe('v4')
    expect(reloaded.entries).toEqual(current.store.entries)
    expect(network).not.toHaveBeenCalled()
  })
  it('rejects old row backups, foreign/current-image files and stale exports before versionchange', async () => {
    const current = await adopted(), old = await current.store.createLocalWorkspaceBackup(), file = await current.store.createSyncRecoveryBackup()
    await expect(current.store.upgradeLocalSyncFormat(old.raw, old.sha256, true)).rejects.toThrow()
    await current.store.add('000009', '后续本机关注')
    const before = await image(current.target)
    await expect(current.store.upgradeLocalSyncFormat(file.raw, file.sha256, true)).rejects.toThrow()
    expect(await image(current.target)).toEqual(before)
    const db = await rawOpen(current.target); expect(db.version).toBe(3); db.close()
    expect(current.store.authorityState).toBe('idb')
    expect(current.store.hasPendingLocalWorkspaceEdit).toBe(false)
    expect(network).not.toHaveBeenCalled()
  })
  it('retains the original file after a true post-upgrade response loss and manually verifies it without replay', async () => {
    const current = await adopted(), file = await current.store.createSyncRecoveryBackup()
    const module = await import('./owner-workspace'), actual = module.upgradeOwnerWorkspaceSync, calls = vi.fn()
    vi.spyOn(module, 'upgradeOwnerWorkspaceSync').mockImplementation(async (...args) => {
      calls(); const handle = await actual(...args); handle.close(); throw new Error('synthetic lost upgrade response')
    })
    await expect(current.store.upgradeLocalSyncFormat(file.raw, file.sha256, true)).rejects.toThrow('lost upgrade')
    expect(current.store.authorityState).toBe('blocked')
    expect(current.store.hasPendingLocalWorkspaceEdit).toBe(false)
    const before = await image(current.target)
    await current.store.reconcileLocalSyncUpgrade(file.raw, file.sha256, true)
    expect(current.store.authorityState).toBe('idb')
    expect(current.store.localSyncFormat).toBe('v4')
    expect(await image(current.target)).toEqual(before)
    expect(calls).toHaveBeenCalledOnce()
    expect(network).not.toHaveBeenCalled()
  })
  it('recovers only the exact v4 empty-initialization gap from an explicit original file after cached initialize rejected', async () => {
    const current = await adopted(), file = await current.store.createSyncRecoveryBackup()
    await current.store.upgradeLocalSyncFormat(file.raw, file.sha256, true)
    current.store.$dispose()
    await rawWrite(current.target, 'sync_metadata')
    const names = (await factory.databases()).map(row => row.name).sort()
    const reloaded = await createStore(true)
    expect(reloaded.authorityState).toBe('blocked')
    const reads = vi.spyOn(localStorage, 'getItem')
    await reloaded.reconcileLocalSyncUpgrade(file.raw, file.sha256, true)
    expect(reloaded.authorityState).toBe('idb')
    expect(reloaded.localSyncFormat).toBe('v4')
    expect(reloaded.recordsFor('510300')[0]).toMatchObject({ shares: 0, cost: 0, target_weight: null })
    expect((await factory.databases()).map(row => row.name).sort()).toEqual(names)
    expect(reads.mock.calls.some(([key]) => key === LS || key === 'sinan_watchlist_v1')).toBe(false)
    expect(network).not.toHaveBeenCalled()
  })
  it('does not roll back later v4 business edits or link metadata when reconciling an old original v3 file', async () => {
    const current = await adopted(), file = await current.store.createSyncRecoveryBackup()
    await current.store.upgradeLocalSyncFormat(file.raw, file.sha256, true)
    await current.store.add('000009', '升级后新本机关注')
    const before = await image(current.target)
    await expect(current.store.reconcileLocalSyncUpgrade(file.raw, file.sha256, true)).rejects.toThrow()
    expect(await image(current.target)).toEqual(before)
    expect(current.store.authorityState).toBe('blocked')
    expect(network).not.toHaveBeenCalled()
  })
  it('refuses a configured endpoint change and never selects another target or creates a replacement database', async () => {
    const current = await adopted(), file = await current.store.createSyncRecoveryBackup(), before = await image(current.target)
    const names = (await factory.databases()).map(row => row.name).sort()
    vi.stubGlobal('location', { origin: 'https://other-fund.example' })
    await expect(current.store.upgradeLocalSyncFormat(file.raw, file.sha256, true)).rejects.toThrow()
    expect(await image(current.target)).toEqual(before)
    expect((await factory.databases()).map(row => row.name).sort()).toEqual(names)
    expect(network).not.toHaveBeenCalled()
  })
})
