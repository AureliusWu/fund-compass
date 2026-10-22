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
import { validateHolding, type HoldingInput } from '@/utils/holding-editor'
import { normalizeOwnerSyncKey } from '@/utils/ownerSyncContract'
import {
  validateOwnerWorkspaceLocalMetadata, emptyOwnerWorkspaceLocalMetadata, validateOwnerWorkspaceSourceArchive,
  decodeOwnerWorkspaceSourceArchive, buildOwnerLegacyWorkspaceBackup, buildOwnerWorkspaceBackup, validateOwnerWorkspaceBackup,
  previewOwnerWorkspaceRestore, canonicalOwnerLocal, OWNER_WORKSPACE_MAX_ARCHIVES, OwnerWorkspaceBackupError,
  type OwnerWorkspaceLocalMetadata, type OwnerWorkspaceSourceArchive, type OwnerWorkspaceBackup,
} from '@/utils/owner-workspace-backup'

export type { OwnerWorkspaceEntry, OwnerWorkspaceLegacy, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
const WORKING = 'working_copy', RECEIPTS = 'import_receipts', METADATA = 'local_metadata', CURRENT = 'current'
const STORES = ['slot', WORKING, RECEIPTS, METADATA]
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
export interface OwnerWorkspaceLocalState {
  readonly snapshot: OwnerWorkspaceSnapshot
  readonly outbox: Readonly<{ version: number; entry: SlotRow['entry'] }>
  readonly metadata: OwnerWorkspaceLocalMetadata
  readonly receiptCount: number
}
export type OwnerWorkspaceLocalCommand = Readonly<{ type: 'save'; input: HoldingInput; expectedEntry: OwnerWorkspaceEntry | null; confirmed: boolean }>
  | Readonly<{ type: 'remove'; keys: readonly string[]; expectedEntries: readonly OwnerWorkspaceEntry[]; confirmed: boolean }>
export interface OwnerWorkspaceAdoptLocalRequest {
  readonly id: string; readonly hash: string; readonly expected: OwnerWorkspaceLocalState
  readonly sourceArchive: OwnerWorkspaceSourceArchive; readonly backupSha256: string
}
export interface OwnerWorkspaceEditLocalRequest {
  readonly id: string; readonly hash: string; readonly expected: OwnerWorkspaceLocalState; readonly command: OwnerWorkspaceLocalCommand
}
export interface OwnerWorkspaceRestoreLocalRequest {
  readonly id: string; readonly hash: string; readonly expected: OwnerWorkspaceLocalState; readonly backup: OwnerWorkspaceBackup
}
export interface OwnerWorkspace {
  readonly targetFingerprint: string
  read(guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSnapshot>
  readLocalState(guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  adoptLocal(request: OwnerWorkspaceAdoptLocalRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  editLocal(request: OwnerWorkspaceEditLocalRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  restoreLocal(request: OwnerWorkspaceRestoreLocalRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  /** Only the latest local mutation receipt is retained. Unknown never permits automatic replay. */
  localReceipt(id: string, hash: string, guard: OwnerWorkspaceGuard): Promise<Readonly<{ state: 'unknown' }>
    | Readonly<{ state: 'matched'; value: OwnerWorkspaceLocalState }>>
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
interface Image { slot: SlotRow; working: WorkingRow; metadata: OwnerWorkspaceLocalMetadata; receipt: StoredReceipt | null; original: StoredReceipt | null; receiptCount: number }
function fail(code: OwnerWorkspaceErrorCode): never { throw new OwnerWorkspaceError(code) }
function code(error: unknown, fallback: OwnerWorkspaceErrorCode = 'workspace_unavailable'): OwnerWorkspaceErrorCode {
  if (error instanceof OwnerWorkspaceError) return error.code
  if (error instanceof OwnerCloudImportError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerWorkspaceBackupError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
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
function checkedMetadata(value: unknown, state: OwnerWorkspaceSnapshot): OwnerWorkspaceLocalMetadata {
  try { return validateOwnerWorkspaceLocalMetadata(value, state) } catch { return fail('workspace_invalid_database') }
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

function localState(value: unknown, target: string): OwnerWorkspaceLocalState {
  if (!closed(value, ['snapshot', 'outbox', 'metadata', 'receiptCount']) || !closed(value.outbox, ['version', 'entry'])) fail('workspace_invalid_input')
  const copy = snapshot(value.snapshot), slot = ownerSyncOutboxStorage.rowShape({ ...value.outbox, resourceFingerprint: target }, target)
  const receiptCount = counter(value.receiptCount)
  if (receiptCount > MAX_RECEIPTS) fail('workspace_invalid_input')
  return Object.freeze({ snapshot: copy, outbox: Object.freeze({ version: slot.version, entry: slot.entry }),
    metadata: validateOwnerWorkspaceLocalMetadata(value.metadata, copy), receiptCount })
}
function stateOf(image: Image): OwnerWorkspaceLocalState {
  return Object.freeze({ snapshot: image.working.snapshot, outbox: Object.freeze({ version: image.slot.version, entry: image.slot.entry }),
    metadata: image.metadata, receiptCount: image.receiptCount })
}
function command(input: unknown): OwnerWorkspaceLocalCommand {
  if (closed(input, ['type', 'input', 'expectedEntry', 'confirmed']) && input.type === 'save' && typeof input.confirmed === 'boolean') {
    if (!closed(input.input, ['code', 'name', 'account', 'position_kind', 'shares', 'cost', 'target_weight'])) fail('workspace_invalid_input')
    let value: HoldingInput
    try { value = validateHolding(input.input as unknown as HoldingInput) } catch { return fail('workspace_invalid_input') }
    if (!value.name) fail('workspace_invalid_input')
    const expectedEntry = input.expectedEntry === null ? null : validateOwnerWorkspaceEntries([input.expectedEntry])[0]
    return Object.freeze({ type: 'save', input: Object.freeze(value), expectedEntry, confirmed: input.confirmed })
  }
  if (closed(input, ['type', 'keys', 'expectedEntries', 'confirmed']) && input.type === 'remove' && typeof input.confirmed === 'boolean') {
    const expectedEntries = validateOwnerWorkspaceEntries(input.expectedEntries)
    if (!Array.isArray(input.keys) || Object.getPrototypeOf(input.keys) !== Array.prototype || input.keys.length !== expectedEntries.length
      || !input.keys.length || Reflect.ownKeys(input.keys).length !== input.keys.length + 1
      || Object.keys(input.keys).some((key, index) => key !== String(index))
      || Object.entries(Object.getOwnPropertyDescriptors(input.keys)).some(([key, item]) => !('value' in item) || key !== 'length' && !item.enumerable)
      || input.keys.some((key, index) => key !== expectedEntries[index].key)) fail('workspace_invalid_input')
    return Object.freeze({ type: 'remove', keys: Object.freeze([...input.keys]), expectedEntries, confirmed: input.confirmed })
  }
  return fail('workspace_invalid_input')
}
function localId(target: string, id: string): void {
  if (typeof target !== 'string' || !HASH.test(target)) fail('workspace_invalid_target')
  if (typeof id !== 'string' || !ID.test(id)) fail('workspace_invalid_input')
}
export async function buildOwnerWorkspaceAdoptLocalRequest(target: string, input: Omit<OwnerWorkspaceAdoptLocalRequest, 'hash'>): Promise<OwnerWorkspaceAdoptLocalRequest> {
  if (!closed(input, ['id', 'expected', 'sourceArchive', 'backupSha256'])) fail('workspace_invalid_input')
  localId(target, input.id)
  if (typeof input.backupSha256 !== 'string' || !HASH.test(input.backupSha256)) fail('workspace_invalid_input')
  const copy = { id: input.id, expected: localState(input.expected, target), sourceArchive: validateOwnerWorkspaceSourceArchive(input.sourceArchive), backupSha256: input.backupSha256 }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'local-adopt-1', target, ...copy })) })
}
export async function buildOwnerWorkspaceEditLocalRequest(target: string, input: Omit<OwnerWorkspaceEditLocalRequest, 'hash'>): Promise<OwnerWorkspaceEditLocalRequest> {
  if (!closed(input, ['id', 'expected', 'command'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const copy = { id: input.id, expected: localState(input.expected, target), command: command(input.command) }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'local-edit-1', target, ...copy })) })
}
export async function buildOwnerWorkspaceRestoreLocalRequest(target: string, input: Omit<OwnerWorkspaceRestoreLocalRequest, 'hash'>): Promise<OwnerWorkspaceRestoreLocalRequest> {
  if (!closed(input, ['id', 'expected', 'backup'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const copy = { id: input.id, expected: localState(input.expected, target), backup: await validateOwnerWorkspaceBackup(input.backup) }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'local-restore-1', target, ...copy })) })
}

function makeWorkspace(db: IDBDatabase, target: string): OwnerWorkspace {
  let closedHandle = false
  const inFlight = new Set<(value: OwnerWorkspaceErrorCode) => void>()
  let observedLocal: OwnerWorkspaceSnapshot | null = null, observedSlot: SlotRow | null = null
  let observedMetadata: OwnerWorkspaceLocalMetadata | null = null
  const ensureOpen = () => { if (closedHandle) fail('workspace_closed') }
  const close = () => {
    if (closedHandle) return
    closedHandle = true
    observedLocal = null; observedSlot = null; observedMetadata = null
    for (const cancel of [...inFlight]) cancel('workspace_closed')
    try { db.close() } catch { /* disposal has no driver details */ }
  }
  db.onversionchange = close
  db.onclose = close
  function observe(image: Image): void {
    const next = image.working.snapshot
    if (observedLocal && (next.localVersion < observedLocal.localVersion
        || (next.localVersion === observedLocal.localVersion && (canonical(next) !== canonical(observedLocal)
          || canonical(image.metadata) !== canonical(observedMetadata))))) fail('workspace_invalid_database')
    if (observedSlot && (image.slot.version < observedSlot.version
        || (image.slot.version === observedSlot.version && !ownerSyncOutboxStorage.sameRow(image.slot, observedSlot)))) fail('workspace_invalid_database')
    observedLocal = next; observedSlot = image.slot; observedMetadata = image.metadata
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
        metadata: stores[METADATA].get(CURRENT), metadatas: stores[METADATA].count(),
        ...(id ? { receipt: stores[RECEIPTS].get(id) } : {}),
        ...(originalId ? { original: stores[RECEIPTS].get(originalId) } : {}),
      }
      let remaining = Object.keys(requests).length
      for (const request of Object.values(requests)) request.onsuccess = () => {
        if (--remaining !== 0) return
        try {
          ensureOpen(); assertGuard(guard)
          if (requests.slots.result !== 1 || requests.workings.result !== 1 || requests.metadatas.result !== 1
              || typeof requests.receipts.result !== 'number' || !Number.isSafeInteger(requests.receipts.result)
              || requests.receipts.result < 0 || requests.receipts.result > MAX_RECEIPTS) fail('workspace_invalid_database')
          const currentWorking = working(requests.working.result, target)
          let current: Image = { slot: ownerSyncOutboxStorage.rowShape(requests.slot.result, target), working: currentWorking,
            metadata: checkedMetadata(requests.metadata.result, currentWorking.snapshot),
            receipt: id && requests.receipt.result !== undefined ? storedReceipt(requests.receipt.result, target) : null,
            original: originalId && requests.original.result !== undefined ? storedReceipt(requests.original.result, target) : null,
            receiptCount: requests.receipts.result }
          observe(current)
          if (current.metadata.recentEdit && current.metadata.recentEdit.outboxVersion > current.slot.version) fail('workspace_invalid_database')
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
    if (!ownerSyncOutboxStorage.sameRow(current.slot, baseline.slot) || canonical(current.working) !== canonical(baseline.working)
      || canonical(current.metadata) !== canonical(baseline.metadata) || current.receiptCount !== baseline.receiptCount) fail('workspace_conflict')
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
      if (current.metadata.adoption) fail('workspace_conflict')
      const slot = advanceEmptySlot(current, stores)
      stores[WORKING].put({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, CURRENT)
      const metadata = emptyOwnerWorkspaceLocalMetadata(next)
      stores[METADATA].put(metadata, CURRENT)
      return { ...current, slot, metadata, working: working({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, target) }
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
      if (current.metadata.adoption) fail('workspace_conflict')
      if (current.receiptCount >= MAX_RECEIPTS) fail('workspace_capacity')
      if (rollbackOf && (!current.original || canonical(current.original) !== canonical(baseline.original))) fail('workspace_conflict')
      const slot = advanceEmptySlot(current, stores)
      stores[WORKING].put({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, CURRENT)
      const metadata = emptyOwnerWorkspaceLocalMetadata(next)
      stores[METADATA].put(metadata, CURRENT)
      stores[RECEIPTS].add(stored, id)
      return { ...current, slot, metadata, working: working({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, target), receipt: stored }
    })
    await verifyReceipt(committed.receipt!)
    ensureOpen(); assertGuard(guard); observe(committed)
    return committed.receipt!.receipt
  }
  function expectedImage(current: Image, expected: OwnerWorkspaceLocalState): void {
    if (canonical(stateOf(current)) !== canonical(expected)) fail('workspace_conflict')
  }
  function matchingLocal(image: Image, id: string, hash: string): boolean {
    const receipt = image.metadata.recentEdit
    if (receipt?.id !== id) return false
    if (receipt.hash !== hash) fail('workspace_idempotency_conflict')
    return receipt.localVersion === image.working.snapshot.localVersion && receipt.outboxVersion === image.slot.version
  }
  async function commitLocal(baseline: Image, expected: OwnerWorkspaceLocalState, next: OwnerWorkspaceSnapshot,
    metadata: OwnerWorkspaceLocalMetadata, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState> {
    // Refuse a state which cannot be exported under the same complete UTF-8
    // budget, including escaped raw archives. Never discard older archives.
    await buildOwnerWorkspaceBackup({ snapshot: next, metadata })
    ensureOpen(); assertGuard(guard)
    const committed = await image('readwrite', guard, undefined, undefined, (current, stores) => {
      expectedImage(current, expected)
      writable(current, baseline, expected.snapshot.localVersion, expected.outbox.version)
      const slot = advanceEmptySlot(current, stores)
      const nextWorking = working({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, target)
      const nextMetadata = validateOwnerWorkspaceLocalMetadata(metadata, next)
      stores[WORKING].put(nextWorking, CURRENT); stores[METADATA].put(nextMetadata, CURRENT)
      return { ...current, slot, working: nextWorking, metadata: nextMetadata }
    })
    ensureOpen(); assertGuard(guard); observe(committed)
    return stateOf(committed)
  }
  function editPostimage(before: OwnerWorkspaceSnapshot, input: OwnerWorkspaceLocalCommand): { snapshot: OwnerWorkspaceSnapshot; changedKeys: readonly string[] } {
    const list = [...before.entries], changedKeys: string[] = []
    if (input.type === 'save') {
      const value = input.input, key = normalizeOwnerSyncKey('watch', value.code + '::' + value.account)
      const previous = input.expectedEntry
      const index = previous ? list.findIndex(row => row.key === previous.key) : -1
      if (previous && (index < 0 || previous.key.slice(0, 6) !== value.code
        || canonical(list[index]) !== canonical(previous))) fail('workspace_conflict')
      if (previous?.deleted && (previous.key !== key || value.position_kind !== 'watch'
        || value.shares !== null || value.cost !== null || value.target_weight !== null)) fail('workspace_conflict')
      if (previous && !previous.deleted && previous.kind === 'holding' && value.position_kind === 'watch' && !input.confirmed) fail('workspace_invalid_input')
      const targetIndex = list.findIndex(row => row.key === key)
      if (targetIndex >= 0 && list[targetIndex].key !== previous?.key) fail('workspace_conflict')
      if (previous && previous.key !== key) {
        list[index] = { ...previous, deleted: true, local_pending: true }; changedKeys.push(previous.key)
      }
      const replacement: OwnerWorkspaceEntry = { key, kind: value.position_kind, deleted: false, local_pending: true,
        values: { name: value.name!, shares: value.shares, cost: value.cost, target_weight: value.target_weight } }
      if (targetIndex >= 0) list[targetIndex] = replacement; else list.push(replacement)
      changedKeys.push(key)
    } else {
      if (!input.confirmed && (input.expectedEntries.length > 1 || input.expectedEntries.some(row => row.kind === 'holding'))) fail('workspace_invalid_input')
      for (const expected of input.expectedEntries) {
        const index = list.findIndex(row => row.key === expected.key)
        if (index < 0 || expected.deleted || canonical(list[index]) !== canonical(expected)) fail('workspace_conflict')
        list[index] = { ...expected, deleted: true, local_pending: true }; changedKeys.push(expected.key)
      }
    }
    return { snapshot: snapshot({ ...before, localVersion: increment(before.localVersion), entries: list }), changedKeys }
  }
  const api: OwnerWorkspace = {
    targetFingerprint: target,
    read(guard: OwnerWorkspaceGuard) { return bounded(guard, async () => (await readImage(guard)).working.snapshot) },
    readLocalState(guard) { return bounded(guard, async () => stateOf(await readImage(guard))) },
    adoptLocal(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'expected', 'sourceArchive', 'backupSha256'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceAdoptLocalRequest(target, { id: input.id, expected: input.expected,
        sourceArchive: input.sourceArchive, backupSha256: input.backupSha256 })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const decoded = decodeOwnerWorkspaceSourceArchive(request.sourceArchive)
      const backup = await buildOwnerLegacyWorkspaceBackup(request.sourceArchive)
      if (backup.sha256 !== request.backupSha256) fail('workspace_invalid_input')
      const baseline = await readImage(guard)
      // Activation cannot supersede any existing candidate state/receipt.
      expectedImage(baseline, request.expected)
      if (baseline.metadata.adoption || baseline.working.snapshot.localVersion !== 0
        || baseline.metadata.recentEdit !== null || baseline.metadata.restoredArchives.length !== 0
        || baseline.working.snapshot.entries.length || baseline.working.snapshot.legacy !== null
        || baseline.receiptCount !== 0) fail('workspace_conflict')
      const next = snapshot({ localVersion: increment(baseline.working.snapshot.localVersion), entries: decoded.entries,
        legacy: decoded.archive.sourceKey === null ? null : { sourceKey: decoded.archive.sourceKey,
          raw: decoded.archive.sourceKey === 'sinan_watchlist_v2' ? decoded.archive.v2Raw : decoded.archive.v1Raw } })
      const metadata: OwnerWorkspaceLocalMetadata = { schema: 'owner-workspace-local-1',
        adoption: { id: request.id, hash: request.hash, backupSha256: request.backupSha256,
          sourceArchive: request.sourceArchive, localVersion: next.localVersion },
        displayTimes: decoded.displayTimes, recentEdit: null, restoredArchives: [] }
      return commitLocal(baseline, request.expected, next, metadata, guard)
    }) },
    editLocal(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'expected', 'command'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceEditLocalRequest(target, { id: input.id, expected: input.expected, command: input.command })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const baseline = await readImage(guard)
      if (matchingLocal(baseline, request.id, request.hash)) return stateOf(baseline)
      expectedImage(baseline, request.expected)
      if (!baseline.metadata.adoption || baseline.metadata.adoption.id === request.id) fail('workspace_conflict')
      const next = editPostimage(baseline.working.snapshot, request.command), timestamp = new Date().toISOString()
      const oldTimes = new Map(baseline.metadata.displayTimes.map(row => [row.key, row.updated_at])), changed = new Set(next.changedKeys)
      const metadata: OwnerWorkspaceLocalMetadata = { ...baseline.metadata,
        displayTimes: next.snapshot.entries.map(row => ({ key: row.key, updated_at: changed.has(row.key) ? timestamp : oldTimes.get(row.key) ?? null })),
        recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
          localVersion: next.snapshot.localVersion, outboxVersion: increment(baseline.slot.version) } }
      return commitLocal(baseline, request.expected, next.snapshot, metadata, guard)
    }) },
    restoreLocal(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'expected', 'backup'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceRestoreLocalRequest(target, { id: input.id, expected: input.expected, backup: input.backup })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const baseline = await readImage(guard)
      if (matchingLocal(baseline, request.id, request.hash)) return stateOf(baseline)
      expectedImage(baseline, request.expected)
      if (!baseline.metadata.adoption || baseline.metadata.adoption.id === request.id) fail('workspace_conflict')
      const preview = previewOwnerWorkspaceRestore(stateOf(baseline), request.backup)
      if (preview.conflicts) fail('workspace_conflict')
      if (!preview.added) return stateOf(baseline) // empty/same backup never clears or advances anything
      const additions = preview.rows.filter(row => row.action === 'add').map(row => row.after)
      const next = snapshot({ ...baseline.working.snapshot, entries: [...baseline.working.snapshot.entries, ...additions],
        localVersion: increment(baseline.working.snapshot.localVersion) })
      const archives = [...baseline.metadata.restoredArchives], own = canonicalOwnerLocal(baseline.metadata.adoption.sourceArchive)
      for (const archive of [request.backup.sourceArchive, ...request.backup.restoredArchives]) {
        const raw = canonicalOwnerLocal(archive)
        if (raw !== own && !archives.some(value => canonicalOwnerLocal(value) === raw)) archives.push(archive)
      }
      if (archives.length > OWNER_WORKSPACE_MAX_ARCHIVES) fail('workspace_capacity')
      const addedKeys = new Set(additions.map(row => row.key))
      const metadata: OwnerWorkspaceLocalMetadata = { ...baseline.metadata, restoredArchives: archives,
        displayTimes: [...baseline.metadata.displayTimes, ...request.backup.displayTimes.filter(row => addedKeys.has(row.key))],
        recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
          localVersion: next.localVersion, outboxVersion: increment(baseline.slot.version) } }
      return commitLocal(baseline, request.expected, next, metadata, guard)
    }) },
    localReceipt(id, hash, guard) { return bounded(guard, async () => {
      localId(target, id)
      if (typeof hash !== 'string' || !HASH.test(hash)) fail('workspace_invalid_input')
      const current = await readImage(guard)
      if (!matchingLocal(current, id, hash)) return Object.freeze({ state: 'unknown' as const })
      return Object.freeze({ state: 'matched' as const, value: stateOf(current) })
    }) },
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

