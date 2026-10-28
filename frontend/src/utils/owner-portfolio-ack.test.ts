/** Real packet builder/restorer and response codecs with synthetic bytes. Pure
 * association/merge tests do not authenticate a source, perform a POST, commit
 * IDB or prove cloud durability. No legacy ACK or validator is mocked. */
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import type { OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from './owner-cloud-import'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import { previewOwnerPortfolioMigration, type OwnerPortfolioLocal, type OwnerPortfolioManual } from './ownerPortfolioLocal'
import { planOwnerPortfolioCloudIntent } from './owner-portfolio-sync'
import {
  buildOwnerSyncRequest, restoreOwnerSyncRequest, OWNER_SYNC_MAX_BODY_BYTES,
  type OwnerSyncRecord, type OwnerSyncWriteResult,
} from './ownerSyncContract'
import {
  buildOwnerPortfolioAckPreview, type OwnerPortfolioAckInput, type OwnerPortfolioAckResolution,
} from './owner-portfolio-ack'

const KEY = '000001::synthetic-account', OTHER = '000002::synthetic-other', FRESH = '000001::synthetic-renamed'
const ASSET = 'asset:synthetic-cash', PRIVATE = 'synthetic-private-never-echo'
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
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
function changed(source: OwnerSyncRecord, changes: Record<string, string | number | null>, at = 2, patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { ...source, record_revision: at, values: { ...source.values, ...changes },
    field_revisions: { ...source.field_revisions, ...Object.fromEntries(Object.keys(changes).map(key => [key, at])) }, ...patch }
}
function entry(source = fund(), patch: Partial<OwnerWorkspaceEntry> = {}): OwnerWorkspaceEntry {
  if (source.kind === 'manual_asset') throw new Error('fund fixture cannot project manual')
  return { key: source.key, kind: source.kind, deleted: source.deleted, local_pending: true,
    values: { name: source.values.name as string, shares: source.values.shares as number | null,
      cost: source.values.cost as number | null, target_weight: source.values.target_weight as number | null }, ...patch }
}
function asset(source = manual(), patch: Partial<OwnerPortfolioManual> = {}): OwnerPortfolioManual {
  if (source.kind !== 'manual_asset') throw new Error('manual fixture cannot project fund')
  return { key: source.key, legacyId: null, deleted: source.deleted, local_pending: true, updated_at: '2026-10-24T00:00:00Z',
    values: { name: source.values.name as string, cls: source.values.cls as OwnerPortfolioManual['values']['cls'],
      value: source.values.value as number, note: source.values.note as string | null }, ...patch }
}
function snapshot(entries: readonly OwnerWorkspaceEntry[] = [entry(fund(), { values: { ...entry().values, cost: 8 } })]): OwnerWorkspaceSnapshot {
  return { localVersion: 7, entries, legacy: { sourceKey: 'sinan_watchlist_v2', raw: PRIVATE } }
}
function portfolio(rows: readonly OwnerPortfolioManual[] = [asset(manual(), { values: { ...asset().values, value: 8 } })]): OwnerPortfolioLocal {
  const source = { manualRaw: null, snapshotsRaw: null }
  return { schema: 'owner-portfolio-local-1', manual: rows, history: [], migration: { ...source,
    sourceSha256: createHash('sha256').update(canonicalOwnerLocal(source), 'utf8').digest('hex'), idMappings: [] } }
}
function baseline(records: readonly OwnerSyncRecord[] = [fund(), manual()]): OwnerSyncBaseline {
  return { pulledRevision: Math.max(0, ...records.map(row => row.record_revision)), records }
}
const digest = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
function rawConflict(items: readonly { key: string; fields: readonly string[] }[]): string {
  return JSON.stringify({ error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
    conflicts: items.map(row => ({ key_digest: digest(row.key), fields: [...row.fields].sort() })) })
}
async function fixture(options: {
  base?: OwnerSyncBaseline; local?: OwnerWorkspaceSnapshot; portfolio?: OwnerPortfolioLocal; cloud?: OwnerSyncBaseline;
  success?: OwnerSyncWriteResult; conflicts?: readonly { key: string; fields: readonly string[] }[];
  receipt?: boolean; observed?: number; resolutions?: readonly OwnerPortfolioAckResolution[];
} = {}): Promise<OwnerPortfolioAckInput> {
  const base = options.base ?? baseline(), local = options.local ?? snapshot(), assets = options.portfolio ?? portfolio(),
    intent = planOwnerPortfolioCloudIntent(base, local, assets)
  expect(intent.issues).toEqual([])
  const built = await buildOwnerSyncRequest({ request_id: 'synthetic-full-ack-request', expected_revision: base.pulledRevision, operations: intent.operations }),
    packet = await restoreOwnerSyncRequest(built.rawBody, built.requestHash), success = options.success
      ?? { revision: 2, records: [changed(fund(), { cost: 8 }), changed(manual(), { value: 8 })] },
    post = new Map(success.records.map(row => [row.key, row])),
    full = [...base.records.filter(row => !post.has(row.key)), ...success.records], status = options.conflicts ? 409 : 200,
    result = options.conflicts ? JSON.parse(rawConflict(options.conflicts)) : success
  return { base, localSnapshot: local, portfolio: assets, packet,
    matchedResult: { source: options.receipt ? 'receipt' : 'write', requestId: packet.request.request_id,
      requestHash: packet.requestHash, status: options.receipt ? 200 : status,
      rawBody: JSON.stringify(options.receipt ? { state: 'matched', status, result } : result) },
    completeBaseline: options.cloud ?? baseline(full), minimumObservedRevision: options.observed ?? 0,
    keyDigests: packet.request.operations.map(operation => ({ key: operation.key, digest: digest(operation.key) })), resolutions: options.resolutions ?? [] }
}
function choice(key: string, field: OwnerPortfolioAckResolution['field'], side: 'local' | 'cloud'): OwnerPortfolioAckResolution {
  return { key, field, choice: side }
}
function invalid(source: unknown, code?: string) {
  const result = buildOwnerPortfolioAckPreview(source)
  expect(result.issues.length).toBeGreaterThan(0)
  if (code) expect(result.issues[0].code).toBe(code)
  expect(result).toMatchObject({ schema: 'owner-portfolio-ack-preview-1', outcome: null, nextSnapshot: null,
    nextPortfolio: null, baseD: null, conflicts: [], rows: [], changedKeys: [] })
  expect(JSON.stringify(result)).not.toContain(PRIVATE)
  return result
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen) }
}

