/** Fixed complete-profile codec, preloaded by core before v6 transactions.
 * No crypto cache, async work, IDB, network or caller-injected validators. */
import { validateOwnerPortfolioSyncMetadata, type OwnerPortfolioSyncMetadataContext } from '@/utils/owner-portfolio-sync'
import { validateOwnerPortfolioSyncUpgradeIntent } from '@/utils/owner-portfolio-sync-intent'
import type { OwnerPortfolioLocal } from '@/utils/ownerPortfolioLocal'
import { canonical, fail } from './owner-workspace-shared'
import type { Image, OwnerWorkspaceFullSyncState } from './owner-workspace-types'

export * from '@/utils/owner-portfolio-sync'
export * from '@/utils/owner-portfolio-sync-intent'

export function validateFullSyncImage(input: unknown, intent: unknown, target: string,
  context: OwnerPortfolioSyncMetadataContext, portfolio: OwnerPortfolioLocal) {
  const fullSync = validateOwnerPortfolioSyncMetadata(input, target, context)
  const fullSyncUpgrade = validateOwnerPortfolioSyncUpgradeIntent(intent, target)
  if (fullSync.base) {
    const keys = new Set([...context.snapshot.entries.map(row => row.key), ...portfolio.manual.map(row => row.key)])
    if (fullSync.base.records.some(row => !keys.has(row.key))) fail('workspace_invalid_input')
  }
  return { fullSync, fullSyncUpgrade }
}

/** Called only on the core's already validated image. Monotonic full epoch,
 * immutable upgrade intent and historical v4 sync are profile invariants,
 * not substitutes for core's final full-image/slot CAS or crypto verification. */
export function assertFullSyncObservation(image: Image, previous: Image['fullSync'],
  intent: Image['fullSyncUpgrade'], historical: Image['sync']): void {
  if (previous && (!image.fullSync || image.fullSync.epoch < previous.epoch
    || image.fullSync.epoch === previous.epoch && canonical(image.fullSync) !== canonical(previous))) fail('workspace_invalid_database')
  if (intent && canonical(image.fullSyncUpgrade) !== canonical(intent)) fail('workspace_invalid_database')
  if (historical && canonical(image.sync) !== canonical(historical)) fail('workspace_invalid_database')
}

/** Read-only receipt classification after core has actually read and verified
 * the complete image and original pending hashes. This pure helper performs
 * no read/write and never authenticates caller-supplied state or allows replay. */
export function fullSyncReceiptOf(current: OwnerWorkspaceFullSyncState, id: string, hash: string) {
  const receipt = current.fullSync.recentReceipt
  if (current.fullSync.pending?.requestId === id) {
    if (current.fullSync.pending.preparationHash !== hash) fail('workspace_idempotency_conflict')
    return Object.freeze({ state: 'matched' as const, value: current })
  }
  if (receipt?.id !== id) return Object.freeze({ state: 'unknown' as const })
  if (receipt.hash !== hash) fail('workspace_idempotency_conflict')
  return receipt.localVersion === current.local.snapshot.localVersion && receipt.outboxVersion === current.local.outbox.version
    ? Object.freeze({ state: 'matched' as const, value: current }) : Object.freeze({ state: 'unknown' as const })
}
