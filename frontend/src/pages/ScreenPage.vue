<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { getFunds, type FundListItem } from '@/api/client'
import { useWatchlistStore } from '@/stores/watchlist'
import { loadScreener, type ScreenFund } from '@/utils/screener'
import { pct, colorOf } from '@/utils/format'

const router = useRouter()
const watch = useWatchlistStore()
const mode = ref<'rank' | 'basic'>('rank') // 默认排行（自带数据、不依赖后端）
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

// ── 排行模式（前端 screener.json，按收益/费率筛选排序）──
const RANK_TYPES = ['', '股票型', '混合型', '债券型', '指数型', 'QDII', 'FOF']
const SORTS = [
  { k: 'r1y', label: '近1年' }, { k: 'r3y', label: '近3年' }, { k: 'r6m', label: '近6月' },
  { k: 'r3m', label: '近3月' }, { k: 'ytd', label: '今年来' }, { k: 'fee', label: '低费率' },
] as const
type SortKey = (typeof SORTS)[number]['k']
const sortKey = ref<SortKey>('r1y')
const minR1y = ref('')
const maxFee = ref('')
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
  const maxF = parseFloat(maxFee.value)
  const kw = q.value.trim().toLowerCase()
  const arr = rankAll.value.filter((f) => {
    if (type.value && f.t !== type.value) return false
    if (Number.isFinite(minY) && !(f.r1y != null && f.r1y >= minY)) return false
    if (Number.isFinite(maxF) && !(f.fee != null && f.fee <= maxF)) return false
    if (kw && !(f.c.includes(kw) || f.n.toLowerCase().includes(kw))) return false
    return true
  })
  const k = sortKey.value
  const asc = k === 'fee'
  arr.sort((a, b) => {
    const av = a[k]; const bv = b[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return asc ? av - bv : bv - av
  })
  return arr
})
const rankedTop = computed(() => ranked.value.slice(0, 200))
function metric(f: ScreenFund): number | null { return f[sortKey.value] }

function switchMode(m: 'rank' | 'basic') {
  mode.value = m
  if (m === 'rank') ensureRank()
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
      <span :class="{ on: mode === 'basic' }" @click="switchMode('basic')">全部 / 搜索</span>
    </div>
    <van-search v-model="q" :placeholder="mode === 'rank' ? '在排行里搜代码/名称' : '代码 / 名称 / 拼音'"
      @search="mode === 'basic' && resetBasic()" @clear="mode === 'basic' && resetBasic()" />
    <div class="chips">
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
          <div class="hint">命中 {{ ranked.length }} 只{{ ranked.length > 200 ? '（显示前 200，缩小筛选看更多）' : '' }} · 数据 {{ rankUpdated }}</div>
          <van-cell v-for="f in rankedTop" :key="f.c" :title="f.n" :label="f.c + ' · ' + f.t" @click="router.push('/fund/' + f.c)">
            <template #value>
              <div class="rk-val">
                <span class="rk-m" :style="{ color: sortKey === 'fee' ? '#646566' : colorOf(metric(f)) }">
                  {{ sortKey === 'fee' ? (f.fee != null ? f.fee + '%' : '--') : pct(metric(f)) }}
                </span>
                <span class="rk-sub">近1年 {{ pct(f.r1y) }} · 费 {{ f.fee != null ? f.fee + '%' : '--' }}</span>
              </div>
            </template>
            <template #right-icon>
              <van-icon :name="watch.has(f.c) ? 'star' : 'star-o'" :color="watch.has(f.c) ? '#ffb400' : '#c8c9cc'"
                size="20" style="margin-left:8px" @click.stop="toggleWatch(f.c, f.n)" />
            </template>
          </van-cell>
        </template>
      </div>
    </template>

    <!-- 基础模式（后端全量） -->
    <div v-else class="page-body" style="padding-top:8px">
      <div class="hint">共 {{ total }} 只</div>
      <van-list v-model:loading="loading" :finished="finished" finished-text="没有更多了" @load="loadBasic">
        <van-cell v-for="it in items" :key="it.code" :title="it.name" :label="it.code + ' · ' + it.type"
          @click="router.push('/fund/' + it.code)">
          <template #right-icon>
            <van-icon :name="watch.has(it.code) ? 'star' : 'star-o'" :color="watch.has(it.code) ? '#ffb400' : '#c8c9cc'"
              size="20" @click.stop="toggleWatch(it.code, it.name)" />
          </template>
        </van-cell>
      </van-list>
    </div>
  </div>
</template>

<style scoped>
.modebar { display: flex; background: #fff; padding: 8px 16px 0; gap: 18px; }
.modebar span { font-size: 14px; color: #969799; padding-bottom: 8px; border-bottom: 2px solid transparent; }
.modebar span.on { color: #0f9d75; font-weight: 600; border-bottom-color: #0f9d75; }
.chips { display: flex; gap: 8px; overflow-x: auto; padding: 8px 16px; background: #fff; }
.chips.sorts { padding-top: 0; }
.chip { flex: none; font-size: 13px; padding: 4px 12px; border-radius: 14px; background: #f2f3f5; color: #646566; white-space: nowrap; }
.chip.sm { font-size: 12px; padding: 3px 10px; }
.chip.on { background: #0f9d75; color: #fff; }
.filters { display: flex; gap: 12px; padding: 4px 16px 8px; background: #fff; }
.filters label { font-size: 12px; color: #646566; display: flex; align-items: center; gap: 4px; }
.filters input { width: 64px; height: 28px; border: 1px solid #ebedf0; border-radius: 6px; padding: 0 8px; font-size: 13px; }
.hint { font-size: 12px; color: #969799; margin-bottom: 8px; }
.rk-val { display: flex; flex-direction: column; align-items: flex-end; }
.rk-m { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.rk-sub { font-size: 11px; color: #c8c9cc; }
</style>
