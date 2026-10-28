/** Pure candidate contracts. No network, session, storage or application wiring. */
export const OWNER_SYNC_MAX_BODY_BYTES = 128 * 1024
export const OWNER_SYNC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const OWNER_SYNC_MAX_JSON_DEPTH = 8
export const OWNER_SYNC_MAX_OPERATIONS = 200
const MAX_JSON_NODES = 50_000
const MAX_REVISION = Number.MAX_SAFE_INTEGER
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/
const FUND_FIELDS = ['name', 'shares', 'cost', 'target_weight'] as const
const MANUAL_FIELDS = ['name', 'cls', 'value', 'note'] as const
const KINDS = ['watch', 'holding', 'manual_asset'] as const
const CONFLICT_FIELDS = ['cls', 'cost', 'deleted', 'expected_revision', 'kind', 'name', 'note', 'record_revision', 'shares', 'target_weight', 'value'] as const

export type OwnerSyncKind = typeof KINDS[number]
export type OwnerSyncValue = string | number | boolean | null
export type OwnerSyncValues = Readonly<Record<string, OwnerSyncValue>>
export interface OwnerSyncOperation {
  readonly key: string
  readonly kind: OwnerSyncKind
  readonly deleted: boolean
  readonly changes?: OwnerSyncValues
  readonly base_values?: OwnerSyncValues
}
export interface OwnerSyncRequest {
  readonly request_id: string
  readonly expected_revision: number
  readonly operations: readonly OwnerSyncOperation[]
}
export type OwnerSyncRequestInput = OwnerSyncRequest
export interface BuiltOwnerSyncRequest {
  readonly request: OwnerSyncRequest
  readonly rawBody: string
  readonly requestHash: string
  readonly byteLength: number
}
export interface OwnerSyncRecord {
  readonly key: string
  readonly kind: OwnerSyncKind
  readonly deleted: boolean
  readonly record_revision: number
  readonly lifecycle_revision: number
  readonly field_revisions: Readonly<Record<string, number>>
  readonly values: OwnerSyncValues
}
export type OwnerSyncCursor = readonly [number, string]
export interface OwnerSyncPageContext {
  readonly sinceRevision: number
  readonly upperRevision?: number
  readonly cursor?: OwnerSyncCursor
  readonly limit?: number
}
export interface OwnerSyncChangesPage {
  readonly upper_revision: number
  readonly changes: readonly OwnerSyncRecord[]
  readonly next_cursor: OwnerSyncCursor | null
  readonly complete: boolean
}
export interface OwnerSyncWriteResult {
  readonly revision: number
  readonly records: readonly OwnerSyncRecord[]
}
export interface OwnerSyncConflict {
  readonly error: { readonly code: 'sync_conflict'; readonly message: string }
  readonly conflicts: readonly { readonly key_digest: string; readonly fields: readonly string[] }[]
}
export type OwnerSyncWriteResponse =
  | { readonly kind: 'success'; readonly status: 200; readonly result: OwnerSyncWriteResult }
  | { readonly kind: 'conflict'; readonly status: 409; readonly result: OwnerSyncConflict }
  | { readonly kind: 'idempotency_conflict'; readonly status: 409; readonly error: { readonly code: 'idempotency_conflict'; readonly message: string } }
  // Even a 401 can arrive after a commit. A failure is NOT proof of rollback.
  | { readonly kind: 'failure'; readonly status: number; readonly code: string }
export type OwnerSyncReceiptResponse =
  | { readonly state: 'matched'; readonly status: 200; readonly result: OwnerSyncWriteResult }
  | { readonly state: 'matched'; readonly status: 409; readonly result: OwnerSyncConflict }
  | { readonly state: 'unknown'; readonly status: 404 | 503; readonly error: 'sync_result_unknown' }

