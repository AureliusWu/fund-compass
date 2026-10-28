/** Complete physical-v5 export/decoder, not a database restore or migration.
 * No ambient storage/network/credentials. A matching SHA is not authentication,
 * a cloud acknowledgement or permission to overwrite another workspace. */
import { validateOwnerWorkspaceLocalState } from '@/stores/owner-workspace'
import type { OwnerWorkspaceLocalState } from '@/stores/owner-workspace-types'
import { canonicalOwnerLocal, OWNER_WORKSPACE_BACKUP_MAX_BYTES, buildOwnerLegacyWorkspaceBackup } from './owner-workspace-backup'
import { parseOwnerBusinessJson } from './owner-legacy-seed'

export const OWNER_PORTFOLIO_RECOVERY_FORMAT = 'sinan-owner-workspace-recovery-2' as const
export const OWNER_PORTFOLIO_RECOVERY_MAX_BYTES = OWNER_WORKSPACE_BACKUP_MAX_BYTES
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const encoder = new TextEncoder()
export interface OwnerPortfolioRecoveryBackup {
  readonly format: typeof OWNER_PORTFOLIO_RECOVERY_FORMAT
  readonly physicalVersion: 5
  readonly targetFingerprint: string
  readonly local: OwnerWorkspaceLocalState
}
export interface BuiltOwnerPortfolioRecoveryBackup {
  readonly envelope: OwnerPortfolioRecoveryBackup
  readonly raw: string
  readonly sha256: string
  readonly byteLength: number
}
export class OwnerPortfolioRecoveryError extends Error {
  constructor(readonly code: 'invalid_recovery' | 'hash_mismatch' | 'capacity_exceeded' | 'hash_unavailable') {
    super('Owner portfolio recovery file rejected'); this.name = 'OwnerPortfolioRecoveryError'
  }
}
function fail(code: OwnerPortfolioRecoveryError['code'] = 'invalid_recovery'): never { throw new OwnerPortfolioRecoveryError(code) }
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
function bounded(value: unknown): string {
  const raw = scalar(value)
  if (raw.length > OWNER_PORTFOLIO_RECOVERY_MAX_BYTES || encoder.encode(raw).byteLength > OWNER_PORTFOLIO_RECOVERY_MAX_BYTES) fail('capacity_exceeded')
  return raw
}
async function sha(raw: string): Promise<string> {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)))].map(item => item.toString(16).padStart(2, '0')).join('') }
  catch { return fail('hash_unavailable') }
}
/** Own the immutable input before the first await. This is not a business codec
 * or an alternative JSON parser: the real shared grammar/state validators follow.
 * Inspect descriptors before reading any child, so accessors are never invoked. */
function safeCopy(input: unknown): unknown {
  let used = 0, nodes = 0
  const charge = (raw: string) => {
    used += encoder.encode(raw).byteLength
    if (used > OWNER_PORTFOLIO_RECOVERY_MAX_BYTES) fail('capacity_exceeded')
  }
  function copy(value: unknown, depth: number): unknown {
    if (depth > 12 || ++nodes > 3_200_128) fail('capacity_exceeded')
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) fail()
      charge(canonicalOwnerLocal(value)); return value
    }
    if (typeof value === 'string') { charge(JSON.stringify(bounded(value))); return value }
    if (!value || typeof value !== 'object') fail()
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100_000 || keys.length !== value.length + 1
        || Object.keys(value).some((key, index) => key !== String(index))
        || Object.entries(descriptors).some(([key, row]) => !('value' in row) || key !== 'length' && !row.enumerable)) fail()
      charge('[]' + ','.repeat(Math.max(value.length - 1, 0)))
      return Object.freeze(Array.from({ length: value.length }, (_, index) => copy(descriptors[String(index)].value, depth + 1)))
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || keys.some(key => typeof key !== 'string') || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail()
    charge('{}' + ','.repeat(Math.max(keys.length - 1, 0)))
    const pairs = Object.entries(descriptors).map(([key, row]) => {
      charge(JSON.stringify(bounded(key)) + ':')
      return [key, copy(row.value, depth + 1)] as const
    })
    return Object.freeze(Object.fromEntries(pairs))
  }
  return copy(input, 1)
}
function fields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail()
  const keys = ['format', 'physicalVersion', 'targetFingerprint', 'local'], descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail()
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
export async function validateOwnerPortfolioRecoveryBackup(input: unknown): Promise<OwnerPortfolioRecoveryBackup> {
  const row = fields(safeCopy(input))
  if (row.format !== OWNER_PORTFOLIO_RECOVERY_FORMAT || row.physicalVersion !== 5
    || typeof row.targetFingerprint !== 'string' || !HASH.test(row.targetFingerprint)) fail()
  let local: OwnerWorkspaceLocalState
  try { local = await validateOwnerWorkspaceLocalState(row.targetFingerprint, row.local) } catch { return fail() }
  if (local.fullSync || local.fullSyncUpgrade || !local.sync || !local.portfolio || !local.portfolioUpgrade || !local.metadata.adoption || local.receiptCount !== 0
    || local.outbox.entry !== null || local.sync.pending !== null) fail()
  const original = await buildOwnerLegacyWorkspaceBackup(local.metadata.adoption.sourceArchive)
  if (original.sha256 !== local.metadata.adoption.backupSha256) fail()
  const envelope: OwnerPortfolioRecoveryBackup = Object.freeze({ format: OWNER_PORTFOLIO_RECOVERY_FORMAT,
    physicalVersion: 5, targetFingerprint: row.targetFingerprint, local })
  bounded(canonicalOwnerLocal(envelope))
  return envelope
}
export async function buildOwnerPortfolioRecoveryBackup(target: string, local: OwnerWorkspaceLocalState): Promise<BuiltOwnerPortfolioRecoveryBackup> {
  const envelope = await validateOwnerPortfolioRecoveryBackup({ format: OWNER_PORTFOLIO_RECOVERY_FORMAT,
    physicalVersion: 5, targetFingerprint: target, local })
  const raw = bounded(canonicalOwnerLocal(envelope))
  return Object.freeze({ envelope, raw, sha256: await sha(raw), byteLength: encoder.encode(raw).byteLength })
}
export async function restoreOwnerPortfolioRecoveryBackup(raw: unknown, expectedSha256: unknown): Promise<OwnerPortfolioRecoveryBackup> {
  const bytes = bounded(raw)
  if (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256)) fail()
  if (await sha(bytes) !== expectedSha256) fail('hash_mismatch')
  let input: unknown
  try { input = parseOwnerBusinessJson(bytes, OWNER_PORTFOLIO_RECOVERY_MAX_BYTES, 12) } catch { return fail() }
  const envelope = await validateOwnerPortfolioRecoveryBackup(input)
  if (canonicalOwnerLocal(envelope) !== bytes) fail()
  return envelope
}
