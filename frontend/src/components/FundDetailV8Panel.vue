<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ApiError,
  getV8Decision,
  getV8FundOutcomes,
  type V8DecisionResult,
  type V8FundOutcomes,
} from '@/api/client'
import {
  buildV8DetailDecisionDisplay,
  buildV8DataNotices,
  collectV8OutcomeRows,
  evidenceCategoryLabel,
  evidenceStateLabel,
  formatEvidenceValue,
  formatV8Number,
  formatV8Percent,
  formatV8Timestamp,
  pendingForDecision,
  v8EstimateAxisLabel,
} from './fundDetailV8Presenter'

const props = defineProps<{
  code: string
}>()

type LoadState = 'loading' | 'ready' | 'missing' | 'error'

const state = ref<LoadState>('loading')
const result = ref<V8DecisionResult | null>(null)
const outcomes = ref<V8FundOutcomes | null>(null)
const outcomeLoading = ref(false)
const outcomeError = ref(false)
let loadGeneration = 0

const evidence = computed(() => result.value?.evidence ?? null)
const decision = computed(() => result.value?.decision ?? null)
const position = computed(() => decision.value?.position_guidance ?? null)
const decisionDisplay = computed(() => result.value ? buildV8DetailDecisionDisplay(result.value) : null)
const notices = computed(() => evidence.value ? buildV8DataNotices(evidence.value) : [])
const outcomeRows = computed(() => collectV8OutcomeRows(outcomes.value))
const outcomePending = computed(() => decision.value
  ? pendingForDecision(outcomes.value, decision.value.decision_id)
  : { pendingHorizons: [], unavailableHorizons: [], qdiiTargetPending: false })

function shortId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > 18 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value
}

async function load() {
  const generation = ++loadGeneration
  state.value = 'loading'
  result.value = null
  outcomes.value = null
  outcomeLoading.value = true
  outcomeError.value = false

  void getV8FundOutcomes(props.code).then((value) => {
    if (generation === loadGeneration) outcomes.value = value
  }).catch(() => {
    if (generation === loadGeneration) outcomeError.value = true
  }).finally(() => {
    if (generation === loadGeneration) outcomeLoading.value = false
  })

  try {
    const value = await getV8Decision(props.code)
    if (generation !== loadGeneration) return
    result.value = value
    state.value = 'ready'
  } catch (error) {
    if (generation !== loadGeneration) return
    state.value = error instanceof ApiError && error.status === 404 ? 'missing' : 'error'
  }
}

watch(() => props.code, load, { immediate: true })
</script>

