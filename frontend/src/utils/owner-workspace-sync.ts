/** Pure common-base planning. No storage, clocks, credentials, consent or IO.
 * A structurally complete DTO is not proof of service identity/full pagination.
 * Callers must retain the actually applied common B; a new cloud observation C
 * must never replace B when deriving the user's B -> L intent.
 */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import { OwnerWorkspaceSyncError } from './owner-workspace-sync-errors'
import { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'
export { OwnerWorkspaceSyncError } from './owner-workspace-sync-errors'
export { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'
import {
  validateOwnerWorkspaceEntries, validateOwnerWorkspaceSnapshot,
  OwnerCloudImportError,
  type OwnerWorkspaceEntry, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'
import {
  compareSyncKeys,
  type OwnerSyncOperation, type OwnerSyncRecord, type OwnerSyncValues,
} from './ownerSyncContract'

export type OwnerWorkspaceSyncIssueCode = 'invalid_baseline' | 'invalid_workspace' | 'capacity_exceeded'
  | 'cloud_tombstone' | 'same_key_difference' | 'missing_value' | 'invalid_operation' | 'missing_workspace_record'
export interface OwnerWorkspaceSyncIssue { readonly code: OwnerWorkspaceSyncIssueCode; readonly key: string | null }
export interface OwnerWorkspaceCloudIntent {
  readonly operations: readonly OwnerSyncOperation[]
  readonly issues: readonly OwnerWorkspaceSyncIssue[]
}
export interface OwnerWorkspaceCloudLinkPreview {
  readonly base: OwnerSyncBaseline
  readonly snapshot: OwnerWorkspaceSnapshot
  readonly issues: readonly OwnerWorkspaceSyncIssue[]
  readonly addedKeys: readonly string[]
}

const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
function fail(code: OwnerWorkspaceSyncError['code']): never { throw new OwnerWorkspaceSyncError(code) }
function capacityError(error: unknown): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return (error instanceof OwnerWorkspaceSyncError || error instanceof OwnerCloudImportError)
      && !!descriptor && 'value' in descriptor && descriptor.value === 'capacity_exceeded'
  } catch { return false }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function workspace(input: unknown): OwnerWorkspaceSnapshot {
  try { return validateOwnerWorkspaceSnapshot(input) }
  catch (error) {
    return fail(capacityError(error) ? 'capacity_exceeded' : 'invalid_workspace')
  }
}
function errorCode(error: unknown): OwnerWorkspaceSyncIssueCode {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    if (error instanceof OwnerWorkspaceSyncError && descriptor && 'value' in descriptor
      && ['invalid_baseline', 'invalid_workspace', 'capacity_exceeded'].includes(descriptor.value)) return descriptor.value
  } catch { /* Untrusted thrown objects cannot contribute getters/private codes. */ }
  return 'invalid_operation'
}
function fullBase(record: OwnerSyncRecord): OwnerSyncValues {
  return { ...record.values, kind: record.kind, deleted: record.deleted }
}
function sameBusiness(first: OwnerWorkspaceEntry, second: OwnerWorkspaceEntry): boolean {
  return first.key === second.key && first.kind === second.kind && first.deleted === second.deleted
    && FUND_FIELDS.every(field => Object.is(first.values[field], second.values[field]))
}

/** Derive only B -> L; not a C -> L overwrite or cloud rebase.
 * Finite numeric +/-0 are the same business value in the backend's _same_value
 * contract. Treat that as no intent without modifying either original image.
 * Missing linked fund records are invalid full workspace images, never delete
 * intent: ordinary local removal must retain its tombstone. The caller MUST use
 * buildOwnerSyncRequest for the 200-operation/128-KiB final packet limits;
 * this helper never trims, splits, hashes, sends or silently drops operations.
 */
export function planOwnerWorkspaceCloudIntent(base: unknown, localSnapshot: unknown): OwnerWorkspaceCloudIntent {
  const operations: OwnerSyncOperation[] = [], issues: OwnerWorkspaceSyncIssue[] = []
  const finish = (): OwnerWorkspaceCloudIntent => freeze({ operations: issues.length ? [] : operations, issues })
  let baseline: OwnerSyncBaseline, local: OwnerWorkspaceSnapshot
  try { baseline = validateOwnerWorkspaceCloudBaseline(base) }
  catch (error) { issues.push({ code: errorCode(error), key: null }); return finish() }
  try { local = workspace(localSnapshot) }
  catch (error) { issues.push({ code: errorCode(error), key: null }); return finish() }
  const previous = new Map(baseline.records.map(record => [record.key, record]))
  const localKeys = new Set(local.entries.map(entry => entry.key))
  for (const record of baseline.records) if (record.kind !== 'manual_asset' && !localKeys.has(record.key)) {
    issues.push({ code: 'missing_workspace_record', key: record.key })
  }
  if (issues.length) return finish()
  for (const entry of local.entries) {
    const before = previous.get(entry.key)
    // A fund workspace cannot contain an asset key; its full cloud record is
    // retained in B but cannot be translated to a made-up fund operation.
    if (before?.kind === 'manual_asset') { issues.push({ code: 'invalid_operation', key: entry.key }); continue }
    if (entry.deleted) {
      if (!before || before.deleted) continue
      if (before.kind !== entry.kind) { issues.push({ code: 'invalid_operation', key: entry.key }); continue }
      operations.push({ key: entry.key, kind: before.kind, deleted: true, base_values: fullBase(before) })
      continue
    }
    if (before?.deleted) { issues.push({ code: 'cloud_tombstone', key: entry.key }); continue }
    if (!before || before.kind !== entry.kind) {
      // The backend requires complete fresh holding input on create/kind
      // change. Existing holding patches may still keep unknown shares null.
      if (entry.kind === 'holding' && entry.values.shares === null) {
        issues.push({ code: 'missing_value', key: entry.key }); continue
      }
      operations.push({ key: entry.key, kind: entry.kind, deleted: false, changes: { ...entry.values },
        base_values: before ? fullBase(before) : {} })
      continue
    }
    const fields = FUND_FIELDS.filter(field => before.values[field] !== entry.values[field])
    if (!fields.length) continue
    operations.push({ key: entry.key, kind: entry.kind, deleted: false,
      changes: Object.fromEntries(fields.map(field => [field, entry.values[field]])),
      // Unedited fields MUST NOT become guards: another device may edit a
      // different field since B without manufacturing a conflict here.
      base_values: { kind: before.kind, deleted: false,
        ...Object.fromEntries(fields.map(field => [field, before.values[field]])) } })
  }
  return finish()
}

/** Explicit initial-link preview, not an apply/ack or cloud identity proof.
 * Accept only equal same-key full business images or cloud-only additions.
 * Manual assets remain completely in base but are not imported as funds.
 * A single conflict/capacity issue retains the entire original snapshot.
 * No timestamps, revisions, localVersion changes or confirmation are invented.
 */
export function buildOwnerWorkspaceCloudLinkPreview(completeBaseline: unknown,
  localSnapshot: unknown): OwnerWorkspaceCloudLinkPreview {
  const base = validateOwnerWorkspaceCloudBaseline(completeBaseline), local = workspace(localSnapshot)
  const issues: OwnerWorkspaceSyncIssue[] = [], additions: OwnerWorkspaceEntry[] = []
  const existing = new Map(local.entries.map(entry => [entry.key, entry]))
  for (const record of [...base.records].sort((left, right) => compareSyncKeys(left.key, right.key))) {
    if (record.kind === 'manual_asset') continue
    const cloud: OwnerWorkspaceEntry = { key: record.key, kind: record.kind, deleted: record.deleted,
      values: { name: record.values.name as string, shares: record.values.shares as number | null,
        cost: record.values.cost as number | null, target_weight: record.values.target_weight as number | null },
      local_pending: true }
    const current = existing.get(record.key)
    if (!current) additions.push(cloud)
    else if (!sameBusiness(current, cloud)) issues.push({ code: 'same_key_difference', key: record.key })
  }
  let snapshot = local
  if (!issues.length && additions.length) {
    try {
      snapshot = freeze({ localVersion: local.localVersion,
        entries: validateOwnerWorkspaceEntries([...local.entries, ...additions]), legacy: local.legacy })
    } catch (error) {
      issues.push({ code: capacityError(error) ? 'capacity_exceeded' : 'invalid_workspace', key: null })
    }
  }
  return freeze({ base, snapshot: issues.length ? local : snapshot, issues,
    addedKeys: issues.length ? [] : additions.map(entry => entry.key) })
}
