<script setup lang="ts">
import { computed } from 'vue'
import type { V8DecisionResult } from '@/api/client'
import {
  HOME_ACTION_CONFIDENCE_GATE,
  decisionChangeText,
  formatCstTime,
  formatNullableNumber,
  homeActionTone,
  homeDisplayAction,
  isActionableAction,
  isV8DecisionLowConfidence,
  isV8DecisionStale,
  primaryDecisionReason,
  sortHomeActions,
  summarizeHomeActions,
  type HomeDecisionError,
} from './homeActionCenter'

const props = defineProps<{
  decisions: V8DecisionResult[]
  errors: HomeDecisionError[]
  requested: number
  loading: boolean
}>()

const ordered = computed(() => sortHomeActions(props.decisions))
const summary = computed(() => summarizeHomeActions(props.decisions, props.errors))
const completed = computed(() => props.decisions.length + props.errors.length)
const hasPartialFailure = computed(() => props.decisions.length > 0 && props.errors.length > 0)
const staleCount = computed(() => props.decisions.filter(isV8DecisionStale).length)
const lowConfidenceCount = computed(() => props.decisions.filter(isV8DecisionLowConfidence).length)
const latestEvidenceTime = computed(() => {
  const values = props.decisions
    .map((item) => item.evidence.market_time || item.evidence.created_at || item.decision.created_at)
    .filter((value): value is string => Boolean(value))
    .sort()
  return values.length ? values[values.length - 1] : null
})

const headline = computed(() => {
  if (props.loading && completed.value === 0) return '正在整理今天的证据。'
  if (props.requested === 0) return '从一只自选开始。'
  if (summary.value.redacted > 0 && props.decisions.length === 0) return '私人决策快照未公开。'
  if (props.decisions.length === 0) return '先恢复决策数据，再做动作。'
  if (summary.value.dataIssues > 0) {
    return `${props.decisions.length} 项可查看，${summary.value.dataIssues} 项需先核对。`
  }
  return summary.value.action > 0 ? '先看需要改变的事。' : '今天没有需要追赶的动作。'
})

const freshnessClass = computed(() => {
  if (summary.value.dataIssues > 0) return staleCount.value > 0 ? 'bad' : 'warn'
  if (props.loading || lowConfidenceCount.value > 0) return 'warn'
  return 'ok'
})

const freshnessText = computed(() => {
  if (props.loading) return `已读取 ${completed.value}/${props.requested}`
  if (props.requested === 0) return '等待添加自选'
  if (staleCount.value > 0) return `${staleCount.value} 只关键证据过期`
  if (summary.value.redacted > 0) return `${summary.value.redacted} 只私人快照未公开`
  if (props.errors.length > 0) return `已生成 ${props.decisions.length}/${props.requested}`
  if (lowConfidenceCount.value > 0) return `${lowConfidenceCount.value} 只低置信，强动作已关闭`
  return `证据已更新 · ${formatCstTime(latestEvidenceTime.value)}`
})

const boundaryText = computed(() => {
  if (props.requested === 0) return '页面不会为了填满区块而制造建议。'
  if (summary.value.redacted > 0) return '匿名页面不能读取私人决策；这不表示记录不存在，动作与持仓统计保持不可用。公开基金分析仍可查看。'
  if (staleCount.value > 0) return '过期证据下的强动作在首页安全降级为观察；原快照仍以标签保留，缺失值保持为空。'
  if (hasPartialFailure.value) return '只汇总成功读取的 V8 快照；未生成或读取失败的基金不参与精确组合结论。'
  if (lowConfidenceCount.value > 0) return '低置信的强动作只列为观察，不会在首页升级为可执行结论。'
  return '正式净值、盘中市场证据与下一净值日估算分别展示；任何缺失值都不会被替换为 0。'
})

function originalActionVisible(result: V8DecisionResult): boolean {
  return isActionableAction(result.action)
    && (isV8DecisionStale(result) || isV8DecisionLowConfidence(result))
}

function sourceIssueCount(result: V8DecisionResult): number {
  return result.evidence.source_states.filter((source) => (
    source.stale || source.state === 'stale' || source.state === 'unavailable'
  )).length
}
</script>

