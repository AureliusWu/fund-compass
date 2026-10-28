import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from '@/stores/watchlist'
import FundDetailPage from './FundDetailPage.vue'

const feedback = vi.hoisted(() => ({ toast: vi.fn(), confirm: vi.fn() }))
vi.mock('vant', () => ({ showToast: feedback.toast, showConfirmDialog: feedback.confirm }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { code: '000001' } }), useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/stores/funds', () => ({ useFundsStore: () => ({ analyze: async () => { throw new Error('synthetic unavailable') } }) }))
vi.mock('@/utils/estimate', async original => ({ ...await original<typeof import('@/utils/estimate')>(), fetchEstimate: vi.fn(async () => null) }))
vi.mock('@/utils/holdings', () => ({ getHoldings: vi.fn(async () => []) }))
vi.mock('@/components/Chart.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/FundDetailV8Panel.vue', () => ({ default: { render: () => null } }))

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
function button(root: Node) { const item = all(root).find(item => item.tag === 'button' && item.props.class === 'watch-toggle'); expect(item).toBeDefined(); return item! }
async function settle() { for (let index = 0; index < 4; index++) { await new Promise<void>(done => setImmediate(done)); await nextTick() } }
const apps: Array<() => void> = []
let store: ReturnType<typeof useWatchlistStore>
async function mount() {
  const root = node(), app = renderer.createApp(FundDetailPage)
  for (const name of ['nav-bar', 'pull-refresh', 'empty', 'button', 'skeleton', 'icon']) app.component(`van-${name}`, defineComponent({ setup: (_props, { attrs, slots }) => () => h('section', attrs, [slots.default?.(), slots.right?.()]) }))
  app.component('van-dialog', defineComponent({ setup: () => () => null }))
  app.mount(root); apps.push(() => app.unmount()); await settle(); return root
}
beforeEach(async () => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('indexedDB', new IDBFactory())
  setActivePinia(createPinia()); store = useWatchlistStore(); await store.initialize()
  feedback.toast.mockReset(); feedback.confirm.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { apps.splice(0).forEach(unmount => unmount()); store.$dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real FundDetail local writer waiting', () => {
  it('does not announce success until the local writer resolves', async () => {
    let resolve!: () => void
    vi.spyOn(store, 'toggle').mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const root = await mount(), toggle = button(root)
    const pending = (toggle.props.onClick as () => Promise<void>)(); await settle()
    expect(toggle.props.disabled).toBe(true); expect(feedback.toast).not.toHaveBeenCalled()
    resolve(); await pending; await settle()
    expect(feedback.toast).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed async local write distinct from success', async () => {
    vi.spyOn(store, 'toggle').mockRejectedValueOnce(new Error('synthetic write failure'))
    const root = await mount(); await (button(root).props.onClick as () => Promise<void>)(); await settle()
    expect(feedback.toast).toHaveBeenCalledWith('本机写入结果尚未核定；请在本机工作区核对，勿自动重试')
    expect(store.entries).toEqual([])
  })

  it('does not announce delayed success after navigation', async () => {
    let resolve!: () => void
    vi.spyOn(store, 'toggle').mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const root = await mount(), pending = (button(root).props.onClick as () => Promise<void>)()
    apps.pop()!(); resolve(); await pending; await settle()
    expect(feedback.toast).not.toHaveBeenCalled()
  })

  it.each(['unresolved', 'activating', 'blocked'] as const)('does not write while authority is %s', async state => {
    const root = await mount(), toggle = vi.spyOn(store, 'toggle')
    store.authorityState = state; await nextTick()
    expect(button(root).props.disabled).toBe(true)
    await (button(root).props.onClick as () => Promise<void>)()
    expect(toggle).not.toHaveBeenCalled()
  })
})
