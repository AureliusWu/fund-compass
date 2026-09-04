// 后端基址：开发走 Vite 代理 /api → localhost:8000；
// 生产用环境变量 VITE_API_BASE 指向已部署后端（Railway/Render）。
const BASE = (import.meta.env.VITE_API_BASE as string) || '/api'
const REQUEST_TIMEOUT_MS = 12_000

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network' | 'http' | 'redacted',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(init?.signal?.reason)
  init?.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = globalThis.setTimeout(() => controller.abort('timeout'), timeoutMs)

  try {
    const res = await fetch(BASE + path, { cache: 'no-store', ...init, signal: controller.signal })
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, 'http', res.status)
    return res.json() as Promise<T>
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (controller.signal.aborted && !init?.signal?.aborted) {
      throw new ApiError('请求超时，请稍后重试', 'timeout')
    }
    throw new ApiError('网络连接失败，请稍后重试', 'network')
  } finally {
    globalThis.clearTimeout(timer)
    init?.signal?.removeEventListener('abort', forwardAbort)
  }
}

const req = request

interface RedactedOwnerRead {
  redacted?: boolean
}

/**
 * Owner-scoped GETs keep their legacy public URL but fail closed with HTTP 403
 * so a cached pre-v8 client cannot mistake a smaller redacted payload for the
 * former full DTO. During a mixed rollout an older backend may still return a
 * 200 redacted marker; accept only that marker and reject every full shape.
 */
async function readOwnerScoped<T>(path: string): Promise<T> {
  try {
    const payload = await req<T | RedactedOwnerRead>(path)
    if (payload && typeof payload === 'object' && (payload as RedactedOwnerRead).redacted === true) {
      throw new ApiError('私人数据未公开', 'redacted')
    }
    throw new ApiError('匿名读取返回了不安全的旧契约', 'http', 502)
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'http' && error.status === 403) {
      throw new ApiError('私人数据未公开', 'redacted', 403)
    }
    throw error
  }
}

export interface Health {
  status: string; service: string; version: string; universe: number; started_at?: string
  source?: Record<string, unknown>
  index_valuation?: {
    loaded?: boolean; usable?: boolean; stale?: boolean; age_days?: number | null
    max_age_days?: number; updated?: string | null; indices?: number; source?: string | null
  } | null
  database?: {
    engine?: string; persistence?: 'persistent_disk' | 'ephemeral' | 'unspecified'
    durable?: boolean; warning?: string | null
  }
  operations?: {
    universe_artifact?: Record<string, unknown> | null
    cache?: { requests: number; hits: number; hit_rate: number | null; oldest_age_hours: number | null }
    latest_decision_write?: string | null; latest_result_settlement?: string | null
  }
}

export type WorkerCronResult = 'sent' | 'sent_with_warning' | 'skipped' | 'failed'
export type WorkerCronReason =
  | 'weekend'
  | 'empty_watchlist'
  | 'already_sent'
  | 'no_fresh_estimate'
  | 'official_nav_only'
  | 'no_publishable_intraday'
  | 'notification_already_claimed'

export interface WorkerHealthRuntime {
  state_available?: boolean
  last_cron_at?: string | null
  last_cron_result?: WorkerCronResult | null
  last_cron_reason?: WorkerCronReason | null
  last_attempt_at?: string | null
  /** Legacy send outcome retained for older Worker deployments. */
  last_result?: WorkerCronResult | 'not_sent' | null
  last_success_at?: string | null
  last_error?: string | null
  last_warning?: string | null
  decision_status?: 'ok' | 'disabled' | 'degraded' | null
  last_http_status?: number | null
  attempt_count?: number
  sent_today?: boolean
  state_date?: string | null
}

export interface WorkerHealth {
  status: string
  service?: string
  version?: string
  runtime?: WorkerHealthRuntime | null
  configured?: Record<string, boolean>
}

export interface NormalizedWorkerRuntime {
  lastCronAt: string | null
  lastCronResult: WorkerCronResult | 'not_sent' | null
  lastCronReason: WorkerCronReason | null
  lastAttemptAt: string | null
  legacyCronContract: boolean
}

