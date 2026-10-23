import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncRecord } from './ownerSyncContract'
import { buildOwnerSyncRequest, restoreOwnerSyncRequest, OWNER_SYNC_MAX_BODY_BYTES, OWNER_SYNC_MAX_RESPONSE_BYTES } from './ownerSyncContract'
import {
  OWNER_WORKSPACE_MAX_ENTRIES, OWNER_WORKSPACE_MAX_IMAGE_BYTES,
  type OwnerWorkspaceEntry, type OwnerWorkspaceSnapshot,
} from './owner-cloud-import'
import {
  buildOwnerWorkspaceCloudLinkPreview, OwnerWorkspaceSyncError,
  planOwnerWorkspaceCloudIntent, validateOwnerWorkspaceCloudBaseline,
} from './owner-workspace-sync'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const KEY = '000001::synthetic-account'
const PRIVATE = 'synthetic-private-never-echo'
const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
function record(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, ...patch } as OwnerSyncRecord
}
function manual(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return record({ key: 'asset:synthetic', kind: 'manual_asset',
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: 'synthetic-manual', cls: '现金', value: 0, note: null }, ...patch })
}
function entry(patch: Record<string, unknown> = {}): OwnerWorkspaceEntry {
  return { key: KEY, kind: 'holding', deleted: false,
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, local_pending: true,
    ...patch } as OwnerWorkspaceEntry
}
function baseline(records: readonly OwnerSyncRecord[] = [], pulledRevision = records.length ? 1 : 0) {
  return { pulledRevision, records }
}
function snapshot(entries: readonly OwnerWorkspaceEntry[] = [], patch: Record<string, unknown> = {}): OwnerWorkspaceSnapshot {
  return { localVersion: 7, entries, legacy: null, ...patch } as OwnerWorkspaceSnapshot
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true)
    Object.values(value).forEach(frozen)
  }
}
function rejected(value: unknown, code = 'invalid_baseline'): void {
  expect(() => validateOwnerWorkspaceCloudBaseline(value)).toThrow(OwnerWorkspaceSyncError)
  try { validateOwnerWorkspaceCloudBaseline(value); expect.fail('accepted invalid input') }
  catch (error) {
    expect(error).toMatchObject({ code, message: 'Owner workspace sync input rejected' })
    expect(String(error)).not.toContain(PRIVATE)
  }
}