<template>
  <section class="v8-ledger" aria-labelledby="v8-ledger-title">
    <header class="ledger-head">
      <div>
        <span class="ledger-kicker">V8 DECISION LEDGER</span>
        <h2 id="v8-ledger-title">先看动作，再核对依据</h2>
      </div>
      <span class="readonly-mark">只读快照</span>
    </header>

    <div v-if="state === 'loading'" class="ledger-state" aria-live="polite">
      <span class="loading-rule" />
      <strong>正在读取 V8 决策链</strong>
      <p>旧版基金详情会继续正常加载。</p>
    </div>

    <div v-else-if="state === 'missing'" class="ledger-state missing-state" aria-live="polite">
      <span class="state-seal">待生成</span>
      <strong>这只基金尚无 V8 决策快照</strong>
      <p>404 表示“还没有生成记录”，不代表基金数据为 0，也不代表后端故障。下方旧版详情仍可查看。</p>
    </div>

    <div v-else-if="state === 'error'" class="ledger-state error-state" aria-live="polite">
      <span class="state-seal">暂不可读</span>
      <strong>V8 决策链本次请求失败</strong>
      <p>不使用缓存或推算数据冒充快照；下方旧版详情不受影响。</p>
      <button type="button" class="retry-button" @click="load">重试读取</button>
    </div>

    <div v-else-if="result && decision && evidence && decisionDisplay" class="ledger-stack">
      <article class="ledger-layer action-layer" data-layer="decision-card">
        <div class="layer-index"><span>01</span><em>DECISION</em></div>
        <div class="layer-content">
          <div class="layer-title">
            <div>
              <span class="layer-eyebrow">Decision Card</span>
              <h3>当前动作</h3>
            </div>
            <time>{{ formatV8Timestamp(decision.created_at) }}</time>
          </div>
          <div class="action-grid">
            <div class="action-stamp" :class="decisionDisplay.displayTone">
              <span>{{ decisionDisplay.displayActionLabel }}</span>
              <small>{{ decisionDisplay.displayActionCode }}</small>
            </div>
            <div class="action-copy">
              <p>{{ decisionDisplay.displaySummary }}</p>
              <div class="meter-pair">
                <div><span>动作强度</span><strong>{{ result.strength }}</strong><em>/100</em></div>
                <div><span>决策信心</span><strong>{{ result.confidence }}</strong><em>/100</em></div>
              </div>
            </div>
          </div>
          <div v-if="decisionDisplay.gated" class="gate-banner" :class="decisionDisplay.gateKind || ''">
            <strong>{{ decisionDisplay.displayActionLabel }}</strong>
            <p>{{ decisionDisplay.gateReason }}</p>
            <span>原快照动作（审计保留）：<b>{{ decisionDisplay.rawActionLabel }}</b> / {{ decisionDisplay.rawActionCode }}</span>
            <em>原快照摘要：{{ decisionDisplay.rawSummary }}</em>
          </div>
          <span v-if="decisionDisplay.gated" class="raw-audit-tag">以下是原快照理由，仅供审计</span>
          <ul class="reason-list">
            <li v-for="(reason, index) in decision.reasons" :key="decision.reason_codes[index] || reason">
              <span>{{ decision.reason_codes[index] || '理由' }}</span>{{ reason }}
            </li>
          </ul>
          <div v-if="notices.length" class="notice-list">
            <p v-for="notice in notices" :key="notice.key" :class="notice.tone">{{ notice.text }}</p>
          </div>
          <dl class="trace-line">
            <div v-if="decisionDisplay.gated"><dt>原快照动作</dt><dd>{{ decisionDisplay.rawActionLabel }} / {{ decisionDisplay.rawActionCode }}</dd></div>
            <div><dt>决策 ID</dt><dd :title="decision.decision_id">{{ shortId(decision.decision_id) }}</dd></div>
            <div><dt>策略版本</dt><dd>{{ decision.strategy_version }}</dd></div>
            <div><dt>政策版本</dt><dd :title="decision.policy_version">{{ shortId(decision.policy_version) }}</dd></div>
          </dl>
          <p class="immutable-note">页面只会按共享安全门槛暂停强动作；API 原快照动作、强度、信心和仓位数字保留供审计，AI 不能改写。</p>
        </div>
      </article>

      <article class="ledger-layer" data-layer="decision-diff">
        <div class="layer-index"><span>02</span><em>DIFF</em></div>
        <div class="layer-content">
          <div class="layer-title">
            <div><span class="layer-eyebrow">Decision Diff</span><h3>{{ decisionDisplay.gated ? '原快照变化（审计）' : '和上次相比' }}</h3></div>
            <span class="change-chip" :class="{ changed: result.diff.changed }">
              {{ result.diff.previous_decision_id == null ? '首份记录' : (result.diff.changed ? '已变化' : '未变化') }}
            </span>
          </div>
          <div class="diff-actions">
            <span>{{ result.diff.previous_action ? result.diff.previous_action : '无上次动作' }}</span>
            <i aria-hidden="true">→</i>
            <strong>{{ result.diff.current_action }}</strong>
          </div>
          <div v-if="result.diff.drivers.length" class="detail-list">
            <b>变化驱动</b>
            <p v-for="(driver, index) in result.diff.drivers" :key="result.diff.driver_codes[index] || driver">
              <span>{{ result.diff.driver_codes[index] || '驱动' }}</span>{{ driver }}
            </p>
          </div>
          <div v-else-if="result.diff.previous_decision_id == null" class="quiet-explanation">
            当前是第一份已持久化决策，暂无上一快照可比较。
          </div>
          <div v-else class="quiet-explanation">
            结构化比较未发现动作变化。<span v-if="result.diff.unchanged.length">未变项：{{ result.diff.unchanged.join('、') }}。</span>
          </div>
        </div>
      </article>

      <article class="ledger-layer" data-layer="position-guidance">
        <div class="layer-index"><span>03</span><em>POSITION</em></div>
        <div class="layer-content">
          <div class="layer-title">
            <div><span class="layer-eyebrow">Position Guidance</span><h3>仓位引导</h3></div>
            <span v-if="position" class="precision-chip" :class="{ precise: position.precise && decisionDisplay.positionExecutionAllowed, gated: !decisionDisplay.positionExecutionAllowed }">
              {{ !decisionDisplay.positionExecutionAllowed ? '执行已暂停' : (position.precise ? '精确计算' : '区间参考') }}
            </span>
          </div>
          <template v-if="position">
            <div v-if="!decisionDisplay.positionExecutionAllowed" class="position-gate">
              <strong>仓位动作已暂停</strong>
              <p>当前只展示持仓与政策背景，不将过期或低置信快照的建议变化/金额当作可执行指令。</p>
              <div>
                <span>当前权重 <b>{{ formatV8Percent(position.current_weight) }}</b></span>
                <span>政策目标 <b>{{ formatV8Percent(position.target_weight) }}</b></span>
              </div>
            </div>
            <details v-if="!decisionDisplay.positionExecutionAllowed" class="audit-position">
              <summary>查看原快照仓位数字（仅供审计）</summary>
              <div class="position-grid">
                <div><span>当前权重</span><strong>{{ formatV8Percent(position.current_weight) }}</strong></div>
                <div><span>目标权重</span><strong>{{ formatV8Percent(position.target_weight) }}</strong></div>
                <div><span>原建议变化</span><strong>{{ formatV8Percent(position.suggested_change) }}</strong></div>
                <div><span>目标区间</span><strong>{{ position.target_range ? `${formatV8Percent(position.target_range[0])} – ${formatV8Percent(position.target_range[1])}` : '—' }}</strong></div>
                <div><span>原变化区间</span><strong>{{ position.suggested_range ? `${formatV8Percent(position.suggested_range[0])} – ${formatV8Percent(position.suggested_range[1])}` : '—' }}</strong></div>
                <div><span>原对应金额</span><strong>{{ position.amount == null ? '—' : `¥${formatV8Number(position.amount)}` }}</strong></div>
              </div>
              <p class="method-line">原快照方法：{{ position.method }}</p>
            </details>
            <template v-else>
              <div class="position-grid">
                <div><span>当前权重</span><strong>{{ formatV8Percent(position.current_weight) }}</strong></div>
                <div><span>目标权重</span><strong>{{ formatV8Percent(position.target_weight) }}</strong></div>
                <div><span>建议变化</span><strong>{{ formatV8Percent(position.suggested_change) }}</strong></div>
                <div><span>目标区间</span><strong>{{ position.target_range ? `${formatV8Percent(position.target_range[0])} – ${formatV8Percent(position.target_range[1])}` : '—' }}</strong></div>
                <div><span>变化区间</span><strong>{{ position.suggested_range ? `${formatV8Percent(position.suggested_range[0])} – ${formatV8Percent(position.suggested_range[1])}` : '—' }}</strong></div>
                <div><span>对应金额</span><strong>{{ position.amount == null ? '—' : `¥${formatV8Number(position.amount)}` }}</strong></div>
              </div>
              <p class="method-line">{{ position.method }}</p>
              <p v-if="!position.precise" class="quiet-explanation">组合市值或完整权重不足，因此不伪造精确金额。— 表示未计算，不是 0。</p>
            </template>
          </template>
          <p v-else class="quiet-explanation">当前快照未给出仓位引导；空值保持为空，不推算为 0。</p>
        </div>
      </article>

      <article class="ledger-layer" data-layer="evidence-graph">
        <div class="layer-index"><span>04</span><em>EVIDENCE</em></div>
        <div class="layer-content">
          <div class="layer-title">
            <div><span class="layer-eyebrow">Evidence Graph</span><h3>证据图谱</h3></div>
            <span class="strength-chip">证据强度 {{ formatV8Number(evidence.evidence_strength, 1) }}/100</span>
          </div>
          <div v-if="evidence.evidence_nodes.length" class="evidence-grid">
            <div v-for="node in evidence.evidence_nodes" :key="node.node_id" class="evidence-node" :class="node.state">
              <span class="node-state">{{ evidenceStateLabel(node.state) }}</span>
              <b>{{ node.label }}</b>
              <div>
                <em>{{ evidenceCategoryLabel(node.category) }}</em>
                <strong v-if="formatEvidenceValue(node.value) != null">{{ formatEvidenceValue(node.value) }}</strong>
              </div>
              <small>{{ node.source_id || '内核规则' }}</small>
            </div>
          </div>
          <p v-else class="quiet-explanation">快照未记录证据节点，不用空图谱推断动作依据。</p>
          <div class="source-strip">
            <span>市场时间 {{ formatV8Timestamp(evidence.market_time) }}</span>
            <span>正式净值 {{ evidence.official_nav == null ? '—' : formatV8Number(evidence.official_nav, 4) }}<template v-if="evidence.official_nav_date"> @{{ evidence.official_nav_date }}</template></span>
            <span>{{ v8EstimateAxisLabel(evidence) }} {{ formatV8Percent(evidence.estimate) }}<template v-if="evidence.target_nav_date"> @目标日 {{ evidence.target_nav_date }}</template></span>
            <span>估值状态 {{ evidence.estimate_status }}</span>
            <span>评分覆盖 {{ formatV8Percent(evidence.score_coverage * 100, 0) }}</span>
            <span>择时覆盖 {{ formatV8Percent(evidence.timing_coverage * 100, 0) }}</span>
          </div>
        </div>
      </article>

      <article class="ledger-layer" data-layer="risk-invalidation">
        <div class="layer-index"><span>05</span><em>RISK</em></div>
        <div class="layer-content">
          <div class="layer-title">
            <div><span class="layer-eyebrow">Risk / Invalidation</span><h3>风险与失效条件</h3></div>
          </div>
          <div class="risk-grid">
            <div>
              <b>已识别风险</b>
              <ul v-if="decision.risks.length"><li v-for="risk in decision.risks" :key="risk">{{ risk }}</li></ul>
              <p v-else>本快照未记录额外风险，不等于“无风险”。</p>
            </div>
            <div>
              <b>决策何时失效</b>
              <ul>
                <li v-for="(condition, index) in decision.invalidation_conditions" :key="decision.invalidation_codes[index] || condition">
                  <span>{{ decision.invalidation_codes[index] || '条件' }}</span>{{ condition }}
                </li>
              </ul>
              <p v-if="!decision.invalidation_conditions.length">本快照未记录失效条件；当前结论只作有限参考。</p>
            </div>
          </div>
        </div>
      </article>

      <article class="ledger-layer outcome-layer" data-layer="historical-outcome">
        <div class="layer-index"><span>06</span><em>OUTCOME</em></div>
        <div class="layer-content">
          <div class="layer-title">
            <div><span class="layer-eyebrow">Historical Outcome</span><h3>历史实盘结果</h3></div>
            <span v-if="outcomes" class="sample-chip">{{ outcomes.total }} 份决策</span>
          </div>
          <p v-if="outcomeLoading" class="outcome-loading">正在单独读取历史结果；该请求不阻塞当前决策展示。</p>
          <p v-else-if="outcomeError" class="outcome-warning">历史结果本次未读取成功；当前决策快照仍可核对，不用空数据伪造结果。</p>
          <div v-else-if="outcomeRows.length" class="outcome-list">
            <div v-for="row in outcomeRows" :key="row.key" class="outcome-row">
              <div class="outcome-title"><b>{{ row.title }}</b><span>{{ row.axis }}</span></div>
              <div><span>实际收益</span><strong>{{ row.returnText }}</strong></div>
              <div><span>区间回撤</span><strong>{{ row.drawdownText }}</strong></div>
              <div v-if="row.peerExcessText"><span>同类超额</span><strong>{{ row.peerExcessText }}</strong></div>
              <div v-if="row.predictionText"><span>当时预测</span><strong>{{ row.predictionText }}</strong></div>
              <div v-if="row.predictionErrorText"><span>预测误差</span><strong>{{ row.predictionErrorText }}</strong></div>
              <em>{{ row.hitText }}</em>
            </div>
          </div>
          <div v-else class="quiet-explanation">尚无已成熟的 Outcome，不将未结算样本记为 0 收益。</div>
          <div v-if="outcomePending.pendingHorizons.length || outcomePending.unavailableHorizons.length || outcomePending.qdiiTargetPending" class="pending-list">
            <p v-if="outcomePending.pendingHorizons.length">待成熟：{{ outcomePending.pendingHorizons.join(' / ') }} 个净值观测日结果尚在积累。</p>
            <p v-if="outcomePending.unavailableHorizons.length">暂无法结算：决策基准日没有精确正式净值，不用前向填充代替。</p>
            <p v-if="outcomePending.qdiiTargetPending">QDII 目标日 Outcome 等待目标日的正式净值，缺失时不顺延配对。</p>
          </div>
          <p class="outcome-footnote">结果仅用决策当时可知信息与后续正式净值结算，不代表未来表现。</p>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.v8-ledger { margin-bottom: 18px; color: var(--ink); }
