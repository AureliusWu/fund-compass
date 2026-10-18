<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { hasOwnerSession, ownerSession, ownerSessionGeneration } from '@/stores/ownerSession'
import { useWatchlistStore, type OwnerSyncWatchSnapshot } from '@/stores/watchlist'
import type { OwnerSyncBaseline, OwnerSyncCandidateStatus, OwnerSyncCandidateTransport } from '@/stores/ownerSyncCandidate'
import type { OwnerSyncOutbox, OwnerSyncOutboxEntry } from '@/stores/ownerSyncOutbox'
import type { OwnerSyncPreview } from '@/utils/owner-sync-preview'

type Candidate = ReturnType<typeof import('@/stores/ownerSyncCandidate')['createOwnerSyncCandidate']>
type Result = ReturnType<Candidate['getLastResult']>
type PreviewBuilder = typeof import('@/utils/owner-sync-preview')['buildOwnerSyncPreview']
interface Context { epoch: number; generation: number }
interface PendingView extends OwnerSyncOutboxEntry { readonly targetFingerprint: string }

const watchlist = useWatchlistStore()
const opened = ref(false)
const consent = ref(false)
const enabled = ref(false)
const busy = ref(false)
const singleSendConsent = ref(false)
const finishConsent = ref(false)
const message = ref('')
const status = shallowRef<OwnerSyncCandidateStatus | null>(null)
const preview = shallowRef<OwnerSyncPreview | null>(null)
const pending = shallowRef<PendingView | null>(null)
const result = shallowRef<Result>(null)
const localSnapshot = shallowRef<OwnerSyncWatchSnapshot | null>(null)
let candidate: Candidate | null = null
let outbox: OwnerSyncOutbox | null = null
let buildPreview: PreviewBuilder | null = null
const preparedSnapshot = shallowRef<OwnerSyncWatchSnapshot | null>(null)
let writeSnapshot: OwnerSyncWatchSnapshot | null = null
let epoch = 0
let mounted = true

const authenticated = computed(() => Boolean(ownerSession.value)
  && ownerSession.value!.scopes.includes('read_private') && ownerSession.value!.scopes.includes('write_holdings'))
const privateVisible = computed(() => enabled.value && consent.value && authenticated.value)
const state = computed(() => status.value?.state ?? 'disabled')
const unresolved = computed(() => pending.value?.state === 'unknown' || pending.value?.state === 'attempted')
const resolved = computed(() => (pending.value?.state === 'confirmed' && result.value?.kind === 'success')
  || (pending.value?.state === 'conflict' && result.value?.kind === 'conflict'))
const stateLabel = computed(() => busy.value ? '操作进行中，请勿重复提交'
  : unresolved.value ? '结果未知 · 原包保留'
  : state.value === 'prepared' ? '原包已准备 · 尚未发送'
  : state.value === 'confirmed' ? '这一批请求已确认'
  : state.value === 'conflict' ? '存在冲突 · 原包保留'
  : preview.value ? '已核对 · 等待你检查完整变更'
  : '已启用本轮操作 · 尚未拉取')
const canPrepare = computed(() => !busy.value && !pending.value && Boolean(preview.value?.operations.length)
  && preview.value?.issues.length === 0 && Boolean(localSnapshot.value))
const canSend = computed(() => !busy.value && pending.value?.state === 'prepared'
  && Boolean(preparedSnapshot.value) && singleSendConsent.value)

