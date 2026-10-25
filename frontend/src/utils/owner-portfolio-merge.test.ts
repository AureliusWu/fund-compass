/** Real pure first-link/planner contracts with synthetic finance rows; these
 * tests do not prove storage CAS, actual browser, POST or cloud durability. */
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import type { OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from './owner-cloud-import'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import { previewOwnerPortfolioMigration, validateOwnerPortfolioLocal, type OwnerPortfolioLocal, type OwnerPortfolioManual } from './ownerPortfolioLocal'
import { buildOwnerSyncRequest, OWNER_SYNC_MAX_BODY_BYTES, type OwnerSyncRecord } from './ownerSyncContract'
import {
  previewOwnerPortfolioInitialMerge, type OwnerPortfolioInitialMergeInput, type OwnerPortfolioInitialMergeResolution,
} from './owner-portfolio-merge'

const KEY = '000001::synthetic-old', OTHER = '000002::synthetic-other', FRESH = '000001::synthetic-new'
const ASSET = 'asset:synthetic-manual', PRIVATE = 'synthetic-private-never-echo'
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fund(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, ...patch } as OwnerSyncRecord
}
function cloudManual(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return fund({ key: ASSET, kind: 'manual_asset', field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: 'synthetic-cash', cls: '现金', value: 0, note: null }, ...patch })
}
function entry(source: OwnerSyncRecord = fund(), patch: Record<string, unknown> = {}): OwnerWorkspaceEntry {
  if (source.kind === 'manual_asset') throw new Error('fund fixture cannot project a manual record')
  return { key: source.key, kind: source.kind, deleted: source.deleted, values: {
    name: source.values.name as string, shares: source.values.shares as number | null,
    cost: source.values.cost as number | null, target_weight: source.values.target_weight as number | null,
  }, local_pending: true, ...patch } as OwnerWorkspaceEntry
}
function asset(patch: Record<string, unknown> = {}): OwnerPortfolioManual {
  return { key: ASSET, legacyId: null, deleted: false, values: { name: 'synthetic-cash', cls: '现金', value: 0, note: null },
    updated_at: '2026-10-22T00:00:00Z', local_pending: true, ...patch } as OwnerPortfolioManual
}
function portfolio(rows: readonly OwnerPortfolioManual[] = []): OwnerPortfolioLocal {
  const source = { manualRaw: null, snapshotsRaw: null }
  return { schema: 'owner-portfolio-local-1', manual: rows, history: [], migration: { ...source,
    sourceSha256: createHash('sha256').update(canonicalOwnerLocal(source), 'utf8').digest('hex'), idMappings: [] } }
}
function baseline(records: readonly OwnerSyncRecord[] = [fund()]): OwnerSyncBaseline {
  return { pulledRevision: Math.max(0, ...records.map(row => row.record_revision)), records }
}
function snapshot(rows: readonly OwnerWorkspaceEntry[] = [entry()]): OwnerWorkspaceSnapshot {
  return { localVersion: 7, entries: rows, legacy: { sourceKey: 'sinan_watchlist_v2', raw: PRIVATE } }
}
function changed(source: OwnerSyncRecord, changes: Record<string, unknown>, at = 2, patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return fund({ ...source, record_revision: at, values: { ...source.values, ...changes },
    field_revisions: { ...source.field_revisions, ...Object.fromEntries(Object.keys(changes).map(key => [key, at])) }, ...patch })
}
function input(patch: Partial<OwnerPortfolioInitialMergeInput> = {}): OwnerPortfolioInitialMergeInput {
  return { base: baseline(), localSnapshot: snapshot(), portfolio: portfolio(), completeBaseline: baseline(),
    minimumObservedRevision: 0, resolutions: [], ...patch }
}
function invalid(source: unknown, code: string) {
  const result = previewOwnerPortfolioInitialMerge(source)
  expect(result.issues[0].code).toBe(code)
  expect(result).toMatchObject({ schema: 'owner-portfolio-initial-merge-1', nextSnapshot: null,
    nextPortfolio: null, baseC: null, remainingOperations: [], conflicts: [], rows: [] })
  expect(JSON.stringify(result)).not.toContain(PRIVATE)
  return result
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen) }
}
function resolution(key: string, field: OwnerPortfolioInitialMergeResolution['field'], choice: 'local' | 'cloud'): OwnerPortfolioInitialMergeResolution {
  return { key, field, choice }
}