describe('closed complete common cloud baseline', () => {
  it('copies every manual asset/tombstone/revision without normalizing zero or freezing input', () => {
    const input = baseline([record({ values: { name: 'synthetic-fund', shares: -0, cost: null, target_weight: 0 } }),
      manual(), manual({ key: 'asset:deleted', deleted: true, record_revision: 4, lifecycle_revision: 3,
        field_revisions: { name: 1, cls: 2, value: 4, note: 3 },
        values: { name: 'old-manual', cls: '权益', value: 0, note: 'preserve me' } })], 4)
    const result = validateOwnerWorkspaceCloudBaseline(input)
    expect(result).toEqual(input)
    expect(Object.is(result.records[0].values.shares, -0)).toBe(true)
    expect(result.records[2]).toMatchObject({ deleted: true, lifecycle_revision: 3,
      field_revisions: { name: 1, cls: 2, value: 4, note: 3 }, values: { note: 'preserve me' } })
    frozen(result)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(input.records[2].values)).toBe(false)
    ;(input.records[2].values as Record<string, unknown>).note = 'changed source'
    expect(result.records[2].values.note).toBe('preserve me')
  })

  it('accepts an empty zero head and native null-prototype closed objects', () => {
    expect(validateOwnerWorkspaceCloudBaseline(baseline())).toEqual({ pulledRevision: 0, records: [] })
    const input = Object.assign(Object.create(null), baseline([record()]))
    expect(validateOwnerWorkspaceCloudBaseline(input).records).toHaveLength(1)
  })

  it.each([
    null, [], new Date(), { revision: 1, records: [record()] },
    { upper_revision: 1, changes: [record()], next_cursor: null, complete: true },
    { pulledRevision: 1, records: [] }, { pulledRevision: 2, records: [record()] },
    { pulledRevision: 0, records: [record()] }, { pulledRevision: -0, records: [] },
    { pulledRevision: true, records: [] }, { pulledRevision: -1, records: [] },
    { pulledRevision: 0.5, records: [] }, { pulledRevision: Number.MAX_SAFE_INTEGER + 1, records: [] },
    { pulledRevision: 1, records: [record(), record()] },
    { pulledRevision: 1, records: [record()], private: PRIVATE },
    { pulledRevision: 1, records: [record({ record_revision: 0 })] },
    { pulledRevision: 1, records: [record({ lifecycle_revision: 2 })] },
    { pulledRevision: 1, records: [record({ field_revisions: { name: 2, shares: 1, cost: 1, target_weight: 1 } })] },
    { pulledRevision: 1, records: [record({ deleted: 1 })] },
    { pulledRevision: 1, records: [record({ key: '000001:: synthetic-account ' })] },
    { pulledRevision: 1, records: [record({ values: { name: 'bad', shares: 0, cost: null } })] },
    { pulledRevision: 1, records: [manual({ values: { name: 'manual', cls: '现金', value: null, note: null } })] },
  ])('rejects incomplete/page/POST/unsafe/extra/invalid record input: %j', input => rejected(input))

  it('rejects getters, symbols, hidden fields, exotic/sparse/extra/accessor arrays without invoking getters', () => {
    let calls = 0
    rejected({ get pulledRevision() { calls++; return 1 }, records: [record()] })
    const accessorRecord = { ...record(), get values() { calls++; return record().values } }
    rejected(baseline([accessorRecord]))
    const hidden = baseline([record()])
    Object.defineProperty(hidden, 'private', { value: PRIVATE })
    rejected(hidden)
    rejected({ ...baseline([record()]), [Symbol('private')]: PRIVATE })
    class Rows extends Array<OwnerSyncRecord> {}
    const extra = [record()] as OwnerSyncRecord[] & { private?: string }; extra.private = PRIVATE
    const accessor = [record()]
    Object.defineProperty(accessor, '0', { get() { calls++; return record() }, enumerable: true })
    for (const records of [new Rows(record()), Array(1), extra, accessor]) rejected({ pulledRevision: 1, records })
    expect(calls).toBe(0)
  })

  it('does not echo or execute getters on arbitrary thrown error objects from exotic input traps', () => {
    let calls = 0
    const throwable = new OwnerWorkspaceSyncError('invalid_baseline')
    Object.defineProperty(throwable, 'code', { get() { calls++; throw new Error(PRIVATE) } })
    const exotic = new Proxy({}, { getPrototypeOf() { throw throwable } })
    rejected(exotic)
    expect(planOwnerWorkspaceCloudIntent(baseline(), exotic)).toEqual({ operations: [],
      issues: [{ code: 'invalid_workspace', key: null }] })
    expect(calls).toBe(0)
  })

  it('bounds the full UTF8 envelope at 2 MiB, accepting exact boundary and rejecting plus one', () => {
    const records = Array.from({ length: 1000 }, (_, index) => manual({ key: 'asset:capacity-' + index,
      values: { name: 'manual', cls: '现金', value: 0, note: '' } }))
    const input = baseline(records)
    let remaining = OWNER_SYNC_MAX_RESPONSE_BYTES - utf8(input)
    for (const row of records) {
      const length = Math.min(2000, remaining)
      ;(row.values as Record<string, unknown>).note = 'x'.repeat(length)
      remaining -= length
    }
    expect(remaining).toBe(0)
    expect(utf8(input)).toBe(OWNER_SYNC_MAX_RESPONSE_BYTES)
    expect(validateOwnerWorkspaceCloudBaseline(input).records).toHaveLength(1000)
    const room = records.find(row => (row.values.note as string).length < 2000)!
    ;(room.values as Record<string, unknown>).note += 'x'
    rejected(input, 'capacity_exceeded')
  })

  it('checks UTF8 bytes, not JS units, and rejects the 100001-row boundary before iterating', () => {
    const records = Array.from({ length: 400 }, (_, index) => manual({ key: 'asset:utf8-' + index,
      values: { name: 'manual', cls: '现金', value: 0, note: '中'.repeat(2000) } }))
    expect(JSON.stringify(baseline(records)).length).toBeLessThan(OWNER_SYNC_MAX_RESPONSE_BYTES)
    rejected(baseline(records), 'capacity_exceeded')
    rejected({ pulledRevision: 0, records: Array(OWNER_WORKSPACE_MAX_ENTRIES + 1) }, 'capacity_exceeded')
  })
})

