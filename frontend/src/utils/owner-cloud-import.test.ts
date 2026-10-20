import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'
import {
  buildCloudImportPreview, canonicalOwnerCloudImportPlan, canonicalOwnerWorkspaceEntries,
  hashOwnerCloudImportPlan, OwnerCloudImportError, OWNER_CLOUD_IMPORT_SCHEMA,
  OWNER_WORKSPACE_MAX_ENTRIES, OWNER_WORKSPACE_MAX_IMAGE_BYTES,
  validateOwnerCloudImportPlan, validateOwnerWorkspaceEntries, validateOwnerWorkspaceSnapshot,
  type OwnerWorkspaceEntry, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'

const TARGET = 'a'.repeat(64)
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function record(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return { key: '000001::合成账户', kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成基金', shares: 0, cost: null, target_weight: null }, ...patch } as OwnerSyncRecord
}
function manual(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return record({ key: 'asset:synthetic-manual', kind: 'manual_asset',
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: '合成手工资产', cls: '现金', value: 0, note: null }, ...patch })
}
function entry(patch: Record<string, unknown> = {}): OwnerWorkspaceEntry {
  return { key: '000001::合成账户', kind: 'holding', deleted: false,
    values: { name: '合成基金', shares: 0, cost: null, target_weight: null }, local_pending: true,
    ...patch } as OwnerWorkspaceEntry
}
function snapshot(entries: readonly OwnerWorkspaceEntry[] = [], patch: Record<string, unknown> = {}): OwnerWorkspaceSnapshot {
  return { localVersion: 7, entries, legacy: null, ...patch } as OwnerWorkspaceSnapshot
}
function baseline(records: readonly OwnerSyncRecord[] = [], pulledRevision = records.length ? 1 : 0) {
  return { pulledRevision, records }
}
function plan() {
  return { schema: OWNER_CLOUD_IMPORT_SCHEMA, targetFingerprint: TARGET, pulledRevision: 1,
    preimage: [], postimage: [entry()], excludedManualAssets: 0 }
}
function badPreview(cloud: unknown, local: unknown = snapshot()) {
  const preview = buildCloudImportPreview(cloud, local, TARGET)
  expect(preview.plan).toBeNull()
  expect(preview.counts).toBeNull()
  expect(preview.issues.length).toBeGreaterThan(0)
  return preview
}

describe('candidate cloud-only local import preview', () => {
  it('imports separate accounts, unknown holding, real zero and null without inventing versions/timestamps', () => {
    const input = baseline([record({ key: '000001::B', values: { name: '合成B', shares: null, cost: 0, target_weight: 0 } }),
      record({ key: '000001::A' }), record({ key: '000002::', kind: 'watch', values: { name: '仅关注', shares: null, cost: null, target_weight: null } })])
    const local = snapshot(), before = JSON.stringify({ input, local })
    const preview = buildCloudImportPreview(input, local, TARGET)
    expect(preview.issues).toEqual([])
    expect(preview.counts).toEqual({ added: 3, noops: 0, conflicts: 0, excludedManualAssets: 0, retainedLocal: 0 })
    expect(preview.plan!.postimage.map(row => row.key)).toEqual(['000001::A', '000001::B', '000002::'])
    expect(preview.plan!.postimage[1]).toMatchObject({ kind: 'holding', values: { shares: null, cost: 0, target_weight: 0 }, local_pending: true })
    expect(preview.plan!.postimage[0].values.shares).toBe(0)
    expect(preview.plan!.postimage[2]).toMatchObject({ kind: 'watch', values: { shares: null }, local_pending: true })
    expect(JSON.stringify({ input, local })).toBe(before)
    expect(JSON.stringify(preview.plan)).not.toMatch(/updated_at|holding_version|lifecycle_revision|record_revision|field_revisions/)
    expect(Object.isFrozen(preview.plan!.postimage[0].values)).toBe(true)
    expect(Reflect.set(preview.plan!.postimage[0].values, 'shares', 99)).toBe(false)
    expect(Object.isFrozen(input)).toBe(false)
  })

  it('retains cloud-only tombstones as deleted entries and never deletes cloud-absent local rows', () => {
    const old = entry({ key: '000003::旧账户', deleted: true, local_pending: true })
    const preview = buildCloudImportPreview(baseline([record({ deleted: true })]), snapshot([old]), TARGET)
    expect(preview.issues).toEqual([])
    expect(preview.plan!.preimage).toEqual([old])
    expect(preview.plan!.postimage[0]).toEqual(old)
    expect(preview.plan!.postimage[1]).toMatchObject({ key: '000001::合成账户', deleted: true, local_pending: true })
    expect(preview.plan!.postimage.filter(row => !row.deleted)).toEqual([])
  })

  it.each([true, false])('equal business input is noop and preserves local_pending=%s and localVersion', pending => {
    const local = snapshot([entry({ local_pending: pending })])
    const preview = buildCloudImportPreview(baseline([record()]), local, TARGET)
    expect(preview.issues).toEqual([])
    expect(preview.counts).toMatchObject({ added: 0, noops: 1, conflicts: 0, retainedLocal: 1 })
    expect(preview.plan).toBeNull()
    expect(preview.rows[0].before).toEqual(local.entries[0])
    expect(preview.rows[0].after.local_pending).toBe(pending)
    expect(local.localVersion).toBe(7)
  })

  it('preserves a pending noop alongside new rows and binds the entire original local image', () => {
    const local = snapshot([entry(), entry({ key: '000003::本机独有', local_pending: false })], {
      legacy: { sourceKey: 'sinan_watchlist_v1', raw: '["synthetic-original-source"]' },
    })
    const preview = buildCloudImportPreview(baseline([record(), record({ key: '000002::新增' })]), local, TARGET)
    expect(preview.plan!.preimage).toEqual(local.entries)
    expect(preview.plan!.postimage.slice(0, 2)).toEqual(local.entries)
    expect(preview.plan!.postimage[0].local_pending).toBe(true)
    expect(preview.plan!.postimage[1].local_pending).toBe(false)
    expect(preview.counts).toMatchObject({ added: 1, noops: 1, retainedLocal: 2 })
    expect(local.legacy?.raw).toBe('["synthetic-original-source"]')
  })

  it.each([
    { kind: 'watch' }, { deleted: true },
    { values: { name: '同key不同名称', shares: 0, cost: null, target_weight: null } },
    { values: { name: '合成基金', shares: null, cost: null, target_weight: null } },
    { values: { name: '合成基金', shares: 0, cost: 0, target_weight: null } },
    { values: { name: '合成基金', shares: 0, cost: null, target_weight: 0 } },
    { values: { name: '合成基金', shares: -0, cost: null, target_weight: null } },
  ])('rejects every same-key difference for the entire batch, including null/zero/signed-zero: %j', patch => {
    const local = snapshot([entry(patch)])
    const preview = buildCloudImportPreview(baseline([record({ key: '000002::新增' }), record()]), local, TARGET)
    expect(preview.plan).toBeNull()
    expect(preview.issues).toContainEqual({ code: 'same_key_difference', key: '000001::合成账户' })
    expect(preview.counts).toMatchObject({ added: 1, conflicts: 1 })
    expect(local.entries).toEqual([entry(patch)])
  })

  it('blocks both directions of tombstone/activity mismatch without timestamp-wins heuristics', () => {
    for (const [localDeleted, cloudDeleted] of [[true, false], [false, true]]) {
      const preview = buildCloudImportPreview(baseline([record({ deleted: cloudDeleted })]), snapshot([entry({ deleted: localDeleted })]), TARGET)
      expect(preview.issues[0].code).toBe('same_key_difference')
      expect(preview.plan).toBeNull()
    }
  })

  it('counts excluded manual assets including tombstones but copies none of their values', () => {
    const preview = buildCloudImportPreview(baseline([manual(), manual({ key: 'asset:synthetic-tombstone', deleted: true }), record()]), snapshot(), TARGET)
    expect(preview.counts).toMatchObject({ added: 1, excludedManualAssets: 2 })
    expect(preview.rows).toHaveLength(1)
    expect(preview.plan!.excludedManualAssets).toBe(2)
    expect(JSON.stringify(preview)).not.toContain('合成手工资产')
    expect(JSON.stringify(preview)).not.toContain('asset:')
    expect(buildCloudImportPreview(baseline([manual()]), snapshot(), TARGET).plan).toBeNull()
  })

  it('accepts an empty full head and does not turn remote absence into deletion', () => {
    const local = snapshot([entry({ deleted: true })])
    const preview = buildCloudImportPreview(baseline(), local, TARGET)
    expect(preview.rows).toEqual([])
    expect(preview.issues).toEqual([])
    expect(preview.counts).toMatchObject({ added: 0, retainedLocal: 1 })
    expect(preview.plan).toBeNull()
  })
})

describe('closed complete-baseline and local snapshot validation', () => {
  it.each([
    { revision: 1, records: [record()] },
    { upper_revision: 1, changes: [record()], next_cursor: null, complete: true },
    { pulledRevision: 1, records: [] },
    { pulledRevision: 2, records: [record()] },
    { pulledRevision: 0, records: [record()] },
    { pulledRevision: 1, records: [record(), record()] },
    { pulledRevision: true, records: [] },
    { pulledRevision: Number.MAX_SAFE_INTEGER + 1, records: [] },
    { pulledRevision: 1, records: [record()], extra: 'do-not-echo-this-private-value' },
  ])('rejects partial/POST/page/duplicate/unknown input without manufacturing counts: %j', cloud => {
    const preview = badPreview(cloud)
    expect(JSON.stringify(preview)).not.toContain('do-not-echo-this-private-value')
  })

  it.each([
    { key: '000001:: 合成账户 ' }, { record_revision: 2 }, { lifecycle_revision: 2 },
    { field_revisions: { name: 0, shares: 1, cost: 1, target_weight: 1 } },
    { field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1, future: 1 } },
    { values: { name: '合成基金', shares: '0', cost: null, target_weight: null } },
    { values: { name: '合成基金', shares: Infinity, cost: null, target_weight: null } },
    { values: { name: '合成基金', shares: Number.MAX_SAFE_INTEGER + 1, cost: null, target_weight: null } },
    { values: { name: '合成基金', shares: 0, cost: null } },
    { values: { name: '合成基金', shares: 0, cost: null, target_weight: 101 } },
    { values: { name: '合成基金', shares: 0, cost: null, target_weight: null, unknown: null } },
    { unknown: 'do-not-echo-record-value' },
  ])('reuses the actual Owner record grammar without coercion: %j', patch => {
    expect(badPreview(baseline([record(patch)])).issues[0].code).toBe('invalid_baseline')
  })

  it('validates manual records before excluding them', () => {
    expect(badPreview(baseline([manual({ values: { name: '合成', cls: '现金', value: null, note: null } })])).issues[0].code).toBe('invalid_baseline')
  })

  it.each([
    { localVersion: true }, { localVersion: -1 }, { localVersion: -0 },
    { localVersion: Number.MAX_SAFE_INTEGER + 1 }, { extra: 'no-unknown-fields' },
    { legacy: { sourceKey: 'sinan_watchlist_v3', raw: '[]' } },
    { legacy: { sourceKey: 'sinan_watchlist_v1', raw: undefined } },
    { legacy: { sourceKey: 'sinan_watchlist_v1', raw: '[]', migrated: true } },
  ])('rejects unsafe local snapshot metadata: %j', patch => {
    expect(badPreview(baseline([record()]), snapshot([], patch)).issues[0].code).toBe('invalid_workspace')
  })

  it.each([
    { local_pending: undefined }, { local_pending: null }, { local_pending: 1 },
    { kind: 'manual_asset' }, { deleted: 0 }, { key: '000001:: 合成账户 ' },
    { values: { name: '合成基金', shares: undefined, cost: null, target_weight: null } },
    { values: { name: '合成基金', shares: NaN, cost: null, target_weight: null } },
    { updated_at: '2026-10-20T00:00:00Z' }, { extra: 'private-unknown-field' },
  ])('rejects unsafe local entries instead of normalizing or dropping data: %j', patch => {
    expect(() => validateOwnerWorkspaceEntries([entry(patch)])).toThrow(OwnerCloudImportError)
    expect(badPreview(baseline([record()]), snapshot([entry(patch)])).issues[0].code).toBe('invalid_workspace')
  })

  it('rejects sparse/accessor/symbol/non-enumerable arrays and objects without invoking getters', () => {
    const getter = vi.fn(() => 'do-not-call')
    const source = { ...entry() }
    Object.defineProperty(source, 'key', { get: getter, enumerable: true })
    expect(() => validateOwnerWorkspaceEntries([source])).toThrow(OwnerCloudImportError)
    expect(getter).not.toHaveBeenCalled()
    const arrayGetter = [entry()]
    Object.defineProperty(arrayGetter, '0', { get: getter, enumerable: true })
    expect(() => validateOwnerWorkspaceEntries(arrayGetter)).toThrow(OwnerCloudImportError)
    expect(getter).not.toHaveBeenCalled()
    expect(() => validateOwnerWorkspaceEntries([, entry()])).toThrow(OwnerCloudImportError)
    const symbol = Object.assign([entry()], { [Symbol('hidden')]: 'secret' })
    expect(() => validateOwnerWorkspaceEntries(symbol)).toThrow(OwnerCloudImportError)
    const nonEnumerable = { ...entry() }
    Object.defineProperty(nonEnumerable, 'key', { value: entry().key, enumerable: false })
    expect(() => validateOwnerWorkspaceEntries([nonEnumerable])).toThrow(OwnerCloudImportError)
    expect(() => validateOwnerWorkspaceEntries([entry(), entry()])).toThrow(OwnerCloudImportError)
    const badBaseline = baseline([record()])
    Object.defineProperty(badBaseline, 'pulledRevision', { get: getter, enumerable: true })
    badPreview(badBaseline)
    expect(getter).not.toHaveBeenCalled()
  })

  it('preserves actual legacy source key/raw and rejects malformed scalar text', () => {
    for (const sourceKey of ['sinan_watchlist_v1', 'sinan_watchlist_v2'] as const) {
      const value = snapshot([], { legacy: { sourceKey, raw: ' [ {"synthetic":true} ] ' } })
      const result = validateOwnerWorkspaceSnapshot(value)
      expect(result.legacy).toEqual(value.legacy)
      expect(Object.isFrozen(result.legacy)).toBe(true)
      expect(result).not.toBe(value)
    }
    expect(() => validateOwnerWorkspaceSnapshot(snapshot([], { legacy: { sourceKey: 'sinan_watchlist_v1', raw: '\ud800' } }))).toThrow(OwnerCloudImportError)
  })

  it('rejects count/UTF8 capacity without truncation or relaxing manual exclusions', () => {
    expect(() => validateOwnerWorkspaceEntries(new Array(OWNER_WORKSPACE_MAX_ENTRIES + 1))).toThrow(OwnerCloudImportError)
    const many = Array.from({ length: 10_000 }, (_, index) => entry({ key: `${String(index + 1).padStart(6, '0')}::`,
      values: { name: '合'.repeat(200), shares: 0, cost: null, target_weight: null } }))
    expect(() => validateOwnerWorkspaceEntries(many)).toThrowError(expect.objectContaining({ code: 'capacity_exceeded' }))
    expect(badPreview(baseline(new Array(OWNER_WORKSPACE_MAX_ENTRIES + 1))).issues[0].code).toBe('capacity_exceeded')
    const largeRaw = '合'.repeat(Math.floor(OWNER_WORKSPACE_MAX_IMAGE_BYTES / 3) + 1)
    expect(() => validateOwnerWorkspaceSnapshot(snapshot([], { legacy: { sourceKey: 'sinan_watchlist_v2', raw: largeRaw } }))).toThrowError(expect.objectContaining({ code: 'capacity_exceeded' }))
  })
})

