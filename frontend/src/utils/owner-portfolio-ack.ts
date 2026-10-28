/** Pure full-profile B/L/D acknowledgement kernel. No IO, clocks or crypto.
 * The guarded caller restores the original SHA-bound bytes, binds the real raw
 * response to its session/id/hash and proves complete fixed-upper pagination.
 * Supplied hashes/digests are checked associations, not source authentication.
 * POST partial records are never promoted to the complete common base D.
 */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import {
  OwnerCloudImportError, validateOwnerWorkspaceEntries, validateOwnerWorkspaceSnapshot,
  type OwnerWorkspaceEntry, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'
import {
  OwnerPortfolioLocalError, validateOwnerPortfolioLocal,
  type OwnerPortfolioLocal, type OwnerPortfolioManual,
} from './ownerPortfolioLocal'
import { planOwnerPortfolioCloudIntent } from './owner-portfolio-sync'
import { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'
import { OwnerWorkspaceSyncError } from './owner-workspace-sync-errors'
import type { OwnerWorkspaceAckRawMatched } from './owner-workspace-ack'
import type { OwnerPortfolioInitialMergeEntity, OwnerPortfolioInitialMergeField, OwnerPortfolioInitialMergeResolution } from './owner-portfolio-merge'
import {
  compareSyncKeys, isOwnerSyncRequestHash, OWNER_SYNC_MAX_BODY_BYTES, OWNER_SYNC_MAX_OPERATIONS,
  parseSyncReceiptResponse, parseSyncWriteResponse, validateOwnerSyncRequest,
  type BuiltOwnerSyncRequest, type OwnerSyncConflict, type OwnerSyncOperation, type OwnerSyncRecord, type OwnerSyncWriteResult,
} from './ownerSyncContract'

export type OwnerPortfolioAckEntity = OwnerPortfolioInitialMergeEntity
export type OwnerPortfolioAckField = OwnerPortfolioInitialMergeField
export type OwnerPortfolioAckResolution = OwnerPortfolioInitialMergeResolution
export type OwnerPortfolioAckRawMatched = OwnerWorkspaceAckRawMatched
export interface OwnerPortfolioAckInput {
  readonly base: OwnerSyncBaseline
  readonly localSnapshot: OwnerWorkspaceSnapshot
  readonly portfolio: OwnerPortfolioLocal
  readonly packet: BuiltOwnerSyncRequest
  readonly matchedResult: OwnerWorkspaceAckRawMatched
  readonly completeBaseline: OwnerSyncBaseline
  readonly minimumObservedRevision: number
  readonly keyDigests: readonly { readonly key: string; readonly digest: string }[]
  readonly resolutions: readonly OwnerPortfolioAckResolution[]
}
export type OwnerPortfolioAckIssueCode = 'invalid_input' | 'invalid_baseline' | 'invalid_workspace' | 'invalid_portfolio'
  | 'invalid_packet' | 'intent_mismatch' | 'invalid_result' | 'result_mismatch' | 'invalid_digests'
  | 'baseline_regression' | 'missing_cloud_record' | 'invalid_resolution' | 'capacity_exceeded'
export type OwnerPortfolioAckConflictReason = 'field_changed' | 'field_aba' | 'lifecycle_changed'
  | 'lifecycle_aba' | 'creation_collision' | 'server_conflict' | 'cloud_tombstone' | 'rename_atomic'
export interface OwnerPortfolioAckConflict {
  readonly key: string
  readonly field: OwnerPortfolioAckField
  readonly reason: OwnerPortfolioAckConflictReason
  readonly base: OwnerPortfolioAckEntity | null
  readonly local: OwnerPortfolioAckEntity | null
  readonly cloud: OwnerPortfolioAckEntity | null
  readonly groupKeys: readonly string[]
  readonly localAllowed: boolean
  readonly choice: 'local' | 'cloud' | null
}
export interface OwnerPortfolioAckRow {
  readonly key: string
  readonly before: OwnerPortfolioAckEntity | null
  readonly after: OwnerPortfolioAckEntity | null
  readonly fields: readonly OwnerPortfolioAckField[]
}
export interface OwnerPortfolioAckPreview {
  readonly schema: 'owner-portfolio-ack-preview-1'
  readonly outcome: 'success' | 'conflict' | null
  readonly issues: readonly { readonly code: OwnerPortfolioAckIssueCode; readonly key: string | null }[]
  readonly conflicts: readonly OwnerPortfolioAckConflict[]
  readonly rows: readonly OwnerPortfolioAckRow[]
  readonly nextSnapshot: OwnerWorkspaceSnapshot | null
  readonly nextPortfolio: OwnerPortfolioLocal | null
  readonly baseD: OwnerSyncBaseline | null
  readonly changedKeys: readonly string[]
}

const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
const MANUAL_FIELDS = ['name', 'cls', 'value', 'note'] as const
const ALL_FIELDS: readonly OwnerPortfolioAckField[] = [...FUND_FIELDS, 'cls', 'value', 'note', 'lifecycle', 'rename']
const encoder = new TextEncoder()
type Entity = OwnerPortfolioAckEntity
class Rejected extends Error {
  constructor(readonly code: OwnerPortfolioAckIssueCode, readonly key: string | null = null) { super('Owner portfolio acknowledgement rejected') }
}
function reject(code: OwnerPortfolioAckIssueCode, key: string | null = null): never { throw new Rejected(code, key) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function closed(input: unknown, keys: readonly string[], code: OwnerPortfolioAckIssueCode): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject(code)
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) reject(code)
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
function list(input: unknown, max: number, code: OwnerPortfolioAckIssueCode): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > max
    || Reflect.ownKeys(input).length !== input.length + 1
    || Object.keys(input).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(input)).some(([key, item]) =>
      !('value' in item) || key !== 'length' && !item.enumerable)) reject(code)
  return input
}
function capacity(error: unknown): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return (error instanceof OwnerCloudImportError || error instanceof OwnerPortfolioLocalError || error instanceof OwnerWorkspaceSyncError)
      && !!descriptor && 'value' in descriptor && descriptor.value === 'capacity_exceeded'
  } catch { return false }
}
function checked<T>(input: unknown, validate: (input: unknown) => T, code: OwnerPortfolioAckIssueCode): T {
  try { return validate(input) } catch (error) { return reject(capacity(error) ? 'capacity_exceeded' : code) }
}
// JSON/backend business equality deliberately equates +/-0. Original B/L and
// portfolio archives retain their exact signed-zero values throughout.
function wire(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(wire).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + wire(row[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function revision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) reject('invalid_input')
  return input
}
function manual(entity: Entity): entity is OwnerPortfolioManual { return 'legacyId' in entity }
function kind(entity: Entity): OwnerSyncRecord['kind'] { return manual(entity) ? 'manual_asset' : entity.kind }
function fields(entity: Entity): readonly OwnerPortfolioAckField[] { return manual(entity) ? MANUAL_FIELDS : FUND_FIELDS }
function values(entity: Entity): Readonly<Record<string, string | number | null>> {
  return entity.values as unknown as Readonly<Record<string, string | number | null>>
}
function copy(entity: Entity): Entity {
  return manual(entity) ? { ...entity, values: { ...entity.values } } : { ...entity, values: { ...entity.values } }
}
function pending(entity: Entity): Entity { return { ...copy(entity), local_pending: true } }
function fromCloud(record: OwnerSyncRecord | undefined, local?: Entity): Entity | null {
  if (!record) return null
  const preserved = (field: string) => local && record.values[field] === values(local)[field] ? values(local)[field] : record.values[field]
  if (record.kind === 'manual_asset') return { key: record.key, deleted: record.deleted,
    legacyId: local && manual(local) ? local.legacyId : null,
    updated_at: local && manual(local) ? local.updated_at : null, local_pending: true,
    values: { name: preserved('name') as string, cls: preserved('cls') as OwnerPortfolioManual['values']['cls'],
      value: preserved('value') as number, note: preserved('note') as string | null } }
  return { key: record.key, kind: record.kind, deleted: record.deleted, local_pending: true,
    values: { name: preserved('name') as string, shares: preserved('shares') as number | null,
      cost: preserved('cost') as number | null, target_weight: preserved('target_weight') as number | null } }
}
function same(first: Entity | null, second: Entity | null): boolean {
  if (!first || !second) return first === second
  return first.key === second.key && kind(first) === kind(second) && first.deleted === second.deleted
    && fields(first).every(field => values(first)[field] === values(second)[field])
}
function packet(input: unknown, base: OwnerSyncBaseline, local: OwnerWorkspaceSnapshot, portfolio: OwnerPortfolioLocal): BuiltOwnerSyncRequest {
  try {
    const row = closed(input, ['request', 'rawBody', 'requestHash', 'byteLength'], 'invalid_packet')
    const request = validateOwnerSyncRequest(row.request)
    if (typeof row.rawBody !== 'string' || !isOwnerSyncRequestHash(row.requestHash)
      || typeof row.byteLength !== 'number' || !Number.isSafeInteger(row.byteLength)
      || row.byteLength < 1 || row.byteLength > OWNER_SYNC_MAX_BODY_BYTES
      || encoder.encode(row.rawBody).byteLength !== row.byteLength || wire(request) !== row.rawBody) reject('invalid_packet')
    if (request.expected_revision !== base.pulledRevision) reject('intent_mismatch')
    const intent = planOwnerPortfolioCloudIntent(base, local, portfolio)
    if (intent.issues.length || !intent.operations.length) reject('intent_mismatch')
    const expected = validateOwnerSyncRequest({ request_id: request.request_id, expected_revision: base.pulledRevision, operations: intent.operations })
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
    if (row.source !== 'write' && row.source !== 'receipt' || typeof row.status !== 'number'
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
function choices(input: unknown): Map<string, OwnerPortfolioAckResolution> {
  const result = new Map<string, OwnerPortfolioAckResolution>()
  for (const source of list(input, OWNER_SYNC_MAX_OPERATIONS * ALL_FIELDS.length, 'invalid_resolution')) {
    const row = closed(source, ['key', 'field', 'choice'], 'invalid_resolution')
    if (typeof row.key !== 'string' || !ALL_FIELDS.includes(row.field as OwnerPortfolioAckField)
      || row.choice !== 'local' && row.choice !== 'cloud') reject('invalid_resolution')
    const value = row as unknown as OwnerPortfolioAckResolution, id = value.key + '\n' + value.field
    if (result.has(id)) reject('invalid_resolution')
    result.set(id, { ...value })
  }
  return result
}
/** Real revision-progress rules shared in semantics with the unchanged old ACK.
 * Stamps detect observed field/lifecycle ABA, not unobserved history. */
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
  const previous = new Map(base.records.map(record => [record.key, record])), records = new Map(result.records.map(record => [record.key, record]))
  for (const operation of original.request.operations) {
    const record = records.get(operation.key), before = previous.get(operation.key)
    if (!record || record.kind !== operation.kind || record.deleted !== operation.deleted || record.record_revision !== result.revision) reject('result_mismatch', operation.key)
    if (before) progress(before, record, base.pulledRevision)
    if (operation.deleted) {
      if (!before || wire(record.values) !== wire(before.values) || record.lifecycle_revision !== result.revision
        || wire(record.field_revisions) !== wire(before.field_revisions)) reject('result_mismatch', operation.key)
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
    // A keyed expected_revision or patch record_revision is not the original
    // server's global/whole-delete conflict contract.
    const allowed = new Set(['kind', 'deleted', ...Object.keys(operation.changes ?? {}), ...Object.keys(operation.base_values ?? {})])
    if (operation.deleted) allowed.add('record_revision')
    if (item.fields.some(field => !allowed.has(field))) reject('result_mismatch', key)
    output.set(key, item.fields)
  }
  return output
}
function conflict(key: string, field: OwnerPortfolioAckField, reason: OwnerPortfolioAckConflictReason,
  before: OwnerSyncRecord | undefined, local: Entity | undefined, cloud: OwnerSyncRecord | undefined,
  groupKeys: readonly string[] = [key], allowed = !(cloud?.deleted && local && !local.deleted)): OwnerPortfolioAckConflict {
  return { key, field, reason, base: fromCloud(before), local: local ? copy(local) : null,
    cloud: fromCloud(cloud, local), groupKeys: [...groupKeys], localAllowed: !!allowed, choice: null }
}
function renameGroups(operations: readonly OwnerSyncOperation[], previous: ReadonlyMap<string, OwnerSyncRecord>): readonly string[][] {
  const groups = new Map<string, OwnerSyncOperation[]>()
  for (const operation of operations) {
    if (operation.kind === 'manual_asset') continue
    const code = operation.key.split('::')[0], rows = groups.get(code) ?? []
    rows.push(operation); groups.set(code, rows)
  }
  return [...groups.values()].filter(rows => rows.some(row => row.deleted && !previous.get(row.key)?.deleted)
    && rows.some(row => !row.deleted && !previous.has(row.key)))
    .map(rows => rows.filter(row => row.deleted || !previous.has(row.key)).map(row => row.key).sort(compareSyncKeys))
}
function mergeEdited(local: Entity, remote: Entity, before: OwnerSyncRecord): Entity {
  if (manual(local)) {
    if (!manual(remote)) reject('invalid_input')
    return { ...remote, values: {
      name: local.values.name !== before.values.name ? local.values.name : remote.values.name,
      cls: local.values.cls !== before.values.cls ? local.values.cls : remote.values.cls,
      value: local.values.value !== before.values.value ? local.values.value : remote.values.value,
      note: local.values.note !== before.values.note ? local.values.note : remote.values.note,
    } }
  }
  if (manual(remote)) reject('invalid_input')
  return { ...remote, values: {
    name: local.values.name !== before.values.name ? local.values.name : remote.values.name,
    shares: local.values.shares !== before.values.shares ? local.values.shares : remote.values.shares,
    cost: local.values.cost !== before.values.cost ? local.values.cost : remote.values.cost,
    target_weight: local.values.target_weight !== before.values.target_weight ? local.values.target_weight : remote.values.target_weight,
  } }
}
function selectedField(original: Entity, source: Entity, field: OwnerPortfolioAckField): Entity {
  if (manual(original)) {
    if (!manual(source) || !MANUAL_FIELDS.some(item => item === field)) reject('invalid_resolution', original.key)
    return { ...original, values: { ...original.values, [field]: values(source)[field] } }
  }
  if (manual(source) || !FUND_FIELDS.some(item => item === field)) reject('invalid_resolution', original.key)
  return { ...original, values: { ...original.values, [field]: values(source)[field] } }
}
function changedFields(before: Entity | null, after: Entity | null): OwnerPortfolioAckField[] {
  if (!before || !after) return ['lifecycle']
  const result: OwnerPortfolioAckField[] = []
  if (kind(before) !== kind(after) || before.deleted !== after.deleted) result.push('lifecycle')
  for (const field of fields(after)) if (values(before)[field] !== values(after)[field]) result.push(field)
  return result
}

/** Preview only. Manual assets here have an actually applied common B, unlike
 * initial-link bootstrap. An unresolved result has no writable postimage. */
export function buildOwnerPortfolioAckPreview(input: unknown): OwnerPortfolioAckPreview {
  try {
    const row = closed(input, ['base', 'localSnapshot', 'portfolio', 'packet', 'matchedResult', 'completeBaseline',
      'minimumObservedRevision', 'keyDigests', 'resolutions'], 'invalid_input')
    const base = checked(row.base, validateOwnerWorkspaceCloudBaseline, 'invalid_baseline')
    const local = checked(row.localSnapshot, validateOwnerWorkspaceSnapshot, 'invalid_workspace')
    const portfolio = checked(row.portfolio, validateOwnerPortfolioLocal, 'invalid_portfolio')
    const original = packet(row.packet, base, local, portfolio), parsed = matched(row.matchedResult, original)
    const nextBase = checked(row.completeBaseline, validateOwnerWorkspaceCloudBaseline, 'invalid_baseline')
    const minimum = revision(row.minimumObservedRevision), byDigest = digests(row.keyDigests, original.request.operations)
    const resolutions = choices(row.resolutions), used = new Set<string>()
    if (nextBase.pulledRevision < Math.max(base.pulledRevision, minimum, parsed.outcome === 'success' ? parsed.result.revision : 0)) reject('baseline_regression')
    const previous = new Map(base.records.map(record => [record.key, record])), remote = new Map(nextBase.records.map(record => [record.key, record]))
    const locals = new Map<string, Entity>([...local.entries, ...portfolio.manual].map(entry => [entry.key, entry]))
    const operations = new Map(original.request.operations.map(operation => [operation.key, operation]))
    for (const record of base.records) progress(record, remote.get(record.key), base.pulledRevision)
    for (const record of nextBase.records) if (!previous.has(record.key) && record.record_revision <= base.pulledRevision) reject('baseline_regression', record.key)
    let known = new Map<string, readonly string[]>()
    if (parsed.outcome === 'success') checkSuccess(parsed.result, original, base, remote)
    else known = serverConflicts(parsed.result, byDigest, original.request.operations)
    const proposed = new Map<string, Entity>(), conflicts: OwnerPortfolioAckConflict[] = []
    for (const entry of locals.values()) {
      const before = previous.get(entry.key), cloud = remote.get(entry.key), operation = operations.get(entry.key), remoteEntry = fromCloud(cloud, entry)
      if (!before && entry.deleted) {
        proposed.set(entry.key, pending(entry))
        if (cloud && !same(entry, remoteEntry)) conflicts.push(conflict(entry.key, 'lifecycle', 'creation_collision', before, entry, cloud))
        continue
      }
      if (parsed.outcome === 'success' || !operation) {
        proposed.set(entry.key, remoteEntry ?? pending(entry)); continue
      }
      const flags = known.get(entry.key) ?? [], businessFields = fields(entry)
      const structural = !before || operation.deleted || operation.kind !== before.kind
      const lifecycleChanged = !!before && !!cloud && cloud.lifecycle_revision > before.lifecycle_revision
      if (structural || lifecycleChanged || flags.some(field => !businessFields.some(item => item === field))) {
        if (!cloud) { proposed.set(entry.key, pending(entry)); continue }
        const server = flags.length > 0, hasChange = !before || cloud.record_revision > before.record_revision
        if (!hasChange && !server) { proposed.set(entry.key, pending(entry)); continue }
        const reason: OwnerPortfolioAckConflictReason = !before ? 'creation_collision'
          : cloud.deleted && !entry.deleted ? 'cloud_tombstone'
            : lifecycleChanged && cloud.kind === before.kind && cloud.deleted === before.deleted ? 'lifecycle_aba'
              : server && !hasChange ? 'server_conflict' : 'lifecycle_changed'
        conflicts.push(conflict(entry.key, 'lifecycle', reason, before, entry, cloud))
        proposed.set(entry.key, pending(entry)); continue
      }
      if (!cloud || !remoteEntry || !before) reject('missing_cloud_record', entry.key)
      for (const field of businessFields) if (values(entry)[field] !== before.values[field]) {
        const advanced = cloud.field_revisions[field] > before.field_revisions[field]
        if (advanced || flags.includes(field)) conflicts.push(conflict(entry.key, field,
          !advanced ? 'server_conflict' : cloud.values[field] === before.values[field] ? 'field_aba' : 'field_changed', before, entry, cloud))
      }
      proposed.set(entry.key, mergeEdited(entry, remoteEntry, before))
    }
    for (const record of nextBase.records) if (!locals.has(record.key)) proposed.set(record.key, fromCloud(record)!)
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
          let chosen = resolution.choice === 'local' ? local ? pending(local) : null : fromCloud(remote.get(key), local)
          if (!chosen && local && resolution.choice === 'cloud') chosen = { ...pending(local), deleted: true }
          if (chosen) proposed.set(key, chosen); else proposed.delete(key)
        }
      } else {
        const original = proposed.get(item.key), source = resolution.choice === 'local' ? item.local : item.cloud
        if (!original || !source) reject('invalid_resolution', item.key)
        proposed.set(item.key, selectedField(original, source, item.field))
      }
    }
    if (used.size !== resolutions.size) reject('invalid_resolution')
    const common = { schema: 'owner-portfolio-ack-preview-1' as const, outcome: parsed.outcome, issues: [], conflicts, baseD: nextBase }
    if (conflicts.some(item => item.choice === null)) return freeze({ ...common, rows: [], nextSnapshot: null, nextPortfolio: null, changedKeys: [] })
    const ordered = [...locals.keys(), ...[...proposed.keys()].filter(key => !locals.has(key)).sort(compareSyncKeys)]
    const result = ordered.filter(key => proposed.has(key)).map(key => proposed.get(key)!)
    const entries = checked(result.filter(entity => !manual(entity)), validateOwnerWorkspaceEntries, 'invalid_workspace')
    const nextSnapshot = checked({ localVersion: local.localVersion, entries, legacy: local.legacy }, validateOwnerWorkspaceSnapshot, 'invalid_workspace')
    const nextPortfolio = checked({ ...portfolio, manual: result.filter(manual) }, validateOwnerPortfolioLocal, 'invalid_portfolio')
    const rows: OwnerPortfolioAckRow[] = []
    for (const key of ordered) {
      const before = locals.get(key) ?? null, after = proposed.get(key) ?? null
      if (!same(before, after) || before?.local_pending !== after?.local_pending) rows.push({ key,
        before: before ? copy(before) : null, after, fields: changedFields(before, after) })
    }
    return freeze({ ...common, rows, nextSnapshot, nextPortfolio, changedKeys: rows.map(item => item.key) })
  } catch (error) {
    const issue = error instanceof Rejected ? { code: error.code, key: error.key } : { code: 'invalid_input' as const, key: null }
    return freeze({ schema: 'owner-portfolio-ack-preview-1', outcome: null, issues: [issue], conflicts: [], rows: [],
      nextSnapshot: null, nextPortfolio: null, baseD: null, changedKeys: [] })
  }
}
