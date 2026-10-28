/** Explicit analysis task storage, separate from the workspace authority.
 * No output snapshots or credentials are persisted. A committed attempted
 * marker never transitions back to prepared, even when the response is lost.
 */
import { ApiError, withRequestDeadline } from '@/api/request'
import { restoreOwnerAnalysisRequest } from '@/utils/ownerAnalysisContract'

const PREFIX = 'fund-compass-owner-analysis-1:'
const STORE = 'task', KEY = 'current'
const HASH = /^[0-9a-f]{64}(?![\s\S])/
export interface OwnerAnalysisTask {
  readonly state: 'prepared' | 'attempted' | 'matched'
  readonly rawBody: string
  readonly requestHash: string
  /** The complete real local workspace/locator preimage, not a server SHA. */
  readonly contextHash: string
}
export interface OwnerAnalysisTaskSlot { readonly version: number; readonly task: OwnerAnalysisTask | null }
export interface OwnerAnalysisOutbox {
  readonly targetFingerprint: string
  read(signal: AbortSignal): Promise<OwnerAnalysisTaskSlot>
  compareAndSwap(expected: OwnerAnalysisTaskSlot, task: OwnerAnalysisTask | null, signal: AbortSignal): Promise<OwnerAnalysisTaskSlot>
  close(): void
}
export class OwnerAnalysisStorageError extends ApiError {
  constructor(readonly code: 'analysis_store_invalid' | 'analysis_store_conflict' | 'analysis_store_unavailable') {
    super('本机分析任务存储不可用，请保留原请求并手动核对', 'http', 503); this.name = 'OwnerAnalysisStorageError'
  }
}
function fail(code: OwnerAnalysisStorageError['code'] = 'analysis_store_invalid'): never { throw new OwnerAnalysisStorageError(code) }
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const ds = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(ds, key))
    || Object.values(ds).some(d => !d.enumerable || !('value' in d))) fail()
  return Object.fromEntries(keys.map(key => [key, ds[key].value]))
}
function taskShape(value: unknown): OwnerAnalysisTask | null {
  if (value === null) return null
  const row = closed(value, ['state', 'rawBody', 'requestHash', 'contextHash'])
  if (!['prepared', 'attempted', 'matched'].includes(row.state as string)
    || typeof row.rawBody !== 'string' || new TextEncoder().encode(row.rawBody).byteLength > 16384
    || typeof row.requestHash !== 'string' || !HASH.test(row.requestHash)
    || typeof row.contextHash !== 'string' || !HASH.test(row.contextHash)) fail()
  return Object.freeze(row) as unknown as OwnerAnalysisTask
}
function slotShape(value: unknown, target: string): OwnerAnalysisTaskSlot {
  const row = closed(value, ['version', 'task', 'target'])
  if (row.target !== target || typeof row.version !== 'number' || !Number.isSafeInteger(row.version)
    || row.version < 0 || Object.is(row.version, -0)) fail()
  return Object.freeze({ version: row.version, task: taskShape(row.task) })
}
function same(a: OwnerAnalysisTaskSlot, b: OwnerAnalysisTaskSlot) {
  return a.version === b.version && a.task?.state === b.task?.state && a.task?.rawBody === b.task?.rawBody
    && a.task?.requestHash === b.task?.requestHash && a.task?.contextHash === b.task?.contextHash
}
function transition(before: OwnerAnalysisTask | null, next: OwnerAnalysisTask | null) {
  if (!before) { if (next?.state !== 'prepared') fail('analysis_store_conflict'); return }
  if (!next) { if (before.state === 'attempted') fail('analysis_store_conflict'); return }
  if (before.rawBody !== next.rawBody || before.requestHash !== next.requestHash || before.contextHash !== next.contextHash
    || !(before.state === 'prepared' && next.state === 'attempted' || before.state === 'attempted' && next.state === 'matched')) {
    fail('analysis_store_conflict')
  }
}
async function checkedTask(task: OwnerAnalysisTask | null) {
  if (task) await restoreOwnerAnalysisRequest(task.rawBody, task.requestHash)
}
function handle(db: IDBDatabase, target: string): OwnerAnalysisOutbox {
  let disposed = false
  const active = new Set<IDBTransaction>()
  const close = () => {
    if (disposed) return
    disposed = true
    for (const tx of active) { try { tx.abort() } catch { /* A commit can already be accepted. */ } }
    db.close()
  }
  db.onversionchange = close; db.onclose = close
  function transaction(signal: AbortSignal, ensure: () => void, write?: { expected: OwnerAnalysisTaskSlot; task: OwnerAnalysisTask | null }) {
    return new Promise<OwnerAnalysisTaskSlot>((resolve, reject) => {
      let tx: IDBTransaction | undefined, result: OwnerAnalysisTaskSlot | null = null, failure: unknown = null
      const abort = () => { failure ??= new OwnerAnalysisStorageError('analysis_store_unavailable'); try { tx?.abort() } catch { /* unknown */ } }
      const stop = () => { signal.removeEventListener('abort', abort); if (tx) active.delete(tx) }
      try {
        ensure(); if (disposed) fail('analysis_store_unavailable')
        tx = db.transaction(STORE, write ? 'readwrite' : 'readonly', write ? { durability: 'strict' } : undefined)
        active.add(tx)
        tx.onabort = () => { stop(); reject(failure ?? new OwnerAnalysisStorageError('analysis_store_unavailable')) }
        tx.onerror = () => { failure ??= new OwnerAnalysisStorageError('analysis_store_unavailable'); abort() }
        tx.oncomplete = () => {
          stop()
          try { ensure(); if (disposed || !result) fail('analysis_store_unavailable'); resolve(result) } catch (error) { reject(error) }
        }
        signal.addEventListener('abort', abort, { once: true })
        if (write && tx.durability !== 'strict') fail('analysis_store_unavailable')
        const store = tx.objectStore(STORE)
        if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail()
        const get = store.get(KEY), count = store.count()
        let got = false, counted = false
        const accept = () => {
          if (!got || !counted) return
          try {
            ensure(); if (count.result !== 1) fail()
            const current = slotShape(get.result, target)
            if (!write) { result = current; return }
            if (!same(current, write.expected) || current.version === Number.MAX_SAFE_INTEGER) fail('analysis_store_conflict')
            transition(current.task, write.task)
            const next = Object.freeze({ version: current.version + 1, task: write.task })
            const put = store.put({ ...next, target }, KEY)
            put.onsuccess = () => { try { ensure(); result = next } catch (error) { failure = error; abort() } }
          } catch (error) { failure = error; abort() }
        }
        get.onsuccess = () => { got = true; accept() }
        count.onsuccess = () => { counted = true; accept() }
      } catch (error) { failure = error; if (tx) abort(); else { stop(); reject(error) } }
    })
  }
  const read = (signal: AbortSignal) => withRequestDeadline(async (active, ensure) => {
    const row = await transaction(active, ensure); ensure(); await checkedTask(row.task); ensure(); return row
  }, signal)
  return Object.freeze({ targetFingerprint: target, close, read,
    compareAndSwap(expected: OwnerAnalysisTaskSlot, task: OwnerAnalysisTask | null, signal: AbortSignal) {
      return withRequestDeadline(async (active, ensure) => {
        const baseline = slotShape({ ...closed(expected, ['version', 'task']), target }, target), next = taskShape(task)
        await checkedTask(next); ensure()
        const current = await read(active); ensure()
        if (!same(current, baseline)) fail('analysis_store_conflict')
        transition(current.task, next)
        return transaction(active, ensure, { expected: baseline, task: next })
      }, signal)
    },
  })
}

