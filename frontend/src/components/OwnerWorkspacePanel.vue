<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import { OWNER_WORKSPACE_BACKUP_MAX_BYTES, restoreOwnerWorkspaceBackup,
  type OwnerWorkspaceBackup } from '@/utils/owner-workspace-backup'
import type { OwnerWorkspaceEntry } from '@/utils/owner-cloud-import'

const store = useWatchlistStore()
type RestorePreview = Awaited<ReturnType<typeof store.previewLocalWorkspaceRestore>>
const opened = ref(false)
const busy = ref(false)
const message = ref('')
const sha = ref('')
const exportedSha = ref('')
const verifiedSha = ref('')
const confirmed = ref(false)
const reconcileConfirmed = ref(false)
const selected = shallowRef<{ raw: string; envelope: OwnerWorkspaceBackup } | null>(null)
const preview = shallowRef<RestorePreview | null>(null)
const selectedTimes = computed(() => new Map(selected.value?.envelope.displayTimes.map(row => [row.key, row.updated_at]) ?? []))
const currentTimes = computed(() => new Map(store.entries.map(row => [row.id, row.updated_at])))
let mounted = true
let generation = 0
let lifecycle = 0
let reading: AbortController | null = null
const authorityReady = computed(() => ['legacy', 'idb'].includes(store.authorityState) && !store.localStorageError)
const canActivate = computed(() => authorityReady.value && store.authorityState === 'legacy' && !busy.value
  && Boolean(selected.value) && exportedSha.value !== '' && verifiedSha.value === exportedSha.value && confirmed.value)
const canRestore = computed(() => authorityReady.value && store.authorityState === 'idb' && !busy.value
  && Boolean(selected.value) && preview.value?.canApply === true && confirmed.value)
const canReconcileActivation = computed(() => store.authorityState === 'activating' && !busy.value
  && Boolean(selected.value) && verifiedSha.value !== '' && reconcileConfirmed.value)
const stateLabel = computed(() => store.authorityState === 'idb' ? '本机权威'
  : store.authorityState === 'legacy' ? '旧版本机副本'
  : store.authorityState === 'activating' ? '权威切换待核定'
  : store.authorityState === 'blocked' ? '本机存储已暂停' : '本机权威核定中')