async function openWorkspace(factory: IDBFactory, target: string, signal: AbortSignal, existingOnly = false): Promise<OwnerWorkspace> {
  if (typeof target !== 'string' || !HASH.test(target)) fail('workspace_invalid_target')
  if (existingOnly) return openExistingWorkspace(factory, target, signal)
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
    let settled = false, upgraded = false, fromVersion = 0
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
      const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target, 3)
      request.onblocked = () => finish('workspace_blocked')
      request.onerror = () => finish(code(request.error, 'workspace_invalid_database'))
      request.onupgradeneeded = event => {
        db = request.result
        const tx = request.transaction!
        activeTransaction = tx
        fromVersion = event.oldVersion
        const names = event.oldVersion === 1 ? ['slot'] : event.oldVersion === 2 ? ['slot', WORKING, RECEIPTS] : []
        if (settled || !names.length || db.objectStoreNames.length !== names.length || !names.every(name => db!.objectStoreNames.contains(name))) {
          tx.abort(); finish('workspace_invalid_database'); return
        }
        try {
          const store = tx.objectStore('slot')
          if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
          const requests = [store.get(CURRENT), store.count(), ...(fromVersion === 2
            ? [tx.objectStore(WORKING).get(CURRENT), tx.objectStore(WORKING).count(), tx.objectStore(RECEIPTS).count()] : [])]
          let remaining = requests.length
          const accept = () => {
            if (--remaining !== 0) return
            try {
              if (settled || requests[1].result !== 1 || !ownerSyncOutboxStorage.sameRow(ownerSyncOutboxStorage.rowShape(requests[0].result, target), baseline)) fail('workspace_invalid_database')
              if (fromVersion === 2) {
                for (const name of [WORKING, RECEIPTS]) {
                  const previous = tx.objectStore(name)
                  if (previous.keyPath !== null || previous.autoIncrement || previous.indexNames.length) fail('workspace_invalid_database')
                }
                working(requests[2].result, target)
                if (requests[3].result !== 1 || counter(requests[4].result) > MAX_RECEIPTS) fail('workspace_invalid_database')
              } else { db!.createObjectStore(WORKING); db!.createObjectStore(RECEIPTS) }
              db!.createObjectStore(METADATA); upgraded = true
            } catch { tx.abort(); finish('workspace_invalid_database') }
          }
          for (const pending of requests) pending.onsuccess = accept
        } catch { tx.abort(); finish('workspace_invalid_database') }
      }
      request.onsuccess = () => {
        db = request.result
        if (settled) { db.close(); return }
        if (db.version !== 3 || !isOwnerSyncOutboxDatabase(db)) { finish('workspace_invalid_database'); return }
        db.onversionchange = () => { handle?.close(); db?.close(); finish('workspace_closed') }
        try {
          // Versionchange exposes no strict durability option. All new data
          // is initialized separately under an actually strict write tx. A
          // crash between these commits can leave v3 without metadata/current;
          // reopen rejects it, never silently repairs or reimports legacy.
          const tx = db.transaction(STORES, upgraded ? 'readwrite' : 'readonly', upgraded ? { durability: 'strict' } : undefined)
          activeTransaction = tx
          if (upgraded && tx.durability !== 'strict') { tx.abort(); fail('workspace_unavailable') }
          for (const name of STORES) {
            const store = tx.objectStore(name)
            if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) { tx.abort(); fail('workspace_invalid_database') }
          }
          if (upgraded && fromVersion === 1) {
            const initial = snapshot({ localVersion: 0, entries: [], legacy: null })
            tx.objectStore(WORKING).add({ schema: SCHEMA, targetFingerprint: target, snapshot: initial }, CURRENT)
            tx.objectStore(METADATA).add(emptyOwnerWorkspaceLocalMetadata(initial), CURRENT)
          } else if (upgraded) {
            const get = tx.objectStore(WORKING).get(CURRENT), count = tx.objectStore(WORKING).count()
            let got = false, counted = false
            const initialize = () => {
              if (!got || !counted) return
              try {
                if (count.result !== 1) fail('workspace_invalid_database')
                tx.objectStore(METADATA).add(emptyOwnerWorkspaceLocalMetadata(working(get.result, target).snapshot), CURRENT)
              } catch (error) { try { tx.abort() } catch { /* fixed failure */ }; finish(code(error)) }
            }
            get.onsuccess = () => { got = true; initialize() }; count.onsuccess = () => { counted = true; initialize() }
          }
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

/** Reopening a durable authority never creates, upgrades, or reconstructs it. */
function openExistingWorkspace(factory: IDBFactory, target: string, signal: AbortSignal): Promise<OwnerWorkspace> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, handle: OwnerWorkspace | undefined, settled = false
    const finish = (problem?: OwnerWorkspaceErrorCode) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort)
      if (problem) { handle?.close(); db?.close(); reject(new OwnerWorkspaceError(problem)) } else resolve(handle!)
    }
    const abort = () => finish('workspace_timeout')
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target)
      request.onupgradeneeded = () => { request.transaction?.abort(); finish('workspace_invalid_database') }
      request.onblocked = () => finish('workspace_blocked')
      request.onerror = () => finish('workspace_invalid_database')
      request.onsuccess = () => {
        db = request.result
        if (settled) { db.close(); return }
        if (db.version !== 3 || !isOwnerSyncOutboxDatabase(db)) { finish('workspace_invalid_database'); return }
        handle = makeWorkspace(db, target)
        handle.readLocalState({ signal, assertActive() { if (signal.aborted) fail('workspace_timeout') } })
          .then(() => finish(), error => finish(code(error)))
      }
    } catch (error) { finish(code(error)) }
  })
}

/** v1/v2->v3 adds only stores/independent metadata; one budget covers every phase. */
export function openOwnerWorkspace(factory: IDBFactory, target: string, options: { readonly existingOnly?: boolean } = {}): Promise<OwnerWorkspace> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const timer = setTimeout(() => {
      settled = true; controller.abort(); reject(new OwnerWorkspaceError('workspace_timeout'))
    }, OWNER_SYNC_OUTBOX_TIMEOUT_MS)
    openWorkspace(factory, target, controller.signal, options.existingOnly === true).then(handle => {
      if (settled) { handle.close(); return }
      settled = true; clearTimeout(timer); resolve(handle)
    }, error => {
      if (settled) return
      settled = true; clearTimeout(timer); reject(new OwnerWorkspaceError(code(error)))
    })
  })
}
