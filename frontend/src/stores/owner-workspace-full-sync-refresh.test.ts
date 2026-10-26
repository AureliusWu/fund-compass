/** Actual 3→4→5→6/full-B strict refresh journey. All remote DTOs are synthetic;
 * no POST, real browser, remote durability or recovery qualification is claimed.
 * Business codecs, request compilers, IDB stores and final CAS are not mocked. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspaceEditPortfolioRequest, buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  buildOwnerWorkspaceFullSyncUpgradeRequest, buildOwnerWorkspaceFullSyncLinkRequest, buildOwnerWorkspaceFullSyncPrepareRequest,
  buildOwnerWorkspaceFullSyncCancelRequest, buildOwnerWorkspaceFullSyncAckRequest,
  previewOwnerWorkspaceFullSyncRefresh, buildOwnerWorkspaceFullSyncRefreshRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceFullSyncState,
  type OwnerWorkspaceFullSyncRefreshInput, type OwnerWorkspaceFullSyncRefreshRequest, type OwnerWorkspaceFullSyncDeliveryRequest,
} from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { buildOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { buildOwnerFullSyncRecoveryBackup, restoreOwnerFullSyncRecoveryBackup } from '@/utils/owner-full-sync-recovery'
import { parseOwnerBusinessJson } from '@/utils/owner-legacy-seed'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'
import { validateOwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'

const TARGET = '7'.repeat(64), KEY = '510300::完整刷新合成账户', FRESH = '510300::完整刷新更名账户', ASSET = 'asset:synthetic-refresh-cash'
const FULL = 'portfolio_sync_metadata', PORTFOLIO = 'portfolio_metadata', handles: OwnerWorkspace[] = []
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function context() {
  const controller = new AbortController()
  return { controller, guard: { signal: controller.signal, assertActive() {
    if (controller.signal.aborted) throw new Error('synthetic authority revoked')
  } } satisfies OwnerWorkspaceGuard }
}
function fund(): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成零份', shares: -0, cost: null, target_weight: 0 } }
}
function manual(): OwnerSyncRecord {
  return { key: ASSET, kind: 'manual_asset', deleted: false, record_revision: 2, lifecycle_revision: 2,
    field_revisions: { name: 2, cls: 2, value: 2, note: 2 }, values: { name: '合成现金', cls: '现金', value: -0, note: null } }
}
const base = (records: readonly OwnerSyncRecord[]): OwnerSyncBaseline => ({ pulledRevision: Math.max(0, ...records.map(row => row.record_revision)), records })
function changed(source: OwnerSyncRecord, changes: Record<string, string | number | null>, revision = 3): OwnerSyncRecord {
  return { ...source, record_revision: revision, values: { ...source.values, ...changes },
    field_revisions: { ...source.field_revisions, ...Object.fromEntries(Object.keys(changes).map(key => [key, revision])) } }
}
function delivery(expected: OwnerWorkspaceFullSyncState, nextState: OwnerWorkspaceFullSyncDeliveryRequest['nextState']): OwnerWorkspaceFullSyncDeliveryRequest {
  const pending = expected.fullSync.pending!
  return { expected, requestId: pending.requestId, requestHash: pending.requestHash, preparationHash: pending.preparationHash, nextState }
}
async function fixture(options: { dirty?: boolean; rename?: boolean; removeManual?: boolean; linked?: boolean } = {}) {
  const factory = new IDBFactory(), { controller, guard } = context(), v3 = await openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const archive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'original opaque refresh archive', v2Raw: canonicalOwnerLocal([
    { code: '510300', name: '合成零份', account: '完整刷新合成账户', position_kind: 'holding', shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-24T00:00:00Z' },
  ]) }, original = await buildOwnerLegacyWorkspaceBackup(archive)
  const adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'fullrefresh-adopt-0001', expected: await v3.readLocalState(guard),
    sourceArchive: archive, backupSha256: original.sha256 }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'fullrefresh-old-link-0001', expected: await v4.readSyncState(guard),
    base: { pulledRevision: 1, records: [fund()] } }), guard)
  const source = { manualRaw: ' \n' + canonicalOwnerLocal([{ id: 'synthetic-refresh-cash', name: '合成现金', cls: '现金', value: -0,
    updated_at: '2026-10-24T00:00:00.12Z' }]) + '\r\n', snapshotsRaw: canonicalOwnerLocal([
    { date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 },
  ]) }, portfolioFile = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), source)
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
    { id: 'fullrefresh-portfolio-0001', backupRaw: portfolioFile.raw, backupSha256: portfolioFile.sha256 }), guard); handles.push(v5)
  const backup5 = await buildOwnerPortfolioRecoveryBackup(TARGET, await v5.readLocalState(guard)),
    v6 = await upgradeOwnerWorkspaceFullSync(factory, TARGET, await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET,
      { id: 'fullrefresh-upgrade-0001', backupRaw: backup5.raw, backupSha256: backup5.sha256 }), guard); handles.push(v6)
  if (options.linked !== false) await v6.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(TARGET,
    { id: 'fullrefresh-full-link-0001', expected: await v6.readFullSyncState(guard), base: base([fund(), manual()]),
      minimumObservedRevision: 2, resolutions: [] }), guard)
  if (options.dirty !== false) {
    const local = await v6.readFullSyncState(guard)
    await v6.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fullrefresh-local-fund-0001', expected: local.local,
      command: { type: 'save', expectedEntry: local.local.snapshot.entries[0], confirmed: true,
        input: { code: '510300', name: '合成零份', account: options.rename ? '完整刷新更名账户' : '完整刷新合成账户',
          position_kind: 'holding', shares: 7, cost: null, target_weight: 0 } } }), guard)
    await v6.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullrefresh-local-manual-0001', expected: await v6.readLocalState(guard),
      command: options.removeManual ? { type: 'remove_manual', key: ASSET, updated_at: '2026-10-25T00:00:00Z' }
        : { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T00:00:00Z', values: { name: '合成现金', cls: '现金', value: 8, note: null } } }), guard)
  }
  const state = await v6.readFullSyncState(guard)
  return { factory, controller, guard, v6, state, source }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function input(current: Fixture, patch: Partial<OwnerWorkspaceFullSyncRefreshInput> = {}): OwnerWorkspaceFullSyncRefreshInput {
  return { id: 'fullrefresh-commit-0001', expected: current.state,
    completeBaseline: base([changed(fund(), { name: '另一设备名称' }), changed(manual(), { note: '' }, 4)]),
    minimumObservedRevision: 4, resolutions: [], ...patch }
}
async function reopen(factory: IDBFactory) {
  const handle = await openOwnerWorkspace(factory, TARGET, { existingOnly: true }); handles.push(handle); return handle
}
async function image(factory: IDBFactory) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  try { return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const names = [...db.objectStoreNames], tx = db.transaction(names), result: Record<string, unknown[]> = {}
    for (const name of names) { const read = tx.objectStore(name).getAll(); read.onsuccess = () => { result[name] = read.result } }
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
function copy<T>(value: T): T { return parseOwnerBusinessJson(canonicalOwnerLocal(value), 24 * 1024 * 1024, 12) as T }

describe('actual complete B/L/D refresh strict commit without original packet', () => {
  it.each([false, true])('atomically refreshes full cloud fields and retains unuploaded intent (dirty=%s)', async dirty => {
    const current = await fixture({ dirty }), before = current.state, supplied = input(current),
      preview = await previewOwnerWorkspaceFullSyncRefresh(TARGET, supplied), request = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, supplied),
      physical = await image(current.factory)
    expect(request.hash).toBe(sha(canonicalOwnerLocal({ operation: 'portfolio-cloud-refresh-1', target: TARGET, input: supplied, preview })))
    const forbidden = vi.fn(() => { throw new Error('no HTTP or legacy storage') }); vi.stubGlobal('fetch', forbidden); vi.stubGlobal('localStorage', { getItem: forbidden })
    const transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, strict = vi.fn(), writes: string[] = []
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = transaction.call(this, names, mode, options)
      if (mode === 'readwrite') { expect(options?.durability).toBe('strict'); expect(tx.durability).toBe('strict'); strict() }
      return tx
    })
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) { writes.push(this.name); return put.call(this, value, key) })
    const state = await current.v6.refreshFullSync(request, current.guard), after = await image(current.factory)
    expect(strict).toHaveBeenCalledOnce(); expect(writes).toEqual(['slot', 'working_copy', 'local_metadata', PORTFOLIO, FULL])
    expect(state.local.snapshot.localVersion).toBe(before.local.snapshot.localVersion + 1)
    expect(state.local.outbox).toEqual({ version: before.local.outbox.version + 1, entry: null })
    expect(state.fullSync).toEqual({ ...before.fullSync, epoch: before.fullSync.epoch + 1, base: supplied.completeBaseline,
      recentReceipt: { id: request.id, hash: request.hash, operation: 'refresh', syncEpoch: before.fullSync.epoch + 1,
        outboxVersion: state.local.outbox.version, localVersion: state.local.snapshot.localVersion } })
    expect(state.local.snapshot.entries[0]).toMatchObject({ local_pending: true, values: { name: '另一设备名称', shares: dirty ? 7 : -0, cost: null, target_weight: 0 } })
    expect(state.local.portfolio!.manual[0]).toEqual({ ...before.local.portfolio!.manual[0], values: { ...before.local.portfolio!.manual[0].values, note: '' } })
    expect(state.local.portfolio!.manual[0].legacyId).toBe('synthetic-refresh-cash')
    expect(state.local.portfolio!.history).toEqual(before.local.portfolio!.history); expect(state.local.portfolio!.migration).toEqual(before.local.portfolio!.migration)
    expect(state.local.portfolio!.migration.manualRaw).toBe(current.source.manualRaw); expect(state.local.portfolio!.migration.snapshotsRaw).toBe(current.source.snapshotsRaw)
    expect(Object.is(state.local.portfolio!.history[0].value, -0)).toBe(true)
    if (!dirty) { expect(Object.is(state.local.snapshot.entries[0].values.shares, -0)).toBe(true); expect(Object.is(state.local.portfolio!.manual[0].values.value, -0)).toBe(true) }
    expect(state.local.sync).toEqual(before.local.sync); expect(state.local.portfolioUpgrade).toEqual(before.local.portfolioUpgrade); expect(state.local.fullSyncUpgrade).toEqual(before.local.fullSyncUpgrade)
    expect(state.local.metadata).toEqual({ ...before.local.metadata, recentEdit: { id: request.id, hash: request.hash,
      beforeLocalVersion: before.local.snapshot.localVersion, localVersion: state.local.snapshot.localVersion, outboxVersion: state.local.outbox.version } })
    for (const name of ['sync_metadata', 'import_receipts']) expect(after[name]).toEqual(physical[name])
    expect(after[PORTFOLIO][1]).toEqual(physical[PORTFOLIO][1]); expect(after[FULL][1]).toEqual(physical[FULL][1])
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio).operations).toHaveLength(dirty ? 2 : 0)
    expect(await current.v6.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
    expect(await (await reopen(current.factory)).readFullSyncState(current.guard)).toEqual(state)
    const backup = await buildOwnerFullSyncRecoveryBackup(TARGET, state.local)
    expect((await restoreOwnerFullSyncRecoveryBackup(backup.raw, backup.sha256)).local).toEqual(state.local)
    expect(forbidden).not.toHaveBeenCalled()
  })
  it.each([false, true])('same full B/D and unchanged local postimage is a no-op, even with remaining local intent (dirty=%s)', async dirty => {
    const current = await fixture({ dirty }), supplied = input(current, { completeBaseline: current.state.fullSync.base!, minimumObservedRevision: 2 }),
      before = await image(current.factory), preview = await previewOwnerWorkspaceFullSyncRefresh(TARGET, supplied)
    expect(preview.noop).toBe(true); expect(preview.remainingOperations).toHaveLength(dirty ? 2 : 0)
    await expect(buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, supplied)).rejects.toMatchObject({ code: 'workspace_noop' })
    await expect(current.v6.refreshFullSync({ ...supplied, hash: '1'.repeat(64) }, current.guard)).rejects.toMatchObject({ code: 'workspace_noop' })
    expect(await image(current.factory)).toEqual(before)
  })
  it('fresh cloud records get unknown display metadata without changing legacy history or original manual origin', async () => {
    const current = await fixture({ dirty: false }), extraFund: OwnerSyncRecord = { ...changed(fund(), { name: '云新增基金' }, 5),
      key: '000001::云新增账户', lifecycle_revision: 5, field_revisions: { name: 5, shares: 5, cost: 5, target_weight: 5 } },
      extraManual: OwnerSyncRecord = { ...changed(manual(), { note: '' }, 6), key: 'asset:cloud-new', lifecycle_revision: 6,
        field_revisions: { name: 6, cls: 6, value: 6, note: 6 } },
      supplied = input(current, { completeBaseline: base([fund(), manual(), extraFund, extraManual]), minimumObservedRevision: 6 }),
      state = await current.v6.refreshFullSync(await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, supplied), current.guard)
    expect(state.local.metadata.displayTimes.find(row => row.key === extraFund.key)?.updated_at).toBeNull()
    expect(state.local.portfolio!.manual.find(row => row.key === extraManual.key)).toMatchObject({ legacyId: null, updated_at: null, local_pending: true })
    expect(state.local.portfolio!.history).toEqual(current.state.local.portfolio!.history)
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio)).toEqual({ issues: [], operations: [] })
  })
  it('refresh receipt belongs only to full-profile metadata and does not extend the historical fund-only receipt enum', async () => {
    const current = await fixture(), request = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)),
      state = await current.v6.refreshFullSync(request, current.guard)
    expect(() => validateOwnerWorkspaceSyncMetadata({ ...state.local.sync, recentReceipt: { ...state.local.sync!.recentReceipt, operation: 'refresh' } }, TARGET)).toThrow()
    expect(state.local.sync).toEqual(current.state.local.sync)
    expect((await (await reopen(current.factory)).readFullSyncState(current.guard)).fullSync.recentReceipt?.operation).toBe('refresh')
  })
})

describe('actual refresh conflicts and next original packet retain full intent', () => {
  it.each(['changed', 'aba', 'same-value'] as const)('requires explicit fund/manual %s choices before strict commit', async mode => {
    const current = await fixture(), cloudShares = mode === 'aba' ? -0 : mode === 'same-value' ? 7 : 12,
      cloudValue = mode === 'aba' ? -0 : mode === 'same-value' ? 8 : 20,
      supplied = input(current, { completeBaseline: base([changed(fund(), { shares: cloudShares }), changed(manual(), { value: cloudValue }, 4)]) }),
      before = await image(current.factory), preview = await previewOwnerWorkspaceFullSyncRefresh(TARGET, supplied)
    expect(preview.nextSnapshot).toBeNull(); expect(preview.conflicts).toMatchObject([{ key: KEY, field: 'shares' }, { key: ASSET, field: 'value' }])
    await expect(buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, supplied)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
    const resolved = { ...supplied, resolutions: [{ key: KEY, field: 'shares' as const, choice: 'cloud' as const }, { key: ASSET, field: 'value' as const, choice: 'local' as const }] },
      state = await current.v6.refreshFullSync(await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, resolved), current.guard)
    expect(Object.is(state.local.snapshot.entries[0].values.shares, cloudShares)).toBe(true); expect(state.local.portfolio!.manual[0].values.value).toBe(8)
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio).operations).toHaveLength(mode === 'same-value' ? 0 : 1)
  })
  it('cloud tombstones cannot be revived by choosing local and explicit cloud adoption preserves identities/raw/history', async () => {
    const current = await fixture(), tombstone = { ...manual(), deleted: true, record_revision: 4, lifecycle_revision: 4 },
      supplied = input(current, { completeBaseline: base([fund(), tombstone]) }),
      preview = await previewOwnerWorkspaceFullSyncRefresh(TARGET, supplied)
    expect(preview.conflicts).toMatchObject([{ key: ASSET, field: 'lifecycle', reason: 'cloud_tombstone', localAllowed: false }])
    await expect(buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, { ...supplied, resolutions: [{ key: ASSET, field: 'lifecycle', choice: 'local' }] })).rejects.toBeInstanceOf(Error)
    const state = await current.v6.refreshFullSync(await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET,
      { ...supplied, resolutions: [{ key: ASSET, field: 'lifecycle', choice: 'cloud' }] }), current.guard)
    expect(state.local.portfolio!.manual[0]).toEqual({ ...current.state.local.portfolio!.manual[0], deleted: true, values: manual().values })
    expect(state.local.portfolio!.history).toEqual(current.state.local.portfolio!.history)
  })
  it('cloud choice cancels a conflicting fund rename atomically and retains the unuploaded fresh-key tombstone', async () => {
    const current = await fixture({ rename: true }), supplied = input(current, { completeBaseline: base([changed(fund(), { shares: 20 }, 4), manual()]) }),
      preview = await previewOwnerWorkspaceFullSyncRefresh(TARGET, supplied), group = preview.conflicts[0]
    expect(group).toMatchObject({ field: 'rename', reason: 'rename_atomic', groupKeys: [KEY, FRESH] })
    const state = await current.v6.refreshFullSync(await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET,
      { ...supplied, resolutions: [{ key: group.key, field: 'rename', choice: 'cloud' }] }), current.guard)
    expect(state.local.snapshot.entries.find(row => row.key === KEY)).toMatchObject({ deleted: false, values: { shares: 20 } })
    expect(state.local.snapshot.entries.find(row => row.key === FRESH)).toMatchObject({ deleted: true, local_pending: true, values: { shares: 7 } })
    expect((await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id: 'fullrefresh-after-rename-packet', expected: state })).packet.request.operations.map(row => row.kind)).toEqual(['manual_asset'])
  })
  it('refresh→prepare→recovery-3→prepared cancel→prepare→real original ACK preserves all receipt and envelope checks', async () => {
    const current = await fixture(), state = await current.v6.refreshFullSync(await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)), current.guard),
      packet = await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id: 'fullrefresh-after-packet-0001', expected: state }),
      prepared = await current.v6.prepareFullSync(packet, current.guard), backup = await buildOwnerFullSyncRecoveryBackup(TARGET, prepared.local)
    expect(packet.packet.request.expected_revision).toBe(4); expect(packet.packet.request.operations.map(row => row.kind)).toEqual(['holding', 'manual_asset'])
    expect((await restoreOwnerFullSyncRecoveryBackup(backup.raw, backup.sha256)).local).toEqual(prepared.local)
    const cancelled = await current.v6.cancelPreparedFullSync(await buildOwnerWorkspaceFullSyncCancelRequest(TARGET,
      { id: 'fullrefresh-after-cancel-0001', expected: prepared, requestId: packet.id, requestHash: packet.packet.requestHash }), current.guard)
    expect(cancelled.local.portfolio).toEqual(state.local.portfolio); expect(cancelled.local.snapshot).toEqual(state.local.snapshot)
    const original = await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id: 'fullrefresh-after-packet-0002', expected: cancelled }),
      one = await current.v6.prepareFullSync(original, current.guard), two = await current.v6.transitionFullSyncDelivery(delivery(one, 'attempted'), current.guard),
      confirmed = await current.v6.transitionFullSyncDelivery(delivery(two, 'confirmed'), current.guard),
      cloudFund = changed(input(current).completeBaseline.records[0], { shares: 7 }, 5), cloudManual = changed(input(current).completeBaseline.records[1], { value: 8 }, 5),
      result = { revision: 5, records: [cloudFund, cloudManual] }, ack = await buildOwnerWorkspaceFullSyncAckRequest(TARGET,
        { id: 'fullrefresh-after-ack-0001', expected: confirmed, matchedResult: { source: 'write', requestId: original.id,
          requestHash: original.packet.requestHash, status: 200, rawBody: JSON.stringify(result) },
        completeBaseline: base(result.records), minimumObservedRevision: 5, resolutions: [] }),
      final = await current.v6.ackFullSync(ack, current.guard)
    expect(final.local.outbox.entry).toBeNull(); expect(final.fullSync.pending).toBeNull(); expect(final.fullSync.recentReceipt?.operation).toBe('ack')
    expect(planOwnerPortfolioCloudIntent(final.fullSync.base, final.local.snapshot, final.local.portfolio)).toEqual({ issues: [], operations: [] })
    expect(final.local.portfolio!.history).toEqual(current.state.local.portfolio!.history); expect(final.local.sync).toEqual(current.state.local.sync)
  })
})

describe('actual refresh owns sealed inputs and refuses pending, regression and incomplete D', () => {
  it('owns both builder input and received sealed refresh before their first await', async () => {
    const current = await fixture(), supplied = copy(input(current)), original = copy(supplied), build = buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, supplied)
    Object.assign(supplied, { id: 'mutated-after-builder-call', completeBaseline: { pulledRevision: 0, records: [] } })
    const request = await build
    expect(request.id).toBe(original.id); expect(request.completeBaseline).toEqual(original.completeBaseline)
    const received = copy(request), work = current.v6.refreshFullSync(received, current.guard)
    Object.assign(received, { id: 'mutated-after-core-call', hash: '1'.repeat(64), completeBaseline: { pulledRevision: 0, records: [] } })
    const state = await work
    expect(state.fullSync.base).toEqual(original.completeBaseline); expect(state.fullSync.recentReceipt).toMatchObject({ id: original.id, hash: request.hash })
  })
  it.each(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const)('refuses the whole refresh in actual %s original-packet state', async mode => {
    const current = await fixture(), stale = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)),
      packet = await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id: 'fullrefresh-blocking-packet', expected: current.state })
    let state = await current.v6.prepareFullSync(packet, current.guard)
    if (mode !== 'prepared') state = await current.v6.transitionFullSyncDelivery(delivery(state, 'attempted'), current.guard)
    if (!['prepared', 'attempted'].includes(mode)) state = await current.v6.transitionFullSyncDelivery(delivery(state, mode as 'unknown' | 'confirmed' | 'conflict'), current.guard)
    const before = await image(current.factory)
    await expect(buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current, { expected: state }))).rejects.toMatchObject({ code: 'workspace_pending' })
    await expect(current.v6.refreshFullSync(stale, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before); expect((await current.v6.readFullSyncState(current.guard)).fullSync.pending).toEqual(state.fullSync.pending)
  })
  it.each(['unlinked', 'head', 'floor', 'missing-fund', 'missing-manual', 'same-head-different', 'field-regression', 'lifecycle-regression', 'too-many-manual'] as const)
    ('refuses %s without changing any store', async fault => {
      const current = await fixture({ linked: fault !== 'unlinked' }), before = await image(current.factory)
      let supplied = input(current)
      if (fault === 'head') supplied = { ...supplied, completeBaseline: base([fund()]), minimumObservedRevision: 0 }
      if (fault === 'floor') supplied = { ...supplied, minimumObservedRevision: 5 }
      if (fault === 'missing-fund') supplied = { ...supplied, completeBaseline: base([changed(manual(), { note: '' }, 4)]) }
      if (fault === 'missing-manual') supplied = { ...supplied, completeBaseline: base([changed(fund(), { name: '云名称' }, 4)]) }
      if (fault === 'same-head-different') supplied = { ...supplied, completeBaseline: base([fund(), { ...manual(), values: { ...manual().values, note: '' } }]), minimumObservedRevision: 2 }
      if (fault === 'field-regression') supplied = { ...supplied, completeBaseline: base([fund(), { ...changed(manual(), { note: '' }, 4), field_revisions: { ...manual().field_revisions, value: 1, note: 4 } }]) }
      if (fault === 'lifecycle-regression') supplied = { ...supplied, completeBaseline: base([fund(), { ...changed(manual(), { note: '' }, 4), lifecycle_revision: 1 }]) }
      if (fault === 'too-many-manual') supplied = { ...supplied, completeBaseline: base([...supplied.completeBaseline.records, ...Array.from({ length: 2000 }, (_, index) =>
        ({ ...manual(), key: 'asset:over-capacity-' + index, record_revision: 5, lifecycle_revision: 5, field_revisions: { name: 5, cls: 5, value: 5, note: 5 } }))]) }
      await expect(buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, supplied)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it.each(['hash', 'extra', 'getter', 'nested-getter', 'hidden', 'symbol', 'changed-D', 'changed-resolution', 'changed-expected'] as const)
    ('rehydrates and rejects %s without executing any getter or trusting caller postimage', async fault => {
      const current = await fixture(), request = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)), before = await image(current.factory), getter = vi.fn()
      let supplied: unknown = { ...request }
      if (fault === 'hash') supplied = { ...request, hash: '1'.repeat(64) }
      if (fault === 'extra') supplied = { ...request, preview: { nextPortfolio: null } }
      if (fault === 'getter') supplied = Object.defineProperty({ ...request }, 'expected', { enumerable: true, get: getter })
      if (fault === 'nested-getter') supplied = { ...request, completeBaseline: { ...request.completeBaseline,
        records: [Object.defineProperty({ ...request.completeBaseline.records[0] }, 'values', { enumerable: true, get: getter }), request.completeBaseline.records[1]] } }
      if (fault === 'hidden') supplied = Object.defineProperty({ ...request }, 'hidden', { value: true })
      if (fault === 'symbol') supplied = Object.defineProperty({ ...request }, Symbol('secret'), { enumerable: true, value: true })
      if (fault === 'changed-D') supplied = { ...request, completeBaseline: base([changed(fund(), { name: 'different' }), changed(manual(), { note: '' }, 4)]) }
      if (fault === 'changed-resolution') supplied = { ...request, resolutions: [{ key: ASSET, field: 'value', choice: 'cloud' }] }
      if (fault === 'changed-expected') supplied = { ...request, expected: { ...request.expected, fullSync: { ...request.expected.fullSync, epoch: 999 } } }
      await expect(current.v6.refreshFullSync(supplied as OwnerWorkspaceFullSyncRefreshRequest, current.guard)).rejects.toBeInstanceOf(Error)
      expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
    })
})

describe('actual refresh strict all-image CAS, rollback and original receipt', () => {
  it('serializes two complete refreshes from the same full image and only commits one original id', async () => {
    const current = await fixture(), other = await reopen(current.factory), one = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)),
      two = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current, { id: 'fullrefresh-concurrent-0002' })),
      results = await Promise.allSettled([current.v6.refreshFullSync(one, current.guard), other.refreshFullSync(two, current.guard)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1); expect(results.filter(row => row.status === 'rejected')).toHaveLength(1)
    const fresh = await reopen(current.factory), state = await fresh.readFullSyncState(current.guard), winner = results[0].status === 'fulfilled' ? one : two,
      loser = results[0].status === 'fulfilled' ? two : one
    expect(state.local.snapshot.localVersion).toBe(current.state.local.snapshot.localVersion + 1); expect(state.fullSync.epoch).toBe(current.state.fullSync.epoch + 1)
    expect(await fresh.fullSyncReceipt(winner.id, winner.hash, current.guard)).toEqual({ state: 'matched', value: state })
    expect(await fresh.fullSyncReceipt(loser.id, loser.hash, current.guard)).toEqual({ state: 'unknown' })
    const before = await image(current.factory)
    await expect(fresh.refreshFullSync(loser, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' }); expect(await image(current.factory)).toEqual(before)
  })
  it.each(['fund', 'manual', 'history', 'prepare'] as const)('rejects an old refresh after another handle completed a real %s writer', async writer => {
    const current = await fixture(), request = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)), other = await reopen(current.factory)
    if (writer === 'fund') await other.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fullrefresh-racing-fund-0001', expected: current.state.local,
      command: { type: 'save', expectedEntry: current.state.local.snapshot.entries[0], confirmed: true,
        input: { code: '510300', name: '另一标签名称', account: '完整刷新合成账户', position_kind: 'holding', shares: 7, cost: null, target_weight: 0 } } }), current.guard)
    if (writer === 'manual') await other.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullrefresh-racing-manual-0001', expected: current.state.local,
      command: { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T02:00:00Z', values: { name: '合成现金', cls: '现金', value: 9, note: null } } }), current.guard)
    if (writer === 'history') await other.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullrefresh-racing-history-0001', expected: current.state.local,
      command: { type: 'append_observation', observation: { id: 'synthetic-refresh-observation', kind: 'observation', observed_at: '2026-10-25T02:00:00Z',
        date: '2026-10-25', calendar: 'Asia/Shanghai', value: 0, cost: null,
        holdings: [{ kind: 'manual', key: ASSET, name: '合成现金', cls: '现金', value: 0, cost: null }] } } }), current.guard)
    if (writer === 'prepare') await other.prepareFullSync(await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET,
      { id: 'fullrefresh-racing-prepare-0001', expected: current.state }), current.guard)
    const before = await image(current.factory)
    await expect(current.v6.refreshFullSync(request, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' }); expect(await image(current.factory)).toEqual(before)
    expect(await other.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'unknown' })
  })
  it('genuine commit after authority loss is only resolved by its full receipt, never by replay or later unrelated edit', async () => {
    const current = await fixture(), request = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)), transaction = IDBDatabase.prototype.transaction, committed = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = transaction.call(this, names, mode, options)
      if (mode === 'readwrite' && Array.isArray(names) && names.includes(FULL)) tx.addEventListener('complete', () => { committed(); current.controller.abort() }, { once: true })
      return tx
    })
    await expect(current.v6.refreshFullSync(request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(committed).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    const { guard } = context(), fresh = await reopen(current.factory), state = await fresh.readFullSyncState(guard), before = await image(current.factory)
    expect(state.local.snapshot.localVersion).toBe(current.state.local.snapshot.localVersion + 1)
    expect(state.local.outbox.entry).toBeNull(); expect(state.fullSync.pending).toBeNull()
    expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'matched', value: state })
    await expect(fresh.fullSyncReceipt(request.id, '1'.repeat(64), guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await image(current.factory)).toEqual(before)
    await fresh.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullrefresh-later-manual-edit', expected: state.local,
      command: { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T02:00:00Z', values: { name: '合成现金', cls: '现金', value: 9, note: '' } } }), guard)
    expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
  })
  it.each(['quota', 'after-put-abort', 'revoked-before', 'revoked-after-put', 'closed-before', 'closed-after-put', 'relaxed', 'default'] as const)
    ('rolls back all funds/manual/history/base/receipts on %s', async fault => {
      const current = await fixture(), request = await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, input(current)), before = await image(current.factory),
        put = IDBObjectStore.prototype.put, transaction = IDBDatabase.prototype.transaction
      if (fault === 'revoked-before') current.controller.abort()
      if (fault === 'closed-before') current.v6.close()
      if (fault === 'relaxed' || fault === 'default') vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
        const tx = transaction.call(this, names, mode, options)
        if (mode === 'readwrite') Object.defineProperty(tx, 'durability', { configurable: true, value: fault })
        return tx
      })
      if (['quota', 'after-put-abort', 'revoked-after-put', 'closed-after-put'].includes(fault)) vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        const target = this.name === FULL && key === 'current'
        if (target && fault === 'quota') throw new DOMException('Synthetic quota', 'QuotaExceededError')
        const pending = put.call(this, value, key)
        if (target && fault === 'after-put-abort') pending.addEventListener('success', () => this.transaction.abort())
        if (target && fault === 'revoked-after-put') current.controller.abort()
        if (target && fault === 'closed-after-put') current.v6.close()
        return pending
      })
      await expect(current.v6.refreshFullSync(request, current.guard)).rejects.toBeInstanceOf(Error); vi.restoreAllMocks()
      expect(await image(current.factory)).toEqual(before)
      const { guard } = context(), fresh = await reopen(current.factory)
      expect(await fresh.readFullSyncState(guard)).toEqual(current.state)
      expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
    })
})
