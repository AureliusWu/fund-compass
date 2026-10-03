import type { WatchEntry } from './gist'

/** Fund-only positions. Cash/manual assets are deliberately not an input. */
export interface AggregatedFundHolding {
  code: string
  name: string
  shares: number | null
  costBasis: number | null
  cost: number | null
  targetWeight: number | null
  sharesComplete: boolean
  costComplete: boolean
  targetComplete: boolean
  accountCount: number
}

export interface FundHoldingAggregation {
  funds: AggregatedFundHolding[]
  /** Input identities and supplied numbers are valid; missing costs/targets are separate. */
  complete: boolean
  errors: string[]
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function boundedTarget(value: unknown): value is number {
  return nonnegative(value) && value <= 100
}

function finiteSum(values: number[]): number | null {
  const sum = values.reduce((total, value) => total + value, 0)
  return Number.isFinite(sum) ? sum : null
}

/**
 * Aggregate one fund across accounts without last-account-wins or partial
 * costs/targets. Explicit zero-share records survive; they are not positive
 * positions. Legacy absent fields remain unknown and are never filled with 0.
 * Consumers must reject `complete=false` before deriving portfolio weights.
 */
export function aggregateFundHoldings(entries: readonly WatchEntry[]): FundHoldingAggregation {
  const errors = new Set<string>()
  const identities = new Set<string>()
  const groups = new Map<string, WatchEntry[]>()
  for (const entry of entries) {
    if (entry.deleted === true) continue
    if (entry.deleted != null && typeof entry.deleted !== 'boolean') errors.add('invalid_deleted_flag')
    if (typeof entry.code !== 'string' || !/^\d{6}$/.test(entry.code)) {
      errors.add('invalid_fund_code')
      continue
    }
    if (entry.account != null && typeof entry.account !== 'string') {
      errors.add('invalid_account')
      continue
    }
    const account = entry.account?.trim() || ''
    const identity = `${entry.code}::${account}`
    if ((entry.id != null && entry.id !== identity) || identities.has(identity)) {
      errors.add('ambiguous_account_identity')
      continue
    }
    identities.add(identity)
    if (entry.position_kind != null && !['watch', 'holding'].includes(entry.position_kind)) {
      errors.add('invalid_position_kind')
      continue
    }
    if (entry.position_kind === 'watch') {
      if (entry.shares != null && (!nonnegative(entry.shares) || entry.shares > 0)) {
        errors.add('watch_has_invalid_position')
      }
      continue
    }
    if (entry.shares != null && !nonnegative(entry.shares)) errors.add('invalid_shares')
    const explicitHolding = entry.position_kind === 'holding'
    const legacyHolding = entry.position_kind == null && nonnegative(entry.shares) && entry.shares > 0
    if (!explicitHolding && !legacyHolding) {
      if (entry.shares == null && (entry.cost != null || entry.target_weight != null)) {
        errors.add('unknown_position_kind')
      }
      continue
    }
    if (!nonnegative(entry.shares)) errors.add('holding_shares_unavailable')
    if (entry.cost != null && !nonnegative(entry.cost)) errors.add('invalid_cost')
    if (entry.target_weight != null && !boundedTarget(entry.target_weight)) errors.add('invalid_target_weight')
    const rows = groups.get(entry.code) || []
    rows.push(entry)
    groups.set(entry.code, rows)
  }
  const funds = [...groups].map(([code, rows]): AggregatedFundHolding => {
    const sharesKnown = rows.every(row => nonnegative(row.shares))
    const shares = sharesKnown ? finiteSum(rows.map(row => row.shares as number)) : null
    const sharesComplete = sharesKnown && shares != null
    if (sharesKnown && shares == null) errors.add('shares_sum_overflow')
    const costsKnown = sharesComplete && rows.every(row => nonnegative(row.cost))
    const costBasis = costsKnown
      ? finiteSum(rows.map(row => (row.shares as number) * (row.cost as number)))
      : null
    const costComplete = costsKnown && costBasis != null
    if (costsKnown && costBasis == null) errors.add('cost_basis_overflow')
    const weightedCost = costComplete && shares != null && shares > 0
      ? (costBasis as number) / shares : null
    const cost = weightedCost != null && Number.isFinite(weightedCost) ? weightedCost : null
    const targetsKnown = rows.every(row => boundedTarget(row.target_weight))
    const targetSum = targetsKnown ? finiteSum(rows.map(row => row.target_weight as number)) : null
    const targetComplete = targetsKnown && targetSum != null && targetSum <= 100
    if (targetsKnown && !targetComplete) errors.add('fund_target_weight_sum_invalid')
    return {
      code, name: rows.find(row => typeof row.name === 'string' && row.name.trim())?.name || code,
      shares, costBasis, cost, targetWeight: targetComplete ? targetSum : null,
      sharesComplete, costComplete, targetComplete, accountCount: rows.length,
    }
  })
  return { funds, complete: errors.size === 0, errors: [...errors] }
}
