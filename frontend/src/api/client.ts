// 后端基址：开发走 Vite 代理 /api → localhost:8000；
// 生产用环境变量 VITE_API_BASE 指向已部署后端（Railway/Render）。
const BASE = (import.meta.env.VITE_API_BASE as string) || '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json() as Promise<T>
}

export interface Health { status: string; service: string; version: string; universe: number }
export interface FundListItem { code: string; name: string; type: string }
export interface FundsResp { total: number; page: number; page_size: number; items: FundListItem[] }
export interface NavPoint { date: string; nav: number; ac_return: number | null }

export interface FundDetail {
  code: string; name: string; type: string | null
  scale: number | null; buy_rate: number | null; source_rate: number | null
  ret_1m: number | null; ret_6m: number | null; ret_1y: number | null; ret_3y: number | null
  rank_in_type: number | null; rank_total: number | null
  manager: string | null; manager_worktime: string | null
  latest_nav: number | null; latest_nav_date: string | null
  nav_history: NavPoint[]
}

export interface Component { weight: number; score: number | null; detail: Record<string, unknown> }
export interface ScoreResp {
  code: string; name: string; type: string | null
  score: number | null; star: number | null
  rank_in_type: number | null; rank_total: number | null
  components: { return: Component; risk: Component; management: Component; cost: Component }
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
  layers: { valuation: Layer; trend: Layer; sentiment: Layer }
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
  outperform?: number; win_rate?: number | null
  actions?: { date: string; signal: string; weight: number }[]
  weights?: Record<string, number>
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
