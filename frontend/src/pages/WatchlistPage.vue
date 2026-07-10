<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { getFunds, postPortfolioDecisions, type DecisionResp, type FundListItem } from '@/api/client'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { fetchEstimates, type Estimate } from '@/utils/estimate'
import { colorOf, pct } from '@/utils/format'
import { getToken } from '@/utils/gist'
import Icon from '@/components/Icon.vue'

interface Row { name: string; type: string | null }

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()
const rows = reactive<Record<string, Row>>({})
const estimates = reactive<Record<string, Estimate | null>>({})
const decisions = reactive<Record<string, DecisionResp>>({})
const loading = ref(true)
const refreshing = ref(false)
const decisionsLoading = ref(false)

const showSync = ref(false)
const token = ref(getToken())
const importShow = ref(false)
const importQuery = ref('')
const importResults = ref<FundListItem[]>([])
const importLoading = ref(false)
let importTimer: ReturnType<typeof setTimeout> | null = null

const decisionSummary = computed(() => {
  const groups: Record<string, string[]> = {}
  for (const item of watch.items) {
    const decision = decisions[item.code]
    if (!decision) continue
    if (!groups[decision.action]) groups[decision.action] = []
    groups[decision.action].push(rows[item.code]?.name || item.name || item.code)
  }
  return groups
})

async function loadDecisions() {
  Object.keys(decisions).forEach((key) => delete decisions[key])
  if (!watch.items.length) return
  decisionsLoading.value = true
  try {
    const response = await postPortfolioDecisions(watch.items.map((item) => ({ code: item.code })))
    response.decisions.forEach((decision) => { decisions[decision.code] = decision })
  } catch { /* 后端不可用时保留估值 */ }
  finally { decisionsLoading.value = false }
}

async function loadOne(code: string, fallbackName: string | null) {
  rows[code] = { name: fallbackName || code, type: null }
  try {
    const detail = await funds.detail(code)
    rows[code] = { name: detail.name || fallbackName || code, type: detail.type }
  } catch { /* 保留名称 */ }
}

async function refresh() {
  loading.value = true
  await watch.load(true)
  const estimateMap = await fetchEstimates(watch.items.map((item) => item.code))
  estimateMap.forEach((value, code) => { estimates[code] = value })
  await Promise.all(watch.items.map((item) => loadOne(item.code, item.name)))
  await loadDecisions()
  loading.value = false
  refreshing.value = false
}

function estimateText(code: string) {
  const value = estimates[code]?.estChange
  return value == null ? '—' : pct(value)
}

function estimateMeta(code: string) {
  const estimate = estimates[code]
  if (!estimate) return '暂无估值'
  const time = estimate.estTime ? estimate.estTime.slice(5) : ''
  return `${estimate.label}${time ? ' · ' + time : ''}`
}

async function remove(code: string) {
  await watch.remove(code)
  delete rows[code]
  delete estimates[code]
  delete decisions[code]
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
  await loadOne(code, name)
  estimates[code] = (await fetchEstimates([code])).get(code) || null
  await loadDecisions()
  importResults.value = importResults.value.filter((fund) => fund.code !== code)
  showToast('已添加')
}

async function saveToken() { watch.setToken(token.value); showToast(token.value ? '已保存 Token' : '已清空') }
async function upload() { await watch.manualUpload(); showToast(watch.lastSync ? '已上传' : '上传失败') }
async function download() { await watch.manualDownload(); await refresh(); showToast('已同步') }

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
        <div class="sec">今日决策摘要</div>
        <section class="card decision-card">
          <div v-if="decisionsLoading" class="decision-loading"><van-loading size="15" /> 计算中</div>
          <template v-else-if="Object.keys(decisionSummary).length">
            <div v-for="(names, action) in decisionSummary" :key="action" class="decision-row">
              <b>{{ action }}</b><span>{{ names.join('、') }}</span>
            </div>
          </template>
          <div v-else class="empty-line">暂无决策结果</div>
        </section>

        <div class="sec">盘中估值</div>
        <div v-if="loading" class="estimate-list skeleton-list"><van-skeleton title :row="6" /></div>
        <van-empty v-else-if="!watch.items.length" description="还没有自选基金" />
        <section v-else class="estimate-list">
          <van-swipe-cell v-for="item in watch.items" :key="item.code">
            <article class="estimate-row" @click="router.push('/fund/' + item.code)">
              <div class="fund-name"><b>{{ rows[item.code]?.name || item.name || item.code }}</b><span>{{ item.code }} · {{ rows[item.code]?.type || '基金' }}</span></div>
              <div class="estimate-value">
                <strong :style="{ color: colorOf(estimates[item.code]?.estChange) }">{{ estimateText(item.code) }}</strong>
                <span>{{ estimateMeta(item.code) }}</span>
                <em v-if="estimates[item.code]?.kind === 'overseas_model'">覆盖 {{ estimates[item.code]?.modelWeight?.toFixed(0) }}%</em>
              </div>
            </article>
            <template #right><van-button square type="danger" text="移除" class="remove-button" @click="remove(item.code)" /></template>
          </van-swipe-cell>
        </section>
      </div>
    </van-pull-refresh>

    <van-popup v-model:show="showSync" position="bottom" round :style="{ padding: '18px', paddingBottom: '30px' }">
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
.nav-tool { width: 34px; height: 34px; display: inline-grid; place-items: center; padding: 0; border: 0; color: var(--teal); background: transparent; cursor: pointer; }
.decision-card { min-height: 76px; padding: 10px 14px; }
.decision-row { display: grid; grid-template-columns: 76px 1fr; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 12px; }.decision-row:last-child { border-bottom: 0; }.decision-row b { color: var(--teal-deep); }.decision-row span { color: var(--text-secondary); line-height: 1.5; }
.decision-loading, .empty-line { min-height: 54px; display: flex; align-items: center; justify-content: center; gap: 7px; color: var(--text-hint); font-size: 11px; }
.estimate-list { overflow: hidden; background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.estimate-row { min-height: 76px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 13px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }.van-swipe-cell:last-child .estimate-row { border-bottom: 0; }
.fund-name { min-width: 0; }.fund-name b, .fund-name span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.fund-name b { color: var(--ink); font-size: 14px; font-weight: 600; }.fund-name span { color: var(--text-hint); font-family: var(--font-mono); font-size: 10px; margin-top: 6px; }
.estimate-value { min-width: 104px; text-align: right; }.estimate-value strong, .estimate-value span, .estimate-value em { display: block; }.estimate-value strong { font-family: var(--font-mono); font-size: 19px; font-weight: 500; }.estimate-value span, .estimate-value em { color: var(--text-hint); font-size: 9px; font-style: normal; margin-top: 3px; }
.remove-button { height: 100%; }.skeleton-list { padding: 15px; }
.popup-title { color: var(--ink); font-family: var(--font-display); font-size: 17px; font-weight: 700; margin-bottom: 12px; }.sync-status { color: var(--text-hint); font-size: 10px; margin: 12px 2px; }.sync-actions { display: flex; gap: 8px; }.sync-actions .van-button { flex: 1; }.import-results { max-height: 42vh; overflow-y: auto; margin-top: 8px; }.import-loading { display: block; text-align: center; padding: 18px; }
</style>
