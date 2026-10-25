<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useWatchlistStore, type OwnerFullSyncPacketFacade } from '@/stores/watchlist'
import { ownerSession, ownerSessionGeneration, hasOwnerSession } from '@/stores/ownerSession'
import type { OwnerPortfolioAckField, OwnerPortfolioAckResolution } from '@/utils/owner-portfolio-ack'
import type { OwnerSyncOperation } from '@/utils/ownerSyncContract'

type Facade = OwnerFullSyncPacketFacade
type Preparation = Awaited<ReturnType<Facade['previewPreparation']>>
type Acknowledgement = Awaited<ReturnType<Facade['previewAcknowledgement']>>
const store = useWatchlistStore()
const consent = ref(false), enabled = ref(false), busy = ref(false), message = ref('')
const prepareConsent = ref(false), sendConsent = ref(false), cancelConsent = ref(false), ackConsent = ref(false)
const facade = shallowRef<Facade | null>(null), image = shallowRef<ReturnType<Facade['getState']>>(null)
const status = shallowRef<ReturnType<Facade['status']> | null>(null)
const preparation = shallowRef<Preparation | null>(null), acknowledgement = shallowRef<Acknowledgement | null>(null)
const selections = ref<Record<string, 'local' | 'cloud'>>({})
let alive = true, epoch = 0, ackId = ''
const authenticated = computed(() => !!ownerSession.value?.scopes.includes('read_private') && !!ownerSession.value?.scopes.includes('write_holdings'))
const visible = computed(() => enabled.value && consent.value && authenticated.value && store.localSyncFormat === 'v6')
const slot = computed(() => image.value?.local.outbox.entry ?? null), pending = computed(() => image.value?.fullSync.pending ?? null)
const localUnknown = computed(() => !!store.fullSyncLocalPending || status.value?.state === 'local_unknown')
const unknown = computed(() => ['attempted', 'unknown'].includes(slot.value?.state ?? ''))
const resolved = computed(() => ['confirmed', 'conflict'].includes(slot.value?.state ?? ''))
const operations = computed<readonly OwnerSyncOperation[] | null>(() => {
  try { const value = pending.value ? JSON.parse(pending.value.rawBody).operations : null; return Array.isArray(value) && value.length ? value : null }
  catch { return null }
})
const fields: Record<string, string> = { name: '名称', cls: '类别', value: '金额', note: '备注', shares: '份额', cost: '成本',
  target_weight: '目标权重', kind: '类型', deleted: '删除', lifecycle: '生命周期', rename: '账户更名整组' }
const states: Record<string, string> = { prepared: '原包已保存，尚未发送', attempted: '结果未知，原包保留', unknown: '结果未知，原包保留',
  confirmed: '原回执已匹配，仍须完整核对', conflict: '原请求冲突，仍须三方核对' }
const reasonNames: Record<string, string> = { field_changed: '同字段两侧变化', field_aba: '字段曾变后恢复', lifecycle_changed: '类型或删除冲突',
  lifecycle_aba: '生命周期曾变后恢复', creation_collision: '新身份冲突', server_conflict: '服务端原请求冲突', cloud_tombstone: '云端墓碑禁止复活', rename_atomic: '账户更名须整组选择' }
