/** Actual SFC, app-owned Pinia stores, locator and IDB. HTTP alone is synthetic. */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRenderer, defineComponent, h, nextTick, type Component } from 'vue'
import { IDBFactory, IDBObjectStore, forceCloseDatabase } from 'fake-indexeddb'
import OwnerAnalysisPanel from './OwnerAnalysisPanel.vue'
import OwnerPolicyVersions from './OwnerPolicyVersions.vue'
import { useOwnerAnalysisStore } from '@/stores/ownerAnalysis'
import { useWatchlistStore } from '@/stores/watchlist'
import { clearOwnerSession, loginOwnerSession } from '@/stores/ownerSession'
import { openOwnerAuthority } from '@/stores/owner-authority'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, buildOwnerWorkspaceLinkCloudRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard } from '@/stores/owner-workspace'
import { openOwnerAnalysisOutbox, type OwnerAnalysisOutbox } from '@/stores/owner-analysis-outbox'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'
import { ownerAnalysisV6BackendFixture } from '@/utils/owner-analysis-v6-contract.fixtures'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { validateOwnerPortfolioCommand, type OwnerPortfolioManualValues } from '@/utils/ownerPortfolioLocal'
import { ownerPolicyStateBackendWireFixture } from '@/utils/ownerPolicyState.fixtures'
import { parseOwnerPolicyState } from '@/utils/ownerPolicyState'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { setLegacySyncConsent } from '@/utils/cloud-consent'
import HomePage from '@/pages/HomePage.vue'
import WatchlistPage from '@/pages/WatchlistPage.vue'
import FundDetailV8Panel from './FundDetailV8Panel.vue'

const mocks = vi.hoisted(() => ({ analysis: vi.fn(), sync: vi.fn(), write: vi.fn(), receipt: vi.fn(),
  policy: vi.fn(), policyState: vi.fn(), evidence: vi.fn(), changes: vi.fn(), syncWrite: vi.fn(), fetch: vi.fn() }))
vi.mock('@/api/owner-analysis-transport', () => ({ createOwnerAnalysisHttpTransport: mocks.analysis }))
vi.mock('@/api/owner-sync-transport', () => ({ createOwnerSyncHttpTransport: mocks.sync }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vant', () => ({ showConfirmDialog: vi.fn(), showToast: vi.fn() }))
vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(),
  getV8Decision: vi.fn(async () => { throw new Error('synthetic legacy snapshots unavailable') }),
  getV8DecisionDiff: vi.fn(async () => { throw new Error('synthetic legacy comparisons unavailable') }),
  getV8FundOutcomes: vi.fn(async () => { throw new Error('synthetic outcomes unavailable') }),
  getFunds: vi.fn(async () => []), getHealth: vi.fn(async () => ({ status: 'ok' })),
}))
vi.mock('@/utils/estimate', async original => ({ ...await original<typeof import('@/utils/estimate')>(),
  fetchEstimates: vi.fn(async () => new Map()), loadCachedEstimates: vi.fn(() => new Map()) }))
