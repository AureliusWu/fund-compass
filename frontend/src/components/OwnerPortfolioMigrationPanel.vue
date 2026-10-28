<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import { OWNER_WORKSPACE_BACKUP_MAX_BYTES } from '@/utils/owner-workspace-backup'
import type { OwnerPortfolioMigrationPreview } from '@/utils/ownerPortfolioLocal'

const store = useWatchlistStore()
const busy = ref(false), message = ref(''), sha = ref(''), exportedSha = ref(''), verifiedSha = ref('')
const confirmed = ref(false), reconcileConfirmed = ref(false)
const currentBackupSha = ref(''), mappingsOpen = ref(false)
const selected = shallowRef<{ raw: string; preview: OwnerPortfolioMigrationPreview } | null>(null)
let alive = true, epoch = 0, reading: AbortController | null = null
const ready = computed(() => store.authorityState === 'idb' && !store.localStorageError && store.localSyncFormat === 'v4')
const recoveryReady = computed(() => store.authorityState === 'idb' && !store.localStorageError && ['v5', 'v6'].includes(store.localSyncFormat ?? ''))
const canUpgrade = computed(() => ready.value && !busy.value && confirmed.value && !!selected.value?.preview.portfolio
  && selected.value.preview.issues.length === 0 && exportedSha.value !== '' && exportedSha.value === verifiedSha.value)
const canReconcile = computed(() => !busy.value && reconcileConfirmed.value && !!selected.value?.preview.portfolio
  && selected.value.preview.issues.length === 0 && ['idb', 'blocked'].includes(store.authorityState))
function invalidate() {
  epoch++; reading?.abort(); reading = null; busy.value = false
  selected.value = null; verifiedSha.value = ''; confirmed.value = false; reconcileConfirmed.value = false; mappingsOpen.value = false
}
const current = (value: number) => alive && value === epoch
watch(() => [store.authorityState, store.localSyncFormat], () => { invalidate(); exportedSha.value = '' }, { flush: 'sync' })
onBeforeUnmount(() => { alive = false; invalidate() })
function download(raw: string, hash: string, currentBackup = false) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a')
  try { anchor.href = url; anchor.download = `司南基金_${currentBackup ? '当前资产历史完整备份' : '资产历史迁移原文件'}_${hash.slice(0, 16)}.json`; document.body.appendChild(anchor); anchor.click() }
  finally { anchor.remove(); URL.revokeObjectURL(url) }
}
async function exportCurrentBackup() {
  if (busy.value || !recoveryReady.value) return
  invalidate(); currentBackupSha.value = ''; exportedSha.value = ''; message.value = ''; busy.value = true
  const context = epoch
  try {
    const result = await store.createPortfolioRecoveryBackup()
    if (!current(context)) return
    download(result.raw, result.sha256, true); currentBackupSha.value = result.sha256
    message.value = `已发起当前 ${store.localSyncFormat} 完整文件下载，包含当前基金、手工资产、历史与同步意图。请确认已保留；这不是丢库恢复、耐久或云端备份证明。`
  } catch { if (current(context)) message.value = '当前完整文件导出未完成；原工作区未清空，请保留此前原文件。' }
  finally { if (current(context)) busy.value = false }
}
async function exportBackup() {
  if (busy.value || !ready.value) return
  invalidate(); exportedSha.value = ''; sha.value = ''; message.value = ''; busy.value = true
  const context = epoch
  try {
    const result = await store.createPortfolioUpgradeBackup()
    if (!current(context)) return
    download(result.raw, result.sha256); exportedSha.value = result.sha256; sha.value = result.sha256
    message.value = '已发起迁移原文件下载，尚未升级。请确认文件已保留，再选回同一完整文件。'
  } catch { if (current(context)) message.value = '迁移原文件导出未完成，不能升级；原工作区与旧资产文件未清空。' }
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
      if (size > file.size || size > OWNER_WORKSPACE_BACKUP_MAX_BYTES) throw new Error('read_size')
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
  if (!file) return
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > OWNER_WORKSPACE_BACKUP_MAX_BYTES) {
    message.value = '文件为空或超过完整备份上限，未读取。'; return
  }
  if (!/^[0-9a-f]{64}$/.test(sha.value)) { message.value = '请填写原文件的完整 SHA256 摘要。'; return }
  const context = epoch, hash = sha.value, controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000)
  reading = controller; busy.value = true
  try {
    const raw = await read(file, controller.signal)
    if (!current(context)) return
    if (controller.signal.aborted) throw new Error('read_aborted')
    const preview = await store.previewPortfolioUpgrade(raw, hash)
    if (!current(context)) return
    if (controller.signal.aborted) throw new Error('read_aborted')
    selected.value = { raw, preview }; verifiedSha.value = hash
    message.value = preview.issues.length || !preview.portfolio ? '原文件已核对，但存在迁移问题；整批暂停，不丢弃问题记录换取成功。'
      : '原文件核对通过；请检查数量、历史保留规则和全部标识映射，再单独确认升级。尚未写入或上传。'
  } catch { if (current(context)) message.value = '迁移原文件核对失败或已中断。请保留原字节与完整摘要；未覆盖当前记录。' }
  finally { clearTimeout(timer); if (current(context)) { busy.value = false; reading = null } }
}
async function upgrade() {
  if (!canUpgrade.value || !selected.value) return
  const context = epoch, original = selected.value, hash = verifiedSha.value
  busy.value = true; message.value = ''
  try {
    await store.upgradePortfolioFormat(original.raw, hash, true)
    if (alive) message.value = '已升级本机资产与历史共同工作区；旧文件原文保留，不再双写。未启用上传，也不是云端确认。'
  } catch { if (alive) message.value = '升级未完成或结果待核对。请保留原文件与原请求，只手动核对，不重新导入或自动重试。' }
  finally { if (current(context)) busy.value = false }
}
async function reconcile() {
  if (!canReconcile.value || !selected.value) return
  const context = epoch, original = selected.value, hash = verifiedSha.value
  busy.value = true; message.value = ''
  try {
    await store.reconcilePortfolioUpgrade(original.raw, hash, true)
    if (alive) message.value = '原资产历史升级已核对；没有重放请求、覆盖后续编辑或重建丢失数据库。'
  } catch { if (alive) message.value = '原升级仍未核定。请保留原文件与原请求标识；不重放、不回退到旧存储。' }
  finally { if (current(context)) busy.value = false }
}
const issueText: Record<string, string> = { invalid_raw: '原文格式无效', capacity_exceeded: '记录或字节超限', invalid_manual: '手工资产字段不兼容',
  duplicate_manual_id: '手工资产标识重复', incompatible_manual_value: '手工资产金额不兼容', id_collision: '映射标识冲突', invalid_snapshot: '历史快照字段不兼容', hash_unavailable: '摘要计算不可用' }
