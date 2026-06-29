<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useFundsStore } from '@/stores/funds'
import { useWatchlistStore } from '@/stores/watchlist'
import { pct, num, colorOf, signalColor } from '@/utils/format'
import StarRating from '@/components/StarRating.vue'
import Chart from '@/components/Chart.vue'
import DcaCalc from '@/components/DcaCalc.vue'
import { fetchEstimate, type Estimate } from '@/utils/estimate'
import { getHoldings, type Holding } from '@/utils/holdings'
import { templateInterpret, llmInterpret } from '@/utils/interpret'
import { getAiConfig, setAiConfig, hasAiKey, providerDef, PROVIDERS, type AiConfig } from '@/utils/ai'
import { findSimilar, type ScreenFund } from '@/utils/screener'
import type { FundDetail, ScoreResp, SignalResp, BacktestResp } from '@/api/client'

const route = useRoute()
const router = useRouter()
const funds = useFundsStore()
const watch = useWatchlistStore()
const code = route.params.code as string

const detail = ref<FundDetail | null>(null)
const score = ref<ScoreResp | null>(null)
const signal = ref<SignalResp | null>(null)
const bt = ref<BacktestResp | null>(null)
const est = ref<Estimate | null>(null)
const estDone = ref(false)
const holdings = ref<Holding[]>([])
const holdingsDone = ref(false)
const loading = ref(true)
const error = ref('')

const holdMax = computed(() => Math.max(1, ...holdings.value.map((s) => s.ratio)))

const COMP_NAMES: Record<string, string> = { return: '收益', risk: '风险', management: '管理', cost: '成本' }

// 智能解读：B 规则版即时计算（随数据到达响应式更新），A LLM 版按需触发
const interp = computed(() =>
  detail.value ? templateInterpret(detail.value, score.value, signal.value, bt.value) : null,
)
const aiCfg = ref<AiConfig>(getAiConfig())
const aiReady = ref(hasAiKey())
const aiText = ref('')
const aiLoading = ref(false)
const aiErr = ref('')
const cfgShow = ref(false)
const curDef = computed(() => providerDef(aiCfg.value.provider))

// 持久化 AI 解读（按基金代码缓存，离开页面不丢失）
const AI_CACHE_KEY = 'sinan_ai_text'
function loadAiCache(c: string) {
  try {
    const m = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}')
    return m[c] || ''
  } catch { return '' }
}
function saveAiCache(c: string, t: string) {
  try {
    const m = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || '{}')
    m[c] = t
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(m))
  } catch { /* quota */ }
}
// 挂载时恢复缓存
aiText.value = loadAiCache(code)

async function runAi() {
  if (!detail.value) return
  aiErr.value = ''; aiText.value = ''; aiLoading.value = true
  try {
    const text = await llmInterpret(detail.value, score.value, signal.value, bt.value)
    aiText.value = text
    saveAiCache(code, text)
  } catch (e) {
    aiErr.value = e instanceof Error ? e.message : 'AI 解读失败'
  } finally {
    aiLoading.value = false
  }
}
function saveCfg() {
  aiCfg.value.apiKey = aiCfg.value.apiKey.trim()
  setAiConfig(aiCfg.value)
  aiReady.value = hasAiKey()
  showToast(aiReady.value ? '已保存 AI 配置' : '已清空')
}

// 同类更优（V3-7）：按需加载排行数据，避免详情页自动拉大文件
const similar = ref<ScreenFund[]>([])
const simLoading = ref(false)
const simDone = ref(false)
async function loadSimilar() {
  if (simDone.value || simLoading.value || !detail.value) return
  simLoading.value = true
  try {
    similar.value = await findSimilar(detail.value.type, code, detail.value.ret_1y)
  } catch { /* 无排行数据 */ } finally {
    simLoading.value = false; simDone.value = true
  }
}