/** Preserve explicit nulls from the new cron contract; only absent fields use legacy aliases. */
export function normalizeWorkerRuntime(
  runtime: WorkerHealthRuntime | null | undefined,
): NormalizedWorkerRuntime {
  if (!runtime) {
    return {
      lastCronAt: null,
      lastCronResult: null,
      lastCronReason: null,
      lastAttemptAt: null,
      legacyCronContract: false,
    }
  }
  const has = (field: keyof WorkerHealthRuntime) => Object.prototype.hasOwnProperty.call(runtime, field)
  return {
    lastCronAt: has('last_cron_at') ? runtime.last_cron_at ?? null : runtime.last_attempt_at ?? null,
    lastCronResult: has('last_cron_result') ? runtime.last_cron_result ?? null : runtime.last_result ?? null,
    lastCronReason: has('last_cron_reason') ? runtime.last_cron_reason ?? null : null,
    lastAttemptAt: has('last_attempt_at') ? runtime.last_attempt_at ?? null : runtime.last_cron_at ?? null,
    legacyCronContract: !has('last_cron_result'),
  }
}

export interface FundListItem { code: string; name: string; type: string }
export interface FundsResp { total: number; page: number; page_size: number; items: FundListItem[] }
export interface NavPoint { date: string; nav: number; ac_return: number | null }

export interface FundDetail {
  code: string; name: string; type: string | null
  scale: number | null; buy_rate: number | null; source_rate: number | null
  ret_1m: number | null; ret_6m: number | null; ret_1y: number | null; ret_3y: number | null
  rank_in_type: number | null; rank_total: number | null
  manager: string | null; manager_id?: string | null; manager_worktime: string | null
  latest_nav: number | null; latest_nav_date: string | null
  nav_history: NavPoint[]
  source?: string | null; updated_at?: string | null; cached?: boolean; stale?: boolean; data_age_hours?: number
}

export interface Component { weight: number; effective_weight: number; score: number | null; detail: Record<string, unknown> }
export interface ScoreResp {
  code: string; name: string; type: string | null
  score: number | null; star: number | null
  score_version: string; coverage: number; eligible: boolean
  rank_in_type: number | null; rank_total: number | null
  components: { return: Component; risk: Component; management: Component; cost: Component }
  data_source?: string | null; data_updated_at?: string | null; data_stale?: boolean; data_age_hours?: number; as_of_date?: string | null
}

export interface Layer {
  label: string
  value: number
  // V3-5 真实 PE/PB 估值字段（source === "index_pe_pb" 时存在）
  source?: string
  percentile?: number | null
  index_name?: string
  pe?: number | null
  pe_pct?: number | null
  pb?: number | null
  pb_pct?: number | null
  valuation_date?: string
  note?: string
  // 趋势层扩展字段
  current?: number
  ma20?: number
  ma60?: number
  ma120?: number
  // 情绪层扩展字段
  rsi?: number | null
  [k: string]: unknown
}
export interface SignalResp {
  code: string; name: string; type: string | null
  signal: string; advice: string; composite: number; disclaimer?: string
  signal_version?: string; coverage?: number; evidence_strength?: '高' | '中' | '低'
  layers: { valuation: Layer; trend: Layer; sentiment: Layer }
  data_source?: string | null; data_updated_at?: string | null; data_stale?: boolean; data_age_hours?: number; as_of_date?: string | null
}

export interface WatchItem { code: string; name: string | null; type: string | null; added_at: string }

export const getHealth = () => req<Health>('/health')

export function getFunds(p: { q?: string; type?: string; page?: number; page_size?: number }) {
  const u = new URLSearchParams()
  if (p.q) u.set('q', p.q)
  if (p.type) u.set('type', p.type)
  u.set('page', String(p.page ?? 1))
  u.set('page_size', String(p.page_size ?? 20))
  return req<FundsResp>('/funds?' + u.toString())
}

