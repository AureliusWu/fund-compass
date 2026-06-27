<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { pct, colorOf } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import {
  annualReturns, rollingMetrics, simulateDCA, sweepMAPeriod, computeSummary,
  type AnnualReturn, type RollingPoint, type BacktestSummary,
} from '@/utils/backtest'
import type { BacktestResp, FundDetail, NavPoint } from '@/api/client'

const watchStore = useWatchlistStore()
const fundsStore = useFundsStore()

const picked = ref('')
const bt = ref<BacktestResp | null>(null)
const loading = ref(false)
const err = ref('')
const detail = ref<FundDetail | null>(null)
const dcaAmount = ref(1000)
const maPeriod = ref(60)

// 基金列表（有持仓的优先）
const fundOpts = computed(() => {
  const seen = new Set<string>()
  const out: { code: string; name: string }[] = []
  for (const e of watchStore.entries) {
    if (e.deleted || seen.has(e.code)) continue
    seen.add(e.code)
    out.push({ code: e.code, name: e.name || e.code })
  }
  return out
})

async function run() {
  if (!picked.value) return
  loading.value = true; err.value = ''
  try {
    const [b, d] = await Promise.all([fundsStore.backtest(picked.value), fundsStore.detail(picked.value)])
    bt.value = b
    detail.value = d
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally { loading.value = false }
}

// 年度数据
const ann = computed(() => bt.value ? annualReturns(bt.value) : [])
const sm = computed(() => bt.value ? computeSummary(bt.value) : null)

// 回测对比图（策略 vs 基准 vs 定投）
const comparisonOption = computed(() => {
  if (!bt.value?.strategy?.curve || !bt.value?.benchmark?.curve) return null
  const sc = bt.value.strategy.curve, bc = bt.value.benchmark.curve
  // DCA 虚拟线
  const dca = simulateDCA(sc, dcaAmount.value)
  const dc: number[] = []
  let accUnits = 0, accAmt = 0
  const byMonth = new Map<string, number>()
  for (const p of sc) {
    const ym = p.date.slice(0, 7)
    if (!byMonth.has(ym) && p.v > 0) byMonth.set(ym, p.v)
  }
  sc.forEach((p) => {
    const ym = p.date.slice(0, 7)
    if (byMonth.has(ym) && accAmt === (dc.length ? accAmt : 0)) {
      // 在每月第一个点定投（简化：该月第一笔）
      const nav = byMonth.get(ym)!
      accUnits += dcaAmount.value / nav
      accAmt += dcaAmount.value
    }
    dc.push(accUnits * p.v)
  })

  // 归一化到起点 100
  const base = sc[0].v || 1
  return {
    grid: { left: 52, right: 20, top: 30, bottom: 28 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, data: ['择时策略', '买入持有', '定投'], textStyle: { fontSize: 11 } },
    xAxis: { type: 'category', data: sc.map((p) => p.date.slice(0, 10)), boundaryGap: false, axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10, formatter: '{value}' } },
    series: [
      { name: '择时策略', type: 'line', showSymbol: false, data: sc.map((p) => +(p.v * 100 / base).toFixed(2)), lineStyle: { color: '#ee0a24' } },
      { name: '买入持有', type: 'line', showSymbol: false, data: bc.map((p) => +(p.v * 100 / base).toFixed(2)), lineStyle: { color: '#0f9d75' } },
      { name: '定投', type: 'line', showSymbol: false, data: dc.map((v) => +(v * 100 / (dc[0] || 1)).toFixed(2)), lineStyle: { color: '#1989fa' } },
    ],
  }
})

// 年度收益热力表
const heatOption = computed(() => {
  const a = ann.value
  if (!a.length) return null
  const years = a.map((x) => String(x.year))
  return {
    grid: { left: 48, right: 80, top: 10, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: years, axisLabel: { fontSize: 10, rotate: 30 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: '{value}%' } },
    series: [
      { name: '策略', type: 'bar', data: a.map((x) => x.strategy != null ? +x.strategy.toFixed(2) : null), itemStyle: { color: '#ee0a24' } },
      { name: '基准', type: 'bar', data: a.map((x) => x.benchmark != null ? +x.benchmark.toFixed(2) : null), itemStyle: { color: '#0f9d75' } },
    ],
  }
})

