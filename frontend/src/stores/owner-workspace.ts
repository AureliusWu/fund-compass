/** Local IDB authority; v4 code loads explicitly before transactions. No implicit HTTP/credential IO. */
import {
  canonicalOwnerCloudImportPlan, canonicalOwnerWorkspaceEntries,
  validateOwnerCloudImportPlan, validateOwnerWorkspaceEntries, validateOwnerWorkspaceLegacy, validateOwnerWorkspaceSnapshot,
  type OwnerWorkspaceEntry, type OwnerWorkspaceLegacy, type OwnerWorkspaceSnapshot,
} from '@/utils/owner-cloud-import'
import { openOwnerSyncOutbox, ownerSyncOutboxStorage, isOwnerSyncOutboxDatabase,
  OWNER_SYNC_OUTBOX_DB_PREFIX, OWNER_SYNC_OUTBOX_TIMEOUT_MS } from './ownerSyncOutbox'
import { validateHolding, type HoldingInput } from '@/utils/holding-editor'
import { normalizeOwnerSyncKey } from '@/utils/ownerSyncContract'
import {
  validateOwnerWorkspaceLocalMetadata, emptyOwnerWorkspaceLocalMetadata, validateOwnerWorkspaceSourceArchive,
  decodeOwnerWorkspaceSourceArchive, buildOwnerLegacyWorkspaceBackup, buildOwnerWorkspaceBackup, validateOwnerWorkspaceBackup,
  previewOwnerWorkspaceRestore, canonicalOwnerLocal, OWNER_WORKSPACE_MAX_ARCHIVES, OWNER_WORKSPACE_BACKUP_MAX_BYTES,
  type OwnerWorkspaceLocalMetadata,
} from '@/utils/owner-workspace-backup'
import type { OwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'
import {
  WORKING, RECEIPTS, METADATA, CURRENT, STORES, SYNC, PORTFOLIO, FULL_SYNC, SCHEMA, RECEIPT_SCHEMA, HASH, ID, MAX_RECEIPTS,
  OwnerWorkspaceError, fail, code, closed, counter, increment, canonical, digest, assertGuard, localId,
} from './owner-workspace-shared'
import type {
  OwnerWorkspaceGuard, OwnerWorkspaceErrorCode, OwnerWorkspaceImportRequest, OwnerWorkspaceRollbackRequest,
  OwnerWorkspaceReceipt, OwnerWorkspaceLocalState, OwnerWorkspaceLocalCommand, OwnerWorkspaceAdoptLocalRequest,
  OwnerWorkspaceEditLocalRequest, OwnerWorkspaceRestoreLocalRequest, OwnerWorkspaceSyncState,
  OwnerWorkspaceLinkCloudRequest, OwnerWorkspacePrepareCloudRequest, OwnerWorkspaceCancelCloudRequest,
  OwnerWorkspace, WorkingRow, StoredReceipt, SlotRow, Image, CloudWorkspaceHost, OwnerWorkspaceEditPortfolioRequest,
  OwnerWorkspaceFullSyncState, OwnerWorkspaceFullSyncLinkRequest,
  OwnerWorkspaceFullSyncPrepareRequest, OwnerWorkspaceFullSyncCancelRequest, OwnerWorkspaceFullSyncDeliveryRequest,
  OwnerWorkspaceFullSyncAckInput, OwnerWorkspaceFullSyncAckRequest,
  FullSyncWorkspaceHost, FullSyncPostimage, FullSyncLinkPostimage, FullSyncCommitMode,
} from './owner-workspace-types'
import type { OwnerPortfolioLocal } from '@/utils/ownerPortfolioLocal'
import type { OwnerPortfolioUpgradeIntent } from '@/utils/owner-portfolio-upgrade-intent'
import type { OwnerPortfolioSyncMetadata } from '@/utils/owner-portfolio-sync'
import type { OwnerPortfolioSyncUpgradeIntent } from '@/utils/owner-portfolio-sync-intent'
import { copyOwnerFullSyncInput } from '@/utils/owner-full-sync-input'
import type { OwnerWorkspaceFullSyncUpgradeRequest } from './owner-workspace-full-sync-upgrade'
import type { OwnerWorkspacePortfolioUpgradeRequest, OwnerWorkspacePortfolioUpgradeSource } from './owner-workspace-portfolio-upgrade'
export type * from './owner-workspace-types'
export { OwnerWorkspaceError } from './owner-workspace-shared'
type SyncCodec = typeof import('@/utils/owner-workspace-sync-codec')
type CloudCommands = typeof import('./owner-workspace-cloud')
type FullSyncCommands = typeof import('./owner-workspace-full-sync-commands')
type FullSyncCommandName = 'prepareFullSync' | 'cancelPreparedFullSync' | 'transitionFullSyncDelivery' | 'ackFullSync' | 'linkFullSyncBase'
type PortfolioCodec = typeof import('@/utils/ownerPortfolioLocal') & typeof import('@/utils/owner-portfolio-upgrade-intent')
type FullSyncCodec = typeof import('@/utils/owner-portfolio-sync') & typeof import('@/utils/owner-portfolio-sync-intent')
let syncCodecPromise: Promise<SyncCodec> | null = null, cloudCommandsPromise: Promise<CloudCommands> | null = null
let portfolioCodecPromise: Promise<PortfolioCodec> | null = null
let fullSyncCodecPromise: Promise<FullSyncCodec> | null = null
let fullSyncCommandsPromise: Promise<FullSyncCommands> | null = null
function loadFullSyncCodec(): Promise<FullSyncCodec> {
  return fullSyncCodecPromise ??= Promise.all([import('@/utils/owner-portfolio-sync'), import('@/utils/owner-portfolio-sync-intent')])
    .then(([sync, intent]) => ({ ...sync, ...intent })).catch(() => fail('workspace_unavailable'))
}
function loadPortfolioCodec(): Promise<PortfolioCodec> {
  return portfolioCodecPromise ??= Promise.all([import('@/utils/ownerPortfolioLocal'), import('@/utils/owner-portfolio-upgrade-intent')])
    .then(([portfolio, intent]) => ({ ...portfolio, ...intent })).catch(() => fail('workspace_unavailable'))
}
function loadSyncCodec(): Promise<SyncCodec> {
  return syncCodecPromise ??= import('@/utils/owner-workspace-sync-codec').catch(() => fail('workspace_unavailable'))
}
function loadCloudCommands(): Promise<CloudCommands> {
  return cloudCommandsPromise ??= import('./owner-workspace-cloud').catch(() => fail('workspace_unavailable'))
}
function loadFullSyncCommands(): Promise<FullSyncCommands> {
  return fullSyncCommandsPromise ??= import('./owner-workspace-full-sync-commands').catch(() => fail('workspace_unavailable'))
}
function waitForImport<T>(pending: Promise<T>, signal: AbortSignal, problem: () => OwnerWorkspaceErrorCode): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value?: T, error?: unknown) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort)
      if (error !== undefined) reject(error); else resolve(value!)
    }
    const abort = () => finish(undefined, new OwnerWorkspaceError(problem()))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    pending.then(value => finish(value), error => finish(undefined, error))
  })
}
/** No business state/cache is held here, only a fixed code-module promise. */
function timedImport<T>(pending: Promise<T>): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), OWNER_SYNC_OUTBOX_TIMEOUT_MS)
  return waitForImport(pending, controller.signal, () => 'workspace_timeout').finally(() => clearTimeout(timer))
}
function timedOwnedCall<T>(input: unknown, work: (owned: unknown) => Promise<T>): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), OWNER_SYNC_OUTBOX_TIMEOUT_MS)
  try {
    const owned = copyOwnerFullSyncInput(input)
    return waitForImport(work(owned), controller.signal, () => 'workspace_timeout').finally(() => clearTimeout(timer))
  } catch (error) { clearTimeout(timer); return Promise.reject(new OwnerWorkspaceError(code(error, 'workspace_invalid_input'))) }
}
async function stateCodec(value: unknown): Promise<SyncCodec | null> {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'sync')
    ? timedImport(loadSyncCodec()) : null
}
type CloudBuilderName = 'buildOwnerWorkspaceLinkCloudRequest' | 'buildOwnerWorkspacePrepareCloudRequest' | 'buildOwnerWorkspaceCancelCloudRequest'
function lazyBuild<T>(name: CloudBuilderName, target: string, input: unknown): Promise<T> {
  return timedImport((async () => {
    const [commands, codec] = await Promise.all([loadCloudCommands(), loadSyncCodec()])
    const build = commands[name] as (target: string, input: unknown, validate: (value: unknown) => OwnerWorkspaceLocalState) => Promise<T>
    return build(target, input, value => localState(value, target, codec))
  })())
}
export async function buildOwnerWorkspaceLinkCloudRequest(target: string,
  input: Omit<OwnerWorkspaceLinkCloudRequest, 'hash'>): Promise<OwnerWorkspaceLinkCloudRequest> {
  return lazyBuild('buildOwnerWorkspaceLinkCloudRequest', target, input)
}
export async function buildOwnerWorkspacePrepareCloudRequest(target: string,
  input: Pick<OwnerWorkspacePrepareCloudRequest, 'id' | 'expected'>): Promise<OwnerWorkspacePrepareCloudRequest> {
  return lazyBuild('buildOwnerWorkspacePrepareCloudRequest', target, input)
}
export async function buildOwnerWorkspaceCancelCloudRequest(target: string,
  input: Omit<OwnerWorkspaceCancelCloudRequest, 'hash'>): Promise<OwnerWorkspaceCancelCloudRequest> {
  return lazyBuild('buildOwnerWorkspaceCancelCloudRequest', target, input)
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
async function verifyReceipt(value: StoredReceipt): Promise<void> {
  if (await digest(canonical(value.before)) !== value.receipt.preimageHash
      || await digest(canonical(value.after)) !== value.receipt.postimageHash) fail('workspace_invalid_database')
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

function localState(value: unknown, target: string, codec: SyncCodec | null = null, portfolioCodec: PortfolioCodec | null = null,
  fullCodec: FullSyncCodec | null = null): OwnerWorkspaceLocalState {
  const hasSync = !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'sync')
  const hasPortfolio = !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'portfolio')
  const hasFullSync = !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'fullSync')
  if (!closed(value, ['snapshot', 'outbox', 'metadata', 'receiptCount', ...(hasSync ? ['sync'] : []), ...(hasPortfolio ? ['portfolio', 'portfolioUpgrade'] : []),
    ...(hasFullSync ? ['fullSync', 'fullSyncUpgrade'] : [])])
    || !closed(value.outbox, ['version', 'entry'])) fail('workspace_invalid_input')
  if (value.outbox.entry !== null && !closed(value.outbox.entry, ['schema', 'state', 'rawBody', 'requestHash'])) fail('workspace_invalid_input')
  const copy = snapshot(value.snapshot), slot = ownerSyncOutboxStorage.rowShape({ ...value.outbox, resourceFingerprint: target }, target)
  const receiptCount = counter(value.receiptCount)
  if (receiptCount > MAX_RECEIPTS) fail('workspace_invalid_input')
  const metadata = validateOwnerWorkspaceLocalMetadata(value.metadata, copy)
  if (hasSync && !codec) fail('workspace_invalid_input')
  const sync = hasSync ? codec!.validateOwnerWorkspaceSyncMetadata(value.sync, target, { snapshot: copy, metadata,
    outbox: { version: slot.version, entry: hasFullSync ? null : slot.entry } }) : null
  if (hasPortfolio && (!sync || !portfolioCodec)) fail('workspace_invalid_input')
  const portfolio = hasPortfolio ? portfolioCodec!.validateOwnerPortfolioLocal(value.portfolio) : null
  const portfolioUpgrade = portfolio ? portfolioCodec!.validateOwnerPortfolioUpgradeIntent(value.portfolioUpgrade, target, portfolio.migration.sourceSha256) : null
  if (portfolio && (slot.entry !== null && !hasFullSync || sync?.pending !== null || !metadata.adoption || receiptCount !== 0)) fail('workspace_invalid_input')
  if (hasFullSync && (!portfolio || !sync || !fullCodec)) fail('workspace_invalid_input')
  const fullSync = hasFullSync ? fullCodec!.validateOwnerPortfolioSyncMetadata(value.fullSync, target,
    { snapshot: copy, metadata, outbox: { version: slot.version, entry: slot.entry } }) : null
  const fullSyncUpgrade = fullSync ? fullCodec!.validateOwnerPortfolioSyncUpgradeIntent(value.fullSyncUpgrade, target) : null
  if (fullSync?.base && portfolio) {
    const keys = new Set([...copy.entries.map(row => row.key), ...portfolio.manual.map(row => row.key)])
    if (fullSync.base.records.some(row => !keys.has(row.key))) fail('workspace_invalid_input')
  }
  const result = Object.freeze({ snapshot: copy, outbox: Object.freeze({ version: slot.version, entry: slot.entry }),
    metadata, receiptCount, ...(sync ? { sync } : {}), ...(portfolio ? { portfolio, portfolioUpgrade: portfolioUpgrade! } : {}),
    ...(fullSync ? { fullSync, fullSyncUpgrade: fullSyncUpgrade! } : {}) })
  assertPortfolioRecoveryCapacity(target, result)
  return result
}
/** The same complete envelope is used by v5 export. Capacity is a whole-image
 * limit, including escaped original raw sources, not separate per-store caps. */
