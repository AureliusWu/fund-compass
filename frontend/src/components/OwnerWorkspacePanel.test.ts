import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from '@/stores/watchlist'
import { OWNER_WORKSPACE_BACKUP_MAX_BYTES } from '@/utils/owner-workspace-backup'
import OwnerWorkspacePanel from './OwnerWorkspacePanel.vue'

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
const all = (item: Node): Node[] => [item, ...item.children.flatMap(all)]
const output = (item: Node): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(output).join(' ')
function action(root: Node, name: string) { const item = all(root).find(item => item.props['data-action'] === name); expect(item, name).toBeDefined(); return item! }
function input(root: Node, name: string) { const item = all(root).find(item => item.props.name === name); expect(item, name).toBeDefined(); return item! }
function fire(root: Node, name: string): Promise<unknown> { return Promise.resolve((action(root, name).props.onClick as () => unknown)()) }
async function press(root: Node, name: string) { expect(action(root, name).props.disabled).not.toBe(true); await fire(root, name); await nextTick() }
async function choose(root: Node, file: File | { size: number; stream: () => unknown }) {
  await (input(root, 'owner-workspace-file').props.onChange as (event: unknown) => Promise<void>)({ target: { files: [file], value: 'selected' } }); await nextTick()
}
async function check(root: Node) { (input(root, 'owner-workspace-confirm').props.onChange as (event: unknown) => void)({ target: { checked: true } }); await nextTick() }
let store: ReturnType<typeof useWatchlistStore>
const apps: Array<() => void> = [], blobs: Blob[] = [], names: string[] = []
async function mount() { const root = node(), app = renderer.createApp(OwnerWorkspacePanel); app.mount(root); apps.push(() => app.unmount()); await nextTick(); return root }
beforeEach(async () => {
  const data = new Map([['sinan_watchlist_v2', JSON.stringify([
    { code: '000001', id: '000001::银行', name: '真实零份', account: '银行', position_kind: 'holding', shares: 0, cost: 0, target_weight: null, local_pending: true, updated_at: '2026-10-01T00:00:00Z' },
    { code: '000002', id: '000002::', name: '仅关注', position_kind: 'watch', shares: null, cost: null, target_weight: null, updated_at: '2026-10-01T00:00:00Z' },
  ])]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('document', { body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() { names.push(this.download) }, remove() {} }) })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blobs.push(value as Blob); return 'blob:local-workspace' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  blobs.length = 0; names.length = 0
  setActivePinia(createPinia()); store = useWatchlistStore(); await store.initialize()
})
afterEach(() => { apps.splice(0).forEach(unmount => unmount()); store.$dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real local workspace panel handlers', () => {
  it('does not export or open a candidate workspace when mounted or expanded', async () => {
    const backup = vi.spyOn(store, 'createLocalWorkspaceBackup'), activate = vi.spyOn(store, 'activateLocalWorkspace')
    const root = await mount(); await press(root, 'open')
    expect(backup).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled(); expect(blobs).toHaveLength(0)
    expect(output(root)).toContain('不需要登录私人会话'); expect(output(root)).toContain('不是整个应用的数据备份')
  })

  it('downloads deterministic private backup name, checks full bytes and previews true zero/null before explicit activation', async () => {
    const root = await mount(); await press(root, 'open'); await press(root, 'export')
    expect(names[0]).toMatch(/^司南基金_本机工作区_[0-9a-f]{16}\.json$/)
    const raw = await blobs[0].text(), hash = input(root, 'owner-workspace-sha256').props.value as string
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    await choose(root, new File([raw], 'backup.json', { type: 'application/json' }))
    expect(output(root)).toContain('银行'); expect(output(root)).toContain('未知（null）'); expect(output(root)).toContain('真实零份')
    expect(action(root, 'activate').props.disabled).toBe(true)
    await check(root); expect(action(root, 'activate').props.disabled).toBe(false)
    expect(store.authorityState).toBe('legacy')
  })

  it.each([0, OWNER_WORKSPACE_BACKUP_MAX_BYTES + 1])('rejects file size %s before opening a stream', async size => {
    const root = await mount(); await press(root, 'open')
    const stream = vi.fn(); await choose(root, { size, stream })
    expect(stream).not.toHaveBeenCalled(); expect(output(root)).toContain('文件为空或超过')
    expect(store.authorityState).toBe('legacy')
  })

  it('does not treat an altered file as the downloaded current backup', async () => {
    const root = await mount(); await press(root, 'open'); await press(root, 'export')
    await choose(root, new File([(await blobs[0].text()) + ' '], 'changed.json'))
    expect(output(root)).toContain('文件与完整 SHA256 摘要不符'); expect(all(root).some(item => item.props['data-action'] === 'activate')).toBe(false)
    expect(store.authorityState).toBe('legacy')
  })

  it('does not strip a BOM and accidentally authenticate different file bytes', async () => {
    const root = await mount(); await press(root, 'open'); await press(root, 'export')
    const bytes = new TextEncoder().encode(await blobs[0].text())
    await choose(root, new File([new Uint8Array([0xef, 0xbb, 0xbf]), bytes], 'with-bom.json'))
    expect(output(root)).toContain('文件与完整 SHA256 摘要不符')
    expect(all(root).some(item => item.props['data-action'] === 'activate')).toBe(false)
  })

  it('does not refill a file verification that resolves after close and reopen', async () => {
    const root = await mount(); await press(root, 'open'); await press(root, 'export')
    let finish!: (value: { done: boolean }) => void
    const cancel = vi.fn(async () => {}), releaseLock = vi.fn()
    const reader = { read: () => new Promise<{ done: boolean }>(resolve => { finish = resolve }), cancel, releaseLock }
    const pending = choose(root, { size: 1, stream: () => ({ getReader: () => reader }) })
    await nextTick(); await press(root, 'open'); await press(root, 'open')
    finish({ done: true }); await pending
    expect(cancel).toHaveBeenCalled(); expect(releaseLock).toHaveBeenCalled()
    expect(output(root)).not.toContain('备份字节与完整摘要一致')
    expect(all(root).some(item => item.props['data-action'] === 'activate')).toBe(false)
  })

  it('suppresses a delayed activation success after closing and reopening the panel', async () => {
    let resolve!: () => void
    vi.spyOn(store, 'activateLocalWorkspace').mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const root = await mount(); await press(root, 'open'); await press(root, 'export')
    await choose(root, new File([await blobs[0].text()], 'backup.json')); await check(root)
    const pending = fire(root, 'activate'); await nextTick()
    expect(output(root)).not.toContain('已启用本机工作区。')
    await press(root, 'open'); await press(root, 'open')
    store.authorityState = 'idb'; resolve(); await pending; await nextTick()
    expect(output(root)).not.toContain('已启用本机工作区。')
  })

  it('suppresses a delayed reconciliation success after closing and reopening', async () => {
    let resolve!: () => void
    vi.spyOn(store, 'hasPendingLocalWorkspaceEdit', 'get').mockReturnValue(true)
    vi.spyOn(store, 'reconcileLocalWorkspaceEdit').mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    store.authorityState = 'blocked'
    const root = await mount(); await press(root, 'open')
    const pending = fire(root, 'reconcile-local'); await nextTick()
    await press(root, 'open'); await press(root, 'open'); resolve(); await pending; await nextTick()
    expect(output(root)).not.toContain('已完成本轮保留写入的本机核对')
  })

  it('does not offer reconciliation without a retained original local request in this session', async () => {
    store.authorityState = 'blocked'
    const reconcile = vi.spyOn(store, 'reconcileLocalWorkspaceEdit'), root = await mount(); await press(root, 'open')
    expect(action(root, 'reconcile-local').props.disabled).toBe(true)
    await fire(root, 'reconcile-local')
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('cancels an incomplete read on a byte-length mismatch and never produces a preview', async () => {
    const root = await mount(); await press(root, 'open'); await press(root, 'export')
    const raw = await blobs[0].text(), bytes = new TextEncoder().encode(raw)
    let read = false
    const cancel = vi.fn(async () => {}), releaseLock = vi.fn()
    const reader = { read: async () => { if (!read) { read = true; return { done: false, value: bytes } }; return { done: true } }, cancel, releaseLock }
    await choose(root, { size: bytes.byteLength + 1, stream: () => ({ getReader: () => reader }) })
    expect(cancel).toHaveBeenCalled(); expect(releaseLock).toHaveBeenCalled()
    expect(output(root)).toContain('文件核对未通过')
  })

  it.each(['missing_name', 'ambiguous_kind', 'invalid_legacy'])('explains actionable legacy backup rejection %s without dropping or guessing records', async code => {
    vi.spyOn(store, 'createLocalWorkspaceBackup').mockRejectedValueOnce({ code })
    const root = await mount(); await press(root, 'open'); await press(root, 'export')
    expect(output(root)).toContain('请先核对原始记录')
    expect(blobs).toHaveLength(0); expect(store.entries).toHaveLength(2)
  })

  it('only exposes an explicit receipt check in activating mode, never a normal import; absent adoption stays paused', async () => {
    const backup = await store.createLocalWorkspaceBackup(), root = await mount()
    store.authorityState = 'activating'; await nextTick(); await press(root, 'open')
    ;(input(root, 'owner-workspace-sha256').props.onInput as (event: unknown) => void)({ target: { value: backup.sha256 } }); await nextTick()
    await choose(root, new File([backup.raw], 'original.json'))
    expect(all(root).some(item => ['activate', 'restore'].includes(item.props['data-action'] as string))).toBe(false)
    expect(action(root, 'reconcile-activation').props.disabled).toBe(true)
    ;(input(root, 'owner-workspace-reconcile-confirm').props.onChange as (event: unknown) => void)({ target: { checked: true } }); await nextTick()
    await press(root, 'reconcile-activation')
    expect(output(root)).toContain('缺少匹配回执时不会重新导入')
    expect(store.authorityState).toBe('activating'); expect(store.entries).toHaveLength(2)
  })

  it('suppresses a delayed activating receipt-check success after closing and reopening', async () => {
    const backup = await store.createLocalWorkspaceBackup()
    let resolve!: () => void
    vi.spyOn(store, 'activateLocalWorkspace').mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
    const root = await mount(); store.authorityState = 'activating'; await nextTick(); await press(root, 'open')
    ;(input(root, 'owner-workspace-sha256').props.onInput as (event: unknown) => void)({ target: { value: backup.sha256 } }); await nextTick()
    await choose(root, new File([backup.raw], 'original.json'))
    ;(input(root, 'owner-workspace-reconcile-confirm').props.onChange as (event: unknown) => void)({ target: { checked: true } }); await nextTick()
    const pending = fire(root, 'reconcile-activation'); await nextTick()
    await press(root, 'open'); await press(root, 'open'); store.authorityState = 'idb'; resolve(); await pending; await nextTick()
    expect(output(root)).not.toContain('已核对保存的权威切换结果。')
  })
})
