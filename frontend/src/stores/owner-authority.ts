/** Fixed application metadata only. Never stores business rows, credentials or API configuration. */
export const OWNER_AUTHORITY_DB = 'fund-compass-owner-authority-1'
export const OWNER_AUTHORITY_SEEN_HINT = 'sinan_owner_authority_seen_v1'
const SCHEMA = 'owner-authority-1'
const STORE = 'authority', KEY = 'current', TIMEOUT = 12_000
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/

export interface OwnerAuthorityRecord {
  readonly schema: typeof SCHEMA
  readonly phase: 'legacy' | 'activating' | 'active'
  readonly epoch: number
  readonly targetFingerprint: string | null
  readonly activationId: string | null
  readonly backupSha256: string | null
}
export type OwnerAuthorityErrorCode = 'authority_unavailable' | 'authority_invalid' | 'authority_missing'
  | 'authority_conflict' | 'authority_closed' | 'authority_timeout' | 'authority_aborted'
export class OwnerAuthorityError extends Error {
  constructor(readonly code: OwnerAuthorityErrorCode) { super('Local authority unavailable'); this.name = 'OwnerAuthorityError' }
}
export interface OwnerAuthority {
  read(): Promise<OwnerAuthorityRecord>
  beginActivation(expected: OwnerAuthorityRecord, targetFingerprint: string, activationId: string, backupSha256: string): Promise<OwnerAuthorityRecord>
  completeActivation(expected: OwnerAuthorityRecord): Promise<OwnerAuthorityRecord>
  close(): void
}
const legacy = (): OwnerAuthorityRecord => Object.freeze({ schema: SCHEMA, phase: 'legacy', epoch: 0,
  targetFingerprint: null, activationId: null, backupSha256: null })
function fail(code: OwnerAuthorityErrorCode): never { throw new OwnerAuthorityError(code) }
function checked(value: unknown): OwnerAuthorityRecord {
  const keys = ['schema', 'phase', 'epoch', 'targetFingerprint', 'activationId', 'backupSha256']
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('authority_invalid')
  const row = value as Record<string, unknown>, descriptors = Object.getOwnPropertyDescriptors(value)
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length
    || !keys.every(key => Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item)) || row.schema !== SCHEMA
    || !['legacy', 'activating', 'active'].includes(row.phase as string)) fail('authority_invalid')
  if (row.phase === 'legacy') {
    if (row.epoch !== 0 || Object.is(row.epoch, -0) || row.targetFingerprint !== null || row.activationId !== null || row.backupSha256 !== null) fail('authority_invalid')
  } else if (row.epoch !== (row.phase === 'activating' ? 1 : 2)
    || typeof row.targetFingerprint !== 'string' || !HASH.test(row.targetFingerprint)
    || typeof row.activationId !== 'string' || !ID.test(row.activationId)
    || typeof row.backupSha256 !== 'string' || !HASH.test(row.backupSha256)) fail('authority_invalid')
  return Object.freeze({ schema: SCHEMA, phase: row.phase as OwnerAuthorityRecord['phase'], epoch: row.epoch as number,
    targetFingerprint: row.targetFingerprint as string | null, activationId: row.activationId as string | null,
    backupSha256: row.backupSha256 as string | null })
}
function same(a: OwnerAuthorityRecord, b: OwnerAuthorityRecord): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function structure(db: IDBDatabase): boolean {
  if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) return false
  const store = db.transaction(STORE).objectStore(STORE)
  return store.keyPath === null && !store.autoIncrement && store.indexNames.length === 0
}

