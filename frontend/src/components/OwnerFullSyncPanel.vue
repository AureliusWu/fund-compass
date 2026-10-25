<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useWatchlistStore, type OwnerFullSyncFacade } from '@/stores/watchlist'
import { hasOwnerSession, ownerSession, ownerSessionGeneration } from '@/stores/ownerSession'
import { OWNER_WORKSPACE_BACKUP_MAX_BYTES } from '@/utils/owner-workspace-backup'
import type { OwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import type { FullSyncInitialPreview } from '@/stores/owner-workspace-full-sync-managed'
import type { OwnerPortfolioInitialMergeField, OwnerPortfolioInitialMergeResolution } from '@/utils/owner-portfolio-merge'

const store = useWatchlistStore()
const OwnerFullSyncPacketPanel = defineAsyncComponent(() => import('./OwnerFullSyncPacketPanel.vue'))
const busy = ref(false), message = ref(''), sha = ref(''), exportedSha = ref(''), verifiedSha = ref('')
const formatConsent = ref(false), reconcileConsent = ref(false), consent = ref(false), enabled = ref(false), linkConsent = ref(false)
const selected = shallowRef<{ raw: string; backup: OwnerPortfolioRecoveryBackup } | null>(null)
const facade = shallowRef<OwnerFullSyncFacade | null>(null), status = shallowRef<ReturnType<OwnerFullSyncFacade['status']> | null>(null)
const view = shallowRef<FullSyncInitialPreview | null>(null), pullResult = shallowRef<{ revision: number; records: number } | null>(null)
const choices = ref<Record<string, 'local' | 'cloud'>>({})
let alive = true, epoch = 0, readController: AbortController | null = null
const formatReady = computed(() => store.authorityState === 'idb' && !store.localStorageError && store.localSyncFormat === 'v5')
const isSix = computed(() => store.authorityState === 'idb' && store.localSyncFormat === 'v6')
const authenticated = computed(() => !!ownerSession.value?.scopes.includes('read_private') && !!ownerSession.value?.scopes.includes('write_holdings'))
const privateVisible = computed(() => enabled.value && consent.value && authenticated.value && isSix.value)
const canUpgrade = computed(() => formatReady.value && !busy.value && formatConsent.value && selected.value !== null
  && verifiedSha.value !== '' && verifiedSha.value === exportedSha.value)
const canReconcile = computed(() => !busy.value && reconcileConsent.value && selected.value !== null && ['idb', 'blocked'].includes(store.authorityState))
const fieldNames: Record<string, string> = { name: '名称', shares: '份额', cost: '成本', target_weight: '目标权重',
  cls: '类别', value: '金额', note: '备注', lifecycle: '类型与删除状态', rename: '账户更名整组', kind: '类型', deleted: '删除状态' }
const reasonNames: Record<string, string> = { field_changed: '同一字段两侧改动', field_aba: '字段曾改后恢复', lifecycle_changed: '类型或删除冲突',
  lifecycle_aba: '生命周期曾改后恢复', creation_collision: '新记录身份重合', cloud_tombstone: '云端墓碑，不允许复活',
  rename_atomic: '旧账户与新账户必须整组选择', bootstrap_difference: '手工资产首次协调，两侧不同，不能沿用旧基金基线' }
const keyFor = (key: string, field: OwnerPortfolioInitialMergeField) => JSON.stringify([key, field])
function valueText(value: unknown): string { return value === null ? 'null（未知）' : value === undefined ? '无' : Object.is(value, -0) ? '-0' : String(value) }
function valuesText(value: unknown): string {
  if (!value || typeof value !== 'object') return '无此记录'
  const row = value as Record<string, unknown>
  if ('values' in row) return `${row.deleted ? '已删除' : '未删除'} · ${valuesText(row.values)}`
  return Object.entries(row).map(([field, item]) => `${fieldNames[field] ?? field}：${valueText(item)}`).join('；')
}
function refresh() { status.value = facade.value?.status() ?? null }
function invalidatePreview() { view.value = null; pullResult.value = null; choices.value = {}; linkConsent.value = false; refresh() }
function clearVisible() {
  epoch++; enabled.value = false; consent.value = false; busy.value = false
  facade.value = null; status.value = null; invalidatePreview()
}
function hide() { store.disableFullSync(); clearVisible() }
function invalidateFile() { epoch++; readController?.abort(); readController = null; selected.value = null; verifiedSha.value = ''; formatConsent.value = false; reconcileConsent.value = false }
watch(ownerSessionGeneration, hide, { flush: 'sync' })
watch(() => store.fullSyncViewEpoch, clearVisible, { flush: 'sync' })
watch(() => [store.authorityState, store.localSyncFormat], () => { hide(); invalidateFile(); exportedSha.value = '' }, { flush: 'sync' })
watch(() => store.ownerAnalysisEpoch, invalidatePreview, { flush: 'sync' })
onBeforeUnmount(() => { alive = false; hide(); invalidateFile() })
const current = (value: number) => alive && value === epoch
function download(raw: string, hash: string, currentBackup = false) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a')
  try { anchor.href = url; anchor.download = `司南基金_${currentBackup ? 'v6当前完整工作区' : 'v6升级前完整v5'}_${hash.slice(0, 16)}.json`; document.body.appendChild(anchor); anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}
async function exportFormat() {
  if (busy.value || !formatReady.value) return
  invalidateFile(); exportedSha.value = ''; message.value = ''; busy.value = true
  const context = epoch
  try {
    const built = await store.createFullSyncUpgradeBackup()
    if (!current(context)) return
    download(built.raw, built.sha256); sha.value = built.sha256; exportedSha.value = built.sha256
    message.value = '已发起完整 v5 原文件下载。请保留并选回同一文件，再单独确认 v6 升级；没有读取或上传云端。'
  } catch { if (current(context)) message.value = '完整原文件导出未完成，不能升级；请保留当前数据库和旧文件。' }
  finally { if (current(context)) busy.value = false }
}
async function read(file: File, signal: AbortSignal) {
  const reader = file.stream().getReader(), chunks: Uint8Array[] = []
  let size = 0, done = false
  const cancel = () => { void reader.cancel().catch(() => {}) }; signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new Error('read_aborted')
      const chunk = await reader.read(); if (signal.aborted) throw new Error('read_aborted'); if (chunk.done) break
      size += chunk.value.byteLength; if (size > file.size || size > OWNER_WORKSPACE_BACKUP_MAX_BYTES) throw new Error('read_size')
      chunks.push(chunk.value)
    }
    if (size !== file.size) throw new Error('read_size')
    const bytes = new Uint8Array(size); let at = 0
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); done = true; return raw
  } finally { if (!done) cancel(); signal.removeEventListener('abort', cancel); reader.releaseLock() }
}
function changeSha(event: Event) { invalidateFile(); sha.value = (event.target as HTMLInputElement).value.trim(); message.value = '' }
async function choose(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''; invalidateFile(); message.value = ''
  if (!file) return
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > OWNER_WORKSPACE_BACKUP_MAX_BYTES || !/^[0-9a-f]{64}$/.test(sha.value)) {
    message.value = '请选择上限内的完整原文件，并填写完整 SHA256；没有读取超限文件。'; return
  }
  const context = epoch, hash = sha.value, controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000)
  readController = controller; busy.value = true
  try {
    const raw = await read(file, controller.signal)
    if (!current(context) || controller.signal.aborted) return
    const backup = await store.previewFullSyncUpgrade(raw, hash)
    if (!current(context) || controller.signal.aborted) return
    selected.value = { raw, backup }; verifiedSha.value = hash
    message.value = '完整原文件已核对。请确认数量与目标后独立确认；只是本机格式升级，不启用上传。'
  } catch { if (current(context)) message.value = '原文件核对失败或已中断；请保留原字节和原摘要，不重建或覆盖数据库。' }
  finally { clearTimeout(timer); if (current(context)) { readController = null; busy.value = false } }
}
async function format(reconcile = false) {
  if (!(reconcile ? canReconcile.value : canUpgrade.value) || !selected.value) return
  busy.value = true; const original = selected.value, hash = verifiedSha.value
  try {
    await (reconcile ? store.reconcileFullSyncUpgrade : store.upgradeFullSyncFormat)(original.raw, hash, true)
    if (alive) message.value = reconcile ? '原 v6 升级已手动核定；没有覆盖后续编辑或重建丢失数据库。'
      : '已升级本机 v6。完整共同基线尚未协调；没有上传，也不是云端确认。'
  } catch { if (alive) message.value = '升级结果仍待核对。只保留原文件、原 id/hash 手动核对；不要重导、重放或删库。' }
  finally { if (alive) busy.value = false }
}
async function enable() {
  if (!isSix.value || !consent.value || !authenticated.value || busy.value || !hasOwnerSession()) return
  busy.value = true; const context = epoch
  try { const value = await store.enableFullSync(true); if (!current(context)) return; facade.value = value; enabled.value = true; refresh(); message.value = '本轮读取已启用，尚未发出网络请求。' }
  catch { if (current(context)) message.value = '本轮读取未启用，请核对会话、目标和当前本机工作区。' }
  finally { if (current(context)) busy.value = false }
}
async function work(action: (ensure: () => void) => Promise<void>) {
  if (!privateVisible.value || busy.value) return
  const context = epoch; busy.value = true; message.value = ''
  const ensure = () => { if (!current(context) || !privateVisible.value) throw new Error('private_view_changed') }
  try { await action(ensure); ensure() }
  catch { if (current(context)) { view.value = null; linkConsent.value = false; message.value = '本次核对未完成或上下文已改变。部分分页不作为共同基线；未知本机写只核原回执，不重放。' } }
  finally { if (current(context)) { busy.value = false; refresh() } }
}
async function pull() { await work(async ensure => { invalidatePreview(); const result = await facade.value!.pullComplete(); ensure(); pullResult.value = result; message.value = '完整固定截止对照已读取；尚未修改本机或云端。请继续预览。' }) }
async function preview() {
  await work(async ensure => {
    const resolutions: OwnerPortfolioInitialMergeResolution[] = (view.value?.preview.conflicts ?? []).flatMap(row => {
      const choice = choices.value[keyFor(row.key, row.field)]; return choice ? [{ key: row.key, field: row.field, choice }] : []
    })
    linkConsent.value = false; const result = await facade.value!.previewInitial(resolutions); ensure(); view.value = result
    message.value = view.value.token ? '预览可应用。请检查全部冲突选择和剩余待上传意图，再单独确认本机协调。' : '预览仍有问题或未选冲突；请完成选择后重新预览。'
  })
}
function select(key: string, field: OwnerPortfolioInitialMergeField, choice: 'local' | 'cloud') {
  choices.value = { ...choices.value, [keyFor(key, field)]: choice }; linkConsent.value = false
  if (view.value) view.value = { ...view.value, token: null }
  facade.value?.invalidatePreview()
}
async function commit() {
  if (!view.value?.token || !linkConsent.value) return
  const token = view.value.token
  await work(async ensure => { await facade.value!.commitInitial(token, true); ensure(); invalidatePreview(); message.value = '共同基线已在本机协调。剩余意图仍待后续显式上传；本次没有发送，不是云端确认或分析资格。' })
}
async function reconcileLocal() {
  if (busy.value || !store.fullSyncLocalPending) return
  busy.value = true
  try { const result = await store.reconcileFullSyncLocal(); message.value = result.state === 'matched' ? '原本机 id/hash 回执已匹配；没有重放。仍不是云端确认。' : '原本机回执未知；保留原标识，不重放。' }
  catch { message.value = '原本机结果仍未核定；保存/取消/ACK 的原标识请先登录并重新启用完整原包核对，再核原回执。保留原 id/hash，不重新确认或重放。' }
  finally { busy.value = false; refresh() }
}
async function exportCurrent() {
  if (busy.value || !isSix.value) return
  busy.value = true; const context = epoch
  try { const result = await store.createPortfolioRecoveryBackup(); if (!current(context)) return; download(result.raw, result.sha256, true); message.value = `已发起 v6 完整文件下载，SHA256：${result.sha256}。文件核对不是丢库恢复或云端耐久证明。` }
  catch { message.value = '当前完整文件未导出；请保留原数据库和此前备份。' }
  finally { busy.value = false }
}
</script>

