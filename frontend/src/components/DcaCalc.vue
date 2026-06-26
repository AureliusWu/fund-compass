<script setup lang="ts">
import { ref, computed } from 'vue'
import type { NavPoint } from '@/api/client'

const props = defineProps<{ navHistory: NavPoint[]; latestNav: number | null }>()

const amount = ref(1000)
const months = ref(12)
const MONTH_OPTS = [6, 12, 24, 36]

// 每月取该月第一个交易日的净值
const monthly = computed<NavPoint[]>(() => {
  const byMonth = new Map<string, NavPoint>()
  for (const p of props.navHistory) {
    const ym = p.date.slice(0, 7)
    if (!byMonth.has(ym)) byMonth.set(ym, p)
  }
  return [...byMonth.values()]
})

const result = computed(() => {
  const pts = monthly.value.slice(-months.value).filter((p) => p.nav > 0)
  const latest = props.latestNav ?? (pts.length ? pts[pts.length - 1].nav : 0)
  if (!pts.length || !latest) return null

  // 定投：每月投 amount，按当月净值买入份额
  let units = 0
  let invested = 0
  for (const p of pts) { units += amount.value / p.nav; invested += amount.value }
  const value = units * latest
  const profit = value - invested
  const rate = invested ? (profit / invested) * 100 : 0

  // 一次性：期初一把投入相同总额
  const startNav = pts[0].nav
  const lumpValue = (invested / startNav) * latest
  const lumpProfit = lumpValue - invested
  const lumpRate = invested ? (lumpProfit / invested) * 100 : 0

  return {
    periods: pts.length, invested, value, profit, rate,
    lumpValue, lumpProfit, lumpRate,
    start: pts[0].date, end: pts[pts.length - 1].date,
  }
})

const f = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const fp = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
const col = (n: number) => (n > 0 ? '#ee0a24' : n < 0 ? '#07c160' : '#646566')
</script>

<template>
  <div class="dca">
    <div class="row">
      <span class="lbl">每月投入</span>
      <van-stepper v-model="amount" :step="500" :min="100" :max="100000" />
      <span class="unit">元</span>
    </div>
    <div class="row">
      <span class="lbl">回放区间</span>
      <div class="segs">
        <span v-for="m in MONTH_OPTS" :key="m" class="seg" :class="{ on: months === m }" @click="months = m">{{ m }}月</span>
      </div>
    </div>

    <template v-if="result">
      <div class="sub">{{ result.start }} ~ {{ result.end }} · 共投 {{ result.periods }} 期</div>
      <table>
        <thead><tr><th></th><th>定投</th><th>一次性</th></tr></thead>
        <tbody>
          <tr><td class="rl">累计投入</td><td>{{ f(result.invested) }}</td><td>{{ f(result.invested) }}</td></tr>
          <tr><td class="rl">当前市值</td><td>{{ f(result.value) }}</td><td>{{ f(result.lumpValue) }}</td></tr>
          <tr><td class="rl">收益</td>
            <td :style="{ color: col(result.profit) }">{{ f(result.profit) }}</td>
            <td :style="{ color: col(result.lumpProfit) }">{{ f(result.lumpProfit) }}</td></tr>
          <tr><td class="rl">收益率</td>
            <td :style="{ color: col(result.rate) }">{{ fp(result.rate) }}</td>
            <td :style="{ color: col(result.lumpRate) }">{{ fp(result.lumpRate) }}</td></tr>
        </tbody>
      </table>
      <div class="note">按每月首个交易日净值回放，未计申赎费；仅供参考，不构成投资建议。</div>
    </template>
    <van-empty v-else description="净值数据不足" />
  </div>
</template>

<style scoped>
.dca { font-size: 13px; }
.row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.lbl { width: 64px; color: #646566; }
.unit { color: #969799; }
.segs { display: flex; gap: 6px; }
.seg { padding: 4px 10px; border-radius: 12px; background: #f2f3f5; color: #646566; }
.seg.on { background: #0f9d75; color: #fff; }
.sub { font-size: 12px; color: #969799; margin: 4px 0 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 7px 6px; text-align: right; border-bottom: 1px solid #f0f0f0; font-variant-numeric: tabular-nums; }
th { color: #969799; font-weight: 500; }
.rl { text-align: left; color: #646566; }
.note { font-size: 11px; color: #c8c9cc; margin-top: 8px; line-height: 1.5; }
</style>
