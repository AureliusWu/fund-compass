import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import ScreenPage from './ScreenPage.vue'
import { loadScreener } from '@/utils/screener'
import { parseQuery } from '@/utils/nlselect'
import { loadManagerDataset, type ManagerDataset } from '@/utils/managers'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vant', () => ({ showToast: vi.fn() }))
vi.mock('@/stores/watchlist', () => ({ useWatchlistStore: () => ({ load: async () => {}, has: () => false, toggle: vi.fn() }) }))
vi.mock('@/api/client', () => ({ getFunds: vi.fn() }))
vi.mock('@/utils/managers', async original => ({ ...await original<typeof import('@/utils/managers')>(), loadManagerDataset: vi.fn() }))
vi.mock('@/utils/export', () => ({ exportRankCSV: vi.fn() }))
vi.mock('@/utils/screener', async original => ({ ...await original<typeof import('@/utils/screener')>(), loadScreener: vi.fn() }))
vi.mock('@/utils/nlselect', async original => ({ ...await original<typeof import('@/utils/nlselect')>(), parseQuery: vi.fn() }))

interface Node {
  tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, unknown>; value: string
  listeners: Record<string, ((event: { target: Node }) => void)[]>
  addEventListener(name: string, listener: (event: { target: Node }) => void): void
  getRootNode(): object
}
const node = (tag = 'root', text = ''): Node => ({
  tag, text, children: [], parent: null, props: {}, value: '', listeners: {},
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener) },
  getRootNode: () => ({}),
})
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
    item.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(item)
    else parent.children.splice(index, 0, item)
  },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const text = (item: Node): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(text).join(' ')