/** Explicit opt-in only. Existing-only does not recreate a missing task DB. */
export function openOwnerAnalysisOutbox(factory: IDBFactory, target: string, signal: AbortSignal, create: boolean): Promise<OwnerAnalysisOutbox> {
  return withRequestDeadline((active, ensure) => new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest | undefined, settled = false
    const stop = () => { active.removeEventListener('abort', aborted) }
    const failed = (error: unknown) => {
      if (settled) return
      settled = true; stop()
      try { request?.transaction?.abort() } catch { /* unknown upgrade completion */ }
      reject(error instanceof OwnerAnalysisStorageError ? error : new OwnerAnalysisStorageError('analysis_store_unavailable'))
    }
    const aborted = () => failed(new OwnerAnalysisStorageError('analysis_store_unavailable'))
    try {
      ensure(); if (!HASH.test(target) || !factory || typeof factory.open !== 'function' || typeof create !== 'boolean') fail()
      active.addEventListener('abort', aborted, { once: true })
      request = factory.open(PREFIX + target, 1)
      request.onerror = () => failed(new OwnerAnalysisStorageError('analysis_store_invalid'))
      request.onblocked = () => failed(new OwnerAnalysisStorageError('analysis_store_unavailable'))
      request.onupgradeneeded = event => {
        try {
          ensure(); if (settled || !create || event.oldVersion !== 0 || request!.result.objectStoreNames.length) fail()
          request!.result.createObjectStore(STORE).put({ version: 0, task: null, target }, KEY)
        } catch (error) { failed(error) }
      }
      request.onsuccess = () => {
        const db = request!.result
        if (settled) { db.close(); return }
        try {
          ensure(); if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) fail()
          const value = handle(db, target)
          value.read(active).then(() => { try { ensure(); settled = true; stop(); resolve(value) } catch (error) { value.close(); failed(error) } },
            error => { value.close(); failed(error) })
        } catch (error) { db.close(); failed(error) }
      }
    } catch (error) { failed(error) }
  }), signal)
}
