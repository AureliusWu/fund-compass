/** Real SFC + Pinia authority/facade + real core/codec + fake-IDB + synthetic
 * HTTP/session. Only native DOM/download is adapted; this is not browser/cloud proof. */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createHash } from 'node:crypto'
import { createRenderer, nextTick, watch as observe, type Component } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBDatabase, IDBFactory, IDBObjectStore, forceCloseDatabase } from 'fake-indexeddb'
import { useWatchlistStore, type OwnerFullSyncFacade } from '@/stores/watchlist'
import { clearOwnerSession, loginOwnerSession } from '@/stores/ownerSession'
import { openOwnerWorkspace, buildOwnerWorkspaceEditPortfolioRequest } from '@/stores/owner-workspace'
import { getOwnerSyncTargetFingerprint } from '@/stores/ownerSession'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'
import OwnerFullSyncPanel from './OwnerFullSyncPanel.vue'
import OwnerFullSyncPacketPanel from './OwnerFullSyncPacketPanel.vue'
import OwnerPortfolioMigrationPanel from './OwnerPortfolioMigrationPanel.vue'
import OwnerWorkspaceFormatPanel from './OwnerWorkspaceFormatPanel.vue'
import OwnerAnalysisPanel from './OwnerAnalysisPanel.vue'
import { useOwnerAnalysisStore } from '@/stores/ownerAnalysis'