.ledger-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 14px; margin: 4px 2px 12px; }
.ledger-kicker { display: block; color: var(--teal); font-family: var(--font-mono); font-size: 9px; letter-spacing: .16em; }
.ledger-head h2 { margin: 4px 0 0; color: var(--ink); font-family: var(--font-display); font-size: 20px; line-height: 1.2; }
.readonly-mark, .state-seal { flex: none; padding: 4px 8px; border: 1px solid var(--border-strong); border-radius: 3px; color: var(--teal-deep); font-family: var(--font-display); font-size: 10px; letter-spacing: .08em; transform: rotate(-1deg); }
.ledger-state { min-height: 118px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card-bg); box-shadow: var(--shadow-sm); }
.ledger-state strong { margin-top: 8px; font-family: var(--font-display); font-size: 15px; }
.ledger-state p { max-width: 620px; margin: 6px 0 0; color: var(--text-secondary); font-size: 11px; line-height: 1.65; }
.loading-rule { width: 96px; height: 2px; overflow: hidden; background: var(--border); }
.loading-rule::after { content: ''; display: block; width: 48%; height: 100%; background: var(--teal); animation: ledger-loading 1.1s ease-in-out infinite alternate; }
.missing-state .state-seal { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 55%, var(--border)); }
.error-state .state-seal { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }
.retry-button { margin-top: 12px; padding: 6px 12px; border: 1px solid var(--teal); border-radius: 7px; color: var(--teal); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.retry-button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }

