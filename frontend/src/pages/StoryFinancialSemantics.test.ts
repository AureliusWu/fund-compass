import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { compileStoryData, storyCoverageDateText, type RawStoryHolding } from '@/utils/story'
import { FREE_TEXT_AI_UNAVAILABLE } from '@/utils/ai'
import StoryPage from './StoryPage.vue'

const mocks = vi.hoisted(() => ({
  activeHoldings: [] as Array<{
    code: string
    name?: string
    shares?: number | null
    cost?: number | null
    account?: string
    id?: string
    position_kind?: 'holding' | 'watch'
    deleted?: boolean
  }>,
  load: vi.fn(),
  detail: vi.fn(),
  signal: vi.fn(),
  score: vi.fn(),
  fetchEstimates: vi.fn(),
  moves: new Map<string, {
    change: number | null
    baseNav: number | null
    label: string
    sourceNote: string
    date?: string
  }>(),
}))

vi.mock('@/stores/watchlist', () => ({
  useWatchlistStore: () => ({ load: mocks.load, activeHoldings: mocks.activeHoldings }),
}))
vi.mock('@/stores/funds', () => ({
  useFundsStore: () => ({ detail: mocks.detail, signal: mocks.signal, score: mocks.score }),
}))
vi.mock('@/utils/estimate', () => ({
  fetchEstimates: mocks.fetchEstimates,
  latestNavMove: () => null,
  estimateDataFreshness: (estimate: { freshness?: string } | null) => estimate?.freshness || 'fresh',
  preferredDailyMove: (estimate: { code?: string } | null) => estimate?.code
    ? mocks.moves.get(estimate.code) ?? null
    : null,
}))
vi.mock('@/components/Chart.vue', () => ({ default: { render: () => null } }))

interface HostNode {
  type: string
  text: string
  children: HostNode[]
  parent: HostNode | null
  props: Record<string, unknown>
}

function hostNode(type = 'root', text = ''): HostNode {
  return { type, text, children: [], parent: null, props: {} }
}

