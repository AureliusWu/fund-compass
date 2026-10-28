<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import { OWNER_WORKSPACE_RECOVERY_MAX_BYTES, restoreOwnerWorkspaceRecoveryBackup,
  type OwnerWorkspaceRecoveryBackup } from '@/utils/owner-workspace-recovery'

const store = useWatchlistStore()
const busy = ref(false), message = ref(''), sha = ref(''), exportedSha = ref(''), verifiedSha = ref('')
const confirmed = ref(false), recoveryConfirmed = ref(false)
const selected = shallowRef<{ raw: string; envelope: OwnerWorkspaceRecoveryBackup } | null>(null)
let alive = true, epoch = 0, reading: AbortController | null = null
const ready = computed(() => store.authorityState === 'idb' && !store.localStorageError && !['v5', 'v6'].includes(store.localSyncFormat ?? ''))
const canUpgrade = computed(() => ready.value && store.localSyncFormat === 'v3' && !busy.value && confirmed.value
  && selected.value?.envelope.physicalVersion === 3 && exportedSha.value !== '' && exportedSha.value === verifiedSha.value)
const canReconcile = computed(() => !busy.value && recoveryConfirmed.value && selected.value?.envelope.physicalVersion === 3
  && !['v5', 'v6'].includes(store.localSyncFormat ?? '') && ['idb', 'blocked'].includes(store.authorityState))
const manualCount = computed(() => selected.value?.envelope.local.sync?.base?.records.filter(row => row.kind === 'manual_asset').length ?? 0)
function invalidate() {
  epoch++; reading?.abort(); reading = null; busy.value = false
  selected.value = null; verifiedSha.value = ''; confirmed.value = false; recoveryConfirmed.value = false
}
const current = (value: number) => alive && value === epoch
watch(() => [store.authorityState, store.localSyncFormat], () => invalidate(), { flush: 'sync' })
onBeforeUnmount(() => { alive = false; invalidate() })
function download(raw: string, hash: string) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a')
  try { anchor.href = url; anchor.download = `司南基金_完整工作区_${hash.slice(0, 16)}.json`; document.body.appendChild(anchor); anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}