describe('full portfolio raw matched success and complete D', () => {
  it.each([false, true])('verifies the original real full packet and raw write/receipt association (receipt=%s)', async receipt => {
    const source = await fixture({ receipt }), original = canonicalOwnerLocal(source), result = buildOwnerPortfolioAckPreview(source)
    expect(source.packet.request.operations.map(row => row.kind)).toEqual(['holding', 'manual_asset'])
    expect(result.issues).toEqual([]); expect(result.outcome).toBe('success'); expect(result.conflicts).toEqual([])
    expect(result.nextSnapshot).toEqual(source.localSnapshot); expect(result.nextPortfolio).toEqual(source.portfolio)
    expect(result.baseD).toEqual(source.completeBaseline); expect(result.changedKeys).toEqual([]); expect(result.rows).toEqual([])
    expect(result).not.toHaveProperty('excludedManualAssets')
    expect(result.nextSnapshot!.localVersion).toBe(7)
    expect(canonicalOwnerLocal(source)).toBe(original); expect(Object.isFrozen(source)).toBe(false); frozen(result)
  })
  it('consumes successful submitted manual intent, then adopts later full D rather than replaying L or partial POST', async () => {
    const post = changed(manual(), { value: 8 }), later = changed(post, { value: 20, cls: '商品', note: '' }, 4),
      extra = manual({ key: 'asset:cloud-only', record_revision: 3, lifecycle_revision: 3,
        field_revisions: { name: 3, cls: 3, value: 3, note: 3 } }),
      source = await fixture({ cloud: baseline([changed(fund(), { cost: 8 }), later, extra]) }), result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([])
    expect(result.nextPortfolio!.manual[0]).toEqual({ ...source.portfolio.manual[0], values: later.values })
    expect(result.nextPortfolio!.manual[1]).toEqual({ ...asset(extra), legacyId: null, updated_at: null })
    expect(result.changedKeys).toEqual([ASSET, 'asset:cloud-only'])
    expect(result.rows[0].fields).toEqual(['cls', 'value', 'note'])
    expect(planOwnerPortfolioCloudIntent(result.baseD, result.nextSnapshot, result.nextPortfolio)).toEqual({ operations: [], issues: [] })
  })
  it('retains original raw/history/legacy identity/time and negative zero while adopting successful manual business fields', async () => {
    const manualRaw = ' \n' + canonicalOwnerLocal([{ id: 'synthetic-cash', name: 'synthetic-cash', cls: '现金', value: -0,
      updated_at: '2026-10-24T00:00:00.12Z' }]) + '\r\n', snapshotsRaw = canonicalOwnerLocal([
      { date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 3, cost: 4 },
    ]), migrated = (await previewOwnerPortfolioMigration({ manualRaw, snapshotsRaw })).portfolio!,
      local = { ...migrated, manual: migrated.manual.map(row => ({ ...row, values: { ...row.values, note: '' } })) },
      post = changed(manual(), { note: '' }), source = await fixture({ portfolio: local,
        success: { revision: 2, records: [changed(fund(), { cost: 8 }), post] } }), result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([])
    expect(result.nextPortfolio!.migration).toEqual(migrated.migration); expect(result.nextPortfolio!.history).toEqual(migrated.history)
    expect(result.nextPortfolio!.manual[0]).toMatchObject({ legacyId: 'synthetic-cash', updated_at: '2026-10-24T00:00:00.12Z', values: { note: '' } })
    expect(Object.is(result.nextPortfolio!.manual[0].values.value, -0)).toBe(true)
    expect(Object.is(result.nextPortfolio!.history[0].value, -0)).toBe(true)
    expect(result.nextPortfolio!.migration.manualRaw).toBe(manualRaw); expect(result.nextPortfolio!.migration.snapshotsRaw).toBe(snapshotsRaw)
  })
  it('verifies manual full deletion against untouched old values/stamps and full lifecycle revision', async () => {
    const before = manual({ values: { ...manual().values, value: -0, note: '' } }), deleted = { ...before, deleted: true, record_revision: 2, lifecycle_revision: 2 },
      source = await fixture({ base: baseline([fund(), before]), portfolio: portfolio([asset(before, { deleted: true })]),
        success: { revision: 2, records: [changed(fund(), { cost: 8 }), deleted] } }), result = buildOwnerPortfolioAckPreview(source)
    expect(source.packet.request.operations[1]).toEqual({ key: ASSET, kind: 'manual_asset', deleted: true,
      base_values: { ...before.values, value: 0, kind: 'manual_asset', deleted: false } })
    expect(result.issues).toEqual([]); expect(result.nextPortfolio!.manual[0].deleted).toBe(true)
    expect(Object.is(result.nextPortfolio!.manual[0].values.value, -0)).toBe(true)
    for (const wrong of [{ ...deleted, values: { ...deleted.values, note: 'not-the-delete-value' } },
      { ...deleted, field_revisions: { ...deleted.field_revisions, value: 2 } }, { ...deleted, lifecycle_revision: 1 }]) {
      invalid({ ...source, matchedResult: { ...source.matchedResult, rawBody: JSON.stringify({ revision: 2,
        records: [changed(fund(), { cost: 8 }), wrong] }) } })
    }
  })
  it('checks complete fresh manual creation stamps and imports additional cloud tombstones without inventing metadata', async () => {
    const created = manual({ record_revision: 2, lifecycle_revision: 2, field_revisions: { name: 2, cls: 2, value: 2, note: 2 } }),
      gone = manual({ key: 'asset:remote-deleted', deleted: true, record_revision: 2, lifecycle_revision: 2,
        field_revisions: { name: 2, cls: 2, value: 2, note: 2 } }),
      source = await fixture({ base: baseline([fund()]), portfolio: portfolio([asset(created, { updated_at: null })]),
        success: { revision: 2, records: [changed(fund(), { cost: 8 }), created] }, cloud: baseline([changed(fund(), { cost: 8 }), created, gone]) }),
      result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([])
    expect(result.nextPortfolio!.manual[0].updated_at).toBeNull()
    expect(result.nextPortfolio!.manual[1]).toEqual(asset(gone, { legacyId: null, updated_at: null }))
    const wrong = { ...created, field_revisions: { ...created.field_revisions, note: 1 } }
    invalid({ ...source, matchedResult: { ...source.matchedResult, rawBody: JSON.stringify({ revision: 2,
      records: [changed(fund(), { cost: 8 }), wrong] }) } }, 'result_mismatch')
  })
  it('preserves zero/null distinction, local signed zero and pending=false before-image without fake zero-sign intent', async () => {
    const before = fund({ values: { ...fund().values, shares: null, cost: -0 } }), local = entry(before,
      { local_pending: false, values: { ...entry(before).values, cost: null, target_weight: -0 } }),
      originalManual = manual({ values: { ...manual().values, value: -0, note: null } }), assets = portfolio([asset(originalManual,
        { values: { ...asset(originalManual).values, note: '' } })]),
      source = await fixture({ base: baseline([before, originalManual]), local: snapshot([local]), portfolio: assets,
        success: { revision: 2, records: [changed(before, { cost: null, target_weight: 0 }), changed(originalManual, { note: '' })] } }),
      result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([]); expect(result.nextSnapshot!.entries[0].values.shares).toBeNull()
    expect(result.nextSnapshot!.entries[0].values.cost).toBeNull()
    expect(Object.is(result.nextSnapshot!.entries[0].values.target_weight, -0)).toBe(true)
    expect(Object.is(result.nextPortfolio!.manual[0].values.value, -0)).toBe(true)
    expect(result.rows[0]).toMatchObject({ before: { local_pending: false }, after: { local_pending: true }, fields: [] })
  })
  it('retains exact fund kind-transition stamp rules alongside a successful manual patch', async () => {
    const watch = fund({ kind: 'watch', record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 1, shares: 2, cost: 1, target_weight: 1 }, values: { ...fund().values, shares: null } }),
      source = await fixture({ local: snapshot([entry(watch)]),
        success: { revision: 2, records: [watch, changed(manual(), { value: 8 })] } }), result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([]); expect(result.nextSnapshot!.entries[0].kind).toBe('watch')
    const wrong = { ...watch, field_revisions: { ...watch.field_revisions, name: 2 } }
    invalid({ ...source, matchedResult: { ...source.matchedResult, rawBody: JSON.stringify({ revision: 2,
      records: [wrong, changed(manual(), { value: 8 })] }) } }, 'result_mismatch')
  })
  it.each(['success', 'conflict'] as const)('can explicitly preview a later authenticated fresh manual revival during unrelated %s ACK without uploading stale local resurrection', async outcome => {
    const before = manual({ deleted: true }), post = changed(fund(), { cost: 8 }),
      revived = manual({ record_revision: 3, lifecycle_revision: 3,
        field_revisions: { name: 3, cls: 3, value: 3, note: 3 }, values: { name: 'fresh-cloud-manual', cls: '权益', value: 7, note: '' } }),
      source = await fixture({ base: baseline([fund(), before]), portfolio: portfolio([asset(before)]),
        success: { revision: 2, records: [post] }, cloud: baseline([outcome === 'success' ? post : changed(fund(), { cost: 12 }), revived]),
        ...(outcome === 'conflict' ? { conflicts: [{ key: KEY, fields: ['cost'] }], resolutions: [choice(KEY, 'cost', 'local')] } : {}) }),
      result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([])
    expect(result.nextPortfolio!.manual[0]).toEqual({ ...source.portfolio.manual[0], deleted: false, values: revived.values })
    expect(result.rows.find(row => row.key === ASSET)).toMatchObject({ before: { deleted: true }, after: { deleted: false },
      fields: ['lifecycle', 'name', 'cls', 'value', 'note'] })
    const intent = planOwnerPortfolioCloudIntent(result.baseD, result.nextSnapshot, result.nextPortfolio)
    expect(intent.issues).toEqual([]); expect(intent.operations.every(row => row.kind !== 'manual_asset')).toBe(true)
  })
  it.each(['missing', 'extra', 'wrong-kind', 'wrong-value', 'wrong-stamp', 'wrong-lifecycle', 'old-revision'] as const)
    ('rejects success with a %s manual result instead of trusting HTTP200', async mode => {
      const source = await fixture(), response = JSON.parse(source.matchedResult.rawBody)
      if (mode === 'missing') response.records = response.records.slice(0, 1)
      if (mode === 'extra') response.records.push(manual({ key: 'asset:extra' }))
      if (mode === 'wrong-kind') response.records[1].kind = 'holding'
      if (mode === 'wrong-value') response.records[1].values.value = 9
      if (mode === 'wrong-stamp') response.records[1].field_revisions.value = 1
      if (mode === 'wrong-lifecycle') response.records[1].lifecycle_revision = 2
      if (mode === 'old-revision') { response.revision = 1; response.records = [fund(), manual()] }
      invalid({ ...source, matchedResult: { ...source.matchedResult, rawBody: JSON.stringify(response) } })
    })
})

