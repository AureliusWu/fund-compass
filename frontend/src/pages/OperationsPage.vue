<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getHealth, type Health } from '@/api/client'
import { fetchTaskStatuses, type TaskStatus } from '@/utils/taskStatus'

const backend = ref<Health | null>(null)
const worker = ref<Record<string, any> | null>(null)
const tasks = ref<TaskStatus[]>([])
const error = ref('')
const WORKER_HEALTH = (import.meta.env.VITE_WORKER_HEALTH as string) || 'https://sinan-estimate-push.ligugu69.workers.dev/health'
const text = (value: unknown) => value == null || value === '' ? '暂无记录' : String(value)

async function load() {
  error.value = ''
  const results = await Promise.allSettled([
    getHealth(),
    fetch(WORKER_HEALTH, { signal: AbortSignal.timeout(8000) }).then((response) => {
      if (!response.ok) throw new Error(`Worker HTTP ${response.status}`)
      return response.json()
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
        <div><span>缓存命中率</span><b>{{ backend?.operations?.cache?.hit_rate ?? '—' }}%</b><em>最旧 {{ backend?.operations?.cache?.oldest_age_hours ?? '—' }} 小时</em></div>
        <div><span>最近决策</span><b>{{ text(backend?.operations?.latest_decision_write) }}</b></div>
        <div><span>最近结算</span><b>{{ text(backend?.operations?.latest_result_settlement) }}</b></div>
      </section>
      <div class="sec">推送 Worker</div>
      <section class="status-band">
        <div><span>状态</span><b>{{ worker?.runtime?.last_result || worker?.status || '不可用' }}</b><em>v{{ worker?.version || '—' }}</em></div>
        <div><span>最近触发</span><b>{{ text(worker?.runtime?.last_cron_at) }}</b></div>
        <div><span>最近成功</span><b>{{ text(worker?.runtime?.last_success_at) }}</b></div>
        <div><span>今日尝试</span><b>{{ worker?.runtime?.attempt_count ?? '—' }}</b><em>{{ worker?.runtime?.sent_today ? '已发送' : '未发送' }}</em></div>
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
span { color: var(--text-hint); font-size: 11px; }b { min-width: 0; color: var(--ink); font-size: 11px; font-weight: 500; overflow-wrap: anywhere; }em { color: var(--text-hint); font-size: 9px; font-style: normal; }.bad { color: var(--danger); }.task-band > div { display: grid; grid-template-columns: 10px 90px minmax(0, 1fr) auto; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--border); align-items: center; }.task-band i { width: 7px; height: 7px; border-radius: 50%; }.task-band i.ok { background: var(--success); }.task-band i.warn { background: var(--gold); }
@media (max-width: 480px) { .status-band > div { grid-template-columns: 82px minmax(0, 1fr); }.status-band em { grid-column: 2; }.task-band > div { grid-template-columns: 10px 72px minmax(0, 1fr); }.task-band em { grid-column: 3; } }
</style>
