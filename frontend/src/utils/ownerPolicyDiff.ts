import type { V8PortfolioPolicy } from '@/api/client'

const fields = {
  name: '名称', target_allocations: '目标权重（%）', target_ranges: '目标范围（%）',
  max_single_fund_weight: '单只上限（%）', max_theme_weight: '主题上限（%）', rebalance_band: '再平衡带（%）',
  dca_rules: '定投规则', reduce_rules: '减仓规则', sell_rules: '卖出规则',
  effective_at: '生效时刻', source: '来源',
} as const
function stable(value: unknown): string {
  if (value === null) return 'null'
  if (Object.is(value, -0)) return '-0'
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (typeof value === 'object') return '{' + Object.entries(value!).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}'
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Invalid policy presentation value')
  return encoded
}
export function ownerPolicyValue(value: unknown): string {
  if (value === null) return '未设置（null）'
  if (Object.is(value, -0)) return '-0'
  if (typeof value === 'object') return stable(value)
  return String(value)
}
/** Only already validated immutable policies enter this presentation helper.
 * It never changes a policy, computes a business ID, or compares past actions. */
export function ownerPolicyDiff(before: V8PortfolioPolicy, after: V8PortfolioPolicy) {
  return Object.entries(fields).filter(([key]) => stable(before[key as keyof typeof fields]) !== stable(after[key as keyof typeof fields]))
    .map(([key, label]) => ({ key, label, before: ownerPolicyValue(before[key as keyof typeof fields]),
      after: ownerPolicyValue(after[key as keyof typeof fields]) }))
}
