/** Pure preview of explicitly selected fund/account input; no Gist, IO or consent. */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import type { OwnerSyncWatchSnapshot } from '@/stores/watchlist'
import {
  normalizeOwnerSyncKey, validateOwnerSyncRecord, validateOwnerSyncRequest,
  OWNER_SYNC_MAX_OPERATIONS,
  type OwnerSyncOperation, type OwnerSyncRecord, type OwnerSyncValues,
} from '@/utils/ownerSyncContract'

type FundKind = 'watch' | 'holding'
type DraftOperation = Omit<OwnerSyncOperation, 'base_values'>
export type OwnerSyncPreviewIssueCode = 'invalid_local_record' | 'ambiguous_kind' | 'missing_value'
  | 'duplicate_key' | 'invalid_baseline' | 'cloud_tombstone' | 'too_many_operations' | 'invalid_operation'
export interface OwnerSyncPreviewIssue { readonly code: OwnerSyncPreviewIssueCode; readonly key: string | null }
export interface OwnerSyncPreviewRow {
  readonly key: string
  readonly code: string
  readonly account: string
  readonly action: 'create' | 'update' | 'delete' | 'kind_change'
  readonly kind: FundKind
  readonly before: OwnerSyncRecord | null
  readonly after: Readonly<{ kind: FundKind; deleted: boolean; values: OwnerSyncValues }>
  readonly fields: readonly string[]
}
export interface OwnerSyncPreview {
  readonly rows: readonly OwnerSyncPreviewRow[]
  readonly operations: readonly DraftOperation[]
  readonly issues: readonly OwnerSyncPreviewIssue[]
}

const LOCAL_FIELDS = ['code', 'name', 'shares', 'cost', 'target_weight', 'position_kind',
  'account', 'updated_at', 'deleted', 'id', 'local_pending']
const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('shape')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) throw new Error('shape')
  return value as Record<string, unknown>
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function nullableNumber(value: unknown, maximum = Infinity): boolean {
  return value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
}

