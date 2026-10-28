/** Actual synthetic IndexedDB transactions; no browser, cloud or release proof. */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { openOwnerAnalysisOutbox, type OwnerAnalysisOutbox, type OwnerAnalysisTask } from './owner-analysis-outbox'
import { buildOwnerAnalysisRequest, restoreOwnerAnalysisRequest } from '@/utils/ownerAnalysisContract'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'

const TARGET = 'e'.repeat(64), NAME = 'fund-compass-owner-analysis-1:' + TARGET
const handles: OwnerAnalysisOutbox[] = []
const signal = () => new AbortController().signal
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  const forbidden = () => { throw new Error('ambient IO forbidden') }
  vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden })
  vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden })
})
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function open(factory = new IDBFactory(), create = true) {
  const outbox = await openOwnerAnalysisOutbox(factory, TARGET, signal(), create); handles.push(outbox)
  return { factory, outbox }
}
async function task(): Promise<OwnerAnalysisTask> {
  const fixture = ownerAnalysisBackendFixture(), original = await restoreOwnerAnalysisRequest(fixture.rawBody, fixture.requestHash)
  return { state: 'prepared', rawBody: original.rawBody, requestHash: original.requestHash, contextHash: 'a'.repeat(64) }
}
async function rawDatabase(factory: IDBFactory, upgrade?: (db: IDBDatabase) => void, version = 1) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(NAME, version)
    request.onupgradeneeded = () => upgrade?.(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function mutate(factory: IDBFactory, work: (store: IDBObjectStore) => void) {
  const db = await rawDatabase(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('task', 'readwrite'); work(tx.objectStore('task'))
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}

describe('bounded original analysis task store', () => {
  it('rejects invalid target before opening and existing-only never creates a missing database', async () => {
    const factory = new IDBFactory(), opened = vi.spyOn(factory, 'open')
    await expect(openOwnerAnalysisOutbox(factory, 'bad', signal(), true)).rejects.toMatchObject({ code: 'analysis_store_invalid' })
    expect(opened).not.toHaveBeenCalled()
    await expect(openOwnerAnalysisOutbox(factory, TARGET, signal(), false)).rejects.toBeDefined()
    expect(await factory.databases()).toEqual([])
  })

  it('keeps the exact original bytes through prepared, attempted, matched and a separately confirmed clear', async () => {
    const { outbox, factory } = await open(), original = await task(), empty = await outbox.read(signal())
    expect(empty).toEqual({ version: 0, task: null })
    const prepared = await outbox.compareAndSwap(empty, original, signal())
    const attempted = await outbox.compareAndSwap(prepared, { ...original, state: 'attempted' }, signal())
    for (const next of [null, original, { ...original, state: 'attempted' as const }, { ...original, contextHash: 'b'.repeat(64), state: 'matched' as const }]) {
      await expect(outbox.compareAndSwap(attempted, next, signal())).rejects.toMatchObject({ code: 'analysis_store_conflict' })
    }
    const matched = await outbox.compareAndSwap(attempted, { ...original, state: 'matched' }, signal())
    expect(matched).toEqual({ version: 3, task: { ...original, state: 'matched' } })
    outbox.close()
    const reopened = (await open(factory, false)).outbox
    expect(await reopened.read(signal())).toEqual(matched)
    expect(await reopened.compareAndSwap(matched, null, signal())).toEqual({ version: 4, task: null })
  })

  it('allows only one actual writer from two handles sharing the same empty preimage', async () => {
    const { factory, outbox: a } = await open(), b = (await open(factory, false)).outbox
    const empty = await a.read(signal()), first = await task()
    const other = await buildOwnerAnalysisRequest({ ...ownerAnalysisBackendFixture().request, request_id: 'different-analysis-0001' })
    const competing = await Promise.allSettled([
      a.compareAndSwap(empty, first, signal()),
      b.compareAndSwap(empty, { ...first, rawBody: other.rawBody, requestHash: other.requestHash }, signal()),
    ])
    expect(competing.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect(await a.read(signal())).toEqual(await b.read(signal()))
    expect((await a.read(signal())).version).toBe(1)
  })

  it.each(['store-missing', 'extra-store', 'keypath', 'increment', 'index', 'version'])(
    'refuses an incompatible physical schema without repairing it (%s)', async fault => {
      const factory = new IDBFactory()
      const db = await rawDatabase(factory, current => {
        if (fault === 'store-missing') { current.createObjectStore('other'); return }
        const store = current.createObjectStore('task', fault === 'keypath' ? { keyPath: 'id' }
          : fault === 'increment' ? { autoIncrement: true } : undefined)
        if (fault === 'index') store.createIndex('unexpected', 'target')
        if (fault === 'extra-store') current.createObjectStore('extra')
        if (fault !== 'keypath') store.put({ version: 0, task: null, target: TARGET }, 'current')
      }, fault === 'version' ? 2 : 1)
      const names = [...db.objectStoreNames], version = db.version
      db.close()
      await expect(openOwnerAnalysisOutbox(factory, TARGET, signal(), true)).rejects.toBeDefined()
      const observed = await rawDatabase(factory, undefined, version)
      expect([...observed.objectStoreNames]).toEqual(names); expect(observed.version).toBe(version); observed.close()
    },
  )

  it.each(['missing', 'extra-row', 'extra-field', 'target', 'version', 'packet-hash'])(
    'refuses corrupted current data and does not replace it (%s)', async fault => {
      const { factory, outbox } = await open(), original = await task()
      outbox.close()
      const current: Record<string, unknown> = { version: 1, task: original, target: TARGET }
      if (fault === 'extra-field') current.private = true
      if (fault === 'target') current.target = 'b'.repeat(64)
      if (fault === 'version') current.version = -1
      if (fault === 'packet-hash') current.task = { ...original, requestHash: 'f'.repeat(64) }
      await mutate(factory, store => {
        if (fault === 'missing') store.delete('current')
        else store.put(current, 'current')
        if (fault === 'extra-row') store.put(current, 'unexpected')
      })
      await expect(openOwnerAnalysisOutbox(factory, TARGET, signal(), false)).rejects.toBeDefined()
    },
  )

  it('aborts a quota failure and refuses non-strict transaction durability', async () => {
    const { outbox } = await open(), empty = await outbox.read(signal()), original = await task()
    const put = IDBObjectStore.prototype.put
    const quota = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'task') throw new DOMException('synthetic quota full', 'QuotaExceededError')
      return put.apply(this, args)
    })
    await expect(outbox.compareAndSwap(empty, original, signal())).rejects.toBeDefined()
    quota.mockRestore(); expect(await outbox.read(signal())).toEqual(empty)
    const transaction = IDBDatabase.prototype.transaction
    const relaxed = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args)
      if (args[1] === 'readwrite') Object.defineProperty(tx, 'durability', { value: 'relaxed' })
      return tx
    })
    await expect(outbox.compareAndSwap(empty, original, signal())).rejects.toMatchObject({ code: 'analysis_store_unavailable' })
    relaxed.mockRestore(); expect(await outbox.read(signal())).toEqual(empty)
  })

  it('retains an actually committed attempted marker after its local completion response is lost', async () => {
    const { outbox } = await open(), original = await task()
    const prepared = await outbox.compareAndSwap(await outbox.read(signal()), original, signal())
    const cancelled = new AbortController(), transaction = IDBDatabase.prototype.transaction
    const lose = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args)
      if (args[1] === 'readwrite') tx.addEventListener('complete', () => cancelled.abort(), { once: true })
      return tx
    })
    await expect(outbox.compareAndSwap(prepared, { ...original, state: 'attempted' }, cancelled.signal)).rejects.toBeDefined()
    lose.mockRestore()
    const actual = await outbox.read(signal())
    expect(actual).toEqual({ version: 2, task: { ...original, state: 'attempted' } })
    await expect(outbox.compareAndSwap(actual, null, signal())).rejects.toMatchObject({ code: 'analysis_store_conflict' })
    await expect(outbox.compareAndSwap(prepared, { ...original, state: 'attempted' }, signal()))
      .rejects.toMatchObject({ code: 'analysis_store_conflict' })
  })

  it('rejects closed or cancelled handles and packet getters without invoking them', async () => {
    const { outbox } = await open(), original = await task(), empty = await outbox.read(signal())
    const getter = vi.fn(() => original.rawBody), bad = { ...original }
    Object.defineProperty(bad, 'rawBody', { enumerable: true, get: getter })
    await expect(outbox.compareAndSwap(empty, bad, signal())).rejects.toBeDefined()
    expect(getter).not.toHaveBeenCalled()
    const stopped = new AbortController(); stopped.abort()
    await expect(outbox.compareAndSwap(empty, original, stopped.signal)).rejects.toBeDefined()
    expect(await outbox.read(signal())).toEqual(empty)
    outbox.close(); await expect(outbox.read(signal())).rejects.toBeDefined()
  })
})
