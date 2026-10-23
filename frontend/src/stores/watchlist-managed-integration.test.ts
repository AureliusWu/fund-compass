/** Real Pinia + locator + workspace + managed + in-memory session + HTTP adapter.
 * Only HTTP/provider responses and explicitly labelled post-commit fault injection
 * are substituted. Synthetic IDB is not browser, cloud, durability or release proof.
 */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory, type IDBDatabase } from 'fake-indexeddb'
import { createRenderer, nextTick, watch } from 'vue'
import { useWatchlistStore } from './watchlist'
import { openOwnerAuthority, OWNER_AUTHORITY_DB } from './owner-authority'
import * as workspaceModule from './owner-workspace'
import type { OwnerWorkspace, OwnerWorkspaceGuard, OwnerWorkspaceSyncState } from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { clearOwnerSession, hasOwnerSession, loginOwnerSession } from './ownerSession'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { restoreOwnerWorkspaceRecoveryBackup } from '@/utils/owner-workspace-recovery'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { setLegacySyncConsent } from '@/utils/cloud-consent'
import OwnerManagedSyncPanel from '@/components/OwnerManagedSyncPanel.vue'

const LS = 'sinan_watchlist_v2', KEY = '510300::银行', CLOUD_KEY = '000003::云账户'
const TOKEN = 'own_' + 's'.repeat(43)
let factory: IDBFactory, data: Map<string, string>
let pinia: ReturnType<typeof createPinia>
const stores: Array<ReturnType<typeof useWatchlistStore>> = [], handles: OwnerWorkspace[] = []
const apps: Array<() => void> = []
let network: ReturnType<typeof createServer>
beforeEach(() => {
  clearOwnerSession(); vi.stubGlobal('crypto', webcrypto)
  factory = new IDBFactory()
  data = new Map([[LS, JSON.stringify([{ code: '510300', name: '合成零份', account: '银行', position_kind: 'holding',
    shares: 0, cost: null, target_weight: null, updated_at: '2026-10-01T00:00:00Z' }])],
    ['sinan_watchlist_v1', 'synthetic-unselected-original-v1']])
  vi.stubGlobal('indexedDB', factory); vi.stubGlobal('location', { origin: 'https://fund.example' })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  setLegacySyncConsent(false); setActivePinia(createPinia())
  network = createServer(); vi.stubGlobal('fetch', network.fetch)
})
afterEach(() => {
  apps.splice(0).forEach(unmount => unmount())
  stores.splice(0).forEach(store => store.$dispose()); handles.splice(0).forEach(handle => handle.close())
  clearOwnerSession(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function record(shares = 0, revision = 1): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: revision, cost: 1, target_weight: 1 },
    values: { name: '合成零份', shares, cost: null, target_weight: null } }
}
function baseRecords(): OwnerSyncRecord[] {
  return [record(), { ...record(5), key: CLOUD_KEY, values: { name: '合成云持仓', shares: 5, cost: null, target_weight: 0 } },
    { key: 'asset:synthetic-manual', kind: 'manual_asset', deleted: false, record_revision: 1, lifecycle_revision: 1,
      field_revisions: { name: 1, cls: 1, value: 1, note: 1 }, values: { name: '合成现金', cls: '现金', value: 0, note: null } }]
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) as OwnerSyncRecord[]
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}
function createServer() {
  let records = baseRecords(), head = 1
  const syncCalls: Array<{ url: URL; method: string; init: RequestInit }> = []
  const receipts = new Map<string, { status: number; result: unknown }>()
  let holdChanges: ReturnType<typeof deferred<Response>> | null = null, holdWrite: ReturnType<typeof deferred<Response>> | null = null
  let changesStarted = deferred<void>(), writeStarted = deferred<void>()
  const pageRecords = () => [...records].sort((a, b) => a.record_revision - b.record_revision || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), 'https://fund.example'), method = init.method ?? 'GET'
    if (url.pathname === '/api/v2/owner/session' && method === 'POST') return json({ access_token: TOKEN,
      token_type: 'Bearer', owner_id: 'owner', expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      scopes: ['read_private', 'write_holdings', 'run_personal_analysis'] })
    if (url.pathname === '/api/v2/owner/session' && method === 'DELETE') return new Response(null, { status: 204 })
    if (!url.pathname.startsWith('/api/v2/owner/sync')) throw new Error('synthetic unexpected HTTP route')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + TOKEN)
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' })
    syncCalls.push({ url, method, init })
    if (url.pathname === '/api/v2/owner/sync' && method === 'GET') {
      expect(url.searchParams.get('since_revision')).toBe('0')
      changesStarted.resolve()
      if (holdChanges) return holdChanges.promise
      return json({ upper_revision: head, changes: pageRecords(), next_cursor: null, complete: true })
    }
    if (url.pathname === '/api/v2/owner/sync' && method === 'POST') {
      expect(new Headers(init.headers).get('X-Owner-Sync-Consent')).toBe('owner-sync-v1')
      const packet = JSON.parse(init.body as string)
      expect(packet.expected_revision).toBe(1)
      expect(packet.operations).toEqual([{ key: KEY, kind: 'holding', deleted: false,
        changes: { shares: 7 }, base_values: { kind: 'holding', deleted: false, shares: 0 } }])
      records = [record(7, 2), ...records.filter(row => row.key !== KEY)]; head = 2
      const result = { revision: 2, records: [record(7, 2)] }
      receipts.set(packet.request_id, { status: 200, result }); writeStarted.resolve()
      if (holdWrite) return holdWrite.promise
      return json(result)
    }
    const id = decodeURIComponent(url.pathname.slice('/api/v2/owner/sync/requests/'.length)), receipt = receipts.get(id)
    expect(new Headers(init.headers).get('X-Owner-Sync-Request-Hash')).toMatch(/^[0-9a-f]{64}$/)
    return receipt ? json({ state: 'matched', ...receipt }) : json({ state: 'unknown', error: 'sync_result_unknown' }, 404)
  })
  return { fetch, syncCalls, posts: () => syncCalls.filter(call => call.method === 'POST'),
    pauseChanges() { holdChanges = deferred<Response>(); changesStarted = deferred<void>(); return { ...holdChanges, started: changesStarted.promise } },
    pauseWrite() { holdWrite = deferred<Response>(); writeStarted = deferred<void>(); return { ...holdWrite, started: writeStarted.promise } },
    completeChanges() { holdChanges!.resolve(json({ upper_revision: head, changes: pageRecords(), next_cursor: null, complete: true })); holdChanges = null },
    completeWrite() { holdWrite!.resolve(json({ revision: 2, records: [record(7, 2)] })); holdWrite = null } }
}
async function createStore() {
  pinia = createPinia(); setActivePinia(pinia)
  const store = useWatchlistStore(); stores.push(store); await store.initialize(); return store
}
function setupGuard(): OwnerWorkspaceGuard {
  const controller = new AbortController(), originalFactory = factory, origin = location.origin
  return { signal: controller.signal, assertActive() {
    if (controller.signal.aborted || globalThis.indexedDB !== originalFactory || location.origin !== origin) throw new Error('synthetic setup context revoked')
  } }
}
async function rawOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
}
async function image(target: string) {
  const db = await rawOpen(OWNER_SYNC_OUTBOX_DB_PREFIX + target)
  try { return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const names = [...db.objectStoreNames], tx = db.transaction(names), result: Record<string, unknown[]> = {}
    for (const name of names) { const read = tx.objectStore(name).getAll(); read.onsuccess = () => { result[name] = read.result } }
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function mutateCurrent(name: string, stores: readonly string[], mutate: (values: Record<string, any>) => void) {
  const db = await rawOpen(name)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...stores], 'readwrite'), values: Record<string, any> = {}; let remaining = stores.length
    for (const name of stores) {
      const read = tx.objectStore(name).get('current')
      read.onsuccess = () => {
        values[name] = read.result
        if (--remaining === 0) { mutate(values); for (const item of stores) tx.objectStore(item).put(values[item], 'current') }
      }
    }
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function fixture(linked = true, beforeReload?: () => void) {
  const originalLS = data.get(LS)!, initial = await createStore(), backup = await initial.createLocalWorkspaceBackup()
  await initial.activateLocalWorkspace(backup.raw, backup.sha256)
  const locator = await openOwnerAuthority(factory, localStorage), pointer = await locator.read(); locator.close()
  const target = pointer.targetFingerprint!, guard = setupGuard(), v3 = await workspaceModule.openOwnerWorkspace(factory, target, { existingOnly: true })
  handles.push(v3)
  const workspace = await workspaceModule.upgradeOwnerWorkspaceSync(factory, target, await v3.readLocalState(guard), guard)
  handles.push(workspace)
  if (linked) {
    const request = await workspaceModule.buildOwnerWorkspaceLinkCloudRequest(target, { id: 'integration-initial-link-0001',
      expected: await workspace.readSyncState(guard), base: { pulledRevision: 1, records: baseRecords() } })
    await workspace.linkCloudBase(request, guard)
  }
  initial.$dispose(); beforeReload?.()
  const store = await createStore(); await store.load(true)
  expect(store.authorityState).toBe('idb'); expect(store.localSyncFormat).toBe('v4')
  return { store, target, workspace, guard, originalLS, pointer, backup }
}
async function enabled(current: Awaited<ReturnType<typeof fixture>>) {
  await loginOwnerSession('synthetic-login-not-a-real-password')
  const managed = await current.store.enableWorkspaceSync(true)
  await managed.hydrate()
  return managed
}
async function edit(store: ReturnType<typeof useWatchlistStore>) {
  await store.saveHolding({ code: '510300', name: '合成零份', account: '银行', position_kind: 'holding',
    shares: 7, cost: null, target_weight: null }, { id: KEY, snapshot: store.entrySnapshot(KEY)! }, { confirmed: true })
}
async function prepared() {
  const current = await fixture(), managed = await enabled(current)
  await edit(current.store)
  const request = await managed.previewPreparation('integration-prepare-0001')
  await managed.commitPreparation(request, true)
  return { ...current, managed, request }
}
function loseResponseAfterRealCommit(operation: 'prepareCloud' | 'ackCloud') {
  const originalOpen = workspaceModule.openOwnerWorkspace, calls: Array<{ target: string; existingOnly: unknown }> = []
  let failures = 1, commits = 0
  vi.spyOn(workspaceModule, 'openOwnerWorkspace').mockImplementation(async (...args) => {
    calls.push({ target: args[1], existingOnly: args[2]?.existingOnly })
    const handle = await originalOpen(...args)
    return { ...handle, async [operation](request: any, guard: OwnerWorkspaceGuard) {
      const result = await (handle[operation] as (request: any, guard: OwnerWorkspaceGuard) => Promise<OwnerWorkspaceSyncState>)(request, guard)
      commits++
      if (failures-- > 0) { handle.close(); throw new Error('synthetic response lost after real strict commit') }
      return result
    } } as OwnerWorkspace
  })
  return { calls, commits: () => commits }
}

describe('store-owned managed v4 real integration', () => {
  it('opens only the selected existing v4 authority, stays opt-in and reuses one controller across panel callers', async () => {
    const current = await fixture(), names = (await factory.databases()).map(row => row.name).sort()
    expect(network.syncCalls).toEqual([])
    const managed = await enabled(current), secondPanel = await current.store.enableWorkspaceSync(true)
    expect(secondPanel).toBe(managed)
    expect(managed.getState()?.local.metadata.adoption?.id).toBe(current.pointer.activationId)
    expect(network.syncCalls).toEqual([])
    expect((await factory.databases()).map(row => row.name).sort()).toEqual(names)
    expect(data.get(LS)).toBe(current.originalLS)
    expect(current.store.hasLocalChanges()).toBe(true)
  })

  it('uses the genuine complete GET to link and reflects cloud-only rows without granting current-action confirmation', async () => {
    const current = await fixture(false), managed = await enabled(current)
    await managed.pullComplete()
    const preview = await managed.previewLink('integration-managed-link-0001')
    await managed.commitLink(preview.request, true)
    expect(current.store.recordsFor('000003')[0]).toMatchObject({ account: '云账户', shares: 5, cost: null, target_weight: 0, updated_at: null })
    expect(managed.getState()?.sync.base?.records).toEqual(baseRecords())
    expect(current.store.hasLocalChanges()).toBe(true)
    expect(network.posts()).toHaveLength(0)
    expect(data.get(LS)).toBe(current.originalLS)
  })

  it.each(['save', 'remove', 'restore'] as const)('explicitly refuses %s against a prepared original without manufacturing a local unknown', async operation => {
    const current = await prepared(), before = await image(current.target), addition = await buildOwnerLegacyWorkspaceBackup({
      sourceKey: 'sinan_watchlist_v2', v1Raw: null, v2Raw: JSON.stringify([{ code: '000009', name: '复导关注', position_kind: 'watch',
        updated_at: '2026-10-02T00:00:00Z' }]) })
    if (operation === 'save') await expect(edit(current.store)).rejects.toBeInstanceOf(Error)
    if (operation === 'remove') await expect(current.store.remove('510300', '银行', { confirmed: true,
      expected: [{ id: KEY, snapshot: current.store.entrySnapshot(KEY)! }] })).rejects.toBeInstanceOf(Error)
    if (operation === 'restore') {
      try { await current.store.previewLocalWorkspaceRestore(addition.raw, addition.sha256) } catch { /* A pending preflight may also forbid preview. */ }
      await expect(current.store.restoreLocalWorkspaceBackup(addition.raw, addition.sha256)).rejects.toBeInstanceOf(Error)
    }
    expect(current.store.authorityState).toBe('idb')
    expect(current.store.hasPendingLocalWorkspaceEdit).toBe(false)
    expect(current.managed.status().uncertainLocal).toBeNull()
    expect(await image(current.target)).toEqual(before)
    expect(network.posts()).toHaveLength(0)
    expect(data.get(LS)).toBe(current.originalLS)
    expect((await current.managed.exportPending())?.rawBody).toBe(current.request.packet.rawBody)
  })

  it('keeps IDB as the source when non-authoritative old LS business rows are changed', async () => {
    const current = await fixture(), managed = await enabled(current)
    data.set(LS, JSON.stringify([{ code: '999999', name: '不得回退的旧行', updated_at: '2026-10-03T00:00:00Z' }]))
    data.set('sinan_watchlist_v1', 'changed non-authoritative archive')
    await managed.pullComplete()
    expect(current.store.has('999999')).toBe(false)
    expect(current.store.recordsFor('510300')[0].shares).toBe(0)
    expect(managed.getState()?.local.metadata.adoption?.sourceArchive.v2Raw).toBe(current.originalLS)
    expect(network.posts()).toHaveLength(0)
  })

  it.each(['locator-target', 'adoption-hash', 'archive', 'endpoint', 'memory'] as const)('rejects a real %s change during an in-flight complete read', async fault => {
    const current = await fixture(), managed = await enabled(current), held = network.pauseChanges(), work = managed.pullComplete()
    const rejected = expect(work).rejects.toBeInstanceOf(Error)
    await held.started
    if (fault === 'locator-target') await mutateCurrent(OWNER_AUTHORITY_DB, ['authority'], rows => { rows.authority.targetFingerprint = '0'.repeat(64) })
    if (fault === 'adoption-hash') await mutateCurrent(OWNER_SYNC_OUTBOX_DB_PREFIX + current.target, ['local_metadata'], rows => {
      rows.local_metadata.adoption.hash = '0'.repeat(64)
    })
    if (fault === 'archive') await mutateCurrent(OWNER_SYNC_OUTBOX_DB_PREFIX + current.target, ['local_metadata', 'working_copy'], rows => {
      rows.local_metadata.adoption.sourceArchive.v2Raw += ' '
      rows.working_copy.snapshot.legacy.raw += ' '
    })
    if (fault === 'endpoint') Object.assign(location, { origin: 'https://different-api.example' })
    if (fault === 'memory') current.store.entries[0].shares = 99
    network.completeChanges(); await rejected
    expect(managed.status().completeReady).toBe(false)
    expect(managed.status().resultReady).toBe(false)
    expect(network.posts()).toHaveLength(0)
    expect(data.get(LS)).toBe(current.originalLS)
  })

  it('immediately invalidates logout and discards a late accepted POST, preserving the original for manual receipt reconciliation', async () => {
    const current = await prepared(), held = network.pauseWrite(), work = current.managed.sendOnce(), rejected = expect(work).rejects.toBeInstanceOf(Error)
    await held.started
    clearOwnerSession(); await nextTick()
    await rejected
    expect(hasOwnerSession()).toBe(false)
    expect(current.managed.status().resultReady).toBe(false)
    network.completeWrite(); await new Promise(resolve => setTimeout(resolve, 0))
    const saved = await image(current.target), slot = saved.slot[0] as { entry: { state: string; rawBody: string; requestHash: string } }
    expect(['attempted', 'unknown']).toContain(slot.entry.state)
    expect(slot.entry.rawBody).toBe(current.request.packet.rawBody)
    expect(slot.entry.requestHash).toBe(current.request.packet.requestHash)
    expect(network.posts()).toHaveLength(1)
    await loginOwnerSession('synthetic-new-session-password')
    const secondPanel = await current.store.enableWorkspaceSync(true)
    await secondPanel.hydrate(); await secondPanel.reconcileReceipt()
    expect(secondPanel.status().resultReady).toBe(true)
    expect(network.posts()).toHaveLength(1)
  })

  it('keeps an exact local preparation tuple across panel callers and reopens only existing storage to reconcile a real committed request', async () => {
    let fault!: ReturnType<typeof loseResponseAfterRealCommit>
    const current = await fixture(true, () => { fault = loseResponseAfterRealCommit('prepareCloud') }), managed = await enabled(current)
    await edit(current.store)
    const request = await managed.previewPreparation('integration-lost-prepare-0001'), names = (await factory.databases()).map(row => row.name).sort()
    await expect(managed.commitPreparation(request, true)).rejects.toBeInstanceOf(Error)
    const tuple = { operation: 'prepare', id: request.id, hash: request.hash }
    expect(managed.status().uncertainLocal).toEqual(tuple)
    const secondPanel = await current.store.enableWorkspaceSync(true)
    expect(secondPanel).toBe(managed); expect(secondPanel.status().uncertainLocal).toEqual(tuple)
    await expect(secondPanel.reconcileLocal(request.id, request.packet.requestHash)).rejects.toBeInstanceOf(Error)
    expect(secondPanel.status().uncertainLocal).toEqual(tuple)
    await secondPanel.reconcileLocal(request.id, request.hash)
    expect(secondPanel.status().uncertainLocal).toBeNull()
    expect(secondPanel.getState()?.sync.pending?.preparationHash).toBe(request.hash)
    expect(secondPanel.getState()?.local.outbox.entry?.rawBody).toBe(request.packet.rawBody)
    expect(fault.commits()).toBe(1)
    expect(fault.calls.length).toBeGreaterThanOrEqual(2)
    expect(fault.calls.every(call => call.target === current.target && call.existingOnly === true)).toBe(true)
    expect((await factory.databases()).map(row => row.name).sort()).toEqual(names)
    expect(network.posts()).toHaveLength(0)
  })

  it('applies a genuine matched POST + complete D ACK and reopens the same target with the original archive/manual/zero/null semantics', async () => {
    const current = await prepared()
    await current.managed.sendOnce(); await current.managed.pullComplete()
    const preview = await current.managed.previewAcknowledgement('integration-ack-0001')
    expect(preview.request).not.toBeNull()
    const result = await current.managed.commitAcknowledgement(preview.request!, true)
    expect(result.sync.pending).toBeNull(); expect(result.local.outbox.entry).toBeNull()
    expect(result.sync.base?.pulledRevision).toBe(2)
    expect(result.sync.base?.records.find(row => row.kind === 'manual_asset')?.values).toEqual({ name: '合成现金', cls: '现金', value: 0, note: null })
    expect(current.store.recordsFor('510300')[0]).toMatchObject({ shares: 7, cost: null, target_weight: null, local_pending: true })
    expect(current.store.recordsFor('000003')[0].updated_at).toBeNull()
    expect(current.store.hasLocalChanges()).toBe(true)
    const backup = await current.store.createSyncRecoveryBackup(), decoded = await restoreOwnerWorkspaceRecoveryBackup(backup.raw, backup.sha256)
    expect(decoded).toMatchObject({ physicalVersion: 4, targetFingerprint: current.target })
    expect(decoded.local.sync?.recentReceipt?.operation).toBe('ack')
    expect(decoded.local.sync?.base).toEqual(result.sync.base)
    expect(decoded.local.outbox.entry).toBeNull()
    expect(canonicalOwnerLocal(decoded.local)).toBe(canonicalOwnerLocal(result.local))
    expect(canonicalOwnerLocal(decoded.local.sync)).toBe(canonicalOwnerLocal(result.sync))
    expect(backup.raw).not.toContain(TOKEN)
    const expected = canonicalOwnerLocal(result)
    current.store.$dispose()
    const store = await createStore(), reopened = await store.enableWorkspaceSync(true)
    await reopened.hydrate()
    expect(canonicalOwnerLocal(reopened.getState())).toBe(expected)
    expect(store.localSyncFormat).toBe('v4')
    expect(network.posts()).toHaveLength(1)
    expect(data.get(LS)).toBe(current.originalLS)
    const locator = await openOwnerAuthority(factory, localStorage)
    expect(await locator.read()).toEqual(current.pointer); locator.close()
  })

  it('preserves the ACK envelope after a true atomic clear succeeded but its response was lost, without a second POST or ACK', async () => {
    let fault!: ReturnType<typeof loseResponseAfterRealCommit>
    const current = await fixture(true, () => { fault = loseResponseAfterRealCommit('ackCloud') }), managed = await enabled(current)
    await edit(current.store)
    const prepare = await managed.previewPreparation('integration-before-lost-ack-0001')
    await managed.commitPreparation(prepare, true); await managed.sendOnce(); await managed.pullComplete()
    const preview = await managed.previewAcknowledgement('integration-lost-ack-0001'), request = preview.request!
    await expect(managed.commitAcknowledgement(request, true)).rejects.toBeInstanceOf(Error)
    const tuple = { operation: 'ack', id: request.id, hash: request.hash }
    expect(managed.status().uncertainLocal).toEqual(tuple)
    const persisted = await image(current.target)
    expect((persisted.slot[0] as { entry: unknown }).entry).toBeNull()
    const nextPanel = await current.store.enableWorkspaceSync(true)
    expect(nextPanel.status().uncertainLocal).toEqual(tuple)
    await nextPanel.reconcileLocal(request.id, request.hash)
    expect(nextPanel.status().uncertainLocal).toBeNull()
    expect(nextPanel.getState()?.sync.pending).toBeNull()
    expect(nextPanel.getState()?.sync.base?.pulledRevision).toBe(2)
    expect(fault.commits()).toBe(1)
    expect(fault.calls.length).toBeGreaterThanOrEqual(2)
    expect(fault.calls.every(call => call.target === current.target && call.existingOnly === true)).toBe(true)
    expect(network.posts()).toHaveLength(1)
    expect(current.store.hasLocalChanges()).toBe(true)
  })

  it('revalidates logout after synchronous Pinia publication and keeps the committed ACK tuple until manual reconciliation', async () => {
    const current = await prepared()
    await current.managed.sendOnce(); await current.managed.pullComplete()
    const preview = await current.managed.previewAcknowledgement('integration-publish-logout-ack-0001'), request = preview.request!
    // A real synchronous consumer can revoke authority during publication,
    // after the core returned but before the facade has delivered its result.
    const stop = watch(() => current.store.entries, () => clearOwnerSession(), { flush: 'sync' })
    let delivered: string
    try { delivered = await current.managed.commitAcknowledgement(request, true).then(() => 'resolved', () => 'rejected') }
    finally { stop() }
    expect(hasOwnerSession()).toBe(false)
    expect(current.managed.getState()).toBeNull()
    expect((await image(current.target)).slot[0]).toMatchObject({ entry: null })
    // A local edit would advance the version tied to the original ACK receipt.
    // Reserve it even while signed out, until that exact receipt is checked.
    const committed = await image(current.target)
    await expect(current.store.add('000008', '不得覆盖待核回执')).rejects.toMatchObject({ code: 'conflict' })
    await expect(current.store.createSyncRecoveryBackup()).rejects.toMatchObject({ code: 'conflict' })
    expect(await image(current.target)).toEqual(committed)
    await loginOwnerSession('synthetic-new-session-password')
    const nextPanel = await current.store.enableWorkspaceSync(true)
    expect({ delivered, tuple: nextPanel.status().uncertainLocal }).toEqual({ delivered: 'rejected',
      tuple: { operation: 'ack', id: request.id, hash: request.hash } })
    await nextPanel.reconcileLocal(request.id, request.hash)
    expect(nextPanel.status().uncertainLocal).toBeNull()
    expect(nextPanel.getState()?.sync.pending).toBeNull()
    expect(network.posts()).toHaveLength(1)
  })
})

// Same native SFC/custom-renderer approach as the existing component suites.
// These host nodes record rendered props; all Vue handlers, stores and guards
// remain actual production implementations, not facade/controller stubs.
interface UiNode { tag: string; text: string; children: UiNode[]; parent: UiNode | null; props: Record<string, unknown> }
const uiNode = (tag = 'root', text = ''): UiNode => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<UiNode, UiNode>({
  createElement: tag => uiNode(tag), createText: text => uiNode('#text', text), createComment: text => uiNode('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
    item.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item)
  },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const uiText = (item: UiNode): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(uiText).join(' ')
const uiAll = (item: UiNode): UiNode[] => [item, ...item.children.flatMap(uiAll)]
async function uiClick(root: UiNode, label: string) {
  const button = uiAll(root).find(item => item.tag === 'button' && uiText(item).trim() === label)
  expect(button, label).toBeDefined(); expect(button!.props.disabled, label).not.toBe(true)
  await (button!.props.onClick as () => Promise<void>)(); await nextTick()
}
async function uiCheck(root: UiNode, name: string) {
  const input = uiAll(root).find(item => item.tag === 'input' && item.props.name === name)
  expect(input, name).toBeDefined(); expect(input!.props.disabled, name).not.toBe(true)
  ;(input!.props.onChange as (event: unknown) => void)({ target: { checked: true } }); await nextTick()
}

describe('real managed SFC native-handler journey with store-owned authority', () => {
  it('clicks consent/link/prepare/send/full-D/ACK with real Pinia, session, HTTP adapter and strict IDB, then verifies a complete ACK recovery file', async () => {
    const current = await fixture(false)
    await loginOwnerSession('synthetic-ui-journey-password')
    const root = uiNode(), app = renderer.createApp(OwnerManagedSyncPanel)
    app.use(pinia); app.mount(root); apps.push(() => app.unmount()); await nextTick()
    expect(network.syncCalls).toEqual([])
    await uiCheck(root, 'owner-managed-consent'); await uiClick(root, '启用工作区本轮核对')
    expect(network.syncCalls).toEqual([])
    await uiClick(root, '完整拉取云端截止快照'); await uiClick(root, '预览建立同步基线')
    expect(uiText(root)).toContain('510300::银行')
    expect(uiText(root)).toContain('份额：0')
    expect(uiText(root)).toContain('成本：null（未知）')
    expect(uiText(root)).toContain('asset:synthetic-manual')
    await uiCheck(root, 'owner-managed-link'); await uiClick(root, '确认建立同步基线')
    expect(current.store.recordsFor('000003')[0]).toMatchObject({ shares: 5, updated_at: null })
    await edit(current.store)
    await uiClick(root, '预览本机变更提交')
    expect(uiText(root)).toContain('份额：7')
    expect(network.posts()).toHaveLength(0)
    await uiCheck(root, 'owner-managed-prepare'); await uiClick(root, '确认保存这一批提交')
    expect(uiText(root)).toContain('原包已保存')
    expect(network.posts()).toHaveLength(0)
    await uiCheck(root, 'owner-managed-send'); await uiClick(root, '单次发送这份提交')
    expect(network.posts()).toHaveLength(1)
    expect(uiText(root)).toContain('原请求已决')
    await uiClick(root, '完整拉取云端截止快照'); await uiClick(root, '预览完整核对与应用')
    expect(uiText(root)).toContain('完整核对后应用')
    expect(uiText(root)).toContain('asset:synthetic-manual')
    await uiCheck(root, 'owner-managed-ack'); await uiClick(root, '确认应用完整核对结果')
    expect(uiText(root)).toContain('已有上次同步基线')
    expect(current.store.recordsFor('510300')[0]).toMatchObject({ shares: 7, cost: null, target_weight: null, local_pending: true })
    expect(current.store.hasLocalChanges()).toBe(true)
    const backup = await current.store.createSyncRecoveryBackup(), decoded = await restoreOwnerWorkspaceRecoveryBackup(backup.raw, backup.sha256),
      actual = await current.workspace.readSyncState(current.guard)
    expect(canonicalOwnerLocal(decoded.local)).toBe(canonicalOwnerLocal(actual.local))
    expect(decoded.local.sync?.recentReceipt?.operation).toBe('ack')
    expect(decoded.local.sync?.base?.pulledRevision).toBe(2)
    expect(decoded.local.sync?.base?.records.find(row => row.kind === 'manual_asset')).toEqual(baseRecords().find(row => row.kind === 'manual_asset'))
    expect(decoded.local.outbox.entry).toBeNull()
    expect(backup.raw).not.toContain(TOKEN)
    expect(network.posts()).toHaveLength(1)
    expect(data.get(LS)).toBe(current.originalLS)
    await uiClick(root, '关闭并隐藏工作区同步')
    expect(uiAll(root).some(item => item.props.class === 'managed-private')).toBe(false)
  })
})
