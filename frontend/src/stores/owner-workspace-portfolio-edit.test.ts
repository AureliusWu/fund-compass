/** Actual v5 IDB writers and receipts, with synthetic private business data.
 * No browser/PWA, cloud confirmation or full disaster-recovery claim.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceEditLocalRequest, buildOwnerWorkspaceEditPortfolioRequest,
  buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceLocalState } from './owner-workspace'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from './ownerSyncOutbox'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { type OwnerPortfolioCommand, type OwnerPortfolioObservation } from '@/utils/ownerPortfolioLocal'

const TARGET = '4'.repeat(64), KEY = '510300::组合合成账户', ASSET = 'asset:synthetic-cash'
const handles: OwnerWorkspace[] = []
const hash = (value: unknown) => createHash('sha256').update(canonicalOwnerLocal(value)).digest('hex')
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function context() {
  const controller = new AbortController()
  return { controller, guard: { signal: controller.signal, assertActive() {
    if (controller.signal.aborted) throw new Error('synthetic authority revoked')
  } } satisfies OwnerWorkspaceGuard }
}
async function adoptedV5(manualCount = 1) {
  const factory = new IDBFactory(), { controller, guard } = context(), v3 = await openOwnerWorkspace(factory, TARGET)
  handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'opaque untouched original',
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '零份合成持仓', account: '组合合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-23T00:00:00Z' }]) }
  const original = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const local = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'portfolio-edit-adopt-0001',
    expected: await v3.readLocalState(guard), sourceArchive, backupSha256: original.sha256 }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, local, guard); handles.push(v4)
  const manualRaw = canonicalOwnerLocal(Array.from({ length: manualCount }, (_, index) => ({
    id: index ? 'synthetic-' + index : 'synthetic-cash', name: '合成现金 ' + index, cls: '现金', value: -0,
    updated_at: '2026-10-23T00:00:00Z',
  })))
  const backup = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), {
    manualRaw, snapshotsRaw: '[{"date":"2026-10-22","value":0,"cost":0}]',
  })
  const request = await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'portfolio-edit-upgrade-0001',
    backupRaw: backup.raw, backupSha256: backup.sha256 })
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, request, guard); handles.push(v5)
  return { factory, controller, guard, v5, state: await v5.readLocalState(guard) }
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
    const result: Record<string, unknown[]> = {}, names = [...db.objectStoreNames], tx = db.transaction(names)
    for (const name of names) { const read = tx.objectStore(name).getAll(); read.onsuccess = () => { result[name] = read.result } }
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
async function mutate(factory: IDBFactory, store: string, value: unknown, key = 'current') {
  const db = await rawOpen(factory)
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  }) } finally { db.close() }
}
function save(value = 7, updated_at = '2026-10-23T01:00:00Z'): Extract<OwnerPortfolioCommand, { type: 'save_manual' }> {
  return { type: 'save_manual', key: ASSET, values: { name: '合成现金 0', cls: '现金', value, note: null }, updated_at }
}
async function portfolioRequest(state: OwnerWorkspaceLocalState, id = 'portfolio-save-0001', command: OwnerPortfolioCommand = save()) {
  return buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id, expected: state, command })
}
async function fundRequest(state: OwnerWorkspaceLocalState, id = 'portfolio-fund-0001', shares: number | null = 9) {
  return buildOwnerWorkspaceEditLocalRequest(TARGET, { id, expected: state, command: { type: 'save', expectedEntry: state.snapshot.entries[0],
    input: { code: '510300', name: '零份合成持仓', account: '组合合成账户', position_kind: 'holding', shares,
      cost: null, target_weight: 0 }, confirmed: true } })
}
function observation(): OwnerPortfolioObservation {
  return { id: 'portfolio-observation-0001', kind: 'observation', observed_at: '2026-10-24T16:01:00Z', date: '2026-10-25',
    calendar: 'Asia/Shanghai', value: 0, cost: null, holdings: [
      { kind: 'fund', key: KEY, name: '零份合成持仓', type: '混合', value: 0, cost: null },
      { kind: 'manual', key: ASSET, name: '合成现金 0', cls: '现金', value: 0, cost: null },
    ] }
}

describe('actual physical-v5 portfolio and fund writer authority', () => {
  it('atomically advances the one global localVersion/slot and exact recent receipt while retaining other complete data', async () => {
    const current = await adoptedV5(), before = current.state, request = await portfolioRequest(before)
    const state = await current.v5.editPortfolio(request, current.guard)
    expect(state.snapshot.localVersion).toBe(before.snapshot.localVersion + 1)
    expect(state.outbox).toEqual({ version: before.outbox.version + 1, entry: null })
    expect(state.snapshot.entries).toEqual(before.snapshot.entries); expect(Object.is(state.snapshot.entries[0].values.shares, -0)).toBe(true)
    expect(state.metadata).toEqual({ ...before.metadata, recentEdit: { id: request.id, hash: request.hash,
      beforeLocalVersion: before.snapshot.localVersion, localVersion: state.snapshot.localVersion, outboxVersion: state.outbox.version } })
    expect(state.sync).toEqual(before.sync); expect(state.portfolioUpgrade).toEqual(before.portfolioUpgrade)
    expect(state.portfolio!.migration).toEqual(before.portfolio!.migration); expect(state.portfolio!.history).toEqual(before.portfolio!.history)
    expect(state.portfolio!.manual[0]).toMatchObject({ key: ASSET, legacyId: 'synthetic-cash', deleted: false,
      local_pending: true, values: { value: 7, note: null }, updated_at: '2026-10-23T01:00:00Z' })
    expect(await current.v5.localReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
    const reopened = await reopen(current.factory)
    expect(await reopened.readLocalState(current.guard)).toEqual(state)
    expect(await reopened.localReceipt(request.id, request.hash, current.guard)).toEqual({ state: 'matched', value: state })
  })
  it('serializes fund and portfolio requests made from the same complete image; exactly one can win', async () => {
    const current = await adoptedV5(), other = await reopen(current.factory), before = current.state
    const [fund, portfolio] = await Promise.all([fundRequest(before), portfolioRequest(before)])
    const outcomes = await Promise.allSettled([current.v5.editLocal(fund, current.guard), other.editPortfolio(portfolio, current.guard)])
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
    const state = await (await reopen(current.factory)).readLocalState(current.guard)
    expect(state.snapshot.localVersion).toBe(before.snapshot.localVersion + 1); expect(state.outbox.version).toBe(before.outbox.version + 1)
    const wonFund = outcomes[0].status === 'fulfilled'
    expect(state.metadata.recentEdit).toMatchObject(wonFund ? { id: fund.id, hash: fund.hash } : { id: portfolio.id, hash: portfolio.hash })
    if (wonFund) { expect(state.portfolio).toEqual(before.portfolio); expect(state.snapshot.entries[0].values.shares).toBe(9) }
    else { expect(state.snapshot.entries).toEqual(before.snapshot.entries); expect(state.portfolio!.manual[0].values.value).toBe(7) }
    expect(state.sync).toEqual(before.sync); expect(state.portfolioUpgrade).toEqual(before.portfolioUpgrade)
  })
  it('rejects a stale fund request after a portfolio edit, and a stale portfolio request after a fund edit', async () => {
    const one = await adoptedV5(), fund = await fundRequest(one.state)
    await one.v5.editPortfolio(await portfolioRequest(one.state), one.guard)
    const afterPortfolio = await image(one.factory)
    await expect((await reopen(one.factory)).editLocal(fund, one.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(one.factory)).toEqual(afterPortfolio)
    const two = await adoptedV5(), portfolio = await portfolioRequest(two.state)
    await two.v5.editLocal(await fundRequest(two.state), two.guard)
    const afterFund = await image(two.factory)
    await expect((await reopen(two.factory)).editPortfolio(portfolio, two.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(two.factory)).toEqual(afterFund)
  })
  it('keeps tombstones and original values, and never resurrects a deleted manual key', async () => {
    const current = await adoptedV5(), before = current.state
    const remove = await portfolioRequest(before, 'portfolio-remove-0001', { type: 'remove_manual', key: ASSET, updated_at: '2026-10-23T02:00:00Z' })
    const state = await current.v5.editPortfolio(remove, current.guard)
    expect(state.portfolio!.manual).toHaveLength(1)
    expect(state.portfolio!.manual[0]).toEqual({ ...before.portfolio!.manual[0], deleted: true, updated_at: '2026-10-23T02:00:00Z' })
    const physical = await image(current.factory)
    await expect(portfolioRequest(state, 'portfolio-resurrection-0001', save(1, '2026-10-23T03:00:00Z'))).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(physical)
  })
  it('preserves incomplete cost as null and appends the Shanghai-date observation without replacing legacy history', async () => {
    const current = await adoptedV5(), item = observation()
    const request = await portfolioRequest(current.state, 'portfolio-history-0001', { type: 'append_observation', observation: item })
    const state = await current.v5.editPortfolio(request, current.guard)
    expect(state.portfolio!.history).toEqual([...current.state.portfolio!.history, item])
    expect(state.portfolio!.history.at(-1)).toMatchObject({ date: '2026-10-25', value: 0, cost: null, calendar: 'Asia/Shanghai' })
    expect(state.portfolio!.migration).toEqual(current.state.portfolio!.migration)
    const before = await image(current.factory)
    await expect(portfolioRequest(state, 'portfolio-history-duplicate', { type: 'append_observation', observation: item })).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it('leaves an exact business/time no-op unchanged, but records a genuinely new updated_at', async () => {
    const current = await adoptedV5(), before = current.state, physical = await image(current.factory)
    const noop = await portfolioRequest(before, 'portfolio-noop-0001', save(-0, '2026-10-23T00:00:00Z'))
    expect(await current.v5.editPortfolio(noop, current.guard)).toEqual(before)
    expect(await image(current.factory)).toEqual(physical)
    const changed = await current.v5.editPortfolio(await portfolioRequest(before, 'portfolio-timestamp-0001', save(-0)), current.guard)
    expect(changed.snapshot.localVersion).toBe(before.snapshot.localVersion + 1)
    expect(changed.portfolio!.manual[0].updated_at).toBe('2026-10-23T01:00:00Z')
  })
  it('does not drop existing records when a real 2000-manual portfolio cannot accept another row', async () => {
    const current = await adoptedV5(2000), before = await image(current.factory)
    expect(current.state.portfolio!.manual).toHaveLength(2000)
    await expect(portfolioRequest(current.state, 'portfolio-capacity-0001', { ...save(), key: 'asset:overflow' })).rejects.toBeInstanceOf(Error)
    expect(await image(current.factory)).toEqual(before)
  })
  it.each(['hash', 'extra-field', 'getter'] as const)('rejects a changed %s command envelope without a business write', async fault => {
    const current = await adoptedV5(), request = await portfolioRequest(current.state), before = await image(current.factory)
    const getter = vi.fn(), changed = fault === 'getter'
      ? Object.defineProperty({ ...request }, 'command', { enumerable: true, get: getter })
      : { ...request, ...(fault === 'hash' ? { hash: '1'.repeat(64) } : { extra: true }) }
    await expect(current.v5.editPortfolio(changed, current.guard)).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled(); expect(await image(current.factory)).toEqual(before)
  })
  it('rejects stale complete portfolio and immutable upgrade preimages, including a fresh handle', async () => {
    const current = await adoptedV5(), original = await portfolioRequest(current.state), intent = current.state.portfolioUpgrade!
    const otherId = 'portfolio-external-intent-0001', changedIntent = { ...intent, id: otherId,
      hash: hash({ operation: 'portfolio-upgrade-1', target: TARGET, id: otherId, backupSha256: intent.backupSha256 }) }
    // Controlled raw test fixture mutation is not an application capability or
    // a claim that hashes authenticate arbitrary same-origin JS.
    await mutate(current.factory, 'portfolio_metadata', changedIntent, 'intent')
    const before = await image(current.factory)
    await expect(current.v5.editPortfolio(original, current.guard)).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    const fresh = await reopen(current.factory)
    await expect(fresh.editPortfolio(original, current.guard)).rejects.toMatchObject({ code: 'workspace_conflict' })
    expect(await image(current.factory)).toEqual(before)
  })
  it('cannot use the old fund-only cloud planner on a v5 portfolio and cannot produce an upload as an edit side effect', async () => {
    const current = await adoptedV5(), forbidden = vi.fn(() => { throw new Error('network forbidden') })
    vi.stubGlobal('fetch', forbidden)
    await expect(current.v5.readSyncState(current.guard)).rejects.toBeInstanceOf(Error)
    const state = await current.v5.editPortfolio(await portfolioRequest(current.state), current.guard)
    expect(state.outbox.entry).toBeNull(); expect(state.sync).toEqual(current.state.sync); expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('v5 local mutation uncertainty, manual receipts and strict aborts', () => {
  it('keeps an actual committed edit after response authority is lost, and only manually matches the original id/hash', async () => {
    const current = await adoptedV5(), request = await portfolioRequest(current.state), actual = IDBDatabase.prototype.transaction
    const reached = vi.fn()
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names, mode, options) {
      const tx = actual.call(this, names, mode, options)
      if (mode === 'readwrite' && Array.isArray(names) && names.includes('portfolio_metadata')) {
        tx.addEventListener('complete', () => { reached(); current.controller.abort() }, { once: true })
      }
      return tx
    })
    await expect(current.v5.editPortfolio(request, current.guard)).rejects.toBeInstanceOf(Error)
    expect(reached).toHaveBeenCalledOnce(); vi.restoreAllMocks()
    const { guard } = context(), handle = await reopen(current.factory), state = await handle.readLocalState(guard)
    expect(state.snapshot.localVersion).toBe(current.state.snapshot.localVersion + 1)
    expect(state.portfolio!.manual[0].values.value).toBe(7)
    expect(await handle.localReceipt(request.id, request.hash, guard)).toEqual({ state: 'matched', value: state })
    expect(await handle.localReceipt('portfolio-other-id-0001', request.hash, guard)).toEqual({ state: 'unknown' })
    await expect(handle.localReceipt(request.id, '1'.repeat(64), guard)).rejects.toMatchObject({ code: 'workspace_idempotency_conflict' })
    const changed = await handle.editLocal(await fundRequest(state, 'portfolio-later-fund-0001'), guard)
    expect(await handle.localReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
    expect(changed.snapshot.localVersion).toBe(state.snapshot.localVersion + 1)
  })
  it.each(['put-abort', 'quota', 'revoked-before', 'revoked-after-put'] as const)
    ('preserves every complete row and the original receipt on %s', async fault => {
      const current = await adoptedV5(), request = await portfolioRequest(current.state), before = await image(current.factory)
      const actual = IDBObjectStore.prototype.put
      if (fault === 'revoked-before') current.controller.abort()
      else vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
        if (this.name === 'portfolio_metadata' && key === 'current' && fault === 'quota') throw new DOMException('Synthetic quota', 'QuotaExceededError')
        const pending = actual.call(this, value, key)
        if (this.name === 'portfolio_metadata' && key === 'current') {
          if (fault === 'put-abort') pending.addEventListener('success', () => this.transaction.abort())
          if (fault === 'revoked-after-put') current.controller.abort()
        }
        return pending
      })
      await expect(current.v5.editPortfolio(request, current.guard)).rejects.toBeInstanceOf(Error)
      vi.restoreAllMocks(); expect(await image(current.factory)).toEqual(before)
      const handle = await reopen(current.factory), { guard } = context()
      expect(await handle.localReceipt(request.id, request.hash, guard)).toEqual({ state: 'unknown' })
    })
})
