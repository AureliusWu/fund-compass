/** Real public workspace/codec/strict-IDB initial-link operations. Synthetic
 * records and controlled storage faults are not Chrome/PWA, actual cloud,
 * POST/ACK, deployment or disaster-recovery evidence. No validators are mocked. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspaceEditPortfolioRequest, buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  buildOwnerWorkspaceFullSyncUpgradeRequest, buildOwnerWorkspaceFullSyncLinkRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceFullSyncState, type OwnerWorkspaceFullSyncLinkRequest,
} from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { buildOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { parseOwnerBusinessJson } from '@/utils/owner-legacy-seed'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'
import { buildOwnerSyncRequest, OWNER_SYNC_MAX_BODY_BYTES, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import type { OwnerPortfolioInitialMergeResolution } from '@/utils/owner-portfolio-merge'

const TARGET = '7'.repeat(64), KEY = '510300::完整联结合成账户', OTHER = '000002::云独有合成账户'
const ASSET = 'asset:synthetic-cash', IMPORTED = 'asset:remote-only', GONE = 'asset:old-cloud-tombstone'
const FULL_SYNC = 'portfolio_sync_metadata', PORTFOLIO = 'portfolio_metadata', PRIVATE = 'opaque-original-never-replaced'
const handles: OwnerWorkspace[] = []
const hash = (value: unknown) => createHash('sha256').update(canonicalOwnerLocal(value), 'utf8').digest('hex')
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function context() {
  const controller = new AbortController()
  return { controller, guard: { signal: controller.signal, assertActive() {
    if (controller.signal.aborted) throw new Error('synthetic authority revoked')
  } } satisfies OwnerWorkspaceGuard }
}
function fund(patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 3, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 3, cost: 1, target_weight: 1 },
    values: { name: '合成零份', shares: -0, cost: null, target_weight: 0 }, ...patch }
}
function manual(patch: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { key: GONE, kind: 'manual_asset', deleted: true, record_revision: 2, lifecycle_revision: 2,
    field_revisions: { name: 1, cls: 1, value: 2, note: 1 },
    values: { name: '旧云墓碑', cls: '现金', value: -0, note: null }, ...patch }
}
function baseline(records: readonly OwnerSyncRecord[]): OwnerSyncBaseline {
  return { pulledRevision: Math.max(0, ...records.map(row => row.record_revision)), records }
}
function cloud(): OwnerSyncBaseline {
  return baseline([fund({ record_revision: 4, field_revisions: { name: 1, shares: 4, cost: 1, target_weight: 1 },
    values: { ...fund().values, shares: 12 } }), manual(),
  manual({ key: IMPORTED, deleted: false, record_revision: 4, lifecycle_revision: 4,
    field_revisions: { name: 4, cls: 4, value: 4, note: 4 }, values: { name: '云独有现金', cls: '现金', value: -0, note: null } })])
}
function choice(key: string, field: OwnerPortfolioInitialMergeResolution['field'], side: 'local' | 'cloud'): OwnerPortfolioInitialMergeResolution {
  return { key, field, choice: side }
}
async function fixture(options: { editName?: boolean; manualCount?: number; note?: string } = {}) {
  const factory = new IDBFactory(), { controller, guard } = context(), v3 = await openOwnerWorkspace(factory, TARGET)
  handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: PRIVATE,
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '合成零份', account: '完整联结合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-24T00:00:00Z' }]) }
  const backup3 = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'fulllink-adopt-0001',
    expected: await v3.readLocalState(guard), sourceArchive, backupSha256: backup3.sha256 }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'fulllink-old-B-0001',
    expected: await v4.readSyncState(guard), base: baseline([fund(), manual()]) }), guard)
  if (options.editName !== false) {
    const before = await v4.readLocalState(guard)
    await v4.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fulllink-name-edit-0001', expected: before,
      command: { type: 'save', expectedEntry: before.snapshot.entries[0], confirmed: true,
        input: { code: '510300', name: '本机已编辑名称', account: '完整联结合成账户', position_kind: 'holding',
          shares: -0, cost: null, target_weight: 0 } } }), guard)
  }
  const source = { manualRaw: ' \n' + canonicalOwnerLocal(Array.from({ length: options.manualCount ?? 1 }, (_, index) => ({
    id: index ? 'synthetic-cash-' + index : 'synthetic-cash', name: '合成现金 ' + index, cls: '现金', value: -0,
    ...(options.note === undefined ? {} : { note: options.note }), updated_at: '2026-10-24T00:00:00.12Z',
  }))) + '\r\n', snapshotsRaw: canonicalOwnerLocal([
    { date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 },
  ]) }
  const portfolioBackup = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), source)
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
    { id: 'fulllink-portfolio-upgrade', backupRaw: portfolioBackup.raw, backupSha256: portfolioBackup.sha256 }), guard)
  handles.push(v5)
  const backup5 = await buildOwnerPortfolioRecoveryBackup(TARGET, await v5.readLocalState(guard))
  const v6 = await upgradeOwnerWorkspaceFullSync(factory, TARGET, await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET,
    { id: 'fulllink-full-upgrade-0001', backupRaw: backup5.raw, backupSha256: backup5.sha256 }), guard)
  handles.push(v6)
  return { factory, controller, guard, v6, state: await v6.readFullSyncState(guard), source }
}
async function reopen(factory: IDBFactory) {
  const handle = await openOwnerWorkspace(factory, TARGET, { existingOnly: true }); handles.push(handle); return handle
}
async function rawOpen(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
}
async function image(factory: IDBFactory) {
  const db = await rawOpen(factory)
  try { return await new Promise<{ version: number; stores: Record<string, unknown[]> }>((resolve, reject) => {
    const names = [...db.objectStoreNames], tx = db.transaction(names), stores: Record<string, unknown[]> = {}
    for (const name of names) { const read = tx.objectStore(name).getAll(); read.onsuccess = () => { stores[name] = read.result } }
    tx.oncomplete = () => resolve({ version: db.version, stores }); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function mutate(factory: IDBFactory, store: string, value: unknown, key = 'current') {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
function copy<T>(value: T): T { return parseOwnerBusinessJson(canonicalOwnerLocal(value), 24 * 1024 * 1024, 12) as T }
async function linkRequest(expected: OwnerWorkspaceFullSyncState, base = cloud(), resolutions: readonly OwnerPortfolioInitialMergeResolution[] = [], id = 'fulllink-request-0001') {
  return buildOwnerWorkspaceFullSyncLinkRequest(TARGET, { id, expected, base, minimumObservedRevision: base.pulledRevision, resolutions })
}
function rehash(request: OwnerWorkspaceFullSyncLinkRequest): OwnerWorkspaceFullSyncLinkRequest {
  return { ...request, hash: hash({ operation: 'portfolio-full-link-1', target: TARGET, id: request.id, expected: request.expected,
    base: request.base, minimumObservedRevision: request.minimumObservedRevision, resolutions: request.resolutions }) }
}
async function editRequest(expected: OwnerWorkspaceFullSyncState, type: 'fund' | 'manual' | 'history') {
  if (type === 'fund') return buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fulllink-racing-fund-0001', expected: expected.local,
    command: { type: 'save', expectedEntry: expected.local.snapshot.entries[0], confirmed: true,
      input: { code: '510300', name: '之后的基金名称', account: '完整联结合成账户', position_kind: 'holding', shares: 9, cost: null, target_weight: 0 } } })
  return buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fulllink-racing-' + type + '-0001', expected: expected.local,
    command: type === 'manual'
      ? { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T01:00:00Z', values: { name: '合成现金 0', cls: '现金', value: 9, note: null } }
      : { type: 'append_observation', observation: { id: 'fulllink-history-0001', kind: 'observation',
        observed_at: '2026-10-24T16:01:00Z', date: '2026-10-25', calendar: 'Asia/Shanghai', value: 0, cost: null,
        holdings: [{ kind: 'manual', key: ASSET, name: '合成现金 0', cls: '现金', value: 0, cost: null }] } } })
}

describe('actual strict v6 complete-portfolio initial link', () => {
  it('atomically keeps B→L name, absorbs C shares, imports complete manual/tombstones and advances one local/slot/full epoch/receipt', async () => {
    const current = await fixture(), before = current.state, request = await linkRequest(before), raw = canonicalOwnerLocal(before)
    const forbidden = vi.fn(() => { throw new Error('network and legacy storage forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden })
    const txs: { mode: IDBTransactionMode | undefined; names: string[]; durability: IDBTransactionDurability }[] = []
    const actual = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      txs.push({ mode, names: typeof names === 'string' ? [names] : [...names], durability: tx.durability }); return tx
    })
    const state = await current.v6.linkFullSyncBase(request, current.guard)
    expect(state.local.snapshot.localVersion).toBe(before.local.snapshot.localVersion + 1)
    expect(state.local.outbox).toEqual({ version: before.local.outbox.version + 1, entry: null })
    expect(state.fullSync).toEqual({ ...before.fullSync, epoch: before.fullSync.epoch + 1, base: request.base,
      recentReceipt: { id: request.id, hash: request.hash, operation: 'link', syncEpoch: before.fullSync.epoch + 1,
        localVersion: state.local.snapshot.localVersion, outboxVersion: state.local.outbox.version } })
    expect(state.local.fullSync).toEqual(state.fullSync)
    expect(state.local.snapshot.entries[0]).toMatchObject({ values: { name: '本机已编辑名称', shares: 12, cost: null, target_weight: 0 }, local_pending: true })
    expect(state.local.sync).toEqual(before.local.sync); expect(state.local.portfolioUpgrade).toEqual(before.local.portfolioUpgrade)
    expect(state.local.fullSyncUpgrade).toEqual(before.local.fullSyncUpgrade)
    expect(state.local.portfolio!.history).toEqual(before.local.portfolio!.history)
    expect(state.local.portfolio!.migration).toEqual(before.local.portfolio!.migration)
    expect(state.local.portfolio!.migration.manualRaw).toBe(current.source.manualRaw)
    expect(state.local.portfolio!.migration.snapshotsRaw).toBe(current.source.snapshotsRaw)
    expect(state.local.portfolio!.manual.find(row => row.key === ASSET)).toEqual(before.local.portfolio!.manual[0])
    expect(state.local.portfolio!.manual.find(row => row.key === IMPORTED)).toMatchObject({ legacyId: null, updated_at: null,
      deleted: false, local_pending: true, values: { value: -0, note: null } })
    expect(state.local.portfolio!.manual.find(row => row.key === GONE)).toMatchObject({ deleted: true, legacyId: null, updated_at: null })
    expect(Object.is(state.local.portfolio!.manual.find(row => row.key === IMPORTED)!.values.value, -0)).toBe(true)
    expect(Object.is(state.local.portfolio!.history[0].value, -0)).toBe(true)
    expect(state.local.metadata).toEqual({ ...before.local.metadata, recentEdit: { id: request.id, hash: request.hash,
      beforeLocalVersion: before.local.snapshot.localVersion, localVersion: state.local.snapshot.localVersion, outboxVersion: state.local.outbox.version } })
    const intent = planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio)
    expect(intent.issues).toEqual([])
    expect(intent.operations).toEqual([
      { key: KEY, kind: 'holding', deleted: false, changes: { name: '本机已编辑名称' }, base_values: { kind: 'holding', deleted: false, name: '合成零份' } },
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: before.local.portfolio!.manual[0].values, base_values: {} },
    ])
    expect(txs.filter(row => row.mode === 'readwrite')).toEqual([{ mode: 'readwrite', durability: 'strict',
      names: expect.arrayContaining(['slot', 'working_copy', 'import_receipts', 'local_metadata', 'sync_metadata', PORTFOLIO, FULL_SYNC]) }])
    expect(canonicalOwnerLocal(before)).toBe(raw); expect(forbidden).not.toHaveBeenCalled()
    expect(await current.v6.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
    const other = await reopen(current.factory)
    expect(await other.readFullSyncState(current.guard)).toEqual(state)
    expect(await other.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
  })
  it('hashes every original request field in the independent full-link domain and owns caller references before awaiting', async () => {
    const current = await fixture(), source = { id: 'fulllink-owned-input-0001', expected: copy(current.state), base: cloud(), minimumObservedRevision: 4, resolutions: [] }
    const original = copy(source), pending = buildOwnerWorkspaceFullSyncLinkRequest(TARGET, source)
    source.id = 'later-caller-id-0001'; source.base = baseline([]); source.minimumObservedRevision = 0
    source.expected = { ...source.expected, local: { ...source.expected.local, receiptCount: 999 } }
    const request = await pending
    expect(request.hash).toBe(hash({ operation: 'portfolio-full-link-1', target: TARGET, ...original }))
    expect(request.id).toBe(original.id); expect(request.base).toEqual(original.base); expect(Object.isFrozen(request)).toBe(true)
    const supplied = { ...copy(request) }, delivery = current.v6.linkFullSyncBase(supplied, current.guard)
    supplied.base = baseline([]); supplied.id = 'later-delivery-id-0001'; supplied.hash = '1'.repeat(64)
    const state = await delivery
    expect(state.fullSync.base).toEqual(original.base)
    expect(state.fullSync.recentReceipt).toMatchObject({ id: original.id, hash: request.hash })
  })
  it('imports a cloud-only fund with unknown display time while retaining existing source timestamp/raw archives', async () => {
    const current = await fixture(), extra = fund({ key: OTHER, record_revision: 4, lifecycle_revision: 4,
      field_revisions: { name: 4, shares: 4, cost: 4, target_weight: 4 } }),
      base = baseline([...cloud().records, extra]), state = await current.v6.linkFullSyncBase(await linkRequest(current.state, base), current.guard)
    expect(state.local.metadata.displayTimes).toEqual([...current.state.local.metadata.displayTimes, { key: OTHER, updated_at: null }])
    expect(state.local.metadata.restoredArchives).toEqual(current.state.local.metadata.restoredArchives)
    expect(state.local.metadata.adoption).toEqual(current.state.local.metadata.adoption)
  })
  it('refuses a new initial-link request once this full profile has a base, without rewriting prior state or receipt', async () => {
    const current = await fixture(), request = await linkRequest(current.state), state = await current.v6.linkFullSyncBase(request, current.guard), before = await image(current.factory)
    await expect(linkRequest(state, cloud(), [], 'fulllink-second-id-0001')).rejects.toMatchObject({ code: 'workspace_pending' })
    const supplied = rehash({ ...request, id: 'fulllink-second-id-0001', expected: state })
    await expect(current.v6.linkFullSyncBase(supplied, current.guard)).rejects.toMatchObject({ code: 'workspace_pending' })
    expect(await image(current.factory)).toEqual(before)
  })
})

describe('real initial link conflict and complete-preimage boundaries', () => {
  it.each(['changed', 'aba', 'same-value'] as const)('rejects unresolved %s local/cloud edits without a partial fund/manual/base/receipt write', async mode => {
    const current = await fixture(), cost = mode === 'aba' ? '合成零份' : mode === 'same-value' ? '本机已编辑名称' : '另一设备名称',
      changed = fund({ record_revision: 4, field_revisions: { name: 4, shares: 3, cost: 1, target_weight: 1 }, values: { ...fund().values, name: cost } }),
      base = baseline([changed, manual()]), before = await image(current.factory)
    await expect(linkRequest(current.state, base)).rejects.toMatchObject({ code: 'workspace_conflict' })
    const resolved = await linkRequest(current.state, base, [choice(KEY, 'name', 'local')]), forged = rehash({ ...resolved, resolutions: [] })
    await expect(current.v6.linkFullSyncBase(forged, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
    expect(await current.v6.fullSyncReceipt(forged.id, forged.hash, current.guard)).toEqual({ state: 'unknown' })
  })
  it('rejects attempted local revival of a cloud tombstone even with a self-consistent full-link hash', async () => {
    const current = await fixture(), deleted = fund({ deleted: true, record_revision: 4, lifecycle_revision: 4 }),
      base = baseline([deleted, manual()]), before = await image(current.factory),
      request = await linkRequest(current.state, base, [choice(KEY, 'lifecycle', 'cloud')]),
      forbidden = rehash({ ...request, resolutions: [choice(KEY, 'lifecycle', 'local')] })
    await expect(current.v6.linkFullSyncBase(forbidden, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
    const state = await current.v6.linkFullSyncBase(request, current.guard)
    expect(state.local.snapshot.entries[0].deleted).toBe(true); expect(state.fullSync.base).toEqual(base)
  })
  it('does not promote the historical B manual into an applied ancestor when local manual collides for the first time', async () => {
    const current = await fixture(), collision = manual({ key: ASSET, deleted: false, record_revision: 4, lifecycle_revision: 4,
      field_revisions: { name: 4, cls: 4, value: 4, note: 4 }, values: { name: '云现金', cls: '权益', value: 20, note: '云端备注' } }),
      base = baseline([...cloud().records, collision]), before = await image(current.factory)
    await expect(linkRequest(current.state, base)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
    const request = await linkRequest(current.state, base, [choice(ASSET, 'lifecycle', 'cloud')]), state = await current.v6.linkFullSyncBase(request, current.guard)
    expect(state.local.portfolio!.manual.find(row => row.key === ASSET)).toEqual({ ...current.state.local.portfolio!.manual[0], values: collision.values })
    expect(state.local.portfolio!.migration).toEqual(current.state.local.portfolio!.migration)
    expect(state.local.portfolio!.history).toEqual(current.state.local.portfolio!.history)
  })
  it.each(['fund', 'manual', 'history'] as const)('serializes a real %s writer and initial link made from the same complete image across two handles', async type => {
    const current = await fixture(), other = await reopen(current.factory), request = await linkRequest(current.state)
    const edit = await editRequest(current.state, type)
    const writer = type === 'fund'
      ? other.editLocal(edit as Awaited<ReturnType<typeof buildOwnerWorkspaceEditLocalRequest>>, current.guard)
      : other.editPortfolio(edit as Awaited<ReturnType<typeof buildOwnerWorkspaceEditPortfolioRequest>>, current.guard)
    const outcomes = await Promise.allSettled([current.v6.linkFullSyncBase(request, current.guard), writer])
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
    const state = await (await reopen(current.factory)).readFullSyncState(current.guard)
    expect(state.local.snapshot.localVersion).toBe(current.state.local.snapshot.localVersion + 1)
    expect(state.local.outbox.version).toBe(current.state.local.outbox.version + 1)
    if (outcomes[0].status === 'fulfilled') {
      expect(state.fullSync.base).toEqual(request.base); expect(state.fullSync.epoch).toBe(1)
      expect(state.local.metadata.recentEdit).toMatchObject({ id: request.id, hash: request.hash })
      expect(state.local.portfolio!.history).toEqual(current.state.local.portfolio!.history)
    } else {
      expect(state.fullSync).toEqual(current.state.fullSync)
      expect(state.local.metadata.recentEdit).toMatchObject({ id: edit.id, hash: edit.hash })
      if (type === 'fund') expect(state.local.snapshot.entries[0].values.shares).toBe(9)
      if (type === 'manual') expect(state.local.portfolio!.manual[0].values.value).toBe(9)
      if (type === 'history') expect(state.local.portfolio!.history).toHaveLength(current.state.local.portfolio!.history.length + 1)
    }
  })
  it.each(['fund', 'manual', 'history'] as const)('rejects a stale complete link request after a real %s writer commits, preserving that exact later image', async type => {
    const current = await fixture(), other = await reopen(current.factory), request = await linkRequest(current.state), edit = await editRequest(current.state, type)
    if (type === 'fund') await other.editLocal(edit as Awaited<ReturnType<typeof buildOwnerWorkspaceEditLocalRequest>>, current.guard)
    else await other.editPortfolio(edit as Awaited<ReturnType<typeof buildOwnerWorkspaceEditPortfolioRequest>>, current.guard)
    const before = await image(current.factory)
    await expect(current.v6.linkFullSyncBase(request, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['fund', 'manual', 'history'] as const)('rechecks the full image in the final strict CAS after a %s writer overtakes the completed readonly preflight', async type => {
    const current = await fixture(), other = await reopen(current.factory), request = await linkRequest(current.state), edit = await editRequest(current.state, type)
    const actualTransaction = IDBDatabase.prototype.transaction, actualDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
    let readComplete = false, paused = false, strictWrites = 0, release: (() => void) | undefined, reached: (() => void) | undefined
    const held = new Promise<void>(resolve => { release = resolve }), gate = new Promise<void>(resolve => { reached = resolve })
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actualTransaction.call(this, names, mode, options)
      if (Array.isArray(names) && names.includes(FULL_SYNC)) {
        if (mode === 'readonly') tx.addEventListener('complete', () => { readComplete = true }, { once: true })
        if (mode === 'readwrite') strictWrites++
      }
      return tx
    })
    // Delegate every digest to the real implementation. Only one asynchronous
    // completion is held: no codec/validator or transaction result is replaced.
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const result = await actualDigest(algorithm, data)
      if (readComplete && !paused) { paused = true; reached!(); await held }
      return result
    })
    const delivery = current.v6.linkFullSyncBase(request, current.guard), rejected = expect(delivery).rejects.toMatchObject({ code: 'workspace_conflict' })
    await gate
    if (type === 'fund') await other.editLocal(edit as Awaited<ReturnType<typeof buildOwnerWorkspaceEditLocalRequest>>, current.guard)
    else await other.editPortfolio(edit as Awaited<ReturnType<typeof buildOwnerWorkspaceEditPortfolioRequest>>, current.guard)
    const winner = await image(current.factory)
    release!(); await rejected
    expect(paused).toBe(true); expect(strictWrites).toBe(2)
    vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(winner)
    const state = await (await reopen(current.factory)).readFullSyncState(current.guard)
    expect(state.fullSync).toEqual(current.state.fullSync)
    expect(state.local.metadata.recentEdit).toMatchObject({ id: edit.id, hash: edit.hash })
    expect(await (await reopen(current.factory)).fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'unknown' })
  })
  it.each(['portfolio-intent', 'full-sync-intent'] as const)('binds immutable %s in the complete preimage even on a fresh handle', async fault => {
    const current = await fixture(), request = await linkRequest(current.state)
    if (fault === 'portfolio-intent') {
      const old = current.state.local.portfolioUpgrade!, id = 'fulllink-changed-portfolio-intent'
      await mutate(current.factory, PORTFOLIO, { ...old, id,
        hash: hash({ operation: 'portfolio-upgrade-1', target: TARGET, id, backupSha256: old.backupSha256 }) }, 'intent')
    } else {
      const old = current.state.local.fullSyncUpgrade!, id = 'fulllink-changed-full-intent'
      await mutate(current.factory, FULL_SYNC, { ...old, id,
        hash: hash({ operation: 'portfolio-sync-upgrade-1', target: TARGET, id, backupSha256: old.backupSha256 }) }, 'intent')
    }
    const before = await image(current.factory), fresh = await reopen(current.factory)
    await expect(fresh.linkFullSyncBase(request, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['hash', 'extra', 'getter', 'hidden', 'symbol', 'changed-base', 'changed-ref', 'changed-floor', 'changed-expected-copy'] as const)
    ('rejects %s without invoking getters or touching storage', async fault => {
      const current = await fixture(), request = await linkRequest(current.state), before = await image(current.factory), getter = vi.fn()
      let supplied: unknown = { ...request }
      if (fault === 'hash') supplied = { ...request, hash: '1'.repeat(64) }
      if (fault === 'extra') supplied = { ...request, extra: true }
      if (fault === 'getter') supplied = Object.defineProperty({ ...request }, 'base', { enumerable: true, get: getter })
      if (fault === 'hidden') supplied = Object.defineProperty({ ...request }, 'hidden', { value: PRIVATE })
      if (fault === 'symbol') supplied = Object.defineProperty({ ...request }, Symbol('secret'), { enumerable: true, value: PRIVATE })
      if (fault === 'changed-base') supplied = { ...request, base: baseline([fund(), manual()]) }
      if (fault === 'changed-ref') supplied = { ...request, expected: { ...request.expected, fullSync: { ...request.expected.fullSync, epoch: 1 } } }
      if (fault === 'changed-floor') supplied = { ...request, minimumObservedRevision: 3 }
      if (fault === 'changed-expected-copy') supplied = { ...request, expected: { ...request.expected,
        local: { ...request.expected.local, snapshot: { ...request.expected.local.snapshot, legacy: null } } } }
      await expect(current.v6.linkFullSyncBase(supplied as OwnerWorkspaceFullSyncLinkRequest, current.guard)).rejects.toBeInstanceOf(Error)
      expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
    })
  it('rejects a nested getter inside an otherwise complete expected history before hash canonicalization', async () => {
    const current = await fixture(), request = copy(await linkRequest(current.state)), before = await image(current.factory), getter = vi.fn()
    Object.defineProperty(request.expected.local.portfolio!.history[0], 'date', { enumerable: true, get: getter })
    await expect(current.v6.linkFullSyncBase(request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
  })
})

describe('initial link unknown-local-response receipts and strict rollback', () => {
  it('retains an actual commit after guard loss and manually matches only original id/hash without replaying link', async () => {
    const current = await fixture(), request = await linkRequest(current.state), actual = IDBDatabase.prototype.transaction, committed = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite' && Array.isArray(names) && names.includes(FULL_SYNC)) tx.addEventListener('complete', () => {
        committed(); current.controller.abort()
      }, { once: true })
      return tx
    })
    await expect(current.v6.linkFullSyncBase(request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(committed).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    const { guard } = context(), fresh = await reopen(current.factory), state = await fresh.readFullSyncState(guard), physical = await image(current.factory)
    expect(state.local.snapshot.localVersion).toBe(current.state.local.snapshot.localVersion + 1)
    expect(state.fullSync.base).toEqual(request.base)
    expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'matched', value: state })
    expect(await fresh.fullSyncReceipt('fulllink-unknown-id-0001', request.hash, guard)).toEqual({ state: 'unknown' })
    await expect(fresh.fullSyncReceipt(request.id, '1'.repeat(64), guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await image(current.factory)).toEqual(physical)
    const edit = await editRequest(state, 'manual')
    await fresh.editPortfolio(edit as Awaited<ReturnType<typeof buildOwnerWorkspaceEditPortfolioRequest>>, guard)
    expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
    const after = await fresh.readFullSyncState(guard)
    expect(after.fullSync.base).toEqual(state.fullSync.base); expect(after.fullSync.epoch).toBe(state.fullSync.epoch)
    expect(after.local.snapshot.localVersion).toBe(state.local.snapshot.localVersion + 1)
  })
  it.each(['relaxed', 'default', 'missing', 'throw'] as const)('refuses %s write durability and retains every original store row', async durability => {
    const current = await fixture(), request = await linkRequest(current.state), before = await image(current.factory), actual = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite') Object.defineProperty(tx, 'durability', { configurable: true, get() {
        if (durability === 'throw') throw new Error('unsupported durability')
        return durability === 'missing' ? undefined : durability
      } })
      return tx
    })
    await expect(current.v6.linkFullSyncBase(request, current.guard)).rejects.toBeInstanceOf(Error)
    vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before)
    expect(await (await reopen(current.factory)).fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'unknown' })
  })
  it.each(['quota', 'after-put-abort', 'revoked-before', 'revoked-after-put', 'closed-before', 'closed-after-put'] as const)
    ('rolls back every fund/manual/history/base/epoch/receipt row on %s', async fault => {
      const current = await fixture(), request = await linkRequest(current.state), before = await image(current.factory), actual = IDBObjectStore.prototype.put
      if (fault === 'revoked-before') current.controller.abort()
      if (fault === 'closed-before') current.v6.close()
      if (!['revoked-before', 'closed-before'].includes(fault)) vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (this.name === FULL_SYNC && key === 'current' && fault === 'quota') throw new DOMException('Synthetic quota', 'QuotaExceededError')
        const pending = actual.call(this, value, key)
        if (this.name === FULL_SYNC && key === 'current') {
          if (fault === 'after-put-abort') pending.addEventListener('success', () => this.transaction.abort())
          if (fault === 'revoked-after-put') current.controller.abort()
          if (fault === 'closed-after-put') current.v6.close()
        }
        return pending
      })
      await expect(current.v6.linkFullSyncBase(request, current.guard)).rejects.toBeInstanceOf(Error)
      vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before)
      const { guard } = context(), fresh = await reopen(current.factory)
      expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
      expect(await fresh.readFullSyncState(guard)).toEqual(current.state)
    })
  it.each([['count', 201, undefined], ['bytes', 200, '中'.repeat(400)]] as const)
    ('retains all %s-limited intent after real initial-link commit and lets only the actual packet builder reject it', async (limit, manualCount, note) => {
      const current = await fixture({ editName: false, manualCount, note }), request = await linkRequest(current.state), forbidden = vi.fn()
      vi.stubGlobal('fetch', forbidden)
      const state = await current.v6.linkFullSyncBase(request, current.guard), intent = planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio)
      expect(intent.issues).toEqual([]); expect(intent.operations).toHaveLength(manualCount)
      if (limit === 'bytes') expect(new TextEncoder().encode(JSON.stringify(intent.operations)).byteLength).toBeGreaterThan(OWNER_SYNC_MAX_BODY_BYTES)
      await expect(buildOwnerSyncRequest({ request_id: 'fulllink-real-builder-' + limit, expected_revision: state.fullSync.base!.pulledRevision,
        operations: intent.operations })).rejects.toMatchObject({ code: 'invalid_sync_request' })
      expect(state.local.portfolio!.manual).toHaveLength(manualCount + 2)
      expect(state.local.outbox.entry).toBeNull(); expect(state.fullSync.pending).toBeNull(); expect(forbidden).not.toHaveBeenCalled()
      expect((await (await reopen(current.factory)).readFullSyncState(current.guard)).local.portfolio).toEqual(state.local.portfolio)
    })
})
