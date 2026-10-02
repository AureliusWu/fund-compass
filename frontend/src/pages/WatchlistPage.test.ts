import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useWatchlistStore } from '@/stores/watchlist'
import * as gist from '@/utils/gist'
import { setLegacySyncConsent } from '@/utils/cloud-consent'
import WatchlistPage from './WatchlistPage.vue'

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), toast: vi.fn(), decision: vi.fn(), diff: vi.fn() }))
vi.mock('vant', () => ({ showConfirmDialog: mocks.confirm, showToast: mocks.toast }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/OwnerSessionPanel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(), getV8Decision: mocks.decision, getV8DecisionDiff: mocks.diff, getFunds: vi.fn() }))
vi.mock('@/utils/estimate', async original => ({ ...await original<typeof import('@/utils/estimate')>(), fetchEstimates: vi.fn(async () => new Map()), loadCachedEstimates: vi.fn(() => new Map()) }))

const source = readFileSync(new URL('./WatchlistPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('自选页 V8 快照契约', () => {
  it('只读 V8 快照与差异，不用 legacy 信号伪装', () => {
    expect(source).toContain('getV8Decision(item.code)')
    expect(source).toContain('getV8DecisionDiff(item.code)')
    expect(source).not.toContain('getDecision(item.code)')
    expect(source).toContain("message: kind === 'decision' ? '尚未生成 V8 决策快照'")
  })

  it('保留本地首屏与逐只渐进写入契约', () => {
    expect(source).toContain('hydrateLocal()\nonMounted(refresh)')
    expect(source).toContain('Promise.allSettled([refreshItems(localItems), watch.load(true)])')
    expect(source).toContain('await Promise.allSettled(items.map(async (item) => {')
    expect(source).toContain('decisions[decision.code] = decision')
    expect(source).toContain('getV8Decision(item.code).then((decision) => {')
    expect(source.indexOf('decisions[decision.code] = decision')).toBeLessThan(source.indexOf('await Promise.allSettled([decisionTask, diffTask])'))
    expect(source).toContain('type: current?.type ?? null')
  })

  it('失败会清除旧快照并保留 null，不用 0 兜底', () => {
    expect(source).toContain('const activeCodes = new Set(watch.items.map((item) => item.code))')
    expect(source).toContain('delete decisions[item.code]')
    expect(source).toContain("decisionLoadStates[item.code] = failedLoadState(error, 'decision')")
    expect(source).not.toMatch(/(?:confidence|strength|change)\s*(?:\|\||\?\?)\s*0/)
  })

  it('会话变化时同步清除已显示的私人快照并作废旧批次', () => {
    expect(source).toContain('observe(ownerSessionGeneration, () => {')
    expect(source).toContain("}, { flush: 'sync' })")
    expect(source).toContain('Object.keys(decisions).forEach(key => { delete decisions[key] })')
    expect(source).toContain('Object.keys(decisionDiffs).forEach(key => { delete decisionDiffs[key] })')
    expect(source).toContain('decisionEpochs[item.code] = (decisionEpochs[item.code] || 0) + 1')
    expect(source).toContain('if (sessionGeneration !== ownerSessionGeneration.value) return')
    expect(source).toContain('<OwnerSessionPanel />')
  })

  it('明确区分 QDII 下一净值估算与正式净值涨跌', () => {
    expect(source).toContain('watchEstimateCaption(typeOrName, estimate)')
    expect(source).toContain('watchEstimateSemanticLabel(rows[code]?.type || rows[code]?.name, estimate)')
    expect(source).toContain('QDII 的最新正式净值与下一净值估算分开标注')
  })

  it('保留本机录入入口且默认不把 PAT 等同于上传同意', () => {
    expect(source).toContain('HoldingEditor v-if="editingCode"')
    expect(source).toContain('保存 Token 不等于授权上传')
    expect(source).toContain('watch.setLegacySyncEnabled(enabled)')
    expect(source).toContain('showConfirmDialog({ title: \'启用旧版 Gist 同步？\'')
  })

  it('删除全基金账户需要明确确认并核对确认前的原行快照', () => {
    expect(source).toContain("title: '移除基金及全部账户？'")
    expect(source).toContain('watch.entrySnapshot(id)')
    expect(source).toContain('watch.remove(code, undefined, { confirmed: true, expected })')
  })

  it('本地未确认修改阻断旧决策当前动作而不篡改原快照', () => {
    expect(source).toContain('const localPending = watch.hasLocalChanges()')
    expect(source).toContain('result: localPending ? null : decisions[item.code] || null')
    expect(source).toContain('本地持仓尚未确认；旧快照不能作为当前行动')
  })
})

