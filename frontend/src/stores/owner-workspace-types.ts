/** Type-only workspace/host contracts. No runtime imports or capability creation. */
import type { OwnerCloudImportPlan, OwnerWorkspaceEntry, OwnerWorkspaceLegacy, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
import type { HoldingInput } from '@/utils/holding-editor'
import type { OwnerWorkspaceLocalMetadata, OwnerWorkspaceSourceArchive, OwnerWorkspaceBackup } from '@/utils/owner-workspace-backup'
import type { BuiltOwnerSyncRequest } from '@/utils/ownerSyncContract'
import type { ownerSyncOutboxStorage } from './ownerSyncOutbox'
import type { OwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'
import type { OwnerPortfolioLocal, OwnerPortfolioCommand } from '@/utils/ownerPortfolioLocal'
import type { OwnerPortfolioUpgradeIntent } from '@/utils/owner-portfolio-upgrade-intent'
import type { OwnerWorkspaceDeliveryRequest, OwnerWorkspaceAckCloudRequest } from './owner-workspace-delivery'
export type { OwnerWorkspaceDeliveryRequest, OwnerWorkspaceAckCloudRequest } from './owner-workspace-delivery'
export type { OwnerWorkspaceEntry, OwnerWorkspaceLegacy, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
export interface OwnerWorkspaceGuard {
  readonly signal: AbortSignal
  /** Must bind current consent, generation, full baseline and legacy raw source, as applicable. */
  assertActive(): void
}
export type OwnerWorkspaceErrorCode = 'workspace_invalid_target' | 'workspace_invalid_database' | 'workspace_invalid_input'
  | 'workspace_conflict' | 'workspace_pending' | 'workspace_idempotency_conflict' | 'workspace_capacity'
  | 'workspace_version_exhausted' | 'workspace_blocked' | 'workspace_timeout' | 'workspace_unavailable'
  | 'workspace_quota' | 'workspace_aborted' | 'workspace_closed' | 'workspace_context_changed' | 'workspace_noop'

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
  /** Physical v4/v5, including the entire common base and epoch. */
  readonly sync?: OwnerWorkspaceSyncMetadata
  /** Physical v5 only. Part of every exact local preimage, never legacy LS. */
  readonly portfolio?: OwnerPortfolioLocal
  readonly portfolioUpgrade?: OwnerPortfolioUpgradeIntent
}
export interface OwnerWorkspaceEditPortfolioRequest {
  readonly id: string; readonly hash: string; readonly expected: OwnerWorkspaceLocalState; readonly command: OwnerPortfolioCommand
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
  editPortfolio(request: OwnerWorkspaceEditPortfolioRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  restoreLocal(request: OwnerWorkspaceRestoreLocalRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceLocalState>
  /** Explicit physical-v4 primitives only. No HTTP, implicit upgrade, or cloud confirmation. */
  readSyncState(guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  linkCloudBase(request: OwnerWorkspaceLinkCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  prepareCloud(request: OwnerWorkspacePrepareCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  cancelPreparedCloud(request: OwnerWorkspaceCancelCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  transitionCloudDelivery(request: OwnerWorkspaceDeliveryRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  ackCloud(request: OwnerWorkspaceAckCloudRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
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
export interface WorkingRow { schema: 'owner-workspace-1'; targetFingerprint: string; snapshot: OwnerWorkspaceSnapshot }
export interface StoredReceipt {
  schema: 'owner-workspace-receipt-1'
  targetFingerprint: string
  receipt: OwnerWorkspaceReceipt
  before: OwnerWorkspaceSnapshot
  after: OwnerWorkspaceSnapshot
}
export type SlotRow = ReturnType<typeof ownerSyncOutboxStorage.rowShape>
export interface Image { slot: SlotRow; working: WorkingRow; metadata: OwnerWorkspaceLocalMetadata; sync: OwnerWorkspaceSyncMetadata | null;
  receipt: StoredReceipt | null; original: StoredReceipt | null; receiptCount: number; portfolio?: OwnerPortfolioLocal | null;
  portfolioUpgrade?: OwnerPortfolioUpgradeIntent | null }

export type LocalStateValidator = (input: unknown) => OwnerWorkspaceLocalState
export interface CloudPostimage {
  readonly outbox: OwnerWorkspaceLocalState['outbox']
  readonly sync: OwnerWorkspaceSyncMetadata
  readonly snapshot?: OwnerWorkspaceSnapshot
  readonly metadata?: OwnerWorkspaceLocalMetadata
}
export type CloudCommitMode = 'empty' | 'prepared' | 'delivery' | 'ack'
/** Private core-created capability; never accepted as a public open option. */
export interface CloudWorkspaceHost {
  readonly target: string
  readImage(guard: OwnerWorkspaceGuard): Promise<Image>
  toSyncState(image: Image): OwnerWorkspaceSyncState
  validateLocalState: LocalStateValidator
  commitCloud(expected: OwnerWorkspaceSyncState, baseline: Image, post: CloudPostimage,
    mode: CloudCommitMode, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceSyncState>
  assertActive(guard: OwnerWorkspaceGuard): void
}
export interface CloudUpgradeHost {
  readonly target: string
  openExistingWorkspace(factory: IDBFactory, target: string, signal: AbortSignal): Promise<OwnerWorkspace>
  strictProbe(factory: IDBFactory, target: string, baseline: SlotRow, signal: AbortSignal): Promise<number>
  working(value: unknown, target: string): WorkingRow
  checkedMetadata(value: unknown, snapshot: OwnerWorkspaceSnapshot): OwnerWorkspaceLocalMetadata
  localState(value: unknown, target: string): OwnerWorkspaceLocalState
  makeWorkspace(db: IDBDatabase, target: string): OwnerWorkspace
}
