/** Real closed codecs/planner and a pure applied-B refresh. No IO, fake POST,
 * receipt, packet, legacy ACK or validator stubs manufacture qualification. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import type { OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from './owner-cloud-import'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import { previewOwnerPortfolioMigration, type OwnerPortfolioLocal, type OwnerPortfolioManual } from './ownerPortfolioLocal'
import { planOwnerPortfolioCloudIntent } from './owner-portfolio-sync'
import { buildOwnerSyncRequest, type OwnerSyncRecord } from './ownerSyncContract'
import {
  previewOwnerPortfolioRefresh, type OwnerPortfolioRefreshInput,
  type OwnerPortfolioRefreshResolution, type OwnerPortfolioRefreshField,
} from './owner-portfolio-refresh'

const KEY = '000001::synthetic-account', OTHER = '000002::synthetic-other', FRESH = '000001::synthetic-renamed'
const ASSET = 'asset:synthetic-cash', PRIVATE = 'synthetic-private-refresh-never-echo'
afterEach(() => vi.restoreAllMocks())
function fund(patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, ...patch }
}
function manual(patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { key: ASSET, kind: 'manual_asset', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: 'synthetic-cash', cls: '现金', value: 0, note: null }, ...patch }
}
function changed(source: OwnerSyncRecord, changes: OwnerSyncRecord['values'], at = 2,
  patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { ...source, record_revision: at, values: { ...source.values, ...changes },
    field_revisions: { ...source.field_revisions, ...Object.fromEntries(Object.keys(changes).map(key => [key, at])) }, ...patch }
}
function fresh(source: OwnerSyncRecord, at = 2): OwnerSyncRecord {
  return { ...source, record_revision: at, lifecycle_revision: at,
    field_revisions: Object.fromEntries(Object.keys(source.values).map(key => [key, at])) }
}
function entry(source = fund(), patch: Partial<OwnerWorkspaceEntry> = {}): OwnerWorkspaceEntry {
  if (source.kind === 'manual_asset') throw new Error('fund fixture cannot project manual')
  return { key: source.key, kind: source.kind, deleted: source.deleted, local_pending: true,
    values: { name: source.values.name as string, shares: source.values.shares as number | null,
      cost: source.values.cost as number | null, target_weight: source.values.target_weight as number | null }, ...patch }
}
function asset(source = manual(), patch: Partial<OwnerPortfolioManual> = {}): OwnerPortfolioManual {
  if (source.kind !== 'manual_asset') throw new Error('manual fixture cannot project fund')
  return { key: source.key, legacyId: null, deleted: source.deleted, local_pending: true, updated_at: '2026-10-25T00:00:00Z',
    values: { name: source.values.name as string, cls: source.values.cls as OwnerPortfolioManual['values']['cls'],
      value: source.values.value as number, note: source.values.note as string | null }, ...patch }
}
function snapshot(entries: readonly OwnerWorkspaceEntry[] = [entry()]): OwnerWorkspaceSnapshot {
  return { localVersion: 7, entries, legacy: { sourceKey: 'sinan_watchlist_v2', raw: PRIVATE } }
}
function portfolio(rows: readonly OwnerPortfolioManual[] = [asset()]): OwnerPortfolioLocal {
  const source = { manualRaw: null, snapshotsRaw: null }
  return { schema: 'owner-portfolio-local-1', manual: rows, history: [], migration: { ...source,
    sourceSha256: createHash('sha256').update(canonicalOwnerLocal(source), 'utf8').digest('hex'), idMappings: [] } }
}
function baseline(records: readonly OwnerSyncRecord[] = [fund(), manual()]): OwnerSyncBaseline {
  return { pulledRevision: Math.max(0, ...records.map(row => row.record_revision)), records }
}
function fixture(patch: Partial<OwnerPortfolioRefreshInput> = {}): OwnerPortfolioRefreshInput {
  return { base: baseline(), localSnapshot: snapshot(), portfolio: portfolio(), completeBaseline: baseline(),
    minimumObservedRevision: 0, resolutions: [], ...patch }
}
function choice(key: string, field: OwnerPortfolioRefreshField, side: 'local' | 'cloud'): OwnerPortfolioRefreshResolution {
  return { key, field, choice: side }
}
function invalid(input: unknown, code?: string) {
  const result = previewOwnerPortfolioRefresh(input)
  expect(result.issues.length).toBeGreaterThan(0)
  if (code) expect(result.issues[0].code).toBe(code)
  expect(result).toMatchObject({ schema: 'owner-portfolio-refresh-preview-1', nextSnapshot: null, nextPortfolio: null,
    baseD: null, conflicts: [], rows: [], changedKeys: [], remainingOperations: [], noop: false })
  expect(JSON.stringify(result)).not.toContain(PRIVATE)
  return result
}
function frozen(input: unknown): void {
  if (input && typeof input === 'object') { expect(Object.isFrozen(input)).toBe(true); Object.values(input).forEach(frozen) }
}

describe('applied full-B refresh, without any original write', () => {
  it('has a stable exact empty no-op without a packet/result/initial bootstrap', () => {
    const result = previewOwnerPortfolioRefresh(fixture({ base: baseline([]), completeBaseline: baseline([]),
      localSnapshot: snapshot([]), portfolio: portfolio([]) }))
    expect(result).toMatchObject({ schema: 'owner-portfolio-refresh-preview-1', issues: [], conflicts: [],
      rows: [], changedKeys: [], remainingOperations: [], noop: true })
    expect(result.baseD).toEqual(baseline([])); frozen(result)
    expect(result).not.toHaveProperty('outcome'); expect(result).not.toHaveProperty('packet')
  })
  it('does not modify/freeze inputs or turn unchanged local_pending=false into a write', () => {
    const input = fixture({ localSnapshot: snapshot([entry(fund(), { local_pending: false })]) }), before = canonicalOwnerLocal(input),
      result = previewOwnerPortfolioRefresh(input)
    expect(result.issues).toEqual([]); expect(result.noop).toBe(true)
    expect(result.nextSnapshot).toEqual(input.localSnapshot); expect(result.nextPortfolio).toEqual(input.portfolio)
    expect(result.rows).toEqual([]); expect(canonicalOwnerLocal(input)).toBe(before)
    expect(Object.isFrozen(input)).toBe(false); frozen(result)
  })
  it('absorbs cloud-only changes for funds and manual, but preserves local identities and local_pending', () => {
    const cloudFund = changed(fund(), { shares: 19 }), cloudManual = changed(manual(), { cls: '商品', value: 20, note: '' }),
      extraFund = fresh(fund({ key: OTHER, deleted: true })), extraManual = fresh(manual({ key: 'asset:cloud-only', deleted: true })),
      input = fixture({ completeBaseline: baseline([cloudFund, cloudManual, extraFund, extraManual]) }), result = previewOwnerPortfolioRefresh(input)
    expect(result.issues).toEqual([]); expect(result.conflicts).toEqual([]); expect(result.noop).toBe(false)
    expect(result.nextSnapshot!.entries).toEqual([entry(cloudFund), entry(extraFund)])
    expect(result.nextPortfolio!.manual).toEqual([asset(cloudManual), asset(extraManual, { updated_at: null })])
    expect(result.remainingOperations).toEqual([]); expect(result.changedKeys).toEqual([KEY, ASSET, OTHER, 'asset:cloud-only'])
    expect(result.baseD).toEqual(input.completeBaseline); expect(result.nextSnapshot!.localVersion).toBe(7)
  })
  it('preserves an unuploaded fund name/manual note while another device changes shares/value', () => {
    const input = fixture({ localSnapshot: snapshot([entry(changed(fund(), { name: 'local-name' }))]),
      portfolio: portfolio([asset(changed(manual(), { note: 'local-note' }))]),
      completeBaseline: baseline([changed(fund(), { shares: 30 }), changed(manual(), { value: 40 })]) }), result = previewOwnerPortfolioRefresh(input)
    expect(result.issues).toEqual([]); expect(result.conflicts).toEqual([])
    expect(result.nextSnapshot!.entries[0].values).toMatchObject({ name: 'local-name', shares: 30 })
    expect(result.nextPortfolio!.manual[0].values).toMatchObject({ note: 'local-note', value: 40 })
    expect(result.remainingOperations.map(row => [row.key, row.changes, row.base_values])).toEqual([
      [KEY, { name: 'local-name' }, { kind: 'holding', deleted: false, name: 'synthetic-fund' }],
      [ASSET, { note: 'local-note' }, { kind: 'manual_asset', deleted: false, note: null }],
    ])
    expect(result.rows[0].fields).toEqual(['shares', 'name']); expect(result.rows[1].fields).toEqual(['value', 'note'])
    expect(planOwnerPortfolioCloudIntent(result.baseD, result.nextSnapshot, result.nextPortfolio).operations).toEqual(result.remainingOperations)
  })
  it('shows retained intents even when refreshing the same B is an exact no-op', () => {
    const input = fixture({ localSnapshot: snapshot([entry(changed(fund(), { name: 'local-name' }))]),
      portfolio: portfolio([asset(changed(manual(), { value: 8 }))]) }), result = previewOwnerPortfolioRefresh(input)
    expect(result.issues).toEqual([]); expect(result.noop).toBe(true); expect(result.changedKeys).toEqual([])
    expect(result.rows.map(row => row.fields)).toEqual([['name'], ['value']]); expect(result.remainingOperations).toHaveLength(2)
    expect(result.rows.every(row => canonicalOwnerLocal(row.before) === canonicalOwnerLocal(row.after))).toBe(true)
  })
  it('advancing cloud stamps/head with equal business values is not a no-op', () => {
    const input = fixture({ completeBaseline: baseline([changed(fund(), { shares: 0 }), manual()]) }), result = previewOwnerPortfolioRefresh(input)
    expect(result.issues).toEqual([]); expect(result.conflicts).toEqual([]); expect(result.noop).toBe(false)
    expect(result.changedKeys).toEqual([]); expect(result.rows).toEqual([]); expect(result.baseD!.pulledRevision).toBe(2)
  })
  it('record ordering alone is a stable no-op, without rewriting either supplied baseline', () => {
    const input = fixture({ completeBaseline: baseline([manual(), fund()]) }), original = canonicalOwnerLocal(input), result = previewOwnerPortfolioRefresh(input)
    expect(result.issues).toEqual([]); expect(result.noop).toBe(true); expect(result.baseD!.records.map(row => row.key)).toEqual([ASSET, KEY])
    expect(canonicalOwnerLocal(input)).toBe(original)
  })
  it('does not normalize signed-zero B/D differences into a typed no-op or alter the original local sign', () => {
    const before = manual({ values: { ...manual().values, value: -0 } }), source = fixture({ base: baseline([fund(), before]),
      portfolio: portfolio([asset(before)]), completeBaseline: baseline([fund(), manual()]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.issues).toEqual([]); expect(result.noop).toBe(false); expect(result.changedKeys).toEqual([])
    expect(Object.is(result.nextPortfolio!.manual[0].values.value, -0)).toBe(true)
    expect(Object.is(result.baseD!.records[1].values.value, -0)).toBe(false)
  })
  it('preserves raw archives, history, original legacyId/time, null/empty and signed zeros', async () => {
    const manualRaw = ' \n' + canonicalOwnerLocal([{ id: 'synthetic-cash', name: 'synthetic-cash', cls: '现金', value: -0,
      updated_at: '2026-10-25T00:00:00.123Z' }]) + '\r\n', snapshotsRaw = canonicalOwnerLocal([
      { date: '2026-10-25', value: -0, cost: 0 }, { date: '2026-10-25', value: 3, cost: 4 },
    ]), migrated = (await previewOwnerPortfolioMigration({ manualRaw, snapshotsRaw })).portfolio!,
      source = fixture({ localSnapshot: snapshot([entry(fund(), { values: { ...entry().values, shares: -0 } })]),
        portfolio: { ...migrated, manual: migrated.manual.map(row => ({ ...row, values: { ...row.values, note: '' } })) },
        completeBaseline: baseline([changed(fund(), { name: 'cloud-name' }), changed(manual(), { cls: '商品' })]) }),
      original = canonicalOwnerLocal(source), result = previewOwnerPortfolioRefresh(source)
    expect(result.issues).toEqual([]); expect(result.conflicts).toEqual([])
    expect(result.nextPortfolio!.migration).toEqual(migrated.migration); expect(result.nextPortfolio!.history).toEqual(migrated.history)
    expect(result.nextPortfolio!.manual[0]).toMatchObject({ legacyId: 'synthetic-cash', updated_at: '2026-10-25T00:00:00.123Z', values: { note: '', cls: '商品' } })
    expect(Object.is(result.nextSnapshot!.entries[0].values.shares, -0)).toBe(true)
    expect(Object.is(result.nextPortfolio!.manual[0].values.value, -0)).toBe(true)
    expect(Object.is(result.nextPortfolio!.history[0].value, -0)).toBe(true)
    expect(result.remainingOperations).toHaveLength(1); expect(result.remainingOperations[0].changes).toEqual({ note: '' })
    expect(canonicalOwnerLocal(source)).toBe(original)
  })
})

const FIELD_CASES: readonly { field: OwnerPortfolioRefreshField; entity: 'fund' | 'manual'; local: string | number; cloud: string | number }[] = [
  { field: 'name', entity: 'fund', local: 'local-fund', cloud: 'cloud-fund' },
  { field: 'shares', entity: 'fund', local: 7, cloud: 9 },
  { field: 'cost', entity: 'fund', local: 7, cloud: 9 },
  { field: 'target_weight', entity: 'fund', local: 0.7, cloud: 0.9 },
  { field: 'name', entity: 'manual', local: 'local-manual', cloud: 'cloud-manual' },
  { field: 'cls', entity: 'manual', local: '商品', cloud: '权益' },
  { field: 'value', entity: 'manual', local: 7, cloud: 9 },
  { field: 'note', entity: 'manual', local: '', cloud: 'cloud-note' },
]
describe('true field three-way conflicts, with manual applied B rather than bootstrap', () => {
  it.each(FIELD_CASES.flatMap(item => ['changed', 'aba', 'converged'].map(mode => ({ ...item, mode }))))(
    '$entity $field requires explicit choice for $mode', item => {
      const before = item.entity === 'fund' ? fund() : manual(), local = changed(before, { [item.field]: item.local }),
        cloud = changed(before, { [item.field]: item.mode === 'aba' ? before.values[item.field] : item.mode === 'converged' ? item.local : item.cloud }),
        source = fixture({ localSnapshot: item.entity === 'fund' ? snapshot([entry(local)]) : snapshot(),
          portfolio: item.entity === 'manual' ? portfolio([asset(local)]) : portfolio(),
          completeBaseline: baseline(item.entity === 'fund' ? [cloud, manual()] : [fund(), cloud]) }),
        result = previewOwnerPortfolioRefresh(source)
      expect(result.issues).toEqual([]); expect(result.nextSnapshot).toBeNull(); expect(result.nextPortfolio).toBeNull()
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]).toMatchObject({ key: before.key, field: item.field,
        reason: item.mode === 'aba' ? 'field_aba' : 'field_changed', choice: null, localAllowed: true })
      for (const side of ['local', 'cloud'] as const) {
        const selected = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(before.key, item.field, side)] })
        expect(selected.issues).toEqual([]); expect(selected.conflicts[0].choice).toBe(side)
        const actual = item.entity === 'fund' ? selected.nextSnapshot!.entries[0].values : selected.nextPortfolio!.manual[0].values
        expect((actual as unknown as Record<string, unknown>)[item.field]).toBe(side === 'local' ? item.local : cloud.values[item.field])
        expect(selected.remainingOperations).toHaveLength(side === 'cloud' || item.mode === 'converged' ? 0 : 1)
      }
    })
})

describe('whole-row lifecycle/delete/create and tombstone boundaries', () => {
  it('a local full delete conflicts with any cloud field advance and retains a complete D delete guard', () => {
    const cloud = changed(manual(), { name: 'cloud-name', note: '' }), source = fixture({
      portfolio: portfolio([asset(manual(), { deleted: true })]), completeBaseline: baseline([fund(), cloud]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts).toHaveLength(1); expect(result.conflicts[0].field).toBe('lifecycle')
    const selected = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(ASSET, 'lifecycle', 'local')] })
    expect(selected.issues).toEqual([]); expect(selected.remainingOperations).toEqual([
      { key: ASSET, kind: 'manual_asset', deleted: true, base_values: { ...cloud.values, kind: 'manual_asset', deleted: false } },
    ])
  })
  it('a local kind change conflicts with cloud progress as one lifecycle selection', () => {
    const before = fund({ kind: 'watch', values: { name: 'synthetic-fund', shares: null, cost: null, target_weight: null } }),
      cloud = changed(before, { name: 'cloud-name' }), source = fixture({ base: baseline([before, manual()]),
        localSnapshot: snapshot([entry(fund())]), completeBaseline: baseline([cloud, manual()]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts[0]).toMatchObject({ field: 'lifecycle', reason: 'lifecycle_changed' })
    const selected = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'lifecycle', 'local')] })
    expect(selected.issues).toEqual([]); expect(selected.remainingOperations[0]).toMatchObject({ kind: 'holding',
      changes: fund().values, base_values: { ...cloud.values, kind: 'watch', deleted: false } })
  })
  it('a cloud kind change and a local field edit use one whole-row choice with real D guards', () => {
    const before = fund({ kind: 'watch', values: { name: 'synthetic-fund', shares: null, cost: null, target_weight: null } }),
      cloud = changed(before, { shares: 12 }, 2, { kind: 'holding', lifecycle_revision: 2 }), source = fixture({
        base: baseline([before, manual()]), localSnapshot: snapshot([entry(before, { values: { ...entry(before).values, name: 'local-watch' } })]),
        completeBaseline: baseline([cloud, manual()]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.issues).toEqual([]); expect(result.conflicts[0]).toMatchObject({ field: 'lifecycle', localAllowed: true })
    const local = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'lifecycle', 'local')] })
    expect(local.nextSnapshot!.entries[0].kind).toBe('watch')
    expect(local.remainingOperations[0]).toMatchObject({ kind: 'watch', base_values: { ...cloud.values, kind: 'holding', deleted: false } })
    const remote = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'lifecycle', 'cloud')] })
    expect(remote.nextSnapshot!.entries[0]).toEqual(entry(cloud)); expect(remote.remainingOperations).toEqual([])
  })
  it('observed lifecycle ABA forces a whole-row choice even for disjoint edits', () => {
    const cloud = { ...fund(), record_revision: 3, lifecycle_revision: 3 }, source = fixture({
      localSnapshot: snapshot([entry(changed(fund(), { cost: 5 }))]), completeBaseline: baseline([cloud, manual()]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.issues).toEqual([]); expect(result.conflicts[0]).toMatchObject({ field: 'lifecycle', reason: 'lifecycle_aba' })
  })
  it('adopts a cloud-only delete, but never permits local selection to revive a cloud tombstone', () => {
    const cloud = { ...manual(), deleted: true, record_revision: 2, lifecycle_revision: 2 }, source = fixture({ completeBaseline: baseline([fund(), cloud]) })
    const clean = previewOwnerPortfolioRefresh(source)
    expect(clean.issues).toEqual([]); expect(clean.conflicts).toEqual([]); expect(clean.nextPortfolio!.manual[0].deleted).toBe(true)
    const edited = { ...source, portfolio: portfolio([asset(changed(manual(), { value: 9 }))]) }, unresolved = previewOwnerPortfolioRefresh(edited)
    expect(unresolved.conflicts[0]).toMatchObject({ reason: 'cloud_tombstone', localAllowed: false })
    invalid({ ...edited, resolutions: [choice(ASSET, 'lifecycle', 'local')] }, 'invalid_resolution')
    expect(previewOwnerPortfolioRefresh({ ...edited, resolutions: [choice(ASSET, 'lifecycle', 'cloud')] }).remainingOperations).toEqual([])
  })
  it('two deletes still require explicit convergence after lifecycle advance', () => {
    const cloud = { ...fund(), deleted: true, record_revision: 2, lifecycle_revision: 2 }, source = fixture({
      localSnapshot: snapshot([entry(fund(), { deleted: true })]), completeBaseline: baseline([cloud, manual()]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts[0]).toMatchObject({ field: 'lifecycle', localAllowed: true })
    expect(previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'lifecycle', 'local')] }).remainingOperations).toEqual([])
  })
  it.each(['fund', 'manual'])('rejects resurrection of an already-cloud tombstone (%s)', type => {
    const before = type === 'fund' ? fund({ deleted: true }) : manual({ deleted: true }), cloud = { ...before, deleted: false, record_revision: 2, lifecycle_revision: 2 },
      source = fixture({ base: baseline(type === 'fund' ? [before, manual()] : [fund(), before]),
        localSnapshot: type === 'fund' ? snapshot([entry(before)]) : snapshot(),
        portfolio: type === 'manual' ? portfolio([asset(before)]) : portfolio(),
        completeBaseline: baseline(type === 'fund' ? [cloud, manual()] : [fund(), cloud]) })
    invalid(source, 'baseline_regression')
  })
  it('rejects an invalid local resurrection relative to applied B before deriving any postimage', () => {
    const before = manual({ deleted: true }), source = fixture({ base: baseline([fund(), before]), completeBaseline: baseline([fund(), before]) })
    invalid(source, 'cloud_tombstone')
  })
  it.each(['fund', 'manual'])('a new local/cloud same-key creation requires whole-row choice even if equal (%s)', type => {
    const cloud = fresh(type === 'fund' ? fund({ key: OTHER }) : manual({ key: 'asset:new-manual' })),
      source = fixture({ localSnapshot: type === 'fund' ? snapshot([entry(), entry(cloud)]) : snapshot(),
        portfolio: type === 'manual' ? portfolio([asset(), asset(cloud)]) : portfolio(),
        completeBaseline: baseline([fund(), manual(), cloud]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts[0]).toMatchObject({ key: cloud.key, field: 'lifecycle', reason: 'creation_collision' })
    expect(previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(cloud.key, 'lifecycle', 'local')] }).remainingOperations).toEqual([])
  })
  it('keeps new local keys and never-uploaded tombstones without manufacturing a write for a tombstone', () => {
    const localFund = entry(fund({ key: OTHER })), localManual = asset(manual({ key: 'asset:new-manual' })),
      tombFund = entry(fund({ key: FRESH, deleted: true })), tombManual = asset(manual({ key: 'asset:old-local', deleted: true })),
      source = fixture({ localSnapshot: snapshot([entry(), localFund, tombFund]), portfolio: portfolio([asset(), localManual, tombManual]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.issues).toEqual([]); expect(result.noop).toBe(true); expect(result.changedKeys).toEqual([])
    expect(result.nextSnapshot!.entries).toContainEqual(tombFund); expect(result.nextPortfolio!.manual).toContainEqual(tombManual)
    expect(result.remainingOperations.map(row => row.key)).toEqual([OTHER, 'asset:new-manual'])
  })
  it('requires an explicit cloud choice before adopting cloud active over an unlinked local tombstone', () => {
    const cloud = fresh(manual({ key: 'asset:local-tombstone' })), local = asset(cloud, { deleted: true }),
      source = fixture({ portfolio: portfolio([asset(), local]), completeBaseline: baseline([fund(), manual(), cloud]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts[0]).toMatchObject({ key: cloud.key, field: 'lifecycle', localAllowed: true })
    const keep = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(cloud.key, 'lifecycle', 'local')] })
    expect(keep.nextPortfolio!.manual[1].deleted).toBe(true); expect(keep.remainingOperations[0].deleted).toBe(true)
    const adopt = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(cloud.key, 'lifecycle', 'cloud')] })
    expect(adopt.nextPortfolio!.manual[1]).toEqual({ ...local, deleted: false }); expect(adopt.remainingOperations).toEqual([])
  })
})

describe('fund rename atomicity and manual non-rename', () => {
  it('groups delete+fresh account conservatively, retaining a fresh tombstone when cloud cancels', () => {
    const renamed = entry(fund({ key: FRESH })), cloud = changed(fund(), { name: 'cloud-name' }), source = fixture({
      localSnapshot: snapshot([entry(fund(), { deleted: true }), renamed]), completeBaseline: baseline([cloud, manual()]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts).toHaveLength(1); expect(result.conflicts[0]).toMatchObject({ field: 'rename', reason: 'rename_atomic', groupKeys: [KEY, FRESH] })
    const local = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'rename', 'local')] })
    expect(local.remainingOperations.map(row => [row.key, row.deleted])).toEqual([[KEY, true], [FRESH, false]])
    const selected = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'rename', 'cloud')] })
    expect(selected.nextSnapshot!.entries).toEqual([entry(cloud), { ...renamed, deleted: true }]); expect(selected.remainingOperations).toEqual([])
  })
  it('cannot revive a cloud-tombstoned fresh rename key by choosing the local whole group', () => {
    const cloudNew = fresh(fund({ key: FRESH, deleted: true })), source = fixture({
      localSnapshot: snapshot([entry(fund(), { deleted: true }), entry(fund({ key: FRESH }))]), completeBaseline: baseline([fund(), manual(), cloudNew]) }),
      result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts[0]).toMatchObject({ field: 'rename', localAllowed: false })
    invalid({ ...source, resolutions: [choice(KEY, 'rename', 'local')] }, 'invalid_resolution')
    expect(previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'rename', 'cloud')] }).remainingOperations).toEqual([])
  })
  it('does not sweep an unrelated already-linked account patch into a same-code rename group', () => {
    const extraKey = '000001::unrelated-account', extra = fund({ key: extraKey }), cloud = changed(fund(), { shares: 9 }),
      source = fixture({ base: baseline([fund(), manual(), extra]),
        localSnapshot: snapshot([entry(fund(), { deleted: true }), entry(fund({ key: FRESH })), entry(changed(extra, { cost: 15 }))]),
        completeBaseline: baseline([cloud, manual(), extra]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts[0]).toMatchObject({ field: 'rename', groupKeys: [KEY, FRESH] })
    const selected = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(KEY, 'rename', 'cloud')] })
    expect(selected.nextSnapshot!.entries[2].values.cost).toBe(15)
    expect(selected.remainingOperations.map(row => row.key)).toEqual([extraKey])
  })
  it('does not label manual delete+new-key as a fund account rename', () => {
    const cloud = changed(manual(), { value: 4 }), source = fixture({ portfolio: portfolio([
      asset(manual(), { deleted: true }), asset(manual({ key: 'asset:manual-new' })),
    ]), completeBaseline: baseline([fund(), cloud]) }), result = previewOwnerPortfolioRefresh(source)
    expect(result.conflicts).toHaveLength(1); expect(result.conflicts[0].field).toBe('lifecycle')
    const selected = previewOwnerPortfolioRefresh({ ...source, resolutions: [choice(ASSET, 'lifecycle', 'cloud')] })
    expect(selected.nextPortfolio!.manual[1].deleted).toBe(false); expect(selected.remainingOperations.map(row => row.key)).toEqual(['asset:manual-new'])
  })
})

describe('complete source progress and missing applied images', () => {
  it.each(['fund', 'manual'])('rejects a missing applied local %s row rather than treating absence as deletion', type => {
    const result = invalid(fixture({ localSnapshot: type === 'fund' ? snapshot([]) : snapshot(),
      portfolio: type === 'manual' ? portfolio([]) : portfolio() }), 'missing_workspace_record')
    expect(result.issues[0].key).toBe(type === 'fund' ? KEY : ASSET)
  })
  it('collects all missing local rows and invalid resurrection issues rather than partially proceeding', () => {
    const before = manual({ deleted: true }), source = fixture({ base: baseline([fund(), before, fund({ key: OTHER })]),
      localSnapshot: snapshot([]), completeBaseline: baseline([fund(), before, fund({ key: OTHER })]) }), result = invalid(source)
    expect(result.issues.map(row => [row.code, row.key])).toEqual([
      ['missing_workspace_record', KEY], ['missing_workspace_record', OTHER], ['cloud_tombstone', ASSET],
    ])
  })
  it.each(['fund', 'manual'])('complete D cannot omit an applied cloud %s row', type => {
    invalid(fixture({ completeBaseline: baseline(type === 'fund' ? [manual()] : [fund()]) }), 'missing_cloud_record')
  })
  it('retains the observed head lower bound independently of complete D shape', () => {
    invalid(fixture({ minimumObservedRevision: 2 }), 'baseline_regression')
    expect(previewOwnerPortfolioRefresh(fixture({ minimumObservedRevision: 1 })).noop).toBe(true)
  })
  it.each<Partial<OwnerSyncRecord>>([
    { record_revision: 2, field_revisions: { ...fund().field_revisions, name: 1 }, values: { ...fund().values, name: 'bad-no-stamp' } },
    { record_revision: 2, lifecycle_revision: 1, kind: 'watch' as const, values: { name: 'watch', shares: null, cost: null, target_weight: null } },
    { record_revision: 1, field_revisions: { ...fund().field_revisions, shares: 1 }, values: { ...fund().values, shares: 2 } },
  ])('rejects invalid field/lifecycle progress rather than trusting record_revision alone %#', patch => {
    invalid(fixture({ completeBaseline: baseline([fund(patch), manual()]) }), 'baseline_regression')
  })
  it('rejects late insertion of a supposedly old key into D', () => {
    invalid(fixture({ completeBaseline: baseline([fund(), manual(), fund({ key: OTHER })]) }), 'baseline_regression')
  })
  it('rejects decreasing record/field/lifecycle revisions relative to applied B', () => {
    const before = changed(fund(), { shares: 4 }, 3, { lifecycle_revision: 2 }), source = fixture({
      base: baseline([before, manual()]), localSnapshot: snapshot([entry(before)]), completeBaseline: baseline([fund(), manual()]) })
    invalid(source, 'baseline_regression')
  })
  it.each(['field', 'lifecycle', 'record'])('changed %s stamps must be beyond the whole previous head, not just that row', type => {
    const head = fresh(manual(), 8), before = fund(), after = type === 'field'
      ? changed(before, { shares: 3 }, 4, { record_revision: 9 })
      : type === 'lifecycle' ? { ...before, record_revision: 9, lifecycle_revision: 4 }
        : { ...before, record_revision: 4 },
      source = fixture({ base: baseline([before, head]), portfolio: portfolio([asset(head)]),
        completeBaseline: baseline([after, { ...head, record_revision: 9 }]) })
    invalid(source, 'baseline_regression')
  })
})

describe('descriptor-safe closed unknown input and resolution bounds', () => {
  it.each([null, undefined, true, [], 1, 'private', new Date()])('rejects unsupported top-level input %#', value => { invalid(value, 'invalid_input') })
  it.each(['packet', 'matchedResult', 'keyDigests', 'history', 'future'])('rejects unknown top-level %s rather than accepting fake authority', field => {
    invalid({ ...fixture(), [field]: PRIVATE }, 'invalid_input')
  })
  it('rejects top-level/nested getters without executing them', () => {
    const getter = vi.fn(() => { throw new Error(PRIVATE) }), top = fixture()
    Object.defineProperty(top, 'base', { enumerable: true, get: getter }); invalid(top, 'invalid_input')
    const source = fixture(), nested = { ...fund().values }
    Object.defineProperty(nested, 'name', { enumerable: true, get: getter })
    invalid({ ...source, completeBaseline: baseline([fund({ values: nested }), manual()]) }, 'invalid_baseline')
    const assets = portfolio(), manualValues = { ...asset().values }
    Object.defineProperty(manualValues, 'note', { enumerable: true, get: getter })
    invalid({ ...source, portfolio: { ...assets, manual: [{ ...asset(), values: manualValues }] } }, 'invalid_portfolio')
    expect(getter).not.toHaveBeenCalled()
  })
  it('rejects hidden/symbol fields and getters in legacy, archives and lists without evaluating them', () => {
    const getter = vi.fn(() => PRIVATE), source = fixture(), legacy = { ...source.localSnapshot.legacy! }
    Object.defineProperty(legacy, 'raw', { enumerable: true, get: getter })
    invalid({ ...source, localSnapshot: { ...source.localSnapshot, legacy } }, 'invalid_workspace')
    const migration = { ...source.portfolio.migration }
    Object.defineProperty(migration, 'manualRaw', { enumerable: true, get: getter })
    invalid({ ...source, portfolio: { ...source.portfolio, migration } }, 'invalid_portfolio')
    const records = [fund(), manual()]; Object.defineProperty(records, '0', { enumerable: true, get: getter })
    invalid({ ...source, completeBaseline: { pulledRevision: 1, records } }, 'invalid_baseline')
    const hidden = fund(); Object.defineProperty(hidden.values, 'private', { value: PRIVATE })
    invalid({ ...source, completeBaseline: baseline([hidden, manual()]) }, 'invalid_baseline')
    const symbol = asset(); Object.defineProperty(symbol.values, Symbol('private'), { enumerable: true, value: PRIVATE })
    invalid({ ...source, portfolio: portfolio([symbol]) }, 'invalid_portfolio')
    expect(getter).not.toHaveBeenCalled()
  })
  it.each(['hidden', 'symbol', 'prototype'])('rejects %s top-level fields', kind => {
    const source = fixture()
    if (kind === 'hidden') Object.defineProperty(source, 'hidden', { value: PRIVATE })
    else if (kind === 'symbol') Object.defineProperty(source, Symbol('private'), { value: PRIVATE, enumerable: true })
    else Object.setPrototypeOf(source, { inherited: PRIVATE })
    invalid(source, 'invalid_input')
  })
  it.each([-0, -1, NaN, Infinity, '1', null])('rejects bad observed revision %#', value => {
    invalid({ ...fixture(), minimumObservedRevision: value }, 'invalid_input')
  })
  it('rejects malformed/sparse/decorated/getter resolutions without execution', () => {
    const getter = vi.fn(() => PRIVATE), sparse: unknown[] = new Array(1), decorated: unknown[] = []
    Object.defineProperty(decorated, 'private', { value: PRIVATE })
    for (const value of [null, {}, sparse, decorated, [choice(KEY, 'name', 'local')],
      [{ ...choice(KEY, 'name', 'local'), extra: PRIVATE }], [{ key: KEY, field: 'future', choice: 'local' }]]) {
      invalid({ ...fixture(), resolutions: value }, 'invalid_resolution')
    }
    const item = { ...choice(KEY, 'name', 'local') }; Object.defineProperty(item, 'choice', { enumerable: true, get: getter })
    invalid({ ...fixture(), resolutions: [item] }, 'invalid_resolution')
    const array = [choice(KEY, 'name', 'local')]; Object.defineProperty(array, '0', { enumerable: true, get: getter })
    invalid({ ...fixture(), resolutions: array }, 'invalid_resolution'); expect(getter).not.toHaveBeenCalled()
  })
  it('rejects duplicate choices and choices that do not name an actual conflict', () => {
    const source = fixture({ localSnapshot: snapshot([entry(changed(fund(), { name: 'local' }))]),
      completeBaseline: baseline([changed(fund(), { name: 'cloud' }), manual()]) })
    invalid({ ...source, resolutions: [choice(KEY, 'name', 'local'), choice(KEY, 'name', 'cloud')] }, 'invalid_resolution')
    invalid({ ...source, resolutions: [choice(KEY, 'cost', 'cloud')] }, 'invalid_resolution')
  })
})

describe('capacities never trim intent or disguise a packet', () => {
  it('retains 201 real operations; the real packet builder later rejects its own 200 operation limit', async () => {
    const entries = Array.from({ length: 201 }, (_, index) => entry(fund({ key: `${String(index).padStart(6, '0')}::synthetic` }))),
      result = previewOwnerPortfolioRefresh(fixture({ base: baseline([]), completeBaseline: baseline([]), localSnapshot: snapshot(entries), portfolio: portfolio([]) }))
    expect(result.issues).toEqual([]); expect(result.remainingOperations).toHaveLength(201); expect(result.rows).toHaveLength(201)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-refresh-over-count', expected_revision: 0,
      operations: result.remainingOperations })).rejects.toThrow()
  })
  it('retains >128KiB guarded intent; real builder refuses rather than refresh trimming fields', async () => {
    const assets = Array.from({ length: 100 }, (_, index) => asset(manual({ key: `asset:synthetic-${index}` }),
      { values: { ...asset().values, note: 'x'.repeat(1800) } })),
      result = previewOwnerPortfolioRefresh(fixture({ base: baseline([]), completeBaseline: baseline([]), localSnapshot: snapshot([]), portfolio: portfolio(assets) }))
    expect(result.issues).toEqual([]); expect(result.remainingOperations).toHaveLength(100)
    expect(result.nextPortfolio!.manual.every(row => row.values.note?.length === 1800)).toBe(true)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-refresh-over-bytes', expected_revision: 0,
      operations: result.remainingOperations })).rejects.toThrow()
  })
  it('rejects over-capacity complete D without a partial writable postimage', () => {
    const records = Array.from({ length: 1800 }, (_, index) => fresh(manual({ key: `asset:synthetic-${index}`,
      values: { ...manual().values, note: 'x'.repeat(1800) } })))
    invalid(fixture({ completeBaseline: baseline([...baseline().records, ...records]) }), 'capacity_exceeded')
  })
})
