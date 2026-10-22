/** Strict local watch/holding backup only. Manual assets/history keep their independent stores. */
import { validateOwnerWorkspaceEntries, validateOwnerWorkspaceSnapshot, OWNER_WORKSPACE_MAX_IMAGE_BYTES,
  type OwnerWorkspaceEntry, type OwnerWorkspaceSnapshot } from './owner-cloud-import'
import { decodeOwnerLegacySeed, parseOwnerBusinessJson } from './owner-legacy-seed'
import { normalizeOwnerSyncKey } from './ownerSyncContract'

export const OWNER_WORKSPACE_BACKUP_FORMAT = 'sinan-owner-local-backup-1' as const
export const OWNER_WORKSPACE_MAX_ARCHIVES = 8
export const OWNER_WORKSPACE_BACKUP_MAX_BYTES = 12 * OWNER_WORKSPACE_MAX_IMAGE_BYTES
export interface OwnerWorkspaceSourceArchive {
  readonly sourceKey: 'sinan_watchlist_v1' | 'sinan_watchlist_v2' | null
  readonly v1Raw: string | null
  readonly v2Raw: string | null
}
export interface OwnerWorkspaceDisplayTime { readonly key: string; readonly updated_at: string | null }
export interface OwnerWorkspaceLocalReceipt {
  readonly id: string
  readonly hash: string
  readonly beforeLocalVersion: number
  readonly localVersion: number
  readonly outboxVersion: number
}
export interface OwnerWorkspaceAdoption {
  readonly id: string
  readonly hash: string
  readonly backupSha256: string
  readonly sourceArchive: OwnerWorkspaceSourceArchive
  readonly localVersion: number
}
export interface OwnerWorkspaceLocalMetadata {
  readonly schema: 'owner-workspace-local-1'
  readonly adoption: OwnerWorkspaceAdoption | null
  readonly displayTimes: readonly OwnerWorkspaceDisplayTime[]
  readonly recentEdit: OwnerWorkspaceLocalReceipt | null
  readonly restoredArchives: readonly OwnerWorkspaceSourceArchive[]
}
export interface OwnerWorkspaceBackup {
  readonly format: typeof OWNER_WORKSPACE_BACKUP_FORMAT
  readonly entries: readonly OwnerWorkspaceEntry[]
  readonly displayTimes: readonly OwnerWorkspaceDisplayTime[]
  readonly sourceArchive: OwnerWorkspaceSourceArchive
  readonly restoredArchives: readonly OwnerWorkspaceSourceArchive[]
  readonly entriesSha256: string
}
export interface BuiltOwnerWorkspaceBackup {
  readonly envelope: OwnerWorkspaceBackup
  readonly raw: string
  readonly sha256: string
  readonly byteLength: number
}
export class OwnerWorkspaceBackupError extends Error {
  constructor(readonly code: 'invalid_backup' | 'capacity_exceeded' | 'hash_mismatch' | 'hash_unavailable') {
    super('Owner local backup rejected'); this.name = 'OwnerWorkspaceBackupError'
  }
}
const HASH = /^[0-9a-f]{64}(?![\s\S])/, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const encoder = new TextEncoder()
function fail(code: OwnerWorkspaceBackupError['code'] = 'invalid_backup'): never { throw new OwnerWorkspaceBackupError(code) }
function scalar(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail()
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail()
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail()
  }
}
function bounded(value: unknown, maximum: number): string {
  scalar(value)
  if (value.length > maximum || encoder.encode(value).byteLength > maximum) fail('capacity_exceeded')
  return value
}
export function canonicalOwnerLocal(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalOwnerLocal).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonicalOwnerLocal(row[key])).join(',') + '}'
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) fail()
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, item]) => !('value' in item) || key !== 'length' && !item.enumerable)) fail()
  return value
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail()
  return value
}
function validTime(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$(?![\s\S])/.test(value)) return false
  const stamp = Date.parse(value)
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value.slice(0, 10)
}
export function validateOwnerWorkspaceSourceArchive(input: unknown): OwnerWorkspaceSourceArchive {
  const row = closed(input, ['sourceKey', 'v1Raw', 'v2Raw'])
  for (const name of ['v1Raw', 'v2Raw']) if (row[name] !== null) bounded(row[name], OWNER_WORKSPACE_MAX_IMAGE_BYTES)
  const selected = row.v2Raw !== null ? 'sinan_watchlist_v2' : row.v1Raw !== null ? 'sinan_watchlist_v1' : null
  if (row.sourceKey !== selected) fail()
  return frozen({ sourceKey: selected, v1Raw: row.v1Raw as string | null, v2Raw: row.v2Raw as string | null })
}
export function validateOwnerWorkspaceDisplayTimes(input: unknown, entries: readonly OwnerWorkspaceEntry[]): readonly OwnerWorkspaceDisplayTime[] {
  const rows = list(input, entries.length)
  if (rows.length !== entries.length) fail()
  const result = rows.map((value, index) => {
    const row = closed(value, ['key', 'updated_at'])
    if (row.key !== entries[index].key || !validTime(row.updated_at)) fail()
    return { key: entries[index].key, updated_at: row.updated_at }
  })
  return frozen(result)
}
function archiveList(input: unknown): readonly OwnerWorkspaceSourceArchive[] {
  const result = list(input, OWNER_WORKSPACE_MAX_ARCHIVES).map(validateOwnerWorkspaceSourceArchive)
  if (new Set(result.map(canonicalOwnerLocal)).size !== result.length) fail()
  return frozen(result)
}
export function validateOwnerWorkspaceLocalMetadata(input: unknown, snapshot: OwnerWorkspaceSnapshot): OwnerWorkspaceLocalMetadata {
  const row = closed(input, ['schema', 'adoption', 'displayTimes', 'recentEdit', 'restoredArchives'])
  if (row.schema !== 'owner-workspace-local-1') fail()
  let adoption: OwnerWorkspaceAdoption | null = null, recentEdit: OwnerWorkspaceLocalReceipt | null = null
  if (row.adoption !== null) {
    const value = closed(row.adoption, ['id', 'hash', 'backupSha256', 'sourceArchive', 'localVersion'])
    if (typeof value.id !== 'string' || !ID.test(value.id) || typeof value.hash !== 'string' || !HASH.test(value.hash)
      || typeof value.backupSha256 !== 'string' || !HASH.test(value.backupSha256)
      || counter(value.localVersion) < 1 || (value.localVersion as number) > snapshot.localVersion) fail()
    adoption = { id: value.id, hash: value.hash, backupSha256: value.backupSha256,
      sourceArchive: validateOwnerWorkspaceSourceArchive(value.sourceArchive), localVersion: value.localVersion as number }
  }
  if (row.recentEdit !== null) {
    const value = closed(row.recentEdit, ['id', 'hash', 'beforeLocalVersion', 'localVersion', 'outboxVersion'])
    if (typeof value.id !== 'string' || !ID.test(value.id) || typeof value.hash !== 'string' || !HASH.test(value.hash)
      || counter(value.beforeLocalVersion) === Number.MAX_SAFE_INTEGER
      || counter(value.localVersion) !== (value.beforeLocalVersion as number) + 1
      || (value.localVersion as number) > snapshot.localVersion || counter(value.outboxVersion) < 1) fail()
    recentEdit = { id: value.id, hash: value.hash, beforeLocalVersion: value.beforeLocalVersion as number,
      localVersion: value.localVersion as number, outboxVersion: value.outboxVersion as number }
  }
  const restoredArchives = archiveList(row.restoredArchives)
  if (adoption && restoredArchives.some(archive => canonicalOwnerLocal(archive) === canonicalOwnerLocal(adoption.sourceArchive))) fail()
  const displayTimes = validateOwnerWorkspaceDisplayTimes(row.displayTimes, snapshot.entries)
  if (adoption) {
    const selected = adoption.sourceArchive.sourceKey === null ? null : { sourceKey: adoption.sourceArchive.sourceKey,
      raw: adoption.sourceArchive.sourceKey === 'sinan_watchlist_v2' ? adoption.sourceArchive.v2Raw : adoption.sourceArchive.v1Raw }
    if (canonicalOwnerLocal(selected) !== canonicalOwnerLocal(snapshot.legacy)
      || (recentEdit ? recentEdit.localVersion !== snapshot.localVersion || recentEdit.beforeLocalVersion < adoption.localVersion
        : snapshot.localVersion !== adoption.localVersion)) fail()
  } else if (recentEdit || restoredArchives.length || displayTimes.some(row => row.updated_at !== null)) fail()
  const result: OwnerWorkspaceLocalMetadata = { schema: 'owner-workspace-local-1', adoption, displayTimes, recentEdit, restoredArchives }
  bounded(canonicalOwnerLocal(result), OWNER_WORKSPACE_BACKUP_MAX_BYTES)
  return frozen(result)
}
export function emptyOwnerWorkspaceLocalMetadata(snapshot: OwnerWorkspaceSnapshot): OwnerWorkspaceLocalMetadata {
  return frozen({ schema: 'owner-workspace-local-1', adoption: null, recentEdit: null,
    displayTimes: snapshot.entries.map(entry => ({ key: entry.key, updated_at: null })), restoredArchives: [] })
}
export function decodeOwnerWorkspaceSourceArchive(input: unknown): {
  readonly archive: OwnerWorkspaceSourceArchive; readonly entries: readonly OwnerWorkspaceEntry[]; readonly displayTimes: readonly OwnerWorkspaceDisplayTime[]
} {
  const archive = validateOwnerWorkspaceSourceArchive(input)
  if (archive.sourceKey === null) return frozen({ archive, entries: [], displayTimes: [] })
  const raw = archive.sourceKey === 'sinan_watchlist_v2' ? archive.v2Raw : archive.v1Raw
  const seed = decodeOwnerLegacySeed({ sourceKey: archive.sourceKey, raw })
  // decode above owns strict duplicate-key/number/kind/name validation. Parse
  // the same already validated bytes only to preserve their actual timestamps.
  const parsed = JSON.parse(raw!) as { code: string; account?: string; updated_at: string }[]
  const times = new Map(parsed.map(row => [normalizeOwnerSyncKey('watch', row.code + '::' + (row.account?.trim() ?? '')), row.updated_at]))
  return frozen({ archive, entries: seed.entries,
    displayTimes: seed.entries.map(entry => ({ key: entry.key, updated_at: times.get(entry.key)! })) })
}
async function digest(raw: string): Promise<string> {
  try {
    const value = await crypto.subtle.digest('SHA-256', encoder.encode(raw))
    return [...new Uint8Array(value)].map(part => part.toString(16).padStart(2, '0')).join('')
  } catch { return fail('hash_unavailable') }
}
function backupShape(input: unknown): OwnerWorkspaceBackup {
  const row = closed(input, ['format', 'entries', 'displayTimes', 'sourceArchive', 'restoredArchives', 'entriesSha256'])
  if (row.format !== OWNER_WORKSPACE_BACKUP_FORMAT || typeof row.entriesSha256 !== 'string' || !HASH.test(row.entriesSha256)) fail()
  let entries: readonly OwnerWorkspaceEntry[]
  try { entries = validateOwnerWorkspaceEntries(row.entries) } catch { return fail() }
  const sourceArchive = validateOwnerWorkspaceSourceArchive(row.sourceArchive), restoredArchives = archiveList(row.restoredArchives)
  if (restoredArchives.some(archive => canonicalOwnerLocal(archive) === canonicalOwnerLocal(sourceArchive))) fail()
  return frozen({ format: OWNER_WORKSPACE_BACKUP_FORMAT, entries,
    displayTimes: validateOwnerWorkspaceDisplayTimes(row.displayTimes, entries), sourceArchive, restoredArchives, entriesSha256: row.entriesSha256 })
}
export async function validateOwnerWorkspaceBackup(input: unknown): Promise<OwnerWorkspaceBackup> {
  const copy = backupShape(input)
  bounded(canonicalOwnerLocal(copy), OWNER_WORKSPACE_BACKUP_MAX_BYTES)
  if (await digest(canonicalOwnerLocal({ entries: copy.entries, displayTimes: copy.displayTimes,
    sourceArchive: copy.sourceArchive, restoredArchives: copy.restoredArchives })) !== copy.entriesSha256) fail('hash_mismatch')
  return copy
}
async function build(entries: readonly OwnerWorkspaceEntry[], displayTimes: readonly OwnerWorkspaceDisplayTime[],
  sourceArchive: OwnerWorkspaceSourceArchive, restoredArchives: readonly OwnerWorkspaceSourceArchive[]): Promise<BuiltOwnerWorkspaceBackup> {
  const envelope = await validateOwnerWorkspaceBackup({ format: OWNER_WORKSPACE_BACKUP_FORMAT, entries, displayTimes, sourceArchive, restoredArchives,
    entriesSha256: await digest(canonicalOwnerLocal({ entries, displayTimes, sourceArchive, restoredArchives })) })
  const raw = bounded(canonicalOwnerLocal(envelope), OWNER_WORKSPACE_BACKUP_MAX_BYTES)
  return frozen({ envelope, raw, sha256: await digest(raw), byteLength: encoder.encode(raw).byteLength })
}
export async function buildOwnerLegacyWorkspaceBackup(archive: unknown): Promise<BuiltOwnerWorkspaceBackup> {
  const decoded = decodeOwnerWorkspaceSourceArchive(archive)
  return build(decoded.entries, decoded.displayTimes, decoded.archive, [])
}
export async function buildOwnerWorkspaceBackup(state: { readonly snapshot: OwnerWorkspaceSnapshot; readonly metadata: OwnerWorkspaceLocalMetadata }): Promise<BuiltOwnerWorkspaceBackup> {
  const snapshot = validateOwnerWorkspaceSnapshot(state.snapshot), metadata = validateOwnerWorkspaceLocalMetadata(state.metadata, snapshot)
  if (!metadata.adoption) return Promise.reject(new OwnerWorkspaceBackupError('invalid_backup'))
  return build(snapshot.entries, metadata.displayTimes, metadata.adoption.sourceArchive, metadata.restoredArchives)
}
export async function restoreOwnerWorkspaceBackup(raw: unknown, expectedSha256: unknown): Promise<OwnerWorkspaceBackup> {
  const bytes = bounded(raw, OWNER_WORKSPACE_BACKUP_MAX_BYTES)
  if (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256)) fail()
  if (await digest(bytes) !== expectedSha256) fail('hash_mismatch')
  let parsed: unknown
  try { parsed = parseOwnerBusinessJson(bytes, OWNER_WORKSPACE_BACKUP_MAX_BYTES, 9) } catch { return fail() }
  const envelope = await validateOwnerWorkspaceBackup(parsed)
  if (canonicalOwnerLocal(envelope) !== bytes) fail()
  return envelope
}
export interface OwnerWorkspaceRestorePreview {
  readonly rows: readonly { readonly key: string; readonly action: 'add' | 'noop' | 'conflict';
    readonly before: OwnerWorkspaceEntry | null; readonly after: OwnerWorkspaceEntry }[]
  readonly added: number; readonly noops: number; readonly conflicts: number; readonly canApply: boolean
}
/** Pure full preview. Timestamp differences are conflicts too; no current tombstone can be revived. */
export function previewOwnerWorkspaceRestore(state: { readonly snapshot: OwnerWorkspaceSnapshot; readonly metadata: OwnerWorkspaceLocalMetadata }, backup: OwnerWorkspaceBackup): OwnerWorkspaceRestorePreview {
  const entries = validateOwnerWorkspaceEntries(state.snapshot.entries), metadata = validateOwnerWorkspaceLocalMetadata(state.metadata, state.snapshot)
  const copy = backupShape(backup), local = new Map(entries.map(row => [row.key, row])), times = new Map(metadata.displayTimes.map(row => [row.key, row.updated_at]))
  const incomingTimes = new Map(copy.displayTimes.map(row => [row.key, row.updated_at]))
  const rows = copy.entries.map(after => {
    const before = local.get(after.key) ?? null
    const action = before === null ? 'add' : canonicalOwnerLocal(before) === canonicalOwnerLocal(after)
      && times.get(after.key) === incomingTimes.get(after.key) ? 'noop' : 'conflict'
    return { key: after.key, action, before, after } as const
  })
  const added = rows.filter(row => row.action === 'add').length, noops = rows.filter(row => row.action === 'noop').length,
    conflicts = rows.filter(row => row.action === 'conflict').length
  return frozen({ rows, added, noops, conflicts, canApply: conflicts === 0 && added > 0 })
}
