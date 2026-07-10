<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { fetchEstimates, latestNavMove, preferredDailyMove, type Estimate, type NavMove } from '@/utils/estimate'
import { pct, num, colorOf } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import Icon from '@/components/Icon.vue'
import { computeAttribution, computePeriodAttribution } from '@/utils/attribution'
import { exportHoldingsCSV, exportPeriodAttributionCSV, exportSnapshotsCSV } from '@/utils/export'
import { loadSnapshots, takeSnapshot, takeDailySnapshot, buildSnapChart } from '@/utils/snapshots'
import { computeAssetClass, REFERENCE_ALLOCATION, CLASS_COLORS, type AssetClass } from '@/utils/assetclass'
import { loadManualAssets, pullManualAssets, pushManualAssets, removeManualAsset, upsertManualAsset, MANUAL_ASSET_CLASSES, type ManualAsset } from '@/utils/manualAssets'
import { stressTest, computeStyleBox, rebalancePlan, computeCorrelation, type StyleBoxItem, type StressResult, type RebalanceAction, type CorrMatrix } from '@/utils/diagnostics'

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()

const meta = reactive<Record<string, { nav: number | null; type: string; navMove: NavMove | null }>>({})
const est = reactive<Record<string, Estimate | null>>({})
const loading = ref(true)
const dim = ref<'account' | 'type'>('account')
const manualAssets = ref<ManualAsset[]>(loadManualAssets())
const manualShow = ref(false)
const manualId = ref('')
const manualName = ref('')
const manualClass = ref<AssetClass>('现金')
const manualValue = ref('')
const manualNote = ref('')
const manualSyncing = ref(false)

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
      meta[e.code] = { nav: d.latest_nav, type: d.type || '其他', navMove: latestNavMove(d.nav_history) }
    } catch { meta[e.code] = { nav: null, type: '其他', navMove: null } }
  }))
  snaps.value = takeDailySnapshot(total.value.value, total.value.cost, new Date(), snapshotHoldings.value)
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
    const move = preferredDailyMove(est[e.code], m?.navMove, m?.type || e.name)
    const today = move && move.change != null && move.baseNav != null
      ? e.shares * move.baseNav * move.change / 100 : null
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
  for (const a of manualAssets.value) {
    value += a.value
    cost += a.value
  }
  const profit = value - cost
  return { value, cost, profit, rate: cost > 0 ? (profit / cost) * 100 : null, today: hasToday ? today : null }
})

// V3-8 收益归因
const attr = computed(() => {
  const hl = holdings.value.filter((h) => h.value > 0)
  if (!hl.length) return null
  return computeAttribution(hl.map((h) => {
    const move = preferredDailyMove(est[h.code], meta[h.code]?.navMove, h.type || h.name)
    return {
      code: h.code, name: h.name, account: h.account, type: h.type,
      shares: h.shares, cost: h.cost, nav: h.nav, value: h.value, profit: h.profit, today: h.today,
      todayPct: move?.change ?? null,
    }
  }))
})
const attrDim = ref<'account' | 'type'>('account')

// V3-10 组合历史快照
const snaps = ref(loadSnapshots())
const snapChart = computed(() => buildSnapChart(snaps.value))
const snapshotHoldings = computed(() => holdings.value.map((h) => ({
  id: `${h.account}|${h.code}`,
  code: h.code,
  name: h.name,
  account: h.account,
  type: h.type,
  value: h.value,
  cost: h.shares * h.cost,
})).concat(manualAssets.value.map((a) => ({
  id: `manual|${a.id}`,
  code: a.id,
  name: a.name,
  account: '手工资产',
  type: a.cls,
  value: a.value,
  cost: a.value,
}))))
const periodAttr = computed(() => computePeriodAttribution(snaps.value, 30))
function doSnap() {
  snaps.value = takeSnapshot(total.value.value, total.value.cost, new Date(), snapshotHoldings.value)
}

