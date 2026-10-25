<script setup lang="ts">
import { reactive, ref, computed, onMounted, onBeforeUnmount, defineAsyncComponent, watch as observe } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import type { NavPoint } from '@/api/client'
import { fetchEstimates, latestNavMove, preferredDailyMove, type Estimate, type NavMove } from '@/utils/estimate'
import { pct, num, colorOf } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import Icon from '@/components/Icon.vue'
import type { OwnerPortfolioLocal } from '@/utils/ownerPortfolioLocal'
import { computeAttribution, computePeriodAttribution } from '@/utils/attribution'
import { exportHoldingsCSV, exportPeriodAttributionCSV, exportSnapshotsCSV } from '@/utils/export'
import { loadSnapshots, takeSnapshot, takeDailySnapshot, buildSnapChart } from '@/utils/snapshots'
import { computeAssetClass, REFERENCE_ALLOCATION, CLASS_COLORS, type AssetClass } from '@/utils/assetclass'
import { getManualAssetStorageStatus, loadManualAssets, pullManualAssets, pushManualAssets, removeManualAsset, upsertManualAsset, MANUAL_ASSET_CLASSES, type ManualAsset } from '@/utils/manualAssets'
import { getLegacySyncConsent, getLegacySyncGeneration, subscribeLegacySyncConsent } from '@/utils/cloud-consent'
import { stressTest, computeStyleBox, rebalancePlan, computeCorrelation, type StyleBoxItem, type StressResult, type RebalanceAction, type CorrMatrix } from '@/utils/diagnostics'
import { completeFiniteSum, costBasisCoverage, holdingCostBasis, holdingMarketValue, valuationCoverage } from '@/utils/portfolioCoverage'
import { aggregateFundHoldings } from '@/utils/holding-aggregation'

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()
const OwnerPortfolioMigrationPanel = defineAsyncComponent(() => import('@/components/OwnerPortfolioMigrationPanel.vue'))

const meta = reactive<Record<string, {
  nav: number | null
  type: string
  navMove: NavMove | null
  navHistory: NavPoint[]
}>>({})
const est = reactive<Record<string, Estimate | null>>({})
const loading = ref(true)
const localReadError = ref(false)
const localAuthorityKnown = ref(false)
const localAuthorityReady = computed(() => ['legacy', 'idb'].includes(watch.authorityState) && !watch.localStorageError)
const dim = ref<'account' | 'type'>('account')
// Authority must be resolved before touching either legacy business slot. An
// adopted IDB workspace must never silently mix in these independent LS files.
const legacyManualAssets = ref<ManualAsset[]>([])
const legacySnaps = ref<ReturnType<typeof loadSnapshots>>([])
const isLegacy = computed(() => localAuthorityKnown.value && localAuthorityReady.value && watch.authorityState === 'legacy')
const isPortfolio = computed(() => localAuthorityKnown.value && localAuthorityReady.value && watch.authorityState === 'idb'
  && watch.localSyncFormat === 'v5' && watch.portfolioState != null)
const manualAssets = computed(() => isPortfolio.value
  ? watch.portfolioState!.manual.filter(row => !row.deleted).map(row => ({ id: row.key, name: row.values.name,
    cls: row.values.cls, value: row.values.value, note: row.values.note ?? undefined, updated_at: row.updated_at }))
  : isLegacy.value ? legacyManualAssets.value : [])
const portfolioCostUnknown = computed(() => isPortfolio.value && (manualAssets.value.length > 0
  || watch.activeHoldings.some(row => !row.deleted && row.position_kind === 'holding' && row.shares === 0 && row.cost == null)))
const canEditManual = computed(() => (isLegacy.value || isPortfolio.value) && !watch.hasPendingLocalWorkspaceEdit)
const manualShow = ref(false)
const manualId = ref('')
const manualName = ref('')
const manualClass = ref<AssetClass>('现金')
const manualValue = ref('')
const manualNote = ref('')
let manualPortfolioSource: OwnerPortfolioLocal | null = null
const manualSyncing = ref(false)
const manualStorageStatus = ref<ReturnType<typeof getManualAssetStorageStatus>>('idle')
const manualStorageKnown = computed(() => isPortfolio.value || isLegacy.value
  && manualStorageStatus.value !== 'invalid' && manualStorageStatus.value !== 'storage-error')
const manualSaving = ref(false), snapshotSaving = ref(false)
const legacySyncEnabled = ref(getLegacySyncConsent())
const manualStatus = ref('正在核对资产权威存储，尚未读取独立资产文件')
let disposed = false
const unsubscribeConsent = subscribeLegacySyncConsent(consent => {
  legacySyncEnabled.value = consent
  if (!consent) manualStatus.value = '云同步已关闭，本地手工资产保留'
})
observe(() => [watch.authorityState, watch.localSyncFormat], () => {
  manualShow.value = false
  manualPortfolioSource = null
  if (!isLegacy.value) { legacyManualAssets.value = []; legacySnaps.value = [] }
}, { flush: 'sync' })
onBeforeUnmount(() => { disposed = true; unsubscribeConsent() })

const UNGROUPED = '未分组'
const holdingInput = computed(() => aggregateFundHoldings(watch.activeHoldings))
const positiveHoldings = computed(() => {
  const identities = new Map<string, number>()
  for (const row of watch.activeHoldings) {
    if (row.deleted || (row.account != null && typeof row.account !== 'string')) continue
    const identity = `${row.code}::${row.account?.trim() || ''}`
    identities.set(identity, (identities.get(identity) || 0) + 1)
  }
  return watch.activeHoldings.filter(row => {
    if (row.deleted || row.position_kind === 'watch' || typeof row.shares !== 'number' || !Number.isFinite(row.shares) || row.shares <= 0) return false
    if (!aggregateFundHoldings([row]).complete) return false
    const identity = `${row.code}::${row.account?.trim() || ''}`
    return identities.get(identity) === 1
  })
})