// 滚动指标图
const rollingOption = computed(() => {
  if (!bt.value?.strategy?.curve) return null
  const r = rollingMetrics(bt.value.strategy.curve)
  if (!r.length) return null
  return {
    grid: { left: 52, right: 20, top: 30, bottom: 28 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, data: ['滚动年化', '滚动夏普'], textStyle: { fontSize: 11 } },
    xAxis: { type: 'category', data: r.map((p) => p.date), boundaryGap: false, axisLabel: { fontSize: 9 } },
    yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10 } },
    series: [
      { name: '滚动年化', type: 'line', showSymbol: false, data: r.map((p) => p.ret != null ? +p.ret.toFixed(2) : null), lineStyle: { color: '#ee0a24' } },
      { name: '滚动夏普', type: 'line', showSymbol: false, data: r.map((p) => p.sharpe != null ? +p.sharpe.toFixed(2) : null), lineStyle: { color: '#1989fa' } },
    ],
  }
})

// MA 参数扫描
const sweep = computed(() => {
  if (!detail.value?.nav_history?.length) return []
  return sweepMAPeriod(detail.value.nav_history, [5, 10, 20, 30, 60, 90, 120])
})

const fp = (n: number | null | undefined, d = 2) => n != null ? (n >= 0 ? '+' : '') + n.toFixed(d) + '%' : '--'
</script>