export const getFundDetail = (code: string) => req<FundDetail>(`/fund/${code}`)
export const getScore = (code: string) => req<ScoreResp>(`/fund/${code}/score`)
export const getSignal = (code: string) => req<SignalResp>(`/fund/${code}/signal`)

export interface BtSeries { total_return: number; max_drawdown: number; curve: { date: string; v: number }[] }
export interface BacktestResp {
  code: string; name: string; available: boolean; reason?: string
  start?: string; end?: string; rebalances?: number
  strategy?: BtSeries; benchmark?: BtSeries
  strategy_gross?: BtSeries
  outperform?: number; win_rate?: number | null
  actions?: { date: string; signal: string; weight: number }[]
  weights?: Record<string, number>
  assumptions?: {
    buy_fee: number; sell_fee: number; slippage: number
    annual_cash_yield: number; min_hold_months: number
  }
  friction_cost?: number
  stress?: {
    high_cost_return: number | null
    high_cost_outperform: number | null
    return_drop: number
    stable: boolean
  }
}
export const getBacktest = (code: string) => req<BacktestResp>(`/fund/${code}/backtest`)

export interface CalibrationResp {
  code: string
  name: string
  available: boolean
  accepted: boolean
  reason: string
  split_date?: string
  train_points?: number
  validation_points?: number
  current_weights?: Record<string, number>
  candidate_weights?: Record<string, number>
  validation?: {
    baseline: { outperform: number; max_drawdown: number }
    candidate: { outperform: number; max_drawdown: number }
  }
}
export const getCalibration = (code: string) => req<CalibrationResp>(`/fund/${code}/calibrate`)

export interface OutcomeMetric {
  horizon: number
  samples: number
  average_return: number
  hit_rate: number
  average_excess: number | null
  average_drawdown: number
  worst_drawdown?: number
  strategy_version?: string
  action?: string
  confidence?: string
  type?: string
}
export interface StrategyOutcomesResp {
  total: number
  mature: number
  pending: number
  summary: OutcomeMetric[]
  items: {
    id: number; code: string; name: string; type: string; decision_date: string
    action: string; confidence: string; strategy_version: string
    returns: Record<string, {
      date: string; return: number; max_drawdown: number
      benchmark_return?: number; excess_return?: number; benchmark_samples?: number
    }>
  }[]
  breakdowns: {
    strategy_version: OutcomeMetric[]
    action: OutcomeMetric[]
    confidence: OutcomeMetric[]
    type: OutcomeMetric[]
  }
}
export const getStrategyOutcomes = () => readOwnerScoped<StrategyOutcomesResp>('/strategy/outcomes')

export interface DecisionResp {
  code: string; name: string; type?: string | null
  action: string
  strength: number
  confidence: '高' | '中' | '低'
  data_status: '实时' | '延迟' | '旧数据' | '降级' | '最新正式净值' | '暂不可用'
  data_time?: string | null
  calculated_at?: string | null
  position_level: string
  trend_state: string
  investment_method: string
  change_conditions: string[]
  summary: string
  reasons: string[]
  risks: string[]
  position_rule: string
  next_check: string
  disclaimer?: string
  methodology?: {
    score_version: string; signal_version: string
    score_coverage?: number | null; signal_coverage?: number | null
    evidence_strength: string
  }
  freshness?: {
    sourceTime: string | null; fetchedAt: string | null; calculatedAt: string | null
    ageSeconds: number | null; status: string; source: string; isFallback: boolean
    fallbackReason?: string | null
  }
}
export interface DecisionContextParams {
  held?: boolean
  target_weight?: number
  current_weight?: number
  /** @deprecated Public reads refresh only through the backend TTL policy. */
  force?: boolean
}
export const getDecision = (code: string, p?: DecisionContextParams) => {
  const u = new URLSearchParams()
  if (p?.held != null) u.set('held', String(p.held))
  if (p?.target_weight != null) u.set('target_weight', String(p.target_weight))
  if (p?.current_weight != null) u.set('current_weight', String(p.current_weight))
  const q = u.toString()
  return req<DecisionResp>(`/fund/${code}/decision` + (q ? '?' + q : ''))
}

