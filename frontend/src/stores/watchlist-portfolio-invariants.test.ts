/** Independent actual Pinia/v5/IDB audit. Synthetic latency does not prove a
 * browser/cloud deployment; it models a delayed old complete read response. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from './watchlist'
import * as workspaceModule from './owner-workspace'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { setLegacySyncConsent } from '@/utils/cloud-consent'

let factory: IDBFactory
let data: Map<string, string>
const stores: Array<ReturnType<typeof useWatchlistStore>> = []
beforeEach(() => {
  factory = new IDBFactory()
  data = new Map([
    ['sinan_watchlist_v2', canonicalOwnerLocal([{ code: '510300', name: '合成零份', account: '合成账户',
      position_kind: 'holding', shares: 0, cost: null, target_weight: null, updated_at: '2026-10-23T00:00:00Z' }])],
    ['sinan_manual_assets_v1', canonicalOwnerLocal([{ id: 'synthetic-cash', name: '合成现金', cls: '现金', value: 1,
      updated_at: '2026-10-23T00:00:00Z' }])],
    ['sinan_snapshots', '[{"date":"2026-10-22","value":1,"cost":0}]'],
  ])
  vi.stubGlobal('indexedDB', factory)
  vi.stubGlobal('location', { origin: 'https://fund.example' })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden') }))
  setLegacySyncConsent(false)
})
afterEach(() => {
  stores.splice(0).forEach(store => store.$dispose())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function store() {
  setActivePinia(createPinia())
  const result = useWatchlistStore(); stores.push(result)
  await result.initialize(); return result
}
async function adoptedV5() {
  const original = await store(), rows = await original.createLocalWorkspaceBackup()
  await original.activateLocalWorkspace(rows.raw, rows.sha256)
  const v3 = await original.createSyncRecoveryBackup()
  await original.upgradeLocalSyncFormat(v3.raw, v3.sha256, true)
  const v4 = await original.createPortfolioUpgradeBackup()
  await original.upgradePortfolioFormat(v4.raw, v4.sha256, true)
  original.$dispose(); stores.splice(stores.indexOf(original), 1)
}

describe('independent complete portfolio read publication invariants', () => {
  it('cannot publish an old complete load after a successful newer portfolio edit', async () => {
    await adoptedV5()
    const reached = deferred(), gate = deferred(), actualOpen = workspaceModule.openOwnerWorkspace
    let armed = false, held = false
    vi.spyOn(workspaceModule, 'openOwnerWorkspace').mockImplementation(async (...args) => {
      const actual = await actualOpen(...args)
      return { ...actual, async readLocalState(guard) {
        const state = await actual.readLocalState(guard)
        if (armed && !held) { held = true; reached.release(); await gate.promise }
        return state
      } }
    })
    const current = await store()
    expect(current.localSyncFormat).toBe('v5')
    armed = true
    const oldLoad = current.load(true).catch(() => undefined)
    await reached.promise
    await current.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash',
      values: { name: '合成现金', cls: '现金', value: 9, note: null }, updated_at: '2026-10-25T00:00:00Z' })
    expect(current.portfolioState!.manual[0].values.value).toBe(9)
    const accepted = current.portfolioState
    gate.release(); await oldLoad
    expect(current.portfolioState).toEqual(accepted)
    expect(current.portfolioState!.manual[0].values.value).toBe(9)
    expect(current.authorityState).toBe('idb')
  })
})