</script>

<template>
  <section class="portfolio-migration card" aria-label="手工资产与组合历史迁移">
    <h3>资产与历史共同工作区</h3>
    <p v-if="['v5', 'v6'].includes(store.localSyncFormat ?? '')">当前 {{ store.localSyncFormat }}：手工资产、删除标记与余额观察均保存在共同工作区。仍是本机待确认状态，不代表云端已同步。</p>
    <p v-else>当前 {{ store.localSyncFormat ?? '未核定' }}：手工资产与组合历史尚未并入共同工作区。旧资产编辑、旧 Gist 和快照写入已暂停；未知金额不按零处理。</p>
    <p>这份迁移原文件包含完整 v4 工作区及独立手工资产、历史快照的原始字节，可能含私人信息。只保存到自己的设备；下载或 SHA 校验不是来源认证或云备份。</p>
    <p>旧 UTC 日期、重复日期、旧持仓不透明标识完整保留；超长旧资产标识使用明确映射，不截断、不丢行。新余额观察使用上海日期；余额变化不等于现金流调整收益。</p>
    <template v-if="['v5', 'v6'].includes(store.localSyncFormat ?? '')">
      <p>升级原文件只保留升级前快照，不含后来编辑。当前完整文件另外包含当前基金、手工资产、历史和同步意图；不包含登录凭据，也不能据此重放未知请求或认定丢库可恢复。</p>
      <button type="button" data-action="export-portfolio-current" :disabled="busy || !recoveryReady" @click="exportCurrentBackup">下载当前资产历史完整备份</button>
      <p v-if="currentBackupSha">当前完整文件 SHA256：<code>{{ currentBackupSha }}</code></p>
    </template>
    <template v-if="store.localSyncFormat !== 'v6'">
    <p v-if="store.localSyncFormat === 'v3'">请先到自选页完成 v3 → v4 的显式完整格式升级，再在这里迁移资产历史。</p>
    <button type="button" data-action="export-portfolio-upgrade" :disabled="busy || !ready" @click="exportBackup">下载资产历史迁移原文件</button>
    <p v-if="exportedSha">本轮原文件 SHA256：<code>{{ exportedSha }}</code></p>
    <label>原文件 SHA256<input name="owner-portfolio-sha" :value="sha" :disabled="busy" autocomplete="off" maxlength="64" spellcheck="false" @input="changeSha" /></label>
    <label>重新选择迁移原文件<input name="owner-portfolio-file" type="file" accept=".json,application/json" :disabled="busy" @change="choose" /></label>
    <p>上限 {{ OWNER_WORKSPACE_BACKUP_MAX_BYTES }} 字节。普通行备份、单独快照导出或旧完整工作区文件不能代替本次迁移原文件。</p>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
    <div v-if="selected" aria-label="资产历史迁移预览">
      <p>手工资产 {{ selected.preview.portfolio?.manual.length ?? '尚未核定' }} 条（含删除项）；历史 {{ selected.preview.portfolio?.history.length ?? '尚未核定' }} 条；标识映射 {{ selected.preview.idMappings.length }} 项。</p>
      <ul v-if="selected.preview.issues.length" role="alert"><li v-for="(issue, index) in selected.preview.issues" :key="index">{{ issue.source }} · {{ issue.index === null ? '整份来源' : `第 ${issue.index + 1} 项` }} · {{ issueText[issue.code] ?? issue.code }}（{{ issue.code }}）</li></ul>
      <details @toggle="mappingsOpen = ($event.target as HTMLDetailsElement).open"><summary>检查全部资产标识映射（{{ selected.preview.idMappings.length }}）</summary><ul v-if="mappingsOpen"><li v-for="row in selected.preview.idMappings" :key="row.legacyId"><code>{{ row.legacyId }}</code> → <code>{{ row.key }}</code> · {{ row.mode === 'identity' ? '保留原标识' : '显式 SHA256 映射，原标识原文保留' }}</li></ul></details>
      <label class="portfolio-check"><input name="owner-portfolio-confirm" type="checkbox" :checked="confirmed" :disabled="busy" @change="confirmed = ($event.target as HTMLInputElement).checked" />我已保留本轮原文件，检查全部问题、数量和映射；仅升级本机格式，不开启上传。</label>
      <p>当前 v5 私人上传与持仓分析暂未开放，原 v4 同步入口不能继续使用。只有本机基金、手工资产与余额观察可编辑；完整手工资产同步意图及确认流程仍在实现。</p>
      <button type="button" data-action="upgrade-portfolio" :disabled="!canUpgrade" @click="upgrade">确认迁移到本机 v5</button>
      <p>升级中断只核对原文件绑定的请求。不会重新导入、覆盖后续编辑、重放未知写入或重建丢失数据库；代码回退不能恢复旧格式。</p>
      <label class="portfolio-check"><input name="owner-portfolio-reconcile-confirm" type="checkbox" :checked="reconcileConfirmed" :disabled="busy" @change="reconcileConfirmed = ($event.target as HTMLInputElement).checked" />我选择的是原升级前文件，只手动核对那一次升级。</label>
      <button type="button" data-action="reconcile-portfolio-upgrade" :disabled="!canReconcile" @click="reconcile">核对原资产历史升级</button>
    </div>
    </template>
    <p v-else>当前 v6 的旧资产历史迁移入口已关闭。完整基金与手工资产共同基线请使用下方独立协调入口；仍不是云确认。</p>
  </section>
</template>

<style scoped>
.portfolio-migration { font-size: 12px; line-height: 1.8; color: var(--text-secondary); }
h3 { margin: 0 0 10px; font-size: 15px; color: var(--text); }
p, li { overflow-wrap: anywhere; } code { overflow-wrap: anywhere; }
label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
input:not([type="checkbox"]) { width: 100%; box-sizing: border-box; padding: 9px; border: 1px solid var(--border); border-radius: 4px; background: var(--card-bg); color: var(--text); }
button { padding: 9px 12px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--card-bg); cursor: pointer; }
button:disabled { opacity: .45; cursor: not-allowed; } button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.portfolio-check { flex-direction: row; align-items: flex-start; gap: 9px; } .portfolio-check input { width: 18px; height: 18px; flex-shrink: 0; }
[role="status"], [role="alert"] { padding: 10px; background: color-mix(in srgb, var(--teal) 8%, var(--card-bg)); }
ul { padding-left: 18px; } summary { cursor: pointer; color: var(--text); }
</style>
