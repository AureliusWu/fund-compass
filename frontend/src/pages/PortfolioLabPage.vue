<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { postPortfolioLab, type PortfolioLabResp } from '@/api/client'
import { useFundsStore } from '@/stores/funds'
import { useWatchlistStore } from '@/stores/watchlist'
import { colorOf, num, pct } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import { completePortfolioWeights, holdingMarketValue, valuationCoverage } from '@/utils/portfolioCoverage'

interface LabItem { code: string; name: string; current: number | null; target: number | null; value: number | null; costComplete: boolean }

const watch = useWatchlistStore()
const funds = useFundsStore()
const items = reactive<LabItem[]>([])
const loading = ref(true)
const running = ref(false)
const error = ref('')
const result = ref<PortfolioLabResp | null>(null)
const coverage = computed(() => valuationCoverage(items))
const unpricedItems = computed(() => coverage.value.missing)
const missingCostItems = computed(() => items.filter((item) => !item.costComplete))
const portfolioReady = computed(() => coverage.value.complete && missingCostItems.value.length === 0)
const portfolioValue = computed(() => coverage.value.complete ? coverage.value.pricedValue : null)
const missingTargetItems = computed(() => items.filter((item) => item.target == null))
const invalidTargetItems = computed(() => items.filter((item) => (
  item.target != null && (!Number.isFinite(item.target) || item.target < 0 || item.target > 100)
)))
const targetTotal = computed<number | null>(() => {
  if (missingTargetItems.value.length || invalidTargetItems.value.length) return null
  let total = 0
  for (const item of items) {
    if (item.target == null) return null
    total += item.target
  }
  return Math.round(total * 10000) / 10000
})
const targetReady = computed(() => targetTotal.value === 100)
const analysisReady = computed(() => portfolioReady.value && targetReady.value)
const targetSummary = computed(() => {
  if (missingTargetItems.value.length) return `目标缺失 ${missingTargetItems.value.length} 项`
  if (invalidTargetItems.value.length) return `目标无效 ${invalidTargetItems.value.length} 项`
  return targetTotal.value == null ? '目标未就绪' : `目标 ${targetTotal.value.toFixed(1)}%`
})
const targetValidationError = computed(() => {
  if (missingTargetItems.value.length) {
    return `目标权重缺失：${missingTargetItems.value.map((item) => item.name).join('、')}。请逐项填写；系统不会自动均分。`
  }
  if (invalidTargetItems.value.length) {
    return `目标权重必须在 0% 到 100% 之间：${invalidTargetItems.value.map((item) => item.name).join('、')}。`
  }
  if (targetTotal.value != null && !targetReady.value) {
    return `目标权重合计 ${targetTotal.value.toFixed(1)}%，必须精确为 100.0%；系统不会自动归一化。`
  }
  return ''
})

function updateTarget(item: LabItem, event: Event) {
  const raw = (event.target as HTMLInputElement).value.trim()
  const parsed = raw === '' ? null : Number(raw)
  item.target = parsed != null && Number.isFinite(parsed) ? parsed : null
  result.value = null
  error.value = ''
}

onMounted(async () => {
  await watch.load(true)
  const grouped = new Map<string, { code: string; name: string; shares: number; target?: number; costComplete: boolean }>()
  for (const entry of watch.activeHoldings) {
    if (!(entry.shares && entry.shares > 0)) continue
    const row = grouped.get(entry.code) || {
      code: entry.code, name: entry.name || entry.code, shares: 0,
      target: entry.target_weight, costComplete: true,
    }
    row.shares += entry.shares
    if (entry.cost == null || !Number.isFinite(entry.cost) || entry.cost < 0) row.costComplete = false
    if (entry.target_weight != null) row.target = entry.target_weight
    grouped.set(entry.code, row)
  }
  const loaded = await Promise.all([...grouped.values()].map(async (row) => {
    try {
      const detail = await funds.detail(row.code)
      return { ...row, name: detail.name || row.name, value: holdingMarketValue(row.shares, detail.latest_nav) }
    } catch { return { ...row, value: null } }
  }))
  const currentWeights = completePortfolioWeights(loaded)
  loaded.forEach((row, index) => items.push({
    code: row.code, name: row.name, value: row.value,
    current: currentWeights?.[index] ?? null,
    target: row.target ?? null,
    costComplete: row.costComplete,
  }))
  loading.value = false
  if (items.length && analysisReady.value) await run()
})