// V3-13 大类资产
const assetClass = computed(() => computeAssetClass([
  ...holdings.value,
  ...manualAssets.value.map((a) => ({ value: a.value, type: a.cls })),
]))
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
  const order: AssetClass[] = ['权益', '固收', '混合', '海外', '现金', '商品']
  return order.map((cls) => ({ cls, actual: map.get(cls) || 0, ref: REFERENCE_ALLOCATION[cls] }))
})

// V4-3 组合诊断
const diagLoading = ref(false)
const styleBox = ref<StyleBoxItem[]>([])
const stressRes = ref<StressResult[]>([])
const rebalance = ref<RebalanceAction[]>([])
const corrMatrix = ref<CorrMatrix | null>(null)
const diagErr = ref('')

async function runDiagnostics() {
  if (diagLoading.value) return
  diagLoading.value = true; diagErr.value = ''
  try {
    // 风格箱（同步，不需要额外数据）
    styleBox.value = computeStyleBox(
      holdings.value.map((h) => ({ code: h.code, name: h.name, type: h.type, value: h.value })),
    )

    // 压力测试
    const cls = assetClass.value.classes
    const eq = cls.find((c) => c.cls === '权益')?.pct || 0
    const bd = cls.find((c) => c.cls === '固收')?.pct || 0
    const ca = cls.find((c) => c.cls === '现金')?.pct || 0
    const ov = cls.find((c) => c.cls === '海外')?.pct || 0
    stressRes.value = stressTest({
      equityPct: eq, bondPct: bd, cashPct: ca, overseasPct: ov,
      totalValue: total.value.value,
    })

    // 再平衡
    rebalance.value = rebalancePlan(
      assetClass.value.classes.map((c) => ({ cls: c.cls, pct: c.pct, value: c.value })),
      REFERENCE_ALLOCATION as unknown as Record<string, number>,
      total.value.value,
    )

    // 相关性（异步，需拉净值）
    corrMatrix.value = await computeCorrelation(
      holdings.value.map((h) => ({ code: h.code, name: h.name })),
    )
  } catch (e) {
    diagErr.value = e instanceof Error ? e.message : '诊断失败'
  } finally { diagLoading.value = false }
}

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

function openManual(asset?: ManualAsset) {
  manualId.value = asset?.id || ''
  manualName.value = asset?.name || ''
  manualClass.value = asset?.cls || '现金'
  manualValue.value = asset ? String(asset.value) : ''
  manualNote.value = asset?.note || ''
  manualShow.value = true
}

function saveManual() {
  manualAssets.value = upsertManualAsset(manualAssets.value, {
    id: manualId.value || undefined,
    name: manualName.value,
    cls: manualClass.value,
    value: Number(manualValue.value) || 0,
    note: manualNote.value,
  })
}

function delManual(id: string) {
  manualAssets.value = removeManualAsset(manualAssets.value, id)
}

async function uploadManual() {
  if (!watch.hasToken || manualSyncing.value) return
  manualSyncing.value = true
  try { await pushManualAssets(manualAssets.value) }
  finally { manualSyncing.value = false }
}

async function downloadManual() {
  if (!watch.hasToken || manualSyncing.value) return
  manualSyncing.value = true
  try {
    const cloud = await pullManualAssets()
    if (cloud) manualAssets.value = cloud
  } finally { manualSyncing.value = false }
}

onMounted(refresh)
</script>

