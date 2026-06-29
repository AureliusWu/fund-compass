<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { getToken } from '@/utils/gist'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { getFunds, type FundListItem } from '@/api/client'
import { pct, num, colorOf, signalColor } from '@/utils/format'
import { fetchEstimates, type Estimate } from '@/utils/estimate'
import StarRating from '@/components/StarRating.vue'
import Chart from '@/components/Chart.vue'
import { exportWatchlistCSV } from '@/utils/export'
import Icon from '@/components/Icon.vue'

interface Row {
  name: string; type: string | null; nav: number | null; ret1y: number | null
  signal: string; star: number | null
}

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()
const rows = reactive<Record<string, Row>>({})
const est = reactive<Record<string, Estimate | null>>({})
const loading = ref(true)

const showSync = ref(false)
const token = ref(getToken())

// 持仓编辑
const editShow = ref(false)
const editCode = ref('')
const editShares = ref('')
const editCost = ref('')
const editAccount = ref('')
const ACCOUNT_PRESETS = ['支付宝', '天天基金', '微信理财通', '蛋卷', '券商', '银行']
const accountChips = computed(() => {
  const s = new Set<string>([...watch.accounts, ...ACCOUNT_PRESETS])
  return [...s]
})

async function loadOne(code: string, name: string | null) {
  rows[code] = { name: name || code, type: null, nav: null, ret1y: null, signal: '', star: null }
  try {
    const [d, s, sig] = await Promise.all([funds.detail(code), funds.score(code), funds.signal(code)])
    rows[code] = { name: d.name || code, type: d.type, nav: d.latest_nav, ret1y: d.ret_1y, star: s.star, signal: sig.signal }
  } catch { /* 占位 */ }
}

async function refresh() {
  loading.value = true
  await watch.load(true)
  // 盘中估值并发抓取（纯前端，不阻塞列表渲染）
  fetchEstimates(watch.items.map((i) => i.code)).then((m) => m.forEach((v, k) => { est[k] = v }))
  await Promise.all(watch.items.map((i) => loadOne(i.code, i.name)))
  loading.value = false
}

// 今日估算盈亏：Σ 份额 × 昨净值 × 估算涨跌%（仅有盘中估值的持仓计入）
const todayEst = computed(() => {
  let amt = 0, has = false
  for (const e of watch.entries) {
    if (e.deleted || !(e.shares && e.shares > 0)) continue
    const es = est[e.code]
    if (!es || es.estChange == null || es.lastNav == null) continue
    amt += e.shares * es.lastNav * es.estChange / 100
    has = true
  }
  return has ? amt : null
})

// 组合（仅 shares>0 的持仓）
const portfolio = computed(() => {
  let value = 0, cost = 0
  const byType: Record<string, number> = {}
  let count = 0
  for (const e of watch.entries) {
    if (e.deleted || !(e.shares && e.shares > 0)) continue
    const nav = rows[e.code]?.nav
    if (nav == null) continue
    const v = e.shares * nav
    value += v
    cost += e.shares * (e.cost ?? 0)
    const t = rows[e.code]?.type || '其他'
    byType[t] = (byType[t] || 0) + v
    count++
  }
  const profit = value - cost
  return { value, cost, profit, rate: cost > 0 ? (profit / cost) * 100 : null, byType, count }
})

const allocOption = computed(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {d}%' },
  legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
  series: [{
    type: 'pie', radius: ['42%', '64%'], center: ['50%', '42%'], label: { show: false },
    data: Object.entries(portfolio.value.byType).map(([name, v]) => ({ name, value: +v.toFixed(2) })),
  }],
}))

function sharesOf(code: string) {
  const e = watch.entries.find((x) => x.code === code)
  return e?.shares && e.shares > 0 ? e : null
}

function openEdit(code: string) {
  const e = watch.entries.find((x) => x.code === code)
  editCode.value = code
  editShares.value = e?.shares ? String(e.shares) : ''
  editCost.value = e?.cost ? String(e.cost) : ''
  editAccount.value = e?.account || ''
  editShow.value = true
}
function saveHolding() {
  watch.setHolding(
    editCode.value, Number(editShares.value) || 0, Number(editCost.value) || 0,
    rows[editCode.value]?.name, editAccount.value.trim() || undefined,
  )
  showToast('已保存持仓')
}
function accountOf(code: string) {
  return watch.entries.find((x) => x.code === code)?.account || ''
}

async function remove(code: string) {
  await watch.remove(code)
  delete rows[code]
  showToast('已移除')
}

async function saveToken() { watch.setToken(token.value); showToast(token.value ? '已保存 Token' : '已清空') }
async function upload() {
  if (!watch.hasToken) { showToast('请先填 Token'); return }
  await watch.manualUpload()
  showToast(watch.lastSync ? '已上传' : '上传失败，检查 Token')
}
async function download() {
  if (!watch.hasToken) { showToast('请先填 Token'); return }
  await watch.manualDownload(); await refresh(); showToast('已同步')
}
function clearCloud() { watch.clearCloud(); token.value = ''; showToast('已清除云同步') }

