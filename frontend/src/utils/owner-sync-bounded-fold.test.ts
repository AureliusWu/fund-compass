import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import { validateOwnerWorkspaceCloudBaseline } from './owner-workspace-sync-baseline'
import {
  OwnerSyncContractError, OWNER_SYNC_MAX_RESPONSE_BYTES,
  type OwnerSyncCursor, type OwnerSyncPageContext, type OwnerSyncRecord,
} from './ownerSyncContract'
import {
  createOwnerSyncBoundedFold, OWNER_SYNC_MAX_CUMULATIVE_PAGE_BYTES, OWNER_SYNC_MAX_HISTORY_RECORDS,
} from './owner-sync-bounded-fold'

afterEach(() => vi.restoreAllMocks())
const size = (raw: string) => new TextEncoder().encode(raw).byteLength
function manual(index: number, revision = 1, note: string | null = null): OwnerSyncRecord {
  return { key: 'asset:' + String(index).padStart(6, '0'), kind: 'manual_asset', deleted: false,
    record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: 1, cls: 1, value: revision, note: revision },
    values: { name: 'synthetic-manual', cls: '现金', value: 0, note } }
}
function page(records: readonly OwnerSyncRecord[], upper: number, complete = true): string {
  const last = records[records.length - 1]
  return canonicalOwnerLocal({ upper_revision: upper, changes: records, complete,
    next_cursor: complete ? null : [last.record_revision, last.key] })
}
function parameters(upper?: number, cursor?: OwnerSyncCursor, sinceRevision = 0, limit = 200): OwnerSyncPageContext {
  return { sinceRevision, limit, ...(upper === undefined ? {} : { upperRevision: upper }), ...(cursor === undefined ? {} : { cursor }) }
}
function rows(first: number, count: number, revision: number, note: string): OwnerSyncRecord[] {
  return Array.from({ length: count }, (_, index) => manual(first + index, revision, note))
}
function padded(raw: string, bytes: number): string {
  expect(size(raw)).toBeLessThanOrEqual(bytes)
  return raw + ' '.repeat(bytes - size(raw))
}
function rejected(work: () => unknown): void {
  expect(work).toThrow(OwnerSyncContractError)
  try { work(); expect.fail('accepted invalid page') }
  catch (error) { expect(error).toMatchObject({ code: 'invalid_sync_contract', message: 'Owner sync contract rejected' }) }
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true)
    Object.values(value).forEach(frozen)
  }
}

