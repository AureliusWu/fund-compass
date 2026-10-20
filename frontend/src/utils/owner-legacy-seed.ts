/** Explicit caller-supplied legacy/business codec only. No LS, IDB, Gist, session or download IO. */
import {
  canonicalOwnerWorkspaceEntries, validateOwnerWorkspaceEntries, validateOwnerWorkspaceLegacy,
  OWNER_WORKSPACE_MAX_ENTRIES, OWNER_WORKSPACE_MAX_IMAGE_BYTES, OwnerCloudImportError,
  type OwnerWorkspaceEntry, type OwnerWorkspaceLegacy,
} from '@/utils/owner-cloud-import'
import { normalizeOwnerSyncKey } from '@/utils/ownerSyncContract'

export const OWNER_BUSINESS_EXPORT_FORMAT = 'sinan-owner-business-export-1' as const
export const OWNER_BUSINESS_EXPORT_MAX_BYTES = OWNER_WORKSPACE_MAX_IMAGE_BYTES + 1024
export interface OwnerLegacySeed extends OwnerWorkspaceLegacy { readonly entries: readonly OwnerWorkspaceEntry[] }
export interface OwnerBusinessCounts {
  readonly total: number
  readonly watch: number
  readonly holding: number
  readonly tombstones: number
  readonly localPending: number
}
export interface OwnerBusinessExport {
  readonly format: typeof OWNER_BUSINESS_EXPORT_FORMAT
  readonly entries: readonly OwnerWorkspaceEntry[]
  readonly counts: OwnerBusinessCounts
  readonly entriesSha256: string
}
export interface BuiltOwnerBusinessExport {
  readonly envelope: OwnerBusinessExport
  readonly raw: string
  readonly sha256: string
  readonly byteLength: number
}
export type OwnerLegacySeedErrorCode = 'invalid_legacy' | 'ambiguous_kind' | 'missing_name'
  | 'capacity_exceeded' | 'invalid_export' | 'hash_mismatch' | 'hash_unavailable'
export class OwnerLegacySeedError extends Error {
  constructor(readonly code: OwnerLegacySeedErrorCode) { super('Owner business codec rejected'); this.name = 'OwnerLegacySeedError' }
}
type ShapeError = 'invalid_legacy' | 'invalid_export'
const LOCAL_FIELDS = ['code', 'name', 'shares', 'cost', 'target_weight', 'position_kind',
  'account', 'updated_at', 'deleted', 'id', 'local_pending']