<template>
  <div class="page">
    <van-nav-bar title="资产">
      <template #right><Icon name="trend" :size="18" @click="router.push('/portfolio-lab')" /></template>
    </van-nav-bar>
    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="holdings.length === 0 && manualAssets.length === 0"
        description="还没有持仓。去自选页给基金填上份额/成本/账户" />
      <template v-else>
        <!-- 总资产 -->
        <div class="hero card">
          <div class="hero-inner">
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
          <!-- 金脊远山 -->
          <svg class="hero-ridge" viewBox="0 0 400 28" preserveAspectRatio="none">
            <path d="M0 28 L0 14 Q60 6 120 14 Q180 22 240 8 Q300 -4 360 14 Q380 18 400 10 L400 28Z" fill="#C8A75B" opacity="0.08" />
            <path d="M0 16 Q60 8 120 16 Q180 24 240 10 Q300 -2 360 16 Q380 20 400 12" fill="none" stroke="#C8A75B" stroke-opacity="0.12" stroke-width="1.5" />
          </svg>
        </div>

        <!-- V3-10 组合历史曲线 -->
        <div class="card">
          <div class="dim-head">
            <span class="sec-t">组合历史</span>
            <div class="snap-actions">
              <van-button size="mini" plain icon="down" :disabled="!snaps.length" @click="exportSnapshotsCSV(snaps)">导出</van-button>
              <van-button size="mini" plain icon="photograph" @click="doSnap">拍快照</van-button>
            </div>
          </div>
          <template v-if="snapChart">
            <Chart :option="snapChart" height="220px" />
            <div class="snap-hint">共 {{ snaps.length }} 个快照 · {{ snaps[0].date.slice(0,10) }} ~ {{ snaps[snaps.length-1].date.slice(0,10) }}。每天打开资产页会自动记录一次，手动快照会覆盖当天数值。</div>
          </template>
          <van-empty v-else description="快照已开始记录，累计两天后显示组合曲线。" image-size="60" />
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
            <div class="manual-head">
              <span>手工资产</span>
              <div class="manual-actions">
                <van-button size="mini" plain icon="down" :disabled="!watch.hasToken" :loading="manualSyncing" @click="downloadManual">下载</van-button>
                <van-button size="mini" plain icon="upgrade" :disabled="!watch.hasToken" :loading="manualSyncing" @click="uploadManual">上传</van-button>
                <van-button size="mini" plain icon="plus" @click="openManual()">新增</van-button>
              </div>
            </div>
            <div class="manual-row" v-for="a in manualAssets" :key="a.id">
              <span class="manual-name">{{ a.name }}<em>{{ a.cls }}</em></span>
              <span class="manual-value">{{ num(a.value, 2) }}</span>
              <van-icon name="edit" color="#4C7E67" size="16" @click="openManual(a)" />
              <van-icon name="cross" color="#A8B2A8" size="16" @click="delManual(a.id)" />
            </div>
            <div class="class-ref" v-if="!manualAssets.length">可把现金、股票、黄金等非基金资产手工纳入总览。</div>
          </div>
        </template>

        <!-- V4-3 组合诊断 -->
        <div class="sec">组合诊断</div>
        <div class="card">
          <van-button plain icon="gem-o" size="small" :loading="diagLoading" @click="runDiagnostics" block>
            运行诊断（风格箱 · 压力测试 · 再平衡 · 相关性）
          </van-button>
          <div class="diag-err" v-if="diagErr">{{ diagErr }}</div>

          <!-- 风格箱 -->
          <template v-if="styleBox.length">
            <div class="diag-sub">风格箱</div>
            <div class="style-grid">
              <div class="style-box" v-for="s in styleBox" :key="s.code">
                <span class="sb-name">{{ s.name }}</span>
                <span class="sb-style">{{ s.style }}</span>
                <span class="sb-pct">{{ s.pct.toFixed(1) }}%</span>
              </div>
            </div>
          </template>

          <!-- 压力测试 -->
          <template v-if="stressRes.length">
            <div class="diag-sub">压力测试</div>
            <div class="stress-grid">
              <div class="st-card" v-for="s in stressRes" :key="s.name">
                <div class="st-name">{{ s.name }}</div>
                <div class="st-desc">{{ s.desc }}</div>
                <div class="st-pnl" :style="{ color: s.pnl <= 0 ? '#3D8B63' : '#C44536' }">
                  {{ s.pnl >= 0 ? '+' : '' }}{{ s.pnl.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}
                </div>
                <div class="st-pct" :style="{ color: s.pnlPct <= 0 ? '#3D8B63' : '#C44536' }">
                  {{ s.pnlPct >= 0 ? '+' : '' }}{{ s.pnlPct.toFixed(2) }}%
                </div>
              </div>
            </div>
            <div class="diag-note">基于大类资产配置的历史场景模拟，不代表未来。</div>
          </template>

          <!-- 再平衡路线图 -->
          <template v-if="rebalance.length">
            <div class="diag-sub">再平衡路线图</div>
            <div class="rb-row" v-for="r in rebalance" :key="r.cls">
              <span class="rb-cls">{{ r.cls }}</span>
              <span class="rb-cur">{{ r.current.toFixed(1) }}%</span>
              <span class="rb-arr">→</span>
              <span class="rb-tgt">{{ r.target }}%</span>
              <span class="rb-act" :style="{
                color: r.action === '加仓' ? '#C44536' : r.action === '减仓' ? '#3D8B63' : '#5A6A60',
              }">{{ r.action }}</span>
              <span class="rb-detail">{{ r.detail }}</span>
            </div>
          </template>

          <!-- 相关性矩阵 -->
          <template v-if="corrMatrix && corrMatrix.pairs.length">
            <div class="diag-sub">相关性矩阵</div>
            <div class="corr-pairs">
              <div class="corr-pair" v-for="p in corrMatrix.pairs.sort((a, b) => b.corr - a.corr).slice(0, 10)" :key="p.a + p.b">
                <span class="cp-names">{{ p.aName }} ↔ {{ p.bName }}</span>
                <van-progress :percentage="((p.corr + 1) / 2) * 100" :show-pivot="false"
                  :color="p.corr > 0.7 ? '#C44536' : p.corr > 0.4 ? '#C8963E' : '#4C7E67'"
                  track-color="var(--border)" style="flex:1;margin:0 8px" />
                <span class="cp-val" :style="{
                  color: p.corr > 0.7 ? '#C44536' : p.corr > 0.4 ? '#C8963E' : '#4C7E67',
                }">{{ p.corr.toFixed(2) }}</span>
              </div>
            </div>
            <div class="corr-note" v-if="corrMatrix.pairs.some((p) => p.corr > 0.8)">
              ⚠ 部分持仓相关性 &gt; 0.8，组合分散化效果较弱
            </div>
            <div class="corr-note" v-else>组合内基金相关性在合理范围。</div>
          </template>
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
                  color="#4C7E67" track-color="var(--border)" style="flex:1;margin:0 8px" />
                <span class="atr-d" :style="{ color: colorOf(g.dayContrib) }">{{ g.dayContrib != null ? (g.dayContrib >= 0 ? '+' : '') + g.dayContrib.toFixed(2) + 'bp' : '--' }}</span>
              </div>
            </template>
            <template v-else>
              <div class="atr-row" v-for="g in attr.byType" :key="g.type">
                <span class="atr-nm">{{ g.type }}</span>
                <span class="atr-w">{{ g.weight.toFixed(1) }}%</span>
                <van-progress :percentage="Math.min(g.weight, 100)" :show-pivot="false"
                  color="#4C7E67" track-color="var(--border)" style="flex:1;margin:0 8px" />
                <span class="atr-d" :style="{ color: colorOf(g.dayContrib) }">{{ g.dayContrib != null ? (g.dayContrib >= 0 ? '+' : '') + g.dayContrib.toFixed(2) + 'bp' : '--' }}</span>
              </div>
            </template>
            <div class="atr-note">bp = 基点（万分比），今日估算贡献</div>
          </div>

          <div class="card">
            <div class="dim-head">
              <span class="sec-t">近30日归因</span>
              <div class="period-tools" v-if="periodAttr">
                <span class="period-range">{{ periodAttr.startDate.slice(5) }} ~ {{ periodAttr.endDate.slice(5) }}</span>
                <van-button size="mini" plain icon="down" @click="exportPeriodAttributionCSV(periodAttr)">导出</van-button>
              </div>
            </div>
            <template v-if="periodAttr">
              <div class="period-head">
                <div>
                  <div class="kk">区间收益</div>
                  <div class="period-v" :style="{ color: colorOf(periodAttr.delta) }">
                    {{ periodAttr.delta >= 0 ? '+' : '' }}{{ num(periodAttr.delta, 2) }}
                    <em>{{ pct(periodAttr.returnPct) }}</em>
                  </div>
                </div>
                <div>
                  <div class="kk">期初 / 期末</div>
                  <div class="period-small">{{ num(periodAttr.startValue, 0) }} → {{ num(periodAttr.endValue, 0) }}</div>
                </div>
              </div>
              <div class="period-sub">按账户</div>
              <div class="atr-row" v-for="g in periodAttr.byAccount.slice(0, 5)" :key="g.account">
                <span class="atr-nm">{{ g.account }}</span>
                <span class="atr-w">{{ g.contribPct.toFixed(2) }}%</span>
                <van-progress :percentage="Math.min(Math.abs(g.contribPct), 100)" :show-pivot="false"
                  :color="g.delta >= 0 ? '#C44536' : '#3D8B63'" track-color="var(--border)" style="flex:1;margin:0 8px" />
                <span class="atr-d" :style="{ color: colorOf(g.delta) }">{{ g.delta >= 0 ? '+' : '' }}{{ num(g.delta, 0) }}</span>
              </div>
              <div class="period-sub">按类型</div>
              <div class="atr-row" v-for="g in periodAttr.byType.slice(0, 5)" :key="g.type">
                <span class="atr-nm">{{ g.type }}</span>
                <span class="atr-w">{{ g.contribPct.toFixed(2) }}%</span>
                <van-progress :percentage="Math.min(Math.abs(g.contribPct), 100)" :show-pivot="false"
                  :color="g.delta >= 0 ? '#C44536' : '#3D8B63'" track-color="var(--border)" style="flex:1;margin:0 8px" />
                <span class="atr-d" :style="{ color: colorOf(g.delta) }">{{ g.delta >= 0 ? '+' : '' }}{{ num(g.delta, 0) }}</span>
              </div>
              <div class="period-best" v-if="periodAttr.best || periodAttr.worst">
                <span v-if="periodAttr.best">最佳 {{ periodAttr.best.name }}：<b :style="{ color: colorOf(periodAttr.best.delta) }">{{ periodAttr.best.delta >= 0 ? '+' : '' }}{{ num(periodAttr.best.delta, 0) }}</b></span>
                <span v-if="periodAttr.worst">最弱 {{ periodAttr.worst.name }}：<b :style="{ color: colorOf(periodAttr.worst.delta) }">{{ periodAttr.worst.delta >= 0 ? '+' : '' }}{{ num(periodAttr.worst.delta, 0) }}</b></span>
              </div>
              <div class="atr-note">基于组合快照明细，反映区间资产变动贡献；申赎/手工调仓会影响归因。</div>
            </template>
            <van-empty v-else description="需要至少两条含持仓明细的快照，之后会自动显示近30日归因。" image-size="50" />
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

    <van-dialog v-model:show="manualShow" title="手工资产" show-cancel-button @confirm="saveManual">
      <div style="padding:8px 4px">
        <van-field v-model="manualName" label="名称" placeholder="如 现金、股票账户、黄金" />
        <van-field v-model="manualValue" type="number" label="市值" placeholder="0.00" />
        <van-field v-model="manualNote" label="备注" placeholder="可留空" />
        <div class="manual-chips">
          <span v-for="c in MANUAL_ASSET_CLASSES" :key="c"
            :class="['chip', { on: manualClass === c }]"
            @click="manualClass = c">{{ c }}</span>
        </div>
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.card { background: var(--card-bg); border-radius: var(--radius-lg); padding: 14px; margin-bottom: 12px; border: 1px solid var(--border); box-shadow: var(--shadow-sm); }
.act-row { display: flex; gap: 8px; margin-bottom: 12px; }
.act-row .lt-btn { flex: 1; margin-bottom: 0; }
.hero { position: relative; overflow: hidden; padding: 0; }
.hero-inner { padding: 14px 14px 8px; }
.hero .k { font-size: 12px; color: var(--text-muted); }
.hero .big { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 2px 0 10px; color: var(--text); }
.hero-ridge { display: block; width: 100%; height: 28px; }
.hero-row { padding-bottom: 4px; }
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
.period-range { font-size: 11px; color: var(--text-hint); }
.period-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.period-v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.period-v em { font-style: normal; font-size: 12px; margin-left: 4px; }
.period-small { font-size: 13px; color: var(--text-secondary); font-variant-numeric: tabular-nums; margin-top: 2px; }
.period-sub { font-size: 12px; color: var(--text-muted); margin: 10px 0 4px; }
.period-best { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--text-secondary); margin-top: 8px; }
.period-best b { font-weight: 700; font-variant-numeric: tabular-nums; }
.conc { display: flex; gap: 16px; }
.conc div { text-align: center; }
.conc div span { display: block; font-size: 11px; color: var(--text-muted); }
.conc div b { font-size: 18px; color: var(--text); }
.conc-warn { font-size: 12px; color: #C8963E; margin-top: 6px; }
/* ── 快照 ── */
.snap-hint { font-size: 11px; color: var(--text-hint); text-align: center; margin-top: 6px; line-height: 1.5; }
.snap-actions { display: flex; gap: 6px; }
.period-tools { display: flex; align-items: center; gap: 6px; }
/* ── V3-13 大类资产 ── */
.class-bars { margin-top: 10px; }
.class-bar { display: flex; align-items: center; margin: 6px 0; font-size: 12px; }
.cb-lbl { width: 36px; color: var(--text-secondary); }
.cb-pct { width: 42px; text-align: right; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.class-ref { font-size: 11px; color: var(--text-hint); margin-top: 6px; }
.class-tip { font-size: 12px; color: #C8963E; margin-top: 4px; }
.manual-head { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 12px; color: var(--text-muted); }
.manual-actions { display: flex; gap: 6px; }
.manual-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid var(--border); font-size: 12px; }
.manual-name { flex: 1; min-width: 0; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.manual-name em { font-style: normal; color: var(--text-hint); font-size: 10px; margin-left: 4px; }
.manual-value { font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.manual-chips { display: flex; gap: 8px; padding: 8px 16px 4px; }
.manual-chips .chip { font-size: 12px; color: var(--text-secondary); background: var(--chip-bg); border-radius: 12px; padding: 3px 10px; }
.manual-chips .chip.on { color: #fff; background: var(--teal); }
/* ── V4-3 组合诊断 ── */
.diag-err { font-size: 12px; color: #C44536; margin-top: 6px; }
.diag-sub { font-size: 14px; font-weight: 600; color: var(--text); margin: 16px 0 8px; }
.diag-note { font-size: 11px; color: var(--text-hint); margin-top: 4px; }
.style-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.style-box { background: var(--chip-bg); border-radius: 8px; padding: 8px; text-align: center; }
.sb-name { display: block; font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-style { display: block; font-size: 10px; color: var(--text-muted); }
.sb-pct { display: block; font-size: 14px; font-weight: 700; color: var(--teal); }
.stress-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.st-card { background: var(--chip-bg); border-radius: 8px; padding: 8px; text-align: center; }
.st-name { font-size: 12px; font-weight: 600; color: var(--text); }
.st-desc { font-size: 10px; color: var(--text-hint); margin: 2px 0; }
.st-pnl { font-size: 15px; font-weight: 700; }
.st-pct { font-size: 11px; font-weight: 600; }
.rb-row { font-size: 12px; display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.rb-cls { width: 36px; font-weight: 600; color: var(--text); }
.rb-cur, .rb-tgt { width: 38px; text-align: right; font-variant-numeric: tabular-nums; }
.rb-arr { color: var(--text-hint); }
.rb-act { width: 32px; font-weight: 600; }
.rb-detail { flex: 1; min-width: 140px; color: var(--text-muted); }
.corr-pairs { display: flex; flex-direction: column; gap: 4px; }
.corr-pair { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.cp-names { width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-secondary); }
.cp-val { width: 32px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.corr-note { font-size: 11px; color: #C8963E; margin-top: 4px; }
</style>
