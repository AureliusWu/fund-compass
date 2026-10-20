/** Explicit candidate IDB authority only. No app, LS, Gist, session or network wiring. */
import {
  canonicalOwnerCloudImportPlan, canonicalOwnerWorkspaceEntries,
  validateOwnerCloudImportPlan, validateOwnerWorkspaceEntries, validateOwnerWorkspaceLegacy, validateOwnerWorkspaceSnapshot,
  OwnerCloudImportError,
  type OwnerCloudImportPlan, type OwnerWorkspaceEntry, type OwnerWorkspaceLegacy, type OwnerWorkspaceSnapshot,
} from '@/utils/owner-cloud-import'
import {
  openOwnerSyncOutbox, ownerSyncOutboxStorage, isOwnerSyncOutboxDatabase,
  OWNER_SYNC_OUTBOX_DB_PREFIX, OWNER_SYNC_OUTBOX_TIMEOUT_MS, OwnerSyncOutboxError,
} from './ownerSyncOutbox'

export type { OwnerWorkspaceEntry, OwnerWorkspaceLegacy, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
const WORKING = 'working_copy', RECEIPTS = 'import_receipts', CURRENT = 'current'
const STORES = ['slot', WORKING, RECEIPTS]
const SCHEMA = 'owner-workspace-1'
const RECEIPT_SCHEMA = 'owner-workspace-receipt-1'
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const MAX_RECEIPTS = 200

export interface OwnerWorkspaceGuard {
  readonly signal: AbortSignal
  /** Must bind current consent, generation, full baseline and legacy raw source, as applicable. */
  assertActive(): void
}
export type OwnerWorkspaceErrorCode = 'workspace_invalid_target' | 'workspace_invalid_database' | 'workspace_invalid_input'
  | 'workspace_conflict' | 'workspace_pending' | 'workspace_idempotency_conflict' | 'workspace_capacity'
  | 'workspace_version_exhausted' | 'workspace_blocked' | 'workspace_timeout' | 'workspace_unavailable'
  | 'workspace_quota' | 'workspace_aborted' | 'workspace_closed' | 'workspace_context_changed' | 'workspace_noop'
export class OwnerWorkspaceError extends Error {
  constructor(readonly code: OwnerWorkspaceErrorCode) {
    super('Owner workspace operation rejected')
    this.name = 'OwnerWorkspaceError'
  }
}
export interface OwnerWorkspaceImportRequest {
  readonly id: string
  readonly hash: string
  readonly plan: OwnerCloudImportPlan
  readonly expectedLocalVersion: number
  readonly expectedOutboxVersion: number
}
export interface OwnerWorkspaceRollbackRequest {
  readonly id: string
  readonly hash: string
  readonly importId: string
  readonly importHash: string
  readonly expectedSnapshot: OwnerWorkspaceSnapshot
  readonly expectedOutboxVersion: number
}
export interface OwnerWorkspaceReceipt {
  readonly id: string
  readonly hash: string
  readonly operation: 'import' | 'rollback'
  readonly beforeLocalVersion: number
  readonly localVersion: number
  readonly outboxVersion: number
  readonly preimageHash: string
  readonly postimageHash: string
  readonly rollbackOf: string | null
  readonly rawReceipt: string
}
export interface OwnerWorkspace {
  readonly targetFingerprint: string
  read(guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSnapshot>
  /** Trusted-caller seed only: this primitive neither reads LS nor proves raw->entries business mapping. */
  adoptLegacy(seed: { sourceKey: OwnerWorkspaceLegacy['sourceKey']; raw: string | null; entries: readonly OwnerWorkspaceEntry[] },
    expectedLocalVersion: number, expectedOutboxVersion: number, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSnapshot>
  importCloud(request: OwnerWorkspaceImportRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceReceipt>
  rollbackImport(request: OwnerWorkspaceRollbackRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceReceipt>
  /** Missing receipt is unknown, never automatic retry, compensation or proof of rollback. */
  receipt(id: string, hash: string, guard: OwnerWorkspaceGuard): Promise<Readonly<{ state: 'unknown' }>
    | Readonly<{ state: 'matched'; receipt: OwnerWorkspaceReceipt }>>
  close(): void
}
interface WorkingRow { schema: typeof SCHEMA; targetFingerprint: string; snapshot: OwnerWorkspaceSnapshot }
interface StoredReceipt {
  schema: typeof RECEIPT_SCHEMA
  targetFingerprint: string
  receipt: OwnerWorkspaceReceipt
  before: OwnerWorkspaceSnapshot
  after: OwnerWorkspaceSnapshot
}
type SlotRow = ReturnType<typeof ownerSyncOutboxStorage.rowShape>
interface Image { slot: SlotRow; working: WorkingRow; receipt: StoredReceipt | null; original: StoredReceipt | null; receiptCount: number }
function fail(code: OwnerWorkspaceErrorCode): never { throw new OwnerWorkspaceError(code) }
function code(error: unknown, fallback: OwnerWorkspaceErrorCode = 'workspace_unavailable'): OwnerWorkspaceErrorCode {
  if (error instanceof OwnerWorkspaceError) return error.code
  if (error instanceof OwnerCloudImportError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerSyncOutboxError) return error.code === 'outbox_blocked' ? 'workspace_blocked'
    : error.code === 'outbox_invalid_target' ? 'workspace_invalid_target' : 'workspace_invalid_database'
  try { if ((error as { name?: string } | null)?.name === 'QuotaExceededError') return 'workspace_quota' } catch { /* fixed code */ }
  return fallback
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(descriptors, key))
    && Object.values(descriptors).every(item => item.enumerable && 'value' in item)
}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail('workspace_invalid_input')
  return value
}
function increment(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) fail('workspace_version_exhausted')
  return value + 1
}
function canonical(value: unknown): string {
  if (typeof value === 'number' && Object.is(value, -0)) return '-0'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function legacy(value: unknown): OwnerWorkspaceLegacy | null {
  try { return validateOwnerWorkspaceLegacy(value) } catch (error) { fail(code(error)) }
}
function snapshot(value: unknown): OwnerWorkspaceSnapshot {
  try { return validateOwnerWorkspaceSnapshot(value) } catch (error) { fail(code(error)) }
}
function working(value: unknown, target: string): WorkingRow {
  try {
    if (!closed(value, ['schema', 'targetFingerprint', 'snapshot']) || value.schema !== SCHEMA || value.targetFingerprint !== target) fail('workspace_invalid_database')
    return Object.freeze({ schema: SCHEMA, targetFingerprint: target, snapshot: snapshot(value.snapshot) })
  } catch { fail('workspace_invalid_database') }
}
function receiptBody(value: Omit<OwnerWorkspaceReceipt, 'rawReceipt'>): string { return canonical(value) }
function storedReceipt(value: unknown, target: string): StoredReceipt {
  try {
    if (!closed(value, ['schema', 'targetFingerprint', 'receipt', 'before', 'after'])
        || value.schema !== RECEIPT_SCHEMA || value.targetFingerprint !== target) fail('workspace_invalid_database')
    const row = value.receipt
    if (!closed(row, ['id', 'hash', 'operation', 'beforeLocalVersion', 'localVersion', 'outboxVersion', 'preimageHash', 'postimageHash', 'rollbackOf', 'rawReceipt'])
        || typeof row.id !== 'string' || !ID.test(row.id) || typeof row.hash !== 'string' || !HASH.test(row.hash)
        || !['import', 'rollback'].includes(row.operation as string)
        || typeof row.preimageHash !== 'string' || !HASH.test(row.preimageHash)
        || typeof row.postimageHash !== 'string' || !HASH.test(row.postimageHash)
        || typeof row.rawReceipt !== 'string' || row.rawReceipt.length > 4096
        || (row.operation === 'import' ? row.rollbackOf !== null : typeof row.rollbackOf !== 'string' || !ID.test(row.rollbackOf))) fail('workspace_invalid_database')
    const before = snapshot(value.before), after = snapshot(value.after)
    const body = { id: row.id, hash: row.hash, operation: row.operation as 'import' | 'rollback',
      beforeLocalVersion: counter(row.beforeLocalVersion), localVersion: counter(row.localVersion), outboxVersion: counter(row.outboxVersion),
      preimageHash: row.preimageHash, postimageHash: row.postimageHash, rollbackOf: row.rollbackOf as string | null }
    if (before.localVersion !== body.beforeLocalVersion || after.localVersion !== body.localVersion
        || before.localVersion === Number.MAX_SAFE_INTEGER || after.localVersion !== before.localVersion + 1
        || canonical(before.legacy) !== canonical(after.legacy) || receiptBody(body) !== row.rawReceipt) fail('workspace_invalid_database')
    return Object.freeze({ schema: RECEIPT_SCHEMA, targetFingerprint: target,
      receipt: Object.freeze({ ...body, rawReceipt: row.rawReceipt }), before, after })
  } catch { fail('workspace_invalid_database') }
}
async function digest(raw: string): Promise<string> {
  try {
    const result = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
    return [...new Uint8Array(result)].map(item => item.toString(16).padStart(2, '0')).join('')
  } catch { fail('workspace_unavailable') }
}
async function verifyReceipt(value: StoredReceipt): Promise<void> {
  if (await digest(canonical(value.before)) !== value.receipt.preimageHash
      || await digest(canonical(value.after)) !== value.receipt.postimageHash) fail('workspace_invalid_database')
}
function assertGuard(guard: OwnerWorkspaceGuard): void {
  try {
    if (!guard || !guard.signal || typeof guard.signal.aborted !== 'boolean' || guard.signal.aborted
        || typeof guard.signal.addEventListener !== 'function' || typeof guard.signal.removeEventListener !== 'function'
        || typeof guard.assertActive !== 'function') fail('workspace_context_changed')
    guard.assertActive()
    if (guard.signal.aborted) fail('workspace_context_changed')
  } catch { fail('workspace_context_changed') }
}
function importEnvelope(target: string, request: Omit<OwnerWorkspaceImportRequest, 'hash'>): string {
  if (typeof request.id !== 'string' || !ID.test(request.id)) fail('workspace_invalid_input')
  const plan = validateOwnerCloudImportPlan(request.plan, target)
  return canonical({ schema: 'owner-workspace-import-request-1', targetFingerprint: target, id: request.id,
    plan: JSON.parse(canonicalOwnerCloudImportPlan(plan)), expectedLocalVersion: counter(request.expectedLocalVersion),
    expectedOutboxVersion: counter(request.expectedOutboxVersion) })
}
export async function buildOwnerWorkspaceImportRequest(target: string, input: Omit<OwnerWorkspaceImportRequest, 'hash'>): Promise<OwnerWorkspaceImportRequest> {
  if (typeof target !== 'string' || !HASH.test(target)) fail('workspace_invalid_target')
  if (!closed(input, ['id', 'plan', 'expectedLocalVersion', 'expectedOutboxVersion'])) fail('workspace_invalid_input')
  const plan = validateOwnerCloudImportPlan(input.plan, target)
  const body = importEnvelope(target, { ...input, plan })
  return Object.freeze({ id: input.id, hash: await digest(body), plan,
    expectedLocalVersion: input.expectedLocalVersion, expectedOutboxVersion: input.expectedOutboxVersion })
}
function rollbackEnvelope(target: string, request: Omit<OwnerWorkspaceRollbackRequest, 'hash'>): string {
  if (typeof request.id !== 'string' || !ID.test(request.id) || typeof request.importId !== 'string' || !ID.test(request.importId)
      || typeof request.importHash !== 'string' || !HASH.test(request.importHash) || request.id === request.importId) fail('workspace_invalid_input')
  return canonical({ schema: 'owner-workspace-rollback-request-1', targetFingerprint: target, id: request.id,
    importId: request.importId, importHash: request.importHash, expectedSnapshot: snapshot(request.expectedSnapshot),
    expectedOutboxVersion: counter(request.expectedOutboxVersion) })
}
export async function buildOwnerWorkspaceRollbackRequest(target: string, input: Omit<OwnerWorkspaceRollbackRequest, 'hash'>): Promise<OwnerWorkspaceRollbackRequest> {
  if (typeof target !== 'string' || !HASH.test(target)) fail('workspace_invalid_target')
  if (!closed(input, ['id', 'importId', 'importHash', 'expectedSnapshot', 'expectedOutboxVersion'])) fail('workspace_invalid_input')
  const copy = { ...input, expectedSnapshot: snapshot(input.expectedSnapshot) }
  return Object.freeze({ ...copy, hash: await digest(rollbackEnvelope(target, copy)) })
}

function makeWorkspace(db: IDBDatabase, target: string): OwnerWorkspace {
  let closedHandle = false
  const inFlight = new Set<(value: OwnerWorkspaceErrorCode) => void>()
  let observedLocal: OwnerWorkspaceSnapshot | null = null, observedSlot: SlotRow | null = null
  const ensureOpen = () => { if (closedHandle) fail('workspace_closed') }
  const close = () => {
    if (closedHandle) return
    closedHandle = true
    observedLocal = null; observedSlot = null
    for (const cancel of [...inFlight]) cancel('workspace_closed')
    try { db.close() } catch { /* disposal has no driver details */ }
  }
  db.onversionchange = close
  db.onclose = close
  function observe(image: Image): void {
    const next = image.working.snapshot
    if (observedLocal && (next.localVersion < observedLocal.localVersion
        || (next.localVersion === observedLocal.localVersion && canonical(next) !== canonical(observedLocal)))) fail('workspace_invalid_database')
    if (observedSlot && (image.slot.version < observedSlot.version
        || (image.slot.version === observedSlot.version && !ownerSyncOutboxStorage.sameRow(image.slot, observedSlot)))) fail('workspace_invalid_database')
    observedLocal = next; observedSlot = image.slot
  }
  function bounded<T>(guard: OwnerWorkspaceGuard, work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false, listening = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (problem?: OwnerWorkspaceErrorCode, result?: T) => {
        if (settled) return
        settled = true; clearTimeout(timer); inFlight.delete(cancel)
        if (listening) guard.signal.removeEventListener('abort', revoked)
        if (problem) reject(new OwnerWorkspaceError(problem)); else resolve(result!)
      }
      const cancel = (problem: OwnerWorkspaceErrorCode) => finish(problem)
      const revoked = () => { cancel('workspace_context_changed'); close() }
      try {
        ensureOpen(); assertGuard(guard)
        inFlight.add(cancel); guard.signal.addEventListener('abort', revoked, { once: true }); listening = true
        timer = setTimeout(() => { cancel('workspace_timeout'); close() }, OWNER_SYNC_OUTBOX_TIMEOUT_MS)
        work().then(result => {
          try { ensureOpen(); assertGuard(guard); finish(undefined, result) } catch (error) { finish(code(error)) }
        }, error => finish(code(error)))
      } catch (error) { finish(code(error)) }
    })
  }
  function transaction<T>(mode: IDBTransactionMode, guard: OwnerWorkspaceGuard,
    perform: (stores: Record<string, IDBObjectStore>, ready: (value: T) => void, cancel: (problem: OwnerWorkspaceErrorCode) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction | undefined, settled = false, ready = false, listening = false
      let value: T
      let failure: OwnerWorkspaceErrorCode | undefined
      const finish = (problem?: OwnerWorkspaceErrorCode) => {
        if (settled) return
        settled = true; inFlight.delete(cancel); if (listening) guard.signal.removeEventListener('abort', revoked)
        if (problem) reject(new OwnerWorkspaceError(problem)); else resolve(value!)
      }
      const cancel = (problem: OwnerWorkspaceErrorCode) => {
        failure ??= problem
        try { tx?.abort() } catch { /* committed results are not undone or retried */ }
        finish(failure)
      }
      const revoked = () => cancel('workspace_context_changed')
      try {
        ensureOpen(); assertGuard(guard)
        tx = db.transaction(STORES, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
        if (mode === 'readwrite' && tx.durability !== 'strict') fail('workspace_unavailable')
        const stores = Object.fromEntries(STORES.map(name => {
          const store = tx!.objectStore(name)
          if (store.keyPath !== null || store.autoIncrement || store.indexNames.length !== 0) fail('workspace_invalid_database')
          return [name, store]
        }))
        inFlight.add(cancel); guard.signal.addEventListener('abort', revoked, { once: true }); listening = true
        tx.oncomplete = () => {
          try { ensureOpen(); assertGuard(guard); finish(failure ?? (!ready ? 'workspace_invalid_database' : undefined)) }
          catch (error) { finish(code(error)) }
        }
        tx.onabort = () => finish(failure ?? code(tx?.error, 'workspace_aborted'))
        // Requests still queued when abort() runs can dispatch error before
        // onabort, while tx.error is still null. This handler itself aborts;
        // do not mislabel that real rollback as an availability failure.
        tx.onerror = () => cancel(code(tx?.error, 'workspace_aborted'))
        perform(stores, result => { value = result; ready = true }, cancel)
      } catch (error) { cancel(code(error)) }
    })
  }
  function image(mode: IDBTransactionMode, guard: OwnerWorkspaceGuard, id?: string, originalId?: string,
    mutate?: (current: Image, stores: Record<string, IDBObjectStore>) => Image): Promise<Image> {
    return transaction(mode, guard, (stores, ready, cancel) => {
      const requests: Record<string, IDBRequest> = {
        slot: stores.slot.get(CURRENT), slots: stores.slot.count(), working: stores[WORKING].get(CURRENT),
        workings: stores[WORKING].count(), receipts: stores[RECEIPTS].count(),
        ...(id ? { receipt: stores[RECEIPTS].get(id) } : {}),
        ...(originalId ? { original: stores[RECEIPTS].get(originalId) } : {}),
      }
      let remaining = Object.keys(requests).length
      for (const request of Object.values(requests)) request.onsuccess = () => {
        if (--remaining !== 0) return
        try {
          ensureOpen(); assertGuard(guard)
          if (requests.slots.result !== 1 || requests.workings.result !== 1
              || typeof requests.receipts.result !== 'number' || !Number.isSafeInteger(requests.receipts.result)
              || requests.receipts.result < 0 || requests.receipts.result > MAX_RECEIPTS) fail('workspace_invalid_database')
          let current: Image = { slot: ownerSyncOutboxStorage.rowShape(requests.slot.result, target), working: working(requests.working.result, target),
            receipt: id && requests.receipt.result !== undefined ? storedReceipt(requests.receipt.result, target) : null,
            original: originalId && requests.original.result !== undefined ? storedReceipt(requests.original.result, target) : null,
            receiptCount: requests.receipts.result }
          observe(current)
          if (current.receipt && current.receipt.receipt.id !== id) fail('workspace_invalid_database')
          if (current.original && current.original.receipt.id !== originalId) fail('workspace_invalid_database')
          if (mutate) current = mutate(current, stores)
          ready(current)
        } catch (error) { cancel(code(error)) }
      }
    })
  }
  async function readImage(guard: OwnerWorkspaceGuard, id?: string, originalId?: string): Promise<Image> {
    const result = await image('readonly', guard, id, originalId)
    await ownerSyncOutboxStorage.validateEntry(result.slot.entry, 'outbox_invalid_database')
    for (const receipt of [result.receipt, result.original]) if (receipt) await verifyReceipt(receipt)
    ensureOpen(); assertGuard(guard)
    return result
  }
  function writable(current: Image, baseline: Image, expectedLocal: number, expectedOutbox: number): void {
    if (current.slot.entry !== null) fail('workspace_pending')
    if (current.slot.version !== expectedOutbox || current.working.snapshot.localVersion !== expectedLocal) fail('workspace_conflict')
    if (!ownerSyncOutboxStorage.sameRow(current.slot, baseline.slot) || canonical(current.working) !== canonical(baseline.working)) fail('workspace_conflict')
  }
  function advanceEmptySlot(current: Image, stores: Record<string, IDBObjectStore>): SlotRow {
    // Coordinate an older tab's prepare CAS. This empty-slot epoch is neither
    // a cloud revision nor a Holding/Policy/Decision version or confirmation.
    const slot = Object.freeze({ version: increment(current.slot.version), entry: null, resourceFingerprint: target })
    stores.slot.put(slot, CURRENT)
    return slot
  }
  async function replace(next: OwnerWorkspaceSnapshot, baseline: Image, expectedOutbox: number, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSnapshot> {
    const committed = await image('readwrite', guard, undefined, undefined, (current, stores) => {
      writable(current, baseline, baseline.working.snapshot.localVersion, expectedOutbox)
      const slot = advanceEmptySlot(current, stores)
      stores[WORKING].put({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, CURRENT)
      return { ...current, slot, working: working({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, target) }
    })
    observe(committed)
    return committed.working.snapshot
  }
  async function mutateReceipt(id: string, hash: string, baseline: Image, next: OwnerWorkspaceSnapshot,
    operation: 'import' | 'rollback', expectedLocal: number, expectedOutbox: number, rollbackOf: string | null,
    guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceReceipt> {
    const before = baseline.working.snapshot
    const body = { id, hash, operation, beforeLocalVersion: before.localVersion, localVersion: next.localVersion,
      outboxVersion: increment(expectedOutbox), preimageHash: await digest(canonical(before)), postimageHash: await digest(canonical(next)), rollbackOf }
    const stored: StoredReceipt = { schema: RECEIPT_SCHEMA, targetFingerprint: target, before, after: next,
      receipt: Object.freeze({ ...body, rawReceipt: receiptBody(body) }) }
    ensureOpen(); assertGuard(guard)
    const committed = await image('readwrite', guard, id, rollbackOf ?? undefined, (current, stores) => {
      // Actual stored receipt takes priority over current CAS/outbox state.
      if (current.receipt) {
        if (current.receipt.receipt.hash !== hash) fail('workspace_idempotency_conflict')
        return current
      }
      writable(current, baseline, expectedLocal, expectedOutbox)
      if (current.receiptCount >= MAX_RECEIPTS) fail('workspace_capacity')
      if (rollbackOf && (!current.original || canonical(current.original) !== canonical(baseline.original))) fail('workspace_conflict')
      const slot = advanceEmptySlot(current, stores)
      stores[WORKING].put({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, CURRENT)
      stores[RECEIPTS].add(stored, id)
      return { ...current, slot, working: working({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, target), receipt: stored }
    })
    await verifyReceipt(committed.receipt!)
    ensureOpen(); assertGuard(guard); observe(committed)
    return committed.receipt!.receipt
  }
  const api: OwnerWorkspace = {
    targetFingerprint: target,
    read(guard: OwnerWorkspaceGuard) { return bounded(guard, async () => (await readImage(guard)).working.snapshot) },
    adoptLegacy(seed, expectedLocalVersion, expectedOutboxVersion, guard) { return bounded(guard, async () => {
      if (!closed(seed, ['sourceKey', 'raw', 'entries'])) fail('workspace_invalid_input')
      const source = legacy({ sourceKey: seed.sourceKey, raw: seed.raw })!
      const entries = validateOwnerWorkspaceEntries(seed.entries)
      const baseline = await readImage(guard)
      if (counter(expectedLocalVersion) !== baseline.working.snapshot.localVersion || baseline.working.snapshot.legacy !== null
          || baseline.working.snapshot.entries.length !== 0) fail('workspace_conflict')
      return replace(snapshot({ localVersion: increment(expectedLocalVersion), entries, legacy: source }), baseline, counter(expectedOutboxVersion), guard)
    }) },
    importCloud(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'plan', 'expectedLocalVersion', 'expectedOutboxVersion'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceImportRequest(target, { id: input.id, plan: input.plan,
        expectedLocalVersion: input.expectedLocalVersion, expectedOutboxVersion: input.expectedOutboxVersion })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const baseline = await readImage(guard, request.id)
      if (baseline.receipt) {
        if (baseline.receipt.receipt.hash !== request.hash) fail('workspace_idempotency_conflict')
        return baseline.receipt.receipt
      }
      if (canonicalOwnerWorkspaceEntries(baseline.working.snapshot.entries) !== canonicalOwnerWorkspaceEntries(request.plan.preimage)) fail('workspace_conflict')
      if (canonicalOwnerWorkspaceEntries(request.plan.preimage) === canonicalOwnerWorkspaceEntries(request.plan.postimage)) fail('workspace_noop')
      const next = snapshot({ localVersion: increment(counter(request.expectedLocalVersion)), entries: request.plan.postimage, legacy: baseline.working.snapshot.legacy })
      return mutateReceipt(request.id, request.hash, baseline, next, 'import', request.expectedLocalVersion, request.expectedOutboxVersion, null, guard)
    }) },
    rollbackImport(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'importId', 'importHash', 'expectedSnapshot', 'expectedOutboxVersion'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceRollbackRequest(target, { id: input.id, importId: input.importId,
        importHash: input.importHash, expectedSnapshot: input.expectedSnapshot, expectedOutboxVersion: input.expectedOutboxVersion })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const baseline = await readImage(guard, request.id, request.importId)
      if (baseline.receipt) {
        if (baseline.receipt.receipt.hash !== request.hash) fail('workspace_idempotency_conflict')
        return baseline.receipt.receipt
      }
      if (!baseline.original || baseline.original.receipt.operation !== 'import' || baseline.original.receipt.hash !== request.importHash
          || canonical(request.expectedSnapshot) !== canonical(baseline.original.after)
          || canonical(baseline.working.snapshot) !== canonical(baseline.original.after)) fail('workspace_conflict')
      const next = snapshot({ ...baseline.original.before, localVersion: increment(baseline.working.snapshot.localVersion) })
      return mutateReceipt(request.id, request.hash, baseline, next, 'rollback', request.expectedSnapshot.localVersion, request.expectedOutboxVersion, request.importId, guard)
    }) },
    receipt(id, hash, guard) { return bounded(guard, async () => {
      if (typeof id !== 'string' || !ID.test(id) || typeof hash !== 'string' || !HASH.test(hash)) fail('workspace_invalid_input')
      const result = await readImage(guard, id)
      if (!result.receipt) return Object.freeze({ state: 'unknown' as const })
      if (result.receipt.receipt.hash !== hash) fail('workspace_idempotency_conflict')
      return Object.freeze({ state: 'matched' as const, receipt: result.receipt.receipt })
    }) },
    close,
  }
  return Object.freeze(api)
}

function strictProbe(factory: IDBFactory, target: string, baseline: SlotRow, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, db: IDBDatabase | undefined, tx: IDBTransaction | undefined
    const finish = (problem?: OwnerWorkspaceErrorCode) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort)
      if (problem) { try { tx?.abort() } catch { /* no writes exist in this probe */ } }
      db?.close()
      if (problem) reject(new OwnerWorkspaceError(problem)); else resolve()
    }
    const abort = () => finish('workspace_timeout')
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target)
      request.onblocked = () => finish('workspace_blocked')
      request.onerror = () => finish('workspace_invalid_database')
      request.onupgradeneeded = () => { request.transaction?.abort(); finish('workspace_invalid_database') }
      request.onsuccess = () => {
        db = request.result
        if (settled) { db.close(); return }
        db.onversionchange = () => finish('workspace_closed')
        try {
          if (!isOwnerSyncOutboxDatabase(db)) fail('workspace_invalid_database')
          tx = db.transaction('slot', 'readwrite', { durability: 'strict' })
          // Refuse a degraded platform before versionchange adds any stores.
          if (tx.durability !== 'strict') fail('workspace_unavailable')
          const store = tx.objectStore('slot'), get = store.get(CURRENT), count = store.count()
          let got = false, counted = false
          const accept = () => {
            if (!got || !counted) return
            try {
              if (count.result !== 1 || !ownerSyncOutboxStorage.sameRow(ownerSyncOutboxStorage.rowShape(get.result, target), baseline)) fail('workspace_conflict')
            } catch (error) { finish(code(error)) }
          }
          get.onsuccess = () => { got = true; accept() }; count.onsuccess = () => { counted = true; accept() }
          tx.oncomplete = () => finish()
          tx.onabort = () => finish('workspace_aborted')
          tx.onerror = () => finish('workspace_unavailable')
        } catch (error) { finish(code(error)) }
      }
    } catch (error) { finish(code(error)) }
  })
}