async function refresh() {
  loading.value = true
  localReadError.value = false; localAuthorityKnown.value = false
  try {
    await watch.load(true)
    if (disposed) return
    if (!localAuthorityReady.value) throw new Error('local_authority_unavailable')
    localAuthorityKnown.value = true
    if (isLegacy.value) {
      legacyManualAssets.value = loadManualAssets()
      manualStorageStatus.value = getManualAssetStorageStatus()
      legacySnaps.value = loadSnapshots()
      manualStatus.value = '默认仅保存在本机，未同步到云端'
    } else {
      manualStatus.value = isPortfolio.value ? '共同工作区本机输入，尚未同步到云端'
        : '手工资产与历史尚未并入共同工作区；请先完成下方显式迁移'
    }
    // V3-12: 使用 activeHoldings（复合键，支持跨账户同一基金多笔持仓）
    const held = positiveHoldings.value
    const codes = [...new Set(held.map((e) => e.code))]
    void fetchEstimates(codes).then((m) => { if (!disposed && localAuthorityReady.value) m.forEach((v, k) => { est[k] = v }) }).catch(() => {})
    await Promise.all(codes.map(async (code) => {
      try {
        const d = await funds.detail(code)
        if (disposed || !localAuthorityReady.value) return
        meta[code] = { nav: d.latest_nav, type: d.type || '其他', navMove: latestNavMove(d.nav_history), navHistory: d.nav_history || [] }
      } catch { if (!disposed && localAuthorityReady.value) meta[code] = { nav: null, type: '其他', navMove: null, navHistory: [] } }
    }))
    if (!disposed && !localAuthorityReady.value) throw new Error('local_authority_unavailable')
    if (!disposed && isLegacy.value && portfolioReady.value && total.value.value != null && total.value.cost != null) {
      legacySnaps.value = takeDailySnapshot(total.value.value, total.value.cost, new Date(), snapshotHoldings.value)
    }
  } catch {
    if (!disposed) { localReadError.value = true; localAuthorityKnown.value = false }
  } finally { if (!disposed) loading.value = false }
}

// 单只持仓的派生指标
interface Holding {
  key: string; code: string; name: string; account: string; type: string
  shares: number; cost: number | null; costBasis: number | null; nav: number | null
  value: number | null; profit: number | null; today: number | null
}
const holdings = computed<Holding[]>(() => {
  const out: Holding[] = []
  // V3-12：迭代 activeHoldings（复合键），同一基金不同账户各自独立一行
  for (const e of positiveHoldings.value) {
    // The positive-position view must not make omitted unknown/invalid inputs
    // look like a complete portfolio; holdingInput gates the whole result.
    if (e.shares == null) continue
    const m = meta[e.code]
    const nav = m?.nav != null && Number.isFinite(m.nav) && m.nav > 0 ? m.nav : null
    const value = holdingMarketValue(e.shares, nav)
    const cost = e.cost != null && Number.isFinite(e.cost) && e.cost >= 0 ? e.cost : null
    const costBasis = holdingCostBasis(e.shares, cost)
    const move = preferredDailyMove(est[e.code], m?.navMove, m?.type || e.name)
    const today = move && move.change != null && move.baseNav != null
      ? e.shares * move.baseNav * move.change / 100 : null
    out.push({
      key: `${e.code}::${e.account?.trim() || ''}`, code: e.code, name: e.name || e.code, account: e.account?.trim() || UNGROUPED,
      type: m?.type || '其他', shares: e.shares, cost, costBasis, nav,
      value, profit: value != null && costBasis != null ? value - costBasis : null, today,
    })
  }
  return out
})
const codesForDiagnostics = computed(() => [...new Set(holdings.value.map((holding) => holding.code))])

const valuation = computed(() => valuationCoverage(holdings.value))
const costs = computed(() => costBasisCoverage(holdings.value.map((holding) => ({
  code: holding.code,
  name: holding.name,
  basis: holding.costBasis,
}))))
const portfolioReady = computed(() => localAuthorityReady.value && localAuthorityKnown.value && !localReadError.value && holdingInput.value.complete && valuation.value.complete && costs.value.complete && total.value.value != null && total.value.cost != null)
const unpricedNames = computed(() => [...new Set(valuation.value.missing.map((holding) => holding.name))])
const missingCostNames = computed(() => [...new Set(costs.value.missing.map((holding) => holding.name))])
const todayCoverage = computed(() => {
  const missingHoldings = holdings.value.filter((holding) => holding.today == null).map((holding) => holding.name)
  const missing = [...missingHoldings, ...manualAssets.value.map((asset) => asset.name), ...(!manualStorageKnown.value ? ['本地手工资产未知'] : []), ...(!holdingInput.value.complete ? ['持仓输入未知或账户重复'] : [])]
  return {
    complete: holdings.value.length > 0 && missing.length === 0,
    covered: holdings.value.filter((holding) => holding.today != null).length,
    total: holdings.value.length + manualAssets.value.length,
    missing: [...new Set(missing)],
  }
})

