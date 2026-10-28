/** Real public core upgrade wrappers plus fake-IDB. This is local contract
 * evidence, not Chrome/PWA, disaster restore, cloud durability or deployment. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio,
  upgradeOwnerWorkspaceFullSync, reconcileOwnerWorkspaceFullSyncUpgrade,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditPortfolioRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard,
} from './owner-workspace'
import { buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest } from './owner-workspace-portfolio-upgrade'
import { buildOwnerWorkspaceFullSyncUpgradeRequest } from './owner-workspace-full-sync-upgrade'
import { buildOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { emptyOwnerPortfolioSyncMetadata } from '@/utils/owner-portfolio-sync'
import { verifyOwnerPortfolioSyncUpgradeIntent } from '@/utils/owner-portfolio-sync-intent'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'

const TARGET = '6'.repeat(64), KEY = '510300::完整同步合成账户', FULL_SYNC = 'portfolio_sync_metadata', PORTFOLIO = 'portfolio_metadata'
const handles: OwnerWorkspace[] = []
const hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function context() {
  const controller = new AbortController()
  return { controller, guard: { signal: controller.signal, assertActive() {
    if (controller.signal.aborted) throw new Error('synthetic authority revoked')
  } } satisfies OwnerWorkspaceGuard }
}
async function fixture() {
  const factory = new IDBFactory(), { guard, controller } = context(), v3 = await openOwnerWorkspace(factory, TARGET)
  handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'original opaque archive',
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '合成零份', account: '完整同步合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-24T00:00:00Z' }]) }
  const original = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'fullsync-adopt-0001',
    expected: await v3.readLocalState(guard), sourceArchive, backupSha256: original.sha256 }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'fullsync-old-link-0001',
    expected: await v4.readSyncState(guard), base: { pulledRevision: 3, records: [
      { key: KEY, kind: 'holding', deleted: false, record_revision: 3, lifecycle_revision: 1,
        field_revisions: { name: 1, shares: 3, cost: 1, target_weight: 1 },
        values: { name: '合成零份', shares: -0, cost: null, target_weight: 0 } },
      { key: 'asset:old-cloud-tombstone', kind: 'manual_asset', deleted: true, record_revision: 2, lifecycle_revision: 2,
        field_revisions: { name: 1, cls: 1, value: 2, note: 1 }, values: { name: '旧云墓碑', cls: '现金', value: 0, note: null } },
    ] } }), guard)
  const source = { manualRaw: canonicalOwnerLocal([{ id: 'local-cash', name: '合成现金', cls: '现金', value: -0,
    updated_at: '2026-10-24T00:00:00Z' }]), snapshotsRaw: canonicalOwnerLocal([
    { date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 },
  ]) }
  const portfolioFile = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), source)
  const portfolioRequest = await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'fullsync-portfolio-0001',
    backupRaw: portfolioFile.raw, backupSha256: portfolioFile.sha256 })
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, portfolioRequest, guard); handles.push(v5)
  const state = await v5.readLocalState(guard), backup = await buildOwnerPortfolioRecoveryBackup(TARGET, state)
  const request = await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET, { id: 'fullsync-upgrade-0001', backupRaw: backup.raw, backupSha256: backup.sha256 })
  return { factory, controller, guard, v5, state, backup, request }
}
async function rawOpen(factory: IDBFactory, version?: number, change?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET, version)
    request.onupgradeneeded = () => change?.(request.result)
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
async function mutate(factory: IDBFactory, storeName: string, value: unknown, key = 'current', remove = false) {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName)
    if (remove) store.delete(key); else store.put(value, key)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function intent(current: Awaited<ReturnType<typeof fixture>>) {
  return verifyOwnerPortfolioSyncUpgradeIntent({ schema: 'owner-portfolio-sync-upgrade-1', targetFingerprint: TARGET,
    id: current.request.id, hash: current.request.hash, backupSha256: current.request.backupSha256 }, TARGET)
}
async function gap(current: Awaited<ReturnType<typeof fixture>>) {
  const original = await intent(current)
  const db = await rawOpen(current.factory, 6, database => database.createObjectStore(FULL_SYNC).add(original, 'intent')); db.close()
}

describe('explicit physical-v5 to v6 full-profile upgrade', () => {
  it('binds the exact recovery2 file in the fixed new intent hash domain and takes a primitive input copy before await', async () => {
    const current = await fixture()
    expect(current.request.hash).toBe(hash(canonicalOwnerLocal({ operation: 'portfolio-sync-upgrade-1', target: TARGET,
      id: current.request.id, backupSha256: current.backup.sha256 })))
    expect(current.request.backupRaw).toBe(current.backup.raw); expect(Object.isFrozen(current.request)).toBe(true)
    const source = { id: 'fullsync-captured-0001', backupRaw: current.backup.raw, backupSha256: current.backup.sha256 }
    const pending = buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET, source)
    source.id = 'changed-after-await-0001'; source.backupRaw = '{}'
    expect((await pending).id).toBe('fullsync-captured-0001')
  })
  it('keeps ordinary v5 unchanged and adds exactly intent/current without changing any of the original six stores', async () => {
    const current = await fixture(), before = await image(current.factory)
    const ordinary = await openOwnerWorkspace(current.factory, TARGET); handles.push(ordinary)
    expect(await image(current.factory)).toEqual(before); expect(before.version).toBe(5)
    const v6 = await upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard); handles.push(v6)
    const state = await v6.readLocalState(current.guard), after = await image(current.factory)
    expect(after.version).toBe(6); expect(Object.keys(after.stores).sort()).toEqual([...Object.keys(before.stores), FULL_SYNC].sort())
    for (const name of Object.keys(before.stores)) expect(after.stores[name]).toEqual(before.stores[name])
    expect(state).toEqual({ ...current.state, fullSync: emptyOwnerPortfolioSyncMetadata(TARGET), fullSyncUpgrade: await intent(current) })
    expect(after.stores[FULL_SYNC]).toEqual([emptyOwnerPortfolioSyncMetadata(TARGET), await intent(current)])
    expect(state.fullSync!.base).toBeNull(); expect(state.sync!.base).toEqual(current.state.sync!.base)
    expect(Object.is(state.portfolio!.manual[0].values.value, -0)).toBe(true)
    const reopened = await openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(reopened)
    expect(await reopened.readLocalState(current.guard)).toEqual(state)
  })
  it.each(['relaxed', 'default', 'missing', 'throw'] as const)('refuses %s durability before any versionchange', async durability => {
    const current = await fixture(), before = await image(current.factory), actual = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite') Object.defineProperty(tx, 'durability', { configurable: true, get() {
        if (durability === 'throw') throw new Error('unsupported durability')
        return durability === 'missing' ? undefined : durability
      } })
      return tx
    })
    await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before)
  })
  it.each(['portfolio', 'portfolio-intent'] as const)('rechecks %s in the strict initialization transaction instead of reading only the old five stores', async kind => {
    const current = await fixture(), before = await image(current.factory), actual = IDBObjectStore.prototype.get
    let injected = false
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      if (!injected && this.name === FULL_SYNC && key === 'current' && this.transaction.mode === 'readwrite') {
        injected = true
        const store = this.transaction.objectStore(PORTFOLIO)
        if (kind === 'portfolio') store.put({ schema: 'owner-workspace-portfolio-1', targetFingerprint: TARGET,
          portfolio: { ...current.state.portfolio!, manual: current.state.portfolio!.manual.map(row => ({ ...row, values: { ...row.values, value: 7 } })) } }, 'current')
        else store.put({ ...current.state.portfolioUpgrade!, id: 'changed-portfolio-intent-0001' }, 'intent')
      }
      return actual.call(this, key)
    })
    await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(injected).toBe(true); vi.restoreAllMocks()
    const after = await image(current.factory)
    expect(after.version).toBe(6); expect(after.stores[FULL_SYNC]).toEqual([await intent(current)])
    for (const name of Object.keys(before.stores)) expect(after.stores[name]).toEqual(before.stores[name])
  })
  it('rejects a later real portfolio edit against the original full file without promoting or overwriting it', async () => {
    const current = await fixture()
    await current.v5.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullsync-later-edit-0001', expected: current.state,
      command: { type: 'save_manual', key: 'asset:local-cash', updated_at: '2026-10-25T00:00:00Z',
        values: { name: 'later edit', cls: '商品', value: 19, note: '' } } }), current.guard)
    const before = await image(current.factory)
    await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before); expect(before.version).toBe(5)
  })
  it('keeps original storage untouched when authority is already revoked', async () => {
    const current = await fixture(), before = await image(current.factory)
    current.controller.abort()
    await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['initial-transaction', 'successful-add', 'late-durability'] as const)
    ('leaves only the intent gap after %s fails, and ordinary startup never repairs it', async fault => {
      const current = await fixture(), before = await image(current.factory), reached = vi.fn()
      if (fault === 'successful-add') {
        const actual = IDBObjectStore.prototype.add
        vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
          const request = actual.call(this, value, key)
          if (this.name === FULL_SYNC && key === 'current') request.addEventListener('success', () => { reached(); this.transaction.abort() })
          return request
        })
      } else {
        const actual = IDBDatabase.prototype.transaction
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
          const tx = actual.call(this, names, mode, options)
          if (mode === 'readwrite' && Array.isArray(names) && names.includes(FULL_SYNC)) {
            reached()
            if (fault === 'initial-transaction') tx.abort()
            else Object.defineProperty(tx, 'durability', { value: 'relaxed' })
          }
          return tx
        })
      }
      await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      expect(reached).toHaveBeenCalledOnce(); vi.restoreAllMocks()
      const after = await image(current.factory)
      expect(after.version).toBe(6); expect(after.stores[FULL_SYNC]).toEqual([await intent(current)])
      for (const name of Object.keys(before.stores)) expect(after.stores[name]).toEqual(before.stores[name])
      await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toBeInstanceOf(Error)
      await expect(openOwnerWorkspace(current.factory, TARGET)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(after)
      const v6 = await reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, context().guard); handles.push(v6)
      expect((await v6.readLocalState(context().guard)).fullSync).toEqual(emptyOwnerPortfolioSyncMetadata(TARGET))
    })
  it('rolls back the versionchange itself when writing the original intent loses authority', async () => {
    const current = await fixture(), before = await image(current.factory), actual = IDBObjectStore.prototype.add, reached = vi.fn()
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === FULL_SYNC && key === 'intent') { reached(); current.controller.abort() }
      return request
    })
    await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(reached).toHaveBeenCalledOnce(); vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before)
  })
  it('keeps the committed initial current after response loss and only reconciles its original request', async () => {
    const current = await fixture(), actual = IDBObjectStore.prototype.add, reached = vi.fn()
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === FULL_SYNC && key === 'current') this.transaction.addEventListener('complete', () => { reached(); current.controller.abort() })
      return request
    })
    await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(reached).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    const after = await image(current.factory)
    expect(after.stores[FULL_SYNC]).toEqual([emptyOwnerPortfolioSyncMetadata(TARGET), await intent(current)])
    const v6 = await reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, context().guard); handles.push(v6)
    expect(await image(current.factory)).toEqual(after)
  })
  it.each(['wrong-hash', 'wrong-sha', 'whitespace', 'duplicate-key', 'wrong-target', 'extra-field', 'old-version'] as const)
    ('rejects non-original or unsupported upgrade input: %s', async fault => {
      const current = await fixture(), before = await image(current.factory)
      const input = { ...current.request }, parsed = JSON.parse(input.backupRaw)
      if (fault === 'wrong-hash') input.hash = '1'.repeat(64)
      else if (fault === 'wrong-sha') input.backupSha256 = '1'.repeat(64)
      else {
        if (fault === 'wrong-target') parsed.targetFingerprint = '7'.repeat(64)
        if (fault === 'extra-field') parsed.private = 'not-a-token'
        if (fault === 'old-version') parsed.physicalVersion = 4
        input.backupRaw = fault === 'whitespace' ? input.backupRaw + ' '
          : fault === 'duplicate-key' ? input.backupRaw.replace('{', '{"physicalVersion":5,') : canonicalOwnerLocal(parsed)
        input.backupSha256 = hash(input.backupRaw)
      }
      await expect(upgradeOwnerWorkspaceFullSync(current.factory, TARGET, input, current.guard)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it('rejects unsafe request getters and oversized/illformed bytes without IO or getter invocation', async () => {
    const current = await fixture(), getter = vi.fn()
    await expect(buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET, Object.defineProperty({ ...current.request }, 'id', { enumerable: true, get: getter }) as any)).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled()
    for (const raw of ['\ud800', 'x'.repeat(24 * 1024 * 1024 + 1)]) {
      await expect(buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET, { id: 'fullsync-bad-0001', backupRaw: raw, backupSha256: 'a'.repeat(64) })).rejects.toBeInstanceOf(Error)
    }
  })
})

describe('narrow interrupted v6 initialization reconciliation', () => {
  it('requires manual reconciliation of the real intent-only gap, then accepts exactly the initial current without further writes', async () => {
    const current = await fixture(), before = await image(current.factory)
    await gap(current)
    await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toBeInstanceOf(Error)
    const v6 = await reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, current.guard); handles.push(v6)
    expect(await v6.readLocalState(current.guard)).toEqual({ ...current.state, fullSync: emptyOwnerPortfolioSyncMetadata(TARGET), fullSyncUpgrade: await intent(current) })
    const initialized = await image(current.factory)
    for (const name of Object.keys(before.stores)) expect(initialized.stores[name]).toEqual(before.stores[name])
    const again = await reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, current.guard); handles.push(again)
    expect(await image(current.factory)).toEqual(initialized)
  })
  it('does not create a missing database or upgrade the original v5 while reconciling', async () => {
    const current = await fixture(), missing = new IDBFactory(), before = await image(current.factory)
    await expect(reconcileOwnerWorkspaceFullSyncUpgrade(missing, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await missing.databases()).toEqual([])
    await expect(reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it('does not accept another valid id even for the very same original complete file', async () => {
    const current = await fixture(); await gap(current)
    const other = await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET, { id: 'fullsync-another-valid-0001',
      backupRaw: current.backup.raw, backupSha256: current.backup.sha256 })
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, other, current.guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['missing-store', 'extra-store', 'key-path', 'auto-increment', 'index'] as const)
    ('rejects unsupported v6 %s inventory without repairing it', async fault => {
      const current = await fixture(), original = await intent(current)
      const db = await rawOpen(current.factory, 6, database => {
        if (fault !== 'missing-store') {
          const store = database.createObjectStore(FULL_SYNC, fault === 'key-path' ? { keyPath: 'id' }
            : fault === 'auto-increment' ? { autoIncrement: true } : undefined)
          if (fault === 'key-path') store.add(original); else store.add(original, 'intent')
          if (fault === 'index') store.createIndex('unexpected', 'hash')
        }
        if (fault === 'extra-store') database.createObjectStore('unexpected')
      }); db.close()
      const before = await image(current.factory)
      await expect(reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it.each(['missing-intent', 'changed-intent', 'extra-row', 'extra-original-row', 'changed-current'] as const)
    ('rejects %s and never repairs or replaces it', async fault => {
      const current = await fixture(); await gap(current)
      if (fault === 'missing-intent') await mutate(current.factory, FULL_SYNC, null, 'intent', true)
      if (fault === 'changed-intent') await mutate(current.factory, FULL_SYNC, { ...await intent(current), id: 'another-upgrade-0001' }, 'intent')
      if (fault === 'extra-row') await mutate(current.factory, FULL_SYNC, true, 'extra')
      if (fault === 'extra-original-row') await mutate(current.factory, PORTFOLIO, true, 'extra')
      if (fault === 'changed-current') await mutate(current.factory, FULL_SYNC, { ...emptyOwnerPortfolioSyncMetadata(TARGET), epoch: 1 })
      const before = await image(current.factory)
      await expect(reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it('refuses any later valid v6 edit rather than overwriting it with the original v5 file', async () => {
    const current = await fixture(), v6 = await upgradeOwnerWorkspaceFullSync(current.factory, TARGET, current.request, current.guard); handles.push(v6)
    const state = await v6.readLocalState(current.guard)
    await v6.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'fullsync-after-upgrade-edit', expected: state,
      command: { type: 'save_manual', key: 'asset:local-cash', updated_at: '2026-10-25T00:00:00Z',
        values: { name: 'newer image', cls: '现金', value: 9, note: null } } }), current.guard)
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspaceFullSyncUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
})
