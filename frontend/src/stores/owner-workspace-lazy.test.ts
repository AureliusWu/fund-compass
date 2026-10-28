/** Real codecs plus synthetic IDB: lazy code failure never changes authority/data. */
import { webcrypto } from 'node:crypto'
import { setImmediate } from 'node:timers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory } from 'fake-indexeddb'
import { buildOwnerLegacyWorkspaceBackup, buildOwnerWorkspaceBackup } from '@/utils/owner-workspace-backup'
import type { OwnerWorkspace, OwnerWorkspaceGuard } from './owner-workspace-types'

const CODEC = '@/utils/owner-workspace-sync-codec', COMMANDS = './owner-workspace-cloud'
const TARGET = 'e'.repeat(64), DB = 'fund-compass-owner-sync-outbox-1:' + TARGET
const handles: OwnerWorkspace[] = []
beforeEach(() => {
  vi.resetModules(); vi.doUnmock(CODEC); vi.doUnmock(COMMANDS)
  vi.stubGlobal('crypto', webcrypto)
  const forbidden = () => { throw new Error('ambient IO forbidden') }
  vi.stubGlobal('fetch', forbidden); vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden })
  vi.stubGlobal('indexedDB', { open: forbidden })
})
afterEach(() => {
  handles.splice(0).forEach(handle => handle.close())
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  vi.doUnmock(CODEC); vi.doUnmock(COMMANDS); vi.resetModules()
})
function context() {
  const controller = new AbortController()
  const guard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() {
    if (controller.signal.aborted) throw new Error('revoked')
  } }
  return { controller, guard }
}
async function drain(until: () => boolean = () => false) {
  for (let index = 0; index < 80 && !until(); index++) await new Promise<void>(resolve => setImmediate(resolve))
}
async function image(factory: IDBFactory) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<{ version: number; stores: Record<string, unknown[]> }>((resolve, reject) => {
      const names = [...db.objectStoreNames], tx = db.transaction(names), stores: Record<string, unknown[]> = {}
      for (const name of names) {
        const request = tx.objectStore(name).getAll()
        request.onsuccess = () => { stores[name] = request.result }
      }
      tx.oncomplete = () => resolve({ version: db.version, stores }); tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
async function adopted() {
  const module = await import('./owner-workspace'), factory = new IDBFactory(), ctx = context()
  const workspace = await module.openOwnerWorkspace(factory, TARGET); handles.push(workspace)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: null,
    v2Raw: JSON.stringify([{ code: '000001', name: 'synthetic', account: '', position_kind: 'holding',
      shares: 0, cost: null, target_weight: null, updated_at: '2026-10-22T00:00:00Z' }]) }
  const backup = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const request = await module.buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'lazy-local-adopt-0001',
    expected: await workspace.readLocalState(ctx.guard), sourceArchive, backupSha256: backup.sha256 })
  const local = await workspace.adoptLocal(request, ctx.guard)
  return { module, factory, ctx, workspace, local }
}
async function upgraded(prepared = false) {
  const current = await adopted()
  const workspace = await current.module.upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.ctx.guard)
  handles.push(workspace)
  const link = await current.module.buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'lazy-link-0001',
    expected: await workspace.readSyncState(current.ctx.guard), base: { pulledRevision: 0, records: [] } })
  await workspace.linkCloudBase(link, current.ctx.guard)
  if (prepared) {
    const request = await current.module.buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'lazy-prepare-0001',
      expected: await workspace.readSyncState(current.ctx.guard) })
    await workspace.prepareCloud(request, current.ctx.guard)
  }
  const local = await workspace.readLocalState(current.ctx.guard)
  workspace.close(); current.workspace.close()
  return { ...current, workspace, local }
}

