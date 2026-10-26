/** Actual core/codecs/IDB with faults only at the new code-module boundary.
 * This is local lazy/CAS evidence, not browser/PWA/cloud or artifact-size proof. */
import { webcrypto } from 'node:crypto'
import { setImmediate } from 'node:timers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory } from 'fake-indexeddb'
import { buildOwnerLegacyWorkspaceBackup, buildOwnerWorkspaceBackup } from '@/utils/owner-workspace-backup'
import type { OwnerWorkspace, OwnerWorkspaceGuard } from './owner-workspace-types'

const COMMANDS = './owner-workspace-full-sync-commands', TARGET = '9'.repeat(64)
const FULL_CODEC = './owner-workspace-full-sync-codec', PORTFOLIO_CODEC = './owner-workspace-portfolio-codec'
const DB = 'fund-compass-owner-sync-outbox-1:' + TARGET
const handles: OwnerWorkspace[] = []
const forbidden = vi.fn(() => { throw new Error('ambient network/storage forbidden') })
beforeEach(() => {
  vi.resetModules(); vi.doUnmock(COMMANDS); vi.doUnmock(FULL_CODEC); vi.doUnmock(PORTFOLIO_CODEC); forbidden.mockClear()
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', forbidden)
  vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden }); vi.stubGlobal('indexedDB', { open: forbidden })
})
afterEach(() => {
  handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
  vi.doUnmock(COMMANDS); vi.doUnmock(FULL_CODEC); vi.doUnmock(PORTFOLIO_CODEC); vi.resetModules()
})
function context() {
  const controller = new AbortController(), guard: OwnerWorkspaceGuard = { signal: controller.signal,
    assertActive() { if (controller.signal.aborted) throw new Error('synthetic authority revoked') } }
  return { controller, guard }
}
async function drain(until: () => boolean = () => false) {
  for (let at = 0; at < 80 && !until(); at++) await new Promise<void>(resolve => setImmediate(resolve))
}
async function image(factory: IDBFactory) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  try { return await new Promise<{ version: number; stores: Record<string, unknown[]> }>((resolve, reject) => {
    const names = [...db.objectStoreNames], tx = db.transaction(names), stores: Record<string, unknown[]> = {}
    for (const name of names) { const read = tx.objectStore(name).getAll(); read.onsuccess = () => { stores[name] = read.result } }
    tx.oncomplete = () => resolve({ version: db.version, stores }); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function adopted() {
  const module = await import('./owner-workspace'), factory = new IDBFactory(), ctx = context()
  const v3 = await module.openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: null,
    v2Raw: JSON.stringify([{ code: '000001', name: 'synthetic-full-lazy', account: '', position_kind: 'holding', shares: 0,
      cost: null, target_weight: 0, updated_at: '2026-10-25T00:00:00Z' }]) }
  const original = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const local = await v3.adoptLocal(await module.buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'full-lazy-adopt-0001',
    expected: await v3.readLocalState(ctx.guard), sourceArchive, backupSha256: original.sha256 }), ctx.guard)
  return { module, factory, ctx, v3, local }
}
async function upgraded(current: Awaited<ReturnType<typeof adopted>>, prepare = false) {
  const { module, factory, ctx } = current
  const v4 = await module.upgradeOwnerWorkspaceSync(factory, TARGET, current.local, ctx.guard); handles.push(v4)
  const file = await module.buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(ctx.guard), {
    manualRaw: '[{"id":"synthetic-lazy-cash","name":"合成零现金","cls":"现金","value":0,"updated_at":"2026-10-25T00:00:00Z"}]', snapshotsRaw: null,
  })
  const v5 = await module.upgradeOwnerWorkspacePortfolio(factory, TARGET, await module.buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
    { id: 'full-lazy-portfolio-0001', backupRaw: file.raw, backupSha256: file.sha256 }), ctx.guard); handles.push(v5)
  const recovery = await import('@/utils/owner-portfolio-recovery')
  const old = await recovery.buildOwnerPortfolioRecoveryBackup(TARGET, await v5.readLocalState(ctx.guard))
  await recovery.restoreOwnerPortfolioRecoveryBackup(old.raw, old.sha256)
  const v6 = await module.upgradeOwnerWorkspaceFullSync(factory, TARGET, await module.buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET,
    { id: 'full-lazy-upgrade-0001', backupRaw: old.raw, backupSha256: old.sha256 }), ctx.guard); handles.push(v6)
  if (prepare) {
    await v6.linkFullSyncBase(await module.buildOwnerWorkspaceFullSyncLinkRequest(TARGET, { id: 'full-lazy-link-0001',
      expected: await v6.readFullSyncState(ctx.guard), base: { pulledRevision: 0, records: [] }, minimumObservedRevision: 0, resolutions: [] }), ctx.guard)
    await v6.prepareFullSync(await module.buildOwnerWorkspaceFullSyncPrepareRequest(TARGET,
      { id: 'full-lazy-prepare-0001', expected: await v6.readFullSyncState(ctx.guard) }), ctx.guard)
  }
  return { ...current, v6 }
}

