/** Full-profile supplied-response association and original operation seal.
 * Actual HTTP provenance/session authority belongs to the app-owned facade;
 * only the core can commit the separately verified complete local postimage. */
import { copyOwnerFullSyncInput } from '@/utils/owner-full-sync-input'
import { buildOwnerPortfolioAckPreview, type OwnerPortfolioAckPreview } from '@/utils/owner-portfolio-ack'
import { restoreOwnerSyncRequest } from '@/utils/ownerSyncContract'
import { validateFullSyncState } from './owner-workspace-full-sync'
import { canonical, closed, counter, digest, fail, HASH, localId } from './owner-workspace-shared'
import type { OwnerWorkspaceFullSyncAckInput, OwnerWorkspaceFullSyncAckRequest } from './owner-workspace-types'

const KEYS = ['id', 'expected', 'matchedResult', 'completeBaseline', 'minimumObservedRevision', 'resolutions']
async function compile(target: string, received: unknown): Promise<{ input: OwnerWorkspaceFullSyncAckInput; preview: OwnerPortfolioAckPreview }> {
  const row = copyOwnerFullSyncInput(received)
  if (!closed(row, KEYS) || typeof row.id !== 'string') fail('workspace_invalid_input')
  localId(target, row.id)
  const expected = await validateFullSyncState(target, row.expected), pending = expected.fullSync.pending
  const slot = expected.local.outbox.entry
  if (!pending || !slot || !['confirmed', 'conflict'].includes(slot.state) || !expected.fullSync.base || !expected.local.portfolio) fail('workspace_pending')
  if ([pending.requestId, expected.local.metadata.adoption?.id, expected.local.metadata.recentEdit?.id,
    expected.fullSync.recentReceipt?.id].includes(row.id)) fail('workspace_idempotency_conflict')
  const packet = await restoreOwnerSyncRequest(pending.rawBody, pending.requestHash)
  if (packet.request.request_id !== pending.requestId || packet.request.expected_revision !== pending.baseRevision) fail('workspace_invalid_input')
  const minimumObservedRevision = counter(row.minimumObservedRevision)
  const keyDigests = await Promise.all(packet.request.operations.map(async operation => ({ key: operation.key,
    digest: (await digest(operation.key)).slice(0, 16) })))
  const preview = buildOwnerPortfolioAckPreview({ base: expected.fullSync.base,
    localSnapshot: expected.local.snapshot, portfolio: expected.local.portfolio, packet,
    matchedResult: row.matchedResult, completeBaseline: row.completeBaseline,
    minimumObservedRevision, keyDigests, resolutions: row.resolutions })
  if (preview.issues.length || !preview.baseD || preview.outcome !== (slot.state === 'confirmed' ? 'success' : 'conflict')) fail('workspace_invalid_input')
  const input: OwnerWorkspaceFullSyncAckInput = Object.freeze({ id: row.id, expected,
    matchedResult: row.matchedResult as OwnerWorkspaceFullSyncAckInput['matchedResult'], completeBaseline: preview.baseD,
    minimumObservedRevision, resolutions: row.resolutions as OwnerWorkspaceFullSyncAckInput['resolutions'] })
  return { input, preview }
}
async function seal(target: string, compiled: Awaited<ReturnType<typeof compile>>): Promise<OwnerWorkspaceFullSyncAckRequest> {
  if (!compiled.preview.nextSnapshot || !compiled.preview.nextPortfolio || !compiled.preview.baseD) fail('workspace_conflict')
  return Object.freeze({ ...compiled.input, hash: await digest(canonical({ operation: 'portfolio-cloud-ack-1', target,
    input: compiled.input, preview: compiled.preview })) })
}
export async function previewOwnerWorkspaceFullSyncAck(target: string, input: OwnerWorkspaceFullSyncAckInput): Promise<OwnerPortfolioAckPreview> {
  return (await compile(target, input)).preview
}
export async function buildOwnerWorkspaceFullSyncAckRequest(target: string, input: OwnerWorkspaceFullSyncAckInput): Promise<OwnerWorkspaceFullSyncAckRequest> {
  return seal(target, await compile(target, input))
}
export async function rehydrateOwnerWorkspaceFullSyncAckRequest(target: string, received: OwnerWorkspaceFullSyncAckRequest) {
  const owned = copyOwnerFullSyncInput(received)
  if (!closed(owned, [...KEYS, 'hash']) || typeof owned.hash !== 'string' || !HASH.test(owned.hash)) fail('workspace_invalid_input')
  const input = Object.fromEntries(KEYS.map(key => [key, owned[key]]))
  const compiled = await compile(target, input), request = await seal(target, compiled)
  if (request.hash !== owned.hash) fail('workspace_invalid_input')
  return Object.freeze({ request, preview: compiled.preview })
}
