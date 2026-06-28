// V4-3 组合诊断报告。相关性矩阵、压力测试、风格箱、再平衡路线图。
// 依赖持仓基金的净值序列（从缓存 FundDetail.nav_history 取）。

import { getFundDetail, type NavPoint } from '@/api/client'

// ── 相关性矩阵 ─────────────────────────────────────────
export interface CorrItem { a: string; b: string; aName: string; bName: string; corr: number }
export interface CorrMatrix { funds: { code: string; name: string }[]; matrix: number[][]; pairs: CorrItem[] }

/** 计算两只基金净值序列的皮尔逊相关系数 */
function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 10) return null
  const x = xs.slice(-n), y = ys.slice(-n)
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let cov = 0, vx = 0, vy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my
    cov += dx * dy; vx += dx * dx; vy += dy * dy
  }
  if (vx === 0 || vy === 0) return null
  return cov / Math.sqrt(vx * vy)
}

/** 从缓存或后端获取持有基金的净值 */
async function fetchNavMap(holdings: { code: string }[]): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>()
  const tasks = holdings.map(async (h) => {
    try {
      const d = await getFundDetail(h.code)
      if (d?.nav_history?.length) {
        map.set(h.code, d.nav_history.map((p: NavPoint) => p.nav))
      }
    } catch { /* skip */ }
  })
  await Promise.all(tasks)
  return map
}

export async function computeCorrelation(
  holdings: { code: string; name: string }[],
): Promise<CorrMatrix | null> {
  if (holdings.length < 2) return null

  const navMap = await fetchNavMap(holdings)
  const codes = holdings.filter((h) => navMap.has(h.code))
  if (codes.length < 2) return null

  const matrix: number[][] = []
  const pairs: CorrItem[] = []

  for (let i = 0; i < codes.length; i++) {
    matrix[i] = []
    matrix[i][i] = 1
    for (let j = i + 1; j < codes.length; j++) {
      const c = pearson(navMap.get(codes[i].code)!, navMap.get(codes[j].code)!)
      matrix[i][j] = c ?? 0
      matrix[j][i] = c ?? 0
      if (c != null) {
        pairs.push({ a: codes[i].code, b: codes[j].code, aName: codes[i].name, bName: codes[j].name, corr: c })
      }
    }
  }

  return { funds: codes.map((h) => ({ code: h.code, name: h.name })), matrix, pairs }
}

// ── 压力测试 ───────────────────────────────────────────
export interface StressScenario { name: string; desc: string; equityDrop: number; bondReturn: number; goldReturn: number; overseas: number }
export interface StressResult { name: string; desc: string; pnl: number; pnlPct: number; detail: string }

// A 股历史上几次著名回撤场景（简化模型
const SCENARIOS: StressScenario[] = [
  { name: '2015 股灾', desc: '沪深300 -35%，债市 +3%', equityDrop: -35, bondReturn: 3, goldReturn: 0, overseas: -15 },
  { name: '2018 熊市', desc: '沪深300 -25%，债市 +8%', equityDrop: -25, bondReturn: 8, goldReturn: 5, overseas: -10 },
  { name: '2020 新冠', desc: '沪深300 -15%（V型恢复），债市 +2%', equityDrop: -15, bondReturn: 2, goldReturn: 8, overseas: -20 },
  { name: '2022 调整', desc: '沪深300 -21%，债市 +1%', equityDrop: -21, bondReturn: 1, goldReturn: -2, overseas: -18 },
  { name: '温和下跌', desc: '权益 -10%，其余不变', equityDrop: -10, bondReturn: 0, goldReturn: 2, overseas: -5 },
  { name: '极端风险', desc: '权益 -50%，海外 -40%，仅债市 +2%', equityDrop: -50, bondReturn: 2, goldReturn: -10, overseas: -40 },
]

