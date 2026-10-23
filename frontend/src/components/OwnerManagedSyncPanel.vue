<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { hasOwnerSession, ownerSession, ownerSessionGeneration } from '@/stores/ownerSession'
import { useWatchlistStore, type OwnerWorkspaceSyncFacade } from '@/stores/watchlist'
import type { OwnerWorkspaceSyncState } from '@/stores/owner-workspace-types'
import type { OwnerWorkspaceAckField, OwnerWorkspaceAckResolution } from '@/utils/owner-workspace-ack'
import type { OwnerSyncOperation, OwnerSyncRecord, OwnerSyncRequest } from '@/utils/ownerSyncContract'
import type { OwnerWorkspaceEntry } from '@/utils/owner-cloud-import'

const emit = defineEmits<{ close: [] }>()
const store = useWatchlistStore()
type Facade = OwnerWorkspaceSyncFacade
type Context = { epoch: number; generation: number }
type Link = Awaited<ReturnType<Facade['previewLink']>>
type Preparation = Awaited<ReturnType<Facade['previewPreparation']>>
type Acknowledgement = Awaited<ReturnType<Facade['previewAcknowledgement']>>
const consent = ref(false), enabled = ref(false), busy = ref(false), message = ref('')
const linkConsent = ref(false), prepareConsent = ref(false), sendConsent = ref(false), cancelConsent = ref(false), ackConsent = ref(false)
const facade = shallowRef<Facade | null>(null), image = shallowRef<OwnerWorkspaceSyncState | null>(null)
const status = shallowRef<ReturnType<Facade['status']> | null>(null)
const link = shallowRef<Link | null>(null), preparation = shallowRef<Preparation | null>(null), acknowledgement = shallowRef<Acknowledgement | null>(null)
const selections = ref<Record<string, 'local' | 'cloud'>>({})
let epoch = 0, mounted = true, hiding = false, ackId = ''
const authenticated = computed(() => !!ownerSession.value?.scopes.includes('read_private')
  && ownerSession.value.scopes.includes('write_holdings'))
const privateVisible = computed(() => enabled.value && consent.value && authenticated.value)
const slot = computed(() => image.value?.local.outbox.entry ?? null)
const pending = computed(() => image.value?.sync.pending ?? null)
const localUnknown = computed(() => status.value?.state === 'local_unknown')
const unknown = computed(() => !localUnknown.value && ['unknown', 'attempted'].includes(slot.value?.state ?? status.value?.state ?? ''))
const resolved = computed(() => !localUnknown.value && ['confirmed', 'conflict'].includes(slot.value?.state ?? ''))
const stateLabel = computed(() => busy.value ? '正在核对，请勿重复操作'
  : localUnknown.value ? '本机提交结果待核对 · 原标识保留'
    : unknown.value ? '云端结果未知 · 原包保留'
      : slot.value?.state === 'prepared' ? '原包已保存 · 尚未发送'
        : resolved.value ? '原请求已决 · 仍须完整核对后应用'
          : image.value?.sync.base ? '已有上次同步基线 · 本机变更仍待确认' : '尚未建立同步基线')
const packetOperations = computed<readonly OwnerSyncOperation[] | null>(() => {
  try {
    if (!pending.value) return null
    // The store's native v4 image already restored/verified these exact bytes.
    const request = JSON.parse(pending.value.rawBody) as OwnerSyncRequest
    return Array.isArray(request.operations) && request.operations.length > 0 ? request.operations : null
  } catch { return null }
})
const linkRows = computed(() => {
  if (!link.value) return []
  const before = new Map(link.value.request.expected.local.snapshot.entries.map(entry => [entry.key, entry]))
  const cloud = new Map(link.value.preview.base.records.filter(row => row.kind !== 'manual_asset').map(row => [row.key, row]))
  const after = new Map(link.value.preview.snapshot.entries.map(entry => [entry.key, entry]))
  return [...new Set([...before.keys(), ...cloud.keys()])].map(key => ({ key, before: before.get(key) ?? null,
    cloud: cloud.get(key) ?? null, after: after.get(key) ?? null }))
})
const manualBase = computed(() => acknowledgement.value?.preview.baseD ?? link.value?.preview.base ?? null)
const manualRows = computed(() => manualBase.value?.records.filter(row => row.kind === 'manual_asset') ?? [])
const fieldNames: Record<string, string> = { name: '名称', shares: '份额', cost: '成本', target_weight: '目标权重',
  kind: '记录类型', deleted: '删除状态', lifecycle: '记录生命周期', rename: '账户更名整组', cls: '资产类别', value: '金额', note: '备注' }
