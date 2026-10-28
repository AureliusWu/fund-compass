/** Real v6 workspace/packet/delivery/ACK with synthetic raw HTTP responses.
 * Ports always delegate to the actual core; wrappers only count, delay or
 * inject labelled failures. No validators or business images are stubbed.
 * This is not real HTTP authentication, Chrome/PWA or cloud durability proof. */
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspaceEditPortfolioRequest, buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  buildOwnerWorkspaceFullSyncUpgradeRequest, buildOwnerWorkspaceFullSyncLinkRequest, buildOwnerWorkspaceFullSyncPrepareRequest,
  buildOwnerWorkspaceFullSyncCancelRequest, OwnerWorkspaceError,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceFullSyncState,
} from './owner-workspace'
import { createOwnerPortfolioWorkspaceSync } from './ownerPortfolioWorkspaceSync'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { buildOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'
import type { BuiltOwnerSyncRequest, OwnerSyncRecord } from '@/utils/ownerSyncContract'
import type { OwnerSyncCandidateTransport } from './ownerSyncCandidate'

const TARGET = 'b'.repeat(64), KEY = '510300::完整协调合成账户', ASSET = 'asset:synthetic-cash', PRIVATE = 'synthetic-private-never-echo'
const handles: OwnerWorkspace[] = [], ambient = vi.fn(() => { throw new Error('ambient IO forbidden') })
type Port = Parameters<typeof createOwnerPortfolioWorkspaceSync>[0]['workspace']
type Http = { status: number; rawBody: string }
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); ambient.mockClear(); vi.stubGlobal('fetch', ambient); vi.stubGlobal('indexedDB', { open: ambient })
  vi.stubGlobal('localStorage', { getItem: ambient, setItem: ambient, removeItem: ambient })
})
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
function fund(revision = 1, shares: number | null = -0): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: revision, cost: 1, target_weight: 1 },
    values: { name: PRIVATE, shares, cost: null, target_weight: null } }
}
function manual(revision = 2, value = 0): OwnerSyncRecord {
  return { key: ASSET, kind: 'manual_asset', deleted: false, record_revision: revision, lifecycle_revision: 2,
    field_revisions: { name: 2, cls: 2, value: revision, note: 2 }, values: { name: '合成现金', cls: '现金', value, note: null } }
}
function page(records: readonly OwnerSyncRecord[], head = Math.max(0, ...records.map(row => row.record_revision)), cursor: readonly [number, string] | null = null): Http {
  const sorted = [...records].sort((a, b) => a.record_revision - b.record_revision || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { status: 200, rawBody: JSON.stringify({ upper_revision: head, changes: sorted, next_cursor: cursor, complete: cursor === null }) }
}
function success(): Http { return { status: 200, rawBody: JSON.stringify({ revision: 3, records: [fund(3, 7), manual(3, 8)] }) } }
function receipt(response = success()): Http { return { status: 200,
  rawBody: JSON.stringify({ state: 'matched', status: response.status, result: JSON.parse(response.rawBody) }) } }
function conflict(): Http { return { status: 409, rawBody: JSON.stringify({ error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
  conflicts: [{ key_digest: sha(KEY).slice(0, 16), fields: ['shares'] }, { key_digest: sha(ASSET).slice(0, 16), fields: ['value'] }] }) } }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function copy<T>(value: T): T { return structuredClone(value) }
async function fixture(mode: 'linked' | 'prepared' = 'linked') {
  const factory = new IDBFactory(), authority = new AbortController(), live = { active: true, endpoint: '/original-api' },
    guard: OwnerWorkspaceGuard = { signal: authority.signal, assertActive() {
      if (authority.signal.aborted || !live.active || live.endpoint !== '/original-api') throw new Error('actual captured authority changed')
    } }, v3 = await openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'opaque original', v2Raw: canonicalOwnerLocal([
    { code: '510300', name: PRIVATE, account: '完整协调合成账户', position_kind: 'holding', shares: -0, cost: null, target_weight: null, updated_at: '2026-10-24T00:00:00Z' },
  ]) }, oldBackup = await buildOwnerLegacyWorkspaceBackup(sourceArchive), adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET,
    { id: 'fullmanaged-adopt-0001', expected: await v3.readLocalState(guard), sourceArchive, backupSha256: oldBackup.sha256 }), guard),
    v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'fullmanaged-old-link-0001', expected: await v4.readSyncState(guard),
    base: { pulledRevision: 1, records: [fund()] } }), guard)
  const source = { manualRaw: ' \n' + canonicalOwnerLocal([{ id: 'synthetic-cash', name: '合成现金', cls: '现金', value: -0, updated_at: '2026-10-24T00:00:00.12Z' }]) + '\r\n',
    snapshotsRaw: canonicalOwnerLocal([{ date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 }]) },
    file5 = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), source),
    v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
      { id: 'fullmanaged-portfolio-0001', backupRaw: file5.raw, backupSha256: file5.sha256 }), guard); handles.push(v5)
  const backup5 = await buildOwnerPortfolioRecoveryBackup(TARGET, await v5.readLocalState(guard)),
    workspace = await upgradeOwnerWorkspaceFullSync(factory, TARGET, await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET,
      { id: 'fullmanaged-upgrade-0001', backupRaw: backup5.raw, backupSha256: backup5.sha256 }), guard); handles.push(workspace)
  let state = await workspace.readFullSyncState(guard)
  state = await workspace.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(TARGET, { id: 'fullmanaged-full-link-0001', expected: state,
    base: { pulledRevision: 2, records: [fund(), manual()] }, minimumObservedRevision: 2, resolutions: [] }), guard)
  await workspace.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fullmanaged-fund-edit-0001', expected: state.local,
    command: { type: 'save', expectedEntry: state.local.snapshot.entries[0], confirmed: true,
      input: { code: '510300', name: PRIVATE, account: '完整协调合成账户', position_kind: 'holding', shares: 7, cost: null, target_weight: null } } }), guard)
  await workspace.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullmanaged-manual-edit-0001', expected: await workspace.readLocalState(guard),
    command: { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T00:00:00Z', values: { name: '合成现金', cls: '现金', value: 8, note: null } } }), guard)
  if (mode === 'prepared') await workspace.prepareFullSync(await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET,
    { id: 'fullmanaged-stored-prepare', expected: await workspace.readFullSyncState(guard) }), guard)
  const events: string[] = []
  const port = {
    targetFingerprint: TARGET,
    readFullSyncState: vi.fn((value: OwnerWorkspaceGuard) => workspace.readFullSyncState(value)),
    prepareFullSync: vi.fn(async (request: Parameters<OwnerWorkspace['prepareFullSync']>[0], value: OwnerWorkspaceGuard) => {
      const result = await workspace.prepareFullSync(request, value); events.push('prepared'); return result
    }),
    cancelPreparedFullSync: vi.fn(async (request: Parameters<OwnerWorkspace['cancelPreparedFullSync']>[0], value: OwnerWorkspaceGuard) => {
      const result = await workspace.cancelPreparedFullSync(request, value); events.push('cancelled'); return result
    }),
    transitionFullSyncDelivery: vi.fn(async (request: Parameters<OwnerWorkspace['transitionFullSyncDelivery']>[0], value: OwnerWorkspaceGuard) => {
      const result = await workspace.transitionFullSyncDelivery(request, value); events.push(request.nextState); return result
    }),
    ackFullSync: vi.fn(async (request: Parameters<OwnerWorkspace['ackFullSync']>[0], value: OwnerWorkspaceGuard) => {
      const result = await workspace.ackFullSync(request, value); events.push('ack'); return result
    }),
    refreshFullSync: vi.fn(async (request: Parameters<OwnerWorkspace['refreshFullSync']>[0], value: OwnerWorkspaceGuard) => {
      const result = await workspace.refreshFullSync(request, value); events.push('refresh'); return result
    }),
    fullSyncReceipt: vi.fn((id: string, hash: string, value: OwnerWorkspaceGuard) => workspace.fullSyncReceipt(id, hash, value)),
  } satisfies Port
  let server = [fund(), manual()], session = { authenticated: true, generation: 1 }
  const transport = {
    targetFingerprint: TARGET,
    write: vi.fn(async (_packet: BuiltOwnerSyncRequest, _signal: AbortSignal): Promise<Http> => {
      expect((await workspace.readFullSyncState(guard)).local.outbox.entry!.state).toBe('attempted')
      events.push('POST'); server = [fund(3, 7), manual(3, 8)]; return success()
    }),
    receipt: vi.fn(async (_id: string, _hash: string, _signal: AbortSignal): Promise<Http> => {
      server = [fund(3, 7), manual(3, 8)]; return receipt()
    }),
    changes: vi.fn(async (_parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0], _signal: AbortSignal) => page(server)),
  }
  const readSession = vi.fn(() => session), createGuard = vi.fn((_signal: AbortSignal) => guard)
  const create = () => createOwnerPortfolioWorkspaceSync({ workspace: port, transport, session: readSession, guard: createGuard }), managed = create()
  return { factory, workspace, port, transport, authority, live, guard, events, source, readSession, createGuard, managed, create,
    image: () => workspace.readFullSyncState(guard), setSession: (next: typeof session) => { session = next }, setServer: (records: OwnerSyncRecord[]) => { server = records } }
}
async function prepared() {
  const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
  const request = await f.managed.previewPreparation('fullmanaged-prepare-0001')
  await f.managed.commitPreparation(request, true); return { ...f, request }
}
async function confirmed() { const f = await prepared(); await f.managed.sendOnce(); return f }
async function other(f: Awaited<ReturnType<typeof fixture>>) {
  const handle = await openOwnerWorkspace(f.factory, TARGET, { existingOnly: true }); handles.push(handle); return handle
}
async function tick() { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) }
async function metadataFault(factory: IDBFactory) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  try { await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('local_metadata', 'readwrite'), store = tx.objectStore('local_metadata'), read = store.get('current')
    read.onsuccess = () => { const value = read.result; store.put({ ...value,
      displayTimes: value.displayTimes.map((row: { key: string; updated_at: string | null }) => ({ ...row, updated_at: null })) }, 'current') }
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { database.close() }
}

