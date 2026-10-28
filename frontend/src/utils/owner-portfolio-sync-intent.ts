/** Fixed v6 full-profile upgrade intent. Synchronous shape checks never certify
 * its hash; verify must finish outside a transaction and always recomputes SHA.
 * No storage, credentials, network, source authentication or cloud authority.
 */
import { canonicalOwnerLocal } from './owner-workspace-backup'

export interface OwnerPortfolioSyncUpgradeIntent {
  readonly schema: 'owner-portfolio-sync-upgrade-1'
  readonly targetFingerprint: string
  readonly id: string
  readonly hash: string
  readonly backupSha256: string
}
export class OwnerPortfolioSyncUpgradeIntentError extends Error {
  constructor(readonly code: 'invalid_intent' | 'hash_mismatch' | 'hash_unavailable') {
    super('Owner portfolio sync upgrade intent rejected'); this.name = 'OwnerPortfolioSyncUpgradeIntentError'
  }
}
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const FIELDS = ['schema', 'targetFingerprint', 'id', 'hash', 'backupSha256'] as const
function fail(code: OwnerPortfolioSyncUpgradeIntentError['code'] = 'invalid_intent'): never {
  throw new OwnerPortfolioSyncUpgradeIntentError(code)
}
/** Closed independent copy only; it does not calculate or authenticate SHA. */
export function validateOwnerPortfolioSyncUpgradeIntent(input: unknown, target: string): OwnerPortfolioSyncUpgradeIntent {
  if (typeof target !== 'string' || !HASH.test(target) || !input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail()
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(input)
  if (actual.length !== FIELDS.length || actual.some(key => typeof key !== 'string' || !FIELDS.includes(key as typeof FIELDS[number]))
    || FIELDS.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) fail()
  const row = Object.fromEntries(FIELDS.map(key => [key, descriptors[key].value]))
  if (row.schema !== 'owner-portfolio-sync-upgrade-1' || row.targetFingerprint !== target
    || typeof row.id !== 'string' || !ID.test(row.id) || typeof row.hash !== 'string' || !HASH.test(row.hash)
    || typeof row.backupSha256 !== 'string' || !HASH.test(row.backupSha256)) fail()
  return Object.freeze({ schema: 'owner-portfolio-sync-upgrade-1', targetFingerprint: target,
    id: row.id, hash: row.hash, backupSha256: row.backupSha256 })
}
/** Checks the fixed request formula, not the original external backup bytes.
 * No success/identity cache: even a previously verified frozen object takes a
 * fresh SHA-256 pass and can fail if crypto is unavailable on this invocation.
 */
export async function verifyOwnerPortfolioSyncUpgradeIntent(input: unknown, target: string): Promise<OwnerPortfolioSyncUpgradeIntent> {
  const checked = validateOwnerPortfolioSyncUpgradeIntent(input, target)
  let hash: string
  try {
    const raw = canonicalOwnerLocal({ operation: 'portfolio-sync-upgrade-1', target, id: checked.id, backupSha256: checked.backupSha256 })
    hash = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))]
      .map(value => value.toString(16).padStart(2, '0')).join('')
  } catch { return fail('hash_unavailable') }
  if (checked.hash !== hash) fail('hash_mismatch')
  return checked
}
