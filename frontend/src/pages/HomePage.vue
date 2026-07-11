<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getHealth } from '@/api/client'
import { useAppStore } from '@/stores/app'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import IndexBar from '@/components/IndexBar.vue'
import { checkBackend, getSourceSummary, type SourceStatus } from '@/utils/resilience'
import { fetchTaskStatuses, type TaskStatus } from '@/utils/taskStatus'
import { loadAlerts, runAllChecks, markRead, markAllRead, dismissAlert, requestNotifyPermission, type Alert } from '@/utils/alerts'
import { APP_VERSION } from '@/version'
import { combineTemperature, sourceFreshness, visibleUnreadAlerts } from '@/utils/presentation'
import { fetchEstimates } from '@/utils/estimate'
import type { SignalResp } from '@/api/client'
import { temperatureLabel, TEMPERATURE_DEFINITION } from '@/utils/terminology'

const app = useAppStore()
const watch = useWatchlistStore()
const funds = useFundsStore()
const backendOk = ref<boolean | null>(null)
const healthText = ref('检查中')
const sources = ref<SourceStatus[]>([])
const tasks = ref<TaskStatus[]>([])
const taskLoading = ref(false)
const sigs = ref<Record<string, string>>({})
const alerts = ref<Alert[]>(loadAlerts())
const refreshing = ref(false)
const SIGNAL_SNAPSHOT_KEY = 'sinan_signal_snapshot_v1'

function loadSignalSnapshot(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SIGNAL_SNAPSHOT_KEY) || '{}') }
  catch { return {} }
}

// 温度统一表示“拥挤/回撤风险”：越高越热。偏多动作对应较低温，减仓信号对应高温。
const SIG_WEIGHT: Record<string, number> = { 买入: 20, 定投: 40, 持有: 55, 减仓: 85, 观察: 50 }

const watchTemp = computed(() => {
  const values = Object.values(sigs.value)
  return values.length
    ? Math.round(values.reduce((sum, signal) => sum + (SIG_WEIGHT[signal] ?? 45), 0) / values.length)
    : null
})

const dist = computed(() => {
  const result: Record<string, number> = { 买入: 0, 定投: 0, 持有: 0, 减仓: 0 }
  Object.values(sigs.value).forEach((signal) => { if (signal in result) result[signal]++ })
  return result
})

const combinedTemp = computed(() => {
  return combineTemperature(app.marketTemp?.status === 'unavailable' ? null : app.marketTemp?.score, watchTemp.value)
})

const tempLabel = computed(() => {
  return temperatureLabel(combinedTemp.value)
})

const tempTone = computed(() => {
  const score = combinedTemp.value ?? 50
  return score <= 40 ? 'cool' : score <= 60 ? 'calm' : score <= 80 ? 'warm' : 'hot'
})

const visibleAlerts = computed(() => visibleUnreadAlerts(alerts.value))

type Light = 'green' | 'yellow' | 'red'
const statusLights = computed<{ label: string; state: Light; text: string; detail: string }[]>(() => {
  const failedSources = sources.value.filter((source) => !source.ok)
  const expiredSources = sources.value.filter((source) => sourceFreshness(source) === 'expired')
  const staleSources = sources.value.filter((source) => sourceFreshness(source) === 'stale')
  const sourceState: Light = !sources.value.length || staleSources.length
    ? 'yellow'
    : expiredSources.length === sources.value.length ? 'red' : expiredSources.length ? 'yellow' : 'green'
  const failedTasks = tasks.value.filter((task) => !task.ok)
  const taskState: Light = taskLoading.value || !tasks.value.length ? 'yellow' : failedTasks.some((task) => !task.stale) ? 'red' : failedTasks.length ? 'yellow' : 'green'
  return [
    { label: '服务', state: backendOk.value == null ? 'yellow' : backendOk.value ? 'green' : 'red', text: backendOk.value ? '正常' : backendOk.value == null ? '检查中' : '异常', detail: healthText.value },
    { label: '数据', state: sourceState, text: sourceState === 'green' ? '正常' : sourceState === 'yellow' ? '降级' : '异常', detail: [...new Set([...failedSources, ...staleSources, ...expiredSources])].map((source) => source.label).join('、') || '公开数据源正常' },
    { label: '任务', state: taskState, text: taskState === 'green' ? '正常' : taskState === 'yellow' ? '延迟' : '异常', detail: failedTasks.map((task) => task.label).join('、') || '定时任务正常' },
  ]
})

async function loadWatchSignals() {
  const previous = loadSignalSnapshot()
  const current: Record<string, SignalResp> = {}
  try {
    await watch.load(false)
    await Promise.all(watch.items.map(async (item) => {
      try {
        const signal = await funds.signal(item.code)
        current[item.code] = signal
        sigs.value[item.code] = signal.signal
      } catch { /* skip */ }
    }))
  } catch { /* skip */ }

  try { localStorage.setItem(SIGNAL_SNAPSHOT_KEY, JSON.stringify(sigs.value)) } catch { /* ignore */ }
  const estimates = await fetchEstimates(watch.items.map((item) => item.code))

  requestNotifyPermission()
  runAllChecks(watch.items.map((item) => ({
    code: item.code,
    name: item.name || item.code,
    prevSignal: previous[item.code],
    currentSignal: current[item.code],
    estimate: estimates.get(item.code) ?? null,
  }))).then((newAlerts) => {
    if (newAlerts.length) alerts.value = loadAlerts()
  })
}

