<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { fetchEstimates, type Estimate } from '@/utils/estimate'
import { pct, num, colorOf } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import { computeAttribution } from '@/utils/attribution'
import { exportHoldingsCSV } from '@/utils/export'
import { loadSnapshots, takeSnapshot, buildSnapChart } from '@/utils/snapshots'
import { computeAssetClass, REFERENCE_ALLOCATION, CLASS_COLORS, type AssetClass } from '@/utils/assetclass'

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()

const meta = reactive<Record<string, { nav: number | null; type: string }>>({})
const est = reactive<Record<string, Estimate | null>>({})
const loading = ref(true)
const dim = ref<'account' | 'type'>('account')

const UNGROUPED = '未分组'

async function refresh() {
  loading.value = true
  await watch.load(true)
  // V3-12: 使用 activeHoldings（复合键，支持跨账户同一基金多笔持仓）
  const held = watch.activeHoldings.filter((e) => e.shares && e.shares > 0)
  const codes = [...new Set(held.map((e) => e.code))]
  fetchEstimates(codes).then((m) => m.forEach((v, k) => { est[k] = v }))
  await Promise.all(held.map(async (e) => {
    try {
      const d = await funds.detail(e.code)
      meta[e.code] = { nav: d.latest_nav, type: d.type || '其他' }
    } catch { meta[e.code] = { nav: null, type: '其他' } }
  }))
  loading.value = false
}

// 单只持仓的派生指标
interface Holding {
  code: string; name: string; account: string; type: string
  shares: number; cost: number; nav: number | null
  value: number; profit: number; today: number | null
}
const holdings = computed<Holding[]>(() => {
  const out: Holding[] = []
  // V3-12：迭代 activeHoldings（复合键），同一基金不同账户各自独立一行
  for (const e of watch.activeHoldings) {
    if (!(e.shares && e.shares > 0)) continue
    const m = meta[e.code]
    const nav = m?.nav ?? null
    const value = nav != null ? e.shares * nav : 0
    const cost = e.shares * (e.cost ?? 0)
    const es = est[e.code]
    const today = es && es.estChange != null && es.lastNav != null
      ? e.shares * es.lastNav * es.estChange / 100 : null
    out.push({
      code: e.code, name: e.name || e.code, account: e.account?.trim() || UNGROUPED,
      type: m?.type || '其他', shares: e.shares, cost: e.cost ?? 0, nav,
      value, profit: nav != null ? value - cost : 0, today,
    })
  }
  return out
})

const total = computed(() => {
  let value = 0, cost = 0, today = 0, hasToday = false
  for (const h of holdings.value) {
    value += h.value
    cost += h.shares * h.cost
    if (h.today != null) { today += h.today; hasToday = true }
  }
  const profit = value - cost
  return { value, cost, profit, rate: cost > 0 ? (profit / cost) * 100 : null, today: hasToday ? today : null }
})

// V3-8 收益归因
const attr = computed(() => {
  const hl = holdings.value.filter((h) => h.value > 0)
  if (!hl.length) return null
  return computeAttribution(hl.map((h) => {
    const es = est[h.code]
    return {
      code: h.code, name: h.name, account: h.account, type: h.type,
      shares: h.shares, cost: h.cost, nav: h.nav, value: h.value, profit: h.profit, today: h.today,
      todayPct: es && es.lastNav != null ? es.estChange : null,
    }
  }))
})
const attrDim = ref<'account' | 'type'>('account')

// V3-10 组合历史快照
const snaps = ref(loadSnapshots())
const snapChart = computed(() => buildSnapChart(snaps.value))
function doSnap() {
  snaps.value = takeSnapshot(total.value.value, total.value.cost)
}

// V3-13 大类资产
const assetClass = computed(() => computeAssetClass(holdings.value))
const classPieOption = computed(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
  legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
  series: [{
    type: 'pie', radius: ['40%', '60%'], center: ['50%', '42%'], label: { show: false },
    data: assetClass.value.classes.map((c) => ({ name: c.cls, value: +c.value.toFixed(2), itemStyle: { color: CLASS_COLORS[c.cls] } })),
  }],
}))
const classBars = computed(() => {
  const map = new Map(assetClass.value.classes.map((c) => [c.cls, c.pct]))
  const order: AssetClass[] = ['权益', '固收', '混合', '海外', '现金']
  return order.map((cls) => ({ cls, actual: map.get(cls) || 0, ref: REFERENCE_ALLOCATION[cls] }))
})

