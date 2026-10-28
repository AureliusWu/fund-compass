/** Complete B/L/D refresh without a packet, POST, receipt forgery or bootstrap.
 * The app-owned reader retains actual remote provenance; this local seal only
 * binds the exact source image, explicit choices and derived full postimage. */
import { copyOwnerFullSyncInput } from '@/utils/owner-full-sync-input'
import { previewOwnerPortfolioRefresh, type OwnerPortfolioRefreshPreview } from '@/utils/owner-portfolio-refresh'
import { validateFullSyncState } from './owner-workspace-full-sync'
import { canonical, closed, counter, digest, fail, HASH, localId } from './owner-workspace-shared'
import type { OwnerWorkspaceFullSyncRefreshInput, OwnerWorkspaceFullSyncRefreshRequest } from './owner-workspace-types'

const KEYS = ['id', 'expected', 'completeBaseline', 'minimumObservedRevision', 'resolutions']
async function compile(target: string, received: unknown): Promise<{ input: OwnerWorkspaceFullSyncRefreshInput; preview: OwnerPortfolioRefreshPreview }> {
  const row = copyOwnerFullSyncInput(received)
  if (!closed(row, KEYS) || typeof row.id !== 'string') fail('workspace_invalid_input')
  localId(target, row.id)
  const expected = await validateFullSyncState(target, row.expected)
  if (!expected.fullSync.base || expected.fullSync.pending !== null || expected.local.outbox.entry !== null
    || !expected.local.portfolio) fail('workspace_pending')
  if ([expected.local.metadata.adoption?.id, expected.local.metadata.recentEdit?.id,
    expected.fullSync.recentReceipt?.id].includes(row.id)) fail('workspace_idempotency_conflict')
  const minimumObservedRevision = counter(row.minimumObservedRevision)
  const preview = previewOwnerPortfolioRefresh({ base: expected.fullSync.base,
    localSnapshot: expected.local.snapshot, portfolio: expected.local.portfolio,
    completeBaseline: row.completeBaseline, minimumObservedRevision, resolutions: row.resolutions })
  if (preview.issues.length || !preview.baseD) fail('workspace_invalid_input')
  const input: OwnerWorkspaceFullSyncRefreshInput = Object.freeze({ id: row.id, expected,
    completeBaseline: preview.baseD, minimumObservedRevision,
    resolutions: row.resolutions as OwnerWorkspaceFullSyncRefreshInput['resolutions'] })
  return { input, preview }
}
async function seal(target: string, compiled: Awaited<ReturnType<typeof compile>>): Promise<OwnerWorkspaceFullSyncRefreshRequest> {
  if (!compiled.preview.nextSnapshot || !compiled.preview.nextPortfolio || !compiled.preview.baseD) fail('workspace_conflict')
  if (compiled.preview.noop) fail('workspace_noop')
  return Object.freeze({ ...compiled.input, hash: await digest(canonical({ operation: 'portfolio-cloud-refresh-1', target,
    input: compiled.input, preview: compiled.preview })) })
}
export async function previewOwnerWorkspaceFullSyncRefresh(target: string, input: OwnerWorkspaceFullSyncRefreshInput): Promise<OwnerPortfolioRefreshPreview> {
  return (await compile(target, input)).preview
}
export async function buildOwnerWorkspaceFullSyncRefreshRequest(target: string, input: OwnerWorkspaceFullSyncRefreshInput): Promise<OwnerWorkspaceFullSyncRefreshRequest> {
  return seal(target, await compile(target, input))
}
export async function rehydrateOwnerWorkspaceFullSyncRefreshRequest(target: string, received: OwnerWorkspaceFullSyncRefreshRequest) {
  const owned = copyOwnerFullSyncInput(received)
  if (!closed(owned, [...KEYS, 'hash']) || typeof owned.hash !== 'string' || !HASH.test(owned.hash)) fail('workspace_invalid_input')
  const input = Object.fromEntries(KEYS.map(key => [key, owned[key]]))
  const compiled = await compile(target, input), request = await seal(target, compiled)
  if (request.hash !== owned.hash) fail('workspace_invalid_input')
  return Object.freeze({ request, preview: compiled.preview })
}