describe('real complete-profile coordinator default-off and one-original-body journey', () => {
  it('constructs with no IO/default consent and exposes no initial-link or legacy clear/resend surface', async () => {
    const f = await fixture()
    expect(f.port.readFullSyncState).not.toHaveBeenCalled(); expect(f.createGuard).not.toHaveBeenCalled(); expect(f.readSession).not.toHaveBeenCalled()
    expect(f.transport.write).not.toHaveBeenCalled(); expect(f.transport.changes).not.toHaveBeenCalled(); expect(f.transport.receipt).not.toHaveBeenCalled(); expect(ambient).not.toHaveBeenCalled()
    expect(f.managed.status().state).toBe('disabled')
    for (const key of ['prepare', 'previewLink', 'commitLink', 'clearResolvedOrUnsent', 'resendUnknown']) expect(f.managed).not.toHaveProperty(key)
    await expect(f.managed.hydrate()).rejects.toMatchObject({ code: 'managed_disabled' })
    expect(f.port.readFullSyncState).not.toHaveBeenCalled()
  })
  it('requires exact target, authenticated generation and explicit per-session consent without closing the shared workspace', async () => {
    const f = await fixture()
    expect(() => createOwnerPortfolioWorkspaceSync({ workspace: f.port, transport: { ...f.transport, targetFingerprint: 'e'.repeat(64) }, session: f.readSession, guard: f.createGuard }))
      .toThrowError(expect.objectContaining({ code: 'managed_invalid_options' }))
    f.managed.setCloudConsent(true); f.setSession({ authenticated: false, generation: 1 })
    await expect(f.managed.hydrate()).rejects.toMatchObject({ code: 'managed_signed_out' })
    f.setSession({ authenticated: true, generation: 2 }); await f.managed.hydrate(); expect(f.managed.status().state).toBe('idle')
    f.managed.close(); await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_closed' })
    expect((await f.image()).fullSync.base!.pulledRevision).toBe(2)
  })
  it('prepares all real fund/manual B→L intent, sends exactly once after strict attempted, pulls complete D and commits actual ACK', async () => {
    const f = await prepared(), before = await f.image()
    expect(f.request.packet.request.expected_revision).toBe(2)
    expect(f.request.packet.request.operations).toEqual([
      { key: KEY, kind: 'holding', deleted: false, changes: { shares: 7 }, base_values: { kind: 'holding', deleted: false, shares: 0 } },
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: 0 } },
    ])
    await f.managed.sendOnce()
    expect(f.events).toEqual(['prepared', 'attempted', 'POST', 'confirmed'])
    expect(f.transport.write).toHaveBeenCalledOnce(); expect(f.transport.write.mock.calls[0][0]).toEqual(f.request.packet)
    expect((await f.image()).fullSync.pending).toEqual(before.fullSync.pending)
    await f.managed.pullComplete()
    const planned = await f.managed.previewAcknowledgement('fullmanaged-ack-0001')
    expect(planned.request).not.toBeNull(); expect(planned.preview.nextPortfolio!.manual[0].values.value).toBe(8)
    const transitions = f.port.transitionFullSyncDelivery.mock.calls.length, state = await f.managed.commitAcknowledgement(planned.request!, true)
    expect(f.events).toEqual(['prepared', 'attempted', 'POST', 'confirmed', 'ack'])
    expect(f.port.transitionFullSyncDelivery).toHaveBeenCalledTimes(transitions)
    expect(state.local.outbox.entry).toBeNull(); expect(state.fullSync.pending).toBeNull(); expect(state.fullSync.base).toEqual(planned.preview.baseD)
    expect(state.local.snapshot.localVersion).toBe(before.local.snapshot.localVersion + 1)
    expect(state.local.portfolio!.history).toEqual(before.local.portfolio!.history)
    expect(state.local.portfolio!.migration).toEqual(before.local.portfolio!.migration)
    expect(state.local.sync).toEqual(before.local.sync); expect(state.local.portfolioUpgrade).toEqual(before.local.portfolioUpgrade)
    expect(state.local.fullSyncUpgrade).toEqual(before.local.fullSyncUpgrade)
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio)).toEqual({ operations: [], issues: [] })
    expect(f.managed.status()).toMatchObject({ state: 'idle', completeReady: false, resultReady: false, uncertainLocal: null })
    await expect(f.managed.commitAcknowledgement(planned.request!, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.ackFullSync).toHaveBeenCalledOnce(); expect(f.transport.write).toHaveBeenCalledOnce(); expect(ambient).not.toHaveBeenCalled()
  })
  it('derives preparation from applied full B rather than a newly observed cloud D', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    f.transport.changes.mockResolvedValueOnce(page([fund(4, 99), manual(4, 30)])); await f.managed.pullComplete()
    const request = await f.managed.previewPreparation('fullmanaged-from-applied-B')
    expect(request.packet.request.expected_revision).toBe(2)
    expect(request.packet.request.operations[1].base_values).toEqual({ kind: 'manual_asset', deleted: false, value: 0 })
    expect(request.packet.request.operations[1].changes).toEqual({ value: 8 })
    expect(f.transport.write).not.toHaveBeenCalled()
  })
  it('requires explicit preparation confirmation and exact current preview, without mutation after failed confirmation', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('fullmanaged-confirm-prepare')
    await expect(f.managed.commitPreparation(request, false as true)).rejects.toMatchObject({ code: 'managed_confirmation_required' })
    expect(f.port.prepareFullSync).not.toHaveBeenCalled()
    await f.managed.hydrate(); await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.prepareFullSync).not.toHaveBeenCalled()
  })
  it('manually exports only original packet bytes/hash/preparation binding and cancels only actual prepared state', async () => {
    const f = await prepared(), before = await f.image(), exported = await f.managed.exportPending()
    expect(exported).toEqual({ requestId: f.request.id, requestHash: f.request.packet.requestHash, rawBody: f.request.packet.rawBody,
      preparationHash: f.request.hash, state: 'prepared' })
    await expect(f.managed.cancelPrepared('fullmanaged-cancel-0001', false as true)).rejects.toMatchObject({ code: 'managed_confirmation_required' })
    await f.managed.hydrate(); const state = await f.managed.cancelPrepared('fullmanaged-cancel-0001', true)
    expect(state.fullSync.base).toEqual(before.fullSync.base); expect(state.local.snapshot).toEqual(before.local.snapshot)
    expect(state.local.portfolio).toEqual(before.local.portfolio); expect(state.fullSync.pending).toBeNull(); expect(state.local.outbox.entry).toBeNull()
    expect(f.transport.write).not.toHaveBeenCalled(); expect(f.port.cancelPreparedFullSync).toHaveBeenCalledOnce()
  })
})