describe('real applied-manual B/L/D conflict merge', () => {
  it('retains local manual value while absorbing independent cloud note, and preserves all unrelated local fund intent', async () => {
    const source = await fixture({ cloud: baseline([changed(fund(), { cost: 12 }), changed(manual(), { note: 'cloud-note' }, 3)]),
      conflicts: [{ key: KEY, fields: ['cost'] }], resolutions: [choice(KEY, 'cost', 'cloud')] }), result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([]); expect(result.outcome).toBe('conflict')
    expect(result.nextPortfolio!.manual[0].values).toEqual({ name: 'synthetic-cash', cls: '现金', value: 8, note: 'cloud-note' })
    expect(result.conflicts.map(row => row.key)).toEqual([KEY])
    expect(planOwnerPortfolioCloudIntent(result.baseD, result.nextSnapshot, result.nextPortfolio)).toEqual({ issues: [], operations: [
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: 0 } },
    ] })
  })
  const edits = [
    { field: 'name', local: 'local-name', remote: 'cloud-name', before: 'synthetic-cash' },
    { field: 'cls', local: '权益', remote: '商品', before: '现金' },
    { field: 'value', local: 8, remote: 12, before: 0 },
    { field: 'note', local: '', remote: 'cloud-note', before: null },
  ] as const
  it.each(edits.flatMap(edit => (['changed', 'aba', 'same-value', 'known-server'] as const).map(mode => ({ ...edit, mode }))))
    ('requires explicit $field selection for $mode without manual bootstrap or rename', async edit => {
      const localManual = asset(manual(), { values: { ...asset().values, [edit.field]: edit.local } }),
        remoteValue = edit.mode === 'aba' ? edit.before : edit.mode === 'same-value' ? edit.local : edit.remote,
        current = edit.mode === 'known-server' ? manual() : changed(manual(), { [edit.field]: remoteValue }),
        source = await fixture({ portfolio: portfolio([localManual]), cloud: baseline([fund(), current]),
          conflicts: [{ key: ASSET, fields: [edit.field] }] }), preview = buildOwnerPortfolioAckPreview(source)
      expect(preview.issues).toEqual([]); expect(preview.nextSnapshot).toBeNull(); expect(preview.nextPortfolio).toBeNull()
      expect(preview.conflicts).toMatchObject([{ key: ASSET, field: edit.field, reason: edit.mode === 'aba' ? 'field_aba'
        : edit.mode === 'known-server' ? 'server_conflict' : 'field_changed', groupKeys: [ASSET], base: { values: manual().values } }])
      for (const side of ['local', 'cloud'] as const) {
        const result = buildOwnerPortfolioAckPreview({ ...source, resolutions: [choice(ASSET, edit.field, side)] })
        expect(result.issues).toEqual([]); expect(result.conflicts[0].choice).toBe(side)
        expect(result.nextPortfolio!.manual[0].values[edit.field]).toBe(side === 'local' ? edit.local : current.values[edit.field])
        expect(result.nextSnapshot!.entries[0].values.cost).toBe(8)
      }
    })
  it('does not conflict on a cloud-only manual field ABA when the local edit is a different field', async () => {
    const source = await fixture({ cloud: baseline([changed(fund(), { cost: 12 }), changed(manual(), { note: null }, 3)]),
      conflicts: [{ key: KEY, fields: ['cost'] }], resolutions: [choice(KEY, 'cost', 'local')] }), result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([]); expect(result.conflicts.map(row => row.key)).toEqual([KEY])
    expect(result.nextPortfolio!.manual[0].values.value).toBe(8)
  })
  it('makes manual lifecycle ABA a whole-row choice, not four independent patches', async () => {
    const current = manual({ record_revision: 3, lifecycle_revision: 3 }), source = await fixture({ cloud: baseline([fund(), current]),
      conflicts: [{ key: ASSET, fields: ['deleted'] }] }), preview = buildOwnerPortfolioAckPreview(source)
    expect(preview.conflicts).toMatchObject([{ key: ASSET, field: 'lifecycle', reason: 'lifecycle_aba' }])
    invalid({ ...source, resolutions: [choice(ASSET, 'value', 'local')] }, 'invalid_resolution')
    expect(buildOwnerPortfolioAckPreview({ ...source, resolutions: [choice(ASSET, 'lifecycle', 'local')] }).nextPortfolio!.manual[0].values.value).toBe(8)
  })
  it('never allows a local manual choice to revive a cloud tombstone', async () => {
    const source = await fixture({ cloud: baseline([fund(), manual({ deleted: true, record_revision: 2, lifecycle_revision: 2 })]),
      conflicts: [{ key: ASSET, fields: ['deleted'] }] }), preview = buildOwnerPortfolioAckPreview(source)
    expect(preview.conflicts).toMatchObject([{ key: ASSET, field: 'lifecycle', reason: 'cloud_tombstone', localAllowed: false }])
    invalid({ ...source, resolutions: [choice(ASSET, 'lifecycle', 'local')] }, 'invalid_resolution')
    expect(buildOwnerPortfolioAckPreview({ ...source, resolutions: [choice(ASSET, 'lifecycle', 'cloud')] }).nextPortfolio!.manual[0].deleted).toBe(true)
  })
  it('uses full lifecycle selection for manual delete versus remote edit and retains an exact delete guard against D', async () => {
    const source = await fixture({ portfolio: portfolio([asset(manual(), { deleted: true })]),
      cloud: baseline([fund(), changed(manual(), { note: 'remote-note' })]),
      conflicts: [{ key: ASSET, fields: ['record_revision', 'note'] }] }), preview = buildOwnerPortfolioAckPreview(source)
    expect(preview.conflicts).toMatchObject([{ key: ASSET, field: 'lifecycle', reason: 'lifecycle_changed' }])
    const selected = buildOwnerPortfolioAckPreview({ ...source, resolutions: [choice(ASSET, 'lifecycle', 'local')] })
    expect(selected.nextPortfolio!.manual[0]).toEqual(source.portfolio.manual[0])
    expect(planOwnerPortfolioCloudIntent(selected.baseD, selected.nextSnapshot, selected.nextPortfolio).operations[1]).toEqual({
      key: ASSET, kind: 'manual_asset', deleted: true, base_values: { ...manual().values, note: 'remote-note', kind: 'manual_asset', deleted: false },
    })
  })
  it('keeps a safe manual delete local when the whole request conflicts only on a separate fund', async () => {
    const source = await fixture({ portfolio: portfolio([asset(manual(), { deleted: true })]), cloud: baseline([fund(), manual()]),
      conflicts: [{ key: KEY, fields: ['cost'] }], resolutions: [choice(KEY, 'cost', 'cloud')] }), result = buildOwnerPortfolioAckPreview(source)
    expect(result.issues).toEqual([]); expect(result.nextPortfolio!.manual[0].deleted).toBe(true)
    expect(result.conflicts).toHaveLength(1)
  })
  it('treats manual creation collisions as whole rows but never groups them as account renames', async () => {
    const current = manual({ record_revision: 2, lifecycle_revision: 2, field_revisions: { name: 2, cls: 2, value: 2, note: 2 },
      values: { ...manual().values, note: 'different-created-row' } }), source = await fixture({ base: baseline([fund()]),
      portfolio: portfolio([asset()]), cloud: baseline([fund(), current]), conflicts: [{ key: ASSET, fields: ['name'] }] }),
      preview = buildOwnerPortfolioAckPreview(source)
    expect(preview.conflicts).toMatchObject([{ key: ASSET, field: 'lifecycle', reason: 'creation_collision', base: null, groupKeys: [ASSET] }])
    expect(buildOwnerPortfolioAckPreview({ ...source, resolutions: [choice(ASSET, 'lifecycle', 'cloud')] }).nextPortfolio!.manual[0].values.note)
      .toBe('different-created-row')
  })
  it('preserves unsent manual/fund tombstones and explicitly resolves a newly appearing cloud identity', async () => {
    const gone = asset(manual({ key: 'asset:unsent' }), { deleted: true }), localFundGone = entry(fund({ key: OTHER }), { deleted: true }),
      source = await fixture({ local: snapshot([...snapshot().entries, localFundGone]), portfolio: portfolio([...portfolio().manual, gone]) }),
      ordinary = buildOwnerPortfolioAckPreview(source)
    expect(ordinary.issues).toEqual([])
    expect(ordinary.nextPortfolio!.manual[1]).toEqual(gone); expect(ordinary.nextSnapshot!.entries[1]).toEqual(localFundGone)
    const appeared = manual({ key: gone.key, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, cls: 2, value: 2, note: 2 } }), collision = { ...source, completeBaseline: baseline([...source.completeBaseline.records, appeared]) }
    expect(buildOwnerPortfolioAckPreview(collision).conflicts).toMatchObject([{ key: gone.key, field: 'lifecycle', reason: 'creation_collision' }])
    const selected = buildOwnerPortfolioAckPreview({ ...collision, resolutions: [choice(gone.key, 'lifecycle', 'local')] })
    expect(selected.nextPortfolio!.manual[1].deleted).toBe(true)
  })
  it('cancels a failed fund rename as one group, retaining the unsent new key tombstone and all unrelated manual intent', async () => {
    const source = await fixture({ local: snapshot([entry(fund(), { deleted: true }), entry(fund({ key: FRESH }))]),
      cloud: baseline([changed(fund(), { shares: 4 }), manual()]), conflicts: [{ key: KEY, fields: ['record_revision'] }] }),
      preview = buildOwnerPortfolioAckPreview(source)
    expect(preview.conflicts).toMatchObject([{ key: KEY, field: 'rename', reason: 'rename_atomic', groupKeys: [KEY, FRESH] }])
    const selected = buildOwnerPortfolioAckPreview({ ...source, resolutions: [choice(KEY, 'rename', 'cloud')] })
    expect(selected.issues).toEqual([])
    expect(selected.nextSnapshot!.entries).toEqual([entry(changed(fund(), { shares: 4 })), entry(fund({ key: FRESH }), { deleted: true })])
    expect(selected.nextPortfolio).toEqual(source.portfolio)
    expect(planOwnerPortfolioCloudIntent(selected.baseD, selected.nextSnapshot, selected.nextPortfolio).operations).toEqual([
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: 0 } },
    ])
    invalid({ ...source, resolutions: [choice(KEY, 'lifecycle', 'cloud')] }, 'invalid_resolution')
  })
  it('blocks a rename-local choice if the fresh account is a cloud tombstone', async () => {
    const remote = fund({ key: FRESH, deleted: true, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }), source = await fixture({
      local: snapshot([entry(fund(), { deleted: true }), entry(fund({ key: FRESH }))]),
      cloud: baseline([fund(), manual(), remote]), conflicts: [{ key: FRESH, fields: ['deleted'] }] })
    expect(buildOwnerPortfolioAckPreview(source).conflicts).toMatchObject([{ field: 'rename', localAllowed: false }])
    invalid({ ...source, resolutions: [choice(KEY, 'rename', 'local')] }, 'invalid_resolution')
  })
})

