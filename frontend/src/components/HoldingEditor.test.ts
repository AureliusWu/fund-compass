import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useWatchlistStore } from '@/stores/watchlist'
import HoldingEditor from './HoldingEditor.vue'

const dialogs = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('vant', () => ({ showConfirmDialog: dialogs.confirm }))

interface Node { tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, unknown> }
const node = (tag = 'root', text = ''): Node => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, value) => { item.text = value }, setElementText: (item, value) => { item.text = value; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
    item.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item)
  },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const text = (item: Node): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(text).join(' ')
function find(root: Node, predicate: (item: Node) => boolean): Node | undefined {
  if (predicate(root)) return root
  for (const child of root.children) { const found = find(child, predicate); if (found) return found }
}
async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); await nextTick() }
const storage = new Map<string, string>()
const stored = () => storage.get('sinan_watchlist_v2')
const mounted: Array<() => void> = []
const stores: ReturnType<typeof useWatchlistStore>[] = []
let watch: ReturnType<typeof useWatchlistStore>
async function mount(code = '510300') {
  const root = node(), visible = ref(true)
  const app = renderer.createApp({ setup: () => () => visible.value ? h(HoldingEditor, { code, name: '合成基金', onClose: () => { visible.value = false } }) : null })
  app.component('VanPopup', defineComponent({ setup: (_props, { slots }) => () => h('popup', slots.default?.()) }))
  app.component('VanButton', defineComponent({ setup: (_props, { attrs, slots }) => () => h('button', attrs, slots.default?.()) }))
  app.component('VanField', defineComponent({
    props: ['name', 'label', 'modelValue', 'disabled'], emits: ['update:modelValue'],
    setup: (props, { emit }) => () => h('field', { name: props.name, disabled: props.disabled, value: props.modelValue, onInput: (value: string) => emit('update:modelValue', value) }, props.label),
  }))
  app.component('VanRadioGroup', defineComponent({
    props: ['modelValue'], emits: ['update:modelValue'],
    setup: (props, { emit, slots }) => () => h('mode', { value: props.modelValue, onChoose: (value: string) => emit('update:modelValue', value) }, slots.default?.()),
  }))
  app.component('VanRadio', defineComponent({ setup: (_props, { slots }) => () => h('radio', slots.default?.()) }))
  app.mount(root); mounted.push(() => app.unmount()); await settle(); return root
}
async function edit(root: Node, name: string, value: string) {
  const field = find(root, item => item.tag === 'field' && item.props.name === name)!
  expect(field).toBeDefined(); (field.props.onInput as (value: string) => void)(value); await settle()
}
async function holding(root: Node) { (find(root, item => item.tag === 'mode')!.props.onChoose as (value: string) => void)('holding'); await settle() }
async function submit(root: Node) {
  const form = find(root, item => item.tag === 'form')!
  ;(form.props.onSubmit as (event: object) => void)({ preventDefault() {} }); await settle()
}
async function click(root: Node, attribute: string, value: string) {
  const button = find(root, item => item.tag === 'button' && item.props[attribute] === value)!
  expect(button).toBeDefined(); (button.props.onClick as () => void)(); await settle()
}

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => storage.delete(key) })
  setActivePinia(createPinia())
  watch = useWatchlistStore(); stores.push(watch)
  dialogs.confirm.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); stores.splice(0).forEach(item => item.$dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real HoldingEditor SFC local interactions', () => {
  it('saves an explicit zero-share holding with true zero cost and target', async () => {
    const root = await mount(); await holding(root)
    await edit(root, 'shares', '0'); await edit(root, 'cost', '0'); await edit(root, 'target', '0')
    expect(text(root)).toContain('尚未同步至新版私人存储')
    await submit(root)
    expect(watch.entries[0]).toMatchObject({ position_kind: 'holding', shares: 0, cost: 0, target_weight: 0 })
    expect(watch.holdingsFor('510300')).toEqual([])
    expect(find(root, item => item.tag === 'popup')).toBeUndefined()
  })

  it('saves blank cost/target as unknown, not zero', async () => {
    const root = await mount(); await holding(root); await edit(root, 'shares', '100.25'); await submit(root)
    expect(watch.entries[0]).toMatchObject({ shares: 100.25, cost: null, target_weight: null })
    expect(watch.entries[0]).not.toHaveProperty('holding_version')
  })

  it('cancel discards a draft without writing or changing the original record', async () => {
    watch.setHolding('510300', 100, 1)
    const before = stored(), rows = JSON.stringify(watch.entries)
    const root = await mount(); await edit(root, 'shares', '200'); await edit(root, 'account', '银行')
    await click(root, 'data-action', 'cancel')
    expect(stored()).toBe(before); expect(JSON.stringify(watch.entries)).toBe(rows)
    expect(dialogs.confirm).not.toHaveBeenCalled()
  })

  it.each(['', '-1', 'NaN', 'Infinity', '1e3'])('rejects invalid shares %s and leaves the original unchanged', async (value) => {
    watch.setHolding('510300', 100, 1)
    const before = stored(), root = await mount()
    await edit(root, 'shares', value); await submit(root)
    expect(text(root)).toContain('请检查基金代码')
    expect(stored()).toBe(before)
    expect(watch.entries[0].shares).toBe(100)
  })

  it('rejects a rename collision and does not silently overwrite the destination', async () => {
    watch.setHolding('510300', 100, 1, undefined, '支付宝')
    watch.setHolding('510300', 50, 2, undefined, '券商')
    const before = stored(), root = await mount()
    await edit(root, 'account', ' 券商 '); await submit(root)
    expect(text(root)).toContain('目标账户已有记录')
    expect(stored()).toBe(before)
    expect(watch.holdingsFor('510300')).toHaveLength(2)
  })

  it('renames one account and leaves exactly one live holding plus a tombstone', async () => {
    watch.setHolding('510300', 100, 1, undefined, '支付宝')
    const root = await mount(); await edit(root, 'account', ' 券商 '); await submit(root)
    expect(watch.activeHoldings.map(row => row.id)).toEqual(['510300::券商'])
    expect(watch.entries.find(row => row.id === '510300::支付宝')?.deleted).toBe(true)
  })

  it('reports local storage failure without publishing a partially edited holding', async () => {
    watch.setHolding('510300', 100, 1)
    const before = stored(), root = await mount()
    await edit(root, 'cost', '')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    await submit(root)
    expect(text(root)).toContain('原记录未修改')
    expect(stored()).toBe(before)
    expect(watch.entries[0].cost).toBe(1)
  })

  it('rejects a draft whose original record changed while the form was open', async () => {
    watch.setHolding('510300', 100, 1)
    const root = await mount(); await edit(root, 'shares', '200')
    watch.setHolding('510300', 101, 1)
    const before = stored(); await submit(root)
    expect(text(root)).toContain('记录已变化')
    expect(stored()).toBe(before)
    expect(watch.entries[0].shares).toBe(101)
  })

  it('canceling the actual delete confirmation preserves all account rows', async () => {
    watch.setHolding('510300', 0, null)
    watch.setHolding('510300', 10, 1, undefined, '支付宝')
    dialogs.confirm.mockRejectedValueOnce('cancel')
    const before = stored(), root = await mount()
    await click(root, 'data-remove', '510300::')
    expect(dialogs.confirm).toHaveBeenCalledTimes(1)
    expect(stored()).toBe(before)
    expect(watch.recordsFor('510300')).toHaveLength(2)
  })

  it('confirmed ungrouped deletion affects only that row, not every account', async () => {
    watch.setHolding('510300', 0, null)
    watch.setHolding('510300', 10, 1, undefined, '支付宝')
    const root = await mount(); await click(root, 'data-remove', '510300::')
    expect(dialogs.confirm.mock.calls[0][0].message).toContain('未分组')
    expect(watch.recordsFor('510300').map(row => row.account)).toEqual(['支付宝'])
  })

  it('an unmounted editor cannot apply a delayed confirmation', async () => {
    watch.setHolding('510300', 0, null)
    let resolve!: () => void
    dialogs.confirm.mockReturnValueOnce(new Promise<void>(done => { resolve = done }))
    const before = stored(), root = await mount()
    await click(root, 'data-remove', '510300::')
    await click(root, 'data-action', 'cancel')
    resolve(); await settle()
    expect(stored()).toBe(before)
    expect(watch.recordsFor('510300')).toHaveLength(1)
  })
})