// 按账户聚合
interface Group { key: string; value: number; cost: number; profit: number; count: number; today: number | null }
function groupBy(field: 'account' | 'type'): Group[] {
  const map = new Map<string, Group>()
  for (const h of holdings.value) {
    const k = field === 'account' ? h.account : h.type
    let g = map.get(k)
    if (!g) { g = { key: k, value: 0, cost: 0, profit: 0, count: 0, today: null }; map.set(k, g) }
    g.value += h.value
    g.cost += h.shares * h.cost
    g.profit += h.profit
    g.count++
    if (h.today != null) g.today = (g.today ?? 0) + h.today
  }
  return [...map.values()].sort((a, b) => b.value - a.value)
}
const byAccount = computed(() => groupBy('account'))

const pieOption = computed(() => {
  const groups = groupBy(dim.value)
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['42%', '64%'], center: ['50%', '42%'], label: { show: false },
      data: groups.map((g) => ({ name: g.key, value: +g.value.toFixed(2) })),
    }],
  }
})

const rateOf = (g: Group) => (g.cost > 0 ? (g.profit / g.cost) * 100 : null)
const share = (v: number) => (total.value.value > 0 ? (v / total.value.value) * 100 : 0)

onMounted(refresh)
</script>

<template>
  <div class="page">
    <van-nav-bar title="资产" />
    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="holdings.length === 0"
        description="还没有持仓。去自选页给基金填上份额/成本/账户" />
      <template v-else>
        <!-- 总资产 -->
        <div class="hero card">
          <div class="k">总资产（估算市值）</div>
          <div class="big">{{ num(total.value, 2) }}</div>
          <div class="hero-row">
            <div>
              <span class="kk">累计收益</span>
              <span class="vv" :style="{ color: colorOf(total.profit) }">
                {{ (total.profit >= 0 ? '+' : '') + num(total.profit, 2) }}
                <em :style="{ color: colorOf(total.rate) }">{{ pct(total.rate) }}</em>
              </span>
            </div>
            <div v-if="total.today != null" style="text-align:right">
              <span class="kk">今日估算</span>
              <span class="vv" :style="{ color: colorOf(total.today) }">
                {{ (total.today >= 0 ? '+' : '') + num(total.today, 2) }}
              </span>
            </div>
          </div>
        </div>

        <!-- V3-10 组合历史曲线 -->
        <div class="card">
          <div class="dim-head">
            <span class="sec-t">组合历史</span>
            <van-button size="mini" plain icon="photograph" @click="doSnap">拍快照</van-button>
          </div>
          <template v-if="snapChart">
            <Chart :option="snapChart" height="220px" />
            <div class="snap-hint">共 {{ snaps.length }} 个快照 · {{ snaps[0].date.slice(0,10) }} ~ {{ snaps[snaps.length-1].date.slice(0,10) }}。点击「拍快照」记录当日市值/成本。</div>
          </template>
          <van-empty v-else description="还没有快照。点击上方「拍快照」开始记录组合历史。" image-size="60" />
        </div>

        <div class="act-row">
          <van-button class="lt-btn" plain icon="cluster-o" size="small"
            @click="router.push('/lookthrough')">持仓穿透</van-button>
          <van-button class="lt-btn" plain icon="down" size="small"
            @click="exportHoldingsCSV(holdings)">导出 CSV</van-button>
        </div>

        <!-- 资产分布（账户 / 类型 切换） -->
        <div class="card">
          <div class="dim-head">
            <span class="sec-t">资产分布</span>
            <div class="seg">
              <span :class="{ on: dim === 'account' }" @click="dim = 'account'">按账户</span>
              <span :class="{ on: dim === 'type' }" @click="dim = 'type'">按类型</span>
            </div>
          </div>
          <Chart :option="pieOption" height="200px" />
        </div>

        <!-- V3-13 大类资产 -->
        <template v-if="assetClass.classes.length">
          <div class="sec">大类资产</div>
          <div class="card">
            <div class="dim-head"><span class="sec-t">资产类别</span></div>
            <Chart :option="classPieOption" height="200px" />
            <div class="class-bars">
              <div class="class-bar" v-for="b in classBars" :key="b.cls">
                <span class="cb-lbl">{{ b.cls }}</span>
                <van-progress :percentage="Math.min(b.actual, 100)" :show-pivot="false"
                  :color="CLASS_COLORS[b.cls]" track-color="var(--border)" style="flex:1;margin:0 8px" />
                <span class="cb-pct">{{ b.actual.toFixed(1) }}%</span>
              </div>
            </div>
            <div class="class-ref">参考：{{ classBars.map((b) => `${b.cls}~${b.ref}%`).join(' / ') }}</div>
            <div class="class-tip" v-if="assetClass.tip">{{ assetClass.tip }}</div>
          </div>
        </template>

        <!-- 账户明细 -->
        <div class="sec">账户明细</div>
        <div class="acc card" v-for="g in byAccount" :key="g.key">
          <div class="acc-top">
            <span class="acc-name">{{ g.key }}</span>
            <span class="acc-share">{{ share(g.value).toFixed(1) }}%</span>
          </div>
          <div class="acc-grid">
            <div><div class="kk">市值</div><div class="vg">{{ num(g.value, 2) }}</div></div>
            <div><div class="kk">收益</div><div class="vg" :style="{ color: colorOf(g.profit) }">{{ (g.profit >= 0 ? '+' : '') + num(g.profit, 0) }}<em :style="{ color: colorOf(rateOf(g)) }">{{ pct(rateOf(g)) }}</em></div></div>
            <div><div class="kk">今日</div><div class="vg" :style="{ color: colorOf(g.today) }">{{ g.today != null ? (g.today >= 0 ? '+' : '') + num(g.today, 0) : '--' }}</div></div>
            <div><div class="kk">持仓</div><div class="vg">{{ g.count }} 只</div></div>
          </div>
        </div>
        <!-- V3-8 收益归因 -->
        <template v-if="attr && attr.holdings.length">
          <div class="sec">收益归因</div>
          <div class="card">
            <div class="dim-head">
              <span class="sec-t">贡献拆解</span>
              <div class="seg">
                <span :class="{ on: attrDim === 'account' }" @click="attrDim = 'account'">按账户</span>
                <span :class="{ on: attrDim === 'type' }" @click="attrDim = 'type'">按类型</span>
              </div>
            </div>
            <template v-if="attrDim === 'account'">
              <div class="atr-row" v-for="g in attr.byAccount" :key="g.account">
                <span class="atr-nm">{{ g.account }}</span>
                <span class="atr-w">{{ g.weight.toFixed(1) }}%</span>
                <van-progress :percentage="Math.min(g.weight, 100)" :show-pivot="false"
                  color="#0f9d75" track-color="#eef0f2" style="flex:1;margin:0 8px" />
                <span class="atr-d" :style="{ color: colorOf(g.dayContrib) }">{{ g.dayContrib != null ? (g.dayContrib >= 0 ? '+' : '') + g.dayContrib.toFixed(2) + 'bp' : '--' }}</span>
              </div>
            </template>
            <template v-else>
              <div class="atr-row" v-for="g in attr.byType" :key="g.type">
                <span class="atr-nm">{{ g.type }}</span>
                <span class="atr-w">{{ g.weight.toFixed(1) }}%</span>
                <van-progress :percentage="Math.min(g.weight, 100)" :show-pivot="false"
                  color="#0f9d75" track-color="#eef0f2" style="flex:1;margin:0 8px" />
                <span class="atr-d" :style="{ color: colorOf(g.dayContrib) }">{{ g.dayContrib != null ? (g.dayContrib >= 0 ? '+' : '') + g.dayContrib.toFixed(2) + 'bp' : '--' }}</span>
              </div>
            </template>
            <div class="atr-note">bp = 基点（万分比），今日估算贡献</div>
          </div>

          <div class="card">
            <div class="dim-head"><span class="sec-t">集中度</span></div>
            <div class="conc">
              <div><span>最大持仓</span><b>{{ attr.concentration.top1.toFixed(1) }}%</b></div>
              <div><span>前3 集中</span><b>{{ attr.concentration.top3.toFixed(1) }}%</b></div>
              <div><span>前5 集中</span><b>{{ attr.concentration.top5.toFixed(1) }}%</b></div>
            </div>
            <div class="conc-warn" v-if="attr.concentration.top1 > 40">⚠ 最大持仓超过 40%，集中度偏高</div>
            <div class="conc-warn" v-else-if="attr.concentration.top3 > 70">⚠ 前三持仓超过 70%，适当分散可降低波动</div>
          </div>

          <div class="card" v-if="attr.bestDay || attr.worstDay">
            <div class="dim-head"><span class="sec-t">今日贡献排行</span></div>
            <div class="atr-row" v-if="attr.bestDay">
              <span class="atr-nm">{{ attr.bestDay.name }}<em>最佳</em></span>
              <span class="atr-w">{{ attr.bestDay.weight.toFixed(1) }}%</span>
              <span class="atr-d" :style="{ color: colorOf(attr.bestDay.dayReturn) }">{{ pct(attr.bestDay.dayReturn) }} · {{ (attr.bestDay.dayContrib! >= 0 ? '+' : '') + attr.bestDay.dayContrib!.toFixed(2) }}bp</span>
            </div>
            <div class="atr-row" v-if="attr.worstDay">
              <span class="atr-nm">{{ attr.worstDay.name }}<em>最差</em></span>
              <span class="atr-w">{{ attr.worstDay.weight.toFixed(1) }}%</span>
              <span class="atr-d" :style="{ color: colorOf(attr.worstDay.dayReturn) }">{{ pct(attr.worstDay.dayReturn) }} · {{ (attr.worstDay.dayContrib! >= 0 ? '+' : '') + attr.worstDay.dayContrib!.toFixed(2) }}bp</span>
            </div>
          </div>
        </template>
        <div class="tip">同一只基金归属一个账户；在「自选」页编辑持仓时设置账户。市值用最新净值/盘中估算，仅供参考。</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.card { background: var(--card-bg); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
.act-row { display: flex; gap: 8px; margin-bottom: 12px; }
.act-row .lt-btn { flex: 1; margin-bottom: 0; }
.hero .k { font-size: 12px; color: var(--text-muted); }
.hero .big { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 2px 0 10px; color: var(--text); }
.hero-row { display: flex; justify-content: space-between; align-items: flex-end; }
.kk { font-size: 11px; color: var(--text-muted); display: block; }
.vv { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.vv em { font-style: normal; font-size: 12px; margin-left: 4px; }
.dim-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.sec-t { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.seg { display: flex; font-size: 12px; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.seg span { padding: 4px 12px; color: var(--text-secondary); }
.seg span.on { background: var(--teal); color: #fff; }
.sec { font-size: 13px; color: var(--text-muted); margin: 4px 4px 8px; }
.acc-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.acc-name { font-size: 15px; font-weight: 600; color: var(--text); }
.acc-share { font-size: 12px; color: var(--teal); }
.acc-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.vg { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 2px; }
.vg em { font-style: normal; font-size: 10px; margin-left: 3px; }
.tip { font-size: 11px; color: var(--text-hint); line-height: 1.6; padding: 0 4px; }
/* ── 归因 ── */
.atr-row { display: flex; align-items: center; font-size: 12px; margin: 7px 0; }
.atr-nm { width: 72px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.atr-nm em { font-style: normal; font-size: 10px; color: var(--text-hint); margin-left: 4px; }
.atr-w { width: 40px; text-align: right; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.atr-d { width: 100px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.atr-note { font-size: 11px; color: var(--text-hint); margin-top: 6px; }
.conc { display: flex; gap: 16px; }
.conc div { text-align: center; }
.conc div span { display: block; font-size: 11px; color: var(--text-muted); }
.conc div b { font-size: 18px; color: var(--text); }
.conc-warn { font-size: 12px; color: #e6a23c; margin-top: 6px; }
/* ── 快照 ── */
.snap-hint { font-size: 11px; color: var(--text-hint); text-align: center; margin-top: 6px; line-height: 1.5; }
/* ── V3-13 大类资产 ── */
.class-bars { margin-top: 10px; }
.class-bar { display: flex; align-items: center; margin: 6px 0; font-size: 12px; }
.cb-lbl { width: 36px; color: var(--text-secondary); }
.cb-pct { width: 42px; text-align: right; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.class-ref { font-size: 11px; color: var(--text-hint); margin-top: 6px; }
.class-tip { font-size: 12px; color: #e6a23c; margin-top: 4px; }
</style>