const total = computed(() => {
  let manualValue = 0
  for (const a of manualAssets.value) {
    manualValue += a.value
  }
  const sum = (first: number | null, second: number): number | null => first != null && Number.isFinite(first + second) ? first + second : null
  const pricedValue = holdingInput.value.complete ? sum(valuation.value.pricedValue, manualValue) : null
  const value = valuation.value.complete && manualStorageKnown.value ? pricedValue : null
  const knownCost = holdingInput.value.complete ? sum(costs.value.knownCost, isPortfolio.value ? 0 : manualValue) : null
  // A manual balance is not a purchase cost. v5 keeps that unknown instead of
  // manufacturing zero manual P/L from the current balance.
  const cost = costs.value.complete && manualStorageKnown.value && !portfolioCostUnknown.value ? knownCost : null
  const profit = value != null && cost != null ? value - cost : null
  return {
    value,
    pricedValue,
    cost,
    profit,
    knownCost,
    rate: profit != null && cost != null && cost > 0 && Number.isFinite((profit / cost) * 100) ? (profit / cost) * 100 : null,
    today: manualStorageKnown.value && holdingInput.value.complete ? completeFiniteSum([
      ...holdings.value.map((holding) => holding.today),
      ...manualAssets.value.map(() => null),
    ]) : null,
  }
})

// V3-8 收益归因
const attr = computed(() => {
  if (!portfolioReady.value) return null
  const hl = holdings.value.filter(
    (h): h is Holding & { value: number; profit: number } => h.value != null && h.value > 0 && h.profit != null,
  )
  if (!hl.length) return null
  return computeAttribution(hl.map((h) => {
    const move = preferredDailyMove(est[h.code], meta[h.code]?.navMove, h.type || h.name)
    return {
      code: h.code, name: h.name, account: h.account, type: h.type,
      shares: h.shares, cost: h.cost as number, nav: h.nav, value: h.value, profit: h.profit,
      today: todayCoverage.value.complete ? h.today : null,
      todayPct: todayCoverage.value.complete ? move?.change ?? null : null,
    }
  }))
})
const attrDim = ref<'account' | 'type'>('account')

// V3-10 组合历史快照
const portfolioHistory = computed(() => isPortfolio.value ? watch.portfolioState!.history : [])
const emptyPortfolio = computed(() => holdingInput.value.complete && manualAssets.value.length === 0
  && (isPortfolio.value ? holdingInput.value.funds.length === 0 && portfolioHistory.value.length === 0 : holdings.value.length === 0))
const snaps = computed(() => legacySnaps.value)
const historyPage = ref(0)
const expandedHistory = ref<ReadonlySet<string>>(new Set())
const historyPageCount = computed(() => Math.max(1, Math.ceil(portfolioHistory.value.length / 10)))
const historyRows = computed(() => [...portfolioHistory.value].reverse().slice(historyPage.value * 10, (historyPage.value + 1) * 10))
observe(() => portfolioHistory.value.length, () => { historyPage.value = 0; expandedHistory.value = new Set() })
function toggleHistory(id: string, event: Event) {
  const next = new Set(expandedHistory.value)
  if ((event.target as HTMLDetailsElement).open) next.add(id); else next.delete(id)
  expandedHistory.value = next
}
const snapChart = computed(() => {
  if (!isPortfolio.value) return buildSnapChart(snaps.value)
  const history = portfolioHistory.value
  if (history.length < 2) return null
  return { grid: { left: 48, right: 16, top: 30, bottom: 32 }, tooltip: { trigger: 'axis' },
    legend: { top: 0, data: ['余额', '成本/旧记录值'], textStyle: { fontSize: 11 } },
    xAxis: { type: 'category', data: history.map(row => `${row.date}${row.calendar === 'legacy-utc' ? ' UTC旧档' : ' 上海'}`), boundaryGap: false },
    yAxis: { type: 'value', scale: true }, series: [
      { name: '余额', type: 'line', showSymbol: false, data: history.map(row => row.value), lineStyle: { color: '#4C7E67' } },
      { name: '成本/旧记录值', type: 'line', showSymbol: false, connectNulls: false, data: history.map(row => row.cost), lineStyle: { color: '#969799' } },
    ] }
})
const snapshotHoldings = computed(() => {
  if (!portfolioReady.value) return []
  return holdings.value.map((h) => ({
    id: `${h.account}|${h.code}`,
    code: h.code,
    name: h.name,
    account: h.account,
    type: h.type,
    value: h.value as number,
    cost: h.costBasis as number,
  })).concat(manualAssets.value.map((a) => ({
    id: `manual|${a.id}`,
    code: a.id,
    name: a.name,
    account: '手工资产',
    type: a.cls,
    value: a.value,
    cost: a.value,
  })))
})
const periodAttr = computed(() => isLegacy.value ? computePeriodAttribution(snaps.value, 30) : null)
const observationReady = computed(() => isPortfolio.value && holdingInput.value.complete && valuation.value.complete
  && manualStorageKnown.value && total.value.value !== null && !watch.hasPendingLocalWorkspaceEdit)
function doSnap() {
  if (isPortfolio.value) return appendObservation()
  if (!isLegacy.value || !portfolioReady.value || total.value.value == null || total.value.cost == null) return
  legacySnaps.value = takeSnapshot(total.value.value, total.value.cost, new Date(), snapshotHoldings.value)
}
async function appendObservation() {
  if (!observationReady.value || snapshotSaving.value) return
  const original = watch.portfolioState, inputs = watch.activeHoldings, priced = holdings.value
  const assertCurrent = () => {
    if (disposed || !observationReady.value || watch.portfolioState !== original || watch.activeHoldings !== inputs
      || holdings.value !== priced) throw new Error('portfolio_observation_source_changed')
  }
  snapshotSaving.value = true
  try {
    const builder = await import('@/utils/owner-portfolio-observation')
    assertCurrent()
    const observation = builder.buildOwnerPortfolioObservation(original, inputs, meta, `observation:${crypto.randomUUID()}`, new Date())
    assertCurrent()
    await watch.editPortfolio({ type: 'append_observation', observation })
    if (!disposed) showToast('已记录本机余额观察，未上传；不是现金流调整收益')
  } catch { if (!disposed) showToast('余额观察未核定；请保留原本机请求并手动核对，不要重复点击') }
  finally { if (!disposed) snapshotSaving.value = false }
}
async function exportHistory() {
  if (!isPortfolio.value) { if (isLegacy.value) exportSnapshotsCSV(snaps.value); return }
  const original = watch.portfolioState
  try {
    const builder = await import('@/utils/owner-portfolio-observation')
    if (disposed || !isPortfolio.value || watch.portfolioState !== original) throw new Error('portfolio_export_source_changed')
    const raw = builder.buildOwnerPortfolioHistoryExport(original)
    if (disposed || !isPortfolio.value || watch.portfolioState !== original) throw new Error('portfolio_export_source_changed')
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a')
    try { anchor.href = url; anchor.download = '司南基金_余额观察与旧历史.json'; document.body.appendChild(anchor); anchor.click() }
    finally { anchor.remove(); URL.revokeObjectURL(url) }
  } catch { if (!disposed) showToast('历史导出未完成或来源已变化；原记录保留，未回退旧存储') }
}

