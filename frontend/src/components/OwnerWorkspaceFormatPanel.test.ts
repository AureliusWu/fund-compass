import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from '@/stores/watchlist'
import { openOwnerAuthority } from '@/stores/owner-authority'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from '@/stores/ownerSyncOutbox'
import { OWNER_WORKSPACE_RECOVERY_MAX_BYTES, restoreOwnerWorkspaceRecoveryBackup } from '@/utils/owner-workspace-recovery'
import OwnerWorkspaceFormatPanel from './OwnerWorkspaceFormatPanel.vue'

// Actual compiled component, Pinia, authority locator and IDB operations; only
// native rendering/download and the test environment are adapted.
interface Node { tag: string; text: string; children: Node[]; parent: Node | null; props: Record<string, unknown> }
const node = (tag = 'root', text = ''): Node => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<Node, Node>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item) },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const all = (root: Node): Node[] => [root, ...root.children.flatMap(all)]
const output = (root: Node): string => (root.tag === '#comment' ? '' : root.text) + root.children.map(output).join(' ')
function find(root: Node, key: string, name: string) { const found = all(root).find(n => n.props[key] === name); expect(found, name).toBeDefined(); return found! }
async function event(item: Node, handler: string, value?: unknown) { await (item.props[handler] as (value: unknown) => unknown)(value); await nextTick() }
async function click(root: Node, name: string) { const item = find(root, 'data-action', name); expect(item.props.disabled).not.toBe(true); await event(item, 'onClick') }
async function select(root: Node, raw: string, hash?: string) {
  if (hash) await event(find(root, 'name', 'owner-format-sha'), 'onInput', { target: { value: hash } })
  await event(find(root, 'name', 'owner-format-file'), 'onChange', { target: { files: [new File([raw], 'synthetic.json')], value: 'file' } })
}
async function check(root: Node, recovery = false) { await event(find(root, 'name', recovery ? 'owner-format-reconcile-confirm' : 'owner-format-confirm'), 'onChange', { target: { checked: true } }) }
const apps: Array<() => void> = [], stores: ReturnType<typeof useWatchlistStore>[] = [], blobs: Blob[] = []
let factory: IDBFactory, store: ReturnType<typeof useWatchlistStore>, data: Map<string, string>
const forbidden = vi.fn(() => { throw new Error('cloud IO forbidden') })
async function fresh(allowBlocked = false) {
  setActivePinia(createPinia()); const next = useWatchlistStore(); stores.push(next)
  if (allowBlocked) { try { await next.initialize() } catch { /* An incomplete upgrade must remain blocked. */ } }
  else await next.initialize()
  return next
}
async function mount() {
  const root = node(), app = renderer.createApp(OwnerWorkspaceFormatPanel); app.mount(root)
  const unmount = () => app.unmount(); apps.push(unmount); await nextTick(); return { root, unmount }
}
beforeEach(async () => {
  factory = new IDBFactory(); data = new Map([['sinan_watchlist_v2', JSON.stringify([{ code: '510300', name: '合成零份', account: '银行',
    position_kind: 'holding', shares: 0, cost: null, target_weight: 0, updated_at: '2026-10-22T00:00:00Z' }])]])
  vi.stubGlobal('indexedDB', factory); vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('location', { origin: 'https://synthetic.example' })
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() {}, remove() {} }) })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blobs.push(value as Blob); return 'blob:synthetic-format' }); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  forbidden.mockClear(); blobs.length = 0; vi.stubGlobal('fetch', forbidden)
  store = await fresh(); const backup = await store.createLocalWorkspaceBackup(); await store.activateLocalWorkspace(backup.raw, backup.sha256)
})
afterEach(() => { apps.splice(0).forEach(fn => fn()); stores.splice(0).forEach(s => s.$dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('explicit local format upgrade and recovery UI', () => {
  it('mounts without export, upgrade, network or automatic recovery', async () => {
    const backup = vi.spyOn(store, 'createSyncRecoveryBackup'), upgrade = vi.spyOn(store, 'upgradeLocalSyncFormat'), recover = vi.spyOn(store, 'reconcileLocalSyncUpgrade')
    const { root } = await mount()
    expect(output(root)).toContain('v3 · 仅本机编辑'); expect(output(root)).toContain('代码回退不能恢复旧格式')
    expect(backup).not.toHaveBeenCalled(); expect(upgrade).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled()
  })
  it('downloads/selects full bytes then explicitly upgrades the actual adopted target without upload or old LS mutation', async () => {
    const originalLS = data.get('sinan_watchlist_v2'), { root } = await mount()
    await click(root, 'export-format')
    const raw = await blobs[0].text(), hash = find(root, 'name', 'owner-format-sha').props.value as string
    const envelope = await restoreOwnerWorkspaceRecoveryBackup(raw, hash)
    expect(envelope.physicalVersion).toBe(3)
    await select(root, raw)
    expect(output(root)).toContain('银行'); expect(output(root)).toContain('份额 0'); expect(output(root)).toContain('未知（null）')
    expect(find(root, 'data-action', 'upgrade-format').props.disabled).toBe(true)
    await check(root); await click(root, 'upgrade-format')
    expect(store.localSyncFormat).toBe('v4'); expect(store.authorityState).toBe('idb'); expect(store.hasLocalChanges()).toBe(true)
    expect(data.get('sinan_watchlist_v2')).toBe(originalLS); expect(forbidden).not.toHaveBeenCalled()
    expect(output(root)).toContain('本机同步格式已升级')
    store.$dispose(); store = await fresh(); expect(store.localSyncFormat).toBe('v4')
  })
  it('requires this-round exported bytes for upgrade; an external valid file is not enough', async () => {
    const backup = await store.createSyncRecoveryBackup(), { root } = await mount()
    await select(root, backup.raw, backup.sha256); await check(root)
    expect(find(root, 'data-action', 'upgrade-format').props.disabled).toBe(true)
    await event(find(root, 'data-action', 'upgrade-format'), 'onClick')
    expect(store.localSyncFormat).toBe('v3')
  })
  it.each([0, OWNER_WORKSPACE_RECOVERY_MAX_BYTES + 1])('rejects size %s before reading the file', async size => {
    const { root } = await mount(), stream = vi.fn()
    await event(find(root, 'name', 'owner-format-file'), 'onChange', { target: { files: [{ size, stream }], value: '' } })
    expect(stream).not.toHaveBeenCalled(); expect(output(root)).toContain('文件为空或超过')
  })
  it('refuses ordinary row backup, changed bytes and BOM instead of enabling upgrade', async () => {
    const ordinary = await store.createLocalWorkspaceBackup(), { root } = await mount()
    await select(root, ordinary.raw, ordinary.sha256)
    expect(output(root)).toContain('完整备份核对失败')
    await click(root, 'export-format'); const raw = await blobs[0].text()
    await select(root, raw + ' '); expect(output(root)).toContain('完整备份核对失败')
    await select(root, '\ufeff' + raw); expect(output(root)).toContain('完整备份核对失败')
    expect(store.localSyncFormat).toBe('v3')
  })
  it('rejects a once-valid upgrade preview after an actual local edit; it does not restore old shares', async () => {
    const { root } = await mount(); await click(root, 'export-format'); await select(root, await blobs[0].text()); await check(root)
    await store.setHolding('510300', 7, null, '合成零份', '银行', 0)
    await click(root, 'upgrade-format')
    expect(store.recordsFor('510300')[0].shares).toBe(7); expect(store.localSyncFormat).toBe('v3')
    expect(output(root)).toContain('升级未完成或结果待核对')
  })
  it('manually completes an interrupted upgrade from the selected original full file after a real store reload', async () => {
    const backup = await store.createSyncRecoveryBackup(), locator = await openOwnerAuthority(factory, localStorage), pointer = await locator.read(); locator.close()
    store.$dispose()
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + pointer.targetFingerprint, 4)
      request.onupgradeneeded = () => request.result.createObjectStore('sync_metadata')
      request.onsuccess = () => { request.result.close(); resolve() }; request.onerror = () => reject(request.error)
    })
    store = await fresh(true); expect(store.authorityState).toBe('blocked')
    const { root } = await mount(); await select(root, backup.raw, backup.sha256)
    expect(find(root, 'data-action', 'reconcile-format').props.disabled).toBe(true)
    await check(root, true); await click(root, 'reconcile-format')
    expect(store.authorityState).toBe('idb'); expect(store.localSyncFormat).toBe('v4')
    expect(store.recordsFor('510300')[0]).toMatchObject({ shares: 0, cost: null, target_weight: 0 })
    expect(output(root)).toContain('业务记录没有重新导入'); expect(forbidden).not.toHaveBeenCalled()
  })
  it('cancels late file reading on unmount, without exposing private preview after reopening', async () => {
    const { root, unmount } = await mount(); await click(root, 'export-format')
    let finish!: (value: { done: boolean }) => void
    const cancel = vi.fn(async () => {}), releaseLock = vi.fn(), reader = { read: () => new Promise<{ done: boolean }>(resolve => { finish = resolve }), cancel, releaseLock }
    const pending = event(find(root, 'name', 'owner-format-file'), 'onChange', { target: { files: [{ size: 1, stream: () => ({ getReader: () => reader }) }], value: '' } })
    await nextTick(); unmount(); apps.splice(apps.indexOf(unmount), 1); finish({ done: true }); await pending
    const reopened = await mount()
    expect(output(reopened.root)).not.toContain('完整备份校验通过'); expect(cancel).toHaveBeenCalled(); expect(releaseLock).toHaveBeenCalled()
  })
})
