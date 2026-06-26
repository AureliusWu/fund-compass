<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useFundsStore } from '@/stores/funds'
import { fetchEstimate, type Estimate } from '@/utils/estimate'
import { templateInterpret } from '@/utils/interpret'
import { pct, num, colorOf, stars } from '@/utils/format'
import type { FundDetail, ScoreResp, SignalResp, BacktestResp } from '@/api/client'

const route = useRoute()
const router = useRouter()
const funds = useFundsStore()
const code = route.params.code as string

const detail = ref<FundDetail | null>(null)
const score = ref<ScoreResp | null>(null)
const signal = ref<SignalResp | null>(null)
const bt = ref<BacktestResp | null>(null)
const est = ref<Estimate | null>(null)
const loading = ref(true)
const error = ref('')
const busy = ref(false)
const card = ref<HTMLElement>()

const COMP: Record<string, string> = { return: '收益', risk: '风险', management: '管理', cost: '成本' }
const today = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')

onMounted(async () => {
  fetchEstimate(code).then((e) => { est.value = e })
  try {
    detail.value = await funds.detail(code)
    score.value = await funds.score(code)
    signal.value = await funds.signal(code)
  } catch {
    error.value = '加载失败，请稍后再试'
  } finally {
    loading.value = false
  }
  try { bt.value = await funds.backtest(code) } catch { /* 可选 */ }
})

const verdict = computed(() =>
  detail.value ? templateInterpret(detail.value, score.value, signal.value, bt.value).verdict : '',
)

async function render(): Promise<string | null> {
  if (!card.value) return null
  const { toPng } = await import('html-to-image')
  // skipFonts：报告用系统字体，跳过 web font 内联，避免 html-to-image 抓取外部样式表时卡死。
  return toPng(card.value, { pixelRatio: 2, backgroundColor: '#ffffff', skipFonts: true })
}

async function save() {
  busy.value = true
  try {
    const url = await render()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = `司南体检_${detail.value?.name || code}.png`
    a.click()
    showToast('已保存图片')
  } catch {
    showToast('导出失败')
  } finally {
    busy.value = false
  }
}

