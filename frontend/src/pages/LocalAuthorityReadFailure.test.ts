import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from '@/stores/watchlist'
import AssetsPage from './AssetsPage.vue'
import LookthroughPage from './LookthroughPage.vue'

const mocks = vi.hoisted(() => ({ detail: vi.fn(), lookthrough: vi.fn(), snapshot: vi.fn(), manualSnapshot: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('vant', () => ({ showToast: vi.fn() }))
vi.mock('@/stores/funds', () => ({ useFundsStore: () => ({ detail: mocks.detail }) }))
vi.mock('@/utils/estimate', async original => ({ ...await original<typeof import('@/utils/estimate')>(), fetchEstimates: vi.fn(async () => new Map()) }))
vi.mock('@/utils/lookthrough', async original => ({ ...await original<typeof import('@/utils/lookthrough')>(), computeLookthrough: mocks.lookthrough }))
vi.mock('@/utils/snapshots', async original => ({ ...await original<typeof import('@/utils/snapshots')>(), loadSnapshots: () => [], takeDailySnapshot: mocks.snapshot, takeSnapshot: mocks.manualSnapshot }))
vi.mock('@/components/Chart.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/Icon.vue', () => ({ default: { render: () => null } }))

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
const apps: Array<() => void> = []
let store: ReturnType<typeof useWatchlistStore>
let data: Map<string, string>
async function mount(component: Component) {
  const root = node(), app = renderer.createApp(component), errors = vi.fn()
  app.config.errorHandler = errors
  for (const name of ['nav-bar', 'button', 'empty', 'cell', 'icon', 'field', 'cell-group', 'loading', 'progress']) app.component(`van-${name}`, defineComponent({ props: ['description'], setup: (props, { attrs, slots }) => () => h(`test-${name}`, attrs, [props.description, slots.default?.(), slots.right?.()]) }))
  app.component('van-dialog', defineComponent({ setup: () => () => null }))
  app.mount(root); apps.push(() => app.unmount()); await nextTick(); return { root, errors }
}
beforeEach(() => {
  data = new Map([['sinan_watchlist_v2', JSON.stringify([{ code: '000001', id: '000001::银行', name: '先前本机持仓', account: '银行', position_kind: 'holding', shares: 10, cost: 1, target_weight: null, updated_at: '2026-10-01T00:00:00Z' }])]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('indexedDB', new IDBFactory())
  mocks.detail.mockReset().mockResolvedValue({ latest_nav: 2, type: '混合型', nav_history: [] })
  mocks.lookthrough.mockReset(); mocks.snapshot.mockReset().mockReturnValue([]); mocks.manualSnapshot.mockReset().mockReturnValue([])
  setActivePinia(createPinia()); store = useWatchlistStore()
})
afterEach(() => { apps.splice(0).forEach(unmount => unmount()); store.$dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real local authority read failure views', () => {
  it('does not record or display an Assets portfolio if authority becomes blocked while public details are pending', async () => {
    let finish!: (value: object) => void
    mocks.detail.mockImplementationOnce(() => new Promise<object>(resolve => { finish = resolve }))
    const { root, errors } = await mount(AssetsPage)
    await vi.waitFor(() => expect(mocks.detail).toHaveBeenCalledTimes(1))
    expect(store.authorityState).toBe('legacy')
    store.authorityState = 'blocked'; store.localStorageError = true
    finish({ latest_nav: 2, type: '混合型', nav_history: [] })
    await vi.waitFor(() => expect(output(root)).toContain('本机持仓权威无法安全读取'))
    expect(all(root).some(item => item.tag === 'test-loading')).toBe(false)
    expect(all(root).some(item => item.props.class === 'big')).toBe(false)
    expect(mocks.snapshot).not.toHaveBeenCalled(); expect(mocks.manualSnapshot).not.toHaveBeenCalled()
    expect(store.entries[0].shares).toBe(10); expect(errors).not.toHaveBeenCalled()
  })

  it('rejects a late Lookthrough computation when shared authority becomes blocked and does not label it a new result', async () => {
    let finish!: (value: object) => void
    mocks.lookthrough.mockImplementationOnce(() => new Promise<object>(resolve => { finish = resolve }))
    const { root, errors } = await mount(LookthroughPage)
    await vi.waitFor(() => expect(mocks.lookthrough).toHaveBeenCalledTimes(1))
    expect(store.authorityState).toBe('legacy')
    store.authorityState = 'blocked'
    finish({ stocks: [{ code: '600001', name: '不应回填的迟到穿透', value: 10, pct: 50, funds: 1 }], industries: [], totalValue: 20, coveredValue: 10, source: 'top10', stockDisclosureDates: [], industryDisclosureDates: [], hasUndatedStockFallback: false })
    await vi.waitFor(() => expect(output(root)).toContain('本机持仓权威无法安全读取'))
    expect(all(root).some(item => item.tag === 'test-loading')).toBe(false)
    expect(output(root)).not.toContain('不应回填的迟到穿透')
    expect(all(root).some(item => item.props.class === 'sum-row')).toBe(false)
    expect(store.entries[0].shares).toBe(10); expect(errors).not.toHaveBeenCalled()
  })

  it.each([{ name: 'Assets', component: AssetsPage }, { name: 'Lookthrough', component: LookthroughPage }])('$name stops loading, shows unknown authority and never draws a zero/empty portfolio on initial rejection', async ({ component }) => {
    vi.stubGlobal('indexedDB', undefined)
    const original = data.get('sinan_watchlist_v2'), { root, errors } = await mount(component)
    await vi.waitFor(() => expect(output(root)).toContain('本机持仓权威无法安全读取'))
    expect(all(root).some(item => item.tag === 'test-loading')).toBe(false)
    expect(output(root)).toContain('未回退旧存储')
    expect(output(root)).not.toContain('还没有持仓'); expect(output(root)).not.toContain('无可穿透的持仓')
    expect(all(root).some(item => typeof item.props.class === 'string' && ['big', 'sum-row'].includes(item.props.class))).toBe(false)
    expect(errors).not.toHaveBeenCalled(); expect(mocks.detail).not.toHaveBeenCalled(); expect(mocks.lookthrough).not.toHaveBeenCalled()
    expect(mocks.snapshot).not.toHaveBeenCalled(); expect(data.get('sinan_watchlist_v2')).toBe(original)
    expect(store.authorityState).toBe('blocked'); expect(store.hasLocalChanges()).toBe(true)
  })

  it.each([{ name: 'Assets', component: AssetsPage }, { name: 'Lookthrough', component: LookthroughPage }])('$name preserves previously known rows when a later authority read is rejected', async ({ component }) => {
    await store.initialize()
    const before = JSON.stringify(store.entries), original = data.get('sinan_watchlist_v2')
    vi.spyOn(store, 'load').mockRejectedValueOnce(new Error('synthetic recheck failed'))
    const { root, errors } = await mount(component)
    await vi.waitFor(() => expect(output(root)).toContain('本机持仓权威无法安全读取'))
    expect(JSON.stringify(store.entries)).toBe(before); expect(data.get('sinan_watchlist_v2')).toBe(original)
    expect(all(root).some(item => item.tag === 'test-loading')).toBe(false)
    expect(mocks.snapshot).not.toHaveBeenCalled(); expect(mocks.detail).not.toHaveBeenCalled(); expect(mocks.lookthrough).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled()
    if (component === AssetsPage) expect(output(root)).toContain('保留 1 条先前已知账户持仓')
  })
})
