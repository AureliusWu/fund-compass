<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  getHealth,
  normalizeWorkerRuntime,
  type Health,
  type WorkerCronReason,
  type WorkerCronResult,
  type WorkerHealth,
} from '@/api/client'
import { fetchTaskStatuses, type TaskStatus } from '@/utils/taskStatus'

const backend = ref<Health | null>(null)
const worker = ref<WorkerHealth | null>(null)
const tasks = ref<TaskStatus[]>([])
const error = ref('')
const WORKER_HEALTH = (import.meta.env.VITE_WORKER_HEALTH as string) || 'https://sinan-estimate-push.ligugu69.workers.dev/health'
const text = (value: unknown) => value == null || value === '' ? '暂无记录' : String(value)

const CRON_RESULT_LABELS: Record<WorkerCronResult, string> = {
  sent: '已发送',
  sent_with_warning: '已发送（有警示）',
  skipped: '已跳过',
  failed: '失败',
}
const CRON_REASON_LABELS: Record<WorkerCronReason, string> = {
  weekend: '非交易日',
  empty_watchlist: '自选为空',
  already_sent: '今日已发送',
  no_fresh_estimate: '无新鲜估值',
  official_nav_only: '仅有正式净值',
  no_publishable_intraday: '无可发布盘中估值',
  notification_already_claimed: '通知已被其他运行领取',
}

const normalizedWorkerRuntime = computed(() => normalizeWorkerRuntime(worker.value?.runtime))
const lastCronAt = computed(() => normalizedWorkerRuntime.value.lastCronAt)
const lastCronResult = computed(() => normalizedWorkerRuntime.value.lastCronResult)
const lastAttemptAt = computed(() => normalizedWorkerRuntime.value.lastAttemptAt)
const legacyCronContract = computed(() => normalizedWorkerRuntime.value.legacyCronContract)
const cronResultText = computed(() => {
  const result = lastCronResult.value
  if (!result) return '暂无自然调度记录'
  return result === 'not_sent' ? '尚未发送' : CRON_RESULT_LABELS[result] ?? result
})
const cronReasonText = computed(() => {
  const runtime = normalizedWorkerRuntime.value
  if (legacyCronContract.value) return '兼容旧 Worker 字段'
  const reason = runtime.lastCronReason
  if (reason) return CRON_REASON_LABELS[reason] ?? reason
  if (runtime.lastCronResult === 'failed') return '详情见最近错误'
  if (runtime.lastCronResult === 'sent_with_warning') return '详情见最近警示'
  return ''
})

async function load() {
  error.value = ''
  const results = await Promise.allSettled([
    getHealth(),
    fetch(WORKER_HEALTH, { signal: AbortSignal.timeout(8000) }).then((response) => {
      if (!response.ok) throw new Error(`Worker HTTP ${response.status}`)
      return response.json() as Promise<WorkerHealth>
    }),
    fetchTaskStatuses(true),
  ])
  if (results[0].status === 'fulfilled') backend.value = results[0].value
  if (results[1].status === 'fulfilled') worker.value = results[1].value
  if (results[2].status === 'fulfilled') tasks.value = results[2].value
  if (results.some((result) => result.status === 'rejected')) error.value = '部分状态暂不可用，主要基金功能不受影响'
}
onMounted(load)
</script>

