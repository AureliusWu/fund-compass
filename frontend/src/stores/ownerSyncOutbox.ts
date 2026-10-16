/** Explicitly injected candidate storage; no global IDB, app, or network use. */
import { restoreOwnerSyncRequest, type BuiltOwnerSyncRequest } from '@/utils/ownerSyncContract'

export const OWNER_SYNC_OUTBOX_SCHEMA = 'owner-sync-outbox-1' as const
export const OWNER_SYNC_OUTBOX_TIMEOUT_MS = 12_000
export const OWNER_SYNC_OUTBOX_DB_PREFIX = 'fund-compass-owner-sync-outbox-1:'
const STORE = 'slot'
const KEY = 'current'
const HEX = /^[0-9a-f]{64}$/
const STATES = new Set(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'])

export type OwnerSyncOutboxState = 'prepared' | 'attempted' | 'unknown' | 'confirmed' | 'conflict'
export interface OwnerSyncOutboxEntry {
  readonly schema: typeof OWNER_SYNC_OUTBOX_SCHEMA
  readonly state: OwnerSyncOutboxState
  readonly rawBody: string
  readonly requestHash: string
}
export interface OwnerSyncOutboxSnapshot {
  readonly version: number
  readonly entry: OwnerSyncOutboxEntry | null
}
export interface OwnerSyncOutbox {
  readonly targetFingerprint: string
  read(): Promise<OwnerSyncOutboxSnapshot>
  compareAndSwap(expectedVersion: number, nextEntry: OwnerSyncOutboxEntry | null): Promise<OwnerSyncOutboxSnapshot>
  close(): void
}
export type OwnerSyncOutboxErrorCode = 'outbox_invalid_target' | 'outbox_invalid_entry' | 'outbox_invalid_database'
  | 'outbox_conflict' | 'outbox_invalid_transition' | 'outbox_version_exhausted' | 'outbox_blocked'
  | 'outbox_timeout' | 'outbox_unavailable' | 'outbox_quota' | 'outbox_aborted' | 'outbox_closed'
export class OwnerSyncOutboxError extends Error {
  constructor(readonly code: OwnerSyncOutboxErrorCode) {
    super('Owner sync outbox operation rejected')
    this.name = 'OwnerSyncOutboxError'
  }
}

interface Row extends OwnerSyncOutboxSnapshot { readonly resourceFingerprint: string }
function fail(code: OwnerSyncOutboxErrorCode): never { throw new OwnerSyncOutboxError(code) }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function entryShape(value: unknown, code: OwnerSyncOutboxErrorCode): OwnerSyncOutboxEntry | null {
  if (value === null) return null
  if (!exact(value, ['schema', 'state', 'rawBody', 'requestHash']) || value.schema !== OWNER_SYNC_OUTBOX_SCHEMA
      || typeof value.state !== 'string' || !STATES.has(value.state) || typeof value.rawBody !== 'string'
      || value.rawBody.length > 131_072 || typeof value.requestHash !== 'string' || !HEX.test(value.requestHash)) fail(code)
  return Object.freeze({ schema: OWNER_SYNC_OUTBOX_SCHEMA, state: value.state as OwnerSyncOutboxState,
    rawBody: value.rawBody, requestHash: value.requestHash })
}
function rowShape(value: unknown, target: string): Row {
  if (!exact(value, ['version', 'entry', 'resourceFingerprint']) || typeof value.version !== 'number'
      || !Number.isSafeInteger(value.version) || value.version < 0 || value.resourceFingerprint !== target) fail('outbox_invalid_database')
  return Object.freeze({ version: value.version, entry: entryShape(value.entry, 'outbox_invalid_database'), resourceFingerprint: target })
}
function snapshot(row: Row): OwnerSyncOutboxSnapshot { return Object.freeze({ version: row.version, entry: row.entry }) }
async function validateEntry(value: unknown, code: OwnerSyncOutboxErrorCode): Promise<OwnerSyncOutboxEntry | null> {
  const entry = entryShape(value, code)
  if (entry) {
    try {
      const restored: BuiltOwnerSyncRequest = await restoreOwnerSyncRequest(entry.rawBody, entry.requestHash)
      if (restored.rawBody !== entry.rawBody || restored.requestHash !== entry.requestHash) fail(code)
    } catch { fail(code) }
  }
  return entry
}
function transition(current: OwnerSyncOutboxEntry | null, next: OwnerSyncOutboxEntry | null): void {
  if (current === null) {
    if (next?.state !== 'prepared') fail('outbox_invalid_transition')
    return
  }
  if (next === null) {
    if (!['prepared', 'confirmed', 'conflict'].includes(current.state)) fail('outbox_invalid_transition')
    return
  }
  if (current.rawBody !== next.rawBody || current.requestHash !== next.requestHash) fail('outbox_invalid_transition')
  const permitted: Record<OwnerSyncOutboxState, readonly OwnerSyncOutboxState[]> = {
    prepared: ['attempted'], attempted: ['unknown', 'confirmed', 'conflict'],
    unknown: ['attempted', 'confirmed', 'conflict'], confirmed: [], conflict: [],
  }
  if (!permitted[current.state].includes(next.state)) fail('outbox_invalid_transition')
}
function storageCode(error: unknown, fallback: OwnerSyncOutboxErrorCode = 'outbox_unavailable'): OwnerSyncOutboxErrorCode {
  try { if ((error as { name?: string } | null)?.name === 'QuotaExceededError') return 'outbox_quota' } catch { /* fixed fallback */ }
  return fallback
}
function sameRow(first: Row, second: Row): boolean {
  return first.version === second.version && first.resourceFingerprint === second.resourceFingerprint
    && first.entry?.state === second.entry?.state && first.entry?.rawBody === second.entry?.rawBody
    && first.entry?.requestHash === second.entry?.requestHash
}

function makeHandle(db: IDBDatabase, target: string): OwnerSyncOutbox {
  let closed = false
  const inFlight = new Set<(code: OwnerSyncOutboxErrorCode) => void>()
  const ensureOpen = () => { if (closed) fail('outbox_closed') }
  const close = () => {
    if (closed) return
    closed = true
    for (const cancel of [...inFlight]) cancel('outbox_closed')
    try { db.close() } catch { /* disposal never exposes a driver error */ }
  }
  db.onversionchange = close
  db.onclose = close

  function bounded<T>(work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (code?: OwnerSyncOutboxErrorCode, result?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        inFlight.delete(cancel)
        if (code) reject(new OwnerSyncOutboxError(code))
        else resolve(result!)
      }
      const cancel = (code: OwnerSyncOutboxErrorCode) => {
        finish(code)
        // Closing on a deadline prevents late hash validation from starting
        // a write after its caller has already received a timeout.
        if (code === 'outbox_timeout') close()
      }
      try {
        ensureOpen()
        inFlight.add(cancel)
        timer = setTimeout(() => cancel('outbox_timeout'), OWNER_SYNC_OUTBOX_TIMEOUT_MS)
        work().then(result => finish(closed ? 'outbox_closed' : undefined, result),
          error => finish(error instanceof OwnerSyncOutboxError ? error.code : storageCode(error)))
      } catch (error) { finish(error instanceof OwnerSyncOutboxError ? error.code : storageCode(error)) }
    })
  }

  function transaction<T>(mode: IDBTransactionMode, perform: (store: IDBObjectStore, result: (value: T) => void,
    cancel: (code: OwnerSyncOutboxErrorCode) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction
      let settled = false, ready = false
      let value: T
      let failure: OwnerSyncOutboxErrorCode | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (code?: OwnerSyncOutboxErrorCode) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        inFlight.delete(cancel)
        if (code) reject(new OwnerSyncOutboxError(code))
        else resolve(value!)
      }
      const cancel = (code: OwnerSyncOutboxErrorCode) => {
        failure ??= code
        try { tx?.abort() } catch { /* completed/aborted transactions cannot be cancelled again */ }
        finish(failure)
      }
      try {
        ensureOpen()
        tx = db.transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
        // A platform/adapter can ignore the requested option. Do not issue
        // even a get on a write transaction unless its actual guarantee is
        // observable and strict; missing/throwing properties fail closed too.
        if (mode === 'readwrite' && tx.durability !== 'strict') fail('outbox_unavailable')
        const store = tx.objectStore(STORE)
        if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) fail('outbox_invalid_database')
        inFlight.add(cancel)
        timer = setTimeout(() => cancel('outbox_timeout'), OWNER_SYNC_OUTBOX_TIMEOUT_MS)
        tx.oncomplete = () => finish(closed ? 'outbox_closed' : failure ?? (!ready ? 'outbox_invalid_database' : undefined))
        tx.onabort = () => finish(failure ?? storageCode(tx.error, 'outbox_aborted'))
        tx.onerror = () => cancel(storageCode(tx.error))
        perform(store, next => { value = next; ready = true }, cancel)
      } catch (error) {
        cancel(error instanceof OwnerSyncOutboxError ? error.code : storageCode(error))
      }
    })
  }

  function storedRow(mode: IDBTransactionMode, write?: { baseline: Row, expected: number, next: OwnerSyncOutboxEntry | null }): Promise<Row> {
    return transaction(mode, (store, result, cancel) => {
      const get = store.get(KEY), count = store.count()
      let got = false, counted = false
      const accept = () => {
        if (!got || !counted) return
        try {
          if (count.result !== 1) fail('outbox_invalid_database')
          const row = rowShape(get.result, target)
          if (!write) { result(row); return }
          if (row.version !== write.expected) fail('outbox_conflict')
          if (!sameRow(row, write.baseline)) fail('outbox_invalid_database')
          if (row.version === Number.MAX_SAFE_INTEGER) fail('outbox_version_exhausted')
          transition(row.entry, write.next)
          const next = Object.freeze({ version: row.version + 1, entry: write.next, resourceFingerprint: target })
          const put = store.put(next, KEY)
          put.onsuccess = () => result(next)
        } catch (error) { cancel(error instanceof OwnerSyncOutboxError ? error.code : storageCode(error)) }
      }
      get.onsuccess = () => { got = true; accept() }
      count.onsuccess = () => { counted = true; accept() }
    })
  }

  return Object.freeze({
    targetFingerprint: target,
    read() { return bounded(async () => {
      const row = await storedRow('readonly')
      await validateEntry(row.entry, 'outbox_invalid_database')
      ensureOpen()
      return snapshot(row)
    }) },
    compareAndSwap(expectedVersion: number, nextEntry: OwnerSyncOutboxEntry | null) { return bounded(async () => {
      ensureOpen()
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('outbox_conflict')
      const next = await validateEntry(nextEntry, 'outbox_invalid_entry')
      ensureOpen()
      const row = await storedRow('readonly')
      await validateEntry(row.entry, 'outbox_invalid_database')
      ensureOpen()
      if (row.version !== expectedVersion) fail('outbox_conflict')
      transition(row.entry, next)
      const committed = await storedRow('readwrite', { baseline: row, expected: expectedVersion, next })
      ensureOpen()
      return snapshot(committed)
    }) },
    close,
  })
}