function assertPortfolioRecoveryCapacity(target: string, state: OwnerWorkspaceLocalState): void {
  if (!state.portfolio) return
  const raw = canonicalOwnerLocal({ format: state.fullSync ? 'sinan-owner-workspace-recovery-3' : 'sinan-owner-workspace-recovery-2',
    physicalVersion: state.fullSync ? 6 : 5, targetFingerprint: target, local: state })
  if (raw.length > OWNER_WORKSPACE_BACKUP_MAX_BYTES || new TextEncoder().encode(raw).byteLength > OWNER_WORKSPACE_BACKUP_MAX_BYTES) fail('workspace_capacity')
}
/** Pure full-image validation for explicit recovery files, never an IDB open.
 * Pending packets retain their original bytes and must pass the same hashes as
 * a normal v4 reopen. Callers cannot provide an alternative codec. */
export async function validateOwnerWorkspaceLocalState(target: string, input: unknown): Promise<OwnerWorkspaceLocalState> {
  localId(target, 'workspace-image-validation')
  const codec = await stateCodec(input)
  const portfolioCodec = input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'portfolio') ? await timedImport(loadPortfolioCodec()) : null
  const fullCodec = input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'fullSync') ? await timedImport(loadFullSyncCodec()) : null
  const copy = localState(input, target, codec, portfolioCodec, fullCodec)
  if (copy.portfolio) {
    await portfolioCodec!.verifyOwnerPortfolioMigration(copy.portfolio)
    await portfolioCodec!.verifyOwnerPortfolioUpgradeIntent(copy.portfolioUpgrade, target, copy.portfolio.migration.sourceSha256)
  }
  if (copy.fullSync) await fullCodec!.verifyOwnerPortfolioSyncUpgradeIntent(copy.fullSyncUpgrade, target)
  if (copy.fullSync?.pending) {
    const pending = await timedImport(import('@/utils/owner-portfolio-pending'))
    await pending.verifyOwnerPortfolioPending({ slot: { ...copy.outbox, resourceFingerprint: target },
      working: { schema: SCHEMA, targetFingerprint: target, snapshot: copy.snapshot }, metadata: copy.metadata,
      receiptCount: copy.receiptCount, sync: copy.sync ?? null, portfolio: copy.portfolio, portfolioUpgrade: copy.portfolioUpgrade,
      fullSync: copy.fullSync, fullSyncUpgrade: copy.fullSyncUpgrade, receipt: null, original: null }, target,
    value => localState(value, target, codec, portfolioCodec, fullCodec))
  }
  if (copy.sync && codec) await codec.verifyPending({
    slot: { ...copy.outbox, resourceFingerprint: target },
    working: { schema: SCHEMA, targetFingerprint: target, snapshot: copy.snapshot },
    metadata: copy.metadata, sync: copy.sync, receiptCount: copy.receiptCount, receipt: null, original: null, portfolio: copy.portfolio, portfolioUpgrade: copy.portfolioUpgrade,
  }, target, value => localState(value, target, codec, portfolioCodec, fullCodec))
  return copy
}
function stateOf(image: Image): OwnerWorkspaceLocalState {
  return Object.freeze({ snapshot: image.working.snapshot, outbox: Object.freeze({ version: image.slot.version, entry: image.slot.entry }),
    metadata: image.metadata, receiptCount: image.receiptCount, ...(image.sync ? { sync: image.sync } : {}),
    ...(image.portfolio ? { portfolio: image.portfolio, portfolioUpgrade: image.portfolioUpgrade! } : {}),
    ...(image.fullSync ? { fullSync: image.fullSync, fullSyncUpgrade: image.fullSyncUpgrade! } : {}) })
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
export async function buildOwnerWorkspaceAdoptLocalRequest(target: string, input: Omit<OwnerWorkspaceAdoptLocalRequest, 'hash'>): Promise<OwnerWorkspaceAdoptLocalRequest> {
  if (!closed(input, ['id', 'expected', 'sourceArchive', 'backupSha256'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const codec = await stateCodec(input.expected)
  if (typeof input.backupSha256 !== 'string' || !HASH.test(input.backupSha256)) fail('workspace_invalid_input')
  const copy = { id: input.id, expected: localState(input.expected, target, codec), sourceArchive: validateOwnerWorkspaceSourceArchive(input.sourceArchive), backupSha256: input.backupSha256 }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'local-adopt-1', target, ...copy })) })
}
export async function buildOwnerWorkspaceEditLocalRequest(target: string, input: Omit<OwnerWorkspaceEditLocalRequest, 'hash'>): Promise<OwnerWorkspaceEditLocalRequest> {
  if (!closed(input, ['id', 'expected', 'command'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const copy = { id: input.id, expected: await validateOwnerWorkspaceLocalState(target, input.expected), command: command(input.command) }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'local-edit-1', target, ...copy })) })
}
export async function buildOwnerWorkspaceEditPortfolioRequest(target: string,
  input: Omit<OwnerWorkspaceEditPortfolioRequest, 'hash'>): Promise<OwnerWorkspaceEditPortfolioRequest> {
  if (!closed(input, ['id', 'expected', 'command'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const expected = await validateOwnerWorkspaceLocalState(target, input.expected)
  const portfolioCodec = await timedImport(loadPortfolioCodec())
  if (!expected.portfolio || !expected.sync || expected.outbox.entry !== null) fail('workspace_pending')
  const command = portfolioCodec.validateOwnerPortfolioCommand(input.command)
  // Validate the complete postimage before binding any caller data.
  portfolioCodec.applyOwnerPortfolioCommand(expected.portfolio, command)
  const copy = { id: input.id, expected, command }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'portfolio-edit-1', target, ...copy })) })
}
export async function buildOwnerWorkspaceRestoreLocalRequest(target: string, input: Omit<OwnerWorkspaceRestoreLocalRequest, 'hash'>): Promise<OwnerWorkspaceRestoreLocalRequest> {
  if (!closed(input, ['id', 'expected', 'backup'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const copy = { id: input.id, expected: await validateOwnerWorkspaceLocalState(target, input.expected), backup: await validateOwnerWorkspaceBackup(input.backup) }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'local-restore-1', target, ...copy })) })
}

