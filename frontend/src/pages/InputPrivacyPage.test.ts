import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import type { WatchEntry } from '@/utils/gist'
import { getLegacySyncConsent, setLegacySyncConsent } from '@/utils/cloud-consent'
import FundDetailPage from './FundDetailPage.vue'
import PortfolioLabPage from './PortfolioLabPage.vue'
import AssetsPage from './AssetsPage.vue'

const mocks = vi.hoisted(() => ({
  entries: [] as WatchEntry[], analyze: vi.fn(), detail: vi.fn(), load: vi.fn(),
  toggle: vi.fn(), remove: vi.fn(), confirm: vi.fn(), toast: vi.fn(),
  lab: vi.fn(), decisions: vi.fn(), pushManual: vi.fn(), pullManual: vi.fn(),
  snapDaily: vi.fn(), snapManual: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { code: '000001' } }), useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('vant', () => ({ showToast: mocks.toast, showConfirmDialog: mocks.confirm }))
vi.mock('@/stores/watchlist', () => ({ useWatchlistStore: () => ({
  get activeHoldings() { return mocks.entries }, hasToken: true, load: mocks.load,
  hasLocalChanges: () => false,
  has: () => mocks.entries.length > 0, toggle: mocks.toggle, remove: mocks.remove,
  recordsFor: (code: string) => mocks.entries.filter(row => row.code === code),
  entrySnapshot: (id: string) => JSON.stringify(mocks.entries.find(row => row.id === id)),
}) }))
vi.mock('@/stores/funds', () => ({ useFundsStore: () => ({ analyze: mocks.analyze, detail: mocks.detail }) }))
vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(), postPortfolioLab: mocks.lab, postPortfolioDecisions: mocks.decisions }))
vi.mock('@/utils/manualAssets', async original => ({ ...await original<typeof import('@/utils/manualAssets')>(), pushManualAssets: mocks.pushManual, pullManualAssets: mocks.pullManual }))
vi.mock('@/utils/estimate', () => ({
  fetchEstimate: async () => null, fetchEstimates: async () => new Map(),
  latestNavMove: () => null, preferredDailyMove: () => null, estimateDataFreshness: () => 'unknown',
}))
vi.mock('@/utils/holdings', () => ({ getHoldings: async () => [] }))
vi.mock('@/utils/interpret', () => ({ templateInterpret: () => null }))
vi.mock('@/utils/snapshots', async original => ({ ...await original<typeof import('@/utils/snapshots')>(), loadSnapshots: () => [], takeDailySnapshot: mocks.snapDaily, takeSnapshot: mocks.snapManual }))
vi.mock('@/components/Chart.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/DcaCalc.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/DecisionCard.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/FundDetailV8Panel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/StarRating.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/Icon.vue', () => ({ default: { render: () => null } }))

