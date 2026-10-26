/** Pure applied-common-base refresh. No packet, receipt, IO, clock or crypto.
 * The guarded caller proves complete fixed-upper D provenance and commits the
 * entire original local image atomically. This helper grants neither proof.
 * Unlike initial link, BOTH fund and manual records already share full B.
 */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import {
  OwnerCloudImportError, OWNER_WORKSPACE_MAX_ENTRIES, validateOwnerWorkspaceEntries,
  validateOwnerWorkspaceSnapshot, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'
import {
  OwnerPortfolioLocalError, validateOwnerPortfolioLocal,
  type OwnerPortfolioLocal, type OwnerPortfolioManual,
} from './ownerPortfolioLocal'
import { planOwnerPortfolioCloudIntent, type OwnerPortfolioSyncIssue } from './owner-portfolio-sync'
import { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'
import { OwnerWorkspaceSyncError } from './owner-workspace-sync-errors'
import type {
  OwnerPortfolioAckEntity, OwnerPortfolioAckField, OwnerPortfolioAckResolution,
  OwnerPortfolioAckConflict, OwnerPortfolioAckRow,
} from './owner-portfolio-ack'
import { compareSyncKeys, type OwnerSyncOperation, type OwnerSyncRecord } from './ownerSyncContract'

export type OwnerPortfolioRefreshEntity = OwnerPortfolioAckEntity
export type OwnerPortfolioRefreshField = OwnerPortfolioAckField
export type OwnerPortfolioRefreshResolution = OwnerPortfolioAckResolution
export type OwnerPortfolioRefreshConflict = OwnerPortfolioAckConflict
export type OwnerPortfolioRefreshRow = OwnerPortfolioAckRow
export type OwnerPortfolioRefreshIssueCode = OwnerPortfolioSyncIssue['code'] | 'invalid_input'
  | 'baseline_regression' | 'missing_cloud_record' | 'invalid_resolution'
export interface OwnerPortfolioRefreshInput {
  readonly base: OwnerSyncBaseline
  readonly localSnapshot: OwnerWorkspaceSnapshot
  readonly portfolio: OwnerPortfolioLocal
  readonly completeBaseline: OwnerSyncBaseline
  readonly minimumObservedRevision: number
  readonly resolutions: readonly OwnerPortfolioRefreshResolution[]
}
export interface OwnerPortfolioRefreshPreview {
  readonly schema: 'owner-portfolio-refresh-preview-1'
  readonly issues: readonly { readonly code: OwnerPortfolioRefreshIssueCode; readonly key: string | null }[]
  readonly conflicts: readonly OwnerPortfolioRefreshConflict[]
  /** Includes retained intent even when that row's before/after are equal. */
  readonly rows: readonly OwnerPortfolioRefreshRow[]
  readonly nextSnapshot: OwnerWorkspaceSnapshot | null
  readonly nextPortfolio: OwnerPortfolioLocal | null
  readonly baseD: OwnerSyncBaseline | null
  /** Actual L -> L' row changes, not merely remaining D -> L' intent. */
  readonly changedKeys: readonly string[]
  readonly remainingOperations: readonly OwnerSyncOperation[]
  /** Full B (including stamps/head) and the complete local postimage agree. */
  readonly noop: boolean
}

const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
const MANUAL_FIELDS = ['name', 'cls', 'value', 'note'] as const
const ALL_FIELDS: readonly OwnerPortfolioRefreshField[] = [...FUND_FIELDS, 'cls', 'value', 'note', 'lifecycle', 'rename']
type Entity = OwnerPortfolioRefreshEntity
class Rejected extends Error {
  constructor(readonly code: OwnerPortfolioRefreshIssueCode, readonly key: string | null = null) { super('Owner portfolio refresh rejected') }
}
function reject(code: OwnerPortfolioRefreshIssueCode, key: string | null = null): never { throw new Rejected(code, key) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function closed(input: unknown, keys: readonly string[], code: OwnerPortfolioRefreshIssueCode): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject(code)
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) reject(code)
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
function choices(input: unknown): Map<string, OwnerPortfolioRefreshResolution> {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > OWNER_WORKSPACE_MAX_ENTRIES * ALL_FIELDS.length
    || Reflect.ownKeys(input).length !== input.length + 1
    || Object.keys(input).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(input)).some(([key, item]) =>
      !('value' in item) || key !== 'length' && !item.enumerable)) reject('invalid_resolution')
  const result = new Map<string, OwnerPortfolioRefreshResolution>()
  for (const source of input) {
    const row = closed(source, ['key', 'field', 'choice'], 'invalid_resolution')
    if (typeof row.key !== 'string' || !ALL_FIELDS.includes(row.field as OwnerPortfolioRefreshField)
      || row.choice !== 'local' && row.choice !== 'cloud') reject('invalid_resolution')
    const value: OwnerPortfolioRefreshResolution = { key: row.key, field: row.field as OwnerPortfolioRefreshField, choice: row.choice }
    const id = value.key + '\n' + value.field
    if (result.has(id)) reject('invalid_resolution')
    result.set(id, value)
  }
  return result
}
function checked<T>(input: unknown, validate: (input: unknown) => T, code: OwnerPortfolioRefreshIssueCode): T {
  try { return validate(input) } catch (error) {
    const descriptor = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
    const capacity = (error instanceof OwnerCloudImportError || error instanceof OwnerPortfolioLocalError || error instanceof OwnerWorkspaceSyncError)
      && descriptor && 'value' in descriptor && descriptor.value === 'capacity_exceeded'
    return reject(capacity ? 'capacity_exceeded' : code)
  }
}
/** Only copied, validated DTOs reach this function. Wire business equality
 * equates +/-0, whereas no-op and local-image comparisons preserve its sign. */
