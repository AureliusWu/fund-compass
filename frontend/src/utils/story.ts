// V4-6 数据故事。组合周报/月报数据聚合。
// 从持仓数据、信号、估值等维度生成结构化故事卡片。

import { chat } from './ai'
import type { FundDetail, ScoreResp, SignalResp, NavPoint } from '@/api/client'
import { pct as formatPct } from './format'

export interface StoryHolding {
  code: string; name: string; type: string; value: number; profit: number; rate: number
  today: number | null; signal: string | null; score: number | null; star: number | null
}

export interface StoryData {
  generated: string           // ISO time
  totalValue: number; totalCost: number; totalProfit: number; totalRate: number | null
  todayEst: number | null
  holdingCount: number
  bestHolding: StoryHolding | null   // by total return
  worstHolding: StoryHolding | null
  bestToday: StoryHolding | null     // by today estimate
  worstToday: StoryHolding | null
  signalDist: Record<string, number>
  holdings: StoryHolding[]
}

/** 聚合持仓数据为故事输入 */
export function compileStoryData(raw: {
  holdings: {
    code: string; name: string; type: string; value: number; shares: number; cost: number
    nav: number | null; today: number | null; signal?: string | null; score?: number | null; star?: number | null
  }[]
  totalValue: number; totalCost: number; totalProfit: number; totalRate: number | null; todayEst: number | null
}): StoryData {
  const holdings: StoryHolding[] = raw.holdings.map((h) => ({
    code: h.code, name: h.name, type: h.type, value: h.value,
    profit: h.value - h.shares * h.cost,
    rate: h.cost > 0 ? ((h.value - h.shares * h.cost) / (h.shares * h.cost)) * 100 : 0,
    today: h.today,
    signal: h.signal ?? null,
    score: h.score ?? null,
    star: h.star ?? null,
  }))

  const sorted = [...holdings].sort((a, b) => b.rate - a.rate)
  const byToday = [...holdings].filter((h) => h.today != null).sort((a, b) => (b.today ?? 0) - (a.today ?? 0))

  const signalDist: Record<string, number> = {}
  for (const h of holdings) {
    const s = h.signal || '未知'
    signalDist[s] = (signalDist[s] || 0) + 1
  }

  return {
    generated: new Date().toISOString(),
    totalValue: raw.totalValue, totalCost: raw.totalCost,
    totalProfit: raw.totalProfit, totalRate: raw.totalRate,
    todayEst: raw.todayEst,
    holdingCount: holdings.length,
    bestHolding: sorted[0] || null,
    worstHolding: sorted[sorted.length - 1] || null,
    bestToday: byToday[0] || null,
    worstToday: byToday[byToday.length - 1] || null,
    signalDist,
    holdings,
  }
}

/** 生成 LLM 一句话总结 */
export async function generateStorySummary(data: StoryData): Promise<string> {
  const facts = {
    总市值: data.totalValue.toLocaleString('zh-CN', { maximumFractionDigits: 0 }),
    累计收益: data.totalProfit >= 0 ? '+' + data.totalProfit.toFixed(2) : data.totalProfit.toFixed(2),
    累计收益率: formatPct(data.totalRate),
    今日估算: data.todayEst != null ? (data.todayEst >= 0 ? '+' : '') + data.todayEst.toFixed(2) : '暂无',
    持仓数量: data.holdingCount,
    最佳持仓: data.bestHolding ? `${data.bestHolding.name}（+${data.bestHolding.rate.toFixed(2)}%）` : '无',
    最差持仓: data.worstHolding ? `${data.worstHolding.name}（${data.worstHolding.rate.toFixed(2)}%）` : '无',
    信号分布: data.signalDist,
    今日最强: data.bestToday ? `${data.bestToday.name}（${data.bestToday.today! >= 0 ? '+' : ''}${data.bestToday.today!.toFixed(2)}）` : '无',
  }

  const system =
    '你是中立的基金组合报告撰写助手。根据给定的持仓数据，用简体中文写一段 100–150 字的组合周报摘要。' +
    '口吻像理财周报，先总述组合近况，再点出最佳/最差持仓和信号分布，最后给一句中性展望。' +
    '结尾另起一行加：「以上为数据摘要，仅供个人参考，不构成投资建议。」'

  try {
    return await chat(system, '组合数据：\n' + JSON.stringify(facts))
  } catch {
    // 降级到规则模板
    let s = `截至${new Date().toLocaleDateString('zh-CN')}，组合总市值 ${facts['总市值']}，累计收益 ${facts['累计收益']}（${facts['累计收益率']}）。`
    s += `持仓 ${facts['持仓数量']} 只，${data.bestHolding ? `最佳「${data.bestHolding.name}」，` : ''}${data.worstHolding ? `需关注「${data.worstHolding.name}」。` : ''}`
    s += `\n以上为数据摘要，仅供个人参考，不构成投资建议。`
    return s
  }
}