async function exportBackup() {
  if (busy.value || !ready.value) return
  invalidate(); exportedSha.value = ''; sha.value = ''; message.value = ''; busy.value = true
  const context = epoch
  try {
    const result = await store.createSyncRecoveryBackup()
    if (!current(context)) return
    download(result.raw, result.sha256); exportedSha.value = result.sha256; sha.value = result.sha256
    message.value = '已发起完整工作区下载。请确认文件保存成功，再选回同一文件核对。'
  } catch { if (current(context)) message.value = '完整备份未完成，不能升级。原本机记录保留；请检查当前工作区。' }
  finally { if (current(context)) busy.value = false }
}
function changeSha(event: Event) { invalidate(); sha.value = (event.target as HTMLInputElement).value.trim(); message.value = '' }
async function read(file: File, signal: AbortSignal) {
  const reader = file.stream().getReader(), chunks: Uint8Array[] = []
  let size = 0, finished = false
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new Error('read_aborted')
      const chunk = await reader.read()
      if (signal.aborted) throw new Error('read_aborted')
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > file.size || size > OWNER_WORKSPACE_RECOVERY_MAX_BYTES) throw new Error('read_size')
      chunks.push(chunk.value)
    }
    if (size !== file.size) throw new Error('read_size')
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    finished = true; return raw
  } finally { if (!finished) cancel(); signal.removeEventListener('abort', cancel); reader.releaseLock() }
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  invalidate(); message.value = ''
  if (store.localSyncFormat === 'v5') return
  if (!file) return
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > OWNER_WORKSPACE_RECOVERY_MAX_BYTES) {
    message.value = '文件为空或超过完整备份上限，未读取。'; return
  }
  if (!/^[0-9a-f]{64}$/.test(sha.value)) { message.value = '请填写原文件的完整 SHA256 摘要。'; return }
  const context = epoch, controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000)
  reading = controller; busy.value = true
  try {
    const raw = await read(file, controller.signal)
    if (!current(context)) return
    if (controller.signal.aborted) throw new Error('read_aborted')
    const envelope = await restoreOwnerWorkspaceRecoveryBackup(raw, sha.value)
    if (!current(context)) return
    if (controller.signal.aborted) throw new Error('read_aborted')
    selected.value = { raw, envelope }; verifiedSha.value = sha.value
    message.value = '完整备份校验通过；尚未升级、恢复或发送云端。'
  } catch { if (current(context)) message.value = '完整备份核对失败或已中断。请核对原文件与摘要；原工作区未覆盖。' }
  finally { clearTimeout(timer); if (current(context)) { busy.value = false; reading = null } }
}
async function upgrade() {
  if (!canUpgrade.value || !selected.value) return
  const context = epoch, original = selected.value, hash = verifiedSha.value
  busy.value = true; message.value = ''
  try {
    await store.upgradeLocalSyncFormat(original.raw, hash, true)
    if (alive) message.value = '本机同步格式已升级。其他打开的旧页面请刷新；私人同步仍需另行登录、同意和核对。'
  } catch { if (alive) message.value = '升级未完成或结果待核对。请保留本次完整备份，使用下方手动核对；不会重新导入旧记录。' }
  finally { if (current(context)) busy.value = false }
}
async function reconcile() {
  if (!canReconcile.value || !selected.value) return
  const context = epoch, original = selected.value, hash = verifiedSha.value
  busy.value = true; message.value = ''
  try {
    await store.reconcileLocalSyncUpgrade(original.raw, hash, true)
    if (alive) message.value = '已核对原升级，必要的空同步元数据初始化已完成；业务记录没有重新导入。'
  } catch { if (alive) message.value = '原升级尚不能核定。当前记录、目标或格式与原备份不符时保持暂停，不覆盖新编辑或重建丢失的数据库。' }
  finally { if (current(context)) busy.value = false }
}
const valueText = (value: unknown) => value === null ? '未知（null）' : Object.is(value, -0) ? '-0' : String(value)
</script>

