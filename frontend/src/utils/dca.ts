// V4-4 智能定投优化。估值定投、止盈回测、目标日期模拟。
// 依赖净值历史序列（NavPoint[]），纯前端计算。

import type { NavPoint } from '@/api/client'

// ── 工具：提取月首净值 ──────────────────────────────
function monthlyNavs(navHistory: NavPoint[]): { date: string; nav: number }[] {
  const byMonth = new Map<string, number>()
  for (const p of navHistory) {
    const ym = p.date.slice(0, 7)
    if (!byMonth.has(ym) && p.nav > 0) byMonth.set(ym, p.nav)
  }
  return [...byMonth.entries()].map(([date, nav]) => ({ date, nav })).sort((a, b) => a.date.localeCompare(b.date))
}

// ── 基础 DCA 结果 ─────────────────────────────────────
export interface DcaResult {
  invested: number; units: number; value: number; profit: number; rate: number
  periods: number; start: string; end: string
}

export function simulateRegularDCA(navHistory: NavPoint[], monthlyAmount: number, months: number, latestNav: number | null): DcaResult | null {
  const mn = monthlyNavs(navHistory).slice(-months)
  if (mn.length < 2) return null
  const lastNav = latestNav ?? mn[mn.length - 1].nav
  let units = 0, invested = 0
  for (const m of mn) { units += monthlyAmount / m.nav; invested += monthlyAmount }
  const value = units * lastNav
  const profit = value - invested
  return {
    invested, units, value, profit,
    rate: invested > 0 ? (profit / invested) * 100 : 0,
    periods: mn.length, start: mn[0].date, end: mn[mn.length - 1].date,
  }
}

// ── 估值定投（基于 MA 偏离度） ──────────────────────
// 偏离 MA 越低 → "估值越低" → 倍投；偏离越高 → "估值越高" → 少投
export interface ValDcaResult extends DcaResult {
  baseAmount: number
  maPeriod: number
  avgMultiplier: number
  detail: { date: string; nav: number; ma: number; dev: number; multiplier: number; units: number }[]
}

export function simulateValueDCA(
  navHistory: NavPoint[],
  baseAmount: number,
  months: number,
  maPeriod: number,
  latestNav: number | null,
): ValDcaResult | null {
  const all = monthlyNavs(navHistory)
  if (all.length < maPeriod + 2) return null
  const slice = all.slice(-months)
  const lastNav = latestNav ?? (slice.length ? slice[slice.length - 1].nav : 0)
  if (!lastNav) return null

  // 计算每月 MA
  const maValues: number[] = []
  for (let i = 0; i < all.length; i++) {
    const start = Math.max(0, i - maPeriod + 1)
    const win = all.slice(start, i + 1)
    maValues.push(win.reduce((s, m) => s + m.nav, 0) / win.length)
  }

  // 建查找表
  const maMap = new Map<string, number>()
  for (let i = 0; i < all.length; i++) maMap.set(all[i].date, maValues[i])

  let units = 0, invested = 0
  const detail: ValDcaResult['detail'] = []
  let totalMult = 0

  for (const m of slice) {
    const ma = maMap.get(m.date) ?? m.nav
    const dev = ma > 0 ? (m.nav - ma) / ma : 0
    // dev < -5% → 2x, dev < -2% → 1.5x, dev > +5% → 0.5x, dev > +2% → 0.75x, else 1x
    let mult: number
    if (dev < -0.08) mult = 2.0
    else if (dev < -0.04) mult = 1.6
    else if (dev < -0.02) mult = 1.3
    else if (dev > 0.08) mult = 0.5
    else if (dev > 0.04) mult = 0.7
    else if (dev > 0.02) mult = 0.85
    else mult = 1.0

    const amt = baseAmount * mult
    units += amt / m.nav
    invested += amt
    totalMult += mult
    detail.push({ date: m.date, nav: m.nav, ma, dev: dev * 100, multiplier: mult, units: amt / m.nav })
  }

  const value = units * lastNav
  const profit = value - invested
  return {
    invested, units, value, profit,
    rate: invested > 0 ? (profit / invested) * 100 : 0,
    periods: slice.length, start: slice[0].date, end: slice[slice.length - 1].date,
    baseAmount, maPeriod,
    avgMultiplier: slice.length > 0 ? totalMult / slice.length : 1,
    detail,
  }
}

// ── 止盈回测 ──────────────────────────────────────────
export interface TakeProfitResult {
  dcaWithoutTP: DcaResult
  withTP: {
    invested: number; totalProfit: number; totalRate: number
    cycles: number; profitTaken: number
    finalValue: number; finalUnits: number
  }
  tpThreshold: number
  cycles: { start: string; end: string; invested: number; profit: number; rate: number }[]
}