// V5-0 导入：模糊搜索代码/名称添加到自选
const importShow = ref(false)
const importQuery = ref('')
const importResults = ref<FundListItem[]>([])
const importLoading = ref(false)
let importTimer: ReturnType<typeof setTimeout> | null = null

function onImportInput() {
  if (importTimer) clearTimeout(importTimer)
  const q = importQuery.value.trim()
  if (q.length < 1) { importResults.value = []; return }
  importTimer = setTimeout(async () => {
    importLoading.value = true
    try {
      const resp = await getFunds({ q, page_size: 20 })
      importResults.value = (resp.items || []).filter((f) => !watch.has(f.code))
    } catch { importResults.value = [] }
    finally { importLoading.value = false }
  }, 350)
}

async function doImport(code: string, name: string) {
  watch.add(code, name)
  await loadOne(code, name)
  // 从结果中移除已添加
  importResults.value = importResults.value.filter((f) => f.code !== code)
  showToast('已添加')
}

onMounted(refresh)
</script>

<template>
  <div class="page">
    <van-nav-bar title="自选 · 持仓">
      <template #right>
        <span style="margin-right:12px;cursor:pointer;color:var(--teal)" @click="importShow = true">
          <Icon name="plus" :size="18" />
        </span>
        <span style="margin-right:12px;cursor:pointer;color:var(--text-muted)" @click="exportWatchlistCSV(watch.items)">
          <Icon name="export" :size="17" />
        </span>
        <span style="cursor:pointer;color:var(--text-muted)" @click="showSync = true">
          <Icon name="refresh" :size="18" />
        </span>
      </template>
    </van-nav-bar>
    <div class="page-body">
      <!-- 组合概览 -->
      <template v-if="portfolio.count > 0">
        <div class="port card">
          <div class="port-top">
            <div>
              <div class="k">持仓市值</div>
              <div class="big">{{ num(portfolio.value, 2) }}</div>
            </div>
            <div style="text-align:right">
              <div class="k">累计收益</div>
              <div class="big" :style="{ color: colorOf(portfolio.profit) }">{{ num(portfolio.profit, 2) }}</div>
              <div class="r" :style="{ color: colorOf(portfolio.rate) }">{{ pct(portfolio.rate) }}</div>
            </div>
          </div>
          <div class="port-today" v-if="todayEst != null">
            今日估算 <b :style="{ color: colorOf(todayEst) }">{{ (todayEst >= 0 ? '+' : '') + num(todayEst, 2) }}</b>
            <span class="port-today-cap">盘中估值 · 收盘前为估算值</span>
          </div>
          <Chart :option="allocOption" height="180px" />
          <div class="port-cap">{{ portfolio.count }} 只持仓 · 按类型配置</div>
        </div>
      </template>

      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="watch.items.length === 0" description="还没有自选，去选基页添加" />
      <van-cell-group v-else inset>
        <van-cell
          v-for="it in watch.items" :key="it.code"
          :title="rows[it.code]?.name || it.name || it.code"
          :label="it.code + (sharesOf(it.code) ? ' · ' + sharesOf(it.code)!.shares + '份' : '') + (accountOf(it.code) ? ' · ' + accountOf(it.code) : '')"
          @click="router.push('/fund/' + it.code)"
        >
          <template #value>
            <div class="wl-val">
              <span v-if="est[it.code]?.estChange != null" class="est-chg" :style="{ color: colorOf(est[it.code]!.estChange) }">估 {{ pct(est[it.code]!.estChange) }}</span>
              <span class="sig" :style="{ color: signalColor(rows[it.code]?.signal || '') }">{{ rows[it.code]?.signal || '…' }}</span>
              <StarRating :star="rows[it.code]?.star ?? null" />
              <span v-if="sharesOf(it.code) && rows[it.code]?.nav != null" class="nav">
                市值 {{ num(sharesOf(it.code)!.shares! * rows[it.code]!.nav!, 2) }}
              </span>
              <span v-else class="nav">{{ num(rows[it.code]?.nav) }} <em :style="{ color: colorOf(rows[it.code]?.ret1y) }">{{ pct(rows[it.code]?.ret1y) }}</em></span>
            </div>
          </template>
          <template #right-icon>
            <van-icon name="edit" color="#4C7E67" size="17" style="margin-left:10px" @click.stop="openEdit(it.code)" />
            <van-icon name="cross" color="#A8B2A8" size="17" style="margin-left:8px" @click.stop="remove(it.code)" />
          </template>
        </van-cell>
      </van-cell-group>
    </div>

    <!-- 持仓编辑 -->
    <van-dialog v-model:show="editShow" title="编辑持仓" show-cancel-button @confirm="saveHolding">
      <div style="padding:8px 4px">
        <van-field v-model="editShares" type="number" label="份额" placeholder="0（0=仅关注）" />
        <van-field v-model="editCost" type="number" label="成本净值" placeholder="0.000" />
        <van-field v-model="editAccount" label="账户" placeholder="如 支付宝（可留空）" />
        <div class="acc-chips">
          <span v-for="a in accountChips" :key="a"
            :class="['chip', { on: editAccount === a }]"
            @click="editAccount = editAccount === a ? '' : a">{{ a }}</span>
        </div>
      </div>
    </van-dialog>

    <!-- 云同步 -->
    <van-popup v-model:show="showSync" position="bottom" round :style="{ padding: '16px' }">
      <div class="sync-title">云同步（GitHub Gist）</div>
      <div class="sync-sub">自选/持仓存在本机，配 Token 后可备份到私有 Gist、多设备同步。需 <code>gist</code> 权限，<a href="https://github.com/settings/tokens" target="_blank" rel="noopener">创建 Token</a>。</div>
      <van-field v-model="token" type="password" label="Token" placeholder="ghp_xxx" />
      <div class="sync-status">{{ watch.syncing ? '同步中…' : watch.lastSync ? '上次同步：' + new Date(watch.lastSync).toLocaleString() : '未同步' }}</div>
      <div class="sync-btns">
        <van-button size="small" @click="saveToken">保存 Token</van-button>
        <van-button size="small" type="primary" @click="upload">上传</van-button>
        <van-button size="small" type="primary" plain @click="download">下载</van-button>
      </div>
      <van-button size="small" block plain @click="clearCloud" style="margin-top:8px;color:var(--danger)">清除云同步配置</van-button>
    </van-popup>

    <!-- V5-0 导入基金 -->
    <van-popup v-model:show="importShow" position="bottom" round :safe-area-inset-bottom="true" :style="{ padding: '16px', paddingBottom: '66px', maxHeight: '70vh' }">
      <div class="sync-title">导入基金</div>
      <div class="sync-sub">输入代码或名称模糊搜索，点击添加到自选。</div>
      <van-field v-model="importQuery" placeholder="例如：沪深300 或 000300" @update:model-value="onImportInput" clearable>
        <template #left-icon>
          <Icon name="mirror" :size="16" color="var(--teal)" />
        </template>
      </van-field>
      <div style="max-height:40vh;overflow-y:auto;margin-top:8px">
        <van-loading v-if="importLoading" style="text-align:center;padding:12px" />
        <div v-else-if="importQuery && importResults.length === 0" style="text-align:center;padding:20px;color:var(--text-hint);font-size:13px">
          {{ importQuery.length < 2 ? '输入至少 2 个字符' : '无匹配结果（或已在自选中）' }}
        </div>
        <van-cell v-for="f in importResults" :key="f.code"
          :title="f.name" :label="f.code + ' · ' + (f.type || '')"
          is-link @click="doImport(f.code, f.name)">
          <template #icon>
            <Icon name="plus" :size="16" color="var(--teal)" style="margin-right:6px" />
          </template>
        </van-cell>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.card { background: var(--card-bg); border-radius: 10px; padding: 14px; }