<template>
  <section class="format-panel" aria-label="本机同步格式与完整备份">
    <h3>同步格式与完整备份</h3>
    <p>当前格式：{{ store.localSyncFormat === 'v5' ? 'v5 · 资产历史共同工作区已核定' : store.localSyncFormat === 'v4' ? 'v4 · 可单独启用私人同步' : store.localSyncFormat === 'v3' ? 'v3 · 仅本机编辑' : '尚未核定' }}。</p>
    <template v-if="['v5', 'v6'].includes(store.localSyncFormat ?? '')">
      <p>当前基金、手工资产与历史已使用共同工作区。请到资产页“下载当前资产历史完整备份”，包含后来编辑与原升级记录；升级前文件不是当前完整备份，也不证明丢库恢复或云端耐久。</p>
      <p>旧 v3/v4 文件的导出、选回与格式升级入口已关闭，不能降级或覆盖当前 {{ store.localSyncFormat }}。v6 只可使用独立完整原包入口逐批确认；持仓分析仍暂停，请保留本机待确认状态。</p>
      <a href="#/assets">前往资产页完整备份</a>
    </template>
    <template v-else>
    <p>完整文件保留本机记录、原时间、旧档案、共同基线（含已拉取的手工资产与删除项）、原提交及本机回执。它不含登录凭据、其他独立资产存储或组合历史，也不是云端备份。请只保存到自己的设备。</p>
    <p>升级需本轮下载并选回同一完整文件；空原包槽才能升级。旧版页面可能无法读取升级后的格式，代码回退不能恢复旧格式。</p>
    <button type="button" data-action="export-format" :disabled="busy || !ready" @click="exportBackup">下载完整工作区备份</button>
    <p v-if="exportedSha">本轮文件 SHA256：<code>{{ exportedSha }}</code></p>
    <label>完整文件 SHA256<input name="owner-format-sha" :value="sha" :disabled="busy" autocomplete="off" maxlength="64" spellcheck="false" @input="changeSha" /></label>
    <label>选择完整工作区文件<input name="owner-format-file" type="file" accept=".json,application/json" :disabled="busy" @change="choose" /></label>
    <p>最大 {{ OWNER_WORKSPACE_RECOVERY_MAX_BYTES }} 字节。普通“本机工作区备份”不包含完整同步状态，不能用于格式升级。</p>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
    <div v-if="selected" aria-label="完整工作区文件核对">
      <p>文件格式 v{{ selected.envelope.physicalVersion }} · 本机 {{ selected.envelope.local.snapshot.entries.length }} 条（含删除项） · 基线手工资产 {{ manualCount }} 条 · 原包 {{ selected.envelope.local.outbox.entry ? '保留，不能据备份重新发送' : '空' }}。</p>
      <p>完整目标指纹：<code>{{ selected.envelope.targetFingerprint }}</code>（只用于核对服务地址，不代表数据库身份或耐久性。）</p>
      <ul><li v-for="row in selected.envelope.local.snapshot.entries" :key="row.key">{{ row.key }} · {{ row.values.name }} · {{ row.kind === 'watch' ? '仅关注' : '持仓' }} · {{ row.deleted ? '已删除' : '未删除' }} · 份额 {{ valueText(row.values.shares) }} · 成本 {{ valueText(row.values.cost) }} · 目标权重 {{ valueText(row.values.target_weight) }}%</li></ul>
      <template v-if="selected.envelope.physicalVersion === 3">
        <label class="format-check"><input name="owner-format-confirm" type="checkbox" :checked="confirmed" :disabled="busy" @change="confirmed = ($event.target as HTMLInputElement).checked" />我已保留并检查完整备份，仅升级当前本机格式，不启用上传。</label>
        <button v-if="store.localSyncFormat === 'v3'" type="button" data-action="upgrade-format" :disabled="!canUpgrade" @click="upgrade">升级本机同步格式</button>
        <p>若升级中断：这里只核对原升级，并在现有 v4 数据库保留完整原记录、仅同步元数据为空时补完初始化。不会回退后续编辑、降级格式或重建丢失的数据库。</p>
        <label class="format-check"><input name="owner-format-reconcile-confirm" type="checkbox" :checked="recoveryConfirmed" :disabled="busy" @change="recoveryConfirmed = ($event.target as HTMLInputElement).checked" />我选择的是原升级前完整文件，只手动核对该次升级。</label>
        <button type="button" data-action="reconcile-format" :disabled="!canReconcile" @click="reconcile">核对中断的格式升级</button>
      </template>
      <p v-else>已核对 v4 完整状态文件。此入口不回写历史文件，也不从备份重发原包；未知写入请在私人同步面板核对原回执。</p>
    </div>
    </template>
  </section>
</template>

<style scoped>
.format-panel { border-top: 1px solid var(--rule); margin-top: 18px; padding-top: 16px; font-size: 12px; line-height: 1.8; }
h3 { margin: 0 0 10px; font-size: 15px; } p, li { overflow-wrap: anywhere; } code { display: block; overflow-wrap: anywhere; }
label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; } input:not([type="checkbox"]) { width: 100%; box-sizing: border-box; padding: 9px; border: 1px solid var(--rule); border-radius: 4px; background: var(--paper); color: var(--ink); }
button { padding: 9px 12px; border: 1px solid var(--rule); border-radius: 4px; color: var(--ink); background: var(--paper); cursor: pointer; } button:disabled { opacity: .45; cursor: not-allowed; }
.format-check { flex-direction: row; align-items: flex-start; gap: 9px; } .format-check input { width: 18px; height: 18px; flex-shrink: 0; }
[role="status"] { padding: 10px; background: var(--teal-mist); } ul { padding-left: 18px; }
</style>