function disjointRefreshRecords(): OwnerSyncRecord[] {
  const holding = fund(), asset = manual()
  return [{ ...holding, record_revision: 3, field_revisions: { ...holding.field_revisions, name: 3 },
    values: { ...holding.values, name: '合成云端名称' } },
  { ...asset, record_revision: 4, field_revisions: { ...asset.field_revisions, note: 4 },
    values: { ...asset.values, note: '合成云端备注' } }]
}
async function refreshReady() {
  const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
  f.setServer(disjointRefreshRecords()); await f.managed.pullComplete(); return f
}

describe('actual complete B/L/D cloud refresh without packet or POST', () => {
  it('adopts disjoint cloud changes while retaining all fund/manual unuploaded intent and immutable local history', async () => {
    const f = await refreshReady(), before = await f.image(), plan = await f.managed.previewRefresh('fullmanaged-refresh-0001')
    expect(plan.request).not.toBeNull(); expect(plan.preview.conflicts).toEqual([])
    expect(plan.preview.remainingOperations).toHaveLength(2)
    const state = await f.managed.commitRefresh(plan.request!, true)
    expect(state.local.snapshot.entries[0].values).toMatchObject({ name: '合成云端名称', shares: 7, cost: null })
    expect(state.local.portfolio!.manual[0].values).toMatchObject({ value: 8, note: '合成云端备注' })
    expect(state.fullSync.base).toEqual(plan.preview.baseD)
    expect(state.fullSync.recentReceipt).toMatchObject({ id: plan.request!.id, hash: plan.request!.hash, operation: 'refresh' })
    expect(state.fullSync.pending).toBeNull(); expect(state.local.outbox.entry).toBeNull()
    expect(state.local.snapshot.localVersion).toBe(before.local.snapshot.localVersion + 1)
    expect(state.local.outbox.version).toBe(before.local.outbox.version + 1)
    expect(state.fullSync.epoch).toBe(before.fullSync.epoch + 1)
    expect(state.local.portfolio!.history).toEqual(before.local.portfolio!.history)
    expect(state.local.portfolio!.migration).toEqual(before.local.portfolio!.migration)
    expect(state.local.portfolioUpgrade).toEqual(before.local.portfolioUpgrade)
    expect(state.local.fullSyncUpgrade).toEqual(before.local.fullSyncUpgrade); expect(state.local.sync).toEqual(before.local.sync)
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio).operations).toEqual(plan.preview.remainingOperations)
    expect(f.events).toEqual(['refresh']); expect(f.transport.write).not.toHaveBeenCalled(); expect(f.transport.receipt).not.toHaveBeenCalled()
    expect(f.managed.status()).toMatchObject({ state: 'idle', completeReady: false, resultReady: false, uncertainLocal: null })
    const preparation = await f.managed.previewPreparation('fullmanaged-after-refresh-prepare')
    expect(preparation.packet.request.expected_revision).toBe(4)
    expect(preparation.packet.request.operations).toEqual(plan.preview.remainingOperations)
    await f.managed.commitPreparation(preparation, true)
    expect((await f.image()).fullSync.pending!.requestId).toBe(preparation.id)
    await f.managed.cancelPrepared('fullmanaged-after-refresh-cancel', true)
    expect(f.transport.write).not.toHaveBeenCalled(); expect(ambient).not.toHaveBeenCalled()
  })
  it('requires the actual fresh complete pull and separately confirmed private preview', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    await expect(f.managed.previewRefresh('fullmanaged-no-pull')).rejects.toMatchObject({ code: 'managed_pull_required' })
    await f.managed.hydrate(); f.setServer(disjointRefreshRecords()); await f.managed.pullComplete()
    const plan = await f.managed.previewRefresh('fullmanaged-refresh-confirm'), before = await f.image()
    await expect(f.managed.commitRefresh(plan.request!, false as true)).rejects.toMatchObject({ code: 'managed_confirmation_required' })
    expect(f.port.refreshFullSync).not.toHaveBeenCalled(); expect(await f.image()).toEqual(before)
    await f.managed.hydrate()
    await expect(f.managed.commitRefresh(plan.request!, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.refreshFullSync).not.toHaveBeenCalled(); expect(f.transport.write).not.toHaveBeenCalled()
  })
  it('exposes a genuine typed no-op without advancing local versions or inventing a receipt even with remaining intent', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    f.transport.changes.mockResolvedValueOnce({ status: 200, rawBody: canonicalOwnerLocal({ upper_revision: 2,
      changes: [fund(), manual()], next_cursor: null, complete: true }) })
    await f.managed.pullComplete(); const before = await f.image(), plan = await f.managed.previewRefresh('fullmanaged-refresh-noop')
    expect(plan.preview.noop).toBe(true); expect(plan.request).toBeNull(); expect(plan.preview.remainingOperations).toHaveLength(2)
    expect(await f.image()).toEqual(before); expect(f.port.refreshFullSync).not.toHaveBeenCalled(); expect(f.transport.write).not.toHaveBeenCalled()
  })
  it('uses actual full field conflicts and invalidates the previous sealed request after changed choices', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    f.setServer([fund(3, 12), manual(4, 20)]); await f.managed.pullComplete()
    const unresolved = await f.managed.previewRefresh('fullmanaged-refresh-conflict')
    expect(unresolved.request).toBeNull()
    expect(unresolved.preview.conflicts).toMatchObject([{ key: KEY, field: 'shares' }, { key: ASSET, field: 'value' }])
    const first = await f.managed.previewRefresh('fullmanaged-refresh-conflict', [
      { key: KEY, field: 'shares', choice: 'cloud' }, { key: ASSET, field: 'value', choice: 'local' }])
    const second = await f.managed.previewRefresh('fullmanaged-refresh-conflict', [
      { key: KEY, field: 'shares', choice: 'local' }, { key: ASSET, field: 'value', choice: 'cloud' }])
    expect(first.request!.hash).not.toBe(second.request!.hash)
    await expect(f.managed.commitRefresh(first.request!, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.refreshFullSync).not.toHaveBeenCalled()
    // Failed old preview invalidates all private read evidence; pull and select again.
    await f.managed.hydrate(); await f.managed.pullComplete()
    const selected = await f.managed.previewRefresh('fullmanaged-refresh-conflict', second.request!.resolutions)
    const state = await f.managed.commitRefresh(selected.request!, true)
    expect(state.local.snapshot.entries[0].values.shares).toBe(7)
    expect(state.local.portfolio!.manual[0].values.value).toBe(20)
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio).operations).toHaveLength(1)
    expect(f.transport.write).not.toHaveBeenCalled()
  })
  it('owns refresh resolutions and the whole sealed request before the first asynchronous boundary', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    f.setServer([fund(3, 12), manual(4, 20)]); await f.managed.pullComplete()
    const choices = [{ key: KEY, field: 'shares' as const, choice: 'cloud' as 'local' | 'cloud' },
      { key: ASSET, field: 'value' as const, choice: 'local' as 'local' | 'cloud' }], work = f.managed.previewRefresh('fullmanaged-owned-refresh', choices)
    choices[0].choice = 'local'; choices[1].choice = 'cloud'
    const plan = await work, supplied = copy(plan.request!), commit = f.managed.commitRefresh(supplied, true)
    Object.assign(supplied, { id: 'tampered-after-invocation', hash: 'e'.repeat(64) })
    Object.assign(supplied.resolutions[0], { choice: 'local' })
    const state = await commit
    expect(state.local.snapshot.entries[0].values.shares).toBe(12); expect(state.local.portfolio!.manual[0].values.value).toBe(8)
    expect(state.fullSync.recentReceipt!.id).toBe('fullmanaged-owned-refresh')
  })
  it.each(['choice', 'request'] as const)('rejects %s getters without executing them or mutating the workspace', async fault => {
    const f = await refreshReady(), getter = vi.fn(), before = await f.image()
    if (fault === 'choice') {
      const bad = [Object.defineProperty({ key: KEY, field: 'shares', choice: 'local' }, 'choice', { enumerable: true, get: getter })]
      await expect(f.managed.previewRefresh('fullmanaged-refresh-getter', bad as Parameters<typeof f.managed.previewRefresh>[1])).rejects.toBeDefined()
    } else {
      const plan = await f.managed.previewRefresh('fullmanaged-refresh-getter')
      const bad = Object.defineProperty({ ...plan.request! }, 'expected', { enumerable: true, get: getter })
      await expect(f.managed.commitRefresh(bad, true)).rejects.toBeDefined()
    }
    expect(getter).not.toHaveBeenCalled(); expect(await f.image()).toEqual(before)
    expect(f.port.refreshFullSync).not.toHaveBeenCalled(); expect(f.transport.write).not.toHaveBeenCalled()
  })
  it.each(['prepared', 'confirmed', 'unknown'] as const)('cannot refresh through a real %s original packet', async mode => {
    const f = await prepared()
    if (mode === 'unknown') f.transport.write.mockRejectedValueOnce(new Error('synthetic unknown write'))
    if (mode !== 'prepared') await f.managed.sendOnce()
    await f.managed.pullComplete(); const before = await f.image()
    await expect(f.managed.previewRefresh('fullmanaged-refresh-pending')).rejects.toMatchObject({ code: 'managed_pending' })
    expect(await f.image()).toEqual(before); expect(f.port.refreshFullSync).not.toHaveBeenCalled()
    expect(f.transport.write).toHaveBeenCalledTimes(mode === 'prepared' ? 0 : 1)
  })
  it.each(['lost-response', 'lost-hydrate'] as const)('retains the original refresh identifier after %s and releases only by manual full receipt', async fault => {
    const f = await refreshReady(), plan = await f.managed.previewRefresh('fullmanaged-refresh-lost'), actual = f.port.refreshFullSync.getMockImplementation()!
    f.port.refreshFullSync.mockImplementationOnce(async (...args) => {
      const state = await actual(...args)
      if (fault === 'lost-response') throw new OwnerWorkspaceError('workspace_unavailable')
      f.port.readFullSyncState.mockRejectedValueOnce(new Error('synthetic post-refresh read lost')); return state
    })
    await expect(f.managed.commitRefresh(plan.request!, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect((await f.image()).fullSync.base!.pulledRevision).toBe(4)
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: {
      operation: 'refresh', id: plan.request!.id, hash: plan.request!.hash } })
    await expect(f.managed.commitRefresh(plan.request!, true)).rejects.toMatchObject({ code: 'managed_local_unknown' })
    expect((await f.managed.reconcileLocal(plan.request!.id, plan.request!.hash)).state).toBe('matched')
    expect(f.managed.status()).toMatchObject({ state: 'idle', uncertainLocal: null, completeReady: false, resultReady: false })
    expect(f.port.refreshFullSync).toHaveBeenCalledOnce(); expect(f.transport.write).not.toHaveBeenCalled(); expect(f.transport.receipt).not.toHaveBeenCalled()
  })
  it('rejects publication of an older committed refresh when another handle writes before the real post-hydration read', async () => {
    const f = await refreshReady(), plan = await f.managed.previewRefresh('fullmanaged-refresh-publication'), handle = await other(f), actual = f.port.refreshFullSync.getMockImplementation()!
    f.port.refreshFullSync.mockImplementationOnce(async (...args) => {
      const state = await actual(...args)
      await handle.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullmanaged-newer-than-refresh', expected: state.local,
        command: { type: 'save_manual', key: ASSET, updated_at: '2026-10-26T00:00:00Z',
          values: { name: '合成现金', cls: '现金', value: 99, note: '较新编辑' } } }), f.guard)
      return state
    })
    await expect(f.managed.commitRefresh(plan.request!, true)).rejects.toMatchObject({ code: 'managed_context_changed' })
    expect((await f.image()).local.portfolio!.manual[0].values.value).toBe(99)
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: { operation: 'refresh', id: plan.request!.id, hash: plan.request!.hash } })
    // The one recent local receipt was legitimately superseded. Absence cannot
    // retroactively classify or authorize replay of the older refresh.
    expect(await f.managed.reconcileLocal(plan.request!.id, plan.request!.hash)).toEqual({ state: 'unknown' })
    expect(f.managed.status().state).toBe('local_unknown'); expect(f.port.refreshFullSync).toHaveBeenCalledOnce()
    expect(f.transport.write).not.toHaveBeenCalled()
  })
  it.each(['request', 'choices'] as const)('charges %s ownership to the original total 12s refresh budget', async mode => {
    const f = await refreshReady(), plan = await f.managed.previewRefresh('fullmanaged-refresh-budget'), before = await f.image(),
      reads = f.port.readFullSyncState.mock.calls.length, encode = TextEncoder.prototype.encode
    let now = 100, injected = false
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now)
    const needle = mode === 'request' ? JSON.stringify(plan.request!.id) : '[]'
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input) {
      const result = encode.call(this, input)
      if (!injected && input === needle) { injected = true; now = 12_100 }
      return result
    })
    await expect(mode === 'request' ? f.managed.commitRefresh(plan.request!, true)
      : f.managed.previewRefresh('fullmanaged-refresh-budget-choices', [])).rejects.toMatchObject({ code: 'managed_timeout' })
    expect(injected).toBe(true); expect(f.port.readFullSyncState).toHaveBeenCalledTimes(reads)
    expect(f.port.refreshFullSync).not.toHaveBeenCalled(); expect(f.transport.write).not.toHaveBeenCalled()
    vi.restoreAllMocks(); expect(await f.image()).toEqual(before)
  })
})