/** The optional LS marker detects observed locator deletion; it never selects authority or a target. */
export function openOwnerAuthority(factory: IDBFactory, hint: Storage | null): Promise<OwnerAuthority> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | null = null, settled = false, upgraded = false
    let reason: OwnerAuthorityErrorCode = 'authority_unavailable'
    const finish = (code: OwnerAuthorityErrorCode) => {
      if (settled) return
      settled = true; clearTimeout(timer); db?.close(); reject(new OwnerAuthorityError(code))
    }
    const timer = setTimeout(() => finish('authority_timeout'), TIMEOUT)
    if (!factory || typeof factory.open !== 'function') { finish('authority_unavailable'); return }
    let request: IDBOpenDBRequest
    try { request = factory.open(OWNER_AUTHORITY_DB, 1) } catch { finish('authority_unavailable'); return }
    request.onblocked = () => finish('authority_unavailable')
    request.onerror = () => finish(reason)
    request.onupgradeneeded = event => {
      try {
        if (settled) { request.transaction?.abort(); return }
        if (event.oldVersion !== 0) { reason = 'authority_invalid'; request.transaction?.abort(); return }
        // Without a readable marker, a newly created locator cannot safely be
        // distinguished from loss of the previously selected database.
        if (!hint) { reason = 'authority_unavailable'; request.transaction?.abort(); return }
        if (hint.getItem(OWNER_AUTHORITY_SEEN_HINT) !== null) { reason = 'authority_missing'; request.transaction?.abort(); return }
        request.result.createObjectStore(STORE).put(legacy(), KEY)
        upgraded = true
      } catch { reason = 'authority_unavailable'; request.transaction?.abort() }
    }
    request.onsuccess = () => {
      db = request.result
      if (settled) { db.close(); return }
      try {
        if (!structure(db)) { finish('authority_invalid'); return }
        let closed = false
        const inFlight = new Set<(code: OwnerAuthorityErrorCode) => void>()
        const close = () => { if (closed) return; closed = true; inFlight.forEach(stop => stop('authority_closed')); db!.close() }
        db.onversionchange = close
        const transact = (expected?: OwnerAuthorityRecord, replacement?: OwnerAuthorityRecord): Promise<OwnerAuthorityRecord> => new Promise((done, bad) => {
          if (closed) { bad(new OwnerAuthorityError('authority_closed')); return }
          let tx: IDBTransaction | null = null, output: OwnerAuthorityRecord | null = null, ended = false
          let failure: OwnerAuthorityErrorCode = 'authority_aborted'
          const stop = (code: OwnerAuthorityErrorCode) => {
            if (ended) return
            ended = true; clearTimeout(deadline); inFlight.delete(stop)
            try { tx?.abort() } catch { /* a completed transaction stays committed */ }
            bad(new OwnerAuthorityError(code))
          }
          const deadline = setTimeout(() => stop('authority_timeout'), TIMEOUT)
          inFlight.add(stop)
          try {
            tx = expected ? db!.transaction(STORE, 'readwrite', { durability: 'strict' }) : db!.transaction(STORE, 'readonly')
            if (expected && tx.durability !== 'strict') { stop('authority_unavailable'); return }
            const store = tx.objectStore(STORE), read = store.get(KEY), count = store.count()
            let remaining = 2
            const ready = () => {
              if (--remaining !== 0 || ended) return
              try {
                if (count.result !== 1) fail('authority_invalid')
                output = checked(read.result)
                if (expected) {
                  if (!same(output, checked(expected))) fail('authority_conflict')
                  output = checked(replacement); store.put(output, KEY)
                }
              } catch (cause) { failure = cause instanceof OwnerAuthorityError ? cause.code : 'authority_invalid'; tx!.abort() }
            }
            read.onsuccess = ready; count.onsuccess = ready
            tx.onabort = () => stop(failure)
            tx.onerror = () => { /* onabort owns the definitive failure */ }
            tx.oncomplete = () => {
              if (ended) return
              ended = true; clearTimeout(deadline); inFlight.delete(stop)
              if (!output) { bad(new OwnerAuthorityError('authority_invalid')); return }
              done(output)
            }
          } catch { stop('authority_unavailable') }
        })
        const handle: OwnerAuthority = Object.freeze({ read: () => transact(),
          beginActivation(expected: OwnerAuthorityRecord, targetFingerprint: string, activationId: string, backupSha256: string) {
            try {
              if (checked(expected).phase !== 'legacy') fail('authority_conflict')
              // A selected authority must have a persisted deletion detector.
              // Existing active IDB remains readable when LS is denied, but a
              // new selection cannot proceed if this non-authority hint fails.
              if (!hint) fail('authority_unavailable')
              try {
                hint.setItem(OWNER_AUTHORITY_SEEN_HINT, '1')
                if (hint.getItem(OWNER_AUTHORITY_SEEN_HINT) !== '1') fail('authority_unavailable')
              } catch { fail('authority_unavailable') }
              return transact(expected, checked({ schema: SCHEMA, phase: 'activating', epoch: 1, targetFingerprint, activationId, backupSha256 }))
            } catch (error) { return Promise.reject(error) }
          },
          completeActivation(expected: OwnerAuthorityRecord) {
            try {
              if (checked(expected).phase !== 'activating') fail('authority_conflict')
              return transact(expected, checked({ ...expected, phase: 'active', epoch: 2 }))
            } catch (error) { return Promise.reject(error) }
          }, close })
        handle.read().then(() => {
          if (settled) { close(); return }
          // This hint has no target or authority. Failure is safe: the existing
          // locator is always checked first, and no business data has migrated.
          try { hint?.setItem(OWNER_AUTHORITY_SEEN_HINT, '1') } catch { if (upgraded) { close(); finish('authority_unavailable'); return } }
          settled = true; clearTimeout(timer); resolve(handle)
        }, () => { close(); finish('authority_invalid') })
      } catch { finish('authority_invalid') }
    }
  })
}
