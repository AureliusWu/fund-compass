/** Complete physical-v6 file codec, not disaster restore, storage or migration.
 * The fixed core validates every old/new image and rechecks its original hashes.
 * A retained full-profile packet is verified by the real original-envelope
 * path; decoding or exporting it never grants permission to resend it.
 */
import { validateOwnerWorkspaceLocalState } from '@/stores/owner-workspace'
import type { OwnerWorkspaceLocalState } from '@/stores/owner-workspace-types'
import { canonicalOwnerLocal, OWNER_WORKSPACE_BACKUP_MAX_BYTES, buildOwnerLegacyWorkspaceBackup } from './owner-workspace-backup'
import { validateOwnerPortfolioSyncMetadata } from './owner-portfolio-sync'
import { verifyOwnerPortfolioSyncUpgradeIntent } from './owner-portfolio-sync-intent'
import { parseOwnerBusinessJson } from './owner-legacy-seed'

export const OWNER_FULL_SYNC_RECOVERY_FORMAT = 'sinan-owner-workspace-recovery-3' as const
export const OWNER_FULL_SYNC_RECOVERY_MAX_BYTES = OWNER_WORKSPACE_BACKUP_MAX_BYTES
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const encoder = new TextEncoder()
export interface OwnerFullSyncRecoveryBackup {
  readonly format: typeof OWNER_FULL_SYNC_RECOVERY_FORMAT
  readonly physicalVersion: 6
  readonly targetFingerprint: string
  readonly local: OwnerWorkspaceLocalState
}
export interface BuiltOwnerFullSyncRecoveryBackup {
  readonly envelope: OwnerFullSyncRecoveryBackup
  readonly raw: string
  readonly sha256: string
  readonly byteLength: number
}
export class OwnerFullSyncRecoveryError extends Error {
  constructor(readonly code: 'invalid_recovery' | 'hash_mismatch' | 'capacity_exceeded' | 'hash_unavailable') {
    super('Owner full sync recovery file rejected'); this.name = 'OwnerFullSyncRecoveryError'
  }
}
function fail(code: OwnerFullSyncRecoveryError['code'] = 'invalid_recovery'): never { throw new OwnerFullSyncRecoveryError(code) }
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
  if (raw.length > OWNER_FULL_SYNC_RECOVERY_MAX_BYTES || encoder.encode(raw).byteLength > OWNER_FULL_SYNC_RECOVERY_MAX_BYTES) fail('capacity_exceeded')
  return raw
}
async function sha(raw: string): Promise<string> {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)))].map(item => item.toString(16).padStart(2, '0')).join('') }
  catch { return fail('hash_unavailable') }
}
/** Descriptor copy before the first await. It does not replace real codecs. */
function safeCopy(input: unknown): unknown {
  let used = 0, nodes = 0
  const charge = (raw: string) => {
    used += encoder.encode(raw).byteLength
    if (used > OWNER_FULL_SYNC_RECOVERY_MAX_BYTES) fail('capacity_exceeded')
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
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.some(key => typeof key !== 'string')
      || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail()
    charge('{}' + ','.repeat(Math.max(keys.length - 1, 0)))
    return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, row]) => {
      charge(JSON.stringify(bounded(key)) + ':'); return [key, copy(row.value, depth + 1)]
    })))
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
function validationFailure(error: unknown): never {
  if (error instanceof OwnerFullSyncRecoveryError) throw error
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    if (descriptor && 'value' in descriptor) {
      if (['workspace_capacity', 'capacity_exceeded'].includes(descriptor.value)) fail('capacity_exceeded')
      if (['hash_unavailable', 'workspace_unavailable'].includes(descriptor.value)) fail('hash_unavailable')
    }
  } catch (problem) { if (problem instanceof OwnerFullSyncRecoveryError) throw problem }
  return fail()
}
export async function validateOwnerFullSyncRecoveryBackup(input: unknown): Promise<OwnerFullSyncRecoveryBackup> {
  const row = fields(safeCopy(input))
  if (row.format !== OWNER_FULL_SYNC_RECOVERY_FORMAT || row.physicalVersion !== 6
    || typeof row.targetFingerprint !== 'string' || !HASH.test(row.targetFingerprint)) fail()
  let local: OwnerWorkspaceLocalState
  try { local = await validateOwnerWorkspaceLocalState(row.targetFingerprint, row.local) }
  catch (error) { return validationFailure(error) }
  if (!local.sync || !local.portfolio || !local.portfolioUpgrade || !local.fullSync || !local.fullSyncUpgrade
    || !local.metadata.adoption || local.receiptCount !== 0 || local.sync.pending !== null) fail()
  try {
    // Real fixed new-profile codecs, never an injected metadata/hash validator.
    validateOwnerPortfolioSyncMetadata(local.fullSync, row.targetFingerprint,
      { snapshot: local.snapshot, metadata: local.metadata, outbox: local.outbox })
    await verifyOwnerPortfolioSyncUpgradeIntent(local.fullSyncUpgrade, row.targetFingerprint)
    const original = await buildOwnerLegacyWorkspaceBackup(local.metadata.adoption.sourceArchive)
    if (original.sha256 !== local.metadata.adoption.backupSha256) fail()
  } catch (error) { return validationFailure(error) }
  const envelope: OwnerFullSyncRecoveryBackup = Object.freeze({ format: OWNER_FULL_SYNC_RECOVERY_FORMAT,
    physicalVersion: 6, targetFingerprint: row.targetFingerprint, local })
  bounded(canonicalOwnerLocal(envelope))
  return envelope
}
export async function buildOwnerFullSyncRecoveryBackup(target: string, local: OwnerWorkspaceLocalState): Promise<BuiltOwnerFullSyncRecoveryBackup> {
  const envelope = await validateOwnerFullSyncRecoveryBackup({ format: OWNER_FULL_SYNC_RECOVERY_FORMAT,
    physicalVersion: 6, targetFingerprint: target, local })
  const raw = bounded(canonicalOwnerLocal(envelope))
  return Object.freeze({ envelope, raw, sha256: await sha(raw), byteLength: encoder.encode(raw).byteLength })
}
export async function restoreOwnerFullSyncRecoveryBackup(raw: unknown, expectedSha256: unknown): Promise<OwnerFullSyncRecoveryBackup> {
  const bytes = bounded(raw)
  if (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256)) fail()
  if (await sha(bytes) !== expectedSha256) fail('hash_mismatch')
  let input: unknown
  try { input = parseOwnerBusinessJson(bytes, OWNER_FULL_SYNC_RECOVERY_MAX_BYTES, 12) } catch { return fail() }
  const envelope = await validateOwnerFullSyncRecoveryBackup(input)
  if (canonicalOwnerLocal(envelope) !== bytes) fail()
  return envelope
}
