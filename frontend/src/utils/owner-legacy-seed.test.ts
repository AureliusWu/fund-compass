import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncWatchSnapshot } from '@/stores/watchlist'
import { buildOwnerSyncPreview } from './owner-sync-preview'
import { canonicalOwnerWorkspaceEntries, OWNER_WORKSPACE_MAX_ENTRIES, OWNER_WORKSPACE_MAX_IMAGE_BYTES,
  type OwnerWorkspaceEntry } from './owner-cloud-import'
import {
  buildOwnerBusinessExport, decodeOwnerLegacySeed, restoreOwnerBusinessExport, OwnerLegacySeedError,
  OWNER_BUSINESS_EXPORT_FORMAT, OWNER_BUSINESS_EXPORT_MAX_BYTES,
} from './owner-legacy-seed'

const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
const sourceKey = 'sinan_watchlist_v2' as const
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function local(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: '000001', name: '合成基金', account: '合成账户', position_kind: 'holding', shares: 0,
    cost: null, target_weight: null, updated_at: '2026-10-20T01:02:03.000Z', local_pending: true, ...patch }
}
function decode(rows: unknown[]) { return decodeOwnerLegacySeed({ sourceKey, raw: JSON.stringify(rows) }) }
function entry(patch: Record<string, unknown> = {}): OwnerWorkspaceEntry {
  return { key: '000001::合成账户', kind: 'holding', deleted: false, local_pending: true,
    values: { name: '合成基金', shares: 0, cost: null, target_weight: null }, ...patch } as OwnerWorkspaceEntry
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}
function rejectRaw(raw: string, code = 'invalid_legacy') {
  expect(() => decodeOwnerLegacySeed({ sourceKey, raw })).toThrow(OwnerLegacySeedError)
  try { decodeOwnerLegacySeed({ sourceKey, raw }) } catch (error) { expect(error).toMatchObject({ code }); return }
  throw new Error('expected_rejection')
}

