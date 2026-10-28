/** Fixed v5/v6 local-portfolio shape codec. Loaded by core before any related
 * transaction; synchronous and no IO. It grants no writer or guard capability. */
import { validateOwnerPortfolioLocal } from '@/utils/ownerPortfolioLocal'
import { validateOwnerPortfolioUpgradeIntent } from '@/utils/owner-portfolio-upgrade-intent'
import { closed, fail } from './owner-workspace-shared'
import { canonicalOwnerLocal, OWNER_WORKSPACE_BACKUP_MAX_BYTES, type OwnerWorkspaceLocalMetadata } from '@/utils/owner-workspace-backup'
import type { OwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'
import type { SlotRow, OwnerWorkspaceLocalState } from './owner-workspace-types'

export * from '@/utils/ownerPortfolioLocal'
export * from '@/utils/owner-portfolio-upgrade-intent'

/** Complete recovery envelope limit, including escaped original archives.
 * Always recomputed from the actual image; not a per-store cap or SHA cache. */
export function assertPortfolioRecoveryCapacity(target: string, state: OwnerWorkspaceLocalState): void {
  if (!state.portfolio) return
  const raw = canonicalOwnerLocal({ format: state.fullSync ? 'sinan-owner-workspace-recovery-3' : 'sinan-owner-workspace-recovery-2',
    physicalVersion: state.fullSync ? 6 : 5, targetFingerprint: target, local: state })
  if (raw.length > OWNER_WORKSPACE_BACKUP_MAX_BYTES || new TextEncoder().encode(raw).byteLength > OWNER_WORKSPACE_BACKUP_MAX_BYTES) fail('workspace_capacity')
}

export function validatePortfolioState(input: unknown, intent: unknown, target: string,
  slot: SlotRow, sync: OwnerWorkspaceSyncMetadata | null, metadata: OwnerWorkspaceLocalMetadata,
  receiptCount: number, full: boolean) {
  const portfolio = validateOwnerPortfolioLocal(input)
  const portfolioUpgrade = validateOwnerPortfolioUpgradeIntent(intent, target, portfolio.migration.sourceSha256)
  if (slot.entry !== null && !full || sync?.pending !== null || !metadata.adoption || receiptCount !== 0) fail('workspace_invalid_input')
  return { portfolio, portfolioUpgrade }
}
export function validateStoredPortfolio(row: unknown, count: unknown, intent: unknown, target: string,
  slot: SlotRow, sync: OwnerWorkspaceSyncMetadata | null, metadata: OwnerWorkspaceLocalMetadata,
  receiptCount: number, full: boolean) {
  if (count !== 2 || !closed(row, ['schema', 'targetFingerprint', 'portfolio'])
    || row.schema !== 'owner-workspace-portfolio-1' || row.targetFingerprint !== target) fail('workspace_invalid_database')
  return validatePortfolioState(row.portfolio, intent, target, slot, sync, metadata, receiptCount, full)
}