const counts = computed(() => {
  const entries = selected.value?.envelope.entries ?? []
  return { total: entries.length, watch: entries.filter(row => row.kind === 'watch').length,
    holding: entries.filter(row => row.kind === 'holding').length, tombstones: entries.filter(row => row.deleted).length,
    localPending: entries.filter(row => row.local_pending).length }
})
function invalidate(clearExport = false) {
  generation++; reading?.abort(); reading = null; busy.value = false
  selected.value = null; preview.value = null; verifiedSha.value = ''; confirmed.value = false; reconcileConfirmed.value = false
  if (clearExport) { exportedSha.value = ''; sha.value = '' }
}
function open() { lifecycle++; opened.value = true }
function close() { lifecycle++; invalidate(true); opened.value = false; message.value = '' }
watch(() => store.authorityState, () => { invalidate(); message.value = '' }, { flush: 'sync' })
onBeforeUnmount(() => { mounted = false; lifecycle++; invalidate(true) })
function current(value: number) { return mounted && value === generation && opened.value }
function samePanel(value: number) { return mounted && opened.value && value === lifecycle }
function failure(value: number, text: string) { if (current(value)) message.value = text }
function rejection(cause: unknown, fallback: string): string {
  const codes: Record<string, string> = {
    missing_name: '旧记录缺少有效基金名称。请先核对原始记录并明确修正名称，再重新导出；不会自动补名或丢弃该项。',
    ambiguous_kind: '旧记录无法明确区分仅关注与持仓。请先核对原始记录的真实类型；不会按 0 份猜测或跳过。',
    invalid_legacy: '旧原始记录格式不兼容或含坏删除项。请先核对原始记录；不会自动修复、删项或覆盖。',
    invalid_backup: '备份格式不兼容或内容不完整。请选用完整原备份；不会删项、补值或覆盖当前记录。',
    hash_mismatch: '文件与完整 SHA256 摘要不符。请重新确认原备份文件和摘要；本机记录未覆盖。',
    capacity_exceeded: '备份或记录超过安全上限。请先核对原始记录，不会截断、丢弃账户或部分导入。',
    hash_unavailable: '浏览器无法计算完整摘要。请检查当前安全页面和浏览器能力；不会跳过校验。',
  }
  const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : ''
  return codes[code] ?? fallback
}
function valueText(value: unknown): string { return value === null ? '未知（null）' : String(value) }
function account(row: OwnerWorkspaceEntry) { return row.key.slice(row.key.indexOf('::') + 2) || '未分组' }
function code(row: OwnerWorkspaceEntry) { return row.key.slice(0, row.key.indexOf('::')) }
function updateSha(event: Event) {
  invalidate()
  sha.value = (event.target as HTMLInputElement).value.trim()
  message.value = '摘要已变更，请重新选择文件核对。'
}
function download(raw: string, hash: string) {
  const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  try {
    anchor.href = url; anchor.download = `司南基金_本机工作区_${hash.slice(0, 16)}.json`
    document.body.appendChild(anchor); anchor.click()
  } finally { anchor.remove(); URL.revokeObjectURL(url) }
}
async function exportBackup() {
  if (busy.value || !authorityReady.value) return
  invalidate(true)
  const context = generation
  busy.value = true; message.value = ''
  try {
    const backup = await store.createLocalWorkspaceBackup()
    if (!current(context)) return
    download(backup.raw, backup.sha256)
    exportedSha.value = backup.sha256; sha.value = backup.sha256
    message.value = '已发起本机文件下载。请检查下载结果，再选回该文件核对；下载动作不等于文件已保存。'
  } catch (cause) { failure(context, rejection(cause, '备份未完成。请检查本机存储及下载权限；原副本未覆盖。')) }
  finally { if (current(context)) busy.value = false }
}
async function readBounded(file: File, signal: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > OWNER_WORKSPACE_BACKUP_MAX_BYTES) throw new Error('file_size')
  const reader = file.stream().getReader(), chunks: Uint8Array[] = []
  let length = 0
  let completed = false
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new Error('file_aborted')
      const chunk = await reader.read()
      if (signal.aborted) throw new Error('file_aborted')
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > OWNER_WORKSPACE_BACKUP_MAX_BYTES || length > file.size) throw new Error('file_size')
      chunks.push(chunk.value)
    }
    if (length !== file.size) throw new Error('file_size')
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    // Preserve a BOM as a character so byte changes cannot disappear before SHA.
    const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    completed = true
    return result
  } finally {
    if (!completed) cancel()
    signal.removeEventListener('abort', cancel); reader.releaseLock()
  }
}
async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  invalidate()
  if (!file) return
  const context = generation
  // Native file size is checked before opening a stream or allocating text.
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > OWNER_WORKSPACE_BACKUP_MAX_BYTES) {
    failure(context, `文件为空或超过 ${OWNER_WORKSPACE_BACKUP_MAX_BYTES} 字节，未读取或覆盖本机记录。`); return
  }
  if (!/^[0-9a-f]{64}$/.test(sha.value)) { failure(context, '请先填写该备份的完整 SHA256 摘要，再选择文件。'); return }
  const controller = new AbortController()
  reading = controller; busy.value = true; message.value = ''
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const raw = await readBounded(file, controller.signal)
    if (!current(context)) return
    if (controller.signal.aborted) throw new Error('file_aborted')
    const envelope = await restoreOwnerWorkspaceBackup(raw, sha.value)
    if (!current(context)) return
    if (controller.signal.aborted) throw new Error('file_aborted')
    selected.value = { raw, envelope }; verifiedSha.value = sha.value
    message.value = '备份字节与完整摘要一致。请逐条检查记录；尚未切换权威或导入。'
  } catch (cause) { failure(context, rejection(cause, '文件核对未通过或读取中断。请使用完整原备份及对应摘要；本机记录未覆盖。')) }
  finally { clearTimeout(timer); if (current(context)) { busy.value = false; reading = null } }
}
async function previewRestore() {
  if (busy.value || !authorityReady.value || store.authorityState !== 'idb' || !selected.value) return
  const context = generation, copy = selected.value
  busy.value = true; confirmed.value = false; preview.value = null; message.value = ''
  try {
    const result = await store.previewLocalWorkspaceRestore(copy.raw, verifiedSha.value)
    if (current(context)) preview.value = result
  } catch { failure(context, '复导预览未完成。请检查当前本机工作区；不会覆盖冲突或复活删除记录。') }
  finally { if (current(context)) busy.value = false }
}
async function activate() {
  if (!canActivate.value || !selected.value) return
  const context = generation, panel = lifecycle, copy = selected.value, hash = verifiedSha.value
  busy.value = true; message.value = ''
  try {
    await store.activateLocalWorkspace(copy.raw, hash)
    // A successful authority transition deliberately invalidates the old view.
    if (samePanel(panel) && store.authorityState === 'idb') message.value = '已启用本机工作区。旧两槽原文保留；云端仍未确认。'
  } catch { failure(context, '权威切换未完成或结果待核定。编辑保持暂停时，请保留备份并检查本机存储；不会回退覆盖。') }
  finally { if (current(context)) busy.value = false }
}
async function restore() {
  if (!canRestore.value || !selected.value) return
  const context = generation, copy = selected.value, hash = verifiedSha.value
  busy.value = true; message.value = ''
  try {
    await store.restoreLocalWorkspaceBackup(copy.raw, hash)
    if (current(context)) { invalidate(); message.value = '已复导允许新增的记录。原有记录和删除项未覆盖；云端仍未确认。' }
  } catch { failure(context, '复导未完成或当前记录已变化。请重新核对完整预览；不会自动重试或覆盖。') }
  finally { if (current(context)) busy.value = false }
}
async function reconcileLocal() {
  if (busy.value || !store.hasPendingLocalWorkspaceEdit) return
  const context = generation, panel = lifecycle
  busy.value = true; message.value = ''
  try {
    await store.reconcileLocalWorkspaceEdit()
    if (samePanel(panel)) message.value = '已完成本轮保留写入的本机核对。只核对原标识，不重放；云端未确认。'
  } catch { failure(context, '上次本机写入尚未核定，或本轮没有可核对的原标识。保留备份并保持暂停；不会重放旧请求。') }
  finally { if (current(context)) busy.value = false }
}
async function reconcileActivation() {
  if (!canReconcileActivation.value || !selected.value) return
  const context = generation, panel = lifecycle, copy = selected.value, hash = verifiedSha.value
  busy.value = true; message.value = ''
  try {
    // This store branch checks the already saved adoption, never reimports rows.
    await store.activateLocalWorkspace(copy.raw, hash)
    if (samePanel(panel) && store.authorityState === 'idb') message.value = '已核对保存的权威切换结果。本机工作区已启用；没有重导业务记录，云端仍未确认。'
  } catch { failure(context, '已保存的切换结果未能核定。请保留原文件与完整摘要；缺少匹配回执时不会重新导入，编辑继续暂停。') }
  finally { if (current(context)) busy.value = false }
}
</script>