describe('actual unknown and reloaded results never authorize another POST', () => {
  it.each(['network', 'partial', 'malformed', 'permission', 'response-getter', 'response-extra'] as const)('retains the original after %s and only reconciles its receipt', async fault => {
    const f = await prepared(), before = await f.image(), getter = vi.fn()
    if (fault === 'network') f.transport.write.mockRejectedValueOnce(new Error(PRIVATE))
    if (fault === 'partial') f.transport.write.mockResolvedValueOnce({ status: 200, rawBody: '{"revision":3,"records":[]}' })
    if (fault === 'malformed') f.transport.write.mockResolvedValueOnce({ status: 200, rawBody: '{"revision":3,"revision":3,"records":[]}' })
    if (fault === 'permission') f.transport.write.mockResolvedValueOnce({ status: 403, rawBody: '{"detail":"sync_consent_required"}' })
    if (fault === 'response-getter') f.transport.write.mockResolvedValueOnce(Object.defineProperty(success(), 'rawBody', { enumerable: true, get: getter }))
    if (fault === 'response-extra') f.transport.write.mockResolvedValueOnce({ ...success(), private: PRIVATE } as Http)
    const state = await f.managed.sendOnce()
    expect(state.local.outbox.entry!.state).toBe('unknown'); expect(state.fullSync.pending).toEqual(before.fullSync.pending)
    expect(f.managed.status().resultReady).toBe(false); expect(getter).not.toHaveBeenCalled()
    await expect(f.managed.sendOnce()).rejects.toMatchObject({ code: 'managed_pending' })
    await f.managed.hydrate(); await expect(f.managed.cancelPrepared('fullmanaged-no-cancel-unknown', true)).rejects.toBeDefined()
    await f.managed.hydrate(); await f.managed.reconcileReceipt()
    expect(f.transport.receipt).toHaveBeenCalledWith(before.fullSync.pending!.requestId, before.fullSync.pending!.requestHash, expect.any(AbortSignal))
    expect((await f.image()).local.outbox.entry!.state).toBe('confirmed')
    expect(f.transport.write).toHaveBeenCalledOnce(); expect(f.port.ackFullSync).not.toHaveBeenCalled()
  })
  it('404/missing receipt keeps unknown unchanged and cannot be treated as rollback or resend permission', async () => {
    const f = await prepared(); f.transport.write.mockRejectedValueOnce(new Error('synthetic lost commit response')); await f.managed.sendOnce()
    const before = await f.image(); f.transport.receipt.mockResolvedValueOnce({ status: 404, rawBody: '{"state":"unknown","error":"sync_result_unknown"}' })
    await f.managed.reconcileReceipt()
    expect(await f.image()).toEqual(before); expect(f.managed.status().resultReady).toBe(false)
    expect(f.transport.write).toHaveBeenCalledOnce()
  })
  it('hydrates stored prepared/attempted packets without POST; after reload confirmed still requires fresh raw receipt association', async () => {
    const f = await fixture('prepared'); f.managed.setCloudConsent(true); await f.managed.hydrate()
    expect(f.managed.status().state).toBe('prepared'); expect(f.transport.write).not.toHaveBeenCalled()
    await f.managed.sendOnce(); const reloaded = f.create(); reloaded.setCloudConsent(true); await reloaded.hydrate(); await reloaded.pullComplete()
    await expect(reloaded.previewAcknowledgement('fullmanaged-reload-ack')).rejects.toMatchObject({ code: 'managed_result_required' })
    await reloaded.hydrate(); await reloaded.reconcileReceipt(); await reloaded.pullComplete()
    expect((await reloaded.previewAcknowledgement('fullmanaged-reload-ack')).request).not.toBeNull()
    expect(f.transport.write).toHaveBeenCalledOnce()
  })
  it('a full 409 waits for explicit fund/manual choices before real ACK and retains manual remaining intent', async () => {
    const f = await prepared(); f.transport.write.mockImplementationOnce(async () => {
      f.setServer([fund(3, 12), manual(3, 20)]); return conflict()
    }); await f.managed.sendOnce(); await f.managed.pullComplete()
    const unresolved = await f.managed.previewAcknowledgement('fullmanaged-conflict-ack')
    expect(unresolved.request).toBeNull(); expect(unresolved.preview.conflicts).toMatchObject([{ key: KEY, field: 'shares' }, { key: ASSET, field: 'value' }])
    const selected = await f.managed.previewAcknowledgement('fullmanaged-conflict-ack', [{ key: KEY, field: 'shares', choice: 'cloud' }, { key: ASSET, field: 'value', choice: 'local' }]),
      state = await f.managed.commitAcknowledgement(selected.request!, true)
    expect(state.local.snapshot.entries[0].values.shares).toBe(12); expect(state.local.portfolio!.manual[0].values.value).toBe(8)
    expect(planOwnerPortfolioCloudIntent(state.fullSync.base, state.local.snapshot, state.local.portfolio).operations).toEqual([
      { key: ASSET, kind: 'manual_asset', deleted: false, changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: 20 } },
    ])
    expect(f.transport.write).toHaveBeenCalledOnce()
  })
  it('owns ACK choices and the public sealed ACK request before either asynchronous boundary', async () => {
    const f = await prepared(); f.transport.write.mockImplementationOnce(async () => { f.setServer([fund(3, 12), manual(3, 20)]); return conflict() })
    await f.managed.sendOnce(); await f.managed.pullComplete()
    const resolutions = [{ key: KEY, field: 'shares' as const, choice: 'cloud' as 'local' | 'cloud' },
      { key: ASSET, field: 'value' as const, choice: 'local' as 'local' | 'cloud' }], work = f.managed.previewAcknowledgement('fullmanaged-owned-ack', resolutions)
    resolutions[0].choice = 'local'; resolutions[1].choice = 'cloud'
    const selected = await work
    expect(selected.preview.nextSnapshot!.entries[0].values.shares).toBe(12)
    expect(selected.preview.nextPortfolio!.manual[0].values.value).toBe(8)
    const supplied = { ...copy(selected.request!) }, commit = f.managed.commitAcknowledgement(supplied, true)
    supplied.hash = '1'.repeat(64); supplied.matchedResult = { ...supplied.matchedResult, rawBody: '{}' }
    const state = await commit
    expect(state.local.snapshot.entries[0].values.shares).toBe(12); expect(state.local.portfolio!.manual[0].values.value).toBe(8)
    expect(f.port.ackFullSync).toHaveBeenCalledOnce(); expect(f.transport.write).toHaveBeenCalledOnce()
  })
})

