/** Own an untrusted complete operation before the first asynchronous boundary.
 * Only native descriptors are copied; this is not a business/schema validator.
 * The bound is shared with complete recovery, never a truncation allowance. */
import { OWNER_WORKSPACE_BACKUP_MAX_BYTES, canonicalOwnerLocal } from './owner-workspace-backup'
const encoder = new TextEncoder()
export class OwnerFullSyncInputError extends Error {
  constructor(readonly code: 'invalid_input' | 'capacity_exceeded') { super('Owner full sync input rejected'); this.name = 'OwnerFullSyncInputError' }
}
export function copyOwnerFullSyncInput(input: unknown): unknown {
  let bytes = 0, nodes = 0
  const charge = (raw: string) => {
    bytes += encoder.encode(raw).byteLength
    if (bytes > OWNER_WORKSPACE_BACKUP_MAX_BYTES) throw new OwnerFullSyncInputError('capacity_exceeded')
  }
  function scalar(raw: string): string {
    if (raw.length > OWNER_WORKSPACE_BACKUP_MAX_BYTES) throw new OwnerFullSyncInputError('capacity_exceeded')
    for (let at = 0; at < raw.length; at++) {
      const unit = raw.charCodeAt(at)
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = raw.charCodeAt(++at)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new OwnerFullSyncInputError('invalid_input')
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new OwnerFullSyncInputError('invalid_input')
    }
    return raw
  }
  function own(value: unknown, depth: number): unknown {
    if (depth > 12 || ++nodes > 3_200_128) throw new OwnerFullSyncInputError('capacity_exceeded')
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new OwnerFullSyncInputError('invalid_input')
      charge(canonicalOwnerLocal(value)); return value
    }
    if (typeof value === 'string') { charge(JSON.stringify(scalar(value))); return value }
    if (!value || typeof value !== 'object') throw new OwnerFullSyncInputError('invalid_input')
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100_000 || keys.length !== value.length + 1
        || Object.keys(value).some((key, index) => key !== String(index))
        || Object.entries(descriptors).some(([key, row]) => !('value' in row) || key !== 'length' && !row.enumerable)) throw new OwnerFullSyncInputError('invalid_input')
      charge('[]' + ','.repeat(Math.max(value.length - 1, 0)))
      return Object.freeze(Array.from({ length: value.length }, (_, index) => own(descriptors[String(index)].value, depth + 1)))
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || keys.some(key => typeof key !== 'string')
      || Object.values(descriptors).some(row => !row.enumerable || !('value' in row))) throw new OwnerFullSyncInputError('invalid_input')
    charge('{}' + ','.repeat(Math.max(keys.length - 1, 0)))
    return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, row]) => {
      charge(JSON.stringify(scalar(key)) + ':'); return [key, own(row.value, depth + 1)]
    })))
  }
  return own(input, 1)
}
