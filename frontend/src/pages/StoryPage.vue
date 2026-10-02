<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { estimateDataFreshness, fetchEstimates, latestNavMove, preferredDailyMove, type Estimate, type NavMove } from '@/utils/estimate'
import { colorOf } from '@/utils/format'
import Chart from '@/components/Chart.vue'
import {
  compileStoryData,
  storyCoverageDateText,
  type RawStoryScoreEvidence,
  type RawStorySignalEvidence,
  type StoryData,
} from '@/utils/story'
import { FREE_TEXT_AI_UNAVAILABLE } from '@/utils/ai'

const watch = useWatchlistStore()
const funds = useFundsStore()

const loading = ref(true)
const story = ref<StoryData | null>(null)
const exporting = ref(false)
const exportErr = ref('')
const cardRef = ref<HTMLElement | null>(null)

const meta = ref<Record<string, {
  nav: number | null
  navDate: string | null
  navStale: boolean | null
  type: string
  navMove: NavMove | null
  signalEvidence: RawStorySignalEvidence | null
  scoreEvidence: RawStoryScoreEvidence | null
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

    await Promise.all(codes.map(async (code) => {
      try {
        const [d, sig, sc] = await Promise.all([
          funds.detail(code),
          funds.signal(code).catch(() => null),
          funds.score(code).catch(() => null),
        ])
        meta.value[code] = {
          nav: d.latest_nav,
          navDate: d.latest_nav_date,
          navStale: typeof d.stale === 'boolean' ? d.stale : null,
          type: d.type || '其他',
          navMove: latestNavMove(d.nav_history),
          signalEvidence: sig ? {
            value: sig.signal,
            coverage: sig.coverage ?? null,
            stale: typeof sig.data_stale === 'boolean' ? sig.data_stale : null,
            asOfDate: sig.as_of_date ?? null,
          } : null,
          scoreEvidence: sc ? {
            score: sc.score,
            star: sc.star,
            coverage: sc.coverage,
            eligible: sc.eligible,
            stale: typeof sc.data_stale === 'boolean' ? sc.data_stale : null,
            asOfDate: sc.as_of_date ?? null,
          } : null,
        }
      } catch {
        meta.value[code] = {
          nav: null,
          navDate: null,
          navStale: null,
          type: '其他',
          navMove: null,
          signalEvidence: null,
          scoreEvidence: null,
        }
      }
    }))

    // 编译故事
    const hlds = held.map((e) => {
      const m = meta.value[e.code]
      const nav = m?.nav ?? null
      const estimate = est.value[e.code]
      const move = preferredDailyMove(estimate, m?.navMove, m?.type || e.name)
      const today = move && move.change != null && Number.isFinite(move.change)
        && move.baseNav != null && Number.isFinite(move.baseNav) && move.baseNav > 0
        ? e.shares! * move.baseNav * move.change / 100 : null
      const usesDetailNav = Boolean(today != null && m?.navMove && move?.label === '净' && move.date === m.navMove.date)
      const todayStale = today == null
        ? null
        : usesDetailNav
          ? m?.navStale ?? null
          : estimate
            ? estimateDataFreshness(estimate) !== 'fresh'
            : null
      return {
        code: e.code, name: e.name || e.code, type: m?.type || '其他',
        shares: e.shares!, cost: e.cost ?? null,
        nav, navDate: m?.navDate ?? null, navStale: m?.navStale ?? null,
        today, todayDate: today != null ? move?.date ?? null : null, todayStale,
        detailStale: m?.navStale ?? null,
        signalEvidence: m?.signalEvidence ?? null,
        scoreEvidence: m?.scoreEvidence ?? null,
      }
    })

    story.value = compileStoryData({ holdings: hlds })
  } catch { /* skip */ }
  finally { loading.value = false }
})