/** 基于大类资产配置做压力测试 */
export function stressTest(
  allocations: { equityPct: number; bondPct: number; cashPct: number; overseasPct: number; totalValue: number },
): StressResult[] {
  const { equityPct, bondPct, cashPct, overseasPct, totalValue } = allocations
  return SCENARIOS.map((sc) => {
    const pnl = totalValue * (
      (equityPct / 100) * (sc.equityDrop / 100) +
      (bondPct / 100) * (sc.bondReturn / 100) +
      (cashPct / 100) * 0 +  // 现金不变
      (overseasPct / 100) * (sc.overseas / 100)
    )
    const pnlPct = totalValue > 0 ? (pnl / totalValue) * 100 : 0
    const detail = `权益${equityPct.toFixed(0)}%×${sc.equityDrop}% + 固收${bondPct.toFixed(0)}%×${sc.bondReturn >= 0 ? '+' : ''}${sc.bondReturn}% + 海外${overseasPct.toFixed(0)}%×${sc.overseas}%`
    return { name: sc.name, desc: sc.desc, pnl, pnlPct, detail }
  })
}

// ── 风格箱 ─────────────────────────────────────────────
export type Style = '大盘价值' | '大盘平衡' | '大盘成长' | '中盘价值' | '中盘平衡' | '中盘成长' | '小盘价值' | '小盘平衡' | '小盘成长' | '未知'
export interface StyleBoxItem { code: string; name: string; style: Style; value: number; pct: number }

/** 根据基金类型 + 规模粗糙映射风格箱。
 *  真实风格箱需要持仓数据或 Morningstar 分类，这里用类型近似：
 *  指数型/ETF → 大盘平衡（沪深300）或 中盘平衡（中证500）
 *  股票型 → 大盘成长
 *  混合偏股 → 大盘平衡
 *  混合偏债 → 中盘平衡
 *  债券型 → 不适用
 */
export function classifyStyle(fundType: string | null, scale: number | null): Style {
  if (!fundType) return '未知'
  const t = fundType.replace(/\s/g, '')
  if (t.includes('沪深300') || t.includes('上证50') || t.includes('中证100')) return '大盘平衡'
  if (t.includes('中证500') || t.includes('中证800')) return '中盘平衡'
  if (t.includes('中证1000') || t.includes('创业板') || t.includes('科创')) return '小盘成长'
  if (t.includes('股票型') || t.includes('偏股')) return '大盘成长'
  if (t.includes('指数型')) return scale && scale > 50 ? '大盘平衡' : '中盘平衡'
  if (t.includes('混合型') && t.includes('偏债')) return '中盘平衡'
  if (t.includes('混合型')) return '大盘平衡'
  if (t.includes('QDII') && t.includes('纳斯达克')) return '大盘成长'
  if (t.includes('QDII')) return '大盘平衡'
  if (t.includes('债券型')) return '中盘平衡'
  return '大盘平衡'
}

export function computeStyleBox(holdings: { code: string; name: string; type: string | null; value: number; scale?: number | null }[]): StyleBoxItem[] {
  const total = holdings.reduce((s, h) => s + h.value, 0)
  if (!total) return []
  return holdings.map((h) => ({
    code: h.code, name: h.name,
    style: classifyStyle(h.type, h.scale ?? null),
    value: h.value,
    pct: (h.value / total) * 100,
  }))
}

// ── 再平衡路线图 ───────────────────────────────────────
export interface RebalanceAction { cls: string; current: number; target: number; delta: number; action: string; detail: string }

export function rebalancePlan(
  current: { cls: string; pct: number; value: number }[],
  target: Record<string, number>,  // {权益: 60, ...}
  totalValue: number,
): RebalanceAction[] {
  const out: RebalanceAction[] = []
  for (const c of current) {
    const t = target[c.cls] ?? 0
    const delta = t - c.pct
    const deltaAmt = (delta / 100) * totalValue
    let action: string, detail: string
    if (Math.abs(delta) < 3) {
      action = '维持'
      detail = `偏差 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%（容差范围内）`
    } else if (delta > 0) {
      action = '加仓'
      detail = `建议增加 ${c.cls} 约 ${Math.abs(deltaAmt).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元（+${delta.toFixed(1)}%）`
    } else {
      action = '减仓'
      detail = `建议减少 ${c.cls} 约 ${Math.abs(deltaAmt).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元（${delta.toFixed(1)}%）`
    }
    out.push({ cls: c.cls, current: c.pct, target: t, delta, action, detail })
  }
  return out
}