interface Node { tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, unknown> }
const node = (tag = 'root', text = ''): Node => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
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
const all = (item: Node): Node[] => [item, ...item.children.flatMap(all)]
const mounted: Array<() => void> = []
const storage = new Map<string, string>()
async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); await nextTick() }
async function mount(component: Component) {
  const root = node()
  const app = renderer.createApp(component)
  for (const name of ['nav-bar', 'button', 'loading', 'empty', 'cell', 'icon', 'dialog', 'field', 'pull-refresh', 'skeleton', 'cell-group', 'progress']) {
    app.component(`van-${name}`, defineComponent({
      props: ['description', 'title', 'label', 'name', 'modelValue', 'show', 'beforeClose'],
      setup(props, { attrs, slots }) { return () => h(`test-${name}`, { ...attrs, ...props }, [props.description, props.title, props.label, slots.default?.(), slots.right?.(), slots.value?.()]) },
    }))
  }
  app.mount(root); mounted.push(() => app.unmount()); await settle()
  return root
}
const entry = (account = '合成账户', target: number | null = 100, shares = 10): WatchEntry => ({
  code: '000001', id: `000001::${account}`, account, name: '合成基金', position_kind: 'holding',
  shares, cost: 1, target_weight: target, updated_at: '2026-10-01T00:00:00Z',
})
const analysis = (name = '公开合成基金') => ({
  detail: { code: '000001', name, type: '指数型', latest_nav: 2, latest_nav_date: '2026-10-01', nav_history: [] },
  score: null, signal: null, backtest: null, decision: { code: '000001' },
})
function button(root: Node, label: string) { return all(root).find(item => item.tag === 'test-button' && text(item).trim() === label)! }
function click(item: Node) { expect(item).toBeDefined(); (item.props.onClick as () => void)() }
beforeEach(() => {
  storage.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  setLegacySyncConsent(false)
  vi.stubGlobal('fetch', vi.fn())
  mocks.entries = [entry()]
  for (const mock of [mocks.analyze, mocks.detail, mocks.load, mocks.toggle, mocks.remove, mocks.confirm, mocks.toast, mocks.lab, mocks.decisions, mocks.pushManual, mocks.pullManual, mocks.snapDaily, mocks.snapManual]) mock.mockReset()
  mocks.load.mockResolvedValue(undefined)
  mocks.detail.mockResolvedValue(analysis().detail)
  mocks.analyze.mockResolvedValue(analysis())
  mocks.confirm.mockResolvedValue(undefined)
  mocks.snapDaily.mockReturnValue([]); mocks.snapManual.mockReturnValue([])
})
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); setLegacySyncConsent(false); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real Detail local-input privacy', () => {
  it('mount and refresh send only public fund identity, never local holding or target', async () => {
    const root = await mount(FundDetailPage)
    expect(mocks.analyze.mock.calls).toEqual([['000001', { force: false }]])
    expect(text(root)).toContain('不使用本机持仓、成本或目标权重')
    const refresh = all(root).find(item => item.tag === 'test-pull-refresh')!
    ;(refresh.props.onRefresh as () => void)(); await settle()
    expect(mocks.analyze.mock.calls.at(-1)).toEqual(['000001', { force: true }])
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.lab).not.toHaveBeenCalled()
  })

  it('ignores an older analysis that completes after a newer refresh', async () => {
    const finishes: Array<(value: ReturnType<typeof analysis>) => void> = []
    mocks.analyze.mockImplementation(() => new Promise(resolve => finishes.push(resolve)))
    const root = await mount(FundDetailPage)
    const refresh = all(root).find(item => item.tag === 'test-pull-refresh')!
    ;(refresh.props.onRefresh as () => void)(); await settle()
    finishes[1](analysis('新公开分析')); await settle()
    finishes[0](analysis('迟到旧分析')); await settle()
    expect(text(root)).toContain('新公开分析')
    expect(text(root)).not.toContain('迟到旧分析')
  })

  it('requires real confirmation for a zero-share holding and preserves it on cancel', async () => {
    mocks.entries = [entry('合成零份', 0, 0)]
    mocks.toggle.mockRejectedValue({ code: 'requires-confirmation' })
    mocks.confirm.mockRejectedValue('cancel')
    const root = await mount(FundDetailPage)
    click(all(root).find(item => item.tag === 'test-icon' && item.props.name === 'star')!); await settle()
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.entries[0].shares).toBe(0)
  })

  it('binds a confirmed multi-account removal to exact captured snapshots', async () => {
    mocks.entries = [entry('A', 50), entry('B', 50)]
    mocks.toggle.mockRejectedValue({ code: 'requires-confirmation' })
    const root = await mount(FundDetailPage)
    click(all(root).find(item => item.tag === 'test-icon' && item.props.name === 'star')!); await settle()
    expect(mocks.remove).toHaveBeenCalledWith('000001', undefined, { confirmed: true, expected: mocks.entries.map(row => ({ id: row.id, snapshot: JSON.stringify(row) })) })
  })
})