describe('first complete portfolio link keeps the actually applied fund ancestor', () => {
  it('links independent local name / other-device shares, absorbs unedited C and retains only the real local patch', () => {
    const before = fund(), local = entry(before, { values: { ...before.values, name: 'local-name' } }),
      cloud = changed(before, { shares: 23 }), original = input({ localSnapshot: snapshot([local]), completeBaseline: baseline([cloud]) })
    const raw = canonicalOwnerLocal(original), result = previewOwnerPortfolioInitialMerge(original)
    expect(result.issues).toEqual([]); expect(result.conflicts).toEqual([])
    expect(result.nextSnapshot).toEqual({ ...original.localSnapshot,
      entries: [{ ...local, values: { ...local.values, shares: 23 } }] })
    expect(result.baseC).toEqual(original.completeBaseline)
    expect(result.nextPortfolio).toEqual(original.portfolio)
    expect(result.remainingOperations).toEqual([{ key: KEY, kind: 'holding', deleted: false,
      changes: { name: 'local-name' }, base_values: { kind: 'holding', deleted: false, name: before.values.name } }])
    expect(result.rows[0].fields).toEqual(['shares', 'name'])
    expect(canonicalOwnerLocal(original)).toBe(raw); expect(Object.isFrozen(original)).toBe(false); frozen(result)
  })
  it('shows retained intent even when no local postimage field changes, and never clears local_pending', () => {
    const before = fund(), local = entry(before, { local_pending: false, values: { ...before.values, cost: 8 } }),
      result = previewOwnerPortfolioInitialMerge(input({ localSnapshot: snapshot([local]) }))
    expect(result.issues).toEqual([])
    expect(result.rows).toMatchObject([{ key: KEY, before: { local_pending: false }, after: { local_pending: true }, fields: ['cost'] }])
    expect(result.nextSnapshot!.localVersion).toBe(7)
    expect(result.remainingOperations[0].changes).toEqual({ cost: 8 })
  })
  it.each([
    ['field_changed', 9, 8, 2],
    ['field_changed', 8, 8, 2], // Same-value convergence is still two observed edits.
    ['field_aba', null, 8, 3],
  ] as const)('requires explicit selection for %s (C=%s, L=%s, revision=%s)', (reason, cloudCost, localCost, at) => {
    const before = fund(), current = changed(before, { cost: cloudCost }, at),
      source = input({ localSnapshot: snapshot([entry(before, { values: { ...before.values, cost: localCost } })]),
        completeBaseline: baseline([current]) }), result = previewOwnerPortfolioInitialMerge(source)
    expect(result.issues).toEqual([]); expect(result.nextSnapshot).toBeNull(); expect(result.nextPortfolio).toBeNull()
    expect(result.conflicts).toMatchObject([{ key: KEY, field: 'cost', reason, choice: null }])
    for (const choice of ['local', 'cloud'] as const) {
      const selected = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(KEY, 'cost', choice)] })
      expect(selected.issues).toEqual([]); expect(selected.conflicts[0].choice).toBe(choice)
      expect(selected.nextSnapshot!.entries[0].values.cost).toBe(choice === 'local' ? localCost : cloudCost)
      expect(selected.remainingOperations).toHaveLength(choice === 'local' && localCost !== cloudCost ? 1 : 0)
    }
  })
  it('absorbs C when L has no edit, including cloud deletion and cloud-only fund/manual tombstones', () => {
    const deleted = fund({ deleted: true, record_revision: 2, lifecycle_revision: 2 }),
      other = fund({ key: OTHER, record_revision: 2, lifecycle_revision: 2,
        field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }),
      manual = cloudManual({ deleted: true, record_revision: 2, lifecycle_revision: 2,
        field_revisions: { name: 2, cls: 2, value: 2, note: 2 } }),
      result = previewOwnerPortfolioInitialMerge(input({ completeBaseline: baseline([deleted, other, manual]) }))
    expect(result.issues).toEqual([]); expect(result.conflicts).toEqual([]); expect(result.remainingOperations).toEqual([])
    expect(result.nextSnapshot!.entries).toEqual([entry(deleted), entry(other)])
    expect(result.nextPortfolio!.manual).toEqual([asset({ deleted: true, legacyId: null, updated_at: null })])
  })
  it.each(['lifecycle_changed', 'lifecycle_aba'] as const)('makes %s an entire-row conflict instead of mixing lifecycle with fields', reason => {
    const before = fund(), current = reason === 'lifecycle_aba'
      ? fund({ record_revision: 2, lifecycle_revision: 2 })
      : fund({ kind: 'watch', record_revision: 2, lifecycle_revision: 2,
        field_revisions: { name: 1, shares: 2, cost: 1, target_weight: 1 }, values: { ...before.values, shares: null } }),
      source = input({ localSnapshot: snapshot([entry(before, { values: { ...before.values, name: 'local-name' } })]),
        completeBaseline: baseline([current]) }), unresolved = previewOwnerPortfolioInitialMerge(source)
    expect(unresolved.conflicts).toMatchObject([{ key: KEY, field: 'lifecycle', reason }])
    const selected = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(KEY, 'lifecycle', 'cloud')] })
    expect(selected.issues).toEqual([]); expect(selected.nextSnapshot!.entries[0]).toEqual(entry(current))
    expect(selected.remainingOperations).toEqual([])
  })
  it('keeps a safe local kind transition / deletion when C has not advanced, with full original guards', () => {
    const before = fund()
    for (const local of [entry(before, { deleted: true }), entry(before, { kind: 'watch', values: { ...before.values, shares: null } })]) {
      const result = previewOwnerPortfolioInitialMerge(input({ localSnapshot: snapshot([local]) }))
      expect(result.issues).toEqual([]); expect(result.conflicts).toEqual([])
      expect(result.nextSnapshot!.entries).toEqual([local])
      expect(result.remainingOperations[0].base_values).toEqual({ ...before.values, kind: before.kind, deleted: before.deleted })
    }
  })
  it('requires entire-row selection when local delete and remote field edit both advance', () => {
    const source = input({ localSnapshot: snapshot([entry(fund(), { deleted: true })]),
      completeBaseline: baseline([changed(fund(), { name: 'cloud-name' })]) })
    expect(previewOwnerPortfolioInitialMerge(source).conflicts).toMatchObject([{ key: KEY, field: 'lifecycle', reason: 'lifecycle_changed' }])
    const selected = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(KEY, 'lifecycle', 'local')] })
    expect(selected.remainingOperations[0]).toMatchObject({ deleted: true, base_values: { name: 'cloud-name' } })
  })
  it('accepts equal create collisions but requires explicit selection for differing unlinked fund identities', () => {
    const source = input({ base: null })
    expect(previewOwnerPortfolioInitialMerge(source).conflicts).toEqual([])
    const collision = { ...source, localSnapshot: snapshot([entry(fund(), { values: { ...fund().values, name: 'new-local' } })]) }
    expect(previewOwnerPortfolioInitialMerge(collision).conflicts).toMatchObject([{ field: 'lifecycle', reason: 'creation_collision', base: null }])
    expect(previewOwnerPortfolioInitialMerge({ ...collision, resolutions: [resolution(KEY, 'lifecycle', 'local')] }).remainingOperations[0].changes)
      .toEqual({ name: 'new-local' })
  })
  it.each([false, true])('never permits local revival of a cloud tombstone (B tombstone=%s)', wasDeleted => {
    const before = fund({ deleted: wasDeleted }), current = wasDeleted ? before
      : fund({ deleted: true, record_revision: 2, lifecycle_revision: 2 }),
      source = input({ base: baseline([before]), localSnapshot: snapshot([entry(fund(), { values: { ...fund().values, cost: 8 } })]),
        completeBaseline: baseline([current]) }), result = previewOwnerPortfolioInitialMerge(source)
    expect(result.conflicts).toMatchObject([{ field: 'lifecycle', reason: 'cloud_tombstone', localAllowed: false }])
    invalid({ ...source, resolutions: [resolution(KEY, 'lifecycle', 'local')] }, 'invalid_resolution')
    const selected = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(KEY, 'lifecycle', 'cloud')] })
    expect(selected.issues).toEqual([]); expect(selected.nextSnapshot!.entries[0].deleted).toBe(true)
  })
})