vi.mock('@/utils/taskStatus', () => ({ fetchTaskStatuses: vi.fn(async () => []) }))
vi.mock('@/utils/indices', () => ({ cachedIndices: () => [], getIndices: vi.fn(async () => []) }))
vi.mock('@/utils/market-temp', () => ({ cachedMarketTemp: () => null, fetchMarketTemp: vi.fn(async () => null) }))

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
let factory: IDBFactory, data: Map<string, string>, target: string, surface: EventTarget
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
async function mountConsumer(component: Component, props: Record<string, unknown> = {}) {
  const root = node(), app = renderer.createApp({ render: () => h(component, props) })
  for (const name of ['VanNavBar', 'VanPullRefresh', 'VanSwipeCell', 'VanCell', 'VanCellGroup', 'VanSkeleton', 'VanEmpty', 'VanTag', 'VanProgress', 'VanField', 'VanSwitch', 'VanLoading', 'VanForm']) {
    app.component(name, defineComponent({ setup: (_props, { attrs, slots }) => () => h('section', attrs, [slots.default?.(), slots.right?.(), slots['right-icon']?.()]) }))
  }
  app.component('RouterLink', defineComponent({ setup: (_props, { attrs, slots }) => () => h('a', attrs, slots.default?.()) }))
  app.component('VanPopup', defineComponent({ props: ['show'], setup: (props, { slots }) => () => props.show ? h('popup', slots.default?.()) : null }))
  app.component('VanButton', defineComponent({ setup: (_props, { attrs, slots }) => () => h('button', attrs, slots.default?.()) }))
  app.mount(root); apps.push(() => app.unmount())
  for (let at = 0; at < 8; at++) { await new Promise<void>(resolve => setImmediate(resolve)); await nextTick() }
  return root
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
function manualCommand(row: OwnerSyncRecord, patch: Partial<OwnerPortfolioManualValues> = {}) {
  if (row.kind !== 'manual_asset') throw new Error('actual manual fixture required')
  const command = validateOwnerPortfolioCommand({ type: 'save_manual', key: row.key,
    values: { ...row.values, ...patch }, updated_at: '2026-10-26T00:00:00Z' })
  if (command.type !== 'save_manual') throw new Error('actual save_manual command required')
  return command
}
async function completeSix(mode: 'initial' | 'refresh' | 'ack' = 'refresh') {
  handles.splice(0).forEach(handle => handle.close())
  const selected = ownerAnalysisV6BackendFixture(), cash = selected.initialRecords.find(row => row.kind === 'manual_asset' && !row.deleted)!
  data.set('sinan_manual_assets_v1', canonicalOwnerLocal([{ id: cash.key.slice(6), name: cash.values.name,
    cls: cash.values.cls, value: cash.values.value, updated_at: '2026-10-24T00:00:00Z' }]))
  data.set('sinan_snapshots', canonicalOwnerLocal([{ date: '2026-10-24', value: -0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 }]))
  const oldFile = await workspace.createPortfolioUpgradeBackup(); await workspace.previewPortfolioUpgrade(oldFile.raw, oldFile.sha256)
  await workspace.upgradePortfolioFormat(oldFile.raw, oldFile.sha256, true)
  const fullFile = await workspace.createFullSyncUpgradeBackup(); await workspace.previewFullSyncUpgrade(fullFile.raw, fullFile.sha256)
  await workspace.upgradeFullSyncFormat(fullFile.raw, fullFile.sha256, true)
  await login()
  mocks.changes.mockResolvedValue({ status: 200, rawBody: selected.initialChangesRaw })
  const initial = await workspace.enableFullSync(true); await initial.pullComplete()
  const first = await initial.previewInitial([])
  const ready = await initial.previewInitial(first.preview.conflicts.map(row => ({ key: row.key, field: row.field, choice: 'cloud' })))
  await initial.commitInitial(ready.token!, true)
  if (mode !== 'initial') {
    mocks.changes.mockResolvedValue({ status: 200, rawBody: selected.currentChangesRaw })
    if (mode === 'ack') {
      const currentCash = selected.currentRecords.find(row => row.key === cash.key)!
      await workspace.editPortfolio(manualCommand(currentCash))
      await workspace.enableFullSync(true)
      const packets = await workspace.enableFullSyncPackets(true), prepare = await packets.previewPreparation('analysis-v6-prior-sync-0001')
      await packets.commitPreparation(prepare, true)
      mocks.syncWrite.mockResolvedValueOnce({ status: 200, rawBody: canonicalOwnerLocal({ revision: 3, records: [currentCash] }) })
      await packets.sendOnce(); await packets.pullComplete()
      const acknowledged = await packets.previewAcknowledgement('analysis-v6-prior-ack-0001')
      await packets.commitAcknowledgement(acknowledged.request!, true)
    } else {
      const packets = await workspace.enableFullSyncPackets(true); await packets.pullComplete()
      const refreshed = await packets.previewRefresh('analysis-v6-prior-refresh-0001')
      await packets.commitRefresh(refreshed.request!, true)
    }
  }
  workspace.disableFullSync()
  mocks.write.mockResolvedValue({ status: 200, rawBody: selected.response })
  mocks.receipt.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(selected.response) }) })
  mocks.policy.mockResolvedValue({ status: 200, rawBody: selected.policy })
  mocks.policyState.mockImplementation(async () => ({ status: 200, rawBody: JSON.stringify({
    schema_version: 'owner-policy-state-1', observed_at: new Date(Date.now() - 1).toISOString(),
    current: JSON.parse(selected.policy), history: [JSON.parse(selected.policy)], next_effective_at: null,
  }) }))
  mocks.evidence.mockResolvedValue({ status: 200, rawBody: selected.evidence })
  return selected
}
async function sixPreview(root: Node, selected: ReturnType<typeof ownerAnalysisV6BackendFixture>) {
  await enabled(root); await analysis.preview(selected.request.request_id); await nextTick()
}
async function sixPrepared(root: Node, selected: ReturnType<typeof ownerAnalysisV6BackendFixture>) {
  await sixPreview(root, selected); await check(root, '确认完整来源、策略和证据'); await click(root, '保存原包')
}
async function sixQualified(root: Node, selected: ReturnType<typeof ownerAnalysisV6BackendFixture>) {
  await sixPrepared(root, selected); await check(root, '确认只发送这个原包一次'); await click(root, '单次生成分析')
  expect(analysis.qualified).toBe(true)
}
beforeEach(async () => {
  clearOwnerSession(); vi.stubGlobal('crypto', webcrypto)
  factory = new IDBFactory(); target = ''; surface = new EventTarget(); vi.stubGlobal('window', surface)
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
  mocks.policyState.mockImplementation(async () => ({ status: 200, rawBody: JSON.stringify({
    schema_version: 'owner-policy-state-1', observed_at: new Date(Date.now() - 1).toISOString(),
    current: JSON.parse(fixture.policy), history: [JSON.parse(fixture.policy)], next_effective_at: null,
  }) }))
  mocks.evidence.mockResolvedValue({ status: 200, rawBody: fixture.evidence })
  mocks.changes.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ upper_revision: 1, changes: records, next_cursor: null, complete: true }) })
  mocks.syncWrite.mockRejectedValue(new Error('analysis cannot send sync writes'))
  mocks.analysis.mockImplementation(async () => ({ targetFingerprint: target, write: mocks.write,
    receipt: mocks.receipt, policy: mocks.policy, policyState: mocks.policyState, evidence: mocks.evidence }))
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
  it('renders a backend Policy scheduled one microsecond later as upcoming, including a stale read', async () => {
    const envelope = JSON.parse(ownerPolicyStateBackendWireFixture())
    // Keep both actual backend Policy payloads unchanged; advance only the
    // observation to one microsecond before the actual scheduled boundary.
    envelope.observed_at = envelope.next_effective_at.replace('.000001Z', '.000000Z')
    const state = parseOwnerPolicyState(JSON.stringify(envelope), Date.parse(envelope.observed_at) + 1)
    expect(Date.parse(state.next_effective_at!)).toBe(Date.parse(state.observed_at))
    const root = node(), app = renderer.createApp(OwnerPolicyVersions, { state, fresh: false, busy: false })
    app.mount(root); apps.push(() => app.unmount()); await nextTick()
    const future = state.history[0]
    const futureButton = all(root).find(item => item.tag === 'button' && output(item).includes(future.policy_version))!
    expect(output(futureButton)).toContain('待生效')
    expect(output(futureButton)).not.toContain('历史')
    expect(output(root)).toContain('以下只作历史')
    expect(mocks.policyState).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })

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

  it('reads and selects Policy history in the actual SFC without source pulls or writes', async () => {
    await login(); const root = await mount(); await enabled(root)
    const current = JSON.parse(fixture.policy), now = Date.now()
    const future = { ...current, policy_version: 'pol_' + 'd'.repeat(64), supersedes: current.policy_version,
      name: '即将生效的合成护栏', effective_at: new Date(now + 30_000).toISOString(),
      created_at: new Date(now - 1000).toISOString(), rebalance_band: 0, max_theme_weight: null }
    mocks.policyState.mockResolvedValueOnce({ status: 200, rawBody: JSON.stringify({
      schema_version: 'owner-policy-state-1', observed_at: new Date(now).toISOString(), current,
      next_effective_at: future.effective_at, history: [future, current],
    }) })
    await click(root, '读取策略版本')
    // A child emits synchronously; its parent's real async action completes
    // later. Observe the actual store outcome instead of awaiting emit().
    await vi.waitFor(() => expect(analysis.view?.policyState?.history).toHaveLength(2)); await nextTick()
    expect(output(root)).toContain('核对时生效'); expect(output(root)).toContain('待生效')
    expect(output(root)).toContain('完整版本 2 份'); expect(analysis.qualified).toBe(false)
    const futureButton = all(root).find(item => item.tag === 'button' && output(item).includes(future.name))!
    ;(futureButton.props.onClick as () => void)(); await nextTick()
    expect(output(root)).toContain('再平衡带（%）'); expect(output(root)).toContain('所选版本')
    expect(mocks.policyState).toHaveBeenCalledOnce(); expect(mocks.changes).not.toHaveBeenCalled()
    expect(mocks.evidence).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.syncWrite).not.toHaveBeenCalled(); expect((await slot()).task).toBeNull()
  })

  it('does not restore private Policy history after logout while its read is outstanding', async () => {
    await login(); const root = await mount(); await enabled(root)
    let finish!: (value: { status: number; rawBody: string }) => void
    mocks.policyState.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const reading = click(root, '读取策略版本')
    await vi.waitFor(() => expect(mocks.policyState).toHaveBeenCalledOnce())
    clearOwnerSession(); await nextTick()
    finish({ status: 200, rawBody: JSON.stringify({ schema_version: 'owner-policy-state-1',
      observed_at: new Date(Date.now() - 1).toISOString(), current: JSON.parse(fixture.policy),
      next_effective_at: null, history: [JSON.parse(fixture.policy)],
    }) })
    await reading; await new Promise<void>(resolve => setImmediate(resolve)); await nextTick()
    expect(analysis.view).toBeNull(); expect(analysis.qualified).toBe(false)
    expect(output(root)).not.toContain('Synthetic analysis guardrails')
    expect(mocks.write).not.toHaveBeenCalled(); expect((await slot()).task).toBeNull()
  })
})

