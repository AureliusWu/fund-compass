import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { entryId, migrateEntries } from '@/utils/gist'
import * as gist from '@/utils/gist'
import { getLegacySyncConsent, setLegacySyncConsent } from '@/utils/cloud-consent'
import { WatchMutationError, type HoldingInput } from '@/utils/holding-editor'
import { useWatchlistStore } from './watchlist'

const store = new Map<string, string>()
const created: ReturnType<typeof useWatchlistStore>[] = []
function createStore() { const watch = useWatchlistStore(); created.push(watch); return watch }
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
    store.clear()
    setLegacySyncConsent(false)
    setActivePinia(createPinia())
  })
  afterEach(() => { created.splice(0).forEach(watch => watch.$dispose()); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('normalizes entry id by trimmed account', () => {
    expect(entryId('510300', ' 支付宝 ')).toBe('510300::支付宝')
    expect(entryId('510300')).toBe('510300::')
  })

  it('migrates old entries with compound ids', () => {
    const rows = migrateEntries([
      { code: '510300', account: '支付宝', updated_at: '2026-07-04T00:00:00Z' },
      { code: '510300', updated_at: '2026-07-04T00:00:00Z' },
    ])
    expect(rows.map((r) => r.id)).toEqual(['510300::支付宝', '510300::'])
  })

  it('keeps same fund independent across accounts', () => {
    const watch = createStore()
    watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    expect(watch.holdingsFor('510300')).toHaveLength(2)
    expect(watch.activeHoldings.map((e) => e.id).sort()).toEqual(['510300::券商', '510300::支付宝'])
  })

  it('removes all account rows when deleting by code from code-level list', () => {
    const watch = createStore()
    watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    expect(() => watch.remove('510300')).toThrow(WatchMutationError)
    watch.remove('510300', undefined, { confirmed: true })

    expect(watch.activeHoldings).toHaveLength(0)
    expect(watch.entries.filter((e) => e.code === '510300').every((e) => e.deleted)).toBe(true)
  })

  it('can remove only one account when account is specified', () => {
    const watch = createStore()
    watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    watch.remove('510300', '支付宝', { confirmed: true })

    expect(watch.activeHoldings.map((e) => e.account)).toEqual(['券商'])
  })

  it('keeps explicit zero holding separate from watch and survives a refresh', () => {
    const watch = createStore()
    watch.saveHolding(input({ cost: 0, target_weight: 0 }))
    expect(watch.recordsFor('510300')[0]).toMatchObject({ shares: 0, cost: 0, target_weight: 0, position_kind: 'holding' })
    expect(watch.holdingsFor('510300')).toEqual([])
    expect(watch.hasLocalChanges('510300')).toBe(true)
    expect(watch.items).toHaveLength(1)
    watch.$dispose()
    setActivePinia(createPinia())
    const refreshed = createStore()
    expect(refreshed.recordsFor('510300')[0]).toMatchObject({ shares: 0, cost: 0, target_weight: 0, position_kind: 'holding' })
    expect(refreshed.hasLocalChanges('510300')).toBe(true)
  })

  it('preserves historical missing shares without manufacturing zero', () => {
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', updated_at: '2026-09-30T00:00:00Z' }]))
    const watch = createStore()
    expect(watch.entries[0].shares).toBeUndefined()
    expect(localValue()).not.toContain('shares')
  })

  it('loads the old v1 key when v2 is absent without uploading', async () => {
    store.set('sinan_watchlist_v1', JSON.stringify([{ code: '510300', shares: 100, updated_at: '2026-09-30T00:00:00Z' }]))
    const watch = createStore()
    await watch.load(true)
    expect(watch.holdingsFor('510300')).toHaveLength(1)
    expect(watch.entries[0].id).toBe('510300::')
    expect(() => watch.setHolding('510300', 101, null)).not.toThrow()
    expect(JSON.parse(localValue()!)[0]).toMatchObject({ id: '510300::', shares: 101 })
  })

  it('keeps undefined targets and clears explicitly null targets without losing zero cost', () => {
    const watch = createStore()
    watch.setHolding('510300', 10, 0, undefined, '', 35)
    watch.setHolding('510300', 10, null)
    expect(watch.entries[0]).toMatchObject({ target_weight: 35, cost: null })
    watch.setHolding('510300', 10, 0, undefined, '', null)
    expect(watch.entries[0]).toMatchObject({ target_weight: null, cost: 0 })
  })

  it('explicitly re-adding a deleted fund does not resurrect its old financial fields', () => {
    const watch = createStore()
    watch.setHolding('510300', 100, 1, undefined, '', 35)
    watch.remove('510300', '', { confirmed: true })
    watch.add('510300')
    expect(watch.recordsFor('510300')[0]).toMatchObject({ position_kind: 'watch', shares: null, cost: null, target_weight: null })
    expect(watch.holdingsFor('510300')).toEqual([])
  })

  it.each([
    { code: 'bad' }, { shares: -1 }, { shares: NaN }, { shares: Infinity },
    { shares: null }, { cost: -1 }, { cost: Infinity }, { target_weight: 101 },
    { target_weight: -1 }, { account: 'bad\naccount' },
  ])('rejects invalid holding input %j before any state/storage mutation', (bad) => {
    const watch = createStore()
    watch.add('000001')
    const before = localValue(), entries = JSON.stringify(watch.entries)
    expect(() => watch.saveHolding(input(bad))).toThrow(WatchMutationError)
    expect(localValue()).toBe(before)
    expect(JSON.stringify(watch.entries)).toBe(entries)
  })

  it('renames atomically with an old-key tombstone, without duplicate live holdings', () => {
    const watch = createStore()
    watch.setHolding('510300', 100, 1, '甲', '支付宝', 20)
    const source = { id: '510300::支付宝', snapshot: watch.entrySnapshot('510300::支付宝')! }
    watch.saveHolding(input({ account: ' 券商 ', shares: 100, cost: 1, target_weight: 20 }), source)
    expect(watch.activeHoldings).toHaveLength(1)
    expect(watch.activeHoldings[0].id).toBe('510300::券商')
    expect(watch.entries.find(row => row.id === source.id)?.deleted).toBe(true)
  })

  it('rejects rename collisions and stale draft snapshots without any mutation', () => {
    const watch = createStore()
    watch.setHolding('510300', 100, 1, undefined, '支付宝')
    watch.setHolding('510300', 50, 2, undefined, '券商')
    const source = { id: '510300::支付宝', snapshot: watch.entrySnapshot('510300::支付宝')! }
    const before = localValue()
    expect(() => watch.saveHolding(input({ account: '券商' }), source)).toThrow('目标账户已有记录')
    expect(localValue()).toBe(before)
    watch.setHolding('510300', 101, 1, undefined, '支付宝')
    const newer = localValue()
    expect(() => watch.saveHolding(input({ account: '银行' }), source)).toThrow('记录已变化')
    expect(localValue()).toBe(newer)
  })

  it('matches ungrouped explicitly and protects zero holdings and detail toggle from unconfirmed deletion', () => {
    const watch = createStore()
    watch.setHolding('510300', 0, null)
    watch.setHolding('510300', 10, 1, undefined, '支付宝')
    expect(watch.has('510300', '')).toBe(true)
    const before = localValue()
    expect(() => watch.toggle('510300')).toThrow('请明确确认')
    expect(() => watch.remove('510300', '')).toThrow('请明确确认')
    expect(localValue()).toBe(before)
    const snapshot = watch.entrySnapshot('510300::')!
    watch.remove('510300', '', { confirmed: true, expected: [{ id: '510300::', snapshot }] })
    expect(watch.has('510300', '')).toBe(false)
    expect(watch.recordsFor('510300').map(row => row.account)).toEqual(['支付宝'])
  })

  it('rejects changes during a delete confirmation', () => {
    const watch = createStore()
    watch.setHolding('510300', 0, null)
    const expected = [{ id: '510300::', snapshot: watch.entrySnapshot('510300::')! }]
    watch.setHolding('510300', 1, null)
    const before = localValue()
    expect(() => watch.remove('510300', undefined, { confirmed: true, expected })).toThrow('记录已变化')
    expect(localValue()).toBe(before)
  })

  it('publishes no in-memory change if browser persistence throws', () => {
    const watch = createStore()
    watch.setHolding('510300', 100, 1)
    const before = localValue(), rows = JSON.stringify(watch.entries)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(() => watch.setHolding('510300', 101, 2)).toThrow('原记录未修改')
    expect(localValue()).toBe(before)
    expect(JSON.stringify(watch.entries)).toBe(rows)
  })

  it('does not overwrite malformed old storage with an empty working copy', () => {
    store.set('sinan_watchlist_v2', '[null]')
    const watch = createStore()
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasLocalChanges()).toBe(true)
    expect(() => watch.add('510300')).toThrow('原记录未修改')
    expect(localValue()).toBe('[null]')
  })

  it('renders a recoverable blocked working copy when browser storage reads are denied', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    const watch = createStore()
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasToken).toBe(false)
    expect(watch.legacySyncEnabled).toBe(false)
    expect(() => watch.add('510300')).toThrow('原记录未修改')
    expect(localValue()).toBeUndefined()
  })

  it('PAT presence alone never schedules cloud work or pulls on refresh', async () => {
    vi.useFakeTimers()
    store.set('sinan_gist_token', 'synthetic-test-token')
    const push = vi.spyOn(gist, 'pushEntries'), pull = vi.spyOn(gist, 'pullEntries')
    const watch = createStore()
    watch.setHolding('510300', 100, 1)
    await watch.load(true)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(watch.push()).resolves.toBe(false)
    await expect(watch.pull()).resolves.toBe(false)
    expect(push).not.toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled()
  })

  it('cancels queued upload when consent is revoked or a Token is saved', async () => {
    vi.useFakeTimers()
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const push = vi.spyOn(gist, 'pushEntries').mockResolvedValue(true)
    const watch = createStore()
    watch.setHolding('510300', 100, 1)
    setLegacySyncConsent(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(push).not.toHaveBeenCalled()
    setLegacySyncConsent(true)
    watch.setHolding('510300', 101, 1)
    watch.setToken('synthetic-new-token')
    expect(getLegacySyncConsent()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(push).not.toHaveBeenCalled()
  })

  it('never clears the Owner pending gate on legacy upload and excludes local metadata from its payload', async () => {
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const push = vi.spyOn(gist, 'pushEntries').mockResolvedValue(true)
    const watch = createStore()
    watch.setHolding('510300', 100, 1)
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
    const watch = createStore()
    await watch.load(true)
    expect(watch.items).toEqual([])
    expect(watch.entries[0].deleted).toBe(true)
  })

  it.each(['revoke', 'local-edit', 'token-change'] as const)('rejects a late pull after %s', async (change) => {
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    let resolve!: (rows: gist.WatchEntry[]) => void
    vi.spyOn(gist, 'pullEntries').mockReturnValue(new Promise(done => { resolve = done }))
    const watch = createStore()
    const pending = watch.pull()
    if (change === 'revoke') setLegacySyncConsent(false)
    if (change === 'token-change') watch.setToken('synthetic-new-token')
    if (change === 'local-edit') watch.setHolding('510300', 123, null)
    const before = localValue()
    resolve([{ code: '000001', updated_at: '2099-01-01T00:00:00Z' }])
    await expect(pending).resolves.toBe(false)
    expect(localValue()).toBe(before)
    expect(watch.has('000001')).toBe(false)
  })

  it('rejects a second independent store saving an observed stale disk baseline without overwriting', () => {
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', shares: 100, cost: 1,
      position_kind: 'holding', updated_at: '2026-09-30T00:00:00Z' }]))
    const first = createStore()
    setActivePinia(createPinia())
    const second = createStore()
    const beforeSecond = JSON.stringify(second.entries)
    first.setHolding('510300', 200, 1)
    const current = localValue()
    const write = vi.spyOn(localStorage, 'setItem')
    expect(() => second.setHolding('510300', 150, 1)).toThrow('记录已变化')
    expect(write).not.toHaveBeenCalled()
    expect(localValue()).toBe(current)
    expect(JSON.stringify(second.entries)).toBe(beforeSecond)
    expect(second.hasLocalChanges()).toBe(true)
    expect(second.hasLocalChanges('000001')).toBe(true)
  })

  it('does not commit a late cloud pull over a second store change even before its event arrives', async () => {
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const first = createStore()
    setActivePinia(createPinia())
    const second = createStore()
    let finish!: (rows: gist.WatchEntry[]) => void
    vi.spyOn(gist, 'pullEntries').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const pending = second.pull()
    first.setHolding('510300', 200, 1)
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
    vi.useFakeTimers()
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    store.set('sinan_gist_token', 'synthetic-test-token')
    setLegacySyncConsent(true)
    const cloudPush = vi.spyOn(gist, 'pushEntries').mockResolvedValue(true)
    const cloudPull = vi.spyOn(gist, 'pullEntries')
    const watch = createStore()
    watch.setHolding('510300', 100, 1)
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
    const watch = createStore()
    const pending = watch.pull()
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

  it('preserves malformed external disk data and the old working copy while failing current actions closed', () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', shares: 100, cost: 1,
      position_kind: 'holding', updated_at: '2026-09-30T00:00:00Z' }]))
    const watch = createStore()
    const rows = JSON.stringify(watch.entries)
    store.set('sinan_watchlist_v2', '[null]')
    const write = vi.spyOn(localStorage, 'setItem')
    const cloudPush = vi.spyOn(gist, 'pushEntries'), cloudPull = vi.spyOn(gist, 'pullEntries')
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', newValue: '[null]', storageArea: localStorage }))
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasLocalChanges()).toBe(true)
    expect(JSON.stringify(watch.entries)).toBe(rows)
    expect(() => watch.setHolding('510300', 150, 1)).toThrow('原记录未修改')
    expect(localValue()).toBe('[null]')
    expect(write).not.toHaveBeenCalled()
    expect(cloudPush).not.toHaveBeenCalled(); expect(cloudPull).not.toHaveBeenCalled()
  })

  it('fails a denied commit-time storage read closed without publishing or writing the draft', () => {
    const watch = createStore()
    const rows = JSON.stringify(watch.entries)
    const originalRead = localStorage.getItem.bind(localStorage)
    vi.spyOn(localStorage, 'getItem').mockImplementation(key => {
      if (key === 'sinan_watchlist_v2') throw new DOMException('denied', 'SecurityError')
      return originalRead(key)
    })
    const write = vi.spyOn(localStorage, 'setItem')
    expect(() => watch.setHolding('510300', 100, 1)).toThrow('原记录未修改')
    expect(watch.localStorageError).toBe(true)
    expect(watch.hasLocalChanges()).toBe(true)
    expect(JSON.stringify(watch.entries)).toBe(rows)
    expect(write).not.toHaveBeenCalled()
  })

  it('reads the newest disk state instead of applying a queued stale storage-event payload', () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    const watch = createStore()
    const newer = JSON.stringify([{ code: '510300', shares: 300, cost: 1,
      position_kind: 'holding', updated_at: '2026-10-02T00:00:00Z' }])
    store.set('sinan_watchlist_v2', newer)
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', newValue: '[]', storageArea: localStorage }))
    expect(watch.entries[0].shares).toBe(300)
    expect(watch.hasLocalChanges()).toBe(true)
  })

  it('removes its exact storage listener when the independent store scope is disposed', () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    const add = vi.spyOn(browser, 'addEventListener'), remove = vi.spyOn(browser, 'removeEventListener')
    const watch = createStore()
    const listener = add.mock.calls.at(-1)![1]
    const rows = JSON.stringify(watch.entries)
    watch.$dispose()
    expect(remove).toHaveBeenCalledWith('storage', listener)
    store.set('sinan_watchlist_v2', JSON.stringify([{ code: '510300', shares: 1, updated_at: '2026-10-02T00:00:00Z' }]))
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'sinan_watchlist_v2', storageArea: localStorage }))
    expect(JSON.stringify(watch.entries)).toBe(rows)
  })
})