describe('actual WatchEntry v1/v2 business allowlist codec', () => {
  it.each(['sinan_watchlist_v1', 'sinan_watchlist_v2'] as const)('preserves exact %s source/raw and projects declared kind, accounts, zero/null and tombstones', key => {
    const input = { sourceKey: key, raw: ' \n' + JSON.stringify([
      local({ id: '000001::合成账户', shares: 0, cost: 0, target_weight: 0 }),
      local({ account: ' B ', id: '000001::B', position_kind: 'watch', shares: null, deleted: true }),
      local({ code: '000002', account: '', position_kind: 'holding', shares: null, local_pending: null }),
    ], null, 2) + '\r\n' }
    const before = JSON.stringify(input), result = decodeOwnerLegacySeed(input)
    expect(result.sourceKey).toBe(key); expect(result.raw).toBe(input.raw)
    expect(result.entries).toEqual([
      entry({ values: { name: '合成基金', shares: 0, cost: 0, target_weight: 0 } }),
      entry({ key: '000001::B', kind: 'watch', deleted: true, values: { name: '合成基金', shares: null, cost: null, target_weight: null } }),
      entry({ key: '000002::', local_pending: false, values: { name: '合成基金', shares: null, cost: null, target_weight: null } }),
    ])
    expect(JSON.stringify(input)).toBe(before)
    expect(JSON.stringify(result.entries)).not.toMatch(/updated_at|position_kind|record_revision|holding_version|"id"|"account"/)
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.entries[0].values)).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
  })

  it('keeps an absent slot distinct from a present empty array without IO', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => { throw new Error('forbidden') }), setItem: vi.fn(() => { throw new Error('forbidden') }) })
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('forbidden') }))
    expect(decodeOwnerLegacySeed({ sourceKey, raw: null })).toEqual({ sourceKey, raw: null, entries: [] })
    expect(decodeOwnerLegacySeed({ sourceKey, raw: '[]' })).toEqual({ sourceKey, raw: '[]', entries: [] })
    expect(localStorage.getItem).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it('uses only historical positive shares to infer a missing kind and keeps absent finance unknown', () => {
    const row = local({ shares: 5 }); delete row.position_kind; delete row.account
    delete row.cost; delete row.target_weight; delete row.local_pending
    expect(decode([row]).entries).toEqual([entry({ key: '000001::', local_pending: false,
      values: { name: '合成基金', shares: 5, cost: null, target_weight: null } })])
  })

  it('matches the existing public Owner preview for named, unambiguous real legacy shapes', () => {
    const oldPositive = local({ code: '000003', shares: 5 }); delete oldPositive.position_kind
    const rows = [local({ shares: 0, cost: 0, target_weight: 0 }),
      local({ account: 'B', position_kind: 'watch', shares: null }), oldPositive]
    const memory = JSON.stringify(rows)
    const preview = buildOwnerSyncPreview({ entries: rows, raw: memory, memory, generation: 1 } as unknown as OwnerSyncWatchSnapshot,
      { pulledRevision: 0, records: [] })
    expect(preview.issues).toEqual([])
    expect(decode(rows).entries.map(({ local_pending: _pending, ...row }) => row)).toEqual(
      preview.rows.map(row => ({ key: row.key, ...row.after })))
  })
  it('retains declared holding/null locally but does not claim it is a valid confirmed upload', () => {
    const rows = [local({ shares: null })], memory = JSON.stringify(rows)
    expect(decode(rows).entries[0]).toMatchObject({ kind: 'holding', values: { shares: null } })
    const preview = buildOwnerSyncPreview({ entries: rows, raw: memory, memory, generation: 1 } as unknown as OwnerSyncWatchSnapshot,
      { pulledRevision: 0, records: [] })
    expect(preview.operations).toEqual([]); expect(preview.issues).toContainEqual({ code: 'missing_value', key: '000001::合成账户' })
  })
  it.each([
    { code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' },
    { code: '510300', updated_at: '2026-09-30T00:00:00Z' },
    { id: '510300::', code: '510300', deleted: true, updated_at: '2020-01-01T00:00:00Z' },
  ])('rejects the existing nameless watchlist fixtures without silently inventing their name: %j', row => {
    // These are the actual public fixtures in watchlist.test.ts, not private LS.
    rejectRaw(JSON.stringify([row]), 'missing_name')
  })
  it('never infers holding from cost/target_weight or turns ambiguous input into a watch', () => {
    const row = local({ shares: null, cost: 10, target_weight: 50 }); delete row.position_kind
    rejectRaw(JSON.stringify([row]), 'ambiguous_kind')
  })

  it.each([undefined, null, 0, -0])('does not infer kind from unknown/zero shares=%s', shares => {
    const row = local({ shares }); delete row.position_kind
    rejectRaw(JSON.stringify([row]), 'ambiguous_kind')
  })
  it.each([undefined, null, '', '  '])('does not manufacture missing name %s even for a tombstone', name => {
    rejectRaw(JSON.stringify([local({ name, deleted: true })]), 'missing_name')
  })
  it('preserves pending markers, original names and declared zero/unknown intent without new timestamps', () => {
    const rows = [local({ position_kind: 'watch', shares: 0, name: ' 原名称 ' }),
      local({ account: 'B', shares: null, local_pending: undefined })]
    const result = decode(rows)
    expect(result.entries[0]).toMatchObject({ kind: 'watch', local_pending: true, values: { name: ' 原名称 ', shares: 0 } })
    expect(result.entries[1]).toMatchObject({ kind: 'holding', local_pending: false, values: { shares: null } })
    expect(result.raw).toBe(JSON.stringify(rows))
  })
  it.each(['2026-10-20', '2024-02-29T01:02:03Z', '2026-10-20T01:02:03.1Z', '2026-10-20T01:02:03.123Z'])('accepts actual Gist timestamp spelling %s but never copies it into business entries', updated_at => {
    const result = decode([local({ updated_at })])
    expect(result.raw).toContain(updated_at); expect(result.entries).toEqual([entry()])
  })
  it.each(['', 'not-a-date', '2026-02-30', '2026-02-29', '2026-10-20T24:00:00Z',
    '2026-10-20T01:02:03+08:00', '2026-10-20T01:02:03.1234Z', '2026-10-20\n'])('rejects malformed legacy timestamp %s', updated_at => {
    rejectRaw(JSON.stringify([local({ updated_at })]))
  })
  it.each([
    { token: 'synthetic-forbidden' }, { holding_version: 1 }, { cls: '现金' }, { local_pending: false },
    { local_pending: 'true' }, { deleted: 1 }, { account: 0 }, { account: 'A\t' }, { account: 'A\u0085' },
    { account: 'A'.repeat(65) }, { id: '000001::wrong' }, { id: '' }, { code: '000001\n' },
    { position_kind: 'manual_asset' }, { position_kind: 'watch', shares: 1 }, { shares: '0' },
    { shares: -1 }, { cost: -1 }, { target_weight: 100.01 }, { name: 'bad\u0000name' },
  ])('rejects unsupported/bad known fields without dropping a row: %j', patch => {
    rejectRaw(JSON.stringify([local(), local({ account: 'B', ...patch })]))
  })
  it('rejects duplicate normalized account keys rather than merging records or choosing newer timestamps', () => {
    rejectRaw(JSON.stringify([local(), local({ account: ' 合成账户 ', deleted: true, updated_at: '2026-10-21' })]))
  })
  it.each(['null', '{}', '[null]', '[1]', '[[]]', '[true]', '["fund"]', '[] trailing', '[,]', '[1,]'])('rejects non-array/bad JSON %s', raw => rejectRaw(raw))
  it('rejects duplicate and escaped duplicate JSON fields before JSON.parse can silently choose a value', () => {
    const raw = JSON.stringify([local()])
    rejectRaw(raw.replace('"shares":0', '"shares":0,"shares":5'))
    rejectRaw(raw.replace('"shares":0', '"shares":0,"sh\\u0061res":5'))
    rejectRaw(raw.replace('"shares":0', '"__proto__":{"polluted":true},"shares":0'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  it.each(['9007199254740993', '1e309', '-Infinity', 'NaN', '01', '+1', '.1'])('rejects lossy/invalid JSON numeric token %s', number => {
    rejectRaw(JSON.stringify([local()]).replace('"shares":0', '"shares":' + number))
  })
  it('preserves negative zero bytes/value and accepts well-formed Unicode without replacement', () => {
    const raw = JSON.stringify([local({ name: '合成😀基金' })]).replace('"shares":0', '"shares":-0')
    const result = decodeOwnerLegacySeed({ sourceKey, raw })
    expect(Object.is(result.entries[0].values.shares, -0)).toBe(true); expect(result.raw).toBe(raw)
    expect(result.entries[0].values.name).toBe('合成😀基金')
  })
  it.each(['\\ud800', '\\udfff', '\ud800'])('rejects lone surrogate %j', scalar => {
    rejectRaw(JSON.stringify([local()]).replace('合成基金', scalar))
  })
  it('bounds raw UTF-16 length, UTF-8 bytes and list count without truncation', () => {
    rejectRaw(' '.repeat(OWNER_WORKSPACE_MAX_IMAGE_BYTES + 1), 'capacity_exceeded')
    rejectRaw('中'.repeat(Math.floor(OWNER_WORKSPACE_MAX_IMAGE_BYTES / 3) + 1), 'capacity_exceeded')
    rejectRaw('[' + Array.from({ length: OWNER_WORKSPACE_MAX_ENTRIES + 1 }, () => 'null').join(',') + ']', 'capacity_exceeded')
  })
  it.each([null, {}, { sourceKey: 'sinan_gist_token', raw: '[]' }, { sourceKey, raw: 0 },
    { sourceKey, raw: '[]', extra: true }])('rejects unsupported source envelopes %j', input => {
    expect(() => decodeOwnerLegacySeed(input)).toThrow(OwnerLegacySeedError)
  })
  it('rejects accessors/symbol fields without invoking an accessor or echoing private input', () => {
    const getter = vi.fn(() => '[]'), input = { sourceKey, get raw() { return getter() } }
    expect(() => decodeOwnerLegacySeed(input)).toThrow('Owner business codec rejected')
    expect(getter).not.toHaveBeenCalled()
    expect(() => decodeOwnerLegacySeed({ sourceKey, raw: '[]', [Symbol('extra')]: 'synthetic-secret' })).toThrow(OwnerLegacySeedError)
    try { decodeOwnerLegacySeed({ sourceKey, raw: 'synthetic-sensitive-value' }) } catch (error) {
      expect(String(error)).not.toContain('synthetic-sensitive-value')
    }
  })
})

describe('closed business-only export and pure re-import validation', () => {
  it('round-trips only allowlisted business data, independently checks SHA/counts and preserves account/type/zero/null/tombstone/pending', async () => {
    const input = [entry(), entry({ key: '000001::B', kind: 'watch', deleted: true, local_pending: false,
      values: { name: '仅关注', shares: null, cost: 0, target_weight: 0 } })]
    const before = JSON.stringify(input), built = await buildOwnerBusinessExport(input)
    expect(built.envelope.format).toBe(OWNER_BUSINESS_EXPORT_FORMAT)
    expect(built.envelope.counts).toEqual({ total: 2, watch: 1, holding: 1, tombstones: 1, localPending: 1 })
    expect(built.envelope.entriesSha256).toBe(sha(canonicalOwnerWorkspaceEntries(input)))
    expect(built.sha256).toBe(sha(built.raw)); expect(built.byteLength).toBe(Buffer.byteLength(built.raw, 'utf8'))
    expect(await restoreOwnerBusinessExport(built.raw, built.sha256)).toEqual(built.envelope)
    expect(Object.keys(built.envelope).sort()).toEqual(['counts', 'entries', 'entriesSha256', 'format'])
    expect(built.raw).not.toMatch(/updated_at|sourceKey|"raw"|token|credential|record_revision|localVersion|targetFingerprint/)
    expect(JSON.stringify(input)).toBe(before); expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(built.envelope.entries[0].values)).toBe(true)
  })
  it('round-trips empty and signed-zero business data without JSON.stringify zero loss', async () => {
    const empty = await buildOwnerBusinessExport([])
    expect((await restoreOwnerBusinessExport(empty.raw, empty.sha256)).counts).toEqual({ total: 0, watch: 0, holding: 0, tombstones: 0, localPending: 0 })
    const negative = await buildOwnerBusinessExport([entry({ values: { name: '合成基金', shares: -0, cost: -0, target_weight: null } })])
    const positive = await buildOwnerBusinessExport([entry({ values: { name: '合成基金', shares: 0, cost: 0, target_weight: null } })])
    expect(negative.sha256).not.toBe(positive.sha256)
    const restored = await restoreOwnerBusinessExport(negative.raw, negative.sha256)
    expect(Object.is(restored.entries[0].values.shares, -0)).toBe(true)
    expect(Object.is(restored.entries[0].values.cost, -0)).toBe(true)
  })
  it('clones input before async hashing, so caller mutation cannot change a sealed export', async () => {
    const input = [entry()], pending = buildOwnerBusinessExport(input)
    ;(input[0].values as { name: string }).name = '后来修改'
    expect((await pending).envelope.entries[0].values.name).toBe('合成基金')
  })
  it.each([
    { legacy: { sourceKey, raw: 'synthetic-private-archive' } }, { updated_at: '2026-10-20' }, { token: 'synthetic-token' },
  ])('rejects extra input fields instead of silently dropping them: %j', async patch => {
    await expect(buildOwnerBusinessExport([entry(patch)])).rejects.toMatchObject({ code: 'invalid_export' })
  })
  it.each(['wrong-format', '', 'sinan-owner-business-export-2'])('rejects unsupported format %j with a matching external hash', async format => {
    const built = await buildOwnerBusinessExport([entry()]), raw = canonical({ ...built.envelope, format })
    await expect(restoreOwnerBusinessExport(raw, sha(raw))).rejects.toMatchObject({ code: 'invalid_export' })
  })
  it.each([{ total: 0 }, { watch: 1 }, { holding: 0 }, { tombstones: 1 }, { localPending: 0 }, { total: -0 }, { extra: 0 }])('rejects wrong/extra counts %j', async patch => {
    const built = await buildOwnerBusinessExport([entry()]), raw = canonical({ ...built.envelope, counts: { ...built.envelope.counts, ...patch } })
    await expect(restoreOwnerBusinessExport(raw, sha(raw))).rejects.toMatchObject({ code: 'invalid_export' })
  })
  it('requires external byte hash as well as the complete internal business digest', async () => {
    const built = await buildOwnerBusinessExport([entry()])
    await expect(restoreOwnerBusinessExport(built.raw, '0'.repeat(64))).rejects.toMatchObject({ code: 'hash_mismatch' })
    const row = JSON.parse(built.raw); row.entries[0].values.shares = 9
    const raw = canonical(row)
    await expect(restoreOwnerBusinessExport(raw, sha(raw))).rejects.toMatchObject({ code: 'hash_mismatch' })
    await expect(restoreOwnerBusinessExport(built.raw, undefined)).rejects.toMatchObject({ code: 'invalid_export' })
  })
  it('rejects new secrets/metadata even with a matching outside hash', async () => {
    const built = await buildOwnerBusinessExport([entry()])
    for (const raw of [canonical({ ...built.envelope, token: 'synthetic-token' }),
      canonical({ ...built.envelope, entries: [entry({ updated_at: '2026-10-20' })] })]) {
      await expect(restoreOwnerBusinessExport(raw, sha(raw))).rejects.toMatchObject({ code: 'invalid_export' })
    }
  })
  it('rejects duplicate keys and noncanonical spellings despite matching external byte hash', async () => {
    const built = await buildOwnerBusinessExport([entry()])
    for (const raw of [' ' + built.raw, built.raw + '\n', built.raw.replace('"entries":', '"entries":[],"entries":'),
      built.raw.replace('合成基金', '\\u5408成基金')]) {
      await expect(restoreOwnerBusinessExport(raw, sha(raw))).rejects.toMatchObject({ code: 'invalid_export' })
    }
  })
  it('enforces bounded export bytes and fixed error messages', async () => {
    await expect(restoreOwnerBusinessExport(' '.repeat(OWNER_BUSINESS_EXPORT_MAX_BYTES + 1), '0'.repeat(64))).rejects.toMatchObject({ code: 'capacity_exceeded' })
    await expect(restoreOwnerBusinessExport('synthetic-private-plaintext', '0'.repeat(64))).rejects.toThrow('Owner business codec rejected')
  })
  it('fails closed when SHA-256 is unavailable, without a noncryptographic substitute', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => { throw new Error('unavailable') }) } })
    await expect(buildOwnerBusinessExport([entry()])).rejects.toMatchObject({ code: 'hash_unavailable' })
    await expect(restoreOwnerBusinessExport('{}', sha('{}'))).rejects.toMatchObject({ code: 'hash_unavailable' })
  })
})
