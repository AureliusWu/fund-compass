import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { entryId, migrateEntries } from '@/utils/gist'
import { useWatchlistStore } from './watchlist'

const store = new Map<string, string>()
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
    setActivePinia(createPinia())
  })

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
    const watch = useWatchlistStore()
    watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    expect(watch.holdingsFor('510300')).toHaveLength(2)
    expect(watch.activeHoldings.map((e) => e.id).sort()).toEqual(['510300::券商', '510300::支付宝'])
  })

  it('removes all account rows when deleting by code from code-level list', () => {
    const watch = useWatchlistStore()
    watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    watch.remove('510300')

    expect(watch.activeHoldings).toHaveLength(0)
    expect(watch.entries.filter((e) => e.code === '510300').every((e) => e.deleted)).toBe(true)
  })

  it('can remove only one account when account is specified', () => {
    const watch = useWatchlistStore()
    watch.setHolding('510300', 100, 1, '沪深300', '支付宝')
    watch.setHolding('510300', 50, 1.2, '沪深300', '券商')

    watch.remove('510300', '支付宝')

    expect(watch.activeHoldings.map((e) => e.account)).toEqual(['券商'])
  })
})
