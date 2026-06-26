<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { fetchEstimates, type Estimate } from '@/utils/estimate'
import { pct, num, colorOf } from '@/utils/format'
import Chart from '@/components/Chart.vue'

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
  const held = watch.entries.filter((e) => !e.deleted && e.shares && e.shares > 0)
  const codes = held.map((e) => e.code)
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
  for (const e of watch.entries) {
    if (e.deleted || !(e.shares && e.shares > 0)) continue
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
        <div class="tip">同一只基金归属一个账户；在「自选」页编辑持仓时设置账户。市值用最新净值/盘中估算，仅供参考。</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.card { background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
.hero .k { font-size: 12px; color: #969799; }
.hero .big { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 2px 0 10px; color: #323233; }
.hero-row { display: flex; justify-content: space-between; align-items: flex-end; }
.kk { font-size: 11px; color: #969799; display: block; }
.vv { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.vv em { font-style: normal; font-size: 12px; margin-left: 4px; }
.dim-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.sec-t { font-size: 13px; color: #646566; font-weight: 500; }
.seg { display: flex; font-size: 12px; border: 1px solid #ebedf0; border-radius: 14px; overflow: hidden; }
.seg span { padding: 4px 12px; color: #646566; }
.seg span.on { background: #0f9d75; color: #fff; }
.sec { font-size: 13px; color: #969799; margin: 4px 4px 8px; }
.acc-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.acc-name { font-size: 15px; font-weight: 600; color: #323233; }
.acc-share { font-size: 12px; color: #0f9d75; }
.acc-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.vg { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 2px; }
.vg em { font-style: normal; font-size: 10px; margin-left: 3px; }
.tip { font-size: 11px; color: #c8c9cc; line-height: 1.6; padding: 0 4px; }
</style>
