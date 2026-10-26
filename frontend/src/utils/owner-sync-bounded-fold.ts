/** Pure bounded reconstruction of an ordered Owner change log. A complete
 * parsed page is not source authentication, nor permission to send or ACK. */
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import { OWNER_WORKSPACE_MAX_ENTRIES } from './owner-cloud-import'
import {
  OwnerSyncContractError, OWNER_SYNC_MAX_RESPONSE_BYTES, parseSyncChangesPage,
  type OwnerSyncChangesPage, type OwnerSyncCursor, type OwnerSyncPageContext, type OwnerSyncRecord,
} from './ownerSyncContract'
import { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'

export const OWNER_SYNC_MAX_CUMULATIVE_PAGE_BYTES = 4 * 1024 * 1024
export const OWNER_SYNC_MAX_HISTORY_RECORDS = OWNER_WORKSPACE_MAX_ENTRIES
export type OwnerSyncFoldCapacityIssue = 'cumulative_bytes' | 'history_count' | 'retained_bytes'
export interface OwnerSyncFoldPage {
  /** Even a capacity-rejected page is strictly parsed. Its upper may raise an
   * observed floor, but none of its partial records establish a complete base. */
  readonly page: OwnerSyncChangesPage
  readonly capacityIssue: OwnerSyncFoldCapacityIssue | null
  readonly baselineIssue: 'invalid_baseline' | null
  readonly completedBaseline: OwnerSyncBaseline | null
}
export interface OwnerSyncBoundedFold {
  accumulateOwnerSyncPage(rawBody: string, parameters: OwnerSyncPageContext): OwnerSyncFoldPage
  getCompletedBaseline(): OwnerSyncBaseline | null
}

const encoder = new TextEncoder()
// Only real-parser/real-baseline-codec copied, closed DTOs enter this helper.
// Match the complete baseline's canonical size, including signed financial 0.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}
function byteLength(value: unknown): number { return encoder.encode(canonical(value)).byteLength }
function reject(): never { throw new OwnerSyncContractError('invalid_sync_contract') }
function sameCursor(first: OwnerSyncCursor | undefined, second: OwnerSyncCursor | undefined): boolean {
  return first === undefined ? second === undefined : second !== undefined && first[0] === second[0] && first[1] === second[1]
}

/** Optional seed preserves the original incremental-pull contract. It must be
 * a real complete baseline; without one, the only accepted since is zero.
 * Construction performs no network, storage, crypto, clock or other IO. */
export function createOwnerSyncBoundedFold(seed?: OwnerSyncBaseline): OwnerSyncBoundedFold {
  let initial: OwnerSyncBaseline | null = null
  if (seed !== undefined) {
    try { initial = validateOwnerWorkspaceCloudBaseline(seed) } catch { return reject() }
  }
  // Map insertion order deliberately matches the existing readers. Replacing
  // history for a key does not delete/reinsert it or reorder the whole image.
  const records = new Map<string, { readonly record: OwnerSyncRecord; readonly bytes: number }>()
  let recordBytes = 0
  for (const record of initial?.records ?? []) {
    const bytes = byteLength(record)
    records.set(record.key, { record, bytes }); recordBytes += bytes
  }
  const since = initial?.pulledRevision ?? 0
  let upper: number | undefined, after: OwnerSyncCursor | undefined, limit: number | undefined
  let cumulativeBytes = 0, historyCount = 0, closed = false
  let completed: OwnerSyncBaseline | null = null
  function stop(): void { closed = true; completed = null; records.clear(); recordBytes = 0 }
  function result(page: OwnerSyncChangesPage, capacityIssue: OwnerSyncFoldCapacityIssue | null = null,
    baselineIssue: 'invalid_baseline' | null = null): OwnerSyncFoldPage {
    return Object.freeze({ page, capacityIssue, baselineIssue, completedBaseline: completed })
  }
  return Object.freeze({
    accumulateOwnerSyncPage(rawBody: string, parameters: OwnerSyncPageContext): OwnerSyncFoldPage {
      if (closed) return reject()
      let page: OwnerSyncChangesPage
      try {
        // Do not account or expose an unparsed response as a legal observed
        // head. This retains the parser's original 2MiB/depth/node limits.
        page = parseSyncChangesPage(rawBody, parameters)
        const pageLimit = parameters.limit ?? 100
        if (parameters.sinceRevision !== since || !sameCursor(parameters.cursor, after)
          || upper !== undefined && parameters.upperRevision !== upper
          || limit !== undefined && pageLimit !== limit) reject()
        limit = pageLimit
      } catch { stop(); return reject() }
      upper = page.upper_revision
      cumulativeBytes += encoder.encode(rawBody).byteLength
      historyCount += page.changes.length
      if (cumulativeBytes > OWNER_SYNC_MAX_CUMULATIVE_PAGE_BYTES) { stop(); return result(page, 'cumulative_bytes') }
      if (historyCount > OWNER_SYNC_MAX_HISTORY_RECORDS) { stop(); return result(page, 'history_count') }
      // Size is the complete envelope plus per-record deltas, not repeated
      // canonicalization of the Map. Repeated keys still consumed raw bytes
      // and history count above; only retained-image bytes subtract old rows.
      const envelopeBytes = byteLength({ pulledRevision: upper, records: [] })
      for (const record of page.changes) {
        const previous = records.get(record.key), bytes = byteLength(record)
        recordBytes += bytes - (previous?.bytes ?? 0)
        records.set(record.key, { record, bytes })
        if (envelopeBytes + recordBytes + Math.max(0, records.size - 1) > OWNER_SYNC_MAX_RESPONSE_BYTES) {
          stop(); return result(page, 'retained_bytes')
        }
      }
      if (page.complete) {
        try {
          completed = validateOwnerWorkspaceCloudBaseline({ pulledRevision: upper,
            records: [...records.values()].map(value => value.record) })
          closed = true
          records.clear(); recordBytes = 0
        } catch { stop(); return result(page, null, 'invalid_baseline') }
      } else after = page.next_cursor ?? undefined
      return result(page)
    },
    getCompletedBaseline: () => completed,
  })
}