describe('private lazy workspace code boundary', () => {
  it('fails command loading without changing a prepared v4 image', async () => {
    const current = await upgraded(true), before = await image(current.factory)
    vi.resetModules(); vi.doMock(COMMANDS, () => { throw new Error('private unavailable commands') })
    const module = await import('./owner-workspace')
    const workspace = await module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(workspace)
    const expected = await workspace.readSyncState(current.ctx.guard), pending = expected.sync.pending!
    await expect(workspace.transitionCloudDelivery({ expected, requestId: pending.requestId, requestHash: pending.requestHash,
      preparationHash: pending.preparationHash, nextState: 'attempted' }, current.ctx.guard)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(await image(current.factory)).toEqual(before)
  })

  it.each(['timeout', 'revoke'] as const)('keeps command loading inside the original handle %s window and starts no late transaction', async reason => {
    const current = await upgraded(true), before = await image(current.factory)
    vi.resetModules()
    const actualCommands = await vi.importActual(COMMANDS)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const commands = vi.fn(async () => { await gate; return actualCommands })
    vi.doMock(COMMANDS, commands)
    const module = await import('./owner-workspace')
    const workspace = await module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(workspace)
    const expected = await workspace.readSyncState(current.ctx.guard), pending = expected.sync.pending!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const result = workspace.transitionCloudDelivery({ expected, requestId: pending.requestId, requestHash: pending.requestHash,
      preparationHash: pending.preparationHash, nextState: 'attempted' }, current.ctx.guard).then(() => 'unexpected', error => error.code)
    await drain(() => commands.mock.calls.length === 1)
    expect(commands).toHaveBeenCalledOnce()
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(12_001)
    else current.ctx.controller.abort()
    expect(await result).toBe(reason === 'timeout' ? 'workspace_timeout' : 'workspace_context_changed')
    expect(transaction).not.toHaveBeenCalled()
    release(); await drain()
    expect(transaction).not.toHaveBeenCalled()
    vi.restoreAllMocks(); vi.useRealTimers()
    expect(await image(current.factory)).toEqual(before)
  })

  it('does not load codec or commands for v3 adopt/edit/backup/restore/reopen', async () => {
    const codec = vi.fn(() => { throw new Error('v3 must not load codec') })
    const commands = vi.fn(() => { throw new Error('v3 must not load commands') })
    vi.doMock(CODEC, codec); vi.doMock(COMMANDS, commands)
    const current = await adopted()
    const request = await current.module.buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'lazy-local-edit-0001', expected: current.local,
      command: { type: 'save', input: { code: '000001', name: 'synthetic', account: '', position_kind: 'holding',
        shares: 0, cost: 0, target_weight: null }, expectedEntry: current.local.snapshot.entries[0], confirmed: true } })
    const edited = await current.workspace.editLocal(request, current.ctx.guard)
    const backup = await buildOwnerWorkspaceBackup(edited)
    const restore = await current.module.buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'lazy-local-restore-0001',
      expected: edited, backup: backup.envelope })
    expect(await current.workspace.restoreLocal(restore, current.ctx.guard)).toEqual(edited)
    current.workspace.close()
    const reopened = await current.module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(reopened)
    expect(await reopened.readLocalState(current.ctx.guard)).toEqual(edited)
    expect(codec).not.toHaveBeenCalled(); expect(commands).not.toHaveBeenCalled()
  })

  it('loads the real codec once before any v4 read transaction, but not cloud commands even for pending hydration', async () => {
    const current = await upgraded(true), before = await image(current.factory)
    vi.resetModules()
    let ready = false
    const codec = vi.fn(async () => { const actual = await vi.importActual(CODEC); ready = true; return actual })
    const commands = vi.fn(() => { throw new Error('read must not load commands') })
    vi.doMock(CODEC, codec); vi.doMock(COMMANDS, commands)
    const actualTransaction = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      expect(ready).toBe(true)
      return actualTransaction.call(this, names, mode, options)
    })
    const module = await import('./owner-workspace')
    const one = await module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(one)
    const state = await one.readLocalState(current.ctx.guard)
    const two = await module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(two)
    expect(await two.readLocalState(current.ctx.guard)).toEqual(state)
    expect(state.outbox.entry?.rawBody).toBe(current.local.outbox.entry?.rawBody)
    expect(await image(current.factory)).toEqual(before)
    expect(codec).toHaveBeenCalledOnce(); expect(commands).not.toHaveBeenCalled()
  })

  it('loads commands only for an explicit cloud builder and retains the original packet workflow', async () => {
    const current = await upgraded()
    vi.resetModules()
    const commands = vi.fn(async () => vi.importActual(COMMANDS))
    vi.doMock(COMMANDS, commands)
    const module = await import('./owner-workspace')
    const workspace = await module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(workspace)
    expect(commands).not.toHaveBeenCalled()
    const request = await module.buildOwnerWorkspacePrepareCloudRequest(TARGET, { id: 'lazy-explicit-prepare-0001',
      expected: await workspace.readSyncState(current.ctx.guard) })
    const value = await workspace.prepareCloud(request, current.ctx.guard)
    expect(value.local.outbox.entry?.rawBody).toBe(request.packet.rawBody)
    expect(commands).toHaveBeenCalledOnce()
  })

  it('fails a v4 codec load without fallback, new stores or changes to the original database', async () => {
    const current = await upgraded(), before = await image(current.factory)
    vi.resetModules(); vi.doMock(CODEC, () => { throw new Error('private unavailable code module') })
    const module = await import('./owner-workspace')
    await expect(module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(await image(current.factory)).toEqual(before)
  })

  it('includes delayed v4 codec loading in the original open timeout and never starts a late transaction', async () => {
    const current = await upgraded(), before = await image(current.factory)
    vi.resetModules()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const codec = vi.fn(async () => { await gate; return vi.importActual(CODEC) })
    vi.doMock(CODEC, codec)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const module = await import('./owner-workspace')
    const result = module.openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }).then(handle => { handles.push(handle); return 'unexpected' }, error => error.code)
    await drain(() => codec.mock.calls.length === 1)
    expect(codec).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(12_001)
    expect(await result).toBe('workspace_timeout')
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    release(); await drain()
    expect(transaction).not.toHaveBeenCalled()
    vi.restoreAllMocks(); vi.useRealTimers()
    expect(await image(current.factory)).toEqual(before)
  })

  it('revokes a delayed explicit upgrade before any versionchange and ignores late commands', async () => {
    const current = await adopted(), before = await image(current.factory)
    current.workspace.close(); vi.resetModules()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const commands = vi.fn(async () => { await gate; return vi.importActual(COMMANDS) })
    vi.doMock(COMMANDS, commands)
    const module = await import('./owner-workspace')
    const result = module.upgradeOwnerWorkspaceSync(current.factory, TARGET, current.local, current.ctx.guard)
      .then(handle => { handles.push(handle); return 'unexpected' }, error => error.code)
    await drain(() => commands.mock.calls.length === 1)
    expect(commands).toHaveBeenCalledOnce()
    current.ctx.controller.abort()
    expect(await result).toBe('workspace_context_changed')
    release(); await drain()
    expect(await image(current.factory)).toEqual(before)
  })

  it('loads the real codec for async local builders with a complete v4 state, not a stripped v3 preimage', async () => {
    const current = await upgraded()
    vi.resetModules()
    const codec = vi.fn(async () => vi.importActual(CODEC))
    const commands = vi.fn(() => { throw new Error('local edit must not load cloud commands') })
    vi.doMock(CODEC, codec); vi.doMock(COMMANDS, commands)
    const module = await import('./owner-workspace')
    const request = await module.buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'lazy-v4-local-edit-0001', expected: current.local,
      command: { type: 'save', input: { code: '000001', name: 'synthetic', account: '', position_kind: 'holding',
        shares: 0, cost: 1, target_weight: null }, expectedEntry: current.local.snapshot.entries[0], confirmed: true } })
    expect(request.expected.sync).toEqual(current.local.sync)
    expect(codec).toHaveBeenCalledOnce(); expect(commands).not.toHaveBeenCalled()
  })
})
