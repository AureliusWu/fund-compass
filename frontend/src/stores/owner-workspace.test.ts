import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore, IDBOpenDBRequest } from 'fake-indexeddb'
import {
  openOwnerWorkspace, buildOwnerWorkspaceImportRequest, buildOwnerWorkspaceRollbackRequest,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceEditLocalRequest, buildOwnerWorkspaceRestoreLocalRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard,
} from './owner-workspace'
import {
  openOwnerSyncOutbox, OWNER_SYNC_OUTBOX_DB_PREFIX, OWNER_SYNC_OUTBOX_SCHEMA, OWNER_SYNC_OUTBOX_TIMEOUT_MS,
  type OwnerSyncOutbox, type OwnerSyncOutboxEntry,
} from './ownerSyncOutbox'
import { buildOwnerSyncRequest } from '@/utils/ownerSyncContract'
import type { OwnerCloudImportPlan, OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
import { buildCloudImportPreview } from '@/utils/owner-cloud-import'
import { buildOwnerBusinessExport, decodeOwnerLegacySeed, restoreOwnerBusinessExport } from '@/utils/owner-legacy-seed'
import { buildOwnerLegacyWorkspaceBackup, buildOwnerWorkspaceBackup, restoreOwnerWorkspaceBackup,
  type OwnerWorkspaceSourceArchive } from '@/utils/owner-workspace-backup'

const TARGET = 'a'.repeat(64)
const handles: (OwnerWorkspace | OwnerSyncOutbox)[] = []
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
function context() {
  const controller = new AbortController()
  const state = { active: true }
  const guard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() { if (!state.active) throw new Error('synthetic revoked') } }
  return { controller, state, guard }
}
function entry(key = '000001::账户一', shares: number | null = null, deleted = false): OwnerWorkspaceEntry {
  return { key, kind: 'holding', deleted, values: { name: '合成基金', shares, cost: null, target_weight: null }, local_pending: true }
}
function plan(preimage: readonly OwnerWorkspaceEntry[] = [], additions = [entry()]): OwnerCloudImportPlan {
  return { schema: 'owner-cloud-import-1', targetFingerprint: TARGET, pulledRevision: 1,
    preimage, postimage: [...preimage, ...additions], excludedManualAssets: 0 }
}
async function packet(localVersion = 0, outboxVersion = 0, preimage: readonly OwnerWorkspaceEntry[] = [],
  additions = [entry()], id = 'synthetic-import-0001') {
  return buildOwnerWorkspaceImportRequest(TARGET, { id, plan: plan(preimage, additions),
    expectedLocalVersion: localVersion, expectedOutboxVersion: outboxVersion })
}
async function open(factory = new IDBFactory()) {
  const handle = await openOwnerWorkspace(factory, TARGET); handles.push(handle); return handle
}
async function outbox(factory: IDBFactory) {
  const handle = await openOwnerSyncOutbox(factory, TARGET); handles.push(handle); return handle
}
function rawOpen(factory: IDBFactory, version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET, version)
    request.onupgradeneeded = () => upgrade?.(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function rawRead(factory: IDBFactory, name: string, key: string) {
  const db = await rawOpen(factory)
  try { return await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(name), request = tx.objectStore(name).get(key)
    let value: unknown
    request.onsuccess = () => { value = request.result }
    tx.oncomplete = () => resolve(value); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function rawPut(factory: IDBFactory, name: string, key: string, value: unknown) {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite'); tx.objectStore(name).put(value, key)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function prepared(): Promise<OwnerSyncOutboxEntry> {
  const built = await buildOwnerSyncRequest({ request_id: 'synthetic-outbox-0001', expected_revision: 0,
    operations: [{ key: '000002::另一个账户', kind: 'watch', deleted: false,
      changes: { name: '合成基金二', shares: 0, cost: null, target_weight: null } }] })
  return { schema: OWNER_SYNC_OUTBOX_SCHEMA, state: 'prepared', rawBody: built.rawBody, requestHash: built.requestHash }
}
const localArchive = (rows: unknown[] = [{ code: '000001', name: '合成基金', account: '账户一', position_kind: 'holding',
  shares: 0, cost: null, target_weight: null, updated_at: '2026-10-20T00:00:00Z' }]): OwnerWorkspaceSourceArchive => ({
  sourceKey: 'sinan_watchlist_v2', v1Raw: 'old unselected raw retained', v2Raw: JSON.stringify(rows),
})
async function activate(workspace: OwnerWorkspace, archive = localArchive(), guard = context().guard) {
  const backup = await buildOwnerLegacyWorkspaceBackup(archive), expected = await workspace.readLocalState(guard)
  const request = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'synthetic-local-adopt-0001', expected,
    sourceArchive: archive, backupSha256: backup.sha256 })
  return workspace.adoptLocal(request, guard)
}

describe('explicit shared Owner workspace IDB foundation', () => {
  it('roundtrips the business export before adopting a strict legacy seed, then imports and rolls back cloud-only additions', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    const source = { sourceKey: 'sinan_watchlist_v2' as const, raw: ' \n' + JSON.stringify([
      { code: '000001', name: '合成零份', account: '账户一', position_kind: 'holding', shares: 0,
        cost: null, target_weight: 0, updated_at: '2026-10-20T00:00:00.000Z', local_pending: true },
      { code: '000002', name: '合成删除', account: '旧账户', position_kind: 'watch', shares: null,
        deleted: true, updated_at: '2026-10-19T00:00:00Z' },
    ], null, 2) + '\r\n' }
    const seed = decodeOwnerLegacySeed(source), backup = await buildOwnerBusinessExport(seed.entries)
    expect((await restoreOwnerBusinessExport(backup.raw, backup.sha256)).entries).toEqual(seed.entries)
    const adopted = await workspace.adoptLegacy(seed, 0, 0, guard)
    expect(adopted).toEqual({ localVersion: 1, entries: seed.entries, legacy: source })
    expect(await (await outbox(factory)).read()).toEqual({ version: 1, entry: null })
    const baseline = { pulledRevision: 1, records: [{ key: '000003::云账户', kind: 'holding', deleted: false,
      values: { name: '合成云记录', shares: 5, cost: 0, target_weight: null },
      record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 } }] }
    const preview = buildCloudImportPreview(baseline, adopted, TARGET)
    expect(preview.issues).toEqual([])
    const request = await buildOwnerWorkspaceImportRequest(TARGET, { id: 'synthetic-codec-import-0001',
      plan: preview.plan!, expectedLocalVersion: 1, expectedOutboxVersion: 1 })
    const receipt = await workspace.importCloud(request, guard), imported = await workspace.read(guard)
    expect(imported.entries.slice(0, 2)).toEqual(seed.entries)
    expect(imported.entries[2]).toMatchObject({ key: '000003::云账户', local_pending: true, values: { shares: 5, cost: 0 } })
    expect(imported.legacy).toEqual(source)
    const rollback = await buildOwnerWorkspaceRollbackRequest(TARGET, { id: 'synthetic-codec-rollback-0001',
      importId: receipt.id, importHash: receipt.hash, expectedSnapshot: imported, expectedOutboxVersion: 2 })
    await workspace.rollbackImport(rollback, guard)
    const restored = await workspace.read(guard)
    expect(restored).toEqual({ ...adopted, localVersion: 3 })
    expect((await restoreOwnerBusinessExport(backup.raw, backup.sha256)).entries).toEqual(restored.entries)
    expect(await workspace.receipt(request.id, request.hash, guard)).toEqual({ state: 'matched', receipt })
    // Injected fake-indexeddb integration is not a browser download or physical recovery proof.
  })

  it('uses only injected IDB, never browser globals, LS, Gist timers or network', async () => {
    const forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden })
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    expect(await workspace.read(guard)).toEqual({ localVersion: 0, entries: [], legacy: null })
    await workspace.importCloud(await packet(), guard)
    expect(forbidden).not.toHaveBeenCalled()
    const db = await rawOpen(factory)
    expect(db.version).toBe(3)
    expect([...db.objectStoreNames]).toEqual(['import_receipts', 'local_metadata', 'slot', 'working_copy'])
    db.close()
  })

  it.each(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const)('upgrades v1 preserving every %s slot field and refuses import', async state => {
    const factory = new IDBFactory(), previous = await outbox(factory), original = await prepared()
    await previous.compareAndSwap(0, original)
    if (state !== 'prepared') await previous.compareAndSwap(1, { ...original, state: 'attempted' })
    if (!['prepared', 'attempted'].includes(state)) await previous.compareAndSwap(2, { ...original, state })
    const before = await rawRead(factory, 'slot', 'current')
    const workspace = await open(factory), guard = context().guard
    await expect(previous.read()).rejects.toMatchObject({ code: 'outbox_closed' })
    expect(await rawRead(factory, 'slot', 'current')).toEqual(before)
    const current = await outbox(factory)
    const saved = await current.read()
    expect(saved.entry?.rawBody).toBe(original.rawBody)
    expect(saved.entry?.requestHash).toBe(original.requestHash)
    await expect(workspace.importCloud(await packet(0, saved.version), guard)).rejects.toMatchObject({ code: 'workspace_pending' })
    expect(await rawRead(factory, 'slot', 'current')).toEqual(before)
    expect(await workspace.read(guard)).toEqual({ localVersion: 0, entries: [], legacy: null })
  })

  it('atomically commits independent local and empty-slot epochs plus exact receipt and retains zero/null/tombstones', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    const additions = [entry('000001::账户一', null), entry('000001::账户二', 0), entry('000002::已删账户', -0, true)]
    const request = await packet(0, 0, [], additions)
    const receipt = await workspace.importCloud(request, guard)
    expect(receipt).toMatchObject({ id: request.id, hash: request.hash, operation: 'import', beforeLocalVersion: 0, localVersion: 1, outboxVersion: 1 })
    const state = await workspace.read(guard)
    expect(state.entries).toEqual(additions)
    expect(Object.is(state.entries[2].values.shares, -0)).toBe(true)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.entries[0].values)).toBe(true)
    expect(await (await outbox(factory)).read()).toEqual({ version: 1, entry: null })
    expect(await workspace.importCloud(request, guard)).toEqual(receipt)
    expect(await workspace.read(guard)).toEqual(state)
    expect(await workspace.receipt(request.id, request.hash, guard)).toEqual({ state: 'matched', receipt })
  })

  it('serializes two independent handles with the same CAS versions so only one import wins', async () => {
    const factory = new IDBFactory(), first = await open(factory), second = await open(factory), guard = context().guard
    const one = await packet(), two = await packet(0, 0, [], [entry('000002::二')], 'synthetic-import-0002')
    const results = await Promise.allSettled([first.importCloud(one, guard), second.importCloud(two, guard)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await first.read(guard)).localVersion).toBe(1)
    expect((await second.read(guard)).entries).toHaveLength(1)
    expect(await (await outbox(factory)).read()).toEqual({ version: 1, entry: null })
  })

  it('serializes an old-tab prepare racing import: exactly one succeeds and no request is sent', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), pending = await outbox(factory), guard = context().guard
    const send = vi.fn(); vi.stubGlobal('fetch', send)
    const request = await packet(), original = await prepared()
    const results = await Promise.allSettled([workspace.importCloud(request, guard), pending.compareAndSwap(0, original)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const state = await workspace.read(guard), slot = await pending.read()
    expect(state.localVersion === 1 ? slot : state.entries).toEqual(state.localVersion === 1 ? { version: 1, entry: null } : [])
    if (state.localVersion === 0) expect(slot.entry).toEqual(original)
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps copy, slot epoch and receipt rolled back after a successful put followed by abort', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = original.call(this, value, key)
      if (this.name === 'working_copy') result.addEventListener('success', () => this.transaction.abort())
      return result
    })
    await expect(workspace.importCloud(request, guard)).rejects.toMatchObject({ code: 'workspace_aborted' })
    expect(await workspace.read(guard)).toEqual({ localVersion: 0, entries: [], legacy: null })
    expect(await workspace.receipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
    expect(await (await outbox(factory)).read()).toEqual({ version: 0, entry: null })
  })

  it('does not claim success after actual commit then close; explicit reopen receipt observes the only committed import', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    const original = IDBDatabase.prototype.transaction
    let commits = 0
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = original.call(this, names, mode, options)
      if (mode === 'readwrite') tx.addEventListener('complete', () => { commits++; workspace.close() })
      return tx
    })
    await expect(workspace.importCloud(request, guard)).rejects.toMatchObject({ code: 'workspace_closed' })
    expect(commits).toBe(1)
    vi.restoreAllMocks()
    const reopened = await open(factory)
    const result = await reopened.receipt(request.id, request.hash, guard)
    expect(result.state).toBe('matched')
    expect((await reopened.read(guard)).localVersion).toBe(1)
    expect(commits).toBe(1)
  })

  it('replays an original receipt before now-stale CAS checks but rejects another hash for its ID', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    const receipt = await workspace.importCloud(request, guard), pending = await outbox(factory)
    const slot = await pending.read()
    expect(await workspace.importCloud(request, guard)).toEqual(receipt)
    const changed = await packet(0, 0, [], [entry('000002::二')], request.id)
    await expect(workspace.importCloud(changed, guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    await expect(workspace.receipt(request.id, 'b'.repeat(64), guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await pending.read()).toEqual(slot)
  })

  it('rolls back only an exact current postimage while continuing local/slot versions and retaining immutable import receipts', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    const imported = await workspace.importCloud(request, guard), after = await workspace.read(guard)
    const rollback = await buildOwnerWorkspaceRollbackRequest(TARGET, { id: 'synthetic-rollback-0001', importId: request.id,
      importHash: request.hash, expectedSnapshot: after, expectedOutboxVersion: 1 })
    const restored = await workspace.rollbackImport(rollback, guard)
    expect(restored).toMatchObject({ operation: 'rollback', localVersion: 2, outboxVersion: 2, rollbackOf: request.id })
    expect(await workspace.read(guard)).toEqual({ localVersion: 2, entries: [], legacy: null })
    expect(await workspace.rollbackImport(rollback, guard)).toEqual(restored)
    expect(await workspace.receipt(request.id, request.hash, guard)).toEqual({ state: 'matched', receipt: imported })
    expect(await (await outbox(factory)).read()).toEqual({ version: 2, entry: null })
  })

  it('refuses rollback over subsequent committed workspace work', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, first = await packet()
    await workspace.importCloud(first, guard)
    const imported = await workspace.read(guard)
    const rollback = await buildOwnerWorkspaceRollbackRequest(TARGET, { id: 'synthetic-rollback-0001', importId: first.id,
      importHash: first.hash, expectedSnapshot: imported, expectedOutboxVersion: 1 })
    await workspace.importCloud(await packet(1, 1, imported.entries, [entry('000002::二')], 'synthetic-import-0002'), guard)
    await expect(workspace.rollbackImport(rollback, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect((await workspace.read(guard)).localVersion).toBe(2)
    expect((await workspace.read(guard)).entries).toHaveLength(2)
  })

  it('preserves trusted-caller v1 seed key/raw without claiming legacy parsing or writing its storage', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    const raw = '[{"code":"000001","account":"账户一","shares":null,"local_pending":true,"legacy_unknown":"preserved only raw"}]'
    const seed = { sourceKey: 'sinan_watchlist_v1' as const, raw, entries: [entry()] }
    const forbidden = vi.fn(); vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden })
    const saved = await workspace.adoptLegacy(seed, 0, 0, guard)
    expect(saved).toEqual({ localVersion: 1, entries: seed.entries, legacy: { sourceKey: seed.sourceKey, raw } })
    expect(await (await outbox(factory)).read()).toEqual({ version: 1, entry: null })
    await expect(workspace.adoptLegacy(seed, 1, 1, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('rejects lone-surrogate legacy raw both on adoption and when reading a corrupt stored row', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    await expect(workspace.adoptLegacy({ sourceKey: 'sinan_watchlist_v1', raw: '\ud800', entries: [] }, 0, 0, guard))
      .rejects.toMatchObject({ code: 'workspace_invalid_input' })
    const current = await rawRead(factory, 'working_copy', 'current') as { snapshot: OwnerWorkspaceSnapshot }
    await rawPut(factory, 'working_copy', 'current', { ...current,
      snapshot: { ...current.snapshot, legacy: { sourceKey: 'sinan_watchlist_v2', raw: '\ud800' } } })
    await expect(workspace.read(guard)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(await (await outbox(factory)).read()).toEqual({ version: 0, entry: null })
  })

  it('checks the supplied source generation again under the write lock, rejecting observed raw ABA', async () => {
    const factory = new IDBFactory(), workspace = await open(factory)
    const source = { raw: '[]', generation: 0 }, controller = new AbortController()
    const guard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() {
      if (source.raw !== '[]' || source.generation !== 0) throw new Error('synthetic source changed')
    } }
    const original = IDBObjectStore.prototype.get
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const result = original.call(this, key)
      if (this.transaction.mode === 'readwrite') result.addEventListener('success', () => {
        source.raw = '["synthetic-other"]'; source.generation++; source.raw = '[]'; source.generation++
      })
      return result
    })
    await expect(workspace.adoptLegacy({ sourceKey: 'sinan_watchlist_v1', raw: '[]', entries: [] }, 0, 0, guard))
      .rejects.toMatchObject({ code: 'workspace_context_changed' })
    vi.restoreAllMocks()
    expect((await workspace.read(context().guard)).localVersion).toBe(0)
  })

  it('rejects revoked guards, aborts a transaction on permission loss, and suppresses late committed result display', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), ctx = context(), request = await packet()
    ctx.state.active = false
    await expect(workspace.read(ctx.guard)).rejects.toMatchObject({ code: 'workspace_context_changed' })
    ctx.state.active = true
    const original = IDBObjectStore.prototype.get
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const result = original.call(this, key)
      if (this.transaction.mode === 'readwrite') result.addEventListener('success', () => ctx.controller.abort())
      return result
    })
    await expect(workspace.importCloud(request, ctx.guard)).rejects.toMatchObject({ code: 'workspace_context_changed' })
    vi.restoreAllMocks()
    const reopened = await open(factory), next = context().guard
    expect(await reopened.read(next)).toEqual({ localVersion: 0, entries: [], legacy: null })
    expect(await reopened.receipt(request.id, request.hash, next)).toEqual({ state: 'unknown' })
  })

  it('does not display an import committed just before its generation was revoked', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), ctx = context(), request = await packet()
    const original = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = original.call(this, names, mode, options)
      if (mode === 'readwrite') tx.addEventListener('complete', () => { ctx.state.active = false })
      return tx
    })
    await expect(workspace.importCloud(request, ctx.guard)).rejects.toMatchObject({ code: 'workspace_context_changed' })
    vi.restoreAllMocks()
    expect((await (await open(factory)).receipt(request.id, request.hash, context().guard)).state).toBe('matched')
  })

  it.each(['relaxed', 'default', 'missing', 'throw'] as const)('rejects actual %s durability before upgrade mutates the v1 schema', async mode => {
    const factory = new IDBFactory(), pending = await outbox(factory), original = IDBDatabase.prototype.transaction
    const before = await rawRead(factory, 'slot', 'current')
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, transactionMode, options) {
      const tx = original.call(this, names, transactionMode, options)
      if (transactionMode === 'readwrite') Object.defineProperty(tx, 'durability', { configurable: true, get() {
        if (mode === 'throw') throw new Error('synthetic only')
        return mode === 'missing' ? undefined : mode
      } })
      return tx
    })
    await expect(openOwnerWorkspace(factory, TARGET)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    vi.restoreAllMocks()
    const db = await rawOpen(factory)
    expect(db.version).toBe(1); expect([...db.objectStoreNames]).toEqual(['slot']); db.close()
    expect(await rawRead(factory, 'slot', 'current')).toEqual(before)
    expect(await pending.read()).toEqual({ version: 0, entry: null })
  })

  it('rejects corrupted existing slot bytes without upgrading, repairing or overwriting', async () => {
    const factory = new IDBFactory(), pending = await outbox(factory), original = await prepared()
    const corrupt = { version: 8, entry: { ...original, requestHash: '0'.repeat(64) }, resourceFingerprint: TARGET }
    await rawPut(factory, 'slot', 'current', corrupt)
    await expect(openOwnerWorkspace(factory, TARGET)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(await rawRead(factory, 'slot', 'current')).toEqual(corrupt)
    const db = await rawOpen(factory); expect(db.version).toBe(1); db.close(); pending.close()
  })

  it('does not repair an incompatible v2 schema or extra working row', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    await rawPut(factory, 'working_copy', 'unexpected-key', { synthetic: true })
    await expect(workspace.read(guard)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    workspace.close()
    await expect(openOwnerWorkspace(factory, TARGET)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(await rawRead(factory, 'working_copy', 'unexpected-key')).toEqual({ synthetic: true })
  })

  it.each(['missing_current', 'bad_keypath'] as const)('refuses a partial/incompatible v2 %s without reconstructing a working copy', async mode => {
    const factory = new IDBFactory()
    const row = { version: 4, entry: null, resourceFingerprint: TARGET }
    const db = await rawOpen(factory, 2, database => {
      database.createObjectStore('slot').put(row, 'current')
      database.createObjectStore('working_copy', mode === 'bad_keypath' ? { keyPath: 'syntheticKey' } : undefined)
      database.createObjectStore('import_receipts')
    })
    db.close()
    await expect(openOwnerWorkspace(factory, TARGET)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(await rawRead(factory, 'slot', 'current')).toEqual(row)
    expect(await rawRead(factory, 'working_copy', 'current')).toBeUndefined()
  })

  it('detects changed stored receipt images instead of treating hash-shaped metadata as an authentic replay', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    await workspace.importCloud(request, guard)
    const stored = await rawRead(factory, 'import_receipts', request.id) as { after: OwnerWorkspaceSnapshot }
    await rawPut(factory, 'import_receipts', request.id, { ...stored, after: { ...stored.after, entries: [entry('000002::changed')] } })
    await expect(workspace.receipt(request.id, request.hash, guard)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    await expect(workspace.importCloud(request, guard)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect((await workspace.read(guard)).entries).toEqual([entry()])
  })

  it('refuses receipt capacity before issuing any put and does not erase history', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    const original = IDBObjectStore.prototype.count
    vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(function (this: IDBObjectStore, query) {
      const result = original.call(this, query)
      if (this.name === 'import_receipts') result.addEventListener('success', () => {
        Object.defineProperty(result, 'result', { value: 200, configurable: true })
      })
      return result
    })
    const put = vi.spyOn(IDBObjectStore.prototype, 'put'), add = vi.spyOn(IDBObjectStore.prototype, 'add')
    await expect(workspace.importCloud(request, guard)).rejects.toMatchObject({ code: 'workspace_capacity' })
    expect(put).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect((await workspace.read(guard)).localVersion).toBe(0)
    expect(await workspace.receipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
  })

  it('refuses blocked upgrades and aborts their late upgrade after the blocker closes', async () => {
    const factory = new IDBFactory(), pending = await outbox(factory), blocker = await rawOpen(factory)
    blocker.onversionchange = () => { /* simulate an older tab that ignores versionchange */ }
    const before = await pending.read()
    await expect(openOwnerWorkspace(factory, TARGET)).rejects.toMatchObject({ code: 'workspace_blocked' })
    blocker.close()
    const db = await rawOpen(factory)
    expect(db.version).toBe(1); expect([...db.objectStoreNames]).toEqual(['slot']); db.close()
    expect(await (await outbox(factory)).read()).toEqual(before)
  })

  it('rejects same-version corruption, request substitution and exhausted local counters without partial writes', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    await expect(workspace.importCloud({ ...request, hash: '0'.repeat(64) }, guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    const raw = await rawRead(factory, 'working_copy', 'current') as { snapshot: OwnerWorkspaceSnapshot }
    await rawPut(factory, 'working_copy', 'current', { ...raw, snapshot: { ...raw.snapshot, entries: [entry()] } })
    await expect(workspace.read(guard)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    workspace.close()
    await rawPut(factory, 'working_copy', 'current', { ...raw, snapshot: { ...raw.snapshot, localVersion: Number.MAX_SAFE_INTEGER } })
    const reopened = await open(factory)
    await expect(reopened.importCloud(await packet(Number.MAX_SAFE_INTEGER), guard)).rejects.toMatchObject({ code: 'workspace_version_exhausted' })
    expect((await reopened.read(guard)).entries).toEqual([])
    expect(await reopened.receipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
  })

  it('hashes complete -0 preimages without folding them into +0', async () => {
    const zero = await packet(0, 0, [], [entry('000001::账户一', 0)])
    const negativeZero = await packet(0, 0, [], [entry('000001::账户一', -0)])
    expect(zero.hash).not.toBe(negativeZero.hash)
  })

  it('rejects IDB quota failure atomically rather than falling back to LS', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    const original = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'import_receipts') throw new DOMException('synthetic-private-only', 'QuotaExceededError')
      return original.call(this, value, key)
    })
    await expect(workspace.importCloud(request, guard)).rejects.toMatchObject({ code: 'workspace_quota', message: 'Owner workspace operation rejected' })
    expect((await workspace.read(guard)).localVersion).toBe(0)
    expect(await (await outbox(factory)).read()).toEqual({ version: 0, entry: null })
    expect(await workspace.receipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
  })

  it('bounds async hashing and never starts a late write after timeout', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const original = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { await wait; return original(...args) })
    vi.useFakeTimers()
    const operation = workspace.importCloud(request, guard)
    const rejected = expect(operation).rejects.toMatchObject({ code: 'workspace_timeout' })
    await vi.advanceTimersByTimeAsync(OWNER_SYNC_OUTBOX_TIMEOUT_MS)
    await rejected
    release(); vi.restoreAllMocks(); vi.useRealTimers()
    const reopened = await open(factory)
    expect((await reopened.read(guard)).localVersion).toBe(0)
    expect(await reopened.receipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
  })

  it('cancels the initial outbox open on the shared deadline before a late upgrade can create anything', async () => {
    vi.useFakeTimers()
    const factory = new IDBFactory(), request = new IDBOpenDBRequest()
    vi.spyOn(factory, 'open').mockReturnValue(request)
    const operation = openOwnerWorkspace(factory, TARGET)
    const rejected = expect(operation).rejects.toMatchObject({ code: 'workspace_timeout' })
    await vi.advanceTimersByTimeAsync(OWNER_SYNC_OUTBOX_TIMEOUT_MS)
    await rejected
    const create = vi.fn(), abort = vi.fn()
    Object.defineProperty(request, 'result', { value: { objectStoreNames: { length: 0 }, createObjectStore: create } })
    Object.defineProperty(request, 'transaction', { value: { abort } })
    request.onupgradeneeded!.call(request, { oldVersion: 0 } as IDBVersionChangeEvent)
    expect(abort).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('aborts a genuinely active initial upgrade after slot put succeeds but before the transaction commits', async () => {
    const factory = new IDBFactory(), controller = new AbortController(), original = IDBObjectStore.prototype.put
    let observedAbort!: () => void
    const aborted = new Promise<void>(resolve => { observedAbort = resolve })
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = original.call(this, value, key)
      if (this.transaction.mode === 'versionchange') {
        this.transaction.addEventListener('abort', observedAbort, { once: true })
        result.addEventListener('success', () => controller.abort(), { once: true })
      }
      return result
    })
    await expect(openOwnerSyncOutbox(factory, TARGET, controller.signal)).rejects.toMatchObject({ code: 'outbox_closed' })
    await aborted
    expect(await factory.databases()).toEqual([])
  })
})

describe('actual local workspace v3 commands and backup restoration (injected synthetic IDB)', () => {
  it('adopts only actual strict raw conversion and binds backup, both archives and real display timestamps', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    const archive = localArchive(), expected = await workspace.readLocalState(guard), backup = await buildOwnerLegacyWorkspaceBackup(archive)
    const request = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'synthetic-local-adopt-0001', expected,
      sourceArchive: archive, backupSha256: backup.sha256 })
    await expect(workspace.adoptLocal({ ...request, backupSha256: 'b'.repeat(64) }, guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    const bad = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: request.id, expected, sourceArchive: archive, backupSha256: 'b'.repeat(64) })
    await expect(workspace.adoptLocal(bad, guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    const state = await workspace.adoptLocal(request, guard)
    expect(state.snapshot).toMatchObject({ localVersion: 1, entries: [{ values: { shares: 0, cost: null } }] })
    expect(state.metadata).toMatchObject({ adoption: { id: request.id, hash: request.hash, backupSha256: backup.sha256, sourceArchive: archive },
      displayTimes: [{ key: '000001::账户一', updated_at: '2026-10-20T00:00:00Z' }], recentEdit: null, restoredArchives: [] })
    expect(state.outbox).toEqual({ version: 1, entry: null }); expect(state.receiptCount).toBe(0)
    expect(await rawRead(factory, 'working_copy', 'current')).toEqual({ schema: 'owner-workspace-1', targetFingerprint: TARGET, snapshot: state.snapshot })
    workspace.close()
    expect(await (await openOwnerWorkspace(factory, TARGET, { existingOnly: true })).readLocalState(guard)).toEqual(state)
  })

  it('activates a genuinely empty device and rejects existing cloud candidate entries/receipts', async () => {
    const workspace = await open(), guard = context().guard
    const empty = await activate(workspace, { sourceKey: null, v1Raw: null, v2Raw: null }, guard)
    expect(empty.snapshot).toEqual({ localVersion: 1, entries: [], legacy: null })
    const other = await open(); await other.importCloud(await packet(), guard)
    await expect(activate(other, localArchive(), guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
  })

  it('rejects an empty-looking candidate with nonzero localVersion even without import receipt rows', async () => {
    const factory = new IDBFactory(), db = await rawOpen(factory, 2, value => {
      value.createObjectStore('slot').put({ version: 0, entry: null, resourceFingerprint: TARGET }, 'current')
      value.createObjectStore('working_copy').put({ schema: 'owner-workspace-1', targetFingerprint: TARGET,
        snapshot: { localVersion: 1, entries: [], legacy: null } }, 'current'); value.createObjectStore('import_receipts')
    }); db.close()
    const workspace = await open(factory), before = await workspace.readLocalState(context().guard)
    await expect(activate(workspace, { sourceKey: null, v1Raw: null, v2Raw: null })).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await workspace.readLocalState(context().guard)).toEqual(before)
  })

  it('saves an exact zero holding, renames atomically with an old tombstone, then removes multiple accounts atomically', async () => {
    const workspace = await open(), guard = context().guard, initial = await activate(workspace, localArchive(), guard)
    const renamed = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0001', expected: initial,
      command: { type: 'save', input: { code: '000001', name: '合成基金', account: ' 新账户 ', position_kind: 'holding',
        shares: 0, cost: null, target_weight: 0 }, expectedEntry: initial.snapshot.entries[0], confirmed: false } })
    const next = await workspace.editLocal(renamed, guard)
    expect(next.snapshot.entries).toMatchObject([{ key: '000001::账户一', deleted: true, local_pending: true },
      { key: '000001::新账户', deleted: false, kind: 'holding', local_pending: true, values: { shares: 0, cost: null, target_weight: 0 } }])
    expect(next.metadata.displayTimes[0].updated_at).toBe(next.metadata.displayTimes[1].updated_at)
    expect(next.metadata.recentEdit).toMatchObject({ id: renamed.id, hash: renamed.hash, beforeLocalVersion: 1, localVersion: 2, outboxVersion: 2 })
    const add = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0002', expected: next,
      command: { type: 'save', input: { code: '000001', name: '合成基金', account: '第三账户', position_kind: 'watch', shares: null,
        cost: null, target_weight: null }, expectedEntry: null, confirmed: false } })
    const added = await workspace.editLocal(add, guard), expectedEntries = added.snapshot.entries.filter(row => !row.deleted)
    const remove = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-remove-0001', expected: added,
      command: { type: 'remove', keys: expectedEntries.map(row => row.key), expectedEntries, confirmed: false } })
    await expect(workspace.editLocal(remove, guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    const confirmed = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: remove.id, expected: added,
      command: { ...remove.command, confirmed: true } })
    const removed = await workspace.editLocal(confirmed, guard)
    expect(removed.snapshot.entries.every(row => row.deleted && row.local_pending)).toBe(true)
    expect(removed.snapshot.localVersion).toBe(4); expect(removed.outbox.version).toBe(4)
  })

  it('requires exact expected entry and explicit destructive confirmation; rejects arbitrary commands/name fabrication', async () => {
    const workspace = await open(), guard = context().guard, state = await activate(workspace)
    const input = { code: '000001', name: '合成基金', account: '账户一', position_kind: 'watch' as const, shares: null, cost: null, target_weight: null }
    const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0001', expected: state,
      command: { type: 'save', input, expectedEntry: state.snapshot.entries[0], confirmed: false } })
    await expect(workspace.editLocal(request, guard)).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    await expect(buildOwnerWorkspaceEditLocalRequest(TARGET, { id: request.id, expected: state,
      command: { ...request.command, type: 'replace', entries: [] } as never })).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    await expect(buildOwnerWorkspaceEditLocalRequest(TARGET, { id: request.id, expected: state,
      command: { type: 'save', input: { ...input, name: '' }, expectedEntry: state.snapshot.entries[0], confirmed: true } }))
      .rejects.toMatchObject({ code: 'workspace_invalid_input' })
    const conflict = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: request.id, expected: state,
      command: { type: 'save', input, expectedEntry: { ...state.snapshot.entries[0], values: { ...state.snapshot.entries[0].values, shares: 99 } }, confirmed: true } })
    await expect(workspace.editLocal(conflict, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await workspace.readLocalState(guard)).toEqual(state)
  })

  it('keeps only latest edit receipt; an overwritten result is unknown and an old expected packet cannot replay', async () => {
    const workspace = await open(), guard = context().guard, initial = await activate(workspace)
    const one = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0001', expected: initial,
      command: { type: 'remove', keys: [initial.snapshot.entries[0].key], expectedEntries: initial.snapshot.entries, confirmed: true } })
    const state = await workspace.editLocal(one, guard)
    expect((await workspace.localReceipt(one.id, one.hash, guard)).state).toBe('matched')
    expect(await workspace.editLocal(one, guard)).toEqual(state)
    const two = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0002', expected: state,
      command: { type: 'save', input: { code: '000002', name: '合成二', account: '', position_kind: 'watch', shares: null,
        cost: null, target_weight: null }, expectedEntry: null, confirmed: false } })
    await workspace.editLocal(two, guard)
    expect(await workspace.localReceipt(one.id, one.hash, guard)).toEqual({ state: 'unknown' })
    await expect(workspace.editLocal(one, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    await expect(workspace.localReceipt(two.id, 'b'.repeat(64), guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect((await workspace.readLocalState(guard)).receiptCount).toBe(0)
  })

  it('permits only explicit fresh watch/null re-add of exact tombstone, never old finance or rename-to-tombstone', async () => {
    const workspace = await open(), guard = context().guard, initial = await activate(workspace)
    const removed = await workspace.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-remove-0001', expected: initial,
      command: { type: 'remove', keys: [initial.snapshot.entries[0].key], expectedEntries: initial.snapshot.entries, confirmed: true } }), guard)
    const tombstone = removed.snapshot.entries[0]
    const base = { code: '000001', name: '重新明确关注', account: '账户一', position_kind: 'watch' as const, shares: null, cost: null, target_weight: null }
    const finance = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-readd-0001', expected: removed,
      command: { type: 'save', input: { ...base, cost: 7 }, expectedEntry: tombstone, confirmed: true } })
    await expect(workspace.editLocal(finance, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    const rename = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-readd-0002', expected: removed,
      command: { type: 'save', input: { ...base, account: '改名账户' }, expectedEntry: tombstone, confirmed: true } })
    await expect(workspace.editLocal(rename, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-readd-0003', expected: removed,
      command: { type: 'save', input: base, expectedEntry: tombstone, confirmed: false } })
    const readded = await workspace.editLocal(request, guard)
    expect(readded.snapshot.entries[0]).toEqual({ key: tombstone.key, kind: 'watch', deleted: false, local_pending: true,
      values: { name: base.name, shares: null, cost: null, target_weight: null } })
    expect(readded.metadata.displayTimes[0].updated_at).not.toBe(initial.metadata.displayTimes[0].updated_at)
  })

  it('returns unknown after commit/close until an explicit existing-only reopen verifies latest receipt', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, initial = await activate(workspace)
    const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0001', expected: initial,
      command: { type: 'remove', keys: [initial.snapshot.entries[0].key], expectedEntries: initial.snapshot.entries, confirmed: true } })
    const original = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = original.call(this, names, mode, options)
      if (mode === 'readwrite') tx.addEventListener('complete', () => workspace.close())
      return tx
    })
    await expect(workspace.editLocal(request, guard)).rejects.toMatchObject({ code: 'workspace_closed' })
    vi.restoreAllMocks()
    const reopened = await openOwnerWorkspace(factory, TARGET, { existingOnly: true }); handles.push(reopened)
    expect((await reopened.localReceipt(request.id, request.hash, guard)).state).toBe('matched')
  })

  it('rolls back snapshot, metadata, timestamp and epoch together on a late metadata abort', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, initial = await activate(workspace)
    const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0001', expected: initial,
      command: { type: 'remove', keys: [initial.snapshot.entries[0].key], expectedEntries: initial.snapshot.entries, confirmed: true } })
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = original.call(this, value, key)
      if (this.name === 'local_metadata') result.addEventListener('success', () => this.transaction.abort())
      return result
    })
    await expect(workspace.editLocal(request, guard)).rejects.toMatchObject({ code: 'workspace_aborted' })
    vi.restoreAllMocks()
    expect(await workspace.readLocalState(guard)).toEqual(initial)
    expect(await workspace.localReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
  })

  it('refuses local metadata quota without partial edits or localStorage fallback', async () => {
    const workspace = await open(), guard = context().guard, initial = await activate(workspace)
    const request = await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0001', expected: initial,
      command: { type: 'remove', keys: [initial.snapshot.entries[0].key], expectedEntries: initial.snapshot.entries, confirmed: true } })
    const original = IDBObjectStore.prototype.put, fallback = vi.fn(); vi.stubGlobal('localStorage', { setItem: fallback })
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'local_metadata') throw new DOMException('synthetic only', 'QuotaExceededError')
      return original.call(this, value, key)
    })
    await expect(workspace.editLocal(request, guard)).rejects.toMatchObject({ code: 'workspace_quota' })
    vi.restoreAllMocks()
    expect(await workspace.readLocalState(guard)).toEqual(initial); expect(fallback).not.toHaveBeenCalled()
  })

  it('rechecks actual source/generation under the local adoption write lock', async () => {
    const workspace = await open(), ctx = context(), archive = localArchive(), backup = await buildOwnerLegacyWorkspaceBackup(archive)
    const initial = await workspace.readLocalState(ctx.guard), request = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, {
      id: 'synthetic-local-adopt-0001', expected: initial, sourceArchive: archive, backupSha256: backup.sha256 })
    const original = IDBObjectStore.prototype.get
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const result = original.call(this, key)
      if (this.transaction.mode === 'readwrite') result.addEventListener('success', () => { ctx.state.active = false })
      return result
    })
    await expect(workspace.adoptLocal(request, ctx.guard)).rejects.toMatchObject({ code: 'workspace_context_changed' })
    vi.restoreAllMocks()
    expect(await workspace.readLocalState(context().guard)).toEqual(initial)
  })

  it('restores only missing entries, preserves current authority/archive, blocks every same-key difference and noops repeated/empty backups', async () => {
    const workspace = await open(), guard = context().guard, state = await activate(workspace, { sourceKey: null, v1Raw: null, v2Raw: null })
    const backup = await buildOwnerLegacyWorkspaceBackup(localArchive())
    const request = await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'synthetic-local-restore-0001', expected: state, backup: backup.envelope })
    const restored = await workspace.restoreLocal(request, guard)
    expect(restored.metadata.adoption).toEqual(state.metadata.adoption)
    expect(restored.metadata.restoredArchives).toEqual([backup.envelope.sourceArchive])
    expect(restored.snapshot.entries).toEqual(backup.envelope.entries)
    const freshBackup = await buildOwnerWorkspaceBackup(restored)
    expect((await restoreOwnerWorkspaceBackup(freshBackup.raw, freshBackup.sha256)).entries).toEqual(restored.snapshot.entries)
    const repeat = await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'synthetic-local-restore-0002', expected: restored, backup: backup.envelope })
    expect(await workspace.restoreLocal(repeat, guard)).toEqual(restored)
    const removed = await workspace.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-remove-0001', expected: restored,
      command: { type: 'remove', keys: [restored.snapshot.entries[0].key], expectedEntries: restored.snapshot.entries, confirmed: true } }), guard)
    const stale = await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'synthetic-local-restore-0003', expected: removed, backup: backup.envelope })
    await expect(workspace.restoreLocal(stale, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    const empty = await buildOwnerLegacyWorkspaceBackup({ sourceKey: null, v1Raw: null, v2Raw: null })
    const noop = await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'synthetic-local-restore-0004', expected: removed, backup: empty.envelope })
    expect(await workspace.restoreLocal(noop, guard)).toEqual(removed)
  })

  it('uses a full preview preimage, so another tab cannot insert an entry after preview and silently overwrite it', async () => {
    const factory = new IDBFactory(), first = await open(factory), guard = context().guard, state = await activate(first, { sourceKey: null, v1Raw: null, v2Raw: null })
    const second = await open(factory), backup = await buildOwnerLegacyWorkspaceBackup(localArchive())
    const request = await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'synthetic-local-restore-0001', expected: state, backup: backup.envelope })
    const edited = await second.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'synthetic-local-edit-0001', expected: state,
      command: { type: 'save', input: { code: '000001', name: '并发基金', account: '账户一', position_kind: 'holding', shares: 7,
        cost: null, target_weight: null }, expectedEntry: null, confirmed: false } }), guard)
    await expect(first.restoreLocal(request, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await first.readLocalState(guard)).toEqual(edited)
  })

  it('refuses archive union capacity atomically instead of dropping old raw archives', async () => {
    const workspace = await open(), guard = context().guard
    let current = await activate(workspace, { sourceKey: null, v1Raw: null, v2Raw: null })
    for (let index = 1; index <= 8; index++) {
      const backup = await buildOwnerLegacyWorkspaceBackup(localArchive([{ code: String(index).padStart(6, '0'), name: '合成基金' + index,
        position_kind: 'watch', shares: null, updated_at: '2026-10-20' }]))
      current = await workspace.restoreLocal(await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'synthetic-local-restore-000' + index,
        expected: current, backup: backup.envelope }), guard)
    }
    const ninth = await buildOwnerLegacyWorkspaceBackup(localArchive([{ code: '000009', name: '合成基金九', position_kind: 'watch', shares: null, updated_at: '2026-10-20' }]))
    const request = await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'synthetic-local-restore-0009', expected: current, backup: ninth.envelope })
    await expect(workspace.restoreLocal(request, guard)).rejects.toMatchObject({ code: 'workspace_capacity' })
    expect(await workspace.readLocalState(guard)).toEqual(current)
    const backup = await buildOwnerWorkspaceBackup(current)
    expect((await restoreOwnerWorkspaceBackup(backup.raw, backup.sha256)).restoredArchives).toHaveLength(8)
  })

  it('refuses legacy candidate mutations after adoption, rather than desynchronizing metadata', async () => {
    const workspace = await open(), guard = context().guard, state = await activate(workspace)
    const request = await packet(1, 1, state.snapshot.entries, [entry('000002::新')])
    await expect(workspace.importCloud(request, guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    await expect(workspace.adoptLegacy({ sourceKey: 'sinan_watchlist_v2', raw: '[]', entries: [] }, 1, 1, guard))
      .rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await workspace.readLocalState(guard)).toEqual(state)
  })

  it('preserves v2 slot, working image and full receipt rows while adding nullable time metadata only', async () => {
    const donorFactory = new IDBFactory(), donor = await open(donorFactory), guard = context().guard, request = await packet()
    await donor.importCloud(request, guard)
    const oldWorking = await rawRead(donorFactory, 'working_copy', 'current'), receipt = await rawRead(donorFactory, 'import_receipts', request.id)
    const factory = new IDBFactory(), original = await prepared(), slot = { version: 8, resourceFingerprint: TARGET, entry: { ...original, state: 'unknown' } }
    const db = await rawOpen(factory, 2, value => {
      value.createObjectStore('slot').put(slot, 'current'); value.createObjectStore('working_copy').put(oldWorking, 'current')
      value.createObjectStore('import_receipts').put(receipt, request.id)
    }); db.close()
    const workspace = await open(factory), state = await workspace.readLocalState(guard)
    expect(await rawRead(factory, 'slot', 'current')).toEqual(slot)
    expect(await rawRead(factory, 'working_copy', 'current')).toEqual(oldWorking)
    expect(await rawRead(factory, 'import_receipts', request.id)).toEqual(receipt)
    expect(state.receiptCount).toBe(1); expect(state.metadata.displayTimes).toEqual([{ key: '000001::账户一', updated_at: null }])
    await expect(activate(workspace)).rejects.toMatchObject({ code: 'workspace_conflict' })
  })

  it('does not repair interrupted v3 metadata and existing-only does not create or upgrade missing/v1/v2 DBs', async () => {
    const factory = new IDBFactory()
    await expect(openOwnerWorkspace(factory, TARGET, { existingOnly: true })).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(await factory.databases()).toEqual([])
    const previous = await outbox(factory)
    await expect(openOwnerWorkspace(factory, TARGET, { existingOnly: true })).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect((await factory.databases())[0].version).toBe(1); previous.close()
    const badFactory = new IDBFactory(), db = await rawOpen(badFactory, 3, value => {
      value.createObjectStore('slot').put({ version: 0, entry: null, resourceFingerprint: TARGET }, 'current')
      value.createObjectStore('working_copy').put({ schema: 'owner-workspace-1', targetFingerprint: TARGET,
        snapshot: { localVersion: 0, entries: [], legacy: null } }, 'current')
      value.createObjectStore('import_receipts'); value.createObjectStore('local_metadata')
    }); db.close()
    await expect(open(badFactory)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(await rawRead(badFactory, 'local_metadata', 'current')).toBeUndefined()
  })

  it('detects same-local-version metadata corruption rather than accepting changed authority/time', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, state = await activate(workspace)
    await rawPut(factory, 'local_metadata', 'current', { ...state.metadata, displayTimes: [{ key: '000001::账户一', updated_at: null }] })
    await expect(workspace.readLocalState(guard)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
  })

  it('blocks all new v3 packet preparation while preserving pre-upgrade unknown packets and legal receipt clearing', async () => {
    const factory = new IDBFactory(), old = await outbox(factory), original = await prepared()
    await old.compareAndSwap(0, original); await old.compareAndSwap(1, { ...original, state: 'attempted' })
    await old.compareAndSwap(2, { ...original, state: 'unknown' }); await open(factory)
    const current = await outbox(factory)
    expect((await current.read()).entry).toEqual({ ...original, state: 'unknown' })
    await current.compareAndSwap(3, { ...original, state: 'confirmed' }); await current.compareAndSwap(4, null)
    await expect(current.compareAndSwap(5, original)).rejects.toMatchObject({ code: 'outbox_invalid_transition' })
    expect(await current.read()).toEqual({ version: 5, entry: null })
  })
})
