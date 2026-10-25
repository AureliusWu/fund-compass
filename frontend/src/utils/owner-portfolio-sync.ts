/** Pure full fund/manual common-base profile. No storage, clock, crypto or IO.
 * Only an explicitly applied complete initial reconciliation establishes this
 * profile's B. An old fund-only B is not promoted by changing its schema label.
 */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import type { OwnerSyncOutboxSnapshot } from '@/stores/ownerSyncOutbox'
import {
  OwnerCloudImportError, validateOwnerWorkspaceSnapshot, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'
import {
  validateOwnerWorkspaceLocalMetadata, type OwnerWorkspaceLocalMetadata,
} from './owner-workspace-backup'
import { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'
import {
  OwnerWorkspaceSyncError, OwnerWorkspaceSyncMetadataError,
} from './owner-workspace-sync-errors'
import type {
  OwnerWorkspaceSyncPending, OwnerWorkspaceSyncReceipt,
} from './owner-workspace-sync-metadata'
import type { OwnerWorkspaceSyncIssueCode } from './owner-workspace-sync'
import {
  OwnerPortfolioLocalError, validateOwnerPortfolioLocal, type OwnerPortfolioLocal,
} from './ownerPortfolioLocal'
import {
  OWNER_SYNC_MAX_BODY_BYTES, type OwnerSyncOperation, type OwnerSyncRecord, type OwnerSyncValues,
} from './ownerSyncContract'

export { OwnerWorkspaceSyncMetadataError as OwnerPortfolioSyncMetadataError } from './owner-workspace-sync-errors'
export interface OwnerPortfolioSyncMetadata {
  readonly schema: 'owner-portfolio-sync-1'
  readonly profile: 'fund-manual-1'
  readonly targetFingerprint: string
  readonly epoch: number
  readonly base: OwnerSyncBaseline | null
  readonly pending: OwnerWorkspaceSyncPending | null
  readonly recentReceipt: OwnerWorkspaceSyncReceipt | null
}
export interface OwnerPortfolioSyncMetadataContext {
  readonly snapshot: OwnerWorkspaceSnapshot
  readonly metadata: OwnerWorkspaceLocalMetadata
  readonly outbox: OwnerSyncOutboxSnapshot
}
export type OwnerPortfolioSyncIssueCode = OwnerWorkspaceSyncIssueCode | 'invalid_portfolio'
export interface OwnerPortfolioSyncIssue { readonly code: OwnerPortfolioSyncIssueCode; readonly key: string | null }
export interface OwnerPortfolioCloudIntent {
  readonly operations: readonly OwnerSyncOperation[]
  readonly issues: readonly OwnerPortfolioSyncIssue[]
}

const HASH = /^[0-9a-f]{64}(?![\s\S])/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const STATES = new Set(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'])
const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
const MANUAL_FIELDS = ['name', 'cls', 'value', 'note'] as const
const encoder = new TextEncoder()
function fail(code: OwnerWorkspaceSyncMetadataError['code'] = 'invalid_metadata'): never {
  throw new OwnerWorkspaceSyncMetadataError(code)
}
function closed(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail()
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(input)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) fail()
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
function counter(input: unknown, minimum = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || Object.is(input, -0)) fail()
  return input
}
function hash(input: unknown): string {
  if (typeof input !== 'string' || !HASH.test(input)) fail()
  return input
}
function id(input: unknown): string {
  if (typeof input !== 'string' || !ID.test(input)) fail()
  return input
}
function body(input: unknown): string {
  if (typeof input !== 'string' || !input.length) fail()
  if (input.length > OWNER_SYNC_MAX_BODY_BYTES) fail('capacity_exceeded')
  for (let offset = 0; offset < input.length; offset++) {
    const unit = input.charCodeAt(offset)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = input.charCodeAt(++offset)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail()
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail()
  }
  if (encoder.encode(input).byteLength > OWNER_SYNC_MAX_BODY_BYTES) fail('capacity_exceeded')
  return input
}
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') { Object.values(input).forEach(freeze); Object.freeze(input) }
  return input
}
function pending(input: unknown, base: OwnerSyncBaseline | null): OwnerWorkspaceSyncPending | null {
  if (input === null) return null
  const row = closed(input, ['requestId', 'requestHash', 'rawBody', 'preimageHash', 'preparationHash', 'adoptionId',
    'adoptionHash', 'localVersion', 'preparedOutboxVersion', 'baseRevision'])
  if (base === null) fail()
  const result: OwnerWorkspaceSyncPending = { requestId: id(row.requestId), requestHash: hash(row.requestHash),
    rawBody: body(row.rawBody), preimageHash: hash(row.preimageHash), preparationHash: hash(row.preparationHash),
    adoptionId: id(row.adoptionId), adoptionHash: hash(row.adoptionHash), localVersion: counter(row.localVersion, 1),
    preparedOutboxVersion: counter(row.preparedOutboxVersion, 1), baseRevision: counter(row.baseRevision) }
  if (result.baseRevision !== base.pulledRevision) fail()
  return result
}
function receipt(input: unknown, epoch: number): OwnerWorkspaceSyncReceipt | null {
  if (input === null) return null
  const row = closed(input, ['id', 'hash', 'operation', 'syncEpoch', 'outboxVersion', 'localVersion'])
  if (row.operation !== 'link' && row.operation !== 'cancel' && row.operation !== 'ack') fail()
  const result: OwnerWorkspaceSyncReceipt = { id: id(row.id), hash: hash(row.hash), operation: row.operation,
    syncEpoch: counter(row.syncEpoch, 1), outboxVersion: counter(row.outboxVersion, 1), localVersion: counter(row.localVersion, 1) }
  if (result.syncEpoch > epoch) fail()
  return result
}
function context(input: unknown): OwnerPortfolioSyncMetadataContext {
  const row = closed(input, ['snapshot', 'metadata', 'outbox'])
  const snapshot = validateOwnerWorkspaceSnapshot(row.snapshot)
  const metadata = validateOwnerWorkspaceLocalMetadata(row.metadata, snapshot)
  const slot = closed(row.outbox, ['version', 'entry']), version = counter(slot.version)
  if (slot.entry === null) return { snapshot, metadata, outbox: { version, entry: null } }
  const entry = closed(slot.entry, ['schema', 'state', 'rawBody', 'requestHash'])
  if (entry.schema !== 'owner-sync-outbox-1' || typeof entry.state !== 'string' || !STATES.has(entry.state)) fail()
  return { snapshot, metadata, outbox: { version, entry: { schema: 'owner-sync-outbox-1',
    state: entry.state as NonNullable<OwnerSyncOutboxSnapshot['entry']>['state'],
    rawBody: body(entry.rawBody), requestHash: hash(entry.requestHash) } } }
}
function capacityError(error: unknown): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return (error instanceof OwnerWorkspaceSyncError || error instanceof OwnerCloudImportError || error instanceof OwnerPortfolioLocalError)
      && !!descriptor && 'value' in descriptor && descriptor.value === 'capacity_exceeded'
  } catch { return false }
}

