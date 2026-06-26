import { defineStore } from 'pinia'
import {
  getFundDetail, getScore, getSignal,
  type FundDetail, type ScoreResp, type SignalResp,
} from '@/api/client'
import { cacheGet, cacheSet } from '@/utils/cache'

const TTL = 30 * 60 * 1000 // 30 分钟

// 详情/评分/信号带缓存的获取，避免页面间重复请求。
export const useFundsStore = defineStore('funds', () => {
  const detailMem = new Map<string, FundDetail>()
  const scoreMem = new Map<string, ScoreResp>()
  const signalMem = new Map<string, SignalResp>()

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

  return { detail, score, signal }
})
