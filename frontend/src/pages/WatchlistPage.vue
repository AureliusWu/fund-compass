<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import {
  ApiError,
  getFunds,
  getV8Decision,
  getV8DecisionDiff,
  type FundListItem,
  type V8DecisionDiff,
  type V8DecisionResult,
} from '@/api/client'
import { useWatchlistStore } from '@/stores/watchlist'
import { fetchEstimates, loadCachedEstimates, type Estimate } from '@/utils/estimate'
import { colorOf, pct } from '@/utils/format'
import { getToken } from '@/utils/gist'
import Icon from '@/components/Icon.vue'
import WatchlistDecisionBoard from '@/components/watchlist/WatchlistDecisionBoard.vue'
import {
  filterAndSortWatchDecisions,
  watchEstimateCaption,
  watchEstimateSemanticLabel,
  type WatchDecisionFilter,
  type WatchDecisionLoadState,
  type WatchDecisionSort,
  type WatchDecisionSource,
} from '@/components/watchlist/decisionView'
import { estimateChangeForDisplay, estimateFreshness, estimateTrustText, WATCH_SECTIONS } from '@/utils/presentation'

interface Row { name: string; type: string | null }

const router = useRouter()
const watch = useWatchlistStore()
const rows = reactive<Record<string, Row>>({})
const estimates = reactive<Record<string, Estimate | null>>({})
const decisions = reactive<Record<string, V8DecisionResult>>({})
const decisionDiffs = reactive<Record<string, V8DecisionDiff>>({})
const decisionLoadStates = reactive<Record<string, WatchDecisionLoadState>>({})
const decisionDiffLoadStates = reactive<Record<string, WatchDecisionLoadState>>({})
const loading = ref(watch.items.length === 0 && watch.hasToken)
const refreshing = ref(false)
const decisionsLoading = ref(false)
const estimatesLoading = ref(false)
const decisionFilter = ref<WatchDecisionFilter>('all')
const decisionSort = ref<WatchDecisionSort>('action')
const decisionEpochs: Record<string, number> = {}
let decisionBatches = 0

const showSync = ref(false)
const token = ref(getToken())
const importShow = ref(false)
const importQuery = ref('')
const importResults = ref<FundListItem[]>([])
const importLoading = ref(false)
let importTimer: ReturnType<typeof setTimeout> | null = null

const decisionSources = computed<WatchDecisionSource[]>(() => {
  return watch.items.map((item) => {
    const estimate = estimates[item.code]
    const typeOrName = rows[item.code]?.type || rows[item.code]?.name || item.name
    return {
      code: item.code,
      name: rows[item.code]?.name || item.name || item.code,
      type: rows[item.code]?.type || null,
      result: decisions[item.code] || null,
      diff: decisionDiffs[item.code] || null,
      load: decisionLoadStates[item.code] || { kind: decisionsLoading.value ? 'loading' : 'idle' },
      diffLoad: decisionDiffLoadStates[item.code] || { kind: decisionsLoading.value ? 'loading' : 'idle' },
      change: displayChange(item.code),
      changeCaption: watchEstimateCaption(typeOrName, estimate),
    }
  })
})

const decisionRows = computed(() => filterAndSortWatchDecisions(
  decisionSources.value,
  decisionFilter.value,
  decisionSort.value,
))

function failedLoadState(error: unknown, kind: 'decision' | 'diff'): WatchDecisionLoadState {
  if (error instanceof ApiError && error.status === 404) {
    return {
      kind: 'missing',
      message: kind === 'decision' ? '尚未生成 V8 决策快照' : '尚无历史变化快照',
    }
  }
  return {
    kind: 'error',
    message: kind === 'decision' ? 'V8 决策请求失败' : '历史变化请求失败',
  }
}

