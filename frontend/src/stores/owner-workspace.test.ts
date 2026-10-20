import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore, IDBOpenDBRequest } from 'fake-indexeddb'
import {
  openOwnerWorkspace, buildOwnerWorkspaceImportRequest, buildOwnerWorkspaceRollbackRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard,
} from './owner-workspace'
import {
  openOwnerSyncOutbox, OWNER_SYNC_OUTBOX_DB_PREFIX, OWNER_SYNC_OUTBOX_SCHEMA, OWNER_SYNC_OUTBOX_TIMEOUT_MS,
  type OwnerSyncOutbox, type OwnerSyncOutboxEntry,
} from './ownerSyncOutbox'
import { buildOwnerSyncRequest } from '@/utils/ownerSyncContract'
import type { OwnerCloudImportPlan, OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'

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

describe('explicit shared Owner workspace IDB foundation', () => {
  it('uses only injected IDB, never browser globals, LS, Gist timers or network', async () => {
    const forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden })
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard
    expect(await workspace.read(guard)).toEqual({ localVersion: 0, entries: [], legacy: null })
    await workspace.importCloud(await packet(), guard)
    expect(forbidden).not.toHaveBeenCalled()
    const db = await rawOpen(factory)
    expect(db.version).toBe(2)
    expect([...db.objectStoreNames]).toEqual(['import_receipts', 'slot', 'working_copy'])
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

  it('replays an original receipt before current outbox/CAS checks but rejects another hash for its ID', async () => {
    const factory = new IDBFactory(), workspace = await open(factory), guard = context().guard, request = await packet()
    const receipt = await workspace.importCloud(request, guard), pending = await outbox(factory)
    await pending.compareAndSwap(1, await prepared())
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