interface Node { tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, unknown> }
const node = (tag = 'root', text = ''): Node => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; if (at < 0) parent.children.push(item); else parent.children.splice(at, 0, item) },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)]
const output = (root: Node): string => (root.tag === '#comment' ? '' : root.text) + root.children.map(output).join(' ')
function find(root: Node, key: string, value: string) { const item = all(root).find(row => row.props[key] === value); expect(item, value).toBeDefined(); return item! }
async function event(item: Node, name: string, value?: unknown) { await (item.props[name] as (input: unknown) => unknown)(value); await nextTick() }
async function click(root: Node, action: string) { const item = find(root, 'data-action', action); expect(item.props.disabled).not.toBe(true); await event(item, 'onClick') }
async function check(root: Node, name: string) { await event(find(root, 'name', name), 'onChange', { target: { checked: true } }) }
async function select(root: Node, raw: string, sha?: string) {
  if (sha) await event(find(root, 'name', 'owner-full-sha'), 'onInput', { target: { value: sha } })
  await event(find(root, 'name', 'owner-full-file'), 'onChange', { target: { files: [new File([raw], 'synthetic-full.json')], value: 'file' } })
}
const apps: Array<() => void> = [], stores: ReturnType<typeof useWatchlistStore>[] = [], blobs: Blob[] = []
type HttpFetch = (input: string, init: RequestInit) => Promise<Response>
let store: ReturnType<typeof useWatchlistStore>, data: Map<string, string>, fetcher: Mock<HttpFetch>
const KEY = '510300::真实合成账户'
async function fresh() { setActivePinia(createPinia()); const value = useWatchlistStore(); stores.push(value); await value.initialize(); return value }
async function mount(component: Component = OwnerFullSyncPanel) {
  const root = node(), app = renderer.createApp(component); app.mount(root); const unmount = () => app.unmount(); apps.push(unmount); await nextTick(); return { root, unmount }
}
function fund(key = KEY, revision = 1): OwnerSyncRecord {
  return { key, kind: 'holding', deleted: false, record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: revision, shares: 1, cost: 1, target_weight: 1 }, values: { name: key === KEY ? '合成零份' : '其他合成', shares: 0, cost: null, target_weight: 0 } }
}
function manual(revision = 2): OwnerSyncRecord {
  return { key: 'asset:synthetic-cash', kind: 'manual_asset', deleted: false, record_revision: revision, lifecycle_revision: revision,
    field_revisions: { name: revision, cls: revision, value: revision, note: revision }, values: { name: '云端现金', cls: '现金', value: 2, note: null } }
}
function page(records: OwnerSyncRecord[], upper = 2, complete = true) {
  const last = records[records.length - 1]
  return new Response(canonicalOwnerLocal({ upper_revision: upper, changes: records, complete,
    next_cursor: complete ? null : [last.record_revision, last.key] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
function http(changes: (url: URL, init: RequestInit) => Promise<Response> | Response = () => page([fund(), manual()])) {
  fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, 'https://synthetic.example')
    if (url.pathname.endsWith('/v2/owner/session')) return new Response(JSON.stringify({ access_token: 'own_' + 'x'.repeat(43), token_type: 'Bearer',
      expires_at: new Date(Date.now() + 900_000).toISOString(), owner_id: 'owner', scopes: ['read_private', 'write_holdings', 'run_personal_analysis'] }), { status: 200 })
    if (url.pathname.endsWith('/v2/owner/sync') && init.method !== 'POST') {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer own_' + 'x'.repeat(43))
      return changes(url, init)
    }
    throw new Error('unexpected cloud write or endpoint')
  })
  vi.stubGlobal('fetch', fetcher)
}
async function upgradeSix() {
  const backup = await store.createFullSyncUpgradeBackup(); await store.previewFullSyncUpgrade(backup.raw, backup.sha256)
  await store.upgradeFullSyncFormat(backup.raw, backup.sha256, true); expect(store.localSyncFormat).toBe('v6')
  return backup
}
async function enabled(): Promise<OwnerFullSyncFacade> { http(); await loginOwnerSession('synthetic-password'); return store.enableFullSync(true) }
function packetServer(mode: 'success' | 'unknown' | 'conflict' | 'rename-conflict' = 'success') {
  const deleted = { ...manual(), key: 'asset:delete-me', values: { name: '待删除现金', cls: '现金', value: 5, note: null } } satisfies OwnerSyncRecord
  const cloud = new Map<string, OwnerSyncRecord>([fund(), deleted, manual()].map(row => [row.key, row]))
  let head = 2, posts = 0, receipts = 0, raw = '', saved: { revision: number; records: OwnerSyncRecord[] } | null = null
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  http(url => page([...cloud.values()].sort((a, b) => a.record_revision - b.record_revision || (a.key < b.key ? -1 : 1)), head))
  const baseFetch = fetcher
  fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input, 'https://synthetic.example')
    if (url.pathname.endsWith('/v2/owner/sync') && init.method === 'POST') {
      posts++; raw = String(init.body)
      const packet = JSON.parse(raw) as { operations: { key: string; kind: OwnerSyncRecord['kind']; deleted: boolean; changes?: Record<string, string | number | boolean | null> }[] }
      if (mode === 'conflict' || mode === 'rename-conflict') {
        const old = cloud.get('asset:synthetic-cash')!
        cloud.set(old.key, { ...old, record_revision: 4, values: { name: '冲突云名称', cls: '权益', value: 12, note: '云备注' },
          field_revisions: { name: 4, cls: 4, value: 4, note: 4 } }); head = 4
        if (mode === 'rename-conflict') { const previous = cloud.get(KEY)!; cloud.set(KEY, { ...previous, record_revision: 4,
          values: { ...previous.values, name: '云端旧账户已改名' }, field_revisions: { ...previous.field_revisions, name: 4 } }) }
        return json({ error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
          conflicts: [...(mode === 'rename-conflict' ? [{ key_digest: createHash('sha256').update(KEY).digest('hex').slice(0, 16), fields: ['record_revision'] }] : []),
            { key_digest: createHash('sha256').update(old.key).digest('hex').slice(0, 16), fields: ['cls', 'name', 'note', 'value'] }] }, 409)
      }
      head = 3
      const records = packet.operations.map(operation => {
        const old = cloud.get(operation.key), fields = operation.kind === 'manual_asset' ? ['name', 'cls', 'value', 'note'] : ['name', 'shares', 'cost', 'target_weight']
        const row: OwnerSyncRecord = { key: operation.key, kind: operation.kind, deleted: operation.deleted, record_revision: 3,
          lifecycle_revision: !old || old.kind !== operation.kind || old.deleted !== operation.deleted ? 3 : old.lifecycle_revision,
          field_revisions: { ...(old?.field_revisions ?? Object.fromEntries(fields.map(field => [field, 3]))),
            ...Object.fromEntries(Object.keys(operation.changes ?? {}).map(field => [field, 3])) },
          values: { ...old?.values, ...operation.changes } }
        cloud.set(row.key, row); return row
      }).sort((a, b) => a.key < b.key ? -1 : 1)
      saved = { revision: 3, records }
      if (mode === 'unknown') throw new Error('synthetic committed response lost')
      return json(saved)
    }
    if (url.pathname.includes('/v2/owner/sync/requests/')) {
      receipts++; expect(new Headers(init.headers).get('X-Owner-Sync-Request-Hash')).toBe(createHash('sha256').update(raw).digest('hex'))
      return json({ state: 'matched', status: 200, result: saved })
    }
    return baseFetch(input, init)
  })
  vi.stubGlobal('fetch', fetcher)
  return { cloud, advance(...records: OwnerSyncRecord[]) {
    for (const row of records) { cloud.set(row.key, row); head = Math.max(head, row.record_revision) }
  }, get posts() { return posts }, get receipts() { return receipts }, get raw() { return raw } }
}
async function linkedForPackets(mode: 'success' | 'unknown' | 'conflict' | 'rename-conflict' = 'success') {
  await upgradeSix(); const server = packetServer(mode); await loginOwnerSession('synthetic-password')
  const initial = await store.enableFullSync(true); await initial.pullComplete()
  const first = await initial.previewInitial([]), chosen = await initial.previewInitial(first.preview.conflicts.map(row => ({ key: row.key, field: row.field, choice: 'local' })))
  await initial.commitInitial(chosen.token!, true)
  return { server, initial }
}
async function openPackets() {
  await store.enableFullSync(true)
  const mounted = await mount(OwnerFullSyncPacketPanel)
  await check(mounted.root, 'full-packet-consent'); await click(mounted.root, 'full-packet-enable')
  return mounted
}
async function linkedForRefresh() {
  await upgradeSix(); const server = packetServer(); await loginOwnerSession('synthetic-password')
  const initial = await store.enableFullSync(true); await initial.pullComplete()
  const first = await initial.previewInitial([])
  const chosen = await initial.previewInitial(first.preview.conflicts.map(row => ({ key: row.key, field: row.field, choice: 'cloud' })))
  await initial.commitInitial(chosen.token!, true)
  return { server }
}
function advanceRefresh(server: ReturnType<typeof packetServer>) {
  const oldFund = server.cloud.get(KEY)!, oldManual = server.cloud.get('asset:synthetic-cash')!
  server.advance({ ...oldFund, record_revision: 3, field_revisions: { ...oldFund.field_revisions, name: 3 },
    values: { ...oldFund.values, name: '刷新云基金名称' } },
  { ...oldManual, record_revision: 4, field_revisions: { ...oldManual.field_revisions, note: 4 },
    values: { ...oldManual.values, note: '刷新云手工备注' } })
}
async function openRefreshPreview() {
  const linked = await linkedForRefresh(); advanceRefresh(linked.server)
  const before = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
  const mounted = await openPackets(); await click(mounted.root, 'full-refresh-pull'); await click(mounted.root, 'full-refresh-preview')
  return { ...linked, ...mounted, before }
}
beforeEach(async () => {
  clearOwnerSession()
  data = new Map([
    ['sinan_watchlist_v2', JSON.stringify([{ code: '510300', name: '合成零份', account: '真实合成账户', position_kind: 'holding', shares: 0, cost: null, target_weight: 0, updated_at: '2026-10-24T00:00:00Z' }])],
    ['sinan_manual_assets_v1', JSON.stringify([{ id: 'synthetic-cash', name: '本机现金', cls: '现金', value: 0, updated_at: '2026-10-24T00:00:00Z' }])],
    ['sinan_snapshots', JSON.stringify([{ date: '2026-10-24', value: 0, cost: 0 }, { date: '2026-10-24', value: 7, cost: 9 }])],
  ])
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('location', { origin: 'https://synthetic.example' })
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() {}, remove() {} }) })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blobs.push(value as Blob); return 'blob:synthetic-full' }); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  blobs.length = 0; fetcher = vi.fn<HttpFetch>(async () => { throw new Error('ambient IO forbidden') }); vi.stubGlobal('fetch', fetcher)
  store = await fresh(); const local = await store.createLocalWorkspaceBackup(); await store.activateLocalWorkspace(local.raw, local.sha256)
  const full = await store.createSyncRecoveryBackup(); await store.upgradeLocalSyncFormat(full.raw, full.sha256, true)
  const portfolio = await store.createPortfolioUpgradeBackup(); await store.previewPortfolioUpgrade(portfolio.raw, portfolio.sha256)
  await store.upgradePortfolioFormat(portfolio.raw, portfolio.sha256, true)
})
afterEach(() => { apps.splice(0).forEach(fn => fn()); stores.splice(0).forEach(value => value.$dispose()); clearOwnerSession(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real full initial reconciliation vertical UI', () => {
  it('does zero network by default, requires this-round export/select/independent confirmation and exports actual recovery3', async () => {
    const originals = new Map(data), { root } = await mount()
    expect(fetcher).not.toHaveBeenCalled(); expect(store.localSyncFormat).toBe('v5')
    await click(root, 'full-export-format'); const raw = await blobs[0].text(); await select(root, raw)
    expect(find(root, 'data-action', 'full-upgrade-format').props.disabled).toBe(true)
    await check(root, 'owner-full-format-confirm'); await click(root, 'full-upgrade-format')
    expect(store.localSyncFormat).toBe('v6'); expect(output(root)).toContain('没有上传，也不是云端确认')
    await store.editPortfolio({ type: 'save_manual', key: 'asset:new-after-six', values: { name: 'v6 新资产', cls: '商品', value: 3, note: null }, updated_at: '2026-10-25T00:00:00Z' })
    await click(root, 'full-export-current'); const current = JSON.parse(await blobs[1].text())
    expect(current.format).toBe('sinan-owner-workspace-recovery-3'); expect(current.physicalVersion).toBe(6)
    expect(current.local.portfolio.manual.some((row: { key: string }) => row.key === 'asset:new-after-six')).toBe(true)
    expect(current.local.fullSync.base).toBeNull(); expect(data).toEqual(originals); expect(fetcher).not.toHaveBeenCalled()
    store.$dispose(); store = await fresh(); expect(store.localSyncFormat).toBe('v6'); expect(store.portfolioState!.history).toHaveLength(2)
  })
  it('does not enable an external valid v5 file without this-round download', async () => {
    const backup = await store.createFullSyncUpgradeBackup(), { root } = await mount()
    await select(root, backup.raw, backup.sha256); await check(root, 'owner-full-format-confirm')
    expect(find(root, 'data-action', 'full-upgrade-format').props.disabled).toBe(true)
  })
  it('reselects the original file after a real initialization gap and only completes that original upgrade', async () => {
    const { root } = await mount(); await click(root, 'full-export-format'); const raw = await blobs[0].text(); await select(root, raw)
    await check(root, 'owner-full-format-confirm')
    const actual = IDBObjectStore.prototype.add
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === 'portfolio_sync_metadata' && key === 'current') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
    await click(root, 'full-upgrade-format'); expect(store.authorityState).toBe('blocked')
    vi.restoreAllMocks()
    await select(root, raw); await check(root, 'owner-full-reconcile-confirm'); await click(root, 'full-reconcile-format')
    expect(store.authorityState).toBe('idb'); expect(store.localSyncFormat).toBe('v6')
    expect(output(root)).toContain('原 v6 升级已手动核定'); expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses the real session and transport, previews manual bootstrap conflicts, invalidates changed choices, then applies only the local common base', async () => {
    await upgradeSix(); const { root } = await mount(); http(); await loginOwnerSession('synthetic-password'); await nextTick()
    expect(fetcher).toHaveBeenCalledTimes(1); await check(root, 'owner-full-consent'); await click(root, 'full-enable')
    expect(fetcher).toHaveBeenCalledTimes(1); await click(root, 'full-pull'); expect(fetcher).toHaveBeenCalledTimes(2)
    await click(root, 'full-preview'); expect(output(root)).toContain('手工资产首次协调')
    expect(find(root, 'data-action', 'full-commit').props.disabled).toBe(true)
    const radios = all(root).filter(row => row.props.type === 'radio')
    expect(radios.length).toBeGreaterThan(0)
    for (let at = 0; at < radios.length; at += 2) await event(radios[at], 'onChange') // retain local intent
    await click(root, 'full-preview'); expect(output(root)).toContain('剩余待上传意图（1）')
    await check(root, 'owner-full-link-confirm'); expect(find(root, 'data-action', 'full-commit').props.disabled).toBe(false)
    await event(all(root).filter(row => row.props.type === 'radio')[1], 'onChange')
    expect(find(root, 'data-action', 'full-commit').props.disabled).toBe(true)
    await click(root, 'full-preview'); await check(root, 'owner-full-link-confirm'); await click(root, 'full-commit')
    expect(output(root)).toContain('本次没有发送，不是云端确认')
    expect(store.portfolioState!.manual[0].values.name).toBe('云端现金'); expect(store.portfolioState!.manual[0].values.value).toBe(2)
    const recovery = await store.createPortfolioRecoveryBackup(), parsed = JSON.parse(recovery.raw)
    expect(parsed.local.fullSync.base.pulledRevision).toBe(2); expect(parsed.local.sync.base).toBeNull()
    expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit).method !== 'POST' || JSON.stringify((init as RequestInit).body).includes('synthetic-password'))).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('closes legacy migration/format entry points and keeps v6 analysis off without explicit source consent', async () => {
    await upgradeSix()
    const migration = await mount(OwnerPortfolioMigrationPanel), format = await mount(OwnerWorkspaceFormatPanel), analysis = await mount(OwnerAnalysisPanel)
    expect(output(migration.root)).toContain('当前 v6'); expect(all(migration.root).some(row => row.props['data-action'] === 'export-portfolio-upgrade')).toBe(false)
    expect(all(format.root).some(row => row.props['data-action'] === 'export-format')).toBe(false)
    expect(output(analysis.root)).toContain('v6 完整格式可独立核对分析来源')
    const ownerAnalysis = useOwnerAnalysisStore(); apps.push(() => ownerAnalysis.$dispose()); expect(ownerAnalysis.enabled).toBe(false)
    await expect(store.enableWorkspaceSync(true)).rejects.toBeInstanceOf(Error)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('app-owned full reconciliation guards and complete read', () => {
  it('counts initial-resolution copy in the original12s before any IDB work and never promotes a previously partial C', async () => {
    await upgradeSix()
    const first = [...Array.from({ length: 199 }, (_, at) => fund(String(at).padStart(6, '0') + '::')), fund()]
    http(url => url.searchParams.has('cursor_revision') ? new Response('{}', { status: 503 }) : page(first, 9, false))
    await loginOwnerSession('synthetic-password'); const facade = await store.enableFullSync(true)
    await expect(facade.pullComplete()).rejects.toBeInstanceOf(Error)
    expect(facade.status()).toMatchObject({ completeReady: false, minimumObservedRevision: 9 })
    const before = (await store.createPortfolioRecoveryBackup()).raw, previousCalls = fetcher.mock.calls.length
    const read = vi.spyOn(IDBObjectStore.prototype, 'get'), put = vi.spyOn(IDBObjectStore.prototype, 'put')
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const actual = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) { clock = 13_000; return actual.call(this, input) })
    await expect(facade.previewInitial([])).rejects.toBeInstanceOf(Error)
    expect(read).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(previousCalls)
    expect(store.fullSyncLocalPending).toBeNull(); vi.restoreAllMocks()
    expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before)
    const current = await store.enableFullSync(true)
    expect(current.status()).toMatchObject({ completeReady: false, minimumObservedRevision: 9 })
    await expect(current.previewInitial([])).rejects.toBeInstanceOf(Error)
    expect(fetcher).toHaveBeenCalledTimes(previousCalls)
  })
  it('gives initial preview only the8s remaining after its synchronous resolution copy spends4s', async () => {
    await upgradeSix(); const facade = await enabled(); await facade.pullComplete()
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const actual = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) { clock = 5000; return actual.call(this, input) })
    const timer = vi.spyOn(globalThis, 'setTimeout'), preview = await facade.previewInitial([])
    expect(timer.mock.calls[0][1]).toBe(8000); expect(preview.token).toBeNull(); expect(preview.preview.conflicts).toHaveLength(1)
  })
  it('pins since0/upper/200 and folds ordered history rather than mistaking a partial page or old record for current C', async () => {
    await upgradeSix()
    const first = [...Array.from({ length: 199 }, (_, at) => fund(String(at).padStart(6, '0') + '::')), fund()]
    http(url => {
      expect(url.searchParams.get('since_revision')).toBe('0'); expect(url.searchParams.get('limit')).toBe('200')
      if (!url.searchParams.has('cursor_revision')) { expect(url.searchParams.has('upper_revision')).toBe(false); return page(first, 9, false) }
      expect(url.searchParams.get('upper_revision')).toBe('9'); expect(url.searchParams.get('cursor_revision')).toBe('1')
      return page([fund(KEY, 2), manual(9)], 9)
    })
    await loginOwnerSession('synthetic-password'); const facade = await store.enableFullSync(true)
    expect(await facade.pullComplete()).toEqual({ revision: 9, records: 201 }); expect(fetcher).toHaveBeenCalledTimes(3)
    const preview = await facade.previewInitial([]); expect(preview.preview.baseC!.records.filter(row => row.key === KEY)).toHaveLength(1)
    expect(preview.preview.baseC!.records.find(row => row.key === KEY)!.record_revision).toBe(2)
  })
  it('retains the observed head floor after later page failure and refuses a lower complete head without publishing partial C', async () => {
    await upgradeSix(); const first = [...Array.from({ length: 199 }, (_, at) => fund(String(at).padStart(6, '0') + '::')), fund()]
    let low = false
    http(url => low ? page([fund(), manual(8)], 8) : url.searchParams.has('cursor_revision') ? new Response('{}', { status: 503 }) : page(first, 9, false))
    await loginOwnerSession('synthetic-password'); const facade = await store.enableFullSync(true)
    await expect(facade.pullComplete()).rejects.toBeInstanceOf(Error)
    expect(facade.status()).toMatchObject({ completeReady: false, minimumObservedRevision: 9 })
    await expect(facade.previewInitial([])).rejects.toBeInstanceOf(Error)
    low = true; await expect(facade.pullComplete()).rejects.toBeInstanceOf(Error)
    expect(facade.status()).toMatchObject({ completeReady: false, minimumObservedRevision: 9 })
  })
  it('rejects actual current-memory drift and stale previews without taking a UI-provided guard', async () => {
    await upgradeSix(); const facade = await enabled(); await facade.pullComplete()
    store.entries[0].name = 'tampered current memory'
    await expect(facade.previewInitial([])).rejects.toBeInstanceOf(Error)
    expect(facade.status().completeReady).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects an actual competing complete-database edit instead of trusting the old in-memory portfolio', async () => {
    await upgradeSix(); const facade = await enabled(); await facade.pullComplete()
    const competing = await openOwnerWorkspace(globalThis.indexedDB, await getOwnerSyncTargetFingerprint(), { existingOnly: true })
    const controller = new AbortController(), guard = { signal: controller.signal, assertActive() { if (controller.signal.aborted) throw new Error('revoked competing test context') } }
    try {
      const expected = await competing.readLocalState(guard)
      await competing.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(competing.targetFingerprint, { id: 'competing-full-local-edit', expected,
        command: { type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '另一页更新', cls: '商品', value: 7, note: '' }, updated_at: '2026-10-25T00:00:00Z' } }), guard)
      await expect(facade.previewInitial([])).rejects.toBeInstanceOf(Error)
      expect(facade.status().completeReady).toBe(false); expect(store.portfolioState!.manual[0].values.value).toBe(0)
    } finally { controller.abort(); competing.close() }
  })
  it('synchronously hides rendered cloud values when an actual local writer publishes a new source', async () => {
    await upgradeSix(); const { root } = await mount(); http(); await loginOwnerSession('synthetic-password'); await nextTick()
    await check(root, 'owner-full-consent'); await click(root, 'full-enable'); await click(root, 'full-pull'); await click(root, 'full-preview')
    expect(output(root)).toContain('云端现金')
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '本机改名', cls: '现金', value: 0, note: null }, updated_at: '2026-10-25T00:00:00Z' })
    await nextTick(); expect(output(root)).not.toContain('云端现金'); expect(all(root).some(row => row.props['data-action'] === 'full-commit')).toBe(false)
  })
  it('clears private C/preview synchronously on logout and rejects a late real HTTP response', async () => {
    await upgradeSix(); let finish!: (response: Response) => void, started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    http(() => new Promise<Response>(resolve => { finish = resolve; started() }))
    await loginOwnerSession('synthetic-password'); const facade = await store.enableFullSync(true)
    const pending = facade.pullComplete(); await ready; clearOwnerSession(); finish(page([fund(), manual()]))
    await expect(pending).rejects.toBeInstanceOf(Error)
    expect(facade.status()).toMatchObject({ enabled: false, completeReady: false }); expect(store.fullSyncLocalPending).toBeNull()
  })
  it('rejects an endpoint change and never sends to a replacement target', async () => {
    await upgradeSix(); const facade = await enabled(); await facade.pullComplete()
    vi.stubGlobal('location', { origin: 'https://different.synthetic.example' })
    expect(facade.status()).toMatchObject({ enabled: false, completeReady: false })
    await expect(facade.previewInitial([])).rejects.toBeInstanceOf(Error); expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('retains the original local id/hash after a committed response loss, blocks editing, and only checks its actual receipt', async () => {
    await upgradeSix(); const facade = await enabled(); await facade.pullComplete()
    const first = await facade.previewInitial([])
    const resolutions = first.preview.conflicts.map(row => ({ key: row.key, field: row.field, choice: 'cloud' as const }))
    const ready = await facade.previewInitial(resolutions), actual = IDBObjectStore.prototype.put
    let reached = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === 'portfolio_sync_metadata' && key === 'current') this.transaction.addEventListener('complete', () => {
        reached = true; Reflect.apply(forceCloseDatabase, undefined, [this.transaction.db])
      })
      return request
    })
    await expect(facade.commitInitial(ready.token!, true)).rejects.toBeInstanceOf(Error); expect(reached).toBe(true); vi.restoreAllMocks()
    const original = store.fullSyncLocalPending; expect(original).not.toBeNull(); expect(store.hasPendingLocalWorkspaceEdit).toBe(true)
    await expect(store.editPortfolio({ type: 'remove_manual', key: 'asset:synthetic-cash', updated_at: '2026-10-25T00:00:00Z' })).rejects.toBeInstanceOf(Error)
    store.disableFullSync(); expect(store.fullSyncLocalPending).toEqual(original)
    const result = await store.reconcileFullSyncLocal(); expect(result.state).toBe('matched')
    expect(store.fullSyncLocalPending).toBeNull(); expect(store.portfolioState!.manual[0].values.value).toBe(2); expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('retains the original local tuple if logout occurs synchronously during publication, then checks only that receipt', async () => {
    await upgradeSix(); const facade = await enabled(); await facade.pullComplete()
    const first = await facade.previewInitial([]), ready = await facade.previewInitial(first.preview.conflicts.map(row => ({ key: row.key, field: row.field, choice: 'cloud' })))
    const stop = observe(() => store.portfolioState, () => clearOwnerSession(), { flush: 'sync' })
    await expect(facade.commitInitial(ready.token!, true)).rejects.toBeInstanceOf(Error); stop()
    expect(store.fullSyncLocalPending).not.toBeNull(); expect(facade.status().enabled).toBe(false)
    expect((await store.reconcileFullSyncLocal()).state).toBe('matched'); expect(store.fullSyncLocalPending).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('real complete fund/manual packet, single delivery and strict ACK UI', () => {
  it.each(['commitPreparation', 'previewAcknowledgement', 'commitAcknowledgement'] as const)
    ('includes synchronous %s input-copy cost in the original12s and performs no locator/prepare/write/POST after expiry', async operation => {
      const { server } = await linkedForPackets(), packets = await store.enableFullSyncPackets(true)
      const prepared = await packets.previewPreparation('copy-deadline-prepare-0001')
      let acknowledgement: Awaited<ReturnType<typeof packets.previewAcknowledgement>> | null = null
      if (operation !== 'commitPreparation') {
        await packets.commitPreparation(prepared, true); await packets.sendOnce(); await packets.pullComplete()
        acknowledgement = await packets.previewAcknowledgement('copy-deadline-ack-0001', [])
      }
      const before = (await store.createPortfolioRecoveryBackup()).raw, previousPosts = server.posts
      const read = vi.spyOn(IDBObjectStore.prototype, 'get'), put = vi.spyOn(IDBObjectStore.prototype, 'put')
      let clock = 1000
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      const actual = TextEncoder.prototype.encode
      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) {
        clock = 13_000; return actual.call(this, input) // real descriptor/byte copy spends exactly12s
      })
      const pending = operation === 'commitPreparation' ? packets.commitPreparation(prepared, true)
        : operation === 'previewAcknowledgement' ? packets.previewAcknowledgement('copy-deadline-ack-0001', [])
          : packets.commitAcknowledgement(acknowledgement!.request!, true)
      await expect(pending).rejects.toBeInstanceOf(Error)
      expect(read).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(server.posts).toBe(previousPosts)
      expect(store.fullSyncLocalPending).toBeNull(); vi.restoreAllMocks()
      expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before)
    })
  it.each([NaN, Infinity, -1])('rejects bad/backwards copy clocks %s before touching the existing original packet', async invalidClock => {
    const { server } = await linkedForPackets(), packets = await store.enableFullSyncPackets(true)
    const prepared = await packets.previewPreparation('copy-clock-prepare-0001'); await packets.commitPreparation(prepared, true)
    await packets.sendOnce(); await packets.pullComplete(); const acknowledgement = await packets.previewAcknowledgement('copy-clock-ack-0001', [])
    const before = (await store.createPortfolioRecoveryBackup()).raw, read = vi.spyOn(IDBObjectStore.prototype, 'get'), put = vi.spyOn(IDBObjectStore.prototype, 'put')
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const actual = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) { clock = invalidClock; return actual.call(this, input) })
    await expect(packets.commitAcknowledgement(acknowledgement.request!, true)).rejects.toBeInstanceOf(Error)
    expect(read).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(server.posts).toBe(1)
    vi.restoreAllMocks(); expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before)
  })
  it('starts only the remaining timer after owning an input instead of restarting12s', async () => {
    await linkedForPackets(); const packets = await store.enableFullSyncPackets(true), original = await packets.previewPreparation('copy-timer-prepare-0001')
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const actual = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) { clock = 5000; return actual.call(this, input) })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    await packets.commitPreparation(original, true)
    expect(timer.mock.calls[0][1]).toBe(8000)
  })
  it('owns the exact preparation request before the real asynchronous locator preflight can observe caller mutations', async () => {
    await linkedForPackets(); const packets = await store.enableFullSyncPackets(true)
    const original = await packets.previewPreparation('owner-copy-prepare-0001'), mutable = structuredClone(original)
    const actual = IDBObjectStore.prototype.get, observed: string[] = []
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      observed.push(this.name); return actual.call(this, key)
    })
    const pending = packets.commitPreparation(mutable, true)
    expect(observed).toContain('authority') // its real IDB request has not completed yet
    Object.assign(mutable, { id: 'later-mutated-prepare-0001', packet: { ...mutable.packet, rawBody: '{}' } })
    await pending; vi.restoreAllMocks()
    const current = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local.fullSync.pending
    expect(current.preparationHash).toBe(original.hash); expect(current.rawBody).toBe(original.packet.rawBody)
  })
  it('owns ACK resolutions and the original ACK request synchronously before real locator preflight yields', async () => {
    await linkedForPackets('conflict')
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '本机四字段', cls: '商品', value: 8, note: '本机备注' }, updated_at: '2026-10-25T00:00:00Z' })
    await store.enableFullSync(true); const packets = await store.enableFullSyncPackets(true)
    const prepare = await packets.previewPreparation('owner-copy-ack-prepare'); await packets.commitPreparation(prepare, true)
    await packets.sendOnce(); await packets.pullComplete(); const first = await packets.previewAcknowledgement('owner-copy-ack-0001', [])
    const resolutions = first.preview.conflicts.map(row => ({ key: row.key, field: row.field, choice: 'cloud' as 'local' | 'cloud' }))
    const actual = IDBObjectStore.prototype.get, observed: string[] = []
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) { observed.push(this.name); return actual.call(this, key) })
    const pendingPreview = packets.previewAcknowledgement('owner-copy-ack-0001', resolutions)
    expect(observed).toContain('authority'); for (const row of resolutions) row.choice = 'local'
    const preview = await pendingPreview
    expect(preview.preview.conflicts.every(row => row.choice === 'cloud')).toBe(true); expect(preview.request).not.toBeNull()
    const request = structuredClone(preview.request!), pendingCommit = packets.commitAcknowledgement(request, true)
    Object.assign(request, { id: 'later-mutated-ack-0001', resolutions })
    await pendingCommit; vi.restoreAllMocks()
    const current = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(current.fullSync.recentReceipt.id).toBe('owner-copy-ack-0001'); expect(current.outbox.entry).toBeNull()
    expect(store.portfolioState!.manual[0].values.value).toBe(12)
  })
  it('previews all fund/manual create/edit/delete with zero/null, persists exact bytes, sends once and applies complete D in an independent ACK', async () => {
    const { server } = await linkedForPackets()
    await store.setHolding('510300', 0, 0, '改名零份', '真实合成账户', null)
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '手工新名称', cls: '商品', value: 0, note: '' }, updated_at: '2026-10-25T00:00:00Z' })
    await store.editPortfolio({ type: 'remove_manual', key: 'asset:delete-me', updated_at: '2026-10-25T00:00:00Z' })
    await store.editPortfolio({ type: 'save_manual', key: 'asset:new-zero', values: { name: '新零金额', cls: '现金', value: 0, note: null }, updated_at: '2026-10-25T00:00:00Z' })
    const { root } = await openPackets(); expect(server.posts).toBe(0)
    await click(root, 'full-packet-prepare-preview'); expect(output(root)).toContain('4 项操作'); expect(output(root)).toContain('手工资产'); expect(output(root)).toContain('null（未知）')
    expect(find(root, 'data-action', 'full-packet-prepare-commit').props.disabled).toBe(true)
    await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    const protectedFile = await store.createPortfolioRecoveryBackup(), prepared = JSON.parse(protectedFile.raw)
    expect(prepared.local.outbox.entry.state).toBe('prepared'); expect(prepared.local.fullSync.pending.rawBody).toBe(prepared.local.outbox.entry.rawBody)
    expect(find(root, 'data-action', 'full-packet-send').props.disabled).toBe(true); expect(server.posts).toBe(0)
    await check(root, 'full-packet-send-confirm'); await click(root, 'full-packet-send'); expect(server.posts).toBe(1)
    expect(server.raw).toBe(prepared.local.outbox.entry.rawBody); expect(output(root)).toContain('仍须完整核对')
    await click(root, 'full-packet-pull'); await click(root, 'full-packet-ack-preview')
    expect(output(root)).toContain('完整 D 截止 3'); expect(find(root, 'data-action', 'full-packet-ack-commit').props.disabled).toBe(true)
    await check(root, 'full-packet-ack-confirm'); await click(root, 'full-packet-ack-commit')
    expect(output(root)).toContain('local_pending 仍保留'); expect(server.posts).toBe(1)
    const after = JSON.parse((await store.createPortfolioRecoveryBackup()).raw)
    expect(after.local.outbox.entry).toBeNull(); expect(after.local.fullSync.base.pulledRevision).toBe(3)
    expect(after.local.portfolio.manual.find((row: { key: string }) => row.key === 'asset:delete-me').deleted).toBe(true)
    expect(after.local.portfolio.manual.every((row: { local_pending: boolean }) => row.local_pending)).toBe(true)
    expect(after.local.snapshot.entries[0]).toMatchObject({ local_pending: true, values: { shares: 0, cost: 0, target_weight: null } })
    expect(after.local.portfolio.history).toHaveLength(2); expect(protectedFile.raw).toContain('prepared')
  })
  it('retains an actually committed unknown original and offers only receipt/export, never cancel/reprepare/retry; matching receipt then complete D closes ACK', async () => {
    const { server } = await linkedForPackets('unknown'), { root } = await openPackets()
    await click(root, 'full-packet-prepare-preview'); await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    await check(root, 'full-packet-send-confirm'); await click(root, 'full-packet-send')
    expect(server.posts).toBe(1); expect(output(root)).toContain('结果未知不代表未提交')
    for (const action of ['full-packet-send', 'full-packet-cancel', 'full-packet-prepare-preview']) expect(all(root).some(row => row.props['data-action'] === action)).toBe(false)
    await click(root, 'full-packet-export'); expect(await blobs.at(-1)!.text()).toContain(server.raw.split('"').join('\\"'))
    const unknownFile = JSON.parse((await store.createPortfolioRecoveryBackup()).raw)
    expect(unknownFile.local.outbox.entry.state).toBe('unknown')
    await click(root, 'full-packet-receipt'); expect(server.receipts).toBe(1); expect(server.posts).toBe(1)
    await click(root, 'full-packet-pull'); await click(root, 'full-packet-ack-preview'); await check(root, 'full-packet-ack-confirm'); await click(root, 'full-packet-ack-commit')
    expect(JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local.outbox.entry).toBeNull(); expect(server.posts).toBe(1)
  })
  it('shows every manual ACK field conflict and invalidates confirmation whenever a field choice changes', async () => {
    const { server } = await linkedForPackets('conflict')
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '本机四字段', cls: '商品', value: 8, note: '本机备注' }, updated_at: '2026-10-25T00:00:00Z' })
    const { root } = await openPackets(); await click(root, 'full-packet-prepare-preview'); await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    await check(root, 'full-packet-send-confirm'); await click(root, 'full-packet-send'); await click(root, 'full-packet-pull'); await click(root, 'full-packet-ack-preview')
    const radios = all(root).filter(row => row.props.type === 'radio'); expect(radios).toHaveLength(8)
    for (const field of ['名称', '类别', '金额', '备注']) expect(output(root)).toContain(field)
    expect(find(root, 'data-action', 'full-packet-ack-commit').props.disabled).toBe(true)
    for (let at = 1; at < radios.length; at += 2) await event(radios[at], 'onChange')
    await click(root, 'full-packet-ack-preview'); await check(root, 'full-packet-ack-confirm')
    expect(find(root, 'data-action', 'full-packet-ack-commit').props.disabled).toBe(false)
    await event(all(root).filter(row => row.props.type === 'radio')[0], 'onChange')
    expect(find(root, 'data-action', 'full-packet-ack-commit').props.disabled).toBe(true)
    await click(root, 'full-packet-ack-preview'); await check(root, 'full-packet-ack-confirm'); await click(root, 'full-packet-ack-commit')
    expect(server.posts).toBe(1); expect(store.portfolioState!.manual.find(row => row.key === 'asset:synthetic-cash')!.values.value).toBe(12)
    expect(JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local.outbox.entry).toBeNull()
  })
  it('keeps account rename choices atomic and preserves the cancelled unuploaded new key as a tombstone', async () => {
    const { server } = await linkedForPackets('rename-conflict')
    await store.saveHolding({ code: '510300', account: '更名新账户', name: '本机新账户', position_kind: 'holding', shares: 0, cost: null, target_weight: 0 },
      { id: KEY, snapshot: store.entrySnapshot(KEY)! }, { confirmed: true })
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '本机四字段', cls: '商品', value: 8, note: '本机备注' }, updated_at: '2026-10-25T00:00:00Z' })
    const { root } = await openPackets(); await click(root, 'full-packet-prepare-preview'); await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    await check(root, 'full-packet-send-confirm'); await click(root, 'full-packet-send'); await click(root, 'full-packet-pull'); await click(root, 'full-packet-ack-preview')
    expect(output(root)).toContain('账户更名须整组选择'); expect(output(root)).toContain('更名新账户')
    const radios = all(root).filter(row => row.props.type === 'radio')
    for (let at = 1; at < radios.length; at += 2) await event(radios[at], 'onChange')
    await click(root, 'full-packet-ack-preview'); await check(root, 'full-packet-ack-confirm'); await click(root, 'full-packet-ack-commit')
    const state = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(state.snapshot.entries.find((row: { key: string }) => row.key === KEY)).toMatchObject({ deleted: false, values: { name: '云端旧账户已改名' } })
    expect(state.snapshot.entries.find((row: { key: string }) => row.key === '510300::更名新账户')).toMatchObject({ deleted: true, local_pending: true })
    expect(server.posts).toBe(1)
  })
  it('cancels only the still-prepared original with independent confirmation and retains complete local intent and B', async () => {
    const { server } = await linkedForPackets(), { root } = await openPackets()
    const before = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    await click(root, 'full-packet-prepare-preview'); await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    expect(find(root, 'data-action', 'full-packet-cancel').props.disabled).toBe(true)
    await check(root, 'full-packet-cancel-confirm'); await click(root, 'full-packet-cancel')
    const after = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(after.outbox.entry).toBeNull(); expect(after.portfolio).toEqual(before.portfolio); expect(after.fullSync.base).toEqual(before.fullSync.base)
    expect(server.posts).toBe(0)
  })
  it('keeps an unknown original across actual store disposal/reopen and never resends during hydration', async () => {
    const { server } = await linkedForPackets('unknown'), mounted = await openPackets(), root = mounted.root
    await click(root, 'full-packet-prepare-preview'); await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    await check(root, 'full-packet-send-confirm'); await click(root, 'full-packet-send')
    const original = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local.fullSync.pending
    mounted.unmount(); apps.splice(apps.indexOf(mounted.unmount), 1); store.$dispose(); store = await fresh()
    const next = await openPackets(); expect(server.posts).toBe(1); expect(output(next.root)).toContain('结果未知不代表未提交')
    expect(JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local.fullSync.pending).toEqual(original)
    expect(all(next.root).some(row => row.props['data-action'] === 'full-packet-send')).toBe(false)
    await click(next.root, 'full-packet-receipt'); expect(server.posts).toBe(1); expect(server.receipts).toBe(1)
  })
  it.each(['prepare', 'ack'] as const)('retains the real %s local tuple after commit response loss and uses fullSyncReceipt rather than localReceipt', async operation => {
    const { server } = await linkedForPackets(), { root } = await openPackets()
    await click(root, 'full-packet-prepare-preview')
    if (operation === 'ack') {
      await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
      await check(root, 'full-packet-send-confirm'); await click(root, 'full-packet-send'); await click(root, 'full-packet-pull'); await click(root, 'full-packet-ack-preview')
    }
    const actual = IDBObjectStore.prototype.put; let reached = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === 'portfolio_sync_metadata' && key === 'current') this.transaction.addEventListener('complete', () => {
        reached = true; Reflect.apply(forceCloseDatabase, undefined, [this.transaction.db])
      })
      return request
    })
    await check(root, operation === 'prepare' ? 'full-packet-prepare-confirm' : 'full-packet-ack-confirm')
    await click(root, operation === 'prepare' ? 'full-packet-prepare-commit' : 'full-packet-ack-commit')
    expect(reached).toBe(true); vi.restoreAllMocks(); expect(store.fullSyncLocalPending).not.toBeNull()
    expect(store.hasPendingLocalWorkspaceEdit).toBe(true); await click(root, 'full-packet-local-receipt')
    expect(store.fullSyncLocalPending).toBeNull()
    const state = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(state.outbox.entry?.state ?? null).toBe(operation === 'prepare' ? 'prepared' : null)
    expect(server.posts).toBe(operation === 'prepare' ? 0 : 1)
  })
  it('keeps the prepare tuple when logout happens during publication, then checks that tuple after a new explicit consent', async () => {
    const { server } = await linkedForPackets(), { root } = await openPackets()
    await click(root, 'full-packet-prepare-preview')
    const stop = observe(() => store.portfolioState, () => clearOwnerSession(), { flush: 'sync' })
    await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit'); stop()
    const original = store.fullSyncLocalPending; expect(original).not.toBeNull(); expect(output(root)).not.toContain('手工资产 · 创建')
    await loginOwnerSession('synthetic-password'); await store.enableFullSync(true)
    await check(root, 'full-packet-consent'); await click(root, 'full-packet-enable'); await click(root, 'full-packet-local-receipt')
    expect(store.fullSyncLocalPending).toBeNull(); expect(JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local.fullSync.pending.preparationHash).toBe(original!.hash)
    expect(server.posts).toBe(0)
  })
  it('hides private packet payloads on logout during the real POST, rejects its late response and still cannot resend after re-enable', async () => {
    const { server } = await linkedForPackets(), { root } = await openPackets()
    await click(root, 'full-packet-prepare-preview'); await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    const actual = fetcher; let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => { const response = await actual(input, init)
      if (init.method === 'POST' && String(input).endsWith('/sync')) { started(); await gate }
      return response
    }))
    await check(root, 'full-packet-send-confirm')
    const sending = event(find(root, 'data-action', 'full-packet-send'), 'onClick'); await waiting
    clearOwnerSession(); release(); await sending; expect(server.posts).toBe(1)
    expect(output(root)).not.toContain(server.raw); expect(all(root).some(row => row.props['data-action'] === 'full-packet-send')).toBe(false)
    await loginOwnerSession('synthetic-password'); await store.enableFullSync(true)
    await check(root, 'full-packet-consent'); await click(root, 'full-packet-enable')
    expect(all(root).some(row => row.props['data-action'] === 'full-packet-send')).toBe(false)
    await click(root, 'full-packet-receipt'); expect(server.posts).toBe(1)
  })
})