.port { margin-bottom: 12px; }
.port-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
.port .k { font-size: 11px; color: var(--text-muted); }
.port .big { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.port .r { font-size: 12px; }
.port-today { font-size: 13px; color: var(--text-secondary); margin: 2px 0 10px; }
.port-today b { font-variant-numeric: tabular-nums; font-weight: 600; }
.port-today-cap { font-size: 11px; color: var(--text-hint); margin-left: 8px; }
.port-cap { font-size: 11px; color: var(--text-hint); text-align: center; }
.wl-val { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.est-chg { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sig { font-size: 14px; font-weight: 500; }
.nav { font-size: 12px; color: var(--text-secondary); }
.nav em { font-style: normal; margin-left: 4px; }
.sync-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.sync-sub { font-size: 12px; color: var(--text-muted); line-height: 1.6; margin-bottom: 10px; }
.sync-sub code { background: var(--chip-bg); padding: 1px 4px; border-radius: 3px; }
.sync-sub a { color: var(--teal); }
.sync-status { font-size: 12px; color: var(--text-secondary); margin: 10px 2px; }
.sync-btns { display: flex; gap: 8px; }
.sync-btns .van-button { flex: 1; }
.acc-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px 4px; }
.acc-chips .chip { font-size: 12px; color: var(--text-secondary); background: var(--chip-bg); border-radius: 12px; padding: 3px 10px; }
.acc-chips .chip.on { color: #fff; background: var(--teal); }
</style>
