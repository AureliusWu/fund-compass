// 收益归因（V3-8）。基于持仓数据分解组合收益来源：
// - 个基贡献度（仓位 × 涨跌）
// - 账户/类型归因
// - 集中度风险提示

export interface HoldingAttribution {
  code: string
  name: string
  account: string
  type: string
  weight: number       // 占组合权重 %
  dayReturn: number | null  // 今日涨跌 %
  dayContrib: number | null // 今日贡献 bps
  totalReturn: number | null // 持仓以来收益 %
  totalContrib: number | null // 累计贡献 bps
  profitAmt: number    // 盈利金额
}

export interface AttributionSummary {
  holdings: HoldingAttribution[]
  bestDay: HoldingAttribution | null
  worstDay: HoldingAttribution | null
  bestTotal: HoldingAttribution | null
  worstTotal: HoldingAttribution | null
  concentration: { top1: number; top3: number; top5: number } // 集中度
  byAccount: { account: string; dayContrib: number; totalContrib: number; weight: number }[]
  byType: { type: string; dayContrib: number; totalContrib: number; weight: number }[]
}

/** 计算个基收益归因 */
export function computeAttribution(holdings: {
  code: string; name: string; account: string; type: string
  shares: number; cost: number; nav: number | null
  value: number; profit: number; today: number | null
  todayPct?: number | null  // 今日涨跌 %
}[]): AttributionSummary {
  const totalValue = holdings.reduce((s, h) => s + h.value, 0)
  if (!totalValue) return { holdings: [], bestDay: null, worstDay: null, bestTotal: null, worstTotal: null, concentration: { top1: 0, top3: 0, top5: 0 }, byAccount: [], byType: [] }

  const attr: HoldingAttribution[] = holdings.map((h) => {
    const weight = totalValue > 0 ? (h.value / totalValue) * 100 : 0
    const dayReturn = h.todayPct ?? null
    // 日贡献（bps）：权重 × 日收益 / 100
    const dayContrib = dayReturn != null ? weight * dayReturn / 100 : null
    // 累计收益率
    const costBasis = h.shares * h.cost
    const totalReturn = costBasis > 0 ? (h.profit / costBasis) * 100 : null
    // 累计贡献 = 权重的加权平均
    const totalContrib = totalReturn != null ? weight * totalReturn / 100 : null
    return { code: h.code, name: h.name || h.code, account: h.account, type: h.type, weight, dayReturn, dayContrib, totalReturn, totalContrib, profitAmt: h.profit }
  })

  const sortedDay = [...attr].filter((a) => a.dayReturn != null).sort((a, b) => (b.dayReturn!) - (a.dayReturn!))
  const sortedTotal = [...attr].filter((a) => a.totalReturn != null).sort((a, b) => (b.totalReturn!) - (a.totalReturn!))

  // 集中度（按权重降序）
  const byWeight = [...attr].sort((a, b) => b.weight - a.weight)
  const topN = (n: number) => byWeight.slice(0, n).reduce((s, a) => s + a.weight, 0)

  // 按账户汇总
  const acctMap = new Map<string, { dayContrib: number; totalContrib: number; weight: number }>()
  for (const a of attr) {
    const g = acctMap.get(a.account) || { dayContrib: 0, totalContrib: 0, weight: 0 }
    g.weight += a.weight
    if (a.dayContrib != null) g.dayContrib += a.dayContrib
    if (a.totalContrib != null) g.totalContrib += a.totalContrib
    acctMap.set(a.account, g)
  }

  // 按类型汇总
  const typeMap = new Map<string, { dayContrib: number; totalContrib: number; weight: number }>()
  for (const a of attr) {
    const g = typeMap.get(a.type) || { dayContrib: 0, totalContrib: 0, weight: 0 }
    g.weight += a.weight
    if (a.dayContrib != null) g.dayContrib += a.dayContrib
    if (a.totalContrib != null) g.totalContrib += a.totalContrib
    typeMap.set(a.type, g)
  }

  return {
    holdings: attr,
    bestDay: sortedDay[0] || null,
    worstDay: sortedDay[sortedDay.length - 1] || null,
    bestTotal: sortedTotal[0] || null,
    worstTotal: sortedTotal[sortedTotal.length - 1] || null,
    concentration: { top1: topN(1), top3: topN(3), top5: topN(5) },
    byAccount: [...acctMap.entries()].map(([k, v]) => ({ account: k, ...v })).sort((a, b) => b.weight - a.weight),
    byType: [...typeMap.entries()].map(([k, v]) => ({ type: k, ...v })).sort((a, b) => b.weight - a.weight),
  }
}