.ledger-stack { --rail-space: 54px; position: relative; }
.ledger-stack::before { content: ''; position: absolute; top: 18px; bottom: 18px; left: 24px; width: 1px; background: linear-gradient(var(--teal), var(--border-strong) 70%, transparent); }
.ledger-layer { position: relative; display: grid; grid-template-columns: var(--rail-space) minmax(0, 1fr); margin-bottom: 10px; }
.layer-index { position: relative; z-index: 1; align-self: start; display: flex; flex-direction: column; align-items: center; padding-top: 14px; }
.layer-index span { display: grid; place-items: center; width: 31px; height: 31px; border: 1px solid var(--teal); border-radius: 50%; color: var(--teal-deep); background: var(--bg); font-family: var(--font-mono); font-size: 10px; }
.layer-index em { margin-top: 7px; color: var(--text-hint); font-family: var(--font-mono); font-size: 7px; font-style: normal; letter-spacing: .08em; writing-mode: vertical-rl; }
.layer-content { min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card-bg); box-shadow: var(--shadow-sm); }
.layer-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.layer-title h3 { margin: 2px 0 0; color: var(--ink); font-family: var(--font-display); font-size: 16px; }
.layer-title time { color: var(--text-hint); font-family: var(--font-mono); font-size: 9px; }
.layer-eyebrow { color: var(--teal); font-family: var(--font-mono); font-size: 8px; letter-spacing: .11em; text-transform: uppercase; }

