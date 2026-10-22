/** Pure shape/binding validation only. No IDB, credentials, network or crypto.
 *
 * A pending rawBody is retained byte-for-byte and bound to the current slot.
 * This synchronous codec does NOT authenticate its hash or parse/certify the
 * request_id inside JSON. Call restoreOwnerSyncRequest outside the IDB
 * transaction before admission, then bind those original id/hash/body values
 * again in the transaction. A local receipt never confirms a cloud revision.
 */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import type { OwnerSyncOutboxSnapshot } from '@/stores/ownerSyncOutbox'
import { OWNER_SYNC_MAX_BODY_BYTES } from '@/utils/ownerSyncContract'
import { validateOwnerWorkspaceSnapshot, type OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
import { validateOwnerWorkspaceLocalMetadata, type OwnerWorkspaceLocalMetadata } from '@/utils/owner-workspace-backup'
import { validateOwnerWorkspaceCloudBaseline } from '@/utils/owner-workspace-sync-baseline'
import { OwnerWorkspaceSyncError, OwnerWorkspaceSyncMetadataError } from '@/utils/owner-workspace-sync-errors'
export { OwnerWorkspaceSyncMetadataError } from '@/utils/owner-workspace-sync-errors'

export interface OwnerWorkspaceSyncPending {
  readonly requestId: string
  readonly requestHash: string
  readonly rawBody: string
  readonly preimageHash: string
  readonly preparationHash: string
  readonly adoptionId: string
  readonly adoptionHash: string
  readonly localVersion: number
  readonly preparedOutboxVersion: number
  readonly baseRevision: number
}
export interface OwnerWorkspaceSyncReceipt {
  readonly id: string
  readonly hash: string
  readonly operation: 'link' | 'cancel' | 'ack'
  readonly syncEpoch: number
  readonly outboxVersion: number
  readonly localVersion: number
}
export interface OwnerWorkspaceSyncMetadata {
  readonly schema: 'owner-workspace-sync-1'
  readonly targetFingerprint: string
  readonly epoch: number
  readonly base: OwnerSyncBaseline | null
  readonly pending: OwnerWorkspaceSyncPending | null
  readonly recentReceipt: OwnerWorkspaceSyncReceipt | null
}
export interface OwnerWorkspaceSyncMetadataContext {
  readonly snapshot: OwnerWorkspaceSnapshot
  readonly metadata: OwnerWorkspaceLocalMetadata
  readonly outbox: OwnerSyncOutboxSnapshot
}

const HASH = /^[0-9a-f]{64}(?![\s\S])/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const STATES = new Set(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'])
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
  if (typeof input !== 'string' || input.length === 0) fail()
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
function frozen<T>(input: T): T {
  if (input && typeof input === 'object') { Object.values(input).forEach(frozen); Object.freeze(input) }
  return input
}
function pending(input: unknown, base: OwnerSyncBaseline | null): OwnerWorkspaceSyncPending | null {
  if (input === null) return null
  const row = closed(input, ['requestId', 'requestHash', 'rawBody', 'preimageHash', 'preparationHash', 'adoptionId',
    'adoptionHash', 'localVersion', 'preparedOutboxVersion', 'baseRevision'])
  if (!base) fail()
  const result: OwnerWorkspaceSyncPending = { requestId: id(row.requestId), requestHash: hash(row.requestHash),
    rawBody: body(row.rawBody), preimageHash: hash(row.preimageHash), preparationHash: hash(row.preparationHash), adoptionId: id(row.adoptionId),
    adoptionHash: hash(row.adoptionHash), localVersion: counter(row.localVersion, 1),
    preparedOutboxVersion: counter(row.preparedOutboxVersion, 1), baseRevision: counter(row.baseRevision) }
  if (result.baseRevision !== base.pulledRevision) fail()
  return result
}
function receipt(input: unknown, epoch: number): OwnerWorkspaceSyncReceipt | null {
  if (input === null) return null
  const row = closed(input, ['id', 'hash', 'operation', 'syncEpoch', 'outboxVersion', 'localVersion'])
  if (row.operation !== 'link' && row.operation !== 'cancel' && row.operation !== 'ack') fail()
  const result: OwnerWorkspaceSyncReceipt = { id: id(row.id), hash: hash(row.hash), operation: row.operation,
    syncEpoch: counter(row.syncEpoch, 1), outboxVersion: counter(row.outboxVersion, 1),
    localVersion: counter(row.localVersion, 1) }
  if (result.syncEpoch > epoch) fail()
  return result
}
function context(input: unknown): OwnerWorkspaceSyncMetadataContext {
  const row = closed(input, ['snapshot', 'metadata', 'outbox'])
  const snapshot = validateOwnerWorkspaceSnapshot(row.snapshot)
  const metadata = validateOwnerWorkspaceLocalMetadata(row.metadata, snapshot)
  const slot = closed(row.outbox, ['version', 'entry'])
  const version = counter(slot.version)
  if (slot.entry === null) return { snapshot, metadata, outbox: { version, entry: null } }
  const entry = closed(slot.entry, ['schema', 'state', 'rawBody', 'requestHash'])
  if (entry.schema !== 'owner-sync-outbox-1' || typeof entry.state !== 'string' || !STATES.has(entry.state)) fail()
  return { snapshot, metadata, outbox: { version, entry: { schema: 'owner-sync-outbox-1',
    state: entry.state as NonNullable<OwnerSyncOutboxSnapshot['entry']>['state'],
    rawBody: body(entry.rawBody), requestHash: hash(entry.requestHash) } } }
}

/** Closed, independent metadata copy. Hashes/preimages are opaque local bindings, not authentication. */
export function validateOwnerWorkspaceSyncMetadata(input: unknown, target: string,
  expected?: OwnerWorkspaceSyncMetadataContext): OwnerWorkspaceSyncMetadata {
  try {
    const fingerprint = hash(target)
    const row = closed(input, ['schema', 'targetFingerprint', 'epoch', 'base', 'pending', 'recentReceipt'])
    if (row.schema !== 'owner-workspace-sync-1' || hash(row.targetFingerprint) !== fingerprint) fail()
    const epoch = counter(row.epoch)
    const base = row.base === null ? null : validateOwnerWorkspaceCloudBaseline(row.base)
    const slotBinding = pending(row.pending, base), recentReceipt = receipt(row.recentReceipt, epoch)
    if (base === null ? epoch !== 0 || slotBinding !== null || recentReceipt !== null : epoch < 1 || recentReceipt === null) fail()
    // An empty-slot link/cancel/ack receipt belongs to the current epoch.
    // A prepare advances the epoch exactly once while retaining the last
    // receipt. Delivery may advance only the slot version, not this epoch.
    // receipt; delivery advances only the slot version, never this epoch.
    if (base !== null && recentReceipt !== null) {
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
    return frozen({ schema: 'owner-workspace-sync-1', targetFingerprint: fingerprint, epoch, base,
      pending: slotBinding, recentReceipt })
  } catch (error) {
    if (error instanceof OwnerWorkspaceSyncMetadataError) throw error
    if (error instanceof OwnerWorkspaceSyncError && error.code === 'capacity_exceeded') return fail('capacity_exceeded')
    return fail()
  }
}

export function emptyOwnerWorkspaceSyncMetadata(target: string): OwnerWorkspaceSyncMetadata {
  return validateOwnerWorkspaceSyncMetadata({ schema: 'owner-workspace-sync-1', targetFingerprint: target,
    epoch: 0, base: null, pending: null, recentReceipt: null }, target)
}
