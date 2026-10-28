/** Pure, closed three-way acknowledgement planning. No IO, clocks or crypto.
 * The guarded caller must restore the original SHA-bound packet, bind the raw
 * response to its real session/id/hash and prove a complete fixed-upper pull.
 * Supplied digests are checked as a closed association, not authenticated here.
 * A POST's partial records never become the new common cloud base.
 */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import {
  validateOwnerWorkspaceEntries, validateOwnerWorkspaceSnapshot,
  type OwnerWorkspaceEntry, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'
import { planOwnerWorkspaceCloudIntent, validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync'
import {
  compareSyncKeys, isOwnerSyncRequestHash, OWNER_SYNC_MAX_BODY_BYTES, OWNER_SYNC_MAX_OPERATIONS,
  parseSyncReceiptResponse, parseSyncWriteResponse, validateOwnerSyncRequest,
  type BuiltOwnerSyncRequest, type OwnerSyncConflict, type OwnerSyncOperation,
  type OwnerSyncRecord, type OwnerSyncWriteResult,
} from './ownerSyncContract'

export type OwnerWorkspaceAckField = 'name' | 'shares' | 'cost' | 'target_weight' | 'lifecycle' | 'rename'
export interface OwnerWorkspaceAckResolution {
  readonly key: string
  readonly field: OwnerWorkspaceAckField
  readonly choice: 'local' | 'cloud'
}
export interface OwnerWorkspaceAckRawMatched {
  readonly source: 'write' | 'receipt'
  readonly requestId: string
  readonly requestHash: string
  readonly status: number
  readonly rawBody: string
}
export interface OwnerWorkspaceAckInput {
  readonly base: OwnerSyncBaseline
  readonly localSnapshot: OwnerWorkspaceSnapshot
  readonly packet: BuiltOwnerSyncRequest
  readonly matchedResult: OwnerWorkspaceAckRawMatched
  readonly completeBaseline: OwnerSyncBaseline
  readonly minimumObservedRevision: number
  readonly keyDigests: readonly { readonly key: string; readonly digest: string }[]
  readonly resolutions: readonly OwnerWorkspaceAckResolution[]
}
export type OwnerWorkspaceAckIssueCode = 'invalid_input' | 'invalid_baseline' | 'invalid_workspace'
  | 'invalid_packet' | 'intent_mismatch' | 'invalid_result' | 'result_mismatch' | 'invalid_digests'
  | 'baseline_regression' | 'missing_cloud_record' | 'invalid_resolution' | 'capacity_exceeded'
export type OwnerWorkspaceAckConflictReason = 'field_changed' | 'field_aba' | 'lifecycle_changed'
  | 'lifecycle_aba' | 'creation_collision' | 'server_conflict' | 'cloud_tombstone' | 'rename_atomic'
export interface OwnerWorkspaceAckConflict {
  readonly key: string
  readonly field: OwnerWorkspaceAckField
  readonly reason: OwnerWorkspaceAckConflictReason
  readonly base: OwnerWorkspaceEntry | null
  readonly local: OwnerWorkspaceEntry | null
  readonly cloud: OwnerWorkspaceEntry | null
  readonly groupKeys: readonly string[]
  readonly localAllowed: boolean
  readonly choice: 'local' | 'cloud' | null
}
export interface OwnerWorkspaceAckRow {
  readonly key: string
  readonly before: OwnerWorkspaceEntry | null
  readonly after: OwnerWorkspaceEntry | null
  readonly fields: readonly OwnerWorkspaceAckField[]
}
export interface OwnerWorkspaceAckPreview {
  readonly schema: 'owner-workspace-ack-preview-1'
  readonly outcome: 'success' | 'conflict' | null
  readonly issues: readonly { readonly code: OwnerWorkspaceAckIssueCode; readonly key: string | null }[]
  readonly conflicts: readonly OwnerWorkspaceAckConflict[]
  readonly rows: readonly OwnerWorkspaceAckRow[]
  readonly nextSnapshot: OwnerWorkspaceSnapshot | null
  readonly baseD: OwnerSyncBaseline | null
  readonly changedKeys: readonly string[]
  readonly excludedManualAssets: number
}

const FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
type FundField = typeof FIELDS[number]
const CHOICES = ['local', 'cloud'] as const
const ALL_FIELDS: readonly OwnerWorkspaceAckField[] = [...FIELDS, 'lifecycle', 'rename']
const encoder = new TextEncoder()
class Rejected extends Error {
  constructor(readonly code: OwnerWorkspaceAckIssueCode, readonly key: string | null = null) { super('Owner acknowledgement rejected') }
}
function reject(code: OwnerWorkspaceAckIssueCode, key: string | null = null): never { throw new Rejected(code, key) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function closed(input: unknown, keys: readonly string[], code: OwnerWorkspaceAckIssueCode): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject(code)
  const properties = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(properties, key))
    || Object.values(properties).some(item => !item.enumerable || !('value' in item))) reject(code)
  return Object.fromEntries(keys.map(key => [key, properties[key].value]))
}
function list(input: unknown, max: number, code: OwnerWorkspaceAckIssueCode): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > max
    || Reflect.ownKeys(input).length !== input.length + 1
    || Object.keys(input).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(input)).some(([key, item]) =>
      !('value' in item) || key !== 'length' && !item.enumerable)) reject(code)
  return input
}
// Applied only to copied, already validated native DTOs. JSON wire semantics
// intentionally equate +/-0; B and L themselves retain their original numbers.
function wire(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(wire).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + wire(row[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function baseline(input: unknown): OwnerSyncBaseline {
  try { return validateOwnerWorkspaceCloudBaseline(input) } catch { return reject('invalid_baseline') }
}
function snapshot(input: unknown): OwnerWorkspaceSnapshot {
  try { return validateOwnerWorkspaceSnapshot(input) } catch { return reject('invalid_workspace') }
}
function fund(record: OwnerSyncRecord | undefined): OwnerWorkspaceEntry | null {
  if (!record || record.kind === 'manual_asset') return null
  return { key: record.key, kind: record.kind, deleted: record.deleted, local_pending: true,
    values: { name: record.values.name as string, shares: record.values.shares as number | null,
      cost: record.values.cost as number | null, target_weight: record.values.target_weight as number | null } }
}
function pending(entry: OwnerWorkspaceEntry): OwnerWorkspaceEntry {
  return { ...entry, values: { ...entry.values }, local_pending: true }
}
function fromCloud(record: OwnerSyncRecord | undefined, local?: OwnerWorkspaceEntry): OwnerWorkspaceEntry | null {
  const value = fund(record)
  if (!value) return null
  // Preserve the user's signed zero when the wire/business value is equal.
  if (local) for (const field of FIELDS) if (local.values[field] === value.values[field]) {
    ;(value.values as unknown as Record<string, unknown>)[field] = local.values[field]
  }
  return value
}
function same(first: OwnerWorkspaceEntry | null, second: OwnerWorkspaceEntry | null): boolean {
  if (!first || !second) return first === second
  return first.key === second.key && first.kind === second.kind && first.deleted === second.deleted
    && FIELDS.every(field => first.values[field] === second.values[field])
}
function revision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) reject('invalid_input')
  return input
}
function packet(input: unknown, base: OwnerSyncBaseline, local: OwnerWorkspaceSnapshot): BuiltOwnerSyncRequest {
  try {
    const row = closed(input, ['request', 'rawBody', 'requestHash', 'byteLength'], 'invalid_packet')
    const request = validateOwnerSyncRequest(row.request)
    if (typeof row.rawBody !== 'string' || !isOwnerSyncRequestHash(row.requestHash)
      || typeof row.byteLength !== 'number' || !Number.isSafeInteger(row.byteLength)
      || row.byteLength < 1 || row.byteLength > OWNER_SYNC_MAX_BODY_BYTES
      || encoder.encode(row.rawBody).byteLength !== row.byteLength || wire(request) !== row.rawBody) reject('invalid_packet')
    if (request.expected_revision !== base.pulledRevision) reject('intent_mismatch')
    const intent = planOwnerWorkspaceCloudIntent(base, local)
    if (intent.issues.length || !intent.operations.length) reject('intent_mismatch')
    const expected = validateOwnerSyncRequest({ request_id: request.request_id,
      expected_revision: base.pulledRevision, operations: intent.operations })
    if (wire(expected) !== row.rawBody) reject('intent_mismatch')
    return { request, rawBody: row.rawBody, requestHash: row.requestHash, byteLength: row.byteLength }
  } catch (error) {
    if (error instanceof Rejected) throw error
    return reject('invalid_packet')
  }
}
type Matched = { outcome: 'success'; result: OwnerSyncWriteResult } | { outcome: 'conflict'; result: OwnerSyncConflict }
function matched(input: unknown, original: BuiltOwnerSyncRequest): Matched {
  try {
    const row = closed(input, ['source', 'requestId', 'requestHash', 'status', 'rawBody'], 'invalid_result')
    if (!['write', 'receipt'].includes(row.source as string) || typeof row.status !== 'number'
      || !Number.isSafeInteger(row.status) || typeof row.rawBody !== 'string') reject('invalid_result')
    if (row.requestId !== original.request.request_id || row.requestHash !== original.requestHash) reject('result_mismatch')
    if (row.source === 'write') {
      const parsed = parseSyncWriteResponse(row.status, row.rawBody)
      if (parsed.kind === 'success') return { outcome: 'success', result: parsed.result }
      if (parsed.kind === 'conflict') return { outcome: 'conflict', result: parsed.result }
    } else {
      const parsed = parseSyncReceiptResponse(row.status, row.rawBody)
      if (parsed.state === 'matched') return parsed.status === 200
        ? { outcome: 'success', result: parsed.result } : { outcome: 'conflict', result: parsed.result }
    }
    return reject('invalid_result')
  } catch (error) {
    if (error instanceof Rejected) throw error
    return reject('invalid_result')
  }
}
function digests(input: unknown, operations: readonly OwnerSyncOperation[]): Map<string, string> {
  const rows = list(input, OWNER_SYNC_MAX_OPERATIONS, 'invalid_digests')
  if (rows.length !== operations.length) reject('invalid_digests')
  const expected = new Set(operations.map(operation => operation.key)), result = new Map<string, string>(), seen = new Set<string>()
  for (const source of rows) {
    const row = closed(source, ['key', 'digest'], 'invalid_digests')
    if (typeof row.key !== 'string' || !expected.has(row.key) || seen.has(row.key)
      || typeof row.digest !== 'string' || row.digest.length !== 16 || !/^[0-9a-f]{16}$/.test(row.digest)
      || result.has(row.digest)) reject('invalid_digests')
    seen.add(row.key); result.set(row.digest, row.key)
  }
  return result
}
function choices(input: unknown): Map<string, OwnerWorkspaceAckResolution> {
  const result = new Map<string, OwnerWorkspaceAckResolution>()
  for (const source of list(input, OWNER_SYNC_MAX_OPERATIONS * 6, 'invalid_resolution')) {
    const row = closed(source, ['key', 'field', 'choice'], 'invalid_resolution')
    if (typeof row.key !== 'string' || !ALL_FIELDS.includes(row.field as OwnerWorkspaceAckField)
      || !CHOICES.includes(row.choice as 'local' | 'cloud')) reject('invalid_resolution')
    const value = row as unknown as OwnerWorkspaceAckResolution, id = value.key + '\n' + value.field
    if (result.has(id)) reject('invalid_resolution')
    result.set(id, { ...value })
  }
  return result
}
/** A later complete snapshot cannot forget a tombstone or backdate a change.
 * Revision stamps detect observed field/lifecycle ABA, not unobserved history.
 */
function progress(before: OwnerSyncRecord, after: OwnerSyncRecord | undefined, previousHead: number): void {
  if (!after) reject('missing_cloud_record', before.key)
  if (after.record_revision < before.record_revision || after.lifecycle_revision < before.lifecycle_revision
    || after.record_revision !== before.record_revision && after.record_revision <= previousHead) reject('baseline_regression', before.key)
  const lifecycle = after.kind !== before.kind || after.deleted !== before.deleted
  if (lifecycle && after.lifecycle_revision <= previousHead
    || after.lifecycle_revision !== before.lifecycle_revision && after.lifecycle_revision <= previousHead) reject('baseline_regression', before.key)
  for (const field of Object.keys(after.values)) {
    if (!Object.prototype.hasOwnProperty.call(before.values, field)) {
      if (after.field_revisions[field] <= previousHead) reject('baseline_regression', before.key)
      continue
    }
    if (after.field_revisions[field] < before.field_revisions[field]
      || after.values[field] !== before.values[field] && after.field_revisions[field] <= previousHead
      || after.field_revisions[field] !== before.field_revisions[field] && after.field_revisions[field] <= previousHead) reject('baseline_regression', before.key)
  }
  if (after.record_revision === before.record_revision && wire(after) !== wire(before)) reject('baseline_regression', before.key)
}
function checkSuccess(result: OwnerSyncWriteResult, original: BuiltOwnerSyncRequest, base: OwnerSyncBaseline,
  current: ReadonlyMap<string, OwnerSyncRecord>): void {
  if (result.revision <= base.pulledRevision || result.records.length !== original.request.operations.length) reject('result_mismatch')
  const previous = new Map(base.records.map(record => [record.key, record]))
  const records = new Map(result.records.map(record => [record.key, record]))
  for (const operation of original.request.operations) {
    const record = records.get(operation.key), before = previous.get(operation.key)
    if (!record || record.kind !== operation.kind || record.deleted !== operation.deleted
      || record.record_revision !== result.revision) reject('result_mismatch', operation.key)
    if (before) progress(before, record, base.pulledRevision)
    if (operation.deleted) {
      if (!before || wire(record.values) !== wire(before.values)
        || record.lifecycle_revision !== result.revision || wire(record.field_revisions) !== wire(before.field_revisions)) reject('result_mismatch', operation.key)
    } else {
      for (const [field, value] of Object.entries(operation.changes ?? {})) {
        if (record.values[field] !== value) reject('result_mismatch', operation.key)
        if ((!before || before.values[field] !== value) && record.field_revisions[field] !== result.revision) reject('result_mismatch', operation.key)
      }
      if (!before || before.kind !== record.kind) {
        if (record.lifecycle_revision !== result.revision) reject('result_mismatch', operation.key)
        if (before) for (const field of Object.keys(record.values)) {
          const expected = before.values[field] === record.values[field] ? before.field_revisions[field] : result.revision
          if (record.field_revisions[field] !== expected) reject('result_mismatch', operation.key)
        }
      } else if (record.lifecycle_revision !== before.lifecycle_revision) reject('result_mismatch', operation.key)
    }
    progress(record, current.get(operation.key), result.revision)
  }
}
function serverConflicts(result: OwnerSyncConflict, byDigest: ReadonlyMap<string, string>,
  operations: readonly OwnerSyncOperation[]): Map<string, readonly string[]> {
  const output = new Map<string, readonly string[]>(), byKey = new Map(operations.map(operation => [operation.key, operation]))
  for (const item of result.conflicts) {
    const key = byDigest.get(item.key_digest)
    if (!key || output.has(key)) reject('result_mismatch')
    const operation = byKey.get(key)!
    // expected_revision is emitted only for the server's global empty-key
    // digest, never as a field conflict owned by one supplied operation key.
    const allowed = new Set(['kind', 'deleted', ...Object.keys(operation.changes ?? {}), ...Object.keys(operation.base_values ?? {})])
    if (operation.deleted) allowed.add('record_revision')
    if (item.fields.some(field => !allowed.has(field))) reject('result_mismatch', key)
    output.set(key, item.fields)
  }
  return output
}
function conflict(key: string, field: OwnerWorkspaceAckField, reason: OwnerWorkspaceAckConflictReason,
  before: OwnerSyncRecord | undefined, local: OwnerWorkspaceEntry | undefined, cloud: OwnerSyncRecord | undefined,
  groupKeys: readonly string[] = [key], allowed = !(cloud?.deleted && local && !local.deleted)): OwnerWorkspaceAckConflict {
  return { key, field, reason, base: fund(before), local: local ? { ...local, values: { ...local.values } } : null,
    cloud: fromCloud(cloud, local), groupKeys: [...groupKeys], localAllowed: !!allowed, choice: null }
}
function renameGroups(operations: readonly OwnerSyncOperation[], previous: ReadonlyMap<string, OwnerSyncRecord>): readonly string[][] {
  const groups = new Map<string, OwnerSyncOperation[]>()
  for (const operation of operations) {
    const code = operation.key.split('::')[0]
    const rows = groups.get(code) ?? []; rows.push(operation); groups.set(code, rows)
  }
  return [...groups.values()].filter(rows => rows.some(row => row.deleted && !previous.get(row.key)?.deleted)
    && rows.some(row => !row.deleted && !previous.has(row.key)))
    .map(rows => rows.filter(row => row.deleted || !previous.has(row.key)).map(row => row.key).sort(compareSyncKeys))
}
function changedFields(before: OwnerWorkspaceEntry | null, after: OwnerWorkspaceEntry | null): OwnerWorkspaceAckField[] {
  if (!before || !after) return ['lifecycle']
  const result: OwnerWorkspaceAckField[] = []
  if (before.kind !== after.kind || before.deleted !== after.deleted) result.push('lifecycle')
  for (const field of FIELDS) if (before.values[field] !== after.values[field]) result.push(field)
  return result
}

/** Build an explicit preview only. An unresolved conflict never returns a
 * snapshot. A successful preview is not storage commit or business confirmation.
 */
export function buildOwnerWorkspaceAckPreview(input: unknown): OwnerWorkspaceAckPreview {
  try {
    const row = closed(input, ['base', 'localSnapshot', 'packet', 'matchedResult', 'completeBaseline',
      'minimumObservedRevision', 'keyDigests', 'resolutions'], 'invalid_input')
    const base = baseline(row.base), local = snapshot(row.localSnapshot), original = packet(row.packet, base, local)
    const parsed = matched(row.matchedResult, original), nextBase = baseline(row.completeBaseline)
    const minimum = revision(row.minimumObservedRevision), byDigest = digests(row.keyDigests, original.request.operations)
    const resolutions = choices(row.resolutions), used = new Set<string>()
    const floor = Math.max(base.pulledRevision, minimum, parsed.outcome === 'success' ? parsed.result.revision : 0)
    if (nextBase.pulledRevision < floor) reject('baseline_regression')
    const previous = new Map(base.records.map(record => [record.key, record])), remote = new Map(nextBase.records.map(record => [record.key, record]))
    const locals = new Map(local.entries.map(entry => [entry.key, entry])), operations = new Map(original.request.operations.map(operation => [operation.key, operation]))
    for (const record of base.records) progress(record, remote.get(record.key), base.pulledRevision)
    for (const record of nextBase.records) if (!previous.has(record.key) && record.record_revision <= base.pulledRevision) reject('baseline_regression', record.key)
    let known = new Map<string, readonly string[]>()
    if (parsed.outcome === 'success') checkSuccess(parsed.result, original, base, remote)
    else known = serverConflicts(parsed.result, byDigest, original.request.operations)
    const proposed = new Map<string, OwnerWorkspaceEntry>(), conflicts: OwnerWorkspaceAckConflict[] = []
    for (const entry of local.entries) {
      const before = previous.get(entry.key), cloud = remote.get(entry.key), operation = operations.get(entry.key)
      const remoteEntry = fromCloud(cloud, entry)
      if (!before && entry.deleted) {
        // This unlinked tombstone was not sent. Preserve it; a newly appearing
        // cloud identity cannot silently turn it back into an active record.
        proposed.set(entry.key, pending(entry))
        if (cloud && !same(entry, remoteEntry)) conflicts.push(conflict(entry.key, 'lifecycle', 'creation_collision', before, entry, cloud))
        continue
      }
      if (parsed.outcome === 'success' || !operation) {
        if (remoteEntry) proposed.set(entry.key, remoteEntry)
        else proposed.set(entry.key, pending(entry))
        continue
      }
      const flags = known.get(entry.key) ?? []
      const structural = !before || operation.deleted || operation.kind !== before.kind
      const lifecycleChanged = !!before && !!cloud && cloud.lifecycle_revision > before.lifecycle_revision
      if (structural || lifecycleChanged || flags.some(field => !FIELDS.includes(field as FundField))) {
        if (!cloud) { proposed.set(entry.key, pending(entry)); continue }
        const server = flags.length > 0
        const hasChange = !before || cloud.record_revision > before.record_revision
        if (!hasChange && !server) { proposed.set(entry.key, pending(entry)); continue }
        let reason: OwnerWorkspaceAckConflictReason = !before ? 'creation_collision'
          : cloud.deleted && !entry.deleted ? 'cloud_tombstone'
            : lifecycleChanged && cloud.kind === before.kind && cloud.deleted === before.deleted ? 'lifecycle_aba'
              : server && !hasChange ? 'server_conflict' : 'lifecycle_changed'
        conflicts.push(conflict(entry.key, 'lifecycle', reason, before, entry, cloud))
        proposed.set(entry.key, pending(entry))
        continue
      }
      if (!cloud || !remoteEntry || !before) reject('missing_cloud_record', entry.key)
      const values = { ...remoteEntry.values }
      for (const field of FIELDS) if (entry.values[field] !== before.values[field]) {
        const advanced = cloud.field_revisions[field] > before.field_revisions[field]
        if (advanced || flags.includes(field)) conflicts.push(conflict(entry.key, field,
          !advanced ? 'server_conflict' : cloud.values[field] === before.values[field] ? 'field_aba' : 'field_changed', before, entry, cloud))
        ;(values as Record<string, unknown>)[field] = entry.values[field]
      }
      proposed.set(entry.key, { ...remoteEntry, values })
    }
    for (const record of nextBase.records) if (record.kind !== 'manual_asset' && !locals.has(record.key)) {
      proposed.set(record.key, fromCloud(record)!)
    }
    // A packet carries no rename provenance. Conservatively group the same-code
    // old tombstone + fresh-account creates, preventing half a failed rename.
    if (parsed.outcome === 'conflict') for (const group of renameGroups(original.request.operations, previous)) {
      if (!conflicts.some(item => group.includes(item.key))) continue
      for (let index = conflicts.length - 1; index >= 0; index--) if (group.includes(conflicts[index].key)) conflicts.splice(index, 1)
      const key = group[0], allowed = group.every(key => !(remote.get(key)?.deleted && !locals.get(key)?.deleted))
      conflicts.push(conflict(key, 'rename', 'rename_atomic', previous.get(key), locals.get(key), remote.get(key), group, allowed))
    }
    conflicts.sort((first, second) => compareSyncKeys(first.key, second.key) || ALL_FIELDS.indexOf(first.field) - ALL_FIELDS.indexOf(second.field))
    for (let index = 0; index < conflicts.length; index++) {
      const item = conflicts[index], id = item.key + '\n' + item.field, resolution = resolutions.get(id)
      if (!resolution) continue
      used.add(id)
      if (resolution.choice === 'local' && !item.localAllowed) reject('invalid_resolution', item.key)
      conflicts[index] = { ...item, choice: resolution.choice }
      if (item.field === 'rename' || item.field === 'lifecycle') {
        for (const key of item.groupKeys) {
          const local = locals.get(key)
          let value = resolution.choice === 'local' ? local ? pending(local) : null : fromCloud(remote.get(key), local)
          // Choosing the cloud side cancels an unuploaded fresh rename key,
          // not its local identity history. Keep a no-upload tombstone so an
          // old backup cannot later treat that formerly visible key as new.
          if (resolution.choice === 'cloud' && !value && local) value = { ...pending(local), deleted: true }
          if (value) proposed.set(key, value); else proposed.delete(key)
        }
      } else {
        const value = proposed.get(item.key)!, source = resolution.choice === 'local' ? item.local : item.cloud
        if (!source) reject('invalid_resolution', item.key)
        proposed.set(item.key, { ...value, values: { ...value.values, [item.field]: source.values[item.field] } })
      }
    }
    if (used.size !== resolutions.size) reject('invalid_resolution')
    const excludedManualAssets = nextBase.records.filter(record => record.kind === 'manual_asset').length
    const common = { schema: 'owner-workspace-ack-preview-1' as const, outcome: parsed.outcome,
      issues: [], conflicts, baseD: nextBase, excludedManualAssets }
    if (conflicts.some(item => item.choice === null)) return freeze({ ...common, rows: [], nextSnapshot: null, changedKeys: [] })
    const ordered = [...local.entries.map(entry => entry.key), ...[...proposed.keys()].filter(key => !locals.has(key)).sort(compareSyncKeys)]
    let entries: readonly OwnerWorkspaceEntry[]
    try { entries = validateOwnerWorkspaceEntries(ordered.filter(key => proposed.has(key)).map(key => proposed.get(key)!)) }
    catch { return reject('capacity_exceeded') }
    const rows: OwnerWorkspaceAckRow[] = []
    for (const key of ordered) {
      const before = locals.get(key) ?? null, after = proposed.get(key) ?? null
      if (!same(before, after) || before?.local_pending !== after?.local_pending) rows.push({ key,
        before: before ? { ...before, values: { ...before.values } } : null, after, fields: changedFields(before, after) })
    }
    const nextSnapshot = validateOwnerWorkspaceSnapshot({ localVersion: local.localVersion, entries, legacy: local.legacy })
    return freeze({ ...common, rows, nextSnapshot, changedKeys: rows.map(item => item.key) })
  } catch (error) {
    // Do not inspect arbitrary exception getters or echo source/response data.
    const issue = error instanceof Rejected ? { code: error.code, key: error.key } : { code: 'invalid_input' as const, key: null }
    return freeze({ schema: 'owner-workspace-ack-preview-1', outcome: null, issues: [issue], conflicts: [],
      rows: [], nextSnapshot: null, baseD: null, changedKeys: [], excludedManualAssets: 0 })
  }
}