onMounted(async () => {
  watch.load().catch(() => {})
  // 盘中估值独立于后端，立即并发抓取（不阻塞详情）
  fetchEstimate(code).then((e) => { est.value = e }).finally(() => { estDone.value = true })
  getHoldings(code).then((h) => { holdings.value = h }).finally(() => { holdingsDone.value = true })
  try {
    const a = await funds.analyze(code)
    detail.value = a.detail
    score.value = a.score
    signal.value = a.signal
    bt.value = a.backtest
  } catch {
    error.value = '加载失败，后端是否已启动？'
  } finally {
    loading.value = false
  }
})

const btOption = computed(() => {
  const s = bt.value?.strategy?.curve || []
  const b = bt.value?.benchmark?.curve || []
  return {
    grid: { left: 36, right: 12, top: 30, bottom: 20 },
    tooltip: { trigger: 'axis' as const },
    legend: { top: 0, data: ['择时策略', '一直持有'], textStyle: { fontSize: 11 } },
    xAxis: { type: 'category' as const, data: s.map((p) => p.date), boundaryGap: false, axisLabel: { show: false } },
    yAxis: { type: 'value' as const, scale: true },
    series: [
      { name: '择时策略', type: 'line' as const, showSymbol: false, data: s.map((p) => p.v), lineStyle: { color: '#4C7E67' } },
      { name: '一直持有', type: 'line' as const, showSymbol: false, data: b.map((p) => p.v), lineStyle: { color: '#5A6A60' } },
    ],
  }
})

const navOption = computed(() => {
  const h = detail.value?.nav_history || []
  return {
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis' as const },
    xAxis: { type: 'category' as const, data: h.map((p) => p.date), boundaryGap: false },
    yAxis: { type: 'value' as const, scale: true },
    series: [{
      type: 'line' as const, data: h.map((p) => p.nav), showSymbol: false,
      lineStyle: { color: '#4C7E67' }, areaStyle: { color: 'rgba(76,126,103,0.08)' },
    }],
  }
})