function syncStateOf(image: Image): OwnerWorkspaceSyncState {
  // v5 cloud packets need the full manual-asset intent/ACK profile. Until that
  // profile is wired, never use the old fund-only planner and silently omit it.
  if (!image.sync || image.portfolio) fail('workspace_invalid_database')
  return Object.freeze({ local: stateOf(image), sync: image.sync })
}
function fullSyncStateOf(image: Image): OwnerWorkspaceFullSyncState {
  if (!image.fullSync || !image.fullSyncUpgrade || !image.portfolio) fail('workspace_invalid_database')
  return Object.freeze({ local: stateOf(image), fullSync: image.fullSync })
}
// Excludes mutable delivery state, but binds every local row/archive/receipt
// count and the exact complete common base. Hashes are not source authentication.
function makeWorkspace(db: IDBDatabase, target: string, codec: SyncCodec | null = null,
  portfolioCodec: PortfolioCodec | null = null, fullCodec: FullSyncCodec | null = null): OwnerWorkspace {
  if (db.version >= 4 && !codec || db.version >= 5 && !portfolioCodec || db.version === 6 && !fullCodec) fail('workspace_invalid_database')
  const storesForVersion = db.version === 6 ? [...STORES, SYNC, PORTFOLIO, FULL_SYNC]
    : db.version === 5 ? [...STORES, SYNC, PORTFOLIO] : db.version === 4 ? [...STORES, SYNC] : STORES
  let closedHandle = false
  const inFlight = new Set<(value: OwnerWorkspaceErrorCode) => void>()
  let observedLocal: OwnerWorkspaceSnapshot | null = null, observedSlot: SlotRow | null = null
  let observedMetadata: OwnerWorkspaceLocalMetadata | null = null
  let observedSync: OwnerWorkspaceSyncMetadata | null = null
  let observedPortfolio: OwnerPortfolioLocal | null = null
  let observedPortfolioUpgrade: OwnerPortfolioUpgradeIntent | null = null
  let observedFullSync: OwnerPortfolioSyncMetadata | null = null, observedFullSyncUpgrade: OwnerPortfolioSyncUpgradeIntent | null = null
  const ensureOpen = () => { if (closedHandle) fail('workspace_closed') }
  const close = () => {
    if (closedHandle) return
    closedHandle = true
    observedLocal = null; observedSlot = null; observedMetadata = null; observedSync = null; observedPortfolio = null; observedPortfolioUpgrade = null
    observedFullSync = null; observedFullSyncUpgrade = null
    for (const cancel of [...inFlight]) cancel('workspace_closed')
    try { db.close() } catch { /* disposal has no driver details */ }
  }
  db.onversionchange = close
  db.onclose = close
  function observe(image: Image): void {
    const next = image.working.snapshot
    if (observedLocal && (next.localVersion < observedLocal.localVersion
        || (next.localVersion === observedLocal.localVersion && (canonical(next) !== canonical(observedLocal)
          || canonical(image.metadata) !== canonical(observedMetadata)
          || canonical(image.portfolio ?? null) !== canonical(observedPortfolio))))) fail('workspace_invalid_database')
    if (observedSlot && (image.slot.version < observedSlot.version
        || (image.slot.version === observedSlot.version && !ownerSyncOutboxStorage.sameRow(image.slot, observedSlot)))) fail('workspace_invalid_database')
    if (observedSync && (!image.sync || image.sync.epoch < observedSync.epoch
        || image.sync.epoch === observedSync.epoch && canonical(image.sync) !== canonical(observedSync))) fail('workspace_invalid_database')
    if (observedPortfolioUpgrade && canonical(image.portfolioUpgrade) !== canonical(observedPortfolioUpgrade)) fail('workspace_invalid_database')
    if (observedFullSync && (!image.fullSync || image.fullSync.epoch < observedFullSync.epoch
      || image.fullSync.epoch === observedFullSync.epoch && canonical(image.fullSync) !== canonical(observedFullSync))) fail('workspace_invalid_database')
    if (observedFullSyncUpgrade && canonical(image.fullSyncUpgrade) !== canonical(observedFullSyncUpgrade)) fail('workspace_invalid_database')
    if (db.version === 6 && observedSync && canonical(image.sync) !== canonical(observedSync)) fail('workspace_invalid_database')
    observedLocal = next; observedSlot = image.slot; observedMetadata = image.metadata; observedSync = image.sync
    observedPortfolio = image.portfolio ?? null
    observedPortfolioUpgrade = image.portfolioUpgrade ?? null
    observedFullSync = image.fullSync ?? null; observedFullSyncUpgrade = image.fullSyncUpgrade ?? null
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
        ...(db.version >= 4 ? { sync: stores[SYNC].get(CURRENT), syncs: stores[SYNC].count() } : {}),
        ...(db.version >= 5 ? { portfolio: stores[PORTFOLIO].get(CURRENT), portfolios: stores[PORTFOLIO].count(), portfolioUpgrade: stores[PORTFOLIO].get('intent') } : {}),
        ...(db.version === 6 ? { fullSync: stores[FULL_SYNC].get(CURRENT), fullSyncs: stores[FULL_SYNC].count(), fullSyncUpgrade: stores[FULL_SYNC].get('intent') } : {}),
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
          if (db.version >= 4 && requests.syncs.result !== 1) fail('workspace_invalid_database')
          let sync: OwnerWorkspaceSyncMetadata | null = null
          if (db.version >= 4) {
            try { sync = codec!.validateOwnerWorkspaceSyncMetadata(requests.sync.result, target, { snapshot: currentWorking.snapshot, metadata,
              outbox: { version: slot.version, entry: db.version === 6 ? null : slot.entry } }) }
            catch { fail('workspace_invalid_database') }
          }
          let portfolio: OwnerPortfolioLocal | null = null
          let portfolioUpgrade: OwnerPortfolioUpgradeIntent | null = null
          if (db.version >= 5) {
            const row = requests.portfolio.result
            if (requests.portfolios.result !== 2 || !closed(row, ['schema', 'targetFingerprint', 'portfolio'])
              || row.schema !== 'owner-workspace-portfolio-1' || row.targetFingerprint !== target) fail('workspace_invalid_database')
            try {
              portfolio = portfolioCodec!.validateOwnerPortfolioLocal(row.portfolio)
              portfolioUpgrade = portfolioCodec!.validateOwnerPortfolioUpgradeIntent(requests.portfolioUpgrade.result, target, portfolio.migration.sourceSha256)
              if (slot.entry !== null && db.version !== 6 || sync?.pending !== null || !metadata.adoption || requests.receipts.result !== 0) fail('workspace_invalid_database')
            } catch { fail('workspace_invalid_database') }
          }
          let fullSync: OwnerPortfolioSyncMetadata | null = null, fullSyncUpgrade: OwnerPortfolioSyncUpgradeIntent | null = null
          if (db.version === 6) {
            if (requests.fullSyncs.result !== 2) fail('workspace_invalid_database')
            try {
              fullSync = fullCodec!.validateOwnerPortfolioSyncMetadata(requests.fullSync.result, target,
                { snapshot: currentWorking.snapshot, metadata, outbox: { version: slot.version, entry: slot.entry } })
              fullSyncUpgrade = fullCodec!.validateOwnerPortfolioSyncUpgradeIntent(requests.fullSyncUpgrade.result, target)
              if (fullSync.base) {
                const keys = new Set([...currentWorking.snapshot.entries.map(row => row.key), ...portfolio!.manual.map(row => row.key)])
                if (fullSync.base.records.some(row => !keys.has(row.key))) fail('workspace_invalid_database')
              }
            } catch { fail('workspace_invalid_database') }
          }
          let current: Image = { slot, working: currentWorking, sync,
            metadata, portfolio, portfolioUpgrade, fullSync, fullSyncUpgrade,
            receipt: id && requests.receipt.result !== undefined ? storedReceipt(requests.receipt.result, target) : null,
            original: originalId && requests.original.result !== undefined ? storedReceipt(requests.original.result, target) : null,
            receiptCount: requests.receipts.result }
          observe(current)
          assertPortfolioRecoveryCapacity(target, stateOf(current))
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
    if (result.portfolio) {
      await portfolioCodec!.verifyOwnerPortfolioMigration(result.portfolio)
      await portfolioCodec!.verifyOwnerPortfolioUpgradeIntent(result.portfolioUpgrade, target, result.portfolio.migration.sourceSha256)
    }
    if (result.fullSync) await fullCodec!.verifyOwnerPortfolioSyncUpgradeIntent(result.fullSyncUpgrade, target)
    if (result.fullSync?.pending) {
      const pending = await import('@/utils/owner-portfolio-pending')
      await pending.verifyOwnerPortfolioPending(result, target, value => localState(value, target, codec, portfolioCodec, fullCodec))
    }
    await ownerSyncOutboxStorage.validateEntry(result.slot.entry, 'outbox_invalid_database')
    if (result.sync?.pending) await codec!.verifyPending(result, target, value => localState(value, target, codec, portfolioCodec, fullCodec))

    for (const receipt of [result.receipt, result.original]) if (receipt) await verifyReceipt(receipt)
    ensureOpen(); assertGuard(guard)
    return result
  }
  function writable(current: Image, baseline: Image, expectedLocal: number, expectedOutbox: number): void {
    if (current.slot.entry !== null) fail('workspace_pending')
    if (current.slot.version !== expectedOutbox || current.working.snapshot.localVersion !== expectedLocal) fail('workspace_conflict')
    if (!ownerSyncOutboxStorage.sameRow(current.slot, baseline.slot) || canonical(current.working) !== canonical(baseline.working)
      || canonical(current.metadata) !== canonical(baseline.metadata) || canonical(current.sync) !== canonical(baseline.sync)
      || canonical(current.portfolio ?? null) !== canonical(baseline.portfolio ?? null)
      || canonical(current.portfolioUpgrade ?? null) !== canonical(baseline.portfolioUpgrade ?? null)
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
  function matchingLocal(image: Image, id: string, hash: string): boolean {
    const receipt = image.metadata.recentEdit
    if (receipt?.id !== id) return false
    if (receipt.hash !== hash) fail('workspace_idempotency_conflict')
    return receipt.localVersion === image.working.snapshot.localVersion && receipt.outboxVersion === image.slot.version
  }
  async function commitLocal(baseline: Image, expected: OwnerWorkspaceLocalState, next: OwnerWorkspaceSnapshot,
    metadata: OwnerWorkspaceLocalMetadata, guard: OwnerWorkspaceGuard,
    portfolio: OwnerPortfolioLocal | null = baseline.portfolio ?? null): Promise<OwnerWorkspaceLocalState> {
    // Refuse a state which cannot be exported under the same complete UTF-8
    // budget, including escaped raw archives. Never discard older archives.
    await buildOwnerWorkspaceBackup({ snapshot: next, metadata })
    if (portfolio) await portfolioCodec!.verifyOwnerPortfolioMigration(portfolio)
    assertPortfolioRecoveryCapacity(target, { ...stateOf(baseline), snapshot: next, metadata,
      outbox: { version: increment(baseline.slot.version), entry: null }, ...(portfolio ? { portfolio } : {}) })
    ensureOpen(); assertGuard(guard)
    const committed = await image('readwrite', guard, undefined, undefined, (current, stores) => {
      expectedImage(current, expected)
      writable(current, baseline, expected.snapshot.localVersion, expected.outbox.version)
      const slot = advanceEmptySlot(current, stores)
      const nextWorking = working({ schema: SCHEMA, targetFingerprint: target, snapshot: next }, target)
      const nextMetadata = validateOwnerWorkspaceLocalMetadata(metadata, next)
      if (portfolio) {
        const value = portfolioCodec!.validateOwnerPortfolioLocal(portfolio)
        stores[PORTFOLIO].put({ schema: 'owner-workspace-portfolio-1', targetFingerprint: target, portfolio: value }, CURRENT)
      }
      stores[WORKING].put(nextWorking, CURRENT); stores[METADATA].put(nextMetadata, CURRENT)
      return { ...current, slot, working: nextWorking, metadata: nextMetadata, portfolio }
    })
    ensureOpen(); assertGuard(guard); observe(committed)
    return stateOf(committed)
  }
  async function commitFull(expected: OwnerWorkspaceFullSyncState, baseline: Image, post: FullSyncPostimage,
    mode: FullSyncCommitMode, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
    if (db.version !== 6 || !fullCodec) fail('workspace_invalid_database')
    // The same fixed module was loaded by the explicit public entry. Resolve
    // it before any transaction; only its synchronous invariant runs inside.
    const commands = await loadFullSyncCommands()
    ensureOpen(); assertGuard(guard)
    // Crypto and full export capacity finish outside the strict transaction.
    const local = await validateOwnerWorkspaceLocalState(target, { ...stateOf(baseline), ...post })
    ensureOpen(); assertGuard(guard)
    const committed = await image('readwrite', guard, undefined, undefined, (current, stores) => {
      if (canonical(fullSyncStateOf(current)) !== canonical(expected) || canonical(current) !== canonical(baseline)
        || post.outbox.version !== increment(current.slot.version)) fail('workspace_conflict')
      commands.assertFullSyncTransition(current, post, mode)
      const checked = localState(local, target, codec, portfolioCodec, fullCodec)
      const slot = ownerSyncOutboxStorage.rowShape({ ...checked.outbox, resourceFingerprint: target }, target)
      const workingRow: WorkingRow = { schema: SCHEMA, targetFingerprint: target, snapshot: checked.snapshot }
      stores.slot.put(slot, CURRENT)
      if (post.snapshot !== undefined) stores[WORKING].put(workingRow, CURRENT)
      if (post.metadata !== undefined) stores[METADATA].put(checked.metadata, CURRENT)
      if (post.portfolio !== undefined) stores[PORTFOLIO].put({ schema: 'owner-workspace-portfolio-1', targetFingerprint: target, portfolio: checked.portfolio }, CURRENT)
      if (mode !== 'delivery') stores[FULL_SYNC].put(checked.fullSync, CURRENT)
      return { ...current, slot, working: workingRow, metadata: checked.metadata,
        portfolio: checked.portfolio!, fullSync: checked.fullSync! }
    })
    ensureOpen(); assertGuard(guard); observe(committed)
    return fullSyncStateOf(committed)
  }
  async function commitFullLink(expected: OwnerWorkspaceFullSyncState, baseline: Image, proposed: FullSyncLinkPostimage,
    guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
    if (db.version !== 6 || !fullCodec) fail('workspace_invalid_database')
    const post = await validateOwnerWorkspaceLocalState(target, { ...stateOf(baseline), ...proposed })
    ensureOpen(); assertGuard(guard)
    const committed = await image('readwrite', guard, undefined, undefined, (latest, stores) => {
      expectedImage(latest, expected.local)
      writable(latest, baseline, expected.local.snapshot.localVersion, expected.local.outbox.version)
      const slot = advanceEmptySlot(latest, stores), workingRow: WorkingRow = { schema: SCHEMA, targetFingerprint: target, snapshot: post.snapshot }
      stores[WORKING].put(workingRow, CURRENT); stores[METADATA].put(post.metadata, CURRENT)
      stores[PORTFOLIO].put({ schema: 'owner-workspace-portfolio-1', targetFingerprint: target, portfolio: post.portfolio }, CURRENT)
      stores[FULL_SYNC].put(post.fullSync, CURRENT)
      return { ...latest, slot, working: workingRow, metadata: post.metadata, portfolio: post.portfolio!, fullSync: post.fullSync! }
    })
    ensureOpen(); assertGuard(guard); observe(committed)
    return fullSyncStateOf(committed)
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
  const cloudHost: CloudWorkspaceHost = {
    target, readImage, toSyncState: syncStateOf,
    validateLocalState: value => localState(value, target, codec, portfolioCodec, fullCodec),
    assertActive(guard) { ensureOpen(); assertGuard(guard) },
    async commitCloud(expected, baseline, post, mode, guard) {
      if (!codec) fail('workspace_invalid_database')
      if (db.version >= 5) fail('workspace_invalid_database')
      ensureOpen(); assertGuard(guard)
      const committed = await image('readwrite', guard, undefined, undefined,
        (current, stores) => codec.commitCloudImage(target, current, baseline, expected, post, mode, stores))
      ensureOpen(); assertGuard(guard); observe(committed)
      return syncStateOf(committed)
    },
  }
  function cloudCall<T>(name: 'linkCloudBase' | 'prepareCloud' | 'cancelPreparedCloud' | 'syncReceipt' | 'transitionCloudDelivery' | 'ackCloud',
    args: unknown[], guard: OwnerWorkspaceGuard): Promise<T> {
    return bounded(guard, async () => {
      if (!codec) fail('workspace_invalid_database')
      if (db.version >= 5) fail('workspace_invalid_database')
      const commands = await loadCloudCommands()
      ensureOpen(); assertGuard(guard)
      const call = commands[name] as (...args: unknown[]) => Promise<T>
      return call(cloudHost, ...args, guard)
    })
  }
  const fullHost: FullSyncWorkspaceHost = {
    target, readImage, toFullSyncState: fullSyncStateOf, commitFull, commitFullLink,
    validateFullSyncMetadata(input, expected) {
      if (!fullCodec) fail('workspace_invalid_database')
      return fullCodec.validateOwnerPortfolioSyncMetadata(input, target, expected)
    },
    assertActive(guard) { ensureOpen(); assertGuard(guard) },
  }
  function fullCall(name: FullSyncCommandName, received: unknown, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
    return bounded(guard, async () => {
      if (name !== 'linkFullSyncBase' && (db.version !== 6 || !fullCodec)) fail('workspace_invalid_database')
      // Own before the first await, inside the original total bounded window.
      const input = copyOwnerFullSyncInput(received)
      if (name === 'linkFullSyncBase' && (db.version !== 6 || !fullCodec)) fail('workspace_invalid_input')
      const commands = await loadFullSyncCommands()
      ensureOpen(); assertGuard(guard)
      return commands[name](fullHost, input, guard)
    })
  }
  const api: OwnerWorkspace = {
    targetFingerprint: target,
    read(guard: OwnerWorkspaceGuard) { return bounded(guard, async () => (await readImage(guard)).working.snapshot) },
    readLocalState(guard) { return bounded(guard, async () => stateOf(await readImage(guard))) },
    readSyncState(guard) { return bounded(guard, async () => syncStateOf(await readImage(guard))) },
    linkCloudBase(input, guard) { return cloudCall('linkCloudBase', [input], guard) },
    prepareCloud(input, guard) { return cloudCall('prepareCloud', [input], guard) },
    cancelPreparedCloud(input, guard) { return cloudCall('cancelPreparedCloud', [input], guard) },
    syncReceipt(id, hash, guard) { return cloudCall('syncReceipt', [id, hash], guard) },
    transitionCloudDelivery(input, guard) { return cloudCall('transitionCloudDelivery', [input], guard) },
    ackCloud(input, guard) { return cloudCall('ackCloud', [input], guard) },
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
    editPortfolio(input, guard) { return bounded(guard, async () => {
      if (db.version < 5 || !portfolioCodec || !closed(input, ['id', 'hash', 'expected', 'command'])) fail('workspace_invalid_input')
      const request = await buildOwnerWorkspaceEditPortfolioRequest(target, { id: input.id, expected: input.expected, command: input.command })
      if (request.hash !== input.hash) fail('workspace_invalid_input')
      const baseline = await readImage(guard)
      if (matchingLocal(baseline, request.id, request.hash)) return stateOf(baseline)
      expectedImage(baseline, request.expected)
      if (!baseline.portfolio || !baseline.metadata.adoption || baseline.metadata.adoption.id === request.id) fail('workspace_conflict')
      const applied = portfolioCodec.applyOwnerPortfolioCommand(baseline.portfolio, request.command)
      if (canonical(applied.portfolio) === canonical(baseline.portfolio)) return stateOf(baseline)
      const next = snapshot({ ...baseline.working.snapshot, localVersion: increment(baseline.working.snapshot.localVersion) })
      const metadata: OwnerWorkspaceLocalMetadata = { ...baseline.metadata,
        recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
          localVersion: next.localVersion, outboxVersion: increment(baseline.slot.version) } }
      return commitLocal(baseline, request.expected, next, metadata, guard, applied.portfolio)
    }) },
    readFullSyncState(guard) { return bounded(guard, async () => fullSyncStateOf(await readImage(guard))) },
    prepareFullSync(received, guard) { return fullCall('prepareFullSync', received, guard) },
    cancelPreparedFullSync(received, guard) { return fullCall('cancelPreparedFullSync', received, guard) },
    transitionFullSyncDelivery(received, guard) { return fullCall('transitionFullSyncDelivery', received, guard) },
    ackFullSync(received, guard) { return fullCall('ackFullSync', received, guard) },
    linkFullSyncBase(received, guard) { return fullCall('linkFullSyncBase', received, guard) },
    fullSyncReceipt(id, hash, guard) { return bounded(guard, async () => {
      localId(target, id)
      if (typeof hash !== 'string' || !HASH.test(hash)) fail('workspace_invalid_input')
      const current = fullSyncStateOf(await readImage(guard)), receipt = current.fullSync.recentReceipt
      if (current.fullSync.pending?.requestId === id) {
        if (current.fullSync.pending.preparationHash !== hash) fail('workspace_idempotency_conflict')
        return Object.freeze({ state: 'matched' as const, value: current })
      }
      if (receipt?.id !== id) return Object.freeze({ state: 'unknown' as const })
      if (receipt.hash !== hash) fail('workspace_idempotency_conflict')
      return receipt.localVersion === current.local.snapshot.localVersion && receipt.outboxVersion === current.local.outbox.version
        ? Object.freeze({ state: 'matched' as const, value: current }) : Object.freeze({ state: 'unknown' as const })
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
  if (physicalVersion >= 4) return openExistingWorkspace(factory, target, signal)
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
        if (![3, 4, 5, 6].includes(db.version) || !isOwnerSyncOutboxDatabase(db)) { finish('workspace_invalid_database'); return }
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
        if (![3, 4, 5, 6].includes(db.version) || !isOwnerSyncOutboxDatabase(db)) { finish('workspace_invalid_database'); return }
        db.onversionchange = () => finish('workspace_closed')
        db.onclose = () => finish('workspace_closed')
        const ready = (codec: SyncCodec | null, portfolioCodec: PortfolioCodec | null = null, fullCodec: FullSyncCodec | null = null) => {
          if (settled || signal.aborted) { db?.close(); return }
          try {
            handle = makeWorkspace(db!, target, codec, portfolioCodec, fullCodec)
            handle.readLocalState({ signal, assertActive() { if (signal.aborted) fail('workspace_timeout') } })
              .then(() => finish(), error => finish(code(error)))
          } catch (error) { finish(code(error)) }
        }
        if (db.version === 6) Promise.all([loadSyncCodec(), loadPortfolioCodec(), loadFullSyncCodec()])
          .then(([sync, portfolio, full]) => ready(sync, portfolio, full), () => finish('workspace_unavailable'))
        else if (db.version === 5) Promise.all([loadSyncCodec(), loadPortfolioCodec()]).then(([sync, portfolio]) => ready(sync, portfolio), () => finish('workspace_unavailable'))
        else if (db.version === 4) loadSyncCodec().then(ready, () => finish('workspace_unavailable'))
        else ready(null)
      }
    } catch (error) { finish(code(error)) }
  })
}

/** Explicit v3->v4 upgrade; lazy code loading shares the original cancellation window. */
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
  const abortCode = (): OwnerWorkspaceErrorCode => timedOut ? 'workspace_timeout' : 'workspace_context_changed'
  try {
    const [commands, codec] = await waitForImport(Promise.all([loadCloudCommands(), loadSyncCodec()]), controller.signal, abortCode)
    assertGuard(activeGuard)
    return await commands.upgradeOwnerWorkspaceSync({ target, openExistingWorkspace, strictProbe, working, checkedMetadata,
      localState: value => localState(value, target, codec), makeWorkspace: db => makeWorkspace(db, target, codec) },
      factory, expected, activeGuard, controller.signal, abortCode)
  } catch (error) { throw new OwnerWorkspaceError(timedOut ? 'workspace_timeout' : code(error)) }
  finally { clearTimeout(timer); guard.signal.removeEventListener('abort', revoked) }
}

/** Explicit recovery of the v3->v4 initialization gap only. Never recreates a
 * missing database, restores an old business image, or downgrades v4. */
export async function reconcileOwnerWorkspaceSyncUpgrade(factory: IDBFactory, target: string,
  expectedInput: OwnerWorkspaceLocalState, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspace> {
  localId(target, 'workspace-sync-upgrade-reconcile')
  const expected = localState(expectedInput, target)
  if (!expected.metadata.adoption || expected.outbox.entry !== null || expected.receiptCount !== 0) fail('workspace_pending')
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
  const abortCode = (): OwnerWorkspaceErrorCode => timedOut ? 'workspace_timeout' : 'workspace_context_changed'
  try {
    const [recovery, codec] = await waitForImport(Promise.all([
      import('./owner-workspace-upgrade-recovery'), loadSyncCodec(),
    ]), controller.signal, abortCode)
    assertGuard(activeGuard)
    return await recovery.reconcileUpgrade({ target, openExistingWorkspace, strictProbe, working, checkedMetadata,
      localState: value => localState(value, target, codec), makeWorkspace: db => makeWorkspace(db, target, codec) },
    factory, expected, activeGuard, controller.signal, abortCode)
  } catch (error) { throw new OwnerWorkspaceError(timedOut ? 'workspace_timeout' : code(error)) }
  finally { clearTimeout(timer); guard.signal.removeEventListener('abort', revoked) }
}

export function buildOwnerWorkspacePortfolioUpgradeBackup(target: string, expected: OwnerWorkspaceLocalState,
  source: OwnerWorkspacePortfolioUpgradeSource) {
  return timedImport(import('./owner-workspace-portfolio-upgrade').then(module => module.buildOwnerWorkspacePortfolioUpgradeBackup(target, expected, source)))
}
export function buildOwnerWorkspacePortfolioUpgradeRequest(target: string, input: Omit<OwnerWorkspacePortfolioUpgradeRequest, 'hash'>) {
  return timedImport(import('./owner-workspace-portfolio-upgrade').then(module => module.buildOwnerWorkspacePortfolioUpgradeRequest(target, input)))
}
/** Shared scheduling only. Each fixed profile still owns its independent
 * request compiler, intent/CAS and codecs; portfolio never loads full code. */
async function profileFormatOperation(profile: 'portfolio' | 'full', factory: IDBFactory, target: string,
  received: OwnerWorkspacePortfolioUpgradeRequest | OwnerWorkspaceFullSyncUpgradeRequest,
  guard: OwnerWorkspaceGuard, reconcile: boolean): Promise<OwnerWorkspace> {
  const full = profile === 'full'
  localId(target, full ? 'workspace-full-sync-upgrade' : 'workspace-portfolio-upgrade')
  assertGuard(guard)
  let input = received
  if (full) {
    if (!closed(received, ['id', 'hash', 'backupRaw', 'backupSha256'])) fail('workspace_invalid_input')
    input = Object.freeze({ id: received.id as string, hash: received.hash as string,
      backupRaw: received.backupRaw as string, backupSha256: received.backupSha256 as string })
  }
  const controller = new AbortController()
  let timedOut = false
  const revoked = () => controller.abort()
  guard.signal.addEventListener('abort', revoked, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, OWNER_SYNC_OUTBOX_TIMEOUT_MS)
  const activeGuard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() {
    if (timedOut) fail('workspace_timeout')
    assertGuard(guard)
  } }
  const abortCode = (): OwnerWorkspaceErrorCode => timedOut ? 'workspace_timeout' : 'workspace_context_changed'
  try {
    const operation = full
      ? import('./owner-workspace-full-sync-upgrade').then(upgrade => reconcile ? upgrade.reconcileOwnerWorkspaceFullSyncUpgrade : upgrade.upgradeOwnerWorkspaceFullSync)
      : import('./owner-workspace-portfolio-upgrade').then(upgrade => reconcile ? upgrade.reconcileOwnerWorkspacePortfolioUpgrade : upgrade.upgradeOwnerWorkspacePortfolio)
    const [apply, codec, portfolioCodec, fullCodec] = await waitForImport(Promise.all([
      operation, loadSyncCodec(), loadPortfolioCodec(), full ? loadFullSyncCodec() : null,
    ]), controller.signal, abortCode)
    assertGuard(activeGuard)
    return await apply({ target, openExistingWorkspace, strictProbe, working, checkedMetadata,
      localState: value => localState(value, target, codec, portfolioCodec, fullCodec),
      makeWorkspace: db => makeWorkspace(db, target, codec, portfolioCodec, fullCodec) }, factory, input, activeGuard, controller.signal, abortCode)
  } catch (error) { throw new OwnerWorkspaceError(timedOut ? 'workspace_timeout' : code(error)) }
  finally { clearTimeout(timer); guard.signal.removeEventListener('abort', revoked) }
}
export function upgradeOwnerWorkspacePortfolio(factory: IDBFactory, target: string, input: OwnerWorkspacePortfolioUpgradeRequest,
  guard: OwnerWorkspaceGuard): Promise<OwnerWorkspace> {
  return profileFormatOperation('portfolio', factory, target, input, guard, false)
}
export function reconcileOwnerWorkspacePortfolioUpgrade(factory: IDBFactory, target: string, input: OwnerWorkspacePortfolioUpgradeRequest,
  guard: OwnerWorkspaceGuard): Promise<OwnerWorkspace> {
  return profileFormatOperation('portfolio', factory, target, input, guard, true)
}

export function buildOwnerWorkspaceFullSyncLinkRequest(target: string, input: Omit<OwnerWorkspaceFullSyncLinkRequest, 'hash'>) {
  return timedOwnedCall(input, owned => import('./owner-workspace-full-sync')
    .then(module => module.buildOwnerWorkspaceFullSyncLinkRequest(target, owned as Omit<OwnerWorkspaceFullSyncLinkRequest, 'hash'>)))
}
export function buildOwnerWorkspaceFullSyncPrepareRequest(target: string, input: Pick<OwnerWorkspaceFullSyncPrepareRequest, 'id' | 'expected'>) {
  return timedOwnedCall(input, owned => import('./owner-workspace-full-sync')
    .then(module => module.buildOwnerWorkspaceFullSyncPrepareRequest(target, owned as Pick<OwnerWorkspaceFullSyncPrepareRequest, 'id' | 'expected'>)))
}
export function buildOwnerWorkspaceFullSyncCancelRequest(target: string, input: Omit<OwnerWorkspaceFullSyncCancelRequest, 'hash'>) {
  return timedOwnedCall(input, owned => import('./owner-workspace-full-sync')
    .then(module => module.buildOwnerWorkspaceFullSyncCancelRequest(target, owned as Omit<OwnerWorkspaceFullSyncCancelRequest, 'hash'>)))
}
export function previewOwnerWorkspaceFullSyncAck(target: string, input: OwnerWorkspaceFullSyncAckInput) {
  return timedOwnedCall(input, owned => import('./owner-workspace-full-sync-ack')
    .then(module => module.previewOwnerWorkspaceFullSyncAck(target, owned as OwnerWorkspaceFullSyncAckInput)))
}
export function buildOwnerWorkspaceFullSyncAckRequest(target: string, input: OwnerWorkspaceFullSyncAckInput) {
  return timedOwnedCall(input, owned => import('./owner-workspace-full-sync-ack')
    .then(module => module.buildOwnerWorkspaceFullSyncAckRequest(target, owned as OwnerWorkspaceFullSyncAckInput)))
}
export function buildOwnerWorkspaceFullSyncUpgradeRequest(target: string, input: Omit<OwnerWorkspaceFullSyncUpgradeRequest, 'hash'>) {
  if (!closed(input, ['id', 'backupRaw', 'backupSha256'])) return Promise.reject(new OwnerWorkspaceError('workspace_invalid_input'))
  const owned = Object.freeze({ id: input.id as string, backupRaw: input.backupRaw as string, backupSha256: input.backupSha256 as string })
  return timedImport(import('./owner-workspace-full-sync-upgrade').then(module => module.buildOwnerWorkspaceFullSyncUpgradeRequest(target, owned)))
}
export function upgradeOwnerWorkspaceFullSync(factory: IDBFactory, target: string, input: OwnerWorkspaceFullSyncUpgradeRequest,
  guard: OwnerWorkspaceGuard): Promise<OwnerWorkspace> {
  return profileFormatOperation('full', factory, target, input, guard, false)
}
export function reconcileOwnerWorkspaceFullSyncUpgrade(factory: IDBFactory, target: string, input: OwnerWorkspaceFullSyncUpgradeRequest,
  guard: OwnerWorkspaceGuard): Promise<OwnerWorkspace> {
  return profileFormatOperation('full', factory, target, input, guard, true)
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
