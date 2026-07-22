import { defineStore } from 'pinia'
import {
  getFundDetail, getScore, getSignal, getBacktest, getAnalyze,
  type FundDetail, type ScoreResp, type SignalResp, type BacktestResp, type DecisionResp, type DecisionContextParams,
} from '@/api/client'
import { cacheGet, cacheSet } from '@/utils/cache'

const TTL = 30 * 60 * 1000 // 30 分钟
type Timed<T> = { value: T; storedAt: number }

function memGet<T>(cache: Map<string, Timed<T>>, code: string): T | null {
  const entry = cache.get(code)
  if (!entry) return null
  if (Date.now() - entry.storedAt > TTL) {
    cache.delete(code)
    return null
  }
  return entry.value
}

function memSet<T>(cache: Map<string, Timed<T>>, code: string, value: T): void {
  cache.set(code, { value, storedAt: Date.now() })
}

// 详情/评分/信号带缓存的获取，避免页面间重复请求。
export const useFundsStore = defineStore('funds', () => {
  const detailMem = new Map<string, Timed<FundDetail>>()
  const scoreMem = new Map<string, Timed<ScoreResp>>()
  const signalMem = new Map<string, Timed<SignalResp>>()
  const btMem = new Map<string, Timed<BacktestResp>>()
  const decisionMem = new Map<string, Timed<DecisionResp>>()

  async function detail(code: string): Promise<FundDetail> {
    const memory = memGet(detailMem, code)
    if (memory) return memory
    const cached = cacheGet<FundDetail>('detail_' + code, TTL)
    if (cached) { memSet(detailMem, code, cached); return cached }
    const d = await getFundDetail(code)
    memSet(detailMem, code, d); cacheSet('detail_' + code, d)
    return d
  }

  async function score(code: string): Promise<ScoreResp> {
    const memory = memGet(scoreMem, code)
    if (memory) return memory
    const cached = cacheGet<ScoreResp>('score_' + code, TTL)
    if (cached) { memSet(scoreMem, code, cached); return cached }
    const s = await getScore(code)
    memSet(scoreMem, code, s); cacheSet('score_' + code, s)
    return s
  }

  async function signal(code: string): Promise<SignalResp> {
    const memory = memGet(signalMem, code)
    if (memory) return memory
    const cached = cacheGet<SignalResp>('signal_' + code, TTL)
    if (cached) { memSet(signalMem, code, cached); return cached }
    const s = await getSignal(code)
    memSet(signalMem, code, s); cacheSet('signal_' + code, s)
    return s
  }

  async function backtest(code: string): Promise<BacktestResp> {
    const memory = memGet(btMem, code)
    if (memory) return memory
    const cached = cacheGet<BacktestResp>('bt_' + code, TTL)
    if (cached) { memSet(btMem, code, cached); return cached }
    const b = await getBacktest(code)
    memSet(btMem, code, b); cacheSet('bt_' + code, b)
    return b
  }

  // 聚合获取：详情页一次往返取齐详情/评分/信号/回测。四块若都已在缓存内则直接拼装、
  // 不再请求；否则单次 getAnalyze 取回后回填四个缓存，使后续单项获取（回测页/对比页等）命中。
  async function analyze(code: string, context?: DecisionContextParams): Promise<{
    detail: FundDetail; score: ScoreResp; signal: SignalResp; backtest: BacktestResp; decision: DecisionResp
  }> {
    const cd = memGet(detailMem, code) ?? cacheGet<FundDetail>('detail_' + code, TTL)
    const cs = memGet(scoreMem, code) ?? cacheGet<ScoreResp>('score_' + code, TTL)
    const cg = memGet(signalMem, code) ?? cacheGet<SignalResp>('signal_' + code, TTL)
    const cb = memGet(btMem, code) ?? cacheGet<BacktestResp>('bt_' + code, TTL)
    const contextual = context?.held != null || context?.force
    const cdec = contextual ? null : (memGet(decisionMem, code) ?? cacheGet<DecisionResp>('decision_' + code, TTL))
    if (!context?.force && cd && cs && cg && cb && cdec) {
      memSet(detailMem, code, cd); memSet(scoreMem, code, cs); memSet(signalMem, code, cg)
      memSet(btMem, code, cb); memSet(decisionMem, code, cdec)
      return { detail: cd, score: cs, signal: cg, backtest: cb, decision: cdec }
    }
    const a = await getAnalyze(code, context)
    memSet(detailMem, code, a.detail); cacheSet('detail_' + code, a.detail)
    memSet(scoreMem, code, a.score); cacheSet('score_' + code, a.score)
    memSet(signalMem, code, a.signal); cacheSet('signal_' + code, a.signal)
    memSet(btMem, code, a.backtest); cacheSet('bt_' + code, a.backtest)
    if (!contextual) { memSet(decisionMem, code, a.decision); cacheSet('decision_' + code, a.decision) }
    return { detail: a.detail, score: a.score, signal: a.signal, backtest: a.backtest, decision: a.decision }
  }

  return { detail, score, signal, backtest, analyze }
})
