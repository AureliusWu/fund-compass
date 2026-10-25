import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, reactive } from 'vue'
import { applyOwnerPortfolioCommand, previewOwnerPortfolioMigration, type OwnerPortfolioLocal, type OwnerPortfolioCommand } from '@/utils/ownerPortfolioLocal'
import AssetsPage from './AssetsPage.vue'

// Actual compiled Assets page and production portfolio codec/commands. This
// isolates the view facade; IDB transaction/authority coverage is a separate gate.
const mocks = vi.hoisted(() => ({ store: null as any, detail: vi.fn(), load: vi.fn(), edit: vi.fn(), toast: vi.fn(),
  snapDaily: vi.fn(), snapManual: vi.fn(), push: vi.fn(), pull: vi.fn(), reconcile: vi.fn(), charts: [] as unknown[] }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vant', () => ({ showToast: mocks.toast }))
vi.mock('@/stores/watchlist', () => ({ useWatchlistStore: () => mocks.store }))
vi.mock('@/stores/funds', () => ({ useFundsStore: () => ({ detail: mocks.detail }) }))
vi.mock('@/utils/estimate', () => ({ fetchEstimates: async () => new Map(), latestNavMove: () => null, preferredDailyMove: () => null }))
vi.mock('@/utils/manualAssets', async original => ({ ...await original<typeof import('@/utils/manualAssets')>(), pushManualAssets: mocks.push, pullManualAssets: mocks.pull }))
vi.mock('@/utils/snapshots', async original => ({ ...await original<typeof import('@/utils/snapshots')>(), takeDailySnapshot: mocks.snapDaily, takeSnapshot: mocks.snapManual }))
vi.mock('@/components/Chart.vue', () => ({ default: defineComponent({ props: ['option'], setup(props) { return () => { mocks.charts.push(props.option); return null } } }) }))
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
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)]
const output = (root: Node): string => (root.tag === '#comment' ? '' : root.text) + root.children.map(output).join(' ')
const apps: Array<() => void> = [], storage = new Map<string, string>(), businessReads: string[] = []
function find(root: Node, tag: string, label: string) { const found = all(root).find(item => item.tag === tag && output(item).trim() === label); expect(found, label).toBeDefined(); return found! }
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); await nextTick() }
async function click(item: Node) { await (item.props.onClick as () => unknown)(); await settle() }
async function mount(wait = true) {
  const root = node(), app = renderer.createApp(AssetsPage)
  for (const name of ['nav-bar', 'button', 'loading', 'empty', 'icon', 'dialog', 'field', 'progress']) app.component(`van-${name}`, defineComponent({
    props: ['description', 'title', 'label', 'name', 'modelValue', 'show', 'beforeClose'],
    setup(props, { attrs, slots }) { return () => h(`test-${name}`, { ...attrs, ...props }, [props.description, props.title, props.label, slots.default?.(), slots.right?.()]) },
  }))
  app.mount(root); apps.push(() => app.unmount()); if (wait) await settle(); return root
}
async function portfolio(manual = true): Promise<OwnerPortfolioLocal> {
  const result = await previewOwnerPortfolioMigration({ manualRaw: JSON.stringify(manual ? [{ id: 'fund|000001', name: '独立现金', cls: '现金', value: 0, updated_at: '2026-10-01T00:00:00Z' }] : []),
    snapshotsRaw: JSON.stringify([{ date: '2026-10-01', value: 10, cost: 8, holdings: [{ id: 'opaque|manual|000001', code: '000001', name: '旧不透明标识', account: '旧账户', type: '现金', value: 10, cost: 8 }] },
      { date: '2026-10-01', value: 11, cost: 9 }]) })
  expect(result.issues).toEqual([]); return result.portfolio!
}
function useV5(value: OwnerPortfolioLocal) { mocks.store.authorityState = 'idb'; mocks.store.localSyncFormat = 'v5'; mocks.store.portfolioState = value }
function field(root: Node, label: string, value: string) { const item = all(root).find(row => row.tag === 'test-field' && row.props.label === label)!; (item.props['onUpdate:modelValue'] as (value: string) => void)(value) }
async function confirmManual(root: Node) { const dialog = all(root).find(item => item.tag === 'test-dialog')!; return await (dialog.props.beforeClose as (action: string) => unknown)('confirm') }
beforeEach(() => {
  storage.clear(); businessReads.length = 0; mocks.charts.length = 0
  for (const mock of [mocks.detail, mocks.load, mocks.edit, mocks.toast, mocks.snapDaily, mocks.snapManual, mocks.push, mocks.pull, mocks.reconcile]) mock.mockReset()
  vi.stubGlobal('localStorage', { getItem: (key: string) => { if (['sinan_manual_assets_v1', 'sinan_snapshots'].includes(key)) businessReads.push(key); return storage.get(key) ?? null },
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden') }))
  mocks.store = reactive({ authorityState: 'legacy', localStorageError: false, localSyncFormat: null, portfolioState: null,
    activeHoldings: [{ id: '000001::银行|专项', code: '000001', account: '银行|专项', name: '合成基金', position_kind: 'holding', shares: 10, cost: 1, target_weight: null }],
    hasToken: true, hasPendingLocalWorkspaceEdit: false, load: mocks.load, editPortfolio: mocks.edit,
    reconcileLocalWorkspaceEdit: mocks.reconcile })
  mocks.load.mockResolvedValue(undefined); mocks.detail.mockResolvedValue({ latest_nav: 2, type: '指数型', nav_history: [] })
  mocks.snapDaily.mockReturnValue([]); mocks.snapManual.mockReturnValue([])
  mocks.edit.mockImplementation(async (command: OwnerPortfolioCommand) => { mocks.store.portfolioState = applyOwnerPortfolioCommand(mocks.store.portfolioState, command).portfolio })
})
afterEach(() => { apps.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Assets authority-first portfolio UI', () => {
  it('does not read independent business LS before the authority load resolves', async () => {
    let finish!: () => void; mocks.load.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const root = await mount(false); expect(businessReads).toEqual([])
    expect(find(root, 'test-button', '新增').props.disabled).toBe(true)
    finish(); await settle(); expect(businessReads).toEqual(['sinan_manual_assets_v1', 'sinan_snapshots'])
    expect(find(root, 'test-button', '新增').props.disabled).toBe(false)
  })
  it.each(['v3', 'v4'])('does not mix or mutate old asset files after adopting %s', async format => {
    storage.set('sinan_manual_assets_v1', 'private-invalid-original'); storage.set('sinan_snapshots', 'private-invalid-history')
    mocks.store.authorityState = 'idb'; mocks.store.localSyncFormat = format
    const root = await mount(); expect(businessReads).toEqual([])
    await vi.waitFor(() => expect(output(root)).toContain('手工资产与组合历史尚未并入共同工作区'))
    expect(output(root)).toContain('总资产（本地手工资产未知）')
    expect(find(root, 'test-button', '新增').props.disabled).toBe(true)
    await click(find(root, 'test-button', '新增')); expect(await confirmManual(root)).toBe(false)
    await click(find(root, 'test-button', '拍快照'))
    expect(mocks.edit).not.toHaveBeenCalled(); expect(mocks.snapDaily).not.toHaveBeenCalled(); expect(mocks.snapManual).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.pull).not.toHaveBeenCalled()
    expect(storage.get('sinan_manual_assets_v1')).toBe('private-invalid-original')
  })
  it('uses only v5 commands for real zero manual input and retains a tombstone without LS/Gist writes', async () => {
    useV5(await portfolio()); const root = await mount()
    expect(businessReads).toEqual([]); expect(mocks.snapDaily).not.toHaveBeenCalled()
    expect(output(root)).toContain('当前尚未接入云确认')
    await click(find(root, 'test-button', '新增')); field(root, '名称', '新零金额'); field(root, '市值', '0')
    expect(await confirmManual(root)).toBe(true); await settle()
    const command = mocks.edit.mock.calls[0][0] as OwnerPortfolioCommand
    expect(command.type).toBe('save_manual')
    if (command.type !== 'save_manual') throw new Error('wrong command')
    expect(command.key).toMatch(/^asset:[0-9a-f-]{36}$/); expect(command.values).toEqual({ name: '新零金额', cls: '现金', value: 0, note: null })
    const remove = all(root).find(item => item.props['aria-label'] === '移出 新零金额')!; await click(remove)
    expect(mocks.store.portfolioState.manual.find((row: any) => row.key === command.key).deleted).toBe(true)
    expect(mocks.store.portfolioState.manual).toHaveLength(2); expect(storage.size).toBe(0); expect(businessReads).toEqual([])
    expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.pull).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('records an explicit Shanghai balance with typed identities and null manual cost; old UTC/opaque rows stay intact', async () => {
    useV5(await portfolio()); const root = await mount()
    expect(mocks.edit).not.toHaveBeenCalled(); expect(output(root)).toContain('UTC 旧档')
    expect(output(root)).toContain('余额变化不等于现金流调整收益')
    expect(output(root)).not.toContain('opaque|manual|000001')
    const oldRow = all(root).filter(item => item.tag === 'details').at(-1)!
    await (oldRow.props.onToggle as (event: unknown) => unknown)({ target: { open: true } }); await settle()
    expect(output(root)).toContain('opaque|manual|000001')
    vi.useFakeTimers(); vi.setSystemTime('2026-10-25T16:02:00Z')
    const record = find(root, 'test-button', '记录余额观察'); expect(record.props.disabled).toBe(false); await click(record)
    const command = mocks.edit.mock.calls[0][0] as OwnerPortfolioCommand
    expect(command.type).toBe('append_observation')
    if (command.type !== 'append_observation') throw new Error('wrong command')
    expect(command.observation).toMatchObject({ kind: 'observation', observed_at: '2026-10-25T16:02:00.000Z', date: '2026-10-26', calendar: 'Asia/Shanghai', value: 20, cost: null,
      holdings: [{ kind: 'fund', key: '000001::银行|专项', value: 20, cost: 10 }, { kind: 'manual', key: 'asset:fund|000001', value: 0, cost: null }] })
    expect(mocks.store.portfolioState.history).toHaveLength(3)
    expect(mocks.store.portfolioState.history[0]).toMatchObject({ kind: 'legacy', date: '2026-10-01', calendar: 'legacy-utc', holdings: [{ id: 'opaque|manual|000001' }] })
    const chart = mocks.charts.find((option: any) => option.series?.[0]?.name === '余额' && option.series[0].data.length === 3) as any
    expect(chart.series[1].data).toEqual([8, 9, null]); expect(chart.series[1].connectNulls).toBe(false)
    expect(chart.series.map((row: any) => row.name)).not.toContain('盈亏')
    expect(mocks.snapDaily).not.toHaveBeenCalled(); expect(mocks.snapManual).not.toHaveBeenCalled(); expect(businessReads).toEqual([])
  })
  it('keeps actual v6 portfolio rows, local editing and original history visible without reading legacy storage', async () => {
    useV5(await portfolio()); mocks.store.localSyncFormat = 'v6'
    const root = await mount(); expect(businessReads).toEqual([]); expect(output(root)).toContain('UTC 旧档')
    expect(output(root)).not.toContain('还没有持仓')
    expect(output(root)).toContain('手工资产 · 共同工作区副本')
    expect(output(root)).toContain('上传和 ACK 需单独确认')
    expect(output(root)).not.toContain('当前尚未接入云确认')
    await click(find(root, 'test-button', '新增')); field(root, '名称', 'v6 本机现金'); field(root, '市值', '0')
    expect(await confirmManual(root)).toBe(true); expect(mocks.store.portfolioState.manual.some((row: any) => row.values.name === 'v6 本机现金')).toBe(true)
    expect(output(root)).toContain('余额观察只留本机')
    const record = find(root, 'test-button', '记录余额观察'); expect(record.props.disabled).toBe(false); await click(record)
    expect(mocks.store.portfolioState.history).toHaveLength(3); expect(mocks.store.portfolioState.history[0].calendar).toBe('legacy-utc')
    expect(mocks.snapDaily).not.toHaveBeenCalled(); expect(mocks.snapManual).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('exports original negative zero without JSON.stringify coercion and labels legacy cost as its original convention', async () => {
    const source = await previewOwnerPortfolioMigration({ manualRaw: null,
      snapshotsRaw: '[{"date":"2026-10-01","value":-0,"cost":-0},{"date":"2026-10-02","value":2,"cost":1}]' })
    useV5(source.portfolio!); const blobs: Blob[] = []
    vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() {}, remove() {} }) })
    vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blobs.push(value as Blob); return 'blob:history' }); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const root = await mount(); await click(find(root, 'test-button', '导出'))
    const raw = await blobs[0].text(); expect(raw).toContain('"value":-0'); expect(raw).toContain('"cost":-0')
    expect(output(root)).toContain('旧成本保留原口径'); expect(output(root)).toContain('不代表真实购入成本')
  })
  it('rejects a stale v5 manual form after another applied local edit instead of silently overwriting it', async () => {
    useV5(await portfolio()); const root = await mount(); await click(find(root, 'test-button', '新增')); field(root, '市值', '5')
    mocks.store.portfolioState = applyOwnerPortfolioCommand(mocks.store.portfolioState, { type: 'save_manual', key: 'asset:newer',
      values: { name: '另一已应用记录', cls: '现金', value: 9, note: null }, updated_at: '2026-10-25T00:00:00Z' }).portfolio
    expect(await confirmManual(root)).toBe(false); expect(mocks.edit).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('原表单未覆盖新记录'))
    expect(mocks.store.portfolioState.manual.some((row: any) => row.key === 'asset:newer')).toBe(true)
  })
  it('allows a fully priced balance with unknown fund cost without manufacturing profit', async () => {
    useV5(await portfolio(false)); mocks.store.activeHoldings[0].cost = null
    const root = await mount(); expect(output(root)).toContain('成本缺失')
    const record = find(root, 'test-button', '记录余额观察'); expect(record.props.disabled).toBe(false); await click(record)
    expect(mocks.edit.mock.calls[0][0].observation.cost).toBeNull()
    expect(mocks.edit.mock.calls[0][0].observation.holdings[0].cost).toBeNull()
  })
  it('retains explicit zero-share fund/account identities without NAV and leaves missing zero-share cost unknown', async () => {
    const initial = await portfolio(), current = applyOwnerPortfolioCommand(initial, { type: 'save_manual', key: initial.manual[0].key,
      values: { ...initial.manual[0].values, value: 50 }, updated_at: '2026-10-25T00:00:00Z' }).portfolio
    useV5(current); mocks.store.activeHoldings = [
      { id: '000001::零份A', code: '000001', account: '零份A', name: '零份已知成本', position_kind: 'holding', shares: 0, cost: 2 },
      { id: '000001::零份B', code: '000001', account: '零份B', name: '零份未知成本', position_kind: 'holding', shares: 0, cost: null },
      { id: '000002::仅关注', code: '000002', account: '仅关注', name: '非持仓', position_kind: 'watch', shares: null, cost: null },
    ]
    const root = await mount(); expect(mocks.detail).not.toHaveBeenCalled()
    const record = find(root, 'test-button', '记录余额观察'); expect(record.props.disabled).toBe(false); await click(record)
    expect(mocks.edit.mock.calls[0][0].observation).toMatchObject({ value: 50, cost: null, holdings: [
      { kind: 'fund', key: '000001::零份A', value: 0, cost: 0 }, { kind: 'fund', key: '000001::零份B', value: 0, cost: null },
      { kind: 'manual', key: 'asset:fund|000001', value: 50, cost: null },
    ] })
    expect(mocks.edit.mock.calls[0][0].observation.holdings).toHaveLength(3)
    expect(mocks.snapDaily).not.toHaveBeenCalled(); expect(businessReads).toEqual([])
  })
  it('keeps a v5 zero-only holding visible for an explicit typed observation without a manual balance or fake NAV', async () => {
    const source = await previewOwnerPortfolioMigration({ manualRaw: null, snapshotsRaw: null }); useV5(source.portfolio!)
    mocks.store.activeHoldings = [{ id: '000001::唯一零份', code: '000001', account: '唯一零份', name: '唯一零份持仓', position_kind: 'holding', shares: 0, cost: null }]
    const root = await mount(); expect(output(root)).not.toContain('还没有持仓')
    expect(mocks.detail).not.toHaveBeenCalled(); const record = find(root, 'test-button', '记录余额观察'); expect(record.props.disabled).toBe(false)
    await click(record)
    expect(mocks.edit.mock.calls[0][0].observation).toMatchObject({ value: 0, cost: null,
      holdings: [{ kind: 'fund', key: '000001::唯一零份', value: 0, cost: null }] })
    expect(mocks.edit.mock.calls[0][0].observation.holdings).toHaveLength(1); expect(businessReads).toEqual([])
  })
  it('keeps original v5 history viewable/exportable after all current assets are tombstoned', async () => {
    const original = await portfolio(), removed = applyOwnerPortfolioCommand(original, { type: 'remove_manual', key: original.manual[0].key,
      updated_at: '2026-10-25T00:00:00Z' }).portfolio
    useV5(removed); mocks.store.activeHoldings = []
    const blobs: Blob[] = []
    vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() {}, remove() {} }) })
    vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blobs.push(value as Blob); return 'blob:history-only' }); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const root = await mount(); expect(output(root)).not.toContain('还没有持仓'); expect(output(root)).toContain('UTC 旧档')
    await click(find(root, 'test-button', '导出')); const raw = await blobs[0].text()
    expect(raw).toContain('opaque|manual|000001'); expect(raw.match(/"calendar":"legacy-utc"/g)).toHaveLength(2)
    expect(mocks.store.portfolioState.manual[0].deleted).toBe(true); expect(mocks.store.portfolioState.history).toHaveLength(2)
    expect(mocks.edit).not.toHaveBeenCalled(); expect(businessReads).toEqual([])
  })
  it('does not treat v5 unknown shares as a known zero-only position', async () => {
    const source = await previewOwnerPortfolioMigration({ manualRaw: null, snapshotsRaw: null }); useV5(source.portfolio!)
    mocks.store.activeHoldings[0].shares = null
    const root = await mount(); expect(output(root)).not.toContain('还没有持仓')
    expect(output(root)).toContain('不能把筛选后的记录当成完整组合')
    const record = find(root, 'test-button', '记录余额观察'); expect(record.props.disabled).toBe(true)
    await click(record); expect(mocks.edit).not.toHaveBeenCalled(); expect(businessReads).toEqual([])
  })
  it('preserves the legacy zero-only empty-view behavior instead of silently upgrading it', async () => {
    mocks.store.activeHoldings[0].shares = 0
    const root = await mount(); expect(output(root)).toContain('还没有持仓')
    expect(all(root).some(item => item.tag === 'test-button' && output(item).trim() === '记录余额观察')).toBe(false)
    expect(mocks.edit).not.toHaveBeenCalled()
  })
  it('does not replay an unknown portfolio save and exposes only manual original-receipt reconciliation', async () => {
    useV5(await portfolio()); mocks.edit.mockImplementation(async () => { mocks.store.hasPendingLocalWorkspaceEdit = true; mocks.store.authorityState = 'blocked'; throw new Error('unknown commit') })
    const root = await mount(); await click(find(root, 'test-button', '新增')); field(root, '市值', '5')
    expect(await confirmManual(root)).toBe(false); await settle(); expect(mocks.edit).toHaveBeenCalledOnce()
    expect(await confirmManual(root)).toBe(false); expect(mocks.edit).toHaveBeenCalledOnce()
    expect(output(root)).toContain('本机写入结果未知')
    const reconcile = all(root).find(item => item.props['data-action'] === 'reconcile-portfolio-local')!
    mocks.reconcile.mockResolvedValue(undefined); await click(reconcile)
    expect(mocks.reconcile).toHaveBeenCalledOnce(); expect(mocks.edit).toHaveBeenCalledOnce(); expect(businessReads).toEqual([])
  })
  it.each(['portfolio', 'holdings', 'authority'])('rejects %s drift while loading the real observation module before any local write', async drift => {
    useV5(await portfolio()); const root = await mount(), record = find(root, 'test-button', '记录余额观察')
    const pending = (record.props.onClick as () => Promise<void>)()
    expect(mocks.edit).not.toHaveBeenCalled()
    if (drift === 'portfolio') mocks.store.portfolioState = applyOwnerPortfolioCommand(mocks.store.portfolioState, { type: 'save_manual', key: 'asset:later',
      values: { name: '较新资产', cls: '现金', value: 3, note: null }, updated_at: '2026-10-25T00:00:00Z' }).portfolio
    else if (drift === 'holdings') mocks.store.activeHoldings = [{ ...mocks.store.activeHoldings[0], shares: 12 }]
    else mocks.store.authorityState = 'blocked'
    await pending; await settle()
    expect(mocks.edit).not.toHaveBeenCalled(); expect(businessReads).toEqual([])
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('余额观察未核定'))
  })
  it('does not append or expose a late observation after unmount during the real dynamic import', async () => {
    useV5(await portfolio()); const root = await mount(), record = find(root, 'test-button', '记录余额观察')
    const pending = (record.props.onClick as () => Promise<void>)(); apps.pop()!(); await pending
    expect(mocks.edit).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled()
  })
  it('does not download an obsolete history image after authority changes during the real dynamic import', async () => {
    useV5(await portfolio()); const download = vi.spyOn(URL, 'createObjectURL')
    const root = await mount(), pending = (find(root, 'test-button', '导出').props.onClick as () => Promise<void>)()
    mocks.store.authorityState = 'blocked'; await pending
    expect(download).not.toHaveBeenCalled(); expect(businessReads).toEqual([])
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('历史导出未完成或来源已变化'))
  })
})