export function buildOwnerSyncPreview(snapshot: OwnerSyncWatchSnapshot, baseline: OwnerSyncBaseline): OwnerSyncPreview {
  const rows: OwnerSyncPreviewRow[] = [], operations: DraftOperation[] = [], issues: OwnerSyncPreviewIssue[] = []
  const problem = (code: OwnerSyncPreviewIssueCode, key: string | null = null) => { issues.push({ code, key }) }
  const finish = (): OwnerSyncPreview => freeze({ rows, operations: issues.length ? [] : operations, issues })
  const remote = new Map<string, OwnerSyncRecord>()
  try {
    plain(baseline)
    if (!Number.isSafeInteger(baseline.pulledRevision) || baseline.pulledRevision < 0
      || !Array.isArray(baseline.records) || Object.keys(baseline.records).length !== baseline.records.length
      || Object.values(Object.getOwnPropertyDescriptors(baseline.records)).some(item => !('value' in item))) throw new Error('baseline')
    for (const source of baseline.records) {
      const record = validateOwnerSyncRecord(source, baseline.pulledRevision)
      if (remote.has(record.key)) throw new Error('duplicate')
      remote.set(record.key, record)
    }
  } catch { problem('invalid_baseline'); return finish() }
  try {
    plain(snapshot)
    if (!Array.isArray(snapshot.entries) || Object.keys(snapshot.entries).length !== snapshot.entries.length
      || Object.values(Object.getOwnPropertyDescriptors(snapshot.entries)).some(item => !('value' in item))
      || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0
      || !(snapshot.raw === null || typeof snapshot.raw === 'string') || typeof snapshot.memory !== 'string') throw new Error('snapshot')
  } catch { problem('invalid_local_record'); return finish() }

  const seen = new Set<string>()
  for (const source of snapshot.entries) {
    let key: string | null = null
    try {
      const local = plain(source)
      if (Object.keys(local).some(field => !LOCAL_FIELDS.includes(field))
        || typeof local.code !== 'string' || !/^[0-9]{6}$/.test(local.code)
        || typeof local.updated_at !== 'string'
        || !(local.name == null || typeof local.name === 'string')
        || !(local.account == null || typeof local.account === 'string')
        || !(local.deleted == null || typeof local.deleted === 'boolean')
        || !(local.local_pending == null || local.local_pending === true)
        || !(local.position_kind == null || local.position_kind === 'watch' || local.position_kind === 'holding')
        || ['shares', 'cost', 'target_weight'].some(field => local[field] !== undefined
          && !nullableNumber(local[field], field === 'target_weight' ? 100 : Infinity))) throw new Error('local')
      const account = typeof local.account === 'string' ? local.account.trim() : ''
      key = normalizeOwnerSyncKey('watch', local.code + '::' + account)
      if (local.id != null && local.id !== key) throw new Error('identity')
      if (seen.has(key)) { problem('duplicate_key', key); continue }
      seen.add(key)
      const previous = remote.get(key) ?? null
      const deleted = local.deleted === true
      // Absent/deleted remote rows need no new DELETE; keep the local tombstone.
      if (deleted && (!previous || previous.deleted)) continue
      const recordKind = local.position_kind ?? (typeof local.shares === 'number' && local.shares > 0 ? 'holding' : null)
      if (recordKind !== 'watch' && recordKind !== 'holding') { problem('ambiguous_kind', key); continue }
      if (!deleted && previous?.deleted) { problem('cloud_tombstone', key); continue }
      if (!deleted && (recordKind === 'holding' && (local.shares == null)
        || recordKind === 'watch' && local.shares != null && local.shares !== 0)) {
        problem('missing_value', key); continue
      }
      if (deleted) {
        if (previous!.kind !== recordKind) { problem('invalid_operation', key); continue }
        operations.push({ key, kind: recordKind, deleted: true })
        rows.push({ key, code: local.code, account, action: 'delete', kind: recordKind, before: previous,
          after: { kind: recordKind, deleted: true, values: { ...previous!.values } }, fields: ['deleted'] })
      } else {
        const supplied: Record<string, string | number | null> = {}
        for (const field of FUND_FIELDS) if (has(local, field) && local[field] !== undefined) {
          if (field === 'name') {
            if (typeof local.name !== 'string' || !local.name.trim()) throw new Error('name')
            supplied.name = local.name
          } else supplied[field] = local[field] as number | null
        }
        const fresh = !previous || previous.kind !== recordKind
        if (fresh && !has(supplied, 'name')) { problem('missing_value', key); continue }
        const desired = fresh ? { name: supplied.name!, shares: null, cost: null, target_weight: null, ...supplied }
          : { ...previous.values, ...supplied }
        const changedFields = FUND_FIELDS.filter(field => !previous || previous.values[field] !== desired[field])
        const fields = previous && previous.kind !== recordKind ? ['kind', ...changedFields] : [...changedFields]
        if (!fresh && fields.length === 0) continue
        const changes = fresh ? desired : Object.fromEntries(changedFields.map(field => [field, desired[field]]))
        operations.push({ key, kind: recordKind, deleted: false, changes })
        rows.push({ key, code: local.code, account, action: !previous ? 'create' : previous.kind !== recordKind ? 'kind_change' : 'update',
          kind: recordKind, before: previous, after: { kind: recordKind, deleted: false, values: desired }, fields })
      }
      if (operations.length > OWNER_SYNC_MAX_OPERATIONS) { problem('too_many_operations'); break }
    } catch { problem('invalid_local_record', key) }
  }
  if (!issues.length && JSON.stringify(snapshot.entries) !== snapshot.memory) problem('invalid_local_record')
  if (!issues.length && operations.length) {
    try {
      // Shape/finance validation only: prepare owns exact packet hashing and
      // the 128 KiB bound. Nothing here splits batches or obtains consent.
      validateOwnerSyncRequest({ request_id: 'owner-preview-0001', expected_revision: baseline.pulledRevision, operations })
    } catch { problem('invalid_operation') }
  }
  return finish()
}