const COUNT_FIELDS = ['total', 'watch', 'holding', 'tombstones', 'localPending']
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const encoder = new TextEncoder()
function fail(code: OwnerLegacySeedErrorCode): never { throw new OwnerLegacySeedError(code) }
function scalar(value: unknown, code: ShapeError): asserts value is string {
  if (typeof value !== 'string') fail(code)
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(code)
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail(code)
  }
}
function bytes(value: unknown, maximum: number, code: ShapeError): Uint8Array {
  scalar(value, code)
  if (value.length > maximum) fail('capacity_exceeded')
  const result = encoder.encode(value)
  if (result.byteLength > maximum) fail('capacity_exceeded')
  return result
}
function closed(value: unknown, required: readonly string[], optional: readonly string[], code: ShapeError): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) fail(code)
  return Object.fromEntries(Object.entries(descriptors).map(([key, item]) => [key, item.value]))
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}
/** Bounded JSON grammar: reject duplicate/escaped duplicate keys, unsafe integers and lone surrogates. */
function parse(raw: string, maximum: number, code: ShapeError): unknown {
  bytes(raw, maximum, code)
  let index = 0, nodes = 0
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
  const whitespace = () => { while (index < raw.length && /[ \t\r\n]/.test(raw[index])) index++ }
  function string(): string {
    const start = index++
    while (index < raw.length) {
      const char = raw[index++]
      if (char === '"') {
        let result: unknown
        try { result = JSON.parse(raw.slice(start, index)) } catch { fail(code) }
        scalar(result, code); return result
      }
      if (char.charCodeAt(0) < 32) fail(code)
      if (char === '\\') {
        const escape = raw[index++]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(raw.slice(index, index + 4))) fail(code)
          index += 4
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) fail(code)
      }
    }
    return fail(code)
  }
  function value(depth: number): unknown {
    if (depth > 6 || ++nodes > OWNER_WORKSPACE_MAX_ENTRIES * 16 + 16) fail('capacity_exceeded')
    whitespace()
    const char = raw[index]
    if (char === '"') return string()
    if (char === '{') {
      index++; whitespace()
      const result: Record<string, unknown> = Object.create(null)
      if (raw[index] === '}') { index++; return result }
      while (index < raw.length) {
        if (raw[index] !== '"') fail(code)
        const key = string()
        if (Object.prototype.hasOwnProperty.call(result, key)) fail(code)
        whitespace(); if (raw[index++] !== ':') fail(code)
        result[key] = value(depth + 1); whitespace()
        const end = raw[index++]
        if (end === '}') return result
        if (end !== ',') fail(code)
        whitespace()
      }
      return fail(code)
    }
    if (char === '[') {
      index++; whitespace()
      const result: unknown[] = []
      if (raw[index] === ']') { index++; return result }
      while (index < raw.length) {
        if (result.length >= OWNER_WORKSPACE_MAX_ENTRIES) fail('capacity_exceeded')
        result.push(value(depth + 1)); whitespace()
        const end = raw[index++]
        if (end === ']') return result
        if (end !== ',') fail(code)
      }
      return fail(code)
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(token, index)) { index += token.length; return result }
    }
    number.lastIndex = index
    const match = number.exec(raw)
    if (!match) return fail(code)
    index = number.lastIndex
    const token = match[0], result = Number(token)
    if (!Number.isFinite(result) || !/[.eE]/.test(token) && !Number.isSafeInteger(result)) fail(code)
    return result
  }
  const result = value(1)
  whitespace(); if (index !== raw.length) fail(code)
  return result
}
function entries(input: unknown, code: ShapeError): readonly OwnerWorkspaceEntry[] {
  try { return validateOwnerWorkspaceEntries(input) }
  catch (error) { return fail(error instanceof OwnerCloudImportError && error.code === 'capacity_exceeded' ? 'capacity_exceeded' : code) }
}
function validTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$(?![\s\S])/.test(value)) return false
  const stamp = Date.parse(value)
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value.slice(0, 10)
}
/** Both actual v1/v2 slots contain WatchEntry[]. This function never chooses the live source slot. */
export function decodeOwnerLegacySeed(input: unknown): OwnerLegacySeed {
  let source: OwnerWorkspaceLegacy
  try {
    const checked = validateOwnerWorkspaceLegacy(input)
    if (!checked) return fail('invalid_legacy')
    source = checked
  } catch (error) { return fail(error instanceof OwnerCloudImportError && error.code === 'capacity_exceeded' ? 'capacity_exceeded' : 'invalid_legacy') }
  if (source.raw === null) return frozen({ ...source, entries: [] })
  const parsed = parse(source.raw, OWNER_WORKSPACE_MAX_IMAGE_BYTES, 'invalid_legacy')
  if (!Array.isArray(parsed)) fail('invalid_legacy')
  const projected = parsed.map(value => {
    const row = closed(value, ['code', 'updated_at'], LOCAL_FIELDS, 'invalid_legacy')
    if (typeof row.code !== 'string' || !/^[0-9]{6}(?![\s\S])/.test(row.code) || !validTimestamp(row.updated_at)
      || !(row.account == null || typeof row.account === 'string' && row.account.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(row.account))
      || !(row.deleted == null || typeof row.deleted === 'boolean')
      || !(row.local_pending == null || row.local_pending === true)
      || !(row.position_kind == null || row.position_kind === 'watch' || row.position_kind === 'holding')
      || ['shares', 'cost', 'target_weight'].some(field => row[field] != null && (typeof row[field] !== 'number'
        || !Number.isFinite(row[field]) || (row[field] as number) < 0 || field === 'target_weight' && (row[field] as number) > 100))) fail('invalid_legacy')
    if (typeof row.name !== 'string' || !row.name.trim()) fail('missing_name')
    let key: string
    try { key = normalizeOwnerSyncKey('watch', row.code + '::' + (typeof row.account === 'string' ? row.account.trim() : '')) }
    catch { return fail('invalid_legacy') }
    if (row.id != null && row.id !== key) fail('invalid_legacy')
    // Match the existing Owner preview's historical-positive rule. Zero/unknown
    // without explicit kind is ambiguous, never silently converted to watch.
    const kind = row.position_kind ?? (typeof row.shares === 'number' && row.shares > 0 ? 'holding' : null)
    if (kind !== 'holding' && kind !== 'watch') fail('ambiguous_kind')
    return { key, kind, deleted: row.deleted === true, local_pending: row.local_pending === true,
      values: { name: row.name, shares: row.shares ?? null, cost: row.cost ?? null, target_weight: row.target_weight ?? null } }
  })
  return frozen({ ...source, entries: entries(projected, 'invalid_legacy') })
}
function counts(input: readonly OwnerWorkspaceEntry[]): OwnerBusinessCounts {
  return frozen({ total: input.length, watch: input.filter(row => row.kind === 'watch').length,
    holding: input.filter(row => row.kind === 'holding').length, tombstones: input.filter(row => row.deleted).length,
    localPending: input.filter(row => row.local_pending).length })
}
async function digest(raw: string): Promise<string> {
  try {
    const result = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(raw))
    return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('')
  } catch { return fail('hash_unavailable') }
}
/** Only business entries are exported, never the raw archive, credentials, timestamps or cloud revisions. */
export async function buildOwnerBusinessExport(input: unknown): Promise<BuiltOwnerBusinessExport> {
  const copy = entries(input, 'invalid_export')
  const envelope = frozen({ format: OWNER_BUSINESS_EXPORT_FORMAT, entries: copy, counts: counts(copy),
    entriesSha256: await digest(canonicalOwnerWorkspaceEntries(copy)) })
  const raw = canonical(envelope), byteLength = bytes(raw, OWNER_BUSINESS_EXPORT_MAX_BYTES, 'invalid_export').byteLength
  return frozen({ envelope, raw, sha256: await digest(raw), byteLength })
}
/** Pure re-import validation only. Hashes detect changed bytes, not source identity, consent or actual restoration. */
export async function restoreOwnerBusinessExport(raw: unknown, expectedSha256: unknown): Promise<OwnerBusinessExport> {
  bytes(raw, OWNER_BUSINESS_EXPORT_MAX_BYTES, 'invalid_export')
  if (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256)) fail('invalid_export')
  if (await digest(raw as string) !== expectedSha256) fail('hash_mismatch')
  const row = closed(parse(raw as string, OWNER_BUSINESS_EXPORT_MAX_BYTES, 'invalid_export'),
    ['format', 'entries', 'counts', 'entriesSha256'], [], 'invalid_export')
  if (row.format !== OWNER_BUSINESS_EXPORT_FORMAT || typeof row.entriesSha256 !== 'string' || !HASH.test(row.entriesSha256)) fail('invalid_export')
  const copy = entries(row.entries, 'invalid_export'), tally = counts(copy)
  if (canonical(closed(row.counts, COUNT_FIELDS, [], 'invalid_export')) !== canonical(tally)) fail('invalid_export')
  if (await digest(canonicalOwnerWorkspaceEntries(copy)) !== row.entriesSha256) fail('hash_mismatch')
  const envelope = frozen({ format: OWNER_BUSINESS_EXPORT_FORMAT, entries: copy, counts: tally, entriesSha256: row.entriesSha256 })
  if (canonical(envelope) !== raw) fail('invalid_export')
  return envelope
}
