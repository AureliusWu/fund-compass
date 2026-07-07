import { beforeEach, describe, expect, it } from 'vitest'

import { loadManualAssets, removeManualAsset, upsertManualAsset } from './manualAssets'

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

describe('manualAssets', () => {
  beforeEach(() => store.clear())

  it('upserts sorted manual assets', () => {
    let items = upsertManualAsset([], { name: '现金', cls: '现金', value: 1000 }, new Date('2026-07-04T00:00:00Z'))
    items = upsertManualAsset(items, { name: '黄金', cls: '商品', value: 2000 }, new Date('2026-07-04T00:00:01Z'))
    expect(items.map((a) => a.name)).toEqual(['黄金', '现金'])
    expect(loadManualAssets()).toHaveLength(2)
  })

  it('updates and removes by id', () => {
    let items = upsertManualAsset([], { id: 'cash', name: '现金', cls: '现金', value: 1000 })
    items = upsertManualAsset(items, { id: 'cash', name: '备用金', cls: '现金', value: 1200 })
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('备用金')
    expect(removeManualAsset(items, 'cash')).toEqual([])
  })
})
