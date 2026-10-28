import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncRecord } from './ownerSyncContract'
import { buildOwnerSyncRequest, OWNER_SYNC_MAX_BODY_BYTES } from './ownerSyncContract'
import type { OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from './owner-cloud-import'
import type { OwnerPortfolioLocal, OwnerPortfolioManual } from './ownerPortfolioLocal'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import {
  emptyOwnerPortfolioSyncMetadata, planOwnerPortfolioCloudIntent, validateOwnerPortfolioSyncMetadata,
  type OwnerPortfolioSyncMetadata, type OwnerPortfolioSyncMetadataContext,
} from './owner-portfolio-sync'

const TARGET = 'a'.repeat(64), ADOPTION_ID = 'synthetic-adoption-0001', ADOPTION_HASH = 'b'.repeat(64)
const KEY = '000001::synthetic-account', ASSET = 'asset:synthetic-manual'
const RAW = '{"request_id":"synthetic-request-0001","expected_revision":1,"operations":[]}'
const PRIVATE = 'synthetic-private-never-echo'
function fund(patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, ...patch }
}
function manual(patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return fund({ key: ASSET, kind: 'manual_asset', field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: 'synthetic-manual', cls: '现金', value: 0, note: null }, ...patch })
}
function entry(patch: Partial<OwnerWorkspaceEntry> = {}): OwnerWorkspaceEntry {
  return { key: KEY, kind: 'holding', deleted: false, local_pending: true,
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, ...patch }
}
function asset(patch: Partial<OwnerPortfolioManual> = {}): OwnerPortfolioManual {
  return { key: ASSET, legacyId: null, deleted: false, updated_at: null, local_pending: true,
    values: { name: 'synthetic-manual', cls: '现金', value: 0, note: null }, ...patch }
}
function base(records: readonly OwnerSyncRecord[] = []) { return { pulledRevision: records.length ? Math.max(...records.map(row => row.record_revision)) : 0, records } }
function snapshot(entries: readonly OwnerWorkspaceEntry[] = []): OwnerWorkspaceSnapshot { return { localVersion: 4, entries, legacy: null } }
function portfolio(manualRows: readonly OwnerPortfolioManual[] = []): OwnerPortfolioLocal {
  return { schema: 'owner-portfolio-local-1', manual: manualRows, history: [],
    migration: { manualRaw: null, snapshotsRaw: null, sourceSha256: '0'.repeat(64), idMappings: [] } }
}
function linked(): OwnerPortfolioSyncMetadata {
  return { schema: 'owner-portfolio-sync-1', profile: 'fund-manual-1', targetFingerprint: TARGET, epoch: 1,
    base: base([fund(), manual({ deleted: true })]), pending: null,
    recentReceipt: { id: 'synthetic-link-0001', hash: 'c'.repeat(64), operation: 'link', syncEpoch: 1, outboxVersion: 2, localVersion: 4 } }
}
function prepared(): OwnerPortfolioSyncMetadata {
  return { ...linked(), epoch: 2, pending: { requestId: 'synthetic-request-0001', requestHash: 'd'.repeat(64),
    rawBody: RAW, preimageHash: 'e'.repeat(64), preparationHash: 'f'.repeat(64), adoptionId: ADOPTION_ID,
    adoptionHash: ADOPTION_HASH, localVersion: 4, preparedOutboxVersion: 6, baseRevision: 1 } }
}
function context(value: OwnerPortfolioSyncMetadata = prepared()): OwnerPortfolioSyncMetadataContext {
  return { snapshot: snapshot(), metadata: { schema: 'owner-workspace-local-1', adoption: { id: ADOPTION_ID,
    hash: ADOPTION_HASH, backupSha256: '9'.repeat(64), localVersion: 4,
    sourceArchive: { sourceKey: null, v1Raw: null, v2Raw: null } }, displayTimes: [], recentEdit: null, restoredArchives: [] },
  outbox: { version: 7, entry: value.pending === null ? null : { schema: 'owner-sync-outbox-1', state: 'prepared',
    rawBody: value.pending.rawBody, requestHash: value.pending.requestHash } } }
}
function mutate<T>(value: T, action: (copy: any) => void): T { const copy = structuredClone(value); action(copy); return copy }
function frozen(value: unknown): void {
  if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen) }
}
function rejected(value: unknown, current?: OwnerPortfolioSyncMetadataContext, code = 'invalid_metadata') {
  expect(() => validateOwnerPortfolioSyncMetadata(value, TARGET, current)).toThrow(expect.objectContaining({ code }))
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('independent complete manual sync active metadata', () => {
  it('starts solely at the closed unlinked epoch0 and does not promote a v4 shape', () => {
    const empty = emptyOwnerPortfolioSyncMetadata(TARGET)
    expect(empty).toEqual({ schema: 'owner-portfolio-sync-1', profile: 'fund-manual-1', targetFingerprint: TARGET,
      epoch: 0, base: null, pending: null, recentReceipt: null })
    expect(validateOwnerPortfolioSyncMetadata(empty, TARGET, context(empty))).toEqual(empty); frozen(empty)
    const { profile: _profile, ...old } = linked()
    rejected({ ...old, schema: 'owner-workspace-sync-1' })
    rejected({ ...linked(), profile: 'fund-only-1' }); rejected(old)
  })
  it('copies and freezes full manual/tombstone/revision/negative-zero B and exact original packet bindings', () => {
    const input = prepared()
    ;(input.base!.records[0].values as any).shares = -0
    const before = canonicalOwnerLocal(input), result = validateOwnerPortfolioSyncMetadata(input, TARGET, context(input))
    expect(result).toEqual(input); expect(result).not.toBe(input); expect(result.base).not.toBe(input.base)
    expect(Object.is(result.base!.records[0].values.shares, -0)).toBe(true)
    expect(result.base!.records[1]).toEqual(manual({ deleted: true })); expect(result.pending!.rawBody).toBe(RAW)
    expect(new Set([result.pending!.requestHash, result.pending!.preimageHash, result.pending!.preparationHash]).size).toBe(3)
    expect(canonicalOwnerLocal(input)).toBe(before); expect(Object.isFrozen(input)).toBe(false); frozen(result)
    ;(input.pending as any).rawBody += 'changed'; expect(result.pending!.rawBody).toBe(RAW)
  })
  it('accepts complete empty head0 and the same original pending in every controlled delivery state', () => {
    const empty = { ...linked(), base: base() }
    expect(validateOwnerPortfolioSyncMetadata(empty, TARGET, context(empty)).base).toEqual(base())
    for (const state of ['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const) {
      const row = prepared(), current = context(row)
      expect(validateOwnerPortfolioSyncMetadata(row, TARGET, { ...current,
        outbox: { version: 20, entry: { ...current.outbox.entry!, state } } })).toEqual(row)
    }
  })
  it.each(['link', 'cancel', 'ack'] as const)('retains old receipt operation %s with exact reachable epoch relation', operation => {
    const row = { ...linked(), epoch: 3, recentReceipt: { ...linked().recentReceipt!, operation, syncEpoch: 3, outboxVersion: 7 } }
    expect(validateOwnerPortfolioSyncMetadata(row, TARGET, context(row))).toEqual(row)
    const next = { ...row, epoch: 4, pending: { ...prepared().pending!, preparedOutboxVersion: 9 } }
    const current = context(next)
    expect(validateOwnerPortfolioSyncMetadata(next, TARGET, { ...current, outbox: { ...current.outbox, version: 10 } })).toEqual(next)
  })
  it.each([
    ['no base with epoch', (row: any) => { row.base = null }],
    ['base epoch0', (row: any) => { row.epoch = 0 }], ['no receipt', (row: any) => { row.recentReceipt = null }],
    ['pending in epoch1', (row: any) => { row.epoch = 1 }], ['skipped epoch', (row: any) => { row.epoch = 3 }],
    ['same epoch receipt', (row: any) => { row.recentReceipt.syncEpoch = 2 }],
    ['empty retains prior receipt', (row: any) => { row.pending = null }],
    ['slot before receipt', (row: any) => { row.pending.preparedOutboxVersion = 2 }],
    ['local before receipt', (row: any) => { row.pending.localVersion = 3 }],
    ['wrong B', (row: any) => { row.pending.baseRevision = 0 }],
    ['unclosed pending', (row: any) => { row.pending.portfolioHash = '0'.repeat(64) }],
    ['unclosed receipt', (row: any) => { row.recentReceipt.confirmedRevision = 1 }],
    ['unclosed root', (row: any) => { row.codec = true }],
    ['partial base', (row: any) => { row.base.pulledRevision = 2 }],
  ])('rejects unreachable or nonclosed full metadata: %s', (_label, action) => rejected(mutate(prepared(), action)))
  it.each(['epoch', 'pending', 'recentReceipt'] as const)('base=null cannot carry %s claims', field => {
    const value: any = emptyOwnerPortfolioSyncMetadata(TARGET)
    rejected({ ...value, [field]: field === 'epoch' ? 1 : field === 'pending' ? prepared().pending : linked().recentReceipt })
  })
  it.each(['epoch', 'pending.localVersion', 'pending.preparedOutboxVersion', 'pending.baseRevision',
    'recentReceipt.syncEpoch', 'recentReceipt.localVersion', 'recentReceipt.outboxVersion'])('rejects invalid counters %s', path => {
    for (const value of [-0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, true, '1', new Number(1)]) {
      rejected(mutate(prepared(), row => { const [group, field] = path.split('.'); if (field) row[group][field] = value; else row[group] = value }))
    }
  })
  it.each(['targetFingerprint', 'pending.requestHash', 'pending.preimageHash', 'pending.preparationHash', 'pending.adoptionHash', 'recentReceipt.hash'])
    ('rejects malformed hash %s', path => {
      for (const value of ['a'.repeat(63), 'A'.repeat(64), 'a'.repeat(64) + '\n', new String('a'.repeat(64)), false]) {
        rejected(mutate(prepared(), row => { const [group, field] = path.split('.'); if (field) row[group][field] = value; else row[group] = value }))
      }
    })
  it.each(['pending.requestId', 'pending.adoptionId', 'recentReceipt.id'])('retains strict original id grammar %s', path => {
    for (const value of ['short-1', '_invalid-0001', 'contains space', 'a'.repeat(129), 'valid-id-0001\n', new String('valid-id-0001')]) {
      rejected(mutate(prepared(), row => { const [group, field] = path.split('.'); row[group][field] = value }))
    }
  })
  it.each(['adoption', 'adoption.id', 'adoption.hash', 'localVersion', 'slot.empty', 'slot.version', 'slot.body', 'slot.hash', 'receipt.localVersion', 'receipt.outboxVersion'])
    ('binds current adoption, snapshot and slot: %s', field => {
      const value: any = prepared(), current: any = context(value)
      if (field === 'adoption') current.metadata.adoption = null
      else if (field === 'adoption.id') current.metadata.adoption.id = 'different-adoption-0001'
      else if (field === 'adoption.hash') current.metadata.adoption.hash = '0'.repeat(64)
      else if (field === 'localVersion') { current.snapshot.localVersion = 5; current.metadata.adoption.localVersion = 5 }
      else if (field === 'slot.empty') current.outbox.entry = null
      else if (field === 'slot.version') current.outbox.version = 5
      else if (field === 'slot.body') current.outbox.entry.rawBody += ' '
      else if (field === 'slot.hash') current.outbox.entry.requestHash = '0'.repeat(64)
      else if (field === 'receipt.localVersion') value.recentReceipt.localVersion = 5
      else value.recentReceipt.outboxVersion = 8
      rejected(value, current)
    })
  it.each(['root', 'pending', 'receipt', 'context', 'slot', 'entry'] as const)('rejects unsafe descriptors and prototypes in %s without getter invocation', level => {
    for (const attack of ['getter', 'hidden', 'symbol', 'prototype']) {
      const value: any = prepared(), current: any = context(value)
      const object = level === 'root' ? value : level === 'pending' ? value.pending : level === 'receipt' ? value.recentReceipt
        : level === 'context' ? current : level === 'slot' ? current.outbox : current.outbox.entry
      const getter = vi.fn(() => { throw new Error('getter must stay uncalled') })
      if (attack === 'getter') Object.defineProperty(object, Object.keys(object)[0], { get: getter, enumerable: true })
      else if (attack === 'hidden') Object.defineProperty(object, 'hidden', { value: true })
      else if (attack === 'symbol') object[Symbol('private')] = true
      else Object.setPrototypeOf(object, { inherited: true })
      rejected(value, current); expect(getter).not.toHaveBeenCalled()
    }
  })
  it('bounds original UTF8 packet strings and retains scalar original bytes at exactly128KiB', () => {
    for (const rawBody of ['', '\ud800', '\udc00']) rejected(mutate(prepared(), row => { row.pending.rawBody = rawBody }))
    for (const rawBody of ['x'.repeat(128 * 1024 + 1), '中'.repeat(50_000)]) {
      rejected(mutate(prepared(), row => { row.pending.rawBody = rawBody }), undefined, 'capacity_exceeded')
    }
    const value = mutate(prepared(), row => { row.pending.rawBody = 'x'.repeat(128 * 1024) })
    expect(validateOwnerPortfolioSyncMetadata(value, TARGET, context(value)).pending!.rawBody).toBe(value.pending!.rawBody)
  })
  it('retains full baseline capacity bounds without dropping manual tombstones to make validation fit', () => {
    const records = Array.from({ length: 1100 }, (_, index) => manual({ key: 'asset:capacity-' + index,
      deleted: true, values: { ...manual().values, note: 'x'.repeat(2000) } }))
    rejected({ ...linked(), base: base(records) }, undefined, 'capacity_exceeded')
    expect(records).toHaveLength(1100)
  })
  it.each(['hole', 'getter', 'hidden-index', 'symbol', 'prototype'])('rejects unsafe complete baseline arrays: %s', attack => {
    const value: any = prepared(), rows = value.base.records
    const getter = vi.fn(() => { throw new Error('record getter must stay uncalled') })
    if (attack === 'hole') delete rows[0]
    else if (attack === 'getter') Object.defineProperty(rows, '0', { get: getter, enumerable: true })
    else if (attack === 'hidden-index') Object.defineProperty(rows, '0', { value: rows[0], enumerable: false })
    else if (attack === 'symbol') rows[Symbol('extra')] = true
    else Object.setPrototypeOf(rows, Object.create(Array.prototype))
    rejected(value); expect(getter).not.toHaveBeenCalled()
  })
  it('has no crypto/clock/network/storage side effects or false synchronous original-body hash claims', () => {
    const forbidden = vi.fn(() => { throw new Error('external IO forbidden') })
    vi.stubGlobal('crypto', { subtle: { digest: forbidden } }); vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    vi.spyOn(Date, 'now').mockImplementation(forbidden)
    const value = mutate(prepared(), row => { row.pending.rawBody = '{"request_id":"different-0001","request_id":"duplicate-0001"}' })
    expect(validateOwnerPortfolioSyncMetadata(value, TARGET, context(value))).toEqual(value)
    expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('full applied common-base fund and manual intent', () => {
  it('noops equal full images without altering null, signed zero, original times, immutable history or local provenance', () => {
    const cloud = base([fund({ values: { ...fund().values, shares: -0 } }), manual({ values: { ...manual().values, value: -0 } })])
    const local = snapshot([entry()]), assets = portfolio([asset({ updated_at: '2026-10-25T00:00:00Z' })])
    const before = canonicalOwnerLocal({ cloud, local, assets })
    const result = planOwnerPortfolioCloudIntent(cloud, local, assets)
    expect(result).toEqual({ operations: [], issues: [] }); frozen(result)
    expect(canonicalOwnerLocal({ cloud, local, assets })).toBe(before)
    expect(Object.is(cloud.records[0].values.shares, -0)).toBe(true)
    expect(Object.is(cloud.records[1].values.value, -0)).toBe(true)
    expect(Object.isFrozen(local)).toBe(false); expect(Object.isFrozen(assets)).toBe(false)
  })
  it.each(['name', 'cls', 'value', 'note'] as const)('patches only edited manual field %s and guards that field plus kind/deleted', field => {
    const values = { ...asset().values, [field]: field === 'name' ? 'new-name' : field === 'cls' ? '权益' : field === 'value' ? 17 : '  original spacing  ' }
    const result = planOwnerPortfolioCloudIntent(base([manual()]), snapshot(), portfolio([asset({ values })]))
    expect(result.issues).toEqual([])
    expect(result.operations).toEqual([{ key: ASSET, kind: 'manual_asset', deleted: false,
      changes: { [field]: values[field] }, base_values: { kind: 'manual_asset', deleted: false, [field]: manual().values[field] } }])
  })
  it('covers all four manual fields and fund fields in one complete B→L plan, retaining explicit null and untrimmed strings', async () => {
    const assets = portfolio([asset({ values: { name: '  manual  ', cls: '商品', value: 0, note: '' } })])
    const local = snapshot([entry({ values: { name: 'changed fund', shares: null, cost: 0, target_weight: 0 } })])
    const result = planOwnerPortfolioCloudIntent(base([fund(), manual({ values: { ...manual().values, value: 1 } })]), local, assets)
    expect(result.operations).toEqual([
      { key: KEY, kind: 'holding', deleted: false, changes: local.entries[0].values,
        base_values: { ...fund().values, kind: 'holding', deleted: false } },
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: assets.manual[0].values,
        base_values: { ...manual().values, value: 1, kind: 'manual_asset', deleted: false } },
    ])
    const built = await buildOwnerSyncRequest({ request_id: 'synthetic-both-0001', expected_revision: 1, operations: result.operations })
    expect(built.request.operations).toEqual(result.operations)
  })
  it('creates fresh manual with all four values and independent fund with explicit zero, never a made-up cloud revision', () => {
    const result = planOwnerPortfolioCloudIntent(base(), snapshot([entry()]), portfolio([asset()]))
    expect(result.operations).toEqual([
      { key: KEY, kind: 'holding', deleted: false, changes: entry().values, base_values: {} },
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: asset().values, base_values: {} },
    ])
    expect(JSON.stringify(result)).not.toMatch(/record_revision|local_pending|updated_at|legacyId/)
  })
  it('deletes manual and fund with the complete old guard, not edited local values or sparse guards', async () => {
    const previous = manual({ values: { name: 'previous', cls: '权益', value: -0, note: 'retain old note' } })
    const result = planOwnerPortfolioCloudIntent(base([fund(), previous]), snapshot([entry({ deleted: true })]),
      portfolio([asset({ deleted: true, values: { ...asset().values, name: 'local ignored on delete' } })]))
    expect(result.operations).toEqual([
      { key: KEY, kind: 'holding', deleted: true, base_values: { ...fund().values, kind: 'holding', deleted: false } },
      { key: ASSET, kind: 'manual_asset', deleted: true, base_values: { ...previous.values, kind: 'manual_asset', deleted: false } },
    ])
    expect(Object.is(result.operations[1].base_values!.value, -0)).toBe(true)
    const built = await buildOwnerSyncRequest({ request_id: 'synthetic-delete-0001', expected_revision: 1, operations: result.operations })
    expect(Object.is(JSON.parse(built.rawBody).operations[1].base_values.value, -0)).toBe(false)
    expect(Object.is(previous.values.value, -0)).toBe(true)
  })
  it('requires every linked fund/manual row, including tombstones, and collects all issues without accepting valid partial creates', () => {
    const cloud = base([fund(), fund({ key: '000002::', deleted: true }), manual(), manual({ key: 'asset:deleted', deleted: true })])
    const result = planOwnerPortfolioCloudIntent(cloud, snapshot([entry({ key: '000003::new' })]), portfolio([asset({ key: 'asset:new' })]))
    expect(result).toEqual({ operations: [], issues: cloud.records.map(row => ({ code: 'missing_workspace_record', key: row.key })) })
  })
  it('never revives manual or fund cloud tombstones and reports all issues even beside missing keys', () => {
    const result = planOwnerPortfolioCloudIntent(base([fund({ deleted: true }), manual({ deleted: true }), fund({ key: '000003::missing' })]),
      snapshot([entry(), entry({ key: '000004::new' })]), portfolio([asset(), asset({ key: 'asset:new' })]))
    expect(result).toEqual({ operations: [], issues: [
      { code: 'missing_workspace_record', key: '000003::missing' }, { code: 'cloud_tombstone', key: KEY },
      { code: 'cloud_tombstone', key: ASSET },
    ] }); frozen(result)
  })
  it('noops both unlinked tombstones and already deleted rows, never emits resurrection from changed deleted values', () => {
    for (const cloud of [base(), base([fund({ deleted: true }), manual({ deleted: true })])]) {
      expect(planOwnerPortfolioCloudIntent(cloud, snapshot([entry({ deleted: true })]), portfolio([asset({ deleted: true })])))
        .toEqual({ operations: [], issues: [] })
    }
  })
  it.each(['watch', 'holding'] as const)('uses full old image and new values for fund kind transition to %s', kind => {
    const before = fund({ kind: kind === 'watch' ? 'holding' : 'watch' })
    const row = entry({ kind, values: { name: 'new-kind', shares: kind === 'watch' ? null : 0, cost: null, target_weight: 0 } })
    expect(planOwnerPortfolioCloudIntent(base([before]), snapshot([row]), portfolio()).operations)
      .toEqual([{ key: KEY, kind, deleted: false, changes: row.values, base_values: { ...before.values, kind: before.kind, deleted: false } }])
  })
  it('rejects new or kind-transition unknown-share holdings and deleted-kind transitions, but keeps unknown existing shares', () => {
    const unknown = entry({ values: { ...entry().values, shares: null } })
    for (const cloud of [base(), base([fund({ kind: 'watch' })])]) {
      expect(planOwnerPortfolioCloudIntent(cloud, snapshot([unknown]), portfolio()))
        .toEqual({ operations: [], issues: [{ code: 'missing_value', key: KEY }] })
    }
    expect(planOwnerPortfolioCloudIntent(base([fund({ values: { ...unknown.values } })]),
      snapshot([entry({ values: { ...unknown.values, name: 'only-name' } })]), portfolio()).operations[0].base_values)
      .toEqual({ kind: 'holding', deleted: false, name: 'synthetic-fund' })
    expect(planOwnerPortfolioCloudIntent(base([fund()]), snapshot([entry({ kind: 'watch', deleted: true })]), portfolio()))
      .toEqual({ operations: [], issues: [{ code: 'invalid_operation', key: KEY }] })
  })
  it('rejects malformed complete inputs without leaking private strings or falling back to a fund-only plan', () => {
    for (const [cloud, local, assets, code] of [
      [{ ...base(), private: PRIVATE }, snapshot(), portfolio(), 'invalid_baseline'],
      [base(), { ...snapshot(), private: PRIVATE }, portfolio(), 'invalid_workspace'],
      [base(), snapshot(), { ...portfolio(), private: PRIVATE }, 'invalid_portfolio'],
      [base(), snapshot(), portfolio([asset(), asset()]), 'invalid_portfolio'],
      [base(), snapshot(), portfolio([asset({ values: { ...asset().values, value: null as any } })]), 'invalid_portfolio'],
    ] as const) {
      const result = planOwnerPortfolioCloudIntent(cloud, local, assets)
      expect(result).toEqual({ operations: [], issues: [{ code, key: null }] }); expect(JSON.stringify(result)).not.toContain(PRIVATE)
    }
  })
  it('does not ignore malformed historical portfolio data merely because manual rows are valid', () => {
    const assets = { ...portfolio([asset()]), history: [{ id: PRIVATE, kind: 'legacy', date: 'broken' }] }
    expect(planOwnerPortfolioCloudIntent(base(), snapshot(), assets)).toEqual({ operations: [], issues: [{ code: 'invalid_portfolio', key: null }] })
  })
  it('retains all 201 manual operations; the actual builder alone rejects the final operation cap', async () => {
    const assets = portfolio(Array.from({ length: 201 }, (_, index) => asset({ key: 'asset:synthetic-' + index })))
    const result = planOwnerPortfolioCloudIntent(base(), snapshot(), assets)
    expect(result.issues).toEqual([]); expect(result.operations).toHaveLength(201)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-count-0001', expected_revision: 0, operations: result.operations }))
      .rejects.toMatchObject({ code: 'invalid_sync_request' })
  })
  it('retains every manual operation over128KiB and every issue over200 without trimming', async () => {
    const records = Array.from({ length: 200 }, (_, index) => manual({ key: 'asset:synthetic-' + index,
      values: { ...manual().values, note: '中'.repeat(400) } }))
    const result = planOwnerPortfolioCloudIntent(base(records), snapshot(), portfolio(records.map(row => asset({ key: row.key, deleted: true }))))
    expect(result.operations).toHaveLength(200); expect(result.issues).toEqual([])
    expect(new TextEncoder().encode(JSON.stringify(result.operations)).byteLength).toBeGreaterThan(OWNER_SYNC_MAX_BODY_BYTES)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-bytes-0001', expected_revision: 1, operations: result.operations }))
      .rejects.toMatchObject({ code: 'invalid_sync_request' })
    const absent = Array.from({ length: 201 }, (_, index) => manual({ key: 'asset:missing-' + index }))
    const issues = planOwnerPortfolioCloudIntent(base(absent), snapshot(), portfolio())
    expect(issues.operations).toEqual([]); expect(issues.issues).toHaveLength(201)
  })
})
