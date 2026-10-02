import { describe, expect, it } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import LocalHoldingGate from './LocalHoldingGate.vue'

interface Node { type: string; text: string; props: Record<string, unknown>; children: Node[]; parent: Node | null }
const node = (type = 'root', text = ''): Node => ({ type, text, props: {}, children: [], parent: null })
const renderer = createRenderer<Node, Node>({
  createElement: type => node(type), createText: value => node('text', value), createComment: value => node('comment', value),
  setText: (item, value) => { item.text = value },
  setElementText: (item, value) => { item.text = value; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
    item.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(item)
    else parent.children.splice(index, 0, item)
  },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent,
  nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const text = (item: Node): string => (item.type === 'comment' ? '' : item.text) + item.children.map(text).join(' ')

describe('local holding action display gate', () => {
  it('does not mount action consumers for an unconfirmed local draft', async () => {
    let actionMounts = 0
    const Action = defineComponent({ setup: () => { actionMounts++; return () => h('button', '当前强动作') } })
    const pending = ref(true)
    const root = node()
    const app = renderer.createApp({ render: () => h(LocalHoldingGate, { pending: pending.value }, { default: () => h(Action) }) })
    app.component('RouterLink', defineComponent({ props: { to: String }, setup: props => () => h('a', { href: '#' + props.to }, '查看历史复盘') }))
    app.mount(root)
    expect(text(root)).toContain('尚未确认')
    expect(text(root)).not.toContain('当前强动作')
    expect(actionMounts).toBe(0)
    pending.value = false
    await nextTick()
    expect(text(root)).toContain('当前强动作')
    expect(actionMounts).toBe(1)
    pending.value = true
    await nextTick()
    expect(text(root)).not.toContain('当前强动作')
    expect(text(root)).toContain('查看历史复盘')
    app.unmount()
  })
  it('retains the existing consumer for an unchanged local state', () => {
    const root = node()
    const app = renderer.createApp({ render: () => h(LocalHoldingGate, {}, { default: () => h('article', '已确认快照') }) })
    app.mount(root)
    expect(text(root)).toContain('已确认快照')
    expect(text(root)).not.toContain('当前行动已暂停')
    app.unmount()
  })
})
