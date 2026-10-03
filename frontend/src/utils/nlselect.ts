// 自然语言选基（V3-6）。用户一句话 → LLM 解析成结构化筛选条件 → 套用到选基排行数据。
// 复用 utils/ai 的统一 chat()（DeepSeek 等用户自带 Key）。仅映射 screener 真有的字段；
// 不支持的条件（回撤/规模/夏普等）由 LLM 放入 unsupported，前端提示用户。
import { chat, type AiRequestOptions } from './ai'
import type { ScreenFund } from './screener'

export interface FilterSpec {
  type?: string | null
  r1m_min?: number; r3m_min?: number; r6m_min?: number
  r1y_min?: number; r3y_min?: number; ytd_min?: number
  fee_max?: number
  sort?: 'r1m' | 'r3m' | 'r6m' | 'r1y' | 'r3y' | 'ytd' | 'fee'
  unsupported?: string[]
}

const TYPES = ['股票型', '混合型', '债券型', '指数型', 'QDII', 'FOF']
const SORTS = ['r1m', 'r3m', 'r6m', 'r1y', 'r3y', 'ytd', 'fee']
const RETURN_FIELDS = ['r1m_min', 'r3m_min', 'r6m_min', 'r1y_min', 'r3y_min', 'ytd_min'] as const
const FIELDS = new Set<string>(['type', ...RETURN_FIELDS, 'fee_max', 'sort', 'unsupported'])
const INVALID_SPEC = 'AI 筛选条件无效：请检查类型、范围及未支持条件后重试'

export function validateSpec(raw: unknown): FilterSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(INVALID_SPEC)
  const row = raw as Record<string, unknown>
  const keys = Object.keys(row)
  if (!keys.length || keys.some(key => !FIELDS.has(key))) throw new Error(INVALID_SPEC)
  if ('type' in row && row.type !== null && (typeof row.type !== 'string' || !TYPES.includes(row.type))) throw new Error(INVALID_SPEC)
  if ('sort' in row && (typeof row.sort !== 'string' || !SORTS.includes(row.sort))) throw new Error(INVALID_SPEC)
  for (const field of RETURN_FIELDS) {
    if (field in row && (typeof row[field] !== 'number' || !Number.isFinite(row[field])
      || row[field] < -100 || row[field] > 100_000)) throw new Error(INVALID_SPEC)
  }
  if ('fee_max' in row && (typeof row.fee_max !== 'number' || !Number.isFinite(row.fee_max)
    || row.fee_max < 0 || row.fee_max > 100)) throw new Error(INVALID_SPEC)
  if ('unsupported' in row && (!Array.isArray(row.unsupported) || row.unsupported.length > 20
    || row.unsupported.some(value => typeof value !== 'string' || !value.trim() || value.length > 100))) throw new Error(INVALID_SPEC)
  // Do not return a model-owned object, coerce numbers, or silently drop unknown keys.
  return { ...row, ...('unsupported' in row ? { unsupported: [...row.unsupported as string[]] } : {}) } as FilterSpec
}

export function parseSpecOutput(out: string): FilterSpec {
  if (typeof out !== 'string' || out.length > 4096) throw new Error(INVALID_SPEC)
  const text = out.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) throw new Error(INVALID_SPEC)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(INVALID_SPEC) }
  // JSON.parse alone would silently keep the last duplicate key. Scan complete
  // string tokens, so escaped quotes and punctuation in unsupported text are safe.
  const keys = new Set<string>()
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') depth--
    else if (char === '"') {
      const start = index++
      while (index < text.length) {
        if (text[index] === '\\') index += 2
        else if (text[index] === '"') break
        else index++
      }
      let next = index + 1
      while (/\s/.test(text[next] || '') && next < text.length) next++
      if (depth === 1 && text[next] === ':') {
        const key = JSON.parse(text.slice(start, index + 1)) as string
        if (keys.has(key)) throw new Error(INVALID_SPEC)
        keys.add(key)
      }
    }
  }
  return validateSpec(raw)
}

const SYS =
  '你是基金筛选助手。把用户的中文需求转成 JSON 筛选条件，只输出 JSON 本身，不要任何解释或代码块标记。\n' +
  '可用字段（均可选）：\n' +
  '- type: 基金类型，必须是 股票型/混合型/债券型/指数型/QDII/FOF 之一，否则置 null\n' +
  '- r1m_min,r3m_min,r6m_min,r1y_min,r3y_min,ytd_min: 近1月/近3月/近6月/近1年/近3年/今年来 收益率下限（百分数数字，如 15 即 15%；范围 -100 到 100000，不猜测）\n' +
  '- fee_max: 手续费上限（百分数数字，范围 0 到 100，不猜测）\n' +
  '- sort: 排序字段，取 r1m/r1y/r3y/r6m/r3m/ytd/fee 之一（fee 升序、其余降序）\n' +
  '- unsupported: 字符串数组，列出用户提到但本系统无法支持的条件（如 最大回撤/规模/夏普/成立年限/基金经理 等）\n' +
  '不得猜测用户没有提供的数值、把未知类型置换成支持类型或把不支持条件转成收益/费率；未知条件必须完整列入 unsupported。\n' +
  '示例：{"type":"混合型","r3y_min":50,"sort":"r3y","unsupported":["规模"]}'

export async function parseQuery(nl: string, options: AiRequestOptions = {}): Promise<FilterSpec> {
  if (!nl.trim() || nl.length > 1000) throw new Error('筛选需求应为 1–1000 个字符')
  return parseSpecOutput(await chat(SYS, nl, options))
}

export function applySpec(funds: ScreenFund[], spec: FilterSpec): ScreenFund[] {
  spec = validateSpec(spec)
  if (spec.unsupported?.length) throw new Error('含未支持条件，未执行筛选；请修改需求后重新解析')
  if (!spec.type && !spec.sort && spec.fee_max == null && !RETURN_FIELDS.some(field => spec[field] != null)) {
    throw new Error('未提供可执行条件，未执行筛选；请修改需求后重新解析')
  }
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
const SORT_LBL: Record<string, string> = { r1m: '近1月', r1y: '近1年', r3y: '近3年', r6m: '近6月', r3m: '近3月', ytd: '今年来', fee: '低费率' }
export function specSummary(spec: FilterSpec): string[] {
  const out: string[] = []
  if (spec.type) out.push(spec.type)
  for (const k of ['r1m_min', 'r3m_min', 'r6m_min', 'r1y_min', 'r3y_min', 'ytd_min', 'fee_max'] as const) {
    const v = spec[k]
    if (v != null) out.push(LBL[k] + v + '%')
  }
  if (!out.length && !spec.sort) out.push('未指定有效筛选条件')
  out.push('按' + SORT_LBL[spec.sort || 'r1y'] + '排序' + (spec.sort ? '' : '（默认）'))
  return out
}