function assertContext(context: Context): void {
  if (!mounted || context.epoch !== epoch || context.generation !== ownerSessionGeneration.value
    || !consent.value || !authenticated.value || !hasOwnerSession()) throw new Error('owner_sync_context_changed')
}
function currentContext(): Context {
  const context = { epoch, generation: ownerSessionGeneration.value }
  assertContext(context)
  return context
}
function dispose(closePanel = false): void {
  epoch++
  candidate?.setCloudConsent(false) // Aborts waiting, hides baseline/result; never clears the durable slot.
  outbox?.close()
  candidate = null; outbox = null; buildPreview = null
  preparedSnapshot.value = null; writeSnapshot = null
  enabled.value = false; busy.value = false
  preview.value = null; pending.value = null; result.value = null; localSnapshot.value = null; status.value = null
  singleSendConsent.value = false; finishConsent.value = false; message.value = ''
  if (consent.value) consent.value = false
  if (closePanel) opened.value = false
}
watch(consent, value => { if (!value) dispose() }, { flush: 'sync' })
watch(ownerSessionGeneration, () => dispose(), { flush: 'sync' })
onBeforeUnmount(() => { mounted = false; dispose(true) })

async function refreshView(context: Context): Promise<void> {
  assertContext(context)
  const active = candidate!, handle = outbox!
  const stored = await handle.read()
  assertContext(context)
  pending.value = stored.entry ? Object.freeze({ ...stored.entry, targetFingerprint: handle.targetFingerprint }) : null
  status.value = active.status()
  result.value = active.getLastResult()
}
async function operate(work: (context: Context) => Promise<void>): Promise<void> {
  if (busy.value || !candidate || !outbox || !enabled.value) return
  let context: Context
  try { context = currentContext() } catch { dispose(); return }
  busy.value = true
  message.value = ''
  singleSendConsent.value = false
  finishConsent.value = false
  try {
    await work(context)
    assertContext(context)
    await refreshView(context)
  } catch {
    if (context.epoch === epoch && context.generation === ownerSessionGeneration.value && consent.value) {
      preview.value = null; localSnapshot.value = null
      try { await refreshView(context) } catch { /* Preserve the last safe view; never replace a pending packet. */ }
      message.value = pending.value
        ? '操作未完成或本机记录已变更。原提交保留；请核对回执，或取消尚未发送的提交后重新预览。不会自动重发。'
        : '手动核对未完成。请检查本机存储及私人服务的兼容配置；本机记录没有被云端覆盖，也不会自动发送或重试。'
    }
  } finally { if (context.epoch === epoch) busy.value = false }
}
async function enable(): Promise<void> {
  if (busy.value || enabled.value || !consent.value || !authenticated.value || !hasOwnerSession()) return
  let context: Context
  try { context = currentContext() } catch { dispose(); return }
  busy.value = true
  message.value = ''
  let openedOutbox: OwnerSyncOutbox | null = null
  try {
    // The parser, IDB handle and HTTP adapter stay dormant until this explicit
    // authenticated, per-round consent action. Mount/open never initializes them.
    const [http, storage, controller, previewModule] = await Promise.all([
      import('@/api/owner-sync-transport'), import('@/stores/ownerSyncOutbox'),
      import('@/stores/ownerSyncCandidate'), import('@/utils/owner-sync-preview'),
    ])
    assertContext(context)
    const transport = await http.createOwnerSyncHttpTransport()
    assertContext(context)
    openedOutbox = await storage.openOwnerSyncOutbox(globalThis.indexedDB, transport.targetFingerprint)
    assertContext(context)
    const guarded: OwnerSyncCandidateTransport = {
      targetFingerprint: transport.targetFingerprint,
      write(packet, signal) {
        assertContext(context)
        if (!writeSnapshot) throw new Error('owner_sync_preview_required')
        watchlist.assertOwnerSyncSnapshot(writeSnapshot)
        return transport.write(packet, signal)
      },
      receipt(requestId, hash, signal) {
        assertContext(context)
        // A receipt concerns the original durable request, not today's local
        // edits. Changing the work copy must never prevent unknown reconciliation.
        return transport.receipt(requestId, hash, signal)
      },
      changes(parameters, signal) { assertContext(context); return transport.changes(parameters, signal) },
    }
    const active = controller.createOwnerSyncCandidate({ outbox: openedOutbox, transport: guarded,
      session: () => ({ authenticated: authenticated.value && hasOwnerSession(), generation: ownerSessionGeneration.value }) })
    active.setCloudConsent(true)
    candidate = active; outbox = openedOutbox; buildPreview = previewModule.buildOwnerSyncPreview
    enabled.value = true
    await active.hydratePending()
    assertContext(context)
    await refreshView(context)
  } catch {
    openedOutbox?.close()
    if (context.epoch === epoch) {
      dispose()
      message.value = '本轮同步未启用。请检查私人会话、浏览器存储及服务端兼容配置；本机记录未修改。'
    }
  } finally { if (context.epoch === epoch) busy.value = false }
}
async function pullAndPreview(context: Context): Promise<void> {
  await candidate!.pullBaseline()
  assertContext(context)
  const baseline: OwnerSyncBaseline | null = candidate!.getBaseline()
  if (!baseline) throw new Error('owner_sync_complete_baseline_required')
  // Read a fresh complete local copy AFTER the GET, not a stale preview. This
  // never applies cloud rows locally and never clears local_pending/action gates.
  const snapshot = watchlist.readOwnerSyncSnapshot()
  const next = buildPreview!(snapshot, baseline)
  assertContext(context)
  localSnapshot.value = snapshot; preview.value = next; preparedSnapshot.value = null
}
async function pull(): Promise<void> {
  if (pending.value) return
  await operate(pullAndPreview)
}
async function prepare(): Promise<void> {
  if (!canPrepare.value || !localSnapshot.value || !preview.value) return
  const snapshot = localSnapshot.value, originalPreview = preview.value
  await operate(async context => {
    watchlist.assertOwnerSyncSnapshot(snapshot)
    const baseline = candidate!.getBaseline()
    if (!baseline || !buildPreview) throw new Error('owner_sync_preview_required')
    const checked = buildPreview(snapshot, baseline)
    if (checked.issues.length || !checked.operations.length
      || JSON.stringify(checked) !== JSON.stringify(originalPreview)) throw new Error('owner_sync_preview_changed')
    const id = 'owner-ui-' + globalThis.crypto.randomUUID()
    await candidate!.prepare(id, checked.operations)
    assertContext(context)
    preparedSnapshot.value = snapshot
    watchlist.assertOwnerSyncSnapshot(snapshot)
  })
}
async function sendOnce(): Promise<void> {
  if (!canSend.value || !preparedSnapshot.value) return
  const snapshot = preparedSnapshot.value
  await operate(async context => {
    // Known stale local data is rejected before the candidate marks attempted.
    watchlist.assertOwnerSyncSnapshot(snapshot)
    writeSnapshot = snapshot
    try { await candidate!.sendPrepared() } finally { writeSnapshot = null }
    assertContext(context)
  })
}
async function reconcile(): Promise<void> {
  if (!pending.value || pending.value.state === 'prepared') return
  await operate(async () => { await candidate!.reconcilePending() })
}
async function finishAndPull(): Promise<void> {
  if (!finishConsent.value || !resolved.value) return
  await operate(async context => {
    await candidate!.clearResolvedOrUnsent()
    assertContext(context)
    pending.value = null; result.value = null; preparedSnapshot.value = null
    await pullAndPreview(context)
  })
}
async function cancelUnsentAndPull(): Promise<void> {
  if (!finishConsent.value || pending.value?.state !== 'prepared') return
  await operate(async context => {
    await candidate!.clearResolvedOrUnsent()
    assertContext(context)
    pending.value = null; result.value = null; preparedSnapshot.value = null
    await pullAndPreview(context)
  })
}
function downloadJson(filename: string, payload: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  try {
    anchor.href = url; anchor.download = filename
    document.body.appendChild(anchor); anchor.click()
  } finally { anchor.remove(); URL.revokeObjectURL(url) }
}
function exportOriginal(): void {
  try {
    currentContext()
    if (!pending.value) return
    const entry = pending.value
    downloadJson('司南基金_同步原包.json', { schema: 'owner-sync-original-export-1',
      target_fingerprint: entry.targetFingerprint, state: entry.state,
      raw_body: entry.rawBody, request_hash: entry.requestHash })
  } catch { message.value = '原包导出未完成；存储中的原包没有删除。' }
}
function exportLocal(): void {
  try {
    currentContext()
    const snapshot = watchlist.readOwnerSyncSnapshot()
    // Deliberately export only the complete watch-record field set, not Gist
    // configuration, Owner metadata, unrelated storage or arbitrary extra keys.
    const fields = new Set(['code', 'name', 'shares', 'position_kind', 'cost', 'target_weight', 'account', 'updated_at', 'deleted', 'id', 'local_pending'])
    const records = snapshot.entries.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.has(key))))
    watchlist.assertOwnerSyncSnapshot(snapshot)
    downloadJson('司南基金_本机完整自选副本.json', { schema: 'owner-sync-local-export-1', includes_tombstones: true, includes_manual_assets: false, records })
  } catch { message.value = '本机副本无法安全导出；原存储未覆盖，请先检查本机存储。' }
}
const fieldNames: Record<string, string> = { name: '名称', shares: '份额', cost: '成本', target_weight: '目标权重', kind: '记录类型', deleted: '删除状态',
  expected_revision: '预期账本序号', record_revision: '记录序号' }
