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

function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function setupWriter(kind: 'edit' | 'restore') {
  const module = await import('./owner-workspace'), original = module.openOwnerWorkspace
  const reached = deferred(), gate = deferred(), writes = vi.fn()
  let armed = false, held = false
  vi.spyOn(module, 'openOwnerWorkspace').mockImplementation(async (...args) => {
    const real = await original(...args)
    return { ...real,
      async readLocalState(guard) {
        const state = await real.readLocalState(guard)
        if (armed && !held) { held = true; reached.release(); await gate.promise }
        return state
      },
      async editLocal(request, guard) {
        const result = await real.editLocal(request, guard)
        if (kind !== 'edit') return result
        writes(request.id, request.hash); real.close(); throw new Error('synthetic committed edit response lost')
      },
      async restoreLocal(request, guard) {
        const result = await real.restoreLocal(request, guard)
        if (kind !== 'restore') return result
        writes(request.id, request.hash); real.close(); throw new Error('synthetic committed restore response lost')
      },
    }
  })
  const store = await createStore(), backup = await store.createLocalWorkspaceBackup()
  await store.activateLocalWorkspace(backup.raw, backup.sha256)
  return { store, backup, reached, gate, writes, arm() { armed = true } }
}
async function addition() {
  const sourceArchive = { sourceKey: null, v1Raw: null, v2Raw: null } as const
  return buildOwnerWorkspaceBackup({ snapshot: { localVersion: 1, legacy: null, entries: [{
    key: '000009::新增', kind: 'watch', deleted: false, local_pending: true,
    values: { name: '合成复导关注', shares: null, cost: null, target_weight: null } }] },
    metadata: { schema: 'owner-workspace-local-1', adoption: { id: 'serialization-source-0001', hash: '1'.repeat(64),
      backupSha256: '2'.repeat(64), sourceArchive, localVersion: 1 }, recentEdit: null, restoredArchives: [],
      displayTimes: [{ key: '000009::新增', updated_at: null }] } })
}
describe('real store preflight reservation and original lost-response receipt ownership', () => {
  it.each(['load', 'backup'] as const)('does not bless an observed adoption identity change through %s', async operation => {
    const f = await setupWriter('edit')
    const locator = await openOwnerAuthority(factory, localStorage), pointer = await locator.read(); locator.close()
    const target = pointer.targetFingerprint!, before = f.store.entries.map(row => ({ ...row }))
    const db = await rawOpen(target)
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('local_metadata', 'readwrite'), store = tx.objectStore('local_metadata')
      const read = store.get('current')
      read.onsuccess = () => {
        const metadata = read.result
        metadata.adoption.hash = metadata.adoption.hash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64)
        store.put(metadata, 'current')
      }
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    }) } finally { db.close() }
    const changed = await image(target)
    await expect(operation === 'load' ? f.store.load(true) : f.store.createLocalWorkspaceBackup()).rejects.toThrow()
    expect(f.store.entries).toEqual(before)
    await expect(f.store.createSyncRecoveryBackup()).rejects.toThrow()
    expect(await image(target)).toEqual(changed)
    expect(f.writes).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })
  it('reserves before an awaited edit preflight, rejecting another save/format/preview without overwriting the committed original tuple', async () => {
    const f = await setupWriter('edit')
    f.arm()
    const first = f.store.add('000009', '唯一合成提交').then(() => 'unexpected', error => error.message)
    await f.reached.promise
    await expect(f.store.add('000008', '不得并发提交')).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.store.createSyncRecoveryBackup()).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.store.previewLocalWorkspaceRestore(f.backup.raw, f.backup.sha256)).rejects.toMatchObject({ code: 'conflict' })
    expect(f.store.hasPendingLocalWorkspaceEdit).toBe(false)
    f.gate.release()
    expect(await first).toContain('committed edit response lost')
    expect(f.writes).toHaveBeenCalledOnce()
    expect(f.store.hasPendingLocalWorkspaceEdit).toBe(true)
    expect(f.store.authorityState).toBe('blocked')
    await f.store.reconcileLocalWorkspaceEdit()
    expect(f.store.authorityState).toBe('idb')
    expect(f.store.has('000009')).toBe(true); expect(f.store.has('000008')).toBe(false)
    expect(f.store.hasPendingLocalWorkspaceEdit).toBe(false)
    expect(f.writes).toHaveBeenCalledOnce()
    expect(network).not.toHaveBeenCalled()
  })
  it('reserves the complete restore preflight, rejecting another restore/save/format and later reconciling only its actual committed id/hash', async () => {
    const f = await setupWriter('restore'), backup = await addition()
    expect(await f.store.previewLocalWorkspaceRestore(backup.raw, backup.sha256)).toMatchObject({ added: 1 })
    f.arm()
    const first = f.store.restoreLocalWorkspaceBackup(backup.raw, backup.sha256).then(() => 'unexpected', error => error.message)
    await f.reached.promise
    await expect(f.store.restoreLocalWorkspaceBackup(backup.raw, backup.sha256)).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.store.add('000008', '不得并发提交')).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.store.createSyncRecoveryBackup()).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.store.previewLocalWorkspaceRestore(backup.raw, backup.sha256)).rejects.toMatchObject({ code: 'conflict' })
    f.gate.release()
    expect(await first).toContain('committed restore response lost')
    expect(f.writes).toHaveBeenCalledOnce()
    expect(f.store.hasPendingLocalWorkspaceEdit).toBe(true)
    await f.store.reconcileLocalWorkspaceEdit()
    expect(f.store.has('000009', '新增')).toBe(true); expect(f.store.has('000008')).toBe(false)
    expect(f.store.hasPendingLocalWorkspaceEdit).toBe(false)
    expect(f.writes).toHaveBeenCalledOnce()
    expect(network).not.toHaveBeenCalled()
  })
})
