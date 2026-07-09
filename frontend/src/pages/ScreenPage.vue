<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { getFunds, type FundListItem } from '@/api/client'
import { useWatchlistStore } from '@/stores/watchlist'
import { loadScreener, filterAndSortRank, rankMetric, screenQuality, type ScreenFund, type ScreenPresetId } from '@/utils/screener'
import { loadManagers, type Manager } from '@/utils/managers'
import { pct, colorOf } from '@/utils/format'
import { parseQuery, applySpec, specSummary } from '@/utils/nlselect'
import type { FilterSpec } from '@/utils/nlselect'
import { exportRankCSV } from '@/utils/export'

const router = useRouter()
const watch = useWatchlistStore()
const mode = ref<'rank' | 'basic' | 'manager' | 'nl'>('rank') // 默认排行（自带数据、不依赖后端）
const q = ref('')
const type = ref('')

// ── 基础模式（后端列表，覆盖 ETF/货币/封闭等全量，按类型+关键词）──
const TYPES = ['', '股票型', '混合型', '债券型', '指数型', 'QDII', 'ETF', '货币型', 'FOF']
const items = ref<FundListItem[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const finished = ref(false)

async function loadBasic() {
  if (finished.value) return
  loading.value = true
  try {
    const r = await getFunds({ q: q.value || undefined, type: type.value || undefined, page: page.value, page_size: 20 })
    total.value = r.total
    items.value.push(...r.items)
    page.value++
    if (items.value.length >= r.total) finished.value = true
  } catch {
    showToast('加载失败，后端是否已启动？')
    finished.value = true
  } finally {
    loading.value = false
  }
}
function resetBasic() {
  page.value = 1; items.value = []; finished.value = false; loadBasic()
}

// ── 排行模式（V6-P4：决策质量筛选 + 场景预设）──
const RANK_TYPES = ['', '股票型', '混合型', '债券型', '指数型', 'QDII', 'FOF']
const PRESETS: { id: ScreenPresetId; label: string }[] = [
  { id: '', label: '全部' },
  { id: 'broad', label: '宽基指数' },
  { id: 'sector', label: '行业主题' },
  { id: 'qdii', label: 'QDII' },
  { id: 'bond', label: '债基' },
]
const SORTS = [
  { k: 'quality' as const, label: '综合质量' },
  { k: 'r1y' as const, label: '近1年' },
  { k: 'r3y' as const, label: '近3年' },
  { k: 'stable' as const, label: '低波动' },
  { k: 'r6m' as const, label: '近6月' },
  { k: 'r3m' as const, label: '近3月' },
  { k: 'ytd' as const, label: '今年来' },
  { k: 'fee' as const, label: '低费率' },
]
type SortKey = (typeof SORTS)[number]['k']
const sortKey = ref<SortKey>('quality')
const preset = ref<ScreenPresetId>('')
const minR1y = ref('')
const minR3y = ref('')
const maxFee = ref('')
const minQuality = ref('')
const rankAll = ref<ScreenFund[]>([])
const rankUpdated = ref('')
const rankLoading = ref(false)
const rankErr = ref('')

async function ensureRank() {
  if (rankAll.value.length || rankLoading.value) return
  rankLoading.value = true; rankErr.value = ''
  try {
    const d = await loadScreener()
    rankAll.value = d.funds; rankUpdated.value = d.updated
  } catch {
    rankErr.value = '暂无排行数据（待富集任务生成后可用）'
  } finally {
    rankLoading.value = false
  }
}

const ranked = computed(() => {
  const minY = parseFloat(minR1y.value)
  const min3 = parseFloat(minR3y.value)
  const maxF = parseFloat(maxFee.value)
  const minQ = parseFloat(minQuality.value)
  return filterAndSortRank(rankAll.value, {
    type: type.value || undefined,
    preset: preset.value || undefined,
    keyword: q.value,
    minR1y: Number.isFinite(minY) ? minY : undefined,
    minR3y: Number.isFinite(min3) ? min3 : undefined,
    maxFee: Number.isFinite(maxF) ? maxF : undefined,
    minQuality: Number.isFinite(minQ) ? minQ : undefined,
    sortKey: sortKey.value,
  })
})
const rankedTop = computed(() => ranked.value.slice(0, 200))
function metric(f: ScreenFund): number | null { return rankMetric(f, sortKey.value) }

function pickPreset(id: ScreenPresetId) {
  preset.value = id
  if (id === 'qdii') type.value = 'QDII'
  else if (id === 'bond') type.value = '债券型'
  else if (id === 'broad' || id === 'sector') type.value = '指数型'
}

// ── 基金经理模式 ──
const managersAll = ref<Manager[]>([])
const mgrLoading = ref(false)
const mgrErr = ref('')
const expanded = ref('')
async function ensureManagers() {
  if (managersAll.value.length || mgrLoading.value) return
  mgrLoading.value = true; mgrErr.value = ''
  try { managersAll.value = await loadManagers() }
  catch { mgrErr.value = '暂无基金经理数据（待富集任务生成后可用）' }
  finally { mgrLoading.value = false }
}
const managerResults = computed(() => {
  const k = q.value.trim()
  if (!k || !managersAll.value.length) return []
  return managersAll.value.filter((m) => m.name.includes(k) || m.company.includes(k)).slice(0, 30)
})

// ── 自然语言模式（V3-6：用户一句话 → LLM 解析 → 套用排行筛选）──
const nlQuery = ref('')
const nlSpec = ref<FilterSpec | null>(null)
const nlLoading = ref(false)
const nlErr = ref('')
const nlDone = ref(false)
const nlFiltered = ref<ScreenFund[]>([])
const nlTop = computed(() => nlFiltered.value.slice(0, 200))

async function runNlSearch() {
  const q = nlQuery.value.trim()
  if (!q) return
  nlErr.value = ''; nlSpec.value = null; nlFiltered.value = []; nlDone.value = false
  nlLoading.value = true
  try {
    // 并行：解析 NL + 加载排行数据
    const [spec, { funds }] = await Promise.all([parseQuery(q), loadScreener()])
    nlSpec.value = spec
    nlFiltered.value = applySpec(funds, spec)
  } catch (e) {
    nlErr.value = e instanceof Error ? e.message : '解析失败'
  } finally {
    nlLoading.value = false; nlDone.value = true
    if (!rankAll.value.length) rankAll.value = (await loadScreener().catch(() => ({ funds: [], updated: '' }))).funds
  }
}

function switchMode(m: 'rank' | 'basic' | 'manager' | 'nl') {
  mode.value = m
  if (m === 'rank') ensureRank()
  else if (m === 'manager') ensureManagers()
  else if (m === 'nl') ensureRank() // NL 依赖排行数据，静默预加载
  else if (!items.value.length) resetBasic()
}
function pick(t: string) {
  type.value = t
  if (mode.value === 'basic') resetBasic()
}
async function toggleWatch(code: string, name: string) {
  try {
    await watch.toggle(code, name)
    showToast(watch.has(code) ? '已加入自选' : '已移出自选')
  } catch { showToast('操作失败') }
}

onMounted(() => {
  watch.load().catch(() => {})
  ensureRank()
})
</script>

<template>
  <div class="page">
    <van-nav-bar title="选基" />
    <div class="modebar">
      <span :class="{ on: mode === 'rank' }" @click="switchMode('rank')">排行筛选</span>
      <span :class="{ on: mode === 'nl' }" @click="switchMode('nl')">AI 选基</span>
      <span :class="{ on: mode === 'basic' }" @click="switchMode('basic')">全部 / 搜索</span>
      <span :class="{ on: mode === 'manager' }" @click="switchMode('manager')">基金经理</span>
    </div>
    <van-search v-if="mode !== 'nl'" v-model="q"
      :placeholder="mode === 'manager' ? '输入基金经理姓名（如 张坤）' : mode === 'rank' ? '在排行里搜代码/名称' : '代码 / 名称 / 拼音'"
      @search="mode === 'basic' && resetBasic()" @clear="mode === 'basic' && resetBasic()" />
    <div class="chips" v-if="mode !== 'manager' && mode !== 'nl'">
      <span v-for="t in (mode === 'rank' ? RANK_TYPES : TYPES)" :key="t" class="chip" :class="{ on: type === t }" @click="pick(t)">
        {{ t || '全部' }}
      </span>
    </div>

    <!-- 排行模式 -->
    <template v-if="mode === 'rank'">
      <div class="chips sorts">
        <span v-for="s in SORTS" :key="s.k" class="chip sm" :class="{ on: sortKey === s.k }" @click="sortKey = s.k">{{ s.label }}</span>
      </div>
      <div class="filters">
        <label>近1年≥<input v-model="minR1y" type="number" inputmode="decimal" placeholder="%" /></label>
        <label>费率≤<input v-model="maxFee" type="number" inputmode="decimal" placeholder="%" /></label>
      </div>
      <div class="page-body" style="padding-top:6px">
        <van-loading v-if="rankLoading" style="text-align:center;padding:40px" />
        <van-empty v-else-if="rankErr" :description="rankErr" />
        <template v-else>
          <div class="hint">命中 {{ ranked.length }} 只{{ ranked.length > 200 ? '（显示前 200，缩小筛选看更多）' : '' }} · 数据 {{ rankUpdated }}<span class="exp-link" @click="exportRankCSV(rankedTop)">导出 CSV</span></div>
          <van-cell v-for="f in rankedTop" :key="f.c" :title="f.n" :label="f.c + ' · ' + f.t" @click="router.push('/fund/' + f.c)">
            <template #value>
              <div class="rk-val">
                <span class="rk-m" :style="{ color: sortKey === 'fee' ? '#5A6A60' : colorOf(metric(f)) }">
                  {{ sortKey === 'fee' ? (f.fee != null ? f.fee + '%' : '--') : pct(metric(f)) }}
                </span>
                <span class="rk-sub">近1年 {{ pct(f.r1y) }} · 费 {{ f.fee != null ? f.fee + '%' : '--' }}</span>
              </div>
            </template>
            <template #right-icon>
              <van-icon :name="watch.has(f.c) ? 'star' : 'star-o'" :color="watch.has(f.c) ? '#C8A75B' : '#A8B2A8'"
                size="20" style="margin-left:8px" @click.stop="toggleWatch(f.c, f.n)" />
            </template>
          </van-cell>
        </template>
      </div>
    </template>

    <!-- 基金经理模式 -->
    <template v-else-if="mode === 'manager'">
      <div class="page-body" style="padding-top:8px">
        <van-loading v-if="mgrLoading" style="text-align:center;padding:40px" />
        <van-empty v-else-if="mgrErr" :description="mgrErr" />
        <van-empty v-else-if="!q.trim()" description="输入基金经理姓名搜索（如 张坤、葛兰）" />
        <van-empty v-else-if="!managerResults.length" description="未找到该基金经理" />
        <van-cell-group v-else inset>
          <template v-for="m in managerResults" :key="m.id">
            <van-cell :title="m.name"
              :label="m.company + ' · 现任 ' + m.codes.length + ' 只 · 任职回报 ' + m.ret + ' · ' + m.scale"
              is-link @click="expanded = expanded === m.id ? '' : m.id" />
            <div v-if="expanded === m.id" class="mgr-funds">
              <div class="mgr-fund" v-for="(c, i) in m.codes" :key="c" @click="router.push('/fund/' + c)">
                <span class="mf-nm">{{ m.names[i] || c }}</span><span class="mf-code">{{ c }}</span>
              </div>
            </div>
          </template>
        </van-cell-group>
      </div>
    </template>

    <!-- 自然语言模式（V3-6） -->
    <template v-else-if="mode === 'nl'">
      <div class="nl-box card">
        <textarea v-model="nlQuery" placeholder="用中文描述你想找的基金，例如：近3年收益超50%的混合型基金，按近3年排序"
          rows="3" @keydown.ctrl.enter="runNlSearch" @keydown.meta.enter="runNlSearch"></textarea>
        <van-button class="nl-btn" size="small" type="primary" :loading="nlLoading"
          @click="runNlSearch" :disabled="!nlQuery.trim()">AI 筛选</van-button>
        <span class="nl-hint">Ctrl+Enter 发送。需先配置 AI（在基金详情页）。</span>
      </div>
      <div class="page-body" style="padding-top:8px">
        <van-loading v-if="nlLoading" style="text-align:center;padding:40px" />
        <van-empty v-else-if="nlErr" :description="nlErr" />
        <template v-else-if="nlDone">
          <div class="nl-tags" v-if="nlSpec">
            <span class="nl-tag" v-for="t in specSummary(nlSpec)" :key="t">{{ t }}</span>
            <span class="nl-tag warn" v-for="u in (nlSpec.unsupported || [])" :key="u">不支持：{{ u }}</span>
          </div>
          <van-empty v-if="!nlFiltered.length" description="没有匹配的基金，试试放宽条件" image-size="50" />
          <template v-else>
            <div class="hint">命中 {{ nlFiltered.length }} 只{{ nlFiltered.length > 200 ? '（显示前 200）' : '' }}</div>
            <van-cell v-for="f in nlTop" :key="f.c" :title="f.n" :label="f.c + ' · ' + f.t"
              @click="router.push('/fund/' + f.c)">
              <template #value>
                <div class="rk-val">
                  <span class="rk-m" :style="{ color: colorOf(f.r1y) }">{{ pct(f.r1y) }}</span>
                  <span class="rk-sub">近3年 {{ pct(f.r3y) }} · 费 {{ f.fee != null ? f.fee + '%' : '--' }}</span>
                </div>
              </template>
              <template #right-icon>
                <van-icon :name="watch.has(f.c) ? 'star' : 'star-o'" :color="watch.has(f.c) ? '#C8A75B' : '#A8B2A8'"
                  size="20" style="margin-left:8px" @click.stop="toggleWatch(f.c, f.n)" />
              </template>
            </van-cell>
          </template>
        </template>
        <van-empty v-else description="输入筛选条件后点击「AI 筛选」" image-size="60" />
      </div>
    </template>

    <!-- 基础模式（后端全量） -->
    <div v-else class="page-body" style="padding-top:8px">
      <div class="hint">共 {{ total }} 只</div>
      <van-list v-model:loading="loading" :finished="finished" finished-text="没有更多了" @load="loadBasic">
        <van-cell v-for="it in items" :key="it.code" :title="it.name" :label="it.code + ' · ' + it.type"
          @click="router.push('/fund/' + it.code)">
          <template #right-icon>
            <van-icon :name="watch.has(it.code) ? 'star' : 'star-o'" :color="watch.has(it.code) ? '#C8A75B' : '#A8B2A8'"
              size="20" @click.stop="toggleWatch(it.code, it.name)" />
          </template>
        </van-cell>
      </van-list>
    </div>
  </div>
</template>

<style scoped>
.modebar { display: flex; background: var(--card-bg); padding: 8px 16px 0; gap: 18px; }
.modebar span { font-size: 14px; color: var(--text-muted); padding-bottom: 8px; border-bottom: 2px solid transparent; }
.modebar span.on { color: var(--teal); font-weight: 600; border-bottom-color: var(--teal); }
.chips { display: flex; gap: 8px; overflow-x: auto; padding: 8px 16px; background: var(--card-bg); }
.chips.sorts { padding-top: 0; }
.chip { flex: none; font-size: 13px; padding: 4px 12px; border-radius: 14px; background: var(--chip-bg); color: var(--text-secondary); white-space: nowrap; }
.chip.sm { font-size: 12px; padding: 3px 10px; }
.chip.on { background: var(--teal); color: #fff; }
.filters { display: flex; gap: 12px; padding: 4px 16px 8px; background: var(--card-bg); }
.filters label { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; }
.filters input { width: 64px; height: 28px; border: 1px solid var(--border); border-radius: 6px; padding: 0 8px; font-size: 13px; background: var(--card-bg); color: var(--text); }
.hint { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
.exp-link { color: var(--teal); font-weight: 500; }
.rk-val { display: flex; flex-direction: column; align-items: flex-end; }
.rk-m { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.rk-sub { font-size: 11px; color: var(--text-hint); }
.mgr-funds { background: var(--mgr-bg); padding: 4px 16px; }
.mgr-fund { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; font-size: 13px; border-bottom: 0.5px solid var(--border); }
.mgr-fund:last-child { border-bottom: none; }
.mf-nm { color: var(--text); }
.mf-code { color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* ── NL 模式 ── */
.nl-box { margin: 8px 16px; display: flex; flex-direction: column; gap: 8px; background: var(--card-bg); }
.nl-box textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 14px; resize: vertical; font-family: inherit; background: var(--card-bg); color: var(--text); }
.nl-box .nl-btn { align-self: flex-start; }
.nl-hint { font-size: 11px; color: var(--text-hint); }
.nl-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.nl-tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--nl-tag-bg); color: var(--teal); }
.nl-tag.warn { background: var(--nl-tag-warn-bg); color: #C8963E; }
</style>