<template>
  <section class="action-center" aria-labelledby="today-action-title">
    <header class="action-intro">
      <div>
        <small>今日行动中心</small>
        <h1 id="today-action-title">{{ headline }}</h1>
        <p>动作来自确定性 V8 快照；指标作为证据，不替代你的资产配置目标。</p>
      </div>
      <div class="freshness" :class="freshnessClass" role="status" aria-live="polite">
        <i></i>{{ freshnessText }}
      </div>
    </header>

    <div class="action-layout">
      <section class="action-ledger" aria-label="V8 自选决策">
        <div class="distribution" aria-label="行动分布">
          <div class="do"><span>需要动作</span><b>{{ (loading && !completed) || summary.redacted ? '—' : summary.action }}</b></div>
          <div class="hold"><span>继续持有</span><b>{{ (loading && !completed) || summary.redacted ? '—' : summary.hold }}</b></div>
          <div class="watch"><span>观察</span><b>{{ (loading && !completed) || summary.redacted ? '—' : summary.watch }}</b></div>
          <div class="error"><span>数据异常</span><b>{{ loading && !completed ? '—' : summary.dataIssues }}</b></div>
        </div>

        <template v-if="loading && completed === 0">
          <div class="section-head"><h2>正在整理今天的证据</h2><span>不展示未完成结论</span></div>
          <div class="empty-state skeleton" aria-label="V8 决策加载中">
            <span></span><span></span><span></span><span></span>
          </div>
        </template>

        <div v-else-if="requested === 0" class="empty-state">
          <div class="compass-mark" aria-hidden="true">南</div>
          <b>还没有需要分析的基金</b>
          <p>先去选基或添加自选。系统不会为了填满页面而制造建议。</p>
          <div class="empty-links"><router-link to="/screen">去选基</router-link><router-link to="/watch">管理自选</router-link></div>
        </div>

        <div v-else-if="decisions.length === 0" class="empty-state unavailable-state">
          <div class="compass-mark" aria-hidden="true">·</div>
          <b>V8 决策暂不可用</b>
          <p v-if="summary.redacted">私人数据未公开；不能据此判断是否已生成快照。无需反复刷新，公开基金详情仍可查看。</p>
          <p v-if="summary.missing">其中 {{ summary.missing }} 只尚无 V8 决策（404）；这些位置不会用旧信号填充。</p>
          <p v-if="summary.failed">{{ summary.failed }} 只读取失败，请检查服务或稍后下拉刷新。</p>
        </div>

        <template v-else>
          <div class="section-head">
            <h2>优先关注</h2>
            <span>{{ loading ? '仍在补齐快照' : '按动作紧迫度与证据强度排序' }}</span>
          </div>

          <div v-if="errors.length" class="partial-note" role="alert">
            <b>部分结果不可读取</b>
            <span v-for="issue in errors" :key="issue.code">
              {{ issue.name || issue.code }}（{{ issue.code }}）·
              {{ issue.kind === 'redacted' ? '私人数据未公开' : issue.kind === 'missing' ? '尚无 V8 决策（404）' : 'V8 决策读取失败' }}
            </span>
          </div>

          <div class="compass-list">
            <article
              v-for="result in ordered"
              :key="result.decision.decision_id"
              class="action-card"
              :class="[homeActionTone(result), { stale: isV8DecisionStale(result), low: isV8DecisionLowConfidence(result) }]"
            >
              <div class="action-head">
                <router-link class="fund" :to="`/fund/${result.code}`">
                  <b>{{ result.name || result.code }}</b>
                  <span>{{ result.code }} · {{ result.decision.decision_id }}</span>
                </router-link>
                <div class="action-stamp">{{ homeDisplayAction(result) }}</div>
              </div>
              <div v-if="originalActionVisible(result)" class="snapshot-action">
                原快照动作：{{ result.action_label }}·首页已安全降级
              </div>
              <p class="why">{{ primaryDecisionReason(result) }}</p>
              <div class="metrics">
                <span>强度 {{ result.strength }}</span>
                <span :class="{ low: isV8DecisionLowConfidence(result) }">可信度 {{ result.confidence }}</span>
                <span>证据强度 {{ result.evidence.evidence_strength }}</span>
                <span v-if="isV8DecisionLowConfidence(result)" class="low">低于 {{ HOME_ACTION_CONFIDENCE_GATE }} 门槛</span>
                <span v-if="isV8DecisionStale(result)" class="danger">过期字段 {{ result.evidence.stale_fields.length }}·异常源 {{ sourceIssueCount(result) }}</span>
              </div>
              <div class="evidence-line">
                <span>正式净值 <b>{{ formatNullableNumber(result.evidence.official_nav) }}</b></span>
                <span>净值日 <b>{{ result.evidence.official_nav_date || '—' }}</b></span>
                <span v-if="result.evidence.target_nav_date">目标净值日 <b>{{ result.evidence.target_nav_date }}</b></span>
                <span>证据时间 <b>{{ formatCstTime(result.evidence.market_time || result.evidence.created_at) }}</b></span>
              </div>
              <div class="diff"><b>变化原因</b><span>{{ decisionChangeText(result) }}</span></div>
              <details>
                <summary>什么情况下会改变</summary>
                <ul v-if="result.decision.invalidation_conditions.length">
                  <li v-for="condition in result.decision.invalidation_conditions" :key="condition">{{ condition }}</li>
                </ul>
                <p v-else>快照未提供失效条件，当前结论仅供观察。</p>
              </details>
            </article>
          </div>
        </template>
      </section>

      <aside class="action-side">
        <section class="boundary-panel">
          <h2>数据边界</h2>
          <div class="boundary">{{ boundaryText }}</div>
        </section>
        <section class="boundary-panel coverage-panel">
          <h2>快照覆盖</h2>
          <dl>
            <div><dt>自选</dt><dd>{{ requested }}</dd></div>
            <div><dt>已读取</dt><dd>{{ decisions.length }}</dd></div>
            <div><dt>404</dt><dd>{{ summary.missing }}</dd></div>
            <div><dt>读取失败</dt><dd>{{ summary.failed }}</dd></div>
            <div v-if="summary.redacted"><dt>未公开</dt><dd>{{ summary.redacted }}</dd></div>
          </dl>
          <p>只使用 V8 Decision Snapshot，不用 legacy signal 冒充缺失决策。</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.action-center { margin-bottom: 24px; }
