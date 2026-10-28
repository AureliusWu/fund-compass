/** Real adopted-workspace primitives with synthetic records. fake-IDB does not
 * prove browser downloads, PWA replacement, cloud persistence or disaster restore.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore, forceCloseDatabase } from 'fake-indexeddb'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, reconcileOwnerWorkspacePortfolioUpgrade,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  buildOwnerWorkspacePrepareCloudRequest, type OwnerWorkspace, type OwnerWorkspaceGuard } from './owner-workspace'
import { buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  restoreOwnerWorkspacePortfolioUpgradeBackup,
  type OwnerWorkspacePortfolioUpgradeSource } from './owner-workspace-portfolio-upgrade'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { previewOwnerPortfolioMigration, applyOwnerPortfolioCommand } from '@/utils/ownerPortfolioLocal'
import { verifyOwnerPortfolioUpgradeIntent } from '@/utils/owner-portfolio-upgrade-intent'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'

const TARGET = '6'.repeat(64), KEY = '510300::升级合成账户', PORTFOLIO = 'portfolio_metadata'
const handles: OwnerWorkspace[] = []
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function context() {
  const controller = new AbortController()
  return { controller, guard: { signal: controller.signal, assertActive() {
    if (controller.signal.aborted) throw new Error('synthetic authority revoked')
  } } satisfies OwnerWorkspaceGuard }
}
function source(): OwnerWorkspacePortfolioUpgradeSource {
  return {
    manualRaw: canonicalOwnerLocal([{ id: 'synthetic-manual', name: '零值现金', cls: '现金', value: -0,
      updated_at: '2026-10-23T00:00:00Z' }]),
    snapshotsRaw: canonicalOwnerLocal([{ date: '2026-10-22', value: -0, cost: 0 },
      { date: '2026-10-22', value: 7, cost: 9, holdings: [] }]),
  }
}
function base(): OwnerSyncBaseline {
  return { pulledRevision: 9, records: [
    { key: KEY, kind: 'holding', deleted: false, record_revision: 9, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 9, cost: 2, target_weight: 2 },
      values: { name: '零份合成', shares: -0, cost: null, target_weight: 0 } },
    { key: 'asset:cloud-deleted', kind: 'manual_asset', deleted: true, record_revision: 8, lifecycle_revision: 8,
      field_revisions: { name: 1, cls: 1, value: 8, note: 1 }, values: { name: '已删除现金', cls: '现金', value: 0, note: null } },
  ] }
}
async function adoptedV4(linked = true) {
  const factory = new IDBFactory(), { guard, controller } = context(), v3 = await openOwnerWorkspace(factory, TARGET)
  handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'opaque preserved original',
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '零份合成', account: '升级合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-22T00:00:00Z' }]) }
  const original = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'portfolio-adopt-0001',
    expected: await v3.readLocalState(guard), sourceArchive, backupSha256: original.sha256 }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  if (linked) await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, {
    id: 'portfolio-link-0001', expected: await v4.readSyncState(guard), base: base(),
  }), guard)
  const expected = await v4.readLocalState(guard), rawSource = source()
  const backup = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, expected, rawSource)
  const request = await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, {
    id: 'portfolio-upgrade-0001', backupRaw: backup.raw, backupSha256: backup.sha256,
  })
  return { factory, v4, guard, controller, expected, rawSource, backup, request }
}
async function rawOpen(factory: IDBFactory, version?: number, change?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + TARGET, version)
    request.onupgradeneeded = () => change?.(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function image(factory: IDBFactory) {
  const db = await rawOpen(factory)
  try { return await new Promise<{ version: number; stores: Record<string, unknown[]> }>((resolve, reject) => {
    const stores: Record<string, unknown[]> = {}, names = [...db.objectStoreNames], tx = db.transaction(names)
    for (const name of names) {
      const request = tx.objectStore(name).getAll()
      request.onsuccess = () => { stores[name] = request.result }
    }
    tx.oncomplete = () => resolve({ version: db.version, stores }); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function mutate(factory: IDBFactory, store: string, value: unknown, key = 'current', remove = false) {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'), objectStore = tx.objectStore(store)
    if (remove) objectStore.delete(key); else objectStore.put(value, key)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function originalIntent(current: Awaited<ReturnType<typeof adoptedV4>>) {
  const portfolio = (await previewOwnerPortfolioMigration(current.rawSource)).portfolio!
  return verifyOwnerPortfolioUpgradeIntent({ schema: 'owner-portfolio-upgrade-intent-1', targetFingerprint: TARGET,
    id: current.request.id, hash: current.request.hash, backupSha256: current.request.backupSha256,
    sourceSha256: portfolio.migration.sourceSha256 }, TARGET, portfolio.migration.sourceSha256)
}
async function gap(current: Awaited<ReturnType<typeof adoptedV4>>) {
  const intent = await originalIntent(current)
  const db = await rawOpen(current.factory, 5, database => database.createObjectStore(PORTFOLIO).add(intent, 'intent')); db.close()
}
async function upgraded() {
  const current = await adoptedV4(), v5 = await upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard)
  handles.push(v5)
  return { ...current, v5, state: await v5.readLocalState(current.guard) }
}

describe('complete explicitly reselected portfolio-upgrade file', () => {
  it('binds the actual complete v4 recovery and both unfiltered source byte strings', async () => {
    const current = await adoptedV4(), { backup } = current
    expect(backup.sha256).toBe(hash(backup.raw)); expect(backup.byteLength).toBe(Buffer.byteLength(backup.raw))
    expect(backup.envelope).toMatchObject({ format: 'sinan-owner-portfolio-upgrade-1', targetFingerprint: TARGET,
      workspace: { physicalVersion: 4, local: current.expected }, source: current.rawSource })
    expect(Object.is(backup.envelope.workspace.local.snapshot.entries[0].values.shares, -0)).toBe(true)
    expect(backup.envelope.workspace.local.sync?.base).toEqual(base())
    expect(current.request).toEqual({ id: 'portfolio-upgrade-0001', hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      backupRaw: backup.raw, backupSha256: backup.sha256 })
    expect(Object.isFrozen(backup.envelope.source)).toBe(true)
  })
  it.each(['bad-json', 'duplicate-manual', 'invalid-history', 'oversize-legacy'] as const)
    ('exports original bad %s source without allowing a partial or empty migration', async fault => {
      const current = await adoptedV4(), rawSource = source()
      const bad = fault === 'bad-json' ? { ...rawSource, manualRaw: '{invalid original' }
        : fault === 'duplicate-manual' ? { ...rawSource, manualRaw: canonicalOwnerLocal([
          { id: 'same', name: 'A', cls: '现金', value: 0, updated_at: '2026-10-23T00:00:00Z' },
          { id: 'same', name: 'B', cls: '现金', value: 1, updated_at: '2026-10-23T00:00:00Z' }]) }
          : fault === 'invalid-history' ? { ...rawSource, snapshotsRaw: '[{"date":"2026-02-30","value":0,"cost":0}]' }
            : { ...rawSource, snapshotsRaw: ' '.repeat(2 * 1024 * 1024) }
      const backup = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, current.expected, bad)
      expect(backup.envelope.source).toEqual(bad)
      expect(await restoreOwnerWorkspacePortfolioUpgradeBackup(backup.raw, backup.sha256)).toEqual(backup.envelope)
      const before = await image(current.factory)
      await expect(buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'portfolio-invalid-0001',
        backupRaw: backup.raw, backupSha256: backup.sha256 })).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it('enforces the real complete 24 MiB UTF-8 file cap without dropping invalid source bytes', async () => {
    const current = await adoptedV4(), before = await image(current.factory)
    await expect(buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, current.expected,
      { manualRaw: 'x'.repeat(24 * 1024 * 1024), snapshotsRaw: null })).rejects.toMatchObject({ code: 'workspace_capacity' })
    await expect(buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, current.expected,
      { manualRaw: '\ud800', snapshotsRaw: null })).rejects.toMatchObject({ code: 'workspace_invalid_input' })
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['wrong-sha', 'whitespace', 'duplicate-key', 'wrong-target', 'extra-field', 'old-v3'] as const)
    ('rejects a non-original or unsupported complete file: %s', async fault => {
      const current = await adoptedV4(), parsed = JSON.parse(current.backup.raw)
      if (fault === 'wrong-target') parsed.targetFingerprint = '7'.repeat(64)
      if (fault === 'extra-field') parsed.credentials = 'not-a-token'
      if (fault === 'old-v3') { parsed.workspace.physicalVersion = 3; delete parsed.workspace.local.sync }
      let raw = ['wrong-sha', 'whitespace', 'duplicate-key'].includes(fault) ? current.backup.raw : canonicalOwnerLocal(parsed)
      if (fault === 'whitespace') raw += ' '
      if (fault === 'duplicate-key') raw = raw.replace('{', '{"format":"sinan-owner-portfolio-upgrade-1",')
      await expect(buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'portfolio-corrupt-0001',
        backupRaw: raw, backupSha256: fault === 'wrong-sha' ? '1'.repeat(64) : hash(raw) })).rejects.toBeInstanceOf(Error)
    })
  it('does no ambient storage/network IO and rejects source getters without invoking them', async () => {
    const current = await adoptedV4(), forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    const backup = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, current.expected, source())
    await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'portfolio-pure-0001', backupRaw: backup.raw, backupSha256: backup.sha256 })
    const getter = vi.fn()
    await expect(buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, current.expected,
      Object.defineProperty({ snapshotsRaw: null }, 'manualRaw', { enumerable: true, get: getter }) as OwnerWorkspacePortfolioUpgradeSource)).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('explicit physical-v4 -> v5 portfolio upgrade', () => {
  it('keeps ordinary v4 startup unchanged, then adds only the fixed target-bound portfolio row', async () => {
    const current = await adoptedV4(), before = await image(current.factory)
    const ordinary = await openOwnerWorkspace(current.factory, TARGET); handles.push(ordinary)
    expect(await image(current.factory)).toEqual(before); expect(before.version).toBe(4)
    const v5 = await upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard); handles.push(v5)
    const state = await v5.readLocalState(current.guard), after = await image(current.factory)
    const expectedPortfolio = (await previewOwnerPortfolioMigration(current.rawSource)).portfolio!
    expect(after.version).toBe(5); expect(Object.keys(after.stores).sort()).toEqual([...Object.keys(before.stores), PORTFOLIO].sort())
    for (const name of Object.keys(before.stores)) expect(after.stores[name]).toEqual(before.stores[name])
    const intent = await originalIntent(current)
    expect(after.stores[PORTFOLIO]).toEqual([{ schema: 'owner-workspace-portfolio-1', targetFingerprint: TARGET, portfolio: expectedPortfolio }, intent])
    expect(state).toEqual({ ...current.expected, portfolio: expectedPortfolio, portfolioUpgrade: intent })
    expect(state.sync?.base).toEqual(base()); expect(Object.is(state.portfolio!.manual[0].values.value, -0)).toBe(true)
    expect(state.portfolio!.manual[0].values.note).toBeNull()
    expect(state.portfolio!.history.map(item => item.value)).toEqual([-0, 7]) // duplicate legacy day is not silently folded
  })
  it.each(['relaxed', 'default', 'missing', 'throw'] as const)
    ('refuses %s durability before versionchange changes any old store', async durability => {
      const current = await adoptedV4(), before = await image(current.factory), actual = IDBDatabase.prototype.transaction
      vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
        const tx = actual.call(this, names, mode, options)
        if (mode === 'readwrite') Object.defineProperty(tx, 'durability', { configurable: true, get() {
          if (durability === 'throw') throw new Error('synthetic unsupported durability')
          return durability === 'missing' ? undefined : durability
        } })
        return tx
      })
      await expect(upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before)
    })
  it.each(['hash', 'backupRaw', 'id', 'extra'] as const)('rejects changed original request %s before opening a database', async fault => {
    const current = await adoptedV4(), request = { ...current.request } as Record<string, unknown>
    if (fault === 'hash') request.hash = '0'.repeat(64)
    if (fault === 'backupRaw') request.backupRaw = current.backup.raw + ' '
    if (fault === 'id') request.id = 'portfolio-different-0001'
    if (fault === 'extra') request.portfolio = {}
    const before = await image(current.factory), open = vi.spyOn(current.factory, 'open')
    await expect(upgradeOwnerWorkspacePortfolio(current.factory, TARGET, request as unknown as typeof current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(open).not.toHaveBeenCalled(); open.mockRestore(); expect(await image(current.factory)).toEqual(before)
  })
  it('rejects a changed complete v4 image and an actual prepared slot without changing either', async () => {
    const current = await adoptedV4(), previous = current.expected.snapshot.entries[0]
    const edited = await current.v4.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'portfolio-edit-0001', expected: current.expected,
      command: { type: 'save', input: { code: '510300', name: previous.values.name, account: '升级合成账户', position_kind: 'holding',
        shares: 7, cost: null, target_weight: 0 }, expectedEntry: previous, confirmed: true } }), current.guard)
    const editedImage = await image(current.factory)
    await expect(upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(editedImage)
    const prepared = await current.v4.prepareCloud(await buildOwnerWorkspacePrepareCloudRequest(TARGET,
      { id: 'portfolio-prepare-0001', expected: { local: edited, sync: edited.sync! } }), current.guard)
    const backup = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, prepared.local, current.rawSource)
    const pendingImage = await image(current.factory)
    await expect(buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'portfolio-pending-0001',
      backupRaw: backup.raw, backupSha256: backup.sha256 })).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(pendingImage)
  })
  it('does not create a missing database and does not let a revoked authority start an upgrade', async () => {
    const current = await adoptedV4(), missing = new IDBFactory()
    await expect(upgradeOwnerWorkspacePortfolio(missing, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await missing.databases()).toEqual([])
    const before = await image(current.factory); current.controller.abort()
    await expect(upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['initial-transaction', 'successful-add'] as const)
    ('leaves the v5 empty-current gap after %s abort, and normal open never repairs it', async point => {
      const current = await adoptedV4(), before = await image(current.factory), reached = vi.fn()
      if (point === 'initial-transaction') {
        const actual = IDBDatabase.prototype.transaction
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
          const tx = actual.call(this, names, mode, options)
          if (mode === 'readwrite' && Array.isArray(names) && names.includes(PORTFOLIO)) { reached(); tx.abort() }
          return tx
        })
      } else {
        const actual = IDBObjectStore.prototype.add
        vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
          const result = actual.call(this, value, key)
          if (this.name === PORTFOLIO && key === 'current') result.addEventListener('success', () => { reached(); this.transaction.abort() })
          return result
        })
      }
      await expect(upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      expect(reached).toHaveBeenCalledOnce(); vi.restoreAllMocks()
      const after = await image(current.factory)
      expect(after.version).toBe(5); expect(after.stores[PORTFOLIO]).toEqual([await originalIntent(current)])
      for (const name of Object.keys(before.stores)) expect(after.stores[name]).toEqual(before.stores[name])
      await expect(openOwnerWorkspace(current.factory, TARGET, { existingOnly: true })).rejects.toBeInstanceOf(Error)
      await expect(openOwnerWorkspace(current.factory, TARGET)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(after)
      const v5 = await reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, context().guard); handles.push(v5)
      expect((await v5.readLocalState(context().guard)).portfolio).toEqual((await previewOwnerPortfolioMigration(current.rawSource)).portfolio)
    })
  it('rolls back the versionchange itself when the original intent write loses authority', async () => {
    const current = await adoptedV4(), before = await image(current.factory), actual = IDBObjectStore.prototype.add
    const reached = vi.fn()
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === PORTFOLIO && key === 'intent') { reached(); current.controller.abort() }
      return request
    })
    await expect(upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(reached).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    expect(await image(current.factory)).toEqual(before)
  })
})

describe('manual exact completion of an interrupted portfolio upgrade', () => {
  it('initializes only missing current, and exact repeat only verifies the same original request/file', async () => {
    const current = await adoptedV4(); await gap(current)
    const before = await image(current.factory)
    const v5 = await reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard); handles.push(v5)
    const state = await v5.readLocalState(current.guard), after = await image(current.factory)
    expect(after).toEqual({ ...before, stores: { ...before.stores, [PORTFOLIO]: [{ schema: 'owner-workspace-portfolio-1',
      targetFingerprint: TARGET, portfolio: state.portfolio }, await originalIntent(current)] } })
    const repeat = await reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard); handles.push(repeat)
    expect(await repeat.readLocalState(current.guard)).toEqual(state); expect(await image(current.factory)).toEqual(after)
    await expect(upgradeOwnerWorkspacePortfolio(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(after)
  })
  it('never creates a missing database or retries the versionchange for an old v4', async () => {
    const current = await adoptedV4(), missing = new IDBFactory()
    await expect(reconcileOwnerWorkspacePortfolioUpgrade(missing, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await missing.databases()).toEqual([])
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it('rejects another valid request id even when it reselects the same original complete file', async () => {
    const current = await adoptedV4(); await gap(current)
    const other = await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'portfolio-other-id-0001',
      backupRaw: current.request.backupRaw, backupSha256: current.request.backupSha256 })
    expect(other.hash).not.toBe(current.request.hash)
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, other, current.guard))
      .rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    expect(await image(current.factory)).toEqual(before)
    const original = await reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard); handles.push(original)
    expect((await original.readLocalState(current.guard)).portfolioUpgrade!.id).toBe(current.request.id)
  })
  it('does not substitute an equivalent business source with different original raw bytes/file SHA', async () => {
    const current = await adoptedV4(); await gap(current)
    const anotherFile = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, current.expected,
      { ...current.rawSource, manualRaw: current.rawSource.manualRaw! + ' ' })
    const anotherRequest = await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: current.request.id,
      backupRaw: anotherFile.raw, backupSha256: anotherFile.sha256 })
    expect(anotherRequest.hash).not.toBe(current.request.hash)
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, anotherRequest, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['missing', 'schema', 'target', 'id', 'hash', 'backupSha256', 'sourceSha256', 'extra'] as const)
    ('rejects missing/corrupt persisted original intent: %s', async fault => {
      const current = await adoptedV4(); await gap(current)
      const intent: Record<string, unknown> = { ...await originalIntent(current) }
      if (fault === 'schema') intent.schema = 'other-schema'
      if (fault === 'target') intent.targetFingerprint = '9'.repeat(64)
      if (fault === 'id') intent.id = 'portfolio-wrong-id-0001'
      if (fault === 'hash') intent.hash = '9'.repeat(64)
      if (fault === 'backupSha256') intent.backupSha256 = '9'.repeat(64)
      if (fault === 'sourceSha256') intent.sourceSha256 = '9'.repeat(64)
      if (fault === 'extra') intent.other = true
      await mutate(current.factory, PORTFOLIO, intent, 'intent', fault === 'missing')
      const before = await image(current.factory)
      await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it.each(['missing-portfolio', 'missing-sync', 'extra-store', 'auto-increment', 'key-path', 'index'] as const)
    ('rejects unsupported physical-v5 layout without repairing it: %s', async fault => {
      const current = await adoptedV4(), intent = await originalIntent(current)
      const db = await rawOpen(current.factory, 5, database => {
        if (fault === 'missing-sync') database.deleteObjectStore('sync_metadata')
        if (fault === 'extra-store') database.createObjectStore('shadow')
        if (fault === 'missing-portfolio') return
        const store = database.createObjectStore(PORTFOLIO, fault === 'auto-increment' ? { autoIncrement: true }
          : fault === 'key-path' ? { keyPath: 'schema' } : undefined)
        if (fault === 'index') store.createIndex('shadow', 'id')
        if (fault === 'key-path') store.add(intent); else store.add(intent, 'intent')
      }); db.close()
      const before = await image(current.factory)
      await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it('rejects a forcibly closed initialization handle without treating closure as proof of rollback', async () => {
    const current = await adoptedV4(); await gap(current)
    const before = await image(current.factory), actual = IDBDatabase.prototype.transaction, reached = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite' && Array.isArray(names) && names.includes(PORTFOLIO)) {
        // fake-indexeddb 6.2.5 declares a constructor parameter, but its actual
        // forceCloseDatabase implementation accepts this database instance.
        // Reflect keeps this test-only third-party interop out of production.
        reached(); Reflect.apply(forceCloseDatabase, undefined, [this])
      }
      return tx
    })
    await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(reached).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    const after = await image(current.factory)
    for (const name of Object.keys(before.stores).filter(name => name !== PORTFOLIO)) expect(after.stores[name]).toEqual(before.stores[name])
    expect(after.stores[PORTFOLIO]).toContainEqual(await originalIntent(current))
    // Driver closure can arrive after commit. Only explicit same-file/original
    // intent verification may distinguish a missing current from the exact one.
    const checked = await reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard); handles.push(checked)
    expect((await checked.readLocalState(current.guard)).portfolioUpgrade).toEqual(await originalIntent(current))
  })
  it.each(['snapshot', 'metadata', 'slot', 'sync', 'receipt', 'shadow-current', 'wrong-target-row'] as const)
    ('refuses changed preimage or incomplete v5 structure: %s', async fault => {
      const current = await adoptedV4(); await gap(current)
      if (fault === 'snapshot') await mutate(current.factory, 'working_copy', { schema: 'owner-workspace-1', targetFingerprint: TARGET,
        snapshot: { ...current.expected.snapshot, entries: [] } })
      if (fault === 'metadata') await mutate(current.factory, 'local_metadata', { ...current.expected.metadata, displayTimes: [] })
      if (fault === 'slot') await mutate(current.factory, 'slot', { ...current.expected.outbox, resourceFingerprint: TARGET,
        version: current.expected.outbox.version + 1 })
      if (fault === 'sync') await mutate(current.factory, 'sync_metadata', { ...current.expected.sync, epoch: current.expected.sync!.epoch + 1 })
      if (fault === 'receipt') await mutate(current.factory, 'import_receipts', {}, 'unexpected')
      if (fault === 'shadow-current') await mutate(current.factory, PORTFOLIO, {}, 'unexpected')
      if (fault === 'wrong-target-row') await mutate(current.factory, PORTFOLIO, { schema: 'owner-workspace-portfolio-1',
        targetFingerprint: '7'.repeat(64), portfolio: (await previewOwnerPortfolioMigration(current.rawSource)).portfolio })
      const before = await image(current.factory)
      await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
      expect(await image(current.factory)).toEqual(before)
    })
  it('does not overwrite later genuine portfolio business changes with the original initial image', async () => {
    const current = await upgraded(), changed = applyOwnerPortfolioCommand(current.state.portfolio!, { type: 'save_manual',
      key: 'asset:synthetic-manual', values: { name: '明确更新后现金', cls: '现金', value: 77, note: null }, updated_at: '2026-10-23T01:00:00Z' }).portfolio
    current.v5.close()
    await mutate(current.factory, PORTFOLIO, { schema: 'owner-workspace-portfolio-1', targetFingerprint: TARGET, portfolio: changed })
    const before = await image(current.factory)
    await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
    const reopened = await openOwnerWorkspace(current.factory, TARGET, { existingOnly: true }); handles.push(reopened)
    expect((await reopened.readLocalState(current.guard)).portfolio).toEqual(changed)
  })
  it('aborts the actual strict add on authority revocation without rewriting any old row', async () => {
    const current = await adoptedV4(); await gap(current)
    const before = await image(current.factory), actual = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      const result = actual.apply(this, args)
      if (this.name === PORTFOLIO) current.controller.abort()
      return result
    })
    await expect(reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, current.guard)).rejects.toBeInstanceOf(Error)
    vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before)
    const v5 = await reconcileOwnerWorkspacePortfolioUpgrade(current.factory, TARGET, current.request, context().guard); handles.push(v5)
    expect((await v5.readLocalState(context().guard)).portfolio!.migration.manualRaw).toBe(current.rawSource.manualRaw)
  })
})