async function loadDecisions(items = watch.items) {
  // items may be a one-fund incremental refresh; pruning must always follow the
  // complete current watchlist or a new item would erase valid snapshots for all others.
  const activeCodes = new Set(watch.items.map((item) => item.code))
  Object.keys(decisions).forEach((key) => { if (!activeCodes.has(key)) delete decisions[key] })
  Object.keys(decisionDiffs).forEach((key) => { if (!activeCodes.has(key)) delete decisionDiffs[key] })
  Object.keys(decisionLoadStates).forEach((key) => { if (!activeCodes.has(key)) delete decisionLoadStates[key] })
  Object.keys(decisionDiffLoadStates).forEach((key) => { if (!activeCodes.has(key)) delete decisionDiffLoadStates[key] })
  if (!items.length) { decisionsLoading.value = false; return }
  decisionBatches++
  decisionsLoading.value = true
  try {
    await Promise.allSettled(items.map(async (item) => {
      const epoch = (decisionEpochs[item.code] || 0) + 1
      decisionEpochs[item.code] = epoch
      delete decisions[item.code]
      delete decisionDiffs[item.code]
      decisionLoadStates[item.code] = { kind: 'loading', message: '正在载入 V8 决策快照' }
      decisionDiffLoadStates[item.code] = { kind: 'loading', message: '正在核对快照变化' }
      const decisionTask = getV8Decision(item.code).then((decision) => {
        if (decisionEpochs[item.code] !== epoch || !watch.has(item.code)) return
        if (decision.code !== item.code || decision.decision?.fund_code !== item.code) {
          decisionLoadStates[item.code] = { kind: 'error', message: 'V8 快照代码与自选基金不一致' }
        } else {
          decisions[decision.code] = decision
          decisionLoadStates[item.code] = { kind: 'ready' }
          rows[decision.code] = { name: decision.name || decision.code, type: decision.type ?? null }
        }
      }).catch((error) => {
        if (decisionEpochs[item.code] !== epoch || !watch.has(item.code)) return
        decisionLoadStates[item.code] = failedLoadState(error, 'decision')
      })
      const diffTask = getV8DecisionDiff(item.code).then((diff) => {
        if (decisionEpochs[item.code] !== epoch || !watch.has(item.code)) return
        decisionDiffs[item.code] = diff
        decisionDiffLoadStates[item.code] = { kind: 'ready' }
      }).catch((error) => {
        if (decisionEpochs[item.code] !== epoch || !watch.has(item.code)) return
        decisionDiffLoadStates[item.code] = failedLoadState(error, 'diff')
      })
      await Promise.allSettled([decisionTask, diffTask])
    }))
  } catch { /* 后端不可用时保留估值 */ }
  finally {
    decisionBatches = Math.max(0, decisionBatches - 1)
    decisionsLoading.value = decisionBatches > 0
  }
}

function loadOne(code: string, fallbackName: string | null) {
  const current = rows[code]
  rows[code] = {
    name: current?.name || fallbackName || code,
    type: current?.type ?? null,
  }
}

function hydrateLocal(items = watch.items) {
  items.forEach((item) => loadOne(item.code, item.name))
  loadCachedEstimates(items.map((item) => item.code)).forEach((value, code) => {
    if (estimates[code] == null) estimates[code] = value
  })
}

async function loadEstimates(items = watch.items) {
  const codes = items.map((item) => item.code)
  if (!codes.length) return
  estimatesLoading.value = true
  try {
    const estimateMap = await fetchEstimates(codes)
    estimateMap.forEach((value, code) => {
      if (watch.has(code) && value) estimates[code] = value
    })
  } finally { estimatesLoading.value = false }
}

async function refreshItems(items = watch.items) {
  await Promise.allSettled([loadEstimates(items), loadDecisions(items)])
}

function itemKey(items = watch.items) {
  return items.map((item) => item.code).sort().join(',')
}