.action-layer .layer-content { border-top: 3px solid var(--teal-deep); }
.action-grid { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 16px; align-items: stretch; }
.action-stamp { min-height: 88px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid currentColor; border-radius: 5px; background: var(--teal-soft); transform: rotate(-.6deg); }
.action-stamp span { font-family: var(--font-display); font-size: 27px; font-weight: 700; letter-spacing: .08em; }
.action-stamp small { margin-top: 4px; font-family: var(--font-mono); font-size: 8px; letter-spacing: .14em; text-transform: uppercase; }
.action-stamp.positive { color: var(--teal-deep); background: var(--teal-soft); }
.action-stamp.neutral { color: var(--ink-muted); background: color-mix(in srgb, var(--ink) 5%, var(--card-bg)); }
.action-stamp.caution { color: var(--gold); background: var(--gold-soft); }
.action-stamp.danger { color: var(--danger); background: var(--danger-soft); }
.action-copy { min-width: 0; display: flex; flex-direction: column; justify-content: space-between; }
.action-copy > p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.65; }
.gate-banner { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 10px; padding: 10px; margin-top: 12px; border: 1px solid color-mix(in srgb, var(--danger) 34%, var(--border)); border-left: 3px solid var(--danger); border-radius: 7px; background: var(--danger-soft); }
.gate-banner.low_confidence { border-color: color-mix(in srgb, var(--gold) 40%, var(--border)); border-left-color: var(--gold); background: var(--gold-soft); }
.gate-banner strong { grid-row: 1 / 3; align-self: center; color: var(--danger); font-family: var(--font-display); font-size: 14px; }
.gate-banner.low_confidence strong { color: var(--gold); }
.gate-banner p, .gate-banner span, .gate-banner em { margin: 0; color: var(--text-secondary); font-size: 10px; font-style: normal; line-height: 1.5; }
.gate-banner span b { color: var(--ink); }
.gate-banner em { grid-column: 2; color: var(--text-hint); }
.raw-audit-tag { display: block; margin-top: 10px; color: var(--text-hint); font-size: 9px; }
.meter-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.meter-pair div { padding-top: 7px; border-top: 1px solid var(--border); }
.meter-pair span { display: block; color: var(--text-hint); font-size: 9px; }
.meter-pair strong { color: var(--ink); font-family: var(--font-mono); font-size: 20px; font-weight: 500; }
.meter-pair em { color: var(--text-hint); font-family: var(--font-mono); font-size: 8px; font-style: normal; }
.reason-list { display: grid; gap: 5px; padding: 0; margin: 12px 0 0; list-style: none; }
.reason-list li, .detail-list p { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.55; }
.reason-list span, .detail-list p span, .risk-grid li span { display: inline-block; margin-right: 7px; color: var(--teal); font-family: var(--font-mono); font-size: 8px; }
.notice-list { display: grid; gap: 5px; margin-top: 11px; }
.notice-list p { margin: 0; padding: 7px 9px; border-left: 2px solid var(--teal); color: var(--text-secondary); background: var(--teal-soft); font-size: 10px; line-height: 1.55; }
.notice-list p.warning { border-left-color: var(--gold); background: var(--gold-soft); }
.notice-list p.danger { border-left-color: var(--danger); background: var(--danger-soft); }
.trace-line { display: grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: 8px; padding-top: 10px; margin: 12px 0 0; border-top: 1px dashed var(--border-strong); }
.trace-line div { min-width: 0; }
.trace-line dt { color: var(--text-hint); font-size: 8px; }
.trace-line dd { overflow: hidden; margin: 3px 0 0; color: var(--text-secondary); font-family: var(--font-mono); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.immutable-note, .outcome-footnote { margin: 10px 0 0; color: var(--text-hint); font-size: 9px; line-height: 1.6; }

.change-chip, .precision-chip, .strength-chip, .sample-chip { flex: none; padding: 3px 7px; border: 1px solid var(--border); border-radius: 10px; color: var(--text-hint); font-size: 9px; }
.change-chip.changed { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 45%, var(--border)); background: var(--gold-soft); }
.precision-chip.precise, .strength-chip { color: var(--teal); border-color: color-mix(in srgb, var(--teal) 38%, var(--border)); background: var(--teal-soft); }
.precision-chip.gated { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 38%, var(--border)); background: var(--danger-soft); }
.diff-actions { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-left: 2px solid var(--teal); background: var(--teal-soft); font-family: var(--font-mono); font-size: 12px; }
.diff-actions span { color: var(--text-hint); }.diff-actions i { color: var(--text-hint); font-style: normal; }.diff-actions strong { color: var(--teal-deep); }
.detail-list { margin-top: 12px; }.detail-list > b { display: block; margin-bottom: 6px; color: var(--ink); font-size: 11px; }
.quiet-explanation { padding: 10px; color: var(--text-secondary); background: color-mix(in srgb, var(--ink) 3%, var(--card-bg)); border-radius: 7px; font-size: 11px; line-height: 1.6; }