export function openOwnerSyncOutbox(factory: IDBFactory, targetFingerprint: string): Promise<OwnerSyncOutbox> {
  return new Promise((resolve, reject) => {
    let settled = false
    let handle: OwnerSyncOutbox | undefined
    let opened: IDBDatabase | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (code?: OwnerSyncOutboxErrorCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code) {
        handle?.close()
        try { opened?.close() } catch { /* fixed rejection still wins */ }
        reject(new OwnerSyncOutboxError(code))
      } else resolve(handle!)
    }
    try {
      if (typeof targetFingerprint !== 'string' || !HEX.test(targetFingerprint)) fail('outbox_invalid_target')
      if (!factory || typeof factory.open !== 'function') fail('outbox_unavailable')
      const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + targetFingerprint, 1)
      timer = setTimeout(() => finish('outbox_timeout'), OWNER_SYNC_OUTBOX_TIMEOUT_MS)
      request.onblocked = () => finish('outbox_blocked')
      request.onerror = () => finish(storageCode(request.error, 'outbox_invalid_database'))
      request.onupgradeneeded = event => {
        const db = request.result
        if (settled || event.oldVersion !== 0 || db.objectStoreNames.length !== 0) {
          request.transaction?.abort()
          if (!settled) finish('outbox_invalid_database')
          return
        }
        try {
          const store = db.createObjectStore(STORE)
          store.put({ version: 0, entry: null, resourceFingerprint: targetFingerprint }, KEY)
        } catch (error) {
          request.transaction?.abort()
          finish(storageCode(error))
        }
      }
      request.onsuccess = () => {
        const db = request.result
        if (settled) { try { db.close() } catch { /* late connection stays unusable */ }; return }
        opened = db
        if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) {
          finish('outbox_invalid_database')
          return
        }
        handle = makeHandle(db, targetFingerprint)
        handle.read().then(() => finish(), error => finish(error instanceof OwnerSyncOutboxError ? error.code : 'outbox_invalid_database'))
      }
    } catch (error) { finish(error instanceof OwnerSyncOutboxError ? error.code : storageCode(error)) }
  })
}