// V3-13 大类资产
const assetClass = computed(() => computeAssetClass(valuation.value.complete && total.value.value != null ? [
  ...holdings.value.map((holding) => ({ ...holding, value: holding.value as number })),
  ...manualAssets.value.map((a) => ({ value: a.value, type: a.cls })),
] : []))
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
const rankedCorrPairs = computed(() => (corrMatrix.value?.pairs || []).slice().sort((a, b) => {
  if (a.corr == null) return b.corr == null ? 0 : 1
  if (b.corr == null) return -1
  return b.corr - a.corr
}))
const unknownCorrCount = computed(() => corrMatrix.value?.pairs.filter((pair) => pair.corr == null).length || 0)
const highCorrExists = computed(() => corrMatrix.value?.pairs.some((pair) => pair.corr != null && pair.corr > 0.8) || false)

async function runDiagnostics() {
  if (diagLoading.value) return
  const portfolioValue = total.value.value
  if (!portfolioReady.value || portfolioValue == null) {
    diagErr.value = '存在未定价或成本缺失持仓，不能计算组合诊断'
    return
  }
  diagLoading.value = true; diagErr.value = ''
  try {
    // 风格箱（同步，不需要额外数据）
    styleBox.value = computeStyleBox(
      holdings.value.map((h) => ({ code: h.code, name: h.name, type: h.type, value: h.value as number })),
    )

    // 压力测试
    const cls = assetClass.value.classes
    const eq = cls.find((c) => c.cls === '权益')?.pct || 0
    const bd = cls.find((c) => c.cls === '固收')?.pct || 0
    const ca = cls.find((c) => c.cls === '现金')?.pct || 0
    const ov = cls.find((c) => c.cls === '海外')?.pct || 0
    stressRes.value = stressTest({
      equityPct: eq, bondPct: bd, cashPct: ca, overseasPct: ov,
      totalValue: portfolioValue,
    })

    // 再平衡
    rebalance.value = rebalancePlan(
      assetClass.value.classes.map((c) => ({ cls: c.cls, pct: c.pct, value: c.value })),
      REFERENCE_ALLOCATION as unknown as Record<string, number>,
      portfolioValue,
    )

    // 相关性复用本页已经加载的详情历史，不再对每只基金重复请求。
    corrMatrix.value = await computeCorrelation(
      holdings.value.map((h) => ({ code: h.code, name: h.name })),
      new Map(codesForDiagnostics.value.map((code) => [code, meta[code]?.navHistory || []])),
    )
  } catch (e) {
    diagErr.value = e instanceof Error ? e.message : '诊断失败'
  } finally { diagLoading.value = false }
}

// 按账户聚合
interface Group { key: string; value: number | null; cost: number | null; profit: number | null; count: number; today: number | null; todayComplete: boolean }
function groupBy(field: 'account' | 'type'): Group[] {
  const map = new Map<string, Group & { pricedValue: number; knownCost: number; valueComplete: boolean; costComplete: boolean; knownToday: number }>()
  for (const h of holdings.value) {
    const k = field === 'account' ? h.account : h.type
    let g = map.get(k)
    if (!g) {
      g = {
        key: k, value: null, cost: null, profit: null, count: 0, today: null, todayComplete: true,
        pricedValue: 0, knownCost: 0, valueComplete: true, costComplete: true, knownToday: 0,
      }
      map.set(k, g)
    }
    if (h.value == null || !Number.isFinite(h.value) || !Number.isFinite(g.pricedValue + h.value)) g.valueComplete = false
    else g.pricedValue += h.value
    if (h.costBasis == null || !Number.isFinite(h.costBasis) || !Number.isFinite(g.knownCost + h.costBasis)) g.costComplete = false
    else g.knownCost += h.costBasis
    g.count++
    if (h.today == null || !Number.isFinite(h.today) || !Number.isFinite(g.knownToday + h.today)) g.todayComplete = false
    else g.knownToday += h.today
  }
  return [...map.values()].map((g) => ({
    key: g.key,
    value: g.valueComplete ? g.pricedValue : null,
    cost: g.costComplete ? g.knownCost : null,
    profit: g.valueComplete && g.costComplete ? g.pricedValue - g.knownCost : null,
    count: g.count,
    today: g.todayComplete ? g.knownToday : null,
    todayComplete: g.todayComplete,
  })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
}
const byAccount = computed(() => groupBy('account'))

const pieOption = computed(() => {
  const groups = groupBy(dim.value).filter((g): g is Group & { value: number } => g.value != null)
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
    legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
    series: [{
      type: 'pie', radius: ['42%', '64%'], center: ['50%', '42%'], label: { show: false },
      data: groups.map((g) => ({ name: g.key, value: +g.value.toFixed(2) })),
    }],
  }
})