async function share() {
  busy.value = true
  try {
    const url = await render()
    if (!url) return
    const blob = await (await fetch(url)).blob()
    const file = new File([blob], `司南体检_${detail.value?.name || code}.png`, { type: 'image/png' })
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean }
    if (nav.canShare && nav.canShare({ files: [file] })) {
      await nav.share({ files: [file], title: '司南基金 · 体检报告' })
    } else {
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
      showToast('已保存图片（本设备不支持直接分享）')
    }
  } catch {
    /* 用户取消分享等，忽略 */
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="体检报告" left-arrow @click-left="router.back()" />
    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="error" :description="error" />
      <template v-else-if="detail">
        <div class="report" ref="card">
          <div class="r-head">
            <span class="brand">司南基金</span>
            <span class="r-title">基金体检报告</span>
          </div>

          <div class="r-name">{{ detail.name }}</div>
          <div class="r-meta">
            {{ detail.code }} · {{ detail.type || '--' }}
            <template v-if="detail.scale != null"> · {{ detail.scale }}亿</template>
            <template v-if="detail.manager"> · {{ detail.manager }}{{ detail.manager_worktime ? '（' + detail.manager_worktime + '）' : '' }}</template>
          </div>

          <div class="r-hero">
            <div class="hb">
              <div class="hk">综合评分</div>
              <div class="hv green">{{ score?.score ?? '--' }}<small>/100</small></div>
              <div class="hs">{{ stars(score?.star) }}</div>
              <div class="hr" v-if="score?.rank_in_type">同类 {{ score.rank_in_type }}/{{ score.rank_total }}</div>
            </div>
            <div class="hb" style="text-align:right">
              <div class="hk">盘中估值</div>
              <div class="hv" :style="{ color: colorOf(est?.estChange) }">{{ est && est.estChange != null ? pct(est.estChange) : '--' }}</div>
              <div class="hr">估算净值 {{ est ? num(est.estNav) : '--' }}</div>
              <div class="hr" v-if="est?.estTime">{{ est.estTime }}</div>
            </div>
          </div>

          <div class="r-sec">评分四维</div>
          <div class="r-comp" v-for="(c, k) in score?.components" :key="k">
            <span class="cn">{{ COMP[k] }}</span>
            <span class="bar"><i :style="{ width: Math.round(c.score ?? 0) + '%' }"></i></span>
            <span class="cv">{{ c.score ?? '--' }}</span>
          </div>

          <div class="r-sec">区间收益</div>
          <div class="r-grid">
            <div><span class="gk">近1月</span><span class="gv" :style="{ color: colorOf(detail.ret_1m) }">{{ pct(detail.ret_1m) }}</span></div>
            <div><span class="gk">近6月</span><span class="gv" :style="{ color: colorOf(detail.ret_6m) }">{{ pct(detail.ret_6m) }}</span></div>
            <div><span class="gk">近1年</span><span class="gv" :style="{ color: colorOf(detail.ret_1y) }">{{ pct(detail.ret_1y) }}</span></div>
            <div><span class="gk">近3年</span><span class="gv" :style="{ color: colorOf(detail.ret_3y) }">{{ pct(detail.ret_3y) }}</span></div>
          </div>

          <template v-if="signal">
            <div class="r-sec">择时信号</div>
            <div class="r-sig">
              <span class="sg" :style="{ color: colorOf(signal.signal === '买入' ? 1 : signal.signal === '减仓' ? -1 : 0) }">{{ signal.signal }}</span>
              <span class="sl">
                估值{{ signal.layers.valuation.label }} · 趋势{{ signal.layers.trend.label }} · 情绪{{ signal.layers.sentiment.label }}
              </span>
            </div>
          </template>

          <template v-if="bt && bt.available && bt.strategy && bt.benchmark">
            <div class="r-sec">策略回测（vs 一直持有）</div>
            <div class="r-grid">
              <div><span class="gk">策略收益</span><span class="gv" :style="{ color: colorOf(bt.strategy.total_return) }">{{ pct(bt.strategy.total_return) }}</span></div>
              <div><span class="gk">持有收益</span><span class="gv" :style="{ color: colorOf(bt.benchmark.total_return) }">{{ pct(bt.benchmark.total_return) }}</span></div>
              <div><span class="gk">超额</span><span class="gv" :style="{ color: colorOf(bt.outperform ?? 0) }">{{ pct(bt.outperform ?? 0) }}</span></div>
              <div><span class="gk">胜率</span><span class="gv">{{ bt.win_rate }}%</span></div>
            </div>
          </template>

          <div class="r-verdict">{{ verdict }}</div>

          <div class="r-foot">
            数据来源：天天基金 · 生成于 {{ today }}<br />
            本报告为数据整理，仅供个人参考，不构成投资建议。
          </div>
        </div>

        <div class="acts">
          <van-button block type="primary" :loading="busy" @click="save">保存图片</van-button>
          <van-button block plain type="primary" :loading="busy" @click="share">分享</van-button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.report { background: #fff; border-radius: 12px; padding: 18px 16px; }
.r-head { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 2px solid #0f9d75; padding-bottom: 8px; }
.brand { font-size: 17px; font-weight: 700; color: #0f9d75; letter-spacing: 1px; }
.r-title { font-size: 12px; color: #969799; }
.r-name { font-size: 19px; font-weight: 600; color: #323233; margin-top: 12px; }
.r-meta { font-size: 12px; color: #969799; margin-top: 4px; line-height: 1.5; }
.r-hero { display: flex; justify-content: space-between; margin: 14px 0 4px; }
.hb .hk { font-size: 11px; color: #969799; }
.hv { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
.hv.green { color: #0f9d75; }
.hv small { font-size: 13px; color: #c8c9cc; font-weight: 400; }
.hs { font-size: 13px; color: #ffb400; letter-spacing: 1px; }
.hr { font-size: 11px; color: #c8c9cc; margin-top: 1px; }
.r-sec { font-size: 12px; color: #646566; font-weight: 600; margin: 16px 0 8px; }
.r-comp { display: flex; align-items: center; font-size: 12px; margin: 7px 0; }
.r-comp .cn { width: 36px; color: #646566; }
.r-comp .bar { flex: 1; height: 7px; background: #eef0f2; border-radius: 4px; margin: 0 10px; overflow: hidden; }
.r-comp .bar i { display: block; height: 100%; background: #0f9d75; border-radius: 4px; }
.r-comp .cv { width: 28px; text-align: right; color: #323233; }
.r-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.r-grid > div { display: flex; flex-direction: column; align-items: center; background: #f7f8fa; border-radius: 8px; padding: 8px 0; }
.gk { font-size: 11px; color: #969799; }
.gv { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 3px; }
.r-sig { display: flex; align-items: baseline; gap: 10px; background: #f7f8fa; border-radius: 8px; padding: 10px 12px; }
.r-sig .sg { font-size: 18px; font-weight: 700; }
.r-sig .sl { font-size: 11px; color: #646566; line-height: 1.5; }
.r-verdict { font-size: 13px; color: #323233; line-height: 1.6; background: #f0faf6; border-radius: 8px; padding: 12px; margin-top: 16px; }
.r-foot { font-size: 10px; color: #c8c9cc; line-height: 1.6; margin-top: 14px; text-align: center; }
.acts { display: flex; gap: 12px; margin-top: 16px; }
</style>
