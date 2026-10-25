/** Explicit full-portfolio initial reconciliation. Pure preparation only; the
 * app-owned core performs the actual strict complete-image CAS. No HTTP/IDB. */
import { copyOwnerFullSyncInput } from '@/utils/owner-full-sync-input'
import { previewOwnerPortfolioInitialMerge } from '@/utils/owner-portfolio-merge'
import { validateOwnerWorkspaceLocalState } from './owner-workspace'
import { canonical, closed, code, counter, digest, fail, localId } from './owner-workspace-shared'
import type { OwnerWorkspaceFullSyncState, OwnerWorkspaceFullSyncLinkRequest,
  OwnerWorkspaceFullSyncPrepareRequest, OwnerWorkspaceFullSyncCancelRequest } from './owner-workspace-types'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'
import { buildOwnerSyncRequest, restoreOwnerSyncRequest, OwnerSyncContractError, type BuiltOwnerSyncRequest } from '@/utils/ownerSyncContract'

export async function validateFullSyncState(target: string, input: unknown): Promise<OwnerWorkspaceFullSyncState> {
  let owned: unknown
  try { owned = copyOwnerFullSyncInput(input) } catch (error) { return fail(code(error, 'workspace_invalid_input')) }
  if (!closed(owned, ['local', 'fullSync'])) fail('workspace_invalid_input')
  const local = await validateOwnerWorkspaceLocalState(target, owned.local)
  if (!local.fullSync || !local.fullSyncUpgrade || canonical(local.fullSync) !== canonical(owned.fullSync)) fail('workspace_invalid_input')
  return Object.freeze({ local, fullSync: local.fullSync })
}

export async function buildOwnerWorkspaceFullSyncPrepareRequest(target: string,
  input: Pick<OwnerWorkspaceFullSyncPrepareRequest, 'id' | 'expected'>): Promise<OwnerWorkspaceFullSyncPrepareRequest> {
  const owned = copyOwnerFullSyncInput(input)
  if (!closed(owned, ['id', 'expected']) || typeof owned.id !== 'string') fail('workspace_invalid_input')
  localId(target, owned.id)
  const expected = await validateFullSyncState(target, owned.expected)
  if (!expected.fullSync.base || expected.fullSync.pending || expected.local.outbox.entry || !expected.local.portfolio) fail('workspace_pending')
  const intent = planOwnerPortfolioCloudIntent(expected.fullSync.base, expected.local.snapshot, expected.local.portfolio)
  if (intent.issues.length) fail('workspace_conflict')
  if (!intent.operations.length) fail('workspace_noop')
  let packet: BuiltOwnerSyncRequest
  try {
    const built = await buildOwnerSyncRequest({ request_id: owned.id,
      expected_revision: expected.fullSync.base.pulledRevision, operations: intent.operations })
    packet = await restoreOwnerSyncRequest(built.rawBody, built.requestHash)
  } catch (error) {
    return fail(error instanceof OwnerSyncContractError && error.code === 'sync_hash_unavailable'
      ? 'workspace_unavailable' : error instanceof OwnerSyncContractError && error.code === 'invalid_sync_request'
        ? 'workspace_capacity' : 'workspace_invalid_input')
  }
  const copy = Object.freeze({ id: owned.id, expected, packet })
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'portfolio-cloud-prepare-1', target, ...copy })) })
}

export async function buildOwnerWorkspaceFullSyncCancelRequest(target: string,
  input: Omit<OwnerWorkspaceFullSyncCancelRequest, 'hash'>): Promise<OwnerWorkspaceFullSyncCancelRequest> {
  const owned = copyOwnerFullSyncInput(input)
  if (!closed(owned, ['id', 'expected', 'requestId', 'requestHash']) || typeof owned.id !== 'string' || typeof owned.requestId !== 'string') fail('workspace_invalid_input')
  localId(target, owned.id); localId(target, owned.requestId)
  if (owned.id === owned.requestId || typeof owned.requestHash !== 'string') fail('workspace_invalid_input')
  const expected = await validateFullSyncState(target, owned.expected), pending = expected.fullSync.pending
  if (expected.local.outbox.entry?.state !== 'prepared' || !pending
    || pending.requestId !== owned.requestId || pending.requestHash !== owned.requestHash) fail('workspace_pending')
  const copy = Object.freeze({ id: owned.id, expected, requestId: owned.requestId, requestHash: owned.requestHash })
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'portfolio-cloud-cancel-1', target, ...copy })) })
}
export async function buildOwnerWorkspaceFullSyncLinkRequest(target: string,
  input: Omit<OwnerWorkspaceFullSyncLinkRequest, 'hash'>): Promise<OwnerWorkspaceFullSyncLinkRequest> {
  let owned: unknown
  try { owned = copyOwnerFullSyncInput(input) } catch (error) { return fail(code(error, 'workspace_invalid_input')) }
  if (!closed(owned, ['id', 'expected', 'base', 'minimumObservedRevision', 'resolutions'])) fail('workspace_invalid_input')
  if (typeof owned.id !== 'string') fail('workspace_invalid_input')
  localId(target, owned.id)
  const expected = await validateFullSyncState(target, owned.expected), minimumObservedRevision = counter(owned.minimumObservedRevision)
  if (expected.local.outbox.entry !== null || expected.fullSync.pending !== null || expected.fullSync.base !== null
    || !expected.local.portfolio) fail('workspace_pending')
  const preview = previewOwnerPortfolioInitialMerge({ base: expected.local.sync?.base ?? null,
    localSnapshot: expected.local.snapshot, portfolio: expected.local.portfolio,
    completeBaseline: owned.base, minimumObservedRevision, resolutions: owned.resolutions })
  if (preview.issues.length || !preview.nextSnapshot || !preview.nextPortfolio || !preview.baseC) fail('workspace_conflict')
  const copy = Object.freeze({ id: owned.id as string, expected, base: preview.baseC,
    minimumObservedRevision, resolutions: owned.resolutions as OwnerWorkspaceFullSyncLinkRequest['resolutions'] })
  return Object.freeze({ ...copy, hash: await digest(canonical({ operation: 'portfolio-full-link-1', target, ...copy })) })
}
