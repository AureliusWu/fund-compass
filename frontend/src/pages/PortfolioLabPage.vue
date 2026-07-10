<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { getFundDetail, postPortfolioLab, type PortfolioLabResp } from '@/api/client'
import { useWatchlistStore } from '@/stores/watchlist'
import { colorOf, num, pct } from '@/utils/format'
import Chart from '@/components/Chart.vue'

interface LabItem { code: string; name: string; current: number; target: number; value: number }

const watch = useWatchlistStore()
const items = reactive<LabItem[]>([])
const loading = ref(true)
const running = ref(false)
const error = ref('')
const result = ref<PortfolioLabResp | null>(null)
const portfolioValue = computed(() => items.reduce((sum, item) => sum + item.value, 0))
const targetTotal = computed(() => items.reduce((sum, item) => sum + Number(item.target || 0), 0))

onMounted(async () => {
  await watch.load(true)
  const grouped = new Map<string, { code: string; name: string; shares: number; target?: number }>()
  for (const entry of watch.activeHoldings) {
    if (!(entry.shares && entry.shares > 0)) continue
    const row = grouped.get(entry.code) || { code: entry.code, name: entry.name || entry.code, shares: 0, target: entry.target_weight }
    row.shares += entry.shares
    if (entry.target_weight != null) row.target = entry.target_weight
    grouped.set(entry.code, row)
  }
  const loaded = await Promise.all([...grouped.values()].map(async (row) => {
    try {
      const detail = await getFundDetail(row.code)
      return { ...row, name: detail.name || row.name, value: row.shares * (detail.latest_nav || 0) }
    } catch { return { ...row, value: 0 } }
  }))
  const total = loaded.reduce((sum, row) => sum + row.value, 0)
  const explicit = loaded.reduce((sum, row) => sum + (row.target ?? 0), 0)
  const unset = loaded.filter((row) => row.target == null).length
  const fallback = unset ? Math.max(0, 100 - explicit) / unset : 0
  loaded.forEach((row) => items.push({
    code: row.code, name: row.name, value: row.value,
    current: total > 0 ? row.value / total * 100 : 0,
    target: row.target ?? fallback,
  }))
  loading.value = false
  if (items.length) await run()
})

async function run() {
  if (!items.length || running.value) return
  const totalTarget = items.reduce((sum, item) => sum + Number(item.target || 0), 0)
  if (totalTarget <= 0) { error.value = '目标权重合计需大于 0'; return }
  if (Math.abs(totalTarget - 100) > 0.01) {
    items.forEach((item) => { item.target = Number(item.target || 0) / totalTarget * 100 })
  }
  running.value = true; error.value = ''
  try {
    result.value = await postPortfolioLab(items.map((item) => ({
      code: item.code, current_weight: item.current, target_weight: Number(item.target || 0),
    })), portfolioValue.value)
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
        <section class="weights-band">
          <div class="band-head"><b>组合权重</b><span :class="{ warn: Math.abs(targetTotal - 100) > 0.1 }">目标 {{ targetTotal.toFixed(1) }}%</span></div>
          <div v-for="item in items" :key="item.code" class="weight-row">
            <div class="fund"><b>{{ item.name }}</b><span>{{ item.code }} · 当前 {{ item.current.toFixed(1) }}%</span></div>
            <van-stepper v-model="item.target" :min="0" :max="100" :step="1" decimal-length="1" input-width="48px" button-size="24px" />
          </div>
          <van-button block type="primary" size="small" :loading="running" @click="run">重新计算</van-button>
          <div v-if="error" class="error">{{ error }}</div>
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
.weight-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid var(--border); }
.fund { min-width: 0; }
.fund b, .fund span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fund b { color: var(--ink); font-size: 13px; }
.fund span { color: var(--text-hint); font-size: 10px; margin-top: 3px; }
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