const id = () => 'portfolio-packet-ui-' + crypto.randomUUID()
const keyFor = (key: string, field: OwnerPortfolioAckField) => JSON.stringify([key, field])
function valueText(value: unknown): string { return value === null ? 'null（未知）' : value === undefined ? '无' : Object.is(value, -0) ? '-0' : String(value) }
function valuesText(input: unknown): string {
  if (!input || typeof input !== 'object') return '无'
  const row = input as Record<string, unknown>
  return 'values' in row ? `${row.deleted ? '已删除' : '未删除'} · ${valuesText(row.values)}`
    : Object.entries(row).map(([key, value]) => `${fields[key] ?? key}：${valueText(value)}`).join('；')
}
function resetChecks() { prepareConsent.value = false; sendConsent.value = false; cancelConsent.value = false; ackConsent.value = false }
function clearPreviews() { preparation.value = null; acknowledgement.value = null; selections.value = {}; ackId = ''; resetChecks() }
function refresh() { status.value = facade.value?.status() ?? null; image.value = facade.value?.getState() ?? null }
function clearVisible() { epoch++; consent.value = false; enabled.value = false; busy.value = false; facade.value = null; image.value = null; status.value = null; clearPreviews() }
function hide() { store.disableFullSync(); clearVisible() }
watch(ownerSessionGeneration, clearVisible, { flush: 'sync' })
watch(() => store.fullSyncViewEpoch, clearVisible, { flush: 'sync' })
watch(() => store.ownerAnalysisEpoch, clearPreviews, { flush: 'sync' })
onBeforeUnmount(() => { alive = false; hide() })
function assertUI(context: number) {
  if (!alive || context !== epoch || !visible.value || !hasOwnerSession()) throw new Error('packet_panel_context_changed')
}
async function enable() {
  if (!consent.value || !authenticated.value || busy.value) return
  const context = epoch; busy.value = true
  try { const active = await store.enableFullSyncPackets(true); if (!alive || context !== epoch || !consent.value) return
    facade.value = active; enabled.value = true; refresh(); message.value = '完整原包核对已启用；没有自动发送。' }
  catch { if (alive && context === epoch) message.value = '本轮完整原包核对未启用；保留原包与原本机标识，不重放。' }
  finally { if (alive && context === epoch) busy.value = false }
}
async function operate(work: (active: Facade, ensure: () => void) => Promise<void>) {
  if (!visible.value || !facade.value || busy.value) return
  const context = epoch, active = facade.value; busy.value = true; message.value = ''; resetChecks()
  try { await work(active, () => assertUI(context)); assertUI(context); refresh() }
  catch { if (alive && context === epoch) { clearPreviews(); refresh(); message.value = '操作未完成或上下文变化。原包/原本机标识保留，不重放；先核对原回执或重新启用后读取。' } }
  finally { if (alive && context === epoch) busy.value = false }
}
async function hydrate() { await operate(async active => { clearPreviews(); await active.hydrate() }) }
async function previewPrepare() { await operate(async (active, ensure) => { clearPreviews(); const value = await active.previewPreparation(id()); ensure(); preparation.value = value }) }
async function commitPrepare() {
  if (!preparation.value || !prepareConsent.value) return
  const request = preparation.value; await operate(async active => { await active.commitPreparation(request, true); clearPreviews() })
}
async function send() { if (sendConsent.value && slot.value?.state === 'prepared' && operations.value) await operate(async active => { clearPreviews(); await active.sendOnce() }) }
async function cancel() { if (cancelConsent.value && slot.value?.state === 'prepared') await operate(async active => { await active.cancelPrepared(id(), true); clearPreviews() }) }
async function receipt() { await operate(async active => { clearPreviews(); await active.reconcileReceipt() }) }
async function pull() { await operate(async active => { clearPreviews(); await active.pullComplete() }) }
async function previewAck() {
  await operate(async (active, ensure) => {
    ackId ||= id()
    const choices: OwnerPortfolioAckResolution[] = (acknowledgement.value?.preview.conflicts ?? []).flatMap(row => {
      const choice = selections.value[keyFor(row.key, row.field)]; return choice ? [{ key: row.key, field: row.field, choice }] : []
    })
    const value = await active.previewAcknowledgement(ackId, choices); ensure(); acknowledgement.value = value
    selections.value = Object.fromEntries(value.preview.conflicts.filter(row => row.choice !== null).map(row => [keyFor(row.key, row.field), row.choice!]))
  })
}
function select(key: string, field: OwnerPortfolioAckField, choice: 'local' | 'cloud') {
  if (!acknowledgement.value || busy.value) return
  selections.value = { ...selections.value, [keyFor(key, field)]: choice }; ackConsent.value = false
  acknowledgement.value = { preview: acknowledgement.value.preview, request: null }
}
async function commitAck() {
  if (!acknowledgement.value?.request || !ackConsent.value) return
  const request = acknowledgement.value.request
  await operate(async active => { await active.commitAcknowledgement(request, true); clearPreviews(); message.value = '完整核对已在本机应用并清除这份原包；local_pending 仍保留，不是 HoldingVersion 或金融行动资格。' })
}
function download(raw: string, filename: string) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a')
  try { anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}
async function exportPending() {
  await operate(async (active, ensure) => { const original = await active.exportPending(); ensure()
    if (!original) { message.value = '未读取到原包，不证明提交或回滚；请保留原标识手动核对。'; return }
    download(JSON.stringify({ schema: 'owner-portfolio-original-export-1', targetFingerprint: image.value?.fullSync.targetFingerprint,
      ...original }), '司南基金_完整基金手工资产原包.json') })
}
async function reconcileLocal() {
  const original = store.fullSyncLocalPending
  if (!original) return
  await operate(async active => { const result = await active.reconcileLocal(original.id, original.hash)
    if (result.state === 'unknown') message.value = '原本机回执仍未知，不重放、不重新制包。' })
}
</script>