async function toggleWatch() {
  try {
    await watch.toggle(code, detail.value?.name)
    showToast(watch.has(code) ? '已加入自选' : '已移出自选')
  } catch {
    showToast('操作失败')
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar :title="detail?.name || '基金详情'" left-arrow @click-left="router.back()">
      <template #right>
        <van-icon :name="watch.has(code) ? 'star' : 'star-o'"
          :color="watch.has(code) ? '#C8A75B' : ''" size="20" @click="toggleWatch" />
      </template>
    </van-nav-bar>
    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="error" :description="error" />
      <template v-else-if="detail">
        <div class="est card">
          <div class="est-head">
            <span class="est-label">盘中估值</span>
            <span class="est-time">{{ est?.estTime || (estDone ? '' : '加载中…') }}</span>
          </div>
          <div class="est-main" v-if="est && est.estChange != null">
            <div class="est-chg" :style="{ color: colorOf(est.estChange) }">{{ pct(est.estChange) }}</div>
            <div class="est-side">
              <div>估算净值 <b>{{ num(est.estNav) }}</b></div>
              <div>昨净值 <b>{{ num(est.lastNav) }}</b><em v-if="est.navDate"> @{{ est.navDate }}</em></div>
            </div>
          </div>
          <div class="est-empty" v-else-if="estDone">暂无盘中估值（QDII/货币基金或非交易时段），以最新净值为准。</div>
          <van-loading v-else size="18" style="padding:6px 0" />
        </div>

        <van-button class="report-btn" block plain icon="description" size="small"
          @click="router.push('/report/' + code)">生成体检报告</van-button>

        <div class="sec">智能解读</div>
        <div class="card interp" v-if="interp">
          <div class="verdict" :class="interp.tone">{{ interp.verdict }}</div>
          <div v-if="aiText" class="ai-box">
            <div class="ai-tag">AI 解读 · {{ curDef.label }}</div>
            <div class="ai-text">{{ aiText }}</div>
          </div>
          <div class="isec" v-for="(x, i) in interp.sections" :key="i">
            <span class="ih">{{ x.h }}</span><span class="it">{{ x.t }}</span>
          </div>
          <div v-if="aiErr" class="ai-err">{{ aiErr }}</div>
          <div class="ai-bar">
            <van-button size="mini" plain type="primary" :loading="aiLoading"
              @click="aiReady ? runAi() : (cfgShow = true)">
              {{ aiReady ? (aiText ? '重新生成' : 'AI 生成解读') : '配置 AI' }}
            </van-button>
            <van-icon v-if="aiReady" name="setting-o" size="17" color="#A8B2A8" @click="cfgShow = true" />
            <span v-if="aiReady" class="ai-prov">{{ curDef.label }}</span>
          </div>
          <div class="ai-hint">上为规则解读，免费离线。配置 AI（DeepSeek / 通义 / OpenAI / Claude… 自带 Key）可生成更自然的点评（按量计费）。</div>
          <div v-if="!aiText" class="disc">以上为数据解读，仅供个人参考，不构成投资建议。</div>
        </div>

        <van-cell-group inset>
          <van-cell title="代码" :value="detail.code" />
          <van-cell title="类型" :value="detail.type || '--'" />
          <van-cell title="最新净值"
            :value="num(detail.latest_nav) + (detail.latest_nav_date ? ' @' + detail.latest_nav_date : '')" />
          <van-cell title="规模" :value="detail.scale != null ? detail.scale + ' 亿' : '--'" />
          <van-cell title="经理"
            :value="(detail.manager || '--') + (detail.manager_worktime ? ' · ' + detail.manager_worktime : '')" />
        </van-cell-group>

        <div class="sec">收益</div>
        <div class="grid4">
          <div><div class="k">近1月</div><div class="v" :style="{ color: colorOf(detail.ret_1m) }">{{ pct(detail.ret_1m) }}</div></div>
          <div><div class="k">近6月</div><div class="v" :style="{ color: colorOf(detail.ret_6m) }">{{ pct(detail.ret_6m) }}</div></div>
          <div><div class="k">近1年</div><div class="v" :style="{ color: colorOf(detail.ret_1y) }">{{ pct(detail.ret_1y) }}</div></div>
          <div><div class="k">近3年</div><div class="v" :style="{ color: colorOf(detail.ret_3y) }">{{ pct(detail.ret_3y) }}</div></div>
        </div>

        <div class="sec">净值走势</div>
        <div class="card"><Chart :option="navOption" height="220px" /></div>

        <div class="sec">十大重仓股</div>
        <div class="card" v-if="holdings.length">
          <div class="hd" v-for="(s, i) in holdings" :key="s.code + i">
            <span class="hd-rk">{{ i + 1 }}</span>
            <span class="hd-nm">{{ s.name }}<em>{{ s.code }}</em></span>
            <span class="hd-bar"><i :style="{ width: (s.ratio / holdMax * 100) + '%' }"></i></span>
            <span class="hd-rt">{{ s.ratio.toFixed(2) }}%</span>
            <span class="hd-ch" :style="{ color: colorOf(s.change) }">{{ s.change != null ? pct(s.change) : '--' }}</span>
          </div>
          <div class="hd-note">条形为占净值比例，右侧为个股当日涨跌。重仓股季度披露，数据来源天天基金。</div>
        </div>
        <div class="card" v-else-if="holdingsDone"><van-empty description="暂无重仓股（QDII/债基/货基常无）" image-size="60" /></div>
        <van-loading v-else size="18" style="display:block;text-align:center;padding:14px" />

        <div class="sec">定投测算</div>
        <div class="card">
          <DcaCalc :nav-history="detail.nav_history" :latest-nav="detail.latest_nav" />
        </div>

        <template v-if="score">
          <div class="sec">综合评分</div>
          <div class="card">
            <div class="scorehead">
              <div class="bigscore">{{ score.score ?? '--' }}</div>
              <div>
                <StarRating :star="score.star" />
                <div class="rank" v-if="score.rank_in_type">同类 {{ score.rank_in_type }}/{{ score.rank_total }}</div>
              </div>
            </div>
            <div class="comp" v-for="(c, k) in score.components" :key="k">
              <span class="cn">{{ COMP_NAMES[k] }} <em>{{ c.weight * 100 }}%</em></span>
              <van-progress :percentage="Math.round(c.score ?? 0)" :show-pivot="false"
                color="#4C7E67" track-color="#EEF1EC" style="flex:1;margin:0 10px" />
              <span class="cv">{{ c.score ?? '--' }}</span>
            </div>
          </div>
        </template>

        <div class="sec">同类更优</div>
        <div class="card">
          <van-button v-if="!simDone" size="small" block plain icon="bar-chart-o" :loading="simLoading"
            @click="loadSimilar">查看同类近1年更优的基金</van-button>
          <template v-else-if="similar.length">
            <div class="sim" v-for="f in similar" :key="f.c" @click="router.push('/fund/' + f.c)">
              <span class="sim-nm">{{ f.n }}<em>{{ f.c }}</em></span>
              <span class="sim-r" :style="{ color: colorOf(f.r1y) }">{{ pct(f.r1y) }}</span>
              <span class="sim-fee">费 {{ f.fee != null ? f.fee + '%' : '--' }}</span>
            </div>
            <div class="sim-note">同类型中近1年收益高于本基金者（数据来自选基排行）。</div>
          </template>
          <van-empty v-else description="本基金已属同类前列，或暂无排行数据" image-size="50" />
        </div>

        <template v-if="bt">
          <div class="sec">策略回测</div>
          <div class="card" v-if="bt.available && bt.strategy && bt.benchmark">
            <div class="bt-row">
              <div><div class="k">择时策略</div><div class="v" :style="{ color: colorOf(bt.strategy.total_return) }">{{ pct(bt.strategy.total_return) }}</div><div class="kk">回撤 {{ bt.strategy.max_drawdown }}%</div></div>
              <div><div class="k">一直持有</div><div class="v" :style="{ color: colorOf(bt.benchmark.total_return) }">{{ pct(bt.benchmark.total_return) }}</div><div class="kk">回撤 {{ bt.benchmark.max_drawdown }}%</div></div>
              <div><div class="k">超额/胜率</div><div class="v" :style="{ color: colorOf(bt.outperform ?? 0) }">{{ pct(bt.outperform ?? 0) }}</div><div class="kk">胜率 {{ bt.win_rate }}%</div></div>
            </div>
            <Chart :option="btOption" height="200px" />
            <div class="bt-note">{{ bt.start }} ~ {{ bt.end }} · 月度调仓 {{ bt.rebalances }} 次。简化回测、不计费用，仅供参考。</div>
          </div>
          <div class="card" v-else><van-empty :description="bt.reason || '无法回测'" image-size="60" /></div>
        </template>

        <template v-if="signal">
          <div class="sec">当前信号</div>
          <div class="card">
            <div class="sighead">
              <span class="stamp sig-stamp"
                :class="signal.signal === '买入' ? 'stamp-buy' : signal.signal === '减仓' ? 'stamp-sell' : 'stamp-hold'"
                :style="{ color: signalColor(signal.signal) }">{{ signal.signal }}</span>
              <span class="advice">{{ signal.advice }}</span>
            </div>
            <van-cell-group>
              <van-cell title="估值"
                :value="signal.layers.valuation.label + (signal.layers.valuation.percentile != null ? ' · 分位 ' + signal.layers.valuation.percentile : '')" />
              <van-cell title="趋势" :value="signal.layers.trend.label" />
              <van-cell title="情绪"
                :value="signal.layers.sentiment.label + (signal.layers.sentiment.rsi != null ? ' · RSI ' + signal.layers.sentiment.rsi : '')" />
            </van-cell-group>
            <div class="sig-disc">
              {{ signal.disclaimer || '择时信号仅为风险 / 时机参考，非买卖指令。' }}
              <template v-if="bt && bt.available && bt.strategy && bt.benchmark">
                本基金回测：择时 {{ pct(bt.strategy.total_return) }} vs 一直持有 {{ pct(bt.benchmark.total_return) }}
                <em :style="{ color: colorOf((bt.outperform ?? 0)) }">（{{ (bt.outperform ?? 0) >= 0 ? '择时跑赢' : '择时跑输' }} {{ Math.abs(bt.outperform ?? 0).toFixed(2) }}%）</em>。
                优质基金长期持有 / 定投通常更优，勿据此轻易卖出。
              </template>
            </div>
          </div>
        </template>
      </template>
    </div>

    <van-dialog v-model:show="cfgShow" title="AI 配置" show-cancel-button @confirm="saveCfg">
      <div style="padding:10px 14px">
        <div class="prov-chips">
          <span v-for="p in PROVIDERS" :key="p.id" :class="['pchip', { on: aiCfg.provider === p.id }]"
            @click="aiCfg.provider = p.id">{{ p.label }}</span>
        </div>
        <van-field v-model="aiCfg.apiKey" type="password" label="Key" :placeholder="curDef.keyHint" />
        <van-field v-model="aiCfg.baseUrl" label="Base URL" :placeholder="curDef.baseUrl || '必填'" />
        <van-field v-model="aiCfg.model" label="模型" :placeholder="curDef.model || '必填'" />
        <div class="kd-hint">Key 仅存本机浏览器，浏览器直连该服务商按量计费。Base URL / 模型留空用默认值。<a v-if="curDef.getKeyUrl" :href="curDef.getKeyUrl" target="_blank" rel="noopener">获取 {{ curDef.label }} Key</a></div>
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.sec { font-size: 13px; color: var(--text-muted); margin: 18px 4px 8px; }
.card { background: var(--card-bg); border-radius: var(--radius-lg); padding: 12px; border: 1px solid var(--border); box-shadow: var(--shadow-sm); }
.est { margin: 0 0 4px; }
.est-head { display: flex; justify-content: space-between; align-items: center; }
.est-label { font-size: 13px; color: #5A6A60; font-weight: 500; }
.est-time { font-size: 11px; color: #A8B2A8; }
.est-main { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.est-chg { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.est-side { text-align: right; font-size: 12px; color: #5A6A60; line-height: 1.7; }
.est-side b { color: #1F2C24; font-weight: 600; }
.est-side em { font-style: normal; color: #A8B2A8; }
.est-empty { font-size: 12px; color: #5A6A60; margin-top: 6px; line-height: 1.5; }
.report-btn { margin-top: 10px; }
.hd { display: flex; align-items: center; font-size: 12px; margin: 9px 0; }
.hd-rk { width: 18px; color: #A8B2A8; font-variant-numeric: tabular-nums; }
.hd-nm { width: 96px; color: #1F2C24; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hd-nm em { font-style: normal; color: #A8B2A8; font-size: 10px; margin-left: 4px; }
.hd-bar { flex: 1; height: 6px; background: #EEF1EC; border-radius: 3px; margin: 0 8px; overflow: hidden; }
.hd-bar i { display: block; height: 100%; background: #4C7E67; border-radius: 3px; }
.hd-rt { width: 44px; text-align: right; color: #5A6A60; font-variant-numeric: tabular-nums; }
.hd-ch { width: 56px; text-align: right; font-variant-numeric: tabular-nums; }
.hd-note { font-size: 11px; color: #A8B2A8; margin-top: 8px; line-height: 1.5; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); background: #fff; border-radius: 10px; padding: 12px 0; }
.grid4 .k { font-size: 11px; color: #5A6A60; text-align: center; }
.grid4 .v { font-size: 14px; font-weight: 500; text-align: center; margin-top: 4px; }
.scorehead { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.bigscore { font-size: 34px; font-weight: 600; color: #4C7E67; }
.rank { font-size: 11px; color: #5A6A60; margin-top: 2px; }
.comp { display: flex; align-items: center; font-size: 12px; margin: 8px 0; }
.comp .cn { width: 64px; color: #5A6A60; }
.comp .cn em { color: #A8B2A8; font-style: normal; font-size: 10px; }
.comp .cv { width: 34px; text-align: right; color: #1F2C24; }
.bt-row { display: grid; grid-template-columns: repeat(3, 1fr); margin-bottom: 8px; }
.bt-row .k { font-size: 11px; color: #5A6A60; }
.bt-row .v { font-size: 17px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.bt-row .kk { font-size: 10px; color: #A8B2A8; margin-top: 1px; }
.bt-note { font-size: 11px; color: #A8B2A8; margin-top: 6px; line-height: 1.5; }
.sighead { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
/* 信号印章 */
.sig-stamp {
  width: 56px; height: 56px;
  font-size: 16px;
  letter-spacing: 1px;
  font-family: 'Noto Serif SC', 'PingFang SC', serif;
  flex-shrink: 0;
}
.advice { font-size: 12px; color: #5A6A60; }
.sig-disc { font-size: 11px; color: #5A6A60; line-height: 1.6; margin-top: 10px; padding: 8px 10px; background: var(--bg-soft, #F2F6F1); border-radius: 8px; }
.sig-disc em { font-style: normal; }
.interp .verdict { font-size: 14px; font-weight: 600; line-height: 1.5; margin-bottom: 10px; }
.interp .verdict.good { color: #C44536; }
.interp .verdict.weak { color: #3D8B63; }
.interp .verdict.mid { color: #1F2C24; }
.ai-box { background: #F0F5F2; border: 1px solid #D9E7DE; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.ai-tag { font-size: 11px; color: #4C7E67; font-weight: 600; margin-bottom: 4px; }
.ai-text { font-size: 13px; color: #1F2C24; line-height: 1.7; white-space: pre-wrap; }
.isec { font-size: 12.5px; line-height: 1.7; margin: 6px 0; color: #5A6A60; }
.isec .ih { display: inline-block; color: #4C7E67; font-weight: 600; margin-right: 6px; }
.ai-err { font-size: 12px; color: #C44536; margin: 8px 0 0; }
.ai-bar { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.ai-hint { font-size: 11px; color: #A8B2A8; line-height: 1.5; margin-top: 6px; }
.disc { font-size: 11px; color: #A8B2A8; margin-top: 8px; }
.kd-hint { font-size: 11px; color: #5A6A60; line-height: 1.6; margin-top: 8px; }
.kd-hint a { color: #4C7E67; }
.ai-prov { font-size: 11px; color: #5A6A60; }
.prov-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.prov-chips .pchip { font-size: 12px; color: #5A6A60; background: #F2F3EF; border-radius: 12px; padding: 3px 10px; }
.prov-chips .pchip.on { color: #fff; background: #4C7E67; }
.sim { display: flex; align-items: center; font-size: 12px; padding: 8px 0; border-bottom: 0.5px solid #F2F3EF; }
.sim:last-of-type { border-bottom: none; }
.sim-nm { flex: 1; color: #1F2C24; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sim-nm em { font-style: normal; color: #A8B2A8; font-size: 10px; margin-left: 4px; }
.sim-r { width: 70px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.sim-fee { width: 64px; text-align: right; color: #5A6A60; }
.sim-note { font-size: 11px; color: #A8B2A8; margin-top: 8px; line-height: 1.5; }
</style>
