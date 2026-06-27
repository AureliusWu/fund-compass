<script setup lang="ts">
import { ref, computed } from 'vue'
import type { NavPoint } from '@/api/client'
import {
  simulateRegularDCA, simulateValueDCA, simulateTakeProfit, simulateTargetDate,
  type DcaResult, type ValDcaResult, type TakeProfitResult, type TargetDateResult,
} from '@/utils/dca'

const props = defineProps<{ navHistory: NavPoint[]; latestNav: number | null }>()

const mode = ref<'regular' | 'value' | 'tp' | 'target'>('regular')
const amount = ref(1000)
const months = ref(12)
const maPeriod = ref(24)
const tpThreshold = ref(30)
const targetInvestMonths = ref(12)
const MONTH_OPTS = [6, 12, 24, 36]
const MA_OPTS = [12, 24, 48, 60]

const regularResult = computed(() => simulateRegularDCA(props.navHistory, amount.value, months.value, props.latestNav))
const valueResult = computed(() => simulateValueDCA(props.navHistory, amount.value, months.value, maPeriod.value, props.latestNav))
const tpResult = computed(() => simulateTakeProfit(props.navHistory, amount.value, months.value, tpThreshold.value, props.latestNav))
const targetResult = computed(() => simulateTargetDate(props.navHistory, amount.value, targetInvestMonths.value, props.latestNav))

// ── 格式化 ──
const f = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const fp = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
const col = (n: number) => (n > 0 ? '#ee0a24' : n < 0 ? '#07c160' : '#646566')
</script>

