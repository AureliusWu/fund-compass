/** Candidate-only local import planning. No storage, session, Gist or network IO. */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import { validateOwnerSyncRecord, compareSyncKeys, OWNER_SYNC_MAX_RESPONSE_BYTES,
  type OwnerSyncRecord } from '@/utils/ownerSyncContract'

export const OWNER_WORKSPACE_MAX_ENTRIES = 100_000
export const OWNER_WORKSPACE_MAX_IMAGE_BYTES = OWNER_SYNC_MAX_RESPONSE_BYTES
export const OWNER_CLOUD_IMPORT_MAX_PLAN_BYTES = 8 * 1024 * 1024
export const OWNER_CLOUD_IMPORT_SCHEMA = 'owner-cloud-import-1' as const

export interface OwnerWorkspaceValues {
  readonly name: string
  readonly shares: number | null
  readonly cost: number | null
  readonly target_weight: number | null
}
export interface OwnerWorkspaceEntry {
  readonly key: string
  readonly kind: 'watch' | 'holding'
  readonly deleted: boolean
  readonly values: OwnerWorkspaceValues
  readonly local_pending: boolean
}
export interface OwnerWorkspaceLegacy {
  readonly sourceKey: 'sinan_watchlist_v1' | 'sinan_watchlist_v2'
  readonly raw: string | null
}
export interface OwnerWorkspaceSnapshot {
  readonly localVersion: number
  readonly entries: readonly OwnerWorkspaceEntry[]
  readonly legacy: OwnerWorkspaceLegacy | null
}
export interface OwnerCloudImportPlan {
  readonly schema: typeof OWNER_CLOUD_IMPORT_SCHEMA
  readonly targetFingerprint: string
  readonly pulledRevision: number
  readonly preimage: readonly OwnerWorkspaceEntry[]
  readonly postimage: readonly OwnerWorkspaceEntry[]
  readonly excludedManualAssets: number
}
export type OwnerCloudImportErrorCode = 'invalid_baseline' | 'invalid_workspace' | 'invalid_plan'
  | 'invalid_target' | 'target_mismatch' | 'capacity_exceeded' | 'hash_unavailable'
export class OwnerCloudImportError extends Error {
  constructor(readonly code: OwnerCloudImportErrorCode) {
    super('Owner cloud import rejected')
    this.name = 'OwnerCloudImportError'
  }
}
export interface OwnerCloudImportPreviewRow {
  readonly key: string
  readonly kind: 'watch' | 'holding'
  readonly action: 'add' | 'noop' | 'conflict'
  readonly before: OwnerWorkspaceEntry | null
  readonly after: OwnerWorkspaceEntry
}
export interface OwnerCloudImportPreview {
  readonly rows: readonly OwnerCloudImportPreviewRow[]
  readonly issues: readonly { readonly code: OwnerCloudImportErrorCode | 'same_key_difference'; readonly key: string | null }[]
  readonly counts: Readonly<{ added: number; noops: number; conflicts: number; excludedManualAssets: number; retainedLocal: number }> | null
  readonly plan: OwnerCloudImportPlan | null
}