describe('actual authority, complete-image drift, fixed-upper head floor and caller input ownership', () => {
  it.each(['manual', 'history'] as const)('invalidates an old preparation preview after actual other-handle %s edit', async kind => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('fullmanaged-stale-preview'), handle = await other(f), state = await handle.readFullSyncState(f.guard)
    await handle.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullmanaged-competing-' + kind, expected: state.local,
      command: kind === 'manual'
        ? { type: 'save_manual', key: ASSET, updated_at: '2026-10-25T01:00:00Z', values: { name: '合成现金', cls: '现金', value: 9, note: null } }
        : { type: 'append_observation', observation: { id: 'fullmanaged-new-history-0001', kind: 'observation', observed_at: '2026-10-24T16:01:00Z', date: '2026-10-25', calendar: 'Asia/Shanghai',
          value: 0, cost: null, holdings: [{ kind: 'manual', key: ASSET, name: '合成现金', cls: '现金', value: 0, cost: null }] } } }), f.guard)
    const changed = await handle.readFullSyncState(f.guard)
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_context_changed' })
    expect(await handle.readFullSyncState(f.guard)).toEqual(changed)
    expect(f.port.prepareFullSync).not.toHaveBeenCalled(); expect(f.transport.write).not.toHaveBeenCalled()
  })
  it('cannot send or clear another handle’s actual cancel/reprepare replacement', async () => {
    const f = await prepared(), handle = await other(f), state = await handle.readFullSyncState(f.guard), pending = state.fullSync.pending!
    const cleared = await handle.cancelPreparedFullSync(await buildOwnerWorkspaceFullSyncCancelRequest(TARGET, { id: 'fullmanaged-other-cancel', expected: state,
      requestId: pending.requestId, requestHash: pending.requestHash }), f.guard),
      next = await buildOwnerWorkspaceFullSyncPrepareRequest(TARGET, { id: 'fullmanaged-other-prepare', expected: cleared }), changed = await handle.prepareFullSync(next, f.guard)
    await expect(f.managed.sendOnce()).rejects.toMatchObject({ code: 'managed_hydrate_required' })
    expect(await handle.readFullSyncState(f.guard)).toEqual(changed); expect(f.transport.write).not.toHaveBeenCalled(); expect(f.port.transitionFullSyncDelivery).not.toHaveBeenCalled()
  })
  it('rejects metadata-only same-version storage drift instead of committing a preview bound to an older complete image', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('fullmanaged-metadata-stale')
    expect(request.expected.local.metadata.displayTimes[0].updated_at).not.toBeNull()
    // Explicit raw storage fault injection, not an application writer or proof
    // that local hashes authenticate arbitrary same-origin JS.
    await metadataFault(f.factory)
    await expect(f.managed.commitPreparation(request, true)).rejects.toBeDefined()
    expect(f.port.prepareFullSync).not.toHaveBeenCalled(); expect(f.transport.write).not.toHaveBeenCalled()
  })
  it('another handle completing the sealed real ACK invalidates this controller preview without a second ACK', async () => {
    const f = await confirmed(); await f.managed.pullComplete(); const { request } = await f.managed.previewAcknowledgement('fullmanaged-competing-ack'), handle = await other(f),
      changed = await handle.ackFullSync(request!, f.guard)
    await expect(f.managed.commitAcknowledgement(request!, true)).rejects.toMatchObject({ code: 'managed_hydrate_required' })
    expect(f.port.ackFullSync).not.toHaveBeenCalled(); expect(await handle.readFullSyncState(f.guard)).toEqual(changed)
  })
  it('retains a validated partial-page head when a later page fails, rejecting lower later D after rehydrate/receipt', async () => {
    const f = await confirmed(), first = Array.from({ length: 200 }, (_, index) => ({ ...fund(4, 7), key: String(index + 1).padStart(6, '0') + '::synthetic-page' })),
      cursor = [4, first.at(-1)!.key] as const
    f.transport.changes.mockResolvedValueOnce(page(first, 6, cursor)).mockResolvedValueOnce({ status: 503, rawBody: '{}' })
    await expect(f.managed.pullComplete()).rejects.toBeDefined()
    expect(f.managed.status().completeReady).toBe(false)
    await f.managed.hydrate(); await f.managed.reconcileReceipt()
    f.transport.changes.mockResolvedValueOnce(page([fund(3, 7), manual(3, 8)], 3))
    await expect(f.managed.pullComplete()).rejects.toBeDefined()
    expect(f.managed.status().completeReady).toBe(false); expect(f.port.ackFullSync).not.toHaveBeenCalled()
  })
  it('does not publish complete D until all fixed-upper pages have parsed under the same operation', async () => {
    const f = await confirmed(), wait = deferred<Http>(), first = Array.from({ length: 200 }, (_, index) => ({ ...fund(2, 7), key: String(index + 1).padStart(6, '0') + '::synthetic-page' })),
      cursor = [2, first.at(-1)!.key] as const
    f.transport.changes.mockResolvedValueOnce(page(first, 3, cursor)).mockImplementationOnce(() => wait.promise)
    const work = f.managed.pullComplete(); await vi.waitFor(() => expect(f.transport.changes).toHaveBeenCalledTimes(2))
    expect(f.managed.status().completeReady).toBe(false); expect(f.port.ackFullSync).not.toHaveBeenCalled()
    expect(f.transport.changes.mock.calls.map(call => call[0])).toEqual([{ sinceRevision: 0, limit: 200 }, { sinceRevision: 0, upperRevision: 3, cursor, limit: 200 }])
    wait.resolve(page([fund(3, 7), manual(3, 8)], 3)); await work
    expect(f.managed.status().completeReady).toBe(true)
  })
  it('owns received preparation references before await and rejects getter/hidden/forged request without invoking them', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('fullmanaged-owned-prepare'), getter = vi.fn(), original = copy(request)
    for (const bad of [Object.defineProperty({ ...request }, 'expected', { enumerable: true, get: getter }),
      Object.defineProperty({ ...request }, 'hidden', { value: true }), { ...request, hash: '1'.repeat(64) }]) {
      await expect((async () => f.managed.commitPreparation(bad, true))()).rejects.toBeDefined()
      expect(f.port.prepareFullSync).not.toHaveBeenCalled()
    }
    expect(getter).not.toHaveBeenCalled()
    await f.managed.hydrate(); const next = await f.managed.previewPreparation(original.id), supplied = { ...copy(next) }, work = f.managed.commitPreparation(supplied, true)
    supplied.id = 'changed-received-prepare'; supplied.hash = '2'.repeat(64)
    const state = await work
    expect(state.fullSync.pending!.requestId).toBe(original.id); expect(state.fullSync.pending!.preparationHash).toBe(next.hash)
  })
  it('rejects injected/fake supplied response bytes and ACK-resolution getters instead of accepting caller evidence', async () => {
    const f = await confirmed(); await f.managed.pullComplete(); const selected = await f.managed.previewAcknowledgement('fullmanaged-sealed-ack'), getter = vi.fn()
    const fake = { ...selected.request!, matchedResult: { ...selected.request!.matchedResult, rawBody: selected.request!.matchedResult.rawBody + ' ' } }
    await expect(f.managed.commitAcknowledgement(fake, true)).rejects.toMatchObject({ code: 'managed_preview_required' })
    expect(f.port.ackFullSync).not.toHaveBeenCalled()
    const resolutions = [Object.defineProperty({ key: ASSET, field: 'value', choice: 'local' }, 'choice', { enumerable: true, get: getter })]
    await expect((async () => f.managed.previewAcknowledgement('fullmanaged-getter-choice', resolutions as Parameters<typeof f.managed.previewAcknowledgement>[1]))()).rejects.toBeDefined()
    expect(getter).not.toHaveBeenCalled(); expect(f.port.ackFullSync).not.toHaveBeenCalled()
  })
  it.each(['revoked', 'endpoint', 'logout', 'consent', 'silent-generation'] as const)('rejects %s authority and ignores a late uncooperative write result', async mode => {
    const f = await prepared(), wait = deferred<Http>(); f.transport.write.mockImplementationOnce(() => wait.promise)
    const work = f.managed.sendOnce(), rejected = expect(work).rejects.toMatchObject({ code: 'managed_context_changed' })
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledOnce())
    if (mode === 'revoked') f.authority.abort()
    if (mode === 'endpoint') { f.live.endpoint = '/changed-api'; f.managed.notifySessionChanged() }
    if (mode === 'logout') { f.setSession({ authenticated: false, generation: 2 }); f.managed.notifySessionChanged() }
    if (mode === 'consent') f.managed.setCloudConsent(false)
    if (mode === 'silent-generation') { f.setSession({ authenticated: true, generation: 2 }); wait.resolve(success()) }
    await rejected; wait.resolve(success()); await tick()
    expect(f.managed.status().resultReady).toBe(false); expect(f.port.ackFullSync).not.toHaveBeenCalled()
    const handle = await other(f), freshGuard = { signal: new AbortController().signal, assertActive() {} }
    expect((await handle.readFullSyncState(freshGuard)).local.outbox.entry!.state).toBe('attempted')
    expect(f.transport.write).toHaveBeenCalledOnce()
  })
  it('late old-generation cleanup does not clear a newer in-flight receipt operation or close the shared workspace', async () => {
    const f = await prepared(), old = deferred<Http>(), newer = deferred<Http>()
    f.transport.write.mockImplementationOnce(() => old.promise)
    const previous = f.managed.sendOnce(), rejected = expect(previous).rejects.toMatchObject({ code: 'managed_context_changed' })
    await vi.waitFor(() => expect(f.transport.write).toHaveBeenCalledOnce())
    f.setSession({ authenticated: true, generation: 2 }); f.managed.notifySessionChanged(); await rejected
    await f.managed.hydrate(); f.transport.receipt.mockImplementationOnce(() => newer.promise)
    const reconciliation = f.managed.reconcileReceipt(); await vi.waitFor(() => expect(f.transport.receipt).toHaveBeenCalledOnce())
    old.resolve(success()); await tick()
    expect(f.managed.status()).toMatchObject({ busy: true, resultReady: false })
    await expect(f.managed.pullComplete()).rejects.toMatchObject({ code: 'managed_busy' })
    newer.resolve(receipt()); await reconciliation
    expect(f.managed.status()).toMatchObject({ busy: false, resultReady: true })
    expect((await f.image()).local.outbox.entry!.state).toBe('confirmed'); expect(f.transport.write).toHaveBeenCalledOnce()
  })
})