interface Node { tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, unknown> }
const node = (tag = 'root', text = ''): Node => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, value) => { item.text = value }, setElementText: (item, value) => { item.text = value; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item) },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const output = (item: Node): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(output).join(' ')
const all = (item: Node): Node[] => [item, ...item.children.flatMap(all)]
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); await nextTick() }
const storage = new Map<string, string>(), mounted: Array<() => void> = [], stores: ReturnType<typeof useWatchlistStore>[] = []
let watch: ReturnType<typeof useWatchlistStore>
async function mount() {
  const root = node(), app = renderer.createApp(WatchlistPage)
  for (const name of ['VanNavBar', 'VanPullRefresh', 'VanSwipeCell', 'VanCell', 'VanSkeleton', 'VanEmpty']) app.component(name, defineComponent({ setup: (_props, { attrs, slots }) => () => h('section', attrs, [slots.default?.(), slots.right?.(), slots['right-icon']?.()]) }))
  app.component('VanPopup', defineComponent({ props: ['show'], setup: (props, { slots }) => () => props.show ? h('popup', slots.default?.()) : null }))
  app.component('VanButton', defineComponent({ props: ['text'], setup: (props, { attrs, slots }) => () => h('button', attrs, [props.text, slots.default?.()]) }))
  app.component('VanField', defineComponent({ props: ['name', 'modelValue', 'label'], emits: ['update:modelValue'], setup: (props, { emit }) => () => h('field', { name: props.name, value: props.modelValue, onInput: (value: string) => emit('update:modelValue', value) }, props.label) }))
  app.component('VanRadioGroup', defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], setup: (props, { emit, slots }) => () => h('mode', { onChoose: (value: string) => emit('update:modelValue', value) }, slots.default?.()) }))
  app.component('VanRadio', defineComponent({ setup: (_props, { slots }) => () => h('radio', slots.default?.()) }))
  app.component('VanSwitch', defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], setup: (props, { emit }) => () => h('switch', { value: props.modelValue, onChoose: (value: boolean) => emit('update:modelValue', value) }) }))
  app.mount(root); mounted.push(() => app.unmount()); await settle(); return root
}
async function click(item: Node) { (item.props.onClick as (event: object) => void)({ stopPropagation() {} }); await settle() }
function strongActions(root: Node) { return all(root).filter(item => item.props.class === 'action-stamp').map(output) }
function snapshot(code: string) {
  return { code, name: '合成基金', type: '混合', action: 'buy', action_label: '买入', strength: 76, confidence: 82, summary: '当前建议',
    decision: { decision_id: 'dec_' + code, evidence_id: 'evi_' + code, fund_code: code, holding_version: 'hold_1', policy_version: 'policy_1', strategy_version: 'strategy_1', action: 'buy', strength: 76, confidence: 82, reasons: ['合成原因'], risks: [], evidence_nodes: [], created_at: '2026-10-01T00:00:00Z' },
    evidence: { evidence_id: 'evi_' + code, fund_code: code, stale_fields: [], missing_fields: [], estimate_status: 'fresh', source_states: [] }, holding: { holding_version: 'hold_1' }, policy: { policy_version: 'policy_1' }, diff: {},
  }
}
beforeEach(() => {
  storage.clear()
  storage.set('sinan_watchlist_v2', JSON.stringify(['000001', '000002'].map(code => ({ code, id: code + '::', updated_at: '2026-10-01T00:00:00Z' }))))
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => storage.delete(key) })
  setActivePinia(createPinia()); watch = useWatchlistStore(); stores.push(watch)
  mocks.confirm.mockReset().mockResolvedValue(undefined); mocks.toast.mockReset()
  mocks.decision.mockReset().mockImplementation(async (code: string) => snapshot(code)); mocks.diff.mockReset().mockResolvedValue({ previous_decision_id: null, current_decision_id: 'dec_000001', current_action: 'buy', changed: false, unchanged: [], drivers: [] })
})
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); stores.splice(0).forEach(item => item.$dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real Watchlist holding journey', () => {
  it('a real form save immediately gates old strong actions for the whole portfolio and persists on refresh', async () => {
    const root = await mount()
    expect(strongActions(root).some(text => text.includes('买入'))).toBe(true)
    await click(all(root).find(item => item.props['aria-label'] === '管理 000001 的持仓')!)
    ;(all(root).find(item => item.tag === 'mode')!.props.onChoose as (value: string) => void)('holding'); await settle()
    ;(all(root).find(item => item.tag === 'field' && item.props.name === 'shares')!.props.onInput as (value: string) => void)('0'); await settle()
    ;(all(root).find(item => item.tag === 'form')!.props.onSubmit as (event: object) => void)({ preventDefault() {} }); await settle()
    expect(watch.recordsFor('000001')[0]).toMatchObject({ shares: 0, position_kind: 'holding', local_pending: true })
    expect(strongActions(root).every(text => !text.includes('买入'))).toBe(true)
    expect(output(root)).toContain('旧快照不能作为当前行动')
    expect(mocks.decision.mock.results).toHaveLength(2)
    mounted.pop()!(); watch.$dispose(); setActivePinia(createPinia()); watch = useWatchlistStore(); stores.push(watch)
    const refreshed = await mount()
    expect(watch.localPending).toBe(true)
    expect(strongActions(refreshed).every(text => !text.includes('买入'))).toBe(true)
  })

  it('canceling the all-account delete confirmation leaves holdings unchanged', async () => {
    watch.setHolding('000001', 100, 1, undefined, '支付宝')
    watch.setHolding('000001', 0, null, undefined, '券商')
    const before = storage.get('sinan_watchlist_v2'), root = await mount()
    mocks.confirm.mockRejectedValueOnce('cancel')
    await click(all(root).find(item => item.tag === 'button' && output(item).includes('移除'))!)
    expect(mocks.confirm.mock.calls[0][0].title).toBe('移除基金及全部账户？')
    expect(storage.get('sinan_watchlist_v2')).toBe(before)
  })

  it('saving PAT does not opt in; enabling legacy sync requires the real disclosure confirmation', async () => {
    storage.set('sinan_gist_token', 'synthetic-token')
    const root = await mount()
    await click(all(root).find(item => item.props['aria-label'] === '同步自选')!)
    expect(watch.legacySyncEnabled).toBe(false)
    expect(output(root)).toContain('保存 Token 不等于授权上传')
    mocks.confirm.mockRejectedValueOnce('cancel')
    ;(all(root).find(item => item.tag === 'switch')!.props.onChoose as (value: boolean) => void)(true); await settle()
    expect(watch.legacySyncEnabled).toBe(false)
    expect(mocks.confirm.mock.calls[0][0].message).toContain('全部自选、账户持仓')
    ;(all(root).find(item => item.tag === 'switch')!.props.onChoose as (value: boolean) => void)(true); await settle()
    expect(watch.legacySyncEnabled).toBe(true)
    setLegacySyncConsent(false)
    expect(watch.legacySyncEnabled).toBe(false)
    expect(gist.hasConfig()).toBe(true)
  })
})
