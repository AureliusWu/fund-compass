<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useOwnerAnalysisStore } from '@/stores/ownerAnalysis'
import { useWatchlistStore } from '@/stores/watchlist'
import { ownerSession } from '@/stores/ownerSession'
import OwnerPolicyVersions from './OwnerPolicyVersions.vue'

const analysis = useOwnerAnalysisStore(), workspace = useWatchlistStore()
const consent = ref(analysis.enabled), saveConsent = ref(false), sendConsent = ref(false)
const cancelConsent = ref(false), finishConsent = ref(false), localBusy = ref(false), message = ref(''), page = ref(0)
const previewRules = ref(false)
const authenticated = computed(() => ownerSession.value?.scopes.includes('read_private')
  && ownerSession.value.scopes.includes('run_personal_analysis'))
const visible = computed(() => analysis.enabled && authenticated.value && workspace.localSyncFormat === 'v4')
const busy = computed(() => localBusy.value || analysis.enabling || analysis.view?.busy)
const task = computed(() => visible.value ? analysis.view?.slot?.task ?? null : null)
const preview = computed(() => visible.value ? analysis.view?.preview ?? null : null)
const pages = computed(() => Math.max(1, Math.ceil((preview.value?.records.length ?? 0) / 40)))
const rows = computed(() => preview.value?.records.slice(page.value * 40, (page.value + 1) * 40) ?? [])
const stateLabel = computed(() => task.value?.state === 'attempted' ? '结果未知 · 原请求保留'
  : task.value?.state === 'matched' ? '原回执已核对'
    : task.value?.state === 'prepared' ? '原包已保存 · 尚未发送' : '先核对完整来源')
function resetChecks() { saveConsent.value = sendConsent.value = cancelConsent.value = finishConsent.value = false }
watch(() => [analysis.view?.slot?.version, analysis.view?.preview?.packet.requestHash], () => { resetChecks(); page.value = 0; previewRules.value = false })
function togglePreviewRules(event: Event) { previewRules.value = (event.target as HTMLDetailsElement).open === true }
watch(() => analysis.enabled, enabled => { if (!enabled) { consent.value = false; resetChecks(); message.value = '' } })
async function work(operation: () => Promise<unknown>) {
  if (busy.value) return
  localBusy.value = true; message.value = ''
  try { await operation() }
  catch { message.value = '本次操作未完成。请查看保留的原任务；不要重复发送或以缺失回执推断未提交。' }
  finally { localBusy.value = false }
}
function disable() { analysis.disable(); consent.value = false; resetChecks(); message.value = '' }
const previewAnalysis = () => analysis.preview('owner-analysis-ui-' + globalThis.crypto.randomUUID())
function valueText(value: unknown): string {
  if (value === null) return '未知（null）'
  if (Object.is(value, -0)) return '-0'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}