export function simulateTakeProfit(
  navHistory: NavPoint[],
  monthlyAmount: number,
  months: number,
  tpThreshold: number,  // e.g., 30 → 30%
  latestNav: number | null,
): TakeProfitResult | null {
  const mn = monthlyNavs(navHistory).slice(-months)
  if (mn.length < 3) return null
  const lastNav = latestNav ?? mn[mn.length - 1].nav

  // 无止盈 DCA
  let units = 0, invested = 0
  for (const m of mn) { units += monthlyAmount / m.nav; invested += monthlyAmount }
  const dcaWithoutTP: DcaResult = {
    invested, units, value: units * lastNav,
    profit: units * lastNav - invested,
    rate: invested > 0 ? ((units * lastNav - invested) / invested) * 100 : 0,
    periods: mn.length, start: mn[0].date, end: mn[mn.length - 1].date,
  }

  // 止盈版：每笔定投独立追踪，达到阈值止盈后重新开始
  let totalInvested = 0, totalProfit = 0, profitTaken = 0
  let activeUnits = 0, activeInvested = 0
  const cycles: TakeProfitResult['cycles'] = []
  let cycleStart = mn[0].date

  // 简化：以总账户视角模拟，到达阈值清仓重新开始
  for (const m of mn) {
    activeUnits += monthlyAmount / m.nav
    activeInvested += monthlyAmount
    totalInvested += monthlyAmount

    const curValue = activeUnits * m.nav
    const curProfit = curValue - activeInvested
    const curRate = activeInvested > 0 ? (curProfit / activeInvested) * 100 : 0

    if (curRate >= tpThreshold) {
      profitTaken += curProfit
      totalProfit += curProfit
      cycles.push({
        start: cycleStart, end: m.date,
        invested: activeInvested, profit: curProfit, rate: curRate,
      })
      activeUnits = 0; activeInvested = 0
      cycleStart = m.date
    }
  }

  // 最后一轮未止盈
  if (activeUnits > 0) {
    const finalValue = activeUnits * lastNav
    const finalProfit = finalValue - activeInvested
    totalProfit += finalProfit
    cycles.push({
      start: cycleStart, end: mn[mn.length - 1].date,
      invested: activeInvested, profit: finalProfit,
      rate: activeInvested > 0 ? (finalProfit / activeInvested) * 100 : 0,
    })
  }

  return {
    dcaWithoutTP,
    withTP: {
      invested: totalInvested,
      totalProfit,
      totalRate: totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0,
      cycles: cycles.length, profitTaken,
      finalValue: activeUnits * lastNav,
      finalUnits: activeUnits,
    },
    tpThreshold,
    cycles,
  }
}

// ── 目标日期：时间段内所有可能起点的 DCA 收益分布 ──────────
export interface TargetDateResult {
  range: { start: string; end: string }
  scenarios: { start: string; invested: number; value: number; rate: number }[]
  best: { start: string; rate: number }
  worst: { start: string; rate: number }
  median: number
  winRate: number  // % of scenarios with positive return
}

export function simulateTargetDate(
  navHistory: NavPoint[],
  monthlyAmount: number,
  investMonths: number,  // how many months to invest each time
  latestNav: number | null,
): TargetDateResult | null {
  const all = monthlyNavs(navHistory)
  if (all.length < investMonths + 3) return null
  const lastNav = latestNav ?? all[all.length - 1].nav

  const scenarios: TargetDateResult['scenarios'] = []
  const maxStart = all.length - investMonths

  for (let i = 0; i <= maxStart; i++) {
    const slice = all.slice(i, i + investMonths)
    let units = 0, invested = 0
    for (const m of slice) { units += monthlyAmount / m.nav; invested += monthlyAmount }
    const value = units * lastNav
    const rate = invested > 0 ? ((value - invested) / invested) * 100 : 0
    scenarios.push({ start: slice[0].date, invested, value, rate })
  }

  const sorted = [...scenarios].sort((a, b) => a.rate - b.rate)
  const median = sorted[Math.floor(sorted.length / 2)].rate
  const best = scenarios.reduce((a, b) => (b.rate > a.rate ? b : a))
  const worst = scenarios.reduce((a, b) => (b.rate < a.rate ? b : a))
  const winRate = (scenarios.filter((s) => s.rate > 0).length / scenarios.length) * 100

  return {
    range: { start: all[0].date, end: all[all.length - 1].date },
    scenarios, best, worst, median, winRate,
  }
}
