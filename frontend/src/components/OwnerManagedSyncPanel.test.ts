/** Real SFC handlers against an injected store-owned facade boundary. These
 * tests prove UI consent/privacy/sequence, not IDB/HTTP contracts; the separate
 * managed store integration journey runs the real facade/workspace/transport.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, nextTick, reactive } from 'vue'
import type { OwnerWorkspaceSyncFacade } from '@/stores/watchlist'
import type { OwnerWorkspaceSyncState } from '@/stores/owner-workspace-types'
import type { BuiltOwnerSyncRequest, OwnerSyncRecord } from '@/utils/ownerSyncContract'
import type { OwnerWorkspaceAckPreview } from '@/utils/owner-workspace-ack'
import OwnerManagedSyncPanel from './OwnerManagedSyncPanel.vue'

const mocks = vi.hoisted(() => ({ store: null as unknown, setSession: (_scopes: readonly string[] | null) => {}, active: true }))
vi.mock('@/stores/watchlist', () => ({ useWatchlistStore: () => mocks.store }))
vi.mock('@/stores/ownerSession', async () => {
  const { shallowRef } = await import('vue'), session = shallowRef<unknown>(null), generation = shallowRef(0)
  mocks.setSession = scopes => {
    session.value = scopes ? { token_type: 'Bearer', owner_id: 'owner', expires_at: '2099-01-01T00:00:00Z', scopes: [...scopes] } : null
    mocks.active = !!scopes; generation.value++
  }
  return { ownerSession: session, ownerSessionGeneration: generation, hasOwnerSession: () => mocks.active }
})

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
function button(root: Node, label: string): Node {
  const result = all(root).find(item => item.tag === 'button' && output(item).trim() === label)
  expect(result, label).toBeDefined(); return result!
}
async function click(root: Node, label: string): Promise<void> {
  const item = button(root, label); expect(item.props.disabled, label).not.toBe(true)
  await (item.props.onClick as () => unknown)(); await nextTick()
}
async function check(root: Node, name: string, value = true): Promise<void> {
  const item = all(root).find(item => item.tag === 'input' && item.props.name === name)
  expect(item, name).toBeDefined(); expect(item!.props.disabled, name).not.toBe(true)
  ;(item!.props.onChange as (event: unknown) => void)({ target: { checked: value } }); await nextTick()
}
async function choose(root: Node, value: 'local' | 'cloud'): Promise<void> {
  const input = all(root).find(item => item.tag === 'input' && item.props.type === 'radio' && item.props.value === value)
  expect(input).toBeDefined(); expect(input!.props.disabled).not.toBe(true)
  ;(input!.props.onChange as () => void)(); await nextTick()
}
const TARGET = 'c'.repeat(64), KEY = '000001::合成账户', DELETED = '000002::旧账户', CLOUD_ONLY = '000003::云账户'
const ORIGINAL_ID = 'synthetic-managed-original-0001', HASH = 'a'.repeat(64), PREP_HASH = 'b'.repeat(64), PRIVATE = '合成私人基金'
const closes: Array<() => void> = [], blobs: Blob[] = []
function record(key = KEY, shares: number | null = 0, deleted = false): OwnerSyncRecord {
  return { key, kind: 'holding', deleted, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: PRIVATE, shares, cost: null, target_weight: 0 } }
}
function manual(): OwnerSyncRecord {
  return { ...record('asset:synthetic'), kind: 'manual_asset', deleted: true,
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: '保留的手工现金', cls: '现金', value: 0, note: null } }
}
function entry(row = record()) { return { key: row.key, kind: row.kind as 'holding' | 'watch', deleted: row.deleted,
  values: { name: row.values.name as string, shares: row.values.shares as number | null,
    cost: row.values.cost as number | null, target_weight: row.values.target_weight as number | null }, local_pending: true } }
const packet: BuiltOwnerSyncRequest = (() => {
  const request: BuiltOwnerSyncRequest['request'] = { request_id: ORIGINAL_ID, expected_revision: 1, operations: [
    { key: KEY, kind: 'holding' as const, deleted: false, changes: { shares: 0, cost: null, target_weight: 0 },
      base_values: { kind: 'holding', deleted: false, shares: 10, cost: 2, target_weight: null } },
    { key: DELETED, kind: 'holding' as const, deleted: true, base_values: { kind: 'holding', deleted: false,
      name: '本机已删除', shares: 0, cost: 0, target_weight: null } },
  ] }, rawBody = JSON.stringify(request)
  return { request, rawBody, requestHash: HASH, byteLength: new TextEncoder().encode(rawBody).byteLength }
})()
type Status = ReturnType<OwnerWorkspaceSyncFacade['status']>
function fixture(options: { linked?: boolean; initial?: 'prepared' | 'unknown' | 'confirmed' | 'conflict'; localUnknown?: boolean } = {}) {
  let enabled = false, uncertain: Status['uncertainLocal'] = options.localUnknown ? { operation: 'prepare', id: ORIGINAL_ID, hash: PREP_HASH } : null
  const localEntries = [entry(), entry(record(DELETED, 0, true))], baseline = { pulledRevision: 1, records: [record(KEY, 10), record(DELETED), manual()] }
  let image = { local: { snapshot: { localVersion: 7, legacy: null, entries: localEntries },
    metadata: { displayTimes: [], adoption: { id: 'synthetic-adoption-0001', hash: 'd'.repeat(64) } },
    receiptCount: 0, outbox: { version: 3, entry: null } },
  sync: { schema: 'owner-workspace-sync-1', targetFingerprint: TARGET, epoch: 1,
    base: options.linked ? baseline : null, pending: null, recentReceipt: null } } as unknown as OwnerWorkspaceSyncState
  let status: Status = { state: 'idle', busy: false, completeReady: false, resultReady: false, uncertainLocal: null }
  function persist(state: NonNullable<OwnerWorkspaceSyncState['local']['outbox']['entry']>['state']) {
    const pending = { requestId: ORIGINAL_ID, requestHash: HASH, rawBody: packet.rawBody, preparationHash: PREP_HASH,
      preimageHash: 'd'.repeat(64), adoptionId: 'synthetic-adoption-0001', adoptionHash: 'd'.repeat(64),
      localVersion: 7, preparedOutboxVersion: 4, baseRevision: 1 }
    const sync = { ...image.sync, base: baseline, pending }
    image = { sync, local: { ...image.local, sync, outbox: { version: image.local.outbox.version + 1,
      entry: { schema: 'owner-sync-outbox-1', state, rawBody: packet.rawBody, requestHash: HASH } } } }
    status = { ...status, state: state === 'attempted' ? 'unknown' : state, resultReady: state === 'confirmed' || state === 'conflict' }
  }
  if (options.initial || options.localUnknown) persist(options.initial ?? 'prepared')
  const baseD = { pulledRevision: 2, records: [record(KEY, 12), record(DELETED, 0, true), manual()] }
  const facade = {
    status: vi.fn((): Status => enabled ? { ...status, state: uncertain ? 'local_unknown' : status.state, uncertainLocal: uncertain }
      : { ...status, state: 'disabled', uncertainLocal: null, resultReady: false, completeReady: false }),
    getState: vi.fn(() => enabled && !uncertain ? image : null),
    hydrate: vi.fn(async () => image),
    pullComplete: vi.fn(async () => { status = { ...status, completeReady: true }; return baseD }),
    previewLink: vi.fn(async (id: string) => {
      const base = { pulledRevision: 1, records: [record(), record(DELETED, 0, true), record(CLOUD_ONLY, null), manual()] },
        snapshot = { ...image.local.snapshot, entries: [...image.local.snapshot.entries, entry(record(CLOUD_ONLY, null))] }
      return { request: { id, hash: HASH, expected: image, base }, preview: { base, snapshot, issues: [], addedKeys: [CLOUD_ONLY] } }
    }),
    commitLink: vi.fn(async (request: Parameters<OwnerWorkspaceSyncFacade['commitLink']>[0], _confirmed: true) => {
      const sync = { ...image.sync, base: request.base }
      image = { sync, local: { ...image.local, sync } }; status = { ...status, completeReady: false }; return image
    }),
    previewPreparation: vi.fn(async (id: string) => ({ id, hash: PREP_HASH, expected: image, packet })),
    commitPreparation: vi.fn(async (_request: Parameters<OwnerWorkspaceSyncFacade['commitPreparation']>[0], _confirmed: true) => { persist('prepared'); return image }),
    sendOnce: vi.fn(async () => { persist('confirmed'); return image }),
    reconcileReceipt: vi.fn(async () => { persist('confirmed'); return image }),
    previewAcknowledgement: vi.fn(async (id: string, resolutions: Parameters<OwnerWorkspaceSyncFacade['previewAcknowledgement']>[1] = []) => {
      const conflict = status.state === 'conflict', choice = resolutions?.find(row => row.key === KEY && row.field === 'shares')?.choice ?? null
      const conflicts: OwnerWorkspaceAckPreview['conflicts'] = conflict ? [{ key: KEY, field: 'shares', reason: 'field_changed',
        base: entry(record(KEY, 10)), local: entry(), cloud: entry(record(KEY, 12)), groupKeys: [KEY], localAllowed: true, choice }] : []
      const nextSnapshot = conflict && !choice ? null : { ...image.local.snapshot, entries: [entry(record(KEY, choice === 'local' ? 0 : 12)), entry(record(DELETED, 0, true))] }
      const preview: OwnerWorkspaceAckPreview = { schema: 'owner-workspace-ack-preview-1', outcome: conflict ? 'conflict' : 'success',
        issues: [], conflicts, rows: nextSnapshot ? [{ key: KEY, before: entry(), after: nextSnapshot.entries[0], fields: ['shares'] }]: [],
        nextSnapshot, baseD, changedKeys: nextSnapshot ? [KEY] : [], excludedManualAssets: 1 }
      const request = nextSnapshot ? { id, hash: HASH, expected: image, matchedResult: { source: 'write' as const,
        requestId: ORIGINAL_ID, requestHash: HASH, status: conflict ? 409 : 200, rawBody: '{}' },
      completeBaseline: baseD, minimumObservedRevision: 2, resolutions: resolutions ?? [] } : null
      return { preview, request }
    }),
    commitAcknowledgement: vi.fn(async (_request: Parameters<OwnerWorkspaceSyncFacade['commitAcknowledgement']>[0], _confirmed: true) => {
      const sync = { ...image.sync, base: baseD, pending: null }
      image = { sync, local: { ...image.local, sync, outbox: { version: image.local.outbox.version + 1, entry: null } } }
      status = { ...status, state: 'idle', resultReady: false, completeReady: false }; return image
    }),
    cancelPrepared: vi.fn(async (_id: string, _confirmed: true) => {
      const sync = { ...image.sync, pending: null }; image = { sync, local: { ...image.local, sync, outbox: { version: 9, entry: null } } }
      status = { ...status, state: 'idle' }; return image
    }),
    reconcileLocal: vi.fn<OwnerWorkspaceSyncFacade['reconcileLocal']>(async (_id, _hash) => { uncertain = null; return { state: 'matched', value: image } }),
    exportPending: vi.fn(async () => image.sync.pending ? { requestId: ORIGINAL_ID, requestHash: HASH, rawBody: packet.rawBody,
      preparationHash: PREP_HASH, targetFingerprint: TARGET, state: image.local.outbox.entry!.state } : null),
  } satisfies OwnerWorkspaceSyncFacade
  const store = reactive({ authorityState: 'idb', localSyncFormat: 'v4' as 'v3' | 'v4' | null,
    enableWorkspaceSync: vi.fn(async (_consent: true) => { enabled = true; return facade }),
    disableWorkspaceSync: vi.fn(() => { enabled = false }),
  })
  mocks.store = store
  return { facade, store, image: () => image, persist, setUncertain: () => { uncertain = { operation: 'prepare', id: ORIGINAL_ID, hash: PREP_HASH } } }
}
async function mount() {
  const root = node(), app = renderer.createApp(OwnerManagedSyncPanel)
  app.mount(root); closes.push(() => app.unmount()); await nextTick(); return root
}
async function enabled(options: Parameters<typeof fixture>[0] = { linked: true }) {
  const f = fixture(options), root = await mount()
  await check(root, 'owner-managed-consent'); await click(root, '启用工作区本轮核对'); return { ...f, root }
}
beforeEach(() => {
  blobs.length = 0; mocks.setSession(['read_private', 'write_holdings'])
  vi.stubGlobal('document', { body: { appendChild: vi.fn() }, createElement: () => ({ href: '', download: '', click: vi.fn(), remove: vi.fn() }) })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return 'blob:synthetic-managed' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { closes.splice(0).forEach(close => close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('managed SFC explicit consent and complete previews', () => {
  it('does not enable/hydrate/fetch on mount and blocks v3 or insufficient private scopes', async () => {
    const f = fixture(), root = await mount()
    expect(f.store.enableWorkspaceSync).not.toHaveBeenCalled(); expect(f.facade.hydrate).not.toHaveBeenCalled(); expect(f.facade.pullComplete).not.toHaveBeenCalled()
    expect(button(root, '启用工作区本轮核对').props.disabled).toBe(true)
    f.store.localSyncFormat = 'v3'; await nextTick()
    expect(output(root)).toContain('旧同步流程不能处理当前工作区')
    expect(all(root).find(row => row.props.name === 'owner-managed-consent')!.props.disabled).toBe(true)
    f.store.localSyncFormat = 'v4'; mocks.setSession(['read_private']); await nextTick()
    expect(output(root)).toContain('具有私人数据读写权限的会话')
    expect(button(root, '启用工作区本轮核对').props.disabled).toBe(true)
    expect(f.store.enableWorkspaceSync).not.toHaveBeenCalled()
  })

  it('requires complete pull, link preview and separate confirmation while showing every account/manual history/0/null', async () => {
    const f = await enabled({ linked: false })
    expect(f.facade.hydrate).toHaveBeenCalledTimes(1); expect(f.facade.pullComplete).not.toHaveBeenCalled()
    expect(button(f.root, '预览建立同步基线').props.disabled).toBe(true)
    await click(f.root, '完整拉取云端截止快照'); await click(f.root, '预览建立同步基线')
    for (const text of [KEY, DELETED, CLOUD_ONLY, '删除：是（保留历史）', '份额：0', 'null（未知）', '保留的手工现金', '不导入本机']) expect(output(f.root)).toContain(text)
    expect(button(f.root, '确认建立同步基线').props.disabled).toBe(true)
    expect(f.facade.commitLink).not.toHaveBeenCalled()
    await check(f.root, 'owner-managed-link'); await click(f.root, '确认建立同步基线')
    expect(f.facade.commitLink).toHaveBeenCalledWith((await f.facade.previewLink.mock.results[0].value).request, true)
    expect(f.facade.sendOnce).not.toHaveBeenCalled()
    expect(f.facade.hydrate).toHaveBeenCalledTimes(1)
  })

  it('previews every original operation, saves without sending, and requires a second single-send consent', async () => {
    const f = await enabled()
    await click(f.root, '预览本机变更提交')
    for (const text of [KEY, DELETED, '份额：0', '成本：null（未知）', '目标权重：0', '删除，不携带新金融值']) expect(output(f.root)).toContain(text)
    expect(button(f.root, '确认保存这一批提交').props.disabled).toBe(true)
    await check(f.root, 'owner-managed-prepare'); await click(f.root, '确认保存这一批提交')
    expect(f.facade.commitPreparation).toHaveBeenCalledTimes(1); expect(f.facade.sendOnce).not.toHaveBeenCalled()
    expect(button(f.root, '单次发送这份提交').props.disabled).toBe(true)
    await check(f.root, 'owner-managed-send'); await click(f.root, '单次发送这份提交')
    expect(f.facade.sendOnce).toHaveBeenCalledTimes(1); expect(f.facade.pullComplete).not.toHaveBeenCalled()
    expect(f.facade.hydrate).toHaveBeenCalledTimes(1) // Never destroy the newly bound result by hydrating after send.
    expect(output(f.root)).toContain('原回执已匹配')
    expect(button(f.root, '预览完整核对与应用').props.disabled).toBe(true)
  })

  it('matched result still needs full D, full ACK rows and separate apply consent; no legacy clear/rebase method exists', async () => {
    const f = await enabled({ linked: true, initial: 'confirmed' })
    await click(f.root, '完整拉取云端截止快照'); await click(f.root, '预览完整核对与应用')
    for (const text of ['本机应用前', '本机应用后', '份额：12', '全部记录仍待业务确认', '部分记录当成完整快照']) expect(output(f.root)).toContain(text)
    expect(button(f.root, '确认应用完整核对结果').props.disabled).toBe(true)
    await check(f.root, 'owner-managed-ack'); await click(f.root, '确认应用完整核对结果')
    expect(f.facade.commitAcknowledgement).toHaveBeenCalledTimes(1)
    expect(f.image().sync.pending).toBeNull(); expect(f.image().local.outbox.entry).toBeNull()
    expect(f.facade.sendOnce).not.toHaveBeenCalled(); expect(f.facade.hydrate).toHaveBeenCalledTimes(1)
  })

  it('presents B/L/D conflict values, requires explicit per-field selection and regenerates the preview before apply', async () => {
    const f = await enabled({ linked: true, initial: 'conflict' })
    await click(f.root, '完整拉取云端截止快照'); await click(f.root, '预览完整核对与应用')
    for (const text of ['上次同步基线', '本机变更', '本次云端完整快照', '份额：10', '份额：0', '份额：12', '同一字段在云端也发生变化']) expect(output(f.root)).toContain(text)
    expect(button(f.root, '确认应用完整核对结果').props.disabled).toBe(true)
    await choose(f.root, 'local')
    expect(button(f.root, '确认应用完整核对结果').props.disabled).toBe(true)
    await click(f.root, '重新核对冲突选择')
    expect(f.facade.previewAcknowledgement.mock.calls[1][1]).toEqual([{ key: KEY, field: 'shares', choice: 'local' }])
    expect(f.facade.previewAcknowledgement.mock.calls[1][0]).toBe(f.facade.previewAcknowledgement.mock.calls[0][0])
    await check(f.root, 'owner-managed-ack')
    await choose(f.root, 'cloud') // Changing a choice discards the old ACK request and confirmation.
    expect(button(f.root, '确认应用完整核对结果').props.disabled).toBe(true)
    expect(f.facade.commitAcknowledgement).not.toHaveBeenCalled()
    await click(f.root, '重新核对冲突选择'); await check(f.root, 'owner-managed-ack'); await click(f.root, '确认应用完整核对结果')
    expect(f.facade.commitAcknowledgement.mock.calls[0][0].resolutions).toEqual([{ key: KEY, field: 'shares', choice: 'cloud' }])
  })

  it('requires prepared cancellation consent and never automatically pulls or sends its replacement', async () => {
    const f = await enabled({ linked: true, initial: 'prepared' })
    expect(button(f.root, '取消尚未发送的提交').props.disabled).toBe(true)
    await check(f.root, 'owner-managed-cancel'); await click(f.root, '取消尚未发送的提交')
    expect(f.facade.cancelPrepared).toHaveBeenCalledWith(expect.any(String), true)
    expect(f.facade.pullComplete).not.toHaveBeenCalled(); expect(f.facade.previewPreparation).not.toHaveBeenCalled(); expect(f.facade.sendOnce).not.toHaveBeenCalled()
  })
})

describe('managed SFC unknown/private lifetime and allowlisted exports', () => {
  it('unknown exposes only receipt/export/close, never send/cancel/pull/prepare/apply, and exports exact original target bytes', async () => {
    const f = await enabled({ linked: true, initial: 'unknown' })
    const labels = all(f.root).filter(row => row.tag === 'button').map(row => output(row).trim())
    expect(labels).toEqual(['核对原请求回执', '导出原包、哈希与状态', '关闭并隐藏工作区同步'])
    await click(f.root, '导出原包、哈希与状态')
    expect(JSON.parse(await blobs[0].text())).toEqual({ schema: 'owner-workspace-original-export-1', target_fingerprint: TARGET,
      request_id: ORIGINAL_ID, request_hash: HASH, preparation_hash: PREP_HASH, raw_body: packet.rawBody, state: 'unknown' })
    expect(f.facade.sendOnce).not.toHaveBeenCalled(); expect(f.facade.cancelPrepared).not.toHaveBeenCalled(); expect(f.facade.pullComplete).not.toHaveBeenCalled()
    await click(f.root, '核对原请求回执'); expect(f.facade.reconcileReceipt).toHaveBeenCalledTimes(1)
    expect(f.facade.hydrate).toHaveBeenCalledTimes(1)
  })

  it('lost local response blocks replay, keeps its exact tuple across close/reopen and does not hydrate over local-unknown', async () => {
    const f = await enabled()
    f.facade.commitPreparation.mockImplementationOnce(async () => { f.persist('prepared'); f.setUncertain(); throw new Error('synthetic lost local response') })
    await click(f.root, '预览本机变更提交'); await check(f.root, 'owner-managed-prepare'); await click(f.root, '确认保存这一批提交')
    expect(output(f.root)).toContain('本机提交结果待核对'); expect(output(f.root)).toContain(ORIGINAL_ID); expect(output(f.root)).toContain(PREP_HASH)
    expect(all(f.root).some(row => row.tag === 'button' && /预览本机|单次发送|确认保存|完整拉取/.test(output(row)))).toBe(false)
    await click(f.root, '关闭并隐藏工作区同步')
    expect(output(f.root)).not.toContain(ORIGINAL_ID); expect(output(f.root)).not.toContain(PRIVATE)
    expect(f.store.disableWorkspaceSync).toHaveBeenCalled()
    await check(f.root, 'owner-managed-consent'); await click(f.root, '启用工作区本轮核对')
    expect(f.facade.hydrate).toHaveBeenCalledTimes(1)
    expect(output(f.root)).toContain(ORIGINAL_ID)
    await click(f.root, '导出原包、哈希与状态')
    expect(JSON.parse(await blobs[0].text()).target_fingerprint).toBe(TARGET) // getState is null, but export carries bound target.
    await click(f.root, '手动核对原本机回执')
    expect(f.facade.reconcileLocal).toHaveBeenCalledWith(ORIGINAL_ID, PREP_HASH)
    expect(f.facade.commitPreparation).toHaveBeenCalledTimes(1); expect(f.facade.sendOnce).not.toHaveBeenCalled()
  })

  it('a missing local receipt stays unknown and the tuple export contains only operation/id/hash', async () => {
    const f = await enabled({ linked: true, localUnknown: true })
    f.facade.reconcileLocal.mockResolvedValueOnce({ state: 'unknown' })
    await click(f.root, '手动核对原本机回执'); expect(output(f.root)).toContain('没有匹配本机回执，结果仍未知')
    await click(f.root, '导出本机待核对标识')
    expect(JSON.parse(await blobs[0].text())).toEqual({ schema: 'owner-workspace-local-uncertain-1', operation: 'prepare', id: ORIGINAL_ID, hash: PREP_HASH })
    expect(f.facade.hydrate).not.toHaveBeenCalled(); expect(f.facade.commitPreparation).not.toHaveBeenCalled()
  })

  it.each(['revoke', 'logout', 'unmount'] as const)('%s hides private original/preview and revokes without destroying the store-owned facade', async action => {
    const f = await enabled({ linked: true, initial: 'prepared' })
    expect(output(f.root)).toContain(ORIGINAL_ID)
    if (action === 'revoke') await check(f.root, 'owner-managed-consent', false)
    if (action === 'logout') { mocks.setSession(null); await nextTick() }
    if (action === 'unmount') { closes.pop()!(); await nextTick() }
    expect(output(f.root)).not.toContain(ORIGINAL_ID); expect(output(f.root)).not.toContain(PRIVATE)
    expect(f.store.disableWorkspaceSync).toHaveBeenCalled(); expect(f.image().sync.pending!.rawBody).toBe(packet.rawBody)
    expect(f.facade).not.toHaveProperty('close'); expect(f.facade).not.toHaveProperty('setCloudConsent')
  })

  it('a late private preview after revocation is not rendered, committed, or used to re-enable the store', async () => {
    const f = await enabled(); let finish!: (value: Awaited<ReturnType<OwnerWorkspaceSyncFacade['previewPreparation']>>) => void
    f.facade.previewPreparation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const previewing = click(f.root, '预览本机变更提交')
    await vi.waitFor(() => expect(f.facade.previewPreparation).toHaveBeenCalledTimes(1))
    await check(f.root, 'owner-managed-consent', false)
    finish({ id: ORIGINAL_ID, hash: PREP_HASH, expected: f.image(), packet }); await previewing
    expect(output(f.root)).not.toContain(PRIVATE); expect(output(f.root)).not.toContain(ORIGINAL_ID)
    expect(f.facade.commitPreparation).not.toHaveBeenCalled(); expect(f.store.enableWorkspaceSync).toHaveBeenCalledTimes(1)
  })
})