/** Independent closed full-profile codec, never an injected/relabelled v4 codec.
 * Hashes remain opaque local bindings here. Async original-body restoration and
 * full-profile preimage/envelope hashing must complete before the IDB CAS.
 */
export function validateOwnerPortfolioSyncMetadata(input: unknown, target: string,
  expected?: OwnerPortfolioSyncMetadataContext): OwnerPortfolioSyncMetadata {
  try {
    const fingerprint = hash(target)
    const row = closed(input, ['schema', 'profile', 'targetFingerprint', 'epoch', 'base', 'pending', 'recentReceipt'])
    if (row.schema !== 'owner-portfolio-sync-1' || row.profile !== 'fund-manual-1'
      || hash(row.targetFingerprint) !== fingerprint) fail()
    const epoch = counter(row.epoch)
    const base = row.base === null ? null : validateOwnerWorkspaceCloudBaseline(row.base)
    const slotBinding = pending(row.pending, base), recentReceipt = receipt(row.recentReceipt, epoch)
    if (base === null ? epoch !== 0 || slotBinding !== null || recentReceipt !== null : epoch < 1 || recentReceipt === null) fail()
    if (base !== null && recentReceipt !== null) {
      // Preparation advances exactly one epoch and retains the prior receipt.
      // Controlled delivery may advance slot.version only, never this epoch/B.
      if (slotBinding === null ? recentReceipt.syncEpoch !== epoch
        : epoch < 2 || recentReceipt.syncEpoch !== epoch - 1
          || slotBinding.preparedOutboxVersion <= recentReceipt.outboxVersion
          || slotBinding.localVersion < recentReceipt.localVersion) fail()
    }
    if (expected !== undefined) {
      const current = context(expected)
      if (base !== null && current.metadata.adoption === null) fail()
      if ((current.outbox.entry === null) !== (slotBinding === null)) fail()
      if (slotBinding !== null) {
        const adoption = current.metadata.adoption, entry = current.outbox.entry
        if (!adoption || !entry || slotBinding.adoptionId !== adoption.id || slotBinding.adoptionHash !== adoption.hash
          || slotBinding.localVersion !== current.snapshot.localVersion
          || slotBinding.preparedOutboxVersion > current.outbox.version
          || slotBinding.rawBody !== entry.rawBody || slotBinding.requestHash !== entry.requestHash) fail()
      }
      if (recentReceipt !== null && (recentReceipt.localVersion > current.snapshot.localVersion
        || recentReceipt.outboxVersion > current.outbox.version)) fail()
    }
    return freeze({ schema: 'owner-portfolio-sync-1', profile: 'fund-manual-1', targetFingerprint: fingerprint,
      epoch, base, pending: slotBinding, recentReceipt })
  } catch (error) {
    if (error instanceof OwnerWorkspaceSyncMetadataError) throw error
    return fail(capacityError(error) ? 'capacity_exceeded' : 'invalid_metadata')
  }
}
export function emptyOwnerPortfolioSyncMetadata(target: string): OwnerPortfolioSyncMetadata {
  return validateOwnerPortfolioSyncMetadata({ schema: 'owner-portfolio-sync-1', profile: 'fund-manual-1',
    targetFingerprint: target, epoch: 0, base: null, pending: null, recentReceipt: null }, target)
}

