/** Actual app locator, Pinia, profile upgrades and strict IDB readers. No cloud
 * or browser evidence: raw mutations below are explicit synthetic faults. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory, type IDBDatabase } from 'fake-indexeddb'
import { useWatchlistStore } from './watchlist'
import * as workspaceModule from './owner-workspace'
import { openOwnerAuthority } from './owner-authority'
import { openOwnerWorkspace, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceFullSyncLinkRequest,
  buildOwnerWorkspaceFullSyncPrepareRequest, buildOwnerWorkspaceEditPortfolioRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard } from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'
import { setLegacySyncConsent } from '@/utils/cloud-consent'

const KEY = '510300::完整来源合成账户', CASH = 'asset:analysis-cash', GONE = 'asset:analysis-deleted'
let factory: IDBFactory, data: Map<string, string>
const stores: Array<ReturnType<typeof useWatchlistStore>> = [], handles: OwnerWorkspace[] = []
const network = vi.fn(() => { throw new Error('synthetic source capture forbids network') })
const stamp = '2026-10-26T00:00:00Z'
const fund = (): OwnerSyncRecord => ({ key: KEY, kind: 'holding', deleted: false, record_revision: 1,
  lifecycle_revision: 1, field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
  values: { name: '合成零份', shares: -0, cost: null, target_weight: 0 } })
const manual = (key = CASH, deleted = false): OwnerSyncRecord => ({ key, kind: 'manual_asset', deleted,
  record_revision: 2, lifecycle_revision: 2, field_revisions: { name: 2, cls: 2, value: 2, note: 2 },
  values: { name: '合成现金', cls: '现金', value: -0, note: null } })
const guard = (): OwnerWorkspaceGuard => ({ signal: new AbortController().signal, assertActive() {} })
const signal = () => new AbortController().signal
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
beforeEach(() => {
  factory = new IDBFactory()
  data = new Map([
    ['sinan_watchlist_v2', canonicalOwnerLocal([{ code: '510300', name: '合成零份', account: '完整来源合成账户',
      position_kind: 'holding', shares: -0, cost: null, target_weight: 0, updated_at: stamp }])],
    ['sinan_manual_assets_v1', ' \n' + canonicalOwnerLocal([{ id: 'analysis-cash', name: '合成现金', cls: '现金', value: -0, updated_at: stamp }]) + '\r\n'],
    ['sinan_snapshots', canonicalOwnerLocal([{ date: '2026-10-25', value: -0, cost: 0 }, { date: '2026-10-25', value: 7, cost: 9 }])],
  ])
  vi.stubGlobal('indexedDB', factory); vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('location', { origin: 'https://synthetic-source.example' })
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  network.mockClear(); vi.stubGlobal('fetch', network); setLegacySyncConsent(false)
})
afterEach(() => {
  stores.splice(0).forEach(store => store.$dispose()); handles.splice(0).forEach(handle => handle.close())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function store() {
  setActivePinia(createPinia()); const value = useWatchlistStore(); stores.push(value)
  await value.initialize(); return value
}
async function handle(target: string) {
  const value = await openOwnerWorkspace(factory, target, { existingOnly: true }); handles.push(value); return value
}
async function fixture(phase: 'v3' | 'v4' | 'v5' | 'unlinked6' | 'v6' = 'v6') {
  const current = await store(), backup = await current.createLocalWorkspaceBackup()
  await current.activateLocalWorkspace(backup.raw, backup.sha256)
  const locator = await openOwnerAuthority(factory, localStorage), pointer = await locator.read(); locator.close()
  const target = pointer.targetFingerprint!
  if (phase === 'v3') return { current, target, pointer, original: new Map(data), db: await handle(target) }
  const recovery = await current.createSyncRecoveryBackup()
  await current.upgradeLocalSyncFormat(recovery.raw, recovery.sha256, true)
  let db = await handle(target)
  await db.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(target, { id: 'source-old-link-0001',
    expected: await db.readSyncState(guard()), base: { pulledRevision: 1, records: [fund()] } }), guard())
  await current.load(true)
  if (phase === 'v4') return { current, target, pointer, original: new Map(data), db }
  const portfolio = await current.createPortfolioUpgradeBackup()
  await current.previewPortfolioUpgrade(portfolio.raw, portfolio.sha256)
  await current.upgradePortfolioFormat(portfolio.raw, portfolio.sha256, true)
  if (phase === 'v5') return { current, target, pointer, original: new Map(data), db: await handle(target) }
  const full = await current.createFullSyncUpgradeBackup()
  await current.previewFullSyncUpgrade(full.raw, full.sha256)
  await current.upgradeFullSyncFormat(full.raw, full.sha256, true)
  db = await handle(target)
  if (phase !== 'unlinked6') await db.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(target, {
    id: 'source-full-link-0001', expected: await db.readFullSyncState(guard()), minimumObservedRevision: 2,
    base: { pulledRevision: 2, records: [fund(), manual(), manual(GONE, true)] }, resolutions: [],
  }), guard())
  await current.load(true)
  return { current, target, pointer, original: new Map(data), db }
}
async function rawOpen(target: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + target)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
}
async function fault(target: string, name: string, key: string, mutate: (value: any) => void) {
  const db = await rawOpen(target)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite'), store = tx.objectStore(name), request = store.get(key)
    request.onsuccess = () => { const value = request.result; mutate(value); store.put(value, key) }
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
const observation = () => ({ id: 'synthetic-source-observation', kind: 'observation' as const,
  observed_at: stamp, date: '2026-10-26', calendar: 'Asia/Shanghai' as const, value: 0, cost: null,
  holdings: [{ kind: 'manual' as const, key: CASH, name: '合成现金', cls: '现金' as const, value: 0, cost: null }] })

describe('actual analysis source capture on complete physical profiles', () => {
  it.each(['v3', 'v5', 'unlinked6'] as const)('refuses %s without a format fallback, network or store writes', async phase => {
    const f = await fixture(phase), before = canonicalOwnerLocal(await f.db.readLocalState(guard()))
    await expect(f.current.captureOwnerAnalysisSource(signal())).rejects.toBeInstanceOf(Error)
    expect(canonicalOwnerLocal(await f.db.readLocalState(guard()))).toBe(before)
    expect(network).not.toHaveBeenCalled(); expect(data).toEqual(f.original)
  })
  it('preserves the exact original v4 preimage bytes and the fund-only sender guard', async () => {
    const f = await fixture('v4'), source = await f.current.captureOwnerAnalysisSource(signal())
    expect(source.profile).toBe('v4')
    expect(source.preimage).toBe(canonicalOwnerLocal({ authority: f.pointer, state: await f.db.readSyncState(guard()) }))
    await expect(source.verify(signal())).resolves.toBeUndefined()
    expect(source.preimage).not.toContain('"profile":')
    expect(network).not.toHaveBeenCalled()
  })
  it('reads the real full B rather than old v4 B and owns the complete typed local source without writes', async () => {
    const f = await fixture(), before = await f.db.readFullSyncState(guard())
    const source = await f.current.captureOwnerAnalysisSource(signal())
    expect(source.profile).toBe('v6'); if (source.profile !== 'v6') throw new Error('not full profile')
    expect(source.state.local.sync!.base!.pulledRevision).toBe(1); expect(source.state.fullSync.base!.pulledRevision).toBe(2)
    expect(source.state.fullSync.base!.records).toHaveLength(3)
    expect(source.state.fullSync.base!.records.find(row => row.key === GONE)?.deleted).toBe(true)
    expect(Object.is(source.state.local.snapshot.entries[0].values.shares, -0)).toBe(true)
    expect(Object.is(source.state.local.portfolio!.manual.find(row => row.key === CASH)!.values.value, -0)).toBe(true)
    expect(source.state.local.portfolio!.manual.find(row => row.key === CASH)!.values.note).toBeNull()
    expect(source.state.local.portfolio!.history).toHaveLength(2)
    expect(source.state.local.portfolio!.migration.manualRaw).toBe(f.original.get('sinan_manual_assets_v1'))
    expect(source.preimage).toBe(canonicalOwnerLocal({ profile: 'v6', authority: f.pointer, state: before }))
    await source.verify(signal()); expect(await f.db.readFullSyncState(guard())).toEqual(before)
    expect(f.current.hasLocalChanges()).toBe(true) // local_pending is not cloud/action confirmation.
    await expect(f.current.enableWorkspaceSync(true)).rejects.toBeInstanceOf(Error)
    expect(network).not.toHaveBeenCalled(); expect(data).toEqual(f.original)
  })
  it.each(['fund', 'manual', 'delete', 'rename'] as const)('refuses real unuploaded %s intent even with no sync packet', async kind => {
    const f = await fixture()
    if (kind === 'manual') await f.current.editPortfolio({ type: 'save_manual', key: CASH,
      values: { ...manual().values, value: 1 } as any, updated_at: stamp })
    else if (kind === 'delete') await f.current.editPortfolio({ type: 'remove_manual', key: CASH, updated_at: stamp })
    else await f.current.saveHolding({ code: '510300', name: '合成零份', account: kind === 'rename' ? '新合成账户' : '完整来源合成账户',
      position_kind: 'holding', shares: 3, cost: null, target_weight: 0 }, { id: KEY, snapshot: f.current.entrySnapshot(KEY)! }, { confirmed: true })
    const current = await f.db.readFullSyncState(guard())
    expect(current.local.outbox.entry).toBeNull()
    expect(planOwnerPortfolioCloudIntent(current.fullSync.base, current.local.snapshot, current.local.portfolio).operations.length).toBeGreaterThan(0)
    await expect(f.current.captureOwnerAnalysisSource(signal())).rejects.toBeInstanceOf(Error)
    expect(network).not.toHaveBeenCalled()
  })
  it.each(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const)('refuses a real %s full packet', async status => {
    const f = await fixture()
    await f.current.editPortfolio({ type: 'save_manual', key: CASH,
      values: { name: '合成现金', cls: '现金', value: 2, note: null }, updated_at: stamp })
    const request = await buildOwnerWorkspaceFullSyncPrepareRequest(f.target, { id: 'source-full-packet-0001', expected: await f.db.readFullSyncState(guard()) })
    let state = await f.db.prepareFullSync(request, guard())
    const move = async (nextState: 'attempted' | 'unknown' | 'confirmed' | 'conflict') => {
      const pending = state.fullSync.pending!
      state = await f.db.transitionFullSyncDelivery({ expected: state, requestId: pending.requestId,
        requestHash: pending.requestHash, preparationHash: pending.preparationHash, nextState }, guard())
    }
    if (status !== 'prepared') await move('attempted')
    if (status !== 'prepared' && status !== 'attempted') await move(status)
    await f.current.load(true)
    expect((await f.db.readFullSyncState(guard())).local.outbox.entry?.state).toBe(status)
    await expect(f.current.captureOwnerAnalysisSource(signal())).rejects.toBeInstanceOf(Error)
    expect((await f.db.readFullSyncState(guard())).local.outbox.entry?.rawBody).toBe(request.packet.rawBody)
  })
  it('rejects unpublished portfolio memory, preserves negative zero, and does not recapture changed memory as a new source', async () => {
    const f = await fixture(), source = await f.current.captureOwnerAnalysisSource(signal())
    const portfolio = structuredClone(f.current.portfolioState!)
    ;(portfolio.manual.find(row => row.key === CASH)!.values as any).value = 0
    f.current.portfolioState = portfolio
    expect(source.assertActive).toThrow(); await expect(source.verify(signal())).rejects.toBeInstanceOf(Error)
    await expect(f.current.captureOwnerAnalysisSource(signal())).rejects.toBeInstanceOf(Error)
  })
  it('invalidates old capture after a real history-only app edit but permits a new clean full source', async () => {
    const f = await fixture(), source = await f.current.captureOwnerAnalysisSource(signal())
    await f.current.editPortfolio({ type: 'append_observation', observation: observation() })
    expect(source.assertActive).toThrow()
    const fresh = await f.current.captureOwnerAnalysisSource(signal())
    expect(fresh.preimage).not.toBe(source.preimage); await fresh.verify(signal())
    expect((await f.db.readFullSyncState(guard())).local.portfolio!.history).toHaveLength(3)
  })
  it('rejects a second-handle history writer before memory publication and never blesses the newer image automatically', async () => {
    const f = await fixture(), source = await f.current.captureOwnerAnalysisSource(signal()), other = await handle(f.target)
    await other.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(f.target, { id: 'source-other-history-0001',
      expected: await other.readLocalState(guard()), command: { type: 'append_observation', observation: observation() } }), guard())
    await expect(source.verify(signal())).rejects.toBeInstanceOf(Error)
    await expect(f.current.captureOwnerAnalysisSource(signal())).rejects.toBeInstanceOf(Error)
    expect(f.current.portfolioState!.history).toHaveLength(2)
  })
  it('discards a delayed real full read after a newer app history writer has published', async () => {
    const f = await fixture(); f.current.$dispose()
    const actualOpen = workspaceModule.openOwnerWorkspace, reached = deferred(), gate = deferred()
    let armed = false
    vi.spyOn(workspaceModule, 'openOwnerWorkspace').mockImplementation(async (...args) => {
      const actual = await actualOpen(...args)
      return { ...actual, async readFullSyncState(active) {
        const value = await actual.readFullSyncState(active)
        if (armed) { armed = false; reached.release(); await gate.promise }
        return value
      } }
    })
    const current = await store(); armed = true
    const capture = current.captureOwnerAnalysisSource(signal()).then(() => false, () => true)
    await reached.promise
    await current.editPortfolio({ type: 'append_observation', observation: observation() })
    gate.release(); expect(await capture).toBe(true)
    expect(current.portfolioState!.history).toHaveLength(3)
    const fresh = await current.captureOwnerAnalysisSource(signal()); await fresh.verify(signal())
  })
  it('cannot verify a capture on a closed original handle by silently reopening another handle', async () => {
    const f = await fixture(); f.current.$dispose()
    const actualOpen = workspaceModule.openOwnerWorkspace
    let appHandle: OwnerWorkspace | null = null
    vi.spyOn(workspaceModule, 'openOwnerWorkspace').mockImplementation(async (...args) => {
      const opened = await actualOpen(...args); appHandle = opened; return opened
    })
    const current = await store(), source = await current.captureOwnerAnalysisSource(signal())
    expect(appHandle).not.toBeNull(); (appHandle as OwnerWorkspace | null)?.close()
    await expect(source.verify(signal())).rejects.toBeInstanceOf(Error)
    // A fresh explicit capture can reopen safely, but it never repairs the
    // context or original handle owned by a previous capture.
    await current.captureOwnerAnalysisSource(signal())
    expect(source.assertActive).toThrow()
  })
  it.each(['old-sync', 'portfolio-intent', 'full-intent', 'display-time', 'full-epoch'] as const)('rejects raw synthetic %s drift in the complete source', async field => {
    const f = await fixture(), source = await f.current.captureOwnerAnalysisSource(signal())
    if (field === 'old-sync') await fault(f.target, 'sync_metadata', 'current', value => { value.epoch++ })
    if (field === 'portfolio-intent') await fault(f.target, 'portfolio_metadata', 'intent', value => { value.id += '-changed' })
    if (field === 'full-intent') await fault(f.target, 'portfolio_sync_metadata', 'intent', value => { value.id += '-changed' })
    if (field === 'display-time') await fault(f.target, 'local_metadata', 'current', value => { value.displayTimes[0].updated_at = null })
    if (field === 'full-epoch') await fault(f.target, 'portfolio_sync_metadata', 'current', value => { value.epoch++ })
    await expect(source.verify(signal())).rejects.toBeInstanceOf(Error)
    expect(network).not.toHaveBeenCalled()
  })
  it('refuses aborted capture/verify and a disposed original store', async () => {
    const f = await fixture(), source = await f.current.captureOwnerAnalysisSource(signal()), stopped = new AbortController()
    stopped.abort(); await expect(source.verify(stopped.signal)).rejects.toBeInstanceOf(Error)
    await expect(f.current.captureOwnerAnalysisSource(stopped.signal)).rejects.toBeInstanceOf(Error)
    f.current.$dispose(); expect(source.assertActive).toThrow()
    await expect(source.verify(signal())).rejects.toBeInstanceOf(Error)
  })
})
