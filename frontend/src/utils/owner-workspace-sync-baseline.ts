/** Complete closed cloud base only. No planner, link, storage or IO. */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import { OWNER_WORKSPACE_MAX_ENTRIES, OwnerCloudImportError } from './owner-cloud-import'
import { validateOwnerSyncRecord, OWNER_SYNC_MAX_RESPONSE_BYTES, type OwnerSyncRecord } from './ownerSyncContract'
import { OwnerWorkspaceSyncError } from './owner-workspace-sync-errors'
const encoder = new TextEncoder()
function fail(code: OwnerWorkspaceSyncError['code']): never { throw new OwnerWorkspaceSyncError(code) }
function capacityError(error: unknown): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return (error instanceof OwnerWorkspaceSyncError || error instanceof OwnerCloudImportError)
      && !!descriptor && 'value' in descriptor && descriptor.value === 'capacity_exceeded'
  } catch { return false }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_baseline')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) fail('invalid_baseline')
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
function rows(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('invalid_baseline')
  if (value.length > OWNER_WORKSPACE_MAX_ENTRIES) fail('capacity_exceeded')
  if (Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) =>
      !('value' in descriptor) || key !== 'length' && !descriptor.enumerable)) fail('invalid_baseline')
  return value
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
// Only copied/validated closed shallow DTOs enter this function. Keep signed
// zero in the image/size calculation; do not normalize the caller's L or B.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}

/** Preserve every current cloud record, including manual assets/tombstones.
 * max(record_revision) == head rejects obvious incomplete input, not a forged
 * complete-looking subset. Only the guarded full pull can establish provenance.
 */
export function validateOwnerWorkspaceCloudBaseline(input: unknown): OwnerSyncBaseline {
  try {
    const row = closed(input, ['pulledRevision', 'records'])
    const upper = row.pulledRevision
    if (typeof upper !== 'number' || !Number.isSafeInteger(upper) || upper < 0 || Object.is(upper, -0)) fail('invalid_baseline')
    const records: OwnerSyncRecord[] = [], seen = new Set<string>()
    let maximum = 0
    let bytes = encoder.encode(canonical({ pulledRevision: upper, records: [] })).byteLength
    for (const source of rows(row.records)) {
      let record: OwnerSyncRecord
      try { record = validateOwnerSyncRecord(source, upper) } catch { return fail('invalid_baseline') }
      if (seen.has(record.key)) fail('invalid_baseline')
      seen.add(record.key)
      maximum = Math.max(maximum, record.record_revision)
      bytes += encoder.encode(canonical(record)).byteLength + (records.length ? 1 : 0)
      if (bytes > OWNER_SYNC_MAX_RESPONSE_BYTES) fail('capacity_exceeded')
      records.push(record)
    }
    if (maximum !== upper) fail('invalid_baseline')
    return freeze({ pulledRevision: upper, records })
  } catch (error) {
    return fail(capacityError(error) ? 'capacity_exceeded' : 'invalid_baseline')
  }
}