export class OwnerSyncContractError extends Error {
  constructor(readonly code: 'invalid_sync_contract' | 'invalid_sync_request' | 'invalid_sync_restore' | 'sync_hash_unavailable' = 'invalid_sync_contract') {
    super('Owner sync contract rejected')
    this.name = 'OwnerSyncContractError'
  }
}
function reject(): never { throw new OwnerSyncContractError() }
function scalarString(value: unknown): asserts value is string {
  if (typeof value !== 'string') reject()
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject()
    } else if (code >= 0xdc00 && code <= 0xdfff) reject()
  }
}
function text(value: unknown, maximum: number, empty = false): string {
  scalarString(value)
  if (value.length > maximum || CONTROLS.test(value) || (!empty && !value.trim())) reject()
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) reject()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) reject()
  return value as Record<string, unknown>
}
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const row = object(value)
  const keys = Object.keys(row)
  if (keys.some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(row, key))) reject()
  return row
}
function list(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).some((key, index) => key !== String(index))) reject()
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !('value' in item))) reject()
  return value
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

// Keep lexical integer/float identity until strict response validation finishes.
// JSON.parse alone cannot distinguish an unsafe integer from a rounded value,
// or an integer revision from the JSON float token 1.0.
class JsonNumber {
  constructor(readonly value: number, readonly integerToken: boolean) {}
}
function revision(value: unknown, minimum = 0): number {
  if (value instanceof JsonNumber) {
    if (!value.integerToken) reject()
    value = value.value
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_REVISION) reject()
  return value
}
function finance(value: unknown, nullable: boolean, upper = Infinity): number | null {
  if (value === null && nullable) return null
  const raw = value instanceof JsonNumber ? value.value : value
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > upper) reject()
  // Match the backend: integer JSON tokens must be safe; exponent/decimal
  // tokens are finite floats. A new browser request uses JS's number spelling.
  const integerToken = value instanceof JsonNumber ? value.integerToken : !/[.eE]/.test(JSON.stringify(raw))
  if (integerToken && !Number.isSafeInteger(raw)) reject()
  return raw
}
function kind(value: unknown): OwnerSyncKind {
  if (typeof value !== 'string' || !(KINDS as readonly string[]).includes(value)) reject()
  return value as OwnerSyncKind
}
function fieldsFor(value: OwnerSyncKind): readonly string[] { return value === 'manual_asset' ? MANUAL_FIELDS : FUND_FIELDS }

