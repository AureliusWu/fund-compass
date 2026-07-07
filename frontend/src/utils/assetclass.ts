// 大类资产（V3-13）。将基金类型映射到五大资产类别，计算组合的大类配置。
// 大类：权益 / 固收 / 混合 / 海外 / 现金 / 商品

export type AssetClass = '权益' | '固收' | '混合' | '海外' | '现金' | '商品'

export interface ClassAllocation { cls: AssetClass; value: number; pct: number; funds: number }
export interface AssetClassSummary { classes: ClassAllocation[]; totalValue: number; tip?: string }

/** 基金类型 → 大类资产映射 */
export function classifyFundType(type: string | null): { cls: AssetClass; detail: string } {
  if (!type) return { cls: '混合', detail: '未知类型归入混合' }
  const t = type.replace(/\s/g, '')
  if (t === '现金' || t.includes('现金')) return { cls: '现金', detail: t }
  if (t === '股票' || t.includes('股票资产')) return { cls: '权益', detail: t }
  if (t === '黄金' || t.includes('黄金') || t.includes('商品')) return { cls: '商品', detail: t }

  // 权益类
  if (t.includes('股票型') || t.includes('指数型')) return { cls: '权益', detail: t }
  if (t.includes('ETF')) return { cls: '权益', detail: 'ETF（按权益计）' }

  // 固收类
  if (t.includes('债券型') || t.includes('债')) return { cls: '固收', detail: t }
  if (t.includes('货币型') || t.includes('货币')) return { cls: '现金', detail: t }

  // 海外
  if (t.includes('QDII')) return { cls: '海外', detail: t }

  // 混合型 → 按子类细分
  if (t.includes('混合型')) {
    if (t.includes('偏股')) return { cls: '权益', detail: '混合型-偏股→权益' }
    if (t.includes('偏债')) return { cls: '固收', detail: '混合型-偏债→固收' }
    return { cls: '混合', detail: t }
  }

  // FOF
  if (t.includes('FOF')) return { cls: '混合', detail: 'FOF' }

  // 默认
  return { cls: '混合', detail: t }
}

/** 推荐的大类配置比例（参考：股债 60/40 基准） */
export const REFERENCE_ALLOCATION: Record<AssetClass, number> = {
  权益: 55, 固收: 25, 混合: 5, 海外: 5, 现金: 5, 商品: 5,
}

/** 计算大类资产配置 */
export function computeAssetClass(holdings: {
  value: number
  type: string
}[]): AssetClassSummary {
  const totalValue = holdings.reduce((s, h) => s + h.value, 0)
  if (!totalValue) return { classes: [], totalValue: 0 }

  const map = new Map<AssetClass, { value: number; funds: Set<string> }>()
  const init = (c: AssetClass) => { if (!map.has(c)) map.set(c, { value: 0, funds: new Set() }) }

  for (const h of holdings) {
    const { cls } = classifyFundType(h.type)
    init(cls)
    const g = map.get(cls)!
    g.value += h.value
  }

  const classes: ClassAllocation[] = []
  for (const [cls, v] of map) {
    classes.push({ cls, value: v.value, pct: totalValue > 0 ? (v.value / totalValue) * 100 : 0, funds: 0 })
  }

  // 排序：权益 > 固收 > 混合 > 海外 > 现金 > 商品
  const order: AssetClass[] = ['权益', '固收', '混合', '海外', '现金', '商品']
  classes.sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls))

  // 诊断提示
  const equityPct = classes.find((c) => c.cls === '权益')?.pct || 0
  const fixedPct = classes.find((c) => c.cls === '固收')?.pct || 0
  const cashPct = classes.find((c) => c.cls === '现金')?.pct || 0
  let tip = ''
  if (equityPct > 85) tip = '权益仓位较高，波动可能偏大'
  else if (equityPct < 30) tip = '权益仓位偏低，长期收益可能不足'
  else if (cashPct > 20) tip = '现金类占比偏高，收益可能被通胀侵蚀'
  else if (equityPct >= 40 && fixedPct >= 20) tip = '大类配置较为均衡'

  return { classes, totalValue, tip }
}

/** 大类颜色 */
export const CLASS_COLORS: Record<AssetClass, string> = {
  权益: '#ee0a24', 固收: '#0f9d75', 混合: '#ff976a', 海外: '#1989fa', 现金: '#969799', 商品: '#C8A75B',
}