async function refreshHome() {
  backendOk.value = await checkBackend()
  sources.value = getSourceSummary()
  if (backendOk.value) {
    await getHealth()
      .then((result) => { healthText.value = `API ${result.version}` })
      .catch(() => { healthText.value = '服务响应异常' })
  } else {
    healthText.value = '后端未连接'
  }
  await app.loadMarketTemp()
  await loadWatchSignals()
  sources.value = getSourceSummary()
  taskLoading.value = true
  try { tasks.value = await fetchTaskStatuses(true) } catch { tasks.value = [] }
  finally { taskLoading.value = false; refreshing.value = false }
}

function onMarkAllRead() {
  markAllRead()
  alerts.value = loadAlerts()
}

function onMarkOne(id: string) {
  markRead(id)
  alerts.value = loadAlerts()
}

function onDismiss(id: string) {
  dismissAlert(id)
  alerts.value = loadAlerts()
}

const levelMark = (level: Alert['level']) => level === 'danger' ? '!' : level === 'warn' ? '!' : 'i'

onMounted(refreshHome)
</script>

<template>
  <div class="page home-page">
    <van-nav-bar class="brand-nav">
      <template #title>
        <div class="brand-title">
          <strong>司南基金</strong>
          <span>v{{ APP_VERSION }}</span>
        </div>
      </template>
    </van-nav-bar>
    <IndexBar />

    <van-pull-refresh v-model="refreshing" @refresh="refreshHome">
      <div class="page-body">
        <div class="sec">市场与持仓温度</div>
        <section class="card climate-card" :title="TEMPERATURE_DEFINITION" @click="app.loadMarketTemp()">
          <div class="climate-head">
            <div class="climate-score" :class="tempTone">
              <strong>{{ combinedTemp ?? '—' }}</strong><span>/100</span>
            </div>
            <div class="climate-stamp" :class="tempTone">{{ tempLabel }}</div>
          </div>
          <div class="gauge-track"><i :class="tempTone" :style="{ width: (combinedTemp ?? 50) + '%' }"></i></div>
          <div class="climate-grid">
            <div><span>市场</span><b>{{ app.marketTemp?.status === 'unavailable' ? '—' : app.marketTemp?.score ?? '—' }}</b><em>{{ app.marketTemp?.label || '计算中' }}</em></div>
            <div><span>自选</span><b>{{ watchTemp ?? '—' }}</b><em>{{ watch.items.length }} 只基金</em></div>
          </div>
          <div class="signal-strip" v-if="watchTemp != null">
            <span class="buy">买入 {{ dist['买入'] }}</span>
            <span class="dca">定投 {{ dist['定投'] }}</span>
            <span class="hold">持有 {{ dist['持有'] }}</span>
            <span class="reduce">减仓 {{ dist['减仓'] }}</span>
          </div>
          <div class="source-lines" v-if="app.marketTemp?.sources?.length">
            <div v-for="source in app.marketTemp.sources.slice(0, 3)" :key="source.label">
              <i :style="{ background: source.color }"></i>
              <span>{{ source.label }}</span><b>{{ source.value }}</b><em>{{ source.detail }}</em>
            </div>
          </div>
          <div class="updated" v-if="app.marketTemp?.updated">
            {{ app.marketTemp.status === 'stale' ? '旧数据 · ' : app.marketTemp.status === 'unavailable' ? '数据不可用 · ' : '' }}{{ new Date(app.marketTemp.updated).toLocaleString('zh-CN') }}
          </div>
        </section>

        <template v-if="visibleAlerts.length">
          <div class="sec alert-title"><span>持仓提醒 <b>{{ visibleAlerts.length }}</b></span><button @click="onMarkAllRead">全部已读</button></div>
          <section class="card alert-card">
            <article v-for="alert in visibleAlerts" :key="alert.id" class="alert-item" @click="onMarkOne(alert.id)">
              <span class="alert-mark" :class="alert.level">{{ levelMark(alert.level) }}</span>
              <div><b>{{ alert.title }}</b><p>{{ alert.body }}</p><time>{{ new Date(alert.time).toLocaleString('zh-CN') }}</time></div>
              <button aria-label="关闭提醒" @click.stop="onDismiss(alert.id)">×</button>
            </article>
          </section>
        </template>

        <div class="sec">系统状态</div>
        <section class="card status-card">
          <div v-for="light in statusLights" :key="light.label" class="status-item" :title="light.detail">
            <i :class="light.state"></i><div><b>{{ light.label }}</b><span>{{ light.text }}</span></div>
          </div>
        </section>
      </div>
    </van-pull-refresh>
  </div>
