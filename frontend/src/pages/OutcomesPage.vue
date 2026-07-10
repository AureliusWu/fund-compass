<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getPortfolioOutcomes, getStrategyOutcomes, type OutcomeMetric, type PortfolioOutcomesResp, type StrategyOutcomesResp } from '@/api/client'
import OverseasAccuracyPanel from '@/components/OverseasAccuracyPanel.vue'
import Icon from '@/components/Icon.vue'
import { loadOverseasAccuracy, type AccuracyReport } from '@/utils/overseasAccuracy'
import { exportDecisionOutcomesCSV, exportOverseasAccuracyCSV } from '@/utils/export'
import { colorOf } from '@/utils/format'

const loading = ref(true)
const error = ref('')
const data = ref<StrategyOutcomesResp | null>(null)
const dimension = ref<'action' | 'confidence' | 'type'>('action')
const horizon = ref(20)
const accuracy = ref<AccuracyReport | null>(null)
const portfolio = ref<PortfolioOutcomesResp | null>(null)
const exportOpen = ref(false)
const exportActions = [{ name: '决策实盘 CSV', key: 'decisions' }, { name: '海外误差 CSV', key: 'overseas' }]

onMounted(async () => {
  try {
    const [outcomes, overseas, portfolioOutcomes] = await Promise.all([
      getStrategyOutcomes(), loadOverseasAccuracy(), getPortfolioOutcomes().catch(() => null),
    ])
    data.value = outcomes
    accuracy.value = overseas
    portfolio.value = portfolioOutcomes
  }
  catch { error.value = '实盘结果暂时不可用' }
  finally { loading.value = false }
})

function onExport(action: { key: string }) {
  if (action.key === 'decisions' && data.value) exportDecisionOutcomesCSV(data.value)
  if (action.key === 'overseas' && accuracy.value) exportOverseasAccuracyCSV(accuracy.value)
  exportOpen.value = false
}

const rows = computed(() => (
  (data.value?.breakdowns[dimension.value] || [])
    .filter((row) => row.horizon === horizon.value)
    .sort((a, b) => b.samples - a.samples)
))

function labelOf(row: OutcomeMetric) {
  return String(row[dimension.value] || '未知')
}
function pct(value: number | null | undefined) {
  return value == null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="实盘验证" left-arrow @click-left="$router.back()">
      <template #right><Icon name="export" :size="18" @click="exportOpen = true" /></template>
    </van-nav-bar>
    <div class="page-body outcomes-page">
      <van-loading v-if="loading" class="center" />
      <van-empty v-else-if="error" :description="error" />
      <template v-else-if="data">
        <div class="overview">
          <div><b>{{ data.total }}</b><span>已记录</span></div>
          <div><b>{{ data.mature }}</b><span>已有结果</span></div>
          <div><b>{{ data.pending }}</b><span>等待成熟</span></div>
        </div>

        <div class="control-band">
          <van-tabs v-model:active="dimension" shrink>
            <van-tab title="按动作" name="action" />
            <van-tab title="按置信度" name="confidence" />
            <van-tab title="按类型" name="type" />
          </van-tabs>
          <div class="horizons">
            <button v-for="n in [5, 20, 60]" :key="n" :class="{ on: horizon === n }" @click="horizon = n">{{ n }}日</button>
          </div>
        </div>

        <div v-if="rows.length" class="result-list">
          <div v-for="row in rows" :key="labelOf(row)" class="result-row">
            <div class="result-name"><b>{{ labelOf(row) }}</b><span>{{ row.samples }} 个成熟样本</span></div>
            <div class="metric"><span>命中</span><b>{{ row.hit_rate.toFixed(1) }}%</b></div>
            <div class="metric"><span>平均收益</span><b>{{ pct(row.average_return) }}</b></div>
            <div class="metric"><span>同类超额</span><b>{{ pct(row.average_excess) }}</b></div>
            <div class="metric"><span>平均回撤</span><b>{{ pct(row.average_drawdown) }}</b></div>
          </div>
        </div>
        <van-empty v-else description="该周期还没有成熟样本" />
        <div class="method-note">仅使用决策日之后公布的净值。少量样本只展示事实，不触发模型晋级。</div>

        <section class="portfolio-outcomes" v-if="portfolio">
          <div class="po-head"><b>组合建议结果</b><span>{{ portfolio.mature }} 成熟 · {{ portfolio.pending }} 等待</span></div>
          <div v-for="item in portfolio.items.slice(0, 5)" :key="item.id" class="po-row">
            <div><b>{{ item.snapshot_date }}</b><span>{{ item.items.length }} 只 · {{ item.strategy_version }}</span></div>
            <div v-for="(outcome, key) in item.returns" :key="key"><span>{{ key }}日</span><b :style="{ color: colorOf(outcome.return) }">{{ pct(outcome.return) }}</b></div>
          </div>
          <div v-if="!portfolio.items.length" class="po-empty">暂无组合建议快照</div>
        </section>

        <OverseasAccuracyPanel />
      </template>
    </div>
    <van-action-sheet v-model:show="exportOpen" :actions="exportActions" cancel-text="取消" @select="onExport" />
  </div>
</template>

<style scoped>
.outcomes-page { padding-bottom: 90px; }
.center { display: block; text-align: center; margin: 80px auto; }
.overview { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--border); background: var(--card-bg); }
.overview div { padding: 16px 8px; text-align: center; }
.overview b { display: block; color: var(--ink); font-size: 22px; }
.overview span { color: var(--text-muted); font-size: 11px; }
.control-band { margin-top: 12px; background: var(--card-bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.horizons { display: flex; gap: 8px; padding: 10px 14px; }
.horizons button { border: 1px solid var(--border); background: transparent; color: var(--text-muted); padding: 5px 12px; border-radius: 4px; }
.horizons button.on { border-color: var(--teal); color: var(--teal); background: var(--teal-soft); }
.result-list { background: var(--card-bg); }
.result-row { display: grid; grid-template-columns: minmax(100px, 1.5fr) repeat(4, minmax(66px, 1fr)); gap: 8px; padding: 13px 14px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.result-name b, .metric b { display: block; font-size: 13px; color: var(--ink); }
.result-name span, .metric span { display: block; color: var(--text-hint); font-size: 10px; margin-bottom: 3px; }
.metric { text-align: right; min-width: 66px; }
.method-note { padding: 12px 14px; color: var(--text-hint); font-size: 11px; line-height: 1.6; }
.portfolio-outcomes { margin-top: 8px; background: var(--card-bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.po-head, .po-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 11px 14px; border-bottom: 1px solid var(--border); }
.po-head b, .po-row b { color: var(--ink); font-size: 12px; }
.po-head span, .po-row span { display: block; color: var(--text-hint); font-size: 10px; }
.po-row > div:not(:first-child) { text-align: right; }
.po-empty { padding: 18px 14px; color: var(--text-hint); font-size: 12px; text-align: center; }
@media (max-width: 520px) {
  .result-row { grid-template-columns: minmax(105px, 1.4fr) repeat(2, minmax(72px, 1fr)); }
  .metric:nth-of-type(4), .metric:nth-of-type(5) { display: none; }
}
</style>