export function normalizeOwnerSyncKey(recordKind: OwnerSyncKind, value: unknown): string {
  kind(recordKind)
  scalarString(value)
  if (value.length < 6 || value.length > 160) reject()
  if (recordKind === 'manual_asset') {
    if (!value.startsWith('asset:')) reject()
    const identifier = text(value.slice(6), 154)
    if (identifier !== identifier.trim()) reject()
    return 'asset:' + identifier
  }
  if (!/^[0-9]{6}::/.test(value)) reject()
  return value.slice(0, 8) + text(value.slice(8).trim(), 64, true)
}
function cursorKey(value: unknown): string {
  scalarString(value)
  const normalized = normalizeOwnerSyncKey(value.startsWith('asset:') ? 'manual_asset' : 'watch', value)
  if (normalized !== value) reject()
  return value
}
function values(value: unknown, recordKind: OwnerSyncKind, base = false, complete = false): Record<string, OwnerSyncValue> {
  const row = object(value)
  const allowed = fieldsFor(recordKind)
  const keys = Object.keys(row)
  if (keys.length > 16 || keys.some(key => !allowed.includes(key) && !(base && ['kind', 'deleted'].includes(key)))
    || (complete && (keys.length !== allowed.length || allowed.some(key => !(key in row))))) reject()
  const out: Record<string, OwnerSyncValue> = {}
  for (const field of keys) {
    const item = row[field]
    if (field === 'kind') out[field] = kind(item)
    else if (field === 'deleted') { if (typeof item !== 'boolean') reject(); out[field] = item }
    else if (field === 'name') out[field] = item === null && base ? null : text(item, 200)
    else if (field === 'cls') {
      if (item === null && base) out[field] = null
      else { if (typeof item !== 'string' || !['现金', '权益', '商品'].includes(item)) reject(); out[field] = item }
    } else if (field === 'note') out[field] = item === null ? null : text(item, 2000, true)
    else out[field] = finance(item, base || field !== 'value', field === 'target_weight' ? 100 : Infinity)
  }
  if (complete && recordKind === 'watch' && out.shares !== null && out.shares !== 0) reject()
  return out
}
function validateRequest(input: unknown): OwnerSyncRequest {
  const row = closed(input, ['request_id', 'expected_revision', 'operations'])
  if (typeof row.request_id !== 'string' || !REQUEST_ID.test(row.request_id)) reject()
  const operations = list(row.operations, OWNER_SYNC_MAX_OPERATIONS, 1).map(value => {
    const item = closed(value, ['key', 'kind', 'deleted'], ['changes', 'base_values'])
    const recordKind = kind(item.kind)
    if (typeof item.deleted !== 'boolean') reject()
    return {
      key: normalizeOwnerSyncKey(recordKind, item.key), kind: recordKind, deleted: item.deleted,
      ...('changes' in item ? { changes: values(item.changes, recordKind) } : {}),
      ...('base_values' in item ? { base_values: values(item.base_values, recordKind, true) } : {}),
    }
  })
  if (new Set(operations.map(item => item.key)).size !== operations.length) reject()
  return frozen({ request_id: row.request_id, expected_revision: revision(row.expected_revision), operations })
}
export function validateOwnerSyncRequest(input: unknown): OwnerSyncRequest {
  try { return validateRequest(input) } catch { throw new OwnerSyncContractError('invalid_sync_request') }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    // Every object key comes from a closed ASCII field allowlist. No locale or
    // UTF-16/code-point key-order ambiguity enters the backend canonical hash.
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
function bytes(raw: unknown, maximum: number): Uint8Array {
  scalarString(raw)
  if (raw.length > maximum) reject()
  const encoded = new TextEncoder().encode(raw)
  if (encoded.byteLength > maximum) reject()
  return encoded
}
async function digest(encoded: Uint8Array): Promise<string> {
  try {
    const result = await globalThis.crypto.subtle.digest('SHA-256', encoded)
    return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('')
  } catch { throw new OwnerSyncContractError('sync_hash_unavailable') }
}
export function isOwnerSyncRequestHash(value: unknown): value is string { return typeof value === 'string' && HASH.test(value) }
export async function buildOwnerSyncRequest(input: unknown): Promise<BuiltOwnerSyncRequest> {
  const request = validateOwnerSyncRequest(input)
  const rawBody = canonical(request)
  let encoded: Uint8Array
  try { encoded = bytes(rawBody, OWNER_SYNC_MAX_BODY_BYTES) } catch { throw new OwnerSyncContractError('invalid_sync_request') }
  const requestHash = await digest(encoded)
  return frozen({ request, rawBody, requestHash, byteLength: encoded.byteLength })
}

/** Bounded complete JSON grammar, rejecting duplicate keys at every depth. */
function parse(raw: unknown, maximum: number): unknown {
  bytes(raw, maximum)
  const source = raw as string
  let index = 0, nodes = 0
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
  const whitespace = () => { while (index < source.length && /[ \t\r\n]/.test(source[index])) index++ }
  function string(): string {
    const start = index++
    while (index < source.length) {
      const char = source[index++]
      if (char === '"') {
        let decoded: unknown
        try { decoded = JSON.parse(source.slice(start, index)) } catch { reject() }
        scalarString(decoded)
        return decoded
      }
      if (char.charCodeAt(0) < 32) reject()
      if (char === '\\') {
        const escape = source[index++]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index, index + 4))) reject()
          index += 4
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) reject()
      }
    }
    return reject()
  }
  function value(depth: number): unknown {
    if (depth > OWNER_SYNC_MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) reject()
    whitespace()
    const char = source[index]
    if (char === '"') return string()
    if (char === '{') {
      index++; whitespace()
      const out: Record<string, unknown> = Object.create(null)
      if (source[index] === '}') { index++; return out }
      while (index < source.length) {
        if (source[index] !== '"') reject()
        const key = string()
        if (Object.prototype.hasOwnProperty.call(out, key)) reject()
        whitespace(); if (source[index++] !== ':') reject()
        out[key] = value(depth + 1)
        whitespace()
        const end = source[index++]
        if (end === '}') return out
        if (end !== ',') reject()
        whitespace()
      }
      return reject()
    }
    if (char === '[') {
      index++; whitespace()
      const out: unknown[] = []
      if (source[index] === ']') { index++; return out }
      while (index < source.length) {
        out.push(value(depth + 1)); whitespace()
        const end = source[index++]
        if (end === ']') return out
        if (end !== ',') reject()
      }
      return reject()
    }
    for (const [token, decoded] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, index)) { index += token.length; return decoded }
    }
    number.lastIndex = index
    const match = number.exec(source)
    if (!match) return reject()
    index = number.lastIndex
    const token = match[0], decoded = Number(token), integerToken = !/[.eE]/.test(token)
    if (!Number.isFinite(decoded) || (integerToken && !Number.isSafeInteger(decoded))) reject()
    return new JsonNumber(decoded, integerToken)
  }
  const result = value(1)
  whitespace(); if (index !== source.length) reject()
  return result
}
export async function restoreOwnerSyncRequest(rawBody: string, expectedHash: string): Promise<BuiltOwnerSyncRequest> {
  let request: OwnerSyncRequest, encoded: Uint8Array
  try {
    if (!isOwnerSyncRequestHash(expectedHash)) reject()
    encoded = bytes(rawBody, OWNER_SYNC_MAX_BODY_BYTES)
    request = validateRequest(parse(rawBody, OWNER_SYNC_MAX_BODY_BYTES))
    // Restore only the byte-exact spelling produced by this constructor. This
    // deliberately is not an arbitrary JSON import or 1.0 -> 1 normalization.
    if (canonical(request) !== rawBody) reject()
  } catch { throw new OwnerSyncContractError('invalid_sync_restore') }
  const requestHash = await digest(encoded)
  if (requestHash !== expectedHash) throw new OwnerSyncContractError('invalid_sync_restore')
  return frozen({ request, rawBody, requestHash, byteLength: encoded.byteLength })
}
function validateRecord(input: unknown, upperRevision = MAX_REVISION): OwnerSyncRecord {
  const upper = revision(upperRevision)
  const row = closed(input, ['key', 'kind', 'deleted', 'record_revision', 'lifecycle_revision', 'field_revisions', 'values'])
  const recordKind = kind(row.kind)
  const key = normalizeOwnerSyncKey(recordKind, row.key)
  if (row.key !== key || typeof row.deleted !== 'boolean') reject()
  const recordRevision = revision(row.record_revision, 1), lifecycle = revision(row.lifecycle_revision, 1)
  if (lifecycle > recordRevision || recordRevision > upper) reject()
  const stamps = closed(row.field_revisions, fieldsFor(recordKind))
  const fieldRevisions: Record<string, number> = {}
  for (const field of Object.keys(stamps)) {
    const stamp = revision(stamps[field], 1)
    if (stamp > recordRevision) reject()
    fieldRevisions[field] = stamp
  }
  return frozen({ key, kind: recordKind, deleted: row.deleted, record_revision: recordRevision,
    lifecycle_revision: lifecycle, field_revisions: fieldRevisions, values: values(row.values, recordKind, false, true) })
}
export function validateOwnerSyncRecord(input: unknown, upperRevision = MAX_REVISION): OwnerSyncRecord {
  try { return validateRecord(input, upperRevision) } catch { throw new OwnerSyncContractError() }
}
function writeResult(value: unknown): OwnerSyncWriteResult {
  const row = closed(value, ['revision', 'records'])
  const head = revision(row.revision)
  const records = list(row.records, OWNER_SYNC_MAX_OPERATIONS).map(record => validateOwnerSyncRecord(record, head))
  if (new Set(records.map(record => record.key)).size !== records.length) reject()
  return frozen({ revision: head, records })
}
const MESSAGES: Readonly<Record<string, string>> = {
  invalid_request: '同步请求无效。', sync_conflict: '同步冲突，请保留本地草稿并重新核对。',
  idempotency_conflict: '请求标识已用于不同的同步请求。', schema_unavailable: '同步存储结构不可用。',
  integrity_unavailable: '同步存储完整性验证失败。', storage_unavailable: '同步存储暂不可用。',
  capacity_exhausted: '同步存储容量已满，历史未被删除。', sync_result_unknown: '同步提交结果未知，请保留原请求标识并核对回执。',
}
function error(value: unknown): { code: string; message: string } {
  const row = closed(value, ['code', 'message'])
  if (typeof row.code !== 'string' || !Object.prototype.hasOwnProperty.call(MESSAGES, row.code) || row.message !== MESSAGES[row.code]) reject()
  return { code: row.code, message: MESSAGES[row.code] }
}
function conflict(value: unknown): OwnerSyncConflict {
  const row = closed(value, ['error', 'conflicts'])
  const problem = error(row.error)
  if (problem.code !== 'sync_conflict') reject()
  const conflicts = list(row.conflicts, OWNER_SYNC_MAX_OPERATIONS, 1).map(value => {
    const item = closed(value, ['key_digest', 'fields'])
    if (typeof item.key_digest !== 'string' || !/^[0-9a-f]{16}(?![\s\S])/.test(item.key_digest)) reject()
    const fields = list(item.fields, CONFLICT_FIELDS.length, 1)
    if (fields.some(field => typeof field !== 'string' || !(CONFLICT_FIELDS as readonly string[]).includes(field))
      || fields.some((field, index) => index > 0 && (fields[index - 1] as string) >= (field as string))) reject()
    return { key_digest: item.key_digest, fields: fields as string[] }
  })
  return frozen({ error: { code: 'sync_conflict', message: problem.message }, conflicts })
}
const DETAIL_CODES: Readonly<Record<number, readonly string[]>> = {
  400: ['invalid_sync_content_length', 'sync_body_incomplete'],
  401: ['Owner 会话无效或已过期，请重新登录'],
  403: ['sync_consent_required', 'Owner 会话无权执行此操作'],
  408: ['sync_body_timeout'], 413: ['sync_body_too_large'], 415: ['invalid_sync_content_type'],
  422: ['invalid_sync_request', 'invalid_sync_query', 'invalid_sync_request_id', 'invalid_sync_request_hash'],
  429: ['Owner 同步请求过于频繁'], 503: ['sync_result_unknown', 'sync_storage_unavailable'],
}
export function parseSyncWriteResponse(status: number, raw: string): OwnerSyncWriteResponse {
  const body = parse(raw, OWNER_SYNC_MAX_RESPONSE_BYTES)
  if (status === 200) return frozen({ kind: 'success', status: 200, result: writeResult(body) })
  if (status === 409) {
    const row = object(body)
    const problem = error(row.error)
    if (problem.code === 'sync_conflict') return frozen({ kind: 'conflict', status: 409, result: conflict(row) })
    if (problem.code !== 'idempotency_conflict') reject()
    closed(row, ['error'])
    return frozen({ kind: 'idempotency_conflict', status: 409, error: { code: 'idempotency_conflict', message: problem.message } })
  }
  const row = object(body)
  if ('detail' in row) {
    closed(row, ['detail'])
    if (typeof row.detail !== 'string' || !DETAIL_CODES[status]?.includes(row.detail)) reject()
    return frozen({ kind: 'failure', status, code: row.detail })
  }
  closed(row, ['error'])
  const problem = error(row.error)
  const allowed = status === 422 ? ['invalid_request'] : status === 503
    ? ['schema_unavailable', 'integrity_unavailable', 'storage_unavailable', 'capacity_exhausted', 'sync_result_unknown'] : []
  if (!allowed.includes(problem.code)) reject()
  return frozen({ kind: 'failure', status, code: problem.code })
}
export function parseSyncReceiptResponse(status: number, raw: string): OwnerSyncReceiptResponse {
  const body = parse(raw, OWNER_SYNC_MAX_RESPONSE_BYTES)
  if (status === 404 || status === 503) {
    const row = closed(body, ['state', 'error'])
    if (row.state !== 'unknown' || row.error !== 'sync_result_unknown') reject()
    return frozen({ state: 'unknown', status, error: 'sync_result_unknown' })
  }
  if (status !== 200) reject()
  const row = closed(body, ['state', 'status', 'result'])
  if (row.state !== 'matched') reject()
  const storedStatus = revision(row.status)
  if (storedStatus === 200) return frozen({ state: 'matched', status: 200, result: writeResult(row.result) })
  if (storedStatus === 409) return frozen({ state: 'matched', status: 409, result: conflict(row.result) })
  return reject()
}