describe('only applied common B to local L intent', () => {
  it('sends only changed fields and their B values plus lifecycle guards, never newly observed C values', () => {
    const applied = baseline([record()])
    const observedC = baseline([record({ record_revision: 2, values: { name: 'other-device-name', shares: 99, cost: null, target_weight: null } })], 2)
    const local = snapshot([entry({ values: { name: 'synthetic-fund', shares: 0, cost: 4, target_weight: 0 } })])
    const input = JSON.stringify({ applied, observedC, local })
    const result = planOwnerWorkspaceCloudIntent(applied, local)
    expect(result.issues).toEqual([])
    expect(result.operations).toEqual([{ key: KEY, kind: 'holding', deleted: false,
      changes: { cost: 4, target_weight: 0 }, base_values: { kind: 'holding', deleted: false, cost: null, target_weight: null } }])
    expect(result.operations[0].base_values).not.toHaveProperty('shares')
    expect(result.operations[0].base_values).not.toHaveProperty('name')
    expect(JSON.stringify({ applied, observedC, local })).toBe(input)
    frozen(result)
  })

  it('does not send manual assets or treat local_pending/versions/legacy text as intent', () => {
    const base = baseline([record(), manual()])
    expect(planOwnerWorkspaceCloudIntent(baseline([manual()]), snapshot())).toEqual({ operations: [], issues: [] })
    for (const pending of [true, false]) {
      const result = planOwnerWorkspaceCloudIntent(base, snapshot([entry({ local_pending: pending })], {
        localVersion: 999, legacy: { sourceKey: 'sinan_watchlist_v2', raw: '["different-time-not-business"]' },
      }))
      expect(result).toEqual({ operations: [], issues: [] })
    }
  })

  it.each([true, false])('blocks missing linked fund records (deleted=%s), never interprets absence as a delete', deleted => {
    const result = planOwnerWorkspaceCloudIntent(baseline([manual(), record({ deleted })]),
      snapshot([entry({ key: '000002::new-local' })]))
    expect(result).toEqual({ operations: [], issues: [{ code: 'missing_workspace_record', key: KEY }] })
    frozen(result)
  })

  it('preserves null versus zero and ignores only the backend-defined numeric zero-sign business equivalence', () => {
    const base = baseline([record({ values: { name: 'synthetic-fund', shares: -0, cost: 0, target_weight: null } })])
    const local = snapshot([entry({ values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: 0 } })])
    const result = planOwnerWorkspaceCloudIntent(base, local)
    expect(result.operations[0].changes).toEqual({ cost: null, target_weight: 0 })
    expect(result.operations[0].base_values).toEqual({ kind: 'holding', deleted: false, cost: 0, target_weight: null })
    expect(Object.is(base.records[0].values.shares, -0)).toBe(true)
    expect(Object.is(local.entries[0].values.shares, 0)).toBe(true)
  })

  it('preserves a negative-zero B guard while the existing exact wire restore normalizes only the packet DTO', async () => {
    const base = baseline([record({ values: { name: 'synthetic-fund', shares: 0, cost: -0, target_weight: null } })])
    const local = snapshot([entry()])
    const result = planOwnerWorkspaceCloudIntent(base, local)
    expect(result.operations[0].changes).toEqual({ cost: null })
    expect(Object.is(result.operations[0].base_values!.cost, -0)).toBe(true)
    const built = await buildOwnerSyncRequest({ request_id: 'synthetic-negative-zero-0001', expected_revision: 1,
      operations: result.operations })
    const restored = await restoreOwnerSyncRequest(built.rawBody, built.requestHash)
    expect(Object.is(built.request.operations[0].base_values!.cost, -0)).toBe(true)
    expect(Object.is(restored.request.operations[0].base_values!.cost, 0)).toBe(true)
    expect(restored.rawBody).toBe(built.rawBody)
    expect(restored.requestHash).toBe(built.requestHash)
    expect(Object.is(base.records[0].values.cost, -0)).toBe(true)
    expect(local.entries[0].values.cost).toBeNull()
  })

  it('creates full new input, retaining watch null/zero and distinct account identities', async () => {
    const local = snapshot([entry(), entry({ key: '000001::second', kind: 'watch',
      values: { name: 'watch', shares: null, cost: 0, target_weight: 0 } }),
    entry({ key: '000002::', kind: 'watch', values: { name: 'zero-watch', shares: 0, cost: null, target_weight: null } })])
    const result = planOwnerWorkspaceCloudIntent(baseline(), local)
    expect(result.issues).toEqual([])
    expect(result.operations).toHaveLength(3)
    expect(result.operations[0]).toEqual({ key: KEY, kind: 'holding', deleted: false,
      changes: local.entries[0].values, base_values: {} })
    expect(result.operations[1].changes).toEqual({ name: 'watch', shares: null, cost: 0, target_weight: 0 })
    expect((await buildOwnerSyncRequest({ request_id: 'synthetic-intent-0001', expected_revision: 0,
      operations: result.operations })).request.operations).toEqual(result.operations)
  })

  it('deletes with the full old image and represents account rename as tombstone plus independent creation', () => {
    const old = record({ values: { name: 'synthetic-fund', shares: 12, cost: 3, target_weight: 0 } })
    const local = snapshot([entry({ deleted: true, values: old.values }), entry({ key: '000001::renamed', values: old.values })])
    const result = planOwnerWorkspaceCloudIntent(baseline([old]), local)
    expect(result.operations).toEqual([{ key: KEY, kind: 'holding', deleted: true,
      base_values: { name: 'synthetic-fund', shares: 12, cost: 3, target_weight: 0, kind: 'holding', deleted: false } },
    { key: '000001::renamed', kind: 'holding', deleted: false, changes: old.values, base_values: {} }])
    expect(result.operations[0]).not.toHaveProperty('changes')
  })

  it.each(['watch', 'holding'] as const)('kind transition to %s uses complete old guards and full fresh values', kind => {
    const oldKind = kind === 'watch' ? 'holding' : 'watch'
    const old = record({ kind: oldKind })
    const next = entry({ kind, values: { name: 'new-kind', shares: kind === 'watch' ? null : 0, cost: null, target_weight: 0 } })
    const result = planOwnerWorkspaceCloudIntent(baseline([old]), snapshot([next]))
    expect(result.issues).toEqual([])
    expect(result.operations).toEqual([{ key: KEY, kind, deleted: false, changes: next.values,
      base_values: { ...old.values, kind: oldKind, deleted: false } }])
  })

  it('does not create/transition an unknown-share holding, but preserves unknown shares on an existing patch', () => {
    const unknown = entry({ values: { name: 'synthetic-fund', shares: null, cost: null, target_weight: null } })
    for (const base of [baseline(), baseline([record({ kind: 'watch' })])]) {
      expect(planOwnerWorkspaceCloudIntent(base, snapshot([unknown]))).toEqual({ operations: [],
        issues: [{ code: 'missing_value', key: KEY }] })
    }
    const old = record({ values: unknown.values })
    const edited = entry({ values: { ...unknown.values, name: 'rename-only' } })
    expect(planOwnerWorkspaceCloudIntent(baseline([old]), snapshot([edited])).operations).toEqual([
      { key: KEY, kind: 'holding', deleted: false, changes: { name: 'rename-only' },
        base_values: { kind: 'holding', deleted: false, name: 'synthetic-fund' } },
    ])
  })

  it('does not automatically revive a base tombstone or partially pass another valid operation', () => {
    const result = planOwnerWorkspaceCloudIntent(baseline([record({ deleted: true })]),
      snapshot([entry({ key: '000002::new' }), entry()]))
    expect(result).toEqual({ operations: [], issues: [{ code: 'cloud_tombstone', key: KEY }] })
    frozen(result)
  })

  it('noops unrepresented/new tombstones but rejects a combined deleted-kind change', () => {
    expect(planOwnerWorkspaceCloudIntent(baseline(), snapshot([entry({ deleted: true })]))).toEqual({ operations: [], issues: [] })
    expect(planOwnerWorkspaceCloudIntent(baseline([record({ deleted: true })]), snapshot([entry({ deleted: true })])))
      .toEqual({ operations: [], issues: [] })
    expect(planOwnerWorkspaceCloudIntent(baseline([record()]), snapshot([entry({ kind: 'watch', deleted: true })])))
      .toEqual({ operations: [], issues: [{ code: 'invalid_operation', key: KEY }] })
  })

  it('rejects invalid snapshots/baselines atomically without echoing arbitrary private input', () => {
    for (const [base, local, code] of [[{ ...baseline(), private: PRIVATE }, snapshot(), 'invalid_baseline'],
      [baseline(), { ...snapshot(), updated_at: PRIVATE }, 'invalid_workspace'],
      [baseline(), snapshot([entry(), entry()]), 'invalid_workspace'],
      [baseline(), snapshot([entry({ local_pending: 1 })]), 'invalid_workspace']] as const) {
      const result = planOwnerWorkspaceCloudIntent(base, local)
      expect(result).toEqual({ operations: [], issues: [{ code, key: null }] })
      expect(JSON.stringify(result)).not.toContain(PRIVATE)
    }
  })

  it('returns all 201 operations and leaves the operation bound to the real request builder', async () => {
    const local = snapshot(Array.from({ length: 201 }, (_, index) => entry({ key: String(index).padStart(6, '0') + '::' })))
    const result = planOwnerWorkspaceCloudIntent(baseline(), local)
    expect(result.issues).toEqual([])
    expect(result.operations).toHaveLength(201)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-capacity-0001', expected_revision: 0,
      operations: result.operations })).rejects.toMatchObject({ code: 'invalid_sync_request' })
  })

  it('does not trim or split a 200-row batch exceeding the real 128 KiB UTF8 packet limit', async () => {
    const cloud = Array.from({ length: 200 }, (_, index) => record({ key: String(index).padStart(6, '0') + '::' + '中'.repeat(64),
      values: { name: '中'.repeat(200), shares: 0, cost: null, target_weight: null } }))
    const local = snapshot(cloud.map(row => entry({ key: row.key, deleted: true, values: row.values })))
    const result = planOwnerWorkspaceCloudIntent(baseline(cloud), local)
    expect(result.issues).toEqual([])
    expect(result.operations).toHaveLength(200)
    expect(utf8({ request_id: 'synthetic-bytes-0001', expected_revision: 1, operations: result.operations })).toBeGreaterThan(OWNER_SYNC_MAX_BODY_BYTES)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-bytes-0001', expected_revision: 1,
      operations: result.operations })).rejects.toMatchObject({ code: 'invalid_sync_request' })
  })
})