.action-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 22px; padding: 14px 2px 18px; }
.action-intro small { color: var(--teal); font-size: 11px; font-weight: 700; letter-spacing: .18em; }
.action-intro h1 { margin: 7px 0 6px; color: var(--ink); font-family: var(--font-display); font-size: clamp(27px, 4.5vw, 42px); line-height: 1.1; letter-spacing: .02em; }
.action-intro p { max-width: 660px; margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.freshness { flex: 0 0 auto; padding: 8px 11px; border: 1px solid var(--border); border-radius: 9px; color: var(--text-muted); background: var(--card-bg); font-size: 11px; box-shadow: var(--shadow-sm); }
.freshness i { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--success); }
.freshness.warn i { background: var(--gold); }.freshness.bad i { background: var(--danger); }
.action-layout { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(250px, .75fr); gap: 18px; align-items: start; }
.action-ledger, .boundary-panel { overflow: hidden; border: 1px solid var(--border); border-radius: 16px; background: var(--card-bg); box-shadow: var(--shadow); }
.distribution { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--border); }
.distribution > div { min-width: 0; padding: 15px 16px 13px; }
.distribution > div + div { border-left: 1px solid var(--border); }
.distribution span { display: block; color: var(--text-hint); font-size: 10px; }
.distribution b { display: block; margin-top: 5px; color: var(--ink); font-family: var(--font-mono); font-size: 21px; font-weight: 600; line-height: 1; }
.distribution .do b { color: var(--danger); }.distribution .hold b { color: var(--teal); }.distribution .watch b { color: var(--gold); }.distribution .error b { color: var(--text-muted); }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 18px 19px 8px; }
.section-head h2, .boundary-panel h2 { margin: 0; color: var(--ink); font-family: var(--font-display); font-size: 16px; line-height: 1.3; }
.section-head span { color: var(--text-hint); font-size: 10px; text-align: right; }
.partial-note { display: grid; gap: 4px; margin: 7px 18px 4px; padding: 10px 12px; border-left: 3px solid var(--gold); background: var(--gold-soft); color: var(--text-muted); font-size: 10px; line-height: 1.55; }
.partial-note b { color: var(--ink); font-size: 11px; }
.compass-list { position: relative; margin: 5px 18px 20px 31px; padding-left: 27px; }
.compass-list::before { content: ''; position: absolute; left: 3px; top: 12px; bottom: 18px; width: 1px; background: linear-gradient(var(--danger), var(--gold), var(--teal)); }
.action-card { --tone: var(--teal); position: relative; margin-bottom: 12px; padding: 15px 16px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--card-bg) 96%, white); }
.action-card::before { content: ''; position: absolute; left: -31px; top: 22px; width: 11px; height: 11px; border: 3px solid var(--card-bg); border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 1px var(--tone); }
.action-card::after { content: ''; position: absolute; left: -18px; top: 27px; width: 17px; height: 1px; background: var(--border); }
.action-card.buy { --tone: var(--danger); }.action-card.watch { --tone: var(--gold); }.action-card.reduce, .action-card.hold { --tone: var(--success); }
.action-card.stale { border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }.action-card.low { background: color-mix(in srgb, var(--gold-soft) 35%, var(--card-bg)); }
.action-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 14px; align-items: start; }
.fund { min-width: 0; color: inherit; text-decoration: none; }
.fund:focus-visible, summary:focus-visible { outline: 3px solid var(--gold-dim); outline-offset: 3px; }
.fund b { display: block; overflow: hidden; color: var(--ink); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.fund span { display: block; overflow: hidden; margin-top: 4px; color: var(--text-hint); font-family: var(--font-mono); font-size: 9px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.action-stamp { min-width: 70px; padding: 6px 9px; border: 1px solid var(--tone); border-radius: 6px; color: var(--tone); text-align: center; font-family: var(--font-display); font-size: 13px; font-weight: 700; line-height: 1; transform: rotate(-1.5deg); }
.snapshot-action { display: inline-flex; margin-top: 9px; padding: 4px 7px; border-radius: 5px; color: var(--danger); background: var(--danger-soft); font-size: 10px; }
.why { margin: 11px 0 10px; color: var(--ink); font-size: 12px; line-height: 1.65; }
.metrics { display: flex; flex-wrap: wrap; gap: 7px; }
.metrics span { padding: 4px 7px; border-radius: 5px; color: var(--text-muted); background: var(--teal-soft); font-family: var(--font-mono); font-size: 10px; line-height: 1.3; }
.metrics span.low { color: var(--warn); background: var(--gold-soft); }.metrics span.danger { color: var(--danger); background: var(--danger-soft); }
.evidence-line { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 10px; color: var(--text-hint); font-size: 9px; line-height: 1.5; }
.evidence-line b { color: var(--text-muted); font-family: var(--font-mono); font-weight: 500; }
.diff { display: grid; grid-template-columns: auto 1fr; gap: 8px; margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--border); color: var(--text-muted); font-size: 10px; line-height: 1.6; }
.diff b { color: var(--teal); }.diff span { min-width: 0; }
details { margin-top: 8px; color: var(--text-muted); font-size: 10px; }
summary { color: var(--teal-deep); cursor: pointer; }
details p, details ul { margin: 6px 0 0; padding-left: 18px; line-height: 1.6; }
.action-side { display: grid; gap: 12px; }
.boundary-panel { padding: 16px; }
.boundary-panel h2 { margin-bottom: 13px; }
.boundary { padding: 11px 12px; border-left: 3px solid var(--gold); background: var(--gold-soft); color: var(--text-muted); font-size: 11px; line-height: 1.7; }
.coverage-panel dl { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border: 1px solid var(--border); border-radius: 8px; }
.coverage-panel dl > div { display: flex; justify-content: space-between; gap: 8px; padding: 8px 9px; }
.coverage-panel dt { color: var(--text-hint); font-size: 10px; }.coverage-panel dd { margin: 0; color: var(--ink); font-family: var(--font-mono); font-size: 11px; }
.coverage-panel p { margin: 11px 0 0; color: var(--text-hint); font-size: 10px; line-height: 1.6; }
.empty-state { padding: 52px 24px 58px; text-align: center; }
.compass-mark { width: 56px; height: 56px; display: grid; place-items: center; margin: 0 auto 14px; border: 1px solid var(--border); border-radius: 50%; color: var(--teal); font-family: var(--font-display); font-size: 22px; font-weight: 700; }
.empty-state > b { display: block; color: var(--ink); font-family: var(--font-display); font-size: 16px; }
.empty-state p { max-width: 390px; margin: 8px auto 0; color: var(--text-muted); font-size: 11px; line-height: 1.7; }
.empty-links { display: flex; justify-content: center; gap: 18px; margin-top: 15px; }
.empty-links a { color: var(--teal); font-size: 11px; text-decoration: none; }
.unavailable-state .compass-mark { color: var(--danger); }
.skeleton { overflow: hidden; }
.skeleton span { display: block; height: 12px; margin: 10px 0; border-radius: 5px; background: linear-gradient(90deg, var(--chip-bg) 20%, var(--card-bg) 50%, var(--chip-bg) 80%); background-size: 240% 100%; animation: action-shimmer 1.4s linear infinite; }
.skeleton span:nth-child(2) { width: 72%; }.skeleton span:nth-child(3) { width: 88%; }
@keyframes action-shimmer { to { background-position: -240% 0; } }
@media (max-width: 760px) {
  .action-intro { display: block; padding: 4px 2px 14px; }
  .action-intro h1 { font-size: 27px; }
  .freshness { display: inline-block; margin-top: 10px; }
  .action-layout { display: block; }
  .action-side { margin-top: 12px; }
  .distribution > div { padding: 12px 9px; }
  .distribution b { font-size: 18px; }
  .compass-list { margin-left: 24px; padding-left: 23px; }
  .action-card::before { left: -27px; }
  .action-card::after { left: -15px; width: 14px; }
}
@media (prefers-reduced-motion: reduce) { .skeleton span { animation: none; } }
</style>
