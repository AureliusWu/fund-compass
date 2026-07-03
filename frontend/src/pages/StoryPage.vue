<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { fetchEstimates, latestNavMove, preferredDailyMove, type Estimate, type NavMove } from '@/utils/estimate'
import { colorOf } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import { compileStoryData, generateStorySummary, type StoryData } from '@/utils/story'

const watch = useWatchlistStore()
const funds = useFundsStore()

const loading = ref(true)
const story = ref<StoryData | null>(null)
const summary = ref('')
const summaryLoading = ref(false)
const exporting = ref(false)
const exportErr = ref('')
const cardRef = ref<HTMLElement | null>(null)

const meta = ref<Record<string, {
  nav: number | null
  type: string
  navMove: NavMove | null
  signal?: string | null
  score?: number | null
  star?: number | null
}>>({})
const est = ref<Record<string, Estimate | null>>({})

onMounted(async () => {
  loading.value = true
  try {
    await watch.load(true)
    const held = watch.activeHoldings.filter((e) => e.shares && e.shares > 0)
    const codes = [...new Set(held.map((e) => e.code))]

    // 并行拉取数据
    const estMap = await fetchEstimates(codes)
    estMap.forEach((v, k) => { est.value[k] = v })

    await Promise.all(held.map(async (e) => {
      try {
        const [d, sig, sc] = await Promise.all([
          funds.detail(e.code),
          funds.signal(e.code).catch(() => null),
          funds.score(e.code).catch(() => null),
        ])
        meta.value[e.code] = {
          nav: d.latest_nav, type: d.type || '其他',
          navMove: latestNavMove(d.nav_history),
          signal: sig?.signal,
          score: sc?.score ?? null,
          star: sc?.star ?? null,
        }
      } catch {
        meta.value[e.code] = { nav: null, type: '其他', navMove: null }
      }
    }))

    // 编译故事
    const hlds = held.map((e) => {
      const m = meta.value[e.code]
      const nav = m?.nav ?? null
      const value = nav != null ? e.shares! * nav : 0
      const move = preferredDailyMove(est.value[e.code], m?.navMove, m?.type || e.name)
      const today = move && move.change != null && move.baseNav != null
        ? e.shares! * move.baseNav * move.change / 100 : null
      return {
        code: e.code, name: e.name || e.code, type: m?.type || '其他',
        value, shares: e.shares!, cost: e.cost ?? 0, nav,
        today, signal: m?.signal, score: m?.score, star: m?.star,
      }
    })

    const totalValue = hlds.reduce((s, h) => s + h.value, 0)
    const totalCost = hlds.reduce((s, h) => s + h.shares * h.cost, 0)
    const totalToday = hlds.reduce((s, h) => s + (h.today ?? 0), 0)

    story.value = compileStoryData({
      holdings: hlds,
      totalValue, totalCost,
      totalProfit: totalValue - totalCost,
      totalRate: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : null,
      todayEst: hlds.some((h) => h.today != null) ? totalToday : null,
    })
  } catch { /* skip */ }
  finally { loading.value = false }
})

async function genSummary() {
  if (!story.value) return
  summaryLoading.value = true
  try {
    summary.value = await generateStorySummary(story.value)
  } catch { /* skip */ }
  finally { summaryLoading.value = false }
}

// 持仓收益排序图
const barOption = computed(() => {
  if (!story.value) return null
  const sorted = [...story.value.holdings].sort((a, b) => b.rate - a.rate)
  return {
    grid: { left: 90, right: 50, top: 10, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: '{value}%' } },
    yAxis: { type: 'category', data: sorted.map((h) => h.name).reverse(), axisLabel: { fontSize: 10, width: 80, overflow: 'truncate' }, inverse: true },
    series: [{
      type: 'bar', data: sorted.map((h) => +h.rate.toFixed(2)).reverse(),
      itemStyle: { color: (p: any) => p.value >= 0 ? '#C44536' : '#3D8B63' },
    }],
  }
})

// 导出 PNG
async function doExport() {
  if (!cardRef.value) return
  exporting.value = true; exportErr.value = ''
  try {
    const { toPng } = await import('html-to-image')
    const dataUrl = await toPng(cardRef.value, { pixelRatio: 2, backgroundColor: 'var(--bg, #f5f6f7)' })
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `司南周报_${new Date().toISOString().slice(0, 10)}.png`
    a.click()
  } catch (e: any) {
    exportErr.value = e?.message || '导出失败'
  }
  finally { exporting.value = false }
}

const fp = (n: number | null | undefined) => n != null ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '--'
const fn = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
</script>