async function openWorkspace(factory: IDBFactory, target: string, signal: AbortSignal): Promise<OwnerWorkspace> {
  if (typeof target !== 'string' || !HASH.test(target)) fail('workspace_invalid_target')
  let baseline: SlotRow
  try {
    const outbox = await openOwnerSyncOutbox(factory, target, signal)
    const cancel = () => outbox.close()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) fail('workspace_timeout')
      baseline = { ...await outbox.read(), resourceFingerprint: target }
    } finally { signal.removeEventListener('abort', cancel); outbox.close() }
  } catch (error) { throw new OwnerWorkspaceError(code(error)) }
  if (signal.aborted) fail('workspace_timeout')
  await strictProbe(factory, target, baseline, signal)
  if (signal.aborted) fail('workspace_timeout')
  return new Promise((resolve, reject) => {
    let settled = false, upgraded = false
    let db: IDBDatabase | undefined, handle: OwnerWorkspace | undefined
    let activeTransaction: IDBTransaction | undefined
    const finish = (problem?: OwnerWorkspaceErrorCode) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort)
      if (problem) {
        try { activeTransaction?.abort() } catch { /* completed transactions stay committed */ }
        handle?.close(); try { db?.close() } catch { /* fixed error */ }
        reject(new OwnerWorkspaceError(problem))
      } else resolve(handle!)
    }
    const abort = () => finish('workspace_timeout')
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target, 2)
      request.onblocked = () => finish('workspace_blocked')
      request.onerror = () => finish(code(request.error, 'workspace_invalid_database'))
      request.onupgradeneeded = event => {
        db = request.result
        const tx = request.transaction!
        activeTransaction = tx
        if (settled || event.oldVersion !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('slot')) {
          tx.abort(); finish('workspace_invalid_database'); return
        }
        try {
          const store = tx.objectStore('slot')
          if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
          const get = store.get(CURRENT), count = store.count()
          let got = false, counted = false
          const accept = () => {
            if (!got || !counted) return
            try {
              if (settled || count.result !== 1 || !ownerSyncOutboxStorage.sameRow(ownerSyncOutboxStorage.rowShape(get.result, target), baseline)) fail('workspace_invalid_database')
              db!.createObjectStore(WORKING); db!.createObjectStore(RECEIPTS); upgraded = true
            } catch { tx.abort(); finish('workspace_invalid_database') }
          }
          get.onsuccess = () => { got = true; accept() }; count.onsuccess = () => { counted = true; accept() }
        } catch { tx.abort(); finish('workspace_invalid_database') }
      }
      request.onsuccess = () => {
        db = request.result
        if (settled) { db.close(); return }
        if (db.version !== 2 || !isOwnerSyncOutboxDatabase(db)) { finish('workspace_invalid_database'); return }
        db.onversionchange = () => { handle?.close(); db?.close(); finish('workspace_closed') }
        try {
          // Versionchange exposes no strict durability option. All new data
          // is initialized separately under an actually strict write tx. A
          // crash between these commits can leave v2 without working/current;
          // reopen rejects it, never silently repairs or reimports legacy.
          const tx = db.transaction(STORES, upgraded ? 'readwrite' : 'readonly', upgraded ? { durability: 'strict' } : undefined)
          activeTransaction = tx
          if (upgraded && tx.durability !== 'strict') { tx.abort(); fail('workspace_unavailable') }
          for (const name of STORES) {
            const store = tx.objectStore(name)
            if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) { tx.abort(); fail('workspace_invalid_database') }
          }
          if (upgraded) tx.objectStore(WORKING).add({ schema: SCHEMA, targetFingerprint: target,
            snapshot: { localVersion: 0, entries: [], legacy: null } }, CURRENT)
          tx.onabort = () => finish(code(tx.error, 'workspace_aborted'))
          tx.onerror = () => { try { tx.abort() } catch { /* fixed abort */ }; finish(code(tx.error)) }
          tx.oncomplete = () => {
            if (settled) { db?.close(); return }
            handle = makeWorkspace(db!, target)
            const active = new AbortController()
            handle.read({ signal: active.signal, assertActive() { /* internal schema/read validation, not UI authority */ } })
              .then(() => finish(), error => finish(code(error)))
          }
        } catch (error) { finish(code(error)) }
      }
    } catch (error) { finish(code(error)) }
  })
}

/** v1->v2 only adds stores; one budget covers preflight, strict probe and upgrade. */
export function openOwnerWorkspace(factory: IDBFactory, target: string): Promise<OwnerWorkspace> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const timer = setTimeout(() => {
      settled = true; controller.abort(); reject(new OwnerWorkspaceError('workspace_timeout'))
    }, OWNER_SYNC_OUTBOX_TIMEOUT_MS)
    openWorkspace(factory, target, controller.signal).then(handle => {
      if (settled) { handle.close(); return }
      settled = true; clearTimeout(timer); resolve(handle)
    }, error => {
      if (settled) return
      settled = true; clearTimeout(timer); reject(new OwnerWorkspaceError(code(error)))
    })
  })
}