.position-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--border); border-left: 1px solid var(--border); }
.position-grid div { min-width: 0; padding: 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.position-grid span { display: block; color: var(--text-hint); font-size: 9px; }
.position-grid strong { display: block; overflow: hidden; margin-top: 4px; color: var(--ink); font-family: var(--font-mono); font-size: 12px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.method-line { margin: 10px 0; color: var(--text-secondary); font-size: 11px; line-height: 1.6; }
.position-gate { padding: 11px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); border-left: 3px solid var(--danger); border-radius: 8px; background: var(--danger-soft); }
.position-gate > strong { color: var(--danger); font-family: var(--font-display); font-size: 13px; }
.position-gate p { margin: 4px 0 9px; color: var(--text-secondary); font-size: 10px; line-height: 1.55; }
.position-gate > div { display: flex; flex-wrap: wrap; gap: 8px 18px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--danger) 18%, var(--border)); }
.position-gate span { color: var(--text-secondary); font-size: 10px; }.position-gate b { color: var(--ink); font-family: var(--font-mono); font-weight: 500; }
.audit-position { margin-top: 9px; border: 1px dashed var(--border-strong); border-radius: 8px; }
.audit-position summary { padding: 9px 10px; color: var(--text-secondary); font-size: 10px; cursor: pointer; }
.audit-position[open] summary { border-bottom: 1px dashed var(--border); }
.audit-position .position-grid { margin: 10px 10px 0; opacity: .78; }
.audit-position .method-line { margin: 8px 10px 10px; color: var(--text-hint); font-size: 9px; }

.evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.evidence-node { position: relative; min-width: 0; padding: 10px 10px 8px 13px; border: 1px solid var(--border); border-left: 3px solid var(--text-hint); border-radius: 7px; }
.evidence-node.support { border-left-color: var(--success); }.evidence-node.constraint { border-left-color: var(--danger); }.evidence-node.neutral { border-left-color: var(--gold); }.evidence-node.missing { border-left-style: dashed; }
.node-state { position: absolute; top: 8px; right: 8px; color: var(--text-hint); font-size: 8px; }
.evidence-node b { display: block; padding-right: 38px; color: var(--ink); font-size: 11px; line-height: 1.45; }
.evidence-node > div { display: flex; justify-content: space-between; gap: 8px; margin-top: 7px; }
.evidence-node em, .evidence-node strong { font-size: 9px; font-style: normal; font-weight: 500; }
.evidence-node em { color: var(--text-secondary); }.evidence-node strong { color: var(--teal); font-family: var(--font-mono); }
.evidence-node small { display: block; overflow: hidden; margin-top: 5px; color: var(--text-hint); font-family: var(--font-mono); font-size: 7px; text-overflow: ellipsis; white-space: nowrap; }
.source-strip { display: flex; flex-wrap: wrap; gap: 5px 12px; padding-top: 10px; margin-top: 11px; border-top: 1px dashed var(--border); color: var(--text-hint); font-family: var(--font-mono); font-size: 8px; }

