export interface TaskConfig {
  id: string
  label: string
  workflow: string
  cadence: string
  staleHours: number
}

export interface TaskStatus {
  id: string
  label: string
  cadence: string
  workflow: string
  status: string
  conclusion: string | null
  url: string
  updatedAt: string | null
  ageMinutes: number | null
  ok: boolean
  stale: boolean
  note: string
}

interface WorkflowRun {
  status?: string
  conclusion?: string | null
  html_url?: string
  updated_at?: string | null
  run_started_at?: string | null
  created_at?: string | null
}

const REPO = 'AureliusWu/fund-compass'
const TASK_CACHE_KEY = 'sinan_task_status_v1'
const TASK_CACHE_TTL = 10 * 60 * 1000

export const SCHEDULED_TASKS: TaskConfig[] = [
  { id: 'enrich', label: '离线富集', workflow: 'enrich.yml', cadence: '每周一 09:00', staleHours: 8 * 24 },
  { id: 'estimate-push', label: '估值推送', workflow: 'estimate-push.yml', cadence: '交易日 14:30', staleHours: 72 },
  { id: 'overseas-accuracy', label: '海外精度', workflow: 'overseas-accuracy.yml', cadence: '交易日 14:35', staleHours: 72 },
  { id: 'signal-notify', label: '信号保活', workflow: 'notify.yml', cadence: '交易时段 10 分钟', staleHours: 72 },
]

function cacheGet(): TaskStatus[] | null {
  try {
    const raw = localStorage.getItem(TASK_CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data?.t || Date.now() - data.t > TASK_CACHE_TTL || !Array.isArray(data.v)) return null
    return data.v as TaskStatus[]
  } catch { return null }
}

function cacheSet(value: TaskStatus[]): void {
  try { localStorage.setItem(TASK_CACHE_KEY, JSON.stringify({ t: Date.now(), v: value })) } catch { /* ignore */ }
}

export function normalizeTaskStatus(config: TaskConfig, run: WorkflowRun | null, now = Date.now()): TaskStatus {
  if (!run) {
    return {
      id: config.id,
      label: config.label,
      cadence: config.cadence,
      workflow: config.workflow,
      status: 'unknown',
      conclusion: null,
      url: `https://github.com/${REPO}/actions/workflows/${config.workflow}`,
      updatedAt: null,
      ageMinutes: null,
      ok: false,
      stale: true,
      note: '暂无运行记录',
    }
  }

  const updatedAt = run.updated_at || run.run_started_at || run.created_at || null
  const ageMinutes = updatedAt ? Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60000)) : null
  const stale = ageMinutes != null ? ageMinutes > config.staleHours * 60 : true
  const status = run.status || 'unknown'
  const conclusion = run.conclusion ?? null
  const completedOk = status === 'completed' && conclusion === 'success'
  const runningOk = status === 'queued' || status === 'in_progress'
  const ok = (completedOk || runningOk) && !stale
  const note = runningOk
    ? '运行中'
    : conclusion === 'success'
      ? (stale ? '最近成功，但可能过期' : '最近成功')
      : conclusion ? `最近${conclusion}` : '状态未知'

  return {
    id: config.id,
    label: config.label,
    cadence: config.cadence,
    workflow: config.workflow,
    status,
    conclusion,
    url: run.html_url || `https://github.com/${REPO}/actions/workflows/${config.workflow}`,
    updatedAt,
    ageMinutes,
    ok,
    stale,
    note,
  }
}

async function fetchTask(config: TaskConfig): Promise<TaskStatus> {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${config.workflow}/runs?branch=main&per_page=1`
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw new Error(`GitHub Actions ${res.status}`)
  const data = await res.json()
  const run = Array.isArray(data?.workflow_runs) ? data.workflow_runs[0] : null
  return normalizeTaskStatus(config, run)
}

export async function fetchTaskStatuses(force = false): Promise<TaskStatus[]> {
  if (!force) {
    const cached = cacheGet()
    if (cached) return cached
  }
  const settled = await Promise.allSettled(SCHEDULED_TASKS.map(fetchTask))
  const statuses = settled.map((r, i) => (
    r.status === 'fulfilled'
      ? r.value
      : normalizeTaskStatus(SCHEDULED_TASKS[i], null)
  ))
  cacheSet(statuses)
  return statuses
}