<template>
  <div class="dca">
    <!-- 模式切换 -->
    <div class="mode-bar">
      <span :class="{ on: mode === 'regular' }" @click="mode = 'regular'">普通定投</span>
      <span :class="{ on: mode === 'value' }" @click="mode = 'value'">估值定投</span>
      <span :class="{ on: mode === 'tp' }" @click="mode = 'tp'">止盈回测</span>
      <span :class="{ on: mode === 'target' }" @click="mode = 'target'">目标日期</span>
    </div>

    <!-- 通用设置 -->
    <div class="row">
      <span class="lbl">每月投入</span>
      <van-stepper v-model="amount" :step="500" :min="100" :max="100000" />
      <span class="unit">元</span>
    </div>

    <!-- ── 普通定投 ── -->
    <template v-if="mode === 'regular'">
      <div class="row">
        <span class="lbl">回放区间</span>
        <div class="segs">
          <span v-for="m in MONTH_OPTS" :key="m" class="seg" :class="{ on: months === m }" @click="months = m">{{ m }}月</span>
        </div>
      </div>
      <template v-if="regularResult">
        <div class="sub">{{ regularResult.start }} ~ {{ regularResult.end }} · 共投 {{ regularResult.periods }} 期</div>
        <table>
          <thead><tr><th></th><th>定投</th><th>一次性</th></tr></thead>
          <tbody>
            <tr><td class="rl">累计投入</td><td>{{ f(regularResult.invested) }}</td><td>{{ f(regularResult.invested) }}</td></tr>
            <tr><td class="rl">当前市值</td><td>{{ f(regularResult.value) }}</td><td>{{ f((regularResult.invested / (navHistory.slice(-months)[0]?.nav || 1)) * (latestNav || 0)) }}</td></tr>
            <tr><td class="rl">收益</td>
              <td :style="{ color: col(regularResult.profit) }">{{ f(regularResult.profit) }}</td>
              <td :style="{ color: col((regularResult.invested / (props.navHistory.slice(-months)[0]?.nav || 1)) * (props.latestNav || 0) - regularResult.invested) }">{{ f((regularResult.invested / (props.navHistory.slice(-months)[0]?.nav || 1)) * (props.latestNav || 0) - regularResult.invested) }}</td></tr>
            <tr><td class="rl">收益率</td>
              <td :style="{ color: col(regularResult.rate) }">{{ fp(regularResult.rate) }}</td>
              <td :style="{ color: col(((regularResult.invested / (props.navHistory.slice(-months)[0]?.nav || 1)) * (props.latestNav || 0) - regularResult.invested) / regularResult.invested * 100) }">--</td></tr>
          </tbody>
        </table>
      </template>
      <van-empty v-else description="净值数据不足" />
    </template>

    <!-- ── 估值定投 ── -->
    <template v-if="mode === 'value'">
      <div class="row">
        <span class="lbl">回放区间</span>
        <div class="segs">
          <span v-for="m in MONTH_OPTS" :key="m" class="seg" :class="{ on: months === m }" @click="months = m">{{ m }}月</span>
        </div>
      </div>
      <div class="row">
        <span class="lbl">MA 周期</span>
        <div class="segs">
          <span v-for="m in MA_OPTS" :key="m" class="seg" :class="{ on: maPeriod === m }" @click="maPeriod = m">{{ m }}月</span>
        </div>
      </div>
      <template v-if="valueResult">
        <div class="sub">{{ valueResult.start }} ~ {{ valueResult.end }} · 共投 {{ valueResult.periods }} 期 · 均倍率 {{ valueResult.avgMultiplier.toFixed(2) }}x</div>
        <table>
          <thead><tr><th></th><th>估值定投</th><th>普通定投</th></tr></thead>
          <tbody>
            <tr><td class="rl">累计投入</td><td>{{ f(valueResult.invested) }}</td><td>{{ f(regularResult?.invested ?? 0) }}</td></tr>
            <tr><td class="rl">当前市值</td><td>{{ f(valueResult.value) }}</td><td>{{ f(regularResult?.value ?? 0) }}</td></tr>
            <tr><td class="rl">收益</td>
              <td :style="{ color: col(valueResult.profit) }">{{ f(valueResult.profit) }}</td>
              <td :style="{ color: col(regularResult?.profit ?? 0) }">{{ f(regularResult?.profit ?? 0) }}</td></tr>
            <tr><td class="rl">收益率</td>
              <td :style="{ color: col(valueResult.rate) }">{{ fp(valueResult.rate) }}</td>
              <td :style="{ color: col(regularResult?.rate ?? 0) }">{{ fp(regularResult?.rate ?? 0) }}</td></tr>
          </tbody>
        </table>
        <div class="note">
          偏离 MA{{ maPeriod }} 时调整投入：≤-8% 倍投2x，-4%→1.6x，-2%→1.3x，≥+8% 减至0.5x，+4%→0.7x。<br />
          平摊下来：估值低位多买，高位少买。
        </div>
      </template>
      <van-empty v-else description="数据不足以计算估值定投（需更长净值历史）" />
    </template>

    <!-- ── 止盈回测 ── -->
    <template v-if="mode === 'tp'">
      <div class="row">
        <span class="lbl">回放区间</span>
        <div class="segs">
          <span v-for="m in MONTH_OPTS" :key="m" class="seg" :class="{ on: months === m }" @click="months = m">{{ m }}月</span>
        </div>
      </div>
      <div class="row">
        <span class="lbl">止盈线</span>
        <van-stepper v-model="tpThreshold" :step="5" :min="10" :max="100" />
        <span class="unit">%</span>
      </div>
      <template v-if="tpResult">
        <table>
          <thead><tr><th></th><th>无止盈</th><th>止盈{{ tpThreshold }}%</th></tr></thead>
          <tbody>
            <tr><td class="rl">累计投入</td><td>{{ f(tpResult.dcaWithoutTP.invested) }}</td><td>{{ f(tpResult.withTP.invested) }}</td></tr>
            <tr><td class="rl">总收益</td>
              <td :style="{ color: col(tpResult.dcaWithoutTP.profit) }">{{ f(tpResult.dcaWithoutTP.profit) }}</td>
              <td :style="{ color: col(tpResult.withTP.totalProfit) }">{{ f(tpResult.withTP.totalProfit) }}</td></tr>
            <tr><td class="rl">收益率</td>
              <td :style="{ color: col(tpResult.dcaWithoutTP.rate) }">{{ fp(tpResult.dcaWithoutTP.rate) }}</td>
              <td :style="{ color: col(tpResult.withTP.totalRate) }">{{ fp(tpResult.withTP.totalRate) }}</td></tr>
            <tr><td class="rl">止盈次数</td><td>—</td><td>{{ tpResult.withTP.cycles }}</td></tr>
          </tbody>
        </table>
        <div class="cycles" v-if="tpResult.cycles.length > 1">
          <div class="sub">止盈周期</div>
          <div class="cyc-row" v-for="(c, i) in tpResult.cycles" :key="i">
            <span>{{ c.start }} ~ {{ c.end }}</span>
            <span :style="{ color: col(c.profit) }">{{ fp(c.rate) }}</span>
          </div>
        </div>
        <div class="note">每次定投资金独立追踪，达到止盈线清仓落袋，下一笔重新开始。未计赎回费。</div>
      </template>
      <van-empty v-else description="数据不足" />
    </template>

    <!-- ── 目标日期 ── -->
    <template v-if="mode === 'target'">
      <div class="row">
        <span class="lbl">定投期数</span>
        <div class="segs">
          <span v-for="m in MONTH_OPTS" :key="m" class="seg" :class="{ on: targetInvestMonths === m }" @click="targetInvestMonths = m">{{ m }}月</span>
        </div>
      </div>
      <template v-if="targetResult">
        <div class="sub">历史 {{ targetResult.scenarios.length }} 个起点 · {{ targetResult.range.start }} ~ {{ targetResult.range.end }}</div>
        <div class="target-grid">
          <div class="tg">
            <span class="tg-l">最佳</span>
            <span class="tg-v" style="color:#ee0a24">{{ fp(targetResult.best.rate) }}</span>
            <span class="tg-d">{{ targetResult.best.start }}</span>
          </div>
          <div class="tg">
            <span class="tg-l">中位</span>
            <span class="tg-v">{{ fp(targetResult.median) }}</span>
          </div>
          <div class="tg">
            <span class="tg-l">最差</span>
            <span class="tg-v" style="color:#07c160">{{ fp(targetResult.worst.rate) }}</span>
            <span class="tg-d">{{ targetResult.worst.start }}</span>
          </div>
          <div class="tg">
            <span class="tg-l">胜率</span>
            <span class="tg-v" :style="{ color: targetResult.winRate >= 80 ? '#0f9d75' : '#ff976a' }">{{ targetResult.winRate.toFixed(0) }}%</span>
          </div>
        </div>
        <div class="note">
          给定定投期数，遍历历史上每个可能的起投点，展示到今日的收益率分布。<br />
          胜率 = 正收益场景占比。
        </div>
      </template>
      <van-empty v-else description="数据不足" />
    </template>

    <div class="note disclaimer">按每月首个交易日净值回放，未计申赎费；仅供参考，不构成投资建议。</div>
  </div>