describe('full-image plan validation and exact hashing', () => {
  it('clones and freezes the closed plan, canonicalizes object fields but preserves array order and signed zero', async () => {
    const source = plan(), original = JSON.stringify(source)
    const normalized = validateOwnerCloudImportPlan(source, TARGET)
    expect(normalized).toEqual(source)
    expect(normalized).not.toBe(source)
    expect(Object.isFrozen(normalized.postimage[0].values)).toBe(true)
    expect(JSON.stringify(source)).toBe(original)
    const raw = canonicalOwnerCloudImportPlan(source, TARGET)
    expect(await hashOwnerCloudImportPlan(source, TARGET)).toBe(sha(raw))
    const changed = { ...source, excludedManualAssets: 1 }
    expect(await hashOwnerCloudImportPlan(changed)).not.toBe(await hashOwnerCloudImportPlan(source))
    expect(await hashOwnerCloudImportPlan({ ...source, postimage: [entry({ values: { name: '合成基金', shares: -0, cost: null, target_weight: null } })] })).not.toBe(await hashOwnerCloudImportPlan(source))
    expect(canonicalOwnerWorkspaceEntries([entry({ values: { name: '合成基金', shares: -0, cost: null, target_weight: null } })])).toContain('"shares":-0')
  })

  it.each([
    { schema: 'other' }, { pulledRevision: 0 }, { pulledRevision: true }, { excludedManualAssets: -1 },
    { extra: 'private-invalid-plan' }, { targetFingerprint: 'A'.repeat(64) },
    { targetFingerprint: TARGET + '\n' }, { postimage: [] },
    { postimage: [entry({ local_pending: false })] },
    { preimage: [entry()], postimage: [entry()] },
  ])('rejects invalid/no-op/tampered import plans: %j', patch => {
    expect(() => validateOwnerCloudImportPlan({ ...plan(), ...patch }, TARGET)).toThrow(OwnerCloudImportError)
  })

  it('rejects target substitution and whole-image old-record edits/deletes/reorders/pending clears', () => {
    expect(() => validateOwnerCloudImportPlan(plan(), 'b'.repeat(64))).toThrowError(expect.objectContaining({ code: 'target_mismatch' }))
    const old = [entry(), entry({ key: '000003::本机' })], added = entry({ key: '000002::新增' })
    for (const postimage of [[old[1], old[0], added], [old[0], added],
      [{ ...old[0], local_pending: false }, old[1], added],
      [{ ...old[0], deleted: true }, old[1], added],
      [{ ...old[0], values: { ...old[0].values, cost: 0 } }, old[1], added]]) {
      expect(() => validateOwnerCloudImportPlan({ ...plan(), preimage: old, postimage })).toThrow(OwnerCloudImportError)
    }
    expect(validateOwnerCloudImportPlan({ ...plan(), preimage: old, postimage: [...old, added] }).postimage).toEqual([...old, added])
  })

  it('reports unavailable digest without exposing input and does no storage/network/timer work', async () => {
    const forbidden = vi.fn(() => { throw new Error('no IO') })
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden, removeItem: forbidden })
    vi.stubGlobal('indexedDB', { open: forbidden })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const preview = buildCloudImportPreview(baseline([record()]), snapshot(), TARGET)
    expect(preview.plan).not.toBeNull()
    expect(forbidden).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('private driver failure')) } })
    await expect(hashOwnerCloudImportPlan(plan())).rejects.toMatchObject({ code: 'hash_unavailable', message: 'Owner cloud import rejected' })
  })
})