describe('private lazy full-profile commands', () => {
  it('does not import write commands for actual v3/v6 reads, format upgrades or complete recovery3 export/decode', async () => {
    const commands = vi.fn(() => { throw new Error('read-only work must not load full write commands') })
    vi.doMock(COMMANDS, commands)
    const current = await adopted()
    await buildOwnerWorkspaceBackup(await current.v3.readLocalState(current.ctx.guard))
    const v3 = await current.module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(v3)
    expect((await v3.readLocalState(current.ctx.guard)).fullSync).toBeUndefined()
    const full = await upgraded(current)
    const reopened = await full.module.openOwnerWorkspace(full.factory, TARGET, { existingOnly: true }); handles.push(reopened)
    const local = await reopened.readLocalState(full.ctx.guard)
    expect((await reopened.readFullSyncState(full.ctx.guard)).fullSync.base).toBeNull()
    expect(await reopened.fullSyncReceipt('full-lazy-missing-0001', '0'.repeat(64), full.ctx.guard)).toEqual({ state: 'unknown' })
    const recovery = await import('@/utils/owner-full-sync-recovery'), file = await recovery.buildOwnerFullSyncRecoveryBackup(TARGET, local)
    expect((await recovery.restoreOwnerFullSyncRecoveryBackup(file.raw, file.sha256)).local).toEqual(local)
    expect(commands).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled()
  })
  it('rejects a failed explicit command import with the exact prepared full image untouched and no transaction', async () => {
    const current = await upgraded(await adopted(), true), before = await image(current.factory)
    handles.splice(0).forEach(handle => handle.close()); vi.resetModules()
    vi.doMock(COMMANDS, () => { throw new Error('synthetic unavailable full commands') })
    const module = await import('./owner-workspace'), workspace = await module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(workspace)
    const expected = await workspace.readFullSyncState(current.ctx.guard), pending = expected.fullSync.pending!
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    await expect(workspace.transitionFullSyncDelivery({ expected, requestId: pending.requestId, requestHash: pending.requestHash,
      preparationHash: pending.preparationHash, nextState: 'attempted' }, current.ctx.guard)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(transaction).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled(); vi.restoreAllMocks()
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['timeout', 'revoke'] as const)('keeps a late full command module inside the original %s budget with zero late transactions', async reason => {
    const current = await upgraded(await adopted(), true), before = await image(current.factory)
    handles.splice(0).forEach(handle => handle.close()); vi.resetModules()
    const actualCommands = await vi.importActual<typeof import('./owner-workspace-full-sync-commands')>(COMMANDS)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), commands = vi.fn(async () => { await gate; return actualCommands })
    vi.doMock(COMMANDS, commands)
    const module = await import('./owner-workspace'), workspace = await module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(workspace)
    const expected = await workspace.readFullSyncState(current.ctx.guard), pending = expected.fullSync.pending!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const result = workspace.transitionFullSyncDelivery({ expected, requestId: pending.requestId, requestHash: pending.requestHash,
      preparationHash: pending.preparationHash, nextState: 'attempted' }, current.ctx.guard).then(() => 'unexpected', error => error.code)
    await drain(() => commands.mock.calls.length === 1); expect(commands).toHaveBeenCalledOnce()
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(12_001)
    else current.ctx.controller.abort()
    expect(await result).toBe(reason === 'timeout' ? 'workspace_timeout' : 'workspace_context_changed')
    expect(transaction).not.toHaveBeenCalled(); release(); await drain(); expect(transaction).not.toHaveBeenCalled()
    vi.restoreAllMocks(); vi.useRealTimers(); expect(await image(current.factory)).toEqual(before); expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('fixed profile shape codecs remain preloaded and capability-free', () => {
  it('does not load either portfolio codec for actual v3 or v4 use', async () => {
    const portfolio = vi.fn(() => { throw new Error('v3/v4 must not load portfolio codec') })
    const full = vi.fn(() => { throw new Error('v3/v4 must not load full codec') })
    vi.doMock(PORTFOLIO_CODEC, portfolio); vi.doMock(FULL_CODEC, full)
    const current = await adopted()
    const v4 = await current.module.upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.ctx.guard); handles.push(v4)
    expect((await v4.readLocalState(current.ctx.guard)).portfolio).toBeUndefined()
    const reopened = await current.module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(reopened)
    expect((await reopened.readSyncState(current.ctx.guard)).local.fullSync).toBeUndefined()
    expect(portfolio).not.toHaveBeenCalled(); expect(full).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled()
  })
  it('does not load the complete-profile codec for actual v5 upgrade, reopen or recovery2', async () => {
    const full = vi.fn(() => { throw new Error('v5 must not load full codec') })
    vi.doMock(FULL_CODEC, full)
    const current = await adopted(), { module, factory, ctx } = current
    const v4 = await module.upgradeOwnerWorkspaceSync(factory, TARGET, current.local, ctx.guard); handles.push(v4)
    const file = await module.buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(ctx.guard), { manualRaw: null, snapshotsRaw: null })
    const v5 = await module.upgradeOwnerWorkspacePortfolio(factory, TARGET, await module.buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
      { id: 'full-lazy-only-v5-0001', backupRaw: file.raw, backupSha256: file.sha256 }), ctx.guard); handles.push(v5)
    const reopened = await module.openOwnerWorkspace(factory, TARGET, { existingOnly: true }); handles.push(reopened)
    const recovery = await import('@/utils/owner-portfolio-recovery')
    const result = await recovery.buildOwnerPortfolioRecoveryBackup(TARGET, await reopened.readLocalState(ctx.guard))
    expect((await recovery.restoreOwnerPortfolioRecoveryBackup(result.raw, result.sha256)).local.fullSync).toBeUndefined()
    expect(full).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled()
  })
  it.each([PORTFOLIO_CODEC, FULL_CODEC])('rejects unavailable %s before opening any v6 read transaction or changing any stored row', async path => {
    const current = await upgraded(await adopted(), true), before = await image(current.factory)
    handles.splice(0).forEach(handle => handle.close()); vi.resetModules()
    const broken = vi.fn(() => { throw new Error('synthetic fixed profile code unavailable') })
    vi.doMock(path, broken)
    const module = await import('./owner-workspace'), transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    await expect(module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(broken).toHaveBeenCalledOnce(); expect(transaction).not.toHaveBeenCalled()
    vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before); expect(forbidden).not.toHaveBeenCalled()
  })
  it('keeps a late full shape-codec import inside the original open budget and ignores its late completion', async () => {
    const current = await upgraded(await adopted(), true), before = await image(current.factory)
    handles.splice(0).forEach(handle => handle.close()); vi.resetModules()
    const real = await vi.importActual<typeof import('./owner-workspace-full-sync-codec')>(FULL_CODEC)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), loading = vi.fn(async () => { await gate; return real })
    vi.doMock(FULL_CODEC, loading)
    const module = await import('./owner-workspace')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const result = module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }).then(() => 'unexpected', error => error.code)
    await drain(() => loading.mock.calls.length === 1); expect(loading).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(12_001)
    expect(await result).toBe('workspace_timeout'); expect(transaction).not.toHaveBeenCalled()
    release(); await drain(); expect(transaction).not.toHaveBeenCalled()
    vi.restoreAllMocks(); vi.useRealTimers(); expect(await image(current.factory)).toEqual(before)
  })
})
