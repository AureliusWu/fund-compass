import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { clearOwnerSession, loginOwnerSession } from '@/stores/ownerSession'
import { useWatchlistStore } from '@/stores/watchlist'
import type { BuiltOwnerSyncRequest, OwnerSyncRecord, OwnerSyncValues } from '@/utils/ownerSyncContract'
import type { OwnerSyncCandidateTransport } from '@/stores/ownerSyncCandidate'
import type { OwnerSyncOutbox } from '@/stores/ownerSyncOutbox'
import OwnerSyncPanel from './OwnerSyncPanel.vue'
import WatchlistPage from '@/pages/WatchlistPage.vue'

const mocks = vi.hoisted(() => ({
  factory: vi.fn(), open: vi.fn(), close: vi.fn(), write: vi.fn(), receipt: vi.fn(), changes: vi.fn(),
  fetch: vi.fn(), confirm: vi.fn(), toast: vi.fn(), handles: [] as Array<{ close(): void }>,
}))
vi.mock('@/api/owner-sync-transport', () => ({ createOwnerSyncHttpTransport: mocks.factory }))
vi.mock('@/stores/ownerSyncOutbox', async original => {
  const actual = await original<typeof import('@/stores/ownerSyncOutbox')>()
  return { ...actual, openOwnerSyncOutbox: async (factory: IDBFactory, target: string) => {
    mocks.open()
    const handle = await actual.openOwnerSyncOutbox(factory, target)
    mocks.handles.push(handle)
    return { targetFingerprint: handle.targetFingerprint, read: handle.read, compareAndSwap: handle.compareAndSwap,
      close() { mocks.close(); handle.close() } } satisfies OwnerSyncOutbox
  } }
})
vi.mock('vant', () => ({ showConfirmDialog: mocks.confirm, showToast: mocks.toast }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/OwnerSessionPanel.vue', () => ({ default: { render: () => null } }))
vi.mock('@/api/client', async original => ({ ...await original<typeof import('@/api/client')>(),
  getV8Decision: vi.fn(async () => { throw new Error('synthetic unavailable') }),
  getV8DecisionDiff: vi.fn(async () => { throw new Error('synthetic unavailable') }), getFunds: vi.fn() }))
vi.mock('@/utils/estimate', async original => ({ ...await original<typeof import('@/utils/estimate')>(),
  fetchEstimates: vi.fn(async () => new Map()), loadCachedEstimates: vi.fn(() => new Map()) }))

// Same real-SFC/custom-renderer approach as WatchlistPage.test.ts. Native button
// and checkbox handlers run; controller/parser/IDB/session are not string mocks.
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
const output = (item: Node): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(output).join(' ')
const all = (item: Node): Node[] => [item, ...item.children.flatMap(all)]
const buttons = (root: Node) => all(root).filter(item => item.tag === 'button')
function button(root: Node, label: string) {
  const item = buttons(root).find(item => output(item).trim() === label)
  expect(item, label).toBeDefined()
  return item!
}
async function click(root: Node, label: string) {
  const item = button(root, label)
  expect(item.props.disabled, label).not.toBe(true)
  await (item.props.onClick as (event: object) => unknown)({ stopPropagation() {}, preventDefault() {} })
  await nextTick()
}
async function check(root: Node, name: string, value = true) {
  const item = all(root).find(item => item.tag === 'input' && item.props.name === name)
  expect(item, name).toBeDefined()
  expect(item!.props.disabled, name).not.toBe(true)
  ;(item!.props.onChange as (event: object) => void)({ target: { checked: value } })
  await nextTick()
}
const TARGET = 'a'.repeat(64)
const TOKEN = 'own_' + 't'.repeat(43)
const storage = new Map<string, string>()
const apps: Array<() => void> = []
const stores: ReturnType<typeof useWatchlistStore>[] = []
const blobs: Blob[] = []
let watchlist: ReturnType<typeof useWatchlistStore>
let cloud: Map<string, OwnerSyncRecord>
let head = 1
function record(key: string, values: OwnerSyncValues, kind: 'watch' | 'holding' = 'holding', revision = 1, deleted = false): OwnerSyncRecord {
  return { key, kind, deleted, record_revision: revision, lifecycle_revision: revision,
    field_revisions: { name: revision, shares: revision, cost: revision, target_weight: revision }, values }
}
function page(parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0]) {
  const changes = [...cloud.values()].filter(item => item.record_revision > parameters.sinceRevision)
    .sort((left, right) => left.record_revision - right.record_revision || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return { status: 200, rawBody: JSON.stringify({ upper_revision: head, changes, next_cursor: null, complete: true }) }
}
function committed(packet: BuiltOwnerSyncRequest) {
  head++
  const records = packet.request.operations.map(operation => {
    const previous = cloud.get(operation.key)
    const row = record(operation.key, { ...(previous?.values ?? { name: '合成', shares: null, cost: null, target_weight: null }), ...operation.changes },
      operation.kind as 'holding' | 'watch', head, operation.deleted)
    cloud.set(row.key, row)
    return row
  })
  return { status: 200, rawBody: JSON.stringify({ revision: head, records }) }
}
const conflict = () => ({ status: 409, rawBody: JSON.stringify({ error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
  conflicts: [{ key_digest: 'b'.repeat(16), fields: ['deleted', 'shares'] }] }) })
async function login(ttl = 600_000) {
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: TOKEN, token_type: 'Bearer', owner_id: 'owner',
    expires_at: new Date(Date.now() + ttl).toISOString(), scopes: ['read_private', 'write_holdings', 'run_personal_analysis'] }) })
  await loginOwnerSession('synthetic-owner-password')
  mocks.fetch.mockClear()
}
async function mount(pageComponent = false) {
  const root = node(), app = renderer.createApp(pageComponent ? WatchlistPage : OwnerSyncPanel)
  for (const name of ['VanNavBar', 'VanPullRefresh', 'VanSwipeCell', 'VanCell', 'VanSkeleton', 'VanEmpty', 'VanLoading']) {
    app.component(name, defineComponent({ setup: (_props, { attrs, slots }) => () => h('section', attrs, [slots.default?.(), slots.right?.(), slots['right-icon']?.()]) }))
  }
  app.component('VanPopup', defineComponent({ props: ['show'], setup: (props, { slots }) => () => props.show ? h('popup', slots.default?.()) : null }))
  app.component('VanButton', defineComponent({ props: ['text'], setup: (props, { attrs, slots }) => () => h('button', attrs, [props.text, slots.default?.()]) }))
  app.mount(root); apps.push(() => app.unmount()); await nextTick()
  return root
}
async function enabled() {
  await login()
  const root = await mount()
  await click(root, '查看私人同步')
  await check(root, 'owner-sync-consent')
  await click(root, '启用本轮核对')
  return root
}
async function prepared() {
  const root = await enabled()
  await click(root, '手动拉取并预览')
  await click(root, '准备这一批原包')
  return root
}
async function slot() {
  const actual = await vi.importActual<typeof import('@/stores/ownerSyncOutbox')>('@/stores/ownerSyncOutbox')
  const handle = await actual.openOwnerSyncOutbox(globalThis.indexedDB, TARGET)
  try { return await handle.read() } finally { handle.close() }
}
function editLocal() { watchlist.setHolding('000001', 7, null, '本机已编辑', '支付宝', 0) }
beforeEach(() => {
  storage.clear(); blobs.length = 0
  storage.set('sinan_watchlist_v2', JSON.stringify([
    { code: '000001', account: '支付宝', id: '000001::支付宝', name: '本机零份', position_kind: 'holding', shares: 0, cost: null, target_weight: 0, deleted: false, local_pending: true, updated_at: '2026-10-01T00:00:00Z' },
    { code: '000001', account: '券商', id: '000001::券商', name: '本机持仓', position_kind: 'holding', shares: 100, cost: 1, target_weight: null, deleted: false, local_pending: true, updated_at: '2026-10-01T00:00:00Z' },
    { code: '000002', account: '旧账户', id: '000002::旧账户', name: '本机已删', position_kind: 'holding', shares: 0, cost: 0, target_weight: null, deleted: true, local_pending: true, updated_at: '2026-10-01T00:00:00Z' },
  ]))
  storage.set('sinan_gist_token', 'synthetic-pat-not-for-owner-export')
  storage.set('sinan_manual_assets', 'synthetic-manual-assets-must-not-be-read')
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubGlobal('document', { body: { appendChild: vi.fn() }, createElement: () => ({ href: '', download: '', click: vi.fn(), remove: vi.fn() }) })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:synthetic-owner-export' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  for (const item of [mocks.factory, mocks.open, mocks.close, mocks.write, mocks.receipt, mocks.changes, mocks.fetch]) item.mockReset()
  cloud = new Map([
    record('000001::支付宝', { name: '云端旧名', shares: 10, cost: 2, target_weight: null }),
    record('000001::券商', { name: '云端关注', shares: null, cost: null, target_weight: null }, 'watch'),
    record('000002::旧账户', { name: '待删账户', shares: 50, cost: 1, target_weight: null }),
    record('000003::仅云端', { name: '仅云端保留', shares: null, cost: null, target_weight: null }, 'watch'),
  ].map(item => [item.key, item]))
  head = 1
  mocks.changes.mockImplementation(async parameters => page(parameters))
  mocks.write.mockImplementation(async packet => committed(packet))
  mocks.receipt.mockResolvedValue({ status: 404, rawBody: '{"state":"unknown","error":"sync_result_unknown"}' })
  mocks.factory.mockResolvedValue({ targetFingerprint: TARGET, changes: mocks.changes, write: mocks.write, receipt: mocks.receipt })
  setActivePinia(createPinia()); watchlist = useWatchlistStore(); stores.push(watchlist)
})
afterEach(() => {
  apps.splice(0).forEach(unmount => unmount())
  stores.splice(0).forEach(store => store.$dispose())
  mocks.handles.splice(0).forEach(handle => handle.close())
  clearOwnerSession(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('real Owner sync panel journey', () => {
  it('is discoverable in the real Watchlist page and stays dormant on mount/open/login without round consent', async () => {
    const root = await mount(true)
    expect(output(root)).toContain('私人自选同步')
    expect(mocks.factory).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled()
    await click(root, '查看私人同步')
    expect(button(root, '启用本轮核对').props.disabled).toBe(true)
    await login(); await nextTick()
    expect(button(root, '启用本轮核对').props.disabled).toBe(true)
    expect(mocks.factory).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.changes).not.toHaveBeenCalled()
  })

  it('requires manual pull, previews every account/deletion and prepares before a separate single-send consent', async () => {
    const before = storage.get('sinan_watchlist_v2'), root = await enabled()
    expect(mocks.open).toHaveBeenCalledTimes(1); expect(mocks.changes).not.toHaveBeenCalled()
    expect(button(root, '准备这一批原包').props.disabled).toBe(true)
    await click(root, '手动拉取并预览')
    for (const text of ['支付宝', '券商', '旧账户', '删除', '0', 'null']) expect(output(root)).toContain(text)
    expect(output(root)).toContain('不含手工资产')
    expect(output(root)).toContain('同步账本确认不等于持仓决策版本')
    expect(mocks.write).not.toHaveBeenCalled()
    await click(root, '准备这一批原包')
    const original = (await slot()).entry!
    expect(original.state).toBe('prepared')
    expect(JSON.parse(original.rawBody).operations.map((item: { key: string }) => item.key).sort()).toEqual(['000001::券商', '000001::支付宝', '000002::旧账户'].sort())
    expect(button(root, '单次发送原包').props.disabled).toBe(true)
    await check(root, 'owner-sync-single-send'); await click(root, '单次发送原包')
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.write.mock.calls[0][0]).toMatchObject({ rawBody: original.rawBody, requestHash: original.requestHash })
    expect(output(root)).toContain('仅这一批原包已由同步账本确认')
    expect(storage.get('sinan_watchlist_v2')).toBe(before)
    expect(watchlist.localPending).toBe(true)
    expect(cloud.get('000003::仅云端')?.deleted).toBe(false)
  })

  it('rejects stale prepared local input before POST and can explicitly cancel unsent to preview current edits', async () => {
    const root = await prepared(), before = (await slot()).entry!
    editLocal(); await check(root, 'owner-sync-single-send'); await click(root, '单次发送原包')
    expect(mocks.write).not.toHaveBeenCalled()
    expect((await slot()).entry).toEqual(before)
    await check(root, 'owner-sync-cancel-unsent'); await click(root, '取消尚未发送的提交并重新预览')
    expect((await slot()).entry).toBeNull()
    expect(output(root)).toContain('本机已编辑')
    await click(root, '准备这一批原包')
    expect((await slot()).entry?.rawBody).not.toBe(before.rawBody)
  })

  it('unknown has only receipt/export/close, survives close and permits receipt after local edits without resend', async () => {
    const root = await prepared()
    mocks.write.mockRejectedValueOnce(new Error('synthetic lost acknowledgement'))
    await check(root, 'owner-sync-single-send'); await click(root, '单次发送原包')
    const original = (await slot()).entry!
    expect(original.state).toBe('unknown')
    expect(buttons(root).some(item => /发送原包|取消尚未发送|结束已决|手动拉取|准备这一批/.test(output(item)))).toBe(false)
    editLocal()
    await click(root, '核对原请求回执')
    expect(mocks.receipt).toHaveBeenCalledTimes(1); expect(mocks.write).toHaveBeenCalledTimes(1)
    expect((await slot()).entry).toEqual(original)
    await click(root, '关闭并隐藏')
    expect(output(root)).not.toContain(original.requestHash)
    expect(mocks.close).toHaveBeenCalled()
    await click(root, '查看私人同步'); await check(root, 'owner-sync-consent'); await click(root, '启用本轮核对')
    expect(mocks.changes).toHaveBeenCalledTimes(1); expect(mocks.write).toHaveBeenCalledTimes(1)
    const packet = mocks.write.mock.calls[0][0] as BuiltOwnerSyncRequest
    const committedResult = committed(packet)
    mocks.receipt.mockResolvedValueOnce({ status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(committedResult.rawBody) }) })
    await click(root, '核对原请求回执')
    expect(output(root)).toContain('仅这一批原包已由同步账本确认')
    expect((await slot()).entry?.state).toBe('confirmed')
    expect(watchlist.recordsFor('000001').find(item => item.account === '支付宝')?.shares).toBe(7)
    expect(watchlist.localPending).toBe(true)
  })

  it('conflict retains original packet and field summary until explicit end then complete manual refresh', async () => {
    const root = await prepared(), original = (await slot()).entry!
    mocks.write.mockResolvedValueOnce(conflict())
    await check(root, 'owner-sync-single-send'); await click(root, '单次发送原包')
    expect(output(root)).toContain('bbbbbbbbbbbbbbbb')
    expect(output(root)).toContain('冲突字段摘要')
    expect(output(root)).toContain('删除状态、份额')
    expect((await slot()).entry).toMatchObject({ rawBody: original.rawBody, requestHash: original.requestHash, state: 'conflict' })
    expect(button(root, '结束已决请求并重新拉取').props.disabled).toBe(true)
    expect(mocks.changes).toHaveBeenCalledTimes(1)
    await check(root, 'owner-sync-finish-resolved'); await click(root, '结束已决请求并重新拉取')
    expect((await slot()).entry).toBeNull(); expect(mocks.changes).toHaveBeenCalledTimes(2)
    expect(watchlist.localPending).toBe(true); expect(mocks.write).toHaveBeenCalledTimes(1)
  })

  it('rejects unordered conflict fields as unknown and retains the original packet without resending', async () => {
    const root = await prepared(), original = (await slot()).entry!
    const malformed = JSON.parse(conflict().rawBody)
    malformed.conflicts[0].fields = ['shares', 'deleted']
    mocks.write.mockResolvedValueOnce({ status: 409, rawBody: JSON.stringify(malformed) })
    await check(root, 'owner-sync-single-send'); await click(root, '单次发送原包')
    expect((await slot()).entry).toMatchObject({ rawBody: original.rawBody, requestHash: original.requestHash, state: 'unknown' })
    expect(output(root)).toContain('结果未知')
    expect(output(root)).not.toContain('冲突字段摘要')
    expect(output(root)).not.toContain('bbbbbbbbbbbbbbbb')
    expect(buttons(root).some(item => /发送原包|取消尚未发送|结束已决|手动拉取|准备这一批/.test(output(item)))).toBe(false)
    await click(root, '核对原请求回执')
    expect(mocks.receipt).toHaveBeenCalledTimes(1)
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.changes).toHaveBeenCalledTimes(1)
    expect(watchlist.localPending).toBe(true)
    expect((await slot()).entry).toMatchObject({ rawBody: original.rawBody, requestHash: original.requestHash, state: 'unknown' })
  })

  it('exports the actual original raw/hash/target/state and allowlisted complete local records with tombstones, never tokens', async () => {
    const root = await prepared(), original = (await slot()).entry!
    ;(watchlist.entries[0] as unknown as Record<string, unknown>).access_token = TOKEN
    await click(root, '导出原包、哈希与状态')
    await click(root, '导出本机完整副本（含删除记录）')
    expect(blobs).toHaveLength(2)
    const rawText = await blobs[0]!.text(), localText = await blobs[1]!.text()
    expect(JSON.parse(rawText)).toEqual({ schema: 'owner-sync-original-export-1', target_fingerprint: TARGET, state: 'prepared', raw_body: original.rawBody, request_hash: original.requestHash })
    const exported = JSON.parse(localText)
    expect(exported.records).toHaveLength(3)
    expect(exported.records.find((item: { deleted?: boolean }) => item.deleted)).toMatchObject({ id: '000002::旧账户', deleted: true, shares: 0, cost: 0 })
    expect(exported.records.find((item: { account: string }) => item.account === '支付宝')).toMatchObject({ shares: 0, cost: null, target_weight: 0 })
    for (const text of [rawText, localText]) {
      expect(text).not.toContain(TOKEN); expect(text).not.toContain('synthetic-pat-not-for-owner-export')
      expect(text).not.toContain('synthetic-manual-assets-must-not-be-read')
      expect(text).not.toContain('access_token'); expect(text).not.toContain('"raw":'); expect(text).not.toContain('"memory":')
    }
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it.each(['revoke', 'logout', 'unmount'] as const)('%s aborts a late private pull and closes without erasing original storage', async action => {
    const root = await enabled()
    let finish!: (value: ReturnType<typeof page>) => void
    let signal!: AbortSignal
    mocks.changes.mockImplementationOnce((_parameters, active) => { signal = active; return new Promise(resolve => { finish = resolve }) })
    const pulling = click(root, '手动拉取并预览')
    await vi.waitFor(() => expect(mocks.changes).toHaveBeenCalledTimes(1))
    if (action === 'revoke') await check(root, 'owner-sync-consent', false)
    else if (action === 'logout') { clearOwnerSession(); await nextTick() }
    else { apps.pop()!(); await nextTick() }
    expect(signal.aborted).toBe(true)
    finish(page({ sinceRevision: 0, limit: 200 })); await pulling; await nextTick()
    expect(output(root)).not.toContain('云端旧名')
    expect(mocks.close).toHaveBeenCalled()
    expect((await slot()).entry).toBeNull()
  })

  it('reopened prepared packets cannot bypass a fresh preview and can be explicitly canceled without a POST', async () => {
    const root = await prepared(), original = (await slot()).entry!
    await click(root, '关闭并隐藏')
    await click(root, '查看私人同步'); await check(root, 'owner-sync-consent'); await click(root, '启用本轮核对')
    expect(button(root, '单次发送原包').props.disabled).toBe(true)
    expect(output(root)).toContain('本轮没有原包对应的本机预览')
    editLocal()
    await check(root, 'owner-sync-cancel-unsent'); await click(root, '取消尚未发送的提交并重新预览')
    expect((await slot()).entry).toBeNull()
    expect(output(root)).toContain('本机已编辑')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(original.state).toBe('prepared')
  })

  it.each(['unknown_field', 'cloud_tombstone'] as const)('blocks the entire preview on %s rather than uploading a partial sanitized batch', async issue => {
    if (issue === 'unknown_field') (watchlist.entries[0] as unknown as Record<string, unknown>).extra_private_field = 'synthetic'
    else cloud.set('000001::支付宝', { ...cloud.get('000001::支付宝')!, deleted: true })
    const root = await enabled()
    await click(root, '手动拉取并预览')
    expect(button(root, '准备这一批原包').props.disabled).toBe(true)
    expect(output(root)).toContain(issue === 'unknown_field' ? '本机记录不完整或不兼容' : '云端已删除，这里不会恢复旧记录')
    expect((await slot()).entry).toBeNull()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it.each(['revoke', 'logout', 'unmount'] as const)('%s during a write aborts local delivery but preserves attempted/unknown exact bytes', async action => {
    const root = await prepared(), original = (await slot()).entry!
    let finish!: (value: ReturnType<typeof committed>) => void
    let signal!: AbortSignal
    mocks.write.mockImplementationOnce((_packet, active) => { signal = active; return new Promise(resolve => { finish = resolve }) })
    await check(root, 'owner-sync-single-send')
    const sending = click(root, '单次发送原包')
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1))
    if (action === 'revoke') await check(root, 'owner-sync-consent', false)
    else if (action === 'logout') { clearOwnerSession(); await nextTick() }
    else { apps.pop()!(); await nextTick() }
    expect(signal.aborted).toBe(true)
    finish(committed(mocks.write.mock.calls[0][0])); await sending; await nextTick()
    const stored = (await slot()).entry!
    expect(['attempted', 'unknown']).toContain(stored.state)
    expect(stored).toMatchObject({ rawBody: original.rawBody, requestHash: original.requestHash })
    expect(output(root)).not.toContain(original.requestHash)
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(watchlist.localPending).toBe(true)
  })

  it('revoking during late adapter construction never opens IDB or starts a request', async () => {
    await login()
    let finish!: (value: OwnerSyncCandidateTransport) => void
    mocks.factory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const root = await mount()
    await click(root, '查看私人同步'); await check(root, 'owner-sync-consent')
    const enabling = click(root, '启用本轮核对')
    await vi.waitFor(() => expect(mocks.factory).toHaveBeenCalledTimes(1))
    await check(root, 'owner-sync-consent', false)
    finish({ targetFingerprint: TARGET, write: mocks.write, receipt: mocks.receipt, changes: mocks.changes })
    await enabling
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.changes).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled()
    expect(button(root, '启用本轮核对').props.disabled).toBe(true)
  })

  it('rechecks session expiry before an operation and hides private state without issuing its GET', async () => {
    const root = await enabled()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001)
    await click(root, '手动拉取并预览')
    expect(mocks.changes).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalled()
    expect(output(root)).toContain('请先在上方登录私人会话')
    expect(button(root, '启用本轮核对').props.disabled).toBe(true)
  })

  it('keeps unknown durable packets after revocation/unmount and never clears a local action gate', async () => {
    const root = await prepared()
    mocks.write.mockRejectedValueOnce(new Error('synthetic unknown'))
    await check(root, 'owner-sync-single-send'); await click(root, '单次发送原包')
    const original = (await slot()).entry!
    await check(root, 'owner-sync-consent', false)
    expect(output(root)).not.toContain(original.requestHash)
    apps.pop()!()
    expect((await slot()).entry).toEqual(original)
    expect(watchlist.localPending).toBe(true); expect(mocks.write).toHaveBeenCalledTimes(1)
  })
})
