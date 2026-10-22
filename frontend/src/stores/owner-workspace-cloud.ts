/** Lazy cloud-only commands. A private core host owns all actual IDB transactions.
 * No runtime import of owner-workspace.ts, network, credentials or implicit UI activation.
 */
import { buildOwnerWorkspaceCloudLinkPreview, planOwnerWorkspaceCloudIntent } from '@/utils/owner-workspace-sync'
import { validateOwnerWorkspaceLocalMetadata, buildOwnerWorkspaceBackup } from '@/utils/owner-workspace-backup'
import { buildOwnerSyncRequest, restoreOwnerSyncRequest, type BuiltOwnerSyncRequest } from '@/utils/ownerSyncContract'
import { emptyOwnerWorkspaceSyncMetadata, validateOwnerWorkspaceSyncMetadata, validateSyncState as syncState, pendingPreimage } from '@/utils/owner-workspace-sync-codec'
import { isOwnerSyncOutboxDatabase, ownerSyncOutboxStorage, OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { closed, localId, fail, canonical, digest, increment, code, assertGuard, OwnerWorkspaceError,
  STORES, WORKING, METADATA, RECEIPTS, SYNC, CURRENT, HASH } from './owner-workspace-shared'
import { validateOwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
import { validateOwnerWorkspaceDeliveryRequest, rehydrateOwnerWorkspaceAckCloudRequest,
  type OwnerWorkspaceDeliveryRequest, type OwnerWorkspaceAckCloudRequest } from './owner-workspace-delivery'
import type { CloudWorkspaceHost, CloudUpgradeHost, Image, LocalStateValidator, SlotRow, OwnerWorkspace,
  OwnerWorkspaceGuard, OwnerWorkspaceErrorCode, OwnerWorkspaceLocalState, OwnerWorkspaceSyncState,
  OwnerWorkspaceLinkCloudRequest, OwnerWorkspacePrepareCloudRequest, OwnerWorkspaceCancelCloudRequest } from './owner-workspace-types'
function expectedImage(host: CloudWorkspaceHost, image: Image, expected: OwnerWorkspaceSyncState): void {
  if (canonical(host.toSyncState(image)) !== canonical(expected)) fail('workspace_conflict')
}
function snapshot(value: unknown) { return validateOwnerWorkspaceSnapshot(value) }
export async function buildOwnerWorkspaceLinkCloudRequest(target: string,
  input: Omit<OwnerWorkspaceLinkCloudRequest, 'hash'>, validateLocal: LocalStateValidator): Promise<OwnerWorkspaceLinkCloudRequest> {
  if (!closed(input, ['id', 'expected', 'base'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const expected = syncState(input.expected, target, validateLocal)
  if (expected.sync.base !== null || expected.sync.pending || expected.local.outbox.entry || !expected.local.metadata.adoption) fail('workspace_conflict')
  const preview = buildOwnerWorkspaceCloudLinkPreview(input.base, expected.local.snapshot)
  if (preview.issues.length) fail('workspace_conflict')
  const copy = { id: input.id, expected, base: preview.base }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'cloud-link-1', target, ...copy })) })
}
export async function buildOwnerWorkspacePrepareCloudRequest(target: string,
  input: Pick<OwnerWorkspacePrepareCloudRequest, 'id' | 'expected'>, validateLocal: LocalStateValidator): Promise<OwnerWorkspacePrepareCloudRequest> {
  if (!closed(input, ['id', 'expected'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const expected = syncState(input.expected, target, validateLocal)
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
  input: Omit<OwnerWorkspaceCancelCloudRequest, 'hash'>, validateLocal: LocalStateValidator): Promise<OwnerWorkspaceCancelCloudRequest> {
  if (!closed(input, ['id', 'expected', 'requestId', 'requestHash'])) fail('workspace_invalid_input')
  localId(target, input.id); localId(target, input.requestId)
  if (typeof input.requestHash !== 'string' || !HASH.test(input.requestHash) || input.id === input.requestId) fail('workspace_invalid_input')
  const expected = syncState(input.expected, target, validateLocal)
  const pending = expected.sync.pending
  if (expected.local.outbox.entry?.state !== 'prepared' || !pending
    || pending.requestId !== input.requestId || pending.requestHash !== input.requestHash) fail('workspace_pending')
  const copy = { id: input.id, expected, requestId: input.requestId, requestHash: input.requestHash }
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'cloud-cancel-1', target, ...copy })) })
}