<template>
  <section class="full-sync-panel card" aria-label="完整基金与手工资产共同基线协调">
    <h3>基金与手工资产共同基线</h3>
    <p>本机共同基线协调，不是云确认。旧基金基线从未代表手工资产已迁移；历史观察只留本机，不上传或变成现金流收益。</p>
    <template v-if="!isSix">
      <p>先将当前完整 v5 文件下载并选回，再独立升级 v6。旧格式不会自动升级；代码回退不能降级数据库。</p>
      <button type="button" data-action="full-export-format" :disabled="busy || !formatReady" @click="exportFormat">下载升级前完整 v5 文件</button>
      <p v-if="exportedSha">本轮 SHA256：<code>{{ exportedSha }}</code></p>
      <label>原文件 SHA256<input name="owner-full-sha" :value="sha" :disabled="busy" maxlength="64" @input="changeSha" /></label>
      <label>选回完整 v5 原文件<input name="owner-full-file" type="file" accept=".json,application/json" :disabled="busy" @change="choose" /></label>
      <p>最多 {{ OWNER_WORKSPACE_BACKUP_MAX_BYTES }} 字节；不是旧普通行备份，也不是单独历史导出。</p>
      <template v-if="selected">
        <p>完整文件：基金 {{ selected.backup.local.snapshot.entries.length }} 条，手工资产 {{ selected.backup.local.portfolio!.manual.length }} 条，历史 {{ selected.backup.local.portfolio!.history.length }} 条（均保留删除项/原历史）。</p>
        <code>{{ selected.backup.targetFingerprint }}</code>
        <label class="check"><input name="owner-full-format-confirm" :checked="formatConsent" @change="formatConsent = ($event.target as HTMLInputElement).checked" type="checkbox" :disabled="busy" />我已保留本轮同 SHA 原文件，仅升级本机格式，不启用上传。</label>
        <button type="button" data-action="full-upgrade-format" :disabled="!canUpgrade" @click="format(false)">确认升级本机 v6</button>
        <p>中断只核原文件绑定的请求；缺库不创建、原 v5 不重试升级、后续编辑不覆盖。</p>
        <label class="check"><input name="owner-full-reconcile-confirm" :checked="reconcileConsent" @change="reconcileConsent = ($event.target as HTMLInputElement).checked" type="checkbox" :disabled="busy" />只手动核对这份原文件对应的升级。</label>
        <button type="button" data-action="full-reconcile-format" :disabled="!canReconcile" @click="format(true)">核对原 v6 升级</button>
      </template>
    </template>
    <template v-else>
      <p>当前 v6：基金、手工资产与本机历史完整保留。初始协调后须再次同意本轮完整原包核对，每批单独确认才发送；持仓分析仍暂停，基线协调不会清除本机待确认。</p>
      <button type="button" data-action="full-export-current" :disabled="busy" @click="exportCurrent">下载 v6 当前完整工作区</button>
      <p v-if="!authenticated">请先登录私人会话；登录本身不授权读取或上传。</p>
      <label class="check"><input name="owner-full-consent" :checked="consent" @change="consent = ($event.target as HTMLInputElement).checked" type="checkbox" :disabled="!authenticated || busy || enabled" />我同意本轮读取完整基金、全部账户、手工资产及删除记录，用于本机初始协调。</label>
      <button v-if="!enabled" type="button" data-action="full-enable" :disabled="!authenticated || !consent || busy" @click="enable">启用本轮完整读取</button>
      <button v-else type="button" data-action="full-disable" @click="hide">关闭并隐藏私人对照</button>
      <div v-if="privateVisible" class="private-view">
        <template v-if="status?.linked"><p role="status">本机已有完整共同基线。上传与完整确认须下方独立授权；不重新联结，也不授权分析。</p><OwnerFullSyncPacketPanel /></template>
        <template v-else>
          <button type="button" data-action="full-pull" :disabled="busy || !!store.fullSyncLocalPending" @click="pull">拉取完整云端对照</button>
          <button type="button" data-action="full-preview" :disabled="busy || !status?.completeReady || !!store.fullSyncLocalPending" @click="preview">{{ view ? '按当前选择重新预览' : '预览本机共同基线' }}</button>
          <p v-if="pullResult">完整截止 {{ pullResult.revision }}，当前记录 {{ pullResult.records }} 条；不是持仓版本。</p>
          <p v-if="status?.minimumObservedRevision">本会话已观察截止下限 {{ status.minimumObservedRevision }}；失败或部分页不会降低下限，也不等于完整对照。</p>
          <div v-if="view" aria-label="完整初始协调预览">
            <ul v-if="view.preview.issues.length" role="alert"><li v-for="(issue, index) in view.preview.issues" :key="index">{{ issue.code }} · {{ issue.key ?? '完整输入' }}</li></ul>
            <article v-for="conflict in view.preview.conflicts" :key="keyFor(conflict.key, conflict.field)" class="conflict">
              <strong>{{ conflict.key }} · {{ fieldNames[conflict.field] }}</strong><p>{{ reasonNames[conflict.reason] ?? conflict.reason }}</p>
              <p>原基金基线（不代表手工资产曾采用）：{{ valuesText(conflict.base) }}</p>
              <p>本机：{{ valuesText(conflict.local) }}</p><p>完整云端对照：{{ valuesText(conflict.cloud) }}</p>
              <p v-if="conflict.groupKeys.length">整组：{{ conflict.groupKeys.join(' / ') }}</p>
              <label class="check"><input type="radio" :name="keyFor(conflict.key, conflict.field)" :checked="choices[keyFor(conflict.key, conflict.field)] === 'local'" :disabled="busy || !conflict.localAllowed" @change="select(conflict.key, conflict.field, 'local')" />保留本机意图{{ conflict.localAllowed ? '' : '（墓碑等规则禁止）' }}</label>
              <label class="check"><input type="radio" :name="keyFor(conflict.key, conflict.field)" :checked="choices[keyFor(conflict.key, conflict.field)] === 'cloud'" :disabled="busy" @change="select(conflict.key, conflict.field, 'cloud')" />采用完整云端对照</label>
            </article>
            <details><summary>全部协调行（{{ view.preview.rows.length }}）</summary><ul><li v-for="row in view.preview.rows" :key="row.key"><code>{{ row.key }}</code>本机：{{ valuesText(row.before) }} → 协调后：{{ valuesText(row.after) }}</li></ul></details>
            <h4>剩余待上传意图（{{ view.preview.remainingOperations.length }}）</h4>
            <p>以下只展示意图，不裁切、不发送；实际原包仍有 200 项/128 KiB 上限。历史观察不在其中。</p>
            <ul><li v-for="operation in view.preview.remainingOperations" :key="operation.key"><code>{{ operation.key }}</code>{{ operation.deleted ? '删除（完整旧像守卫）' : '创建或字段补丁' }} · {{ valuesText(operation.changes) }}<br />守卫：{{ valuesText(operation.base_values) }}</li></ul>
            <label class="check"><input name="owner-full-link-confirm" :checked="linkConsent" @change="linkConsent = ($event.target as HTMLInputElement).checked" type="checkbox" :disabled="busy || !view.token" />我已检查全部选择与剩余意图，仅应用本机共同基线；不发送、不视为云确认。</label>
            <button type="button" data-action="full-commit" :disabled="busy || !view.token || !linkConsent" @click="commit">确认应用本机共同基线</button>
          </div>
        </template>
      </div>
    </template>
    <div v-if="store.fullSyncLocalPending" role="alert"><p>本机协调结果待核对。原 id：<code>{{ store.fullSyncLocalPending.id }}</code>原 hash：<code>{{ store.fullSyncLocalPending.hash }}</code>只保留本页内原标识；跨刷新不声称永久保存。不能重新确认或重放。</p><button type="button" data-action="full-reconcile-local" :disabled="busy" @click="reconcileLocal">只核原本机回执</button></div>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
  </section>
</template>

<style scoped>
.full-sync-panel { font-size: 12px; line-height: 1.8; color: var(--text-secondary); }
h3 { margin: 0 0 10px; font-size: 15px; color: var(--text); } h4 { font-size: 13px; color: var(--text); }
p, li, code { overflow-wrap: anywhere; } code { display: block; }
label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
input:not([type="checkbox"]):not([type="radio"]) { width: 100%; box-sizing: border-box; padding: 9px; border: 1px solid var(--border); border-radius: 4px; background: var(--card-bg); color: var(--text); }
.check { flex-direction: row; align-items: flex-start; gap: 9px; }.check input { width: 18px; height: 18px; flex-shrink: 0; }
button { margin: 4px 6px 4px 0; padding: 9px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--card-bg); color: var(--text); cursor: pointer; }
button:disabled { opacity: .45; cursor: not-allowed; }button:focus-visible,input:focus-visible,summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.conflict { border-top: 1px solid var(--border); padding: 12px 0; }[role="status"],[role="alert"] { padding: 10px; background: color-mix(in srgb, var(--teal) 8%, var(--card-bg)); }
ul { padding-left: 18px; }summary { cursor: pointer; color: var(--text); }
</style>