describe('pure bounded Owner history fold', () => {
  it('constructs cold without clocks, network, storage or crypto', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const clock = vi.spyOn(performance, 'now')
    const fold = createOwnerSyncBoundedFold()
    expect(fold.getCompletedBaseline()).toBeNull()
    expect(fetch).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled()
    expect(Object.keys(fold)).toEqual(['accumulateOwnerSyncPage', 'getCompletedBaseline'])
    expect(OWNER_SYNC_MAX_CUMULATIVE_PAGE_BYTES).toBe(4 * 1024 * 1024)
    expect(OWNER_SYNC_MAX_HISTORY_RECORDS).toBe(100_000)
  })

  it('accepts a real complete empty zero head and exposes no authentication claim', () => {
    const fold = createOwnerSyncBoundedFold()
    const result = fold.accumulateOwnerSyncPage(page([], 0), parameters())
    expect(result).toEqual({ page: { upper_revision: 0, changes: [], next_cursor: null, complete: true },
      capacityIssue: null, baselineIssue: null, completedBaseline: { pulledRevision: 0, records: [] } })
    expect(fold.getCompletedBaseline()).toBe(result.completedBaseline)
    expect(result).not.toHaveProperty('authenticated')
    expect(result).not.toHaveProperty('source_current')
    frozen(result)
  })

  it('preserves fund/manual fields, tombstones, UTF8, null, signed zero and every revision', () => {
    const fund: OwnerSyncRecord = { key: '000001::合成账户😀', kind: 'holding', deleted: false,
      record_revision: 2, lifecycle_revision: 1, field_revisions: { name: 1, shares: 2, cost: 1, target_weight: 2 },
      values: { name: 'synthetic-fund', shares: -0, cost: null, target_weight: 0 } }
    const asset: OwnerSyncRecord = { ...manual(1, 3, ' 私人原文😀 '), deleted: true, lifecycle_revision: 2,
      field_revisions: { name: 1, cls: 2, value: 3, note: 2 }, values: { name: ' 合成 ', cls: '权益', value: -0, note: ' 私人原文😀 ' } }
    const result = createOwnerSyncBoundedFold().accumulateOwnerSyncPage(page([fund, asset], 3), parameters())
    expect(result.completedBaseline).toEqual({ pulledRevision: 3, records: [fund, asset] })
    expect(Object.is(result.completedBaseline!.records[0].values.shares, -0)).toBe(true)
    expect(Object.is(result.completedBaseline!.records[1].values.value, -0)).toBe(true)
    frozen(result)
  })

  it('never exposes a partial baseline and replaces later history without reordering initial insertion', () => {
    const fold = createOwnerSyncBoundedFold()
    const first = fold.accumulateOwnerSyncPage(page([manual(2), manual(3)], 3, false), parameters(undefined, undefined, 0, 2))
    expect(first.completedBaseline).toBeNull(); expect(fold.getCompletedBaseline()).toBeNull()
    const replacement = { ...manual(2, 2, 'new'), deleted: true }
    const last = fold.accumulateOwnerSyncPage(page([replacement, manual(1, 3)], 3), parameters(3, first.page.next_cursor!, 0, 2))
    expect(last.completedBaseline!.records.map(row => row.key)).toEqual(['asset:000002', 'asset:000003', 'asset:000001'])
    expect(last.completedBaseline!.records[0]).toEqual(replacement)
    expect(validateOwnerWorkspaceCloudBaseline(last.completedBaseline)).toEqual(last.completedBaseline)
  })

  it('owns and really validates the seed for the original incremental contract', () => {
    const original = manual(3)
    const seed: OwnerSyncBaseline = { pulledRevision: 1, records: [original] }
    const fold = createOwnerSyncBoundedFold(seed)
    ;(original.values as Record<string, unknown>).name = 'changed caller memory'
    const result = fold.accumulateOwnerSyncPage(page([manual(1, 2)], 2), parameters(undefined, undefined, 1))
    expect(result.completedBaseline!.records.map(row => row.key)).toEqual(['asset:000003', 'asset:000001'])
    expect(result.completedBaseline!.records[0].values.name).toBe('synthetic-manual')
    expect(Object.isFrozen(original)).toBe(false)
  })

  it('accepts an unchanged complete incremental page only with the verified original seed', () => {
    const seed = validateOwnerWorkspaceCloudBaseline({ pulledRevision: 1, records: [manual(1)] })
    const result = createOwnerSyncBoundedFold(seed).accumulateOwnerSyncPage(page([], 1), parameters(undefined, undefined, 1))
    expect(result.completedBaseline).toEqual(seed)
    rejected(() => createOwnerSyncBoundedFold().accumulateOwnerSyncPage(page([], 1), parameters(undefined, undefined, 1)))
  })

  it('rejects an invalid or accessor seed through the real complete-baseline codec', () => {
    rejected(() => createOwnerSyncBoundedFold({ pulledRevision: 2, records: [manual(1)] }))
    const getter = vi.fn(() => [manual(1)])
    const seed = Object.defineProperty({ pulledRevision: 1 }, 'records', { enumerable: true, get: getter })
    rejected(() => createOwnerSyncBoundedFold(seed as OwnerSyncBaseline))
    expect(getter).not.toHaveBeenCalled()
  })

  it('counts every 400+KiB repeated-key response although the retained Map stays small', () => {
    const fold = createOwnerSyncBoundedFold()
    let cursor: OwnerSyncCursor | undefined, rejectedPage = false
    for (let revision = 1; revision <= 10; revision++) {
      const raw = page(rows(0, 200, revision, 'x'.repeat(2000)), 10, revision === 10)
      expect(size(raw)).toBeGreaterThan(400 * 1024)
      const result = fold.accumulateOwnerSyncPage(raw, parameters(revision === 1 ? undefined : 10, cursor))
      if (result.capacityIssue) {
        expect(result.capacityIssue).toBe('cumulative_bytes')
        expect(result.page.upper_revision).toBe(10)
        expect(result.completedBaseline).toBeNull(); expect(fold.getCompletedBaseline()).toBeNull()
        rejectedPage = true
        break
      }
      cursor = result.page.next_cursor!
    }
    expect(rejectedPage).toBe(true)
    rejected(() => fold.accumulateOwnerSyncPage(page([manual(0, 10)], 10), parameters()))
    expect(fold.getCompletedBaseline()).toBeNull()
  })

  it('allows exactly 4MiB cumulative raw UTF8, including legal JSON whitespace', () => {
    const fold = createOwnerSyncBoundedFold()
    const first = fold.accumulateOwnerSyncPage(padded(page(rows(0, 200, 1, ''), 2, false), OWNER_SYNC_MAX_RESPONSE_BYTES), parameters())
    const result = fold.accumulateOwnerSyncPage(padded(page(rows(0, 200, 2, ''), 2), OWNER_SYNC_MAX_RESPONSE_BYTES), parameters(2, first.page.next_cursor!))
    expect(result.capacityIssue).toBeNull(); expect(result.baselineIssue).toBeNull()
    expect(result.completedBaseline!.records).toHaveLength(200)
  })

  it('counts UTF8 bytes rather than JS string length across Chinese history pages', () => {
    const fold = createOwnerSyncBoundedFold()
    let cursor: OwnerSyncCursor | undefined, units = 0, bytes = 0
    for (let revision = 1; revision <= 4; revision++) {
      const raw = page(rows(0, 200, revision, '中'.repeat(2000)), 4, revision === 4)
      units += raw.length; bytes += size(raw)
      const result = fold.accumulateOwnerSyncPage(raw, parameters(revision === 1 ? undefined : 4, cursor))
      if (revision < 4) expect(result.capacityIssue).toBeNull()
      else {
        expect(units).toBeLessThan(OWNER_SYNC_MAX_CUMULATIVE_PAGE_BYTES)
        expect(bytes).toBeGreaterThan(OWNER_SYNC_MAX_CUMULATIVE_PAGE_BYTES)
        expect(result.capacityIssue).toBe('cumulative_bytes')
        expect(result.page.complete).toBe(true); expect(result.completedBaseline).toBeNull()
      }
      cursor = result.page.next_cursor ?? undefined
    }
  })

  it('rejects a retained complete image above 2MiB before cumulative 4MiB is used', () => {
    const fold = createOwnerSyncBoundedFold()
    const firstRaw = page(rows(0, 200, 1, '中'.repeat(2000)), 2, false)
    const lastRaw = page(rows(200, 200, 2, '中'.repeat(2000)), 2)
    expect(size(firstRaw) + size(lastRaw)).toBeLessThan(OWNER_SYNC_MAX_CUMULATIVE_PAGE_BYTES)
    const first = fold.accumulateOwnerSyncPage(firstRaw, parameters())
    const result = fold.accumulateOwnerSyncPage(lastRaw, parameters(2, first.page.next_cursor!))
    expect(result.capacityIssue).toBe('retained_bytes')
    expect(result.page.upper_revision).toBe(2); expect(result.completedBaseline).toBeNull()
    rejected(() => fold.accumulateOwnerSyncPage(page([], 0), parameters()))
  })

  it('subtracts old full rows on large incremental replacements instead of accumulating retained history', () => {
    const seed = validateOwnerWorkspaceCloudBaseline({ pulledRevision: 1, records: rows(0, 300, 1, '中'.repeat(2000)) })
    const fold = createOwnerSyncBoundedFold(seed)
    const first = fold.accumulateOwnerSyncPage(page(rows(0, 200, 2, '中'.repeat(2000)), 2, false), parameters(undefined, undefined, 1))
    const result = fold.accumulateOwnerSyncPage(page(rows(200, 100, 2, '中'.repeat(2000)), 2), parameters(2, first.page.next_cursor!, 1))
    expect(result.capacityIssue).toBeNull(); expect(result.baselineIssue).toBeNull()
    expect(result.completedBaseline!.records).toHaveLength(300)
    expect(result.completedBaseline!.records.every(row => row.record_revision === 2)).toBe(true)
  })

  it('does not reserialize untouched retained rows while accumulating another page', () => {
    const untouched = 'synthetic-untouched-row-must-not-be-reserialized'
    const seed = validateOwnerWorkspaceCloudBaseline({ pulledRevision: 1, records: rows(0, 300, 1, untouched) })
    const fold = createOwnerSyncBoundedFold(seed)
    const raw = page([manual(0, 2, 'replacement')], 2, false)
    const stringify = vi.spyOn(JSON, 'stringify')
    const result = fold.accumulateOwnerSyncPage(raw, parameters(undefined, undefined, 1, 1))
    expect(result.completedBaseline).toBeNull()
    expect(stringify.mock.calls.some(call => call[0] === untouched)).toBe(false)
  })

  it('includes envelope revision digits, separators and signed zero in exact retained bytes', () => {
    const records: OwnerSyncRecord[] = []
    let bytes = size(canonicalOwnerLocal({ pulledRevision: 9, records: [] }))
    for (let index = 0;; index++) {
      const empty = manual(index, 9, ''), fixed = size(canonicalOwnerLocal(empty)) + (records.length ? 1 : 0)
      const remaining = OWNER_SYNC_MAX_RESPONSE_BYTES - bytes - fixed
      const noteBytes = Math.min(6000, remaining)
      const note = '中'.repeat(Math.floor(noteBytes / 3)) + 'x'.repeat(noteBytes % 3)
      records.push(manual(index, 9, note)); bytes += fixed + noteBytes
      if (bytes === OWNER_SYNC_MAX_RESPONSE_BYTES) break
    }
    const seed = validateOwnerWorkspaceCloudBaseline({ pulledRevision: 9, records })
    expect(size(canonicalOwnerLocal(seed))).toBe(OWNER_SYNC_MAX_RESPONSE_BYTES)
    const source = records[0], note = source.values.note as string
    // record_revision +1 byte, pulledRevision +1, -0 +1, note shrinks by2.
    const update: OwnerSyncRecord = { ...source, record_revision: 10,
      values: { ...source.values, value: -0, note: note.slice(0, -1) + 'x' } }
    const result = createOwnerSyncBoundedFold(seed).accumulateOwnerSyncPage(page([update], 10), parameters(undefined, undefined, 9))
    expect(result.capacityIssue).toBe('retained_bytes')
    expect(result.completedBaseline).toBeNull()
  })

  it('returns a strict terminal page but no baseline when the real complete codec rejects its head', () => {
    const fold = createOwnerSyncBoundedFold()
    const result = fold.accumulateOwnerSyncPage(page([manual(0)], 2), parameters())
    expect(result.page).toMatchObject({ upper_revision: 2, complete: true })
    expect(result.capacityIssue).toBeNull(); expect(result.baselineIssue).toBe('invalid_baseline')
    expect(result.completedBaseline).toBeNull(); expect(fold.getCompletedBaseline()).toBeNull()
    rejected(() => fold.accumulateOwnerSyncPage(page([manual(0, 2)], 2), parameters()))
  })

  it.each([
    ['duplicate JSON key', '{"upper_revision":0,"upper_revision":0,"changes":[],"next_cursor":null,"complete":true}'],
    ['float revision token', '{"upper_revision":0.0,"changes":[],"next_cursor":null,"complete":true}'],
    ['bad complete flag', '{"upper_revision":0,"changes":[],"next_cursor":null,"complete":1}'],
    ['unknown field', '{"upper_revision":0,"changes":[],"next_cursor":null,"complete":true,"extra":null}'],
    ['malformed JSON', '{synthetic-private-body'],
    ['oversize first response', page([], 0) + ' '.repeat(OWNER_SYNC_MAX_RESPONSE_BYTES)],
  ])('closes on %s with only the fixed parser error', (_name, raw) => {
    const fold = createOwnerSyncBoundedFold()
    rejected(() => fold.accumulateOwnerSyncPage(raw, parameters()))
    rejected(() => fold.accumulateOwnerSyncPage(page([], 0), parameters()))
    expect(fold.getCompletedBaseline()).toBeNull()
  })

  it.each(['since', 'upper', 'cursor', 'limit'] as const)('binds the original %s across a page chain', field => {
    const fold = createOwnerSyncBoundedFold()
    const first = fold.accumulateOwnerSyncPage(page([manual(0)], 3, false), parameters(undefined, undefined, 0, 1))
    let next = parameters(3, first.page.next_cursor!, 0, 1)
    if (field === 'since') next = { ...next, sinceRevision: 1 }
    if (field === 'upper') next = { ...next, upperRevision: 4 }
    if (field === 'cursor') next = { ...next, cursor: [1, 'asset:000001'] }
    if (field === 'limit') next = { ...next, limit: 2 }
    rejected(() => fold.accumulateOwnerSyncPage(page([manual(2, 3)], field === 'upper' ? 4 : 3), next))
    rejected(() => fold.accumulateOwnerSyncPage(page([manual(2, 3)], 3), parameters(3, first.page.next_cursor!, 0, 1)))
  })

  it('rejects a skipped first cursor even if that individual page parses', () => {
    rejected(() => createOwnerSyncBoundedFold().accumulateOwnerSyncPage(page([manual(2, 3)], 3), parameters(3, [1, 'asset:000001'])))
  })

  it('rejects parameter getters without invoking them or accepting a later good page', () => {
    const getter = vi.fn(() => 0)
    const context = Object.defineProperty({ limit: 200 }, 'sinceRevision', { enumerable: true, get: getter })
    const fold = createOwnerSyncBoundedFold()
    rejected(() => fold.accumulateOwnerSyncPage(page([], 0), context as OwnerSyncPageContext))
    expect(getter).not.toHaveBeenCalled()
    rejected(() => fold.accumulateOwnerSyncPage(page([], 0), parameters()))
  })

  it('never accepts more pages after completion or alters the frozen completed image', () => {
    const fold = createOwnerSyncBoundedFold()
    const complete = fold.accumulateOwnerSyncPage(page([manual(0)], 1), parameters()).completedBaseline
    rejected(() => fold.accumulateOwnerSyncPage(page([manual(1, 2)], 2), parameters()))
    expect(fold.getCompletedBaseline()).toBe(complete)
    frozen(complete)
  })
})
