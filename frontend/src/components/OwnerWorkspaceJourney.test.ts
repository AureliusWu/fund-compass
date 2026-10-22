import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'
import { useWatchlistStore } from '@/stores/watchlist'
import { OWNER_SYNC_OUTBOX_DB_PREFIX } from '@/stores/ownerSyncOutbox'
import OwnerWorkspacePanel from './OwnerWorkspacePanel.vue'
import HoldingEditor from './HoldingEditor.vue'

vi.mock('@/stores/ownerSession', async original => ({
  ...await original<typeof import('@/stores/ownerSession')>(),
  getOwnerSyncTargetFingerprint: async () => 'a'.repeat(64),
}))
vi.mock('vant', () => ({ showConfirmDialog: vi.fn(async () => {}), showToast: vi.fn() }))

// Real compiled SFC handlers, Pinia store, codec, locator and IDB transactions.
// Host rendering/download, the local endpoint fingerprint, and Vant confirmation
// are adapted. No business writer, codec, locator or transaction is mocked.
interface TestNode {
  tag: string; text: string; children: TestNode[]; parent: TestNode | null; props: Record<string, unknown>
}
const node = (tag = 'root', text = ''): TestNode => ({ tag, text, children: [], parent: null, props: {} })
const renderer = createRenderer<TestNode, TestNode>({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
  patchProp: (item, key, _old, value) => { item.props[key] = value },
  insert(item, parent, anchor = null) {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
    item.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item)
  },
  remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
})
const all = (item: TestNode): TestNode[] => [item, ...item.children.flatMap(all)]
const output = (item: TestNode): string => (item.tag === '#comment' ? '' : item.text) + item.children.map(output).join(' ')
function find(root: TestNode, key: string, value: unknown) {
  const found = all(root).find(item => item.props[key] === value)
  expect(found, `${key}=${value}`).toBeDefined()
  return found!
}
async function event(item: TestNode, name: string, value: unknown = { preventDefault() {}, stopPropagation() {} }) {
  const handler = item.props[name] as (event: unknown) => unknown
  expect(handler).toBeTypeOf('function')
  await handler(value); await nextTick()
}
async function click(root: TestNode, action: string) {
  const item = find(root, 'data-action', action)
  expect(item.props.disabled).not.toBe(true)
  await event(item, 'onClick')
}
async function select(root: TestNode, raw: string, hash: string) {
  await event(find(root, 'name', 'owner-workspace-sha256'), 'onInput', { target: { value: hash } })
  await event(find(root, 'name', 'owner-workspace-file'), 'onChange', {
    target: { value: 'synthetic.json', files: [new File([raw], 'synthetic.json', { type: 'application/json' })] },
  })
}
async function confirm(root: TestNode) {
  await event(find(root, 'name', 'owner-workspace-confirm'), 'onChange', { target: { checked: true } })
}
async function sha(raw: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))]
    .map(value => value.toString(16).padStart(2, '0')).join('')
}
const storage = new Map<string, string>(), downloads: Blob[] = []
const apps: Array<() => void> = [], stores: ReturnType<typeof useWatchlistStore>[] = []
let factory: IDBFactory, store: ReturnType<typeof useWatchlistStore>
const raw = JSON.stringify([
  { code: '000001', name: '合成持仓', id: '000001::银行', account: '银行', position_kind: 'holding', shares: 7, cost: null, target_weight: 0, local_pending: true, updated_at: '2026-10-01T00:00:00Z' },
  { code: '000002', name: '合成关注', id: '000002::旧账户', account: '旧账户', position_kind: 'watch', shares: null, cost: null, target_weight: null, updated_at: '2026-09-30T00:00:00Z' },
  { code: '000003', name: '合成已删', id: '000003::', account: '', position_kind: 'holding', shares: 0, cost: 0, target_weight: null, deleted: true, local_pending: true, updated_at: '2026-09-29T00:00:00Z' },
])
async function freshStore() {
  setActivePinia(createPinia()); const result = useWatchlistStore(); stores.push(result)
  await result.initialize(); return result
}
function dispose() {
  apps.splice(0).forEach(unmount => unmount())
  stores.splice(0).forEach(value => value.$dispose())
}
async function mount(component: typeof OwnerWorkspacePanel | typeof HoldingEditor = OwnerWorkspacePanel) {
  const root = node(), app = renderer.createApp(component, component === HoldingEditor ? { code: '000001', name: '合成持仓' } : {})
  app.component('VanPopup', defineComponent({ setup: (_props, { slots }) => () => h('popup', slots.default?.()) }))
  app.component('VanButton', defineComponent({ setup: (_props, { attrs, slots }) => () => h('button', attrs, slots.default?.()) }))
  app.component('VanField', defineComponent({ props: ['name', 'modelValue', 'disabled'], emits: ['update:modelValue'],
    setup: (props, { emit }) => () => h('field', { name: props.name, disabled: props.disabled,
      onInput: (value: string) => emit('update:modelValue', value) }) }))
  app.component('VanRadioGroup', defineComponent({ setup: (_props, { slots }) => () => h('mode', slots.default?.()) }))
  app.component('VanRadio', defineComponent({ setup: (_props, { slots }) => () => h('radio', slots.default?.()) }))
  app.mount(root); apps.push(() => app.unmount()); await nextTick(); return root
}
async function activateViaPanel() {
  const activation = vi.spyOn(store, 'activateLocalWorkspace')
  const root = await mount(); await click(root, 'open'); await click(root, 'export')
  const exported = await downloads.at(-1)!.text(), hash = await sha(exported)
  await select(root, exported, hash); await confirm(root); await click(root, 'activate')
  expect(activation.mock.settledResults).toEqual([{ type: 'fulfilled', value: undefined }])
  expect(store.authorityState).toBe('idb')
  return { root, exported, hash }
}
beforeEach(async () => {
  storage.clear(); downloads.length = 0; factory = new IDBFactory()
  storage.set('sinan_watchlist_v2', raw)
  storage.set('sinan_watchlist_v1', ' [ ] \n')
  storage.set('sinan_gist_token', 'synthetic-credential-canary-not-in-backup')
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) }, removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('indexedDB', factory)
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No network allowed in local journey') }))
  vi.stubGlobal('document', Object.assign(new EventTarget(), {
    body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() {}, remove() {} }),
  }))
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { downloads.push(blob as Blob); return 'blob:synthetic-local' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  store = await freshStore()
})
afterEach(() => { dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('independent real local workspace journey', () => {
  it('exports, reselects, activates, edits true zero through the real form and reloads IDB without reviving LS', async () => {
    const { exported } = await activateViaPanel()
    expect(exported).not.toContain('synthetic-credential-canary')
    expect(storage.get('sinan_watchlist_v2')).toBe(raw)
    const editor = await mount(HoldingEditor)
    await event(find(editor, 'name', 'shares'), 'onInput', '0')
    await event(find(editor, 'name', 'cost'), 'onInput', '0')
    await event(find(editor, 'name', 'target'), 'onInput', '')
    await event(all(editor).find(item => item.tag === 'form')!, 'onSubmit')
    expect(store.recordsFor('000001')[0]).toMatchObject({ shares: 0, cost: 0, target_weight: null, local_pending: true })
    expect(storage.get('sinan_watchlist_v2')).toBe(raw)
    expect(store.entries.find(item => item.code === '000003')?.deleted).toBe(true)
    dispose()
    // The preserved old source is now different; it must not regain authority.
    storage.set('sinan_watchlist_v2', raw.replace('"shares":7', '"shares":999'))
    store = await freshStore()
    expect(store.authorityState).toBe('idb')
    expect(store.recordsFor('000001')[0]).toMatchObject({ shares: 0, cost: 0, target_weight: null, local_pending: true })
    expect(fetch).not.toHaveBeenCalled()
  }, 15000)

  it('shows real tombstone conflicts and rejects a direct restore attempt, not only a disabled button', async () => {
    const { root, exported, hash } = await activateViaPanel()
    await store.remove('000002', '旧账户', { confirmed: true })
    await select(root, exported, hash); await click(root, 'preview-restore')
    expect(output(root)).toContain('冲突')
    await confirm(root)
    expect(find(root, 'data-action', 'restore').props.disabled).toBe(true)
    const before = JSON.stringify(store.entries)
    await expect(store.restoreLocalWorkspaceBackup(exported, hash)).rejects.toBeDefined()
    expect(JSON.stringify(store.entries)).toBe(before)
    expect(store.entries.find(item => item.code === '000002')?.deleted).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  }, 15000)

  it('does not recreate a missing active workspace or fall back to the archived LS after restart', async () => {
    await activateViaPanel(); dispose()
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(OWNER_SYNC_OUTBOX_DB_PREFIX + 'a'.repeat(64))
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error)
    })
    setActivePinia(createPinia()); store = useWatchlistStore(); stores.push(store)
    await expect(store.initialize()).rejects.toMatchObject({ code: 'workspace_invalid_database' })
    expect(store.authorityState).toBe('blocked')
    expect(store.entries).toEqual([])
    expect((await factory.databases()).some(item => item.name === OWNER_SYNC_OUTBOX_DB_PREFIX + 'a'.repeat(64))).toBe(false)
    expect(storage.get('sinan_watchlist_v2')).toBe(raw)
  }, 15000)

  it('restores a real downloaded backup into a fresh local workspace while preserving zero, null, times and raw archives', async () => {
    const original = await activateViaPanel()
    await store.setHolding('000001', 0, 0, '合成持仓', '银行', null)
    await click(original.root, 'export')
    const downloaded = await downloads.at(-1)!.text()
    const backup = { raw: downloaded, sha256: await sha(downloaded) }
    const expected = JSON.parse(JSON.stringify(store.entries))
    dispose()
    // Independent synthetic device: neither its IDB nor LS contains the source.
    factory = new IDBFactory(); storage.clear(); vi.stubGlobal('indexedDB', factory)
    store = await freshStore()
    const { root } = await activateViaPanel()
    expect(store.entries).toEqual([])
    await select(root, backup.raw, backup.sha256); await click(root, 'preview-restore'); await confirm(root)
    await click(root, 'restore')
    expect(store.entries).toEqual(expected)
    expect(store.localPending).toBe(true)
    const restored = await store.createLocalWorkspaceBackup()
    expect(restored.envelope.restoredArchives.some(archive => archive.v2Raw === raw)).toBe(true)
    const same = JSON.stringify(store.entries)
    await store.previewLocalWorkspaceRestore(backup.raw, backup.sha256)
    await store.restoreLocalWorkspaceBackup(backup.raw, backup.sha256)
    expect(JSON.stringify(store.entries)).toBe(same)
    expect(fetch).not.toHaveBeenCalled()
  }, 15000)
})
