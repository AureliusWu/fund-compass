import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import type { BacktestResp, FundDetail, ScoreResp, SignalResp } from '@/api/client'
import type { WatchEntry } from '@/utils/gist'
import { FREE_TEXT_AI_UNAVAILABLE } from '@/utils/ai'
import FundDetailPage from './FundDetailPage.vue'
import StoryPage from './StoryPage.vue'

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(), detail: vi.fn(), signal: vi.fn(), score: vi.fn(),
  load: vi.fn(), has: vi.fn(), holdingsFor: vi.fn(), toggle: vi.fn(), hasLocalChanges: vi.fn(),
  fetchEstimate: vi.fn(), fetchEstimates: vi.fn(), getHoldings: vi.fn(),
  entries: [] as WatchEntry[],
}))
vi.mock('@/stores/funds', () => ({ useFundsStore: () => mocks }))
vi.mock('@/stores/watchlist', () => ({ useWatchlistStore: () => ({ ...mocks, get activeHoldings() { return mocks.entries } }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { code: '000001' } }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))
vi.mock('vant', () => ({ showToast: vi.fn(), showConfirmDialog: vi.fn() }))
vi.mock('@/utils/estimate', () => ({
  fetchEstimate: mocks.fetchEstimate, fetchEstimates: mocks.fetchEstimates,
  latestNavMove: () => null, preferredDailyMove: () => null, estimateDataFreshness: () => 'unknown',
}))
vi.mock('@/utils/holdings', () => ({ getHoldings: mocks.getHoldings }))
vi.mock('@/utils/screener', () => ({ findSimilar: vi.fn() }))
vi.mock('@/components/Chart.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/StarRating.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/DecisionCard.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/FundDetailV8Panel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/DcaCalc.vue', () => ({ default: { render: () => null } }))

interface HostNode {
  type: string; text: string; children: HostNode[]; parent: HostNode | null; props: Record<string, unknown>
}
function hostNode(type = 'root', text = ''): HostNode { return { type, text, children: [], parent: null, props: {} } }
const renderer = createRenderer<HostNode, HostNode>({
  createElement: type => hostNode(type), createText: text => hostNode('text', text),
  createComment: text => hostNode('comment', text),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text; node.children = [] },
  patchProp: (node, key, _previous, next) => { node.props[key] = next },
  insert(node, parent, anchor = null) {
    if (node.parent) {
      const previous = node.parent.children.indexOf(node)
      if (previous >= 0) node.parent.children.splice(previous, 1)
    }
    node.parent = parent
    const before = anchor ? parent.children.indexOf(anchor) : -1
    if (before < 0) parent.children.push(node)
    else parent.children.splice(before, 0, node)
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})
function text(node: HostNode): string { return (node.type === 'comment' ? '' : node.text) + node.children.map(text).join(' ') }
function all(node: HostNode): HostNode[] { return [node, ...node.children.flatMap(all)] }
const mounted: (() => void)[] = []
async function mount(component: Component): Promise<HostNode> {
  const root = hostNode()
  const app = renderer.createApp({ render: () => h(component) })
  const passthrough = defineComponent({ inheritAttrs: false, setup: (_props, { attrs, slots }) => () => h('section', attrs, slots.default?.()) })
  const button = defineComponent({ inheritAttrs: false, setup: (_props, { attrs, slots }) => () => h('button', attrs, slots.default?.()) })
  const dialog = defineComponent({ props: { show: Boolean }, setup: (props, { slots }) => () => props.show ? h('dialog', slots.default?.()) : null })
  for (const name of ['VanNavBar', 'VanPullRefresh', 'VanSkeleton', 'VanEmpty', 'VanIcon', 'VanLoading', 'VanCellGroup', 'VanCell', 'VanProgress', 'VanField']) app.component(name, passthrough)
  app.component('VanButton', button)
  app.component('VanDialog', dialog)
  app.mount(root)
  mounted.push(() => app.unmount())
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await nextTick()
  return root
}

const syntheticDetail: FundDetail = {
  code: '000001', name: '合成基金', type: '股票', scale: 2, buy_rate: null, source_rate: null,
  ret_1m: 0, ret_6m: null, ret_1y: 12, ret_3y: null, rank_in_type: null, rank_total: null,
  manager: null, manager_worktime: null, latest_nav: 1, latest_nav_date: '2026-09-30', nav_history: [],
}
const component = { score: 80, weight: 0.25, effective_weight: 0.25, detail: {} }
const syntheticScore: ScoreResp = {
  code: '000001', name: '合成基金', type: '股票', score: 82, star: 4, score_version: 'synthetic',
  coverage: 0.8, eligible: true, rank_in_type: 1, rank_total: 10,
  components: { return: component, risk: component, management: component, cost: component },
}
const syntheticSignal: SignalResp = {
  code: '000001', name: '合成基金', type: '股票', signal: '买入', advice: '合成操作倾向', composite: 80, coverage: 0.8,
  layers: { valuation: { label: '中性', value: 0 }, trend: { label: '上行', value: 1 }, sentiment: { label: '中性', value: 0 } },
}
let storage: Map<string, string>
let getItem: ReturnType<typeof vi.fn>
let setItem: ReturnType<typeof vi.fn>
let removeItem: ReturnType<typeof vi.fn>
let fetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.entries = []
  storage = new Map([
    ['sinan_ai_text', JSON.stringify({ '000001': '旧 AI 缓存：合成的买卖建议，不应展示' })],
    ['sinan_ai_cfg', JSON.stringify({ provider: 'deepseek', apiKey: 'synthetic-not-a-real-key', baseUrl: '', model: '' })],
  ])
  getItem = vi.fn((key: string) => storage.get(key) ?? null)
  setItem = vi.fn((key: string, value: string) => storage.set(key, value))
  removeItem = vi.fn((key: string) => storage.delete(key))
  fetch = vi.fn().mockRejectedValue(new Error('No network allowed in this fixture'))
  vi.stubGlobal('localStorage', { getItem, setItem, removeItem })
  vi.stubGlobal('fetch', fetch)
  mocks.load.mockResolvedValue(undefined)
  mocks.has.mockReturnValue(false)
  mocks.hasLocalChanges.mockReturnValue(false)
  mocks.holdingsFor.mockReturnValue([])
  mocks.fetchEstimate.mockResolvedValue(null)
  mocks.fetchEstimates.mockResolvedValue(new Map())
  mocks.getHoldings.mockResolvedValue([])
  mocks.analyze.mockResolvedValue({ detail: syntheticDetail, score: syntheticScore, signal: syntheticSignal, backtest: null, decision: null })
})
afterEach(() => {
  mounted.splice(0).forEach(unmount => unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function expectPreservedCacheAndNoNetwork() {
  expect(getItem.mock.calls.some(([key]) => key === 'sinan_ai_text')).toBe(false)
  expect(setItem).not.toHaveBeenCalled()
  expect(removeItem).not.toHaveBeenCalled()
  expect(storage.get('sinan_ai_text')).toContain('旧 AI 缓存')
  expect(storage.get('sinan_ai_cfg')).toContain('synthetic-not-a-real-key')
  expect(fetch).not.toHaveBeenCalled()
}

describe('mounted free-text AI pause consumer', () => {
  it('shows the pause notice instead of cached AI advice and has no generating action in detail', async () => {
    const root = await mount(FundDetailPage)
    expect(text(root)).toContain(FREE_TEXT_AI_UNAVAILABLE)
    expect(text(root)).not.toContain('旧 AI 缓存')
    const pausedButton = all(root).find(node => node.type === 'button' && text(node).includes('AI 自由文本解读已暂停'))
    expect(pausedButton).toBeDefined()
    expect(pausedButton?.props.disabled).toBeDefined()
    expect(pausedButton?.props.onClick).toBeUndefined()
    const configButton = all(root).find(node => node.type === 'button' && text(node) === '配置 AI')
    expect(configButton?.props.onClick).toBeTypeOf('function')
    expectPreservedCacheAndNoNetwork()
  })

  it('renders neutral rule text for stale signals rather than new model/action advice', async () => {
    mocks.analyze.mockResolvedValue({ detail: syntheticDetail, score: syntheticScore, signal: { ...syntheticSignal, data_stale: true }, backtest: null, decision: null })
    const root = await mount(FundDetailPage)
    const interpretation = all(root).find(node => typeof node.props.class === 'string' && node.props.class.includes('card interp'))
    expect(interpretation).toBeDefined()
    expect(text(interpretation!)).toContain('暂不作当前评分与操作倾向判断')
    expect(text(interpretation!)).toContain('暂不提供操作倾向')
    expect(text(interpretation!)).not.toContain('合成操作倾向')
    expect(text(interpretation!)).not.toContain('分批 / 定投介入')
    expectPreservedCacheAndNoNetwork()
  })

  it.each([0.69, undefined, Number.NaN, Number.POSITIVE_INFINITY, 1.01])(
    'renders neutral rule text for insufficient or invalid signal coverage %s', async coverage => {
      mocks.analyze.mockResolvedValue({ detail: syntheticDetail, score: syntheticScore, signal: { ...syntheticSignal, coverage }, backtest: null, decision: null })
      const root = await mount(FundDetailPage)
      const interpretation = all(root).find(node => typeof node.props.class === 'string' && node.props.class.includes('card interp'))
      expect(interpretation).toBeDefined()
      expect(text(interpretation!)).toContain('暂不作当前评分与操作倾向判断')
      expect(text(interpretation!)).toContain('暂不提供操作倾向')
      expect(text(interpretation!)).not.toContain('合成操作倾向')
      expect(text(interpretation!)).not.toContain('当前信号「买入」')
      expect(text(interpretation!)).not.toContain('分批 / 定投介入')
      expectPreservedCacheAndNoNetwork()
    },
  )

  it('shows the summary pause in the real story card and cannot generate a fallback summary', async () => {
    // A story card now requires a real positive local position; empty/watch-only
    // inputs must not fabricate a complete zero-value portfolio for this fixture.
    mocks.entries = [{ code: '000001', account: '合成账户', id: '000001::合成账户', position_kind: 'holding', shares: 10, cost: 1, updated_at: '2026-10-01T00:00:00Z' }]
    mocks.detail.mockResolvedValue(syntheticDetail)
    mocks.signal.mockResolvedValue(syntheticSignal)
    mocks.score.mockResolvedValue(syntheticScore)
    const root = await mount(StoryPage)
    expect(text(root)).toContain('AI 摘要暂不可用')
    expect(text(root)).toContain(FREE_TEXT_AI_UNAVAILABLE)
    expect(text(root)).not.toContain('AI 点评')
    expect(text(root)).not.toContain('旧 AI 缓存')
    const pausedButton = all(root).find(node => node.type === 'button' && text(node).includes('AI 自由文本摘要已暂停'))
    expect(pausedButton).toBeDefined()
    expect(pausedButton?.props.disabled).toBeDefined()
    expect(pausedButton?.props.onClick).toBeUndefined()
    expectPreservedCacheAndNoNetwork()
  })

  it('renders a real zero excess as a tie in the separate backtest signal disclaimer', async () => {
    const backtest: BacktestResp = {
      code: '000001', name: '合成基金', available: true, outperform: 0,
      strategy: { total_return: 12, max_drawdown: 8, curve: [] },
      benchmark: { total_return: 12, max_drawdown: 9, curve: [] },
    }
    mocks.analyze.mockResolvedValue({ detail: syntheticDetail, score: syntheticScore, signal: syntheticSignal, backtest, decision: null })
    const root = await mount(FundDetailPage)
    const disclaimer = all(root).find(node => node.props.class === 'sig-disc')
    expect(disclaimer).toBeDefined()
    expect(text(disclaimer!)).toContain('本次历史回测收益持平')
    expect(text(disclaimer!)).not.toContain('择时跑赢')
    expect(text(disclaimer!)).not.toContain('通常更优')
    expect(text(disclaimer!)).toContain('历史回测不代表未来表现')
    expectPreservedCacheAndNoNetwork()
  })

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not compare missing or non-finite excess %s in the mounted signal disclaimer', async outperform => {
      const backtest = {
        code: '000001', name: '合成基金', available: true, outperform,
        strategy: { total_return: 12, max_drawdown: 8, curve: [] },
        benchmark: { total_return: 12, max_drawdown: 9, curve: [] },
      }
      mocks.analyze.mockResolvedValue({ detail: syntheticDetail, score: syntheticScore, signal: syntheticSignal, backtest, decision: null })
      const root = await mount(FundDetailPage)
      const disclaimer = all(root).find(node => node.props.class === 'sig-disc')
      expect(disclaimer).toBeDefined()
      expect(text(disclaimer!)).toContain('超额数据不足，暂不比较')
      expect(text(disclaimer!)).not.toMatch(/择时跑赢|择时跑输|收益持平|NaN|Infinity/)
      expectPreservedCacheAndNoNetwork()
    },
  )

  it.each([[2, '择时跑赢 2.00%'], [-2, '择时跑输 2.00%']] as const)(
    'limits excess %s to its historical window in the mounted disclaimer', async (outperform, expected) => {
      const backtest: BacktestResp = {
        code: '000001', name: '合成基金', available: true, outperform,
        strategy: { total_return: 12, max_drawdown: 8, curve: [] },
        benchmark: { total_return: 12, max_drawdown: 9, curve: [] },
      }
      mocks.analyze.mockResolvedValue({ detail: syntheticDetail, score: syntheticScore, signal: syntheticSignal, backtest, decision: null })
      const root = await mount(FundDetailPage)
      const disclaimer = all(root).find(node => node.props.class === 'sig-disc')
      expect(text(disclaimer!)).toContain('本次历史区间' + expected)
      expect(text(disclaimer!)).toContain('历史回测不代表未来表现')
      expectPreservedCacheAndNoNetwork()
    },
  )
})