export async function linkCloudBase(host: CloudWorkspaceHost, input: OwnerWorkspaceLinkCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState> {
  const target = host.target
  if (!closed(input, ['id', 'hash', 'expected', 'base'])) fail('workspace_invalid_input')
  const request = await buildOwnerWorkspaceLinkCloudRequest(target, { id: input.id, expected: input.expected, base: input.base }, host.validateLocalState)
  if (request.hash !== input.hash) fail('workspace_invalid_input')
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  const preview = buildOwnerWorkspaceCloudLinkPreview(request.base, baseline.working.snapshot)
  if (preview.issues.length) fail('workspace_conflict')
  const next = snapshot({ ...preview.snapshot, localVersion: increment(baseline.working.snapshot.localVersion) })
  const outboxVersion = increment(baseline.slot.version), epoch = increment(baseline.sync!.epoch)
  const metadata = validateOwnerWorkspaceLocalMetadata({ ...baseline.metadata,
    displayTimes: [...baseline.metadata.displayTimes, ...preview.addedKeys.map(key => ({ key, updated_at: null }))],
    recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
      localVersion: next.localVersion, outboxVersion } }, next)
  await buildOwnerWorkspaceBackup({ snapshot: next, metadata })
  const sync = validateOwnerWorkspaceSyncMetadata({ ...baseline.sync, epoch, base: preview.base,
    recentReceipt: { id: request.id, hash: request.hash, operation: 'link', syncEpoch: epoch, outboxVersion,
      localVersion: next.localVersion } }, target, { snapshot: next, metadata, outbox: { version: outboxVersion, entry: null } })
  return host.commitCloud(request.expected, baseline, { outbox: { version: outboxVersion, entry: null }, sync,
    snapshot: next, metadata }, 'empty', guard)
}
export async function prepareCloud(host: CloudWorkspaceHost, input: OwnerWorkspacePrepareCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState> {
  const target = host.target
  if (!closed(input, ['id', 'hash', 'expected', 'packet'])
    || !closed(input.packet, ['request', 'rawBody', 'requestHash', 'byteLength'])) fail('workspace_invalid_input')
  const request = await buildOwnerWorkspacePrepareCloudRequest(target, { id: input.id, expected: input.expected }, host.validateLocalState)
  let supplied: BuiltOwnerSyncRequest
  try { supplied = await buildOwnerSyncRequest(input.packet.request) } catch { return fail('workspace_invalid_input') }
  if (request.hash !== input.hash || request.packet.rawBody !== input.packet.rawBody
    || request.packet.requestHash !== input.packet.requestHash || request.packet.byteLength !== input.packet.byteLength
    || supplied.rawBody !== request.packet.rawBody || supplied.requestHash !== request.packet.requestHash) fail('workspace_invalid_input')
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  const adoption = baseline.metadata.adoption!
  if (request.id === adoption.id) fail('workspace_idempotency_conflict')
  const version = increment(baseline.slot.version), epoch = increment(baseline.sync!.epoch)
  const entry = { schema: 'owner-sync-outbox-1' as const, state: 'prepared' as const,
    rawBody: request.packet.rawBody, requestHash: request.packet.requestHash }
  const sync = validateOwnerWorkspaceSyncMetadata({ ...baseline.sync, epoch,
    pending: { requestId: request.id, requestHash: request.packet.requestHash, rawBody: request.packet.rawBody,
      preparationHash: request.hash, preimageHash: await digest(pendingPreimage(baseline, epoch, version)),
      adoptionId: adoption.id, adoptionHash: adoption.hash, localVersion: baseline.working.snapshot.localVersion,
      preparedOutboxVersion: version, baseRevision: baseline.sync!.base!.pulledRevision } }, target,
    { snapshot: baseline.working.snapshot, metadata: baseline.metadata, outbox: { version, entry } })
  return host.commitCloud(request.expected, baseline, { outbox: { version, entry }, sync }, 'empty', guard)
}
export async function cancelPreparedCloud(host: CloudWorkspaceHost, input: OwnerWorkspaceCancelCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState> {
  const target = host.target
  if (!closed(input, ['id', 'hash', 'expected', 'requestId', 'requestHash'])) fail('workspace_invalid_input')
  const request = await buildOwnerWorkspaceCancelCloudRequest(target, { id: input.id, expected: input.expected,
    requestId: input.requestId, requestHash: input.requestHash }, host.validateLocalState)
  if (request.hash !== input.hash) fail('workspace_invalid_input')
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  const version = increment(baseline.slot.version), epoch = increment(baseline.sync!.epoch)
  const sync = validateOwnerWorkspaceSyncMetadata({ ...baseline.sync, epoch, pending: null,
    recentReceipt: { id: request.id, hash: request.hash, operation: 'cancel', syncEpoch: epoch,
      outboxVersion: version, localVersion: baseline.working.snapshot.localVersion } }, target,
    { snapshot: baseline.working.snapshot, metadata: baseline.metadata, outbox: { version, entry: null } })
  return host.commitCloud(request.expected, baseline, { outbox: { version, entry: null }, sync }, 'prepared', guard)
}
export async function syncReceipt(host: CloudWorkspaceHost, id: string, hash: string, guard: OwnerWorkspaceGuard) {
  localId(host.target, id)
  if (typeof hash !== 'string' || !HASH.test(hash)) fail('workspace_invalid_input')
  const state = host.toSyncState(await host.readImage(guard))
  const pending = state.sync.pending, receipt = state.sync.recentReceipt
  if (pending?.requestId === id) {
    if (pending.preparationHash !== hash) fail('workspace_idempotency_conflict')
    return Object.freeze({ state: 'matched' as const, value: state })
  }
  if (receipt?.id !== id) return Object.freeze({ state: 'unknown' as const })
  if (receipt.hash !== hash) fail('workspace_idempotency_conflict')
  if (receipt.syncEpoch !== state.sync.epoch || receipt.localVersion !== state.local.snapshot.localVersion
    || receipt.outboxVersion !== state.local.outbox.version) return Object.freeze({ state: 'unknown' as const })
  return Object.freeze({ state: 'matched' as const, value: state })
}

/** This persists delivery bookkeeping only, not a send or an acknowledgement. */
export async function transitionCloudDelivery(host: CloudWorkspaceHost, input: OwnerWorkspaceDeliveryRequest,
  guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState> {
  let request: OwnerWorkspaceDeliveryRequest
  try { request = validateOwnerWorkspaceDeliveryRequest(host.target, input) } catch { return fail('workspace_invalid_input') }
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  const entry = { ...baseline.slot.entry!, state: request.nextState }
  return host.commitCloud(request.expected, baseline, {
    outbox: { version: increment(baseline.slot.version), entry }, sync: baseline.sync!,
  }, 'delivery', guard)
}

/** Rehydrate the explicit supplied-response preview, then commit its complete
 * D base and resolved image together. Session/provenance stay in the guard and
 * coordinator; this primitive performs no IO beyond its private host's IDB.
 */
export async function ackCloud(host: CloudWorkspaceHost, input: OwnerWorkspaceAckCloudRequest,
  guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState> {
  let compiled: Awaited<ReturnType<typeof rehydrateOwnerWorkspaceAckCloudRequest>>
  try { compiled = await rehydrateOwnerWorkspaceAckCloudRequest(host.target, input) }
  catch { return fail('workspace_invalid_input') }
  const { request, preview } = compiled
  if (!preview.nextSnapshot || !preview.baseD || preview.issues.length || preview.conflicts.some(row => row.choice === null)) fail('workspace_conflict')
  const baseline = await host.readImage(guard)
  expectedImage(host, baseline, request.expected)
  const next = snapshot({ ...preview.nextSnapshot, localVersion: increment(baseline.working.snapshot.localVersion),
    entries: preview.nextSnapshot.entries.map(row => ({ ...row, local_pending: true })) })
  const outboxVersion = increment(baseline.slot.version), epoch = increment(baseline.sync!.epoch)
  const previousTimes = new Map(baseline.metadata.displayTimes.map(row => [row.key, row.updated_at]))
  const metadata = validateOwnerWorkspaceLocalMetadata({ ...baseline.metadata,
    displayTimes: next.entries.map(row => ({ key: row.key, updated_at: previousTimes.get(row.key) ?? null })),
    recentEdit: { id: request.id, hash: request.hash, beforeLocalVersion: baseline.working.snapshot.localVersion,
      localVersion: next.localVersion, outboxVersion } }, next)
  // Capacity is checked without dropping adoption or previous restore archives.
  await buildOwnerWorkspaceBackup({ snapshot: next, metadata })
  const outbox = { version: outboxVersion, entry: null }
  const sync = validateOwnerWorkspaceSyncMetadata({ ...baseline.sync, epoch, base: preview.baseD, pending: null,
    recentReceipt: { id: request.id, hash: request.hash, operation: 'ack', syncEpoch: epoch, outboxVersion,
      localVersion: next.localVersion } }, host.target, { snapshot: next, metadata, outbox })
  return host.commitCloud(request.expected, baseline, { outbox, sync, snapshot: next, metadata }, 'ack', guard)
}
export async function upgradeOwnerWorkspaceSync(host: CloudUpgradeHost, factory: IDBFactory,
  expected: OwnerWorkspaceLocalState, guard: OwnerWorkspaceGuard, signal: AbortSignal,
  abortCode: () => OwnerWorkspaceErrorCode): Promise<OwnerWorkspace> {
  const { target, openExistingWorkspace, strictProbe, working, checkedMetadata, localState, makeWorkspace } = host
    const existing = await openExistingWorkspace(factory, target, signal)
    try {
      const current = await existing.readLocalState(guard)
      if (canonical(current) !== canonical(expected)) fail('workspace_conflict')
    } finally { existing.close() }
    const version = await strictProbe(factory, target, { ...expected.outbox, resourceFingerprint: target }, signal)
    if (version !== 3) fail('workspace_invalid_database')
    assertGuard(guard)
    return await new Promise<OwnerWorkspace>((resolve, reject) => {
      let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, handle: OwnerWorkspace | undefined, settled = false
      const finish = (problem?: OwnerWorkspaceErrorCode) => {
        if (settled) return
        if (!problem) { try { assertGuard(guard) } catch (error) { problem = code(error) } }
        settled = true; signal.removeEventListener('abort', abort)
        if (problem) {
          try { tx?.abort() } catch { /* a completed versionchange remains visible */ }
          handle?.close(); db?.close(); reject(new OwnerWorkspaceError(problem))
        } else resolve(handle!)
      }
      const abort = () => finish(abortCode())
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      const readExpected = (transaction: IDBTransaction, accept: () => void) => {
        try {
          assertGuard(guard)
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
              assertGuard(guard)
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
        assertGuard(guard)
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
            assertGuard(guard)
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
              handle.readSyncState(guard).then(() => finish(), error => finish(code(error)))
            }
          } catch (error) { finish(code(error)) }
        }
      } catch (error) { finish(code(error)) }
    })

}
