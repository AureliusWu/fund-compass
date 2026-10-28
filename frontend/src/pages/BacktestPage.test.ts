import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from '@/stores/watchlist'
import BacktestPage from './BacktestPage.vue'

const queries = vi.hoisted(() => ({ backtest: vi.fn(), detail: vi.fn(), calibration: vi.fn() }))
vi.mock('@/stores/funds', () => ({ useFundsStore: () => ({ backtest: queries.backtest, detail: queries.detail }) }))
vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(), getCalibration: queries.calibration }))
vi.mock('@/stores/ownerSession', async original => ({ ...await original<typeof import('@/stores/ownerSession')>(), getOwnerSyncTargetFingerprint: async () => 'a'.repeat(64) }))
vi.mock('@/components/Chart.vue', () => ({ default: { render: () => null } }))

interface Node { tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, unknown> }
const node = (tag = 'root', text = ''): Node => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item) },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const all = (item: Node): Node[] => [item, ...item.children.flatMap(all)]
const output = (item: Node): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(output).join(' ')
const chips = (root: Node) => all(root).filter(item => item.tag === 'span' && typeof item.props.class === 'string' && item.props.class.split(' ').includes('chip'))
const apps: Array<() => void> = [], stores: ReturnType<typeof useWatchlistStore>[] = []
let store: ReturnType<typeof useWatchlistStore>
let data: Map<string, string>
function newStore() { setActivePinia(createPinia()); store = useWatchlistStore(); stores.push(store); return store }
async function mount() {
  const root = node(), app = renderer.createApp(BacktestPage)
  for (const name of ['nav-bar', 'button', 'empty', 'cell-group', 'divider']) app.component(`van-${name}`, defineComponent({ setup: (_props, { attrs, slots }) => () => h('section', attrs, [slots.default?.(), slots.right?.()]) }))
  app.component('van-field', defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], setup: (props, { emit }) => () => h('field', { value: props.modelValue, onInput: (value: string) => emit('update:modelValue', value) }) }))
  app.mount(root); apps.push(() => app.unmount()); await nextTick(); return root
}
beforeEach(() => {
  data = new Map([['sinan_watchlist_v2', JSON.stringify([
    { code: '000001', id: '000001::银行', name: '本机快捷基金', account: '银行', position_kind: 'holding', shares: 0, cost: 0, target_weight: null, updated_at: '2026-10-01T00:00:00Z' },
    { code: '000001', id: '000001::券商', name: '同基金第二账户', account: '券商', position_kind: 'watch', shares: null, cost: null, target_weight: null, updated_at: '2026-10-01T00:00:00Z' },
    { code: '000002', id: '000002::', name: '已删除快捷', deleted: true, position_kind: 'watch', shares: null, cost: null, target_weight: null, updated_at: '2026-10-01T00:00:00Z' },
  ])]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('fetch', vi.fn())
  queries.backtest.mockReset().mockRejectedValue(new Error('synthetic unavailable')); queries.detail.mockReset().mockRejectedValue(new Error('synthetic unavailable')); queries.calibration.mockReset().mockResolvedValue(null)
  newStore()
})
afterEach(() => { apps.splice(0).forEach(unmount => unmount()); stores.splice(0).forEach(item => item.$dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real Backtest direct-page local initialization', () => {
  it('loads local shortcuts without having visited Home, Screen or Watchlist, deduplicating accounts and preserving tombstones', async () => {
    expect(store.authorityState).toBe('unresolved'); expect(store.entries).toEqual([])
    const root = await mount()
    expect(output(root)).toContain('正在核对本机基金列表')
    await vi.waitFor(() => expect(chips(root).map(output)).toEqual(['本机快捷基金']))
    expect(store.authorityState).toBe('legacy'); expect(store.entries).toHaveLength(3)
    expect(queries.backtest).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it('opens the fixed IDB authority after a fresh store, not altered archived LS, and does not clear pending', async () => {
    await store.initialize()
    const backup = await store.createLocalWorkspaceBackup(); await store.activateLocalWorkspace(backup.raw, backup.sha256)
    store.$dispose(); newStore()
    data.set('sinan_watchlist_v2', JSON.stringify([{ code: '000099', name: '归档不可回退', updated_at: '2026-10-01T00:00:00Z' }]))
    const root = await mount()
    await vi.waitFor(() => expect(chips(root).map(output)).toEqual(['本机快捷基金']))
    expect(output(root)).not.toContain('归档不可回退'); expect(store.authorityState).toBe('idb')
    expect(store.hasLocalChanges()).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('makes an unavailable authority visible and never revives LS shortcuts; a public code query remains independent', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const root = await mount()
    await vi.waitFor(() => expect(output(root)).toContain('本机基金列表无法安全读取，不代表没有记录'))
    expect(chips(root)).toEqual([]); expect(store.entries).toEqual([])
    expect(store.authorityState).toBe('blocked'); expect(store.hasLocalChanges()).toBe(true)
    const field = all(root).find(item => item.tag === 'field')!
    ;(field.props.onInput as (value: string) => void)('000001'); await nextTick()
    const run = all(root).find(item => item.tag === 'section' && output(item).trim() === '开始回测' && typeof item.props.onClick === 'function')!
    await (run.props.onClick as () => Promise<void>)(); await nextTick()
    expect(queries.backtest).toHaveBeenCalledWith('000001'); expect(queries.detail).toHaveBeenCalledWith('000001')
    expect(queries.calibration).toHaveBeenCalledWith('000001')
    expect(data.get('sinan_watchlist_v2')).toContain('本机快捷基金')
  })

  it('hides retained shortcuts immediately if local authority becomes blocked after a successful load', async () => {
    const root = await mount(); await vi.waitFor(() => expect(chips(root)).toHaveLength(1))
    store.authorityState = 'blocked'; await nextTick()
    expect(chips(root)).toEqual([]); expect(output(root)).toContain('未回退旧存储')
    expect(store.entries).toHaveLength(3)
  })
})
