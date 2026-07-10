<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { loadOverseasAccuracy, type AccuracyReport } from '@/utils/overseasAccuracy'

const report = ref<AccuracyReport | null>(null)
onMounted(async () => { report.value = await loadOverseasAccuracy() })

const funds = computed(() => {
  if (!report.value) return []
  return Object.entries(report.value.summary)
    .filter(([code]) => code === '018147' || code === '012920')
    .map(([code, summary]) => ({
      code,
      summary,
      anomaly: report.value!.records.find((row) => row.code === code && row.status === 'observed_only'),
    }))
})

const value = (n: number | null, suffix = '%') => n == null ? '--' : `${n.toFixed(2)}${suffix}`
</script>

<template>
  <section v-if="funds.length" class="accuracy-section">
    <div class="section-title">海外估值精度</div>
    <div v-for="fund in funds" :key="fund.code" class="accuracy-row">
      <div class="accuracy-head">
        <div><b>{{ fund.code }}</b><span>{{ fund.summary.confidence }}</span></div>
        <em>{{ fund.summary.samples }} 个可训练样本</em>
      </div>
      <div class="accuracy-metrics">
        <div><span>平均误差</span><b>{{ value(fund.summary.mae) }}</b></div>
        <div><span>方向命中</span><b>{{ value(fund.summary.direction_accuracy) }}</b></div>
        <div><span>误差区间</span><b>{{ fund.summary.error_band == null ? '--' : '±' + value(fund.summary.error_band) }}</b></div>
      </div>
      <div class="trend-row" v-if="fund.summary.rolling_5 || fund.summary.rolling_20">
        <span>近5次 MAE {{ value(fund.summary.rolling_5?.mae ?? null) }}</span>
        <span>近20次 MAE {{ value(fund.summary.rolling_20?.mae ?? null) }}</span>
        <span>P95 {{ value(fund.summary.error_percentiles?.p95 ?? null) }}</span>
      </div>
      <div class="quality-row" v-if="(fund.summary.pending || 0) + (fund.summary.stale || 0) > 0">
        待结算 {{ fund.summary.pending || 0 }} · 异常等待 {{ fund.summary.stale || 0 }}
      </div>
      <div v-if="fund.anomaly" class="anomaly">
        {{ fund.anomaly.display_date }} 可见净值对应 {{ fund.anomaly.target_nav_date }}：{{ value(fund.anomaly.actual_change ?? null) }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.accuracy-section { margin-top: 18px; border-top: 1px solid var(--border); background: var(--card-bg); }
.section-title { padding: 13px 14px 8px; color: var(--ink); font-size: 15px; font-weight: 600; }
.accuracy-row { padding: 12px 14px; border-bottom: 1px solid var(--border); }
.accuracy-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.accuracy-head b { display: block; color: var(--ink); font-size: 14px; }
.accuracy-head span { display: block; color: var(--teal); font-size: 11px; margin-top: 3px; }
.accuracy-head em { color: var(--text-hint); font-size: 11px; font-style: normal; }
.accuracy-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }
.accuracy-metrics div { border-left: 2px solid var(--border); padding-left: 8px; }
.accuracy-metrics span, .accuracy-metrics b { display: block; }
.accuracy-metrics span { color: var(--text-hint); font-size: 10px; }
.accuracy-metrics b { color: var(--ink); font-size: 13px; margin-top: 3px; }
.anomaly { margin-top: 10px; color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.trend-row { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-top: 10px; color: var(--text-muted); font-size: 11px; }
.quality-row { margin-top: 7px; color: var(--warn); font-size: 11px; }
</style>