.risk-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.risk-grid > div { padding: 11px; border: 1px solid var(--border); border-radius: 8px; }
.risk-grid > div:first-child { border-top-color: var(--gold); }.risk-grid > div:last-child { border-top-color: var(--danger); }
.risk-grid b { color: var(--ink); font-family: var(--font-display); font-size: 12px; }
.risk-grid ul { display: grid; gap: 6px; padding-left: 15px; margin: 9px 0 0; }
.risk-grid li, .risk-grid p { color: var(--text-secondary); font-size: 10px; line-height: 1.55; }
.risk-grid p { margin: 9px 0 0; }

.outcome-warning, .outcome-loading { padding: 9px; margin: 0; border-left: 2px solid var(--danger); color: var(--text-secondary); background: var(--danger-soft); font-size: 10px; line-height: 1.55; }
.outcome-loading { border-left-color: var(--teal); background: var(--teal-soft); }
.outcome-list { display: grid; gap: 7px; }
.outcome-row { display: grid; grid-template-columns: minmax(150px, 1.5fr) repeat(2, minmax(72px, .7fr)) auto; gap: 9px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); }
.outcome-row:last-child { border-bottom: 0; }
.outcome-title b, .outcome-title span { display: block; }.outcome-title b { color: var(--ink); font-size: 11px; }.outcome-title span { margin-top: 3px; color: var(--text-hint); font-family: var(--font-mono); font-size: 8px; }
.outcome-row > div > span { display: block; color: var(--text-hint); font-size: 8px; }.outcome-row > div > strong { color: var(--ink); font-family: var(--font-mono); font-size: 11px; font-weight: 500; }
.outcome-row > em { color: var(--teal); font-size: 9px; font-style: normal; }
.pending-list { display: grid; gap: 5px; margin-top: 9px; }.pending-list p { margin: 0; padding-left: 9px; border-left: 2px solid var(--gold); color: var(--text-secondary); font-size: 10px; line-height: 1.55; }

@keyframes ledger-loading { from { transform: translateX(0); } to { transform: translateX(108%); } }

@media (max-width: 560px) {
  .ledger-stack { --rail-space: 38px; }
  .ledger-stack::before { left: 15px; }
  .layer-index { align-items: flex-start; padding-top: 14px; }
  .layer-index span { width: 29px; height: 29px; }
  .layer-index em { display: none; }
  .layer-content { padding: 12px; }
  .action-grid { grid-template-columns: 78px minmax(0, 1fr); gap: 11px; }
  .action-stamp { min-height: 84px; }.action-stamp span { font-size: 22px; }
  .trace-line, .position-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .evidence-grid, .risk-grid { grid-template-columns: 1fr; }
  .outcome-row { grid-template-columns: minmax(0, 1fr) repeat(2, minmax(58px, auto)); }
  .outcome-row > div:nth-of-type(n+4) { display: none; }
  .outcome-row > em { grid-column: 1 / -1; }
}

@media (prefers-reduced-motion: reduce) {
  .loading-rule::after { animation: none; width: 100%; }
  .action-stamp, .readonly-mark, .state-seal { transform: none; }
}
</style>
