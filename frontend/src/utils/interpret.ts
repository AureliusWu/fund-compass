// 规则解读：在数据覆盖与时效门禁内，合成离线中文点评。
// 自由文本 AI 暂停，避免未经核验的金融数字与操作倾向。
import type { FundDetail, ScoreResp, SignalResp, BacktestResp } from '@/api/client'
import { FREE_TEXT_AI_UNAVAILABLE } from './ai'

export interface InterpSection { h: string; t: string }
export interface Interpretation { verdict: string; tone: 'good' | 'mid' | 'weak'; sections: InterpSection[] }

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function pctStr(n: number | null | undefined): string {
  if (!finite(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

function scalarStr(n: unknown): string {
  return finite(n) ? String(n) : '—'
}

// ── B：规则模板解读 ───────────────────────────────────────
export function templateInterpret(
  detail: FundDetail, score: ScoreResp | null, signal: SignalResp | null, bt: BacktestResp | null,
): Interpretation {
  const sections: InterpSection[] = []
  const currentDataEligible = score?.eligible === true
    && finite(score.coverage) && score.coverage >= 0.7 && score.coverage <= 1
    && (!signal || (finite(signal.coverage) && signal.coverage >= 0.7 && signal.coverage <= 1))
    && !score.data_stale && !detail.stale && !signal?.data_stale
  const s = currentDataEligible && finite(score?.score) && score.score >= 0 && score.score <= 100
    ? score.score : null

  // 1. 总评
  let tone: 'good' | 'mid' | 'weak' = 'mid'
  let verdict = '数据不足或已过期，暂不作当前评分与操作倾向判断。'
  if (s != null) {
    if (s >= 75) { tone = 'good'; verdict = `综合评分 ${s}，在同类中表现优秀。` }
    else if (s >= 55) { tone = 'mid'; verdict = `综合评分 ${s}，整体中规中矩。` }
    else { tone = 'weak'; verdict = `综合评分 ${s}，相对偏弱，需谨慎。` }
  }
  if (s != null && finite(score?.rank_in_type) && finite(score?.rank_total)
    && Number.isInteger(score.rank_in_type) && Number.isInteger(score.rank_total)
    && score.rank_in_type >= 1 && score.rank_total >= score.rank_in_type) {
    const p = Math.max(1, Math.round((score.rank_in_type / score.rank_total) * 100))
    verdict += ` 同类排名前 ${p}%（${score.rank_in_type}/${score.rank_total}）。`
  }

  // 2. 评分拆解：最强 / 最弱维度
  if (s != null && score?.components) {
    const NM: Record<string, string> = { return: '收益', risk: '风险控制', management: '管理', cost: '成本' }
    const arr = (Object.entries(score.components) as [string, { score: number | null; weight: number }][])
      .map(([k, c]) => ({ k, name: NM[k] || k, v: c.score }))
      .filter((x): x is { k: string; name: string; v: number } => finite(x.v) && x.v >= 0 && x.v <= 100)
    if (arr.length) {
      const best = arr.reduce((a, b) => (b.v > a.v ? b : a))
      const worst = arr.reduce((a, b) => (b.v < a.v ? b : a))
      let t = `四维里 ${best.name} 最突出（${Math.round(best.v)} 分）`
      if (worst.k !== best.k) t += `，${worst.name} 最弱（${Math.round(worst.v)} 分）`
      t += '。权重：收益 40%、风险 30%、管理 20%、成本 10%。'
      sections.push({ h: '评分拆解', t })
    }
  }

  // 3. 收益与管理
  const rets = `近1月 ${pctStr(detail.ret_1m)}、近6月 ${pctStr(detail.ret_6m)}、近1年 ${pctStr(detail.ret_1y)}、近3年 ${pctStr(detail.ret_3y)}`
  const mgr = detail.manager
    ? `现任经理 ${detail.manager}${detail.manager_worktime ? `（任职 ${detail.manager_worktime}）` : ''}。`
    : ''
  const historyNote = detail.stale ? `历史缓存（${detail.updated_at || detail.latest_nav_date || '时间未知'}），不代表当前数据。` : ''
  sections.push({ h: '收益与管理', t: `${historyNote}${rets}。${mgr}${finite(detail.scale) ? `规模约 ${detail.scale} 亿。` : ''}` })

  // 4. 择时信号
  if (signal && s == null) {
    sections.push({ h: '择时信号', t: '数据不足或已过期，暂停当前择时信号与操作倾向解读。' })
  } else if (signal) {
    let t = `当前信号「${signal.signal}」。`
    const L = signal.layers
    const bits: string[] = []
    if (L?.valuation?.label) {
      const v = L.valuation
      if (v.source === 'index_pe_pb' && v.index_name) {
        bits.push(`估值${v.label}（${v.index_name} PE ${scalarStr(v.pe)}，分位 ${finite(v.pe_pct) ? v.pe_pct + '%' : '—'}）`)
      } else if (finite(v.percentile)) {
        bits.push(`估值${v.label}（分位 ${v.percentile}）`)
      } else {
        bits.push(`估值${v.label}`)
      }
    }
    if (L?.trend?.label) bits.push(`趋势${L.trend.label}`)
    if (L?.sentiment?.label) bits.push(`情绪${L.sentiment.label}${finite(L.sentiment.rsi) ? `（RSI ${L.sentiment.rsi}）` : ''}`)
    if (bits.length) t += bits.join('、') + '。'
    if (signal.advice) t += signal.advice
    sections.push({ h: '择时信号', t })
  }

  // 5. 回测验证
  if (bt?.available && bt.strategy && bt.benchmark) {
    const out = bt.outperform
    let t = `历史回测：择时策略 ${pctStr(bt.strategy.total_return)}（回撤 ${finite(bt.strategy.max_drawdown) ? bt.strategy.max_drawdown + '%' : '—'}）vs 一直持有 ${pctStr(bt.benchmark.total_return)}（回撤 ${finite(bt.benchmark.max_drawdown) ? bt.benchmark.max_drawdown + '%' : '—'}）。`
    if (!finite(out)) t += '超额收益数据不足，暂不比较策略优劣。'
    else if (out > 0) t += `本次历史回测区间策略超额 ${pctStr(out)}。`
    else if (out === 0) t += '本次历史回测区间与一直持有收益相同（+0.00%）。'
    else t += `本次历史回测区间策略低于一直持有 ${pctStr(out)}。`
    if (finite(bt.win_rate) && bt.win_rate >= 0 && bt.win_rate <= 100) t += `胜率 ${bt.win_rate}%。`
    t += '历史回测不代表未来表现。'
    sections.push({ h: '回测验证', t })
  }

  // 6. 操作建议
  const sig = signal?.signal
  let op: string
  if (s == null) op = '数据不足或已过期，暂不提供操作倾向；请补充有效数据后再判断。'
  else if (s >= 70 && (sig === '买入' || sig === '定投')) op = '基本面较好且信号偏积极，可考虑分批 / 定投介入，避免一次性追高。'
  else if (s >= 70 && sig === '减仓') op = '基本面尚可但当前位置偏高，已持有可考虑逢高减仓、落袋部分收益。'
  else if (s >= 55) op = '中等品种，适合小仓位定投跟踪，不宜重仓押注。'
  else op = '评分偏弱，建议观望或寻找同类更优标的，谨慎参与。'
  sections.push({ h: '操作建议', t: op })

  return { verdict, tone, sections }
}

// 保留调用边界，暂停期间即使被直接调用也不得发送模型请求。
export async function llmInterpret(
  _detail: FundDetail, _score: ScoreResp | null, _signal: SignalResp | null, _bt: BacktestResp | null,
): Promise<string> {
  throw new Error(FREE_TEXT_AI_UNAVAILABLE)
}
