/** Lazy v4 validation/hydration. Loaded before handle creation or any IDB transaction.
 * All exported shape codecs are synchronous; crypto below runs after read tx completion.
 */
import { validateOwnerWorkspaceSyncMetadata } from './owner-workspace-sync-metadata'
export { emptyOwnerWorkspaceSyncMetadata, validateOwnerWorkspaceSyncMetadata } from './owner-workspace-sync-metadata'
import { restoreOwnerSyncRequest } from './ownerSyncContract'
import { closed, canonical, digest, fail, increment, SCHEMA, CURRENT, WORKING, METADATA, SYNC } from '@/stores/owner-workspace-shared'
import { ownerSyncOutboxStorage } from '@/stores/ownerSyncOutbox'
import { validateOwnerWorkspaceSnapshot } from './owner-cloud-import'
import { validateOwnerWorkspaceLocalMetadata } from './owner-workspace-backup'
import type { Image, LocalStateValidator, OwnerWorkspaceSyncState, CloudPostimage, CloudCommitMode, WorkingRow } from '@/stores/owner-workspace-types'
export function validateSyncState(input: unknown, target: string, validateLocal: LocalStateValidator): OwnerWorkspaceSyncState {
  if (!closed(input, ['local', 'sync'])) fail('workspace_invalid_input')
  const local = validateLocal(input.local)
  const sync = validateOwnerWorkspaceSyncMetadata(input.sync, target, {
    snapshot: local.snapshot, metadata: local.metadata, outbox: local.outbox,
  })
  if (!local.sync || canonical(local.sync) !== canonical(sync)) fail('workspace_invalid_input')
  return Object.freeze({ local, sync })
}

export function pendingPreimage(image: Image, epoch: number, preparedOutboxVersion: number): string {
  return canonical({ target: image.sync?.targetFingerprint, snapshot: image.working.snapshot, metadata: image.metadata,
    receiptCount: image.receiptCount, base: image.sync?.base, epoch, preparedOutboxVersion })
}

/** Synchronous v4 writer, invoked only inside the core's existing strict image
 * transaction. All async packet/crypto/planning work must have finished first.
 * The host is private; this module is not a public caller-injected codec hook.
 */
export function commitCloudImage(target: string, current: Image, baseline: Image, expected: OwnerWorkspaceSyncState,
  post: CloudPostimage, mode: CloudCommitMode, stores: Record<string, IDBObjectStore>): Image {
  const local = { snapshot: current.working.snapshot, outbox: { version: current.slot.version, entry: current.slot.entry },
    metadata: current.metadata, receiptCount: current.receiptCount, sync: current.sync }
  if (!current.sync || canonical({ local, sync: current.sync }) !== canonical(expected)
    || canonical(current) !== canonical(baseline)) fail('workspace_conflict')
  const before = current.slot.entry, next = post.outbox.entry
  if (mode === 'empty') {
    if (before !== null) fail('workspace_pending')
  } else if (mode === 'prepared') {
    if (before?.state !== 'prepared' || next !== null) fail('workspace_conflict')
  } else if (mode === 'delivery') {
    const allowed = { prepared: ['attempted'], attempted: ['unknown', 'confirmed', 'conflict'],
      unknown: ['confirmed', 'conflict'], confirmed: [], conflict: [] }
    if (!before || !next || !(allowed[before.state] as string[]).includes(next.state)
      || next.rawBody !== before.rawBody || next.requestHash !== before.requestHash
      || next.schema !== before.schema || post.snapshot !== undefined || post.metadata !== undefined
      || canonical(post.sync) !== canonical(current.sync)) fail('workspace_conflict')
  } else if (mode === 'ack') {
    if (!before || !['confirmed', 'conflict'].includes(before.state) || next !== null
      || !post.snapshot || !post.metadata || post.snapshot.localVersion !== increment(current.working.snapshot.localVersion)
      || post.sync.epoch !== increment(current.sync.epoch) || post.sync.pending !== null
      || post.sync.recentReceipt?.operation !== 'ack' || !post.sync.base || !current.sync.base
      || post.sync.base.pulledRevision < current.sync.base.pulledRevision) fail('workspace_conflict')
  } else fail('workspace_conflict')
  if (post.outbox.version !== increment(current.slot.version)) fail('workspace_conflict')
  const slot = ownerSyncOutboxStorage.rowShape({ ...post.outbox, resourceFingerprint: target }, target)
  const working: WorkingRow = post.snapshot === undefined ? current.working
    : { schema: SCHEMA, targetFingerprint: target, snapshot: validateOwnerWorkspaceSnapshot(post.snapshot) }
  const metadata = post.metadata === undefined ? current.metadata : validateOwnerWorkspaceLocalMetadata(post.metadata, working.snapshot)
  const sync = validateOwnerWorkspaceSyncMetadata(post.sync, target,
    { snapshot: working.snapshot, metadata, outbox: { version: slot.version, entry: slot.entry } })
  stores.slot.put(slot, CURRENT)
  if (post.snapshot !== undefined) stores[WORKING].put(working, CURRENT)
  if (post.metadata !== undefined) stores[METADATA].put(metadata, CURRENT)
  // Delivery leaves every sync byte and the original preparation epoch intact.
  if (mode !== 'delivery') stores[SYNC].put(sync, CURRENT)
  return { ...current, slot, working, metadata, sync }
}


export async function verifyPending(result: Image, target: string, validateLocal: LocalStateValidator): Promise<void> {
  if (result.sync?.pending) {
      try {
        const pending = result.sync.pending
        const packet = await restoreOwnerSyncRequest(pending.rawBody, pending.requestHash)
        // Delivery-state transitions may advance the slot, not the preparation
        // epoch. Recover the exact pre-prepare local envelope to verify the
        // independently retained preparation hash as well as its data image.
        const beforeSync = { ...result.sync, epoch: result.sync.epoch - 1, pending: null }
        const beforeLocal = { ...{ snapshot: result.working.snapshot, outbox: { version: result.slot.version, entry: result.slot.entry }, metadata: result.metadata, receiptCount: result.receiptCount, sync: result.sync }, outbox: { version: pending.preparedOutboxVersion - 1, entry: null }, sync: beforeSync }
        const expected = validateSyncState({ local: beforeLocal, sync: beforeSync }, target, validateLocal)
        if (packet.request.request_id !== pending.requestId || packet.request.expected_revision !== pending.baseRevision
          || await digest(canonical({ operation: 'cloud-prepare-1', target, id: pending.requestId, expected, packet })) !== pending.preparationHash
          || await digest(pendingPreimage(result, result.sync.epoch, pending.preparedOutboxVersion)) !== pending.preimageHash) fail('workspace_invalid_database')
      } catch { fail('workspace_invalid_database') }
    }
}