<template>
  <div class="page">
    <van-nav-bar title="回测实验室" />
    <div class="page-body">
      <!-- 基金选择 -->
      <van-cell-group inset>
        <van-field v-model="picked" label="选择基金" placeholder="输入代码" />
      </van-cell-group>
      <div class="chip-row" v-if="fundOpts.length">
        <span class="chip" v-for="f in fundOpts.slice(0, 12)" :key="f.code"
          :class="{ on: picked === f.code }" @click="picked = f.code; run()">
          {{ f.name }}
        </span>
      </div>
      <div class="btn-row">
        <van-button type="primary" size="small" :loading="loading" @click="run" :disabled="!picked">开始回测</van-button>
      </div>
      <van-divider v-if="err">{{ err }}</van-divider>

      <template v-if="bt && sm">
        <!-- 摘要卡片 -->
        <div class="sec">回测摘要</div>
        <div class="summary-cards">
          <div class="sc">
            <div class="sc-label">策略收益</div>
            <div class="sc-val" :style="{ color: colorOf(sm.strategyRet) }">{{ fp(sm.strategyRet) }}</div>
          </div>
          <div class="sc">
            <div class="sc-label">超额收益</div>
            <div class="sc-val" :style="{ color: colorOf(sm.excess) }">{{ fp(sm.excess) }}</div>
          </div>
          <div class="sc">
            <div class="sc-label">年化收益</div>
            <div class="sc-val" :style="{ color: colorOf(sm.annualRet) }">{{ sm.annualRet != null ? fp(sm.annualRet) : '--' }}</div>
          </div>
          <div class="sc">
            <div class="sc-label">最大回撤</div>
            <div class="sc-val" style="color:#07c160">{{ sm.strategyDD != null ? sm.strategyDD.toFixed(2) + '%' : '--' }}</div>
          </div>
          <div class="sc">
            <div class="sc-label">夏普比率</div>
            <div class="sc-val">{{ sm.sharpe != null ? sm.sharpe.toFixed(2) : '--' }}</div>
          </div>
          <div class="sc">
            <div class="sc-label">胜率</div>
            <div class="sc-val">{{ sm.winRate != null ? (sm.winRate * 100).toFixed(0) + '%' : '--' }}</div>
          </div>
        </div>

        <!-- 回测对比图 -->
        <div class="sec">策略对比</div>
        <div class="card" v-if="comparisonOption">
          <div class="row mb">
            <span>定投金额</span>
            <van-stepper v-model="dcaAmount" :step="500" :min="100" :max="50000" />
          </div>
          <Chart :option="comparisonOption" height="260px" />
        </div>

        <!-- 年度收益 -->
        <div class="sec">年度收益</div>
        <div class="card" v-if="heatOption">
          <Chart :option="heatOption" height="200px" />
          <table class="ann-tbl" v-if="ann.length">
            <thead><tr><th>年</th><th>策略</th><th>基准</th><th>超额</th></tr></thead>
            <tbody>
              <tr v-for="a in ann" :key="a.year">
                <td>{{ a.year }}</td>
                <td :style="{ color: colorOf(a.strategy) }">{{ fp(a.strategy) }}</td>
                <td :style="{ color: colorOf(a.benchmark) }">{{ fp(a.benchmark) }}</td>
                <td :style="{ color: colorOf(a.excess) }">{{ fp(a.excess) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 滚动指标 -->
        <div class="sec">滚动指标（12个月）</div>
        <div class="card" v-if="rollingOption">
          <Chart :option="rollingOption" height="220px" />
        </div>

        <!-- MA 参数扫描 -->
        <div class="sec">MA 周期参数扫描</div>
        <div class="card" v-if="sweep.length">
          <table class="ann-tbl">
            <thead><tr><th>MA 周期</th><th>总收益</th><th>夏普</th><th>最大回撤</th></tr></thead>
            <tbody>
              <tr v-for="s in sweep" :key="s.period">
                <td>{{ s.period }} 日</td>
                <td :style="{ color: colorOf(s.ret) }">{{ fp(s.ret) }}</td>
                <td>{{ s.sharpe.toFixed(2) }}</td>
                <td style="color:#07c160">{{ s.drawdown.toFixed(2) }}%</td>
              </tr>
            </tbody>
          </table>
          <div class="note">基于净值序列模拟 MA 交叉择时，未计摩擦成本；仅供参考。</div>
        </div>

        <!-- 最佳/最差年份 -->
        <div class="sec">极值年份</div>
        <div class="card" v-if="sm.bestYear && sm.worstYear">
          <van-cell title="最佳年份" :value="sm.bestYear.year + ' · ' + fp(sm.bestYear.strategy)" value-class="red" />
          <van-cell title="最差年份" :value="sm.worstYear.year + ' · ' + fp(sm.worstYear.strategy)" value-class="green" />
        </div>
      </template>

      <van-empty v-if="!bt && !loading" description="选择基金后点击「开始回测」" />
    </div>
  </div>
</template>

<style scoped>
.chip-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; }
.chip { padding: 4px 10px; border-radius: 12px; background: var(--chip-bg, #f2f3f5); color: var(--text-secondary, #646566); font-size: 12px; cursor: pointer; }
.chip.on { background: #0f9d75; color: #fff; }
.btn-row { padding: 8px 16px; }

.sec { font-size: 13px; color: var(--text-muted, #969799); margin: 18px 4px 8px; }
.card { background: var(--card-bg, #fff); border-radius: 10px; padding: 14px; margin-bottom: 4px; }
.row { display: flex; align-items: center; gap: 10px; }
.mb { margin-bottom: 10px; }

.summary-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.sc { background: var(--card-bg, #fff); border-radius: 8px; padding: 10px 8px; text-align: center; }
.sc-label { font-size: 11px; color: var(--text-muted, #969799); }
.sc-val { font-size: 18px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }

.ann-tbl { width: 100%; border-collapse: collapse; margin-top: 8px; font-variant-numeric: tabular-nums; }
.ann-tbl th, .ann-tbl td { padding: 5px 6px; text-align: right; border-bottom: 1px solid var(--border, #f0f0f0); font-size: 12px; }
.ann-tbl th { color: var(--text-muted, #969799); font-weight: 500; }
.ann-tbl td:first-child, .ann-tbl th:first-child { text-align: left; }

.note { font-size: 11px; color: var(--text-hint, #c8c9cc); margin-top: 8px; }
:deep(.red) { color: #ee0a24 !important; }
:deep(.green) { color: #07c160 !important; }
</style>
