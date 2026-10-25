import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from '@/stores/watchlist'
import { OWNER_WORKSPACE_BACKUP_MAX_BYTES } from '@/utils/owner-workspace-backup'
import OwnerPortfolioMigrationPanel from './OwnerPortfolioMigrationPanel.vue'
import OwnerSyncPanel from './OwnerSyncPanel.vue'
import OwnerAnalysisPanel from './OwnerAnalysisPanel.vue'
import { useOwnerAnalysisStore } from '@/stores/ownerAnalysis'

// Actual SFC, Pinia facade, locator and fake-IDB; native download/render only is
// adapted. This is not a real browser/PWA persistence or cloud acceptance test.
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
function find(root: Node, key: string, name: string) { const found = all(root).find(item => item.props[key] === name); expect(found, name).toBeDefined(); return found! }
async function event(item: Node, handler: string, value?: unknown) { await (item.props[handler] as (value: unknown) => unknown)(value); await nextTick() }
async function click(root: Node, name: string) { const item = find(root, 'data-action', name); expect(item.props.disabled).not.toBe(true); await event(item, 'onClick') }
async function select(root: Node, raw: string, hash?: string) {
  if (hash) await event(find(root, 'name', 'owner-portfolio-sha'), 'onInput', { target: { value: hash } })
  await event(find(root, 'name', 'owner-portfolio-file'), 'onChange', { target: { files: [new File([raw], 'synthetic-portfolio.json')], value: 'file' } })
}
async function check(root: Node, recovery = false) { await event(find(root, 'name', recovery ? 'owner-portfolio-reconcile-confirm' : 'owner-portfolio-confirm'), 'onChange', { target: { checked: true } }) }
const apps: Array<() => void> = [], stores: ReturnType<typeof useWatchlistStore>[] = [], blobs: Blob[] = []
let store: ReturnType<typeof useWatchlistStore>, data: Map<string, string>
const forbidden = vi.fn(() => { throw new Error('cloud IO forbidden') })
async function fresh() { setActivePinia(createPinia()); const next = useWatchlistStore(); stores.push(next); await next.initialize(); return next }
async function mount(component: Component = OwnerPortfolioMigrationPanel) { const root = node(), app = renderer.createApp(component); app.mount(root); const unmount = () => app.unmount(); apps.push(unmount); await nextTick(); return { root, unmount } }
beforeEach(async () => {
  data = new Map([
    ['sinan_watchlist_v2', JSON.stringify([{ code: '510300', name: '合成零份', account: '银行|账户', position_kind: 'holding', shares: 0, cost: null, target_weight: 0, updated_at: '2026-10-22T00:00:00Z' }])],
    ['sinan_manual_assets_v1', JSON.stringify([{ id: 'legacy-' + '中'.repeat(190), name: '合成零金额', cls: '现金', value: 0, updated_at: '2026-10-22T00:00:00Z' }])],
    ['sinan_snapshots', JSON.stringify([{ date: '2026-10-22', value: 10, cost: 5, holdings: [{ id: 'opaque|manual|510300', code: '510300', name: '旧不透明项', account: '旧账户', type: '现金', value: 10, cost: 5 }] }, { date: '2026-10-22', value: 11, cost: 6 }])],
  ])
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('location', { origin: 'https://synthetic.example' })
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() {}, remove() {} }) })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blobs.push(value as Blob); return 'blob:synthetic-portfolio' }); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  forbidden.mockClear(); blobs.length = 0; vi.stubGlobal('fetch', forbidden)
  store = await fresh(); const backup = await store.createLocalWorkspaceBackup(); await store.activateLocalWorkspace(backup.raw, backup.sha256)
  const full = await store.createSyncRecoveryBackup(); await store.upgradeLocalSyncFormat(full.raw, full.sha256, true)
})
afterEach(() => { apps.splice(0).forEach(fn => fn()); stores.splice(0).forEach(value => value.$dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('explicit asset/history migration UI', () => {
  it('mounts v4 without exporting, parsing independent sources, upgrading or cloud IO', async () => {
    const backup = vi.spyOn(store, 'createPortfolioUpgradeBackup'), preview = vi.spyOn(store, 'previewPortfolioUpgrade'), upgrade = vi.spyOn(store, 'upgradePortfolioFormat')
    const { root } = await mount()
    expect(output(root)).toContain('手工资产与组合历史尚未并入共同工作区')
    expect(backup).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(upgrade).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled()
  })
  it('requires downloaded/select-back exact bytes, all explicit mappings and a separate confirmation before actual v5 upgrade', async () => {
    const originals = new Map(data), { root } = await mount()
    await click(root, 'export-portfolio-upgrade'); const raw = await blobs[0].text()
    expect(raw).toContain('opaque|manual|510300'); expect(store.localSyncFormat).toBe('v4')
    await select(root, raw)
    expect(output(root)).toContain('手工资产 1 条'); expect(output(root)).toContain('历史 2 条')
    const mappings = all(root).find(item => item.tag === 'details')!; await event(mappings, 'onToggle', { target: { open: true } })
    expect(output(root)).toContain('显式 SHA256 映射'); expect(output(root)).toContain('legacy-' + '中'.repeat(190))
    expect(find(root, 'data-action', 'upgrade-portfolio').props.disabled).toBe(true)
    await check(root); await click(root, 'upgrade-portfolio')
    expect(store.localSyncFormat).toBe('v5'); expect(store.portfolioState?.manual[0].values.value).toBe(0)
    expect(store.portfolioState?.history).toHaveLength(2)
    expect(store.portfolioState?.history[0]).toMatchObject({ kind: 'legacy', calendar: 'legacy-utc', holdings: [{ id: 'opaque|manual|510300' }] })
    expect(output(root)).toContain('不是云端确认'); expect(data).toEqual(originals); expect(forbidden).not.toHaveBeenCalled()
    store.$dispose(); store = await fresh(); expect(store.localSyncFormat).toBe('v5'); expect(store.portfolioState?.history).toHaveLength(2)
  })
  it('exports current v5 state separately after later edits; the old upgrade file is not presented as current recovery', async () => {
    const { root } = await mount(); await click(root, 'export-portfolio-upgrade'); await select(root, await blobs[0].text()); await check(root); await click(root, 'upgrade-portfolio')
    await store.editPortfolio({ type: 'save_manual', key: 'asset:new-current', values: { name: '升级后新资产', cls: '现金', value: 7, note: null }, updated_at: '2026-10-25T00:00:00Z' })
    await nextTick(); await click(root, 'export-portfolio-current')
    const current = await blobs[1].text(); expect(current).toContain('升级后新资产')
    expect(output(root)).toContain('升级原文件只保留升级前快照，不含后来编辑')
    expect(output(root)).toContain('不是丢库恢复'); expect(forbidden).not.toHaveBeenCalled()
  })
  it('explains actual v5 upload/analysis suspension without loading the old managed sync UI or making requests', async () => {
    const original = await store.createPortfolioUpgradeBackup(); await store.previewPortfolioUpgrade(original.raw, original.sha256)
    await store.upgradePortfolioFormat(original.raw, original.sha256, true)
    const sync = await mount(OwnerSyncPanel)
    const open = all(sync.root).find(item => item.tag === 'button' && output(item).trim() === '查看私人同步')!
    await event(open, 'onClick')
    expect(output(sync.root)).toContain('当前 v5 私人上传暂未开放')
    expect(all(sync.root).some(item => item.tag === 'button' && output(item).includes('启用本轮核对'))).toBe(false)
    const analysis = await mount(OwnerAnalysisPanel), ownerAnalysis = useOwnerAnalysisStore(); apps.push(() => ownerAnalysis.$dispose())
    expect(output(analysis.root)).toContain('当前 v5 持仓分析暂未开放')
    expect(all(analysis.root).some(item => item.tag === 'button' && output(item).includes('启用分析'))).toBe(false)
    expect(ownerAnalysis.enabled).toBe(false); expect(forbidden).not.toHaveBeenCalled()
  })
  it('does not upgrade an external valid original file without this-round download', async () => {
    const backup = await store.createPortfolioUpgradeBackup(), { root } = await mount()
    await select(root, backup.raw, backup.sha256); await check(root)
    expect(find(root, 'data-action', 'upgrade-portfolio').props.disabled).toBe(true)
    await event(find(root, 'data-action', 'upgrade-portfolio'), 'onClick'); expect(store.localSyncFormat).toBe('v4')
  })
  it('backs up malformed independent source bytes but shows issues and blocks the whole upgrade rather than dropping them', async () => {
    data.set('sinan_manual_assets_v1', 'private-invalid-manual')
    const { root } = await mount(); await click(root, 'export-portfolio-upgrade'); const raw = await blobs[0].text()
    expect(raw).toContain('private-invalid-manual'); await select(root, raw); await check(root)
    expect(output(root)).toContain('整批暂停'); expect(output(root)).toContain('invalid_manual')
    expect(find(root, 'data-action', 'upgrade-portfolio').props.disabled).toBe(true)
    expect(store.localSyncFormat).toBe('v4'); expect(data.get('sinan_manual_assets_v1')).toBe('private-invalid-manual')
  })
  it('rejects ordinary backup, changed bytes and BOM without modifying the original workspace', async () => {
    const ordinary = await store.createLocalWorkspaceBackup(), { root } = await mount()
    await select(root, ordinary.raw, ordinary.sha256); expect(output(root)).toContain('原文件核对失败')
    await click(root, 'export-portfolio-upgrade'); const raw = await blobs[0].text()
    await select(root, raw + ' '); expect(output(root)).toContain('原文件核对失败')
    await select(root, '\ufeff' + raw); expect(output(root)).toContain('原文件核对失败')
    expect(store.localSyncFormat).toBe('v4'); expect(store.recordsFor('510300')[0].shares).toBe(0)
  })
  it.each([0, OWNER_WORKSPACE_BACKUP_MAX_BYTES + 1])('rejects file size %s before opening its stream', async size => {
    const { root } = await mount(), stream = vi.fn()
    await event(find(root, 'name', 'owner-portfolio-file'), 'onChange', { target: { files: [{ size, stream }], value: '' } })
    expect(stream).not.toHaveBeenCalled(); expect(output(root)).toContain('文件为空或超过')
  })
  it('refuses a valid preview after the original LS source changes and does not restore the old source', async () => {
    const { root } = await mount(); await click(root, 'export-portfolio-upgrade'); await select(root, await blobs[0].text()); await check(root)
    const next = JSON.stringify([{ id: 'newer', name: '后来的本机资产', cls: '现金', value: 4, updated_at: '2026-10-25T00:00:00Z' }]); data.set('sinan_manual_assets_v1', next)
    await click(root, 'upgrade-portfolio')
    expect(store.localSyncFormat).toBe('v4'); expect(data.get('sinan_manual_assets_v1')).toBe(next)
    expect(output(root)).toContain('升级未完成或结果待核对')
  })
  it('cancels file reading on unmount and never publishes the late private preview', async () => {
    const { root, unmount } = await mount(); await click(root, 'export-portfolio-upgrade')
    let finish!: (value: { done: boolean }) => void
    const cancel = vi.fn(async () => {}), releaseLock = vi.fn(), reader = { read: () => new Promise<{ done: boolean }>(resolve => { finish = resolve }), cancel, releaseLock }
    const pending = event(find(root, 'name', 'owner-portfolio-file'), 'onChange', { target: { files: [{ size: 1, stream: () => ({ getReader: () => reader }) }], value: '' } })
    await nextTick(); unmount(); apps.splice(apps.indexOf(unmount), 1); finish({ done: true }); await pending
    const reopened = await mount(); expect(output(reopened.root)).not.toContain('原文件核对通过'); expect(cancel).toHaveBeenCalled(); expect(releaseLock).toHaveBeenCalled()
  })
})
