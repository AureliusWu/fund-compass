/** Actual SFC, app-owned Pinia stores, locator and IDB. HTTP alone is synthetic. */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRenderer, nextTick } from 'vue'
import { IDBFactory } from 'fake-indexeddb'
import OwnerAnalysisPanel from './OwnerAnalysisPanel.vue'
import { useOwnerAnalysisStore } from '@/stores/ownerAnalysis'
import { useWatchlistStore } from '@/stores/watchlist'
import { clearOwnerSession, loginOwnerSession } from '@/stores/ownerSession'
import { openOwnerAuthority } from '@/stores/owner-authority'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, buildOwnerWorkspaceLinkCloudRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard } from '@/stores/owner-workspace'
import { openOwnerAnalysisOutbox, type OwnerAnalysisOutbox } from '@/stores/owner-analysis-outbox'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { setLegacySyncConsent } from '@/utils/cloud-consent'

const mocks = vi.hoisted(() => ({ analysis: vi.fn(), sync: vi.fn(), write: vi.fn(), receipt: vi.fn(),
  policy: vi.fn(), evidence: vi.fn(), changes: vi.fn(), syncWrite: vi.fn(), fetch: vi.fn() }))
vi.mock('@/api/owner-analysis-transport', () => ({ createOwnerAnalysisHttpTransport: mocks.analysis }))
vi.mock('@/api/owner-sync-transport', () => ({ createOwnerSyncHttpTransport: mocks.sync }))

// v-model checkbox uses real Vue DOM directives, so the renderer exposes only
// the native checkbox event/property surface needed by those directives.
interface Node {
  tag: string; tagName: string; text: string; children: Node[]; parent: Node | null
  props: Record<string, unknown>; listeners: Record<string, (event: unknown) => void>
  checked: boolean; value: unknown; type: string
  addEventListener(name: string, callback: (event: unknown) => void): void
  removeEventListener(name: string): void
}
const node = (tag = 'root', text = ''): Node => ({ tag, tagName: tag.toUpperCase(), text, children: [], parent: null,
  props: {}, listeners: {}, checked: false, value: '', type: '',
  addEventListener(name, callback) { this.listeners[name] = callback },
  removeEventListener(name) { delete this.listeners[name] },
})
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value; if (key === 'type') item.type = String(value) },
  insert(item, parent, anchor = null) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
    item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item) },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const output = (item: Node): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(output).join(' ')
const all = (item: Node): Node[] => [item, ...item.children.flatMap(all)]
function button(root: Node, label: string) {
  const item = all(root).find(item => item.tag === 'button' && output(item).trim() === label)
  expect(item, label).toBeDefined(); return item!
}
async function click(root: Node, label: string) {
  const item = button(root, label); expect(item.props.disabled, label).not.toBe(true)
  await (item.props.onClick as () => unknown)(); await nextTick()
}
async function check(root: Node, label: string) {
  const parent = all(root).find(item => item.tag === 'label' && output(item).includes(label))
  expect(parent, label).toBeDefined()
  const input = parent!.children.find(item => item.tag === 'input')!
  expect(input.props.disabled).not.toBe(true)
  input.checked = true; input.listeners.change({ target: input }); await nextTick()
}
const KEY = '510300::synthetic-account', TOKEN = 'own_' + 'p'.repeat(43)
let factory: IDBFactory, data: Map<string, string>, target: string
let workspace: ReturnType<typeof useWatchlistStore>, analysis: ReturnType<typeof useOwnerAnalysisStore>
const stores: Array<{ $dispose(): void }> = [], handles: Array<OwnerWorkspace | OwnerAnalysisOutbox> = [], apps: Array<() => void> = []
const fixture = ownerAnalysisBackendFixture()
const records: OwnerSyncRecord[] = [{ key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
  field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
  values: { name: 'synthetic private analysis fund', shares: 10, cost: 1, target_weight: 20 } }]