const renderer = createRenderer<HostNode, HostNode>({
  createElement: type => hostNode(type),
  createText: text => hostNode('text', text),
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

function text(node: HostNode): string {
  return (node.type === 'comment' ? '' : node.text) + node.children.map(text).join(' ')
}

function all(node: HostNode): HostNode[] {
  return [node, ...node.children.flatMap(all)]
}

const mounted: Array<() => void> = []
async function mount(component: Component): Promise<HostNode> {
  const root = hostNode()
  const app = renderer.createApp({ render: () => h(component) })
  const passthrough = defineComponent({
    inheritAttrs: false,
    setup: (_props, { attrs, slots }) => () => h('section', attrs, slots.default?.()),
  })
  const button = defineComponent({
    inheritAttrs: false,
    setup: (_props, { attrs, slots }) => () => h('button', attrs, slots.default?.()),
  })
  for (const name of ['VanLoading', 'VanEmpty', 'VanCell']) app.component(name, passthrough)
  app.component('VanNavBar', defineComponent({
    inheritAttrs: false,
    setup: (_props, { attrs, slots }) => () => h('nav', attrs, [slots.default?.(), slots.right?.()]),
  }))
  app.component('VanButton', button)
  app.mount(root)
  mounted.push(() => app.unmount())
  for (let index = 0; index < 40; index++) await Promise.resolve()
  await nextTick()
  return root
}

function holding(overrides: Partial<RawStoryHolding> = {}): RawStoryHolding {
  return {
    code: '000001',
    name: '基金甲',
    type: '股票',
    shares: 100,
    cost: 1,
    nav: 1,
    navDate: '2026-09-30',
    navStale: false,
    today: 0,
    todayDate: '2026-10-01 10:00:00',
    todayStale: false,
    detailStale: false,
    signalEvidence: {
      value: '持有', coverage: 0.8, stale: false, asOfDate: '2026-09-30',
    },
    scoreEvidence: {
      score: 80, star: 4, coverage: 0.8, eligible: true, stale: false, asOfDate: '2026-09-30',
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.activeHoldings.splice(0)
  mocks.moves.clear()
  mocks.load.mockResolvedValue(undefined)
  mocks.signal.mockResolvedValue({
    signal: '持有', coverage: 0.8, data_stale: false, as_of_date: '2026-09-30',
  })
  mocks.score.mockResolvedValue({
    score: 80, star: 4, coverage: 0.8, eligible: true, data_stale: false, as_of_date: '2026-09-30',
  })
  mocks.fetchEstimates.mockImplementation(async (codes: string[]) => new Map(
    codes.map(code => [code, { code, freshness: 'fresh' }]),
  ))
})

afterEach(() => {
  mounted.splice(0).forEach(unmount => unmount())
  vi.restoreAllMocks()
})

describe('Story financial aggregation boundary', () => {
  const now = Date.parse('2026-10-01T12:00:00+08:00')

  it('keeps missing NAV, cost and daily move null and refuses partial portfolio totals', () => {
    const result = compileStoryData({
      holdings: [
        holding(),
        holding({
          code: '000002', name: '基金乙', nav: null, navDate: null,
          cost: null, today: null, todayDate: null,
        }),
      ],
      // Legacy caller totals must not be able to bypass the completeness gate.
      totalValue: 100,
      totalCost: 100,
      totalProfit: 0,
      totalRate: 0,
      todayEst: 0,
    }, { now })

    expect(result.holdings[1]).toMatchObject({
      value: null, costBasis: null, profit: null, rate: null, today: null,
    })
    expect(result).toMatchObject({
      totalValue: null,
      pricedValue: 100,
      totalCost: null,
      knownCost: 100,
      totalProfit: null,
      totalRate: null,
      todayEst: null,
      bestHolding: null,
      worstHolding: null,
      bestToday: null,
      worstToday: null,
    })
    expect(result.coverage.valuation).toMatchObject({ complete: false, covered: 1, total: 2, missing: ['基金乙'] })
    expect(result.coverage.cost).toMatchObject({ complete: false, covered: 1, total: 2, missing: ['基金乙'] })
    expect(result.coverage.returns).toMatchObject({ complete: false, covered: 1, total: 2 })
    expect(result.coverage.today).toMatchObject({ complete: false, covered: 1, total: 2 })
  })

  it('preserves real zero profit, rate and daily move as observed values', () => {
    const result = compileStoryData({ holdings: [holding()] }, { now })

    expect(result.totalValue).toBe(100)
    expect(result.totalCost).toBe(100)
    expect(result.totalProfit).toBe(0)
    expect(result.totalRate).toBe(0)
    expect(result.todayEst).toBe(0)
    expect(result.holdings[0]).toMatchObject({ profit: 0, rate: 0, today: 0 })
    expect(result.coverage.valuation.complete).toBe(true)
    expect(result.coverage.cost.complete).toBe(true)
    expect(result.coverage.returns.complete).toBe(true)
    expect(result.coverage.today.complete).toBe(true)
  })

  it('keeps an explicit zero cost known while withholding an undefined return rate', () => {
    const result = compileStoryData({ holdings: [holding({ cost: 0 })] }, { now })

    expect(result.totalCost).toBe(0)
    expect(result.totalProfit).toBe(100)
    expect(result.totalRate).toBeNull()
    expect(result.holdings[0]).toMatchObject({ costBasis: 0, profit: 100, rate: null })
    expect(result.coverage.cost.complete).toBe(true)
    expect(result.coverage.returns.complete).toBe(false)
  })

  it('shows only real source dates and marks partial date coverage', () => {
    const result = compileStoryData({
      holdings: [
        holding({ navDate: '2026-09-29', todayDate: '2026-10-01 10:00:00' }),
        holding({ code: '000002', name: '基金乙', navDate: null, todayDate: '2026-10-01 10:05:00' }),
      ],
    }, { now })

    expect(storyCoverageDateText(result.coverage.valuation)).toBe('2026-09-29（1/2 日期可用）')
    expect(storyCoverageDateText(result.coverage.today)).toBe('2026-10-01')
    expect(storyCoverageDateText({
      complete: false, publishable: false, covered: 1, total: 2, missing: ['基金乙'], dated: 0, dates: [],
      stale: [], freshnessUnknown: [], futureDate: [],
    })).toBe('未知')
  })

  it.each([
    '2026-09-30',
    '2026-09-30 10:00',
    '2026-09-30 10:00:00',
    '2026-09-30T10:00:00',
    '2026-09-30T10:00:00.123Z',
    '2026-09-30T23:59:59-07:00',
    '2026-09-30T00:00:00+08:00',
  ])('validates %s without changing its source market date', (date) => {
    const result = compileStoryData({ holdings: [holding({
      navDate: date,
      todayDate: date,
      signalEvidence: { value: '持有', coverage: 0.8, stale: false, asOfDate: date },
      scoreEvidence: { score: 80, star: 4, coverage: 0.8, eligible: true, stale: false, asOfDate: date },
    })] }, { now })

    expect(result.holdings[0]).toMatchObject({
      navDate: '2026-09-30', todayDate: '2026-09-30',
      signalDate: '2026-09-30', scoreDate: '2026-09-30',
      signal: '持有', score: 80, star: 4,
    })
    expect(result.todayEst).toBe(0)
    expect(storyCoverageDateText(result.coverage.today)).toBe('2026-09-30')
  })

  it.each([
    '2026-09-30 garbage',
    '2026-09-30T',
    '2026-09-30 10',
    '2026-09-30T99:99',
    '2026-09-30T24:00:00',
    '2026-09-30T10:60:00',
    '2026-09-30T10:00:60',
    '2026-09-30T10:00:00garbage',
    '2026-09-30T10:00:00Zgarbage',
    '2026-09-30T10:00:00+24:00',
    '2026-09-30T10:00:00+08:60',
    '2026-09-30T10:00:00Z+08:00',
    '2026-09-30T10:00.123',
    '2026-09-31',
    '2026-02-29T10:00:00Z',
  ])('rejects malformed source date %s for daily, return and decision evidence', (date) => {
    const result = compileStoryData({ holdings: [holding({
      navDate: date,
      todayDate: date,
      signalEvidence: { value: '持有', coverage: 0.8, stale: false, asOfDate: date },
      scoreEvidence: { score: 80, star: 4, coverage: 0.8, eligible: true, stale: false, asOfDate: date },
    })] }, { now })

    expect(result.holdings[0]).toMatchObject({
      navDate: null, todayDate: null, signalDate: null, scoreDate: null,
      signal: null, score: null, star: null,
    })
    expect(result.todayEst).toBeNull()
    expect(result.bestToday).toBeNull()
    expect(result.bestHolding).toBeNull()
    expect(storyCoverageDateText(result.coverage.today)).toBe('未知')
  })

  it('marks stale finite NAVs and rejects stale legacy signal, score, ranking and daily aggregate', () => {
    const result = compileStoryData({ holdings: [holding({
      navStale: true,
      todayStale: true,
      detailStale: true,
      signalEvidence: { value: '买入', coverage: 1, stale: false, asOfDate: '2026-10-01' },
      scoreEvidence: { score: 99, star: 5, coverage: 1, eligible: true, stale: false, asOfDate: '2026-10-01' },
    })] }, { now })

    expect(result.totalValue).toBe(100)
    expect(result.coverage.valuation.stale).toEqual(['基金甲'])
    expect(result.todayEst).toBeNull()
    expect(result.bestHolding).toBeNull()
    expect(result.bestToday).toBeNull()
    expect(result.holdings[0]).toMatchObject({ signal: null, score: null, star: null })
    expect(result.signalDist).toEqual({ 未知: 1 })
    expect(result.coverage.signal.covered).toBe(0)
    expect(result.coverage.score.covered).toBe(0)
  })

  it('rejects future value dates and refuses to publish their otherwise finite totals', () => {
    const result = compileStoryData({ holdings: [holding({
      navDate: '2026-10-02',
      todayDate: '2026-10-02 09:30:00',
    })] }, { now })

    expect(result.pricedValue).toBe(100)
    expect(result.totalValue).toBeNull()
    expect(result.totalProfit).toBeNull()
    expect(result.todayEst).toBeNull()
    expect(result.coverage.valuation.futureDate).toEqual(['基金甲'])
    expect(result.coverage.today.futureDate).toEqual(['基金甲'])
    expect(storyCoverageDateText(result.coverage.valuation)).toBe('未知（未来日期已拒绝）')
  })

  it('does not add finite daily moves from different market dates', () => {
    const result = compileStoryData({ holdings: [
      holding({ today: 10, todayDate: '2026-09-30 15:00:00' }),
      holding({ code: '000002', name: '基金乙', today: -5, todayDate: '2026-10-01 10:00:00' }),
    ] }, { now })

    expect(result.coverage.today).toMatchObject({ complete: true, publishable: false, covered: 2, dated: 2 })
    expect(result.todayEst).toBeNull()
    expect(result.bestToday).toBeNull()
    expect(result.worstToday).toBeNull()
    expect(storyCoverageDateText(result.coverage.today)).toBe('2026-09-30 至 2026-10-01（跨日期）')
  })

  it('rejects finite-input aggregate and rate overflow without publishing totals or rankings', () => {
    const result = compileStoryData({ holdings: [
      holding({ shares: Number.MAX_VALUE, nav: 1, cost: 1, today: Number.MAX_VALUE }),
      holding({ code: '000002', name: '基金乙', shares: Number.MAX_VALUE, nav: 1, cost: 1, today: Number.MAX_VALUE }),
    ] }, { now })
    expect(result.pricedValue).toBeNull()
    expect(result.knownCost).toBeNull()
    expect(result.totalValue).toBeNull()
    expect(result.totalCost).toBeNull()
    expect(result.totalProfit).toBeNull()
    expect(result.todayEst).toBeNull()
    expect(result.coverage.valuation.publishable).toBe(false)
    expect(result.coverage.cost.publishable).toBe(false)
    expect(result.coverage.today.publishable).toBe(false)
    expect(result.bestToday).toBeNull()
    const extremeRate = compileStoryData({ holdings: [holding({ shares: 1, nav: Number.MAX_VALUE, cost: 1 })] }, { now })
    expect(extremeRate.holdings[0].rate).toBeNull()
    expect(extremeRate.totalRate).toBeNull()
    expect(extremeRate.bestHolding).toBeNull()
  })

  it('requires explicit 70% coverage, eligibility, freshness and dates for legacy evidence', () => {
    const trusted = compileStoryData({ holdings: [holding({
      signalEvidence: { value: '买入', coverage: 0.7, stale: false, asOfDate: '2026-10-01' },
      scoreEvidence: { score: 0, star: 0, coverage: 0.7, eligible: true, stale: false, asOfDate: '2026-10-01' },
    })] }, { now })
    expect(trusted.holdings[0]).toMatchObject({ signal: '买入', score: 0, star: 0 })

    const rejected = compileStoryData({ holdings: [holding({
      signal: '买入', score: 99, star: 5,
      signalEvidence: { value: '买入', coverage: 0.69, stale: false, asOfDate: '2026-10-01' },
      scoreEvidence: { score: 99, star: 5, coverage: 1, eligible: false, stale: false, asOfDate: '2026-10-01' },
    })] }, { now })
    expect(rejected.holdings[0]).toMatchObject({ signal: null, score: null, star: null })
    expect(rejected.signalDist).toEqual({ 未知: 1 })

    const staleOrUndated = compileStoryData({ holdings: [holding({
      signalEvidence: { value: '减仓', coverage: 1, stale: true, asOfDate: '2026-10-01' },
      scoreEvidence: { score: 90, star: 5, coverage: 1, eligible: true, stale: true, asOfDate: null },
    })] }, { now })
    expect(staleOrUndated.holdings[0]).toMatchObject({ signal: null, score: null, star: null })
    expect(staleOrUndated.coverage.signal.stale).toEqual(['基金甲'])
    expect(staleOrUndated.coverage.score.stale).toEqual(['基金甲'])
  })
})

describe('mounted Story page financial semantics', () => {
  it.each([null, undefined])('blocks complete amounts and rankings when a second explicit holding has unknown shares %s', async shares => {
    mocks.activeHoldings.push(
      { code: '000001', name: '基金甲', shares: 100, cost: 1, position_kind: 'holding' },
      { code: '000002', name: '未知份额基金', shares, cost: 1, position_kind: 'holding' },
    )
    const root = await mount(StoryPage)
    expect(text(root)).toContain('组合总额保持未知（--）')
    expect(text(root)).toContain('缺失份额不会按 0 处理')
    expect(all(root).some(node => node.props.class === 'sc-ov')).toBe(false)
    expect(text(root)).not.toContain('最佳持仓')
    expect(text(root)).not.toContain('单日最强')
    const exportButton = all(root).find(node => node.type === 'button' && text(node) === '导出长图')!
    expect(exportButton.props.disabled).toBe(true)
    expect(mocks.detail).not.toHaveBeenCalled()
    expect(mocks.fetchEstimates).not.toHaveBeenCalled()
    expect(mocks.activeHoldings[1].shares).toBe(shares)
  })

  it.each(['duplicate-account', 'invalid-shares'] as const)('fails %s closed instead of publishing a partial denominator', async kind => {
    mocks.activeHoldings.push(
      { code: '000001', name: '基金甲', shares: 100, cost: 1, account: 'A', position_kind: 'holding' },
      kind === 'duplicate-account'
        ? { code: '000001', name: '重复账户', shares: 50, cost: 1, account: ' A ', position_kind: 'holding' }
        : { code: '000002', name: '无效份额', shares: Infinity, cost: 1, position_kind: 'holding' },
    )
    const output = text(await mount(StoryPage))
    expect(output).toContain('持仓输入不完整、无效或账户重复')
    expect(output).toContain('已暂停排行和长图导出')
    expect(mocks.fetchEstimates).not.toHaveBeenCalled()
  })

  it('does not turn pure watch records into zero-valued positions or request their NAVs', async () => {
    mocks.activeHoldings.push({ code: '000001', name: '仅关注', shares: null, cost: null, position_kind: 'watch' })
    const root = await mount(StoryPage)
    expect(all(root).some(node => String(node.props.description || '').includes('仅关注基金不计入持仓金额和排行'))).toBe(true)
    expect(all(root).some(node => node.props.class === 'sc-ov')).toBe(false)
    expect(mocks.fetchEstimates).not.toHaveBeenCalled()
    expect(mocks.detail).not.toHaveBeenCalled()
    expect(mocks.activeHoldings).toHaveLength(1)
  })

  it('retains a zero-share holding record without inventing a positive position or zero portfolio', async () => {
    mocks.activeHoldings.push({ code: '000001', name: '零份记录', shares: 0, cost: 0, position_kind: 'holding' })
    const root = await mount(StoryPage)
    expect(all(root).some(node => String(node.props.description || '').includes('1 条 0 份持仓记录'))).toBe(true)
    expect(all(root).some(node => node.props.class === 'sc-ov')).toBe(false)
    expect(mocks.fetchEstimates).not.toHaveBeenCalled()
    expect(mocks.activeHoldings[0]).toMatchObject({ shares: 0, cost: 0, position_kind: 'holding' })
  })

  it('labels a retained zero-share record separately from a complete positive holding story', async () => {
    mocks.activeHoldings.push(
      { code: '000001', name: '基金甲', shares: 100, cost: 1, position_kind: 'holding' },
      { code: '000002', name: '零份记录', shares: 0, cost: null, position_kind: 'holding' },
    )
    mocks.detail.mockResolvedValue({ code: '000001', name: '基金甲', type: '股票', latest_nav: 1,
      latest_nav_date: '2026-09-30', nav_history: [], stale: false })
    const root = await mount(StoryPage)
    expect(text(root)).toContain('另有 1 条 0 份持仓记录')
    expect(all(root).filter(node => node.props.class === 'sc-ov').map(text).some(value => value.includes('总市值') && value.includes('100'))).toBe(true)
    expect(mocks.fetchEstimates).toHaveBeenCalledWith(['000001'])
    expect(mocks.detail).toHaveBeenCalledTimes(1)
    expect(mocks.activeHoldings).toHaveLength(2)
  })

  it('renders incomplete fields as -- with coverage, source date and a clearly labelled subtotal', async () => {
    mocks.activeHoldings.push(
      { code: '000001', name: '基金甲', shares: 100, cost: 1 },
      { code: '000002', name: '基金乙', shares: 100 },
    )
    mocks.detail.mockImplementation(async (code: string) => {
      if (code === '000002') throw new Error('synthetic missing detail')
      return {
        code,
        name: '基金甲',
        type: '股票',
        latest_nav: 1,
        latest_nav_date: '2026-09-30',
        stale: false,
        nav_history: [],
      }
    })
    mocks.moves.set('000001', {
      change: 0,
      baseNav: 1,
      label: '估',
      sourceNote: 'synthetic fixture',
      date: '2026-10-01 10:00:00',
    })

    const root = await mount(StoryPage)
    const overview = all(root).filter(node => node.props.class === 'sc-ov').map(text)
    const output = text(root)

    expect(overview.some(value => value.includes('市值') && value.includes('--'))).toBe(true)
    expect(overview.some(value => value.includes('累计收益') && value.includes('--'))).toBe(true)
    expect(overview.some(value => value.includes('单日变动合计') && value.includes('--'))).toBe(true)
    expect(output).toContain('净值覆盖 1/2')
    expect(output).toContain('成本覆盖 1/2')
    expect(output).toContain('单日变动覆盖 1/2')
    expect(output).toContain('数据日期 2026-09-30')
    expect(output).toContain('已定价小计 100，不代表组合总市值')
    expect(output).toContain('不发布部分持仓合计')
    expect(output).toContain('持仓收益覆盖 1/2，未通过覆盖、同日日期与新鲜度门禁，暂不排名')
    expect(output).toContain('报告生成于')
    expect(output).toContain(FREE_TEXT_AI_UNAVAILABLE)
  })

  it('labels stale NAV and blocks stale-detail signal/score from the mounted story', async () => {
    mocks.activeHoldings.push({ code: '000001', name: '基金甲', shares: 100, cost: 1 })
    mocks.detail.mockResolvedValue({
      code: '000001', name: '基金甲', type: '股票', latest_nav: 1,
      latest_nav_date: '2026-09-30', nav_history: [], stale: true,
    })
    mocks.signal.mockResolvedValue({
      signal: '买入', coverage: 1, data_stale: false, as_of_date: '2026-09-30',
    })
    mocks.score.mockResolvedValue({
      score: 99, star: 5, coverage: 1, eligible: true, data_stale: false, as_of_date: '2026-09-30',
    })

    const output = text(await mount(StoryPage))

    expect(output).toContain('总市值（含旧净值） 100')
    expect(output).toContain('旧净值：基金甲')
    expect(output).toContain('未知 1')
    expect(output).not.toContain('买入 1')
    expect(output).toContain('可信信号覆盖 0/1')
    expect(output).toContain('可信评分覆盖 0/1')
  })

  it('does not present mixed market dates as a today aggregate or extrema', async () => {
    mocks.activeHoldings.push(
      { code: '000001', name: '基金甲', shares: 100, cost: 1 },
      { code: '000002', name: '基金乙', shares: 100, cost: 1 },
    )
    mocks.detail.mockImplementation(async (code: string) => ({
      code,
      name: code === '000001' ? '基金甲' : '基金乙',
      type: '股票',
      latest_nav: 1,
      latest_nav_date: '2026-09-30',
      nav_history: [],
      stale: false,
    }))
    mocks.moves.set('000001', {
      change: 1, baseNav: 1, label: '估', sourceNote: 'synthetic', date: '2026-09-30 15:00:00',
    })
    mocks.moves.set('000002', {
      change: -1, baseNav: 1, label: '估', sourceNote: 'synthetic', date: '2026-10-01 10:00:00',
    })

    const root = await mount(StoryPage)
    const output = text(root)
    const overview = all(root).filter(node => node.props.class === 'sc-ov').map(text)

    expect(overview.some(value => value.includes('单日变动合计') && value.includes('--'))).toBe(true)
    expect(output).toContain('2026-09-30 至 2026-10-01（跨日期）')
    expect(output).toContain('来源跨日期')
    expect(output).not.toContain('今日最强')
    expect(output).not.toContain('今日最弱')
    expect(output).not.toContain('单日最强')
    expect(output).not.toContain('单日最弱')
  })
})
