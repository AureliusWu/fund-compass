/** Explicit v6-only lazy commands. The private app core owns the fixed loaded
 * codec, full-image crypto/capacity gate and all strict IDB/CAS/store writes.
 * No runtime static core import, network, credentials, UI activation or fallback.
 * Inputs were descriptor-owned by the public core before its first await.
 */
import { validateOwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
import { canonical, closed, code, digest, fail, increment } from './owner-workspace-shared'
import type { OwnerWorkspaceLocalMetadata } from '@/utils/owner-workspace-backup'
import type { FullSyncWorkspaceHost, Image, OwnerWorkspaceFullSyncState, OwnerWorkspaceGuard,
  OwnerWorkspaceFullSyncLinkRequest, OwnerWorkspaceFullSyncDeliveryRequest, OwnerWorkspaceFullSyncAckRequest,
  FullSyncPostimage, FullSyncCommitMode } from './owner-workspace-types'

/** Fixed synchronous transition rules only. Core calls this inside its strict
 * transaction AFTER the complete expected/baseline/slot-version CAS, and before
 * its loaded synchronous codecs and real writes. No IO, mutation or callbacks. */
export function assertFullSyncTransition(current: Image, post: FullSyncPostimage, mode: FullSyncCommitMode): void {
  const before = current.slot.entry, after = post.outbox.entry
  const changedLocal = post.snapshot !== undefined || post.metadata !== undefined || post.portfolio !== undefined
  if (mode === 'prepare') {
    if (before !== null || !after || after.state !== 'prepared' || changedLocal || !post.fullSync.pending
      || post.fullSync.epoch !== increment(current.fullSync!.epoch)
      || canonical(post.fullSync.base) !== canonical(current.fullSync!.base)) fail('workspace_conflict')
  } else if (mode === 'cancel') {
    if (before?.state !== 'prepared' || after !== null || changedLocal || post.fullSync.pending !== null
      || post.fullSync.epoch !== increment(current.fullSync!.epoch) || post.fullSync.recentReceipt?.operation !== 'cancel'
      || canonical(post.fullSync.base) !== canonical(current.fullSync!.base)) fail('workspace_conflict')
  } else if (mode === 'delivery') {
    const allowed = { prepared: ['attempted'], attempted: ['unknown', 'confirmed', 'conflict'],
      unknown: ['confirmed', 'conflict'], confirmed: [], conflict: [] }
    if (!before || !after || !(allowed[before.state] as string[]).includes(after.state) || changedLocal
      || after.rawBody !== before.rawBody || after.requestHash !== before.requestHash || after.schema !== before.schema
      || canonical(post.fullSync) !== canonical(current.fullSync)) fail('workspace_conflict')
  } else if (mode === 'ack') {
    if (!before || !['confirmed', 'conflict'].includes(before.state) || after !== null
      || !post.snapshot || !post.metadata || !post.portfolio || post.snapshot.localVersion !== increment(current.working.snapshot.localVersion)
      || post.fullSync.pending !== null || post.fullSync.epoch !== increment(current.fullSync!.epoch)
      || post.fullSync.recentReceipt?.operation !== 'ack' || !post.fullSync.base || !current.fullSync?.base
      || post.fullSync.base.pulledRevision < current.fullSync.base.pulledRevision) fail('workspace_conflict')
  } else fail('workspace_invalid_input')
}

function snapshot(value: unknown) {
  try { return validateOwnerWorkspaceSnapshot(value) } catch (error) { return fail(code(error)) }
}
function expectedImage(host: FullSyncWorkspaceHost, image: Image, expected: OwnerWorkspaceFullSyncState): void {
  if (canonical(host.toFullSyncState(image)) !== canonical(expected)) fail('workspace_conflict')
}

export async function prepareFullSync(host: FullSyncWorkspaceHost, input: unknown, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
  const target = host.target
  if (!closed(input, ['id', 'hash', 'expected', 'packet']) || typeof input.id !== 'string'
    || !closed(input.packet, ['request', 'rawBody', 'requestHash', 'byteLength'])) fail('workspace_invalid_input')
  const [{ buildOwnerWorkspaceFullSyncPrepareRequest: build }, contract, { fullSyncPendingPreimage, fullSyncWire }] = await Promise.all([
    import('./owner-workspace-full-sync'), import('@/utils/ownerSyncContract'), import('@/utils/owner-portfolio-pending'),
  ])
  const request = await build(target, { id: input.id, expected: input.expected as OwnerWorkspaceFullSyncState })
  let supplied
  try { supplied = contract.validateOwnerSyncRequest(input.packet.request) } catch { return fail('workspace_invalid_input') }
  if (request.hash !== input.hash || input.packet.rawBody !== request.packet.rawBody
    || input.packet.requestHash !== request.packet.requestHash || input.packet.byteLength !== request.packet.byteLength
    || fullSyncWire(supplied) !== request.packet.rawBody) fail('workspace_invalid_input')
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  const adoption = baseline.metadata.adoption!
  if (request.id === adoption.id) fail('workspace_idempotency_conflict')
  const version = increment(baseline.slot.version), epoch = increment(baseline.fullSync!.epoch)
  const entry = Object.freeze({ schema: 'owner-sync-outbox-1' as const, state: 'prepared' as const,
    rawBody: request.packet.rawBody, requestHash: request.packet.requestHash })
  const fullSync = host.validateFullSyncMetadata({ ...baseline.fullSync, epoch,
    pending: { requestId: request.id, requestHash: request.packet.requestHash, rawBody: request.packet.rawBody,
      preparationHash: request.hash, preimageHash: await digest(fullSyncPendingPreimage(baseline, epoch, version)),
      adoptionId: adoption.id, adoptionHash: adoption.hash, localVersion: baseline.working.snapshot.localVersion,
      preparedOutboxVersion: version, baseRevision: baseline.fullSync!.base!.pulledRevision } },
  { snapshot: baseline.working.snapshot, metadata: baseline.metadata, outbox: { version, entry } })
  return host.commitFull(request.expected, baseline, { outbox: { version, entry }, fullSync }, 'prepare', guard)
}

export async function cancelPreparedFullSync(host: FullSyncWorkspaceHost, input: unknown, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
  const target = host.target
  if (!closed(input, ['id', 'hash', 'expected', 'requestId', 'requestHash'])) fail('workspace_invalid_input')
  const { buildOwnerWorkspaceFullSyncCancelRequest: build } = await import('./owner-workspace-full-sync')
  const request = await build(target, { id: input.id as string, expected: input.expected as OwnerWorkspaceFullSyncState,
    requestId: input.requestId as string, requestHash: input.requestHash as string })
  if (input.hash !== request.hash) fail('workspace_invalid_input')
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  const version = increment(baseline.slot.version), epoch = increment(baseline.fullSync!.epoch)
  const fullSync = host.validateFullSyncMetadata({ ...baseline.fullSync, epoch, pending: null,
    recentReceipt: { id: request.id, hash: request.hash, operation: 'cancel', syncEpoch: epoch,
      outboxVersion: version, localVersion: baseline.working.snapshot.localVersion } },
  { snapshot: baseline.working.snapshot, metadata: baseline.metadata, outbox: { version, entry: null } })
  return host.commitFull(request.expected, baseline, { outbox: { version, entry: null }, fullSync }, 'cancel', guard)
}

export async function transitionFullSyncDelivery(host: FullSyncWorkspaceHost, input: unknown, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
  if (!closed(input, ['expected', 'requestId', 'requestHash', 'preparationHash', 'nextState'])) fail('workspace_invalid_input')
  const { validateFullSyncState } = await import('./owner-workspace-full-sync')
  const expected = await validateFullSyncState(host.target, input.expected), pending = expected.fullSync.pending
  if (!pending || pending.requestId !== input.requestId || pending.requestHash !== input.requestHash
    || pending.preparationHash !== input.preparationHash
    || !['attempted', 'unknown', 'confirmed', 'conflict'].includes(input.nextState as string)) fail('workspace_invalid_input')
  const baseline = await host.readImage(guard)
  const entry = { ...expected.local.outbox.entry!, state: input.nextState as OwnerWorkspaceFullSyncDeliveryRequest['nextState'] }
  return host.commitFull(expected, baseline, { outbox: { version: increment(baseline.slot.version), entry },
    fullSync: expected.fullSync }, 'delivery', guard)
}

export async function ackFullSync(host: FullSyncWorkspaceHost, input: unknown, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
  const { rehydrateOwnerWorkspaceFullSyncAckRequest } = await import('./owner-workspace-full-sync-ack')
  const { request, preview } = await rehydrateOwnerWorkspaceFullSyncAckRequest(host.target, input as OwnerWorkspaceFullSyncAckRequest)
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  if (!preview.nextSnapshot || !preview.nextPortfolio || !preview.baseD) fail('workspace_conflict')
  const next = snapshot({ ...preview.nextSnapshot, localVersion: increment(baseline.working.snapshot.localVersion) })
  const version = increment(baseline.slot.version), epoch = increment(baseline.fullSync!.epoch)
  const times = new Map(baseline.metadata.displayTimes.map(row => [row.key, row.updated_at]))
  const metadata: OwnerWorkspaceLocalMetadata = { ...baseline.metadata,
    displayTimes: next.entries.map(row => ({ key: row.key, updated_at: times.get(row.key) ?? null })),
    recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
      localVersion: next.localVersion, outboxVersion: version } }
  const fullSync = host.validateFullSyncMetadata({ ...baseline.fullSync, epoch, pending: null, base: preview.baseD,
    recentReceipt: { id: request.id, hash: request.hash, operation: 'ack', syncEpoch: epoch,
      outboxVersion: version, localVersion: next.localVersion } },
  { snapshot: next, metadata, outbox: { version, entry: null } })
  return host.commitFull(request.expected, baseline, { snapshot: next, metadata, portfolio: preview.nextPortfolio,
    fullSync, outbox: { version, entry: null } }, 'ack', guard)
}