describe('conservative account rename groups', () => {
  function rename() {
    return input({ localSnapshot: snapshot([entry(fund(), { deleted: true }), entry(fund({ key: FRESH }))]),
      completeBaseline: baseline([changed(fund(), { name: 'cloud-name' })]) })
  }
  it('resolves the entire same-code tombstone + fresh account group and retains a cancelled local key tombstone', () => {
    const source = rename(), unresolved = previewOwnerPortfolioInitialMerge(source), group = unresolved.conflicts[0]
    expect(unresolved.conflicts).toHaveLength(1)
    expect(group).toMatchObject({ field: 'rename', reason: 'rename_atomic', localAllowed: true, groupKeys: [FRESH, KEY] })
    const selected = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(group.key, 'rename', 'cloud')] })
    expect(selected.issues).toEqual([])
    expect(selected.nextSnapshot!.entries).toEqual([entry(source.completeBaseline.records[0]), entry(fund({ key: FRESH }), { deleted: true })])
    expect(selected.remainingOperations).toEqual([])
    expect(selected.rows.find(row => row.key === FRESH)!.after!.deleted).toBe(true)
    const kept = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(group.key, 'rename', 'local')] })
    expect(kept.issues).toEqual([]); expect(kept.remainingOperations.map(row => [row.key, row.deleted])).toEqual([[KEY, true], [FRESH, false]])
  })
  it('forbids a local group selection when the new account is a cloud tombstone', () => {
    const tombstone = fund({ key: FRESH, deleted: true, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }), source = { ...rename(), completeBaseline: baseline([fund(), tombstone]) },
      result = previewOwnerPortfolioInitialMerge(source)
    expect(result.conflicts).toMatchObject([{ field: 'rename', localAllowed: false }])
    invalid({ ...source, resolutions: [resolution(result.conflicts[0].key, 'rename', 'local')] }, 'invalid_resolution')
  })
  it('does not accept a stale per-field choice after conflicts were collapsed into a rename group', () => {
    invalid({ ...rename(), resolutions: [resolution(KEY, 'lifecycle', 'cloud')] }, 'invalid_resolution')
  })
})

