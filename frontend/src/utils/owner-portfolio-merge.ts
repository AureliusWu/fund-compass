/** Pure first complete-portfolio link. No packet, receipt, IO, clock or crypto.
 * An old fund-only B was applied to funds, never to manual assets. This kernel
 * preserves that distinction; it cannot manufacture POST/ACK qualification.
 * The guarded caller owns complete-pull provenance and the atomic local CAS.
 */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import {
  OwnerCloudImportError, OWNER_WORKSPACE_MAX_ENTRIES,
  validateOwnerWorkspaceEntries, validateOwnerWorkspaceSnapshot,
  type OwnerWorkspaceEntry, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'
import {
  OwnerPortfolioLocalError, validateOwnerPortfolioLocal,
  type OwnerPortfolioLocal, type OwnerPortfolioManual,
} from './ownerPortfolioLocal'
import { planOwnerPortfolioCloudIntent, type OwnerPortfolioSyncIssue } from './owner-portfolio-sync'
import { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'
import { OwnerWorkspaceSyncError } from './owner-workspace-sync-errors'
import { compareSyncKeys, type OwnerSyncOperation, type OwnerSyncRecord } from './ownerSyncContract'

export type OwnerPortfolioInitialMergeField = 'name' | 'shares' | 'cost' | 'target_weight'
  | 'cls' | 'value' | 'note' | 'lifecycle' | 'rename'
export type OwnerPortfolioInitialMergeEntity = OwnerWorkspaceEntry | OwnerPortfolioManual
export interface OwnerPortfolioInitialMergeResolution {
  readonly key: string
  readonly field: OwnerPortfolioInitialMergeField
  readonly choice: 'local' | 'cloud'
}
export interface OwnerPortfolioInitialMergeInput {
  readonly base: OwnerSyncBaseline | null
  readonly localSnapshot: OwnerWorkspaceSnapshot
  readonly portfolio: OwnerPortfolioLocal
  readonly completeBaseline: OwnerSyncBaseline
  readonly minimumObservedRevision: number
  readonly resolutions: readonly OwnerPortfolioInitialMergeResolution[]
}
export type OwnerPortfolioInitialMergeIssueCode = OwnerPortfolioSyncIssue['code'] | 'invalid_input'
  | 'baseline_regression' | 'missing_cloud_record' | 'invalid_resolution'
export type OwnerPortfolioInitialMergeConflictReason = 'field_changed' | 'field_aba'
  | 'lifecycle_changed' | 'lifecycle_aba' | 'creation_collision' | 'cloud_tombstone'
  | 'rename_atomic' | 'bootstrap_difference'
export interface OwnerPortfolioInitialMergeConflict {
  readonly key: string
  readonly field: OwnerPortfolioInitialMergeField
  readonly reason: OwnerPortfolioInitialMergeConflictReason
  readonly base: OwnerPortfolioInitialMergeEntity | null
  readonly local: OwnerPortfolioInitialMergeEntity | null
  readonly cloud: OwnerPortfolioInitialMergeEntity | null
  readonly groupKeys: readonly string[]
  readonly localAllowed: boolean
  readonly choice: 'local' | 'cloud' | null
}
export interface OwnerPortfolioInitialMergeRow {
  readonly key: string
  readonly before: OwnerPortfolioInitialMergeEntity | null
  readonly after: OwnerPortfolioInitialMergeEntity | null
  /** Changed fields and/or retained intent. A retained local edit may have an
   * equal before/after; remainingOperations exposes its actual guarded write. */
  readonly fields: readonly OwnerPortfolioInitialMergeField[]
}
export interface OwnerPortfolioInitialMergePreview {
  readonly schema: 'owner-portfolio-initial-merge-1'
  readonly issues: readonly { readonly code: OwnerPortfolioInitialMergeIssueCode; readonly key: string | null }[]
  readonly conflicts: readonly OwnerPortfolioInitialMergeConflict[]
  readonly rows: readonly OwnerPortfolioInitialMergeRow[]
  readonly nextSnapshot: OwnerWorkspaceSnapshot | null
  readonly nextPortfolio: OwnerPortfolioLocal | null
  readonly baseC: OwnerSyncBaseline | null
  readonly remainingOperations: readonly OwnerSyncOperation[]
}

const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
const MANUAL_FIELDS = ['name', 'cls', 'value', 'note'] as const
const ALL_FIELDS: readonly OwnerPortfolioInitialMergeField[] = [...FUND_FIELDS, 'cls', 'value', 'note', 'lifecycle', 'rename']
type Entity = OwnerPortfolioInitialMergeEntity
class Rejected extends Error {
  constructor(readonly code: OwnerPortfolioInitialMergeIssueCode, readonly key: string | null = null) {
    super('Owner portfolio initial merge rejected')
  }
}
function reject(code: OwnerPortfolioInitialMergeIssueCode, key: string | null = null): never { throw new Rejected(code, key) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function closed(input: unknown, keys: readonly string[], code: OwnerPortfolioInitialMergeIssueCode): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject(code)
  const properties = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(properties, key))
    || Object.values(properties).some(item => !item.enumerable || !('value' in item))) reject(code)
  return Object.fromEntries(keys.map(key => [key, properties[key].value]))
}
function list(input: unknown): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > OWNER_WORKSPACE_MAX_ENTRIES * ALL_FIELDS.length
    || Reflect.ownKeys(input).length !== input.length + 1
    || Object.keys(input).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(input)).some(([key, item]) =>
      !('value' in item) || key !== 'length' && !item.enumerable)) reject('invalid_resolution')
  return input
}
function capacity(error: unknown): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return (error instanceof OwnerCloudImportError || error instanceof OwnerPortfolioLocalError || error instanceof OwnerWorkspaceSyncError)
      && !!descriptor && 'value' in descriptor && descriptor.value === 'capacity_exceeded'
  } catch { return false }
}
function checked<T>(input: unknown, validator: (input: unknown) => T, code: OwnerPortfolioInitialMergeIssueCode): T {
  try { return validator(input) } catch (error) { return reject(capacity(error) ? 'capacity_exceeded' : code) }
}
function choices(input: unknown): Map<string, OwnerPortfolioInitialMergeResolution> {
  const result = new Map<string, OwnerPortfolioInitialMergeResolution>()
  for (const source of list(input)) {
    const row = closed(source, ['key', 'field', 'choice'], 'invalid_resolution')
    if (typeof row.key !== 'string' || !ALL_FIELDS.includes(row.field as OwnerPortfolioInitialMergeField)
      || row.choice !== 'local' && row.choice !== 'cloud') reject('invalid_resolution')
    const value = row as unknown as OwnerPortfolioInitialMergeResolution, id = value.key + '\n' + value.field
    if (result.has(id)) reject('invalid_resolution')
    result.set(id, { ...value })
  }
  return result
}
function manual(entity: Entity): entity is OwnerPortfolioManual { return 'legacyId' in entity }
function kind(entity: Entity): OwnerSyncRecord['kind'] { return manual(entity) ? 'manual_asset' : entity.kind }
function fields(entity: Entity): readonly OwnerPortfolioInitialMergeField[] { return manual(entity) ? MANUAL_FIELDS : FUND_FIELDS }
function values(entity: Entity): Readonly<Record<string, string | number | null>> {
  return entity.values as unknown as Readonly<Record<string, string | number | null>>
}
function pending(entity: Entity): Entity { return { ...entity, values: { ...entity.values }, local_pending: true } as Entity }
function fromCloud(record: OwnerSyncRecord | undefined, local?: Entity): Entity | null {
  if (!record) return null
  const copy = { ...record.values }
  // Preserve the local signed zero when JSON/business values agree. Neither
  // the complete cloud image nor the original local image is normalized.
  if (local) for (const field of Object.keys(copy)) if (copy[field] === values(local)[field]) copy[field] = values(local)[field]
  if (record.kind === 'manual_asset') return { key: record.key,
    legacyId: local && manual(local) ? local.legacyId : null,
    deleted: record.deleted, values: copy as unknown as OwnerPortfolioManual['values'],
    updated_at: local && manual(local) ? local.updated_at : null, local_pending: true }
  return { key: record.key, kind: record.kind, deleted: record.deleted,
    values: copy as unknown as OwnerWorkspaceEntry['values'], local_pending: true }
}
function same(first: Entity | null, second: Entity | null): boolean {
  if (!first || !second) return first === second
  return first.key === second.key && kind(first) === kind(second) && first.deleted === second.deleted
    && fields(first).every(field => values(first)[field] === values(second)[field])
}
// Only copied, validated native DTOs enter canonicalization. Progress uses
// backend wire equality; source B/L continue to preserve negative zero.
function wire(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(wire).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + wire(row[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
/** Same actual revision-progress algorithm as the existing ACK kernel, without
 * invoking ACK or fabricating its packet/result. Applies also to observed but
 * never-applied old manual records: they still cannot disappear or regress. */
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
function conflict(key: string, field: OwnerPortfolioInitialMergeField, reason: OwnerPortfolioInitialMergeConflictReason,
  before: OwnerSyncRecord | undefined, local: Entity | undefined, cloud: OwnerSyncRecord | undefined,
  groupKeys: readonly string[] = [key], allowed = !(cloud?.deleted && local && !local.deleted)): OwnerPortfolioInitialMergeConflict {
  return { key, field, reason, base: fromCloud(before), local: local ? { ...local, values: { ...local.values } } as Entity : null,
    cloud: fromCloud(cloud, local), groupKeys: [...groupKeys], localAllowed: !!allowed, choice: null }
}
function changedFields(before: Entity | null, after: Entity | null): OwnerPortfolioInitialMergeField[] {
  if (!before || !after) return ['lifecycle']
  const result: OwnerPortfolioInitialMergeField[] = []
  if (kind(before) !== kind(after) || before.deleted !== after.deleted) result.push('lifecycle')
  for (const field of fields(after)) if (values(before)[field] !== values(after)[field]) result.push(field)
  return result
}
function renameGroups(local: OwnerWorkspaceSnapshot, previous: ReadonlyMap<string, OwnerSyncRecord>): readonly string[][] {
  const groups = new Map<string, OwnerWorkspaceEntry[]>()
  for (const entry of local.entries) {
    const before = previous.get(entry.key)
    if (!(entry.deleted && before && !before.deleted) && !(!entry.deleted && !before)) continue
    const code = entry.key.split('::')[0], rows = groups.get(code) ?? []
    rows.push(entry); groups.set(code, rows)
  }
  return [...groups.values()].filter(rows => rows.some(row => row.deleted) && rows.some(row => !row.deleted))
    .map(rows => rows.map(row => row.key).sort(compareSyncKeys))
}

/** Explicit preview only. No unresolved/invalid result is a writable postimage.
 * Final packet limits (200 ops/128 KiB) belong to the real request builder;
 * remaining intent is never trimmed, split, hashed or sent by this kernel. */
export function previewOwnerPortfolioInitialMerge(input: unknown): OwnerPortfolioInitialMergePreview {
  try {
    const row = closed(input, ['base', 'localSnapshot', 'portfolio', 'completeBaseline', 'minimumObservedRevision', 'resolutions'], 'invalid_input')
    const base = row.base === null ? null : checked(row.base, validateOwnerWorkspaceCloudBaseline, 'invalid_baseline')
    const local = checked(row.localSnapshot, validateOwnerWorkspaceSnapshot, 'invalid_workspace')
    const portfolio = checked(row.portfolio, validateOwnerPortfolioLocal, 'invalid_portfolio')
    const cloud = checked(row.completeBaseline, validateOwnerWorkspaceCloudBaseline, 'invalid_baseline')
    const minimum = row.minimumObservedRevision
    if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 0 || Object.is(minimum, -0)) reject('invalid_input')
    if (cloud.pulledRevision < Math.max(base?.pulledRevision ?? 0, minimum)) reject('baseline_regression')
    const resolutions = choices(row.resolutions), used = new Set<string>()
    const previous = new Map(base?.records.map(record => [record.key, record]) ?? [])
    const remote = new Map(cloud.records.map(record => [record.key, record]))
    const locals = new Map<string, Entity>([...local.entries, ...portfolio.manual].map(entry => [entry.key, entry]))
    if (base) {
      for (const record of base.records) {
        progress(record, remote.get(record.key), base.pulledRevision)
        if (record.kind !== 'manual_asset' && !locals.has(record.key)) reject('missing_workspace_record', record.key)
      }
      for (const record of cloud.records) if (!previous.has(record.key) && record.record_revision <= base.pulledRevision) reject('baseline_regression', record.key)
    }
    const proposed = new Map<string, Entity>(), conflicts: OwnerPortfolioInitialMergeConflict[] = []
    for (const entry of locals.values()) {
      // Old B never applied manual rows. A newer C matching old B is not a
      // common manual ancestor and must not overwrite the first local import.
      const before = manual(entry) ? undefined : previous.get(entry.key), current = remote.get(entry.key)
      const cloudEntry = fromCloud(current, entry)
      proposed.set(entry.key, pending(entry))
      if (!before) {
        if (!current) continue
        if (same(entry, cloudEntry)) { proposed.set(entry.key, cloudEntry!); continue }
        conflicts.push(conflict(entry.key, 'lifecycle', current.deleted && !entry.deleted ? 'cloud_tombstone'
          : manual(entry) ? 'bootstrap_difference' : 'creation_collision', undefined, entry, current))
        continue
      }
      if (!current || !cloudEntry) reject('missing_cloud_record', entry.key)
      const beforeEntry = fromCloud(before)!
      if (same(entry, beforeEntry)) { proposed.set(entry.key, cloudEntry); continue }
      if (current.deleted && !entry.deleted) {
        conflicts.push(conflict(entry.key, 'lifecycle', 'cloud_tombstone', before, entry, current)); continue
      }
      const structural = kind(entry) !== before.kind || entry.deleted !== before.deleted
      const lifecycleChanged = current.lifecycle_revision > before.lifecycle_revision
      if (structural || lifecycleChanged) {
        if (current.record_revision === before.record_revision && !lifecycleChanged) continue
        const reason = current.deleted && !entry.deleted ? 'cloud_tombstone'
          : lifecycleChanged && current.kind === before.kind && current.deleted === before.deleted ? 'lifecycle_aba' : 'lifecycle_changed'
        conflicts.push(conflict(entry.key, 'lifecycle', reason, before, entry, current)); continue
      }
      if (manual(entry) || manual(cloudEntry)) reject('invalid_input')
      for (const field of FUND_FIELDS) if (values(entry)[field] !== before.values[field]) {
        if (current.field_revisions[field] > before.field_revisions[field]) conflicts.push(conflict(entry.key, field,
          current.values[field] === before.values[field] ? 'field_aba' : 'field_changed', before, entry, current))
      }
      proposed.set(entry.key, { ...cloudEntry, values: {
        name: entry.values.name !== before.values.name ? entry.values.name : cloudEntry.values.name,
        shares: entry.values.shares !== before.values.shares ? entry.values.shares : cloudEntry.values.shares,
        cost: entry.values.cost !== before.values.cost ? entry.values.cost : cloudEntry.values.cost,
        target_weight: entry.values.target_weight !== before.values.target_weight ? entry.values.target_weight : cloudEntry.values.target_weight,
      } })
    }
    for (const record of cloud.records) if (!locals.has(record.key)) proposed.set(record.key, fromCloud(record)!)
    // No rename provenance exists in the wire. Same-code tombstone + fresh
    // account candidates are conservatively resolved together, never halfway.
    for (const group of renameGroups(local, previous)) {
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
      if (item.field === 'lifecycle' || item.field === 'rename') {
        for (const key of item.groupKeys) {
          const original = locals.get(key)
          let chosen = resolution.choice === 'local' ? original ? pending(original) : null : fromCloud(remote.get(key), original)
          // Cloud selection cancels an unuploaded rename identity, not its
          // local identity history. Preserve a no-upload local tombstone.
          if (!chosen && original && resolution.choice === 'cloud') chosen = { ...pending(original), deleted: true }
          if (chosen) proposed.set(key, chosen); else proposed.delete(key)
        }
      } else {
        const original = proposed.get(item.key), source = resolution.choice === 'local' ? item.local : item.cloud
        if (!original || !source) reject('invalid_resolution', item.key)
        if (manual(original)) {
          if (!manual(source) || !MANUAL_FIELDS.some(field => field === item.field)) reject('invalid_resolution', item.key)
          proposed.set(item.key, { ...original, values: { ...original.values, [item.field]: values(source)[item.field] } })
        } else {
          if (manual(source) || !FUND_FIELDS.some(field => field === item.field)) reject('invalid_resolution', item.key)
          proposed.set(item.key, { ...original, values: { ...original.values, [item.field]: values(source)[item.field] } })
        }
      }
    }
    if (used.size !== resolutions.size) reject('invalid_resolution')
    const common = { schema: 'owner-portfolio-initial-merge-1' as const, issues: [], conflicts, baseC: cloud }
    if (conflicts.some(item => item.choice === null)) return freeze({ ...common,
      rows: [], nextSnapshot: null, nextPortfolio: null, remainingOperations: [] })
    const ordered = [...locals.keys(), ...[...proposed.keys()].filter(key => !locals.has(key)).sort(compareSyncKeys)]
    const result = ordered.filter(key => proposed.has(key)).map(key => proposed.get(key)!)
    const entries = checked(result.filter(entry => !manual(entry)), validateOwnerWorkspaceEntries, 'invalid_workspace')
    const nextSnapshot = checked({ localVersion: local.localVersion, entries, legacy: local.legacy }, validateOwnerWorkspaceSnapshot, 'invalid_workspace')
    const nextPortfolio = checked({ ...portfolio, manual: result.filter(manual) }, validateOwnerPortfolioLocal, 'invalid_portfolio')
    const remaining = planOwnerPortfolioCloudIntent(cloud, nextSnapshot, nextPortfolio)
    if (remaining.issues.length) return freeze({ ...common, issues: remaining.issues,
      rows: [], nextSnapshot: null, nextPortfolio: null, remainingOperations: [] })
    const intents = new Map(remaining.operations.map(operation => [operation.key, operation]))
    const rows: OwnerPortfolioInitialMergeRow[] = []
    for (const key of ordered) {
      const before = locals.get(key) ?? null, after = proposed.get(key) ?? null, intent = intents.get(key)
      if (same(before, after) && before?.local_pending === after?.local_pending && !intent) continue
      const changed = changedFields(before, after)
      if (intent) for (const field of intent.deleted || !remote.has(key) || intent.kind !== remote.get(key)?.kind
        ? ['lifecycle'] as const : Object.keys(intent.changes ?? {}) as OwnerPortfolioInitialMergeField[]) {
        if (!changed.includes(field)) changed.push(field)
      }
      rows.push({ key, before, after, fields: changed })
    }
    return freeze({ ...common, rows, nextSnapshot, nextPortfolio, remainingOperations: remaining.operations })
  } catch (error) {
    // Never inspect arbitrary exception getters or echo private input.
    const issue = error instanceof Rejected ? { code: error.code, key: error.key } : { code: 'invalid_input' as const, key: null }
    return freeze({ schema: 'owner-portfolio-initial-merge-1', issues: [issue], conflicts: [],
      rows: [], nextSnapshot: null, nextPortfolio: null, baseC: null, remainingOperations: [] })
  }
}
