/** Fixed local upgrade receipt, not source authentication or cloud authority.
 * Shape checks are synchronous for existing IDB transactions; the asynchronous
 * hash recheck must finish before admission and is never claimed by the shape
 * validator alone. This module performs no storage, network or credential IO.
 */
import { canonicalOwnerLocal } from './owner-workspace-backup'

export interface OwnerPortfolioUpgradeIntent {
  readonly schema: 'owner-portfolio-upgrade-intent-1'
  readonly targetFingerprint: string
  readonly id: string
  readonly hash: string
  readonly backupSha256: string
  readonly sourceSha256: string
}
export class OwnerPortfolioUpgradeIntentError extends Error {
  constructor(readonly code: 'invalid_intent' | 'hash_mismatch' | 'hash_unavailable') {
    super('Owner portfolio upgrade intent rejected'); this.name = 'OwnerPortfolioUpgradeIntentError'
  }
}
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const FIELDS = ['schema', 'targetFingerprint', 'id', 'hash', 'backupSha256', 'sourceSha256'] as const
function fail(code: OwnerPortfolioUpgradeIntentError['code'] = 'invalid_intent'): never {
  throw new OwnerPortfolioUpgradeIntentError(code)
}
/** Does not calculate SHA or authenticate the caller. */
export function validateOwnerPortfolioUpgradeIntent(input: unknown, target: string,
  sourceSha256: string): OwnerPortfolioUpgradeIntent {
  if (typeof target !== 'string' || !HASH.test(target) || typeof sourceSha256 !== 'string' || !HASH.test(sourceSha256)
    || !input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(input).length !== FIELDS.length || FIELDS.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail()
  const row = Object.fromEntries(FIELDS.map(key => [key, descriptors[key].value]))
  if (row.schema !== 'owner-portfolio-upgrade-intent-1' || row.targetFingerprint !== target || row.sourceSha256 !== sourceSha256
    || typeof row.id !== 'string' || !ID.test(row.id) || typeof row.hash !== 'string' || !HASH.test(row.hash)
    || typeof row.backupSha256 !== 'string' || !HASH.test(row.backupSha256)) fail()
  return Object.freeze({ schema: 'owner-portfolio-upgrade-intent-1', targetFingerprint: target, id: row.id,
    hash: row.hash, backupSha256: row.backupSha256, sourceSha256 })
}
/** Rechecks this fixed request-hash formula only, not the external file bytes. */
export async function verifyOwnerPortfolioUpgradeIntent(input: unknown, target: string,
  sourceSha256: string): Promise<OwnerPortfolioUpgradeIntent> {
  const checked = validateOwnerPortfolioUpgradeIntent(input, target, sourceSha256)
  let hash: string
  try {
    const raw = canonicalOwnerLocal({ operation: 'portfolio-upgrade-1', target, id: checked.id, backupSha256: checked.backupSha256 })
    hash = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))]
      .map(value => value.toString(16).padStart(2, '0')).join('')
  } catch { return fail('hash_unavailable') }
  if (checked.hash !== hash) fail('hash_mismatch')
  return checked
}
