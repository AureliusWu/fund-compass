/** Explicit local portfolio codec. No storage, network, credentials or implicit migration.
 * Hashes bind bytes; they do not authenticate a source or acknowledge a cloud write. */
import { canonicalOwnerLocal } from './owner-workspace-backup'
import { parseOwnerBusinessJson } from './owner-legacy-seed'
import { normalizeOwnerSyncKey, validateOwnerSyncRecord } from './ownerSyncContract'

export const OWNER_PORTFOLIO_LOCAL_SCHEMA = 'owner-portfolio-local-1' as const
export const OWNER_PORTFOLIO_MAX_RAW_BYTES = 2 * 1024 * 1024
export const OWNER_PORTFOLIO_MAX_BYTES = 8 * 1024 * 1024
export const OWNER_PORTFOLIO_MAX_HISTORY = 2000
export const OWNER_PORTFOLIO_MAX_MANUAL = 2000
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const encoder = new TextEncoder()
export type OwnerPortfolioManualClass = '现金' | '权益' | '商品'
export interface OwnerPortfolioManualValues {
  readonly name: string
  readonly cls: OwnerPortfolioManualClass
  readonly value: number
  readonly note: string | null
}
export interface OwnerPortfolioManual {
  readonly key: string
  readonly legacyId: string | null
  readonly deleted: boolean
  readonly values: OwnerPortfolioManualValues
  readonly updated_at: string | null
  readonly local_pending: true
}
export interface OwnerPortfolioLegacyHolding {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly account: string
  readonly type: string
  readonly value: number
  readonly cost: number
}
export interface OwnerPortfolioLegacyHistory {
  readonly id: string
  readonly kind: 'legacy'
  readonly observed_at: null
  readonly date: string
  readonly calendar: 'legacy-utc'
  readonly value: number
  readonly cost: number
  readonly holdings: readonly OwnerPortfolioLegacyHolding[] | null
}
export type OwnerPortfolioObservationHolding = {
  readonly kind: 'fund'; readonly key: string; readonly name: string; readonly type: string
  readonly value: number; readonly cost: number | null
} | {
  readonly kind: 'manual'; readonly key: string; readonly name: string; readonly cls: OwnerPortfolioManualClass
  readonly value: number; readonly cost: null
}
/** A balance observation, not cash-flow-adjusted performance or a transaction ledger. */
export interface OwnerPortfolioObservation {
  readonly id: string
  readonly kind: 'observation'
  readonly observed_at: string
  readonly date: string
  readonly calendar: 'Asia/Shanghai'
  readonly value: number
  readonly cost: number | null
  readonly holdings: readonly OwnerPortfolioObservationHolding[]
}
export type OwnerPortfolioHistory = OwnerPortfolioLegacyHistory | OwnerPortfolioObservation
export interface OwnerPortfolioIdMapping {
  readonly legacyId: string
  readonly key: string
  readonly mode: 'identity' | 'sha256'
  readonly idSha256: string | null
}
export interface OwnerPortfolioMigrationSource {
  readonly manualRaw: string | null
  readonly snapshotsRaw: string | null
}
export interface OwnerPortfolioMigration extends OwnerPortfolioMigrationSource {
  readonly sourceSha256: string
  readonly idMappings: readonly OwnerPortfolioIdMapping[]
}
export interface OwnerPortfolioLocal {
  readonly schema: typeof OWNER_PORTFOLIO_LOCAL_SCHEMA
  readonly manual: readonly OwnerPortfolioManual[]
  readonly history: readonly OwnerPortfolioHistory[]
  readonly migration: OwnerPortfolioMigration
}
export type OwnerPortfolioErrorCode = 'invalid_portfolio' | 'invalid_command' | 'invalid_source'
  | 'capacity_exceeded' | 'hash_mismatch' | 'hash_unavailable' | 'deleted_asset' | 'missing_asset' | 'duplicate_history'