<template>
  <section class="owner-workspace" aria-label="本机工作区">
    <header class="workspace-heading"><div><h2>本机工作区</h2><p>备份、核对与本机编辑 · 不上传</p></div><button type="button" class="workspace-button" data-action="open" @click="opened ? close() : open()">{{ opened ? '关闭并隐藏' : '查看本机工作区' }}</button></header>
    <ol class="workspace-status" aria-label="本机与云端状态"><li :class="{ complete: verifiedSha }">{{ verifiedSha ? '备份已核对' : '备份待核对' }}</li><li :class="{ complete: store.authorityState === 'idb' }">{{ stateLabel }}</li><li>云端未确认</li></ol>
    <div v-if="opened" class="workspace-body">
      <p class="workspace-boundary">此处只处理本机自选与账户持仓，不需要登录私人会话，也不授权云同步。旧两槽原文保留；启用后旧版 Gist 不再读写。</p>
      <p class="workspace-boundary">备份不含手工资产或组合历史，不读取凭据键、认证元数据或同步原包槽。这不是整个应用的数据备份，也不是云端确认、耐久或恢复证明。旧原文档案可能含任意私人内容；请只保存在自己的设备，不上传或公开分享。</p>
      <p v-if="store.authorityState === 'idb'" class="workspace-boundary">当前仅启用本机工作区；新版云端上传暂未启用。</p>
      <p v-if="!authorityReady" class="workspace-error" role="alert">{{ store.authorityError || '本机权威尚未核定，编辑和导入已暂停。请保留原文件与摘要，不要清除浏览器存储。' }}</p>
      <button v-if="store.authorityState === 'blocked'" type="button" class="workspace-button" data-action="reconcile-local" :disabled="busy || !store.hasPendingLocalWorkspaceEdit" @click="reconcileLocal">核对上次本机写入</button>
      <button type="button" class="workspace-button" data-action="export" :disabled="busy || !authorityReady" @click="exportBackup">下载本机工作区备份</button>
      <p v-if="exportedSha" class="workspace-meta">本轮导出 SHA256：<code>{{ exportedSha }}</code>请先确认文件已下载，再选择同一文件。</p>
      <label class="workspace-field">备份完整 SHA256<input name="owner-workspace-sha256" :value="sha" :disabled="busy" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" @input="updateSha" /></label>
      <label class="workspace-field">重新选择本机备份文件<input name="owner-workspace-file" type="file" accept="application/json,.json" :disabled="busy" @change="selectFile" /></label>
      <p class="workspace-note">最大 {{ OWNER_WORKSPACE_BACKUP_MAX_BYTES }} 字节；空文件、坏格式或摘要不符都不能导入。核对只在本机执行；读取 15 秒未完成会停止等待，不代表能中断已经进行的摘要计算。</p>
      <p v-if="message" class="workspace-message" role="status" aria-live="polite">{{ message }}</p>
      <div v-if="selected" class="workspace-preview" aria-label="本机备份完整预览">
        <h3>全部账户与删除记录</h3><p>共 {{ counts.total }} 条 · 仅关注 {{ counts.watch }} · 持仓 {{ counts.holding }} · 删除 {{ counts.tombstones }} · 本地待确认 {{ counts.localPending }}</p>
        <p class="workspace-meta">已核对完整 SHA256：<code>{{ verifiedSha }}</code></p>
        <p v-if="!counts.total">空业务副本；不会填充未知份额或虚构账户。</p>
        <article v-for="row in selected.envelope.entries" :key="row.key" class="workspace-row">
          <h4>{{ code(row) }} · {{ account(row) }}</h4><p>{{ row.values.name }} · {{ row.kind === 'holding' ? '持仓记录' : '仅关注' }}</p>
          <dl><dt>份额</dt><dd>{{ valueText(row.values.shares) }}</dd><dt>成本净值</dt><dd>{{ valueText(row.values.cost) }}</dd><dt>目标权重 %</dt><dd>{{ valueText(row.values.target_weight) }}</dd><dt>删除状态</dt><dd>{{ row.deleted ? '已删除（保留 tombstone）' : '未删除' }}</dd><dt>本地待确认</dt><dd>{{ row.local_pending ? '是' : '否（不等于云端已确认）' }}</dd><dt>原更新时间</dt><dd>{{ selectedTimes.get(row.key) ?? '未知（null）' }}</dd></dl>
        </article>
        <button v-if="store.authorityState === 'idb'" type="button" class="workspace-button" data-action="preview-restore" :disabled="busy || !authorityReady" @click="previewRestore">预览复导差异与冲突</button>
        <div v-if="preview" aria-label="复导完整差异">
          <h3>逐条复导差异</h3><p>新增 {{ preview.added }} · 无变化 {{ preview.noops }} · 冲突 {{ preview.conflicts }}</p>
          <article v-for="row in preview.rows" :key="row.key" class="workspace-row" :class="{ 'workspace-conflict': row.action === 'conflict' }"><h4>{{ row.key }} · {{ row.action === 'add' ? '新增' : row.action === 'noop' ? '无变化' : '冲突：不覆盖' }}</h4><dl><dt>当前完整记录</dt><dd><pre>{{ row.before ? JSON.stringify(row.before, null, 2) : '不存在' }}</pre></dd><dt>当前更新时间</dt><dd>{{ row.before ? currentTimes.get(row.key) ?? '未知（null）' : '不存在' }}</dd><dt>备份完整记录</dt><dd><pre>{{ JSON.stringify(row.after, null, 2) }}</pre></dd><dt>备份更新时间</dt><dd>{{ selectedTimes.get(row.key) ?? '未知（null）' }}</dd></dl></article>
          <p v-if="!preview.canApply" class="workspace-error">存在冲突或没有可新增记录，不能复导。删除记录不会自动复活。</p>
        </div>
        <template v-if="store.authorityState === 'activating'">
          <p class="workspace-note">这里只核对已经保存的权威切换结果，不重新导入业务记录。必须使用原切换对应的备份和完整摘要；缺少匹配回执保持暂停。</p>
          <label class="workspace-check"><input name="owner-workspace-reconcile-confirm" type="checkbox" :checked="reconcileConfirmed" :disabled="busy" @change="reconcileConfirmed = ($event.target as HTMLInputElement).checked" /><span>我已核对所有预览及原备份，只核对已保存的切换结果，不重导旧记录。</span></label>
          <button type="button" class="workspace-button" data-action="reconcile-activation" :disabled="!canReconcileActivation" @click="reconcileActivation">核对已保存的权威切换</button>
        </template>
        <label v-else class="workspace-check"><input name="owner-workspace-confirm" type="checkbox" :checked="confirmed" :disabled="busy || !authorityReady" @change="confirmed = ($event.target as HTMLInputElement).checked" /><span>我已检查所有账户、真实 0 与未知值、删除及待确认项，并已在本机保留备份；仅执行下方所选本机操作，不发送云端。</span></label>
        <button v-if="store.authorityState === 'legacy'" type="button" class="workspace-button workspace-primary" data-action="activate" :disabled="!canActivate" @click="activate">启用本机工作区</button>
        <p v-if="store.authorityState === 'legacy' && verifiedSha !== exportedSha" class="workspace-note">启用须先在本轮下载当前副本，再选择同一文件核对。其他备份不能代替当前来源。</p>
        <button v-if="store.authorityState === 'idb'" type="button" class="workspace-button workspace-primary" data-action="restore" :disabled="!canRestore" @click="restore">按完整预览复导新增记录</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.owner-workspace { margin: 12px 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card-bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
.workspace-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 16px; }.workspace-heading h2 { margin: 0; font: 700 17px var(--font-display, SimSun, serif); }.workspace-heading p { margin: 6px 0 0; color: var(--text-secondary); font-size: 12px; }
.workspace-status { display: flex; flex-wrap: wrap; list-style: none; padding: 12px 16px; margin: 0; gap: 8px; border-top: 1px solid var(--border); background: var(--teal-mist); font-size: 12px; line-height: 1.6; }.workspace-status li + li::before { content: '→'; padding-right: 8px; color: var(--text-secondary); }.workspace-status .complete { font-weight: 600; }.workspace-status li:last-child { color: var(--text-secondary); }
.workspace-body { padding: 0 16px 16px; }.workspace-boundary, .workspace-note { color: var(--text-secondary); font-size: 12px; line-height: 1.7; }.workspace-boundary:first-child { border-left: 2px solid var(--gold); padding-left: 12px; }.workspace-meta { font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }.workspace-meta code { display: block; color: var(--ink); font-family: var(--font-mono, monospace); font-size: 11px; word-break: break-all; }
.workspace-button { min-height: 40px; padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--ink); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }.workspace-primary { background: var(--teal); color: var(--card-bg); border-color: var(--teal); }.workspace-button:disabled { opacity: .5; cursor: not-allowed; }.workspace-button:focus-visible, input:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.workspace-field { display: flex; flex-direction: column; gap: 8px; margin: 16px 0; color: var(--ink); font-size: 13px; }.workspace-field input { width: 100%; min-width: 0; min-height: 40px; padding: 8px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--ink); font: 12px var(--font-mono, monospace); }.workspace-field input[type=file] { white-space: normal; font-family: inherit; }
.workspace-preview { margin-top: 16px; border-top: 1px solid var(--border); }.workspace-preview h3 { margin: 16px 0 8px; font: 700 15px var(--font-display, SimSun, serif); }.workspace-preview > p { font-size: 12px; line-height: 1.7; }.workspace-row { border-top: 1px solid var(--border); padding: 12px 0; overflow-wrap: anywhere; }.workspace-row h4 { margin: 0; font-size: 13px; }.workspace-row p { margin: 8px 0; font-size: 12px; }.workspace-row dl { display: grid; grid-template-columns: minmax(85px, 1fr) minmax(0, 2fr); gap: 6px 12px; font-size: 12px; line-height: 1.6; }.workspace-row dt { color: var(--text-secondary); }.workspace-row dd { margin: 0; font-family: var(--font-mono, monospace); }.workspace-row pre { margin: 0; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }.workspace-conflict { border-left: 2px solid var(--danger); padding-left: 10px; }
.workspace-check { display: flex; align-items: flex-start; gap: 10px; margin: 16px 0; font-size: 12px; line-height: 1.7; }.workspace-check input { flex: 0 0 auto; width: 18px; height: 18px; margin: 2px 0; accent-color: var(--teal); }.workspace-error { font-size: 12px; line-height: 1.7; color: var(--danger); }.workspace-message { padding: 10px; background: var(--teal-mist); font-size: 12px; line-height: 1.7; }
@media (max-width: 390px) { .workspace-heading, .workspace-body { padding-left: 12px; padding-right: 12px; }.workspace-status { padding-left: 12px; padding-right: 12px; }.workspace-heading > .workspace-button { width: 100%; }.workspace-row dl { grid-template-columns: minmax(0, 1fr); }.workspace-row dd { margin-bottom: 5px; } }
</style>