const actionNames = { create: '新增', update: '更新', delete: '删除', kind_change: '变更类型' }
const issueNames: Record<string, string> = { invalid_local_record: '本机记录不完整或不兼容', ambiguous_kind: '无法确定关注或持仓意图',
  missing_value: '缺少必要值', duplicate_key: '账户键重复', invalid_baseline: '云端基线无效',
  cloud_tombstone: '云端已删除，这里不会恢复旧记录', too_many_operations: '变更超过单批上限', invalid_operation: '变更不能安全提交' }
const valuesText = (value: unknown) => JSON.stringify(value)
const checked = (event: Event) => (event.target as HTMLInputElement | null)?.checked === true
</script>

<template>
  <section class="owner-sync" aria-label="私人自选同步">
    <header class="owner-sync-header">
      <div><h2>私人自选同步</h2><p>默认关闭 · 每一批都由你核对、准备并单次发送</p></div>
      <button v-if="!opened" type="button" class="sync-button" @click="opened = true">查看私人同步</button>
      <button v-else type="button" class="sync-button" @click="dispose(true)">关闭并隐藏</button>
    </header>
    <div v-if="opened" class="owner-sync-body">
      <p class="sync-boundary">不含手工资产。只核对当前本机完整自选和账户记录；不读取旧版 Gist，不把云端记录合并到本机。</p>
      <p class="sync-boundary">同步账本确认不等于持仓决策版本。这里不会清除本地待确认状态，也不会解除当前行动门禁。</p>
      <p class="sync-boundary">服务端须先完成兼容配置。本面板不自动迁移数据库，也不证明云端耐久或恢复能力。</p>
      <p v-if="!authenticated" class="sync-notice" role="status">请先在上方登录私人会话。登录本身不授权同步。</p>
      <label class="sync-check"><input :checked="consent" type="checkbox" name="owner-sync-consent" :disabled="!authenticated" @change="consent = checked($event)" /><span>我同意仅在本轮打开私人同步，并在单独确认后发送已展示的自选及账户变更。</span></label>
      <button v-if="!enabled" type="button" class="sync-button sync-primary" :disabled="!authenticated || !consent || busy" @click="enable">启用本轮核对</button>
      <p v-if="message" class="sync-error" role="alert">{{ message }}</p>
      <div v-if="privateVisible" class="sync-private">
        <p class="sync-state" role="status" aria-live="polite">{{ stateLabel }}</p>
        <p v-if="status?.lastCompletePulledRevision !== null && status?.lastCompletePulledRevision !== undefined" class="sync-meta">完整拉取截止账本序号 {{ status.lastCompletePulledRevision }}；不是持仓版本。</p>
        <div v-if="!pending" class="sync-actions">
          <button type="button" class="sync-button" :disabled="busy" @click="pull">手动拉取并预览</button>
          <button type="button" class="sync-button sync-primary" :disabled="!canPrepare" @click="prepare">准备这一批原包</button>
        </div>
        <div v-if="preview && !unresolved" class="sync-preview" aria-label="完整账户变更预览">
          <h3>逐账户变更清单</h3>
          <p>本机完整副本 {{ localSnapshot?.entries.length }} 条（含删除记录）；本批 {{ preview.rows.length }} 条变更。云端独有记录不会被删除。</p>
          <ul v-if="preview.issues.length" class="sync-issues" role="alert">
            <li v-for="(issue, index) in preview.issues" :key="index">{{ issueNames[issue.code] || '记录不能安全提交' }}<code v-if="issue.key">{{ issue.key }}</code></li>
          </ul>
          <p v-else-if="!preview.rows.length">没有可提交的变化；不生成空请求。</p>
          <article v-for="row in preview.rows" :key="row.key" class="sync-row" :class="{ 'sync-deletion': row.action === 'delete' }">
            <div class="sync-row-heading"><strong>{{ row.code }} · {{ row.account || '未分组账户' }}</strong><b>{{ actionNames[row.action] }}</b></div>
            <p>变更字段：{{ row.fields.map(field => fieldNames[field] || field).join('、') }}</p>
            <dl><dt>原云端记录</dt><dd>{{ row.before ? valuesText({ kind: row.before.kind, deleted: row.before.deleted, values: row.before.values }) : '不存在' }}</dd>
              <dt>本次完整目标</dt><dd>{{ valuesText(row.after) }}</dd></dl>
          </article>
        </div>
        <div v-if="pending" class="sync-packet">
          <h3>保留的原始提交</h3>
          <dl><dt>状态</dt><dd>{{ pending.state }}</dd><dt>原包 SHA256</dt><dd><code>{{ pending.requestHash }}</code></dd><dt>API 端点指纹（非数据库身份）</dt><dd><code>{{ pending.targetFingerprint }}</code></dd></dl>
          <details><summary>查看原始请求文本</summary><pre>{{ pending.rawBody }}</pre></details>
          <p v-if="unresolved" class="sync-notice">结果未知，不代表未提交。这里只核对原回执、导出或关闭；不重发、不清除原包。</p>
          <template v-if="pending.state === 'prepared'">
            <p v-if="!preparedSnapshot" class="sync-notice">本轮没有原包对应的本机预览。请取消尚未发送的提交后重新预览，不直接发送旧包。</p>
            <label class="sync-check"><input :checked="singleSendConsent" type="checkbox" name="owner-sync-single-send" :disabled="busy || !preparedSnapshot" @change="singleSendConsent = checked($event)" /><span>我已检查所有账户与删除项，仅发送这份原包一次。</span></label>
            <button type="button" class="sync-button sync-primary" :disabled="!canSend" @click="sendOnce">单次发送原包</button>
            <label class="sync-check"><input :checked="finishConsent" type="checkbox" name="owner-sync-cancel-unsent" :disabled="busy" @change="finishConsent = checked($event)" /><span>我确认取消这个尚未发送的提交，保留本机副本并重新核对。</span></label>
            <button type="button" class="sync-button" :disabled="busy || !finishConsent" @click="cancelUnsentAndPull">取消尚未发送的提交并重新预览</button>
          </template>
          <button v-else type="button" class="sync-button" :disabled="busy" @click="reconcile">核对原请求回执</button>
          <template v-if="result?.kind === 'success'"><p class="sync-notice">仅这一批原包已由同步账本确认，序号 {{ result.result.revision }}。本机持仓决策版本没有因此更新。</p></template>
          <template v-if="result?.kind === 'conflict'">
            <h3>冲突字段摘要</h3><ul class="sync-issues"><li v-for="(conflict, index) in result.result.conflicts" :key="index"><code>{{ conflict.key_digest }}</code> · {{ conflict.fields.map(field => fieldNames[field] || field).join('、') }}</li></ul>
          </template>
          <template v-if="resolved">
            <label class="sync-check"><input :checked="finishConsent" type="checkbox" name="owner-sync-finish-resolved" :disabled="busy" @change="finishConsent = checked($event)" /><span>我已检查这一批的回执或冲突，明确结束此已决请求；保留本机副本并重新拉取。</span></label>
            <button type="button" class="sync-button" :disabled="busy || !finishConsent" @click="finishAndPull">结束已决请求并重新拉取</button>
          </template>
          <button type="button" class="sync-button" :disabled="busy" @click="exportOriginal">导出原包、哈希与状态</button>
        </div>
        <button type="button" class="sync-button sync-export" :disabled="busy" @click="exportLocal">导出本机完整副本（含删除记录）</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.owner-sync { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card-bg); color: var(--ink); }
