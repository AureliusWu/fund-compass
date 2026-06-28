import { defineStore } from 'pinia'
import {
  getFundDetail, getScore, getSignal, getBacktest, getAnalyze,
  type FundDetail, type ScoreResp, type SignalResp, type BacktestResp,
} from '@/api/client'
import { cacheGet, cacheSet } from '@/utils/cache'

const TTL = 30 * 60 * 1000 // 30 分钟

// 详情/评分/信号带缓存的获取，避免页面间重复请求。
export const useFundsStore = defineStore('funds', () => {
  const detailMem = new Map<string, FundDetail>()
  const scoreMem = new Map<string, ScoreResp>()
  const signalMem = new Map<string, SignalResp>()
  const btMem = new Map<string, BacktestResp>()

  async function detail(code: string): Promise<FundDetail> {
    if (detailMem.has(code)) return detailMem.get(code)!
    const cached = cacheGet<FundDetail>('detail_' + code, TTL)
    if (cached) { detailMem.set(code, cached); return cached }
    const d = await getFundDetail(code)
    detailMem.set(code, d); cacheSet('detail_' + code, d)
    return d
  }

  async function score(code: string): Promise<ScoreResp> {
    if (scoreMem.has(code)) return scoreMem.get(code)!
    const cached = cacheGet<ScoreResp>('score_' + code, TTL)
    if (cached) { scoreMem.set(code, cached); return cached }
    const s = await getScore(code)
    scoreMem.set(code, s); cacheSet('score_' + code, s)
    return s
  }

  async function signal(code: string): Promise<SignalResp> {
    if (signalMem.has(code)) return signalMem.get(code)!
    const cached = cacheGet<SignalResp>('signal_' + code, TTL)
    if (cached) { signalMem.set(code, cached); return cached }
    const s = await getSignal(code)
    signalMem.set(code, s); cacheSet('signal_' + code, s)
    return s
  }

  async function backtest(code: string): Promise<BacktestResp> {
    if (btMem.has(code)) return btMem.get(code)!
    const cached = cacheGet<BacktestResp>('bt_' + code, TTL)
    if (cached) { btMem.set(code, cached); return cached }
    const b = await getBacktest(code)
    btMem.set(code, b); cacheSet('bt_' + code, b)
    return b
  }

  // 聚合获取：详情页一次往返取齐详情/评分/信号/回测。四块若都已在缓存内则直接拼装、
  // 不再请求；否则单次 getAnalyze 取回后回填四个缓存，使后续单项获取（回测页/对比页等）命中。
  async function analyze(code: string): Promise<{
    detail: FundDetail; score: ScoreResp; signal: SignalResp; backtest: BacktestResp
  }> {
    const cd = detailMem.get(code) ?? cacheGet<FundDetail>('detail_' + code, TTL)
    const cs = scoreMem.get(code) ?? cacheGet<ScoreResp>('score_' + code, TTL)
    const cg = signalMem.get(code) ?? cacheGet<SignalResp>('signal_' + code, TTL)
    const cb = btMem.get(code) ?? cacheGet<BacktestResp>('bt_' + code, TTL)
    if (cd && cs && cg && cb) {
      detailMem.set(code, cd); scoreMem.set(code, cs); signalMem.set(code, cg); btMem.set(code, cb)
      return { detail: cd, score: cs, signal: cg, backtest: cb }
    }
    const a = await getAnalyze(code)
    detailMem.set(code, a.detail); cacheSet('detail_' + code, a.detail)
    scoreMem.set(code, a.score); cacheSet('score_' + code, a.score)
    signalMem.set(code, a.signal); cacheSet('signal_' + code, a.signal)
    btMem.set(code, a.backtest); cacheSet('bt_' + code, a.backtest)
    return { detail: a.detail, score: a.score, signal: a.signal, backtest: a.backtest }
  }

  return { detail, score, signal, backtest, analyze }
})
