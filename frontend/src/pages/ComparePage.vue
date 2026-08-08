<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { showToast } from 'vant'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { pct } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import type { FundDetail, ScoreResp } from '@/api/client'
import { alignNavHistories } from '@/utils/diagnostics'

const watch = useWatchlistStore()
const funds = useFundsStore()
const selected = ref<string[]>([])
const data = reactive<Record<string, { d: FundDetail; s: ScoreResp }>>({})

onMounted(() => watch.load().catch(() => {}))

async function toggle(code: string) {
  if (selected.value.includes(code)) {
    selected.value = selected.value.filter((c) => c !== code)
    return
  }
  if (selected.value.length >= 3) { showToast('最多对比 3 只'); return }
  selected.value.push(code)
  if (!data[code]) {
    try {
      const [d, s] = await Promise.all([funds.detail(code), funds.score(code)])
      data[code] = { d, s }
    } catch { showToast('加载失败') }
  }
}

const cols = computed(() => selected.value.filter((c) => data[c]))
const headers = computed(() => cols.value.map((c) => data[c].d.name))

function riskField(c: string, key: string): string {
  const v = (data[c].s.components.risk.detail as Record<string, unknown>)[key]
  return v == null ? '--' : key === 'sharpe' ? String(v) : v + '%'
}

const rows = computed(() => {
  const m = (label: string, fn: (c: string) => string) => ({ label, vals: cols.value.map(fn) })
  return [
    m('综合评分', (c) => String(data[c].s.score ?? '--')),
    m('近1年', (c) => pct(data[c].d.ret_1y)),
    m('近3年', (c) => pct(data[c].d.ret_3y)),
    m('最大回撤', (c) => riskField(c, 'max_drawdown')),
    m('年化波动', (c) => riskField(c, 'volatility')),
    m('夏普', (c) => riskField(c, 'sharpe')),
    m('规模(亿)', (c) => (data[c].d.scale != null ? String(data[c].d.scale) : '--')),
    m('经理', (c) => data[c].d.manager || '--'),
  ]
})

const alignedNav = computed(() => alignNavHistories(
  cols.value.map((code) => ({ code, points: data[code].d.nav_history })),
))

const navOption = computed(() => {
  const aligned = alignedNav.value
  const series = cols.value.map((c) => {
    const values = aligned.values[c] || []
    const base = values[0]
    return {
      name: data[c].d.name, type: 'line' as const, showSymbol: false,
      data: base ? values.map((value) => +(value / base).toFixed(4)) : [],
    }
  })
  return {
    grid: { left: 40, right: 12, top: 32, bottom: 24 },
    tooltip: { trigger: 'axis' as const },
    legend: { top: 0, type: 'scroll' as const },
    xAxis: { type: 'category' as const, data: aligned.dates, boundaryGap: false },
    yAxis: { type: 'value' as const, scale: true },
    series,
  }
})
</script>

<template>
  <div class="page">
    <van-nav-bar title="对比" />
    <div class="page-body">
      <div class="sec">从自选中选 2–3 只</div>
      <div class="picks" v-if="watch.items.length">
        <span v-for="it in watch.items" :key="it.code" class="pick"
          :class="{ on: selected.includes(it.code) }" @click="toggle(it.code)">
          {{ it.name || it.code }}
        </span>
      </div>
      <van-empty v-else description="自选为空，先去添加基金" />

      <template v-if="headers.length">
        <div class="sec">净值走势（首日归一）</div>
        <div class="card">
          <Chart v-if="alignedNav.dates.length" :option="navOption" height="240px" />
          <van-empty v-else description="所选基金暂无共同净值日期" image-size="55" />
          <div class="nav-note">仅使用所选基金的共同净值日期，不前向填充 · {{ alignedNav.dates.length }} 个观测</div>
        </div>
        <div class="sec">指标对比</div>
        <div class="card cmp">
          <table>
            <thead><tr><th></th><th v-for="h in headers" :key="h">{{ h }}</th></tr></thead>
            <tbody>
              <tr v-for="r in rows" :key="r.label">
                <td class="rl">{{ r.label }}</td>
                <td v-for="(v, i) in r.vals" :key="i">{{ v }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sec { font-size: 13px; color: #5A6A60; margin: 16px 4px 8px; }
.picks { display: flex; flex-wrap: wrap; gap: 8px; }
.pick { font-size: 13px; padding: 6px 12px; border-radius: 14px; background: #F2F3EF; color: #5A6A60; }
.pick.on { background: #4C7E67; color: #fff; }
.card { background: #fff; border-radius: 10px; padding: 12px; }
.nav-note { color: var(--text-hint); font-size: 10px; line-height: 1.5; margin-top: 5px; text-align: center; }
.cmp { overflow-x: auto; }
.cmp table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cmp th, .cmp td { padding: 8px 6px; text-align: right; border-bottom: 1px solid #ECEFE9; white-space: nowrap; }
.cmp th:first-child, .cmp .rl { text-align: left; color: #5A6A60; }
</style>