</template>

<style scoped>
.brand-title { text-align: center; line-height: 1.15; }
.brand-title strong { display: block; color: var(--ink); font-family: var(--font-display); font-size: 19px; font-weight: 700; }
.brand-title span { display: block; color: var(--text-hint); font-family: var(--font-mono); font-size: 9px; margin-top: 3px; }
.climate-card { cursor: pointer; }
.climate-head { display: flex; align-items: center; justify-content: space-between; }
.climate-score { display: flex; align-items: baseline; gap: 6px; }
.climate-score strong { font-family: var(--font-mono); font-size: 48px; font-weight: 500; line-height: 1; }
.climate-score span { color: var(--text-hint); font-family: var(--font-mono); font-size: 12px; }
.climate-score.cool strong { color: var(--teal-deep); }
.climate-score.calm strong { color: var(--ink); }
.climate-score.warm strong { color: var(--gold); }
.climate-score.hot strong { color: var(--danger); }
.climate-stamp { width: 54px; height: 54px; display: grid; place-items: center; border: 2px solid currentColor; border-radius: 7px; font-size: 13px; transform: rotate(-3deg); }
.climate-stamp.cool { color: var(--teal); }.climate-stamp.calm { color: var(--ink-muted); }.climate-stamp.warm { color: var(--gold); }.climate-stamp.hot { color: var(--danger); }
.gauge-track { height: 8px; overflow: hidden; margin: 16px 0; background: var(--chip-bg); border-radius: 4px; }
.gauge-track i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--teal-deep), var(--teal), var(--teal-light), var(--gold)); transition: width .35s ease; }
.climate-grid { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.climate-grid > div { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 10px 12px; }
.climate-grid > div + div { border-left: 1px solid var(--border); }
.climate-grid span, .climate-grid em { color: var(--text-hint); font-size: 10px; font-style: normal; }
.climate-grid b { color: var(--ink); font-family: var(--font-mono); font-size: 16px; font-weight: 500; grid-row: span 2; align-self: center; }
.signal-strip { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.signal-strip span { padding: 4px 9px; border-radius: 12px; font-size: 11px; }
.signal-strip .buy { color: var(--danger); background: var(--danger-soft); }.signal-strip .dca { color: var(--gold); background: var(--gold-soft); }.signal-strip .hold { color: var(--ink-muted); background: var(--chip-bg); }.signal-strip .reduce { color: var(--success); background: var(--success-soft); }
.source-lines { display: grid; gap: 8px; margin-top: 14px; }
.source-lines > div { display: grid; grid-template-columns: 6px 76px 28px 1fr; gap: 7px; align-items: center; font-size: 11px; }
.source-lines i { width: 6px; height: 6px; border-radius: 50%; }.source-lines span { color: var(--text-secondary); }.source-lines b { color: var(--ink); font-family: var(--font-mono); }.source-lines em { min-width: 0; overflow: hidden; color: var(--text-hint); font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.updated { color: var(--text-hint); font-family: var(--font-mono); font-size: 9px; margin-top: 12px; }
.alert-title { display: flex; justify-content: space-between; align-items: center; }.alert-title b { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; margin-left: 4px; color: #fff; background: var(--danger); border-radius: 9px; font-family: var(--font-mono); font-size: 10px; }.alert-title button { border: 0; color: var(--teal); background: transparent; font-size: 11px; cursor: pointer; }
.alert-card { padding: 2px 14px; }
.alert-item { display: grid; grid-template-columns: 22px 1fr 24px; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--border); cursor: pointer; }.alert-item:last-child { border-bottom: 0; }.alert-item > div { min-width: 0; }.alert-item b { color: var(--ink); font-size: 12px; }.alert-item p { margin: 3px 0; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }.alert-item time { color: var(--text-hint); font-family: var(--font-mono); font-size: 9px; }.alert-item > button { align-self: start; border: 0; color: var(--text-hint); background: transparent; font-size: 17px; cursor: pointer; }
.alert-mark { width: 18px; height: 18px; display: grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; font-family: var(--font-mono); font-size: 10px; }.alert-mark.info { color: var(--teal); }.alert-mark.warn { color: var(--gold); }.alert-mark.danger { color: var(--danger); }
.status-card { display: grid; grid-template-columns: repeat(3, 1fr); padding: 14px 10px; }
.status-item { display: flex; align-items: center; justify-content: center; gap: 8px; min-width: 0; }.status-item + .status-item { border-left: 1px solid var(--border); }.status-item > i { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 50%; box-shadow: 0 0 0 3px var(--chip-bg); }.status-item > i.green { background: var(--success); }.status-item > i.yellow { background: var(--gold); }.status-item > i.red { background: var(--danger); }.status-item b, .status-item span { display: block; }.status-item b { color: var(--ink); font-size: 11px; }.status-item span { color: var(--text-hint); font-size: 9px; margin-top: 2px; }
@media (min-width: 900px) { .home-page .page-body { max-width: 760px; } }
</style>