describe('explicit all-or-nothing initial cloud link preview', () => {
  it('adds only cloud-only fund rows, retains local-only and equal full images/pending, and stores complete manual base', () => {
    const local = snapshot([entry({ local_pending: false }), entry({ key: '000003::local-only', deleted: true })],
      { legacy: { sourceKey: 'sinan_watchlist_v1', raw: '["archive with original time"]' } })
    const cloud = baseline([manual(), record({ key: '000004::tombstone', deleted: true }), record(),
      record({ key: '000002::cloud-only', kind: 'watch', values: { name: 'watch', shares: null, cost: 0, target_weight: null } }),
      manual({ key: 'asset:manual-tombstone', deleted: true })])
    const before = JSON.stringify({ cloud, local })
    const result = buildOwnerWorkspaceCloudLinkPreview(cloud, local)
    expect(result.issues).toEqual([])
    expect(result.base).toEqual(cloud)
    expect(result.snapshot.localVersion).toBe(7)
    expect(result.snapshot.legacy).toEqual(local.legacy)
    expect(result.snapshot.entries.slice(0, 2)).toEqual(local.entries)
    expect(result.snapshot.entries[0].local_pending).toBe(false)
    expect(result.addedKeys).toEqual(['000002::cloud-only', '000004::tombstone'])
    expect(result.snapshot.entries.slice(2)).toMatchObject([{ local_pending: true, kind: 'watch', values: { shares: null, cost: 0 } },
      { local_pending: true, deleted: true }])
    expect(result.snapshot.entries.some(row => row.key.startsWith('asset:'))).toBe(false)
    expect(JSON.stringify(result.snapshot)).not.toMatch(/updated_at|record_revision|holding_version|lifecycle_revision/)
    expect(JSON.stringify({ cloud, local })).toBe(before)
    frozen(result)
  })

  it.each([
    { kind: 'watch' }, { deleted: true },
    { values: { name: 'different', shares: 0, cost: null, target_weight: null } },
    { values: { name: 'synthetic-fund', shares: null, cost: null, target_weight: null } },
    { values: { name: 'synthetic-fund', shares: -0, cost: null, target_weight: null } },
    { values: { name: 'synthetic-fund', shares: 0, cost: 0, target_weight: null } },
  ])('blocks all additions on any same-key full business difference: %j', patch => {
    const local = snapshot([entry(patch)])
    const result = buildOwnerWorkspaceCloudLinkPreview(baseline([record({ key: '000002::new' }), record()]), local)
    expect(result.issues).toEqual([{ code: 'same_key_difference', key: KEY }])
    expect(result.addedKeys).toEqual([])
    expect(result.snapshot).toEqual(local)
    expect(result.base.records).toHaveLength(2)
  })

  it('keeps exactly equal tombstones as noop but blocks both tombstone/live directions', () => {
    const old = entry({ deleted: true, local_pending: false })
    const same = buildOwnerWorkspaceCloudLinkPreview(baseline([record({ deleted: true })]), snapshot([old]))
    expect(same.issues).toEqual([])
    expect(same.snapshot.entries).toEqual([old])
    expect(same.addedKeys).toEqual([])
    for (const [cloudDeleted, localDeleted] of [[true, false], [false, true]]) {
      const result = buildOwnerWorkspaceCloudLinkPreview(baseline([record({ deleted: cloudDeleted })]),
        snapshot([entry({ deleted: localDeleted })]))
      expect(result.issues).toEqual([{ code: 'same_key_difference', key: KEY }])
      expect(result.addedKeys).toEqual([])
    }
  })

  it('can link an empty or manual-only baseline without inventing fund imports or local mutations', () => {
    const local = snapshot([entry()])
    for (const cloud of [baseline(), baseline([manual()])]) {
      const result = buildOwnerWorkspaceCloudLinkPreview(cloud, local)
      expect(result).toEqual({ base: cloud, snapshot: local, issues: [], addedKeys: [] })
      frozen(result)
    }
  })

  it('rejects malformed input instead of fabricating an empty base or local snapshot', () => {
    expect(() => buildOwnerWorkspaceCloudLinkPreview(null, snapshot())).toThrow(OwnerWorkspaceSyncError)
    expect(() => buildOwnerWorkspaceCloudLinkPreview(baseline(), null)).toThrow(OwnerWorkspaceSyncError)
  })

  it('keeps original local snapshot on merged image capacity failure, without accepting a partial cloud subset', () => {
    const entries = Array.from({ length: 6500 }, (_, index) => entry({ key: String(index).padStart(6, '0') + '::',
      values: { name: 'f', shares: 0, cost: null, target_weight: null } }))
    let remaining = OWNER_WORKSPACE_MAX_IMAGE_BYTES - utf8(entries)
    for (const row of entries) {
      const count = Math.min(199, remaining)
      ;(row.values as unknown as Record<string, unknown>).name += 'x'.repeat(count)
      remaining -= count
    }
    expect(remaining).toBe(0)
    expect(utf8(entries)).toBe(OWNER_WORKSPACE_MAX_IMAGE_BYTES)
    const local = snapshot(entries)
    const result = buildOwnerWorkspaceCloudLinkPreview(baseline([record({ key: '999999::new' })]), local)
    expect(result.issues).toEqual([{ code: 'capacity_exceeded', key: null }])
    expect(result.snapshot).toEqual(local)
    expect(result.addedKeys).toEqual([])
  })
})