function valuesText(values: Readonly<Record<string, unknown>>) {
  const names: Record<string, string> = { name: '名称', shares: '份额', cost: '单位成本', target_weight: '目标权重%', cls: '类别', value: '金额', note: '备注' }
  return Object.entries(values).map(([key, value]) => `${names[key] ?? key}：${valueText(value)}`).join('；')
}
function exportTask() {
  try {
    const value = analysis.exportTask(), url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'sinan-owner-analysis-task.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch { message.value = '原任务暂不可导出；请保留本页面和现有存储，不要重发。' }
}
</script>

<template>
  <details class="owner-analysis-panel">
    <summary>持仓分析 <span>完整来源 → 决策 → 原回执</span></summary>
    <div class="analysis-body">
      <p>仅分析已同步并应用的完整持仓。默认不发送；不会执行交易、通知，也不会临时生成策略或行情。</p>
      <p v-if="workspace.localSyncFormat === 'v5'" role="status">当前 v5 持仓分析暂未开放。完整手工资产同步与确认链仍在实现，本机基金、手工资产和余额观察不能当作云端已确认来源；请先保留资产页完整文件。</p>
      <p v-else-if="workspace.localSyncFormat === 'v6'" role="status">当前 v6 持仓分析仍暂停。本机共同基线协调不等于完整云端来源已确认，也不授予分析资格。</p>
      <p v-else-if="!authenticated" role="status">请先登录私人会话。登录本身不会启用分析。</p>
      <p v-else-if="workspace.localSyncFormat !== 'v4'">请先启用本机工作区、升级同步格式，完成同步及完整核对；未同步编辑不能当作确认持仓。</p>
      <template v-else-if="!analysis.enabled">
        <label><input v-model="consent" type="checkbox" :disabled="busy">我同意本轮读取私人策略、证据与完整持仓，并启用本机分析任务存储</label>
        <button type="button" :disabled="!consent || busy" @click="work(() => analysis.enable(true))">启用分析</button>
      </template>
      <template v-if="visible">
        <header class="analysis-status"><strong>{{ busy ? '正在核对，请勿重复操作' : stateLabel }}</strong><button type="button" @click="disable">关闭分析</button></header>
        <p role="status" aria-live="polite">{{ analysis.view?.message }}</p>
        <p v-if="analysis.qualified" class="source-seal">最近一分钟内已核对完整来源与引用链。首页、自选、详情使用同一结果，过期、已知新策略生效或失配即暂停。</p>
        <OwnerPolicyVersions :state="analysis.view?.policyState ?? null" :fresh="analysis.policyStateFresh" :busy="!!busy" @review="work(() => analysis.reviewPolicy())" />
        <div class="analysis-actions">
          <button v-if="!task || task.state === 'prepared'" type="button" :disabled="busy" @click="work(previewAnalysis)">读取并预览完整来源</button>
          <button v-if="task && task.state !== 'prepared'" type="button" :disabled="busy" @click="work(() => analysis.reconcile())">核对原回执与当前来源</button>
          <button v-if="task" type="button" :disabled="busy" @click="exportTask">导出原任务</button>
          <button type="button" :disabled="busy" @click="work(() => analysis.hydrate())">读取本机原任务</button>
        </div>
        <p v-if="task">原包 SHA：<code>{{ task.requestHash }}</code>。刷新后不会自动发送；缺失回执也不表示未提交。任务文件不含登录凭据，但仍属私人资料。</p>
        <section v-if="preview" class="analysis-preview">
          <h3>发送前核对</h3>
          <p v-if="!analysis.previewFresh" role="status">预览引用已过期。请重新读取完整来源；若策略已变化，须先明确取消尚未发送的原包，不能重制或重发原任务。</p>
          <p>完整同步版本 {{ preview.packet.request.expected_revision }} · {{ preview.records.length }} 条来源 · {{ preview.evidence.length }} 只基金。手工资产、删除记录均保留来源，但不加入基金权重分母。</p>
          <p>策略：{{ preview.policy.name }} · <code>{{ preview.policy.policy_version }}</code></p>
          <details :open="previewRules" @toggle="togglePreviewRules"><summary>查看完整策略规则</summary><pre v-if="previewRules">{{ JSON.stringify(preview.policy, null, 2) }}</pre></details>
          <div class="source-table"><table><thead><tr><th>账户 / 资产身份</th><th>类型与状态</th><th>原始业务值</th></tr></thead><tbody>
            <tr v-for="row in rows" :key="row.key"><td>{{ row.key }}</td><td>{{ row.kind === 'holding' ? '持仓（含0份）' : row.kind === 'watch' ? '仅关注' : '手工资产' }} · {{ row.deleted ? '已删除，保留历史' : '有效' }}</td><td>{{ valuesText(row.values) }}</td></tr>
          </tbody></table></div>
          <nav v-if="pages > 1" aria-label="来源记录分页"><button :disabled="page === 0" @click="page--">上一页</button><span>{{ page + 1 }} / {{ pages }}</span><button :disabled="page + 1 >= pages" @click="page++">下一页</button></nav>
          <ul class="evidence-list"><li v-for="row in preview.evidence" :key="row.fund_code"><strong>{{ row.fund_code }} {{ row.fund_name }}</strong> · 证据 {{ row.created_at }} · 正式净值 {{ valueText(row.official_nav) }} / {{ row.official_nav_date ?? '日期未知' }} · {{ row.estimate_status }}<code>{{ row.evidence_id }}</code></li></ul>
          <template v-if="!task"><label><input v-model="saveConsent" type="checkbox" :disabled="busy || !analysis.previewFresh">确认完整来源、策略和证据，保存本轮原包（尚不发送）</label><button :disabled="!saveConsent || busy || !analysis.previewFresh" @click="work(() => analysis.prepare(true))">保存原包</button></template>
          <template v-else-if="task.state === 'prepared'"><label><input v-model="sendConsent" type="checkbox" :disabled="busy || !analysis.previewFresh">确认只发送这个原包一次，失败后仅核对原回执</label><button :disabled="!sendConsent || busy || !analysis.previewFresh" @click="work(() => analysis.sendOnce(true))">单次生成分析</button></template>
        </section>
        <template v-if="task?.state === 'prepared'"><label><input v-model="cancelConsent" type="checkbox" :disabled="busy">确认取消这个尚未发送的原包</label><button :disabled="!cancelConsent || busy" @click="work(() => analysis.cancelPrepared(true))">取消未发送原包</button></template>
        <template v-if="task?.state === 'matched'"><label><input v-model="finishConsent" type="checkbox" :disabled="busy">确认结束已核对任务，刷新后不再自动找回这份结果</label><button :disabled="!finishConsent || busy" @click="work(() => analysis.finishMatched(true))">结束已核对任务</button></template>
        <p v-if="analysis.view?.result && !analysis.qualified">原回执作为历史保留，当前来源资格未通过或已过期；不能据此执行旧动作。</p>
      </template>
      <p v-if="message" role="alert">{{ message }}</p>
      <small>任务存储独立于工作区格式文件；请单独导出原任务。此流程不证明云端迁移、耐久或灾难恢复已通过。</small>
    </div>
  </details>
</template>

<style scoped>
.owner-analysis-panel { margin: 12px 0; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--card-bg); }
summary { padding: 14px 16px; cursor: pointer; color: var(--ink); font-family: var(--font-display); }
summary span { margin-left: 12px; font: 11px var(--font-mono, monospace); color: var(--text-secondary); }
.analysis-body { padding: 0 16px 16px; color: var(--text-secondary); font-size: 12px; line-height: 1.7; }
.analysis-body p { margin: 10px 0; } .analysis-body small { display: block; margin-top: 12px; }
.analysis-status, .analysis-actions, nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.analysis-status { justify-content: space-between; color: var(--ink); } .analysis-status strong { font-size: 14px; }
button { padding: 7px 12px; border: 1px solid var(--border-strong); border-radius: 5px; background: var(--card-bg); color: var(--teal-deep); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; } button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
label { display: flex; align-items: flex-start; gap: 7px; margin: 12px 0; } input { margin-top: 4px; }
.analysis-preview { border-top: 1px solid var(--border-strong); margin-top: 16px; padding-top: 8px; }
.analysis-preview h3 { color: var(--ink); font-family: var(--font-display); font-size: 15px; }
.source-seal { border-left: 3px solid var(--teal); padding: 8px 10px; background: var(--bg); }
.source-table { overflow-x: auto; } table { width: 100%; border-collapse: collapse; text-align: left; }
td, th { padding: 9px 8px; border-bottom: 1px solid var(--border-strong); min-width: 130px; vertical-align: top; }
th { color: var(--ink); } td:last-child { min-width: 230px; white-space: normal; } code { overflow-wrap: anywhere; font-size: 10px; }
pre { overflow: auto; max-height: 280px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.evidence-list { padding-left: 18px; } .evidence-list code { display: block; } nav { justify-content: center; margin-top: 8px; }
</style>
