<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useFundsStore } from '@/stores/funds'
import { useWatchlistStore } from '@/stores/watchlist'
import { pct, num, colorOf, signalColor } from '@/utils/format'
import StarRating from '@/components/StarRating.vue'
import Chart from '@/components/Chart.vue'
import DcaCalc from '@/components/DcaCalc.vue'
import { fetchEstimate, type Estimate } from '@/utils/estimate'
import type { FundDetail, ScoreResp, SignalResp, BacktestResp } from '@/api/client'

const route = useRoute()
const router = useRouter()
const funds = useFundsStore()
const watch = useWatchlistStore()
const code = route.params.code as string

const detail = ref<FundDetail | null>(null)
const score = ref<ScoreResp | null>(null)
const signal = ref<SignalResp | null>(null)
const bt = ref<BacktestResp | null>(null)
const est = ref<Estimate | null>(null)
const estDone = ref(false)
const loading = ref(true)
const error = ref('')

const COMP_NAMES: Record<string, string> = { return: '收益', risk: '风险', management: '管理', cost: '成本' }

onMounted(async () => {
  watch.load().catch(() => {})
  // 盘中估值独立于后端，立即并发抓取（不阻塞详情）
  fetchEstimate(code).then((e) => { est.value = e }).finally(() => { estDone.value = true })
  try {
    detail.value = await funds.detail(code)
    score.value = await funds.score(code)
    signal.value = await funds.signal(code)
  } catch {
    error.value = '加载失败，后端是否已启动？'
  } finally {
    loading.value = false
  }
  try { bt.value = await funds.backtest(code) } catch { /* 回测可选 */ }
})

const btOption = computed(() => {
  const s = bt.value?.strategy?.curve || []
  const b = bt.value?.benchmark?.curve || []
  return {
    grid: { left: 36, right: 12, top: 30, bottom: 20 },
    tooltip: { trigger: 'axis' as const },
    legend: { top: 0, data: ['择时策略', '一直持有'], textStyle: { fontSize: 11 } },
    xAxis: { type: 'category' as const, data: s.map((p) => p.date), boundaryGap: false, axisLabel: { show: false } },
    yAxis: { type: 'value' as const, scale: true },
    series: [
      { name: '择时策略', type: 'line' as const, showSymbol: false, data: s.map((p) => p.v), lineStyle: { color: '#0f9d75' } },
      { name: '一直持有', type: 'line' as const, showSymbol: false, data: b.map((p) => p.v), lineStyle: { color: '#969799' } },
    ],
  }
})

const navOption = computed(() => {
  const h = detail.value?.nav_history || []
  return {
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis' as const },
    xAxis: { type: 'category' as const, data: h.map((p) => p.date), boundaryGap: false },
    yAxis: { type: 'value' as const, scale: true },
    series: [{
      type: 'line' as const, data: h.map((p) => p.nav), showSymbol: false,
      lineStyle: { color: '#0f9d75' }, areaStyle: { color: 'rgba(15,157,117,0.08)' },
    }],
  }
})

