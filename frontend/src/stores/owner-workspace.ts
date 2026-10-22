/** Local IDB authority. Cloud preparation is explicit; no implicit HTTP or credential IO. */
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
import { buildOwnerSyncRequest, restoreOwnerSyncRequest, type BuiltOwnerSyncRequest } from '@/utils/ownerSyncContract'
import { buildOwnerWorkspaceCloudLinkPreview, planOwnerWorkspaceCloudIntent, OwnerWorkspaceSyncError } from '@/utils/owner-workspace-sync'
import { emptyOwnerWorkspaceSyncMetadata, validateOwnerWorkspaceSyncMetadata,
  OwnerWorkspaceSyncMetadataError, type OwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'

export type { OwnerWorkspaceEntry, OwnerWorkspaceLegacy, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
const WORKING = 'working_copy', RECEIPTS = 'import_receipts', METADATA = 'local_metadata', CURRENT = 'current'
const STORES = ['slot', WORKING, RECEIPTS, METADATA]
const SYNC = 'sync_metadata'
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
  /** Present only in physical v4, including the entire common base and epoch. */
  readonly sync?: OwnerWorkspaceSyncMetadata
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
export interface OwnerWorkspaceSyncState {
  readonly local: OwnerWorkspaceLocalState
  readonly sync: OwnerWorkspaceSyncMetadata
}
export interface OwnerWorkspaceLinkCloudRequest {
  readonly id: string; readonly hash: string; readonly expected: OwnerWorkspaceSyncState
  readonly base: OwnerWorkspaceSyncMetadata['base']
}
export interface OwnerWorkspacePrepareCloudRequest {
  readonly id: string; readonly hash: string; readonly expected: OwnerWorkspaceSyncState
  readonly packet: BuiltOwnerSyncRequest
}
export interface OwnerWorkspaceCancelCloudRequest {
  readonly id: string; readonly hash: string; readonly expected: OwnerWorkspaceSyncState
  readonly requestId: string; readonly requestHash: string
}
export interface OwnerWorkspace {
  readonly targetFingerprint: string
  read(guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSnapshot>
  readLocalState(guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  adoptLocal(request: OwnerWorkspaceAdoptLocalRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  editLocal(request: OwnerWorkspaceEditLocalRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  restoreLocal(request: OwnerWorkspaceRestoreLocalRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  /** Explicit physical-v4 primitives only. No HTTP, implicit upgrade, or cloud confirmation. */
  readSyncState(guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  linkCloudBase(request: OwnerWorkspaceLinkCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  prepareCloud(request: OwnerWorkspacePrepareCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  cancelPreparedCloud(request: OwnerWorkspaceCancelCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  syncReceipt(id: string, hash: string, guard: OwnerWorkspaceGuard): Promise<Readonly<{ state: 'unknown' }>
    | Readonly<{ state: 'matched'; value: OwnerWorkspaceSyncState }>>
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
interface Image { slot: SlotRow; working: WorkingRow; metadata: OwnerWorkspaceLocalMetadata; sync: OwnerWorkspaceSyncMetadata | null;
  receipt: StoredReceipt | null; original: StoredReceipt | null; receiptCount: number }
function fail(code: OwnerWorkspaceErrorCode): never { throw new OwnerWorkspaceError(code) }
function code(error: unknown, fallback: OwnerWorkspaceErrorCode = 'workspace_unavailable'): OwnerWorkspaceErrorCode {
  if (error instanceof OwnerWorkspaceError) return error.code
  if (error instanceof OwnerCloudImportError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerWorkspaceBackupError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerWorkspaceSyncMetadataError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerWorkspaceSyncError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
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
  const hasSync = !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'sync')
  if (!closed(value, ['snapshot', 'outbox', 'metadata', 'receiptCount', ...(hasSync ? ['sync'] : [])])
    || !closed(value.outbox, ['version', 'entry'])) fail('workspace_invalid_input')
  if (value.outbox.entry !== null && !closed(value.outbox.entry, ['schema', 'state', 'rawBody', 'requestHash'])) fail('workspace_invalid_input')
  const copy = snapshot(value.snapshot), slot = ownerSyncOutboxStorage.rowShape({ ...value.outbox, resourceFingerprint: target }, target)
  const receiptCount = counter(value.receiptCount)
  if (receiptCount > MAX_RECEIPTS) fail('workspace_invalid_input')
  const metadata = validateOwnerWorkspaceLocalMetadata(value.metadata, copy)
  const sync = hasSync ? validateOwnerWorkspaceSyncMetadata(value.sync, target, { snapshot: copy, metadata,
    outbox: { version: slot.version, entry: slot.entry } }) : null
  return Object.freeze({ snapshot: copy, outbox: Object.freeze({ version: slot.version, entry: slot.entry }),
    metadata, receiptCount, ...(sync ? { sync } : {}) })
}
function stateOf(image: Image): OwnerWorkspaceLocalState {
  return Object.freeze({ snapshot: image.working.snapshot, outbox: Object.freeze({ version: image.slot.version, entry: image.slot.entry }),
    metadata: image.metadata, receiptCount: image.receiptCount, ...(image.sync ? { sync: image.sync } : {}) })
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

function syncState(input: unknown, target: string): OwnerWorkspaceSyncState {
  if (!closed(input, ['local', 'sync'])) fail('workspace_invalid_input')
  const local = localState(input.local, target)
  const sync = validateOwnerWorkspaceSyncMetadata(input.sync, target, {
    snapshot: local.snapshot, metadata: local.metadata, outbox: local.outbox,
  })
  if (!local.sync || canonical(local.sync) !== canonical(sync)) fail('workspace_invalid_input')
  return Object.freeze({ local, sync })
}
function syncStateOf(image: Image): OwnerWorkspaceSyncState {
  if (!image.sync) fail('workspace_invalid_database')
  return Object.freeze({ local: stateOf(image), sync: image.sync })
}
export async function buildOwnerWorkspaceLinkCloudRequest(target: string,
  input: Omit<OwnerWorkspaceLinkCloudRequest, 'hash'>): Promise<OwnerWorkspaceLinkCloudRequest> {
  if (!closed(input, ['id', 'expected', 'base'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const expected = syncState(input.expected, target)
  if (expected.sync.base !== null || expected.sync.pending || expected.local.outbox.entry || !expected.local.metadata.adoption) fail('workspace_conflict')
  const preview = buildOwnerWorkspaceCloudLinkPreview(input.base, expected.local.snapshot)
  if (preview.issues.length) fail('workspace_conflict')
  const copy = { id: input.id, expected, base: preview.base }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'cloud-link-1', target, ...copy })) })
}
export async function buildOwnerWorkspacePrepareCloudRequest(target: string,
  input: Pick<OwnerWorkspacePrepareCloudRequest, 'id' | 'expected'>): Promise<OwnerWorkspacePrepareCloudRequest> {
  if (!closed(input, ['id', 'expected'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const expected = syncState(input.expected, target)
  if (!expected.sync.base || expected.sync.pending || expected.local.outbox.entry || !expected.local.metadata.adoption) fail('workspace_conflict')
  const intent = planOwnerWorkspaceCloudIntent(expected.sync.base, expected.local.snapshot)
  if (intent.issues.length) fail('workspace_conflict')
  if (!intent.operations.length) fail('workspace_noop')
  let packet: BuiltOwnerSyncRequest
  try {
    const built = await buildOwnerSyncRequest({ request_id: input.id, expected_revision: expected.sync.base.pulledRevision,
      operations: intent.operations })
    // Bind the original wire DTO, not an in-memory duplicate whose signed
    // numeric zero can differ after JSON restoration. B and L stay unchanged.
    packet = await restoreOwnerSyncRequest(built.rawBody, built.requestHash)
  } catch { return fail('workspace_invalid_input') }
  const copy = { id: input.id, expected, packet }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'cloud-prepare-1', target, ...copy })) })
}
export async function buildOwnerWorkspaceCancelCloudRequest(target: string,
  input: Omit<OwnerWorkspaceCancelCloudRequest, 'hash'>): Promise<OwnerWorkspaceCancelCloudRequest> {
  if (!closed(input, ['id', 'expected', 'requestId', 'requestHash'])) fail('workspace_invalid_input')
  localId(target, input.id); localId(target, input.requestId)
  if (typeof input.requestHash !== 'string' || !HASH.test(input.requestHash) || input.id === input.requestId) fail('workspace_invalid_input')
  const expected = syncState(input.expected, target)
  const pending = expected.sync.pending
  if (expected.local.outbox.entry?.state !== 'prepared' || !pending
    || pending.requestId !== input.requestId || pending.requestHash !== input.requestHash) fail('workspace_pending')
  const copy = { id: input.id, expected, requestId: input.requestId, requestHash: input.requestHash }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'cloud-cancel-1', target, ...copy })) })
}

// Excludes mutable delivery state, but binds every local row/archive/receipt
// count and the exact complete common base. Hashes are not source authentication.
function pendingPreimage(image: Image, epoch: number, preparedOutboxVersion: number): string {
  return canonical({ target: image.sync?.targetFingerprint, snapshot: image.working.snapshot, metadata: image.metadata,
    receiptCount: image.receiptCount, base: image.sync?.base, epoch, preparedOutboxVersion })
}

function makeWorkspace(db: IDBDatabase, target: string): OwnerWorkspace {
  const storesForVersion = db.version === 4 ? [...STORES, SYNC] : STORES
  let closedHandle = false
  const inFlight = new Set<(value: OwnerWorkspaceErrorCode) => void>()
  let observedLocal: OwnerWorkspaceSnapshot | null = null, observedSlot: SlotRow | null = null
  let observedMetadata: OwnerWorkspaceLocalMetadata | null = null
  let observedSync: OwnerWorkspaceSyncMetadata | null = null
  const ensureOpen = () => { if (closedHandle) fail('workspace_closed') }
  const close = () => {
    if (closedHandle) return
    closedHandle = true
    observedLocal = null; observedSlot = null; observedMetadata = null; observedSync = null
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
    if (observedSync && (!image.sync || image.sync.epoch < observedSync.epoch
        || image.sync.epoch === observedSync.epoch && canonical(image.sync) !== canonical(observedSync))) fail('workspace_invalid_database')
    observedLocal = next; observedSlot = image.slot; observedMetadata = image.metadata; observedSync = image.sync
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
        tx = db.transaction(storesForVersion, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
        if (mode === 'readwrite' && tx.durability !== 'strict') fail('workspace_unavailable')
        const stores = Object.fromEntries(storesForVersion.map(name => {
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
        ...(db.version === 4 ? { sync: stores[SYNC].get(CURRENT), syncs: stores[SYNC].count() } : {}),
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
          const slot = ownerSyncOutboxStorage.rowShape(requests.slot.result, target)
          const metadata = checkedMetadata(requests.metadata.result, currentWorking.snapshot)
          if (db.version === 4 && requests.syncs.result !== 1) fail('workspace_invalid_database')
          let sync: OwnerWorkspaceSyncMetadata | null = null
          if (db.version === 4) {
            try { sync = validateOwnerWorkspaceSyncMetadata(requests.sync.result, target, { snapshot: currentWorking.snapshot, metadata,
              outbox: { version: slot.version, entry: slot.entry } }) }
            catch { fail('workspace_invalid_database') }
          }
          let current: Image = { slot, working: currentWorking, sync,
            metadata,
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
    if (result.sync?.pending) {
      try {
        const pending = result.sync.pending
        const packet = await restoreOwnerSyncRequest(pending.rawBody, pending.requestHash)
        // Delivery-state transitions may advance the slot, not the preparation
        // epoch. Recover the exact pre-prepare local envelope to verify the
        // independently retained preparation hash as well as its data image.
        const beforeSync = { ...result.sync, epoch: result.sync.epoch - 1, pending: null }
        const beforeLocal = { ...stateOf(result), outbox: { version: pending.preparedOutboxVersion - 1, entry: null }, sync: beforeSync }
        const expected = syncState({ local: beforeLocal, sync: beforeSync }, target)
        if (packet.request.request_id !== pending.requestId || packet.request.expected_revision !== pending.baseRevision
          || await digest(canonical({ operation: 'cloud-prepare-1', target, id: pending.requestId, expected, packet })) !== pending.preparationHash
          || await digest(pendingPreimage(result, result.sync.epoch, pending.preparedOutboxVersion)) !== pending.preimageHash) fail('workspace_invalid_database')
      } catch { fail('workspace_invalid_database') }
    }
    for (const receipt of [result.receipt, result.original]) if (receipt) await verifyReceipt(receipt)
    ensureOpen(); assertGuard(guard)
    return result
  }
  function writable(current: Image, baseline: Image, expectedLocal: number, expectedOutbox: number): void {
    if (current.slot.entry !== null) fail('workspace_pending')
    if (current.slot.version !== expectedOutbox || current.working.snapshot.localVersion !== expectedLocal) fail('workspace_conflict')
    if (!ownerSyncOutboxStorage.sameRow(current.slot, baseline.slot) || canonical(current.working) !== canonical(baseline.working)
      || canonical(current.metadata) !== canonical(baseline.metadata) || canonical(current.sync) !== canonical(baseline.sync)
      || current.receiptCount !== baseline.receiptCount) fail('workspace_conflict')
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
  function expectedSyncImage(current: Image, expected: OwnerWorkspaceSyncState): void {
    if (canonical(syncStateOf(current)) !== canonical(expected)) fail('workspace_conflict')
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
    readSyncState(guard) { return bounded(guard, async () => syncStateOf(await readImage(guard))) },
    linkCloudBase(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'expected', 'base'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceLinkCloudRequest(target, { id: input.id, expected: input.expected, base: input.base })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const baseline = await readImage(guard)
      expectedSyncImage(baseline, request.expected)
      const preview = buildOwnerWorkspaceCloudLinkPreview(request.base, baseline.working.snapshot)
      if (preview.issues.length) fail('workspace_conflict')
      const next = snapshot({ ...preview.snapshot, localVersion: increment(baseline.working.snapshot.localVersion) })
      const outboxVersion = increment(baseline.slot.version), epoch = increment(baseline.sync!.epoch)
      const metadata = validateOwnerWorkspaceLocalMetadata({ ...baseline.metadata,
        displayTimes: [...baseline.metadata.displayTimes, ...preview.addedKeys.map(key => ({ key, updated_at: null }))],
        recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
          localVersion: next.localVersion, outboxVersion } }, next)
      // The unchanged watch/holding backup remains exportable; it deliberately
      // excludes sync metadata, credentials, manual assets and pending packets.
      await buildOwnerWorkspaceBackup({ snapshot: next, metadata })
      const sync = validateOwnerWorkspaceSyncMetadata({ ...baseline.sync, epoch, base: preview.base,
        recentReceipt: { id: request.id, hash: request.hash, operation: 'link', syncEpoch: epoch, outboxVersion,
          localVersion: next.localVersion } }, target, { snapshot: next, metadata, outbox: { version: outboxVersion, entry: null } })
      const committed = await image('readwrite', guard, undefined, undefined, (current, stores) => {
        expectedSyncImage(current, request.expected)
        writable(current, baseline, request.expected.local.snapshot.localVersion, request.expected.local.outbox.version)
        const slot = advanceEmptySlot(current, stores), nextWorking = working({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, target)
        stores[WORKING].put(nextWorking, CURRENT); stores[METADATA].put(metadata, CURRENT); stores[SYNC].put(sync, CURRENT)
        return { ...current, slot, working: nextWorking, metadata, sync }
      })
      ensureOpen(); assertGuard(guard); observe(committed)
      return syncStateOf(committed)
    }) },
    prepareCloud(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'expected', 'packet'])
        || !closed(input.packet, ['request', 'rawBody', 'requestHash', 'byteLength'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspacePrepareCloudRequest(target, { id: input.id, expected: input.expected })
      let supplied: BuiltOwnerSyncRequest
      try { supplied = await buildOwnerSyncRequest(input.packet.request) } catch { return fail('workspace_invalid_input') }
      // Re-derive B->L, then bind original bytes. Never let the old candidate
      // rebase an operation against a newer GET or repack this stored request.
      if (request.hash !== input.hash || request.packet.rawBody !== input.packet.rawBody
        || request.packet.requestHash !== input.packet.requestHash || request.packet.byteLength !== input.packet.byteLength
        || supplied.rawBody !== request.packet.rawBody || supplied.requestHash !== request.packet.requestHash) fail('workspace_invalid_input')
      const baseline = await readImage(guard)
      expectedSyncImage(baseline, request.expected)
      const adoption = baseline.metadata.adoption!
      if (request.id === adoption.id) fail('workspace_idempotency_conflict')
      const version = increment(baseline.slot.version), epoch = increment(baseline.sync!.epoch)
      const slot: SlotRow = { resourceFingerprint: target, version,
        entry: { schema: 'owner-sync-outbox-1', state: 'prepared', rawBody: request.packet.rawBody, requestHash: request.packet.requestHash } }
      const sync = validateOwnerWorkspaceSyncMetadata({ ...baseline.sync, epoch,
        pending: { requestId: request.id, requestHash: request.packet.requestHash, rawBody: request.packet.rawBody,
          preparationHash: request.hash, preimageHash: await digest(pendingPreimage(baseline, epoch, version)),
          adoptionId: adoption.id, adoptionHash: adoption.hash, localVersion: baseline.working.snapshot.localVersion,
          preparedOutboxVersion: version, baseRevision: baseline.sync!.base!.pulledRevision } }, target,
      { snapshot: baseline.working.snapshot, metadata: baseline.metadata, outbox: { version, entry: slot.entry } })
      const committed = await image('readwrite', guard, undefined, undefined, (current, stores) => {
        expectedSyncImage(current, request.expected)
        writable(current, baseline, request.expected.local.snapshot.localVersion, request.expected.local.outbox.version)
        stores.slot.put(slot, CURRENT); stores[SYNC].put(sync, CURRENT)
        return { ...current, slot, sync }
      })
      ensureOpen(); assertGuard(guard); observe(committed)
      return syncStateOf(committed)
    }) },
    cancelPreparedCloud(input, guard) { return bounded(guard, async () => {
      if (!closed(input, ['id', 'hash', 'expected', 'requestId', 'requestHash'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceCancelCloudRequest(target, { id: input.id, expected: input.expected,
        requestId: input.requestId, requestHash: input.requestHash })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const baseline = await readImage(guard)
      expectedSyncImage(baseline, request.expected)
      const version = increment(baseline.slot.version), epoch = increment(baseline.sync!.epoch)
      const slot: SlotRow = { resourceFingerprint: target, version, entry: null }
      const sync = validateOwnerWorkspaceSyncMetadata({ ...baseline.sync, epoch, pending: null,
        recentReceipt: { id: request.id, hash: request.hash, operation: 'cancel', syncEpoch: epoch,
          outboxVersion: version, localVersion: baseline.working.snapshot.localVersion } }, target,
      { snapshot: baseline.working.snapshot, metadata: baseline.metadata, outbox: { version, entry: slot.entry } })
      const committed = await image('readwrite', guard, undefined, undefined, (current, stores) => {
        expectedSyncImage(current, request.expected)
        if (canonical(current) !== canonical(baseline)) fail('workspace_conflict')
        stores.slot.put(slot, CURRENT); stores[SYNC].put(sync, CURRENT)
        return { ...current, slot, sync }
      })
      ensureOpen(); assertGuard(guard); observe(committed)
      return syncStateOf(committed)
    }) },
    syncReceipt(id, hash, guard) { return bounded(guard, async () => {
      localId(target, id)
      if (typeof hash !== 'string' || !HASH.test(hash)) fail('workspace_invalid_input')
      const current = await readImage(guard), state = syncStateOf(current)
      const pending = state.sync.pending, receipt = state.sync.recentReceipt
      if (pending?.requestId === id) {
        if (pending.preparationHash !== hash) fail('workspace_idempotency_conflict')
        return Object.freeze({ state: 'matched' as const, value: state })
      }
      if (receipt?.id !== id) return Object.freeze({ state: 'unknown' as const })
      if (receipt.hash !== hash) fail('workspace_idempotency_conflict')
      if (receipt.syncEpoch !== state.sync.epoch || receipt.outboxVersion !== state.local.outbox.version
        || receipt.localVersion !== state.local.snapshot.localVersion) return Object.freeze({ state: 'unknown' as const })
      return Object.freeze({ state: 'matched' as const, value: state })
    }) },
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

function strictProbe(factory: IDBFactory, target: string, baseline: SlotRow, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false, db: IDBDatabase | undefined, tx: IDBTransaction | undefined
    const finish = (problem?: OwnerWorkspaceErrorCode) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort)
      if (problem) { try { tx?.abort() } catch { /* no writes exist in this probe */ } }
      const version = db?.version
      db?.close()
      if (problem) reject(new OwnerWorkspaceError(problem)); else resolve(version!)
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
  const physicalVersion = await strictProbe(factory, target, baseline, signal)
  if (signal.aborted) fail('workspace_timeout')
  if (physicalVersion === 4) return openExistingWorkspace(factory, target, signal)
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
        if (![3, 4].includes(db.version) || !isOwnerSyncOutboxDatabase(db)) { finish('workspace_invalid_database'); return }
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
        if (![3, 4].includes(db.version) || !isOwnerSyncOutboxDatabase(db)) { finish('workspace_invalid_database'); return }
        handle = makeWorkspace(db, target)
        handle.readLocalState({ signal, assertActive() { if (signal.aborted) fail('workspace_timeout') } })
          .then(() => finish(), error => finish(code(error)))
      }
    } catch (error) { finish(code(error)) }
  })
}

/** Explicit upgrade of the original adopted v3 target only. Versionchange and
 * strict initialization are separate commits: an interrupted v4 with no current
 * metadata fails closed on every normal open. There is no automatic repair. */
export async function upgradeOwnerWorkspaceSync(factory: IDBFactory, target: string,
  expectedInput: OwnerWorkspaceLocalState, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspace> {
  localId(target, 'workspace-sync-upgrade')
  const expected = localState(expectedInput, target)
  if (!expected.metadata.adoption || expected.outbox.entry !== null) fail('workspace_pending')
  assertGuard(guard)
  const controller = new AbortController()
  let timedOut = false
  const revoked = () => controller.abort()
  guard.signal.addEventListener('abort', revoked, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, OWNER_SYNC_OUTBOX_TIMEOUT_MS)
  const activeGuard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() {
    if (timedOut) fail('workspace_timeout')
    assertGuard(guard)
  } }
  try {
    const existing = await openExistingWorkspace(factory, target, controller.signal)
    try {
      const current = await existing.readLocalState(activeGuard)
      if (canonical(current) !== canonical(expected)) fail('workspace_conflict')
    } finally { existing.close() }
    const version = await strictProbe(factory, target, { ...expected.outbox, resourceFingerprint: target }, controller.signal)
    if (version !== 3) fail('workspace_invalid_database')
    assertGuard(activeGuard)
    return await new Promise<OwnerWorkspace>((resolve, reject) => {
      let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, handle: OwnerWorkspace | undefined, settled = false
      const finish = (problem?: OwnerWorkspaceErrorCode) => {
        if (settled) return
        if (!problem) { try { assertGuard(activeGuard) } catch (error) { problem = code(error) } }
        settled = true; controller.signal.removeEventListener('abort', abort)
        if (problem) {
          try { tx?.abort() } catch { /* a completed versionchange remains visible */ }
          handle?.close(); db?.close(); reject(new OwnerWorkspaceError(problem))
        } else resolve(handle!)
      }
      const abort = () => finish(timedOut ? 'workspace_timeout' : 'workspace_context_changed')
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) { abort(); return }
      const readExpected = (transaction: IDBTransaction, accept: () => void) => {
        try {
          assertGuard(activeGuard)
          for (const name of STORES) {
            const store = transaction.objectStore(name)
            if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
          }
          const stores = Object.fromEntries(STORES.map(name => [name, transaction.objectStore(name)]))
          const reads = [stores.slot.get(CURRENT), stores.slot.count(), stores[WORKING].get(CURRENT), stores[WORKING].count(),
            stores[METADATA].get(CURRENT), stores[METADATA].count(), stores[RECEIPTS].count()]
          let remaining = reads.length
          for (const read of reads) read.onsuccess = () => {
            if (--remaining !== 0 || settled) return
            try {
              assertGuard(activeGuard)
              if (reads[1].result !== 1 || reads[3].result !== 1 || reads[5].result !== 1) fail('workspace_invalid_database')
              const state = working(reads[2].result, target).snapshot
              const current = localState({ snapshot: state, metadata: checkedMetadata(reads[4].result, state),
                outbox: (() => { const slot = ownerSyncOutboxStorage.rowShape(reads[0].result, target)
                  return { version: slot.version, entry: slot.entry } })(), receiptCount: reads[6].result }, target)
              if (canonical(current) !== canonical(expected)) fail('workspace_conflict')
              accept()
            } catch (error) { finish(code(error)) }
          }
        } catch (error) { finish(code(error)) }
      }
      try {
        assertGuard(activeGuard)
        const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target, 4)
        request.onblocked = () => finish('workspace_blocked')
        request.onerror = () => finish('workspace_invalid_database')
        request.onupgradeneeded = event => {
          db = request.result; tx = request.transaction!
          if (settled || event.oldVersion !== 3 || db.objectStoreNames.length !== STORES.length
            || !STORES.every(name => db!.objectStoreNames.contains(name))) {
            try { tx.abort() } catch { /* rejection remains fixed */ }; finish('workspace_invalid_database'); return
          }
          readExpected(tx, () => { db!.createObjectStore(SYNC) })
        }
        request.onsuccess = () => {
          db = request.result
          if (settled) { db.close(); return }
          db.onversionchange = () => finish('workspace_closed')
          try {
            assertGuard(activeGuard)
            if (db.version !== 4 || !isOwnerSyncOutboxDatabase(db)) fail('workspace_invalid_database')
            tx = db.transaction([...STORES, SYNC], 'readwrite', { durability: 'strict' })
            if (tx.durability !== 'strict') fail('workspace_unavailable')
            const store = tx.objectStore(SYNC)
            if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
            // Do not repair another tab's already initialized/incomplete state.
            const count = store.count()
            count.onsuccess = () => {
              if (settled) return
              if (count.result !== 0) { finish('workspace_invalid_database'); return }
              readExpected(tx!, () => store.add(emptyOwnerWorkspaceSyncMetadata(target), CURRENT))
            }
            tx.onerror = () => finish(code(tx?.error, 'workspace_aborted'))
            tx.onabort = () => finish(code(tx?.error, 'workspace_aborted'))
            tx.oncomplete = () => {
              if (settled) { db?.close(); return }
              handle = makeWorkspace(db!, target)
              handle.readSyncState(activeGuard).then(() => finish(), error => finish(code(error)))
            }
          } catch (error) { finish(code(error)) }
        }
      } catch (error) { finish(code(error)) }
    })
  } catch (error) { throw new OwnerWorkspaceError(timedOut ? 'workspace_timeout' : code(error)) }
  finally { clearTimeout(timer); guard.signal.removeEventListener('abort', revoked) }
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