const rateOf = (g: Group) => (g.profit != null && g.cost != null && g.cost > 0 && Number.isFinite((g.profit / g.cost) * 100) ? (g.profit / g.cost) * 100 : null)
const share = (v: number | null) => (v != null && total.value.value != null && total.value.value > 0 && Number.isFinite((v / total.value.value) * 100) ? (v / total.value.value) * 100 : null)
const shareText = (value: number | null) => {
  const percentage = share(value)
  return percentage == null ? '--' : `${percentage.toFixed(1)}%`
}
const signedNum = (value: number | null, digits = 2) => value == null ? '--' : `${value >= 0 ? '+' : ''}${num(value, digits)}`

function openPortfolioLab() {
  if (!portfolioReady.value) return
  router.push('/portfolio-lab')
}

function openManual(asset?: { id: string; name: string; cls: AssetClass; value: number; note?: string }) {
  if (!canEditManual.value || manualSaving.value) return
  manualId.value = asset?.id || ''
  manualName.value = asset?.name || ''
  manualClass.value = asset?.cls || '现金'
  manualValue.value = asset ? String(asset.value) : ''
  manualNote.value = asset?.note || ''
  manualPortfolioSource = isPortfolio.value ? watch.portfolioState : null
  manualShow.value = true
}

function saveManual(): boolean | Promise<boolean> {
  if (!canEditManual.value || manualSaving.value) return false
  const raw = manualValue.value.trim()
  const value = raw === '' ? null : Number(raw)
  if (value == null || !Number.isFinite(value) || value < 0) {
    showToast('请填写有效的非负金额；空值不会按 0 保存')
    return false
  }
  if (isPortfolio.value) return savePortfolioManual(value)
  if (!isLegacy.value) return false
  const previous = legacyManualAssets.value
  const next = upsertManualAsset(previous, {
    id: manualId.value || undefined,
    name: manualName.value,
    cls: manualClass.value,
    value,
    note: manualNote.value,
  })
  manualStorageStatus.value = getManualAssetStorageStatus()
  if (next === previous) { showToast('本地保存失败，原记录保留，未同步'); return false }
  legacyManualAssets.value = next
  manualStatus.value = '已保存在本机，未同步到云端'
  showToast('已保存在本机，未同步')
  return true
}

async function savePortfolioManual(value: number): Promise<boolean> {
  if (!manualPortfolioSource || watch.portfolioState !== manualPortfolioSource) {
    showToast('共同工作区已变化；原表单未覆盖新记录，请重新打开后核对'); return false
  }
  manualSaving.value = true
  try {
    const key = manualId.value || `asset:${crypto.randomUUID()}`
    await watch.editPortfolio({ type: 'save_manual', key, values: { name: manualName.value.trim() || manualClass.value,
      cls: manualClass.value as '现金' | '权益' | '商品', value, note: manualNote.value.trim() || null }, updated_at: new Date().toISOString() })
    if (!disposed) { manualStatus.value = '已保存在共同工作区本机，未同步到云端'; showToast('已保存在本机，未同步') }
    return true
  } catch { if (!disposed) showToast('本机保存未核定；请手动核对原请求，不会自动重放'); return false }
  finally { if (!disposed) manualSaving.value = false }
}

function delManual(id: string) {
  if (!canEditManual.value || manualSaving.value) return
  if (isPortfolio.value) {
    manualSaving.value = true
    void watch.editPortfolio({ type: 'remove_manual', key: id, updated_at: new Date().toISOString() }).then(() => {
      if (!disposed) { manualStatus.value = '已在共同工作区保留删除标记，未同步到云端'; showToast('已在本机移出，删除标记保留') }
    }).catch(() => { if (!disposed) showToast('本机移出未核定；请手动核对原请求，不会自动重放') })
      .finally(() => { if (!disposed) manualSaving.value = false })
    return
  }
  if (!isLegacy.value) return
  const previous = legacyManualAssets.value
  const next = removeManualAsset(previous, id)
  manualStorageStatus.value = getManualAssetStorageStatus()
  if (next === previous) { showToast('本地保存失败，原记录保留，未同步'); return }
  legacyManualAssets.value = next
  manualStatus.value = '已在本机移出，未同步到云端'
}

async function uploadManual() {
  if (!isLegacy.value) { showToast('共同工作区禁止旧版 Gist 资产读写；原本机记录保留'); return }
  if (!getLegacySyncConsent()) { showToast('请先明确开启旧版云同步；本地数据未发送'); return }
  if (!watch.hasToken || manualSyncing.value) return
  const generation = getLegacySyncGeneration()
  const baseline = legacyManualAssets.value
  manualSyncing.value = true
  try {
    const success = await pushManualAssets(baseline)
    if (disposed || !isLegacy.value || generation !== getLegacySyncGeneration() || !getLegacySyncConsent()) return
    if (legacyManualAssets.value !== baseline) { showToast('本地记录已变化，当前草稿未确认云备份'); return }
    showToast(success ? '手工资产已上传' : '上传失败，请先下载合并后重试')
    if (success) manualStatus.value = '已上传旧版 Gist 云备份'
  }
  catch { if (!disposed) showToast('手工资产上传失败，本地记录保留') }
  finally { manualSyncing.value = false }
}