async function toggleWatch() {
  try {
    await watch.toggle(code, detail.value?.name)
    showToast(watch.has(code) ? '已加入自选' : '已移出自选')
  } catch {
    showToast('操作失败')
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar :title="detail?.name || '基金详情'" left-arrow @click-left="router.back()">
      <template #right>
        <van-icon :name="watch.has(code) ? 'star' : 'star-o'"
          :color="watch.has(code) ? '#ffb400' : ''" size="20" @click="toggleWatch" />
      </template>
    </van-nav-bar>
    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="error" :description="error" />
      <template v-else-if="detail">
        <div class="est card">
          <div class="est-head">
            <span class="est-label">盘中估值</span>
            <span class="est-time">{{ est?.estTime || (estDone ? '' : '加载中…') }}</span>
          </div>
          <div class="est-main" v-if="est && est.estChange != null">
            <div class="est-chg" :style="{ color: colorOf(est.estChange) }">{{ pct(est.estChange) }}</div>
            <div class="est-side">
              <div>估算净值 <b>{{ num(est.estNav) }}</b></div>
              <div>昨净值 <b>{{ num(est.lastNav) }}</b><em v-if="est.navDate"> @{{ est.navDate }}</em></div>
            </div>
          </div>
          <div class="est-empty" v-else-if="estDone">暂无盘中估值（QDII/货币基金或非交易时段），以最新净值为准。</div>
          <van-loading v-else size="18" style="padding:6px 0" />
        </div>

        <van-cell-group inset>
          <van-cell title="代码" :value="detail.code" />
          <van-cell title="类型" :value="detail.type || '--'" />
          <van-cell title="最新净值"
            :value="num(detail.latest_nav) + (detail.latest_nav_date ? ' @' + detail.latest_nav_date : '')" />
          <van-cell title="规模" :value="detail.scale != null ? detail.scale + ' 亿' : '--'" />
          <van-cell title="经理"
            :value="(detail.manager || '--') + (detail.manager_worktime ? ' · ' + detail.manager_worktime : '')" />
        </van-cell-group>

        <div class="sec">收益</div>
        <div class="grid4">
          <div><div class="k">近1月</div><div class="v" :style="{ color: colorOf(detail.ret_1m) }">{{ pct(detail.ret_1m) }}</div></div>
          <div><div class="k">近6月</div><div class="v" :style="{ color: colorOf(detail.ret_6m) }">{{ pct(detail.ret_6m) }}</div></div>
          <div><div class="k">近1年</div><div class="v" :style="{ color: colorOf(detail.ret_1y) }">{{ pct(detail.ret_1y) }}</div></div>
          <div><div class="k">近3年</div><div class="v" :style="{ color: colorOf(detail.ret_3y) }">{{ pct(detail.ret_3y) }}</div></div>
        </div>

        <div class="sec">净值走势</div>
        <div class="card"><Chart :option="navOption" height="220px" /></div>

        <div class="sec">定投测算</div>
        <div class="card">
          <DcaCalc :nav-history="detail.nav_history" :latest-nav="detail.latest_nav" />
        </div>

        <template v-if="score">
          <div class="sec">综合评分</div>
          <div class="card">
            <div class="scorehead">
              <div class="bigscore">{{ score.score ?? '--' }}</div>
              <div>
                <StarRating :star="score.star" />
                <div class="rank" v-if="score.rank_in_type">同类 {{ score.rank_in_type }}/{{ score.rank_total }}</div>
              </div>
            </div>
            <div class="comp" v-for="(c, k) in score.components" :key="k">
              <span class="cn">{{ COMP_NAMES[k] }} <em>{{ c.weight * 100 }}%</em></span>
              <van-progress :percentage="Math.round(c.score ?? 0)" :show-pivot="false"
                color="#0f9d75" track-color="#eef0f2" style="flex:1;margin:0 10px" />
              <span class="cv">{{ c.score ?? '--' }}</span>
            </div>
          </div>
        </template>

        <template v-if="bt">
          <div class="sec">策略回测</div>
          <div class="card" v-if="bt.available && bt.strategy && bt.benchmark">
            <div class="bt-row">
              <div><div class="k">择时策略</div><div class="v" :style="{ color: colorOf(bt.strategy.total_return) }">{{ pct(bt.strategy.total_return) }}</div><div class="kk">回撤 {{ bt.strategy.max_drawdown }}%</div></div>
              <div><div class="k">一直持有</div><div class="v" :style="{ color: colorOf(bt.benchmark.total_return) }">{{ pct(bt.benchmark.total_return) }}</div><div class="kk">回撤 {{ bt.benchmark.max_drawdown }}%</div></div>
              <div><div class="k">超额/胜率</div><div class="v" :style="{ color: colorOf(bt.outperform ?? 0) }">{{ pct(bt.outperform ?? 0) }}</div><div class="kk">胜率 {{ bt.win_rate }}%</div></div>
            </div>
            <Chart :option="btOption" height="200px" />
            <div class="bt-note">{{ bt.start }} ~ {{ bt.end }} · 月度调仓 {{ bt.rebalances }} 次。简化回测、不计费用，仅供参考。</div>
          </div>
          <div class="card" v-else><van-empty :description="bt.reason || '无法回测'" image-size="60" /></div>
        </template>

        <template v-if="signal">
          <div class="sec">当前信号</div>
          <div class="card">
            <div class="sighead">
              <span class="sigbig" :style="{ color: signalColor(signal.signal) }">{{ signal.signal }}</span>
              <span class="advice">{{ signal.advice }}</span>
            </div>
            <van-cell-group>
              <van-cell title="估值"
                :value="signal.layers.valuation.label + (signal.layers.valuation.percentile != null ? ' · 分位 ' + signal.layers.valuation.percentile : '')" />
              <van-cell title="趋势" :value="signal.layers.trend.label" />
              <van-cell title="情绪"
                :value="signal.layers.sentiment.label + (signal.layers.sentiment.rsi != null ? ' · RSI ' + signal.layers.sentiment.rsi : '')" />
            </van-cell-group>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sec { font-size: 13px; color: #969799; margin: 18px 4px 8px; }
.card { background: #fff; border-radius: 10px; padding: 12px; }
.est { margin: 0 0 4px; }
.est-head { display: flex; justify-content: space-between; align-items: center; }
.est-label { font-size: 13px; color: #646566; font-weight: 500; }
.est-time { font-size: 11px; color: #c8c9cc; }
.est-main { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.est-chg { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.est-side { text-align: right; font-size: 12px; color: #969799; line-height: 1.7; }
.est-side b { color: #323233; font-weight: 600; }
.est-side em { font-style: normal; color: #c8c9cc; }
.est-empty { font-size: 12px; color: #969799; margin-top: 6px; line-height: 1.5; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); background: #fff; border-radius: 10px; padding: 12px 0; }
.grid4 .k { font-size: 11px; color: #969799; text-align: center; }
.grid4 .v { font-size: 14px; font-weight: 500; text-align: center; margin-top: 4px; }
.scorehead { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.bigscore { font-size: 34px; font-weight: 600; color: #0f9d75; }
.rank { font-size: 11px; color: #969799; margin-top: 2px; }
.comp { display: flex; align-items: center; font-size: 12px; margin: 8px 0; }
.comp .cn { width: 64px; color: #646566; }
.comp .cn em { color: #c8c9cc; font-style: normal; font-size: 10px; }
.comp .cv { width: 34px; text-align: right; color: #323233; }
.bt-row { display: grid; grid-template-columns: repeat(3, 1fr); margin-bottom: 8px; }
.bt-row .k { font-size: 11px; color: #969799; }
.bt-row .v { font-size: 17px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.bt-row .kk { font-size: 10px; color: #c8c9cc; margin-top: 1px; }
.bt-note { font-size: 11px; color: #c8c9cc; margin-top: 6px; line-height: 1.5; }
.sighead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.sigbig { font-size: 22px; font-weight: 600; }
.advice { font-size: 12px; color: #969799; }
</style>