async function run() {
  if (!items.length || running.value) return
  if (!portfolioReady.value || portfolioValue.value == null || items.some((item) => item.current == null)) {
    result.value = null
    error.value = '存在未定价或成本缺失持仓，已停止权重、回测和再平衡计算'
    return
  }
  if (!targetReady.value) {
    result.value = null
    error.value = targetValidationError.value || '目标权重必须完整且合计精确为 100.0%'
    return
  }
  const requestItems: Array<{ code: string; current_weight: number; target_weight: number }> = []
  for (const item of items) {
    if (item.current == null || item.target == null) {
      result.value = null
      error.value = '当前权重或目标权重缺失，已停止组合实验'
      return
    }
    requestItems.push({ code: item.code, current_weight: item.current, target_weight: item.target })
  }
  running.value = true; error.value = ''
  try {
    result.value = await postPortfolioLab(requestItems, portfolioValue.value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '组合分析失败'
  } finally { running.value = false }
}

const curveOption = computed(() => {
  const bt = result.value?.backtest
  if (!bt) return {}
  return {
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, data: ['月度再平衡', '买入持有', '现金'] },
    grid: { left: 46, right: 16, top: 20, bottom: 45 },
    xAxis: { type: 'category', data: bt.strategy.curve.map((row) => row.date), axisLabel: { show: false } },
    yAxis: { type: 'value', scale: true },
    series: [
      { name: '月度再平衡', type: 'line', showSymbol: false, data: bt.strategy.curve.map((row) => row.v) },
      { name: '买入持有', type: 'line', showSymbol: false, data: bt.benchmark.curve.map((row) => row.v) },
      { name: '现金', type: 'line', showSymbol: false, data: bt.cash.curve.map((row) => row.v) },
    ],
  }
})
</script>

<template>
  <div class="page">
    <van-nav-bar title="组合实验室" left-arrow @click-left="$router.back()" />
    <div class="page-body lab-page">
      <van-loading v-if="loading" class="center" />
      <van-empty v-else-if="!items.length" description="持仓基金为空" />
      <template v-else>
        <section v-if="!portfolioReady" class="coverage-error" role="alert">
          <b>组合实验已暂停</b>
          <span v-if="unpricedItems.length">净值覆盖 {{ coverage.pricedCount }}/{{ coverage.totalCount }} 只；未定价：{{ unpricedItems.map((item) => item.name).join('、') }}。</span>
          <span v-if="missingCostItems.length">成本缺失：{{ missingCostItems.map((item) => item.name).join('、') }}。</span>
          <span>缺失净值不会按 0 生成权重；净值或成本未完整时不会进入组合实验。</span>
        </section>
        <section class="weights-band">
          <div class="band-head"><b>组合权重</b><span :class="{ warn: !targetReady }">{{ targetSummary }}</span></div>
          <div v-for="item in items" :key="item.code" class="weight-row">
            <div class="fund"><b>{{ item.name }}</b><span>{{ item.code }} · 当前 {{ item.current != null ? item.current.toFixed(1) + '%' : '--' }}</span></div>
            <label class="target-input-wrap">
              <span class="sr-only">{{ item.name }}目标权重</span>
              <input
                :value="item.target ?? ''"
                type="number"
                inputmode="decimal"
                min="0"
                max="100"
                step="0.1"
                placeholder="未设置"
                :aria-invalid="item.target == null || item.target < 0 || item.target > 100"
                @input="updateTarget(item, $event)"
              >
              <em>%</em>
            </label>
          </div>
          <div v-if="targetValidationError" class="target-error" role="alert">{{ targetValidationError }}</div>
          <van-button block type="primary" size="small" :loading="running" :disabled="!analysisReady" @click="run">重新计算</van-button>
          <div v-if="error" class="error" role="alert">{{ error }}</div>
        </section>

        <template v-if="result">
          <div class="summary-grid">
            <div><span>再平衡收益</span><b :style="{ color: colorOf(result.backtest.strategy.total_return) }">{{ pct(result.backtest.strategy.total_return) }}</b></div>
            <div><span>最大回撤</span><b>{{ pct(result.backtest.strategy.max_drawdown) }}</b></div>
            <div><span>组合波动</span><b>{{ pct(result.risk.annual_volatility) }}</b></div>
            <div><span>有效持仓</span><b>{{ num(result.risk.effective_holdings, 1) }}</b></div>
          </div>

          <section class="result-band">
            <div class="band-head"><b>历史路径</b><span>{{ result.backtest.start }} ~ {{ result.backtest.end }}</span></div>
            <Chart :option="curveOption" height="250px" />
            <div class="footline">换手 {{ pct(result.backtest.turnover) }} · 摩擦 {{ result.backtest.friction_cost.toFixed(3) }}%</div>
          </section>

          <section class="result-band">
            <div class="band-head"><b>风险贡献</b><span>相关集中 {{ result.risk.correlation_concentration.toFixed(1) }}%</span></div>
            <div v-for="row in result.risk.contributions" :key="row.code" class="risk-row">
              <div><b>{{ row.name }}</b><span>仓位 {{ row.weight.toFixed(1) }}%</span></div>
              <div class="risk-bar"><i :style="{ width: Math.max(0, Math.min(100, row.risk_contribution)) + '%' }"></i></div>
              <strong>{{ row.risk_contribution.toFixed(1) }}%</strong>
            </div>
          </section>

          <section class="result-band">
            <div class="band-head"><b>再平衡清单</b><span>预计成本 {{ num(result.rebalance.estimated_cost, 2) }}</span></div>
            <div class="risk-change">
              波动 {{ pct(result.rebalance.risk_change.current_volatility) }} → {{ pct(result.rebalance.risk_change.suggested_volatility) }}
              <b :style="{ color: colorOf(result.rebalance.risk_change.delta) }">{{ pct(result.rebalance.risk_change.delta) }}</b>
            </div>
            <div v-for="row in result.rebalance.actions" :key="row.code" class="action-row">
              <div><b>{{ row.action }} · {{ row.name }}</b><span>{{ row.current_weight.toFixed(1) }}% → {{ row.suggested_weight.toFixed(1) }}%</span></div>
              <strong :style="{ color: colorOf(row.delta) }">{{ pct(row.delta) }}</strong>
              <small>{{ row.reason }}</small>
            </div>
          </section>

          <section class="result-band">
            <div class="band-head"><b>压力情景</b><span>按当前基金类型与仓位</span></div>
            <div v-for="scenario in result.stress" :key="scenario.name" class="stress-row">
              <span>{{ scenario.name }}</span>
              <b :style="{ color: colorOf(scenario.return) }">{{ pct(scenario.return) }}</b>
              <em v-if="scenario.pnl != null">{{ num(scenario.pnl, 0) }}</em>
            </div>
          </section>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lab-page { padding-bottom: 90px; }