describe('closed original packet/result/digest associations and complete progress', () => {
  it.each(['wrong-id', 'wrong-hash', 'extra-body', 'duplicate-json', 'idempotency', 'unknown-receipt', 'failure', 'wrong-status'] as const)
    ('rejects a %s raw result without promoting supplied rows', async mode => {
      const source = await fixture(), matched = { ...source.matchedResult }
      if (mode === 'wrong-id') matched.requestId = 'another-request-0001'
      if (mode === 'wrong-hash') matched.requestHash = 'f'.repeat(64)
      if (mode === 'extra-body') matched.rawBody = JSON.stringify({ ...JSON.parse(matched.rawBody), private: PRIVATE })
      if (mode === 'duplicate-json') matched.rawBody = '{"revision":2,"revision":2,"records":[]}'
      if (mode === 'idempotency') { matched.status = 409; matched.rawBody = '{"error":{"code":"idempotency_conflict","message":"请求标识已用于不同的同步请求。"}}' }
      if (mode === 'unknown-receipt') { matched.source = 'receipt'; matched.status = 404; matched.rawBody = '{"state":"unknown","error":"sync_result_unknown"}' }
      if (mode === 'failure') { matched.status = 503; matched.rawBody = '{"error":{"code":"storage_unavailable","message":"同步存储暂不可用。"}}' }
      if (mode === 'wrong-status') matched.status = 409
      invalid({ ...source, matchedResult: matched })
    })
  it.each(['manual-subset', 'fund-subset', 'changed-manual-intent', 'extra-packet', 'noncanonical', 'wrong-bytes', 'wrong-base', 'missing-local-manual', 'missing-local-fund'] as const)
    ('rejects %s instead of accepting a fund-only or trimmed packet', async mode => {
      const source = await fixture(), packet = { ...source.packet }
      if (mode === 'manual-subset' || mode === 'fund-subset') {
        const operations = source.packet.request.operations.filter(row => mode === 'manual-subset' ? row.kind !== 'manual_asset' : row.kind === 'manual_asset'),
          partial = await buildOwnerSyncRequest({ ...source.packet.request, operations })
        invalid({ ...source, packet: partial }, 'intent_mismatch'); return
      }
      if (mode === 'changed-manual-intent') { invalid({ ...source, portfolio: portfolio([asset(manual(), { values: { ...asset().values, value: 9 } })]) }, 'intent_mismatch'); return }
      if (mode === 'extra-packet') { invalid({ ...source, packet: { ...packet, private: PRIVATE } }, 'invalid_packet'); return }
      if (mode === 'noncanonical') { packet.rawBody += ' '; packet.byteLength++ }
      if (mode === 'wrong-bytes') packet.byteLength++
      if (mode === 'wrong-base') { invalid({ ...source, base: baseline([fund({ record_revision: 2 }), manual()]) }, 'intent_mismatch'); return }
      if (mode === 'missing-local-manual') { invalid({ ...source, portfolio: portfolio([]) }, 'intent_mismatch'); return }
      if (mode === 'missing-local-fund') { invalid({ ...source, localSnapshot: snapshot([]) }, 'intent_mismatch'); return }
      invalid({ ...source, packet }, 'invalid_packet')
    })
  it.each(['missing', 'duplicate-key', 'duplicate-digest', 'newline', 'extra', 'unknown-server', 'duplicate-server', 'unguarded-manual', 'keyed-global', 'keyed-record-revision'] as const)
    ('requires a one-to-one closed key/digest association: %s', async mode => {
      const source = await fixture({ conflicts: [{ key: ASSET, fields: ['value'] }] }), matched = { ...source.matchedResult }
      let keyDigests: unknown = source.keyDigests
      if (mode === 'missing') keyDigests = source.keyDigests.slice(1)
      if (mode === 'duplicate-key') keyDigests = [source.keyDigests[0], source.keyDigests[0]]
      if (mode === 'duplicate-digest') keyDigests = [source.keyDigests[0], { ...source.keyDigests[1], digest: source.keyDigests[0].digest }]
      if (mode === 'newline') keyDigests = source.keyDigests.map(row => ({ ...row, digest: row.digest + '\n' }))
      if (mode === 'extra') keyDigests = [{ ...source.keyDigests[0], private: PRIVATE }, source.keyDigests[1]]
      if (mode === 'unknown-server') matched.rawBody = rawConflict([{ key: 'asset:unknown', fields: ['value'] }])
      if (mode === 'duplicate-server') matched.rawBody = rawConflict([{ key: ASSET, fields: ['value'] }, { key: ASSET, fields: ['value'] }])
      if (mode === 'unguarded-manual') matched.rawBody = rawConflict([{ key: ASSET, fields: ['note'] }])
      if (mode === 'keyed-global') matched.rawBody = rawConflict([{ key: ASSET, fields: ['expected_revision'] }])
      if (mode === 'keyed-record-revision') matched.rawBody = rawConflict([{ key: ASSET, fields: ['record_revision'] }])
      invalid({ ...source, keyDigests, matchedResult: matched }, ['missing', 'duplicate-key', 'duplicate-digest', 'newline', 'extra'].includes(mode)
        ? 'invalid_digests' : 'result_mismatch')
    })
  it('rejects missing applied manual/fund D rows, partial/retrograde heads, observed/result floors and backdated stamps', async () => {
    const source = await fixture()
    invalid({ ...source, completeBaseline: baseline([changed(fund(), { cost: 8 })]) }, 'missing_cloud_record')
    invalid({ ...source, completeBaseline: baseline([changed(manual(), { value: 8 })]) }, 'missing_cloud_record')
    invalid({ ...source, completeBaseline: baseline() }, 'baseline_regression')
    invalid({ ...source, minimumObservedRevision: 3 }, 'baseline_regression')
    invalid({ ...source, completeBaseline: { pulledRevision: 3, records: source.completeBaseline.records } }, 'invalid_baseline')
    const bad = changed(manual(), { value: 8 }, 2, { field_revisions: manual().field_revisions })
    invalid({ ...source, completeBaseline: baseline([changed(fund(), { cost: 8 }), bad]) }, 'baseline_regression')
    invalid({ ...source, completeBaseline: baseline([...source.completeBaseline.records, manual({ key: 'asset:backdated-new' })]) }, 'baseline_regression')
  })
  it('requires D to retain the successful created manual, even when D otherwise looks complete', async () => {
    const created = manual({ record_revision: 2, lifecycle_revision: 2, field_revisions: { name: 2, cls: 2, value: 2, note: 2 } }),
      source = await fixture({ base: baseline([fund()]), portfolio: portfolio([asset()]),
        success: { revision: 2, records: [changed(fund(), { cost: 8 }), created] } })
    invalid({ ...source, completeBaseline: baseline([changed(fund(), { cost: 8 }, 3)]) }, 'missing_cloud_record')
  })
  it.each([NaN, Infinity, -0, -1, 0.5, true, '2'])('rejects non-revision observed floor %s', async value => {
    invalid({ ...await fixture(), minimumObservedRevision: value }, 'invalid_input')
  })
  it.each(['top-extra', 'missing-portfolio', 'baseline-extra', 'portfolio-extra', 'bad-history', 'hidden', 'symbol', 'unused-choice', 'duplicate-choice', 'unknown-choice', 'sparse-choice'] as const)
    ('rejects %s without private diagnostics', async mode => {
      const source = await fixture()
      if (mode === 'top-extra') { invalid({ ...source, private: PRIVATE }, 'invalid_input'); return }
      if (mode === 'missing-portfolio') { const { portfolio: ignored, ...rest } = source; void ignored; invalid(rest, 'invalid_input'); return }
      if (mode === 'baseline-extra') { invalid({ ...source, base: { ...source.base, private: PRIVATE } }, 'invalid_baseline'); return }
      if (mode === 'portfolio-extra') { invalid({ ...source, portfolio: { ...source.portfolio, private: PRIVATE } }, 'invalid_portfolio'); return }
      if (mode === 'bad-history') { invalid({ ...source, portfolio: { ...source.portfolio, history: [{ id: PRIVATE }] } }, 'invalid_portfolio'); return }
      if (mode === 'hidden') { invalid(Object.defineProperty({ ...source }, 'hidden', { value: PRIVATE }), 'invalid_input'); return }
      if (mode === 'symbol') { invalid(Object.defineProperty({ ...source }, Symbol('secret'), { value: PRIVATE, enumerable: true }), 'invalid_input'); return }
      if (mode === 'unused-choice') { invalid({ ...source, resolutions: [choice(ASSET, 'note', 'local')] }, 'invalid_resolution'); return }
      if (mode === 'duplicate-choice') { invalid({ ...source, resolutions: [choice(ASSET, 'value', 'local'), choice(ASSET, 'value', 'local')] }, 'invalid_resolution'); return }
      if (mode === 'unknown-choice') { invalid({ ...source, resolutions: [{ key: ASSET, field: 'future', choice: 'local' }] }, 'invalid_resolution'); return }
      invalid({ ...source, resolutions: new Array(1) }, 'invalid_resolution')
    })
  it('rejects nested getters without invoking them and performs no ambient crypto/storage/network work', async () => {
    const source = await fixture(), forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    vi.stubGlobal('crypto', { subtle: { digest: forbidden } })
    const top = { ...source }; Object.defineProperty(top, 'portfolio', { enumerable: true, get: forbidden }); invalid(top, 'invalid_input')
    const assets = { ...source.portfolio, manual: [{ ...source.portfolio.manual[0], values: { ...source.portfolio.manual[0].values } }] }
    Object.defineProperty(assets.manual[0].values, 'value', { enumerable: true, get: forbidden }); invalid({ ...source, portfolio: assets }, 'invalid_portfolio')
    const result = { ...source.matchedResult }; Object.defineProperty(result, 'rawBody', { enumerable: true, get: forbidden }); invalid({ ...source, matchedResult: result }, 'invalid_result')
    const original = { ...source.packet }; Object.defineProperty(original, 'rawBody', { enumerable: true, get: forbidden }); invalid({ ...source, packet: original }, 'invalid_packet')
    expect(buildOwnerPortfolioAckPreview(source).issues).toEqual([]); expect(forbidden).not.toHaveBeenCalled()
  })
  it.each(['request-change', 'result-status', 'digest-key', 'resolution-choice', 'cloud-field-stamp'] as const)
    ('rejects a hidden/getter %s descriptor before canonicalization or resolution', async field => {
      const source = await fixture(), getter = vi.fn(), extra = PRIVATE
      if (field === 'request-change') {
        const changes = { ...source.packet.request.operations[1].changes }
        Object.defineProperty(changes, 'value', { enumerable: true, get: getter })
        invalid({ ...source, packet: { ...source.packet, request: { ...source.packet.request,
          operations: [source.packet.request.operations[0], { ...source.packet.request.operations[1], changes }] } } }, 'invalid_packet')
      }
      if (field === 'result-status') invalid({ ...source, matchedResult: Object.defineProperty({ ...source.matchedResult }, 'status', { enumerable: true, get: getter }) }, 'invalid_result')
      if (field === 'digest-key') invalid({ ...source, keyDigests: [source.keyDigests[0],
        Object.defineProperty({ ...source.keyDigests[1] }, 'key', { enumerable: true, get: getter })] }, 'invalid_digests')
      if (field === 'resolution-choice') invalid({ ...source, resolutions: [Object.defineProperty(choice(ASSET, 'value', 'local'), 'choice', { enumerable: true, get: getter })] }, 'invalid_resolution')
      if (field === 'cloud-field-stamp') {
        const stamps = Object.defineProperty({ ...source.completeBaseline.records[1].field_revisions }, 'secret', { value: extra })
        invalid({ ...source, completeBaseline: baseline([source.completeBaseline.records[0], { ...source.completeBaseline.records[1], field_revisions: stamps }]) }, 'invalid_baseline')
      }
      expect(getter).not.toHaveBeenCalled()
    })
  it('does not trim over200 local intents into the smaller supplied original packet', async () => {
    const source = await fixture(), rows = [...source.portfolio.manual, ...Array.from({ length: 201 }, (_, index) => asset(manual({ key: 'asset:new-' + index })))],
      intent = planOwnerPortfolioCloudIntent(source.base, source.localSnapshot, portfolio(rows))
    expect(intent.operations).toHaveLength(203)
    await expect(buildOwnerSyncRequest({ ...source.packet.request, operations: intent.operations })).rejects.toMatchObject({ code: 'invalid_sync_request' })
    invalid({ ...source, portfolio: portfolio(rows) })
  })
  it('does not trim over128KiB local intents to match the original smaller packet', async () => {
    const source = await fixture({ base: baseline([fund()]), portfolio: portfolio([]), success: { revision: 2, records: [changed(fund(), { cost: 8 })] } }),
      assets = portfolio(Array.from({ length: 199 }, (_, index) => asset(manual({ key: 'asset:large-' + index,
        values: { ...manual().values, note: '中'.repeat(400) } })))), intent = planOwnerPortfolioCloudIntent(source.base, source.localSnapshot, assets)
    expect(intent.operations).toHaveLength(200)
    expect(new TextEncoder().encode(JSON.stringify(intent.operations)).byteLength).toBeGreaterThan(OWNER_SYNC_MAX_BODY_BYTES)
    await expect(buildOwnerSyncRequest({ ...source.packet.request, operations: intent.operations })).rejects.toMatchObject({ code: 'invalid_sync_request' })
    invalid({ ...source, portfolio: assets }, 'intent_mismatch')
  })
  it('rejects a complete-D addition exceeding local portfolio capacity rather than dropping any original manual/history/raw', async () => {
    const rows = Array.from({ length: 2000 }, (_, index) => manual({ key: 'asset:capacity-' + index })), post = changed(fund(), { cost: 8 }),
      extra = manual({ key: 'asset:overflow', record_revision: 2, lifecycle_revision: 2,
        field_revisions: { name: 2, cls: 2, value: 2, note: 2 } }),
      source = await fixture({ base: baseline([fund(), ...rows]), portfolio: portfolio(rows.map(row => asset(row))),
        success: { revision: 2, records: [post] }, cloud: baseline([post, ...rows, extra]) })
    invalid(source, 'capacity_exceeded')
  })
})
