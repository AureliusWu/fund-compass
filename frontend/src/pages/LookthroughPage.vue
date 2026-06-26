<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { computeLookthrough, type Lookthrough, type HeldFund } from '@/utils/lookthrough'
import { num } from '@/utils/format'
import Chart from '@/components/Chart.vue'

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()

const lt = ref<Lookthrough | null>(null)
const loading = ref(true)

const SOURCE_LABEL: Record<string, string> = {
  enrich: '完整持仓（AKShare 富集）',
  top10: '前十大重仓（近似）',
  mixed: '部分完整 / 部分前十大',
  none: '无数据',
}

async function refresh() {
  loading.value = true
  await watch.load(true)
  const held: HeldFund[] = []
  await Promise.all(
    watch.entries
      .filter((e) => !e.deleted && e.shares && e.shares > 0)
      .map(async (e) => {
        try {
          const d = await funds.detail(e.code)
          if (d.latest_nav != null) held.push({ code: e.code, name: d.name || e.code, value: e.shares! * d.latest_nav })
        } catch { /* 跳过 */ }
      }),
  )
  lt.value = held.length ? await computeLookthrough(held) : null
  loading.value = false
}

const topStocks = computed(() => (lt.value?.stocks || []).slice(0, 15))
const stockMax = computed(() => Math.max(1, ...topStocks.value.map((s) => s.pct)))

const indOption = computed(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
  legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
  series: [{
    type: 'pie', radius: ['42%', '64%'], center: ['50%', '42%'], label: { show: false },
    data: (lt.value?.industries || []).slice(0, 10).map((i) => ({ name: i.name, value: +i.value.toFixed(2) })),
  }],
}))

const coverPct = computed(() =>
  lt.value && lt.value.totalValue > 0 ? Math.round((lt.value.coveredValue / lt.value.totalValue) * 100) : 0,
)
const top10Share = computed(() => topStocks.value.slice(0, 10).reduce((a, s) => a + s.pct, 0))

onMounted(refresh)
</script>

<template>
  <div class="page">
    <van-nav-bar title="持仓穿透" left-arrow @click-left="router.back()" />
    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="!lt || !lt.stocks.length"
        description="无可穿透的持仓。去自选页给基金填上份额，且基金需有重仓股数据" />
      <template v-else>
        <div class="card sum">
          <div class="sum-row">
            <div><div class="k">穿透覆盖</div><div class="v">{{ coverPct }}%</div></div>
            <div><div class="k">前十大集中度</div><div class="v">{{ top10Share.toFixed(1) }}%</div></div>
            <div><div class="k">穿透个股</div><div class="v">{{ lt.stocks.length }}</div></div>
          </div>
          <div class="src">数据：{{ SOURCE_LABEL[lt.source] }}</div>
        </div>

        <template v-if="lt.industries.length">
          <div class="sec">行业分布（穿透后）</div>
          <div class="card"><Chart :option="indOption" height="200px" /></div>
        </template>

        <div class="sec">个股暴露 Top {{ topStocks.length }}（穿透后占组合）</div>
        <div class="card">
          <div class="st" v-for="(s, i) in topStocks" :key="s.code + i">
            <span class="st-rk">{{ i + 1 }}</span>
            <span class="st-nm">{{ s.name }}<em>{{ s.code }}<i v-if="s.funds > 1"> · {{ s.funds }}只基金</i></em></span>
            <span class="st-bar"><i :style="{ width: (s.pct / stockMax * 100) + '%' }"></i></span>
            <span class="st-pct">{{ s.pct.toFixed(2) }}%</span>
            <span class="st-val">{{ num(s.value, 0) }}</span>
          </div>
          <div class="note">个股占比 = Σ 基金市值 × 个股占该基金净值比例 ÷ 组合总市值。前十大来源时为近似（未覆盖前十之外）。</div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.card { background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
.sec { font-size: 13px; color: #969799; margin: 4px 4px 8px; }
.sum-row { display: grid; grid-template-columns: repeat(3, 1fr); }
.sum-row .k { font-size: 11px; color: #969799; }
.sum-row .v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; color: #0f9d75; }
.src { font-size: 11px; color: #c8c9cc; margin-top: 8px; }
.st { display: flex; align-items: center; font-size: 12px; margin: 9px 0; }
.st-rk { width: 18px; color: #c8c9cc; font-variant-numeric: tabular-nums; }
.st-nm { width: 110px; color: #323233; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st-nm em { font-style: normal; color: #c8c9cc; font-size: 10px; margin-left: 4px; }
.st-nm em i { font-style: normal; color: #0f9d75; }
.st-bar { flex: 1; height: 6px; background: #eef0f2; border-radius: 3px; margin: 0 8px; overflow: hidden; }
.st-bar i { display: block; height: 100%; background: #0f9d75; border-radius: 3px; }
.st-pct { width: 46px; text-align: right; color: #323233; font-variant-numeric: tabular-nums; }
.st-val { width: 60px; text-align: right; color: #969799; font-variant-numeric: tabular-nums; }
.note { font-size: 11px; color: #c8c9cc; margin-top: 8px; line-height: 1.5; }
</style>