const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
const TARGET = /^[0-9a-f]{64}(?![\s\S])/
const encoder = new TextEncoder()
function fail(code: OwnerCloudImportErrorCode): never { throw new OwnerCloudImportError(code) }
function scalar(value: unknown, code: OwnerCloudImportErrorCode): asserts value is string {
  if (typeof value !== 'string') fail(code)
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(code)
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail(code)
  }
}
function closed(value: unknown, keys: readonly string[], code: OwnerCloudImportErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) fail(code)
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
function list(value: unknown, code: OwnerCloudImportErrorCode): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code)
  if (value.length > OWNER_WORKSPACE_MAX_ENTRIES) fail('capacity_exceeded')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).some((key, index) => key !== String(index))
    || Object.entries(descriptors).some(([key, item]) => !('value' in item) || key !== 'length' && !item.enumerable)) fail(code)
  return value
}
function revision(value: unknown, code: OwnerCloudImportErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail(code)
  return value
}
function target(value: unknown): string {
  if (typeof value !== 'string' || !TARGET.test(value)) fail('invalid_target')
  return value
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}
/** Only validated closed ASCII object fields enter canonicalization; array order is part of the full image. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  // Do not hide a JS before-image difference behind JSON.stringify(-0) === '0'.
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}
function bounded(raw: string, maximum: number): string {
  if (raw.length > maximum || encoder.encode(raw).byteLength > maximum) fail('capacity_exceeded')
  return raw
}
function entry(value: unknown): OwnerWorkspaceEntry {
  const row = closed(value, ['key', 'kind', 'deleted', 'values', 'local_pending'], 'invalid_workspace')
  if ((row.kind !== 'watch' && row.kind !== 'holding') || typeof row.local_pending !== 'boolean') fail('invalid_workspace')
  let record: OwnerSyncRecord
  try {
    // Reuse the real DTO's finance/key grammar. These validation-only stamps
    // are never persisted/exported and are not a cloud or HoldingVersion claim.
    record = validateOwnerSyncRecord({ key: row.key, kind: row.kind, deleted: row.deleted,
      values: row.values, record_revision: 1, lifecycle_revision: 1,
      field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 } }, 1)
  } catch { return fail('invalid_workspace') }
  const values: OwnerWorkspaceValues = { name: record.values.name as string,
    shares: record.values.shares as number | null, cost: record.values.cost as number | null,
    target_weight: record.values.target_weight as number | null }
  return frozen({ key: record.key, kind: row.kind, deleted: record.deleted, values, local_pending: row.local_pending })
}
export function validateOwnerWorkspaceEntries(input: unknown): readonly OwnerWorkspaceEntry[] {
  const result: OwnerWorkspaceEntry[] = [], seen = new Set<string>()
  let bytes = 2
  for (const source of list(input, 'invalid_workspace')) {
    const value = entry(source)
    if (seen.has(value.key)) fail('invalid_workspace')
    seen.add(value.key)
    bytes += encoder.encode(canonical(value)).byteLength + (result.length ? 1 : 0)
    if (bytes > OWNER_WORKSPACE_MAX_IMAGE_BYTES) fail('capacity_exceeded')
    result.push(value)
  }
  return frozen(result)
}
export function canonicalOwnerWorkspaceEntries(input: unknown): string {
  return canonical(validateOwnerWorkspaceEntries(input))
}
export function validateOwnerWorkspaceLegacy(input: unknown): OwnerWorkspaceLegacy | null {
  if (input === null) return null
  const row = closed(input, ['sourceKey', 'raw'], 'invalid_workspace')
  if (row.sourceKey !== 'sinan_watchlist_v1' && row.sourceKey !== 'sinan_watchlist_v2') fail('invalid_workspace')
  if (row.raw !== null) { scalar(row.raw, 'invalid_workspace'); bounded(row.raw, OWNER_WORKSPACE_MAX_IMAGE_BYTES) }
  return frozen({ sourceKey: row.sourceKey, raw: row.raw as string | null })
}
export function validateOwnerWorkspaceSnapshot(input: unknown): OwnerWorkspaceSnapshot {
  const row = closed(input, ['localVersion', 'entries', 'legacy'], 'invalid_workspace')
  return frozen({ localVersion: revision(row.localVersion, 'invalid_workspace'),
    entries: validateOwnerWorkspaceEntries(row.entries), legacy: validateOwnerWorkspaceLegacy(row.legacy) })
}
function baseline(input: unknown): OwnerSyncBaseline {
  const row = closed(input, ['pulledRevision', 'records'], 'invalid_baseline')
  const upper = revision(row.pulledRevision, 'invalid_baseline')
  const records: OwnerSyncRecord[] = [], seen = new Set<string>()
  let maximum = 0, bytes = 2
  for (const source of list(row.records, 'invalid_baseline')) {
    let record: OwnerSyncRecord
    try { record = validateOwnerSyncRecord(source, upper) } catch { return fail('invalid_baseline') }
    if (seen.has(record.key)) fail('invalid_baseline')
    seen.add(record.key); maximum = Math.max(maximum, record.record_revision)
    bytes += encoder.encode(canonical(record)).byteLength + (records.length ? 1 : 0)
    if (bytes > OWNER_SYNC_MAX_RESPONSE_BYTES) fail('capacity_exceeded')
    records.push(record)
  }
  // Persistent tombstones are retained: a nonzero full head needs its latest
  // current record. This rejects obvious partial input, not authenticated proof
  // that every page was fetched; the caller's current getBaseline/guard owns that.
  if (maximum !== upper) fail('invalid_baseline')
  return frozen({ pulledRevision: upper, records })
}
export function validateOwnerCloudImportPlan(input: unknown, expectedTarget?: string): OwnerCloudImportPlan {
  const row = closed(input, ['schema', 'targetFingerprint', 'pulledRevision', 'preimage', 'postimage', 'excludedManualAssets'], 'invalid_plan')
  if (row.schema !== OWNER_CLOUD_IMPORT_SCHEMA) fail('invalid_plan')
  const fingerprint = target(row.targetFingerprint)
  if (expectedTarget !== undefined && target(expectedTarget) !== fingerprint) fail('target_mismatch')
  const pulledRevision = revision(row.pulledRevision, 'invalid_plan')
  if (pulledRevision === 0) fail('invalid_plan')
  const excludedManualAssets = revision(row.excludedManualAssets, 'invalid_plan')
  if (excludedManualAssets > OWNER_WORKSPACE_MAX_ENTRIES) fail('capacity_exceeded')
  const preimage = validateOwnerWorkspaceEntries(row.preimage), postimage = validateOwnerWorkspaceEntries(row.postimage)
  // This slice adds only. No reorder, deletion, same-key edit, or pending clear
  // can enter a transaction through a hand-crafted plan, even with a new hash.
  if (postimage.length <= preimage.length) fail('invalid_plan')
  if (excludedManualAssets + postimage.length - preimage.length > OWNER_WORKSPACE_MAX_ENTRIES) fail('capacity_exceeded')
  for (let index = 0; index < preimage.length; index++) if (canonical(preimage[index]) !== canonical(postimage[index])) fail('invalid_plan')
  if (postimage.slice(preimage.length).some(value => value.local_pending !== true)) fail('invalid_plan')
  const result: OwnerCloudImportPlan = { schema: OWNER_CLOUD_IMPORT_SCHEMA, targetFingerprint: fingerprint,
    pulledRevision, preimage, postimage, excludedManualAssets }
  bounded(canonical(result), OWNER_CLOUD_IMPORT_MAX_PLAN_BYTES)
  return frozen(result)
}
export function canonicalOwnerCloudImportPlan(input: unknown, expectedTarget?: string): string {
  return canonical(validateOwnerCloudImportPlan(input, expectedTarget))
}
/** Plan-only digest, not the id/version-bound receipt hash. Complete before opening IDB. */
export async function hashOwnerCloudImportPlan(input: unknown, expectedTarget?: string): Promise<string> {
  const raw = canonicalOwnerCloudImportPlan(input, expectedTarget)
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(raw))
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  } catch { return fail('hash_unavailable') }
}
function fromCloud(record: OwnerSyncRecord): OwnerWorkspaceEntry {
  return entry({ key: record.key, kind: record.kind, deleted: record.deleted, values: record.values, local_pending: true })
}
function sameBusiness(first: OwnerWorkspaceEntry, second: OwnerWorkspaceEntry): boolean {
  return first.key === second.key && first.kind === second.kind && first.deleted === second.deleted
    && FUND_FIELDS.every(field => Object.is(first.values[field], second.values[field]))
}