function canonical(value: unknown, exact = false): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, exact)).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key], exact)).join(',') + '}'
  }
  return exact && Object.is(value, -0) ? '-0' : JSON.stringify(value)
}
function sameBaseline(first: OwnerSyncBaseline, second: OwnerSyncBaseline): boolean {
  const ordered = (base: OwnerSyncBaseline) => ({ pulledRevision: base.pulledRevision,
    records: [...base.records].sort((a, b) => compareSyncKeys(a.key, b.key)) })
  return canonical(ordered(first), true) === canonical(ordered(second), true)
}
function manual(entity: Entity): entity is OwnerPortfolioManual { return 'legacyId' in entity }
function kind(entity: Entity): OwnerSyncRecord['kind'] { return manual(entity) ? 'manual_asset' : entity.kind }
function fields(entity: Entity): readonly OwnerPortfolioRefreshField[] { return manual(entity) ? MANUAL_FIELDS : FUND_FIELDS }
function values(entity: Entity): Readonly<Record<string, string | number | null>> {
  return entity.values as unknown as Readonly<Record<string, string | number | null>>
}
function copy(entity: Entity): Entity {
  return manual(entity) ? { ...entity, values: { ...entity.values } } : { ...entity, values: { ...entity.values } }
}
function same(first: Entity | null, second: Entity | null): boolean {
  return !first || !second ? first === second : first.key === second.key && kind(first) === kind(second)
    && first.deleted === second.deleted && fields(first).every(field => values(first)[field] === values(second)[field])
}
function fromCloud(record: OwnerSyncRecord | undefined, local?: Entity): Entity | null {
  if (!record) return null
  const preserved = (field: string) => local && record.values[field] === values(local)[field] ? values(local)[field] : record.values[field]
  const result: Entity = record.kind === 'manual_asset' ? { key: record.key, deleted: record.deleted,
    legacyId: local && manual(local) ? local.legacyId : null,
    updated_at: local && manual(local) ? local.updated_at : null, local_pending: true,
    values: { name: preserved('name') as string, cls: preserved('cls') as OwnerPortfolioManual['values']['cls'],
      value: preserved('value') as number, note: preserved('note') as string | null } }
    : { key: record.key, kind: record.kind, deleted: record.deleted, local_pending: true,
      values: { name: preserved('name') as string, shares: preserved('shares') as number | null,
        cost: preserved('cost') as number | null, target_weight: preserved('target_weight') as number | null } }
  return local && same(local, result) ? copy(local) : result
}
function progress(before: OwnerSyncRecord, after: OwnerSyncRecord | undefined, head: number): void {
  if (!after) reject('missing_cloud_record', before.key)
  if (after.record_revision < before.record_revision || after.lifecycle_revision < before.lifecycle_revision
    || after.record_revision !== before.record_revision && after.record_revision <= head
    || before.deleted && !after.deleted) reject('baseline_regression', before.key)
  if ((after.kind !== before.kind || after.deleted !== before.deleted) && after.lifecycle_revision <= head
    || after.lifecycle_revision !== before.lifecycle_revision && after.lifecycle_revision <= head) reject('baseline_regression', before.key)
  for (const field of Object.keys(after.values)) {
    if (!Object.prototype.hasOwnProperty.call(before.values, field)) {
      if (after.field_revisions[field] <= head) reject('baseline_regression', before.key)
    } else if (after.field_revisions[field] < before.field_revisions[field]
      || after.values[field] !== before.values[field] && after.field_revisions[field] <= head
      || after.field_revisions[field] !== before.field_revisions[field] && after.field_revisions[field] <= head) reject('baseline_regression', before.key)
  }
  if (after.record_revision === before.record_revision && canonical(after) !== canonical(before)) reject('baseline_regression', before.key)
}
function conflict(key: string, field: OwnerPortfolioRefreshField, reason: OwnerPortfolioRefreshConflict['reason'],
  before: OwnerSyncRecord | undefined, local: Entity | undefined, cloud: OwnerSyncRecord | undefined,
  groupKeys: readonly string[] = [key], allowed = !(cloud?.deleted && local && !local.deleted)): OwnerPortfolioRefreshConflict {
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
function selectedField(original: Entity, source: Entity, field: OwnerPortfolioRefreshField): Entity {
  if (manual(original)) {
    if (!manual(source) || !MANUAL_FIELDS.some(item => item === field)) reject('invalid_resolution', original.key)
    return { ...original, values: { ...original.values, [field]: values(source)[field] } }
  }
  if (manual(source) || !FUND_FIELDS.some(item => item === field)) reject('invalid_resolution', original.key)
  return { ...original, values: { ...original.values, [field]: values(source)[field] } }
}
function mergeEdited(local: Entity, cloud: Entity, before: OwnerSyncRecord): Entity {
  let result = cloud
  for (const field of fields(local)) if (values(local)[field] !== before.values[field]) result = selectedField(result, local, field)
  return same(local, result) ? copy(local) : result
}
function changedFields(before: Entity | null, after: Entity | null): OwnerPortfolioRefreshField[] {
  if (!before || !after) return ['lifecycle']
  const result: OwnerPortfolioRefreshField[] = []
  if (kind(before) !== kind(after) || before.deleted !== after.deleted) result.push('lifecycle')
  for (const field of fields(after)) if (values(before)[field] !== values(after)[field]) result.push(field)
  return result
}

export function previewOwnerPortfolioRefresh(input: unknown): OwnerPortfolioRefreshPreview {
  try {
    const row = closed(input, ['base', 'localSnapshot', 'portfolio', 'completeBaseline', 'minimumObservedRevision', 'resolutions'], 'invalid_input')
    const base = checked(row.base, validateOwnerWorkspaceCloudBaseline, 'invalid_baseline')
    const local = checked(row.localSnapshot, validateOwnerWorkspaceSnapshot, 'invalid_workspace')
    const portfolio = checked(row.portfolio, validateOwnerPortfolioLocal, 'invalid_portfolio')
    const nextBase = checked(row.completeBaseline, validateOwnerWorkspaceCloudBaseline, 'invalid_baseline')
    const minimum = row.minimumObservedRevision
    if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 0 || Object.is(minimum, -0)) reject('invalid_input')
    const resolutions = choices(row.resolutions), used = new Set<string>()
    if (nextBase.pulledRevision < Math.max(base.pulledRevision, minimum)) reject('baseline_regression')
    const intent = planOwnerPortfolioCloudIntent(base, local, portfolio)
    if (intent.issues.length) return freeze({ schema: 'owner-portfolio-refresh-preview-1', issues: intent.issues,
      conflicts: [], rows: [], nextSnapshot: null, nextPortfolio: null, baseD: null, changedKeys: [], remainingOperations: [], noop: false })
    const previous = new Map(base.records.map(record => [record.key, record])), remote = new Map(nextBase.records.map(record => [record.key, record]))
    const locals = new Map<string, Entity>([...local.entries, ...portfolio.manual].map(entry => [entry.key, entry]))
    const operations = new Map(intent.operations.map(operation => [operation.key, operation]))
    for (const record of base.records) progress(record, remote.get(record.key), base.pulledRevision)
    for (const record of nextBase.records) if (!previous.has(record.key) && record.record_revision <= base.pulledRevision) reject('baseline_regression', record.key)
    const proposed = new Map<string, Entity>(), conflicts: OwnerPortfolioRefreshConflict[] = []
    for (const entry of locals.values()) {
      const before = previous.get(entry.key), cloud = remote.get(entry.key), operation = operations.get(entry.key), remoteEntry = fromCloud(cloud, entry)
      if (!before && entry.deleted) {
        proposed.set(entry.key, copy(entry))
        if (cloud && !same(entry, remoteEntry)) conflicts.push(conflict(entry.key, 'lifecycle', 'creation_collision', before, entry, cloud))
        continue
      }
      if (!operation) { proposed.set(entry.key, remoteEntry ?? copy(entry)); continue }
      const structural = !before || operation.deleted || operation.kind !== before.kind
      const lifecycleChanged = !!before && !!cloud && cloud.lifecycle_revision > before.lifecycle_revision
      if (structural || lifecycleChanged) {
        proposed.set(entry.key, copy(entry))
        if (!cloud || before && cloud.record_revision === before.record_revision && !lifecycleChanged) continue
        const reason = !before ? 'creation_collision' : cloud.deleted && !entry.deleted ? 'cloud_tombstone'
          : lifecycleChanged && cloud.kind === before.kind && cloud.deleted === before.deleted ? 'lifecycle_aba' : 'lifecycle_changed'
        conflicts.push(conflict(entry.key, 'lifecycle', reason, before, entry, cloud)); continue
      }
      if (!cloud || !remoteEntry || !before) reject('missing_cloud_record', entry.key)
      for (const field of fields(entry)) if (values(entry)[field] !== before.values[field]
        && cloud.field_revisions[field] > before.field_revisions[field]) conflicts.push(conflict(entry.key, field,
        cloud.values[field] === before.values[field] ? 'field_aba' : 'field_changed', before, entry, cloud))
      proposed.set(entry.key, mergeEdited(entry, remoteEntry, before))
    }
    for (const record of nextBase.records) if (!locals.has(record.key)) proposed.set(record.key, fromCloud(record)!)
    for (const group of renameGroups(intent.operations, previous)) {
      if (!conflicts.some(item => group.includes(item.key))) continue
      for (let index = conflicts.length - 1; index >= 0; index--) if (group.includes(conflicts[index].key)) conflicts.splice(index, 1)
      const key = group[0], allowed = group.every(key => !(remote.get(key)?.deleted && !locals.get(key)?.deleted))
      conflicts.push(conflict(key, 'rename', 'rename_atomic', previous.get(key), locals.get(key), remote.get(key), group, allowed))
    }
    conflicts.sort((a, b) => compareSyncKeys(a.key, b.key) || ALL_FIELDS.indexOf(a.field) - ALL_FIELDS.indexOf(b.field))
    for (let index = 0; index < conflicts.length; index++) {
      const item = conflicts[index], id = item.key + '\n' + item.field, resolution = resolutions.get(id)
      if (!resolution) continue
      used.add(id)
      if (resolution.choice === 'local' && !item.localAllowed) reject('invalid_resolution', item.key)
      conflicts[index] = { ...item, choice: resolution.choice }
      if (item.field === 'rename' || item.field === 'lifecycle') {
        for (const key of item.groupKeys) {
          const local = locals.get(key)
          let chosen = resolution.choice === 'local' ? local ? copy(local) : null : fromCloud(remote.get(key), local)
          // Cancelling a never-uploaded rename/new key keeps its local tombstone.
          if (!chosen && local && resolution.choice === 'cloud') chosen = { ...copy(local), deleted: true }
          if (chosen) proposed.set(key, chosen); else proposed.delete(key)
        }
      } else {
        const original = proposed.get(item.key), source = resolution.choice === 'local' ? item.local : item.cloud
        if (!original || !source) reject('invalid_resolution', item.key)
        proposed.set(item.key, selectedField(original, source, item.field))
      }
    }
    if (used.size !== resolutions.size) reject('invalid_resolution')
    const common = { schema: 'owner-portfolio-refresh-preview-1' as const, issues: [], conflicts, baseD: nextBase }
    if (conflicts.some(item => item.choice === null)) return freeze({ ...common, rows: [], nextSnapshot: null,
      nextPortfolio: null, changedKeys: [], remainingOperations: [], noop: false })
    const ordered = [...locals.keys(), ...[...proposed.keys()].filter(key => !locals.has(key)).sort(compareSyncKeys)]
    const result = ordered.filter(key => proposed.has(key)).map(key => proposed.get(key)!)
    const entries = checked(result.filter(entity => !manual(entity)), validateOwnerWorkspaceEntries, 'invalid_workspace')
    const nextSnapshot = checked({ localVersion: local.localVersion, entries, legacy: local.legacy }, validateOwnerWorkspaceSnapshot, 'invalid_workspace')
    const nextPortfolio = checked({ ...portfolio, manual: result.filter(manual) }, validateOwnerPortfolioLocal, 'invalid_portfolio')
    const remaining = planOwnerPortfolioCloudIntent(nextBase, nextSnapshot, nextPortfolio)
    if (remaining.issues.length) return freeze({ ...common, issues: remaining.issues, rows: [], nextSnapshot: null,
      nextPortfolio: null, changedKeys: [], remainingOperations: [], noop: false })
    const intents = new Map(remaining.operations.map(operation => [operation.key, operation]))
    const rows: OwnerPortfolioRefreshRow[] = [], changedKeys: string[] = []
    for (const key of ordered) {
      const before = locals.get(key) ?? null, after = proposed.get(key) ?? null, operation = intents.get(key)
      const changed = canonical(before, true) !== canonical(after, true), rowFields = changedFields(before, after)
      if (changed) changedKeys.push(key)
      if (operation) for (const field of operation.deleted || !remote.has(key) || operation.kind !== remote.get(key)?.kind
        ? ['lifecycle'] as const : Object.keys(operation.changes ?? {}) as OwnerPortfolioRefreshField[]) if (!rowFields.includes(field)) rowFields.push(field)
      if (changed || operation) rows.push({ key, before: before ? copy(before) : null, after, fields: rowFields })
    }
    return freeze({ ...common, rows, nextSnapshot, nextPortfolio, changedKeys, remainingOperations: remaining.operations,
      noop: sameBaseline(base, nextBase) && canonical(local, true) === canonical(nextSnapshot, true)
        && canonical(portfolio, true) === canonical(nextPortfolio, true) })
  } catch (error) {
    const issue = error instanceof Rejected ? { code: error.code, key: error.key } : { code: 'invalid_input' as const, key: null }
    return freeze({ schema: 'owner-portfolio-refresh-preview-1', issues: [issue], conflicts: [], rows: [],
      nextSnapshot: null, nextPortfolio: null, baseD: null, changedKeys: [], remainingOperations: [], noop: false })
  }
}