export async function linkFullSyncBase(host: FullSyncWorkspaceHost, input: unknown, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState> {
  if (!closed(input, ['id', 'hash', 'expected', 'base', 'minimumObservedRevision', 'resolutions'])) fail('workspace_invalid_input')
  const [{ buildOwnerWorkspaceFullSyncLinkRequest: build }, { previewOwnerPortfolioInitialMerge: merge }] = await Promise.all([
    import('./owner-workspace-full-sync'), import('@/utils/owner-portfolio-merge'),
  ])
  const request = await build(host.target, { id: input.id as string, expected: input.expected as OwnerWorkspaceFullSyncState,
    base: input.base as OwnerWorkspaceFullSyncLinkRequest['base'], minimumObservedRevision: input.minimumObservedRevision as number,
    resolutions: input.resolutions as OwnerWorkspaceFullSyncLinkRequest['resolutions'] })
  if (input.hash !== request.hash) fail('workspace_invalid_input')
  const baseline = await host.readImage(guard), current = host.toFullSyncState(baseline)
  const oldReceipt = current.fullSync.recentReceipt
  if (oldReceipt?.id === request.id) {
    if (oldReceipt.hash !== request.hash) fail('workspace_idempotency_conflict')
    if (oldReceipt.localVersion === current.local.snapshot.localVersion && oldReceipt.outboxVersion === current.local.outbox.version) return current
  }
  if (canonical(current.local) !== canonical(request.expected.local)) fail('workspace_conflict')
  if (baseline.slot.entry !== null || !baseline.fullSync || baseline.fullSync.base !== null || !baseline.portfolio) fail('workspace_pending')
  const preview = merge({ base: baseline.sync?.base ?? null, localSnapshot: baseline.working.snapshot,
    portfolio: baseline.portfolio, completeBaseline: request.base, minimumObservedRevision: request.minimumObservedRevision,
    resolutions: request.resolutions })
  if (preview.issues.length || !preview.nextSnapshot || !preview.nextPortfolio || !preview.baseC) fail('workspace_conflict')
  const next = snapshot({ ...preview.nextSnapshot, localVersion: increment(baseline.working.snapshot.localVersion) })
  const outbox = { version: increment(baseline.slot.version), entry: null }
  const times = new Map(baseline.metadata.displayTimes.map(row => [row.key, row.updated_at]))
  const metadata: OwnerWorkspaceLocalMetadata = { ...baseline.metadata,
    displayTimes: next.entries.map(row => ({ key: row.key, updated_at: times.get(row.key) ?? null })),
    recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
      localVersion: next.localVersion, outboxVersion: outbox.version } }
  const fullSync = host.validateFullSyncMetadata({ ...baseline.fullSync, epoch: increment(baseline.fullSync.epoch),
    base: preview.baseC, pending: null, recentReceipt: { id: request.id, hash: request.hash, operation: 'link',
      syncEpoch: increment(baseline.fullSync.epoch), outboxVersion: outbox.version, localVersion: next.localVersion } },
  { snapshot: next, metadata, outbox })
  return host.commitFullLink(request.expected, baseline, { snapshot: next, metadata, outbox, portfolio: preview.nextPortfolio, fullSync }, guard)
}