<template>
  <div class="page">
    <van-nav-bar title="数据故事">
      <template #right>
        <van-button size="mini" plain icon="down" :loading="exporting" @click="doExport">导出长图</van-button>
      </template>
    </van-nav-bar>

    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="!story" description="还没有持仓数据。去自选页添加持仓。" />

      <template v-if="story">
        <div class="story-card" ref="cardRef">
          <!-- 头部 -->
          <div class="sc-header">
            <div class="sc-brand">司南基金 · 组合周报</div>
            <div class="sc-date">{{ new Date(story.generated).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) }}</div>
          </div>

          <!-- 总览 -->
          <div class="sc-section">
            <div class="sc-sec-title">组合总览</div>
            <div class="sc-overview">
              <div class="sc-ov">
                <span class="sco-label">总市值</span>
                <span class="sco-val big">{{ fn(story.totalValue) }}</span>
              </div>
              <div class="sc-ov">
                <span class="sco-label">累计收益</span>
                <span class="sco-val" :style="{ color: colorOf(story.totalProfit) }">
                  {{ story.totalProfit >= 0 ? '+' : '' }}{{ fn(story.totalProfit) }}
                  <em>{{ fp(story.totalRate) }}</em>
                </span>
              </div>
              <div class="sc-ov" v-if="story.todayEst != null">
                <span class="sco-label">今日估算</span>
                <span class="sco-val" :style="{ color: colorOf(story.todayEst) }">
                  {{ story.todayEst >= 0 ? '+' : '' }}{{ fn(story.todayEst) }}
                </span>
              </div>
              <div class="sc-ov">
                <span class="sco-label">持仓数量</span>
                <span class="sco-val">{{ story.holdingCount }} 只</span>
              </div>
            </div>
          </div>

          <!-- 信号分布 -->
          <div class="sc-section" v-if="Object.keys(story.signalDist).length">
            <div class="sc-sec-title">信号分布</div>
            <div class="sc-chips">
              <span v-for="(cnt, sig) in story.signalDist" :key="sig" class="sc-chip"
                :style="{ background: { '买入': '#F6E3E0', '定投': '#FAF3E2', '持有': '#ECEFE9', '减仓': '#E6F0E9' }[sig] || '#F2F3EF' }">
                {{ sig }} {{ cnt }}
              </span>
            </div>
          </div>

          <!-- 持仓收益排行 -->
          <div class="sc-section" v-if="barOption">
            <div class="sc-sec-title">持仓收益对比</div>
            <Chart :option="barOption" height="220px" />
          </div>

          <!-- 极值 -->
          <div class="sc-section" v-if="story.bestHolding && story.worstHolding">
            <div class="sc-sec-title">持仓亮点</div>
            <van-cell title="🏆 最佳持仓" :value="story.bestHolding.name" :label="fp(story.bestHolding.rate)" />
            <van-cell title="📉 需关注" :value="story.worstHolding.name" :label="fp(story.worstHolding.rate)" />
            <van-cell v-if="story.bestToday" title="🔥 今日最强" :value="story.bestToday.name"
              :label="(story.bestToday.today! >= 0 ? '+' : '') + story.bestToday.today!.toFixed(2)" />
            <van-cell v-if="story.worstToday" title="❄ 今日最弱" :value="story.worstToday.name"
              :label="(story.worstToday.today! >= 0 ? '+' : '') + story.worstToday.today!.toFixed(2)" />
          </div>

          <!-- LLM 摘要 -->
          <div class="sc-section" v-if="summary">
            <div class="sc-sec-title">AI 点评</div>
            <div class="sc-summary">{{ summary }}</div>
          </div>

          <!-- 免责声明 -->
          <div class="sc-disclaimer">以上内容基于历史数据与模型估算，仅供个人参考，不构成投资建议。投资有风险，决策需谨慎。</div>
        </div>

        <!-- 操作按钮 -->
        <div class="act-row" v-if="!summary">
          <van-button plain icon="gem-o" size="small" :loading="summaryLoading" @click="genSummary" block>
            AI 生成一句话总结
          </van-button>
        </div>
        <div class="act-row" v-if="summary">
          <van-button plain icon="replay" size="small" :loading="summaryLoading" @click="genSummary" block>
            重新生成
          </van-button>
        </div>
        <div class="export-err" v-if="exportErr">{{ exportErr }}</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.story-card {
  background: var(--card-bg, #fff);
  border-radius: 12px;
  padding: 18px;
  margin-bottom: 12px;
}
.sc-header { margin-bottom: 16px; }
.sc-brand { font-size: 20px; font-weight: 700; color: var(--text); }
.sc-date { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.sc-section { margin-bottom: 16px; }
.sc-sec-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.sc-overview { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.sc-ov { background: var(--chip-bg); border-radius: 8px; padding: 10px; }
.sco-label { display: block; font-size: 11px; color: var(--text-muted); }
.sco-val { display: block; font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
.sco-val.big { font-size: 24px; }
.sco-val em { font-style: normal; font-size: 13px; margin-left: 6px; }
.sc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sc-chip { padding: 4px 10px; border-radius: 12px; font-size: 12px; }
.sc-summary { font-size: 13px; line-height: 1.8; color: var(--text-secondary); white-space: pre-line; }
.sc-disclaimer { font-size: 10px; color: var(--text-hint); margin-top: 12px; line-height: 1.5; text-align: center; }
.act-row { margin-bottom: 12px; }
.export-err { font-size: 12px; color: #C44536; text-align: center; }
</style>