export class OwnerPortfolioLocalError extends Error {
  constructor(readonly code: OwnerPortfolioErrorCode = 'invalid_portfolio') {
    super('Owner local portfolio rejected'); this.name = 'OwnerPortfolioLocalError'
  }
}
export interface OwnerPortfolioMigrationIssue {
  readonly source: 'manual' | 'snapshots' | 'portfolio'
  readonly index: number | null
  readonly code: 'invalid_raw' | 'capacity_exceeded' | 'invalid_manual' | 'duplicate_manual_id'
    | 'incompatible_manual_value' | 'id_collision' | 'invalid_snapshot' | 'hash_unavailable'
}
export interface OwnerPortfolioMigrationPreview {
  readonly source: OwnerPortfolioMigrationSource
  readonly sourceSha256: string | null
  readonly issues: readonly OwnerPortfolioMigrationIssue[]
  readonly idMappings: readonly OwnerPortfolioIdMapping[]
  readonly portfolio: OwnerPortfolioLocal | null
}
export type OwnerPortfolioCommand = {
  readonly type: 'save_manual'; readonly key: string; readonly values: OwnerPortfolioManualValues; readonly updated_at: string
} | {
  readonly type: 'remove_manual'; readonly key: string; readonly updated_at: string
} | {
  readonly type: 'append_observation'; readonly observation: OwnerPortfolioObservation
}