export interface PortfolioDecisionItem {
  code: string
  current_weight?: number
  target_weight?: number
}
export interface PortfolioDecisionsResp {
  decisions: DecisionResp[]
  errors: { code: string; error: string }[]
  total: number
  allocation: {
    current_total: number | null
    target_total: number | null
    target_cash: number | null
    status: string
    warnings: string[]
    complete?: boolean
    missing_current_weights?: string[]
    missing_target_weights?: string[]
  }
  rebalance: {
    code: string
    name: string
    current_weight: number
    target_weight: number
    gap: number
    suggestion: string
    amount: number | null
  }[]
}
export const postPortfolioDecisions = (items: PortfolioDecisionItem[], portfolioValue?: number) =>
  req<PortfolioDecisionsResp>('/portfolio/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, portfolio_value: portfolioValue }),
  })

export type V8Action = 'buy' | 'dca' | 'watch' | 'add' | 'hold' | 'reduce' | 'sell'
export type V8UserState = 'unheld' | 'held'

export interface V8SourceState {
  source_id: string
  state: 'healthy' | 'degraded' | 'stale' | 'unavailable' | 'unknown'
  last_success: string | null
  last_failure: string | null
  latency_ms: number | null
  data_age_seconds: number | null
  stale: boolean
  error_class: string | null
}

export interface V8EvidenceNode {
  node_id: string
  category: 'valuation' | 'trend' | 'momentum' | 'quality' | 'risk' | 'holding' | 'portfolio' | 'data_quality' | 'model_accuracy' | 'outcome'
  state: 'support' | 'constraint' | 'neutral' | 'missing'
  label: string
  value: number | string | boolean | null
  source_id: string | null
}

export interface V8EvidenceSnapshot {
  schema_version: 'v8-evidence-1'
  evidence_id: string
  fund_code: string
  fund_name: string | null
  fund_type: string
  created_at: string
  market_time: string | null
  official_nav: number | null
  official_nav_date: string | null
  target_nav_date: string | null
  benchmark_id: string | null
  valuation_percentile: number | null
  trend_state: string | null
  momentum_state: string | null
  drawdown: number | null
  volatility: number | null
  market_temperature: number | null
  score: number | null
  score_version: string | null
  score_coverage: number
  timing_signal: string | null
  timing_coverage: number
  estimate: number | null
  estimate_status: string
  estimate_coverage: number | null
  estimate_model_version: string | null
  estimate_error_p80: number | null
  estimate_sample_count: number | null
  estimate_mae: number | null
  estimate_direction_accuracy: number | null
  source_states: V8SourceState[]
  evidence_nodes: V8EvidenceNode[]
  evidence_strength: number
  missing_fields: string[]
  stale_fields: string[]
  risk_flags: string[]
}

export interface V8HoldingInput {
  is_held: boolean
  shares?: number
  cost?: number
  market_value?: number
  account?: string
  current_weight?: number
  target_weight?: number
  updated_at?: string
  source?: string
}

export interface V8HoldingVersion {
  schema_version: 'v8-holding-1'
  holding_version: string
  fund_code: string
  user_state: V8UserState
  shares: number | null
  cost: number | null
  market_value: number | null
  account: string | null
  current_weight: number | null
  target_weight: number | null
  updated_at: string | null
  source: string
  created_at: string
}

export interface V8PortfolioPolicy {
  schema_version: 'v8-policy-1'
  policy_version: string
  name: string
  target_allocations: Record<string, number>
  target_ranges: Record<string, [number, number]>
  max_single_fund_weight: number | null
  max_theme_weight: number | null
  rebalance_band: number | null
  dca_rules: Record<string, unknown>
  reduce_rules: Record<string, unknown>
  sell_rules: Record<string, unknown>
  effective_at: string
  created_at: string
  source: string
  supersedes: string | null
}

