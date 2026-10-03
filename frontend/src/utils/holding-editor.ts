import type { WatchEntry } from './gist'

export type PositionKind = 'holding' | 'watch'
export interface HoldingInput {
  code: string
  name?: string
  account: string
  position_kind: PositionKind
  shares: number | null
  cost: number | null
  target_weight: number | null
}
export interface EntrySnapshot { id: string; snapshot: string }
const messages = {
  invalid: '请检查基金代码、账户、份额、成本净值和目标权重',
  conflict: '记录已变化或目标账户已有记录，请重新打开后编辑',
  storage: '本机保存失败，原记录未修改；请检查浏览器存储空间或权限',
  'requires-confirmation': '此操作会移除持仓记录或多个账户，请明确确认后重试',
} as const
export class WatchMutationError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = 'WatchMutationError' }
}
export function positionKind(entry: Pick<WatchEntry, 'shares' | 'position_kind'>): PositionKind {
  return entry.position_kind ?? (entry.shares != null && entry.shares > 0 ? 'holding' : 'watch')
}
export function validateHolding(input: HoldingInput): HoldingInput {
  const number = (value: unknown, max = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
  if (!/^\d{6}$/.test(input.code) || typeof input.account !== 'string'
    || input.account.trim().length > 64 || /[\x00-\x1f\x7f]/.test(input.account)
    || (input.name != null && (typeof input.name !== 'string' || input.name.length > 200))
    || !['holding', 'watch'].includes(input.position_kind)
    || (input.position_kind === 'holding' && !number(input.shares))
    || (input.shares != null && !number(input.shares))
    || (input.cost != null && !number(input.cost))
    || (input.target_weight != null && !number(input.target_weight, 100))
    || (input.position_kind === 'watch' && input.shares != null && input.shares !== 0)) throw new WatchMutationError('invalid')
  return { ...input, account: input.account.trim(), name: input.name?.trim() || undefined }
}
/** Empty is unknown; entered zero is an observed zero, never Number('') coercion. */
export function parseHoldingNumber(text: string, required = false): number | null {
  const value = text.trim()
  if (!value) { if (required) throw new WatchMutationError('invalid'); return null }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new WatchMutationError('invalid')
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new WatchMutationError('invalid')
  return parsed
}
