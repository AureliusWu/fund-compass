// V4-2 策略回测实验室。增强回测分析：年度收益拆解、滚动指标、DCA 对比、参数灵敏度。
// 后端提供原始回测曲线（strategy / benchmark），前端做进一步计算与可视化。

import type { BacktestResp, NavPoint, BtSeries } from '@/api/client'

// ── 年度收益拆解 ──────────────────────────────────────
export interface AnnualReturn { year: number; strategy: number | null; benchmark: number | null; excess: number | null }
export function annualReturns(bt: BacktestResp): AnnualReturn[] {
  const sc = bt.strategy?.curve
  const bc = bt.benchmark?.curve
  if (!sc || sc.length < 2) return []

  const byYear = new Map<number, { sStart: number; sEnd: number; bStart: number; bEnd: number }>()
  for (let i = 0; i < sc.length; i++) {
    const yr = parseInt(sc[i].date.slice(0, 4))
    if (!byYear.has(yr)) {
      byYear.set(yr, {
        sStart: sc[i].v, sEnd: sc[i].v,
        bStart: bc?.[i]?.v ?? sc[i].v, bEnd: bc?.[i]?.v ?? sc[i].v,
      })
    }
    const e = byYear.get(yr)!
    e.sEnd = sc[i].v
    if (bc?.[i]) e.bEnd = bc[i].v
  }

  const out: AnnualReturn[] = []
  for (const [yr, v] of byYear) {
    const sr = v.sStart > 0 ? ((v.sEnd - v.sStart) / v.sStart) * 100 : null
    const br = v.bStart > 0 ? ((v.bEnd - v.bStart) / v.bStart) * 100 : null
    out.push({
      year: yr,
      strategy: sr,
      benchmark: br,
      excess: sr != null && br != null ? sr - br : null,
    })
  }
  out.sort((a, b) => a.year - b.year)
  return out
}

// ── 从曲线计算滚动指标（12 个月窗口） ──────────────────
export interface RollingPoint { date: string; ret: number | null; sharpe: number | null; drawdown: number | null }
export function rollingMetrics(curve: { date: string; v: number }[], windowMonths = 12): RollingPoint[] {
  if (curve.length < 22) return []

  // 先算月度收益序列
  const monthly: { date: string; ret: number }[] = []
  let prevMonth = ''
  let monthStartV = curve[0].v
  for (const p of curve) {
    const m = p.date.slice(0, 7)
    if (m !== prevMonth) {
      if (prevMonth && monthStartV > 0) {
        monthly.push({ date: prevMonth, ret: (p.v - monthStartV) / monthStartV })
      }
      prevMonth = m
      monthStartV = p.v
    }
  }
  // 最后一个月
  if (prevMonth && monthStartV > 0) {
    const last = curve[curve.length - 1].v
    monthly.push({ date: prevMonth, ret: (last - monthStartV) / monthStartV })
  }

  if (monthly.length < windowMonths) return []

  const out: RollingPoint[] = []
  for (let i = windowMonths - 1; i < monthly.length; i++) {
    const win = monthly.slice(i - windowMonths + 1, i + 1).map((m) => m.ret)
    const avg = win.reduce((a, b) => a + b, 0) / win.length
    const std = Math.sqrt(win.reduce((s, r) => s + (r - avg) ** 2, 0) / win.length)
    const sharpe = std > 0 ? (avg / std) * Math.sqrt(12) : 0

    // 从曲线找窗口内的最大回撤
    const startIdx = curve.findIndex((p) => p.date.slice(0, 7) === monthly[i - windowMonths + 1].date)
    const endIdx = curve.findIndex((p) => p.date.slice(0, 7) === monthly[i].date)
    let peak = 0, dd = 0
    for (let j = Math.max(0, startIdx); j <= Math.min(curve.length - 1, endIdx); j++) {
      if (curve[j].v > peak) peak = curve[j].v
      const d = peak > 0 ? (peak - curve[j].v) / peak : 0
      if (d > dd) dd = d
    }

    out.push({ date: monthly[i].date, ret: avg * 12, sharpe, drawdown: dd })
  }
  return out
}

// ── 定投模拟（从回测区间） ──────────────────────────────
export interface DcaResult { invested: number; units: number; value: number; profit: number; rate: number; periods: number }
export function simulateDCA(curve: { date: string; v: number }[], monthlyAmount: number): DcaResult {
  // 每月首个交易日定投
  const byMonth = new Map<string, number>() // ym → first nav
  for (const p of curve) {
    const ym = p.date.slice(0, 7)
    if (!byMonth.has(ym) && p.v > 0) byMonth.set(ym, p.v)
  }

  let units = 0, invested = 0
  for (const [, nav] of byMonth) {
    units += monthlyAmount / nav
    invested += monthlyAmount
  }

  const lastNav = curve[curve.length - 1]?.v ?? 0
  const value = units * lastNav
  const profit = value - invested
  return {
    invested, units, value, profit,
    rate: invested > 0 ? (profit / invested) * 100 : 0,
    periods: byMonth.size,
  }
}