describe('actual complete v6 source through the analysis SFC, local authority and real task store', () => {
  it('remains default-off after actual format/link/refresh and login; explicit enable only hydrates the original task', async () => {
    const selected = await completeSix(), root = await mount(), changes = mocks.changes.mock.calls.length
    expect(output(root)).toContain('v6 完整格式可独立核对分析来源'); expect(analysis.enabled).toBe(false)
    expect(mocks.analysis).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.receipt).not.toHaveBeenCalled()
    expect(button(root, '启用分析').props.disabled).toBe(true)
    await enabled(root); expect(mocks.changes.mock.calls.length).toBe(changes); expect(mocks.evidence).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled(); expect((await slot()).task).toBeNull()
    await analysis.preview(selected.request.request_id); await nextTick()
    expect(analysis.view!.preview!.records).toHaveLength(3); expect(output(root)).toContain('refreshed note')
    expect(output(root)).toContain('手工资产'); expect(output(root)).toContain('已删除，保留历史'); expect(output(root)).toContain('金额：-0')
    expect(analysis.view!.preview!.packet.rawBody).toBe(selected.rawBody); expect(analysis.view!.preview!.packet.requestHash).toBe(selected.requestHash)
    expect(mocks.evidence).toHaveBeenCalledTimes(1); expect(mocks.evidence).toHaveBeenCalledWith('510300', expect.any(AbortSignal))
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it.each(['refresh', 'ack'] as const)('accepts the actual full %s, saves the original context, commits attempted before one analysis POST and qualifies the real full-source receipt', async mode => {
    const selected = await completeSix(mode), root = await mount(), source = await workspace.captureOwnerAnalysisSource(new AbortController().signal)
    expect(source.profile).toBe('v6')
    if (source.profile !== 'v6') throw new Error('actual full source required')
    expect(source.state.fullSync.base!.pulledRevision).toBe(3); expect(source.state.local.sync!.base!.pulledRevision).toBe(1)
    expect(source.state.fullSync.base!.records).toHaveLength(3)
    mocks.write.mockImplementationOnce(async packet => {
      expect((await slot()).task).toMatchObject({ state: 'attempted', rawBody: selected.rawBody, requestHash: selected.requestHash })
      expect(packet.rawBody).toBe(selected.rawBody); return { status: 200, rawBody: selected.response }
    })
    await sixQualified(root, selected)
    const saved = (await slot()).task!, result = analysis.resultFor('510300')!
    expect(saved.state).toBe('matched'); expect(saved.contextHash).toMatch(/^[a-f0-9]{64}$/)
    expect(analysis.view!.result!.run.source).toEqual(JSON.parse(selected.response).run.source)
    expect(result.decision.decision_id).toBe(JSON.parse(selected.response).run.components[0].decision.decision_id)
    expect(result.holding!.current_weight).toBe(100); expect(analysis.results).toHaveLength(1)
    expect(workspace.entries.find(row => row.code === '510300')!.local_pending).toBe(true)
    expect(source.state.local.portfolio!.history).toHaveLength(2); expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.syncWrite).toHaveBeenCalledTimes(mode === 'ack' ? 1 : 0)
    await expect(analysis.sendOnce(true)).rejects.toBeInstanceOf(Error); expect(mocks.write).toHaveBeenCalledOnce()
  })
  it('does not qualify an original unknown analysis after reopen until the real original receipt and current complete source are explicitly matched', async () => {
    const selected = await completeSix(), root = await mount(); await sixPrepared(root, selected)
    mocks.write.mockRejectedValueOnce(new Error('synthetic accepted response lost'))
    await check(root, '确认只发送这个原包一次'); await click(root, '单次生成分析')
    const original = (await slot()).task!; expect(original.state).toBe('attempted'); expect(analysis.qualified).toBe(false)
    await click(root, '关闭分析'); await enabled(root)
    expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.receipt).not.toHaveBeenCalled()
    expect(all(root).some(row => row.tag === 'button' && output(row).trim() === '单次生成分析')).toBe(false)
    await click(root, '核对原回执与当前来源')
    expect((await slot()).task).toEqual({ ...original, state: 'matched' }); expect(analysis.qualified).toBe(true)
    expect(mocks.receipt).toHaveBeenCalledOnce(); expect(mocks.write).toHaveBeenCalledOnce()
  })
  it('keeps manual-only business edits outside analysis even when the fund is unchanged and does not read Policy/Evidence or send', async () => {
    const selected = await completeSix(), cash = selected.currentRecords.find(row => row.kind === 'manual_asset' && !row.deleted)!
    await workspace.editPortfolio(manualCommand(cash, { value: 9 }))
    const root = await mount(); await check(root, '我同意本轮读取私人策略'); await click(root, '启用分析')
    expect(analysis.enabled).toBe(false); expect(mocks.analysis).not.toHaveBeenCalled(); expect(mocks.evidence).not.toHaveBeenCalled()
    expect(mocks.policyState).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.syncWrite).not.toHaveBeenCalled()
  })
  it.each(['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const)('refuses analysis while an actual full-sync original packet is %s, without reading private references or sending analysis', async phase => {
    await completeSix()
    await workspace.saveHolding({ code: '510300', name: 'synthetic private analysis fund', account: 'synthetic-account',
      position_kind: 'holding', shares: 11, cost: 1, target_weight: 20 },
    { id: KEY, snapshot: workspace.entrySnapshot(KEY)! }, { confirmed: true })
    await workspace.enableFullSync(true); const packets = await workspace.enableFullSyncPackets(true)
    const request = await packets.previewPreparation('analysis-ui-blocked-full-packet')
    await packets.commitPreparation(request, true)
    const guard = { signal: new AbortController().signal, assertActive() {} }
    const handle = await openOwnerWorkspace(factory, target, { existingOnly: true }); handles.push(handle)
    if (phase !== 'prepared') {
      let actual = await handle.readFullSyncState(guard)
      for (const nextState of phase === 'attempted' ? ['attempted'] as const : ['attempted', phase] as const) {
        const pending = actual.fullSync.pending!
        actual = await handle.transitionFullSyncDelivery({ expected: actual, requestId: pending.requestId,
          requestHash: pending.requestHash, preparationHash: pending.preparationHash, nextState }, guard)
      }
    }
    workspace.disableFullSync(); await workspace.load(true)
    const original = await handle.readFullSyncState(guard)
    expect(original.local.outbox.entry?.state).toBe(phase); expect(original.fullSync.pending).not.toBeNull()
    const root = await mount(); await check(root, '我同意本轮读取私人策略'); await click(root, '启用分析')
    expect(analysis.enabled).toBe(false); expect(analysis.qualified).toBe(false); expect(analysis.results).toEqual([])
    expect(mocks.analysis).not.toHaveBeenCalled(); expect(mocks.policyState).not.toHaveBeenCalled(); expect(mocks.evidence).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.syncWrite).not.toHaveBeenCalled()
    expect(await handle.readFullSyncState(guard)).toEqual(original)
  })
  it('revokes a previously qualified complete result on a real manual-only writer, preserving the original matched task and no extra POST', async () => {
    const selected = await completeSix(), root = await mount(); await sixQualified(root, selected)
    const original = (await slot()).task!, cash = selected.currentRecords.find(row => row.kind === 'manual_asset' && !row.deleted)!
    await workspace.editPortfolio(manualCommand(cash, { value: 7, note: null }))
    expect(analysis.qualified).toBe(false); expect(analysis.results).toEqual([]); expect(analysis.resultFor('510300')).toBeNull()
    await nextTick(); expect(output(root)).not.toContain('最近一分钟内已核对'); expect((await slot()).task).toEqual(original)
    expect(mocks.write).toHaveBeenCalledOnce(); await expect(analysis.preview(selected.request.request_id)).rejects.toBeInstanceOf(Error)
  })
  it('requires a newly observed full D to match every manual record, not merely the unchanged fund/head count', async () => {
    const selected = await completeSix(), root = await mount(); await enabled(root)
    const changed = structuredClone(selected.currentRecords), cash = changed.find(row => row.kind === 'manual_asset' && !row.deleted)!
    Object.assign(cash, { values: { ...cash.values, note: 'same-head different complete manual source' } })
    mocks.changes.mockResolvedValueOnce({ status: 200, rawBody: canonicalOwnerLocal({ upper_revision: 3, changes: changed.sort((a, b) => a.record_revision - b.record_revision || (a.key < b.key ? -1 : 1)), next_cursor: null, complete: true }) })
    await expect(analysis.preview(selected.request.request_id)).rejects.toBeInstanceOf(Error)
    expect(analysis.view?.preview).toBeNull(); expect(mocks.policyState).not.toHaveBeenCalled(); expect(mocks.evidence).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })
  it('invalidates prepared/qualified source when in-memory manual values are replaced without changing fund rows', async () => {
    const selected = await completeSix(), root = await mount(); await sixQualified(root, selected)
    const mutable = structuredClone(workspace.portfolioState!)
    const cash = mutable.manual.find(row => !row.deleted)!
    Object.assign(cash, { values: { ...cash.values, value: 55 } }); workspace.portfolioState = mutable
    expect(analysis.qualified).toBe(false); expect(analysis.results).toEqual([]); expect(mocks.write).toHaveBeenCalledOnce()
  })
  it.each(['logout', 'observed-endpoint'] as const)('synchronously removes a qualified v6 result after %s while preserving the original matched task', async cause => {
    const selected = await completeSix(), root = await mount(); await sixQualified(root, selected)
    const original = (await slot()).task!
    if (cause === 'logout') clearOwnerSession()
    else {
      vi.stubGlobal('location', { origin: 'https://other-owner.synthetic.example' })
      // A real observer event retires the cached Pinia qualification. No
      // polling result or new reference read may silently renew the old one.
      surface.dispatchEvent(new Event('focus'))
    }
    expect(analysis.qualified).toBe(false); expect(analysis.results).toEqual([]); expect(analysis.view).toBeNull()
    await nextTick(); expect(output(root)).not.toContain('最近一分钟内已核对')
    expect(output(root)).not.toContain('refreshed note'); expect((await slot()).task).toEqual(original)
    expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.receipt).not.toHaveBeenCalled()
  })
  it.each(['preview', 'qualified'] as const)('synchronously revokes %s when a real full-sync operation begins, before its pending complete read finishes', async phase => {
    const selected = await completeSix(), root = await mount()
    await workspace.enableFullSync(true); const packets = await workspace.enableFullSyncPackets(true)
    if (phase === 'qualified') await sixQualified(root, selected); else await sixPreview(root, selected)
    let finish!: (value: { status: number; rawBody: string }) => void
    mocks.changes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pulling = packets.pullComplete()
    expect(analysis.qualified).toBe(false); expect(analysis.view?.preview).toBeNull(); expect(analysis.results).toEqual([])
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish({ status: 200, rawBody: selected.currentChangesRaw }); await pulling
    expect(analysis.qualified).toBe(false); expect(analysis.view?.preview).toBeNull(); expect(mocks.write).toHaveBeenCalledTimes(phase === 'qualified' ? 1 : 0)
  })
  it.each(['logout', 'endpoint'] as const)('rejects a late full-source preview after %s and never restores private records or sends an analysis', async cause => {
    const selected = await completeSix(), root = await mount(); await enabled(root)
    let finish!: (value: { status: number; rawBody: string }) => void
    mocks.changes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = analysis.preview(selected.request.request_id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    if (cause === 'logout') clearOwnerSession(); else vi.stubGlobal('location', { origin: 'https://other-owner.synthetic.example' })
    finish({ status: 200, rawBody: selected.currentChangesRaw }); await expect(pending).rejects.toBeInstanceOf(Error); await nextTick()
    expect(analysis.view?.preview ?? null).toBeNull(); expect(analysis.qualified).toBe(false); expect(output(root)).not.toContain('refreshed note')
    expect(mocks.evidence).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })
  it('retains a full-sync unknown local tuple and refuses analysis instead of silently trusting the committed refresh', async () => {
    const selected = await completeSix('initial')
    await workspace.enableFullSync(true); const packets = await workspace.enableFullSyncPackets(true)
    mocks.changes.mockResolvedValue({ status: 200, rawBody: selected.currentChangesRaw }); await packets.pullComplete()
    const ready = await packets.previewRefresh('analysis-ui-refresh-unknown'), actual = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === 'portfolio_sync_metadata' && key === 'current') this.transaction.addEventListener('complete', () => { Reflect.apply(forceCloseDatabase, undefined, [this.transaction.db]) })
      return request
    })
    await expect(packets.commitRefresh(ready.request!, true)).rejects.toBeInstanceOf(Error); vi.restoreAllMocks()
    expect(workspace.fullSyncLocalPending).not.toBeNull()
    const root = await mount(); await check(root, '我同意本轮读取私人策略'); await click(root, '启用分析')
    expect(analysis.enabled).toBe(false); expect(mocks.analysis).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
  })
  it('renders the same qualified run through actual Home, Watchlist and FundDetail consumers, then revokes all three on a manual edit', async () => {
    const selected = await completeSix(), loading = vi.spyOn(workspace, 'load')
    const home = await mountConsumer(HomePage), watch = await mountConsumer(WatchlistPage), detail = await mountConsumer(FundDetailV8Panel, { code: '510300', localHoldingPending: true })
    // Actual mounted pages start actual workspace reads. Await those returned
    // operations rather than assuming a few event-loop turns settle IDB/hash
    // work; a later legitimate hydrate must invalidate an older capture.
    await Promise.all(loading.mock.results.map(result => result.value)); await nextTick()
    const root = await mount(); await sixQualified(root, selected); await nextTick()
    const decision = JSON.parse(selected.response).run.components[0].decision
    expect(output(home)).toContain(decision.decision_id)
    expect(output(watch)).toContain('本轮分析未提供同来源历史比较')
    expect(all(detail).some(row => row.props.title === decision.decision_id)).toBe(true)
    expect(workspace.hasLocalChanges()).toBe(true); expect(analysis.resultFor('510300')!.decision.decision_id).toBe(decision.decision_id)
    const cash = selected.currentRecords.find(row => row.kind === 'manual_asset' && !row.deleted)!
    await workspace.editPortfolio(manualCommand(cash, { value: 1, note: null }))
    await nextTick(); expect(analysis.results).toEqual([])
    expect(output(home)).not.toContain(decision.decision_id); expect(output(watch)).not.toContain('本轮分析未提供同来源历史比较')
    expect(all(detail).some(row => row.props.title === decision.decision_id)).toBe(false); expect(mocks.write).toHaveBeenCalledOnce()
  })
})