describe('real Lab local draft and scoped-analysis boundary', () => {
  it('never automatically POSTs a complete portfolio and keeps targets editable locally', async () => {
    const root = await mount(PortfolioLabPage)
    expect(mocks.lab).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(text(root)).toContain('本机组合草稿')
    expect(text(root)).toContain('不会自动发送私人权重')
    const run = button(root, '私人组合分析待启用')
    expect(run.props.disabled).toBe(true)
    click(run); await settle() // even a synthetic bypass of disabled UI is no-network.
    expect(mocks.lab).not.toHaveBeenCalled()
    const input = all(root).find(item => item.tag === 'input')!
    ;(input.props.onInput as (event: unknown) => void)({ target: { value: '0' } }); await settle()
    expect(input.props.value).toBe(0)
    expect(text(root)).toContain('系统不会自动归一化')
    expect(mocks.lab).not.toHaveBeenCalled()
  })

  it('sums complete cross-account targets and preserves missing coverage rather than last-wins', async () => {
    mocks.entries = [entry('A', 40), entry('B', 60)]
    let root = await mount(PortfolioLabPage)
    expect(all(root).find(item => item.tag === 'input')?.props.value).toBe(100)
    expect(mocks.detail).toHaveBeenCalledTimes(1)
    mounted.pop()!()
    mocks.entries = [entry('A', null), entry('B', 60)]
    root = await mount(PortfolioLabPage)
    expect(all(root).find(item => item.tag === 'input')?.props.value).toBe('')
    expect(text(root)).toContain('目标权重缺失')
    expect(mocks.lab).not.toHaveBeenCalled()
  })

  it('does not fill late public NAVs into an unmounted local draft', async () => {
    let finish!: (value: unknown) => void
    mocks.detail.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const root = await mount(PortfolioLabPage)
    mounted.pop()!()
    finish(analysis().detail); await settle()
    expect(text(root)).not.toContain('合成基金')
    expect(mocks.lab).not.toHaveBeenCalled()
  })

  it('keeps weights and total unknown for duplicate account inputs rather than displaying a filtered 100%', async () => {
    mocks.entries = [entry('A', 40), entry('A', 60)]
    const root = await mount(PortfolioLabPage)
    expect(text(root)).toContain('账户重复')
    expect(text(root)).toContain('当前 --')
    expect(text(root)).toContain('已定价组合金额：--')
    expect(mocks.lab).not.toHaveBeenCalled()
  })
})