async function downloadManual() {
  if (!isLegacy.value) { showToast('共同工作区禁止旧版 Gist 资产读写；原本机记录保留'); return }
  if (!getLegacySyncConsent()) { showToast('请先明确开启旧版云同步；未下载或覆盖本地数据'); return }
  if (!watch.hasToken || manualSyncing.value) return
  const generation = getLegacySyncGeneration()
  const baseline = legacyManualAssets.value
  manualSyncing.value = true
  try {
    const cloud = await pullManualAssets()
    if (disposed || !isLegacy.value || generation !== getLegacySyncGeneration() || !getLegacySyncConsent()) return
    if (legacyManualAssets.value !== baseline) { showToast('本地记录已变化，迟到下载未应用，当前草稿未同步'); return }
    manualStorageStatus.value = getManualAssetStorageStatus()
    if (cloud) {
      legacyManualAssets.value = cloud
      showToast('旧版手工资产已下载合并；不是新版确认版本')
      manualStatus.value = '已合并旧版 Gist 云备份到本机；不是新版确认版本'
    } else showToast('未合并：本地记录已变化、云数据冲突或为空；原记录保留')
  } catch { if (!disposed) showToast('手工资产下载失败，本地记录保留') }
  finally { manualSyncing.value = false }
}

onMounted(refresh)
</script>