<template>
  <div class="page operations-page">
    <van-nav-bar title="运行状态" left-arrow @click-left="$router.back()" />
    <div class="page-body">
      <div v-if="error" class="notice">{{ error }}</div>
      <div class="sec">后端与数据</div>
      <section class="status-band">
        <div><span>API</span><b>{{ backend?.status || '不可用' }}</b><em>{{ backend?.version || '—' }}</em></div>
        <div><span>启动时间</span><b>{{ text(backend?.started_at) }}</b></div>
        <div><span>基金全集</span><b>{{ backend?.universe ?? '—' }}</b><em>{{ text(backend?.operations?.universe_artifact?.generated_at) }}</em></div>
        <div><span>指数估值</span><b :class="{ bad: backend?.index_valuation?.usable === false }">{{ backend?.index_valuation ? (backend.index_valuation.usable ? '可用' : '已降级') : '未报告' }}</b><em>{{ text(backend?.index_valuation?.updated) }} · {{ backend?.index_valuation?.age_days ?? '—' }} 天</em></div>
        <div><span>数据库</span><b :class="{ bad: backend?.database?.durable === false }">{{ backend?.database ? (backend.database.durable ? '持久盘' : '临时存储') : '未报告' }}</b><em>{{ backend?.database?.warning || backend?.database?.persistence || '未报告' }}</em></div>
        <div><span>缓存命中率</span><b>{{ backend?.operations?.cache?.hit_rate ?? '—' }}%</b><em>最旧 {{ backend?.operations?.cache?.oldest_age_hours ?? '—' }} 小时</em></div>
        <div><span>最近决策</span><b>{{ text(backend?.operations?.latest_decision_write) }}</b></div>
        <div><span>最近结算</span><b>{{ text(backend?.operations?.latest_result_settlement) }}</b></div>
      </section>
      <div class="sec">推送 Worker</div>
      <section class="status-band">
        <div><span>服务状态</span><b>{{ worker?.status || '不可用' }}</b><em>v{{ worker?.version || '—' }}</em></div>
        <div><span>最近调度</span><b>{{ text(lastCronAt) }}</b></div>
        <div>
          <span>调度结果</span>
          <b :class="{ bad: lastCronResult === 'failed', 'warn-text': lastCronResult === 'skipped' || lastCronResult === 'sent_with_warning' }">{{ cronResultText }}</b>
          <em v-if="cronReasonText">{{ cronReasonText }}</em>
        </div>
        <div><span>发送尝试</span><b>{{ text(lastAttemptAt) }}</b></div>
        <div><span>最近成功</span><b>{{ text(worker?.runtime?.last_success_at) }}</b></div>
        <div><span>今日尝试</span><b>{{ worker?.runtime?.attempt_count ?? '—' }}</b><em>{{ worker?.runtime?.sent_today ? '已发送' : '未发送' }}</em></div>
        <div v-if="worker?.runtime?.last_warning"><span>最近警示</span><b class="warn-text">{{ worker.runtime.last_warning }}</b><em>{{ worker?.runtime?.decision_status || '已降级' }}</em></div>
        <div v-if="worker?.runtime?.last_error"><span>最近错误</span><b class="bad">{{ worker.runtime.last_error }}</b></div>
      </section>
      <div class="sec">自动任务</div>
      <section class="task-band">
        <div v-for="task in tasks" :key="task.id"><i :class="task.ok ? 'ok' : 'warn'"></i><span>{{ task.label }}</span><b>{{ task.note }}</b><em>{{ text(task.updatedAt) }}</em></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.operations-page { padding-bottom: 90px; }.notice { padding: 10px 14px; color: var(--gold); background: var(--gold-soft); border-bottom: 1px solid var(--gold); font-size: 11px; }
.status-band, .task-band { background: var(--card-bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }.status-band > div { display: grid; grid-template-columns: 100px minmax(0, 1fr) auto; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--border); align-items: center; }.status-band > div:last-child, .task-band > div:last-child { border-bottom: 0; }
  span { color: var(--text-hint); font-size: 11px; }b { min-width: 0; color: var(--ink); font-size: 11px; font-weight: 500; overflow-wrap: anywhere; }em { color: var(--text-hint); font-size: 9px; font-style: normal; }.bad { color: var(--danger); }.warn-text { color: var(--gold); }.task-band > div { display: grid; grid-template-columns: 10px 90px minmax(0, 1fr) auto; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--border); align-items: center; }.task-band i { width: 7px; height: 7px; border-radius: 50%; }.task-band i.ok { background: var(--success); }.task-band i.warn { background: var(--gold); }
@media (max-width: 480px) { .status-band > div { grid-template-columns: 82px minmax(0, 1fr); }.status-band em { grid-column: 2; }.task-band > div { grid-template-columns: 10px 72px minmax(0, 1fr); }.task-band em { grid-column: 3; } }
</style>
