// 后端基址：开发走 Vite 代理 /api → localhost:8000；
// 生产用环境变量 VITE_API_BASE 指向已部署后端（Railway/Render）。
const BASE = (import.meta.env.VITE_API_BASE as string) || '/api'
const REQUEST_TIMEOUT_MS = 12_000

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network' | 'http',
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
    const res = await fetch(BASE + path, { ...init, signal: controller.signal })
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

export interface Health { status: string; service: string; version: string; universe: number }
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
export const getStrategyOutcomes = () => req<StrategyOutcomesResp>('/strategy/outcomes')

export interface DecisionResp {
  code: string; name: string; type?: string | null
  action: string
  confidence: '高' | '中' | '低'
  summary: string
  reasons: string[]
  risks: string[]
  position_rule: string
  next_check: string
  disclaimer?: string
}
export const getDecision = (code: string, p?: { target_weight?: number; current_weight?: number }) => {
  const u = new URLSearchParams()
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
    current_total: number
    target_total: number
    target_cash: number
    status: string
    warnings: string[]
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
export const getPortfolioOutcomes = () => req<PortfolioOutcomesResp>('/strategy/portfolio-outcomes')

// 聚合分析：一次往返取齐详情 + 评分 + 信号 + 回测 + 决策，详情页据此把四次请求收敛为一次。
export interface AnalyzeResp {
  code: string; name: string; type: string | null
  detail: FundDetail
  score: ScoreResp
  signal: SignalResp
  backtest: BacktestResp
  decision: DecisionResp
}
export const getAnalyze = (code: string) => req<AnalyzeResp>(`/fund/${code}/analyze`)

export const getWatchlist = () => req<{ items: WatchItem[] }>('/watchlist')
export const addWatch = (code: string) =>
  req<{ ok: boolean }>('/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
export const removeWatch = (code: string) =>
  req<{ ok: boolean }>(`/watchlist/${code}`, { method: 'DELETE' })
