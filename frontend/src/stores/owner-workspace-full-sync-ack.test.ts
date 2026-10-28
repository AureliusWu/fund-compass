/** Real public 3→4→5→6/link/edit/prepare/delivery/strict-ACK journey.
 * Responses are explicit synthetic raw bytes: their association is checked,
 * not authenticated as HTTP provenance here. No validators are mocked and no
 * test sends a POST or claims actual browser/cloud durability evidence. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspaceEditPortfolioRequest, buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  buildOwnerWorkspaceFullSyncUpgradeRequest, buildOwnerWorkspaceFullSyncLinkRequest, buildOwnerWorkspaceFullSyncPrepareRequest,
  previewOwnerWorkspaceFullSyncAck, buildOwnerWorkspaceFullSyncAckRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceFullSyncState,
  type OwnerWorkspaceFullSyncAckInput, type OwnerWorkspaceFullSyncAckRequest, type OwnerWorkspaceFullSyncDeliveryRequest,
} from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { buildOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { buildOwnerFullSyncRecoveryBackup, restoreOwnerFullSyncRecoveryBackup } from '@/utils/owner-full-sync-recovery'
import { parseOwnerBusinessJson } from '@/utils/owner-legacy-seed'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'

const TARGET = '9'.repeat(64), KEY = '510300::完整ACK合成账户', FRESH = '510300::完整ACK更名账户', ASSET = 'asset:synthetic-cash'
const FULL = 'portfolio_sync_metadata', PORTFOLIO = 'portfolio_metadata', handles: OwnerWorkspace[] = []
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex'), hash = (value: unknown) => sha(canonicalOwnerLocal(value))
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
async function fixture(options: { terminal?: 'confirmed' | 'conflict' | 'unknown'; rename?: boolean; removeManual?: boolean } = {}) {
  const factory = new IDBFactory(), { controller, guard } = context(), v3 = await openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const archive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'original opaque archive', v2Raw: canonicalOwnerLocal([
    { code: '510300', name: '合成零份', account: '完整ACK合成账户', position_kind: 'holding', shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-24T00:00:00Z' },
  ]) }, original = await buildOwnerLegacyWorkspaceBackup(archive)
  const adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'fullack-adopt-0001', expected: await v3.readLocalState(guard),
    sourceArchive: archive, backupSha256: original.sha256 }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'fullack-old-link-0001', expected: await v4.readSyncState(guard),
    base: { pulledRevision: 1, records: [fund()] } }), guard)
  const old = await v4.readLocalState(guard)
  await v4.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fullack-local-name-0001', expected: old,
    command: { type: 'save', expectedEntry: old.snapshot.entries[0], confirmed: true,
      input: { code: '510300', name: '本机名称', account: '完整ACK合成账户', position_kind: 'holding', shares: -0, cost: null, target_weight: 0 } } }), guard)
  const source = { manualRaw: ' \n' + canonicalOwnerLocal([{ id: 'synthetic-cash', name: '合成现金', cls: '现金', value: -0, updated_at: '2026-10-24T00:00:00.12Z' }]) + '\r\n',
    snapshotsRaw: canonicalOwnerLocal([{ date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 }]) },
    portfolioFile = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), source)
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
    { id: 'fullack-portfolio-0001', backupRaw: portfolioFile.raw, backupSha256: portfolioFile.sha256 }), guard); handles.push(v5)
  const backup5 = await buildOwnerPortfolioRecoveryBackup(TARGET, await v5.readLocalState(guard)),
    v6 = await upgradeOwnerWorkspaceFullSync(factory, TARGET, await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET,
      { id: 'fullack-upgrade-0001', backupRaw: backup5.raw, backupSha256: backup5.sha256 }), guard); handles.push(v6)
  const before = await v6.readFullSyncState(guard), cloudFund = changed(fund(), { shares: 12 }, 2),
    linked = await v6.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(TARGET, { id: 'fullack-full-link-0001', expected: before,
      base: base([cloudFund, manual()]), minimumObservedRevision: 2, resolutions: [] }), guard)
  await v6.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullack-local-manual-0001', expected: linked.local,
    command: options.removeManual
      ? { type: 'remove_manual', key: ASSET, updated_at: '2026-10-25T00:00:00Z' }
      : { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T00:00:00Z', values: { name: '合成现金', cls: '现金', value: 8, note: null } } }), guard)
  let local = await v6.readFullSyncState(guard)
  if (options.rename) {
    await v6.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fullack-local-rename-0001', expected: local.local,
      command: { type: 'save', expectedEntry: local.local.snapshot.entries[0], confirmed: true,
        input: { code: '510300', name: '本机名称', account: '完整ACK更名账户', position_kind: 'holding', shares: 12, cost: null, target_weight: 0 } } }), guard)
    local = await v6.readFullSyncState(guard)
  }
  const packet = await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id: 'fullack-original-packet', expected: local }),
    prepared = await v6.prepareFullSync(packet, guard), attempted = await v6.transitionFullSyncDelivery(delivery(prepared, 'attempted'), guard),
    state = await v6.transitionFullSyncDelivery(delivery(attempted, options.terminal ?? 'confirmed'), guard)
  return { factory, controller, guard, v6, linked, beforePacket: local, state, packet, source, cloudFund }
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
function successInput(current: Awaited<ReturnType<typeof fixture>>, options: { receipt?: boolean; later?: boolean; id?: string } = {}): OwnerWorkspaceFullSyncAckInput {
  const postFund = changed(current.cloudFund, { name: '本机名称' }), postManual = current.state.local.portfolio!.manual[0].deleted
    ? { ...manual(), deleted: true, record_revision: 3, lifecycle_revision: 3 } : changed(manual(), { value: 8 }),
    result = { revision: 3, records: [postFund, postManual] },
    records = options.later ? [changed(postFund, { shares: 15 }, 4), changed(postManual, { note: '' }, 4)] : result.records
  return { id: options.id ?? 'fullack-commit-0001', expected: current.state,
    matchedResult: { source: options.receipt ? 'receipt' : 'write', requestId: current.packet.id, requestHash: current.packet.packet.requestHash,
      status: 200, rawBody: JSON.stringify(options.receipt ? { state: 'matched', status: 200, result } : result) },
    completeBaseline: base(records), minimumObservedRevision: options.later ? 4 : 3, resolutions: [] }
}
function conflictInput(current: Awaited<ReturnType<typeof fixture>>, options: { mode?: 'changed' | 'aba' | 'same-value' | 'tombstone'; resolved?: boolean } = {}): OwnerWorkspaceFullSyncAckInput {
  const mode = options.mode ?? 'changed', cloudManual = mode === 'tombstone' ? { ...manual(), deleted: true, record_revision: 4, lifecycle_revision: 4 }
    : changed(manual(), { value: mode === 'aba' ? 0 : mode === 'same-value' ? 8 : 12, note: 'cloud-note' }, 4),
    fields = mode === 'tombstone' ? ['deleted'] : ['value']
  return { id: 'fullack-conflict-0001', expected: current.state,
    matchedResult: { source: 'write', requestId: current.packet.id, requestHash: current.packet.packet.requestHash, status: 409,
      rawBody: JSON.stringify({ error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
        conflicts: [{ key_digest: sha(KEY).slice(0, 16), fields: ['name'] }, { key_digest: sha(ASSET).slice(0, 16), fields }] }) },
    completeBaseline: base([changed(current.cloudFund, { name: '另一设备名称' }), cloudManual]), minimumObservedRevision: 4,
    resolutions: options.resolved ? [{ key: KEY, field: 'name', choice: 'cloud' }, { key: ASSET, field: mode === 'tombstone' ? 'lifecycle' : 'value',
      choice: mode === 'tombstone' ? 'cloud' : 'local' }] : [] }
}

describe('actual strict complete-portfolio ACK commit', () => {
  it.each([false, true])('commits matched raw success, complete later D and all global versions/receipts in one strict transaction (receipt=%s)', async receipt => {
    const current = await fixture(), before = current.state, input = successInput(current, { receipt, later: true }),
      preview = await previewOwnerWorkspaceFullSyncAck(TARGET, input), request = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, input), physical = await image(current.factory)
    expect(request.hash).toBe(hash({ operation: 'portfolio-cloud-ack-1', target: TARGET, input, preview }))
    const forbidden = vi.fn(() => { throw new Error('no HTTP/legacy storage allowed') }); vi.stubGlobal('fetch', forbidden); vi.stubGlobal('localStorage', { getItem: forbidden })
    const actual = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put, writes: string[] = [], strict = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite') { expect(options?.durability).toBe('strict'); expect(tx.durability).toBe('strict'); strict() }
      return tx
    })
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) { writes.push(this.name); return put.call(this, value, key) })
    const state = await current.v6.ackFullSync(request, current.guard), after = await image(current.factory)
    expect(strict).toHaveBeenCalledOnce(); expect(writes).toEqual(['slot', 'working_copy', 'local_metadata', PORTFOLIO, FULL])
    expect(state.local.snapshot.localVersion).toBe(before.local.snapshot.localVersion + 1)
    expect(state.local.outbox).toEqual({ version: before.local.outbox.version + 1, entry: null })
    expect(state.fullSync).toEqual({ ...before.fullSync, epoch: before.fullSync.epoch + 1, pending: null, base: input.completeBaseline,
      recentReceipt: { id: request.id, hash: request.hash, operation: 'ack', syncEpoch: before.fullSync.epoch + 1,
        localVersion: state.local.snapshot.localVersion, outboxVersion: state.local.outbox.version } })
    expect(state.local.snapshot.entries[0]).toMatchObject({ local_pending: true, values: { name: '本机名称', shares: 15, cost: null, target_weight: 0 } })
    expect(state.local.portfolio!.manual[0]).toEqual({ ...before.local.portfolio!.manual[0], values: { ...manual().values, value: 8, note: '' } })
    expect(state.local.portfolio!.history).toEqual(before.local.portfolio!.history); expect(state.local.portfolio!.migration).toEqual(before.local.portfolio!.migration)
    expect(state.local.portfolio!.migration.manualRaw).toBe(current.source.manualRaw)
    expect(state.local.portfolio!.migration.snapshotsRaw).toBe(current.source.snapshotsRaw)
    expect(Object.is(state.local.portfolio!.history[0].value, -0)).toBe(true)
    expect(state.local.sync).toEqual(before.local.sync); expect(state.local.portfolioUpgrade).toEqual(before.local.portfolioUpgrade)
    expect(state.local.fullSyncUpgrade).toEqual(before.local.fullSyncUpgrade)
    expect(state.local.metadata).toEqual({ ...before.local.metadata, recentEdit: { id: request.id, hash: request.hash,
      beforeLocalVersion: before.local.snapshot.localVersion, localVersion: state.local.snapshot.localVersion, outboxVersion: state.local.outbox.version } })
    for (const name of ['sync_metadata', 'import_receipts']) expect(after[name]).toEqual(physical[name])
    expect(after[PORTFOLIO][1]).toEqual(physical[PORTFOLIO][1]); expect(after[FULL][1]).toEqual(physical[FULL][1])
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio)).toEqual({ issues: [], operations: [] })
    expect(await current.v6.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
    expect(await current.v6.fullSyncReceipt(current.packet.id, current.packet.hash, current.guard)).toEqual({ state: 'unknown' })
    expect(await (await reopen(current.factory)).readFullSyncState(current.guard)).toEqual(state)
    const backup = await buildOwnerFullSyncRecoveryBackup(TARGET, state.local)
    expect((await restoreOwnerFullSyncRecoveryBackup(backup.raw, backup.sha256)).local).toEqual(state.local)
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('applies a successful original manual deletion as a tombstone while preserving origin/time/raw/history', async () => {
    const current = await fixture({ removeManual: true }), input = successInput(current), request = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, input),
      state = await current.v6.ackFullSync(request, current.guard)
    expect(state.local.portfolio!.manual[0]).toEqual(current.state.local.portfolio!.manual[0])
    expect(state.local.portfolio!.manual[0].deleted).toBe(true)
    expect(state.local.portfolio!.manual[0].legacyId).toBe('synthetic-cash')
    expect(Object.is(state.local.portfolio!.manual[0].values.value, -0)).toBe(true)
    expect(state.local.portfolio!.history).toEqual(current.state.local.portfolio!.history)
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio)).toEqual({ issues: [], operations: [] })
  })
  it('owns input before hashing and owns the received sealed request before its first await', async () => {
    const current = await fixture(), source = { ...copy(successInput(current)) }, original = copy(source), pending = buildOwnerWorkspaceFullSyncAckRequest(TARGET, source)
    source.id = 'changed-after-builder-await'; source.completeBaseline = { pulledRevision: 0, records: [] }
    const request = await pending
    expect(request.id).toBe(original.id); expect(request.completeBaseline).toEqual(original.completeBaseline)
    const supplied = { ...copy(request) }, work = current.v6.ackFullSync(supplied, current.guard)
    supplied.id = 'changed-after-received-await'; supplied.hash = '1'.repeat(64); supplied.completeBaseline = { pulledRevision: 0, records: [] }
    const state = await work
    expect(state.fullSync.recentReceipt).toMatchObject({ id: original.id, hash: request.hash })
    expect(state.fullSync.base).toEqual(original.completeBaseline)
  })
})

describe('actual conflict ACK preserves intent until explicit choices', () => {
  it.each(['changed', 'aba', 'same-value'] as const)('rejects unresolved manual %s conflict and commits only explicit selected three-way postimage', async mode => {
    const current = await fixture({ terminal: 'conflict' }), input = conflictInput(current, { mode }), before = await image(current.factory),
      preview = await previewOwnerWorkspaceFullSyncAck(TARGET, input)
    expect(preview.nextSnapshot).toBeNull(); expect(preview.nextPortfolio).toBeNull()
    expect(preview.conflicts).toMatchObject([{ key: KEY, field: 'name' }, { key: ASSET, field: 'value',
      reason: mode === 'aba' ? 'field_aba' : 'field_changed' }])
    await expect(buildOwnerWorkspaceFullSyncAckRequest(TARGET, input)).rejects.toMatchObject({ code: 'workspace_conflict' })
    await expect(current.v6.ackFullSync({ ...input, hash: '1'.repeat(64) }, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
    const selected = conflictInput(current, { mode, resolved: true }), request = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, selected),
      state = await current.v6.ackFullSync(request, current.guard)
    expect(state.local.snapshot.entries[0].values.name).toBe('另一设备名称')
    expect(state.local.portfolio!.manual[0]).toEqual({ ...current.state.local.portfolio!.manual[0], values: { ...manual().values, value: 8, note: 'cloud-note' } })
    expect(state.fullSync.base).toEqual(selected.completeBaseline)
    const intent = planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio)
    expect(intent.issues).toEqual([])
    expect(intent.operations).toEqual(mode === 'same-value' ? [] : [{ key: ASSET, kind: 'manual_asset', deleted: false,
      changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: mode === 'aba' ? 0 : 12 } }])
    expect(state.local.outbox.entry).toBeNull()
  })
  it('cannot use local ACK selection to revive a cloud manual tombstone; choosing cloud commits the full tombstone', async () => {
    const current = await fixture({ terminal: 'conflict' }), input = conflictInput(current, { mode: 'tombstone' }), before = await image(current.factory),
      preview = await previewOwnerWorkspaceFullSyncAck(TARGET, input)
    expect(preview.conflicts[1]).toMatchObject({ key: ASSET, field: 'lifecycle', reason: 'cloud_tombstone', localAllowed: false })
    const invalid = { ...input, resolutions: [{ key: KEY, field: 'name', choice: 'cloud' }, { key: ASSET, field: 'lifecycle', choice: 'local' }] } as OwnerWorkspaceFullSyncAckInput
    await expect(buildOwnerWorkspaceFullSyncAckRequest(TARGET, invalid)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
    const selected = conflictInput(current, { mode: 'tombstone', resolved: true }), state = await current.v6.ackFullSync(await buildOwnerWorkspaceFullSyncAckRequest(TARGET, selected), current.guard)
    expect(state.local.portfolio!.manual[0].deleted).toBe(true)
    expect(state.local.portfolio!.manual[0].legacyId).toBe('synthetic-cash')
    expect(state.local.portfolio!.history).toEqual(current.state.local.portfolio!.history)
  })
  it('cancels a failed fund rename atomically while preserving the local fresh-key tombstone and manual remaining intent', async () => {
    const current = await fixture({ terminal: 'conflict', rename: true }), input: OwnerWorkspaceFullSyncAckInput = {
      id: 'fullack-rename-commit', expected: current.state, matchedResult: { source: 'write', requestId: current.packet.id,
        requestHash: current.packet.packet.requestHash, status: 409, rawBody: JSON.stringify({ error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
          conflicts: [{ key_digest: sha(KEY).slice(0, 16), fields: ['record_revision'] }] }) },
      completeBaseline: base([changed(current.cloudFund, { shares: 20 }), manual()]), minimumObservedRevision: 3, resolutions: [] },
      preview = await previewOwnerWorkspaceFullSyncAck(TARGET, input), group = preview.conflicts[0]
    expect(group).toMatchObject({ field: 'rename', reason: 'rename_atomic', groupKeys: [KEY, FRESH] })
    const selected: OwnerWorkspaceFullSyncAckInput = { ...input, resolutions: [{ key: group.key, field: 'rename', choice: 'cloud' }] },
      state = await current.v6.ackFullSync(await buildOwnerWorkspaceFullSyncAckRequest(TARGET, selected), current.guard)
    expect(state.local.snapshot.entries.find(row => row.key === KEY)).toMatchObject({ deleted: false, values: { shares: 20, name: '合成零份' } })
    expect(state.local.snapshot.entries.find(row => row.key === FRESH)).toMatchObject({ deleted: true, local_pending: true, values: { shares: 12 } })
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio).operations).toEqual([
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: -0 } },
    ])
    expect((await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id: 'fullack-next-manual-only', expected: state })).packet.request.operations[0].kind).toBe('manual_asset')
  })
})

describe('actual ACK closed provenance-shaped input and final strict CAS', () => {
  it.each(['unknown-slot', 'slot-outcome', 'wrong-id', 'wrong-hash', 'partial-success', 'wrong-value', 'missing-D', 'regressed-floor'] as const)
    ('rejects %s and preserves the whole original terminal/unknown packet', async mode => {
      const current = await fixture({ terminal: mode === 'unknown-slot' ? 'unknown' : mode === 'slot-outcome' ? 'conflict' : 'confirmed' }), before = await image(current.factory),
        original = successInput(current), matched = { ...original.matchedResult }
      let input: OwnerWorkspaceFullSyncAckInput = original
      if (mode === 'wrong-id') matched.requestId = 'another-original-request'
      if (mode === 'wrong-hash') matched.requestHash = '1'.repeat(64)
      if (mode === 'partial-success' || mode === 'wrong-value') {
        const result = JSON.parse(matched.rawBody)
        if (mode === 'partial-success') result.records = result.records.slice(0, 1)
        else result.records[1].values.value = 9
        matched.rawBody = JSON.stringify(result)
      }
      if (mode === 'missing-D') input = { ...input, completeBaseline: base(input.completeBaseline.records.filter(row => row.kind !== 'manual_asset')) }
      if (mode === 'regressed-floor') input = { ...input, minimumObservedRevision: 4 }
      input = { ...input, matchedResult: matched }
      await expect(buildOwnerWorkspaceFullSyncAckRequest(TARGET, input)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it.each(['hash', 'extra', 'getter', 'nested-getter', 'hidden', 'symbol', 'changed-raw', 'changed-D', 'changed-resolution', 'changed-expected'] as const)
    ('rejects %s instead of trusting a sealed caller preview', async fault => {
      const current = await fixture(), request = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, successInput(current)), before = await image(current.factory), getter = vi.fn()
      let supplied: unknown = { ...request }
      if (fault === 'hash') supplied = { ...request, hash: '1'.repeat(64) }
      if (fault === 'extra') supplied = { ...request, preview: { nextPortfolio: null } }
      if (fault === 'getter') supplied = Object.defineProperty({ ...request }, 'expected', { enumerable: true, get: getter })
      if (fault === 'nested-getter') supplied = { ...request, matchedResult: Object.defineProperty({ ...request.matchedResult }, 'rawBody', { enumerable: true, get: getter }) }
      if (fault === 'hidden') supplied = Object.defineProperty({ ...request }, 'hidden', { value: true })
      if (fault === 'symbol') supplied = Object.defineProperty({ ...request }, Symbol('secret'), { enumerable: true, value: true })
      if (fault === 'changed-raw') supplied = { ...request, matchedResult: { ...request.matchedResult, rawBody: request.matchedResult.rawBody + ' ' } }
      if (fault === 'changed-D') supplied = { ...request, completeBaseline: base([changed(current.cloudFund, { name: 'changed' }), changed(manual(), { value: 8 })]) }
      if (fault === 'changed-resolution') supplied = { ...request, resolutions: [{ key: ASSET, field: 'value', choice: 'cloud' }] }
      if (fault === 'changed-expected') supplied = { ...request, expected: { ...request.expected, fullSync: { ...request.expected.fullSync, epoch: 999 } } }
      await expect(current.v6.ackFullSync(supplied as OwnerWorkspaceFullSyncAckRequest, current.guard)).rejects.toBeInstanceOf(Error)
      expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
    })
  it('serializes two genuine ACK ids sealed from the same original complete image, and never replays the loser', async () => {
    const current = await fixture(), other = await reopen(current.factory), one = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, successInput(current)),
      two = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, successInput(current, { id: 'fullack-second-ack-id' })),
      results = await Promise.allSettled([current.v6.ackFullSync(one, current.guard), other.ackFullSync(two, current.guard)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1); expect(results.filter(row => row.status === 'rejected')).toHaveLength(1)
    const fresh = await reopen(current.factory), state = await fresh.readFullSyncState(current.guard), winner = results[0].status === 'fulfilled' ? one : two,
      loser = results[0].status === 'fulfilled' ? two : one
    expect(state.local.snapshot.localVersion).toBe(current.state.local.snapshot.localVersion + 1)
    expect(state.local.outbox.version).toBe(current.state.local.outbox.version + 1); expect(state.fullSync.epoch).toBe(current.state.fullSync.epoch + 1)
    expect(await fresh.fullSyncReceipt(winner.id, winner.hash, current.guard)).toEqual({ state: 'matched', value: state })
    expect(await fresh.fullSyncReceipt(loser.id, loser.hash, current.guard)).toEqual({ state: 'unknown' })
    const before = await image(current.factory)
    await expect(fresh.ackFullSync(loser, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
  })
  it('retains the original packet when D cannot fit all cloud-only manual additions without trimming', async () => {
    const current = await fixture(), input = successInput(current), extra = Array.from({ length: 2000 }, (_, index): OwnerSyncRecord => ({
      ...manual(), key: 'asset:cloud-extra-' + index, record_revision: 4, lifecycle_revision: 4,
      field_revisions: { name: 4, cls: 4, value: 4, note: 4 },
    })), before = await image(current.factory)
    await expect(buildOwnerWorkspaceFullSyncAckRequest(TARGET, { ...input, completeBaseline: base([...input.completeBaseline.records, ...extra]) })).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
    expect((await current.v6.readFullSyncState(current.guard)).fullSync.pending).toEqual(current.state.fullSync.pending)
  })
})

describe('actual strict ACK lost response and complete rollback', () => {
  it('keeps a genuine commit after authority loss, manually matches only its original id/hash and later returns unknown after local edit', async () => {
    const current = await fixture(), request = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, successInput(current)),
      transaction = IDBDatabase.prototype.transaction, committed = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = transaction.call(this, names, mode, options)
      if (mode === 'readwrite' && Array.isArray(names) && names.includes(FULL)) tx.addEventListener('complete', () => { committed(); current.controller.abort() }, { once: true })
      return tx
    })
    await expect(current.v6.ackFullSync(request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(committed).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    const { guard } = context(), fresh = await reopen(current.factory), state = await fresh.readFullSyncState(guard), before = await image(current.factory)
    expect(state.local.snapshot.localVersion).toBe(current.state.local.snapshot.localVersion + 1)
    expect(state.fullSync.pending).toBeNull(); expect(state.local.outbox.entry).toBeNull()
    expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'matched', value: state })
    await expect(fresh.fullSyncReceipt(request.id, '1'.repeat(64), guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await image(current.factory)).toEqual(before)
    const edited = await fresh.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullack-after-manual-edit', expected: state.local,
      command: { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T02:00:00Z', values: { name: '合成现金', cls: '现金', value: 9, note: null } } }), guard)
    expect(edited.snapshot.localVersion).toBe(state.local.snapshot.localVersion + 1)
    expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
  })
  it.each(['quota', 'after-put-abort', 'revoked-before', 'revoked-after-put', 'closed-before', 'closed-after-put', 'relaxed', 'default'] as const)
    ('preserves the original full packet and every local/base/history/receipt row on %s', async fault => {
      const current = await fixture(), request = await buildOwnerWorkspaceFullSyncAckRequest(TARGET, successInput(current)), before = await image(current.factory),
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
      await expect(current.v6.ackFullSync(request, current.guard)).rejects.toBeInstanceOf(Error); vi.restoreAllMocks()
      expect(await image(current.factory)).toEqual(before)
      const { guard } = context(), fresh = await reopen(current.factory)
      expect(await fresh.readFullSyncState(guard)).toEqual(current.state)
      expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
      expect(await fresh.fullSyncReceipt(current.packet.id, current.packet.hash, guard)).toEqual({ state: 'matched', value: current.state })
    })
})
