// 智能解读（双模式）。
// B 规则模板：把评分四维 / 三层信号 / 回测合成中文点评，纯前端、免费、离线、稳定。
// A LLM：用用户自带 Anthropic key（存本机），浏览器直连 api.anthropic.com，措辞更自然。
import type { FundDetail, ScoreResp, SignalResp, BacktestResp } from '@/api/client'
import { chat } from './ai'

export interface InterpSection { h: string; t: string }
export interface Interpretation { verdict: string; tone: 'good' | 'mid' | 'weak'; sections: InterpSection[] }

function pctStr(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

// ── B：规则模板解读 ───────────────────────────────────────
export function templateInterpret(
  detail: FundDetail, score: ScoreResp | null, signal: SignalResp | null, bt: BacktestResp | null,
): Interpretation {
  const sections: InterpSection[] = []
  const s = score?.score ?? null

  // 1. 总评
  let tone: 'good' | 'mid' | 'weak' = 'mid'
  let verdict = '数据有限，建议结合更多信息判断。'
  if (s != null) {
    if (s >= 75) { tone = 'good'; verdict = `综合评分 ${s}，在同类中表现优秀。` }
    else if (s >= 55) { tone = 'mid'; verdict = `综合评分 ${s}，整体中规中矩。` }
    else { tone = 'weak'; verdict = `综合评分 ${s}，相对偏弱，需谨慎。` }
  }
  if (score?.rank_in_type && score?.rank_total) {
    const p = Math.max(1, Math.round((score.rank_in_type / score.rank_total) * 100))
    verdict += ` 同类排名前 ${p}%（${score.rank_in_type}/${score.rank_total}）。`
  }

  // 2. 评分拆解：最强 / 最弱维度
  if (score?.components) {
    const NM: Record<string, string> = { return: '收益', risk: '风险控制', management: '管理', cost: '成本' }
    const arr = (Object.entries(score.components) as [string, { score: number | null; weight: number }][])
      .map(([k, c]) => ({ k, name: NM[k] || k, v: c.score }))
      .filter((x): x is { k: string; name: string; v: number } => x.v != null)
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
  sections.push({ h: '收益与管理', t: `${rets}。${mgr}${detail.scale != null ? `规模约 ${detail.scale} 亿。` : ''}` })

  // 4. 择时信号
  if (signal) {
    let t = `当前信号「${signal.signal}」。`
    const L = signal.layers
    const bits: string[] = []
    if (L?.valuation?.label) {
      const v = L.valuation
      if (v.source === 'index_pe_pb' && v.index_name) {
        bits.push(`估值${v.label}（${v.index_name} PE${v.pe} 分位${v.pe_pct}%）`)
      } else if (v.percentile != null) {
        bits.push(`估值${v.label}（分位 ${v.percentile}）`)
      } else {
        bits.push(`估值${v.label}`)
      }
    }
    if (L?.trend?.label) bits.push(`趋势${L.trend.label}`)
    if (L?.sentiment?.label) bits.push(`情绪${L.sentiment.label}${L.sentiment.rsi != null ? `（RSI ${L.sentiment.rsi}）` : ''}`)
    if (bits.length) t += bits.join('、') + '。'
    if (signal.advice) t += signal.advice
    sections.push({ h: '择时信号', t })
  }

  // 5. 回测验证
  if (bt?.available && bt.strategy && bt.benchmark) {
    const out = bt.outperform ?? 0
    let t = `历史回测：择时策略 ${pctStr(bt.strategy.total_return)}（回撤 ${bt.strategy.max_drawdown}%）vs 一直持有 ${pctStr(bt.benchmark.total_return)}（回撤 ${bt.benchmark.max_drawdown}%）。`
    if (out > 0) t += `策略跑赢 ${pctStr(out)}，胜率 ${bt.win_rate}%。`
    else t += `策略未跑赢持有（${pctStr(out)}）——对该基金择时不如长期持有，强趋势品种尤其如此。`
    sections.push({ h: '回测验证', t })
  }

  // 6. 操作建议
  const sig = signal?.signal
  let op: string
  if (s == null) op = '数据不足，建议补充信息后再决策。'
  else if (s >= 70 && (sig === '买入' || sig === '定投')) op = '基本面较好且信号偏积极，可考虑分批 / 定投介入，避免一次性追高。'
  else if (s >= 70 && sig === '减仓') op = '基本面尚可但当前位置偏高，已持有可考虑逢高减仓、落袋部分收益。'
  else if (s >= 55) op = '中等品种，适合小仓位定投跟踪，不宜重仓押注。'
  else op = '评分偏弱，建议观望或寻找同类更优标的，谨慎参与。'
  sections.push({ h: '操作建议', t: op })

  return { verdict, tone, sections }
}

// ── A：LLM 解读（用户自带 Key，浏览器直连，Provider 见 utils/ai）──────
export async function llmInterpret(
  detail: FundDetail, score: ScoreResp | null, signal: SignalResp | null, bt: BacktestResp | null,
): Promise<string> {
  const comp = score?.components
  const facts = {
    名称: detail.name, 类型: detail.type, 规模亿: detail.scale,
    经理: detail.manager, 任职: detail.manager_worktime,
    收益: { 近1月: detail.ret_1m, 近6月: detail.ret_6m, 近1年: detail.ret_1y, 近3年: detail.ret_3y },
    同类排名: score?.rank_in_type && score?.rank_total ? `${score.rank_in_type}/${score.rank_total}` : null,
    综合评分: score?.score,
    评分四维: comp ? { 收益: comp.return?.score, 风险: comp.risk?.score, 管理: comp.management?.score, 成本: comp.cost?.score } : null,
    择时信号: signal?.signal,
    三层: signal?.layers ? { 估值: signal.layers.valuation?.label, 趋势: signal.layers.trend?.label, 情绪: signal.layers.sentiment?.label } : null,
    回测: bt?.available ? { 策略收益: bt.strategy?.total_return, 持有收益: bt.benchmark?.total_return, 超额: bt.outperform, 胜率: bt.win_rate } : null,
  }

  const system =
    '你是中立的基金数据解读助手，面向个人投资者。基于给定数据用简体中文写一段 150–250 字的点评：' +
    '先给总体判断，再点出收益 / 风险 / 择时 / 回测的要点，最后给一句操作倾向。' +
    '口吻客观克制，不夸大、不做收益承诺，不构成投资建议。不要罗列原始字段，要像分析师口吻自然成段。' +
    '结尾另起一行加：「以上为数据解读，仅供个人参考，不构成投资建议。」'

  return chat(system, '基金数据：\n' + JSON.stringify(facts))
}