async function login() {
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', owner_id: 'owner',
    expires_at: new Date(Date.now() + 1_800_000).toISOString(), scopes: ['read_private', 'write_holdings', 'run_personal_analysis'] }),
  { headers: { 'Content-Type': 'application/json' } }))
  await loginOwnerSession('synthetic-owner-password')
}
async function currentStores() {
  setActivePinia(createPinia()); workspace = useWatchlistStore(); stores.push(workspace)
  await workspace.initialize(); await workspace.load(true)
  analysis = useOwnerAnalysisStore(); stores.push(analysis)
}
async function mount() {
  const root = node(), app = renderer.createApp(OwnerAnalysisPanel)
  app.mount(root); apps.push(() => app.unmount()); await nextTick(); return root
}
async function enabled(root: Node) {
  await check(root, '我同意本轮读取私人策略'); await click(root, '启用分析')
  expect(analysis.enabled).toBe(true)
}
async function originalPreview(root: Node) {
  await enabled(root)
  // The original backend fixture supplies this exact original ID/hash. The
  // SFC reads the resulting real store preview and handles save/send itself.
  await analysis.preview(fixture.request.request_id); await nextTick()
}
async function prepared(root: Node) {
  await originalPreview(root)
  await check(root, '确认完整来源、策略和证据'); await click(root, '保存原包')
}
async function slot() {
  const handle = await openOwnerAnalysisOutbox(factory, target, new AbortController().signal, false)
  handles.push(handle); return handle.read(new AbortController().signal)
}
beforeEach(async () => {
  clearOwnerSession(); vi.stubGlobal('crypto', webcrypto)
  factory = new IDBFactory(); target = ''
  data = new Map([['sinan_watchlist_v2', JSON.stringify([{ code: '510300', name: 'synthetic private analysis fund',
    account: 'synthetic-account', position_kind: 'holding', shares: 10, cost: 1, target_weight: 20, updated_at: '2026-10-23T00:00:00Z' }])]])
  vi.stubGlobal('indexedDB', factory); vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('location', { origin: 'https://synthetic-owner.example' })
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() {}, remove() {} }) })
  setLegacySyncConsent(false)
  for (const value of Object.values(mocks)) value.mockReset()
  mocks.fetch.mockRejectedValue(new Error('unapproved synthetic HTTP')); vi.stubGlobal('fetch', mocks.fetch)
  mocks.write.mockResolvedValue({ status: 200, rawBody: fixture.response })
  mocks.receipt.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(fixture.response) }) })
  mocks.policy.mockResolvedValue({ status: 200, rawBody: fixture.policy })
  mocks.evidence.mockResolvedValue({ status: 200, rawBody: fixture.evidence })
  mocks.changes.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ upper_revision: 1, changes: records, next_cursor: null, complete: true }) })
  mocks.syncWrite.mockRejectedValue(new Error('analysis cannot send sync writes'))
  mocks.analysis.mockImplementation(async () => ({ targetFingerprint: target, write: mocks.write,
    receipt: mocks.receipt, policy: mocks.policy, evidence: mocks.evidence }))
  mocks.sync.mockImplementation(async () => ({ targetFingerprint: target, write: mocks.syncWrite,
    receipt: vi.fn(), changes: mocks.changes }))
  setActivePinia(createPinia()); const first = useWatchlistStore(); stores.push(first); await first.initialize()
  const backup = await first.createLocalWorkspaceBackup(); await first.activateLocalWorkspace(backup.raw, backup.sha256)
  const locator = await openOwnerAuthority(factory, localStorage), pointer = await locator.read(); locator.close()
  target = pointer.targetFingerprint!
  const guard: OwnerWorkspaceGuard = { signal: new AbortController().signal, assertActive() {
    if (location.origin !== 'https://synthetic-owner.example') throw new Error('setup origin changed')
  } }
  const old = await openOwnerWorkspace(factory, target, { existingOnly: true }); handles.push(old)
  const v4 = await upgradeOwnerWorkspaceSync(factory, target, await old.readLocalState(guard), guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(target, { id: 'panel-analysis-link-0001',
    expected: await v4.readSyncState(guard), base: { pulledRevision: 1, records } }), guard)
  first.$dispose(); await currentStores()
  expect(workspace.localSyncFormat).toBe('v4')
})
afterEach(() => {
  apps.splice(0).forEach(unmount => unmount()); stores.splice(0).reverse().forEach(store => store.$dispose())
  handles.splice(0).forEach(handle => handle.close()); clearOwnerSession(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('actual Owner analysis panel and adopted workspace journey', () => {
  it('defaults off before and after login, and enable/UI preview never generate analysis', async () => {
    const root = await mount()
    expect(output(root)).toContain('请先登录私人会话')
    expect(analysis.enabled).toBe(false); expect(mocks.analysis).not.toHaveBeenCalled()
    await login(); await nextTick()
    expect(button(root, '启用分析').props.disabled).toBe(true)
    expect(mocks.analysis).not.toHaveBeenCalled()
    await enabled(root)
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.changes).not.toHaveBeenCalled()
    await click(root, '读取并预览完整来源')
    expect(output(root)).toContain('synthetic-account'); expect(output(root)).toContain('发送前核对')
    expect(analysis.view?.preview?.packet.request.request_id).toMatch(/^owner-analysis-ui-/)
    expect((await slot()).task).toBeNull()
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.receipt).not.toHaveBeenCalled()
  })

  it('separately saves/sends the actual original packet and immediately revokes qualification on a real local edit', async () => {
    await login(); const root = await mount(); await originalPreview(root)
    expect(button(root, '保存原包').props.disabled).toBe(true)
    await check(root, '确认完整来源、策略和证据'); await click(root, '保存原包')
    expect((await slot()).task?.state).toBe('prepared'); expect(mocks.write).not.toHaveBeenCalled()
    expect(button(root, '单次生成分析').props.disabled).toBe(true)
    await check(root, '确认只发送这个原包一次'); await click(root, '单次生成分析')
    expect(mocks.write).toHaveBeenCalledOnce(); expect((await slot()).task?.state).toBe('matched')
    expect(analysis.qualified).toBe(true); expect(analysis.resultFor('510300')?.decision.decision_id).toBe(JSON.parse(fixture.response).run.components[0].decision.decision_id)
    const originalLS = data.get('sinan_watchlist_v2')
    await workspace.saveHolding({ code: '510300', name: 'synthetic private analysis fund', account: 'synthetic-account',
      position_kind: 'holding', shares: 11, cost: 1, target_weight: 20 },
    { id: KEY, snapshot: workspace.entrySnapshot(KEY)! }, { confirmed: true })
    expect(analysis.qualified).toBe(false); expect(analysis.results).toEqual([])
    await nextTick(); expect(output(root)).not.toContain('最近一分钟内已核对')
    expect(data.get('sinan_watchlist_v2')).toBe(originalLS)
    expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.syncWrite).not.toHaveBeenCalled()
  })

  it('reopens an actual unknown task and requires manual original receipt without another POST', async () => {
    await login(); const root = await mount(); await prepared(root)
    mocks.write.mockRejectedValueOnce(new Error('synthetic accepted response lost'))
    await check(root, '确认只发送这个原包一次'); await click(root, '单次生成分析')
    expect((await slot()).task?.state).toBe('attempted')
    expect(output(root)).toContain('结果未知'); expect(mocks.write).toHaveBeenCalledOnce()
    await click(root, '关闭分析'); await enabled(root)
    expect((await slot()).task?.state).toBe('attempted')
    expect(mocks.receipt).not.toHaveBeenCalled(); expect(mocks.write).toHaveBeenCalledOnce()
    expect(all(root).some(item => item.tag === 'button' && output(item).trim() === '单次生成分析')).toBe(false)
    mocks.receipt.mockResolvedValueOnce({ status: 404, rawBody: '{"state":"unknown","error":"analysis_result_unknown"}' })
    await click(root, '核对原回执与当前来源')
    expect((await slot()).task?.state).toBe('attempted'); expect(analysis.qualified).toBe(false)
    await click(root, '核对原回执与当前来源')
    expect((await slot()).task?.state).toBe('matched'); expect(analysis.qualified).toBe(true)
    expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.receipt).toHaveBeenCalledTimes(2)
  })

  it('hides a late accepted result and all private preview on real logout while retaining the original attempted task', async () => {
    await login(); const root = await mount(); await prepared(root)
    let finish!: (value: { status: number; rawBody: string }) => void
    mocks.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await check(root, '确认只发送这个原包一次')
    const sending = click(root, '单次生成分析')
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce())
    clearOwnerSession(); await nextTick()
    expect(analysis.view).toBeNull(); expect(analysis.results).toEqual([])
    expect(output(root)).not.toContain('Synthetic analysis guardrails')
    expect(output(root)).not.toContain('synthetic-account')
    finish({ status: 200, rawBody: fixture.response }); await sending; await nextTick()
    expect(analysis.view).toBeNull(); expect(analysis.qualified).toBe(false)
    expect((await slot()).task?.state).toBe('attempted')
    expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.receipt).not.toHaveBeenCalled()
  })
})