function find(root: Node, predicate: (item: Node) => boolean): Node | undefined {
  if (predicate(root)) return root
  for (const child of root.children) { const result = find(child, predicate); if (result) return result }
}
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); await nextTick() }
const dataset = () => ({
  updated: '2026-10-01', ageDays: 0, stale: false,
  funds: [{ c: '000001', n: '合成确认基金', t: '混合型', r1m: 0, r3m: null, r6m: null, r1y: 10, r3y: null, ytd: null, fee: 0 }],
})
const mounted: (() => void)[] = []
async function mount(modeLabel = 'AI 选基') {
  const root = node()
  const app = renderer.createApp(ScreenPage)
  for (const name of ['nav-bar', 'search', 'button', 'loading', 'cell', 'icon', 'empty', 'list', 'cell-group']) {
    app.component(`van-${name}`, defineComponent({
      props: ['description', 'title', 'label'],
      setup(props, { attrs, slots }) { return () => h(`test-${name}`, attrs, [props.description, props.title, props.label, slots.default?.()]) },
    }))
  }
  app.mount(root); mounted.push(() => app.unmount())
  await settle()
  const mode = find(root, item => item.tag === 'span' && text(item) === modeLabel)!
  ;(mode.props.onClick as () => void)(); await settle()
  return root
}
async function edit(root: Node, value: string) {
  const textarea = find(root, item => item.tag === 'textarea')!
  textarea.value = value
  textarea.listeners.input.forEach(listener => listener({ target: textarea }))
  await settle()
}
async function click(root: Node, label: string) {
  const button = find(root, item => item.tag === 'test-button' && text(item).trim() === label)!
  expect(button, `button ${label}`).toBeDefined()
  ;(button.props.onClick as () => void)(); await settle()
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T13:00:00Z'))
  vi.stubGlobal('Document', class SyntheticDocument {})
  vi.stubGlobal('ShadowRoot', class SyntheticShadowRoot {})
  vi.mocked(loadScreener).mockReset().mockResolvedValue(dataset())
  vi.mocked(parseQuery).mockReset().mockResolvedValue({ r1y_min: 0, sort: 'r1y' })
  vi.mocked(loadManagerDataset).mockReset().mockResolvedValue(managerDataset())
})
afterEach(() => { mounted.splice(0).forEach(unmount => unmount()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function managerDataset(): ManagerDataset {
  return {
    managers: [{ id: '1', name: '合成经理', company: '合成公司', codes: ['000001'], names: ['合成基金'], days: '1', ret: '0', scale: '' }],
    source: 'eastmoney_fund_managers', collectedOn: '2026-09-24', fetchedAt: null, valueDate: null, ageDays: 7, stale: false,
  }
}

describe('real Screen manager SFC collection provenance', () => {
  it('shows collection age and unknown metric date, then ages at Beijing midnight without a new request', async () => {
    const root = await mount('基金经理')
    const search = find(root, item => item.tag === 'test-search')!
    ;(search.props['onUpdate:modelValue'] as (value: string) => void)('合成经理'); await settle()
    expect(text(root)).toContain('采集日 2026-09-24')
    expect(text(root)).toContain('已采集 7 天')
    expect(text(root)).toContain('指标基准日未知')
    expect(text(root)).toContain('历史任职回报 0')
    expect(text(root)).not.toContain('经理索引已超过 7 天')
    await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 1); await settle()
    expect(text(root)).toContain('已采集 8 天')
    expect(text(root)).toContain('经理索引已超过 7 天')
    expect(loadManagerDataset).toHaveBeenCalledTimes(1)
    mounted.pop()!()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['switch', 'unmount'])('cancels a manager request and ignores late results on %s', async action => {
    let finish!: (value: ManagerDataset) => void
    vi.mocked(loadManagerDataset).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const root = await mount('基金经理')
    const signal = vi.mocked(loadManagerDataset).mock.calls[0][0]?.signal
    if (action === 'unmount') mounted.pop()!()
    else {
      const mode = find(root, item => item.tag === 'span' && text(item) === '排行筛选')!
      ;(mode.props.onClick as () => void)(); await settle()
    }
    expect(signal?.aborted).toBe(true)
    finish(managerDataset()); await settle()
    expect(text(root)).not.toContain('采集日 2026-09-24')
  })
})

describe('real Screen SFC proposal lifecycle', () => {
  it('does not send duplicate paid parses while one query is running', async () => {
    let finish!: (value: { type: string }) => void
    vi.mocked(parseQuery).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const root = await mount(); await edit(root, '混合型'); await click(root, '解析条件'); await click(root, '解析条件')
    expect(parseQuery).toHaveBeenCalledTimes(1)
    finish({ type: '混合型' }); await settle()
    expect(text(root)).toContain('按近1年排序（默认）')
  })
  it('loads data before parsing and executes only after explicit condition confirmation', async () => {
    const root = await mount()
    await edit(root, '近一年收益至少0%')
    await click(root, '解析条件')
    expect(parseQuery).toHaveBeenCalledTimes(1)
    expect(vi.mocked(loadScreener).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(parseQuery).mock.invocationCallOrder[0])
    expect(text(root)).toContain('近1年≥0%')
    expect(text(root)).not.toContain('命中 1 只')
    await click(root, '确认条件并筛选')
    expect(text(root)).toContain('命中 1 只')
    expect(text(root)).toContain('合成确认基金')
  })
  it.each(['stale', 'failed', 'empty'])('does not call optional AI when data is %s, or refetch in finally', async state => {
    const root = await mount()
    if (state === 'stale') vi.mocked(loadScreener).mockResolvedValue({ ...dataset(), stale: true })
    else if (state === 'empty') vi.mocked(loadScreener).mockResolvedValue({ ...dataset(), funds: [] })
    else vi.mocked(loadScreener).mockRejectedValue(new Error('合成静态数据失败'))
    await edit(root, '混合型')
    const before = vi.mocked(loadScreener).mock.calls.length
    await click(root, '解析条件')
    expect(parseQuery).not.toHaveBeenCalled()
    expect(vi.mocked(loadScreener).mock.calls.length).toBe(before + 1)
    expect(text(root)).toContain(state === 'stale' ? 'AI 选基已暂停' : state === 'empty' ? '未调用 AI' : '合成静态数据失败')
  })
  it.each(['cancel', 'edit', 'unmount'])('does not start paid parsing after a cancelled static preflight: %s', async action => {
    const root = await mount()
    let finish!: (value: ReturnType<typeof dataset>) => void
    vi.mocked(loadScreener).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await edit(root, '混合型'); await click(root, '解析条件')
    const signal = vi.mocked(loadScreener).mock.calls.at(-1)?.[0]?.signal
    if (action === 'cancel') await click(root, '取消')
    else if (action === 'edit') await edit(root, '债券型')
    else mounted.pop()!()
    expect(signal?.aborted).toBe(true)
    finish(dataset()); await settle()
    expect(parseQuery).not.toHaveBeenCalled()
    expect(text(root)).not.toContain('确认条件并筛选')
  })
  it('blocks the whole unsupported proposal rather than returning partial matches', async () => {
    vi.mocked(parseQuery).mockResolvedValue({ type: '混合型', unsupported: ['规模'] })
    const root = await mount(); await edit(root, '规模很大且混合型'); await click(root, '解析条件')
    expect(text(root)).toContain('不支持：规模')
    expect(text(root)).toContain('未执行筛选')
    const confirm = find(root, item => item.tag === 'test-button' && text(item).trim() === '确认条件并筛选')!
    expect(confirm.props.disabled).toBe(true)
    await click(root, '确认条件并筛选')
    expect(text(root)).not.toContain('命中 1 只')
  })
  it('invalidates a reviewed proposal on edit and rechecks source freshness at confirmation', async () => {
    const root = await mount(); await edit(root, '混合型'); await click(root, '解析条件')
    await edit(root, '债券型')
    expect(text(root)).not.toContain('确认条件并筛选')
    expect(text(root)).toContain('需求已修改')
    await click(root, '解析条件')
    vi.setSystemTime(new Date('2026-10-12T13:00:00Z'))
    await click(root, '确认条件并筛选')
    expect(text(root)).toContain('排行数据已过期，未执行筛选')
    expect(text(root)).not.toContain('命中 1 只')
  })
  it('cancels and rejects old success/finally while a new parse is pending', async () => {
    let finishOld!: (value: { type: string }) => void
    let finishNew!: (value: { type: string }) => void
    vi.mocked(parseQuery).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    const root = await mount(); await edit(root, '旧需求'); await click(root, '解析条件')
    const oldSignal = vi.mocked(parseQuery).mock.calls[0][1]?.signal
    await edit(root, '新需求'); await click(root, '解析条件')
    expect(oldSignal?.aborted).toBe(true)
    finishOld({ type: '股票型' }); await settle()
    expect(text(root)).not.toContain('股票型')
    const parseButton = find(root, item => item.tag === 'test-button' && text(item).trim() === '解析条件')!
    expect(parseButton.props.loading).toBe(true)
    finishNew({ type: '混合型' }); await settle()
    expect(text(root)).toContain('原需求：新需求')
    expect(parseButton.props.loading).toBe(false)
  })
  it.each(['cancel', 'mode', 'unmount'])('invalidates and aborts pending work on %s', async action => {
    let finish!: (value: { sort: 'r1y' }) => void
    vi.mocked(parseQuery).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const root = await mount(); await edit(root, '近一年排序'); await click(root, '解析条件')
    const signal = vi.mocked(parseQuery).mock.calls[0][1]?.signal
    if (action === 'cancel') await click(root, '取消')
    else if (action === 'mode') {
      const rankMode = find(root, item => item.tag === 'span' && text(item) === '排行筛选')!
      ;(rankMode.props.onClick as () => void)(); await settle()
    } else mounted.pop()!()
    expect(signal?.aborted).toBe(true)
    finish({ sort: 'r1y' }); await settle()
    expect(text(root)).not.toContain('确认条件并筛选')
  })
})