describe('one monotonic operation budget and local uncertainty without replay', () => {
  it.each(['preparation-request', 'ack-request', 'ack-resolutions'] as const)('includes %s descriptor ownership in the same 12s budget before any actual mutation/read continuation', async mode => {
    const f = mode === 'preparation-request' ? await fixture() : await confirmed()
    let preparation: Awaited<ReturnType<typeof buildOwnerWorkspaceFullSyncPrepareRequest>> | null = null
    let acknowledgement: NonNullable<Awaited<ReturnType<typeof f.managed.previewAcknowledgement>>['request']> | null = null
    if (mode === 'preparation-request') {
      f.managed.setCloudConsent(true); await f.managed.hydrate(); preparation = await f.managed.previewPreparation('fullmanaged-copy-budget-prepare')
    } else {
      await f.managed.pullComplete()
      if (mode === 'ack-request') acknowledgement = (await f.managed.previewAcknowledgement('fullmanaged-copy-budget-ack')).request
    }
    const before = await f.image(), reads = f.port.readFullSyncState.mock.calls.length, encode = TextEncoder.prototype.encode,
      needle = mode === 'preparation-request' ? JSON.stringify(preparation!.id) : mode === 'ack-request' ? JSON.stringify(acknowledgement!.id) : '[]'
    let now = 100, injected = false
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now)
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input) {
      const result = encode.call(this, input)
      // The genuine copier still checks all original descriptors/limits. Only
      // its measured elapsed time is advanced; no validator result is changed.
      if (!injected && input === needle) { injected = true; now = 12_100 }
      return result
    })
    const work = mode === 'preparation-request' ? f.managed.commitPreparation(preparation!, true)
      : mode === 'ack-request' ? f.managed.commitAcknowledgement(acknowledgement!, true)
        : f.managed.previewAcknowledgement('fullmanaged-copy-budget-resolutions', [])
    await expect(work).rejects.toMatchObject({ code: 'managed_timeout' })
    expect(injected).toBe(true); expect(f.port.readFullSyncState).toHaveBeenCalledTimes(reads)
    expect(f.port.prepareFullSync).toHaveBeenCalledTimes(mode === 'preparation-request' ? 0 : 1)
    expect(f.port.ackFullSync).not.toHaveBeenCalled()
    vi.restoreAllMocks(); expect(await f.image()).toEqual(before)
  })
  it('checks the same monotonic 12s budget after real attempted CAS and never POSTs when that CAS exhausted it', async () => {
    const f = await prepared(), transition = f.port.transitionFullSyncDelivery.getMockImplementation()!
    let now = 100; vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now)
    f.port.transitionFullSyncDelivery.mockImplementationOnce(async (...args) => {
      const actual = await transition(...args); now = 12_100; return actual
    })
    const error = await f.managed.sendOnce().then(() => null, problem => problem as unknown)
    expect(f.transport.write).not.toHaveBeenCalled()
    expect((await f.image()).local.outbox.entry!.state).toBe('attempted')
    expect((await f.image()).fullSync.pending!.rawBody).toBe(f.request.packet.rawBody)
    expect(error).toMatchObject({ code: 'managed_timeout' })
  })
  it('checks captured endpoint authority again after actual attempted CAS and before POST', async () => {
    const f = await prepared(), transition = f.port.transitionFullSyncDelivery.getMockImplementation()!
    f.port.transitionFullSyncDelivery.mockImplementationOnce(async (...args) => { const actual = await transition(...args); f.live.endpoint = '/changed-api'; return actual })
    const error = await f.managed.sendOnce().then(() => null, problem => problem as unknown)
    expect(f.transport.write).not.toHaveBeenCalled()
    const handle = await other(f), guard = { signal: new AbortController().signal, assertActive() {} }
    expect((await handle.readFullSyncState(guard)).local.outbox.entry!.state).toBe('attempted')
    expect(error).toMatchObject({ code: 'managed_context_changed' })
  })
  it('rejects a monotonic clock rollback during real storage preflight without even attempting or POSTing the packet', async () => {
    const f = await prepared(), read = f.port.readFullSyncState.getMockImplementation()!
    let now = 100; vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now)
    f.port.readFullSyncState.mockImplementationOnce(async (...args) => { const actual = await read(...args); now = 99; return actual })
    const error = await f.managed.sendOnce().then(() => null, problem => problem as unknown)
    expect(f.transport.write).not.toHaveBeenCalled(); expect(f.port.transitionFullSyncDelivery).not.toHaveBeenCalled()
    expect((await f.image()).local.outbox.entry!.state).toBe('prepared')
    expect(error).toMatchObject({ code: 'managed_timeout' })
  })
  it('a real preparation commit followed by a lost local response only releases through manual original receipt', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('fullmanaged-lost-prepare'), actual = f.port.prepareFullSync.getMockImplementation()!
    f.port.prepareFullSync.mockImplementationOnce(async (...args) => { await actual(...args); throw new OwnerWorkspaceError('workspace_unavailable') })
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: { operation: 'prepare', id: request.id, hash: request.hash } })
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_local_unknown' })
    expect((await f.managed.reconcileLocal(request.id, request.hash)).state).toBe('matched')
    expect(f.managed.status()).toMatchObject({ state: 'prepared', uncertainLocal: null })
    expect(f.port.prepareFullSync).toHaveBeenCalledOnce(); expect(f.transport.write).not.toHaveBeenCalled()
  })
  it('a real quota-aborted prepare leaves local result unknown until manual receipt, whose absence never permits replay', async () => {
    const f = await fixture(); f.managed.setCloudConsent(true); await f.managed.hydrate()
    const request = await f.managed.previewPreparation('fullmanaged-quota-unknown'), put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'portfolio_sync_metadata' && key === 'current') throw new DOMException('Synthetic quota', 'QuotaExceededError')
      return put.call(this, value, key)
    })
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    vi.restoreAllMocks()
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: { operation: 'prepare', id: request.id, hash: request.hash } })
    expect(await f.managed.reconcileLocal(request.id, request.hash)).toEqual({ state: 'unknown' })
    expect(f.managed.status().state).toBe('local_unknown')
    expect(await f.managed.exportPending()).toBeNull(); expect((await f.image()).local.outbox.entry).toBeNull()
    await expect(f.managed.commitPreparation(request, true)).rejects.toMatchObject({ code: 'managed_local_unknown' })
    expect(f.port.prepareFullSync).toHaveBeenCalledOnce(); expect(f.transport.write).not.toHaveBeenCalled()
  })
  it.each(['lost-ack-response', 'lost-reset-read'] as const)('keeps actual ACK committed after %s, then only manually matches its local receipt', async fault => {
    const f = await confirmed(); await f.managed.pullComplete(); const { request } = await f.managed.previewAcknowledgement('fullmanaged-lost-ack'), actual = f.port.ackFullSync.getMockImplementation()!
    f.port.ackFullSync.mockImplementationOnce(async (...args) => {
      const result = await actual(...args)
      if (fault === 'lost-ack-response') throw new OwnerWorkspaceError('workspace_unavailable')
      f.port.readFullSyncState.mockRejectedValueOnce(new Error('synthetic reset read lost')); return result
    })
    await expect(f.managed.commitAcknowledgement(request!, true)).rejects.toMatchObject({ code: 'managed_unavailable' })
    expect((await f.image()).local.outbox.entry).toBeNull()
    expect(f.managed.status()).toMatchObject({ state: 'local_unknown', uncertainLocal: { operation: 'ack', id: request!.id, hash: request!.hash } })
    await expect(f.managed.commitAcknowledgement(request!, true)).rejects.toMatchObject({ code: 'managed_local_unknown' })
    expect((await f.managed.reconcileLocal(request!.id, request!.hash)).state).toBe('matched')
    expect(f.managed.status()).toMatchObject({ state: 'idle', uncertainLocal: null, completeReady: false, resultReady: false })
    expect(f.port.ackFullSync).toHaveBeenCalledOnce(); expect(f.transport.write).toHaveBeenCalledOnce()
  })
})
