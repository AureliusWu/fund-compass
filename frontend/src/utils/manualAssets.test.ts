import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getManualAssetStorageStatus, loadManualAssets, pullManualAssets, pushManualAssets, removeManualAsset, upsertManualAsset } from './manualAssets'
import { setLegacySyncConsent } from './cloud-consent'

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
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

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

  it('preserves genuine zero without coercing missing or invalid amounts', () => {
    const zero = upsertManualAsset([], { id: 'zero', name: '合成现金', cls: '现金', value: 0 })
    expect(zero[0].value).toBe(0)
    const original = store.get('sinan_manual_assets_v1')
    for (const value of [undefined, null, '', '12', Infinity, NaN, -1]) {
      expect(upsertManualAsset(zero, { id: 'bad', name: '无效', cls: '现金', value: value as number })).toBe(zero)
      expect(store.get('sinan_manual_assets_v1')).toBe(original)
    }
  })

  it.each(['固收', 'invalid', null])('rejects unsupported manual class %s without overwriting', cls => {
    const items = upsertManualAsset([], { id: 'original', name: '现金', cls: '现金', value: 20 })
    const original = store.get('sinan_manual_assets_v1')
    expect(upsertManualAsset(items, { name: '错误分类', cls: cls as never, value: 1 })).toBe(items)
    expect(store.get('sinan_manual_assets_v1')).toBe(original)
  })

  it.each([
    'not-json',
    JSON.stringify([{ id: 'one', name: '现金', cls: '现金', value: '1', updated_at: '2026-10-01T00:00:00Z' }]),
    JSON.stringify([{ id: 'one', name: '现金', cls: '现金', value: 1, updated_at: '2026-02-30T00:00:00Z' }]),
    JSON.stringify([{ id: 'one', name: '现金', cls: '现金', value: 1, updated_at: '2026-10-01T00:00:00Z', secret: 'synthetic-extra' }]),
  ])('keeps malformed historical storage intact and refuses implicit repair', raw => {
    store.set('sinan_manual_assets_v1', raw)
    expect(loadManualAssets()).toEqual([])
    expect(getManualAssetStorageStatus()).toBe('invalid')
    expect(upsertManualAsset([], { name: '新现金', cls: '现金', value: 1 })).toEqual([])
    expect(store.get('sinan_manual_assets_v1')).toBe(raw)
  })

  it('preserves previous data when browser storage rejects save', () => {
    const items = upsertManualAsset([], { id: 'original', name: '现金', cls: '现金', value: 20 })
    const original = store.get('sinan_manual_assets_v1')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    expect(upsertManualAsset(items, { name: '新现金', cls: '现金', value: 30 })).toBe(items)
    expect(getManualAssetStorageStatus()).toBe('storage-error')
    expect(store.get('sinan_manual_assets_v1')).toBe(original)
  })

  it('does not roll back another tab write between its own save and readback', () => {
    const items = upsertManualAsset([], { id: 'cash', name: '现金', cls: '现金', value: 50 }, new Date('2026-10-01T00:00:00Z'))
    const newerRaw = JSON.stringify([{ ...items[0], value: 300, updated_at: '2026-10-02T00:00:00Z' }])
    let interleaved = false
    const writes = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      store.set(key, value)
      if (key === 'sinan_manual_assets_v1' && !interleaved) {
        interleaved = true
        store.set(key, newerRaw) // The other tab wins before this tab's readback.
      }
    })
    expect(upsertManualAsset(items, { id: 'cash', name: '现金', cls: '现金', value: 200 })).toBe(items)
    expect(getManualAssetStorageStatus()).toBe('storage-error')
    expect(writes).toHaveBeenCalledOnce()
    expect(store.get('sinan_manual_assets_v1')).toBe(newerRaw)
    expect(loadManualAssets()[0].value).toBe(300)
  })

  it('ignores a cloud pull after consent revocation and leaves local assets unchanged', async () => {
    upsertManualAsset([], { id: 'original', name: '现金', cls: '现金', value: 20 })
    const original = store.get('sinan_manual_assets_v1')
    store.set('sinan_gist_token', 'synthetic-unused-token')
    store.set('sinan_gist_id', 'synthetic-gist')
    setLegacySyncConsent(true)
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = pullManualAssets()
    setLegacySyncConsent(false)
    finish(new Response(JSON.stringify({ files: { 'sinan-manual-assets.json': { content: '[]' } } })))
    await expect(pending).resolves.toBeNull()
    expect(store.get('sinan_manual_assets_v1')).toBe(original)
  })

  function authorizeCloud() {
    store.set('sinan_gist_token', 'synthetic-unused-token')
    store.set('sinan_gist_id', 'synthetic-gist')
    setLegacySyncConsent(true)
  }
  function remoteAssets(items: unknown) {
    return new Response(JSON.stringify({ files: { 'sinan-manual-assets.json': { content: JSON.stringify(items) } } }))
  }
  it.each(['edit', 'remove', 'external-storage'])('rejects a delayed cloud pull after local %s', async action => {
    let local = upsertManualAsset([], { id: 'original', name: '现金', cls: '现金', value: 20 }, new Date('2026-10-01T00:00:00Z'))
    authorizeCloud()
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = pullManualAssets()
    if (action === 'edit') local = upsertManualAsset(local, { id: 'original', name: '现金', cls: '现金', value: 200 }, new Date('2026-10-02T00:00:00Z'))
    if (action === 'remove') removeManualAsset(local, 'original')
    if (action === 'external-storage') store.set('sinan_manual_assets_v1', JSON.stringify([{ ...local[0], value: 300 }]))
    const current = store.get('sinan_manual_assets_v1')
    finish(remoteAssets([{ ...local[0], value: 100 }]))
    await expect(pending).resolves.toBeNull()
    expect(store.get('sinan_manual_assets_v1')).toBe(current)
  })

  it('rejects empty cloud data over a nonempty local work copy', async () => {
    upsertManualAsset([], { id: 'original', name: '现金', cls: '现金', value: 20 })
    const original = store.get('sinan_manual_assets_v1')
    authorizeCloud()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(remoteAssets([])))
    await expect(pullManualAssets()).resolves.toBeNull()
    expect(store.get('sinan_manual_assets_v1')).toBe(original)
  })

  it('merges non-destructively and retains missing cloud IDs and newer local values', async () => {
    let local = upsertManualAsset([], { id: 'local-only', name: '本地', cls: '现金', value: 20 }, new Date('2026-10-02T00:00:00Z'))
    local = upsertManualAsset(local, { id: 'shared', name: '较新本地', cls: '现金', value: 200 }, new Date('2026-10-02T00:00:00Z'))
    authorizeCloud()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(remoteAssets([
      { ...local.find(item => item.id === 'shared')!, name: '旧云', value: 100, updated_at: '2026-10-01T00:00:00Z' },
      { id: 'cloud-only', name: '云备份', cls: '现金', value: 10, updated_at: '2026-10-01T00:00:00Z' },
    ])))
    const merged = await pullManualAssets()
    expect(merged?.map(item => item.id)).toEqual(['shared', 'local-only', 'cloud-only'])
    expect(merged?.find(item => item.id === 'shared')?.value).toBe(200)
  })

  it('rejects same-time different payload instead of picking a last-wins amount', async () => {
    const local = upsertManualAsset([], { id: 'shared', name: '现金', cls: '现金', value: 20 }, new Date('2026-10-01T00:00:00Z'))
    const original = store.get('sinan_manual_assets_v1')
    authorizeCloud()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(remoteAssets([{ ...local[0], value: 100 }])))
    await expect(pullManualAssets()).resolves.toBeNull()
    expect(store.get('sinan_manual_assets_v1')).toBe(original)
  })

  it('does not mark an older in-flight upload as a successful backup of newer local edits', async () => {
    const local = upsertManualAsset([], { id: 'shared', name: '现金', cls: '现金', value: 20 })
    authorizeCloud()
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = pushManualAssets(local)
    upsertManualAsset(local, { id: 'shared', name: '现金', cls: '现金', value: 200 })
    const current = store.get('sinan_manual_assets_v1')
    finish(new Response(JSON.stringify({ id: 'synthetic-gist' })))
    await expect(pending).resolves.toBe(false)
    expect(store.get('sinan_manual_assets_v1')).toBe(current)
  })

  it('rejects amount-sum overflow instead of saving individually finite but unusable totals', () => {
    const local = upsertManualAsset([], { id: 'one', name: '现金', cls: '现金', value: 1e308 })
    const original = store.get('sinan_manual_assets_v1')
    expect(upsertManualAsset(local, { id: 'two', name: '第二项', cls: '现金', value: 1e308 })).toBe(local)
    expect(store.get('sinan_manual_assets_v1')).toBe(original)
  })

  it.each(['add', 'update', 'remove'])('rejects a stale tab work copy on %s without losing another tab update or new ID', action => {
    const oldTab = upsertManualAsset([], { id: 'cash', name: '现金', cls: '现金', value: 50 }, new Date('2026-10-01T00:00:00Z'))
    const otherTab = [
      { ...oldTab[0], value: 200, updated_at: '2026-10-02T00:00:00Z' },
      { id: 'other-tab', name: '另一标签页新增', cls: '现金', value: 20, updated_at: '2026-10-02T00:00:00Z' },
    ]
    const currentRaw = JSON.stringify(otherTab)
    store.set('sinan_manual_assets_v1', currentRaw)
    const result = action === 'remove' ? removeManualAsset(oldTab, 'cash') : upsertManualAsset(oldTab, {
      id: action === 'add' ? 'new' : 'cash', name: '旧标签页草稿', cls: '现金', value: 10,
    })
    expect(result).toBe(oldTab)
    expect(getManualAssetStorageStatus()).toBe('storage-error')
    expect(store.get('sinan_manual_assets_v1')).toBe(currentRaw)
    expect(loadManualAssets().find(item => item.id === 'cash')?.value).toBe(200)
    expect(loadManualAssets().find(item => item.id === 'other-tab')?.value).toBe(20)
  })

  it('compares whole local baselines without depending on array or object field order', () => {
    let current = upsertManualAsset([], { id: 'cash', name: '现金', cls: '现金', value: 50 })
    current = upsertManualAsset(current, { id: 'gold', name: '黄金', cls: '商品', value: 20 })
    const reordered = [...current].reverse().map(item => ({
      updated_at: item.updated_at, value: item.value, cls: item.cls, name: item.name, id: item.id,
    }))
    const next = upsertManualAsset(reordered, { id: 'cash', name: '现金', cls: '现金', value: 200 })
    expect(next).not.toBe(reordered)
    expect(next.find(item => item.id === 'cash')?.value).toBe(200)
    expect(next.find(item => item.id === 'gold')?.value).toBe(20)
  })
})