export interface V8PositionGuidance {
  current_weight: number | null
  target_weight: number | null
  target_range: [number, number] | null
  suggested_change: number | null
  suggested_range: [number, number] | null
  method: string
  amount: number | null
  precise: boolean
}

export interface V8DecisionSnapshot {
  schema_version: 'v8-decision-1'
  decision_id: string
  evidence_id: string
  fund_code: string
  holding_version: string | null
  policy_version: string
  strategy_version: string
  user_state: V8UserState
  action: V8Action
  strength: number
  confidence: number
  summary: string
  reason_codes: string[]
  reasons: string[]
  risks: string[]
  invalidation_codes: string[]
  invalidation_conditions: string[]
  position_guidance: V8PositionGuidance | null
  evidence_nodes: V8EvidenceNode[]
  created_at: string
}

export interface V8DecisionDiff {
  previous_decision_id: string | null
  current_decision_id: string
  previous_action: V8Action | null
  current_action: V8Action
  changed: boolean
  drivers: string[]
  driver_codes: string[]
  unchanged: string[]
}

export interface V8DecisionResult {
  code: string
  name: string | null
  type: string
  action: V8Action
  action_label: string
  strength: number
  confidence: number
  summary: string
  decision: V8DecisionSnapshot
  evidence: V8EvidenceSnapshot
  holding: V8HoldingVersion
  policy: V8PortfolioPolicy
  diff: V8DecisionDiff
}

export interface V8DecisionItem {
  code: string
  holding: V8HoldingInput
  theme?: string
  estimate_context?: Record<string, unknown>
}

export interface V8DecisionBatchRequest {
  request_id?: string
  items: V8DecisionItem[]
  policy_version?: string
  portfolio_value?: number
}

export interface V8DecisionBatchResponse {
  decisions: V8DecisionResult[]
  errors: { code: string; error: string }[]
  total: number
  requested: number
  complete: boolean
  allocation: {
    complete: boolean
    current_total: number | null
    target_total: number | null
    target_cash: number | null
    status: string
    missing_current_weights: string[]
    missing_target_weights: string[]
    warnings: string[]
  }
  rebalance: {
    code: string; name: string | null; action: V8Action
    current_weight: number | null; target_weight: number | null
    suggested_change: number | null; suggested_range: [number, number] | null
    amount: number | null; precise: boolean
  }[]
  policy_version: string
  strategy_version: string
  request_id: string | null
  duplicate: boolean
}

export interface V8PortfolioRebalanceResponse {
  request_id: string | null
  duplicate: boolean
  complete: boolean
  allocation: V8DecisionBatchResponse['allocation']
  rebalance: V8DecisionBatchResponse['rebalance']
  policy_version: string
  strategy_version: string
}

export interface V8FundOutcomes {
  fund_code: string
  total: number
  items: {
    decision: V8DecisionSnapshot
    outcomes: Record<string, unknown>[]
    pending_horizons: number[]
    qdii_target_pending: boolean
  }[]
}

export interface V8StrategyPerformance {
  strategy_version: string
  samples: number
  metrics: {
    horizon: number
    samples: number
    hit_rate: number
    average_return: number
    average_peer_excess: number | null
    average_drawdown: number
    worst_drawdown: number
  }[]
  auto_promotion: false
  sample_gate: { minimum_total: number; minimum_primary_type: number }
  eligible_for_review: boolean
}

/**
 * Owner-scoped V8 reads are deliberately unavailable to anonymous browser
 * clients. The legacy public URLs fail closed with 403 (or a redacted marker
 * during mixed rollout), which readOwnerScoped maps to the unavailable UI. Snapshot creation,
 * settlement, notification and rebalance routes require Worker/Admin
 * credentials and must never be called from public frontend code.
 */
export const getV8Evidence = (code: string) =>
  readOwnerScoped<V8EvidenceSnapshot>(`/v2/fund/${encodeURIComponent(code)}/evidence`)