function fullBase(record: OwnerSyncRecord): OwnerSyncValues {
  return { ...record.values, kind: record.kind, deleted: record.deleted }
}

/** Derive full B -> L only after complete manual reconciliation was applied.
 * Missing linked fund/manual rows are invalid full images, never deletes.
 * +/-0 compare equal under the wire business contract; neither B nor L changes.
 * This deliberately retains every operation/issue without trimming/splitting.
 * The real request builder alone enforces the final 200-row/128-KiB packet cap.
 */
export function planOwnerPortfolioCloudIntent(base: unknown, localSnapshot: unknown, portfolio: unknown): OwnerPortfolioCloudIntent {
  const operations: OwnerSyncOperation[] = [], issues: OwnerPortfolioSyncIssue[] = []
  const finish = (): OwnerPortfolioCloudIntent => freeze({ operations: issues.length ? [] : operations, issues })
  let baseline: OwnerSyncBaseline, local: OwnerWorkspaceSnapshot, assets: OwnerPortfolioLocal
  try { baseline = validateOwnerWorkspaceCloudBaseline(base) }
  catch (error) { issues.push({ code: capacityError(error) ? 'capacity_exceeded' : 'invalid_baseline', key: null }); return finish() }
  try { local = validateOwnerWorkspaceSnapshot(localSnapshot) }
  catch (error) { issues.push({ code: capacityError(error) ? 'capacity_exceeded' : 'invalid_workspace', key: null }); return finish() }
  try { assets = validateOwnerPortfolioLocal(portfolio) }
  catch (error) { issues.push({ code: capacityError(error) ? 'capacity_exceeded' : 'invalid_portfolio', key: null }); return finish() }
  const previous = new Map(baseline.records.map(record => [record.key, record]))
  const localKeys = new Set([...local.entries.map(entry => entry.key), ...assets.manual.map(entry => entry.key)])
  for (const record of baseline.records) if (!localKeys.has(record.key)) {
    issues.push({ code: 'missing_workspace_record', key: record.key })
  }
  for (const entry of local.entries) {
    const before = previous.get(entry.key)
    if (before?.kind === 'manual_asset') { issues.push({ code: 'invalid_operation', key: entry.key }); continue }
    if (entry.deleted) {
      if (!before || before.deleted) continue
      if (before.kind !== entry.kind) { issues.push({ code: 'invalid_operation', key: entry.key }); continue }
      operations.push({ key: entry.key, kind: before.kind, deleted: true, base_values: fullBase(before) })
      continue
    }
    if (before?.deleted) { issues.push({ code: 'cloud_tombstone', key: entry.key }); continue }
    if (!before || before.kind !== entry.kind) {
      if (entry.kind === 'holding' && entry.values.shares === null) { issues.push({ code: 'missing_value', key: entry.key }); continue }
      operations.push({ key: entry.key, kind: entry.kind, deleted: false, changes: { ...entry.values },
        base_values: before ? fullBase(before) : {} })
      continue
    }
    const fields = FUND_FIELDS.filter(field => before.values[field] !== entry.values[field])
    if (fields.length) operations.push({ key: entry.key, kind: entry.kind, deleted: false,
      changes: Object.fromEntries(fields.map(field => [field, entry.values[field]])),
      base_values: { kind: before.kind, deleted: false, ...Object.fromEntries(fields.map(field => [field, before.values[field]])) } })
  }
  for (const entry of assets.manual) {
    const before = previous.get(entry.key)
    if (before && before.kind !== 'manual_asset') { issues.push({ code: 'invalid_operation', key: entry.key }); continue }
    if (entry.deleted) {
      if (before && !before.deleted) operations.push({ key: entry.key, kind: 'manual_asset', deleted: true, base_values: fullBase(before) })
      continue
    }
    if (before?.deleted) { issues.push({ code: 'cloud_tombstone', key: entry.key }); continue }
    if (!before) {
      operations.push({ key: entry.key, kind: 'manual_asset', deleted: false, changes: { ...entry.values }, base_values: {} })
      continue
    }
    const fields = MANUAL_FIELDS.filter(field => before.values[field] !== entry.values[field])
    if (fields.length) operations.push({ key: entry.key, kind: 'manual_asset', deleted: false,
      changes: Object.fromEntries(fields.map(field => [field, entry.values[field]])),
      base_values: { kind: 'manual_asset', deleted: false, ...Object.fromEntries(fields.map(field => [field, before.values[field]])) } })
  }
  return finish()
}