async function refresh() {
  const localItems = [...watch.items]
  const localKey = itemKey(localItems)
  hydrateLocal(localItems)
  if (localItems.length || !watch.hasToken) loading.value = false
  try {
    // 与蜉蝣基金相同：本地数据先展示，云同步和行情/决策在后台并行更新。
    await Promise.allSettled([refreshItems(localItems), watch.load(true)])
    const syncedItems = [...watch.items]
    hydrateLocal(syncedItems)
    loading.value = false
    if (itemKey(syncedItems) !== localKey) await refreshItems(syncedItems)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function estimateText(code: string) {
  const value = displayChange(code)
  return value == null ? '—' : pct(value)
}

function displayChange(code: string) {
  return estimateChangeForDisplay(estimates[code])
}

function estimateMeta(code: string) {
  const estimate = estimates[code]
  if (!estimate) return estimatesLoading.value ? '估值更新中' : '暂无估值'
  if (estimate.status === 'unavailable') return '数据不可用'
  if (estimateFreshness(estimate) === 'expired') return '数据过期'
  const sourceTime = estimate.kind === 'official_nav'
    ? estimate.valueDate || estimate.estTime || estimate.navDate
    : estimate.estTime
  const time = sourceTime ? sourceTime.slice(5) : ''
  const label = estimate.cached ? '缓存估值' : estimate.label
  const semanticLabel = watchEstimateSemanticLabel(rows[code]?.type || rows[code]?.name, estimate)
  const cachePrefix = estimate.cached ? `${label} · ` : ''
  return `${cachePrefix}${semanticLabel}${time ? ' · ' + time : ''}`
}

async function remove(code: string) {
  await watch.remove(code)
  delete rows[code]
  delete estimates[code]
  delete decisions[code]
  delete decisionDiffs[code]
  delete decisionLoadStates[code]
  delete decisionDiffLoadStates[code]
  decisionEpochs[code] = (decisionEpochs[code] || 0) + 1
  showToast('已移除')
}

function onImportInput() {
  if (importTimer) clearTimeout(importTimer)
  const query = importQuery.value.trim()
  if (!query) { importResults.value = []; return }
  importTimer = setTimeout(async () => {
    importLoading.value = true
    try {
      const response = await getFunds({ q: query, page_size: 20 })
      importResults.value = response.items.filter((fund) => !watch.has(fund.code))
    } catch { importResults.value = [] }
    finally { importLoading.value = false }
  }, 300)
}

async function doImport(code: string, name: string) {
  watch.add(code, name)
  loadOne(code, name)
  estimates[code] = (await fetchEstimates([code])).get(code) || null
  await loadDecisions(watch.items.filter((item) => item.code === code))
  importResults.value = importResults.value.filter((fund) => fund.code !== code)
  showToast('已添加')
}

async function saveToken() { watch.setToken(token.value); showToast(token.value ? '已保存 Token' : '已清空') }
async function upload() {
  const success = await watch.manualUpload()
  showToast(success ? '已上传' : '上传失败，请先下载合并后重试')
}
async function download() {
  const success = await watch.manualDownload()
  if (success) await refresh()
  showToast(success ? '已同步' : '同步失败')
}

hydrateLocal()
onMounted(refresh)
</script>

<template>
  <div class="page watch-page">
    <van-nav-bar title="自选">
      <template #right>
        <button class="nav-tool" aria-label="添加基金" @click="importShow = true"><Icon name="plus" :size="18" /></button>
        <button class="nav-tool" aria-label="同步自选" @click="showSync = true"><Icon name="refresh" :size="18" /></button>
      </template>
    </van-nav-bar>

    <van-pull-refresh v-model="refreshing" @refresh="refresh">
      <div class="page-body">
        <div class="sec">{{ WATCH_SECTIONS[0] }}</div>
        <WatchlistDecisionBoard
          v-model:filter="decisionFilter"
          v-model:sort="decisionSort"
          :rows="decisionRows"
          :total="watch.items.length"
          :loading="decisionsLoading"
          @open="router.push('/fund/' + $event)"
        />

        <div class="sec estimate-sec">
          <span>{{ WATCH_SECTIONS[1] }}</span>
          <small>QDII 的最新正式净值与下一净值估算分开标注</small>
        </div>
        <div v-if="loading" class="estimate-list skeleton-list"><van-skeleton title :row="6" /></div>
        <van-empty v-else-if="!watch.items.length" description="还没有自选基金" />
        <section v-else class="estimate-list">
          <van-swipe-cell v-for="item in watch.items" :key="item.code">
            <article class="estimate-row" @click="router.push('/fund/' + item.code)">
              <div class="fund-name"><b>{{ rows[item.code]?.name || item.name || item.code }}</b><span>{{ item.code }} · {{ rows[item.code]?.type || '基金' }}</span></div>
              <div class="estimate-value">
                <strong :style="{ color: colorOf(displayChange(item.code)) }">{{ estimateText(item.code) }}</strong>
                <span>{{ estimateMeta(item.code) }}</span>
                <em v-if="['holdings_model', 'overseas_model'].includes(estimates[item.code]?.kind || '')" class="trust-line">{{ estimateTrustText(estimates[item.code]) }}</em>
              </div>
            </article>
            <template #right><van-button square type="danger" text="移除" class="remove-button" @click="remove(item.code)" /></template>
          </van-swipe-cell>
        </section>
      </div>
    </van-pull-refresh>

    <van-popup
      v-model:show="showSync"
      class="sync-popup"
      position="bottom"
      round
      :z-index="3000"
      :safe-area-inset-bottom="true"
      :style="{ padding: '18px', paddingBottom: 'calc(78px + env(safe-area-inset-bottom))', maxHeight: '80vh', overflowY: 'auto' }"
    >
      <div class="popup-title">同步自选</div>
      <van-field v-model="token" type="password" label="Token" placeholder="GitHub Gist Token" />
      <div class="sync-status">{{ watch.syncing ? '同步中' : watch.lastSync ? '上次同步 ' + new Date(watch.lastSync).toLocaleString() : '尚未同步' }}</div>
      <div class="sync-actions">
        <van-button size="small" @click="saveToken">保存</van-button>
        <van-button size="small" type="primary" @click="upload">上传</van-button>
        <van-button size="small" type="primary" plain @click="download">下载</van-button>
      </div>
    </van-popup>

    <van-popup v-model:show="importShow" position="bottom" round :safe-area-inset-bottom="true" :style="{ padding: '18px', paddingBottom: '66px', maxHeight: '70vh' }">
      <div class="popup-title">添加基金</div>
      <van-field v-model="importQuery" placeholder="输入代码或名称" clearable @update:model-value="onImportInput">
        <template #left-icon><Icon name="mirror" :size="16" color="var(--teal)" /></template>
      </van-field>
      <div class="import-results">
        <van-loading v-if="importLoading" class="import-loading" />
        <van-empty v-else-if="importQuery && !importResults.length" description="没有可添加的基金" image-size="56" />
        <van-cell v-for="fund in importResults" :key="fund.code" :title="fund.name" :label="fund.code + ' · ' + (fund.type || '')" is-link @click="doImport(fund.code, fund.name)" />
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.watch-page { --watch-estimate-column: clamp(140px, 34vw, 240px); }
.nav-tool { width: 34px; height: 34px; display: inline-grid; place-items: center; padding: 0; border: 0; color: var(--teal); background: transparent; cursor: pointer; }
.estimate-sec { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }.estimate-sec small { color: var(--text-hint); font-size: 9px; font-weight: 400; letter-spacing: 0; text-align: right; }
.estimate-list { overflow: hidden; background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.estimate-row { min-height: 76px; display: grid; grid-template-columns: minmax(0, 1fr) var(--watch-estimate-column); align-items: center; gap: 14px; padding: 13px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }.van-swipe-cell:last-child .estimate-row { border-bottom: 0; }
.fund-name { min-width: 0; }.fund-name b, .fund-name span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.fund-name b { color: var(--ink); font-size: 14px; font-weight: 600; }.fund-name span { color: var(--text-hint); font-family: var(--font-mono); font-size: 10px; margin-top: 6px; }
.estimate-value { width: 100%; min-width: 0; text-align: right; }.estimate-value strong, .estimate-value span, .estimate-value em { display: block; }.estimate-value strong { font-family: var(--font-mono); font-size: 19px; font-weight: 500; }.estimate-value span, .estimate-value em { color: var(--text-hint); font-size: 9px; font-style: normal; margin-top: 3px; }.trust-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remove-button { height: 100%; }.skeleton-list { padding: 15px; }
.popup-title { color: var(--ink); font-family: var(--font-display); font-size: 17px; font-weight: 700; margin-bottom: 12px; }.sync-status { color: var(--text-hint); font-size: 10px; margin: 12px 2px; }.sync-actions { display: flex; gap: 8px; }.sync-actions .van-button { flex: 1; }.import-results { max-height: 42vh; overflow-y: auto; margin-top: 8px; }.import-loading { display: block; text-align: center; padding: 18px; }
@media (max-width: 480px) { .watch-page { --watch-estimate-column: 132px; } }
</style>
