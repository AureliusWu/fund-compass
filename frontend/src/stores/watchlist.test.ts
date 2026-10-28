import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'

import { entryId, migrateEntries } from '@/utils/gist'
import * as gist from '@/utils/gist'
import { getLegacySyncConsent, setLegacySyncConsent } from '@/utils/cloud-consent'
import { WatchMutationError, type HoldingInput } from '@/utils/holding-editor'
import { useWatchlistStore } from './watchlist'

const store = new Map<string, string>()
const created: ReturnType<typeof useWatchlistStore>[] = []
async function createStore() { const watch = useWatchlistStore(); created.push(watch); try { await watch.initialize() } catch { /* blocked state remains observable */ } return watch }
const localValue = () => store.get('sinan_watchlist_v2')
const input = (overrides: Partial<HoldingInput> = {}): HoldingInput => ({ code: '510300', account: '', position_kind: 'holding', shares: 0, cost: null, target_weight: null, ...overrides })
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  },
  configurable: true,
})

describe('watchlist cross-account model', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('location', { origin: 'https://fund.example' })
    store.clear()
    setLegacySyncConsent(false)
    setActivePinia(createPinia())
  })
  afterEach(() => { created.splice(0).forEach(watch => watch.$dispose()); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('normalizes entry id by trimmed account', async () => {
    expect(entryId('510300', ' 支付宝 ')).toBe('510300::支付宝')
    expect(entryId('510300')).toBe('510300::')
  })

  it('migrates old entries with compound ids', async () => {
    const rows = migrateEntries([
      { code: '510300', account: '支付宝', updated_at: '2026-07-04T00:00:00Z' },
      { code: '510300', updated_at: '2026-07-04T00:00:00Z' },
    ])
    expect(rows.map((r) => r.id)).toEqual(['510300::支付宝', '510300::'])
  })

  it('keeps same fund independent across accounts', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    await watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    expect(watch.holdingsFor('510300')).toHaveLength(2)
    expect(watch.activeHoldings.map((e) => e.id).sort()).toEqual(['510300::券商', '510300::支付宝'])
  })

  it('removes all account rows when deleting by code from code-level list', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    await watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    await expect(watch.remove('510300')).rejects.toThrow(WatchMutationError)
    await watch.remove('510300', undefined, { confirmed: true })

    expect(watch.activeHoldings).toHaveLength(0)
    expect(watch.entries.filter((e) => e.code === '510300').every((e) => e.deleted)).toBe(true)
  })

  it('can remove only one account when account is specified', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    await watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    await watch.remove('510300', '支付宝', { confirmed: true })

    expect(watch.activeHoldings.map((e) => e.account)).toEqual(['券商'])
  })

  it('keeps explicit zero holding separate from watch and survives a refresh', async () => {
    const watch = await createStore()
    await watch.saveHolding(input({ cost: 0, target_weight: 0 }))
    expect(watch.recordsFor('510300')[0]).toMatchObject({ shares: 0, cost: 0, target_weight: 0, position_kind: 'holding' })
    expect(watch.holdingsFor('510300')).toEqual([])
    expect(watch.hasLocalChanges('510300')).toBe(true)
    expect(watch.items).toHaveLength(1)
    watch.$dispose()
    setActivePinia(createPinia())
    const refreshed = await createStore()
    expect(refreshed.recordsFor('510300')[0]).toMatchObject({ shares: 0, cost: 0, target_weight: 0, position_kind: 'holding' })
    expect(refreshed.hasLocalChanges('510300')).toBe(true)
  })

  it('preserves historical missing shares without manufacturing zero', async () => {
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', updated_at: '2026-09-30T00:00:00Z' }]))
    const watch = await createStore()
    expect(watch.entries[0].shares).toBeUndefined()
    expect(localValue()).not.toContain('shares')
  })

  it('loads the old v1 key when v2 is absent without uploading', async () => {
    store.set('sinan_watchlist_v1', JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }]))
    const watch = await createStore()
    await watch.load(true)
    expect(watch.holdingsFor('510300')).toHaveLength(1)
    expect(watch.entries[0].id).toBe('510300::')
    await expect(watch.setHolding('510300', 101, null)).resolves.toBeUndefined()
    expect(JSON.parse(localValue()!)[0]).toMatchObject({ id: '510300::', shares: 101 })
  })

  it('binds the actual v1 source and both original slots without normalizing its raw bytes', async () => {
    const raw = ' [ { "code":"510300", "shares":100, "updated_at":"2026-09-30T00:00:00Z" } ] '
    store.set('sinan_watchlist_v1', raw)
    const watch = await createStore(), write = vi.spyOn(localStorage, 'setItem')
    const snapshot = watch.readOwnerSyncSnapshot()
    expect(snapshot.raw).toBeNull() // Existing v2-only field stays compatible.
    expect(snapshot.source).toEqual({ sourceKey: 'sinan_watchlist_v1', v1Raw: raw, v2Raw: null })
    expect(Object.isFrozen(snapshot.source)).toBe(true)
    watch.assertOwnerSyncSnapshot(snapshot)
    expect(write).not.toHaveBeenCalled()
    expect(localValue()).toBeUndefined()
    expect(store.get('sinan_watchlist_v1')).toBe(raw)
  })

  it('distinguishes absent slots from an explicitly empty authoritative v2 without falling back to v1', async () => {
    const absent = (await createStore()).readOwnerSyncSnapshot()
    expect(absent.source).toEqual({ sourceKey: null, v1Raw: null, v2Raw: null })
    setActivePinia(createPinia())
    store.set('sinan_watchlist_v1', '[null]'); store.set('sinan_watchlist_v2', '[]')
    const watch = await createStore(), present = watch.readOwnerSyncSnapshot()
    expect(present.entries).toEqual([])
    expect(present.source).toEqual({ sourceKey: 'sinan_watchlist_v2', v1Raw: '[null]', v2Raw: '[]' })
    expect(watch.localStorageError).toBe(false)
    watch.assertOwnerSyncSnapshot(present)
  })

  it.each(['missing', 'wrong-key', 'wrong-v1', 'wrong-v2'] as const)('rejects %s source metadata on an otherwise unchanged Owner snapshot', async kind => {
    const raw = JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }])
    store.set('sinan_watchlist_v1', raw)
    const watch = await createStore(), snapshot = watch.readOwnerSyncSnapshot()
    const source = kind === 'missing' ? undefined : { ...snapshot.source,
      ...(kind === 'wrong-key' ? { sourceKey: 'sinan_watchlist_v2' } : {}),
      ...(kind === 'wrong-v1' ? { v1Raw: '[]' } : {}),
      ...(kind === 'wrong-v2' ? { v2Raw: raw } : {}),
    }
    const write = vi.spyOn(localStorage, 'setItem')
    expect(() => watch.assertOwnerSyncSnapshot({ ...snapshot, source } as unknown as typeof snapshot)).toThrow(WatchMutationError)
    expect(write).not.toHaveBeenCalled()
    expect(store.get('sinan_watchlist_v1')).toBe(raw)
    expect(localValue()).toBeUndefined()
    watch.assertOwnerSyncSnapshot(snapshot)
  })

  it('rejects an unobserved v1 fallback change before either Owner send or local mutation can use the stale copy', async () => {
    const original = JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }])
    const newer = JSON.stringify([{ code: '510300', shares: 200, updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v1', original)
    const watch = await createStore(), snapshot = watch.readOwnerSyncSnapshot(), memory = JSON.stringify(watch.entries)
    store.set('sinan_watchlist_v1', newer)
    const write = vi.spyOn(localStorage, 'setItem')
    expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
    await expect(watch.setHolding('510300', 150, 1)).rejects.toThrow('记录已变化')
    expect(JSON.stringify(watch.entries)).toBe(memory)
    expect(store.get('sinan_watchlist_v1')).toBe(newer)
    expect(localValue()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
    expect(watch.hasLocalChanges()).toBe(true)
  })

  it('rejects a v1-to-v2 authority switch even when the two raw values are identical', async () => {
    const raw = JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }])
    store.set('sinan_watchlist_v1', raw)
    const watch = await createStore(), snapshot = watch.readOwnerSyncSnapshot()
    store.set('sinan_watchlist_v2', raw)
    const write = vi.spyOn(localStorage, 'setItem')
    expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
    expect(write).not.toHaveBeenCalled()
    expect(localValue()).toBe(raw)
  })

  it('never revives an archived v1 holding after observing authoritative v2 tombstones then v2 deletion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    store.set('sinan_gist_token', 'synthetic-test-token'); setLegacySyncConsent(true)
    const old = JSON.stringify([{ code: '510300', shares: 100, position_kind: 'holding', updated_at: '2026-09-30T00:00:00Z' }])
    const current = JSON.stringify([{ code: '510300', shares: 100, position_kind: 'holding', deleted: true,
      local_pending: true, updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v1', old); store.set('sinan_watchlist_v2', current)
    const watch = await createStore(), snapshot = watch.readOwnerSyncSnapshot(), memory = JSON.stringify(watch.entries)
    const push = vi.spyOn(gist, 'pushEntries'), pull = vi.spyOn(gist, 'pullEntries')
    store.delete('sinan_watchlist_v2')
    const write = vi.spyOn(localStorage, 'setItem')
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', storageArea: localStorage }))
    expect(watch.localStorageError).toBe(true)
    expect(JSON.stringify(watch.entries)).toBe(memory)
    expect(watch.entries[0].deleted).toBe(true)
    expect(watch.has('510300')).toBe(false)
    expect(watch.hasLocalChanges()).toBe(true)
    expect(snapshot.source).toEqual({ sourceKey: 'sinan_watchlist_v2', v1Raw: old, v2Raw: current })
    expect(() => watch.readOwnerSyncSnapshot()).toThrow(WatchMutationError)
    expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
    await expect(watch.add('000001')).rejects.toThrow(WatchMutationError)
    await expect(watch.push()).resolves.toBe(false)
    await expect(watch.pull()).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(push).not.toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(store.get('sinan_watchlist_v1')).toBe(old)
    expect(localValue()).toBeUndefined()
  })

  it('also fails v2 removal closed before its event arrives after this store created v2 from v1', async () => {
    const old = JSON.stringify([{ code: '510300', shares: 100, position_kind: 'holding', updated_at: '2026-09-30T00:00:00Z' }])
    store.set('sinan_watchlist_v1', old)
    const watch = await createStore()
    await watch.setHolding('510300', 200, null)
    const snapshot = watch.readOwnerSyncSnapshot(), memory = JSON.stringify(watch.entries)
    store.delete('sinan_watchlist_v2')
    const write = vi.spyOn(localStorage, 'setItem')
    expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
    expect(watch.localStorageError).toBe(true)
    expect(JSON.stringify(watch.entries)).toBe(memory)
    expect(watch.entries[0].shares).toBe(200)
    await expect(watch.setHolding('510300', 300, null)).rejects.toThrow(WatchMutationError)
    expect(write).not.toHaveBeenCalled()
    expect(store.get('sinan_watchlist_v1')).toBe(old)
    expect(localValue()).toBeUndefined()
  })

  it('retains v2 authority when v1 changes but invalidates the old Owner context without merging or rewriting', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    const current = JSON.stringify([{ code: '510300', shares: 200, updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v2', current)
    const watch = await createStore(), snapshot = watch.readOwnerSyncSnapshot()
    store.set('sinan_watchlist_v1', '[null]') // Inactive malformed legacy data is archived, not selected.
    const write = vi.spyOn(localStorage, 'setItem')
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v1', storageArea: localStorage }))
    expect(watch.entries[0].shares).toBe(200)
    expect(watch.localStorageError).toBe(false)
    expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
    const next = watch.readOwnerSyncSnapshot()
    expect(next.source).toEqual({ sourceKey: 'sinan_watchlist_v2', v1Raw: '[null]', v2Raw: current })
    expect(next.generation).toBeGreaterThan(snapshot.generation)
    watch.assertOwnerSyncSnapshot(next)
    expect(write).not.toHaveBeenCalled()
    expect(localValue()).toBe(current)
  })

  it.each(['sinan_watchlist_v1', 'sinan_watchlist_v2', null] as const)(
    'invalidates an observed source event for %s even when queued ABA returned both raw slots to the same bytes', async key => {
      const browser = new EventTarget()
      vi.stubGlobal('window', browser)
      const raw = JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }])
      store.set('sinan_watchlist_v1', raw)
      const watch = await createStore(), snapshot = watch.readOwnerSyncSnapshot()
      store.set('sinan_watchlist_v1', '[]'); store.set('sinan_watchlist_v1', raw)
      const write = vi.spyOn(localStorage, 'setItem')
      browser.dispatchEvent(Object.assign(new Event('storage'), { key, oldValue: '[]', newValue: raw, storageArea: localStorage }))
      const next = watch.readOwnerSyncSnapshot()
      expect(next.source).toEqual(snapshot.source)
      expect(next.memory).toBe(snapshot.memory)
      expect(next.generation).toBeGreaterThan(snapshot.generation)
      expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
      expect(write).not.toHaveBeenCalled()
    },
  )

  it.each(['initial', 'snapshot', 'mutation'] as const)(
    'fails %s closed when reading v1 is denied despite a valid authoritative v2', async phase => {
      const raw = JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }])
      store.set('sinan_watchlist_v2', raw)
      const read = localStorage.getItem.bind(localStorage)
      const deny = () => vi.spyOn(localStorage, 'getItem').mockImplementation(key => {
        if (key === 'sinan_watchlist_v1') throw new DOMException('synthetic denied', 'SecurityError')
        return read(key)
      })
      if (phase === 'initial') deny()
      const watch = await createStore(), before = JSON.stringify(watch.entries), write = vi.spyOn(localStorage, 'setItem')
      if (phase !== 'initial') deny()
      if (phase === 'mutation') await expect(watch.setHolding('510300', 150, null)).rejects.toThrow(WatchMutationError)
      else expect(() => watch.readOwnerSyncSnapshot()).toThrow(WatchMutationError)
      expect(watch.localStorageError).toBe(true)
      expect(watch.hasLocalChanges()).toBe(true)
      expect(JSON.stringify(watch.entries)).toBe(before)
      expect(localValue()).toBe(raw)
      expect(write).not.toHaveBeenCalled()
    },
  )

  it.each(['event', 'before-event'] as const)('rejects a late Gist pull after a v1 fallback mutation %s', async mode => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    store.set('sinan_gist_token', 'synthetic-test-token'); setLegacySyncConsent(true)
    const original = JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }])
    const newer = JSON.stringify([{ code: '510300', shares: 200, updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v1', original)
    let finish!: (rows: gist.WatchEntry[]) => void
    vi.spyOn(gist, 'pullEntries').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const watch = await createStore(), pending = watch.pull()
    await vi.waitFor(() => expect(gist.pullEntries).toHaveBeenCalled())
    store.set('sinan_watchlist_v1', newer)
    const write = vi.spyOn(localStorage, 'setItem')
    if (mode === 'event') browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v1', storageArea: localStorage }))
    finish([{ code: '000001', updated_at: '2099-01-01T00:00:00Z' }])
    await expect(pending).resolves.toBe(false)
    expect(watch.has('000001')).toBe(false)
    expect(localValue()).toBeUndefined()
    expect(store.get('sinan_watchlist_v1')).toBe(newer)
    expect(write).not.toHaveBeenCalled()
  })

  it('does not claim a late Gist upload confirms the current source when v1 changed before its event arrived', async () => {
    store.set('sinan_gist_token', 'synthetic-test-token'); setLegacySyncConsent(true)
    const original = JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }])
    const newer = JSON.stringify([{ code: '510300', shares: 200, updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v1', original)
    let finish!: (success: boolean) => void
    vi.spyOn(gist, 'pushEntries').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const watch = await createStore(), previousSync = watch.lastSync, pending = watch.push()
    await vi.waitFor(() => expect(gist.pushEntries).toHaveBeenCalled())
    store.set('sinan_watchlist_v1', newer)
    const write = vi.spyOn(localStorage, 'setItem')
    finish(true)
    await expect(pending).resolves.toBe(false)
    expect(watch.lastSync).toBe(previousSync)
    expect(store.get('sinan_watchlist_v1')).toBe(newer)
    expect(localValue()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
    expect(watch.hasLocalChanges()).toBe(true)
  })

  it('keeps undefined targets and clears explicitly null targets without losing zero cost', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 10, 0, undefined, '', 35)
    await watch.setHolding('510300', 10, null)
    expect(watch.entries[0]).toMatchObject({ target_weight: 35, cost: null })
    await watch.setHolding('510300', 10, 0, undefined, '', null)
    expect(watch.entries[0]).toMatchObject({ target_weight: null, cost: 0 })
  })

  it('explicitly re-adding a deleted fund does not resurrect its old financial fields', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1, undefined, '', 35)
    await watch.remove('510300', '', { confirmed: true })
    await watch.add('510300')
    expect(watch.recordsFor('510300')[0]).toMatchObject({ position_kind: 'watch', shares: null, cost: null, target_weight: null })
    expect(watch.holdingsFor('510300')).toEqual([])
  })

  it.each([
    { code: 'bad' }, { shares: -1 }, { shares: NaN }, { shares: Infinity },
    { shares: null }, { cost: -1 }, { cost: Infinity }, { target_weight: 101 },
    { target_weight: -1 }, { account: 'bad\naccount' },
  ])('rejects invalid holding input %j before any state/storage mutation', async (bad) => {
    const watch = await createStore()
    await watch.add('000001')
    const before = localValue(), entries = JSON.stringify(watch.entries)
    await expect(watch.saveHolding(input(bad))).rejects.toThrow(WatchMutationError)
    expect(localValue()).toBe(before)
    expect(JSON.stringify(watch.entries)).toBe(entries)
  })

  it('renames atomically with an old-key tombstone, without duplicate live holdings', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1, '甲', '支付宝', 20)
    const source = { id: '510300::支付宝', snapshot: watch.entrySnapshot('510300::支付宝')! }
    await watch.saveHolding(input({ account: ' 券商 ', shares: 100, cost: 1, target_weight: 20 }), source)
    expect(watch.activeHoldings).toHaveLength(1)
    expect(watch.activeHoldings[0].id).toBe('510300::券商')
    expect(watch.entries.find(row => row.id === source.id)?.deleted).toBe(true)
  })

  it('rejects rename collisions and stale draft snapshots without any mutation', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1, undefined, '支付宝')
    await watch.setHolding('510300', 50, 2, undefined, '券商')
    const source = { id: '510300::支付宝', snapshot: watch.entrySnapshot('510300::支付宝')! }
    const before = localValue()
    await expect(watch.saveHolding(input({ account: '券商' }), source)).rejects.toThrow('目标账户已有记录')
    expect(localValue()).toBe(before)
    await watch.setHolding('510300', 101, 1, undefined, '支付宝')
    const newer = localValue()
    await expect(watch.saveHolding(input({ account: '银行' }), source)).rejects.toThrow('记录已变化')
    expect(localValue()).toBe(newer)
  })

  it('matches ungrouped explicitly and protects zero holdings and detail toggle from unconfirmed deletion', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 0, null)
    await watch.setHolding('510300', 10, 1, undefined, '支付宝')
    expect(watch.has('510300', '')).toBe(true)
    const before = localValue()
    await expect(watch.toggle('510300')).rejects.toThrow('请明确确认')
    await expect(watch.remove('510300', '')).rejects.toThrow('请明确确认')
    expect(localValue()).toBe(before)
    const snapshot = watch.entrySnapshot('510300::')!
    await watch.remove('510300', '', { confirmed: true, expected: [{ id: '510300::', snapshot }] })
    expect(watch.has('510300', '')).toBe(false)
    expect(watch.recordsFor('510300').map(row => row.account)).toEqual(['支付宝'])
  })

  it('rejects changes during a delete confirmation', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 0, null)
    const expected = [{ id: '510300::', snapshot: watch.entrySnapshot('510300::')! }]
    await watch.setHolding('510300', 1, null)
    const before = localValue()
    await expect(watch.remove('510300', undefined, { confirmed: true, expected })).rejects.toThrow('记录已变化')
    expect(localValue()).toBe(before)
  })

  it('publishes no in-memory change if browser persistence throws', async () => {
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1)
    const before = localValue(), rows = JSON.stringify(watch.entries)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    await expect(watch.setHolding('510300', 101, 2)).rejects.toThrow('本机操作未能安全完成')
    expect(localValue()).toBe(before)
    expect(JSON.stringify(watch.entries)).toBe(rows)
  })

  it('does not overwrite malformed old storage with an empty working copy', async () => {
    store.set('sinan_watchlist_v2', '[null]')
    const watch = await createStore()
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasLocalChanges()).toBe(true)
    await expect(watch.add('510300')).rejects.toThrow('本机操作未能安全完成')
    expect(localValue()).toBe('[null]')
  })

  it('renders a recoverable blocked working copy when browser storage reads are denied', async () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    const watch = await createStore()
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasToken).toBe(false)
    expect(watch.legacySyncEnabled).toBe(false)
    await expect(watch.add('510300')).rejects.toThrow('本机操作未能安全完成')
    expect(localValue()).toBeUndefined()
  })

  it('PAT presence alone never schedules cloud work or pulls on refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    store.set('sinan_gist_token', 'synthetic-test-token')
    const push = vi.spyOn(gist, 'pushEntries'), pull = vi.spyOn(gist, 'pullEntries')
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1)
    await watch.load(true)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(watch.push()).resolves.toBe(false)
    await expect(watch.pull()).resolves.toBe(false)
    expect(push).not.toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled()
  })

  it('cancels queued upload when consent is revoked or a Token is saved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const push = vi.spyOn(gist, 'pushEntries').mockResolvedValue(true)
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1)
    setLegacySyncConsent(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(push).not.toHaveBeenCalled()
    setLegacySyncConsent(true)
    await watch.setHolding('510300', 101, 1)
    watch.setToken('synthetic-new-token')
    expect(getLegacySyncConsent()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(push).not.toHaveBeenCalled()
  })

  it('never clears the Owner pending gate on legacy upload and excludes local metadata from its payload', async () => {
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const push = vi.spyOn(gist, 'pushEntries').mockResolvedValue(true)
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1)
    await expect(watch.push()).resolves.toBe(true)
    expect(watch.hasLocalChanges('510300')).toBe(true)
    expect(push.mock.calls[0][0][0]).not.toHaveProperty('local_pending')
    expect(localValue()).toContain('local_pending')
  })

  it('does not prune unconfirmed tombstones or resurrect them from an older cloud copy', async () => {
    store.set('sinan_watchlist_v2', JSON.stringify([{ id: '510300::', code: '510300', deleted: true, updated_at: '2020-01-01T00:00:00Z' }]))
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    vi.spyOn(gist, 'pullEntries').mockResolvedValue([{ code: '510300', updated_at: '2019-12-31T00:00:00Z' }])
    const watch = await createStore()
    await watch.load(true)
    expect(watch.items).toEqual([])
    expect(watch.entries[0].deleted).toBe(true)
  })

  it.each(['revoke', 'local-edit', 'token-change'] as const)('rejects a late pull after %s', async (change) => {
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    let resolve!: (rows: gist.WatchEntry[]) => void
    vi.spyOn(gist, 'pullEntries').mockReturnValue(new Promise(done => { resolve = done }))
    const watch = await createStore()
    const pending = watch.pull()
    await vi.waitFor(() => expect(gist.pullEntries).toHaveBeenCalled())
    if (change === 'revoke') setLegacySyncConsent(false)
    if (change === 'token-change') watch.setToken('synthetic-new-token')
    if (change === 'local-edit') await watch.setHolding('510300', 123, null)
    const before = localValue()
    resolve([{ code: '000001', updated_at: '2099-01-01T00:00:00Z' }])
    await expect(pending).resolves.toBe(false)
    expect(localValue()).toBe(before)
    expect(watch.has('000001')).toBe(false)
  })

  it('rejects a second independent store saving an observed stale disk baseline without overwriting', async () => {
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', shares: 100, cost: 1,
      position_kind: 'holding', updated_at: '2026-09-30T00:00:00Z' }]))
    const first = await createStore()
    setActivePinia(createPinia())
    const second = await createStore()
    const beforeSecond = JSON.stringify(second.entries)
    await first.setHolding('510300', 200, 1)
    const current = localValue()
    const write = vi.spyOn(localStorage, 'setItem')
    await expect(second.setHolding('510300', 150, 1)).rejects.toThrow('记录已变化')
    expect(write).not.toHaveBeenCalled()
    expect(localValue()).toBe(current)
    expect(JSON.stringify(second.entries)).toBe(beforeSecond)
    expect(second.hasLocalChanges()).toBe(true)
    expect(second.hasLocalChanges('000001')).toBe(true)
  })

  it('does not commit a late cloud pull over a second store change even before its event arrives', async () => {
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const first = await createStore()
    setActivePinia(createPinia())
    const second = await createStore()
    let finish!: (rows: gist.WatchEntry[]) => void
    vi.spyOn(gist, 'pullEntries').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const pending = second.pull()
    await vi.waitFor(() => expect(gist.pullEntries).toHaveBeenCalled())
    await first.setHolding('510300', 200, 1)
    const current = localValue()
    const write = vi.spyOn(localStorage, 'setItem')
    finish([{ code: '000001', updated_at: '2099-01-01T00:00:00Z' }])
    await expect(pending).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
    expect(localValue()).toBe(current)
    expect(second.has('000001')).toBe(false)
    expect(second.hasLocalChanges()).toBe(true)
  })

  it('reloads a valid external storage event locally, gates current actions, and cancels queued cloud work without echo writes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const cloudPush = vi.spyOn(gist, 'pushEntries').mockResolvedValue(true)
    const cloudPull = vi.spyOn(gist, 'pullEntries')
    const watch = await createStore()
    await watch.setHolding('510300', 100, 1)
    const external = JSON.stringify([{ code: '510300', shares: 200, cost: 1,
      position_kind: 'holding', updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v2', external)
    const write = vi.spyOn(localStorage, 'setItem')
    browser.dispatchEvent(Object.assign(new Event('storage'), {
      key: 'sinan_watchlist_v2', newValue: external, storageArea: localStorage,
    }))
    expect(watch.entries[0].shares).toBe(200)
    expect(watch.entries[0].local_pending).toBeUndefined()
    expect(watch.hasLocalChanges('000001')).toBe(true)
    expect(watch.localStorageError).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(write).not.toHaveBeenCalled()
    expect(cloudPush).not.toHaveBeenCalled()
    expect(cloudPull).not.toHaveBeenCalled()
    expect(localValue()).toBe(external)
  })

  it('rejects an already pending pull after an external valid event and does not echo its value back to disk', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    let finish!: (rows: gist.WatchEntry[]) => void
    vi.spyOn(gist, 'pullEntries').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const watch = await createStore()
    const pending = watch.pull()
    await vi.waitFor(() => expect(gist.pullEntries).toHaveBeenCalled())
    const external = JSON.stringify([{ code: '510300', shares: 200, cost: 1,
      position_kind: 'holding', updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v2', external)
    const write = vi.spyOn(localStorage, 'setItem')
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', newValue: external, storageArea: localStorage }))
    finish([{ code: '000001', updated_at: '2099-01-01T00:00:00Z' }])
    await expect(pending).resolves.toBe(false)
    expect(watch.entries[0].shares).toBe(200)
    expect(watch.has('000001')).toBe(false)
    expect(write).not.toHaveBeenCalled()
    expect(localValue()).toBe(external)
  })

  it('preserves malformed external disk data and the old working copy while failing current actions closed', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', shares: 100, cost: 1,
      position_kind: 'holding', updated_at: '2026-09-30T00:00:00Z' }]))
    const watch = await createStore()
    const rows = JSON.stringify(watch.entries)
    store.set('sinan_watchlist_v2', '[null]')
    const write = vi.spyOn(localStorage, 'setItem')
    const cloudPush = vi.spyOn(gist, 'pushEntries'), cloudPull = vi.spyOn(gist, 'pullEntries')
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', newValue: '[null]', storageArea: localStorage }))
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasLocalChanges()).toBe(true)
    expect(JSON.stringify(watch.entries)).toBe(rows)
    await expect(watch.setHolding('510300', 150, 1)).rejects.toThrow('本机操作未能安全完成')
    expect(localValue()).toBe('[null]')
    expect(write).not.toHaveBeenCalled()
    expect(cloudPush).not.toHaveBeenCalled(); expect(cloudPull).not.toHaveBeenCalled()
  })

  it('fails a denied commit-time storage read closed without publishing or writing the draft', async () => {
    const watch = await createStore()
    const rows = JSON.stringify(watch.entries)
    const originalRead = localStorage.getItem.bind(localStorage)
    vi.spyOn(localStorage, 'getItem').mockImplementation(key => {
      if (key === 'sinan_watchlist_v2') throw new DOMException('denied', 'SecurityError')
      return originalRead(key)
    })
    const write = vi.spyOn(localStorage, 'setItem')
    await expect(watch.setHolding('510300', 100, 1)).rejects.toThrow('本机操作未能安全完成')
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasLocalChanges()).toBe(true)
    expect(JSON.stringify(watch.entries)).toBe(rows)
    expect(write).not.toHaveBeenCalled()
  })

  it('reads the newest disk state instead of applying a queued stale storage-event payload', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    const watch = await createStore()
    const newer = JSON.stringify([{ code: '510300', shares: 300, cost: 1,
      position_kind: 'holding', updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v2', newer)
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', newValue: '[]', storageArea: localStorage }))
    expect(watch.entries[0].shares).toBe(300)
    expect(watch.hasLocalChanges()).toBe(true)
  })

  it('removes its exact storage listener when the independent store scope is disposed', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    const add = vi.spyOn(browser, 'addEventListener'), remove = vi.spyOn(browser, 'removeEventListener')
    const watch = await createStore()
    const listener = add.mock.calls.find(call => call[0] === 'storage')![1]
    const rows = JSON.stringify(watch.entries)
    watch.$dispose()
    expect(remove).toHaveBeenCalledWith('storage', listener)
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', shares: 1, updated_at: '2026-10-02T00:00:00Z' }]))
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', storageArea: localStorage }))
    expect(JSON.stringify(watch.entries)).toBe(rows)
  })

  it('reads a frozen complete Owner input snapshot without writing or dropping account tombstones', async () => {
    const watch = await createStore()
    await watch.saveHolding(input({ account: '旧账户', name: '合成基金', shares: 0, cost: 0 }))
    await watch.remove('510300', '旧账户', { confirmed: true })
    await watch.saveHolding(input({ account: '新账户', name: '合成基金', shares: 0, cost: null }))
    const before = localValue(), write = vi.spyOn(localStorage, 'setItem')
    const snapshot = watch.readOwnerSyncSnapshot()
    expect(snapshot.raw).toBe(before)
    expect(snapshot.memory).toBe(JSON.stringify(watch.entries))
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries.some(row => row.deleted === true)).toBe(true)
    expect(snapshot.entries.find(row => !row.deleted)).toMatchObject({ position_kind: 'holding', shares: 0, cost: null })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.entries)).toBe(true)
    expect(snapshot.entries.every(Object.isFrozen)).toBe(true)
    watch.assertOwnerSyncSnapshot(snapshot)
    expect(write).not.toHaveBeenCalled()
    expect(watch.localPending).toBe(true)
    expect(localValue()).toBe(before)
  })

  it.each(['local-edit', 'memory-only', 'raw-before-event', 'external-event', 'observed-aba'] as const)(
    'rejects a stale Owner preview after %s without an echo write', async cause => {
      const browser = new EventTarget()
      vi.stubGlobal('window', browser)
      const watch = await createStore()
      await watch.saveHolding(input({ name: '合成基金', shares: 0 }))
      const snapshot = watch.readOwnerSyncSnapshot(), original = localValue()!
      const external = JSON.stringify(JSON.parse(original).map((row: object) => ({ ...row, shares: 2 })))
      const event = () => browser.dispatchEvent(Object.assign(new Event('storage'), {
        key: 'sinan_watchlist_v2', storageArea: localStorage,
      }))
      if (cause === 'local-edit') await watch.setHolding('510300', 1, null)
      else if (cause === 'memory-only') watch.entries[0]!.shares = 2
      else {
        store.set('sinan_watchlist_v2', external)
        if (cause !== 'raw-before-event') event()
        if (cause === 'observed-aba') { store.set('sinan_watchlist_v2', original); event() }
      }
      const before = localValue(), write = vi.spyOn(localStorage, 'setItem')
      expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
      expect(write).not.toHaveBeenCalled()
      expect(localValue()).toBe(before)
      expect(watch.localPending).toBe(true)
    },
  )

  it('keeps Owner snapshot access blocked on malformed/denied storage and never mutates stored records', async () => {
    store.set('sinan_watchlist_v2', '[null]')
    const malformed = await createStore(), before = localValue()
    expect(() => malformed.readOwnerSyncSnapshot()).toThrow(WatchMutationError)
    expect(localValue()).toBe(before)
    setActivePinia(createPinia())
    store.set('sinan_watchlist_v2', '[]')
    const watch = await createStore(), snapshot = watch.readOwnerSyncSnapshot()
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('synthetic denied', 'SecurityError') })
    expect(() => watch.readOwnerSyncSnapshot()).toThrow(WatchMutationError)
    expect(() => watch.assertOwnerSyncSnapshot(snapshot)).toThrow(WatchMutationError)
    expect(localValue()).toBe('[]')
  })

  it('does not read or publish legacy business data before metadata resolves', async () => {
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', updated_at: '2026-09-30T00:00:00Z' }]))
    const read = vi.spyOn(localStorage, 'getItem')
    const watch = useWatchlistStore(); created.push(watch)
    expect(watch.authorityState).toBe('unresolved')
    expect(watch.entries).toEqual([])
    expect(read).not.toHaveBeenCalled()
    const open = vi.spyOn(indexedDB, 'open')
    await Promise.all([watch.initialize(), watch.initialize()])
    expect(open).toHaveBeenCalledTimes(1)
    expect(watch.authorityState).toBe('legacy')
    expect(watch.has('510300')).toBe(true)
  })

  it('keeps initialization failure closed without reading LS or permitting writers', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const read = vi.spyOn(localStorage, 'getItem')
    const watch = useWatchlistStore(); created.push(watch)
    await expect(watch.initialize()).rejects.toMatchObject({ code: 'authority_unavailable' })
    expect(watch.authorityState).toBe('blocked')
    expect(read).not.toHaveBeenCalled()
    await expect(watch.add('510300', '合成基金')).rejects.toThrow(WatchMutationError)
    expect(localValue()).toBeUndefined()
  })

  it('disposal invalidates late initialization before any business rows are accepted', async () => {
    const watch = useWatchlistStore(); created.push(watch)
    const pending = watch.initialize()
    watch.$dispose()
    await expect(pending).rejects.toThrow()
    expect(watch.entries).toEqual([])
  })

  it('activates only its current exported and reselected bytes, then edits and reloads from the same IDB', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const watch = await createStore()
    await watch.saveHolding(input({ name: '合成基金', account: '甲', shares: 0, cost: 0 }))
    const backup = await watch.createLocalWorkspaceBackup(), legacy = localValue()
    expect(backup.counts).toMatchObject({ total: 1, holding: 1, tombstones: 0 })
    await expect(watch.activateLocalWorkspace(backup.raw, '0'.repeat(64))).rejects.toThrow()
    expect(watch.authorityState).toBe('legacy')
    await watch.activateLocalWorkspace(backup.raw, backup.sha256)
    expect(watch.authorityState).toBe('idb')
    expect(watch.recordsFor('510300')[0]).toMatchObject({ shares: 0, cost: 0, position_kind: 'holding' })
    await watch.setHolding('510300', 7, null, '合成基金', '甲')
    expect(watch.recordsFor('510300')[0].shares).toBe(7)
    expect(localValue()).toBe(legacy)
    watch.$dispose(); setActivePinia(createPinia())
    const reloaded = await createStore()
    await reloaded.load(true)
    expect(reloaded.authorityState).toBe('idb')
    expect(reloaded.recordsFor('510300')[0]).toMatchObject({ shares: 7, cost: null, account: '甲', local_pending: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(localValue()).toBe(legacy)
  })

  it('rejects activation from an old export after an actual legacy edit', async () => {
    const watch = await createStore()
    await watch.add('510300', '合成基金')
    const backup = await watch.createLocalWorkspaceBackup()
    await watch.add('000001', '第二基金')
    await expect(watch.activateLocalWorkspace(backup.raw, backup.sha256)).rejects.toThrow(WatchMutationError)
    expect(watch.authorityState).toBe('legacy')
  })

  it('exports the actual post-edit authority and reimports duplicates without overwriting or advancing it', async () => {
    const watch = await createStore(), original = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(original.raw, original.sha256)
    await watch.add('510300', '合成基金')
    const current = await watch.createLocalWorkspaceBackup()
    const preview = await watch.previewLocalWorkspaceRestore(current.raw, current.sha256)
    expect(preview).toMatchObject({ added: 0, noops: 1, conflicts: 0 })
    const before = JSON.stringify(watch.entries)
    await watch.restoreLocalWorkspaceBackup(current.raw, current.sha256)
    expect(JSON.stringify(watch.entries)).toBe(before)
    expect((await watch.createLocalWorkspaceBackup()).raw).toBe(current.raw)
  })

  it('keeps the original workspace target after the configured API endpoint changes', async () => {
    const watch = await createStore(), original = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(original.raw, original.sha256)
    await watch.add('510300', '原目标基金')
    const names = (await indexedDB.databases()).map(row => row.name).sort()
    watch.$dispose(); setActivePinia(createPinia())
    vi.stubGlobal('location', { origin: 'https://different-api.example' })
    const reopened = await createStore()
    await reopened.load(true)
    expect(reopened.authorityState).toBe('idb')
    expect(reopened.has('510300')).toBe(true)
    expect((await indexedDB.databases()).map(row => row.name).sort()).toEqual(names)
  })

  it('refuses a missing selected workspace instead of recreating it or showing old LS rows', async () => {
    const watch = await createStore()
    await watch.add('510300', '旧本机基金')
    const original = await watch.createLocalWorkspaceBackup(), legacy = localValue()
    await watch.activateLocalWorkspace(original.raw, original.sha256)
    const name = (await indexedDB.databases()).find(row => row.name?.startsWith('fund-compass-owner-sync-outbox-1:'))!.name!
    watch.$dispose(); setActivePinia(createPinia())
    await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error) })
    const reopened = await createStore()
    expect(reopened.authorityState).toBe('blocked')
    expect(reopened.entries).toEqual([])
    expect((await indexedDB.databases()).some(row => row.name === name)).toBe(false)
    expect(localValue()).toBe(legacy)
    await expect(reopened.add('000001', '不能新增')).rejects.toThrow()
  })

  it('revokes Gist and rejects all old read/write paths after activation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    store.set('sinan_gist_token', 'synthetic-token')
    setLegacySyncConsent(true)
    const push = vi.spyOn(gist, 'pushEntries').mockResolvedValue(true)
    const pull = vi.spyOn(gist, 'pullEntries').mockResolvedValue([{ code: '000001', updated_at: '2026-10-01T00:00:00Z' }])
    const watch = await createStore()
    await watch.add('510300', '本机基金')
    const original = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(original.raw, original.sha256)
    expect(getLegacySyncConsent()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(watch.push()).resolves.toBe(false)
    await expect(watch.pull()).resolves.toBe(false)
    await watch.load(true)
    expect(push).not.toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled()
    expect(() => watch.setLegacySyncEnabled(true)).toThrow()
    expect(() => watch.readOwnerSyncSnapshot()).toThrow()
  })

  it('refuses a target with a pending old outbox, retaining its exact original packet', async () => {
    const { getOwnerSyncTargetFingerprint } = await import('./ownerSession')
    const { openOwnerSyncOutbox, OWNER_SYNC_OUTBOX_SCHEMA } = await import('./ownerSyncOutbox')
    const { buildOwnerSyncRequest } = await import('@/utils/ownerSyncContract')
    const target = await getOwnerSyncTargetFingerprint()
    const outbox = await openOwnerSyncOutbox(indexedDB, target)
    const request = await buildOwnerSyncRequest({ request_id: 'synthetic-existing-packet-01', expected_revision: 0,
      operations: [{ key: 'asset:synthetic-cash', kind: 'manual_asset', deleted: false, changes: { name: '合成资产', cls: '现金', value: 0, note: null } }] })
    const entry = { schema: OWNER_SYNC_OUTBOX_SCHEMA, state: 'prepared' as const, rawBody: request.rawBody, requestHash: request.requestHash }
    await outbox.compareAndSwap(0, entry); outbox.close()
    const watch = await createStore(), backup = await watch.createLocalWorkspaceBackup()
    await expect(watch.activateLocalWorkspace(backup.raw, backup.sha256)).rejects.toThrow()
    expect(watch.authorityState).toBe('legacy')
    const reopened = await openOwnerSyncOutbox(indexedDB, target)
    expect((await reopened.read()).entry).toEqual(entry)
    reopened.close()
  })

  it('restores additional records with raw archives, but refuses same-key conflicts and tombstone revival', async () => {
    const codec = await import('@/utils/owner-workspace-backup')
    const watch = await createStore()
    await watch.add('510300', '保留基金')
    const original = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(original.raw, original.sha256)
    const raw = JSON.stringify([{ code: '000001', name: '新基金', position_kind: 'holding', shares: 0,
      cost: null, target_weight: 0, updated_at: '2026-01-02T00:00:00Z', local_pending: true }])
    const addition = await codec.buildOwnerLegacyWorkspaceBackup({ sourceKey: 'sinan_watchlist_v2', v1Raw: null, v2Raw: raw })
    expect(await watch.previewLocalWorkspaceRestore(addition.raw, addition.sha256)).toMatchObject({ added: 1, conflicts: 0 })
    await watch.restoreLocalWorkspaceBackup(addition.raw, addition.sha256)
    expect(watch.recordsFor('000001')[0]).toMatchObject({ shares: 0, cost: null, target_weight: 0, updated_at: '2026-01-02T00:00:00Z', local_pending: true })
    expect(watch.has('510300')).toBe(true)
    expect((await watch.createLocalWorkspaceBackup()).envelope.restoredArchives[0].v2Raw).toBe(raw)
    await watch.remove('000001', undefined, { confirmed: true })
    const tombstone = JSON.stringify(watch.entries)
    expect(await watch.previewLocalWorkspaceRestore(addition.raw, addition.sha256)).toMatchObject({ conflicts: 1, canApply: false })
    await expect(watch.restoreLocalWorkspaceBackup(addition.raw, addition.sha256)).rejects.toThrow()
    expect(JSON.stringify(watch.entries)).toBe(tombstone)
    expect(watch.has('000001')).toBe(false)
    await watch.add('000001', '显式重新关注')
    expect(watch.recordsFor('000001')[0]).toMatchObject({ position_kind: 'watch', shares: null, cost: null, target_weight: null, local_pending: true })
  })

  it('invalidates a restore preview after an intervening real IDB edit', async () => {
    const codec = await import('@/utils/owner-workspace-backup'), watch = await createStore()
    const original = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(original.raw, original.sha256)
    const raw = JSON.stringify([{ code: '000001', name: '复导基金', position_kind: 'watch', updated_at: '2026-01-02' }])
    const addition = await codec.buildOwnerLegacyWorkspaceBackup({ sourceKey: 'sinan_watchlist_v2', v1Raw: null, v2Raw: raw })
    await watch.previewLocalWorkspaceRestore(addition.raw, addition.sha256)
    await watch.add('510300', '中途编辑')
    await expect(watch.restoreLocalWorkspaceBackup(addition.raw, addition.sha256)).rejects.toThrow()
    expect(watch.has('000001')).toBe(false)
    expect(watch.has('510300')).toBe(true)
  })

  it('does not silently complete or re-adopt after an interrupted locator completion', async () => {
    const authority = await import('./owner-authority'), originalOpen = authority.openOwnerAuthority
    let failCompletion = true
    vi.spyOn(authority, 'openOwnerAuthority').mockImplementation(async (factory, hint) => {
      const handle = await originalOpen(factory, hint)
      return { ...handle, completeActivation(expected) {
        if (failCompletion) { failCompletion = false; return Promise.reject(new Error('synthetic interruption after adoption')) }
        return handle.completeActivation(expected)
      } }
    })
    const watch = await createStore()
    await watch.add('510300', '原备份基金')
    const backup = await watch.createLocalWorkspaceBackup()
    await expect(watch.activateLocalWorkspace(backup.raw, backup.sha256)).rejects.toThrow('synthetic interruption')
    expect(watch.authorityState).toBe('activating')
    watch.$dispose(); setActivePinia(createPinia())
    const reloaded = await createStore()
    expect(reloaded.authorityState).toBe('activating')
    expect(reloaded.entries).toEqual([])
    await expect(reloaded.add('000001', '不得自动写')).rejects.toThrow()
    await reloaded.activateLocalWorkspace(backup.raw, backup.sha256)
    expect(reloaded.authorityState).toBe('idb')
    expect(reloaded.recordsFor('510300')[0].name).toBe('原备份基金')
    const { getOwnerSyncTargetFingerprint } = await import('./ownerSession'), storage = await import('./owner-workspace')
    const handle = await storage.openOwnerWorkspace(indexedDB, await getOwnerSyncTargetFingerprint(), { existingOnly: true })
    const state = await handle.readLocalState({ signal: new AbortController().signal, assertActive() {} })
    expect(state.snapshot.localVersion).toBe(1)
    handle.close()
  })

  it('keeps the entire IDB authority pending without rewriting historical false entry flags', async () => {
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', name: '未确认旧基金', position_kind: 'watch', updated_at: '2026-01-02' }]))
    const watch = await createStore(), backup = await watch.createLocalWorkspaceBackup()
    expect(backup.envelope.entries[0].local_pending).toBe(false)
    await watch.activateLocalWorkspace(backup.raw, backup.sha256)
    expect((await watch.createLocalWorkspaceBackup()).envelope.entries[0].local_pending).toBe(false)
    expect(watch.localPending).toBe(true)
    expect(watch.hasLocalChanges('510300')).toBe(true)
    expect(watch.hasLocalChanges('000001')).toBe(true)
  })

  it('rejects a second store editing a stale IDB preimage without publishing or overwriting its draft', async () => {
    const first = await createStore(), backup = await first.createLocalWorkspaceBackup()
    await first.activateLocalWorkspace(backup.raw, backup.sha256)
    setActivePinia(createPinia())
    const second = await createStore(), before = JSON.stringify(second.entries)
    await first.add('510300', '先提交基金')
    await expect(second.add('000001', '陈旧草稿')).rejects.toThrow()
    expect(second.authorityState).toBe('blocked')
    expect(JSON.stringify(second.entries)).toBe(before)
    await first.load(true)
    expect(first.has('510300')).toBe(true)
    expect(first.has('000001')).toBe(false)
  })

  it('keeps a local unknown write blocked until explicit matching recent-receipt reconciliation, never replaying it', async () => {
    const storage = await import('./owner-workspace'), originalOpen = storage.openOwnerWorkspace
    const editCalls = vi.fn()
    vi.spyOn(storage, 'openOwnerWorkspace').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      return { ...handle, async editLocal(request, guard) {
        editCalls()
        await handle.editLocal(request, guard)
        handle.close() // a real timeout/closed DB handle cannot be reused for the receipt read
        throw new Error('synthetic lost post-commit response')
      } }
    })
    const watch = await createStore(), backup = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(backup.raw, backup.sha256)
    await expect(watch.add('510300', '结果待核基金')).rejects.toThrow('lost post-commit')
    expect(watch.authorityState).toBe('blocked')
    expect(watch.hasPendingLocalWorkspaceEdit).toBe(true)
    expect(watch.has('510300')).toBe(false)
    await expect(watch.add('000001', '不得重发')).rejects.toThrow()
    await watch.reconcileLocalWorkspaceEdit()
    expect(watch.authorityState).toBe('idb')
    expect(watch.has('510300')).toBe(true)
    expect(watch.has('000001')).toBe(false)
    expect(editCalls).toHaveBeenCalledTimes(1)
    expect(watch.hasPendingLocalWorkspaceEdit).toBe(false)
  })

  it('manually accepts an already committed active locator after its completion response was lost, without replay', async () => {
    const authority = await import('./owner-authority'), originalOpen = authority.openOwnerAuthority
    const completions = vi.fn()
    vi.spyOn(authority, 'openOwnerAuthority').mockImplementation(async (factory, hint) => {
      const handle = await originalOpen(factory, hint)
      return { ...handle, async completeActivation(expected) {
        completions()
        await handle.completeActivation(expected)
        throw new Error('synthetic pointer committed but response unknown')
      } }
    })
    const watch = await createStore(), backup = await watch.createLocalWorkspaceBackup()
    await expect(watch.activateLocalWorkspace(backup.raw, backup.sha256)).rejects.toThrow('pointer committed')
    expect(watch.authorityState).toBe('activating')
    await watch.activateLocalWorkspace(backup.raw, backup.sha256)
    expect(watch.authorityState).toBe('idb')
    expect(completions).toHaveBeenCalledTimes(1)
    const { getOwnerSyncTargetFingerprint } = await import('./ownerSession'), storage = await import('./owner-workspace')
    const handle = await storage.openOwnerWorkspace(indexedDB, await getOwnerSyncTargetFingerprint(), { existingOnly: true })
    expect((await handle.readLocalState({ signal: new AbortController().signal, assertActive() {} })).snapshot.localVersion).toBe(1)
    handle.close()
  })

  it('keeps checked metadata initialization usable when an optional BroadcastChannel is denied', async () => {
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new DOMException('synthetic denied', 'SecurityError') } })
    const watch = await createStore()
    expect(watch.authorityState).toBe('legacy')
    await watch.add('510300', '不依赖消息通道')
    expect(watch.has('510300')).toBe(true)
  })

  it('keeps missing historical timestamps null in the real restored view instead of inventing an import time', async () => {
    const codec = await import('@/utils/owner-workspace-backup')
    const entry = { key: '000001::', kind: 'watch' as const, deleted: false, local_pending: false,
      values: { name: '未知时间基金', shares: null, cost: null, target_weight: null } }
    const sourceArchive = { sourceKey: null, v1Raw: null, v2Raw: null } as const
    const backup = await codec.buildOwnerWorkspaceBackup({ snapshot: { localVersion: 1, entries: [entry], legacy: null },
      metadata: { schema: 'owner-workspace-local-1', adoption: { id: 'synthetic-old-adoption', hash: '1'.repeat(64),
        backupSha256: '2'.repeat(64), sourceArchive, localVersion: 1 }, recentEdit: null,
      displayTimes: [{ key: entry.key, updated_at: null }], restoredArchives: [] } })
    const watch = await createStore(), original = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(original.raw, original.sha256)
    await watch.previewLocalWorkspaceRestore(backup.raw, backup.sha256)
    await watch.restoreLocalWorkspaceBackup(backup.raw, backup.sha256)
    expect(watch.recordsFor('000001')[0].updated_at).toBeNull()
    expect(watch.items[0].added_at).toBeNull()
    expect(watch.localPending).toBe(true)
    expect((await watch.createLocalWorkspaceBackup()).envelope.displayTimes[0].updated_at).toBeNull()
  })

  it('does not replace the original recent-receipt identity with a second in-flight local edit', async () => {
    const storage = await import('./owner-workspace'), originalOpen = storage.openOwnerWorkspace
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), entered = vi.fn()
    vi.spyOn(storage, 'openOwnerWorkspace').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      return { ...handle, async editLocal(request, guard) { entered(); await gate; return handle.editLocal(request, guard) } }
    })
    const watch = await createStore(), backup = await watch.createLocalWorkspaceBackup()
    await watch.activateLocalWorkspace(backup.raw, backup.sha256)
    const first = watch.add('510300', '唯一在途编辑')
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1))
    await expect(watch.add('000001', '不能替换标识')).rejects.toThrow(WatchMutationError)
    release(); await first
    expect(watch.authorityState).toBe('idb')
    expect(watch.has('510300')).toBe(true)
    expect(watch.has('000001')).toBe(false)
    expect(watch.hasPendingLocalWorkspaceEdit).toBe(false)
    expect(entered).toHaveBeenCalledTimes(1)
  })

  it.each(['activating', 'active'] as const)('does not apply a late Gist pull after a persisted %s switch without hint events', async phase => {
    store.set('sinan_gist_token', 'synthetic-token')
    setLegacySyncConsent(true)
    const watch = await createStore()
    await watch.add('510300', '原本机基金')
    let finish!: (rows: gist.WatchEntry[]) => void
    const pull = vi.spyOn(gist, 'pullEntries').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const applied = vi.spyOn(gist, 'confirmEntriesApplied'), sync = vi.spyOn(gist, 'getSyncTime')
    const pending = watch.pull()
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1))
    const { openOwnerAuthority } = await import('./owner-authority')
    const other = await openOwnerAuthority(indexedDB, localStorage)
    const activating = await other.beginActivation(await other.read(), 'a'.repeat(64), 'synthetic-other-activation', 'b'.repeat(64))
    if (phase === 'active') await other.completeActivation(activating)
    other.close() // no BC message or synthetic StorageEvent was delivered
    expect(watch.authorityState).toBe('legacy')
    const before = localValue(), memory = JSON.stringify(watch.entries), write = vi.spyOn(localStorage, 'setItem')
    sync.mockClear()
    finish([{ code: '000001', name: '迟到旧源', updated_at: '2099-01-01T00:00:00Z' }])
    await expect(pending).resolves.toBe(false)
    expect(localValue()).toBe(before)
    expect(JSON.stringify(watch.entries)).toBe(memory)
    expect(write.mock.calls.filter(([key]) => key === 'sinan_watchlist_v2')).toEqual([])
    expect(applied).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(watch.authorityState).toBe(phase === 'active' ? 'blocked' : 'activating')
    expect(getLegacySyncConsent()).toBe(false)
  })

  it.each(['activating', 'active'] as const)('does not locally acknowledge a late Gist upload after a persisted %s switch without hint events', async phase => {
    store.set('sinan_gist_token', 'synthetic-token')
    setLegacySyncConsent(true)
    const watch = await createStore()
    await watch.add('510300', '原本机基金')
    let finish!: (success: boolean) => void
    const push = vi.spyOn(gist, 'pushEntries').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const pending = watch.push()
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    const { openOwnerAuthority } = await import('./owner-authority')
    const other = await openOwnerAuthority(indexedDB, localStorage)
    const activating = await other.beginActivation(await other.read(), 'a'.repeat(64), 'synthetic-other-activation', 'b'.repeat(64))
    if (phase === 'active') await other.completeActivation(activating)
    other.close()
    expect(watch.authorityState).toBe('legacy')
    const before = localValue(), memory = JSON.stringify(watch.entries), sync = vi.spyOn(gist, 'getSyncTime')
    finish(true)
    await expect(pending).resolves.toBe(false)
    expect(sync).not.toHaveBeenCalled()
    expect(watch.lastSync).toBe('')
    expect(localValue()).toBe(before)
    expect(JSON.stringify(watch.entries)).toBe(memory)
    expect(push).toHaveBeenCalledTimes(1) // no attempt to undo or replay the already sent request
    expect(watch.authorityState).toBe(phase === 'active' ? 'blocked' : 'activating')
    expect(watch.localPending).toBe(true)
  })

})