.center { display: block; text-align: center; margin: 80px auto; }
.weights-band, .result-band { background: var(--card-bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin-bottom: 14px; padding: 12px 14px; }
.band-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.band-head b { color: var(--ink); font-size: 14px; }
.band-head span { color: var(--text-hint); font-size: 10px; }
.band-head span.warn, .error { color: var(--danger); }
.coverage-error { display: flex; flex-direction: column; gap: 4px; margin: 0 14px 14px; padding: 11px 12px; border: 1px solid var(--danger); color: var(--text-secondary); font-size: 11px; line-height: 1.55; }
.coverage-error b { color: var(--danger); font-size: 13px; }
.weight-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid var(--border); }
.fund { min-width: 0; }
.fund b, .fund span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fund b { color: var(--ink); font-size: 13px; }
.fund span { color: var(--text-hint); font-size: 10px; margin-top: 3px; }
.target-input-wrap { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.target-input-wrap input { width: 82px; height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; color: var(--ink); background: var(--card-bg); font-family: var(--font-mono); font-size: 12px; text-align: right; }
.target-input-wrap input[aria-invalid="true"] { border-color: var(--danger); }
.target-input-wrap em { color: var(--text-hint); font-size: 11px; font-style: normal; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.target-error { margin: 2px 0 10px; padding: 8px 10px; border: 1px solid var(--danger); border-radius: 8px; color: var(--text-secondary); background: var(--danger-soft); font-size: 11px; line-height: 1.55; }
.error { margin-top: 8px; font-size: 11px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--card-bg); border-bottom: 1px solid var(--border); margin-bottom: 14px; }
.summary-grid div { padding: 12px 6px; text-align: center; }
.summary-grid span, .summary-grid b { display: block; }
.summary-grid span { color: var(--text-hint); font-size: 10px; }
.summary-grid b { color: var(--ink); font-size: 15px; margin-top: 4px; }
.footline { color: var(--text-hint); font-size: 10px; text-align: right; }
.risk-row { display: grid; grid-template-columns: minmax(105px, 1.2fr) 1fr 48px; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--border); }
.risk-row b, .risk-row span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.risk-row b { color: var(--ink); font-size: 12px; }
.risk-row span { color: var(--text-hint); font-size: 10px; }
.risk-row strong { color: var(--teal); text-align: right; font-size: 12px; }
.risk-bar { height: 5px; background: var(--border); overflow: hidden; }
.risk-bar i { display: block; height: 100%; background: var(--teal); }
.action-row { display: grid; grid-template-columns: 1fr 55px; gap: 3px 10px; padding: 9px 0; border-top: 1px solid var(--border); }
.risk-change { padding: 8px 0; color: var(--text-muted); font-size: 11px; border-top: 1px solid var(--border); }
.risk-change b { float: right; }
.action-row b, .action-row span { display: block; }
.action-row b { color: var(--ink); font-size: 12px; }
.action-row span, .action-row small { color: var(--text-hint); font-size: 10px; }
.action-row strong { text-align: right; font-size: 12px; }
.action-row small { grid-column: 1 / -1; }
.stress-row { display: grid; grid-template-columns: 1fr 65px 90px; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); font-size: 12px; }
.stress-row span { color: var(--ink); }
.stress-row b, .stress-row em { text-align: right; }
.stress-row em { color: var(--text-muted); font-style: normal; }
@media (max-width: 420px) { .summary-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