export const getV8Decision = (code: string) =>
  readOwnerScoped<V8DecisionResult>(`/v2/fund/${encodeURIComponent(code)}/decision`)

export const getV8DecisionDiff = (code: string) =>
  readOwnerScoped<V8DecisionDiff>(`/v2/fund/${encodeURIComponent(code)}/decision/diff`)

export const getV8FundOutcomes = (code: string) =>
  readOwnerScoped<V8FundOutcomes>(`/v2/fund/${encodeURIComponent(code)}/outcomes`)

export const getV8PortfolioPolicy = () => readOwnerScoped<V8PortfolioPolicy>('/v2/portfolio/policy')
export const getV8PortfolioPolicyHistory = () =>
  readOwnerScoped<{ total: number; items: V8PortfolioPolicy[] }>('/v2/portfolio/policy/history')

export const getV8StrategyRegistry = () => readOwnerScoped<Record<string, unknown>>('/v2/strategy/registry')
export const getV8StrategyPerformance = (version: string) =>
  readOwnerScoped<V8StrategyPerformance>(`/v2/strategy/${encodeURIComponent(version)}/performance`)

export interface PortfolioLabResp {
  backtest: {
    available: boolean; start: string; end: string; points: number
    strategy: BtSeries & { annual_return: number; annual_volatility: number }
    benchmark: BtSeries & { annual_return: number; annual_volatility: number }
    cash: BtSeries & { annual_return: number; annual_volatility: number }
    turnover: number; friction_cost: number
    assumptions: { rebalance_fee: number; annual_cash_yield: number; max_weight: number; min_trade: number }
  }
  risk: {
    annual_volatility: number; effective_holdings: number; correlation_concentration: number
    contributions: { code: string; name: string; weight: number; risk_contribution: number; annual_volatility: number }[]
  }
  rebalance: {
    turnover: number; estimated_cost: number | null
    risk_change: { current_volatility: number; suggested_volatility: number; delta: number }
    constraints: { max_weight: number; effective_max_weight: number; min_trade: number }
    actions: {
      code: string; name: string; current_weight: number; suggested_weight: number
      delta: number; action: string; amount: number | null; reason: string
    }[]
  }
  stress: { name: string; return: number; pnl: number | null }[]
}
export const postPortfolioLab = (
  items: { code: string; current_weight: number; target_weight: number }[],
  portfolioValue?: number,
) => req<PortfolioLabResp>('/portfolio/lab', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items, portfolio_value: portfolioValue }),
})

export interface PortfolioOutcomesResp {
  total: number; mature: number; pending: number
  items: {
    id: number; snapshot_date: string; strategy_version: string
    items: { code: string; name: string; weight: number; base_nav: number; base_date: string; action: string }[]
    returns: Record<string, { date: string; return: number; components: number }>
  }[]
}
export const getPortfolioOutcomes = () => readOwnerScoped<PortfolioOutcomesResp>('/strategy/portfolio-outcomes')

// 聚合分析：一次往返取齐详情 + 评分 + 信号 + 回测 + 决策，详情页据此把四次请求收敛为一次。
export interface AnalyzeResp {
  code: string; name: string; type: string | null
  detail: FundDetail
  score: ScoreResp
  signal: SignalResp
  backtest: BacktestResp
  decision: DecisionResp
}
export const getAnalyze = (code: string, p?: DecisionContextParams) => {
  const u = new URLSearchParams()
  if (p?.held != null) u.set('held', String(p.held))
  if (p?.target_weight != null) u.set('target_weight', String(p.target_weight))
  if (p?.current_weight != null) u.set('current_weight', String(p.current_weight))
  const query = u.toString()
  return req<AnalyzeResp>(`/fund/${code}/analyze${query ? '?' + query : ''}`)
}

export const getWatchlist = () => readOwnerScoped<{ items: WatchItem[] }>('/watchlist')
export const addWatch = (code: string) =>
  req<{ ok: boolean }>('/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
export const removeWatch = (code: string) =>
  req<{ ok: boolean }>(`/watchlist/${code}`, { method: 'DELETE' })