/** SQLite BINARY compares valid Unicode keys in UTF-8 byte order, not locale/UTF-16 order. */
export function compareSyncKeys(first: string, second: string): number {
  const left = new TextEncoder().encode(cursorKey(first)), right = new TextEncoder().encode(cursorKey(second))
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}
function compareCursor(first: OwnerSyncCursor, second: OwnerSyncCursor): number {
  return first[0] === second[0] ? compareSyncKeys(first[1], second[1]) : first[0] < second[0] ? -1 : 1
}
function cursor(value: unknown): OwnerSyncCursor {
  const row = list(value, 2, 2)
  return frozen([revision(row[0], 1), cursorKey(row[1])] as const)
}
export function parseSyncChangesPage(raw: string, context: OwnerSyncPageContext): OwnerSyncChangesPage {
  const parameters = closed(context, ['sinceRevision'], ['upperRevision', 'cursor', 'limit'])
  const since = revision(parameters.sinceRevision)
  const upper = 'upperRevision' in parameters ? revision(parameters.upperRevision) : undefined
  const limit = 'limit' in parameters ? revision(parameters.limit, 1) : 100
  const after = 'cursor' in parameters ? cursor(parameters.cursor) : undefined
  if (limit > 200 || (upper !== undefined && upper < since)
    || (after && (upper === undefined || after[0] <= since || after[0] > upper))) reject()
  const row = closed(parse(raw, OWNER_SYNC_MAX_RESPONSE_BYTES), ['upper_revision', 'changes', 'next_cursor', 'complete'])
  const pinnedUpper = revision(row.upper_revision)
  if (pinnedUpper < since || (upper !== undefined && upper !== pinnedUpper) || typeof row.complete !== 'boolean') reject()
  const changes = list(row.changes, limit).map(record => validateOwnerSyncRecord(record, pinnedUpper))
  let previous = after
  for (const record of changes) {
    const point: OwnerSyncCursor = [record.record_revision, record.key]
    if (record.record_revision <= since || (previous && compareCursor(previous, point) >= 0)) reject()
    previous = point
  }
  const next = row.next_cursor === null ? null : cursor(row.next_cursor)
  if (row.complete ? next !== null : (!next || changes.length !== limit || !previous || compareCursor(previous, next) !== 0)) reject()
  if (!after && changes.length === 0 && pinnedUpper !== since) reject()
  return frozen({ upper_revision: pinnedUpper, changes, next_cursor: next, complete: row.complete })
}