.owner-sync-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px; }
.owner-sync h2 { margin: 0; font: 600 15px/1.4 var(--font-display); }
.owner-sync h3 { margin: 16px 0 8px; font: 600 14px/1.5 var(--font-display); }
.owner-sync p { margin: 8px 0; font-size: 12px; line-height: 1.7; }
.owner-sync-header p, .sync-meta { color: var(--text-muted); }
.owner-sync-body { padding: 0 16px 16px; border-top: 1px solid var(--border); }
.sync-boundary, .sync-notice { padding: 10px 12px; border-left: 2px solid var(--gold); background: var(--gold-soft); }
.sync-check { display: flex; align-items: flex-start; gap: 10px; margin: 14px 0; color: var(--ink); font-size: 12px; line-height: 1.7; cursor: pointer; }
.sync-check input { flex: 0 0 auto; width: 18px; height: 18px; margin: 2px 0; accent-color: var(--teal); }
.sync-button { min-height: 40px; padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); color: var(--teal); background: var(--card-bg); font: inherit; font-size: 12px; line-height: 1.5; cursor: pointer; }
.sync-primary { color: var(--card-bg); background: var(--teal); border-color: var(--teal); }
.sync-button:disabled { opacity: .5; cursor: not-allowed; }
.sync-button:focus-visible, .sync-check input:focus-visible, summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.sync-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.sync-state { color: var(--teal); font-weight: 600; }
.sync-error, .sync-issues { color: var(--danger); }
.sync-issues { padding-left: 20px; font-size: 12px; line-height: 1.8; }
.sync-preview, .sync-packet { margin-top: 16px; padding-top: 4px; border-top: 1px solid var(--border); }
.sync-row { margin: 12px 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.sync-deletion { border-left: 3px solid var(--danger); }
.sync-row-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 12px; }
.sync-row-heading b { color: var(--teal); }.sync-deletion .sync-row-heading b { color: var(--danger); }
.owner-sync dl { display: grid; grid-template-columns: minmax(80px, 1fr) minmax(0, 3fr); gap: 5px 10px; margin: 8px 0; font-size: 11px; line-height: 1.7; }
.owner-sync dt { color: var(--text-muted); }.owner-sync dd { margin: 0; overflow-wrap: anywhere; }
.owner-sync code, .owner-sync pre { font-family: var(--font-mono); font-size: 10px; overflow-wrap: anywhere; white-space: pre-wrap; }
.owner-sync summary { padding: 10px 0; font-size: 12px; cursor: pointer; }
.sync-packet > .sync-button, .sync-export { margin-top: 10px; margin-right: 8px; }
@media (max-width: 480px) { .owner-sync-header { align-items: flex-start; flex-direction: column; }.owner-sync-header > .sync-button, .sync-actions > .sync-button { width: 100%; }.owner-sync dl { grid-template-columns: 1fr; gap: 2px; }.owner-sync dd { margin-bottom: 7px; }.sync-button { min-height: 44px; }.sync-check { min-height: 44px; } }
</style>