</template>

<style scoped>
.dca { font-size: 13px; }
.mode-bar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.mode-bar span { padding: 4px 10px; border-radius: 12px; background: var(--chip-bg, #f2f3f5); color: var(--text-secondary, #646566); font-size: 12px; cursor: pointer; }
.mode-bar span.on { background: #0f9d75; color: #fff; }
.row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.lbl { width: 64px; color: var(--text-secondary, #646566); }
.unit { color: var(--text-muted, #969799); }
.segs { display: flex; gap: 6px; }
.seg { padding: 4px 10px; border-radius: 12px; background: var(--chip-bg, #f2f3f5); color: var(--text-secondary, #646566); cursor: pointer; }
.seg.on { background: #0f9d75; color: #fff; }
.sub { font-size: 12px; color: var(--text-muted, #969799); margin: 4px 0 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 7px 6px; text-align: right; border-bottom: 1px solid var(--border, #f0f0f0); font-variant-numeric: tabular-nums; }
th { color: var(--text-muted, #969799); font-weight: 500; }
.rl { text-align: left; color: var(--text-secondary, #646566); }
.note { font-size: 11px; color: var(--text-hint, #c8c9cc); margin-top: 8px; line-height: 1.5; }
.disclaimer { margin-top: 12px; }
.cycles { margin-top: 8px; }
.cyc-row { display: flex; justify-content: space-between; font-size: 11px; padding: 3px 0; border-bottom: 1px solid var(--border, #f0f0f0); }
.target-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 8px 0; }
.tg { background: var(--chip-bg, #f2f3f5); border-radius: 8px; padding: 10px; text-align: center; }
.tg-l { display: block; font-size: 11px; color: var(--text-muted, #969799); }
.tg-v { display: block; font-size: 22px; font-weight: 700; }
.tg-d { display: block; font-size: 10px; color: var(--text-hint, #c8c9cc); }
</style>
