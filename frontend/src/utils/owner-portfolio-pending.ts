/** Original full-profile packet verification, always outside IDB transactions.
 * Reconstruct only the original preparation envelope for comparison; never
 * replace the retained raw body, retry it, or grant remote acknowledgement. */
import { restoreOwnerSyncRequest, validateOwnerSyncRequest } from './ownerSyncContract'
import { planOwnerPortfolioCloudIntent } from './owner-portfolio-sync'
import { canonical, digest, fail } from '@/stores/owner-workspace-shared'
import type { Image, LocalStateValidator, OwnerWorkspaceFullSyncState } from '@/stores/owner-workspace-types'

export function fullSyncPendingPreimage(image: Image, epoch: number, preparedOutboxVersion: number): string {
  return canonical({ target: image.fullSync?.targetFingerprint, snapshot: image.working.snapshot,
    metadata: image.metadata, receiptCount: image.receiptCount, legacySync: image.sync,
    portfolio: image.portfolio, portfolioUpgrade: image.portfolioUpgrade, fullSyncUpgrade: image.fullSyncUpgrade,
    base: image.fullSync?.base, epoch, preparedOutboxVersion })
}
/** Both inputs have already passed their real closed codecs. Wire numeric zero
 * is equivalent; complete stored B/L retain their signed original numbers. */
export function fullSyncWire(input: unknown): string {
  return canonical(JSON.parse(JSON.stringify(input)))
}
export async function verifyOwnerPortfolioPending(image: Image, target: string,
  validateLocal: LocalStateValidator): Promise<void> {
  const pending = image.fullSync?.pending
  if (!pending) return
  try {
    const packet = await restoreOwnerSyncRequest(pending.rawBody, pending.requestHash)
    const beforeFull = { ...image.fullSync!, epoch: image.fullSync!.epoch - 1, pending: null }
    const local = validateLocal({ snapshot: image.working.snapshot,
      outbox: { version: pending.preparedOutboxVersion - 1, entry: null }, metadata: image.metadata,
      receiptCount: image.receiptCount, sync: image.sync, portfolio: image.portfolio,
      portfolioUpgrade: image.portfolioUpgrade, fullSync: beforeFull, fullSyncUpgrade: image.fullSyncUpgrade })
    const expected: OwnerWorkspaceFullSyncState = Object.freeze({ local, fullSync: local.fullSync! })
    const intent = planOwnerPortfolioCloudIntent(beforeFull.base, local.snapshot, local.portfolio)
    if (intent.issues.length || !intent.operations.length) fail('workspace_invalid_database')
    const intended = validateOwnerSyncRequest({ request_id: pending.requestId,
      expected_revision: pending.baseRevision, operations: intent.operations })
    if (packet.request.request_id !== pending.requestId || packet.request.expected_revision !== pending.baseRevision
      || fullSyncWire(intended) !== packet.rawBody
      || await digest(canonical({ operation: 'portfolio-cloud-prepare-1', target, id: pending.requestId,
        expected, packet })) !== pending.preparationHash
      || await digest(fullSyncPendingPreimage(image, image.fullSync!.epoch, pending.preparedOutboxVersion)) !== pending.preimageHash) fail('workspace_invalid_database')
  } catch { fail('workspace_invalid_database') }
}