describe('manual bootstrap has no invented common ancestor', () => {
  it('never treats old fund-only B manual values as applied, even if C is unchanged', () => {
    const before = cloudManual(), local = asset({ values: { ...asset().values, value: 8 } }),
      source = input({ base: baseline([fund(), before]), portfolio: portfolio([local]), completeBaseline: baseline([fund(), before]) }),
      result = previewOwnerPortfolioInitialMerge(source)
    expect(result.issues).toEqual([])
    expect(result.conflicts).toMatchObject([{ key: ASSET, field: 'lifecycle', reason: 'bootstrap_difference', base: null }])
    expect(result.nextPortfolio).toBeNull()
    const selected = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(ASSET, 'lifecycle', 'local')] })
    expect(selected.issues).toEqual([]); expect(selected.nextPortfolio!.manual[0]).toEqual(local)
    expect(selected.remainingOperations).toEqual([{ key: ASSET, kind: 'manual_asset', deleted: false,
      changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: 0 } }])
  })
  it('requires one bootstrap choice instead of auto-merging distinct L/C manual fields based on old B', () => {
    const before = cloudManual(), current = changed(before, { note: 'other-device-note' }),
      source = input({ base: baseline([fund(), before]), completeBaseline: baseline([fund(), current]),
        portfolio: portfolio([asset({ values: { ...asset().values, value: 8 } })]) })
    expect(previewOwnerPortfolioInitialMerge(source).conflicts).toMatchObject([{ field: 'lifecycle', reason: 'bootstrap_difference', base: null }])
    const kept = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(ASSET, 'lifecycle', 'local')] })
    expect(kept.remainingOperations[0].changes).toEqual({ value: 8, note: null })
  })
  it('imports cloud-only active / deleted manual rows with unknown local origin/time and no invented zero', () => {
    const current = cloudManual({ values: { name: 'synthetic-cash', cls: '现金', value: -0, note: null } }),
      gone = cloudManual({ key: 'asset:gone', deleted: true }),
      source = input({ base: null, completeBaseline: baseline([fund(), current, gone]) }), result = previewOwnerPortfolioInitialMerge(source)
    expect(result.issues).toEqual([]); expect(result.nextPortfolio!.manual).toHaveLength(2)
    const imported = result.nextPortfolio!.manual.find(row => row.key === ASSET)!
    expect(imported).toMatchObject({ legacyId: null, updated_at: null, local_pending: true, values: { note: null } })
    expect(Object.is(imported.values.value, -0)).toBe(true)
    expect(result.nextPortfolio!.manual.find(row => row.key === 'asset:gone')!.deleted).toBe(true)
    expect(result.remainingOperations).toEqual([])
  })
  it('preserves legacyId/raw/history, duplicate old dates, local signed zero and original/null updated_at through explicit cloud selection', async () => {
    const manualRaw = ' \n' + canonicalOwnerLocal([{ id: 'synthetic-manual', name: 'synthetic-cash', cls: '现金', value: -0,
      updated_at: '2026-10-22T23:00:00.12Z' }]) + '\r\n', snapshotsRaw = canonicalOwnerLocal([
      { date: '2026-10-22', value: -0, cost: 0 }, { date: '2026-10-22', value: 9, cost: 7 },
    ]), migrated = (await previewOwnerPortfolioMigration({ manualRaw, snapshotsRaw })).portfolio!,
      current = cloudManual({ values: { ...cloudManual().values, note: 'cloud-note' } }),
      source = input({ base: null, portfolio: migrated, completeBaseline: baseline([fund(), current]),
        resolutions: [resolution(ASSET, 'lifecycle', 'cloud')] }), result = previewOwnerPortfolioInitialMerge(source)
    expect(result.issues).toEqual([])
    expect(result.nextPortfolio!.migration).toEqual(migrated.migration)
    expect(result.nextPortfolio!.history).toEqual(migrated.history)
    expect(result.nextPortfolio!.migration.manualRaw).toBe(manualRaw)
    expect(result.nextPortfolio!.migration.snapshotsRaw).toBe(snapshotsRaw)
    expect(result.nextPortfolio!.manual[0]).toMatchObject({ legacyId: 'synthetic-manual', updated_at: '2026-10-22T23:00:00.12Z', values: { note: 'cloud-note' } })
    expect(Object.is(result.nextPortfolio!.manual[0].values.value, -0)).toBe(true)
    expect(Object.is(result.nextPortfolio!.history[0].value, -0)).toBe(true)
    expect(JSON.stringify(result.remainingOperations)).not.toMatch(/history|legacyId|updated_at|local_pending|migration/)
    const nullTime = asset({ updated_at: null, values: { ...asset().values, value: 8 } })
    const selected = previewOwnerPortfolioInitialMerge(input({ base: null, portfolio: portfolio([nullTime]), completeBaseline: baseline([fund(), current]),
      resolutions: [resolution(ASSET, 'lifecycle', 'cloud')] }))
    expect(selected.nextPortfolio!.manual[0].updated_at).toBeNull()
  })
  it('retains unlinked local manual live/deleted rows and uploads only real live intent, never history', () => {
    const local = portfolio([asset(), asset({ key: 'asset:local-gone', deleted: true })]), result = previewOwnerPortfolioInitialMerge(input({ portfolio: local }))
    expect(result.issues).toEqual([]); expect(result.nextPortfolio).toEqual(local)
    expect(result.remainingOperations).toEqual([{ key: ASSET, kind: 'manual_asset', deleted: false,
      changes: asset().values, base_values: {} }])
  })
  it('requires explicit choice for local tombstone versus cloud active, and explicit cloud merge is not a save_manual resurrection', () => {
    const local = asset({ deleted: true }), source = input({ base: null, portfolio: portfolio([local]), completeBaseline: baseline([fund(), cloudManual()]) }),
      result = previewOwnerPortfolioInitialMerge(source)
    expect(result.conflicts).toMatchObject([{ key: ASSET, field: 'lifecycle', reason: 'bootstrap_difference', localAllowed: true }])
    const kept = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(ASSET, 'lifecycle', 'local')] })
    expect(kept.nextPortfolio!.manual[0].deleted).toBe(true); expect(kept.remainingOperations[0].deleted).toBe(true)
    const cloud = previewOwnerPortfolioInitialMerge({ ...source, resolutions: [resolution(ASSET, 'lifecycle', 'cloud')] })
    expect(cloud.nextPortfolio!.manual[0]).toEqual({ ...local, deleted: false }); expect(cloud.remainingOperations).toEqual([])
  })
  it('never allows a local active manual to revive a cloud tombstone', () => {
    const source = input({ base: null, portfolio: portfolio([asset()]), completeBaseline: baseline([fund(), cloudManual({ deleted: true })]) })
    expect(previewOwnerPortfolioInitialMerge(source).conflicts).toMatchObject([{ key: ASSET, reason: 'cloud_tombstone', localAllowed: false }])
    invalid({ ...source, resolutions: [resolution(ASSET, 'lifecycle', 'local')] }, 'invalid_resolution')
  })
  it('keeps negative-zero business equality but preserves null/zero differences and unknown holding shares', () => {
    const before = fund({ values: { ...fund().values, shares: null, cost: -0 } }),
      result = previewOwnerPortfolioInitialMerge(input({ base: baseline([before]), localSnapshot: snapshot([entry(before,
        { values: { ...before.values, name: 'local-name', target_weight: -0 } })]), completeBaseline: baseline([before]),
        portfolio: portfolio([asset({ values: { ...asset().values, value: -0 } })]) }))
    expect(result.issues).toEqual([])
    expect(result.nextSnapshot!.entries[0].values.shares).toBeNull()
    expect(Object.is(result.nextSnapshot!.entries[0].values.cost, -0)).toBe(true)
    expect(Object.is(result.nextSnapshot!.entries[0].values.target_weight, -0)).toBe(true)
    expect(result.remainingOperations[0].changes).toEqual({ name: 'local-name', target_weight: -0 })
    expect(Object.is(result.nextPortfolio!.manual[0].values.value, -0)).toBe(true)
  })
})