function fail(code: OwnerPortfolioErrorCode = 'invalid_portfolio'): never { throw new OwnerPortfolioLocalError(code) }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail()
  return Object.fromEntries(Object.entries(descriptors).map(([key, row]) => [key, row.value]))
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail()
  if (value.length > maximum) fail('capacity_exceeded')
  if (Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, row]) => !('value' in row) || key !== 'length' && !row.enumerable)) fail()
  return value
}
function scalar(value: unknown): string {
  if (typeof value !== 'string') fail()
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail()
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail()
  }
  return value
}
function bounded(value: unknown, maximum: number, exclusive = false): string {
  const raw = scalar(value)
  if (raw.length > maximum || encoder.encode(raw).byteLength > maximum
    || exclusive && (raw.length === maximum || encoder.encode(raw).byteLength === maximum)) fail('capacity_exceeded')
  return raw
}
function text(value: unknown, maximum: number, empty = true): string {
  const result = scalar(value)
  if (result.length > maximum || !empty && !result.trim()) fail()
  return result
}
function amount(value: unknown, nullable = false): number | null {
  if (value === null && nullable) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || !/[.eE]/.test(JSON.stringify(value)) && !Number.isSafeInteger(value)) fail()
  return value
}
function day(value: unknown): string {
  const result = scalar(value)
  if (!/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(result)) fail()
  const parsed = Date.parse(result + 'T00:00:00Z')
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== result) fail()
  return result
}
function utc(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null
  const result = scalar(value)
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$(?![\s\S])/.exec(result)
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== match[1]) fail()
  return result
}
function manualKey(value: unknown): string {
  try { const key = normalizeOwnerSyncKey('manual_asset', value); if (key !== value) fail(); return key } catch { return fail() }
}
function manualValues(value: unknown): OwnerPortfolioManualValues {
  const copy = fields(value, ['name', 'cls', 'value', 'note'])
  try {
    // Validation-only stamps are never persisted and are not cloud revisions.
    const checked = validateOwnerSyncRecord({ key: 'asset:validation-only', kind: 'manual_asset', deleted: false,
      record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, cls: 1, value: 1, note: 1 }, values: copy }, 1)
    return { name: checked.values.name as string, cls: checked.values.cls as OwnerPortfolioManualClass,
      value: checked.values.value as number, note: checked.values.note as string | null }
  } catch { return fail() }
}
function manual(value: unknown): OwnerPortfolioManual {
  const row = fields(value, ['key', 'legacyId', 'deleted', 'values', 'updated_at', 'local_pending'])
  if (typeof row.deleted !== 'boolean' || row.local_pending !== true) fail()
  return { key: manualKey(row.key), legacyId: row.legacyId === null ? null : text(row.legacyId, 200, false),
    deleted: row.deleted, values: manualValues(row.values), updated_at: utc(row.updated_at, true), local_pending: true }
}
function legacyHolding(value: unknown): OwnerPortfolioLegacyHolding {
  const row = fields(value, ['id', 'code', 'name', 'account', 'type', 'value', 'cost'])
  return { id: text(row.id, 512, false), code: text(row.code, 200), name: text(row.name, 200),
    account: text(row.account, 200), type: text(row.type, 200), value: amount(row.value)!, cost: amount(row.cost)! }
}
function legacySnapshot(value: unknown, index: number): OwnerPortfolioLegacyHistory {
  const row = fields(value, ['date', 'value', 'cost'], ['holdings'])
  return { id: 'legacy:' + index, kind: 'legacy', observed_at: null, date: day(row.date), calendar: 'legacy-utc',
    value: amount(row.value)!, cost: amount(row.cost)!, holdings: 'holdings' in row
      ? list(row.holdings, OWNER_PORTFOLIO_MAX_MANUAL).map(legacyHolding) : null }
}
function archivedLegacySnapshot(value: unknown, index: number): OwnerPortfolioLegacyHistory {
  const row = fields(value, ['id', 'kind', 'observed_at', 'date', 'calendar', 'value', 'cost', 'holdings'])
  if (row.id !== 'legacy:' + index || row.kind !== 'legacy' || row.observed_at !== null || row.calendar !== 'legacy-utc') fail()
  return { id: row.id, kind: 'legacy', observed_at: null, date: day(row.date), calendar: 'legacy-utc',
    value: amount(row.value)!, cost: amount(row.cost)!, holdings: row.holdings === null ? null
      : list(row.holdings, OWNER_PORTFOLIO_MAX_MANUAL).map(legacyHolding) }
}
function observationHolding(value: unknown): OwnerPortfolioObservationHolding {
  const row = fields(value, ['kind', 'key', 'name', 'value', 'cost'], ['type', 'cls'])
  if (row.kind === 'manual') {
    if ('type' in row || !('cls' in row) || row.cost !== null) fail()
    const checked = manualValues({ name: row.name, cls: row.cls, value: row.value, note: null })
    return { kind: 'manual', key: manualKey(row.key), name: checked.name, cls: checked.cls, value: checked.value, cost: null }
  }
  if (row.kind !== 'fund' || 'cls' in row || !('type' in row)) fail()
  let key: string, name: string
  try {
    const checked = validateOwnerSyncRecord({ key: row.key, kind: 'holding', deleted: false,
      record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
      values: { name: row.name, shares: null, cost: null, target_weight: null } }, 1)
    key = checked.key; name = checked.values.name as string
  } catch { return fail() }
  return { kind: 'fund', key, name, type: text(row.type, 200),
    value: amount(row.value)!, cost: amount(row.cost, true) }
}
function observation(value: unknown): OwnerPortfolioObservation {
  const row = fields(value, ['id', 'kind', 'observed_at', 'date', 'calendar', 'value', 'cost', 'holdings'])
  if (typeof row.id !== 'string' || !ID.test(row.id) || row.kind !== 'observation' || row.calendar !== 'Asia/Shanghai') fail()
  const observed_at = utc(row.observed_at)!, date = day(row.date)
  if (new Date(Date.parse(observed_at) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== date) fail()
  const holdings = list(row.holdings, OWNER_PORTFOLIO_MAX_MANUAL).map(observationHolding)
  if (new Set(holdings.map(item => item.key)).size !== holdings.length) fail()
  const valueTotal = holdings.reduce((total, item) => total + item.value, 0)
  const costTotal = holdings.some(item => item.cost === null) ? null : holdings.reduce((total, item) => total + item.cost!, 0)
  const total = amount(row.value)!, cost = amount(row.cost, true)
  if (!Number.isFinite(valueTotal) || !Object.is(total, valueTotal) && total !== valueTotal
    || costTotal === null && cost !== null || costTotal !== null && (!Number.isFinite(costTotal) || cost !== costTotal)) fail()
  return { id: row.id, kind: 'observation', observed_at, date, calendar: 'Asia/Shanghai', value: total, cost, holdings }
}
interface LegacyManual { readonly id: string; readonly values: OwnerPortfolioManualValues; readonly updated_at: string }
function decodeManual(raw: string | null): readonly LegacyManual[] {
  if (raw === null) return []
  const rows = list(parseOwnerBusinessJson(bounded(raw, OWNER_PORTFOLIO_MAX_RAW_BYTES, true), OWNER_PORTFOLIO_MAX_RAW_BYTES, 5), OWNER_PORTFOLIO_MAX_MANUAL)
  const result = rows.map(input => {
    const row = fields(input, ['id', 'name', 'cls', 'value', 'updated_at'], ['note'])
    const id = text(row.id, 200, false), updated_at = utc(row.updated_at)!
    if ('note' in row && typeof row.note !== 'string') fail()
    // Missing legacy note maps explicitly to wire null; original spelling stays in raw.
    const values = manualValues({ name: row.name, cls: row.cls, value: row.value, note: 'note' in row ? row.note : null })
    return { id, values, updated_at }
  })
  if (new Set(result.map(item => item.id)).size !== result.length) fail()
  if (!Number.isFinite(result.reduce((sum, item) => sum + item.values.value, 0))) fail()
  return result
}
function decodeSnapshots(raw: string | null): readonly OwnerPortfolioLegacyHistory[] {
  if (raw === null) return []
  return list(parseOwnerBusinessJson(bounded(raw, OWNER_PORTFOLIO_MAX_RAW_BYTES, true), OWNER_PORTFOLIO_MAX_RAW_BYTES, 6), OWNER_PORTFOLIO_MAX_HISTORY).map(legacySnapshot)
}
function mapping(value: unknown): OwnerPortfolioIdMapping {
  const row = fields(value, ['legacyId', 'key', 'mode', 'idSha256'])
  const legacyId = text(row.legacyId, 200, false), key = manualKey(row.key)
  let identity: string | null = null
  try { identity = manualKey('asset:' + legacyId) } catch { /* Explicit mapping, never trimming. */ }
  if (identity !== null) {
    if (row.mode !== 'identity' || row.idSha256 !== null || key !== identity) fail()
  } else if (row.mode !== 'sha256' || typeof row.idSha256 !== 'string' || !HASH.test(row.idSha256)
    || key !== 'asset:legacy-' + row.idSha256) fail()
  return { legacyId, key, mode: row.mode as OwnerPortfolioIdMapping['mode'], idSha256: row.idSha256 as string | null }
}
function migration(value: unknown): { migration: OwnerPortfolioMigration; initial: readonly LegacyManual[]; history: readonly OwnerPortfolioLegacyHistory[] } {
  const row = fields(value, ['manualRaw', 'snapshotsRaw', 'sourceSha256', 'idMappings'])
  const source = { manualRaw: row.manualRaw === null ? null : bounded(row.manualRaw, OWNER_PORTFOLIO_MAX_RAW_BYTES, true),
    snapshotsRaw: row.snapshotsRaw === null ? null : bounded(row.snapshotsRaw, OWNER_PORTFOLIO_MAX_RAW_BYTES, true) }
  if (typeof row.sourceSha256 !== 'string' || !HASH.test(row.sourceSha256)) fail()
  const initial = decodeManual(source.manualRaw), history = decodeSnapshots(source.snapshotsRaw)
  const idMappings = list(row.idMappings, OWNER_PORTFOLIO_MAX_MANUAL).map(mapping)
  if (idMappings.length !== initial.length || new Set(idMappings.map(item => item.key)).size !== idMappings.length
    || initial.some((item, index) => item.id !== idMappings[index].legacyId)) fail()
  return { migration: { ...source, sourceSha256: row.sourceSha256, idMappings }, initial, history }
}
/** Synchronous shape/origin validation for an already asynchronously verified full image.
 * It deliberately does not claim to recompute SHA-256 inside an IDB transaction. */
export function validateOwnerPortfolioLocal(input: unknown): OwnerPortfolioLocal {
  try {
    const row = fields(input, ['schema', 'manual', 'history', 'migration'])
    if (row.schema !== OWNER_PORTFOLIO_LOCAL_SCHEMA) fail()
    const origin = migration(row.migration)
    let used = encoder.encode(canonicalOwnerLocal({ schema: OWNER_PORTFOLIO_LOCAL_SCHEMA, manual: [], history: [], migration: origin.migration })).byteLength
    const charge = (value: unknown, index: number) => {
      used += encoder.encode(canonicalOwnerLocal(value)).byteLength + (index ? 1 : 0)
      if (used > OWNER_PORTFOLIO_MAX_BYTES) fail('capacity_exceeded')
    }
    const manualRows = list(row.manual, OWNER_PORTFOLIO_MAX_MANUAL).map((value, index) => { const checked = manual(value); charge(checked, index); return checked })
    const manualByKey = new Map(manualRows.map(item => [item.key, item]))
    if (manualByKey.size !== manualRows.length) fail()
    if (!Number.isFinite(manualRows.reduce((sum, item) => sum + (item.deleted ? 0 : item.values.value), 0))) fail()
    const origins = new Map(origin.migration.idMappings.map(item => [item.key, item.legacyId]))
    if (origin.migration.idMappings.some(item => manualByKey.get(item.key)?.legacyId !== item.legacyId)
      || manualRows.some(item => item.legacyId === null ? origins.has(item.key) : origins.get(item.key) !== item.legacyId)) fail()
    const sourceHistory = list(row.history, OWNER_PORTFOLIO_MAX_HISTORY)
    if (sourceHistory.length < origin.history.length) fail()
    const history: OwnerPortfolioHistory[] = sourceHistory.map((item, index) => {
      if (index < origin.history.length) {
        // The raw archive, including ordering, duplicate dates and opaque ids, is immutable.
        const checked = archivedLegacySnapshot(item, index)
        if (canonicalOwnerLocal(checked) !== canonicalOwnerLocal(origin.history[index])) fail()
        charge(checked, index)
        return origin.history[index]
      }
      const checked = observation(item); charge(checked, index); return checked
    })
    if (new Set(history.map(item => item.id)).size !== history.length) fail()
    const result = { schema: OWNER_PORTFOLIO_LOCAL_SCHEMA, manual: manualRows, history, migration: origin.migration }
    bounded(canonicalOwnerLocal(result), OWNER_PORTFOLIO_MAX_BYTES)
    return frozen(result)
  } catch (error) {
    if (error instanceof OwnerPortfolioLocalError) throw error
    return fail()
  }
}
async function sha(raw: string): Promise<string> {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)))].map(item => item.toString(16).padStart(2, '0')).join('') }
  catch { return fail('hash_unavailable') }
}
const idHashInput = (legacyId: string) => canonicalOwnerLocal({ schema: 'owner-portfolio-legacy-id-1', legacyId })
/** Must run outside a transaction before its synchronous full-image CAS. */
export async function verifyOwnerPortfolioMigration(input: unknown): Promise<OwnerPortfolioLocal> {
  const portfolio = validateOwnerPortfolioLocal(input), { manualRaw, snapshotsRaw, sourceSha256, idMappings } = portfolio.migration
  if (await sha(canonicalOwnerLocal({ manualRaw, snapshotsRaw })) !== sourceSha256) fail('hash_mismatch')
  for (const item of idMappings) if (item.mode === 'sha256' && await sha(idHashInput(item.legacyId)) !== item.idSha256) fail('hash_mismatch')
  return portfolio
}
/** All source problems block the whole migration; caller retains the original file/raw. */
export async function previewOwnerPortfolioMigration(input: OwnerPortfolioMigrationSource): Promise<OwnerPortfolioMigrationPreview> {
  const row = fields(input, ['manualRaw', 'snapshotsRaw'])
  if (row.manualRaw !== null && typeof row.manualRaw !== 'string' || row.snapshotsRaw !== null && typeof row.snapshotsRaw !== 'string') fail('invalid_source')
  const source = { manualRaw: row.manualRaw as string | null, snapshotsRaw: row.snapshotsRaw as string | null }
  const issues: OwnerPortfolioMigrationIssue[] = [], idMappings: OwnerPortfolioIdMapping[] = []
  for (const [name, raw] of [['manual', source.manualRaw], ['snapshots', source.snapshotsRaw]] as const) {
    if (raw === null) continue
    try { bounded(raw, OWNER_PORTFOLIO_MAX_RAW_BYTES, true) } catch (error) {
      issues.push({ source: name, index: null, code: error instanceof OwnerPortfolioLocalError && error.code === 'capacity_exceeded' ? 'capacity_exceeded' : 'invalid_raw' })
    }
  }
  if (issues.length) return frozen({ source, sourceSha256: null, issues, idMappings, portfolio: null })
  let sourceSha256: string
  try { sourceSha256 = await sha(canonicalOwnerLocal(source)) } catch {
    return frozen({ source, sourceSha256: null, issues: [{ source: 'portfolio', index: null, code: 'hash_unavailable' as const }], idMappings, portfolio: null })
  }
  let manualRows: readonly LegacyManual[] = [], history: readonly OwnerPortfolioLegacyHistory[] = []
  try { manualRows = decodeManual(source.manualRaw) } catch (error) {
    issues.push({ source: 'manual', index: null, code: error instanceof OwnerPortfolioLocalError && error.code === 'capacity_exceeded' ? 'capacity_exceeded' : 'invalid_manual' })
  }
  try { history = decodeSnapshots(source.snapshotsRaw) } catch (error) {
    issues.push({ source: 'snapshots', index: null, code: error instanceof OwnerPortfolioLocalError && error.code === 'capacity_exceeded' ? 'capacity_exceeded' : 'invalid_snapshot' })
  }
  try {
    for (const item of manualRows) {
      let identity: string | null = null
      try { identity = manualKey('asset:' + item.id) } catch { /* An explicit displayed mapping follows. */ }
      const idSha256 = identity === null ? await sha(idHashInput(item.id)) : null
      idMappings.push({ legacyId: item.id, key: identity ?? 'asset:legacy-' + idSha256,
        mode: identity === null ? 'sha256' : 'identity', idSha256 })
    }
  } catch {
    issues.push({ source: 'portfolio', index: null, code: 'hash_unavailable' })
  }
  if (new Set(idMappings.map(item => item.key)).size !== idMappings.length) issues.push({ source: 'manual', index: null, code: 'id_collision' })
  if (issues.length) return frozen({ source, sourceSha256, issues, idMappings, portfolio: null })
  let portfolio: OwnerPortfolioLocal
  try {
    portfolio = validateOwnerPortfolioLocal({ schema: OWNER_PORTFOLIO_LOCAL_SCHEMA,
      manual: manualRows.map((item, index) => ({ key: idMappings[index].key, legacyId: item.id, deleted: false,
        values: item.values, updated_at: item.updated_at, local_pending: true })), history,
      migration: { ...source, sourceSha256, idMappings } })
  } catch (error) {
    issues.push({ source: 'portfolio', index: null, code: error instanceof OwnerPortfolioLocalError && error.code === 'capacity_exceeded' ? 'capacity_exceeded' : 'invalid_raw' })
    return frozen({ source, sourceSha256, issues, idMappings, portfolio: null })
  }
  return frozen({ source, sourceSha256, issues, idMappings, portfolio })
}
/** Closed independent copy to freeze before request hashing or any asynchronous work. */
export function validateOwnerPortfolioCommand(input: unknown): OwnerPortfolioCommand {
  try {
    const row = fields(input, ['type'], ['key', 'values', 'updated_at', 'observation'])
    if (row.type === 'append_observation') {
      fields(row, ['type', 'observation'])
      return frozen({ type: 'append_observation', observation: observation(row.observation) })
    }
    if (row.type === 'save_manual') {
      fields(row, ['type', 'key', 'values', 'updated_at'])
      return frozen({ type: 'save_manual', key: manualKey(row.key), values: manualValues(row.values), updated_at: utc(row.updated_at)! })
    }
    if (row.type === 'remove_manual') {
      fields(row, ['type', 'key', 'updated_at'])
      return frozen({ type: 'remove_manual', key: manualKey(row.key), updated_at: utc(row.updated_at)! })
    }
    return fail('invalid_command')
  } catch { return fail('invalid_command') }
}
/** Pure postimage only. The real workspace transaction owns version/receipt/empty-slot CAS. */
export function applyOwnerPortfolioCommand(input: unknown, command: unknown): { readonly portfolio: OwnerPortfolioLocal; readonly changedKeys: readonly string[] } {
  const before = validateOwnerPortfolioLocal(input), row = validateOwnerPortfolioCommand(command)
  let next: OwnerPortfolioLocal, changedKeys: string[]
  try {
    if (row.type === 'append_observation') {
      const item = row.observation
      if (before.history.some(existing => existing.id === item.id)) fail('duplicate_history')
      next = { ...before, history: [...before.history, item] }; changedKeys = ['history:' + item.id]
    } else if (row.type === 'save_manual' || row.type === 'remove_manual') {
      const { key, updated_at } = row, index = before.manual.findIndex(item => item.key === key), previous = before.manual[index]
      if (previous?.deleted) fail('deleted_asset')
      if (row.type === 'remove_manual' && !previous) fail('missing_asset')
      if (previous?.updated_at !== null && previous?.updated_at !== undefined && Date.parse(updated_at) < Date.parse(previous.updated_at)) fail()
      const item: OwnerPortfolioManual = row.type === 'remove_manual' ? { ...previous!, deleted: true, updated_at }
        : { key, legacyId: previous?.legacyId ?? null, deleted: false, values: row.values, updated_at, local_pending: true }
      next = { ...before, manual: index < 0 ? [...before.manual, item] : before.manual.map((current, at) => at === index ? item : current) }
      changedKeys = [key]
    } else return fail('invalid_command')
    return frozen({ portfolio: validateOwnerPortfolioLocal(next), changedKeys })
  } catch (error) {
    if (error instanceof OwnerPortfolioLocalError && ['capacity_exceeded', 'deleted_asset', 'missing_asset', 'duplicate_history'].includes(error.code)) throw error
    return fail('invalid_command')
  }
}
