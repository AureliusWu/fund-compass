// 自然语言选基（V3-6）。用户一句话 → LLM 解析成结构化筛选条件 → 套用到选基排行数据。
// 复用 utils/ai 的统一 chat()（DeepSeek 等用户自带 Key）。仅映射 screener 真有的字段；
// 不支持的条件（回撤/规模/夏普等）由 LLM 放入 unsupported，前端提示用户。
import { chat } from './ai'
import type { ScreenFund } from './screener'

export interface FilterSpec {
  type?: string | null
  r1m_min?: number; r3m_min?: number; r6m_min?: number
  r1y_min?: number; r3y_min?: number; ytd_min?: number
  fee_max?: number
  sort?: 'r1m' | 'r3m' | 'r6m' | 'r1y' | 'r3y' | 'ytd' | 'fee'
  unsupported?: string[]
}

const SYS =
  '你是基金筛选助手。把用户的中文需求转成 JSON 筛选条件，只输出 JSON 本身，不要任何解释或代码块标记。\n' +
  '可用字段（均可选）：\n' +
  '- type: 基金类型，必须是 股票型/混合型/债券型/指数型/QDII/FOF 之一，否则置 null\n' +
  '- r1m_min,r3m_min,r6m_min,r1y_min,r3y_min,ytd_min: 近1月/近3月/近6月/近1年/近3年/今年来 收益率下限（百分数数字，如 15 即 15%）\n' +
  '- fee_max: 手续费上限（百分数数字）\n' +
  '- sort: 排序字段，取 r1y/r3y/r6m/r3m/ytd/fee 之一（fee 升序、其余降序）\n' +
  '- unsupported: 字符串数组，列出用户提到但本系统无法支持的条件（如 最大回撤/规模/夏普/成立年限/基金经理 等）\n' +
  '示例：{"type":"混合型","r3y_min":50,"sort":"r3y","unsupported":["规模"]}'

export async function parseQuery(nl: string): Promise<FilterSpec> {
  const out = await chat(SYS, nl)
  const m = out.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('AI 未返回可解析的条件')
  return JSON.parse(m[0]) as FilterSpec
}

export function applySpec(funds: ScreenFund[], spec: FilterSpec): ScreenFund[] {
  const mins: [keyof ScreenFund, number | undefined][] = [
    ['r1m', spec.r1m_min], ['r3m', spec.r3m_min], ['r6m', spec.r6m_min],
    ['r1y', spec.r1y_min], ['r3y', spec.r3y_min], ['ytd', spec.ytd_min],
  ]
  const arr = funds.filter((f) => {
    if (spec.type && f.t !== spec.type) return false
    for (const [k, v] of mins) {
      if (v != null && !(f[k] != null && (f[k] as number) >= v)) return false
    }
    if (spec.fee_max != null && !(f.fee != null && f.fee <= spec.fee_max)) return false
    return true
  })
  const k = spec.sort || 'r1y'
  const asc = k === 'fee'
  arr.sort((a, b) => {
    const av = a[k]; const bv = b[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return asc ? av - bv : bv - av
  })
  return arr
}

// 把解析出的条件转成人类可读摘要（前端展示用）
const LBL: Record<string, string> = {
  r1m_min: '近1月≥', r3m_min: '近3月≥', r6m_min: '近6月≥', r1y_min: '近1年≥',
  r3y_min: '近3年≥', ytd_min: '今年来≥', fee_max: '费率≤',
}
const SORT_LBL: Record<string, string> = { r1y: '近1年', r3y: '近3年', r6m: '近6月', r3m: '近3月', ytd: '今年来', fee: '低费率' }
export function specSummary(spec: FilterSpec): string[] {
  const out: string[] = []
  if (spec.type) out.push(spec.type)
  for (const k of ['r1m_min', 'r3m_min', 'r6m_min', 'r1y_min', 'r3y_min', 'ytd_min', 'fee_max'] as const) {
    const v = spec[k]
    if (v != null) out.push(LBL[k] + v + '%')
  }
  if (spec.sort) out.push('按' + (SORT_LBL[spec.sort] || spec.sort) + '排序')
  return out
}
