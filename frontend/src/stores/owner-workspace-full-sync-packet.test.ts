/** Real public v6 packet/delivery/cancel and recovery codecs with fake-IDB.
 * Controlled raw mutations/crypto pauses inject faults only; no validator is
 * mocked. This is not a POST, cloud durability or actual Chrome/PWA proof. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspaceEditPortfolioRequest, buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  buildOwnerWorkspaceFullSyncUpgradeRequest, buildOwnerWorkspaceFullSyncLinkRequest,
  buildOwnerWorkspaceFullSyncPrepareRequest, buildOwnerWorkspaceFullSyncCancelRequest, buildOwnerWorkspacePrepareCloudRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceFullSyncState,
  type OwnerWorkspaceFullSyncPrepareRequest, type OwnerWorkspaceFullSyncCancelRequest, type OwnerWorkspaceFullSyncDeliveryRequest,
} from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { buildOwnerPortfolioRecoveryBackup, restoreOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { buildOwnerFullSyncRecoveryBackup, restoreOwnerFullSyncRecoveryBackup } from '@/utils/owner-full-sync-recovery'
import { parseOwnerBusinessJson } from '@/utils/owner-legacy-seed'
import { buildOwnerSyncRequest, restoreOwnerSyncRequest, OWNER_SYNC_MAX_BODY_BYTES, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'

const TARGET = '8'.repeat(64), KEY = '510300::完整原包合成账户', ASSET = 'asset:synthetic-cash'
const FULL = 'portfolio_sync_metadata', PORTFOLIO = 'portfolio_metadata', OLD = 'sync_metadata'
const handles: OwnerWorkspace[] = [], STATES = ['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const
type State = typeof STATES[number]
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
const hash = (value: unknown) => sha(canonicalOwnerLocal(value))
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
function tombstone(): OwnerSyncRecord {
  return { key: 'asset:old-cloud-tombstone', kind: 'manual_asset', deleted: true, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 }, values: { name: '旧云墓碑', cls: '现金', value: -0, note: null } }
}
async function fixture(options: { manualCount?: number; editName?: boolean; note?: string } = {}) {
  const factory = new IDBFactory(), { controller, guard } = context(), v3 = await openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'original opaque archive untouched',
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '合成零份', account: '完整原包合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-24T00:00:00Z' }]) }, backup3 = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'fullpacket-adopt-0001',
    expected: await v3.readLocalState(guard), sourceArchive, backupSha256: backup3.sha256 }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'fullpacket-old-link-0001',
    expected: await v4.readSyncState(guard), base: { pulledRevision: 1, records: [fund(), tombstone()] } }), guard)
  if (options.editName !== false) {
    const before = await v4.readLocalState(guard)
    await v4.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fullpacket-local-name-0001', expected: before,
      command: { type: 'save', expectedEntry: before.snapshot.entries[0], confirmed: true,
        input: { code: '510300', name: '本机名称', account: '完整原包合成账户', position_kind: 'holding', shares: -0, cost: null, target_weight: 0 } } }), guard)
  }
  const source = { manualRaw: ' \n' + canonicalOwnerLocal(Array.from({ length: options.manualCount ?? 1 }, (_, index) => ({
    id: index ? 'synthetic-cash-' + index : 'synthetic-cash', name: '合成现金 ' + index, cls: '现金', value: -0,
    ...(options.note === undefined ? {} : { note: options.note }), updated_at: '2026-10-24T00:00:00.12Z',
  }))) + '\r\n', snapshotsRaw: canonicalOwnerLocal([{ date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 }]) }
  const file5 = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), source)
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
    { id: 'fullpacket-portfolio-0001', backupRaw: file5.raw, backupSha256: file5.sha256 }), guard); handles.push(v5)
  const backup5 = await buildOwnerPortfolioRecoveryBackup(TARGET, await v5.readLocalState(guard))
  const v6 = await upgradeOwnerWorkspaceFullSync(factory, TARGET, await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET,
    { id: 'fullpacket-upgrade-0001', backupRaw: backup5.raw, backupSha256: backup5.sha256 }), guard); handles.push(v6)
  const before = await v6.readFullSyncState(guard), cloudFund = { ...fund(), record_revision: 2,
    field_revisions: { ...fund().field_revisions, shares: 2 }, values: { ...fund().values, shares: 12 } }
  const state = await v6.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(TARGET, { id: 'fullpacket-full-link-0001', expected: before,
    base: { pulledRevision: 2, records: [cloudFund, tombstone()] }, minimumObservedRevision: 2, resolutions: [] }), guard)
  return { factory, controller, guard, v6, state, source }
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
  try { return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const names = [...db.objectStoreNames], tx = db.transaction(names), result: Record<string, unknown[]> = {}
    for (const name of names) { const read = tx.objectStore(name).getAll(); read.onsuccess = () => { result[name] = read.result } }
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function mutate(factory: IDBFactory, writes: readonly { store: string; value: unknown; key?: string }[]) {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...new Set(writes.map(row => row.store))], 'readwrite')
    for (const row of writes) tx.objectStore(row.store).put(row.value, row.key ?? 'current')
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
function copy<T>(value: T): T { return parseOwnerBusinessJson(canonicalOwnerLocal(value), 24 * 1024 * 1024, 12) as T }
function at(input: unknown, path: string): Record<string, unknown> {
  let value = input as Record<string, unknown>
  for (const key of path.split('.').filter(Boolean)) value = value[key] as Record<string, unknown>
  return value
}
function replace(input: unknown, path: string, value: unknown): void {
  const parts = path.split('.'), key = parts.pop()!; at(input, parts.join('.'))[key] = value
}
const prepare = (expected: OwnerWorkspaceFullSyncState, id = 'fullpacket-prepare-0001') => buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id, expected })
const cancel = (expected: OwnerWorkspaceFullSyncState, id = 'fullpacket-cancel-0001') => buildOwnerWorkspaceFullSyncCancelRequest(TARGET, {
  id, expected, requestId: expected.fullSync.pending!.requestId, requestHash: expected.fullSync.pending!.requestHash,
})
function delivery(expected: OwnerWorkspaceFullSyncState, nextState: OwnerWorkspaceFullSyncDeliveryRequest['nextState']): OwnerWorkspaceFullSyncDeliveryRequest {
  const pending = expected.fullSync.pending!
  return { expected, requestId: pending.requestId, requestHash: pending.requestHash, preparationHash: pending.preparationHash, nextState }
}
async function prepared() {
  const current = await fixture(), request = await prepare(current.state), state = await current.v6.prepareFullSync(request, current.guard)
  return { ...current, linked: current.state, state, request }
}
async function toState(current: Awaited<ReturnType<typeof prepared>>, target: State) {
  let state = current.state
  if (target !== 'prepared') state = await current.v6.transitionFullSyncDelivery(delivery(state, 'attempted'), current.guard)
  if (target !== 'prepared' && target !== 'attempted') state = await current.v6.transitionFullSyncDelivery(delivery(state, target), current.guard)
  return state
}
async function editPortfolio(expected: OwnerWorkspaceFullSyncState, type: 'manual' | 'history') {
  return buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullpacket-race-' + type, expected: expected.local,
    command: type === 'manual'
      ? { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T01:00:00Z', values: { name: '合成现金 0', cls: '现金', value: 9, note: null } }
      : { type: 'append_observation', observation: { id: 'fullpacket-observation-0001', kind: 'observation',
        observed_at: '2026-10-24T16:01:00Z', date: '2026-10-25', calendar: 'Asia/Shanghai', value: 0, cost: null,
        holdings: [{ kind: 'manual', key: ASSET, name: '合成现金 0', cls: '现金', value: 0, cost: null }] } } })
}

describe('actual full-profile atomic original preparation', () => {
  it('stores exact fund+manual wire bytes and bindings in one strict slot/full-sync commit without touching local business/legacy images', async () => {
    const current = await fixture(), before = current.state, request = await prepare(before), physical = await image(current.factory)
    const forbidden = vi.fn(() => { throw new Error('ambient network/legacy IO forbidden') }); vi.stubGlobal('fetch', forbidden); vi.stubGlobal('localStorage', { getItem: forbidden })
    const actual = IDBDatabase.prototype.transaction, writes: string[] = []
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite') { expect(options?.durability).toBe('strict'); expect(tx.durability).toBe('strict') }
      return tx
    })
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) { writes.push(this.name); return put.call(this, value, key) })
    const state = await current.v6.prepareFullSync(request, current.guard), pending = state.fullSync.pending!, after = await image(current.factory)
    expect(writes).toEqual(['slot', FULL])
    expect(request.packet.request.operations.map(row => row.kind)).toEqual(['holding', 'manual_asset'])
    expect(request.hash).toBe(hash({ operation: 'portfolio-cloud-prepare-1', target: TARGET, id: request.id, expected: request.expected, packet: request.packet }))
    expect(state.local.outbox).toEqual({ version: before.local.outbox.version + 1, entry: { schema: 'owner-sync-outbox-1', state: 'prepared',
      rawBody: request.packet.rawBody, requestHash: request.packet.requestHash } })
    expect(state.fullSync.epoch).toBe(before.fullSync.epoch + 1); expect(state.fullSync.base).toEqual(before.fullSync.base)
    expect(state.fullSync.recentReceipt).toEqual(before.fullSync.recentReceipt)
    expect(pending).toEqual({ requestId: request.id, requestHash: request.packet.requestHash, rawBody: request.packet.rawBody,
      preparationHash: request.hash, preimageHash: hash({ target: TARGET, snapshot: before.local.snapshot, metadata: before.local.metadata,
        receiptCount: before.local.receiptCount, legacySync: before.local.sync, portfolio: before.local.portfolio,
        portfolioUpgrade: before.local.portfolioUpgrade, fullSyncUpgrade: before.local.fullSyncUpgrade, base: before.fullSync.base,
        epoch: state.fullSync.epoch, preparedOutboxVersion: state.local.outbox.version }),
      adoptionId: before.local.metadata.adoption!.id, adoptionHash: before.local.metadata.adoption!.hash,
      localVersion: before.local.snapshot.localVersion, preparedOutboxVersion: state.local.outbox.version, baseRevision: before.fullSync.base!.pulledRevision })
    for (const name of Object.keys(physical).filter(name => !['slot', FULL].includes(name))) expect(after[name]).toEqual(physical[name])
    expect(state.local.snapshot).toEqual(before.local.snapshot); expect(state.local.metadata).toEqual(before.local.metadata)
    expect(state.local.portfolio).toEqual(before.local.portfolio); expect(state.local.sync).toEqual(before.local.sync)
    expect(state.local.portfolioUpgrade).toEqual(before.local.portfolioUpgrade); expect(state.local.fullSyncUpgrade).toEqual(before.local.fullSyncUpgrade)
    expect(Object.is(state.local.portfolio!.manual[0].values.value, -0)).toBe(true)
    expect(Object.is(JSON.parse(pending.rawBody).operations[1].changes.value, 0)).toBe(true)
    expect(await restoreOwnerSyncRequest(pending.rawBody, pending.requestHash)).toEqual(request.packet)
    expect(await current.v6.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
    const fresh = await reopen(current.factory)
    expect(await fresh.readFullSyncState(current.guard)).toEqual(state)
    expect(await fresh.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('owns prepare inputs before asynchronous hashing and captures the original request before delivery awaits', async () => {
    const current = await fixture(), source = { id: 'fullpacket-owned-0001', expected: copy(current.state) }, old = copy(source), pending = buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, source)
    source.id = 'changed-builder-id-0001'; source.expected = { ...source.expected, local: { ...source.expected.local, receiptCount: 9 } }
    const request = await pending
    expect(request.id).toBe(old.id); expect(request.expected).toEqual(old.expected)
    const supplied = { ...copy(request) }, work = current.v6.prepareFullSync(supplied, current.guard)
    supplied.hash = '1'.repeat(64); supplied.id = 'changed-delivery-id-0001'
    const state = await work
    expect(state.fullSync.pending).toMatchObject({ requestId: old.id, preparationHash: request.hash, rawBody: request.packet.rawBody })
  })
  it.each(['noop', 'count', 'bytes', 'invalid-counter', 'sparse-array'] as const)('rejects %s before any packet/epoch/slot commit instead of trimming', async fault => {
    const current = await fixture(fault === 'noop' ? { manualCount: 0, editName: false }
      : fault === 'count' ? { manualCount: 201, editName: false } : fault === 'bytes' ? { manualCount: 200, editName: false, note: '中'.repeat(400) } : {}), before = await image(current.factory)
    let expected: unknown = current.state
    if (fault === 'invalid-counter') expected = { ...current.state, local: { ...current.state.local, snapshot: { ...current.state.local.snapshot, localVersion: -0 } } }
    if (fault === 'sparse-array') expected = { ...current.state, local: { ...current.state.local,
      portfolio: { ...current.state.local.portfolio!, history: new Array(1) } } }
    if (fault === 'count' || fault === 'bytes') {
      const intent = planOwnerPortfolioCloudIntent(current.state.fullSync.base, current.state.local.snapshot, current.state.local.portfolio)
      expect(intent.issues).toEqual([]); expect(intent.operations).toHaveLength(fault === 'count' ? 201 : 200)
      if (fault === 'bytes') expect(new TextEncoder().encode(JSON.stringify(intent.operations)).byteLength).toBeGreaterThan(OWNER_SYNC_MAX_BODY_BYTES)
      await expect(buildOwnerSyncRequest({ request_id: 'fullpacket-capacity-0001', expected_revision: 2, operations: intent.operations }))
        .rejects.toMatchObject({ code: 'invalid_sync_request' })
    }
    await expect(prepare(expected as OwnerWorkspaceFullSyncState)).rejects.toMatchObject({ code: fault === 'noop' ? 'workspace_noop'
      : ['count', 'bytes'].includes(fault) ? 'workspace_capacity' : 'workspace_invalid_input' })
    expect(await image(current.factory)).toEqual(before)
    expect((await current.v6.readFullSyncState(current.guard)).fullSync.pending).toBeNull()
  })
  it.each(['hash', 'extra', 'getter', 'packet-request', 'packet-raw', 'packet-hash', 'packet-length', 'expected-ref'] as const)
    ('rejects changed %s without a partial preparation', async fault => {
      const current = await fixture(), request = await prepare(current.state), before = await image(current.factory), getter = vi.fn()
      let supplied: unknown = { ...request }
      if (fault === 'hash') supplied = { ...request, hash: '1'.repeat(64) }
      if (fault === 'extra') supplied = { ...request, extra: true }
      if (fault === 'getter') supplied = Object.defineProperty({ ...request }, 'packet', { enumerable: true, get: getter })
      if (fault === 'packet-request') supplied = { ...request, packet: { ...request.packet, request: { ...request.packet.request, expected_revision: 1 } } }
      if (fault === 'packet-raw') supplied = { ...request, packet: { ...request.packet, rawBody: request.packet.rawBody + ' ' } }
      if (fault === 'packet-hash') supplied = { ...request, packet: { ...request.packet, requestHash: '2'.repeat(64) } }
      if (fault === 'packet-length') supplied = { ...request, packet: { ...request.packet, byteLength: request.packet.byteLength + 1 } }
      if (fault === 'expected-ref') supplied = { ...request, expected: { ...request.expected, fullSync: { ...request.expected.fullSync, epoch: 999 } } }
      await expect(current.v6.prepareFullSync(supplied as OwnerWorkspaceFullSyncPrepareRequest, current.guard)).rejects.toBeInstanceOf(Error)
      expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
    })
})

describe('actual original packet delivery state machine and prepared-only cancellation', () => {
  it.each(STATES.flatMap(from => STATES.map(to => [from, to] as const)))('allows only real original-packet transition %s → %s', async (from, to) => {
    const current = await prepared(), before = await toState(current, from), physical = await image(current.factory),
      allowed = ({ prepared: ['attempted'], attempted: ['unknown', 'confirmed', 'conflict'], unknown: ['confirmed', 'conflict'], confirmed: [], conflict: [] } as Record<State, readonly string[]>)[from].includes(to),
      input = { ...delivery(before, 'attempted'), nextState: to } as OwnerWorkspaceFullSyncDeliveryRequest
    if (!allowed) {
      await expect(current.v6.transitionFullSyncDelivery(input, current.guard)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(physical); return
    }
    const put = IDBObjectStore.prototype.put, writes: string[] = []
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) { writes.push(this.name); return put.call(this, value, key) })
    const state = await current.v6.transitionFullSyncDelivery(input, current.guard)
    expect(writes).toEqual(['slot'])
    expect(state.fullSync).toEqual(before.fullSync)
    expect(state.local).toEqual({ ...before.local, outbox: { version: before.local.outbox.version + 1,
      entry: { ...before.local.outbox.entry!, state: to } } })
    expect(await (await reopen(current.factory)).readFullSyncState(current.guard)).toEqual(state)
    expect(state.fullSync.pending!.rawBody).toBe(current.request.packet.rawBody)
    expect(state.fullSync.pending!.requestHash).toBe(current.request.packet.requestHash)
    expect(state.fullSync.pending!.preparationHash).toBe(current.request.hash)
    expect(await current.v6.fullSyncReceipt(current.request.id, current.request.hash, current.guard)).toEqual({ state: 'matched', value: state })
  })
  it('cancels only prepared original id/hash, advancing slot/full epoch while preserving all local data and original base', async () => {
    const current = await prepared(), request = await cancel(current.state), physical = await image(current.factory)
    const state = await current.v6.cancelPreparedFullSync(request, current.guard), after = await image(current.factory)
    expect(request.hash).toBe(hash({ operation: 'portfolio-cloud-cancel-1', target: TARGET, id: request.id, expected: request.expected,
      requestId: request.requestId, requestHash: request.requestHash }))
    expect(state.local.outbox).toEqual({ version: current.state.local.outbox.version + 1, entry: null })
    expect(state.fullSync).toEqual({ ...current.state.fullSync, epoch: current.state.fullSync.epoch + 1, pending: null,
      recentReceipt: { id: request.id, hash: request.hash, operation: 'cancel', syncEpoch: current.state.fullSync.epoch + 1,
        outboxVersion: state.local.outbox.version, localVersion: state.local.snapshot.localVersion } })
    for (const name of Object.keys(physical).filter(name => !['slot', FULL].includes(name))) expect(after[name]).toEqual(physical[name])
    expect(await current.v6.fullSyncReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
    expect(await current.v6.fullSyncReceipt(current.request.id, current.request.hash, current.guard)).toEqual({ state: 'unknown' })
    const next = await prepare(state, 'fullpacket-new-original-0001'), again = await current.v6.prepareFullSync(next, current.guard)
    expect(again.fullSync.pending!.requestId).toBe(next.id); expect(again.fullSync.pending!.rawBody).not.toBe(current.request.packet.rawBody)
    expect(again.fullSync.base).toEqual(current.linked.fullSync.base)
  })
  it.each(['attempted', 'unknown', 'confirmed', 'conflict'] as const)('cannot cancel/reprepare/local-edit/old-CAS a real %s slot', async target => {
    const current = await prepared(), originalCancel = await cancel(current.state), state = await toState(current, target), before = await image(current.factory)
    await expect(cancel(state)).rejects.toMatchObject({ code: 'workspace_pending' })
    await expect(prepare(state, 'fullpacket-no-replay-0001')).rejects.toMatchObject({ code: 'workspace_pending' })
    await expect(current.v6.prepareFullSync(current.request, current.guard)).rejects.toBeInstanceOf(Error)
    await expect(current.v6.cancelPreparedFullSync(originalCancel, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    await expect(editPortfolio(state, 'manual')).rejects.toBeInstanceOf(Error)
    await expect(current.v6.editPortfolio(await editPortfolio(current.linked, 'manual'), current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
    expect(await current.v6.fullSyncReceipt(current.request.id, current.request.hash, current.guard)).toEqual({ state: 'matched', value: state })
  })
  it.each(['requestId', 'requestHash', 'preparationHash', 'extra', 'getter'] as const)('rejects delivery %s substitution and retains the original complete packet', async fault => {
    const current = await prepared(), original = delivery(current.state, 'attempted'), before = await image(current.factory), getter = vi.fn()
    const supplied = fault === 'getter' ? Object.defineProperty({ ...original }, 'expected', { enumerable: true, get: getter })
      : fault === 'extra' ? { ...original, extra: true } : { ...original, [fault]: fault === 'requestId' ? 'another-original-0001' : 'f'.repeat(64) }
    await expect(current.v6.transitionFullSyncDelivery(supplied, current.guard)).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
  })
  it.each(['requestId', 'requestHash', 'hash', 'extra', 'getter'] as const)('rejects cancel %s substitution without clearing another original', async fault => {
    const current = await prepared(), original = await cancel(current.state), before = await image(current.factory), getter = vi.fn()
    const supplied = fault === 'getter' ? Object.defineProperty({ ...original }, 'expected', { enumerable: true, get: getter })
      : fault === 'extra' ? { ...original, extra: true } : { ...original, [fault]: fault === 'requestId' ? 'another-original-0001' : 'f'.repeat(64) }
    await expect(current.v6.cancelPreparedFullSync(supplied, current.guard)).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
  })
})

describe('actual pending re-open revalidates complete original preimage and bytes', () => {
  it.each(['manual', 'history', 'portfolio-intent', 'full-intent', 'legacy-B', 'active-stamp', 'preparation-hash', 'preimage-hash',
    'pending-raw', 'slot-raw', 'packet-hash', 'packet-resigned', 'negative-zero-wire', 'old-receipt'] as const)
    ('rejects %s tampering on a fresh real handle without repairing retained data', async fault => {
      const current = await prepared(), original = await image(current.factory), portfolioRow = copy(original[PORTFOLIO][0]),
        active = copy(original[FULL][0]), slot = copy(original.slot[0]), legacy = copy(original[OLD][0])
      const writes: { store: string; value: unknown; key?: string }[] = []
      if (fault === 'manual') { replace(portfolioRow, 'portfolio.manual.0.values.value', 9); writes.push({ store: PORTFOLIO, value: portfolioRow }) }
      if (fault === 'history') {
        const history = at(portfolioRow, 'portfolio').history as unknown[]
        history.push({ id: 'fullpacket-injected-observation', kind: 'observation', observed_at: '2026-10-24T16:01:00Z', date: '2026-10-25', calendar: 'Asia/Shanghai',
          value: 0, cost: null, holdings: [{ kind: 'manual', key: ASSET, name: '合成现金 0', cls: '现金', value: 0, cost: null }] })
        writes.push({ store: PORTFOLIO, value: portfolioRow })
      }
      if (fault === 'portfolio-intent' || fault === 'full-intent') {
        const store = fault === 'portfolio-intent' ? PORTFOLIO : FULL, old = copy(original[store][1]) as Record<string, unknown>, id = 'fullpacket-changed-' + fault
        writes.push({ store, key: 'intent', value: { ...old, id, hash: hash({ operation: fault === 'portfolio-intent' ? 'portfolio-upgrade-1'
          : 'portfolio-sync-upgrade-1', target: TARGET, id, backupSha256: old.backupSha256 }) } })
      }
      if (fault === 'legacy-B') { replace(legacy, 'base.records.0.values.name', 'changed-old-base-only'); writes.push({ store: OLD, value: legacy }) }
      if (fault === 'active-stamp') { replace(active, 'base.records.0.field_revisions.name', 2); writes.push({ store: FULL, value: active }) }
      if (fault === 'preparation-hash') { replace(active, 'pending.preparationHash', '1'.repeat(64)); writes.push({ store: FULL, value: active }) }
      if (fault === 'preimage-hash') { replace(active, 'pending.preimageHash', '2'.repeat(64)); writes.push({ store: FULL, value: active }) }
      if (fault === 'pending-raw') { replace(active, 'pending.rawBody', current.request.packet.rawBody + ' '); writes.push({ store: FULL, value: active }) }
      if (fault === 'slot-raw') { replace(slot, 'entry.rawBody', current.request.packet.rawBody + ' '); writes.push({ store: 'slot', value: slot }) }
      if (fault === 'packet-hash') { replace(active, 'pending.requestHash', '3'.repeat(64)); replace(slot, 'entry.requestHash', '3'.repeat(64));
        writes.push({ store: FULL, value: active }, { store: 'slot', value: slot }) }
      if (fault === 'packet-resigned' || fault === 'negative-zero-wire') {
        let raw: string
        if (fault === 'packet-resigned') {
          const request = copy(current.request.packet.request), operations = request.operations.map(row => row.kind === 'manual_asset'
            ? { ...row, changes: { ...row.changes, value: 9 } } : row)
          raw = (await buildOwnerSyncRequest({ ...request, operations })).rawBody
        } else raw = current.request.packet.rawBody.replace('"value":0', '"value":-0')
        expect(raw).not.toBe(current.request.packet.rawBody)
        replace(active, 'pending.rawBody', raw); replace(active, 'pending.requestHash', sha(raw)); replace(slot, 'entry.rawBody', raw); replace(slot, 'entry.requestHash', sha(raw))
        writes.push({ store: FULL, value: active }, { store: 'slot', value: slot })
      }
      if (fault === 'old-receipt') { replace(active, 'recentReceipt.hash', '4'.repeat(64)); writes.push({ store: FULL, value: active }) }
      await mutate(current.factory, writes)
      const corrupted = await image(current.factory)
      await expect((async () => (await reopen(current.factory)).readFullSyncState(current.guard))()).rejects.toMatchObject({ code: 'workspace_invalid_database' })
      expect(await image(current.factory)).toEqual(corrupted)
    })
  it.each(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const)('roundtrips the original %s packet in recovery3 without translating it to a new request or recovery2', async target => {
    const current = await prepared(), state = await toState(current, target), before = await image(current.factory), file = await buildOwnerFullSyncRecoveryBackup(TARGET, state.local),
      restored = await restoreOwnerFullSyncRecoveryBackup(file.raw, file.sha256)
    expect(restored.local).toEqual(state.local)
    expect(restored.local.fullSync!.pending).toEqual(state.fullSync.pending)
    expect(restored.local.outbox.entry).toEqual(state.local.outbox.entry)
    expect(restored.local.portfolio).toEqual(state.local.portfolio)
    expect(restored.local.sync).toEqual(state.local.sync); expect(restored.local.portfolioUpgrade).toEqual(state.local.portfolioUpgrade)
    expect(restored.local.fullSyncUpgrade).toEqual(state.local.fullSyncUpgrade)
    await expect(buildOwnerPortfolioRecoveryBackup(TARGET, state.local)).rejects.toBeInstanceOf(Error)
    await expect(restoreOwnerPortfolioRecoveryBackup(file.raw, file.sha256)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it('rejects a rehashed recovery3 whose history or original packet association was altered despite a correct outer file SHA', async () => {
    const current = await prepared(), file = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state.local)
    for (const path of ['local.fullSync.pending.preparationHash', 'local.portfolio.manual.0.values.value', 'local.sync.base.records.0.field_revisions.name']) {
      const envelope = copy(file.envelope); replace(envelope, path, path.endsWith('preparationHash') ? '1'.repeat(64) : path.endsWith('value') ? 9 : 2)
      const raw = canonicalOwnerLocal(envelope)
      await expect(restoreOwnerFullSyncRecoveryBackup(raw, sha(raw))).rejects.toBeInstanceOf(Error)
    }
  })
})

describe('actual complete-image CAS, uncertainty, strict abort and legacy refusal', () => {
  it('serializes two original preparations from one complete image so exactly one id/raw binding can win', async () => {
    const current = await fixture(), other = await reopen(current.factory), one = await prepare(current.state), two = await prepare(current.state, 'fullpacket-other-prepare-0001')
    const outcomes = await Promise.allSettled([current.v6.prepareFullSync(one, current.guard), other.prepareFullSync(two, current.guard)])
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
    const state = await (await reopen(current.factory)).readFullSyncState(current.guard), winner = outcomes[0].status === 'fulfilled' ? one : two
    expect(state.fullSync.pending).toMatchObject({ requestId: winner.id, requestHash: winner.packet.requestHash, preparationHash: winner.hash, rawBody: winner.packet.rawBody })
    expect(state.fullSync.epoch).toBe(current.state.fullSync.epoch + 1); expect(state.local.outbox.version).toBe(current.state.local.outbox.version + 1)
  })
  it.each(['manual', 'history'] as const)('rejects stale preparation after a real %s writer and retains the exact newer image', async type => {
    const current = await fixture(), other = await reopen(current.factory), request = await prepare(current.state)
    await other.editPortfolio(await editPortfolio(current.state, type), current.guard)
    const before = await image(current.factory)
    await expect(current.v6.prepareFullSync(request, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
  })
  it('rejects stale cancellation after another handle attempted the original packet, and never returns it to prepared', async () => {
    const current = await prepared(), other = await reopen(current.factory), cancelRequest = await cancel(current.state), attempted = await other.transitionFullSyncDelivery(delivery(current.state, 'attempted'), current.guard), before = await image(current.factory)
    await expect(current.v6.cancelPreparedFullSync(cancelRequest, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    await expect(current.v6.transitionFullSyncDelivery(delivery(current.state, 'attempted'), current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
    expect((await other.readFullSyncState(current.guard)).local.outbox.entry!.state).toBe(attempted.local.outbox.entry!.state)
  })
  it.each(['prepare', 'cancel'] as const)('keeps an actual committed %s after lost authority and only manually checks original local id/hash', async operation => {
    const current = operation === 'prepare' ? await fixture() : await prepared(), request = operation === 'prepare' ? await prepare(current.state) : await cancel(current.state),
      actual = IDBDatabase.prototype.transaction, completed = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite' && Array.isArray(names) && names.includes(FULL)) tx.addEventListener('complete', () => { completed(); current.controller.abort() }, { once: true })
      return tx
    })
    const work = operation === 'prepare' ? current.v6.prepareFullSync(request as OwnerWorkspaceFullSyncPrepareRequest, current.guard)
      : current.v6.cancelPreparedFullSync(request as OwnerWorkspaceFullSyncCancelRequest, current.guard)
    await expect(work).rejects.toBeInstanceOf(Error); expect(completed).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    const { guard } = context(), fresh = await reopen(current.factory), state = await fresh.readFullSyncState(guard), before = await image(current.factory)
    expect(await fresh.fullSyncReceipt(request.id, request.hash, guard)).toEqual({ state: 'matched', value: state })
    expect(await fresh.fullSyncReceipt('fullpacket-unknown-original-0001', request.hash, guard)).toEqual({ state: 'unknown' })
    await expect(fresh.fullSyncReceipt(request.id, 'f'.repeat(64), guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await image(current.factory)).toEqual(before)
    if (operation === 'prepare') expect(state.fullSync.pending!.preparationHash).toBe(request.hash)
    else expect(state.fullSync.pending).toBeNull()
  })
  it.each((['prepare', 'cancel', 'delivery'] as const).flatMap(operation => (['quota', 'after-put-abort', 'revoked-after-put', 'closed-after-put', 'relaxed'] as const).map(fault => ({ operation, fault }))))
    ('rolls back the complete image for $operation / $fault', async ({ operation, fault }) => {
      const current = operation === 'prepare' ? await fixture() : await prepared(), request = operation === 'prepare' ? await prepare(current.state)
        : operation === 'cancel' ? await cancel(current.state) : delivery(current.state, 'attempted'), before = await image(current.factory),
        put = IDBObjectStore.prototype.put, transact = IDBDatabase.prototype.transaction
      if (fault === 'relaxed') vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
        const tx = transact.call(this, names, mode, options)
        if (mode === 'readwrite') Object.defineProperty(tx, 'durability', { configurable: true, value: 'relaxed' })
        return tx
      })
      else vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        const target = this.name === (operation === 'delivery' ? 'slot' : FULL) && key === 'current'
        if (target && fault === 'quota') throw new DOMException('Synthetic quota', 'QuotaExceededError')
        const pending = put.call(this, value, key)
        if (target && fault === 'after-put-abort') pending.addEventListener('success', () => this.transaction.abort())
        if (target && fault === 'revoked-after-put') current.controller.abort()
        if (target && fault === 'closed-after-put') current.v6.close()
        return pending
      })
      const work = operation === 'prepare' ? current.v6.prepareFullSync(request as OwnerWorkspaceFullSyncPrepareRequest, current.guard)
        : operation === 'cancel' ? current.v6.cancelPreparedFullSync(request as OwnerWorkspaceFullSyncCancelRequest, current.guard)
          : current.v6.transitionFullSyncDelivery(request as OwnerWorkspaceFullSyncDeliveryRequest, current.guard)
      await expect(work).rejects.toBeInstanceOf(Error); vi.restoreAllMocks()
      expect(await image(current.factory)).toEqual(before)
      const { guard } = context()
      expect(await (await reopen(current.factory)).readFullSyncState(guard)).toEqual(current.state)
    })
  it('keeps v4 fund-only planners/writers disabled on v6 even when an original full packet is prepared', async () => {
    const current = await prepared(), before = await image(current.factory), legacy = { local: current.state.local, sync: current.state.local.sync! }
    await expect(current.v6.readSyncState(current.guard)).rejects.toBeInstanceOf(Error)
    await expect(buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'fullpacket-legacy-bypass-0001', expected: legacy })).rejects.toBeInstanceOf(Error)
    await expect(current.v6.prepareCloud({ id: current.request.id, hash: current.request.hash, expected: legacy, packet: current.request.packet }, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
})