<template>
  <section class="packet-panel" aria-label="完整基金与手工资产原包发送及核对">
    <h4>完整原包 · 单次发送 · 三方核对</h4>
    <p>这是独立于初始共同基线的本轮授权。每次保存、发送、取消与 ACK 都单独确认；同步 revision 不是持仓/策略/决策版本。分析仍暂停。</p>
    <label class="check"><input name="full-packet-consent" type="checkbox" :checked="consent" :disabled="busy || enabled || !authenticated" @change="consent = ($event.target as HTMLInputElement).checked" />我同意本轮核对完整基金、全部账户、手工资产与删除项；仅在独立确认后单次发送原包。</label>
    <button v-if="!enabled" type="button" data-action="full-packet-enable" :disabled="busy || !consent || !authenticated" @click="enable">启用完整原包核对</button>
    <template v-if="visible">
      <p role="status">{{ localUnknown ? '本机操作结果待核对，只保留原 id/hash' : slot ? states[slot.state] : '当前无原包；本机意图仍待业务确认' }}</p>
      <template v-if="localUnknown"><code>{{ store.fullSyncLocalPending?.id }}</code><code>{{ store.fullSyncLocalPending?.hash }}</code><button type="button" data-action="full-packet-local-receipt" :disabled="busy" @click="reconcileLocal">只核原本机回执</button></template>
      <template v-else>
        <button v-if="!image" type="button" data-action="full-packet-hydrate" :disabled="busy" @click="hydrate">重新读取本机原包</button>
        <button v-if="image && !slot" type="button" data-action="full-packet-prepare-preview" :disabled="busy" @click="previewPrepare">预览完整待上传意图</button>
        <section v-if="preparation" aria-label="完整基金手工资产制包预览">
          <p>{{ preparation.packet.request.operations.length }} 项操作 · {{ preparation.packet.byteLength }} 字节。只保存，不发送；0 与 null 不互换。</p>
          <article v-for="operation in preparation.packet.request.operations" :key="operation.key"><strong>{{ operation.key }} · {{ operation.kind === 'manual_asset' ? '手工资产' : operation.kind === 'holding' ? '持仓' : '仅关注' }} · {{ operation.deleted ? '删除' : '创建/字段修改' }}</strong><p>旧像守卫：{{ valuesText(operation.base_values) }}</p><p>改动：{{ valuesText(operation.changes) }}</p></article>
          <label class="check"><input name="full-packet-prepare-confirm" type="checkbox" :checked="prepareConsent" :disabled="busy" @change="prepareConsent = ($event.target as HTMLInputElement).checked" />我已核对全部字段与删除项，仅严格保存这份原包，不发送。</label>
          <button type="button" data-action="full-packet-prepare-commit" :disabled="busy || !prepareConsent" @click="commitPrepare">确认保存完整原包</button>
        </section>
        <section v-if="slot && pending" aria-label="完整原包原字节">
          <code>{{ pending.requestId }}</code><code>{{ pending.requestHash }}</code><code>{{ pending.preparationHash }}</code>
          <details><summary>查看原字节</summary><pre>{{ pending.rawBody }}</pre></details>
          <p v-if="unknown">结果未知不代表未提交。这里只核原请求回执、导出或关闭；不取消、不重制、不重发。</p>
          <template v-if="slot.state === 'prepared'">
            <article v-for="operation in operations" :key="operation.key"><strong>{{ operation.key }} · {{ operation.kind === 'manual_asset' ? '手工资产' : operation.kind === 'holding' ? '持仓' : '仅关注' }} · {{ operation.deleted ? '删除' : '创建/修改' }}</strong><p>{{ valuesText(operation.changes) }}</p><p>守卫：{{ valuesText(operation.base_values) }}</p></article>
            <p v-if="!operations" role="alert">原包不能完整展示，禁止发送。</p>
            <label class="check"><input name="full-packet-send-confirm" type="checkbox" :checked="sendConsent" :disabled="busy || !operations" @change="sendConsent = ($event.target as HTMLInputElement).checked" />我已检查这份原包全部操作，仅发送原字节一次。</label>
            <button type="button" data-action="full-packet-send" :disabled="busy || !sendConsent || !operations" @click="send">单次发送完整原包</button>
            <label class="check"><input name="full-packet-cancel-confirm" type="checkbox" :checked="cancelConsent" :disabled="busy" @change="cancelConsent = ($event.target as HTMLInputElement).checked" />仅取消尚未发送的原包，保留本机意图与基线。</label>
            <button type="button" data-action="full-packet-cancel" :disabled="busy || !cancelConsent" @click="cancel">取消尚未发送的原包</button>
          </template>
          <button v-else type="button" data-action="full-packet-receipt" :disabled="busy" @click="receipt">核对原请求回执</button>
          <button type="button" data-action="full-packet-export" :disabled="busy" @click="exportPending">导出原包与状态</button>
          <template v-if="resolved">
            <p>{{ status?.resultReady ? '当前会话原回执已匹配，仍须完整固定截止 D。' : '当前本机槽不是当前会话回执证明；先核原回执。' }}</p>
            <button type="button" data-action="full-packet-pull" :disabled="busy || !status?.resultReady" @click="pull">拉取完整固定截止对照 D</button>
            <button type="button" data-action="full-packet-ack-preview" :disabled="busy || !status?.resultReady || !status?.completeReady" @click="previewAck">{{ acknowledgement ? '按当前选择重新预览 ACK' : '预览完整三方 ACK' }}</button>
          </template>
        </section>
        <section v-if="acknowledgement" aria-label="完整基金手工资产三方ACK预览">
          <p>完整 D 截止 {{ acknowledgement.preview.baseD?.pulledRevision }}；{{ acknowledgement.preview.outcome === 'success' ? '原请求成功' : '原请求冲突' }}。原 POST 的部分记录不冒充完整 D。</p>
          <ul v-if="acknowledgement.preview.issues.length" role="alert"><li v-for="(issue, at) in acknowledgement.preview.issues" :key="at">{{ issue.code }} · {{ issue.key }}</li></ul>
          <article v-for="conflict in acknowledgement.preview.conflicts" :key="keyFor(conflict.key, conflict.field)"><strong>{{ conflict.key }} · {{ fields[conflict.field] }}</strong><p>{{ reasonNames[conflict.reason] }}</p><p v-if="conflict.groupKeys.length > 1">整组：{{ conflict.groupKeys.join(' / ') }}</p><p>B：{{ valuesText(conflict.base) }}</p><p>L：{{ valuesText(conflict.local) }}</p><p>D：{{ valuesText(conflict.cloud) }}</p>
            <label class="check"><input type="radio" :name="keyFor(conflict.key, conflict.field)" :checked="selections[keyFor(conflict.key, conflict.field)] === 'local'" :disabled="busy || !conflict.localAllowed" @change="select(conflict.key, conflict.field, 'local')" />保留本机意图{{ conflict.localAllowed ? '' : '（墓碑等规则禁止）' }}</label>
            <label class="check"><input type="radio" :name="keyFor(conflict.key, conflict.field)" :checked="selections[keyFor(conflict.key, conflict.field)] === 'cloud'" :disabled="busy" @change="select(conflict.key, conflict.field, 'cloud')" />采用完整 D</label>
          </article>
          <article v-for="row in acknowledgement.preview.rows" :key="row.key"><strong>{{ row.key }} · {{ row.fields.map(field => fields[field]).join(' / ') }}</strong><p>应用前：{{ valuesText(row.before) }}</p><p>应用后：{{ valuesText(row.after) }}</p></article>
          <label class="check"><input name="full-packet-ack-confirm" type="checkbox" :checked="ackConsent" :disabled="busy || !acknowledgement.request" @change="ackConsent = ($event.target as HTMLInputElement).checked" />我已核对全部冲突、整组更名和所有应用行，严格同时更新本机 L/B 并清除这份原包；仍保留本机待业务确认。</label>
          <button type="button" data-action="full-packet-ack-commit" :disabled="busy || !ackConsent || !acknowledgement.request" @click="commitAck">确认应用完整 ACK</button>
        </section>
      </template>
    </template>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
    <button v-if="enabled" type="button" data-action="full-packet-close" @click="hide">关闭并隐藏完整同步</button>
  </section>
</template>

<style scoped>
.packet-panel { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 12px; font-size: 12px; line-height: 1.8; }
h4 { color: var(--text); font-size: 14px; }p,code,strong,li,pre { overflow-wrap: anywhere; }code { display: block; }pre { white-space: pre-wrap; }
article { border-top: 1px solid var(--border); padding: 12px 0; }label.check { display: flex; align-items: flex-start; gap: 9px; margin: 12px 0; }.check input { width: 18px; height: 18px; flex-shrink: 0; }
button { margin: 4px 6px 4px 0; padding: 9px 12px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--card-bg); cursor: pointer; }button:disabled { opacity: .45; cursor: not-allowed; }button:focus-visible,input:focus-visible,summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }[role="status"],[role="alert"] { padding: 10px; background: color-mix(in srgb, var(--teal) 8%, var(--card-bg)); }summary { cursor: pointer; }
</style>
