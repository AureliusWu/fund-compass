/** Explicit complete adopted-workspace image, distinct from additive row backups.
 * This codec never opens storage, reads credentials, sends requests, or restores
 * a database. A valid file alone is not permission to overwrite newer state. */
import { validateOwnerWorkspaceLocalState } from '@/stores/owner-workspace'
import type { OwnerWorkspaceLocalState } from '@/stores/owner-workspace-types'
import { canonicalOwnerLocal, OWNER_WORKSPACE_BACKUP_MAX_BYTES, buildOwnerLegacyWorkspaceBackup } from './owner-workspace-backup'
import { parseOwnerBusinessJson } from './owner-legacy-seed'

export const OWNER_WORKSPACE_RECOVERY_FORMAT = 'sinan-owner-workspace-recovery-1' as const
export const OWNER_WORKSPACE_RECOVERY_MAX_BYTES = OWNER_WORKSPACE_BACKUP_MAX_BYTES
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const encoder = new TextEncoder()
export interface OwnerWorkspaceRecoveryBackup {
  readonly format: typeof OWNER_WORKSPACE_RECOVERY_FORMAT
  readonly physicalVersion: 3 | 4
  readonly targetFingerprint: string
  readonly local: OwnerWorkspaceLocalState
}
export interface BuiltOwnerWorkspaceRecoveryBackup {
  readonly envelope: OwnerWorkspaceRecoveryBackup
  readonly raw: string
  readonly sha256: string
  readonly byteLength: number
}
export class OwnerWorkspaceRecoveryError extends Error {
  constructor(readonly code: 'invalid_recovery' | 'hash_mismatch' | 'capacity_exceeded' | 'hash_unavailable') {
    super('Owner workspace recovery file rejected'); this.name = 'OwnerWorkspaceRecoveryError'
  }
}
function fail(code: OwnerWorkspaceRecoveryError['code'] = 'invalid_recovery'): never { throw new OwnerWorkspaceRecoveryError(code) }
function bounded(raw: unknown): string {
  if (typeof raw !== 'string') fail()
  if (raw.length > OWNER_WORKSPACE_RECOVERY_MAX_BYTES || encoder.encode(raw).byteLength > OWNER_WORKSPACE_RECOVERY_MAX_BYTES) fail('capacity_exceeded')
  // TextEncoder replaces invalid Unicode. Reject it before any byte hash.
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = raw.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail()
    } else if (c >= 0xdc00 && c <= 0xdfff) fail()
  }
  return raw
}
async function sha(raw: string): Promise<string> {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)))].map(n => n.toString(16).padStart(2, '0')).join('') }
  catch { return fail('hash_unavailable') }
}
function fields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail()
  const keys = ['format', 'physicalVersion', 'targetFingerprint', 'local'], descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail()
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
export async function validateOwnerWorkspaceRecoveryBackup(input: unknown): Promise<OwnerWorkspaceRecoveryBackup> {
  const row = fields(input)
  if (row.format !== OWNER_WORKSPACE_RECOVERY_FORMAT || typeof row.targetFingerprint !== 'string' || !HASH.test(row.targetFingerprint)
    || row.physicalVersion !== 3 && row.physicalVersion !== 4) fail()
  let local: OwnerWorkspaceLocalState
  try { local = await validateOwnerWorkspaceLocalState(row.targetFingerprint, row.local) } catch { return fail() }
  // All application adoptions start with zero legacy import receipts and never
  // add them. Refuse unsupported history instead of exporting only its count.
  if (local.portfolio || local.portfolioUpgrade || !local.metadata.adoption || local.receiptCount !== 0 || (local.sync ? 4 : 3) !== row.physicalVersion
    || row.physicalVersion === 3 && local.outbox.entry !== null) fail()
  const original = await buildOwnerLegacyWorkspaceBackup(local.metadata.adoption.sourceArchive)
  if (original.sha256 !== local.metadata.adoption.backupSha256) fail()
  const envelope = Object.freeze({ format: OWNER_WORKSPACE_RECOVERY_FORMAT, physicalVersion: row.physicalVersion,
    targetFingerprint: row.targetFingerprint, local })
  bounded(canonicalOwnerLocal(envelope))
  return envelope
}
export async function buildOwnerWorkspaceRecoveryBackup(target: string, local: OwnerWorkspaceLocalState): Promise<BuiltOwnerWorkspaceRecoveryBackup> {
  const envelope = await validateOwnerWorkspaceRecoveryBackup({ format: OWNER_WORKSPACE_RECOVERY_FORMAT,
    physicalVersion: local && Object.prototype.hasOwnProperty.call(local, 'sync') ? 4 : 3, targetFingerprint: target, local })
  const raw = bounded(canonicalOwnerLocal(envelope))
  return Object.freeze({ envelope, raw, sha256: await sha(raw), byteLength: encoder.encode(raw).byteLength })
}
export async function restoreOwnerWorkspaceRecoveryBackup(raw: unknown, expectedSha256: unknown): Promise<OwnerWorkspaceRecoveryBackup> {
  const bytes = bounded(raw)
  if (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256)) fail()
  if (await sha(bytes) !== expectedSha256) fail('hash_mismatch')
  let input: unknown
  try { input = parseOwnerBusinessJson(bytes, OWNER_WORKSPACE_RECOVERY_MAX_BYTES, 12) } catch { return fail() }
  const envelope = await validateOwnerWorkspaceRecoveryBackup(input)
  if (canonicalOwnerLocal(envelope) !== bytes) fail()
  return envelope
}