describe('real complete B/L/D refresh facade and SFC without a packet or POST', () => {
  it('pulls and previews a real complete D, requires independent local confirmation and publishes fund/manual together', async () => {
    const { server, root, before } = await openRefreshPreview()
    expect(output(root)).toContain('刷新云基金名称'); expect(output(root)).toContain('刷新云手工备注')
    expect(output(root)).toContain('刷新后剩余待上传意图（0）')
    expect(find(root, 'data-action', 'full-refresh-commit').props.disabled).toBe(true)
    expect(server.posts).toBe(0); expect(server.receipts).toBe(0)
    await check(root, 'full-refresh-confirm'); await click(root, 'full-refresh-commit')
    const after = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(after.fullSync.base.pulledRevision).toBe(4); expect(after.fullSync.recentReceipt.operation).toBe('refresh')
    expect(after.snapshot.entries[0]).toMatchObject({ values: { name: '刷新云基金名称', shares: 0, cost: null, target_weight: 0 }, local_pending: true })
    expect(store.portfolioState!.manual.find(row => row.key === 'asset:synthetic-cash')!.values.note).toBe('刷新云手工备注')
    expect(after.fullSync.pending).toBeNull(); expect(after.outbox.entry).toBeNull()
    expect(after.snapshot.localVersion).toBe(before.snapshot.localVersion + 1)
    expect(after.outbox.version).toBe(before.outbox.version + 1); expect(after.fullSync.epoch).toBe(before.fullSync.epoch + 1)
    for (const key of ['sync', 'portfolioUpgrade', 'fullSyncUpgrade']) expect(after[key]).toEqual(before[key])
    expect(after.portfolio.history).toEqual(before.portfolio.history); expect(after.portfolio.migration).toEqual(before.portfolio.migration)
    expect(output(root)).toContain('没有 POST，没有清除待上传意图'); expect(server.posts).toBe(0); expect(server.receipts).toBe(0)
  })
  it('preserves actual unuploaded fund and manual intent, previews every remainder and can later build the real request from refreshed B', async () => {
    const { server } = await linkedForRefresh()
    await store.setHolding('510300', 7, null, '合成零份', '真实合成账户', 0)
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '云端现金', cls: '现金', value: 8, note: null }, updated_at: '2026-10-25T00:00:00Z' })
    advanceRefresh(server); const { root } = await openPackets()
    await click(root, 'full-refresh-pull'); await click(root, 'full-refresh-preview')
    expect(output(root)).toContain('刷新后剩余待上传意图（2）'); expect(output(root)).toContain('份额：7'); expect(output(root)).toContain('金额：8')
    expect(output(root)).toContain('成本：null（未知）')
    await check(root, 'full-refresh-confirm'); await click(root, 'full-refresh-commit')
    expect(store.entries[0]).toMatchObject({ shares: 7, name: '刷新云基金名称', local_pending: true })
    expect(store.portfolioState!.manual.find(row => row.key === 'asset:synthetic-cash')!.values).toMatchObject({ value: 8, note: '刷新云手工备注' })
    await click(root, 'full-packet-prepare-preview'); expect(output(root)).toContain('2 项操作')
    await check(root, 'full-packet-prepare-confirm'); await click(root, 'full-packet-prepare-commit')
    const state = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local, packet = JSON.parse(state.fullSync.pending.rawBody)
    expect(packet.expected_revision).toBe(4); expect(packet.operations).toEqual([
      { key: KEY, kind: 'holding', deleted: false, changes: { shares: 7 }, base_values: { kind: 'holding', deleted: false, shares: 0 } },
      { key: 'asset:synthetic-cash', kind: 'manual_asset', deleted: false, changes: { value: 8 }, base_values: { kind: 'manual_asset', deleted: false, value: 2 } },
    ])
    expect(server.posts).toBe(0); expect(server.receipts).toBe(0)
  })
  it('shows a true noop and performs no strict put, version advance or new receipt even with retained local intent', async () => {
    const { server } = await linkedForPackets(), { root } = await openPackets()
    await click(root, 'full-refresh-pull')
    const before = (await store.createPortfolioRecoveryBackup()).raw, put = vi.spyOn(IDBObjectStore.prototype, 'put')
    await click(root, 'full-refresh-preview')
    expect(output(root)).toContain('无需应用：完整基线和本机后像均未改变'); expect(output(root)).toContain('刷新后剩余待上传意图（1）')
    expect(find(root, 'data-action', 'full-refresh-commit').props.disabled).toBe(true)
    expect(find(root, 'name', 'full-refresh-confirm').props.disabled).toBe(true); expect(put).not.toHaveBeenCalled()
    vi.restoreAllMocks(); expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before); expect(server.posts).toBe(0)
  })
  it('requires all same-field choices, invalidates an old UI request on a changed choice, and keeps an explicitly selected local remainder', async () => {
    const { server } = await linkedForRefresh()
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '云端现金', cls: '现金', value: 8, note: '本机备注' }, updated_at: '2026-10-25T00:00:00Z' })
    const old = server.cloud.get('asset:synthetic-cash')!
    server.advance({ ...old, record_revision: 4, field_revisions: { ...old.field_revisions, value: 4, note: 4 }, values: { ...old.values, value: 12, note: '另一设备备注' } })
    const { root } = await openPackets(); await click(root, 'full-refresh-pull'); await click(root, 'full-refresh-preview')
    expect(output(root)).toContain('同字段两侧变化'); expect(find(root, 'data-action', 'full-refresh-commit').props.disabled).toBe(true)
    const radio = (field: string, choice: number) => all(root).filter(row => row.props.type === 'radio' && row.props.name === 'refresh-' + JSON.stringify(['asset:synthetic-cash', field]))[choice]
    await event(radio('value', 1), 'onChange'); await event(radio('note', 1), 'onChange')
    await click(root, 'full-refresh-preview'); await check(root, 'full-refresh-confirm')
    expect(find(root, 'data-action', 'full-refresh-commit').props.disabled).toBe(false)
    await event(radio('value', 0), 'onChange'); expect(find(root, 'data-action', 'full-refresh-commit').props.disabled).toBe(true)
    await click(root, 'full-refresh-preview'); expect(output(root)).toContain('刷新后剩余待上传意图（1）')
    await check(root, 'full-refresh-confirm'); await click(root, 'full-refresh-commit')
    expect(store.portfolioState!.manual.find(row => row.key === 'asset:synthetic-cash')!.values).toMatchObject({ value: 8, note: '另一设备备注' })
    expect(server.posts).toBe(0); expect(server.receipts).toBe(0)
  })
  it('presents rename as an atomic group and retains the cancelled unuploaded new key as a tombstone', async () => {
    const { server } = await linkedForRefresh()
    await store.saveHolding({ code: '510300', account: '刷新更名新账户', name: '本机新账户', position_kind: 'holding', shares: 0, cost: null, target_weight: 0 },
      { id: KEY, snapshot: store.entrySnapshot(KEY)! }, { confirmed: true })
    const old = server.cloud.get(KEY)!
    server.advance({ ...old, record_revision: 3, field_revisions: { ...old.field_revisions, name: 3 }, values: { ...old.values, name: '云端保留旧账户' } })
    const { root } = await openPackets(); await click(root, 'full-refresh-pull'); await click(root, 'full-refresh-preview')
    expect(output(root)).toContain('账户更名须整组选择'); expect(output(root)).toContain('刷新更名新账户')
    const radios = all(root).filter(row => row.props.type === 'radio')
    for (let at = 1; at < radios.length; at += 2) await event(radios[at], 'onChange')
    await click(root, 'full-refresh-preview'); await check(root, 'full-refresh-confirm'); await click(root, 'full-refresh-commit')
    const after = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(after.snapshot.entries.find((row: { key: string }) => row.key === KEY)).toMatchObject({ deleted: false, values: { name: '云端保留旧账户' } })
    expect(after.snapshot.entries.find((row: { key: string }) => row.key === '510300::刷新更名新账户')).toMatchObject({ deleted: true, local_pending: true })
    expect(server.posts).toBe(0)
  })
  it.each(['prepared', 'unknown', 'confirmed', 'conflict'] as const)('has no refresh UI and rejects the real facade refresh while %s is pending', async state => {
    const { server } = await linkedForPackets(state === 'unknown' ? 'unknown' : state === 'conflict' ? 'conflict' : 'success')
    const packets = await store.enableFullSyncPackets(true), request = await packets.previewPreparation('refresh-forbid-' + state)
    await packets.commitPreparation(request, true); if (state !== 'prepared') await packets.sendOnce()
    const { root } = await openPackets(), before = (await store.createPortfolioRecoveryBackup()).raw
    expect(all(root).some(row => row.props['data-action'] === 'full-refresh-pull')).toBe(false)
    await expect(packets.previewRefresh('refresh-not-permitted')).rejects.toBeInstanceOf(Error)
    expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before); expect(server.posts).toBe(state === 'prepared' ? 0 : 1)
  })
  it.each(['previewRefresh', 'commitRefresh'] as const)('counts the synchronous %s copy in the original12s before any locator read/write or cloud request', async operation => {
    const { server } = await linkedForRefresh(); advanceRefresh(server)
    await store.enableFullSync(true); const packets = await store.enableFullSyncPackets(true); await packets.pullComplete()
    const ready = await packets.previewRefresh('refresh-copy-budget-0001')
    const before = (await store.createPortfolioRecoveryBackup()).raw, read = vi.spyOn(IDBObjectStore.prototype, 'get'), put = vi.spyOn(IDBObjectStore.prototype, 'put'), requests = fetcher.mock.calls.length
    let clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const actual = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) { clock = 13_000; return actual.call(this, input) })
    await expect(operation === 'previewRefresh' ? packets.previewRefresh('refresh-copy-budget-0001', []) : packets.commitRefresh(ready.request!, true)).rejects.toBeInstanceOf(Error)
    expect(read).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(fetcher.mock.calls.length).toBe(requests); expect(server.posts).toBe(0)
    expect(store.fullSyncLocalPending).toBeNull(); vi.restoreAllMocks(); expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before)
  })
  it.each([NaN, Infinity, -1])('rejects a bad/backwards refresh copy clock %s before reading the authority or creating an uncertain operation', async invalidClock => {
    const { server } = await linkedForRefresh(); advanceRefresh(server)
    await store.enableFullSync(true); const packets = await store.enableFullSyncPackets(true); await packets.pullComplete()
    const ready = await packets.previewRefresh('refresh-bad-clock-0001'), before = (await store.createPortfolioRecoveryBackup()).raw
    const read = vi.spyOn(IDBObjectStore.prototype, 'get'), put = vi.spyOn(IDBObjectStore.prototype, 'put'), requests = fetcher.mock.calls.length
    let clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const actual = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) { clock = invalidClock; return actual.call(this, input) })
    await expect(packets.commitRefresh(ready.request!, true)).rejects.toBeInstanceOf(Error)
    expect(read).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(store.fullSyncLocalPending).toBeNull()
    expect(fetcher.mock.calls.length).toBe(requests); vi.restoreAllMocks(); expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before)
  })
  it('uses only the refresh deadline remainder after synchronous ownership instead of granting another12s', async () => {
    const { server } = await linkedForRefresh(); advanceRefresh(server)
    await store.enableFullSync(true); const packets = await store.enableFullSyncPackets(true); await packets.pullComplete()
    const ready = await packets.previewRefresh('refresh-remaining-clock-0001')
    let clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const actual = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, input?: string) { clock = 5000; return actual.call(this, input) })
    const timer = vi.spyOn(globalThis, 'setTimeout'); await packets.commitRefresh(ready.request!, true)
    expect(timer.mock.calls[0][1]).toBe(8000); expect(server.posts).toBe(0)
  })
  it('owns refresh resolutions and the sealed refresh request before the actual asynchronous locator preflight', async () => {
    const { server } = await linkedForRefresh()
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '云端现金', cls: '现金', value: 8, note: null }, updated_at: '2026-10-25T00:00:00Z' })
    const old = server.cloud.get('asset:synthetic-cash')!
    server.advance({ ...old, record_revision: 4, field_revisions: { ...old.field_revisions, value: 4 }, values: { ...old.values, value: 12 } })
    await store.enableFullSync(true); const packets = await store.enableFullSyncPackets(true); await packets.pullComplete()
    const first = await packets.previewRefresh('refresh-owned-0001'), choices = first.preview.conflicts.map(row => ({ key: row.key, field: row.field, choice: 'cloud' as 'local' | 'cloud' }))
    const actual = IDBObjectStore.prototype.get, observed: string[] = []
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) { observed.push(this.name); return actual.call(this, key) })
    const previewing = packets.previewRefresh('refresh-owned-0001', choices); expect(observed).toContain('authority'); choices.forEach(row => { row.choice = 'local' })
    const ready = await previewing; expect(ready.preview.conflicts.every(row => row.choice === 'cloud')).toBe(true)
    const request = structuredClone(ready.request!), committing = packets.commitRefresh(request, true)
    Object.assign(request, { id: 'refresh-mutated-after-await', resolutions: choices }); await committing; vi.restoreAllMocks()
    const current = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(current.fullSync.recentReceipt).toMatchObject({ operation: 'refresh', id: 'refresh-owned-0001', hash: ready.request!.hash })
    expect(store.portfolioState!.manual.find(row => row.key === 'asset:synthetic-cash')!.values.value).toBe(12); expect(server.posts).toBe(0)
  })
  it('rejects hidden/getter refresh inputs without invoking a getter or touching the real authority', async () => {
    const { server } = await linkedForRefresh(); advanceRefresh(server)
    await store.enableFullSync(true); const packets = await store.enableFullSyncPackets(true); await packets.pullComplete()
    const ready = await packets.previewRefresh('refresh-no-getter-0001'), getter = vi.fn(), read = vi.spyOn(IDBObjectStore.prototype, 'get'), put = vi.spyOn(IDBObjectStore.prototype, 'put')
    const input = Object.defineProperty({ ...ready.request }, 'resolutions', { enumerable: true, get: getter })
    expect(() => packets.commitRefresh(input as NonNullable<typeof ready.request>, true)).toThrow()
    expect(() => packets.previewRefresh('refresh-no-getter-0001', Object.defineProperty([], 'private', { get: getter }))).toThrow()
    expect(getter).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(server.posts).toBe(0)
  })
  it('retains the original refresh id/hash after actual strict commit response loss and resolves only fullSyncReceipt without replay', async () => {
    const { server, root } = await openRefreshPreview(), actual = IDBObjectStore.prototype.put
    let reached = false
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = actual.call(this, value, key)
      if (this.name === 'portfolio_sync_metadata' && key === 'current') this.transaction.addEventListener('complete', () => {
        reached = true; Reflect.apply(forceCloseDatabase, undefined, [this.transaction.db])
      })
      return request
    })
    await check(root, 'full-refresh-confirm'); await click(root, 'full-refresh-commit')
    expect(reached).toBe(true); vi.restoreAllMocks(); const original = store.fullSyncLocalPending; expect(original).not.toBeNull()
    expect(store.hasPendingLocalWorkspaceEdit).toBe(true); expect(all(root).some(row => row.props['data-action'] === 'full-refresh-commit')).toBe(false)
    const put = vi.spyOn(IDBObjectStore.prototype, 'put'); await click(root, 'full-packet-local-receipt'); expect(put).not.toHaveBeenCalled(); vi.restoreAllMocks()
    const current = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(store.fullSyncLocalPending).toBeNull(); expect(current.fullSync.recentReceipt).toMatchObject({ operation: 'refresh', id: original!.id, hash: original!.hash })
    expect(current.fullSync.base.pulledRevision).toBe(4); expect(server.posts).toBe(0); expect(server.receipts).toBe(0)
  })
  it('keeps the refresh tuple when logout occurs during Pinia publication, then only manually reconciles that original tuple', async () => {
    const { server, root } = await openRefreshPreview(), stop = observe(() => store.portfolioState, () => clearOwnerSession(), { flush: 'sync' })
    await check(root, 'full-refresh-confirm'); await click(root, 'full-refresh-commit'); stop()
    const original = store.fullSyncLocalPending; expect(original).not.toBeNull(); expect(output(root)).not.toContain('刷新云手工备注')
    await loginOwnerSession('synthetic-password'); await store.enableFullSync(true)
    await check(root, 'full-packet-consent'); await click(root, 'full-packet-enable'); await click(root, 'full-packet-local-receipt')
    expect(store.fullSyncLocalPending).toBeNull()
    const after = JSON.parse((await store.createPortfolioRecoveryBackup()).raw).local
    expect(after.fullSync.recentReceipt).toMatchObject({ operation: 'refresh', id: original!.id, hash: original!.hash }); expect(server.posts).toBe(0)
  })
  it('synchronously hides the complete private refresh preview on a real local writer and does not reuse the previous checkbox', async () => {
    const { server, root } = await openRefreshPreview(); await check(root, 'full-refresh-confirm')
    expect(output(root)).toContain('刷新云手工备注')
    await store.editPortfolio({ type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '新的本机修改', cls: '商品', value: 9, note: null }, updated_at: '2026-10-26T00:00:00Z' })
    await nextTick()
    expect(output(root)).not.toContain('刷新云手工备注'); expect(all(root).some(row => row.props['data-action'] === 'full-refresh-commit')).toBe(false)
    expect(store.fullSyncLocalPending).toBeNull(); expect(server.posts).toBe(0)
  })
  it('rejects a refresh prepared before a real competing handle writes, without overwriting its complete current state or publishing it as the old preview', async () => {
    const { server } = await linkedForRefresh(); advanceRefresh(server)
    await store.enableFullSync(true); const packets = await store.enableFullSyncPackets(true); await packets.pullComplete()
    const ready = await packets.previewRefresh('refresh-cross-tab-0001'), competing = await openOwnerWorkspace(indexedDB, await getOwnerSyncTargetFingerprint(), { existingOnly: true })
    const controller = new AbortController(), guard = { signal: controller.signal, assertActive() { if (controller.signal.aborted) throw new Error('synthetic competing guard cancelled') } }
    try {
      const expected = await competing.readLocalState(guard)
      await competing.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(competing.targetFingerprint, { id: 'refresh-competing-local-writer', expected,
        command: { type: 'save_manual', key: 'asset:synthetic-cash', values: { name: '另一标签较新完整状态', cls: '商品', value: 99, note: '' }, updated_at: '2026-10-26T00:00:00Z' } }), guard)
      const before = await competing.readFullSyncState(guard), put = vi.spyOn(IDBObjectStore.prototype, 'put')
      await expect(packets.commitRefresh(ready.request!, true)).rejects.toBeInstanceOf(Error)
      expect(put).not.toHaveBeenCalled(); expect(await competing.readFullSyncState(guard)).toEqual(before)
      expect(store.portfolioState!.manual.find(row => row.key === 'asset:synthetic-cash')!.values.value).toBe(2)
      expect(store.fullSyncLocalPending).toBeNull(); expect(server.posts).toBe(0)
    } finally { controller.abort(); competing.close() }
  })
  it.each(['logout', 'endpoint'] as const)('rejects a late complete D after %s and cannot publish a stale refresh preview or mutate the local base', async cause => {
    const { server } = await linkedForRefresh(); advanceRefresh(server); const { root } = await openPackets(), before = (await store.createPortfolioRecoveryBackup()).raw
    const actual = fetcher; let release!: () => void, started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      const response = await actual(input, init); if (String(input).includes('/sync?')) { started(); await gate }; return response
    }))
    const pending = event(find(root, 'data-action', 'full-refresh-pull'), 'onClick'); await waiting
    if (cause === 'logout') clearOwnerSession(); else vi.stubGlobal('location', { origin: 'https://other.synthetic.example' })
    release(); await pending
    expect(output(root)).not.toContain('刷新云手工备注'); expect(all(root).some(row => row.props['data-action'] === 'full-refresh-commit')).toBe(false)
    expect((await store.createPortfolioRecoveryBackup()).raw).toBe(before); expect(store.fullSyncLocalPending).toBeNull(); expect(server.posts).toBe(0)
  })
})