// 持仓收益排序图
const barOption = computed(() => {
  if (!story.value?.coverage.returns.publishable) return null
  const sorted = [...story.value.holdings].sort((a, b) => (b.rate as number) - (a.rate as number))
  return {
    grid: { left: 90, right: 50, top: 10, bottom: 28 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value', axisLabel: { fontSize: 10, formatter: '{value}%' } },
    yAxis: { type: 'category', data: sorted.map((h) => h.name).reverse(), axisLabel: { fontSize: 10, width: 80, overflow: 'truncate' }, inverse: true },
    series: [{
      type: 'bar', data: sorted.map((h) => +(h.rate as number).toFixed(2)).reverse(),
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
const fn = (n: number | null | undefined) => n != null && Number.isFinite(n)
  ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  : '--'
const signedFn = (n: number | null | undefined) => n != null && Number.isFinite(n)
  ? (n >= 0 ? '+' : '') + fn(n)
  : '--'

function totalValueLabel(data: StoryData): string {
  const coverage = data.coverage.valuation
  if (coverage.futureDate.length) return '总市值（日期异常）'
  if (coverage.stale.length) return '总市值（含旧净值）'
  if (coverage.freshnessUnknown.length || coverage.dated !== coverage.covered) return '净值市值（日期/新鲜度未知）'
  if (coverage.dates.length > 1) return '净值市值（跨日期）'
  return '总市值'
}

function totalProfitLabel(data: StoryData): string {
  const coverage = data.coverage.valuation
  if (coverage.futureDate.length) return '累计收益（日期异常）'
  if (coverage.stale.length) return '累计收益（含旧净值）'
  if (coverage.freshnessUnknown.length || coverage.dated !== coverage.covered || coverage.dates.length > 1) {
    return '累计收益（非同日口径）'
  }
  return '累计收益'
}
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
            <div class="sc-date">报告生成于 {{ new Date(story.generated).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) }}</div>
          </div>

          <!-- 总览 -->
          <div class="sc-section">
            <div class="sc-sec-title">组合总览</div>
            <div class="sc-overview">
              <div class="sc-ov">
                <span class="sco-label">{{ totalValueLabel(story) }}</span>
                <span class="sco-val big">{{ fn(story.totalValue) }}</span>
              </div>
              <div class="sc-ov">
                <span class="sco-label">{{ totalProfitLabel(story) }}</span>
                <span class="sco-val" :style="{ color: colorOf(story.totalProfit) }">
                  {{ signedFn(story.totalProfit) }}
                  <em>{{ fp(story.totalRate) }}</em>
                </span>
              </div>
              <div class="sc-ov">
                <span class="sco-label">单日变动合计</span>
                <span class="sco-val" :style="{ color: colorOf(story.todayEst) }">
                  {{ signedFn(story.todayEst) }}
                </span>
              </div>
              <div class="sc-ov">
                <span class="sco-label">持仓数量</span>
                <span class="sco-val">{{ story.holdingCount }} 只</span>
              </div>
            </div>
            <div class="sc-trace">
              <div>
                净值覆盖 {{ story.coverage.valuation.covered }}/{{ story.coverage.valuation.total }}
                · 数据日期 {{ storyCoverageDateText(story.coverage.valuation) }}
              </div>
              <div>成本覆盖 {{ story.coverage.cost.covered }}/{{ story.coverage.cost.total }}</div>
              <div>
                单日变动覆盖 {{ story.coverage.today.covered }}/{{ story.coverage.today.total }}
                · 数据日期 {{ storyCoverageDateText(story.coverage.today) }}
              </div>
            </div>
            <div class="sc-coverage-warning" v-if="!story.coverage.valuation.publishable || !story.coverage.cost.publishable || !story.coverage.today.publishable || story.coverage.valuation.stale.length || story.coverage.valuation.freshnessUnknown.length || story.coverage.valuation.dates.length > 1">
              <div v-if="!story.coverage.valuation.complete">
                缺失净值：{{ story.coverage.valuation.missing.join('、') || '未知持仓' }}；总市值保留为 --。
                <template v-if="story.coverage.valuation.covered > 0">已定价小计 {{ fn(story.pricedValue) }}，不代表组合总市值。</template>
              </div>
              <div v-if="story.coverage.valuation.futureDate.length">未来净值日期已拒绝：{{ story.coverage.valuation.futureDate.join('、') }}；总市值与累计收益保留为 --。</div>
              <div v-if="story.coverage.valuation.stale.length">旧净值：{{ story.coverage.valuation.stale.join('、') }}；金额基于旧数据，不代表当前市值。</div>
              <div v-if="story.coverage.valuation.freshnessUnknown.length">净值新鲜度未知：{{ story.coverage.valuation.freshnessUnknown.join('、') }}。</div>
              <div v-if="story.coverage.valuation.complete && story.coverage.valuation.dated < story.coverage.valuation.covered && !story.coverage.valuation.futureDate.length">部分净值缺少有效数值日期，日期保持未知。</div>
              <div v-if="story.coverage.valuation.dates.length > 1">净值来自不同市场日期，金额按各自最近可用净值计算。</div>
              <div v-if="!story.coverage.cost.complete">缺失成本：{{ story.coverage.cost.missing.join('、') || '未知持仓' }}；累计收益保留为 --。</div>
              <div v-if="!story.coverage.today.complete">单日变动数据未完整，不发布部分持仓合计。</div>
              <div v-else-if="!story.coverage.today.publishable">
                单日变动未通过日期/新鲜度门禁，不发布合计：
                <template v-if="story.coverage.today.dates.length > 1">来源跨日期；</template>
                <template v-if="story.coverage.today.dated < story.coverage.today.covered">日期缺失；</template>
                <template v-if="story.coverage.today.futureDate.length">未来日期；</template>
                <template v-if="story.coverage.today.stale.length">旧数据；</template>
                <template v-if="story.coverage.today.freshnessUnknown.length">新鲜度未知；</template>
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
            <div class="sc-trace">
              <div>可信信号覆盖 {{ story.coverage.signal.covered }}/{{ story.coverage.signal.total }} · 数据日期 {{ storyCoverageDateText(story.coverage.signal) }}</div>
              <div>可信评分覆盖 {{ story.coverage.score.covered }}/{{ story.coverage.score.total }} · 数据日期 {{ storyCoverageDateText(story.coverage.score) }}</div>
            </div>
            <div class="sc-missing" v-if="!story.coverage.signal.complete || !story.coverage.score.complete">未通过 70% 覆盖、新鲜度、有效日期或评分资格门禁的旧版证据统一显示为“未知”。</div>
          </div>

          <!-- 持仓收益排行 -->
          <div class="sc-section" v-if="barOption">
            <div class="sc-sec-title">持仓收益对比</div>
            <Chart :option="barOption" height="220px" />
          </div>
          <div class="sc-section" v-else-if="story.holdingCount > 0">
            <div class="sc-sec-title">持仓收益对比</div>
            <div class="sc-missing">持仓收益覆盖 {{ story.coverage.returns.covered }}/{{ story.coverage.returns.total }}，未通过覆盖、同日日期与新鲜度门禁，暂不排名。</div>
          </div>

          <!-- 极值 -->
          <div class="sc-section" v-if="story.bestHolding || story.worstHolding || story.bestToday || story.worstToday">
            <div class="sc-sec-title">持仓亮点</div>
            <van-cell v-if="story.bestHolding" title="🏆 最佳持仓" :value="story.bestHolding.name" :label="fp(story.bestHolding.rate)" />
            <van-cell v-if="story.worstHolding" title="📉 需关注" :value="story.worstHolding.name" :label="fp(story.worstHolding.rate)" />
            <van-cell v-if="story.bestToday" title="🔥 单日最强" :value="story.bestToday.name"
              :label="(story.bestToday.today! >= 0 ? '+' : '') + story.bestToday.today!.toFixed(2)" />
            <van-cell v-if="story.worstToday" title="❄ 单日最弱" :value="story.worstToday.name"
              :label="(story.worstToday.today! >= 0 ? '+' : '') + story.worstToday.today!.toFixed(2)" />
          </div>

          <!-- 自由文本 AI 暂停，不生成或伪装降级摘要 -->
          <div class="sc-section">
            <div class="sc-sec-title">AI 摘要暂不可用</div>
            <div class="sc-summary" role="status">{{ FREE_TEXT_AI_UNAVAILABLE }}</div>
          </div>

          <!-- 免责声明 -->
          <div class="sc-disclaimer">以上内容基于历史数据与模型估算，仅供个人参考，不构成投资建议。投资有风险，决策需谨慎。</div>
        </div>

        <!-- 操作按钮 -->
        <div class="act-row">
          <van-button plain icon="gem-o" size="small" disabled block>AI 自由文本摘要已暂停</van-button>
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
.sc-trace { display: grid; gap: 3px; margin-top: 9px; color: var(--text-hint); font-size: 10px; line-height: 1.5; }
.sc-coverage-warning { display: grid; gap: 4px; margin-top: 8px; padding: 8px 10px; color: var(--text-secondary); background: var(--chip-bg); border-radius: 7px; font-size: 11px; line-height: 1.55; }
.sc-missing { color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.sc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sc-chip { padding: 4px 10px; border-radius: 12px; font-size: 12px; }
.sc-summary { font-size: 13px; line-height: 1.8; color: var(--text-secondary); white-space: pre-line; }
.sc-disclaimer { font-size: 10px; color: var(--text-hint); margin-top: 12px; line-height: 1.5; text-align: center; }
.act-row { margin-bottom: 12px; }
.export-err { font-size: 12px; color: #C44536; text-align: center; }
</style>