/** Input must come from the current completed candidate baseline, never a POST result/page. */
export function buildCloudImportPreview(completeBaseline: unknown, workspaceSnapshot: unknown,
  targetFingerprint: string): OwnerCloudImportPreview {
  const rows: OwnerCloudImportPreviewRow[] = [], issues: OwnerCloudImportPreview['issues'][number][] = []
  try {
    const fingerprint = target(targetFingerprint), cloud = baseline(completeBaseline)
    const snapshot = validateOwnerWorkspaceSnapshot(workspaceSnapshot)
    const local = new Map(snapshot.entries.map(value => [value.key, value]))
    const additions: OwnerWorkspaceEntry[] = []
    let excludedManualAssets = 0, noops = 0, conflicts = 0
    for (const record of [...cloud.records].sort((first, second) => compareSyncKeys(first.key, second.key))) {
      if (record.kind === 'manual_asset') { excludedManualAssets++; continue }
      const after = fromCloud(record), before = local.get(record.key) ?? null
      const action = before === null ? 'add' : sameBusiness(before, after) ? 'noop' : 'conflict'
      if (action === 'add') additions.push(after)
      if (action === 'noop') noops++
      if (action === 'conflict') { conflicts++; issues.push({ code: 'same_key_difference', key: record.key }) }
      rows.push({ key: record.key, kind: after.kind, action, before, after: action === 'noop' ? before! : after })
    }
    const counts = { added: additions.length, noops, conflicts, excludedManualAssets, retainedLocal: snapshot.entries.length }
    const plan = issues.length || additions.length === 0 ? null : validateOwnerCloudImportPlan({
      schema: OWNER_CLOUD_IMPORT_SCHEMA, targetFingerprint: fingerprint, pulledRevision: cloud.pulledRevision,
      preimage: snapshot.entries, postimage: [...snapshot.entries, ...additions], excludedManualAssets }, fingerprint)
    return frozen({ rows, issues, counts, plan })
  } catch (error) {
    const code = error instanceof OwnerCloudImportError ? error.code : 'invalid_baseline'
    return frozen({ rows: [], issues: [{ code, key: null }], counts: null, plan: null })
  }
}
