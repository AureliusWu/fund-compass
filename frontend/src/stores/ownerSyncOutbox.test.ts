import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore, IDBOpenDBRequest, IDBDatabase, IDBTransaction } from 'fake-indexeddb'
import * as contract from '@/utils/ownerSyncContract'
import {
  openOwnerSyncOutbox, OWNER_SYNC_OUTBOX_DB_PREFIX, OWNER_SYNC_OUTBOX_SCHEMA, OWNER_SYNC_OUTBOX_TIMEOUT_MS,
  type OwnerSyncOutbox, type OwnerSyncOutboxEntry,
} from './ownerSyncOutbox'

const TARGET = 'a'.repeat(64)
const OTHER_TARGET = 'b'.repeat(64)
const handles: OwnerSyncOutbox[] = []
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function entry(id = 'synthetic-outbox-0001', state: OwnerSyncOutboxEntry['state'] = 'prepared'): Promise<OwnerSyncOutboxEntry> {
  const built = await contract.buildOwnerSyncRequest({
    request_id: id, expected_revision: 0, operations: [{ key: 'asset:synthetic-cash', kind: 'manual_asset', deleted: false,
      changes: { name: '合成资产', cls: '现金', value: 0, note: null } }],
  })
  return { schema: OWNER_SYNC_OUTBOX_SCHEMA, state, rawBody: built.rawBody, requestHash: built.requestHash }
}
async function open(factory = new IDBFactory(), target = TARGET) {
  const handle = await openOwnerSyncOutbox(factory, target)
  handles.push(handle)
  return handle
}
function rawOpen(factory: IDBFactory, target = TARGET, version = 1, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target, version)
    request.onupgradeneeded = () => upgrade?.(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function rawWrite(factory: IDBFactory, row: unknown, key = 'current') {
  const db = await rawOpen(factory)
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('slot', 'readwrite')
      tx.objectStore('slot').put(row, key)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}

describe('injected transactional Owner outbox', () => {
  it('only initializes a new synthetic injected database and never accesses browser globals or network', async () => {
    const forbidden = vi.fn(() => { throw new Error('real browser storage forbidden') })
    vi.stubGlobal('indexedDB', { open: forbidden })
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden })
    vi.stubGlobal('fetch', forbidden)
    const handle = await open()
    expect(handle.targetFingerprint).toBe(TARGET)
    expect(await handle.read()).toEqual({ version: 0, entry: null })
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('persists exact original bytes and hash across close/reopen with frozen snapshots', async () => {
    const factory = new IDBFactory(), first = await open(factory), prepared = await entry()
    const saved = await first.compareAndSwap(0, prepared)
    expect(saved).toEqual({ version: 1, entry: prepared })
    expect(Object.isFrozen(saved)).toBe(true)
    expect(Object.isFrozen(saved.entry)).toBe(true)
    first.close()
    const reopened = await open(factory)
    expect(await reopened.read()).toEqual(saved)
    expect((await reopened.read()).entry?.rawBody).toBe(prepared.rawBody)
    expect((await reopened.read()).entry?.requestHash).toBe(prepared.requestHash)
  })

  it('serializes two independent handle CAS writers so exactly one wins', async () => {
    const factory = new IDBFactory(), first = await open(factory), second = await open(factory)
    const one = await entry('synthetic-outbox-0001'), two = await entry('synthetic-outbox-0002')
    const results = await Promise.allSettled([first.compareAndSwap(0, one), second.compareAndSwap(0, two)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'outbox_conflict' })
    const snapshot = await first.read()
    expect(snapshot.version).toBe(1)
    expect([one.requestHash, two.requestHash]).toContain(snapshot.entry?.requestHash)
    expect(await second.read()).toEqual(snapshot)
  })

  it('does not resolve a write on request success when its transaction aborts before commit', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    const original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key)
      if (this.transaction.mode === 'readwrite') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await expect(handle.compareAndSwap(0, prepared)).rejects.toMatchObject({ code: 'outbox_aborted' })
    expect(await handle.read()).toEqual({ version: 0, entry: null })
  })

  it('reports close after actual commit as closed while reopen retains exact committed bytes/version', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    const original = IDBDatabase.prototype.transaction
    let committed = 0
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = original.call(this, names, mode, options)
      if (mode === 'readwrite') {
        // fakeIDB fires complete after applying the transaction. This listener
        // runs before the wrapper's oncomplete property, not at request success.
        tx.addEventListener('complete', () => { committed += 1; handle.close() })
      }
      return tx
    })
    await expect(handle.compareAndSwap(0, prepared)).rejects.toMatchObject({ code: 'outbox_closed' })
    expect(committed).toBe(1)
    vi.restoreAllMocks()
    expect(await (await open(factory)).read()).toEqual({ version: 1, entry: prepared })
  })

  it('maps quota failure to a fixed code and does not fall back or commit', async () => {
    const handle = await open(), prepared = await entry(), original = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.transaction.mode === 'readwrite') throw new DOMException('synthetic-private-value', 'QuotaExceededError')
      return original.call(this, value, key)
    })
    await expect(handle.compareAndSwap(0, prepared)).rejects.toMatchObject({ code: 'outbox_quota', message: 'Owner sync outbox operation rejected' })
    expect(await handle.read()).toEqual({ version: 0, entry: null })
  })

  it.each(['default', 'relaxed', 'missing', 'throw'] as const)('rejects actual %s write durability before any objectStore/get/put', async mode => {
    const handle = await open(), prepared = await entry()
    const original = IDBDatabase.prototype.transaction
    let aborted = 0
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, transactionMode, options) {
      const tx = original.call(this, names, transactionMode, options)
      if (transactionMode === 'readwrite') {
        tx.addEventListener('abort', () => { aborted += 1 })
        Object.defineProperty(tx, 'durability', { configurable: true, get: () => {
          if (mode === 'throw') throw new Error('synthetic private driver value')
          return mode === 'missing' ? undefined : mode
        } })
      }
      return tx
    })
    const objectStore = vi.spyOn(IDBTransaction.prototype, 'objectStore')
    const get = vi.spyOn(IDBObjectStore.prototype, 'get')
    const put = vi.spyOn(IDBObjectStore.prototype, 'put')
    await expect(handle.compareAndSwap(0, prepared)).rejects.toMatchObject({
      code: 'outbox_unavailable', message: 'Owner sync outbox operation rejected',
    })
    expect(objectStore.mock.contexts.filter(tx => (tx as IDBTransaction).mode === 'readwrite')).toHaveLength(0)
    expect(get.mock.contexts.filter(store => (store as IDBObjectStore).transaction.mode === 'readwrite')).toHaveLength(0)
    expect(put).not.toHaveBeenCalled()
    expect(await handle.read()).toEqual({ version: 0, entry: null })
    expect(aborted).toBe(1)
  })

  it('keeps attempted durable after reload without automatically changing it to unknown', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    await handle.compareAndSwap(0, prepared)
    await handle.compareAndSwap(1, { ...prepared, state: 'attempted' })
    handle.close()
    expect(await (await open(factory)).read()).toEqual({ version: 2, entry: { ...prepared, state: 'attempted' } })
  })

  it('never clears, replaces, or directly confirms a prepared/unknown pending request', async () => {
    const handle = await open(), prepared = await entry(), replacement = await entry('synthetic-outbox-0002')
    await handle.compareAndSwap(0, prepared)
    await expect(handle.compareAndSwap(1, { ...prepared, state: 'confirmed' })).rejects.toMatchObject({ code: 'outbox_invalid_transition' })
    await handle.compareAndSwap(1, { ...prepared, state: 'attempted' })
    await expect(handle.compareAndSwap(2, null)).rejects.toMatchObject({ code: 'outbox_invalid_transition' })
    await handle.compareAndSwap(2, { ...prepared, state: 'unknown' })
    const forbidden: (OwnerSyncOutboxEntry | null)[] = [null, replacement, { ...prepared, state: 'prepared' }, { ...replacement, state: 'attempted' }]
    for (const next of forbidden) {
      await expect(handle.compareAndSwap(3, next)).rejects.toMatchObject({ code: 'outbox_invalid_transition' })
    }
    expect((await handle.read()).version).toBe(3)
    // Explicit retry permission is supplied by the separate controller, not storage.
    await handle.compareAndSwap(3, { ...prepared, state: 'attempted' })
    expect((await handle.read()).entry?.rawBody).toBe(prepared.rawBody)
  })

  it.each(['confirmed', 'conflict'] as const)('allows %s terminal clearing without deleting/resetting the version', async state => {
    const handle = await open(), prepared = await entry()
    await handle.compareAndSwap(0, prepared)
    await handle.compareAndSwap(1, { ...prepared, state: 'attempted' })
    await handle.compareAndSwap(2, { ...prepared, state })
    expect(await handle.compareAndSwap(3, null)).toEqual({ version: 4, entry: null })
  })

  it('cancels a never-attempted prepared request but prevents blank-slot ABA', async () => {
    const handle = await open(), prepared = await entry()
    await handle.compareAndSwap(0, prepared)
    expect(await handle.compareAndSwap(1, null)).toEqual({ version: 2, entry: null })
    await expect(handle.compareAndSwap(0, prepared)).rejects.toMatchObject({ code: 'outbox_conflict' })
    expect(await handle.compareAndSwap(2, prepared)).toEqual({ version: 3, entry: prepared })
  })

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe expected version %s', async version => {
    const handle = await open()
    await expect(handle.compareAndSwap(version, await entry())).rejects.toMatchObject({ code: 'outbox_conflict' })
    expect((await handle.read()).version).toBe(0)
  })

  it('fails closed at counter overflow while preserving the existing slot', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    await rawWrite(factory, { version: Number.MAX_SAFE_INTEGER, entry: null, resourceFingerprint: TARGET })
    await expect(handle.compareAndSwap(Number.MAX_SAFE_INTEGER, prepared)).rejects.toMatchObject({ code: 'outbox_version_exhausted' })
    expect(await handle.read()).toEqual({ version: Number.MAX_SAFE_INTEGER, entry: null })
  })

  it('isolates target databases and rejects mismatched resource metadata without repair', async () => {
    const factory = new IDBFactory(), one = await open(factory), two = await open(factory, OTHER_TARGET)
    await one.compareAndSwap(0, await entry())
    expect(await two.read()).toEqual({ version: 0, entry: null })
    one.close()
    await rawWrite(factory, { version: 1, entry: null, resourceFingerprint: OTHER_TARGET })
    await expect(openOwnerSyncOutbox(factory, TARGET)).rejects.toMatchObject({ code: 'outbox_invalid_database' })
    expect(await two.read()).toEqual({ version: 0, entry: null })
  })

  it.each(['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)])('validates target before opening IDB', async target => {
    const factory = new IDBFactory(), spy = vi.spyOn(factory, 'open')
    await expect(openOwnerSyncOutbox(factory, target)).rejects.toMatchObject({ code: 'outbox_invalid_target' })
    expect(spy).not.toHaveBeenCalled()
  })

  it.each(['missing', 'unknown_store', 'index', 'keypath', 'newer'])('rejects incompatible existing database %s without initializing a slot', async mode => {
    const factory = new IDBFactory()
    const db = await rawOpen(factory, TARGET, mode === 'newer' ? 2 : 1, database => {
      if (mode === 'unknown_store') database.createObjectStore('private-unknown')
      else if (mode === 'keypath') database.createObjectStore('slot', { keyPath: 'version' })
      else {
        const store = database.createObjectStore('slot')
        if (mode === 'index') store.createIndex('private-index', 'version')
      }
    })
    db.close()
    await expect(openOwnerSyncOutbox(factory, TARGET)).rejects.toMatchObject({ code: 'outbox_invalid_database' })
    const remaining = await rawOpen(factory, TARGET, mode === 'newer' ? 2 : 1)
    if (remaining.objectStoreNames.contains('slot')) {
      const request = remaining.transaction('slot').objectStore('slot').count()
      const count = await new Promise<number>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      expect(count).toBe(0)
    }
    remaining.close()
  })

  it.each([undefined, { version: -1, entry: null, resourceFingerprint: TARGET },
    { version: 0.5, entry: null, resourceFingerprint: TARGET },
    { version: Number.MAX_SAFE_INTEGER + 1, entry: null, resourceFingerprint: TARGET },
    { version: 0, entry: null, resourceFingerprint: TARGET, private: 'not-allowed' },
    { version: 0, entry: { schema: 'unknown' }, resourceFingerprint: TARGET }])('rejects a corrupted slot shape without overwriting it', async row => {
    const factory = new IDBFactory(), handle = await open(factory)
    await rawWrite(factory, row)
    await expect(handle.read()).rejects.toMatchObject({ code: 'outbox_invalid_database' })
    await expect(handle.compareAndSwap(0, await entry())).rejects.toMatchObject({ code: 'outbox_invalid_database' })
  })

  it('rejects extra slot rows and corrupted canonical request/hash without repair', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    await rawWrite(factory, { version: 1, entry: { ...prepared, requestHash: '0'.repeat(64) }, resourceFingerprint: TARGET })
    await expect(handle.read()).rejects.toMatchObject({ code: 'outbox_invalid_database' })
    await rawWrite(factory, { version: 0, entry: null, resourceFingerprint: TARGET })
    await rawWrite(factory, 'synthetic extra row', 'private-extra')
    await expect(handle.read()).rejects.toMatchObject({ code: 'outbox_invalid_database' })
  })

  it('validates next canonical bytes/hash before any readwrite transaction', async () => {
    const handle = await open(), prepared = await entry(), put = vi.spyOn(IDBObjectStore.prototype, 'put')
    for (const next of [{ ...prepared, requestHash: '0'.repeat(64) }, { ...prepared, rawBody: prepared.rawBody + ' ' },
      { ...prepared, schema: 'unknown' }, { ...prepared, state: 'other' }, { ...prepared, private: 'extra' }]) {
      await expect(handle.compareAndSwap(0, next as OwnerSyncOutboxEntry)).rejects.toMatchObject({ code: 'outbox_invalid_entry' })
    }
    expect(put).not.toHaveBeenCalled()
    expect(await handle.read()).toEqual({ version: 0, entry: null })
  })

  it('rejects close during pending hash validation and prevents its late write', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    const original = contract.restoreOwnerSyncRequest
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(contract, 'restoreOwnerSyncRequest').mockImplementation(async (rawBody, hash) => { await pending; return original(rawBody, hash) })
    const operation = handle.compareAndSwap(0, prepared)
    handle.close()
    await expect(operation).rejects.toMatchObject({ code: 'outbox_closed' })
    release()
    vi.restoreAllMocks()
    expect(await (await open(factory)).read()).toEqual({ version: 0, entry: null })
    await expect(handle.read()).rejects.toMatchObject({ code: 'outbox_closed' })
  })

  it('aborts an in-flight readwrite transaction on close instead of committing its slot', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    const original = IDBObjectStore.prototype.get
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key)
      if (this.transaction.mode === 'readwrite') request.addEventListener('success', () => handle.close())
      return request
    })
    await expect(handle.compareAndSwap(0, prepared)).rejects.toMatchObject({ code: 'outbox_closed' })
    vi.restoreAllMocks()
    expect(await (await open(factory)).read()).toEqual({ version: 0, entry: null })
  })

  it('bounds hash validation time and prevents a late write after timeout', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    const original = contract.restoreOwnerSyncRequest
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(contract, 'restoreOwnerSyncRequest').mockImplementation(async (rawBody, hash) => { await pending; return original(rawBody, hash) })
    vi.useFakeTimers()
    const operation = handle.compareAndSwap(0, prepared)
    const rejected = expect(operation).rejects.toMatchObject({ code: 'outbox_timeout' })
    await vi.advanceTimersByTimeAsync(OWNER_SYNC_OUTBOX_TIMEOUT_MS)
    await rejected
    await expect(handle.read()).rejects.toMatchObject({ code: 'outbox_closed' })
    release()
    vi.restoreAllMocks()
    vi.useRealTimers()
    expect(await (await open(factory)).read()).toEqual({ version: 0, entry: null })
  })

  it('refuses same-version corruption observed inside the CAS write transaction', async () => {
    const factory = new IDBFactory(), handle = await open(factory), prepared = await entry()
    await handle.compareAndSwap(0, prepared)
    const original = contract.restoreOwnerSyncRequest
    let restores = 0
    vi.spyOn(contract, 'restoreOwnerSyncRequest').mockImplementation(async (rawBody, hash) => {
      restores += 1
      if (restores === 2) {
        await rawWrite(factory, { version: 1, entry: { ...prepared, requestHash: '0'.repeat(64) }, resourceFingerprint: TARGET })
      }
      return original(rawBody, hash)
    })
    await expect(handle.compareAndSwap(1, { ...prepared, state: 'attempted' })).rejects.toMatchObject({ code: 'outbox_invalid_database' })
    vi.restoreAllMocks()
    await expect(handle.read()).rejects.toMatchObject({ code: 'outbox_invalid_database' })
  })

  it('closes on versionchange and refuses new operations', async () => {
    const factory = new IDBFactory(), handle = await open(factory)
    const upgraded = await rawOpen(factory, TARGET, 2)
    upgraded.close()
    await expect(handle.read()).rejects.toMatchObject({ code: 'outbox_closed' })
    await expect(handle.compareAndSwap(0, await entry())).rejects.toMatchObject({ code: 'outbox_closed' })
  })

  it.each(['blocked', 'error', 'timeout'] as const)('fails closed on open %s with a fixed error', async mode => {
    vi.useFakeTimers()
    const request = new IDBOpenDBRequest()
    const factory = new IDBFactory()
    vi.spyOn(factory, 'open').mockReturnValue(request)
    const opened = openOwnerSyncOutbox(factory, TARGET)
    const rejected = expect(opened).rejects.toMatchObject({ code: mode === 'blocked' ? 'outbox_blocked' : mode === 'error' ? 'outbox_invalid_database' : 'outbox_timeout' })
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(OWNER_SYNC_OUTBOX_TIMEOUT_MS)
    else if (mode === 'blocked') request.onblocked!.call(request, { type: 'blocked' } as IDBVersionChangeEvent)
    else {
      Object.defineProperty(request, 'error', { value: new DOMException('synthetic-private-value', 'UnknownError') })
      request.onerror!.call(request, new Event('error'))
    }
    await rejected
  })
})