describe('complete C progress / closed boundaries and real builder limits', () => {
  it('rejects missing linked fund rows, never translates absence into delete', () => {
    invalid(input({ localSnapshot: snapshot([]) }), 'missing_workspace_record')
    invalid(input({ completeBaseline: baseline([]) }), 'baseline_regression')
    invalid(input({ completeBaseline: baseline([fund({ key: OTHER, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } })]) }), 'missing_cloud_record')
  })
  it('requires observed old manual rows to remain in C even though they were never applied to L', () => {
    invalid(input({ base: baseline([fund(), cloudManual()]), completeBaseline: baseline([changed(fund(), { name: 'new' })]) }), 'missing_cloud_record')
  })
  it.each([
    { minimumObservedRevision: 2 },
    { completeBaseline: baseline([fund({ values: { ...fund().values, name: 'changed-without-stamp' } })]) },
    { completeBaseline: baseline([fund({ record_revision: 2, values: { ...fund().values, cost: 8 } })]) },
    { base: baseline([fund({ record_revision: 2 })]), completeBaseline: baseline([fund({ record_revision: 2 }), fund({ key: OTHER })]) },
    { base: baseline([fund({ record_revision: 3, field_revisions: { name: 1, shares: 3, cost: 1, target_weight: 1 } })]),
      completeBaseline: baseline([fund({ record_revision: 4, field_revisions: { name: 1, shares: 2, cost: 1, target_weight: 1 } })]) },
  ])('rejects C head/stamp regression without manufacturing a matched receipt (%j)', patch => {
    invalid(input(patch), 'baseline_regression')
  })
  it.each([NaN, Infinity, -0, -1, 0.5, true, '1'])('rejects non-revision observed floor %s', value => {
    invalid({ ...input(), minimumObservedRevision: value }, 'invalid_input')
  })
  it.each([
    ['top field', (source: any) => ({ ...source, secret: PRIVATE }), 'invalid_input'],
    ['missing top field', (source: any) => { delete source.portfolio; return source }, 'invalid_input'],
    ['base field', (source: any) => ({ ...source, base: { ...source.base, secret: PRIVATE } }), 'invalid_baseline'],
    ['C field', (source: any) => ({ ...source, completeBaseline: { ...source.completeBaseline, secret: PRIVATE } }), 'invalid_baseline'],
    ['workspace field', (source: any) => ({ ...source, localSnapshot: { ...source.localSnapshot, secret: PRIVATE } }), 'invalid_workspace'],
    ['portfolio field', (source: any) => ({ ...source, portfolio: { ...source.portfolio, secret: PRIVATE } }), 'invalid_portfolio'],
    ['bad history', (source: any) => ({ ...source, portfolio: { ...source.portfolio, history: [{ id: PRIVATE }] } }), 'invalid_portfolio'],
    ['duplicate manual', (source: any) => ({ ...source, portfolio: portfolio([asset(), asset()]) }), 'invalid_portfolio'],
    ['fake receipt', (source: any) => ({ ...source, matchedResult: { rawBody: PRIVATE } }), 'invalid_input'],
    ['unused choice', (source: any) => ({ ...source, resolutions: [resolution(KEY, 'name', 'local')] }), 'invalid_resolution'],
    ['unknown choice field', (source: any) => ({ ...source, resolutions: [{ key: KEY, field: 'future', choice: 'local' }] }), 'invalid_resolution'],
    ['duplicate choice', (source: any) => ({ ...source, resolutions: [resolution(KEY, 'name', 'local'), resolution(KEY, 'name', 'local')] }), 'invalid_resolution'],
    ['extra choice field', (source: any) => ({ ...source, resolutions: [{ ...resolution(KEY, 'name', 'local'), secret: PRIVATE }] }), 'invalid_resolution'],
    ['sparse array', (source: any) => ({ ...source, resolutions: new Array(1) }), 'invalid_resolution'],
    ['response subset', (source: any) => ({ ...source, completeBaseline: { pulledRevision: 2, records: source.base.records } }), 'invalid_baseline'],
  ] as const)('rejects %s and never echoes private raw', (_label, transform, code) => {
    invalid(transform(input()), code)
  })
  it('rejects getters / symbols / hidden fields without invoking getters or ambient IO', () => {
    const forbidden = vi.fn(() => { throw new Error('must not run') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    vi.stubGlobal('crypto', { subtle: { digest: forbidden } })
    const top = input(); Object.defineProperty(top, 'base', { enumerable: true, get: forbidden }); invalid(top, 'invalid_input')
    const nested = input(); Object.defineProperty(nested.localSnapshot.entries[0].values, 'name', { enumerable: true, get: forbidden }); invalid(nested, 'invalid_workspace')
    const manualGetter = input({ portfolio: portfolio([asset()]) })
    Object.defineProperty(manualGetter.portfolio.manual[0].values, 'value', { enumerable: true, get: forbidden }); invalid(manualGetter, 'invalid_portfolio')
    const hidden = input(); Object.defineProperty(hidden, 'secret', { value: PRIVATE, enumerable: false }); invalid(hidden, 'invalid_input')
    const symbol = input(); Object.defineProperty(symbol, Symbol('private'), { value: PRIVATE, enumerable: true }); invalid(symbol, 'invalid_input')
    expect(previewOwnerPortfolioInitialMerge(input()).issues).toEqual([])
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('returns no writable partial image if a retained local create cannot pass the real planner', () => {
    const unknown = entry(fund({ key: OTHER }), { values: { ...fund().values, shares: null } }),
      result = previewOwnerPortfolioInitialMerge(input({ localSnapshot: snapshot([entry(), unknown]) }))
    expect(result.issues).toEqual([{ code: 'missing_value', key: OTHER }])
    expect(result.nextSnapshot).toBeNull(); expect(result.nextPortfolio).toBeNull(); expect(result.remainingOperations).toEqual([])
  })
  it('does not trim 201 remaining operations or falsely claim packet-builder acceptance', async () => {
    const local = portfolio(Array.from({ length: 201 }, (_, index) => asset({ key: 'asset:synthetic-' + index }))),
      result = previewOwnerPortfolioInitialMerge(input({ base: null, localSnapshot: snapshot([]), portfolio: local, completeBaseline: baseline([]) }))
    expect(result.issues).toEqual([]); expect(result.remainingOperations).toHaveLength(201); expect(result.rows).toHaveLength(201)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-merge-count', expected_revision: 0, operations: result.remainingOperations }))
      .rejects.toMatchObject({ code: 'invalid_sync_request' })
  })
  it('does not trim over128KiB remaining manual intent; the real request builder rejects it', async () => {
    const local = portfolio(Array.from({ length: 200 }, (_, index) => asset({ key: 'asset:synthetic-' + index,
      values: { ...asset().values, note: '中'.repeat(400) } }))),
      result = previewOwnerPortfolioInitialMerge(input({ base: null, localSnapshot: snapshot([]), portfolio: local, completeBaseline: baseline([]) }))
    expect(result.issues).toEqual([]); expect(result.remainingOperations).toHaveLength(200)
    expect(new TextEncoder().encode(JSON.stringify(result.remainingOperations)).byteLength).toBeGreaterThan(OWNER_SYNC_MAX_BODY_BYTES)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-merge-bytes', expected_revision: 0, operations: result.remainingOperations }))
      .rejects.toMatchObject({ code: 'invalid_sync_request' })
  })
  it('enforces full portfolio capacity instead of dropping cloud-only manual rows', () => {
    const local = portfolio(Array.from({ length: 2000 }, (_, index) => asset({ key: 'asset:synthetic-' + index })))
    invalid(input({ base: null, portfolio: local, completeBaseline: baseline([fund(), cloudManual({ key: 'asset:one-too-many' })]) }), 'capacity_exceeded')
  })
  it('accepts codec-owned portfolios but never trusts arbitrary caller-frozen images', () => {
    const owned = validateOwnerPortfolioLocal(portfolio([asset()]))
    expect(previewOwnerPortfolioInitialMerge(input({ portfolio: owned })).issues).toEqual([])
    invalid(input({ portfolio: Object.freeze({ ...owned, secret: PRIVATE }) }), 'invalid_portfolio')
  })
})