// ── 参数扫描：不同 MA 周期下的策略表现 ──────────────────
export interface ParamSweep { period: number; ret: number; sharpe: number; drawdown: number }
export function sweepMAPeriod(navHistory: NavPoint[], periods: number[]): ParamSweep[] {
  if (navHistory.length < Math.max(...periods) + 1) return []

  const navs = navHistory.map((p) => p.nav)
  const dates = navHistory.map((p) => p.date)

  return periods.map((ma) => {
    const curve: { date: string; v: number }[] = []
    let cash = 1, units = 0
    let peak = 0, maxDD = 0

    for (let i = ma; i < navs.length; i++) {
      const avg = navs.slice(i - ma, i).reduce((a, b) => a + b, 0) / ma
      const signal = navs[i] > avg ? 'buy' : 'sell' // 价格 > MA → 持有，< MA → 现金

      if (signal === 'buy' && cash > 0) {
        units = cash / navs[i]
        cash = 0
      } else if (signal === 'sell' && units > 0) {
        cash = units * navs[i]
        units = 0
      }

      const total = cash + units * navs[i]
      curve.push({ date: dates[i], v: total })
      if (total > peak) peak = total
      const dd = peak > 0 ? (peak - total) / peak : 0
      if (dd > maxDD) maxDD = dd
    }

    const totalRet = ((cash + units * navs[navs.length - 1]) - 1) * 100
    const n = curve.length

    // 简易夏普
    const dailyRets: number[] = []
    for (let i = 1; i < n; i++) {
      if (curve[i - 1].v > 0) dailyRets.push((curve[i].v - curve[i - 1].v) / curve[i - 1].v)
    }
    const avgR = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length
    const stdR = Math.sqrt(dailyRets.reduce((s, r) => s + (r - avgR) ** 2, 0) / dailyRets.length)
    const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(252) : 0

    return { period: ma, ret: totalRet, sharpe, drawdown: maxDD * 100 }
  })
}

// ── 回测摘要卡片 ──────────────────────────────────────
export interface BacktestSummary {
  strategyRet: number | null
  benchmarkRet: number | null
  excess: number | null
  strategyDD: number | null
  benchmarkDD: number | null
  winRate: number | null
  sharpe: number | null
  annualRet: number | null
  bestYear: AnnualReturn | null
  worstYear: AnnualReturn | null
}

export function computeSummary(bt: BacktestResp): BacktestSummary {
  const ann = annualReturns(bt)
  const best = ann.length ? ann.reduce((a, b) => ((b.strategy ?? -Infinity) > (a.strategy ?? -Infinity) ? b : a)) : null
  const worst = ann.length ? ann.reduce((a, b) => ((b.strategy ?? Infinity) < (a.strategy ?? Infinity) ? b : a)) : null

  // 从曲线推算年化
  const sc = bt.strategy?.curve
  let annRet: number | null = null
  if (sc && sc.length >= 2) {
    const years = (new Date(sc[sc.length - 1].date).getTime() - new Date(sc[0].date).getTime()) / (365.25 * 864e5)
    if (years > 0.2 && sc[0].v > 0) {
      annRet = (Math.pow(sc[sc.length - 1].v / sc[0].v, 1 / years) - 1) * 100
    }
  }

  // 简易夏普
  let sharpe: number | null = null
  if (sc && sc.length > 30) {
    const dailyRets: number[] = []
    for (let i = 1; i < sc.length; i++) {
      if (sc[i - 1].v > 0) dailyRets.push((sc[i].v - sc[i - 1].v) / sc[i - 1].v)
    }
    const avgR = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length
    const stdR = Math.sqrt(dailyRets.reduce((s, r) => s + (r - avgR) ** 2, 0) / dailyRets.length)
    sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(252) : null
  }

  return {
    strategyRet: bt.strategy?.total_return ?? null,
    benchmarkRet: bt.benchmark?.total_return ?? null,
    excess: bt.outperform ?? null,
    strategyDD: bt.strategy?.max_drawdown ?? null,
    benchmarkDD: bt.benchmark?.max_drawdown ?? null,
    winRate: bt.win_rate ?? null,
    sharpe,
    annualRet: annRet,
    bestYear: best,
    worstYear: worst,
  }
}