const reasonNames: Record<string, string> = { field_changed: '同一字段在云端也发生变化', field_aba: '字段曾变化后又恢复，不能视为未改动',
  lifecycle_changed: '记录类型、删除或整条记录同时变化', lifecycle_aba: '记录生命周期曾变化后又恢复', creation_collision: '新账户身份与云端重合',
  server_conflict: '原请求已有明确冲突，须重新选择', cloud_tombstone: '云端已删除，不允许用旧本机记录复活', rename_atomic: '旧账户删除与新账户建立必须整组选择' }
const stateNames: Record<string, string> = { prepared: '尚未发送', attempted: '已尝试发送，结果未知', unknown: '结果未知', confirmed: '原请求已确认', conflict: '原请求存在冲突' }
function valueText(value: unknown): string {
  if (value === null) return 'null（未知）'
  if (value === undefined) return '无'
  if (Object.is(value, -0)) return '-0'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}
function valuesText(values: Readonly<Record<string, unknown>> | undefined): string {
  if (!values || !Object.keys(values).length) return '无字段改动'
  return Object.entries(values).map(([field, value]) => `${fieldNames[field] ?? field}：${valueText(value)}`).join('\n')
}
function recordText(entry: OwnerWorkspaceEntry | OwnerSyncRecord | null): string {
  if (!entry) return '无此记录'
  return `类型：${entry.kind === 'holding' ? '持仓' : entry.kind === 'watch' ? '仅关注' : '手工资产'}\n删除：${entry.deleted ? '是（保留历史）' : '否'}\n${valuesText(entry.values as unknown as Readonly<Record<string, unknown>>)}`
}
const checked = (event: Event) => (event.target as HTMLInputElement | null)?.checked === true
const selectionKey = (key: string, field: OwnerWorkspaceAckField) => JSON.stringify([key, field])
const id = () => 'owner-managed-ui-' + globalThis.crypto.randomUUID()
function resetChecks(): void { linkConsent.value = false; prepareConsent.value = false; sendConsent.value = false; cancelConsent.value = false; ackConsent.value = false }
function clearPreviews(): void { link.value = null; preparation.value = null; acknowledgement.value = null; selections.value = {}; ackId = ''; resetChecks() }
function valid(context: Context): boolean {
  return mounted && context.epoch === epoch && context.generation === ownerSessionGeneration.value
    && consent.value && authenticated.value && hasOwnerSession() && store.authorityState === 'idb'
}
function assertContext(context: Context): void { if (!valid(context)) throw new Error('managed_panel_context_changed') }
function refresh(): void { image.value = facade.value?.getState() ?? null; status.value = facade.value?.status() ?? null }
function hide(close = false): void {
  if (hiding) return
  hiding = true
  epoch++; store.disableWorkspaceSync() // Revoke only; the store retains uncertain original local id/hash.
  facade.value = null; image.value = null; status.value = null; enabled.value = false; busy.value = false; message.value = ''
  clearPreviews(); consent.value = false
  hiding = false
  if (close) emit('close')
}
watch(consent, value => { if (!value) hide() }, { flush: 'sync' })
watch(ownerSessionGeneration, () => hide(), { flush: 'sync' })
watch(() => store.authorityState, value => { if (value !== 'idb') hide() }, { flush: 'sync' })
onBeforeUnmount(() => { mounted = false; hide() })
async function enable(): Promise<void> {
  if (busy.value || enabled.value || !consent.value || !authenticated.value || store.localSyncFormat !== 'v4') return
  const context = { epoch, generation: ownerSessionGeneration.value }
  if (!valid(context)) { hide(); return }
  busy.value = true; message.value = ''
  try {
    const active = await store.enableWorkspaceSync(true)
    assertContext(context); facade.value = active; enabled.value = true
    // Reopening is not replay: a preserved local-unknown tuple is reconciled
    // manually. Hydration itself would be blocked and must not hide that tuple.
    if (active.status().state !== 'local_unknown') await active.hydrate()
    assertContext(context); refresh()
  } catch {
    if (valid(context)) {
      refresh(); message.value = '本轮启用或本机读取未完成。不会发送或重放；请检查本机工作区，保留原标识后手动核对。'
    }
  } finally { if (context.epoch === epoch) busy.value = false }
}
async function operate(work: (active: Facade, context: Context) => Promise<void>): Promise<void> {
  if (busy.value || !facade.value || !enabled.value) return
  const context = { epoch, generation: ownerSessionGeneration.value }, active = facade.value
  if (!valid(context)) { hide(); return }
  busy.value = true; message.value = ''; resetChecks()
  try { await work(active, context); assertContext(context); refresh() }
  catch {
    if (valid(context)) {
      clearPreviews(); refresh()
      message.value = '操作未完成或上下文已变化。原包与本机待核对标识不重放；请手动核对回执，或重新启用后读取当前状态。'
    }
  } finally { if (context.epoch === epoch) busy.value = false }
}
async function pull(): Promise<void> { await operate(async active => { clearPreviews(); await active.pullComplete() }) }
async function previewLink(): Promise<void> { await operate(async (active, context) => { clearPreviews(); const next = await active.previewLink(id()); assertContext(context); link.value = next }) }
async function commitLink(): Promise<void> {
  if (!link.value || !linkConsent.value || link.value.preview.issues.length) return
  const request = link.value.request
  await operate(async active => { await active.commitLink(request, true); clearPreviews() })
}
async function previewPreparation(): Promise<void> { await operate(async (active, context) => { clearPreviews(); const next = await active.previewPreparation(id()); assertContext(context); preparation.value = next }) }
async function commitPreparation(): Promise<void> {
  if (!preparation.value || !prepareConsent.value) return
  const request = preparation.value
  await operate(async active => { await active.commitPreparation(request, true); clearPreviews() })
}
async function send(): Promise<void> {
  if (!sendConsent.value || slot.value?.state !== 'prepared' || !packetOperations.value) return
  await operate(async active => { clearPreviews(); await active.sendOnce() })
}
async function reconcile(): Promise<void> { await operate(async active => { clearPreviews(); await active.reconcileReceipt() }) }
async function cancel(): Promise<void> {
  if (!cancelConsent.value || slot.value?.state !== 'prepared') return
  await operate(async active => { await active.cancelPrepared(id(), true); clearPreviews() })
}
async function previewAck(): Promise<void> {
  await operate(async (active, context) => {
    ackId ||= id()
    const resolutions: OwnerWorkspaceAckResolution[] = (acknowledgement.value?.preview.conflicts ?? []).flatMap(conflict => {
      const choice = selections.value[selectionKey(conflict.key, conflict.field)]
      return choice ? [{ key: conflict.key, field: conflict.field, choice }] : []
    })
    const next = await active.previewAcknowledgement(ackId, resolutions)
    assertContext(context); acknowledgement.value = next
    selections.value = Object.fromEntries(next.preview.conflicts.filter(item => item.choice !== null).map(item => [selectionKey(item.key, item.field), item.choice!]))
  })
}
function select(key: string, field: OwnerWorkspaceAckField, choice: 'local' | 'cloud'): void {
  if (busy.value || !acknowledgement.value) return
  selections.value = { ...selections.value, [selectionKey(key, field)]: choice }
  acknowledgement.value = { preview: acknowledgement.value.preview, request: null }; ackConsent.value = false
}
async function commitAck(): Promise<void> {
  if (!ackConsent.value || !acknowledgement.value?.request) return
  const request = acknowledgement.value.request
  await operate(async active => { await active.commitAcknowledgement(request, true); clearPreviews() })
}
async function reconcileLocal(): Promise<void> {
  const uncertain = status.value?.uncertainLocal
  if (!uncertain) return
  await operate(async active => { clearPreviews(); const result = await active.reconcileLocal(uncertain.id, uncertain.hash)
    if (result.state === 'unknown') message.value = '没有匹配本机回执，结果仍未知。不会重放该本机操作，请保留原标识与备份。' })
}
function download(filename: string, payload: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  try { anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}
async function exportOriginal(): Promise<void> {
  await operate(async (active, context) => {
    const original = await active.exportPending(); assertContext(context)
    if (!original) { message.value = '当前未读到原包，不证明提交或回滚。请保留本机待核对标识并核对对应本机回执。'; return }
    download('司南基金_工作区同步原包.json', { schema: 'owner-workspace-original-export-1',
      target_fingerprint: original.targetFingerprint, request_id: original.requestId,
      request_hash: original.requestHash, preparation_hash: original.preparationHash, raw_body: original.rawBody, state: original.state })
  })
}
function exportLocalReceipt(): void {
  const uncertain = status.value?.uncertainLocal, context = { epoch, generation: ownerSessionGeneration.value }
  try { assertContext(context); if (!uncertain) return
    download('司南基金_本机待核对标识.json', { schema: 'owner-workspace-local-uncertain-1',
      operation: uncertain.operation, id: uncertain.id, hash: uncertain.hash })
  } catch { message.value = '待核对标识导出未完成，原标识仍由本机工作区保留。' }
}
</script>

<template>
  <div class="managed-sync" aria-label="本机工作区私人同步">
    <p class="managed-note">分别核对上次同步基线、本机变更与本次云端完整快照（来源记为 B / L / D）。每一批先展示，再由你单独确认；新拉取的快照不会改写本机变更的原始依据。</p>
    <p>不上传或导入手工资产；完整基线仍保留手工资产及删除历史。0 是真实零值，null 是未知，删除记录不会凭空丢弃。</p>
    <p>同步账本序号不是持仓或决策的业务确认；所有本机记录仍待业务确认，不解除行动门禁。</p>
    <p v-if="store.localSyncFormat !== 'v4'" class="managed-notice" role="status">旧同步流程不能处理当前工作区。请先在“本机工作区”导出完整备份并显式升级 v4；本面板不会自动迁移。</p>
    <p v-if="!authenticated" class="managed-notice" role="status">请先登录具有私人数据读写权限的会话。登录不代表同意同步。</p>
    <label class="managed-check"><input type="checkbox" name="owner-managed-consent" :checked="consent" :disabled="!authenticated || store.localSyncFormat !== 'v4'" @change="consent = checked($event)" /><span>我同意本轮打开工作区私人同步，所有本机应用和原包发送仍须另行确认。</span></label>
    <button v-if="!enabled" type="button" class="managed-button managed-primary" :disabled="!authenticated || !consent || busy || store.localSyncFormat !== 'v4'" @click="enable">启用工作区本轮核对</button>
    <p v-if="message" class="managed-error" role="alert">{{ message }}</p>
    <div v-if="privateVisible" class="managed-private">
      <p class="managed-state" role="status" aria-live="polite">{{ stateLabel }}</p>
      <p v-if="image" class="managed-meta">上次同步基线序号：{{ image.sync.base?.pulledRevision ?? '未建立' }}；本机版本 {{ image.local.snapshot.localVersion }}。这里只标识同步来源，不是持仓决策版本。</p>
      <section v-if="localUnknown" class="managed-notice" aria-label="本机提交结果待核对">
        <p>只核对这个原标识，不重新应用、制包或发送。关闭及重新打开仍保留它。</p>
        <dl><dt>操作</dt><dd>{{ status?.uncertainLocal?.operation }}</dd><dt>原本机标识</dt><dd><code>{{ status?.uncertainLocal?.id }}</code></dd><dt>原 SHA256</dt><dd><code>{{ status?.uncertainLocal?.hash }}</code></dd></dl>
        <button class="managed-button" type="button" :disabled="busy" @click="reconcileLocal">手动核对原本机回执</button>
        <button class="managed-button" type="button" :disabled="busy" @click="exportLocalReceipt">导出本机待核对标识</button>
        <button class="managed-button" type="button" :disabled="busy" @click="exportOriginal">导出原包、哈希与状态</button>
      </section>
      <template v-else>
        <div v-if="!unknown && (!slot || resolved)" class="managed-actions">
          <button class="managed-button" type="button" :disabled="busy" @click="pull">完整拉取云端截止快照</button>
          <button v-if="!image?.sync.base && !slot" class="managed-button" type="button" :disabled="busy || !status?.completeReady" @click="previewLink">预览建立同步基线</button>
          <button v-if="image?.sync.base && !slot" class="managed-button" type="button" :disabled="busy" @click="previewPreparation">预览本机变更提交</button>
          <button v-if="resolved" class="managed-button" type="button" :disabled="busy || !status?.completeReady || !status?.resultReady" @click="previewAck">{{ acknowledgement ? '重新核对冲突选择' : '预览完整核对与应用' }}</button>
        </div>
        <section v-if="link" class="managed-preview" aria-label="共同基线完整预览">
          <h3>建立同步基线 · 全部账户核对</h3>
          <p>本次云端完整快照截止序号 {{ link.preview.base.pulledRevision }}，{{ link.preview.base.records.length }} 条记录；仅云端基金可加入本机，本机独有记录保留。同一账户有任何差异时整批不应用。云端新增记录的原始本机时间为 null（未知），不会拿拉取时间补造。</p>
          <ul v-if="link.preview.issues.length" class="managed-error" role="alert"><li v-for="(issue, index) in link.preview.issues" :key="index">{{ issue.key ?? '整批' }} · {{ issue.code }}</li></ul>
          <article v-for="row in linkRows" :key="row.key" class="managed-row"><h4>{{ row.key }}</h4><div class="managed-ledger"><div><b>当前本机</b><pre>{{ recordText(row.before) }}</pre></div><div><b>本次云端完整快照</b><pre>{{ recordText(row.cloud) }}</pre></div><div><b>应用后本机</b><pre>{{ recordText(row.after) }}</pre></div></div></article>
          <label class="managed-check"><input type="checkbox" name="owner-managed-link" :checked="linkConsent" :disabled="busy || !!link.preview.issues.length" @change="linkConsent = checked($event)" /><span>我已检查全部账户，同意建立这份完整同步基线并应用已列明的云端独有基金。</span></label>
          <button class="managed-button managed-primary" type="button" :disabled="busy || !linkConsent || !!link.preview.issues.length" @click="commitLink">确认建立同步基线</button>
        </section>
        <section v-if="preparation" class="managed-preview" aria-label="B到L完整制包预览">
          <h3>本机变更 · 逐账户准备提交</h3><p>原同步基线序号 {{ preparation.packet.request.expected_revision }}；{{ preparation.packet.request.operations.length }} 条操作。此步骤只在本机保存完整提交，不发送。</p>
          <article v-for="operation in preparation.packet.request.operations" :key="operation.key" class="managed-row" :class="{ 'managed-deleted': operation.deleted }"><h4>{{ operation.key }} · {{ operation.deleted ? '删除（保留历史）' : operation.kind === 'holding' ? '持仓' : '仅关注' }}</h4><div class="managed-ledger"><div><b>上次同步时的值</b><pre>{{ valuesText(operation.base_values) }}</pre></div><div><b>本机变更</b><pre>{{ operation.deleted ? '删除，不携带新金融值' : valuesText(operation.changes) }}</pre></div></div></article>
          <label class="managed-check"><input type="checkbox" name="owner-managed-prepare" :checked="prepareConsent" :disabled="busy" @change="prepareConsent = checked($event)" /><span>我已检查每个账户、字段与删除项，只保存这一批原包，暂不发送。</span></label>
          <button class="managed-button managed-primary" type="button" :disabled="busy || !prepareConsent" @click="commitPreparation">确认保存这一批提交</button>
        </section>
        <section v-if="slot && pending" class="managed-preview" aria-label="保留的工作区原始提交">
          <h3>原始提交保留 · {{ stateNames[slot.state] }}</h3><details><summary>查看原请求标识与校验信息</summary><dl><dt>请求标识</dt><dd><code>{{ pending.requestId }}</code></dd><dt>原包 SHA256</dt><dd><code>{{ pending.requestHash }}</code></dd><dt>本机准备校验 SHA256</dt><dd><code>{{ pending.preparationHash }}</code></dd><dt>端点指纹（非数据库身份）</dt><dd><code>{{ image?.sync.targetFingerprint }}</code></dd></dl></details>
          <details><summary>查看原始请求文本</summary><pre>{{ pending.rawBody }}</pre></details>
          <p v-if="unknown" class="managed-notice">结果未知，不代表未提交。这里只核对原回执、导出或关闭；不重发、不清除原提交、不自动重新准备。</p>
          <template v-if="slot.state === 'prepared'">
            <article v-for="operation in packetOperations" :key="operation.key" class="managed-row" :class="{ 'managed-deleted': operation.deleted }"><h4>{{ operation.key }} · {{ operation.deleted ? '删除（保留历史）' : operation.kind === 'holding' ? '持仓' : '仅关注' }}</h4><pre>共同基线守卫：{{ valuesText(operation.base_values) }}
本机改动：{{ operation.deleted ? '删除，不携带新金融值' : valuesText(operation.changes) }}</pre></article>
            <p v-if="!packetOperations" class="managed-error">原包不能完整展示，禁止发送；请保留原包并检查本机存储。</p>
            <label class="managed-check"><input type="checkbox" name="owner-managed-send" :checked="sendConsent" :disabled="busy || !packetOperations" @change="sendConsent = checked($event)" /><span>我已核对上述提交全部账户与删除项，仅发送这份原始提交一次。</span></label>
            <button class="managed-button managed-primary" type="button" :disabled="busy || !sendConsent || !packetOperations" @click="send">单次发送这份提交</button>
            <label class="managed-check"><input type="checkbox" name="owner-managed-cancel" :checked="cancelConsent" :disabled="busy" @change="cancelConsent = checked($event)" /><span>取消这个尚未发送的原包，保留本机副本与共同基线，不自动制包。</span></label>
            <button class="managed-button" type="button" :disabled="busy || !cancelConsent" @click="cancel">取消尚未发送的提交</button>
          </template>
          <button v-else class="managed-button" type="button" :disabled="busy" @click="reconcile">核对原请求回执</button>
          <p v-if="resolved">{{ status?.resultReady ? '原回执已匹配，仍须拉取完整云端快照、检查全部变更并确认应用。' : '本机状态不是本轮回执证明；请先手动核对原请求回执。' }}</p>
          <button class="managed-button" type="button" :disabled="busy" @click="exportOriginal">导出原包、哈希与状态</button>
        </section>
        <section v-if="acknowledgement" class="managed-preview" aria-label="完整三方冲突与应用预览">
          <h3>本机与云端 · 完整核对后应用</h3><p>本次云端完整快照截止序号 {{ acknowledgement.preview.baseD?.pulledRevision }}；不会把单批回执的部分记录当成完整快照。{{ acknowledgement.preview.outcome === 'success' ? '本批已确认：已提交变更不再重复保留，依据本次完整快照核对其他变化。' : '本批存在冲突，本机变更未提交；不同字段可合并，同一字段或记录身份变化须逐项选择。' }}</p>
          <article v-for="conflict in acknowledgement.preview.conflicts" :key="selectionKey(conflict.key, conflict.field)" class="managed-row managed-conflict"><h4>{{ conflict.key }} · {{ fieldNames[conflict.field] }}</h4><p>{{ reasonNames[conflict.reason] }}</p><p v-if="conflict.groupKeys.length > 1">整组账户：{{ conflict.groupKeys.join('、') }}，不得半组应用。</p><div class="managed-ledger"><div><b>上次同步基线</b><pre>{{ recordText(conflict.base) }}</pre></div><div><b>本机变更</b><pre>{{ recordText(conflict.local) }}</pre></div><div><b>本次云端完整快照</b><pre>{{ recordText(conflict.cloud) }}</pre></div></div>
            <fieldset :disabled="busy"><legend>{{ conflict.key }} · 明确选择{{ fieldNames[conflict.field] }}</legend><label><input type="radio" :name="'owner-managed-choice-' + selectionKey(conflict.key, conflict.field)" value="local" :checked="selections[selectionKey(conflict.key, conflict.field)] === 'local'" :disabled="!conflict.localAllowed" @change="select(conflict.key, conflict.field, 'local')" />保留本机意图</label><label><input type="radio" :name="'owner-managed-choice-' + selectionKey(conflict.key, conflict.field)" value="cloud" :checked="selections[selectionKey(conflict.key, conflict.field)] === 'cloud'" @change="select(conflict.key, conflict.field, 'cloud')" />采用云端</label></fieldset><p v-if="!conflict.localAllowed" class="managed-error">云端已删除，禁止用旧本机记录复活；只能采用云端。</p>
          </article>
          <p v-if="!acknowledgement.request" class="managed-notice">尚无可应用的完整计划。选择全部冲突后点击“重新核对冲突选择”，再检查完整变更。</p>
          <article v-for="row in acknowledgement.preview.rows" :key="row.key" class="managed-row" :class="{ 'managed-deleted': row.after?.deleted }"><h4>{{ row.key }} · 变更：{{ row.fields.map(field => fieldNames[field]).join('、') || '仅待确认标记' }}</h4><p v-if="row.before?.deleted && row.after && !row.after.deleted" class="managed-notice">完整云端含显式重新建立的记录，请核对全部新值。</p><div class="managed-ledger"><div><b>本机应用前</b><pre>{{ recordText(row.before) }}</pre></div><div><b>本机应用后</b><pre>{{ recordText(row.after) }}</pre></div></div></article>
          <p v-if="acknowledgement.request && !acknowledgement.preview.rows.length">本机内容无变化；仍需确认本次完整快照与原回执，不能直接清除原提交。</p>
          <label class="managed-check"><input type="checkbox" name="owner-managed-ack" :checked="ackConsent" :disabled="busy || !acknowledgement.request" @change="ackConsent = checked($event)" /><span>我已检查全部变更与冲突选择，同意在本机应用完整核对结果、保存回执并清除这份原提交。全部记录仍待业务确认。</span></label>
          <button class="managed-button managed-primary" type="button" :disabled="busy || !ackConsent || !acknowledgement.request" @click="commitAck">确认应用完整核对结果</button>
        </section>
        <details v-if="manualRows.length" class="managed-manual"><summary>共同基线保留 {{ manualRows.length }} 条手工资产 / 删除历史（不导入本机）</summary><article v-for="row in manualRows" :key="row.key"><h4>{{ row.key }}</h4><pre>{{ recordText(row) }}</pre></article></details>
      </template>
    </div>
    <button type="button" class="managed-button managed-close" @click="hide(true)">关闭并隐藏工作区同步</button>
  </div>
</template>

<style scoped>
.managed-sync { padding: 0 16px 16px; border-top: 1px solid var(--border); color: var(--ink); font: 12px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
.managed-sync p { margin: 10px 0; }.managed-note, .managed-notice { padding: 10px 12px; border-left: 2px solid var(--gold); background: var(--gold-soft); }.managed-note { font-family: var(--font-display, SimSun, serif); font-size: 13px; }.managed-state { color: var(--teal); font-weight: 700; }.managed-meta { color: var(--text-muted); }.managed-error { color: var(--danger); overflow-wrap: anywhere; }
.managed-sync h3 { margin: 16px 0 8px; font: 700 15px/1.5 var(--font-display, SimSun, serif); }.managed-sync h4 { margin: 0 0 8px; font-size: 12px; overflow-wrap: anywhere; }
.managed-button { min-height: 40px; padding: 9px 12px; margin: 6px 8px 6px 0; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); color: var(--teal); background: var(--card-bg); font: inherit; cursor: pointer; }.managed-primary { color: var(--card-bg); background: var(--teal); border-color: var(--teal); }.managed-button:disabled { opacity: .5; cursor: not-allowed; }.managed-button:focus-visible, .managed-check input:focus-visible, fieldset input:focus-visible, summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.managed-check { display: flex; align-items: flex-start; gap: 10px; margin: 14px 0; cursor: pointer; }.managed-check input, fieldset input { flex: 0 0 auto; width: 18px; height: 18px; margin: 2px 4px 0 0; accent-color: var(--teal); }.managed-actions { display: flex; flex-wrap: wrap; gap: 0; }
.managed-preview { margin-top: 16px; padding-top: 6px; border-top: 1px solid var(--border); }.managed-row { padding: 12px; margin: 12px 0; border: 1px solid var(--border); border-radius: var(--radius-sm); }.managed-deleted, .managed-conflict { border-left: 3px solid var(--danger); }
.managed-ledger { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 12px; }.managed-ledger > div { min-width: 0; }.managed-ledger b { display: block; padding-bottom: 6px; color: var(--text-muted); font-size: 11px; border-bottom: 1px solid var(--border); }.managed-sync pre { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.8 var(--font-mono, monospace); }.managed-sync dl { display: grid; grid-template-columns: minmax(80px, 1fr) minmax(0, 3fr); gap: 5px 10px; }.managed-sync dt { color: var(--text-muted); }.managed-sync dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }.managed-sync code { font: 10px/1.8 var(--font-mono, monospace); overflow-wrap: anywhere; }.managed-sync summary { padding: 10px 0; cursor: pointer; }.managed-sync fieldset { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 0; margin: 8px 0 0; border: 0; }.managed-sync fieldset legend { font-weight: 600; }.managed-sync fieldset label { display: flex; align-items: center; min-height: 40px; gap: 5px; cursor: pointer; }.managed-manual article { border-top: 1px solid var(--border); padding: 10px 0; }.managed-close { margin-top: 14px; }
@media (max-width: 480px) { .managed-button { min-height: 44px; }.managed-actions > .managed-button { width: 100%; }.managed-sync dl { grid-template-columns: 1fr; gap: 2px; }.managed-sync dd { margin-bottom: 7px; }.managed-check { min-height: 44px; } }
</style>