describe('real Assets manual input privacy and zero semantics', () => {
  it('disables cloud actions by default and rejects direct handler invocation without consent', async () => {
    const root = await mount(AssetsPage)
    expect(getLegacySyncConsent()).toBe(false)
    for (const label of ['上传', '下载合并']) {
      const action = button(root, label)
      expect(action.props.disabled).toBe(true)
      click(action); await settle()
    }
    expect(mocks.pushManual).not.toHaveBeenCalled()
    expect(mocks.pullManual).not.toHaveBeenCalled()
    expect(text(root)).toContain('保存 Token 不代表同意上传')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects blank/invalid amounts without closing the form and preserves a real zero locally', async () => {
    const root = await mount(AssetsPage)
    click(button(root, '新增')); await settle()
    const dialog = all(root).find(item => item.tag === 'test-dialog' && item.props.title === '手工资产')!
    const close = dialog.props.beforeClose as (action: string) => boolean
    expect(close('confirm')).toBe(false)
    const field = all(root).find(item => item.tag === 'test-field' && item.props.label === '市值')!
    for (const value of ['Infinity', '-1', 'not-money']) {
      ;(field.props['onUpdate:modelValue'] as (value: string) => void)(value); await settle()
      expect(close('confirm')).toBe(false)
    }
    ;(field.props['onUpdate:modelValue'] as (value: string) => void)('0'); await settle()
    expect(close('confirm')).toBe(true); await settle()
    expect(JSON.parse(storage.get('sinan_manual_assets_v1') || '[]')[0].value).toBe(0)
    expect(text(root)).toContain('已保存在本机，未同步到云端')
    expect(mocks.pushManual).not.toHaveBeenCalled()
  })

  it('does not treat unreadable manual storage as zero or snapshot a fund-only total', async () => {
    storage.set('sinan_manual_assets_v1', 'synthetic-invalid-json')
    const root = await mount(AssetsPage)
    expect(text(root)).toContain('总资产（本地手工资产未知）')
    expect(text(root)).toContain('不能把未读出的金额按 0 纳入完整组合')
    expect(mocks.snapDaily).not.toHaveBeenCalled()
    const snapshot = button(root, '拍快照')
    expect(snapshot.props.disabled).toBe(true)
    click(snapshot); await settle()
    expect(mocks.snapManual).not.toHaveBeenCalled()
    expect(storage.get('sinan_manual_assets_v1')).toBe('synthetic-invalid-json')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([null, undefined])('keeps an explicit holding with unknown shares %s from becoming a filtered complete total', async shares => {
    const unknown = { ...entry('未知账户'), code: '000002', id: '000002::未知账户', shares }
    mocks.entries = [entry(), unknown]
    const root = await mount(AssetsPage)
    expect(text(root)).toContain('不能把筛选后的记录当成完整组合')
    expect(text(root)).toContain('总资产（数据未完整或金额超限）')
    expect(text(root)).not.toContain('100.0%')
    expect(mocks.snapDaily).not.toHaveBeenCalled()
    const snapshot = button(root, '拍快照')
    expect(snapshot.props.disabled).toBe(true)
    click(snapshot); await settle()
    expect(mocks.snapManual).not.toHaveBeenCalled()
    const diagnostic = button(root, '运行诊断（风格箱 · 压力测试 · 再平衡 · 相关性）')
    expect(diagnostic.props.disabled).toBe(true)
    click(diagnostic); await settle()
    expect(text(root)).toContain('不能计算组合诊断')
  })

  it.each(['duplicate', 'invalid-account'])('rejects %s identity inputs instead of trusted account sums', async kind => {
    const second = kind === 'duplicate'
      ? { ...entry('A'), account: ' A ' }
      : { ...entry('B'), account: 123 as unknown as string }
    mocks.entries = [entry('A'), second]
    const root = await mount(AssetsPage)
    expect(text(root)).toContain('不能把筛选后的记录当成完整组合')
    expect(text(root)).not.toContain('100.0%')
    expect(mocks.snapDaily).not.toHaveBeenCalled()
    expect(button(root, '拍快照').props.disabled).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores valid pure watches and real zero-share records economically without treating them as unknown', async () => {
    mocks.entries = [entry('A'), entry('零份', 0, 0), {
      ...entry('仅观察', null), position_kind: 'watch', shares: null, cost: null,
    }]
    const root = await mount(AssetsPage)
    expect(text(root)).not.toContain('不能把筛选后的记录当成完整组合')
    expect(mocks.snapDaily).toHaveBeenCalledWith(20, 10, expect.any(Date), expect.any(Array))
    expect(button(root, '拍快照').props.disabled).toBe(false)
    expect(mocks.entries[1].shares).toBe(0)
    expect(mocks.entries[2].shares).toBeNull()
  })

  it.each(['upload', 'download'])('does not let an old %s result claim or overwrite a new local manual draft', async operation => {
    setLegacySyncConsent(true)
    let finish!: (value: unknown) => void
    const request = operation === 'upload' ? mocks.pushManual : mocks.pullManual
    request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const root = await mount(AssetsPage)
    click(button(root, operation === 'upload' ? '上传' : '下载合并')); await settle()
    click(button(root, '新增')); await settle()
    const field = all(root).find(item => item.tag === 'test-field' && item.props.label === '市值')!
    ;(field.props['onUpdate:modelValue'] as (value: string) => void)('200'); await settle()
    const dialog = all(root).find(item => item.tag === 'test-dialog' && item.props.title === '手工资产')!
    expect((dialog.props.beforeClose as (action: string) => boolean)('confirm')).toBe(true); await settle()
    finish(operation === 'upload' ? true : []); await settle()
    expect(text(root)).toContain('200.00')
    expect(text(root)).toContain('已保存在本机，未同步到云端')
    expect(text(root)).not.toContain('已上传旧版 Gist 云备份')
    expect(text(root)).not.toContain('已合并旧版 Gist 云备份到本机')
    expect(JSON.parse(storage.get('sinan_manual_assets_v1') || '[]')[0].value).toBe(200)
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('本地记录已变化'))
  })
})