<template>
  <div class="page">
    <van-nav-bar title="资产">
      <template #right>
        <Icon name="trend" :size="18" :class="{ 'nav-disabled': !portfolioReady }"
          :title="portfolioReady ? '打开组合实验室' : '存在未定价或成本缺失持仓，组合实验已暂停'" @click="openPortfolioLab" />
      </template>
    </van-nav-bar>
    <div class="page-body">
      <OwnerPortfolioMigrationPanel v-if="watch.authorityState !== 'legacy' && localAuthorityKnown || watch.authorityState === 'blocked'" />
      <div v-if="isLegacy && (manualStorageStatus === 'invalid' || manualStorageStatus === 'storage-error')" class="coverage-warning" role="alert">手工资产本地读取或保存失败；原始存储未被清空，也未同步。请先保留备份并修复本地记录。</div>
      <section class="card manual-card">
        <div class="manual-head">
          <span>手工资产 · 本机输入</span>
          <div class="manual-actions">
            <van-button v-if="isLegacy" size="mini" plain icon="down" :disabled="!watch.hasToken || !legacySyncEnabled" :loading="manualSyncing" @click="downloadManual">下载合并</van-button>
            <van-button v-if="isLegacy" size="mini" plain icon="upgrade" :disabled="!watch.hasToken || !legacySyncEnabled" :loading="manualSyncing" @click="uploadManual">上传</van-button>
            <van-button size="mini" plain icon="plus" :disabled="!canEditManual || manualSaving" @click="openManual()">新增</van-button>
          </div>
        </div>
        <div class="class-ref" role="status">{{ manualStatus }}。<template v-if="isLegacy">旧版云同步需在自选页单独明确开启，保存 Token 不代表同意上传。</template><template v-else-if="isPortfolio">手工资产与余额观察只写共同工作区；当前尚未接入云确认，不写旧存储或 Gist。</template><template v-else>资产来源尚未核定，不把独立旧存储的未知金额按 0 展示。</template></div>
        <div class="manual-row" v-for="a in manualAssets" :key="a.id">
          <span class="manual-name">{{ a.name }}<em>{{ a.cls }}</em></span>
          <span class="manual-value">{{ num(a.value, 2) }}</span>
          <button type="button" class="manual-icon-button" :disabled="!canEditManual || manualSaving" :aria-label="`编辑 ${a.name}`" @click="openManual(a)"><van-icon name="edit" color="#4C7E67" size="16" /></button>
          <button type="button" class="manual-icon-button" :disabled="!canEditManual || manualSaving" :aria-label="`移出 ${a.name}`" @click="delManual(a.id)"><van-icon name="cross" color="#A8B2A8" size="16" /></button>
        </div>
        <div class="class-ref" v-if="!manualAssets.length && canEditManual">可把现金、股票、黄金等非基金资产手工纳入总览；金额 0 是有效输入。</div>
        <div v-if="watch.hasPendingLocalWorkspaceEdit" class="coverage-warning" role="alert"><p>本机写入结果未知，原请求标识保留。请只手动核对原回执，不要重复保存或追加观察。</p><button type="button" data-action="reconcile-portfolio-local" @click="watch.reconcileLocalWorkspaceEdit().catch(() => showToast('原本机请求仍未核定；原标识保留，未重新发送'))">核对原本机写入</button></div>
      </section>
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <section v-else-if="localReadError || !localAuthorityReady" class="coverage-warning" role="alert"><p>本机持仓权威无法安全读取，资产总览已暂停；未知记录不会按 0 或空组合处理。请到自选页核对本机工作区，未回退旧存储。</p><p v-if="holdings.length">保留 {{ holdings.length }} 条先前已知账户持仓，未当作本次完整组合展示。</p><p v-if="snaps.length">已保留 {{ snaps.length }} 个历史快照；本次没有生成新的组合快照。</p></section>
      <van-empty v-else-if="emptyPortfolio"
        description="还没有持仓。去自选页给基金填上份额/成本/账户" />
      <template v-else>
        <!-- 总资产 -->
        <div class="hero card">
          <div class="hero-inner">
            <div class="k">{{ !manualStorageKnown ? '总资产（本地手工资产未知）' : total.value == null ? '总资产（数据未完整或金额超限）' : '总资产（估算市值）' }}</div>
            <div class="big">{{ num(total.value, 2) }}</div>
            <div class="priced-subtotal" v-if="total.value == null">
              已定价小计 {{ num(total.pricedValue, 2) }}，不代表组合总资产
            </div>
            <div class="hero-row">
              <div>
                <span class="kk">累计收益<span v-if="!costs.complete || portfolioCostUnknown">（成本未完整）</span></span>
                <span class="vv" :style="{ color: colorOf(total.profit) }">
                  {{ signedNum(total.profit) }}
                  <em :style="{ color: colorOf(total.rate) }">{{ pct(total.rate) }}</em>
                </span>
              </div>
              <div style="text-align:right">
                <span class="kk">今日估算<span v-if="!todayCoverage.complete">（{{ todayCoverage.covered }}/{{ todayCoverage.total }}）</span></span>
                <span class="vv" :style="{ color: colorOf(total.today) }">
                  {{ signedNum(total.today) }}
                </span>
                <span class="coverage-mini" v-if="!todayCoverage.complete">数据未完整</span>
              </div>
            </div>
          </div>
          <!-- 金脊远山 -->
          <svg class="hero-ridge" viewBox="0 0 400 28" preserveAspectRatio="none">
            <path d="M0 28 L0 14 Q60 6 120 14 Q180 22 240 8 Q300 -4 360 14 Q380 18 400 10 L400 28Z" fill="#C8A75B" opacity="0.08" />
            <path d="M0 16 Q60 8 120 16 Q180 24 240 10 Q300 -2 360 16 Q380 20 400 12" fill="none" stroke="#C8A75B" stroke-opacity="0.12" stroke-width="1.5" />
          </svg>
        </div>

        <div class="valuation-warning" role="alert" v-if="!portfolioReady">
          <span v-if="!holdingInput.complete">存在份额未知、输入无效或账户重复的持仓，不能把筛选后的记录当成完整组合。请在自选页核对本机输入。</span>
          <b v-if="!valuation.complete">净值覆盖 {{ valuation.pricedCount }}/{{ valuation.totalCount }} 笔持仓</b>
          <span v-if="!valuation.complete">未定价：{{ unpricedNames.join('、') }}。缺失净值不会当成 0。</span>
          <b v-if="!costs.complete">成本覆盖 {{ costs.knownCount }}/{{ costs.totalCount }} 笔持仓</b>
          <span v-if="!costs.complete">成本缺失：{{ missingCostNames.join('、') }}。缺失成本不会当成 0。</span>
          <span v-if="!manualStorageKnown">手工资产存储未知，不能把未读出的金额按 0 纳入完整组合。</span>
          <span v-if="isPortfolio && manualAssets.length">手工资产只提供当前余额，未提供成本；不把余额冒充成本或制造零收益。余额完整时仍可显式记录观察。</span>
          <span v-if="isPortfolio && portfolioCostUnknown && !manualAssets.length">零份持仓身份仍保留；缺失单位成本保持未知，不借其他账户补齐成本。余额完整时仍可显式记录观察。</span>
          <span v-if="total.pricedValue == null || total.knownCost == null">金额合计超出可安全计算范围，已隐藏精确组合结果。</span>
          <span>已暂停累计盈亏、快照、组合诊断和组合实验。</span>
        </div>

        <!-- V3-10 组合历史曲线 -->
        <div class="card">
          <div class="dim-head">
            <span class="sec-t">组合历史</span>
            <div class="snap-actions">
              <van-button size="mini" plain icon="down" :disabled="isPortfolio ? !portfolioHistory.length : !isLegacy || !snaps.length" @click="exportHistory">导出</van-button>
              <van-button size="mini" plain icon="photograph" :disabled="snapshotSaving || (isPortfolio ? !observationReady : !isLegacy || !portfolioReady)" :loading="snapshotSaving" @click="doSnap">{{ isPortfolio ? '记录余额观察' : '拍快照' }}</van-button>
            </div>
          </div>
          <template v-if="snapChart">
            <Chart :option="snapChart" height="220px" />
            <div v-if="!isPortfolio" class="snap-hint">共 {{ snaps.length }} 个快照 · {{ snaps[0].date.slice(0,10) }} ~ {{ snaps[snaps.length-1].date.slice(0,10) }}。{{ portfolioReady ? '每天打开资产页会自动记录一次，手动快照会覆盖当天数值。' : '本次因净值或成本未完整，未自动写入快照。' }}</div>
          </template>
          <van-empty v-else :description="isPortfolio ? '至少两条余额记录后显示曲线；打开页面不会自动新增或覆盖记录。' : portfolioReady ? '快照已开始记录，累计两天后显示组合曲线。' : '净值或成本未完整，本次不会写入自动快照。'" image-size="60" />
          <template v-if="isPortfolio">
            <p class="snap-hint">共 {{ portfolioHistory.length }} 条，曲线按原始追加顺序，清单倒序展示。新记录采用上海日期、保留精确观察时间；旧 UTC 日期与不透明持仓标识原样归档，不推断为新身份。旧成本保留原口径，可能是手工资产余额代理，不代表真实购入成本。余额变化不等于现金流调整收益，缺成本显示 --，不会补零或连接断点。</p>
            <div class="history-ledger" v-if="portfolioHistory.length" aria-label="余额观察与旧历史">
              <details v-for="row in historyRows" :key="row.id" @toggle="toggleHistory(row.id, $event)">
                <summary>{{ row.date }} · {{ row.kind === 'legacy' ? 'UTC 旧档' : '上海余额观察' }} · 余额 {{ num(row.value, 2) }} · 成本 {{ num(row.cost, 2) }}</summary>
                <template v-if="expandedHistory.has(row.id)">
                  <p>{{ row.observed_at ?? '旧档没有观察时刻，保持未知' }} · {{ row.id }}</p>
                  <ul><li v-for="(part, index) in row.holdings" :key="index">{{ part.name }} · {{ 'key' in part ? part.key : part.id }} · {{ 'kind' in part ? part.kind === 'manual' ? '手工资产' : '基金账户' : '旧不透明标识' }} · 余额 {{ num(part.value, 2) }} · 成本 {{ num(part.cost, 2) }}</li></ul>
                  <p v-if="row.holdings === null">旧档未提供持仓明细。</p>
                </template>
              </details>
              <div class="history-paging"><button type="button" :disabled="historyPage === 0" @click="historyPage--">上一页</button><span>{{ historyPage + 1 }} / {{ historyPageCount }}</span><button type="button" :disabled="historyPage + 1 >= historyPageCount" @click="historyPage++">下一页</button></div>
            </div>
          </template>
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
          <Chart v-if="valuation.complete && total.value != null" :option="pieOption" height="200px" />
          <div v-else class="coverage-placeholder">净值覆盖完整后才计算账户和类型权重。</div>
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

        <!-- V4-3 组合诊断 -->
        <div class="sec">组合诊断</div>
        <div class="card">
          <van-button plain icon="gem-o" size="small" :loading="diagLoading" :disabled="!portfolioReady" @click="runDiagnostics" block>
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
              <div class="corr-pair" v-for="p in rankedCorrPairs.slice(0, 10)" :key="p.a + p.b">
                <span class="cp-names">{{ p.aName }} ↔ {{ p.bName }}</span>
                <van-progress v-if="p.corr != null" :percentage="((p.corr + 1) / 2) * 100" :show-pivot="false"
                  :color="p.corr > 0.7 ? '#C44536' : p.corr > 0.4 ? '#C8963E' : '#4C7E67'"
                  track-color="var(--border)" style="flex:1;margin:0 8px" />
                <span v-if="p.corr != null" class="cp-val" :style="{
                  color: p.corr > 0.7 ? '#C44536' : p.corr > 0.4 ? '#C8963E' : '#4C7E67',
                }">{{ p.corr.toFixed(2) }}</span>
                <span v-else class="cp-unknown">无法计算（共同 {{ p.samples }} 个日收益）</span>
              </div>
            </div>
            <div class="corr-note" v-if="highCorrExists">
              ⚠ 部分持仓相关性 &gt; 0.8，组合分散化效果较弱
            </div>
            <div class="corr-note" v-else-if="unknownCorrCount === corrMatrix.pairs.length">所有组合均因共同净值日期不足或序列无波动而无法计算。</div>
            <div class="corr-note" v-else>已计算的基金相关性未超过 0.8<span v-if="unknownCorrCount">；另有 {{ unknownCorrCount }} 组为未知</span>。</div>
          </template>
        </div>

        <!-- 账户明细 -->
        <div class="sec">账户明细</div>
        <div class="acc card" v-for="g in byAccount" :key="g.key">
          <div class="acc-top">
            <span class="acc-name">{{ g.key }}</span>
            <span class="acc-share">{{ shareText(g.value) }}</span>
          </div>
          <div class="acc-grid">
            <div><div class="kk">市值</div><div class="vg">{{ num(g.value, 2) }}</div></div>
            <div><div class="kk">收益</div><div class="vg" :style="{ color: colorOf(g.profit) }">{{ signedNum(g.profit, 0) }}<em :style="{ color: colorOf(rateOf(g)) }">{{ pct(rateOf(g)) }}</em></div></div>
            <div><div class="kk">今日<span v-if="!g.todayComplete">（未完整）</span></div><div class="vg" :style="{ color: colorOf(g.today) }">{{ signedNum(g.today, 0) }}</div></div>
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
            <div v-if="!todayCoverage.complete" class="atr-note" role="status">
              今日涨跌仅覆盖 {{ todayCoverage.covered }}/{{ todayCoverage.total }}，贡献拆解已暂停，不以 0 补缺失值。
            </div>
            <template v-else-if="attrDim === 'account'">
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
            <div v-if="todayCoverage.complete" class="atr-note">bp = 基点（万分比），今日估算贡献</div>
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
        <div class="tip">同一只基金归属一个账户；在「自选」页编辑持仓时设置账户。净值、成本或今日涨跌缺失时显示为 --，不用 0 代替。</div>
      </template>
    </div>

    <van-dialog v-model:show="manualShow" title="手工资产" show-cancel-button :before-close="(action: string) => action === 'confirm' ? saveManual() : true">
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
.priced-subtotal { color: var(--text-muted); font-size: 11px; margin: -6px 0 8px; }
.hero-ridge { display: block; width: 100%; height: 28px; }
.hero-row { padding-bottom: 4px; }
.hero-row { display: flex; justify-content: space-between; align-items: flex-end; }
.kk { font-size: 11px; color: var(--text-muted); display: block; }
.vv { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.vv em { font-style: normal; font-size: 12px; margin-left: 4px; }
.coverage-mini { display: block; color: var(--text-hint); font-size: 9px; margin-top: 2px; }
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
.nav-disabled { cursor: not-allowed; opacity: 0.35; }
.valuation-warning { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--danger) 7%, var(--card-bg)); color: var(--text-secondary); font-size: 11px; line-height: 1.55; }
.valuation-warning b { color: var(--danger); font-size: 12px; }
.coverage-placeholder { padding: 28px 12px; color: var(--text-hint); font-size: 12px; line-height: 1.6; text-align: center; }
.coverage-warning { margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--danger); color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.manual-card .manual-head { margin-top: 0; }
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
.manual-icon-button { border: 0; background: transparent; padding: 6px; cursor: pointer; }
.manual-icon-button:disabled { opacity: .4; cursor: not-allowed; }
.manual-icon-button:focus-visible, .history-paging button:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.history-ledger { margin-top: 12px; font-size: 11px; line-height: 1.7; color: var(--text-secondary); overflow-wrap: anywhere; }
.history-ledger details { border-top: 1px solid var(--border); padding: 8px 0; }
.history-ledger summary { cursor: pointer; color: var(--text); }
.history-ledger p { margin: 6px 0; }
.history-ledger ul { padding-left: 18px; }
.history-paging { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.history-paging button { border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; background: var(--card-bg); color: var(--text); }
.history-paging button:disabled { opacity: .4; }
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
.cp-unknown { flex: 1; color: var(--text-hint); font-size: 10px; text-align: right; }
.corr-note { font-size: 11px; color: #C8963E; margin-top: 4px; }
</style>
